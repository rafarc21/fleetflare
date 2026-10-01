import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  sweepTick, sweepPrompt, SWEEP_COUNT_KEY, QUIESCENT_STREAK_KEY, SWEEP_STOPPED_KEY,
  type SweepDeps, type SweepStorage,
} from "../src/studio/sweep";
import type { QuiescenceDeps } from "../src/studio/quiescence";

function fakeStorage(): SweepStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(k: string) => map.get(k) as T | undefined,
    put: async (k: string, v: unknown) => { map.set(k, v); },
  };
}

const clearFleet: QuiescenceDeps = {
  runningStudios: async () => [],
  openTasksFor: async () => [],
  openPulls: async () => [],
  latestEnvelope: async () => null,
};

function deps(over: Partial<SweepDeps> = {}): SweepDeps & { wakes: string[] } {
  const wakes: string[] = [];
  return {
    wakes,
    quiescence: clearFleet,
    isStopped: async () => false,
    wake: async (prompt: string) => { wakes.push(prompt); return { ok: true }; },
    ...over,
  } as SweepDeps & { wakes: string[] };
}

// SWEEP_SECONDS's real behavior coverage: the source-pinning block below
// ("StudioDO.sweepMaestro wiring") already asserts do.ts rearms through
// `this.rearm("sweepMaestro", SWEEP_SECONDS)` — the symbol, not a re-typed
// literal — which is the real regression this constant needs caught.

describe("sweepTick", () => {
  it("wakes maestro and numbers the sweep", async () => {
    const d = deps();
    const storage = fakeStorage();
    await sweepTick(d, storage);
    await sweepTick(d, storage);
    expect(d.wakes[0]).toContain("SWEEP #1");
    expect(d.wakes[1]).toContain("SWEEP #2");
    expect(storage.map.get(SWEEP_COUNT_KEY)).toBe(2);
  });

  it("never stops after a single quiescent sweep", async () => {
    const d = deps();
    const storage = fakeStorage();
    const r = await sweepTick(d, storage);
    expect(r.stop).toBe(false);
    expect(storage.map.get(QUIESCENT_STREAK_KEY)).toBe(1);
  });

  it("stops on the second consecutive quiescent sweep and says FINAL", async () => {
    const d = deps();
    const storage = fakeStorage();
    await sweepTick(d, storage);
    const r = await sweepTick(d, storage);
    expect(r.stop).toBe(true);
    expect(r.why).toBe("quiescent");
    expect(d.wakes[1]).toContain("FINAL");
    expect(storage.map.get(SWEEP_STOPPED_KEY)).toBeTruthy();
  });

  it("resets the streak when the fleet is busy again", async () => {
    const storage = fakeStorage();
    await sweepTick(deps(), storage);
    const busy = deps({ quiescence: { ...clearFleet, openPulls: async () => [138] } });
    const r = await sweepTick(busy, storage);
    expect(r.stop).toBe(false);
    expect(storage.map.get(QUIESCENT_STREAK_KEY)).toBe(0);
    expect(busy.wakes[0]).toContain("#138");
  });

  /** Fail-CLOSED, one layer up: a check that cannot answer must not end the
   *  chain, no matter how many times in a row it fails. */
  it("never stops while the quiescence check keeps throwing", async () => {
    const storage = fakeStorage();
    const broken = deps({ quiescence: { ...clearFleet, openPulls: async () => { throw new Error("GitHub 503"); } } });
    expect((await sweepTick(broken, storage)).stop).toBe(false);
    expect((await sweepTick(broken, storage)).stop).toBe(false);
    expect((await sweepTick(broken, storage)).stop).toBe(false);
    expect(broken.wakes[2]).toContain("check failed");
  });

  /** Stopping is what ends supervision. Ending it on a wave nobody received
   *  is the one way this feature fails silently. */
  it("does NOT stop when the FINAL wake never landed", async () => {
    const storage = fakeStorage();
    const dead = deps({ wake: async () => ({ ok: false, error: "can't find window: studio:claude" }) });
    await sweepTick(dead, storage);
    const r = await sweepTick(dead, storage);
    expect(r.stop).toBe(false);
  });
});

