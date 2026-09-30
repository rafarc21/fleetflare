import { describe, it, expect, vi } from "vitest";
import {
  createTask, transitionTask, commentEnvelope, listTasks, showTask, resolveBoardRepo,
  requireAssignedTask, showStudioTask, commentStudioEnvelope, resolveBriefPrompt, resolveLatestAssignedBrief,
  assignTask, transitionStudioTask, openAssignedTasks, findLiveAssignedTask,
  closeTerminalTasks, TERMINAL_CLOSE_PAGE, autoStartSubmittedTasks,
  type BoardApi,
} from "../src/board/board";
import { parseEnvelopeComment, renderEnvelopeComment, parseEnvelope } from "../src/board/envelope";
import { studioLabel, taskAssignees, type BoardTask } from "../src/board/types";
import type { RepoReach } from "../src/github/reach";
import { GitHubError } from "../src/board/api";

const MSG_ID = "0d9f1c2e-0000-4000-8000-000000000001";

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/o/r/issues/12", title: "Build the task board",
    body: "## Objective\n\nShip it.\n", state: "submitted", labels: ["submitted"],
    assignee: null, milestone: "Sprint 1", open: true, updatedAt: "2026-08-25T10:00:00Z", ...overrides,
  };
}

function fakeApi(overrides: Partial<BoardApi> = {}): BoardApi {
  return {
    createIssue: vi.fn(async () => task()),
    getIssue: vi.fn(async () => task()),
    listIssues: vi.fn(async () => [task()]),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ id: 1, url: "https://github.com/o/r/issues/12#issuecomment-1" })),
    pullRequestExists: vi.fn(async () => true),
    listComments: vi.fn(async () => []),
    listMilestones: vi.fn(async () => [{ number: 3, title: "Sprint 1" }]),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    ...overrides,
  };
}

const brief = {
  title: "Build the task board",
  objective: "Worker-side board module.",
  outputFormat: "A PR.",
  boundaries: "No sprint open/close.",
};

describe("createTask", () => {
  it("opens the issue with the submitted label — the board's only entry state", async () => {
    const api = fakeApi();
    const res = await createTask(api, "o/r", brief);

    expect(res.ok).toBe(true);
    expect(api.createIssue).toHaveBeenCalledWith("o/r", expect.objectContaining({
      title: "Build the task board", labels: ["submitted"],
    }));
    const input = vi.mocked(api.createIssue).mock.calls[0][1];
    expect(input.body).toContain("## Objective");
    expect(input.body).toContain("Worker-side board module.");
    expect(input.milestone).toBeUndefined();
  });

  it("resolves a sprint title to its milestone number", async () => {
    const api = fakeApi();
    await createTask(api, "o/r", { ...brief, milestone: "Sprint 1" });
    expect(vi.mocked(api.createIssue).mock.calls[0][1].milestone).toBe(3);
  });

  it("matches a sprint title regardless of case", async () => {
    const api = fakeApi();
    await createTask(api, "o/r", { ...brief, milestone: "sprint 1" });
    expect(vi.mocked(api.createIssue).mock.calls[0][1].milestone).toBe(3);
  });

  it("refuses an unknown sprint rather than creating one — sprint open owns that", async () => {
    const api = fakeApi();
    const res = await createTask(api, "o/r", { ...brief, milestone: "Sprint 9" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(res.message).toContain("Sprint 9");
    expect(res.message).toContain("Sprint 1");
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("refuses an incomplete brief as a 400, before any GitHub call", async () => {
    const api = fakeApi();
    const res = await createTask(api, "o/r", { title: "t", objective: "o" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(api.listMilestones).not.toHaveBeenCalled();
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  // Task 5: the maestro's per-task authorization for the junior skill.
  it("createTask writes the junior label in the same single create call", async () => {
    const api = fakeApi();
    await createTask(api, "acme-org/websites", {
      title: "t", objective: "o", outputFormat: "f", boundaries: "b",
      assignee: "websites--web-studio", junior: true,
    });
    expect(vi.mocked(api.createIssue).mock.calls.length).toBe(1);
    expect(vi.mocked(api.createIssue).mock.calls[0][1].labels)
      .toEqual(["submitted", "studio:websites--web-studio", "junior"]);
  });

  // PR #9 review, blocker B1: `hasJuniorAuthorizedTask` (label-gated) is gone
  // — JUNIOR_LABEL is no longer this module's concern at all, on purpose (see
  // findLiveAssignedTask's own doc comment). This block now proves only the
  // board-signal half (open/state/assignee); the actual junior authorization
  // decision is D1-backed and covered by test/junior.authz.test.ts and
  // test/junior.route.test.ts's B1 mutation test.
  describe("findLiveAssignedTask", () => {
    const S = "websites--web-studio";
    const withTasks = (tasks: BoardTask[]) => fakeApi({ listIssues: vi.fn(async () => tasks) });
    it("finds the live task assigned to the studio — no label required", async () => {
      const t = task({ state: "working", labels: ["working", studioLabel(S)], assignee: S });
      const api = withTasks([t]);
      // listTasks (the underlying call) adds `stale`, same as every other
      // BoardTaskView it returns — see that function's own return type.
      expect(await findLiveAssignedTask(api, "acme-org/websites", S)).toEqual({ ok: true, value: { ...t, stale: false } });
    });
    it("null when the only task is completed", async () => {
      const api = withTasks([task({ state: "completed", open: false, labels: ["completed", studioLabel(S)], assignee: S })]);
      expect(await findLiveAssignedTask(api, "acme-org/websites", S)).toEqual({ ok: true, value: null });
    });
    // Review gap: the plan's own comment demands the helper check
    // `studioLabel(S)` explicitly rather than trust `listTasks`'s label
    // filter blindly, "in case a test double ignores that filter". Prove it:
    // a fake that returns a task belonging to ANOTHER studio (as if the
    // assignedTo filter were never applied) must not be found for S.
    it("ignores a live task assigned to a DIFFERENT studio, even if listIssues does not honor the filter", async () => {
      const other = "websites--release-studio";
      const api = withTasks([
        task({ state: "working", labels: ["working", studioLabel(other)], assignee: other }),
      ]);
      expect(await findLiveAssignedTask(api, "acme-org/websites", S)).toEqual({ ok: true, value: null });
    });
    // Board board.ts's own #124-review rule for resolveLatestAssignedBrief
    // applies here too: a terminal board state leaves the ISSUE open (sprint
    // close is what closes it), so `open` alone is not "live" — both `open`
    // AND a LIVE_TASK_STATES state are required, independently.
    it("null for a task that is a terminal state but the issue is still open", async () => {
      const api = withTasks([task({ state: "completed", open: true, labels: ["completed", studioLabel(S)], assignee: S })]);
      expect(await findLiveAssignedTask(api, "acme-org/websites", S)).toEqual({ ok: true, value: null });
    });
    // The mirror case: a live-looking state label on an issue GitHub already
    // shows closed. `open` still gates it, even with the state label intact.
    it("null for a task carrying a live state label but the issue itself is closed", async () => {
      const api = withTasks([task({ state: "working", open: false, labels: ["working", studioLabel(S)], assignee: S })]);
      expect(await findLiveAssignedTask(api, "acme-org/websites", S)).toEqual({ ok: true, value: null });
    });
  });
});

describe("transitionTask", () => {
  it("removes the observed label and adds the new one, in that order", async () => {
    const api = fakeApi();
    const res = await transitionTask(api, "o/r", 12, { from: "submitted", to: "working" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 12, "submitted");
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 12, ["working"]);
    expect(res.value.state).toBe("working");
    expect(res.value.labels).toEqual(["working"]);
  });

  // Issue #248: after reap closed #107, `fleet task state 107 input_required`
  // relabelled a CLOSED issue — the board read parked, GitHub read done.
  for (const to of ["submitted", "working", "input_required"] as const) {
    it(`refuses to put a GitHub-closed issue into open state ${to}, and writes nothing`, async () => {
      const api = fakeApi({ getIssue: vi.fn(async () => task({ open: false, state: "completed", labels: ["completed"] })) });
      const res = await transitionTask(api, "o/r", 12, { from: "completed", to });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(409);
      expect(res.message).toBe(
        `task #12 is closed on GitHub; the Worker does not reopen issues, so it will not label it "${to}" — ` +
        "reopen the issue first, or file a new task",
      );
      expect(api.removeLabel).not.toHaveBeenCalled();
      expect(api.addLabels).not.toHaveBeenCalled();
    });
  }

  it("a GitHub-closed issue may still move between closed states (completed -> canceled)", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ open: false, state: "completed", labels: ["completed"] })) });
    const res = await transitionTask(api, "o/r", 12, { from: "completed", to: "canceled" });
    expect(res.ok).toBe(true);
  });

  it("refuses an unknown target state, naming the vocabulary", async () => {
    const api = fakeApi();
    const res = await transitionTask(api, "o/r", 12, { from: "submitted", to: "in-progress" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.message).toContain("input_required");
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("refuses an unknown source state too, without reading the issue", async () => {
    const api = fakeApi();
    const res = await transitionTask(api, "o/r", 12, { from: "queued", to: "working" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(api.getIssue).not.toHaveBeenCalled();
  });

  it("requires both ends of the transition — a blind write is what drift is made of", async () => {
    const api = fakeApi();
    const res = await transitionTask(api, "o/r", 12, { to: "working" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.message).toContain("from");
  });

  it("refuses when the issue is not in the state the caller expected", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })) });
    const res = await transitionTask(api, "o/r", 12, { from: "submitted", to: "completed" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain("working");
    expect(res.message).toContain("submitted");
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("refuses an issue carrying no state label — the Worker did not write it", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: null, labels: ["bug"] })) });
    const res = await transitionTask(api, "o/r", 12, { from: "submitted", to: "working" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain("no board state label");
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous issue and names both labels it found", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: null, labels: ["working", "completed"] })) });
    const res = await transitionTask(api, "o/r", 12, { from: "working", to: "completed" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain("working");
    expect(res.message).toContain("completed");
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("writes nothing for a transition onto the state already held", async () => {
    const api = fakeApi();
    const res = await transitionTask(api, "o/r", 12, { from: "submitted", to: "submitted" });
    expect(res.ok).toBe(true);
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  // Issue #55: a terminal board state left the issue OPEN (226 stale in one
  // repo). Now the transition closes it, after the label, with GitHub's own
  // reason: completed = "completed", canceled/failed = "not_planned".
  for (const [to, reason] of [["completed", "completed"], ["canceled", "not_planned"], ["failed", "not_planned"]] as const) {
    it(`working -> ${to} closes the open issue as ${reason}, after the label write`, async () => {
      const order: string[] = [];
      const api = fakeApi({
        getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })),
        addLabels: vi.fn(async () => { order.push("label"); }),
        closeIssue: vi.fn(async () => { order.push("close"); }),
      });
      const res = await transitionTask(api, "o/r", 12, { from: "working", to });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12, reason);
      expect(order).toEqual(["label", "close"]);
      expect(res.value.open).toBe(false);
    });
  }

  it("a live transition never closes", async () => {
    const api = fakeApi();
    await transitionTask(api, "o/r", 12, { from: "submitted", to: "working" });
    expect(api.closeIssue).not.toHaveBeenCalled();
  });

  it("an already-closed issue moving between terminal states is not closed again", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ open: false, state: "completed", labels: ["completed"] })) });
    await transitionTask(api, "o/r", 12, { from: "completed", to: "canceled" });
    expect(api.closeIssue).not.toHaveBeenCalled();
  });

  it("terminal onto itself, issue still open (a close that failed last time): closes, no label writes", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"] })) });
    const res = await transitionTask(api, "o/r", 12, { from: "completed", to: "completed" });
    expect(res.ok).toBe(true);
    expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12, "completed");
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("terminal onto itself, issue closed: nothing at all", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ open: false, state: "canceled", labels: ["canceled"] })) });
    await transitionTask(api, "o/r", 12, { from: "canceled", to: "canceled" });
    expect(api.closeIssue).not.toHaveBeenCalled();
  });
});

