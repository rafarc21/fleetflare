# Plan — issue #1223: amend PR #1222 (Worker-only, fix test count, bound refetch)

## Problem
PR #1222 (issue #1216) re-resolves MCP from the blueprint on EVERY heal/restart.
The gate went red on `studio.routes-handle.test.ts:1229` (asserts 4 blueprint
fetches, got 6), and the re-resolve is UNBOUNDED: two extra GitHub fetches per
heal/restart burn the fleet-wide installation rate limit. The .sh change also
ships in the same PR, making it non-Worker-only.

## Asks
1. Move the studio-bringup.sh stderr-log change OUT of #1222 into a separate
   [IMAGE] PR. #1222 becomes Worker-only (no apps/fleet/container/ path).
2. Fix the fetch count (4 -> 6) + the 'no refetch' comment in
   studio.routes-handle.test.ts:1229.
3. Bound the cost: re-resolve MCP only when the stored STUDIO_MCP/ROLE_MCP is
   empty (the pre-#1181 stale case); non-empty replays without fetching.
4. Keep the fetch-failure fallback and its test.

Refs #1216. Bounded. Tests first.

## Design
**Ask 1** — rebase-drop commit `cbab546` (the .sh log + its 2 tests) from
`1216-mcp-stale-replay-heal`; cherry-pick onto a new `1216-mcp-empty-removal-log`
branch off origin/main; open as [IMAGE] PR.

**Ask 2** — `studio.routes-handle.test.ts`: `toHaveBeenCalledTimes(4)` -> `6`,
comment updated to "restart re-resolves MCP when stored ROLE_MCP is empty".

**Ask 3** — `runRestart` (provision.ts): compute `storedMcpNames` from the stored
STUDIO_MCP/ROLE_MCP; only call `resolveMcpOverride` when empty. Non-empty skips
both fetches. `resolveMcpOverride` itself unchanged.

**Ask 4** — the existing `a blueprint fetch failure replays the stored env
unchanged` test (replacement-restore.test.ts) stays, still green.

## Test plan (RED first)
1. `replacement-restore.test.ts`: non-empty stored STUDIO_MCP -> fetch never
   called (assert `.not.toHaveBeenCalled()`), bringupEnv === stored.
2. `routes-handle.test.ts`: count 4 -> 6.
3. Existing: empty-stored re-resolve, fetch-failure fallback, BLUEPRINT_REF pin.

## Verification
`bun run check` (tsc x5) exit 0 under `flock /tmp/fleet-gate.lock`. Full vitest
(`bun run test`) green — the red `vitest-6` shard's `studio.routes-handle` count
is fixed. Worker-only diff: no `apps/fleet/container/` path.

## Files
- apps/fleet/src/studio/provision.ts
- apps/fleet/test/studio.replacement-restore.test.ts
- apps/fleet/test/studio.routes-handle.test.ts
- apps/fleet/container/studio-bringup.sh (removed -> own [IMAGE] PR)
- apps/fleet/test/bun/bringup-mcp-config.test.ts (removed -> own [IMAGE] PR)