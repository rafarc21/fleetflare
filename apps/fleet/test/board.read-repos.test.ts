import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleBoard, handleFleetBoard, type PolicyFetch } from "../src/board/routes";
import type { RepoReach } from "../src/github/reach";
import type { BoardApi } from "../src/board/board";
import type { AssignWakeDeps } from "../src/board/assign-wake";
import { studioLabel, type BoardTask } from "../src/board/types";
import * as readReposModule from "../src/github/read-repos";
import { readReposGrantsForStudio, recordReadReposGrant } from "../src/github/read-repos";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// Issue #291: `--read-repos` is the maestro's per-task opt-in. It rides the
// operator's Access-gated board only, is validated BEFORE any GitHub write,
// and becomes a Worker-held D1 grant a studio's own token can never write.

const REPO = "acme-org/websites";
const STUDIO = "websites--web-studio";
// An App-provider owner: read-repos is minted from an installation only.
const testEnv = { ...env, AGENT_REPO: REPO, GITHUB_APP_PRIVATE_KEY: "test-key" } as unknown as Env;
const reach = async (): Promise<RepoReach> => ({ reachable: true });

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/acme-org/websites/issues/12", title: "Research", body: "b",
    state: "submitted", labels: ["submitted", studioLabel(STUDIO)], assignee: STUDIO, milestone: null,
    open: true, updatedAt: "2026-10-09T00:00:00Z", ...overrides,
  };
}

function fakeApi(overrides: Partial<BoardApi> = {}): BoardApi {
  return {
    createIssue: vi.fn(async () => task()),
    getIssue: vi.fn(async () => task({ labels: ["submitted"], assignee: null })),
    listIssues: vi.fn(async () => []),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ id: 1, url: "u" })),
    pullRequestExists: vi.fn(async () => true),
    listComments: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    listOpenPullFiles: vi.fn(async () => []),
    ...overrides,
  };
}

function wakeDeps(): AssignWakeDeps {
  return {
    studioState: async () => ({ state: "stopped", repoSlug: REPO }),
    wake: async () => ({ woke: true }) as never,
    resolveCanonicalRepo: async (slug) => slug,
  };
}

