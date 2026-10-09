import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { mintReadReposToken } from "../src/github/auth";
import { MintTokenError } from "../src/github/mint-token-error";
import {
  READ_REPOS_MAX, READ_REPOS_PERMISSIONS, parseReadRepos, recordReadReposGrant, revokeReadReposGrant,
  readReposGrantsForStudio, studioReadReposCredential, swapStoredReadToken, revokeInstallationToken,
} from "../src/github/read-repos";
import type { BoardTask } from "../src/board/types";
import type { Env } from "../src/env";

// Issue #291: a research task may READ sibling repos of its own repo's owner.
// The studio's primary token stays scoped to its one work repo; a SECOND,
// read-only installation token covers exactly the repos the maestro listed.

const TASK_REPO = "acme-org/websites";
const STUDIO = "websites--web-studio";
const OTHER = "websites--release-studio";

let pem: string;
let calls: { url: string; method: string; body: string | undefined }[] = [];
let realFetch: typeof globalThis.fetch;
/** What the stub answers; the mint POST by default echoes GitHub's shape. */
let answer: (url: string, method: string) => Response;

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
});

const appEnv = (): Env => ({
  ...env, GITHUB_APP_ID: "1111111", GITHUB_INSTALLATION_ID: "2222222", GITHUB_APP_PRIVATE_KEY: pem,
}) as unknown as Env;
const PAT = "github_pat_11ABCDEF0_exampleexampleexample";
const tokenOnlyEnv = (): Env => ({ ...env, GITHUB_TOKEN: PAT }) as unknown as Env;

const READ_TOKEN = "ghs_READONLYsiblingtoken";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  answer = () => Response.json({ token: READ_TOKEN });
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    return answer(url, method);
  }) as typeof globalThis.fetch;
});
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe("READ_REPOS_PERMISSIONS", () => {
  it("is exactly contents:read + metadata:read — nothing else, nothing writable", () => {
    expect(READ_REPOS_PERMISSIONS).toEqual({ contents: "read", metadata: "read" });
    expect(Object.isFrozen(READ_REPOS_PERMISSIONS)).toBe(true);
  });
});

describe("parseReadRepos", () => {
  it("absent, null and an empty list all mean no opt-in", () => {
    expect(parseReadRepos(undefined, TASK_REPO)).toEqual({ ok: true, repos: [] });
    expect(parseReadRepos(null, TASK_REPO)).toEqual({ ok: true, repos: [] });
    expect(parseReadRepos([], TASK_REPO)).toEqual({ ok: true, repos: [] });
  });

  it("accepts same-owner owner/name repos, lowercased and de-duplicated", () => {
    expect(parseReadRepos(["acme-org/alpha", "Acme-Org/Beta", "acme-org/alpha"], TASK_REPO))
      .toEqual({ ok: true, repos: ["acme-org/alpha", "acme-org/beta"] });
  });

  it("refuses a repo of a different owner — a different installation", () => {
    const r = parseReadRepos(["acme-org/alpha", "other-org/secret"], TASK_REPO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/other-org\/secret/);
    if (!r.ok) expect(r.message).toMatch(/owner/);
  });

  it(`refuses more than ${READ_REPOS_MAX} repos`, () => {
    expect(READ_REPOS_MAX).toBe(15);
    const many = Array.from({ length: 16 }, (_, i) => `acme-org/r${i}`);
    const r = parseReadRepos(many, TASK_REPO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/15/);
    expect(parseReadRepos(many.slice(0, 15), TASK_REPO).ok).toBe(true);
  });

  it("refuses anything that is not a plain owner/name", () => {
    for (const bad of ["alpha", "acme-org/", "/alpha", "acme-org/a/b", "acme-org/a b", "acme-org/a'b",
      "acme-org/..", "acme-org/.", "https://github.com/acme-org/a", "acme-org/a;rm"]) {
      expect(parseReadRepos([bad], TASK_REPO).ok, bad).toBe(false);
    }
  });

  it("refuses a non-array or non-string entry rather than guessing", () => {
    expect(parseReadRepos("acme-org/a", TASK_REPO).ok).toBe(false);
    expect(parseReadRepos([42], TASK_REPO).ok).toBe(false);
  });
});

