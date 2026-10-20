import { describe, it, expect, vi } from "vitest";
import {
  createTask, transitionTask, commentEnvelope, listTasks, showTask, resolveBoardRepo,
  requireAssignedTask, showStudioTask, commentStudioEnvelope, resolveBriefPrompt, resolveLatestAssignedBrief,
  assignTask, transitionStudioTask, openAssignedTasks, revokeGlmLeadOnSecurityLabel,
  closeTerminalTasks, TERMINAL_CLOSE_PAGE, LEAD_TASK_STATES,
  openTasksNeedingRebrief, REBRIEF_TASK_STATES,
  type BoardApi,
} from "../src/board/board";
import { parseEnvelopeComment, renderEnvelopeComment, parseEnvelope } from "../src/board/envelope";
import { defaultBrief as brief, fakeApi as boardFakeApi, task as boardTask } from "./helpers/board-api";
import {
  studioLabel, taskAssignees, TASK_STATES, TERMINAL_TASK_STATES, LIVE_TASK_STATES, type BoardTask,
} from "../src/board/types";
import type { RepoReach } from "../src/github/reach";

const MSG_ID = "0d9f1c2e-0000-4000-8000-000000000001";

// Old local defaults preserved as explicit overrides: title "Build the task
// board", milestone "Sprint 1", and the Sprint-1 listMilestones seed the
// createTask/listTasks milestone-resolution tests resolve against.
const task = (overrides: Partial<BoardTask> = {}) =>
  boardTask({ title: "Build the task board", milestone: "Sprint 1", ...overrides });
const fakeApi = (overrides: Partial<BoardApi> = {}) => boardFakeApi({
  listMilestones: vi.fn(async () => [{ number: 3, title: "Sprint 1", description: "", state: "open" }]),
  ...overrides,
}, () => task());

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

  it("passes open through to the api query (issue #1121)", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => []) });
    const res = await listTasks(api, "o/r", { open: true });
    expect(res.ok).toBe(true);
    expect(api.listIssues).toHaveBeenCalledWith("o/r", { open: true });
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

  it("the BoardApi port has no delete verb — history cannot be removed by this path", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["working", studioLabel(WEB)], state: "working", assignee: WEB })),
    });
    await assignTask(api, "o/r", 42, { assignee: RELEASE }, reassign);
    // The port itself carries no delete verb — the directive below IS the
    // assertion, same mechanics as studio.exports-pin-608.test.ts: TS2339
    // fires today because BoardApi has no deleteComment; add one and the
    // directive goes unused (TS2578), failing `bun run check`'s root
    // `tsc --noEmit` pass — the tsconfig project that owns this file
    // (root tsconfig.json includes test/**; test/tsconfig.json's own
    // project covers only test/bun/** plus two bun:test files, measured:
    // it stayed exit 0 under the mutation). Compile-time pin — vitest
    // never typechecks, so the runtime half below is what vitest proves:
    // reassignment comments the lineage exactly once and deletes nothing.
    // @ts-expect-error TS2339 — BoardApi has no deleteComment verb
    void api.deleteComment;
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

  // Issue #249 (maestro spec point 5): the assign/reassign half of the same
  // refusal createTask enforces at creation — a security-labelled task
  // already on the board must not be handed (or re-handed) to a glm-lead
  // studio either.
  describe("security refuses a glm-lead studio (#249)", () => {
    const securityTask = () => task({ number: 42, labels: ["submitted", "security"], state: "submitted", assignee: null });

    it("refuses adoption, writes NOTHING, when the target studio resolves to leadType glm", async () => {
      const api = fakeApi({ getIssue: vi.fn(async () => securityTask()) });
      const getLeadType = vi.fn(async () => "glm" as const);
      const res = await assignTask(api, "o/r", 42, { assignee: WEB }, { ...adopt, getLeadType });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(400);
      expect(res.message).toContain("security");
      expect(res.message).toContain(WEB);
      expect(api.addLabels).not.toHaveBeenCalled();
      expect(api.removeLabel).not.toHaveBeenCalled();
      expect(api.createComment).not.toHaveBeenCalled();
    });

    it("refuses REASSIGNMENT too, same task, same target studio", async () => {
      const api = fakeApi({
        getIssue: vi.fn(async () => task({
          number: 42, labels: ["working", studioLabel(RELEASE), "security"], state: "working", assignee: RELEASE,
        })),
      });
      const getLeadType = vi.fn(async () => "glm" as const);
      const res = await assignTask(api, "o/r", 42, { assignee: WEB }, { ...reassign, getLeadType });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(400);
      expect(api.addLabels).not.toHaveBeenCalled();
    });

    it("the IDENTICAL security task against a claude-lead studio is NOT refused", async () => {
      const api = fakeApi({ getIssue: vi.fn(async () => securityTask()) });
      const getLeadType = vi.fn(async () => "claude" as const);
      const res = await assignTask(api, "o/r", 42, { assignee: WEB }, { ...adopt, getLeadType });

      expect(res.ok).toBe(true);
      expect(api.addLabels).toHaveBeenCalledTimes(1);
    });

    it("an unlabelled task against a glm-lead studio is NOT refused — only security triggers this", async () => {
      const api = fakeApi({ getIssue: vi.fn(async () => bare()) });
      const getLeadType = vi.fn(async () => "glm" as const);
      const res = await assignTask(api, "o/r", 42, { assignee: WEB }, { ...adopt, getLeadType });

      expect(res.ok).toBe(true);
      expect(api.addLabels).toHaveBeenCalledTimes(1);
    });

    it("no getLeadType port wired at all: skips the check entirely (every caller that predates #249)", async () => {
      const api = fakeApi({ getIssue: vi.fn(async () => securityTask()) });
      const res = await assignTask(api, "o/r", 42, { assignee: WEB }, adopt);

      expect(res.ok).toBe(true);
      expect(api.addLabels).toHaveBeenCalledTimes(1);
    });
  });
});

