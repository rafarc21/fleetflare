import type { Env } from "../env";
import { revokeJuniorAuthorization } from "../junior/authz";
import { TERMINAL_TASK_STATES } from "../board/types";
import { recentApprovalsFor } from "../approvals/store";
import { sendCard } from "../telegram/api";
import { agentForProject, telegramConfig } from "../agents/registry";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import { deltaDigest, maestroIdFor } from "./wake-events";
import { listStudios } from "../studio/registry";
import { logWakeOutcome } from "../studio/wake";
import { getStudioStub } from "../studio/profile";
import { repoTokenMinter } from "./auth";
import {
  getDefaultBranch, listPullsForCommit, closingIssuesForPull, listPullCommits, getPullRequest,
  pullsWithClosingIssuesForCommits, resolveCanonicalRepoName,
} from "./api";
import {
  resolveIssuesForPushCommits, resolveIssuesFromEnvelopeArtifacts, type ClosableIssue, type PromoteCloseApi,
} from "./promote-close";
import { githubBoardApi } from "../board/routes";
import { listTasks } from "../board/board";
import { openTasksWithLatestPr } from "../board/pr-landed";
import { closeTaskOnPromote } from "../board/close-action";
import type { BoardApi } from "../board/board";
import { makeTimeBudget, budgetExceeded, AUTO_CLOSE_BUDGET_MS, type TimeBudget } from "../time-budget";
import { getFlag, setFlag } from "../state";
import { taskAssignees, taskStates, type TaskState } from "../board/types";
import { qualifiesForCommentWake, wakeOnComment } from "../board/comment-wake";
import type { AssignWakeDeps } from "../board/assign-wake";

const WATCHED = new Set(["refs/heads/staging", "refs/heads/main"]);
const WINDOW_MS = 30 * 60 * 1000;

/**
 * Constant-time comparison of the GitHub webhook signature — the entire
 * trust boundary for /gh. Unlike Day 1's Telegram secret header (a fixed
 * value behind Cloudflare's edge, compared with plain `!==`), this body is
 * attacker-chosen: a short-circuiting compare would leak how many leading
 * bytes of a guess matched through response timing, so that deferral does
 * not carry over here.
 *
 * The length check below sits outside that guarantee and does not need to
 * be constant-time: a valid signature's length (7-char "sha256=" prefix +
 * 64 hex chars) is a fixed public constant, not a secret, so branching on
 * whether a header matches that length leaks nothing an attacker doesn't
 * already know.
 */
