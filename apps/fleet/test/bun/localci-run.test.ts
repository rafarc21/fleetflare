import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #267 — localci.sh end to end, against a throwaway origin and PATH
 * stubs for gh, docker and the lane half of bun (summarize.ts still runs on
 * the real bun). What is pinned: the tested tree is PR head merged onto
 * main, both contexts go pending then final, a conflict / skipped gate still
 * posts a status, a status POST that fails is retried once and then fails
 * the run loudly, and nothing (worktree, refs/localci/*) outlives the run.
 */
// Each test runs the whole script: git clone/fetch/merge-tree/worktree plus
// a dozen stub processes. ~150 ms in the Linux lane, but measured 6-12 s on
// the Mac at load average 200 (2026-09-25) — past bun's 5 s default.
setDefaultTimeout(60_000);

const SCRIPT = resolve(import.meta.dir, "../../scripts/localci/localci.sh");
const REAL_BUN = process.execPath;

let root: string;
let repo: string;
let calls: string;

function sh(cmd: string, cwd = repo) {
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: { ...process.env, TMUX: "" } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function stub(name: string, body: string) {
  const f = join(root, "bin", name);
  writeFileSync(f, `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(f, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "localci-"));
  repo = join(root, "repo");
  calls = join(root, "calls.log");
  writeFileSync(calls, "");
  mkdirSync(join(root, "bin"));
  sh(`git init -q --bare -b main ${root}/origin.git`, root);
  sh(`git clone -q ${root}/origin.git repo 2>/dev/null`, root);
  sh(`git config user.email t@t && git config user.name t && mkdir -p apps/fleet docs \
      && echo base > apps/fleet/a.txt && echo doc > docs/d.md && git add -A && git commit -qm base \
      && git push -q origin HEAD:main`);

  // gh: the only call is the status POST. STUB_GH_FAILS=n fails the first n.
  stub(
    "gh",
    `n=$(cat "${root}/gh.count" 2>/dev/null || echo 0); echo $((n+1)) > "${root}/gh.count"
     if [ "$n" -lt "\${STUB_GH_FAILS:-0}" ]; then echo "HTTP 502" >&2; exit 1; fi`,
  );
  // docker: info/image inspect succeed; run prints the canned Linux-lane log.
  stub(
    "docker",
    `case "$1" in
       run) if [ "\${STUB_LINUX_HANG:-}" = stubborn ]; then trap '' TERM; echo $$ > "${root}/hang.pid"; while :; do sleep 1; done; fi
            if [ -n "\${STUB_LINUX_HANG:-}" ]; then echo $$ > "${root}/hang.pid"; sleep 61; exit 0; fi
            if [ -n "\${STUB_LINUX_KILLED:-}" ]; then kill -9 $$; fi
            if [[ "$*" == *"bun test test/"* ]]; then cat "${root}/linux-rerun.out"; exit $(cat "${root}/linux-rerun.code"); fi
            cat "${root}/linux.out"; exit $(cat "${root}/linux.code") ;;
       *) exit 0 ;;
     esac`,
  );
  // bun: lane commands are canned; anything else (summarize.ts) is the real bun.
  stub(
    "bun",
    `case "$*" in
       install|"run check") exit 0 ;;
       "run test"*) for a in "$@"; do case "$a" in --outputFile=*) f="\${a#--outputFile=}";; esac; done
                    echo '{"numPassedTests":5,"numFailedTests":0,"numPendingTests":0,"testResults":[]}' > "$f"; exit 0 ;;
       *english-check.ts) exit 0 ;;
       # --native (#279): the Linux lane runs bun directly, no docker.
       "run bun-test") echo "env TMUX=\${TMUX-unset} TMUX_PANE=\${TMUX_PANE-unset}" >> "${calls}"
                       if [ -n "\${STUB_LEAK:-}" ]; then
                         # (a) daemonized, env inherited; (b) daemonized, env scrubbed, script under the worktree
                         perl -e 'use POSIX; setsid(); exec @ARGV' sleep 302 >/dev/null 2>&1 & echo $! > "${root}/leak-env.pid"
                         printf 'while :; do sleep 1; done\n' > "$PWD/leak.sh"
                         env -i perl -e 'use POSIX; setsid(); exec @ARGV' /bin/bash "$PWD/leak.sh" >/dev/null 2>&1 & echo $! > "${root}/leak-path.pid"
                       fi
                       cat "${root}/linux.out"; exit $(cat "${root}/linux.code") ;;
       "test test/"*) cat "${root}/linux-rerun.out"; exit $(cat "${root}/linux-rerun.code") ;;
       *) exec "${REAL_BUN}" "$@" ;;
     esac`,
  );
  writeFileSync(join(root, "linux.out"), " 7 pass\n 0 fail\nRan 7 tests across 1 files.\n");
  // --native needs a Linux host and tmux; both stubbed so the lane runs on a Mac too.
  stub("uname", `echo "\${STUB_UNAME:-Linux}"`);
  stub("tmux", `echo "tmux 3.4"`);
  stub("node", `exit 0`);
  stub("chromium", `echo "Chromium 140"`);
  writeFileSync(join(root, "linux.code"), "0");
});

afterEach(() => {
  // Never let a RED run of the leak test leak for real.
  for (const f of ["leak-env.pid", "leak-path.pid"]) {
    try {
      process.kill(Number(readFileSync(join(root, f), "utf8")), "SIGKILL");
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

function openPr(n: number, path: string, content: string) {
  sh(`git checkout -q -b pr${n} main && mkdir -p $(dirname ${path}) && echo ${content} > ${path} \
      && git add -A && git commit -qm pr${n} && git push -q origin HEAD:refs/pull/${n}/head && git checkout -q main`);
  return sh(`git rev-parse pr${n}`);
}

function runEnv(env: Record<string, string>) {
  return {
    ...process.env,
    TMUX: "",
    PATH: `${root}/bin:${process.env.PATH}`,
    LOCALCI_REPO_DIR: repo,
    LOCALCI_GH_REPO: "o/r",
    LOCALCI_LOGS: join(root, "logs"),
    LOCALCI_WORK: join(root, "work"),
    LOCALCI_LOCK: join(root, "gate.lock"),
    LOCALCI_RETRY_SLEEP: "0",
    LOCALCI_CHROMIUM: join(root, "bin", "chromium"),
    IS_SANDBOX: "",
    ...env,
  };
}

function run(target: string, extra: string[] = [], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bash", SCRIPT, target, ...extra], {
    cwd: repo,
    env: {
      ...process.env,
      TMUX: "",
      PATH: `${root}/bin:${process.env.PATH}`,
      LOCALCI_REPO_DIR: repo,
      LOCALCI_GH_REPO: "o/r",
      LOCALCI_LOGS: join(root, "logs"),
      LOCALCI_WORK: join(root, "work"),
      LOCALCI_LOCK: join(root, "gate.lock"),
      LOCALCI_RETRY_SLEEP: "0",
    LOCALCI_CHROMIUM: join(root, "bin", "chromium"),
    IS_SANDBOX: "",
      ...env,
    },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/**
 * True while pid is a live, non-zombie process. In the Linux lane a killed
 * stub is reparented to the container's PID 1 and can sit as a zombie until
 * reaped (measured 2026-09-25, full bun-test lane): kill(pid, 0) still
 * succeeds on a zombie, yet it runs nothing and holds nothing.
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

/** The status POSTs in order, as "context=state". */
function posts(): string[] {
  return readFileSync(calls, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("gh api"))
    .map((l) => `${l.match(/context=(\S+)/)?.[1]}=${l.match(/state=(\S+)/)?.[1]}`);
}

function resultJson(): any {
  const runs = join(root, "logs", "runs");
  const dir = readdirSync(runs)[0];
  return JSON.parse(readFileSync(join(runs, dir, "result.json"), "utf8"));
}

describe("localci.sh", () => {
  test("green PR: pending then success on both contexts, posted to the PR head sha", () => {
    const head = openPr(7, "apps/fleet/b.txt", "x");
    const r = run("7");
    expect(r.code).toBe(0);
    // The lane watchdog is reaped quietly: no job-control noise in the daemon log.
    expect(r.err).not.toContain("Terminated");
    expect(posts()).toEqual([
      "local-ci/fleet-check=pending",
      "local-ci/english=pending",
      "local-ci/fleet-check=success",
      "local-ci/english=success",
    ]);
    expect(readFileSync(calls, "utf8")).toContain(`repos/o/r/statuses/${head}`);
  });

  test("the tested tree is PR head merged onto main, recorded in result.json", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    // main moves after the PR branched: the tested tree must hold both.
    sh(`echo later > apps/fleet/c.txt && git add -A && git commit -qm later && git push -q origin HEAD:main`);
    run("7");
    const r = resultJson();
    const files = sh(`git ls-tree -r --name-only ${r.tree}`);
    expect(files).toContain("apps/fleet/b.txt");
    expect(files).toContain("apps/fleet/c.txt");
  });

  test("a sha works as the target too", () => {
    const head = openPr(7, "apps/fleet/b.txt", "x");
    expect(run(head).code).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain(`statuses/${head}`);
  });

  test("conflict with main: failure 'conflicts with main' on both contexts, no lane runs", () => {
    openPr(7, "apps/fleet/a.txt", "theirs");
    sh(`echo ours > apps/fleet/a.txt && git commit -qam ours && git push -q origin HEAD:main`);
    const r = run("7");
    expect(r.code).toBe(1);
    expect(posts().slice(2)).toEqual(["local-ci/fleet-check=failure", "local-ci/english=failure"]);
    expect(readFileSync(calls, "utf8")).toContain("description=conflicts with main");
    expect(readFileSync(calls, "utf8")).not.toContain("docker run");
  });

  test("no fleet path touched: fleet-check still posts (success, skipped), english still runs", () => {
    openPr(7, "docs/e.md", "x");
    expect(run("7").code).toBe(0);
    expect(posts().slice(2)).toEqual(["local-ci/fleet-check=success", "local-ci/english=success"]);
    expect(readFileSync(calls, "utf8")).toContain("description=skipped");
    expect(readFileSync(calls, "utf8")).not.toContain("docker run");
  });

  // Issue #395: the fleet-path filter was `git diff --name-only ... | grep
  // -qE '^(apps/fleet/|...)'`  — a bare pipe under this script's own `set
  // -uo pipefail` (line 25), the same SIGPIPE/pipefail shape #393 proved
  // live against install-cache.ts's own traversal guard. Fixed by capturing
  // the diff into a variable first, then checking it via process
  // substitution (immune to the early-exit-reader problem by construction,
  // regardless of timing). This is a plain CORRECTNESS regression against
  // the real, fixed script for a diff genuinely past the 64KB pipe-buffer
  // size — not a forced race: this task's own investigation found the SAME
  // race unreliable to force deterministically against a real `git diff`
  // process even past 700KB (0/30 trials, likely because `git diff
  // --name-only` writes one short line per file — grep can decide "no
  // match yet" or "match" after only a few lines, long before the writer
  // could ever fill a 64KB pipe) — the fix is correct regardless of whether
  // the exact race can be forced to order.
  test("a large diff (thousands of changed files, past the 64KB pipe-buffer size) still detects the apps/fleet change and runs fleet-check (issue #395)", () => {
    sh(`git checkout -q -b pr8 main && mkdir -p apps/fleet zzz-padding && touch zzz-padding/f{1..5000}.txt \
        && echo changed > apps/fleet/a.txt && git add -A && git commit -qm pr8 \
        && git push -q origin HEAD:refs/pull/8/head && git checkout -q main`);
    const diffSize = Number(sh(`git diff --name-only main...pr8 | wc -c`));
    expect(diffSize).toBeGreaterThan(65_536);
    const r = run("8");
    expect(r.code).toBe(0);
    expect(posts().slice(2)).toEqual(["local-ci/fleet-check=success", "local-ci/english=success"]);
    // fleet-check actually RAN (not the "skipped" no-op path)
    expect(readFileSync(calls, "utf8")).not.toContain("description=skipped");
  });

  test("red Linux lane → failure, exit 1", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    writeFileSync(join(root, "linux.out"), "test/bun/wake-cmd.test.ts:\n(fail) wakes [1ms]\n 6 pass\n 1 fail\n");
    writeFileSync(join(root, "linux.code"), "1");
    const r = run("7");
    expect(r.code).toBe(1);
    expect(posts()[2]).toBe("local-ci/fleet-check=failure");
  });

  test("red only in a known-flaky file: that file reruns alone once, and a green rerun is success", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    writeFileSync(join(root, "linux.out"), "test/bun/session-memory.test.ts:\n(fail) peak [1ms]\n 6 pass\n 1 fail\n");
    writeFileSync(join(root, "linux.code"), "1");
    writeFileSync(join(root, "linux-rerun.out"), " 3 pass\n 0 fail\n");
    writeFileSync(join(root, "linux-rerun.code"), "0");
    const r = run("7");
    expect(r.code).toBe(0);
    const log = readFileSync(calls, "utf8");
    expect(log).toContain("bun test test/bun/session-memory.test.ts");
    expect(posts()[2]).toBe("local-ci/fleet-check=success");
    expect(log).toContain("flaky rerun ok");
  });

  test("--dry-run posts nothing, prints each status it would post", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    const r = run("7", ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(posts()).toEqual([]);
    expect(r.out).toContain("local-ci/fleet-check success");
  });

  test("a status POST that fails once is retried and the run still succeeds", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    const r = run("7", [], { STUB_GH_FAILS: "1" });
    expect(r.code).toBe(0);
    expect(r.err).toContain("status POST failed");
    expect(posts()).toHaveLength(5);
  });

  test("a status POST that fails twice fails the run loudly (exit 3), never swallowed", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    const r = run("7", [], { STUB_GH_FAILS: "99" });
    expect(r.code).toBe(3);
    expect(r.err).toContain("status POST failed");
  });

  // #267 follow-ups, each proved by the 2026-09-25 reboot.
  test("a hung lane is killed at its timeout: error status, lock released, no process left", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    const t0 = Date.now();
    const r = run("7", [], { STUB_LINUX_HANG: "1", LOCALCI_LANE_TIMEOUT: "2" });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.code).toBe(2);
    expect(posts()[2]).toBe("local-ci/fleet-check=error");
    expect(readFileSync(calls, "utf8")).toContain("description=lane linux timed out after 2s");
    const pid = Number(readFileSync(join(root, "hang.pid"), "utf8"));
    const deadline = Date.now() + 5_000;
    while (running(pid) && Date.now() < deadline) Bun.sleepSync(100);
    expect(running(pid)).toBe(false);
  });

  test("a lane killed by a signal posts error, never success or pending-forever", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    const r = run("7", [], { STUB_LINUX_KILLED: "1" });
    expect(r.code).toBe(2);
    expect(posts()[2]).toBe("local-ci/fleet-check=error");
    expect(readFileSync(calls, "utf8")).toContain("killed (signal 9)");
  });

  test("start sweeps a killed run: its worktree, refs and containers go, its pending sha gets error", () => {
    const dead = "20200101-000000-999999";
    const stale = sh("git rev-parse main");
    sh(`git worktree add -q --detach ${root}/work/wt-${dead} main && git update-ref refs/localci/${dead}/head main \
        && git update-ref refs/localci/pr268 main && git update-ref refs/localci/foo/bar main`);
    mkdirSync(join(root, "logs", "runs", dead), { recursive: true });
    writeFileSync(join(root, "logs", "runs", dead, "meta"), `sha=${stale}\npr=5\n`);
    openPr(7, "apps/fleet/b.txt", "x");
    run("7");
    expect(existsSync(join(root, "work", `wt-${dead}`))).toBe(false);
    expect(sh(`git for-each-ref refs/localci/${dead}/`)).toBe("");
    // Another tool's ref under refs/localci/ that is not a run id is left alone.
    expect(sh("git for-each-ref --format='%(refname)' refs/localci/pr268")).toBe("refs/localci/pr268");
    // A NESTED foreign ref too: only run-id-shaped refs/localci/<rid>/ belong to localci.
    expect(sh("git for-each-ref --format='%(refname)' refs/localci/foo/")).toBe("refs/localci/foo/bar");
    const log = readFileSync(calls, "utf8");
    // -v: the lane's anonymous node_modules volume goes with its container.
    expect(log).toContain(`docker rm -f -v localci-${dead}-linux`);
    expect(log).toContain(`statuses/${stale}`);
    expect(log).toContain("run killed before it finished");
    // Swept once: a second run posts nothing more for the dead run.
    const before = log.split(`statuses/${stale}`).length;
    run("7");
    expect(readFileSync(calls, "utf8").split(`statuses/${stale}`).length).toBe(before);
  });

  test("a finished run's log dir is history, not a leftover: never swept", () => {
    const done = "20200101-000000-999998";
    mkdirSync(join(root, "logs", "runs", done), { recursive: true });
    writeFileSync(join(root, "logs", "runs", done, "result.json"), "{}");
    openPr(7, "apps/fleet/b.txt", "x");
    const r = run("7");
    expect(r.err).not.toContain(`sweeping killed run ${done}`);
  });

  // PR #272 review, MED: launchd bootout / a plain kill sends SIGTERM. Lanes
  // must not keep the trap waiting, nor outlive the run in their own pgroups.
  test("SIGTERM mid-lane: exits promptly, posts error, lane processes and refs gone", async () => {
    openPr(7, "apps/fleet/b.txt", "x");
    const p = Bun.spawn(["bash", SCRIPT, "7"], {
      cwd: repo,
      env: runEnv({ STUB_LINUX_HANG: "1", LOCALCI_LANE_TIMEOUT: "600" }),
      stderr: "pipe",
      stdout: "pipe",
    });
    const pidFile = join(root, "hang.pid");
    const until = Date.now() + 30_000;
    while (!existsSync(pidFile) && Date.now() < until) await Bun.sleep(100);
    const hang = Number(readFileSync(pidFile, "utf8"));
    const t0 = Date.now();
    p.kill("SIGTERM");
    await p.exited;
    // #382: this path needs no LOCALCI_KILL_GRACE wait (the stub dies on TERM
    // at once), but stop_lanes/cleanup still fork gh/docker/git subprocesses
    // and walk the process table (sweep_procs) twice — the same host-load-
    // driven overhead the harder "ignores TERM" scenario budgets 15s for
    // below, which only adds ~1s of *mandatory* wait (LOCALCI_KILL_GRACE=1)
    // on top of that shared overhead. Match its accepted budget rather than
    // a tighter one that doesn't reflect a meaningfully lighter workload.
    expect(Date.now() - t0).toBeLessThan(15_000);
    const deadline = Date.now() + 5_000;
    while (running(hang) && Date.now() < deadline) await Bun.sleep(100);
    expect(running(hang)).toBe(false);
    expect(posts().at(-1)).toBe("local-ci/english=error");
    expect(readFileSync(calls, "utf8")).toContain("description=error: run interrupted");
    expect(sh("git for-each-ref refs/localci")).toBe("");
    // #291.4: an interrupted run finished its own cleanup — the next start
    // must not sweep it again and re-post error on its sha.
    expect(run("7").err).not.toContain("sweeping killed run");
  });

  // #291.1: lockf dies on TERM at once and frees the gate lock while the lane
  // is still dying — the next heavy job starts on top of it. The run must hold
  // the lock until its lane is really gone, escalating to KILL after a grace.
  test("SIGTERM with a lane that ignores TERM: exit only after it is dead, lock free at exit", async () => {
    openPr(7, "apps/fleet/b.txt", "x");
    const lock = join(root, "gate.lock");
    const p = Bun.spawn(["bash", SCRIPT, "7"], {
      cwd: repo,
      env: runEnv({ STUB_LINUX_HANG: "stubborn", LOCALCI_LANE_TIMEOUT: "600", LOCALCI_KILL_GRACE: "1" }),
      stderr: "pipe",
      stdout: "pipe",
    });
    const pidFile = join(root, "hang.pid");
    const until = Date.now() + 30_000;
    while (!existsSync(pidFile) && Date.now() < until) await Bun.sleep(100);
    const hang = Number(readFileSync(pidFile, "utf8"));
    const t0 = Date.now();
    p.kill("SIGTERM");
    await p.exited;
    // No polling: the moment the run is gone, its lane must be gone too.
    expect(running(hang)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const probe = Bun.spawnSync(["bash", "-c", `if command -v flock >/dev/null; then flock -n "${lock}" true; else lockf -t 0 "${lock}" true; fi`]);
    expect(probe.exitCode).toBe(0);
  });

  // #279: --native runs every lane on this host (a Linux studio has no docker).
  describe("--native", () => {
    test("green: no docker at all, lanes run here, success, runner=linux/native in the description", () => {
      openPr(7, "apps/fleet/b.txt", "x");
      const r = run("7", ["--native"]);
      expect(r.code).toBe(0);
      const log = readFileSync(calls, "utf8");
      expect(log).toContain("bun run bun-test");
      expect(log).not.toMatch(/^docker (run|info|build|image)/m);
      expect(posts().slice(2)).toEqual(["local-ci/fleet-check=success", "local-ci/english=success"]);
      expect(log).toMatch(/context=local-ci\/fleet-check -f description=.*runner=linux\/native/);
    });

    // PR #306 review: the label comes from the host, not the flag.
    test("runner label from the host: a studio (IS_SANDBOX=1) says studio/native", () => {
      openPr(7, "apps/fleet/b.txt", "x");
      run("7", ["--native"], { IS_SANDBOX: "1" });
      expect(readFileSync(calls, "utf8")).toMatch(/context=local-ci\/fleet-check -f description=.*runner=studio\/native/);
    });

    // PR #306 review BLOCKER: no container reaps what a suite leaves behind
    // (ego-browser daemons, tmux servers, daemon loops from a deleted worktree).
    test("after the lanes, every process of the run is gone — daemonized, env-marked or pathed under the worktree", () => {
      openPr(7, "apps/fleet/b.txt", "x");
      expect(run("7", ["--native"], { STUB_LEAK: "1" }).code).toBe(0);
      for (const f of ["leak-env.pid", "leak-path.pid"]) {
        const pid = Number(readFileSync(join(root, f), "utf8"));
        const until = Date.now() + 3_000;
        while (running(pid) && Date.now() < until) Bun.sleepSync(100);
        expect({ f, alive: running(pid) }).toEqual({ f, alive: false });
      }
    });

    // PR #306 review: name each missing native prerequisite.
    test("native prerequisites: a broken tmux and a missing chromium are named, no lane runs", () => {
      openPr(7, "apps/fleet/b.txt", "x");
      writeFileSync(join(root, "bin", "tmux"), "#!/bin/bash\nexit 127\n");
      const r = run("7", ["--native"], { LOCALCI_CHROMIUM: join(root, "nope", "chromium") });
      expect(r.code).toBe(2);
      const log = readFileSync(calls, "utf8");
      expect(log).toContain("native prerequisites missing: tmux chromium");
      expect(log).not.toContain("bun run check");
    });

    test("the bun-test lane runs with TMUX and TMUX_PANE unset, whatever the caller has", () => {
      openPr(7, "apps/fleet/b.txt", "x");
      run("7", ["--native"], { TMUX: "/tmp/tmux-0/fleet-studio,1,0", TMUX_PANE: "%3" });
      expect(readFileSync(calls, "utf8")).toContain("env TMUX=unset TMUX_PANE=unset");
    });

    test("red only in a known-flaky file reruns that file natively, once", () => {
      openPr(7, "apps/fleet/b.txt", "x");
      writeFileSync(join(root, "linux.out"), "test/bun/session-memory.test.ts:\n(fail) peak [1ms]\n 6 pass\n 1 fail\n");
      writeFileSync(join(root, "linux.code"), "1");
      writeFileSync(join(root, "linux-rerun.out"), " 3 pass\n 0 fail\n");
      writeFileSync(join(root, "linux-rerun.code"), "0");
      expect(run("7", ["--native"]).code).toBe(0);
      const log = readFileSync(calls, "utf8");
      expect(log).toContain("bun test test/bun/session-memory.test.ts");
      expect(log).not.toMatch(/^docker run/m);
    });

    test("refuses a non-Linux host: error status, no lane runs", () => {
      openPr(7, "apps/fleet/b.txt", "x");
      const r = run("7", ["--native"], { STUB_UNAME: "Darwin" });
      expect(r.code).toBe(2);
      expect(posts().slice(2)).toEqual(["local-ci/fleet-check=error", "local-ci/english=error"]);
      expect(readFileSync(calls, "utf8")).toContain("--native needs a Linux host");
      expect(readFileSync(calls, "utf8")).not.toContain("bun run bun-test");
    });

    test("flags work in either order: --dry-run --native", () => {
      openPr(7, "apps/fleet/b.txt", "x");
      const r = run("7", ["--dry-run", "--native"]);
      expect(r.code).toBe(0);
      expect(posts()).toEqual([]);
      expect(r.out).toContain("runner=linux/native");
    });
  });

  // Found by the first real --native run (2026-09-25, localci image, no node)
  // and by the first launchd install (nvm-only node): vitest is
  // `#!/usr/bin/env node`; without node, `bun run test` runs it on Bun, its
  // config fails, 0 tests run. Name the cause instead.
  for (const mode of [[], ["--native"]]) {
    test(`no node on PATH${mode.length ? " (--native)" : ""}: error 'node not on PATH', no lane runs`, () => {
      openPr(7, "apps/fleet/b.txt", "x");
      rmSync(join(root, "bin", "node"));
      const r = run("7", mode, { PATH: `${root}/bin:/usr/bin:/bin` });
      expect(r.code).toBe(2);
      expect(posts().slice(2)).toEqual(["local-ci/fleet-check=error", "local-ci/english=error"]);
      const log = readFileSync(calls, "utf8");
      expect(log).toContain("node not on PATH");
      expect(log).not.toContain("bun run check");
    });
  }

  test("docker mode on the Mac says runner=mac/docker", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    run("7", [], { STUB_UNAME: "Darwin" });
    expect(readFileSync(calls, "utf8")).toMatch(/context=local-ci\/fleet-check -f description=.*runner=mac\/docker/);
  });

  // PR #306 review: a git plumbing failure reports its own cause.
  const REAL_GIT = Bun.which("git")!;
  for (const [cmd, msg, want] of [
    ["commit-tree", "fatal: commit-tree boom", "commit-tree failed: fatal: commit-tree boom"],
    ["merge-tree", "fatal: bad tree", "merge-tree failed: fatal: bad tree"],
  ] as const) {
    test(`${cmd} failing → error naming git's own message, never a conflict`, () => {
      openPr(7, "apps/fleet/b.txt", "x");
      stub("git", `if [ "$1" = ${cmd} ]; then echo "${msg}" >&2; exit 128; fi; exec "${REAL_GIT}" "$@"`);
      const r = run("7");
      expect(r.code).toBe(2);
      const log = readFileSync(calls, "utf8");
      expect(log).toContain(`description=error: ${want}`);
      expect(log).not.toContain("conflicts with main");
    });
  }

  test("nothing outlives the run: no worktree, no refs/localci/*", () => {
    openPr(7, "apps/fleet/b.txt", "x");
    run("7");
    expect(sh("git for-each-ref refs/localci")).toBe("");
    expect(sh("git worktree list").split("\n")).toHaveLength(1);
    const work = join(root, "work");
    expect(existsSync(work) ? readdirSync(work) : []).toEqual([]);
  });
});
