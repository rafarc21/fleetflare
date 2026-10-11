/**
 * Browser-process ownership for daemon.ts: the BrowserProcess lifecycle
 * (lazy launch -> pid discovery -> bounded close -> SIGKILL backstop; board
 * #326, deep-modules sweep 2 F11) plus the OS-process-identification and
 * bounded-wait helpers it is built from (board #36 and the follow-up
 * review findings on that fix; board #276 -- see
 * docs/plans/2026-09-23-ego-browser-idle-shutdown-container.md and
 * docs/plans/2026-10-08-fix-276-ego-browser-hang.md). No playwright-core
 * import and no unconditional real I/O: every real thing (launcher, /proc,
 * kill, timers) is injected, so the whole module is fast, deterministic and
 * unit-testable -- same spirit as idle-shutdown.ts and registry.ts.
 * daemon.ts is the only module that plugs the real implementations in.
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

// ---------------------------------------------------------------------------
// BrowserProcess (board #326): owns the daemon's whole browser-process
// lifecycle so daemon.ts only wires real implementations and Playwright
// specifics. Every behavioral guarantee below is load-bearing and covered
// by test/bun/ego-browser-process.test.ts with injected fakes.
// ---------------------------------------------------------------------------

/** The only Browser member this sequence relies on; playwright-core's real
 * Browser satisfies it structurally. */
export interface BrowserLike {
  close(): Promise<void>;
}

export interface BrowserProcessDeps<T extends BrowserLike = BrowserLike> {
  launch(): Promise<T>;
  log(line: string): void;
  /** Real daemon uses findDirectChildPid() -- pid discovery has no public
   * API on playwright-core's Browser (see findDirectChildPid's comment). */
  findPid(parentPid: number, opts: { chromiumBinaryName?: string }): number | undefined;
  /** Real daemon uses process.kill; injected so tests assert the backstop. */
  killFn(pid: number, signal: string): void;
  /** Optional fake clock for raceWithTimeout in close(). */
  setTimeoutFn?: typeof setTimeout;
}

export interface BrowserProcess<T extends BrowserLike = BrowserLike> {
  get(): Promise<T>;
  close(budgetMs: number): Promise<void>;
}

export function createBrowserProcess<T extends BrowserLike>(
  chromiumBinaryName: string,
  deps: BrowserProcessDeps<T>,
): BrowserProcess<T> {
  let browserPromise: Promise<T> | undefined;
  // Real Chromium OS pid, once a launch succeeded -- the SIGKILL backstop's
  // target. Stays undefined on the launch-failure path, so close() no-ops
  // its kill there.
  let browserPid: number | undefined;

  return {
    get() {
      if (!browserPromise) {
        // Once per REAL attempt, never on a cache hit -- a fresh failure's
        // message is textually identical to a stale replay, so this log
        // line is the only externally-observable proof a retry happened
        // (board #276; ego-browser-launch-self-heal.test.ts greps it).
        deps.log("getBrowser: attempting chromium launch");
        browserPromise = deps
          .launch()
          .then((browser) => {
            browserPid = deps.findPid(process.pid, { chromiumBinaryName });
            deps.log(`browser launched, pid ${browserPid ?? "unknown"}`);
            return browser;
          })
          .catch((err) => {
            // A rejected Promise is still truthy: without this reset every
            // later get() would replay the same stale rejection forever
            // (board #276's permanent wedge). The throw still rejects THIS
            // caller's await; the NEXT get() gets a fresh launch.
            browserPromise = undefined;
            throw err;
          });
      }
      return browserPromise;
    },

    close(budgetMs: number) {
      // Never launched -> nothing to close, nothing recorded to kill.
      // (browserPid is only ever set after a launch resolved, so
      // browserPromise undefined implies browserPid undefined.)
      if (!browserPromise) return Promise.resolve();
      // `.catch(() => {})` swallows either a launch failure or a close
      // failure, so shutdown's caller never throws out of this path (a
      // bare await of a permanently-rejected launch was board #32's
      // resident-forever bug, closed by #44). raceWithTimeout bounds a
      // hung close() so the backstop below still runs -- the follow-up
      // review finding on the original #36 fix.
      const closeWait = browserPromise.then((b) => b.close()).then(
        () => undefined,
        () => undefined,
      );
      return raceWithTimeout(closeWait, budgetMs, deps.setTimeoutFn).then(() => {
        // Unconditional backstop: raceWithTimeout only bounds the WAIT --
        // it does not claim the process died -- so always check-and-kill
        // for real. kill(2) on an already-exited-but-unreaped zombie is a
        // no-op; ESRCH (fully reaped) throws, which is the expected case.
        if (browserPid !== undefined) {
          try {
            deps.killFn(browserPid, "SIGKILL");
          } catch {
            // Already gone -- fine.
          }
        }
      });
    },
  };
}
