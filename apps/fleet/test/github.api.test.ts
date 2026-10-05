import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Env } from "../src/env";
import {
  mergePullRequest, fetchRepoFile, listInstallationRepos, createRepoFile,
  getDefaultBranch, commitFilesOnNewBranch, openPullRequest, listRepoTree,
  BLUEPRINT_FILE_MAX_BYTES, INSTALLATION_REPOS_PAGE_SIZE, INSTALLATION_REPOS_MAX_PAGES,
  listOpenPullNumbers, listPullsForCommit, listPullCommits, closeIssue,
  closingIssuesForPull, getPullRequest, commitReachableFromBranch, getIssueCloser,
  pullsWithClosingIssuesForCommits, pullClaimsIssue, upsertRepoFile,
  listAllBranchNames, BRANCH_NAMES_PAGE_SIZE, BRANCH_NAMES_MAX_PAGES,
} from "../src/github/api";
import { doneRecordPutter } from "../src/studio/do";
import { PATH1_BATCH_MAX } from "../src/github/promote-close";

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
});

describe("fetchRepoFile", () => {
  it("GETs the Contents API with the raw media type, authenticated, and returns the body text as-is", async () => {
    respond = () => new Response("---\nname: pilot\n---\nprompt\n", { status: 200 });
    const text = await fetchRepoFile("tok", "o/r", "fleet/blueprint/roles/pilot.md", "v1.2.3");

    expect(text).toBe("---\nname: pilot\n---\nprompt\n");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/contents/fleet/blueprint/roles/pilot.md?ref=v1.2.3");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].headers.accept).toBe("application/vnd.github.raw+json");
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

describe("listRepoTree", () => {
  it("returns blob paths only, recursively, in one call", async () => {
    respond = () => Response.json({ tree: [
      { path: "fleet/memory", type: "tree" },
      { path: "fleet/memory/websites--pilot/a.md", type: "blob" },
      { path: "fleet/memory/INDEX.md", type: "blob" },
    ] });
    expect(await listRepoTree("tok", "o/r", "main")).toEqual([
      "fleet/memory/websites--pilot/a.md", "fleet/memory/INDEX.md",
    ]);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/trees/main?recursive=1");
  });

  it("throws on a truncated listing rather than surveying a subset", async () => {
    respond = () => Response.json({ tree: [], truncated: true });
    await expect(listRepoTree("tok", "o/r", "main")).rejects.toThrow(/truncated/);
  });
});

describe("listOpenPullNumbers", () => {
  it("asks GitHub for open PRs only and returns their numbers", async () => {
    respond = () => Response.json([{ number: 138 }, { number: 139 }]);
    const nums = await listOpenPullNumbers("tok", "o/r");
    expect(nums).toEqual([138, 139]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/repos/o/r/pulls?");
    expect(calls[0].url).toContain("state=open");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("throws on a non-2xx rather than reporting an empty fleet", async () => {
    // Quiescence is fail-CLOSED: this throw is what the checker turns into
    // "could not tell", and swallowing it here would defeat that upstream.
    respond = () => new Response("boom", { status: 503 });
    await expect(listOpenPullNumbers("tok", "o/r")).rejects.toThrow(/503/);
  });
});

describe("listAllBranchNames", () => {
  it("GETs the plain branches-list endpoint, one page, and returns names, not truncated", async () => {
    respond = () => Response.json([{ name: "main" }, { name: "fix-231-replaced-session" }]);
    const result = await listAllBranchNames("tok", "o/r");
    expect(result).toEqual({ names: ["main", "fix-231-replaced-session"], truncated: false });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/branches?per_page=100");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("throws GitHub's own words on a non-2xx, token never in the message", async () => {
    respond = () => new Response("boom", { status: 503 });
    await expect(listAllBranchNames("tok", "o/r")).rejects.toThrow(/503/);
  });

  // Reviewer finding 1 (PR #239): a single `per_page=100` page silently
  // missed a match past branch 100 on any repo with more than one page --
  // the ORIGINAL #234 bug, reappearing for any repo past 100 branches.
  // `git ls-remote origin 'refs/heads/*'` against this very repo on
  // 2026-10-05 counted 116 -- already past one page today.
  it("follows Link: rel=\"next\" across pages and finds a name that only exists on page 2", async () => {
    const first = Array.from({ length: BRANCH_NAMES_PAGE_SIZE }, (_, i) => ({ name: `branch-${i}` }));
    let page = 0;
    respond = () => {
      page++;
      if (page === 1) {
        return new Response(JSON.stringify(first), {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: '<https://api.github.com/repos/o/r/branches?per_page=100&page=2>; rel="next"',
          },
        });
      }
      return Response.json([{ name: "fix-999-tail" }]);
    };
    const result = await listAllBranchNames("tok", "o/r");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://api.github.com/repos/o/r/branches?per_page=100&page=2");
    expect(result.names).toContain("fix-999-tail");
    expect(result.names).toHaveLength(BRANCH_NAMES_PAGE_SIZE + 1);
    expect(result.truncated).toBe(false);
  });

  it("stops at the page cap and reports truncated:true when a next link still remains", async () => {
    respond = () => new Response(JSON.stringify([{ name: "branch-x" }]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        link: '<https://api.github.com/repos/o/r/branches?per_page=100&page=99>; rel="next"',
      },
    });
    const result = await listAllBranchNames("tok", "o/r");
    expect(calls).toHaveLength(BRANCH_NAMES_MAX_PAGES);
    expect(result.truncated).toBe(true);
  });
});

// Board issue #8: auto-close on promote. The six primitives below are the
// whole of what promote-close.ts and task-reap.ts need from real GitHub —
// everything else in those two files is pure and DI'd over fakes.

describe("listPullsForCommit", () => {
  it("GETs the commit's pulls endpoint and returns number + base/head refs", async () => {
    respond = () => Response.json([
      { number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } },
    ]);
    const pulls = await listPullsForCommit("tok", "o/r", "abc123");
    expect(pulls).toEqual([{ number: 7, base: "staging", head: "feat/x" }]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/commits/abc123/pulls");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("a commit belonging to no PR answers an empty list", async () => {
    respond = () => Response.json([]);
    expect(await listPullsForCommit("tok", "o/r", "orphan")).toEqual([]);
  });

  it("throws GitHub's own words on a non-2xx", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    await expect(listPullsForCommit("tok", "o/r", "missing")).rejects.toThrow(/Not Found/);
  });
});

describe("listPullCommits", () => {
  it("GETs the PR's own commits, regardless of how it was merged", async () => {
    respond = () => Response.json([{ sha: "aaa" }, { sha: "bbb" }]);
    const shas = await listPullCommits("tok", "o/r", 42);
    expect(shas).toEqual(["aaa", "bbb"]);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls/42/commits?per_page=100");
  });

  it("throws GitHub's own words on a non-2xx", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    await expect(listPullCommits("tok", "o/r", 999)).rejects.toThrow(/Not Found/);
  });
});

describe("closeIssue", () => {
  it("PATCHes state: closed, authenticated", async () => {
    respond = () => Response.json({ number: 12, state: "closed" });
    await closeIssue("tok", "o/r", 12);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/12");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].body).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("surfaces GitHub's own words on a non-2xx", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    await expect(closeIssue("tok", "o/r", 404)).rejects.toThrow(/Not Found/);
  });

  it("never leaks the token into the thrown error message", async () => {
    respond = () => new Response("unauthorized", { status: 401 });
    try {
      await closeIssue("super-secret-token", "o/r", 1);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-token");
    }
  });
});

describe("closingIssuesForPull", () => {
  it("POSTs one minimal GraphQL query and returns the closing issue numbers", async () => {
    respond = () => Response.json({
      data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 42, repository: { nameWithOwner: "o/r" } }] } } } },
    });
    const issues = await closingIssuesForPull("tok", "o/r", 7);
    expect(issues).toEqual([42]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.github.com/graphql");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].body.variables).toEqual({ owner: "o", repo: "r", number: 7 });
    // #252 (M3): page size pinned, same as the batch query's.
    expect(calls[0].body.query).toContain("closingIssuesReferences(first:20)");
  });

  // #252: GitHub resolves "Fixes other/repo#12" into closingIssuesReferences
  // too; only this repo's issues are ours to close.
  it("drops a closing reference to another repo's issue; same repo matches in any case", async () => {
    respond = () => Response.json({
      data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [
        { number: 12, repository: { nameWithOwner: "other/repo" } },
        { number: 42, repository: { nameWithOwner: "O/R" } },
      ] } } } },
    });
    expect(await closingIssuesForPull("tok", "o/r", 7)).toEqual([42]);
    expect(calls[0].body.query).toContain("nodes{number repository{nameWithOwner}}");
  });

  // #265, live: slug acme-org/acme-os redirects to acme-hq/acme-os and
  // GitHub names the issue by its new home; #1635 was dropped with no log.
  it("#265: a stale slug still keeps this repo's issue under its canonical name; other repos dropped", async () => {
    respond = () => Response.json({
      data: { repository: { nameWithOwner: "new/name", pullRequest: { closingIssuesReferences: { nodes: [
        { number: 12, repository: { nameWithOwner: "new/name" } },
        { number: 13, repository: { nameWithOwner: "other/repo" } },
      ] } } } },
    });
    expect(await closingIssuesForPull("tok", "old/name", 7)).toEqual([12]);
    expect(calls[0].body.query).toContain("repository(owner:$owner,name:$repo){nameWithOwner ");
  });

  it("a PR that closes nothing (no keyword in its body) answers an empty list", async () => {
    respond = () => Response.json({
      data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } },
    });
    expect(await closingIssuesForPull("tok", "o/r", 7)).toEqual([]);
  });

  it("throws on a GraphQL errors[] response even when the transport itself is 200", async () => {
    respond = () => Response.json({ errors: [{ message: "Could not resolve to a PullRequest" }] });
    await expect(closingIssuesForPull("tok", "o/r", 999)).rejects.toThrow(/Could not resolve/);
  });

  it("throws GitHub's own words on a non-2xx transport failure", async () => {
    respond = () => new Response('{"message":"Bad credentials"}', { status: 401 });
    await expect(closingIssuesForPull("tok", "o/r", 7)).rejects.toThrow(/Bad credentials/);
  });
});

