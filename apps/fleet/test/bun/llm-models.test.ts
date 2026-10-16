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
    expect(modelByKey("glm")).toEqual({ key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: 16000, maxMaxTokens: 32000, smokePassed: true, softCapTokens: 24000 });
  });
  // Issue #1099: the runaway soft cap must fire before the model's own ceiling
  // would, or it never does anything.
  test("every soft cap (issue #1099) sits below its model's maxMaxTokens ceiling", () => {
    for (const m of POOL) if (m.softCapTokens !== undefined) expect(m.softCapTokens).toBeLessThan(m.maxMaxTokens);
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
