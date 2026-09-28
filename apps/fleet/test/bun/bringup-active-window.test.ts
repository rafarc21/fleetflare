// container/studio-bringup.sh — which window is ACTIVE when bring-up ends (#314).
//
// Measured 2026-09-25, image window f5e2f598: after containers were replaced
// and self-healed, the attach terminals for fleetflare--pilot/scratch/
// web-studio all read `[studio] 0:claude- 1:shell*`. A maestro message sent
// to a lead landed in bash. studio-shell.sh selects studio:claude BEFORE it
// attaches -- but a reconnect attaches as soon as the session exists, and
// bring-up's LAST step created the shell window WITHOUT -d, which makes it the
// session's current window; the attached client follows it.
//
// Runs the REAL `shell-window` region against a REAL tmux server in a
// throwaway TMUX_TMPDIR + HOME (same isolation as bringup-tmux-render.test.ts),
// and reads the active window back from tmux. Never a studio's own server.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTools } from "./require-tool";

const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");

function extractRegion(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`region opener ${open} not found in source`);
  const closeAt = src.indexOf(close, openAt);
  if (closeAt === -1) throw new Error(`region terminator ${close} not found in source`);
  return src.slice(src.indexOf("\n", openAt) + 1, closeAt);
}

const REGION = extractRegion(BRINGUP, "shell-window");
// Nested-tmux and tool-absence are different reasons to not run this suite:
// a real tmux server can't safely be started from inside one it doesn't own
// (that's an environment conflict, unconditional skip, not a tool gap), but a
// missing `tmux` itself is exactly the "the pinned localci image is supposed
// to guarantee this" case require-tool.ts covers (issue #356).
const LANE = process.env.TMUX ? describe.skip : requireTools("tmux", "bring-up's shell-window region needs a real tmux server");

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-active-window-"));
  const { TMUX: _t, TMUX_PANE: _p, ...rest } = process.env;
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const env = { ...rest, HOME: home, TMUX_TMPDIR: dir };
  const sh = (cmd: string) => {
    const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
  };
  const active = () => sh(`tmux display-message -p -t studio '#{window_name}'`).stdout;
  const windows = () => sh(`tmux list-windows -t studio -F '#{window_index}:#{window_name}'`).stdout.split("\n");
  const done = () => { sh("tmux kill-server"); rmSync(dir, { recursive: true, force: true }); };
  return { sh, active, windows, done };
}

LANE("#314 — bring-up leaves studio:claude as the ACTIVE window", () => {
  test("fresh session (a replaced container): shell window created, claude still active", () => {
    const h = harness();
    try {
      expect(h.sh("tmux new-session -d -s studio -n claude").code).toBe(0);
      expect(h.sh(REGION).code).toBe(0);
      expect(h.windows()).toEqual(["0:claude", "1:shell"]);
      expect(h.active()).toBe("claude");
    } finally {
      h.done();
    }
  });

  test("a session already sitting on shell (left by an older bring-up or an operator): re-run returns it to claude", () => {
    const h = harness();
    try {
      h.sh("tmux new-session -d -s studio -n claude && tmux new-window -t studio -n shell");
      expect(h.active()).toBe("shell"); // the measured #314 state
      expect(h.sh(REGION).code).toBe(0);
      expect(h.windows()).toEqual(["0:claude", "1:shell"]);
      expect(h.active()).toBe("claude");
    } finally {
      h.done();
    }
  });

  test("a client ATTACHED during bring-up never sees the shell window become current, even for an instant", () => {
    // The #314 shape: a reconnect attaches while bring-up still runs. A
    // control-mode client (tmux -C) gets a %session-window-changed event for
    // every switch the session makes. Without -d the new shell window becomes
    // current, then select-window puts claude back -- the end state looks
    // fine, but the attached client DID land on shell in between: a message
    // typed at that moment runs in bash.
    const h = harness();
    try {
      h.sh("tmux new-session -d -s studio -n claude");
      const shellWindowId = "@1";
      const log = h.sh(
        `ctl=$(mktemp); (sleep 2 | tmux -C attach -t studio > "$ctl" 2>&1) & sleep 0.5\n` +
        `${REGION}\n` +
        `sleep 0.5; tmux list-windows -t studio -F '#{window_id}:#{window_name}'; echo ---; wait; cat "$ctl"`,
      ).stdout;
      expect(log).toContain(`${shellWindowId}:shell`);
      const events = log.split("\n").filter((l) => l.startsWith("%session-window-changed"));
      expect(events.filter((l) => l.endsWith(` ${shellWindowId}`))).toEqual([]);
    } finally {
      h.done();
    }
  });

  test("re-run is idempotent: never a second shell window", () => {
    const h = harness();
    try {
      h.sh("tmux new-session -d -s studio -n claude");
      h.sh(REGION);
      h.sh(REGION);
      expect(h.windows()).toEqual(["0:claude", "1:shell"]);
      expect(h.active()).toBe("claude");
    } finally {
      h.done();
    }
  });
});
