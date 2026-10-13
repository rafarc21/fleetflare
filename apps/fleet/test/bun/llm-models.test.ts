import { describe, it, expect } from "bun:test";
import { POOL, modelByKey, modelById } from "../../src/llm/models";

describe("model pool registry", () => {
  it("has exactly glm, kimi, deepseek in that order", () => {
    expect(POOL.map((m) => m.key)).toEqual(["glm", "kimi", "deepseek"]);
  });
  it("every id is a @cf/ Workers AI id and unique", () => {
    expect(POOL.every((m) => m.id.startsWith("@cf/"))).toBe(true);
    expect(new Set(POOL.map((m) => m.id)).size).toBe(POOL.length);
  });
  it("glm keeps today's id and 16000 max_tokens floor", () => {
    expect(modelByKey("glm")).toEqual({ key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: 16000, smokePassed: true });
  });
  it("lookups miss cleanly", () => {
    expect(modelByKey("gpt4")).toBeUndefined();
    expect(modelById("@cf/nope/nope")).toBeUndefined();
  });
});
