import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  parseRoleFile, parseFleetJson, assertRoleInFleet, roleBringupEnv, appendBrief, appendHouseRules,
  appendMemoryIndex, HOUSE_RULES,
  BlueprintError, type Role, type FleetConfig,
} from "../src/studio/blueprint";

// ROLE_PROMPT_B64 is base64 of UTF-8 and every prompt now carries the house
// rules, whose em dashes are multi-byte — bare atob() hands back Latin-1 and
// would fail a byte-identity assertion for the wrong reason.
const decodePrompt = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

// A minimal, synthetic pilot.md-shaped fixture — same five REQUIRED
// frontmatter fields (name/skills/allowedTools/reports_to/gates) and shape
// as the real fleet/blueprint/roles/pilot.md (repo root), but kept local so
// these unit tests don't depend on that file's exact prose. Also declares
// may_spawn explicitly (Fleet Spawn P3: optional, default [] — see the
// "optional role fields" describe block below for the absent-field/default
// cases) since pilot.md itself still does. instance_type/keep_alive are
// both optional with no required-presence form, so this fixture omits them
// — their own describe block covers explicit values. The "real files parse"
// describe block at the bottom of this file is what proves the actual
// shipped files (fleet.json, pilot.md, org.json) are valid against this
// same parser — see its own header comment for how it reads them (workerd
// has no filesystem, so they're injected via vitest.config.ts, the same
// TEST_CONTAINER_SERVER_SRC technique test/container.args.test.ts already
// uses for container/server.ts).
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

const VALID_FLEET_JSON = JSON.stringify({
  blueprint: { repo: "acme-org/websites", ref: "main" },
  roles: ["pilot"],
  instance_type: "standard-2",
});

describe("parseRoleFile", () => {
  it("parses a valid role file: the five required frontmatter fields, may_spawn, keep_alive's default, and the trimmed body as prompt", () => {
    const role = parseRoleFile(VALID_ROLE_MD);
    expect(role).toEqual<Role>({
      name: "pilot",
      skills: [],
      allowedTools: "Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write",
      may_spawn: [],
      reports_to: "operator",
      gates: [],
      keep_alive: true,
      mcp: [],
      prompt: "You are pilot. Work carefully. Small commits.",
    });
  });

  it("parses simple non-empty arrays (comma-split, optionally quoted)", () => {
    const md = VALID_ROLE_MD.replace("skills: []", 'skills: [design, "full-stack-dev"]')
      .replace("may_spawn: []", "may_spawn: [dev, qa]")
      .replace("gates: []", "gates: [merge]");
    const role = parseRoleFile(md);
    expect(role.skills).toEqual(["design", "full-stack-dev"]);
    expect(role.may_spawn).toEqual(["dev", "qa"]);
    expect(role.gates).toEqual(["merge"]);
  });

  it("missing allowedTools -> BlueprintError naming the field", () => {
    const md = VALID_ROLE_MD.replace("allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write\n", "");
    expect(() => parseRoleFile(md)).toThrow(BlueprintError);
    try {
      parseRoleFile(md);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintError);
      expect((err as BlueprintError).field).toBe("allowedTools");
      expect((err as BlueprintError).message).toContain("allowedTools");
    }
  });

  it.each(["name", "skills", "reports_to", "gates"])(
    "missing %s -> BlueprintError naming that field",
    (field) => {
      const lineRe = new RegExp(`^${field}:.*$\\n?`, "m");
      const md = VALID_ROLE_MD.replace(lineRe, "");
      expect(() => parseRoleFile(md)).toThrow(BlueprintError);
      try {
        parseRoleFile(md);
        expect.unreachable();
      } catch (err) {
        expect((err as BlueprintError).field).toBe(field);
      }
    },
  );

  it.each(["name", "allowedTools", "reports_to"])(
    "empty (present but blank) %s -> BlueprintError naming that field, not a silently-empty value",
    (field) => {
      const lineRe = new RegExp(`^${field}:.*$`, "m");
      const md = VALID_ROLE_MD.replace(lineRe, `${field}:`); // present, empty value
      expect(() => parseRoleFile(md)).toThrow(BlueprintError);
      try {
        parseRoleFile(md);
        expect.unreachable();
      } catch (err) {
        expect((err as BlueprintError).field).toBe(field);
      }
    },
  );

  it("empty (present but blank) skills/may_spawn/gates is NOT an error — [] is a legitimate value, not a violation", () => {
    // A blank scalar-looking value for an array field fails parseSimpleArray's
    // own "must look like [...]" check (a different, pre-existing error path)
    // — this test is really about REQUIRED_NONEMPTY_ROLE_FIELDS correctly
    // excluding the three array fields, using the one legitimate empty form
    // they actually take: the literal `[]` pilot.md itself ships.
    const role = parseRoleFile(VALID_ROLE_MD); // skills: [], may_spawn: [], gates: [] already
    expect(role.skills).toEqual([]);
    expect(role.may_spawn).toEqual([]);
    expect(role.gates).toEqual([]);
  });

  it("malformed frontmatter: no opening --- delimiter -> BlueprintError", () => {
    expect(() => parseRoleFile("name: pilot\nprompt body\n")).toThrow(BlueprintError);
  });

  it("malformed frontmatter: no closing --- delimiter -> BlueprintError", () => {
    const md = "---\nname: pilot\nallowedTools: Edit\n\nno closing delimiter here";
    expect(() => parseRoleFile(md)).toThrow(BlueprintError);
  });

  it("malformed frontmatter: a line with no colon -> BlueprintError", () => {
    const md = "---\nname: pilot\nthis line has no colon\nallowedTools: Edit\n---\nprompt\n";
    expect(() => parseRoleFile(md)).toThrow(BlueprintError);
  });

  it("empty body -> BlueprintError (a role without a prompt is invalid)", () => {
    const md = "---\nname: pilot\nskills: []\nallowedTools: Edit\nmay_spawn: []\nreports_to: operator\ngates: []\n---\n\n   \n";
    expect(() => parseRoleFile(md)).toThrow(BlueprintError);
    try {
      parseRoleFile(md);
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("prompt");
    }
  });
});

