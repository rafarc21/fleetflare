import { describe, it, expect, vi } from "vitest";
import { createTask, transitionTask, autoStartSubmittedTasks, findLiveAssignedTask, type BoardApi } from "../src/board/board";
import { fakeApi as boardFakeApi, task as boardTask } from "./helpers/board-api";
import { studioLabel, type BoardTask } from "../src/board/types";
import { GitHubError } from "../src/board/api";

// Old local defaults preserved as explicit overrides: title "Build the task
// board", milestone "Sprint 1", and the Sprint-1 listMilestones seed the
// createTask/listTasks milestone-resolution tests resolve against.
const task = (overrides: Partial<BoardTask> = {}) =>
  boardTask({ title: "Build the task board", milestone: "Sprint 1", ...overrides });
const fakeApi = (overrides: Partial<BoardApi> = {}) => boardFakeApi({
  listMilestones: vi.fn(async () => [{ number: 3, title: "Sprint 1" }]),
  ...overrides,
}, () => task());

const brief = {
  title: "Build the task board",
  objective: "Worker-side board module.",
  outputFormat: "A PR.",
  // Issue #112: no "/" here on purpose — this text is reused by nearly
  // every createTask test in this file, and extractPaths (board issue #112
  // / #70 ask 8) would otherwise read "open/close" as a path claim and
  // trigger the new pathClaimWarnings network calls these tests never
  // intend to exercise. See the dedicated "createTask — path overlap
  // warning" describe block below for the tests that DO exercise it.
  boundaries: "No sprint open or close.",
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

  // Board issue #112 / #70 ask 8: a lightweight WARN-not-refuse check —
  // never refuses creation, only attaches `pathWarnings` naming the
  // overlapping PR(s)/task(s).
  describe("path overlap warning (#112)", () => {
    const overlapBrief = {
      title: "t", objective: "Touches apps/fleet/src/board/board.ts directly.",
      outputFormat: "f", boundaries: "b",
    };

    it("warns when the brief's path also appears in an open PR's changed files", async () => {
      const api = fakeApi({
        listOpenPullFiles: vi.fn(async () => [
          { number: 245, files: ["apps/fleet/src/board/board.ts"] },
        ]),
      });
      const res = await createTask(api, "o/r", overlapBrief);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.pathWarnings).toBeDefined();
      expect(res.value.pathWarnings!.length).toBeGreaterThan(0);
      expect(res.value.pathWarnings!.join("\n")).toContain("#245");
    });

    it("warns when the brief's path also appears in another OPEN task's body, never a terminal one", async () => {
      const other = task({
        number: 201, state: "working", labels: ["working"],
        body: "## Objective\n\nAlso touches apps/fleet/src/board/board.ts.\n",
      });
      const dead = task({
        number: 202, state: "failed", open: false, labels: ["failed"],
        body: "## Objective\n\nAlso touches apps/fleet/src/board/board.ts.\n",
      });
      const api = fakeApi({ listIssues: vi.fn(async () => [other, dead]) });
      const res = await createTask(api, "o/r", overlapBrief);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.pathWarnings).toBeDefined();
      const joined = res.value.pathWarnings!.join("\n");
      expect(joined).toContain("#201");
      expect(joined).not.toContain("#202");
    });

    it("no path-looking text in the brief: pathWarnings is absent and neither extra read fires", async () => {
      const api = fakeApi();
      const res = await createTask(api, "o/r", brief);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.pathWarnings).toBeUndefined();
      expect(api.listOpenPullFiles).not.toHaveBeenCalled();
      // The base fakeApi's own listIssues call count stays at 0: nothing
      // beyond the idempotency-key path (absent here) reads it either.
      expect(api.listIssues).not.toHaveBeenCalled();
    });

    it("fails open: listOpenPullFiles throwing still lets the task succeed, with no pathWarnings", async () => {
      const api = fakeApi({
        listOpenPullFiles: vi.fn(async () => { throw new Error("github down"); }),
      });
      const res = await createTask(api, "o/r", overlapBrief);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.pathWarnings).toBeUndefined();
    });
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

  // Issue #249 (maestro spec point 5): same single-create-call shape as
  // junior, for the SECURITY_LABEL half.
  it("createTask writes the security label in the same single create call", async () => {
    const api = fakeApi();
    await createTask(api, "acme-org/websites", {
      title: "t", objective: "o", outputFormat: "f", boundaries: "b",
      assignee: "websites--web-studio", security: true,
    });
    expect(vi.mocked(api.createIssue).mock.calls.length).toBe(1);
    expect(vi.mocked(api.createIssue).mock.calls[0][1].labels)
      .toEqual(["submitted", "studio:websites--web-studio", "security"]);
  });

  describe("createTask — security refuses a glm-lead studio (#249)", () => {
    const securityBrief = {
      title: "t", objective: "o", outputFormat: "f", boundaries: "b",
      assignee: "websites--web-studio", security: true,
    };

    it("refuses, writes NOTHING, when the assignee studio resolves to leadType glm", async () => {
      const api = fakeApi();
      const getLeadType = vi.fn(async () => "glm" as const);
      const res = await createTask(api, "acme-org/websites", securityBrief, undefined, getLeadType);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(400);
      expect(res.message).toContain("security");
      expect(res.message).toContain("websites--web-studio");
      expect(api.createIssue).not.toHaveBeenCalled();
    });

    it("the IDENTICAL security task against a claude-lead studio is NOT refused", async () => {
      const api = fakeApi();
      const getLeadType = vi.fn(async () => "claude" as const);
      const res = await createTask(api, "acme-org/websites", securityBrief, undefined, getLeadType);
      expect(res.ok).toBe(true);
      expect(api.createIssue).toHaveBeenCalledTimes(1);
    });

    it("an unlabelled task against a glm-lead studio is NOT refused — only security triggers this", async () => {
      const api = fakeApi();
      const getLeadType = vi.fn(async () => "glm" as const);
      const res = await createTask(
        api, "acme-org/websites",
        { title: "t", objective: "o", outputFormat: "f", boundaries: "b", assignee: "websites--web-studio" },
        undefined, getLeadType,
      );
      expect(res.ok).toBe(true);
      expect(api.createIssue).toHaveBeenCalledTimes(1);
    });

    it("no getLeadType port wired at all: skips the check entirely (every caller that predates #249)", async () => {
      const api = fakeApi();
      const res = await createTask(api, "acme-org/websites", securityBrief);
      expect(res.ok).toBe(true);
      expect(api.createIssue).toHaveBeenCalledTimes(1);
    });

    it("no assignee at all: never calls getLeadType (nothing to resolve)", async () => {
      const api = fakeApi();
      const getLeadType = vi.fn(async () => "glm" as const);
      const res = await createTask(
        api, "acme-org/websites",
        { title: "t", objective: "o", outputFormat: "f", boundaries: "b", security: true },
        undefined, getLeadType,
      );
      expect(res.ok).toBe(true);
      expect(getLeadType).not.toHaveBeenCalled();
    });
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

  // Issue #519 (sweep 13): the first addLabels attempt's catch used to fall
  // through to the retry with no trace, so a transient GitHub 500 looked
  // identical to a slow one in the tail. One console.warn now names the
  // failed attempt (task, repo, target state, error) before the retry fires
  // -- the swallow itself stays, the retry contract above is unchanged.
  it("the retried add logs one console.warn naming the failed attempt before the retry (#519)", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const addLabels = vi.fn().mockRejectedValueOnce(new Error("GitHub 500")).mockResolvedValueOnce(undefined);
      const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })), addLabels });
      const res = await transitionTask(api, "o/r", 12, { from: "working", to: "input_required" });
      expect(res.ok).toBe(true);
      expect(addLabels).toHaveBeenCalledTimes(2);
      const retryWarns = warns.mock.calls.filter((c) => c.join(" ").includes("retrying"));
      expect(retryWarns).toHaveLength(1);
      expect(retryWarns[0].join(" ")).toContain("#12");
      expect(retryWarns[0].join(" ")).toContain("input_required");
      expect(retryWarns[0].join(" ")).toContain("GitHub 500");
    } finally {
      warns.mockRestore();
    }
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
