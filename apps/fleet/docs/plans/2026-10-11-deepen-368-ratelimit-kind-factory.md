# Rate-limit kind factory — board #368

> **For agentic workers:** implement via superpowers:subagent-driven-development, task-by-task, checkbox steps.

**Goal:** Fold the three `checkAndConsume*RateLimit` wrappers' repeated parse-env-then-consume body into one `makeRateLimitKind` factory in `src/ratelimit.ts`, and replace count_tokens' `Number.MAX_SAFE_INTEGER` inert-daily sentinel with an explicit no-daily arm.

**Architecture:** Behavior-preserving. Core gains `makeRateLimitKind(spec)` returning a `(db, env, studioId, now)` closure; `checkAndConsumeRateLimit`'s `dailyCap` widens to `number | null` (null = per-minute-only kind: no daily increment, no daily row). The three public functions become one-line factory products — names, signatures, callers unchanged. Env interfaces become type aliases (implicit index signatures satisfy the generic `E extends Record<string, string | undefined>` constraint; TS interfaces would not).

**Tech Stack:** TypeScript, vitest + cloudflare:test (real D1 via miniflare).

**Spec:** https://github.com/rafarc21/fleetflare/issues/368 — sweep-4 finding F8 (docs/maintainability/2026-10-11-deep-modules-sweep-4.md, parent #361).

## Constraints

- GLM-OK tier: no auth, tokens, rescue, failover, deploy, migrations, credentials.
- Two-way door, code-only, revertable. Existing tests pass unchanged.
- Only observable delta: count_tokens writes no inert `lead-count-daily:` row (nothing reads it).
- All content English.

## Steps

- [ ] 1. RED: tests first — count_tokens describe in test/llm.ratelimit.test.ts (5 cases: config block, minute reset + zero `lead-count-daily:%` rows — fails today, separate budget, garbage fallback, fractional floor), fractional floor pin per junior (per-minute "2.9"→2) and lead (daily "2.9"→2). Run both files: exactly the zero-rows case fails. Commit + push.
- [ ] 2. GREEN: `RateLimitKindSpec` discriminated union (daily pair both-or-neither) + `makeRateLimitKind` in src/ratelimit.ts; core `dailyCap: number | null`, null skips daily increment; junior + llm wrappers become one-line factory products, env interfaces → type aliases. Both test files green. Commit + push.
- [ ] 3. Gates, sequential: `bun run check`, `bun run english-check`, `bun run test-lies-check`, then full `bun run test` and `bun run bun-test` — all exit 0.

## Files

- Modify: apps/fleet/src/ratelimit.ts
- Modify: apps/fleet/src/junior/ratelimit.ts
- Modify: apps/fleet/src/llm/ratelimit.ts
- Test: apps/fleet/test/llm.ratelimit.test.ts
- Test: apps/fleet/test/junior.ratelimit.test.ts
