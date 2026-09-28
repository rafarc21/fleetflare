import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { advanceTask, type TaskRecord, type LoopDeps, type LoopOutcome } from "../src/tasks/loop";
import { FakeRuntime } from "../src/agents/runtime";
import { readSince } from "../src/events/log";
import {
  toStartInput, shouldAbortOnTerminal, pollOnce, shouldClearRearm, pollAndClearRearm,
  parseMaxTaskSeconds, DEFAULT_MAX_TASK_SECONDS,
} from "../src/agents/do";
import { getFlag, setFlag } from "../src/state";
import { rearmKey } from "../src/tasks/watchdog";

// Day 1's deliver() (formerly here in do.ts) ran one blocking runtime.ask()
// call per Telegram turn and is gone as of Task 3's async task loop. Its
// replacement, advanceTask() (src/tasks/loop.ts), is exhaustively covered by
// test/tasks.loop.test.ts. This file keeps only the migration ledger: each of
// deliver()'s 3 original assertions, and what became of it.
//
//   1. "asks the runtime and logs the reply as a cto->human event"
//      -> "delivers a completed task's result as a cto->human event" below.
//      Note: the event's `kind` changed from "human" to "report" — see
//      report()/terminalMessage() in src/tasks/loop.ts. Not a regression:
//      Day 2 gives status/result updates their own kind instead of
//      overloading "human" for both a live turn and an async result.
//
//   2. "passes the operator's text through to the runtime unchanged"
//      -> "carries the operator's prompt into startTask() unaltered" below.
//      advanceTask() still never sends a prompt; it only polls
//      status()/abort(). Prompt fidelity is a startTask() concern, and
//      Task 5 gives startTask() its first caller: AgentDO.fetch()'s /start
//      handler (src/agents/do.ts). AgentDO itself cannot be constructed
//      under vitest-pool-workers (see test/telegram.webhook.test.ts's
//      "Known gap" note), so the handler's body-to-startTask()-input
//      mapping is extracted as the plain, exported toStartInput() — the
//      same shell-out-the-logic move advanceTask() itself is.
//
//   3. "records a runtime failure as a report rather than losing the turn"
//      -> "declares a task dead after repeated runtime failures instead of
//      losing the turn" below. The old proof the turn wasn't lost was
//      `res.status === 200`; advanceTask() has no HTTP response, so the new
//      proof is `out.kind === "terminal"` — a defined outcome returned to
//      the caller instead of a thrown, unhandled error.
const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: "task_1",
  agentId: "cto",
  project: "websites",
  thread: null,
  chatId: "100000001",
  liveMessageId: 501,
  startedTs: 1000,
  lastHeartbeat: 1000,
  failedPolls: 0,
  shownMilestones: 0,
  ...over,
});

const deps = (runtime: FakeRuntime, over: Partial<LoopDeps> = {}): LoopDeps => ({
  db: env.DB,
  runtime,
  botToken: "T",
  now: 2000,
  maxTaskSeconds: 900,
  maxFailedPolls: 3,
  ...over,
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("advanceTask (formerly deliver())", () => {
  it("delivers a completed task's result as a cto->human event", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [], pendingApproval: null,
      result: "the site is green", error: null, costUsd: null,
    }]);
    const out = await advanceTask(deps(r), task());
    expect(out.kind).toBe("terminal");

    const replies = await readSince(env.DB, "human", 0);
    expect(replies).toHaveLength(1);
    expect(replies[0].from).toBe("cto");
    expect(replies[0].kind).toBe("report");
    expect(replies[0].body).toBe("the site is green");

    // The default network mock 404s every Telegram call, so sendCard threw
    // inside terminalMessage's catch (fix round 1, Important 2). That
    // failure must land in D1 too: a self-addressed report the operator can
    // find even though the live message never arrived.
    const selfReports = await readSince(env.DB, "cto", 0);
    expect(selfReports.some((e) => /telegram delivery failed/.test(e.body))).toBe(true);
  });

  it("declares a task dead after repeated runtime failures instead of losing the turn", async () => {
    const r = new FakeRuntime([], new Error("container unreachable"));
    const out = await advanceTask(deps(r), task({ failedPolls: 2 }));
    expect(out.kind).toBe("terminal");

    const replies = await readSince(env.DB, "human", 0);
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toMatch(/container unreachable/);
  });
});

