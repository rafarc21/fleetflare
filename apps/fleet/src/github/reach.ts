// P6a: the reachability ANSWER, alone in its own module.
//
// It lives apart from src/github/auth.ts (which produces it) for one concrete
// reason, and moving it back would break the build in a way tests would not
// catch: src/studio/repo.ts and src/board/board.ts are pure, import no binding
// and touch no `Env` — and cli/fleet.ts imports repo.ts for its git-remote
// parsing. auth.ts imports `Env`, and `Env` reaches every Durable Object class
// in the Worker; a type-only import is erased at runtime but tsc still follows
// it, so pointing repo.ts at auth.ts pulled the whole Worker type graph into
// the `cli` tsconfig project (which carries bun types, not
// @cloudflare/workers-types) and failed `bun run check` with ~80 errors about
// D1Database and DurableObjectNamespace. This file imports nothing, so it can
// be shared by all of them.

/**
 * May this fleet touch that repo? — and, when the answer is no, the REMEDY,
 * phrased for whichever provider actually answered.
 *
 * A refusal that names the wrong fix is worse than a vague one: it would send
 * an operator to install a GitHub App on an account whose repos an org
 * installation could never cover. So the wording travels WITH the answer, and
 * the callers (src/studio/repo.ts, src/board/board.ts) hold no provider
 * knowledge of their own.
 *
 * `remedy` is a sentence FRAGMENT, appended by the caller after
 * `repo "<slug>" `.
 *
 * A transient failure is neither case: it THROWS (see auth.ts's reachRepo), so
 * both callers can answer 503 "ask again" instead of 403 "no". Collapsing the
 * two would make a GitHub outage read to an operator as a permission problem
 * they would then go and "fix".
 *
 * A RATE LIMIT (#1276) is a third answer, distinct from both: it RETURNS
 * `{ rateLimited: true, resetInMs }` so the callers can answer 429 with the
 * reset time — the operator sees "retry in Ns", not an outage 503 and not a
 * permission 403. It is not a throw because a rate limit is a predictable,
 * named upstream condition (unlike a transient outage, which the throw path
 * already treats as "ask again" without a reset hint).
 */
export type RepoReach =
  | { reachable: true; rateLimited?: false }
  | { reachable: false; remedy: string; rateLimited?: false }
  | { reachable: false; remedy?: string; rateLimited: true; resetInMs: number | null };

/** The 429 message a resolve caller returns for a rate limit: names the retry,
 *  with GitHub's reset time in seconds when it was given. */
export function rateLimitMessage(resetInMs: number | null): string {
  const retry = resetInMs === null ? "" : ` (reset in ~${Math.ceil(resetInMs / 1000)}s)`;
  return `GitHub rate limit reached — retry later${retry}`;
}

/**
 * The fetch-side alias of the answer above: what src/github/auth.ts's
 * reachRepo is, and what every caller that injects reachability names as a
 * parameter. Swept here (S29-F4, refs #647) from two identical local
 * declarations in src/board/routes.ts and src/studio/routes.ts; this module
 * imports nothing, so every tsconfig project can type-check against it.
 */
export type RepoReachFetch = (slug: string) => Promise<RepoReach>;
