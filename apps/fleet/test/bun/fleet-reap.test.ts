// Issue #53: `fleet reap` — idle studios bill for hours with zero events.
// This suite covers cli/reap.ts's testable core, `runReap`: the stall alarm,
// the opt-in reap, and every guard between "the listing says IDLE" and a
// destroy. Every read and every write is injected through fakes — never a
// real studio, board or container.
//
// bun:test lane (CLI code, same reason rescue-all-scope.test.ts gives).
import { test, expect, describe } from "bun:test";
import {
  runReap, formatIdleAlarm, parseIdleDuration, emptyReapState, destroyRaceOutcome, chromeRefusal,
  REAP_BACKOFF_MS, STALL_ALARM_EVERY_MS, STALL_AFTER_MS, REAP_LIVE_READ_MAX_MS,
  type ReapDeps, type ReapFlags, type ReapInspect, type ReapState, type ReapDestroyResult, type NudgeOutcome,
} from "../../cli/reap";
import { REAL_WEBSTUDIO_PANE } from "../fixtures/rate-limit-panes";
import { parseCliArgs } from "../../src/studio/cli-args";
import { WORKING_GLYPH_DOT_FOOTER_ESC_PANE } from "../fixtures/activity-panes";
import type { StudioStatus } from "../../src/studio/types";
import { type Activity, nextActivity, readActivityFrame } from "../../src/studio/activity";
import type { BoardTask, BoardTaskState } from "../../src/board/types";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const MIN = 60_000;
const REPO = "example-org/acmeclient";
const PILOT = "acmeclient--pilot";
const WEB = "acmeclient--web-studio";

// A real captured idle pane (turn ended, empty input box), with its member
// row and its "7 shells" chrome removed: the one shape reap may act on.
const MEMBER_ROW = /\n[^\n]*◯ frontend-developer[^\n]*/;
// The captured input box held typed-but-unsent text; emptied here.
const TYPED = "❯\u00a0check on task 2 progress"; // claude draws a no-break space after ❯
const strip = (p: string) => p.replace(" · 7 shells still running", "").replace(" · 7 shells", "");
const CLEAN_IDLE = strip(REAL_WEBSTUDIO_PANE.replace(MEMBER_ROW, "")).replace(TYPED, "❯\u00a0");
// Idle, clean chrome, but text typed into the input box and not yet sent.
const IDLE_WITH_TYPED_TEXT = strip(REAL_WEBSTUDIO_PANE.replace(MEMBER_ROW, ""));
// The clean pane with a live spinner on its status line: a running turn and
// NOTHING else to trip on (no member row, no shells) — isolates the frame check.
const CLEAN_WORKING = CLEAN_IDLE.replace("✻ Cooked for 36m 35s", "✻ Cogitating… (3s · esc to interrupt)");
// Same idle pane, member row still under the footer: the lead is idle but a
// background agent may still be running.
const IDLE_WITH_MEMBER = strip(REAL_WEBSTUDIO_PANE).replace(TYPED, "❯\u00a0");
// Same idle pane, background shells still running.
const IDLE_WITH_SHELLS = REAL_WEBSTUDIO_PANE.replace(MEMBER_ROW, "").replace(TYPED, "❯\u00a0");
// Clean idle pane whose footer carries a counter reap does not know.
const IDLE_WITH_UNKNOWN_COUNTER = CLEAN_IDLE.replace("⏵⏵ bypass permissions on ·", "⏵⏵ bypass permissions on · 2 monitors ·");
// Clean idle pane whose turn-ended row says background work is still running.
const IDLE_WITH_BG_TASK = CLEAN_IDLE.replace("✻ Cooked for 36m 35s", "✻ Cooked for 36m 35s · 1 background task still running");
// Every studio in a real board has task history (state=all); never zero rows.
const HISTORY: BoardTask[] = [task(1, WEB, "completed", false)];

function activity(state: Activity["state"], idleForMs: number, observedAgoMs = 0): Activity {
  return {
    state,
    since: new Date(NOW.getTime() - idleForMs).toISOString(),
    anchored: true,
    observedAt: new Date(NOW.getTime() - observedAgoMs).toISOString(),
    source: "pane",
    reason: null,
    membersTickingAt: null,
  };
}

function studio(id: string, act: Activity | null, over: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id, state: "running", repoSlug: REPO,
    observed: { activity: act, memberAlerts: null },
    ...over,
  } as StudioStatus;
}

function task(number: number, assignee: string | null, state: BoardTaskState | null = "working", open = true): BoardTask {
  return {
    number, url: "", title: `t${number}`, body: "", state,
    labels: assignee ? [`studio:${assignee}`] : [], assignee, milestone: null, open, updatedAt: NOW.toISOString(),
  };
}

function flags(over: Partial<ReapFlags> = {}): ReapFlags {
  return { apply: true, idleMs: 30 * MIN, repo: REPO, ...over };
}

interface World {
  studios: StudioStatus[];
  board: BoardTask[] | Error;
  /** issue #1121: GitHub's non-PR issue count (all states). Default: board.length. */
  boardTotal?: number | Error;
  studioTasks?: (id: string) => BoardTask[] | Error;
  /** n = 1 for the cheap pre-check, 2 for the read right before destroy. */
  inspect?: (id: string, n: number) => ReapInspect;
  /** Runs after each call is recorded; may move the fake clock. */
  after?: (call: string, clock: { t: number }) => void;
  loadStateError?: Error;
  rescue?: (id: string) => { ok: true } | { ok: false; error: string };
  destroy?: (id: string) => ReapDestroyResult;
  /** --nudge's wake (issue #1098). Default: woke. A thrown Error throws. */
  nudge?: (id: string, taskNumber: number) => NudgeOutcome | Error;
  state?: ReapState;
  now?: Date;
}

function goodInspect(): Extract<ReapInspect, { ok: true }> {
  return { ok: true, tail: CLEAN_IDLE, capturedAt: NOW.getTime() / 1000, activity: activity("idle", 45 * MIN) };
}

