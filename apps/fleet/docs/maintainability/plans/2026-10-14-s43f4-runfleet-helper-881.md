# S43-F4: run(args,home) Bun.spawn runner -> bun/helpers/fleet-cli.ts runFleet (refs #850, refs #881)

## What

Two bun-lane suites carry a byte-identical `async run(args, home)`: a real
`Bun.spawn` of the real cli/fleet.ts with a temp HOME, streaming stdout/stderr
and the exit code in parallel. Move it into the sweep-33 helper as
`runFleet(args, home) -> {out, err, code}` — the helper already owns the FLEET
path (one `..` deeper than the suites), so the runner belongs beside it.

## Sites (verbatim in each)

- cli-check-clear-guard.test.ts: `FLEET_CLI` at 35, `run()` at 83-93, 8 calls.
- cli-destroy-unmerged.test.ts: `FLEET_CLI` at 200 (describe-scoped), `run()`
  at 244-254, 6 calls. No harness state inside `run()` beyond `FLEET_CLI` —
  delete both, no wrapper kept.

## Steps (TDD)

1. Extend helpers/fleet-cli.ts with `runFleet` (WHY comment above it).
2. RED: migrate cli-check-clear-guard.test.ts — import `runFleet`, delete
   local `FLEET_CLI` + `run()`, rename the 8 calls. Its own tempDirs stack and
   `tmpHomeWithCredentials` stay local (it does not use the helper's trio).
   `bun test test/bun/cli-check-clear-guard.test.ts` proves the helper's
   deeper FLEET path resolves — a wrong `..` count fails every spawn.
3. GREEN: migrate cli-destroy-unmerged.test.ts the same way (6 calls).
4. Both files together (expect 30 pass); english-check; test-lies-check;
   `npx tsc --noEmit -p test`.

## Boundaries

- Test files + helper only. No cli/fleet.ts, no src/, no new dependencies.
- No full bun-test lane or vitest (memory ceiling) — the touched-file runs
  above are the whole gate. One command at a time.

Estimated ~24 lines removed.
