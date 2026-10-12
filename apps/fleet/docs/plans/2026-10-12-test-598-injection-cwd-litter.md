# Plan — #598: install-cache injection proofs stop littering checkout cwd

Ref #579 sweep 23, finding 1 (doc: docs/maintainability/2026-10-12-orphan-tests-sweep-23.md).
Test-only fix. One file: apps/fleet/test/bun/install-cache-security.test.ts. No src/ change.

## Finding

The two "full pipeline" MUTANT PROOF tests (~line 477 restore, ~line 491 save) pass a BARE
relative injection payload — `injectionPayload(marker)` returns `x$(touch /tmp/<marker>)y` —
to the FIXED, shipped installCacheRestoreCmd / installCacheSaveCmd. Those commands' own
`mkdir -p ${shQuote(dir)}` / `[ ! -d ${shQuote(dir)}/node_modules ]` lines materialize the
literal relative name under the test's cwd (`apps/fleet/`), leaving empty
`x$(touch /tmp/install-cache-sec-pwned-<hex>)y` dir trees. Empty dirs are invisible to
`git status` and accumulate one per run (two hex markers measured on this studio).

## Fix (TDD)

1. RED: in the same test file, add assertions that no `x$(touch`-named entry appears under
   the repo checkout's apps/fleet directory after each full-pipeline proof runs (readdir
   scan). Run `cd apps/fleet && bun test test/bun/install-cache-security.test.ts` — new
   assertions fail against current code (litter exists).
2. GREEN: in the two full-pipeline proof tests only, pass
   `join(base, injectionPayload(marker))` (absolute, inside the per-test tmpdir) instead of
   the bare payload. Same bash-parsing proof: the `$( )` must still be quoted by shQuote or
   the marker fires. Baseline (pre-fix) blocks unchanged — their touch targets are absolute
   and nothing relative is mkdir'ed.
3. Litter from prior runs (pre-existing trees under apps/fleet/) is NOT tracked by git
   (empty dirs); do not try to gitignore it — remove the measured leftovers manually in
   this session after GREEN so the verification find is clean.

## Verification

- `cd apps/fleet && bun test test/bun/install-cache-security.test.ts` green (single-file
  lane, NOT the full suite — heavy gate budget).
- `find apps/fleet -maxdepth 1 -name 'x$(*'` empty after a fresh run.
- `cd apps/fleet && bun run test-lies-check` exit 0.
- `cd apps/fleet && bun run english-check` exit 0.

## Boundaries

- One test file. No src/ changes. No new deps.
- Verification runs the single bun test lane only; full suite belongs to CI/merge gate.
