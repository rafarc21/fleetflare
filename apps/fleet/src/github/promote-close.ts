// Board issue #8: the pure commit -> PR -> issue resolver behind auto-close
// on promote. Pure over one small injected port (PromoteCloseApi) — same
// "no Env, no live fetch baked in" discipline as src/studio/task-state.ts's
// TaskStateDeps<C> and src/board/verify.ts's own pure core — so every rule
// here, INCLUDING the squash-merge fallback, is provable without a network.
//
// Two independent resolution paths, both exported so src/github/webhook.ts
// (the one real caller) can run both for every push and combine the result
// with mergeClosable:
//
//   resolveIssuesForPushCommits — the PRIMARY path. Walks the push's own
//     commits, asks GitHub which PR each belongs to, and reads that PR's
//     GraphQL closingIssuesReferences (GitHub's own parse of "Fixes #N").
//
//   resolveIssuesFromEnvelopeArtifacts — the path for a PR that never used a
//     literal closing keyword at all (so closingIssuesReferences is honestly
//     empty, not squashed-away) but whose issue's own §6 result envelope
//     names it. Cross-checks that PR's evidence against the SAME push's
//     commit list, for free (no extra GitHub call beyond a merge-commit-sha
//     lookup) — see src/board/pr-landed.ts for where the candidate list
//     (open tasks with a PR artifact in their latest envelope) comes from;
//     this module has no board/envelope knowledge of its own.

import { AUTO_CLOSE_BUDGET_MS, budgetExceeded, type TimeBudget } from "../time-budget";

/** Everything this module asks of real GitHub, as one small port. The real
 *  implementation (src/github/webhook.ts) wires these to
 *  src/github/api.ts's listPullsForCommit/closingIssuesForPull/
 *  listPullCommits/getPullRequest against a minted installation token; tests
 *  pass fakes, so every rule below is proven without an HTTP call. */
export interface PromoteCloseApi {
  listPullsForCommit: (sha: string) => Promise<{ number: number }[]>;
  closingIssues: (pullNumber: number) => Promise<number[]>;
  listPullCommits: (pullNumber: number) => Promise<string[]>;
  getPullRequestMergeCommit: (pullNumber: number) => Promise<string | null>;
  /**
   * Issue #208: `listPullsForCommit` + `closingIssues` for up to
   * PATH1_BATCH_MAX commits in ONE call (GraphQL `associatedPullRequests` ->
   * `closingIssuesReferences`). A sha with no PR maps to `[]`; a sha the
   * answer leaves out takes the per-commit REST walk. Optional: without it,
   * Path 1 is the per-commit REST walk.
   */
  /** `commits`: also fetch each PR's original commits (#252: only a
   *  top-level commit's PR can squash-fall-back, so only then). */
  pullsWithClosingIssuesForCommits?: (shas: string[], opts: { commits: boolean }) => Promise<Map<string, BatchedCommit>>;
}

/** One PR of a commit, with GitHub's own parse of its closing keywords and,
 *  when the batch fetched it, its original commits (listPullCommits' page). */
export type BatchedPull = {
  number: number; closingIssues: number[]; closingIssuesTotal?: number; commits?: string[]; commitsTotal?: number;
};

/** One commit's batched answer: its PRs (GitHub's first page) and, when
 *  known, how many it has in all. */
export type BatchedCommit = { prsTotal?: number; prs: BatchedPull[] };

/** Issue #208: commits per batched call — GitHub's practical ceiling for
 *  aliased sub-selections in one GraphQL query. */
export const PATH1_BATCH_MAX = 100;

/** Issue #208: GitHub's GraphQL server timeout. A batch call started with less
 *  budget left than this can run past the ~30s waitUntil ceiling and be killed
 *  with no log (#215's failure mode); those commits take the REST walk, whose
 *  per-call checks log the cutoff. */
export const PATH1_BATCH_MIN_BUDGET_MS = 10_000;

