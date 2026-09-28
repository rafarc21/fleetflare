import { describe, it, expect, vi } from "vitest";
import { runTaskReap, type ReapDeps, type ReapTaskInput } from "../src/studio/task-reap";

// Pure core, DI'd the same way src/studio/task-state.ts's TaskStateDeps<C>
// is -- no Env, no live fetch, no board.

function deps(overrides: Partial<ReapDeps> = {}): ReapDeps {
  return {
    repo: "o/r",
    listOpenTasks: async () => [],
    checkLanded: async () => ({ landed: false, sha: null }),
    findCloser: async () => ({ stateReason: null, closer: null }),
    prClaims: async () => true,
    close: async () => ({ ok: true, outcome: "closed" }),
    ...overrides,
  };
}

describe("runTaskReap — dry-run (apply: false)", () => {
  it("a task with no PR artifact is skipped, never crashes, and gives the reason", async () => {
    const d = deps({ listOpenTasks: async () => [{ taskNumber: 1, prNumber: null }] });
    const result = await runTaskReap(d, false);
    expect(result).toEqual([
      { taskNumber: 1, outcome: "skipped", reason: "no PR artifact found in the latest result envelope" },
    ]);
  });

  it("a task whose PR is not on the default branch yet is skipped", async () => {
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 1, prNumber: 9 }],
      checkLanded: async () => ({ landed: false, sha: null }),
    });
    const result = await runTaskReap(d, false);
    expect(result).toEqual([
      { taskNumber: 1, prNumber: 9, outcome: "skipped", reason: "PR not on default branch yet" },
    ]);
  });

  it("a task whose PR IS landed reports would-close and performs no write", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 1, prNumber: 9 }],
      checkLanded: async () => ({ landed: true, sha: "abc123" }),
      close,
    });
    const result = await runTaskReap(d, false);
    expect(result).toEqual([{ taskNumber: 1, prNumber: 9, outcome: "would-close", sha: "abc123" }]);
    expect(close).not.toHaveBeenCalled();
  });

  it("bare (no apply argument false) is the default posture -- same as an explicit --dry-run", async () => {
    // task-reap.ts's CLI/route layer is what actually spells --dry-run; this
    // proves the PURE core treats apply:false identically regardless of how
    // the caller arrived at it.
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 1, prNumber: 9 }],
      checkLanded: async () => ({ landed: true, sha: "abc123" }),
    });
    const result = await runTaskReap(d, false);
    expect(result[0].outcome).toBe("would-close");
  });
});

