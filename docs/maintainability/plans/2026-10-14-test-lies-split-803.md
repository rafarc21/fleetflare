# S35-F10 plan — split test/bun/test-lies-check.test.ts into detectors vs repo/CLI

Task: https://github.com/rafarc21/fleetflare/issues/803 (parent sweep #735,
finding S35-F10, GLM-OK tier). Doc:
`docs/maintainability/2026-10-13-mid-size-test-files-sweep-35.md` §F10.

## Problem

`apps/fleet/test/bun/test-lies-check.test.ts` — 698 lines, 7 describes /
42 tests over `scripts/test-lies-check.ts`, the repo's own test-quality
gate. Sweep-35 band 600-800. Seam measured: `:45-374` detectors,
`:375-698` repo + CLI + #323 characterization.

## Change

Pure move, describes whole, titles verbatim, zero assertion edits:

1. `test/bun/test-lies-detectors.test.ts` — Fixture class (:22-43) +
   describes: findTautologies, findSourceReading, findOwnModuleMocks,
   formatFinding (:45-373). Imports trimmed to detectors used.
2. `test/bun/test-lies-repo.test.ts` — describes: "the repository
   itself" (:375-411), CLI exit code (#174, :413-472), quote/escape/
   bracket-depth walking (#323 characterization, :474-698). Needs its
   own Fixture copy — its last #323 test uses one — plus mkdtemp CLI
   harness inline.
3. Delete `test-lies-check.test.ts`.

## Couplings (the non-move edits)

- `scripts/test-lies-check.ts` ALLOWLIST (:47-52): replace the
  single old-path key with BOTH new paths, same reason text.
- `scripts/test-lies-check.ts:33` header comment: "(test/bun/
  test-lies-check.test.ts)" → "(test/bun/test-lies-detectors.test.ts,
  test/bun/test-lies-repo.test.ts)".
- `scripts/test-lies-check.ts:529` scanRepo doc comment names the old
  test path — update to the two new files.
- Repo half test "never appears in its own real findings" (:407-410)
  pins the old path — must assert BOTH new files absent AND the old
  path absent (dropped ALLOWLIST entry regression guard still works).
- #323 detector tests in repo half ARE flagged shapes textually —
  both new files need ALLOWLIST, not just the detectors half.
- Split hazard 2 (sweep-26): Fixture class duplicated in both halves
  is fine — extraction is the separate dedup lane, never both at once.

## Verification (one heavy gate at a time)

- `cd apps/fleet && bun test test/bun/test-lies-detectors.test.ts
  test/bun/test-lies-repo.test.ts` — exit 0, 42 tests.
- Test-count guard: 23 (detectors) + 19 (repo) = 42, sum equals
  before (22 + 20 in-file before).
- `cd apps/fleet && bun run english-check` — exit 0.
- `cd apps/fleet && bun run test-lies-check` — exit 0, 0/0/0 across
  366 files (was 365).
- `cd apps/fleet && bun x tsc --noEmit -p test` — once, alone.
