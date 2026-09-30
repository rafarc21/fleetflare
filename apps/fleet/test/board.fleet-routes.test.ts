import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleFleetBoard, resolveStudioBoardRepo, briefPromptResolver } from "../src/board/routes";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import { GitHubError } from "../src/board/api";
import { studioLabel, type BoardTask } from "../src/board/types";
import type { BoardApi } from "../src/board/board";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { isJuniorAuthorized, recordJuniorAuthorization } from "../src/junior/authz";

// P4a-2 — GET/POST /fleet/tasks*: the STUDIO's own read of the board.
//
// Same posture as test/board.routes.test.ts (every GitHub call behind an
// injected port, no live issue) with one difference that IS the feature: this
// surface has no Access gate at all. Its whole authentication is the spawn
// token, resolved against registry rows — so the rows are injected too, and
// every test below states which studio the presented token belongs to.

const MINE = "websites--web-studio";
const THEIRS = "websites--release-studio";
const REPO = "acme-org/websites";

const testEnv = { ...env, AGENT_REPO: REPO } as unknown as Env;

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 71, url: "https://github.com/acme-org/websites/issues/71", title: "Ship the thing",
    body: "## Objective\n\nShip it.\n", state: "submitted", labels: ["submitted", studioLabel(MINE)],
    assignee: MINE, milestone: null, open: true, updatedAt: "2026-08-25T10:00:00Z", ...overrides,
  };
}

function fakeApi(overrides: Partial<BoardApi> = {}): BoardApi {
  return {
    createIssue: vi.fn(async () => task()),
    getIssue: vi.fn(async () => task()),
    listIssues: vi.fn(async () => [task()]),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ id: 1, url: "https://github.com/o/r/issues/71#issuecomment-1" })),
    pullRequestExists: vi.fn(async () => true),
    listComments: vi.fn(async () => []),
    listMilestones: vi.fn(async () => [{ number: 3, title: "Sprint 1" }]),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    ...overrides,
  };
}

function row(id: string, hash: string, repoSlug: string | null = REPO): StudioStatus {
  return {
    id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug,
  };
}

/** One studio, one live token — the shape every authenticated test needs. */
async function tokenFor(id: string, repoSlug: string | null = REPO) {
  const token = mintSpawnToken();
  const rows = [row(id, await hashSpawnToken(token), repoSlug)];
  return { token, rows: async () => rows };
}

function req(path: string, token: string | null, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: {
      ...(token === null ? {} : { [SPAWN_TOKEN_HEADER]: token }),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("resolveStudioBoardRepo — a studio does not choose its board", () => {
  it("uses the studio's own bound repo when it names none", () => {
    expect(resolveStudioBoardRepo("Acme-Org/Websites", "fallback/repo", undefined))
      .toEqual({ ok: true, value: REPO });
  });

  it("falls back to the fleet default for a pre-P4a row with no binding", () => {
    // Every such studio was cloned from AGENT_REPO by construction.
    expect(resolveStudioBoardRepo(null, REPO, undefined)).toEqual({ ok: true, value: REPO });
  });

  it("lets an exactly-matching repo through — it tells the caller nothing new", () => {
    expect(resolveStudioBoardRepo(REPO, "x/y", "ACME-ORG/websites")).toEqual({ ok: true, value: REPO });
  });

  it("403s a DIFFERENT repo loudly rather than silently serving the studio's own", () => {
    const res = resolveStudioBoardRepo(REPO, REPO, "torvalds/linux");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.message).toContain(REPO);
      expect(res.message).toContain("torvalds/linux");
    }
  });
});