describe("getPullRequest", () => {
  it("reads merged state, merge commit sha, and base/head refs", async () => {
    respond = () => Response.json({
      number: 7, merged: true, merge_commit_sha: "deadbeef", base: { ref: "staging", repo: { full_name: "O/R" } }, head: { ref: "feat/x" },
      title: "feat: x", body: "Closes #3",
    });
    expect(await getPullRequest("tok", "o/r", 7)).toEqual({
      number: 7, merged: true, mergeCommitSha: "deadbeef", baseRef: "staging", headRef: "feat/x",
      title: "feat: x", body: "Closes #3", repoFullName: "O/R",
    });
  });

  it("an unmerged PR reads merged: false and a null merge commit sha", async () => {
    respond = () => Response.json({
      number: 7, merged: false, merge_commit_sha: null, base: { ref: "staging" }, head: { ref: "feat/x" },
    });
    const pr = await getPullRequest("tok", "o/r", 7);
    expect(pr.merged).toBe(false);
    expect(pr.mergeCommitSha).toBeNull();
    // #248: GitHub sends body: null for an empty description.
    expect(pr.body).toBe("");
  });
});

describe("commitReachableFromBranch", () => {
  it("ahead_by 0 means the sha is already contained in the branch", async () => {
    respond = () => Response.json({ status: "behind", ahead_by: 0, behind_by: 3 });
    expect(await commitReachableFromBranch("tok", "o/r", "main", "abc")).toBe(true);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/compare/main...abc");
  });

  it("identical (both 0) is also reachable", async () => {
    respond = () => Response.json({ status: "identical", ahead_by: 0, behind_by: 0 });
    expect(await commitReachableFromBranch("tok", "o/r", "main", "abc")).toBe(true);
  });

  it("ahead_by > 0 means the sha carries commits main does not have yet", async () => {
    respond = () => Response.json({ status: "ahead", ahead_by: 2, behind_by: 0 });
    expect(await commitReachableFromBranch("tok", "o/r", "main", "abc")).toBe(false);
  });

  it("a 404 (bad ref) reads as not reachable rather than throwing", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await commitReachableFromBranch("tok", "o/r", "main", "bogus")).toBe(false);
  });

  it("throws GitHub's own words on any other non-2xx", async () => {
    respond = () => new Response("boom", { status: 503 });
    await expect(commitReachableFromBranch("tok", "o/r", "main", "abc")).rejects.toThrow(/503/);
  });
});

