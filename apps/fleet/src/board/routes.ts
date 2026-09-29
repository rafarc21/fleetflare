// The board's HTTP surface. Same shape and the same order as
// src/studio/routes.ts's handleStudio — auth first, unconditionally, then
// path, then method, then body — and the same seam discipline: the two things
// that cannot run under the test pool (a minted installation token, a live
// GitHub call) are defaulted parameters, so every route below is exercised in
// test/board.routes.test.ts without one.
//
// Mounted under `/studio/board/` and NOT at a `/board/` prefix of its own,
// which is a deployment fact rather than a naming preference: the Cloudflare
// Access application in front of this Worker is scoped to the `/studio` PATH
// (verified 2026-08-25 — an unauthenticated GET of `/studio/` 302s to the
// Access login, while `/board/x` reaches the Worker directly). A `/board`
// prefix would therefore receive no `Cf-Access-Jwt-Assertion` at all, and the
// CLI's service-token headers — which only the Access edge exchanges for a
// JWT — would 401 on every request. Under `/studio/` the board inherits
// exactly the gate every operator surface already has. A studio id always
// contains `--` (src/studio/ids.ts's grammar), so the literal `board` can
// never collide with one.

import type { Env } from "../env";
import { verifyAccess } from "../studio/auth";
import { redactSecrets } from "../studio/redact";
import { reachRepo, repoTokenMinter, mintRepoToken, type RepoReach } from "../github/auth";
import {
  pullRequestExists, branchExists, commitExists, issueExists, pathExists, compareExists,
  closeIssue as closeIssueApi, getDefaultBranch, getPullRequest, commitReachableFromBranch,
  getIssueCloser, type IssueCloser, pullClaimsIssue,
  listMatchingBranches, commitDate, compareFiles, deleteBranch, resolveCanonicalRepoName,
  repoIsPrivate, fetchRepoFile,
} from "../github/api";
import {
  createIssue, getIssue, listIssues, addLabels, removeLabel,
  createComment, listComments, listMilestones, GitHubError,
} from "./api";
import {
  createTask, transitionTask, commentEnvelope, listTasks, showTask, resolveBoardRepo, assignTask,
  commentStudioEnvelope, showStudioTask, transitionStudioTask, resolveBriefPrompt, resolveLatestAssignedBrief,
  openAssignedTasks,
  type BoardApi, type BoardResult, type ListTasksQuery, type OnAssigned,
} from "./board";
import { recordJuniorAuthorization, revokeJuniorAuthorization, sweepJuniorAuthorizations } from "../junior/authz";
import { wakeOnAssign, checkAssignRepo, type AssignWakeDeps, type AssignWakeReport } from "./assign-wake";
import { attemptVerification, parseGithubUrl, type VerifyFetch } from "./verify";
import { openTasksWithLatestPr } from "./pr-landed";
import { closeTaskOnPromote } from "./close-action";
import { runTaskReap, type ReapDeps, type LandedCheck } from "../studio/task-reap";
import { runRescueGc, type RescueBranch } from "../studio/rescue-gc";
import { listStudios } from "../studio/registry";
import { isSpawnTokenShaped, resolveSpawnParent, SPAWN_TOKEN_HEADER } from "../studio/spawn";
import { parseStudioId } from "../studio/ids";
import type { StudioStatus } from "../studio/types";
import { JUNIOR_LABEL, TERMINAL_TASK_STATES, type BoardTask } from "./types";
import { guardBoardApi, leakGuard, LeakGateError, type LeakGuardDeps } from "./leak";
import { OPS_DENYLIST_PATH } from "../leak-gate";
import { resolveOpsRepo } from "../ops-repo";

// `/studio/board/tasks`, optionally one task number, optionally one action on
// it. Anything else is a 404 by construction, including a non-numeric task id
// — the board addresses tasks by issue number and nothing else.
const BOARD_ROUTE_RE = /^\/studio\/board\/tasks(?:\/(\d+)(?:\/(state|envelope|adopt|assign|verify))?)?$/;

/**
 * The real port: one credential per repo OWNER, minted lazily on first use and
 * reused for the (at most three) calls a single board request makes. Per-call
 * rather than module-level for the same reason src/studio/routes.ts's
 * githubBlueprintFetch is — a credential is never held across requests.
 *
 * P6a: the board repo is "the repo being worked" (§5), which under a mixed
 * config can belong to a different owner — and therefore a different provider
 * — than the fleet's own repo. Every method already takes the repo, so each
 * one asks for the credential that repo's owner actually uses.
 */
export function githubBoardApi(env: Env, leakDeps: Partial<LeakGuardDeps> = {}): BoardApi {
  const token = repoTokenMinter(env);
  // Issue #1: issue and comment writes pass the leak gate first (src/board/leak.ts).
  return guardBoardApi({
    createIssue: async (repo, input) => createIssue(await token(repo), repo, input),
    getIssue: async (repo, number) => getIssue(await token(repo), repo, number),
    listIssues: async (repo, query) => listIssues(await token(repo), repo, query),
    addLabels: async (repo, number, labels) => addLabels(await token(repo), repo, number, labels),
    removeLabel: async (repo, number, label) => removeLabel(await token(repo), repo, number, label),
    createComment: async (repo, number, body) => createComment(await token(repo), repo, number, body),
    pullRequestExists: async (repo, number) => pullRequestExists(await token(repo), repo, number),
    listComments: async (repo, number) => listComments(await token(repo), repo, number),
    listMilestones: async (repo) => listMilestones(await token(repo), repo),
    branchExists: async (repo, branch) => branchExists(await token(repo), repo, branch),
    commitExists: async (repo, sha) => commitExists(await token(repo), repo, sha),
    closeIssue: async (repo, number) => closeIssueApi(await token(repo), repo, number),
  }, leakGuard({ ...realLeakDeps(env, token), ...leakDeps }));
}

/** Visibility via the board's own token; the denylist via a contents:read
 *  token on the ops repo -- same port as do.ts's opsFileFetcher, inlined
 *  because do.ts imports this file. No ops repo = no list = fail closed. */
