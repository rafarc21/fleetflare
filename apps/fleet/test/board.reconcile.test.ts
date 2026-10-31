import { describe, it, expect, vi } from "vitest";
import { runBoardReconcile, rotateReconcileSlice, type ReconcileDeps, type ReconcileTask } from "../src/board/reconcile";

// Board issue #1447: the Worker reconcile. Three cases over open tasks:
//   (a) a task whose linked PR is MERGED -> completed;
//   (b) a working/awaiting_merge task on a stopped/parked studio with no open
//       PR -> back to submitted;
//   (c) an awaiting_merge task on a stopped studio whose PR is still open ->
//       leave state, comment once.
// Every write goes through the single writer (transition) or the comment port,
// never a label write of its own. Pure, DI'd like src/studio/task-reap.ts.

const STUDIO = "acme--web-studio";

function task(overrides: Partial<ReconcileTask> = {}): ReconcileTask {
  return { taskNumber: 12, state: "awaiting_merge", assignee: STUDIO, ...overrides };
}

function deps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    repo: "acme/websites",
    listOpenTasks: async () => [],
    linkedPrs: async () => [],
    prState: async () => ({ merged: false, open: false, landed: false }),
    studioStopped: async () => false,
    hasComment: async () => false,
    transition: vi.fn(async () => ({ ok: true as const })),
    comment: vi.fn(async () => {}),
    ...overrides,
  };
}

const completeComment = (n: number) => `auto-completed: PR #${n} merged`;
const resetComment = (id: string) => `auto-reconcile: ${id} stopped or parked with no open PR — task back to submitted`;
const noteComment = (id: string, n: number) => `auto-reconcile: ${id} stopped or parked, PR #${n} still open — leaving awaiting_merge`;

describe("runBoardReconcile — case (a): linked PR merged -> completed", () => {
  it("dry-run reports would-complete and writes nothing", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: true, open: false, landed: true }),
    });
    const out = await runBoardReconcile(d, false);
    expect(out).toEqual([{ taskNumber: 12, prNumber: 40, outcome: "would-complete" }]);
    expect(d.transition).not.toHaveBeenCalled();
    expect(d.comment).not.toHaveBeenCalled();
  });

  it("apply transitions to completed and comments once with the PR number", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: true, open: false, landed: true }),
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, prNumber: 40, outcome: "completed" }]);
    expect(d.transition).toHaveBeenCalledWith(12, "awaiting_merge", "completed");
    expect(d.comment).toHaveBeenCalledWith(12, completeComment(40));
  });

  it("a working task with a merged PR completes too", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "working" })],
      linkedPrs: async () => [7],
      prState: async () => ({ merged: true, open: false, landed: true }),
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, prNumber: 7, outcome: "completed" }]);
    expect(d.transition).toHaveBeenCalledWith(12, "working", "completed");
  });

  it("a merged PR among several linked PRs wins", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40, 41],
      prState: async (n: number) => (n === 41 ? { merged: true, open: false, landed: true } : { merged: false, open: true, landed: false }),
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, prNumber: 41, outcome: "completed" }]);
    expect(d.transition).toHaveBeenCalledWith(12, "awaiting_merge", "completed");
  });

  it("does not comment twice when a prior run already wrote the auto-completed marker", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: true, open: false, landed: true }),
      hasComment: async (n: number, marker: string) => n === 12 && marker === completeComment(40),
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, prNumber: 40, outcome: "completed" }]);
    expect(d.transition).toHaveBeenCalled(); // the transition still runs (CAS-guarded)
    expect(d.comment).not.toHaveBeenCalled();
  });

  it("a failed transition is a failed outcome, not a silent success", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: true, open: false, landed: true }),
      transition: async () => ({ ok: false, message: "drifted" }),
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, outcome: "failed", reason: "drifted" }]);
    expect(d.comment).not.toHaveBeenCalled();
  });
});

describe("runBoardReconcile — case (b): stopped studio, no open PR -> submitted", () => {
  it("a working task on a stopped studio with no linked PR resets to submitted and comments", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "working" })],
      studioStopped: async () => true,
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, outcome: "reset", reason: STUDIO }]);
    expect(d.transition).toHaveBeenCalledWith(12, "working", "submitted");
    expect(d.comment).toHaveBeenCalledWith(12, resetComment(STUDIO));
  });

  it("an awaiting_merge task whose PR closed (not merged, not open) resets to submitted", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: false, open: false, landed: false }),
      studioStopped: async () => true,
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, outcome: "reset", reason: STUDIO }]);
    expect(d.transition).toHaveBeenCalledWith(12, "awaiting_merge", "submitted");
  });

  it("dry-run reports would-reset and writes nothing", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "working" })],
      studioStopped: async () => true,
    });
    const out = await runBoardReconcile(d, false);
    expect(out).toEqual([{ taskNumber: 12, outcome: "would-reset", reason: STUDIO }]);
    expect(d.transition).not.toHaveBeenCalled();
  });

  it("a second run on an already-reset marker is a no-op comment", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "working" })],
      studioStopped: async () => true,
      hasComment: async (n: number, marker: string) => n === 12 && marker === resetComment(STUDIO),
    });
    await runBoardReconcile(d, true);
    expect(d.comment).not.toHaveBeenCalled();
  });
});

