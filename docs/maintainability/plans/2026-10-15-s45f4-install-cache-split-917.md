# S45-F4 install-cache.test.ts split — plan (refs #917, refs #907)

Pure move of describes, titles verbatim, zero test-body edits.
135 it(): 17 describes -> cmds half, 8 -> ticks half.

## Files

- Create apps/fleet/test/install-cache-cmds.test.ts — lines 65-666 verbatim
  (parse/pure helpers + command-shape builders, presignR2).
- Create apps/fleet/test/install-cache-ticks.test.ts — lines 700-1796 verbatim
  (run loops, backoff/lease, mixed-fleet #350 wiring).
- Delete apps/fleet/test/install-cache.test.ts (git rm).

## Seams (split hazards)

- presignR2 block carries its own FAKE_ENV (inert fixtures) — cmds half.
- fakeRestoreDeps/fakeSaveStorage/fakeSaveDeps/scratchBlueprint/
  fakeRestartStorage/fakeInstallDeps + REPO/ROLE_ENV consts — ticks half.
- dirSlug + INSTALL_CACHE_URL_ENV shared — each half imports its own.
- Import lists = exactly what each half's code uses; comment-only mentions
  are prose, not imports (tsc --noEmit is the proof).

## Verify (one at a time)

1. npx vitest run both files — 2 files, 135 tests, 0 failed.
2. npx tsc --noEmit. 3. bun run english-check.

Commits: plan doc, then split. Refs only, never closing keywords.