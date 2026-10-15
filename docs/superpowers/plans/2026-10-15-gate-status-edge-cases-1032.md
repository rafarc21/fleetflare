# Plan — gate status edge cases (fixes for #715 audit, issue #1032)

Four bugs, TDD, one PR. Touch only: apps/fleet/src/gate/routes.ts, apps/fleet/src/gate/fanout.ts, apps/fleet/cli/gate.ts, root fleet.json, their tests. Never workflow.ts, run-leg.ts, do.ts, gate-server.ts (other open PRs own those).

## Items

1. routes.ts status: workflow skip output `{skipped, statusPostFailed}` has no `state` — currently maps to error/exit 2 while GitHub already got success. Map `skipped` → `{state:"success", description:"skipped: <reason>", statusPostFailed}`. Test: gate-routes.test.ts (vitest), skipped-output case.
2. fanout.ts verdictToStatusArgs: GitHub commit-status description over 140 chars → HTTP 422, no verdict posted. Cap description at 140. Test: gate-workflow-verdict.test.ts (bun), long-description case.
3. root fleet.json gate.pathRules: add "gates/**" and "fleet.json" (vitest.config.ts + bringup gates read them; gates-only PR got false green with zero legs). Test: gate-config.test.ts (bun), shipped-fleet.json pathRules pin.
4. cli/gate.ts cmdGateWatch poll: `res.json()` unguarded — non-JSON reply (Cloudflare 500 HTML) throws, dispatcher reads exit 1 = RED. Extract `parseStatusResponse(text)`: on non-JSON, print first 200 chars of body, exit 2, never 1. Test: cli-gate.test.ts (bun), non-JSON case.

## Verification

`cd apps/fleet && bun install --frozen-lockfile`; only touched tests (`bun test test/bun/gate-*.test.ts`, plus vitest `gate-routes.test.ts`); `bunx tsc --noEmit`; `bun run test-lies-check`. One gate at a time. No closing keywords. refs #715.
