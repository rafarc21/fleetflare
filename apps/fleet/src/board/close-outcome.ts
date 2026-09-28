// Board issue #157: `CloseOutcome` on its own, with zero imports of its
// own, on purpose. `close-action.ts` (this type's real home, re-exported
// from there too) imports `Env`, which imports the Durable Object classes
// (`AgentDO`/`DeployDO`/`StudioDO`) for their namespace generics — fine for
// every caller that already type-checks against `@cloudflare/workers-types`,
// but `src/studio/task-reap.ts` is a PURE orchestrator also reachable from
// `cli/fleet.ts`, which type-checks under its own tsconfig (`types: ["bun"]`,
// no workers-types at all — see cli/tsconfig.json's own comment). A plain
// `import type { CloseOutcome } from "./close-action"` there still forces
// tsc to resolve close-action.ts's own imports to type-check the file it
// came from, dragging the whole Durable Object graph into the cli/
// test-integration/ test/bun projects and breaking them on
// `D1Database`/`ctx`/`env` names that only exist under workers-types. This
// leaf file is what task-reap.ts actually imports instead.
export type CloseOutcome = "closed" | "already-closed" | "no-op";
