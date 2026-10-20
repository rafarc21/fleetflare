// #1082 (refs #715): the per-PR gate run pointer on the real D1 binding
// (migration 0007, gate_pr_head). A new head sha reads the PR's previous run
// here to end it; the pointer is overwritten by every new run.
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { d1RunIndex, d1WatchdogIndex, STALLED_RUNS_SQL } from "../src/gate/auto-run-env";
import type { GateRunInstance } from "../src/gate/auto-run";
import { launchInfraRerun, recordInfraRerun } from "../src/gate/infra-rerun";
import { sweepStalledRuns, type WatchdogWorkflow } from "../src/gate/watchdog";

describe("d1RunIndex: the latest gate run per PR", () => {
  it("a PR with no recorded run has no latest run", async () => {
    expect(await d1RunIndex(env.DB).latest("acme/index-empty", 1)).toBeNull();
  });

  it("record then latest returns the recorded head sha and run id", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/index-one", 3, { headSha: "a".repeat(40), runId: "gate-run-a" });
    expect(await index.latest("acme/index-one", 3)).toMatchObject({ headSha: "a".repeat(40), runId: "gate-run-a" });
  });

  it("a later record replaces the earlier pointer for the same PR", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/index-two", 4, { headSha: "a".repeat(40), runId: "gate-run-a" });
    await index.record("acme/index-two", 4, { headSha: "b".repeat(40), runId: "gate-run-b" });
    expect(await index.latest("acme/index-two", 4)).toMatchObject({ headSha: "b".repeat(40), runId: "gate-run-b" });
  });

  it("keeps PRs apart by number, and repos apart by name", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/index-three", 5, { headSha: "a".repeat(40), runId: "gate-run-five" });
    expect(await index.latest("acme/index-three", 6)).toBeNull();
    expect(await index.latest("acme/index-other", 5)).toBeNull();
  });

  it("matches the repo case-insensitively, like the gate config does", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("Acme/Index-Case", 7, { headSha: "a".repeat(40), runId: "gate-run-case" });
    expect(await index.latest("acme/index-case", 7)).toMatchObject({ headSha: "a".repeat(40), runId: "gate-run-case" });
  });
});

describe("d1RunIndex: the infra handoff and the progress stamp are single conditional writes (#1135)", () => {
  it("handOff moves the pointer only while it still names the first run", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/handoff-one", 8, { headSha: "a".repeat(40), runId: "gate-run-first" });
    expect(await index.handOff("acme/handoff-one", 8, "gate-run-first", { headSha: "a".repeat(40), runId: "rerun-first", progressedAt: 9 }))
      .toBe(true);
    expect(await index.latest("acme/handoff-one", 8)).toMatchObject({ runId: "rerun-first", progressedAt: 9 });
  });

  it("handOff is refused once a newer push replaced the pointer: the newer run keeps it", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/handoff-two", 9, { headSha: "b".repeat(40), runId: "gate-run-newer" });
    expect(await index.handOff("acme/handoff-two", 9, "gate-run-first", { headSha: "a".repeat(40), runId: "rerun-first" }))
      .toBe(false);
    expect(await index.latest("acme/handoff-two", 9)).toMatchObject({ headSha: "b".repeat(40), runId: "gate-run-newer" });
  });

  it("progress stamps only the pointed run; a superseded run's progress changes nothing", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/progress-one", 10, { headSha: "a".repeat(40), runId: "gate-run-live", progressedAt: 1 });
    await index.progress("acme/progress-one", 10, "gate-run-live", 50);
    expect(await index.latest("acme/progress-one", 10)).toMatchObject({ runId: "gate-run-live", progressedAt: 50 });
    await index.progress("acme/progress-one", 10, "gate-run-gone", 99);
    expect(await index.latest("acme/progress-one", 10)).toMatchObject({ runId: "gate-run-live", progressedAt: 50 });
  });
});

describe("d1WatchdogIndex: the watchdog sweep reads stalled pointers on the real table (#1148 item 1)", () => {
  it("stalled returns only pointers stamped inside [notBefore, before], oldest first, with the repo and PR", async () => {
    const base = d1RunIndex(env.DB);
    await base.record("acme/watch-old", 1, { headSha: "a".repeat(40), runId: "gate-old", progressedAt: 100 });
    await base.record("acme/watch-mid", 2, { headSha: "a".repeat(40), runId: "gate-mid", progressedAt: 200 });
    await base.record("acme/watch-fresh", 3, { headSha: "a".repeat(40), runId: "gate-fresh", progressedAt: 900 });
    await base.record("acme/watch-ancient", 4, { headSha: "a".repeat(40), runId: "gate-ancient", progressedAt: 10 });
    const rows = await d1WatchdogIndex(env.DB).stalled(500, 50);
    const mine = rows.filter((r) => r.repo.startsWith("acme/watch-"));
    expect(mine).toEqual([
      { repo: "acme/watch-old", pr: 1, headSha: "a".repeat(40), runId: "gate-old", progressedAt: 100 },
      { repo: "acme/watch-mid", pr: 2, headSha: "a".repeat(40), runId: "gate-mid", progressedAt: 200 },
    ]);
  });

  it("stalled is inclusive at the stall edge: a pointer stamped exactly at `before` is stalled", async () => {
    await d1RunIndex(env.DB).record("acme/watch-edge", 5, { headSha: "a".repeat(40), runId: "gate-edge", progressedAt: 300 });
    const rows = await d1WatchdogIndex(env.DB).stalled(300, 0);
    expect(rows.map((r) => r.runId)).toContain("gate-edge");
  });

  it("adoptUnknown stamps only the 0 stamps, so a live run from before the stamp gets a full window (#1148 item 3)", async () => {
    const base = d1RunIndex(env.DB);
    await base.record("acme/watch-unknown", 6, { headSha: "a".repeat(40), runId: "gate-unknown" });
    await base.record("acme/watch-known", 7, { headSha: "a".repeat(40), runId: "gate-known", progressedAt: 42 });
    await d1WatchdogIndex(env.DB).adoptUnknown(9_000);
    expect(await base.latest("acme/watch-unknown", 6)).toMatchObject({ progressedAt: 9_000 });
    expect(await base.latest("acme/watch-known", 7)).toMatchObject({ progressedAt: 42 });
  });
});

