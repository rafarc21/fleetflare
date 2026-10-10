import { describe, it, expect, vi, afterEach } from "vitest";
import { studioOpenPrs } from "../src/board/open-prs";
import { parseEnvelope, renderEnvelopeComment } from "../src/board/envelope";
import * as boardModule from "../src/board/board";
import type { BoardApi, TaskComment } from "../src/board/board";
import { studioLabel, type BoardTask, type BoardTaskView, type EnvelopeDoc } from "../src/board/types";

// Board issue #332: the park/destroy unmerged-PR warning's scan. Same
// fake-BoardApi conventions as test/board.pr-landed.test.ts and
// test/board.verify.test.ts — the PORT is faked as a plain object literal
// (never a vi.mock of the module under test), so every assertion below is
// about what studioOpenPrs DID, never about a live issue or a source file's
// text. The one vi.spyOn below targets board.ts's PUBLIC listTasks export —
// the same collaborator-spy shape test/board.read-repos.test.ts already uses
// for authModule.verifyAccess — and exists only because a `{assignedTo}`-only
// listTasks call has no milestone/state leg to refuse on, so a `{ok:false}` is
// structurally unreachable through the port alone; board.board.test.ts's own
// "listIssues throwing resolves to null" comment records that same fact for
// resolveLatestAssignedBrief.

const REPO = "acme-org/websites";
const MINE = "websites--web-studio";

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: `https://github.com/${REPO}/issues/12`, title: "Ship it",
    body: "## Objective\n\nShip it.\n", state: "working", labels: ["working", studioLabel(MINE)],
    assignee: MINE, milestone: null, open: true, updatedAt: "2026-10-10T10:00:00Z", ...overrides,
  };
}

function view(overrides: Partial<BoardTaskView> = {}): BoardTaskView {
  return { ...task(overrides), stale: false, ...overrides };
}

function pr(overrides: Partial<{ number: number; merged: boolean; open: boolean; title: string }> = {}) {
  return { number: 9, merged: false, open: true, title: "feat: the thing", ...overrides };
}

function fakeApi(overrides: Partial<BoardApi> = {}): BoardApi {
  return {
    createIssue: vi.fn(async () => task()),
    getIssue: vi.fn(async (_repo: string, number: number) => task({ number })),
    listIssues: vi.fn(async () => [task()]),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ id: 1, url: `https://github.com/${REPO}/issues/12#issuecomment-1` })),
    pullRequestExists: vi.fn(async () => true),
    listComments: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    listOpenPullFiles: vi.fn(async () => []),
    getPullRequest: vi.fn(async (_repo: string, number: number) => pr({ number })),
    ...overrides,
  };
}

let msgCounter = 0;
function envelopeDoc(
  payload: Partial<{ intent: string; artifacts: unknown[] }> = {}, taskId = 12,
): EnvelopeDoc {
  msgCounter += 1;
  const raw = {
    sender: MINE,
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
    createdAt: "2026-10-10T10:00:00Z", body: renderEnvelopeComment(doc), envelope: doc,
    ...overrides,
  };
}

/** The per-task fake: listIssues answers the studio's board, and getIssue +
 *  listComments — the two calls board.ts's own showTask makes — are keyed on
 *  the task number, exactly like pr-landed's own per-number listComments fake. */
