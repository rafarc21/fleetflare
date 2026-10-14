# 802 — S35-F9 studio.blueprint split: parse vs brief (refs #735)

Sweep 35 F9 (docs/maintainability/2026-10-13-mid-size-test-files-sweep-35.md):
apps/fleet/test/studio.blueprint.test.ts (705 lines, 12 describes, 62 tests)
splits on topic. Pure move: parse half (parseRoleFile, optional role fields
may_spawn/instance_type/keep_alive, effort, mcp #276, parseFleetJson,
assertRoleInFleet) becomes test/studio.blueprint-parse.test.ts; env/brief
half (roleBringupEnv + ROLE_EFFORT, real shipped blueprint files, appendBrief
P4a-2, HOUSE_RULES neutral default #330 + operator overlay) becomes
test/studio.blueprint-brief.test.ts. Old file deleted. Shared preamble
duplicated then trimmed per half — dup-not-extract (extraction is sweep-18's
lane, never both at once).

## Plan

1. Baseline: vitest run of the old file, 62 tests green; per-describe it()
   counts recorded.
2. Parse half: trimmed preamble (imports minus unused) + describes verbatim
   (parseRoleFile :47-152, optional fields :154-243, effort :245-285,
   parseFleetJson :287-388, assertRoleInFleet :390-408, mcp :455-479).
3. Brief half: trimmed preamble + describes verbatim (roleBringupEnv :410-427,
   ROLE_EFFORT :429-453, real files :481-607, appendBrief :609-647,
   HOUSE_RULES :649-668, appendHouseRules :670-705).
4. Update sibling comment refs naming the old file where they point at moved
   content (S26-F12 precedent): vitest.config.ts :110/:124, src/studio/
   blueprint.ts :5, test/studio.routes-handle.test.ts :1658,
   test/studio.refresh.test.ts :38, test/studio.provision.test.ts :8,
   test/studio.houserules.prompt.test.ts :29, test/studio.spawn.test.ts :1005,
   test/studio.org.test.ts :116.
5. Preservation proof: per-describe and whole-region diff vs HEAD, exit 0.
6. Verify: targeted vitest on both new files (62 total), tsc -p test,
   english-check. One heavy gate at a time.

## Verification

- bun x vitest run test/studio.blueprint-parse.test.ts test/studio.blueprint-brief.test.ts — 62 passed, matching baseline per-describe counts.
- bun run check (tsc --noEmit -p test included) — exit 0.
- bun run english-check — clean.