/** One issue this fleet can now mechanically prove is done: which issue,
 *  which sha carried the proof, and which PR the proof came through — `sha`
 *  and `viaPr` both feed the close-action's dedup key and its "closed by
 *  <sha>, promoted to <branch>" comment, so neither is dropped once found. */
export interface ClosableIssue {
  issue: number;
  sha: string;
  viaPr: number;
}

/**
 * A promotion-of-a-promotion is not a real shape in this fleet's actual
 * workflow — one staging, one main. Depth-limiting to a single extra level
 * is a termination guarantee, not a capacity estimate: unbounded recursion
 * here would be machinery with no failing case to justify it. A depth-limit
 * hit is logged and skipped, never looped.
 */
const SQUASH_FALLBACK_MAX_DEPTH = 1;

function logSkip(what: string, err: unknown): void {
  console.error(`promote-close: ${what} failed`, err instanceof Error ? err.message : err);
}

/**
 * Board issue #198: a big promotion's squash-fallback recursion can re-walk
 * the SAME PR's `closingIssues`/`listPullCommits` once per top-level commit
 * that happens to belong to it — measured live (acme-os, 2026-09-24):
 * 53/137/747 calls for three real promotion pushes, collapsing to 31/77/381
 * once deduped. Shared across the WHOLE push (every top-level commit's own
 * recursion branch), never reset per top-level commit — that scope is the
 * whole point: two DIFFERENT top-level commits mapping to the same PR must
 * still only pay for `closingIssues`/`listPullCommits` once.
 *
 *   - `seenShas`: a sha already walked (top-level or reached via the squash
 *     fallback) contributes nothing new the second time — `listPullsForCommit`
 *     is skipped entirely for it.
 *   - `seenPrs`: a PR already resolved (its `closingIssues`, and its
 *     `listPullCommits` fallback if that ran) is not re-resolved for a later
 *     commit that also maps to it — same evidence, first sha wins, exactly
 *     `close-action.ts`'s own idempotency philosophy elsewhere in this
 *     codebase. This does NOT drop any issue: the first commit to reach that
 *     PR already added every issue it closes to `results`.
 */
/**
 * Board issue #215, Gap 2: the per-push `budget` used to be checked ONLY in
 * the caller's top-level loop (`resolveIssuesForPushCommits`, once per
 * TOP-LEVEL commit) — nothing inside a single commit's own resolution ever
 * checked it again. A genuine squash-merge shape (one top-level commit whose
 * PR has dozens of original commits and empty `closingIssuesReferences`, so
 * the depth-1 fallback below fires) can loop over every one of those
 * original commits, and recurse into `resolveForCommit` for each, ENTIRELY
 * inside the one top-level loop iteration whose own budget check already
 * passed before entering it. Measured (2026-09-24, synthetic but
 * realistic): ~120 calls inside ONE `resolveForCommit` invocation for a
 * 57-original-commit PR — killed by the platform at the `waitUntil` ceiling
 * with no log at all, because nothing inside this function used to check.
 *
 * `budget`/`repo` are seeded once, by `resolveIssuesForPushCommits`, onto
 * this SAME per-push object that already threads `seenShas`/`seenPrs`
 * through every recursive call — the natural home for it, since it is
 * already per-push mutable state passed through the whole recursion.
 *
 * `budgetLogged`: the cutoff is now checked at THREE call sites (the
 * caller's top-level loop, the `for (const pr of prs)` loop below, and the
 * `for (const origSha of originalCommits)` fallback loop below) instead of
 * one — this flag is what keeps the whole push logging its budget cutoff
 * EXACTLY ONCE, wherever it actually happened, rather than once per site
 * that happens to notice the same already-exceeded budget on its own next
 * check.
 */
interface PushDedupContext {
  seenShas: Set<string>;
  seenPrs: Set<number>;
  /** Issue #208: batched answers, by sha. A sha absent here (no batch port,
   *  a failed chunk, a budget cutoff) takes the per-commit REST walk. */
  batched: Map<string, BatchedCommit>;
  /** Issue #252: set by the first failed batch call; every later chunk of
   *  this push goes straight to REST instead of failing again first. */
  batchBroken: boolean;
  budget?: TimeBudget;
  repo?: string;
  budgetLogged: boolean;
}

