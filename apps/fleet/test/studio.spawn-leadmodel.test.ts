// #717: readLeadTypeRequest's widened return shape — {leadType, model?}
// instead of a bare string — once "kimi"/"deepseek" joined "claude"/"glm" as
// accepted `--lead` values. See src/studio/spawn.ts's own doc comment for
// why the "claude" case omits `model` entirely rather than setting it to
// `undefined`. Same vitest convention as the rest of studio.spawn.test.ts
// (that file's own readLeadTypeRequest describe block covers the same
// function from the other direction — the old-string-shape pin, updated).
import { describe, it, expect } from "vitest";
import { readLeadTypeRequest } from "../src/studio/spawn";
import { POOL } from "../src/llm/models";

describe("readLeadTypeRequest pool keys", () => {
  it("kimi → glm-led with kimi model", () => {
    expect(readLeadTypeRequest({ leadType: "kimi" })).toEqual({ leadType: "glm", model: POOL[1].id });
  });
  it("deepseek → glm-led with deepseek model", () => {
    expect(readLeadTypeRequest({ leadType: "deepseek" })).toEqual({ leadType: "glm", model: POOL[2].id });
  });
  it("glm → glm-led with glm model", () => {
    expect(readLeadTypeRequest({ leadType: "glm" })).toEqual({ leadType: "glm", model: POOL[0].id });
  });
  it("claude → claude, no model", () => {
    expect(readLeadTypeRequest({ leadType: "claude" })).toEqual({ leadType: "claude" });
  });
  it("absent → undefined; gpt4 → null", () => {
    expect(readLeadTypeRequest({})).toBeUndefined();
    expect(readLeadTypeRequest({ leadType: "gpt4" })).toBeNull();
  });
});
