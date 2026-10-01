import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMemberFile } from "../../src/studio/studio-blueprint";

const PATH = join(import.meta.dir, "../../../../fleet/blueprint/studios/web-studio/members/code-reviewer.md");
const raw = readFileSync(PATH, "utf8");

describe("code-reviewer blueprint — Spec + Standards axes (#162)", () => {
  test("still parses as a valid read-only member", () => {
    const m = validateMemberFile("code-reviewer.md", raw);
    expect(m.name).toBe("code-reviewer");
    expect(m.tools).toBe("Read, Glob, Grep, Bash(git diff *), Bash(git log *), Bash(git show *)");
  });

  test("declares both axes by name", () => {
    expect(raw).toContain("Spec axis");
    expect(raw).toContain("Standards axis");
  });

  test("Spec axis reads the board issue's objective/output/boundaries", () => {
    expect(raw).toMatch(/objective/);
    expect(raw).toMatch(/output/);
    expect(raw).toMatch(/boundaries/i);
  });

  test("Standards axis reads CODING_STANDARDS.md and falls back to the Fowler baseline, repo rules win", () => {
    expect(raw).toContain("CODING_STANDARDS.md");
    expect(raw).toContain("Fowler");
    expect(raw).toMatch(/repo rules override/i);
  });

  test("the two reports are never merged or reranked", () => {
    expect(raw).toMatch(/never merge/i);
    expect(raw).toMatch(/never rerank/i);
  });

  test("every finding carries a citation", () => {
    expect(raw).toMatch(/cit/i);
  });

  test("recursion guard: review directly, spawn no agents, invoke no review skill", () => {
    expect(raw).toMatch(/spawn no agents/i);
    expect(raw).toMatch(/invoke no review skill/i);
  });
});

describe("code-reviewer blueprint — read-only git (#166)", () => {
  test("tools grant read-only git alongside the existing read-only toolset", () => {
    const m = validateMemberFile("code-reviewer.md", raw);
    expect(m.tools).toBe("Read, Glob, Grep, Bash(git diff *), Bash(git log *), Bash(git show *)");
  });

  test("prompt explains the git access is read-only, no tree-changing form", () => {
    expect(raw).toMatch(/git diff/);
    expect(raw).toMatch(/git log/);
    expect(raw).toMatch(/git show/);
  });
});

describe("code-reviewer blueprint — deny --output/-o on git reads (#167)", () => {
  test("prompt explicitly forbids --output/-o on git diff/log/show", () => {
    expect(raw).toMatch(/--output/);
    expect(raw).toMatch(/-o\b/);
  });
});