function fake(w: World) {
  const calls: string[] = [];
  const lines: string[] = [];
  let saved: ReapState | null = null;
  const clock = { t: (w.now ?? NOW).getTime() };
  const inspects = new Map<string, number>();
  const push = (c: string) => { calls.push(c); w.after?.(c, clock); };
  const deps: ReapDeps = {
    now: () => new Date(clock.t),
    listStudios: async () => w.studios,
    listBoard: async () => {
      push("board");
      if (w.board instanceof Error) throw w.board;
      return w.board;
    },
    boardTotal: async () => {
      push("total");
      if (w.boardTotal instanceof Error) throw w.boardTotal;
      return w.boardTotal ?? (w.board instanceof Error ? 0 : w.board.length);
    },
    studioTasks: async (id) => {
      push(`tasks:${id}`);
      const r = w.studioTasks ? w.studioTasks(id) : [];
      if (r instanceof Error) throw r;
      return r;
    },
    inspect: async (id) => {
      const n = (inspects.get(id) ?? 0) + 1;
      inspects.set(id, n);
      push(`inspect:${id}`);
      const r = w.inspect ? w.inspect(id, n) : goodInspect();
      // A real capture is stamped when it is taken: at the (possibly moved) clock.
      return r.ok && r.capturedAt === NOW.getTime() / 1000 ? { ...r, capturedAt: clock.t / 1000 } : r;
    },
    rescue: async (id) => {
      push(`rescue:${id}`);
      return w.rescue ? w.rescue(id) : { ok: true };
    },
    destroy: async (id) => {
      push(`destroy:${id}`);
      return w.destroy ? w.destroy(id) : { outcome: "destroyed" };
    },
    nudge: async (id, taskNumber) => {
      push(`nudge:${id}:${taskNumber}`);
      const r = w.nudge ? w.nudge(id, taskNumber) : { woke: true as const };
      if (r instanceof Error) throw r;
      return r;
    },
    loadState: async () => {
      if (w.loadStateError) throw w.loadStateError;
      return structuredClone(w.state ?? emptyReapState());
    },
    saveState: async (s) => { saved = s; },
    log: (line) => lines.push(line),
  };
  return { deps, calls, lines, saved: () => saved };
}

const IDLE_45 = () => studio(PILOT, activity("idle", 45 * MIN));

describe("reap — the happy path", () => {
  test("idle past the threshold, no open task, rescue ok, live pane idle -> destroyed, rescue first", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY });
    const out = await runReap(flags(), f.deps);
    expect(out.exitCode).toBe(0);
    expect(f.calls).toEqual([
      "board", `inspect:${PILOT}`, `rescue:${PILOT}`, `tasks:${PILOT}`, `inspect:${PILOT}`, `destroy:${PILOT}`,
    ]);
    expect(f.lines.some((l) => l.startsWith(`REAPED ${PILOT}`))).toBe(true);
  });
});

describe("reap — never a studio with a running turn", () => {
  test("listing says WORKING -> no rescue, no destroy", async () => {
    const f = fake({ studios: [studio(PILOT, activity("working", 45 * MIN))], board: HISTORY });
    await runReap(flags(), f.deps);
    expect(f.calls.filter((c) => c.startsWith("rescue") || c.startsWith("destroy"))).toEqual([]);
  });

  for (const state of ["waiting-members", "waiting-question", "limit", "unknown"] as const) {
    test(`listing says ${state} -> no destroy`, async () => {
      const f = fake({ studios: [studio(PILOT, activity(state, 45 * MIN))], board: HISTORY });
      await runReap(flags(), f.deps);
      expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
    });
  }

  test("listing activity missing -> no destroy", async () => {
    const f = fake({ studios: [studio(PILOT, null)], board: HISTORY });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("listing activity stale (mirror older than its budget) -> no destroy", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 45 * MIN, 20 * MIN))], board: HISTORY });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("rescue") || c.startsWith("destroy"))).toBe(false);
  });

  test("a current member alert -> no destroy", async () => {
    const s = studio(PILOT, activity("idle", 45 * MIN));
    s.observed!.memberAlerts = [{ kind: "member-gone", at: NOW.toISOString(), detail: "x", confidence: "inferred" } as never];
    const f = fake({ studios: [s], board: HISTORY });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("idle but below the threshold -> no destroy", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 10 * MIN))], board: HISTORY });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("rescue") || c.startsWith("destroy"))).toBe(false);
  });

  test("a stopped or degraded studio is never touched", async () => {
    const f = fake({
      studios: [
        studio(PILOT, activity("idle", 45 * MIN), { state: "stopped" }),
        studio(WEB, activity("idle", 45 * MIN), { state: "degraded" }),
      ],
      board: HISTORY,
    });
    await runReap(flags(), f.deps);
    expect(f.calls).toEqual(["board"]);
  });

  test("the live pane shows a running turn at destroy time -> no destroy", async () => {
    const f = fake({
      studios: [IDLE_45()], board: HISTORY,
      inspect: () => ({ ...goodInspect(), tail: WORKING_GLYPH_DOT_FOOTER_ESC_PANE }),
    });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the live pane shows a running turn, no member row, no shells -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), tail: CLEAN_WORKING }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the live pane is idle but a member row sits under the footer -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), tail: IDLE_WITH_MEMBER }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the live pane is idle but background shells still run -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), tail: IDLE_WITH_SHELLS }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the DO's own activity says working at destroy time -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), activity: activity("working", 45 * MIN) }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the DO's own activity is stale at destroy time -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), activity: activity("idle", 45 * MIN, 5 * MIN) }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the DO's own idle began after the threshold window (a turn ran since the listing) -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), activity: activity("idle", 1 * MIN) }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the live capture is old -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), capturedAt: NOW.getTime() / 1000 - 600 }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("inspect fails -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ok: false, message: "container did not answer" }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });
});

