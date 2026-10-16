import { describe, it, expect, vi } from "vitest";
import { refsInBody, prAwaitsMerge, markAwaitingMerge, flipRequestFromPullRequest } from "../src/board/pr-awaiting-merge";
import { fakeApi, task } from "./helpers/board-api";
import { studioLabel } from "../src/board/types";

// Board issue #1071, item 1: a PR that names a board task with `refs #N`
// flips that task working -> awaiting_merge once the PR is ready for review.
// Maestros flipped these by hand (2 of 4 lanes sat at "working" with a PR
// open). Pure over the BoardApi port, so every rule is proven with no webhook,
// no token and no GitHub.

const WEB = "websites--web-studio";
const REPO = "acme/websites";

const assigned = (number: number, state: string | null, overrides: Partial<ReturnType<typeof task>> = {}) =>
  task({
    number,
    state: state as ReturnType<typeof task>["state"],
    labels: [...(state ? [state] : []), studioLabel(WEB)],
    assignee: WEB,
    ...overrides,
  });

describe("refsInBody — which tasks a PR names", () => {
  it("reads every `refs #N` once, in order", () => {
    expect(refsInBody("Work for the board.\n\nrefs #12\nrefs #40 and also refs #12")).toEqual([12, 40]);
  });

  it("matches case-insensitively", () => {
    expect(refsInBody("REFS #7")).toEqual([7]);
  });

  it("ignores a bare #N and a closing keyword — a PR never closes a task by naming it", () => {
    expect(refsInBody("closes #9, see #10, fixes #11")).toEqual([]);
  });

  it("returns [] for an empty or null-ish body", () => {
    expect(refsInBody("")).toEqual([]);
  });
});

describe("prAwaitsMerge — which PR events mean 'ready for review'", () => {
  it("a PR opened ready (not draft) counts", () => {
    expect(prAwaitsMerge("opened", false)).toBe(true);
  });

  it("a draft opened is NOT ready yet", () => {
    expect(prAwaitsMerge("opened", true)).toBe(false);
  });

  it("a draft marked ready for review counts", () => {
    expect(prAwaitsMerge("ready_for_review", false)).toBe(true);
  });

  it("any other PR action does not count — a push, a close, an edit", () => {
    expect(prAwaitsMerge("synchronize", false)).toBe(false);
    expect(prAwaitsMerge("closed", false)).toBe(false);
    expect(prAwaitsMerge("edited", false)).toBe(false);
  });
});

describe("markAwaitingMerge — flip the referenced task when its PR is ready", () => {
  it("flips a WORKING task assigned to a studio: working off, awaiting_merge on", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => assigned(12, "working")) });
    const flipped = await markAwaitingMerge(api, REPO, [12]);
    expect(flipped).toEqual([12]);
    expect(api.removeLabel).toHaveBeenCalledWith(REPO, 12, "working");
    expect(api.addLabels).toHaveBeenCalledWith(REPO, 12, ["awaiting_merge"]);
  });

  it("writes nothing for a task that is not working — submitted, input_required, awaiting_merge already", async () => {
    for (const state of ["submitted", "input_required", "awaiting_merge"]) {
      const api = fakeApi({ getIssue: vi.fn(async () => assigned(12, state)) });
      expect(await markAwaitingMerge(api, REPO, [12])).toEqual([]);
      expect(api.removeLabel).not.toHaveBeenCalled();
      expect(api.addLabels).not.toHaveBeenCalled();
    }
  });

  it("writes nothing for an unassigned task — the webhook only moves a studio's own work", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 12, state: "working", labels: ["working"], assignee: null })),
    });
    expect(await markAwaitingMerge(api, REPO, [12])).toEqual([]);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("writes nothing for a CLOSED issue — the Worker never reopens or re-labels finished work", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => assigned(12, "working", { open: false })) });
    expect(await markAwaitingMerge(api, REPO, [12])).toEqual([]);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("writes nothing for a drifted task (two state labels) — another writer touched it", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => assigned(12, null, { labels: ["working", "submitted", studioLabel(WEB)] })),
    });
    expect(await markAwaitingMerge(api, REPO, [12])).toEqual([]);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("a board read failure on one ref skips that ref and still flips the rest", async () => {
    const getIssue = vi.fn(async (_repo: string, n: number) => {
      if (n === 12) throw new Error("board down");
      return assigned(n, "working");
    });
    const flipped = await markAwaitingMerge(fakeApi({ getIssue }), REPO, [12, 40]);
    expect(flipped).toEqual([40]);
  });
});

