import { describe, it, expect } from "bun:test";
import {
  parseGateRunnerRepos, isGateRunnerRepo, parseGateConfig, matchesPathRules,
  DEFAULT_VITEST_SHARDS, DEFAULT_BUN_SHARDS, MAX_LEGS_PER_PR,
} from "../../src/gate/config";

describe("parseGateRunnerRepos", () => {
  it("absent/empty -> no repos gated in", () => {
    expect(parseGateRunnerRepos(undefined)).toEqual([]);
    expect(parseGateRunnerRepos("")).toEqual([]);
  });
  it("comma-separated, trimmed, lowercased", () => {
    expect(parseGateRunnerRepos(" Rafarc21/FleetFlare , other/repo ")).toEqual([
      "rafarc21/fleetflare", "other/repo",
    ]);
  });
});

describe("isGateRunnerRepo", () => {
  it("case-insensitive match", () => {
    expect(isGateRunnerRepo("rafarc21/fleetflare", "Rafarc21/FleetFlare")).toBe(true);
  });
  it("no match when repo not listed", () => {
    expect(isGateRunnerRepo("rafarc21/fleetflare", "other/repo")).toBe(false);
  });
});

describe("parseGateConfig", () => {
  it("parses a well-formed gate block", () => {
    const cfg = parseGateConfig({
      gate: { install: "bun install --frozen-lockfile", legs: ["typecheck", "lint"],
        vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"] },
    });
    expect(cfg).toEqual({
      install: "bun install --frozen-lockfile", legs: ["typecheck", "lint"],
      vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"],
      vitestShards: DEFAULT_VITEST_SHARDS, bunShards: DEFAULT_BUN_SHARDS,
    });
  });
  it("defaults to 6 bun-test shards when the gate block names none", () => {
    const cfg = parseGateConfig({
      gate: { install: "x", legs: [], vitestCmd: "t", pathRules: ["a/**"] },
    });
    expect(cfg?.bunShards).toBe(6);
  });
  it("reads a configured bun shard count from the gate block", () => {
    const cfg = parseGateConfig({
      gate: { install: "x", legs: [], vitestCmd: "t", pathRules: ["a/**"], bunShards: 4 },
    });
    expect(cfg?.bunShards).toBe(4);
  });
  it("null on a bun shard count that is not a positive integer", () => {
    for (const bad of [0, -2, 1.5, "6", null]) {
      expect(parseGateConfig({
        gate: { install: "x", legs: [], vitestCmd: "t", pathRules: ["a/**"], bunShards: bad },
      })).toBeNull();
    }
  });
  it("null when the fixed legs plus bun shards leave no room for a vitest shard", () => {
    // merge-tree (1) + 22 fixed legs + 1 bun shard + 1 vitest shard = 25 > 24
    const legs = Array.from({ length: 22 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gate: { install: "x", legs, vitestCmd: "t", pathRules: ["a/**"], bunShards: 1 },
    })).toBeNull();
  });
  it("accepts the largest leg list that still leaves room for bun shards and one vitest shard", () => {
    // merge-tree (1) + 21 fixed legs + 1 bun shard + 1 vitest shard = 24
    const legs = Array.from({ length: 21 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gate: { install: "x", legs, vitestCmd: "t", pathRules: ["a/**"], bunShards: 1 },
    })?.legs.length).toBe(21);
  });
  it("null when the default 6 bun shards do not fit beside the fixed legs", () => {
    // merge-tree (1) + 18 fixed legs + 6 bun shards + 1 vitest shard = 26 > 24
    const legs = Array.from({ length: 18 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gate: { install: "x", legs, vitestCmd: "t", pathRules: ["a/**"] },
    })).toBeNull();
  });
  it("defaults to 8 vitest shards when the gate block names none", () => {
    const cfg = parseGateConfig({
      gate: { install: "x", legs: [], vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["a/**"] },
    });
    expect(cfg?.vitestShards).toBe(8);
  });
  it("reads a configured shard count from the gate block", () => {
    const cfg = parseGateConfig({
      gate: { install: "x", legs: [], vitestCmd: "t", pathRules: ["a/**"], vitestShards: 12 },
    });
    expect(cfg?.vitestShards).toBe(12);
  });
  it("null on a shard count that is not a positive integer", () => {
    for (const bad of [0, -1, 2.5, "8", null]) {
      expect(parseGateConfig({
        gate: { install: "x", legs: [], vitestCmd: "t", pathRules: ["a/**"], vitestShards: bad },
      })).toBeNull();
    }
  });
  it("null when the fixed legs alone leave no room for a vitest shard under the cap", () => {
    // merge-tree (1) + 23 fixed legs + 1 bun shard + 1 vitest shard = 26 > 24
    const legs = Array.from({ length: MAX_LEGS_PER_PR - 1 }, (_, i) => `leg-${i}`);
    expect(parseGateConfig({
      gate: { install: "x", legs, vitestCmd: "t", pathRules: ["a/**"], bunShards: 1 },
    })).toBeNull();
  });
  it("null on a missing gate block, not a throw", () => {
    expect(parseGateConfig({})).toBeNull();
    expect(parseGateConfig(null)).toBeNull();
  });
  it("null on a gate block missing a required field", () => {
    expect(parseGateConfig({ gate: { install: "x" } })).toBeNull();
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
