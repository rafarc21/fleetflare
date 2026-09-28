#!/usr/bin/env bun
// Studio memory guard (issue #169). Started by studio-bringup.sh's
// `memguard-start` region, one instance per container (flock).
//
// WHY. Measured 2026-09-24: a studio container at its memory cap (11.65 GiB
// standard-4) gets NO kernel OOM kill. It thrashes for good; 211 of 212 DO
// alarm kills since 09-23 trace here. The driver is parallel heavy gates in
// member worktrees (vitest, vite builds, bun test lanes, chrome). This loop
// frees memory BEFORE the ceiling: below MEMGUARD_TERM_PCT available it
// SIGTERMs the largest gate, SIGKILLs it after MEMGUARD_GRACE_MS or below
// MEMGUARD_KILL_PCT.
//
// WHY NOT earlyoom (jammy ships 1.6.2): it reads /proc/meminfo only, so under
// a cgroup limit (docker --memory, the test harness) it sees the host's free
// memory and never fires; its --avoid only shifts a badness score, it cannot
// promise the lead survives; and it does nothing about the inherited
// oom_score_adj trap below.
//
// PROTECTED, never signalled: PID 1 (sandbox control server) and its executor
// pool (argv under /container-server/), this process, tmux server, THE lead,
// tailscaled, sshd -- AND every ancestor of those (the lead's pane shell,
// this guard's flock parent).
//
// #238: "the lead" narrowed. Matching every claude-named process by NAME
// alone (the pre-#238 rule) pinned a NESTED `claude -p` subprocess the lead
// itself spawned, and a stale/orphaned relaunch (#67) that never attached to
// any pane, with the same -1000 immunity as the real lead -- measured: a
// runaway gate under a claude-named CHILD was immune (the child's ancestor
// walk pulled the gate in too), and separately the kernel's own OOM killer
// picked `gh` while a 1.8 GiB claude-named LEAK sat immune nearby. THE lead is
// now the one claude-named process whose PARENT is the pane shell tmux
// spawned for studio:claude (resolveLeadParentPid, below) -- everything else
// merely named claude is an ordinary candidate. A relaunched lead is still
// protected the moment it exists, because it still execs under that same
// pane shell.
//
// NEVER A SMALL VICTIM. Only a process of at least MEMGUARD_MIN_VICTIM_MIB is
// ever signalled: killing a 3 MiB shell frees nothing and can take the lead
// with it (PR #189 review: a claude-named leak the guard cannot relieve made
// it walk down the process table). Nothing big enough -> no signal, one
// NO_VICTIM line per low episode. An episode ends only when available memory
// is MEMGUARD_RECOVER_MIB (64) above the TERM line, not on every crossing.
//
// ONE VICTIM AT A TIME. After a victim exits its memory takes a moment to
// return; the guard picks no next victim for MEMGUARD_SETTLE_MS unless memory
// recovers first. While memory is low (and something is killable) or a victim
// is pending or settling it ticks every MEMGUARD_FAST_INTERVAL_MS (100 ms),
// else every MEMGUARD_INTERVAL_MS.
//
// THE TRAP. oom_score_adj is inherited across fork. Pinning the lead at -1000
// makes every gate it spawns -1000 too, and a kernel OOM (if one ever fires)
// then has nothing to pick. So every scan re-pins protected processes at -1000
// AND raises every other process to +500.
//
// Log: one line per signal to MEMGUARD_LOG (default
// ${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log, next to bringup.log),
// cmd redacted, trimmed to its last LOG_MAX_LINES at every start.
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Proc {
  pid: number;
  comm: string;
  argv: string[];
  rssKiB: number;
  adj: number;
  start: number;
  ppid: number;
}

export interface Memory {
  availMiB: number;
  totalMiB: number;
  source: "cgroup" | "meminfo";
}

export interface GuardConfig {
  termPct: number;
  killPct: number;
  graceMs: number;
  minVictimMiB: number;
  settleMs: number;
  /** #242: a low episode ends only once available memory is this far ABOVE the TERM line. */
  recoverMiB: number;
}

