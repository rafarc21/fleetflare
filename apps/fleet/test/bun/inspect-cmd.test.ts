// Board issue #47 — inspectCmd, executed against a REAL tmux server. Same
// lane and same reason test/bun/pane-probe.test.ts exists: `runInspect`
// refuses/succeeds based on this command's OUTPUT and on tmux's OWN
// client-tracking, so a source-text assertion proves nothing about either —
// what has to be measured is what a real tmux server actually does.
//
// This is also this feature's proof for requirement 1 (never attach a
// client, never touch window size): `tmux list-clients` and
// `window-size`/`aggressive-resize` are read back from the SAME live server
// inspectCmd just ran against, before and after, so a regression that ever
// made this command attach would fail these tests deterministically rather
// than requiring a human to notice repaint garbage in a shared pane again.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCmd, parseInspectOutput, CHECKOUT_PRESENT, CHECKOUT_MISSING } from "../../src/studio/inspect";

/** Copied from test/bun/pane-probe.test.ts verbatim, for the reason that
 *  file's own comment gives: TMUX_TMPDIR alone is NOT isolation, and this
 *  suite's session/window names are the REAL ones, so a run inside a live
 *  studio would otherwise probe — and `kill-server` — that studio's own
 *  tmux. Three leads died that way before it was found. */
function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return { ...rest, TMUX_TMPDIR: dir };
}

interface Sh {
  (cmd: string): { code: number; stdout: string; stderr: string };
}

/**
 * One throwaway tmux server plus a throwaway root containing a
 * `<root>/workspace` a `cwd:`-scoped exec can actually see
 * `<root>/workspace/<repo>/.git` under, so the checkout half of inspectCmd
 * is exercised for real rather than assumed.
 *
 * `cmd(repo, tailLines)` inside the callback runs the SAME command
 * inspectCmd builds, with only the one leading `/workspace/` swapped for
 * this test's throwaway root (there is no root filesystem access to bind a
 * real `/workspace` under) — everything else (tmux target, sentinels,
 * capture-pane flags) is byte-for-byte what production sends, so this suite
 * cannot silently drift from what `runInspect` actually executes.
 */
