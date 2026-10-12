# Plan — #455 S6-F9 watchdog.ts comment deprovenance

Refs https://github.com/rafarc21/fleetflare/issues/455 (parent sweep #415, finding F9; doc docs/maintainability/2026-10-12-deep-modules-sweep-6.md §F9, branch sweep-415-glm-maintainability-6). Tier GLM-OK. Comment-only diff, zero code change, two-way door (trivial revert).

## Problem

Three doc comments narrate review rounds before stating their rule:

- src/tasks/watchdog.ts:38-77 — clearRearm: ~33 lines of "Fix round 1 (task 10a review, Important finding)" / "Final re-review residual" / "an earlier version cleared only rearmKey" precede "Clearing both flags in this one place".
- src/tasks/watchdog.ts:99-113 — shouldAlert: leads with "Carve-out C (final-review fix wave)".
- src/agents/do.ts:114-137 — shouldClearRearm: re-narrates the same round-1 story.

Operative invariants (clear on completed polls only; clear BOTH flags; alert once per episode; reset makes re-alert possible) buried under provenance — the "comment narrates issue history instead of why" shape, src-comment twin of sweep-3's #377.

## Change

Rewrite each to state the contract; at most one issue ref each where a measured fact lives; delete round numbering and earlier-version narratives. Keep every measured fact (the throw class, the 5s-vs-60s reachability argument, the one-setter observation, the library's unconditional schedule deletion), drop only the storytelling around it. Consequential edits: watchdog.ts alertedKey's "final-review fix" clause and agents/do.ts shouldClearRearm's "fix this replaces" framing. No signature, behavior, or test change.

## Steps (TDD)

1. Implement comment rewrites (exact text pre-written in dispatch brief). Commit both files, refs #455, push.
2. Characterize: comments cannot change tests — run them anyway per discipline: `cd apps/fleet && bun run test watchdog agents.do` — pass unchanged.
3. Gates, one at a time: `cd apps/fleet && bun run english-check` (comment-heavy diff — the gate that matters here), then `flock /tmp/fleet-gate.lock bash -c 'cd apps/fleet && bun run check'`.

## Boundaries

- Comment-only: any diff hunk touching executable code = STOP, wrong edit.
- No new issue refs in comments except one per function where a measured fact lives.
- Push after every commit (LEFTHOOK=0 git push).
- Heavy gates: english-check then check, sequential, never alongside a test run.
