import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  parseRoleFile, parseFleetJson, assertRoleInFleet, roleBringupEnv, appendBrief, appendHouseRules,
  appendMemoryIndex, HOUSE_RULES,
  type Role,
} from "../src/studio/blueprint";

// ROLE_PROMPT_B64 is base64 of UTF-8 and every prompt now carries the house
// rules, whose em dashes are multi-byte — bare atob() hands back Latin-1 and
// would fail a byte-identity assertion for the wrong reason.
const decodePrompt = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

// Same synthetic pilot.md-shaped fixture as test/studio.blueprint-parse.test.ts,
// duplicated rather than extracted (extraction is sweep-18's lane) — the
// roleBringupEnv describe below parses it through the real parseRoleFile.
const VALID_ROLE_MD = `---
name: pilot
skills: []
allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write
may_spawn: []
reports_to: operator
gates: []
---
You are pilot. Work carefully. Small commits.
`;

describe("roleBringupEnv", () => {
  it("base64-encodes the prompt and passes allowedTools through verbatim", () => {
    const role = parseRoleFile(VALID_ROLE_MD);
    const bringupEnv = roleBringupEnv(role);
    expect(bringupEnv.ROLE_ALLOWED_TOOLS).toBe("Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write");
    expect(decodePrompt(bringupEnv.ROLE_PROMPT_B64)).toBe(appendHouseRules(role.prompt));
  });

  it("round-trips a multi-byte UTF-8 prompt losslessly", () => {
    const role: Role = {
      name: "pilot", skills: [], allowedTools: "Edit", may_spawn: [], reports_to: "operator", gates: [],
      keep_alive: true,
      prompt: "Chinese and emoji in a prompt should survive: 你好 🚀",
    };
    const bringupEnv = roleBringupEnv(role);
    expect(decodePrompt(bringupEnv.ROLE_PROMPT_B64)).toBe(appendHouseRules(role.prompt));
  });
});

describe("roleBringupEnv — ROLE_EFFORT (Fleet CTO effort default, operator directive 2026-08-19)", () => {
  function role(overrides: Partial<Role>): Role {
    return {
      name: "pilot", skills: [], allowedTools: "Edit", may_spawn: [], reports_to: "operator", gates: [],
      keep_alive: true, prompt: "You are a role.",
      ...overrides,
    };
  }

  it('cto role, no explicit effort -> ROLE_EFFORT "max"', () => {
    expect(roleBringupEnv(role({ name: "cto" })).ROLE_EFFORT).toBe("max");
  });

  it('non-cto role, no explicit effort -> ROLE_EFFORT "" (no --effort flag; claude\'s own default)', () => {
    expect(roleBringupEnv(role({ name: "pilot" })).ROLE_EFFORT).toBe("");
  });

  it('cto role WITH an explicit effort -> the explicit value wins over the "max" default', () => {
    expect(roleBringupEnv(role({ name: "cto", effort: "high" })).ROLE_EFFORT).toBe("high");
  });

  it("non-cto role with an explicit effort -> that exact value; the cto-only default never applies", () => {
    expect(roleBringupEnv(role({ name: "pilot", effort: "low" })).ROLE_EFFORT).toBe("low");
  });
});

