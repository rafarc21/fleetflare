# Plan: #1179 amend PR #1174 — real timing test + wording (refs #1155, refs #1174)

Amend-only. SQL + route logic unchanged; same branch 1155-llm-router-followups, same PR.

## Step 1 — new test (TDD: mutants are the RED)
test/llm.anthropic-stream.test.ts, new `it` after the existing time_to_headers test:
- run() awaits a real 30 ms timer, then returns a ReadableStream whose
  start() awaits a real 40 ms before the first enqueue
- assert time_to_headers >= 25 AND duration_ms - time_to_headers >= 30
- one-sided bounds, real timers — a timer fires at or after its delay, so no flake

## Step 2 — wording x3
"request start" -> "model-call start (after auth, rate limit, body, pool reads)":
- src/junior/usage.ts:39 doc comment
- migrations/0010_junior_usage_time_to_headers.sql:3 comment
- PR #1174 body (lead amends after mutant evidence)

## Step 3 — mutant RED evidence (never committed)
- A: anthropic-route.ts:906 `const headersAt = Date.now();` -> `const headersAt = startedAt;`
  -> time_to_headers 0 -> first assert RED
- B: every `timeToHeaders: headersAt - startedAt` -> `timeToHeaders: Date.now() - startedAt`
  -> equals duration_ms -> second assert RED
- capture failures verbatim, `git checkout -- src/llm/anthropic-route.ts` after each

## Step 4 — GREEN + gates, one at a time
- npx vitest run test/llm.anthropic-stream.test.ts
- bun run check (tsc x5); bun run english-check

## Step 5 — one commit, push
- test(llm): real-timer test pins time_to_headers to the pre-header window (refs #1155, refs #1174)
- LEFTHOOK=0 git push