// #1148 item 1 (refs #1135): the gate run watchdog. The every-minute cron ends a
// live run with no progress for GATE_STALL_MS, then reruns it once (infra), or
// posts the final error verdict when the run is already a rerun. The Workflows
// engine, the run index and the status post are fakes at the boundary; the
// decision is the code under test.
import { describe, it, expect } from "bun:test";
import { GATE_STALL_MS, type GateRunIndex, type GateRunInstance, type GateRunRecord } from "../../src/gate/auto-run";
import { GATE_WATCHDOG_LOOKBACK_MS, sweepStalledRuns, type WatchdogIndex } from "../../src/gate/watchdog";

const REPO = "acme/example";
const PR = 7;
const HEAD = "a".repeat(40);
const T0 = 1_700_000_000_000;

/** A Workflows engine fake with the duplicate-id rule. The live status of each
 *  instance is what the test sets; terminate() ends it, as the binding would. */
function fakeEngine(opts: { createError?: Error } = {}) {
  const runs = new Map<string, { status: string; params: unknown }>();
  const creates: { id: string; params: unknown }[] = [];
  const terminated: string[] = [];
  const instance = (id: string): GateRunInstance => ({
    async status() { return { status: runs.get(id)!.status }; },
    async terminate() { terminated.push(id); runs.get(id)!.status = "terminated"; },
  });
  return {
    runs, creates, terminated,
    workflow: {
      async create(opts2: { id: string; params: unknown }) {
        creates.push(opts2);
        if (opts.createError) throw opts.createError;
        if (runs.has(opts2.id)) throw new Error(`instance ${opts2.id} already exists`);
        runs.set(opts2.id, { status: "running", params: opts2.params });
        return { id: opts2.id };
      },
      async get(id: string) {
        if (!runs.has(id)) throw new Error(`instance ${id} not found`);
        return instance(id);
      },
    },
  };
}

/** The per-PR pointer in memory, with the D1 store's rules for handOff and progress. */
function fakeIndex(initial: GateRunRecord | null) {
  let head: GateRunRecord | null = initial;
  const index: WatchdogIndex & GateRunIndex = {
    async latest() { return head; },
    async record(_r, _p, run) { head = run; },
    async progress(_r, _p, runId, at) { if (head?.runId === runId) head = { ...head, progressedAt: at }; },
    async handOff(_r, _p, from, run) {
      if (head?.runId !== from) return false;
      head = run;
      return true;
    },
    async adoptUnknown(at) { if (head && head.progressedAt === 0) head = { ...head, progressedAt: at }; },
    async stalled(before, notBefore) {
      if (!head || head.progressedAt === undefined || head.progressedAt <= 0) return [];
      if (head.progressedAt > before || head.progressedAt < notBefore) return [];
      return [{ ...head, repo: REPO, pr: PR }];
    },
  };
  return { index, head: () => head };
}

function fakeStatusPost() {
  const posts: { repo: string; headSha: string; state: string; description?: string }[] = [];
  const post = async (repo: string, headSha: string, args: { state: string; description?: string }) => {
    posts.push({ repo, headSha, ...args });
    return true;
  };
  return { post, posts };
}

describe("sweepStalledRuns: a live run with no progress for the stall window is ended (#1148 item 1)", () => {
  it("a live run inside the stall window is left alone", async () => {
    const engine = fakeEngine();
    engine.runs.set("gate-x", { status: "running", params: {} });
    const { index } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: T0 });
    const { post, posts } = fakeStatusPost();
    const result = await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => T0 + GATE_STALL_MS - 60_000 });
    expect(result).toEqual([]);
    expect(engine.terminated).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("a finished run is never ended, even when its progress is old", async () => {
    const engine = fakeEngine();
    engine.runs.set("gate-x", { status: "complete", params: {} });
    const { index } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: T0 });
    const { post, posts } = fakeStatusPost();
    await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => T0 + GATE_STALL_MS + 60_000 });
    expect(engine.terminated).toEqual([]);
    expect(posts).toEqual([]);
  });
});