export async function verifySignature(
  secret: string, body: string, header: string | null,
): Promise<boolean> {
  // Fix round 1, Important: WebCrypto's importKey rejects a zero-length
  // HMAC key with a thrown DataError. An unset GITHUB_WEBHOOK_SECRET binding
  // reads as undefined, and TextEncoder.encode(undefined) yields 0 bytes —
  // same as an explicit empty string — so both would otherwise throw here,
  // escape this function, escape handleGithubWebhook, and escape index.ts's
  // fetch with no try/catch anywhere on that path: every real signed
  // delivery 500s while an unsigned probe still 401s cleanly (it
  // short-circuits at the header check below and never reaches importKey),
  // so the endpoint reads healthy while the only alarm in the system is
  // dead. Must return a defined false here, not throw.
  if (!secret) return false;
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected =
    "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

/**
 * Board issue #182: the fleet_state flag tracking whether THIS stopped
 * episode has already logged its skip — same `<namespace>:<id>` idiom
 * tasks/watchdog.ts's rearmKey/alertedKey use for the identical "log/alert
 * once per episode, not once per tick" shape. Set to "1" the first time
 * wakeMaestro sees the studio stopped, cleared back to "0" the next time it
 * sees the studio NOT stopped (the recovery signal), so the NEXT stop
 * episode on the same studio logs again instead of being muted forever.
 */
function stoppedWakeSkipKey(studioId: string): string {
  return `stopped-wake-skip:${studioId}`;
}

/**
 * Give the repo's maestro a turn, carrying what just changed.
 *
 * TOTAL: every failure — an unparseable body, a repo with no maestro, a
 * container that will not take the keystrokes — is logged and swallowed. The
 * caller has already committed to a 200, and the 20-minute sweep re-detects
 * any delta a missed wake would have carried.
 */
/**
 * Issue #35: a label change made OUTSIDE the Worker (the GitHub UI, a
 * studio's own gh token) never passed board/routes.ts's revoke. Any terminal
 * state label added or removed, or a close, deletes the task's junior record
 * here. Removing a terminal label is the terminal -> live relabel itself; the
 * add catches it earlier. Revoke only, never grant; a bad payload or a D1
 * error is logged and the delivery still answers 200 like every other event.
 */
async function revokeJuniorOnIssueEvent(env: Env, body: string): Promise<void> {
  try {
    const p = JSON.parse(body) as {
      action?: string; label?: { name?: string }; issue?: { number?: number }; repository?: { full_name?: string };
    };
    const repo = p.repository?.full_name;
    const number = p.issue?.number;
    if (typeof repo !== "string" || typeof number !== "number") return;
    const label = p.label?.name ?? "";
    const terminal = (TERMINAL_TASK_STATES as readonly string[]).includes(label);
    const why = p.action === "closed" ? "closed"
      : (p.action === "labeled" || p.action === "unlabeled") && terminal ? `${p.action} ${label}` : null;
    if (why === null) return;
    await revokeJuniorAuthorization(env.DB, repo, number);
    console.log(`junior: revoked ${repo}#${number} on issues webhook (${why})`);
  } catch (err) {
    console.error("junior: issues webhook revoke failed", err instanceof Error ? err.message : String(err));
  }
}

async function wakeMaestro(env: Env, event: string, body: string, now: number): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return;
  }
  const digest = deltaDigest(event, payload);
  if (!digest) return;
  const repo = (payload as { repository?: { full_name?: string } }).repository?.full_name;
  const studioId = maestroIdFor(repo);
  if (!studioId) return;
  try {
    // Issue #100 F5: the registry FIRST, as the board's assign path does —
    // `idFromName` on a name nothing uses mints an empty Durable Object, and
    // this runs once per GitHub event for a repo that may have no maestro.
    //
    // Issue #182: read the matched row's STATE too, not just its existence.
    // A stopped maestro's wakeStudio call is wasted work — runGatedWake's own
    // gate (issue #82, src/studio/wake.ts's `state === "stopped"` refusal)
    // already refuses it, correctly, but only AFTER paying for the DO call
    // and the alarm wakeStudio schedules. Real production tail (2026-09-24):
    // 22 such wasted calls in 33 minutes against a stopped
    // demosite-life--maestro. This skips the DO call entirely instead of
    // reaching that (unchanged, still-correct) gate.
    const studio = (await listStudios(env)).find((s) => s.id === studioId);
    if (!studio) return;
    const skipKey = stoppedWakeSkipKey(studioId);
    if (studio.state === "stopped") {
      // Log once per stopped EPISODE, not once per event — this is expected,
      // benign behaviour (the studio is deliberately stopped), not a genuine
      // failure, so it goes through console.log; console.error below stays
      // reserved for a call that actually threw.
      if ((await getFlag(env.DB, skipKey)) !== "1") {
        console.log(`maestro wake (${studioId}) skipped: studio is stopped`);
        await setFlag(env.DB, skipKey, "1", now);
      }
      return;
    }
    // Not stopped (running again, or never was) — clear the flag
    // unconditionally, same posture watchdog.ts's clearRearm takes for its
    // own pair of flags: a redundant write of "0" is free, and this is what
    // makes the NEXT stop episode log again instead of a permanent mute.
    await setFlag(env.DB, skipKey, "0", now);
    const outcome = await getStudioStub(env, studioId).wakeStudio(digest);
    logWakeOutcome(`maestro wake (${studioId})`, outcome);
  } catch (err) {
    console.error(`maestro wake threw (${studioId})`, err);
  }
}

/** Loose shape of the one `issue_comment` payload field this needs beyond
 *  what `deltaDigest`/`issueOf` (wake-events.ts) already read: the issue's
 *  own label list, which carries both its board state and its studio
 *  assignee, and the comment's own author login + URL. GitHub's real
 *  `issue.labels` entries carry more than `name` (id, color, description);
 *  none of that is read here, same posture `issueOf` already takes. */
interface CommentPayload {
  action?: string;
  repository?: { full_name?: string };
  issue?: { number?: number; title?: string; labels?: { name?: string }[] };
  comment?: { body?: string; html_url?: string; user?: { login?: string } };
}

