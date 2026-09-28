import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc } from "./exec-snippet";
import { requireTools } from "./require-tool";
import { STUDIO_TMUX, STUDIO_TMUX_SOCKET, withStudioTmux } from "../../src/studio/tmux";

/**
 * Issue #117, IMAGE half: the studio's tmux lives on `tmux -L fleet-studio`,
 * so a plain `tmux` — a test's `kill-server`, a debugging shell, anything the
 * lead or its gates run — addresses the DEFAULT server and can never reach the
 * lead. fleetflare--web-studio's lead died twice on 2026-09-24 exactly that way.
 *
 * Runs the SHIPPED bytes (regions and functions extracted from
 * container/studio-bringup.sh and container/studio-shell.sh) against a REAL
 * tmux, and the Worker's REAL withStudioTmux against the layout they create.
 *
 * SAFETY — this suite addresses two servers by design, so both are pinned
 * inside a throwaway dir: `bin/tmux` sets TMUX_TMPDIR to that dir, unsets
 * TMUX/TMUX_PANE, and refuses `-S` (a socket path could point anywhere). So
 * `-L fleet-studio` and the "default" server both resolve to
 * `<dir>/tmux-<uid>/…`, and the default-server `kill-server` below kills only
 * the throwaway one. Never run with $TMUX set.
 */
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
const SHELL = readFileSync(join(import.meta.dir, "../../container/studio-shell.sh"), "utf8");

/** A `# >>> marker >>>` … `# <<< marker <<<` region, verbatim. */
function extractRegion(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`region opener ${open} not found in source`);
  const closeAt = src.indexOf(close, openAt);
  if (closeAt === -1) throw new Error(`region terminator ${close} not found in source`);
  return src.slice(src.indexOf("\n", openAt) + 1, closeAt);
}

/** Bring-up's tmux shadow: every call it makes goes to fleet-studio. */
const SHADOW = () => extractShellFunc(BRINGUP, "tmux");

/** Bring-up's own session creation: its tmux shadow, then its session region. */
const SESSION = () => `${SHADOW()}\n${extractRegion(BRINGUP, "tmux-render-options")}`;

/** studio-shell.sh's socket choice, verbatim. */
const STUDIO_SOCKET = () => extractShellFunc(SHELL, "studio_socket");

/** The exact line bring-up assembles the lead's launch command with. */
const CMD_STR_LINE = () => {
  const line = BRINGUP.split("\n").find((l) => l.trimStart().startsWith(`cmd_str="$(printf '%q '`));
  if (!line) throw new Error("bring-up's cmd_str assembly line not found");
  return line.trim();
};

class TwoServers {
  readonly dir = mkdtempSync(join(tmpdir(), "fleet-harness-"));
  readonly bin = join(this.dir, "bin");
  readonly env: Record<string, string>;

  constructor() {
    if (process.env.TMUX) throw new Error("refusing to run with $TMUX set");
    const realTmux = Bun.which("tmux");
    const realSleep = Bun.which("sleep");
    if (!realTmux || !realSleep) throw new Error("needs tmux and sleep on PATH");
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(join(this.dir, "home"), { recursive: true });
    writeFileSync(
      join(this.bin, "tmux"),
      "#!/bin/sh\n" +
        'for a in "$@"; do case "$a" in -S*) echo "harness: refusing -S ($a)" >&2; exit 97 ;; -*) ;; *) break ;; esac; done\n' +
        "unset TMUX TMUX_PANE\n" +
        `TMUX_TMPDIR=${JSON.stringify(this.dir)}; export TMUX_TMPDIR\n` +
        `exec ${JSON.stringify(realTmux)} "$@"\n`,
      { mode: 0o755 },
    );
    // The fake lead: records its own environment, then stays up.
    writeFileSync(
      join(this.bin, "claude"),
      `#!/bin/sh\nenv > ${JSON.stringify(join(this.dir, "lead-env"))}\nexec ${JSON.stringify(realSleep)} 300\n`,
      { mode: 0o755 },
    );
    symlinkSync(realSleep, join(this.bin, "lead-sleep"));
    const { TMUX: _t, TMUX_PANE: _p, ...rest } = process.env;
    this.env = {
      ...(rest as Record<string, string>),
      HOME: join(this.dir, "home"),
      XDG_CONFIG_HOME: join(this.dir, "xdg"),
      TMUX_TMPDIR: this.dir,
      SHELL: "/bin/sh",
      PATH: `${this.bin}:${process.env.PATH ?? ""}`,
    };
  }

