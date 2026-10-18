import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  listRepoTree, listOpenPullNumbers, listPullsForCommit, listPullCommits, closeIssue,
  closingIssuesForPull, getPullRequest, commitReachableFromBranch, getIssueCloser,
  pullsWithClosingIssuesForCommits, pullClaimsIssue,
  listAllBranchNames, BRANCH_NAMES_PAGE_SIZE, BRANCH_NAMES_MAX_PAGES, listOpenPulls,
  pullRequestExists, branchExists, commitExists, issueExists, pathExists, compareExists,
  repoIsWritable, deleteBranch, compareAhead, ghRequest,
} from "../src/github/api";
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
    // #309: the third bodyless-GET site — its 3-key set (no content-type)
    // pinned bit-for-bit, and page 2 (a later `calls` slot) keeps it too.
    // toStrictEqual, matching the other two deviant-set pins.
    expect(calls[0].headers).toStrictEqual(GH_GET_HEADERS);
  });

  it("throws GitHub's own words on a non-2xx, token never in the message", async () => {
    respond = () => new Response("boom", { status: 503 });
    // try/catch, not rejects.toThrow: the caught message must be checked
    // twice (status words present, token absent) — the shape :122, :315
    // and :1352 already use for their "never leaks the token" twins.
    try {
      await listAllBranchNames("super-secret-token", "o/r");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/503/);
      expect((err as Error).message).not.toContain("super-secret-token");
    }
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
    expect(calls[1].headers).toStrictEqual(GH_GET_HEADERS);
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
      title: "feat: x", body: "Closes #3", state: "open",
    });
    expect(await getPullRequest("tok", "o/r", 7)).toEqual({
      number: 7, merged: true, mergeCommitSha: "deadbeef", baseRef: "staging", headRef: "feat/x",
      title: "feat: x", body: "Closes #3", repoFullName: "O/R", open: true, baseRepoPrivate: false,
    });
  });

  // #715: a private PR's leg clones through the git proxy, so the base repo's
  // private flag rides on the PR read, not a second call.
  it("reads the base repo's private flag (pull.base.repo.private)", async () => {
    respond = () => Response.json({
      number: 7, merged: false, state: "open", base: { ref: "main", repo: { full_name: "o/r", private: true } }, head: { ref: "feat/x" },
    });
    expect((await getPullRequest("tok", "o/r", 7)).baseRepoPrivate).toBe(true);
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

  // Board issue #332: `open` comes off the same single GET's raw `state`
  // field — the park/destroy unmerged-PR warning excludes a closed-unmerged
  // PR with it (src/board/open-prs.ts, the one caller that reads it).
  it("reads GitHub's own state as open: true/false (issue #332)", async () => {
    respond = () => Response.json({
      number: 7, merged: false, state: "closed", base: { ref: "staging" }, head: { ref: "feat/x" },
    });
    expect((await getPullRequest("tok", "o/r", 7)).open).toBe(false);
    respond = () => Response.json({
      number: 8, merged: false, state: "open", base: { ref: "staging" }, head: { ref: "feat/y" },
    });
    expect((await getPullRequest("tok", "o/r", 8)).open).toBe(true);
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

// Board issue #265, characterization: the six existence checks — 404 is
// `false`, 2xx is `true`, everything else throws GitHub's own words, each
// with its own exact `what` prefix. These pin CURRENT behavior ahead of the
// one-ghRequest-plus-exists consolidation and must pass UNMODIFIED against
// the refactored module — if the refactor "requires" editing one of these,
// it changed behavior.
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

describe("pullRequestExists", () => {
  it("200: true, GETs the pulls endpoint with the standard header set", async () => {
    expect(await pullRequestExists("tok", "o/r", 4242)).toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls/4242");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
  });

  it("404: false, not a throw", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await pullRequestExists("tok", "o/r", 4242)).toBe(false);
  });

  it("500: throws GitHub's own words with this fn's exact message", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await pullRequestExists("tok", "o/r", 4242);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("read o/r#4242 failed (500): boom");
    }
  });
});

describe("branchExists", () => {
  it("200: true, GETs the branches endpoint with the branch URL-encoded", async () => {
    expect(await branchExists("tok", "o/r", "release/1.0")).toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/branches/release%2F1.0");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
  });

  it("404: false, not a throw", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await branchExists("tok", "o/r", "release/1.0")).toBe(false);
  });

  it("500: throws GitHub's own words with this fn's exact message", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await branchExists("tok", "o/r", "release/1.0");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("read o/r@release/1.0 failed (500): boom");
    }
  });
});

