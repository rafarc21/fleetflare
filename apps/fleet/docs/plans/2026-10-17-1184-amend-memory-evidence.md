# 1184 — amend codebase-memory-mcp PR evidence, member tools, mem cap

Amend #1167 implementation per maestro review.

## Changes
1. web-studio member tools: backend-developer, frontend-developer, code-reviewer `tools:` += `mcp__codebase-memory__*`.
2. code-reviewer blueprint test: update pinned tools strings (lines 13, 51). Add parse test: all three member files carry the wildcard.
3. studio-bringup.sh fleet_mcp_config known map: codebase-memory entry carries `env: {"CBM_MEM_BUDGET_MB": "1024"}`.
4. studio-bringup.sh access check: `os.access` on exact `/usr/local/bin/codebase-memory-mcp` path, not `shutil.which(basename)`. Tests inject binary via `CBM_MCP_BIN` env. Fix stale old-image comment.
5. bringup-mcp-config test: assert budget env; use CBM_MCP_BIN for path injection.
6. PR #1181 Evidence: replace RSS row with total-process numbers (daemon + detached worker missed by ru_maxrss).
7. image-repro-check.sh studio: run and paste result. Container has no docker; note if blocked.

## Verify
- bun test test/bun/code-reviewer-blueprint-content.test.ts test/bun/bringup-mcp-config.test.ts test/studio.files.test.ts
- bun run check
- bun run english-check