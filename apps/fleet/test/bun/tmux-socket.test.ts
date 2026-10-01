// Issue #117 — the dual-socket tmux builder (src/studio/tmux.ts).
//
// The image half moves the studio session onto a private socket
// (`tmux -L fleet-studio`) so a plain `tmux` in a test or a debugging shell
// can no longer kill the lead. The Worker half ships FIRST, so every command
// it sends must reach the lead on EITHER socket: the private one when bring-up
// created it, the default server otherwise.
//
// Two lanes here:
//   1. A fake `tmux` on PATH that records argv — proves the builder's shell
//      passes every argument through byte-for-byte (quoting) and picks the
//      socket the probe says.
//   2. A REAL tmux, reached only through a wrapper that pins every call to a
//      random `-L` socket. This Mac and the studios run other agents' tmux;
//      nothing here may ever address a default or ambient server.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUDIO_TMUX, STUDIO_TMUX_SOCKET, withStudioTmux } from "../../src/studio/tmux";
import { PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd } from "../../src/studio/wake";
import { inspectCmd } from "../../src/studio/inspect";
import { accountSwitchCmd, paneCaptureCmd } from "../../src/studio/failover";
import { tokenEnv } from "../../src/studio/credentials";
import { provisionedCheckCmd } from "../../src/studio/provision";
import { runSnippet } from "./exec-snippet";

const TOKEN = "sk-ant-oat01-" + "b".repeat(40);

/** Every command the Worker hands sbExec that talks to tmux. */
const WORKER_TMUX_CMDS: [string, string][] = [
  ["wakeCmd", wakeCmd("hi")],
  ["PANE_PROBE_CMD", PANE_PROBE_CMD],
  ["PANE_SCREEN_CMD", PANE_SCREEN_CMD],
  ["inspectCmd", inspectCmd("websites")],
  ["paneCaptureCmd", paneCaptureCmd()],
  ["accountSwitchCmd", accountSwitchCmd()],
  ["provisionedCheckCmd", provisionedCheckCmd("websites")],
];

