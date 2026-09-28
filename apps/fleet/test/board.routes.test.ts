import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { RepoReach } from "../src/github/reach";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleBoard, githubAwareVerifyFetch, openTaskChecker, type GithubUrlExistenceChecks, type ReapPort, type RescueGcPort } from "../src/board/routes";
import type { VerifyFetch } from "../src/board/verify";
import { parseEnvelope, renderEnvelopeComment } from "../src/board/envelope";
import { GitHubError } from "../src/board/api";
import type { BoardApi } from "../src/board/board";
import type { BoardTask } from "../src/board/types";
import type { Env } from "../src/env";
import { isJuniorAuthorized, recordJuniorAuthorization } from "../src/junior/authz";

// PR #9 review, blocker B1: fleet_state is not isolated per test (same as
// agents.do.test.ts's own identical beforeEach) — the junior-authorization
// tests below write real D1 rows that must not leak across tests.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

// Same wiring as test/studio.routes.test.ts: real verifyAccess for the
// unauthenticated cases, spied away for the rest, and every GitHub call
// behind an injected port so no test needs a live issue.

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/o/r/issues/12", title: "Build the task board",
    body: "## Objective\n\nShip it.\n", state: "submitted", labels: ["submitted"],
    assignee: null, milestone: null, open: true, updatedAt: "2026-08-25T10:00:00Z", ...overrides,
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
    listMilestones: vi.fn(async () => [{ number: 3, title: "Sprint 1" }]),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    ...overrides,
  };
}

const testEnv = { ...env, AGENT_REPO: "acme-org/websites" } as unknown as Env;
/** The P6a reachability seam handleBoard takes as its 4th argument — a live
 *  GitHub call in production, with no test double. */
const reach = async (slug: string): Promise<RepoReach> =>
  ["acme-org/websites", "acme-org/beta"].includes(slug.toLowerCase())
    ? { reachable: true }
    : { reachable: false, remedy: "is not reachable by this fleet" };

