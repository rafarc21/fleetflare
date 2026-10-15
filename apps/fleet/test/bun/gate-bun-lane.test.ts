// #1018 (refs #715): the bun-test lane, sharded. Pure planning only: which
// files the lane runs, and how they pack into shards. Fixture names are
// neutral on purpose (this repo is public).
import { describe, it, expect } from "bun:test";
import { readdirSync } from "node:fs";
import {
  isBunLaneFile, laneFilesFromTree, planBunShards,
} from "../../src/gate/bun-lane";
import BUN_SHARD_TIMINGS from "../../src/gate/bun-shard-timings.json";
import { MAX_LEGS_PER_PR, parseGateConfig } from "../../src/gate/config";
import { planLegs } from "../../src/gate/fanout";
import FLEET_JSON from "../../../../fleet.json";

describe("isBunLaneFile", () => {
  it("takes test/bun/*.test.ts files", () => {
    expect(isBunLaneFile("test/bun/alpha.test.ts")).toBe(true);
  });
  it("takes the two root files the bun-test-gate script also runs", () => {
    expect(isBunLaneFile("test/studio.files.test.ts")).toBe(true);
    expect(isBunLaneFile("test/studio.studio-blueprint.test.ts")).toBe(true);
  });
  it("excludes memguard-docker, as the gate's --path-ignore-patterns does", () => {
    expect(isBunLaneFile("test/bun/memguard-docker.test.ts")).toBe(false);
  });
  it("keeps other memguard files: only memguard-docker* is excluded", () => {
    expect(isBunLaneFile("test/bun/memguard-select-core.test.ts")).toBe(true);
  });
  it("excludes helpers, non-test files and nested directories", () => {
    expect(isBunLaneFile("test/bun/helpers/shared.ts")).toBe(false);
    expect(isBunLaneFile("test/bun/fixture.json")).toBe(false);
    expect(isBunLaneFile("test/bun/deep/nested.test.ts")).toBe(false);
  });
  it("excludes other root-level tests the gate does not run", () => {
    expect(isBunLaneFile("test/other.test.ts")).toBe(false);
    expect(isBunLaneFile("src/gate/config.ts")).toBe(false);
  });
});

describe("isBunLaneFile with the block's own globs", () => {
  it("takes only files matching the globs it is given", () => {
    expect(isBunLaneFile("suites/unit/a.test.ts", ["suites/*/*.test.ts"])).toBe(true);
    expect(isBunLaneFile("test/bun/a.test.ts", ["suites/*/*.test.ts"])).toBe(false);
  });
  it("** crosses directories; * does not", () => {
    expect(isBunLaneFile("suites/deep/x/a.test.ts", ["suites/**/*.test.ts"])).toBe(true);
    expect(isBunLaneFile("suites/deep/x/a.test.ts", ["suites/*/*.test.ts"])).toBe(false);
  });
  it("still excludes memguard-docker under any glob set", () => {
    expect(isBunLaneFile("suites/memguard-docker.test.ts", ["suites/*.test.ts"])).toBe(false);
  });
});

describe("laneFilesFromTree", () => {
  it("maps repo-root paths to apps/fleet-relative lane files, sorted", () => {
    expect(laneFilesFromTree([
      "apps/fleet/test/bun/zeta.test.ts",
      "apps/fleet/test/bun/alpha.test.ts",
      "apps/fleet/test/studio.files.test.ts",
    ], "apps/fleet")).toEqual([
      "test/bun/alpha.test.ts",
      "test/bun/zeta.test.ts",
      "test/studio.files.test.ts",
    ]);
  });
  it("drops paths outside the block's root, even when they look like lane files", () => {
    expect(laneFilesFromTree(["test/bun/alpha.test.ts", "other/test/bun/beta.test.ts"], "apps/fleet")).toEqual([]);
  });
  it("applies the same lane rules as isBunLaneFile", () => {
    expect(laneFilesFromTree([
      "apps/fleet/test/bun/memguard-docker.test.ts",
      "apps/fleet/test/bun/helpers/x.ts",
    ], "apps/fleet")).toEqual([]);
  });
  it("uses the block's own root: a per-repo root reads only its own tree", () => {
    expect(laneFilesFromTree([
      "packages/web/test/bun/a.test.ts",
      "apps/fleet/test/bun/b.test.ts",
      "packages/web/test/bun/memguard-docker.test.ts",
    ], "packages/web")).toEqual(["test/bun/a.test.ts"]);
  });
  it("a trailing slash on the root changes nothing", () => {
    expect(laneFilesFromTree(["packages/web/test/bun/a.test.ts"], "packages/web/")).toEqual(["test/bun/a.test.ts"]);
  });
  it("takes its file set from the block's globs, relative to the root", () => {
    expect(laneFilesFromTree([
      "packages/web/suites/unit/a.test.ts",
      "packages/web/test/bun/b.test.ts",
    ], "packages/web", ["suites/*/*.test.ts"])).toEqual(["suites/unit/a.test.ts"]);
  });
});

