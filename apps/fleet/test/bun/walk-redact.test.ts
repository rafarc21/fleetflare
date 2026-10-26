// apps/fleet/test/bun/walk-redact.test.ts
// #1348: storageState is a bearer credential. redact() is the one scrub every
// description passes through before it reaches evidence JSON or a log line.
import { describe, it, expect } from "bun:test";
import { redact, redactValues } from "../../src/walk/redact";

describe("redact", () => {
  it("replaces an exact secret substring with a fixed marker", () => {
    expect(redact("upstream said sekret123 timed out", "sekret123")).toBe(
      "upstream said [REDACTED] timed out",
    );
  });

  it("replaces every occurrence, not just the first", () => {
    expect(redact("sekret123 then sekret123 again", "sekret123")).toBe(
      "[REDACTED] then [REDACTED] again",
    );
  });

  it("leaves text unchanged when the secret is absent", () => {
    expect(redact("plain error text", "sekret123")).toBe("plain error text");
  });

  it("leaves text unchanged when the secret is empty (no secret to scrub)", () => {
    expect(redact("plain error text", "")).toBe("plain error text");
  });

  it("passes through undefined text as undefined", () => {
    expect(redact(undefined, "sekret123")).toBeUndefined();
  });
});

// #1348 review r1 item 3: redact() alone only strips an EXACT whole-blob
// match. A probe against the old single-secret call site leaked 5 of 6
// vectors: the value re-encoded (JSON-escaped, URL-encoded, base64), a lone
// cookie value pulled out of the blob, and the value sitting inside a
// multi-line blob. redactValues() takes the list of individual secret
// values (one per cookie/localStorage entry — see storage-state.ts) and
// scrubs every encoding of each, independent of whatever text surrounds it.
describe("redactValues", () => {
  const SECRET = "cookie-secret-1";

  it("redacts the raw value", () => {
    expect(redactValues(`token=${SECRET} rejected`, [SECRET])).toBe("token=[REDACTED] rejected");
  });

  it("redacts the JSON-string-escaped form (a value containing a quote)", () => {
    const tricky = 'va"lue';
    const escaped = JSON.stringify(tricky).slice(1, -1); // va\"lue
    expect(redactValues(`body: "${escaped}"`, [tricky])).toBe('body: "[REDACTED]"');
  });

  it("redacts the URL-encoded form", () => {
    const withSpace = "a b/c";
    const encoded = encodeURIComponent(withSpace);
    expect(redactValues(`redirect?state=${encoded}`, [withSpace])).toBe("redirect?state=[REDACTED]");
  });

  it("redacts the base64 form", () => {
    const b64 = btoa(SECRET);
    expect(redactValues(`Authorization: Basic ${b64}`, [SECRET])).toBe("Authorization: Basic [REDACTED]");
  });

  it("redacts a lone value pulled out of a blob, not just the whole blob", () => {
    // the old call site redacted against the WHOLE storage-state JSON blob;
    // a single extracted cookie value never matched it.
    expect(redactValues(`cookie value leaked: ${SECRET}`, [SECRET])).toBe("cookie value leaked: [REDACTED]");
  });

  it("redacts a value even when the surrounding text is split across lines", () => {
    const multiline = `line one\n${SECRET}\nline three`;
    expect(redactValues(multiline, [SECRET])).toBe("line one\n[REDACTED]\nline three");
  });

  it("redacts every value in the list independently", () => {
    expect(redactValues("a=1 b=2", ["1", "2"])).toBe("a=[REDACTED] b=[REDACTED]");
  });

  it("skips empty values in the list without erasing unrelated text", () => {
    expect(redactValues("plain text", ["", SECRET])).toBe("plain text");
  });

  it("passes through undefined text as undefined", () => {
    expect(redactValues(undefined, [SECRET])).toBeUndefined();
  });
});
