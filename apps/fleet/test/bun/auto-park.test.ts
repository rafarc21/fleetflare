// Board #1448: Worker scheduled auto-park — a running studio whose only open
// board task(s) are `awaiting_merge` and whose lead has sat idle past N min is
// parked resumably, exactly like `fleet destroy <id> --park` (rescue first).
// The decision core is pure and DI'd, the same shape cli/reap.ts's runReap
// uses: every read and write is injected, so each rule is provable without a
// network or a Durable Object.
import { test, expect, describe } from "bun:test";
import {
  autoParkSweep, AUTO_PARK_ACTIVITY_STALE_MS, DEFAULT_AUTO_PARK_IDLE_MINUTES,
  DEFAULT_MAX_BOARD_CALLS, DEFAULT_MAX_PARKS,
  type AutoParkOpenTask, type AutoParkSweepDeps,
} from "../../src/studio/auto-park";
import type { Activity } from "../../src/studio/activity";
import type { BoardTaskState } from "../../src/board/types";
import type { StudioStatus } from "../../src/studio/types";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const MIN = 60_000;
const REPO = "example-org/acmeclient";
const PILOT = "acmeclient--pilot";
const TASK = 1448;

function activity(state: Activity["state"], idleForMs: number): Activity {
  return {
    state,
    since: new Date(NOW.getTime() - idleForMs).toISOString(),
    anchored: true,
    observedAt: new Date(NOW.getTime() - 1000).toISOString(),
    source: "pane",
    reason: null,
    membersTickingAt: null,
  };
}

function studio(over: Record<string, unknown> = {}): StudioStatus {
  return {
    id: PILOT, state: "running", repoSlug: REPO,
    observed: { activity: activity("idle", 45 * MIN), memberAlerts: null },
    ...over,
  } as unknown as StudioStatus;
}

function task(state: BoardTaskState | null, number = TASK): AutoParkOpenTask {
  return { number, state };
}

interface World {
  enabled?: boolean;
  idleThresholdMs?: number;
  activityStaleMs?: number;
  maxBoardCalls?: number;
  maxParks?: number;
  studios: StudioStatus[];
  /** open tasks per studio, or null = board read failed. */
  openTasks?: (studioId: string) => AutoParkOpenTask[] | null;
  park?: (studioId: string) => { ok: boolean; reason?: string };
  inFlight?: (studioId: string) => boolean;
}

function fake(w: World) {
  const parks: string[] = [];
  const boardCalls: string[] = [];
  const comments: { taskNumber: number; body: string }[] = [];
  const deps: AutoParkSweepDeps = {
    enabled: w.enabled ?? true,
    idleThresholdMs: w.idleThresholdMs ?? DEFAULT_AUTO_PARK_IDLE_MINUTES * MIN,
    activityStaleMs: w.activityStaleMs ?? AUTO_PARK_ACTIVITY_STALE_MS,
    maxBoardCalls: w.maxBoardCalls ?? DEFAULT_MAX_BOARD_CALLS,
    maxParks: w.maxParks ?? DEFAULT_MAX_PARKS,
    now: () => NOW,
    listStudios: async () => w.studios,
    openTasks: async (studio) => {
      boardCalls.push(studio.id);
      return w.openTasks ? w.openTasks(studio.id) : [task("awaiting_merge")];
    },
    park: async (studio) => {
      parks.push(studio.id);
      return w.park ? w.park(studio.id) : { ok: true };
    },
    inFlight: w.inFlight ? async (studio) => w.inFlight!(studio.id) : undefined,
    comment: async (_studio, taskNumber, body) => { comments.push({ taskNumber, body }); },
    log: () => {},
  };
  return { deps, parks, boardCalls, comments };
}