function realLeakDeps(env: Env, token: (repo: string) => Promise<string>): LeakGuardDeps {
  return {
    isPrivate: async (repo) => repoIsPrivate(await token(repo), repo),
    fetchDenylist: async () => {
      const opsRepo = resolveOpsRepo(env);
      if (opsRepo === null) throw new Error("FLEET_OPS_REPO unset");
      const opsToken = await mintRepoToken(env, opsRepo, { permissions: { contents: "read" } });
      return fetchRepoFile(opsToken, opsRepo, OPS_DENYLIST_PATH, "HEAD");
    },
  };
}

export type RepoReachFetch = (slug: string) => Promise<RepoReach>;

function githubRepoReach(env: Env): RepoReachFetch {
  return (slug: string) => reachRepo(env, slug);
}

/**
 * The plain unauthenticated GET every non-github url — and, after board task
 * #126, every github.com url this fleet has no authenticated check for —
 * still gets: no auth, no special headers, since the point is reproducing
 * what an unauthenticated human clicking the link would see (or, for an
 * arbitrary host, the only thing this fleet CAN do — it holds no credential
 * for a host that is not github.com). Never throws: attemptVerification's
 * own checkUrl already treats a rejected promise as attempted-failed, but a
 * network error crashing the ROUTE (rather than being classified) would turn
 * "the url is unreachable" into a 502 the operator has to read the Worker's
 * own logs to explain, instead of a comment naming exactly what happened.
 */
async function plainGetFetch(url: string): Promise<{ status: number }> {
  try {
    const res = await fetch(url, { method: "GET" });
    return { status: res.status };
  } catch {
    // 0 is not a real HTTP status; checkUrl's own `>= 200 && < 300` test
    // reads it as attempted-failed, same as any other non-2xx, and the
    // detail line still carries "HTTP 0" — honestly ambiguous rather than
    // silently defaulting to something that looks like a chosen number.
    return { status: 0 };
  }
}

/**
 * Board task #126's fix: the four checks parseGithubUrl's `path`/`branch`
 * kinds and the `commit`/`pr`/`issue`/`compare` kinds each need, bundled as
 * one small record so a test can hand in fakes for every one of them at
 * once — same reason BoardApi is one port instead of five loose function
 * arguments. Real values are src/github/api.ts's own existence checks;
 * githubAwareVerifyFetch below never assumes which.
 */
export interface GithubUrlExistenceChecks {
  commit: (token: string, repo: string, sha: string) => Promise<boolean>;
  pr: (token: string, repo: string, number: number) => Promise<boolean>;
  issue: (token: string, repo: string, number: number) => Promise<boolean>;
  branch: (token: string, repo: string, branch: string) => Promise<boolean>;
  path: (token: string, repo: string, path: string, ref: string) => Promise<boolean>;
  compare: (token: string, repo: string, base: string, head: string) => Promise<boolean>;
}

/**
 * Board task #126's fix, as a pure(ish) DI-testable factory: a `VerifyFetch`
 * whose github.com branch resolves through an INJECTED token minter and
 * existence checks rather than baked-in ones — the seam a test needs to
 * prove "the authenticated answer wins" without a live token mint or a
 * network call. `realVerifyFetch` below is the only real-deps caller; it
 * hands in `repoTokenMinter(env)` and the actual src/github/api.ts
 * functions.
 *
 * A url src/board/verify.ts's parseGithubUrl does not recognize — including
 * every non-github.com host — falls straight through to `fallback`
 * unchanged; see that function's own doc comment for the fallback rule this
 * only carries out. A THROWN error from either the mint or the existence
 * check (a rate limit, a non-404 failure, a network issue) reads as
 * `{status: 0}`, the exact same "not a real HTTP status, but checkUrl's own
 * classification reads it as attempted-failed" posture plainGetFetch's own
 * catch above already took.
 */
export function githubAwareVerifyFetch(
  mintToken: (repo: string) => Promise<string>,
  checks: GithubUrlExistenceChecks,
  fallback: VerifyFetch,
): VerifyFetch {
  return async (url: string) => {
    const parsed = parseGithubUrl(url);
    if (!parsed) return fallback(url);
    try {
      const token = await mintToken(parsed.repo);
      const exists =
        parsed.kind === "commit" ? await checks.commit(token, parsed.repo, parsed.sha)
          : parsed.kind === "pr" ? await checks.pr(token, parsed.repo, parsed.number)
            : parsed.kind === "issue" ? await checks.issue(token, parsed.repo, parsed.number)
              : parsed.kind === "branch" ? await checks.branch(token, parsed.repo, parsed.branch)
                : parsed.kind === "path" ? await checks.path(token, parsed.repo, parsed.path, parsed.ref)
                  : await checks.compare(token, parsed.repo, parsed.base, parsed.head);
      return { status: exists ? 200 : 404 };
    } catch {
      return { status: 0 };
    }
  };
}

const REAL_GITHUB_URL_CHECKS: GithubUrlExistenceChecks = {
  commit: commitExists, pr: pullRequestExists, issue: issueExists,
  branch: branchExists, path: pathExists, compare: compareExists,
};

/**
 * Task #119's live url-check seam; task #126's fix. Every repo this fleet
 * works is PRIVATE, so the plain anonymous GET this used to make on every
 * `verification.url` 404s even when the thing named genuinely exists —
 * measured live on board task #126: a real, existing commit on a private
 * repo read HTTP 404 unauthenticated, while `gh repo view` and the
 * authenticated REST API both confirmed it was fine. A verifier that fails
 * on everything is worse than none — it trains the reader to ignore it.
 *
 * A github.com url matching one of parseGithubUrl's recognized shapes is now
 * resolved through the fleet's own credential (repoTokenMinter) and the
 * matching authenticated REST check instead — see githubAwareVerifyFetch
 * above. Everything else — a non-github host, or a github.com url this
 * fleet has no authenticated check for (a repo root, `/settings`,
 * `/actions/...`) — still gets the exact plain GET a human clicking the
 * link would get: the fleet holds no credential for an arbitrary host, and
 * has no authenticated meaning for those paths anyway.
 */
function realVerifyFetch(env: Env): VerifyFetch {
  return githubAwareVerifyFetch(repoTokenMinter(env), REAL_GITHUB_URL_CHECKS, plainGetFetch);
}

/** Malformed JSON reads as an empty object and falls through to the domain
 *  layer's own 400 — same posture the studio provision/spawn routes take. */
