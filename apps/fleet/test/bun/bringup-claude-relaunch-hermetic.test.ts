import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc, runSnippet } from "./exec-snippet";

/**
 * Issue #67's decision, executed everywhere.
 *
 * The companion suite (bringup-claude-relaunch.test.ts) runs the same
 * functions against a REAL tmux and counts REAL processes off /proc. It is
 * the stronger test and, since #72 (PR #126), it RUNS on Linux CI. It is
 * skipped on macOS (no /proc) and inside a tmux pane ($TMUX set).
 *
 * So THIS suite is the coverage everywhere that one skips — a developer's
 * Mac, a studio lead running tests in its own pane — and the only one that
 * reaches the branches below that a real tmux cannot stage cheaply.
 *
 * `tmux` and `pgrep` here are real executables on PATH
 * driven by a state file, so the extracted bodies call them exactly as they
 * do in the container — a refactor to `command tmux` could not escape it —
 * and every branch of the decision is reachable, including one the real
 * suite cannot stage cheaply: a lead that ignores C-c.
 */
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");

const DECISION = () =>
  [
    extractShellFunc(BRINGUP, "claude_pane_field"),
    extractShellFunc(BRINGUP, "claude_pane_command"),
    extractShellFunc(BRINGUP, "claude_stop"),
    extractShellFunc(BRINGUP, "claude_launch_needed"),
    extractShellFunc(BRINGUP, "claude_process_census"),
  ].join("\n");

/**
 * A container-shaped world: a `tmux` that answers for pane `studio:claude`
 * out of a state file and logs every call, a `pgrep` reporting a chosen
 * count, and a no-op `sleep` so the stop loops cost no real seconds.
 */
function world(opts: { pane: string; cCFrees?: boolean; respawnFrees?: boolean; procs?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-relaunch-hermetic-"));
  const paneFile = join(dir, "pane");
  const logFile = join(dir, "tmux.log");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(paneFile, opts.pane);
  writeFileSync(logFile, "");

  // The real probe asks for `#{session_name}:#{window_name} #{pane_current_command}`
  // and DISCARDS any answer that does not name studio:claude (the hardening
  // that stops a tmux with no such window from answering about another one).
  // The fake answers in exactly that shape, so that guard is under test here
  // rather than bypassed.
  const tmux = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
case "$1" in
  display-message)
    printf 'studio:claude %s\\n' "$(cat ${JSON.stringify(paneFile)})"
    ;;
  send-keys)
    [ "${opts.cCFrees ? 1 : 0}" = 1 ] && printf bash > ${JSON.stringify(paneFile)}
    ;;
  respawn-pane)
    [ "${opts.respawnFrees ? 1 : 0}" = 1 ] && printf bash > ${JSON.stringify(paneFile)}
    ;;
