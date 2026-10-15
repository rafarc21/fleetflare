// Phase 1 (#715) gate config: the FLEET_GATE_RUNNER/GATE_RUNNER_REPOS repo
// gate (same comma-separated "owner/repo" shape as INSTALL_CACHE_REPOS,
// apps/fleet/src/studio/install-cache.ts:104-126) and the fleet.json gate
// config's parsing: a `gates` map keyed by "owner/repo", plus the single
// `gate` block as the fallback for the fleet's own repo. Pure — no exec, no
// network, no token.

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
  /** Repo-root path the bun-test lane runs from (e.g. "apps/fleet"). Absent
   *  means the block has no bun lane: no bun legs for that repo. */
  bunLaneRoot?: string;
  /** Lane file globs, relative to bunLaneRoot. Absent means the lane's default set. */
  bunLaneGlobs?: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** One gate block, validated. Returns null on anything malformed. */
function parseBlock(block: unknown): GateConfig | null {
  if (typeof block !== "object" || block === null) return null;
  const g = block as Record<string, unknown>;
  if (typeof g.install !== "string") return null;
  if (!isStringArray(g.legs)) return null;
  if (typeof g.vitestCmd !== "string") return null;
  if (!isStringArray(g.pathRules)) return null;
  const vitestShards = g.vitestShards === undefined ? DEFAULT_VITEST_SHARDS : g.vitestShards;
  if (typeof vitestShards !== "number" || !Number.isInteger(vitestShards) || vitestShards < 1) return null;
  const bunShards = g.bunShards === undefined ? DEFAULT_BUN_SHARDS : g.bunShards;
  if (typeof bunShards !== "number" || !Number.isInteger(bunShards) || bunShards < 1) return null;
  if (g.bunLaneRoot !== undefined && (typeof g.bunLaneRoot !== "string" || g.bunLaneRoot === "")) return null;
  if (g.bunLaneGlobs !== undefined && !isStringArray(g.bunLaneGlobs)) return null;
  // Bun shards only take cap room when the block has a bun lane.
  const bunLegs = g.bunLaneRoot === undefined ? 0 : bunShards;
  // merge-tree + the fixed legs + the bun legs + at least one vitest shard must fit the cap.
  if (1 + g.legs.length + bunLegs + 1 > MAX_LEGS_PER_PR) return null;
  return {
    install: g.install, legs: g.legs, vitestCmd: g.vitestCmd, pathRules: g.pathRules, vitestShards, bunShards,
    bunLaneRoot: g.bunLaneRoot, bunLaneGlobs: g.bunLaneGlobs,
  };
}

/** The gate config for one PR's repo. `repo` is the PR's own "owner/repo";
 *  `fleetRepo` is the repo fleet.json lives in (env.AGENT_REPO), which the
 *  single `gate` block describes. Lookup, in order:
 *    1. `gates[repo]` (case-insensitive): that block, or null if malformed.
 *    2. `gate`, only when `repo` is the fleet's own repo. Any other repo with
 *       no map entry gets null: the fleet's commands never run against it.
 *  Returns null on anything malformed — never throws. A null config gets the
 *  Workflow's own "skip, don't guess" behavior (Task 14), not a crash. */
export function parseGateConfig(fleetJson: unknown, repo: string, fleetRepo: string): GateConfig | null {
  if (typeof fleetJson !== "object" || fleetJson === null) return null;
  const root = fleetJson as Record<string, unknown>;
  const key = repo.toLowerCase();
  const gates = root.gates;
  if (typeof gates === "object" && gates !== null) {
    const entry = Object.entries(gates).find(([name]) => name.toLowerCase() === key);
    if (entry !== undefined) return parseBlock(entry[1]);
  }
  if (key !== fleetRepo.toLowerCase()) return null;
  return parseBlock(root.gate);
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