describe("toStartInput (AgentDO's /start seam)", () => {
  it("carries the operator's prompt into startTask() unaltered", async () => {
    // Successor to Day 1's deleted "passes the operator's text through to
    // the runtime unchanged" — see the migration ledger above. Deliberately
    // ugly text (markup, punctuation, accents, newlines) so any accidental
    // trim/escape/truncate added later to either toStartInput() or
    // AgentDO's /start handler would show up here.
    const weirdPrompt = "deploy the site NOW <script>alert(1)</script> — 100% done? café\nmulti\nline";
    const r = new FakeRuntime([]);

    await r.startTask(toStartInput({
      task: task({ taskId: "task_2" }),
      prompt: weirdPrompt,
      repo: "acme-org/websites",
      ref: "staging",
      ghToken: "gh-token",
    }));

    expect(r.started).toHaveLength(1);
    expect(r.started[0].prompt).toBe(weirdPrompt);
    expect(r.started[0].taskId).toBe("task_2");
    expect(r.started[0].repo).toBe("acme-org/websites");
    expect(r.started[0].ref).toBe("staging");
    expect(r.started[0].ghToken).toBe("gh-token");
  });
});

// Fix round 1 (review response). Two decisions this task owned beyond
// transcribing the brief were both found wrong: aborting a dead container
// can cold-start one (Important 1, guarded in do.ts, not testable here —
// depends on this.ctx.container), and a throw inside advanceTask wedged the
// agent permanently (Important 2). shouldAbortOnTerminal and pollOnce below
// are the two extractions that make the surviving logic unit-testable —
// same move as toStartInput above, same reason.
describe("shouldAbortOnTerminal (Important 3, fix round 1)", () => {
  it("is true once failedPolls reaches MAX_FAILED_POLLS — the dead-container path", () => {
    expect(shouldAbortOnTerminal({ task: task({ failedPolls: 3 }) })).toBe(true);
    expect(shouldAbortOnTerminal({ task: task({ failedPolls: 5 }) })).toBe(true);
  });

  it("is false below the threshold — every other terminal branch's shape", () => {
    expect(shouldAbortOnTerminal({ task: task({ failedPolls: 0 }) })).toBe(false);
    expect(shouldAbortOnTerminal({ task: task({ failedPolls: 2 }) })).toBe(false);
  });
});

describe("pollOnce (Important 2, fix round 1 — proves the wedge is fixed)", () => {
  it("passes a normal outcome through unchanged when advance succeeds", async () => {
    const r = new FakeRuntime([{
      state: "running", taskId: "task_1", milestones: [{ ts: 1, text: "x" }],
      pendingApproval: null, result: null, error: null, costUsd: null,
    }]);
    const result = await pollOnce(deps(r), task());
    expect(result.kind).toBe("continue");
  });

  it("still reaches terminal normally when advance resolves terminal", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [], pendingApproval: null,
      result: "ok", error: null, costUsd: null,
    }]);
    const result = await pollOnce(deps(r), task({ liveMessageId: 501 }));
    expect(result.kind).toBe("terminal");
  });

  it("converts an advanceTask throw into kind:'error' with the pre-poll task, instead of propagating it", async () => {
    // The exact failure mode Important 2 found: an unguarded D1 write
    // inside advanceTask (appendEvent, createApproval) throws. Simulated
    // here via the injected `advance` param rather than a real D1 failure,
    // since forcing one of those specific call sites to throw is not
    // reachable from outside loop.ts.
    const boom = async (_d: LoopDeps, _t: TaskRecord): Promise<LoopOutcome> => {
      throw new Error("D1 write failed");
    };
    const original = task({ failedPolls: 1, liveMessageId: 501 });

    const result = await pollOnce(deps(new FakeRuntime([])), original, boom);

    expect(result.kind).toBe("error");
    // pollTask (do.ts) persists exactly this and reschedules on any
    // non-terminal kind — the pre-poll task coming back unchanged, rather
    // than the throw propagating out of pollOnce uncaught, is what stops
    // the wedge: without it, the Container library's alarm() deletes the
    // firing schedule row unconditionally and nothing ever reschedules,
    // while TASK_KEY is never cleared — every later /start would 409
    // forever.
    expect(result.task).toEqual(original);
  });
});