// Fleet Spawn P3, Task 1: may_spawn moved from REQUIRED_ROLE_FIELDS to
// optional-with-default (R-P3-6's blueprint frontmatter extension), and
// gained two siblings — instance_type (string, no default: absent means
// "fall back to fleet.json's own instance_type", per R-P3-3) and keep_alive
// (boolean, default true — "studios burn credits deliberately"). All three
// are optional so existing role files (may_spawn aside, which pilot.md
// already declares) are unaffected by this change.
describe("optional role fields (may_spawn / instance_type / keep_alive)", () => {
  // VALID_ROLE_MD minus its may_spawn line — the "never declared at all"
  // case, distinct from the "present but blank" case parseSimpleArray
  // already rejects (that path is unaffected by this task).
  const ROLE_MD_NO_OPTIONAL_FIELDS = VALID_ROLE_MD.replace(/^may_spawn:.*$\n?/m, "");

  it("may_spawn absent entirely -> defaults to [], no error", () => {
    const role = parseRoleFile(ROLE_MD_NO_OPTIONAL_FIELDS);
    expect(role.may_spawn).toEqual([]);
  });

  it("instance_type absent -> undefined (no default; caller falls back to fleet.json)", () => {
    const role = parseRoleFile(ROLE_MD_NO_OPTIONAL_FIELDS);
    expect(role.instance_type).toBeUndefined();
  });

  it("keep_alive absent -> defaults to true", () => {
    const role = parseRoleFile(ROLE_MD_NO_OPTIONAL_FIELDS);
    expect(role.keep_alive).toBe(true);
  });

  it("explicit instance_type is parsed as a plain string", () => {
    const md = ROLE_MD_NO_OPTIONAL_FIELDS.replace("---\nYou are pilot", "instance_type: standard-4\n---\nYou are pilot");
    expect(parseRoleFile(md).instance_type).toBe("standard-4");
  });

  // Fix round (Minor, folded): a PRESENT-but-blank instance_type used to
  // parse to "" — silently defeating a later `fields.instance_type ??
  // fleetInstanceType` fallback (`??` only falls back on null/undefined,
  // not on ""). Absent is still fine (undefined, "no override" — the test
  // above this block already covers that); only present-and-blank is now
  // an error, same "no silently-wrong value" rule the three REQUIRED
  // scalar fields already enforce.
  it("instance_type present but blank -> BlueprintError naming it, not a silently-empty override", () => {
    const md = ROLE_MD_NO_OPTIONAL_FIELDS.replace("---\nYou are pilot", "instance_type:\n---\nYou are pilot");
    try {
      parseRoleFile(md);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintError);
      expect((err as BlueprintError).field).toBe("instance_type");
    }
  });

  it("instance_type absent (not merely blank) still parses cleanly to undefined", () => {
    // Same fixture the earlier "absent -> undefined" test uses — repeated
    // here, right beside the blank-rejection test above, so the two
    // "missing" vs. "present but empty" cases read as one deliberate pair
    // rather than two tests that happen to live in different places.
    expect(parseRoleFile(ROLE_MD_NO_OPTIONAL_FIELDS).instance_type).toBeUndefined();
  });

  it("explicit keep_alive: false overrides the default", () => {
    const md = ROLE_MD_NO_OPTIONAL_FIELDS.replace("---\nYou are pilot", "keep_alive: false\n---\nYou are pilot");
    expect(parseRoleFile(md).keep_alive).toBe(false);
  });

  it("explicit keep_alive: true parses the same as the default (not merely absent-and-defaulted)", () => {
    const md = ROLE_MD_NO_OPTIONAL_FIELDS.replace("---\nYou are pilot", "keep_alive: true\n---\nYou are pilot");
    expect(parseRoleFile(md).keep_alive).toBe(true);
  });

  it("keep_alive with a malformed value -> BlueprintError naming it", () => {
    const md = ROLE_MD_NO_OPTIONAL_FIELDS.replace("---\nYou are pilot", "keep_alive: yes\n---\nYou are pilot");
    try {
      parseRoleFile(md);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintError);
      expect((err as BlueprintError).field).toBe("keep_alive");
    }
  });

  it("all three together: explicit may_spawn + instance_type + keep_alive:false", () => {
    const md = VALID_ROLE_MD
      .replace("may_spawn: []", "may_spawn: [scratch]")
      .replace("---\nYou are pilot", "instance_type: standard-4\nkeep_alive: false\n---\nYou are pilot");
    const role = parseRoleFile(md);
    expect(role.may_spawn).toEqual(["scratch"]);
    expect(role.instance_type).toBe("standard-4");
    expect(role.keep_alive).toBe(false);
  });
});

