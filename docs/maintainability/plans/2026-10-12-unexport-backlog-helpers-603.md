# fix-603 plan — un-export isBacklog and BACKLOG_STALE_MS

Task: https://github.com/rafarc21/fleetflare/issues/603 (sweep 24
finding S24-F3, refs #588).

## Problem

`src/board/types.ts` exports `isBacklog` (:143) and `BACKLOG_STALE_MS`
(:154) but no file imports either. isBacklog's only caller is the
sibling `isStaleBacklog` in the same file; BACKLOG_STALE_MS's only
out-of-file mention is a doc comment in src/memory/compact.ts:27 —
a comment, not an import. Exported surface nobody reads is drift bait:
the next sweep cannot tell contract from leftover.

## Change

One file, two keywords.

- apps/fleet/src/board/types.ts: drop `export` on `isBacklog` and on
  `BACKLOG_STALE_MS`. Names stay, values stay, behavior unchanged.
  The compact.ts comment stays — it cites the name, which survives.

## Steps

1. This plan doc (this commit).
2. RED: a pin test asserting both names are absent from the module's
   export surface (import * as types, `expect(types.isBacklog).toBeUndefined()`
   and `expect((types as any).BACKLOG_STALE_MS).toBeUndefined()`); fails
   today. Commit + push.
3. GREEN: drop the two `export` keywords; pin test passes, `tsc --noEmit -p test`
   proves no hidden importer existed. Commit + push.
4. Verify: vitest run test/board.types-export.test.ts, then
   `bun run check` — heavy gate, ALONE, nothing parallel.
   english-check on the diff.
5. Fresh-context review (cap 2 rounds), done record, PR, envelope.
