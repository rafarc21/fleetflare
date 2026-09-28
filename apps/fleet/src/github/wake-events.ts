/**
 * The webhook half of the maestro waker: which GitHub deliveries deserve a
 * turn, and the one-line delta each one carries.
 *
 * Studios emit no events of their own — a studio has no outbound channel.
 * Its only outward signals are GitHub writes (envelope comment, task state,
 * PR) and its own container state. So board activity reaches maestro as a
 * true push through `/gh`, and nothing else does; container death is the
 * sweep's job, not this file's.
 */

// The one fold, imported rather than re-typed. repo.ts is pure — it imports
// no Env and touches no binding (see its own header) — so this file stays
// as testable as it was.
import { buildStudioId } from "../studio/ids";
import { repoIdSegment } from "../studio/repo";

/** The four the App actually delivers. `push` is deliberately absent: it
 *  already owns a path in webhook.ts (the UNAPPROVED WRITE alarm) and a merge
 *  to staging/main is not a delta maestro supervises.
 *
 *  `check_suite` is deliberately absent too, against the design spec's
 *  wording: a `wrangler tail` on the deployed Worker through a full push-plus-task
 *  cycle (2026-09-11) saw push, workflow_run x2, workflow_job x2, issues x2
 *  and issue_comment — and not one check_suite. The App does not send it, so
 *  watching it bought nothing while CI's real conclusion was filtered out.
 *
 *  `workflow_job` is absent for the opposite reason: it DOES arrive, once per
 *  JOB, carrying nothing workflow_run's single per-RUN delivery does not
 *  already say. Strictly more wakes, identical signal. */
export const WAKE_EVENTS: ReadonlySet<string> = new Set([
  "issue_comment", "issues", "pull_request", "workflow_run",
]);

/**
 * The pinned board issue maestro comments every wave on.
 *
 * Load-bearing: without this exclusion, maestro's own wave comment is an
 * `issue_comment` delivery that wakes maestro, which comments another wave,
 * forever — a self-sustaining loop whose cost is Claude tokens, the one cost
 * this whole design exists to minimise. Every fleet actor authenticates as
 * the same installation, so the sender's login cannot distinguish maestro
 * from a studio; the ISSUE is what identifies the loop.
 */
export const WAVE_LOG_TITLE = "fleet: maestro wave log";

/** Longest comment excerpt carried into a wake. A digest is a pointer, not a
 *  copy — maestro reads the issue itself once it has a turn.
 *
 *  Exported: src/board/assign-wake.ts's assignDigest reuses this exact cap
 *  for its own excerpt (the --why text on board issue #158), rather than
 *  re-picking a number. */
export const COMMENT_EXCERPT = 160;

/** One line, always: a literal newline typed into the claude TUI submits the
 *  turn, so a two-line digest would arrive as two half-prompts.
 *
 *  Exported for the same reason COMMENT_EXCERPT is: src/board/assign-wake.ts
 *  flattens a task title and a --why excerpt the SAME way, and re-typing this
 *  regex a second place is exactly how the two would drift apart. */