// Fleet CTO effort default (operator directive 2026-08-19): effort is
// optional, validated against claude's own accepted levels when present —
// same "absent vs. present-but-wrong" testing shape as instance_type's own
// describe block above. The cto->"max" default is NOT parse-time behavior
// (see Role.effort's own doc comment) — that's covered separately, below,
// against roleBringupEnv.
describe("optional role field: effort (Fleet CTO effort default, operator directive 2026-08-19)", () => {
  const ROLE_MD_NO_OPTIONAL_FIELDS = VALID_ROLE_MD.replace(/^may_spawn:.*$\n?/m, "");

  it("effort absent -> undefined (no default at parse time; the cto->max default applies downstream, in roleBringupEnv)", () => {
    expect(parseRoleFile(ROLE_MD_NO_OPTIONAL_FIELDS).effort).toBeUndefined();
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("effort present and valid (%s) parses as a plain string", (level) => {
    const md = ROLE_MD_NO_OPTIONAL_FIELDS.replace("---\nYou are pilot", `effort: ${level}\n---\nYou are pilot`);
    expect(parseRoleFile(md).effort).toBe(level);
  });

  it("effort present but invalid -> BlueprintError naming it", () => {
    const md = ROLE_MD_NO_OPTIONAL_FIELDS.replace("---\nYou are pilot", "effort: turbo\n---\nYou are pilot");
    try {
      parseRoleFile(md);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintError);
      expect((err as BlueprintError).field).toBe("effort");
      expect((err as BlueprintError).message).toContain("effort");
    }
  });

  it("effort present but blank -> BlueprintError naming it, not a silently-empty override", () => {
    const md = ROLE_MD_NO_OPTIONAL_FIELDS.replace("---\nYou are pilot", "effort:\n---\nYou are pilot");
    try {
      parseRoleFile(md);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintError);
      expect((err as BlueprintError).field).toBe("effort");
    }
  });
});