export type Signal = "SIGTERM" | "SIGKILL";

export interface GuardState {
  /** The victim signalled last, until it is gone. `at` = when it was signalled. */
  pending: { pid: number; start: number; termAt: number; killed?: boolean } | null;
  /** No new victim before this time: the last one's memory is draining. */
  settleUntil: number | null;
  /** NO_VICTIM already logged in this low episode. */
  noVictimLogged: boolean;
}

// "claude" is deliberately NOT here (#238): matching it by comm alone would
// protect every claude-named process regardless of ancestry, exactly the
// over-broad rule isProtected narrows below.
const PROTECTED_COMM = new Set(["tmux: server", "tailscaled", "sshd"]);
const PREFER = /vitest|vite|bun test|esbuild|chrom|playwright|node|tsc|jest/;
const PROTECTED_ADJ = -1000;
const RAISED_ADJ = 500;
const LOG_MAX_LINES = 4000;

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export function readProc(procRoot: string, pid: number): Proc | null {
  const dir = `${procRoot}/${pid}`;
  const cmdline = read(`${dir}/cmdline`);
  const status = read(`${dir}/status`);
  const stat = read(`${dir}/stat`);
  const comm = read(`${dir}/comm`);
  if (!cmdline || status === null || stat === null || comm === null) return null; // kernel thread or exited
  const rss = /^VmRSS:\s+(\d+)/m.exec(status);
  const statTail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return {
    pid,
    comm: comm.replace(/\n$/, ""),
    argv: cmdline.replace(/\0$/, "").split("\0"),
    rssKiB: rss ? Number(rss[1]) : 0,
    adj: Number(read(`${dir}/oom_score_adj`) ?? 0),
    start: Number(statTail[19]),
    ppid: Number(statTail[1]),
  };
}

function pids(procRoot: string): number[] {
  return readdirSync(procRoot).filter((n) => /^\d+$/.test(n)).map(Number);
}

export function readProcs(procRoot: string): Proc[] {
  const out: Proc[] = [];
  for (const pid of pids(procRoot)) {
    const p = readProc(procRoot, pid);
    if (p) out.push(p);
  }
  return out;
}

export type RunTmux = (args: string[], timeoutMs: number) => { status: number | null; stdout: string };

// Generous but bounded (issue #238): a few hundred ms is nothing next to the
// ADJ_INTERVAL_MS cadence this is called on, but this must never hang the
// guard's own tick loop waiting on a wedged or missing tmux.
const TMUX_TIMEOUT_MS = 300;

function spawnTmux(args: string[], timeoutMs: number): { status: number | null; stdout: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8", timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout ?? "" };
}

/**
 * #238: the pid of the pane shell tmux holds for studio:claude on
 * `tmux -L fleet-studio` -- studio-bringup.sh's and studio-shell.sh's own
 * idiom for addressing that exact pane (grep both for `display-message`).
 * `run` is injected, matching every other function in this file: no hidden
 * I/O, so this is testable against a fake subprocess rather than a real
 * tmux/socket.
 *
 * Returns null on ANY failure -- tmux missing, the socket/session/window not
 * up yet (early in bring-up, or after a crash), a non-numeric answer, or a
 * timeout -- never throws, never hangs the caller.
 */
