import { describe, it, expect } from "vitest";
import { formatMemoryTable, MEMORY_LEGEND } from "../cli/memory-format";

describe("formatMemoryTable", () => {
  const rows = [
    { target: "websites--pilot/a.md", citations: 3, ageMs: 9 * 24 * 3600 * 1000, indexed: true, verdict: "promote" },
    { target: "websites--web-studio/bb.md", citations: 0, ageMs: null, indexed: false, verdict: "hold" },
  ];

  it("shows the two numbers a verdict rests on, beside the verdict", () => {
    const out = formatMemoryTable(rows);
    expect(out).toContain("CITED");
    expect(out).toMatch(/websites--pilot\/a\.md\s+3\s+9d\s+y\s+promote/);
    expect(out).toMatch(/websites--web-studio\/bb\.md\s+0\s+-\s+n\s+hold/);
  });

  it("says so rather than printing a bare header for an empty fleet", () => {
    expect(formatMemoryTable([])).toBe("(no memory files)");
  });

  it("the legend spells out that demote MOVES and never deletes", () => {
    expect(MEMORY_LEGEND).toMatch(/never deleted/);
    expect(MEMORY_LEGEND).toMatch(/archive/);
  });
});
