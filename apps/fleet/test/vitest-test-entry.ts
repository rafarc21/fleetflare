// #1203: the vitest worker entrypoint (wrangler.test.jsonc's `main` under
// vitest — see vitest.config.ts). Test-only, like test-integration/dev-entry.ts:
// it re-exports every entrypoint class of src/index.ts and adds the one
// test-only Durable Object class GateRunnerStub, so the GATE_RUNNER binding can
// stand in for the real container-backed GateRunnerDO (which vitest-pool-workers
// cannot spawn). Nothing under src/ imports this file, and `wrangler deploy`
// never uses it — the deployed Worker's entrypoint stays src/index.ts.
//
// Each DO/workflow class a wrangler config names must be exported from the
// worker entrypoint (src/index.ts's own comments, Day 1 Task 4); vitest resolves
// them from `main`, so a test-only class needs this test-only entry to live in.
export { AgentDO } from "../src/agents/do";
export { DeployDO } from "../src/deploy/do";
export { StudioDO, StudioBigDO } from "../src/studio/do";
export { GateRunnerDO } from "../src/gate/do";
export { GateOutbound } from "../src/gate/outbound-entrypoint";
export { GateWorkflow } from "../src/gate/workflow";
export { GateRunnerStub } from "./helpers/gate-runner-stub";
export { default } from "../src/index";