describe("handleFleetBoard — auth", () => {
  it("401s with no token at all, before any registry read", async () => {
    const rows = vi.fn(async () => []);
    const res = await handleFleetBoard(req("/fleet/tasks", null), testEnv, fakeApi(), rows);
    expect(res.status).toBe(401);
    expect(rows).not.toHaveBeenCalled();
  });

  it("401s a malformed token on the regex alone — an Access-less route must not cost a D1 query per probe", async () => {
    const rows = vi.fn(async () => []);
    expect((await handleFleetBoard(req("/fleet/tasks", "nope"), testEnv, fakeApi(), rows)).status).toBe(401);
    expect(rows).not.toHaveBeenCalled();
  });

  it("401s a well-shaped token no studio holds — indistinguishable from absent", async () => {
    const { rows } = await tokenFor(MINE);
    const res = await handleFleetBoard(req("/fleet/tasks", mintSpawnToken()), testEnv, fakeApi(), rows);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  it("404s an unknown /fleet/tasks path and 405s a wrong verb, both before auth", async () => {
    expect((await handleFleetBoard(req("/fleet/tasks/12/nonsense", null, { method: "POST" }), testEnv, fakeApi(), async () => [])).status)
      .toBe(404);
    expect((await handleFleetBoard(req("/fleet/tasks/12", null, { method: "DELETE" }), testEnv, fakeApi(), async () => [])).status)
      .toBe(405);
  });

  // Board issue #41, half two. The route exists now; `completed` does not.
  it("refuses an unauthenticated transition before any registry read", async () => {
    const rows = vi.fn(async () => []);
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", null, { method: "POST", body: JSON.stringify({ to: "working" }) }),
      testEnv, fakeApi(), rows,
    );
    expect(res.status).toBe(401);
    expect(rows).not.toHaveBeenCalled();
  });

  it("405s a GET on the transition route — a read can never move a task", async () => {
    const { token, rows } = await tokenFor(MINE);
    expect((await handleFleetBoard(req("/fleet/tasks/71/state", token), testEnv, fakeApi(), rows)).status).toBe(405);
  });

  it("cannot adopt, and cannot assign outside its org-chart edges (P5 §3, issue #59)", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    // web-studio has no edges at all: the assign route exists since issue #59,
    // and refuses it at the org-chart gate before any label is touched.
    const noEdges = async () => ({ org: { edges: {}, gates: {} }, roles: [] });
    for (const [action, status] of [["adopt", 404], ["assign", 403]] as const) {
      const res = await handleFleetBoard(
        req(`/fleet/tasks/71/${action}`, token, { method: "POST", body: JSON.stringify({ assignee: THEIRS }) }),
        testEnv, api, rows, noEdges,
      );
      expect(res.status).toBe(status);
    }
    // The point is not the status code: no label was written by either call.
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });
});

// Board issue #41, half two: a lead moves the state of its OWN task.
//
// Every write below is still the WORKER's — the lead holds a spawn token and
// no GitHub credential, and there is no code path on this surface that calls
// GitHub's label API for it. What changed is that the lead can now ASK.

