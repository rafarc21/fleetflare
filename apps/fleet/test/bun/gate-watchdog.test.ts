// #1148 item 1 (refs #1135): the gate run watchdog. The every-minute cron ends a
// live run with no progress for GATE_STALL_MS, then reruns it once (infra). A run
// that is already a rerun takes the final error verdict. A red leg stays final
// (#1119). The Workflows engine, the run index and the status post are fakes at
// the boundary; the decisions are the code under test.
import { describe, it, expect } from "bun:test";
import { GATE_STALL_MS, type GateRunIndex, type GateRunInstance, type GateRunRecord } from "../../src/gate/auto-run";
import {
  GATE_WATCHDOG_FINAL_AGE_MS, GATE_WATCHDOG_LOOKBACK_MS, sweepStalledRuns, type WatchdogDeps, type WatchdogIndex,
} from "../../src/gate/watchdog";

const REPO = "acme/example";
const PR = 7;
const HEAD = "a".repeat(40);
const T0 = 1_700_000_000_000;

/** A Workflows engine fake with the duplicate-id rule. Each instance has the
 *  status the test sets; terminate() ends it. `createError` makes creates fail. */
function fakeEngine() {
  const state: { createError?: Error } = {};
  const runs = new Map<string, { status: string; params: unknown }>();
  const creates: { id: string; params: unknown }[] = [];
  const terminated: string[] = [];
  const instance = (id: string): GateRunInstance => ({
    async status() { return { status: runs.get(id)!.status }; },
    async terminate() { terminated.push(id); runs.get(id)!.status = "terminated"; },
  });
  const workflow: WatchdogDeps["workflow"] = {
    async create(opts) {
      creates.push(opts);
      if (state.createError) throw state.createError;
      if (runs.has(opts.id)) throw new Error(`instance ${opts.id} already exists`);
      runs.set(opts.id, { status: "running", params: opts.params });
      return { id: opts.id };
    },
    async get(id) {
      if (!runs.has(id)) throw new Error(`instance ${id} not found`);
      return instance(id);
    },
  };
  return { state, runs, creates, terminated, workflow };
}

/** The per-PR pointer in memory, with the D1 rules: handOff lands from the
 *  pointed run or onto a run already pointed at; retire clears only the stamp it read. */
function fakeIndex(initial: GateRunRecord | null) {
  let head: GateRunRecord | null = initial;
  const index: WatchdogIndex & GateRunIndex = {
    async latest() { return head; },
    async record(_r, _p, run) { head = run; },
    async progress(_r, _p, runId, at) { if (head?.runId === runId) head = { ...head, progressedAt: at }; },
    async handOff(_r, _p, from, run) {
      if (head?.runId !== from && head?.runId !== run.runId) return false;
      head = run;
      return true;
    },
    async adoptUnknown(at) { if (head && head.progressedAt === 0) head = { ...head, progressedAt: at }; },
    async stalled(before, notBefore) {
      if (!head || head.progressedAt === undefined || head.progressedAt <= 0) return [];
      if (head.progressedAt > before || head.progressedAt < notBefore) return [];
      return [{ ...head, repo: REPO, pr: PR }];
    },
    async retire(_r, _p, runId, progressedAt) {
      if (head?.runId === runId && head.progressedAt === progressedAt) head = { ...head, progressedAt: -1 };
    },
  };
  return { index, head: () => head };
}

type Post = { repo: string; headSha: string; state: string; description?: string };

function harness(opts: { initial?: GateRunRecord | null; redLeg?: boolean; runs?: Record<string, string> } = {}) {
  const engine = fakeEngine();
  for (const [id, status] of Object.entries(opts.runs ?? { "gate-x": "running" })) {
    engine.runs.set(id, { status, params: {} });
  }
  const { index, head } = fakeIndex(opts.initial === undefined ? { headSha: HEAD, runId: "gate-x", progressedAt: T0 } : opts.initial);
  const posts: Post[] = [];
  const post = async (repo: string, headSha: string, args: { state: string; description?: string }) => {
    posts.push({ repo, headSha, ...args });
    return true;
  };
  const hasRedLeg = async () => opts.redLeg === true;
  const sweep = (now: number) => sweepStalledRuns({ index, workflow: engine.workflow, post, hasRedLeg, now: () => now });
  return { engine, index, head, posts, sweep };
}

describe("sweepStalledRuns: a live run with no progress for the stall window is hung (#1148 item 1)", () => {
  it("a live run inside the stall window is left alone", async () => {
    const h = harness();
    expect(await h.sweep(T0 + GATE_STALL_MS - 60_000)).toEqual([]);
    expect(h.engine.terminated).toEqual([]);
    expect(h.posts).toEqual([]);
  });

  it("a finished stalled run is retired at once, so no later sweep reads it again (#1150 review item 2)", async () => {
    const h = harness({ runs: { "gate-x": "complete" } });
    expect(await h.sweep(T0 + GATE_STALL_MS + 60_000)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.head()?.progressedAt).toBe(-1);
    expect(await h.sweep(T0 + GATE_STALL_MS + 120_000)).toEqual([]);
    expect(h.engine.terminated).toEqual([]);
    expect(h.posts).toEqual([]);
  });
});