export function resolveLeadParentPid(run: RunTmux = spawnTmux, timeoutMs = TMUX_TIMEOUT_MS): number | null {
  let r: { status: number | null; stdout: string };
  try {
    r = run(["-L", "fleet-studio", "display-message", "-p", "-t", "studio:claude", "#{pane_pid}"], timeoutMs);
  } catch {
    return null;
  }
  if (r.status !== 0) return null;
  const pid = Number(r.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * #270 round 2: apply a fresh `resolveLeadParentPid()` result. A FAILED
 * resolution (`resolved === null`: tmux gone, a wedged socket, the 300 ms
 * timeout tripping under memory pressure) must REPLACE a previously
 * known-good pid with null, never keep it -- isProtected's doc comment below
 * already establishes that unresolved must fail toward the OLD broad rule
 * (protect every claude-named process), not stay narrow around a pid that
 * may now be stale. Concretely: if the pane respawns (studio-bringup.sh's
 * `respawn-pane -k`) WHILE a lookup happens to fail, the relaunched lead's
 * real parent is the NEW pane shell pid, which will never equal the stale
 * one -- keeping it would read the actual lead as unprotected while some
 * unrelated process that happens to reuse the stale pid (PID reuse over a
 * container's lifetime is real) gets wrongly protected instead.
 *
 * `previous` is accepted, not consulted, on purpose: it is what the buggy
 * shape this replaces (`resolved !== null ? resolved : previous`) reads, and
 * keeping it in the signature makes that regression expressible as a
 * one-line mutant against this exact function.
 */
export function refreshLeadParentPid(previous: number | null, resolved: number | null): number | null {
  return resolved;
}

/**
 * #238: `leadParentPid` is the pane shell's pid tmux holds for studio:claude
 * (resolveLeadParentPid, above) -- THE lead is the one claude-named process
 * whose ppid matches it. Unresolved (`null`: tmux not up yet, the query
 * failed or timed out) falls back to the OLD broad rule and protects EVERY
 * claude-named process, deliberately. A false negative here -- failing to
 * protect the REAL lead -- is catastrophic; a false positive -- still
 * protecting a nested `claude -p` a bit too generously while unresolved -- is
 * merely today's already-shipped, already-accepted behaviour.
 */
export function isProtected(p: Proc, selfPid: number, leadParentPid: number | null): boolean {
  if (p.pid === 1 || p.pid === selfPid) return true;
  if (PROTECTED_COMM.has(p.comm)) return true;
  if (p.argv.some((a) => a.includes("/container-server/"))) return true; // sandbox executor pool
  const claudeNamed = p.comm === "claude" || basename(p.argv[0] ?? "") === "claude";
  if (!claudeNamed) return false;
  if (leadParentPid === null) return true; // fail safe: see doc comment above
  return p.ppid === leadParentPid;
}

/** Protected processes plus every ancestor of one: killing the lead's pane
 *  shell (or this guard's flock parent) takes the protected child with it. */
export function protectedSet(procs: Proc[], selfPid: number, leadParentPid: number | null): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>();
  for (const p of procs) {
    if (!isProtected(p, selfPid, leadParentPid)) continue;
    let q: Proc | undefined = p;
    while (q && !out.has(q.pid)) {
      out.add(q.pid);
      q = byPid.get(q.ppid);
    }
  }
  return out;
}

/**
 * Largest RSS outside the protected set, at least `minVictimMiB`. A preferred
 * gate wins only while it is at least half the largest candidate -- a small
 * vitest worker is not worth sparing a 2 GiB runaway for.
 */
export function pickVictim(procs: Proc[], selfPid: number, leadParentPid: number | null, minVictimMiB: number): Proc | null {
  const prot = protectedSet(procs, selfPid, leadParentPid);
  const open = procs.filter((p) => !prot.has(p.pid) && p.rssKiB >= minVictimMiB * 1024);
  const largest = (ps: Proc[]) => ps.reduce<Proc | null>((a, p) => (!a || p.rssKiB > a.rssKiB ? p : a), null);
  const top = largest(open);
  if (!top) return null;
  const preferred = open.filter((p) => PREFER.test(p.argv.join(" ")) && p.rssKiB * 2 >= top.rssKiB);
  return largest(preferred) ?? top;
}

export function adjPlan(procs: Proc[], selfPid: number, leadParentPid: number | null): Array<{ pid: number; adj: number }> {
  const prot = protectedSet(procs, selfPid, leadParentPid);
  const plan: Array<{ pid: number; adj: number }> = [];
  for (const p of procs) {
    if (prot.has(p.pid)) {
      if (p.adj !== PROTECTED_ADJ) plan.push({ pid: p.pid, adj: PROTECTED_ADJ });
    } else if (p.adj < RAISED_ADJ) {
      plan.push({ pid: p.pid, adj: RAISED_ADJ });
    }
  }
  return plan;
}

/** adjScan's incremental state: pid -> comm as last seen, plus the
 *  leadParentPid that cache was built against (#270 round 2, see adjScan). */
export interface AdjCache {
  comm: Map<number, string>;
  leadParentPid: number | null;
}

export function newAdjCache(): AdjCache {
  return { comm: new Map(), leadParentPid: null };
}

/**
 * The periodic adj pass, incremental. Measured at 400 processes: a full
 * re-read of every pid every 2s cost 2.3-2.8% of a core; this pass every 5s
 * costs the guard 0.41% in total. Each known pid costs one read of its comm, and only new pids -- or pids whose comm changed, i.e.
 * that exec'd (bash -> claude on a lead relaunch) -- are read in full.
 * `cache.comm` maps pid -> comm as last seen.
 *
 * #270 round 2: a cached pid's comm not changing says nothing about whether
 * it still qualifies for protection -- that also depends on `leadParentPid`,
 * which can change underneath the cache (a pane respawn re-resolves it, or a
 * failed refresh resets it to null, #270 round 2's other fix). Without this
 * check, a process pinned at -1000 under the OLD leadParentPid would keep
 * that immunity, unexamined, until it next exec's or a full non-incremental
 * pass happens to run -- so a leadParentPid change forces one full re-check.
 */
export function adjScan(
  procRoot: string,
  cache: AdjCache,
  selfPid: number,
  leadParentPid: number | null,
): Array<{ pid: number; adj: number }> {
  if (cache.leadParentPid !== leadParentPid) {
    cache.comm.clear();
    cache.leadParentPid = leadParentPid;
  }
  const fresh: Proc[] = [];
  const live = new Set<number>();
  for (const pid of pids(procRoot)) {
    live.add(pid);
    const comm = read(`${procRoot}/${pid}/comm`);
    if (comm === null || cache.comm.get(pid) === comm) continue;
    cache.comm.set(pid, comm);
    const p = readProc(procRoot, pid);
    if (p) fresh.push(p);
  }
  for (const pid of cache.comm.keys()) if (!live.has(pid)) cache.comm.delete(pid);
  const plan = new Map(adjPlan(fresh, selfPid, leadParentPid).map((e) => [e.pid, e.adj]));
  // A new protected pid's ancestors may be cached (read long ago, raised to
  // +500): the pane shell a relaunched lead starts under. Walk up and pin them.
  const seen = new Set<number>();
  for (const p of fresh) {
    if (!isProtected(p, selfPid, leadParentPid)) continue;
    for (let pp = p.ppid; pp > 1 && !seen.has(pp); ) {
      seen.add(pp);
      const a = readProc(procRoot, pp);
      if (!a) break;
      if (a.adj !== PROTECTED_ADJ) plan.set(a.pid, PROTECTED_ADJ);
      else plan.delete(a.pid);
      pp = a.ppid;
    }
  }
  return [...plan].map(([pid, adj]) => ({ pid, adj }));
}

function kv(text: string, key: string): number | null {
  const m = new RegExp(`^${key}:?\\s+(\\d+)`, "m").exec(text);
  return m ? Number(m[1]) : null;
}

export function readMemory(procRoot: string, cgroupRoot: string): Memory {
  const max = read(`${cgroupRoot}/memory.max`)?.trim();
  const current = read(`${cgroupRoot}/memory.current`)?.trim();
  const meminfo = read(`${procRoot}/meminfo`) ?? "";
  const hostAvailKiB = kv(meminfo, "MemAvailable");
  if (max && max !== "max" && current) {
    // memory.current counts page cache; inactive_file is reclaimable, so
    // leaving it in would kill a build for writing files.
    const inactive = kv(read(`${cgroupRoot}/memory.stat`) ?? "", "inactive_file") ?? 0;
    const MiB = 1024 * 1024;
    const cgroupAvail = Math.floor((Number(max) - Number(current) + inactive) / MiB);
    // A limited cgroup inside a starved host is bounded by the host too.
    const hostAvail = hostAvailKiB === null ? Infinity : Math.floor(hostAvailKiB / 1024);
    return {
      availMiB: Math.min(cgroupAvail, hostAvail),
      totalMiB: Math.floor(Number(max) / MiB),
      source: "cgroup",
    };
  }
  return {
    availMiB: Math.floor((hostAvailKiB ?? 0) / 1024),
    totalMiB: Math.floor((kv(meminfo, "MemTotal") ?? 0) / 1024),
    source: "meminfo",
  };
}

export function initialState(): GuardState {
  return { pending: null, settleUntil: null, noVictimLogged: false };
}

/**
 * #242: the low episode is over -- available memory is back a margin above
 * the TERM line, not merely across it. The #189 reviewer measured one 90 s
 * hold logging NO_VICTIM 3 times, every reading within 31 MiB of the line: a
 * boundary that flaps is one spell, not many.
 */
function recovered(mem: Memory, cfg: GuardConfig): boolean {
  return mem.availMiB >= (mem.totalMiB * cfg.termPct) / 100 + cfg.recoverMiB;
}

/**
 * One tick. Pure: the caller sends the signal and writes the log.
 * Below termPct: SIGTERM the victim, then wait graceMs for it to exit.
 * Still alive after the grace, or below killPct: SIGKILL it. Once it is gone,
 * settle for settleMs before choosing another. `noVictim` is true on the one
 * tick per low episode where nothing qualified.
 */
export function decide(
  state: GuardState,
  mem: Memory,
  procs: Proc[],
  now: number,
  cfg: GuardConfig,
  selfPid: number,
  leadParentPid: number | null,
): { state: GuardState; action: { signal: Signal; victim: Proc } | null; noVictim: boolean } {
  const pct = (mem.availMiB / mem.totalMiB) * 100;
  const p = state.pending;
  const alive = p ? procs.find((q) => q.pid === p.pid && q.start === p.start) ?? null : null;
  const none = (s: GuardState) => ({ state: s, action: null, noVictim: false });
  if (pct >= cfg.termPct) {
    return none({ pending: alive ? p : null, settleUntil: null, noVictimLogged: state.noVictimLogged && !recovered(mem, cfg) });
  }
  // The victim is gone (or exiting: its /proc entry no longer reads). Its
  // memory may still be draining; settle before choosing the next.
  if (p && (!alive || (p.killed && now - p.termAt >= cfg.graceMs))) {
    return none({ ...state, pending: null, settleUntil: now + cfg.settleMs });
  }
  if (state.settleUntil !== null && now < state.settleUntil) return none(state);
  const s: GuardState = { ...state, settleUntil: null };
  const critical = pct < cfg.killPct;
  if (alive && p) {
    if (p.killed) return none(s);
    if (critical || now - p.termAt >= cfg.graceMs) {
      return { state: { ...s, pending: { ...p, termAt: now, killed: true } }, action: { signal: "SIGKILL", victim: alive }, noVictim: false };
    }
    return none(s);
  }
  const victim = pickVictim(procs, selfPid, leadParentPid, cfg.minVictimMiB);
  if (!victim) return { state: { ...s, noVictimLogged: true }, action: null, noVictim: !state.noVictimLogged };
  return {
    state: { ...s, pending: { pid: victim.pid, start: victim.start, termAt: now, killed: critical } },
    action: { signal: critical ? "SIGKILL" : "SIGTERM", victim },
    noVictim: false,
  };
}

/** Fast while there is something to watch; slow when healthy or when nothing can be killed. */
export function nextTickMs(
  low: boolean,
  state: GuardState,
  now: number,
  cfg: { intervalMs: number; fastIntervalMs: number },
): number {
  const settling = state.settleUntil !== null && now < state.settleUntil;
  if (state.pending || settling) return cfg.fastIntervalMs;
  // Low with nothing killable (NO_VICTIM holds): a 100 ms full scan finds the
  // same nothing, at 20% of a core with 386 processes (review round 2).
  return low && !state.noVictimLogged ? cfg.fastIntervalMs : cfg.intervalMs;
}

/**
 * One loop tick, pure but for `scan` (the full /proc read, called only when
 * needed). Returns what to signal, whether to log NO_VICTIM, the processes
 * it scanned (for the adj pass) and when to tick next.
 */
export function step(
  state: GuardState,
  mem: Memory,
  scan: () => Proc[],
  now: number,
  cfg: GuardConfig,
  ticks: { intervalMs: number; fastIntervalMs: number },
  selfPid: number,
  leadParentPid: number | null,
): {
  state: GuardState;
  action: { signal: Signal; victim: Proc } | null;
  noVictim: boolean;
  procs: Proc[] | null;
  nextMs: number;
} {
  const low = (mem.availMiB / mem.totalMiB) * 100 < cfg.termPct;
  // The full /proc scan (RSS for every pid) runs only under pressure.
  if (!(low || state.pending || state.settleUntil !== null)) {
    // Recovered: the low episode is over, so the next one logs its own
    // NO_VICTIM (review round 2: this reset used to need a decide() that a
    // healthy tick never ran). Only a margin above the line counts (#242).
    const next = state.noVictimLogged && recovered(mem, cfg) ? { ...state, noVictimLogged: false } : state;
    return { state: next, action: null, noVictim: false, procs: null, nextMs: nextTickMs(low, next, now, ticks) };
  }
  const procs = scan();
  const r = decide(state, mem, procs, now, cfg, selfPid, leadParentPid);
  return { ...r, procs, nextMs: nextTickMs(low, r.state, now, ticks) };
}

// Same seven shapes, same order, as src/studio/redact.ts's redactSecrets and
// studio-bringup.sh's bringup_redact; test/bun/memguard-select.test.ts pins
// the equivalence. Copied, not imported: this file ships alone in the image.
export function redact(s: string): string {
  return s
    .replace(/ghs_[A-Za-z0-9]+/g, "«redacted»")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "«redacted»")
    .replace(/gh[pour]_[A-Za-z0-9]+/g, "«redacted»")
    .replace(/tskey-auth-[A-Za-z0-9-]+/g, "«redacted»")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "«redacted»")
    .replace(/fsp_[0-9a-f]+/g, "«redacted»")
    .replace(/Bearer\s+\S+/gi, "Bearer «redacted»");
}

