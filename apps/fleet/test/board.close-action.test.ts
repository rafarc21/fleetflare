import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { closeTaskOnPromote } from "../src/board/close-action";
import { readSince } from "../src/events/log";
import type { BoardApi } from "../src/board/board";
import type { BoardTask } from "../src/board/types";
import type { Env } from "../src/env";

// Real D1 (env.DB from cloudflare:test) for the dedup guard -- same
// precedent test/github.webhook.test.ts already uses for the identical
// appendEvent + ON CONFLICT DO NOTHING pattern -- and a fake BoardApi for
// every GitHub call, so no test needs a live issue.

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/o/r/issues/12", title: "Some task",
    body: "## Objective\n\nShip it.\n", state: "working", labels: ["working"],
    assignee: null, milestone: null, open: true, updatedAt: "2026-09-18T10:00:00Z", ...overrides,
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
    listMilestones: vi.fn(async () => []),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    ...overrides,
  };
}

const testEnv = env as unknown as Env;

beforeEach(async () => {
  await testEnv.DB.prepare("DELETE FROM events").run();
});

describe("closeTaskOnPromote", () => {
  it("closes the issue, transitions the board to completed, and comments the evidence", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })) });
    const result = await closeTaskOnPromote(
      testEnv, api, "o/r", 12, { sha: "abc123456789", branch: "main" }, 1_000,
    );
    expect(result).toEqual({ ok: true, outcome: "closed" });
    expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12, "completed");
    expect(api.removeLabel).toHaveBeenCalledWith("o/r", 12, "working");
    expect(api.addLabels).toHaveBeenCalledWith("o/r", 12, ["completed"]);
    expect(api.createComment).toHaveBeenCalledWith("o/r", 12, expect.stringContaining("abc12345"));
    expect(api.createComment).toHaveBeenCalledWith("o/r", 12, expect.stringContaining("main"));
  });

  it("the posted comment reads exactly \"closed by <sha>, promoted to <branch>\"", async () => {
    const api = fakeApi();
    await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "deadbeefcafe", branch: "staging" }, 1_000);
    const body = vi.mocked(api.createComment).mock.calls[0][2];
    expect(body).toBe("closed by deadbeef, promoted to staging");
  });

  // #66 follow-up: the comment used to be Portuguese. Dedup never read
  // comment TEXT -- it is the D1 event key plus the board's `completed`
  // state -- so changing the wording cannot make a task closed under the
  // old wording get a second comment. These two pin that.
  describe("tasks closed under the old Portuguese wording get no second comment", () => {
    const legacy = "fechada por abc12345 promovido a main"; // english-check: allow (pre-#66 Worker wording)

    it("board already `completed`, thread holds the Portuguese comment, a NEW sha arrives, GitHub still open -> issue closed, no comment", async () => {
      const api = fakeApi({
        getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: true })),
        listComments: vi.fn(async () => [{ id: 1, body: legacy }] as never),
      });
      const result = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "newsha999999", branch: "main" }, 1_000);
      expect(result).toEqual({ ok: true, outcome: "closed" });
      expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12);
      expect(api.createComment).not.toHaveBeenCalled();
    });

    it("the SAME evidence the old Worker already recorded (its D1 key) -> no comment, no GitHub write (still reads the real state)", async () => {
      const oldApi = fakeApi();
      await closeTaskOnPromote(testEnv, oldApi, "o/r", 12, { sha: "abc123456789", branch: "main" }, 1_000);
      // Default fake task: state "working", open: true. `open: true` alone
      // would-be-triggering if the dedup-hit backfill only checked `open` --
      // it must also require `state === "completed"`, which this does NOT
      // have, so this is a genuine "no write" proof, not one that passes
      // merely because the state never qualifies for a close either way.
      const api = fakeApi();
      const result = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "abc123456789", branch: "main" }, 2_000);
      expect(result).toEqual({ ok: true, outcome: "no-op" });
      expect(api.getIssue).toHaveBeenCalledWith("o/r", 12);
      expect(api.closeIssue).not.toHaveBeenCalled();
      expect(api.createComment).not.toHaveBeenCalled();
    });
  });

  describe("idempotency", () => {
    it("the SAME evidence (repo+issue+sha) called twice performs the real work only once", async () => {
      const api = fakeApi();
      const first = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "samesha1234", branch: "main" }, 1_000);
      const second = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "samesha1234", branch: "main" }, 2_000);
      expect(first).toEqual({ ok: true, outcome: "closed" });
      expect(second).toEqual({ ok: true, outcome: "no-op" });
      expect(api.closeIssue).toHaveBeenCalledTimes(1);
      expect(api.createComment).toHaveBeenCalledTimes(1);
      expect(api.addLabels).toHaveBeenCalledTimes(1);
    });

    it("a DIFFERENT sha for the same issue is a distinct evidence key and closes again", async () => {
      const api = fakeApi();
      await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "sha-one-123", branch: "main" }, 1_000);
      const second = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "sha-two-456", branch: "main" }, 2_000);
      expect(second.outcome).toBe("closed");
      expect(api.closeIssue).toHaveBeenCalledTimes(2);
    });

    it("records a marker row an operator/webhook redelivery can be traced through", async () => {
      const api = fakeApi();
      await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "tracedsha1", branch: "main" }, 1_000);
      const events = await readSince(testEnv.DB, "board", 0);
      expect(events.some((e) => e.id === "gh_close_o/r_12_tracedsha1")).toBe(true);
    });

    // Finding 1: the exact case the fresh-context review said no test
    // covered -- "dedup marker recorded, then a downstream write throws".
    // Fails against the OLD code (marker written FIRST): the throw still
    // propagates on the first call, but the marker is already committed, so
    // a SECOND call with the SAME evidence silently no-ops forever instead
    // of retrying -- closeIssue would be called only once total, never
    // twice, and the second call would never throw either.
    it("a downstream write throwing leaves NO dedup marker committed -- a retry with the same evidence genuinely retries", async () => {
      const api = fakeApi({
        closeIssue: vi.fn()
          .mockRejectedValueOnce(new Error("GitHub 502"))
          .mockResolvedValueOnce(undefined),
      });

      await expect(
        closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "poison-sha", branch: "main" }, 1_000),
      ).rejects.toThrow("GitHub 502");

      // No marker was committed by the failed attempt.
      const eventsAfterFailure = await readSince(testEnv.DB, "board", 0);
      expect(eventsAfterFailure.some((e) => e.id === "gh_close_o/r_12_poison-sha")).toBe(false);

      // A retry with the SAME evidence genuinely retries the real work
      // (closeIssue called a second time) and succeeds this time.
      const retry = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "poison-sha", branch: "main" }, 2_000);
      expect(retry).toEqual({ ok: true, outcome: "closed" });
      expect(api.closeIssue).toHaveBeenCalledTimes(2);

      // The marker is committed only now, after the real work succeeded.
      const eventsAfterRetry = await readSince(testEnv.DB, "board", 0);
      expect(eventsAfterRetry.some((e) => e.id === "gh_close_o/r_12_poison-sha")).toBe(true);
    });
  });

  // Board issue #157: `task.state === "completed"` on the board is NOT the
  // same fact as GitHub's own open/closed -- the #98 repro was exactly this,
  // a board already reading "completed" while the GitHub issue itself sat
  // open forever, because this branch used to be an empty no-op regardless
  // of `task.open`.
  it("a task already completed on the board but GitHub still open (#98) closes the GitHub issue only -- no re-transition, no re-comment", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: true })) });
    const result = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "alreadyclosed", branch: "main" }, 1_000);
    expect(result).toEqual({ ok: true, outcome: "closed" });
    expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12);
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("a task already completed on the board AND already closed on GitHub is a true no-op -- no GitHub write at all", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: false })) });
    const result = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "trulyclosed", branch: "main" }, 1_000);
    expect(result).toEqual({ ok: true, outcome: "already-closed" });
    expect(api.closeIssue).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  describe("Finding 3 -- an already-completed, already-GitHub-closed task does not re-close or re-comment for a distinct sha", () => {
    it("a DIFFERENT sha discovered later for an already-completed, already-closed task is a full no-op past the dedup guard", async () => {
      const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: false })) });
      // A prior call already closed this task under a different sha.
      const first = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "sha-original", branch: "main" }, 1_000);
      expect(first).toEqual({ ok: true, outcome: "already-closed" });

      const second = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "sha-late-discovery", branch: "main" }, 2_000);
      expect(second).toEqual({ ok: true, outcome: "already-closed" });
      expect(api.closeIssue).not.toHaveBeenCalled();
      expect(api.createComment).not.toHaveBeenCalled();
    });

    it("still records the dedup marker for the late evidence, so a repeat of THAT sha is itself a no-op", async () => {
      const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: false })) });
      await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "late-sha-again", branch: "main" }, 1_000);
      const events = await readSince(testEnv.DB, "board", 0);
      expect(events.some((e) => e.id === "gh_close_o/r_12_late-sha-again")).toBe(true);
    });
  });

  it("a task with no single board state label (drift) still closes the GitHub issue, logs, and does not throw", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: null, labels: [] })) });
    const result = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "driftsha1234", branch: "main" }, 1_000);
    expect(result).toEqual({ ok: true, outcome: "closed" });
    expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12);
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  // Reviewer hold on #161: a dedup record already existing (as production
  // actually has for #98) used to make the dedup-hit branch above return
  // BEFORE ever reaching the completed+open backfill check -- the exact
  // shape of the #157 bug, just relocated one guard earlier. The dedup-hit
  // branch itself now checks GitHub's real state and backfills the close
  // when needed, writing NO new dedup record (one already exists) and doing
  // NO comment/label transition.
  describe("dedup-hit backfill -- a dedup record already exists, but GitHub's own issue never actually closed (#98's real shape)", () => {
    it("dedup record pre-seeded (same sha) + board completed + GitHub open -> backfills the close only, no re-transition or re-comment", async () => {
      const seedApi = fakeApi();
      await closeTaskOnPromote(testEnv, seedApi, "o/r", 12, { sha: "backfillsha1", branch: "main" }, 1_000);

      const api = fakeApi({
        getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: true })),
      });
      const result = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "backfillsha1", branch: "main" }, 2_000);
      expect(result).toEqual({ ok: true, outcome: "closed" });
      expect(api.closeIssue).toHaveBeenCalledTimes(1);
      expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12);
      expect(api.createComment).not.toHaveBeenCalled();
      expect(api.addLabels).not.toHaveBeenCalled();
      expect(api.removeLabel).not.toHaveBeenCalled();
    });

    it("dedup record pre-seeded (same sha) + board completed + GitHub closed -> true no-op, no GitHub write at all", async () => {
      const seedApi = fakeApi();
      await closeTaskOnPromote(testEnv, seedApi, "o/r", 12, { sha: "backfillsha2", branch: "main" }, 1_000);

      const api = fakeApi({
        getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: false })),
      });
      const result = await closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "backfillsha2", branch: "main" }, 2_000);
      expect(result).toEqual({ ok: true, outcome: "no-op" });
      expect(api.closeIssue).not.toHaveBeenCalled();
      expect(api.createComment).not.toHaveBeenCalled();
      expect(api.addLabels).not.toHaveBeenCalled();
      expect(api.removeLabel).not.toHaveBeenCalled();
    });

    // Mutant K14: "completed+open -> closeIssue throws" must never be
    // swallowed into a false `{ ok: true }` on either entry point -- that is
    // exactly how #98 got stuck (an earlier buggy build let the write get
    // marked done regardless of whether the real GitHub call ever
    // succeeded). Covered for BOTH the fresh-evidence path (no dedup record
    // yet) and the dedup-hit backfill path (one already exists).
    it("fresh evidence, board already completed, GitHub open, closeIssue throws -> error propagates and no dedup marker is written", async () => {
      const api = fakeApi({
        getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: true })),
        closeIssue: vi.fn().mockRejectedValueOnce(new Error("GitHub 500")),
      });

      await expect(
        closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "poison-completed", branch: "main" }, 1_000),
      ).rejects.toThrow("GitHub 500");

      const events = await readSince(testEnv.DB, "board", 0);
      expect(events.some((e) => e.id === "gh_close_o/r_12_poison-completed")).toBe(false);
    });

    it("dedup record already exists, board completed, GitHub open, closeIssue throws on backfill -> error propagates, not swallowed into a false ok:true", async () => {
      const seedApi = fakeApi();
      await closeTaskOnPromote(testEnv, seedApi, "o/r", 12, { sha: "backfill-poison", branch: "main" }, 1_000);

      const api = fakeApi({
        getIssue: vi.fn(async () => task({ state: "completed", labels: ["completed"], open: true })),
        closeIssue: vi.fn().mockRejectedValueOnce(new Error("GitHub 503")),
      });

      await expect(
        closeTaskOnPromote(testEnv, api, "o/r", 12, { sha: "backfill-poison", branch: "main" }, 2_000),
      ).rejects.toThrow("GitHub 503");
      expect(api.closeIssue).toHaveBeenCalledWith("o/r", 12);
    });
  });
});