describe("reap — open task: stall alarm, not reap", () => {
  test("idle >= 10m with an open task -> STALL line, no rescue, no destroy", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 12 * MIN))], board: [task(7, PILOT)] });
    await runReap(flags(), f.deps);
    expect(f.lines.some((l) => l.startsWith(`STALL ${PILOT}`) && l.includes("#7"))).toBe(true);
    expect(f.calls.some((c) => c.startsWith("rescue") || c.startsWith("destroy"))).toBe(false);
  });

  test("idle < 10m with an open task -> no STALL line", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 5 * MIN))], board: [task(7, PILOT)] });
    await runReap(flags(), f.deps);
    expect(f.lines.some((l) => l.startsWith("STALL"))).toBe(false);
  });

  test("a terminal-state task does not count as open (reapable)", async () => {
    const f = fake({ studios: [IDLE_45()], board: [task(7, PILOT, "completed")] });
    await runReap(flags(), f.deps);
    expect(f.calls).toContain(`destroy:${PILOT}`);
  });

  // Board issue #110: awaiting_merge is neither terminal nor live — the
  // lead's part is already done, so a studio whose only open task is in this
  // state is eligible for reap, same as one whose only task is terminal.
  test("an awaiting_merge task does not count as open (reapable) either", async () => {
    const f = fake({ studios: [IDLE_45()], board: [task(7, PILOT, "awaiting_merge")] });
    await runReap(flags(), f.deps);
    expect(f.calls).toContain(`destroy:${PILOT}`);
  });

  test("a drifted (no state label) open task counts as open", async () => {
    const f = fake({ studios: [IDLE_45()], board: [task(7, PILOT, null)] });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the STALL alarm fires once per 15m per studio", async () => {
    // Each poll sees a freshly mirrored observation, idle since the same instant.
    const at = (offsetMs: number) => [studio(PILOT, activity("idle", 12 * MIN, -offsetMs))];
    const first = fake({ studios: at(0), board: [task(7, PILOT)] });
    await runReap(flags(), first.deps);
    const state1 = first.saved()!;
    const soon = fake({ studios: at(5 * MIN), board: [task(7, PILOT)], state: state1, now: new Date(NOW.getTime() + 5 * MIN) });
    await runReap(flags(), soon.deps);
    expect(soon.lines.some((l) => l.startsWith("STALL"))).toBe(false);
    const later = fake({
      studios: at(STALL_ALARM_EVERY_MS), board: [task(7, PILOT)], state: soon.saved()!,
      now: new Date(NOW.getTime() + STALL_ALARM_EVERY_MS),
    });
    await runReap(flags(), later.deps);
    expect(later.lines.some((l) => l.startsWith(`STALL ${PILOT}`))).toBe(true);
  });

  // #86: a lead waiting on its own background shell/monitor is not idle.
  // The mirror is built the way the DO builds it: prev idle 12m, this frame.
  for (const [name, pane] of [["shells", IDLE_WITH_SHELLS], ["monitors", IDLE_WITH_UNKNOWN_COUNTER], ["background task", IDLE_WITH_BG_TASK]] as const) {
    test(`idle frame with live ${name} + open task -> no STALL line, no idle alarm`, async () => {
      const mirrored = nextActivity(activity("idle", 12 * MIN, 30_000), readActivityFrame(pane), null, null, NOW);
      const studios = [studio(PILOT, mirrored)];
      const f = fake({ studios, board: [task(7, PILOT)] });
      await runReap(flags(), f.deps);
      expect(f.lines.some((l) => l.startsWith("STALL"))).toBe(false);
      expect(formatIdleAlarm(studios, NOW)).toBeNull();
    });
  }

  test("the STALL alarm runs in dry-run too", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 12 * MIN))], board: [task(7, PILOT)] });
    await runReap(flags({ apply: false }), f.deps);
    expect(f.lines.some((l) => l.startsWith(`STALL ${PILOT}`))).toBe(true);
  });

  test("STALL_AFTER_MS is 10 minutes", () => {
    expect(STALL_AFTER_MS).toBe(10 * MIN);
  });
});

describe("reap — the race: a task filed between list and destroy", () => {
  test("fresh per-studio read shows a live task -> skip", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, studioTasks: () => [task(9, PILOT, "submitted")] });
    await runReap(flags(), f.deps);
    expect(f.calls).toContain(`tasks:${PILOT}`);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("fresh per-studio read fails -> skip", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, studioTasks: () => new Error("502") });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the fresh task read happens after rescue; the last live read is the call right before destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY });
    await runReap(flags(), f.deps);
    const d = f.calls.indexOf(`destroy:${PILOT}`);
    expect(f.calls[d - 1]).toBe(`inspect:${PILOT}`);
    expect(f.calls.indexOf(`tasks:${PILOT}`)).toBeGreaterThan(f.calls.indexOf(`rescue:${PILOT}`));
  });
});

