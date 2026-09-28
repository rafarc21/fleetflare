import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc, runSnippet } from "./exec-snippet";
import { parseSessionAdoption } from "../../src/studio/provision";
import { requireTools } from "./require-tool";

/**
 * Issue #146, end to end in bring-up's own bytes: a FRESH container whose
 * only session is worktree-keyed.
 *
 * The Worker's pre-bring-up adopt (#120) ran while the session tar was still
 * staged, found nothing, and the lead launched blank — and that blank root
 * session then outranked the real one on every later heal. Here the restore
 * untars, bring-up's own adopt step runs, and the launch guard must see the
 * copy: `--continue` in the argv.
 *
 * Runs the shipped regions (`session-restore`, `session-adopt`), the shipped
 * claude_project_dir / claude_has_conversation, and the shipped `--continue`
 * guard line, against a temp HOME and a temp FLEET_WORKSPACE. No tmux.
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

const WT_KEY = "-workspace-fleetflare--claude-worktrees-row-tells-truth-85-pr1";
const WT_ID = "b1c006ac-dd42-48a7-a063-90400c353858";
const CLI = '{"type":"user","entrypoint":"cli","sessionId":"x"}\n';

// The restore verifies with sha256sum and the adopt is bounded by `timeout`,
// both bounded by `tar`'s own extraction: all three coreutils/tar, all three
// in the image and on CI; macOS lacks them (issue #356).
const LANE = requireTools(["sha256sum", "timeout", "tar"], "bring-up's session-restore/session-adopt regions");

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Stage a session tar exactly as runSessionRestore does: parts, then the manifest LAST. */
function stageRestore(workspace: string, home: string, rootBody?: string): void {
  const src = join(home, "..", "snapshot");
  const key = join(src, ".claude", "projects", WT_KEY);
  mkdirSync(key, { recursive: true });
  const t = Math.floor(Date.now() / 1000) - 3600;
  writeFileSync(join(key, `${WT_ID}.jsonl`), CLI);
  utimesSync(join(key, `${WT_ID}.jsonl`), t, t);
  if (rootBody !== undefined) {
    // An OLDER same-id root copy (#155's collision).
    const root = join(src, ".claude", "projects", "-workspace-fleetflare");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${WT_ID}.jsonl`), rootBody);
    utimesSync(join(root, `${WT_ID}.jsonl`), t - 600, t - 600);
  }
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

LANE("#146 — bring-up adopts AFTER the restore untar, so a fresh container resumes a worktree-keyed lead", () => {
  test("a restored tar holding only a worktree session: the root key holds the copy, and the launch argv has --continue", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-bringup-adopt-"));
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    stageRestore(workspace, home);

    const r = runSnippet({
      shell: "bash",
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        FLEET_WORKSPACE: workspace,
        FLEET_STUDIO_ADOPT: ADOPT_SCRIPT,
        STUDIO_ID: "fleetflare--pilot",
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

    expect(r.stderr).not.toContain("verification failed");
    expect(readFileSync(join(home, ".claude", "projects", "-workspace-fleetflare", `${WT_ID}.jsonl`), "utf8")).toBe(CLI);
    expect(existsSync(join(home, ".claude", "projects", WT_KEY, `${WT_ID}.jsonl`))).toBe(true);
    expect(r.stdout).toMatch(/^ARGV .*--continue/m);
    // The row reads bring-up's own result line.
    expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "adopted", sessionId: WT_ID, fromKey: WT_KEY, at: "T" });
  }, 60_000);

  test("a HUNG adopt script is bounded by bring-up's timeout -k: the region finishes, says failed, and the launch guard still runs", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-bringup-adopt-"));
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const hang = join(dir, "hang.sh");
    writeFileSync(hang, "#!/bin/sh\nsleep 120\n");
    chmodSync(hang, 0o755);

    const started = Date.now();
    const r = runSnippet({
      shell: "bash",
      env: { HOME: home, PATH: process.env.PATH ?? "", FLEET_WORKSPACE: workspace, FLEET_STUDIO_ADOPT: hang, STUDIO_ID: "fleetflare--pilot" },
      script:
        "set -euo pipefail\nbringup_step() { :; }\n" +
        `${extractRegion(BRINGUP, "session-adopt")}\n` +
        `${extractShellFunc(BRINGUP, "claude_project_dir")}\n${extractShellFunc(BRINGUP, "claude_has_conversation")}\n` +
        'claude_args=()\nrepo_dir="/workspace/${STUDIO_ID%%--*}"\n' +
        `${CONTINUE_GUARD()}\n` +
        'printf "ARGV %s\\n" "${claude_args[*]:-}"\n',
      timeout: 60_000,
    });

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.stdout).toContain("FLEET_SESSION_ADOPT failed");
    expect(r.stdout).toMatch(/^ARGV/m);
  }, 60_000);

  test("#155: a restored root copy the worktree session does NOT extend is kept, and the skip reaches the bring-up log", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-bringup-adopt-"));
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    stageRestore(workspace, home, CLI + CLI);

    const r = runSnippet({
      shell: "bash",
      env: { HOME: home, PATH: process.env.PATH ?? "", FLEET_WORKSPACE: workspace, FLEET_STUDIO_ADOPT: ADOPT_SCRIPT, STUDIO_ID: "fleetflare--pilot" },
      script: "set -euo pipefail\nbringup_step() { :; }\n" + `${extractRegion(BRINGUP, "session-restore")}\n${extractRegion(BRINGUP, "session-adopt")}\n`,
      timeout: 60_000,
    });

    expect(readFileSync(join(home, ".claude", "projects", "-workspace-fleetflare", `${WT_ID}.jsonl`), "utf8")).toBe(CLI + CLI);
    expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "root" });
    expect(r.stderr).toContain("not a byte-extension");
  }, 60_000);
});
