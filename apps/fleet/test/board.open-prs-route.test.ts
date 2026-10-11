import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { RepoReach } from "../src/github/reach";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleBoard } from "../src/board/routes";
import type { BoardApi } from "../src/board/board";
import type { BoardTask } from "../src/board/types";
import type { Env } from "../src/env";

// Board issue #332, plan step 2: GET /studio/board/open-prs?repo=<slug> —
// the per-repo unmerged-PR map `fleet ls`'s PRS column and destroy's warning
// both read. Same harness shape as test/board.routes.test.ts: real
// verifyAccess spied away for the authorized cases, every GitHub call behind
// an injected fake BoardApi, and the SAME `reach` fake board.routes.test.ts
// already uses — resolveBoardRepo's reachability seam. The one seam this
// route adds over the routes file's existing ports is the registry rows
// (`StudioRowFetch`, the shape handleFleetBoard's own tests inject): the
// route decides which studios belong to the requested repo from each row's
// `repoSlug`, exactly as resolveStudioBoardRepo reads it.

const testEnv = { ...env, AGENT_REPO: "acme-org/websites" } as unknown as Env;

/** The P6a reachability seam handleBoard takes — a live GitHub call in
 *  production, with no test double: the SAME fake board.routes.test.ts
 *  already uses verbatim, so resolveBoardRepo's refusal legs (a repo the
 *  installation cannot reach, a reachability throw) are exercised through
 *  the identical inputs. */
const reach = async (slug: string): Promise<RepoReach> =>
  ["acme-org/websites", "acme-org/beta"].includes(slug.toLowerCase())
    ? { reachable: true }
    : { reachable: false, remedy: "is not reachable by this fleet" };

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/o/r/issues/12", title: "Build the task board",
    body: "## Objective\n\nShip it.\n", state: "working", labels: ["working"],
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
    listOpenPullFiles: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ number: 0, merged: false, open: true, title: "" })),
    ...overrides,
  };
}

/** Registry rows as the injected `StudioRowFetch` — the seam shape
 *  board.fleet-routes.test.ts already uses for the same registry read. */
function row(id: string, repoSlug: string | null): { id: string; state: string; repoSlug: string | null } {
  return { id, state: "running", repoSlug };
}

