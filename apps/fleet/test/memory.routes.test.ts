import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleMemory, MEMORY_SURVEY_MAX_FILES, type MemoryDeps } from "../src/memory/routes";
import { MEMORY_INDEX_PATH } from "../src/memory/index-file";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// GET/POST /studio/memory* and /fleet/memory* — P5 §9's compaction pass.
//
// Same posture as test/board.routes.test.ts: every GitHub call is behind the
// injected MemoryDeps port, and verifyAccess is stubbed so the Access surface
// is exercised without a live JWT. The spawn surface's auth is NOT stubbed —
// it is the boundary a container actually crosses, so it runs for real against
// injected registry rows.

const REPO = "acme-org/websites";
const BLUEPRINT = "acme-org/websites";
const testEnv = { ...env, AGENT_REPO: REPO } as unknown as Env;
const NOW = new Date("2026-09-10T12:00:00.000Z");
const OLD = "2026-08-01T10-00-00-000Z";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
});

function memFile(studio: string, i: number, slug: string, description: string) {
  const name = `${OLD}-${i}-${slug}`;
  return {
    path: `fleet/memory/${studio}/${name}.md`,
    content: `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: learning\n---\n\n${description}\n`,
  };
}

const CF = memFile("websites--pilot", 0, "cf-rollout", "bump rollout_step_percentage to 100, the VERSION column lies");
const IPV6 = memFile("websites--web-studio", 1, "ipv6-bind", "curl 127.0.0.1 fakes a dead server when astro binds [::1]");
const FILES = [CF, IPV6];

function fakeDeps(overrides: Partial<MemoryDeps> = {}): MemoryDeps {
  const byPath = new Map(FILES.map((f) => [f.path, f.content]));
  return {
    memoryRepo: vi.fn(async () => BLUEPRINT),
    defaultBranch: vi.fn(async () => "main"),
    listTree: vi.fn(async () => [...byPath.keys(), "README.md"]),
    fetchFile: vi.fn(async (_r: string, path: string) => {
      const c = byPath.get(path);
      if (c === undefined) throw new Error(`fetch ${path}@main failed (404): Not Found`);
      return c;
    }),
    taskTexts: vi.fn(async () => ({ citations: [], truncated: false })),
    commit: vi.fn(async () => "newcommit"),
    openPr: vi.fn(async () => ({ number: 91, url: "https://github.com/acme-org/websites/pull/91" })),
    studios: vi.fn(async () => []),
    now: () => NOW,
    ...overrides,
  };
}

