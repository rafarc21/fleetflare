import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Env } from "../src/env";
import {
  mergePullRequest, fetchRepoFile, listInstallationRepos, createRepoFile,
  getDefaultBranch, commitFilesOnNewBranch, openPullRequest,
  BLUEPRINT_FILE_MAX_BYTES, INSTALLATION_REPOS_PAGE_SIZE, INSTALLATION_REPOS_MAX_PAGES,
  upsertRepoFile,
} from "../src/github/api";
import { doneRecordPutter } from "../src/studio/do";

let calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
let realFetch: typeof globalThis.fetch;
let respond: () => Response;

beforeEach(() => {
  calls = [];
  respond = () => Response.json({ sha: "abc1234567" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    return respond();
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

const GH_STD_HEADERS = {
  authorization: "Bearer tok",
  accept: "application/vnd.github+json",
  "user-agent": "fleetflare",
  "content-type": "application/json",
};

// #309: the deviant 3-key bodyless-GET set three call sites carry (no
// content-type) — pinned separately so the one-request-path refactor must
// reproduce it bit-for-bit at each of them.
const GH_GET_HEADERS = {
  authorization: "Bearer tok",
  accept: "application/vnd.github+json",
  "user-agent": "fleetflare",
};
describe("mergePullRequest", () => {
  it("PUTs to the merge endpoint, authenticated, and returns the merge sha", async () => {
    const sha = await mergePullRequest("tok", "o/r", "7", "Merge into staging (PR #7)", "squash");
    expect(sha).toBe("abc1234567");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls/7/merge");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].body.commit_title).toBe("Merge into staging (PR #7)");
    expect(calls[0].body.merge_method).toBe("squash");
  });

  it("threads the caller's merge method through rather than always squashing", async () => {
    // Review round 1, Important 3: merge_main promotes the long-lived
    // staging branch into main. Squashing that flattens history staging and
    // main should share, so every later promotion would replay
    // already-integrated commits as conflicts — squash is only correct for
    // a feature branch merging into staging.
    await mergePullRequest("tok", "o/r", "7", "Merge into main (PR #7)", "merge");
    expect(calls[0].body.merge_method).toBe("merge");
  });

  it("surfaces GitHub's reason when the PR cannot merge", async () => {
    respond = () => new Response('{"message":"Pull Request is not mergeable"}', { status: 405 });
    await expect(mergePullRequest("tok", "o/r", "7", "t", "squash"))
      .rejects.toThrow(/not mergeable/);
  });

  it("surfaces a conflict with the base branch", async () => {
    respond = () => new Response('{"message":"Base branch was modified"}', { status: 409 });
    await expect(mergePullRequest("tok", "o/r", "7", "t", "squash"))
      .rejects.toThrow(/Base branch was modified/);
  });

  // #309 finding 2: the PUT sites carried no full-header pin — stripping
  // their headers to auth-only passed all of #308's tests. This pins the
  // whole 4-key standard set, so that strip now fails.
  it("PUTs with the full standard header set (#309 finding 2)", async () => {
    await mergePullRequest("tok", "o/r", "7", "t", "squash");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
  });

  it("a 2xx body with no sha throws, never returns undefined (S10-F2)", async () => {
    respond = () => Response.json({});
    try {
      await mergePullRequest("tok", "o/r", "7", "t", "squash");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("merge failed (200): GitHub named no sha");
    }
  });
});

describe("fetchRepoFile", () => {
  it("GETs the Contents API with the raw media type, authenticated, and returns the body text as-is", async () => {
    respond = () => new Response("---\nname: pilot\n---\nprompt\n", { status: 200 });
    const text = await fetchRepoFile("tok", "o/r", "fleet/blueprint/roles/pilot.md", "v1.2.3");

    expect(text).toBe("---\nname: pilot\n---\nprompt\n");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/contents/fleet/blueprint/roles/pilot.md?ref=v1.2.3");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].headers.accept).toBe("application/vnd.github.raw+json");
    // #309: the raw-media-type deviation pinned as a full object — the 3-key
    // set with the RAW accept and no content-type. This site stays a raw
    // fetch under ghRequest (its Content-Length guard must reject before the
    // body is ever buffered), so this pin guards against anyone "helpfully"
    // routing it later without noticing the set differs.
    expect(calls[0].headers).toEqual({
      authorization: "Bearer tok",
      accept: "application/vnd.github.raw+json",
      "user-agent": "fleetflare",
    });
  });

  it("URL-encodes the ref", async () => {
    respond = () => new Response("{}", { status: 200 });
    await fetchRepoFile("tok", "o/r", "fleet.json", "feature/x y");
    expect(calls[0].url).toContain("ref=feature%2Fx%20y");
  });

  it("surfaces GitHub's reason (e.g. Not Found for a bad path/ref) rather than swallowing it", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    await expect(fetchRepoFile("tok", "o/r", "missing.md", "main")).rejects.toThrow(/Not Found/);
  });

  it("never leaks the token into the thrown error message", async () => {
    respond = () => new Response("unauthorized", { status: 401 });
    try {
      await fetchRepoFile("super-secret-token", "o/r", "fleet.json", "main");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-token");
    }
  });

  describe("size cap (review finding: unbounded fetch -> base64 -> exec env pipeline)", () => {
    it("rejects on an HONEST Content-Length that truthfully declares a size over the cap — before ever reading the body", async () => {
      const declared = BLUEPRINT_FILE_MAX_BYTES + 1;
      respond = () => new Response("this body is never even read", {
        status: 200,
        headers: { "content-length": String(declared) },
      });
      try {
        await fetchRepoFile("tok", "o/r", "fleet/blueprint/roles/pilot.md", "main");
        expect.unreachable();
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("fleet/blueprint/roles/pilot.md");
        expect(msg).toContain("main");
        expect(msg).toContain(String(declared));
        expect(msg).toContain(String(BLUEPRINT_FILE_MAX_BYTES));
      }
    });

    it("rejects an oversized body even with a LYING (absent) Content-Length — the actual-byte-length check is not optional", async () => {
      const bigBody = "x".repeat(BLUEPRINT_FILE_MAX_BYTES + 1000);
      respond = () => new Response(bigBody, { status: 200 }); // no content-length header at all
      try {
        await fetchRepoFile("tok", "o/r", "fleet.json", "v1");
        expect.unreachable();
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("fleet.json");
        expect(msg).toContain("v1");
        expect(msg).toContain(String(bigBody.length));
      }
    });

    it("rejects an oversized body when Content-Length LIES LOW (declares under the cap, actual content is over)", async () => {
      const bigBody = "y".repeat(BLUEPRINT_FILE_MAX_BYTES + 1000);
      respond = () => new Response(bigBody, { status: 200, headers: { "content-length": "10" } });
      await expect(fetchRepoFile("tok", "o/r", "fleet.json", "main")).rejects.toThrow(/exceeds/);
    });

    it("accepts content comfortably under the cap, with an honest Content-Length present", async () => {
      const smallBody = "---\nname: pilot\n---\nprompt\n";
      respond = () => new Response(smallBody, {
        status: 200,
        headers: { "content-length": String(smallBody.length) },
      });
      const text = await fetchRepoFile("tok", "o/r", "fleet/blueprint/roles/pilot.md", "main");
      expect(text).toBe(smallBody);
    });

    it("accepts content exactly at the cap boundary", async () => {
      const exactBody = "z".repeat(BLUEPRINT_FILE_MAX_BYTES);
      respond = () => new Response(exactBody, { status: 200 });
      const text = await fetchRepoFile("tok", "o/r", "fleet.json", "main");
      expect(text.length).toBe(BLUEPRINT_FILE_MAX_BYTES);
    });
  });
});

// Task 4 (P5a guardrails): the teardown learning harvest's write side
// (src/studio/do.ts's harvestLearnings) — the Worker commits a harvested
// learning to fleet/memory/<studio>/ through this one function, never the
// container (do.ts's own header: "containers hold no blueprint-repo write
// credentials, by design").
// #363 review round 2: the Contents API refuses a PUT over an existing file
// without its sha (422). A completion record rewritten by a later teardown
// must replace the old one, not fail.
describe("upsertRepoFile", () => {
  it("existing file: GETs its sha, then PUTs with that sha", async () => {
    let n = 0;
    respond = () => (n++ === 0 ? Response.json({ sha: "old111" }) : Response.json({ content: { sha: "new222" } }));
    const result = await upsertRepoFile("tok", "o/ops", "done/a-b/316.json", "{}", "msg");
    expect(result).toEqual({ path: "done/a-b/316.json", sha: "new222" });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/ops/contents/done/a-b/316.json");
    expect(calls[0].method ?? "GET").toBe("GET");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].body.sha).toBe("old111");
  });

  it("new file (404): PUTs with no sha", async () => {
    let n = 0;
    respond = () => (n++ === 0 ? new Response("Not Found", { status: 404 }) : Response.json({ content: { sha: "new222" } }));
    await upsertRepoFile("tok", "o/ops", "done/a-b/316.json", "{}", "msg");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].body.sha).toBeUndefined();
  });

  it("a failed sha lookup (not 404) throws, never a blind PUT", async () => {
    respond = () => new Response("boom", { status: 500 });
    await expect(upsertRepoFile("tok", "o/ops", "p.json", "{}", "msg")).rejects.toThrow(/500/);
    expect(calls).toHaveLength(1);
  });

  // #309: the GET carries this module's only 3-key bodyless set (no
  // content-type) — pinned bit-for-bit so routing it through the merged
  // header set must still drop that key exactly, and the DIFFERENT
  // `upsert ${path}: sha lookup failed` message shape must survive.
  it("GETs with the 3-key bodyless set (no content-type) — #309 deviant set", async () => {
    let n = 0;
    respond = () => (n++ === 0 ? Response.json({ sha: "old111" }) : Response.json({ content: { sha: "new222" } }));
    await upsertRepoFile("tok", "o/ops", "done/a-b/316.json", "{}", "msg");
    // toStrictEqual, not toEqual: the stripped set must be EXACTLY 3 keys —
    // toEqual ignores an undefined-valued key, so it cannot see the strip
    // (#309 round 2 review: deleting ghRequest's undefined-strip passed
    // all 130 tests under toEqual).
    expect(calls[0].headers).toStrictEqual(GH_GET_HEADERS);
  });

  it("the failed-lookup throw carries this fn's own exact message shape (#309)", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await upsertRepoFile("tok", "o/ops", "p.json", "{}", "msg");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("upsert p.json: sha lookup failed (500): boom");
    }
  });

  it("a sha-lookup body with no sha throws, never a sha-less PUT (S10-F2)", async () => {
    respond = () => Response.json({});
    try {
      await upsertRepoFile("tok", "o/ops", "p.json", "{}", "msg");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("upsert p.json: sha lookup failed (200): GitHub named no sha");
    }
    expect(calls).toHaveLength(1); // GET only — the sha-less PUT never fired
  });
});

