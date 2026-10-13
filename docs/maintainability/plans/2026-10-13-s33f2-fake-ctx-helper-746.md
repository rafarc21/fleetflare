# S33-F2: fakeCtx() queue-drain fake — 8 suites → helpers/fake-ctx.ts (task #746, refs #733)

## Findings
8 vitest suites hand-roll a fake ExecutionContext: waitUntil queues promises into a tasks array, passThroughOnException no-op. Four variants exist; the two real semantic axes are (a) vi.fn spy vs plain function (suites asserting call counts need the spy), (b) drain() present or not. The 6 suites with .catch(() => {}) swallow unobserved rejections; the 2 webhook suites deliberately do NOT swallow (a rejecting queued task must be observable via drain()). Sites: test/github.webhook-core.test.ts:95, test/github.webhook-autoclose.test.ts:95, test/exceptions.test.ts:12, test/index.test.ts:57, test/junior.usage.test.ts:30, test/junior.route.test.ts:34, test/llm.anthropic-route.test.ts:32, test/studio.glm-leadtype-persist-do.test.ts:95.

## Design
One helper file test/helpers/fake-ctx.ts, one export, options object — mirrors fake-namespace.ts style (plain vitest-side module, no cloudflare:test import, so it loads under either runtime):

```ts
import { vi, type Mock } from "vitest";
export type FakeCtxOpts = { drain?: boolean; swallow?: boolean };
export type FakeCtx = ExecutionContext & {
  waitUntil: Mock<(p: Promise<unknown>) => void>;
  drain?: () => Promise<unknown[]>;
};
export function fakeCtx(opts: FakeCtxOpts = {}): FakeCtx {
  const tasks: Promise<unknown>[] = [];
  const { drain = true, swallow = true } = opts;
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { tasks.push(p); if (swallow) p.catch(() => {}); }),
    passThroughOnException: () => {},
    ...(drain ? { drain: () => Promise.all(tasks) } : {}),
  };
  return ctx as unknown as FakeCtx;
}
```

Per-site call: webhook-core/autoclose → fakeCtx({swallow:false}); exceptions/index → fakeCtx({drain:false}); junior.usage/junior.route/llm.anthropic-route → fakeCtx(); glm-leadtype-persist-do → fakeCtx({drain:false}) (its signature returns ExecutionContext — FakeCtx extends it, still assignable). Drain type note: drain?: — suites that use drain can keep `await ctx.drain()` because the type at those sites is FakeCtx (non-optional via a second type when needed — implementers' call: simplest is drain?: () => ... and non-null assert at call sites if strictness complains, prefer keeping call sites clean).

## Steps
1. Create test/helpers/fake-ctx.ts per above.
2. In each of the 8 suites: delete the local fakeCtx() block + its doc comment (keep ONE shorter comment pointing at the helper), add `import { fakeCtx } from "./helpers/fake-ctx";`, adjust `let ctx: ReturnType<typeof fakeCtx>` stays valid, keep any vi import still needed for other uses; remove `vi` from imports only if no other vi usage remains in the file.
3. TDD: this is a refactor of test code — the existing 8 suites are the test. Run them before and after; both must be green with zero assertion changes.
4. Update the census doc? No — census doc is committed already; do not touch.

## Verify
- cd apps/fleet && bun vitest run test/github.webhook-core.test.ts test/github.webhook-autoclose.test.ts test/exceptions.test.ts test/index.test.ts test/junior.usage.test.ts test/junior.route.test.ts test/llm.anthropic-route.test.ts test/studio.glm-leadtype-persist-do.test.ts — green before AND after.
- One heavy-gate rule: these vitest runs use pool-workers; do NOT run them alongside a vite build. Run the 8 suites in ONE vitest invocation.
- git grep -n "function fakeCtx" apps/fleet/test — must return 0 hits.
- bun run typecheck if the repo has it — check package.json scripts first; if typecheck exists run it once.

## Boundaries
Do NOT touch src/, container/, or any file outside apps/fleet/test/. Never modify test assertions' semantics — only the fake's construction. No test renames.
