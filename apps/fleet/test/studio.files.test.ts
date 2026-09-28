import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseStudioFile, validateMemberFile } from "../src/studio/studio-blueprint";
import { collapseWs } from "./collapse-ws";

const ROOT = join(import.meta.dir, "../../../fleet/blueprint/studios");

describe("authored studio files", () => {
  test("every studio dir parses clean", () => {
    const studios = readdirSync(ROOT);
    expect(studios.sort()).toEqual(["maestro", "release-studio", "web-studio"]);
    for (const s of studios) {
      const studio = parseStudioFile(readFileSync(join(ROOT, s, "studio.md"), "utf8"));
      expect(studio.name).toBe(s);
      const membersDir = join(ROOT, s, "members");
      if (existsSync(membersDir)) {
        for (const f of readdirSync(membersDir)) {
          validateMemberFile(f, readFileSync(join(membersDir, f), "utf8"));
        }
      }
    }
  });
});

// Board issue #160. Every authored file that already states the #98 one-heavy-
// gate rule also states that verification counts toward that budget. Otherwise
// the place the rule already lives goes stale and contradicts HOUSE_RULES.
describe("the #98 gate rule counts verification too", () => {
  const FILES = [
    "release-studio/studio.md",
    "web-studio/studio.md",
    "web-studio/members/frontend-developer.md",
    "web-studio/members/backend-developer.md",
  ];

  for (const rel of FILES) {
    test(`${rel} says the verification a task demands counts toward the gate budget`, () => {
      // Collapse before matching (test/collapse-ws.ts, shared with the other
      // two gate-rule pin files): these paragraphs are one long line today, but
      // a rewrap must not break the pin — only deleting the sentence may. The
      // whole clause, not /twice/: that word also sits in the e.g. example one
      // sentence later, so the old pin stayed green after a deletion.
      const md = collapseWs(readFileSync(join(ROOT, rel), "utf8"));
      expect(md).toMatch(/counts toward the gate budget/);
      expect(md).toMatch(/RED\/GREEN mutation test of a heavy check runs that check twice/);
      expect(md).toMatch(/one step at a time/);
      expect(md).toMatch(/never in parallel/);
      expect(md).toMatch(/never alongside another gate/);
      expect(md).toMatch(/Boundaries/);
    });
  }
});

// Board issue #235: release-studio orchestrates merge/deploy through the
// `fleet` CLI and verifies on the deployed URL afterward — it must say plainly
// that it never holds a Cloudflare API token itself, since HOUSE_RULES is the
// ONLY always-on copy maestro/pilot/scratch get, but a studio like this one
// also has its own studio.md, which has to carry the same fact for its own
// lead to find it without reasoning from HOUSE_RULES alone.
describe("release-studio holds no Cloudflare deploy credential itself (issue #235)", () => {
  test("release-studio/studio.md says it holds no Cloudflare credential and names who deploys instead", () => {
    const md = collapseWs(readFileSync(join(ROOT, "release-studio/studio.md"), "utf8"));
    expect(md).toMatch(/No Cloudflare credential lives in this container either/);
    expect(md).toMatch(
      /no CLOUDFLARE_API_TOKEN \(what wrangler reads\) and no CLOUDFLARE_DEPLOY_TOKEN \(the fleet's own deploy secret, held only by the Worker-side deploy container\)/,
    );
    expect(md).toMatch(/`fleet` deploys Worker-side on that credential, never this studio's/);
    expect(md).toMatch(/this studio's own verification — the deployed URL, in a browser, after the deploy already ran/);
  });
});
