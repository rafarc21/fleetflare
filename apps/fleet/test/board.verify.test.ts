import { describe, it, expect, vi } from "vitest";
import {
  attemptVerification, findLatestResultEnvelope, extractRefCandidates, renderVerifyComment,
  parseGithubUrl,
  type VerifyFetch,
} from "../src/board/verify";
import { parseEnvelope, renderEnvelopeComment } from "../src/board/envelope";
import type { BoardApi, TaskComment } from "../src/board/board";
import type { BoardTask, EnvelopeDoc } from "../src/board/types";

// Same fake-BoardApi conventions as test/board.board.test.ts: every GitHub
// call is a vi.fn, so every assertion below is about what verify.ts DID,
// never about a live issue.

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 109, url: "https://github.com/o/r/issues/109", title: "Fleet Check task",
    body: "## Objective\n\nShip it.\n", state: "working", labels: ["working"],
    assignee: null, milestone: null, open: true, updatedAt: "2026-09-08T10:00:00Z", ...overrides,
  };
}

function fakeApi(overrides: Partial<BoardApi> = {}): BoardApi {
  return {
    createIssue: vi.fn(async () => task()),
    getIssue: vi.fn(async () => task()),
    listIssues: vi.fn(async () => [task()]),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ id: 1, url: "https://github.com/o/r/issues/109#issuecomment-1" })),
    pullRequestExists: vi.fn(async () => true),
    listComments: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    ...overrides,
  };
}

let msgCounter = 0;
function envelopeDoc(
  payload: Partial<{ intent: string; verification: unknown }> = {}, taskId = 109,
): EnvelopeDoc {
  msgCounter += 1;
  const raw = {
    sender: "websites--release-studio",
    intent: payload.intent ?? "result",
    status: "ok",
    ...(payload.verification !== undefined ? { verification: payload.verification } : {
      verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
    }),
  };
  const parsed = parseEnvelope(raw, taskId, `msg-${msgCounter}`);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.doc;
}

function envelopeComment(doc: EnvelopeDoc, overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: msgCounter, url: `u${msgCounter}`, author: "example-bot[bot]",
    createdAt: "2026-09-08T10:00:00Z", body: renderEnvelopeComment(doc), envelope: doc,
    ...overrides,
  };
}

const okFetch: VerifyFetch = async () => ({ status: 200 });

describe("findLatestResultEnvelope", () => {
  it("picks the LAST result-intent envelope, not just the last comment", () => {
    const first = envelopeDoc();
    const clarify = envelopeDoc({ intent: "clarify" });
    const last = envelopeDoc();
    const comments: TaskComment[] = [
      envelopeComment(first),
      envelopeComment(clarify),
      envelopeComment(last),
      { id: 999, url: "u999", author: "rafarc21", createdAt: "t", body: "looks good", envelope: null },
    ];
    const found = findLatestResultEnvelope(comments);
    expect(found?.envelope.msg_id).toBe(last.envelope.msg_id);
  });

  it("returns null when no comment carries a result envelope", () => {
    const comments: TaskComment[] = [
      { id: 1, url: "u1", author: "rafarc21", createdAt: "t", body: "hi", envelope: null },
      envelopeComment(envelopeDoc({ intent: "clarify" })),
    ];
    expect(findLatestResultEnvelope(comments)).toBeNull();
  });
});

describe("extractRefCandidates", () => {
  it("finds a PR from #123 and from pull/123", () => {
    expect(extractRefCandidates("see #42 for details")).toEqual([{ kind: "pr", value: "42" }]);
    expect(extractRefCandidates("open pull/7 to review")).toEqual([{ kind: "pr", value: "7" }]);
  });

  it("finds a branch after the keyword `branch`", () => {
    expect(extractRefCandidates("Actions tab -> Fleet Check -> Run workflow, against branch ci/fleet-check-workflow"))
      .toEqual([{ kind: "branch", value: "ci/fleet-check-workflow" }]);
  });

  it("finds a standalone commit sha (7-40 hex chars, at least one letter)", () => {
    expect(extractRefCandidates("deployed at commit 3f9a2c1")).toEqual([{ kind: "commit", value: "3f9a2c1" }]);
  });

  it("does not mistake a plain decimal number for a commit sha", () => {
    // All-digit words are excluded deliberately: a false "not-checkable" is
    // safe, a false ref match is not, and a pure decimal number is far more
    // likely to be a date, a count, or an issue number typed without `#`.
    expect(extractRefCandidates("landed on 20260908 at 1234567")).toEqual([]);
  });

  it("plain prose with no ref keyword at all extracts nothing", () => {
    expect(extractRefCandidates("Open the dashboard and confirm the banner reads green")).toEqual([]);
  });
});