function authorized() {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

const brief = {
  title: "Build the task board", objective: "A board module.",
  outputFormat: "A PR.", boundaries: "No sprint close.",
};

afterEach(() => { vi.restoreAllMocks(); });

describe("handleBoard", () => {
  it("401s without an Access header — the board is behind the same gate every studio route is", async () => {
    const res = await handleBoard(new Request("https://x/studio/board/tasks"), testEnv, fakeApi(), reach);
    expect(res.status).toBe(401);
  });

  it("404s an unknown board path and 405s a wrong verb", async () => {
    authorized();
    expect((await handleBoard(req("/studio/board/nonsense"), testEnv, fakeApi(), reach)).status).toBe(404);
    expect((await handleBoard(req("/studio/board/tasks/12", { method: "DELETE" }), testEnv, fakeApi(), reach)).status)
      .toBe(405);
  });

  it("POST /tasks creates on the fleet's default repo when the caller names none", async () => {
    authorized();
    const api = fakeApi();
    const res = await handleBoard(req("/studio/board/tasks", { method: "POST", body: JSON.stringify(brief) }), testEnv, api, reach);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(task());
    expect(vi.mocked(api.createIssue).mock.calls[0][0]).toBe("acme-org/websites");
  });

  it("POST /tasks honours a caller's repo — the board is the repo being worked", async () => {
    authorized();
    const api = fakeApi();
    await handleBoard(
      req("/studio/board/tasks", { method: "POST", body: JSON.stringify({ ...brief, repo: "acme-org/beta" }) }),
      testEnv, api, reach,
    );
    expect(vi.mocked(api.createIssue).mock.calls[0][0]).toBe("acme-org/beta");
  });

  it("refuses a repo the installation cannot reach, before any board call", async () => {
    authorized();
    const api = fakeApi();
    const res = await handleBoard(
      req("/studio/board/tasks", { method: "POST", body: JSON.stringify({ ...brief, repo: "someone/else" }) }),
      testEnv, api, reach,
    );
    expect(res.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("surfaces a bad brief as 400 with the reason in the body", async () => {
    authorized();
    const res = await handleBoard(
      req("/studio/board/tasks", { method: "POST", body: JSON.stringify({ title: "t" }) }), testEnv, fakeApi(), reach,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("objective");
  });

  // PR #142 review: `return withAssignWake(...)` inside the try, un-awaited,
  // let a GitHub throw escape the catch — a Worker exception (edge 500)
  // instead of the route's own 502.
  it("POST /tasks answers 502 when GitHub fails the create — never an escaped throw", async () => {
    authorized();
    const api = fakeApi({
      createIssue: vi.fn(async () => { throw new GitHubError(520, "POST /repos/x/issues failed (520)"); }),
      listIssues: vi.fn(async () => []),
    });
    const res = await handleBoard(
      req("/studio/board/tasks", { method: "POST", body: JSON.stringify({ ...brief, idempotencyKey: "k-0123456789abcdef" }) }),
      testEnv, api, reach,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("board upstream failed");
  });

  // PR #9 review, blocker B1: the write half of the real fix — a task filed
  // with `junior: true` and a real assignee must leave behind the D1 record
  // src/junior/authz.ts's isJuniorAuthorized reads, written from exactly this
  // route (see recordJuniorAuthorizationIfNeeded's own doc comment for why
  // nowhere else may).
  describe("POST /tasks — junior authorization record (B1)", () => {
    it("records D1 authorization for the created task's assignee when the brief asks for junior", async () => {
      authorized();
      const created = task({ number: 55, labels: ["submitted", "studio:acme--web-studio", "junior"], assignee: "acme--web-studio" });
      const api = fakeApi({ createIssue: vi.fn(async () => created) });
      const res = await handleBoard(
        req("/studio/board/tasks", {
          method: "POST",
          body: JSON.stringify({ ...brief, assignee: "acme--web-studio", junior: true }),
        }),
        testEnv, api, reach,
      );
      expect(res.status).toBe(200);
      expect(await isJuniorAuthorized(env.DB, "acme-org/websites", 55, "acme--web-studio")).toBe(true);
      // Never for a DIFFERENT studio than the one actually assigned.
      expect(await isJuniorAuthorized(env.DB, "acme-org/websites", 55, "acme--release-studio")).toBe(false);
    });

    it("does not record anything when the brief does not ask for junior", async () => {
      authorized();
      const created = task({ number: 56, labels: ["submitted", "studio:acme--web-studio"], assignee: "acme--web-studio" });
      const api = fakeApi({ createIssue: vi.fn(async () => created) });
      await handleBoard(
        req("/studio/board/tasks", { method: "POST", body: JSON.stringify({ ...brief, assignee: "acme--web-studio" }) }),
        testEnv, api, reach,
      );
      expect(await isJuniorAuthorized(env.DB, "acme-org/websites", 56, "acme--web-studio")).toBe(false);
    });

    it("does not authorize anyone for an unassigned junior-flagged task — there is no studio to authorize", async () => {
      authorized();
      const created = task({ number: 57, labels: ["submitted", "junior"], assignee: null });
      const api = fakeApi({ createIssue: vi.fn(async () => created) });
      const res = await handleBoard(
        req("/studio/board/tasks", { method: "POST", body: JSON.stringify({ ...brief, junior: true }) }),
        testEnv, api, reach,
      );
      expect(res.status).toBe(200);
      // Nothing to assert isJuniorAuthorized against directly (no studio id),
      // so this proves the negative the only way possible: the create still
      // succeeds and nothing throws attempting to record an authorization
      // with no assignee.
      expect(await res.json()).toMatchObject({ number: 57 });
    });
  });

  it("POST /tasks/:n/assign answers 502 when GitHub fails — never an escaped throw", async () => {
    authorized();
    const api = fakeApi({ getIssue: vi.fn(async () => { throw new GitHubError(500, "GET failed (500)"); }) });
    const res = await handleBoard(
      req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: "websites--web-studio" }) }),
      testEnv, api, reach,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("board upstream failed");
  });

  it("GET /tasks lists, passing milestone and state through from the query string", async () => {
    authorized();
    const api = fakeApi({ listIssues: vi.fn(async () => []) });
    const res = await handleBoard(
      req("/studio/board/tasks?milestone=Sprint%201&state=working"), testEnv, api, reach,
    );
    expect(res.status).toBe(200);
    expect(api.listIssues).toHaveBeenCalledWith("acme-org/websites", { milestone: 3, labels: ["working"] });
  });

  it("GET /tasks/:n shows one task with its comments", async () => {
    authorized();
    const api = fakeApi({
      listComments: vi.fn(async () => [
        { id: 1, url: "u1", author: "rafarc21", createdAt: "t1", body: "looks good" },
      ]),
    });
    const res = await handleBoard(req("/studio/board/tasks/12"), testEnv, api, reach);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: BoardTask; comments: unknown[] };
    expect(body.task.number).toBe(12);
    expect(body.comments).toHaveLength(1);
  });

  it("POST /tasks/:n/state transitions and returns the moved task", async () => {
    authorized();
    const api = fakeApi();
    const res = await handleBoard(
      req("/studio/board/tasks/12/state", { method: "POST", body: JSON.stringify({ from: "submitted", to: "working" }) }),
      testEnv, api, reach,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as BoardTask).state).toBe("working");
    expect(api.removeLabel).toHaveBeenCalledWith("acme-org/websites", 12, "submitted");
  });

  // Issue #10: a terminal state ends the task the maestro authorized. The
  // record goes with it, so no later move back to a live state (a relabel,
  // a reopen) brings junior access back.
  it("#10: POST /tasks/:n/state to a terminal state revokes the junior record", async () => {
    authorized();
    await recordJuniorAuthorization(testEnv.DB, "acme-org/websites", 12, "acme--web-studio", 1000);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })) });
    const res = await handleBoard(
      req("/studio/board/tasks/12/state", { method: "POST", body: JSON.stringify({ from: "working", to: "canceled" }) }),
      testEnv, api, reach,
    );
    expect(res.status).toBe(200);
    expect(await isJuniorAuthorized(testEnv.DB, "acme-org/websites", 12, "acme--web-studio")).toBe(false);
  });

  it("#10: a live-to-live transition keeps the junior record", async () => {
    authorized();
    await recordJuniorAuthorization(testEnv.DB, "acme-org/websites", 12, "acme--web-studio", 1000);
    const res = await handleBoard(
      req("/studio/board/tasks/12/state", { method: "POST", body: JSON.stringify({ from: "submitted", to: "working" }) }),
      testEnv, fakeApi(), reach,
    );
    expect(res.status).toBe(200);
    expect(await isJuniorAuthorized(testEnv.DB, "acme-org/websites", 12, "acme--web-studio")).toBe(true);
  });

  it("409s a transition the Worker did not initiate", async () => {
    authorized();
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working"] })) });
    const res = await handleBoard(
      req("/studio/board/tasks/12/state", { method: "POST", body: JSON.stringify({ from: "submitted", to: "completed" }) }),
      testEnv, api, reach,
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("single writer");
  });

  it("POST /tasks/:n/envelope comments and returns the comment url and the stamped struct", async () => {
    authorized();
    const api = fakeApi();
    const res = await handleBoard(
      req("/studio/board/tasks/12/envelope", {
        method: "POST",
        body: JSON.stringify({
          sender: "websites--web-studio", intent: "result", status: "ok", notes: "done",
          verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
        }),
      }),
      testEnv, api, reach,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; envelope: { envelope: { msg_id: string; task_id: number } } };
    expect(body.url).toContain("issuecomment-1");
    expect(body.envelope.envelope.task_id).toBe(12);
    // Minted per comment by the Worker, never taken from the caller.
    expect(body.envelope.envelope.msg_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps a GitHub 404 to a 404, not a generic upstream failure", async () => {
    authorized();
    const api = fakeApi({
      getIssue: vi.fn(async () => { throw new GitHubError(404, "GET /repos/o/r/issues/999 failed (404): Not Found"); }),
    });
    const res = await handleBoard(req("/studio/board/tasks/999"), testEnv, api, reach);
    expect(res.status).toBe(404);
  });

  it("maps any other GitHub failure to 502 — the caller's request was fine, ours was not", async () => {
    authorized();
    const api = fakeApi({
      listIssues: vi.fn(async () => { throw new GitHubError(500, "GET /repos/o/r/issues failed (500): boom"); }),
    });
    const res = await handleBoard(req("/studio/board/tasks"), testEnv, api, reach);
    expect(res.status).toBe(502);
  });

  it("refuses a task number that is not a number at all", async () => {
    authorized();
    const res = await handleBoard(req("/studio/board/tasks/abc"), testEnv, fakeApi(), reach);
    expect(res.status).toBe(404);
  });

  it("POST /tasks/:n/adopt stamps the studio label and the entry state (P5 §3)", async () => {
    authorized();
    const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
    const res = await handleBoard(
      req("/studio/board/tasks/42/adopt", {
        method: "POST", body: JSON.stringify({ assignee: "websites--web-studio" }),
      }), testEnv, api, reach,
    );

    expect(res.status).toBe(200);
    expect(api.addLabels).toHaveBeenCalledWith(
      "acme-org/websites", 42, ["studio:websites--web-studio", "submitted"],
    );
    expect((await res.json() as BoardTask).assignee).toBe("websites--web-studio");
  });

  it("POST /tasks/:n/assign reassigns and comments the lineage", async () => {
    authorized();
    const api = fakeApi({
      getIssue: vi.fn(async () => task({
        number: 42, state: "working", labels: ["working", "studio:websites--web-studio"],
        assignee: "websites--web-studio",
      })),
    });
    const res = await handleBoard(
      req("/studio/board/tasks/42/assign", {
        method: "POST",
        body: JSON.stringify({ assignee: "websites--release-studio", why: "web studio died" }),
      }), testEnv, api, reach,
    );

    expect(res.status).toBe(200);
    expect(api.removeLabel).toHaveBeenCalledWith("acme-org/websites", 42, "studio:websites--web-studio");
    expect(vi.mocked(api.createComment).mock.calls[0][2]).toContain("web studio died");
  });

  // Board issue #41, half one: the wake edge, wired. The rules themselves are
  // proven in test/board.assign-wake.test.ts; these prove the ROUTE reaches
  // them, on every path that assigns, and only on those.
  describe("assignment wakes the target studio, whatever its role", () => {
    const WEB = "websites--web-studio";

    function wakeDeps(state: string | null = "running", repoSlug: string | null = null) {
      const wake = vi.fn(async (_studioId: string, _prompt: string) => ({ ok: true as const }));
      return {
        deps: {
          studioState: vi.fn(async (_studioId: string) => state === null ? null : { state, repoSlug }),
          wake,
          // Identity by default: no rename in play in these fixtures, so the
          // raw case-insensitive compare in `sameRepoSlug` decides.
          resolveCanonicalRepo: vi.fn(async (slug: string) => slug),
        },
        wake,
      };
    }

    it("POST /tasks/:n/assign issues exactly one wake carrying that issue number", async () => {
      authorized();
      const api = fakeApi({
        getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [], assignee: null })),
      });
      const { deps, wake } = wakeDeps();
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );

      expect(res.status).toBe(200);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0][0]).toBe(WEB);
      expect(wake.mock.calls[0][1]).toContain("#42");
      expect((await res.json() as { wake: { woke: boolean } }).wake.woke).toBe(true);
    });

    it("POST /tasks/:n/adopt wakes too — `ff <role> <n>` is an assignment", async () => {
      authorized();
      const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
      const { deps, wake } = wakeDeps();
      await handleBoard(
        req("/studio/board/tasks/42/adopt", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("POST /tasks with an assignee wakes it — `fleet task new --studio` files AND wakes", async () => {
      authorized();
      const api = fakeApi({ createIssue: vi.fn(async () => task({ number: 77, assignee: WEB })) });
      const { deps, wake } = wakeDeps();
      const res = await handleBoard(
        req("/studio/board/tasks", { method: "POST", body: JSON.stringify({ ...brief, assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(res.status).toBe(200);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0][1]).toContain("#77");
    });

    it("POST /tasks into the BACKLOG wakes nothing and the response keeps its old shape", async () => {
      authorized();
      const api = fakeApi();
      const { deps, wake } = wakeDeps();
      const res = await handleBoard(
        req("/studio/board/tasks", { method: "POST", body: JSON.stringify(brief) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(wake).not.toHaveBeenCalled();
      expect(await res.json()).toEqual(task());
    });

    it("board #158: re-assigning the same task to the same studio still wakes it — a deliberate nudge, not a duplicate", async () => {
      authorized();
      const api = fakeApi({
        getIssue: vi.fn(async () => task({
          number: 42, state: "submitted", labels: ["submitted", `studio:${WEB}`], assignee: WEB,
        })),
      });
      const { deps, wake } = wakeDeps();
      const res = await handleBoard(
        req("/studio/board/tasks/42/adopt", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(res.status).toBe(200);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0][0]).toBe(WEB);
      expect(wake.mock.calls[0][1]).toContain("#42");
      expect(api.addLabels).not.toHaveBeenCalled();
      expect(api.createComment).not.toHaveBeenCalled();
      expect((await res.json() as { wake: { woke: boolean } }).wake.woke).toBe(true);
    });

    it("board #158: a same-studio re-assign to a STOPPED studio still reports NO WAKE, with the reason", async () => {
      authorized();
      const api = fakeApi({
        getIssue: vi.fn(async () => task({
          number: 42, state: "submitted", labels: ["submitted", `studio:${WEB}`], assignee: WEB,
        })),
      });
      const { deps, wake } = wakeDeps("stopped");
      const res = await handleBoard(
        req("/studio/board/tasks/42/adopt", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(res.status).toBe(200);
      expect(wake).not.toHaveBeenCalled();
      expect(api.addLabels).not.toHaveBeenCalled();
      const body = await res.json() as { wake: { woke: boolean; reason: string } };
      expect(body.wake.woke).toBe(false);
      expect(body.wake.reason).toContain("stopped");
    });

    it("a STOPPED studio gets no wake, the assignment still lands, and the response says why", async () => {
      authorized();
      const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
      const { deps, wake } = wakeDeps("stopped");
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );

      expect(res.status).toBe(200);
      expect(wake).not.toHaveBeenCalled();
      expect(api.addLabels).toHaveBeenCalled();
      const body = await res.json() as { wake: { woke: boolean; reason: string } };
      expect(body.wake.woke).toBe(false);
      expect(body.wake.reason).toContain("stopped");
    });

    // Board issue #158's spec gap, AND the test gap the review flagged: the
    // real CLI command (`fleet task assign`) posts to `/assign` (mode
    // "reassign"), never `/adopt` — the two #158 tests above only ever
    // exercised `/adopt`, so a fix gated on the wrong mode would still pass
    // the whole suite. This one hits `/assign` on a same-studio re-assign,
    // the exact path `fleet task assign <n> <role> --why "..."` takes.
    it("board #158: same-studio POST /tasks/:n/assign WITH why wakes once, carries why, writes nothing", async () => {
      authorized();
      const api = fakeApi({
        getIssue: vi.fn(async () => task({
          number: 42, state: "submitted", labels: ["submitted", `studio:${WEB}`], assignee: WEB,
        })),
      });
      const { deps, wake } = wakeDeps();
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", {
          method: "POST", body: JSON.stringify({ assignee: WEB, why: "nudge — check the failing test" }),
        }),
        testEnv, api, reach, undefined, undefined, deps,
      );

      expect(res.status).toBe(200);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0][0]).toBe(WEB);
      expect(wake.mock.calls[0][1]).toContain("nudge — check the failing test");
      const body = await res.json() as { wake: { woke: boolean; digest: string } };
      expect(body.wake.woke).toBe(true);
      expect(body.wake.digest).toContain("nudge — check the failing test");
      expect(api.addLabels).not.toHaveBeenCalled();
      expect(api.removeLabel).not.toHaveBeenCalled();
      expect(api.createComment).not.toHaveBeenCalled();
    });

    it("board #158: same-studio POST /tasks/:n/assign with NO why — digest has no why segment at all", async () => {
      authorized();
      const api = fakeApi({
        getIssue: vi.fn(async () => task({
          number: 42, state: "submitted", labels: ["submitted", `studio:${WEB}`], assignee: WEB,
        })),
      });
      const { deps, wake } = wakeDeps();
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { wake: { digest: string } };
      expect(body.wake.digest).not.toContain("why:");
      expect(wake.mock.calls[0][1]).not.toContain("why:");
    });

    it("board #158: a DIFFERENT-studio /assign WITH why leaves the digest unchanged — that path's why already lives in the lineage comment", async () => {
      authorized();
      const RELEASE = "websites--release-studio";
      const api = fakeApi({
        getIssue: vi.fn(async () => task({
          number: 42, state: "working", labels: ["working", `studio:${RELEASE}`], assignee: RELEASE,
        })),
      });
      const { deps, wake } = wakeDeps();
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", {
          method: "POST", body: JSON.stringify({ assignee: WEB, why: "release studio died" }),
        }),
        testEnv, api, reach, undefined, undefined, deps,
      );

      expect(res.status).toBe(200);
      // The why DID land — in the lineage comment, the existing mechanism —
      // but it must NOT also be threaded into the wake digest for a real move.
      expect(vi.mocked(api.createComment).mock.calls[0][2]).toContain("release studio died");
      const body = await res.json() as { wake: { digest: string } };
      expect(body.wake.digest).not.toContain("release studio died");
      expect(body.wake.digest).not.toContain("why:");
      expect(wake.mock.calls[0][1]).not.toContain("why:");
    });

    it("a failed wake never fails the assignment — the task is filed either way", async () => {
      authorized();
      const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
      const deps = {
        studioState: async () => ({ state: "running", repoSlug: null }),
        wake: async () => { throw new Error("DO unreachable"); },
        resolveCanonicalRepo: async (slug: string) => slug,
      };
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(res.status).toBe(200);
      expect((await res.json() as { wake: { reason: string } }).wake.reason).toContain("DO unreachable");
    });

    it("a REFUSED assignment wakes nothing", async () => {
      authorized();
      const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, labels: ["working", "failed"], state: null })) });
      const { deps, wake } = wakeDeps();
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(res.status).toBe(409);
      expect(wake).not.toHaveBeenCalled();
    });

    // Issue #278/#284 round 2: assigning/filing a task into a studio
    // provisioned for a DIFFERENT repo used to still report `woke the
    // studio` — the studio's own DO then 404s resolving the task number
    // against ITS OWN repo. Round 1 refused the WAKE but still let
    // `createTask`/`assignTask` write the `studio:` label and answered 200 —
    // indistinguishable from a real success at the HTTP level. Round 2 moves
    // the check BEFORE any write: a mismatch now writes NOTHING (no label,
    // no issue, no lineage comment) and the route answers 409, naming both
    // repos, with the underlying `wake` RPC never called.
    it("assigning a task into a studio for a different repo is refused BEFORE any write — 409, no label, never calls wake", async () => {
      authorized();
      const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
      // testEnv.AGENT_REPO ("acme-org/websites") is what this task is filed
      // into by default; the studio itself is recorded for a different (also
      // reachable) repo.
      const { deps, wake } = wakeDeps("running", "acme-org/beta");
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );

      expect(res.status).toBe(409);
      expect(wake).not.toHaveBeenCalled();
      // No write of any kind landed — not even the label a round-1 mismatch
      // still wrote before this fix.
      expect(api.addLabels).not.toHaveBeenCalled();
      expect(api.removeLabel).not.toHaveBeenCalled();
      expect(api.createComment).not.toHaveBeenCalled();
      const body = await res.text();
      expect(body).toContain(WEB);
      expect(body).toContain("acme-org/beta");
      expect(body).toContain("acme-org/websites");
    });

    it("filing a task with --studio into a studio for a different repo is refused the same way — 409, no issue ever created", async () => {
      authorized();
      const api = fakeApi({ createIssue: vi.fn(async () => task({ number: 77, assignee: WEB })) });
      const { deps, wake } = wakeDeps("running", "acme-org/beta");
      const res = await handleBoard(
        req("/studio/board/tasks", { method: "POST", body: JSON.stringify({ ...brief, assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(res.status).toBe(409);
      expect(wake).not.toHaveBeenCalled();
      // `createIssue` embeds the `studio:` label in the SAME call that files
      // the issue (board.ts's createTask) — never reached means no issue and
      // no label, not merely "no label added afterwards".
      expect(api.createIssue).not.toHaveBeenCalled();
      const body = await res.text();
      expect(body).toContain("acme-org/beta");
      expect(body).toContain("acme-org/websites");
    });

    it("a studio with no recorded repo (repoSlug: null) still wakes — fail-open, unchanged from today", async () => {
      authorized();
      const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
      const { deps, wake } = wakeDeps("running", null);
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(res.status).toBe(200);
      expect(wake).toHaveBeenCalledTimes(1);
      expect((await res.json() as { wake: { woke: boolean } }).wake.woke).toBe(true);
    });

    // Issue #295 bug 2: a canonical-lookup failure used to collapse into
    // "different repo" and hard-409 the write, same as a real mismatch. It
    // must fail OPEN for the write (with a warning logged) while the
    // post-write wake attempt still refuses — writes and wakes split here.
    it("issue #295: a canonical-lookup failure lets the write through with a warning, but still refuses the wake", async () => {
      authorized();
      const api = fakeApi({ getIssue: vi.fn(async () => task({ number: 42, state: null, labels: [] })) });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { deps, wake } = wakeDeps("running", "acme-org/beta");
      deps.resolveCanonicalRepo = vi.fn(async () => { throw new Error("GitHub token expired"); });
      const res = await handleBoard(
        req("/studio/board/tasks/42/assign", { method: "POST", body: JSON.stringify({ assignee: WEB }) }),
        testEnv, api, reach, undefined, undefined, deps,
      );
      expect(res.status).toBe(200);
      expect(api.addLabels).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
      expect((await res.json() as { wake: { woke: boolean } }).wake.woke).toBe(false);
      warnSpy.mockRestore();
    });
  });

  it("GETs are not assignment verbs — a read can never move a task", async () => {
    authorized();
    for (const action of ["adopt", "assign"]) {
      const res = await handleBoard(req(`/studio/board/tasks/42/${action}`), testEnv, fakeApi(), reach);
      expect(res.status).toBe(405);
    }
  });

  // Task #119: `verify` is read-only in the sense that it never mutates task
  // state, but it does outbound fetches and posts a comment — same POST-only
  // shape as envelope/adopt/assign, and it must be dispatched as its own
  // branch rather than falling through to commentEnvelope.
  describe("POST /tasks/:n/verify", () => {
    const okVerifyFetch: VerifyFetch = async () => ({ status: 200 });

    function resultEnvelopeComment() {
      const parsed = parseEnvelope(
        {
          sender: "websites--release-studio", intent: "result", status: "ok",
          verification: { url: "https://x.test", steps: ["branch ci/fleet-check-workflow exists"], expected: "works" },
        },
        42, "msg-1",
      );
      if (!parsed.ok) throw new Error(parsed.message);
      return { id: 1, url: "u1", author: "example-bot[bot]", createdAt: "t1", body: renderEnvelopeComment(parsed.doc) };
    }

    it("GET is not allowed — a read must never trigger outbound checks or a comment", async () => {
      authorized();
      const res = await handleBoard(req("/studio/board/tasks/42/verify"), testEnv, fakeApi(), reach);
      expect(res.status).toBe(405);
    });

    it("401s without an Access header, same gate as every other action", async () => {
      const res = await handleBoard(
        new Request("https://x/studio/board/tasks/42/verify", { method: "POST" }), testEnv, fakeApi(), reach,
      );
      expect(res.status).toBe(401);
    });

    it("dispatches into attemptVerification: classifies checks and posts exactly one comment", async () => {
      authorized();
      const api = fakeApi({
        getIssue: vi.fn(async () => task({ number: 42, state: "working", labels: ["working"] })),
        listComments: vi.fn(async () => [resultEnvelopeComment()]),
      });
      const res = await handleBoard(
        req("/studio/board/tasks/42/verify", { method: "POST" }), testEnv, api, reach, okVerifyFetch,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { comment: { url: string }; results: { verdict: string }[] };
      expect(body.results.length).toBe(2); // the url check + the one step
      expect(api.createComment).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.createComment).mock.calls[0][2]).toContain("msg-1");
    });

    it("404s and posts nothing when the task has no result envelope yet", async () => {
      authorized();
      const api = fakeApi({
        getIssue: vi.fn(async () => task({ number: 42, state: "working", labels: ["working"] })),
        listComments: vi.fn(async () => []),
      });
      const res = await handleBoard(
        req("/studio/board/tasks/42/verify", { method: "POST" }), testEnv, api, reach, okVerifyFetch,
      );
      expect(res.status).toBe(404);
      expect(api.createComment).not.toHaveBeenCalled();
    });
  });

  // Board task #126: the url check used to make a plain anonymous fetch of
  // `verification.url`, which 404s on every private repo in this fleet even
  // when the thing named genuinely exists. githubAwareVerifyFetch is the
  // fix's own testable seam — an injected token minter and existence checks,
  // so this proves the auth wiring with no live token mint and no network
  // call at all (realVerifyFetch itself, routes.ts's real-deps wrapper
  // around this function, is not separately tested — same posture
  // githubBoardApi/githubRepoReach's own real-deps wiring already takes in
  // this file).
  describe("githubAwareVerifyFetch (board task #126)", () => {
    function fakeChecks(overrides: Partial<GithubUrlExistenceChecks> = {}): GithubUrlExistenceChecks {
      return {
        commit: vi.fn(async () => true),
        pr: vi.fn(async () => true),
        issue: vi.fn(async () => true),
        branch: vi.fn(async () => true),
        path: vi.fn(async () => true),
        compare: vi.fn(async () => true),
        ...overrides,
      };
    }

    it("scenario 1 (the bug report): a private-repo commit url that would 404 unauthenticated resolves attempted-ok through the authenticated API", async () => {
      const mint = vi.fn(async (repo: string) => `token-for-${repo}`);
      const commit = vi.fn(async () => true); // the authenticated answer
      const fallback: VerifyFetch = vi.fn(async () => ({ status: 404 })); // what plain unauthenticated fetch said, live
      const fetchUrl = githubAwareVerifyFetch(mint, fakeChecks({ commit }), fallback);

      const res = await fetchUrl("https://github.com/acme-org/websites/commit/1e3a9d76abc");

      expect(res.status).toBe(200);
      expect(mint).toHaveBeenCalledWith("acme-org/websites");
      expect(commit).toHaveBeenCalledWith("token-for-acme-org/websites", "acme-org/websites", "1e3a9d76abc");
      expect(fallback).not.toHaveBeenCalled();
    });

    it("scenario 2: a genuinely missing commit still classifies attempted-failed (404) through the authenticated API", async () => {
      const mint = vi.fn(async (repo: string) => `token-for-${repo}`);
      const commit = vi.fn(async () => false);
      const fetchUrl = githubAwareVerifyFetch(mint, fakeChecks({ commit }), vi.fn());

      const res = await fetchUrl("https://github.com/acme-org/websites/commit/0000000");

      expect(res.status).toBe(404);
    });

    it("scenario 3: a non-github url is untouched — plain-fetch fallback, and the auth seam is never reached", async () => {
      const mint = vi.fn();
      const checks = fakeChecks();
      const fallback: VerifyFetch = vi.fn(async () => ({ status: 200 }));
      const fetchUrl = githubAwareVerifyFetch(mint, checks, fallback);

      const res = await fetchUrl("https://example.com/whatever");

      expect(res.status).toBe(200);
      expect(fallback).toHaveBeenCalledWith("https://example.com/whatever");
      expect(mint).not.toHaveBeenCalled();
      for (const fn of Object.values(checks)) expect(fn).not.toHaveBeenCalled();
    });

    it("an unrecognized github.com shape also falls back to the plain fetch, not the auth seam", async () => {
      const mint = vi.fn();
      const checks = fakeChecks();
      const fallback: VerifyFetch = vi.fn(async () => ({ status: 200 }));
      const fetchUrl = githubAwareVerifyFetch(mint, checks, fallback);

      const res = await fetchUrl("https://github.com/acme-org/websites/settings");

      expect(res.status).toBe(200);
      expect(fallback).toHaveBeenCalledWith("https://github.com/acme-org/websites/settings");
      expect(mint).not.toHaveBeenCalled();
    });

    it("a thrown mint/existence-check error reads as status 0, same posture the plain-fetch catch already took", async () => {
      const mint = vi.fn(async () => { throw new Error("rate limited"); });
      const fetchUrl = githubAwareVerifyFetch(mint, fakeChecks(), vi.fn());

      const res = await fetchUrl("https://github.com/acme-org/websites/pull/7");

      expect(res.status).toBe(0);
    });
  });
});

