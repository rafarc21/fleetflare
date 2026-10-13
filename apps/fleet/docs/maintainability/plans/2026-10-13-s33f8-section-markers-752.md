# S33-F8: SECTION_* transcript markers — export from src, import in 3 suites (refs #733, refs #752)

## What

src/studio/transcript.ts:266-299 declares 8 private SECTION_* wire markers. 3 suites re-spell them as local consts:

- test/studio.transcript.test.ts:18-25 — 8 markers
- test/studio.restart-count.test.ts:23-27 — 5 markers (BOOTID, STAT, INCARNATION, CHUNK, TAIL)
- test/bun/transcript-wire-equivalence.test.ts:20-24 — same 5 markers

Export the 8 consts from transcript.ts, import them in the three suites, delete the local spellings. Reword each suite's "pinned as literals" comment: marker values now come from the builder's own exports; the drift contract stays owned by test/bun/transcript-wire-format.ts (the bash -n spec copy) plus the equivalence test's byte-for-byte expect.

No new helper file. Same outcome helpers/bringup-pins.ts got for the bring-up script.

## Steps

1. Add `export` to the 8 SECTION_* consts in src/studio/transcript.ts (lines 266, 267, 271, 272, 273, 280, 289, 299). No other src/ change — task's own note: diff limited to added export keywords.
2. test/studio.transcript.test.ts: add the 8 names to the existing import from ../src/studio/transcript; delete the 8 local consts (lines 18-25); reword the wire-literals comment above them.
3. test/studio.restart-count.test.ts: line 8 is `import type { TranscriptStorage } from "../src/studio/transcript";` — turn it into a value import adding the 5 markers; delete local consts (lines 23-27); reword comment. TRANSCRIPT_BOOT_ID_KEY and TRANSCRIPT_MANIFEST_KEY stay local — task names SECTION_* markers only.
4. test/bun/transcript-wire-equivalence.test.ts: add the 5 names to the existing import from ../../src/studio/transcript; delete local consts (lines 20-24); reword comment.
5. Verify serially, one gate at a time: vitest run on the 2 vitest files (cd apps/fleet && bunx vitest run test/studio.transcript.test.ts test/studio.restart-count.test.ts); bun test test/bun/transcript-wire-equivalence.test.ts; bun run check; english-check; test-lies-check.

## Boundaries

- src/ = export keywords only. No behavior change.
- test/bun/transcript-wire-format.ts keeps its own local copy — it is the bash -n net's owned spec, its header says so. NOT touched.
- restart-count's TRANSCRIPT_*_KEY keys stay local.
- Heavy gates serial, never two at once (container memory ceiling).

~18 lines removed; ~3 comment blocks reworded.
