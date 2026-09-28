import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { staleTasks, rearmKey, clearRearm, alertedKey, shouldAlert } from "../src/tasks/watchdog";
import { getFlag, setFlag } from "../src/state";
import type { TaskRecord } from "../src/tasks/loop";

const rec = (over: Partial<TaskRecord>): TaskRecord => ({
  taskId: "t", agentId: "cto", project: "websites", thread: null,
  chatId: "1", liveMessageId: null, startedTs: 0, lastHeartbeat: 0,
  failedPolls: 0, shownMilestones: 0, ...over,
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("staleTasks", () => {
  it("ignores agents with no running task", () => {
    expect(staleTasks([null, null], 1_000_000)).toEqual([]);
  });

  it("ignores a task polled within the threshold", () => {
    expect(staleTasks([rec({ lastHeartbeat: 1_000_000 })], 1_000_000 + 179_000)).toEqual([]);
  });

  it("flags a task whose schedule stopped firing", () => {
    const out = staleTasks([rec({ lastHeartbeat: 1_000_000 })], 1_000_000 + 181_000);
    expect(out).toHaveLength(1);
    expect(out[0].staleMs).toBe(181_000);
  });

  it("is exclusive at exactly the threshold", () => {
    expect(staleTasks([rec({ lastHeartbeat: 0 })], 180_000)).toEqual([]);
    expect(staleTasks([rec({ lastHeartbeat: 0 })], 180_001)).toHaveLength(1);
  });
});

// rearmKey is shared by scheduled() (increments, src/index.ts) and pollTask
// (clears, src/agents/do.ts) so the two sides can't drift onto different key
// formats for the same task — same DRY reasoning as MAX_FAILED_POLLS in do.ts.
describe("rearmKey", () => {
  it("namespaces by taskId so different tasks can't collide", () => {
    expect(rearmKey("task_1")).toBe("rearm:task_1");
    expect(rearmKey("task_2")).toBe("rearm:task_2");
  });
});

// The trap named in the dispatch: if pollTask never clears this counter, a
// long task accumulates it across unrelated, already-self-healed hiccups and
// eventually trips the "two in a row" alert on two hiccups that were never
// actually consecutive. clearRearm is the fix; these tests are what "wire
// that clear into pollTask, and test it" cashes out to, since pollTask itself
// (a Container/AgentDO method) cannot be constructed under
// vitest-pool-workers — see agents.do.test.ts's identical extraction of
// shouldAbortOnTerminal/pollOnce for the same reason.
describe("clearRearm", () => {
  it("resets an existing counter to 0", async () => {
    await setFlag(env.DB, rearmKey("task_1"), "3", 1000);
    await clearRearm(env.DB, "task_1", 2000);
    expect(await getFlag(env.DB, rearmKey("task_1"))).toBe("0");
  });

  it("is a harmless write when no counter has ever been set", async () => {
    await clearRearm(env.DB, "never-stale", 1000);
    expect(await getFlag(env.DB, rearmKey("never-stale"))).toBe("0");
  });

  it("does not disturb a different task's counter", async () => {
    await setFlag(env.DB, rearmKey("task_A"), "5", 1000);
    await clearRearm(env.DB, "task_B", 2000);
    expect(await getFlag(env.DB, rearmKey("task_A"))).toBe("5");
  });
});

// Carve-out C (final-review fix wave). Namespaced separately from rearmKey:
// re-arm attempts and "has the operator been told" are different questions
// about the same stale task, and scheduled() (src/index.ts) reads/writes
// both every minute it stays stale.
describe("alertedKey", () => {
  it("namespaces by taskId so different tasks can't collide", () => {
    expect(alertedKey("task_1")).toBe("alerted:task_1");
    expect(alertedKey("task_2")).toBe("alerted:task_2");
  });

  it("does not collide with rearmKey's namespace", () => {
    expect(alertedKey("task_1")).not.toBe(rearmKey("task_1"));
  });
});

// The trap named in the carve-out: scheduled() used to re-send the identical
// Telegram message every single minute a task stayed stuck, forever — no
// backoff, no dedupe. shouldAlert is the extracted decision; the caller
// (index.ts) persists alertedKey only after a successful send.
describe("shouldAlert (Carve-out C)", () => {
  it("is false below the two-consecutive-failures threshold", () => {
    expect(shouldAlert(0, false)).toBe(false);
    expect(shouldAlert(1, false)).toBe(false);
  });

  it("is true the first time the threshold is crossed", () => {
    expect(shouldAlert(2, false)).toBe(true);
    expect(shouldAlert(5, false)).toBe(true);
  });

  it("is false once already alerted, however high attempts climbs — the fix itself", () => {
    expect(shouldAlert(2, true)).toBe(false);
    expect(shouldAlert(50, true)).toBe(false);
  });
});