// STUDIO_TMUX_SOCKET's own literal value ("fleet-studio") has real behavior
// coverage already: test/bun/studio-tmux-socket.test.ts runs the REAL
// container/studio-bringup.sh and studio-shell.sh against a real tmux and
// hardcodes that same literal, proving the Worker and image sides agree —
// not just re-asserting the constant against itself.
describe("the builder's contract", () => {
  test.each(WORKER_TMUX_CMDS)("%s is wrapped by withStudioTmux and calls tmux only through it", (_name, cmd) => {
    expect(cmd.startsWith(withStudioTmux(""))).toBe(true);
    expect(cmd.slice(withStudioTmux("").length)).toContain(`${STUDIO_TMUX} `);
  });

  test.each(WORKER_TMUX_CMDS)("%s parses as POSIX sh", (_name, cmd) => {
    const r = Bun.spawnSync({ cmd: ["sh", "-n", "-c", cmd], stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lane 1: fake tmux, recorded argv
// ---------------------------------------------------------------------------

const SEP = "\u001f";

/** A `tmux` that records each call's argv (fields joined by \x1f) and answers
 *  `-L <socket> has-session` with 0 only when `privateUp` is true. */
function fakeTmux(privateUp: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fake-tmux-sock-"));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "tmux"),
    [
      "#!/usr/bin/env bash",
      `(IFS=$'${"\\x1f"}'; printf '%s\\n' "$*") >> ${JSON.stringify(log)}`,
      `if [ "$1" = -L ] && [ "$3" = has-session ]; then exit ${privateUp ? 0 : 1}; fi`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    run: (script: string) =>
      runSnippet({ shell: "sh", sourced: true, env: { PATH: `${dir}:${process.env.PATH ?? ""}` }, script }),
    calls: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((l) => l.split(SEP)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("withStudioTmux, run against a fake tmux", () => {
  const nasty = `it's $HOME \`id\`; "quoted" | & > < \\ tail`;

  test("no private studio session: probes -L once, then addresses the DEFAULT server", () => {
    const t = fakeTmux(false);
    try {
      const r = t.run(wakeCmd(nasty));
      expect(r.parentAlive).toBe(true);
      const calls = t.calls();
      expect(calls[0]).toEqual(["-L", STUDIO_TMUX_SOCKET, "has-session", "-t", "=studio"]);
      // Issue #136: the wake scans the pane before typing and again before
      // Enter, so capture-pane now comes first (and again before Enter).
      // Issue #249 round-2 item 3: and ONCE MORE AFTER the Enter, to confirm the
      // prompt actually left the input box instead of sitting there as a draft.
      expect(calls.filter((c) => c[2] !== "has-session")).toEqual([
        ["capture-pane", "-p", "-t", "studio:claude"],
        ["send-keys", "-t", "studio:claude", "-l", "--", nasty],
        ["capture-pane", "-p", "-t", "studio:claude"],
        ["send-keys", "-t", "studio:claude", "Enter"],
        ["capture-pane", "-p", "-t", "studio:claude"],
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("private studio session up: every call carries -L fleet-studio, argv byte-identical", () => {
    const t = fakeTmux(true);
    try {
      t.run(wakeCmd(nasty));
      const real = t.calls().filter((c) => c[2] !== "has-session");
      expect(real).toEqual([
        ["-L", STUDIO_TMUX_SOCKET, "capture-pane", "-p", "-t", "studio:claude"],
        ["-L", STUDIO_TMUX_SOCKET, "send-keys", "-t", "studio:claude", "-l", "--", nasty],
        ["-L", STUDIO_TMUX_SOCKET, "capture-pane", "-p", "-t", "studio:claude"],
        ["-L", STUDIO_TMUX_SOCKET, "send-keys", "-t", "studio:claude", "Enter"],
        // Issue #249 round-2 item 3: the submit confirmation's own capture, on
        // the SAME socket as every other call.
        ["-L", STUDIO_TMUX_SOCKET, "capture-pane", "-p", "-t", "studio:claude"],
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("format strings with #{...} and spaces survive as ONE argument", () => {
    const t = fakeTmux(true);
    try {
      t.run(PANE_PROBE_CMD);
      const real = t.calls().filter((c) => c[2] !== "has-session");
      expect(real).toEqual([
        ["-L", STUDIO_TMUX_SOCKET, "display-message", "-p", "-t", "studio:claude",
          "#{session_name}:#{window_name} #{pane_current_command}"],
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("tmux's exit code is the command's exit code (a failing call still fails)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-fake-tmux-fail-"));
    writeFileSync(join(dir, "tmux"), "#!/bin/sh\n[ \"$1\" = -L ] && exit 1\necho boom >&2\nexit 3\n", { mode: 0o755 });
    try {
      const r = runSnippet({
        shell: "sh", sourced: true, env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
        script: withStudioTmux(`${STUDIO_TMUX} send-keys -t studio:claude Enter`),
      });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("boom");
      expect(r.parentAlive).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Lane 2: REAL tmux, every call pinned to a random -L socket
// ---------------------------------------------------------------------------

const REAL_TMUX = Bun.which("tmux");

/**
 * A sandbox where `tmux` on PATH is a wrapper that rewrites the socket:
 *   `tmux -L fleet-studio ...` -> real tmux -L <privSock> ...   (the "private" server)
 *   `tmux ...` (no -L)         -> real tmux -L <defSock> ...    (the "default" server)
 * Any other socket argument is refused. So the builder runs unmodified and
 * sees two servers, and the real tmux is only ever reached on two random
 * sockets under a throwaway TMUX_TMPDIR.
 */
function realSandbox() {
  // /tmp, not os.tmpdir(): macOS's $TMPDIR is long enough that
  // $TMUX_TMPDIR/tmux-<uid>/<socket> overflows the 104-byte unix socket path
  // limit and tmux fails with "File name too long".
  const dir = mkdtempSync("/tmp/ff117-");
  const rand = () => `f${Math.random().toString(36).slice(2, 10)}`;
  const privSock = rand();
  const defSock = rand();
  const bin = join(dir, "bin");
  Bun.spawnSync({ cmd: ["mkdir", "-p", bin] });
  writeFileSync(
    join(bin, "tmux"),
    [
      "#!/bin/sh",
      // A caller INSIDE a pane (the account switch's adopt line) has $TMUX
      // naming its own server — one of the two random sockets below. Plain
      // tmux there must reach that server, exactly as in a studio.
      `if [ -n "$TMUX" ] && [ "$1" != -L ]; then exec ${REAL_TMUX} "$@"; fi`,
      `if [ "$1" = -L ]; then`,
      `  [ "$2" = ${STUDIO_TMUX_SOCKET} ] || { echo "wrapper: refused socket $2" >&2; exit 97; }`,
      `  shift 2; exec ${REAL_TMUX} -L ${privSock} "$@"`,
      `fi`,
      `case "$1" in -*) echo "wrapper: refused flag $1" >&2; exit 97 ;; esac`,
      `exec ${REAL_TMUX} -L ${defSock} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = { ...process.env, TMUX_TMPDIR: dir, PATH: `${bin}:${process.env.PATH ?? ""}` };
  const sh = (cmd: string, extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync({
      cmd: ["sh", "-c", cmd], env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  /** Direct real-tmux call on one of the two random sockets. */
  const on = (sock: "priv" | "def", args: string) =>
    sh(`${REAL_TMUX} -L ${sock === "priv" ? privSock : defSock} ${args}`);
  const cleanup = () => {
    on("priv", "kill-server 2>/dev/null");
    on("def", "kill-server 2>/dev/null");
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, sh, on, cleanup };
}

describe("withStudioTmux against a REAL tmux (random -L sockets only)", () => {
  beforeAll(() => {
    // Hard stop: a test that ran inside a tmux pane has historically reached
    // the live server through $TMUX and killed studio leads (2026-09-18,
    // 2026-09-24). Every call below is pinned to a random -L socket, but if
    // $TMUX is set something is already wrong with how this suite was run.
    if (process.env.TMUX) throw new Error("refusing to run: $TMUX is set (running inside a tmux session)");
    if (!REAL_TMUX) throw new Error("tmux not on PATH — this lane needs a real tmux");
  });

  let box: ReturnType<typeof realSandbox> | null = null;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  function waitForFile(path: string): string {
    for (let i = 0; i < 30; i++) {
      if (existsSync(path) && readFileSync(path, "utf8").includes("\n")) break;
      Bun.spawnSync({ cmd: ["sleep", "0.1"] });
    }
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  test("old image — studio on the DEFAULT server only: the wake lands there", () => {
    box = realSandbox();
    const out = join(box.dir, "def-out");
    expect(box.on("def", `new-session -d -s studio -n claude ${JSON.stringify(`cat > ${out}`)}`).code).toBe(0);
    const r = box.sh(wakeCmd("WAKE default"));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(waitForFile(out)).toBe("WAKE default\n");
  });

  test("new image — studio on the PRIVATE socket: the wake lands there, a default-server decoy gets nothing", () => {
    box = realSandbox();
    const priv = join(box.dir, "priv-out");
    const decoy = join(box.dir, "decoy-out");
    expect(box.on("priv", `new-session -d -s studio -n claude ${JSON.stringify(`cat > ${priv}`)}`).code).toBe(0);
    expect(box.on("def", `new-session -d -s studio -n claude ${JSON.stringify(`cat > ${decoy}`)}`).code).toBe(0);
    const r = box.sh(wakeCmd("WAKE private"));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(waitForFile(priv)).toBe("WAKE private\n");
    expect(existsSync(decoy) ? readFileSync(decoy, "utf8") : "").toBe("");
  });

  test("the pane probe reads the private session", () => {
    box = realSandbox();
    expect(box.on("priv", "new-session -d -s studio -n claude 'sleep 30'").code).toBe(0);
    const r = box.sh(PANE_PROBE_CMD);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("studio:claude sleep");
  });

  test("a plain `tmux kill-server` (default server) leaves the private studio alive", () => {
    box = realSandbox();
    expect(box.on("priv", "new-session -d -s studio -n claude 'sleep 30'").code).toBe(0);
    expect(box.on("def", "new-session -d -s scratch 'sleep 30'").code).toBe(0);
    // What a test or a debugging shell types when it has NO $TMUX (not inside
    // a pane). Via the wrapper it hits the random "default" socket, standing in
    // for the real default server. A caller INSIDE the studio's pane still
    // reaches the private server through $TMUX — the socket does not stop that.
    box.sh("tmux kill-server");
    expect(box.on("def", "has-session -t scratch").code).not.toBe(0);
    expect(box.on("priv", "has-session -t studio").code).toBe(0);
    expect(box.sh(PANE_PROBE_CMD).stdout.trim()).toBe("studio:claude sleep");
  });

  test("a private session merely PREFIXED `studio` (studio-old) is not the studio: falls back to default", () => {
    // tmux resolves `-t studio` by prefix when no exact name matches, so an
    // unanchored probe says "private is up" and send-keys lands in studio-old.
    box = realSandbox();
    const def = join(box.dir, "def-out");
    const old = join(box.dir, "old-out");
    expect(box.on("priv", `new-session -d -s studio-old -n claude ${JSON.stringify(`cat > ${old}`)}`).code).toBe(0);
    expect(box.on("def", `new-session -d -s studio -n claude ${JSON.stringify(`cat > ${def}`)}`).code).toBe(0);
    const r = box.sh(wakeCmd("WAKE exact"));
    expect(r.code).toBe(0);
    expect(waitForFile(def)).toBe("WAKE exact\n");
    expect(existsSync(old) ? readFileSync(old, "utf8") : "").toBe("");
  });

  test("account switch on the PRIVATE socket: token lands in its session env and the pane adopts it", () => {
    box = realSandbox();
    // Private studio: a bash pane the switch respawns. Default-server decoy
    // `studio` must receive nothing.
    expect(box.on("priv", "new-session -d -s studio -n claude -x 200 -y 50 'bash --norc'").code).toBe(0);
    expect(box.on("def", "new-session -d -s studio -n claude 'bash --norc'").code).toBe(0);
    // Token only via env ($FLEET_TOKEN), as runAccountFailover hands it.
    const r = box.sh(accountSwitchCmd(), tokenEnv(TOKEN));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(box.on("priv", "show-environment -t studio CLAUDE_CODE_OAUTH_TOKEN").stdout.trim())
      .toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`);
    expect(box.on("def", "show-environment -t studio CLAUDE_CODE_OAUTH_TOKEN").stdout).not.toContain(TOKEN);
    // The adopt line ran in the private pane's shell: ask that shell.
    const probe = join(box.dir, "pane-token");
    // Single-quoted so the OUTER sh -c does not expand the variable first.
    box.on("priv", `send-keys -t studio:claude 'printf "%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN" > ${probe}' Enter`);
    expect(waitForFile(probe)).toBe(`${TOKEN}\n`);
    expect(box.on("priv", "capture-pane -p -t studio:claude").stdout).toContain("__ff_t=$(tmux show-environment");
  });
});