export function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Issue #268's own canonical-nameWithOwner match (github/api.ts's
 * `sameRepoIssues`/`getIssueCloser`: build the known-names list — the
 * caller's own slug plus GitHub's canonical answer for it — and match any
 * case), generalized here for a bare repo-slug comparison rather than an
 * issue's closing reference. `board/assign-wake.ts` and
 * `board/comment-wake.ts` both need exactly this for their own studio-repo
 * checks (issue #284 round 2: a naive lowercase-only compare false-refuses
 * after a rename/transfer), and this file is already the shared, Env-free
 * home both import `oneLine`/`COMMENT_EXCERPT` from.
 *
 * Issue #295 bug 1: round 2 asked `resolveCanonical` about `a` only, on the
 * theory that `a` — a studio's own recorded `repoSlug`, written once at
 * spawn/provision time and never refreshed — is the only side that goes
 * stale, while `b` (the task's/comment's own repo, read fresh off the
 * current request) is not. That is only half true: `b` can ALSO be stale —
 * a leftover git remote, or a hand-typed `--repo` flag — while the STUDIO's
 * own record already carries the current name. Both sides are resolved to
 * canonical here (any of raw-vs-raw, canonical(a)-vs-raw-b, raw-a-vs-
 * canonical(b), or canonical(a)-vs-canonical(b) matching counts as "same"),
 * so a rename/transfer matches regardless of which side is stale.
 *
 * Issue #295 bug 2: a `resolveCanonical` throw (token/network failure) used
 * to fall back to the naive compare it replaces, i.e. collapse straight into
 * "different" — indistinguishable from a genuine mismatch. That single
 * boolean was consumed by callers that need to react differently: a
 * write-gate should fail OPEN on a lookup failure (never block a label write
 * on a transient hiccup), while a wake-gate must keep failing CLOSED (a wake
 * into the wrong studio is the expensive mistake). A boolean cannot carry
 * that distinction, so this returns a THIRD state, `"unknown"`, whenever a
 * lookup failure leaves no confirmed match — never silently folded into
 * `"different"`. See `board/assign-wake.ts`'s `checkAssignRepo` (fails open
 * on `"unknown"`) vs `repoMismatchReason`/`board/comment-wake.ts`'s inline
 * check (both fail closed on `"unknown"`, same as `"different"`).
 */
export type RepoMatch = "same" | "different" | "unknown";

export async function sameRepoSlug(
  a: string, b: string, resolveCanonical: (slug: string) => Promise<string>,
): Promise<RepoMatch> {
  if (a.toLowerCase() === b.toLowerCase()) return "same";

  let canonicalA: string | null = null;
  let canonicalB: string | null = null;
  let lookupFailed = false;

  try {
    canonicalA = await resolveCanonical(a);
  } catch {
    lookupFailed = true;
  }
  if (canonicalA !== null && canonicalA.toLowerCase() === b.toLowerCase()) return "same";

  try {
    canonicalB = await resolveCanonical(b);
  } catch {
    lookupFailed = true;
  }
  if (canonicalB !== null && canonicalB.toLowerCase() === a.toLowerCase()) return "same";
  if (canonicalA !== null && canonicalB !== null && canonicalA.toLowerCase() === canonicalB.toLowerCase()) {
    return "same";
  }

  return lookupFailed ? "unknown" : "different";
}

/**
 * Which studio hears about this repo's events. A maestro supervises its own
 * repo's fleet, so the id is derived from the delivery, never hard-coded to
 * `websites--maestro` — `rafarc21/sample` has its own.
 *
 * The short name goes through `repoIdSegment` (studio/repo.ts), the ONE fold
 * in the system, rather than being concatenated raw. Board #40: the raw
 * version sent every delivery for `demositeltda/demosite.life` to
 * `demosite.life--maestro`, while `fleet spawn` — which has folded since #22 —
 * had created `demosite-life--maestro`. `env.STUDIO.idFromName()` on a name
 * nothing else uses mints a FRESH, EMPTY Durable Object, so the wake was
 * delivered to a phantom supervising nothing and the live maestro never woke.
 * Nothing errored: the call succeeded, and webhook.ts's `wakeMaestro` only
 * logs when the call itself fails. Silence is the whole failure mode, which
 * is why the fold has to be shared and not re-typed here.
 *
 * Null when no fold makes a valid segment — `studioIdIn`'s posture, for
 * `studioIdIn`'s reason: a guessed id is a perfectly valid id belonging to
 * some other repo's studio, so guessing turns "no wake" into "wrong studio
 * woken". `wakeMaestro` already treats null as DO NOT WAKE, and the
 * 20-minute sweep still re-detects the delta.
 */
export function maestroIdFor(repoFullName: string | undefined | null): string | null {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;
  const segment = repoIdSegment(repo);
  if (segment === null) return null;
  // Issue #269: maestro is a SINGLETON role — a repo has exactly one, and
  // nothing spawns a second — so this is always the bare two-segment id, which
  // is also exactly what parseStudioId reads back as instance 1. Built through
  // the one builder rather than interpolated, so the id grammar has one source
  // even where the instance is a constant.
  return buildStudioId({ repo: segment, role: "maestro" });
}

