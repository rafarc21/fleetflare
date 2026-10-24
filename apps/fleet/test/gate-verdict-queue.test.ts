// #1276 item 3: the gate/verdict post queue. A terminal verdict a rate limit
// kept from landing is queued here and re-posted by the every-minute cron once
// its reset time passes — the verdict is never lost.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { gateVerdictQueue, drainVerdictQueue } from "../src/gate/verdict-queue-env";
import { GATE_VERDICT_QUEUE_KEY, type QueuedVerdictPost } from "../src/gate/verdict-queue";
import { deleteFlag } from "../src/state";

const post: QueuedVerdictPost = {
  repo: "acme/verdict-queue",
  sha: "a".repeat(40),
  state: "failure",
  description: "1/2 green",
  resetAt: 0,
};

beforeEach(async () => {
  await deleteFlag(env.DB, GATE_VERDICT_QUEUE_KEY);
});

describe("gateVerdictQueue: the queued verdict posts over fleet_state", () => {
  it("peek returns [] when no key exists", async () => {
    expect(await gateVerdictQueue(env.DB).peek()).toEqual([]);
  });

  it("append then peek round-trips a post", async () => {
    const queue = gateVerdictQueue(env.DB);
    await queue.append(post);
    expect(await queue.peek()).toEqual([post]);
  });

  it("remove drops only the matched post, keeping the rest", async () => {
    const queue = gateVerdictQueue(env.DB);
    const other: QueuedVerdictPost = { ...post, state: "error", description: "no progress" };
    await queue.append(post);
    await queue.append(other);
    await queue.remove(post);
    expect(await queue.peek()).toEqual([other]);
  });
});

describe("drainVerdictQueue: the every-minute retry", () => {
  it("re-posts a post whose reset time has passed, and removes it from the queue", async () => {
    const queue = gateVerdictQueue(env.DB);
    await queue.append({ ...post, resetAt: 1 });
    const posted: QueuedVerdictPost[] = [];
    await drainVerdictQueue(
      { FLEET_GATE_RUNNER: "on", DB: env.DB },
      async (p) => { posted.push(p); },
    );
    expect(posted).toEqual([{ ...post, resetAt: 1 }]);
    expect(await queue.peek()).toEqual([]);
  });

  it("a post whose reset time has not passed stays queued, un-re-posted", async () => {
    const queue = gateVerdictQueue(env.DB);
    await queue.append({ ...post, resetAt: Date.now() + 60_000 });
    const posted: QueuedVerdictPost[] = [];
    await drainVerdictQueue(
      { FLEET_GATE_RUNNER: "on", DB: env.DB },
      async (p) => { posted.push(p); },
    );
    expect(posted).toEqual([]);
    expect(await queue.peek()).toEqual([{ ...post, resetAt: expect.any(Number) }]);
  });

  it("a re-post that fails stays queued (replayed next minute)", async () => {
    const queue = gateVerdictQueue(env.DB);
    await queue.append({ ...post, resetAt: 1 });
    await drainVerdictQueue(
      { FLEET_GATE_RUNNER: "on", DB: env.DB },
      async () => { throw new Error("rate limit again"); },
    );
    expect(await queue.peek().then((q) => q.length)).toBe(1);
  });

  it("does nothing while the gate runner is off", async () => {
    const queue = gateVerdictQueue(env.DB);
    await queue.append({ ...post, resetAt: 1 });
    const posted: QueuedVerdictPost[] = [];
    await drainVerdictQueue(
      { FLEET_GATE_RUNNER: "off", DB: env.DB },
      async (p) => { posted.push(p); },
    );
    expect(posted).toEqual([]);
    expect(await queue.peek().then((q) => q.length)).toBe(1);
  });
});