function jsonBody(req: Request): Promise<Record<string, unknown>> {
  return req.json<Record<string, unknown>>().catch(() => ({}));
}

// --- board issue #8: POST /studio/board/tasks/reap --------------------------
//
// `fleet task reap [--dry-run|--apply]`'s one server-side route — the Mac CLI
// never holds a GitHub token, only the Worker mints one, so a poll-based
// backfill has to live here. Real work is entirely `src/studio/task-reap.ts`'s
// pure `runTaskReap`; this is only the wiring, same split every other route
// in this file already draws between "the rule" (board.ts/verify.ts/
// task-reap.ts) and "the plumbing" (here).

/** The two things the reap route needs from real GitHub beyond what
 *  `BoardApi` already covers — injected the same way `verify`'s own
 *  `VerifyFetch` is, so no test here ever mints a real token. */
export interface ReapPort {
  getDefaultBranch: (repo: string) => Promise<string>;
  /** Is this PR now reachable from `defaultBranch`? Mirrors
   *  `task-reap.ts`'s own `LandedCheck` exactly — this is the ONE place that
   *  answers it for real, via `getPullRequest` + `commitReachableFromBranch`
   *  (github/api.ts): merged directly into the default branch is landed
   *  outright; merged into `staging` (the common case) asks whether the
   *  merge commit is now an ancestor of the default branch, which reads
   *  correctly regardless of squash strategy — see that function's own doc
   *  comment. */
  checkLanded: (repo: string, defaultBranch: string, prNumber: number) => Promise<LandedCheck>;
  /** Board issue #138: who closed this issue — `getIssueCloser`. */
  findCloser: (repo: string, taskNumber: number) => Promise<IssueCloser>;
  /** Issue #248: does this PR claim to close this task? */
  prClaims: (repo: string, prNumber: number, taskNumber: number) => Promise<boolean>;
}

function realReapPort(env: Env): ReapPort {
  const mint = repoTokenMinter(env);
  return {
    getDefaultBranch: async (repo) => getDefaultBranch(await mint(repo), repo),
    checkLanded: async (repo, defaultBranch, prNumber) => {
      const token = await mint(repo);
      const pr = await getPullRequest(token, repo, prNumber);
      if (!pr.merged || pr.mergeCommitSha === null) return { landed: false, sha: null };
      if (pr.baseRef === defaultBranch) return { landed: true, sha: pr.mergeCommitSha };
      const reachable = await commitReachableFromBranch(token, repo, defaultBranch, pr.mergeCommitSha);
      return reachable ? { landed: true, sha: pr.mergeCommitSha } : { landed: false, sha: null };
    },
    findCloser: async (repo, taskNumber) => getIssueCloser(await mint(repo), repo, taskNumber),
    prClaims: async (repo, prNumber, taskNumber) => pullClaimsIssue(await mint(repo), repo, prNumber, taskNumber),
  };
}

/** Issue #217: what `fleet rescue-gc` needs from real GitHub, injected like
 *  ReapPort so no test mints a token. */
export interface RescueGcPort {
  getDefaultBranch: (repo: string) => Promise<string>;
  /** Every `fleet/rescue/*` branch with its tip commit's date. */
  listRescueBranches: (repo: string) => Promise<RescueBranch[]>;
  compare: (repo: string, base: string, head: string) => Promise<{ aheadBy: number; files: string[] }>;
  deleteBranch: (repo: string, branch: string) => Promise<void>;
}

function realRescueGcPort(env: Env): RescueGcPort {
  const mint = repoTokenMinter(env);
  return {
    getDefaultBranch: async (repo) => getDefaultBranch(await mint(repo), repo),
    listRescueBranches: async (repo) => {
      const token = await mint(repo);
      const refs = await listMatchingBranches(token, repo, "fleet/rescue/");
      return Promise.all(refs.map(async (r) => ({ ...r, date: await commitDate(token, repo, r.sha) })));
    },
    compare: async (repo, base, head) => compareFiles(await mint(repo), repo, base, head),
    deleteBranch: async (repo, branch) => deleteBranch(await mint(repo), repo, branch),
  };
}

/** Default age before a rescue branch may go: two weeks of someone reading it. */
export const RESCUE_GC_DEFAULT_DAYS = 14;

/**
 * `POST /studio/board/tasks/rescue-gc {apply?, olderThanDays?, repo?}` —
 * issue #217. Dry-run unless `apply: true`; the rule is runRescueGc's.
 */
async function handleRescueGcRoute(
  req: Request, env: Env, reach: RepoReachFetch, port: RescueGcPort,
): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await jsonBody(req);
  const apply = body.apply === true;
  const olderThanDays =
    typeof body.olderThanDays === "number" && Number.isFinite(body.olderThanDays) && body.olderThanDays >= 0
      ? body.olderThanDays : RESCUE_GC_DEFAULT_DAYS;
  const repoResult = await resolveBoardRepo({ reachRepo: reach }, { requested: body.repo, defaultSlug: env.AGENT_REPO });
  if (!repoResult.ok) return respond(repoResult);
  const repo = repoResult.value;
  try {
    const defaultBranch = await port.getDefaultBranch(repo);
    const results = await runRescueGc(
      {
        listBranches: () => port.listRescueBranches(repo),
        compare: (name) => port.compare(repo, defaultBranch, name),
        deleteBranch: (name) => port.deleteBranch(repo, name),
      },
      { apply, olderThanDays, now: new Date(), defaultBranch },
    );
    return Response.json({ repo, apply, defaultBranch, olderThanDays, results });
  } catch (err) {
    return upstreamFailure(err, req.method, new URL(req.url).pathname);
  }
}

/**
 * `POST /studio/board/tasks/reap {apply?: boolean, repo?: string}`. `apply`
 * missing or falsy is a dry-run — `runTaskReap`'s own default posture,
 * carried through unchanged rather than re-decided here.
 *
 * `listOpenTasks` reuses `listTasks` + `openTasksWithLatestPr` (the SAME
 * scan `promote-close.ts`'s push-triggered envelope cross-check walks the
 * other direction — see that module's own header). `close` is the shared
 * `closeTaskOnPromote`, so a webhook close and a later `reap --apply` run
 * for the identical (repo, issue, sha) do at most one real write between
 * them via that function's own dedup guard.
 */
