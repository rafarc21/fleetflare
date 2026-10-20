// #1232: the gate drain flag and pending queue. A Worker deploy sets `gate_drain`
// while it drains running gate runs; a pull_request delivery that arrives in that
// window queues its auto-run as pending instead of starting a run the deploy would
// kill. The every-minute cron releases the queue once the flag is cleared.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { GATE_DRAIN_FLAG, GATE_DRAIN_QUEUE_KEY, gateDrainQueue, gateDraining, clearStaleDrainFlag } from "../src/gate/drain";
import { drainPendingGateRuns, d1RunIndex } from "../src/gate/auto-run-env";
import { gateRunId, type PullRequestAutoRun } from "../src/gate/auto-run";
import { setFlag, deleteFlag, flagIsSet } from "../src/state";
import type { Env } from "../src/env";

const pr: PullRequestAutoRun = {
  repo: "acme/drain-queue",
  pr: 42,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
};

/** Inserts a raw ts string, so a test can force a non-numeric stamp that a
 *  number-typed setFlag call could never write. */
async function db_set_raw(db: D1Database, key: string, value: string, ts: string) {
  await db.prepare(`INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`).bind(key, value, ts).run();
}

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
    await queue.append(pr);
    expect(await queue.peek()).toEqual([pr]);
  });

  it("append is atomic: two appends both land in one array", async () => {
    const queue = gateDrainQueue(env.DB);
    const second: PullRequestAutoRun = { repo: "acme/drain-queue", pr: 43, headSha: "f".repeat(40), baseSha: "e".repeat(40) };
    await queue.append(pr);
    await queue.append(second);
    expect(await queue.peek()).toEqual([pr, second]);
  });

  it("remove drops only the matched entry, keeping the rest (atomic)", async () => {
    const queue = gateDrainQueue(env.DB);
    const other: PullRequestAutoRun = { repo: "acme/drain-queue", pr: 42, headSha: "f".repeat(40), baseSha: "e".repeat(40) };
    await queue.append(pr);
    await queue.append(other);
    await queue.remove(pr);
    expect(await queue.peek()).toEqual([other]);
  });

  it("a corrupt (non-JSON) value reads as [] — fail-closed, never throws", async () => {
    await setFlag(env.DB, GATE_DRAIN_QUEUE_KEY, "not json", 0);
    expect(await gateDrainQueue(env.DB).peek()).toEqual([]);
  });
});

describe("gateDraining: the drain flag", () => {
  it("is true after setFlag \"1\", false when absent or \"0\"", async () => {
    expect(await gateDraining(env.DB)).toBe(false);
    await setFlag(env.DB, GATE_DRAIN_FLAG, "1", Date.now());
    expect(await gateDraining(env.DB)).toBe(true);
    await setFlag(env.DB, GATE_DRAIN_FLAG, "0", Date.now());
    expect(await gateDraining(env.DB)).toBe(false);
  });

  it("a stale flag (older than 20 min) reads as not-draining and is cleared", async () => {
    await setFlag(env.DB, GATE_DRAIN_FLAG, "1", Date.now() - 21 * 60_000);
    expect(await gateDraining(env.DB)).toBe(false);
    expect(await flagIsSet(env.DB, GATE_DRAIN_FLAG)).toBe(false);
  });

  it("a non-numeric ts reads as stale, never draining forever", async () => {
    await db_set_raw(env.DB, GATE_DRAIN_FLAG, "1", "not-a-number");
    expect(await gateDraining(env.DB)).toBe(false);
    expect(await flagIsSet(env.DB, GATE_DRAIN_FLAG)).toBe(false);
  });

  it("clearStaleDrainFlag deletes only when the ts still matches; a fresh re-set survives", async () => {
    const stale = Date.now() - 21 * 60_000;
    await setFlag(env.DB, GATE_DRAIN_FLAG, "1", Date.now());
    await clearStaleDrainFlag(env.DB, stale); // aimed at a stale stamp, must no-op
    expect(await flagIsSet(env.DB, GATE_DRAIN_FLAG)).toBe(true);
    await setFlag(env.DB, GATE_DRAIN_FLAG, "1", stale);
    await clearStaleDrainFlag(env.DB, stale); // matching stamp deletes
    expect(await flagIsSet(env.DB, GATE_DRAIN_FLAG)).toBe(false);
  });
});

