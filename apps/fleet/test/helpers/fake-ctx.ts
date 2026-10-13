// Board #746 (sweep-33 S33-F2): the fake ExecutionContext shape —
// waitUntil queues promises into a local array (it must NEVER await them:
// that is the entire point of ctx.waitUntil) plus a no-op
// passThroughOnException — hand-written in 8 suites in four near-identical
// variants (webhook-core, webhook-autoclose, exceptions, index,
// junior.usage, junior.route, llm.anthropic-route, glm-leadtype-persist-do).
// The helper owns ONLY that shape; swallow defaults to true because the
// majority variant attaches .catch(() => {}) so an unobserved rejection
// doesn't crash the suite, while the 2 webhook suites pass swallow:false —
// a rejecting queued task must stay observable through drain(). This file
// is a plain vitest-side module, NOT a bun:test fixture — no
// cloudflare:test import on purpose, so it loads under either runtime
// without workerd bindings (same precedent as helpers/fake-namespace.ts).
import { vi, type Mock } from "vitest";

/** Options for fakeCtx(): `drain` adds drain(): Promise.all(queued) for
 *  tests that must await the deferred phase; `swallow` attaches
 *  .catch(() => {}) to queued promises so unobserved rejections don't
 *  fail the suite (webhook suites pass false — a rejecting queued task
 *  must stay observable through drain()). */
export type FakeCtxOpts = { drain?: boolean; swallow?: boolean };

export type FakeCtx = ExecutionContext & {
  waitUntil: Mock<(p: Promise<unknown>) => void>;
  drain?: () => Promise<unknown[]>;
};

/** A fake Workers ExecutionContext whose waitUntil queues promises into a
 *  local array (never awaits — that's the point of ctx.waitUntil) and is a
 *  vi.fn spy so suites can assert call counts. drain(): Promise.all of
 *  everything queued so far. Cast out rather than fully implementing
 *  props/tracing — same precedent as the per-suite fakes this replaces
 *  (sweep 33 F2, board issue #746). */
export function fakeCtx(opts: FakeCtxOpts = {}): FakeCtx {
  const tasks: Promise<unknown>[] = [];
  const { drain = true, swallow = true } = opts;
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      tasks.push(p);
      if (swallow) p.catch(() => {});
    }),
    passThroughOnException: () => {},
    ...(drain ? { drain: () => Promise.all(tasks) } : {}),
  };
  return ctx as unknown as FakeCtx;
}
