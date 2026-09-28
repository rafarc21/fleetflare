import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { advanceTask, type TaskRecord, type LoopDeps } from "../src/tasks/loop";
import { FakeRuntime } from "../src/agents/runtime";
import { readSince } from "../src/events/log";
import { getApproval, recentApprovalsFor } from "../src/approvals/store";
import type { TaskStatus } from "../src/tasks/types";

let calls: { url: string; body: any }[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
  await env.DB.prepare("DELETE FROM approvals").run();
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      body: JSON.parse(init.body as string),
    });
    return Response.json({ ok: true, result: { message_id: 500 + calls.length } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: "task_1",
  agentId: "cto",
  project: "websites",
  thread: "T1",
  chatId: "100000001",
  liveMessageId: null,
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

const running = (milestones: string[]): TaskStatus => ({
  state: "running", taskId: "task_1",
  milestones: milestones.map((text, i) => ({ ts: 1000 + i, text })),
  pendingApproval: null, result: null, error: null, costUsd: null,
});

describe("advanceTask", () => {
  it("posts the live card on the first poll and keeps its id", async () => {
    const r = new FakeRuntime([running(["cloned repo"])]);
    const out = await advanceTask(deps(r), task());
    expect(out.kind).toBe("continue");
    expect(out.task.liveMessageId).toBe(501);
    expect(calls[0].url).toContain("/sendMessage");
    expect(calls[0].body.text).toContain("cloned repo");
  });

  it("edits the same message on later polls instead of sending a new one", async () => {
    const r = new FakeRuntime([running(["cloned repo", "tests green"])]);
    await advanceTask(deps(r), task({ liveMessageId: 501, shownMilestones: 1 }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/editMessageText");
    expect(calls[0].body.text).toContain("tests green");
  });

  it("does not touch Telegram when no new milestone arrived", async () => {
    const r = new FakeRuntime([running(["cloned repo"])]);
    await advanceTask(deps(r), task({ liveMessageId: 501, shownMilestones: 1 }));
    expect(calls).toHaveLength(0);
  });

  it("logs each new milestone to D1 exactly once", async () => {
    const r = new FakeRuntime([running(["a", "b"]), running(["a", "b", "c"])]);
    const first = await advanceTask(deps(r), task());
    const second = await advanceTask(deps(r), first.task);
    const events = await readSince(env.DB, "cto", 0);
    expect(events.filter((e) => e.kind === "report").map((e) => e.body))
      .toEqual(["a", "b", "c"]);
    expect(second.task.shownMilestones).toBe(3);
  });

  it("on done, sends a NEW buzzing message and stops", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [], pendingApproval: null,
      result: "PR #7 open", error: null, costUsd: 0.42,
    }]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, shownMilestones: 0 }));
    expect(out.kind).toBe("terminal");
    const sends = calls.filter((c) => c.url.includes("/sendMessage"));
    expect(sends).toHaveLength(1);
    expect(sends[0].body.text).toContain("PR #7 open");
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => e.body.includes("PR #7 open"))).toBe(true);
  });

  it("records the reported cost on the terminal event", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [], pendingApproval: null,
      result: "ok", error: null, costUsd: 0.42,
    }]);
    await advanceTask(deps(r), task({ liveMessageId: 501 }));
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => e.body.includes("0.42"))).toBe(true);
  });

  it("on a pending approval, writes the row and sends a keyboard", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [],
      pendingApproval: { action: "merge_staging", params: { repo: "o/r", pr: "7" } },
      result: null, error: null, costUsd: null,
    }]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501 }));
    expect(out.kind).toBe("terminal");
    const send = calls.find((c) => c.url.includes("/sendMessage"))!;
    const buttons = send.body.reply_markup.inline_keyboard[0];
    expect(buttons).toHaveLength(2);
    const id = buttons[0].callback_data.split(":")[0];
    const row = await getApproval(env.DB, id);
    expect(row?.action).toBe("merge_staging");
    expect(row?.params).toEqual({ repo: "o/r", pr: "7" });
    expect(row?.state).toBe("pending");
    // The mock returns 500 + calls.length, so the first send is 501. The row
    // must carry it, or the operator's tap has no message to edit.
    expect(row?.messageId).toBe(501);
  });

  it("on failed, reports the error and stops", async () => {
    const r = new FakeRuntime([{
      state: "failed", taskId: "task_1", milestones: [], pendingApproval: null,
      result: null, error: "claude failed (api_error): 401", costUsd: null,
    }]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501 }));
    expect(out.kind).toBe("terminal");
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => e.body.includes("401"))).toBe(true);
  });

  it("aborts a task that outran maxTaskSeconds", async () => {
    const r = new FakeRuntime([running(["still going"])]);
    const out = await advanceTask(
      deps(r, { now: 1000 + 901_000 }),
      task({ liveMessageId: 501, startedTs: 1000 }),
    );
    expect(out.kind).toBe("terminal");
    expect(r.aborted).toBe(true);
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => /budget|timed out|aborted/i.test(e.body))).toBe(true);
  });

  it("counts a failed poll and keeps going below the threshold", async () => {
    const r = new FakeRuntime([], new Error("container unreachable"));
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, failedPolls: 0 }));
    expect(out.kind).toBe("continue");
    expect(out.task.failedPolls).toBe(1);
    // Fix round 1, Important 2: a sub-threshold poll failure used to write
    // nothing to D1. A transient container failure must be queryable on the
    // first occurrence, not just once it crosses maxFailedPolls.
    const events = await readSince(env.DB, "cto", 0);
    expect(events.some((e) => /unreachable/i.test(e.body))).toBe(true);
  });

  it("declares the task dead after maxFailedPolls consecutive failures", async () => {
    const r = new FakeRuntime([], new Error("container unreachable"));
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, failedPolls: 2 }));
    expect(out.kind).toBe("terminal");
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => /unreachable|lost/i.test(e.body))).toBe(true);
  });

  it("resets the failure counter after a successful poll", async () => {
    const r = new FakeRuntime([running(["back"])]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, failedPolls: 2 }));
    expect(out.kind).toBe("continue");
    expect(out.task.failedPolls).toBe(0);
  });

  it("stamps the heartbeat on every successful poll", async () => {
    const r = new FakeRuntime([running(["x"])]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, lastHeartbeat: 1000 }));
    expect(out.task.lastHeartbeat).toBe(2000);
  });

  // Fix round 1, Important 1: routeDecision restores "only the CTO may
  // address the human" as a structural guarantee, not just a tested-but-
  // unused module. Both human-addressed sends must honor it.
  it("refuses a non-CTO agent's terminal message: logs it, withholds it from Telegram, and reports the refusal", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [], pendingApproval: null,
      result: "sneaky status update", error: null, costUsd: null,
    }]);
    const out = await advanceTask(deps(r), task({ agentId: "not-cto", liveMessageId: 501 }));
    expect(out.kind).toBe("terminal");

    // Logged unconditionally — the log is the record, even of a suppressed
    // message (strictly better than Day 1, which dropped it with no trace).
    const humanEvents = await readSince(env.DB, "human", 0);
    expect(humanEvents.some((e) => e.body === "sneaky status update")).toBe(true);

    // Never reaches Telegram.
    expect(calls).toHaveLength(0);

    // The refusal itself is queryable, not silent.
    const selfEvents = await readSince(env.DB, "not-cto", 0);
    expect(selfEvents.some((e) => /only the cto/i.test(e.body))).toBe(true);
  });

  it("refuses a non-CTO agent's approval request: logs it, sends no keyboard, and reports the refusal", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [],
      pendingApproval: { action: "merge_staging", params: { repo: "o/r", pr: "7" } },
      result: null, error: null, costUsd: null,
    }]);
    const out = await advanceTask(deps(r), task({ agentId: "not-cto", liveMessageId: 501 }));
    expect(out.kind).toBe("terminal");

    const humanEvents = await readSince(env.DB, "human", 0);
    expect(humanEvents.some((e) => e.kind === "approval_request")).toBe(true);
    expect(calls).toHaveLength(0);

    const selfEvents = await readSince(env.DB, "not-cto", 0);
    expect(selfEvents.some((e) => /only the cto/i.test(e.body))).toBe(true);

    // The row is still created — D1 is the record even when Telegram
    // delivery is withheld — but carries no messageId, since no keyboard
    // was ever sent for a human to tap.
    const rows = await recentApprovalsFor(env.DB, "websites", "merge_staging", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBeNull();
  });
});
