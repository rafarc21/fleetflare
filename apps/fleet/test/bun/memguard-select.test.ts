// container/memguard.ts — victim selection, memory source and escalation,
// against FIXTURE /proc and cgroup trees (issue #169).
//
// Every function under test takes its roots as arguments, so none of this
// touches the real /proc of the machine running the suite. The live behaviour
// (a real hog, a real cgroup limit) is test/bun/memguard-docker.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjPlan,
  adjScan,
  decide,
  formatLogLine,
  initialState,
  isProtected,
  newAdjCache,
  nextTickMs,
  pickVictim,
  protectedSet,
  readMemory,
  readProcs,
  redact,
  refreshLeadParentPid,
  resolveLeadParentPid,
  step,
  trimLog,
  type GuardConfig,
  type Proc,
} from "../../container/memguard";
import { redactSecrets } from "../../src/studio/redact";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memguard-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface FixtureProc {
  pid: number;
  comm: string;
  argv: string[];
  rssMiB: number;
  adj?: number;
  start?: number;
  ppid?: number;
}

/** Write a /proc-shaped tree: <root>/<pid>/{comm,cmdline,status,stat,oom_score_adj}. */
function procTree(procs: FixtureProc[]): string {
  const root = tmp();
  for (const p of procs) {
    const d = join(root, String(p.pid));
    mkdirSync(d);
    writeFileSync(join(d, "comm"), `${p.comm}\n`);
    writeFileSync(join(d, "cmdline"), p.argv.length ? p.argv.join("\0") + "\0" : "");
    writeFileSync(join(d, "status"), `Name:\t${p.comm}\nVmRSS:\t${p.rssMiB * 1024} kB\n`);
    // Field 4 is ppid, field 22 starttime. The comm deliberately may carry
    // spaces and a ')' -- the parser must split on the LAST ')'.
    const fields = ["S", String(p.ppid ?? 1), ...Array(17).fill("0"), String(p.start ?? 1000 + p.pid)];
    writeFileSync(join(d, "stat"), `${p.pid} (${p.comm}) ${fields.join(" ")}\n`);
    writeFileSync(join(d, "oom_score_adj"), `${p.adj ?? 0}\n`);
  }
  // Non-pid entries a real /proc carries; the reader must skip them.
  mkdirSync(join(root, "self"));
  writeFileSync(join(root, "meminfo"), "MemTotal: 1 kB\n");
  return root;
}

const SELF = 50;
const FLOOR = 64;
// #238: LEAD's ppid (150, the pane shell) is what `resolveLeadParentPid()`
// resolves in production -- the ONE parent that makes a claude-named process
// THE lead, not merely claude-named.
const PANE = 150;
const LEAD: FixtureProc = { pid: 200, comm: "claude", argv: ["claude", "--dangerously-skip-permissions"], rssMiB: 3000, ppid: 150 };
const STUDIO: FixtureProc[] = [
  { pid: 1, comm: "sandbox", argv: ["/container-server/sandbox"], rssMiB: 4000, ppid: 0 },
  { pid: 40, comm: "flock", argv: ["flock", "-n", "/run/fleet-memguard.lock", "bun", "/opt/fleet/memguard.ts"], rssMiB: 1, ppid: 1 },
  { pid: SELF, comm: "bun", argv: ["bun", "/opt/fleet/memguard.ts"], rssMiB: 9000, ppid: 40 },
  { pid: 100, comm: "tmux: server", argv: ["tmux", "new-session", "-d", "-s", "studio"], rssMiB: 5000 },
  { pid: 150, comm: "bash", argv: ["bash"], rssMiB: 5, ppid: 100 },
  LEAD,
  { pid: 300, comm: "tailscaled", argv: ["tailscaled", "--tun=userspace-networking"], rssMiB: 6000 },
  { pid: 400, comm: "sshd", argv: ["sshd: root@pts/0"], rssMiB: 7000 },
  { pid: 500, comm: "bash", argv: ["bash"], rssMiB: 800 },
  { pid: 600, comm: "node", argv: ["node", "/w/node_modules/.bin/vitest", "run"], rssMiB: 1200, ppid: 200 },
  { pid: 700, comm: "node", argv: ["node", "/w/node_modules/.bin/vite", "build"], rssMiB: 2100, ppid: 200 },
  { pid: 800, comm: "python3", argv: ["python3", "big.py"], rssMiB: 2500 },
];

