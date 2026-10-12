# Plan — sweep-7 fleet-cockpit doc fixes (issue #430)

Board issue #430 (batch 1 of 4 from sweep #421). Three stale-fact findings in
skills/fleet-cockpit/SKILL.md, all verified against origin/main (3634dcd):

- S7-F1 lines 61-63: claims "org.json still lists a cto role and an operator node
  from before this; those are being reconciled in the blueprint (board task)".
  fleet/blueprint/org.json edges are keyed operator/pilot/maestro only — no cto.
  Reconciliation already happened. FIX: delete the stale sentence, keep the
  Vocabulary ruling itself.
- S7-F2 lines 104-105: parenthetical claims "(org.json also lists cto ->
  release, qa, dev; none of those four roles has a definition file, so those
  edges resolve to nothing.)" — no such edges exist. FIX: delete the parenthetical.
- S7-F3 line 76: "see `fleet-dispatch-grouping-rule`" resolves to nothing
  repo-wide (single mention, no target). FIX: point at the real text —
  fleet/blueprint/studios/web-studio/studio.md line 13, the collision-free
  grouping rule.

## Steps

1. This plan doc, committed first.
2. Edit skills/fleet-cockpit/SKILL.md only: apply the three fixes above.
   S7-F1: sentence "…from before this; those are being reconciled in the
   blueprint (board task)." deleted so the paragraph ends cleanly after the
   Vocabulary ruling. S7-F2: whole parenthetical removed from the end of
   "…usually what you wanted anyway." S7-F3: "see `fleet-dispatch-grouping-rule`"
   becomes "see the collision-free grouping rule in
   `fleet/blueprint/studios/web-studio/studio.md`".
3. Verification: bun run english-check; bun run test-lies-check; grep proof
   that "cto" and "fleet-dispatch-grouping-rule" no longer appear in the file;
   flock /tmp/fleet-gate.lock bun run check (tsc, heavy gate, run alone).
   Docs-only diff — no test suite run beyond these scripts.
4. Fresh-context Code Reviewer on the diff (Spec + Standards axes).
5. QA n/a (no UI); completion record /workspace/.fleet/done/430.json; PR refs
   #430 and #421, never closes either.

## Boundaries

Scope: skills/fleet-cockpit/SKILL.md only. No code changes. Do not touch
fleet/blueprint/org.json (already correct). English only. `bun run check`
counts as the heavy gate — run it once, alone, under the lock.
