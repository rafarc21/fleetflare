import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { redactSecrets } from "../../src/studio/redact";
import { bringupLogAppendCmd, bringupLogTailCmd, BRINGUP_LOG_PATH } from "../../src/studio/provision";

// Issue #38, measured 2026-09-23: a deploy bumped the studio image digest,
// Cloudflare replaced every running container, and SIX `acme-os` studios
// came back with `/workspace` EMPTY — no clone, pane running `bash` instead
// of claude. Nothing recorded why. `/var/log` held nothing,
// `find / -maxdepth 4 -name "*bringup*log*"` returned nothing, and the only
// forensic evidence was the mtimes of `/workspace/.fleet/remote-branches.txt`
// and `working-set.md`, read from inside a container shell.
//
// Part 1 of the issue: studio-bringup.sh writes every step, timestamped and
// run-id-tagged, to a file that survives the run — and no secret may ever
// reach it, because the log surviving the run is exactly what makes a token
// in it a real leak.
//
// These tests run the REAL function bodies a studio container executes,
// extracted verbatim out of container/studio-bringup.sh, so what is exercised
// here is the shipped code and not a re-typed copy of it.
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");

/**
 * Pull one `name() { ... }` body out of shell source, brace-matched from the
 * opening line to a closing `}` at column 0 — the shape every function in
 * studio-bringup.sh is written in.
 *
 * Deliberately local to this file rather than added to ./exec-snippet: PR #58
 * (issue #54) adds its own `extractShellFunc` to that shared module for the
 * claude-launch functions, and a second edit to the same few lines would be a
 * merge conflict over ten lines of test helper. When both have landed these
 * two collapse into one.
 */
function extractFunc(src: string, name: string): string {
  const open = `${name}() {`;
  const at = src.indexOf(`\n${open}`);
  if (at === -1) throw new Error(`shell function ${name}() not found in studio-bringup.sh`);
  const rest = src.slice(at + 1);
  const end = rest.indexOf("\n}\n");
  if (end === -1) throw new Error(`shell function ${name}() has no closing brace at column 0`);
  return rest.slice(0, end + 2);
}

/** Every function the log region defines, in one blob, ready to source. */
function logFuncs(): string {
  return [
    extractFunc(BRINGUP, "bringup_redact"),
    extractFunc(BRINGUP, "bringup_log"),
    extractFunc(BRINGUP, "bringup_step"),
  ].join("\n");
}

interface LogHome {
  dir: string;
  log: string;
  read: () => string;
  cleanup: () => void;
}

