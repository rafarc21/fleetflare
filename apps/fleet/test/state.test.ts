import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { getFlag, setFlag, incrementCounter } from "../src/state";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("fleet_state", () => {
  it("returns null for an unset key", async () => {
    expect(await getFlag(env.DB, "paused")).toBeNull();
  });

  it("sets and overwrites", async () => {
    await setFlag(env.DB, "paused", "1", 1000);
    expect(await getFlag(env.DB, "paused")).toBe("1");
    await setFlag(env.DB, "paused", "0", 2000);
    expect(await getFlag(env.DB, "paused")).toBe("0");
  });
});

// PR #9 review, BLOCKER F1: incrementCounter is the single atomic D1
// statement ratelimit.ts's fix rests on — see its own doc comment.
describe("incrementCounter", () => {
  it("starts a fresh key at 1", async () => {
    expect(await incrementCounter(env.DB, "n", 1000)).toBe(1);
  });

  it("increments an existing key and returns the new total", async () => {
    expect(await incrementCounter(env.DB, "n", 1000)).toBe(1);
    expect(await incrementCounter(env.DB, "n", 1001)).toBe(2);
    expect(await incrementCounter(env.DB, "n", 1002)).toBe(3);
    expect(await getFlag(env.DB, "n")).toBe("3");
  });

  it("tracks each key independently", async () => {
    expect(await incrementCounter(env.DB, "a", 0)).toBe(1);
    expect(await incrementCounter(env.DB, "b", 0)).toBe(1);
    expect(await incrementCounter(env.DB, "a", 0)).toBe(2);
  });

  it("exactly `cap` of N concurrent increments on the same key see a value <= cap", async () => {
    // The atomicity proof this table's row rests on: N genuinely concurrent
    // increments against the SAME key must produce N distinct sequential
    // totals (1..N), never two callers seeing the same post-increment value.
    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, () => incrementCounter(env.DB, "race", 0)),
    );
    expect(new Set(results).size).toBe(n);
    expect(Math.max(...results)).toBe(n);
  });
});
