# Plan — sweep 24 F1: ratelimit.ts core exports with zero importers (#601)

Refs #588 (sweep doc docs/maintainability/2026-10-12-unused-exports-sweep-24.md,
S24-F1). Bounded: export-keyword drop only, no behavior change.

## Finding

src/ratelimit.ts exports its own public core — checkAndConsumeRateLimit,
RateLimitResult, RateLimitKindSpec, RateLimitKind — and no file imports any
of them (grep: in-file use only; RateLimitKind appears elsewhere solely in
a comment, llm/ratelimit.ts:60). The module's consumed surface is
makeRateLimitKind + parsePositiveInt (junior/ratelimit.ts:20, llm/ratelimit.ts:16).

## Steps

1. Drop `export` on the 4 symbols (src/ratelimit.ts:34 RateLimitResult,
   :43 RateLimitKind, :116 checkAndConsumeRateLimit, :150 RateLimitKindSpec).
   All four stay in-file; checkAndConsumeRateLimit is the engine
   makeRateLimitKind delegates to at :178. This is the compile pin: if any
   hidden importer existed, tsc fails.
2. Commit + push branch sweep-601-ratelimit-core-exports.
3. Verify: tsc, touched vitest files, english-check (one gate at a time).

## Verification

- cd apps/fleet && tsc --noEmit  (exit 0 — pins zero importers)
- cd apps/fleet && flock /tmp/fleet-gate.lock bun run test test/junior.ratelimit.test.ts test/llm.ratelimit.test.ts  (exit 0)
- cd apps/fleet && bun run english-check  (exit 0)

## Boundaries

- No test changes, no behavior changes, no new deps. One heavy gate at a
  time (vitest under flock). Review cap 2 rounds. No browser QA — no visual
  surface, compile-level change.
