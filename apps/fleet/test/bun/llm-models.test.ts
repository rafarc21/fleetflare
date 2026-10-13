// apps/fleet/test/bun/llm-models.test.ts
// Pure model pool registry (Task 1) for the model pool design spec
// docs/superpowers/specs/2026-10-13-model-pool-design.md.
import { describe, test, expect } from "bun:test";
import { POOL, modelByKey, modelById } from "../../src/llm/models";

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
    expect(modelByKey("glm")).toEqual({ key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: 16000, smokePassed: true });
  });
  test("lookups miss cleanly", () => {
    expect(modelByKey("gpt4")).toBeUndefined();
    expect(modelById("@cf/nope/nope")).toBeUndefined();
  });
});
