// #1148 item 1 (refs #1135): the gate run watchdog. The every-minute cron ends a
// live run with no progress for GATE_STALL_MS, then reruns it once (infra). A run
// that is already a rerun takes the final error verdict. A red leg stays final
// (#1119). The Workflows engine, the run index and the status post are fakes at
// the boundary; the decisions are the code under test.
import { describe, it, expect } from "bun:test";
import { GATE_STALL_MS, type GateRunIndex, type GateRunInstance, type GateRunRecord } from "../../src/gate/auto-run";
import {
  GATE_WATCHDOG_FINAL_AGE_MS, GATE_WATCHDOG_LOOKBACK_MS, hasRedResult, redResultPrefix, sweepStalledRuns, type WatchdogDeps, type WatchdogIndex,
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

function harness(opts: {
  initial?: GateRunRecord | null; redLeg?: boolean; postFails?: boolean; runs?: Record<string, string>;
  headStatus?: (repo: string, headSha: string) => Promise<{ state: string; description?: string } | undefined>;
} = {}) {
  const engine = fakeEngine();
  for (const [id, status] of Object.entries(opts.runs ?? { "gate-x": "running" })) {
    engine.runs.set(id, { status, params: {} });
  }
  const { index, head } = fakeIndex(opts.initial === undefined ? { headSha: HEAD, runId: "gate-x", progressedAt: T0 } : opts.initial);
  const posts: Post[] = [];
  // #1226: post follows postGateStatus's throw contract — a failure is an
  // exception, never a swallowed boolean.
  const post = async (repo: string, headSha: string, args: { state: string; description?: string }) => {
    posts.push({ repo, headSha, ...args });
    if (opts.postFails === true) throw new Error("status post failed");
  };
  const hasRedLeg = async () => opts.redLeg === true;
  const headStatus = opts.headStatus ?? (async () => undefined);
  const sweep = (now: number) => sweepStalledRuns({ index, workflow: engine.workflow, post, headStatus, hasRedLeg, now: () => now });
  return { engine, index, head, posts, sweep, opts };
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

describe("sweepStalledRuns: a red check that fails is retried, then ends final at the watch edge (#1156 item 1)", () => {
  it("a red check that fails before the final age is kept; at the final age the run gets the final error", async () => {
    const h = harness();
    let redCheckFails = true;
    const deps = {
      index: h.index, workflow: h.engine.workflow,
      post: async (repo: string, headSha: string, args: { state: string; description?: string }) => {
        h.posts.push({ repo, headSha, ...args });
      },
      headStatus: async () => undefined,
      hasRedLeg: async () => { if (redCheckFails) throw new Error("github down"); return false; },
      now: () => T0 + GATE_STALL_MS,
    };
    expect(await sweepStalledRuns(deps)).toEqual([{ runId: "gate-x", outcome: "failed" }]);
    expect(h.posts).toEqual([]);
    expect(h.engine.terminated).toEqual([]);
    const edge = T0 + GATE_WATCHDOG_FINAL_AGE_MS;
    expect(await sweepStalledRuns({ ...deps, now: () => edge })).toEqual([{ runId: "gate-x", outcome: "final" }]);
    expect(h.engine.terminated).toEqual(["gate-x"]);
    expect(h.posts.at(-1)).toMatchObject({ state: "error" });
    expect(h.posts.at(-1)?.description).toContain("could not check leg results");
  });
});

describe("sweepStalledRuns: the final verdict is stamped before its post (#1156 item 3)", () => {
  it("the progress stamp lands before the final post, so a slow post is never re-stalled", async () => {
    const h = harness({ redLeg: true });
    const now = T0 + GATE_STALL_MS;
    let stampAtPost: number | undefined;
    await sweepStalledRuns({
      index: h.index, workflow: h.engine.workflow, hasRedLeg: async () => true, now: () => now,
      headStatus: async () => undefined,
      post: async (repo, headSha, args) => { stampAtPost = h.head()?.progressedAt; h.posts.push({ repo, headSha, ...args }); },
    });
    expect(stampAtPost).toBe(now);
    expect(h.head()?.progressedAt).toBe(-1);
  });
});

describe("sweepStalledRuns: a final post that failed is retried, not silently retired (#1156 item 4)", () => {
  it("the failed post keeps the run live and restores its row's stamp, so a later sweep reposts the verdict", async () => {
    const h = harness({ redLeg: true, postFails: true });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "failed" }]);
    expect(h.engine.terminated).toEqual([]);
    expect(h.head()?.runId).toBe("gate-x");
    expect(h.head()?.progressedAt).toBe(T0); // the stamp is restored, so the row stays in the sweep
    h.opts.postFails = false;
    const later = T0 + GATE_STALL_MS + GATE_STALL_MS + 60_000;
    expect(await h.sweep(later)).toEqual([{ runId: "gate-x", outcome: "final" }]);
    expect(h.engine.terminated).toEqual(["gate-x"]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a final post that fails at the watch edge is ended and retired anyway, logging the lost verdict (#1196 B)", async () => {
    const h = harness({ redLeg: true, postFails: true });
    expect(await h.sweep(T0 + GATE_WATCHDOG_FINAL_AGE_MS)).toEqual([{ runId: "gate-x", outcome: "final" }]);
    expect(h.engine.terminated).toEqual(["gate-x"]);
    expect(h.head()?.progressedAt).toBe(-1);
  });
});

describe("sweepStalledRuns: a repo the gate runner is off for is retired at once, never ended, reran or posted (#1148 review LOW 5, #1156 item 2)", () => {
  it("a repo the gate runner is off for is never ended, reran or posted", async () => {
    const h = harness();
    const result = await sweepStalledRuns({
      index: h.index, workflow: h.engine.workflow, hasRedLeg: async () => false, now: () => T0 + GATE_STALL_MS,
      headStatus: async () => undefined,
      post: async (repo, headSha, args) => { h.posts.push({ repo, headSha, ...args }); },
      gated: () => false,
    });
    expect(result).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.engine.terminated).toEqual([]);
    expect(h.engine.creates).toEqual([]);
    expect(h.posts).toEqual([]);
    expect(h.head()?.runId).toBe("gate-x");
    expect(h.head()?.progressedAt).toBe(-1); // the switched-off repo is retired, freeing its sweep slot
  });
});