/**
 * Board issue #236: give the commented-on TASK'S OWN assignee a turn, not
 * the repo's maestro — an ADDITIONAL, targeted wake alongside `wakeMaestro`
 * above, not a replacement for it. See
 * docs/superpowers/specs/2026-09-25-comment-triggers-wake-design.md for the
 * full design: trigger conditions, the bot/envelope exclusion, and why no
 * extra dedup marker is added here.
 *
 * Reads the issue's labels straight off the payload GitHub already sent —
 * same lightweight approach `wake-events.ts`'s `issueOf` already takes — so
 * this needs no extra API call to learn the task's board state or assignee.
 *
 * TOTAL: same swallow-all posture as `wakeMaestro` — a malformed payload, an
 * unresolved assignee, or a failed RPC are all logged and swallowed, never
 * thrown past this function. The caller has already committed to a 200, and
 * a missed wake here is not something GitHub retrying the delivery fixes.
 */
async function wakeTaskOnComment(env: Env, body: string): Promise<void> {
  try {
    const payload: unknown = JSON.parse(body);
    if (payload === null || typeof payload !== "object") return;
    const p = payload as CommentPayload;
    // Only a NEW comment is a candidate — an edit or a delete of an existing
    // comment carries no new instruction and must not re-fire this path.
    if (p.action !== "created") return;
    const issue = p.issue;
    if (!issue || typeof issue.number !== "number" || typeof issue.title !== "string") return;
    const labels = Array.isArray(issue.labels)
      ? issue.labels.map((l) => l?.name).filter((n): n is string => typeof n === "string")
      : [];
    const commentBody = typeof p.comment?.body === "string" ? p.comment.body : "";
    const commentUrl = typeof p.comment?.html_url === "string" ? p.comment.html_url : "";
    const authorLogin = typeof p.comment?.user?.login === "string" ? p.comment.user.login : undefined;

    // An ambiguous label set (zero or more than one state label) reads as
    // "state unknown" here, never as input_required — see
    // qualifiesForCommentWake's own doc comment for why an unclear read must
    // never be upgraded into an unmarked wake.
    const states = taskStates(labels);
    const state: TaskState | null = states.length === 1 ? states[0] : null;
    // Precedence (see qualifiesForCommentWake's own doc comment): a real §6
    // envelope always excludes; an explicit /wake marker always qualifies,
    // even from a [bot] author; only otherwise does the [bot] filter apply.
    if (!qualifiesForCommentWake(state, commentBody, authorLogin)) return;

    // Zero assignees (backlog) or more than one (label-drift) both mean
    // there is no single unambiguous target — same refusal posture
    // `maestroIdFor`'s own `null` case already takes: guessing a target here
    // turns "no wake" into "wrong studio woken".
    const assignees = taskAssignees(labels);
    if (assignees.length !== 1) return;
    const studioId = assignees[0];

    // Round 2 SHOULD-FIX: `wakeMaestro` above ALREADY woke this exact studio
    // for this SAME delivery when the task's own assignee happens to be the
    // repo's maestro (`studio:<repo>--maestro`) — a second, targeted wake
    // here would land a redundant prompt in the same tmux pane.
    const repo = typeof p.repository?.full_name === "string" ? p.repository.full_name : undefined;
    if (studioId === maestroIdFor(repo)) return;
    // Issue #284 round 2: `wakeOnComment` now checks the assignee's own
    // recorded repo against the comment's repo (see that function's own doc
    // comment for the stale-label failure this closes) — it needs the repo
    // as a real string, not `undefined`. A delivery with no
    // `repository.full_name` is a malformed payload no genuine GitHub
    // delivery sends; same refusal posture as every other "shape this
    // function cannot use" check above.
    if (repo === undefined) return;

    const mint = repoTokenMinter(env);
    const deps: AssignWakeDeps = {
      studioState: async (id) => {
        const row = (await listStudios(env)).find((s) => s.id === id);
        // `?? null`: see board/routes.ts's `realAssignWake` for why a row
        // missing this key entirely (predates the field, or a test fixture
        // that omits it) must normalize to `null`, not `undefined`.
        return row ? { state: row.state, repoSlug: row.repoSlug ?? null } : null;
      },
      wake: (id, prompt) => getStudioStub(env, id).wakeStudioOnAssignment(prompt),
      resolveCanonicalRepo: async (slug) => resolveCanonicalRepoName(await mint(slug), slug),
    };
    const task = { number: issue.number, title: issue.title, repo };
    const report = await wakeOnComment(deps, studioId, task, commentUrl);
    if (!report.woke) console.error(`task comment wake (${studioId}) on #${task.number} — ${report.reason}`);
  } catch (err) {
    console.error("task comment wake threw", err);
  }
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: { full_name?: string };
  pusher?: { name?: string };
  sender?: { login?: string };
  // Board issue #8: GitHub's real push payload carries every commit
  // included in this push, oldest first — `id` (the sha) and `message`
  // are the two fields autoCloseOnPromote below actually reads; GitHub's
  // own payload carries several more (author, url, timestamp, added/
  // removed/modified paths) that nothing here needs. Absent on a payload
  // this codebase has no test fixture for is treated as `[]`, never a
  // crash — see autoCloseOnPromote's own `p.commits ?? []`.
  commits?: { id: string; message?: string }[];
}

