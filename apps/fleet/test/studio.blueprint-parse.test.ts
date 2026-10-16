import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  parseRoleFile, parseFleetJson, assertRoleInFleet, roleBringupEnv,
  BlueprintError, type Role, type FleetConfig,
} from "../src/studio/blueprint";

// A minimal, synthetic pilot.md-shaped fixture — same five REQUIRED
// frontmatter fields (name/skills/allowedTools/reports_to/gates) and shape
// as the real fleet/blueprint/roles/pilot.md (repo root), but kept local so
// these unit tests don't depend on that file's exact prose. Also declares
// may_spawn explicitly (Fleet Spawn P3: optional, default [] — see the
// "optional role fields" describe block below for the absent-field/default
// cases) since pilot.md itself still does. instance_type/keep_alive are
// both optional with no required-presence form, so this fixture omits them
// — their own describe block covers explicit values. The "real files parse"
// describe block in test/studio.blueprint-brief.test.ts is what proves the actual
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
// (see Role.effort's own doc comment) — that's covered separately in
// test/studio.blueprint-brief.test.ts, against roleBringupEnv.
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

  it("the real pilot.md and scratch.md declare no mcp (playwright retired, #293)", () => {
    expect(parseRoleFile(env.TEST_PILOT_ROLE_MD).mcp).toEqual([]);
    expect(parseRoleFile(env.TEST_SCRATCH_ROLE_MD).mcp).toEqual([]);
  });
});
