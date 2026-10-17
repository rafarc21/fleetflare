# Plan: #1193 — Worker auto-continue for idle OSS leads (refs #1112)

## Problem
OSS leads (glm/kimi/deepseek) end turn with work open. Today operator nudges
by hand (~10 stalls on 10-17). Issue #1112 layer 1 (system prompt) and the
image Stop hook already landed (#1116). This adds the Worker-side nudge: idle
lead + open task -> one continue nudge, same path WAKE uses.

## Decision
New pure module apps/fleet/src/studio/auto-continue.ts:
- decision fn `shouldAutoContinue(input)` -> { fire: true, taskNumber } |
  { fire: false }. Fire when: leadType glm; activity state idle for >= 10min;
  board task open, assigned, state submitted OR working (never awaiting_merge
  / input_required / terminal); fewer than 1 nudge per 20min; fewer than 6
  nudges this task.
- At 6 nudges this task: fire an escalation event (kind escalation, from the
  studio, to "board") instead of a 7th nudge.
- Prompt: "Continue your board task #<n> now; do not stop between steps."

## Seams (existing, reused)
- Activity: nextActivity/Activity (activity.ts); idle = state "idle";
  idle age from Activity.since (anchored).
- Wake: wakeStudioWith (do.ts) -> runGatedWake (stopped/limit-modal gates).
- Board: findLiveAssignedTask (board.ts) -> BoardTask.state/number.
- leadType: resolveLeadType(STATUS_KEY row) -> "glm".
- Events: makeEvent/appendEvent; one row per nudge, one per escalation.
- ACTIVITY cell: autoContinues count on Observed, rendered
  "auto-continued Nx" via cli/readiness-format.ts + fleet ls.
- Ship tick: applyActivityVerdict already computes idle + prev-state edge;
  add an onIdleAutoContinue callback beside onStaleBackgroundShell.

## Storage (own narrow keyed port)
AUTO_CONTINUE_LAST_KEY (last nudge ISO), AUTO_CONTINUE_COUNT_KEY
{ nudgeCount, taskNumber } — rate limit + per-task cap.

## Tests
- Unit (vitest): decision fn — idle under 10min no; submitted yes; working
  yes; awaiting_merge/input_required/terminal no; modal/esc/input-box
  non-empty no; 20min rate-limit window; 6-cap escalation.
- DO-level (studio.do.test.ts style, Map fake): runShipTickWithObservation
  fires the callback on the idle-crossing tick only, gated by leadType and
  board state.

## Blast radius
Studio DO ship tick. Wrong = spurious nudges into an OSS lead pane, or missed
nudges. Confined to apps/fleet/src/studio/ + cli rendering. Worker-only, no
container/.