function req(path: string, body: unknown) {
  return new Request(`https://x${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Cf-Access-Jwt-Assertion": "t", "Content-Type": "application/json" },
  });
}

const BRIEF = { title: "Research", objective: "Read siblings", outputFormat: "A report", boundaries: "Read only" };

const board = (r: Request, api: BoardApi) =>
  handleBoard(r, testEnv, api, reach, undefined, undefined, wakeDeps());

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
  // StudioDO cannot be constructed under vitest-pool-workers; the kick is
  // asserted per test below, never sent to a real Durable Object.
  vi.spyOn(readReposModule, "revokeStudioReadToken").mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("operator board: POST /tasks with readRepos", () => {
  it("records the grant for the created task's studio", async () => {
    const api = fakeApi();
    const res = await board(req("/studio/board/tasks", { ...BRIEF, assignee: STUDIO, readRepos: ["acme-org/alpha"] }), api);
    expect(res.status).toBe(200);
    expect(await readReposGrantsForStudio(env.DB, STUDIO))
      .toEqual([{ repo: REPO, number: 12, studioId: STUDIO, repos: ["acme-org/alpha"] }]);
  });

  it("cross-owner is refused 400 BEFORE the issue is filed", async () => {
    const api = fakeApi();
    const res = await board(req("/studio/board/tasks", { ...BRIEF, assignee: STUDIO, readRepos: ["other-org/x"] }), api);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/owner/);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toEqual([]);
  });

  it("more than 15 is refused 400 before any write", async () => {
    const api = fakeApi();
    const many = Array.from({ length: 16 }, (_, i) => `acme-org/r${i}`);
    const res = await board(req("/studio/board/tasks", { ...BRIEF, assignee: STUDIO, readRepos: many }), api);
    expect(res.status).toBe(400);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("refused with no studio to grant it to (no assignee, no continues)", async () => {
    const api = fakeApi();
    const res = await board(req("/studio/board/tasks", { ...BRIEF, readRepos: ["acme-org/alpha"] }), api);
    expect(res.status).toBe(400);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("refused 400 for an owner on the PAT provider — a PAT cannot be made read-only", async () => {
    const api = fakeApi();
    const patEnv = { ...env, AGENT_REPO: REPO, GITHUB_TOKEN: "github_pat_x", GITHUB_APP_ID: "", GITHUB_REPO_AUTH: "" } as unknown as Env;
    const res = await handleBoard(
      req("/studio/board/tasks", { ...BRIEF, assignee: STUDIO, readRepos: ["acme-org/alpha"] }),
      patEnv, api, reach, undefined, undefined, wakeDeps());
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/GitHub App/);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("no readRepos -> no grant at all", async () => {
    await board(req("/studio/board/tasks", { ...BRIEF, assignee: STUDIO }), fakeApi());
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toEqual([]);
  });
});

describe("operator board: POST /tasks/:n/assign with readRepos", () => {
  it("records the grant for the new assignee", async () => {
    const res = await board(req("/studio/board/tasks/12/assign", { assignee: STUDIO, readRepos: ["acme-org/beta"] }), fakeApi());
    expect(res.status).toBe(200);
    expect((await readReposGrantsForStudio(env.DB, STUDIO))[0]?.repos).toEqual(["acme-org/beta"]);
  });

  it("an assign WITHOUT readRepos drops an earlier grant — the opt-in is per assignment", async () => {
    await recordReadReposGrant(env.DB, REPO, 12, "websites--old-studio", ["acme-org/alpha"], 1);
    const res = await board(req("/studio/board/tasks/12/assign", { assignee: STUDIO }), fakeApi());
    expect(res.status).toBe(200);
    expect(await readReposGrantsForStudio(env.DB, "websites--old-studio")).toEqual([]);
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toEqual([]);
  });

  it("cross-owner refused before the label write", async () => {
    const api = fakeApi();
    const res = await board(req("/studio/board/tasks/12/assign", { assignee: STUDIO, readRepos: ["other-org/x"] }), api);
    expect(res.status).toBe(400);
    expect(api.addLabels).not.toHaveBeenCalled();
  });
});

describe("operator board: terminal state revokes the grant", () => {
  it("POST /tasks/:n/state to completed revokes", async () => {
    await recordReadReposGrant(env.DB, REPO, 12, STUDIO, ["acme-org/alpha"], 1);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working", studioLabel(STUDIO)] })) });
    const res = await board(req("/studio/board/tasks/12/state", { from: "working", to: "completed" }), api);
    expect(res.status).toBe(200);
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toEqual([]);
  });
});

// PR #292 review item 2: an un-grant asks the studio to revoke its live read
// token NOW (DELETE /installation/token), not when it expires.
describe("operator board: un-grant revokes the studio's live read token now", () => {
  it("terminal state -> revoke kicked for the studio that held the grant", async () => {
    const kick = vi.spyOn(readReposModule, "revokeStudioReadToken").mockResolvedValue(undefined);
    await recordReadReposGrant(env.DB, REPO, 12, STUDIO, ["acme-org/alpha"], 1);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working", studioLabel(STUDIO)] })) });
    await board(req("/studio/board/tasks/12/state", { from: "working", to: "completed" }), api);
    expect(kick).toHaveBeenCalledWith(expect.anything(), STUDIO);
  });

  it("assign without readRepos -> revoke kicked for the previous holder", async () => {
    const kick = vi.spyOn(readReposModule, "revokeStudioReadToken").mockResolvedValue(undefined);
    await recordReadReposGrant(env.DB, REPO, 12, "websites--old-studio", ["acme-org/alpha"], 1);
    await board(req("/studio/board/tasks/12/assign", { assignee: STUDIO }), fakeApi());
    expect(kick).toHaveBeenCalledWith(expect.anything(), "websites--old-studio");
  });

  it("no kick while the studio still holds another live grant (next refresh narrows it)", async () => {
    const kick = vi.spyOn(readReposModule, "revokeStudioReadToken").mockResolvedValue(undefined);
    await recordReadReposGrant(env.DB, REPO, 12, STUDIO, ["acme-org/alpha"], 1);
    await recordReadReposGrant(env.DB, REPO, 13, STUDIO, ["acme-org/beta"], 1);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working", studioLabel(STUDIO)] })) });
    await board(req("/studio/board/tasks/12/state", { from: "working", to: "completed" }), api);
    expect(kick).not.toHaveBeenCalled();
  });

  it("a kick failure never fails the board write", async () => {
    vi.spyOn(readReposModule, "revokeStudioReadToken").mockRejectedValue(new Error("DO down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await recordReadReposGrant(env.DB, REPO, 12, STUDIO, ["acme-org/alpha"], 1);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "working", labels: ["working", studioLabel(STUDIO)] })) });
    expect((await board(req("/studio/board/tasks/12/state", { from: "working", to: "completed" }), api)).status).toBe(200);
  });
});

describe("studio surface (/fleet/tasks): a studio can never grant read-repos", () => {
  const MAESTRO = "websites--maestro";
  const policy: PolicyFetch = async () => ({ org: { edges: { maestro: ["web-studio"] }, gates: {} }, roles: ["maestro", "web-studio"] });
  async function tokenFor(id: string) {
    const token = mintSpawnToken();
    const rows: StudioStatus[] = [{
      id, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
      burn: null, spawnedBy: null, spawnTokenHash: await hashSpawnToken(token), repoSlug: REPO,
    }];
    return { token, rows: async () => rows };
  }
  const post = (path: string, token: string, body: unknown) => new Request(`https://x${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { [SPAWN_TOKEN_HEADER]: token, "Content-Type": "application/json" },
  });

  it("create with readRepos -> 403, nothing filed", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks", token, { ...BRIEF, assignee: STUDIO, readRepos: ["acme-org/alpha"] }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("assign with readRepos -> 403, nothing written", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks/12/assign", token, { assignee: STUDIO, readRepos: ["acme-org/alpha"] }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(403);
    expect(api.addLabels).not.toHaveBeenCalled();
  });
});