/** Logs the push's ONE budget-cutoff message, wherever it actually tripped —
 *  a no-op on every call after the first (`dedup.budgetLogged` already
 *  true), which is what lets multiple nested loops share this without ever
 *  double-logging the same cutoff. */
function logBudgetCutoff(dedup: PushDedupContext, detail: string): void {
  if (dedup.budgetLogged) return;
  dedup.budgetLogged = true;
  console.error(
    `promote-close: ${AUTO_CLOSE_BUDGET_MS / 1000}s budget exceeded for ${dedup.repo ?? "unknown repo"}, ${detail}`,
  );
}

/**
 * Issue #208: resolve, in batches of PATH1_BATCH_MAX, every sha not already
 * walked or fetched — one call per chunk instead of `listPullsForCommit` +
 * `closingIssues` per commit and PR. A failed chunk is said once and opens
 * the circuit (#252): it and every later chunk take the REST walk. Budget:
 * one read before each call, which needs PATH1_BATCH_MIN_BUDGET_MS left; a
 * cutoff is logged by the walk's own checks, once, as before (#198/#215).
 */
async function prefetch(
  api: PromoteCloseApi, shas: string[], dedup: PushDedupContext, opts: { commits: boolean },
): Promise<void> {
  if (!api.pullsWithClosingIssuesForCommits || dedup.batchBroken) return;
  const todo = [...new Set(shas)].filter((s) => !dedup.seenShas.has(s) && !dedup.batched.has(s));
  for (let i = 0; i < todo.length; i += PATH1_BATCH_MAX) {
    if (dedup.budget && dedup.budget.deadline - dedup.budget.clock() < PATH1_BATCH_MIN_BUDGET_MS) return;
    const chunk = todo.slice(i, i + PATH1_BATCH_MAX);
    try {
      const answer = await api.pullsWithClosingIssuesForCommits(chunk, opts);
      for (const s of chunk) {
        const c = answer.get(s);
        if (c) dedup.batched.set(s, c);
      }
    } catch (err) {
      dedup.batchBroken = true;
      logSkip(`pullsWithClosingIssuesForCommits(${chunk.length} commits), falling back to per-commit REST for the rest of this push`, err);
      return;
    }
  }
}

/** Issue #208: a batched connection GitHub cut at its page size is said, not
 *  silently walked short. Each connection is walked once (seenShas/seenPrs),
 *  so each cut logs once. */
function logPageCut(dedup: PushDedupContext, where: string, walked: number, total: number | undefined, what: string): void {
  if (total === undefined || total <= walked) return;
  console.error(`promote-close: page cut in ${dedup.repo ?? "unknown repo"}, ${where}: walked ${walked} of ${total} ${what}`);
}