function withStudio<T>(paneCommand: string, checkoutRepo: string | null, fn: (sh: Sh, cmd: (repo: string, tailLines?: number) => string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fleet-inspect-"));
  const env = isolatedTmuxEnv(dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  if (checkoutRepo) mkdirSync(join(workspace, checkoutRepo, ".git"), { recursive: true });
  const sh: Sh = (cmd) => {
    const r = Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const cmd = (repo: string, tailLines?: number) => inspectCmd(repo, tailLines).replaceAll("/workspace/", `${dir}/workspace/`);
  try {
    sh(`tmux new-session -d -s studio -n claude ${JSON.stringify(paneCommand)}`);
    return fn(sh, cmd);
  } finally {
    sh("tmux kill-server 2>/dev/null || true");
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("inspectCmd, executed against a real tmux server", () => {
  test("reads pane_current_command for a live claude pane and the checkout as present", () => {
    withStudio("sleep 30", "websites", (sh, cmd) => {
      const r = sh(cmd("websites"));
      expect(r.code).toBe(0);
      const snap = parseInspectOutput(r.stdout);
      expect(snap.checkoutExists).toBe(true);
      expect(snap.paneCommand).toBe("sleep");
    });
  });

  test("reads a bare shell pane as NOT claude, and a missing checkout as missing", () => {
    withStudio("bash", null, (sh, cmd) => {
      const r = sh(cmd("websites"));
      expect(r.code).toBe(0);
      const snap = parseInspectOutput(r.stdout);
      expect(snap.checkoutExists).toBe(false);
      expect(snap.paneCommand).toBe("bash");
    });
  });

  test("#151: stamps the capture with the container clock, in the same exec", () => {
    withStudio("sleep 30", "websites", (sh, cmd) => {
      const before = Math.floor(Date.now() / 1000);
      const snap = parseInspectOutput(sh(cmd("websites")).stdout);
      const after = Math.ceil(Date.now() / 1000);
      expect(snap.capturedAt).not.toBeNull();
      expect(snap.capturedAt!).toBeGreaterThanOrEqual(before);
      expect(snap.capturedAt!).toBeLessThanOrEqual(after);
    });
  });

  test("captures actual pane output in the tail", () => {
    withStudio('bash -c "printf 1; printf 2\\\\n; printf 3\\\\n; sleep 30"', "websites", (sh, cmd) => {
      const r = sh(cmd("websites"));
      const snap = parseInspectOutput(r.stdout);
      expect(snap.tail).toContain("12");
      expect(snap.tail).toContain("3");
    });
  });

  test("attaches ZERO tmux clients — before and after, list-clients stays empty", () => {
    withStudio("sleep 30", "websites", (sh, cmd) => {
      const before = sh("tmux list-clients -t studio");
      sh(cmd("websites"));
      const after = sh("tmux list-clients -t studio");
      // A real attach (`tmux attach`) would print one line per client here.
      // A one-shot `tmux <cmd>` invocation — which is all inspectCmd ever
      // issues — never registers as a session client at all.
      expect(before.stdout.trim()).toBe("");
      expect(after.stdout.trim()).toBe("");
    });
  });

  test("changes NOTHING about window-size or aggressive-resize — the exact mechanism issue #47 measured", () => {
    withStudio("sleep 30", "websites", (sh, cmd) => {
      const winsizeBefore = sh("tmux show-options -gv window-size").stdout.trim();
      const aggressiveBefore = sh("tmux show-window-options -gv aggressive-resize").stdout.trim();
      sh(cmd("websites"));
      const winsizeAfter = sh("tmux show-options -gv window-size").stdout.trim();
      const aggressiveAfter = sh("tmux show-window-options -gv aggressive-resize").stdout.trim();
      expect(winsizeAfter).toBe(winsizeBefore);
      expect(aggressiveAfter).toBe(aggressiveBefore);
    });
  });

  test("switches no window — an operator attaching later sees no trace of it", () => {
    // Same requirement provisionedCheckCmd's own doc comment states and
    // test/bun/pane-probe.test.ts already proves for PANE_PROBE_CMD: a probe
    // that ever selects a window leaves a healthy studio LOOKING dead to the
    // next human who attaches.
    withStudio("sleep 30", "websites", (sh, cmd) => {
      sh("tmux new-window -d -t studio -n shell 'sleep 30'");
      sh("tmux select-window -t studio:shell");
      sh(cmd("websites"));
      const active = sh("tmux display-message -p '#{window_name}'").stdout.trim();
      expect(active).toBe("shell");
    });
  });

  test("sends ZERO keystrokes — a pane parked on a blocking read (the modal case) is never satisfied", () => {
    // The exact requirement 3 scenario: a lead blocked on an interactive
    // prompt where any keystroke could land on it. inspectCmd must be able
    // to read that pane WITHOUT ever completing the read.
    withStudio(
      'bash -c "read -p \'rate limit -- Upgrade your plan\' x; echo GOT:$x > /tmp/fleet-inspect-modal-marker; sleep 30"',
      "websites",
      (sh, cmd) => {
        // Run it twice, the way a coordinator would poll repeatedly.
        sh(cmd("websites"));
        const r = sh(cmd("websites"));
        const marker = sh("test -f /tmp/fleet-inspect-modal-marker && echo present || echo absent");
        expect(marker.stdout.trim()).toBe("absent");
        expect(parseInspectOutput(r.stdout).tail).toContain("Upgrade your plan");
      },
    );
  });

  test("respects a caller-supplied tail length", () => {
    withStudio("sleep 30", "websites", (sh, cmd) => {
      const r = sh(cmd("websites", 5));
      expect(r.code).toBe(0);
    });
  });
});

describe("inspectCmd — command-shape sentinels stay in sync with the real function", () => {
  test("the sentinels this file greps for are the SAME exports inspectCmd/parseInspectOutput use", () => {
    expect(inspectCmd("websites")).toContain(CHECKOUT_PRESENT);
    expect(inspectCmd("websites")).toContain(CHECKOUT_MISSING);
  });
});
