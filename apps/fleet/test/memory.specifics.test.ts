import { describe, it, expect } from "vitest";
import { extractSpecifics, missingSpecifics } from "../src/memory/specifics";

describe("extractSpecifics — numbers, names, commands, dates survive verbatim (spec §9)", () => {
  const cases: [string, string[]][] = [
    ["bump rollout_step_percentage to 100", ["rollout_step_percentage", "100"]],
    ["measured 2026-08-27", ["2026-08-27"]],
    ["run `wrangler deploy --keep-vars`", ["wrangler deploy --keep-vars"]],
    ["pass --dry-run first", ["--dry-run"]],
    ["the VERSION column lies", ["VERSION"]],
    ["edit src/studio/do.ts", ["src/studio/do.ts"]],
    ["AOV fell 21%", ["AOV", "21%"]],
    ["workerd 1.20260310.1 lacks it", ["1.20260310.1"]],
  ];
  for (const [text, expected] of cases) {
    it(`keeps ${JSON.stringify(expected)} out of ${JSON.stringify(text)}`, () => {
      for (const s of expected) expect(extractSpecifics(text)).toContain(s);
    });
  }

  it("ignores ordinary prose — a rule that flags every word refuses every merge", () => {
    expect(extractSpecifics("the studio came up and the lead did the work")).toEqual([]);
  });

  // The honest boundary of a mechanical check: a bare lowercase word with no
  // digit, dot, slash or underscore is indistinguishable from prose, so
  // "workerd" alone is NOT protected — the version beside it is.
  it("does not claim to protect a bare lowercase name", () => {
    expect(extractSpecifics("workerd 1.20260310.1")).toEqual(["1.20260310.1", "20260310"]);
  });

  it("dedupes", () => {
    expect(extractSpecifics("100 and 100 again")).toEqual(["100"]);
  });
});

describe("missingSpecifics — the compaction check, by diff", () => {
  it("a merge that keeps every specific passes", () => {
    const before = "bump rollout_step_percentage to 100; the VERSION column lies";
    const after = "CF rollout: rollout_step_percentage 100, VERSION column lies";
    expect(missingSpecifics(before, after)).toEqual([]);
  });

  it("a merge that dissolves the exact flag into a summary is caught", () => {
    const before = "deploy with `wrangler deploy --keep-vars`, else vars are wiped";
    const after = "deploy carefully or vars are wiped";
    expect(missingSpecifics(before, after)).toContain("wrangler deploy --keep-vars");
  });

  it("a merge that drops the number is caught", () => {
    expect(missingSpecifics("rollout_step_percentage:100", "set the rollout percentage")).toContain("100");
  });

  it("prose around a specific may go — only the specific itself must survive", () => {
    expect(missingSpecifics("you should probably remember that port 41730 is the audit site", "port 41730")).toEqual([]);
  });

  it("is case sensitive: DO is not do", () => {
    expect(missingSpecifics("the DO serializes it", "the do serializes it")).toContain("DO");
  });

  it("many sources into one line: every source's specifics are checked", () => {
    const before = ["port 41730", "commit d62dc12"].join("\n");
    expect(missingSpecifics(before, "port 41730 and a commit")).toEqual(["d62dc12"]);
  });
});
