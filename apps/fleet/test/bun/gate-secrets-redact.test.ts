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

  it("redacts the lowercase-hex form (UTF-8 bytes as a plain lowercase hex string)", () => {
    const value = "sup3r-s3cret";
    const hex = [...new TextEncoder().encode(value)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const text = `raw bytes: ${hex}`;
    expect(redactKnownSecretValues(text, [value])).toBe("raw bytes: «redacted»");
  });

  it("redacts the lowercase percent-encoding form (hex digits a-f, unlike encodeURIComponent's A-F)", () => {
    const value = "sup3r s3cret/val";
    const lowerPct = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    const text = `GET /login?token=${lowerPct}`;
    expect(redactKnownSecretValues(text, [value])).toBe("GET /login?token=«redacted»");
  });
});

// #1346 security review r2: container/gate-server.ts's own 32k tail cut can
// land in the MIDDLE of a granted secret, leaving just its TRAILING fragment
// at the very START of the kept stdout/stderr -- a full-value match never
// finds a fragment shorter than the whole value.
describe("redactKnownSecretValues: leading partial from a mid-secret tail cut", () => {
  it("redacts a >=8-char trailing fragment of a secret sitting at the start of the text", () => {
    const value = "sup3r-s3cret-abcdefgh"; // 21 chars
    // Simulate the tail cut landing 13 chars into the secret: only the last
    // 8 chars of the value ("abcdefgh") survive, at position 0.
    const text = `${value.slice(13)} ... rest of stdout follows normally`;
    expect(redactKnownSecretValues(text, [value])).toBe("«redacted» ... rest of stdout follows normally");
  });

  it("finds the LONGEST qualifying fragment, not just the shortest 8-char match", () => {
    const value = "0123456789ABCDEF"; // 16 chars
    const text = "6789ABCDEF-trailing-text"; // the last 10 chars of value, at position 0
    expect(redactKnownSecretValues(text, [value])).toBe("«redacted»-trailing-text");
  });

  it("does NOT redact an overlap shorter than the 8-char threshold (avoids false positives)", () => {
    const value = "sup3r-s3cret-abcdefgh";
    const text = "efgh is just four letters, not a leak"; // only the last 4 chars of value
    expect(redactKnownSecretValues(text, [value])).toBe(text);
  });

  it("a text with no relationship to the secret is left alone", () => {
    const text = "all tests passed, no secrets printed";
    expect(redactKnownSecretValues(text, ["sup3r-s3cret-abcdefgh"])).toBe(text);
  });

  it("the full-result field-scoped path also catches the leading partial (end to end)", () => {
    const value = "sup3r-s3cret-abcdefgh";
    const result = { state: "failure" as const, stdout: `${value.slice(13)} trailing output` };
    const redacted = redactLegResultFields(result, [value]);
    expect(redacted.state).toBe("failure");
    expect(redacted.stdout).toBe("«redacted» trailing output");
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