async function handleTaskReapRoute(
  req: Request, env: Env, api: BoardApi, reach: RepoReachFetch, reapPort: ReapPort,
): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await jsonBody(req);
  const apply = body.apply === true;
  const repoResult = await resolveBoardRepo({ reachRepo: reach }, { requested: body.repo, defaultSlug: env.AGENT_REPO });
  if (!repoResult.ok) return respond(repoResult);
  const repo = repoResult.value;

  try {
    const defaultBranch = await reapPort.getDefaultBranch(repo);
    const deps: ReapDeps = {
      repo,
      listOpenTasks: async () => {
        const tasksResult = await listTasks(api, repo, {});
        if (!tasksResult.ok) throw new Error(tasksResult.message);
        // Board issue #26: no `.open` pre-filter here — the full task list
        // passes straight through, and openTasksWithLatestPr's own
        // predicate decides, including a task GitHub already closed
        // natively whose board label isn't `completed` yet.
        // Board issue #138: carry each task's GitHub open/closed through, so
        // a closed task with no envelope PR can be resolved by its closer.
        // Issue #248: and its board state, so reap leaves input_required alone.
        const byNumber = new Map(tasksResult.value.map((t) => [t.number, t]));
        return (await openTasksWithLatestPr(api, repo, tasksResult.value))
          .map((t) => ({ ...t, open: byNumber.get(t.taskNumber)?.open, state: byNumber.get(t.taskNumber)?.state }));
      },
      checkLanded: (prNumber) => reapPort.checkLanded(repo, defaultBranch, prNumber),
      findCloser: (taskNumber) => reapPort.findCloser(repo, taskNumber),
      prClaims: (prNumber, taskNumber) => reapPort.prClaims(repo, prNumber, taskNumber),
      close: async (taskNumber, sha) => {
        const result = await closeTaskOnPromote(env, api, repo, taskNumber, { sha, branch: defaultBranch });
        return { ok: true, outcome: result.outcome };
      },
    };
    const results = await runTaskReap(deps, apply);
    return Response.json({ repo, apply, defaultBranch, results });
  } catch (err) {
    return upstreamFailure(err, req.method, new URL(req.url).pathname);
  }
}

/**
 * Issue #35: `POST /studio/board/tasks/junior-sweep {apply?, repo?, after?, limit?}` (limit clamped to JUNIOR_SWEEP_PAGE) — same
 * shape and repo resolution as tasks/reap. Dry-run unless `apply: true`.
 * src/junior/authz.ts's sweepJuniorAuthorizations decides; this only wires
 * the board read.
 */
async function handleJuniorSweepRoute(req: Request, env: Env, api: BoardApi, reach: RepoReachFetch): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await jsonBody(req);
  const apply = body.apply === true;
  const repoResult = await resolveBoardRepo({ reachRepo: reach }, { requested: body.repo, defaultSlug: env.AGENT_REPO });
  if (!repoResult.ok) return respond(repoResult);
  const repo = repoResult.value;
  // Issue #41: one page per request; `next` feeds the caller's `after`.
  const whole = (v: unknown, min: number) => v === undefined || (Number.isInteger(v) && (v as number) >= min);
  if (!whole(body.after, 0) || !whole(body.limit, 1)) {
    return new Response("after must be an integer >= 0 and limit an integer >= 1", { status: 400 });
  }
  const page = { after: body.after as number | undefined, limit: body.limit as number | undefined };
  try {
    const { results, next } = await sweepJuniorAuthorizations(env.DB, repo, (r, n) => api.getIssue(r, n), apply, page);
    return Response.json({ repo, apply, results, next });
  } catch (err) {
    return upstreamFailure(err, req.method, new URL(req.url).pathname);
  }
}

/** One BoardResult -> one Response. HTTP semantics are decided in board.ts,
 *  beside the rule that produced them; this only carries them out. */
function respond<T>(result: BoardResult<T>): Response {
  if (!result.ok) return new Response(result.message, { status: result.status });
  return Response.json(result.value);
}

// --- board issue #41, half one: the assign -> wake edge ---------------------
//
// Assigning a task to a studio wakes THAT studio, whatever its role. It is
// wired here, in the Worker, and not in any CLI, because `fleet task assign`,
// `ff <role> <n>` and `fleet task new --studio` all arrive as one of the three
// routes below — while a CLI-side wake would not fire at all for a task filed
// by an agent inside a container.
//
// `wakeMaestro` (src/github/webhook.ts) is deliberately untouched: it still
// resolves `maestroIdFor(repo)` and wakes that one studio for GitHub
// deliveries. This is a second, independent edge for a different trigger.

/**
 * The real ports the wake edge needs, wired to D1 and to the Durable Object
 * namespace.
 *
 * `studioState` reads the registry FIRST and the DO only after — board
 * #40/#49's lesson: `idFromName` on a name nothing else uses mints a fresh,
 * empty Durable Object and the call succeeds, so a wake aimed at a studio
 * that does not exist lands on a phantom and reports nothing. The id is never
 * composed here; it arrives as written on the task's own `studio:` label,
 * which the operator CLI folded through `repoIdSegment` (src/studio/repo.ts)
 * before it was ever an assignee. Re-deriving that fold is exactly the bug
 * #49 fixed.
 *
 * `wake` calls `wakeStudioOnAssignment`, NOT `wakeStudio`: the DO-side method
 * that runs the stopped and pane gates (src/studio/wake.ts's runGatedWake)
 * before a single keystroke reaches the container.
 *
 * `repoSlug` (issue #278) rides along from the SAME `listStudios(env)` row —
 * it is already a field on the registry, just not read here before this fix.
 * `wakeOnAssign` uses it to refuse a wake into a studio provisioned for a
 * different repo than the task's own.
 */
