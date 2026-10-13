import type { ProvisionDeps } from "../../src/studio/provision";

// Sweep 33 F6 (refs #750 / #733): the canned blueprint triple — fleet.json,
// org.json, one role .md — that 7 suites each hand-wrote as private consts.
// Divergence between the suites is load-bearing (role lists, refs, org
// edges, role-md contents encode each suite's own org shape), so this is a
// builder with options, never one shared literal: roles and repo are
// REQUIRED (no default could merge two suites' shapes silently), and every
// default that exists is the census majority value the 7 suites already
// agree on byte-for-byte (ref "main", edges {cto:["release"]}, gates
// {merge:["release"]}, the pilot-era allowedTools string, reportsTo
// "operator").

/** The majority allowedTools string — 4 of the 7 suites spell exactly this;
 *  the rest pass their own. */
export const DEFAULT_BLUEPRINT_ALLOWED_TOOLS = "Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write";

export interface FakeBlueprintOpts {
  /** blueprint.repo, e.g. "acme-org/websites" — REQUIRED. */
  repo: string;
  /** blueprint.ref — default "main". */
  ref?: string;
  /** The roles fleet.json declares — REQUIRED, no default (load-bearing
   *  per-suite divergence). */
  roles: string[];
  roleMd: {
    name: string;
    prompt: string;
    /** Frontmatter allowedTools — defaults to the majority string. */
    allowedTools?: string;
    /** Frontmatter reports_to — default "operator". */
    reportsTo?: string;
    /** Adds the `keep_alive: false` frontmatter line (routes suites' R-P3-6
     *  variant). Absent = no keep_alive line at all, the default shape. */
    keepAliveFalse?: boolean;
  };
  /** org.json edges — default { cto: ["release"] }. */
  edges?: Record<string, string[]>;
  /** org.json gates — default { merge: ["release"] }. */
  gates?: Record<string, string[]>;
}

export interface FakeBlueprintFiles {
  fleetJson: string;
  orgJson: string;
  roleMd: string;
}

/** Builds the triple. The fleet.json key order matches what the suites
 *  hand-wrote (blueprint/roles/instance_type, one line); the role md's
 *  frontmatter field order is verbatim (name/skills/allowedTools/may_spawn/
 *  reports_to/gates, optional keep_alive) — both round-trip through the real
 *  parseFleetJson/parseRoleFile, which every consumer depends on. */
export function fakeBlueprintFiles(opts: FakeBlueprintOpts): FakeBlueprintFiles {
  const {
    repo, roles, roleMd,
    ref = "main",
    edges = { cto: ["release"] },
    gates = { merge: ["release"] },
  } = opts;
  const allowedTools = roleMd.allowedTools ?? DEFAULT_BLUEPRINT_ALLOWED_TOOLS;
  const reportsTo = roleMd.reportsTo ?? "operator";
  const keepAliveLine = roleMd.keepAliveFalse ? "keep_alive: false\n" : "";
  return {
    fleetJson: JSON.stringify({
      blueprint: { repo, ref }, roles, instance_type: "standard-2",
    }),
    orgJson: JSON.stringify({ edges, gates }),
    roleMd: `---
name: ${roleMd.name}
skills: []
allowedTools: ${allowedTools}
may_spawn: []
reports_to: ${reportsTo}
gates: []
${keepAliveLine}---
${roleMd.prompt}
`,
  };
}

/** The endsWith-style path dispatcher the routes/refresh/spawn suites'
 *  hand-written fakeFetchBlueprintFile used: fleet.json / org.json / any
 *  .md route to the built triple, anything else throws. Satisfies
 *  ProvisionDeps["fetchBlueprintFile"]'s type exactly. */
export function fakeBlueprintFetch(files: FakeBlueprintFiles): ProvisionDeps["fetchBlueprintFile"] {
  return async (_repo: string, path: string) => {
    if (path.endsWith("fleet.json")) return files.fleetJson;
    if (path.endsWith("org.json")) return files.orgJson;
    if (path.endsWith(".md")) return files.roleMd;
    throw new Error(`fakeBlueprintFetch: unexpected path ${path}`);
  };
}
