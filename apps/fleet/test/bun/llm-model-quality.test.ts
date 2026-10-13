// apps/fleet/test/bun/llm-model-quality.test.ts
// Pure per-model quality stats + demote rule (spec 2026-10-13-model-pool-design,
// Quality) — no env/fetch, so the rule is tested with plain PrOutcome fixtures.
// The 5-PR minimum in shouldDemote is a deliberate guard: a brand-new model
// must not be demoted off a single bad PR or two, before it has had a real
// sample of closed work to judge.
import { describe, expect, test } from "bun:test";
import { modelStats, shouldDemote, statsTable, type PrOutcome } from "../../src/llm/model-quality";

const pr = (model: string, i: number, over: Partial<PrOutcome> = {}): PrOutcome =>
  ({ model, closedAt: i, firstCiPassed: true, bounced: false, reverted: false, ...over });

describe("model quality", () => {
  test("uses the newest 10 PRs per model", () => {
    const o = [...Array.from({ length: 12 }, (_, i) => pr("a", i, { firstCiPassed: i >= 2 }))];
    expect(modelStats(o)[0]).toMatchObject({ model: "a", prs: 10, firstCiPassRate: 1 });
  });

  test("demotes a model 25+ points below best first-try rate", () => {
    const o = [...Array.from({ length: 10 }, (_, i) => pr("a", i)), ...Array.from({ length: 10 }, (_, i) => pr("b", i, { firstCiPassed: i < 7 }))];
    expect(shouldDemote(modelStats(o))).toEqual(["b"]);
  });

  test("does not demote at 24 points; does at 25", () => {
    const s = (b: number) => [
      { model: "a", prs: 10, firstCiPassRate: 1, bounces: 0, reverts: 0 },
      { model: "b", prs: 10, firstCiPassRate: b, bounces: 0, reverts: 0 },
    ];
    expect(shouldDemote(s(0.76))).toEqual([]);
    expect(shouldDemote(s(0.75))).toEqual(["b"]);
  });

  test("demotes on 2 reverts regardless of rate", () => {
    const o = Array.from({ length: 10 }, (_, i) => pr("c", i, { reverted: i < 2 }));
    expect(shouldDemote(modelStats(o))).toEqual(["c"]);
  });

  test("models with fewer than 5 PRs are never demoted", () => {
    const o = [...Array.from({ length: 10 }, (_, i) => pr("a", i)), ...Array.from({ length: 4 }, (_, i) => pr("b", i, { firstCiPassed: false }))];
    expect(shouldDemote(modelStats(o))).toEqual([]);
  });

  test("table has one row per model", () => {
    expect(statsTable(modelStats([pr("a", 1), pr("b", 1)])).split("\n").filter((l) => l.startsWith("| a") || l.startsWith("| b"))).toHaveLength(2);
  });
});
