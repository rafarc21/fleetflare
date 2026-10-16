// Gate config: the FLEET_GATE_RUNNER/GATE_RUNNER_REPOS repo gate (same
// comma-separated "owner/repo" shape as INSTALL_CACHE_REPOS,
// apps/fleet/src/studio/install-cache.ts:104-126), and the parsing of one gate
// block. Where a PR's block comes from is load-config.ts's job. Pure: no exec,
// no network, no token.

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

/** Hard cap on legs per PR, merge-tree, gate block legs, bun and vitest shards
 *  included (#715 comment 6194310999). Each leg is a container, so this bounds
 *  cost per PR. */
export const MAX_LEGS_PER_PR = 24;

/** A leg's name is its status-independent id: the result key, the log line and
 *  the verdict's "first failing leg". The reserved names below belong to the
 *  built-in lanes, so a configured leg can never shadow them. */
export const LEG_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** One configured leg. A string entry `"lint"` is `{ name: "lint", cmd: "bun run lint" }`. */
export interface GateLeg {
  name: string;
  /** Shell command, run from the repo root after the shared install. */
  cmd: string;
}

export interface GateConfig {
  install: string;
  legs: GateLeg[];
  /** Absent means the block has no vitest lane: zero vitest legs. */
  vitestCmd?: string;
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

function isReservedLegName(name: string): boolean {
  return name === "merge-tree" || /^bun-\d+$/.test(name) || /^vitest-\d+$/.test(name);
}

/** The block's `legs`, normalised to { name, cmd }. Each entry is a string
 *  (`bun run <name>`) or an object { name, cmd }. Null on any bad entry, a bad
 *  name, a reserved name or a duplicate. */
export function parseLegs(raw: unknown): GateLeg[] | null {
  if (!Array.isArray(raw)) return null;
  const legs: GateLeg[] = [];
  for (const entry of raw) {
    let leg: GateLeg;
    if (typeof entry === "string") {
      leg = { name: entry, cmd: `bun run ${entry}` };
    } else if (typeof entry === "object" && entry !== null) {
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== "string" || typeof e.cmd !== "string" || e.cmd === "") return null;
      leg = { name: e.name, cmd: e.cmd };
    } else {
      return null;
    }
    if (!LEG_NAME_PATTERN.test(leg.name) || isReservedLegName(leg.name)) return null;
    if (legs.some((l) => l.name === leg.name)) return null;
    legs.push(leg);
  }
  return legs;
}

/** One gate block, validated. Returns null on anything malformed. */
export function parseGateBlock(block: unknown): GateConfig | null {
  if (typeof block !== "object" || block === null) return null;
  const g = block as Record<string, unknown>;
  if (typeof g.install !== "string") return null;
  const legs = parseLegs(g.legs);
  if (legs === null) return null;
  if (g.vitestCmd !== undefined && (typeof g.vitestCmd !== "string" || g.vitestCmd === "")) return null;
  if (!isStringArray(g.pathRules)) return null;
  const vitestShards = g.vitestShards === undefined ? DEFAULT_VITEST_SHARDS : g.vitestShards;
  if (typeof vitestShards !== "number" || !Number.isInteger(vitestShards) || vitestShards < 1) return null;
  const bunShards = g.bunShards === undefined ? DEFAULT_BUN_SHARDS : g.bunShards;
  if (typeof bunShards !== "number" || !Number.isInteger(bunShards) || bunShards < 1) return null;
  if (g.bunLaneRoot !== undefined && (typeof g.bunLaneRoot !== "string" || g.bunLaneRoot === "")) return null;
  if (g.bunLaneGlobs !== undefined && !isStringArray(g.bunLaneGlobs)) return null;
  // Bun shards only take cap room when the block has a bun lane. A vitest
  // lane, when configured, needs at least one shard of room.
  const bunLegs = g.bunLaneRoot === undefined ? 0 : bunShards;
  const vitestMin = g.vitestCmd === undefined ? 0 : 1;
  if (1 + legs.length + bunLegs + vitestMin > MAX_LEGS_PER_PR) return null;
  return {
    install: g.install, legs, vitestCmd: g.vitestCmd, pathRules: g.pathRules, vitestShards, bunShards,
    bunLaneRoot: g.bunLaneRoot, bunLaneGlobs: g.bunLaneGlobs,
  };
}

/** The raw `gates[repo]` entry from the fleet repo's fleet.json, matched
 *  case-insensitively. Undefined when the map has no entry for `repo`. */
export function gateMapEntry(fleetJson: unknown, repo: string): unknown {
  if (typeof fleetJson !== "object" || fleetJson === null) return undefined;
  const gates = (fleetJson as Record<string, unknown>).gates;
  if (typeof gates !== "object" || gates === null) return undefined;
  const key = repo.toLowerCase();
  return Object.entries(gates).find(([name]) => name.toLowerCase() === key)?.[1];
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
