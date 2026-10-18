# Plan — issue #1216: heal/restart replays stale STUDIO_MCP; empty list silently deletes fleet-mcp.json

## Problem
Provision persists the resolved bring-up env once (`ROLE_ENV_KEY`) and replays
it verbatim on heal/restart. A studio provisioned before #1181 has
`STUDIO_MCP: ""` frozen into that stored env, so every heal/restart re-runs
`fleet_mcp_config` with an empty list, which `rm -f`'s `~/.claude/fleet-mcp.json`
with **no log**, launching the lead without `codebase-memory` until a recycle.

## Asks
1. Log a stderr line when the MCP config is removed because the name list is empty.
2. Heal/restart re-resolve `STUDIO_MCP`/`ROLE_MCP` from the current blueprint.
3. READY check: blueprint declares `mcp:` but `~/.claude/fleet-mcp.json` missing → degraded.

Refs #1181 #1167. Bounded. Tests first.

## Design
**Ask 1** — `fleet_mcp_config()` (studio-bringup.sh:1369): before `rm -f`,
log to stderr, guarded so only a real removal (file existed) logs:
```sh
if [ -z "$names" ]; then
  if [ -f "$file" ]; then
    echo "studio-bringup: mcp name list empty -- removing $file (claude launches without MCP)" >&2
  fi
  rm -f "$file"; return 0
fi
```

**Ask 2** — `provision.ts`: add `resolveMcpOverride(deps, fleetRepoSlug, env)`
that re-reads `fleet.json` → blueprint → `studios/<name>/studio.md` (or
`roles/<name>.md`), returns `{ STUDIO_MCP }` or `{ ROLE_MCP }`, or `null` on
any fetch/parse failure (fail open — restart must not depend on GitHub, same
reason `ROLE_ENV_KEY` exists). In `runRestart`, after the null guard:
`bringupEnv = mcpOverride ? { ...roleEnv, ...mcpOverride } : roleEnv`, used in
both `bringUpAndVerify` calls. Stored env NOT rewritten (replay-only, no
racing write). Signatures unchanged (pinned by existing tests).

**Ask 3** — `harnessExpectation` appends a `mcp` token when the env's
`STUDIO_MCP`/`ROLE_MCP` is non-empty; `harnessCheckSnippet` gains a branch:
`[ -f "$HOME/.claude/fleet-mcp.json" ] || echo "mcp config missing (...)"`.
Existing check surfaces `bare` (→ degraded); ask 2 lets heal actually re-write it.

## Test plan (RED first, bun lane)
1. `bringup-mcp-config.test.ts`: empty list + existing file → removal line in stderr; empty + no file → no line.
2. New `provision-mcp-restart.test.ts`: `runRestart` with stored `STUDIO_MCP:""` +
   blueprint declaring `mcp:[codebase-memory]` → `BRINGUP_CMD` env carries `STUDIO_MCP=codebase-memory`;
   fetch throws → stored env replayed unchanged.
3. `provisioned-check.test.ts`: env declaring MCP adds `mcp` token; missing
   `fleet-mcp.json` → bare (names missing config); present → `PROVISIONED_OK`.

## Verification
`bun run check` (tsc ×5) exit 0 — one heavy gate, run once via
`flock /tmp/fleet-gate.lock`. Targeted bun tests green. Full vitest → CI.

## Files
- `apps/fleet/container/studio-bringup.sh`
- `apps/fleet/src/studio/provision.ts`
- `apps/fleet/test/bun/bringup-mcp-config.test.ts`
- `apps/fleet/test/bun/provision-mcp-restart.test.ts` (new)
- `apps/fleet/test/bun/provisioned-check.test.ts`