describe("sweepStalledRuns: a lost leg attempt is terminated and reruns once (#1148 item 1)", () => {
  it("a stalled first run is terminated, a rerun starts under rerun-<id>, and the pointer moves to the rerun", async () => {
    const engine = fakeEngine();
    engine.runs.set("gate-x", { status: "running", params: {} });
    const { index, head } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: T0 });
    const { post, posts } = fakeStatusPost();
    const result = await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => T0 + GATE_STALL_MS });
    expect(result).toEqual([{ runId: "gate-x", outcome: "rerun" }]);
    expect(engine.terminated).toEqual(["gate-x"]);
    expect(engine.creates).toEqual([{ id: "rerun-gate-x", params: { repo: REPO, pr: PR, headSha: HEAD, rerunOf: "gate-x" } }]);
    expect(head()?.runId).toBe("rerun-gate-x");
    expect(posts.map((p) => p.state)).toEqual(["pending"]);
    expect(posts[0].description).toContain("rerun after infra error (run gate-x)");
  });

  it("the rerun is itself stalled: it is terminated and the final error verdict posts, no second rerun (one rerun max)", async () => {
    const engine = fakeEngine();
    engine.runs.set("gate-x", { status: "running", params: {} });
    const { index, head } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: T0 });
    const { post, posts } = fakeStatusPost();
    // Sweep 1: the first run stalls and its rerun starts.
    await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => T0 + GATE_STALL_MS });
    // The rerun is pointed at, and stamped with the handoff time; its legs then stall too.
    expect(head()?.runId).toBe("rerun-gate-x");
    // Sweep 2, a stall window later: the rerun is ended and the final verdict posts.
    const later = T0 + GATE_STALL_MS * 2 + 60_000;
    const second = await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => later });
    expect(second).toEqual([{ runId: "rerun-gate-x", outcome: "final" }]);
    expect(engine.terminated).toEqual(["gate-x", "rerun-gate-x"]);
    expect(engine.creates.map((c) => c.id)).toEqual(["rerun-gate-x"]);
    expect(posts.at(-1)).toMatchObject({ state: "error" });
    expect(posts.at(-1)?.description).toContain("a rerun is final");
    // Sweep 3: nothing live is left on the head, so no third run and no second verdict.
    const third = await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => later + GATE_STALL_MS });
    // The terminated rerun is no longer live: it is skipped, with no new end, rerun or post.
    expect(third).toEqual([{ runId: "rerun-gate-x", outcome: "skipped" }]);
    expect(engine.terminated).toEqual(["gate-x", "rerun-gate-x"]);
    expect(engine.creates).toHaveLength(1);
    expect(posts.filter((p) => p.state === "error")).toHaveLength(1);
  });

  it("a stalled run whose rerun cannot be created posts the final error verdict, never silence", async () => {
    const engine = fakeEngine({ createError: new Error("quota exceeded") });
    engine.runs.set("gate-x", { status: "running", params: {} });
    const { index } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: T0 });
    const { post, posts } = fakeStatusPost();
    const result = await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => T0 + GATE_STALL_MS });
    expect(result).toEqual([{ runId: "gate-x", outcome: "final" }]);
    expect(posts.at(-1)).toMatchObject({ state: "error" });
  });

  it("a rerun whose pointer handoff is lost to a newer push is terminated, and the head gets the final error verdict", async () => {
    const engine = fakeEngine();
    engine.runs.set("gate-x", { status: "running", params: {} });
    const { index, head } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: T0 });
    const { post, posts } = fakeStatusPost();
    // A newer push takes the pointer between the sweep's read and its handoff.
    const handOff = index.handOff;
    index.handOff = async (r, p, from, run) => {
      await index.record(r, p, { headSha: "b".repeat(40), runId: "gate-newer", progressedAt: T0 });
      return handOff.call(index, r, p, from, run);
    };
    const result = await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => T0 + GATE_STALL_MS });
    expect(result).toEqual([{ runId: "gate-x", outcome: "final" }]);
    expect(engine.terminated).toEqual(["gate-x", "rerun-gate-x"]);
    expect(head()?.runId).toBe("gate-newer");
    expect(posts.at(-1)).toMatchObject({ state: "error" });
  });

  it("a run that stalled before the lookback window is not swept: past it, the run is no longer watched", async () => {
    const engine = fakeEngine();
    engine.runs.set("gate-x", { status: "running", params: {} });
    const { index } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: T0 });
    const { post } = fakeStatusPost();
    const result = await sweepStalledRuns({
      index, workflow: engine.workflow, post, now: () => T0 + GATE_WATCHDOG_LOOKBACK_MS + GATE_STALL_MS,
    });
    expect(result).toEqual([]);
    expect(engine.terminated).toEqual([]);
  });
});

describe("sweepStalledRuns: a run with no progress stamp is adopted, never ended on first sight (#1148 item 3)", () => {
  it("a run with progressedAt 0 is stamped with the sweep time, and is not ended in the same sweep", async () => {
    const engine = fakeEngine();
    engine.runs.set("gate-x", { status: "running", params: {} });
    const { index, head } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: 0 });
    const { post } = fakeStatusPost();
    const result = await sweepStalledRuns({ index, workflow: engine.workflow, post, now: () => T0 });
    expect(result).toEqual([]);
    expect(head()?.progressedAt).toBe(T0);
    expect(engine.terminated).toEqual([]);
  });
});

describe("sweepStalledRuns: one bad row never stops the sweep", () => {
  it("a terminate that fails leaves that run for the next sweep, and the others still run", async () => {
    const engine = fakeEngine();
    engine.runs.set("gate-x", { status: "running", params: {} });
    const { index } = fakeIndex({ headSha: HEAD, runId: "gate-x", progressedAt: T0 });
    const broken = { ...engine.workflow, get: async () => ({ status: async () => ({ status: "running" }), terminate: async () => { throw new Error("DO down"); } }) };
    const { post, posts } = fakeStatusPost();
    const result = await sweepStalledRuns({ index, workflow: broken as never, post, now: () => T0 + GATE_STALL_MS });
    expect(result).toEqual([{ runId: "gate-x", outcome: "failed" }]);
    expect(posts).toEqual([]);
  });
});
