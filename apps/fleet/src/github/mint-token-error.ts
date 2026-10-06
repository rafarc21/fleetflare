/**
 * PR #339 round 2 (issue #331) — a typed status code, not a string a caller
 * would have to parse back out of the message. `mintRepoToken` (auth.ts)
 * needs to distinguish "this repo name is stale (422, a renamed/transferred
 * repo not among `repositories[]`)" from every other failure (bad
 * credentials, rate limit, a genuinely unreachable repo) to know when its
 * own canonical-name retry applies — text-matching a message this file owns
 * would be exactly the brittle coupling this codebase has already measured
 * failing elsewhere (issue #310's glob/octal alias bypass).
 *
 * Deliberately kept in its own file, dependency-free (no `Env`, no
 * Cloudflare Workers ambient types): `app.ts` (where `mintInstallationToken`
 * lives) imports `Env`, which pulls in this Worker's entire backend typing
 * graph. `rescue.ts` is documented as pure (no Worker bindings) and is
 * imported directly by `cli/fleet.ts`, whose `cli/tsconfig.json` type-checks
 * under `"types": ["bun"]` with no Workers ambient types at all — importing
 * `MintTokenError` from `app.ts` would drag that whole graph into the CLI's
 * type-check and break it (issue #233 follow-up fix).
 */
export class MintTokenError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "MintTokenError";
  }
}