function realAssignWake(env: Env): AssignWakeDeps {
  const mint = repoTokenMinter(env);
  return {
    studioState: async (studioId) => {
      const row = (await listStudios(env)).find((s) => s.id === studioId);
      // `?? null`: a registry row written before `repoSlug` existed (or by a
      // test fixture that omits it) has NO such key in its stored JSON at
      // all, so `row.repoSlug` reads `undefined`, not `null` — and
      // `undefined !== null` is true, which would run the repo compare on
      // `undefined.toLowerCase()` instead of failing open the way a genuine
      // `null` does. Normalized at this one read boundary rather than in
      // assign-wake.ts's own check, the same posture StudioStatus.repoSlug's
      // own doc comment already documents for this exact ambiguity.
      return row ? { state: row.state, repoSlug: row.repoSlug ?? null } : null;
    },
    wake: (studioId, prompt) => env.STUDIO.get(env.STUDIO.idFromName(studioId)).wakeStudioOnAssignment(prompt),
    // Issue #284 round 2 (issue #268's own fix, reused): GitHub's canonical
    // owner/name for a possibly-stale `repoSlug` — see assign-wake.ts's
    // `AssignWakeDeps.resolveCanonicalRepo` for why a live lookup, not a
    // lexical trick, is what a rename or ownership transfer needs.
    resolveCanonicalRepo: async (slug) => resolveCanonicalRepoName(await mint(slug), slug),
  };
}

/**
 * Runs an assigning call and folds whatever the wake did into its response.
 *
 * The `wake` field is present whenever `onAssigned` fired at all — a real
 * move, a task filed with an assignee, OR (board #158) a re-assignment to the
 * studio that already owns the task. Only a bare backlog create with no
 * assignee still answers with the byte-identical body it answered with
 * before this feature existed — there is no studio in that case to have a
 * wake outcome about. Whenever `wake` IS present the operator sees, in the
 * same breath as the assignment, whether a lead was given a turn — which is
 * the whole complaint this issue opens with: a studio that was assigned work
 * and never heard about it.
 *
 * `repo` (issue #278): the same resolved repo (`resolveBoardRepo`'s value)
 * `handleBoard` already passed to `createTask`/`assignTask` for this exact
 * request — threaded straight to `wakeOnAssign` here rather than through
 * `OnAssigned`/`fireOnAssigned` (src/board/board.ts), which stay untouched:
 * this is the one place in the call chain where the repo the task was
 * created/assigned IN and the repo `wakeOnAssign` must check against are
 * provably the same value, since both come from this one local.
 */
async function withAssignWake(
  deps: AssignWakeDeps,
  repo: string,
  run: (onAssigned: OnAssigned) => Promise<BoardResult<BoardTask>>,
): Promise<Response> {
  let report: AssignWakeReport | null = null;
  const result = await run(async (studioId, task, why) => {
    report = await wakeOnAssign(deps, studioId, { ...task, repo }, why ?? null);
    if (!report.woke) console.error(`board: assignment to ${studioId} on #${task.number} woke nothing — ${report.reason}`);
  });
  if (!result.ok || report === null) return respond(result);
  return Response.json({ ...result.value, wake: report });
}

/**
 * PR #9 review, blocker B1: the ONE call site anywhere in this codebase that
 * may ever write a `/fleet/junior` authorization record — see
 * src/junior/authz.ts's own header for the full argument and
 * src/board/board.ts's findLiveAssignedTask for the read side.
 *
 * Reachable ONLY from `handleBoard`'s create-task branch, itself gated by
 * `verifyAccess` (Cloudflare Access) at the top of that function — a spawn
 * token, the credential every studio actually holds, is never accepted here.
 * So the single fact this whole fix rests on is: nothing a studio's own `gh`
 * token or spawn token can drive ever reaches this function.
 *
 * Fires only when `createTask` actually succeeded, the created (or replayed)
 * task carries `JUNIOR_LABEL`, AND it resolved to exactly one assignee — an
 * unassigned junior-flagged task (a brief with `junior: true` and no
 * `assignee`) authorizes NOBODY, since there is no studio to authorize. A D1
 * write failure is logged and swallowed rather than failing the whole
 * request: the task itself was already created successfully, and the safe
 * direction for this record to fail in is "nobody gets junior access", which
 * is exactly what an absent record already means.
 */
async function recordJuniorAuthorizationIfNeeded(
  env: Env, repo: string, result: BoardResult<BoardTask>,
): Promise<void> {
  if (!result.ok) return;
  if (!result.value.labels.includes(JUNIOR_LABEL)) return;
  if (result.value.assignee === null) return;
  try {
    await recordJuniorAuthorization(env.DB, repo, result.value.number, result.value.assignee, Date.now());
  } catch (err) {
    console.error(`board: junior authorization record failed for #${result.value.number} in ${repo}`, err);
  }
}

/**
 * Issue #10: a transition into a terminal state ends the task the maestro
 * authorized, so its junior record goes too. Without this a lead could set
 * `failed` then `working` and keep junior. Same failure posture as the record
 * write above: logged and swallowed, the transition already happened.
 */
async function revokeJuniorAuthorizationIfTerminal(
  env: Env, repo: string, result: BoardResult<BoardTask>,
): Promise<BoardResult<BoardTask>> {
  if (!result.ok || result.value.state === null || !TERMINAL_TASK_STATES.includes(result.value.state)) return result;
  try {
    await revokeJuniorAuthorization(env.DB, repo, result.value.number);
  } catch (err) {
    console.error(`board: junior authorization revoke failed for #${result.value.number} in ${repo}`, err);
  }
  return result;
}

/**
 * Issue #284 round 2: the repo-mismatch refusal used to run only AFTER
 * `createTask`/`assignTask` had already written the `studio:` label —
 * `wakeOnAssign` (above, in `withAssignWake`) only runs from board.ts's
 * `onAssigned` hook, itself fired ONLY once the GitHub write has landed. A
 * mismatched assign therefore still wrote the label, and the route still
 * answered 200 with the refusal buried in a `wake: {woke:false}` field —
 * indistinguishable, at the HTTP level, from a normal successful assignment.
 *
 * This runs the SAME check (assign-wake.ts's `checkAssignRepo`, split out of
 * `wakeOnAssign` for exactly this) BEFORE either write function is even
 * called: a mismatch here writes NOTHING and answers 409, the status every
 * other board refusal in this file already uses (see `transitionTask`'s own
 * 409s). `null` means "no mismatch, proceed" — used at both call sites
 * exactly like `resolveBoardRepo`'s `!repo.ok` early-return above.
 *
 * Only runs when the body actually names a well-formed studio id: an absent
 * or malformed `assignee` is left alone, and falls through to
 * `createTask`/`assignTask`'s own validation exactly as before — this is a
 * repo check, not a re-implementation of that grammar check.
 */