function tasksApi(
  tasks: BoardTaskView[],
  commentsByTask: Record<number, TaskComment[]> = {},
  overrides: Partial<BoardApi> = {},
): BoardApi {
  return fakeApi({
    listIssues: vi.fn(async () => tasks),
    getIssue: vi.fn(async (_repo: string, number: number) =>
      tasks.find((t) => t.number === number) ?? task({ number })),
    listComments: vi.fn(async (_repo: string, number: number) => commentsByTask[number] ?? []),
    ...overrides,
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe("studioOpenPrs", () => {
  it("zero tasks assigned -> ok with an empty list, and the studio's own label is the filter GitHub saw", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => []) });
    const result = await studioOpenPrs(api, REPO, MINE);
    expect(result).toEqual({ ok: true, value: [] });
    // The scan reaches for the shared listTasks helper, whose assignedTo
    // filter is a server-side LABEL filter — the studio's own label.
    expect(api.listIssues).toHaveBeenCalledWith(REPO, { labels: [studioLabel(MINE)] });
  });

  it("reports one unmerged OPEN PR with task number, PR number, title, and url", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const api = tasksApi([view({ number: 12 })], { 12: [envelopeComment(doc)] });
    const result = await studioOpenPrs(api, REPO, MINE);
    expect(result).toEqual({
      ok: true,
      value: [{ taskNumber: 12, prNumber: 9, title: "feat: the thing", url: `https://github.com/${REPO}/pull/9` }],
    });
    expect(api.getPullRequest).toHaveBeenCalledWith(REPO, 9);
  });

  it("a MERGED PR is excluded — merged is the exact thing the warning is not about", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const api = tasksApi([view({ number: 12 })], { 12: [envelopeComment(doc)] }, {
      getPullRequest: vi.fn(async () => pr({ merged: true })),
    });
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({ ok: true, value: [] });
  });

  it("a CLOSED-unmerged PR is excluded — it can never merge, so the warning would nag forever", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const api = tasksApi([view({ number: 12 })], { 12: [envelopeComment(doc)] }, {
      getPullRequest: vi.fn(async () => pr({ open: false })),
    });
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({ ok: true, value: [] });
  });

  it("a GitHub-closed AND completed task is done work — not even read: no showTask, no getPullRequest", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const api = tasksApi(
      [view({ number: 12, open: false, state: "completed", labels: ["completed", studioLabel(MINE)] })],
      { 12: [envelopeComment(doc)] },
      {
        getPullRequest: vi.fn(async () => {
          throw new Error("getPullRequest must never run for done work");
        }),
        listComments: vi.fn(async () => {
          throw new Error("showTask must never run for done work");
        }),
      },
    );
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({ ok: true, value: [] });
  });

  it("a task open on GitHub but completed on the board is still scanned — the awaiting_merge aftermath race", async () => {
    // Board #110's aftermath: the verifier completed the task while the
    // issue is still open, and the PR sits unmerged behind it — exactly the
    // PR `destroy --park`'s open-task gate waves through, because
    // awaiting_merge/completed is not "open work" to that gate.
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const api = tasksApi(
      [view({ number: 12, open: true, state: "completed", labels: ["completed", studioLabel(MINE)] })],
      { 12: [envelopeComment(doc)] },
    );
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({
      ok: true,
      value: [{ taskNumber: 12, prNumber: 9, title: "feat: the thing", url: `https://github.com/${REPO}/pull/9` }],
    });
  });

  it("a drifted task (state null, two state labels) is still scanned", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const api = tasksApi(
      [view({ number: 12, state: null, labels: ["working", "completed", studioLabel(MINE)] })],
      { 12: [envelopeComment(doc)] },
    );
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({
      ok: true,
      value: [{ taskNumber: 12, prNumber: 9, title: "feat: the thing", url: `https://github.com/${REPO}/pull/9` }],
    });
  });

  it("a zero-state-labels issue is never a fleet task — skipped without a single showTask call", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const api = tasksApi([view({ number: 12, state: null, labels: [studioLabel(MINE)] })], {
      12: [envelopeComment(doc)],
    });
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({ ok: true, value: [] });
    expect(api.listComments).not.toHaveBeenCalled();
    expect(api.getPullRequest).not.toHaveBeenCalled();
  });

  it("one task's showTask throwing degrades to nothing for THAT task — the others still reported", async () => {
    const docB = envelopeDoc({ artifacts: [{ kind: "pr", pr: "11" }] }, 13);
    const api = tasksApi([view({ number: 12 }), view({ number: 13 })], { 13: [envelopeComment(docB)] }, {
      getIssue: vi.fn(async (_repo: string, number: number) => {
        if (number === 12) throw new Error("GitHub 500");
        return task({ number: 13 });
      }),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await studioOpenPrs(api, REPO, MINE);
    expect(result).toEqual({
      ok: true,
      value: [{ taskNumber: 13, prNumber: 11, title: "feat: the thing", url: `https://github.com/${REPO}/pull/11` }],
    });
    expect(errors).toHaveBeenCalled();
  });

  it("one task's getPullRequest throwing degrades to nothing for THAT task — the others still reported", async () => {
    const docA = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const docB = envelopeDoc({ artifacts: [{ kind: "pr", pr: "11" }] }, 13);
    const api = tasksApi(
      [view({ number: 12 }), view({ number: 13 })],
      { 12: [envelopeComment(docA)], 13: [envelopeComment(docB)] },
      {
        getPullRequest: vi.fn(async (_repo: string, number: number) => {
          if (number === 9) throw new Error("GitHub 502");
          return pr({ number: 11 });
        }),
      },
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await studioOpenPrs(api, REPO, MINE);
    expect(result).toEqual({
      ok: true,
      value: [{ taskNumber: 13, prNumber: 11, title: "feat: the thing", url: `https://github.com/${REPO}/pull/11` }],
    });
    expect(errors).toHaveBeenCalled();
  });

  it("a `{ok:false}` board listing fails the WHOLE call, status and message carried verbatim", async () => {
    // See the file header: `{assignedTo}`-only listTasks calls cannot reach
    // listTasks' own refusal legs through the port, so the propagation
    // contract is driven through board.ts's public export — the collaborator
    // seam, same as read-repos' authModule spy. The assertion is the whole
    // point: a board read that failed must reach the caller AS a failure,
    // never collapse into "confirmed zero unmerged PRs".
    const bad = { ok: false as const, status: 502, message: "board upstream failed" };
    const api = fakeApi({
      listIssues: vi.fn(async () => {
        throw new Error("listIssues must not run once listTasks answers {ok:false}");
      }),
    });
    vi.spyOn(boardModule, "listTasks").mockResolvedValue(bad);
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual(bad);
    expect(api.getPullRequest).not.toHaveBeenCalled();
  });

  it("a THROWN board listing also fails the whole call — never degrades into an empty ok", async () => {
    const api = fakeApi({ listIssues: vi.fn(async () => { throw new Error("GitHub 503"); }) });
    await expect(studioOpenPrs(api, REPO, MINE)).rejects.toThrow("GitHub 503");
    expect(api.getPullRequest).not.toHaveBeenCalled();
  });

  it("an envelope whose pr artifact is `#12` (hash-prefixed) parses to PR 12", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "#12" }] }, 12);
    const api = tasksApi([view({ number: 12 })], { 12: [envelopeComment(doc)] });
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({
      ok: true,
      value: [{ taskNumber: 12, prNumber: 12, title: "feat: the thing", url: `https://github.com/${REPO}/pull/12` }],
    });
  });

  it("a malformed pr artifact (`not-a-pr`) contributes nothing — no getPullRequest call at all", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "pr", pr: "not-a-pr" }] }, 12);
    const api = tasksApi([view({ number: 12 })], { 12: [envelopeComment(doc)] });
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({ ok: true, value: [] });
    expect(api.getPullRequest).not.toHaveBeenCalled();
  });

  it("a task with no result envelope at all contributes nothing", async () => {
    const api = tasksApi([view({ number: 12 })], { 12: [] });
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({ ok: true, value: [] });
  });

  it("an envelope with no pr artifact contributes nothing", async () => {
    const doc = envelopeDoc({ artifacts: [{ kind: "code", path: "src/x.ts" }] }, 12);
    const api = tasksApi([view({ number: 12 })], { 12: [envelopeComment(doc)] });
    expect(await studioOpenPrs(api, REPO, MINE)).toEqual({ ok: true, value: [] });
    expect(api.getPullRequest).not.toHaveBeenCalled();
  });

  it("the NEWEST result envelope decides — a later human comment never shadows it", async () => {
    const old = envelopeDoc({ artifacts: [{ kind: "pr", pr: "8" }] }, 12);
    const newest = envelopeDoc({ artifacts: [{ kind: "pr", pr: "9" }] }, 12);
    const api = tasksApi([view({ number: 12 })], {
      12: [
        envelopeComment(old),
        { id: 2, url: "u2", author: "rafarc21", createdAt: "2026-10-10T11:00:00Z", body: "nice work", envelope: null },
        envelopeComment(newest),
      ],
    });
    const result = await studioOpenPrs(api, REPO, MINE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((p) => p.prNumber)).toEqual([9]);
  });
});
