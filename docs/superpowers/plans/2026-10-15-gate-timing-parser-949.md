# Task 949 — gate shard timing parser (gate-runner plan Task 8, refs #715)

One pure module, no suite runs: `apps/fleet/scripts/gate/measure-shard-timing.ts`
plus `apps/fleet/test/bun/gate-measure-shard-timing.test.ts`.

- `parseVitestTimings(text)` — vitest `--reporter=json` shape (testResults[].name/.startTime/.endTime), name stripped to repo-relative via `/^.*\/apps\/fleet\//` -> "", duration = endTime - startTime, missing fields -> ms 0, malformed JSON -> []. Verbatim from plan Task 8 Step 3.
- `parseBunJunitTimings(xml)` (delta, #715 comment 6188308109: bun lane dominates 674s vs 255s) — sum of `<testcase time="...">` per file in `bun test --reporter=junit --reporter-outfile` XML. Measured on bun 1.3.12: file-level `<testsuite time>` attr is "0", real seconds live only on testcase elements; per-file = sum of its testcases' time attrs. Seconds float -> ms int, Math.round.
- Both parse-only, no throws; CLI entry via import.meta.main for the vitest variant.
- Verification: targeted only — `bun test test/bun/gate-measure-shard-timing.test.ts` (twice: RED then GREEN), `tsc --noEmit -p test` once after GREEN, english-check on new files. Never the full suite or full `check`.

TDD: failing test first, commit, push. Full code blocks for test and module are in the plan doc under Task 8; chunk 2 (next agent) applies them plus the junit addition.