describe("sweepStalledRuns: a rerun create that lands before its response is lost is retried by id (#1148 review)", () => {
  it("the next sweep relaunches the same rerun id and takes the pointer, with no error posted", async () => {
    const h = harness();
    const realCreate = h.engine.workflow.create;
    const realGet = h.engine.workflow.get;
    let lost = true;
    let blip = true;
    h.engine.workflow.create = async (opts) => {
      if (lost) { lost = false; await realCreate(opts); throw new Error("response lost"); }
      return realCreate(opts);
    };
    h.engine.workflow.get = async (id) => {
      if (id === "rerun-gate-x" && blip) { blip = false; throw new Error("get blip"); }
      return realGet(id);
    };
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "failed" }]);
    expect(h.posts.filter((p) => p.state === "error")).toEqual([]);
    expect(h.head()?.runId).toBe("gate-x");
    expect(await h.sweep(T0 + GATE_STALL_MS + 60_000)).toEqual([{ runId: "gate-x", outcome: "rerun" }]);
    expect(h.head()?.runId).toBe("rerun-gate-x");
    expect(h.posts.filter((p) => p.state === "error")).toEqual([]);
    expect(h.engine.runs.get("rerun-gate-x")?.status).toBe("running");
  });
});

describe("hasRedResult: a leg's decisive stored result decides red, as the run's verdict does (#1150 review)", () => {
  const P = "gate/acme/example/runs/7/gate-x";
  const store = (files: Record<string, string>) => async (key: string) =>
    files[key] === undefined ? undefined : { state: files[key] };

  it("a red first try whose retry passed is not red: the run's verdict is success for that leg", async () => {
    const files = { [`${P}/shard-lint.json`]: "failure", [`${P}/shard-lint.retry.json`]: "success" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(false);
  });

  it("a red first try whose retry is also red is red", async () => {
    const files = { [`${P}/shard-lint.json`]: "failure", [`${P}/shard-lint.retry.json`]: "failure" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(true);
  });

  it("a red first try whose retry never stored a result stays red: its retry was lost, the first try is the verdict", async () => {
    const files = { [`${P}/shard-lint.json`]: "failure" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(true);
  });

  it("an infra try-2 that passed decides the leg over its infra first try: not red", async () => {
    const files = { [`${P}/shard-lint.json`]: "error", [`${P}/shard-lint-try2.json`]: "success" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(false);
  });

  it("one red leg among green ones is red, whatever the others did", async () => {
    const files = {
      [`${P}/shard-lint.json`]: "failure", [`${P}/shard-lint.retry.json`]: "success",
      [`${P}/shard-e2e.json`]: "success", [`${P}/shard-unit.json`]: "failure",
    };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(true);
  });

  it("no stored result at all is not red: nothing failed before the stall", async () => {
    expect(await hasRedResult([], store({}))).toBe(false);
  });

  it("a red first try whose retry stored an error stays red: the run's red-first rule is final (#1156 N1c)", async () => {
    const files = { [`${P}/shard-lint.json`]: "failure", [`${P}/shard-lint.retry.json`]: "error" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(true);
  });

  it("a try-2 that is red with a green retry is not red: the retry's success decides the leg (#1196 A1)", async () => {
    const files = { [`${P}/shard-lint-try2.json`]: "failure", [`${P}/shard-lint.retry.json`]: "success" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(false);
  });

  it("an install error first try whose retry is red IS red: a red retry is the leg's verdict (#1196 A2)", async () => {
    const files = { [`${P}/shard-lint.json`]: "error", [`${P}/shard-lint.retry.json`]: "failure" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(true);
  });

  it("a try-2 error with a red retry IS red: a red retry is the leg's verdict (#1196 A3)", async () => {
    const files = { [`${P}/shard-lint-try2.json`]: "error", [`${P}/shard-lint.retry.json`]: "failure" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(true);
  });

  it("a try-2 that is red alone IS red: its retry was lost, the try-2 is the verdict (#1196 A4)", async () => {
    const files = { [`${P}/shard-lint-try2.json`]: "failure" };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(true);
  });

  it("a try-3 that passed decides the leg over tries 1 and 2: not red (#1231: more than one infra retry)", async () => {
    const files = {
      [`${P}/shard-lint.json`]: "error",
      [`${P}/shard-lint-try2.json`]: "failure",
      [`${P}/shard-lint-try3.json`]: "success",
    };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(false);
  });

  it("a try-3 that failed decides the leg over a passing try-2: red (#1231: the latest try always decides)", async () => {
    const files = {
      [`${P}/shard-lint.json`]: "error",
      [`${P}/shard-lint-try2.json`]: "success",
      [`${P}/shard-lint-try3.json`]: "failure",
    };
    expect(await hasRedResult(Object.keys(files), store(files))).toBe(true);
  });
});

describe("sweepStalledRuns: only a finished run is retired; an unknown status is read again (#1150 review)", () => {
  it("a run reporting unknown is kept and skipped, not retired, so the next sweep still sees it", async () => {
    const h = harness({ runs: { "gate-x": "unknown" } });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.head()?.progressedAt).toBe(T0);
    expect(await h.sweep(T0 + GATE_STALL_MS + 60_000)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
  });
});

describe("sweepStalledRuns: an errored run that never posted its own verdict is reconciled once before it is retired (#1226)", () => {
  it("an errored run with no landed head status gets one reconciliation post, then is retired", async () => {
    const h = harness({ runs: { "gate-x": "errored" }, headStatus: async () => undefined });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([{ repo: REPO, headSha: HEAD, state: "error", description: expect.stringContaining("ended without a verdict") }]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("an errored run whose head already shows a terminal status is never clobbered: no reconciliation post, still retired", async () => {
    const h = harness({ runs: { "gate-x": "errored" }, headStatus: async () => ({ state: "success" }) });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a pending head naming a DIFFERENT run is a newer same-head run: no reconciliation post, still retired", async () => {
    const h = harness({
      runs: { "gate-x": "errored" },
      headStatus: async () => ({ state: "pending", description: "running (run gate-y) — 2 legs" }),
    });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a pending head naming THIS run is reconciled: the one error post lands", async () => {
    const h = harness({
      runs: { "gate-x": "errored" },
      headStatus: async () => ({ state: "pending", description: "running (run gate-x) — 2 legs" }),
    });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([{ repo: REPO, headSha: HEAD, state: "error", description: expect.stringContaining("ended without a verdict") }]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a pending head whose description starts with this run id but names a longer run is a newer same-head run: no reconciliation post, still retired (#1243)", async () => {
    const h = harness({
      runs: { "gate-x": "errored" },
      headStatus: async () => ({ state: "pending", description: "running (run gate-x-p7) — 2 legs" }),
    });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a pre-create pending with no run id is reconciled: the one error post lands, retired (#1243)", async () => {
    const h = harness({
      runs: { "gate-x": "errored" },
      headStatus: async () => ({ state: "pending", description: "running (fresh gate run)" }),
    });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([{ repo: REPO, headSha: HEAD, state: "error", description: expect.stringContaining("ended without a verdict") }]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a pre-create pending with no run id, edited variant, is reconciled: the one error post lands, retired (#1243)", async () => {
    const h = harness({
      runs: { "gate-x": "errored" },
      headStatus: async () => ({ state: "pending", description: "running (edited title/body recheck)" }),
    });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([{ repo: REPO, headSha: HEAD, state: "error", description: expect.stringContaining("ended without a verdict") }]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a terminal failure head is never clobbered: no reconciliation post, still retired", async () => {
    const h = harness({ runs: { "gate-x": "errored" }, headStatus: async () => ({ state: "failure" }) });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a terminal error head is never clobbered: no reconciliation post, still retired", async () => {
    const h = harness({ runs: { "gate-x": "errored" }, headStatus: async () => ({ state: "error" }) });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a pending head naming this run id with a -r suffix is a newer same-head rerun: no reconciliation post, still retired", async () => {
    const h = harness({
      runs: { "gate-x": "errored" },
      headStatus: async () => ({ state: "pending", description: "running (run gate-x-p7-r3) — 2 legs" }),
    });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a rerun-status head naming THIS run is reconciled: the one error post lands, retired", async () => {
    const h = harness({
      runs: { "gate-x": "errored" },
      headStatus: async () => ({ state: "pending", description: "rerun after infra error (run gate-x)" }),
    });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([{ repo: REPO, headSha: HEAD, state: "error", description: expect.stringContaining("ended without a verdict") }]);
    expect(h.head()?.progressedAt).toBe(-1);
  });

  it("a queued drain marker is a newer run's status, never clobbered: no reconciliation post, still retired", async () => {
    const h = harness({
      runs: { "gate-x": "errored" },
      headStatus: async () => ({ state: "pending", description: "queued (gate draining for deploy)" }),
    });
    expect(await h.sweep(T0 + GATE_STALL_MS)).toEqual([{ runId: "gate-x", outcome: "skipped" }]);
    expect(h.posts).toEqual([]);
    expect(h.head()?.progressedAt).toBe(-1);
  });
});

// #1343 MED6: the watchdog lists a run's results under the `shard-` prefix,
// so an evidence .json (PR-controlled) is never read as a result, and
// evidence volume never crowds results out of one listing page.
describe("redResultPrefix (#1343 MED6)", () => {
  it("scopes the listing to shard- result keys, never the whole run prefix", () => {
    expect(redResultPrefix("acme/example", 7, "run-a")).toBe("gate/acme/example/runs/7/run-a/shard-");
    expect(redResultPrefix("acme/example", 7, "run-a")).not.toContain("evidence");
  });
});
