import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { provisionedCheckCmd } from "../../src/studio/provision";

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
