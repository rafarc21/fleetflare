import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc, runSnippet } from "./exec-snippet";

/**
 * Issue #67: every provision must not start ANOTHER claude.
 *
 * MEASURED 2026-09-23 on `fleetflare--release-studio` after a day of repeated
 * provisions: `pgrep -fc claude` = 62, `free -m` = 458MB free, the lead dead
 * twice in ten minutes. The loop is the dangerous part — a starved container
 * kills the lead, a dead lead reads `bare`, and the documented recovery for
 * `bare` is `fleet provision`, which was adding another process each time.
 *
 * Everything here runs the REAL decision, extracted verbatim out of
 * container/studio-bringup.sh, against a REAL tmux server on a throwaway
 * socket — the same lane and the same reason test/bun/pane-probe.test.ts
 * exists. A source-text assertion cannot tell a guard that holds from one that
 * lies; this suite counts PROCESSES.
 *
 * The one thing not extracted is the launch line itself: bring-up assembles it
 * inline (role prompt, --allowedTools, --effort, the `cd` into the checkout)
 * and that assembly is not what issue #67 is about. The stand-in below is the
 * same shape — one `tmux send-keys -t studio:claude` of a command that starts
 * a process named `claude` in the pane — so what is under test is exactly the
 * decision of WHETHER to send it, and how many processes that leaves behind.
 */
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");

/** A `# >>> name >>>` ... `# <<< name <<<` region of bring-up, verbatim. */
function extractRegion(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`region opener ${open} not found in source`);
  const closeAt = src.indexOf(close, openAt);
  if (closeAt === -1) throw new Error(`region terminator ${close} not found in source`);
  return src.slice(src.indexOf("\n", openAt) + 1, closeAt);
}

const DECISION = () =>
  [
    // Bring-up's tmux shadow (#117): every call below goes `-L fleet-studio`,
    // exactly as shipped. The pinned wrapper lets -L through and its -S wins,
    // so the private socket still holds.
    extractShellFunc(BRINGUP, "tmux"),
    extractShellFunc(BRINGUP, "claude_pane_field"),
    extractShellFunc(BRINGUP, "claude_pane_command"),
    extractShellFunc(BRINGUP, "claude_launch_landed"),
    extractShellFunc(BRINGUP, "claude_stop"),
    extractShellFunc(BRINGUP, "claude_launch_needed"),
    // The launch keystrokes themselves (#90), not a stand-in.
    extractShellFunc(BRINGUP, "claude_launch"),
  ].join("\n");

/**
 * A studio on a throwaway tmux server.
 *
 * SAFETY, and this is not decoration: this fleet's tests killed a studio's
 * tmux twice on 2026-09-24 alone, and the session and window names here are
 * the REAL ones. So isolation is ONE mechanism, not two:
 *
 * - `bin/tmux` is a wrapper first on PATH that execs the real tmux with
 *   `-f /dev/null -S <this.dir>/tmux.sock` — every call, the harness's own
 *   AND the bare `tmux` inside the code extracted from studio-bringup.sh,
 *   lands on that one socket, with no user or system tmux.conf. It scans
 *   tmux's global options and refuses any `-S`, bare or bundled. `-L` is
 *   let through: the pinned `-S` wins over it (measured), so bring-up moving
 *   to `tmux -L fleet-studio` (#122) still lands here.
 * - $TMUX/$TMUX_PANE are stripped, and the constructor refuses outright
 *   when $TMUX is set: a runner inside a tmux pane is one mistake away from
 *   the server it lives in.
 * - HOME, XDG_CONFIG_HOME and TMUX_TMPDIR point into the temp dir, so even
 *   a tmux that got past the wrapper could not reach a default server or
 *   read the machine owner's config.
 *
 * #72's cause was exactly two mechanisms disagreeing: the harness used
 * `-S <dir>/default` while the extracted code's bare `tmux` followed
 * TMUX_TMPDIR to `<dir>/tmux-<uid>/default`, a server that never existed.
 * Every probe in the snippet read empty and the decision refused.
 *
 * Teardown is `kill-server` through the same wrapper, never a bare one.
 */
class FakeStudio {
  readonly dir: string;
  readonly socket: string;
  readonly bin: string;
  /** One line per claude launch the pane actually ran. */
  readonly startLog: string;
  readonly env: Record<string, string | undefined>;