/** Keep the last `maxLines` lines. Never throws. */
export function trimLog(path: string, maxLines: number): void {
  const text = read(path);
  if (text === null) return;
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= maxLines) return;
  try {
    writeFileSync(path, lines.slice(-maxLines).join("\n") + "\n");
  } catch {
    // A guard that cannot trim still guards.
  }
}

export function formatLogLine(at: Date, signal: Signal, victim: Proc, mem: Memory): string {
  // Redact BEFORE the cut, so a token is matched whole.
  const cmd = redact(victim.argv.join(" ")).replace(/\s+/g, " ").slice(0, 200);
  return (
    `${at.toISOString()} ${signal} pid=${victim.pid} comm=${victim.comm} ` +
    `rss_mib=${Math.round(victim.rssKiB / 1024)} avail_mib=${mem.availMiB} total_mib=${mem.totalMiB} ` +
    `source=${mem.source} cmd=${cmd}`
  );
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

function main(): void {
  const cfg: GuardConfig = {
    termPct: num("MEMGUARD_TERM_PCT", 6),
    killPct: num("MEMGUARD_KILL_PCT", 3),
    graceMs: num("MEMGUARD_GRACE_MS", 5000),
    minVictimMiB: num("MEMGUARD_MIN_VICTIM_MIB", 64),
    settleMs: num("MEMGUARD_SETTLE_MS", 1000),
    recoverMiB: num("MEMGUARD_RECOVER_MIB", 64),
  };
  const ticks = {
    intervalMs: num("MEMGUARD_INTERVAL_MS", 500),
    fastIntervalMs: num("MEMGUARD_FAST_INTERVAL_MS", 100),
  };
  const adjEveryMs = num("MEMGUARD_ADJ_INTERVAL_MS", 5000);
  const logPath = process.env.MEMGUARD_LOG || `${process.env.FLEET_WORKSPACE || "/workspace"}/.fleet/memguard.log`;
  const self = process.pid;
  const log = (line: string) => {
    try {
      appendFileSync(logPath, line + "\n");
    } catch {
      // A guard that cannot log still guards.
    }
  };
  const applyAdj = (plan: Array<{ pid: number; adj: number }>) => {
    for (const { pid, adj } of plan) {
      try {
        writeFileSync(`/proc/${pid}/oom_score_adj`, String(adj));
      } catch {
        // Exited, or no CAP_SYS_RESOURCE for a negative value.
      }
    }
  };
  const adjCache = newAdjCache();

  trimLog(logPath, LOG_MAX_LINES);
  log(
    `${new Date().toISOString()} START pid=${self} term_pct=${cfg.termPct} kill_pct=${cfg.killPct} ` +
      `grace_ms=${cfg.graceMs} settle_ms=${cfg.settleMs} recover_mib=${cfg.recoverMiB} min_victim_mib=${cfg.minVictimMiB} interval_ms=${ticks.intervalMs}`,
  );
  let state = initialState();
  let lastAdj = 0;
  // #238: THE lead's pane-shell pid, re-resolved on the same ADJ_INTERVAL_MS
  // cadence as the adj pass below -- spawning tmux is far pricier than a
  // /proc read, so this must not run on the 100 ms fast tick. Re-resolved,
  // not resolved once: studio-bringup.sh's claude_stop can `respawn-pane -k`
  // the pane, which keeps the pane but replaces the process inside it, so the
  // pane shell's pid CAN change over a container's life. #270 round 2: a
  // FAILED resolution (tmux not up yet, socket/session missing, the 300 ms
  // timeout tripping) DOES clear an already-known good pid -- see
  // refreshLeadParentPid's, resolveLeadParentPid's and isProtected's own doc
  // comments for why unresolved must fail toward the OLD broad protection,
  // never stay narrow around a pid that may now be stale.
  let leadParentPid: number | null = null;
  const tick = () => {
    const now = Date.now();
    const mem = readMemory("/proc", "/sys/fs/cgroup");
    if (now - lastAdj >= adjEveryMs) {
      leadParentPid = refreshLeadParentPid(leadParentPid, resolveLeadParentPid());
      applyAdj(adjScan("/proc", adjCache, self, leadParentPid));
      lastAdj = now;
    }
    const r = step(state, mem, () => readProcs("/proc"), now, cfg, ticks, self, leadParentPid);
    state = r.state;
    if (r.procs) applyAdj(adjPlan(r.procs, self, leadParentPid));
    if (r.noVictim) {
      log(`${new Date(now).toISOString()} NO_VICTIM avail_mib=${mem.availMiB} total_mib=${mem.totalMiB} source=${mem.source}`);
    }
    if (r.action) {
      try {
        process.kill(r.action.victim.pid, r.action.signal);
        log(formatLogLine(new Date(now), r.action.signal, r.action.victim, mem));
      } catch {
        // It exited between the scan and the signal: settle as if it had.
        state = { ...state, pending: null, settleUntil: now + cfg.settleMs };
      }
    }
    setTimeout(tick, r.nextMs);
  };
  setTimeout(tick, ticks.intervalMs);
}

if (import.meta.main) main();