async function assignRepoPreflight(
  deps: AssignWakeDeps, repo: string, rawAssignee: unknown,
): Promise<Response | null> {
  if (typeof rawAssignee !== "string") return null;
  const studioId = rawAssignee.trim();
  if (!parseStudioId(studioId)) return null;
  const check = await checkAssignRepo(deps, studioId, repo);
  if (!check.ok) return new Response(check.reason, { status: 409 });
  // Issue #295 bug 2: a canonical-lookup failure lets the write through
  // (`checkAssignRepo`'s own fail-open) but is not nothing — same
  // `console.warn`/`console.error` convention this file already uses for
  // other non-fatal Worker-side notices (see `withAssignWake`, below).
  if (check.warning) console.warn(`board: ${check.warning}`);
  return null;
}

export async function handleBoard(
  req: Request, env: Env,
  api: BoardApi = githubBoardApi(env),
  reach: RepoReachFetch = githubRepoReach(env),
  verifyFetch: VerifyFetch = realVerifyFetch(env),
  reapPort: ReapPort = realReapPort(env),
  // Board issue #41, half one. Same seam shape as `api`/`reach`/`reapPort`
  // above: the real one reads D1 and talks to a Durable Object, and no test
  // in this file needs either.
  assignWake: AssignWakeDeps = realAssignWake(env),
  rescueGcPort: RescueGcPort = realRescueGcPort(env),
): Promise<Response> {
  const authFailure = await verifyAccess(req, env);
  if (authFailure) return authFailure;

  const url = new URL(req.url);

  // Board issue #8: matched BEFORE BOARD_ROUTE_RE, which only ever captures
  // a NUMERIC task id in that position — "reap" would never match it, so
  // this has to be its own check rather than another BOARD_ROUTE_RE
  // alternative.
  if (url.pathname === "/studio/board/tasks/reap") {
    return handleTaskReapRoute(req, env, api, reach, reapPort);
  }
  if (url.pathname === "/studio/board/tasks/junior-sweep") {
    return handleJuniorSweepRoute(req, env, api, reach);
  }
  if (url.pathname === "/studio/board/tasks/rescue-gc") {
    return handleRescueGcRoute(req, env, reach, rescueGcPort);
  }

  const m = BOARD_ROUTE_RE.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404 });
  const [, rawNumber, action] = m;
  const number = rawNumber === undefined ? null : Number(rawNumber);

  // Method before anything that costs a call, so a wrong verb never mints a
  // token. The matrix is small enough to state outright rather than infer.
  const method = req.method;
  const allowed =
    number === null ? method === "GET" || method === "POST"
      : action === undefined ? method === "GET"
        : method === "POST";
  if (!allowed) return new Response("method not allowed", { status: 405 });

  const body = method === "POST" ? await jsonBody(req) : {};

  // §5: the board repo is the repo being WORKED, which the CLI reads from the
  // cwd's git remote and sends — as a query param on reads, in the body on
  // writes. Absent means the fleet's own repo, and resolveBoardRepo owns
  // every decision about it, including whether the fleet can reach it.
  const requested = method === "POST" ? body.repo : url.searchParams.get("repo") ?? undefined;
  const repo = await resolveBoardRepo({ reachRepo: reach }, {
    requested, defaultSlug: env.AGENT_REPO,
  });
  if (!repo.ok) return respond(repo);

  try {
    if (number === null) {
      if (method === "POST") {
        // Board issue #41: a brief carrying `assignee` IS an assignment —
        // `fleet task new --studio` and `ff <role> "<task>"` both file this
        // way — so it wakes on exactly the same edge `assign` and `adopt` do.
        // Issue #284 round 2: the repo-mismatch check runs HERE, before
        // `createTask` writes a single label — see `assignRepoPreflight`'s
        // own doc comment for the failure this closes.
        // `return await`, not `return`: inside this try, an un-awaited
        // promise's rejection skips the catch below and escapes as a Worker
        // exception (edge 500) instead of upstreamFailure's 502 (PR #142).
        const createPreflight = await assignRepoPreflight(assignWake, repo.value, body.assignee);
        if (createPreflight) return createPreflight;
        return await withAssignWake(assignWake, repo.value, async (onAssigned) => {
          const result = await createTask(api, repo.value, body, onAssigned);
          await recordJuniorAuthorizationIfNeeded(env, repo.value, result);
          return result;
        });
      }
      const query: ListTasksQuery = {};
      const milestone = url.searchParams.get("milestone");
      if (milestone !== null) query.milestone = milestone;
      const state = url.searchParams.get("state");
      if (state !== null) query.state = state;
      // §5 assignment, from the operator's side: which studio owns it. The
      // operator may filter by ANY studio — this is the whole board, seen by
      // the human who owns it. The studio surface below is the narrow one.
      const assignedTo = url.searchParams.get("assignedTo");
      if (assignedTo !== null) query.assignedTo = assignedTo;
      return respond(await listTasks(api, repo.value, query));
    }
    if (action === undefined) return respond(await showTask(api, repo.value, number));
    if (action === "state") {
      return respond(await revokeJuniorAuthorizationIfTerminal(env, repo.value, await transitionTask(api, repo.value, number, body)));
    }
    // P5 §3's two assignment verbs. Both are on the OPERATOR surface and on
    // no other: the studio surface below has no route for either, so "an
    // agent never writes a studio label" is a fact about this Worker rather
    // than a convention a prompt asks for. `adopt` is what `ff <role> <n>`
    // calls; `assign` is Maestro's reassignment, and the only difference
    // between them is whether taking a task from another studio is allowed.
    //
    // Board issue #41, half one, and board issue #158: both wake the studio
    // they point at, whatever its role — including a same-studio re-assign
    // that changes NOTHING on the board itself, which #158 measured as a
    // coordinator's deliberate nudge to an idle lead, not a duplicate call.
    // See `withAssignWake` above and board.ts's `onAssigned` hook for exactly
    // which writes that no-op case skips (the label and the lineage comment
    // — never the wake).
    if (action === "adopt" || action === "assign") {
      const mode = action === "adopt" ? "adopt" as const : "reassign" as const;
      // Issue #284 round 2: same pre-write repo-mismatch gate as the create
      // path above — see `assignRepoPreflight`'s own doc comment.
      const assignPreflight = await assignRepoPreflight(assignWake, repo.value, body.assignee);
      if (assignPreflight) return assignPreflight;
      return await withAssignWake(assignWake, repo.value, (onAssigned) =>
        assignTask(api, repo.value, number, body, { mode, onAssigned }));
    }
    // Task #119: read-only in the sense that it never moves task state, but
    // it makes outbound fetches and posts a comment — so it is matched as
    // its OWN branch, before the unnamed-action fallback below, same
    // ordering discipline adopt/assign already follow. Never gates, never
    // transitions, never closes — see src/board/verify.ts's own header.
    if (action === "verify") return respond(await attemptVerification(api, verifyFetch, repo.value, number));
    // §6's msg_id: minted HERE, once per comment. It is the single writer's
    // stamp on a thread, so a sender never supplies it — see
    // src/board/envelope.ts's own note on the input/stored shape split.
    return respond(await commentEnvelope(api, repo.value, number, body, crypto.randomUUID()));
  } catch (err) {
    return upstreamFailure(err, method, url.pathname);
  }
}