describe("d1RunIndex: a replayed infra handoff finds its own rerun on the pointer (#1148 review, finding 1)", () => {
  it("a handOff replayed after the rerun took the pointer is still true: the replay does not end its own rerun", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/replay-one", 11, { headSha: "a".repeat(40), runId: "gate-replay-first" });
    const handOff = () => index.handOff("acme/replay-one", 11, "gate-replay-first", { headSha: "a".repeat(40), runId: "rerun-replay-first" });
    expect(await handOff()).toBe(true);
    expect(await handOff()).toBe(true);
    expect(await index.latest("acme/replay-one", 11)).toMatchObject({ runId: "rerun-replay-first" });
  });

  it("a replayed launchInfraRerun on the real table: the second start is started, ends nothing, and the pointer stays on the rerun", async () => {
    const repo = "acme/replay-two";
    const index = d1RunIndex(env.DB);
    await index.record(repo, 12, { headSha: "a".repeat(40), runId: "gate-replay-two" });
    let exists = false;
    const terminate = vi.fn(async () => {});
    const start = () => launchInfraRerun({
      create: async () => { if (exists) throw new Error("instance rerun-replay-two already exists"); exists = true; },
      get: async () => { if (!exists) throw new Error("instance not found"); },
      handOff: () => recordInfraRerun(index, {
        repo, pr: 12, headSha: "a".repeat(40), runId: "rerun-replay-two", instanceId: "gate-replay-two", at: 9,
      }),
      terminate,
    });
    expect(await start()).toBe("started");
    expect(await start()).toBe("started");
    expect(terminate).not.toHaveBeenCalled();
    expect(await index.latest(repo, 12)).toMatchObject({ runId: "rerun-replay-two" });
  });
});

describe("the watchdog sweep on the real table: finished runs never starve a hung run (#1148 review, finding 2)", () => {
  it("20 finished runs in the stall band are retired by the first sweep; the second sweep reaches the hung run and reruns it", async () => {
    const T = 1_700_000_000_000;
    const now = T + 60 * 60_000;
    const index = d1RunIndex(env.DB);
    const head = "a".repeat(40);
    for (let i = 1; i <= 20; i++) {
      await index.record("acme/starve-fin", i, { headSha: head, runId: `gate-fin-${i}`, progressedAt: T + i });
    }
    await index.record("acme/starve-hung", 1, { headSha: head, runId: "gate-hung", progressedAt: T + 60_000 });
    const statuses = new Map<string, string>([["gate-hung", "running"]]);
    for (let i = 1; i <= 20; i++) statuses.set(`gate-fin-${i}`, "complete");
    const workflow: WatchdogWorkflow = {
      async create(opts) {
        if (statuses.has(opts.id)) throw new Error(`instance ${opts.id} already exists`);
        statuses.set(opts.id, "running");
        return { id: opts.id };
      },
      async get(id): Promise<GateRunInstance> {
        if (!statuses.has(id)) throw new Error(`instance ${id} not found`);
        return {
          async status() { return { status: statuses.get(id)! }; },
          async terminate() { statuses.set(id, "terminated"); },
        };
      },
    };
    const post = async () => {};
    const headStatus = async () => undefined;
    const first = await sweepStalledRuns({ index: d1WatchdogIndex(env.DB), workflow, post, headStatus, hasRedLeg: async () => false, now: () => now });
    expect(first.filter((r) => r.runId.startsWith("gate-fin-")).every((r) => r.outcome === "skipped")).toBe(true);
    const second = await sweepStalledRuns({ index: d1WatchdogIndex(env.DB), workflow, post, headStatus, hasRedLeg: async () => false, now: () => now });
    expect(second.find((r) => r.runId === "gate-hung")).toEqual({ runId: "gate-hung", outcome: "rerun" });
    expect(await index.latest("acme/starve-hung", 1)).toMatchObject({ runId: "rerun-gate-hung" });
  });
});

describe("d1WatchdogIndex: the stall read is served by an index on progressed_at (#1148 review, minor)", () => {
  it("the stalled query plan searches the progress index, not a full table scan", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${STALLED_RUNS_SQL}`).bind(1, 0).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toContain("gate_pr_head_progressed");
  });
});
