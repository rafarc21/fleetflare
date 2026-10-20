// #1232: the gate drain flag and pending queue. A Worker deploy sets `gate_drain`
// while it drains running gate runs; a pull_request delivery that arrives in that
// window queues its auto-run as pending instead of starting a run the deploy would
// kill. The every-minute cron releases the queue once the flag is cleared.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { GATE_DRAIN_FLAG, GATE_DRAIN_QUEUE_KEY, gateDrainQueue, gateDraining } from "../src/gate/drain";
import { drainPendingGateRuns } from "../src/gate/auto-run-env";
import { gateRunId, type PullRequestAutoRun } from "../src/gate/auto-run";
import { setFlag, deleteFlag } from "../src/state";
import type { Env } from "../src/env";

const pr: PullRequestAutoRun = {
  repo: "acme/drain-queue",
  pr: 42,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
};

beforeEach(async () => {
  await deleteFlag(env.DB, GATE_DRAIN_FLAG);
  await deleteFlag(env.DB, GATE_DRAIN_QUEUE_KEY);
});

describe("gateDrainQueue: the pending auto-runs over fleet_state", () => {
  it("peek returns [] when no key exists", async () => {
    expect(await gateDrainQueue(env.DB).peek()).toEqual([]);
  });

  it("write then peek round-trips an array of PullRequestAutoRun", async () => {
    const queue = gateDrainQueue(env.DB);
    await queue.write([pr]);
    expect(await queue.peek()).toEqual([pr]);
  });

  it("write([]) clears the queue", async () => {
    const queue = gateDrainQueue(env.DB);
    await queue.write([pr]);
    await queue.write([]);
    expect(await queue.peek()).toEqual([]);
  });

  it("a corrupt (non-JSON) value reads as [] — fail-closed, never throws", async () => {
    await setFlag(env.DB, GATE_DRAIN_QUEUE_KEY, "not json", 0);
    expect(await gateDrainQueue(env.DB).peek()).toEqual([]);
  });
});

describe("gateDraining: the drain flag", () => {
  it("is true after setFlag \"1\", false when absent or \"0\"", async () => {
    expect(await gateDraining(env.DB)).toBe(false);
    await setFlag(env.DB, GATE_DRAIN_FLAG, "1", 0);
    expect(await gateDraining(env.DB)).toBe(true);
    await setFlag(env.DB, GATE_DRAIN_FLAG, "0", 0);
    expect(await gateDraining(env.DB)).toBe(false);
  });
});

describe("drainPendingGateRuns: the every-minute release of the pending queue", () => {
  function fakeEnv(opts: {
    runner?: string;
    create?: () => Promise<{ id: string }>;
    get?: () => Promise<unknown>;
  } = {}): Env {
    return {
      FLEET_GATE_RUNNER: opts.runner ?? "on",
      DB: env.DB,
      GATE_WORKFLOW: {
        create: opts.create ?? (async () => ({ id: "unused" })),
        get: opts.get ?? (async () => { throw new Error("instance not found"); }),
      },
    } as unknown as Env;
  }

  it("with the flag clear and a queued PR, creates the run and ends with an empty queue", async () => {
    const queued: PullRequestAutoRun = { repo: "acme/drain-release", pr: 101, headSha: "c".repeat(40), baseSha: "d".repeat(40) };
    const create = vi.fn(async () => ({ id: "unused" }));
    await gateDrainQueue(env.DB).write([queued]);
    await drainPendingGateRuns(fakeEnv({ create }));
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      id: await gateRunId(queued.repo, queued.headSha),
      params: { repo: queued.repo, pr: queued.pr },
    });
    expect(await gateDrainQueue(env.DB).peek()).toEqual([]);
  });

  it("with the flag set, creates nothing and leaves the queue untouched", async () => {
    const queued: PullRequestAutoRun = { repo: "acme/drain-blocked", pr: 102, headSha: "e".repeat(40), baseSha: "f".repeat(40) };
    const create = vi.fn(async () => ({ id: "unused" }));
    await setFlag(env.DB, GATE_DRAIN_FLAG, "1", 0);
    await gateDrainQueue(env.DB).write([queued]);
    await drainPendingGateRuns(fakeEnv({ create }));
    expect(create).not.toHaveBeenCalled();
    expect(await gateDrainQueue(env.DB).peek()).toEqual([queued]);
  });

  it("a create that throws leaves the entry queued", async () => {
    const queued: PullRequestAutoRun = { repo: "acme/drain-throw", pr: 103, headSha: "9".repeat(40), baseSha: "8".repeat(40) };
    const create = vi.fn(async () => { throw new Error("create failed"); });
    const get = vi.fn(async () => { throw new Error("instance not found"); });
    await gateDrainQueue(env.DB).write([queued]);
    await drainPendingGateRuns(fakeEnv({ create, get }));
    expect(create).toHaveBeenCalled();
    expect(await gateDrainQueue(env.DB).peek()).toEqual([queued]);
  });
});