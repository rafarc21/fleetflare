import { describe, it, expect } from "vitest";
import { encodeResize, parseFrame, resizeFrameFor } from "../src/studio/frames";

describe("frames", () => {
  it("resize round-trips", () => {
    const f = parseFrame(encodeResize(120, 40));
    expect(f).toEqual({ type: "resize", cols: 120, rows: 40 });
  });
  it("binary is data", () => {
    const f = parseFrame(new Uint8Array([27, 91, 65]).buffer);
    expect(f.type).toBe("data");
    expect([...(f as any).bytes]).toEqual([27, 91, 65]);
  });
  it("unknown text ignored", () => expect(parseFrame('{"t":"x"}')).toEqual({ type: "ignore" }));
  it("garbage text ignored", () => expect(parseFrame("not json")).toEqual({ type: "ignore" }));
  it("non-positive resize ignored", () => expect(parseFrame('{"t":"resize","cols":0,"rows":-1}')).toEqual({ type: "ignore" }));
});

// ---------------------------------------------------------------------------
// The size-declaration rule (issue #43)
//
// The pty is SHARED and opens at terminal.ts's DEFAULT_COLS = 80. It only ever
// changes size because a client sent this frame. MEASURED 2026-09-23: an `ff`
// with no tty sent `80x24` (cli/fleet.ts's old `process.stdout.columns ?? 80`)
// and pinned all four acme-os studios to 80 columns for hours, while the
// operator's own 180-column client rendered torn text around it.
//
// Only a client with a REAL TERMINAL declares a size. A client reading
// programmatically declares nothing — not a guessed default, nothing at all.

describe("resizeFrameFor — only a real terminal declares a size", () => {
  it("a real terminal declares its own size", () => {
    expect(resizeFrameFor({ isTTY: true, columns: 180, rows: 53 })).toBe(encodeResize(180, 53));
  });

  it("a client with no tty declares NOTHING — not a guessed 80x24", () => {
    expect(resizeFrameFor({ isTTY: false, columns: 180, rows: 53 })).toBeNull();
  });

  it("an absent isTTY is not a terminal either (a piped stdout reports undefined)", () => {
    expect(resizeFrameFor({})).toBeNull();
  });

  it("a tty that does not know its own size declares nothing rather than guessing", () => {
    expect(resizeFrameFor({ isTTY: true })).toBeNull();
    expect(resizeFrameFor({ isTTY: true, columns: 180 })).toBeNull();
    expect(resizeFrameFor({ isTTY: true, columns: 0, rows: 0 })).toBeNull();
  });

  it("a fractional or negative size is refused — the pty would take it literally", () => {
    expect(resizeFrameFor({ isTTY: true, columns: 180.5, rows: 53 })).toBeNull();
    expect(resizeFrameFor({ isTTY: true, columns: -180, rows: 53 })).toBeNull();
  });

  it("what it emits is a frame the server actually parses as a resize", () => {
    const frame = resizeFrameFor({ isTTY: true, columns: 180, rows: 53 });
    expect(frame).not.toBeNull();
    expect(parseFrame(frame!)).toEqual({ type: "resize", cols: 180, rows: 53 });
  });
});
