import { describe, expect, test } from "bun:test";
import { findDirectChildPid, raceWithTimeout, type ProcReader } from "../../container/ego-browser/process-reap";

// Pure logic only -- no daemon, no real browser, no real /proc scan. Fast
// and deterministic, same spirit as ego-browser-idle-shutdown-scheduler.test.ts
// unit-testing idle-shutdown.ts with injected fakes instead of a real
// system clock.

// -----------------------------------------------------------------------
// findDirectChildPid: post-merge review finding on the original #36 fix --
// the old scan had zero process-identity check, so it could grab
// Chromium's crashpad handler (briefly a direct child too, before it
// double-forks/reparents to PID 1) instead of the real browser process.
// -----------------------------------------------------------------------

function fakeReader(procs: Record<string, { ppid: number; comm?: string }>): ProcReader {
  return {
    listPids: () => Object.keys(procs),
    readStatus: (pid) => {
      const proc = procs[pid];
      if (!proc) throw new Error(`no such fake pid ${pid}`);
      return `Name:\tfake\nState:\tR (running)\nPPid:\t${proc.ppid}\n`;
    },
    readComm: (pid) => {
      const proc = procs[pid];
      if (!proc || proc.comm === undefined) throw new Error(`no comm for fake pid ${pid}`);
      return proc.comm;
    },
  };
}

describe("findDirectChildPid", () => {
  test("returns the one direct child of parentPid when there is exactly one", () => {
    const reader = fakeReader({
      "100": { ppid: 1, comm: "daemon" }, // the daemon itself -- not a child of itself
      "200": { ppid: 100, comm: "chromium" },
      "300": { ppid: 999, comm: "unrelated" }, // some other process entirely
    });
    expect(findDirectChildPid(100, { reader })).toBe(200);
  });

  test("returns undefined when no /proc entry has parentPid as its PPid", () => {
    const reader = fakeReader({ "300": { ppid: 999, comm: "unrelated" } });
    expect(findDirectChildPid(100, { reader })).toBeUndefined();
  });

  test("returns undefined when listPids() itself throws (e.g. /proc unavailable)", () => {
    const reader: ProcReader = {
      listPids: () => {
        throw new Error("no /proc here");
      },
      readStatus: () => "",
      readComm: () => "",
    };
    expect(findDirectChildPid(100, { reader })).toBeUndefined();
  });

  test("excludes a crashpad-named direct child, even when it is the only candidate", () => {
    const reader = fakeReader({
      "201": { ppid: 100, comm: "chrome_crashpad_handler" },
    });
    expect(findDirectChildPid(100, { reader })).toBeUndefined();
  });

  // The exact scenario the review flagged: TWO direct children of the
  // daemon's pid at scan time -- one crashpad, one the real chromium
  // binary. The crashpad entry is deliberately given the LOWER pid (sorts
  // first in both numeric and typical readdirSync order) so this test only
  // passes if the comm-based identity filter is actually doing the work,
  // not a lucky ordering.
  test("returns the chromium pid, not the crashpad pid, when both are direct children", () => {
    const reader = fakeReader({
      "201": { ppid: 100, comm: "chrome_crashpad_handler" },
      "205": { ppid: 100, comm: "chromium" },
    });
    expect(findDirectChildPid(100, { reader })).toBe(205);
  });

  test("crashpad exclusion is case-insensitive and matches on substring", () => {
    const reader = fakeReader({
      "201": { ppid: 100, comm: "Chrome_CrashPad_Handler" },
      "205": { ppid: 100, comm: "chromium" },
    });
    expect(findDirectChildPid(100, { reader })).toBe(205);
  });

  test("prefers a candidate whose comm matches the configured chromium binary name when both survive the crashpad filter", () => {
    // Neither name contains "crashpad", so both survive that filter --
    // chromiumBinaryName is what should break the tie, not just pid order.
    const reader = fakeReader({
      "301": { ppid: 100, comm: "some-other-helper" },
      "205": { ppid: 100, comm: "chromium" },
    });
    expect(findDirectChildPid(100, { reader, chromiumBinaryName: "chromium" })).toBe(205);
  });

  test("falls back to the lowest pid when no candidate matches chromiumBinaryName", () => {
    const reader = fakeReader({
      "301": { ppid: 100, comm: "some-helper" },
      "205": { ppid: 100, comm: "another-helper" },
    });
    expect(findDirectChildPid(100, { reader, chromiumBinaryName: "chromium" })).toBe(205);
  });

  test("skips a candidate whose comm is unreadable (exited mid-scan) rather than misidentifying it", () => {
    const reader: ProcReader = {
      listPids: () => ["201", "205"],
      readStatus: (pid) => `PPid:\t100\n`,
      readComm: (pid) => {
        if (pid === "201") throw new Error("ENOENT: process exited");
        return "chromium";
      },
    };
    expect(findDirectChildPid(100, { reader })).toBe(205);
  });
});

// -----------------------------------------------------------------------
// raceWithTimeout: post-merge review finding on the original #36 fix --
// shutdown()'s SIGKILL backstop had no actual bound. A hung browser.close()
// meant the backstop and rmSync/process.exit cleanup never ran at all.
// -----------------------------------------------------------------------

describe("raceWithTimeout", () => {
  test("resolves once the awaited promise settles, before the timeout fires", async () => {
    const events: string[] = [];
    let firedTimeout: (() => void) | undefined;
    const fakeSetTimeout = ((fn: () => void) => {
      firedTimeout = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const inner = Promise.resolve().then(() => {
      events.push("inner-settled");
    });

    await raceWithTimeout(inner, 999999, fakeSetTimeout);
    events.push("race-resolved");

    expect(events).toEqual(["inner-settled", "race-resolved"]);
    // The timeout callback was armed but never needed to fire.
    expect(firedTimeout).toBeDefined();
  });

  // The core proof the review asked for: the timeout mechanism itself
  // returns within the timeout window even when the awaited operation
  // NEVER settles -- simulating a hung browser.close() (unresponsive CDP
  // connection, wedged renderer) without needing a real browser at all.
  test("resolves via the timeout when the awaited promise never settles", async () => {
    const neverSettles = new Promise<void>(() => {});
    let timeoutFn: (() => void) | undefined;
    const fakeSetTimeout = ((fn: () => void, delay?: number) => {
      timeoutFn = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const racePromise = raceWithTimeout(neverSettles, 5000, fakeSetTimeout);
    let resolved = false;
    void racePromise.then(() => {
      resolved = true;
    });

    // Nothing has fired the timer yet -- the race must not have resolved
    // on its own just because the inner promise will never settle.
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(timeoutFn).toBeDefined();

    // Simulate the timer firing.
    timeoutFn!();
    await racePromise;
    expect(resolved).toBe(true);
  });

  // Same proof as above, but against REAL timers instead of a fake clock,
  // so there is no ambiguity that this only works because of a fake --
  // proves the actual bounded-wait guarantee shutdown() relies on: a
  // never-settling promise still lets this return in well under the
  // test's own timeout.
  test(
    "with real timers, still returns within a short bound even though the inner promise never settles",
    async () => {
      const neverSettles = new Promise<void>(() => {});
      const start = Date.now();
      await raceWithTimeout(neverSettles, 100);
      const elapsed = Date.now() - start;
      // Comfortably above the 100ms timeout (scheduling jitter under a
      // loaded container) but nowhere near "forever" -- the whole point.
      expect(elapsed).toBeLessThan(2000);
    },
    5000,
  );
});
