# 1194 — amend PR #1181 round 2: hermetic tests, body labels, reviewer read-only

Maestro round-2 review of #1181. Three fixes, one branch.

## Changes
1. bringup-mcp-config.test.ts bringUp(): default `CBM_MCP_BIN` to a nonexistent
   path under the fake home, BEFORE `...env`. Absent tests (:77, :87, :144)
   then skip without depending on the host lacking the binary. :144 drops its
   explicit CBM_MCP_BIN.
2. code-reviewer.md: forbid `index_repository` with `persistence: true` —
   reviewer stays read-only. Pin it in code-reviewer-blueprint-content.test.ts.
3. PR #1181 body: relabel RSS figures linux-arm64, restore the Dockerfile pin
   summary (v0.11.0 asset + sha256), keep the image-repro-check-owed note.

## Verify
- bun test test/bun/bringup-mcp-config.test.ts test/bun/code-reviewer-blueprint-content.test.ts
- bun run english-check
- leak-scan PR text (neutral names only)

## Out of scope
Worker src; re-measuring RSS on amd64 (body relabels to arm64 instead).