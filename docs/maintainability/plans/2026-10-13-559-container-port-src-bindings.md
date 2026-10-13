# #559 plan — CONTAINER_PORT per-site pin via vitest SRC bindings

Task: https://github.com/rafarc21/fleetflare/issues/559 (follow-up to merged PR https://github.com/rafarc21/fleetflare/pull/560, refs #514, sweep-14 §S14-F10).

## Problem

PR #560's import-edge pin is blind: `Bun.Transpiler.scanImports` returns import paths only, never named imports, so `apps/fleet/test/bun/container-port.test.ts` proves each DO keeps a runtime import edge but NOT that CONTAINER_PORT rides it. Revert `deploy/do.ts:212` to the `8080` literal and the suite stays green — the exact regression #514 exists to prevent. Per-site pins must read source text through vitest config bindings (the `TEST_STUDIO_DO_SRC`/`TEST_AGENT_DO_SRC` pattern), which also dodges the test-lies-check source-reading detector (config-side reads are exempt; test-file `readFileSync(join(..., "src/..."))` is flagged).

## Change

1. `apps/fleet/vitest.config.ts` — add `TEST_DEPLOY_DO_SRC` binding, same wiring as `agentsDoSrc` at :71/:193: read `src/deploy/do.ts` on Node side, bind under `bindings.TEST_DEPLOY_DO_SRC`. 2-4 line WHY comment (no task numbers).
2. `apps/fleet/test/env.d.ts` — add `TEST_DEPLOY_DO_SRC: string;` beside `TEST_AGENT_DO_SRC`.
3. New `apps/fleet/test/deploy-do-port.test.ts` (vitest, pool-workers) — source-slice pins, same `body(sig)` slice technique as `apps/fleet/test/agents.do.test.ts:332-348`:
   - agents DO (via existing `env.TEST_AGENT_DO_SRC`): class head `export class AgentDO extends Container<Env> {` contains `defaultPort = CONTAINER_PORT;`
   - deploy DO (via new `env.TEST_DEPLOY_DO_SRC`): class head `export class DeployDO extends Container<Env> {` contains `defaultPort = CONTAINER_PORT;`
   - deploy DO `/run` containerFetch: slice `async fetch(req: Request): Promise<Response> {` body, assert contains `CONTAINER_PORT,` inside the `containerFetch(` call
   - deploy DO pollDeploy: slice `async pollDeploy(_payload: { targetId: string }): Promise<void> {` body, assert contains `CONTAINER_PORT)`
   - zero surviving `8080` literals in both bound sources (`.includes("8080")` false on each)
4. `apps/fleet/test/bun/container-port.test.ts` — drop the import-edge describe (:48-62) + its Bun.Transpiler/readFileSync imports + AGENTS_DO/DEPLOY_DO path consts + the file-header paragraph about scanImports; keep the two ContainerRuntime behavioral tests. Update header comment to point the per-site pin at test/deploy-do-port.test.ts.

## Verification

RED first (binding missing → new test fails), then GREEN. Per command, real output captured:
- `cd apps/fleet && bun run test -- deploy-do-port.test.ts` exit 0
- `cd apps/fleet && bun test test/bun/container-port.test.ts` exit 0, 2 tests
- `cd apps/fleet && bun run test-lies-check` exit 0, 0 findings
- `cd apps/fleet && bun run english-check` exit 0
- Heavy `tsc`/`bun run check` NOT run here (CI owns it) — src/ untouched, test+config only.
