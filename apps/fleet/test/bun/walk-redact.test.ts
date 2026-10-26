// apps/fleet/test/bun/walk-redact.test.ts
// #1348: storageState is a bearer credential. redact() is the one scrub every
// description passes through before it reaches evidence JSON or a log line.
import { describe, it, expect } from "bun:test";
import { redact } from "../../src/walk/redact";

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