function logHome(): LogHome {
  const dir = mkdtempSync(join(tmpdir(), "fleet-bringup-log-"));
  mkdirSync(join(dir, ".fleet"), { recursive: true });
  const log = join(dir, ".fleet", "bringup.log");
  return {
    dir,
    log,
    read: () => {
      try {
        return readFileSync(log, "utf8");
      } catch {
        return "";
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Sources the real log functions with a fixed run id and writes via them. */
function runWithLog(home: LogHome, script: string, runId = "20260923T174201Z-1a2b3c4d") {
  return runSnippet({
    shell: "bash",
    env: {
      FLEET_BRINGUP_LOG: home.log,
      FLEET_BRINGUP_RUN_ID: runId,
    },
    script: `${logFuncs()}\n${script}\n`,
  });
}

describe("studio-bringup.sh bring-up log — every step lands in a file that survives the run (issue #38 part 1)", () => {
  test("bringup_log appends a line carrying the run id and an ISO-8601 UTC timestamp", () => {
    const home = logHome();
    try {
      const r = runWithLog(home, `bringup_log "hello"`);
      expect(r.parentAlive).toBe(true);
      const body = home.read();
      expect(body).toContain("20260923T174201Z-1a2b3c4d");
      expect(body).toContain("hello");
      expect(body).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /m);
    } finally {
      home.cleanup();
    }
  });

  test("bringup_step names the step, and closes the PREVIOUS step with its exit code", () => {
    const home = logHome();
    try {
      runWithLog(home, `bringup_step tailscaled\nbringup_step "tmux-session"`);
      const body = home.read();
      expect(body).toContain("step tailscaled");
      // Reaching the next step under `set -e` IS the previous step's exit
      // code: the region ran to completion. That is the recorded 0.
      expect(body).toContain("step-ok tailscaled exit=0");
      expect(body).toContain("step tmux-session");
    } finally {
      home.cleanup();
    }
  });

  test("two runs APPEND, each under its own run id — the previous run's evidence is never overwritten", () => {
    const home = logHome();
    try {
      runWithLog(home, `bringup_log "first run"`, "20260923T174201Z-aaaaaaaa");
      runWithLog(home, `bringup_log "second run"`, "20260923T180000Z-bbbbbbbb");
      const body = home.read();
      expect(body).toContain("20260923T174201Z-aaaaaaaa");
      expect(body).toContain("first run");
      expect(body).toContain("20260923T180000Z-bbbbbbbb");
      expect(body).toContain("second run");
    } finally {
      home.cleanup();
    }
  });

  test("an unwritable log directory never fails the caller — a logging failure must not take a studio down", () => {
    const home = logHome();
    try {
      const r = runSnippet({
        shell: "bash",
        env: {
          FLEET_BRINGUP_LOG: "/proc/definitely/not/writable/bringup.log",
          FLEET_BRINGUP_RUN_ID: "20260923T174201Z-1a2b3c4d",
        },
        script: `set -euo pipefail\n${logFuncs()}\nbringup_log "hello"\nbringup_step x\necho SURVIVED\n`,
      });
      expect(r.stdout).toContain("SURVIVED");
      expect(r.code).toBe(0);
    } finally {
      home.cleanup();
    }
  });
});

// --- the redaction contract -------------------------------------------------
// HARD REQUIREMENT, not advice: the log survives the run by design, which is
// exactly what makes a token inside it a real leak. `bringup_redact` must
// cover the SAME shapes src/studio/redact.ts's `redactSecrets` covers — that
// module is the fleet's single definition of "what a secret looks like", and
// the assertion below compares the shell filter's output against it directly
// rather than against a hand-written expectation that could drift.

/** One specimen per shape `redactSecrets` knows, plus surrounding prose. */
const SECRET_SPECIMENS = [
  "git clone https://x-access-token:ghs_AbC123deadbeefZZ@github.com/rafarc21/fleetflare.git failed",
  "remote: Invalid credentials github_pat_11ABCDEFG0aBcDeFgHiJk_lMnOpQrStUvWxYz0123456789",
  "classic token ghp_0123456789abcdefGHIJ and oauth gho_zzzz1111 and user ghu_qqqq2222 and refresh ghr_wwww3333",
  "tailscale up --authkey=tskey-auth-kXyZ12CNTRL-abcdefGHIJ2345 --hostname=acme-os--release-studio",
  "ANTHROPIC error with sk-ant-oat01-AbCd_eF-gHiJkLmNoP0123456789 in the message",
  "spawn auth fsp_0123456789abcdef rejected",
  "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' https://api.github.com",
  // Issue #67: a traced git push echoes its credential header.
  "git -c http.extraHeader='Authorization: Basic eC1hY2Nlc3MtdG9rZW46ZmFrZS10b2tlbg==' push origin HEAD",
].join("\n");

function shellRedact(input: string): string {
  const r = runSnippet({
    shell: "bash",
    stdin: input,
    script: `${extractFunc(BRINGUP, "bringup_redact")}\nbringup_redact\n`,
  });
  expect(r.parentAlive).toBe(true);
  return r.stdout;
}

describe("studio-bringup.sh bringup_redact — the same shapes redactSecrets covers, never fewer (issue #38)", () => {
  test("the shell filter and redactSecrets agree, shape for shape, on every known token", () => {
    expect(shellRedact(SECRET_SPECIMENS).trimEnd()).toBe(redactSecrets(SECRET_SPECIMENS).trimEnd());
  });

  test("no literal token body survives the filter", () => {
    const out = shellRedact(SECRET_SPECIMENS);
    for (const fragment of [
      "ghs_AbC123deadbeefZZ",
      "github_pat_11ABCDEFG0aBcDeFgHiJk",
      "ghp_0123456789abcdefGHIJ",
      "gho_zzzz1111",
      "ghu_qqqq2222",
      "ghr_wwww3333",
      "eC1hY2Nlc3MtdG9rZW46ZmFrZS10b2tlbg==",
      "tskey-auth-kXyZ12CNTRL-abcdefGHIJ2345",
      "sk-ant-oat01-AbCd_eF-gHiJkLmNoP0123456789",
      "fsp_0123456789abcdef",
      "eyJhbGciOiJIUzI1NiJ9.payload.sig",
    ]) {
      expect(out).not.toContain(fragment);
    }
  });

  test("prose around a token survives — redaction replaces the secret, never the diagnosis", () => {
    const out = shellRedact("tailscale up --authkey=tskey-auth-kXyZ12CNTRL-abcdef failed: network unreachable");
    expect(out).toContain("tailscale up --authkey=");
    expect(out).toContain("failed: network unreachable");
    expect(out).not.toContain("kXyZ12CNTRL");
  });

  test("a secret written THROUGH bringup_log never reaches the log file", () => {
    const home = logHome();
    try {
      runWithLog(home, `bringup_log "tailscale up --authkey=tskey-auth-kXyZ12CNTRL-abcdef exited 1"`);
      const body = home.read();
      expect(body).not.toContain("tskey-auth-kXyZ12CNTRL");
      expect(body).toContain("exited 1");
    } finally {
      home.cleanup();
    }
  });
});

// --- stderr capture ---------------------------------------------------------
// Every diagnosis this script already emits goes to stderr ("declared skill X
// resolves to NOTHING", "session restore verification failed", "clone
// failed"). Before this change those lines existed ONLY in the sbExec result
// the Worker throws away on a successful exit — which is precisely the
// hollow-container case. They are now mirrored, redacted, into the log, and
// still handed back to the caller verbatim so nothing Worker-side changes.

describe("studio-bringup.sh bringup_finish — the run's own stderr is mirrored into the log (issue #38 part 1)", () => {
  function runFinish(home: LogHome, body: string, opts: { failWith?: number } = {}) {
    return runSnippet({
      shell: "bash",
      env: { FLEET_BRINGUP_LOG: home.log, FLEET_BRINGUP_RUN_ID: "20260923T174201Z-1a2b3c4d" },
      script:
        `set -euo pipefail\n` +
        `${logFuncs()}\n${extractFunc(BRINGUP, "bringup_finish")}\n` +
        `FLEET_BRINGUP_STDERR_TMP="$(mktemp)"\n` +
        `exec 9>&2\nexec 2>"$FLEET_BRINGUP_STDERR_TMP"\ntrap bringup_finish EXIT\n` +
        `${body}\n` +
        (opts.failWith === undefined ? "" : `exit ${opts.failWith}\n`),
    });
  }

  test("a stderr line emitted by a step is in the log after the run, redacted", () => {
    const home = logHome();
    try {
      const r = runFinish(
        home,
        `bringup_step blueprint-clone\n` +
          `echo "studio-bringup: blueprint clone failed for https://x-access-token:ghs_AbC123deadbeefZZ@github.com/x.git" >&2`,
      );
      const body = home.read();
      expect(body).toContain("studio-bringup: blueprint clone failed");
      expect(body).not.toContain("ghs_AbC123deadbeefZZ");
      // Still reaches the caller verbatim: provision.ts slices bringupRes
      // .stderr into StudioStatus.error and must keep seeing what it saw.
      expect(r.stderr).toContain("studio-bringup: blueprint clone failed");
    } finally {
      home.cleanup();
    }
  });

  test("the run's exit code and the step it died on are the last thing recorded", () => {
    const home = logHome();
    try {
      runFinish(home, `bringup_step branch-fetch`, { failWith: 1 });
      const body = home.read();
      expect(body).toContain("end exit=1 last-step=branch-fetch");
    } finally {
      home.cleanup();
    }
  });

  test("a clean run records exit=0", () => {
    const home = logHome();
    try {
      runFinish(home, `bringup_step shell-window`);
      expect(home.read()).toContain("end exit=0 last-step=shell-window");
    } finally {
      home.cleanup();
    }
  });
});

// --- the script itself ------------------------------------------------------

describe("studio-bringup.sh wiring — the log region is armed before any step runs (issue #38 part 1)", () => {
  test("the log path defaults to /workspace/.fleet/bringup.log, under FLEET_WORKSPACE like working-set.md", () => {
    expect(BRINGUP).toContain('FLEET_BRINGUP_LOG="${FLEET_BRINGUP_LOG:-${FLEET_WORKSPACE:-/workspace}/.fleet/bringup.log}"');
  });

  test("the EXIT trap is installed, so a step that aborts the script still records where it got to", () => {
    expect(BRINGUP).toContain("trap bringup_finish EXIT");
  });

  test("the log region is armed BEFORE the tailscaled step — the first step is already inside the run", () => {
    const armed = BRINGUP.indexOf("trap bringup_finish EXIT");
    const tailscaled = BRINGUP.indexOf("if ! tailscale status >/dev/null 2>&1; then");
    expect(armed).toBeGreaterThan(-1);
    expect(tailscaled).toBeGreaterThan(armed);
  });

  test("every bring-up region is marked, so the log names the step a hollow container stopped at", () => {
    for (const step of [
      "tailscaled",
      "tailscale-up",
      "tailscale-host",
      "tmux-session",
      "session-restore",
      "studio-materialization",
      "claude-launch",
      "transcript-pipe",
    ]) {
      expect(BRINGUP).toContain(`bringup_step ${step}`);
    }
  });

  test("the log is trimmed so appending forever cannot fill the container disk", () => {
    expect(BRINGUP).toContain("FLEET_BRINGUP_LOG_MAX_LINES");
  });

  // The tmux SERVER outlives this script and every pane under it inherits its
  // stderr. If it inherited the run's BUFFERED stderr, bringup_finish would
  // then unlink that file out from under it and the server would write
  // forever into a deleted inode — unreadable, and invisible to `du`. fd 9 is
  // the real stderr, so the server keeps exactly what it had before this
  // feature existed.
  test("the tmux server gets the REAL stderr, never the run's buffered one", () => {
    expect(BRINGUP).toContain("tmux new-session -d -s studio -n claude 2>&9");
    // fd 9 is opened unconditionally, so that redirect can never dangle.
    const fd9 = BRINGUP.indexOf("exec 9>&2");
    const newSession = BRINGUP.indexOf("tmux new-session -d -s studio -n claude 2>&9");
    expect(fd9).toBeGreaterThan(-1);
    expect(newSession).toBeGreaterThan(fd9);
    // Opened OUTSIDE the writable-buffer branch: the `if` that arms buffering
    // must not be what decides whether fd 9 exists.
    expect(BRINGUP).toContain('exec 9>&2\n# Only take stderr over if the buffer is genuinely writable.');
  });

  test("the buffered stderr file is removed at the end of the run, never left behind", () => {
    expect(BRINGUP).toContain('rm -f "$FLEET_BRINGUP_STDERR_TMP"');
  });
});

// --- what an operator actually reads ---------------------------------------

describe("studio-bringup.sh bring-up log — the hollow-container run reads back as a story (issue #38)", () => {
  test("a run that dies mid-way names the last step reached and the ones before it", () => {
    const home = logHome();
    try {
      runSnippet({
        shell: "bash",
        env: { FLEET_BRINGUP_LOG: home.log, FLEET_BRINGUP_RUN_ID: "20260923T174201Z-1a2b3c4d" },
        script:
          `set -euo pipefail\n${logFuncs()}\n${extractFunc(BRINGUP, "bringup_finish")}\n` +
          `FLEET_BRINGUP_STDERR_TMP="$(mktemp)"\nexec 9>&2\nexec 2>"$FLEET_BRINGUP_STDERR_TMP"\n` +
          `trap bringup_finish EXIT\n` +
          `bringup_step tailscaled\nbringup_step tmux-session\nbringup_step studio-materialization\n` +
          `echo "studio-bringup: python3 missing -- refusing to boot" >&2\nexit 1\n`,
      });
      const body = home.read();
      const lines = body.trim().split("\n");
      expect(lines.some((l) => l.includes("step tailscaled"))).toBe(true);
      expect(lines.some((l) => l.includes("step-ok tmux-session exit=0"))).toBe(true);
      expect(lines.some((l) => l.includes("python3 missing"))).toBe(true);
      expect(lines[lines.length - 1]).toContain("end exit=1 last-step=studio-materialization");
    } finally {
      home.cleanup();
    }
  });
});

// Guards the specimen list above against silently going stale: if
// redactSecrets ever learns a new shape, this file must learn a specimen for
// it too, or the shell filter can fall behind without a single test turning
// red.
// Issue #67: the Basic-auth rule, shell and Worker in step beyond the one
// specimen: any case, header-scoped (prose left alone), value gone.
describe("bringup_redact and redactSecrets agree on Authorization: Basic (issue #67)", () => {
  const lines = [
    "> authorization: basic eC1hY2Nlc3M6c2VjcmV0 <",
    "AUTHORIZATION:BASIC dXNlcjpwYXNz",
    "basic auth failed for user x",
  ].join("\n");
  test("same output, and no base64 value survives", () => {
    const out = shellRedact(lines);
    expect(out.trimEnd()).toBe(redactSecrets(lines).trimEnd());
    expect(out).not.toContain("eC1hY2Nlc3M6c2VjcmV0");
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).toContain("basic auth failed for user x");
  });
});

describe("redaction coverage — the specimen list tracks redactSecrets itself", () => {
  test("one specimen per regex declared in src/studio/redact.ts", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/studio/redact.ts"), "utf8");
    const declared = src.match(/^const [A-Z0-9_]+_RE = \//gm) ?? [];
    expect(declared.length).toBe(8);
    // Each specimen line carries exactly one shape; the count must agree.
    expect(SECRET_SPECIMENS.split("\n").length).toBe(declared.length);
  });
});

// --- the Worker's own writes into the same log -----------------------------
// src/studio/provision.ts's runRestart appends its retry decision to the same
// file bring-up writes, so the two runs and the reason between them read as
// one stream. `reason` there is container stdout/stderr echoed back, which
// means it can carry a `;`, a backtick or a quote — and the only lane that
// can PROVE the quoting holds is one with a real shell in it. A source-text
// assertion cannot tell correct escaping from a command a shell would tear
// apart, so this runs the emitted command for real.

describe("bringupLogAppendCmd — the emitted append is safe in a real shell (issue #38 part 3)", () => {
  function runAppend(payload: string, logPath: string) {
    return runSnippet({
      shell: "bash",
      // The real command, with only the absolute container path rewritten to
      // a temp file — everything else (quoting, redirection, `|| true`) is
      // exactly what reaches the container.
      script: `${bringupLogAppendCmd(payload).replace(BRINGUP_LOG_PATH, logPath)}\n`,
    });
  }

  test("a payload carrying quotes and shell metacharacters lands as literal text", () => {
    const home = logHome();
    const payload = "attempt 1 FAILED: boom'; rm -rf /tmp/fleet-canary; echo '";
    try {
      const r = runAppend(payload, home.log);
      expect(r.parentAlive).toBe(true);
      expect(r.code).toBe(0);
      expect(home.read()).toBe(`${payload}\n`);
    } finally {
      home.cleanup();
    }
  });

  test("the metacharacters never execute — the injected command leaves no trace", () => {
    const home = logHome();
    const canary = join(home.dir, "canary");
    writeFileSync(canary, "still here");
    try {
      runAppend(`boom'; rm -f ${canary}; echo '`, home.log);
      expect(readFileSync(canary, "utf8")).toBe("still here");
    } finally {
      home.cleanup();
    }
  });

  test("a backtick in the reason is not a command substitution", () => {
    const home = logHome();
    try {
      runAppend("bring-up failed: `whoami` said no", home.log);
      expect(home.read()).toBe("bring-up failed: `whoami` said no\n");
    } finally {
      home.cleanup();
    }
  });

  test("an unwritable log path is a no-op, never a failed exec", () => {
    const r = runAppend("anything", "/proc/definitely/not/writable/bringup.log");
    expect(r.code).toBe(0);
  });

  test("the tail read is a plain read: no tmux, and it never writes to the log", () => {
    const cmd = bringupLogTailCmd();
    expect(cmd).toContain("tail -n");
    expect(cmd).not.toContain("tmux");
    expect(cmd).not.toContain(">>");
    expect(cmd).not.toMatch(/\bexit\b/);
    // The only redirection it is allowed is discarding its own stderr.
    expect(cmd.match(/>/g)).toEqual([">"]);
  });

  // The two halves name the same file from different sides — the script
  // builds it from ${FLEET_WORKSPACE:-/workspace}, the Worker hardcodes the
  // production path — so agreement is proved by EXPANDING the script's own
  // default with FLEET_WORKSPACE unset, exactly as production runs it.
  test("the Worker and the script agree on WHERE the log lives", () => {
    const defaultLine = BRINGUP.split("\n").find((l) => l.startsWith("FLEET_BRINGUP_LOG="));
    expect(defaultLine).toBeDefined();
    const r = runSnippet({
      shell: "bash",
      script: `unset FLEET_WORKSPACE FLEET_BRINGUP_LOG\n${defaultLine}\nprintf '%s' "$FLEET_BRINGUP_LOG"\n`,
    });
    expect(r.stdout).toBe(BRINGUP_LOG_PATH);
  });
});

// Keeps the fake-HOME helper honest about what it wrote.
describe("test scaffolding", () => {
  test("logHome starts empty", () => {
    const home = logHome();
    try {
      expect(home.read()).toBe("");
      writeFileSync(home.log, "x");
      expect(home.read()).toBe("x");
    } finally {
      home.cleanup();
    }
  });
});
