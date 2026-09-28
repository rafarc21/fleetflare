import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneLeadProbeCmd, parsePaneLeadProbe } from "../../src/studio/observed";
import { STUDIO_TMUX_SOCKET } from "../../src/studio/tmux";

/**
 * Board issue #85, maestro correction #9 — the redesigned pane-lead probe,
 * executed against a REAL tmux server, the same lane and reason
 * test/bun/pane-probe.test.ts exists: `computeSessionVerdict` refuses a
 * pane that answers about a DIFFERENT window (a missing `studio:claude`
 * silently falls back to the current pane and exits 0 — measured, not
 * theorised), so a source-text assertion proves nothing here either. What
 * matters is that real tmux + `/proc` behave the way this command assumes:
 * the LEAD is the pane's DIRECT child named `claude`, never a deeper
 * `claude -p` member subprocess, and a missing window answers `found: false`
 * rather than a foreign pane's own truth.
 *
 * Linux-gated (the production container IS Linux; `/proc/<pid>/cmdline` and
 * `/proc/<pid>/cwd` are Linux-only) — same gate test/bun/pane-probe.test.ts's
 * own #71 coverage already uses.
 *
 * INCIDENT, 2026-09-24: two studio leads died TODAY (~14:52Z and ~15:03Z)
 * while this file was in flight. This suite's session/window names are the
 * REAL ones (`studio:claude`), and its earlier `isolatedTmuxEnv`-only
 * mechanism — TMUX_TMPDIR set, $TMUX/$TMUX_PANE stripped, copied verbatim
 * from wake-cmd.test.ts / pane-probe.test.ts — was not enough to PROVE this
 * suite's own `tmux new-session` / `tmux kill-server` calls could never
 * reach the live server. Every tmux invocation this file issues directly
 * now targets an explicit private socket via `-S`, which bypasses tmux's
 * entire $TMUX / $TMUX_TMPDIR resolution chain outright for those calls —
 * there is no env-var ambiguity left to get wrong. `paneLeadProbeCmd()`
 * itself is production code and is deliberately NOT changed: in production
 * there is exactly one tmux server per container and no socket flag is
 * needed there, so the command under test still resolves via the env-based
 * mechanism (TMUX_TMPDIR, with TMUX/TMUX_PANE stripped). `socketFlag` below
 * computes the EXACT path tmux's own implicit resolution would land on for
 * that TMUX_TMPDIR (`<dir>/tmux-<uid>/default`) and pre-creates it, so the
 * explicit `-S` calls and the env-resolved production call are provably the
 * same socket, not two that merely hope to agree. `assertIsolatedEnv` is a
 * hard runtime guard that throws before ANY tmux command in this file runs
 * if that env could possibly resolve to the real/default socket, rather
 * than silently drifting into it again.
 *
 * CI fix round 1 (board issue #85): the three tests that put a "lead" in the
 * pane used to do it via `exec -a claude sh -c "exec -a claude sleep 30 &
 * sleep 30"` — `exec -a` sets argv[0] only. The kernel's `comm` field is what
 * `pgrep -x claude` (this command's own mechanism, above) actually reads, and
 * comm stays the real binary's name (`sh`/`sleep`) regardless of argv[0].
 * Every one of those three tests' `pgrep -x claude -P $FLEET_PANE_PID`
 * therefore found nothing and `found` read `false`. Fixed with a real FILE
 * literally named `claude`, resolved off `$PATH` — but that file was a POSIX
 * shell SCRIPT (`#!/bin/sh`), which turned out to trade one mismatch for
 * another (see round 2 below).
 *
 * CI fix round 2 (this task, board issue #85): `waitForPane` still failed,
 * expecting `claude` and getting `sh`. Cause, pinned exactly: on Linux, tmux's
 * `pane_current_command` reads the pane's direct-child process's **argv[0]**
 * (via `/proc/<pid>/cmdline`'s first field) — a DIFFERENT kernel-tracked name
 * than `comm`, which is what `pgrep -x` (used above, and by
 * `paneLeadProbeCmd` itself) reads instead. Round 1's `claude` was a shebang
 * SCRIPT (`#!/bin/sh`), and the kernel's script loader runs shebang scripts by
 * re-executing the INTERPRETER with the script path appended to argv — the
 * process becomes `execve("/bin/sh", ["/bin/sh", "<dir>/claude", ...], env)`.
 * That rewrite touches argv[0] (now `/bin/sh`, read by tmux as `sh`) but not
 * `comm` (still `claude`'s basename, per the kernel's own script-loader
 * special case, read fine by `pgrep -x claude`). So the ACTUAL probe
 * mechanism this suite exercises was never broken — only this suite's own
 * `waitForPane` polling loop, which waits on tmux's pane_current_command
 * (argv[0]) rather than on `pgrep`, could never observe `claude` and timed
 * out on `sh` instead.
 *
 * Fix: `claude` is now a SYMLINK to a real BINARY (`bash`), never a script —
 * a real ELF binary's argv[0] is exactly whatever the caller's execve passed
 * (no interpreter rewrite), so both argv[0] (tmux) and comm (`pgrep -x`) read
 * `claude`, the whole life of the process. Fake behaviour comes from `-c`
 * arguments to that bash rather than from a script body: `claude -c '<script>'`
 * runs `<script>` as bash's own command list under a process whose own argv[0]
 * and comm are still `claude` (the script never `exec`s itself away — every
 * script below ends in the `wait` builtin after backgrounding its actual
 * sleep, which forks a CHILD for the wait rather than tail-call-replacing the
 * shell itself, so the `claude`-named process persists rather than becoming
 * `sleep`). This suite's first test additionally needs a DIRECT child of the
 * pane (the lead) alongside a DEEPER grandchild (a member `claude -p`
 * subprocess) to prove `pgrep -P`'s direct-child-only scoping is real — the
 * lead's own `-c` script backgrounds exactly one such member, itself another
 * `claude -c '...' -p &` invocation through the same symlink, before
 * backgrounding its own keep-alive sleep and waiting on both.
 *
 * The pane itself is `/bin/bash`, and every lead is launched by `send-keys`
 * typed INTO that already-running interactive shell — never as the pane's
 * OWN command — mirroring exactly how `bringup-claude-relaunch.test.ts`'s
 * own `start()`/`launchClaude()` split works, and for the identical reason
 * that file's header calls out for its default-shell note: `paneLeadProbeCmd`
 * (`src/studio/observed.ts`) only ever asks `pgrep -x claude -P
 * "$FLEET_PANE_PID"` for a DIRECT child of `#{pane_pid}` — deliberate,
 * unchanged production behaviour — so the lead must be a direct child of
 * that pane process, not a grandchild sitting one `sh -c` layer down. An
 * interactive bash pane that later runs `claude` as a plain foreground job
 * (rather than the pane's own command being a nested `sh -c '...'` that
 * would put the lead a layer deeper) is exactly what keeps that
 * parent/child edge one hop, matching production's own tmux-attach ->
 * send-keys sequence.
 */
