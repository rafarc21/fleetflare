import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { accountSwitchCmd } from "../../src/studio/failover";
import { tokenEnv } from "../../src/studio/credentials";

/**
 * Issue #90, the Worker's half: accountSwitchCmd types a shell line into a
 * pane an attach client may be writing terminal replies into.
 *
 * MEASURED (test/bun/bringup-claude-relaunch.test.ts, #126/#132): an
 * attaching xterm.js's DA2 + XTVERSION replies land in the pane as
 * keystrokes; `ESC P` puts readline into a history search, the next typed
 * line is eaten, and the line left behind ends `0;276;0c`. On the CURRENT
 * image, bring-up's relaunch then types its launch in front of that
 * leftover: the lead starts with a corrupted argv (`claude 3000`).
 *
 * The replies are injected right after `respawn-pane` — an Orca row
 * reconnecting to a studio whose pane was just replaced, the window a
 * failover opens. The Worker clears readline with C-c before typing, so the
 * pane is clean for the relaunch that follows.
 *
 * SAFETY: a private tmux server only. `bin/tmux` pins `-f /dev/null -S
 * <tmpdir>/tmux.sock` for every call — the command under test calls a bare
 * `tmux` — and the suite never runs with $TMUX set. Teardown kill-server goes
 * through the same wrapper.
 */
const REPLIES_HEX = [..."\x1b[>0;276;0c\x1bP>|xterm.js(6.0.0)\x1b\\"]
  .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
  .join(" ");

const TOKEN_2 = "sk-ant-oat01-" + "c".repeat(40);

class SwitchPane {
  readonly dir = mkdtempSync(join(tmpdir(), "fleet-harness-"));
  readonly bin = join(this.dir, "bin");
  readonly socket = join(this.dir, "tmux.sock");
  readonly env: Record<string, string>;

  constructor() {
    if (process.env.TMUX) throw new Error("refusing to run with $TMUX set");
    const realTmux = Bun.which("tmux");
    if (!realTmux) throw new Error("needs tmux on PATH");
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(join(this.dir, "home"), { recursive: true });
    const tmux = `${JSON.stringify(realTmux)} -f /dev/null -S ${JSON.stringify(this.socket)}`;
    writeFileSync(
      join(this.bin, "tmux"),
      "#!/bin/sh\n" +
        'case "$1" in -*) echo "harness: refusing global tmux options ($1)" >&2; exit 97 ;; esac\n' +
        "unset TMUX TMUX_PANE\n" +
        // An attach client's replies, arriving just after the pane is replaced.
        'if [ "$1" = respawn-pane ]; then\n' +
        `  ${tmux} "$@" || exit $?\n` +
        "  sleep 0.3\n" +
        `  exec ${tmux} send-keys -t studio:claude -H ${REPLIES_HEX}\n` +
        "fi\n" +
        `exec ${tmux} "$@"\n`,
      { mode: 0o755 },
    );
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

  tmux(args: string): string {
    const r = Bun.spawnSync({
      cmd: ["sh", "-c", `${JSON.stringify(join(this.bin, "tmux"))} ${args}`],
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    return r.stdout.toString().trim();
  }

  start(): void {
    this.tmux(`new-session -d -s studio -n claude ${JSON.stringify("exec /bin/bash")}`);
    this.waitFor(() => this.tmux("display-message -p -t studio:claude '#{pane_current_command}'") === "bash");
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
    this.tmux("kill-server 2>/dev/null || true");
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const REAL = process.env.TMUX ? describe.skip : describe;
const T = 30_000;

let pane: SwitchPane | null = null;
afterEach(() => {
  pane?.cleanup();
  pane = null;
});

REAL("#90 — accountSwitchCmd against a real tmux whose attach client answers after respawn", () => {
  test("leaves the pane's line clean: the next line typed runs exactly as typed", () => {
    const s = (pane = new SwitchPane());
    s.start();

    const r = runSnippet({ shell: "bash", env: { ...s.env, ...tokenEnv(TOKEN_2) }, script: accountSwitchCmd(), timeout: 30000 });
    expect(r.code).toBe(0);
    Bun.sleepSync(500);

    // What bring-up's relaunch does next on the current image: type a line
    // with no C-c of its own.
    const marker = join(s.dir, "marker");
    s.tmux(`send-keys -t studio:claude -- ${JSON.stringify(`touch ${marker}`)} Enter`);
    const landed = s.waitFor(() => existsSync(marker));

    expect({ landed, stray: readdirSync(s.dir).filter((f) => f.startsWith("marker")) }).toEqual({
      landed: true,
      stray: ["marker"],
    });
  }, T);
});
