# S35-F11 claude-swap test split — join vs usage/pick (refs #804, refs #735)

Sweep 35 finding F11 (docs/maintainability/2026-10-13-mid-size-test-files-sweep-35.md).
Pure move, zero src changes, zero assertion edits. Sibling precedent: S26-F15
webhook split (PR #720, docs/superpowers/plans/2026-10-13-webhook-split-702.md).

- before: `apps/fleet/test/claude-swap.test.ts` — 689 lines, 5 describes,
  54 it(), 90 expect() (baseline green 2026-10-14: 54/54 pass via
  `bun x vitest run test/claude-swap.test.ts`).
- after: `test/claude-swap-join.test.ts` — lines :1-611 → 3 describes
  (joinAccountsToCswap, decideAccountSync, real cswap shape tolerance #240),
  44 it(), 78 expect().
- after: `test/claude-swap-pick.test.ts` — lines :612-689 → 2 describes
  (usageMaxPct/toUsageHeadroom #238, pickHeadroomAccount), 10 it(),
  12 expect().
- counts guard: it() per file before vs after, sum equal (44+10=54);
  describe titles verbatim; no assertion text changed.

## Seams

1. Move describes whole, titles verbatim. Issue provenance comments (#232,
   #238, #240, #244) stay attached to their cluster and move with it.
2. Imports: join half keeps joinAccountsToCswap, decideAccountSync,
   MAX_USAGE_AGE_SECONDS, RESET_MATCH_WINDOW_MS, types
   FleetAccountSlot/SlotJoin/CswapAccount, plus the full fixtures/cswap-list
   import. Pick half keeps usageMaxPct, toUsageHeadroom,
   pickHeadroomAccount, types
   UsageHeadroom/HeadroomCandidate/CswapAccount, and the fixture symbols
   its 12 expects touch (OVER_SCOPED_ONLY, STALE_OK). Verify trimmed
   imports with grep after the split — every kept symbol must appear in a
   non-import line, no unused import survives. Dup-not-extract for the
   import preamble; NO shared helper extraction (sweep-18's lane).
3. The pick half's `candidate()` local builder (old :633) moves with the
   pickHeadroomAccount describe, verbatim.
4. The usage describe (:612) and pickHeadroomAccount describe (:632) move
   together — sweep-35 names them one seam (usage + pick).
5. File headers: each new file gets a short header comment stating its
   half's scope and split provenance (S35-F11, refs #804). The join half
   keeps the original header's fixture-provenance pointer
   (test/fixtures/cswap-list.ts's own header) and its PR #237 review
   context.

## Verification (serial, one gate at a time; heavy gates under
`flock /tmp/fleet-gate.lock`, never parallel)

1. `cd apps/fleet && bun x vitest run test/claude-swap-join.test.ts
   test/claude-swap-pick.test.ts` — 54 pass; old
   test/claude-swap.test.ts no longer exists.
2. Preservation proof: for each moved region, diff against the pre-split
   original (`git show 5bc4f90c:apps/fleet/test/claude-swap.test.ts`,
   sliced by line range) — byte-identical modulo the import preamble and
   file header. Record exact commands and output tails in the completion
   record.
3. `bun x tsc --noEmit -p test` (heavy, alone under flock).
4. `bun run scripts/english-check.ts` → clean.
   `bun run scripts/test-lies-check.ts` → clean.
5. Never run the full vitest suite; only these two files.

## Risk

Test-only, no src/ change, no behavior change. Door: two-way — no path under
apps/fleet/scripts/merge-danger.ts ONE_WAY_GLOBS; test files only.