describe("commentEnvelope", () => {
  const envelope = {
    sender: "websites--web-studio", intent: "result", status: "ok", notes: "done",
    verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
  };

  it("posts one rendered comment and hands back its url", async () => {
    const api = fakeApi();
    const res = await commentEnvelope(api, "o/r", 12, envelope, MSG_ID);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const body = vi.mocked(api.createComment).mock.calls[0][2];
    expect(body).toContain("websites--web-studio");
    expect(parseEnvelopeComment(body)?.envelope.msg_id).toBe(MSG_ID);
    expect(parseEnvelopeComment(body)?.envelope.task_id).toBe(12);
    expect(res.value.url).toContain("issuecomment-1");
  });

  it("refuses a malformed envelope as a 400 without commenting", async () => {
    const api = fakeApi();
    const res = await commentEnvelope(api, "o/r", 12, { sender: "s", intent: "gossip", status: "ok" }, MSG_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("refuses to comment on an issue that is not a board task", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: null, labels: [] })) });
    const res = await commentEnvelope(api, "o/r", 12, envelope, MSG_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("does NOT move the task's state — an envelope reports, the Worker decides", async () => {
    const api = fakeApi();
    await commentEnvelope(api, "o/r", 12, { ...envelope, status: "failed" }, MSG_ID);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });
});

describe("listTasks", () => {
  it("shows BACKLOG — an issue with no state label is not hidden (P5 §3)", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task(),
        // the operator's phone: raw `gh issue create`, no labels at all. This is the
        // row whose absence made a filed issue look inert.
        task({ number: 13, state: null, labels: [] }),
        task({ number: 14, state: null, labels: ["bug"] }),
        task({ number: 15, state: null, labels: ["working", "failed"] }),
      ]),
    });
    const res = await listTasks(api, "o/r", {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 15 is drifted, not absent: an ambiguous task must stay VISIBLE on the
    // board, or the drift it represents is invisible too.
    expect(res.value.map((t) => t.number)).toEqual([12, 13, 14, 15]);
  });

  it("drops a CLOSED issue with no state label — repo history, never backlog", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({ number: 13, state: null, labels: [], open: false }),
        // A task the Worker DID write a state onto stays visible after sprint
        // close closes the issue.
        task({ number: 14, state: "completed", labels: ["completed"], open: false }),
        task({ number: 15, state: null, labels: [], open: true }),
      ]),
    });
    const res = await listTasks(api, "o/r", {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((t) => t.number)).toEqual([14, 15]);
  });

  it("flags stale backlog mechanically: age + no assignment + no blocker", async () => {
    const now = Date.parse("2026-08-28T00:00:00Z");
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        // 3 days untouched, unassigned, unblocked -> stale
        task({ number: 13, state: null, labels: [], updatedAt: "2026-08-24T00:00:00Z" }),
        // same age, but a studio owns it -> not backlog at all
        task({
          number: 14, state: "submitted", labels: ["submitted", studioLabel("r--web-studio")],
          assignee: "r--web-studio", updatedAt: "2026-08-24T00:00:00Z",
        }),
        // same age, unassigned, but BLOCKED on an answer -> not stale
        task({ number: 15, state: "input_required", labels: ["input_required"], updatedAt: "2026-08-24T00:00:00Z" }),
        // unassigned and unblocked, but filed this morning -> not stale yet
        task({ number: 16, state: null, labels: [], updatedAt: "2026-08-27T23:00:00Z" }),
      ]),
    });
    const res = await listTasks(api, "o/r", {}, now);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((t) => [t.number, t.stale])).toEqual([[13, true], [14, false], [15, false], [16, false]]);
  });

  it("resolves a milestone title and passes a state label through as a server-side filter", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => []) });
    const res = await listTasks(api, "o/r", { milestone: "Sprint 1", state: "working" });
    expect(res.ok).toBe(true);
    expect(api.listIssues).toHaveBeenCalledWith("o/r", { milestone: 3, labels: ["working"] });
  });

  it("refuses an unknown state filter and an unknown milestone", async () => {
    const api = fakeApi();
    const badState = await listTasks(api, "o/r", { state: "doing" });
    expect(badState.ok).toBe(false);
    if (!badState.ok) expect(badState.status).toBe(400);

    const badMilestone = await listTasks(api, "o/r", { milestone: "Sprint 9" });
    expect(badMilestone.ok).toBe(false);
    if (!badMilestone.ok) expect(badMilestone.status).toBe(404);
  });
});

