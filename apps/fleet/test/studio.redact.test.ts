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

// Operator fix-first review on PR #198 (issue #188): four more secret
// shapes found during that review's read of this Worker-wide util — each
// helps every caller of redactSecrets (studio status responses included),
// not just the exceptions feature that prompted the read.
describe("redactSecrets — JWT (operator review, PR #198)", () => {
  it("redacts a three-segment eyJ... JWT, keeping surrounding prose", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactSecrets(`token was ${jwt} in the header`)).toBe("token was «redacted» in the header");
  });
});

describe("redactSecrets — Telegram bot token (operator review, PR #198)", () => {
  it("redacts digits:35-char-token, Telegram's own documented shape", () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw5";
    expect(redactSecrets(`sendCard failed for ${token}`)).toBe("sendCard failed for «redacted»");
  });
});

describe("redactSecrets — PEM private key block (operator review, PR #198)", () => {
  it("redacts a full multiline PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\nmore base64 lines\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`leaked key:\n${pem}\nend of output`)).toBe("leaked key:\n«redacted»\nend of output");
  });
});

describe("redactSecrets — token=/key= query-string values (operator review, PR #198)", () => {
  it("redacts the value, keeping the param name, for token=", () => {
    expect(redactSecrets("GET /webhook?token=abc123&x=1")).toBe("GET /webhook?token=«redacted»&x=1");
  });
  it("redacts the value, keeping the param name, for key=, any case, &-prefixed", () => {
    expect(redactSecrets("curl 'https://x/y&KEY=super-secret-value'")).toBe("curl 'https://x/y&KEY=«redacted»'");
  });
});