// Issue #217: POST /studio/board/tasks/rescue-gc. Same seam pattern as reap:
// RescueGcPort stands in for real GitHub.
describe("POST /studio/board/tasks/rescue-gc", () => {
  const NOW = Date.now();
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
  function fakePort(overrides: Partial<RescueGcPort> = {}): RescueGcPort {
    return {
      getDefaultBranch: vi.fn(async () => "main"),
      listRescueBranches: vi.fn(async () => [
        { name: "fleet/rescue/a-1", sha: "aaa", date: iso(30) },
        { name: "fleet/rescue/b-1", sha: "bbb", date: iso(30) },
      ]),
      compare: vi.fn(async (_repo: string, _base: string, head: string) =>
        head === "fleet/rescue/a-1" ? { aheadBy: 1, files: [".claude/worktrees/agent-x"] } : { aheadBy: 2, files: ["src/x.ts"] }),
      deleteBranch: vi.fn(async () => {}),
      ...overrides,
    };
  }
  const post = (body: unknown) => req("/studio/board/tasks/rescue-gc", { method: "POST", body: JSON.stringify(body) });

  it("401s without an Access header", async () => {
    const res = await handleBoard(new Request("https://x/studio/board/tasks/rescue-gc", { method: "POST" }), testEnv, fakeApi(), reach);
    expect(res.status).toBe(401);
  });

  it("dry-run by default: marker-only would be deleted, real work kept, nothing deleted", async () => {
    authorized();
    const port = fakePort();
    const res = await handleBoard(post({}), testEnv, fakeApi(), reach, undefined, undefined, undefined, port);
    expect(res.status).toBe(200);
    const body = await res.json() as { repo: string; apply: boolean; defaultBranch: string; olderThanDays: number; results: unknown[] };
    expect(body).toMatchObject({ repo: "acme-org/websites", apply: false, defaultBranch: "main", olderThanDays: 14 });
    expect(body.results).toEqual([
      { branch: "fleet/rescue/a-1", outcome: "would-delete", reason: "only tool markers (.claude/worktrees)" },
      { branch: "fleet/rescue/b-1", outcome: "kept", reason: "1 file(s) of real work not on main" },
    ]);
    expect(port.deleteBranch).not.toHaveBeenCalled();
  });

  it("apply + olderThanDays: deletes through the port, and honours the age", async () => {
    authorized();
    const port = fakePort();
    const res = await handleBoard(post({ apply: true, olderThanDays: 7 }), testEnv, fakeApi(), reach, undefined, undefined, undefined, port);
    const body = await res.json() as { olderThanDays: number; results: { outcome: string }[] };
    expect(body.olderThanDays).toBe(7);
    expect(body.results.map((r) => r.outcome)).toEqual(["deleted", "kept"]);
    expect(port.deleteBranch).toHaveBeenCalledWith("acme-org/websites", "fleet/rescue/a-1");
  });
});

