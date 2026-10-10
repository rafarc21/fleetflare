import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { leakGuard, guardBoardApi, LeakGateError, type LeakGuardDeps } from "../src/board/leak";
import { githubBoardApi, handleFleetBoard } from "../src/board/routes";
import { repoIsPrivate } from "../src/github/api";
import { GitHubError } from "../src/board/api";
import { LEAK_DENYLIST_MISSING, LEAK_SCAN_ERROR } from "../src/leak-gate";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import { studioLabel, type BoardTask } from "../src/board/types";
import type { BoardApi } from "../src/board/board";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// Issue #1 piece 4: every board write (issue, comment, envelope) is scanned
// against the ops-repo denylist before it reaches a PUBLIC repo. Fake terms
// only -- this repo is public.

const TERM = "acmeclient";
const LIST = `999999999\n${TERM}\n`;
const REPO = "acme-org/websites";

function deps(overrides: Partial<LeakGuardDeps> = {}): LeakGuardDeps {
  return {
    isPrivate: vi.fn(async () => false),
    fetchDenylist: vi.fn(async () => LIST),
    ...overrides,
  };
}

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 71, url: `https://github.com/${REPO}/issues/71`, title: "Ship the thing",
    body: "Ship it.", state: "submitted", labels: ["submitted"], assignee: null,
    milestone: null, open: true, updatedAt: "2026-08-25T10:00:00Z", ...overrides,
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
    listMilestones: vi.fn(async () => []),
    branchExists: vi.fn(async () => true),
    commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    listOpenPullFiles: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ number: 0, merged: false, open: true, title: "" })),
    ...overrides,
  };
}

async function refusal(p: Promise<unknown>): Promise<LeakGateError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(LeakGateError);
  expect(err).toBeInstanceOf(GitHubError);
  return err as LeakGateError;
}

describe("guardBoardApi -- comments", () => {
  it("422s a hit in a comment body, never posts, names the index not the term", async () => {
    const inner = fakeApi();
    const api = guardBoardApi(inner, leakGuard(deps()));
    const err = await refusal(api.createComment(REPO, 71, `notes for ${TERM.toUpperCase()} rollout`));
    expect(err.status).toBe(422);
    expect(err.message).toContain("#2");
    expect(err.message.toLowerCase()).not.toContain(TERM);
    expect(inner.createComment).not.toHaveBeenCalled();
  });

  it("posts a clean comment through to the inner api", async () => {
    const inner = fakeApi();
    const api = guardBoardApi(inner, leakGuard(deps()));
    await api.createComment(REPO, 71, "all clean");
    expect(inner.createComment).toHaveBeenCalledWith(REPO, 71, "all clean");
  });
});

describe("guardBoardApi -- issues", () => {
  it("refuses a hit in the issue title", async () => {
    const inner = fakeApi();
    const api = guardBoardApi(inner, leakGuard(deps()));
    const err = await refusal(api.createIssue(REPO, { title: `${TERM} onboarding`, body: "clean", labels: [] }));
    expect(err.status).toBe(422);
    expect(inner.createIssue).not.toHaveBeenCalled();
  });

  it("refuses a hit in the issue body", async () => {
    const inner = fakeApi();
    const api = guardBoardApi(inner, leakGuard(deps()));
    const err = await refusal(api.createIssue(REPO, { title: "clean", body: "id 999999999", labels: [] }));
    expect(err.message).toContain("#1");
    expect(inner.createIssue).not.toHaveBeenCalled();
  });

  it("posts a clean issue", async () => {
    const inner = fakeApi();
    const api = guardBoardApi(inner, leakGuard(deps()));
    await api.createIssue(REPO, { title: "clean", body: "clean", labels: ["submitted"] });
    expect(inner.createIssue).toHaveBeenCalledOnce();
  });
});

