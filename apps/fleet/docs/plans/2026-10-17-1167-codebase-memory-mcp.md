---
# 1167 — codebase-memory-mcp in every studio

[IMAGE] tooling. One MCP server, one static binary, all studios. No Worker src change.

## Facts (measured, not re-derived)
- v0.11.0 linux-amd64-portable.tar.gz sha256 `1f9e8293eb2bc5c05cfa27a7e8fc033da6d729ffad525ccfcdaa3fd606306683` (release checksums.txt). Static ELF x86-64, 299 MB, `--help` clean, `--version` 0.11.0.
- 17 tools: index_repository, search_graph, query_graph, trace_path, get_code_snippet, get_file_outline, get_graph_schema, compare_graphs, get_architecture, search_code, list_projects, delete_project, index_status, check_index_coverage, detect_changes, manage_adr, ingest_traces.
- `cli index_repository --repo-path P --mode full` indexes; cache in ~/.cache/codebase-memory-mcp. index_repository writes NO repo files (list_projects is the only mutating tool).
- Session tar = ~/.claude/projects + ~/.claude.json only (session-sync.ts tarAndStatCmd). ~/.cache/codebase-memory-mcp is OUTSIDE that → never synced. No exclude needed (step 6).
- Server auto-refreshes indexes ("Indexes auto-refresh").

## Changes
1. Dockerfile.studio: curl tar.gz by exact tag URL, hardcoded `sha256sum -c`, extract `codebase-memory-mcp` to /usr/local/bin 0755. repro-seal wrapped. No install.sh, no curl|bash.
2. studio-bringup.sh fleet_mcp_config known map += `codebase-memory` → `{"command": "/usr/local/bin/codebase-memory-mcp"}`. Binary absent (old image) → skip + stderr line, never fail boot.
3. Blueprint mcp: web-studio, release-studio, pilot, scratch each get `mcp: [codebase-memory]`. Members unchanged — their `tools:` lists exclude `mcp__*`, so lead-only, consistent with playwright today.
4. Tests (RED first): known map writes server; absent binary skipped; real studio/role md parse the new list.

## Verify
- RED → GREEN mutation per test.
- `bun test test/bun/bringup-mcp-config.test.ts test/studio.files.test.ts test/studio.blueprint-parse.test.ts test/container.args.test.ts`
- `bun run check` (tsc, heavy — one gate at a time).
- Measure index fleetflare + one 100k+ LOC clone → peak RSS (ru_maxrss), wall time, cache size. >1 GiB RSS → flag first in PR.

## Out of scope
Worker src; index_repository write behavior (reported only).