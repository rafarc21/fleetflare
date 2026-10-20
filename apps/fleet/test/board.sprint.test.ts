import { describe, it, expect, vi } from "vitest";
import { openSprint, sprintSummaries, closeSprint } from "../src/board/sprint";
import { fakeApi as boardFakeApi, task as boardTask } from "./helpers/board-api";
import type { BoardApi } from "../src/board/board";
import type { BoardTask } from "../src/board/types";
import type { ListIssuesQuery } from "../src/board/api";

// Sprint policy (open/status/close) over a fake BoardApi. Every assertion is
// against the port's calls — the pure layer decides HTTP semantics here, and
// no test needs a live milestone or issue.

const task = (overrides: Partial<BoardTask> = {}) => boardTask(overrides);
const fakeApi = (overrides: Partial<BoardApi> = {}) => boardFakeApi(overrides, () => task());

describe("openSprint", () => {
  it("creates the milestone with a rendered Owner/Goal description", async () => {
    const api = fakeApi({
      createMilestone: vi.fn(async () => ({ number: 1, title: "Sprint 1" })),
    });
    const res = await openSprint(api, "o/r", { title: "  Sprint 1  ", owner: "x", goal: "y" });
    expect(res).toEqual({ ok: true, value: { number: 1, title: "Sprint 1" } });
    expect(api.createMilestone).toHaveBeenCalledWith("o/r", {
      title: "Sprint 1",
      description: "Owner: x\nGoal: y",
    });
  });

  it("refuses a duplicate title case-insensitively", async () => {
    const api = fakeApi({
      listMilestones: vi.fn(async () => [{ number: 7, title: "Sprint One", description: "", state: "open" }]),
    });
    const res = await openSprint(api, "o/r", { title: "sprint one", owner: "x", goal: "y" });
    expect(res).toEqual({ ok: false, status: 409, message: 'a sprint titled "sprint one" already exists' });
  });

  it("refuses a blank title, owner, and goal", async () => {
    const api = fakeApi();
    expect(await openSprint(api, "o/r", { title: "   ", owner: "x", goal: "y" }))
      .toEqual({ ok: false, status: 400, message: "sprint needs a title" });
    expect(await openSprint(api, "o/r", { title: "t", owner: "  ", goal: "y" }))
      .toEqual({ ok: false, status: 400, message: "sprint open needs --maestro <name>" });
    expect(await openSprint(api, "o/r", { title: "t", owner: "x", goal: "  " }))
      .toEqual({ ok: false, status: 400, message: 'sprint open needs --goal "<outcome>"' });
  });
});

describe("sprintSummaries", () => {
  const twoOpen = {
    listOpenMilestones: vi.fn(async () => [
      { number: 1, title: "Sprint A", description: "Owner: alice\nGoal: ship A" },
      { number: 2, title: "Sprint B", description: "Owner: bob\nGoal: ship B" },
    ]),
    listIssues: vi.fn(async (_repo: string, query: ListIssuesQuery) => {
      if (query.milestone === 1) {
        return [
          task({ number: 10, state: "completed", labels: ["completed"] }),
          task({ number: 11, state: "working", labels: ["working"] }),
          task({ number: 12, state: "canceled", labels: ["canceled"] }),
          task({ number: 13, state: null, labels: [] }),
        ];
      }
      if (query.milestone === 2) {
        return [task({ number: 20, state: "completed", labels: ["completed"] })];
      }
      return [];
    }),
  };

  it("computes completed/total per open milestone, canceled excluded", async () => {
    const api = fakeApi(twoOpen);
    const res = await sprintSummaries(api, "o/r", null);
    expect(res).toEqual({
      ok: true,
      value: [
        { title: "Sprint A", owner: "alice", goal: "ship A", completed: 1, total: 3 },
        { title: "Sprint B", owner: "bob", goal: "ship B", completed: 1, total: 1 },
      ],
    });
  });

  it("filters to one open milestone by title, case-insensitively", async () => {
    const api = fakeApi(twoOpen);
    const res = await sprintSummaries(api, "o/r", "sprint b");
    expect(res).toEqual({
      ok: true,
      value: [{ title: "Sprint B", owner: "bob", goal: "ship B", completed: 1, total: 1 }],
    });
  });

  it("404s on an unknown title", async () => {
    const api = fakeApi(twoOpen);
    const res = await sprintSummaries(api, "o/r", "Sprint C");
    expect(res).toEqual({ ok: false, status: 404, message: 'no open sprint titled "Sprint C"' });
  });
});