const isLinux = process.platform === "linux";

/**
 * Throws if `env` could possibly let a tmux client reach the REAL/default
 * server. Load-bearing, not decorative — two leads died today because
 * isolation that LOOKED sufficient was never actually proven so.
 *
 * - `$TMUX` set means tmux ignores `$TMUX_TMPDIR` entirely and reconnects to
 *   whatever live server the caller is already inside — exactly the studio's
 *   own session, when this runs inside a studio.
 * - An empty/unset `$TMUX_TMPDIR` makes tmux fall back to the bare system
 *   tmp root, the same directory a real server's default socket also lives
 *   under.
 */
function assertIsolatedEnv(env: Record<string, string | undefined>): void {
  if (env.TMUX) {
    throw new Error("refusing to run tmux with $TMUX set — would target the REAL server");
  }
  if (!env.TMUX_TMPDIR) {
    throw new Error("refusing to run tmux with no $TMUX_TMPDIR set — falls back to the system tmp root");
  }
  if (env.TMUX_TMPDIR === tmpdir()) {
    throw new Error("refusing to run tmux with TMUX_TMPDIR pointed at the bare system tmp root");
  }
}

/** Copied from test/bun/pane-probe.test.ts verbatim, for the reason that
 *  file's own comment gives: TMUX_TMPDIR alone is NOT isolation, and this
 *  suite's session/window names are the REAL ones, so a run inside a live
 *  studio would otherwise probe — and `kill-server` — that studio's own
 *  tmux. This env still backs `paneLeadProbeCmd()` itself (production code,
 *  unaware of any test socket), guarded by `assertIsolatedEnv`. Every OTHER
 *  tmux call this file makes uses an explicit `-S` socket instead — see
 *  `socketFlag`.
 *
 *  `PATH` is prepended with `<dir>/bin` — the ONLY addition beyond the
 *  original wake-cmd.test.ts/pane-probe.test.ts copy this comment refers
 *  to — so a bare `claude` typed into the pane resolves to this suite's own
 *  fake lead (see `installFakeClaude`) rather than whatever (if anything)
 *  happens to be named `claude` on the machine running this test. */