/** Shared setup for both phases of auto-close-on-promote — computed ONCE
 *  per push and reused by Phase A and Phase B below, rather than minting a
 *  second token / asking `getDefaultBranch` twice for the same push. `null`
 *  means "nothing to do for this push" — a missing repo/ref, a push that
 *  isn't to the default branch, or any failure while establishing that
 *  (no repo auth configured, a rate limit, a malformed payload).
 *
 *  `budget` (board issue #198): one shared ~25s wall-clock deadline for the
 *  ENTIRE push — Path 1's commit walk, Path 2's candidate scan, AND the
 *  close loop that follows both — computed once here from a LIVE clock, not
 *  reset per phase. See src/time-budget.ts's own header for why one shared
 *  deadline, not one per phase, is this fix's chosen reading of the issue. */
interface AutoCloseSetup {
  repo: string;
  defaultBranch: string;
  api: BoardApi;
  promoteApi: PromoteCloseApi;
  commitShas: string[];
  budget: TimeBudget;
}

/**
 * Board issue #8's trigger: a push whose `ref` IS the repo's own default
 * branch — asked via `getDefaultBranch`, never assumed to be `"main"` (see
 * the plan doc's rejected-`deployment_status` section for why this, and not
 * a later deploy event, is the trigger). Runs for EVERY push this Worker
 * receives, not just ones already in `WATCHED` above: that set is the
 * UNAPPROVED WRITE alarm's own literal `staging`/`main`, and reusing it here
 * would silently reintroduce the exact hardcoding this feature was told not
 * to have.
 *
 * TOTAL and swallow-all, same posture `wakeMaestro` above already takes for
 * this same handler: every failure is logged and reported as "nothing to
 * do" (`null`) rather than thrown — the caller has already committed to a
 * 200, both here and in each phase below.
 */
async function prepareAutoClose(env: Env, p: PushPayload, now: () => number): Promise<AutoCloseSetup | null> {
  const repo = p.repository?.full_name;
  if (!repo || !p.ref) return null;
  try {
    const mint = repoTokenMinter(env);
    const token = await mint(repo);
    const defaultBranch = await getDefaultBranch(token, repo);
    if (p.ref !== `refs/heads/${defaultBranch}`) return null;

    const api = githubBoardApi(env);
    const promoteApi: PromoteCloseApi = {
      listPullsForCommit: (sha) => listPullsForCommit(token, repo, sha),
      closingIssues: (pullNumber) => closingIssuesForPull(token, repo, pullNumber),
      // Issue #208: Path 1's whole push in one GraphQL call per 100 commits.
      pullsWithClosingIssuesForCommits: (shas, opts) => pullsWithClosingIssuesForCommits(token, repo, shas, opts),
      listPullCommits: (pullNumber) => listPullCommits(token, repo, pullNumber),
      getPullRequestMergeCommit: async (pullNumber) => (await getPullRequest(token, repo, pullNumber)).mergeCommitSha,
    };
    const commitShas = (p.commits ?? [])
      .map((c) => c.id)
      .filter((id): id is string => typeof id === "string" && id !== "");

    // Board issue #198: one shared ~25s deadline for the whole push, seeded
    // from a LIVE clock call made right now (not the frozen snapshot the
    // webhook arrived with) — see AutoCloseSetup's own doc comment.
    const budget = makeTimeBudget(now, AUTO_CLOSE_BUDGET_MS);

    return { repo, defaultBranch, api, promoteApi, commitShas, budget };
  } catch (err) {
    console.error(`promote-close: push processing failed for ${repo}`, err);
    return null;
  }
}