describe("isProtected", () => {
  const procs = readProcs(procTree(STUDIO));
  const byPid = (pid: number) => procs.find((p) => p.pid === pid)!;

  test("protects PID 1, the killer itself, tmux server, the lead claude, tailscaled, sshd", () => {
    for (const pid of [1, SELF, 100, 200, 300, 400]) expect(isProtected(byPid(pid), SELF, PANE)).toBe(true);
  });

  test("does not protect gates, shells or other user processes", () => {
    for (const pid of [500, 600, 700, 800]) expect(isProtected(byPid(pid), SELF, PANE)).toBe(false);
  });

  test("protects a lead whose argv[0] is a full path to claude, and one that renamed its comm", () => {
    const [a, b] = readProcs(
      procTree([
        { pid: 10, comm: "claude", argv: ["/usr/local/bin/claude"], rssMiB: 1, ppid: 9 },
        { pid: 11, comm: "MainThread", argv: ["/usr/local/bin/claude", "--continue"], rssMiB: 1, ppid: 9 },
      ]),
    );
    expect(isProtected(a, SELF, 9)).toBe(true);
    expect(isProtected(b, SELF, 9)).toBe(true);
  });

  test("a gate that merely mentions claude in its args is NOT protected", () => {
    const [p] = readProcs(procTree([{ pid: 12, comm: "node", argv: ["node", "vitest", "claude.test.ts"], rssMiB: 1 }]));
    expect(isProtected(p, SELF, PANE)).toBe(false);
  });

  test("protects the sandbox executor pool under PID 1 (argv carries /container-server/)", () => {
    const [p] = readProcs(
      procTree([{ pid: 13, comm: "bun", argv: ["bun", "/container-server/dist/executor.js"], rssMiB: 900 }]),
    );
    expect(isProtected(p, SELF, PANE)).toBe(true);
  });

  // #238: narrowed to THE lead -- the one claude-named process whose parent
  // is the pane shell tmux spawned for studio:claude -- not every
  // claude-named process.
  describe("#238 -- narrowed to THE lead", () => {
    test("a nested `claude -p` spawned BY the lead itself is NOT protected", () => {
      const [nested] = readProcs(
        procTree([{ pid: 250, comm: "claude", argv: ["claude", "-p", "summarize this"], rssMiB: 50, ppid: 200 }]),
      );
      expect(isProtected(nested, SELF, PANE)).toBe(false);
    });

    test("a stale/orphaned claude-named leak (issue #67), unrelated to the pane shell, is NOT protected", () => {
      const [orphan] = readProcs(
        procTree([{ pid: 260, comm: "claude", argv: ["claude", "--continue"], rssMiB: 1800, ppid: 1 }]),
      );
      expect(isProtected(orphan, SELF, PANE)).toBe(false);
    });

    test("the lead itself is still protected when its parent pid is passed explicitly", () => {
      const [lead] = readProcs(procTree([LEAD]));
      expect(isProtected(lead, SELF, PANE)).toBe(true);
    });

    test("unresolved pane pid (null) falls back to the OLD broad rule: every claude-named process is protected", () => {
      const [nested, orphan] = readProcs(
        procTree([
          { pid: 250, comm: "claude", argv: ["claude", "-p", "summarize this"], rssMiB: 50, ppid: 200 },
          { pid: 260, comm: "claude", argv: ["claude", "--continue"], rssMiB: 1800, ppid: 1 },
        ]),
      );
      expect(isProtected(nested, SELF, null)).toBe(true);
      expect(isProtected(orphan, SELF, null)).toBe(true);
    });
  });
});

describe("protectedSet — a protected process's ancestors are protected too", () => {
  const procs = readProcs(procTree(STUDIO));

  test("tmux server -> bash -> claude: the pane shell is protected", () => {
    expect(protectedSet(procs, SELF, PANE).has(150)).toBe(true);
  });

  test("the guard's flock parent is protected", () => {
    expect(protectedSet(procs, SELF, PANE).has(40)).toBe(true);
  });

  test("descendants of the lead (its gates) are NOT protected", () => {
    const set = protectedSet(procs, SELF, PANE);
    expect(set.has(600)).toBe(false);
    expect(set.has(700)).toBe(false);
  });

  test("#238: a nested `claude -p` child of the lead is itself excluded; only its ancestors are protected", () => {
    const withNested = readProcs(
      procTree([...STUDIO, { pid: 250, comm: "claude", argv: ["claude", "-p", "x"], rssMiB: 50, ppid: 200 }]),
    );
    const set = protectedSet(withNested, SELF, PANE);
    expect(set.has(250)).toBe(false);
    expect(set.has(200)).toBe(true); // its parent, the real lead, still is
  });
});

describe("readProcs", () => {
  test("parses pid, ppid, comm, argv, rss, adj and starttime; skips non-pid entries and kernel threads", () => {
    const root = procTree([
      { pid: 42, comm: "weird ) name", argv: ["x", "y"], rssMiB: 3, adj: -5, start: 777, ppid: 9 },
      { pid: 43, comm: "kthreadd", argv: [], rssMiB: 0 },
    ]);
    const procs = readProcs(root);
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({ pid: 42, ppid: 9, comm: "weird ) name", argv: ["x", "y"], rssKiB: 3 * 1024, adj: -5, start: 777 });
  });

  test("a pid that vanishes mid-scan is skipped, not thrown", () => {
    const root = procTree([{ pid: 44, comm: "a", argv: ["a"], rssMiB: 1 }]);
    mkdirSync(join(root, "45")); // a directory with no files: the process exited
    expect(readProcs(root).map((p) => p.pid)).toEqual([44]);
  });
});

