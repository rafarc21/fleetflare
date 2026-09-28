// container/studio-bringup.sh — the tmux rendering options, EXECUTED.
//
// Issue #43. Every earlier attempt at these four settings asserted that a
// line exists in the script, and every earlier attempt was wrong about what
// the running session actually had: `history-limit 50000` sat in the script
// since 2026-08 while `acme-os--release-studio` ran at tmux's default 2000,
// measured 2026-09-23. A source-text assertion cannot tell a setting that
// took from one that did not.
//
// So this suite runs the REAL region out of the REAL script against a REAL
// tmux server in a throwaway TMUX_TMPDIR + throwaway HOME, and asserts only
// on values READ BACK from the session it created. Same lane and same
// isolation discipline as test/bun/wake-cmd.test.ts.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");

/**
 * Pull a marked region out of shell source, verbatim.
 *
 * The companion to exec-snippet.ts's extractHeredoc, for a stretch of script
 * that studio-bringup.sh RUNS rather than emits. The bring-up brackets the
 * tmux rendering block with `# >>> <marker> >>>` / `# <<< <marker> <<<` for
 * exactly this: what runs below is the shipped bytes, not a re-typed copy.
 */
function extractRegion(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`region opener ${open} not found in source`);
  const closeAt = src.indexOf(close, openAt);
  if (closeAt === -1) throw new Error(`region terminator ${close} not found in source`);
  return src.slice(src.indexOf("\n", openAt) + 1, closeAt);
}

const REGION = extractRegion(BRINGUP, "tmux-render-options");

/**
 * An env whose tmux can ONLY reach the throwaway server under `dir`, and
 * whose HOME is throwaway too (the region writes a tmux.conf into it).
 *
 * `TMUX_TMPDIR` alone is not isolation: when `TMUX` is set — i.e. this suite
 * runs INSIDE a studio, which is exactly where it will run — tmux targets the
 * server named in `$TMUX` and ignores TMUX_TMPDIR. The session name here is
 * the real one (`studio`), so without stripping TMUX/TMUX_PANE this file
 * would read and rewrite the live lead's own session. Same measured failure
 * wake-cmd.test.ts documents (three studio leads died that way over two days).
 */
function isolated(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return { ...rest, HOME: home, TMUX_TMPDIR: dir };
}

interface Sh {
  (cmd: string): { code: number; stdout: string; stderr: string };
}

function shell(env: Record<string, string | undefined>): Sh {
  return (cmd) => {
    const r = Bun.spawnSync({
      cmd: ["bash", "-c", cmd], env, stdout: "pipe", stderr: "pipe", timeout: 20000,
    });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
  };
}

/** Global option, read back from the live server. */
function globalOption(sh: Sh, name: string): string {
  return sh(`tmux show-options -gv ${name}`).stdout;
}

/** Global WINDOW option, read back from the live server. `aggressive-resize`
 *  is a window option, so `show-options -g` alone is the wrong table. */
function globalWindowOption(sh: Sh, name: string): string {
  return sh(`tmux show-window-options -gv ${name}`).stdout;
}

/**
 * The `studio:claude` pane's OWN history limit, and never anything else's.
 *
 * FLEET-WIDE PROBE DEFECT, found by the #41 work on tmux 3.2a:
 * `tmux display-message -p -t studio:claude '#{...}'` run on a server where
 * that window does NOT exist silently answers about the CURRENT pane and
 * exits 0. It cannot fail; it lies. So the format carries
 * `#{session_name}:#{window_name}` and any answer that is not about
 * `studio:claude` is refused here rather than believed.
 */
function paneHistoryLimit(sh: Sh): number {
  const r = sh(`tmux display-message -p -t studio:claude '#{session_name}:#{window_name} #{history_limit}'`);
  const m = /^studio:claude (\d+)$/.exec(r.stdout);
  if (m === null) {
    throw new Error(`probe did not answer about studio:claude: ${JSON.stringify(r.stdout)} (stderr: ${r.stderr})`);
  }
  return Number(m[1]);
}

/** The shipped region, run exactly as studio-bringup.sh runs it — under the
 *  same `set -euo pipefail` the script declares at its top, so a region that
 *  only survives a lax shell fails here. */
function runRegion(sh: Sh): { code: number; stdout: string; stderr: string } {
  return sh(`set -euo pipefail\n${REGION}`);
}

