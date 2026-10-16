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

describe("flipRequestFromPullRequest — what one PR delivery asks the board to flip", () => {
  const pr = (action: string, overrides: Record<string, unknown> = {}) => ({
    action,
    repository: { full_name: "Acme/Websites" },
    pull_request: { draft: false, title: "Board work", body: "Ships it.\n\nrefs #12", ...overrides },
  });

  it("a PR opened ready asks for its refs, repo lowercased", () => {
    expect(flipRequestFromPullRequest(pr("opened"))).toEqual({ repo: "acme/websites", refs: [12] });
  });

  it("a draft marked ready for review asks for its refs", () => {
    expect(flipRequestFromPullRequest(pr("ready_for_review"))).toEqual({ repo: "acme/websites", refs: [12] });
  });

  it("a draft opened is NOT ready — no request", () => {
    expect(flipRequestFromPullRequest(pr("opened", { draft: true }))).toBeNull();
  });

  it("a ready PR naming no task in title or body — no request", () => {
    expect(flipRequestFromPullRequest(pr("opened", { title: "Nothing", body: "no task here" }))).toBeNull();
  });

  it("a ref in the TITLE counts as much as one in the body", () => {
    expect(flipRequestFromPullRequest(pr("opened", { title: "refs #40", body: null }))).toEqual({ repo: "acme/websites", refs: [40] });
  });

  it("a null body and a missing repo are no request, never a throw", () => {
    expect(flipRequestFromPullRequest(pr("opened", { body: null, title: "x" }))).toBeNull();
    expect(flipRequestFromPullRequest({ action: "opened", pull_request: { draft: false, body: "refs #1" } })).toBeNull();
  });

  it("a payload with no pull_request object is no request", () => {
    expect(flipRequestFromPullRequest({ action: "opened" })).toBeNull();
  });
});