describe("runBoardReconcile — case (c): awaiting_merge + open PR on a stopped studio", () => {
  it("leaves the state and comments once", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: false, open: true, landed: false }),
      studioStopped: async () => true,
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, prNumber: 40, outcome: "noted", reason: STUDIO }]);
    expect(d.transition).not.toHaveBeenCalled();
    expect(d.comment).toHaveBeenCalledWith(12, noteComment(STUDIO, 40));
  });

  it("comments ONCE — a second apply on the same task is a silent no-op", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: false, open: true, landed: false }),
      studioStopped: async () => true,
      hasComment: async (n: number, marker: string) => n === 12 && marker === noteComment(STUDIO, 40),
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([{ taskNumber: 12, prNumber: 40, outcome: "noted", reason: STUDIO }]);
    expect(d.comment).not.toHaveBeenCalled();
  });

  it("dry-run reports would-note and writes nothing", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: false, open: true, landed: false }),
      studioStopped: async () => true,
    });
    const out = await runBoardReconcile(d, false);
    expect(out).toEqual([{ taskNumber: 12, prNumber: 40, outcome: "would-note", reason: STUDIO }]);
    expect(d.comment).not.toHaveBeenCalled();
  });
});

describe("runBoardReconcile — every other task is skipped with a reason", () => {
  it("a running studio's working task is left alone", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "working" })],
      studioStopped: async () => false,
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "studio running" },
    ]);
  });

  it("a working task on a stopped studio with an OPEN PR is left alone (the PR holds the work)", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "working" })],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: false, open: true, landed: false }),
      studioStopped: async () => true,
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "working with an open PR — left for review" },
    ]);
  });

  it("an unassigned task has no studio to judge — skipped", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ assignee: null })],
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "unassigned" },
    ]);
  });

  it("input_required is parked on a human — skipped", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "input_required" })],
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "input_required parked" },
    ]);
  });

  it("a terminal state is done — skipped", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "completed" })],
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "terminal completed" },
    ]);
  });

  it("a task with no single state label is drift — skipped", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: null })],
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "no single board state" },
    ]);
  });

  it("a submitted task is not a stopped-studio candidate — skipped", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "submitted" })],
      studioStopped: async () => true,
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "submitted, not in flight" },
    ]);
  });

  it("a linkedPrs failure fails closed — the task is skipped, never reset", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => { throw new Error("github down"); },
    });
    const out = await runBoardReconcile(d, true);
    expect(out).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "reading linked PRs failed: github down" },
    ]);
    expect(d.transition).not.toHaveBeenCalled();
  });

  it("a studioState failure fails closed — the task is skipped, never reset", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "working" })],
      studioStopped: async () => { throw new Error("d1 down"); },
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "reading studio state failed: d1 down" },
    ]);
    expect(d.transition).not.toHaveBeenCalled();
  });

  it("a prState failure fails closed — the task is skipped, never completed", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => { throw new Error("github down"); },
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "reading PR #40 failed: github down" },
    ]);
    expect(d.transition).not.toHaveBeenCalled();
  });
});

describe("runBoardReconcile — review #1447 fixes", () => {
  it("an unassigned task skips the PR search entirely", async () => {
    const linkedPrs = vi.fn(async () => [40]);
    const d = deps({ listOpenTasks: async () => [task({ assignee: null })], linkedPrs });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "unassigned" },
    ]);
    expect(linkedPrs).not.toHaveBeenCalled();
  });

  it("a PR merged into a non-default branch is skipped, not completed", async () => {
    const d = deps({
      listOpenTasks: async () => [task()],
      linkedPrs: async () => [40],
      prState: async () => ({ merged: true, open: false, landed: false }),
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "PR #40 merged but not on default branch yet" },
    ]);
    expect(d.transition).not.toHaveBeenCalled();
  });

  it("a task whose studio has no registry row is skipped, not reset", async () => {
    const d = deps({
      listOpenTasks: async () => [task({ state: "working" })],
      studioStopped: async () => null,
    });
    expect(await runBoardReconcile(d, true)).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "unknown studio" },
    ]);
    expect(d.transition).not.toHaveBeenCalled();
  });
});

describe("rotateReconcileSlice", () => {
  const nums = (ns: number[]): ReconcileTask[] => ns.map((n) => ({ taskNumber: n, state: "awaiting_merge", assignee: STUDIO }));

  it("an empty list yields an empty slice and no cursor", () => {
    expect(rotateReconcileSlice([], 25, null)).toEqual({ slice: [], nextCursor: null });
  });

  it("no cursor takes the first `limit` tasks", () => {
    const out = rotateReconcileSlice(nums([10, 9, 8, 7]), 2, null);
    expect(out.slice.map((t) => t.taskNumber)).toEqual([10, 9]);
    expect(out.nextCursor).toBe(9);
  });

  it("a cursor resumes just after it, wrapping at the end", () => {
    const out = rotateReconcileSlice(nums([10, 9, 8, 7]), 2, 9);
    expect(out.slice.map((t) => t.taskNumber)).toEqual([8, 7]);
    expect(out.nextCursor).toBe(7);
  });

  it("a stale cursor (task gone) starts from the head", () => {
    const out = rotateReconcileSlice(nums([10, 9, 8]), 2, 99);
    expect(out.slice.map((t) => t.taskNumber)).toEqual([10, 9]);
  });

  it("caps at the list length when limit exceeds it", () => {
    const out = rotateReconcileSlice(nums([10, 9]), 25, null);
    expect(out.slice.map((t) => t.taskNumber)).toEqual([10, 9]);
  });
});