describe("leakGuard -- fail closed", () => {
  it("503s when the denylist is unavailable -- a missing list never passes", async () => {
    const check = leakGuard(deps({ fetchDenylist: async () => { throw new Error("404 Not Found"); } }));
    const err = await refusal(check(REPO, ["all clean"]));
    expect(err.status).toBe(503);
    expect(err.message).toBe(LEAK_DENYLIST_MISSING);
  });

  it("503s an empty denylist -- zero patterns would pass everything", async () => {
    const check = leakGuard(deps({ fetchDenylist: async () => "\n  \n" }));
    const err = await refusal(check(REPO, ["all clean"]));
    expect(err.status).toBe(503);
    expect(err.message).toBe(LEAK_DENYLIST_MISSING);
  });

  it("503s a bad regex -- a scanner error is never swallowed as a pass", async () => {
    const check = leakGuard(deps({ fetchDenylist: async () => "ok\n(unclosed\n" }));
    const err = await refusal(check(REPO, ["all clean"]));
    expect(err.status).toBe(503);
    expect(err.message).toBe(LEAK_SCAN_ERROR);
  });

  // Mutant: the Worker accepts a list the container's grep -E reads
  // differently (`\d` = literal d there) -> one side of the gate fails open.
  it("503s a pattern grep -E and JS read differently -- refused at parse, never scanned", async () => {
    const check = leakGuard(deps({ fetchDenylist: async () => "ok\nacme-secret-\\d+\n" }));
    const err = await refusal(check(REPO, ["all clean"]));
    expect(err.status).toBe(503);
    expect(err.message).toBe(LEAK_DENYLIST_MISSING);
  });

  it("scans as public when isPrivate throws", async () => {
    const check = leakGuard(deps({ isPrivate: async () => { throw new Error("403"); } }));
    expect((await refusal(check(REPO, [TERM]))).status).toBe(422);
  });

  it("lets a hit through on a confirmed-private repo, without reading the list", async () => {
    const d = deps({ isPrivate: vi.fn(async () => true) });
    await expect(leakGuard(d)(REPO, [TERM])).resolves.toBeUndefined();
    expect(d.fetchDenylist).not.toHaveBeenCalled();
  });

  it("fetches the denylist once per guard instance", async () => {
    const d = deps();
    const check = leakGuard(d);
    await check(REPO, ["a"]);
    await check(REPO, ["b"]);
    expect(d.fetchDenylist).toHaveBeenCalledOnce();
  });
});

describe("githubBoardApi -- guard deps injectable", () => {
  it("refuses a hit before minting any token", async () => {
    const api = githubBoardApi(env as unknown as Env, deps());
    const err = await refusal(api.createComment(REPO, 71, TERM));
    expect(err.status).toBe(422);
  });

  it("with FLEET_OPS_REPO unset, refuses public writes (fail closed)", async () => {
    const e = { ...env, FLEET_OPS_REPO: undefined } as unknown as Env;
    const api = githubBoardApi(e, { isPrivate: async () => false });
    const err = await refusal(api.createComment(REPO, 71, "clean"));
    expect(err.status).toBe(503);
  });
});

describe("repoIsPrivate", () => {
  let realFetch: typeof globalThis.fetch;
  let respond: () => Response;
  const urls: string[] = [];
  beforeEach(() => {
    realFetch = globalThis.fetch;
    urls.length = 0;
    globalThis.fetch = (async (input: any) => {
      urls.push(typeof input === "string" ? input : input.url);
      return respond();
    }) as typeof globalThis.fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("reads GitHub's own private flag", async () => {
    respond = () => Response.json({ private: true });
    expect(await repoIsPrivate("tok", "o/r")).toBe(true);
    expect(urls[0]).toBe("https://api.github.com/repos/o/r");
    respond = () => Response.json({ private: false });
    expect(await repoIsPrivate("tok", "o/r")).toBe(false);
  });

  it("throws on non-2xx -- the caller treats that as public", async () => {
    respond = () => new Response("nope", { status: 403 });
    await expect(repoIsPrivate("tok", "o/r")).rejects.toThrow(/403/);
  });
});

describe("envelope route -- end to end", () => {
  const MINE = "websites--web-studio";
  function row(hash: string): StudioStatus {
    return {
      id: MINE, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug: REPO,
    };
  }

  it("surfaces a leak refusal to the lead as 422 with the index, never 502", async () => {
    const token = mintSpawnToken();
    const rows = [row(await hashSpawnToken(token))];
    const inner = fakeApi({
      getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(MINE)], assignee: MINE })),
    });
    const res = await handleFleetBoard(
      new Request("https://x/fleet/tasks/71/envelope", {
        method: "POST",
        headers: { [SPAWN_TOKEN_HEADER]: token, "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "result", status: "ok", notes: `shipped for ${TERM}`, verification: { url: "https://x.test", steps: ["open it"], expected: "it works" } }),
      }),
      { ...env, AGENT_REPO: REPO } as unknown as Env,
      guardBoardApi(inner, leakGuard(deps())),
      async () => rows,
    );
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("#2");
    expect(text.toLowerCase()).not.toContain(TERM);
    expect(inner.createComment).not.toHaveBeenCalled();
  });

  it("surfaces a missing denylist as 503 with its message", async () => {
    const token = mintSpawnToken();
    const rows = [row(await hashSpawnToken(token))];
    const inner = fakeApi({
      getIssue: vi.fn(async () => task({ labels: ["submitted", studioLabel(MINE)], assignee: MINE })),
    });
    const res = await handleFleetBoard(
      new Request("https://x/fleet/tasks/71/envelope", {
        method: "POST",
        headers: { [SPAWN_TOKEN_HEADER]: token, "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "result", status: "ok", verification: { url: "https://x.test", steps: ["open it"], expected: "it works" } }),
      }),
      { ...env, AGENT_REPO: REPO } as unknown as Env,
      guardBoardApi(inner, leakGuard(deps({ fetchDenylist: async () => { throw new Error("gone"); } }))),
      async () => rows,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(LEAK_DENYLIST_MISSING);
  });
});
