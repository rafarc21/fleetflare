// #1469: `fleet review <pr>` — the cloud PR review verb's pure decision
// logic. No Env, no network, no token: the route (review-route.ts) hands in
// the GitHub/board reads, tests hand in fakes. The commit status this posts is
// a SEPARATE context from the gate runner's `gate/verdict`, so an advisory
// review never blocks a merge the gate itself certified.
//
// Semantics, from the task + operator update (2026-11-13):
//   - one reviewer per PR head sha (the status on the head is the dedup key);
//   - docs-only and lockfile-only diffs are skipped (neutral, no reviewer);
//   - a failure verdict FAILS the merge gate only when a changed file matches
//     one of the repo's `review.blockingPaths`; otherwise it is advisory
//     (neutral) — success is success either way.
import { matchesPathRules, type ReviewConfig } from "./config";

/** The commit status context this feature posts. Distinct from the gate
 *  runner's `gate/verdict` (status-post.ts). */
export const REVIEW_STATUS_CONTEXT = "gate/review";

/** The three terminal states a review posts. `neutral` is not pending: it is
 *  a finished review that neither certifies nor blocks. */
export type ReviewState = "success" | "failure" | "neutral";

/** The CLI-facing `--axis` values. Absent means all three axes. */
export const REVIEW_AXES = ["spec", "standards", "security"] as const;
export type ReviewAxis = (typeof REVIEW_AXES)[number];

/** Lockfile basenames that never warrant a cloud review. */
const LOCKFILES = new Set([
  "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
  "Cargo.lock", "composer.lock", "poetry.lock", "Pipfile.lock", "go.sum",
  "Gemfile.lock", "mix.lock", "podfile.lock",
]);

/** Whether one changed path is documentation. */
function isDocsPath(file: string): boolean {
  if (file.startsWith("docs/") || file.includes("/docs/")) return true;
  return /\.(md|mdx|rst|txt)$/i.test(file)
    || /(^|\/)(README|CHANGELOG|CONTRIBUTING|SECURITY|NOTICE|LICENSE|LICENCE)(\.[a-z]+)?$/i.test(file);
}

/** Whether one changed path is a lockfile (or a vendored checksum file). */
function isLockfile(file: string): boolean {
  const base = file.split("/").pop() ?? "";
  return LOCKFILES.has(base);
}

/** #1469 operator update: skip docs-only and lockfile-only diffs — they
 *  cannot contain a defect a reviewer would catch that the gate legs miss.
 *  An empty file list (an unreadable diff) is NOT skipped: fail-closed. */
export function docsOrLockfileOnly(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return false;
  return changedFiles.every((f) => isDocsPath(f) || isLockfile(f));
}

/** A reviewer's reported envelope status maps to a review verdict. Only a
 *  blocked/failed report fails; everything else a reviewer might report
 *  (ok, partial) reads as success — a review is advisory by default. */
export function reportFailed(envelopeStatus: string | undefined): boolean {
  return envelopeStatus === "blocked" || envelopeStatus === "failed";
}

/** Whether any changed file matches a blocking path (a review that fails on
 *  one of these fails the merge gate). Pure, computed once at start. */
export function reviewBlocking(changedFiles: string[], blockingPaths: string[]): boolean {
  return matchesPathRules(changedFiles, blockingPaths);
}

/** The terminal state a review posts: success on a passing report, failure
 *  only when the report failed AND a blocking path changed, neutral otherwise
 *  (an advisory failure on non-blocking paths). */
export function reviewVerdict(args: {
  blocking: boolean;
  envelopeStatus: string | undefined;
}): ReviewState {
  if (!reportFailed(args.envelopeStatus)) return "success";
  return args.blocking ? "failure" : "neutral";
}

/** The dedup decision for one (repo, pr, head): whether to spawn a reviewer
 *  or skip. A status on the head that is not pending means the head was
 *  already reviewed — re-review only on a new head sha. */
export function reviewStartDecision(existingState: string | undefined): "run" | "skip" {
  return existingState === undefined ? "run" : "skip";
}