describe("pickVictim", () => {
  test("prefers a gate over a larger non-gate process", () => {
    const v = pickVictim(readProcs(procTree(STUDIO)), SELF, PANE, FLOOR);
    expect(v?.pid).toBe(700); // vite 2100 MiB within 2x of python3 2500 MiB: prefer list wins
  });

  test("never the lead's pane shell, even when it is the largest open process", () => {
    const big = STUDIO.map((p) => (p.pid === 150 ? { ...p, rssMiB: 90000 } : p));
    expect(pickVictim(readProcs(procTree(big)), SELF, PANE, FLOOR)?.pid).toBe(700);
  });

  test("never the guard's flock parent, even when it is the largest open process", () => {
    const big = STUDIO.map((p) => (p.pid === 40 ? { ...p, rssMiB: 90000 } : p));
    expect(pickVictim(readProcs(procTree(big)), SELF, PANE, FLOOR)?.pid).toBe(700);
  });

  test("largest RSS among preferred gates wins", () => {
    const v = pickVictim(
      readProcs(
        procTree([
          { pid: 2, comm: "node", argv: ["node", "vitest"], rssMiB: 300 },
          { pid: 3, comm: "esbuild", argv: ["/x/esbuild", "--service"], rssMiB: 900 },
          { pid: 4, comm: "chrome", argv: ["/usr/local/bin/chromium", "--type=renderer"], rssMiB: 500 },
          { pid: 5, comm: "bun", argv: ["bun", "test", "a.test.ts"], rssMiB: 700 },
        ]),
      ),
      SELF,
      null,
      FLOOR,
    );
    expect(v?.pid).toBe(3);
  });

  test("prefer is bounded: a gate under half the largest candidate loses to the largest", () => {
    const tree = (gateMiB: number) =>
      readProcs(
        procTree([
          { pid: 2, comm: "node", argv: ["node", "vitest"], rssMiB: gateMiB },
          { pid: 3, comm: "python3", argv: ["python3", "hog.py"], rssMiB: 900 },
        ]),
      );
    expect(pickVictim(tree(449), SELF, null, FLOOR)?.pid).toBe(3);
    expect(pickVictim(tree(450), SELF, null, FLOOR)?.pid).toBe(2);
  });

  test("falls back to largest non-protected process when no gate clears the floor", () => {
    const v = pickVictim(
      readProcs(
        procTree([
          { pid: 2, comm: "node", argv: ["node", "vitest"], rssMiB: 10 },
          { pid: 3, comm: "python3", argv: ["python3", "hog.py"], rssMiB: 900 },
          { pid: 4, comm: "bash", argv: ["bash"], rssMiB: 5 },
        ]),
      ),
      SELF,
      null,
      FLOOR,
    );
    expect(v?.pid).toBe(3);
  });

  test("the floor applies to EVERY victim: only small processes left -> null", () => {
    const v = pickVictim(
      readProcs(
        procTree([
          { pid: 2, comm: "bash", argv: ["bash"], rssMiB: 5 },
          { pid: 3, comm: "python3", argv: ["python3", "x.py"], rssMiB: 63 },
          { pid: 4, comm: "node", argv: ["node", "vitest"], rssMiB: 40 },
        ]),
      ),
      SELF,
      null,
      FLOOR,
    );
    expect(v).toBeNull();
  });

  test("never picks a protected process, however large; null when only protected remain", () => {
    const only = STUDIO.filter((p) => [1, 40, SELF, 100, 150, 200, 300, 400].includes(p.pid));
    expect(pickVictim(readProcs(procTree(only)), SELF, PANE, FLOOR)).toBeNull();
  });

  describe("#238 -- a claude-named process that is NOT the lead is an ordinary candidate", () => {
    test("a nested `claude -p` big enough to clear the floor is picked once it is the largest open process", () => {
      const withNested = readProcs(
        procTree([...STUDIO, { pid: 250, comm: "claude", argv: ["claude", "-p", "x"], rssMiB: 5000, ppid: 200 }]),
      );
      expect(pickVictim(withNested, SELF, PANE, FLOOR)?.pid).toBe(250);
    });

    test("a stale orphaned claude-named leak big enough to clear the floor is picked", () => {
      const withOrphan = readProcs(
        procTree([...STUDIO, { pid: 260, comm: "claude", argv: ["claude", "--continue"], rssMiB: 5000, ppid: 1 }]),
      );
      expect(pickVictim(withOrphan, SELF, PANE, FLOOR)?.pid).toBe(260);
    });

    test("unresolved pane pid (null) still spares a nested claude -p (old broad behaviour)", () => {
      const withNested = readProcs(
        procTree([...STUDIO, { pid: 250, comm: "claude", argv: ["claude", "-p", "x"], rssMiB: 5000, ppid: 200 }]),
      );
      expect(pickVictim(withNested, SELF, null, FLOOR)?.pid).toBe(700); // same pick as with no nested process at all
    });
  });
});

const byPid = (plan: Array<{ pid: number; adj: number }>) => [...plan].sort((a, b) => a.pid - b.pid);