describe("drainPendingGateRuns: the every-minute release of the pending queue", () => {
  function fakeEnv(opts: {
    runner?: string;
    create?: () => Promise<{ id: string }>;
    get?: (id: string) => Promise<unknown>;
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
    await gateDrainQueue(env.DB).append(queued);
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
    await setFlag(env.DB, GATE_DRAIN_FLAG, "1", Date.now());
    await gateDrainQueue(env.DB).append(queued);
    await drainPendingGateRuns(fakeEnv({ create }));
    expect(create).not.toHaveBeenCalled();
    expect(await gateDrainQueue(env.DB).peek()).toEqual([queued]);
  });

  it("a create that throws leaves the entry queued", async () => {
    const queued: PullRequestAutoRun = { repo: "acme/drain-throw", pr: 103, headSha: "9".repeat(40), baseSha: "8".repeat(40) };
    const create = vi.fn(async () => { throw new Error("create failed"); });
    const get = vi.fn(async () => { throw new Error("instance not found"); });
    await gateDrainQueue(env.DB).append(queued);
    await drainPendingGateRuns(fakeEnv({ create, get }));
    expect(create).toHaveBeenCalled();
    expect(await gateDrainQueue(env.DB).peek()).toEqual([queued]);
  });

  it("a queued edited PR with a live -e run reattaches, never creates or terminates (#1241 a)", async () => {
    const repo = "acme/drain-edit";
    const headSha = "a".repeat(40);
    // The -e suffix encodes the run's start time (base36); reattach requires
    // the run to be no older than the queue entry. queuedAt 1, suffix "1" -> 1 >= 1.
    const queued: PullRequestAutoRun = { repo, pr: 201, headSha, baseSha: "b".repeat(40), edited: true, queuedAt: 1 };
    const eRunId = `${await gateRunId(repo, headSha)}-e1`;
    await d1RunIndex(env.DB).record(repo, 201, { headSha, runId: eRunId, progressedAt: Date.now() });
    await gateDrainQueue(env.DB).append(queued);
    const create = vi.fn(async () => ({ id: "unused" }));
    const terminate = vi.fn(async () => {});
    const get = vi.fn(async (id: string) => ({
      status: async () => ({ status: id === eRunId ? "running" : "terminated" }),
      terminate,
    }));
    await drainPendingGateRuns(fakeEnv({ create, get }));
    expect(create).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(await gateDrainQueue(env.DB).peek()).toEqual([]);
  });

  it("a queued edited PR whose live -e run predates the queue is NOT reattached (ended + fresh) (#1241 b1)", async () => {
    const repo = "acme/drain-edit-old";
    const headSha = "a".repeat(40);
    const queuedAt = 2;
    const queued: PullRequestAutoRun = { repo, pr: 202, headSha, baseSha: "b".repeat(40), edited: true, queuedAt };
    const eRunId = `${await gateRunId(repo, headSha)}-e1`; // suffix 1 < queuedAt 2: a pre-edit -e run
    await d1RunIndex(env.DB).record(repo, 202, { headSha, runId: eRunId, progressedAt: Date.now() });
    await gateDrainQueue(env.DB).append(queued);
    const create = vi.fn(async () => ({ id: "unused" }));
    const terminated: string[] = [];
    const get = vi.fn(async (id: string) => ({
      status: async () => ({ status: terminated.includes(id) ? "terminated" : id === eRunId ? "running" : "terminated" }),
      terminate: async () => { terminated.push(id); },
    }));
    await drainPendingGateRuns(fakeEnv({ create, get }));
    expect(create).toHaveBeenCalledOnce();
    expect(terminated).toEqual([eRunId]);
    expect(await gateDrainQueue(env.DB).peek()).toEqual([]);
  });
});