import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStudioFile } from "../../src/studio/studio-blueprint";

// bun:test, not vitest: real files on a real filesystem, same split
// vendored-skills.test.ts's own header documents (vitest-pool-workers runs
// under workerd — no node:fs).
//
// Board task #33: ego-browser was declared in exactly one studio's `skills:`
// list (web-studio) while the binary ships to every role, and the mandated
// brief line ("Use the ego-browser skill") goes to every role regardless.
// Rather than add one more one-off per-skill test (vendored-skills.test.ts's
// pattern), this walks EVERY studio.md, parses its declared `skills:` array
// with the same parser provision.ts's own bring-up path uses, and proves
// EACH declared name actually RESOLVES — SKILL.md exists at the repo-root
// skills/<name> dir (where /opt/blueprint/skills/<name> resolves to,
// in-container — see vendored-skills.test.ts) and its frontmatter `name:`
// line matches the slug. That is the same shape harnessCheckSnippet's own
// "s" branch checks live (provision.ts, ~line 677): a name merely typed into
// the list is not proof of anything; resolution is.
const STUDIOS_ROOT = join(import.meta.dir, "../../../../fleet/blueprint/studios");
const SKILLS_ROOT = join(import.meta.dir, "../../../../skills");

function resolvesSkillName(name: string): string | undefined {
  const skillMd = join(SKILLS_ROOT, name, "SKILL.md");
  if (!existsSync(skillMd)) return undefined;
  const frontmatter = readFileSync(skillMd, "utf8").split("---")[1] ?? "";
  return /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
}

describe("every studio's declared skills resolve", () => {
  const studioDirs = readdirSync(STUDIOS_ROOT);

  for (const dir of studioDirs) {
    const studio = parseStudioFile(readFileSync(join(STUDIOS_ROOT, dir, "studio.md"), "utf8"));

    for (const name of studio.skills) {
      test(`${dir} declares "${name}" and it resolves to skills/${name}/SKILL.md`, () => {
        expect(resolvesSkillName(name)).toBe(name);
      });
    }
  }

  // Board task #33's own point: maestro and release-studio must each declare
  // ego-browser, not merely have it resolve somewhere in skills/ — a general
  // "every skills/ dir resolves" test would pass regardless of what any one
  // studio actually declares, missing the bug entirely.
  test("maestro declares ego-browser", () => {
    const studio = parseStudioFile(readFileSync(join(STUDIOS_ROOT, "maestro", "studio.md"), "utf8"));
    expect(studio.skills).toContain("ego-browser");
  });

  test("release-studio declares ego-browser", () => {
    const studio = parseStudioFile(readFileSync(join(STUDIOS_ROOT, "release-studio", "studio.md"), "utf8"));
    expect(studio.skills).toContain("ego-browser");
  });
});