describe("adjPlan — the inherited oom_score_adj trap", () => {
  test("pins protected processes (and their ancestors) at -1000 and raises every other process to +500", () => {
    // The lead at -1000 forked two gates: both INHERITED -1000. Without the
    // raise, a kernel OOM would skip them and pick nothing useful.
    const procs = readProcs(
      procTree([
        { pid: 100, comm: "tmux: server", argv: ["tmux"], rssMiB: 5, adj: 0 },
        { pid: 150, comm: "bash", argv: ["bash"], rssMiB: 5, adj: 500, ppid: 100 },
        { ...LEAD, adj: -1000 },
        { pid: 600, comm: "node", argv: ["node", "vitest"], rssMiB: 100, adj: -1000, ppid: 200 },
        { pid: 601, comm: "bash", argv: ["bash"], rssMiB: 1, adj: -1000, ppid: 200 },
        { pid: 602, comm: "node", argv: ["node", "vite"], rssMiB: 100, adj: 500 },
        { pid: 603, comm: "node", argv: ["node", "x"], rssMiB: 100, adj: 900 },
      ]),
    );
    expect(byPid(adjPlan(procs, SELF, PANE))).toEqual([
      { pid: 100, adj: -1000 },
      { pid: 150, adj: -1000 },
      { pid: 600, adj: 500 },
      { pid: 601, adj: 500 },
    ]);
  });
});

describe("adjScan — incremental adj pass (only new or exec'd pids are read in full)", () => {
  test("first scan pins/raises everything; an unchanged second scan writes nothing", () => {
    const root = procTree([
      { ...LEAD, adj: 0, ppid: 1 },
      { pid: 600, comm: "node", argv: ["node", "vitest"], rssMiB: 100, adj: -1000, ppid: 200 },
    ]);
    const cache = newAdjCache();
    // This fixture parents LEAD directly at 1, not at a pane shell in a
    // studio tree: 1 stands in for "wherever resolveLeadParentPid resolved."
    expect(byPid(adjScan(root, cache, SELF, 1))).toEqual([
      { pid: 200, adj: -1000 },
      { pid: 600, adj: 500 },
    ]);
    writeFileSync(join(root, "200", "oom_score_adj"), "-1000\n");
    writeFileSync(join(root, "600", "oom_score_adj"), "500\n");
    expect(adjScan(root, cache, SELF, 1)).toEqual([]);
  });

  test("a pid that exec'd into claude after it was first seen as bash gets pinned", () => {
    // bash forks, the child is read while still `bash` (raised to +500), then
    // execs claude: a lead relaunch. comm changes, so the pid is re-read.
    // ppid defaults to 1, so 1 is the resolved lead-parent pid throughout.
    const root = procTree([{ pid: 900, comm: "bash", argv: ["bash"], rssMiB: 1, adj: 0 }]);
    const cache = newAdjCache();
    expect(adjScan(root, cache, SELF, 1)).toEqual([{ pid: 900, adj: 500 }]);
    writeFileSync(join(root, "900", "comm"), "claude\n");
    writeFileSync(join(root, "900", "cmdline"), "claude\0--continue\0");
    writeFileSync(join(root, "900", "oom_score_adj"), "500\n");
    expect(adjScan(root, cache, SELF, 1)).toEqual([{ pid: 900, adj: -1000 }]);
  });

  test("a NEW lead pins its already-cached pane shell too (the cache hides the older ancestor)", () => {
    const root = procTree([{ pid: 150, comm: "bash", argv: ["bash"], rssMiB: 5, adj: 0 }]);
    const cache = newAdjCache();
    expect(adjScan(root, cache, SELF, PANE)).toEqual([{ pid: 150, adj: 500 }]);
    writeFileSync(join(root, "150", "oom_score_adj"), "500\n");
    // The pane shell starts the lead: a new pid, parent 150.
    mkdirSync(join(root, "200"));
    writeFileSync(join(root, "200", "comm"), "claude\n");
    writeFileSync(join(root, "200", "cmdline"), "claude\0");
    writeFileSync(join(root, "200", "status"), "VmRSS:\t1024 kB\n");
    writeFileSync(join(root, "200", "stat"), `200 (claude) S 150 ${Array(17).fill("0").join(" ")} 5000\n`);
    writeFileSync(join(root, "200", "oom_score_adj"), "500\n");
    expect(byPid(adjScan(root, cache, SELF, PANE))).toEqual([
      { pid: 150, adj: -1000 },
      { pid: 200, adj: -1000 },
    ]);
  });

  test("exited pids leave the cache", () => {
    const root = procTree([{ pid: 901, comm: "node", argv: ["node"], rssMiB: 1, adj: 500 }]);
    const cache = newAdjCache();
    adjScan(root, cache, SELF, null);
    expect(cache.comm.has(901)).toBe(true);
    rmSync(join(root, "901"), { recursive: true });
    adjScan(root, cache, SELF, null);
    expect(cache.comm.has(901)).toBe(false);
  });

  test("#270 round 2: a changed leadParentPid invalidates the cache -- a stale pin is corrected on the VERY NEXT scan", () => {
    // Cycle 1: leadParentPid=1 stands in for the OLD pane shell. LEAD
    // (ppid=1) matches it and gets pinned; its comm ("claude") is cached.
    const root = procTree([{ ...LEAD, adj: 0, ppid: 1 }]);
    const cache = newAdjCache();
    expect(adjScan(root, cache, SELF, 1)).toEqual([{ pid: 200, adj: -1000 }]);
    writeFileSync(join(root, "200", "oom_score_adj"), "-1000\n");
    // Cycle 2: leadParentPid changes to 999 (e.g. a pane respawn resolved a
    // genuinely different pid, or a failed refresh reset it -- either way it
    // is no longer 1). LEAD's ppid (1) no longer matches: its -1000 immunity
    // must be corrected THIS scan even though its comm never changed and an
    // incremental pass would otherwise skip it entirely.
    expect(adjScan(root, cache, SELF, 999)).toEqual([{ pid: 200, adj: 500 }]);
  });
});

