/**
 * Pure OS-process-identification and bounded-wait helpers for daemon.ts's
 * shutdown() backstop (board #36, and the follow-up review findings on the
 * original #36 fix -- see
 * docs/plans/2026-09-23-ego-browser-idle-shutdown-container.md). Deliberately
 * has no Bun/playwright-core import and does no unconditional real I/O --
 * same spirit as idle-shutdown.ts/registry.ts: fast, deterministic,
 * unit-testable via injected fakes. daemon.ts is the only module that plugs
 * the real /proc filesystem and real timers in here.
 */
import { readdirSync, readFileSync } from "node:fs";

export interface ProcReader {
  listPids(): string[];
  readStatus(pid: string): string;
  /** /proc/<pid>/comm -- the kernel's own short (<=15 char) process name.
   * Throws (same as a real ENOENT) when the process has already exited. */
  readComm(pid: string): string;
}

const realProcReader: ProcReader = {
  listPids: () => readdirSync("/proc"),
  readStatus: (pid) => readFileSync(`/proc/${pid}/status`, "utf8"),
  readComm: (pid) => readFileSync(`/proc/${pid}/comm`, "utf8").trim(),
};

export interface FindDirectChildPidOptions {
  /** Injectable for tests -- real daemon.ts uses the real /proc filesystem. */
  reader?: ProcReader;
  /** Basename of the configured chromium executable (e.g. "chromium"). Used
   * as a positive-match preference when more than one crashpad-filtered
   * candidate remains: a comm/cmdline-adjacent match wins over a
   * non-matching one. Optional -- when omitted, or when no candidate's comm
   * contains it, this falls back to the lowest-pid tie-break alone. */
  chromiumBinaryName?: string;
}

/**
 * Board #36: `chromium.launch()`'s returned Browser has NO public way to
 * reach the real OS process it spawned (`browser.process` does not exist on
 * that class -- verified directly against playwright-core's own
 * types.d.ts, and confirmed live: `browser.process is not a function`; that
 * method only exists on `BrowserServer`, the `launchServer()`-mode object
 * this daemon deliberately does NOT use -- tried it first, see the plan
 * doc's dead end: `chromium.connect()` back to its own wsEndpoint hung
 * indefinitely in this exact container, never worth the added
 * websocket-hop complexity anyway when a direct spawn already gives a much
 * simpler answer). Scans /proc for processes whose PPid is this daemon's
 * own pid -- confirmed live (see the plan doc) that Chromium's main browser
 * process is always a DIRECT child of whatever spawned it.
 *
 * Follow-up review finding on the original #36 fix: a bare "first PPid
 * match, arbitrary readdirSync order, zero identity check" scan can grab
 * Chromium's crashpad handler instead of the real browser process --
 * crashpad's handler is briefly a direct child too, before it
 * double-forks/reparents itself to PID 1 so it survives the browser
 * crashing (an intentional, independent, near-zero-cost helper process,
 * not the resource this backstop cares about); the scan can run during
 * that narrow window since `chromium.launch()`'s promise resolving is not
 * guaranteed to happen strictly after crashpad's own reparenting
 * completes. Now filters every direct-child candidate by its real
 * `/proc/<pid>/comm`, explicitly excluding anything with "crashpad" in the
 * name, and prefers a candidate whose comm contains the configured
 * chromium binary's basename when more than one survives that filter. Any
 * remaining tie breaks on lowest pid -- the earliest-spawned direct child
 * is the most likely to be the main browser process, which Chromium
 * launches before any helper processes.
 */
export function findDirectChildPid(parentPid: number, opts: FindDirectChildPidOptions = {}): number | undefined {
  const reader = opts.reader ?? realProcReader;
  let entries: string[];
  try {
    entries = reader.listPids();
  } catch {
    return undefined;
  }

  const candidates: { pid: number; comm: string }[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = reader.readStatus(entry);
      const ppidLine = status.split("\n").find((l) => l.startsWith("PPid:"));
      const ppid = ppidLine ? Number(ppidLine.split(/\s+/)[1]) : NaN;
      if (ppid !== parentPid) continue;
    } catch {
      // Process exited mid-scan -- just skip it, not fatal to the scan.
      continue;
    }
    let comm = "";
    try {
      comm = reader.readComm(entry);
    } catch {
      // comm unreadable (process exited between the PPid check above and
      // here) -- skip rather than risk treating an unidentifiable process
      // as the real browser.
      continue;
    }
    if (comm.toLowerCase().includes("crashpad")) continue;
    candidates.push({ pid: Number(entry), comm });
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].pid;

  if (opts.chromiumBinaryName) {
    const named = candidates.filter((c) => c.comm.toLowerCase().includes(opts.chromiumBinaryName!.toLowerCase()));
    if (named.length > 0) return Math.min(...named.map((c) => c.pid));
  }
  return Math.min(...candidates.map((c) => c.pid));
}

/**
 * Bounded-wait helper for shutdown()'s browser.close() (follow-up review
 * finding on the original #36 fix): a hung close() (unresponsive CDP
 * connection, wedged renderer -- anything short of an outright rejection)
 * must never keep the daemon's shutdown() from reaching its SIGKILL
 * backstop and rmSync/process.exit cleanup. Races the given promise against
 * a timeout and resolves either way -- callers must not assume the awaited
 * operation actually completed just because this returned; that is exactly
 * why the SIGKILL backstop in daemon.ts still unconditionally checks
 * whether the process is really gone afterwards.
 */
export function raceWithTimeout(promise: Promise<unknown>, timeoutMs: number, setTimeoutFn: typeof setTimeout = setTimeout): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    setTimeoutFn(finish, timeoutMs);
    promise.then(finish, finish);
  });
}

/**
 * Same bounded-wait shape as raceWithTimeout(), but for callers that need
 * the timeout itself to become a REAL rejection with a caller-supplied,
 * actionable message -- board #276's getBrowser() bound on chromium.launch().
 * raceWithTimeout() deliberately only resolves either way (right for
 * shutdown()'s browser.close(), which doesn't care whether close() actually
 * succeeded, only that the wait ends); a hung launch() must surface as an
 * honest failure to whatever is awaiting getBrowser(), not a silent "assume
 * it launched". Does not cancel the underlying promise (there is no such
 * thing for a plain Promise) -- if it later settles anyway, that settlement
 * is simply ignored by the `settled` guard, same spirit as raceWithTimeout().
 */
export function raceWithTimeoutOrReject<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  setTimeoutFn: typeof setTimeout = setTimeout,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
    );
  });
}