interface Issueish { number?: unknown; title?: unknown; state?: unknown; labels?: unknown }

function issueOf(p: Record<string, unknown>): { number: number; title: string; state: string; labels: string } | null {
  const i = p["issue"] as Issueish | undefined;
  if (!i || typeof i.number !== "number" || typeof i.title !== "string") return null;
  const labels = Array.isArray(i.labels)
    ? i.labels.map((l) => (l as { name?: unknown })?.name).filter((n): n is string => typeof n === "string")
    : [];
  return {
    number: i.number, title: i.title,
    state: typeof i.state === "string" ? i.state : "?",
    labels: labels.join(","),
  };
}

/**
 * The wake prompt's payload: what fired, which task or PR, and its new state.
 *
 * `null` means DO NOT WAKE — an unwatched event, maestro's own wave log, or
 * a payload too incomplete to say anything true. A half-empty digest is worse
 * than no wake: it spends a turn to tell maestro nothing, and the sweep will
 * catch the same delta within 20 minutes anyway.
 */
export function deltaDigest(event: string, payload: unknown): string | null {
  if (!WAKE_EVENTS.has(event)) return null;
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const repo = (p["repository"] as { full_name?: unknown } | undefined)?.full_name;
  if (typeof repo !== "string") return null;
  const action = typeof p["action"] === "string" ? p["action"] : "?";
  const head = `WAKE EVENT(${event}.${action}) ${repo}`;

  if (event === "issues" || event === "issue_comment") {
    const issue = issueOf(p);
    if (!issue) return null;
    if (issue.title === WAVE_LOG_TITLE) return null;
    if (event === "issues") {
      const labels = issue.labels ? ` labels=${issue.labels}` : "";
      return oneLine(`${head} #${issue.number} "${issue.title}" state=${issue.state}${labels}`);
    }
    const c = p["comment"] as { user?: { login?: unknown }; body?: unknown } | undefined;
    const who = typeof c?.user?.login === "string" ? c.user.login : "?";
    const bodyText = typeof c?.body === "string" ? oneLine(c.body).slice(0, COMMENT_EXCERPT) : "";
    return oneLine(`${head} #${issue.number} "${issue.title}" by ${who}: ${bodyText}`);
  }

  if (event === "pull_request") {
    const pr = p["pull_request"] as
      { number?: unknown; title?: unknown; state?: unknown; merged?: unknown; draft?: unknown } | undefined;
    if (!pr || typeof pr.number !== "number" || typeof pr.title !== "string") return null;
    return oneLine(
      `${head} PR #${pr.number} "${pr.title}" state=${typeof pr.state === "string" ? pr.state : "?"} ` +
      `merged=${pr.merged === true} draft=${pr.draft === true}`,
    );
  }

  /**
   * CI. Load-bearing filter: `workflow_run` fires three times per run —
   * `requested`, `in_progress`, then `completed`. Only the last one carries a
   * conclusion, and a conclusion is the only part of a CI run maestro
   * supervises. Waking on all three triples the Claude-token cost of every
   * push for zero added signal, and that cost is the whole reason this file
   * decides anything instead of waking on everything.
   */
  if (action !== "completed") return null;
  const wr = p["workflow_run"] as
    { name?: unknown; conclusion?: unknown; head_branch?: unknown; html_url?: unknown } | undefined;
  if (!wr) return null;
  return oneLine(
    `${head} "${typeof wr.name === "string" ? wr.name : "?"}" ` +
    `branch=${typeof wr.head_branch === "string" ? wr.head_branch : "?"} ` +
    `conclusion=${typeof wr.conclusion === "string" ? wr.conclusion : "?"} ` +
    `${typeof wr.html_url === "string" ? wr.html_url : "?"}`,
  );
}