describe("readMemory", () => {
  function meminfo(root: string, totalMiB: number, availMiB: number) {
    writeFileSync(
      join(root, "meminfo"),
      `MemTotal:       ${totalMiB * 1024} kB\nMemFree:          1 kB\nMemAvailable:   ${availMiB * 1024} kB\n`,
    );
  }
  const MiB = 1024 * 1024;
  function cgroup(root: string, maxMiB: number, currentMiB: number, inactiveMiB: number) {
    writeFileSync(join(root, "memory.max"), `${maxMiB * MiB}\n`);
    writeFileSync(join(root, "memory.current"), `${currentMiB * MiB}\n`);
    writeFileSync(join(root, "memory.stat"), `anon ${currentMiB * MiB}\ninactive_file ${inactiveMiB * MiB}\nactive_file 0\n`);
  }

  test("uses /proc/meminfo when the cgroup is unlimited (CF VM: memory.max=max)", () => {
    const proc = tmp();
    const cg = tmp();
    meminfo(proc, 11930, 700);
    writeFileSync(join(cg, "memory.max"), "max\n");
    writeFileSync(join(cg, "memory.current"), "123\n");
    expect(readMemory(proc, cg)).toEqual({ availMiB: 700, totalMiB: 11930, source: "meminfo" });
  });

  test("uses /proc/meminfo when there is no cgroup memory controller file at all", () => {
    const proc = tmp();
    meminfo(proc, 5800, 300);
    expect(readMemory(proc, tmp())).toEqual({ availMiB: 300, totalMiB: 5800, source: "meminfo" });
  });

  test("uses cgroup v2 max - current + inactive_file when limited (docker --memory)", () => {
    const proc = tmp();
    const cg = tmp();
    meminfo(proc, 64000, 60000); // the host's view: plenty free, and wrong for this cgroup
    cgroup(cg, 1024, 1000, 40);
    expect(readMemory(proc, cg)).toEqual({ availMiB: 64, totalMiB: 1024, source: "cgroup" });
  });

  test("limited cgroup inside a starved host: available is the SMALLER of the two", () => {
    const proc = tmp();
    const cg = tmp();
    meminfo(proc, 64000, 20);
    cgroup(cg, 1024, 500, 0);
    expect(readMemory(proc, cg)).toEqual({ availMiB: 20, totalMiB: 1024, source: "cgroup" });
  });
});

