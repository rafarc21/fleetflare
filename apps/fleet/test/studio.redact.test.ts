import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/studio/redact";

// Issue #67: a rescue push's stderr reaches the destroy/recycle 409 (#49);
// a traced git can echo `Authorization: Basic <base64 user:token>`. The
// container's bringup_redact carries the same rule (test/bun/bringup-log).
describe("redactSecrets — Authorization: Basic (issue #67)", () => {
  it("redacts the value, any case, keeping the header as written", () => {
    expect(redactSecrets("Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0")).toBe("Authorization: Basic «redacted»");
    expect(redactSecrets("> authorization: basic eC1hY2Nlc3M6c2VjcmV0 <")).toBe("> authorization: basic «redacted» <");
  });
  it("leaves prose alone: only the header's value", () => {
    expect(redactSecrets("basic auth failed for user x")).toBe("basic auth failed for user x");
  });
  it("still redacts Bearer", () => {
    expect(redactSecrets("Authorization: Bearer abc.def")).toBe("Authorization: Bearer «redacted»");
  });
});