// Fix round 1 (task 10a review, Important finding). clearRearm was wired to
// the wrong signal: called unconditionally at the TOP of pollTask, before
// pollOnce ran, so it cleared on "the schedule fired" rather than "the poll
// succeeded." A persistent advanceTask throw (pollOnce's kind:"error", with
// lastHeartbeat frozen) would then have the counter reset every 5s while the
// cron (scheduled(), src/index.ts) only reads it every 60s — making its
// "two in a row" alert structurally unreachable for exactly the failure
// class the watchdog exists to catch. shouldClearRearm is the extracted
// decision, gating clearRearm to fire only after pollOnce actually returns —
// same reason shouldAbortOnTerminal/pollOnce above are extracted: pollTask
// itself (an AgentDO method) cannot be constructed under
// vitest-pool-workers, so the call site is reduced to a single gated call.
describe("shouldClearRearm (Important finding, fix round 1 — task 10a)", () => {
  it("is true when the poll actually completed — continue", () => {
    expect(shouldClearRearm({ kind: "continue" })).toBe(true);
  });

  it("is true when the poll actually completed — terminal", () => {
    expect(shouldClearRearm({ kind: "terminal" })).toBe(true);
  });

  it("is false when advanceTask itself threw — error", () => {
    // The exact case the fix targets: a persistent throw must NOT clear the
    // counter, or scheduled()'s attempts >= 2 check can never observe two
    // consecutive non-zero reads.
    expect(shouldClearRearm({ kind: "error" })).toBe(false);
  });
});

// MUST FIX 2 (final-review fix wave). clearRearm -> setFlag -> a real D1
// write -> sat unguarded between pollOnce and pollTask's own
// storage.put/schedule (continue) or storage.delete (terminal). A throw
// there stopped pollTask before either ran: no schedule survives (the
// Container library's alarm() deletes the firing row regardless), TASK_KEY
// never clears, every later /start 409s forever — the exact wedge f970d85
// fixed, reopened by this one remaining call. pollAndClearRearm folds the
// guarded call into the same testable seam as pollOnce.
describe("pollAndClearRearm (MUST FIX 2 — the wedge f970d85 closed, reopened)", () => {
  it("clears an existing counter after a poll that actually completes", async () => {
    await setFlag(env.DB, rearmKey("task_1"), "3", 500);
    const r = new FakeRuntime([{
      state: "running", taskId: "task_1", milestones: [],
      pendingApproval: null, result: null, error: null, costUsd: null,
    }]);

    const result = await pollAndClearRearm(deps(r), task());

    expect(result.kind).toBe("continue");
    expect(await getFlag(env.DB, rearmKey("task_1"))).toBe("0");
  });

  it("leaves the counter alone when advanceTask itself threw", async () => {
    await setFlag(env.DB, rearmKey("task_1"), "3", 500);
    const boom = async (_d: LoopDeps, _t: TaskRecord): Promise<LoopOutcome> => {
      throw new Error("D1 write failed");
    };

    const result = await pollAndClearRearm(deps(new FakeRuntime([])), task(), boom);

    expect(result.kind).toBe("error");
    expect(await getFlag(env.DB, rearmKey("task_1"))).toBe("3");
  });

  it("still returns a reschedulable outcome when clearRearm's own write throws", async () => {
    // The exact failure this closes: poison only the fleet_state UPSERT
    // clearRearm issues, leaving everything advanceTask itself needs
    // (events, approvals) hitting the real DB, same poisoning technique as
    // test/approvals.gates.test.ts's finishApproval(executed) case.
    const realPrepare = env.DB.prepare.bind(env.DB);
    const poisonedDb = {
      prepare(sql: string) {
        if (sql.startsWith("INSERT INTO fleet_state")) {
          return { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) };
        }
        return realPrepare(sql);
      },
    } as unknown as D1Database;
    const r = new FakeRuntime([{
      state: "running", taskId: "task_1", milestones: [],
      pendingApproval: null, result: null, error: null, costUsd: null,
    }]);

    const result = await pollAndClearRearm(deps(r, { db: poisonedDb }), task());

    // pollTask (do.ts) does `if (result.kind === "terminal") ... else
    // storage.put + schedule` unconditionally on whatever this returns —
    // never on whether clearRearm itself succeeded. A throw escaping here
    // instead, left unguarded, would stop pollTask before either branch runs.
    expect(result.kind).toBe("continue");
  });
});

// Carve-out A (final-review fix wave). Number(this.env.MAX_TASK_SECONDS ??
// 900) has no finite guard: a typo'd var yields NaN, and advanceTask's
// budget check `(now - start)/1000 > NaN` is always false — silently
// disabling the only cost ceiling on an opus agent.
describe("parseMaxTaskSeconds (Carve-out A)", () => {
  it("uses the default when unset", () => {
    expect(parseMaxTaskSeconds(undefined)).toBe(DEFAULT_MAX_TASK_SECONDS);
  });

  it("parses a configured value", () => {
    expect(parseMaxTaskSeconds("120")).toBe(120);
  });

  it("falls back to the default on a non-numeric value instead of NaN", () => {
    expect(parseMaxTaskSeconds("not-a-number")).toBe(DEFAULT_MAX_TASK_SECONDS);
  });
});
