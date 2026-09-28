import { describe, expect, test } from "bun:test";
import { parseStudioFile, validateMemberFile, TIER0_SKILLS, studioBringupEnv } from "../src/studio/studio-blueprint";
import { appendHouseRules, BlueprintError } from "../src/studio/blueprint";

const VALID = `---
name: web-studio
title: Web Studio
lead: Web Designer
skills: [frontend-design, qa]
secrets: [UNSPLASH_KEY]
mcp: [playwright]
allowedTools: Bash(git *) Read
---
You are the Web Designer, lead of Web Studio. Dispatch members; never implement.`;

const MEMBER = `---
name: frontend-developer
description: implements frontend steps dispatched by the lead
tools: Read, Edit, Write, Bash
---
You are the Frontend Developer of Web Studio. Implement exactly the dispatched step.`;

describe("parseStudioFile", () => {
  test("parses a valid studio file", () => {
    const s = parseStudioFile(VALID);
    expect(s.name).toBe("web-studio");
    expect(s.title).toBe("Web Studio");
    expect(s.lead).toBe("Web Designer");
    expect(s.skills).toEqual(["frontend-design", "qa"]);
    expect(s.secrets).toEqual(["UNSPLASH_KEY"]);
    expect(s.mcp).toEqual(["playwright"]);
    expect(s.keep_alive).toBe(true);
    expect(s.prompt).toContain("never implement");
  });
  test("empty secrets/mcp arrays are legal", () => {
    const s = parseStudioFile(VALID.replace("secrets: [UNSPLASH_KEY]", "secrets: []").replace("mcp: [playwright]", "mcp: []"));
    expect(s.secrets).toEqual([]);
    expect(s.mcp).toEqual([]);
  });
  test("missing required field names the field", () => {
    expect(() => parseStudioFile(VALID.replace("title: Web Studio\n", ""))).toThrow(BlueprintError);
    try { parseStudioFile(VALID.replace("title: Web Studio\n", "")); } catch (e) {
      expect((e as BlueprintError).field).toBe("title");
    }
  });
  test("invalid effort rejected", () => {
    expect(() => parseStudioFile(VALID.replace("---\nYou", "effort: turbo\n---\nYou"))).toThrow(BlueprintError);
  });
  test("empty body rejected", () => {
    const noBody = VALID.slice(0, VALID.lastIndexOf("---") + 3);
    expect(() => parseStudioFile(noBody)).toThrow(BlueprintError);
  });
});

describe("validateMemberFile", () => {
  test("valid member passes, returns name + raw untouched", () => {
    const m = validateMemberFile("frontend-developer.md", MEMBER);
    expect(m.name).toBe("frontend-developer");
    expect(m.raw).toBe(MEMBER);
  });
  test("filename/name mismatch rejected", () => {
    expect(() => validateMemberFile("qa-engineer.md", MEMBER)).toThrow(BlueprintError);
  });
  test("missing description rejected", () => {
    expect(() => validateMemberFile("frontend-developer.md", MEMBER.replace(/description:.*\n/, ""))).toThrow(BlueprintError);
  });
  test("more than 12 tools rejected", () => {
    const fat = MEMBER.replace(/tools:.*/, "tools: " + Array.from({length: 13}, (_, i) => `T${i}`).join(", "));
    expect(() => validateMemberFile("frontend-developer.md", fat)).toThrow(BlueprintError);
  });
});

describe("studioBringupEnv", () => {
  const studio = parseStudioFile(VALID);
  const members = [validateMemberFile("frontend-developer.md", MEMBER)];
  test("tier0 always present, deduped, before domain skills", () => {
    const env = studioBringupEnv(studio, members);
    const skills = env.STUDIO_SKILLS.split(",");
    for (const t0 of TIER0_SKILLS) expect(skills).toContain(t0);
    expect(skills).toContain("frontend-design");
    expect(new Set(skills).size).toBe(skills.length);
  });
  test("members round-trip through the b64 bundle", () => {
    const env = studioBringupEnv(studio, members);
    const bundle = JSON.parse(Buffer.from(env.STUDIO_MEMBERS_B64, "base64").toString("utf8")) as Record<string, string>;
    expect(Buffer.from(bundle["frontend-developer.md"], "base64").toString("utf8")).toBe(MEMBER);
  });
  test("maestro defaults to effort max, others empty", () => {
    const maestro = parseStudioFile(VALID.replace("name: web-studio", "name: maestro"));
    expect(studioBringupEnv(maestro, []).ROLE_EFFORT).toBe("max");
    expect(studioBringupEnv(studio, members).ROLE_EFFORT).toBe("");
  });
  test("explicit effort beats the maestro default", () => {
    const m = parseStudioFile(VALID.replace("name: web-studio", "name: maestro").replace("---\nYou", "effort: high\n---\nYou"));
    expect(studioBringupEnv(m, []).ROLE_EFFORT).toBe("high");
  });
});

