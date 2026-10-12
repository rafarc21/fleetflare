# Plan — S18-F3: writeCredentials ×5 → bun/helpers/credentials.ts (refs #593)

Sweep 18 finding F3 (refs #537): `writeCredentials(home, workerUrl)` is
byte-identical in five bun-lane suites — junior-stats-cli:14,
task-state-cli:29, cli.task-verify:43, cli.task-reap:33, accounts-cli:31.
Each mkdirs ~/.fleet, writes {workerUrl, accessClientId:"id",
accessClientSecret:"secret"} (fixture secrets only), chmods 0600.

## Changes

1. New `apps/fleet/test/bun/helpers/credentials.ts`: exports
   `writeCredentials(home, workerUrl)`, body verbatim from the 5 copies.
   Sits next to helpers/shell.ts (the sweep-18 fold precedent).
2. Five suites import it from `./helpers/credentials` and delete their
   local copies. Per-file `node:fs` import trims (only symbols used solely
   by the deleted copy go): junior-stats drops chmodSync; task-state,
   task-verify, task-reap drop chmodSync+mkdirSync+writeFileSync;
   accounts drops mkdirSync.

## Scope guard

Divergent siblings stay local (different key spellings / mode options,
per the #537 census): attach-liveness:34, cli-destroy-unmerged:213,
deploy-rescue-gate:207, ff-new-main:41, ff-no-tty:61.

## Verification

- Baseline (recorded pre-change): `bun test` on the 5 files → 35 pass.
- Post-change: same command → 35 pass, 0 fail.
- `cd apps/fleet && bun run check` (5× tsc — heavy gate, run alone).
- `bun run test-lies-check` + `bun run english-check` (new comments).
