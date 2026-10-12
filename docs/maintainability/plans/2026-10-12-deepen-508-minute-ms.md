# deepen-508 plan — one `MINUTE_MS`, one declaration, one inline re-derivation gone

Task: https://github.com/rafarc21/fleetflare/issues/508 (parent sweep #485, finding S14-F4, GLM-OK).
Doc: `docs/maintainability/2026-10-12-magic-numbers-sweep-14.md` §S14-F4 (doc PR pending on main at time of writing).

## Problem

"What is a minute in ms" is declared three times:
`src/ratelimit.ts:19` owns `const MINUTE_MS = 60_000` (module-private, the bucket
size for every rate-limit kind); `src/exceptions.ts:159` declares its own
`RATE_WINDOW_MS = 60_000` (insert-throttle window, deliberately module-private
per its own doc); `src/studio/rate-limit.ts:144` re-derives the minute inline —
raw `60_000` twice in offset arithmetic. Values agree; no operational risk.
Cost is readability, and later sweeps keep re-meeting `60_000`.

## Change

Two files, no behavior change:

1. `src/ratelimit.ts:19` — add `export` to the existing `const MINUTE_MS = 60_000;`.
   No other edit. The line's module comment (issue #284 core) already names it
   the shared core; the symbol just becomes importable.
2. `src/studio/rate-limit.ts` — import `MINUTE_MS` from `../ratelimit`; line 144
   becomes `const offset = nowWall - Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;`

Left alone, deliberately (per issue): `src/exceptions.ts`'s `RATE_WINDOW_MS` —
its doc claims module-locality (per-isolate cap, hot path, no imports wanted
there); forcing a shared import would trade one constant for a module
dependency. Doc-only finding there.

## CLI-import safety (pre-verified on c9fc70c)

`src/studio/rate-limit.ts`'s header says "Pure: no Env, no imports" and that
the CLI imports it (`cli/readiness-format.ts:12` imports formatRateLimited).
The new import is `src/ratelimit.ts`, whose only import is `src/state.ts` —
which imports NOTHING (verified: zero import lines, 132 lines, only ambient
D1 types). So the CLI's chain stays import-clean: rate-limit → ratelimit →
state → nothing. The bun CLI compiles what it imports per-file; ambient
D1Database types come from @cloudflare/workers-types. Also verified: no
existing test imports MINUTE_MS (zero grep hits in apps/fleet/test), and
studio/rate-limit.ts has no current imports at all — this is its first.

## Steps

1. This plan doc (this commit).
2. The two-file refactor — one commit.
3. Verify: `cd apps/fleet && bun run check` exit 0 (heavy gate — run ALONE);
   targeted vitest: `bun run test studio.rate-limited.test.ts junior.ratelimit.test.ts llm.ratelimit.test.ts` — vitest takes filename filters.
4. Fresh-context review, one round max (operator tail).
5. PR, envelope on the issue.

## Verification

- `cd apps/fleet && bun run check` exit 0 — heavy gate, run alone, nothing else heavy parallel.
- `cd apps/fleet && bun run test studio.rate-limited.test.ts junior.ratelimit.test.ts llm.ratelimit.test.ts` — the three suites touching both edited files. Full suite stays with CI/merge gate.
- No behavior change: `60_000` → `MINUTE_MS` is a value-identical substitution at one line; exceptions.ts untouched.