describe("studioBringupEnv — brief injection (P4a-2)", () => {
  const studio = parseStudioFile(VALID);
  const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

  test("appends the brief to the lead prompt inside ROLE_PROMPT_B64, adding no new env var", () => {
    const withBrief = studioBringupEnv(studio, [], "## Your task — board issue #71");
    expect(decode(withBrief.ROLE_PROMPT_B64)).toContain(studio.prompt);
    expect(decode(withBrief.ROLE_PROMPT_B64)).toContain("board issue #71");
    expect(Object.keys(withBrief)).toEqual(Object.keys(studioBringupEnv(studio, [])));
  });

  test("no brief leaves the lead prompt exactly as the studio file wrote it", () => {
    // Exactly as WRITTEN, plus the house rules every prompt carries
    // unconditionally — nothing the brief path contributed.
    expect(decode(studioBringupEnv(studio, []).ROLE_PROMPT_B64))
      .toBe(appendHouseRules(studio.prompt));
  });
});

// ---------------------------------------------------------------------------
// Tier-0 completion gate — spec §4's "no completion without verification" row.
// The switch is DERIVED from the roster, never declared: a studio writes code
// iff one of its members holds a write tool, and that member's own frontmatter
// is the only honest source for it. Maestro (solo, no members) must never get
// the gate — it never implements, so a Stop-gate demanding a plan doc and green
// build output would wedge it on every coordination turn.
// ---------------------------------------------------------------------------

const READONLY_MEMBER = `---
name: code-reviewer
description: reviews a member's diff with fresh context
tools: Read, Grep, Glob
---
You are the Code Reviewer of Web Studio. Read the diff, never change it.`;

describe("validateMemberFile — tools stay readable, not just counted", () => {
  test("carries the declared tools string through verbatim", () => {
    expect(validateMemberFile("frontend-developer.md", MEMBER).tools).toBe("Read, Edit, Write, Bash");
  });
  test("a member declaring no tools reads as undefined, never as an empty grant", () => {
    const noTools = MEMBER.replace("tools: Read, Edit, Write, Bash\n", "");
    expect(validateMemberFile("frontend-developer.md", noTools).tools).toBeUndefined();
  });
});

describe("studioBringupEnv — STUDIO_COMPLETION_GATE is derived from the roster", () => {
  const studio = parseStudioFile(VALID);

  test("a roster holding Edit/Write installs the gate", () => {
    const members = [validateMemberFile("frontend-developer.md", MEMBER)];
    expect(studioBringupEnv(studio, members).STUDIO_COMPLETION_GATE).toBe("1");
  });
  test("a read-only roster does not — nothing in it can write code", () => {
    const members = [validateMemberFile("code-reviewer.md", READONLY_MEMBER)];
    expect(studioBringupEnv(studio, members).STUDIO_COMPLETION_GATE).toBe("");
  });
  test("a solo studio (maestro) does not — leads never implement, so there is nothing to gate", () => {
    expect(studioBringupEnv(studio, []).STUDIO_COMPLETION_GATE).toBe("");
  });
  test("NotebookEdit counts as a write tool too", () => {
    const nb = MEMBER.replace("tools: Read, Edit, Write, Bash", "tools: Read, NotebookEdit");
    expect(studioBringupEnv(studio, [validateMemberFile("frontend-developer.md", nb)]).STUDIO_COMPLETION_GATE).toBe("1");
  });
  test("a tool merely CONTAINING the word does not count — 'Edited' is not Edit", () => {
    const fake = MEMBER.replace("tools: Read, Edit, Write, Bash", "tools: Read, WriteReview");
    expect(studioBringupEnv(studio, [validateMemberFile("frontend-developer.md", fake)]).STUDIO_COMPLETION_GATE).toBe("");
  });
});