async function resolveForCommit(
  api: PromoteCloseApi, sha: string, depth: number, dedup: PushDedupContext,
): Promise<ClosableIssue[]> {
  if (dedup.seenShas.has(sha)) return [];
  dedup.seenShas.add(sha);

  let prs: { number: number; closingIssues?: number[]; closingIssuesTotal?: number; commits?: string[]; commitsTotal?: number }[];
  const batched = dedup.batched.get(sha);
  if (batched) {
    prs = batched.prs;
    logPageCut(dedup, `commit ${sha}`, prs.length, batched.prsTotal, "associated PRs");
  } else {
    try {
      prs = await api.listPullsForCommit(sha);
    } catch (err) {
      logSkip(`listPullsForCommit(${sha})`, err);
      return [];
    }
  }

  const results: ClosableIssue[] = [];
  for (let i = 0; i < prs.length; i++) {
    // Board issue #215, Gap 2: checked before each PR this commit maps to —
    // usually just one, but a commit CAN map to more than one open PR.
    if (budgetExceeded(dedup.budget)) {
      logBudgetCutoff(dedup, `Path 1: processed ${i}/${prs.length} PRs for commit ${sha}`);
      break;
    }
    const pr = prs[i];
    if (dedup.seenPrs.has(pr.number)) continue;
    dedup.seenPrs.add(pr.number);

    let issues: number[];
    if (pr.closingIssues) {
      issues = pr.closingIssues;
      logPageCut(dedup, `PR #${pr.number}`, issues.length, pr.closingIssuesTotal, "closing issues");
    } else {
      try {
        issues = await api.closingIssues(pr.number);
      } catch (err) {
        logSkip(`closingIssues(#${pr.number})`, err);
        issues = [];
      }
    }
    if (issues.length > 0) {
      for (const issue of issues) results.push({ issue, sha, viaPr: pr.number });
      continue;
    }

    // Empty closingIssuesReferences: possibly a promotion/squash PR whose
    // own body never carried a closing keyword. Fall back to the PR's own
    // ORIGINAL commits (GitHub's record of them survives a squash even
    // though the squash commit itself has no git-parent link to them) and
    // recurse — depth-limited, see this module's header.
    if (depth >= SQUASH_FALLBACK_MAX_DEPTH) continue;
    let originalCommits: string[];
    if (pr.commits) {
      originalCommits = pr.commits;
      logPageCut(dedup, `PR #${pr.number}`, originalCommits.length, pr.commitsTotal, "commits");
    } else {
      try {
        originalCommits = await api.listPullCommits(pr.number);
      } catch (err) {
        logSkip(`listPullCommits(#${pr.number})`, err);
        continue;
      }
    }
    await prefetch(api, originalCommits, dedup, { commits: false });
    for (let j = 0; j < originalCommits.length; j++) {
      // Board issue #215, Gap 2: the load-bearing check — a big promotion's
      // fallback can be dozens of original commits, entirely inside this
      // one top-level commit's own resolution. Checked before each one.
      if (budgetExceeded(dedup.budget)) {
        logBudgetCutoff(
          dedup, `Path 1: processed ${j}/${originalCommits.length} original commits for PR #${pr.number}`,
        );
        break;
      }
      results.push(...await resolveForCommit(api, originalCommits[j], depth + 1, dedup));
    }
  }
  return results;
}

/** Options for {@link resolveIssuesForPushCommits} — both optional so every
 *  existing pure-unit caller (this module's own test suite) is unaffected:
 *  `repo` only names the push in the budget-exceeded log line below, and
 *  `budget` (board issue #198), when omitted, never stops the loop early. */
export interface ResolvePushCommitsOptions {
  repo?: string;
  budget?: TimeBudget;
}

/** GitHub's closing-keyword grammar: close/closes/closed, fix/fixes/fixed,
 *  resolve/resolves/resolved, optional colon, then `#N`, `owner/repo#N` or
 *  the issue URL. */
const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:#|([\w.-]+\/[\w.-]+)#|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/)(\d+)(?!\d)/gi;

/**
 * Issue #248: does this text (a PR's title + body) carry a closing keyword
 * for `issue` in `repo`? The same claim closingIssuesReferences parses, read
 * directly: GitHub fills that connection only for PRs into the default
 * branch, so a PR merged into staging needs the text.
 */
export function closesIssueByKeyword(text: string, issue: number, repo: string | readonly string[]): boolean {
  // #265: a qualified ref may name the caller's slug or the canonical name.
  const known = (typeof repo === "string" ? [repo] : repo).map((r) => r.toLowerCase());
  for (const m of text.matchAll(CLOSING_KEYWORD)) {
    const ref = m[1] ?? m[2];
    if (Number(m[3]) === issue && (ref === undefined || known.includes(ref.toLowerCase()))) return true;
  }
  return false;
}

