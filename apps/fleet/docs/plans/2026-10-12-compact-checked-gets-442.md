# memory/compact.ts checked gets — plan (board issue #442)

Ref #442. Sweep-10 finding F5
(docs/maintainability/2026-10-12-type-safety-sweep-10.md): four
non-null asserts whose guarantees live 15+ non-local lines away.
Pure code, ~10 changed lines, no new tests — the guards are
unreachable today; a reachable one is a finding, not a test case.

## Steps

1. Characterization: `cd apps/fleet && bun run test memory.compact`
   green before the edit (baseline counts recorded).
2. Four sites in src/memory/compact.ts, per F5:
   - countCitations (:99): `target.split("/").pop() ?? target`
   - surveyMemory (:167): `harvestDateOf(target.split("/").pop() ?? target)`
     — no stamp ⇒ ageMs null ⇒ never auto-demoted, the safe side
   - planCompaction demote loop (:292): checked get
     `if (!f) return refuse(...)` — same message the :277 named-sweep
     emits
   - planCompaction promote sources loop (:310): same checked get
3. Same test command green after, identical counts.
4. One commit, both files, refs #442, push.

## Verification

- `bun run test memory.compact` — green before and after, same counts.
- `flock /tmp/fleet-gate.lock` around `bun run check` — exit 0 (run by lead).
- `bun run english-check` — exit 0 (run by lead).