// Task #126: the pure parser that lets src/board/routes.ts's realVerifyFetch
// tell a recognized github.com url shape apart from everything else, with no
// token/fetch/network needed to prove it — see src/board/verify.ts's own doc
// comment on parseGithubUrl for the fallback rule these tests pin.
describe("parseGithubUrl", () => {
  it("parses a commit url", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/commit/1e3a9d76abc"))
      .toEqual({ kind: "commit", repo: "acme-org/websites", sha: "1e3a9d76abc" });
  });

  it("parses a pull request url", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/pull/123"))
      .toEqual({ kind: "pr", repo: "acme-org/websites", number: 123 });
  });

  it("parses an issue url", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/issues/42"))
      .toEqual({ kind: "issue", repo: "acme-org/websites", number: 42 });
  });

  it("parses a pull request url with a trailing tab segment (e.g. the Files changed tab), ignoring it", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/pull/123/files"))
      .toEqual({ kind: "pr", repo: "acme-org/websites", number: 123 });
  });

  it("parses an issue url with a trailing segment (e.g. /comments), ignoring it", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/issues/42/comments"))
      .toEqual({ kind: "issue", repo: "acme-org/websites", number: 42 });
  });

  it("parses a blob (file) url as a path check", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/blob/main/apps/fleet/src/board/verify.ts"))
      .toEqual({ kind: "path", repo: "acme-org/websites", ref: "main", path: "apps/fleet/src/board/verify.ts" });
  });

  it("parses a tree url WITH a path (a directory) as a path check", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/tree/main/apps/fleet"))
      .toEqual({ kind: "path", repo: "acme-org/websites", ref: "main", path: "apps/fleet" });
  });

  it("parses a tree url with NO path as the branch itself", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/tree/release-109"))
      .toEqual({ kind: "branch", repo: "acme-org/websites", branch: "release-109" });
  });

  it("parses a compare url, base and head split on the literal `...`", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites/compare/main...feature/x"))
      .toEqual({ kind: "compare", repo: "acme-org/websites", base: "main", head: "feature/x" });
  });

  it("lowercases owner/repo, matching this codebase's repo-slug convention", () => {
    expect(parseGithubUrl("https://github.com/Acme-Org/Websites/pull/1"))
      .toEqual({ kind: "pr", repo: "acme-org/websites", number: 1 });
  });

  it("falls back to null on a github.com url it does not recognize (repo root, settings, actions) — the plain-fetch fallback rule", () => {
    expect(parseGithubUrl("https://github.com/acme-org/websites")).toBeNull();
    expect(parseGithubUrl("https://github.com/acme-org/websites/settings")).toBeNull();
    expect(parseGithubUrl("https://github.com/acme-org/websites/actions/runs/123")).toBeNull();
  });

  it("returns null for a non-github.com host entirely", () => {
    expect(parseGithubUrl("https://example.com/acme-org/websites/commit/abc")).toBeNull();
  });
});

describe("renderVerifyComment", () => {
  it("renders one line per check with the right icon per verdict", () => {
    const body = renderVerifyComment(109, "msg-1", { label: "https://x.test", verdict: "attempted-ok", detail: "HTTP 200" }, [
      { label: "step a", verdict: "attempted-failed", detail: "branch nope does not exist" },
      { label: "step b", verdict: "not-mechanically-checkable", detail: "no ref found" },
    ]);
    expect(body).toContain("#109");
    expect(body).toContain("msg-1");
    expect(body).toContain("✅");
    expect(body).toContain("attempted-ok");
    expect(body).toContain("❌");
    expect(body).toContain("attempted-FAILED");
    expect(body).toContain("branch nope does not exist");
    expect(body).toContain("➖");
    expect(body).toContain("not-mechanically-checkable");
  });
});

