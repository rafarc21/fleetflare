// container/memguard.ts — the loop half of the former memguard-select.test.ts
// (sweep-35 F1, issue #794): escalation, tick, lead-parent resolution and
// the log format. Pure selection lives in memguard-select-core.test.ts; the
// live behaviour (a real hog, a real cgroup limit) in test/bun/memguard-docker.test.ts.
// Against FIXTURE /proc and cgroup trees (issue #169) — never the real /proc.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decide,
  formatLogLine,
  initialState,
  isProtected,
  nextTickMs,
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