function authorized() {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

// fleet_state is not isolated per test (same as board.routes.test.ts's own
// beforeEach) — but the rows seam is injected, so the sweep only guards the
// tests that use the real D1 default.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("GET /studio/board/open-prs", () => {
  it("200s with prs keyed by studio id — only studios of the requested repo", async () => {
    authorized();
    // web-studio on the requested repo reports one unmerged PR; release-studio
    // reports none. Both are on acme-org/websites; the caller asked for it
    // by name, so both lanes must be in the map.
    const api = fakeApi({
      listIssues: vi.fn(async (repo: string, _query: { labels?: string[] }) =>
        repo === "acme-org/websites" ? [task()] : []),
      listComments: vi.fn(async () => []),
    });
    const rows = vi.fn(async () => [
      row("websites--web-studio", "acme-org/websites"),
      row("websites--release-studio", "acme-org/websites"),
    ]);
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach, rows);

    expect(res.status).toBe(200);
    const body = await res.json() as { repo: string; prs: Record<string, unknown[]> };
    expect(body.repo).toBe("acme-org/websites");
    // Zero matching studios is `{}`; here both must be present.
    expect(Object.keys(body.prs).sort()).toEqual(["websites--release-studio", "websites--web-studio"]);
  });

  it("a studio on ANOTHER repo is excluded — its repoSlug differs from the resolved one", async () => {
    authorized();
    const listIssues = vi.fn(async () => [task()]);
    const api = fakeApi({ listIssues });
    const rows = vi.fn(async () => [
      row("websites--web-studio", "acme-org/websites"),
      row("beta--web-studio", "acme-org/beta"),
    ]);
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach, rows);

    expect(res.status).toBe(200);
    const body = await res.json() as { prs: Record<string, unknown[]> };
    expect(Object.keys(body.prs)).toEqual(["websites--web-studio"]);
    // And its board was never read — one call, all studios of THAT repo.
    // listIssues is called once per matching studio (the studio label is a
    // server-side GitHub filter), never once for the excluded one.
    expect(listIssues).toHaveBeenCalledTimes(1);
  });

  it("case-insensitive: an uppercase repoSlug row matches the lowercased resolved repo", async () => {
    authorized();
    const api = fakeApi({ listIssues: vi.fn(async () => []) });
    const rows = vi.fn(async () => [row("websites--web-studio", "ACME-ORG/Websites")]);
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach, rows);

    expect(res.status).toBe(200);
    const body = await res.json() as { prs: Record<string, unknown[]> };
    expect(Object.keys(body.prs)).toEqual(["websites--web-studio"]);
  });

  it("a null-repoSlug studio (pre-P4a, cloned from the fleet default) is included when repo == default, excluded otherwise", async () => {
    authorized();
    const rows = vi.fn(async () => [row("websites--legacy-studio", null)]);

    // Default repo (no repo query at all): included.
    const included = await handleBoard(req("/studio/board/open-prs"), testEnv, fakeApi(), reach, rows);
    expect(included.status).toBe(200);
    expect(Object.keys((await included.json() as { prs: Record<string, unknown[]> }).prs))
      .toEqual(["websites--legacy-studio"]);

    // A named non-default repo: a pre-P4a studio was cloned from the fleet
    // default by construction, so it cannot belong to acme-org/beta.
    const excluded = await handleBoard(
      req("/studio/board/open-prs?repo=acme-org/beta"), testEnv, fakeApi(), reach, rows,
    );
    expect(excluded.status).toBe(200);
    expect((await excluded.json() as { prs: Record<string, unknown[]> }).prs).toEqual({});
  });

  it("one studioOpenPrs failure degrades to an empty list for THAT studio — the others intact, still 200", async () => {
    authorized();
    // release-studio's board read fails (`{ok:false}` from listTasks —
    // e.g. an upstream 500); web-studio's succeeds and reports one PR.
    // The plan's ruling: one studio's board trouble must not blank the
    // parker's view of every other lane, and never a 5xx for the route.
    const api = fakeApi({
      listIssues: vi.fn(async (repo: string, _query: { labels?: string[] }) => {
        if (repo === "acme-org/websites" && _query.labels?.includes("studio:websites--release-studio")) {
          throw new Error("GitHub 500");
        }
        return [task()];
      }),
    });
    const rows = vi.fn(async () => [
      row("websites--web-studio", "acme-org/websites"),
      row("websites--release-studio", "acme-org/websites"),
    ]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach, rows);

    expect(res.status).toBe(200);
    const body = await res.json() as { prs: Record<string, unknown[]> };
    // The failed studio reads as an empty list — never absent (its lane
    // exists), never a 5xx.
    expect(body.prs).toEqual({ "websites--web-studio": [], "websites--release-studio": [] });
    expect(errors).toHaveBeenCalled();
  });

  it("POST (or any non-GET verb) is 405", async () => {
    authorized();
    const res = await handleBoard(
      req("/studio/board/open-prs?repo=acme-org/websites", { method: "POST", body: "{}" }),
      testEnv, fakeApi(), reach, vi.fn(async () => []),
    );
    expect(res.status).toBe(405);
  });

  it("a resolveBoardRepo failure passes its status and message through — the same fake reach the reap tests use", async () => {
    authorized();
    const rows = vi.fn(async () => [row("websites--web-studio", "acme-org/websites")]);
    const res = await handleBoard(
      req("/studio/board/open-prs?repo=someone/else"), testEnv, fakeApi(), reach, rows,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("is not reachable by this fleet");
    // The studio set is never even read — a repo this fleet cannot reach
    // has no lanes to warn about.
    expect(rows).not.toHaveBeenCalled();
  });

  it("zero matching studios answers { repo, prs: {} }", async () => {
    authorized();
    const api = fakeApi();
    const rows = vi.fn(async () => [row("beta--web-studio", "acme-org/beta")]);
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach, rows);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repo: "acme-org/websites", prs: {} });
    // No studio of that repo, no board read at all.
    expect(api.listIssues).not.toHaveBeenCalled();
  });
});
