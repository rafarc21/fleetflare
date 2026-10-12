# Plan — sweep 22: weak tests (#576)

Scope: apps/fleet/test/** (test root + test/bun, helpers excluded). Analysis
only, doc-only; test files read, never modified. Census by paren-depth scanner
(helper-aware) over 335 files / 8225 blocks; every finding read in full with
its src module. test-lies-check's categories (tautological/source-reading/
own-module-mock) are disjoint from this sweep's — nothing here duplicates it.

## Steps

1. Commit sweep doc docs/maintainability/2026-10-12-weak-tests-sweep-22.md
   (6 findings + verified-clean set, content provided by lead).
2. File 6 follow-up issues, one per batch, titled test(GLM-OK): S22-Fn <short>:
   F1 fleet-reap backoff 30m value, F2 fleet-reap:583 three maps, F3
   session:1236 hash assert, F4 cli.studio-row return value, F5 never-throws
   companions, F6 cond-skip issue refs. Each refs #576, never closing keywords.
3. Open one doc-only PR (sweep doc + plan doc only), refs #576, never closing
   keywords.

## Verification

- Doc-only change: english check only — cd apps/fleet && bun run english-check.
- git diff origin/main --stat shows exactly the two docs files.

## Boundaries

- No test or src changes. No new deps. No CI polling. Review cap 30m.
