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
 */
export type RepoReach = { reachable: true } | { reachable: false; remedy: string };