async function closeEach(env: Env, setup: AutoCloseSetup, closable: ClosableIssue[], now: number): Promise<void> {
  for (let i = 0; i < closable.length; i++) {
    // Board issue #198: the third and last loop site sharing the push's one
    // budget (Path 1's commit walk and Path 2's candidate scan are the other
    // two) — a big enough closable batch (an unusually large promotion, or a
    // scan that ate most of the budget before this loop even started) could
    // otherwise still run past the deadline this fix exists to enforce.
    if (budgetExceeded(setup.budget)) {
      console.error(
        `promote-close: ${AUTO_CLOSE_BUDGET_MS / 1000}s budget exceeded for ${setup.repo}, close loop: processed ` +
        `${i}/${closable.length} closes`,
      );
      break;
    }
    const c = closable[i];
    // Board issue #8, Finding 2: per-item try/catch, not just the outer one
    // around each phase. closeTaskOnPromote throws on a genuine write
    // failure (close-action.ts's dedup marker is last, not first), so a
    // throw for ONE issue in this push's batch must not stop the loop
    // before the REST of the batch's issues are ever attempted -- GitHub
    // does not retry a 200 response, so an uncaught throw here would leave
    // every later issue in the SAME push uncovered until the next push (or
    // a manual `fleet task reap`).
    try {
      await closeTaskOnPromote(env, setup.api, setup.repo, c.issue, { sha: c.sha, branch: setup.defaultBranch }, now);
    } catch (err) {
      console.error(`promote-close: closing #${c.issue} in ${setup.repo} failed`, err);
    }
  }
}

/**
 * Phase A — Path 1 only: the primary commit -> PR -> issue walk (with the
 * depth-1 squash fallback promote-close.ts's own header documents).
 *
 * Board issue #198: NO LONGER awaited by the request handler — the whole of
 * `autoCloseOnPromote` (this phase AND Phase B below) now runs inside the
 * caller's own `ctx.waitUntil`, never before the HTTP response. Board issue
 * #180's own claim that this phase was already "well under GitHub's 10s
 * webhook delivery timeout" measured wrong: a real acme-os promotion
 * (7-57 commits) cost 53/137/747 LIVE `PromoteCloseApi` calls = 12-217s
 * measured (2026-09-24) — Phase A alone, awaited, blew the 10s budget on its
 * own on a big promotion, the exact failure #180 was supposed to have fixed.
 * Deduped (see promote-close.ts's own `PushDedupContext`), the same three
 * pushes cost only 31/77/381 calls — most of the old waste was the SAME PR's
 * `closingIssues`/`listPullCommits` being re-resolved once per commit that
 * happened to belong to it. This phase is also bounded by the push's own
 * shared `budget` (issue #198) — see `resolveIssuesForPushCommits`'s own loop.
 */
async function autoClosePhaseA(env: Env, setup: AutoCloseSetup, now: number): Promise<void> {
  try {
    const primary = await resolveIssuesForPushCommits(setup.promoteApi, setup.commitShas, {
      repo: setup.repo, budget: setup.budget,
    });
    await closeEach(env, setup, primary, now);
  } catch (err) {
    console.error(`promote-close: Path 1 (push commits) failed for ${setup.repo}`, err);
  }
}