describe("decide — escalation", () => {
  const cfg: GuardConfig = { termPct: 6, killPct: 3, graceMs: 5000, minVictimMiB: FLOOR, settleMs: 1000, recoverMiB: 64 };
  const mem = (availMiB: number) => ({ availMiB, totalMiB: 1000, source: "cgroup" as const });
  const procs = () => readProcs(procTree(STUDIO));
  const without = (pid: number) => procs().filter((p) => p.pid !== pid);

  test("above the TERM threshold: nothing", () => {
    expect(decide(initialState(), mem(61), procs(), 0, cfg, SELF, PANE).action).toBeNull();
  });

  test("below TERM: SIGTERM the chosen victim, then wait out the grace period", () => {
    const first = decide(initialState(), mem(50), procs(), 0, cfg, SELF, PANE);
    expect(first.action).toMatchObject({ signal: "SIGTERM", victim: { pid: 700 } });
    const waiting = decide(first.state, mem(50), procs(), 4000, cfg, SELF, PANE);
    expect(waiting.action).toBeNull();
  });

  test("victim still alive after the grace period: SIGKILL the SAME victim", () => {
    const first = decide(initialState(), mem(50), procs(), 0, cfg, SELF, PANE);
    const second = decide(first.state, mem(50), procs(), 5001, cfg, SELF, PANE);
    expect(second.action).toMatchObject({ signal: "SIGKILL", victim: { pid: 700 } });
  });

  test("below KILL: SIGKILL at once, no grace", () => {
    expect(decide(initialState(), mem(20), procs(), 0, cfg, SELF, PANE).action).toMatchObject({
      signal: "SIGKILL",
      victim: { pid: 700 },
    });
  });

  test("below KILL while a TERMed victim is pending: SIGKILL it without waiting out the grace", () => {
    const first = decide(initialState(), mem(50), procs(), 0, cfg, SELF, PANE);
    expect(decide(first.state, mem(20), procs(), 100, cfg, SELF, PANE).action).toMatchObject({
      signal: "SIGKILL",
      victim: { pid: 700 },
    });
  });

  test("a TERMed victim that exited: NO new victim while its memory drains, the next one after the settle", () => {
    const first = decide(initialState(), mem(50), procs(), 0, cfg, SELF, PANE);
    const gone = decide(first.state, mem(50), without(700), 100, cfg, SELF, PANE);
    expect(gone.action).toBeNull();
    const draining = decide(gone.state, mem(50), without(700), 1099, cfg, SELF, PANE);
    expect(draining.action).toBeNull();
    expect(decide(draining.state, mem(50), without(700), 1100, cfg, SELF, PANE).action).toMatchObject({
      signal: "SIGTERM",
      victim: { pid: 800 }, // vitest 1200 < half of python3 2500: the prefer bound yields
    });
  });

  test("a SIGKILLed victim that exited settles too, even below KILL", () => {
    const first = decide(initialState(), mem(20), procs(), 0, cfg, SELF, PANE);
    expect(first.action?.signal).toBe("SIGKILL");
    expect(decide(first.state, mem(20), without(700), 100, cfg, SELF, PANE).action).toBeNull();
  });

  test("memory back above TERM ends the settle early", () => {
    const first = decide(initialState(), mem(50), procs(), 0, cfg, SELF, PANE);
    const gone = decide(first.state, mem(50), without(700), 100, cfg, SELF, PANE);
    const recovered = decide(gone.state, mem(200), without(700), 200, cfg, SELF, PANE);
    expect(recovered.action).toBeNull();
    expect(decide(recovered.state, mem(50), without(700), 300, cfg, SELF, PANE).action).toMatchObject({
      signal: "SIGTERM",
      victim: { pid: 800 }, // vitest 1200 < half of python3 2500: the prefer bound yields
    });
  });

  test("a recycled pid (same pid, new starttime) counts as the victim gone: settle, then the next one", () => {
    const first = decide(initialState(), mem(50), procs(), 0, cfg, SELF, PANE);
    const reused = readProcs(
      procTree(STUDIO.map((p) => (p.pid === 700 ? { ...p, start: 999999, rssMiB: 1 } : p))),
    );
    const gone = decide(first.state, mem(50), reused, 100, cfg, SELF, PANE);
    expect(gone.action).toBeNull();
    expect(decide(gone.state, mem(50), reused, 1100, cfg, SELF, PANE).action).toMatchObject({
      signal: "SIGTERM",
      victim: { pid: 800 }, // vitest 1200 < half of python3 2500: the prefer bound yields
    });
  });

  test("no victim qualifies: no signal, noVictim reported ONCE per low episode", () => {
    const small = readProcs(procTree(STUDIO.filter((p) => [1, 40, SELF, 100, 150, 200, 500].includes(p.pid)).map(
      (p) => (p.pid === 500 ? { ...p, rssMiB: 10 } : p),
    )));
    const a = decide(initialState(), mem(50), small, 0, cfg, SELF, PANE);
    expect(a.action).toBeNull();
    expect(a.noVictim).toBe(true);
    const b = decide(a.state, mem(50), small, 100, cfg, SELF, PANE);
    expect(b.action).toBeNull();
    expect(b.noVictim).toBe(false);
    const up = decide(b.state, mem(200), small, 200, cfg, SELF, PANE);
    expect(decide(up.state, mem(50), small, 300, cfg, SELF, PANE).noVictim).toBe(true);
  });

  test("#238: a nested `claude -p` big enough is an ordinary victim once it is the largest open process", () => {
    const withNested = readProcs(
      procTree([...STUDIO, { pid: 250, comm: "claude", argv: ["claude", "-p", "x"], rssMiB: 9000, ppid: 200 }]),
    );
    expect(decide(initialState(), mem(50), withNested, 0, cfg, SELF, PANE).action).toMatchObject({
      signal: "SIGTERM",
      victim: { pid: 250 },
    });
  });
});

