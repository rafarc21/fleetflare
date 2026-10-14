# Plan — S36-F1 stoppedRow deleted; golden pins dropped (refs #812, #739)

Finding (sweep 36, census doc
docs/maintainability/2026-10-13-unused-test-helpers-sweep-36.md): the only
importer of `stoppedRow` (test/helpers/studio-row.ts:17) is its own golden
test. Zero suites import it. The stopped state is spelled as overrides on
the shared builders — `row({ state: "stopped", ... })` (fleet-resume :29,
fleet-ls-denominator via the runningRow-as-row alias) — or shadowing local
consts (studio.session :1585, studio.readiness :275/:304). runningRow earns
its 8 importers; stoppedRow's zero after the full sweep-18 adoption pass
(#596) is the market's verdict. Delete, the census-recommended option.

Changes:
1. apps/fleet/test/helpers/studio-row.ts — delete line 17
   (`export const stoppedRow = ...`). Leave runningRow (:16) and every
   comment above untouched.
2. apps/fleet/test/studio-row.helper.test.ts — drop `stoppedRow` from the
   import at :3 (keep row, runningRow, burnRow). Rewrite the combined pin
   test at :24-28 to cover runningRow only:
   `it("runningRow() sets state and changes nothing else", ...)`
   with the two runningRow expects. Delete the stoppedRow(overrides) test
   at :37-38 entirely. burnRow describe block untouched.

NOT touched (task rules): test/studio.session.test.ts and
test/studio.readiness.test.ts (local stoppedRow consts are load-bearing
shadowing names), test/studio.spawn.test.ts (CLAUDE-ONLY lane, sweep-18
F9), test/studio.resume-guards.test.ts (divergent builder by design).

Tricky bit: none — pure deletion of one export plus its self-test pins. No
src/, no container/, no behavior change. Net ~8 lines.

Verify (one heavy gate at a time):
- cd apps/fleet && bun x vitest run test/studio-row.helper.test.ts — green
- cd apps/fleet && bun run check — green (typecheck proves no importer broke)
- cd apps/fleet && bun run english-check — clean
- grep -rn "stoppedRow" apps/fleet --include="*.ts" --exclude-dir=node_modules
  returns only the two shadowing suites' local consts.

Commit: docs(maintainability): #812 plan — S36-F1 stoppedRow delete (refs #739)
Body may be empty. Add the standard Co-Authored-By trailer:
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Use `git commit` normally (no --amend, no force). Do NOT push yet — the
implementation commits follow, push happens after the first RED/implementation
commit per push discipline. Actually, per discipline: push right after this
first commit. Run `LEFTHOOK=0 git push -u origin fix-812-s36f1-stoppedrow-delete`.