describe("runTaskReap — apply: true", () => {
  it("a landed task is actually closed via the shared close-action", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 1, prNumber: 9 }],
      checkLanded: async () => ({ landed: true, sha: "abc123" }),
      close,
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([{ taskNumber: 1, prNumber: 9, outcome: "closed", sha: "abc123" }]);
    expect(close).toHaveBeenCalledWith(1, "abc123");
  });

  // Board issue #157: the apply-success outcome must come from whatever
  // close-action itself reported (closed / already-closed / no-op), not a
  // hardcoded "closed" literal -- that hardcoding is exactly why `fleet task
  // reap --apply` used to print "closed" every run even on a true no-op.
  it("the apply-success outcome is whatever deps.close itself reported, not a hardcoded \"closed\"", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "already-closed" as const }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 1, prNumber: 9 }],
      checkLanded: async () => ({ landed: true, sha: "abc123" }),
      close,
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([{ taskNumber: 1, prNumber: 9, outcome: "already-closed", sha: "abc123" }]);
  });

  it("a task with no PR artifact is still skipped, never closed", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const d = deps({ listOpenTasks: async () => [{ taskNumber: 1, prNumber: null }], close });
    const result = await runTaskReap(d, true);
    expect(result[0].outcome).toBe("skipped");
    expect(close).not.toHaveBeenCalled();
  });

  it("a task not yet landed is still skipped, never closed", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 1, prNumber: 9 }],
      checkLanded: async () => ({ landed: false, sha: null }),
      close,
    });
    const result = await runTaskReap(d, true);
    expect(result[0].outcome).toBe("skipped");
    expect(close).not.toHaveBeenCalled();
  });

  it("a close-action failure is reported as skipped with the failure's own message, not thrown", async () => {
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 1, prNumber: 9 }],
      checkLanded: async () => ({ landed: true, sha: "abc123" }),
      close: async () => ({ ok: false, message: "board CAS conflict" }),
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([{ taskNumber: 1, outcome: "skipped", reason: "board CAS conflict" }]);
  });

  it("a THROWN close (not a rejected {ok:false}) is reported as skipped with the real error, not closed", async () => {
    // Board issue #8, Finding 1's caller-side follow-up: close-action.ts's
    // closeTaskOnPromote now throws on a genuine write failure instead of
    // silently swallowing it into a dedup no-op. This proves runTaskReap's
    // own try/catch around deps.close (already present) correctly reports
    // that as "skipped" with the failure's own message, not "closed".
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 1, prNumber: 9 }],
      checkLanded: async () => ({ landed: true, sha: "abc123" }),
      close: async () => { throw new Error("board CAS conflict"); },
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([
      { taskNumber: 1, outcome: "skipped", reason: expect.stringContaining("board CAS conflict") },
    ]);
  });

  it("a thrown checkLanded for one task is reported as skipped and does not stop the others", async () => {
    const tasks: ReapTaskInput[] = [{ taskNumber: 1, prNumber: 9 }, { taskNumber: 2, prNumber: 11 }];
    const d = deps({
      listOpenTasks: async () => tasks,
      checkLanded: async (pr) => {
        if (pr === 9) throw new Error("rate limited");
        return { landed: true, sha: "sha2" };
      },
    });
    const result = await runTaskReap(d, false);
    expect(result[0].outcome).toBe("skipped");
    expect(result[0]).toMatchObject({ taskNumber: 1, reason: expect.stringContaining("rate limited") });
    expect(result[1]).toEqual({ taskNumber: 2, prNumber: 11, outcome: "would-close", sha: "sha2" });
  });
});

describe("runTaskReap — multiple tasks, independently", () => {
  it("walks every task given and reports one outcome each, in order", async () => {
    const d = deps({
      listOpenTasks: async () => [
        { taskNumber: 1, prNumber: null },
        { taskNumber: 2, prNumber: 9 },
        { taskNumber: 3, prNumber: 11 },
      ],
      checkLanded: async (pr) => (pr === 9 ? { landed: true, sha: "s9" } : { landed: false, sha: null }),
    });
    const result = await runTaskReap(d, false);
    expect(result.map((r) => r.taskNumber)).toEqual([1, 2, 3]);
    expect(result[0].outcome).toBe("skipped");
    expect(result[1].outcome).toBe("would-close");
    expect(result[2].outcome).toBe("skipped");
  });

  it("no open tasks at all is an empty report, not an error", async () => {
    const result = await runTaskReap(deps(), false);
    expect(result).toEqual([]);
  });
});

