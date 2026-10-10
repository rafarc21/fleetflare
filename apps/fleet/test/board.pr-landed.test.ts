import { describe, it, expect, vi } from "vitest";
import { openTasksWithLatestPr, OPEN_TASKS_SCAN_MAX_CANDIDATES } from "../src/board/pr-landed";
import { parseEnvelope, renderEnvelopeComment } from "../src/board/envelope";
import type { BoardApi, TaskComment } from "../src/board/board";
import type { BoardTask, BoardTaskView, EnvelopeDoc } from "../src/board/types";
import type { TimeBudget } from "../src/time-budget";

// Same fake-BoardApi / envelope-comment conventions as test/board.verify.test.ts
// and test/board.board.test.ts — one shared scan, proven without a live issue.

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/o/r/issues/12", title: "Some task",
    body: "## Objective\n\nShip it.\n", state: "working", labels: ["working"],
    assignee: null, milestone: null, open: true, updatedAt: "2026-09-18T10:00:00Z", ...overrides,
  };
}

function view(overrides: Partial<BoardTaskView> = {}): BoardTaskView {
  return { ...task(overrides), stale: false, ...overrides };
}

function fakeApi(overrides: Partial<BoardApi> = {}): BoardApi {
  return {
    createIssue: vi.fn(async () => task()),
    getIssue: vi.fn(async (repo: string, number: number) => task({ number })),
    listIssues: vi.fn(async () => [task()]),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ id: 1, url: "https://github.com/o/r/issues/12#issuecomment-1" })),
    pullRequestExists: vi.fn(async () => true),
    listComments: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    listOpenPullFiles: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ number: 0, merged: false, open: true, title: "" })),
    ...overrides,
  };
}

let msgCounter = 0;
function envelopeDoc(
  payload: Partial<{ intent: string; artifacts: unknown[] }> = {}, taskId = 12,
): EnvelopeDoc {
  msgCounter += 1;
  const raw = {
    sender: "websites--web-studio",
    intent: payload.intent ?? "result",
    status: "ok",
    artifacts: payload.artifacts ?? [],
    ...(payload.intent === undefined || payload.intent === "result"
      ? { verification: { url: "https://x.test", steps: ["open it"], expected: "it works" } }
      : {}),
  };
  const parsed = parseEnvelope(raw, taskId, `msg-${msgCounter}`);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.doc;
}

function envelopeComment(doc: EnvelopeDoc, overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: msgCounter, url: `u${msgCounter}`, author: "example-bot[bot]",
    createdAt: "2026-09-18T10:00:00Z", body: renderEnvelopeComment(doc), envelope: doc,
    ...overrides,
  };
}

