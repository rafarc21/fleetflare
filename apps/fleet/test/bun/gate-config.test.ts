import { describe, it, expect } from "bun:test";
import {
  parseGateRunnerRepos, isGateRunnerRepo, parseGateBlock, gateMapEntry, matchesPathRules,
  DEFAULT_VITEST_SHARDS, DEFAULT_BUN_SHARDS, MAX_LEGS_PER_PR,
} from "../../src/gate/config";
import FLEET_JSON from "../../../../fleet.json";

// Fixture repos are neutral on purpose (this repo is public).
const BLOCK = { install: "x", legs: [], vitestCmd: "t", pathRules: ["a/**"] };
const names = (n: number) => Array.from({ length: n }, (_, i) => `leg-${i}`);

describe("parseGateRunnerRepos", () => {
  it("absent/empty -> no repos gated in", () => {
    expect(parseGateRunnerRepos(undefined)).toEqual([]);
    expect(parseGateRunnerRepos("")).toEqual([]);
  });
  it("comma-separated, trimmed, lowercased", () => {
    expect(parseGateRunnerRepos(" Acme/Example , other/repo ")).toEqual([
      "acme/example", "other/repo",
    ]);
  });
});

describe("isGateRunnerRepo", () => {
  it("case-insensitive match", () => {
    expect(isGateRunnerRepo("acme/example", "Acme/Example")).toBe(true);
  });
  it("no match when repo not listed", () => {
    expect(isGateRunnerRepo("acme/example", "other/repo")).toBe(false);
  });
});

describe("parseGateBlock: a well-formed block", () => {
  it("parses every field; string legs become { name, cmd: bun run <name> }", () => {
    const cfg = parseGateBlock({
      install: "bun install --frozen-lockfile", legs: ["typecheck", "lint"],
      vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"],
    });
    expect(cfg).toEqual({
      install: "bun install --frozen-lockfile",
      legs: [
        { name: "typecheck", cmd: "bun run typecheck" },
        { name: "lint", cmd: "bun run lint" },
      ],
      vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"],
      vitestShards: DEFAULT_VITEST_SHARDS, bunShards: DEFAULT_BUN_SHARDS,
    });
  });
  it("null on a missing or non-object block, not a throw", () => {
    expect(parseGateBlock(undefined)).toBeNull();
    expect(parseGateBlock(null)).toBeNull();
    expect(parseGateBlock("gate")).toBeNull();
  });
  it("null on a block missing a required field", () => {
    expect(parseGateBlock({ install: "x" })).toBeNull();
  });
});

describe("parseGateBlock: object legs", () => {
  it("an object leg keeps its own cmd verbatim", () => {
    const cfg = parseGateBlock({
      ...BLOCK, legs: [{ name: "e2e", cmd: "cd apps/web && bun run e2e -- --bail" }],
    });
    expect(cfg?.legs).toEqual([{ name: "e2e", cmd: "cd apps/web && bun run e2e -- --bail" }]);
  });
  it("mixes string and object legs in configured order", () => {
    const cfg = parseGateBlock({ ...BLOCK, legs: ["lint", { name: "docs", cmd: "make docs" }] });
    expect(cfg?.legs.map((l) => l.name)).toEqual(["lint", "docs"]);
    expect(cfg?.legs[1].cmd).toBe("make docs");
  });
  it("null on an object leg with no cmd, or an empty cmd", () => {
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "e2e" }] })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "e2e", cmd: "" }] })).toBeNull();
  });
  it("null on an object leg with a non-string name", () => {
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: 3, cmd: "x" }] })).toBeNull();
  });
  it("null on a leg that is neither a string nor an object", () => {
    expect(parseGateBlock({ ...BLOCK, legs: [42] })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: [null] })).toBeNull();
  });
});