describe("step — the loop tick (gate + decide)", () => {
  const cfg: GuardConfig = { termPct: 6, killPct: 3, graceMs: 5000, minVictimMiB: FLOOR, settleMs: 1000, recoverMiB: 64 };
  const ticks = { intervalMs: 500, fastIntervalMs: 100 };
  const mem = (availMiB: number) => ({ availMiB, totalMiB: 1000, source: "cgroup" as const });
  // Only protected processes and small ones: nothing qualifies as a victim.
  const small = () =>
    readProcs(procTree(STUDIO.filter((p) => [1, 40, SELF, 100, 150, 200, 500].includes(p.pid)).map(
      (p) => (p.pid === 500 ? { ...p, rssMiB: 10 } : p),
    )));

  test("NO_VICTIM once per EPISODE: two low episodes with a recovery between log twice", () => {
    const procs = small();
    let state = initialState();
    const logged: number[] = [];
    for (const [avail, now] of [[50, 0], [50, 500], [200, 1000], [200, 1500], [50, 2000], [50, 2500]]) {
      const r = step(state, mem(avail), () => procs, now, cfg, ticks, SELF, PANE);
      state = r.state;
      if (r.noVictim) logged.push(now);
    }
    expect(logged).toEqual([0, 2000]);
  });

  // #242: the TERM line is 60 MiB here (6% of 1000), recovery 60 + 64 = 124.
  const run = (seq: number[]) => {
    const procs = small();
    let state = initialState();
    const logged: number[] = [];
    seq.forEach((avail, i) => {
      const r = step(state, mem(avail), () => procs, i * 500, cfg, ticks, SELF, PANE);
      state = r.state;
      if (r.noVictim) logged.push(i * 500);
    });
    return logged;
  };

  test("#242: a boundary flapping across the TERM line for a 90 s hold logs exactly ONE NO_VICTIM", () => {
    // Measured by the #189 reviewer: one 90 s hold logged 3 lines, every
    // reading within 31 MiB of the line. 180 ticks, never 64 MiB above it.
    const flap = [40, 75, 45, 88, 50, 62, 58, 91, 44, 70];
    const seq = Array.from({ length: 180 }, (_, i) => flap[i % flap.length]);
    expect(run(seq)).toHaveLength(1);
  });

  test("#242: a REAL recovery (TERM + 64 MiB) then a second spell logs two", () => {
    const seq = [...Array(20).fill(45), ...Array(6).fill(200), ...Array(20).fill(45)];
    expect(run(seq)).toEqual([0, 26 * 500]);
  });

  test("#242: back just above the line but under the margin is the SAME episode", () => {
    const seq = [...Array(10).fill(45), ...Array(10).fill(123), ...Array(10).fill(45)];
    expect(run(seq)).toEqual([0]);
  });

  test("a healthy tick with nothing to finish does not scan /proc", () => {
    let scans = 0;
    const r = step(initialState(), mem(200), () => { scans++; return []; }, 0, cfg, ticks, SELF, PANE);
    expect(scans).toBe(0);
    expect(r.nextMs).toBe(500);
  });

  test("#238: step also treats a nested `claude -p` as an ordinary, killable candidate", () => {
    const withNested = () =>
      readProcs(procTree([...STUDIO, { pid: 250, comm: "claude", argv: ["claude", "-p", "x"], rssMiB: 9000, ppid: 200 }]));
    const r = step(initialState(), mem(50), withNested, 0, cfg, ticks, SELF, PANE);
    expect(r.action).toMatchObject({ signal: "SIGTERM", victim: { pid: 250 } });
  });
});

describe("nextTickMs", () => {
  const cfg = { intervalMs: 500, fastIntervalMs: 100 };
  test("500 ms when healthy, 100 ms while low, a victim is pending, or settling", () => {
    expect(nextTickMs(false, initialState(), 0, cfg)).toBe(500);
    expect(nextTickMs(true, initialState(), 0, cfg)).toBe(100);
    expect(nextTickMs(false, { ...initialState(), pending: { pid: 1, start: 1, termAt: 0 } }, 0, cfg)).toBe(100);
    expect(nextTickMs(false, { ...initialState(), settleUntil: 1000 }, 500, cfg)).toBe(100);
  });

  test("slow while NO_VICTIM holds (low, nothing killable, nothing pending or settling)", () => {
    // Review round 2: 100 ms full scans with nothing to kill cost 20% of a core at 386 processes.
    const stuck = { ...initialState(), noVictimLogged: true };
    expect(nextTickMs(true, stuck, 0, cfg)).toBe(500);
    expect(nextTickMs(true, { ...stuck, pending: { pid: 1, start: 1, termAt: 0 } }, 0, cfg)).toBe(100);
    expect(nextTickMs(true, { ...stuck, settleUntil: 1000 }, 500, cfg)).toBe(100);
  });
});

describe("formatLogLine", () => {
  const victim: Proc = {
    pid: 700,
    ppid: 200,
    comm: "node",
    argv: ["node", "/w/node_modules/.bin/vite", "build", "x".repeat(300)],
    rssKiB: 2100 * 1024,
    adj: 500,
    start: 1,
  };
  const m = { availMiB: 640, totalMiB: 11930, source: "meminfo" as const };

  test("one line: ISO ts, signal, pid, comm, rss MiB, avail MiB, cmdline head", () => {
    const line = formatLogLine(new Date("2026-09-24T18:45:00Z"), "SIGTERM", victim, m);
    expect(line).toStartWith(
      "2026-09-24T18:45:00.000Z SIGTERM pid=700 comm=node rss_mib=2100 avail_mib=640 total_mib=11930 source=meminfo cmd=node /w/node_modules/.bin/vite build x",
    );
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(400);
  });

  test("the cmd field is redacted: no token body survives", () => {
    const line = formatLogLine(new Date(0), "SIGKILL", {
      ...victim,
      argv: ["tailscale", "up", "--authkey=tskey-auth-kXyZ12CNTRL-abcdefGHIJ2345", "--hostname=x"],
    }, m);
    expect(line).not.toContain("kXyZ12CNTRL");
    expect(line).toContain("«redacted»");
  });
});