// Review F1: the gap between the last live read and the destroy must be
// bounded. A slow board read may not sit inside it, and a turn that starts
// while reap is busy must be seen.
describe("reap — F1: bounded gap between live read and destroy", () => {
  test("a turn starts during a slow fresh board read -> the final live read sees it -> skip", async () => {
    const f = fake({
      studios: [IDLE_45()], board: HISTORY,
      after: (c, clock) => { if (c.startsWith("tasks:")) clock.t += 5 * MIN; },
      inspect: (_id, n) => (n === 1 ? goodInspect() : { ...goodInspect(), tail: CLEAN_WORKING }),
    });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the final live read itself took longer than the budget -> skip", async () => {
    let n = 0;
    const f = fake({
      studios: [IDLE_45()], board: HISTORY,
      // The final inspect answers 60s after it was asked.
      after: (c, clock) => { if (c.startsWith("inspect:") && ++n === 2) clock.t += 60_000; },
      inspect: () => ({ ...goodInspect(), capturedAt: NOW.getTime() / 1000 - 1, activity: activity("idle", 45 * MIN) }),
    });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  // Maestro review of f8edce1: `unknown` must never pass the FINAL check.
  // The unknown pane below has clean chrome (footer, empty box, no counter,
  // no member row), so only the frame-kind check can refuse it.
  test("the live pane reads unknown at the final check -> no destroy", async () => {
    const unknownPane = CLEAN_IDLE.replace("✻ Cooked for 36m 35s", "✻ Pondering the next step");
    const f = fake({
      studios: [IDLE_45()], board: HISTORY,
      inspect: (_id, n) => (n === 1 ? goodInspect() : { ...goodInspect(), tail: unknownPane }),
    });
    await runReap(flags(), f.deps);
    expect(f.calls.filter((c) => c.startsWith("inspect:")).length).toBe(2);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the DO's own activity reads unknown at the final check -> no destroy", async () => {
    const f = fake({
      studios: [IDLE_45()], board: HISTORY,
      inspect: (_id, n) => (n === 1 ? goodInspect() : { ...goodInspect(), activity: activity("unknown", 45 * MIN) }),
    });
    await runReap(flags(), f.deps);
    expect(f.calls.filter((c) => c.startsWith("inspect:")).length).toBe(2);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("the run lock is refreshed once per candidate, before its first read", async () => {
    const f = fake({ studios: [IDLE_45(), studio(WEB, activity("idle", 45 * MIN))], board: HISTORY });
    f.deps.heartbeat = async () => { f.calls.push("heartbeat"); };
    await runReap(flags(), f.deps);
    expect(f.calls.filter((c) => c === "heartbeat").length).toBe(2);
    expect(f.calls[f.calls.indexOf(`inspect:${PILOT}`) - 1]).toBe("heartbeat");
    expect(f.calls[f.calls.indexOf(`inspect:${WEB}`) - 1]).toBe("heartbeat");
  });

  test("a failed lock refresh stops the run before that candidate", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY });
    f.deps.heartbeat = async () => { throw new Error("lock gone"); };
    await runReap(flags(), f.deps);
    expect(f.calls).toEqual(["board"]);
  });

  test("REAP_LIVE_READ_MAX_MS is at most 30s", () => {
    expect(REAP_LIVE_READ_MAX_MS).toBeLessThanOrEqual(30_000);
  });

  test("a pre-check that is not idle means no rescue at all (no rescue-branch noise)", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), tail: CLEAN_WORKING }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("rescue"))).toBe(false);
  });

  test("3 live-read refusals in a row -> back off 30m", async () => {
    let state = emptyReapState();
    for (let i = 0; i < 3; i++) {
      const f = fake({ studios: [IDLE_45()], board: HISTORY, state, inspect: () => ({ ...goodInspect(), tail: IDLE_WITH_SHELLS }) });
      await runReap(flags(), f.deps);
      state = f.saved()!;
    }
    // The 30m is the claim: NOW + REAP_BACKOFF_MS, not just any truthy date.
    expect(Date.parse(state.backoffUntil[PILOT]!)).toBe(NOW.getTime() + REAP_BACKOFF_MS);
    // This describe has no other REAP_BACKOFF_MS pin (the sibling pin lives in
    // the "rescue failure, 409 and backoff" describe below) — one per describe.
    expect(REAP_BACKOFF_MS).toBe(30 * MIN);
  });
});

describe("reap — F2/F3: live pane chrome", () => {
  test("typed-but-unsent text in the input box -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), tail: IDLE_WITH_TYPED_TEXT }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("an unknown counter in the footer -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), tail: IDLE_WITH_UNKNOWN_COUNTER }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("a footer counter in words reap has never seen -> still no destroy (unknown = skip)", async () => {
    const tail = CLEAN_IDLE.replace("⏵⏵ bypass permissions on ·", "⏵⏵ bypass permissions on · 3 widgets ·");
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), tail }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });

  test("a background task still running on the turn-ended row -> no destroy", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, inspect: () => ({ ...goodInspect(), tail: IDLE_WITH_BG_TASK }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
  });
});

// Issue #1110: the footer hint text (`ctrl+t to hide tasks`, `PR #4343`) is
// chrome, not work. chromeRefusal reads the footer by its `·` segments: known
// chrome hints drop out, then the rest is checked (running words, counters,
// unknown-with-digit = skip).
describe("reap — #1110: footer segments and chrome hints", () => {
  const withFooter = (footer: string) => CLEAN_IDLE.replace(/^ *⏵⏵ .*$/m, footer);

  test("the measured footer (bypass + ctrl+t hint + agents hint) -> no refusal", () => {
    const tail = withFooter("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks · ← for agents");
    expect(chromeRefusal(tail)).toBeNull();
  });

  test("a `· 2 shells ·` footer segment -> refusal", () => {
    const tail = withFooter("  ⏵⏵ bypass permissions on (shift+tab to cycle) · 2 shells · ← for agents");
    expect(chromeRefusal(tail)).not.toBeNull();
  });

  test("an `esc to interrupt` footer segment -> refusal", () => {
    const tail = withFooter("  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt");
    expect(chromeRefusal(tail)).not.toBeNull();
  });

  test("a `PR #12` footer hint alone -> no refusal", () => {
    const tail = withFooter("  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #12");
    expect(chromeRefusal(tail)).toBeNull();
  });

  test("an unknown `· 3 foo ·` footer segment -> refusal (unknown with a digit = skip)", () => {
    const tail = withFooter("  ⏵⏵ bypass permissions on (shift+tab to cycle) · 3 foo · ← for agents");
    expect(chromeRefusal(tail)).not.toBeNull();
  });
});

describe("reap — F4/F5: scope and state", () => {
  test("a studio with no repoSlug is never reaped, even when its id matches", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 45 * MIN), { repoSlug: null })], board: HISTORY });
    await runReap(flags(), f.deps);
    expect(f.calls).toEqual(["board"]);
  });

  test("zero board rows -> reap nothing this poll (a board with history is never empty)", async () => {
    const f = fake({ studios: [IDLE_45()], board: [] });
    const out = await runReap(flags(), f.deps);
    expect(out.exitCode).toBe(1);
    expect(f.calls).toEqual(["board"]);
  });

  test("state unreadable -> floor unknown -> reap nothing this poll", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, loadStateError: new Error("corrupt") });
    const out = await runReap(flags(), f.deps);
    expect(out.exitCode).toBe(1);
    expect(f.calls.some((c) => c.startsWith("rescue") || c.startsWith("destroy"))).toBe(false);
    expect(f.saved()!.boardRows[REPO]).toBe(1);
  });

  test("the floor is keyed on the lowercased repo", async () => {
    const state = { ...emptyReapState(), boardRows: { [REPO]: 10 } };
    const f = fake({ studios: [IDLE_45()], board: HISTORY, state });
    const out = await runReap(flags({ repo: "Example-Org/AcmeClient" }), f.deps);
    expect(out.exitCode).toBe(1);
    expect(f.calls).toEqual(["board"]);
  });
});

