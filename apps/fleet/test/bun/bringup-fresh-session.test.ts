import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc, runSnippet } from "./exec-snippet";
import { parseFreshSession } from "../../src/studio/provision";
import { requireTools } from "./require-tool";

/**
 * Issue #28: `--fresh-session` bring-up. A session claude cannot resume
 * (corrupt, oversize, exits on `--continue`) used to come back on every heal.
 * With FLEET_FRESH_SESSION=1 bring-up skips the adopt, moves every root and
 * worktree transcript aside (never deletes), says where on stdout, and the
 * launch guard finds nothing to continue.
 *
 * Runs the shipped regions against a temp HOME, same harness as
 * bringup-session-adopt.test.ts.
 */
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
const ADOPT_SCRIPT = join(import.meta.dir, "../../container/studio-adopt.sh");

function extractRegion(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`region opener ${open} not found in source`);
  const closeAt = src.indexOf(close, openAt);
  if (closeAt === -1) throw new Error(`region terminator ${close} not found in source`);
  return src.slice(src.indexOf("\n", openAt) + 1, closeAt);
}

const CONTINUE_GUARD = () => {
  const line = BRINGUP.split("\n").find((l) => l.includes("if claude_has_conversation ") && l.includes("--continue"));
  if (!line) throw new Error("bring-up's --continue guard line not found");
  return line.trim();
};

const ROOT_KEY = "-workspace-acmeclient";
const WT_KEY = "-workspace-acmeclient--claude-worktrees-task-7";
const ROOT_ID = "a1c006ac-dd42-48a7-a063-90400c353858";
const WT_ID = "b1c006ac-dd42-48a7-a063-90400c353858";
const CLI = '{"type":"user","entrypoint":"cli","sessionId":"x"}\n';

const LANE = requireTools(["sha256sum", "timeout", "tar"], "bring-up's session-restore/session-adopt regions");

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Root session + memory, and a NEWER worktree session: the adopt would copy it. */
function stageRestore(workspace: string, home: string): void {
  const src = join(home, "..", "snapshot");
  const p = join(src, ".claude", "projects");
  const t = Math.floor(Date.now() / 1000) - 3600;
  mkdirSync(join(p, ROOT_KEY, "memory"), { recursive: true });
  writeFileSync(join(p, ROOT_KEY, "memory", "notes.md"), "kept\n");
  writeFileSync(join(p, ROOT_KEY, `${ROOT_ID}.jsonl`), CLI);
  mkdirSync(join(p, ROOT_KEY, ROOT_ID, "subagents"), { recursive: true });
  writeFileSync(join(p, ROOT_KEY, ROOT_ID, "subagents", "agent-1.jsonl"), CLI);
  utimesSync(join(p, ROOT_KEY, `${ROOT_ID}.jsonl`), t - 600, t - 600);
  mkdirSync(join(p, WT_KEY), { recursive: true });
  writeFileSync(join(p, WT_KEY, `${WT_ID}.jsonl`), CLI + CLI);
  utimesSync(join(p, WT_KEY, `${WT_ID}.jsonl`), t, t);
  const tar = Bun.spawnSync({ cmd: ["tar", "-czf", "-", "-C", src, ".claude"], stdout: "pipe" });
  if (tar.exitCode !== 0) throw new Error("tar failed");
  const bytes = tar.stdout;
  const restore = join(workspace, ".session-restore");
  mkdirSync(restore, { recursive: true });
  writeFileSync(join(restore, "part-000"), bytes);
  writeFileSync(
    join(restore, "manifest.json"),
    JSON.stringify({ partCount: 1, totalBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }),
  );
}

