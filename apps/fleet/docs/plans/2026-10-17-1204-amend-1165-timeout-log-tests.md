# Plan — #1204: amend PR #1165 round 3 — timeout + log-capture tests

Task: https://github.com/rafarc21/fleetflare/issues/1204
PR: https://github.com/rafarc21/fleetflare/pull/1165 (amend, no new PR)

## Problem

Maestro round 3: install works. Tests missing for two behaviors the
round-2 code added: STUDIO_TOOLS_TIMEOUT bounds a hung apt; apt stderr
lands in bringup.log, not the marker.

## Change

All in apps/fleet/test/bun/bringup-studio-tools.test.ts, plus fake bins.

1. Add `sleepBin`: fake `sleep` that records its argv and exits 0; drop
   `sleep` from sysBin so the region's `timeout` runs the fake.
2. Fake `apt-get` gains a `sleep` mode: when APT_SLEEP=1, exec `sleep 30`
   then exit 100. Region install with STUDIO_TOOLS_TIMEOUT=1 → run returns
   under 5 s wall, exit 0, marker written.
3. apt failure prints a unique stderr string. Assert it appears in
   bringup.log (via the region's tail append) and NOT in the marker.
4. Mutation check (one-off, hand-edit a region copy): drop the `timeout`
   wrappers, or send apt stderr to /dev/null — each turns a test red.
   Revert after. Shipped tests stay green and hermetic.
5. Drop the chmod source-grep test: behavior covered by item 3.

## Verification (one heavy gate at a time, sequential)

- cd apps/fleet && bun test test/bun/bringup-studio-tools.test.ts
- cd apps/fleet && bun x vitest run test/studio.tools.test.ts
- bun run check
- bun run english-check
- bun run test-lies-check

Report: .context/REPORT.md + PR #1165 body. Set #1204 awaiting_merge.

Boundaries: bringup-studio-tools test only.