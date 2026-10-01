# Plans name test seams; coverage counts behavior tests only (#169)

**Issue:** https://github.com/rafarc21/fleetflare/issues/169

**Goal:** Plans should name the test seams — the public interfaces tests go
through — so a test that goes around a seam instead of through it gets caught
at planning time, not left to CI's `test-lies-check` gate or a code reviewer
to catch after the fact. Also make explicit that the 50% coverage floor
counts behavior tests only, since coverage percentage can reward a
tautological test just as easily as a real one.

This is a prose-only doc edit. No application code, no test files.

## What changed

One file: `skills/spec-driven-delivery/SKILL.md`.

- **Section `### A. Automated tests`**: added a new bullet, "Name the
  seams.", after the existing "Edge cases" bullet. It asks a plan to list the
  public interface each test goes through (exported function, HTTP route,
  CLI command, rendered element), and names the three shapes of going around
  a seam instead of through it — rereading a `src/` file as text, mocking the
  module under test, echoing an imported constant back at itself — matching
  this repo's own `apps/fleet/scripts/test-lies-check.ts` detector
  categories (source-reading, own-module-mock, tautological) exactly. Any of
  those needs a stated reason in the plan: "no reason, no pass."
- **Section `## Coverage`**: added a third paragraph after the two existing
  ones (both left untouched). It states that coverage percentage can reward
  a test that cannot fail, that the 50% floor counts **behavior tests
  only**, and names the same three inflation shapes (tautological
  assertion, mock of the module under test, source-text read standing in
  for the real seam) as things to strip before reporting coverage, not bank.

## Why no app-code change

`skills/spec-driven-delivery/SKILL.md` is a prompt/skill file read by
implementers and the lead at plan-writing time, not application source. No
test imports or string-matches this file's content; `english-check` is the
only lint that touches skill prose, and `test-lies-check.ts` only scans
`.test.ts` files, so this change is a no-op for that scanner — confirmed
below rather than assumed.

## Verification

- `cd apps/fleet && bun run english-check` — clean (`english-check: clean`).
- `cd apps/fleet && bun run scripts/test-lies-check.ts` — unchanged from
  baseline: `0 tautological, 0 source-reading, 0 own-module-mock across 274
  test files`, exit 0. Confirms this skill-file edit has zero effect on the
  scanner, as expected since it isn't a `.test.ts` file.

## Boundaries

Did not run `bun run check` (5x repo-wide `tsc --noEmit`), `bun run test`
(full vitest-pool-workers suite), or `bun run bun-test` (full container
lane). This is a two-section prose addition to a skill markdown file with no
application-code or type surface touched — those heavy gates are reserved
for changes that could plausibly affect build/type/runtime behavior, which
this cannot.