function run(fresh: boolean) {
  dir = mkdtempSync(join(tmpdir(), "fleet-bringup-fresh-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  stageRestore(workspace, home);
  const r = runSnippet({
    shell: "bash",
    env: {
      HOME: home, PATH: process.env.PATH ?? "", FLEET_WORKSPACE: workspace,
      FLEET_STUDIO_ADOPT: ADOPT_SCRIPT, STUDIO_ID: "acmeclient--pilot",
      ...(fresh ? { FLEET_FRESH_SESSION: "1" } : {}),
    },
    script:
      "set -euo pipefail\nbringup_step() { :; }\n" +
      `${extractRegion(BRINGUP, "session-restore")}\n` +
      `${extractRegion(BRINGUP, "session-adopt")}\n` +
      `${extractShellFunc(BRINGUP, "claude_project_dir")}\n` +
      `${extractShellFunc(BRINGUP, "claude_has_conversation")}\n` +
      'claude_args=()\nrepo_dir="/workspace/${STUDIO_ID%%--*}"\n' +
      `${CONTINUE_GUARD()}\n` +
      'printf "ARGV %s\\n" "${claude_args[*]:-}"\n',
    timeout: 60_000,
  });
  return { r, projects: join(home, ".claude", "projects") };
}

LANE("#28 — FLEET_FRESH_SESSION: no --continue, old sessions moved aside intact, and bring-up says where", () => {
  test("resumable sessions present + flag: argv has no --continue; every transcript kept aside; memory stays", () => {
    const { r, projects } = run(true);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ARGV\s*$/m);
    expect(r.stdout).not.toContain("--continue");
    // The adopt never ran: nothing copied into root.
    expect(r.stdout).not.toContain("FLEET_SESSION_ADOPT");
    expect(existsSync(join(projects, ROOT_KEY, `${ROOT_ID}.jsonl`))).toBe(false);
    expect(existsSync(join(projects, ROOT_KEY, `${WT_ID}.jsonl`))).toBe(false);
    expect(readFileSync(join(projects, ROOT_KEY, "memory", "notes.md"), "utf8")).toBe("kept\n");

    // Aside dirs: flat siblings (burn.ts keys a session by the path after its
    // project dir), prefixed so the adopt's `<root>--claude-worktrees-*` glob
    // can never pick one back up.
    const aside = readdirSync(projects).filter((k) => k.startsWith("fleet-aside-"));
    expect(aside).toHaveLength(2);
    const rootAside = aside.find((k) => k.endsWith(`-${ROOT_KEY}`))!;
    const wtAside = aside.find((k) => k.endsWith(`-${WT_KEY}`))!;
    expect(readFileSync(join(projects, rootAside, `${ROOT_ID}.jsonl`), "utf8")).toBe(CLI);
    expect(readFileSync(join(projects, rootAside, ROOT_ID, "subagents", "agent-1.jsonl"), "utf8")).toBe(CLI);
    expect(readFileSync(join(projects, wtAside, `${WT_ID}.jsonl`), "utf8")).toBe(CLI + CLI);
    expect(existsSync(join(projects, rootAside, "memory"))).toBe(false);

    // Never silent: the Worker's parse names every destination.
    const moved = parseFreshSession(r.stdout);
    expect(moved).not.toBeNull();
    expect(moved!.sort()).toEqual([`~/.claude/projects/${rootAside}`, `~/.claude/projects/${wtAside}`].sort());
    expect(r.stderr).toContain(rootAside);
  }, 60_000);

  test("no flag: unchanged — adopt runs and the launch continues", () => {
    const { r, projects } = run(false);
    expect(r.stdout).toMatch(/^ARGV .*--continue/m);
    expect(parseFreshSession(r.stdout)).toBeNull();
    expect(readdirSync(projects).some((k) => k.startsWith("fleet-aside-"))).toBe(false);
  }, 60_000);

  test("flag with nothing to move: says so, still no --continue", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-bringup-fresh-"));
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const r = runSnippet({
      shell: "bash",
      env: { HOME: home, PATH: process.env.PATH ?? "", FLEET_WORKSPACE: dir, FLEET_STUDIO_ADOPT: ADOPT_SCRIPT, STUDIO_ID: "acmeclient--pilot", FLEET_FRESH_SESSION: "1" },
      script:
        "set -euo pipefail\nbringup_step() { :; }\n" +
        `${extractRegion(BRINGUP, "session-adopt")}\n` +
        `${extractShellFunc(BRINGUP, "claude_project_dir")}\n${extractShellFunc(BRINGUP, "claude_has_conversation")}\n` +
        'claude_args=()\nrepo_dir="/workspace/${STUDIO_ID%%--*}"\n' +
        `${CONTINUE_GUARD()}\n` +
        'printf "ARGV %s\\n" "${claude_args[*]:-}"\n',
      timeout: 60_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("--continue");
    expect(parseFreshSession(r.stdout)).toEqual([]);
  }, 60_000);
});