describe("showTask", () => {
  it("returns the task, its brief, and every comment with its envelope decoded", async () => {
    const parsed = parseEnvelope(
      { sender: "a", intent: "result", status: "ok", verification: { url: "https://x.test", steps: ["open it"], expected: "it works" } },
      12, MSG_ID,
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const api = fakeApi({
      listComments: vi.fn(async () => [
        { id: 1, url: "u1", author: "example-bot[bot]", createdAt: "t1", body: renderEnvelopeComment(parsed.doc) },
        { id: 2, url: "u2", author: "rafarc21", createdAt: "t2", body: "looks good" },
      ]),
    });

    const res = await showTask(api, "o/r", 12);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.task.number).toBe(12);
    expect(res.value.task.body).toContain("## Objective");
    expect(res.value.comments[0].envelope?.envelope.msg_id).toBe(MSG_ID);
    expect(res.value.comments[1].envelope).toBeNull();
  });
});

describe("resolveBoardRepo", () => {
  const REMEDY = "is not reachable by this fleet — grant it access first";
  /** The P6a reachability port, standing in for a provider that can reach
   *  exactly these repos. src/github/auth.ts covers the real App and token
   *  answers; this file covers the rule that consumes them. */
  const reaching = (repos: string[]) => vi.fn(async (slug: string): Promise<RepoReach> =>
    repos.some((full) => full.toLowerCase() === slug.toLowerCase())
      ? { reachable: true }
      : { reachable: false, remedy: REMEDY });
  const deps = { reachRepo: reaching(["acme-org/websites", "acme-org/beta"]) };

  it("falls back to the fleet's own repo, unverified — that value is deployment config", async () => {
    const reachRepo = reaching([]);
    const res = await resolveBoardRepo({ reachRepo }, { requested: undefined, defaultSlug: "acme-org/websites" });
    expect(res).toEqual({ ok: true, value: "acme-org/websites" });
    expect(reachRepo).not.toHaveBeenCalled();
  });

  it("verifies a caller's repo against the fleet's own credential", async () => {
    const res = await resolveBoardRepo(deps, { requested: "acme-org/beta", defaultSlug: "acme-org/websites" });
    expect(res).toEqual({ ok: true, value: "acme-org/beta" });
  });

  it("refuses a repo the fleet cannot reach, carrying the provider's own remedy", async () => {
    const res = await resolveBoardRepo(deps, { requested: "someone/else", defaultSlug: "acme-org/websites" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.message).toBe(`repo "someone/else" ${REMEDY}`);
  });

  it("refuses a malformed slug without calling GitHub", async () => {
    const reachRepo = reaching([]);
    const res = await resolveBoardRepo({ reachRepo }, { requested: "not-a-slug", defaultSlug: "acme-org/websites" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(reachRepo).not.toHaveBeenCalled();
  });

  it("answers 503, not 500, when reachability cannot be answered", async () => {
    const reachRepo = vi.fn(async (): Promise<RepoReach> => { throw new Error("github down"); });
    const res = await resolveBoardRepo({ reachRepo }, { requested: "acme-org/beta", defaultSlug: "acme-org/websites" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(503);
  });
});

// --- §5 assignment: which studio owns a task (P4a-2) -------------------------

describe("taskAssignees", () => {
  it("reads the ids out of studio: labels and ignores every other label", () => {
    expect(taskAssignees(["submitted", "studio:websites--web-studio", "bug"]))
      .toEqual(["websites--web-studio"]);
  });

  it("returns a LIST so zero and two are distinguishable from one", () => {
    expect(taskAssignees(["submitted"])).toEqual([]);
    expect(taskAssignees([studioLabel("a--b"), studioLabel("c--d")])).toEqual(["a--b", "c--d"]);
  });

  it("carries a label that is not a studio id verbatim — drift stays visible", () => {
    // Dropping it would make a hand-typed `studio:oops` read as unassigned.
    // Nothing is granted by it: ownership is compared against a token-resolved
    // id, never against the shape of this list.
    expect(taskAssignees(["studio:oops"])).toEqual(["oops"]);
    expect(taskAssignees(["studio:"])).toEqual([]);
  });
});

describe("createTask — assignment", () => {
  const brief = {
    title: "T", objective: "O", outputFormat: "F", boundaries: "B",
  };

  it("writes the studio label ALONGSIDE the entry state, in one create call", async () => {
    const api = fakeApi();
    await createTask(api, "o/r", { ...brief, assignee: "websites--web-studio" });
    expect(vi.mocked(api.createIssue).mock.calls[0][1].labels)
      .toEqual(["submitted", "studio:websites--web-studio"]);
    // One call, not create-then-label: an issue with a state and no owner is a
    // window in which the studio being spawned for it would not see it.
    expect(vi.mocked(api.addLabels)).not.toHaveBeenCalled();
  });

  it("files an unassigned task with the state label alone", async () => {
    const api = fakeApi();
    await createTask(api, "o/r", brief);
    expect(vi.mocked(api.createIssue).mock.calls[0][1].labels).toEqual(["submitted"]);
  });

  it("refuses an assignee that is not a studio id, before any GitHub call", async () => {
    const api = fakeApi();
    const res = await createTask(api, "o/r", { ...brief, assignee: "web-studio" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    expect(vi.mocked(api.createIssue)).not.toHaveBeenCalled();
  });
});

describe("listTasks — assignedTo", () => {
  it("filters SERVER-side, so another studio's task never reaches this Worker", async () => {
    const api = fakeApi();
    await listTasks(api, "o/r", { assignedTo: "websites--web-studio" });
    expect(vi.mocked(api.listIssues).mock.calls[0][1].labels).toEqual(["studio:websites--web-studio"]);
  });

  it("composes with the state filter rather than replacing it (GitHub ANDs labels)", async () => {
    const api = fakeApi();
    await listTasks(api, "o/r", { state: "working", assignedTo: "websites--web-studio" });
    expect(vi.mocked(api.listIssues).mock.calls[0][1].labels)
      .toEqual(["working", "studio:websites--web-studio"]);
  });
});

describe("assignTask — adoption and reassignment (P5 §3)", () => {
  const WEB = "websites--web-studio";
  const RELEASE = "websites--release-studio";
  const AT = "2026-08-28T12:00:00Z";
  const adopt = { mode: "adopt" as const, at: AT };
  const reassign = { mode: "reassign" as const, at: AT };

  /** the operator's phone: raw `gh issue create`, no labels at all. */
  const bare = () => task({ number: 42, state: null, labels: [], assignee: null });

  it("adopts a bare backlog issue: stamps the studio label and the entry state", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => bare()) });
    const res = await assignTask(api, "o/r", 42, { assignee: WEB }, adopt);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 42, [studioLabel(WEB), "submitted"]);
    expect(res.value.labels).toEqual([studioLabel(WEB), "submitted"]);
    expect(res.value.state).toBe("submitted");
    expect(res.value.assignee).toBe(WEB);
  });

  it("adopts a LABELLED issue too — the state is reset, not preserved", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: "working", labels: ["working"] })) });
    const res = await assignTask(api, "o/r", 42, { assignee: WEB }, adopt);

    expect(res.ok).toBe(true);
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, "working");
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 42, [studioLabel(WEB), "submitted"]);
  });

  it("comments the lineage — from, to, when, why — on the adoption too", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => bare()) });
    await assignTask(api, "o/r", 42, { assignee: WEB, why: "the operator filed it from his phone" }, adopt);

    const comment = vi.mocked(api.createComment).mock.calls[0][2];
    expect(comment).toContain("Adopted");
    expect(comment).toContain("backlog");
    expect(comment).toContain(WEB);
    expect(comment).toContain(AT);
    expect(comment).toContain("the operator filed it from his phone");
  });

  it("refuses to adopt a task another studio holds, and names the verb that can", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["working", studioLabel(RELEASE)], state: "working", assignee: RELEASE })),
    });
    const res = await assignTask(api, "o/r", 42, { assignee: WEB }, adopt);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain(RELEASE);
    expect(res.message).toContain("fleet task assign");
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("reassigns: old studio label off, new one on, state back to submitted", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["working", studioLabel(WEB)], state: "working", assignee: WEB })),
    });
    const res = await assignTask(api, "o/r", 42, { assignee: RELEASE, why: "web studio died" }, reassign);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(api.removeLabel).toHaveBeenNthCalledWith(1, "o/r", 42, studioLabel(WEB));
    expect(api.removeLabel).toHaveBeenNthCalledWith(2, "o/r", 42, "working");
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 42, [studioLabel(RELEASE), "submitted"]);
    expect(res.value.labels).toEqual([studioLabel(RELEASE), "submitted"]);
    expect(res.value.assignee).toBe(RELEASE);

    const comment = vi.mocked(api.createComment).mock.calls[0][2];
    expect(comment).toContain("Reassigned");
    expect(comment).toContain(`from: ${WEB}`);
    expect(comment).toContain(`to: ${RELEASE}`);
    expect(comment).toContain(`when: ${AT}`);
    expect(comment).toContain("web studio died");
  });

  it("never deletes a comment — the dead studio's envelopes are the history", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["working", studioLabel(WEB)], state: "working", assignee: WEB })),
    });
    await assignTask(api, "o/r", 42, { assignee: RELEASE }, reassign);
    // The port has no delete verb at all: history cannot be removed by this
    // path even by mistake.
    expect(Object.keys(api)).not.toContain("deleteComment");
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  it("repairs assignment drift: two studio labels off, the named one on", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({
        number: 42, labels: ["submitted", studioLabel(WEB), studioLabel("websites--pilot")], state: "submitted", assignee: null,
      })),
    });
    const res = await assignTask(api, "o/r", 42, { assignee: RELEASE }, reassign);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, studioLabel(WEB));
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, studioLabel("websites--pilot"));
    expect(res.value.labels).toEqual(["submitted", studioLabel(RELEASE)]);
    expect(vi.mocked(api.createComment).mock.calls[0][2]).toContain(`from: ${WEB}, websites--pilot`);
  });

  it("refuses STATE drift — two state labels cannot be resolved by naming a destination", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["working", "failed"], state: null })),
    });
    const res = await assignTask(api, "o/r", 42, { assignee: WEB }, reassign);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain("working");
    expect(res.message).toContain("failed");
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("writes nothing at all when the task is already there — no labels, no comment", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["submitted", studioLabel(WEB)], state: "submitted", assignee: WEB })),
    });
    const res = await assignTask(api, "o/r", 42, { assignee: WEB }, adopt);

    expect(res.ok).toBe(true);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("refuses an assignee that is not a studio id, before any GitHub call", async () => {
    const api = fakeApi();
    for (const assignee of [undefined, "", "web-studio", 7]) {
      const res = await assignTask(api, "o/r", 42, { assignee }, adopt);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(400);
    }
    expect(api.getIssue).not.toHaveBeenCalled();
  });
});

