// apps/fleet/test/glm-lead.provision.test.ts
// Issue #302: a glm-led studio's lead prompt carries a short brief-discipline
// rule (concrete member briefs, small fan-out); a claude-led one never does.
import { describe, it, expect, vi } from "vitest";
import { resolveBringupEnv, type ProvisionDeps } from "../src/studio/provision";
import { GLM_LEAD_HOUSE_RULE } from "../src/llm/lead-rule";

const FLEET_JSON = JSON.stringify({ blueprint: { repo: "o/blueprint", ref: "main" }, roles: ["web-studio", "cto"], instance_type: "standard-2" });
const STUDIO_MD = "---\nname: web-studio\ntitle: Web Studio\nlead: Web Designer\nskills: []\nsecrets: []\nmcp: []\nallowedTools: Bash(fleet *)\nkeep_alive: false\n---\nyou are the lead\n";
const ROLE_MD = "---\nname: cto\nskills: []\nallowedTools: Bash(fleet *)\nreports_to: maestro\ngates: []\nkeep_alive: false\n---\nyou are the cto\n";
const files: Record<string, string> = {
  "fleet.json": FLEET_JSON,
  "fleet/blueprint/studios/web-studio/studio.md": STUDIO_MD,
  "fleet/blueprint/roles/cto.md": ROLE_MD,
  "fleet/blueprint/org.json": "{}",
};
const decode = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

function deps(): ProvisionDeps {
  return {
    sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    recordStudio: vi.fn(async () => {}),
    now: () => "2026-10-09T00:00:00.000Z",
    fetchBlueprintFile: vi.fn(async (_r: string, path: string) => {
      const hit = files[path];
      if (hit === undefined) throw new Error(`fetch ${path} failed (404): Not Found`);
      return hit;
    }),
    memoryRepo: null,
  } as unknown as ProvisionDeps;
}

describe("glm-lead brief rule at provision (issue #302)", () => {
  it("the rule asks for concrete verbatim briefs and a small fan-out", () => {
    expect(GLM_LEAD_HOUSE_RULE).toMatch(/^## House rules — GLM lead/);
    expect(GLM_LEAD_HOUSE_RULE).toMatch(/verbatim/);
    expect(GLM_LEAD_HOUSE_RULE).toMatch(/research/);
    expect(GLM_LEAD_HOUSE_RULE).toMatch(/one member at a time|at most/i);
  });

  it("studio path: leadType glm renders the rule", async () => {
    const { bringupEnv } = await resolveBringupEnv(deps(), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites", "glm");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toContain(GLM_LEAD_HOUSE_RULE);
  });

  it("studio path: leadType claude or absent never renders it", async () => {
    for (const leadType of ["claude", undefined] as const) {
      const { bringupEnv } = await resolveBringupEnv(deps(), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites", leadType);
      expect(decode(bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — GLM lead");
    }
  });

  it("role path: leadType glm renders the rule, claude does not", async () => {
    const glm = await resolveBringupEnv(deps(), { repo: "websites", role: "cto" }, "o/fleet", "o/websites", "glm");
    expect(decode(glm.bringupEnv.ROLE_PROMPT_B64)).toContain(GLM_LEAD_HOUSE_RULE);
    const claude = await resolveBringupEnv(deps(), { repo: "websites", role: "cto" }, "o/fleet", "o/websites", "claude");
    expect(decode(claude.bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — GLM lead");
  });

  it("the rule sits before the brief, so the task stays last", async () => {
    const { bringupEnv } = await resolveBringupEnv(
      deps(), { repo: "websites", role: "web-studio", briefPrompt: "TASK BRIEF" }, "o/fleet", "o/websites", "glm",
    );
    const prompt = decode(bringupEnv.ROLE_PROMPT_B64);
    expect(prompt.indexOf("House rules — GLM lead")).toBeLessThan(prompt.indexOf("TASK BRIEF"));
  });
});
