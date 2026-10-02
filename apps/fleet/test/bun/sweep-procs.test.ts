import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #159 — a direct, fast correctness test for `sweep_procs` itself
 * (not routed through the whole `localci.sh --lanes` machinery that
 * localci-run.test.ts already covers, and which is what's slow/flaky under
 * a process-dense host). Calls the real function, in the real script, via
 * the `--sweep-procs-only` test hook (localci.sh), against a handful of
 * real short-lived decoys — one per match criterion (cmdline, cwd, env),
 * plus one unrelated decoy that must survive. This is a safety net for the
 * #159 refactor of the Linux branch's per-process forking, not a test of
 * the refactor's performance (that's measured separately, in the plan doc).
 */
const SCRIPT = resolve(import.meta.dir, "../../scripts/localci/localci.sh");
// Mostly a margin over the up-to-5s "wait for a kill to land" loop below,
// not an expectation that this is ever slow — unlike localci-run.test.ts,
// this test never walks the full /proc (that's the whole point of #159).
setDefaultTimeout(15_000);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-procs-"));
  mkdirSync(join(root, "worktree", "cwd-decoy"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * True while pid is a live, non-zombie process. A killed child reparented
 * to pid 1 can sit as a zombie until reaped; kill(pid, 0) still succeeds on
 * a zombie, yet it runs nothing and holds nothing (same helper shape as
 * localci-run.test.ts's own `running`).
 */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  let state = "";
  try {
    state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] ?? "";
  } catch {
    state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim()[0] ?? "";
  }
  return state !== "Z";
}

test("sweep_procs kills cmdline/cwd/env matches, spares an unrelated process", async () => {
  const worktree = join(root, "worktree");
  const rid = `rid-${Date.now()}`;

  // (1) cmdline match: argv contains a path under the worktree.
  const cmdlineDecoy = Bun.spawn(
    ["bash", "-c", "while :; do sleep 1; done", `${worktree}/arg-marker`],
    { stdout: "ignore", stderr: "ignore" },
  );
  // (2) cwd match: the process's cwd is under the worktree.
  const cwdDecoy = Bun.spawn(["sleep", "100"], {
    cwd: join(worktree, "cwd-decoy"),
    stdout: "ignore",
    stderr: "ignore",
  });
  // (3) env match: LOCALCI_RUN=<rid> set on the process.
  const envDecoy = Bun.spawn(["sleep", "100"], {
    env: { ...process.env, LOCALCI_RUN: rid },
    stdout: "ignore",
    stderr: "ignore",
  });
  // Unrelated: none of the three criteria. Different cwd, no matching env,
  // cmdline names none of the worktree's path.
  const unrelated = Bun.spawn(["sleep", "100"], {
    cwd: tmpdir(),
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    // Give each decoy a moment to actually start (argv/cwd/environ readable).
    await Bun.sleep(200);

    const r = Bun.spawnSync(["bash", SCRIPT, "--sweep-procs-only", worktree, rid], {
      env: process.env,
    });
    expect(r.exitCode).toBe(0);

    const deadline = Date.now() + 5_000;
    const dead = (pid: number) => {
      while (running(pid) && Date.now() < deadline) Bun.sleepSync(100);
      return !running(pid);
    };

    expect(dead(cmdlineDecoy.pid)).toBe(true);
    expect(dead(cwdDecoy.pid)).toBe(true);
    expect(dead(envDecoy.pid)).toBe(true);
    expect(running(unrelated.pid)).toBe(true);
  } finally {
    for (const p of [cmdlineDecoy, cwdDecoy, envDecoy, unrelated]) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    }
  }
});

// #159 review (fresh-context code review, empirically reproduced): the cwd
// match must be boundary-anchored on the worktree path itself, not a bare
// substring test. localci.sh's own RID ends in a raw, unpadded `$$`, so two
// runs close together can produce e.g. `wt-...-1` and `wt-...-12` — the
// first a literal character-prefix of the second — and both can exist on
// disk before the gate lock serializes the lanes. A sibling worktree whose
// name merely EXTENDS the target's, with no `/` in between, must never match.
test("sweep_procs: a sibling worktree whose path is a literal character-prefix extension is never matched by cwd", async () => {
  const wt1 = join(root, "wt-1");
  const wt12 = join(root, "wt-12");
  mkdirSync(wt1, { recursive: true });
  mkdirSync(wt12, { recursive: true });
  const rid = `rid-${Date.now()}`;

  // Lives in the sibling worktree wt-12, which is NOT what the sweep targets
  // (wt-1) — must survive. wt-12's path literally starts with wt-1's path.
  const sibling = Bun.spawn(["sleep", "100"], { cwd: wt12, stdout: "ignore", stderr: "ignore" });
  // A genuine cwd match (exactly wt-1) — must still die, proving the fix
  // didn't just make cwd matching stop working altogether.
  const exact = Bun.spawn(["sleep", "100"], { cwd: wt1, stdout: "ignore", stderr: "ignore" });

  try {
    await Bun.sleep(200);

    const r = Bun.spawnSync(["bash", SCRIPT, "--sweep-procs-only", wt1, rid], { env: process.env });
    expect(r.exitCode).toBe(0);

    const deadline = Date.now() + 5_000;
    while (running(exact.pid) && Date.now() < deadline) Bun.sleepSync(100);
    expect(running(exact.pid)).toBe(false);
    expect(running(sibling.pid)).toBe(true);
  } finally {
    for (const p of [sibling, exact]) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    }
  }
});