// Board issue #41, half one, and board issue #158: the hook the wake edge
// hangs off. It fires on a real board write AND on the same-studio no-op —
// #158 measured that second case as a coordinator's deliberate nudge to an
// idle lead, answered with a success-shaped response that woke nobody.

describe("assignTask / createTask — the onAssigned hook (board issue #41)", () => {
  const WEB = "websites--web-studio";
  const AT = "2026-08-28T12:00:00Z";

  it("fires once, naming the studio and the task, when an adoption lands", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask) => {});
    await assignTask(api, "o/r", 42, { assignee: WEB }, { mode: "adopt", at: AT, onAssigned });

    expect(onAssigned).toHaveBeenCalledTimes(1);
    expect(onAssigned.mock.calls[0][0]).toBe(WEB);
    expect(onAssigned.mock.calls[0][1].number).toBe(42);
  });

  it("fires once when a reassignment lands", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["working", studioLabel("websites--release-studio")] })),
    });
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask) => {});
    await assignTask(api, "o/r", 42, { assignee: WEB }, { mode: "reassign", at: AT, onAssigned });
    expect(onAssigned).toHaveBeenCalledTimes(1);
  });

  it("board #158: fires on the no-op too — a same-studio re-assign still wakes the lead, though it writes nothing", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["submitted", studioLabel(WEB)], assignee: WEB })),
    });
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask) => {});
    const res = await assignTask(api, "o/r", 42, { assignee: WEB }, { mode: "adopt", at: AT, onAssigned });
    expect(res.ok).toBe(true);
    expect(onAssigned).toHaveBeenCalledTimes(1);
    expect(onAssigned.mock.calls[0][0]).toBe(WEB);
    expect(onAssigned.mock.calls[0][1].number).toBe(42);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("board #158: the no-op passes `why` as the hook's 3rd argument", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["submitted", studioLabel(WEB)], assignee: WEB })),
    });
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask, _why?: string | null) => {});
    await assignTask(api, "o/r", 42, { assignee: WEB, why: "nudging the idle lead" }, { mode: "adopt", at: AT, onAssigned });
    expect(onAssigned).toHaveBeenCalledTimes(1);
    expect(onAssigned.mock.calls[0][2]).toBe("nudging the idle lead");
  });

  it("board #158: a real move passes NO `why` to the hook — the lineage comment already carries it", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["working", studioLabel("websites--release-studio")] })),
    });
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask, _why?: string | null) => {});
    await assignTask(
      api, "o/r", 42, { assignee: WEB, why: "web studio died" }, { mode: "reassign", at: AT, onAssigned },
    );
    expect(onAssigned).toHaveBeenCalledTimes(1);
    expect(onAssigned.mock.calls[0][2]).toBeUndefined();
  });

  it("does NOT fire on a refusal — no assignment, no wake", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["working", "failed"], state: null })),
    });
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask) => {});
    await assignTask(api, "o/r", 42, { assignee: WEB }, { mode: "reassign", at: AT, onAssigned });
    expect(onAssigned).not.toHaveBeenCalled();
  });

  it("a throwing hook never fails the assignment that already landed on GitHub", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
    const res = await assignTask(api, "o/r", 42, { assignee: WEB }, {
      mode: "adopt", at: AT, onAssigned: async () => { throw new Error("DO unreachable"); },
    });
    expect(res.ok).toBe(true);
  });

  it("fires for a task FILED with an assignee — `fleet task new --studio` wakes it too", async () => {
    const api = fakeApi({ createIssue: vi.fn(async () => task({ number: 99, assignee: WEB })) });
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask) => {});
    await createTask(api, "o/r", { ...brief, assignee: WEB }, onAssigned);
    expect(onAssigned).toHaveBeenCalledTimes(1);
    expect(onAssigned.mock.calls[0][0]).toBe(WEB);
    expect(onAssigned.mock.calls[0][1].number).toBe(99);
  });

  it("does NOT fire for a task filed into the backlog with no assignee", async () => {
    const api = fakeApi();
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask) => {});
    await createTask(api, "o/r", brief, onAssigned);
    expect(onAssigned).not.toHaveBeenCalled();
  });
});

