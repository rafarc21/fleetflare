# Plan — S24-F2: tasks/types.ts, five of eight exports consumed by nothing (refs #602, parent #588)

Sweep-24 finding F2 (docs/maintainability/2026-10-12-unused-exports-sweep-24.md, GLM-OK lane). src/tasks/types.ts exports GATE_ACTIONS, isGateAction, TaskState, Milestone, PendingApproval with zero importers. Verified on this branch by grep: module's only importers (tasks/loop.ts, agents/runtime.ts, approvals/gates.ts, approvals/store.ts, test/tasks.loop.test.ts) import only TaskStatus, GateAction, GATE_LABELS. isGateAction has no caller anywhere; its body is GATE_ACTIONS' only consumer, so deleting it makes the array fully dead.

## Change

One file, apps/fleet/src/tasks/types.ts:

1. DELETE `export function isGateAction` (lines 7-9) — dead function, no test pins it.
2. DELETE `export const GATE_ACTIONS` (lines 3-5) — its only consumer was isGateAction's body; with that gone the array is dead. Sharper than the sweep doc's "un-export": keeps no orphaned private const.
3. Un-export (drop ONLY the `export` keyword, keep symbol + in-file use): `TaskState` (line 19), `Milestone` (line 21), `PendingApproval` (line 26) — all three compose TaskStatus, which stays exported.
4. GateAction, GATE_LABELS, TaskStatus stay exported — the module's real consumed surface.

## TDD / verification (one heavy gate at a time, flock /tmp/fleet-gate.lock)

1. RED: before edits, write test/tasks.types.test.ts pinning the module's consumed surface: import { GATE_LABELS, type GateAction, type TaskStatus } from "../src/tasks/types"; assert GATE_LABELS values map each GateAction to a non-empty string; assert a TaskStatus value type-checks with state: "idle", milestones: [], pendingApproval: null. Then run `grep -rn "isGateAction\|GATE_ACTIONS" apps/fleet/src apps/fleet/test apps/fleet/cli` — expect only src/tasks/types.ts hits; if any other file hits, STOP and report back, do not edit.
2. GREEN: apply the four edits, run the new test — `cd apps/fleet && ./node_modules/.bin/vitest run test/tasks.types.test.ts` — exit 0.
3. Per-symbol grep after edits: `grep -rlw isGateAction apps/fleet` → zero files; `grep -rlw GATE_ACTIONS apps/fleet/src` → zero files (container/ has its own local GATE_ACTIONS? check: if container/ declares its own GATE_ACTIONS locally that is FINE, it does not import from tasks/types — verify with `grep -rn "from.*tasks/types" apps/fleet/container/` expecting zero hits; if a container file DOES import GATE_ACTIONS/isGateAction from tasks/types, STOP and report).
4. Targeted vitest: test/tasks.loop.test.ts test/approvals.gates.test.ts test/agents.do.test.ts — the modules importing tasks/types.
5. `flock /tmp/fleet-gate.lock bash -c 'cd apps/fleet && bun run check'` — exit 0. This is the real proof: tsc catches any missed importer at compile time.
6. `flock /tmp/fleet-gate.lock bash -c 'cd apps/fleet && bun run english-check'` — exit 0.

## Bounds

- One file + one test file + one plan doc. Two-way door (re-add `export` trivially). No behavior change; runtime code deleted is dead code.
- Sibling sweep tasks may run parallel: touch NOTHING outside the files above.
