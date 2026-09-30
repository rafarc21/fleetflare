import { describe, it, expect } from "vitest";
import { extractPaths, findPathOverlaps, formatPathOverlapWarnings } from "../src/board/path-overlap";

// Board issue #112 / #70 ask 8: "task new warns when the brief's paths
// overlap files touched by open PRs / open tasks (a lightweight path-claim
// check)". Pure module, no I/O — see path-overlap.ts's own header for why.

describe("extractPaths", () => {
  it("pulls a single path-looking token out of free text", () => {
    expect(extractPaths("touches apps/fleet/src/board/board.ts directly"))
      .toEqual(["apps/fleet/src/board/board.ts"]);
  });

  it("dedupes a path mentioned more than once", () => {
    expect(extractPaths(
      "edits apps/fleet/src/board/board.ts, then apps/fleet/src/board/board.ts again",
    )).toEqual(["apps/fleet/src/board/board.ts"]);
  });

  it("extracts every distinct path in the text", () => {
    const paths = extractPaths(
      "changes apps/fleet/src/board/board.ts and apps/fleet/src/board/routes.ts",
    );
    expect(paths).toContain("apps/fleet/src/board/board.ts");
    expect(paths).toContain("apps/fleet/src/board/routes.ts");
    expect(paths).toHaveLength(2);
  });

  it("returns [] for prose with no path-looking text at all", () => {
    expect(extractPaths("Add a caching layer for repeated database queries.")).toEqual([]);
  });

  it("trims trailing sentence punctuation off an extracted path", () => {
    expect(extractPaths("See apps/fleet/src/board/board.ts.")).toEqual(["apps/fleet/src/board/board.ts"]);
    expect(extractPaths("(read apps/fleet/src/board/board.ts)")).toEqual(["apps/fleet/src/board/board.ts"]);
  });

  it("requires at least one slash — a bare filename is not a path claim", () => {
    expect(extractPaths("rename board.ts to boardv2.ts")).toEqual([]);
  });
});

describe("findPathOverlaps", () => {
  it("reports a brief path that also appears in an open PR's changed files", () => {
    const overlaps = findPathOverlaps(
      ["apps/fleet/src/board/board.ts"],
      [{ number: 245, files: ["apps/fleet/src/board/board.ts", "apps/fleet/src/board/routes.ts"] }],
      [],
    );
    expect(overlaps).toEqual([{ path: "apps/fleet/src/board/board.ts", prs: [245], tasks: [] }]);
  });

  it("reports a brief path that also appears in another open task's claimed paths", () => {
    const overlaps = findPathOverlaps(
      ["apps/fleet/src/board/board.ts"],
      [],
      [{ number: 201, paths: ["apps/fleet/src/board/board.ts"] }],
    );
    expect(overlaps).toEqual([{ path: "apps/fleet/src/board/board.ts", prs: [], tasks: [201] }]);
  });

  it("names every PR and every task that overlaps the same path", () => {
    const overlaps = findPathOverlaps(
      ["apps/fleet/src/board/board.ts"],
      [{ number: 245, files: ["apps/fleet/src/board/board.ts"] }],
      [{ number: 201, paths: ["apps/fleet/src/board/board.ts"] }],
    );
    expect(overlaps).toEqual([{ path: "apps/fleet/src/board/board.ts", prs: [245], tasks: [201] }]);
  });

  it("returns [] when nothing in the brief's paths overlaps anything claimed", () => {
    const overlaps = findPathOverlaps(
      ["apps/fleet/src/board/board.ts"],
      [{ number: 245, files: ["apps/fleet/src/studio/do.ts"] }],
      [{ number: 201, paths: ["apps/fleet/src/studio/repo.ts"] }],
    );
    expect(overlaps).toEqual([]);
  });

  it("is an exact-string match only — a PR touching a sibling path is not an overlap", () => {
    const overlaps = findPathOverlaps(
      ["apps/fleet/src/board"],
      [{ number: 245, files: ["apps/fleet/src/board/board.ts"] }],
      [],
    );
    expect(overlaps).toEqual([]);
  });
});

describe("formatPathOverlapWarnings", () => {
  it("formats a single PR-only overlap", () => {
    const lines = formatPathOverlapWarnings([{ path: "apps/fleet/src/board/board.ts", prs: [245], tasks: [] }]);
    expect(lines).toEqual(["path claim overlap: apps/fleet/src/board/board.ts also touched by PR #245"]);
  });

  it("formats a single task-only overlap", () => {
    const lines = formatPathOverlapWarnings([{ path: "apps/fleet/src/board/board.ts", prs: [], tasks: [201] }]);
    expect(lines).toEqual(["path claim overlap: apps/fleet/src/board/board.ts also touched by task #201"]);
  });

  it("names both PR and task on a combined overlap", () => {
    const lines = formatPathOverlapWarnings([{ path: "apps/fleet/src/board/board.ts", prs: [245], tasks: [201] }]);
    expect(lines).toEqual([
      "path claim overlap: apps/fleet/src/board/board.ts also touched by PR #245 and task #201",
    ]);
  });

  it("one line per overlapping path, in order", () => {
    const lines = formatPathOverlapWarnings([
      { path: "apps/fleet/src/board/board.ts", prs: [245], tasks: [] },
      { path: "apps/fleet/src/board/routes.ts", prs: [], tasks: [201] },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("apps/fleet/src/board/board.ts");
    expect(lines[1]).toContain("apps/fleet/src/board/routes.ts");
  });
});
