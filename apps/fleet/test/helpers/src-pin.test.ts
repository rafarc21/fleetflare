// Pins the shared src-pin helper's contract (sweep-43 F8, issue #885): the
// slice runs from a signature to the first following 2-space close, and BOTH
// failure modes assert — the end must be guarded because a missing delimiter
// makes `slice(start, -1)` hand back the whole file tail, and a `.toContain`
// pin built on that can never fail. Fixtures here are synthetic class-shaped
// text, deliberately not do.ts: this pins the SLICE behavior, not any one
// file's contents.
import { describe, it, expect } from "vitest";
import { methodBody } from "./src-pin";

const SRC = [
  "export class Fake {",
  "  async one(): Promise<void> {",
  "    await step();",
  "    const cb = (): number => {",
  "      return 1;",
  "    };",
  "    await done();",
  "  }",
  "",
  "  async two(): Promise<void> {",
  "    await other();",
  "  }",
  "}",
].join("\n");

describe("methodBody — the shared source-slice pin (sweep-43 F8, #885)", () => {
  it("slices from the signature to the method's own close", () => {
    const b = methodBody(SRC, "  async one(");
    expect(b.startsWith("  async one(): Promise<void> {")).toBe(true);
    expect(b.endsWith("await done();")).toBe(true);
    expect(b).toContain("await step();");
  });

  it("stops at the first close, so a later method is never in the slice", () => {
    expect(methodBody(SRC, "  async one(")).not.toContain("async two");
  });

  it("a nested closure closing at deeper indent does not end the slice — the delimiter needs exactly two spaces", () => {
    const b = methodBody(SRC, "  async one(");
    expect(b).toContain("return 1;");
    expect(b).toContain("await done();");
  });

  it("a 2-space `}` inside the body ends the slice early", () => {
    // This template literal's closing quote line starts with exactly two
    // spaces and a `}` — the delimiter the helper slices on.
    const early = [
      "export class Early {",
      "  async early(): Promise<void> {",
      "    return `template line",
      "  }`;",
      "    neverReached();",
      "  }",
      "}",
    ].join("\n");
    const b = methodBody(early, "  async early(");
    expect(b).toContain("template line");
    expect(b).not.toContain("neverReached();");
  });

  it("a signature not present fails", () => {
    // Only the missing-signature failure produces this message: `start` is
    // the only value that can stand on the right of "-1 to be greater than".
    expect(() => methodBody(SRC, "  async absent(")).toThrow(/expected -1 to be greater than -1/);
  });

  it("a signature present with no following 2-space close fails, rather than returning the file tail", () => {
    // The signature sits at index 0, so only this failure mode can produce
    // "-1 to be greater than 0" — the missing-signature case above always
    // says "greater than -1".
    const noClose = "async tail(): Promise<void> {\n    await x();\n}";
    expect(() => methodBody(noClose, "async tail(")).toThrow(/expected -1 to be greater than 0/);
  });
});