describe("commitExists", () => {
  it("200: true, GETs the commits endpoint", async () => {
    expect(await commitExists("tok", "o/r", "abc123")).toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/commits/abc123");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
  });

  it("404: false, not a throw", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await commitExists("tok", "o/r", "abc123")).toBe(false);
  });

  it("500: throws GitHub's own words with this fn's exact message", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await commitExists("tok", "o/r", "abc123");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("read o/r@abc123 failed (500): boom");
    }
  });
});

describe("issueExists", () => {
  it("200: true, GETs the issues endpoint with the standard header set", async () => {
    expect(await issueExists("tok", "o/r", 126)).toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/126");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
  });

  it("404: false, not a throw", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await issueExists("tok", "o/r", 126)).toBe(false);
  });

  it("500: throws GitHub's own words with this fn's exact message", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await issueExists("tok", "o/r", 126);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("read o/r#126 failed (500): boom");
    }
  });
});

describe("pathExists", () => {
  it("200: true, GETs the Contents API with the path raw and the ref URL-encoded", async () => {
    expect(await pathExists("tok", "o/r", "fleet/blueprint/roles/pilot.md", "v1/x")).toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/contents/fleet/blueprint/roles/pilot.md?ref=v1%2Fx");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
  });

  it("404: false, not a throw", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await pathExists("tok", "o/r", "fleet/blueprint/roles/pilot.md", "v1/x")).toBe(false);
  });

  it("500: throws GitHub's own words with this fn's exact message", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await pathExists("tok", "o/r", "fleet/blueprint/roles/pilot.md", "v1/x");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe(
        "read o/r:fleet/blueprint/roles/pilot.md@v1/x failed (500): boom",
      );
    }
  });
});

describe("compareExists", () => {
  it("200: true, GETs the compare endpoint with each side URL-encoded", async () => {
    expect(await compareExists("tok", "o/r", "release/1.0", "feat/ship")).toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/compare/release%2F1.0...feat%2Fship");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
  });

  it("404: false, not a throw", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await compareExists("tok", "o/r", "release/1.0", "feat/ship")).toBe(false);
  });

  it("500: throws GitHub's own words with this fn's exact message", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await compareExists("tok", "o/r", "release/1.0", "feat/ship");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe(
        "read o/r compare release/1.0...feat/ship failed (500): boom",
      );
    }
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

  // #367: the fold's undefined-name guard is load-bearing — a closer whose
  // repository field is absent must read as foreign (repo: ""), never as
  // this repo, whatever known names it is matched against.
  it("a PR closer with no repository field stays foreign (repo: empty string)", async () => {
    respond = () => closed("COMPLETED", { __typename: "PullRequest", number: 7, merged: true });
    expect(await getIssueCloser("tok", "o/r", 39)).toEqual({
      stateReason: "COMPLETED", closer: { kind: "pr", number: 7, merged: true, repo: "" },
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

// --- #309, round 2: previously untested sites + the 300-char cut ----------
//
// Characterization ahead of the ghRequest fold: these pin CURRENT behavior,
// so the refactor must pass them UNMODIFIED. repoIsWritable, deleteBranch
// and compareAhead had ZERO direct tests in this file before #309 — only
// callers' fakes exercised them.

describe("repoIsWritable", () => {
  it("200 with permissions.push answers true", async () => {
    respond = () => Response.json({ permissions: { push: true } });
    expect(await repoIsWritable("tok", "o/r")).toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r");
  });

  it("200 without a permissions object fails closed: false", async () => {
    respond = () => Response.json({});
    expect(await repoIsWritable("tok", "o/r")).toBe(false);
  });

  it("403 is false, not a throw — an answer, not a permission question", async () => {
    respond = () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
    expect(await repoIsWritable("tok", "o/r")).toBe(false);
  });

  it("404 is false, not a throw — a PAT's refusal to confirm a repo exists", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await repoIsWritable("tok", "o/r")).toBe(false);
  });

  it("500 throws this fn's exact message, GitHub's own words in it", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await repoIsWritable("tok", "o/r");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("read o/r failed (500): boom");
    }
  });
});

describe("deleteBranch", () => {
  it("DELETEs the ref with the standard header set and swallows a 2xx's body", async () => {
    respond = () => new Response(null, { status: 204 });
    await deleteBranch("tok", "o/r", "fleet/rescue/9");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/refs/heads/fleet/rescue/9");
    expect(calls[0].headers).toEqual(GH_STD_HEADERS);
    expect(calls[0].body).toBeUndefined();
  });

  it("a name with no slash still URL-encodes nothing away", async () => {
    respond = () => new Response(null, { status: 204 });
    await deleteBranch("tok", "o/r", "plain");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/refs/heads/plain");
  });

  it("500 throws this fn's exact message", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await deleteBranch("tok", "o/r", "b");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("delete o/r branch b failed (500): boom");
    }
  });

  it("never leaks the token into the thrown error message", async () => {
    respond = () => new Response("unauthorized", { status: 401 });
    try {
      await deleteBranch("super-secret-token", "o/r", "b");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-token");
    }
  });
});