function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  const env = { ...rest, TMUX_TMPDIR: dir, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` };
  assertIsolatedEnv(env);
  return env;
}

/**
 * An explicit, per-test private socket, for every tmux invocation THIS FILE
 * issues itself (setup/teardown) — never for `paneLeadProbeCmd()`, which is
 * production code that knows nothing of it and resolves purely via
 * `isolatedTmuxEnv`'s TMUX_TMPDIR instead.
 *
 * The path is not arbitrary: it is the EXACT socket tmux's own implicit
 * resolution computes when `TMUX_TMPDIR=dir` and `$TMUX` is unset
 * (`<dir>/tmux-<uid>/default`), pre-created here so tmux never has to fall
 * back to anything on its own. That makes the explicit `-S` calls below and
 * the env-resolved `paneLeadProbeCmd()` call provably the same socket file,
 * by construction, not by coincidence.
 */
function socketFlag(dir: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const socketDir = join(dir, `tmux-${uid}`);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  return `-S ${join(socketDir, "default")}`;
}

/**
 * A real file literally named `claude`, on `<dir>/bin` — resolved by `$PATH`
 * lookup (see `isolatedTmuxEnv`), never by `exec -a`. Round 2 (this file's
 * own header explains the cause): a SYMLINK to a real ELF binary (`bash`),
 * never a shebang script — a real binary's argv[0] is exactly what execve was
 * given, with no interpreter rewrite, so both argv[0] (what tmux's
 * `pane_current_command` reads) AND the kernel's `comm` field (what `pgrep -x
 * claude` reads) name it `claude`, for the process's whole life. All fake
 * behaviour is driven by `-c` arguments at launch time (see `fakeLead`
 * below), never by anything this file writes into the binary itself.
 */
function installFakeClaude(dir: string): void {
  const bash = Bun.which("bash");
  if (!bash) throw new Error("pane-probe-lead harness needs bash on PATH");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(bash, join(bin, "claude"));
}

/**
 * POSIX single-quote a string for embedding in a shell command line — wraps
 * in `'...'` and escapes any embedded single quote as `'\''`. None of this
 * file's own scripts below contain one, but a helper that assumes that would
 * be the kind of thing that quietly breaks later.
 */
function quoteSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The line typed into the pane to start a fake lead: `claude` (the symlink
 * installed by `installFakeClaude`) invoked with `-c <script>`, so the
 * process bash starts IS the lead — argv[0]/comm `claude`, argv[1] `-c`,
 * argv[2] `script` — and `script` decides what it does next. Every script
 * passed to this file's own tests ends in the `wait` builtin after
 * backgrounding its actual sleep: builtins never trigger bash's tail-call
 * exec-replacement the way a bare trailing external command can, so the
 * `claude`-named process this starts is provably the one still running
 * seconds later, never silently replaced by `sleep` itself.
 */
function fakeLead(script: string): string {
  return `claude -c ${quoteSingle(script)}`;
}

/**
 * The lead script for the one test that needs a DEEPER grandchild: backgrounds
 * one member subprocess — itself another `claude -c '...' -p &` invocation
 * through the very same symlink, so its own comm is ALSO `claude`, but its
 * PPID is the lead, not the pane — before backgrounding its own keep-alive
 * sleep and waiting on both. `pgrep -P`'s direct-child-only scoping must find
 * the lead here and never this member.
 */
const LEAD_WITH_MEMBER = `claude -c "sleep 300" -p & sleep 300 & wait`;

/** The lead script for every other test: no member, no extra argv — just
 *  stays alive long enough for the probe to run against it. */
const LEAD_ALONE = "sleep 300 & wait";

/**
 * Board issue #85, review round 4 (TEST 11): a member deliberately made to
 * differ from the lead on BOTH signals the probe reports (`--continue` in
 * argv, and cwd) — `env -C /` chdir's the member to `/` before it execs into
 * the fake `claude` binary (so the member's own cwd is `/`, distinct from
 * whatever cwd the lead itself is started in), and the member's own argv
 * carries `--continue` (the lead's argv, fixed by `fakeLead` as `claude -c
 * <script>`, never does). If the probe ever answered from the member's
 * `/proc` entry instead of strictly the pane's DIRECT child, this would read
 * back `hasContinue: true` / `cwd: "/"` instead of the lead's own values.
 *
 * Review round 6, MUST-FIX 5(a): `claude` is a symlink to real `bash`
 * (installFakeClaude's own doc comment), and bash's own argument parsing
 * scans for recognised options BEFORE it ever reaches `-c` — an unrecognised
 * long option anywhere ahead of `-c` (`--continue` is not one bash itself
 * knows) makes bash print a usage error and exit 2 immediately, regardless
 * of what follows. The ORIGINAL form here put `--continue` before `-c`
 * (`claude --continue -c "sleep 300" -p`) and the member died on the spot —
 * a silent fixture bug that made this test's own "differs in argv" premise
 * empty: there was no live member process to ever be misread from. Fixed by
 * moving `-c "sleep 300 & wait"` first — bash accepts everything AFTER a
 * `-c script` as plain positional parameters (`$0`, `$1`, ...) to the
 * script, never options to bash itself, so `--continue -p` land there
 * instead: still genuinely present as their OWN literal argv elements
 * (visible in `/proc/<pid>/cmdline`, which is all this suite or the probe
 * itself ever reads), just no longer parsed as bash flags. The script itself
 * is `sleep 300 & wait`, not a bare `sleep 300` — a bare trailing external
 * command triggers bash's own tail-call exec-replacement (this file's own
 * header explains it for the LEAD; the same rule applies to any nested
 * `bash -c` here), which would silently turn this member's `comm` into
 * `sleep` instead of `claude`, exactly the identity this test depends on.
 */
const LEAD_WITH_DIFFERING_MEMBER = `env -C / claude -c "sleep 300 & wait" --continue -p & sleep 300 & wait`;

/** Poll `#{pane_current_command}` for `target` (a `session:window` pair)
 *  until it reads `want`, the same bounded-retry shape
 *  `bringup-claude-relaunch.test.ts`'s own `waitForPane` uses, for the
 *  identical reason: `send-keys` types keystrokes, it does not wait for the
 *  shell to have forked and execed the result before returning. Parameterized
 *  by `target` rather than hardcoding `studio:claude` so `startLeadInPane`
 *  can reuse the exact same settle-and-poll mechanism for a FOREIGN
 *  session/window too, not just the real `studio:claude` one. */
function waitForPane(
  sh: (cmd: string) => { stdout: { toString(): string } }, sock: string, target: string, want: string, tries = 40,
): string {
  let seen = "";
  for (let i = 0; i < tries; i++) {
    seen = sh(`tmux ${sock} display-message -p -t ${target} '#{pane_current_command}'`).stdout.toString().trim();
    if (seen === want) return seen;
    Bun.sleepSync(100);
  }
  return seen;
}

/**
 * `/bin/bash` as the pane's OWN command (never a nested `sh -c '...'`, which
 * would put whatever it launches a layer deeper than the pane's direct
 * child — see this file's own header), then `send-keys` types `launchLine`
 * into that already-running shell and waits for the pane to actually be
 * running `claude` before returning. Mirrors
 * `bringup-claude-relaunch.test.ts`'s own `start()` + `launchClaude()`
 * split exactly, for the same reason.
 *
 * `session`/`window` default to the real `studio`/`claude` pair every
 * existing caller needs, but are parameters (not hardcoded) so a FOREIGN
 * session's fake lead can be started via this exact same safe mechanism too
 * — passing a launch line directly as tmux's own pane-command argument (as
 * this file used to do for the foreign-session tests) skips this settle
 * step entirely and races an immediate `pgrep` against tmux's own
 * fork+exec of the pane, which has not necessarily happened yet by the time
 * `new-session` returns.
 */
function startLeadInPane(
  sh: (cmd: string) => { stdout: { toString(): string } }, sock: string, launchLine: string,
  session = "studio", window = "claude",
): void {
  sh(`tmux ${sock} new-session -d -s ${session} -n ${window} /bin/bash`);
  sh(`tmux ${sock} send-keys -t ${session}:${window} -- ${JSON.stringify(launchLine)} Enter`);
  expect(waitForPane(sh, sock, `${session}:${window}`, "claude")).toBe("claude");
}

describe.skipIf(!isLinux)("paneLeadProbeCmd against a real tmux server (issue #85, maestro correction #9)", () => {
  test("a member `claude -p` subprocess launched BY the lead is never mistaken for the lead itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // Lead: `claude -c '<LEAD_WITH_MEMBER>'` — it backgrounds its own
      // member (also named `claude`, a grandchild of the pane) before
      // waiting on its own keep-alive sleep. See LEAD_WITH_MEMBER's own doc
      // comment.
      startLeadInPane(sh, sock, fakeLead(LEAD_WITH_MEMBER));
      const cmd = paneLeadProbeCmd();
      const res = sh(cmd);
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(true); // the DIRECT child (the lead) is found
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing studio:claude window answers unknown (found: false), never a foreign pane", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      sh(`tmux ${sock} new-session -d -s other -n shell 'sleep 30'`); // a DIFFERENT session/window entirely
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0); // never crashes even though the target does not exist
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(false);
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--continue is detected per-argv-element, never by a substring match on the whole cmdline", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // `LEAD_ALONE` has no `--continue` anywhere in its argv (just
      // `claude`, `-c`, and the script string) — the false case this test
      // pins.
      startLeadInPane(sh, sock, fakeLead(LEAD_ALONE));
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(true);
      expect(probe.hasContinue).toBe(false); // no --continue in this argv at all
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("switches no window and never returns raw argv — the lead's own cwd is readable regardless", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // `cd /tmp` is a bash BUILTIN, run by the pane's own persistent shell
      // before it forks+execs `claude` — the child (the lead) inherits that
      // cwd exactly as a real bring-up's `cd <checkout> && claude ...` line
      // would, with the pane's shell itself staying at whatever `bash`
      // resolved on for #{pane_pid} (unaffected either way).
      startLeadInPane(sh, sock, `cd /tmp && ${fakeLead(LEAD_ALONE)}`);
      sh(`tmux ${sock} new-window -d -t studio -n shell 'sleep 30'`);
      sh(`tmux ${sock} select-window -t studio:shell`);
      const res = sh(paneLeadProbeCmd());
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(true);
      expect(probe.cwd).toBe("/tmp");
      expect(res.stdout.toString()).not.toContain("--append-system-prompt"); // never echoes raw argv
      const active = sh(`tmux ${sock} display-message -p '#{window_name}'`).stdout.toString().trim();
      expect(active).toBe("shell"); // untouched — this command switches nothing
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lead and member differ in argv/cwd — the probe reports the LEAD's, never the member's", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // Lead starts at /tmp; its member (LEAD_WITH_DIFFERING_MEMBER, above)
      // chdir's to `/` and carries `--continue` in its own argv — neither of
      // which the lead's own argv/cwd has.
      startLeadInPane(sh, sock, `cd /tmp && ${fakeLead(LEAD_WITH_DIFFERING_MEMBER)}`);
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(true);
      expect(probe.cwd).toBe("/tmp"); // the LEAD's own cwd, never the member's "/"
      expect(probe.hasContinue).toBe(false); // the LEAD's own argv has no --continue; only the member's does
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lead argv element that merely CONTAINS the substring --continue, but is not exactly --continue, never sets hasContinue", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // `--continue-ish` is its own, single argv element (bash's own `-c`
      // handling turns anything after the script into positional params,
      // never additional flags to bash itself — the kernel's own
      // /proc/<pid>/cmdline still records it as a distinct null-separated
      // element). A substring scan over the whole cmdline would false-positive
      // on this; the per-argv-element EXACT match (`grep -qxF -- --continue`)
      // must not.
      startLeadInPane(sh, sock, `claude -c ${quoteSingle(LEAD_ALONE)} --continue-ish`);
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(true);
      expect(probe.hasContinue).toBe(false);
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an --append-system-prompt value that contains the literal text --continue inside a longer string never sets hasContinue", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // The whole `--append-system-prompt=...` value is ONE argv element
      // (single-quoted so the shell never splits it) that merely contains
      // the substring "--continue" surrounded by other text — never the
      // exact string "--continue" on its own.
      const promptArg = "--append-system-prompt=please --continue thoughtfully";
      startLeadInPane(sh, sock, `claude -c ${quoteSingle(LEAD_ALONE)} ${quoteSingle(promptArg)}`);
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(true);
      expect(probe.hasContinue).toBe(false);
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a foreign pane with an unrelated claude process elsewhere is never found — scoped strictly to the target pane's own pid tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // No `studio:claude` window at all — a DIFFERENT session ("other")
      // entirely, whose own pane happens to be running something ALSO named
      // `claude` (installFakeClaude's fake binary), completely outside the
      // `studio:claude` pane's pid tree. If the probe ever fell back to a
      // bare, unscoped `pgrep -x claude` it would find this process; the real
      // command must not, because it never resolves a target pane pid at all.
      sh(`tmux ${sock} new-session -d -s other -n shell ${quoteSingle(fakeLead(LEAD_ALONE))}`);
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(false);
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review round 6, MUST-FIX 5(b): the existing "foreign pane" test just
  // above proves a DIFFERENT session is ignored, but with no real lead
  // present anywhere to potentially be confused with — it cannot distinguish
  // "scoped to the target pane's own pid tree" from "scoped to the LOWEST
  // claude pid on the system" (which would also happen to answer correctly
  // there, since no real lead exists at all in that test). This test puts a
  // REAL lead in `studio:claude` too, started AFTER a foreign claude-named
  // process elsewhere — so the foreign one genuinely has the LOWER pid —
  // and pins that the probe still finds the real lead: its own `pgrep -P
  // <pane_pid>` scoping (paneLeadProbeCmd, src/studio/observed.ts), not pid
  // ordering, is what actually decides this.
  //
  // Board issue #223 fix: asserting only `probe.found === true` here would
  // ALSO pass if `paneLeadProbeCmd`'s own `pgrep -x claude -P
  // "$FLEET_PANE_PID"` ever had its `-P` (pane-scoping) flag accidentally
  // dropped — an unscoped `pgrep -x claude` finds ANY claude-named process on
  // the system, including the foreign, lower-pid one, and `head -n1` (see
  // paneLeadProbeCmd) would then hand back the foreign process's own pid,
  // still satisfying a bare `found: true`. The real lead is launched via `cd
  // /tmp && ...` with `--continue` as a literal argv element (never present
  // on the foreign process, which runs `LEAD_ALONE` with no cd and no
  // --continue) — asserting BOTH `probe.cwd === "/tmp"` and `probe.hasContinue
  // === true` can only hold true when the probe actually read the REAL
  // lead's own `/proc` entry, never the foreign one's.
  test("a foreign claude process started BEFORE the lead (lower pid) never confuses the probe's own pid-tree scoping", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      // A genuinely foreign session, started FIRST — its own claude-named
      // process therefore gets a LOWER pid than the real lead started below.
      // Launched via `startLeadInPane`'s safe send-keys-into-a-running-bash
      // mechanism (session "other", window "shell"), not by passing the
      // launch line directly as tmux's own pane-command argument — the
      // latter has no settle step before the `pgrep` just below runs, and
      // races tmux's own fork+exec of the pane (see `startLeadInPane`'s own
      // doc comment). No cd, no --continue — neither of the two properties
      // this test distinguishes on.
      startLeadInPane(sh, sock, fakeLead(LEAD_ALONE), "other", "shell");
      const foreignPanePid = sh(`tmux ${sock} display-message -p -t other:shell '#{pane_pid}'`).stdout.toString().trim();
      const foreignLeadPid = Number(sh(`pgrep -x claude -P ${foreignPanePid}`).stdout.toString().trim());

      // The real lead: `cd /tmp` (a bash builtin, run by the pane's own
      // persistent shell before it forks+execs `claude` — same mechanism the
      // "switches no window" test above already relies on) then `claude -c
      // <script> --continue`, so `--continue` lands as its own literal argv
      // element (bash's `-c` handling turns everything after `<script>` into
      // positional params, never flags to bash itself — see
      // LEAD_WITH_DIFFERING_MEMBER's own doc comment for the identical
      // reasoning).
      startLeadInPane(sh, sock, `cd /tmp && claude -c ${quoteSingle(LEAD_ALONE)} --continue`);
      const realPanePid = sh(`tmux ${sock} display-message -p -t studio:claude '#{pane_pid}'`).stdout.toString().trim();
      const realLeadPid = Number(sh(`pgrep -x claude -P ${realPanePid}`).stdout.toString().trim());

      // Genuinely lower, not merely asserted — proves the ordering this test
      // depends on actually held, rather than hoping it did.
      expect(foreignLeadPid).toBeGreaterThan(0);
      expect(realLeadPid).toBeGreaterThan(foreignLeadPid);

      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      // Properties only the REAL lead has — the foreign process has neither
      // (no cd /tmp, no --continue). A dropped `-P` scope would find the
      // foreign process instead and fail both of these.
      expect(probe.found).toBe(true);
      expect(probe.cwd).toBe("/tmp");
      expect(probe.hasContinue).toBe(true);
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review round 6, MUST-FIX 5(c): `paneLeadProbeCmd`'s own target is the
  // SESSION:WINDOW pair `studio:claude` (LEAD_PANE_TARGET, observed.ts) —
  // never "any pane in a session named studio". A session named `studio`
  // whose only window is `shell` (never `claude`) must answer `found: false`
  // even when that unrelated window's own pane happens to have a
  // claude-named child running in it (e.g. a human manually typed `claude`
  // into an ordinary shell there).
  //
  // Board issue #223 fix: the earlier version of this test started the fake
  // lead AS the pane's own tmux command (`new-session ... 'shell'
  // <launch-line>` directly), so the window was never actually observed
  // running a plain "shell" at any point — it ran the fake lead from the
  // moment the session existed. That makes it impossible to tell whether a
  // weakened probe (one that dropped the exact `session_name:window_name`
  // match in favor of, say, a bare `pgrep -x claude` scoped only by session)
  // would actually be caught here, or whether this test just happens to pass
  // for some unrelated reason. Fixed to use the SAME `startLeadInPane` helper
  // every `studio`/`claude` test above already uses — a plain interactive
  // bash pane first, THEN `send-keys` types the launch line in, THEN waits
  // for `pane_current_command` to read `claude` — just pointed at session
  // `studio` window `shell` instead of `studio`/`claude`. This genuinely puts
  // a live, running, claude-comm'd process into a window named `shell`, so
  // the assertion below actually exercises the window-name check rather than
  // merely asserting on a probe that had nothing real to find in the first
  // place.
  test("a `studio` session with only a `shell` window (never `claude`) answers found: false, even with a claude-named child in that pane", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const sock = socketFlag(dir);
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      startLeadInPane(sh, sock, fakeLead(LEAD_ALONE), "studio", "shell");
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0); // never crashes even though studio:claude does not exist
      const probe = parsePaneLeadProbe(res.stdout.toString());
      // The probe's own target is studio:claude (session:window), never
      // merely "any pane in a session called studio" — a live claude process
      // in the wrongly-named window must still read as not-found.
      expect(probe.found).toBe(false);
    } finally {
      sh(`tmux ${sock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Board issue #223, minor item — #117's own socket-aware `withStudioTmux`
  // (tmux.ts): production bring-up moves the studio session to a PRIVATE
  // socket (`tmux -L fleet-studio`), and `paneLeadProbeCmd`'s own
  // `__ff_tmux` wrapper auto-detects it by checking `tmux -L fleet-studio
  // has-session -t =studio` FIRST, falling back to the default socket only
  // when that check fails. Every other test in this file puts the lead on
  // the DEFAULT socket (explicit `-S` pointed at the exact path
  // `isolatedTmuxEnv`'s TMUX_TMPDIR would implicitly resolve to) — none
  // exercises the private-socket auto-detect branch at all. `-L
  // fleet-studio` resolves under the SAME `TMUX_TMPDIR` (isolatedTmuxEnv),
  // so creating the studio session there — via the identical
  // `startLeadInPane` helper, just handed `-L fleet-studio` as its own
  // `sock` — is a small, mechanical extension of the existing fixtures, not
  // a new isolation mechanism: `assertIsolatedEnv` already guards the shared
  // env every tmux call in this file (including this one) runs under.
  test("a lead running on the studio's own PRIVATE tmux socket (-L fleet-studio, #117) is still found via paneLeadProbeCmd's own auto-detection", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pane-probe-"));
    installFakeClaude(dir);
    const env = isolatedTmuxEnv(dir);
    const privateSock = `-L ${STUDIO_TMUX_SOCKET}`;
    const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
    try {
      startLeadInPane(sh, privateSock, fakeLead(LEAD_ALONE));
      // No `-L`/`-S` here — matches production exactly: `paneLeadProbeCmd`'s
      // own `withStudioTmux` wrapper (tmux.ts) resolves the private socket
      // itself, under this same env, with no socket flag from the caller.
      const res = sh(paneLeadProbeCmd());
      expect(res.exitCode).toBe(0);
      const probe = parsePaneLeadProbe(res.stdout.toString());
      expect(probe.found).toBe(true);
    } finally {
      sh(`tmux ${privateSock} kill-server`);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
