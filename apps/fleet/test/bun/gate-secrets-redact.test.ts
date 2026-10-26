// #1346: exact-value redaction of a leg's own granted secrets, before its
// result body reaches R2 or a Workflow step's own return value.
import { describe, it, expect } from "bun:test";
import { redactKnownSecretValues, redactLegResultFields } from "../../src/gate/secrets-redact";

describe("redactKnownSecretValues", () => {
  it("replaces every occurrence of a known value", () => {
    const text = 'env dump: GATE_SECRET_STAGING_LOGIN="sup3r-s3cret" ... retry with sup3r-s3cret again';
    expect(redactKnownSecretValues(text, ["sup3r-s3cret"])).toBe(
      'env dump: GATE_SECRET_STAGING_LOGIN="«redacted»" ... retry with «redacted» again',
    );
  });

  it("leaves text with no known value untouched", () => {
    const text = "all tests passed, no secrets printed";
    expect(redactKnownSecretValues(text, ["sup3r-s3cret"])).toBe(text);
  });

  it("an UNgranted value (not passed in) is left alone -- this is exact-value, not a blanket wipe", () => {
    const text = "leaked: some-other-leg-secret-value";
    expect(redactKnownSecretValues(text, ["sup3r-s3cret"])).toBe(text);
  });

  it("redacts several distinct granted values in the same text", () => {
    const text = "login=alpha123 token=bravo456";
    expect(redactKnownSecretValues(text, ["alpha123", "bravo456"])).toBe("login=«redacted» token=«redacted»");
  });

  it("an empty values list changes nothing", () => {
    const text = "nothing to redact here";
    expect(redactKnownSecretValues(text, [])).toBe(text);
  });

  it("an empty-string value in the list is skipped, never redacts every character boundary", () => {
    const text = "abc";
    expect(redactKnownSecretValues(text, [""])).toBe("abc");
  });
});

// #1346 security review r1 item 4: a secret can reach a leg's own output
// already encoded by the test/script that printed it.
describe("redactKnownSecretValues: common encodings", () => {
  it("redacts the base64 and base64url forms of a granted value", () => {
    const value = "sup3r-s3cret!!";
    const b64 = btoa(value);
    const text = `Authorization: Basic ${b64}`;
    expect(redactKnownSecretValues(text, [value])).toBe("Authorization: Basic «redacted»");
  });

  it("redacts the URL-encoded form of a granted value", () => {
    const value = "sup3r s3cret/val";
    const text = `GET /login?token=${encodeURIComponent(value)}`;
    expect(redactKnownSecretValues(text, [value])).toBe("GET /login?token=«redacted»");
  });

  it("redacts the JSON-escaped form of a granted value (one containing a quote)", () => {
    const value = 'sup3r"s3cret';
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    const text = `embedded: ${jsonEscaped}`;
    expect(redactKnownSecretValues(text, [value])).toBe("embedded: «redacted»");
  });
});

// #1346 correctness review r1 item 3: a short/common granted value must never
// corrupt a structural field (state) by matching it as plain text would.
describe("redactLegResultFields: field-scoped, never touches `state`", () => {
  it("redacts description and summary, leaves state untouched even when the value equals state's own text", () => {
    const result = { state: "success" as const, description: "login as success failed", summary: "1 fail (success)" };
    const redacted = redactLegResultFields(result, ["success"]);
    expect(redacted.state).toBe("success");
    expect(redacted.description).toBe("login as «redacted» failed");
    expect(redacted.summary).toBe("1 fail («redacted»)");
  });

  it("redacts stdout and stderr too, when present", () => {
    const result = { state: "failure" as const, stdout: "token=abc123", stderr: "auth failed: abc123" };
    const redacted = redactLegResultFields(result, ["abc123"]);
    expect(redacted.stdout).toBe("token=«redacted»");
    expect(redacted.stderr).toBe("auth failed: «redacted»");
  });

  it("an empty values list returns the exact same object reference, no copy made", () => {
    const result = { state: "success" as const, description: "fine" };
    expect(redactLegResultFields(result, [])).toBe(result);
  });

  it("leaves a field absent from the result absent in the output", () => {
    const result: { state: "success"; description?: string } = { state: "success" };
    const redacted = redactLegResultFields(result, ["sup3r-s3cret"]);
    expect(Object.hasOwn(redacted, "description")).toBe(false);
    expect(Object.hasOwn(redacted, "summary")).toBe(false);
  });
});