describe("parseGateBlock: leg names", () => {
  it("accepts names matching ^[a-z0-9][a-z0-9-]{0,39}$ in both forms", () => {
    expect(parseGateBlock({ ...BLOCK, legs: ["a", "x9-y", "0lint", { name: "a".repeat(40), cmd: "c" }] })).not.toBeNull();
  });
  it("rejects a name that breaks the pattern, in either form", () => {
    const bad = ["", "Lint", "test:unit", "under_score", "-lead", "a".repeat(41), "sp ace", "dot.name"];
    for (const name of bad) {
      expect(parseGateBlock({ ...BLOCK, legs: [name] })).toBeNull();
      expect(parseGateBlock({ ...BLOCK, legs: [{ name, cmd: "c" }] })).toBeNull();
    }
  });
  it("rejects duplicate names across string and object legs", () => {
    expect(parseGateBlock({ ...BLOCK, legs: ["lint", { name: "lint", cmd: "other" }] })).toBeNull();
  });
  it("rejects the reserved merge-tree name", () => {
    expect(parseGateBlock({ ...BLOCK, legs: ["merge-tree"] })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "merge-tree", cmd: "c" }] })).toBeNull();
  });
  it("rejects bun-N and vitest-N names, which the bun and vitest lanes own", () => {
    for (const name of ["bun-1", "bun-12", "vitest-3"]) {
      expect(parseGateBlock({ ...BLOCK, legs: [name] })).toBeNull();
      expect(parseGateBlock({ ...BLOCK, legs: [{ name, cmd: "c" }] })).toBeNull();
    }
  });
  it("keeps names that only look like the reserved ones", () => {
    expect(parseGateBlock({ ...BLOCK, legs: ["bun", "bun-lint", "vitest-only"] })).not.toBeNull();
  });
});

describe("parseGateBlock: vitestCmd is optional", () => {
  it("absent vitestCmd -> vitestCmd is undefined (zero vitest legs)", () => {
    const { vitestCmd: _omit, ...noVitest } = BLOCK;
    const cfg = parseGateBlock({ ...noVitest, legs: ["lint"] });
    expect(cfg).not.toBeNull();
    expect(cfg?.vitestCmd).toBeUndefined();
  });
  it("a present vitestCmd must be a non-empty string", () => {
    expect(parseGateBlock({ ...BLOCK, vitestCmd: "" })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, vitestCmd: 8 })).toBeNull();
  });
});

describe("parseGateBlock: cap, 1 + legs + bun legs + vitest legs <= MAX_LEGS_PER_PR", () => {
  it("bun shards count only when the block has a bun lane", () => {
    // 1 + 21 legs + 6 bun shards without a lane = 28 would breach, but no lane, so no bun legs.
    expect(parseGateBlock({ ...BLOCK, legs: names(21), bunShards: 6 })).not.toBeNull();
  });
  it("absent vitestCmd: the largest legs list is merge-tree + 23 legs = 24", () => {
    const { vitestCmd: _omit, ...noVitest } = BLOCK;
    expect(parseGateBlock({ ...noVitest, legs: names(MAX_LEGS_PER_PR - 1) })).not.toBeNull();
  });
  it("absent vitestCmd: merge-tree + 24 legs = 25 is rejected", () => {
    const { vitestCmd: _omit, ...noVitest } = BLOCK;
    expect(parseGateBlock({ ...noVitest, legs: names(MAX_LEGS_PER_PR) })).toBeNull();
  });
  it("absent vitestCmd: bun shards with a lane still count against the cap", () => {
    const { vitestCmd: _omit, ...noVitest } = BLOCK;
    expect(parseGateBlock({ ...noVitest, legs: names(22), bunShards: 1, bunLaneRoot: "apps/fleet" })).not.toBeNull();
    expect(parseGateBlock({ ...noVitest, legs: names(23), bunShards: 1, bunLaneRoot: "apps/fleet" })).toBeNull();
  });
  it("present vitestCmd still needs one vitest shard of room", () => {
    expect(parseGateBlock({ ...BLOCK, legs: names(23) })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: names(22) })).not.toBeNull();
  });
});

