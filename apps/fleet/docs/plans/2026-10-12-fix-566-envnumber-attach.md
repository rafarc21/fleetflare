# Plan — #566: envNumber() for attach-liveness env numbers, NaN refused at startup

Ref #566 (finding S20-F4 of docs/maintainability/2026-10-12-cli-args-sweep-20.md). Bounded fix, one module + one test file.

## Why
`cli/attach-liveness.ts:10,16` reads `Number(process.env.FLEET_ATTACH_STALE_MS ?? 90_000)` (and the FLEET_ATTACH_CONNECT_TIMEOUT_MS sibling) with no NaN guard. `FLEET_ATTACH_STALE_MS=90s` (unit-suffix typo) yields NaN: watchdog interval `Math.max(250, Math.min(5_000, NaN / 3))` = NaN (~1ms default), staleness test `now - lastFrameAt <= NaN` false for every frame — title flips STALE immediately, socket closes first tick. A typo silently disables both attach watchdogs with no message naming it.

## Change
- `envNumber(name, fallback)` in `cli/attach-liveness.ts`: reads `process.env[name]`; undefined/empty → fallback; `Number.isFinite(n) && n > 0` → n; otherwise `console.error("fleet: FLEET_ATTACH_STALE_MS must be a number of ms, got \"90s\"")` (name + JSON.stringify(raw)) and `process.exit(1)`. Both constants route through it.
- Module stays pure/testable: refusal path prints + exits — pinned by spawning the real CLI with a bad env value.

## Tests (TDD, test/bun/attach-liveness.test.ts)
- RED first: `FLEET_ATTACH_STALE_MS=90s` → child exits 1 fast, stderr matches `FLEET_ATTACH_STALE_MS must be a number of ms, got "90s"`; same for CONNECT_TIMEOUT with `"30x"`; empty string value falls back to default (no refusal, exit not 1).
- Existing T1–T5 keep passing (valid "1500" still works).

## Boundaries
- Verification runs `bun test test/bun/attach-liveness.test.ts` (heavy-ish: 6 subprocess tests, ~30s) and `tsc --noEmit -p cli` + `-p test` — one gate at a time, never in parallel.

## Verification
- `cd apps/fleet && bun test test/bun/attach-liveness.test.ts` green
- `cd apps/fleet && bun run english-check` green
- `cd apps/fleet && bun run check` green (full typecheck)
Full suite belongs to CI.
