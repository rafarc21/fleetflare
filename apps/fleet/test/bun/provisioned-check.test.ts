import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { provisionedCheckCmd, harnessExpectation } from "../../src/studio/provision";
import type { RoleEnv, StudioEnv } from "../../src/studio/provision";

// A repo name that cannot exist on disk sends the command down its FIRST
// branch, so this runs instantly and needs no tmux, no claude, no container.
const ABSENT = "no-such-repo-p7a";

describe("provisionedCheckCmd, executed", () => {
  test("reports a missing checkout on stdout and leaves the parent shell alive", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT), sourced: true });
    expect(r.stdout).toContain(`no git checkout at /workspace/${ABSENT}`);
    expect(r.parentAlive).toBe(true);
  });

  test("same under dash, the shell a container actually uses for /bin/sh", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT), shell: "dash", sourced: true });
    expect(r.stdout).toContain(`no git checkout at /workspace/${ABSENT}`);
    expect(r.parentAlive).toBe(true);
  });

  test("the harness variant also leaves the parent alive", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT, "claude"), sourced: true });
    expect(r.parentAlive).toBe(true);
  });

  // Issue #189: bring-up writes .fleet/tailnet-down when `tailscale up`
  // fails; the check must carry that line out so `fleet ls` can show it.
  test("prints the tailnet-down marker after its verdict, parent alive", () => {
    const ws = mkdtempSync(join(tmpdir(), "fleet-check-tailnet-"));
    try {
      mkdirSync(join(ws, ".fleet"));
      writeFileSync(join(ws, ".fleet", "tailnet-down"), "tailnet: quota reached\n");
      const r = runSnippet({ script: provisionedCheckCmd(ABSENT), sourced: true, env: { FLEET_WORKSPACE: ws } });
      expect(r.stdout).toContain(`no git checkout at /workspace/${ABSENT}`);
      expect(r.stdout).toContain("tailnet: quota reached");
      expect(r.parentAlive).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("no marker: prints nothing extra", () => {
    const ws = mkdtempSync(join(tmpdir(), "fleet-check-tailnet-"));
    try {
      const r = runSnippet({ script: provisionedCheckCmd(ABSENT), sourced: true, env: { FLEET_WORKSPACE: ws } });
      expect(r.stdout).not.toContain("tailnet:");
      expect(r.parentAlive).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("harnessExpectation — the mcp token (issue #1216)", () => {
  const studioEnv = (mcp: string): StudioEnv => ({
    ROLE_PROMPT_B64: "aGk=",
    ROLE_ALLOWED_TOOLS: "",
    ROLE_EFFORT: "",
    STUDIO_NAME: "release-studio",
    STUDIO_SKILLS: "",
    STUDIO_MEMBERS_B64: "e30=",
    STUDIO_MCP: mcp,
    STUDIO_LEAD_DISALLOWED: "",
    BLUEPRINT_REPO: "rafarc21/fleetflare",
  });

  test("a studio with STUDIO_MCP names carries the mcp token", () => {
    const dec = atob(harnessExpectation(studioEnv("codebase-memory"))!);
    expect(dec.split("\n")).toContain("mcp");
  });

  test("a studio with empty STUDIO_MCP carries no mcp token", () => {
    const dec = atob(harnessExpectation(studioEnv(""))!);
    expect(dec.split("\n")).not.toContain("mcp");
  });

  test("a studio harness starts with the kind studio marker", () => {
    const dec = atob(harnessExpectation(studioEnv("codebase-memory"))!);
    expect(dec.split("\n")[0]).toBe("kind studio");
  });

  test("a role with ROLE_MCP names carries the mcp token, marked kind role", () => {
    const roleEnv: RoleEnv = { ROLE_PROMPT_B64: "aGk=", ROLE_ALLOWED_TOOLS: "", ROLE_EFFORT: "", ROLE_MCP: "playwright" };
    const dec = atob(harnessExpectation(roleEnv)!);
    expect(dec.split("\n")[0]).toBe("kind role");
    expect(dec.split("\n")).toContain("mcp");
  });

  test("a role with no ROLE_MCP returns null", () => {
    const roleEnv: RoleEnv = { ROLE_PROMPT_B64: "aGk=", ROLE_ALLOWED_TOOLS: "", ROLE_EFFORT: "" };
    expect(harnessExpectation(roleEnv)).toBeNull();
  });

  test("a role harness asserts mcp only — the studio-only lead-gate/caveman checks are gated behind kind studio", () => {
    const roleEnv: RoleEnv = { ROLE_PROMPT_B64: "aGk=", ROLE_ALLOWED_TOOLS: "", ROLE_EFFORT: "", ROLE_MCP: "playwright" };
    const dec = atob(harnessExpectation(roleEnv)!);
    // The role blob asserts the MCP config and nothing studio-only.
    expect(dec.split("\n")).toEqual(["kind role", "mcp", "end"]);
    // The command still COMPILES the lead-gate/caveman checks (same as every
    // harness), but wraps them in a `kind studio` guard so a role never takes
    // them at runtime — the marker, not the text, is what excludes a role.
    const cmd = provisionedCheckCmd(ABSENT, harnessExpectation(roleEnv));
    expect(cmd).toContain('if [ "$kind" = studio ]; then');
    expect(cmd).toContain("fleet-mcp.json");
  });
});