  sh(script: string): { code: number; stdout: string; stderr: string } {
    const r = Bun.spawnSync({ cmd: ["bash", "-c", script], env: this.env, stdout: "pipe", stderr: "pipe", timeout: 30000 });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
  }

  waitFor(ok: () => boolean, deadlineMs = 10_000): boolean {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      if (ok()) return true;
      Bun.sleepSync(100);
    }
    return false;
  }

  cleanup(): void {
    this.sh(`tmux -L ${STUDIO_TMUX_SOCKET} kill-server 2>/dev/null; tmux kill-server 2>/dev/null; true`);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const REAL = process.env.TMUX ? describe.skip : describe;
const T = 30_000;

let box: TwoServers | null = null;
afterEach(() => {
  box?.cleanup();
  box = null;
});
function fresh(): TwoServers {
  box = new TwoServers();
  return box;
}

REAL("#117 — the studio session lives on `tmux -L fleet-studio`, never the default server", () => {
  test("bring-up creates the studio session on fleet-studio, and nothing on the default server", () => {
    const b = fresh();
    const r = b.sh(`set -euo pipefail\n${SESSION()}`);
    expect(r.code).toBe(0);

    expect(b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} has-session -t =studio`).code).toBe(0);
    expect(b.sh("tmux has-session -t =studio").code).not.toBe(0);
  }, T);

  test("a default-server kill-server — what a test or a debugging shell runs — leaves the studio session and its lead alive", () => {
    const b = fresh();
    expect(b.sh(`set -euo pipefail\n${SESSION()}`).code).toBe(0);
    const L = `tmux -L ${STUDIO_TMUX_SOCKET}`;
    b.sh(`${L} send-keys -t studio:claude -- ${JSON.stringify(`${join(b.bin, "lead-sleep")} 300`)} Enter`);
    const lead = () => b.sh(`${L} display-message -p -t studio:claude '#{pane_current_command}'`).stdout;
    expect(b.waitFor(() => lead() !== "bash" && lead() !== "")).toBe(true);
    const before = lead();
    // Something to kill: a server on the default socket, as a test would start.
    expect(b.sh("tmux new-session -d -s decoy").code).toBe(0);

    expect(b.sh("env -u TMUX tmux kill-server").code).toBe(0);

    expect(b.sh("tmux has-session -t =decoy").code).not.toBe(0);
    expect(b.sh(`${L} has-session -t =studio`).code).toBe(0);
    expect(lead()).toBe(before);
  }, T);

  test("the lead is launched without TMUX/TMUX_PANE, so its own plain `tmux` reaches the default server, not the studio's", () => {
    const b = fresh();
    expect(b.sh(`set -euo pipefail\n${SESSION()}`).code).toBe(0);
    // Control: the pane's shell itself DOES carry TMUX — the strip is real work.
    const paneEnv = join(b.dir, "pane-env");
    b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} send-keys -t studio:claude -- ${JSON.stringify(`env > ${paneEnv}`)} Enter`);
    expect(b.waitFor(() => existsSync(paneEnv) && readFileSync(paneEnv, "utf8").length > 0)).toBe(true);
    expect(readFileSync(paneEnv, "utf8")).toMatch(/^TMUX=.*fleet-studio/m);

    // Bring-up's own assembly line, then its own launch keystrokes.
    const launch = b.sh(
      `set -euo pipefail\n${SHADOW()}\nclaude_args=(--flag)\n${CMD_STR_LINE()}\n` +
        'tmux send-keys -t studio:claude -- " $cmd_str" Enter',
    );
    expect(launch.code).toBe(0);
    const leadEnv = join(b.dir, "lead-env");
    expect(b.waitFor(() => existsSync(leadEnv) && readFileSync(leadEnv, "utf8").length > 0)).toBe(true);

    const env = readFileSync(leadEnv, "utf8");
    expect(env).not.toMatch(/^TMUX=/m);
    expect(env).not.toMatch(/^TMUX_PANE=/m);
  }, T);

  test("the Worker's withStudioTmux (the real function) reaches the lead's pane in the new layout", () => {
    const b = fresh();
    expect(b.sh(`set -euo pipefail\n${SESSION()}`).code).toBe(0);

    const r = b.sh(withStudioTmux(`${STUDIO_TMUX} display-message -p -t studio:claude '#{session_name}:#{window_name} #{socket_path}'`));

    expect(r.stdout).toMatch(new RegExp(`^studio:claude .*/${STUDIO_TMUX_SOCKET}$`));
  }, T);
});

