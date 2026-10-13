// Daily cron glue for #717's model pool quality pass (spec 2026-10-13-
// model-pool-design, Task 6) — runDailyModelQuality is DI'd over
// {collect, post, now} so the once-per-day guard and demote logic are
// testable without a live GitHub call (collectOutcomes itself is exercised
// only by the Worker's real cron, never here). Same cloudflare:test
// convention as test/llm.model-store.test.ts.
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { runDailyModelQuality } from "../src/llm/model-quality-cron";
import { getModelStates } from "../src/llm/model-store";
import { POOL } from "../src/llm/models";

const outcomes = [
  ...Array.from({ length: 10 }, (_, i) => ({ model: POOL[0].id, closedAt: i, firstCiPassed: true, bounced: false, reverted: false })),
  ...Array.from({ length: 10 }, (_, i) => ({ model: POOL[2].id, closedAt: i, firstCiPassed: i < 5, bounced: false, reverted: false })),
];

describe("daily model quality", () => {
  it("demotes once per day, posts table", async () => {
    const post = vi.fn(async () => {});
    const e = { ...env, LEAD_MODEL_POOL: "on", MODEL_QUALITY_ISSUE: "1" };
    await runDailyModelQuality(e as any, { collect: async () => outcomes, post, now: Date.UTC(2026, 9, 14, 6) });
    await runDailyModelQuality(e as any, { collect: async () => outcomes, post, now: Date.UTC(2026, 9, 14, 7) });
    expect(post).toHaveBeenCalledTimes(1);
    expect((await getModelStates(env.DB))[POOL[2].id]).toBe("demoted");
  });

  it("pool off: no-op", async () => {
    const post = vi.fn(async () => {});
    await runDailyModelQuality({ ...env, LEAD_MODEL_POOL: "off" } as any, { collect: async () => outcomes, post, now: Date.UTC(2026, 9, 15, 6) });
    expect(post).not.toHaveBeenCalled();
  });

  // Finding 4 (#717 review): posting is conditional on MODEL_QUALITY_ISSUE,
  // but demotion must still happen when posting is skipped — unverified
  // before this test. A separate outcomes fixture (demoting POOL[1], which
  // the test above never touches) keeps this assertion attributable to this
  // test's own call rather than state the earlier test already left behind.
  it("pool on, MODEL_QUALITY_ISSUE unset: demotes without ever calling post", async () => {
    const post = vi.fn(async () => {});
    const outcomesNoIssue = [
      ...Array.from({ length: 10 }, (_, i) => ({ model: POOL[0].id, closedAt: i, firstCiPassed: true, bounced: false, reverted: false })),
      ...Array.from({ length: 10 }, (_, i) => ({ model: POOL[1].id, closedAt: i, firstCiPassed: false, bounced: false, reverted: false })),
    ];
    const e = { ...env, LEAD_MODEL_POOL: "on", MODEL_QUALITY_ISSUE: undefined };
    await runDailyModelQuality(e as any, { collect: async () => outcomesNoIssue, post, now: Date.UTC(2026, 9, 16, 6) });
    expect(post).not.toHaveBeenCalled();
    expect((await getModelStates(env.DB))[POOL[1].id]).toBe("demoted");
  });
});
