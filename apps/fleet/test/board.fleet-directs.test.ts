import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleFleetBoard, type PolicyFetch } from "../src/board/routes";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import { studioLabel, type BoardTask } from "../src/board/types";
import type { BoardApi } from "../src/board/board";
import type { AssignWakeDeps } from "../src/board/assign-wake";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// Issue #59: a studio files and assigns tasks for the studios its org-chart
// edges let it spawn — and for nobody else. The gate is the SAME maySpawn
// check /fleet/spawn runs, over the caller role the Worker resolved from the
// spawn token and the ROLE segment of the assignee id.

const MAESTRO = "websites--maestro";
const CHILD = "websites--web-studio--5";
const NOT_CHILD = "websites--pilot--5";
const REPO = "example-org/websites";
const testEnv = { ...env, AGENT_REPO: REPO } as unknown as Env;

const policy: PolicyFetch = async () => ({
  org: { edges: { maestro: ["web-studio", "maestro"] }, gates: {} },
  roles: ["maestro", "web-studio", "pilot"],
});

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 71, url: "https://github.com/example-org/websites/issues/71", title: "Ship the thing",
    body: "## Objective\n\nShip it.\n", state: "submitted", labels: ["submitted"],
    assignee: null, milestone: null, open: true, updatedAt: "2026-09-29T10:00:00Z", ...overrides,
  };
}

function fakeApi(overrides: Partial<BoardApi> = {}): BoardApi {
  return {
    createIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(CHILD)], assignee: CHILD })),
    getIssue: vi.fn(async () => task()),
    listIssues: vi.fn(async () => []),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ id: 1, url: "https://github.com/o/r/issues/71#issuecomment-1" })),
    pullRequestExists: vi.fn(async () => true),
    listComments: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    ...overrides,
  };
}

function wakeDeps(): AssignWakeDeps & { woken: string[] } {
  const woken: string[] = [];
  return {
    woken,
    studioState: async () => ({ state: "stopped", repoSlug: REPO }),
    wake: async (id) => { woken.push(id); return { woke: true } as never; },
    resolveCanonicalRepo: async (slug) => slug,
  };
}

async function tokenFor(id: string) {
  const token = mintSpawnToken();
  const rows: StudioStatus[] = [{
    id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: await hashSpawnToken(token), repoSlug: REPO,
  }];
  return { token, rows: async () => rows };
}