REAL("#117 — studio-shell.sh attaches to whichever server holds the studio", () => {
  const socketOf = (b: TwoServers) =>
    b.sh(`${STUDIO_SOCKET()}\ntmux $(studio_socket) display-message -p '#{socket_path}'`).stdout;

  test("new layout: the session on fleet-studio", () => {
    const b = fresh();
    b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} new-session -d -s studio -n claude`);
    expect(socketOf(b)).toMatch(new RegExp(`/${STUDIO_TMUX_SOCKET}$`));
  }, T);

  test("rollout transition: the session only on the default server (an old bring-up) is still found", () => {
    const b = fresh();
    b.sh("tmux new-session -d -s studio -n claude");
    expect(socketOf(b)).toMatch(/\/default$/);
  }, T);

  test("no session anywhere yet: the fallback creates it on fleet-studio, where bring-up will look", () => {
    const b = fresh();
    const r = b.sh(`${STUDIO_SOCKET()}\ntmux $(studio_socket) new-session -d -s studio -n claude`);
    expect(r.code).toBe(0);
    expect(b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} has-session -t =studio`).code).toBe(0);
    expect(b.sh("tmux has-session -t =studio").code).not.toBe(0);
  }, T);
});

/**
 * #177 review: seven mutants survived the suite above — every call going
 * through the shadow, and studio_socket's order and exact match, were
 * asserted nowhere. Pinned here, one test per mutant family.
 */
