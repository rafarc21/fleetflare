# S26-F14 plan — split test/bun/bringup-hooks.test.ts into gates vs heartbeat

Task: https://github.com/rafarc21/fleetflare/issues/701 (parent sweep #635, finding S26-F14, GLM-OK tier).
Doc: `docs/maintainability/2026-10-13-oversized-test-files-sweep-26.md` §F14 + "Split hazards" (read, all five honored).

## Problem

`apps/fleet/test/bun/bringup-hooks.test.ts` — 1806 lines, 17 describes + 3 top-level tests (99 total), over four gate scripts (lead-gate.sh, completion-gate.sh, session-reemit.sh, activity-heartbeat.sh) plus studio-bringup.sh wiring pins. Zero shared in-file state across the seam: every helper/const is used by exactly one half (lead-gate greps confirm: no symbol has call sites on both sides except the shared `exec-snippet` import).

## Change

Pure move. One file becomes two, describes whole, titles verbatim, zero assertion edits:

1. `test/bun/bringup-gates.test.ts` — lines 1-1081 + completion-gate fixture block (GIT_ID/gateFixture/cleanup/writeLocalRecord/gateIn/broken/onBranch/commitAll/repoWithMergedRecords, :817-864, stays inside its current position between the two completion-gate describes). Describes: lead gate executed/shape/no-STUDIO_ID, completion gate no-STUDIO_ID/prose/executed/#361, install-marker wiring, maestro no-proxy, mid-flight redirect, bake-in mechanism, plus top-level `:481` matcher test.
2. `test/bun/bringup-heartbeat.test.ts` — REEMIT const + reemit() (:1083-1097), then everything :1099-1806: session re-emit, ACTIVITY_HEARTBEAT, fakeClaudeBinary/tmuxStubDir/fakeBsdDateDir/sq/dq/claudeHop/shellHop/linuxOnly/AncestryMode/runHeartbeatWithAncestry/heartbeat helpers, heartbeat describes, extractMarkedBlock, settings wiring describe, top-level tests :1787/:1792.
3. Delete `bringup-hooks.test.ts`.

## Guardrails

- Per-half imports trimmed to what the half calls (gates half: no copyFileSync/chmodSync/readdirSync calls; heartbeat half: no utimesSync). Import-line edit is the ONLY non-move edit.
- Stale-name comments in other files (studio.session.test.ts:142/:5080, install-marker-gate.test.ts:19/:55, cli/context-salvage.ts:14) name bringup-hooks.test.ts — fix each to name bringup-gates.test.ts or bringup-heartbeat.test.ts (whichever half now carries the named test). Comment-text edits only.
- File-header comment block (:10-21) goes to gates half verbatim; heartbeat half carries the #221/PR3b headers already attached to its own sections.
- No helper extraction, no shared module (sweep hazard 2: dedup lane is separate).

## Verification

- `cd apps/fleet && bun test test/bun/bringup-gates.test.ts test/bun/bringup-heartbeat.test.ts` exit 0, 99 tests.
- Counts per file before vs after, sum equal (maestro guard): gates 63, heartbeat 36.
- `cd apps/fleet && bun run english-check` exit 0.
- Heavy `bun run check` NOT needed (test-only, tsc -p test covers it — run it ALONE under flock anyway, once, in verify step).