// Board issue #41, half two: a lead moves the state of its OWN task.
//
// The gap it closes: `fleet` inside the container has no `task state` verb at
// all, so a task a lead is ACTIVELY working sits at `submitted` until a
// coordinator moves it by hand — and any monitor watching board state reads
// `submitted` on a healthy working studio and concludes it stalled. That is a
// false negative in the expensive direction.

describe("transitionStudioTask — a lead moves its OWN task, and only so far", () => {
  const MINE = "websites--web-studio";
  const THEIRS = "websites--release-studio";
  const mine = (overrides: Partial<BoardTask> = {}) =>
    task({ number: 42, labels: ["submitted", studioLabel(MINE)], state: "submitted", assignee: MINE, ...overrides });

  it("moves the caller's own task to working", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "working" }, MINE);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.state).toBe("working");
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, "submitted");
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 42, ["working"]);
  });

  it("moves it to input_required and to failed", async () => {
    for (const to of ["input_required", "failed"]) {
      const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
      const res = await transitionStudioTask(api, "o/r", 42, { to }, MINE);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.state).toBe(to);
    }
  });

  it("REFUSES completed — that is the verifier's verdict, never the worker's — and writes no label", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "completed" }, MINE);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.message).toContain("completed");
    expect(res.message).toContain("working, input_required, failed");
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("refuses completed BEFORE reading the issue — the attempt costs not one GitHub call", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
    await transitionStudioTask(api, "o/r", 42, { to: "completed" }, MINE);
    expect(api.getIssue).not.toHaveBeenCalled();
  });

  it("refuses canceled and submitted too — the allowlist is exactly three states", async () => {
    for (const to of ["canceled", "submitted"]) {
      const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
      const res = await transitionStudioTask(api, "o/r", 42, { to }, MINE);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(403);
      expect(api.addLabels).not.toHaveBeenCalled();
    }
  });

  it("400s a state outside the vocabulary entirely, naming the vocabulary", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "in-progress" }, MINE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("404s a task assigned to ANOTHER studio and writes nothing", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, labels: ["submitted", studioLabel(THEIRS)] })) });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "working" }, MINE);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("reads `from` off the board itself, so a lead never has to know its current state", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine({ labels: ["working", studioLabel(MINE)], state: "working" })) });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "input_required" }, MINE);
    expect(res.ok).toBe(true);
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, "working");
  });

  it("refuses STATE drift — two labels, so which one the Worker last wrote is unknowable", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => mine({ labels: ["working", "failed", studioLabel(MINE)], state: null })),
    });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "working" }, MINE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("refuses an issue the Worker never stamped — it will not adopt a state it did not write", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine({ labels: [studioLabel(MINE)], state: null })) });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "working" }, MINE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("writes nothing when the task is already in the state asked for", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine({ labels: ["working", studioLabel(MINE)], state: "working" })) });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "working" }, MINE);
    expect(res.ok).toBe(true);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });
});

describe("requireAssignedTask — a studio reads only its own", () => {
  const MINE = "websites--web-studio";
  const owned = () => task({ labels: ["submitted", studioLabel(MINE)], assignee: MINE });

  it("hands over a task carrying this studio's label", async () => {
    const res = await requireAssignedTask(fakeApi({ getIssue: vi.fn(async () => owned()) }), "o/r", 12, MINE);
    expect(res.ok).toBe(true);
  });

  it("404s a task assigned to somebody else, and names the CALLER, never the owner", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel("websites--release-studio")] })) });
    const res = await requireAssignedTask(api, "o/r", 12, MINE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.message).toContain(MINE);
      // Leaking the real owner would turn this route into a board-wide read,
      // one issue number at a time.
      expect(res.message).not.toContain("release-studio");
    }
  });

  it("404s an unassigned task — no owner is not the same as any owner", async () => {
    const res = await requireAssignedTask(fakeApi(), "o/r", 12, MINE);
    expect(res.ok).toBe(false);
  });

  it("accepts membership, not exclusivity: a second (drifted) label does not lock a lead out of its own brief", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(MINE), studioLabel("websites--release-studio")] })),
    });
    expect((await requireAssignedTask(api, "o/r", 12, MINE)).ok).toBe(true);
  });
});

