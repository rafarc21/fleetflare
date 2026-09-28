// apps/fleet/test/junior.provision.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveBringupEnv, type ProvisionDeps } from "../src/studio/provision";
import { JUNIOR_HOUSE_RULE } from "../src/junior/gate";

const FLEET_JSON = JSON.stringify({ blueprint: { repo: "o/blueprint", ref: "main" }, roles: ["web-studio", "maestro"], instance_type: "standard-2" });
const STUDIO_MD = "---\nname: web-studio\ntitle: Web Studio\nlead: Web Designer\nskills: []\nsecrets: []\nmcp: []\nallowedTools: Bash(fleet *)\nkeep_alive: false\n---\nyou are the lead\n";
const files: Record<string, string> = { "fleet.json": FLEET_JSON, "fleet/blueprint/studios/web-studio/studio.md": STUDIO_MD };
const decode = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

function deps(juniorEnabled?: (slug: string) => boolean): ProvisionDeps {
  return {
    sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    recordStudio: vi.fn(async () => {}),
    now: () => "2026-09-28T00:00:00.000Z",
    fetchBlueprintFile: vi.fn(async (_r: string, path: string) => {
      const hit = files[path];
      if (hit === undefined) throw new Error(`fetch ${path} failed (404): Not Found`);
      return hit;
    }),
    memoryRepo: null,
    ...(juniorEnabled ? { juniorEnabled } : {}),
  } as unknown as ProvisionDeps;
}

describe("junior at provision", () => {
  it("port absent: no skill, no rule (every pre-junior fixture)", async () => {
    const { bringupEnv } = await resolveBringupEnv(deps(), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — junior");
  });
  it("enabled for the work repo: skill + rule", async () => {
    const seen: string[] = [];
    const { bringupEnv } = await resolveBringupEnv(deps((s) => { seen.push(s); return true; }), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect(seen).toEqual(["o/websites"]);
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toContain(JUNIOR_HOUSE_RULE);
  });
  it("disabled: neither", async () => {
    const { bringupEnv } = await resolveBringupEnv(deps(() => false), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — junior");
  });
  it("maestro never gets the skill or the rule, even when enabled", async () => {
    const MAESTRO_MD = STUDIO_MD.replace("name: web-studio", "name: maestro");
    files["fleet/blueprint/studios/maestro/studio.md"] = MAESTRO_MD;
    const { bringupEnv } = await resolveBringupEnv(deps(() => true), { repo: "websites", role: "maestro" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — junior");
  });
  it("the no-Cloudflare-credential house rule survives with junior on", async () => {
    const { bringupEnv } = await resolveBringupEnv(deps(() => true), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toContain("No Cloudflare");
  });

  // Fresh-review addition (Task 7): the maestro exclusion in the plan's own
  // sample code keys ONLY off `studio.name` -- the frontmatter `name:` field
  // parsed from studio.md, documented as "matches its directory name" but
  // never actually validated against it anywhere in provision.ts. A blueprint
  // whose `fleet/blueprint/studios/maestro/studio.md` carries a mismatched
  // frontmatter name (an operator rename, or any other drift) would defeat a
  // `studio.name !== "maestro"` check while cfg.role -- the value that
  // actually selected this file -- still reads "maestro". This is the real
  // safety property (studio.md "Junior — your call": the maestro must NEVER
  // get the skill), so it must hold even when the frontmatter's own `name:`
  // field disagrees with the directory it was fetched from.
  it("maestro exclusion holds even when the maestro studio.md's own frontmatter name field is out of sync with its directory", async () => {
    files["fleet/blueprint/studios/maestro/studio.md"] = STUDIO_MD; // name: web-studio, fetched via role "maestro"
    const { bringupEnv } = await resolveBringupEnv(deps(() => true), { repo: "websites", role: "maestro" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — junior");
  });

  // Fresh-review addition: the maestro exclusion (and the FLEET_JUNIOR-off
  // path) must not merely SKIP adding "junior" -- they must actively STRIP it
  // if the studio.md's own frontmatter already lists it. `skills:` is parsed
  // straight off blueprint content (parseSimpleArray, no allow-list), so an
  // operator typo/bad merge/blueprint-repo write access could put "junior"
  // directly in a studio's (including the maestro's) skills array. Nothing
  // upstream of this function filters that, so materialization must.
  const STUDIO_MD_WITH_JUNIOR_SKILL = STUDIO_MD.replace("skills: []", "skills: [junior]");

  it("maestro's own frontmatter listing 'junior' directly in skills is still stripped -- authorization is never blueprint-content-derived", async () => {
    files["fleet/blueprint/studios/maestro/studio.md"] = STUDIO_MD_WITH_JUNIOR_SKILL.replace("name: web-studio", "name: maestro");
    const { bringupEnv } = await resolveBringupEnv(deps(() => true), { repo: "websites", role: "maestro" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
  });

  it("a non-maestro studio.md listing 'junior' directly in skills is stripped when the global flag is off/absent", async () => {
    files["fleet/blueprint/studios/web-studio/studio.md"] = STUDIO_MD_WITH_JUNIOR_SKILL;
    const { bringupEnv } = await resolveBringupEnv(deps(() => false), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
    files["fleet/blueprint/studios/web-studio/studio.md"] = STUDIO_MD; // restore
  });

  it("a studio.md listing 'junior' directly in skills still gets exactly one 'junior' entry when actually authorized (filter-then-readd, no accidental always-strip, no dedup-wasting duplicate)", async () => {
    files["fleet/blueprint/studios/web-studio/studio.md"] = STUDIO_MD_WITH_JUNIOR_SKILL;
    const { bringupEnv } = await resolveBringupEnv(deps(() => true), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    const skills = (bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",");
    expect(skills.filter((s) => s === "junior")).toEqual(["junior"]);
    files["fleet/blueprint/studios/web-studio/studio.md"] = STUDIO_MD; // restore
  });
});