  constructor() {
    if (process.env.TMUX) {
      throw new Error(
        `relaunch harness refuses to run with $TMUX set (${process.env.TMUX}): this runner lives inside a tmux server, and this harness must never be one mistake away from it`,
      );
    }
    const realTmux = Bun.which("tmux");
    const realSleep = Bun.which("sleep");
    if (!realTmux || !realSleep) throw new Error("relaunch harness needs tmux and sleep on PATH");
    this.dir = mkdtempSync(join(tmpdir(), "fleet-harness-"));
    this.socket = join(this.dir, "tmux.sock");
    this.bin = join(this.dir, "bin");
    this.startLog = join(this.dir, "starts");
    const home = join(this.dir, "home");
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(this.bin, "tmux"),
      "#!/bin/sh\n" +
        "# Global options end at the first word that is not an option, or --.\n" +
        "# -c -f -L -S -T take a value: glued (-Sx) or the next word.\n" +
        "skip=0\n" +
        "for a in \"$@\"; do\n" +
        "  if [ \"$skip\" = 1 ]; then skip=0; continue; fi\n" +
        "  case \"$a\" in --) break ;; -?*) ;; *) break ;; esac\n" +
        "  rest=${a#-}\n" +
        "  while [ -n \"$rest\" ]; do\n" +
        "    c=${rest%\"${rest#?}\"}; rest=${rest#?}\n" +
        "    case \"$c\" in\n" +
        "      S) echo \"relaunch harness: refusing to address another tmux server (tmux $*)\" >&2; exit 97 ;;\n" +
        "      c|f|L|T) [ -z \"$rest\" ] && skip=1; break ;;\n" +
        "    esac\n" +
        "  done\n" +
        "done\n" +
        "unset TMUX TMUX_PANE\n" +
        `exec ${JSON.stringify(realTmux)} -f /dev/null -S ${JSON.stringify(this.socket)} "$@"\n`,
      { mode: 0o755 },
    );
    // The fake lead: a SYMLINK named claude to sleep. The kernel names a
    // process (comm) after the basename of the path execve was given; tmux's
    // pane_current_command on Linux reads argv[0]. Invoking the symlink by
    // its path sets BOTH to `claude` — measured on Linux. `exec -a claude`
    // would set argv[0] only, leaving comm `sleep` (PR #121's probe tests
    // went wrong on exactly that); a script named claude reads as its
    // interpreter; a COPY of sleep is SIGKILLed on macOS.
    symlinkSync(realSleep, join(this.bin, "claude"));
    writeFileSync(this.startLog, "");
    const { TMUX: _t, TMUX_PANE: _p, ...rest } = process.env;
    this.env = {
      ...rest,
      HOME: home,
      XDG_CONFIG_HOME: join(this.dir, "xdg"),
      TMUX_TMPDIR: this.dir,
      // tmux runs a window's command through $SHELL -c. /bin/sh is the worst
      // case (dash does not exec a lone command), fixed here so the pane's
      // process tree does not depend on who runs the suite; start() execs.
      SHELL: "/bin/sh",
      PATH: `${this.bin}:${process.env.PATH ?? ""}`,
    };
  }

  /** A tmux command against THIS server only — through the pinned wrapper. */
  tmux(args: string): { stdout: string; code: number } {
    const r = Bun.spawnSync({
      cmd: ["sh", "-c", `${JSON.stringify(join(this.bin, "tmux"))} ${args}`],
      env: this.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    return { stdout: r.stdout.toString().trim(), code: r.exitCode ?? -1 };
  }

  /** Session with the window this fleet's whole launch path addresses by name. */
  start(windowName = "claude", shellCmd = "exec /bin/bash"): void {
    // The pane's shell is named explicitly rather than inherited. The whole
    // launch decision turns on `pane_current_command` reading exactly
    // `bash` — that is the script's own "nothing is running here" signal —
    // and tmux otherwise starts the INVOKING user's login shell, which on a
    // developer's machine is routinely zsh. Without this the suite fails on
    // a macOS checkout for a reason that has nothing to do with the guard,
    // and the studio image (where the pane really is bash) would be the only
    // place it could run.
    //
    // `exec`, because tmux hands this to `$SHELL -c` and a /bin/sh that does
    // not exec leaves bash — and every lead launched in it — one generation
    // below #{pane_pid}. On a studio the lead is the pane process's child.
    this.tmux(`new-session -d -s studio -n ${windowName} ${JSON.stringify(shellCmd)}`);
  }

  /** Put a live claude in the pane, the same way bring-up would. */
  launchClaude(): void {
    this.tmux(`send-keys -t studio:claude -- ${JSON.stringify(this.launchLine())} Enter`);
    this.waitForPane("claude");
  }

  /**
   * Invoked by ABSOLUTE path, which is what makes `claudePids()` able to count
   * only this test's own processes: tmux still reads `claude` for the pane
   * (measured — it reports the exec name, not the path), while /proc carries
   * the temp directory that no other process on the box shares.
   */
  launchLine(): string {
    return `printf 'start\\n' >> ${JSON.stringify(this.startLog)}; ${join(this.bin, "claude")} 300`;
  }

  paneCommand(): string {
    return this.tmux("display-message -p -t studio:claude '#{pane_current_command}'").stdout;
  }

  waitForPane(want: string, tries = 40): string {
    let seen = "";
    for (let i = 0; i < tries; i++) {
      seen = this.paneCommand();
      if (seen === want) return seen;
      Bun.sleepSync(100);
    }
    return seen;
  }

  /** The pane's own process — what tmux started for the window. */
  panePid(): string {
    return this.tmux("display-message -p -t studio:claude '#{pane_pid}'").stdout;
  }

  /**
   * The pane's last non-empty LOGICAL line. `-J` joins wrapped rows:
   * measured on CI, an 80-column pane wrapped the runner's long prompt and
   * the last row read `c` instead of `... 0;276;0c`.
   */
  screenLastLine(): string {
    const lines = this.tmux("capture-pane -p -J -t studio:claude").stdout.split("\n").filter((l) => l.trim() !== "");
    return lines[lines.length - 1] ?? "";
  }

  /**
   * argv of EVERY live process started through this test's fake lead,
   * whatever its arguments — the view claudePids() deliberately does not
   * give, so a corrupted launch (#90 step 6) is visible instead of uncounted.
   */
  leadArgvs(): string[][] {
    const prefix = `${join(this.bin, "claude")}\u0000`;
    const found: string[][] = [];
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (cmdline.startsWith(prefix)) found.push(cmdline.replace(/\u0000$/, "").split("\u0000"));
      } catch {
        // exited between readdir and read
      }
    }
    return found;
  }

  /**
   * #90: poll, with a deadline, until readline has CONSUMED a swallowed
   * launch. Measured (Linux, bash 5.2): the injected replies leave the
   * search prompt `:>|xterm.js(6.0.0)^[\\` on screen; the launch's Enter
   * fails the search and restores the line, which then ends `0;276;0c`.
   * Until that shows, "no lead yet" means nothing.
   */
  waitForSwallowed(deadlineMs = 10_000): string {
    // Returns the screen it last saw, so a miss names what the pane showed.
    const until = Date.now() + deadlineMs;
    let line = "";
    while (Date.now() < until) {
      line = this.screenLastLine();
      if (line.endsWith("0;276;0c") && !line.includes("xterm.js")) return "consumed";
      Bun.sleepSync(100);
    }
    return `not consumed after ${deadlineMs}ms; screen: ${JSON.stringify(this.tmux("capture-pane -p -t studio:claude").stdout)}; TERM in pane: ${this.tmux("show-options -gv default-terminal").stdout}`;
  }

  /** How many launches the pane has actually run. */
  starts(): number {
    return readFileSync(this.startLog, "utf8").split("\n").filter((l) => l !== "").length;
  }

  /**
   * Live `claude` processes belonging to THIS test, counted off /proc rather
   * than pgrep — not because the studio image lacks procps (it is actually
   * present there: measured, `pgrep -fc claude` answers real counts in
   * production, and observed.ts's own paneLeadProbeCmd already relies on
   * `pgrep`/`ps` for the same reason), but because THIS Bun-test harness's
   * own CI environment is not guaranteed to have it, and a count that
   * silently returns zero would turn the central assertion of this file
   * into a no-op.
   */
  claudePids(): string[] {
    const exe = join(this.bin, "claude");
    if (!existsSync("/proc")) {
      // macOS has no /proc. `ps` is the only portable answer, and it is
      // acceptable HERE and not in the container for the same reason the
      // /proc reader exists: what must never happen is a count that returns
      // zero silently. A failed `ps` throws below instead.
      const r = Bun.spawnSync({ cmd: ["ps", "-axo", "pid=,args="], stdout: "pipe", stderr: "pipe" });
      if ((r.exitCode ?? -1) !== 0) throw new Error("ps failed — refusing to report a process count of zero");
      return r.stdout
        .toString()
        .split("\n")
        .filter((l) => l.trim().replace(/^\d+\s+/, "") === `${exe} 300`)
        .map((l) => l.trim().split(/\s+/)[0] ?? "")
        .filter(Boolean);
    }
    // NUL-separated argv, written as the explicit \u0000 escape: a literal
    // backslash-zero followed by a digit is an OCTAL escape, not a NUL, and
    // silently made this count zero — which passes every "no second process"
    // assertion in this file for the wrong reason.
    // EXACT argv, trailing NUL included: a prefix match counted a corrupted
    // `claude 3000` (#90 step 6) as the lead that was sent.
    const needle = `${join(this.bin, "claude")}\u0000300\u0000`;
    const found: string[] = [];
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, "utf8") === needle) found.push(pid);
      } catch {
        // the process exited between readdir and read — not ours to count
      }
    }
    return found;
  }

  /**
   * Issue #90: the DA2 + XTVERSION replies an attaching xterm.js sends, as
   * captured live, typed into the pane as keystrokes — which is what a reply
   * tmux did not consume becomes.
   */
  injectTerminalReplies(deadlineMs = 10_000): void {
    // Only once bash's readline owns the tty (`-icanon`): bytes that land
    // earlier are echoed by the line discipline instead of read as keys, and
    // the #90 tests would stop modelling #90 (#132 review N1).
    const tty = this.tmux("display-message -p -t studio:claude '#{pane_tty}'").stdout;
    const until = Date.now() + deadlineMs;
    for (;;) {
      const st = Bun.spawnSync({ cmd: ["stty", "-F", tty, "-a"], stdout: "pipe", stderr: "pipe" });
      if (/(^|\s)-icanon(\s|$)/.test(st.stdout.toString())) break;
      if (Date.now() >= until) {
        throw new Error(`relaunch harness: readline never owned ${tty} within ${deadlineMs}ms — refusing to inject replies blind`);
      }
      Bun.sleepSync(50);
    }
    this.tmux(`send-keys -t studio:claude -H ${REPLIES_HEX}`);
    Bun.sleepSync(300);
  }

  /**
   * Put a delegating wrapper in front of the pinned one, to stage what a
   * real pane does to keystrokes. `body` is sh; `$P` is the pinned tmux (so
   * every call still lands on the private socket), `$H` this studio's dir.
   */
  interpose(body: string): void {
    renameSync(join(this.bin, "tmux"), join(this.bin, "tmux.pinned"));
    writeFileSync(
      join(this.bin, "tmux"),
      "#!/bin/sh\n" +
        `P=${JSON.stringify(join(this.bin, "tmux.pinned"))}\nH=${JSON.stringify(this.dir)}\n` +
        // Bring-up's calls arrive as `-L fleet-studio <cmd> …` (#117). Drop the
        // socket words so `body` matches on the command itself; the pinned -S
        // decides the server either way.
        '[ "$1" = -L ] && shift 2\n' +
        body +
        "\n",
      { mode: 0o755 },
    );
  }

  /** Run the extracted bring-up decision, then its launch, exactly as the script does. */
  /**
   * The launch goes through bring-up's own claude_launch (#90), so what runs
   * here is the shipped keystroke sequence, not a stand-in. Its waits are
   * shortened through the script's existing test seams; production sets
   * neither, so the defaults stay the production values. MISSED/LANDED is
   * the launch's own verdict, printed after SENT.
   */
  bringup(env: Record<string, string> = {}, line = this.launchLine()) {
    return runSnippet({
      shell: "bash",
      env: { CLAUDE_ALIVE_TRIES: "5", CLAUDE_SETTLE_SECONDS: "1", ...(this.env as Record<string, string>), ...env },
      script:
        "set -euo pipefail\n" +
        // The snippet's bare `tmux` must be the pinned wrapper, or nothing runs.
        `[ "$(command -v tmux)" = ${JSON.stringify(join(this.bin, "tmux"))} ] || { echo "relaunch harness: bare tmux is not the pinned wrapper -- refusing" >&2; exit 97; }\n` +
        `${DECISION()}\n` +
        "if claude_launch_needed; then\n" +
        "  echo SENT\n" +
        `  if claude_launch ${JSON.stringify(line)}; then echo LANDED; else echo MISSED; fi\n` +
        "else\n" +
        "  echo NOT_SENT\n" +
        "fi\n",
      timeout: 60000,
    });
  }

  cleanup(): void {
    this.tmux("kill-server 2>/dev/null || true");
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * This suite runs REAL processes under a REAL tmux and counts them off
 * /proc, which is the whole reason it is worth having — and also why it is
 * Linux-only. Two macOS facts, both measured rather than assumed: there is no
 * /proc, and tmux on macOS names a pane by the RESOLVED binary, so the fake
 * lead (a symlink named `claude` to sleep) reads `sleep` there and never
 * `claude` (measured 2026-09-24, tmux 3.7c). Skipping is honest; a rewritten
 * macOS variant would be testing a different thing. CI is Linux, which is
 * where the count has to hold.
 *
 * Also skipped when $TMUX is set — that is, when the runner itself lives in a
 * tmux pane, which a studio lead always does. The harness refuses to start
 * there (see FakeStudio) rather than risk addressing the server its own
 * caller runs in: this fleet's own tests killed a studio's tmux twice on
 * 2026-09-24.
 *
 * test/bun/bringup-claude-relaunch-hermetic.test.ts covers the same decision
 * with a fake tmux on PATH and runs everywhere, so a developer on a Mac is
 * not left with no signal at all.
 */
const REAL = existsSync("/proc") && !process.env.TMUX ? describe : describe.skip;

/** Issue #90: DA2 + XTVERSION replies an attaching xterm.js sends, as captured live, in hex. */
const REPLIES_HEX = [...Buffer.from("\x1b[>0;276;0c\x1bP>|xterm.js(6.0.0)\x1b\\")]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join(" ");

/** Real processes, real waits: bun's 5s default is shorter than one bring-up. */
const T = 30_000;

let studio: FakeStudio | null = null;
function fresh(): FakeStudio {
  studio = new FakeStudio();
  return studio;
}
afterEach(() => {
  studio?.cleanup();
  studio = null;
});

REAL("studio-bringup.sh claude_launch_needed — a re-provision never adds a second claude (issue #67)", () => {
  test("a studio with a LIVE claude gets no second process, and the pane keeps the original one", () => {
    const s = fresh();
    s.start();
    s.launchClaude();
    const before = s.claudePids();
    expect(before.length).toBe(1);

    const r = s.bringup();

    expect(r.stdout).toContain("NOT_SENT");
    expect(s.starts()).toBe(1);
    expect(s.claudePids()).toEqual(before);
    expect(s.paneCommand()).toBe("claude");
  }, T);

  test("it SAYS it left the lead alone, so re-issuing provision reads as a no-op instead of an action", () => {
    const s = fresh();
    s.start();
    s.launchClaude();

    const r = s.bringup();

    // stderr since #70's review: bring-up STDOUT reaches no log, see the
    // comment on this notice in claude_launch_needed.
    expect(r.stderr).toContain("claude is ALREADY running in tmux studio:claude");
    expect(r.stderr).toContain("launched nothing");
  }, T);

  test("a studio with a DEAD claude (pane at a bare bash) gets exactly one", () => {
    const s = fresh();
    s.start();
    expect(s.waitForPane("bash")).toBe("bash");

    const r = s.bringup();

    expect(r.stdout).toMatch(/^SENT$/m);
    expect(s.waitForPane("claude")).toBe("claude");
    expect(s.starts()).toBe(1);
    expect(s.claudePids().length).toBe(1);
  }, T);

  test("three provisions in a row leave exactly one claude — the measured loop, run", () => {
    const s = fresh();
    s.start();
    // First heals the dead lead, the next two must be no-ops. This is the
    // operator's documented recovery for `bare`, issued the way the incident
    // issued it.
    for (let i = 0; i < 3; i++) {
      s.bringup();
      s.waitForPane("claude");
    }
    expect(s.starts()).toBe(1);
    expect(s.claudePids().length).toBe(1);
  }, T);

  test("a probe that cannot name studio:claude is refused, not believed — no launch at an unidentified pane", () => {
    // MEASURED on tmux 3.2a (PR #60, and re-measured for this change): with
    // `studio:claude` absent, `display-message -p -t studio:claude` answers
    // about the CURRENT pane and exits 0 — here it would answer `bash` about
    // `studio:shell`. A guard that believes it sends a launch into a pane it
    // cannot identify.
    const s = fresh();
    s.start("shell");

    const r = s.bringup();

    expect(r.stdout).toContain("NOT_SENT");
    expect(r.stderr).toContain("could not identify tmux studio:claude");
    expect(s.starts()).toBe(0);
  }, T);

  test("a pane owned by some OTHER process is left alone — not every non-claude pane is a dead lead", () => {
    const s = fresh();
    s.start();
    s.tmux(`send-keys -t studio:claude -- ${JSON.stringify("sleep 120")} Enter`);
    s.waitForPane("sleep");

    const r = s.bringup();

    expect(r.stdout).toContain("NOT_SENT");
    expect(s.starts()).toBe(0);
  }, T);

  test("INVISIBLE: the decision switches no window — an operator attaching later sees no trace", () => {
    const s = fresh();
    s.start();
    s.launchClaude();
    s.tmux("new-window -d -t studio -n shell");
    s.tmux("select-window -t studio:shell");

    s.bringup();

    expect(s.tmux("display-message -p '#{window_name}'").stdout).toBe("shell");
  }, T);
});

REAL("studio-bringup.sh claude_stop — a deliberate replacement, never two (issue #67)", () => {
  test("STUDIO_REPLACE_CLAUDE=1 stops the running claude first, then launches ONE", () => {
    const s = fresh();
    s.start();
    s.launchClaude();
    const before = s.claudePids();
    expect(before.length).toBe(1);

    const r = s.bringup({ STUDIO_REPLACE_CLAUDE: "1" });

    expect(r.stdout).toMatch(/^SENT$/m);
    expect(s.waitForPane("claude")).toBe("claude");
    const after = s.claudePids();
    expect(after.length).toBe(1);
    expect(after).not.toEqual(before);
    expect(s.starts()).toBe(2);
    expect(r.stderr).toContain("STUDIO_REPLACE_CLAUDE=1");
  }, T);

  test("without it, the same live studio is a no-op — replacement is never guessed at", () => {
    // The limit this respects, measured and documented on claude_pane_command:
    // `pane_current_command` reads `claude` for a lead mid-turn, a lead idle
    // waiting on subagents, AND a lead parked on a modal. It answers
    // ALIVE-or-DEAD, never WORKING-or-STOPPED, so "wedged" is NOT a state this
    // script can detect. Replacement is therefore operator-triggered only.
    const s = fresh();
    s.start();
    s.launchClaude();
    const before = s.claudePids();
    expect(before.length).toBe(1);

    s.bringup();

    expect(s.claudePids()).toEqual(before);
    expect(s.starts()).toBe(1);
  }, T);
});

REAL("studio-bringup.sh claude_launch_line — a >64 KB role prompt still launches (issue #6)", () => {
  test("the real launch line, typed through real send-keys, lands a lead holding the whole prompt", () => {
    // MEASURED 2026-09-28 (issue #6): a 4.4 KB brief inlined into the typed
    // line hit tmux's `command too long`; launch and retry both failed. The
    // line claude_launch_line returns is typed here by bring-up's own
    // claude_launch, so a prompt that leaks back into it fails this test.
    const s = fresh();
    const wrap = join(s.dir, "wrap");
    const got = join(s.dir, "got");
    mkdirSync(wrap, { recursive: true });
    // Found first on the pane's PATH: records the prompt it was handed, then
    // execs the harness's fake lead so the pane reads `claude` and the
    // /proc count below sees exactly one.
    writeFileSync(
      join(wrap, "claude"),
      "#!/bin/bash\n" +
        "while [ $# -gt 0 ]; do\n" +
        `  [ "$1" = --append-system-prompt ] && printf '%s' "$2" > ${JSON.stringify(got)}\n` +
        "  shift\n" +
        "done\n" +
        `exec ${JSON.stringify(join(s.bin, "claude"))} 300\n`,
      { mode: 0o755 },
    );
    s.start("claude", `exec env PATH=${wrap}:$PATH /bin/bash`);
    expect(s.waitForPane("bash")).toBe("bash");
    const chunk = `brief line with 'quotes' "double" $HOME \`tick\` and a long tail of words\n`;
    const prompt = chunk.repeat(Math.ceil(70_000 / chunk.length)).trimEnd();
    expect(prompt.length).toBeGreaterThan(64 * 1024);
    const promptPath = join(s.dir, "prompt-in");
    writeFileSync(promptPath, prompt);

    const r = runSnippet({
      shell: "bash",
      env: {
        CLAUDE_ALIVE_TRIES: "10",
        CLAUDE_SETTLE_SECONDS: "1",
        ...(s.env as Record<string, string>),
        FLEET_WORKSPACE: join(s.dir, "ws"),
      },
      script:
        "set -euo pipefail\n" +
        `[ "$(command -v tmux)" = ${JSON.stringify(join(s.bin, "tmux"))} ] || { echo "relaunch harness: bare tmux is not the pinned wrapper -- refusing" >&2; exit 97; }\n` +
        `${DECISION()}\n${extractShellFunc(BRINGUP, "claude_launch_line")}\n` +
        `role_prompt="$(cat ${JSON.stringify(promptPath)})"\n` +
        `line="$(claude_launch_line "$role_prompt" "" --dangerously-skip-permissions)"\n` +
        "if claude_launch \"$line\"; then echo LANDED; else echo MISSED; fi\n",
      timeout: 60000,
    });

    expect(r.stderr).not.toContain("command too long");
    expect(r.stdout).toContain("LANDED");
    expect(s.claudePids().length).toBe(1);
    expect(readFileSync(got, "utf8")).toBe(prompt);
  }, T);
});

REAL("studio-bringup.sh claude-launch region — a large restored session never wedges bring-up (issue #21)", () => {
  test("a 5 MB resumable session plus a 70 KB brief: --continue, the whole brief, one lead, verdict clean", () => {
    // MEASURED 2026-09-28 (issue #21): a studio with a large restored session
    // failed provision and recycle twice each with `command too long`. The
    // session never enters the launch argv -- session-adopt only copies a
    // .jsonl, and the guard only decides --continue -- so what overflowed
    // was the inline brief #6 moved into a file. This runs the REAL
    // claude-launch region, extracted from studio-bringup.sh, with both at
    // their worst, through real send-keys.
    const s = fresh();
    const wrap = join(s.dir, "wrap");
    const got = join(s.dir, "got");
    const argsFile = join(s.dir, "args");
    const repo = join(s.dir, "acme-os");
    mkdirSync(wrap, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(wrap, "claude"),
      "#!/bin/bash\n" +
        `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n` +
        "while [ $# -gt 0 ]; do\n" +
        `  [ "$1" = --append-system-prompt ] && printf '%s' "$2" > ${JSON.stringify(got)}\n` +
        "  shift\n" +
        "done\n" +
        `exec ${JSON.stringify(join(s.bin, "claude"))} 300\n`,
      { mode: 0o755 },
    );
    // The restored session, where claude_has_conversation looks for it:
    // ~/.claude/projects/<cwd with every non-alphanumeric char as `-`>/.
    const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
    const projects = join(s.env.HOME as string, ".claude", "projects", slug);
    mkdirSync(projects, { recursive: true });
    const line = `${JSON.stringify({ type: "user", message: { content: "x".repeat(1000) } })}\n`;
    writeFileSync(join(projects, "f0e1d2c3-4b5a-6978-8a9b-0c1d2e3f4a5b.jsonl"), line.repeat(5000));
    s.start("claude", `exec env PATH=${wrap}:$PATH /bin/bash`);
    expect(s.waitForPane("bash")).toBe("bash");
    const chunk = `brief line with 'quotes' "double" $HOME \`tick\` and a long tail of words\n`;
    const prompt = chunk.repeat(Math.ceil(70_000 / chunk.length)).trimEnd();

    const r = runSnippet({
      shell: "bash",
      env: {
        CLAUDE_ALIVE_TRIES: "10",
        CLAUDE_SETTLE_SECONDS: "1",
        ...(s.env as Record<string, string>),
        FLEET_WORKSPACE: join(s.dir, "ws"),
        STUDIO_ID: "acme-os--web-studio",
        ROLE_PROMPT_B64: Buffer.from(prompt).toString("base64"),
        ROLE_ALLOWED_TOOLS: "Bash(git *) Read",
        ROLE_EFFORT: "",
      },
      script:
        "set -euo pipefail\n" +
        `[ "$(command -v tmux)" = ${JSON.stringify(join(s.bin, "tmux"))} ] || { echo "relaunch harness: bare tmux is not the pinned wrapper -- refusing" >&2; exit 97; }\n` +
        `cd ${JSON.stringify(repo)}\n` +
        `${DECISION()}\n` +
        ["claude_launch_line", "claude_project_dir", "claude_has_conversation", "claude_process_census"]
          .map((f) => extractShellFunc(BRINGUP, f))
          .join("\n") +
        "\n" +
        extractRegion(BRINGUP, "claude-launch") +
        'echo "VERDICT ${claude_launch_failed:-0}"\n',
      timeout: 60000,
    });

    expect(r.stderr).not.toContain("command too long");
    expect(r.stdout).toContain("VERDICT 0");
    expect(readFileSync(argsFile, "utf8").split("\n")).toContain("--continue");
    expect(readFileSync(got, "utf8")).toBe(prompt);
    expect(s.claudePids().length).toBe(1);
    // The size line #6 added, so the next wedge arrives with its own numbers.
    expect(r.stderr).toMatch(/launch line is \d{2,3} bytes \(role prompt \d+ bytes, passed by file\)/);
  }, T);
});

/**
 * The harness's own safety, asserted rather than trusted. Every one of these
 * is a way this fleet's tests have hit, or nearly hit, a tmux they did not
 * own.
 */
describe("relaunch harness — it can only ever reach its OWN tmux server (issue #72)", () => {
  test("refuses to start inside a tmux pane: $TMUX set means a live server is one typo away", () => {
    const saved = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-0/default,1,0";
    try {
      expect(() => new FakeStudio()).toThrow(/TMUX/);
    } finally {
      if (saved === undefined) delete process.env.TMUX;
      else process.env.TMUX = saved;
    }
  });
});

REAL("relaunch harness — one private server, a lead the kernel names claude (issue #72)", () => {
  test("the extracted code's bare `tmux` and the harness's own calls reach ONE server", () => {
    // THE cause of #72: the harness used `-S <dir>/default` while the
    // extracted functions' bare `tmux` followed TMUX_TMPDIR to
    // `<dir>/tmux-<uid>/default` — a server that did not exist. Every probe
    // in the snippet read empty, the decision refused, and a bare
    // toContain("SENT") read the refusal's "NOT_SENT" as a launch.
    const s = fresh();
    s.start();
    const r = runSnippet({
      shell: "bash",
      env: s.env as Record<string, string>,
      script: "tmux display-message -p '#{socket_path}'\n",
    });
    expect(r.stdout.trim()).toBe(s.socket);
    expect(s.tmux("display-message -p '#{socket_path}'").stdout).toBe(s.socket);
  }, T);

  test("a tmux call that tries to name another server is refused, not obeyed", () => {
    const s = fresh();
    s.start();
    // The other server is ALSO inside this test's temp dir: even this
    // negative test must never address a tmux it does not own, should the
    // refusal ever regress.
    const r = Bun.spawnSync({
      cmd: ["bash", "-c", `tmux -S ${JSON.stringify(join(s.dir, "other.sock"))} list-sessions`],
      env: s.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("refusing");
  }, T);

  test("-S is refused wherever it hides among tmux's global options — behind a flag, bundled, after -f", () => {
    const s = fresh();
    s.start();
    const other = JSON.stringify(join(s.dir, "other.sock"));
    for (const opts of [`-u -S ${other}`, `-uS${JSON.parse(other)}`, `-f /dev/null -S ${other}`, `-Lfoo -S ${other}`]) {
      const r = Bun.spawnSync({
        cmd: ["bash", "-c", `tmux ${opts} list-sessions`],
        env: s.env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ opts, code: r.exitCode }).toEqual({ opts, code: 97 });
      expect(r.stderr.toString()).toContain("refusing");
    }
  }, T);

  test("-L passes, and still lands on the private socket: bring-up moving to `tmux -L fleet-studio` (#122) must run here", () => {
    const s = fresh();
    s.start();
    const r = Bun.spawnSync({
      cmd: ["bash", "-c", "tmux -L fleet-studio display-message -p '#{socket_path}'"],
      env: s.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.stdout.toString().trim()).toBe(s.socket);
  }, T);

  test("the private server loads no user or system tmux.conf", () => {
    // A leak here changes the pane under test (default-shell, history,
    // hooks) with whatever the machine's owner configured.
    const xdg = mkdtempSync(join(tmpdir(), "fleet-harness-xdg-"));
    mkdirSync(join(xdg, "tmux"), { recursive: true });
    writeFileSync(join(xdg, "tmux", "tmux.conf"), "set -g @harness_leak yes\n");
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const s = fresh();
      s.start();
      expect(s.tmux("show-options -gqv @harness_leak").stdout).toBe("");
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
      rmSync(xdg, { recursive: true, force: true });
    }
  }, T);

  test("a tmux.conf planted where tmux would look (XDG, HOME) is not loaded either", () => {
    const s = fresh();
    mkdirSync(join(s.dir, "xdg", "tmux"), { recursive: true });
    writeFileSync(join(s.dir, "xdg", "tmux", "tmux.conf"), "set -g @harness_leak_xdg yes\n");
    writeFileSync(join(s.dir, "home", ".tmux.conf"), "set -g @harness_leak_home yes\n");
    s.start();
    expect(s.tmux("show-options -gqv @harness_leak_xdg").stdout).toBe("");
    expect(s.tmux("show-options -gqv @harness_leak_home").stdout).toBe("");
  }, T);

  test("the fake lead's kernel name (comm) is `claude`, not merely its argv[0]", () => {
    // `exec -a claude` sets argv[0] only; comm stays the real binary's name,
    // which is how PR #121's probe tests went wrong. A symlink NAMED claude
    // makes execve's own path end in `claude`, so comm reads it too.
    const s = fresh();
    s.start();
    s.launchClaude();
    const pids = s.claudePids();
    expect(pids.length).toBe(1);
    expect(readFileSync(`/proc/${pids[0]}/comm`, "utf8").trim()).toBe("claude");
    expect(s.paneCommand()).toBe("claude");
    // The lead is a CHILD of the pane's process, as on a studio — not a
    // grandchild under an `sh -c` that never exec'd the pane's bash.
    const ppid = readFileSync(`/proc/${pids[0]}/stat`, "utf8").split(") ")[1]?.split(" ")[1];
    expect(ppid).toBe(s.panePid());
  }, T);

  test("the fake lead STAYS up — still the same process seconds later", () => {
    const s = fresh();
    s.start();
    s.launchClaude();
    const before = s.claudePids();
    expect(before.length).toBe(1);
    Bun.sleepSync(3000);
    expect(s.claudePids()).toEqual(before);
    expect(s.paneCommand()).toBe("claude");
  }, T);
});

/**
 * REGRESSION GUARD, issue #90 — the relaunch hazard, run end to end.
 *
 * A fresh container's pane is created by the attach path before bring-up
 * runs. The attaching terminal (xterm.js in Orca) answers tmux's DA2 and
 * XTVERSION queries, and a reply tmux does not consume lands in the pane as
 * KEYSTROKES. `ESC P` from XTVERSION is readline's M-p (non-incremental
 * history search), so a launch line typed next goes into a search prompt and
 * never runs: `pane runs: bash` 20s later, the lead never came up. Typed
 * again WITHOUT C-c, it lands in front of the leftover `0;276;0c`: argv
 * `claude 3000`. Lab repro (cloudflare/sandbox:0.12.7): 2 replies swallow; 1
 * reply later than ~1s swallows; C-c before the launch comes up clean. Live
 * capture on demosite-life--release-studio: `:>|xterm.js(6.0.0)^[\^[[>0;276;0c...`.
 *
 * The fix is bring-up's claude_launch: C-c, then the launch; on a miss over
 * a bare bash, ONE retry the same way. The first test keeps the HAZARD
 * itself reproducible with raw keystrokes, so a green fix can never be the
 * harness quietly no longer modelling #90.
 */
REAL("REGRESSION GUARD #90 — terminal replies in a fresh pane no longer swallow the launch", () => {
  test("the hazard, raw keys: replies eat a launch typed without C-c, and the retype is CORRUPTED (`3000`)", () => {
    const s = fresh();
    s.start();
    s.injectTerminalReplies();
    const raw = () => s.tmux(`send-keys -t studio:claude -- ${JSON.stringify(s.launchLine())} Enter`);

    raw();
    expect(s.waitForSwallowed()).toBe("consumed");
    expect(s.starts()).toBe(0);

    raw();
    expect(s.waitForPane("claude")).toBe("claude");
    expect(s.leadArgvs()).toEqual([[join(s.bin, "claude"), "3000"]]);
    expect(s.claudePids()).toEqual([]);
  }, T);

  test("replies are injected only once readline owns the pane's tty — never echoed by the line discipline", () => {
    // #132 review N1: replies typed before bash's readline owns the tty are
    // ECHOED by the line discipline (ECHOCTL caret text on screen) instead
    // of read as keystrokes, and the #90 tests stop modelling #90 — measured
    // 1/100 on a ~220-char cwd. Staged deterministically: bash starts 1s late.
    const s = fresh();
    s.start("claude", "sleep 1 && exec /bin/bash");
    s.injectTerminalReplies();

    expect(s.tmux("capture-pane -p -J -t studio:claude").stdout).not.toContain("^[[>0;276;0c");
    s.tmux(`send-keys -t studio:claude -- ${JSON.stringify(s.launchLine())} Enter`);
    expect(s.waitForSwallowed()).toBe("consumed");
    expect(s.starts()).toBe(0);
  }, T);

  test("a pane whose readline never owns the tty makes the injector throw, not inject blind", () => {
    const s = fresh();
    s.start("claude", "sleep 120");
    expect(() => s.injectTerminalReplies(1_000)).toThrow(/readline/);
  }, T);

  test("replies ahead of bring-up's launch: exactly one lead, argv exactly as sent", () => {
    const s = fresh();
    s.start();
    s.injectTerminalReplies();

    const r = s.bringup();

    expect(r.stdout).toMatch(/^SENT$/m);
    expect(r.stdout).toMatch(/^LANDED$/m);
    // The FIRST C-c did it: landing only on the retry would mean it did not.
    expect(r.stderr).not.toContain("retrying");
    expect(s.leadArgvs()).toEqual([[join(s.bin, "claude"), "300"]]);
    expect(s.starts()).toBe(1);
    expect(s.claudePids().length).toBe(1);
  }, T);

  test("two attach clients' replies (the lab's always-swallow case): still exactly one lead", () => {
    const s = fresh();
    s.start();
    s.injectTerminalReplies();
    s.injectTerminalReplies();

    const r = s.bringup();

    expect(r.stdout).toMatch(/^LANDED$/m);
    expect(r.stderr).not.toContain("retrying");
    expect(s.leadArgvs()).toEqual([[join(s.bin, "claude"), "300"]]);
    expect(s.starts()).toBe(1);
  }, T);

  test("replies arriving AFTER the first C-c (attach mid-launch): the retry's own C-c clears them — argv exact", () => {
    const s = fresh();
    s.start();
    // Once, right after bring-up's first C-c: the first launch is eaten, and
    // only the retry's C-c stands between the leftover and `claude 3000`.
    writeFileSync(join(s.dir, "inject"), "1");
    s.interpose(
      '"$P" "$@"; rc=$?\n' +
        'if [ "$*" = "send-keys -t studio:claude C-c" ] && [ "$(cat "$H/inject")" = 1 ]; then\n' +
        '  echo 0 > "$H/inject"; sleep 0.2\n' +
        `  "$P" send-keys -t studio:claude -H ${REPLIES_HEX}; sleep 0.3\n` +
        "fi\n" +
        "exit $rc",
    );

    const r = s.bringup();

    expect(r.stdout).toMatch(/^LANDED$/m);
    expect(r.stderr).toContain("retrying the launch ONCE");
    expect(s.leadArgvs()).toEqual([[join(s.bin, "claude"), "300"]]);
    expect(s.starts()).toBe(1);
  }, T);

  test("a launch whose FIRST typed byte is eaten still lands — C-c into a shell not yet idle at readline", () => {
    // MEASURED (#145 review): C-c into a bash not idle at readline (a fresh
    // or respawned pane, rc files still running) eats the first byte typed
    // after it: `rintf: command not found`, then `+20s` and a retry that can
    // lose the same byte. Staged deterministically: every typed launch loses
    // its first character.
    const s = fresh();
    s.start();
    s.interpose(
      'if [ "$1" = send-keys ] && [ "$4" = "--" ] && [ "$6" = Enter ]; then exec "$P" send-keys -t "$3" -- "${5#?}" Enter; fi\n' +
        'exec "$P" "$@"',
    );
    const line = `printf 'start\\n' >> ${JSON.stringify(s.startLog)} && ${join(s.bin, "claude")} 300`;

    const r = s.bringup({}, line);

    expect({
      verdict: r.stdout.match(/^(LANDED|MISSED)$/m)?.[1],
      screen: s.tmux("capture-pane -p -J -t studio:claude").stdout.split("\n").filter((l) => l.trim()).slice(-2),
    }).toMatchObject({ verdict: "LANDED" });
    expect(s.leadArgvs()).toEqual([[join(s.bin, "claude"), "300"]]);
    expect(s.starts()).toBe(1);
  }, T);

  test("bash gets time to act on each C-c before the launch keys: >= 0.4s gap, first attempt AND retry", () => {
    // #145 review, prod stack (tmux 3.2a / bash 5.1) under load: with the
    // launch typed right behind its C-c, bash was not scheduled in between —
    // the C-c landed late, the launch went into the reply-opened search, and
    // the retry typed in front of the leftover `0;276;0c`: 4/250 leads ran
    // as `claude 3000`, retries 2-8%. With a 0.5 s gap: 0/580.
    const s = fresh();
    s.start();
    // printf, not echo: dash's echo expands the launch line's own `\n`.
    s.interpose('printf \'%s %s\\n\' "$(date +%s.%N)" "$*" >> "$H/keys.log"\nexec "$P" "$@"');
    const first = JSON.stringify(join(s.dir, "first"));
    const line = `if [ -e ${first} ]; then ${s.launchLine()}; else touch ${first}; fi`;

    const r = s.bringup({}, line);

    expect(r.stderr).toContain("retrying");
    const keys = readFileSync(join(s.dir, "keys.log"), "utf8").split("\n").filter((l) => l.includes("send-keys -t studio:claude"));
    const cc = keys.filter((l) => l.endsWith(" C-c")).map((l) => Number(l.split(" ")[0]));
    const launch = keys.filter((l) => l.endsWith(" Enter") && l.includes(" -- ")).map((l) => Number(l.split(" ")[0]));
    expect({ cc: cc.length, launch: launch.length }).toEqual({ cc: 2, launch: 2 });
    for (let i = 0; i < 2; i++) expect(launch[i]! - cc[i]!).toBeGreaterThanOrEqual(0.4);
  }, T);

  test("a launch that misses over a bare bash is retried ONCE, C-c first — one lead", () => {
    const s = fresh();
    s.start();
    // First attempt runs nothing (pane stays bash); the retry launches.
    const first = join(s.dir, "first");
    const line = `if [ -e ${JSON.stringify(first)} ]; then ${s.launchLine()}; else touch ${JSON.stringify(first)}; fi`;

    const r = s.bringup({}, line);

    // Whole context in the received value: a miss here names the pane's
    // screen and bring-up's stderr instead of just `MISSED`.
    expect({
      verdict: r.stdout.match(/^(LANDED|MISSED)$/m)?.[1],
      stderr: r.stderr,
      screen: s.tmux("capture-pane -p -J -t studio:claude").stdout,
    }).toMatchObject({ verdict: "LANDED" });
    expect(r.stderr).toContain("retrying the launch ONCE");
    expect(s.leadArgvs()).toEqual([[join(s.bin, "claude"), "300"]]);
    expect(s.starts()).toBe(1);
  }, T);

  test("the RETRY's own leading space: first attempt misses, every typed launch loses its first byte — the retry still lands", () => {
    // #145 review: a mutation dropping only the retry's leading space
    // (studio-bringup.sh, claude_launch's second send-keys) passed every
    // other test — the first attempt's space was the only one pinned.
    const s = fresh();
    s.start();
    s.interpose(
      'if [ "$1" = send-keys ] && [ "$4" = "--" ] && [ "$6" = Enter ]; then exec "$P" send-keys -t "$3" -- "${5#?}" Enter; fi\n' +
        'exec "$P" "$@"',
    );
    const first = JSON.stringify(join(s.dir, "first"));
    const line = `if [ -e ${first} ]; then printf 'start\\n' >> ${JSON.stringify(s.startLog)} && ${join(s.bin, "claude")} 300; else touch ${first}; fi`;

    const r = s.bringup({}, line);

    expect(r.stderr).toContain("retrying");
    expect({
      verdict: r.stdout.match(/^(LANDED|MISSED)$/m)?.[1],
      screen: s.tmux("capture-pane -p -J -t studio:claude").stdout.split("\n").filter((l) => l.trim()).slice(-2),
    }).toMatchObject({ verdict: "LANDED" });
    expect(s.leadArgvs()).toEqual([[join(s.bin, "claude"), "300"]]);
    expect(s.starts()).toBe(1);
  }, T);

  test("a lead that never comes up gets exactly TWO attempts, then bring-up reports the miss", () => {
    const s = fresh();
    s.start();
    const attempts = join(s.dir, "attempts");
    const r = s.bringup({}, `printf 'a\\n' >> ${JSON.stringify(attempts)}`);

    expect(r.stdout).toMatch(/^MISSED$/m);
    expect(readFileSync(attempts, "utf8")).toBe("a\na\n");
    expect(s.leadArgvs()).toEqual([]);
  }, T);

  test("no retry over a pane something else now owns — never a launch typed into a running process", () => {
    const s = fresh();
    s.start();
    const attempts = join(s.dir, "attempts");
    const r = s.bringup({}, `printf 'a\\n' >> ${JSON.stringify(attempts)}; sleep 120`);

    expect(r.stdout).toMatch(/^MISSED$/m);
    expect(readFileSync(attempts, "utf8")).toBe("a\n");
    expect(s.paneCommand()).toBe("sleep");
  }, T);
});