/**
 * A GitHub call that threw, as a Response.
 *
 * A 404 from GitHub means the caller named a task (or a repo) that is not
 * there — the caller's own 404. Everything else is ours: a revoked
 * installation, a GitHub outage, a shape we mis-sent. Reporting those as the
 * caller's mistake would send an agent rewriting a request that was fine.
 * Message is redacted at this boundary, same posture the studio routes take
 * before an upstream error reaches a client.
 *
 * Shared by both handlers in this file rather than written twice: the two
 * surfaces differ in WHO is asking, never in what a broken upstream means.
 */
function upstreamFailure(err: unknown, method: string, pathname: string): Response {
  // Issue #1: a leak refusal is the gate's answer, not an upstream failure --
  // the lead sees its status and its (term-free) message verbatim.
  if (err instanceof LeakGateError) return new Response(err.message, { status: err.status });
  const status = err instanceof GitHubError && err.status === 404 ? 404 : 502;
  console.error(`board ${method} ${pathname} failed`, err);
  const message = redactSecrets(err instanceof Error ? err.message : String(err));
  return new Response(status === 404 ? message : `board upstream failed: ${message}`, { status });
}

// --- the studio surface: /fleet/tasks (P4a-2) --------------------------------
//
// The same board, read through a much narrower window. Deliberately mounted
// OUTSIDE the `/studio` prefix, at `/fleet/`, and authenticated by exactly the
// header /fleet/spawn already uses: the callers are containers, which hold a
// spawn token and no Access service token at all (src/studio/spawn.ts's
// SPAWN_TOKEN_HEADER doc comment is the full argument). This handler follows
// that route's order verbatim — path, method, auth, then work — so a wrong
// verb gets a 405 rather than a misleading 401, and an unauthenticated caller
// learns nothing about what the route accepts.
//
// Two scope rules, both enforced from values the WORKER resolved and never
// from the request:
//
//   REPO — the studio's own bound work repo (its registry row's `repoSlug`,
//          which provisioning wrote). A studio cannot name a repo. Naming a
//          different one is refused loudly rather than ignored, because a
//          studio that believes it read another repo's board and silently got
//          its own is worse off than one that got an error.
//   TASK — only tasks carrying this studio's assignment label. `list` filters
//          server-side at GitHub; `show`, `envelope` and `state` go through
//          board.ts's requireAssignedTask.
//
// Board issue #41, half two added `state` to this surface, and it is worth
// being exact about what did NOT change with it. A studio still writes no
// GitHub label: it holds a spawn token, not a GitHub credential, and the only
// thing that ever calls the labels API is this Worker. What it may now do is
// ASK the Worker to move ITS OWN task within a three-state allowlist
// (board.ts's LEAD_TASK_STATES) that deliberately excludes `completed`. The
// operator surface above keeps the full vocabulary, behind Cloudflare Access.

/** `/fleet/tasks`, optionally one task number, optionally one action. Same
 *  grammar as BOARD_ROUTE_RE above minus `adopt`, `assign` and `verify`: a
 *  studio does not assign work and does not verify it, so there is no route
 *  for either to be refused at. */
const FLEET_BOARD_ROUTE_RE = /^\/fleet\/tasks(?:\/(\d+)(?:\/(envelope|state))?)?$/;

/** Registry rows, as a port — the one dependency of this handler that needs a
 *  D1 binding, so tests inject rows directly. Same seam shape `api` and
 *  `reach` already are for handleBoard. */
export type StudioRowFetch = () => Promise<StudioStatus[]>;

/**
 * The board repo a studio reads through, and the refusal when it asks for
 * another one.
 *
 * `bound` is the studio's own `repoSlug`, which the Worker wrote at provision
 * from a repo it had already verified against the App installation
 * (src/studio/repo.ts's resolveWorkRepo). A pre-P4a row has none, and every
 * such studio was cloned from the fleet default by construction — the same
 * reading StudioStatus.repoSlug's own doc comment already prescribes.
 *
 * An exactly-matching `requested` is allowed through as a no-op: it tells the
 * caller nothing it did not already know, and refusing it would make the
 * obvious CLI shape (send the repo you are standing in) fail for no reason.
 */
export function resolveStudioBoardRepo(
  bound: string | null | undefined, defaultSlug: string, requested: unknown,
): BoardResult<string> {
  const repo = (bound ?? defaultSlug).toLowerCase();
  if (requested === undefined || requested === null) return { ok: true, value: repo };
  if (typeof requested !== "string" || requested.trim().toLowerCase() !== repo) {
    return {
      ok: false, status: 403,
      message: `this studio is bound to ${repo} and reads no other board — ` +
        `${JSON.stringify(requested)} is not yours to ask about`,
    };
  }
  return { ok: true, value: repo };
}

