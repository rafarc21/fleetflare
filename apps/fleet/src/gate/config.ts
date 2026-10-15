// Phase 1 (#715) gate config: the FLEET_GATE_RUNNER/GATE_RUNNER_REPOS repo
// gate (same comma-separated "owner/repo" shape as INSTALL_CACHE_REPOS,
// apps/fleet/src/studio/install-cache.ts:104-126) and the fleet.json `gate`
// block's parsing. Pure — no exec, no network, no token.

export function parseGateRunnerRepos(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

export function isGateRunnerRepo(raw: string | undefined, workRepoSlug: string): boolean {
  return parseGateRunnerRepos(raw).includes(workRepoSlug.toLowerCase());
}

/** Vitest shards when the gate block names none (#1015 spike, #715 comment 6188308109). */
export const DEFAULT_VITEST_SHARDS = 8;

/** Bun-test shards when the gate block names none (#1018). The bun-test lane
 *  was one container (674s serial on GH runners); six balanced legs bring it
 *  under the p50 target. */
export const DEFAULT_BUN_SHARDS = 6;

/** Hard cap on legs per PR, merge-tree, fleet.json legs, bun and vitest shards
 *  included (#715 comment 6194310999). Each leg is a container, so this bounds
 *  cost per PR. */
export const MAX_LEGS_PER_PR = 24;

export interface GateConfig {
  install: string;
  legs: string[];
  vitestCmd: string;
  pathRules: string[];
  vitestShards: number;
  bunShards: number;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Returns null on anything malformed — never throws. A repo with no `gate`
 *  block, or a malformed one, gets the Workflow's own "skip, don't guess"
 *  behavior (Task 14), not a crash. `vitestShards` and `bunShards` are optional
 *  (absent means DEFAULT_VITEST_SHARDS / DEFAULT_BUN_SHARDS), but when present
 *  each must be a positive integer. merge-tree, the fixed legs, the bun shards
 *  and at least one vitest shard must fit under MAX_LEGS_PER_PR. */
export function parseGateConfig(fleetJson: unknown): GateConfig | null {
  if (typeof fleetJson !== "object" || fleetJson === null) return null;
  const gate = (fleetJson as Record<string, unknown>).gate;
  if (typeof gate !== "object" || gate === null) return null;
  const g = gate as Record<string, unknown>;
  if (typeof g.install !== "string") return null;
  if (!isStringArray(g.legs)) return null;
  if (typeof g.vitestCmd !== "string") return null;
  if (!isStringArray(g.pathRules)) return null;
  const vitestShards = g.vitestShards === undefined ? DEFAULT_VITEST_SHARDS : g.vitestShards;
  if (typeof vitestShards !== "number" || !Number.isInteger(vitestShards) || vitestShards < 1) return null;
  const bunShards = g.bunShards === undefined ? DEFAULT_BUN_SHARDS : g.bunShards;
  if (typeof bunShards !== "number" || !Number.isInteger(bunShards) || bunShards < 1) return null;
  // merge-tree + the fixed legs + the bun shards + at least one vitest shard must fit the cap.
  if (1 + g.legs.length + bunShards + 1 > MAX_LEGS_PER_PR) return null;
  return {
    install: g.install, legs: g.legs, vitestCmd: g.vitestCmd, pathRules: g.pathRules, vitestShards, bunShards,
  };
}

/** Mirrors localci.sh's own skip-fleet-check path filter (localci.sh:378-381):
 *  a PR touching none of `pathRules` skips the whole gate. A rule ending in
 *  "/**" matches any path under that prefix; anything else must match a
 *  changed file exactly. */
export function matchesPathRules(changedFiles: string[], pathRules: string[]): boolean {
  return changedFiles.some((file) =>
    pathRules.some((rule) => {
      if (rule.endsWith("/**")) return file.startsWith(rule.slice(0, -2));
      return file === rule;
    }));
}