// #363 round 3: the Worker's putOpsFile port must UPSERT (sha lookup, then
// PUT with it) -- a plain create 422s over a record a later teardown rewrites.
describe("doneRecordPutter — the DO's putOpsFile", () => {
  it("mints ops-scoped contents:write, GETs the existing sha, then PUTs with it", async () => {
    let n = 0;
    respond = () => (n++ === 0 ? Response.json({ sha: "old111" }) : Response.json({ content: { sha: "new222" } }));
    const mint = vi.fn(async () => "tok-w");
    await doneRecordPutter({} as Env, mint)("o/ops", "done/a-b/316.json", "{}", "msg");
    expect(mint).toHaveBeenCalledWith({}, "o/ops", { permissions: { contents: "write" } });
    expect(calls).toHaveLength(2);
    expect(calls[0].method ?? "GET").toBe("GET");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].body.sha).toBe("old111");
  });
});

describe("createRepoFile", () => {
  it("PUTs the Contents API with the message and base64 content, and returns the new file's path + sha", async () => {
    respond = () => Response.json({ content: { sha: "def7890123" } });
    const result = await createRepoFile("tok", "o/r", "fleet/memory/websites--pilot/2026-08-27-0-a-fact.md", "the fact", "fleet: harvest learning (websites--pilot)");

    expect(result).toEqual({ path: "fleet/memory/websites--pilot/2026-08-27-0-a-fact.md", sha: "def7890123" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/contents/fleet/memory/websites--pilot/2026-08-27-0-a-fact.md");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].body.message).toBe("fleet: harvest learning (websites--pilot)");
    expect(atob(calls[0].body.content)).toBe("the fact");
  });

  it("never sends a branch — commits to the repo's own default branch, not whatever ref a studio's role happened to pin", async () => {
    respond = () => Response.json({ content: { sha: "def7890123" } });
    await createRepoFile("tok", "o/r", "fleet/memory/s/x.md", "fact", "msg");
    expect(calls[0].body.branch).toBeUndefined();
  });

  it("never sends a sha — a PUT onto an existing path must 422, not silently overwrite an earlier learning", async () => {
    respond = () => Response.json({ content: { sha: "def7890123" } });
    await createRepoFile("tok", "o/r", "fleet/memory/s/x.md", "fact", "msg");
    expect(calls[0].body.sha).toBeUndefined();
  });

  it("round-trips multi-byte UTF-8 content losslessly (a bare btoa would throw)", async () => {
    respond = () => Response.json({ content: { sha: "def7890123" } });
    const text = "Higgsfield: ~7 crédits/image — 猫";
    await createRepoFile("tok", "o/r", "fleet/memory/s/x.md", text, "msg");
    const decoded = decodeURIComponent(escape(atob(calls[0].body.content)));
    expect(decoded).toBe(text);
  });

  it("surfaces GitHub's reason on a non-2xx (e.g. 422 on a path that already exists)", async () => {
    respond = () => new Response('{"message":"Invalid request.\\n\\n\\"sha\\" wasn\'t supplied."}', { status: 422 });
    await expect(createRepoFile("tok", "o/r", "fleet/memory/s/x.md", "fact", "msg")).rejects.toThrow(/sha.*wasn/);
  });

  it("never leaks the token into the thrown error message", async () => {
    respond = () => new Response("unauthorized", { status: 401 });
    try {
      await createRepoFile("super-secret-token", "o/r", "fleet/memory/s/x.md", "fact", "msg");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-token");
    }
  });

  // #309 finding 2: the second PUT site with no full-header pin. Same pin
  // as mergePullRequest's — stripping to auth-only must fail HERE too.
  it("PUTs with the full standard header set (#309 finding 2)", async () => {
    respond = () => Response.json({ content: { sha: "def7890123" } });
    await createRepoFile("tok", "o/r", "fleet/memory/s/x.md", "fact", "msg");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
  });

  it("a 2xx body with no content.sha throws, never a phantom empty sha (S10-F2)", async () => {
    respond = () => Response.json({});
    try {
      await createRepoFile("tok", "o/r", "fleet/memory/s/x.md", "fact", "msg");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("create fleet/memory/s/x.md failed (200): GitHub named no sha");
    }
  });
});

// Dynamic repo selection (P4a): the installation's repository list is the
// ONE thing that decides whether the fleet may clone a repo a caller named
// — src/studio/repo.ts's resolveWorkRepo checks membership against exactly
// this, server-side, so a client can never steer a studio's checkout.
describe("listInstallationRepos", () => {
  function pageOf(names: string[], total: number): Response {
    return Response.json({ total_count: total, repositories: names.map((full_name) => ({ full_name })) });
  }

  it("GETs the installation endpoint with the installation token and returns full names", async () => {
    respond = () => pageOf(["acme-org/websites", "acme-org/beta"], 2);
    const repos = await listInstallationRepos("tok");
    expect(repos).toEqual(["acme-org/websites", "acme-org/beta"]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("https://api.github.com/installation/repositories");
    expect(calls[0].url).toContain(`per_page=${INSTALLATION_REPOS_PAGE_SIZE}`);
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("follows pages until the declared total_count is covered", async () => {
    const first = Array.from({ length: INSTALLATION_REPOS_PAGE_SIZE }, (_, i) => `o/r${i}`);
    let page = 0;
    respond = () => (page++ === 0 ? pageOf(first, INSTALLATION_REPOS_PAGE_SIZE + 1) : pageOf(["o/last"], INSTALLATION_REPOS_PAGE_SIZE + 1));
    const repos = await listInstallationRepos("tok");
    expect(repos).toHaveLength(INSTALLATION_REPOS_PAGE_SIZE + 1);
    expect(repos.at(-1)).toBe("o/last");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("page=2");
  });

  it("stops at the page cap rather than paging forever on a lying total_count", async () => {
    const full = Array.from({ length: INSTALLATION_REPOS_PAGE_SIZE }, (_, i) => `o/r${i}`);
    respond = () => pageOf(full, 1_000_000);
    const repos = await listInstallationRepos("tok");
    expect(calls).toHaveLength(INSTALLATION_REPOS_MAX_PAGES);
    expect(repos).toHaveLength(INSTALLATION_REPOS_PAGE_SIZE * INSTALLATION_REPOS_MAX_PAGES);
  });

  it("stops early when a page comes back short, without asking for another", async () => {
    respond = () => pageOf(["o/only"], 500);
    await listInstallationRepos("tok");
    expect(calls).toHaveLength(1);
  });

  it("throws GitHub's own words on a non-2xx, and never the token", async () => {
    respond = () => new Response("Bad credentials", { status: 401 });
    await expect(listInstallationRepos("tok")).rejects.toThrow(/401.*Bad credentials/);
  });

  // #309: this is one of the three bodyless-GET sites whose 3-key set (no
  // content-type) is a deviant the merged header convention must preserve.
  it("GETs each page with the 3-key bodyless set (no content-type) — #309 deviant set", async () => {
    respond = () => pageOf(["acme-org/websites"], 1);
    await listInstallationRepos("tok");
    // toStrictEqual for the same reason as upsertRepoFile's pin above: an
    // undefined-valued content-type key must fail here, not be ignored.
    expect(calls[0].headers).toStrictEqual(GH_GET_HEADERS);
  });
});

// P5d (memory compaction): a compaction lands as ONE branch, ONE commit and
// ONE pull request — the mitigation spec §9 names ("compaction lands as a PR
// the operator can reject"). These three functions are the whole write path; nothing
// else in the fleet opens a PR.
describe("getDefaultBranch", () => {
  it("reads the repo's own default branch rather than assuming main", async () => {
    respond = () => Response.json({ default_branch: "trunk" });
    expect(await getDefaultBranch("tok", "o/r")).toBe("trunk");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r");
  });

  it("throws when GitHub does not name one", async () => {
    respond = () => Response.json({});
    await expect(getDefaultBranch("tok", "o/r")).rejects.toThrow(/default branch/);
  });
});

describe("commitFilesOnNewBranch", () => {
  function gitDataResponses() {
    const seq = [
      Response.json({ object: { sha: "basecommit" } }),        // GET ref
      Response.json({ tree: { sha: "basetree" } }),             // GET commit
      Response.json({ sha: "newtree" }),                        // POST tree
      Response.json({ sha: "newcommit" }),                      // POST commit
      Response.json({ ref: "refs/heads/b" }),                   // POST ref
    ];
    let i = 0;
    return () => seq[i++];
  }

  it("builds one tree, one commit and one ref — the whole compaction is atomic", async () => {
    respond = gitDataResponses();
    const sha = await commitFilesOnNewBranch("tok", "o/r", "main", "fleet/memory-compaction-x", "fleet: compact memory", [
      { path: "fleet/memory/INDEX.md", content: "- [a](a.md) — one\n" },
      { path: "fleet/memory/archive/s/a.md", content: "the fact\n" },
      { path: "fleet/memory/s/a.md", content: null },
    ]);
    expect(sha).toBe("newcommit");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/o/r/git/ref/heads/main",
      "https://api.github.com/repos/o/r/git/commits/basecommit",
      "https://api.github.com/repos/o/r/git/trees",
      "https://api.github.com/repos/o/r/git/commits",
      "https://api.github.com/repos/o/r/git/refs",
    ]);
    expect(calls[2].body.base_tree).toBe("basetree");
    expect(calls[3].body.parents).toEqual(["basecommit"]);
    expect(calls[4].body.ref).toBe("refs/heads/fleet/memory-compaction-x");
  });

  it("a null content is a tree DELETION of that path only — the bytes live on at the archive path in the same commit", async () => {
    respond = gitDataResponses();
    await commitFilesOnNewBranch("tok", "o/r", "main", "b", "m", [
      { path: "fleet/memory/archive/s/a.md", content: "the fact\n" },
      { path: "fleet/memory/s/a.md", content: null },
    ]);
    expect(calls[2].body.tree).toEqual([
      { path: "fleet/memory/archive/s/a.md", mode: "100644", type: "blob", content: "the fact\n" },
      { path: "fleet/memory/s/a.md", mode: "100644", type: "blob", sha: null },
    ]);
  });

  it("refuses an empty change list rather than pushing an empty commit", async () => {
    await expect(commitFilesOnNewBranch("tok", "o/r", "main", "b", "m", [])).rejects.toThrow(/no changes/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces GitHub's own words when the branch already exists", async () => {
    const seq = [
      Response.json({ object: { sha: "basecommit" } }),
      Response.json({ tree: { sha: "basetree" } }),
      Response.json({ sha: "newtree" }),
      Response.json({ sha: "newcommit" }),
      new Response('{"message":"Reference already exists"}', { status: 422 }),
    ];
    let i = 0;
    respond = () => seq[i++];
    await expect(commitFilesOnNewBranch("tok", "o/r", "main", "b", "m", [{ path: "x", content: "y" }]))
      .rejects.toThrow(/Reference already exists/);
  });
});

describe("openPullRequest", () => {
  it("opens the PR and returns the number and url a human can click", async () => {
    respond = () => Response.json({ number: 91, html_url: "https://github.com/o/r/pull/91" });
    expect(await openPullRequest("tok", "o/r", "fleet/memory-compaction-x", "main", "t", "b"))
      .toEqual({ number: 91, url: "https://github.com/o/r/pull/91" });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls");
    expect(calls[0].body).toEqual({ title: "t", body: "b", head: "fleet/memory-compaction-x", base: "main" });
  });

  it("surfaces GitHub's refusal — a missing pull_requests permission must not read as success", async () => {
    respond = () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
    await expect(openPullRequest("tok", "o/r", "h", "main", "t", "b"))
      .rejects.toThrow(/not accessible by integration/);
  });
});
