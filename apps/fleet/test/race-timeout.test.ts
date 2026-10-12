import { describe, it, expect, afterEach, vi } from "vitest";
import { raceWithDeadline } from "../src/race-timeout";

// Board issue #450 (sweep-6 F4): the REJECTING `Promise.race` + `setTimeout`
// + `finally clearTimeout` idiom src/exceptions.ts:264-284 and
// src/studio/sandbox-api.ts:219-235 each hand-rolled now has one home,
// src/race-timeout.ts. These tests pin the helper's own contract — the two
// call sites' behavior stays pinned by their existing characterization
// suites (test/exceptions.test.ts case "1a", test/studio.exec-deadlines.test.ts),
// which must keep passing unchanged after the fold.

// Every case that waits for a real timer runs under fake timers, same
// discipline as test/exceptions.test.ts's own "1a" case — no test here
// depends on wall-clock elapsed time, so the suite stays fast and the
// deadline boundary is asserted exactly (fires AT timeoutMs, not before).
afterEach(() => {
  vi.useRealTimers();
});

describe("raceWithDeadline — the deadline wins", () => {
  it("rejects with the exact Error makeTimeoutError() returns, not a wrapper", async () => {
    vi.useFakeTimers();
    const boom = new Error("insert timed out after 2000ms");
    const p = raceWithDeadline(new Promise(() => {}), 2_000, () => boom);
    const settled = expect(p).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(1_999);
    await Promise.resolve();
    let done = false;
    void p.catch(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
  });

  it("rejects even when timeoutMs is 0", async () => {
    vi.useFakeTimers();
    const p = raceWithDeadline(new Promise<never>(() => {}), 0, () => new Error("immediate"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).rejects.toThrow("immediate");
  });

  it("arms the timer via the injected setTimeoutFn with (fn, timeoutMs)", async () => {
    const calls: Array<[() => void, number]> = [];
    const setTimeoutFn = vi.fn((fn: () => void, ms?: number) => {
      calls.push([fn, ms ?? -1]);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const p = raceWithDeadline(new Promise<never>(() => {}), 5_000, () => new Error("x"), setTimeoutFn);
    void p.catch(() => {});
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(calls[0]).toHaveLength(2);
    expect(typeof calls[0][0]).toBe("function");
    expect(calls[0][1]).toBe(5_000);
    // The deadline path works end-to-end through the INJECTED fn too: firing
    // the captured callback rejects — this is the seam the image-boundary
    // sibling (container/ego-browser/process-reap.ts's raceWithTimeout) also
    // relies on to stay testable without real timers.
    calls[0][0]();
    await expect(p).rejects.toThrow("x");
  });
});

describe("raceWithDeadline — the promise wins", () => {
  it("resolves with the promise's own value and clears the armed timer", async () => {
    vi.useFakeTimers();
    const p = raceWithDeadline(Promise.resolve(7), 10_000, () => new Error("must not happen"));
    expect(await p).toBe(7);
    // The strongest observable without a clearTimeoutFn parameter: the fake
    // clock's own live-timer count. The timer was armed (otherwise a count
    // of 0 would prove nothing), and a resolved race must have cleared it —
    // a dangling one would hold a reference to this isolate's memory until
    // the full 10s elapsed on whatever clock it was armed against.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer on the ERROR path too — a rejection also never leaks it", async () => {
    vi.useFakeTimers();
    const original = new Error("from the promise itself");
    const p = raceWithDeadline(Promise.reject(original), 10_000, () => new Error("deadline"));
    await expect(p).rejects.toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates the promise's own error unchanged — not swallowed, not replaced", async () => {
    vi.useFakeTimers();
    const original = new Error("underlying failure");
    const p = raceWithDeadline(Promise.reject(original), 30_000, () => new Error("deadline error"));
    await expect(p).rejects.toBe(original);
    // Also before the deadline ever fires: the race settles on the promise's
    // own rejection at once, and advancing the clock afterwards must not
    // produce an unhandled rejection from the (cleared) deadline.
    await vi.advanceTimersByTimeAsync(30_000);
  });

  it("never constructs the timeout error on a fast resolution — the factory stays uncalled", async () => {
    vi.useFakeTimers();
    let made = 0;
    const p = raceWithDeadline(Promise.resolve("value"), 10_000, () => {
      made++;
      return new Error("never");
    });
    expect(await p).toBe("value");
    expect(made).toBe(0);
  });

  it("never constructs the timeout error on a fast REJECTION either", async () => {
    vi.useFakeTimers();
    let made = 0;
    const p = raceWithDeadline(Promise.reject(new Error("fail fast")), 10_000, () => {
      made++;
      return new Error("never");
    });
    await expect(p).rejects.toThrow("fail fast");
    expect(made).toBe(0);
  });
});

describe("raceWithDeadline — fake-clock determinism", () => {
  it("fires exactly at timeoutMs, never one tick before", async () => {
    vi.useFakeTimers();
    const p = raceWithDeadline(new Promise<never>(() => {}), 2_500, () => new Error("at 2500"));
    const settled = expect(p).rejects.toThrow("at 2500");
    await vi.advanceTimersByTimeAsync(2_499);
    let rejected = false;
    void p.catch(() => { rejected = true; });
    await Promise.resolve();
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it("still waits the full timeoutMs after a promise that settles late but before the deadline", async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("late"), 1_000);
    });
    const p = raceWithDeadline(slow, 3_000, () => new Error("deadline"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toBe("late");
    expect(vi.getTimerCount()).toBe(0);
  });
});
