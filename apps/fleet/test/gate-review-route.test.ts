// #1469: the review route handlers over fakes. Verifies the start decision
// wiring (disabled/skip/run/dedup) and the status envelope->verdict mapping.
import { describe, it, expect, vi } from "vitest";
import {
  runReviewStart, runReviewStatus, handleReviewRoute, reviewBrief,
  type ReviewPort, type ReviewBoard, type ReviewRunIndex,
} from "../src/gate/review-route";
import type { ReviewConfig } from "../src/gate/config";

const REPO = "acme/example";
const HEAD = "c".repeat(40);

function port(cfg: ReviewConfig | null, files: string[], state?: string): ReviewPort {
  let posted: { state: string; description: string } | null = null;
  return {
    pr: vi.fn(async () => ({ headSha: HEAD, baseSha: "b".repeat(40) })),
    changedFiles: vi.fn(async () => files),
    reviewConfig: vi.fn(async () => cfg),
    status: {
      mintToken: vi.fn(async () => "tok"),
      post: vi.fn(async (_t, _r, _s, s, description) => { posted = { state: s, description }; }),
      get: vi.fn(async () => (state !== undefined ? { state, description: state } : posted ?? undefined)),
    },
  };
}

function board(envelopeStatus?: string): ReviewBoard {
  return {
    createTask: vi.fn(async () => 42),
    latestEnvelopeStatus: vi.fn(async () => envelopeStatus),
  };
}

function index(record?: { headSha: string; studioId: string; task: number }): ReviewRunIndex {
  return {
    latest: vi.fn(async () => record ?? null),
    record: vi.fn(async () => {}),
  };
}

const spawn = vi.fn(async () => "acme--reviewer");

describe("runReviewStart (#1469)", () => {
  it("disabled repo -> noop", async () => {
    const r = await runReviewStart(port(null, ["src/a.ts"]), board(), spawn, index(), { repo: REPO, pr: 1 });
    expect(r.kind).toBe("noop");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("docs-only diff -> noop, posts neutral", async () => {
    const p = port({ enabled: true, blockingPaths: [], lead: "claude" }, ["README.md"]);
    const r = await runReviewStart(p, board(), spawn, index(), { repo: REPO, pr: 1 });
    expect(r.kind).toBe("noop");
    expect(p.status.post).toHaveBeenCalledWith("tok", REPO, HEAD, "success", "skipped: docs/lockfile-only diff");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("a head already carrying a status -> already", async () => {
    const p = port({ enabled: true, blockingPaths: [], lead: "claude" }, ["src/a.ts"], "success");
    const r = await runReviewStart(p, board(), spawn, index(), { repo: REPO, pr: 1 });
    expect(r.kind).toBe("already");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("a live run of the same head in the index -> already (no second reviewer)", async () => {
    const p = port({ enabled: true, blockingPaths: [], lead: "claude" }, ["src/a.ts"]);
    const r = await runReviewStart(p, board(), spawn, index({ headSha: HEAD, studioId: "acme--reviewer", task: 1 }), { repo: REPO, pr: 1 });
    expect(r.kind).toBe("already");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("runs a reviewer, files a task, records the run, posts pending", async () => {
    const p = port({ enabled: true, blockingPaths: ["migrations/**"], lead: "deepseek" }, ["migrations/1.sql"]);
    const b = board();
    const ix = index();
    const r = await runReviewStart(p, b, spawn, ix, { repo: REPO, pr: 7, axis: "security" });
    expect(r.kind).toBe("started");
    expect(spawn).toHaveBeenCalledWith(REPO, "reviewer", "glm", 42);
    expect(b.createTask).toHaveBeenCalled();
    expect(ix.record).toHaveBeenCalledWith(REPO, 7, { headSha: HEAD, studioId: "acme--reviewer", task: 42 });
    expect(p.status.post).toHaveBeenCalledWith("tok", REPO, HEAD, "pending", "review in progress");
  });
});

describe("runReviewStatus (#1469)", () => {
  it("no run -> pending", async () => {
    const r = await runReviewStatus(port(null, []), board(), index(), { repo: REPO, pr: 1 });
    expect(r.state).toBe("pending");
  });
  it("no envelope yet -> pending", async () => {
    const r = await runReviewStatus(port(null, []), board(undefined), index({ headSha: HEAD, studioId: "x", task: 1 }), { repo: REPO, pr: 1 });
    expect(r.state).toBe("pending");
  });
  it("ok envelope -> success", async () => {
    const p = port({ enabled: true, blockingPaths: ["migrations/**"], lead: "claude" }, ["migrations/1.sql"]);
    const r = await runReviewStatus(p, board("ok"), index({ headSha: HEAD, studioId: "x", task: 1 }), { repo: REPO, pr: 1 });
    expect(r.state).toBe("success");
  });
  it("blocked envelope on a blocking path -> failure", async () => {
    const p = port({ enabled: true, blockingPaths: ["migrations/**"], lead: "claude" }, ["migrations/1.sql"]);
    const r = await runReviewStatus(p, board("blocked"), index({ headSha: HEAD, studioId: "x", task: 1 }), { repo: REPO, pr: 1 });
    expect(r.state).toBe("failure");
  });
  it("blocked envelope off a blocking path -> neutral", async () => {
    const p = port({ enabled: true, blockingPaths: ["migrations/**"], lead: "claude" }, ["src/a.ts"]);
    const r = await runReviewStatus(p, board("blocked"), index({ headSha: HEAD, studioId: "x", task: 1 }), { repo: REPO, pr: 1 });
    expect(r.state).toBe("neutral");
  });
});

describe("reviewBrief (#1469)", () => {
  it("names the axis and blocking", () => {
    const b = reviewBrief(REPO, 1, "security", true);
    expect(b.objective).toContain("security axis");
    expect(b.objective).toContain("blocks these paths");
    expect(b.boundaries).toContain("no push, no merge");
  });
  it("defaults to all three axes when none named", () => {
    expect(reviewBrief(REPO, 1, undefined, false).objective).toContain("all three axes");
  });
});

describe("handleReviewRoute (#1469)", () => {
  const deps = {
    port: port({ enabled: true, blockingPaths: [], lead: "claude" }, ["src/a.ts"]),
    board: board("ok"),
    spawn,
    index: index(),
  };
  it("start returns started with the studio id", async () => {
    const req = new Request("https://worker/studio/review/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 1 }),
    });
    const res = await handleReviewRoute(req, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ started: true, studioId: "acme--reviewer", task: 42 });
  });
  it("start rejects a bad axis", async () => {
    const req = new Request("https://worker/studio/review/start", {
      method: "POST", body: JSON.stringify({ repo: REPO, pr: 1, axis: "style" }),
    });
    const res = await handleReviewRoute(req, deps);
    expect(res.status).toBe(400);
  });
  it("status returns a verdict", async () => {
    const req = new Request("https://worker/studio/review/status?repo=acme/example&pr=1");
    const res = await handleReviewRoute(req, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "pending" });
  });
});