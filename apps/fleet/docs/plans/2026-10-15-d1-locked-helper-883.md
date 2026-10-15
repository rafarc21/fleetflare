# Plan — #883: S43-F6 shared d1-locked helper for the two junior_usage_log fakes

Task: https://github.com/rafarc21/fleetflare/issues/883

## Problem

apps/fleet/test/junior.route.test.ts:184 and
apps/fleet/test/llm.anthropic-route.test.ts:279 carry a byte-identical
12-line fake D1: prepare(sql) throws
"D1_ERROR: the database is locked by another connection" from the
junior_usage_log INSERT's run(), delegates every other statement to the
real DB. Both prove usage-recording fails soft when D1 is locked (#519).

## Change (test-only, no source change)

New apps/fleet/test/helpers/d1-locked.ts exporting
lockedUsageLogDb(realDb: D1Database): D1Database — the 12-line fake,
helper-style comment pointing at #519/#883. Both call sites keep their
own env cast, per the census doc. The gated-insert fake at
llm.anthropic-route.test.ts:705 stays — it is a different fake
(promises, not a throw).

## Verification (one heavy gate at a time, sequential)

- cd apps/fleet && bun x vitest run test/junior.route.test.ts
  test/llm.anthropic-route.test.ts (both green)
- bun run check (alone, nothing else running)
- bun run english-check
- bun run test-lies-check
