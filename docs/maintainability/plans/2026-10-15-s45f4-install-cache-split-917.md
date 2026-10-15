# S45-F4 install-cache.test.ts split — plan (refs #917, refs #907)

Source: docs/maintainability/2026-10-15-oversized-tests-sweep-45.md F4.
Pure move of describes, titles verbatim, zero test-body edits. 135 it()
total: 17 describes -> cmds half, 8 -> ticks half.

## Files

- Create: apps/fleet/test/install-cache-cmds.test.ts — lines 65-666
  verbatim (parse/pure helpers + command-shape builders, presignR2).
- Create: apps/fleet/test/install-cache-ticks.test.ts — lines 700-1796
  verbatim (runInstallCacheRestore, backoff/lease, runInstallCacheSaveTick,
  mixed-fleet #350 runProvision/restartWithStorage wiring).
- Delete: apps/fleet/test/install-cache.test.ts (git rm).
- This plan doc.

## Seams and shared setup (split hazards, from the sweep doc)

- :667-668 divider comment stays with cmds half end / ticks half start
  is the section banner at :668-670; both halves keep the divider style.
- presignR2 block carries its own FAKE_ENV — inert fixture keys, moves
  with cmds half.
- fakeRestoreDeps/fakeSaveStorage/fakeSaveDeps/scratchBlueprint/
  fakeRestartStorage/fakeInstallDeps + REPO/ROLE_ENV consts move with
  the ticks half (their only consumers live there).
- dirSlug + INSTALL_CACHE_URL_ENV are the only symbols BOTH halves use
  in code — each half imports what it needs; no shared helper file
  (extraction is sweep-18/43's lane, keep split and dedup separate).
- Header comment block :1-35: cmds half keeps the pure-fn/doc parts,
  ticks half keeps the orchestration parts; both cite the security
  split to test/bun/install-cache-security-*.test.ts.
- Comment-only mentions of installCacheRestoreCmd/parseSaveOutcome/
  lockHashCmd/discoverCacheDirsCmd in ticks half move verbatim — they
  are prose, NOT imports; import lists stay exactly what each half's
  code uses (tsc --noEmit proves it).

## Verify (one at a time, never parallel)

1. npx vitest run test/install-cache-cmds.test.ts test/install-cache-ticks.test.ts — 2 files, 135 tests passed, zero skipped.
2. npx tsc --noEmit (root project covers test/**; run from apps/fleet).
3. bun run english-check.
4. grep -c '  it(' both new files, sum == 135; describe count 17 + 8.

Commits: plan doc alone first ("docs(fleet): S45-F4 install-cache split plan (refs #917, refs #907)"), then the split in its own commit ("test(fleet): S45-F4 split install-cache.test.ts — cmds vs ticks halves (refs #917, refs #907)"). Refs only, never closing keywords. Push with LEFTHOOK=0 git push -u origin fix-917-install-cache-split right after each commit.