describe("showStudioTask / commentStudioEnvelope / resolveBriefPrompt — the gate applies to all three", () => {
  const MINE = "websites--web-studio";
  const ownedApi = (over: Partial<BoardApi> = {}) => fakeApi({
    getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(MINE)], assignee: MINE })),
    ...over,
  });

  it("show refuses a task that is not the caller's, and never reads its comments", async () => {
    const api = fakeApi();
    const res = await showStudioTask(api, "o/r", 12, MINE);
    expect(res.ok).toBe(false);
    expect(vi.mocked(api.listComments)).not.toHaveBeenCalled();
  });

  it("show returns the brief and the comments once the gate passes", async () => {
    const res = await showStudioTask(ownedApi(), "o/r", 12, MINE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.task.number).toBe(12);
  });

  it("envelope STAMPS the sender — a studio cannot sign as another studio", async () => {
    const api = ownedApi();
    const res = await commentStudioEnvelope(
      api, "o/r", 12,
      { sender: "websites--release-studio", intent: "result", status: "ok",
        verification: { url: "https://x.test", steps: ["open it"], expected: "it works" } },
      MSG_ID, MINE,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.envelope.envelope.sender).toBe(MINE);
    expect(vi.mocked(api.createComment).mock.calls[0][2]).toContain(MINE);
  });

  it("envelope refuses a task that is not the caller's, and posts nothing", async () => {
    const api = fakeApi();
    const res = await commentStudioEnvelope(api, "o/r", 12, { intent: "result", status: "ok" }, MSG_ID, MINE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
    expect(vi.mocked(api.createComment)).not.toHaveBeenCalled();
  });

  it("brief resolution refuses a task that is not the studio's — no brief crosses the boundary", async () => {
    const res = await resolveBriefPrompt(fakeApi(), "o/r", 12, MINE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("brief resolution renders the issue, its url and the report verb for the owning studio", async () => {
    const res = await resolveBriefPrompt(ownedApi(), "o/r", 12, MINE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toContain("#12");
      expect(res.value).toContain("https://github.com/o/r/issues/12");
      expect(res.value).toContain("Ship it.");
      expect(res.value).toContain("fleet task report 12");
      expect(res.value).toContain(MINE);
    }
  });
});

// Fleet board task #118 — the adopted-task fix's board-side half:
// resolveLatestAssignedBrief is what src/studio/provision.ts's
// resolveBringupEnv falls back to when a caller (recycle, a bodyless
// re-provision) supplied no task number at all.
describe("resolveLatestAssignedBrief — the adopted-task fallback (board task #118)", () => {
  const MINE = "websites--web-studio";

  it("no open task carries this studio's label: resolves null, never throws", async () => {
    // fakeApi()'s default listIssues returns one task with no studio label —
    // the assignedTo label filter itself is asserted elsewhere (listTasks —
    // assignedTo); here it's simply not MINE's task.
    const api = fakeApi({ listIssues: vi.fn(async () => []) });
    expect(await resolveLatestAssignedBrief(api, "o/r", MINE)).toBeNull();
  });

  it("a closed task carrying the label is not picked up — only OPEN counts", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({
          number: 20, open: false, state: "completed", labels: ["completed", studioLabel(MINE)],
          assignee: MINE, updatedAt: "2026-08-29T00:00:00Z",
        }),
      ]),
    });
    expect(await resolveLatestAssignedBrief(api, "o/r", MINE)).toBeNull();
  });

  it("one open assigned task: resolves its rendered brief with no multi-task note", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({
          number: 21, title: "Ship the hero", body: "## Objective\n\nShip it.\n",
          state: "submitted", labels: ["submitted", studioLabel(MINE)], assignee: MINE,
          updatedAt: "2026-08-29T00:00:00Z",
        }),
      ]),
    });
    const result = await resolveLatestAssignedBrief(api, "o/r", MINE);
    expect(result?.taskNumber).toBe(21);
    expect(result?.title).toBe("Ship the hero");
    expect(result?.prompt).toContain("#21");
    expect(result?.prompt).toContain("Ship it.");
    expect(result?.prompt).not.toContain("Note:");
  });

  it("multiple open assigned tasks: picks the NEWEST (by updatedAt) and names the others in the prompt", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({
          number: 30, title: "Older task", body: "## Objective\n\nOlder.\n",
          state: "submitted", labels: ["submitted", studioLabel(MINE)], assignee: MINE,
          updatedAt: "2026-08-20T00:00:00Z",
        }),
        // Newest of the three — assigned/touched most recently.
        task({
          number: 32, title: "Newest task", body: "## Objective\n\nNewest.\n",
          state: "submitted", labels: ["submitted", studioLabel(MINE)], assignee: MINE,
          updatedAt: "2026-08-29T00:00:00Z",
        }),
        task({
          number: 31, title: "Middle task", body: "## Objective\n\nMiddle.\n",
          state: "submitted", labels: ["submitted", studioLabel(MINE)], assignee: MINE,
          updatedAt: "2026-08-25T00:00:00Z",
        }),
      ]),
    });
    const result = await resolveLatestAssignedBrief(api, "o/r", MINE);
    expect(result?.taskNumber).toBe(32);
    expect(result?.title).toBe("Newest task");
    expect(result?.prompt).toContain("#32");
    expect(result?.prompt).toContain("Newest.");
    // "Say so": the note names the chosen task and lists the others still open.
    expect(result?.prompt).toMatch(/Note:.*3 open tasks/);
    expect(result?.prompt).toContain("most recently assigned, #32");
    expect(result?.prompt).toContain("#30");
    expect(result?.prompt).toContain("#31");
  });

  it("listIssues throwing resolves to null (fail-open)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // An unknown state filter is not reachable through this function's own
    // call (it never sets `state`), so a thrown listIssues is the realistic
    // failure shape here — same fail-open posture provision.ts's
    // resolveMemoryIndex takes for its own upstream.
    const api = fakeApi({ listIssues: vi.fn(async () => { throw new Error("upstream unreachable"); }) });
    await expect(resolveLatestAssignedBrief(api, "o/r", MINE)).resolves.toBeNull();
    vi.restoreAllMocks();
  });
});

// Board #55 defect A: `fleet task state <n> completed` leaves the issue OPEN
// by design (sprint close closes it), so a destroy guard reading GitHub's
// open/closed refused on tasks the board already called finished. The guard
// reads BOARD state: open AND not terminal. A drifted task (no single state
// label) still blocks — fail closed.
describe("openAssignedTasks — the destroy guard's board read (#55 defect A)", () => {
  const MINE = "fleetflare--web-studio";
  const mine = (number: number, state: BoardTask["state"], open = true) =>
    task({ number, state, open, labels: [...(state ? [state] : []), studioLabel(MINE)], assignee: MINE });

  it("a completed/failed/canceled task whose issue is still OPEN does not block", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [mine(98, "completed"), mine(56, "canceled"), mine(40, "failed")]),
    });
    expect(await openAssignedTasks(api, "o/r", MINE)).toEqual({ ok: true, value: [] });
  });

  it("live tasks block and are named; closed issues never block", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        mine(90, "working"), mine(85, "submitted"), mine(66, "input_required"), mine(12, "working", false),
      ]),
    });
    expect(await openAssignedTasks(api, "o/r", MINE)).toEqual({ ok: true, value: [
      { number: 90, drifted: false }, { number: 85, drifted: false }, { number: 66, drifted: false },
    ] });
  });

  it("an open task with drifted state (no single state label) blocks — fail closed", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => [mine(7, null)]) });
    expect(await openAssignedTasks(api, "o/r", MINE)).toEqual({ ok: true, value: [{ number: 7, drifted: true }] });
  });
});

// #124 review, same bug class as #55 A: the bring-up brief resolver filtered
// on issue OPEN only, so a re-provisioned studio was handed a COMPLETED
// task's brief. Live shape 2026-09-24: completed #98 (14:12Z) newer than
// working #90 (13:56Z).
describe("resolveLatestAssignedBrief — board state, not issue open (#124 follow-up)", () => {
  const MINE = "fleetflare--web-studio";
  it("a newer COMPLETED task on an open issue never wins over a working one", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({ number: 98, title: "House rule", state: "completed", open: true,
          labels: ["completed", studioLabel(MINE)], assignee: MINE, updatedAt: "2026-09-24T14:12:00Z" }),
        task({ number: 90, title: "Cold start", state: "working", open: true,
          labels: ["working", studioLabel(MINE)], assignee: MINE, updatedAt: "2026-09-24T13:56:00Z" }),
      ]),
    });
    const result = await resolveLatestAssignedBrief(api, "o/r", MINE);
    expect(result?.taskNumber).toBe(90);
    expect(result?.prompt).not.toContain("#98");
  });

  it("only finished tasks: no brief", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({ number: 98, state: "completed", open: true, labels: ["completed", studioLabel(MINE)], assignee: MINE }),
        task({ number: 56, state: "canceled", open: true, labels: ["canceled", studioLabel(MINE)], assignee: MINE }),
      ]),
    });
    expect(await resolveLatestAssignedBrief(api, "o/r", MINE)).toBeNull();
  });
});

