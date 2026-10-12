# Plan — S14-F7: pin formatSurvivalAge to formatAge wording (refs #511)

Sweep 14 finding S14-F7 (refs #485). Tests only — src/ and cli/ untouched.
formatSurvivalAge (src/studio/survival-brief.ts:349) is byte-identical to
formatAge (cli/readiness-format.ts:81). The src→cli import direction is
forbidden (survival-brief.ts header, issue #107), so the copy stays and a
behavioral pin replaces it: the brief's rendered age wording must equal the
real formatAge's output at every bucket boundary, on both render paths.

## Steps

1. test/studio.survival-brief.test.ts — new describe "formatSurvivalAge pinned to cli formatAge wording (S14-F7, refs #511)": sweep of boundary ages through BOTH render paths — the Session "from snap <age> old" suffix (baseSession({snapshotAgeS: X})) and the task-line last-commit age (baseInput({tasks: {ok: true, value: [{taskNumber, taskTitle, branch, commitsAheadOfMain, lastCommitAt: NOW minus X seconds}]}})) — asserting the rendered age token matches formatAge(X) imported live from ../../cli/readiness-format (test-side import, legal direction). Boundaries: 0, 7, 59, 60, 61, 119, 300, 3599, 3600, 3661, 86399, 86400, 90000, 172800, plus one negative clamp and one fractional-floor case. One explicit example assertion keeps the wording human-readable ("from snap 1h old"); the rest assert against the imported function.
2. RED check: temporarily mutate formatSurvivalAge's minute fallback to `${s}m`, run vitest run test/studio.survival-brief.test.ts, confirm new tests fail, restore, rerun green. One gate at a time.
3. Commit, push, PR refs #511 (no closing keyword).

## Verification

- `bun run vitest run test/studio.survival-brief.test.ts` — all pass
- `bun run test-lies-check` — 0 findings (test imports formatAge and exercises it; not source-reading)

## Out of scope

Any src/ or cli/ change; rescue/destroy logic; CI wiring.