// Board issue #138: token-auth repos get no webhooks, and a PR closing an
// issue with "Closes #N" often never lands a result envelope. 13 tasks sat
// `submitted` on GitHub-closed issues because reap only read envelopes. A
// CLOSED task with no envelope PR now asks GitHub who closed it.
describe("runTaskReap — closed task with no envelope PR (#138)", () => {
  it("a closed task whose closer is a merged PR reports would-close with that PR", async () => {
    const checkLanded = vi.fn(async () => ({ landed: true, sha: "m46" }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 39, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "COMPLETED", closer: { kind: "pr", number: 46, merged: true, repo: "o/r" } }),
      checkLanded,
    });
    const result = await runTaskReap(d, false);
    expect(result).toEqual([{ taskNumber: 39, prNumber: 46, outcome: "would-close", sha: "m46" }]);
    expect(checkLanded).toHaveBeenCalledWith(46);
  });

  it("apply: true closes it through the shared close-action", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 39, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "COMPLETED", closer: { kind: "pr", number: 46, merged: true, repo: "o/r" } }),
      checkLanded: async () => ({ landed: true, sha: "m46" }),
      close,
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([{ taskNumber: 39, prNumber: 46, outcome: "closed", sha: "m46" }]);
    expect(close).toHaveBeenCalledWith(39, "m46");
  });

  it("an OPEN task with no envelope is untouched — GitHub is never asked who closed it", async () => {
    const findCloser = vi.fn(async () => ({ stateReason: null, closer: null }));
    const d = deps({ listOpenTasks: async () => [{ taskNumber: 1, prNumber: null, open: true }], findCloser });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([
      { taskNumber: 1, outcome: "skipped", reason: "no PR artifact found in the latest result envelope" },
    ]);
    expect(findCloser).not.toHaveBeenCalled();
  });

  it("closed as not planned is left as-is, and dry-run says so", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const checkLanded = vi.fn(async () => ({ landed: true, sha: "x" }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 7, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "NOT_PLANNED", closer: null }),
      checkLanded, close,
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([{ taskNumber: 7, outcome: "skipped", reason: "closed as not planned — left as-is" }]);
    expect(checkLanded).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  // #143 review: the state reason outranks a merged closer.
  it("NOT_PLANNED with a merged PR closer is still left — checkLanded and close never run", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const checkLanded = vi.fn(async () => ({ landed: true, sha: "x" }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 7, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "NOT_PLANNED", closer: { kind: "pr", number: 46, merged: true, repo: "o/r" } }),
      checkLanded, close,
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([{ taskNumber: 7, outcome: "skipped", reason: "closed as not planned — left as-is" }]);
    expect(checkLanded).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("DUPLICATE is left as-is, and says so", async () => {
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 7, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "DUPLICATE", closer: null }),
    });
    const result = await runTaskReap(d, false);
    expect(result).toEqual([{ taskNumber: 7, outcome: "skipped", reason: "closed as duplicate — left as-is" }]);
  });

  it("a merged PR whose repo differs from the board slug only in case would-close", async () => {
    const d = deps({
      repo: "o/r",
      listOpenTasks: async () => [{ taskNumber: 39, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "COMPLETED", closer: { kind: "pr", number: 46, merged: true, repo: "O/R" } }),
      checkLanded: async () => ({ landed: true, sha: "m46" }),
    });
    const result = await runTaskReap(d, false);
    expect(result).toEqual([{ taskNumber: 39, prNumber: 46, outcome: "would-close", sha: "m46" }]);
  });

  it("a merged PR from another repo is skipped, never checked or closed", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const checkLanded = vi.fn(async () => ({ landed: true, sha: "x" }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 7, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "COMPLETED", closer: { kind: "pr", number: 5, merged: true, repo: "other/x" } }),
      checkLanded, close,
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([{ taskNumber: 7, outcome: "skipped", reason: "closed by other/x#5, another repo" }]);
    expect(checkLanded).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("closed by an unmerged PR is skipped, never closed", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 7, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "COMPLETED", closer: { kind: "pr", number: 50, merged: false, repo: "o/r" } }),
      close,
    });
    const result = await runTaskReap(d, true);
    expect(result).toEqual([{ taskNumber: 7, outcome: "skipped", reason: "closed by PR #50, which never merged" }]);
    expect(close).not.toHaveBeenCalled();
  });

  it("closed by hand (no closer) is skipped with the reason", async () => {
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 7, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "COMPLETED", closer: null }),
    });
    const result = await runTaskReap(d, false);
    expect(result).toEqual([{ taskNumber: 7, outcome: "skipped", reason: "closed without a closing PR — no merge to prove it landed" }]);
  });

  it("closed by a commit is skipped with the commit named", async () => {
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 7, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "COMPLETED", closer: { kind: "commit", sha: "abcdef1234567" } }),
    });
    const result = await runTaskReap(d, false);
    expect(result).toEqual([{ taskNumber: 7, outcome: "skipped", reason: "closed by commit abcdef12, not a PR" }]);
  });

  it("a thrown findCloser is skipped for that task alone", async () => {
    const d = deps({
      listOpenTasks: async () => [
        { taskNumber: 7, prNumber: null, open: false },
        { taskNumber: 8, prNumber: 9 },
      ],
      findCloser: async () => { throw new Error("rate limited"); },
      checkLanded: async () => ({ landed: true, sha: "s9" }),
    });
    const result = await runTaskReap(d, false);
    expect(result[0]).toEqual({ taskNumber: 7, outcome: "skipped", reason: "finding who closed it failed: rate limited" });
    expect(result[1]).toEqual({ taskNumber: 8, prNumber: 9, outcome: "would-close", sha: "s9" });
  });
});

