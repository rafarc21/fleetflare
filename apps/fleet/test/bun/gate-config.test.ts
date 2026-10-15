import { describe, it, expect } from "bun:test";
import {
  parseGateRunnerRepos, isGateRunnerRepo, parseGateConfig, matchesPathRules,
  DEFAULT_VITEST_SHARDS, DEFAULT_BUN_SHARDS, MAX_LEGS_PER_PR,
} from "../../src/gate/config";
import FLEET_JSON from "../../../../fleet.json";

// Fixture repos are neutral on purpose (this repo is public). FLEET is the
// repo fleet.json lives in: the `gate` block's own repo, the fallback.
const FLEET = "acme/fleet";
const BLOCK = { install: "x", legs: [], vitestCmd: "t", pathRules: ["a/**"] };

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

describe("parseGateConfig", () => {
  it("parses a well-formed gate block", () => {
    const cfg = parseGateConfig({
      gate: { install: "bun install --frozen-lockfile", legs: ["typecheck", "lint"],
        vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"] },
    }, FLEET, FLEET);
    expect(cfg).toEqual({
      install: "bun install --frozen-lockfile", legs: ["typecheck", "lint"],
      vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"],
      vitestShards: DEFAULT_VITEST_SHARDS, bunShards: DEFAULT_BUN_SHARDS,
    });
  });
  it("defaults to 6 bun-test shards when the gate block names none", () => {
    const cfg = parseGateConfig({ gate: BLOCK }, FLEET, FLEET);
    expect(cfg?.bunShards).toBe(6);
  });
  it("reads a configured bun shard count from the gate block", () => {
    const cfg = parseGateConfig({ gate: { ...BLOCK, bunShards: 4 } }, FLEET, FLEET);
    expect(cfg?.bunShards).toBe(4);
  });
  it("null on a bun shard count that is not a positive integer", () => {
    for (const bad of [0, -2, 1.5, "6", null]) {
      expect(parseGateConfig({ gate: { ...BLOCK, bunShards: bad } }, FLEET, FLEET)).toBeNull();
    }
  });
  it("null when the fixed legs plus bun shards leave no room for a vitest shard", () => {
    // merge-tree (1) + 22 fixed legs + 1 bun shard + 1 vitest shard = 25 > 24
    const legs = Array.from({ length: 22 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gate: { ...BLOCK, legs, bunShards: 1, bunLaneRoot: "apps/fleet" },
    }, FLEET, FLEET)).toBeNull();
  });
  it("accepts the largest leg list that still leaves room for bun shards and one vitest shard", () => {
    // merge-tree (1) + 21 fixed legs + 1 bun shard + 1 vitest shard = 24
    const legs = Array.from({ length: 21 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gate: { ...BLOCK, legs, bunShards: 1, bunLaneRoot: "apps/fleet" },
    }, FLEET, FLEET)?.legs.length).toBe(21);
  });
  it("null when the default 6 bun shards do not fit beside the fixed legs", () => {
    // merge-tree (1) + 18 fixed legs + 6 bun shards + 1 vitest shard = 26 > 24
    const legs = Array.from({ length: 18 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gate: { ...BLOCK, legs, bunLaneRoot: "apps/fleet" },
    }, FLEET, FLEET)).toBeNull();
  });
  it("defaults to 8 vitest shards when the gate block names none", () => {
    const cfg = parseGateConfig({
      gate: { ...BLOCK, vitestCmd: "bun run test --shard={i}/{n}" },
    }, FLEET, FLEET);
    expect(cfg?.vitestShards).toBe(8);
  });
  it("reads a configured shard count from the gate block", () => {
    const cfg = parseGateConfig({ gate: { ...BLOCK, vitestShards: 12 } }, FLEET, FLEET);
    expect(cfg?.vitestShards).toBe(12);
  });
  it("null on a shard count that is not a positive integer", () => {
    for (const bad of [0, -1, 2.5, "8", null]) {
      expect(parseGateConfig({ gate: { ...BLOCK, vitestShards: bad } }, FLEET, FLEET)).toBeNull();
    }
  });
  it("null when the fixed legs alone leave no room for a vitest shard under the cap", () => {
    // merge-tree (1) + 23 fixed legs + 1 bun shard + 1 vitest shard = 26 > 24
    const legs = Array.from({ length: MAX_LEGS_PER_PR - 1 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gate: { ...BLOCK, legs, bunShards: 1, bunLaneRoot: "apps/fleet" },
    }, FLEET, FLEET)).toBeNull();
  });
  it("null on a missing gate block, not a throw", () => {
    expect(parseGateConfig({}, FLEET, FLEET)).toBeNull();
    expect(parseGateConfig(null, FLEET, FLEET)).toBeNull();
  });
  it("null on a gate block missing a required field", () => {
    expect(parseGateConfig({ gate: { install: "x" } }, FLEET, FLEET)).toBeNull();
  });
});

