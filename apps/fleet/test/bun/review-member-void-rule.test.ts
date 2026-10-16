import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMemberFile } from "../../src/studio/studio-blueprint";

// Issue #1107 layer 1: a review or QA member that finished with `tool_uses: 0`
// read nothing, so its verdict is void. Blueprint text, loaded from main at
// studio start, carries the rule to the lead and to each member.
const BLUEPRINT = join(import.meta.dir, "../../../../fleet/blueprint");
const read = (...parts: string[]) => readFileSync(join(BLUEPRINT, ...parts), "utf8");

const WEB_STUDIO = read("studios", "web-studio", "studio.md");
const CODE_REVIEWER = read("studios", "web-studio", "members", "code-reviewer.md");
const WEB_QA = read("studios", "web-studio", "members", "qa-engineer.md");
const RELEASE_QA = read("studios", "release-studio", "members", "qa-engineer.md");

describe("lead lists review-member tool-use counts (#1107 layer 1)", () => {
  test("lead text voids a review/QA member with tool_uses 0 and re-dispatches it", () => {
    expect(WEB_STUDIO).toMatch(/tool_uses: 0/);
    expect(WEB_STUDIO).toMatch(/void/i);
    expect(WEB_STUDIO).toMatch(/re-dispatch/i);
  });

  test("a void verdict never counts as approval", () => {
    expect(WEB_STUDIO).toMatch(/never count (it|that|a void|them) as approval/i);
  });

  test("the completion record lists each review member's tool-use count", () => {
    expect(WEB_STUDIO).toMatch(/"reviews"/);
    expect(WEB_STUDIO).toMatch(/"tool_uses"/);
  });

  test("the completion record example stays valid JSON", () => {
    const block = WEB_STUDIO.match(/\{"plan":[\s\S]*?\]\}/);
    expect(block).not.toBeNull();
    const withPlaceholders = block![0].replace(/<[^>]+>/g, "x");
    expect(() => JSON.parse(withPlaceholders)).not.toThrow();
  });
});

describe("review and QA members say their verdict is void without a read (#1107 layer 1)", () => {
  test("web code-reviewer: no read, no verdict", () => {
    expect(CODE_REVIEWER).toMatch(/read the diff before any verdict/i);
    expect(CODE_REVIEWER).toMatch(/void/i);
  });

  test("web qa-engineer: no page loaded, no verdict", () => {
    expect(WEB_QA).toMatch(/no (page|browser) (loaded|load)/i);
    expect(WEB_QA).toMatch(/void/i);
  });

  test("release qa-engineer: no page loaded, no verdict", () => {
    expect(RELEASE_QA).toMatch(/no (page|browser) (loaded|load)/i);
    expect(RELEASE_QA).toMatch(/void/i);
  });

  test("member files still parse as valid members", () => {
    expect(validateMemberFile("code-reviewer.md", CODE_REVIEWER).name).toBe("code-reviewer");
    expect(validateMemberFile("qa-engineer.md", WEB_QA).name).toBe("qa-engineer");
    expect(validateMemberFile("qa-engineer.md", RELEASE_QA).name).toBe("qa-engineer");
  });
});