/**
 * Phase B — Path 2, the envelope cross-check: for a PR that never carried a
 * closing keyword at all. Shares board/pr-landed.ts's scan with
 * task-reap.ts, walked from the opposite direction (this push's own
 * commits, rather than asking GitHub for ancestry). The full task list is
 * passed straight through — no `.open` pre-filter here (board issue #26):
 * openTasksWithLatestPr's own predicate (bounded, board issue #180 —
 * OPEN_TASKS_SCAN_MAX_CANDIDATES) is the single source of truth for "does
 * this still need a look", including a task GitHub already closed natively
 * whose board label isn't `completed` yet.
 *
 * Board issue #198: NEVER awaited by the request handler, same as Phase A —
 * the whole of `autoCloseOnPromote` (both phases) now runs inside the
 * caller's own `ctx.waitUntil`, so this phase gains nothing extra from being
 * separately deferred any more; it is simply run after Phase A, sequentially,
 * inside that one deferred call. Board issue #180's original split still
 * matters for a DIFFERENT reason now: candidates here are cheap to skip
 * (issue #198's own board-state-label filter, `pr-landed.ts`'s
 * `openTasksWithLatestPr`) and bounded both by count (`OPEN_TASKS_SCAN_MAX_CANDIDATES`)
 * and by this push's own shared `budget` — see that function's own loop.
 * Wrapped in its own try/catch — same swallow-all posture as everywhere else
 * in this file — so a rejection here never surfaces as an unhandled
 * rejection out of the `waitUntil`'d promise the caller holds.
 *
 * Board issue #157/#180: does NOT need to be merged against Phase A's own
 * closable set first (the old `mergeClosable` "primary wins" step) — both
 * phases call the SAME idempotent `closeTaskOnPromote`, so an issue Phase A
 * already closed is found already-`completed`+closed by Phase B (a
 * different sha, same issue) and cleanly no-ops there instead.
 */
/** #252: what Phase B's `listTasks` costs on a busy repo (acme-os,
 *  measured 2026-09-24: ~20 GraphQL pages, ~5s). */
const PHASE_B_LIST_TASKS_COST_MS = 5_000;

async function autoClosePhaseB(env: Env, setup: AutoCloseSetup, now: number): Promise<void> {
  try {
    // Board issue #215, Gap 1: `listTasks` alone costs ~20 `listIssues`
    // GraphQL pages on a busy repo (acme-os, measured 2026-09-24: ~5s) --
    // if Path 1 already spent the whole shared budget (a real 39- or
    // 57-commit promotion), NOTHING inside `listTasks` itself checks the
    // budget, so entering it anyway runs this phase blind past the ~30s
    // `waitUntil` ceiling with no trace at all (the platform kills it before
    // this phase's own "skipped" log, or any other log, ever fires). Checked
    // BEFORE the call, not after -- the whole point is to never start it.
    // #252: and not merely "not yet exceeded": entered with less than its
    // own cost left, it overruns the same way.
    const left = setup.budget.deadline - setup.budget.clock();
    if (left < PHASE_B_LIST_TASKS_COST_MS) {
      console.error(
        `promote-close: Path 2 skipped — budget: ${Math.max(0, Math.floor(left / 1000))}s left for ${setup.repo}, ` +
        `under listTasks' ~${PHASE_B_LIST_TASKS_COST_MS / 1000}s cost, before listTasks`,
      );
      return;
    }
    const tasksResult = await listTasks(setup.api, setup.repo, {});
    const allTasks = tasksResult.ok ? tasksResult.value : [];
    const candidates = (await openTasksWithLatestPr(setup.api, setup.repo, allTasks, setup.budget))
      .filter((t): t is { taskNumber: number; prNumber: number } => t.prNumber !== null)
      .map((t) => ({ taskNumber: t.taskNumber, prNumber: t.prNumber }));

    // Board issue #215, Gap 1 (second check): the budget can run out DURING
    // `listTasks` + `openTasksWithLatestPr` even though the phase started
    // with time to spare -- this second check catches that case before the
    // envelope cross-check's own GitHub calls (`getPullRequestMergeCommit`/
    // `listPullCommits` per candidate) start on top of an already-blown budget.
    if (budgetExceeded(setup.budget)) {
      console.error(
        `promote-close: Path 2 skipped — budget (${AUTO_CLOSE_BUDGET_MS / 1000}s) exceeded for ${setup.repo}, ` +
        `before the envelope cross-check (${candidates.length} candidates found)`,
      );
      return;
    }
    const extra = await resolveIssuesFromEnvelopeArtifacts(setup.promoteApi, candidates, new Set(setup.commitShas));
    await closeEach(env, setup, extra, now);
  } catch (err) {
    console.error(`promote-close: Path 2 (envelope cross-check) failed for ${setup.repo}`, err);
  }
}

