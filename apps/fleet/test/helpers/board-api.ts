import { vi } from "vitest";
import { renderEnvelopeComment } from "../../src/board/envelope";
import type { BoardApi, TaskComment } from "../../src/board/board";
import type { BoardTask, EnvelopeDoc } from "../../src/board/types";

// Sweep 18, F6+F7 (refs #537 / board #595): the BoardApi fake, the BoardTask
// builder, and the envelope-comment builder the board suites each hand-copied.
// Defaults are the census defaults (issue 12, listMilestones [], state
// "submitted"); a caller whose old local builder differed keeps a one-line
// thin wrapper over the shared builder spelling its own fixture values as
// explicit overrides — never a silent default change. CLAUDE-ONLY files
// (board.routes, board.fleet-routes, board.read-repos) keep their local copies.

/** The 9-field BoardTask literal. Divergent per-file fixtures (number 71/109,
 *  "working" state, REPO-based urls) are thin-wrapper overrides, not defaults. */
export function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/o/r/issues/12", title: "Some task",
    body: "## Objective\n\nShip it.\n", state: "submitted", labels: ["submitted"],
    assignee: null, milestone: null, open: true, updatedAt: "2026-08-25T10:00:00Z", ...overrides,
  };
}

/** The 15-port BoardApi fake. Default issue number 12; a file whose old copy
 *  keyed another number (71, 109, a REPO-based url) overrides the port itself.
 *  buildTask lets a file with divergent task defaults swap the task the three
 *  issue-returning ports hand back, without re-keying each port by hand. */
export function fakeApi(overrides: Partial<BoardApi> = {}, buildTask: () => BoardTask = task): BoardApi {
  return {
    createIssue: vi.fn(async () => buildTask()),
    getIssue: vi.fn(async () => buildTask()),
    listIssues: vi.fn(async () => [buildTask()]),
    countIssues: vi.fn(async () => 0),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ id: 1, url: "https://github.com/o/r/issues/12#issuecomment-1" })),
    pullRequestExists: vi.fn(async () => true),
    listComments: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    listOpenPullFiles: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ number: 0, merged: false, open: true, title: "" })),
    ...overrides,
  };
}

// The shared counter is for comment id/url uniqueness ONLY: each file's own
// envelopeDoc keeps its own msg-id counter, and no test asserts a comment id.
let commentCounter = 0;

/** The §6 envelope-carrying TaskComment. envelopeDoc itself stays local per
 *  file (genuinely divergent fixture semantics, census F7). */
export function envelopeComment(doc: EnvelopeDoc, overrides: Partial<TaskComment> = {}): TaskComment {
  commentCounter += 1;
  return {
    id: commentCounter, url: `u${commentCounter}`, author: "example-bot[bot]",
    createdAt: "2026-09-08T10:00:00Z", body: renderEnvelopeComment(doc), envelope: doc,
    ...overrides,
  };
}

/** The shared createTask brief both board suites hand to nearly every
 *  createTask test. Issue #112: no "/" in boundaries on purpose —
 *  extractPaths (board issue #112 / #70 ask 8) would otherwise read
 *  "open/close" as a path claim and trigger pathClaimWarnings network
 *  calls these tests never intend to exercise. The dedicated
 *  "createTask — path overlap warning" describe block in
 *  board.create.test.ts exercises that path with its own overlap brief. */
export const defaultBrief = {
  title: "Build the task board",
  objective: "Worker-side board module.",
  outputFormat: "A PR.",
  boundaries: "No sprint open or close.",
};