// Board issue #8: POST /studio/board/tasks/reap. Same fakeApi()/authorized()/
// reach pattern as every other route above; the one new seam is ReapPort
// (getDefaultBranch + checkLanded), injected the same way verify's own
// VerifyFetch is — so no test here ever mints a real token or hits real
// GitHub.
describe("POST /studio/board/tasks/reap", () => {
  function fakeReapPort(overrides: Partial<ReapPort> = {}): ReapPort {
    return {
      getDefaultBranch: vi.fn(async () => "main"),
      checkLanded: vi.fn(async () => ({ landed: false, sha: null })),
      findCloser: vi.fn(async () => ({ stateReason: null, closer: null })),
      prClaims: vi.fn(async () => true),
      ...overrides,
    };
  }

  function resultEnvelopeWithPr(pr: string, taskId = 12) {
    const parsed = parseEnvelope(
      {
        sender: "websites--web-studio", intent: "result", status: "ok",
        artifacts: [{ kind: "pr", pr }],
        verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
      },
      taskId, "msg-1",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    return { id: 1, url: "u1", author: "example-bot[bot]", createdAt: "t1", body: renderEnvelopeComment(parsed.doc) };
  }

  it("405s anything but POST", async () => {
    authorized();
    const res = await handleBoard(req("/studio/board/tasks/reap"), testEnv, fakeApi(), reach);
    expect(res.status).toBe(405);
  });

  it("401s without an Access header — same gate as every other board route", async () => {
    const res = await handleBoard(
      new Request("https://x/studio/board/tasks/reap", { method: "POST" }), testEnv, fakeApi(), reach,
    );
    expect(res.status).toBe(401);
  });

  // Issue #248: the #107 shape through the real route — board state and the
  // claim check both reach runTaskReap.
  it("apply: true leaves an input_required task open, and a non-claiming PR's task open", async () => {
    authorized();
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({ number: 107, open: true, state: "input_required", labels: ["input_required"] }),
        task({ number: 108, open: true, state: "working", labels: ["working"] }),
      ]),
      listComments: vi.fn(async (_repo: string, n: number) => [resultEnvelopeWithPr(n === 107 ? "150" : "152", n)]),
    });
    const prClaims = vi.fn(async () => false);
    const reapPort = fakeReapPort({ checkLanded: vi.fn(async () => ({ landed: true, sha: "ef4e9a15" })), prClaims });
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({ apply: true }) }),
      testEnv, api, reach, undefined, reapPort,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toEqual([
      { taskNumber: 107, prNumber: 150, outcome: "skipped", reason: "parked input_required" },
      { taskNumber: 108, prNumber: 152, outcome: "skipped", reason: "PR #152 landed but does not close #108 (no closing keyword) — multi-PR task?" },
    ]);
    expect(prClaims).toHaveBeenCalledWith("acme-org/websites", 152, 108);
    expect(api.closeIssue).not.toHaveBeenCalled();
  });

  it("dry-run (apply omitted) reports would-close for a landed task and performs no write", async () => {
    authorized();
    const api = fakeApi({
      listIssues: vi.fn(async () => [task({ number: 12, open: true })]),
      listComments: vi.fn(async () => [resultEnvelopeWithPr("9")]),
    });
    const reapPort = fakeReapPort({ checkLanded: vi.fn(async () => ({ landed: true, sha: "abc123" })) });
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({}) }),
      testEnv, api, reach, undefined, reapPort,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { repo: string; apply: boolean; defaultBranch: string; results: unknown[] };
    expect(body.repo).toBe("acme-org/websites");
    expect(body.apply).toBe(false);
    expect(body.defaultBranch).toBe("main");
    expect(body.results).toEqual([{ taskNumber: 12, prNumber: 9, outcome: "would-close", sha: "abc123" }]);
    expect(api.closeIssue).not.toHaveBeenCalled();
  });

  it("apply: true actually closes a landed task through the shared close-action", async () => {
    authorized();
    const api = fakeApi({
      listIssues: vi.fn(async () => [task({ number: 12, open: true, state: "working", labels: ["working"] })]),
      getIssue: vi.fn(async () => task({ number: 12, state: "working", labels: ["working"] })),
      listComments: vi.fn(async () => [resultEnvelopeWithPr("9")]),
    });
    const reapPort = fakeReapPort({ checkLanded: vi.fn(async () => ({ landed: true, sha: "abc123" })) });
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({ apply: true }) }),
      testEnv, api, reach, undefined, reapPort,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { apply: boolean; results: unknown[] };
    expect(body.apply).toBe(true);
    expect(body.results).toEqual([{ taskNumber: 12, prNumber: 9, outcome: "closed", sha: "abc123" }]);
    expect(api.closeIssue).toHaveBeenCalledWith("acme-org/websites", 12);
    expect(api.createComment).toHaveBeenCalledWith(
      "acme-org/websites", 12, expect.stringContaining("closed by abc123, promoted to main"),
    );
  });

  // Board issue #157: the #98 repro -- board already reads `completed` but
  // GitHub's own issue is still open, because closeTaskOnPromote's completed
  // branch used to be an empty no-op regardless of `task.open`. This proves
  // the fix end-to-end through the real route + real closeTaskOnPromote, not
  // just close-action.ts's own unit tests.
  it("apply: true closes a task the board already reads completed but GitHub still has open (#98/#157)", async () => {
    authorized();
    const api = fakeApi({
      listIssues: vi.fn(async () => [task({ number: 98, open: true, state: "completed", labels: ["completed"] })]),
      getIssue: vi.fn(async () => task({ number: 98, open: true, state: "completed", labels: ["completed"] })),
      listComments: vi.fn(async () => [resultEnvelopeWithPr("46", 98)]),
    });
    const reapPort = fakeReapPort({ checkLanded: vi.fn(async () => ({ landed: true, sha: "d93f0a9" })) });
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({ apply: true }) }),
      testEnv, api, reach, undefined, reapPort,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toEqual([{ taskNumber: 98, prNumber: 46, outcome: "closed", sha: "d93f0a9" }]);
    expect(api.closeIssue).toHaveBeenCalledWith("acme-org/websites", 98);
  });

  it("apply: true reports already-closed and never calls closeIssue for a completed task GitHub already closed", async () => {
    authorized();
    // listIssues reports `open: true` so openTasksWithLatestPr's own
    // `!task.open && task.state === "completed"` pre-filter does not drop
    // it before reap even gets a look (a fully-resolved task is out of
    // reap's scope by design) -- getIssue (the fresh read close-action.ts's
    // own completed-branch makes) is what actually says GitHub already
    // closed it, the way a real race between listing and closing would.
    const api = fakeApi({
      listIssues: vi.fn(async () => [task({ number: 98, open: true, state: "completed", labels: ["completed"] })]),
      getIssue: vi.fn(async () => task({ number: 98, open: false, state: "completed", labels: ["completed"] })),
      listComments: vi.fn(async () => [resultEnvelopeWithPr("46", 98)]),
    });
    const reapPort = fakeReapPort({ checkLanded: vi.fn(async () => ({ landed: true, sha: "e1a2b3c" })) });
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({ apply: true }) }),
      testEnv, api, reach, undefined, reapPort,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toEqual([{ taskNumber: 98, prNumber: 46, outcome: "already-closed", sha: "e1a2b3c" }]);
    expect(api.closeIssue).not.toHaveBeenCalled();
  });

  // Board issue #26: routes.ts's own `.filter((t) => t.open)` ahead of
  // openTasksWithLatestPr used to drop a task GitHub already closed
  // natively before reap ever got a look at it, even with its board label
  // still "working" (closeTaskOnPromote never ran). The route now passes
  // the FULL listIssues result through, and openTasksWithLatestPr's own
  // predicate decides -- proving the removed pre-filter no longer hides it.
  it("dry-run still reports would-close for a task GitHub already closed natively but not yet labeled completed", async () => {
    authorized();
    const api = fakeApi({
      listIssues: vi.fn(async () => [task({ number: 12, open: false, state: "working", labels: ["working"] })]),
      listComments: vi.fn(async () => [resultEnvelopeWithPr("9")]),
    });
    const reapPort = fakeReapPort({ checkLanded: vi.fn(async () => ({ landed: true, sha: "abc123" })) });
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({}) }),
      testEnv, api, reach, undefined, reapPort,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toEqual([{ taskNumber: 12, prNumber: 9, outcome: "would-close", sha: "abc123" }]);
    expect(api.closeIssue).not.toHaveBeenCalled();
  });

  it("a task with no PR artifact is skipped, and checkLanded is never called for it", async () => {
    authorized();
    const api = fakeApi({
      listIssues: vi.fn(async () => [task({ number: 12, open: true })]),
      listComments: vi.fn(async () => []),
    });
    const checkLanded = vi.fn(async () => ({ landed: false, sha: null }));
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({}) }),
      testEnv, api, reach, undefined, fakeReapPort({ checkLanded }),
    );
    const body = await res.json() as { results: { outcome: string; reason?: string }[] };
    expect(body.results).toEqual([
      { taskNumber: 12, outcome: "skipped", reason: "no PR artifact found in the latest result envelope" },
    ]);
    expect(checkLanded).not.toHaveBeenCalled();
  });

  // Board issue #138: a GitHub-closed task with no envelope PR is resolved
  // through the merged PR that closed it; an open one never asks.
  it("a closed task with no envelope is resolved through the merged PR that closed it", async () => {
    authorized();
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({ number: 39, open: false, state: "submitted", labels: ["submitted"] }),
        task({ number: 40, open: true, state: "submitted", labels: ["submitted"] }),
      ]),
      listComments: vi.fn(async () => []),
    });
    const findCloser = vi.fn(async () => ({ stateReason: "COMPLETED", closer: { kind: "pr" as const, number: 46, merged: true, repo: "acme-org/websites" } }));
    const checkLanded = vi.fn(async () => ({ landed: true, sha: "m46" }));
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({}) }),
      testEnv, api, reach, undefined, fakeReapPort({ findCloser, checkLanded }),
    );
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toEqual([
      { taskNumber: 39, prNumber: 46, outcome: "would-close", sha: "m46" },
      { taskNumber: 40, outcome: "skipped", reason: "no PR artifact found in the latest result envelope" },
    ]);
    expect(findCloser).toHaveBeenCalledTimes(1);
    expect(findCloser).toHaveBeenCalledWith("acme-org/websites", 39);
    expect(checkLanded).toHaveBeenCalledWith("acme-org/websites", "main", 46);
    expect(api.closeIssue).not.toHaveBeenCalled();
  });

  it("honours a caller's repo the same way every other board route does", async () => {
    authorized();
    const api = fakeApi({ listIssues: vi.fn(async () => []) });
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({ repo: "acme-org/beta" }) }),
      testEnv, api, reach, undefined, fakeReapPort(),
    );
    const body = await res.json() as { repo: string };
    expect(body.repo).toBe("acme-org/beta");
  });

  // Finding 1's callers-must-handle-a-throw-correctly follow-up: with the
  // dedup marker now written last (close-action.ts), a genuine write
  // failure propagates OUT of closeTaskOnPromote as a throw instead of a
  // silent no-op. This route's `close` wrapper must not let that throw get
  // coerced into a "closed" outcome -- runTaskReap's own try/catch around
  // `deps.close` is what turns it into a "skipped" outcome carrying the
  // real error, and this proves that wiring holds end-to-end through the
  // route, not just in task-reap.ts's pure core.
  it("apply: true reports a thrown close-action failure as skipped with the real error, not closed", async () => {
    authorized();
    // Distinct issue number + sha from every other test in this describe
    // block -- close-action.ts's dedup guard is keyed on (repo, issue, sha)
    // over the SAME real D1, and a collision with an earlier test's
    // successful close would short-circuit this one before it ever calls
    // the throwing closeIssue mock.
    const api = fakeApi({
      listIssues: vi.fn(async () => [task({ number: 99, open: true, state: "working", labels: ["working"] })]),
      getIssue: vi.fn(async () => task({ number: 99, state: "working", labels: ["working"] })),
      listComments: vi.fn(async () => [resultEnvelopeWithPr("9", 99)]),
      closeIssue: vi.fn(async () => { throw new Error("GitHub 502"); }),
    });
    const reapPort = fakeReapPort({ checkLanded: vi.fn(async () => ({ landed: true, sha: "throw-sha-1" })) });
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({ apply: true }) }),
      testEnv, api, reach, undefined, reapPort,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { results: { taskNumber: number; outcome: string; reason?: string }[] };
    expect(body.results).toEqual([
      { taskNumber: 99, outcome: "skipped", reason: expect.stringContaining("GitHub 502") },
    ]);
  });

  it("refuses a repo the installation cannot reach, before any board or GitHub call", async () => {
    authorized();
    const reapPort = fakeReapPort();
    const res = await handleBoard(
      req("/studio/board/tasks/reap", { method: "POST", body: JSON.stringify({ repo: "someone/else" }) }),
      testEnv, fakeApi(), reach, undefined, reapPort,
    );
    expect(res.status).toBe(403);
    expect(reapPort.getDefaultBranch).not.toHaveBeenCalled();
  });
});

