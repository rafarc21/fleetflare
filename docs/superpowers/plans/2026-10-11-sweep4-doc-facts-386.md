# Plan — #386 sweep-4 doc-fact corrections

Ref #386. Doc-only: 5 fact defects in docs/maintainability/2026-10-11-deep-modules-sweep-4.md
(cited by round-2 fresh-context review of #361, all pre-verified against origin/main and
the doc's pinned commit 234a3b1) plus the same one fix in issue #368's body.
No code, no behavior. Two-way door.

## Steps

1. This plan doc, committed first.
2. Five edits to the sweep-4 doc:
   - L62 (F6): delete the parenthetical "(cli/junior.ts deliberately avoids bun-only globals)"
     and the "is reachable from the root test pool" claim; justify the tagged-result helper by
     the soft-fail posture alone.
   - L34 (F2): "Both files' own comments cite each other's pagination problems" -> "Each file's
     own comments record a pagination bug it hit (board/api.ts:190 #148; github/api.ts:1012-1019
     PR #239)."
   - L48 (F4): "Sweeps 1-2 noted the pattern but never filed it" -> "Sweeps 1-2 never surfaced it".
   - L76 (F8): "a 4th kind (issue #335's retry lane, a future webhook lane)" -> "a future retry
     or webhook lane".
   - L91 (F10): "both handlers revoke junior authorizations" -> "both handlers revoke
     authorizations — one the junior D1 record, one a glm-lead assignment".
3. Same F8 fix in issue #368's body (gh issue edit; read body first, change only that phrase).
4. Verify: bun run english-check; re-check each edited line's refs against source.
5. Done record at /workspace/.fleet/done/386.json (lead supplies content).

## F6 decision (lead's call, reviewer marked non-blocking)

Keep F6, fix only the false parenthetical. The doc is the historical record of what sweep-4
found; F6 already closed via #366/#391, dropping it would falsify the sweep's findings.