esac
exit 0
`;
  writeFileSync(join(bin, "tmux"), tmux, { mode: 0o755 });
  chmodSync(join(bin, "tmux"), 0o755);
  writeFileSync(join(bin, "pgrep"), `#!/bin/sh\necho ${opts.procs ?? 3}\n`, { mode: 0o755 });
  chmodSync(join(bin, "pgrep"), 0o755);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "sleep"), 0o755);

  return {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    tmuxCalls: () => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean),
    pane: () => readFileSync(paneFile, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Runs the real decision and reports it the way bring-up itself does:
 * `sent` is whether a launch line would have gone into the pane.
 */
function bringup(w: ReturnType<typeof world>, env: Record<string, string> = {}) {
  const r = runSnippet({
    shell: "bash",
    env: { ...w.env, CLAUDE_STOP_TRIES: "2", ...env },
    script:
      "set -euo pipefail\n" +
      `${DECISION()}\n` +
      "claude_process_census\n" +
      "if claude_launch_needed; then echo SENT; else echo NOT_SENT; fi\n",
  });
  expect(r.parentAlive).toBe(true);
  return { sent: r.stdout.includes("SENT") && !r.stdout.includes("NOT_SENT"), out: r.stdout, err: r.stderr };
}

describe("claude_launch_needed, hermetic — a re-provision never adds a second claude (issue #67)", () => {
  test("a live claude is left alone, and the run SAYS it launched nothing", () => {
    const w = world({ pane: "claude" });
    try {
      const r = bringup(w);
      expect(r.sent).toBe(false);
      // On STDERR, deliberately. bringup_finish flushes only stderr into the
      // bring-up log and the Worker reads only `bringupRes.stderr` — a bare
      // `echo` here landed in no log, no row and no Worker tail, while the
      // comment above it claimed it was the fix for exactly that silence.
      expect(r.err).toContain("ALREADY running");
      expect(r.out).not.toContain("ALREADY running");
      // Nothing was stopped and nothing was started, so this path cannot
      // have left two: the pane is untouched.
      expect(w.pane()).toBe("claude");
      expect(w.tmuxCalls().some((c) => c.startsWith("send-keys"))).toBe(false);
      expect(w.tmuxCalls().some((c) => c.startsWith("respawn-pane"))).toBe(false);
    } finally {
      w.cleanup();
    }
  });

  test("a pane at a bare bash launches exactly one", () => {
    const w = world({ pane: "bash" });
    try {
      expect(bringup(w).sent).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  test("a pane owned by some THIRD process launches nothing — a launch on top would leave two", () => {
    const w = world({ pane: "git" });
    try {
      const r = bringup(w);
      expect(r.sent).toBe(false);
      expect(r.err).toContain("git");
      expect(w.pane()).toBe("git");
    } finally {
      w.cleanup();
    }
  });

  test("STUDIO_REPLACE_CLAUDE=1 frees the pane with C-c BEFORE launching, so there are never two", () => {
    const w = world({ pane: "claude", cCFrees: true });
    try {
      const r = bringup(w, { STUDIO_REPLACE_CLAUDE: "1" });
      expect(r.sent).toBe(true);
      expect(w.pane()).toBe("bash");
      expect(w.tmuxCalls()).toContain("send-keys -t studio:claude C-c");
      // C-c was enough, so the process was never killed under it — the
      // session .jsonl `--continue` is about to read got its clean flush.
      expect(w.tmuxCalls().some((c) => c.startsWith("respawn-pane"))).toBe(false);
    } finally {
      w.cleanup();
    }
  });

  test("a lead that ignores C-c is killed with respawn-pane -k, then launched", () => {
    const w = world({ pane: "claude", cCFrees: false, respawnFrees: true });
    try {
      const r = bringup(w, { STUDIO_REPLACE_CLAUDE: "1" });
      expect(r.sent).toBe(true);
      expect(w.pane()).toBe("bash");
      expect(w.tmuxCalls()).toContain("send-keys -t studio:claude C-c");
      expect(w.tmuxCalls()).toContain("respawn-pane -k -t studio:claude");
    } finally {
      w.cleanup();
    }
  });

  test("a pane nothing can free launches NOTHING rather than leaving two", () => {
    const w = world({ pane: "claude", cCFrees: false, respawnFrees: false });
    try {
      const r = bringup(w, { STUDIO_REPLACE_CLAUDE: "1" });
      expect(r.sent).toBe(false);
      expect(r.err).toContain("did not come back to a bare bash");
      expect(w.pane()).toBe("claude");
    } finally {
      w.cleanup();
    }
  });
});

describe("claude_process_census — the number that reached 62 (issue #67)", () => {
  test("it is always reported, so a provision leaves a record of what it walked into", () => {
    const w = world({ pane: "bash", procs: 3 });
    try {
      const r = bringup(w);
      expect(r.out).toContain("processes matching 'claude' on this container: 3");
      expect(r.err).not.toContain("WARNING");
    } finally {
      w.cleanup();
    }
  });

  test("past the threshold it warns loudly, and names the recycle that actually clears them", () => {
    const w = world({ pane: "claude", procs: 62 });
    try {
      const r = bringup(w);
      expect(r.err).toContain("WARNING 62 processes");
      expect(r.err).toContain("recycle");
    } finally {
      w.cleanup();
    }
  });
});
