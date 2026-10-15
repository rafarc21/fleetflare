# S48-F3 localci-run — LANE_TIMEOUT 2s → 1s; per-test git fixture sharing rejected (refs #971, refs #945, refs #715)

`apps/fleet/test/bun/localci-run.test.ts`, measured 56.8s by sweep 48 (F3), 127s on this container (2026-10-15, real git via preload).

(a) `:348` hung-lane test runs with `LOCALCI_LANE_TIMEOUT=2` — a real 2s watchdog wait proving the lane watchdog fires and the run exits 2. 1s carries the same proof: the watchdog only needs to beat the stub's 61s sleep. Cut to 1s.

(b) Per-test git fixture (`:46-50` bare init + clone + commit + push) — sweep estimated ~0.5-1s × 32 tests and proposed a shared origin.git. Measured 0.15s real (local bare repo, real git) ≈ 2.7s over the whole 34-test file. Sharing changes teardown semantics (sweep/remove_run delete refs/localci/* and worktrees) for ~2.7s on a 127s file. Rejected.

(c) 15s SIGTERM budgets (`:426`, `:459`) — measured 16.4s on "SIGTERM mid-lane": genuinely consumed by sweep_procs walking /proc twice plus cleanup subprocesses, not idle insurance. Leave, per sweep.

## Change
- `apps/fleet/test/bun/localci-run.test.ts:348`: `LOCALCI_LANE_TIMEOUT: "2"` → `"1"`.
- `:352`: `after 2s` → `after 1s` (summarize.ts prints the seconds the watchdog wrote).

## Steps
1. Plan doc commit + push.
2. Edit + run the suite. No writable RED test (constant, not a branch); the 34-test suite is the guard.

## Verify (sequential, one gate at a time)
- `cd apps/fleet && bun test test/bun/localci-run.test.ts`
- `cd apps/fleet && npx tsc --noEmit -p test`
- `cd apps/fleet && bun run english-check`

## Boundaries
- One file, two lines (env value + assertion string) + a WHY comment. No container/, src/, cli/.
- No closing keywords for #945/#715.
- Heavy gates: this one test file only; `tsc -p test` only. No full suite, no vite build.