function withTmux(body: (sh: Sh) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fleet-tmux-render-"));
  const sh = shell(isolated(dir));
  try {
    body(sh);
  } finally {
    sh("tmux kill-server 2>/dev/null || true");
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("studio-bringup tmux rendering options, executed against a real tmux", () => {
  test("a studio BORN under the region reads back mouse off, window-size largest, aggressive-resize off and a 50000-line pane history", () => {
    withTmux((sh) => {
      const run = runRegion(sh);
      expect(run.code).toBe(0);

      // Every assertion below is a READ of the session the region just
      // created — never a read of the script that created it.
      expect(globalOption(sh, "mouse")).toBe("off");
      expect(globalOption(sh, "window-size")).toBe("largest");
      expect(globalWindowOption(sh, "aggressive-resize")).toBe("off");
      // The one that was measured NOT taking: the pane's own allocated
      // history, not the global option the pane may or may not have inherited.
      expect(paneHistoryLimit(sh)).toBe(50000);
    });
  });

  test("the region reports the four settings it actually read back, so a bring-up log can be audited", () => {
    withTmux((sh) => {
      const run = runRegion(sh);
      expect(run.code).toBe(0);
      const out = `${run.stdout}\n${run.stderr}`;
      expect(out).toContain("mouse=off");
      expect(out).toContain("window-size=largest");
      expect(out).toContain("aggressive-resize=off");
      expect(out).toContain("history_limit=50000");
    });
  });

  test("an ALREADY-RUNNING studio at the old settings is corrected live for mouse, window-size and aggressive-resize", () => {
    withTmux((sh) => {
      // The shape of every existing container: a server created before this
      // change landed, carrying exactly what the old region set.
      sh("tmux new-session -d -s studio -n claude");
      sh("tmux set -g mouse on");
      sh("tmux set -g window-size latest");
      sh("tmux setw -g aggressive-resize on");
      expect(globalOption(sh, "mouse")).toBe("on");

      const run = runRegion(sh);
      expect(run.code).toBe(0);

      expect(globalOption(sh, "mouse")).toBe("off");
      expect(globalOption(sh, "window-size")).toBe("largest");
      expect(globalWindowOption(sh, "aggressive-resize")).toBe("off");
    });
  });

  test("an already-allocated pane keeps its 2000-line history, and the region SAYS SO instead of claiming 50000", () => {
    withTmux((sh) => {
      sh("tmux new-session -d -s studio -n claude");
      expect(paneHistoryLimit(sh)).toBe(2000);

      const run = runRegion(sh);
      expect(run.code).toBe(0);

      // tmux allocates a pane's history AT PANE CREATION; no option write
      // grows it afterwards. Measured 2026-09-23 as the reason
      // `acme-os--release-studio` ran at 2000 with the 50000 line present in
      // the script. Pinned here so nobody "fixes" it by asserting 50000.
      expect(paneHistoryLimit(sh)).toBe(2000);
      const out = `${run.stdout}\n${run.stderr}`;
      expect(out).toContain("history_limit=2000");
      expect(out).toMatch(/recycle/);
    });
  });

  test("running the region twice changes nothing — bring-up runs on every provision", () => {
    withTmux((sh) => {
      expect(runRegion(sh).code).toBe(0);
      const firstPane = sh("tmux display-message -p -t studio:claude '#{pane_id}'").stdout;
      expect(runRegion(sh).code).toBe(0);
      // A second session/pane would mean bring-up doubles the studio.
      expect(sh("tmux list-sessions -F '#{session_name}'").stdout).toBe("studio");
      expect(sh("tmux display-message -p -t studio:claude '#{pane_id}'").stdout).toBe(firstPane);
      expect(globalOption(sh, "mouse")).toBe("off");
      expect(paneHistoryLimit(sh)).toBe(50000);
    });
  });

  test("the pane probe refuses an answer about the wrong window instead of believing it", () => {
    withTmux((sh) => {
      // A live server whose `claude` window does not exist — the shape that
      // makes tmux 3.2a answer about the CURRENT pane with exit 0.
      sh("tmux new-session -d -s studio -n shell 'sleep 30'");
      expect(() => paneHistoryLimit(sh)).toThrow(/did not answer about studio:claude/);
    });
  });
});

// --- the fd the tmux SERVER walks away with ---------------------------------
//
// The region hands the tmux server an explicit `2>&9` so the server cannot end
// up writing forever into the run's buffered stderr file, which bringup_finish
// unlinks on exit (issue #38). That redirect is correct and stays. What is NOT
// correct is fd 9 itself being left OPEN across the exec: a bash redirection
// only sets the child's fd 2, it does not take fd 9 away, so the daemon the
// client forks keeps a private write handle on whatever fd 9 points at, for
// the entire life of the container.
//
// Measured 2026-09-23, this branch, tmux 3.2a: with the region run standalone
// under a pipe (exactly how the suite above runs it, and exactly how CI runs
// the suite), `/proc/<server>/fd` reads
//     0 -> /dev/null   1 -> /dev/null   2 -> /dev/null
//     3,4 -> pipe (tmux's own)   5 -> /dev/ptmx   6 -> socket
//     9 -> pipe:[6961]        <-- the harness's stderr pipe, held forever
// The reader on the other end never sees EOF, so the caller blocks: rc=124 at
// 10006ms, with the region's own "region done" already printed. A HANG, never
// a slowdown. The same listing also shows why `2>&9` alone was never the whole
// guard: tmux daemonises onto /dev/null for 0/1/2, so fd 9 is the ONLY handle
// the server keeps, whichever file or pipe it happens to name.
//
// Both tests below run the shipped region and read the RESULT, in the spirit
// of the suite above: no assertion here is about the text of the script.
describe("studio-bringup tmux server fd inheritance, executed against a real tmux", () => {
  /** Write the shipped region into `dir` wrapped in `pre`, and answer the path. */
  function regionScript(dir: string, pre: string): string {
    const path = join(dir, "region.sh");
    // `exec 9>&-` first, ALWAYS: whoever runs this suite may already hold an
    // open fd 9 (a studio's own panes inherit one from the bring-up that
    // started their tmux server), and that would silently skip the region's
    // fallback and hide the whole defect. CI has no fd 9; this makes a
    // developer's shell behave like CI instead of disagreeing with it.
    writeFileSync(path, `exec 9>&-\nset -euo pipefail\n${pre}${REGION}\n`);
    return path;
  }

  test("a caller reading the region's output through a pipe reaches EOF instead of blocking on the server", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-tmux-fd-eof-"));
    const env = isolated(dir);
    try {
      const script = regionScript(dir, "");
      const out = join(dir, "region.out");
      const started = Date.now();
      // The CI shape, reduced to its essentials: the region's stdout+stderr go
      // into a PIPE, and something on the far end reads that pipe to EOF. The
      // pipeline's status is `cat`'s, so exit 0 means — and can only mean —
      // that every writer on that pipe was gone once the region's shell was.
      // `exec 2>/dev/null` keeps `cat` off this spawn's own stderr pipe, so a
      // hang inside shows up as a timeout here and not as a wedged reader.
      const r = Bun.spawnSync({
        cmd: ["bash", "-c", `exec 2>/dev/null; bash ${script} 2>&1 | cat > ${out}`],
        env, stdout: "pipe", stderr: "pipe", timeout: 15000,
      });
      const elapsedMs = Date.now() - started;
      // exitCode null = killed at the timeout = the pipe never reached EOF.
      expect({ code: r.exitCode, region: readFileSync(out, "utf8").includes("studio-bringup: tmux mouse=off") })
        .toEqual({ code: 0, region: true });
      expect(elapsedMs).toBeLessThan(15000);
    } finally {
      shell(env)("tmux kill-server 2>/dev/null || true");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the server the region starts holds no fd 9 and no handle on the run's unlinked stderr buffer", () => {
    // /proc is how a live fd table is read; there is no portable substitute,
    // and every place this script ships to is Linux (Dockerfile.studio) as is
    // the lane that runs this suite.
    if (!existsSync("/proc/self/fd")) return;

    const dir = mkdtempSync(join(tmpdir(), "fleet-tmux-fd-proc-"));
    const env = isolated(dir);
    const sh = shell(env);
    try {
      const realStderr = join(dir, "real-stderr");
      const buffered = join(dir, "buffered-stderr");
      // The FULL script's shape, which the suite above never exercises: fd 9
      // already open on the real stderr, fd 2 taken over by the run's buffered
      // stderr file. A real file rather than this spawn's pipe on purpose —
      // the point here is which fds survive, not whether the caller blocks,
      // and the previous test already owns the blocking question.
      const script = regionScript(dir, `exec 9>"${realStderr}"\nexec 2>"${buffered}"\n`);
      expect(sh(`bash ${script}`).code).toBe(0);

      // bringup_finish's unlink, reproduced. From here on, anything still
      // holding this path is writing into a deleted inode.
      rmSync(buffered, { force: true });

      const serverPid = sh("tmux display-message -p '#{pid}'").stdout;
      expect(serverPid).toMatch(/^\d+$/);
      const fds = sh(`ls -l /proc/${serverPid}/fd`).stdout;

      // Hazard 1, the inherited handle (this branch's CI failure): fd 9 is
      // gone from the server entirely, so nothing the region opened outlives
      // the region.
      expect(fds).not.toMatch(/ 9 -> /);
      // Hazard 2, the deleted inode (issue #38): no fd of the server's names
      // the buffered stderr file, unlinked or otherwise.
      expect(fds).not.toContain(buffered);
      // And the server is genuinely up — an empty/garbage listing must not be
      // allowed to satisfy the two refusals above.
      expect(fds).toMatch(/ 0 -> /);
    } finally {
      sh("tmux kill-server 2>/dev/null || true");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
