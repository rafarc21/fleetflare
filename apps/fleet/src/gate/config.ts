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

/** #1398: the GATE_ASYNC_LEGS repo gate, same comma-separated "owner/repo"
 *  shape as GATE_RUNNER_REPOS (above) -- a fleet-wide, per-repo opt-in into
 *  the async /run-leg path. Absent/empty means every repo stays on the old
 *  synchronous path, the default this flag ships with. */
export function parseAsyncLegsRepos(raw: string | undefined): string[] {
  return parseGateRunnerRepos(raw);
}

export function isAsyncLegsRepo(raw: string | undefined, workRepoSlug: string): boolean {
  return parseAsyncLegsRepos(raw).includes(workRepoSlug.toLowerCase());
}

/** Vitest shards when the gate block names none (#1015 spike, #715 comment 6188308109). */
export const DEFAULT_VITEST_SHARDS = 8;

/** Bun-test shards when the gate block names none (#1018). The bun-test lane
 *  was one container (674s serial on GH runners); six balanced legs bring it
 *  under the p50 target. */
export const DEFAULT_BUN_SHARDS = 6;

/** The gate images a block may name, by key (#1066). A key is a lookup into the
 *  operator's deployed `images` map: a repo never names an image ref.
 *  `e2e` (#1342) names the browser-capable image: Chromium + Playwright, so a
 *  leg opts in via `"image": "e2e"` and runs a Playwright spec headless. */
export const GATE_IMAGES: ReadonlySet<string> = new Set(["gate", "desktop", "e2e"]);
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
/** The ceiling a block may set. An attempt's step deadline is 28 min (leg-run.ts
 *  legStepDeadlineMs); the leg's own timeout runs from the container start, which
 *  takes up to 180 s, so 25 min is the largest timeout that ends inside that deadline (#1148 item 5). */
export const MAX_LEG_TIMEOUT_MIN = 25;

/** A leg's deadline in minutes: the default when unset, else clamped to 1..MAX_LEG_TIMEOUT_MIN. */
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
  /** #1274: the leg runs only when a changed file matches one of these (same
   *  shape as the block's pathRules). Absent means the leg always runs. */
  paths?: string[];
  /** #1274: the container image THIS leg runs on, overriding the block's image.
   *  Absent means the block's image (or the default). */
  image?: string;
  /** #1343: this leg is a browser leg — its result is a REAL verdict only when
   *  spec evidence exists. Absent means a plain leg, no evidence contract. */
  browser?: boolean;
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
  /** #1319: every generated vitest-N leg's deadline in minutes (clamped via
   *  legTimeoutMin). Absent means the 25 min default applies per shard. */
  vitestTimeoutMin?: number;
  /** #1319: every generated bun-N leg's deadline in minutes. Absent means the default. */
  bunTimeoutMin?: number;
  /** Lane file globs, relative to bunLaneRoot. Absent means the lane's default set. */
  bunLaneGlobs?: string[];
  /** #1080: the repo opts into the one-bundle-per-run path. Absent means off: the legs clone. Opt in only
   *  when no leg reads git history beyond what a snapshot holds (see docs/operations.md). */
  bundle?: boolean;
  /** The block's image key (#1066). Absent means DEFAULT_GATE_IMAGE at run time. */
  image?: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** #1412: the workflow's fixed step names, audited (workflow.ts's own
 *  `step.do(...)` literals; "build-bundle" is runBundleStep's, leg-run.ts). A
 *  leg's OWN steps are minted as `<prefix>-<leg>` for prefix in { start-, retry-,
 *  recover-start-, recover-retry-, leg-started- } (leg-run.ts); the
 *  dispatch-…/total-budget-… names always carry a trailing `-tryN`, so they can
 *  never equal a hand-written fixed step. A leg name that makes one of the five
 *  simple forms equal a fixed step would shadow it — a leg "infra-rerun" mints
 *  `start-infra-rerun`, colliding with the infra-rerun launch step. Reserved leg
 *  names are derived from the real fixed-step names (not hand-listed), so a fixed
 *  step added later reserves its leg-name shadow for free. KEEP IN SYNC with
 *  workflow.ts: every fixed `step.do("...")` literal must appear here. */
const LEG_STEP_PREFIXES = ["start-", "retry-", "recover-start-", "recover-retry-", "leg-started-"] as const;

const FIXED_STEP_NAMES = [
  "build-bundle",
  "fleet-json-changed",
  "gate-secrets-allowlist",
  "gate-secrets-own-app-slug",
  "head-gates-map",
  "leg-mode",
  "list-browser-evidence",
  "list-bun-lane",
  "load-config",
  "load-head-config",
  "post-head-invalid",
  "post-infra-rerun",
  "post-pending",
  "post-precheck-failure",
  "post-recheck-failure",
  "post-secrets-allowlist-failure",
  "post-skip-status",
  "post-verdict",
  "precheck",
  "precheck-recheck",
  "resolve-pr",
  "shared-head-guard-skip",
  "shared-head-guard-verdict",
  "start-infra-rerun",
] as const;

