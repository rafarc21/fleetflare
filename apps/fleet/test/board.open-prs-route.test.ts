import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { RepoReach } from "../src/github/reach";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import * as openPrsModule from "../src/board/open-prs";
import { handleBoard } from "../src/board/routes";
import { parseEnvelope, renderEnvelopeComment } from "../src/board/envelope";
import type { BoardApi } from "../src/board/board";
import type { BoardComment } from "../src/board/api";
import { studioLabel, type BoardTask, type EnvelopeDoc } from "../src/board/types";
import type { Env } from "../src/env";
import { recordStudio } from "../src/studio/registry";

// Board issue #332, plan step 2: GET /studio/board/open-prs?repo=<slug> —
// the per-repo unmerged-PR map `fleet ls`'s PRS column and destroy's warning
// both read. Same harness shape as test/board.routes.test.ts: real
// verifyAccess spied away for the authorized cases, every GitHub call behind
// an injected fake BoardApi, and the SAME `reach` fake board.routes.test.ts
// already uses — resolveBoardRepo's reachability seam. The studio set is the
// real registry: the route reads `listStudios(env)` directly (D1 runs fine
// under the test pool — see src/board/routes.ts's own header for why only a
// minted token and a live GitHub call are seam'd), so these tests seed real
// rows with `recordStudio` exactly the way board.routes.test.ts's own
// registry-dependent tests (issue #81) already do. That is also what makes
// the null-repoSlug case faithful: the round trip through recordStudio's
// JSON is the same one production reads.

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

/** Same shape as board.routes.test.ts's own seedStudio: the only fields the
 *  open-prs route reads are `id` and `repoSlug`, so the rest of the row is
 *  the recordStudio-compatible minimal literal that file already uses. */
