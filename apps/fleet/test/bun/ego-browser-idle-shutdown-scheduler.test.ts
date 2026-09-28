import { describe, expect, test } from "bun:test";
import { IdleShutdown, resolveIdleMs } from "../../container/ego-browser/idle-shutdown";

// Pure scheduling logic only -- no daemon, no browser, no real socket. Fast
// and deterministic, same spirit as ego-browser-registry.test.ts unit-
// testing registry.ts without a real browser. Fake timers (manually driven,
// not bun's system clock) so this test suite never has to actually wait.

interface FakeTimer {
  id: number;
  fn: () => void;
  delay: number;
}

function makeFakeClock() {
  const pending = new Map<number, FakeTimer>();
  let nextId = 1;
  const setTimeoutFn = ((fn: () => void, delay?: number) => {
    const id = nextId++;
    pending.set(id, { id, fn, delay: delay ?? 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) pending.delete(id as unknown as number);
  }) as typeof clearTimeout;
  /** Fires every timer currently pending, in insertion order -- simulates "idle window elapsed". */
  function fireAll(): void {
    const timers = [...pending.values()];
    pending.clear();
    for (const t of timers) t.fn();
  }
  return {
    setTimeoutFn,
    clearTimeoutFn,
    fireAll,
    pendingCount: () => pending.size,
    /** The delay each currently-pending timer was armed with -- lets a test
     * distinguish "armed, but with the wrong duration" from "not armed at
     * all", which pendingCount() alone cannot (board #36's startup race). */
    pendingDelays: () => [...pending.values()].map((t) => t.delay),
  };
}

describe("resolveIdleMs", () => {
  test("defaults to 60000 when EGO_BROWSER_IDLE_MS is unset", () => {
    expect(resolveIdleMs({})).toBe(60000);
  });

  test("honors a trimmed numeric override, same style as EGO_BROWSER_HOME", () => {
    expect(resolveIdleMs({ EGO_BROWSER_IDLE_MS: "  500  " })).toBe(500);
  });

  test("falls back to the default on garbage input", () => {
    expect(resolveIdleMs({ EGO_BROWSER_IDLE_MS: "not-a-number" })).toBe(60000);
  });
});

describe("IdleShutdown.schedule", () => {
  test("arms a timer when spaces are empty right now", () => {
    const clock = makeFakeClock();
    let idleFired = 0;
    const idle = new IdleShutdown({
      idleMs: 1000,
      spacesEmpty: () => true,
      inFlightZero: () => true,
      onIdle: () => {
        idleFired += 1;
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    idle.schedule();
    expect(clock.pendingCount()).toBe(1);
    clock.fireAll();
    expect(idleFired).toBe(1);
  });

  test("does not arm a timer when spaces are non-empty right now", () => {
    const clock = makeFakeClock();
    let idleFired = 0;
    const idle = new IdleShutdown({
      idleMs: 1000,
      spacesEmpty: () => false,
      inFlightZero: () => true,
      onIdle: () => {
        idleFired += 1;
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    idle.schedule();
    expect(clock.pendingCount()).toBe(0);
    clock.fireAll();
    expect(idleFired).toBe(0);
  });

  test("fire-time re-check suppresses shutdown if spaces became non-empty since scheduling", () => {
    const clock = makeFakeClock();
    let spaces = 0;
    let idleFired = 0;
    const idle = new IdleShutdown({
      idleMs: 1000,
      spacesEmpty: () => spaces === 0,
      inFlightZero: () => true,
      onIdle: () => {
        idleFired += 1;
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    idle.schedule();
    expect(clock.pendingCount()).toBe(1);
    // A taskSpace() call lands between scheduling and the timer firing --
    // exactly what a caller reusing the daemon mid-idle-window looks like.
    spaces = 1;
    clock.fireAll();
    expect(idleFired).toBe(0);
  });

  test("fire-time re-check suppresses shutdown if a request is still in-flight, even with zero spaces (the create-space race)", () => {
    const clock = makeFakeClock();
    let inFlight = 0;
    let idleFired = 0;
    const idle = new IdleShutdown({
      idleMs: 1000,
      spacesEmpty: () => true, // registry.list().length reads 0 -- the new space isn't committed yet
      inFlightZero: () => inFlight === 0,
      onIdle: () => {
        idleFired += 1;
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    idle.schedule();
    // Simulates a taskSpace() RPC handler that's already past
    // handleRequest's inFlight++ but not yet past the await that would
    // push registry.list().length to 1.
    inFlight = 1;
    clock.fireAll();
    expect(idleFired).toBe(0);
  });

  // Board #36 investigation: live reproduction (see the plan doc) found the
  // real daemon self-destructing well within its own configured idleMs,
  // BEFORE the very client that caused it to spawn had sent its first
  // byte -- daemon.ts's startup call (`scheduleIdleCheck()` right after
  // `Bun.listen()`) arms the SAME idleMs a short-window test/config uses,
  // even though "nobody has connected yet" at boot is not evidence nobody
  // is ABOUT to: ensureDaemonAlive always spawns a daemon and then
  // immediately starts connecting to it. schedule(overrideMs) lets the one
  // startup call site use a more generous grace duration while every other
  // call (post-request, from handleRequest's finally) keeps using the real,
  // steady-state idleMs unchanged.
  test("schedule(overrideMs) arms with overrideMs instead of the configured idleMs", () => {
    const clock = makeFakeClock();
    const idle = new IdleShutdown({
      idleMs: 400,
      spacesEmpty: () => true,
      inFlightZero: () => true,
      onIdle: () => {},
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    idle.schedule(5000);
    expect(clock.pendingDelays()).toEqual([5000]);
  });

  test("schedule() with no argument still uses the configured idleMs, unaffected by overrideMs support", () => {
    const clock = makeFakeClock();
    const idle = new IdleShutdown({
      idleMs: 400,
      spacesEmpty: () => true,
      inFlightZero: () => true,
      onIdle: () => {},
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    idle.schedule();
    expect(clock.pendingDelays()).toEqual([400]);
  });

  test("re-scheduling clears the previous pending timer -- only ever one live timer at a time", () => {
    const clock = makeFakeClock();
    const idle = new IdleShutdown({
      idleMs: 1000,
      spacesEmpty: () => true,
      inFlightZero: () => true,
      onIdle: () => {},
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    idle.schedule();
    idle.schedule();
    idle.schedule();
    expect(clock.pendingCount()).toBe(1);
  });

  test("scheduling with non-empty spaces clears any previously-armed timer", () => {
    const clock = makeFakeClock();
    let spaces = 0;
    let idleFired = 0;
    const idle = new IdleShutdown({
      idleMs: 1000,
      spacesEmpty: () => spaces === 0,
      inFlightZero: () => true,
      onIdle: () => {
        idleFired += 1;
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    idle.schedule(); // spaces empty -- arms
    expect(clock.pendingCount()).toBe(1);
    spaces = 1;
    idle.schedule(); // a taskSpace() request just landed -- clears, does not re-arm
    expect(clock.pendingCount()).toBe(0);
    clock.fireAll();
    expect(idleFired).toBe(0);
  });
});