describe("reap — board read failure and floor", () => {
  test("board read throws -> nothing reaped, non-zero exit", async () => {
    const f = fake({ studios: [IDLE_45()], board: new Error("502 from the Worker") });
    const out = await runReap(flags(), f.deps);
    expect(out.exitCode).toBe(1);
    expect(f.calls).toEqual(["board"]);
  });

  test("board rows fall below half the last good read -> reap nothing this poll, keep the baseline", async () => {
    const state = { ...emptyReapState(), boardRows: { [REPO]: 10 } };
    const f = fake({ studios: [IDLE_45()], board: HISTORY, state });
    const out = await runReap(flags(), f.deps);
    expect(out.exitCode).toBe(1);
    expect(f.calls).toEqual(["board"]);
    expect(f.saved()!.boardRows[REPO]).toBe(10);
  });

  test("board rows at or above half the last good read -> proceeds, baseline updated", async () => {
    const state = { ...emptyReapState(), boardRows: { [REPO]: 10 } };
    const rows = [1, 2, 3, 4, 5].map((n) => task(n, WEB, "completed"));
    const f = fake({ studios: [IDLE_45()], board: rows, state });
    await runReap(flags(), f.deps);
    expect(f.calls).toContain(`destroy:${PILOT}`);
    expect(f.saved()!.boardRows[REPO]).toBe(5);
  });

  test("issue #1121: an empty open board with a healthy total proceeds (every task closed)", async () => {
    const state = { ...emptyReapState(), boardRows: { [REPO]: 10 } };
    const f = fake({ studios: [IDLE_45()], board: [], boardTotal: 10, state });
    await runReap(flags(), f.deps);
    expect(f.calls).toContain(`destroy:${PILOT}`);
    expect(f.saved()!.boardRows[REPO]).toBe(10);
  });

  test("issue #1121: board total read fails -> reap nothing this poll", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, boardTotal: new Error("GraphQL 502") });
    const out = await runReap(flags(), f.deps);
    expect(out.exitCode).toBe(1);
    expect(f.calls).toEqual(["board", "total"]);
  });

  test("listing studios fails -> non-zero exit, nothing else called", async () => {
    const f = fake({ studios: [], board: HISTORY });
    f.deps.listStudios = async () => { throw new Error("401"); };
    const out = await runReap(flags(), f.deps);
    expect(out.exitCode).toBe(1);
    expect(f.calls).toEqual([]);
  });
});

describe("reap — rescue failure, 409 and backoff", () => {
  test("rescue fails -> skip, no destroy, back off 30m", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, rescue: () => ({ ok: false, error: "RESCUE_FAILED checkout push" }) });
    await runReap(flags(), f.deps);
    expect(f.calls.some((c) => c.startsWith("destroy"))).toBe(false);
    expect(Date.parse(f.saved()!.backoffUntil[PILOT]!)).toBe(NOW.getTime() + REAP_BACKOFF_MS);
    expect(REAP_BACKOFF_MS).toBe(30 * MIN);
  });

  test("destroy refused (409) -> back off 30m", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, destroy: () => ({ outcome: "refused", message: "409 destroy refused" }) });
    await runReap(flags(), f.deps);
    expect(Date.parse(f.saved()!.backoffUntil[PILOT]!)).toBe(NOW.getTime() + REAP_BACKOFF_MS);
  });

  test("destroy outcome unknown -> back off 30m", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, destroy: () => ({ outcome: "unknown", message: "timed out" }) });
    await runReap(flags(), f.deps);
    expect(Date.parse(f.saved()!.backoffUntil[PILOT]!)).toBe(NOW.getTime() + REAP_BACKOFF_MS);
  });

  test("inside the backoff window -> nothing attempted; after it -> tried again", async () => {
    const state = { ...emptyReapState(), backoffUntil: { [PILOT]: new Date(NOW.getTime() + 10 * MIN).toISOString() } };
    const inside = fake({ studios: [IDLE_45()], board: HISTORY, state });
    await runReap(flags(), inside.deps);
    expect(inside.calls).toEqual(["board"]);
    const after = fake({ studios: [IDLE_45()], board: HISTORY, state, now: new Date(NOW.getTime() + 11 * MIN) });
    await runReap(flags(), after.deps);
    // Attempted again: the live pre-check runs (the fake's DO stamp is stale by now, so it stops there).
    expect(after.calls).toContain(`inspect:${PILOT}`);
  });

  test("a successful destroy clears its state entries", async () => {
    // Seed all three per-studio maps: "entries" is plural, and cli/reap.ts's
    // success path deletes backoffUntil, stallAlarmAt AND refusals for the
    // destroyed id (a regression that stops clearing any one of them must
    // fail here, not pass untouched). The seeded refusals count is below the
    // backoff threshold and only counts LIVE-READ refusals while a candidate,
    // so a clean inspect leaves it untouched until the destroy clears it.
    const state = {
      ...emptyReapState(),
      backoffUntil: { [PILOT]: new Date(NOW.getTime() - MIN).toISOString() },
      stallAlarmAt: { [PILOT]: new Date(NOW.getTime() - MIN).toISOString() },
      refusals: { [PILOT]: 2 },
    };
    const f = fake({ studios: [IDLE_45()], board: HISTORY, state });
    await runReap(flags(), f.deps);
    expect(f.saved()!.backoffUntil[PILOT]).toBeUndefined();
    expect(f.saved()!.stallAlarmAt[PILOT]).toBeUndefined();
    expect(f.saved()!.refusals[PILOT]).toBeUndefined();
  });
});

describe("reap — dry-run", () => {
  test("dry-run lists what would be reaped and why, and calls no rescue, inspect or destroy", async () => {
    const f = fake({ studios: [IDLE_45(), studio(WEB, activity("working", 45 * MIN))], board: HISTORY });
    const out = await runReap(flags({ apply: false }), f.deps);
    expect(out.exitCode).toBe(0);
    expect(f.calls).toEqual(["board"]);
    const line = f.lines.find((l) => l.startsWith(`would reap ${PILOT}`));
    expect(line).toContain("IDLE 45m");
    expect(line).toContain("no open task");
    expect(f.lines.some((l) => l.startsWith(`skip ${WEB}`) && l.includes("working"))).toBe(true);
  });
});