describe("handleFleetBoard — a lead moves its own task", () => {
  it("moves the caller's own task to working", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", token, { method: "POST", body: JSON.stringify({ to: "working" }) }),
      testEnv, api, rows,
    );

    expect(res.status).toBe(200);
    expect((await res.json() as BoardTask).state).toBe("working");
    expect(api.removeLabel).toHaveBeenCalledWith(REPO, 71, "submitted");
    expect(api.addLabels).toHaveBeenCalledWith(REPO, 71, ["working"]);
  });

  it("moves it to input_required and to failed", async () => {
    for (const to of ["input_required", "failed"]) {
      const { token, rows } = await tokenFor(MINE);
      const api = fakeApi();
      const res = await handleFleetBoard(
        req("/fleet/tasks/71/state", token, { method: "POST", body: JSON.stringify({ to }) }),
        testEnv, api, rows,
      );
      expect(res.status).toBe(200);
      expect(api.addLabels).toHaveBeenCalledWith(REPO, 71, [to]);
    }
  });

  // Issue #10: `failed` is terminal and a lead may set it, then set `working`
  // again. The first move must revoke junior, or the lead keeps it.
  it("#10: a lead moving its task to failed revokes the junior record", async () => {
    await testEnv.DB.prepare("DELETE FROM fleet_state").run();
    await recordJuniorAuthorization(testEnv.DB, REPO, 71, MINE, 1000);
    const { token, rows } = await tokenFor(MINE);
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", token, { method: "POST", body: JSON.stringify({ to: "failed" }) }),
      testEnv, fakeApi(), rows,
    );
    expect(res.status).toBe(200);
    expect(await isJuniorAuthorized(testEnv.DB, REPO, 71, MINE)).toBe(false);
  });

  it("REFUSES completed with a 403 and writes no label — a lead never self-approves", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", token, { method: "POST", body: JSON.stringify({ to: "completed" }) }),
      testEnv, api, rows,
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain("verifies");
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
    expect(api.getIssue).not.toHaveBeenCalled();
  });

  it("refuses completed even when the body also carries a `from` the caller invented", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", token, {
        method: "POST", body: JSON.stringify({ from: "working", to: "completed" }),
      }),
      testEnv, api, rows,
    );
    expect(res.status).toBe(403);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("refuses canceled and submitted too", async () => {
    for (const to of ["canceled", "submitted"]) {
      const { token, rows } = await tokenFor(MINE);
      const api = fakeApi();
      const res = await handleFleetBoard(
        req("/fleet/tasks/71/state", token, { method: "POST", body: JSON.stringify({ to }) }),
        testEnv, api, rows,
      );
      expect(res.status).toBe(403);
      expect(api.addLabels).not.toHaveBeenCalled();
    }
  });

  it("404s a task assigned to ANOTHER studio and writes nothing", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(THEIRS)], assignee: THEIRS })) });
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", token, { method: "POST", body: JSON.stringify({ to: "working" }) }),
      testEnv, api, rows,
    );

    expect(res.status).toBe(404);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("refuses a repo the studio is not bound to, and writes nothing", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", token, {
        method: "POST", body: JSON.stringify({ to: "working", repo: "torvalds/linux" }),
      }),
      testEnv, api, rows,
    );
    expect(res.status).toBe(403);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("400s a state outside the board's vocabulary", async () => {
    const { token, rows } = await tokenFor(MINE);
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", token, { method: "POST", body: JSON.stringify({ to: "in-progress" }) }),
      testEnv, fakeApi(), rows,
    );
    expect(res.status).toBe(400);
  });

  it("409s board drift rather than flattening it", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ labels: ["working", "failed", studioLabel(MINE)], state: null })) });
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/state", token, { method: "POST", body: JSON.stringify({ to: "working" }) }),
      testEnv, api, rows,
    );
    expect(res.status).toBe(409);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("cannot adopt, and cannot assign outside its org-chart edges (P5 §3, issue #59)", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    // web-studio has no edges at all: the assign route exists since issue #59,
    // and refuses it at the org-chart gate before any label is touched.
    const noEdges = async () => ({ org: { edges: {}, gates: {} }, roles: [] });
    for (const [action, status] of [["adopt", 404], ["assign", 403]] as const) {
      const res = await handleFleetBoard(
        req(`/fleet/tasks/71/${action}`, token, { method: "POST", body: JSON.stringify({ assignee: THEIRS }) }),
        testEnv, api, rows, noEdges,
      );
      expect(res.status).toBe(status);
    }
    // The point is not the status code: no label was written by either call.
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });
});

describe("handleFleetBoard — scope", () => {
  it("lists only this studio's tasks, filtered at GitHub", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    const res = await handleFleetBoard(req("/fleet/tasks", token), testEnv, api, rows);
    expect(res.status).toBe(200);
    expect(vi.mocked(api.listIssues).mock.calls[0][0]).toBe(REPO);
    expect(vi.mocked(api.listIssues).mock.calls[0][1].labels).toEqual([studioLabel(MINE)]);
  });

  it("honours a state filter alongside the ownership filter", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    await handleFleetBoard(req("/fleet/tasks?state=working", token), testEnv, api, rows);
    expect(vi.mocked(api.listIssues).mock.calls[0][1].labels).toEqual(["working", studioLabel(MINE)]);
  });

  it("refuses a repo the studio is not bound to, and reads nothing", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    const res = await handleFleetBoard(req("/fleet/tasks?repo=torvalds/linux", token), testEnv, api, rows);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not yours to ask about");
    expect(vi.mocked(api.listIssues)).not.toHaveBeenCalled();
  });

  it("reads the board of the repo THIS studio is bound to, not the fleet default", async () => {
    const { token, rows } = await tokenFor("beta--web-studio", "acme-org/beta");
    const api = fakeApi();
    await handleFleetBoard(req("/fleet/tasks", token), testEnv, api, rows);
    expect(vi.mocked(api.listIssues).mock.calls[0][0]).toBe("acme-org/beta");
  });

  it("shows a task assigned to the caller", async () => {
    const { token, rows } = await tokenFor(MINE);
    const res = await handleFleetBoard(req("/fleet/tasks/71", token), testEnv, fakeApi(), rows);
    expect(res.status).toBe(200);
    expect((await res.json() as { task: BoardTask }).task.number).toBe(71);
  });

  it("404s a task assigned to ANOTHER studio, naming the caller and not the owner", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(THEIRS)], assignee: THEIRS })) });
    const res = await handleFleetBoard(req("/fleet/tasks/71", token), testEnv, api, rows);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain(MINE);
    expect(body).not.toContain("release-studio");
    expect(vi.mocked(api.listComments)).not.toHaveBeenCalled();
  });
});

