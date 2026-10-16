import { describe, it, expect, vi } from "vitest";
import { sendTaskMessage, taskMessageDigest, taskMessageComment, MESSAGE_COMMENT_MARKER } from "../src/board/task-message";
import type { AssignWakeDeps } from "../src/board/assign-wake";
import { fakeApi, task } from "./helpers/board-api";
import { GitHubError } from "../src/board/api";
import { studioLabel } from "../src/board/types";
import { qualifiesForCommentWake } from "../src/board/comment-wake";

// Board issue #1071, item 4: `fleet task message <n> "<text>"` posts a board
// comment on task n AND wakes the task's studio lead with the text, replacing
// unreliable terminal sends. Pure over the BoardApi port and the wake port.

const WEB = "websites--web-studio";
const REPO = "acme/websites";
const SENDER = "websites--maestro";

function deps(overrides: Partial<AssignWakeDeps> = {}): AssignWakeDeps {
  return {
    studioState: vi.fn(async () => ({ state: "running", repoSlug: null })),
    wake: vi.fn(async () => ({ ok: true })),
    resolveCanonicalRepo: vi.fn(async (slug: string) => slug),
    ...overrides,
  };
}

const assigned = (state: string | null = "working", overrides: Partial<ReturnType<typeof task>> = {}) =>
  task({
    number: 12,
    state: state as ReturnType<typeof task>["state"],
    labels: [...(state ? [state] : []), studioLabel(WEB)],
    assignee: WEB,
    ...overrides,
  });

describe("sendTaskMessage — comment on the task and wake its lead", () => {
  it("posts ONE comment carrying the marker, the sender and the text, then wakes the assignee", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => assigned("working")) });
    const d = deps();
    const res = await sendTaskMessage(api, d, REPO, 12, { text: "rebase on main first" }, SENDER);

    expect(res.ok).toBe(true);
    expect(api.createComment).toHaveBeenCalledTimes(1);
    const body = vi.mocked(api.createComment).mock.calls[0][2];
    expect(body.split("\n")[0]).toBe(MESSAGE_COMMENT_MARKER);
    expect(body).toContain(SENDER);
    expect(body).toContain("rebase on main first");

    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.wake).mock.calls[0][0]).toBe(WEB);
    expect(vi.mocked(d.wake).mock.calls[0][1]).toBe(taskMessageDigest({ number: 12, title: "Some task" }, "rebase on main first"));
    if (res.ok) expect(res.value.wake).toEqual({ woke: true, digest: taskMessageDigest({ number: 12, title: "Some task" }, "rebase on main first") });
  });

  it("the wake digest is a POINTER with the text inline — one line, and it names how to read the task", () => {
    const digest = taskMessageDigest({ number: 12, title: "Some task" }, "line one\nline two");
    expect(digest).not.toMatch(/[\r\n]/);
    expect(digest).toContain("#12");
    expect(digest).toContain("line one line two");
    expect(digest).toContain("fleet task show 12");
  });

  it("refuses an empty or non-string text as a 400 — before any comment or wake", async () => {
    for (const text of ["", "   ", 42, undefined]) {
      const api = fakeApi({ getIssue: vi.fn(async () => assigned()) });
      const d = deps();
      const res = await sendTaskMessage(api, d, REPO, 12, { text }, SENDER);
      expect(res).toMatchObject({ ok: false, status: 400 });
      expect(api.createComment).not.toHaveBeenCalled();
      expect(d.wake).not.toHaveBeenCalled();
    }
  });

  it("refuses text over 4000 characters as a 400", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => assigned()) });
    const res = await sendTaskMessage(api, deps(), REPO, 12, { text: "x".repeat(4001) }, SENDER);
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("refuses a CLOSED task as a 409 — finished work gets no message and no wake", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => assigned("working", { open: false })) });
    const d = deps();
    const res = await sendTaskMessage(api, d, REPO, 12, { text: "hi" }, SENDER);
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(api.createComment).not.toHaveBeenCalled();
    expect(d.wake).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "canceled"])("refuses a %s task as a 409 — terminal work is not messaged", async (state) => {
    const api = fakeApi({ getIssue: vi.fn(async () => assigned(state)) });
    const d = deps();
    const res = await sendTaskMessage(api, d, REPO, 12, { text: "hi" }, SENDER);
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(api.createComment).not.toHaveBeenCalled();
    expect(d.wake).not.toHaveBeenCalled();
  });

  it("an awaiting_merge task IS messaged — a reviewer's note for an open PR is an explicit ask", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => assigned("awaiting_merge")) });
    const d = deps();
    const res = await sendTaskMessage(api, d, REPO, 12, { text: "review is in" }, SENDER);
    expect(res.ok).toBe(true);
    expect(d.wake).toHaveBeenCalledTimes(1);
  });

  // Board issue #1106: an unknown number answers in words that name the task.
  it("answers an unknown task as a 404 naming the task — nothing posted, nothing woken", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => { throw new GitHubError(404, "GET /repos/acme/websites/issues/12 failed (404): Not Found"); }),
    });
    const d = deps();
    const res = await sendTaskMessage(api, d, REPO, 12, { text: "hi" }, SENDER);
    expect(res).toEqual({ ok: false, status: 404, message: "task #12 not found in acme/websites — nothing to message" });
    expect(api.createComment).not.toHaveBeenCalled();
    expect(d.wake).not.toHaveBeenCalled();
  });

  it("refuses an unassigned task as a 409 — there is no single lead to wake", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ number: 12, state: "working", labels: ["working"], assignee: null })),
    });
    const res = await sendTaskMessage(api, deps(), REPO, 12, { text: "hi" }, SENDER);
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("refuses a task with two studio labels as a 409 — ambiguous assignee, guessing wakes the wrong studio", async () => {
    const api = fakeApi({
      getIssue: vi.fn(async () => assigned("working", { labels: ["working", studioLabel(WEB), studioLabel("websites--pilot")] })),
    });
    const res = await sendTaskMessage(api, deps(), REPO, 12, { text: "hi" }, SENDER);
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("a STOPPED assignee still gets the comment; the wake is reported refused, not silently dropped", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => assigned("working")) });
    const d = deps({ studioState: vi.fn(async () => ({ state: "stopped", repoSlug: null })) });
    const res = await sendTaskMessage(api, d, REPO, 12, { text: "hi" }, SENDER);
    expect(res.ok).toBe(true);
    expect(api.createComment).toHaveBeenCalledTimes(1);
    expect(d.wake).not.toHaveBeenCalled();
    if (res.ok) expect(res.value.wake.woke).toBe(false);
  });
});

describe("the message comment is never a second wake", () => {
  it("qualifiesForCommentWake refuses a message comment even on an input_required task — the explicit wake already happened", () => {
    const body = taskMessageComment(SENDER, "answer: yes");
    expect(qualifiesForCommentWake("input_required", body, "example-human")).toBe(false);
  });

  it("…and even when the text itself opens with /wake — the marker line still excludes it", () => {
    const body = taskMessageComment(SENDER, "/wake");
    expect(qualifiesForCommentWake("input_required", body, "example-human")).toBe(false);
  });
});