// Proves the ACTUAL files this task ships (repo root fleet.json,
// fleet/blueprint/roles/pilot.md, fleet/blueprint/org.json) are valid
// against this same parser — not just the synthetic fixtures above.
// workerd has no filesystem; vitest.config.ts reads them on the Node side
// and injects them as TEST_* bindings (same technique
// test/container.args.test.ts uses for container/server.ts, which can't be
// imported either).
describe("the real shipped blueprint files parse cleanly", () => {
  it("fleet.json (repo root)", () => {
    const fleet = parseFleetJson(env.TEST_FLEET_JSON);
    // Migrated 2026-09-12 (367816d): the blueprint repo IS this repo now.
    // The old value outlived the move and reddened main for four days.
    expect(fleet.blueprint.repo).toBe("rafarc21/fleetflare");
    expect(fleet.roles).toContain("pilot");
    // Fleet Spawn P3, Task 4 (R-P3-3): "scratch" declared alongside pilot —
    // see fleet/blueprint/README.md's coherence rule (declared roles = roles
    // with files) and this describe block's own scratch.md tests below.
    expect(fleet.roles).toContain("scratch");
    expect(fleet.instance_type).toBe("standard-2");
  });

  it("fleet/blueprint/roles/pilot.md", () => {
    const role = parseRoleFile(env.TEST_PILOT_ROLE_MD);
    expect(role.name).toBe("pilot");
    expect(role.allowedTools).toBe("Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write");
    expect(role.prompt.length).toBeGreaterThan(0);
    // "~10-line" system prompt, per the task brief — a loose sanity bound,
    // not a byte-exact pin (the prose itself is free to be edited later).
    expect(role.prompt.split("\n").length).toBeGreaterThanOrEqual(8);
  });

  it("the real pilot.md's role is declared in the real fleet.json's roles", () => {
    const fleet = parseFleetJson(env.TEST_FLEET_JSON);
    const role = parseRoleFile(env.TEST_PILOT_ROLE_MD);
    expect(() => assertRoleInFleet(fleet, role.name)).not.toThrow();
  });

  it("fleet/blueprint/org.json is at least valid JSON with the expected top-level shape", () => {
    const org = JSON.parse(env.TEST_ORG_JSON) as { edges: unknown; gates: unknown };
    expect(org.edges).toBeTruthy();
    expect(org.gates).toBeTruthy();
  });

  // Fleet Spawn P3, Task 3: the real `scratch` role this task ships —
  // same fixture-binding technique as pilot.md above (TEST_SCRATCH_ROLE_MD,
  // vitest.config.ts), proving the ACTUAL shipped file against this same
  // parser rather than a synthetic fixture.
  it("fleet/blueprint/roles/scratch.md", () => {
    const role = parseRoleFile(env.TEST_SCRATCH_ROLE_MD);
    expect(role.name).toBe("scratch");
    expect(role.allowedTools).toBe("Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write");
    expect(role.may_spawn).toEqual([]);
    expect(role.reports_to).toBe("operator");
    expect(role.gates).toEqual([]);
    // keep_alive is omitted from the frontmatter on purpose ("keep_alive
    // true implied" — the task brief's own wording); parseRoleFile's default
    // is what actually makes that true, asserted here so a future edit that
    // adds an explicit `keep_alive: false` cannot silently change scratch's
    // cost posture without failing this test.
    expect(role.keep_alive).toBe(true);
    // "6-8 line real prompt" per the task brief — a loose sanity bound, same
    // spirit as pilot.md's own "~10-line" check above, not a byte-exact pin.
    expect(role.prompt.split("\n").length).toBeGreaterThanOrEqual(6);
    expect(role.prompt.split("\n").length).toBeLessThanOrEqual(8);
  });

  // Fleet Spawn P3, Task 4 (R-P3-3): the real scratch.md's role is now
  // declared in the real fleet.json's roles too — same assertRoleInFleet
  // proof pilot.md's own test above runs, now true for scratch as well.
  it("the real scratch.md's role is declared in the real fleet.json's roles", () => {
    const fleet = parseFleetJson(env.TEST_FLEET_JSON);
    const role = parseRoleFile(env.TEST_SCRATCH_ROLE_MD);
    expect(() => assertRoleInFleet(fleet, role.name)).not.toThrow();
  });

  // Fleet Spawn P3, Task 4 (R-P3-3): the blueprint README's coherence rule —
  // source-pinned the same way every other file in this describe block is
  // (raw text via vitest.config.ts, since workerd has no filesystem), so a
  // future edit that drops the rule's own wording fails a test, not just a
  // manual re-read. Substring checks, not a byte-exact pin: the file is free
  // to be reworded around these two load-bearing phrases.
  it("fleet/blueprint/README.md documents the roles-vs-files coherence rule", () => {
    const readme = env.TEST_BLUEPRINT_README;
    expect(readme).toContain("roles with files");
    expect(readme.toLowerCase()).toContain("org.json");
    expect(readme.toLowerCase()).toContain("edges");
    expect(readme.toLowerCase()).toContain("fleet.json");
  });

  // Fleet Spawn P3, Task 3: org.json's two new edges (additive — cto's own
  // edge, asserted above, is untouched). Same file, same real-fixture read;
  // the maySpawn *behavior* these edges drive is covered directly against
  // the real file in test/studio.org.test.ts and test/studio.spawn.test.ts.
  it("fleet/blueprint/org.json declares the operator and pilot edges, no dead cto edge (board issue #10)", () => {
    const org = JSON.parse(env.TEST_ORG_JSON) as { edges: Record<string, string[]> };
    expect(org.edges.operator)
      .toEqual(["pilot", "scratch", "maestro", "web-studio", "release-studio"]);
    expect(org.edges.pilot).toEqual(["scratch"]);
    expect(org.edges.cto).toBeUndefined();
  });

  // P4a-1 fix wave (Important #4): all three studios were unspawnable — every
  // request 403'd on the org edges, then 400'd on fleet.json's roles. Both
  // halves declared here now. Edge shape follows spec decision 13: the
  // operator reaches the Maestro, the Maestro spawns the studios.
  it("fleet/blueprint/org.json + fleet.json make all three studios spawnable (P4a-1 fix wave)", () => {
    const org = JSON.parse(env.TEST_ORG_JSON) as { edges: Record<string, string[]> };
    expect(org.edges.operator).toContain("maestro");
    expect(org.edges.maestro).toEqual(["web-studio", "release-studio"]);
    const fleet = parseFleetJson(env.TEST_FLEET_JSON);
    for (const studio of ["maestro", "web-studio", "release-studio"]) {
      expect(fleet.roles).toContain(studio);
      expect(() => assertRoleInFleet(fleet, studio)).not.toThrow();
    }
    // P4a-2 REVERSES the "operator reaches only the Maestro" half of the
    // line above, deliberately, and the reason is that it never held anything
    // shut: POST /studio/:id/provision runs NO org check at all
    // (src/studio/routes.ts), so the human could always build a web-studio —
    // the edge only decided whether the SPAWN verb agreed with that. `ff
    // <role>` is the operator's own command and its shipped help text already
    // names web-studio and release-studio, so refusing them made the command
    // lie. The Maestro's own fan-out edge is untouched, and remains the path
    // §7 fans out through.
    expect(org.edges.operator).toContain("web-studio");
    expect(org.edges.operator).toContain("release-studio");
  });
});

