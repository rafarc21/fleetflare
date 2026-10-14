// container/memguard.ts — victim selection and memory source,
// against FIXTURE /proc and cgroup trees (issue #169).
//
// Every function under test takes its roots as arguments, so none of this
// touches the real /proc of the machine running the suite. The live behaviour
// (a real hog, a real cgroup limit) is test/bun/memguard-docker.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjPlan,
  adjScan,
  isProtected,
  newAdjCache,
  pickVictim,
  protectedSet,
  readMemory,
  readProcs,
} from "../../container/memguard";

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

