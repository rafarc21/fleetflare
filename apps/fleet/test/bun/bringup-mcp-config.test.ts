import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoleFile, roleBringupEnv } from "../../src/studio/blueprint";
import { parseStudioFile, studioBringupEnv } from "../../src/studio/studio-blueprint";
import { BRINGUP, extractRegion, extractShellFunc, runSnippet } from "./exec-snippet";

/**
 * Issue #276: pilot studios reported "no Playwright MCP tool is registered".
 * Two causes, both exercised here against the REAL bring-up code:
 *   - the mcp writer sat inside the `if STUDIO_NAME` block, so the
 *     pilot/scratch ROLE path never wrote any MCP config at all;
 *   - the file it did write (studios) was a project `.mcp.json` in the tmux
 *     pane's dir, but claude_launch_line cds claude into the checkout first —
 *     measured with claude 2.1.294: from the checkout, `claude mcp list` says
 *     "No MCP servers configured"; with `--mcp-config <file>` the same cwd
 *     reports playwright "connected" and registers mcp__playwright__* tools.
 */
const BLUEPRINT = join(import.meta.dir, "../../../../fleet/blueprint");

/** The one claude-launch line that hands claude the MCP config, verbatim. */
function mcpLaunchLine(): string {
  const lines = extractRegion(BRINGUP, "claude-launch").split("\n").filter((l) => l.includes("--mcp-config"));
  expect(lines.length).toBe(1);
  return lines[0];
}

let homes: string[] = [];
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

function fakeHome(): string {
  const h = mkdtempSync(join(tmpdir(), "fleet-mcp-home-"));
  homes.push(h);
  return h;
}

/** Runs the real mcp-config region, then the real launch line; returns what
 *  landed on disk and the claude args it produced. */
function bringUp(env: Record<string, string>, home = fakeHome()) {
  const r = runSnippet({
    shell: "bash",
    // Default CBM_MCP_BIN to a path that never exists under the fake home so
    // the access check skips codebase-memory regardless of whether the host
    // (or the rolled-out image) has the real binary. Callers override it.
    env: { HOME: home, STUDIO_MCP: "", ROLE_MCP: "", CBM_MCP_BIN: join(home, "no-such-codebase-memory-mcp"), ...env },
    script:
      "set -euo pipefail\n" +
      `${extractShellFunc(BRINGUP, "fleet_mcp_config")}\n` +
      extractRegion(BRINGUP, "mcp-config") +
      "claude_args=()\n" +
      `${mcpLaunchLine()}\n` +
      `printf 'ARG %s\\n' "\${claude_args[@]:-}"\n`,
  });
  expect(r.parentAlive).toBe(true);
  expect(r.code).toBe(0);
  const file = join(home, ".claude", "fleet-mcp.json");
  return {
    home,
    stderr: r.stderr,
    args: r.stdout.split("\n").filter((l) => l.startsWith("ARG ")).map((l) => l.slice(4)).filter(Boolean),
    config: existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> }) : null,
    file,
  };
}

const PLAYWRIGHT = { command: "bun", args: ["x", "@playwright/mcp@latest"] };

// The absent-binary skip is driven by bringUp()'s default CBM_MCP_BIN (a path
// that never exists under the fake home), so no test depends on the host (or
// the rolled-out image) lacking the real binary. NO_CBM_PATH still pins a
// minimal PATH so the python3 heredoc resolves without relying on the host.
const NO_CBM_PATH = "/usr/bin:/bin";

