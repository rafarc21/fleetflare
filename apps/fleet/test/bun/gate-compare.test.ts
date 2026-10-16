// The compare API's file list (#1091 review round 2). A renamed file is listed
// by its new name only; its old name must join the list so a move out of a
// gated path still counts as a change to that path.
import { describe, it, expect } from "bun:test";
import { comparedFilePaths, compareSummary } from "../../src/github/api";

describe("comparedFilePaths", () => {
  it("keeps the new name of a plain change", () => {
    expect(comparedFilePaths([{ filename: "src/a.ts" }])).toEqual(["src/a.ts"]);
  });
  it("keeps the old name of a rename too, so moving a file out of a gated path is seen", () => {
    expect(comparedFilePaths([{ filename: "docs/fleet.json", previous_filename: "fleet.json" }]))
      .toEqual(["docs/fleet.json", "fleet.json"]);
  });
  it("empty for a compare with no files", () => {
    expect(comparedFilePaths(undefined)).toEqual([]);
    expect(comparedFilePaths([])).toEqual([]);
  });
});

// #1095 round 3: the compare response names the merge-base, and a list cut at
// GitHub's 300-file cap is flagged truncated.
describe("compareSummary (#1095 round 3)", () => {
  const MB = "m".repeat(40);
  it("returns the merge-base sha GitHub names for the compare", () => {
    expect(compareSummary({ ahead_by: 1, merge_base_commit: { sha: MB }, files: [] }).mergeBaseSha).toBe(MB);
  });
  it("truncated when the compare lists exactly 300 files", () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.md` }));
    expect(compareSummary({ ahead_by: 1, merge_base_commit: { sha: MB }, files }).truncated).toBe(true);
  });
  it("not truncated below 300 files", () => {
    const files = Array.from({ length: 299 }, (_, i) => ({ filename: `f${i}.md` }));
    expect(compareSummary({ ahead_by: 1, merge_base_commit: { sha: MB }, files }).truncated).toBe(false);
  });
  it("truncation counts listed files, not paths: a rename's old name does not tip it over", () => {
    const files: { filename: string; previous_filename?: string }[] = Array.from({ length: 299 }, (_, i) => ({ filename: `f${i}.md` }));
    files[0] = { filename: "new.md", previous_filename: "old.md" };
    expect(compareSummary({ ahead_by: 1, merge_base_commit: { sha: MB }, files }).truncated).toBe(false);
  });
});