/**
 * Entry point. Board issue #198: the caller (`handleGithubWebhook`) now hands
 * this ENTIRE function to `ctx.waitUntil` — not just Phase B, as board issue
 * #180 originally had it. Nothing in here, including `prepareAutoClose`'s own
 * token mint / `getDefaultBranch` / ref check, runs before the HTTP response
 * is sent any more. Since the whole call is already deferred by the caller,
 * this function itself no longer needs to defer Phase B a second time — it
 * just awaits Phase A then Phase B, in order, both already running inside the
 * outer `waitUntil`. `ctx` is no longer needed here (nothing left to defer
 * FROM inside this function), so it is dropped from the signature; `now` is
 * now a live clock function, not a frozen snapshot — see `AutoCloseSetup`'s
 * own `budget` field for why (board issue #198's shared ~25s budget needs to
 * measure ELAPSED time across a potentially-long scan).
 */
async function autoCloseOnPromote(env: Env, p: PushPayload, now: () => number): Promise<void> {
  const setup = await prepareAutoClose(env, p, now);
  if (!setup) return;
  const nowMs = now();
  await autoClosePhaseA(env, setup, nowMs);
  await autoClosePhaseB(env, setup, nowMs);
}

/**
 * The fleet's only after-the-fact safety net for a write to staging or
 * main. Two guarantees in the spec are policy, not structure: the agent's
 * installation token can merge a PR, and it can dispatch a workflow that
 * deploys. Neither is prevented anywhere in this codebase — this handler
 * exists to make a violation of that policy loud within seconds, not to
 * enforce it.
 *
 * KNOWN LIMITATION, recorded rather than papered over: the check below —
 * a 30-minute window plus `state === "executed" || state === "approved"`
 * — is a heuristic, not an authorisation decision.
 *   1. Two approved merges close together can leave the second one
 *      silently read as covered by the first's approval gate.
 *   2. A legitimate merge pushed straight from the operator's own laptop
 *      (which never went through an approval gate at all) reads as
 *      unapproved and pages the operator for nothing.
 *   3. Fix round 1, promoted Minor: `approved` is accepted alongside
 *      `executed` because handleCallbackQuery (src/approvals/gates.ts)
 *      writes `state = "executed"` only AFTER the real merge already
 *      happened on GitHub, and swallows that write's own failure into a
 *      console.error rather than retrying. So a genuinely approved merge
 *      races this webhook's own push delivery (both states are true
 *      positives either way), and if that terminal write ever fails
 *      outright the row is stuck at `approved` forever. Treating only
 *      `executed` as covered would then alert "UNAPPROVED WRITE" for a
 *      merge the operator personally approved — on every push, forever.
 *      Costs nothing in detection strength: a rejected gate settles at
 *      `failed`, and a failed execution also settles at `failed` — never
 *      `approved` or `executed` — so neither is silenced by this.
 * It exists to make an unapproved write loud, not to adjudicate one.
 */