/** What a /studio/review/start resolves to, from its inputs alone. The route
 *  maps each action to a response; `disabled` and `skip` post nothing but a
 *  neutral/skip status when the repo is opted in but the diff needs no review. */
export type ReviewStartDecision =
  | { action: "disabled" }
  | { action: "skip"; reason: "docs-or-lockfile" }
  | { action: "already-reviewed" }
  | { action: "run"; config: ReviewConfig };

/** The full start decision: a repo with no enabled review is a no-op; a
 *  docs/lockfile-only diff posts neutral; a head already carrying a
 *  non-pending gate/review is skipped; otherwise run a reviewer. */
export function decideReviewStart(input: {
  review: ReviewConfig | null | undefined;
  changedFiles: string[];
  existingState: string | undefined;
}): ReviewStartDecision {
  if (input.review === null || input.review === undefined || input.review.enabled !== true) {
    return { action: "disabled" };
  }
  if (docsOrLockfileOnly(input.changedFiles)) return { action: "skip", reason: "docs-or-lockfile" };
  if (reviewStartDecision(input.existingState) === "skip") return { action: "already-reviewed" };
  return { action: "run", config: input.review };
}

/** The one-line status description for a skip, named so the operator sees why
 *  a PR carries a neutral review without a reviewer. */
export function reviewSkipDescription(reason: "docs-or-lockfile"): string {
  return "skipped: docs/lockfile-only diff";
}

/** The pending description posted before a reviewer starts, and the neutral
 *  description a review that neither passed nor blocked a path carries. */
export const REVIEW_PENDING_DESCRIPTION = "review in progress";

/** The block that starts a review: the read-only reviewer role and the
 *  leadType the repo's `review.lead` maps to. */
export const REVIEWER_ROLE = "reviewer";
export type ReviewerLeadType = "claude" | "glm";

/** A repo's `review.lead` maps onto the leadType the spawn route accepts.
 *  Only claude rides a Claude slot; the OSS pool keys all share the glm-led
 *  route (spawn.ts's readLeadTypeRequest). */
export function reviewLeadType(lead: ReviewConfig["lead"]): ReviewerLeadType {
  return lead === "claude" ? "claude" : "glm";
}

/** The status-post port this feature needs, narrowed to the one context. The
 *  `post` state is already GitHub-mapped (neutral folded to success), so it
 *  matches postCommitStatus's own vocabulary. */
export interface ReviewStatusPort {
  mintToken: (repo: string) => Promise<string>;
  post: (token: string, repo: string, sha: string, state: "pending" | "success" | "failure", description: string) => Promise<void>;
  get: (token: string, repo: string, sha: string) => Promise<{ state: string; description?: string } | undefined>;
}

/** GitHub's commit-status endpoint accepts only error/failure/pending/success
 *  — no `neutral`. A neutral review (advisory findings, or a docs/lockfile
 *  skip) is non-blocking, which is exactly what `success` means to the merge
 *  gate, so neutral maps to success at this boundary. The description keeps
 *  the distinction for the human reading the status. */
function ghState(state: ReviewState | "pending"): "pending" | "success" | "failure" {
  return state === "neutral" ? "success" : state;
}

/** Posts gate/review, then reads it back — the same confirm-it-landed
 *  contract status-post.ts's postGateStatus keeps for gate/verdict. Throws
 *  when the read-back does not match, so a failed post is never silent. */
export async function postReviewStatus(
  port: ReviewStatusPort, repo: string, sha: string,
  args: { state: ReviewState | "pending"; description: string },
): Promise<void> {
  const token = await port.mintToken(repo);
  const state = ghState(args.state);
  let postErr: unknown;
  try {
    await port.post(token, repo, sha, state, args.description);
  } catch (err) {
    postErr = err;
  }
  const landed = await port.get(token, repo, sha).catch(() => undefined);
  if (landed?.state === state && landed.description === args.description) return;
  const cause = postErr instanceof Error
    ? postErr.message
    : postErr !== undefined ? String(postErr) : `read-back did not match (got ${JSON.stringify(landed)})`;
  throw new Error(`gate/review POST failed: ${cause}`);
}