describe("bring-up MCP config — roles honor mcp: (issue #276)", () => {
  for (const role of ["pilot", "scratch"]) {
    test(`real roles/${role}.md declares codebase-memory; binary absent in test env -> no config, no flag, skip logged`, () => {
      const parsed = parseRoleFile(readFileSync(join(BLUEPRINT, "roles", `${role}.md`), "utf8"));
      const env = roleBringupEnv(parsed);
      const out = bringUp({ ...env, PATH: NO_CBM_PATH });
      expect(out.config).toBeNull();
      expect(out.args).toEqual([]);
      expect(out.stderr).toContain("codebase-memory");
    });
  }

  test("real studios/web-studio declares codebase-memory; binary absent in test env -> no config, no flag, skip logged", () => {
    const studio = parseStudioFile(readFileSync(join(BLUEPRINT, "studios", "web-studio", "studio.md"), "utf8"));
    const env = studioBringupEnv(studio, []);
    const out = bringUp({ ...env, PATH: NO_CBM_PATH });
    expect(out.config).toBeNull();
    expect(out.args).toEqual([]);
    expect(out.stderr).toContain("codebase-memory");
  });

  test("an mcp server named in ROLE_MCP -> config written and claude gets --mcp-config", () => {
    const out = bringUp({ ROLE_MCP: "playwright" });
    expect(out.config?.mcpServers.playwright).toEqual(PLAYWRIGHT);
    expect(out.args).toEqual(["--mcp-config", out.file]);
  });

  test("a role env stored before ROLE_MCP existed -> no config, no flag", () => {
    const out = bringUp({});
    expect(out.config).toBeNull();
    expect(out.args).toEqual([]);
  });

  test("mcp dropped from the blueprint -> a stale config from an earlier bring-up is removed, no flag", () => {
    const home = fakeHome();
    bringUp({ ROLE_MCP: "playwright" }, home);
    const out = bringUp({ ROLE_MCP: "" }, home);
    expect(out.config).toBeNull();
    expect(out.args).toEqual([]);
  });

  test("empty name list with an existing config logs the removal", () => {
    const home = fakeHome();
    bringUp({ ROLE_MCP: "playwright" }, home);
    const out = bringUp({ ROLE_MCP: "" }, home);
    expect(out.stderr).toContain("mcp name list empty -- removing");
    expect(out.stderr).toContain("fleet-mcp.json");
  });

  test("empty name list with no existing config stays silent", () => {
    const out = bringUp({});
    expect(out.stderr).not.toContain("mcp name list empty");
  });

  test("an unknown server name is skipped loudly, known ones still land", () => {
    const out = bringUp({ ROLE_MCP: "nope,playwright" });
    expect(Object.keys(out.config?.mcpServers ?? {})).toEqual(["playwright"]);
    expect(out.stderr).toContain('"nope"');
  });

  test("an MCP write failure never blocks the boot", () => {
    const home = fakeHome();
    // ~/.claude as a FILE: mkdir -p under it fails.
    writeFileSync(join(home, ".claude"), "");
    const out = bringUp({ ROLE_MCP: "playwright" }, home);
    expect(out.args).toEqual([]);
    expect(out.stderr).toContain("studio-bringup:");
  });

  test("codebase-memory in ROLE_MCP -> server written with the bare binary command", () => {
    const home = fakeHome();
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codebase-memory-mcp"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "codebase-memory-mcp"), 0o755);
    const out = bringUp({ ROLE_MCP: "codebase-memory", PATH: `${bin}:${NO_CBM_PATH}`, CBM_MCP_BIN: join(bin, "codebase-memory-mcp") }, home);
    expect(out.config?.mcpServers["codebase-memory"]).toEqual({ command: "/usr/local/bin/codebase-memory-mcp", env: { CBM_MEM_BUDGET_MB: "1024" } });
    expect(out.args).toEqual(["--mcp-config", out.file]);
  });

  test("codebase-memory binary absent -> skipped with a stderr line, boot never fails", () => {
    const home = fakeHome();
    const out = bringUp({ ROLE_MCP: "codebase-memory" }, home);
    expect(out.config?.mcpServers["codebase-memory"]).toBeUndefined();
    expect(out.args).toEqual([]);
    expect(out.stderr).toContain("codebase-memory");
  });
});