describe("mintReadReposToken", () => {
  it("asks GitHub for exactly the read-only permissions, scoped to exactly the listed repos", async () => {
    const minted = await mintReadReposToken(appEnv(), TASK_REPO, ["acme-org/alpha", "acme-org/beta"]);
    expect(minted.token).toBe(READ_TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/app/installations/2222222/access_tokens");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      repositories: ["alpha", "beta"],
      permissions: { contents: "read", metadata: "read" },
    });
  });

  // PR #292 review item 3: git's credential URL match is case-sensitive on
  // the path, so the helper needs GitHub's canonical casing, not only ours.
  it("returns GitHub's canonical full names from the mint response", async () => {
    answer = () => Response.json({ token: READ_TOKEN, repositories: [{ full_name: "Acme-Org/Alpha" }, { full_name: "acme-org/beta" }] });
    const minted = await mintReadReposToken(appEnv(), TASK_REPO, ["acme-org/alpha", "acme-org/beta"]);
    expect(minted).toEqual({ token: READ_TOKEN, canonical: ["Acme-Org/Alpha", "acme-org/beta"] });
  });

  it("refuses a cross-owner repo before any GitHub call", async () => {
    await expect(mintReadReposToken(appEnv(), TASK_REPO, ["other-org/secret"])).rejects.toThrow(/owner/);
    expect(calls).toHaveLength(0);
  });

  it("refuses more than 15 repos before any GitHub call", async () => {
    const many = Array.from({ length: 16 }, (_, i) => `acme-org/r${i}`);
    await expect(mintReadReposToken(appEnv(), TASK_REPO, many)).rejects.toThrow(/15/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty list — no opt-in never mints", async () => {
    await expect(mintReadReposToken(appEnv(), TASK_REPO, [])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("refuses the PAT provider — a fine-grained PAT cannot be narrowed to read-only", async () => {
    await expect(mintReadReposToken(tokenOnlyEnv(), TASK_REPO, ["acme-org/alpha"])).rejects.toThrow(/GitHub App/);
    expect(calls).toHaveLength(0);
  });
});

describe("read-repos grant record (D1, Worker-held)", () => {
  it("no grant -> nothing for the studio", async () => {
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toEqual([]);
  });

  it("a recorded grant is read back for its studio only", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/alpha"], 1000);
    expect(await readReposGrantsForStudio(env.DB, STUDIO))
      .toEqual([{ repo: TASK_REPO, number: 7, studioId: STUDIO, repos: ["acme-org/alpha"] }]);
    expect(await readReposGrantsForStudio(env.DB, OTHER)).toEqual([]);
  });

  it("revoke removes it", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/alpha"], 1000);
    await revokeReadReposGrant(env.DB, TASK_REPO, 7);
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toEqual([]);
  });

  it("a malformed row reads as no grant (fail closed)", async () => {
    await env.DB.prepare("INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)")
      .bind(`read-repos:${TASK_REPO}:9`, "{not json", 1).run();
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toEqual([]);
  });
});

function liveTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 7, url: "u", title: "t", body: "b", state: "working", labels: ["working", `studio:${STUDIO}`],
    assignee: STUDIO, milestone: null, open: true, updatedAt: "2026-10-09T00:00:00Z", ...overrides,
  };
}

describe("studioReadReposCredential (the refresh cycle's port)", () => {
  it("no opt-in -> null and no token minted at all", async () => {
    const getTask = vi.fn(async () => liveTask());
    expect(await studioReadReposCredential(appEnv(), STUDIO, { getTask })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(getTask).not.toHaveBeenCalled();
  });

  it("a live grant mints one read-only token over the union of the studio's granted repos", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/alpha"], 1000);
    await recordReadReposGrant(env.DB, TASK_REPO, 8, STUDIO, ["acme-org/beta", "acme-org/alpha"], 1000);
    const getTask = vi.fn(async (_r: string, n: number) => liveTask({ number: n }));
    answer = () => Response.json({ token: READ_TOKEN, repositories: [{ full_name: "Acme-Org/Alpha" }, { full_name: "acme-org/beta" }] });
    const got = await studioReadReposCredential(appEnv(), STUDIO, { getTask });
    // Lowercase (what was granted) plus GitHub's canonical casing.
    expect(got).toEqual({ token: READ_TOKEN, repos: ["Acme-Org/Alpha", "acme-org/alpha", "acme-org/beta"] });
    expect(JSON.parse(calls[0]!.body!).permissions).toEqual({ contents: "read", metadata: "read" });
  });

  it("a grant whose task finished, closed or moved to another studio is revoked, not minted", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/alpha"], 1000);
    await recordReadReposGrant(env.DB, TASK_REPO, 8, STUDIO, ["acme-org/beta"], 1000);
    await recordReadReposGrant(env.DB, TASK_REPO, 9, STUDIO, ["acme-org/gamma"], 1000);
    const getTask = vi.fn(async (_r: string, n: number) =>
      n === 7 ? liveTask({ number: 7, state: "completed" })
        : n === 8 ? liveTask({ number: 8, open: false })
          : liveTask({ number: 9, assignee: OTHER, labels: ["working", `studio:${OTHER}`] }));
    expect(await studioReadReposCredential(appEnv(), STUDIO, { getTask })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toEqual([]);
  });

  it("audit log names studio, task and repos — never the token", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/alpha"], 1000);
    const logs: string[] = [];
    const capture = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    await studioReadReposCredential(appEnv(), STUDIO, { getTask: async () => liveTask() });
    const all = logs.join("\n");
    expect(all).toContain(STUDIO);
    expect(all).toContain(`${TASK_REPO}#7`);
    expect(all).toContain("acme-org/alpha");
    expect(all).not.toContain(READ_TOKEN);
  });
});

