# Gate runner robustness — infra retries, stale container, watch deadline

Issue: https://github.com/rafarc21/fleetflare/issues/1043
Refs #715 (gate runner), live-system audit. TDD, targeted tests only.

## Change

1. run-leg.ts + do.ts — infra failures get 503 so the Workflow step retries.
   `runLegInContainer` returns `LegOutcome` (`{kind:"result",result}` or
   `{kind:"infra",description}`) instead of a bare LegResult. Pure
   `legResponse(outcome)` maps infra -> 503 error body, result -> 200.
   do.ts answers 503 for infra, 200 for a real gate-server body.
2. run-leg.ts — if `c.running` before intercept/start (a Worker deploy reset
   the DO while the container survived), `await c.destroy()` first; else
   start() throws "already running".
3. cli/gate.ts `gate watch` — 45-min deadline. Pure `gateWatchDecision(status,
   elapsedMs)` returns terminal/continue/deadline; `onGateWatchDeadline(runId)`
   prints "gate watch: no verdict after 45 min (run <id>)" and exit 2.

## Files

- apps/fleet/src/gate/run-leg.ts (LegOutcome, legResponse, pre-start destroy)
- apps/fleet/src/gate/do.ts (legResponse wiring, 503/200)
- apps/fleet/cli/gate.ts (GATE_WATCH_DEADLINE_MS, gateWatchDecision, onGateWatchDeadline)
- apps/fleet/test/bun/gate-run-leg.test.ts (outcome shape, destroy-first, legResponse)
- apps/fleet/test/bun/cli-gate.test.ts (deadline decision + message/exit)

## Verify

- cd apps/fleet && bun install --frozen-lockfile
- bun test test/bun/gate-run-leg.test.ts test/bun/gate-leg-run.test.ts test/bun/cli-gate.test.ts
- bun run check  (tsc x5)
- bun run test-lies-check  (no tautological asserts)