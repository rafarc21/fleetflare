// #1018 (refs #715): the bun-test lane, sharded. Pure: which files the lane
// runs (the bun-test-gate script's own set, memguard-docker excluded) and how
// they pack into shards by measured per-file time (shard-plan.ts). No I/O, so
// bun test loads it directly.
import { planShards, totalWeightMs, type FileTiming } from "./shard-plan";

/** The lane's file globs when the gate block names none, relative to the
 *  block's bunLaneRoot. Mirrors bun-test-gate: test/bun/*.test.ts plus two
 *  root files. */
export const DEFAULT_BUN_LANE_GLOBS = [
  "test/bun/*.test.ts",
  "test/studio.files.test.ts",
  "test/studio.studio-blueprint.test.ts",
];

/** A leg's commands run in a fresh shell at the repo root, so each bun leg
 *  enters the block's root first, the same way the vitest leg does. */
export function bunLaneCwd(root: string): string {
  return `cd ${root.replace(/\/+$/, "")} && `;
}

/** A glob to a RegExp over a repo-relative path. `**\/` matches zero or more
 *  directories, `**` any run of characters, `*` one path segment; everything
 *  else is literal. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; }
    else if (glob.startsWith("**", i)) { re += ".*"; i += 1; }
    else if (glob[i] === "*") re += "[^/]*";
    else re += glob[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Lane membership for a file relative to the lane root. `globs` is the
 *  block's own set (default DEFAULT_BUN_LANE_GLOBS). The memguard-docker
 *  exclusion is the gate's own --path-ignore-patterns, so it applies to any
 *  glob set. */
export function isBunLaneFile(file: string, globs: string[] = DEFAULT_BUN_LANE_GLOBS): boolean {
  if (!globs.some((glob) => globToRegExp(glob).test(file))) return false;
  return !/(^|\/)memguard-docker[^/]*$/.test(file);
}

/** Lane files out of a full repo tree listing (repo-root paths), for the
 *  block's `root`. Lane files come back root-relative. Sorted, so the plan is
 *  the same whatever order GitHub returns the tree in. */
export function laneFilesFromTree(paths: string[], root: string, globs?: string[]): string[] {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  return paths
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter((file) => isBunLaneFile(file, globs))
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
