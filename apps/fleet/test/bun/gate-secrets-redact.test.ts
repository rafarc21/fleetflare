// #1346: exact-value redaction of a leg's own granted secrets, before its
// result body reaches R2.
import { describe, it, expect } from "bun:test";
import { redactKnownSecretValues } from "../../src/gate/secrets-redact";

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
