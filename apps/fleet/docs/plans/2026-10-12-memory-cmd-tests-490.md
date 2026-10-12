# Plan — #490 S11-F2 fleet memory ls/compact cmd-half tests

Refs https://github.com/rafarc21/fleetflare/issues/490 (sweep #467, finding S11-F2). GLM-OK. Bounded: one test file, zero src changes, one PR, two-way door (delete the file to revert).

## Gap
cmdMemoryLs (cli/fleet.ts:2568) and cmdMemoryCompact (cli/fleet.ts:2606) have no behavioral test: header line (:2582), truncated WARNING (:2589, :2644), exit 1 on !res.ok (:2574), stdin-JSON refusal (:2615), PR/branch/summary lines (:2635). Helpers covered by test/cli.memory-format.test.ts, routes by test/memory.routes.test.ts; the cmd halves are the hole.

## Change
New apps/fleet/test/bun/memory-cmd.test.ts, accounts-cli.test.ts pattern: real Bun.spawn of cli/fleet.ts, temp HOME + credentials mode 600, Bun.serve stand-in for GET /studio/memory + POST /studio/memory/compact, temp cwd with no .git (detectRepo fallback). Seven tests: ls happy, ls truncated WARNING, ls 500 exit 1, compact empty-stdin bootstrap `{}`, compact truncated WARNING, compact invalid-stdin exit 1 + zero POSTs, compact valid-JSON passthrough.

## Verify
`cd apps/fleet && bun test test/bun/memory-cmd.test.ts` green; `bun run test-lies-check` 0 findings; `bun run english-check` clean. A failing test = report, never fix by editing src.