describe("parseGateConfig gates map", () => {
  it("looks up the PR's repo in the gates map and parses that block", () => {
    const cfg = parseGateConfig({
      gates: { "acme/example": { ...BLOCK, vitestCmd: "example-test" } },
    }, "acme/example", FLEET);
    expect(cfg?.vitestCmd).toBe("example-test");
  });
  it("matches a map key case-insensitively, on both sides", () => {
    const cfg = parseGateConfig({
      gates: { "Acme/Example": { ...BLOCK, vitestCmd: "example-test" } },
    }, "acme/EXAMPLE", FLEET);
    expect(cfg?.vitestCmd).toBe("example-test");
  });
  it("a map entry beats the gate-block fallback for the fleet's own repo", () => {
    const cfg = parseGateConfig({
      gate: { ...BLOCK, vitestCmd: "fleet-test" },
      gates: { [FLEET]: { ...BLOCK, vitestCmd: "mapped-test" } },
    }, FLEET, FLEET);
    expect(cfg?.vitestCmd).toBe("mapped-test");
  });
  it("falls back to the gate block for the fleet's own repo when it has no map entry", () => {
    const cfg = parseGateConfig({
      gate: { ...BLOCK, vitestCmd: "fleet-test" },
      gates: { "acme/example": { ...BLOCK, vitestCmd: "example-test" } },
    }, FLEET, FLEET);
    expect(cfg?.vitestCmd).toBe("fleet-test");
  });
  it("a repo with no map entry that is not the fleet's own repo gets no gate (null)", () => {
    // The fleet's commands must never run against another repo's PR.
    expect(parseGateConfig({ gate: BLOCK, gates: {} }, "acme/other", FLEET)).toBeNull();
  });
  it("null for a missing repo when fleet.json has no gates map and no gate block", () => {
    expect(parseGateConfig({}, "acme/example", FLEET)).toBeNull();
  });
  it("a malformed map entry is null, never the fallback", () => {
    expect(parseGateConfig({
      gate: BLOCK,
      gates: { "acme/example": { install: "x" } },
    }, "acme/example", FLEET)).toBeNull();
  });
  it("a non-object gates value is ignored: the fleet's own repo still gets the fallback", () => {
    expect(parseGateConfig({ gate: BLOCK, gates: "nope" }, FLEET, FLEET)?.vitestCmd).toBe("t");
  });
  it("reads a per-repo bun lane root and globs from the map entry", () => {
    const cfg = parseGateConfig({
      gates: { "acme/example": { ...BLOCK, bunLaneRoot: "packages/web", bunLaneGlobs: ["suites/*.test.ts"] } },
    }, "acme/example", FLEET);
    expect(cfg?.bunLaneRoot).toBe("packages/web");
    expect(cfg?.bunLaneGlobs).toEqual(["suites/*.test.ts"]);
  });
  it("a block without bunLaneRoot has no bun lane, and its bun shards do not count against the cap", () => {
    // merge-tree (1) + 21 fixed legs + 1 vitest shard = 23 <= 24, bun shards aside.
    const legs = Array.from({ length: 21 }, (_, i) => `leg-${i}`);
    const cfg = parseGateConfig({ gates: { "acme/example": { ...BLOCK, legs, bunShards: 6 } } }, "acme/example", FLEET);
    expect(cfg).not.toBeNull();
    expect(cfg?.bunLaneRoot).toBeUndefined();
  });
  it("a block with bunLaneRoot counts its bun shards against the cap", () => {
    const legs = Array.from({ length: 21 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gates: { "acme/example": { ...BLOCK, legs, bunShards: 6, bunLaneRoot: "packages/web" } },
    }, "acme/example", FLEET)).toBeNull();
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