describe("auto-park sweep (#1448)", () => {
  test("parks a running studio idle past N min whose only open task is awaiting_merge", async () => {
    const { deps, parks, comments } = fake({ studios: [studio()] });

    const out = await autoParkSweep(deps);

    expect(out).toEqual([{ studioId: PILOT, outcome: "parked", taskNumber: TASK, idleMinutes: 45 }]);
    expect(parks).toEqual([PILOT]);
    expect(comments).toHaveLength(1);
    expect(comments[0].taskNumber).toBe(TASK);
    expect(comments[0].body).toContain(PILOT);
  });

  test("does not park when an open task is working", async () => {
    const { deps, parks, comments } = fake({
      studios: [studio()],
      openTasks: () => [task("working")],
    });

    const out = await autoParkSweep(deps);

    expect(out).toEqual([{ studioId: PILOT, outcome: "skipped", reason: expect.stringContaining("working") }]);
    expect(parks).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });

  test("does not park when an open task is submitted or input_required", async () => {
    for (const state of ["submitted", "input_required"] as BoardTaskState[]) {
      const { deps, parks } = fake({ studios: [studio()], openTasks: () => [task(state)] });
      const out = await autoParkSweep(deps);
      expect(out[0].outcome).toBe("skipped");
      expect(parks).toHaveLength(0);
    }
  });

  test("does not park when a drifted (state-null) open task cannot be confirmed", async () => {
    const { deps, parks } = fake({ studios: [studio()], openTasks: () => [task(null)] });
    const out = await autoParkSweep(deps);
    expect(out[0].outcome).toBe("skipped");
    expect(parks).toHaveLength(0);
  });

  test("does not park when the board read fails (fail closed)", async () => {
    const { deps, parks } = fake({ studios: [studio()], openTasks: () => null });
    const out = await autoParkSweep(deps);
    expect(out[0].outcome).toBe("skipped");
    expect(parks).toHaveLength(0);
  });

  test("does not park when the lead is not idle (working)", async () => {
    const { deps, parks } = fake({
      studios: [studio({ observed: { activity: activity("working", 45 * MIN), memberAlerts: null } })],
    });
    const out = await autoParkSweep(deps);
    expect(out[0].outcome).toBe("skipped");
    expect(parks).toHaveLength(0);
  });

  test("does not park when the lead has been idle less than N min", async () => {
    const { deps, parks } = fake({
      studios: [studio({ observed: { activity: activity("idle", 5 * MIN), memberAlerts: null } })],
    });
    const out = await autoParkSweep(deps);
    expect(out[0].outcome).toBe("skipped");
    expect(parks).toHaveLength(0);
  });

  test("does not park when the idle observation is stale (ticker outage)", async () => {
    const staleObservedAt = new Date(NOW.getTime() - AUTO_PARK_ACTIVITY_STALE_MS - 1000).toISOString();
    const { deps, parks } = fake({
      studios: [studio({
        observed: { activity: { ...activity("idle", 45 * MIN), observedAt: staleObservedAt }, memberAlerts: null },
      })],
    });
    const out = await autoParkSweep(deps);
    expect(out[0].outcome).toBe("skipped");
    expect(out[0].outcome === "skipped" && out[0].reason).toContain("stale");
    expect(parks).toHaveLength(0);
  });

  test("checks activity before the board: a below-threshold idle studio never calls the board", async () => {
    const { deps, boardCalls } = fake({
      studios: [studio({ observed: { activity: activity("idle", 5 * MIN), memberAlerts: null } })],
    });
    const out = await autoParkSweep(deps);
    expect(out[0].outcome).toBe("skipped");
    expect(boardCalls).toHaveLength(0);
  });

  test("caps board calls per sweep", async () => {
    const many = Array.from({ length: DEFAULT_MAX_BOARD_CALLS + 3 }, (_, i) =>
      studio({ id: `acmeclient--pilot--${i}` }),
    );
    const { deps, boardCalls, parks } = fake({ studios: many, maxBoardCalls: DEFAULT_MAX_BOARD_CALLS });
    const out = await autoParkSweep(deps);
    expect(boardCalls.length).toBe(DEFAULT_MAX_BOARD_CALLS);
    expect(parks.length).toBeLessThanOrEqual(DEFAULT_MAX_BOARD_CALLS);
    expect(out.some((o) => o.outcome === "skipped" && o.reason === "board-call cap reached")).toBe(true);
  });

  test("caps parks per sweep", async () => {
    const many = Array.from({ length: DEFAULT_MAX_PARKS + 3 }, (_, i) =>
      studio({ id: `acmeclient--pilot--${i}` }),
    );
    const { deps, parks } = fake({ studios: many, maxParks: DEFAULT_MAX_PARKS });
    const out = await autoParkSweep(deps);
    expect(parks.length).toBe(DEFAULT_MAX_PARKS);
    expect(out.filter((o) => o.outcome === "parked")).toHaveLength(DEFAULT_MAX_PARKS);
    expect(out.some((o) => o.outcome === "skipped" && o.reason === "park cap reached")).toBe(true);
  });

  test("does not park a studio that is not running", async () => {
    const { deps, parks } = fake({ studios: [studio({ state: "stopped" })] });
    const out = await autoParkSweep(deps);
    expect(out).toEqual([]);
    expect(parks).toHaveLength(0);
  });

  test("does not park when a destroy is already in flight", async () => {
    const { deps, parks } = fake({ studios: [studio()], inFlight: () => true });
    const out = await autoParkSweep(deps);
    expect(out[0].outcome).toBe("skipped");
    expect(out[0].outcome === "skipped" && out[0].reason).toContain("in flight");
    expect(parks).toHaveLength(0);
  });

  test("does not park when rescue cannot confirm (park refused)", async () => {
    const { deps, parks, comments } = fake({
      studios: [studio()],
      park: () => ({ ok: false, reason: "rescue-push could not confirm" }),
    });

    const out = await autoParkSweep(deps);

    expect(out[0].outcome).toBe("park-failed");
    expect(parks).toEqual([PILOT]);
    expect(comments).toHaveLength(0);
  });

  test("does nothing when the sweep flag is off", async () => {
    const { deps, parks, comments } = fake({ enabled: false, studios: [studio()] });
    const out = await autoParkSweep(deps);
    expect(out).toEqual([]);
    expect(parks).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });
});