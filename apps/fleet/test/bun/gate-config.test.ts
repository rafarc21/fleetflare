import { describe, it, expect } from "bun:test";
import {
  parseGateRunnerRepos, isGateRunnerRepo, parseGateConfig, matchesPathRules,
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
    });
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
