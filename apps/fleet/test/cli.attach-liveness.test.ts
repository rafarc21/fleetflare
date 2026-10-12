import { describe, expect, it } from "vitest";
import { attachTitle, attachTitleState, hhmmssZ, titleSequence } from "../cli/attach-liveness";

describe("attachTitleState (S11-F9)", () => {
  it("round-trips waiting: the title attachTitle writes for waiting reads back as waiting", () => {
    expect(attachTitleState("a--b", attachTitle("a--b", "waiting"))).toBe("waiting");
  });

  it("round-trips live", () => {
    expect(attachTitleState("a--b", attachTitle("a--b", "live"))).toBe("live");
  });

  it("round-trips stale: a real since/now pair reads back as stale", () => {
    const since = Date.parse("2026-09-24T17:50:00.400Z");
    expect(attachTitleState("a--b", attachTitle("a--b", { since, now: since + 95_000 }))).toBe("stale");
  });

  it("fails closed on a reworded prefix: a capitalized Fleet is not this studio's title", () => {
    expect(attachTitleState("a--b", "Fleet a--b · live")).toBe(null);
  });

  it("fails closed on another studio's title", () => {
    expect(attachTitleState("a--b", attachTitle("c--d", "live"))).toBe(null);
  });

  it("fails closed on no title (undefined)", () => {
    expect(attachTitleState("a--b", undefined)).toBe(null);
  });
});

describe("titleSequence (S11-F9)", () => {
  it("wraps the title in OSC 0 + BEL, exact bytes", () => {
    expect(titleSequence("fleet a--b · live")).toBe("\x1b]0;fleet a--b · live\x07");
  });
});

describe("hhmmssZ (S11-F9)", () => {
  it("zero is 00:00:00Z", () => {
    expect(hhmmssZ(0)).toBe("00:00:00Z");
  });

  it("a known epoch slices to the UTC clock, milliseconds truncated", () => {
    expect(hhmmssZ(Date.parse("2026-09-24T17:50:00.400Z"))).toBe("17:50:00Z");
  });
});
