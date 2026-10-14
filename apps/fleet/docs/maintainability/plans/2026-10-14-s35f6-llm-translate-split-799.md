# S35-F6 plan — llm-translate.test.ts split (refs #735, refs #799)

Pure move: split apps/fleet/test/bun/llm-translate.test.ts (812 lines
post-#717, not the 719 the sweep doc read; 13 describes, 60 static
test() incl. 5 test.each templates) into llm-translate-request.test.ts +
llm-translate-stream.test.ts. Titles verbatim, no new tests, no
assertion edits, no helper extraction (sweep-26 hazard 2: split first,
dedup later). Sweep-35 doc F6 governs.

## Baseline (measured, on origin/main 8fa7738)

cd apps/fleet && bun test test/bun/llm-translate.test.ts
→ 78 pass, 0 fail, 119 expect() calls, 36.00ms.

## Seams (current line numbers, file as of 8fa7738)

- llm-translate-request.test.ts ← old :1-466:
  header comment, imports (GLM_LEAD_MODEL, GLM_MIN_MAX_TOKENS,
  anthropicRequestToOpenAI, openAIResponseToAnthropic only),
  describes: text, GLM_MIN_MAX_TOKENS floor, pool model override,
  maxMaxTokens ceiling, tools, tool_use/tool_result round trip,
  openAIResponseToAnthropic — text, output_tokens clamped to
  requestedMaxTokens, openAIResponseToAnthropic — tool_calls.
- llm-translate-stream.test.ts ← old :468-812 (plus parseFrame helper
  old :23-29 — stream half needs it, request half does not, so it moves
  whole into the stream file):
  imports (classifyAiError, createStreamState, streamPrelude,
  applyOpenAIStreamChunk, closeStream, closeStreamOrError,
  parseSseDataLine, parseStreamErrorChunk, streamErrorFrame),
  describes: classifyAiError, streamErrorFrame, parseSseDataLine,
  streaming: prelude + chunk application + close, closeStreamOrError
  #284 (a), parseStreamErrorChunk #284 (b).
- parseFrame: verify zero uses in the request half before moving it
  (grep in the :31-466 range); it must live only in the stream file.

## Steps

1. This plan doc, committed first.
2. RED: create both new files with correct imports + parseFrame in the
   stream file, move ALL describes per seams, DELETE the old file, run
   `bun test test/bun/llm-translate-request.test.ts test/bun/llm-translate-stream.test.ts`
   from apps/fleet — if the move is somehow incomplete it fails on
   unresolved names.
3. GREEN: complete move. Both files pass, sum 78, 119 expect() calls
   total.
4. Verify: bun test both files; per-file grep counts recorded
   (`grep -c "test(" per file`, sum incl. templates = 60 static);
   `tsc --noEmit -p test` from apps/fleet (covers test/tsconfig.json →
   bun/**/*.ts); `bun run english-check` and
   `bun run test-lies-check` from apps/fleet, both exit 0.
5. Push branch sweep-799-llm-translate-split, open PR.

## Guard rails (violations = rework)

- Titles verbatim — move describe/test blocks whole, change NO string
  inside. Comments attached to a describe/test move WITH it (the STATUS
  comments, incident #717 comments, review-round comments).
- Sum: 78 runtime pass / 119 expect() calls must hold.
- No shared helper extraction, no fixture files, no new imports beyond
  what each half actually uses from ../../src/llm/translate.
- Old file DELETED from disk, not left empty.
- test/llm.anthropic-route.test.ts:6-9 comment still names
  test/bun/llm-translate.test.ts — update that path mention to name the
  two new files instead (comment-only change, keep the sentence's
  meaning: translation directions covered in the two bun files).
- Commit messages English, conventional, "refs #799" (never
  "fixes/closes"). Never push to main; push with LEFTHOOK=0 git push
  origin sweep-799-llm-translate-split.