// Board issue #138: who closed an issue — the timeline's newest ClosedEvent.
describe("getIssueCloser", () => {
  function closed(stateReason: string, closer: unknown) {
    return Response.json({
      data: { repository: { issue: { stateReason, timelineItems: { nodes: [{ closer }] } } } },
    });
  }

  it("POSTs one GraphQL query and answers a merged PR closer", async () => {
    respond = () => closed("COMPLETED", {
      __typename: "PullRequest", number: 46, merged: true, repository: { nameWithOwner: "o/r" },
    });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 46, merged: true, repo: "o/r" },
    });
    expect(calls[0].url).toBe("https://api.github.com/graphql");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].body.variables).toEqual({ owner: "o", repo: "r", number: 39 });
    expect(calls[0].body.query).toContain("CLOSED_EVENT");
  });

  it("a commit closer with no associated merged PR carries its sha", async () => {
    respond = () => closed("COMPLETED", {
      __typename: "Commit", oid: "abc123", associatedPullRequests: { nodes: [] },
    });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "commit", sha: "abc123" },
    });
  });

  // #143 review: a squash commit closes the issue, so the closer is the
  // Commit — its associated merged PR in the same repo stands in for it.
  // Live: #30 -> #31, #1 -> #3, #32 -> #35.
  it("a commit closer with a merged associated PR in the same repo answers that PR", async () => {
    respond = () => closed("COMPLETED", {
      __typename: "Commit", oid: "561547b",
      associatedPullRequests: { nodes: [
        { number: 9, merged: false, repository: { nameWithOwner: "o/r" } },
        { number: 12, merged: true, repository: { nameWithOwner: "fork/r" } },
        { number: 31, merged: true, repository: { nameWithOwner: "o/r" } },
      ] },
    });
    expect(await getIssueCloser("tok", "o/r", 30)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 31, merged: true, repo: "o/r" },
    });
    expect(calls[0].body.query).toContain("associatedPullRequests");
  });

  it("a PR closer from another repo carries that repo", async () => {
    respond = () => closed("COMPLETED", {
      __typename: "PullRequest", number: 5, merged: true, repository: { nameWithOwner: "other/x" },
    });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 5, merged: true, repo: "other/x" },
    });
  });

  // #149 review: the board slug is lowercased (board.ts resolveBoardRepo);
  // GitHub answers the canonical name, and after a rename/transfer the new
  // one. Same repo = case-insensitive match against the canonical name the
  // query itself returns; a same-repo closer carries the BOARD slug.
  function canonical(nameWithOwner: string, closer: unknown) {
    return Response.json({ data: { repository: {
      nameWithOwner, issue: { stateReason: "COMPLETED", timelineItems: { nodes: [{ closer }] } },
    } } });
  }

  it("a PR closer whose repo differs only in case from the board slug is the board repo", async () => {
    respond = () => canonical("O/R", { __typename: "PullRequest", number: 46, merged: true, repository: { nameWithOwner: "O/R" } });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 46, merged: true, repo: "o/r" },
    });
    expect(calls[0].body.query).toMatch(/repository\(owner:\$owner,name:\$repo\)\{nameWithOwner /);
  });

  it("a commit closer's associated PR matches the board repo case-insensitively", async () => {
    respond = () => canonical("O/R", {
      __typename: "Commit", oid: "c1",
      associatedPullRequests: { nodes: [{ number: 31, merged: true, repository: { nameWithOwner: "O/R" } }] },
    });
    expect(await getIssueCloser("tok", "o/r", 30)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 31, merged: true, repo: "o/r" },
    });
  });

  it("a renamed repo: canonical new/r, closer new/r, board old/r — same repo", async () => {
    respond = () => canonical("new/r", { __typename: "PullRequest", number: 46, merged: true, repository: { nameWithOwner: "new/r" } });
    expect(await getIssueCloser("tok", "old/r", 39)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 46, merged: true, repo: "old/r" },
    });
  });

  it("a renamed repo: a commit closer's associated PR in new/r resolves for board old/r", async () => {
    respond = () => canonical("new/r", {
      __typename: "Commit", oid: "c1",
      associatedPullRequests: { nodes: [{ number: 31, merged: true, repository: { nameWithOwner: "new/r" } }] },
    });
    expect(await getIssueCloser("tok", "old/r", 30)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 31, merged: true, repo: "old/r" },
    });
  });

  it("a foreign closer is still foreign when the canonical name is known", async () => {
    respond = () => canonical("O/R", { __typename: "PullRequest", number: 5, merged: true, repository: { nameWithOwner: "other/x" } });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 5, merged: true, repo: "other/x" },
    });
  });

  it("an unmerged PR closer answers merged: false", async () => {
    respond = () => closed("COMPLETED", {
      __typename: "PullRequest", number: 50, merged: false, repository: { nameWithOwner: "o/r" },
    });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 50, merged: false, repo: "o/r" },
    });
  });

  it("reads only the NEWEST ClosedEvent — last:1, CLOSED_EVENT only", async () => {
    respond = () => Response.json({ data: { repository: { issue: { stateReason: "COMPLETED", timelineItems: { nodes: [
      { closer: { __typename: "PullRequest", number: 46, merged: true, repository: { nameWithOwner: "o/r" } } },
      { closer: null },
    ] } } } } });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({ stateReason: "COMPLETED", closer: null });
    expect(calls[0].body.query).toContain("last:1");
    expect(calls[0].body.query).toMatch(/itemTypes:\[CLOSED_EVENT\]/);
  });

  it("closed by hand (null closer, not planned) answers a null closer", async () => {
    respond = () => closed("NOT_PLANNED", null);
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({ stateReason: "NOT_PLANNED", closer: null });
  });

  it("an issue with no ClosedEvent answers null reason and null closer", async () => {
    respond = () => Response.json({ data: { repository: { issue: { stateReason: null, timelineItems: { nodes: [] } } } } });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({ stateReason: null, closer: null });
  });

  it("throws on a GraphQL errors[] response", async () => {
    respond = () => Response.json({ errors: [{ message: "Could not resolve to an Issue" }] });
    await expect(getIssueCloser("tok", "o/r", 999)).rejects.toThrow(/Could not resolve/);
  });
});

