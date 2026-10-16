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

/** The gate images a block may name, by key (#1066). A key is a lookup into the
 *  operator's deployed `images` map: a repo never names an image ref. */
export const GATE_IMAGES: ReadonlySet<string> = new Set(["gate", "desktop"]);
/** The image a run uses when its block names none. */
export const DEFAULT_GATE_IMAGE = "gate";

/** Hard cap on legs per PR, merge-tree, gate block legs, bun and vitest shards
 *  included (#715 comment 6194310999). Each leg is a container, so this bounds
 *  cost per PR. */
export const MAX_LEGS_PER_PR = 24;

/** A leg's name is its status-independent id: the result key, the log line and
 *  the verdict's "first failing leg". The reserved names below belong to the
 *  built-in lanes, so a configured leg can never shadow them. */
export const LEG_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** One leg's deadline when its block names none: 25 min, counted from the leg's start. */
export const DEFAULT_LEG_TIMEOUT_MIN = 25;
/** The ceiling a block may set. The Workflows step timeout is 30 min per attempt. */
export const MAX_LEG_TIMEOUT_MIN = 28;

/** A leg's deadline in minutes: the default when unset, else clamped to 1..28. */
export function legTimeoutMin(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LEG_TIMEOUT_MIN;
  return Math.min(MAX_LEG_TIMEOUT_MIN, Math.max(1, Math.floor(raw)));
}

// One configured leg. A string entry `"lint"` is `{ name: "lint", cmd: "bun run lint" }`.
export interface GateLeg {
  name: string;
  /** Shell command, run from the repo root after the shared install. */
  cmd: string;
  /** The leg's own deadline in minutes, when the block sets one. Absent means the default. */
  timeoutMin?: number;
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
  /** The block's image key (#1066). Absent means DEFAULT_GATE_IMAGE at run time. */
  image?: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isReservedLegName(name: string): boolean {
  // "bundle" is the #1080 bundle step's leg: its result key is shard-bundle.json, so a block leg of that name would share it.
  return name === "merge-tree" || name === "bundle" || /^bun-\d+$/.test(name) || /^vitest-\d+$/.test(name);
}

/** The block's `legs`, normalised to { name, cmd, timeoutMin? }. Each entry is a
 *  string (`bun run <name>`) or an object { name, cmd, timeoutMin? }. Null on any
 *  bad entry, a bad name, a reserved name, a duplicate, or a non-number timeoutMin. */
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
      if (e.timeoutMin !== undefined && (typeof e.timeoutMin !== "number" || !Number.isFinite(e.timeoutMin))) return null;
      leg = { name: e.name, cmd: e.cmd, ...(e.timeoutMin === undefined ? {} : { timeoutMin: legTimeoutMin(e.timeoutMin) }) };
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
  // An image key outside the allowlist (a registry ref, "__proto__", "") is a
  // malformed block, never a silent fallback to the default image.
  let image: string | undefined;
  if (g.image !== undefined) {
    if (typeof g.image !== "string" || !GATE_IMAGES.has(g.image)) return null;
    image = g.image;
  }
  return {
    install: g.install, legs, vitestCmd: g.vitestCmd, pathRules: g.pathRules, vitestShards, bunShards,
    bunLaneRoot: g.bunLaneRoot, bunLaneGlobs: g.bunLaneGlobs, ...(image === undefined ? {} : { image }),
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

/** Whether the repo's own gate config changed (#1091 review round 2). Decided on
 *  CONTENT: `base` and `head` are the parsed root fleet.json at each sha, null
 *  when absent or unparseable. A file list cannot be trusted for this: the
 *  compare API names a rename by its new path only and stops at 300 files, so a
 *  moved or buried fleet.json would look untouched. Any difference counts,
 *  including a file gone at head and a file new at base: over-gating costs one
 *  run, under-gating lets a PR edit its own gate. */
export function fleetJsonChanged(base: unknown, head: unknown): boolean {
  return JSON.stringify(base ?? null) !== JSON.stringify(head ?? null);
}

/** The verdict a PR that changes fleet.json fails with when its head config is
 *  absent or invalid (#1091 review): a failure, never a skip. Null otherwise.
 *  `head` is undefined when the config did not change and was not loaded. */
export function headFleetJsonFailure(
  configChanged: boolean, head: GateConfig | null | undefined, headGatesInvalid = false,
): string | null {
  if (!configChanged) return null;
  return head && !headGatesInvalid ? null : "head fleet.json invalid";
}

/** Whether a PR's diff gates the run (#1091). A config change always gates, so a
 *  config edit is validated by its own PR, not the next unrelated one. */
export function gateDecision(
  changedFiles: string[], pathRules: string[], configChanged: boolean, truncated = false,
): "gate" | "skip" {
  return configChanged || truncated || matchesPathRules(changedFiles, pathRules) ? "gate" : "skip";
}

/** Whether a fleet.json's `gates` map holds an entry that is not a valid gate
 *  block, or a `gates` value that is not an object at all (#1095 round 3). Read
 *  on the head, so a bad entry fails the PR that adds it, not the next one. */
export function gateMapHasInvalidEntry(fleetJson: unknown): boolean {
  if (typeof fleetJson !== "object" || fleetJson === null) return false;
  const gates = (fleetJson as Record<string, unknown>).gates;
  if (gates === undefined) return false;
  if (typeof gates !== "object" || gates === null || Array.isArray(gates)) return true;
  return Object.values(gates).some((entry) => parseGateBlock(entry) === null);
}

/** The verdict a gated repo's PR fails with when its base sha has no gate block
 *  and the PR does not add one (#1132). Visible on the head, never a success:
 *  the description names the base and the fix. GitHub caps a description at 140. */
export function noGateBlockFailure(baseSha: string): string {
  return `no gate block at base ${baseSha.slice(0, 8)}: merge gated base into branch`;
}

/** What the gate Workflow does with one PR, decided from its inputs alone (#1091
 *  review round 2, #1132): fail on a bad head config or a base with no gate
 *  block, skip (the workflow posts success) when a gated repo's paths did not
 *  change, or run the legs. */
export type GateRunDecision =
  | { action: "fail"; description: string }
  | { action: "skip"; reason: string }
  | { action: "run" };

export function decideGateRun(input: {
  /** The PR's base sha, named in the failure description when the base has no gate block. */
  baseSha: string;
  changedFiles: string[];
  fleetJsonChanged: boolean;
  base: GateConfig | null;
  head: GateConfig | null | undefined;
  /** The compare list hit COMPARE_FILE_CAP, so it may be cut short (#1095 round 3). */
  truncated?: boolean;
  /** The head's fleet repo `gates` map holds an invalid entry (#1095 round 3). */
  headGatesInvalid?: boolean;
}): GateRunDecision {
  const { baseSha, changedFiles, fleetJsonChanged: configChanged, base, head, truncated = false, headGatesInvalid = false } = input;
  const failure = headFleetJsonFailure(configChanged, head, headGatesInvalid);
  if (failure !== null) return { action: "fail", description: failure };
  // #1132: no gate block at the base and the PR adds none. A silent skip here let
  // a PR merge with no verdict, so the head is failed with the fix named.
  if (base === null && !configChanged) return { action: "fail", description: noGateBlockFailure(baseSha) };
  // Nothing gated changed: the workflow posts success so the required context is not left pending forever.
  if (gateDecision(changedFiles, base?.pathRules ?? [], configChanged, truncated) === "skip") {
    return { action: "skip", reason: "no gated paths changed" };
  }
  return { action: "run" };
}