describe("planBunShards", () => {
  const FILES = Array.from({ length: 12 }, (_, i) => `test/bun/f${String(i).padStart(2, "0")}.test.ts`);

  it("every lane file lands in exactly one shard", () => {
    const shards = planBunShards(FILES, [], 6);
    expect(shards.flat().sort()).toEqual([...FILES].sort());
  });

  it("never returns more shards than asked for", () => {
    expect(planBunShards(FILES, [], 6).length).toBeLessThanOrEqual(6);
    expect(planBunShards(FILES, [], 1).length).toBe(1);
  });

  it("with timings, a heavy file does not share a shard with much other work", () => {
    const timings = [{ file: "test/bun/f00.test.ts", ms: 120_000 }];
    const shards = planBunShards(FILES, timings, 6);
    const owner = shards.find((s) => s.includes("test/bun/f00.test.ts"))!;
    expect(owner.length).toBeLessThanOrEqual(2);
  });

  it("a file missing from the timings still gets a shard (equal-weight fallback)", () => {
    const timings = FILES.slice(1).map((file) => ({ file, ms: 10_000 }));
    const shards = planBunShards(FILES, timings, 3);
    expect(shards.flat()).toContain("test/bun/f00.test.ts");
    expect(shards.flat().sort()).toEqual([...FILES].sort());
  });

  it("no lane files -> no shards, so the gate adds no bun legs", () => {
    expect(planBunShards([], [], 6)).toEqual([]);
  });

  it("is deterministic for the same input", () => {
    const timings = [{ file: "test/bun/f03.test.ts", ms: 9_000 }];
    expect(planBunShards(FILES, timings, 4)).toEqual(planBunShards(FILES, timings, 4));
  });
});

describe("checked-in gate plan", () => {
  // The real fleet.json gate block, the checked-in timing snapshot and the
  // test/bun directory on disk, planned together: the shipped config must
  // cover the lane exactly once and stay under the leg cap.
  const laneOnDisk = [
    ...readdirSync(import.meta.dir).map((f) => `apps/fleet/test/bun/${f}`),
    "apps/fleet/test/studio.files.test.ts",
    "apps/fleet/test/studio.studio-blueprint.test.ts",
  ];

  // The shipped fleet.json is the fleet's own repo, so its `gate` block is the fallback.
  const FLEET_REPO = FLEET_JSON.blueprint.repo;

  it("the shipped gate block parses and carries bunShards", () => {
    expect(parseGateConfig(FLEET_JSON, FLEET_REPO, FLEET_REPO)?.bunShards).toBeGreaterThan(0);
  });

  it("the real lane is covered exactly once by the shipped bun shard count", () => {
    const cfg = parseGateConfig(FLEET_JSON, FLEET_REPO, FLEET_REPO)!;
    const lane = laneFilesFromTree(laneOnDisk, cfg.bunLaneRoot!, cfg.bunLaneGlobs);
    const shards = planBunShards(lane, BUN_SHARD_TIMINGS.timings, cfg.bunShards);
    expect(lane.length).toBeGreaterThan(0);
    expect(shards.flat().sort()).toEqual(lane);
    expect(shards.length).toBeLessThanOrEqual(cfg.bunShards);
  });

  it("the full leg plan for the shipped config stays under MAX_LEGS_PER_PR", () => {
    const cfg = parseGateConfig(FLEET_JSON, FLEET_REPO, FLEET_REPO)!;
    const bunShards = planBunShards(
      laneFilesFromTree(laneOnDisk, cfg.bunLaneRoot!, cfg.bunLaneGlobs), BUN_SHARD_TIMINGS.timings, cfg.bunShards,
    );
    const legs = planLegs({
      owner: "acme", repo: "example", pr: 1, runId: "run-a",
      headSha: "h".repeat(40), baseSha: "b".repeat(40),
      install: cfg.install, legs: cfg.legs, bunShards, bunLaneRoot: cfg.bunLaneRoot!,
      vitestCmd: cfg.vitestCmd, vitestShards: cfg.vitestShards, baselineKeys: [],
    });
    expect(legs.length).toBeLessThanOrEqual(MAX_LEGS_PER_PR);
    expect(legs.filter((l) => l.leg.startsWith("bun-")).length).toBe(bunShards.length);
  });
});
