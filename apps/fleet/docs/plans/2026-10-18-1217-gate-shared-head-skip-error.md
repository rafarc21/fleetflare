# Plan — task #1217: skip-path shared-head lookup error must post failure

Test-only follow-up from https://github.com/rafarc21/fleetflare/pull/1213 review. Branch `1211-gate-shared-head-guard`; no new PR, no merge.

## Root cause
`workflow.ts` runs the shared-head guard at TWO call sites. The verdict path's
error case is covered (`gate-workflow-precheck.test.ts` "a listing error that
never clears fails closed"), but the SKIP path's `.catch(() => SHARED_HEAD_LOOKUP_FAILED)`
(workflow.ts:187) has no test driving a lookup that throws. A mutant that swaps
that catch for a green `{ open: [] }` would post success on a lookup error and no
test would go red — the mutant survives.

## Change (test only, no production code)
Add one vitest to `apps/fleet/test/gate-workflow-precheck.test.ts`, modeled on the
existing verdict-path error test, driving the SKIP path (`fleetJson = FLEET_JSON`)
with `openPullsAlwaysThrows = true`:

- `out.state === "failure"`
- `out.description === "gate: cannot list shared-head PRs"` (config.ts `guardSuccessStatus`)
- the status POST body is `{ state: "failure", context: GATE_STATUS_CONTEXT, description: "gate: cannot list shared-head PRs" }`
- no `/run-leg` call (skip path never touches GATE_RUNNER)

Fixture setup (same as the existing skip-path shared-head test):
`commitMessage = "clean"`, `fleetJson = FLEET_JSON`, `titleFlipsOnRecheck = false`,
`e.FLEET_OPS_REPO = "acme/ops"`, `openPullsAlwaysThrows = true`. No `GATE_RUNNER` stub.

## Mutation proof (RED)
To prove the mutant dies, temporarily flip the skip-path catch to green and watch
the new test go red, then restore:

```ts
// workflow.ts:187 — MUTANT (do not commit)
.catch(() => ({ open: [] }));
```

Run the single test: fails with "expected failure, got success". Restore
`SHARED_HEAD_LOOKUP_FAILED`, re-run: passes.

## Verify
`npx vitest run test/gate-workflow-precheck.test.ts` (exit 0), then the full
task gate: `bun run check`, `bun run english-check`, `bun run test-lies-check`.