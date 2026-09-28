import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PANE_PROBE_CMD } from "../../src/studio/wake";

/**
 * Board issue #41, half one: the pane probe, executed against a REAL tmux
 * server — the same lane and the same reason test/bun/wake-cmd.test.ts
 * exists. `runGatedWake` refuses a wake on this command's OUTPUT, so a
 * source-text assertion proves nothing: what matters is that real tmux prints
 * `claude` for a claude pane, `bash` for a bare shell, and fails non-zero
 * when the window is gone.
 *
 * `isolatedTmuxEnv` is copied from wake-cmd.test.ts verbatim, for the reason
 * that file's own comment gives: TMUX_TMPDIR alone is NOT isolation, and this
 * suite's session/window names are the REAL ones, so a run inside a live
 * studio would otherwise probe — and `kill-server` — that studio's own tmux.
 * Three leads died that way before it was found.
 */
function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return { ...rest, TMUX_TMPDIR: dir };
}

/** Runs PANE_PROBE_CMD against a throwaway server whose `studio:claude`
 *  window runs `command`. `null` skips creating that window entirely. */
function probeAgainst(command: string | null): { stdout: string; code: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-probe-"));
  const env = isolatedTmuxEnv(dir);
  const sh = (cmd: string) =>
    Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  try {
    if (command === null) sh("tmux new-session -d -s studio -n shell 'sleep 30'");
    else sh(`tmux new-session -d -s studio -n claude ${JSON.stringify(command)}`);
    const r = sh(PANE_PROBE_CMD);
    return { stdout: r.stdout.toString(), code: r.exitCode ?? -1, stderr: r.stderr.toString() };
  } finally {
    sh("tmux kill-server 2>/dev/null || true");
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("PANE_PROBE_CMD, executed against a real tmux", () => {
  test("names the window it answered about, then that pane's own command", () => {
    // `sleep 30` is a real foreground process in that pane, exactly as
    // `claude` is in a live studio — the probe reads the process name.
    const r = probeAgainst("sleep 30");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("studio:claude sleep");
  });

  test("reads `bash` for a pane sitting at a bare shell — the case the wake refuses", () => {
    // Exactly how a dead studio looks: the window exists, claude has exited,
    // and keystrokes typed into it would be SHELL COMMANDS.
    const r = probeAgainst("bash");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("studio:claude bash");
  });

  test("a MISSING studio:claude answers about another window and still exits 0 — which is why the probe names it", () => {
    // MEASURED, tmux 3.2a: this is not a hypothetical. `display-message -p -t
    // studio:claude` on a server with no such window silently falls back to
    // the CURRENT pane and exits 0, so the exit code cannot be the gate. The
    // window name in the output is, and runGatedWake compares it.
    const r = probeAgainst(null);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().startsWith("studio:claude ")).toBe(false);
    expect(r.stdout.trim()).toBe("studio:shell sleep");
  });

  test("switches no window — an operator attaching later sees no trace of it", () => {
    // provisionedCheckCmd's own hard requirement, inherited: a probe that
    // selected a window left a studio showing a bare shell and got a healthy
    // lead declared dead. Three false diagnoses from that one cause.
    const dir = mkdtempSync(join(tmpdir(), "fleet-probe-"));
    const env = isolatedTmuxEnv(dir);
    const sh = (cmd: string) =>
      Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    try {
      sh("tmux new-session -d -s studio -n claude 'sleep 30'");
      sh("tmux new-window -d -t studio -n shell 'sleep 30'");
      sh("tmux select-window -t studio:shell");
      sh(PANE_PROBE_CMD);
      const active = sh("tmux display-message -p '#{window_name}'").stdout.toString().trim();
      expect(active).toBe("shell");
    } finally {
      sh("tmux kill-server 2>/dev/null || true");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