// Issue #208: Path 1's commit -> PR -> closing issues for many commits in ONE
// GraphQL call (aliased `object(oid:)` selections).
describe("pullsWithClosingIssuesForCommits", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("ONE POST for all the commits, one alias each, and every sha answered", async () => {
    respond = () => Response.json({
      data: { repository: {
        c0: { associatedPullRequests: { nodes: [{
          // Totals past the page (#252, M21/M22): code reading nodes.length instead fails here.
          number: 7, closingIssuesReferences: { totalCount: 25, nodes: [{ number: 42, repository: { nameWithOwner: "o/r" } }, { number: 43, repository: { nameWithOwner: "o/r" } }] },
          commits: { totalCount: 117, nodes: [{ commit: { oid: "o1" } }, { commit: { oid: "o2" } }] },
        }], totalCount: 31 } },
        c1: { associatedPullRequests: { totalCount: 0, nodes: [] } },
      } },
    });

    const map = await pullsWithClosingIssuesForCommits("tok", "o/r", [A, B]);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.github.com/graphql");
    expect(calls[0].body.variables).toEqual({ owner: "o", repo: "r" });
    expect(calls[0].body.query).toContain(`c0:object(oid:"${A}")`);
    expect(calls[0].body.query).toContain(`c1:object(oid:"${B}")`);
    expect(calls[0].body.query).toContain("associatedPullRequests(first:30)");
    expect(calls[0].body.query).toContain("closingIssuesReferences(first:20)");
    // Same first page listPullCommits reads (per_page=100), for the squash fallback.
    expect(calls[0].body.query).toContain("commits(first:100){totalCount nodes{commit{oid}}}");
    // totalCount on every connection, so a page cut is said, never silent.
    expect(calls[0].body.query).toContain("associatedPullRequests(first:30){totalCount ");
    expect(calls[0].body.query).toContain("closingIssuesReferences(first:20){totalCount ");
    expect(map).toEqual(new Map([
      [A, { prsTotal: 31, prs: [{ number: 7, closingIssues: [42, 43], closingIssuesTotal: 25, commits: ["o1", "o2"], commitsTotal: 117 }] }],
      [B, { prsTotal: 0, prs: [] }],
    ]));
  });

  it("#252: another repo's closing reference is dropped, and does not count as a page cut", async () => {
    respond = () => Response.json({
      data: { repository: {
        c0: { associatedPullRequests: { totalCount: 1, nodes: [{
          number: 7,
          closingIssuesReferences: { totalCount: 2, nodes: [
            { number: 12, repository: { nameWithOwner: "other/repo" } },
            { number: 42, repository: { nameWithOwner: "o/r" } },
          ] },
          commits: { totalCount: 0, nodes: [] },
        }] } },
      } },
    });
    const map = await pullsWithClosingIssuesForCommits("tok", "o/r", [A]);
    expect(calls[0].body.query).toContain("closingIssuesReferences(first:20){totalCount nodes{number repository{nameWithOwner}}}");
    expect(map.get(A)!.prs[0]).toMatchObject({ closingIssues: [42], closingIssuesTotal: 1 });
  });

  it("#252: { commits: false } leaves the PR commit list out of the query and the answer", async () => {
    respond = () => Response.json({
      data: { repository: {
        c0: { associatedPullRequests: { totalCount: 1, nodes: [{
          number: 7, closingIssuesReferences: { totalCount: 0, nodes: [] },
        }] } },
      } },
    });
    const map = await pullsWithClosingIssuesForCommits("tok", "o/r", [A], { commits: false });
    expect(calls[0].body.query).not.toContain("commits(first");
    expect(map).toEqual(new Map([[A, { prsTotal: 1, prs: [{ number: 7, closingIssues: [], closingIssuesTotal: 0 }] }]]));
  });

  it("#265: stale slug — this repo's issue kept under its canonical name, other repo dropped", async () => {
    respond = () => Response.json({
      data: { repository: {
        // GitHub's canonical case differs from the node's (K1: the caller's
        // names must be lowercased too, not only the node's).
        nameWithOwner: "New/Name",
        c0: { associatedPullRequests: { totalCount: 1, nodes: [{
          number: 7,
          closingIssuesReferences: { totalCount: 2, nodes: [
            { number: 12, repository: { nameWithOwner: "new/name" } },
            { number: 13, repository: { nameWithOwner: "other/repo" } },
          ] },
        }] } },
      } },
    });
    const map = await pullsWithClosingIssuesForCommits("tok", "old/name", [A], { commits: false });
    expect(calls[0].body.query).toContain("repository(owner:$owner,name:$repo){nameWithOwner ");
    expect(map.get(A)!.prs[0]).toMatchObject({ closingIssues: [12], closingIssuesTotal: 1 });
  });

  it("#265: no totalCount on a closing connection reads as unknown, never NaN", async () => {
    respond = () => Response.json({
      data: { repository: {
        c0: { associatedPullRequests: { totalCount: 1, nodes: [{
          number: 7, closingIssuesReferences: { nodes: [{ number: 12, repository: { nameWithOwner: "o/r" } }] },
        }] } },
      } },
    });
    const pr = (await pullsWithClosingIssuesForCommits("tok", "o/r", [A], { commits: false })).get(A)!.prs[0]!;
    expect(pr.closingIssues).toEqual([12]);
    expect(pr.closingIssuesTotal).toBeUndefined();
  });

  it("a commit GitHub does not know (null object) answers [] — never an error", async () => {
    respond = () => Response.json({ data: { repository: { c0: null } } });
    expect(await pullsWithClosingIssuesForCommits("tok", "o/r", [A])).toEqual(new Map([[A, { prsTotal: 0, prs: [] }]]));
  });

  it("a sha that is not 40 hex never reaches the query (it is inlined) and is left out, for the REST walk; no shas, no call", async () => {
    respond = () => Response.json({ data: { repository: {} } });
    expect(await pullsWithClosingIssuesForCommits("tok", "o/r", ['x") { evil }'])).toEqual(new Map());
    expect(await pullsWithClosingIssuesForCommits("tok", "o/r", [])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });

  it("GitHub's node ceiling: a full chunk of first:30 PRs x (first:20 issues + first:100 commits) stays under 500,000", () => {
    // GitHub dry run: 100 aliases = 363,000 nodes; 138 aliases rejected at 500,940.
    expect(PATH1_BATCH_MAX * (30 + 30 * 20 + 30 * 100)).toBeLessThanOrEqual(500_000);
  });

  it("partial data with an alias error rejects — the null alias is never read as 'no PRs'", async () => {
    respond = () => Response.json({
      data: { repository: { c0: null } },
      errors: [{ message: "timeout", path: ["repository", "c0"] }],
    });
    await expect(pullsWithClosingIssuesForCommits("tok", "o/r", [A])).rejects.toThrow("timeout");
  });

  it("GraphQL errors throw (the resolver falls back to REST for that chunk)", async () => {
    respond = () => Response.json({ errors: [{ message: "Something went wrong" }] });
    await expect(pullsWithClosingIssuesForCommits("tok", "o/r", [A])).rejects.toThrow("Something went wrong");
  });
});

