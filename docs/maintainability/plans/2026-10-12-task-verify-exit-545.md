# fix-545 plan — `fleet task verify` exits 1 on attempted-failed

Task: https://github.com/rafarc21/fleetflare/issues/545 (sweep 19 finding
S19-F1, refs #539).

## Problem

`cmdTaskVerify` (cli/fleet.ts:1797, dispatch :3030) prints the Worker's verify
results — ❌ attempted-failed lines included — but always exits 0. It is the
only check verb in the CLI whose failure is invisible from `$?`, so scripts
(`fleet task verify <n> && …`) see success on a failed envelope.

## Change

Two files.

- apps/fleet/cli/fleet.ts: after the print loop, exit 1 when any
  `result.results[].verdict` is `attempted-failed`. `not-mechanically-checkable`
  and `attempted-ok` stay exit 0 — an unmechanizable step is not a failure.
- apps/fleet/test/bun/cli.task-verify.test.ts: pin the exit code. The existing
  two-result test (one attempted-ok + one attempted-failed) flips its exit
  assertion 0 → 1; add one test whose answer is all-attempted-ok (exit 0), one
  with a not-mechanically-checkable verdict (exit 0), reusing the existing
  Bun.serve stand-in pattern.

## Steps

1. This plan doc (this commit).
2. RED: extend test/bun/cli.task-verify.test.ts per above; run
   `bun test test/bun/cli.task-verify.test.ts` from apps/fleet — new exit
   assertions fail against current src. Commit + push.
3. GREEN: the one-line-block fix in cmdTaskVerify; same test run green.
   Commit + push.
4. Verify: bun test (touched file only), bun run test-lies-check,
   tsc --noEmit -p cli — heavy gate, ALONE, nothing parallel.
5. Fresh-context review, QA behavioral run, done record, PR, envelope.
