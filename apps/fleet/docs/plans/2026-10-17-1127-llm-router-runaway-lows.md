# Plan: #1127 — llm router runaway guard lows (split think tag, quadratic line split)

## Problem

Two round-3 lows on the runaway guard in `apps/fleet/src/llm/translate.ts`:

1. `scanForRunaway` runs the in-think tool-call probe only when `state.thinking`
   is already set or the delta holds the whole `<think>` tag. When `<think>`
   itself is split across deltas (`<thi` + `nk>{...}`), the delta that carries
   `<tool_call>` / `"name":"..."` is scanned before `routeContent` flips
   `thinking`, so the tool payload never latches and its multi-line arguments
   (60 identical 40+ char lines) trip `repeat_line`, losing the tool call.
2. `(scan.partial + text).split("\n")` re-copies the whole open line on every
   delta, even when the delta has no `\n` — quadratic on a long single line
   (183 ms at 62k chars, 2.0 s at 200k).

## Fix

- Probe guard: `if (state.thinkTags || state.thinking || text.includes(THINK_OPEN))`
  — with thinkTags on, the probe runs on every delta, so a split `<think>` tag
  still latches the tool marker before its argument lines reach the scan.
- Line split: only split when the delta contains `\n`; otherwise
  `scan.partial += text`. Identical observable state, linear instead of quadratic.

## Tests

- New: split `<think>` + bare `{"name":"Write",...}` with 60 identical
  multi-line args is recovered as a tool_use, not `repeat_line`. RED first.
- New: a 200k-char single line delivered as 3-char deltas scans without tripping
  and ends with the full text in `scan.partial` (perf-only fix; correctness guard).
- `bun test test/bun/llm-translate-stream.test.ts` and `bun run check` pass.

## Blast radius

The llm router's runaway guard. If wrong, a real kimi in-think tool call whose
tag splits across deltas is aborted as a runaway (tool call lost), or a long
single-line answer is scanned slowly. Confined to `translate.ts` scanning; no
other consumer of `scanForRunaway`.