// Maestro review round 1 MINOR (#249, #255): createTask/assignTask both
// refuse a security-labelled task going ONTO a glm-lead studio, but neither
// watches for the label arriving AFTER the fact -- a task already
// live-assigned to a glm-lead studio, relabelled `security` later (GitHub
// UI, a hand-run `gh issue edit --add-label security`, anything other than
// this Worker's own createTask/assignTask write), stayed silently owned by
// that studio with nothing to catch it. revokeGlmLeadOnSecurityLabel is the
// fix: called in reaction to that exact event (webhook.ts's own issues-event
// handler wires it, same `labeled` trigger junior/authz.ts's
// revokeJuniorOnIssueEvent already answers for issue #35), it unassigns any
// CURRENT owner whose leadType resolves to "glm" -- same "revoke only, never
// grant" posture junior/authz.ts's own header argues for its reopened-task
// case: once a glm-lead studio's claim on a security task is gone here,
// nothing (a later unlabel, a relabel) brings it back on its own; a human
// has to reassign it, through assignTask, which already refuses to hand it
// BACK to a glm-lead studio (the describe block just above).
describe("revokeGlmLeadOnSecurityLabel — a security label added AFTER assignment unassigns a glm-lead owner (#249 maestro r1)", () => {
  const WEB = "websites--web-studio";
  const CLAUDE_STUDIO = "websites--claude-studio";

  it("a task already working, owned by a glm-lead studio, now carries `security` -> unassigned and reset to backlog", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({
        number: 42, labels: ["working", studioLabel(WEB), "security"], state: "working", assignee: WEB,
      })),
    });
    const getLeadType = vi.fn(async () => "glm" as const);
    const res = await revokeGlmLeadOnSecurityLabel(api, "o/r", 42, getLeadType);

    expect(res.revoked).toEqual([WEB]);
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, studioLabel(WEB));
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, "working");
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 42, ["submitted"]);
    expect(api.createComment).toHaveBeenCalledTimes(1);
    const [, , comment] = vi.mocked(api.createComment).mock.calls[0];
    expect(comment).toContain(WEB);
    expect(comment).toContain("security");
  });

  it("already in backlog (submitted) when the label lands -> owner removed, state left alone (no duplicate submitted write)", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({
        number: 42, labels: ["submitted", studioLabel(WEB), "security"], state: "submitted", assignee: WEB,
      })),
    });
    const getLeadType = vi.fn(async () => "glm" as const);
    const res = await revokeGlmLeadOnSecurityLabel(api, "o/r", 42, getLeadType);

    expect(res.revoked).toEqual([WEB]);
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, studioLabel(WEB));
    expect(api.removeLabel).not.toHaveBeenCalledWith("o/r", 42, "submitted");
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("the owner is a claude-lead studio -> nothing written, nothing revoked (identical label, wrong lead type)", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({
        number: 42, labels: ["working", studioLabel(CLAUDE_STUDIO), "security"], state: "working", assignee: CLAUDE_STUDIO,
      })),
    });
    const getLeadType = vi.fn(async () => "claude" as const);
    const res = await revokeGlmLeadOnSecurityLabel(api, "o/r", 42, getLeadType);

    expect(res.revoked).toEqual([]);
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("the task does not carry `security` at all -> nothing written (not every relabel is this one)", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({
        number: 42, labels: ["working", studioLabel(WEB)], state: "working", assignee: WEB,
      })),
    });
    const getLeadType = vi.fn(async () => "glm" as const);
    const res = await revokeGlmLeadOnSecurityLabel(api, "o/r", 42, getLeadType);

    expect(res.revoked).toEqual([]);
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(getLeadType).not.toHaveBeenCalled();
  });

  it("unassigned backlog task, somehow already carrying `security` -> no owner to revoke, nothing written", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 42, labels: ["submitted", "security"], state: "submitted", assignee: null })),
    });
    const getLeadType = vi.fn(async () => "glm" as const);
    const res = await revokeGlmLeadOnSecurityLabel(api, "o/r", 42, getLeadType);

    expect(res.revoked).toEqual([]);
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("end to end: revoke, then the IDENTICAL re-adoption that would have succeeded before the label landed now refuses", async () => {
    // Before: a plain working task, owned by WEB, no security label --
    // assignTask would happily re-adopt/nudge it (round-1's own tests prove
    // that path). Then the label lands; revoke runs. The task this function
    // hands back is the SAME shape assignTask's own getIssue would now see.
    const afterLabel = task({ number: 42, labels: ["submitted", "security"], state: "submitted", assignee: null });
    const api = fakeApi({
      getIssue: vi.fn(async () => task({
        number: 42, labels: ["working", studioLabel(WEB), "security"], state: "working", assignee: WEB,
      })),
    });
    const getLeadType = vi.fn(async () => "glm" as const);
    const revoked = await revokeGlmLeadOnSecurityLabel(api, "o/r", 42, getLeadType);
    expect(revoked.revoked).toEqual([WEB]);

    // The next call against this task's own assignment: re-adopting WEB.
    // Before the label landed this is exactly the "nudge the studio that
    // already owns it" shape (board #158) and would have succeeded; now the
    // task's own fresh labels (read inside assignTask, not trusted from the
    // caller) carry `security` against a glm-lead target, so it refuses.
    const apiAfter = fakeApi({ getIssue: vi.fn(async () => afterLabel) });
    const res = await assignTask(apiAfter, "o/r", 42, { assignee: WEB }, { mode: "adopt" as const, getLeadType });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(apiAfter.addLabels).not.toHaveBeenCalled();
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

  // Board issue #1071, item 3: a bookkeeping reassign of a task whose work is
  // already past the lead's hands must wake nobody (5 bogus wakes measured).
  it.each(["awaiting_merge", "completed", "canceled"] as const)(
    "does NOT fire when reassigning a %s task — a bookkeeping move wakes nobody", async (state) => {
      const api = fakeApi({
        getIssue: vi.fn(async () => task({ number: 42, labels: [state, studioLabel("websites--release-studio")] })),
      });
      const onAssigned = vi.fn(async (_studioId: string, _task: BoardTask) => {});
      const res = await assignTask(api, "o/r", 42, { assignee: WEB }, { mode: "reassign", at: AT, onAssigned });
      expect(res.ok).toBe(true);
      expect(onAssigned).not.toHaveBeenCalled();
    },
  );

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

// Board issue #110: `awaiting_merge` — self-reported by a lead, "I'm done,
// PR's up", NOT terminal (the issue stays open until merge) and NOT live
// (a studio may not be briefed on it).
describe("TASK_STATES vocabulary (board issue #110)", () => {
  it("includes awaiting_merge, after input_required and before the terminal states", () => {
    expect(TASK_STATES).toContain("awaiting_merge");
    expect(TASK_STATES.indexOf("awaiting_merge")).toBe(TASK_STATES.indexOf("input_required") + 1);
  });

  it("is NOT terminal — the issue must stay open until merge", () => {
    expect(TERMINAL_TASK_STATES).not.toContain("awaiting_merge");
  });

  it("is NOT live — the lead already finished its part, a studio is not briefed on it", () => {
    expect(LIVE_TASK_STATES).not.toContain("awaiting_merge");
  });

  it("LEAD_TASK_STATES includes it — the lead self-reports it, same as working/input_required/failed", () => {
    expect(LEAD_TASK_STATES).toContain("awaiting_merge");
  });
});

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

  it("moves it to input_required, awaiting_merge and to failed", async () => {
    for (const to of ["input_required", "awaiting_merge", "failed"]) {
      const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
      const res = await transitionStudioTask(api, "o/r", 42, { to }, MINE);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.state).toBe(to);
    }
  });

  // Board issue #110: the lead reports "I'm done, PR's up, waiting on merge"
  // — same self-reported-claim category as working/input_required/failed,
  // never a verified fact. `completed` stays the verifier's exclusive call.
  it("moves working -> awaiting_merge", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => mine({ labels: ["working", studioLabel(MINE)], state: "working" })),
    });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "awaiting_merge" }, MINE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.state).toBe("awaiting_merge");
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 42, "working");
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 42, ["awaiting_merge"]);
  });

  it("REFUSES completed — that is the verifier's verdict, never the worker's — and writes no label", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
    const res = await transitionStudioTask(api, "o/r", 42, { to: "completed" }, MINE);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.message).toContain("completed");
    expect(res.message).toContain("working, input_required, awaiting_merge, failed");
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("refuses completed BEFORE reading the issue — the attempt costs not one GitHub call", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => mine()) });
    await transitionStudioTask(api, "o/r", 42, { to: "completed" }, MINE);
    expect(api.getIssue).not.toHaveBeenCalled();
  });

  it("refuses canceled and submitted too — the allowlist is exactly four states", async () => {
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

  // Board issue #1071, item 2 (existing issue #299): `destroy --park` must not
  // be blocked by a studio waiting on an answer or on a merge — a parked lane
  // exists precisely to keep its history alive while it waits. Plain destroy
  // keeps the guard above unchanged.
  describe("parking (issue #1071 item 2)", () => {
    const PARK = { parking: true };

    it("--park is NOT blocked by an input_required task — the lead is waiting on an answer", async () => {
      const api = fakeApi({ listIssues: vi.fn(async () => [mine(66, "input_required")]) });
      expect(await openAssignedTasks(api, "o/r", MINE, PARK)).toEqual({ ok: true, value: [] });
    });

    it("--park is NOT blocked by an awaiting_merge task either", async () => {
      const api = fakeApi({ listIssues: vi.fn(async () => [mine(7, "awaiting_merge")]) });
      expect(await openAssignedTasks(api, "o/r", MINE, PARK)).toEqual({ ok: true, value: [] });
    });

    it("plain destroy (no park) is STILL blocked by input_required — today's guard is unchanged", async () => {
      const api = fakeApi({ listIssues: vi.fn(async () => [mine(66, "input_required")]) });
      expect(await openAssignedTasks(api, "o/r", MINE)).toEqual({ ok: true, value: [{ number: 66, drifted: false }] });
    });

    it("--park still blocks on submitted and working — only the two parked states are waived", async () => {
      const api = fakeApi({
        listIssues: vi.fn(async () => [mine(90, "working"), mine(85, "submitted"), mine(66, "input_required")]),
      });
      expect(await openAssignedTasks(api, "o/r", MINE, PARK)).toEqual({ ok: true, value: [
        { number: 90, drifted: false }, { number: 85, drifted: false },
      ] });
    });

    it("--park still fails closed on a drifted task — a parked state is never guessed from two labels", async () => {
      const api = fakeApi({ listIssues: vi.fn(async () => [mine(7, null)]) });
      expect(await openAssignedTasks(api, "o/r", MINE, PARK)).toEqual({ ok: true, value: [{ number: 7, drifted: true }] });
    });
  });

  // Board issue #110: awaiting_merge is neither terminal nor live — the
  // three-way split. `destroy` must NOT be refused for it, unlike the still-
  // live states below (regression coverage for the existing behaviour).
  it("an awaiting_merge task does NOT block — the lead's part is done", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => [mine(7, "awaiting_merge")]) });
    expect(await openAssignedTasks(api, "o/r", MINE)).toEqual({ ok: true, value: [] });
  });

  it("submitted/working/input_required still block — awaiting_merge is the only new exclusion", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [mine(1, "submitted"), mine(2, "working"), mine(3, "input_required")]),
    });
    expect(await openAssignedTasks(api, "o/r", MINE)).toEqual({ ok: true, value: [
      { number: 1, drifted: false }, { number: 2, drifted: false }, { number: 3, drifted: false },
    ] });
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