describe("sweepStalledRuns: a lost leg attempt is terminated and reruns once (#1148 item 1)", () => {
  it("a stalled first run gets its rerun under rerun-<id>, the pointer moves to it, and the first run is ended", async () => {
    const h = harness();
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "rerun" }]);
    expect(h.engine.creates).toEqual([{ id: "rerun-gate-x", params: { repo: REPO, pr: PR, headSha: HEAD, rerunOf: "gate-x" } }]);
    expect(h.head()?.runId).toBe("rerun-gate-x");
    expect(h.engine.terminated).toEqual(["gate-x"]);
    expect(h.posts.map((p) => p.state)).toEqual(["pending"]);
    expect(h.posts[0].description).toContain("rerun after infra error (run gate-x)");
  });

  it("the rerun is itself stalled: it is ended and the final error verdict posts, and no third run follows (one rerun max)", async () => {
    const h = harness();
    await h.sweep(T0 + GATE_STALL_MS);
    const later = T0 + GATE_STALL_MS * 2 + 60_000;
    expect(await h.sweep(later)).toEqual([{ runId: "rerun-gate-x", outcome: "final" }]);
    expect(h.engine.terminated).toEqual(["gate-x", "rerun-gate-x"]);
    expect(h.engine.creates.map((c) => c.id)).toEqual(["rerun-gate-x"]);
    expect(h.posts.at(-1)).toMatchObject({ state: "error" });
    expect(h.posts.at(-1)?.description).toContain("a rerun is final");
    // The ended rerun is retired, so the next sweep leaves the head alone.
    expect(await h.sweep(later + GATE_STALL_MS)).toEqual([]);
    expect(h.posts.filter((p) => p.state === "error")).toHaveLength(1);
  });

  it("a rerun start that fails with no instance behind it posts nothing and leaves the first run live: the next sweep retries it (#1150 review item 3)", async () => {
    const h = harness();
    h.engine.state.createError = new Error("quota exceeded");
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "failed" }]);
    expect(h.posts).toEqual([]);
    expect(h.engine.terminated).toEqual([]);
    expect(h.head()?.runId).toBe("gate-x");
    h.engine.state.createError = undefined;
    expect(await h.sweep(T0 + GATE_STALL_MS + 60_000)).toEqual([{ runId: "gate-x", outcome: "rerun" }]);
    expect(h.head()?.runId).toBe("rerun-gate-x");
    expect(h.engine.terminated).toEqual(["gate-x"]);
  });

  it("a rerun that still cannot start at the edge of the watch window gets the final error verdict, and the run is ended", async () => {
    const h = harness();
    h.engine.state.createError = new Error("quota exceeded");
    const edge = T0 + GATE_WATCHDOG_FINAL_AGE_MS;
    expect(await h.sweep(edge)).toEqual([{ runId: "gate-x", outcome: "final" }]);
    expect(h.posts.at(-1)).toMatchObject({ state: "error" });
    expect(h.engine.terminated).toEqual(["gate-x"]);
    expect(GATE_WATCHDOG_FINAL_AGE_MS).toBeLessThan(GATE_WATCHDOG_LOOKBACK_MS);
  });

  it("a handoff lost to a newer push ends the orphan rerun and the first run, posts nothing on the old head", async () => {
    const h = harness();
    const handOff = h.index.handOff;
    h.index.handOff = async (r, p, from, run) => {
      await h.index.record(r, p, { headSha: "b".repeat(40), runId: "gate-newer", progressedAt: T0 });
      return handOff.call(h.index, r, p, from, run);
    };
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.engine.terminated).toEqual(["rerun-gate-x", "gate-x"]);
    expect(h.head()?.runId).toBe("gate-newer");
    expect(h.posts).toEqual([]);
  });

  it("a first run's end that fails after its rerun took over is logged: the rerun stands", async () => {
    const h = harness();
    const realGet = h.engine.workflow.get;
    h.engine.workflow.get = async (id: string) => id === "gate-x"
      ? { status: async () => ({ status: "running" }), terminate: async () => { throw new Error("DO down"); } }
      : realGet(id);
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "rerun" }]);
    expect(h.head()?.runId).toBe("rerun-gate-x");
  });
});

describe("sweepStalledRuns: a red leg stays final, never rerun (#1119, #1150 review)", () => {
  it("a stalled run with a red leg is ended and posts failure, with no rerun", async () => {
    const h = harness({ redLeg: true });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "final" }]);
    expect(h.engine.creates).toEqual([]);
    expect(h.engine.terminated).toEqual(["gate-x"]);
    expect(h.posts.at(-1)).toMatchObject({ state: "failure" });
  });

  it("a stalled rerun with a red leg posts failure, not error", async () => {
    const h = harness({ redLeg: true, initial: { headSha: HEAD, runId: "rerun-gate-x", progressedAt: T0 }, runs: { "rerun-gate-x": "running" } });
    await h.sweep(T0 + GATE_STALL_MS);
    expect(h.posts.at(-1)).toMatchObject({ state: "failure" });
  });
});

describe("sweepStalledRuns: a run with no progress stamp is adopted, never ended on first sight (#1148 item 3)", () => {
  it("a run with progressedAt 0 is stamped with the sweep time, and is not ended in the same sweep", async () => {
    const h = harness({ initial: { headSha: HEAD, runId: "gate-x", progressedAt: 0 } });
    expect(await h.sweep(T0)).toEqual([]);
    expect(h.head()?.progressedAt).toBe(T0);
    expect(h.engine.terminated).toEqual([]);
  });
});

describe("sweepStalledRuns: one bad read never stops the sweep or retires a live run", () => {
  it("a status read that fails is reported as failed, the row is kept, and nothing is ended", async () => {
    const h = harness();
    h.engine.workflow.get = async () => { throw new Error("binding down"); };
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "failed" }]);
    expect(h.head()?.progressedAt).toBe(T0);
    expect(h.posts).toEqual([]);
  });
});