describe("handleFleetBoard — reporting", () => {
  it("posts the envelope and stamps the sender with the token's own studio", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi();
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/envelope", token, {
        method: "POST",
        body: JSON.stringify({
          sender: THEIRS, intent: "result", status: "ok", evidence: ["bun run test"],
          verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
        }),
      }),
      testEnv, api, rows,
    );
    expect(res.status).toBe(200);
    const posted = await res.json() as { envelope: { envelope: { sender: string; msg_id: string } } };
    expect(posted.envelope.envelope.sender).toBe(MINE);
    expect(posted.envelope.envelope.msg_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses an envelope aimed at a task the caller does not own", async () => {
    const { token, rows } = await tokenFor(MINE);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(THEIRS)] })) });
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/envelope", token, { method: "POST", body: JSON.stringify({ intent: "result", status: "ok" }) }),
      testEnv, api, rows,
    );
    expect(res.status).toBe(404);
    expect(vi.mocked(api.createComment)).not.toHaveBeenCalled();
  });

  it("400s a malformed envelope with the schema's own words", async () => {
    const { token, rows } = await tokenFor(MINE);
    const res = await handleFleetBoard(
      req("/fleet/tasks/71/envelope", token, { method: "POST", body: JSON.stringify({ intent: "nonsense", status: "ok" }) }),
      testEnv, fakeApi(), rows,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unknown intent");
  });

  it("a broken upstream is OURS (502), a missing issue is the caller's (404)", async () => {
    const { token, rows } = await tokenFor(MINE);
    const boom = (status: number) => fakeApi({ getIssue: vi.fn(async () => { throw new GitHubError(status, "Not Found"); }) });
    expect((await handleFleetBoard(req("/fleet/tasks/71", token), testEnv, boom(404), rows)).status).toBe(404);
    expect((await handleFleetBoard(req("/fleet/tasks/71", token), testEnv, boom(500), rows)).status).toBe(502);
  });
});

describe("briefPromptResolver — what a spawn hands a new studio", () => {
  it("renders the brief for a task the studio owns", async () => {
    const api = fakeApi();
    const res = await briefPromptResolver(testEnv, api)(MINE, REPO, 71);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain("fleet task report 71");
    expect(vi.mocked(api.getIssue).mock.calls[0][0]).toBe(REPO);
  });

  it("falls back to the fleet's own repo when the studio has no binding yet", async () => {
    const api = fakeApi();
    await briefPromptResolver(testEnv, api)(MINE, undefined, 71);
    expect(vi.mocked(api.getIssue).mock.calls[0][0]).toBe(REPO.toLowerCase());
  });

  it("refuses a task assigned to somebody else — a parent cannot hand a child another studio's work", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(THEIRS)] })) });
    const res = await briefPromptResolver(testEnv, api)(MINE, REPO, 71);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("turns a thrown GitHub failure into a result, never an exception into the spawn path", async () => {
    const api = fakeApi({ getIssue: vi.fn(async () => { throw new GitHubError(503, "unavailable"); }) });
    const res = await briefPromptResolver(testEnv, api)(MINE, REPO, 71);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
  });
});