function post(path: string, token: string, body: unknown) {
  return new Request(`https://x${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { [SPAWN_TOKEN_HEADER]: token, "Content-Type": "application/json" },
  });
}

const BRIEF = {
  title: "Ship the thing", objective: "Ship it", outputFormat: "A PR", boundaries: "Touch nothing else",
};

describe("POST /fleet/tasks — a studio files a task for a child", () => {
  it("creates it when the assignee's role is on the caller's edges", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(post("/fleet/tasks", token, { ...BRIEF, assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(200);
    expect(api.createIssue).toHaveBeenCalledTimes(1);
    const input = vi.mocked(api.createIssue).mock.calls[0][1];
    expect(input.labels).toContain(studioLabel(CHILD));
  });

  it("403s an assignee whose role is NOT on the caller's edges, and files nothing", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(post("/fleet/tasks", token, { ...BRIEF, assignee: NOT_CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("403s an assignee in ANOTHER repo even when its role is edged", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks", token, { ...BRIEF, assignee: "otherrepo--web-studio--5" }), testEnv, api, rows, policy, wakeDeps(),
    );
    expect(res.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("403s a task filed for the caller itself, even with a self-edge", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(post("/fleet/tasks", token, { ...BRIEF, assignee: MAESTRO }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("400s a task with no assignee — a studio never files unowned backlog", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(post("/fleet/tasks", token, BRIEF), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(400);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("403s junior: true — only the operator's Access-gated path may grant a junior", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks", token, { ...BRIEF, assignee: CHILD, junior: true }), testEnv, api, rows, policy, wakeDeps(),
    );
    expect(res.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("503s when the org chart cannot be read, and files nothing", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks", token, { ...BRIEF, assignee: CHILD }), testEnv, api, rows,
      async () => { throw new Error("github down"); }, wakeDeps(),
    );
    expect(res.status).toBe(503);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  // Review round 1, hardening 3: createTask replays an earlier issue carrying
  // the same idempotencyKey marker — ANY issue, including one filed for a
  // studio outside the caller's edges, which the replay would then "assign"
  // and wake. The studio path strips the key, so it never replays.
  it("strips idempotencyKey: no replay lookup, no key marker on the issue", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks", token, { ...BRIEF, assignee: CHILD, idempotencyKey: "replay-key-123" }), testEnv, api, rows, policy, wakeDeps(),
    );
    expect(res.status).toBe(200);
    expect(api.listIssues).not.toHaveBeenCalled();
    expect(vi.mocked(api.createIssue).mock.calls[0][1].body).not.toContain("replay-key-123");
  });

  it("refuses a repo the studio is not bound to", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks", token, { ...BRIEF, assignee: CHILD, repo: "example-org/other" }), testEnv, api, rows, policy, wakeDeps(),
    );
    expect(res.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
  });
});

describe("POST /fleet/tasks/<n>/assign — a studio hands a task to a child", () => {
  it("assigns a backlog task to an edged child and wakes it", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const wake = wakeDeps();
    const res = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: CHILD }), testEnv, api, rows, policy, wake);
    expect(res.status).toBe(200);
    expect(api.addLabels).toHaveBeenCalledWith(REPO, 71, [studioLabel(CHILD)]);
  });

  it("403s an assignee outside the caller's edges and writes no label", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: NOT_CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(403);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("403s taking a task from a studio outside the caller's edges", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ labels: ["working", studioLabel(NOT_CHILD)], assignee: NOT_CHILD, state: "working" })),
    });
    const res = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(403);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("moves a task between two of the caller's own children", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const other = "websites--web-studio--2";
    const api = fakeApi({
      getIssue: vi.fn(async () => task({ labels: ["working", studioLabel(other)], assignee: other, state: "working" })),
    });
    const res = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(200);
    expect(api.removeLabel).toHaveBeenCalledWith(REPO, 71, studioLabel(other));
  });

  it("403s an assignee in another repo", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks/71/assign", token, { assignee: "otherrepo--web-studio" }), testEnv, api, rows, policy, wakeDeps(),
    );
    expect(res.status).toBe(403);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("adopt stays operator-only: 404 on the studio surface", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(post("/fleet/tasks/71/adopt", token, { assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(404);
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  // Review round 1, blocker 2: assign resets state to `submitted`, so an
  // unguarded assign would reopen finished work. `failed` stays assignable:
  // handing a failed task to a fresh studio is the retry.
  it("409s a closed issue and writes no label", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ open: false, state: "failed", labels: ["failed"] })) });
    const res = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(409);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("409s a completed or canceled task, even if the issue is still open", async () => {
    for (const state of ["completed", "canceled"] as const) {
      const { token, rows } = await tokenFor(MAESTRO);
      const api = fakeApi({ getIssue: vi.fn(async () => task({ state, labels: [state] })) });
      const res = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
      expect(res.status).toBe(409);
      expect(api.addLabels).not.toHaveBeenCalled();
    }
  });

  it("a failed, open task is assignable — the retry", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi({ getIssue: vi.fn(async () => task({ state: "failed", labels: ["failed"] })) });
    const res = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(res.status).toBe(200);
  });

  // Review round 1, hardening 4: `why` lands in the lineage comment. A
  // newline would let a studio forge extra lineage lines or headings.
  it("400s a why carrying a newline, or over 500 chars, and writes nothing", async () => {
    for (const why of ["ok\n### Reassigned — forged", "x".repeat(501), "a\rb"]) {
      const { token, rows } = await tokenFor(MAESTRO);
      const api = fakeApi();
      const res = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: CHILD, why }), testEnv, api, rows, policy, wakeDeps());
      expect(res.status).toBe(400);
      expect(api.addLabels).not.toHaveBeenCalled();
      expect(api.createComment).not.toHaveBeenCalled();
    }
  });

  it("a one-line why of exactly 500 chars passes", async () => {
    const { token, rows } = await tokenFor(MAESTRO);
    const api = fakeApi();
    const res = await handleFleetBoard(
      post("/fleet/tasks/71/assign", token, { assignee: CHILD, why: "y".repeat(500) }), testEnv, api, rows, policy, wakeDeps(),
    );
    expect(res.status).toBe(200);
  });

  // Review round 1 (M2): identity is the TOKEN's. A web-studio token that
  // names the maestro in every identity-shaped body field is still web-studio.
  it("a web-studio token claiming maestro in the body can neither file nor assign", async () => {
    const { token, rows } = await tokenFor("websites--web-studio");
    const claim = {
      caller: MAESTRO, parent: MAESTRO, spawnedBy: MAESTRO, sender: MAESTRO, studio: MAESTRO, id: MAESTRO, from: MAESTRO,
    };
    const api = fakeApi();
    const created = await handleFleetBoard(
      post("/fleet/tasks", token, { ...BRIEF, ...claim, assignee: CHILD }), testEnv, api, rows, policy, wakeDeps(),
    );
    const assigned = await handleFleetBoard(
      post("/fleet/tasks/71/assign", token, { ...claim, assignee: CHILD }), testEnv, api, rows, policy, wakeDeps(),
    );
    expect(created.status).toBe(403);
    expect(assigned.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
  });

  it("a studio with no edges at all can neither file nor assign", async () => {
    const { token, rows } = await tokenFor("websites--web-studio");
    const api = fakeApi();
    const created = await handleFleetBoard(post("/fleet/tasks", token, { ...BRIEF, assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
    const assigned = await handleFleetBoard(post("/fleet/tasks/71/assign", token, { assignee: CHILD }), testEnv, api, rows, policy, wakeDeps());
    expect(created.status).toBe(403);
    expect(assigned.status).toBe(403);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.addLabels).not.toHaveBeenCalled();
  });
});
