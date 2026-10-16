import { describe, it, expect } from "vitest";
import { parseCliArgs, renderHelp } from "../src/studio/cli-args";

// Board issue #1077, item 2: `fleet task message <n> "<text>"` exists in the
// in-container CLI (container/studio-fleet) and not in the local one. This is
// the local grammar, the same shape: an issue number, then the rest of argv as
// one text, so an unquoted multi-word message still reaches the lead whole.

describe("fleet task message — board issue #1077 (local CLI)", () => {
  it("takes an issue number and the rest of argv as one text", () => {
    expect(parseCliArgs(["task", "message", "12", "please", "rebase", "first"]))
      .toEqual({ cmd: "task-message", number: 12, text: "please rebase first" });
  });

  it("a quoted single argument is the text as typed", () => {
    expect(parseCliArgs(["task", "message", "12", "rebase first"]))
      .toEqual({ cmd: "task-message", number: 12, text: "rebase first" });
  });

  it("refuses a missing or non-numeric issue number", () => {
    expect(parseCliArgs(["task", "message"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "message", "abc", "hi"]).cmd).toBe("usage");
  });

  it("refuses a missing text, and a text that is only whitespace", () => {
    expect(parseCliArgs(["task", "message", "12"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "message", "12", "   "]).cmd).toBe("usage");
  });

  it("is listed in the help, so a maestro can find it", () => {
    expect(renderHelp()).toContain("message <n> <text>");
  });
});
