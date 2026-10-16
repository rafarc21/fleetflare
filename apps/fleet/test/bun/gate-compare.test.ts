// The compare API's file list (#1091 review round 2). A renamed file is listed
// by its new name only; its old name must join the list so a move out of a
// gated path still counts as a change to that path.
import { describe, it, expect } from "bun:test";
import { comparedFilePaths } from "../../src/github/api";

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