// Board issue #1077: several working refs need the PR's head branch to break
// the tie. A sub-PR routinely names its umbrella tasks too (`refs #977, refs
// #945, refs #715`), so an umbrella left in `working` must not flip with it.
describe("markAwaitingMerge — several working refs, the PR's head branch breaks the tie", () => {
  const board = (tasks: Record<number, ReturnType<typeof task>>) =>
    fakeApi({ getIssue: vi.fn(async (_repo: string, n: number) => tasks[n]!) });

  it("an umbrella still working next to the sub-task the branch names: only the sub-task flips", async () => {
    const api = board({ 715: assigned(715, "working"), 1049: assigned(1049, "working") });
    expect(await markAwaitingMerge(api, REPO, [715, 1049], "task-1049-board-umbrella")).toEqual([1049]);
    expect(api.addLabels).toHaveBeenCalledTimes(1);
    expect(api.addLabels).toHaveBeenCalledWith(REPO, 1049, ["awaiting_merge"]);
  });

  it("several candidates and the branch names none of them: nothing flips, and the ambiguity is logged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = board({ 715: assigned(715, "working"), 1049: assigned(1049, "working") });
    expect(await markAwaitingMerge(api, REPO, [715, 1049], "fix-refactor-login")).toEqual([]);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("several candidates and the branch names two of them: still ambiguous, nothing flips", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = board({ 715: assigned(715, "working"), 1049: assigned(1049, "working") });
    expect(await markAwaitingMerge(api, REPO, [715, 1049], "task-715-1049-umbrella")).toEqual([]);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a number inside a longer digit run is not a token: `task-10491` does not name #1049", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = board({ 715: assigned(715, "working"), 1049: assigned(1049, "working") });
    expect(await markAwaitingMerge(api, REPO, [715, 1049], "task-10491-board")).toEqual([]);
    expect(api.addLabels).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("several candidates and no head branch to read: nothing flips", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = board({ 715: assigned(715, "working"), 1049: assigned(1049, "working") });
    expect(await markAwaitingMerge(api, REPO, [715, 1049])).toEqual([]);
    expect(api.addLabels).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("exactly one candidate flips even when the branch names another task", async () => {
    const api = board({ 715: assigned(715, "working"), 1049: assigned(1049, "submitted") });
    expect(await markAwaitingMerge(api, REPO, [715, 1049], "task-1049-board-umbrella")).toEqual([715]);
    expect(api.addLabels).toHaveBeenCalledWith(REPO, 715, ["awaiting_merge"]);
  });

  it("a closed or unassigned ref is not a candidate, so it never competes for the tie-break", async () => {
    const api = board({
      715: assigned(715, "working"),
      1049: assigned(1049, "working", { open: false }),
      977: task({ number: 977, state: "working", labels: ["working"], assignee: null }),
    });
    expect(await markAwaitingMerge(api, REPO, [715, 1049, 977], "fix-refactor-login")).toEqual([715]);
  });
});

describe("flipRequestFromPullRequest — what one PR delivery asks the board to flip", () => {
  const pr = (action: string, overrides: Record<string, unknown> = {}) => ({
    action,
    repository: { full_name: "Acme/Websites" },
    pull_request: {
      draft: false, title: "Board work", body: "Ships it.\n\nrefs #12",
      head: { ref: "task-12-board-work" }, ...overrides,
    },
  });

  it("a PR opened ready asks for its refs and its head branch, repo lowercased", () => {
    expect(flipRequestFromPullRequest(pr("opened"))).toEqual({
      repo: "acme/websites", refs: [12], head: "task-12-board-work",
    });
  });

  it("a draft marked ready for review asks for its refs and its head branch", () => {
    expect(flipRequestFromPullRequest(pr("ready_for_review"))).toEqual({
      repo: "acme/websites", refs: [12], head: "task-12-board-work",
    });
  });

  it("a PR with no readable head branch still asks, with an empty head", () => {
    expect(flipRequestFromPullRequest({
      action: "opened", repository: { full_name: "Acme/Websites" },
      pull_request: { draft: false, title: "x", body: "refs #3" },
    })).toEqual({ repo: "acme/websites", refs: [3], head: "" });
  });

  it("a draft opened is NOT ready — no request", () => {
    expect(flipRequestFromPullRequest(pr("opened", { draft: true }))).toBeNull();
  });

  it("a ready PR naming no task in title or body — no request", () => {
    expect(flipRequestFromPullRequest(pr("opened", { title: "Nothing", body: "no task here" }))).toBeNull();
  });

  it("a ref in the TITLE counts as much as one in the body", () => {
    expect(flipRequestFromPullRequest(pr("opened", { title: "refs #40", body: null }))).toEqual({
      repo: "acme/websites", refs: [40], head: "task-12-board-work",
    });
  });

  it("a null body and a missing repo are no request, never a throw", () => {
    expect(flipRequestFromPullRequest(pr("opened", { body: null, title: "x" }))).toBeNull();
    expect(flipRequestFromPullRequest({ action: "opened", pull_request: { draft: false, body: "refs #1" } })).toBeNull();
  });

  it("a payload with no pull_request object is no request", () => {
    expect(flipRequestFromPullRequest({ action: "opened" })).toBeNull();
  });
});
