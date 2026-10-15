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

export interface GateConfig {
  install: string;
  legs: string[];
  vitestCmd: string;
  pathRules: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Returns null on anything malformed — never throws. A repo with no `gate`
 *  block, or a malformed one, gets the Workflow's own "skip, don't guess"
 *  behavior (Task 14), not a crash. */
export function parseGateConfig(fleetJson: unknown): GateConfig | null {
  if (typeof fleetJson !== "object" || fleetJson === null) return null;
  const gate = (fleetJson as Record<string, unknown>).gate;
  if (typeof gate !== "object" || gate === null) return null;
  const g = gate as Record<string, unknown>;
  if (typeof g.install !== "string") return null;
  if (!isStringArray(g.legs)) return null;
  if (typeof g.vitestCmd !== "string") return null;
  if (!isStringArray(g.pathRules)) return null;
  return { install: g.install, legs: g.legs, vitestCmd: g.vitestCmd, pathRules: g.pathRules };
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