describe("parseGateBlock shard counts", () => {
  it("defaults to 6 bun-test shards when the block names none", () => {
    expect(parseGateBlock({ ...BLOCK })?.bunShards).toBe(6);
  });
  it("reads a configured bun shard count", () => {
    expect(parseGateBlock({ ...BLOCK, bunShards: 4 })?.bunShards).toBe(4);
  });
  it("null on a bun shard count that is not a positive integer", () => {
    for (const bad of [0, -2, 1.5, "6", null]) {
      expect(parseGateBlock({ ...BLOCK, bunShards: bad })).toBeNull();
    }
  });
  it("defaults to 8 vitest shards when the block names none", () => {
    expect(parseGateBlock({ ...BLOCK })?.vitestShards).toBe(8);
  });
  it("reads a configured vitest shard count", () => {
    expect(parseGateBlock({ ...BLOCK, vitestShards: 12 })?.vitestShards).toBe(12);
  });
  it("null on a vitest shard count that is not a positive integer", () => {
    for (const bad of [0, -1, 2.5, "8", null]) {
      expect(parseGateBlock({ ...BLOCK, vitestShards: bad })).toBeNull();
    }
  });
  it("reads a per-repo bun lane root and globs", () => {
    const cfg = parseGateBlock({ ...BLOCK, bunLaneRoot: "packages/web", bunLaneGlobs: ["suites/*.test.ts"] });
    expect(cfg?.bunLaneRoot).toBe("packages/web");
    expect(cfg?.bunLaneGlobs).toEqual(["suites/*.test.ts"]);
  });
});

describe("gateMapEntry", () => {
  it("returns the entry for the repo, matched case-insensitively on both sides", () => {
    const entry = { ...BLOCK, vitestCmd: "example-test" };
    expect(gateMapEntry({ gates: { "Acme/Example": entry } }, "acme/EXAMPLE")).toEqual(entry);
  });
  it("undefined when the repo has no map entry", () => {
    expect(gateMapEntry({ gates: { "acme/example": BLOCK } }, "acme/other")).toBeUndefined();
  });
  it("undefined when there is no gates map, or it is not an object", () => {
    expect(gateMapEntry({}, "acme/example")).toBeUndefined();
    expect(gateMapEntry({ gates: "nope" }, "acme/example")).toBeUndefined();
    expect(gateMapEntry(null, "acme/example")).toBeUndefined();
  });
});

describe("matchesPathRules", () => {
  const rules = ["apps/fleet/**", "skills/**"];
  it("matches a file under a **-suffixed rule", () => {
    expect(matchesPathRules(["apps/fleet/src/index.ts"], rules)).toBe(true);
  });
  it("no match when every changed file is outside every rule", () => {
    expect(matchesPathRules(["README.md"], rules)).toBe(false);
  });
  it("empty changed-file list never matches", () => {
    expect(matchesPathRules([], rules)).toBe(false);
  });
});

// #1032 (refs #715): the shipped fleet.json's own pathRules must gate the
// files the bringup gates read — gates/*.sh and fleet.json itself. A
// gates-only PR skipping the gate reads as a false green.
describe("shipped fleet.json pathRules", () => {
  it("covers gates/ scripts and fleet.json itself", () => {
    const rules = FLEET_JSON.gate?.pathRules ?? [];
    expect(matchesPathRules(["gates/lead-gate.sh"], rules)).toBe(true);
    expect(matchesPathRules(["gates/completion-gate.sh"], rules)).toBe(true);
    expect(matchesPathRules(["fleet.json"], rules)).toBe(true);
  });
  it("still excludes a file nothing reads", () => {
    const rules = FLEET_JSON.gate?.pathRules ?? [];
    expect(matchesPathRules(["docs/notes.md"], rules)).toBe(false);
  });
});
