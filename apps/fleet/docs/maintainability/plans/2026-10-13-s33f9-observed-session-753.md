# S33-F9 plan — shared ObservedSession builder, issue #753

Census: sweep 33 (duplicated test setup), issue #733. Spec: issue #753.
Baseline measured 2026-10-13: vitest on the 3 files = 157 tests, 3 files, 0 fail.

## Steps

1. New `apps/fleet/test/helpers/observed-session.ts` exporting
   `session(over: Partial<ObservedSession> = {}): ObservedSession`, defaults
   = the survival pair's byte-identical values (survival-retry:54-59 and
   survival-input:54-59, an S26-F10 (#697) split pair synced by hand until now).
2. survival-retry.test.ts, survival-input.test.ts: delete the local `session`,
   import it from `./helpers/observed-session`. `NOW` stays — used elsewhere.
3. cli.recycle-outcome.test.ts: local wrapper
   `const session = (over) => observedSession({ at: START.toISOString(), snapshotAgeS: 5, turnsBefore: 3, ...over })`
   folds its divergent defaults once; its 15 call sites untouched.
4. Verify (sequentially, one at a time): vitest on the 3 files (expect 157/3),
   mutation red check on cli.recycle-outcome, `npx tsc --noEmit -p test`,
   english-check, test-lies-check.
5. Push branch, completion record.

## Risk

Pure test-fixture move, no src/ or container/ change. Door: two-way.
