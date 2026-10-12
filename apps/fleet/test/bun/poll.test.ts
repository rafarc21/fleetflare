// Board task #404 — the bounded poll loop that ff's attach-wait and accounts
// --watch will share, as cli/poll.ts. RED first: the module does not exist
// yet, so this import fails. Clock and sleep are injected so the budget math
// is deterministic; ticker's line shape is pinned byte-exact because
// operators read those lines.
import { describe, expect, test } from "bun:test";
import { poll, ticker } from "../../cli/poll";

/** Fake clock: `now()` reads `t`; the injected `sleep` is the only thing that
 *  moves it, so elapsed is exactly (sleeps so far) * sleepMs past `at`. */
function fakeClock(startMs: number) {
  let t = startMs;
  const sleepLog: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      sleepLog.push(ms);
      t += ms;
    },
    sleepLog,
  };
}

describe("poll — the budget counts from `at`, not loop entry", () => {
  test("a fresh 60s budget exhausts at exactly elapsedSecs 60, one read per 5s interval", async () => {
    const AT = 1_000_000;
    const clock = fakeClock(AT);
    const reads: number[] = [];
    const res = await poll({
      at: AT, budgetMs: 60_000, sleepMs: 5_000, now: clock.now, sleep: clock.sleep,
      read: async () => {
        reads.push(clock.now());
        return null;
      },
    });
    expect(res).toEqual({ timedOut: true, elapsedSecs: 60 });
    // Whether the budget is checked before or after the read is an
    // implementation detail; the pin is one read per 5s interval (12 or 13,
    // never 1, never a busy-spin past the budget).
    expect(reads.length).toBeGreaterThanOrEqual(12);
    expect(reads.length).toBeLessThanOrEqual(13);
    expect(clock.sleepLog).toHaveLength(12);
    for (const ms of clock.sleepLog) expect(ms).toBe(5_000);
  });

  test("50s already burned before the loop leaves only 2-3 reads, not a fresh 60s", async () => {
    const AT = 1_000_000;
    // The spawn POST blocks for most of a bring-up: the loop starts 50s
    // after `at`. Counting from loop entry would grant a full fresh budget.
    const clock = fakeClock(AT + 50_000);
    const reads: number[] = [];
    const res = await poll({
      at: AT, budgetMs: 60_000, sleepMs: 5_000, now: clock.now, sleep: clock.sleep,
      read: async () => {
        reads.push(clock.now());
        return null;
      },
    });
    expect(res).toEqual({ timedOut: true, elapsedSecs: 60 });
    // 10s of budget left in 5s steps: 2 or 3 reads. 12+ means the loop
    // restarted the clock.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.length).toBeLessThanOrEqual(3);
  });
});

describe("poll — the first non-null read wins", () => {
  test("returns the value immediately: no sleep, no tick", async () => {
    const AT = 1_000_000;
    const clock = fakeClock(AT);
    const ticks: number[] = [];
    const res = await poll({
      at: AT, budgetMs: 60_000, sleepMs: 5_000, now: clock.now, sleep: clock.sleep,
      read: async () => "attached",
      tick: (secs) => {
        ticks.push(secs);
      },
    });
    expect(res).toBe("attached");
    expect(clock.sleepLog).toHaveLength(0);
    expect(ticks).toHaveLength(0);
  });
});

describe("poll — tick cadence", () => {
  test("fires once per iteration after each null read, elapsed rounded from `at`", async () => {
    const AT = 1_000_000;
    const clock = fakeClock(AT);
    const ticks: number[] = [];
    const reads: number[] = [];
    let i = 0;
    const res = await poll({
      at: AT, budgetMs: 60_000, sleepMs: 1_500, now: clock.now, sleep: clock.sleep,
      read: async () => {
        reads.push(clock.now());
        i += 1;
        return i === 5 ? "done" : null;
      },
      tick: (secs) => {
        ticks.push(secs);
      },
    });
    expect(res).toBe("done");
    // Null reads land at elapsed 0, 1.5s, 3s, 4.5s. ff.ts's secs() uses
    // Math.round (half up): 1.5s prints 2, 4.5s prints 5. Math.floor would
    // print 1 and 4, and ff's operator-facing lines would stop being
    // byte-identical — the whole point of the extraction.
    expect(ticks).toEqual([0, 2, 3, 5]);
    expect(reads).toHaveLength(5);
    expect(clock.sleepLog).toHaveLength(4);
  });
});

describe("poll — no budgetMs means unbounded", () => {
  test("keeps going past where a 60s budget would have ended, then resolves", async () => {
    const AT = 1_000_000;
    const clock = fakeClock(AT);
    const elapsedAtRead: number[] = [];
    let i = 0;
    const res = await poll({
      at: AT, sleepMs: 5_000, now: clock.now, sleep: clock.sleep,
      read: async () => {
        elapsedAtRead.push(clock.now() - AT);
        i += 1;
        return i === 21 ? "late" : null;
      },
    });
    // Resolved with the read's value, not a timeout object.
    expect(res).toBe("late");
    // The 21st read happens at elapsed 100s — well past 60s, so "absent
    // budget" truly means unbounded (accounts --watch runs until SIGINT).
    expect(elapsedAtRead[20]).toBeGreaterThanOrEqual(65_000);
    expect(clock.sleepLog).toHaveLength(20);
  });
});

describe("ticker — heartbeat with its own stopper", () => {
  test("emits one line per interval and the stopper freezes the count", async () => {
    const lines: string[] = [];
    // Fixed injected now: every line reads 0 elapsed, so only the count moves.
    const stop = ticker("spawning x", 20, (line) => lines.push(line), () => 10_000);
    try {
      await Bun.sleep(60);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines[0]).toBe("spawning x... (0s)");
      const atStop = lines.length;
      stop();
      await Bun.sleep(60);
      // The interval must be cleared: one more line means a leaked timer
      // that keeps the process alive after the work is done.
      expect(lines.length).toBe(atStop);
    } finally {
      stop();
    }
  });

  test("line text is exactly `what... (Ns)` with elapsed counted from creation", async () => {
    const lines: string[] = [];
    let t = 1_000_000;
    // now() advances 5s per call: creation captures 1_005_000, the first
    // interval line reads 1_010_000 — 5 elapsed seconds, then 10.
    const now = () => (t += 5_000);
    const stop = ticker("spawning x", 10, (line) => lines.push(line), now);
    try {
      await Bun.sleep(60);
      expect(lines[0]).toBe("spawning x... (5s)");
      expect(lines[1]).toBe("spawning x... (10s)");
    } finally {
      stop();
    }
  });
});