describe("openTasksWithLatestPr", () => {
  it("returns the PR number named in an open task's latest result envelope", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] });
    const api = fakeApi({ listComments: vi.fn(async () => [envelopeComment(doc)]) });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 })]);
    expect(result).toEqual([{ taskNumber: 12, prNumber: 9 }]);
  });

  it("a `#`-prefixed pr artifact is parsed the same way", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "#9" }] });
    const api = fakeApi({ listComments: vi.fn(async () => [envelopeComment(doc)]) });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 })]);
    expect(result).toEqual([{ taskNumber: 12, prNumber: 9 }]);
  });

  it("a task with no envelope at all reports prNumber: null, not a skip", async () => {
    const api = fakeApi({ listComments: vi.fn(async () => []) });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 })]);
    expect(result).toEqual([{ taskNumber: 12, prNumber: null }]);
  });

  it("an envelope with no pr artifact reports prNumber: null", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "code", path: "src/x.ts" }] });
    const api = fakeApi({ listComments: vi.fn(async () => [envelopeComment(doc)]) });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 })]);
    expect(result).toEqual([{ taskNumber: 12, prNumber: null }]);
  });

  it("a later plain comment does not shadow the real result envelope's PR", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] });
    const api = fakeApi({
      listComments: vi.fn(async () => [
        envelopeComment(doc),
        { id: 2, url: "u2", author: "rafarc21", createdAt: "2026-09-18T11:00:00Z", body: "nice work", envelope: null },
      ]),
    });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 })]);
    expect(result).toEqual([{ taskNumber: 12, prNumber: 9 }]);
  });

  // Board issue #26: a GitHub native closing keyword (e.g. "closes #12" in a
  // merged PR's body) flips `open` to false the instant the PR merges --
  // before this scan, or anything else in the fleet's own reconciliation
  // code, ever looks. A task in that state has NOT yet had its board label
  // moved to `completed` (that write is closeTaskOnPromote's job, and it
  // never got called), so it still needs to be a candidate -- the ONLY thing
  // that is safe to skip forever is a task that is BOTH closed AND already
  // labeled `completed`, proven separately below.
  it("still returns a task GitHub already closed natively, when its board label isn't completed yet", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] });
    const api = fakeApi({ listComments: vi.fn(async () => [envelopeComment(doc)]) });
    const result = await openTasksWithLatestPr(
      api, "o/r", [view({ number: 12, open: false, state: "working" })],
    );
    expect(result).toEqual([{ taskNumber: 12, prNumber: 9 }]);
  });

  it("skips a task that is BOTH closed AND already labeled completed -- genuinely done", async () => {
    const listComments = vi.fn(async () => []);
    const api = fakeApi({ listComments });
    const result = await openTasksWithLatestPr(
      api, "o/r", [view({ number: 12, open: false, state: "completed" })],
    );
    expect(result).toEqual([]);
    expect(listComments).not.toHaveBeenCalled();
  });

  it("walks every task given, independently", async () => {
    const docA = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const docB = envelopeDoc({ artifacts: [{ kind: "pr", pr: "11" }] }, 13);
    const api = fakeApi({
      listComments: vi.fn(async (_repo: string, number: number) =>
        number === 12 ? [envelopeComment(docA)] : number === 13 ? [envelopeComment(docB)] : []),
    });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 }), view({ number: 13 })]);
    expect(result).toEqual([{ taskNumber: 12, prNumber: 9 }, { taskNumber: 13, prNumber: 11 }]);
  });

  it("a thrown lookup for one task reports null and does not stop the others", async () => {
    const docB = envelopeDoc({ artifacts: [{ kind: "pr", pr: "11" }] }, 13);
    const api = fakeApi({
      listComments: vi.fn(async (_repo: string, number: number) => {
        if (number === 12) throw new Error("boom");
        return [envelopeComment(docB)];
      }),
    });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 }), view({ number: 13 })]);
    expect(result).toEqual([{ taskNumber: 12, prNumber: null }, { taskNumber: 13, prNumber: 11 }]);
  });

  // Board issue #180: this is the ONE shared scan both the webhook's
  // deferred envelope cross-check AND task-reap.ts's reap route call --
  // bounding it here bounds both callers for free (see this function's own
  // doc comment on OPEN_TASKS_SCAN_MAX_CANDIDATES for the subrequest math).
  describe("OPEN_TASKS_SCAN_MAX_CANDIDATES bound", () => {
    it("scans only the first N candidates, in the order given, and reports the truncation once", async () => {
      const total = OPEN_TASKS_SCAN_MAX_CANDIDATES + 50;
      const tasks = Array.from({ length: total }, (_, i) => view({ number: i + 1 }));
      const listComments = vi.fn(async () => []);
      const api = fakeApi({ listComments });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await openTasksWithLatestPr(api, "o/r", tasks);

      expect(result).toHaveLength(OPEN_TASKS_SCAN_MAX_CANDIDATES);
      expect(listComments).toHaveBeenCalledTimes(OPEN_TASKS_SCAN_MAX_CANDIDATES);
      // The FIRST N of the list the caller passed -- listTasks's own
      // newest-first order (#163/#168) -- never a random or later subset.
      expect(result.map((r) => r.taskNumber)).toEqual(
        tasks.slice(0, OPEN_TASKS_SCAN_MAX_CANDIDATES).map((t) => t.number),
      );
      expect(errors).toHaveBeenCalledTimes(1);
      const [msg] = errors.mock.calls[0] as [string];
      expect(msg).toContain("o/r");
      expect(msg).toContain(String(total));
      expect(msg).toContain(String(OPEN_TASKS_SCAN_MAX_CANDIDATES));

      errors.mockRestore();
    });

    it("counts only actual candidates against the bound -- a task already closed AND completed costs nothing", async () => {
      const done = Array.from({ length: 10 }, (_, i) => view({ number: 9000 + i, open: false, state: "completed" }));
      const candidates = Array.from({ length: OPEN_TASKS_SCAN_MAX_CANDIDATES }, (_, i) => view({ number: i + 1 }));
      const listComments = vi.fn(async () => []);
      const api = fakeApi({ listComments });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await openTasksWithLatestPr(api, "o/r", [...done, ...candidates]);

      expect(result).toHaveLength(OPEN_TASKS_SCAN_MAX_CANDIDATES);
      expect(listComments).toHaveBeenCalledTimes(OPEN_TASKS_SCAN_MAX_CANDIDATES);
      expect(errors).not.toHaveBeenCalled();

      errors.mockRestore();
    });

    it("does not report a truncation when candidates are exactly at the bound", async () => {
      const tasks = Array.from({ length: OPEN_TASKS_SCAN_MAX_CANDIDATES }, (_, i) => view({ number: i + 1 }));
      const listComments = vi.fn(async () => []);
      const api = fakeApi({ listComments });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await openTasksWithLatestPr(api, "o/r", tasks);

      expect(result).toHaveLength(OPEN_TASKS_SCAN_MAX_CANDIDATES);
      expect(errors).not.toHaveBeenCalled();

      errors.mockRestore();
    });
  });

  // Board issue #198, finding 1: `commentEnvelope` (board.ts) refuses to post
  // a §6 envelope onto any issue with ZERO board state labels -- such an
  // issue can never carry useful data here, so scanning it at all is pure
  // waste. Measured live (2026-09-24): demosite.life 186 candidates / 2 real
  // fleet tasks, acme-os 565/13, websites 44/11 -- most of a repo's open
  // GitHub issues are ordinary issues mixed in with real fleet tasks, not
  // fleet tasks themselves.
  describe("board-state-label filter (#198)", () => {
    it("excludes an open task with NO board state label -- never a real fleet task", async () => {
      const listComments = vi.fn(async () => []);
      const api = fakeApi({ listComments });
      const unlabelled = view({ number: 12, state: null, labels: [] });

      const result = await openTasksWithLatestPr(api, "o/r", [unlabelled]);

      expect(result).toEqual([]);
      expect(listComments).not.toHaveBeenCalled();
    });

    it("keeps a labelled candidate but drops an unlabelled one in the SAME scan", async () => {
      const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] });
      const listComments = vi.fn(async (_repo: string, number: number) =>
        number === 12 ? [envelopeComment(doc)] : []);
      const api = fakeApi({ listComments });
      const labelled = view({ number: 12, state: "working", labels: ["working"] });
      const unlabelled = view({ number: 13, state: null, labels: [] });

      const result = await openTasksWithLatestPr(api, "o/r", [labelled, unlabelled]);

      expect(result).toEqual([{ taskNumber: 12, prNumber: 9 }]);
      expect(listComments).toHaveBeenCalledTimes(1);
      expect(listComments).toHaveBeenCalledWith("o/r", 12);
    });

    // Deliberately NOT the same as `task.state !== null`: `state` is already
    // null for BOTH zero state labels AND two-or-more (board drift,
    // board/api.ts's toBoardTask). A drifted task carrying TWO state labels
    // is a real fleet task needing reconciliation and must stay a candidate
    // -- only zero labels excludes.
    it("keeps a drifted task carrying TWO state labels as a candidate -- state is null, but it IS a real fleet task", async () => {
      const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] });
      const api = fakeApi({ listComments: vi.fn(async () => [envelopeComment(doc)]) });
      const drifted = view({ number: 12, state: null, labels: ["working", "completed"] });

      const result = await openTasksWithLatestPr(api, "o/r", [drifted]);

      expect(result).toEqual([{ taskNumber: 12, prNumber: 9 }]);
    });
  });

  // Board issue #198, finding 3: Path 2's own O(open tasks) scan can run long
  // enough (once #163's pagination is in full swing on a big repo) to hit
  // Cloudflare's own `waitUntil` execution ceiling and be silently killed
  // mid-scan. A shared, injectable-clock time budget bounds this loop too --
  // in ADDITION to, not instead of, the count-based OPEN_TASKS_SCAN_MAX_CANDIDATES
  // bound above; whichever fires first stops the loop.
  describe("time budget (#198)", () => {
    function fakeBudget(overrides: Partial<TimeBudget> = {}): TimeBudget {
      return { clock: () => 0, deadline: 1, ...overrides };
    }

    it("an already-exceeded budget stops the scan before a single candidate is read", async () => {
      const listComments = vi.fn(async () => []);
      const api = fakeApi({ listComments });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const tasks = [view({ number: 1 }), view({ number: 2 }), view({ number: 3 })];
      // Budget already expired the instant it's checked.
      const budget = fakeBudget({ clock: () => 100, deadline: 0 });

      const result = await openTasksWithLatestPr(api, "o/r", tasks, budget);

      expect(result).toEqual([]);
      expect(listComments).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(1);
      const [msg] = errors.mock.calls[0] as [string];
      expect(msg).toContain("o/r");
      expect(msg).toContain("Path 2");
      expect(msg).toContain("0/3");
      errors.mockRestore();
    });

    it("stops mid-loop once the budget is exceeded after N iterations, reporting done/total once", async () => {
      const listComments = vi.fn(async () => []);
      const api = fakeApi({ listComments });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const tasks = [view({ number: 1 }), view({ number: 2 }), view({ number: 3 }), view({ number: 4 })];
      // A fake clock that reads as "still within budget" for the first two
      // candidates, then "exceeded" from the third check onward -- no real
      // sleep, deterministic.
      let calls = 0;
      const budget = fakeBudget({ clock: () => (calls++ < 2 ? 0 : 100), deadline: 1 });

      const result = await openTasksWithLatestPr(api, "o/r", tasks, budget);

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.taskNumber)).toEqual([1, 2]);
      expect(listComments).toHaveBeenCalledTimes(2);
      expect(errors).toHaveBeenCalledTimes(1);
      const [msg] = errors.mock.calls[0] as [string];
      expect(msg).toContain("2/4");
      errors.mockRestore();
    });

    it("never checked, never exceeded, when no budget is given at all -- existing callers unaffected", async () => {
      const tasks = Array.from({ length: 10 }, (_, i) => view({ number: i + 1 }));
      const listComments = vi.fn(async () => []);
      const api = fakeApi({ listComments });

      const result = await openTasksWithLatestPr(api, "o/r", tasks);

      expect(result).toHaveLength(10);
      expect(listComments).toHaveBeenCalledTimes(10);
    });
  });
});
