# Plan — #468 S9-F1 delete dead `REAP_DEFAULT_IDLE_MS` in cli/reap.ts

Refs https://github.com/rafarc21/fleetflare/issues/468 (parent sweep #428, finding F1; doc docs/maintainability/2026-10-12-dead-code-sweep-9.md §F1). Tier GLM-OK. Bounded: 2 deleted lines, one PR, two-way door (pure dead-code deletion; revert restores the export).

## Problem

`cli/reap.ts` exports `REAP_DEFAULT_IDLE_MS = 30 * 60_000` with a comment claiming it is "`fleet reap`'s default threshold". It is dead: repo-wide grep over src, cli, test, test-integration, scripts, container, docs returns exactly one hit — the definition itself. Zero importers. The default `fleet reap` actually uses is the inline `let idleMs = 30 * 60_000` at src/studio/cli-args.ts:999. A future `--idle` default change edits the inline literal and silently leaves this "default" const lying about the threshold.

## Change

Delete apps/fleet/cli/reap.ts lines 62-63 (the doc comment + the export const). Nothing references the symbol, so no import breaks and no behavior change; the inline default in src/studio/cli-args.ts:999 is untouched.

## Steps

1. Delete the two lines (comment + const) in cli/reap.ts. No test change: no test names the const, and the reap default path is asserted via the inline literal (test/cli.reap-terminal.test.ts, test/bun/fleet-reap.test.ts, test/bun/fleet-reap-wiring.test.ts).
2. Verify, one heavy gate at a time, each ALONE:
   - `grep -rEn "(^|[^A-Za-z0-9_.])REAP_DEFAULT_IDLE_MS([^A-Za-z0-9_]|$)"` over apps/fleet (src, cli, test, test-integration, scripts, page, container) → zero hits.
   - `cd apps/fleet && bun run check` → exit 0 (tsc --noEmit on all five tsconfigs). HEAVY GATE — run alone, nothing else heavy in parallel.
   - `cd apps/fleet && bun test test/cli.reap-terminal.test.ts test/bun/fleet-reap.test.ts test/bun/fleet-reap-wiring.test.ts` → all pass.
3. Commit, push.
