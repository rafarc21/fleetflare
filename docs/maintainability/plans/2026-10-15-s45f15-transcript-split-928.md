# #928 plan — S45-F15 split studio.transcript.test.ts: ship loop vs sections (refs #907)

Sweep 45 finding F15 (docs/maintainability/2026-10-15-oversized-tests-sweep-45.md F15).
Pure move: 1379-line vitest file -> two files, describes whole, titles verbatim,
20 describes / 80 tests unchanged (baseline: 80 pass). Split hazards read + honored:
in-file fakes duplicated not extracted (h2), no shared beforeEach (h4), #NNN provenance
verbatim (h5); no bun lane guards (h1), no mock.module (h3).

## Seams (grep-verified against working file)
- test/studio.transcript-ship.test.ts <- old :1-183 preamble (imports + fakeStorage/
  synthesizeTickStdout/fakeDeps + consts) + 12 describes :184-955.
- test/studio.transcript-sections.test.ts <- old :956-1379 (8 describes) +
  getTranscriptTailWithStorage :1363.

## Shared setup (duplicated verbatim, no extraction)
- Both: fakeStorage/synthesizeTickStdout/fakeDeps, STUDIO_ID/TODAY, 3 storage-key
  consts, 8 SECTION_* names, doStorage/fixedNow/b64Utf8/vi, TranscriptManifest/
  ShipDeps/TranscriptStorage types.
- Ship only: b64/chunkKey/TRANSCRIPT_PULL_MAX/HOT_TAIL_BYTES/INCARNATION_PATH/
  SESSION_FOUND_SECTION/TRANSCRIPT_LOG_PATH/TRANSCRIPT_BOOT_ID_PATH.
- Sections only: getTranscriptTailWithStorage/REAL_PILOT_PANE/SESSION_CONTINUE_SECTION/
  SESSION_CWD_SECTION. Import lists exact, no unused.