describe("compareAhead", () => {
  it("reads ahead_by and the LAST commit's committer date (GitHub sends commits oldest-first)", async () => {
    respond = () => Response.json({
      ahead_by: 3,
      commits: [
        { commit: { committer: { date: "2026-10-01T10:00:00Z" } } },
        { commit: { committer: { date: "2026-10-05T10:00:00Z" } } },
      ],
    });
    expect(await compareAhead("tok", "o/r", "main", "feat/x")).toEqual({
      aheadBy: 3, lastCommitAt: "2026-10-05T10:00:00Z",
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/compare/main...feat%2Fx");
  });

  it("a compare with no commits still answers, last commit unknown", async () => {
    respond = () => Response.json({ ahead_by: 0, commits: [] });
    expect(await compareAhead("tok", "o/r", "main", "feat/x")).toEqual({ aheadBy: 0, lastCommitAt: null });
  });

  it("a 404 is null — the ref cannot be resolved, never a fabricated zero", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    expect(await compareAhead("tok", "o/r", "main", "gone")).toBeNull();
  });

  it("500 throws this fn's exact message", async () => {
    respond = () => new Response("boom", { status: 500 });
    try {
      await compareAhead("tok", "o/r", "main", "feat/x");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("compare o/r main...feat/x failed (500): boom");
    }
  });

  it("a missing ahead_by throws rather than answering a guess", async () => {
    respond = () => Response.json({ commits: [] });
    await expect(compareAhead("tok", "o/r", "main", "feat/x")).rejects.toThrow(/named no ahead_by/);
  });
});

// #309 finding 4: the error cut is 300 chars, exactly. A 1000-char body
// must surface its first 300 chars and NOT one character more.
describe("the 300-char error cut (#309 finding 4)", () => {
  it("carries exactly the first 300 chars of a 1000-char GitHub error body, no more", async () => {
    const longBody = "x".repeat(1000);
    respond = () => new Response(longBody, { status: 500 });
    try {
      await pullRequestExists("tok", "o/r", 4242);
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      const cut = longBody.slice(0, 300);
      expect(msg.endsWith(cut)).toBe(true);
      expect(msg).not.toContain(cut + "x"); // char 301 must not be in it
    }
  });
});

// #311 finding 3: no production caller sends a header value differing
// from the standard set (GH_HEADERS_GET's only difference is the undefined
// deletion marker), so nothing else in this file can tell caller-wins from
// base-wins. ghRequest is exported as the test seam precisely for this pin.
describe("ghRequest's merge order (#311 finding 3)", () => {
  it("a caller's header beats the standard set; a custom key rides alongside the rest", async () => {
    await ghRequest("tok", "https://api.github.com/repos/o/r", {
      method: "GET",
      headers: { accept: "application/vnd.github.raw+json", "x-test": "1" },
    }, "read o/r");
    expect(calls[0].headers.accept).toBe("application/vnd.github.raw+json");
    expect(calls[0].headers["x-test"]).toBe("1");
    // The untouched standard keys all survive alongside the overridden one.
    expect(calls[0].headers).toEqual({
      authorization: "Bearer tok",
      accept: "application/vnd.github.raw+json",
      "user-agent": "fleetflare",
      "content-type": "application/json",
      "x-test": "1",
    });
  });

  it("a caller's undefined deletes that standard key before fetch sees the headers", async () => {
    await ghRequest("tok", "https://api.github.com/repos/o/r", {
      method: "GET",
      headers: { "content-type": undefined },
    }, "read o/r");
    expect(calls[0].headers["content-type"]).toBeUndefined();
    expect(Object.hasOwn(calls[0].headers, "content-type")).toBe(false);
  });
});

describe("listOpenPulls", () => {
  it("GETs open PRs and returns number + head sha + base ref", async () => {
    respond = () => Response.json([
      { number: 7, head: { sha: "abc1234567890" }, base: { ref: "main" } },
      { number: 8, head: { sha: "abc1234567890" }, base: { ref: "staging" } },
    ]);
    const pulls = await listOpenPulls("tok", "o/r");
    expect(pulls).toEqual([
      { number: 7, headSha: "abc1234567890", baseRef: "main" },
      { number: 8, headSha: "abc1234567890", baseRef: "staging" },
    ]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/repos/o/r/pulls?");
    expect(calls[0].url).toContain("state=open");
  });

  it("throws GitHub's own words on a non-2xx", async () => {
    respond = () => new Response('{"message":"Not Found"}', { status: 404 });
    await expect(listOpenPulls("tok", "o/r")).rejects.toThrow(/Not Found/);
  });
});