const get = (path = "/studio/memory") => new Request(`https://w${path}`, { headers: { "Cf-Access-Jwt-Assertion": "j" } });
const post = (body: unknown, path = "/studio/memory/compact") =>
  new Request(`https://w${path}`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": "j", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /studio/memory — what an agent reads before it proposes anything", () => {
  it("surveys the blueprint repo at its DEFAULT branch, where harvest writes", async () => {
    const deps = fakeDeps();
    const res = await handleMemory(get(), testEnv, deps);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.repo).toBe(BLUEPRINT);
    expect(body.ref).toBe("main");
    expect(deps.listTree).toHaveBeenCalledWith(BLUEPRINT, "main");
  });

  // #341: no store configured (FLEET_OPS_REPO unset) is a clear refusal, never
  // a survey of some other repo.
  it("memory store off: survey and compaction both answer 409 and name the setting, and touch no repo", async () => {
    const deps = fakeDeps({ memoryRepo: vi.fn(async () => null) });
    for (const req of [get(), post({})]) {
      const res = await handleMemory(req, testEnv, deps);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("FLEET_OPS_REPO");
    }
    expect(deps.listTree).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it("bootstraps a line per file when there is no INDEX.md, and says so", async () => {
    const body = await (await handleMemory(get(), testEnv, fakeDeps())).json<any>();
    expect(body.index).toHaveLength(2);
    expect(body.unindexed).toHaveLength(2);
    expect(body.index[0].summary).toBe("bump rollout_step_percentage to 100, the VERSION column lies");
  });

  it("names the demotion candidates with the numbers behind them", async () => {
    const body = await (await handleMemory(get(), testEnv, fakeDeps())).json<any>();
    expect(body.candidates.demote).toHaveLength(2);
    expect(body.files[0].citations).toBe(0);
    expect(body.files[0].verdict).toBe("demote");
  });

  it("counts citations from the BOARD repo, which is not necessarily the blueprint repo", async () => {
    const deps = fakeDeps({
      taskTexts: vi.fn(async () => ({ citations: [{ number: 5, text: `per ${OLD}-0-cf-rollout` }], truncated: false })),
    });
    const res = await handleMemory(new Request("https://w/studio/memory?repo=Other/Board", {
      headers: { "Cf-Access-Jwt-Assertion": "j" },
    }), testEnv, deps);
    const body = await res.json<any>();
    expect(deps.taskTexts).toHaveBeenCalledWith("other/board");
    expect(body.files.find((f: any) => f.target.includes("cf-rollout")).citations).toBe(1);
    expect(body.candidates.keep).toHaveLength(1);
  });

  // Issue #187: hitting board/api.ts's TASK_TEXTS_MAX_PAGES bound used to be
  // invisible to every caller of this route — the survey looked complete even
  // when some issues' comments were never scanned. `taskTexts` now carries a
  // `truncated` flag alongside the citations, and the survey response must
  // pass it straight through so `fleet memory ls` can warn instead of showing
  // a normal-looking, silently-incomplete survey.
  it("reports truncated: false on a complete citation survey", async () => {
    const body = await (await handleMemory(get(), testEnv, fakeDeps())).json<any>();
    expect(body.truncated).toBe(false);
  });

  it("reports truncated: true when taskTexts hit its page bound", async () => {
    const deps = fakeDeps({ taskTexts: vi.fn(async () => ({ citations: [], truncated: true })) });
    const body = await (await handleMemory(get(), testEnv, deps)).json<any>();
    expect(body.truncated).toBe(true);
  });

  it("a non-404 failure fetching INDEX.md is NOT read as 'there is no index'", async () => {
    const deps = fakeDeps({
      fetchFile: vi.fn(async (_r: string, path: string) => {
        if (path === MEMORY_INDEX_PATH) throw new Error("fetch INDEX.md@main failed (500): boom");
        return "x";
      }),
    });
    const res = await handleMemory(get(), testEnv, deps);
    expect(res.status).toBe(502);
  });

  it("refuses a tree bigger than one pass reads rather than surveying a subset", async () => {
    const many = Array.from({ length: MEMORY_SURVEY_MAX_FILES + 1 }, (_, i) => `fleet/memory/s/${i}.md`);
    const res = await handleMemory(get(), testEnv, fakeDeps({ listTree: vi.fn(async () => many) }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(new RegExp(String(MEMORY_SURVEY_MAX_FILES)));
  });

  it("405s a POST to the survey and a GET to compact", async () => {
    expect((await handleMemory(post({}, "/studio/memory"), testEnv, fakeDeps())).status).toBe(405);
    expect((await handleMemory(get("/studio/memory/compact"), testEnv, fakeDeps())).status).toBe(405);
  });

  it("404s any other path under the prefix", async () => {
    expect((await handleMemory(get("/studio/memory/nope"), testEnv, fakeDeps())).status).toBe(404);
  });

  it("refuses when Access does", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(new Response("unauthorized", { status: 401 }));
    expect((await handleMemory(get(), testEnv, fakeDeps())).status).toBe(401);
  });
});

describe("POST /studio/memory/compact — the PR, and every refusal before it", () => {
  it("commits one branch and opens ONE pull request, never a direct commit to the default branch", async () => {
    const deps = fakeDeps();
    const res = await handleMemory(post({ proposal: { demote: [`websites--pilot/${OLD}-0-cf-rollout.md`] } }), testEnv, deps);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.pr).toBe(91);
    expect(body.url).toBe("https://github.com/acme-org/websites/pull/91");
    expect(body.truncated).toBe(false);
    const [repo, base, branch, , changes] = (deps.commit as any).mock.calls[0];
    expect(repo).toBe(BLUEPRINT);
    expect(base).toBe("main");
    expect(branch).toMatch(/^fleet\/memory-compaction-/);
    // the demoted file MOVED — a create at archive/ and a removal of the original
    expect(changes).toContainEqual({ path: `fleet/memory/archive/websites--pilot/${OLD}-0-cf-rollout.md`, content: CF.content });
    expect(changes).toContainEqual({ path: CF.path, content: null });
    const [prRepo, head, prBase] = (deps.openPr as any).mock.calls[0];
    expect([prRepo, head, prBase]).toEqual([BLUEPRINT, branch, "main"]);
  });

  it("accepts the proposal at the top level too — an agent should not have to guess the envelope", async () => {
    const deps = fakeDeps();
    const res = await handleMemory(post({ demote: [`websites--pilot/${OLD}-0-cf-rollout.md`] }), testEnv, deps);
    expect(res.status).toBe(200);
    expect(deps.commit).toHaveBeenCalled();
  });

  it("reports truncated: true on the compact response too, when the citation survey behind it was truncated", async () => {
    const deps = fakeDeps({ taskTexts: vi.fn(async () => ({ citations: [], truncated: true })) });
    const res = await handleMemory(post({}), testEnv, deps);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.truncated).toBe(true);
  });

  it("a refused proposal never touches GitHub", async () => {
    const deps = fakeDeps({
      taskTexts: vi.fn(async () => ({ citations: [{ number: 5, text: `${OLD}-0-cf-rollout` }], truncated: false })),
    });
    const res = await handleMemory(post({ demote: [`websites--pilot/${OLD}-0-cf-rollout.md`] }), testEnv, deps);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/cited by 1/);
    expect(deps.commit).not.toHaveBeenCalled();
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it("a merge that destroys a specific is refused with the specific named", async () => {
    const deps = fakeDeps();
    const res = await handleMemory(post({
      merges: [{ title: "CF", summary: "bump the percentage", sources: [`websites--pilot/${OLD}-0-cf-rollout.md`, `websites--web-studio/${OLD}-1-ipv6-bind.md`] }],
    }), testEnv, deps);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/100/);
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it("an empty proposal still writes the index — the bootstrap run", async () => {
    const deps = fakeDeps();
    const res = await handleMemory(post({}), testEnv, deps);
    expect(res.status).toBe(200);
    const changes = (deps.commit as any).mock.calls[0][4];
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe(MEMORY_INDEX_PATH);
  });

  it("surfaces a missing pull_requests permission instead of reporting success", async () => {
    const deps = fakeDeps({
      openPr: vi.fn(async () => { throw new Error("open pull request failed (403): Resource not accessible by integration"); }),
    });
    const res = await handleMemory(post({}), testEnv, deps);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/not accessible by integration/);
  });
});

describe("/fleet/memory — the Release Studio's surface, spawn-token authed", () => {
  async function tokenFor(id: string) {
    const token = mintSpawnToken();
    const row: StudioStatus = {
      id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null,
      spawnTokenHash: await hashSpawnToken(token), repoSlug: REPO,
    };
    return { token, studios: async () => [row] };
  }

  it("a live spawn token surveys memory with no Access JWT at all", async () => {
    const { token, studios } = await tokenFor("websites--release-studio");
    const res = await handleMemory(
      new Request("https://w/fleet/memory", { headers: { [SPAWN_TOKEN_HEADER]: token } }),
      testEnv, fakeDeps({ studios }),
    );
    expect(res.status).toBe(200);
  });

  it("no token, a malformed token, and an unknown token are all 401 — and cost no GitHub call", async () => {
    const { studios } = await tokenFor("websites--release-studio");
    const deps = fakeDeps({ studios });
    const cases: Record<string, string>[] = [{}, { [SPAWN_TOKEN_HEADER]: "nope" }, { [SPAWN_TOKEN_HEADER]: mintSpawnToken() }];
    for (const headers of cases) {
      const res = await handleMemory(new Request("https://w/fleet/memory", { headers }), testEnv, deps);
      expect(res.status).toBe(401);
    }
    expect(deps.memoryRepo).not.toHaveBeenCalled();
  });

  it("a studio can run the compaction pass at sprint close", async () => {
    const { token, studios } = await tokenFor("websites--release-studio");
    const deps = fakeDeps({ studios });
    const res = await handleMemory(new Request("https://w/fleet/memory/compact", {
      method: "POST", headers: { [SPAWN_TOKEN_HEADER]: token, "Content-Type": "application/json" }, body: "{}",
    }), testEnv, deps);
    expect(res.status).toBe(200);
    expect(deps.openPr).toHaveBeenCalled();
  });
});