// PR #292 review item 1: a mint failure (App not installed on a sibling ->
// 422, union over 15) skips the read token; the task hears about it once.
describe("studioReadReposCredential — mint failure is non-fatal", () => {
  it("returns null, keeps the grant, comments on the granting task ONCE per distinct error", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/alpha"], 1000);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const comment = vi.fn(async (_repo: string, _n: number, _body: string) => {});
    const mint = vi.fn(async () => { throw new Error("installation token failed (422): not installed"); });
    const deps = { getTask: async () => liveTask(), mint, comment };
    expect(await studioReadReposCredential(appEnv(), STUDIO, deps)).toBeNull();
    expect(await studioReadReposCredential(appEnv(), STUDIO, deps)).toBeNull();
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0]![0]).toBe(TASK_REPO);
    expect(comment.mock.calls[0]![1]).toBe(7);
    expect(String(comment.mock.calls[0]![2])).toMatch(/read-repos/);
    expect(await readReposGrantsForStudio(env.DB, STUDIO)).toHaveLength(1);
    mint.mockImplementationOnce(async () => { throw new Error("a different failure"); });
    await studioReadReposCredential(appEnv(), STUDIO, deps);
    expect(comment).toHaveBeenCalledTimes(2);
  });

  // PR #292 review round 2 (MAJOR): the task issue may be PUBLIC. The
  // comment names no sibling repo and quotes no GitHub error text — only
  // the repo count and the HTTP status.
  it("the task comment is generic: repo count + HTTP status, no repo names, no GitHub text", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/secret-alpha", "acme-org/secret-beta"], 1000);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const comment = vi.fn(async (_repo: string, _n: number, _body: string) => {});
    const mint = vi.fn(async () => {
      throw new MintTokenError(422, "installation token failed (422): {\"message\":\"acme-org/secret-alpha not accessible\"}");
    });
    await studioReadReposCredential(appEnv(), STUDIO, { getTask: async () => liveTask(), mint, comment });
    const body = String(comment.mock.calls[0]![2]);
    expect(body).not.toContain("secret-alpha");
    expect(body).not.toContain("secret-beta");
    expect(body).not.toContain("not accessible");
    expect(body).toContain("2 repos");
    expect(body).toContain("HTTP 422");
  });

  it("a non-HTTP failure says so without its message", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/secret-alpha"], 1000);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const comment = vi.fn(async (_repo: string, _n: number, _body: string) => {});
    const mint = vi.fn(async () => { throw new Error("read-repos: 16 repos, over the limit of 15 (acme-org/secret-alpha)"); });
    await studioReadReposCredential(appEnv(), STUDIO, { getTask: async () => liveTask(), mint, comment });
    const body = String(comment.mock.calls[0]![2]);
    expect(body).not.toContain("secret-alpha");
    expect(body).toContain("1 repo");
  });

  it("a later success re-arms the comment for the next failure", async () => {
    await recordReadReposGrant(env.DB, TASK_REPO, 7, STUDIO, ["acme-org/alpha"], 1000);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const comment = vi.fn(async (_repo: string, _n: number, _body: string) => {});
    const fail = async () => { throw new Error("boom 422"); };
    const ok = async () => ({ token: READ_TOKEN, canonical: [] as string[] });
    const mint = vi.fn(fail);
    const deps = { getTask: async () => liveTask(), mint, comment };
    await studioReadReposCredential(appEnv(), STUDIO, deps);
    mint.mockImplementationOnce(ok as never);
    expect(await studioReadReposCredential(appEnv(), STUDIO, deps)).not.toBeNull();
    await studioReadReposCredential(appEnv(), STUDIO, deps);
    expect(comment).toHaveBeenCalledTimes(2);
  });
});

// PR #292 review item 2: un-grant and rotation revoke the old token now.
describe("swapStoredReadToken / revokeInstallationToken", () => {
  function store(initial?: string) {
    let v = initial;
    return { get: async () => v, put: async (t: string) => { v = t; }, delete: async () => { v = undefined; }, peek: () => v };
  }

  it("revokeInstallationToken sends DELETE /installation/token as that token", async () => {
    answer = () => new Response(null, { status: 204 });
    await revokeInstallationToken("ghs_old");
    expect(calls).toEqual([{ url: "https://api.github.com/installation/token", method: "DELETE", body: undefined }]);
  });

  it("rotation stores the new token and revokes the previous one", async () => {
    const s = store("ghs_old");
    const revoke = vi.fn(async () => {});
    await swapStoredReadToken(s, "ghs_new", revoke);
    expect(s.peek()).toBe("ghs_new");
    expect(revoke).toHaveBeenCalledWith("ghs_old");
  });

  it("un-grant (null) revokes and forgets", async () => {
    const s = store("ghs_old");
    const revoke = vi.fn(async () => {});
    await swapStoredReadToken(s, null, revoke);
    expect(s.peek()).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith("ghs_old");
  });

  it("nothing stored -> nothing revoked; a revoke failure is logged, never thrown, never logs the token", async () => {
    const revoke = vi.fn(async () => { throw new Error("401"); });
    await swapStoredReadToken(store(), null, revoke);
    expect(revoke).not.toHaveBeenCalled();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    await expect(swapStoredReadToken(store("ghs_secretold"), null, revoke)).resolves.toBeUndefined();
    expect(logs.join("\n")).not.toContain("ghs_secretold");
  });
});
