# Plan — sweep-22 weak-test batch, S22-F1..F6 (board issue #591, refs #576)

Test files only, never src/. Findings + exact proposed lines live in
docs/maintainability/2026-10-12-weak-tests-sweep-22.md — follow it. Each
strengthened test must fail against a named mutant (mutant named in PR body,
never committed).

- F1 test/bun/fleet-reap.test.ts:454,563,569 — replace the three
  `expect(...backoffUntil[PILOT]).toBeDefined()` with the :556 shape:
  `expect(Date.parse(...)).toBe(NOW.getTime() + REAP_BACKOFF_MS)`.
- F2 test/bun/fleet-reap.test.ts:583-588 — seed stallAlarmAt + refusals for
  PILOT alongside backoffUntil; assert all three maps' PILOT keys undefined
  after successful destroy.
- F3 test/studio.session.test.ts:1274 — after `await hashPersisted`, capture
  the hash key the put hook fired on and `expect(await storage.get(<key>)).not.toBeNull()`.
- F4 test/cli.studio-row.test.ts:77-86,119-127 — in each loop also assert the
  return per contract: null for every case except the two valid ones (which
  keep their existing per-case toBe tests; in the loop assert non-null).
- F5 companion positive asserts: spy console.error (vi.spyOn) + assert called
  with the failure it should log — exceptions.test.ts:61 (insert failed),
  :355 (prune failed), studio.activity.test.ts:690 (no delete method — no
  error log expected: instead assert resolves AND no delete attempted is
  observable only as resolve; add console.error spy asserting NOT called),
  :695 (delete rejects — spy asserts one clearActivityState log line).
- F6 test/bun/bringup-hooks.test.ts — append ` (#221)` to each of the 19
  linuxOnly test titles (the map they pin traces to #221/#370; one ref per
  title, mechanical); test/bun/ego-browser-launch-timeout.test.ts:97 — move
  the #276 citation into the skipIf test's title.

Order: F1+F2 together (same file), then F3, F4, F5, F6. After each file:
run only that file's lane, then `bun run english-check`. Mutant-verify per
finding (REDO the change, RED, revert, GREEN) — one file's tests at a time,
never in parallel with another gate. Push after every commit.
Verification: vitest run for session/activity/studio-row/exceptions,
bun test for reap/bringup/ego lanes, english-check, done record 591.json.