// Issue #139: GitHub created the issue, then the response came back a 520 —
// the caller saw a failure, retried, and filed a duplicate (#56 / #57). The
// fake below is a tiny stateful GitHub: createIssue WRITES first and only
// then fails, which is exactly the upstream behaviour that bit us.
describe("createTask — idempotency key (#139)", () => {
  function statefulGitHub(opts: { failFirstCreateAfterWrite?: boolean } = {}) {
    const issues: BoardTask[] = [];
    let failNext = opts.failFirstCreateAfterWrite === true;
    const api = fakeApi({
      createIssue: vi.fn(async (_repo, input) => {
        const created = task({ number: 100 + issues.length, title: input.title, body: input.body, labels: input.labels });
        issues.unshift(created);
        if (failNext) {
          failNext = false;
          throw new GitHubError(520, "POST /repos/o/r/issues failed (520): upstream");
        }
        return created;
      }),
      listIssues: vi.fn(async () => [...issues]),
    });
    return { api, issues };
  }

  it("a create that landed upstream but answered 520 resolves to the SAME issue, on the call and on retry", async () => {
    const { api, issues } = statefulGitHub({ failFirstCreateAfterWrite: true });
    const first = await createTask(api, "o/r", { ...brief, idempotencyKey: "k-0123456789abcdef" });
    const retry = await createTask(api, "o/r", { ...brief, idempotencyKey: "k-0123456789abcdef" });

    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(first.value.number).toBe(100);
    expect(retry.value.number).toBe(100);
    expect(issues).toHaveLength(1);
    expect(api.createIssue).toHaveBeenCalledTimes(1);
  });

  it("two different tasks with the same title still create two issues", async () => {
    const { api, issues } = statefulGitHub();
    const a = await createTask(api, "o/r", { ...brief, idempotencyKey: "k-aaaaaaaaaaaaaaaa" });
    const b = await createTask(api, "o/r", { ...brief, idempotencyKey: "k-bbbbbbbbbbbbbbbb" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.number).not.toBe(b.value.number);
    expect(issues).toHaveLength(2);
  });

  it("stores the key as a hidden marker in the issue body", async () => {
    const { api } = statefulGitHub();
    await createTask(api, "o/r", { ...brief, idempotencyKey: "k-0123456789abcdef" });
    expect(vi.mocked(api.createIssue).mock.calls[0][1].body).toContain("<!-- fleet-task-key: k-0123456789abcdef -->");
  });

  it("an upstream failure with nothing written still fails as before", async () => {
    const api = fakeApi({
      createIssue: vi.fn(async () => { throw new GitHubError(502, "down"); }),
      listIssues: vi.fn(async () => []),
    });
    await expect(createTask(api, "o/r", { ...brief, idempotencyKey: "k-0123456789abcdef" })).rejects.toThrow("down");
  });

  it("a replayed create wakes the assignee — the 520 path never reached the hook", async () => {
    const { api } = statefulGitHub({ failFirstCreateAfterWrite: true });
    const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask) => {});
    await createTask(api, "o/r", { ...brief, assignee: "websites--web-studio", idempotencyKey: "k-0123456789abcdef" }, onAssigned);
    expect(onAssigned).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onAssigned).mock.calls[0][1]).toMatchObject({ number: 100 });
  });

  it("refuses a malformed key as a 400, before any GitHub call", async () => {
    const api = fakeApi();
    const res = await createTask(api, "o/r", { ...brief, idempotencyKey: "has spaces -->" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.listIssues).not.toHaveBeenCalled();
  });

  it("two issues carrying the same key resolve to the OLDEST — the first filed is the task", async () => {
    const marker = "<!-- fleet-task-key: k-0123456789abcdef -->";
    const api = fakeApi({
      // GitHub's default order: newest first.
      listIssues: vi.fn(async () => [task({ number: 101, body: marker }), task({ number: 100, body: marker })]),
    });
    const res = await createTask(api, "o/r", { ...brief, idempotencyKey: "k-0123456789abcdef" });
    expect(res.ok && res.value.number).toBe(100);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("no key: no lookup, create exactly as before", async () => {
    const api = fakeApi();
    await createTask(api, "o/r", brief);
    expect(api.listIssues).not.toHaveBeenCalled();
    expect(vi.mocked(api.createIssue).mock.calls[0][1].body).not.toContain("fleet-task-key");
  });
});

// Issue #55: the backlog the old transition left behind -- terminal label,
// issue still open. `fleet task reap --terminal` closes it, a page per call.
describe("closeTerminalTasks", () => {
  const board = [
    task({ number: 1, state: "completed", labels: ["completed"] }),
    task({ number: 2, state: "canceled", labels: ["canceled"] }),
    task({ number: 3, state: "failed", labels: ["failed"] }),
    task({ number: 4, state: "working", labels: ["working"] }),
    task({ number: 5, state: "completed", labels: ["completed"], open: false }),
    task({ number: 6, state: null, labels: ["completed", "working"] }),
  ];

  it("dry-run: lists open terminal tasks with their reason, closes nothing", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => board) });
    const r = await closeTerminalTasks(api, "o/r", false);
    expect(r.results).toEqual([
      { number: 1, state: "completed", outcome: "would-close", reason: "completed" },
      { number: 2, state: "canceled", outcome: "would-close", reason: "not_planned" },
      { number: 3, state: "failed", outcome: "would-close", reason: "not_planned" },
    ]);
    expect(r.remaining).toBe(0);
    expect(api.closeIssue).not.toHaveBeenCalled();
  });

  it("apply: closes each with its reason; live, closed and ambiguous untouched", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => board) });
    const r = await closeTerminalTasks(api, "o/r", true);
    expect(r.results.map((x) => [x.number, x.outcome])).toEqual([[1, "closed"], [2, "closed"], [3, "closed"]]);
    expect(api.closeIssue).toHaveBeenCalledTimes(3);
    expect(api.closeIssue).toHaveBeenCalledWith("o/r", 2, "not_planned");
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("apply: at most TERMINAL_CLOSE_PAGE closes per call; `remaining` says how many are left", async () => {
    const many = Array.from({ length: TERMINAL_CLOSE_PAGE + 3 }, (_, i) =>
      task({ number: i + 1, state: "completed", labels: ["completed"] }));
    const api = fakeApi({ listIssues: vi.fn(async () => many) });
    const r = await closeTerminalTasks(api, "o/r", true);
    expect(api.closeIssue).toHaveBeenCalledTimes(TERMINAL_CLOSE_PAGE);
    expect(r.remaining).toBe(3);
  });

  it("apply: one failed close is reported and the rest still run", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => board),
      closeIssue: vi.fn(async (_r: string, n: number) => { if (n === 2) throw new Error("github 502"); }),
    });
    const r = await closeTerminalTasks(api, "o/r", true);
    expect(r.results.map((x) => [x.number, x.outcome])).toEqual([[1, "closed"], [2, "error"], [3, "closed"]]);
    expect(r.results[1].error).toContain("github 502");
  });
});

// Issue #54: a merge auto-completes a task; follow-up typed into the lead is
// invisible to the board, so the studio holds no open task and gets reaped
// mid-work. `continues` files the follow-up as a real task, to the SAME
// studio, read from the finished one rather than retyped.
describe("createTask — continues (issue #54)", () => {
  const FINISHED = task({ number: 7, state: "completed", labels: ["completed", "studio:demo--web-studio"],
    assignee: "demo--web-studio", open: false });

  it("no --studio: assigned to the continued task's studio, lineage in the body", async () => {
    const createIssue = vi.fn(async () => task({ number: 8 }));
    const api = fakeApi({ getIssue: vi.fn(async () => FINISHED), createIssue });
    const res = await createTask(api, "o/r", { ...brief, continues: 7 });
    expect(res.ok).toBe(true);
    expect(api.getIssue).toHaveBeenCalledWith("o/r", 7);
    const input = (createIssue.mock.calls[0] as unknown[])[1] as { labels: string[]; body: string };
    expect(input.labels).toContain("studio:demo--web-studio");
    expect(input.body).toContain("Continues #7.");
  });

  it("explicit --studio wins; lineage kept", async () => {
    const createIssue = vi.fn(async () => task({ number: 8 }));
    const api = fakeApi({ getIssue: vi.fn(async () => FINISHED), createIssue });
    await createTask(api, "o/r", { ...brief, continues: 7, assignee: "demo--release-studio" });
    const input = (createIssue.mock.calls[0] as unknown[])[1] as { labels: string[]; body: string };
    expect(input.labels).toContain("studio:demo--release-studio");
    expect(input.labels).not.toContain("studio:demo--web-studio");
    expect(input.body).toContain("Continues #7.");
  });

  it("continued task has no studio and none given: 400, nothing filed", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 7, assignee: null })) });
    const res = await createTask(api, "o/r", { ...brief, continues: 7 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.message).toContain("#7");
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("continued task does not exist: 404, nothing filed", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => { throw new GitHubError(404, "Not Found"); }) });
    const res = await createTask(api, "o/r", { ...brief, continues: 99 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("continues must be a positive integer", async () => {
    for (const bad of [0, -1, 1.5, "7"]) {
      const api = fakeApi();
      const res = await createTask(api, "o/r", { ...brief, continues: bad });
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (!res.ok) expect(res.status).toBe(400);
      expect(api.createIssue).not.toHaveBeenCalled();
    }
  });
});