// Board #55 defect A: the destroy guard's checker reads BOARD state and hands
// the blocking task numbers up, so the 409 can name them.
describe("openTaskChecker (#55)", () => {
  const MINE = "fleetflare--web-studio";
  it("a completed task on an open issue does not block; a working one does, by number", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({ number: 98, state: "completed", open: true, labels: ["completed", `studio:${MINE}`], assignee: MINE }),
        task({ number: 90, state: "working", open: true, labels: ["working", `studio:${MINE}`], assignee: MINE }),
      ]),
    });
    expect(await openTaskChecker(env as unknown as Env, api)(MINE, "rafarc21/fleetflare"))
      .toEqual({ ok: true, hasOpenTask: true, tasks: [90], drifted: [] });
  });

  it("only finished tasks: confirmed clear, empty lists (#124 N5)", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [
        task({ number: 98, state: "completed", open: true, labels: ["completed", `studio:${MINE}`], assignee: MINE }),
        task({ number: 56, state: "canceled", open: true, labels: ["canceled", `studio:${MINE}`], assignee: MINE }),
      ]),
    });
    expect(await openTaskChecker(env as unknown as Env, api)(MINE, "rafarc21/fleetflare"))
      .toEqual({ ok: true, hasOpenTask: false, tasks: [], drifted: [] });
  });

  it("a drifted task is reported as drifted (#124 N1)", async () => {
    const api = fakeApi({
      listIssues: vi.fn(async () => [task({ number: 7, state: null, open: true, labels: [`studio:${MINE}`], assignee: MINE })]),
    });
    expect(await openTaskChecker(env as unknown as Env, api)(MINE, "rafarc21/fleetflare"))
      .toEqual({ ok: true, hasOpenTask: true, tasks: [7], drifted: [7] });
  });
});