REAL("#177 review — bring-up's own launch path goes through the shadow, end to end", () => {
  (existsSync("/proc") ? test : test.skip)("claude_launch_needed + claude_launch land the lead on fleet-studio; nothing reaches the default server", () => {
    const b = fresh();
    // The studio's pane is a bash (bring-up launches only over a bare bash).
    expect(b.sh(`set -euo pipefail\nexport SHELL=/bin/bash\n${SESSION()}`).code).toBe(0);
    // A lead the kernel and tmux name `claude` (Linux reads argv[0]).
    const lb = join(b.dir, "lb");
    mkdirSync(lb);
    symlinkSync(Bun.which("sleep")!, join(lb, "claude"));
    const fns = ["claude_pane_field", "claude_pane_command", "claude_launch_landed", "claude_launch_needed", "claude_launch"]
      .map((f) => extractShellFunc(BRINGUP, f)).join("\n");

    const r = b.sh(
      `set -euo pipefail\n${SHADOW()}\n${fns}\nexport CLAUDE_ALIVE_TRIES=8 CLAUDE_SETTLE_SECONDS=1\n` +
        `if claude_launch_needed; then if claude_launch ${JSON.stringify(`${join(lb, "claude")} 300`)}; then echo LANDED; else echo MISSED; fi; else echo NOT_SENT; fi`,
    );

    expect(r.stdout).toMatch(/^LANDED$/m);
    // On the FIRST attempt: a first send that bypassed the shadow would miss,
    // and the (shadowed) retry would still land it.
    expect(r.stderr).not.toContain("retrying");
    expect(b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} display-message -p -t studio:claude '#{pane_current_command}'`).stdout).toBe("claude");
    expect(b.sh("tmux ls").code).not.toBe(0);
  }, T);
});

REAL("#177 review — studio_socket: order and exact match", () => {
  const socketOf = (b: TwoServers) =>
    b.sh(`${STUDIO_SOCKET()}\ntmux $(studio_socket) display-message -p '#{socket_path}'`).stdout;

  test("BOTH servers hold `studio` (a rollout straggler): fleet-studio wins", () => {
    const b = fresh();
    b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} new-session -d -s studio -n claude`);
    b.sh("tmux new-session -d -s studio -n claude");
    expect(socketOf(b)).toMatch(new RegExp(`/${STUDIO_TMUX_SOCKET}$`));
  }, T);

  test("`studio-old` on fleet-studio is NOT `studio`: the default server's real `studio` is chosen", () => {
    const b = fresh();
    b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} new-session -d -s studio-old -n claude`);
    b.sh("tmux new-session -d -s studio -n claude");
    expect(socketOf(b)).toMatch(/\/default$/);
  }, T);
});

/**
 * The real studio-shell.sh, the way the sandbox runs it: on a pty that is no
 * process's controlling terminal (container-server's Bun.spawn terminal), so
 * its `setsid --ctty` works as in production. Python for the pty; every
 * server pinned under the throwaway TMUX_TMPDIR by TwoServers' wrapper.
 */
const ATTACH_PY = `
import os, subprocess, sys, threading, time
sh, env = sys.argv[1], dict(os.environ)
def t(*a): return subprocess.run(["tmux", *a], env=env, capture_output=True, text=True)
m, s = os.openpty()
p = subprocess.Popen(["bash", sh], stdin=s, stdout=s, stderr=s, env=env)
os.close(s)
stop = False
def drain():
    while not stop:
        try:
            if not os.read(m, 65536): return
        except OSError: return
threading.Thread(target=drain, daemon=True).start()
t0, fs, df = time.time(), "", ""
while time.time() - t0 < 20:
    fs = t("-L", "fleet-studio", "list-clients", "-F", "#{session_name}:#{window_name}").stdout.strip()
    df = t("list-clients", "-F", "#{session_name}:#{window_name}").stdout.strip()
    if fs or df: break
    time.sleep(0.2)
dt = time.time() - t0
stop = True
p.kill(); p.wait(); os.close(m)
print(f"fleet-studio=[{fs}] default=[{df}] secs={dt:.1f}")
`;

REAL("#177 review — the real studio-shell.sh attaches to the right server", () => {
  const attach = (b: TwoServers) => {
    const py = join(b.dir, "attach.py");
    writeFileSync(py, ATTACH_PY);
    const out = b.sh(`TERM=xterm-256color python3 ${JSON.stringify(py)} ${JSON.stringify(join(import.meta.dir, "../../container/studio-shell.sh"))}`).stdout;
    const m = /^(fleet-studio=\[.*\] default=\[.*\]) secs=([\d.]+)$/.exec(out);
    if (!m) throw new Error(`attach probe said: ${out}`);
    return { where: m[1], secs: Number(m[2]) };
  };
  // Issue #369 round 2 (maestro review): a real pty needs python3 + setsid,
  // neither of which this file's own tool-presence checks named before —
  // `Bun.which(...) ? test : test.skip` looked identical whether a dev
  // machine lacked them or the pinned localci image itself regressed.
  const PTY = requireTools(["python3", "setsid"], "studio-shell.sh attach probe (needs a real pty)");

  PTY("attach probe (needs a real pty: python3 + setsid)", () => {
    test("both layouts present, fleet-studio's current window is `shell`: the client lands on fleet-studio, on `claude`", () => {
      const b = fresh();
      b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} new-session -d -s studio -n claude && tmux -L ${STUDIO_TMUX_SOCKET} new-window -t studio -n shell`);
      b.sh("tmux new-session -d -s studio -n claude");
      expect(attach(b).where).toBe("fleet-studio=[studio:claude] default=[]");
    }, T);

    test("only fleet-studio holds `studio`: the wait loop sees it at once — no 10 s wait on the wrong server", () => {
      const b = fresh();
      b.sh(`tmux -L ${STUDIO_TMUX_SOCKET} new-session -d -s studio -n claude`);
      const r = attach(b);
      expect(r.where).toBe("fleet-studio=[studio:claude] default=[]");
      expect(r.secs).toBeLessThan(5);
    }, T);
  });
});