/** Leg names whose `<prefix>-<name>` step would equal a fixed workflow step. */
const STEP_SHADOWING_LEG_NAMES: ReadonlySet<string> = new Set(
  FIXED_STEP_NAMES.flatMap((step) =>
    LEG_STEP_PREFIXES.filter((prefix) => step.startsWith(prefix)).map((prefix) => step.slice(prefix.length)),
  ),
);

function isReservedLegName(name: string): boolean {
  // "bundle" is the #1080 bundle step's leg: its result key is shard-bundle.json, so a block leg of that name would share it.
  if (name === "merge-tree" || name === "bundle" || /^bun-\d+$/.test(name) || /^vitest-\d+$/.test(name)) return true;
  // #1412: a leg whose minted step would shadow a fixed workflow step
  // (e.g. "infra-rerun" → `start-infra-rerun`) is reserved too.
  return STEP_SHADOWING_LEG_NAMES.has(name);
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
      // #1274: an optional per-leg path filter. Reuses the block's pathRules shape.
      if (e.paths !== undefined && !isStringArray(e.paths)) return null;
      // #1274: an optional per-leg image. Fail-closed on any key outside GATE_IMAGES.
      if (e.image !== undefined && (typeof e.image !== "string" || !GATE_IMAGES.has(e.image))) return null;
      // #1343: an optional browser flag. Must be a boolean; anything else is a
      // malformed block, never a silent plain leg (a browser leg has a
      // DID-NOT-RUN contract a plain leg must never inherit by typo).
      if (e.browser !== undefined && typeof e.browser !== "boolean") return null;
      leg = {
        name: e.name, cmd: e.cmd,
        ...(e.timeoutMin === undefined ? {} : { timeoutMin: legTimeoutMin(e.timeoutMin) }),
        ...(e.paths === undefined ? {} : { paths: e.paths }),
        ...(e.image === undefined ? {} : { image: e.image }),
        ...(e.browser === true ? { browser: true } : {}),
      };
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
  // #1319: lane timeouts clamp the same as per-leg timeouts. Fail-closed on any
  // non-finite number; absent keeps the default so lanes run at 25 min.
  if (g.vitestTimeoutMin !== undefined && (typeof g.vitestTimeoutMin !== "number" || !Number.isFinite(g.vitestTimeoutMin))) return null;
  if (g.bunTimeoutMin !== undefined && (typeof g.bunTimeoutMin !== "number" || !Number.isFinite(g.bunTimeoutMin))) return null;
  if (g.bundle !== undefined && typeof g.bundle !== "boolean") return null;
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
    ...(g.bundle === true ? { bundle: true } : {}),
    ...(g.vitestTimeoutMin === undefined ? {} : { vitestTimeoutMin: legTimeoutMin(g.vitestTimeoutMin) }),
    ...(g.bunTimeoutMin === undefined ? {} : { bunTimeoutMin: legTimeoutMin(g.bunTimeoutMin) }),
  };
}

/** #1080: whether a run's legs may read the one-bundle snapshot. Every block that
 *  runs legs must opt in (a PR that changes fleet.json runs both the base's and the
 *  head's legs). A null or absent block runs no legs and does not count. No block
 *  at all is never an opt-in. A repo whose legs read git history stays off until
 *  range parity exists (docs/operations.md). */
export function bundleOptedIn(blocks: (GateConfig | null | undefined)[]): boolean {
  const present = blocks.filter((b): b is GateConfig => b !== null && b !== undefined);
  return present.length > 0 && present.every((b) => b.bundle === true);
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

/** The verdict a gated repo's PR fails with when its base sha has no valid gate
 *  config (absent, malformed, or a malformed gates entry) and the PR does not
 *  add one (#1132). Visible on the head, never a success: the description names
 *  the base. GitHub caps a description at 140. */
export function noGateBlockFailure(baseSha: string): string {
  return `no valid gate config at base ${baseSha.slice(0, 8)}`;
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

/** One open PR of the resolved head, with the base branch it targets (#1172). */
export interface SharedHeadPull { number: number; baseRef: string }

/** The failure a gated PR's success post becomes when a sibling open PR shares
 *  the head sha with a different base (#1172): red must win across PRs sharing
 *  a head, because one gate/verdict status serves them all. Null when every
 *  open PR of the head shares the base (or only the PR itself is open). */
export function sharedHeadFailure(
  headSha: string, baseRef: string, pr: number, open: SharedHeadPull[],
): string | null {
  for (const pull of open) {
    if (pull.number !== pr && pull.baseRef !== baseRef) {
      return `head ${headSha.slice(0, 8)} shared with PR #${pull.number}`;
    }
  }
  return null;
}

/** The shared-head guard's lookup: the head's open PRs, or an error (fail closed). */
export type SharedHeadLookup = { open: SharedHeadPull[] } | { error: string };

/** The guarded (state, description) of a success post (#1172). A lookup error
 *  fails closed, never success. */
export function guardSuccessStatus(
  headSha: string, baseRef: string, pr: number, lookup: SharedHeadLookup,
  args: { state: "success"; description: string },
): { state: "success" | "failure"; description: string } {
  if ("error" in lookup) return { state: "failure", description: "gate: cannot list shared-head PRs" };
  const failure = sharedHeadFailure(headSha, baseRef, pr, lookup.open);
  return failure === null ? args : { state: "failure", description: failure };
}
