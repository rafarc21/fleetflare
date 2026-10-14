# S35-F5 plan — second cut: split test/bun/bringup-heartbeat.test.ts (task #798, refs #735)

Doc: docs/maintainability/2026-10-13-mid-size-test-files-sweep-35.md §F5 + split hazards (all five honored). First cut was sweep-26 F14 (PR #724). GLM-OK tier.

## Problem

731 lines, 6 describes + 2 flat pins, two unrelated subjects in one file: gates/session-reemit.sh (the re-emit hook) and gates/activity-heartbeat.sh (the heartbeat hook + its studio-bringup.sh wiring pins). Zero shared in-file state across the seam: the reemit() helper, REEMIT const and mkdtemp'd workspace fixtures serve only the re-emit half; fakeClaudeBinary/tmuxStubDir/fakeBsdDateDir/sq/dq/claudeHop/shellHop/linuxOnly/runHeartbeatWithAncestry/heartbeat and ACTIVITY_HEARTBEAT serve only the heartbeat half. Only shared import: runSnippet from ./exec-snippet (the heartbeat half also uses BRINGUP for its wiring pins).

## Change

Pure move, one file becomes two, zero assertion edits, describes whole, titles verbatim:

1. `test/bun/bringup-reemit.test.ts` — lines 1-103 of the old file: imports, REEMIT const, reemit() helper, the "session re-emit hook" describe (8 tests). Import line is the only edit: drop execFileSync, chmodSync, copyFileSync, readdirSync and BRINGUP (this half never uses them; readFileSync stays — REEMIT's gate-source read).
2. `test/bun/bringup-heartbeat-core.test.ts` — lines 105-731: the #221 PR3b header block, ACTIVITY_HEARTBEAT const, all helpers (fakeClaudeBinary, tmuxStubDir, fakeBsdDateDir, sq, dq, claudeHop, shellHop, linuxOnly, AncestryMode, runHeartbeatWithAncestry, heartbeat), the four heartbeat describes (event-to-state map, silent/exit-0, atomic write, lead-only round 2), extractMarkedBlock + the settings.json wiring describe, the two flat pins (blueprint copy single source; no PreCompact).
3. Delete bringup-heartbeat.test.ts.

## Guardrails

- Import lines are the ONLY non-move edits. Reemit half: describe/expect/test, mkdirSync/mkdtempSync/readFileSync/rmSync/writeFileSync, tmpdir, join, runSnippet. Heartbeat half: describe/expect/test, execFileSync, chmodSync/copyFileSync/mkdirSync/mkdtempSync/readdirSync/readFileSync/rmSync/writeFileSync, tmpdir, join, BRINGUP + runSnippet.
- Stale-name comments elsewhere name bringup-heartbeat.test.ts; each moves its cite to bringup-heartbeat-core.test.ts (comment-text edits only): gates/activity-heartbeat.sh:203, apps/fleet/test/studio.session.test.ts:5080. Both cite heartbeat-subject tests, which live in the heartbeat-core half.
- No helper extraction, no shared module, no renames (sweep hazard 2).
- file-count-guard.test.ts derives both sides from argv + git ls-files, so file add/remove needs no guard update.

## Verification

- `cd apps/fleet && bun test test/bun/bringup-reemit.test.ts test/bun/bringup-heartbeat-core.test.ts` exit 0, 36 tests (8 + 28) across 2 files — same as the pre-split baseline (36 across 1).
- `bun run english-check` exit 0.
- `bun run test-lies-check` exit 0.
- `bun x tsc --noEmit -p test` exit 0, run ALONE (heavy gate, one at a time).
- `git grep -n "bringup-heartbeat.test.ts" apps/fleet test` — zero hits.