// Issue #137: the bring-up re-delivery wake's own board read — widened from
// resolveLatestAssignedBrief's single "newest" task to every open task still
// genuinely in flight, so a container replacement leaves no assigned task
// un-rebriefed.
describe("openTasksNeedingRebrief — bring-up re-delivery's board read (issue #137)", () => {
  const MINE = "fleetflare--web-studio";
  const mine = (number: number, state: BoardTask["state"], title = "A task", updatedAt = "2026-09-24T00:00:00Z") =>
    task({ number, state, title, updatedAt, labels: [...(state ? [state] : []), studioLabel(MINE)], assignee: MINE });

  it("no open tasks assigned to this studio: empty, never throws", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => []) });
    expect(await openTasksNeedingRebrief(api, "o/r", MINE)).toEqual([]);
  });

  it("listIssues throwing resolves to [] (fail-open, board hiccup must never block bring-up)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = fakeApi({ listIssues: vi.fn(async () => { throw new Error("upstream unreachable"); }) });
    await expect(openTasksNeedingRebrief(api, "o/r", MINE)).resolves.toEqual([]);
    vi.restoreAllMocks();
  });

  it("submitted and working qualify — input_required, awaiting_merge and terminal states get no bring-up wake (issue #1071 item 3)", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        mine(1, "submitted"), mine(2, "working"), mine(3, "input_required"),
        mine(4, "awaiting_merge"), mine(5, "completed"), mine(6, "failed"), mine(7, "canceled"),
      ]),
    });
    const result = await openTasksNeedingRebrief(api, "o/r", MINE);
    expect(result.map((t) => t.taskNumber).sort()).toEqual([1, 2]);
  });

  // Reviewer fix-first on #143/#137: `wakeOnAssign` (assign-wake.ts) refuses
  // to type into a STOPPED studio and says so explicitly — "Provision it and
  // the task is delivered on bring-up" — a promise only THIS function keeps.
  // A task assigned while its studio was stopped sits in `submitted` with no
  // wake ever sent; if `openTasksNeedingRebrief` dropped `submitted`, that
  // promise would be a lie and the lead would never see the task at all.
  // Exercises the REAL board-query filter (not a hand-built list handed
  // straight to the delivery loop, which would hide this bug entirely — see
  // studio.wake-gate.test.ts / studio.destroy-race.test.ts, neither of which
  // goes through this function).
  it("a submitted task (assigned while the studio was stopped, never woken) is returned too", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => [mine(9, "submitted", "Stopped at assign time")]) });
    const result = await openTasksNeedingRebrief(api, "o/r", MINE);
    expect(result).toEqual([{ taskNumber: 9, title: "Stopped at assign time" }]);
  });

  it("a closed issue in a live state does not count — must be open too", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [{ ...mine(8, "working"), open: false }]),
    });
    expect(await openTasksNeedingRebrief(api, "o/r", MINE)).toEqual([]);
  });

  it("multiple open live tasks: every one is returned, newest-updated first", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        mine(10, "working", "Older", "2026-09-20T00:00:00Z"),
        mine(11, "submitted", "Newest", "2026-09-29T00:00:00Z"),
        mine(12, "working", "Middle", "2026-09-24T00:00:00Z"),
      ]),
    });
    const result = await openTasksNeedingRebrief(api, "o/r", MINE);
    expect(result).toEqual([
      { taskNumber: 11, title: "Newest" },
      { taskNumber: 12, title: "Middle" },
      { taskNumber: 10, title: "Older" },
    ]);
  });

  // Board issue #1071, item 3: provision/recycle wake a lead only for work it
  // is actively holding. A task parked at input_required, awaiting_merge,
  // completed or canceled gets NO bring-up wake — one maestro hand-completed
  // eight stale tasks and every bring-up re-woke them.
  it("REBRIEF_TASK_STATES is exactly submitted + working (issue #1071 item 3)", () => {
    expect(REBRIEF_TASK_STATES).toEqual(["submitted", "working"]);
  });

  it("a bring-up re-brief skips input_required, awaiting_merge, completed and canceled — no stale wakes", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        mine(1, "input_required"), mine(2, "awaiting_merge"), mine(3, "completed"), mine(4, "canceled"),
      ]),
    });
    expect(await openTasksNeedingRebrief(api, "o/r", MINE)).toEqual([]);
  });

  it("a bring-up re-brief still delivers a submitted and a working task", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [mine(5, "working"), mine(6, "submitted"), mine(7, "awaiting_merge")]),
    });
    const got = (await openTasksNeedingRebrief(api, "o/r", MINE)).map((t) => t.taskNumber).sort();
    expect(got).toEqual([5, 6]);
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