describe("appendBrief / roleBringupEnv — brief injection (P4a-2)", () => {
  const ROLE: Role = {
    name: "scratch", skills: [], allowedTools: "Edit", may_spawn: [], reports_to: "operator",
    gates: [], keep_alive: true, prompt: "You are scratch.",
  };

  it("no brief leaves the prompt byte-identical — every studio spawned without a task", () => {
    expect(appendBrief("You are scratch.", undefined)).toBe("You are scratch.");
    expect(appendBrief("You are scratch.", "   ")).toBe("You are scratch.");
    // Byte-identical up to the house rules every prompt now carries
    // unconditionally (appendHouseRules) — nothing the BRIEF path added.
    expect(decodePrompt(roleBringupEnv(ROLE).ROLE_PROMPT_B64)).toBe(appendHouseRules("You are scratch."));
  });

  it("a brief rides in the SAME ROLE_PROMPT_B64, appended after the role prompt", () => {
    const encoded = roleBringupEnv(ROLE, "## Your task — board issue #71").ROLE_PROMPT_B64;
    // Decoded through TextDecoder, not bare atob: the brief is UTF-8 and atob
    // hands back Latin-1 code units.
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    // One mechanism, not two: no second env var for bring-up to decode.
    expect(decoded.startsWith("You are scratch.")).toBe(true);
    expect(decoded).toContain("## Your task — board issue #71");
    expect(Object.keys(roleBringupEnv(ROLE, "x")))
      .toEqual(["ROLE_PROMPT_B64", "ROLE_ALLOWED_TOOLS", "ROLE_EFFORT", "ROLE_MCP"]);
  });

  it("a multi-byte brief round-trips losslessly, same as the prompt itself", () => {
    const brief = "## Your task — naïve café #71 🚀";
    const bytes = Uint8Array.from(atob(roleBringupEnv(ROLE, brief).ROLE_PROMPT_B64), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toContain(brief);
  });

  it("leaves allowedTools and effort untouched — a brief is not a policy change", () => {
    const withBrief = roleBringupEnv(ROLE, "brief");
    const without = roleBringupEnv(ROLE);
    expect(withBrief.ROLE_ALLOWED_TOOLS).toBe(without.ROLE_ALLOWED_TOOLS);
    expect(withBrief.ROLE_EFFORT).toBe(without.ROLE_EFFORT);
  });
});

// Issue #330 (public-release prep): HOUSE_RULES used to bake in one
// operator's own preferences as an unconditional product default — a
// communication-style mandate ("caveman" + "i-have-adhd"), a broken-URL
// example naming that operator's own infra, and two paragraphs hardcoding
// that operator's own repo slug (rafarc21/fleetflare) as THE repo, which is
// wrong copy for every other operator's normal case. Fixed: that content
// moves to the operator's OWN blueprint repo, loaded as an optional overlay
// (see resolveOperatorHouseRules in provision.ts), and the shipped default
// below is neutral.
describe("HOUSE_RULES — neutral default (issue #330)", () => {
  // Round 2 review's own verification list (no communication-style mandate,
  // no operator-specific infra names) — widened from round 1's four terms
  // to all six named there, so this test actually covers what was verified.
  it("contains none of the operator-specific strings that used to be hardcoded", () => {
    const lower = HOUSE_RULES.toLowerCase();
    for (const forbidden of ["caveman", "i-have-adhd", "acme", "examplehost", "rafarc21/fleetflare", "ego-browser"]) {
      expect(lower).not.toContain(forbidden);
    }
  });
});

describe("appendHouseRules — operator overlay (issue #330)", () => {
  it("absent overlay (undefined) -> identical to today's neutral-only prompt", () => {
    expect(appendHouseRules("You are scratch.", undefined)).toBe(appendHouseRules("You are scratch."));
  });

  it("absent overlay (null, the resolveOperatorHouseRules 404 case) -> identical to today's neutral-only prompt", () => {
    expect(appendHouseRules("You are scratch.", null)).toBe(appendHouseRules("You are scratch."));
  });

  it("blank overlay (whitespace only) -> identical to the neutral-only prompt, same trim rule as appendBrief/appendMemoryIndex", () => {
    expect(appendHouseRules("You are scratch.", "   \n  ")).toBe(appendHouseRules("You are scratch."));
  });

  it("a present overlay is appended AFTER the neutral HOUSE_RULES block", () => {
    const overlay = "## Operator house rules — private overlay\n\nSay it caveman-style, always.";
    const withOverlay = appendHouseRules("You are scratch.", overlay);
    expect(withOverlay).toContain(overlay);
    expect(withOverlay.indexOf(HOUSE_RULES)).toBeLessThan(withOverlay.indexOf(overlay));
    // Neutral default is untouched, not replaced — the overlay is additive.
    expect(withOverlay).toContain(HOUSE_RULES);
  });

  it("ordering: the overlay lands BEFORE memory index and brief, same innermost-first composition appendHouseRules's own doc comment establishes for the neutral default", () => {
    const overlay = "## Operator house rules — private overlay\n\nExtra rule.";
    const composed = appendBrief(
      appendMemoryIndex(appendHouseRules("You are scratch.", overlay), "## Memory index\n\nSome memory."),
      "## Your task — board issue #330",
    );
    const overlayIdx = composed.indexOf(overlay);
    const memoryIdx = composed.indexOf("## Memory index");
    const briefIdx = composed.indexOf("## Your task — board issue #330");
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(briefIdx);
  });
});