// Issue #82: two 500s mid-transition left an issue with ZERO state labels.
// The CAS then refused every repair, and destroy refused to free the studio.
describe("transitionTask — a failed label add never strands zero labels (issue #82)", () => {
  it("the add is retried once: a transient failure still lands the new state", async () => {
    const addLabels = vi.fn().mockRejectedValueOnce(new Error("GitHub 500")).mockResolvedValueOnce(undefined);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })), addLabels });
    const res = await transitionTask(api, "o/r", 12, { from: "working", to: "input_required" });
    expect(res.ok).toBe(true);
    expect(addLabels).toHaveBeenCalledTimes(2);
    expect(addLabels).toHaveBeenLastCalledWith("o/r", 12, ["input_required"]);
  });

  it("the add fails twice: the old label is put back, and the failure still surfaces", async () => {
    const addLabels = vi.fn(async (_r: string, _n: number, labels: string[]) => {
      if (labels[0] === "input_required") throw new Error("GitHub 500");
    });
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })), addLabels });
    await expect(transitionTask(api, "o/r", 12, { from: "working", to: "input_required" })).rejects.toThrow("GitHub 500");
    expect(addLabels).toHaveBeenLastCalledWith("o/r", 12, ["working"]);
  });
});

// Issue #86 item 3: a GitHub 500 on the label REMOVE left the task open;
// destroy then refused. The remove gets the same one retry the add has.
describe("transitionTask — a failed label remove is retried once (issue #86)", () => {
  it("a transient 500 on the remove: retried, the transition lands", async () => {
    const removeLabel = vi.fn().mockRejectedValueOnce(new GitHubError(500, "GitHub 500")).mockResolvedValueOnce(undefined);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })), removeLabel });
    const res = await transitionTask(api, "o/r", 12, { from: "working", to: "completed" });
    expect(res.ok).toBe(true);
    expect(removeLabel).toHaveBeenCalledTimes(2);
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 12, ["completed"]);
  });

  it("the retry answers 404 (the first remove landed despite its 500): removed, the transition lands", async () => {
    const removeLabel = vi.fn()
      .mockRejectedValueOnce(new GitHubError(500, "GitHub 500"))
      .mockRejectedValueOnce(new GitHubError(404, "Label does not exist"));
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })), removeLabel });
    const res = await transitionTask(api, "o/r", 12, { from: "working", to: "completed" });
    expect(res.ok).toBe(true);
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 12, ["completed"]);
  });

  it("the remove fails twice: the failure surfaces, nothing is added", async () => {
    const removeLabel = vi.fn(async () => { throw new GitHubError(500, "GitHub 500"); });
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })), removeLabel });
    await expect(transitionTask(api, "o/r", 12, { from: "working", to: "completed" })).rejects.toThrow("GitHub 500");
    expect(removeLabel).toHaveBeenCalledTimes(2);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("a first-try 404 is not swallowed: the label was never there", async () => {
    const removeLabel = vi.fn(async () => { throw new GitHubError(404, "Label does not exist"); });
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })), removeLabel });
    await expect(transitionTask(api, "o/r", 12, { from: "working", to: "completed" })).rejects.toThrow("Label does not exist");
    expect(api.addLabels).not.toHaveBeenCalled();
  });
});

describe("transitionTask — from \"none\" repairs a zero-label task (issue #82)", () => {
  it("zero state labels: writes the target, logs the repair, removes nothing", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: null, labels: ["studio:demo--web-studio"] })) });
    const res = await transitionTask(api, "o/r", 12, { from: "none", to: "working" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.state).toBe("working");
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 12, ["working"]);
    expect(vi.mocked(api.createComment).mock.calls[0][2]).toContain("repaired");
  });

  it("a repair into a terminal state closes the issue too (#55)", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: null, labels: [] })) });
    const res = await transitionTask(api, "o/r", 12, { from: "none", to: "completed" });
    expect(res.ok).toBe(true);
    expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12, "completed");
  });

  for (const labels of [["working"], ["working", "completed"]]) {
    it(`refused (409) when the issue carries ${labels.length} state label(s) — repair is for zero only`, async () => {
      const api = fakeApi({ getIssue: vi.fn(async () => task({ state: null, labels })) });
      const res = await transitionTask(api, "o/r", 12, { from: "none", to: "working" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(409);
      expect(api.addLabels).not.toHaveBeenCalled();
    });
  }
});

// Issue #86 item 4: leads never flip their own task to working, so the
// board read `submitted` while a lead visibly worked. The DO calls this on
// the lead's first observed working turn.
describe("autoStartSubmittedTasks (issue #86)", () => {
  const STUDIO = "demo--web-studio";
  const mine = (n: number, over: Partial<BoardTask> = {}) =>
    task({ number: n, labels: ["submitted", studioLabel(STUDIO)], assignee: STUDIO, ...over });

  it("asks GitHub for this studio's submitted tasks only, and moves each open one to working", async () => {
    const issues = new Map([[12, mine(12)], [13, mine(13)]]);
    const listIssues = vi.fn(async () => [...issues.values()]);
    const getIssue = vi.fn(async (_r: string, n: number) => issues.get(n)!);
    const api = fakeApi({ listIssues, getIssue });
    const res = await autoStartSubmittedTasks(api, "o/r", STUDIO);
    expect(listIssues).toHaveBeenCalledWith("o/r", { labels: ["submitted", studioLabel(STUDIO)] });
    expect(res).toEqual({ moved: [12, 13], errors: [] });
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 12, "submitted");
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 12, ["working"]);
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 13, ["working"]);
  });

  it("a closed submitted task is left alone", async () => {
    const closed = mine(14, { open: false });
    const api = fakeApi({ listIssues: vi.fn(async () => [closed]), getIssue: vi.fn(async () => closed) });
    expect(await autoStartSubmittedTasks(api, "o/r", STUDIO)).toEqual({ moved: [], errors: [] });
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("a task moved since the listing (CAS refusal) is an error line, never a throw; the rest still move", async () => {
    const moved = mine(12, { state: "working", labels: ["working", studioLabel(STUDIO)] });
    const issues = new Map([[12, moved], [13, mine(13)]]);
    const api = fakeApi({
      listIssues: vi.fn(async () => [mine(12), mine(13)]),
      getIssue: vi.fn(async (_r: string, n: number) => issues.get(n)!),
    });
    const res = await autoStartSubmittedTasks(api, "o/r", STUDIO);
    expect(res.moved).toEqual([13]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("#12");
  });

  it("a GitHub failure is an error line, never a throw", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => { throw new GitHubError(502, "down"); }) });
    const res = await autoStartSubmittedTasks(api, "o/r", STUDIO);
    expect(res.moved).toEqual([]);
    expect(res.errors[0]).toContain("down");
  });
});