export async function handleFleetBoard(
  req: Request, env: Env,
  api: BoardApi = githubBoardApi(env),
  rows: StudioRowFetch = () => listStudios(env),
): Promise<Response> {
  const url = new URL(req.url);
  const m = FLEET_BOARD_ROUTE_RE.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404 });
  const [, rawNumber, action] = m;
  const number = rawNumber === undefined ? null : Number(rawNumber);

  const method = req.method;
  const allowed = action === "envelope" || action === "state" ? method === "POST" : method === "GET";
  if (!allowed) return new Response("method not allowed", { status: 405 });

  // The shape gate before any I/O, exactly as handleFleetSpawn does it: this
  // route is deliberately Access-less, so an unauthenticated flood must cost
  // one regex, not a D1 query each.
  const presented = req.headers.get(SPAWN_TOKEN_HEADER);
  if (!isSpawnTokenShaped(presented)) return new Response("unauthorized", { status: 401 });
  const studio = await resolveSpawnParent(await rows(), presented);
  if (!studio) return new Response("unauthorized", { status: 401 });

  const body = method === "POST" ? await jsonBody(req) : {};
  const requested = method === "POST" ? body.repo : url.searchParams.get("repo") ?? undefined;
  const repo = resolveStudioBoardRepo(studio.repoSlug, env.AGENT_REPO, requested);
  if (!repo.ok) return respond(repo);

  try {
    if (number === null) {
      const query: ListTasksQuery = { assignedTo: studio.id };
      const state = url.searchParams.get("state");
      if (state !== null) query.state = state;
      const milestone = url.searchParams.get("milestone");
      if (milestone !== null) query.milestone = milestone;
      return respond(await listTasks(api, repo.value, query));
    }
    if (action === undefined) return respond(await showStudioTask(api, repo.value, number, studio.id));
    // Board issue #41, half two. `studio.id` is the id the Worker resolved
    // from the presented spawn token (resolveSpawnParent above) and never a
    // request field — the same rule every other branch on this surface
    // follows, and what makes "a lead moves only ITS OWN task" a fact about
    // this Worker rather than a claim the caller makes about itself.
    if (action === "state") {
      return respond(await revokeJuniorAuthorizationIfTerminal(
        env, repo.value, await transitionStudioTask(api, repo.value, number, body, studio.id)));
    }
    // Same stamp as handleBoard's own envelope branch: `msg_id` minted here,
    // once per comment. `sender` is stamped too on this surface — see
    // board.ts's commentStudioEnvelope for why a studio may not sign for
    // another one.
    return respond(
      await commentStudioEnvelope(api, repo.value, number, body, crypto.randomUUID(), studio.id),
    );
  } catch (err) {
    return upstreamFailure(err, method, url.pathname);
  }
}

/**
 * The brief resolver both provisioning entry points share (POST /studio/spawn,
 * POST /fleet/spawn and POST /studio/:id/provision).
 *
 * Lives here, not in src/studio/routes.ts, because it is a BOARD read and this
 * file already owns the one wired BoardApi. The studio id is always one the
 * Worker derived — never a request field — and board.ts's own ownership gate
 * is what makes "spawn this studio for that task" impossible to point at a
 * task belonging to somebody else.
 */
export function briefPromptResolver(
  env: Env, api: BoardApi = githubBoardApi(env),
): (studioId: string, repoSlug: string | undefined, task: number) => Promise<BoardResult<string>> {
  return async (studioId, repoSlug, task) => {
    const repo = (repoSlug ?? env.AGENT_REPO).toLowerCase();
    try {
      return await resolveBriefPrompt(api, repo, task, studioId);
    } catch (err) {
      const res = upstreamFailure(err, "GET", `/board/tasks/${task}`);
      return { ok: false, status: res.status, message: await res.text() };
    }
  };
}

/**
 * The fallback `resolveBringupEnv` (src/studio/provision.ts) reaches for when
 * a caller supplied no `cfg.briefPrompt` at all — recycle, and a bodyless
 * re-provision, neither of which ever names a task number and so can never
 * go through `briefPromptResolver` above. Board-side sibling of that
 * resolver, same shape, minus the task number: `resolveLatestAssignedBrief`
 * finds it FROM the board's own `studio:<id>` label instead.
 *
 * `repoSlug` is REQUIRED here, unlike `briefPromptResolver`'s
 * optional-defaulting-to-AGENT_REPO one: by the time this is called,
 * `runProvision` has already resolved the concrete work-repo slug (see
 * `resolveWorkRepoSlug`) — there is nothing left for this to default.
 *
 * Never throws: `resolveLatestAssignedBrief` itself is already total and
 * fail-open, so this try/catch is only a backstop against a `githubBoardApi`
 * default-argument construction throwing (e.g. a malformed token minter) —
 * the same defensive shape `briefPromptResolver` takes for its own call.
 */
export function assignedBriefResolver(
  env: Env, api: BoardApi = githubBoardApi(env),
): (studioId: string, repoSlug: string) => Promise<string | undefined> {
  return async (studioId, repoSlug) => {
    try {
      const result = await resolveLatestAssignedBrief(api, repoSlug.toLowerCase(), studioId);
      return result?.prompt;
    } catch (err) {
      console.error(`board: assigned-brief lookup failed for ${studioId}@${repoSlug}`, err);
      return undefined;
    }
  };
}

/**
 * `assignedBriefResolver`'s sibling for `fleet destroy`'s refusal gate (board
 * task #124's code review) — deliberately does NOT share that resolver's
 * fail-open-to-`undefined` posture. `assignedBriefResolver` backs a bringup
 * fallback where "couldn't tell" and "nothing assigned" are the same
 * decision (boot with no brief either way); `destroy` is destructive, and a
 * board hiccup must read as "cannot prove this is safe", not "safe" — see
 * `runDestroy`'s own doc comment (src/studio/destroy.ts) for why that
 * distinction is load-bearing here. So both a caught exception AND a
 * `openAssignedTasks` `{ ok: false }` are returned to the caller as-is,
 * never swallowed into a boolean.
 */
export function openTaskChecker(
  env: Env, api: BoardApi = githubBoardApi(env),
): (studioId: string, repoSlug: string) => Promise<
  { ok: true; hasOpenTask: boolean; tasks: number[]; drifted: number[] } | { ok: false; message: string }
> {
  return async (studioId, repoSlug) => {
    try {
      const result = await openAssignedTasks(api, repoSlug.toLowerCase(), studioId);
      if (!result.ok) return { ok: false, message: result.message };
      return {
        ok: true, hasOpenTask: result.value.length > 0,
        tasks: result.value.map((t) => t.number),
        drifted: result.value.filter((t) => t.drifted).map((t) => t.number),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`board: open-task lookup failed for ${studioId}@${repoSlug}`, err);
      return { ok: false, message };
    }
  };
}
