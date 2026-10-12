# Plan — #604: un-export the three makeRateLimitKind env type aliases (S24-F5)

Refs https://github.com/rafarc21/fleetflare/issues/604, sweep doc
docs/maintainability/2026-10-12-unused-exports-sweep-24.md (S24-F5), refs #588.

## Finding

LeadRateLimitEnv, LeadCountTokensRateLimitEnv (src/llm/ratelimit.ts) and
JuniorRateLimitEnv (src/junior/ratelimit.ts) appear in exactly two places
each: their declaration and their own module's makeRateLimitKind<X> type
parameter. No file imports any of the three; the modules' consumed exports
are the checkAndConsume* functions. Grep over src, test, cli, container and
test-integration confirms zero hits outside the two defining files.

## Change

Drop the `export` keyword from all three type aliases; the types stay as
module-private generics. One line each:

- src/llm/ratelimit.ts:36 `export type LeadRateLimitEnv` → `type LeadRateLimitEnv`
- src/llm/ratelimit.ts:55 `export type LeadCountTokensRateLimitEnv` → `type LeadCountTokensRateLimitEnv`
- src/junior/ratelimit.ts:28 `export type JuniorRateLimitEnv` → `type JuniorRateLimitEnv`

## Verification (sequential, one heavy gate at a time)

1. `cd apps/fleet && bun test test/junior.ratelimit.test.ts test/llm.ratelimit.test.ts`
2. `cd apps/fleet && npx tsc --noEmit`
3. `cd apps/fleet && npx tsc --noEmit -p test`
4. `cd apps/fleet && bun run scripts/english-check.ts`
5. `cd apps/fleet && bun run scripts/test-lies-check.ts`

Runtime behavior unchanged: type aliases are erased at compile time; the
checkAndConsume* exports the routes consume are untouched.