// Issue #248, measured 2026-09-25: #107 is two PRs. PR4a #150 landed with no
// closing keyword while #107 sat input_required, and `reap --apply` closed it.
describe("runTaskReap — a landed PR closes only a task it claims (#248)", () => {
  const NO_CLAIM = "PR #150 landed but does not close #107 (no closing keyword) — multi-PR task?";

  for (const apply of [false, true]) {
    it(`#107 shape (landed, no keyword, input_required) is skipped, apply: ${apply}`, async () => {
      const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
      const d = deps({
        listOpenTasks: async () => [{ taskNumber: 107, prNumber: 150, state: "input_required" }],
        checkLanded: async () => ({ landed: true, sha: "ef4e9a15" }),
        prClaims: async () => false,
        close,
      });
      const result = await runTaskReap(d, apply);
      expect(result).toEqual([{ taskNumber: 107, prNumber: 150, outcome: "skipped", reason: "parked input_required" }]);
      expect(close).not.toHaveBeenCalled();
    });

    it(`a landed PR that does not claim the task is skipped, apply: ${apply}`, async () => {
      const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
      const prClaims = vi.fn(async () => false);
      const d = deps({
        listOpenTasks: async () => [{ taskNumber: 107, prNumber: 150, state: "working" }],
        checkLanded: async () => ({ landed: true, sha: "ef4e9a15" }),
        prClaims,
        close,
      });
      const result = await runTaskReap(d, apply);
      expect(result).toEqual([{ taskNumber: 107, prNumber: 150, outcome: "skipped", reason: NO_CLAIM }]);
      expect(prClaims).toHaveBeenCalledWith(150, 107);
      expect(close).not.toHaveBeenCalled();
    });

    it(`input_required is never closed, even by a PR that claims it, apply: ${apply}`, async () => {
      const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
      const checkLanded = vi.fn(async () => ({ landed: true, sha: "s" }));
      const d = deps({
        listOpenTasks: async () => [{ taskNumber: 107, prNumber: 151, state: "input_required" }],
        checkLanded,
        close,
      });
      const result = await runTaskReap(d, apply);
      expect(result).toEqual([{ taskNumber: 107, prNumber: 151, outcome: "skipped", reason: "parked input_required" }]);
      expect(checkLanded).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });
  }

  it("a landed PR that claims the task ('Closes #T') closes it", async () => {
    const close = vi.fn(async () => ({ ok: true, outcome: "closed" as const }));
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 107, prNumber: 151, state: "working" }],
      checkLanded: async () => ({ landed: true, sha: "abc" }),
      prClaims: async (pr, task) => pr === 151 && task === 107,
      close,
    });
    expect(await runTaskReap(d, true)).toEqual([{ taskNumber: 107, prNumber: 151, outcome: "closed", sha: "abc" }]);
    expect(close).toHaveBeenCalledWith(107, "abc");
  });

  it("a thrown prClaims is skipped for that task alone", async () => {
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 107, prNumber: 150 }],
      checkLanded: async () => ({ landed: true, sha: "abc" }),
      prClaims: async () => { throw new Error("rate limited"); },
    });
    expect(await runTaskReap(d, false)).toEqual([{
      taskNumber: 107, prNumber: 150, outcome: "skipped", reason: "checking whether PR #150 closes #107 failed: rate limited",
    }]);
  });

  it("findCloser path (#138) is unchanged: the closer PR is not asked to claim the task", async () => {
    const prClaims = vi.fn(async () => false);
    const d = deps({
      listOpenTasks: async () => [{ taskNumber: 39, prNumber: null, open: false }],
      findCloser: async () => ({ stateReason: "COMPLETED", closer: { kind: "pr", number: 46, merged: true, repo: "o/r" } }),
      checkLanded: async () => ({ landed: true, sha: "m46" }),
      prClaims,
    });
    expect(await runTaskReap(d, false)).toEqual([{ taskNumber: 39, prNumber: 46, outcome: "would-close", sha: "m46" }]);
    expect(prClaims).not.toHaveBeenCalled();
  });
});
