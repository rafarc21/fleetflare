// container/memguard.ts — the createGuard interface (issue #324, sweep 2 F9).
//
// The pure selection fns this module exports are its internals leaked as
// interface (17 of 18 exports test-only); the REAL loop lived untested in
// main() (only memguard-docker.test.ts exercises it, skipped without Docker).
// These tests drive the tick loop through a fake io port instead: /proc
// reads, kills, adj writes and log lines all scripted, no container, no
// Docker. The adj pass itself still reads a fixture /proc tree (adjScan's
// own file seam) — the one thing these fakes build on disk, exactly like
// memguard-select.test.ts's fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuard, type GuardConfig, type GuardIo, type Memory, type Proc } from "../../container/memguard";

// --- fixtures ---------------------------------------------------------------

const SELF = 50;
const T0 = 1_000_000; // big enough that the first tick always runs the adj pass

function proc(p: { pid: number; comm: string; argv: string[]; rssMiB: number; adj?: number; start?: number; ppid?: number }): Proc {
  return {
    pid: p.pid,
    ppid: p.ppid ?? 1,
    comm: p.comm,
    argv: p.argv,
    rssKiB: p.rssMiB * 1024,
    adj: p.adj ?? 0,
    start: p.start ?? 1000 + p.pid,
  };
}

/** A whole studio, same shape as memguard-select's STUDIO fixture: protected
 *  core, THE lead under the pane shell, two gates and one ordinary hog. */
function cast(): Proc[] {
  return [
    proc({ pid: 1, comm: "sandbox", argv: ["/container-server/sandbox"], rssMiB: 4000, ppid: 0 }),
    proc({ pid: 40, comm: "flock", argv: ["flock", "-n", "/run/fleet-memguard.lock", "bun", "/opt/fleet/memguard.ts"], rssMiB: 1, ppid: 1 }),
    proc({ pid: SELF, comm: "bun", argv: ["bun", "/opt/fleet/memguard.ts"], rssMiB: 9000, ppid: 40 }),
    proc({ pid: 100, comm: "tmux: server", argv: ["tmux", "new-session", "-d", "-s", "studio"], rssMiB: 5000, ppid: 1 }),
    proc({ pid: 150, comm: "bash", argv: ["bash"], rssMiB: 5, ppid: 100 }),
    proc({ pid: 200, comm: "claude", argv: ["claude", "--dangerously-skip-permissions"], rssMiB: 3000, ppid: 150 }),
    proc({ pid: 300, comm: "tailscaled", argv: ["tailscaled", "--tun=userspace-networking"], rssMiB: 6000, ppid: 1 }),
    proc({ pid: 400, comm: "sshd", argv: ["sshd: root@pts/0"], rssMiB: 7000, ppid: 1 }),
    proc({ pid: 500, comm: "bash", argv: ["bash"], rssMiB: 800, ppid: 1 }),
    proc({ pid: 700, comm: "node", argv: ["node", "/w/node_modules/.bin/vite", "build"], rssMiB: 2100, ppid: 200 }),
    proc({ pid: 800, comm: "python3", argv: ["python3", "big.py"], rssMiB: 2500, ppid: 1 }),
  ];
}