describe("attemptVerification", () => {
  it("classifies a 404'ing url as attempted-failed, and still evaluates the other steps", async () => {
    const doc = envelopeDoc({
      verification: { url: "https://x.test/404", steps: ["branch ci/fleet-check-workflow exists", "open the dashboard"], expected: "works" },
    });
    const api = fakeApi({ listComments: vi.fn(async () => [envelopeComment(doc)]) });
    const fetchUrl: VerifyFetch = async () => ({ status: 404 });

    const res = await attemptVerification(api, fetchUrl, "o/r", 109);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [urlResult, step1, step2] = res.value.results;
    expect(urlResult.verdict).toBe("attempted-failed");
    expect(urlResult.detail).toContain("404");
    // the other steps are still evaluated, not short-circuited
    expect(step1.verdict).toBe("attempted-ok");
    expect(step2.verdict).toBe("not-mechanically-checkable");
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  it("a step naming an existing branch/PR/commit classifies attempted-ok", async () => {
    const doc = envelopeDoc({
      verification: { url: "https://x.test", steps: ["merge PR #42", "branch release/109 is deployed", "commit 3f9a2c1 is live"], expected: "works" },
    });
    const api = fakeApi({
      listComments: vi.fn(async () => [envelopeComment(doc)]),
      pullRequestExists: vi.fn(async () => true),
      branchExists: vi.fn(async () => true),
      commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    });
    const res = await attemptVerification(api, okFetch, "o/r", 109);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, ...stepResults] = res.value.results;
    expect(stepResults.every((r) => r.verdict === "attempted-ok")).toBe(true);
    expect(api.pullRequestExists).toHaveBeenCalledWith("o/r", 42);
    expect(api.branchExists).toHaveBeenCalledWith("o/r", "release/109");
    expect(api.commitExists).toHaveBeenCalledWith("o/r", "3f9a2c1");
  });

  it("a step naming a branch that does NOT exist classifies attempted-failed, naming it", async () => {
    const doc = envelopeDoc({
      verification: { url: "https://x.test", steps: ["against branch ci/fleet-check-workflow"], expected: "works" },
    });
    const api = fakeApi({
      listComments: vi.fn(async () => [envelopeComment(doc)]),
      branchExists: vi.fn(async () => false),
    });
    const res = await attemptVerification(api, okFetch, "o/r", 109);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, stepResult] = res.value.results;
    expect(stepResult.verdict).toBe("attempted-failed");
    expect(stepResult.detail).toContain("ci/fleet-check-workflow");
  });

  it("a step with no extractable ref is not-mechanically-checkable", async () => {
    const doc = envelopeDoc({
      verification: { url: "https://x.test", steps: ["Open the dashboard and confirm the banner reads green"], expected: "works" },
    });
    const api = fakeApi({ listComments: vi.fn(async () => [envelopeComment(doc)]) });
    const res = await attemptVerification(api, okFetch, "o/r", 109);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, stepResult] = res.value.results;
    expect(stepResult.verdict).toBe("not-mechanically-checkable");
  });

  it("404s and posts NOTHING when the task has no result envelope at all", async () => {
    const api = fakeApi({
      listComments: vi.fn(async () => [
        { id: 1, url: "u1", author: "rafarc21", createdAt: "t", body: "just a human comment", envelope: null },
      ]),
    });
    const res = await attemptVerification(api, okFetch, "o/r", 109);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("multiple envelopes: only the LAST result-intent one is checked", async () => {
    const stale = envelopeDoc({ verification: { url: "https://stale.test", steps: ["stale step"], expected: "e" } });
    const clarify = envelopeDoc({ intent: "clarify" });
    const fresh = envelopeDoc({ verification: { url: "https://fresh.test", steps: ["fresh step"], expected: "e" } });
    const api = fakeApi({
      listComments: vi.fn(async () => [
        envelopeComment(stale),
        envelopeComment(clarify),
        envelopeComment(fresh),
        { id: 999, url: "u999", author: "rafarc21", createdAt: "t", body: "plain human comment after", envelope: null },
      ]),
    });
    const fetchUrl = vi.fn(async () => ({ status: 200 }));
    const res = await attemptVerification(api, fetchUrl, "o/r", 109);
    expect(res.ok).toBe(true);
    expect(fetchUrl).toHaveBeenCalledWith("https://fresh.test");
    const body = vi.mocked(api.createComment).mock.calls[0][2];
    expect(body).toContain(fresh.envelope.msg_id);
    expect(body).not.toContain(stale.envelope.msg_id);
  });
});