describe("a stopped studio", () => {
  /**
   * `sbExec` STARTS a container that is not running. Without this guard the
   * sweep would resurrect a studio the operator deliberately stopped, every
   * 20 minutes, forever — and stopping a studio is the only off switch there
   * is for the sweep.
   */
  it("is never woken, and its container is never touched", async () => {
    const d = deps({ isStopped: async () => true });
    const r = await sweepTick(d, fakeStorage());
    expect(d.wakes).toEqual([]);
    expect(r.why).toBe("studio-stopped");
  });

  it("ends the sweep chain rather than re-arming it — provision/restart is the way back", async () => {
    const r = await sweepTick(deps({ isStopped: async () => true }), fakeStorage());
    expect(r.stop).toBe(true);
  });

  it("does not consume a sweep number or touch the quiescent streak", async () => {
    const storage = fakeStorage();
    await sweepTick(deps({ isStopped: async () => true }), storage);
    expect(storage.map.get(SWEEP_COUNT_KEY)).toBeUndefined();
    expect(storage.map.get(QUIESCENT_STREAK_KEY)).toBeUndefined();
  });
});

describe("sweepPrompt", () => {
  it("says why supervision continues", () => {
    expect(sweepPrompt(3, { quiescent: false, reason: "open fleet PRs: #138" }, false))
      .toBe("WAKE SWEEP #3 | fleet NOT quiescent: open fleet PRs: #138 | report a wave, then act unprompted.");
  });

  it("shows the streak while it is still counting", () => {
    expect(sweepPrompt(3, { quiescent: true }, false))
      .toBe("WAKE SWEEP #3 | quiescent 1 of 2 consecutive sweeps | report a wave, then act unprompted.");
  });

  it("tells maestro this is the last one", () => {
    expect(sweepPrompt(4, { quiescent: true }, true))
      .toBe("WAKE SWEEP #4 | FINAL — fleet quiescent 2 consecutive sweeps. Emit the FINAL wave and record end state. Sweeps stop after this one.");
  });

  it("is one line, always — a newline in a TUI prompt submits it", () => {
    for (const p of [
      sweepPrompt(1, { quiescent: false, reason: "check failed: a\nb" }, false),
      sweepPrompt(1, { quiescent: true }, true),
    ]) expect(p).not.toContain("\n");
  });
});

describe("StudioDO.sweepMaestro wiring (source-pinned — the class cannot be constructed here)", () => {
  const src: string = env.TEST_STUDIO_DO_SRC;

  function sweepBody(): string {
    const start = src.indexOf("  async sweepMaestro()");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }

  /**
   * The rule the refreshToken()/shipTranscript() doc comments state outright:
   * an unguarded throw ends the schedule chain FOREVER, and no watchdog
   * re-arms a studio schedule. A bare tail statement is exactly that bug.
   */
  // runScheduledTick owns the `finally` now (and its behaviour is pinned in
  // test/studio.stopped-stays-stopped.test.ts): the re-arm must be its
  // `rearm` argument, never a bare tail statement after it.
  it("reschedules through runScheduledTick's `finally`, never as a bare tail statement", () => {
    const body = sweepBody();
    expect(body).toContain("runScheduledTick(");
    expect(body.indexOf('this.rearm("sweepMaestro", SWEEP_SECONDS)')).toBeGreaterThan(body.indexOf("runScheduledTick("));
    expect(body).not.toContain("this.schedule(");
  });

  it("clears the pending sweep before arming a new one, so wakes cannot stack loops", () => {
    const start = src.indexOf("  private async rearm(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));
    expect(body.indexOf("this.deleteSchedules(name)")).toBeGreaterThan(-1);
    expect(body.indexOf("this.deleteSchedules(name)")).toBeLessThan(body.indexOf("this.schedule(seconds, name)"));
  });

  it("asks the registry whether this studio is stopped before ever exec'ing", () => {
    expect(sweepBody()).toContain("isStopped");
  });

  it("only skips the reschedule on a decided stop, and that flag starts false", () => {
    const body = sweepBody();
    expect(body).toMatch(/let\s+stop\s*=\s*false/);
    expect(body).toMatch(/if\s*\(!stop\)/);
  });

  it("re-arms the sweep on an external wake, so every wake resets the 20 minutes", () => {
    const start = src.indexOf("  async wakeStudio(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));
    expect(body).toContain("armSweep");
  });
});