describe("reap — registry derived each poll, scope", () => {
  test("studios of another repo are never touched", async () => {
    const other = studio("otherrepo--pilot", activity("idle", 45 * MIN), { repoSlug: "example-org/otherrepo" });
    const f = fake({ studios: [other], board: HISTORY });
    await runReap(flags(), f.deps);
    expect(f.calls).toEqual(["board"]);
  });

  test("state entries for studios no longer in the registry are dropped", async () => {
    const state = {
      ...emptyReapState(),
      backoffUntil: { "acmeclient--gone": new Date(NOW.getTime() + 10 * MIN).toISOString() },
      stallAlarmAt: { "acmeclient--gone": NOW.toISOString() },
    };
    const f = fake({ studios: [], board: HISTORY, state });
    await runReap(flags(), f.deps);
    expect(f.saved()!.backoffUntil).toEqual({});
    expect(f.saved()!.stallAlarmAt).toEqual({});
  });

  test("one studio's thrown step never stops the next studio", async () => {
    const f = fake({
      studios: [IDLE_45(), studio(WEB, activity("idle", 45 * MIN))], board: HISTORY,
      rescue: (id) => { if (id === PILOT) throw new Error("boom"); return { ok: true }; },
    });
    await runReap(flags(), f.deps);
    expect(f.calls).toContain(`destroy:${WEB}`);
    expect(f.calls).not.toContain(`destroy:${PILOT}`);
  });
});

describe("formatIdleAlarm — the fleet ls line", () => {
  test("names running studios idle >= 10m, with their age", () => {
    const line = formatIdleAlarm([IDLE_45(), studio(WEB, activity("idle", 3 * MIN))], NOW);
    expect(line).not.toBeNull();
    expect(line!).toContain(`${PILOT} IDLE 45m`);
    expect(line!).not.toContain(WEB);
  });

  test("null when nothing is idle long enough", () => {
    expect(formatIdleAlarm([studio(WEB, activity("working", 45 * MIN))], NOW)).toBeNull();
  });

  test("ignores a stale mirror and a stopped row", () => {
    expect(formatIdleAlarm([
      studio(PILOT, activity("idle", 45 * MIN, 20 * MIN)),
      studio(WEB, activity("idle", 45 * MIN), { state: "stopped" }),
    ], NOW)).toBeNull();
  });
});

describe("parseIdleDuration", () => {
  test("accepts s, m, h", () => {
    expect(parseIdleDuration("90s")).toBe(90_000);
    expect(parseIdleDuration("5m")).toBe(5 * MIN);
    expect(parseIdleDuration("2h")).toBe(120 * MIN);
  });
  test("rejects anything else", () => {
    for (const bad of ["5", "m", "-5m", "5d", "", "1.5h"]) expect(parseIdleDuration(bad)).toBeNull();
  });
});

// Issue #86 item 2: the reaper's destroy raced an operator's destroy and
// answered "container did not answer 8s probe". Already stopped / another
// destroy in flight is the outcome reap wanted: success, not an error.
describe("reap — destroy racing another destroy", () => {
  test("destroy answers already-stopped -> REAPED, no back-off", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, destroy: () => ({ outcome: "already-stopped" }) });
    await runReap(flags(), f.deps);
    expect(f.lines.some((l) => l.startsWith(`REAPED ${PILOT}`) && l.includes("already stopped"))).toBe(true);
    expect(f.lines.some((l) => l.includes("backing off"))).toBe(false);
    expect(f.saved()!.backoffUntil[PILOT]).toBeUndefined();
  });

  test("destroy answers in-progress -> REAPED line naming it, no error back-off line, not retried next poll", async () => {
    const f = fake({ studios: [IDLE_45()], board: HISTORY, destroy: () => ({ outcome: "in-progress" }) });
    await runReap(flags(), f.deps);
    expect(f.lines.some((l) => l.startsWith(`REAPED ${PILOT}`) && l.includes("another destroy"))).toBe(true);
    expect(f.lines.some((l) => l.includes("backing off"))).toBe(false);
    const next = fake({ studios: [IDLE_45()], board: HISTORY, state: f.saved()!, now: new Date(NOW.getTime() + MIN) });
    await runReap(flags(), next.deps);
    expect(next.calls.some((c) => c.startsWith("rescue") || c.startsWith("destroy"))).toBe(false);
  });

  test("destroyRaceOutcome: stopped row -> already-stopped; destroy in flight -> in-progress; else null", () => {
    expect(destroyRaceOutcome({ state: "stopped" })).toBe("already-stopped");
    expect(destroyRaceOutcome({ state: "running", destroyInFlight: true })).toBe("in-progress");
    expect(destroyRaceOutcome({ state: "running", destroyInFlight: false })).toBeNull();
    expect(destroyRaceOutcome({ state: "running" })).toBeNull();
    expect(destroyRaceOutcome(null)).toBeNull();
  });
});

// Issue #1098: `fleet reap --nudge` wakes an OSS-led lead that ended its turn
// mid-task (TodoWrite item in progress, empty prompt, no error). The wake is
// the same `fleet task assign` call; here it is a fake `nudge` port.
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
const iso = (t: Date) => t.toISOString();

/** The DO's own mirror of an idle lead since `forMs` before `t`, observed at `t`. */
function idleAt(t: Date, forMs: number): Activity {
  return {
    state: "idle", since: iso(new Date(t.getTime() - forMs)), anchored: true, observedAt: iso(t),
    source: "pane", reason: null, membersTickingAt: null,
  };
}

/** A live GET /inspect answered at `t`: capture fresh, DO activity idle `forMs`. */
function liveAt(t: Date, forMs: number, tail: string = CLEAN_IDLE): ReapInspect {
  return { ok: true, tail, capturedAt: t.getTime() / 1000, activity: idleAt(t, forMs) };
}

