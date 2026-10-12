# Plan — slow-tests sweep 15 (task #487)

Parent: https://github.com/rafarc21/fleetflare/issues/487. Doc-only, no code, no test edits.

1. Rank apps/fleet/test slow tests. The task named `gh run view --log` on a main CI run for durations — GitHub Actions is disabled in this repo (CI is the local-ci commit status), so no run logs exist. Measured locally on the sweep container, 2026-10-12, one file at a time (one-heavy-gate rule). DONE — 12 findings.
2. Classify each finding: fake-clock replaceable (injected clock / vi.useFakeTimers fits) vs intrinsic (the wall time IS the assertion — real subprocess/tmux/kill walls a fake clock cannot cross). Only fakeable ones get a proposed rewrite; intrinsic ones recorded with the reason.
3. Write `docs/maintainability/2026-10-12-slow-tests-sweep-15.md` (content given by the lead, written verbatim below).
4. Proposed: one issue per batch, title `test(GLM-OK): S15-Fn <short>` — NOT filed in this pass (operator 30m-cap stop; the doc's Counts section names which findings they would be).
5. One docs-only PR: both docs, refs #487, never closing keywords.

## Boundaries

- apps/fleet/test ONLY. No src/ or cli/ production code touched. No assertions weakened. test-lies-check must stay clean.
- Verification: `bun run scripts/english-check.ts` and `bun run scripts/test-lies-check.ts` from apps/fleet — the two checks a docs-only PR can move. No bundler build, no test suite.

## Verification

- english-check exit 0, test-lies-check exit 0
- `git diff origin/main --stat` shows exactly 2 new doc files