describe("closeSprint", () => {
  it("404s when the sprint milestone does not exist", async () => {
    const api = fakeApi();
    const res = await closeSprint(api, "o/r", "Sprint A");
    expect(res).toEqual({ ok: false, status: 404, message: 'no milestone titled "Sprint A"' });
  });

  it("refuses a sprint with a task still in flight", async () => {
    const api = fakeApi({
      listMilestones: vi.fn(async () => [{ number: 5, title: "Sprint A", description: "", state: "open" }]),
      listIssues: vi.fn(async () => [task({ number: 11, state: "working", labels: ["working"] })]),
    });
    const res = await closeSprint(api, "o/r", "Sprint A");
    expect(res).toEqual({
      ok: false, status: 409,
      message: 'sprint "Sprint A" has tasks still in flight: #11 working',
    });
    expect(api.closeMilestone).not.toHaveBeenCalled();
    expect(api.setIssueMilestone).not.toHaveBeenCalled();
  });

  it("refuses a sprint whose task links an open PR", async () => {
    const api = fakeApi({
      listMilestones: vi.fn(async () => [{ number: 5, title: "Sprint A", description: "", state: "open" }]),
      listIssues: vi.fn(async () => [task({ number: 10, title: "Fix #45", body: "", state: "submitted", labels: ["submitted"] })]),
      listOpenPullFiles: vi.fn(async () => [{ number: 45, files: [] }]),
    });
    const res = await closeSprint(api, "o/r", "Sprint A");
    expect(res).toEqual({
      ok: false, status: 409,
      message: 'sprint "Sprint A" has open PRs: task #10 links PR #45',
    });
    expect(api.closeMilestone).not.toHaveBeenCalled();
  });

  it("closes completed tasks, moves the rest to the backlog, and closes the sprint", async () => {
    const api = fakeApi({
      listMilestones: vi.fn(async () => [
        { number: 5, title: "Sprint A", description: "", state: "open" },
        { number: 99, title: "backlog", description: "", state: "open" },
      ]),
      listIssues: vi.fn(async () => [
        task({ number: 10, state: "completed", labels: ["completed"] }),
        task({ number: 11, state: "submitted", labels: ["submitted"] }),
      ]),
    });
    const res = await closeSprint(api, "o/r", "Sprint A");
    expect(res).toEqual({ ok: true, value: { movedToBacklog: [11], closed: [10] } });
    expect(api.closeIssue).toHaveBeenCalledWith("o/r", 10, "completed");
    expect(api.setIssueMilestone).toHaveBeenCalledWith("o/r", 11, 99);
    expect(api.closeMilestone).toHaveBeenCalledWith("o/r", 5);
  });

  it("creates the backlog milestone when it is missing", async () => {
    const api = fakeApi({
      listMilestones: vi.fn(async () => [{ number: 5, title: "Sprint A", description: "", state: "open" }]),
      listIssues: vi.fn(async () => [task({ number: 11, state: "submitted", labels: ["submitted"] })]),
      createMilestone: vi.fn(async () => ({ number: 99, title: "backlog" })),
    });
    const res = await closeSprint(api, "o/r", "Sprint A");
    expect(res).toEqual({ ok: true, value: { movedToBacklog: [11], closed: [] } });
    expect(api.createMilestone).toHaveBeenCalledWith("o/r", {
      title: "backlog",
      description: "Backlog: tasks awaiting a sprint.",
    });
    expect(api.setIssueMilestone).toHaveBeenCalledWith("o/r", 11, 99);
    expect(api.closeMilestone).toHaveBeenCalledWith("o/r", 5);
  });
});