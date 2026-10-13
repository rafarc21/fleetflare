// apps/fleet/test/bun/llm-router.test.ts
// Pure model picker for the non-Claude model pool (spec 2026-10-13-model-pool-design,
// Components 3) — no env/fetch, so ordering rules are tested with plain objects.
import { describe, expect, test } from "bun:test";
import { pickModels, isSmallModelName, defaultModelFor } from "../../src/llm/router";
import type { PoolModel } from "../../src/llm/models";

const P: PoolModel[] = [
  { key: "glm", id: "@cf/a/glm", minMaxTokens: 1, smokePassed: true },
  { key: "kimi", id: "@cf/b/kimi", minMaxTokens: 1, smokePassed: true },
  { key: "deepseek", id: "@cf/c/ds", minMaxTokens: 1, smokePassed: true },
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
    expect(pickModels({ ...base, poolOn: false, assigned: "@cf/b/kimi", states: { ...ALL } })).toEqual(["@cf/a/glm"]);
  });

  test("assigned main model first, then the rest in pool order", () => {
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...ALL } })).toEqual(["@cf/b/kimi", "@cf/a/glm", "@cf/c/ds"]);
  });

  test("small role: next active model after main goes first", () => {
    expect(pickModels({ ...base, requestedModel: "claude-haiku", assigned: "@cf/b/kimi", states: { ...ALL } }))
      .toEqual(["@cf/c/ds", "@cf/b/kimi", "@cf/a/glm"]);
  });

  test("unknown assigned id falls back to round-robin default", () => {
    const out = pickModels({ ...base, assigned: "@cf/typo/x", states: { ...ALL } });
    expect(out[0]).toBe(defaultModelFor(base.studioId, P, { ...ALL }));
    expect(out).toHaveLength(3);
  });

  test("overflow models after active; demoted last", () => {
    const states = { "@cf/a/glm": "demoted", "@cf/b/kimi": "overflow", "@cf/c/ds": "active" } as const;
    expect(pickModels({ ...base, assigned: null, states: { ...states } })).toEqual(["@cf/c/ds", "@cf/b/kimi", "@cf/a/glm"]);
  });

  test("assigned but demoted: not first", () => {
    const states = { "@cf/a/glm": "active", "@cf/b/kimi": "demoted", "@cf/c/ds": "active" } as const;
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...states } })[0]).not.toBe("@cf/b/kimi");
  });

  test("never empty even when everything is demoted", () => {
    const states = { "@cf/a/glm": "demoted", "@cf/b/kimi": "demoted", "@cf/c/ds": "demoted" } as const;
    expect(pickModels({ ...base, assigned: null, states: { ...states } }).length).toBe(3);
  });

  test("models with smokePassed false are excluded", () => {
    const pool = P.map((m) => (m.key === "kimi" ? { ...m, smokePassed: false } : m));
    expect(pickModels({ ...base, pool, assigned: "@cf/b/kimi", states: { ...ALL } })).not.toContain("@cf/b/kimi");
  });

  test("never throws and stays non-empty when nothing has smoke-passed", () => {
    const pool = P.map((m) => ({ ...m, smokePassed: false }));
    const out = pickModels({ ...base, pool, assigned: null, states: { ...ALL } });
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("defaultModelFor", () => {
  test("is stable per studio id and lands on an active model", () => {
    const a = defaultModelFor("x--web-studio--45", P, { ...ALL });
    expect(defaultModelFor("x--web-studio--45", P, { ...ALL })).toBe(a);
    expect(P.map((m) => m.id)).toContain(a);
  });
});
