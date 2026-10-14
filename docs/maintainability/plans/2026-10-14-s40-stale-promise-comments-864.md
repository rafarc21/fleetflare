# #864 plan — S40-F1..F4 stale promise-comments rewording

Refs #844 (sweep 40 doc: docs/maintainability/2026-10-14-stale-markers-sweep-40.md, PR #865).
Comment-only rewording of 4 files, no behavior change, no exported API change.

1. close-action.ts:101 — replace "(Portuguese until the #66 follow-up; ...)" with the historical note from sweep-40 F1.
2. anthropic-route.ts:13-16 — replace the stale "(Since then: ...)" parenthetical with the all-three-landed wording from sweep-40 F2.
3. sensors/run.ts:35 — replace "intended once a scheduled workflow (not part of this PR) calls it" with the names-the-workflow wording from sweep-40 F3.
4. pr-landed.ts:43-44 — replace "issue #180 projects ~186 once #163's listIssues pagination fix keeps a wider net visible" with the present-tense wording from sweep-40 F4.

Verification: bun test on the 4 files' existing test files (bun/close-action, anthropic-route or llm tests, sensors-run, pr-landed) + bun run english-check + bun run test-lies-check. No heavy gates: never full test suite, never vite build, never repo-wide tsc alongside anything else.