async function seedStudio(id: string, repoSlug: string | null): Promise<void> {
  await recordStudio(testEnv, { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug });
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

/** One §6 result envelope naming a PR — the same render/parse round trip
 *  test/board.open-prs.test.ts's own envelopeComment uses, so the route's
 *  first test proves the WHOLE chain (listTasks -> showTask ->
 *  findLatestResultEnvelope -> getPullRequest) answers a real OpenPr through
 *  the HTTP boundary, not just an empty-list map. */
let msgCounter = 0;
function envelopeCommentWithPr(pr: string, taskId: number, author: string): BoardComment {
  msgCounter += 1;
  const parsed = parseEnvelope(
    {
      sender: author, intent: "result", status: "ok",
      artifacts: [{ kind: "pr", pr }],
      verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
    },
    taskId, `msg-${msgCounter}`,
  );
  if (!parsed.ok) throw new Error(parsed.message);
  const doc = parsed.doc as EnvelopeDoc;
  return {
    id: msgCounter, url: `u${msgCounter}`, author, createdAt: "2026-10-10T10:00:00Z",
    body: renderEnvelopeComment(doc),
  };
}

// fleet_state is not isolated per test (same as board.routes.test.ts's own
// beforeEach) — these tests write real registry rows, so the sweep is what
// keeps one test's studios out of the next one's map.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("GET /studio/board/open-prs", () => {
  it("200s with prs keyed by studio id — only studios of the requested repo, real PRs through the whole chain", async () => {
    authorized();
    await seedStudio("websites--web-studio", "acme-org/websites");
    await seedStudio("websites--release-studio", "acme-org/websites");
    // web-studio's scan finds task #12 whose newest result envelope names PR
    // #9 — still OPEN and unmerged, so it is exactly what the warning prints.
    // release-studio's board has no PR to report.
    const api = fakeApi({
      listIssues: vi.fn(async (_repo: string, query: { labels?: string[] }) => {
        if (query.labels?.includes(studioLabel("websites--web-studio"))) {
          return [task({ number: 12, labels: ["working", studioLabel("websites--web-studio")] })];
        }
        return [];
      }),
      listComments: vi.fn(async (_repo: string, number: number) =>
        number === 12 ? [envelopeCommentWithPr("9", 12, "websites--web-studio")] : []),
      getPullRequest: vi.fn(async (_repo: string, number: number) =>
        ({ number, merged: false, open: true, title: "feat: the thing" })),
    });
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach);

    expect(res.status).toBe(200);
    const body = await res.json() as { repo: string; prs: Record<string, unknown[]> };
    expect(body.repo).toBe("acme-org/websites");
    // web-studio's lane carries the real OpenPr; release-studio's empty one
    // stays present (its lane exists — an empty list, never absence).
    expect(body.prs).toEqual({
      "websites--web-studio": [{
        taskNumber: 12, prNumber: 9, title: "feat: the thing",
        url: "https://github.com/acme-org/websites/pull/9",
      }],
      "websites--release-studio": [],
    });
    // One scan per studio — the studio label is a server-side GitHub filter,
    // so `listIssues` is called once per matching studio, never per task.
    expect(api.listIssues).toHaveBeenCalledTimes(2);
  });

  it("a studio on ANOTHER repo is excluded — its repoSlug differs from the resolved one", async () => {
    authorized();
    await seedStudio("websites--web-studio", "acme-org/websites");
    await seedStudio("beta--web-studio", "acme-org/beta");
    const api = fakeApi();
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach);

    expect(res.status).toBe(200);
    const body = await res.json() as { prs: Record<string, unknown[]> };
    expect(Object.keys(body.prs)).toEqual(["websites--web-studio"]);
    // The excluded studio's board was never read — one call per studio OF
    // the repo, zero for studios of some other repo.
    expect(api.listIssues).toHaveBeenCalledTimes(1);
  });

  it("case-insensitive: an uppercase repoSlug row matches the lowercased resolved repo", async () => {
    authorized();
    await seedStudio("websites--web-studio", "ACME-ORG/Websites");
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, fakeApi(), reach);

    expect(res.status).toBe(200);
    const body = await res.json() as { prs: Record<string, unknown[]> };
    expect(Object.keys(body.prs)).toEqual(["websites--web-studio"]);
  });

  it("a null-repoSlug studio (pre-P4a, cloned from the fleet default) is included when repo == default, excluded otherwise", async () => {
    authorized();
    await seedStudio("websites--legacy-studio", null);

    // Default repo (no repo query at all): included.
    const included = await handleBoard(req("/studio/board/open-prs"), testEnv, fakeApi(), reach);
    expect(included.status).toBe(200);
    expect(Object.keys((await included.json() as { prs: Record<string, unknown[]> }).prs))
      .toEqual(["websites--legacy-studio"]);

    // A named non-default repo: a pre-P4a studio was cloned from the fleet
    // default by construction, so it cannot belong to acme-org/beta.
    const excluded = await handleBoard(
      req("/studio/board/open-prs?repo=acme-org/beta"), testEnv, fakeApi(), reach,
    );
    expect(excluded.status).toBe(200);
    expect((await excluded.json() as { prs: Record<string, unknown[]> }).prs).toEqual({});
  });

  it("one studioOpenPrs failure degrades to an empty list for THAT studio — the others intact, still 200", async () => {
    authorized();
    await seedStudio("websites--web-studio", "acme-org/websites");
    await seedStudio("websites--release-studio", "acme-org/websites");
    // release-studio's board read fails (an upstream GitHub 500); web-studio's
    // succeeds. The plan's ruling: one studio's board trouble must not blank
    // the parker's view of every other lane, and never a 5xx for the route.
    const api = fakeApi({
      listIssues: vi.fn(async (_repo: string, query: { labels?: string[] }) => {
        if (query.labels?.includes("studio:websites--release-studio")) {
          throw new Error("GitHub 500");
        }
        return [task()];
      }),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach);

    expect(res.status).toBe(200);
    const body = await res.json() as { prs: Record<string, unknown[]> };
    // The failed studio reads as an empty list — never absent (its lane
    // exists), never a 5xx.
    expect(body.prs).toEqual({ "websites--web-studio": [], "websites--release-studio": [] });
    expect(errors).toHaveBeenCalled();
  });

  it("a `{ok:false}` studioOpenPrs answer also degrades to an empty list — the studio and message land in the Worker log", async () => {
    authorized();
    await seedStudio("websites--web-studio", "acme-org/websites");
    await seedStudio("websites--release-studio", "acme-org/websites");
    // The `{ok:false}` leg of the degradation — studioOpenPrs returns a
    // failed BoardResult for one studio (see open-prs.ts's own contract).
    // Driven through the module's public export as a collaborator spy, the
    // same seam board.open-prs.test.ts uses for listTasks, because a
    // `{assignedTo}`-only board read cannot reach a `{ok:false}` through the
    // port alone.
    const bad = { ok: false as const, status: 502, message: "board upstream failed" };
    vi.spyOn(openPrsModule, "studioOpenPrs").mockImplementation(async (_api, _repo, studioId) =>
      studioId === "websites--release-studio" ? bad : { ok: true as const, value: [] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, fakeApi(), reach);

    expect(res.status).toBe(200);
    const body = await res.json() as { prs: Record<string, unknown[]> };
    expect(body.prs).toEqual({ "websites--web-studio": [], "websites--release-studio": [] });
    // The log names the studio AND carries the message verbatim — the
    // operator's only trail that the empty list is "could not look", not
    // "looked and found nothing".
    const logged = errors.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("websites--release-studio");
    expect(logged).toContain("board upstream failed");
  });

  it("POST (or any non-GET verb) is 405", async () => {
    authorized();
    await seedStudio("websites--web-studio", "acme-org/websites");
    const res = await handleBoard(
      req("/studio/board/open-prs?repo=acme-org/websites", { method: "POST", body: "{}" }),
      testEnv, fakeApi(), reach,
    );
    expect(res.status).toBe(405);
  });

  it("a resolveBoardRepo failure passes its status and message through — the same fake reach the reap tests use", async () => {
    authorized();
    await seedStudio("websites--web-studio", "acme-org/websites");
    const api = fakeApi();
    const res = await handleBoard(
      req("/studio/board/open-prs?repo=someone/else"), testEnv, api, reach,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("is not reachable by this fleet");
    // No GitHub call — a repo this fleet cannot reach has no lanes to scan.
    expect(api.listIssues).not.toHaveBeenCalled();
  });

  it("zero matching studios answers { repo, prs: {} }", async () => {
    authorized();
    await seedStudio("beta--web-studio", "acme-org/beta");
    const api = fakeApi();
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, api, reach);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repo: "acme-org/websites", prs: {} });
    // No studio of that repo, no board read at all.
    expect(api.listIssues).not.toHaveBeenCalled();
  });
});
