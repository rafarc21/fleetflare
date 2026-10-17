import { describe, it, expect, vi } from "vitest";
import {
  shouldAutoContinue, autoContinuePrompt, idleAutoContinue,
  AUTO_CONTINUE_MAX_NUDGES, AUTO_CONTINUE_KEY, type AutoContinueState,
} from "../src/studio/auto-continue";
import type { Activity } from "../src/studio/activity";
import type { BoardTaskState } from "../src/board/types";

const T0 = new Date("2026-10-17T12:00:00.000Z");
const MIN = 60_000;

function idle(since: Date): Activity {
  return { state: "idle", since: since.toISOString(), anchored: true, observedAt: since.toISOString(), source: "pane", reason: null, membersTickingAt: null };
}
const task = (state: BoardTaskState | null, open = true) => ({ number: 77, state, open });
const base = {
  leadType: "glm" as const,
  activity: idle(new Date(T0.getTime() - 11 * MIN)),
  now: T0,
  task: task("submitted"),
  lastNudgeAt: null,
  nudgeCountForTask: 0,
  alreadyEscalated: false,
};

describe("shouldAutoContinue", () => {
  it("fires for a glm lead idle >= 10 min on an open submitted task", () => {
    expect(shouldAutoContinue(base)).toEqual({ kind: "nudge", taskNumber: 77 });
  });
  it("refuses a claude lead", () => {
    expect(shouldAutoContinue({ ...base, leadType: "claude" })).toEqual({ kind: "none" });
  });
  it("refuses idle under 10 minutes", () => {
    expect(shouldAutoContinue({ ...base, activity: idle(new Date(T0.getTime() - 9 * MIN)) })).toEqual({ kind: "none" });
  });
  it("fires for a working task", () => {
    expect(shouldAutoContinue({ ...base, task: task("working") })).toEqual({ kind: "nudge", taskNumber: 77 });
  });
  it("refuses awaiting_merge", () => {
    expect(shouldAutoContinue({ ...base, task: task("awaiting_merge") })).toEqual({ kind: "none" });
  });
  it("refuses input_required", () => {
    expect(shouldAutoContinue({ ...base, task: task("input_required") })).toEqual({ kind: "none" });
  });
  it("refuses a terminal state", () => {
    expect(shouldAutoContinue({ ...base, task: task("completed") })).toEqual({ kind: "none" });
  });
  it("refuses a closed task", () => {
    expect(shouldAutoContinue({ ...base, task: task("submitted", false) })).toEqual({ kind: "none" });
  });
  it("refuses no task", () => {
    expect(shouldAutoContinue({ ...base, task: null })).toEqual({ kind: "none" });
  });
  it("refuses a non-idle activity state (modal / working / waiting)", () => {
    for (const state of ["working", "waiting-members", "waiting-question", "limit", "unknown"] as const) {
      expect(shouldAutoContinue({ ...base, activity: { ...idle(T0), state } })).toEqual({ kind: "none" });
    }
  });
  it("refuses a nudge within the 20-minute rate window", () => {
    expect(shouldAutoContinue({ ...base, lastNudgeAt: new Date(T0.getTime() - 5 * MIN).toISOString() })).toEqual({ kind: "none" });
  });
  it("fires again once the 20-minute window has elapsed", () => {
    expect(shouldAutoContinue({ ...base, lastNudgeAt: new Date(T0.getTime() - 21 * MIN).toISOString() })).toEqual({ kind: "nudge", taskNumber: 77 });
  });
  it("escalates instead of the 7th nudge for one task", () => {
    expect(shouldAutoContinue({ ...base, nudgeCountForTask: AUTO_CONTINUE_MAX_NUDGES })).toEqual({ kind: "escalate", taskNumber: 77 });
  });
  it("stays silent after the escalation for that task", () => {
    expect(shouldAutoContinue({ ...base, nudgeCountForTask: AUTO_CONTINUE_MAX_NUDGES, alreadyEscalated: true })).toEqual({ kind: "none" });
  });
});

describe("autoContinuePrompt", () => {
  it("names the task number and the do-not-stop instruction", () => {
    expect(autoContinuePrompt(77)).toBe("Continue your board task #77 now; do not stop between steps.");
  });
});

describe("idleAutoContinue (tick side effect)", () => {
  const fakeStorage = () => {
    const map = new Map<string, unknown>();
    return {
      map,
      get: (async (key: string) => map.get(key)) as never,
      put: (async (key: string, value: unknown) => { map.set(key, value); }) as never,
    };
  };

  it("skips the board read while rate-limited and under the cap", async () => {
    const storage = fakeStorage();
    const prev: AutoContinueState = { taskNumber: 77, nudgeCount: 1, lastNudgeAt: new Date(T0.getTime() - 5 * MIN).toISOString(), escalated: false };
    storage.map.set(AUTO_CONTINUE_KEY, prev);
    const findTask = vi.fn(async () => task("submitted"));
    const wake = vi.fn(async () => ({ ok: true }));
    const escalate = vi.fn(async () => {});
    await idleAutoContinue(
      { now: () => T0, leadType: "glm", activity: idle(new Date(T0.getTime() - 11 * MIN)), findTask, wake, escalate },
      storage as never, "acme--pilot",
    );
    expect(findTask).not.toHaveBeenCalled();
  });

  it("nudges and stamps count + lastNudgeAt when due", async () => {
    const storage = fakeStorage();
    const findTask = vi.fn(async () => task("submitted"));
    const wake = vi.fn(async () => ({ ok: true }));
    const escalate = vi.fn(async () => {});
    await idleAutoContinue(
      { now: () => T0, leadType: "glm", activity: idle(new Date(T0.getTime() - 11 * MIN)), findTask, wake, escalate },
      storage as never, "acme--pilot",
    );
    expect(wake).toHaveBeenCalledWith("Continue your board task #77 now; do not stop between steps.");
    expect(storage.map.get(AUTO_CONTINUE_KEY)).toEqual({ taskNumber: 77, nudgeCount: 1, lastNudgeAt: T0.toISOString(), escalated: false });
  });

  it("escalates instead of a 7th nudge and marks escalated", async () => {
    const storage = fakeStorage();
    const prev: AutoContinueState = { taskNumber: 77, nudgeCount: AUTO_CONTINUE_MAX_NUDGES, lastNudgeAt: new Date(T0.getTime() - 25 * MIN).toISOString(), escalated: false };
    storage.map.set(AUTO_CONTINUE_KEY, prev);
    const findTask = vi.fn(async () => task("working"));
    const wake = vi.fn(async () => ({ ok: true }));
    const escalate = vi.fn(async () => {});
    await idleAutoContinue(
      { now: () => T0, leadType: "glm", activity: idle(new Date(T0.getTime() - 11 * MIN)), findTask, wake, escalate },
      storage as never, "acme--pilot",
    );
    expect(wake).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledWith(77);
    expect(storage.map.get(AUTO_CONTINUE_KEY)).toMatchObject({ escalated: true, taskNumber: 77 });
  });
});