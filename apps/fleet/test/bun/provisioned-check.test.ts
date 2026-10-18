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

  test("a role env returns null — roles get MCP coverage via ask 2, not ask 3", () => {
    const roleEnv: RoleEnv = { ROLE_PROMPT_B64: "aGk=", ROLE_ALLOWED_TOOLS: "", ROLE_EFFORT: "", ROLE_MCP: "playwright" };
    expect(harnessExpectation(roleEnv)).toBeNull();
  });
});