export async function handleGithubWebhook(
  req: Request, env: Env, now: () => number, ctx: ExecutionContext,
): Promise<Response> {
  // Fix round 1, Important: distinct from a bad signature. verifySignature's
  // own guard above already keeps this path from throwing, but a plain 401
  // here would make "the secret was never configured" indistinguishable
  // from "someone sent a bad signature" in GitHub's delivery log — the
  // exact scenario where this being the fleet's only alarm matters most.
  // Checked before touching the body: this is a config precondition, not a
  // verdict on anything the request sent.
  if (!env.GITHUB_WEBHOOK_SECRET) {
    console.error("GITHUB_WEBHOOK_SECRET is not configured — /gh cannot verify any delivery");
    return new Response("misconfigured", { status: 503 });
  }
  const body = await req.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, req.headers.get("x-hub-signature-256")))) {
    // The entire boundary: no event, no alert, no D1 write below this line
    // when verification fails.
    return new Response("forbidden", { status: 401 });
  }
  /**
   * The waker's branch (Phase 2, task 2). `push` keeps the UNAPPROVED WRITE
   * path below, untouched; the four events the design spec names instead give
   * maestro a turn, carrying the delta that fired.
   *
   * Placed AFTER the signature gate and never before it: a wake spends Claude
   * tokens, so an unsigned delivery must not be able to buy one.
   *
   * Returns 200 whatever the wake did — same contract as everything else past
   * the gate. A failed wake means a studio whose tmux window is gone; GitHub
   * retrying the delivery cannot fix that, and a 500 here would have it retry
   * anyway.
   */
  const event = req.headers.get("x-github-event");
  if (event !== "push") {
    // Issue #41: the revoke FIRST. GitHub cancels a delivery after 10s and
    // the maestro wake below can outlast that; a cancelled request must not
    // take the revoke with it.
    if (event === "issues") await revokeJuniorOnIssueEvent(env, body);
    if (event) await wakeMaestro(env, event, body, now());
    // Board issue #236: an ADDITIONAL, targeted wake for the commented-on
    // task's own assignee — independent of wakeMaestro above, which still
    // fires for its own, separate, generic supervision purpose.
    // Board issue #198 precedent (this file's own autoCloseOnPromote,
    // handed to ctx.waitUntil below on the push path): GitHub's webhook
    // delivery budget is 10s, while a wake's own exec can take up to 30s, so
    // this must not block the response either.
    if (event === "issue_comment") ctx.waitUntil(wakeTaskOnComment(env, body));
    return new Response("ok");
  }

  // Everything past the signature gate returns 200, including a body that
  // fails to parse — same contract, and same reason, as
  // telegram/webhook.ts: an uncaught throw here surfaces as a runtime 500,
  // and a corrupted-in-transit delivery or a hand-crafted replay by
  // whoever holds a leaked secret is not something crashing the handler
  // fixes.
  let p: PushPayload;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return new Response("ok");
    p = parsed as PushPayload;
  } catch {
    return new Response("ok");
  }
  // Board issue #8: independent of the WATCHED gate below on purpose — see
  // autoCloseOnPromote's own doc comment for why. Board issue #198: handed
  // to `ctx.waitUntil` WHOLESALE now — not just Phase B, as board issue
  // #180 originally had it. NOTHING in `autoCloseOnPromote` (not the token
  // mint, not `getDefaultBranch`, not Phase A, not Phase B) runs before this
  // line returns; see that function's own doc comment for why #180's split
  // did not actually go far enough (a big promotion's Phase A alone could
  // still blow GitHub's 10s webhook timeout, measured live).
  ctx.waitUntil(autoCloseOnPromote(env, p, now));

  if (!p.ref || !WATCHED.has(p.ref)) return new Response("ok");

  const branch = p.ref.replace("refs/heads/", "");
  const action = branch === "staging" ? "merge_staging" : "merge_main";
  const project = "websites";
  const nowMs = now();
  const recent = await recentApprovalsFor(env.DB, project, action, nowMs - WINDOW_MS);
  if (recent.some((r) => r.state === "executed" || r.state === "approved")) return new Response("ok");

  // Keys on sender.login — never head_commit.author.name or
  // commits[].author.name. GitHub derives sender.login from the credential
  // that authenticated the push (here, the App's installation token), so
  // it reads the App's own bot login regardless of local git config. The
  // commit-author fields instead come from the commit object itself, which
  // is exactly what the container's own (env-configured, see FLEET_BOT_NAME
  // on Env) user.name/user.email git config governs — keying on those would
  // compare against a string that never appears on a real push, which is
  // worse than no detection at all: it looks like it works. pusher.name is
  // kept as a fallback for the same reason sender.login is safe to trust:
  // GitHub populates it from the same authenticated-actor context, not
  // from commit metadata.
  const who = p.sender?.login ?? p.pusher?.name ?? "unknown";
  const alert =
    `UNAPPROVED WRITE\n${p.repository?.full_name} ${branch} ` +
    `${(p.after ?? "").slice(0, 8)}\nactor: ${who}\nNo approved gate in the last 30 minutes.`;

  await appendEvent(
    env.DB,
    makeEvent(
      { from: "worker", to: "human", kind: "escalation", project, body: alert },
      nowMs, crypto.randomUUID().slice(0, 8),
    ),
  );
  // Board #334: with Telegram off the D1 event above is the whole record.
  const agent = agentForProject(project, env);
  const tg = telegramConfig(env);
  if (agent && tg) {
    // sendCard throws on a non-ok response or a body with ok !== true
    // (telegram/api.ts's call() helper) — a failed alert must not surface
    // as a 500 back to GitHub. The event above is already durably recorded
    // in D1 regardless of whether this notification lands.
    try {
      await sendCard(tg.token, agent.chatId, alert);
    } catch (err) {
      console.error("alert delivery failed", err);
    }
  }
  return new Response("ok");
}