/** One poll at `t`: an OSS (glm) lead idle `idleFor` on open task #7. */
function nudgePoll(t: Date, state?: ReapState, over: {
  idleFor?: number; studioOver?: Partial<StudioStatus>; tasks?: BoardTask[]; tail?: string;
  nudge?: World["nudge"]; nudgeAfterMs?: number; apply?: boolean; fresh?: BoardTask[];
} = {}) {
  const idleFor = over.idleFor ?? 12 * MIN;
  const f = fake({
    studios: [studio(PILOT, idleAt(t, idleFor), { leadType: "glm", ...over.studioOver })],
    board: over.tasks ?? [task(7, PILOT)],
    inspect: () => liveAt(t, idleFor, over.tail),
    studioTasks: () => over.fresh ?? over.tasks ?? [task(7, PILOT)],
    nudge: over.nudge,
    state,
    now: t,
  });
  const run = () => runReap(
    flags({ nudge: true, apply: over.apply ?? true, nudgeAfterMs: over.nudgeAfterMs }), f.deps,
  );
  return { f, run };
}

describe("reap --nudge — wake an OSS lead that stops mid-task (issue #1098)", () => {
  test("without --nudge an OSS lead idle with an open task is only logged, never woken", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 12 * MIN), { leadType: "glm" })], board: [task(7, PILOT)] });
    await runReap(flags({ apply: true }), f.deps);
    expect(f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
  });

  test("apply: an OSS lead idle on an open task is woken for that task, after a live read says idle", async () => {
    const p = nudgePoll(NOW);
    await p.run();
    expect(p.f.calls).toContain(`nudge:${PILOT}:7`);
    expect(p.f.lines.some((l) => l.startsWith(`NUDGED ${PILOT}`) && l.includes("#7"))).toBe(true);
    expect(p.f.calls.some((c) => c.startsWith("destroy") || c.startsWith("rescue"))).toBe(false);
  });

  test("dry-run prints would-nudge lines and calls no inspect, nudge, rescue or destroy", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 12 * MIN), { leadType: "glm" })], board: [task(7, PILOT)] });
    await runReap(flags({ apply: false, nudge: true }), f.deps);
    expect(f.lines.some((l) => l.startsWith(`would nudge ${PILOT}: task #7`))).toBe(true);
    expect(f.calls.filter((c) => /^(inspect|nudge|rescue|destroy):/.test(c))).toEqual([]);
  });

  test("a claude lead is never nudged: leadType claude, and leadType absent (= claude)", async () => {
    for (const over of [{ leadType: "claude" as const }, {}]) {
      const f = fake({ studios: [studio(PILOT, idleAt(NOW, 12 * MIN), over)], board: [task(7, PILOT)] });
      await runReap(flags({ nudge: true }), f.deps);
      expect(f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
    }
  });

  test("any non-claude lead type is OSS: kimi and deepseek are nudged too", async () => {
    for (const leadType of ["kimi", "deepseek"] as const) {
      const p = nudgePoll(NOW, undefined, { studioOver: { leadType: leadType as StudioStatus["leadType"] } });
      await p.run();
      expect(p.f.calls).toContain(`nudge:${PILOT}:7`);
    }
  });

  test("an OSS lead idle under --nudge-after is not nudged (default 5m; 12m idle clears it, 15m does not)", async () => {
    const under = nudgePoll(NOW, undefined, { idleFor: 4 * MIN });
    await under.run();
    expect(under.f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
    const high = nudgePoll(NOW, undefined, { idleFor: 12 * MIN, nudgeAfterMs: 15 * MIN });
    await high.run();
    expect(high.f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
  });

  test("never nudges into a limit modal, a member alert, a waiting question or running work", async () => {
    const limit = nudgePoll(NOW, undefined, { studioOver: { rateLimited: { until: null, seenAt: iso(NOW), select: true } } });
    await limit.run();
    const member = studio(PILOT, idleAt(NOW, 12 * MIN), { leadType: "glm" });
    member.observed!.memberAlerts = [{ kind: "member-gone", at: iso(NOW), detail: "x", confidence: "inferred" } as never];
    const members = fake({ studios: [member], board: [task(7, PILOT)] });
    await runReap(flags({ nudge: true }), members.deps);
    const question = fake({ studios: [studio(PILOT, activity("waiting-question", 12 * MIN), { leadType: "glm" })], board: [task(7, PILOT)] });
    await runReap(flags({ nudge: true }), question.deps);
    const running = nudgePoll(NOW, undefined, { tail: CLEAN_WORKING });
    await running.run();
    for (const calls of [limit.f.calls, members.calls, question.calls, running.f.calls]) {
      expect(calls.some((c) => c.startsWith("nudge:"))).toBe(false);
    }
  });

  test("never types over text the operator is typing (unsent input box) or a running turn", async () => {
    const typed = nudgePoll(NOW, undefined, { tail: IDLE_WITH_TYPED_TEXT });
    await typed.run();
    expect(typed.f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
    expect(typed.f.lines.some((l) => l.includes("holds unsent text"))).toBe(true);
  });

  test("at most one nudge per studio per 15m", async () => {
    const first = nudgePoll(at(0));
    await first.run();
    expect(first.f.calls).toContain(`nudge:${PILOT}:7`);
    const soon = nudgePoll(at(5), first.f.saved()!);
    await soon.run();
    expect(soon.f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
    const later = nudgePoll(at(15), soon.f.saved()!);
    await later.run();
    expect(later.f.calls).toContain(`nudge:${PILOT}:7`);
  });

  test("at most 3 nudges per task per hour: the 4th is held and its STALL line says nudge budget spent", async () => {
    let state: ReapState | undefined;
    for (const m of [0, 15, 30]) {
      const p = nudgePoll(at(m), state);
      await p.run();
      expect(p.f.calls).toContain(`nudge:${PILOT}:7`);
      state = p.f.saved()!;
    }
    const fourth = nudgePoll(at(45), state);
    await fourth.run();
    expect(fourth.f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
    expect(fourth.f.lines.some((l) => l.startsWith(`STALL ${PILOT}`) && l.includes("nudge budget spent"))).toBe(true);
    // The first nudge (minute 0) leaves the hour at minute 60.
    const after = nudgePoll(at(61), fourth.f.saved()!);
    await after.run();
    expect(after.f.calls).toContain(`nudge:${PILOT}:7`);
  });

  test("the budget is per task: a spent task does not block another open task on the same studio", async () => {
    const spent = [at(-1), at(-2), at(-3)].map(iso);
    const state = { ...emptyReapState(), taskNudges: { [`${REPO}#7`]: spent } };
    const p = nudgePoll(NOW, state, { tasks: [task(7, PILOT), task(8, PILOT)] });
    await p.run();
    expect(p.f.calls).toContain(`nudge:${PILOT}:8`);
    expect(p.f.calls).not.toContain(`nudge:${PILOT}:7`);
  });

  test("a wake the Worker refuses is logged and still spends the budget", async () => {
    const p = nudgePoll(NOW, undefined, { nudge: () => ({ woke: false, reason: "studio is stopped" }) });
    await p.run();
    expect(p.f.lines.some((l) => l.startsWith(`NUDGE FAILED ${PILOT}`) && l.includes("studio is stopped"))).toBe(true);
    expect(p.f.saved()!.taskNudges[`${REPO}#7`]).toHaveLength(1);
    expect(p.f.saved()!.nudgedAt[PILOT]).toBeDefined();
  });

  test("a wake that throws is logged and the poll still finishes", async () => {
    const p = nudgePoll(NOW, undefined, { nudge: () => new Error("network down") });
    expect(await p.run()).toEqual({ exitCode: 0 });
    expect(p.f.lines.some((l) => l.startsWith(`NUDGE FAILED ${PILOT}`) && l.includes("network down"))).toBe(true);
  });

  test("a lock refresh that fails before a nudge stops the run: no wake sent", async () => {
    const p = nudgePoll(NOW);
    const deps = { ...p.f.deps, heartbeat: async () => { throw new Error("lock lost"); } };
    expect(await runReap(flags({ nudge: true }), deps)).toEqual({ exitCode: 1 });
    expect(p.f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
  });

  test("state: nudge records for studios no longer in the registry are dropped; records older than an hour too", async () => {
    const GONE = "acmeclient--retired";
    const old = iso(at(-61));
    const recent = iso(at(-5));
    const state: ReapState = {
      ...emptyReapState(),
      nudgedAt: { [PILOT]: recent, [GONE]: recent },
      taskNudges: { [`${REPO}#7`]: [old, recent], [`${REPO}#9`]: [old] },
    };
    // Cooling down (5m ago), so this poll wakes nothing: only the pruning is under test.
    const p = nudgePoll(NOW, state);
    await p.run();
    const saved = p.f.saved()!;
    expect(saved.nudgedAt).toEqual({ [PILOT]: recent });
    expect(saved.taskNudges).toEqual({ [`${REPO}#7`]: [recent] });
  });
});

describe("fleet reap --nudge flags (issue #1098)", () => {
  test("no flag: nudge off, the 5m floor still reported", () => {
    expect(parseCliArgs(["reap"])).toMatchObject({ cmd: "reap", nudge: false });
  });
  test("--nudge alone turns it on at the 5m default", () => {
    expect(parseCliArgs(["reap", "--nudge"])).toMatchObject({ cmd: "reap", nudge: true, nudgeAfterMs: 5 * MIN });
  });
  test("--nudge-after takes a duration", () => {
    expect(parseCliArgs(["reap", "--nudge", "--nudge-after", "10m"])).toMatchObject({ cmd: "reap", nudgeAfterMs: 10 * MIN });
    expect(parseCliArgs(["reap", "--nudge", "--nudge-after=2h"])).toMatchObject({ cmd: "reap", nudgeAfterMs: 120 * MIN });
  });
  test("--nudge-after below 5m is refused, like --idle", () => {
    expect(parseCliArgs(["reap", "--nudge", "--nudge-after", "1m"]).cmd).not.toBe("reap");
  });
  test("--nudge-after without --nudge is refused, not silently ignored", () => {
    expect(parseCliArgs(["reap", "--nudge-after", "10m"]).cmd).not.toBe("reap");
  });
});

describe("reap --nudge — review (#1103): a working task, read fresh, budget per repo, saved before the wake", () => {
  test("only a working task is nudged: input_required, submitted and a drifted (no state) task are held", async () => {
    for (const state of ["input_required", "submitted", null] as const) {
      const p = nudgePoll(NOW, undefined, { tasks: [task(7, PILOT, state)] });
      await p.run();
      expect(p.f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
    }
  });

  test("a task that leaves working between the listing and the fresh read is skipped", async () => {
    const p = nudgePoll(NOW, undefined, { fresh: [task(7, PILOT, "awaiting_merge")] });
    await p.run();
    expect(p.f.calls.some((c) => c.startsWith("nudge:"))).toBe(false);
    expect(p.f.lines.some((l) => l.startsWith(`skip ${PILOT}: no working task`))).toBe(true);
  });

  test("the budget is repo-scoped: another repo's task #7 does not spend this repo's budget", async () => {
    const spent = [at(-1), at(-2), at(-3)].map(iso);
    const state = { ...emptyReapState(), taskNudges: { "other/repo#7": spent } };
    const p = nudgePoll(NOW, state);
    await p.run();
    expect(p.f.calls).toContain(`nudge:${PILOT}:7`);
  });

  test("the budget is written before the wake, so a run killed after the wake cannot wake the same task again", async () => {
    let savedAtWake: ReapState | null = null;
    const p = nudgePoll(NOW, undefined, {
      nudge: () => {
        savedAtWake = p.f.saved() ?? null;
        return { woke: true };
      },
    });
    await p.run();
    expect(savedAtWake).not.toBeNull();
    expect(savedAtWake!.taskNudges[`${REPO}#7`]).toHaveLength(1);
  });

  test("dry-run honors --nudge-after: an OSS lead idle under it is not listed as would-nudge", async () => {
    const f = fake({ studios: [studio(PILOT, activity("idle", 12 * MIN), { leadType: "glm" })], board: [task(7, PILOT)] });
    await runReap(flags({ apply: false, nudge: true, nudgeAfterMs: 15 * MIN }), f.deps);
    expect(f.lines.some((l) => l.startsWith("would nudge"))).toBe(false);
  });
});
