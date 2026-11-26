// apps/fleet/test/bun/llm-models.test.ts
// Pure model pool registry (Task 1) for the model pool design spec
// docs/superpowers/specs/2026-10-13-model-pool-design.md.
import { describe, test, expect } from "bun:test";
import { POOL, modelByKey, modelById } from "../../src/llm/models";
import { pickModels } from "../../src/llm/router";

describe("model pool registry", () => {
  test("has exactly glm, kimi, deepseek in that order", () => {
    expect(POOL.map((m) => m.key)).toEqual(["glm", "kimi", "deepseek"]);
  });
  test("every id starts with @cf/", () => {
    expect(POOL.every((m) => m.id.startsWith("@cf/"))).toBe(true);
  });
  test("ids are unique across the pool", () => {
    expect(new Set(POOL.map((m) => m.id)).size).toBe(POOL.length);
  });
  test("glm keeps today's id and 16000 max_tokens floor", () => {
    expect(modelByKey("glm")).toEqual({ key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: 16000, maxMaxTokens: 32000, smokePassed: true });
  });
  // Incident #717: a per-model ceiling on the SAME computed max_tokens the
  // floor above bounds — reasoning_content can push total output past
  // Claude Code's hard 64k output-token limit even when max_tokens was
  // requested far below that.
  test("every model has a maxMaxTokens ceiling above its own floor", () => {
    expect(POOL.every((m) => m.maxMaxTokens > m.minMaxTokens)).toBe(true);
  });
  test("lookups miss cleanly", () => {
    expect(modelByKey("gpt4")).toBeUndefined();
    expect(modelById("@cf/nope/nope")).toBeUndefined();
  });
});

// Issue #1476: CF retired kimi-k2.7-code and deepseek-v4-pro-0813, but the
// pool kept walking them as a demoted overflow tail (by design — see
// router.ts's own rank comment), so a studio still reached a dead id. The
// fix is catalog-only: repoint the ids. These guard against the old ids
// ever coming back, in the catalog itself and in the walk order a real
// studio request would see.
describe("model pool registry no longer serves the retired #1476 ids", () => {
  const RETIRED = ["@cf/moonshotai/kimi-k2.7-code", "@cf/deepseek-ai/deepseek-v4-pro-0813"];

  test("POOL carries neither retired id", () => {
    for (const id of RETIRED) expect(POOL.some((m) => m.id === id)).toBe(false);
  });

  test("pickModels never walks a retired id, even with every model demoted except glm", () => {
    const states = {
      [POOL[0].id]: "active",
      [POOL[1].id]: "demoted",
      [POOL[2].id]: "demoted",
    } as const;
    const pool = POOL.map((m) => ({ ...m, smokePassed: true }));
    const order = pickModels({
      studioId: "r--web-studio--1", requestedModel: "claude-opus-4", assigned: null,
      states, pool, poolOn: true, overflowOn: true,
    });
    for (const id of order) expect(RETIRED).not.toContain(id);
  });
});
