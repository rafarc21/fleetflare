// apps/fleet/test/bun/llm-router.test.ts
// Pure model picker for the non-Claude model pool (spec 2026-10-13-model-pool-design,
// Components 3) — no env/fetch, so ordering rules are tested with plain objects.
import { describe, expect, test } from "bun:test";
import { pickModels, isSmallModelName, defaultModelFor } from "../../src/llm/router";
import type { PoolModel } from "../../src/llm/models";

const P: PoolModel[] = [
  { key: "glm", id: "@cf/a/glm", minMaxTokens: 1, maxMaxTokens: 32000, smokePassed: true },
  { key: "kimi", id: "@cf/b/kimi", minMaxTokens: 1, maxMaxTokens: 32000, smokePassed: true },
  { key: "deepseek", id: "@cf/c/ds", minMaxTokens: 1, maxMaxTokens: 32000, smokePassed: true },
];
const ALL = { "@cf/a/glm": "active", "@cf/b/kimi": "active", "@cf/c/ds": "active" } as const;
const base = { studioId: "repo--web-studio--49", requestedModel: "claude-opus-4", pool: P, poolOn: true };

describe("isSmallModelName", () => {
  test("haiku-ish names are small", () => {
    expect(isSmallModelName("claude-3-5-haiku-latest")).toBe(true);
  });

  test("lead names are not small", () => {
    expect(isSmallModelName("claude-opus-4")).toBe(false);
  });

  test("absent/empty/non-string is lead role", () => {
    expect(isSmallModelName(undefined)).toBe(false);
    expect(isSmallModelName("")).toBe(false);
    expect(isSmallModelName(42)).toBe(false);
  });
});

describe("pickModels", () => {
  test("pool off: GLM only (pool[0])", () => {
    expect(pickModels({ ...base, poolOn: false, overflowOn: false, assigned: "@cf/b/kimi", states: { ...ALL } })).toEqual(["@cf/a/glm"]);
  });

  test("assigned main model first, then the rest in pool order", () => {
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...ALL }, overflowOn: true })).toEqual(["@cf/b/kimi", "@cf/a/glm", "@cf/c/ds"]);
  });

  test("small role: next active model after main goes first", () => {
    expect(pickModels({ ...base, requestedModel: "claude-haiku", assigned: "@cf/b/kimi", states: { ...ALL }, overflowOn: true }))
      .toEqual(["@cf/c/ds", "@cf/b/kimi", "@cf/a/glm"]);
  });

  test("unknown assigned id falls back to round-robin default", () => {
    const out = pickModels({ ...base, assigned: "@cf/typo/x", states: { ...ALL }, overflowOn: true });
    expect(out[0]).toBe(defaultModelFor(base.studioId, P, { ...ALL }));
    expect(out).toHaveLength(3);
  });

  test("overflow models after active; demoted last", () => {
    const states = { "@cf/a/glm": "demoted", "@cf/b/kimi": "overflow", "@cf/c/ds": "active" } as const;
    expect(pickModels({ ...base, assigned: null, states: { ...states }, overflowOn: true })).toEqual(["@cf/c/ds", "@cf/b/kimi", "@cf/a/glm"]);
  });

  test("assigned but demoted: not first", () => {
    const states = { "@cf/a/glm": "active", "@cf/b/kimi": "demoted", "@cf/c/ds": "active" } as const;
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...states }, overflowOn: true })[0]).not.toBe("@cf/b/kimi");
  });

  test("never empty even when everything is demoted", () => {
    const states = { "@cf/a/glm": "demoted", "@cf/b/kimi": "demoted", "@cf/c/ds": "demoted" } as const;
    expect(pickModels({ ...base, assigned: null, states: { ...states }, overflowOn: true }).length).toBe(3);
  });

  test("models with smokePassed false are excluded", () => {
    const pool = P.map((m) => (m.key === "kimi" ? { ...m, smokePassed: false } : m));
    expect(pickModels({ ...base, pool, assigned: "@cf/b/kimi", states: { ...ALL }, overflowOn: true })).not.toContain("@cf/b/kimi");
  });

  test("never throws and stays non-empty when nothing has smoke-passed", () => {
    const pool = P.map((m) => ({ ...m, smokePassed: false }));
    const out = pickModels({ ...base, pool, assigned: null, states: { ...ALL }, overflowOn: true });
    expect(out.length).toBeGreaterThan(0);
  });
});

// LEAD_MODEL_OVERFLOW=off (#768): each model has its own 20 rpm budget, so
// keeping a studio on its ONE assigned model spreads capacity across the pool.
describe("pickModels — overflow off (LEAD_MODEL_OVERFLOW=off, #768)", () => {
  test("overflow off + assigned kimi → kimi only, no overflow candidates", () => {
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...ALL }, overflowOn: false })).toEqual(["@cf/b/kimi"]);
  });

  test("overflow off + no assignment → defaultModelFor only", () => {
    expect(pickModels({ ...base, assigned: null, states: { ...ALL }, overflowOn: false })).toEqual([defaultModelFor(base.studioId, P, { ...ALL })]);
  });

  test("overflow off + unknown assigned id → defaultModelFor only", () => {
    expect(pickModels({ ...base, assigned: "@cf/typo/x", states: { ...ALL }, overflowOn: false })).toEqual([defaultModelFor(base.studioId, P, { ...ALL })]);
  });

  test("overflow off + assigned demoted → defaultModelFor only (demoted still respected)", () => {
    const states = { "@cf/a/glm": "active", "@cf/b/kimi": "demoted", "@cf/c/ds": "active" } as const;
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states, overflowOn: false })).toEqual([defaultModelFor(base.studioId, P, states)]);
  });

  test("overflow on unchanged — full order", () => {
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...ALL }, overflowOn: true })).toEqual(["@cf/b/kimi", "@cf/a/glm", "@cf/c/ds"]);
  });
});

describe("defaultModelFor", () => {
  test("is stable per studio id and lands on an active model", () => {
    const a = defaultModelFor("x--web-studio--45", P, { ...ALL });
    expect(defaultModelFor("x--web-studio--45", P, { ...ALL })).toBe(a);
    expect(P.map((m) => m.id)).toContain(a);
  });
});

// Issue #1099: after a runaway abort the studio's next call avoids that model
// (only when overflow is on, since overflow is what lets the retry move on).
describe("pickModels avoid (issue #1099)", () => {
  test("the avoided model is never first when overflow is on", () => {
    const order = pickModels({ ...base, assigned: "@cf/b/kimi", avoid: "@cf/b/kimi", states: { ...ALL }, overflowOn: true });
    expect(order[0]).not.toBe("@cf/b/kimi");
    expect(order).toContain("@cf/b/kimi");
    expect(order[order.length - 1]).toBe("@cf/b/kimi");
  });

  test("avoid is ignored when overflow is off (retry stays on the one model)", () => {
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", avoid: "@cf/b/kimi", states: { ...ALL }, overflowOn: false })).toEqual(["@cf/b/kimi"]);
  });

  test("avoid naming a model not in the candidate list changes nothing", () => {
    const without = pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...ALL }, overflowOn: true });
    const withStale = pickModels({ ...base, assigned: "@cf/b/kimi", avoid: "@cf/gone/model", states: { ...ALL }, overflowOn: true });
    expect(withStale).toEqual(without);
  });
});
