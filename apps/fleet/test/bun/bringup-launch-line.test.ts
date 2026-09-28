import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc, runSnippet } from "./exec-snippet";

/**
 * Issue #6: bring-up typed the WHOLE claude command, role prompt inlined via
 * `printf %q`, into the pane with `tmux send-keys`. A long task brief pushed
 * that past tmux's message limit: `command too long`, the launch and its
 * retry both failed, and the pane showed only the retry's `^C`.
 *
 * claude_launch_line now writes the prompt to a file under .fleet and types
 * a short line that reads it back. These tests run the REAL function,
 * extracted from container/studio-bringup.sh, and then run the line it
 * returns through bash — the same re-parse the pane does — against a fake
 * `claude` that records the prompt it was handed.
 *
 * The real-tmux half (the line actually typed through send-keys and landing)
 * lives in bringup-claude-relaunch.test.ts, which runs on Linux CI.
 */
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
const LAUNCH_LINE = () => extractShellFunc(BRINGUP, "claude_launch_line");

/** Past 64 KB, and full of what shell quoting gets wrong. */
function bigPrompt(): string {
  const chunk = `line with 'single' "double" $HOME \`tick\` \\ back ! bang * glob; semi & amp | pipe\n`;
  return chunk.repeat(Math.ceil(70_000 / chunk.length)).trimEnd();
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-launch-line-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const ws = join(dir, "workspace");
  mkdirSync(bin, { recursive: true });
  mkdirSync(ws, { recursive: true });
  // Records the argument after --append-system-prompt, and where it ran.
  writeFileSync(
    join(bin, "claude"),
    "#!/bin/bash\n" +
      `pwd > ${JSON.stringify(join(dir, "cwd"))}\n` +
      'while [ $# -gt 0 ]; do\n' +
      `  [ "$1" = --append-system-prompt ] && printf '%s' "$2" > ${JSON.stringify(join(dir, "got"))}\n` +
      "  shift\n" +
      "done\n",
    { mode: 0o755 },
  );
  chmodSync(join(bin, "claude"), 0o755);
  return { dir, bin, ws, got: () => readFileSync(join(dir, "got"), "utf8") };
}

/** Build the line with the real function, then run it the way the pane would. */
function buildAndRun(w: ReturnType<typeof world>, prompt: string, repoDir = "", ws = w.ws) {
  const promptPath = join(w.dir, "prompt-in");
  writeFileSync(promptPath, prompt);
  const r = runSnippet({
    shell: "bash",
    env: { PATH: `${w.bin}:${process.env.PATH ?? ""}`, FLEET_WORKSPACE: ws },
    script:
      "set -euo pipefail\n" +
      `${LAUNCH_LINE()}\n` +
      `role_prompt="$(cat ${JSON.stringify(promptPath)})"\n` +
      `line="$(claude_launch_line "$role_prompt" ${JSON.stringify(repoDir)} --dangerously-skip-permissions --allowedTools 'Bash(git *) Edit')"\n` +
      `printf '%s' "$line" > ${JSON.stringify(join(w.dir, "line"))}\n` +
      'bash -c "$line"\n',
  });
  expect(r.parentAlive).toBe(true);
  return { ...r, line: existsSync(join(w.dir, "line")) ? readFileSync(join(w.dir, "line"), "utf8") : "" };
}

describe("claude_launch_line — the role prompt never rides the send-keys line (issue #6)", () => {
  test("a >64 KB prompt yields a launch line under 1 KB", () => {
    const w = world();
    const prompt = bigPrompt();
    expect(prompt.length).toBeGreaterThan(64 * 1024);
    const r = buildAndRun(w, prompt);
    expect(r.code).toBe(0);
    expect(Buffer.byteLength(r.line)).toBeLessThan(1024);
    expect(r.line).not.toContain("single");
  });

  test("claude receives the >64 KB prompt byte-for-byte as ONE argument", () => {
    const w = world();
    const prompt = bigPrompt();
    const r = buildAndRun(w, prompt);
    expect(r.code).toBe(0);
    expect(w.got()).toBe(prompt);
  });

  test("the prompt lands in .fleet/role-prompt.md under the workspace", () => {
    const w = world();
    buildAndRun(w, "hello brief");
    expect(readFileSync(join(w.ws, ".fleet", "role-prompt.md"), "utf8")).toBe("hello brief");
  });

  test("an empty prompt still passes --append-system-prompt an empty argument", () => {
    const w = world();
    const r = buildAndRun(w, "");
    expect(r.code).toBe(0);
    expect(w.got()).toBe("");
  });

  test("an existing checkout is cd'd into before claude starts", () => {
    const w = world();
    const repo = join(w.dir, "acme repo");
    mkdirSync(repo);
    buildAndRun(w, "p", repo);
    expect(readFileSync(join(w.dir, "cwd"), "utf8").trim()).toBe(repo);
  });

  test("an unwritable workspace falls back to the inline prompt, and says so", () => {
    const w = world();
    const blocker = join(w.dir, "not-a-dir");
    writeFileSync(blocker, "");
    const r = buildAndRun(w, "inline brief", "", blocker);
    expect(r.code).toBe(0);
    expect(w.got()).toBe("inline brief");
    expect(r.stderr).toContain("could not write the role prompt file");
  });

  // Issue #21 item 4: the shell's "command too long" named the symptom. The
  // inline fallback is the one path left that can overflow tmux (16338
  // bytes per send-keys, measured on tmux 3.2a and 3.4), so it says so.
  test("an inline fallback past tmux's limit names the cause before tmux refuses it", () => {
    const w = world();
    const blocker = join(w.dir, "not-a-dir");
    writeFileSync(blocker, "");
    const r = buildAndRun(w, bigPrompt(), "", blocker);
    expect(r.stderr).toMatch(/launch line is \d+ bytes, over tmux's 16338-byte send-keys limit/);
  });

  test("a short inline fallback stays quiet about the limit", () => {
    const w = world();
    const blocker = join(w.dir, "not-a-dir");
    writeFileSync(blocker, "");
    const r = buildAndRun(w, "short", "", blocker);
    expect(r.stderr).not.toContain("send-keys limit");
  });
});