const dirs: string[] = [];
function tmpTree(): string {
  const d = mkdtempSync(join(tmpdir(), "memguard-guard-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A /proc-shaped tree for the adj pass (adjScan's own file seam). */
function writeTree(root: string, procs: Proc[]): void {
  for (const p of procs) {
    const d = join(root, String(p.pid));
    mkdirSync(d);
    writeFileSync(join(d, "comm"), `${p.comm}\n`);
    writeFileSync(join(d, "cmdline"), p.argv.join("\0") + "\0");
    writeFileSync(join(d, "status"), `Name:\t${p.comm}\nVmRSS:\t${p.rssKiB} kB\n`);
    const fields = ["S", String(p.ppid), ...Array(17).fill("0"), String(p.start)];
    writeFileSync(join(d, "stat"), `${p.pid} (${p.comm}) ${fields.join(" ")}\n`);
    writeFileSync(join(d, "oom_score_adj"), `${p.adj}\n`);
  }
}

// --- the fake io port --------------------------------------------------------

interface Scripted {
  mem: Memory;
  procs: Proc[];
  leadParentPid?: number | null;
}

/** Every port scripted: one readMemory per tick walks the script (last entry
 *  repeats), kills and adj plans and log lines recorded, `killThrows`
 *  simulates a victim that exited between the scan and the signal. */
function fakeIo(script: Scripted[]): GuardIo & {
  kills: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }>;
  adjLog: Array<Array<{ pid: number; adj: number }>>;
  lines: string[];
  killThrows: Set<number>;
} {
  let i = -1;
  const out = {
    kills: [] as Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }>,
    adjLog: [] as Array<Array<{ pid: number; adj: number }>>,
    lines: [] as string[],
    killThrows: new Set<number>(),
    readProcs: (): Proc[] => script[i].procs,
    readMemory: (): Memory => {
      i = Math.min(i + 1, script.length - 1);
      return script[i].mem;
    },
    resolveLeadParentPid: (): number | null => script[i].leadParentPid ?? 150,
    kill: (pid: number, signal: "SIGTERM" | "SIGKILL"): void => {
      out.kills.push({ pid, signal });
      if (out.killThrows.has(pid)) throw new Error(`process ${pid} already exited`);
    },
    setAdj: (plan: Array<{ pid: number; adj: number }>): void => {
      out.adjLog.push(plan);
    },
    log: (line: string): void => {
      out.lines.push(line);
    },
  };
  return out;
}

// --- the guard under test -----------------------------------------------------

const CFG: GuardConfig = { termPct: 6, killPct: 3, graceMs: 5000, minVictimMiB: 64, settleMs: 1000, recoverMiB: 64 };
const TICKS = { intervalMs: 500, fastIntervalMs: 100 };

function guard(io: GuardIo, tree: string) {
  return createGuard(io, CFG, { selfPid: SELF, procRoot: tree, ticks: TICKS, adjEveryMs: 5000 });
}

const mem = (availMiB: number): Memory => ({ availMiB, totalMiB: 1000, source: "cgroup" });

describe("createGuard — the tick interface (issue #324)", () => {
  test("healthy: adj pass on the first tick, then no scan, no kill, no log, slow cadence", () => {
    const tree = tmpTree();
    writeTree(tree, cast());
    const io = fakeIo([{ mem: mem(500), procs: cast() }]);
    const g = guard(io, tree);
    const r = g.tick(T0);
    expect(io.kills).toEqual([]);
    expect(io.lines).toEqual([]);
    expect(io.adjLog).toHaveLength(1);
    // The lead is pinned at -1000; a gate is raised to +500 (the inherited-adj trap).
    expect(io.adjLog[0].find((e) => e.pid === 200)?.adj).toBe(-1000);
    expect(io.adjLog[0].find((e) => e.pid === 700)?.adj).toBe(500);
    expect(r.nextMs).toBe(500);
    g.tick(T0 + 500); // 500 < 5000: no second adj pass
    expect(io.adjLog).toHaveLength(1);
  });

  test("below TERM: SIGTERMs the preferred gate, one log line, fast cadence", () => {
    const io = fakeIo([{ mem: mem(50), procs: cast() }]);
    const g = guard(io, tmpTree());
    const r = g.tick(T0);
    expect(io.kills).toEqual([{ pid: 700, signal: "SIGTERM" }]);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toContain(
      "SIGTERM pid=700 comm=node rss_mib=2100 avail_mib=50 total_mib=1000 source=cgroup cmd=node /w/node_modules/.bin/vite build",
    );
    expect(r.nextMs).toBe(100);
  });

  test("victim still alive after the grace: SIGKILLs the SAME victim", () => {
    const io = fakeIo([
      { mem: mem(50), procs: cast() },
      { mem: mem(50), procs: cast() },
    ]);
    const g = guard(io, tmpTree());
    g.tick(T0);
    const r = g.tick(T0 + 5001);
    expect(io.kills).toEqual([
      { pid: 700, signal: "SIGTERM" },
      { pid: 700, signal: "SIGKILL" },
    ]);
    expect(io.lines[1]).toContain("SIGKILL pid=700");
    expect(r.nextMs).toBe(100);
  });

  test("victim gone: settles before choosing the next", () => {
    const without700 = () => cast().filter((p) => p.pid !== 700);
    const io = fakeIo([
      { mem: mem(50), procs: cast() },
      { mem: mem(50), procs: without700() },
      { mem: mem(50), procs: without700() },
      { mem: mem(50), procs: without700() },
    ]);
    const g = guard(io, tmpTree());
    g.tick(T0); // SIGTERM 700
    const mid = g.tick(T0 + 100); // victim gone: settle, no new pick
    expect(io.kills).toHaveLength(1);
    expect(mid.nextMs).toBe(100);
    g.tick(T0 + 1000); // still settling (settleUntil = T0 + 1100)
    expect(io.kills).toHaveLength(1);
    g.tick(T0 + 1100); // settle elapsed: next pick is python3, the largest open
    expect(io.kills[1]).toEqual({ pid: 800, signal: "SIGTERM" });
  });

  test("kill() throws (victim exited between scan and signal): silent settle, no log line", () => {
    const without700 = () => cast().filter((p) => p.pid !== 700);
    const io = fakeIo([
      { mem: mem(50), procs: cast() },
      { mem: mem(50), procs: without700() },
      { mem: mem(50), procs: without700() },
      { mem: mem(50), procs: without700() },
    ]);
    io.killThrows.add(700);
    const g = guard(io, tmpTree());
    g.tick(T0); // kill attempted on 700, throws: settle as if it had died
    expect(io.kills).toEqual([{ pid: 700, signal: "SIGTERM" }]); // the attempt is recorded
    expect(io.lines).toEqual([]); // no SIGTERM line for a failed signal
    g.tick(T0 + 100); // settling (settleUntil = T0 + 1000)
    expect(io.kills).toHaveLength(1);
    g.tick(T0 + 1100); // settle elapsed: the next pick
    expect(io.kills[1]).toEqual({ pid: 800, signal: "SIGTERM" });
    expect(io.lines).toHaveLength(1);
  });

  test("lead pid changes mid-run: protection follows the relaunch", () => {
    const tree = tmpTree();
    // Old world: the lead (200) sits under pane shell 150 and is the biggest
    // process in the tree.
    const oldWorld = cast().map((p) => (p.pid === 200 ? { ...p, rssKiB: 9000 * 1024 } : p));
    writeTree(tree, oldWorld);
    // The pane respawns: a NEW lead (201) under a NEW pane shell (999); the
    // old lead is gone entirely.
    const newLead = proc({ pid: 201, comm: "claude", argv: ["claude", "--continue"], rssMiB: 9000, ppid: 999, start: 2001 });
    const newPane = proc({ pid: 999, comm: "bash", argv: ["bash"], rssMiB: 5, ppid: 998 });
    const newWorld = oldWorld.filter((p) => p.pid !== 200).concat([newLead, newPane]);
    const gone700 = newWorld.filter((p) => p.pid !== 700);
    const io = fakeIo([
      { mem: mem(50), procs: oldWorld, leadParentPid: 150 },
      { mem: mem(500), procs: newWorld, leadParentPid: 999 },
      { mem: mem(50), procs: gone700, leadParentPid: 999 },
      { mem: mem(50), procs: gone700, leadParentPid: 999 },
    ]);
    const g = guard(io, tree);
    g.tick(T0); // adj #1 reads the old tree; the huge OLD lead is protected
    expect(io.kills).toEqual([{ pid: 700, signal: "SIGTERM" }]);
    // Rewrite the tree the adj pass reads, then let the adj cadence fire.
    rmSync(join(tree, "200"), { recursive: true });
    writeTree(tree, [newLead, newPane]);
    g.tick(T0 + 5000); // adj #2: leadParentPid changed -> cache invalidated, all re-read
    // Both adj writes go through setAdj (the periodic scan pass AND the
    // per-scan plan — exactly the two applyAdj calls main() made), so take
    // the LAST write per pid across every plan this tick saw: the final
    // oom_score_adj state, not "the second plan".
    const last = (pid: number) => {
      const writes = io.adjLog.flat().filter((e) => e.pid === pid);
      return writes[writes.length - 1]?.adj;
    };
    expect(last(201)).toBe(-1000); // the NEW lead is pinned
    expect(last(999)).toBe(-1000); // and its pane shell with it
    expect(last(150)).toBe(500); // the OLD pane shell: protection followed
    expect(io.kills).toHaveLength(1); // mem healthy: no escalation this tick
    g.tick(T0 + 5100); // low again, victim 700 gone: settle
    expect(io.kills).toHaveLength(1);
    g.tick(T0 + 6200); // settle elapsed: the pick must never be the new lead
    expect(io.kills[1]).toEqual({ pid: 800, signal: "SIGTERM" });
    expect(io.kills.some((k) => k.pid === 200 || k.pid === 201)).toBe(false);
  });

  test("NO_VICTIM once per low episode, a second line only after a real recovery", () => {
    const small = cast()
      .filter((p) => p.pid !== 700 && p.pid !== 800)
      .map((p) => (p.pid === 500 ? { ...p, rssKiB: 10 * 1024 } : p)); // under the 64 floor: nothing killable
    const io = fakeIo([
      { mem: mem(50), procs: small },
      { mem: mem(50), procs: small },
      { mem: mem(200), procs: small },
      { mem: mem(200), procs: small },
      { mem: mem(50), procs: small },
    ]);
    const g = guard(io, tmpTree());
    g.tick(T0); // low, nothing killable: NO_VICTIM
    g.tick(T0 + 500); // still low: same episode, no second line
    g.tick(T0 + 1000); // recovered (200 >= 60 + 64): the episode ends
    g.tick(T0 + 1500);
    g.tick(T0 + 2000); // low again: a NEW episode logs its own line
    expect(io.lines).toHaveLength(2);
    expect(io.lines[0]).toContain("NO_VICTIM avail_mib=50 total_mib=1000 source=cgroup");
    expect(io.lines[1]).toContain("NO_VICTIM avail_mib=50 total_mib=1000 source=cgroup");
  });

  test("adj cadence: first tick, then only every adjEveryMs", () => {
    const io = fakeIo([{ mem: mem(500), procs: cast() }]);
    const g = guard(io, tmpTree());
    g.tick(T0); // first tick: adj runs (lastAdj starts at 0)
    expect(io.adjLog).toHaveLength(1);
    g.tick(T0 + 500); // 500 < 5000: no pass
    expect(io.adjLog).toHaveLength(1);
    g.tick(T0 + 5100); // 5100 >= 5000: pass
    expect(io.adjLog).toHaveLength(2);
  });
});
