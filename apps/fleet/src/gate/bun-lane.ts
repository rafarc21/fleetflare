// #1018 (refs #715): the bun-test lane, sharded. Pure: which files the lane
// runs (the bun-test-gate script's own set, memguard-docker excluded) and how
// they pack into shards by measured per-file time (shard-plan.ts). No I/O, so
// bun test loads it directly.
import { planShards, totalWeightMs, type FileTiming } from "./shard-plan";

/** The repo path prefix of fleet.json's gate root. Tree paths carry it;
 *  lane files and leg commands do not (they run from apps/fleet). */
export const BUN_LANE_ROOT = "apps/fleet/";

/** A leg's commands run in a fresh shell at the repo root, so each bun leg
 *  enters apps/fleet first, the same way the vitest leg does. */
export const BUN_LANE_CWD = "cd apps/fleet && ";

// The root-level files bun-test-gate runs alongside test/bun.
const ROOT_LANE_FILES = new Set(["test/studio.files.test.ts", "test/studio.studio-blueprint.test.ts"]);

/** Mirrors bun-test-gate: test/bun/*.test.ts plus two root files, with
 *  `--path-ignore-patterns '**\/memguard-docker*'` applied to the basename. */
export function isBunLaneFile(file: string): boolean {
  const inBunDir = /^test\/bun\/[^/]+\.test\.ts$/.test(file);
  if (!inBunDir && !ROOT_LANE_FILES.has(file)) return false;
  return !/(^|\/)memguard-docker[^/]*$/.test(file);
}

/** Lane files out of a full repo tree listing (repo-root paths). Sorted, so
 *  the plan is the same whatever order GitHub returns the tree in. */
export function laneFilesFromTree(paths: string[]): string[] {
  return paths
    .filter((p) => p.startsWith(BUN_LANE_ROOT))
    .map((p) => p.slice(BUN_LANE_ROOT.length))
    .filter(isBunLaneFile)
    .sort();
}

/** Packs the lane's files into at most `shards` groups, every file in exactly
 *  one. Files with no timing weigh the measured median (shard-plan.ts). The
 *  target per shard is the even split of the total weight, so the planner
 *  returns no more than `shards` groups. */
export function planBunShards(files: string[], timings: FileTiming[], shards: number): string[][] {
  const byFile = new Map(timings.map((t) => [t.file, t.ms]));
  const weighted = files.map((file) => ({ file, ms: byFile.get(file) ?? 0 }));
  const target = Math.max(1, Math.ceil(totalWeightMs(weighted) / Math.max(1, shards)));
  return planShards(weighted, target);
}