// #265: reap's claim check (routes.ts realReapPort.prClaims) against a stale slug.
describe("pullClaimsIssue", () => {
  let queue: Response[];
  beforeEach(() => { queue = []; respond = () => queue.shift()!; });

  it("stale slug: a closing reference under the canonical name claims, in one call", async () => {
    queue.push(Response.json({ data: { repository: { nameWithOwner: "acme-hq/acme-os", pullRequest: {
      closingIssuesReferences: { nodes: [{ number: 1635, repository: { nameWithOwner: "acme-hq/acme-os" } }] },
    } } } }));
    expect(await pullClaimsIssue("tok", "acme-org/acme-os", 150, 1635)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("stale slug: a keyword naming the canonical repo in the PR text claims", async () => {
    queue.push(Response.json({ data: { repository: { nameWithOwner: "new/name", pullRequest: { closingIssuesReferences: { nodes: [] } } } } }));
    queue.push(Response.json({
      number: 150, merged: true, merge_commit_sha: "s", base: { ref: "staging", repo: { full_name: "new/name" } }, head: { ref: "f" },
      title: "feat: x", body: "Closes new/name#1635",
    }));
    expect(await pullClaimsIssue("tok", "old/name", 150, 1635)).toBe(true);
  });

  it("a keyword naming another repo does not claim", async () => {
    queue.push(Response.json({ data: { repository: { nameWithOwner: "new/name", pullRequest: { closingIssuesReferences: { nodes: [] } } } } }));
    queue.push(Response.json({
      number: 150, merged: true, merge_commit_sha: "s", base: { ref: "staging", repo: { full_name: "new/name" } }, head: { ref: "f" },
      title: "feat: x", body: "Closes other/repo#1635",
    }));
    expect(await pullClaimsIssue("tok", "old/name", 150, 1635)).toBe(false);
  });
});