/** The primary path, for every commit in one push. */
export async function resolveIssuesForPushCommits(
  api: PromoteCloseApi, commitShas: string[], opts: ResolvePushCommitsOptions = {},
): Promise<ClosableIssue[]> {
  // Board issue #215, Gap 2: `budget`/`repo` seeded onto the SAME dedup
  // object threaded through every recursive `resolveForCommit` call below —
  // `budgetLogged` starts false here and is shared by this loop's own check
  // and every nested check inside `resolveForCommit`, so the whole push logs
  // its budget cutoff at most once, wherever it actually happened.
  const dedup: PushDedupContext = {
    seenShas: new Set(), seenPrs: new Set(), batched: new Map(), batchBroken: false, budget: opts.budget, repo: opts.repo, budgetLogged: false,
  };
  // Issue #208: the whole push's commits in ONE call per PATH1_BATCH_MAX.
  await prefetch(api, commitShas, dedup, { commits: true });
  // ...and the squash fallback's original commits, for every PR of the push at
  // once, instead of one round per PR.
  const fallbackShas = commitShas.flatMap((s) => (dedup.batched.get(s)?.prs ?? [])
    .flatMap((pr) => (pr.closingIssues.length === 0 ? pr.commits ?? [] : [])));
  await prefetch(api, fallbackShas, dedup, { commits: false });
  const results: ClosableIssue[] = [];
  for (let i = 0; i < commitShas.length; i++) {
    if (budgetExceeded(dedup.budget)) {
      logBudgetCutoff(dedup, `Path 1: processed ${i}/${commitShas.length} commits`);
      break;
    }
    results.push(...await resolveForCommit(api, commitShas[i], 0, dedup));
  }
  return results;
}

/** One open task whose latest §6 envelope names a PR — src/board/pr-landed.ts's
 *  scan is what actually produces these; this module only consumes them. */
export interface EnvelopePrCandidate {
  taskNumber: number;
  prNumber: number;
}

/**
 * The cross-check path: does a candidate's PR show up in THIS push's own
 * commit list at all? Tried in order — the PR's merge commit sha first (one
 * call, the common/cheap case), then its full original commit list (the
 * fallback for a PR whose merge commit itself isn't the sha this push
 * carries, e.g. it merged into staging under a regular merge and only ONE of
 * its commits made it into this particular promotion). The first match wins;
 * a candidate with no intersection at all contributes nothing, silently —
 * "not landed by this push" is not an error.
 */
export async function resolveIssuesFromEnvelopeArtifacts(
  api: PromoteCloseApi, candidates: EnvelopePrCandidate[], pushShas: ReadonlySet<string>,
): Promise<ClosableIssue[]> {
  const results: ClosableIssue[] = [];
  for (const c of candidates) {
    let matched: string | null = null;
    try {
      const mergeSha = await api.getPullRequestMergeCommit(c.prNumber);
      if (mergeSha !== null && pushShas.has(mergeSha)) matched = mergeSha;
    } catch (err) {
      logSkip(`getPullRequestMergeCommit(#${c.prNumber})`, err);
    }
    if (matched === null) {
      try {
        const commits = await api.listPullCommits(c.prNumber);
        matched = commits.find((s) => pushShas.has(s)) ?? null;
      } catch (err) {
        logSkip(`listPullCommits(#${c.prNumber})`, err);
      }
    }
    if (matched !== null) results.push({ issue: c.taskNumber, sha: matched, viaPr: c.prNumber });
  }
  return results;
}

/**
 * Combines both paths for one push, de-duplicated by issue number. The
 * primary path (an explicit GraphQL closingIssuesReferences hit) is checked
 * first and wins on a collision — it is the stronger signal, GitHub's own
 * parse of an actual closing keyword, versus the cross-check's inferred
 * commit-intersection evidence.
 */
export function mergeClosable(primary: ClosableIssue[], extra: ClosableIssue[]): ClosableIssue[] {
  const seen = new Set(primary.map((c) => c.issue));
  return [...primary, ...extra.filter((c) => !seen.has(c.issue))];
}
