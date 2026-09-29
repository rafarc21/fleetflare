import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/studio/redact";

// Issue #58 item 5: a rescue push's stderr now reaches the destroy/recycle
// 409 (#49). git with GIT_TRACE_CURL or a verbose helper can echo an
// `Authorization: Basic <base64 user:token>` header; that must never reach a
// 409, a row, or a log.
describe("redactSecrets — Authorization headers (issue #58)", () => {
  it("redacts Basic, any case, keeping the scheme word", () => {
    expect(redactSecrets("Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0")).toBe("Authorization: Basic «redacted»");
    expect(redactSecrets("> authorization: basic eC1hY2Nlc3M6c2VjcmV0 <")).toBe("> authorization: basic «redacted» <");
  });
  it("leaves prose alone: only the Authorization header's value", () => {
    expect(redactSecrets("basic auth failed for user x")).toBe("basic auth failed for user x");
  });
  it("still redacts Bearer", () => {
    expect(redactSecrets("Authorization: Bearer abc.def")).toBe("Authorization: Bearer «redacted»");
  });
});
