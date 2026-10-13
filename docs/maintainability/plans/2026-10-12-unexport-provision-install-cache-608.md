# fix-608 plan — un-export 20→18 provision.ts + install-cache.ts fossils

Task: https://github.com/rafarc21/fleetflare/issues/608 (sweep 24
finding S24-F11, refs #588). Correction refs #620: REMOTE_BRANCHES_LIST_FILE
and RESCUE_DISCOVERY_TIMEOUT_SECONDS moved to #611 — 18 names remain.

## Problem

src/studio/provision.ts and src/studio/install-cache.ts export 18
names no file imports (grep over src/test/test-integration/scripts/
container/cli + repo root: definitions, in-file uses, prose comments
only). Sweep 24's importer map + hand grep agree. Exported surface
nobody reads is drift bait: the next sweep cannot tell contract from
leftover. provision.ts is bring-up-critical (ONE_WAY_GLOBS), so the
change is keyword-only — names, bodies, comments untouched.

## Change

Two files, 18 keywords.

- apps/fleet/src/studio/provision.ts (7): KEEP_ALIVE_KEY :466,
  guardedCloneCmd :883, verifyBringupLanded :1359, TAILNET_DOWN_PATH
  :1566, OpsHouseRulesOutcome :1772, SessionAdoption :3135,
  freshSessionNoteFor :3257.
- apps/fleet/src/studio/install-cache.ts (11):
  INSTALL_CACHE_KEEP_GENERATIONS :203, INSTALL_COMPLETE_MARKER :740,
  R2PresignEnv :1328, INSTALL_CACHE_URL_TTL_SECONDS :1352,
  InstallCacheRestoreOutcome :1452, InstallCacheDirRestoreResult :1461,
  InstallCacheRestoreResult :1475, InstallCacheFailureRecord :1852,
  InstallCacheSaveOutcome :2001, InstallCacheDirSaveResult :2005,
  InstallCacheSaveResult :2013.

Line refs pinned at origin/main 0a134f0 — re-check each before the
GREEN edit; provision.ts moves often.

## Steps

1. This plan doc (this commit).
2. RED: pin test apps/fleet/test/studio.exports-pin-608.test.ts —
   runtime namespace pins for the 8 value exports, `@ts-expect-error`
   type pins for the 10 type-only exports. Runtime pins fail vitest
   today; type pins fail `tsc --noEmit` today as TS2578 (unused
   directive). Commit + push.
3. GREEN: drop 18 `export` keywords; pin passes, `bun run check`
   proves zero hidden importers. Commit + push.
4. Verify (one heavy gate at a time, never parallel): vitest pin file,
   vitest test/install-cache.test.ts, bun run check, english-check.
5. Fresh-context review (cap 2 rounds), done record, PR, envelope.