describe("parseFleetJson", () => {
  it("parses a valid fleet.json", () => {
    expect(parseFleetJson(VALID_FLEET_JSON)).toEqual<FleetConfig>({
      blueprint: { repo: "acme-org/websites", ref: "main" },
      roles: ["pilot"],
      instance_type: "standard-2",
    });
  });

  it("invalid JSON syntax -> BlueprintError", () => {
    expect(() => parseFleetJson("{not json")).toThrow(BlueprintError);
  });

  it("missing blueprint.repo -> BlueprintError naming it", () => {
    const s = JSON.stringify({ blueprint: { ref: "main" }, roles: ["pilot"], instance_type: "standard-2" });
    try {
      parseFleetJson(s);
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("blueprint.repo");
    }
  });

  it("missing blueprint.ref -> BlueprintError naming it", () => {
    const s = JSON.stringify({ blueprint: { repo: "o/r" }, roles: ["pilot"], instance_type: "standard-2" });
    try {
      parseFleetJson(s);
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("blueprint.ref");
    }
  });

  it("missing roles array -> BlueprintError naming it", () => {
    const s = JSON.stringify({ blueprint: { repo: "o/r", ref: "main" }, instance_type: "standard-2" });
    try {
      parseFleetJson(s);
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("roles");
    }
  });

  it("missing instance_type -> BlueprintError naming it", () => {
    const s = JSON.stringify({ blueprint: { repo: "o/r", ref: "main" }, roles: ["pilot"] });
    try {
      parseFleetJson(s);
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("instance_type");
    }
  });

  // Board issue #105 (pre-gate): an optional shell command a lead's
  // `fleet task report` runs before posting a "result"/"ok" envelope — see
  // container/studio-fleet's own runPreflight/evaluatePreGate for the
  // enforcement (that binary duplicates this same parse rather than
  // importing this file — see its own header on zero relative imports).
  // Same "absent -> undefined, present-but-blank throws" shape as
  // Role.instance_type above: no repo declaring this feature is the
  // overwhelming common case, and "no opinion" must stay distinguishable
  // from "explicitly run nothing".
  describe("optional field: preflight (board issue #105, pre-gate)", () => {
    it("absent -> undefined, no error", () => {
      expect(parseFleetJson(VALID_FLEET_JSON).preflight).toBeUndefined();
    });

    it("present -> parsed as a plain string", () => {
      const s = JSON.stringify({
        blueprint: { repo: "o/r", ref: "main" }, roles: ["pilot"], instance_type: "standard-2",
        preflight: "bun run check:fast",
      });
      expect(parseFleetJson(s).preflight).toBe("bun run check:fast");
    });

    it("present but blank -> BlueprintError naming it, not a silently-empty override", () => {
      const s = JSON.stringify({
        blueprint: { repo: "o/r", ref: "main" }, roles: ["pilot"], instance_type: "standard-2", preflight: "",
      });
      try {
        parseFleetJson(s);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(BlueprintError);
        expect((err as BlueprintError).field).toBe("preflight");
      }
    });

    it("present but not a string -> BlueprintError naming it", () => {
      const s = JSON.stringify({
        blueprint: { repo: "o/r", ref: "main" }, roles: ["pilot"], instance_type: "standard-2", preflight: 7,
      });
      try {
        parseFleetJson(s);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(BlueprintError);
        expect((err as BlueprintError).field).toBe("preflight");
      }
    });
  });
});

describe("assertRoleInFleet", () => {
  it("does not throw when the role is declared", () => {
    const fleet = parseFleetJson(VALID_FLEET_JSON);
    expect(() => assertRoleInFleet(fleet, "pilot")).not.toThrow();
  });

  it("fleet.json with the requested role not in blueprint roles -> BlueprintError naming it", () => {
    const fleet = parseFleetJson(
      JSON.stringify({ blueprint: { repo: "o/r", ref: "main" }, roles: ["dev", "qa"], instance_type: "standard-2" }),
    );
    expect(() => assertRoleInFleet(fleet, "pilot")).toThrow(BlueprintError);
    try {
      assertRoleInFleet(fleet, "pilot");
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).message).toContain("pilot");
    }
  });
});

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

// Issue #276: roles honor `mcp:` the same way studios do. Optional on a role
// (absent -> []), same "[] or [a, b]" syntax, carried to bring-up as ROLE_MCP.
describe("optional role field: mcp (issue #276)", () => {
  it("mcp absent -> [] and ROLE_MCP is empty", () => {
    const role = parseRoleFile(VALID_ROLE_MD);
    expect(role.mcp).toEqual([]);
    expect(roleBringupEnv(role).ROLE_MCP).toBe("");
  });

  it("mcp: [playwright] -> parsed, and ROLE_MCP carries it comma-joined like STUDIO_MCP", () => {
    const role = parseRoleFile(VALID_ROLE_MD.replace("gates: []", "gates: []\nmcp: [playwright, other]"));
    expect(role.mcp).toEqual(["playwright", "other"]);
    expect(roleBringupEnv(role).ROLE_MCP).toBe("playwright,other");
  });

  it("malformed mcp -> BlueprintError naming the field", () => {
    expect(() => parseRoleFile(VALID_ROLE_MD.replace("gates: []", "gates: []\nmcp: playwright")))
      .toThrow(expect.objectContaining({ field: "mcp" }));
  });

  it("the real pilot.md and scratch.md declare the playwright MCP", () => {
    expect(parseRoleFile(env.TEST_PILOT_ROLE_MD).mcp).toEqual(["playwright"]);
    expect(parseRoleFile(env.TEST_SCRATCH_ROLE_MD).mcp).toEqual(["playwright"]);
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
