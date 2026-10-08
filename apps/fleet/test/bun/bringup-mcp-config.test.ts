import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoleFile, roleBringupEnv } from "../../src/studio/blueprint";
import { parseStudioFile, studioBringupEnv } from "../../src/studio/studio-blueprint";
import { extractShellFunc, runSnippet } from "./exec-snippet";

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
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
const BLUEPRINT = join(import.meta.dir, "../../../../fleet/blueprint");

function extractRegion(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`region opener ${open} not found in source`);
  const closeAt = src.indexOf(close, openAt);
  if (closeAt === -1) throw new Error(`region terminator ${close} not found in source`);
  return src.slice(src.indexOf("\n", openAt) + 1, closeAt);
}

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
    env: { HOME: home, STUDIO_MCP: "", ROLE_MCP: "", ...env },
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

describe("bring-up MCP config — roles honor mcp: (issue #276)", () => {
  for (const role of ["pilot", "scratch"]) {
    test(`real roles/${role}.md -> bring-up config has the playwright server and claude gets --mcp-config`, () => {
      const parsed = parseRoleFile(readFileSync(join(BLUEPRINT, "roles", `${role}.md`), "utf8"));
      const env = roleBringupEnv(parsed);
      const out = bringUp({ ...env });
      expect(out.config?.mcpServers.playwright).toEqual(PLAYWRIGHT);
      expect(out.args).toEqual(["--mcp-config", out.file]);
    });
  }

  test("real studios/web-studio -> same server, same flag (studio path unchanged in effect)", () => {
    const studio = parseStudioFile(readFileSync(join(BLUEPRINT, "studios", "web-studio", "studio.md"), "utf8"));
    const env = studioBringupEnv(studio, []);
    const out = bringUp({ ...env });
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
});
