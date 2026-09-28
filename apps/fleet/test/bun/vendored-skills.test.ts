import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collapseWs } from "../collapse-ws";

// bun:test, not vitest: this asserts on real files on a real filesystem, and
// the vitest lane runs under vitest-pool-workers (workerd — no node:fs). Same
// split, same reason, as test/studio.files.test.ts next door.
//
// Repo root is three levels up from apps/fleet/test/bun. Studios resolve a
// declared skill from /opt/blueprint/skills/<name> (container/
// studio-bringup.sh), and /opt/blueprint IS this repo's checkout — so a skill
// only exists in-container if it exists in this top-level dir.
const SKILLS = join(import.meta.dir, "../../../../skills");

describe("vendored skills/i-have-adhd", () => {
  test("SKILL.md exists where studio-bringup.sh resolves /opt/blueprint/skills/<name>", () => {
    expect(existsSync(join(SKILLS, "i-have-adhd", "SKILL.md"))).toBe(true);
  });

  test("its frontmatter name is i-have-adhd — the slug /i-have-adhd resolves by", () => {
    const md = readFileSync(join(SKILLS, "i-have-adhd", "SKILL.md"), "utf8");
    const frontmatter = md.split("---")[1] ?? "";
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
    expect(name).toBe("i-have-adhd");
  });
});

describe("vendored skills/fleet-cockpit", () => {
  test("SKILL.md exists where studio-bringup.sh resolves /opt/blueprint/skills/<name>", () => {
    expect(existsSync(join(SKILLS, "fleet-cockpit", "SKILL.md"))).toBe(true);
  });

  test("its frontmatter name is fleet-cockpit — the slug /fleet-cockpit resolves by", () => {
    const md = readFileSync(join(SKILLS, "fleet-cockpit", "SKILL.md"), "utf8");
    const frontmatter = md.split("---")[1] ?? "";
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
    expect(name).toBe("fleet-cockpit");
  });
});

// Board issue #160. Cockpit is what an operator reads before writing a task,
// so the gate-budget rule has to be reachable there, not only in a studio file.
describe("skills/fleet-cockpit — the gate budget counts verification", () => {
  // Markdown wraps at ~76 cols, so a pinned sentence straddles a newline.
  // Collapse whitespace before matching (test/collapse-ws.ts, shared with the
  // other two gate-rule pin files): rewrapping the paragraph must not break the
  // pin, deleting the sentence must.
  const cockpit = () => collapseWs(readFileSync(join(SKILLS, "fleet-cockpit", "SKILL.md"), "utf8"));

  test("says the verification a task demands counts toward the gate budget", () => {
    expect(cockpit()).toMatch(/counts toward the gate budget/);
  });

  // #171 item 1: the clause WHOLE. /twice/ alone also matched the e.g. example
  // one sentence later and an unrelated "twice" further up SKILL.md, so
  // deleting this clause left the pin green — a pin that cannot fail is not a
  // pin.
  test("says a RED\/GREEN mutation test of a heavy check runs that check twice", () => {
    expect(cockpit()).toMatch(/RED\/GREEN mutation test of a heavy check runs that check twice/);
  });

  test("says one step at a time, never in parallel, never alongside another gate", () => {
    expect(cockpit()).toMatch(/one step at a time/);
    expect(cockpit()).toMatch(/never in parallel/);
    expect(cockpit()).toMatch(/never alongside another gate/);
  });

  test("tells a task author to name heavy verification in the task's Boundaries", () => {
    expect(cockpit()).toMatch(/Boundaries/);
  });
});

describe("vendored skills/ego-browser", () => {
  test("SKILL.md exists where studio-bringup.sh resolves /opt/blueprint/skills/<name>", () => {
    expect(existsSync(join(SKILLS, "ego-browser", "SKILL.md"))).toBe(true);
  });

  test("its frontmatter name is ego-browser — the slug /ego-browser resolves by", () => {
    const md = readFileSync(join(SKILLS, "ego-browser", "SKILL.md"), "utf8");
    const frontmatter = md.split("---")[1] ?? "";
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
    expect(name).toBe("ego-browser");
  });
});