describe("redact — the same shapes src/studio/redact.ts covers", () => {
  const SPECIMENS = [
    "git clone https://x-access-token:ghs_AbC123deadbeefZZ@github.com/rafarc21/fleetflare.git failed",
    "remote: Invalid credentials github_pat_11ABCDEFG0aBcDeFgHiJk_lMnOpQrStUvWxYz0123456789",
    "classic token ghp_0123456789abcdefGHIJ and oauth gho_zzzz1111 and user ghu_qqqq2222 and refresh ghr_wwww3333",
    "tailscale up --authkey=tskey-auth-kXyZ12CNTRL-abcdefGHIJ2345 --hostname=acme-os--release-studio",
    "ANTHROPIC error with sk-ant-oat01-AbCd_eF-gHiJkLmNoP0123456789 in the message",
    "spawn auth fsp_0123456789abcdef rejected",
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' https://api.github.com",
  ].join("\n");

  test("agrees with redactSecrets, shape for shape", () => {
    expect(redact(SPECIMENS)).toBe(redactSecrets(SPECIMENS));
    expect(redact(SPECIMENS)).not.toBe(SPECIMENS);
  });
});

describe("trimLog", () => {
  test("keeps only the last N lines; a short or missing file is left alone", () => {
    const d = tmp();
    const p = join(d, "memguard.log");
    writeFileSync(p, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    trimLog(p, 4000);
    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(4000);
    expect(lines[0]).toBe("line 1000");
    expect(lines[3999]).toBe("line 4999");
    trimLog(p, 4000);
    expect(readFileSync(p, "utf8").trimEnd().split("\n")).toHaveLength(4000);
    expect(() => trimLog(join(d, "nope.log"), 4000)).not.toThrow();
  });
});

describe("resolveLeadParentPid — #238, tmux display-message for the pane shell's pid", () => {
  test("parses the numeric pid from a successful display-message", () => {
    const run = () => ({ status: 0, stdout: "4242\n" });
    expect(resolveLeadParentPid(run)).toBe(4242);
  });

  test("a non-zero exit (tmux missing, socket/session/window not up yet) resolves null", () => {
    const run = () => ({ status: 1, stdout: "" });
    expect(resolveLeadParentPid(run)).toBeNull();
  });

  test("non-numeric stdout resolves null rather than throwing", () => {
    const run = () => ({ status: 0, stdout: "no server running on socket\n" });
    expect(resolveLeadParentPid(run)).toBeNull();
  });

  test("a run function that throws (spawnSync timeout, ENOENT) resolves null, never throws", () => {
    const run = () => {
      throw new Error("boom");
    };
    expect(() => resolveLeadParentPid(run)).not.toThrow();
    expect(resolveLeadParentPid(run)).toBeNull();
  });

  test("calls tmux with the exact fleet-studio socket and studio:claude pane-pid idiom", () => {
    const seen: { args: string[] | null } = { args: null };
    const run = (args: string[]) => {
      seen.args = args;
      return { status: 0, stdout: "1\n" };
    };
    resolveLeadParentPid(run);
    expect(seen.args).toEqual(["-L", "fleet-studio", "display-message", "-p", "-t", "studio:claude", "#{pane_pid}"]);
  });
});

describe("refreshLeadParentPid — #270 round 2: a failed refresh must clear a stale pid, not keep it", () => {
  test("a successful resolution replaces the cached value outright", () => {
    expect(refreshLeadParentPid(null, 4242)).toBe(4242);
    expect(refreshLeadParentPid(1111, 4242)).toBe(4242);
  });

  test("a FAILED resolution (resolved=null) clears a previously known-good pid to null", () => {
    expect(refreshLeadParentPid(4242, null)).toBeNull();
  });

  test("two failures in a row stay null, not stuck non-null", () => {
    expect(refreshLeadParentPid(refreshLeadParentPid(4242, null), null)).toBeNull();
  });

  test("end-to-end: after a failed refresh, a relaunched lead under a NEW pane is protected via broad fallback -- the stale pid would have missed it", () => {
    const relaunchedLead = readProcs(procTree([{ pid: 250, comm: "claude", argv: ["claude"], rssMiB: 100, ppid: 777 }]))[0];
    const stale = PANE; // leadParentPid was resolved to the OLD pane (150) before it respawned to 777.
    // The danger this fix closes: keeping the stale pid narrows protection
    // around a pane that no longer exists, so the REAL lead reads as an
    // ordinary, killable process.
    expect(isProtected(relaunchedLead, SELF, stale)).toBe(false);
    // The fix: a failed refresh resets leadParentPid to null, and isProtected's
    // own fail-safe rule protects every claude-named process while unresolved.
    const afterFailedRefresh = refreshLeadParentPid(stale, null);
    expect(isProtected(relaunchedLead, SELF, afterFailedRefresh)).toBe(true);
  });
});
