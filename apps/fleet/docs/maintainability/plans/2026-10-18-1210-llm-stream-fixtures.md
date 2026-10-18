# Plan — recorded kimi/deepseek stream fixtures for llm translate (refs #1210)

Follow-up to #1197. The #1209 "wire-level kimi stream" test is one
hand-written SSE string. This task commits replayable router-stream
fixtures under apps/fleet/test/fixtures/llm-streams/ and a bun test that
replays each through translate.ts's real chunk pipeline.

## Blocker (honest)

"Record real router streams from a live OSS studio" is impossible from a
studio container: the upstream kimi/deepseek wire bytes exist only inside
the Worker (env.AI.run), and no Cloudflare credential exists here. The
fixtures are therefore hand-built from the documented wire shapes already
pinned in translate.ts and llm-translate-stream.test.ts, labeled
NOT-live-captured in each file. Live re-capture is escalated to the
operator (a wrangler-tail dump or a maestro-side smoke), not faked.

## Fixtures (apps/fleet/test/fixtures/llm-streams/)

Each file is a raw upstream OpenAI-SSE body (real `data: ` lines, real
finish_reason/usage chunks, secrets scrubbed). Four files, one per case:

- stray-closer.sse — kimi thinkTags ON: visible narration, then ` response`
  with no ` thinking` first, then a clean finish. Replay expects the stray
  closer dropped (no visible ` response`), turn ok, end_turn.
- in-think-tool-after-narration.sse — kimi thinkTags ON: narration, then a
  complete `<tool_call>` recovered inside ` thinking`, then finish. Replay
  expects a real tool_use block, stop_reason tool_use, no narration text
  leaked.
- good-call-then-truncated.sse — kimi thinkTags ON: one complete
  `<tool_call>`, then a truncated sibling, then finish. Replay expects
  retryable error (think_tool_call_unrecovered), no message_stop.
- deepseek-plain.sse — deepseek thinkTags OFF: plain text, no think tags.
  Replay expects byte-identical text streaming and a clean end_turn.

## Replay test (apps/fleet/test/bun/llm-translate-fixtures.test.ts)

Reads each .sse with readFileSync + import.meta.dir (same idiom as
archive-wiring.test.ts), splits on blank lines, feeds each `data:` line
through parseSseDataLine -> applyOpenAIStreamChunk, then
closeStreamOrError. Asserts the per-case expectations above. No new
production code; translate.ts is already correct (logic proven by #1197).

## Verify

cd apps/fleet && bun test test/bun/llm-translate-fixtures.test.ts  (exit 0)
cd apps/fleet && bun test test/bun/llm-translate-stream.test.ts      (exit 0, unchanged)
cd apps/fleet && bun run english-check && bun run test-lies-check    (both exit 0)
tsc --noEmit -p test from apps/fleet                              (exit 0)

## Guard rails

- No production code changes. Fixtures + one test file only.
- Fixture files carry a header comment marking them NOT-live-captured.
- Existing llm-translate-stream.test.ts untouched.
