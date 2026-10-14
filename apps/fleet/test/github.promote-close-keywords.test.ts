import { describe, it, expect, vi } from "vitest";
import {
  resolveIssuesForPushCommits, closesIssueByKeyword,
  type PromoteCloseApi,
  type BatchedPull,
} from "../src/github/promote-close";

function fakeApi(overrides: Partial<PromoteCloseApi> = {}): PromoteCloseApi {
  return {
    listPullsForCommit: async () => [],
    closingIssues: async () => [],
    listPullCommits: async () => [],
    getPullRequestMergeCommit: async () => null,
    ...overrides,
  };
}

// Issue #248: GitHub's closing-keyword grammar, read from a PR's title/body.
// closingIssuesReferences is empty for a PR into staging, so reap needs it.
describe("closesIssueByKeyword (#248)", () => {
  const yes: [string, string][] = [
    ["Closes #107", "plain"],
    ["fixes: #107", "colon, lower case"],
    ["RESOLVED #107", "upper case"],
    ["Fixed o/r#107", "same repo, qualified"],
    ["Close O/R#107", "repo case-insensitive"],
    ["resolves https://github.com/o/r/issues/107", "issue URL"],
    ["closes #10, closes #107", "second of two"],
    ["feat: x\n\nFix #107.", "sentence end"],
  ];
  const no: [string, string][] = [
    ["feat(restart): composer — PR4a of #107", "mention, no keyword"],
    ["Closes #1070", "longer number"],
    ["Closes other/repo#107", "other repo"],
    ["encloses #107", "keyword inside a word"],
    ["Closes: see #107", "keyword not followed by the ref"],
    ["", "empty"],
  ];
  for (const [text, why] of yes) it(`claims — ${why}`, () => expect(closesIssueByKeyword(text, 107, "o/r")).toBe(true));
  for (const [text, why] of no) it(`does not claim — ${why}`, () => expect(closesIssueByKeyword(text, 107, "o/r")).toBe(false));

  // #265: caller slug may be stale; the canonical name counts as this repo too.
  it("claims under either the caller slug or the canonical name", () => {
    const names = ["old/name", "new/name"];
    expect(closesIssueByKeyword("Fixes new/name#107", 107, names)).toBe(true);
    expect(closesIssueByKeyword("Fixes OLD/name#107", 107, names)).toBe(true);
    expect(closesIssueByKeyword("Fixes other/repo#107", 107, names)).toBe(false);
    // K3: names in GitHub's case still match a lower-case ref.
    expect(closesIssueByKeyword("Fixes new/name#107", 107, ["Old/Name", "New/Name"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #208: Path 1 batched — commit -> associatedPullRequests ->
// closingIssuesReferences for up to 100 commits in ONE GraphQL call, instead
// of listPullsForCommit + closingIssues per commit/PR. Same issues, same
// order, same #198 dedup and budget.
// ---------------------------------------------------------------------------
describe("batched Path 1 (#208)", () => {
  /** A tiny GitHub: commit -> PRs, PR -> closing issues, PR -> original commits. */
  type Graph = { prsOf: Record<string, number[]>; closes: Record<number, number[]>; commitsOf: Record<number, string[]> };

  function ports(g: Graph) {
    const calls = { listPullsForCommit: 0, closingIssues: 0, listPullCommits: 0, batch: 0, batchSizes: [] as number[], batchCommits: [] as boolean[] };
    const rest: PromoteCloseApi = fakeApi({
      listPullsForCommit: async (sha) => (calls.listPullsForCommit++, (g.prsOf[sha] ?? []).map((number) => ({ number }))),
      closingIssues: async (pr) => (calls.closingIssues++, g.closes[pr] ?? []),
      listPullCommits: async (pr) => (calls.listPullCommits++, g.commitsOf[pr] ?? []),
    });
    const batched: PromoteCloseApi = {
      ...rest,
      pullsWithClosingIssuesForCommits: async (shas, opts) => {
        calls.batch++;
        calls.batchSizes.push(shas.length);
        calls.batchCommits.push(opts.commits);
        return new Map(shas.map((s) => [s, {
          prsTotal: (g.prsOf[s] ?? []).length,
          prs: (g.prsOf[s] ?? []).map((number) => ({
            number,
            closingIssues: g.closes[number] ?? [], closingIssuesTotal: (g.closes[number] ?? []).length,
            commits: (g.commitsOf[number] ?? []).slice(0, 100), commitsTotal: (g.commitsOf[number] ?? []).length,
          })),
        }]));
      },
    };
    return { rest, batched, calls };
  }

  const SHAPES: Record<string, { g: Graph; push: string[] }> = {
    "plain: each commit its own PR, one issue each": {
      g: { prsOf: { a: [1], b: [2], c: [3] }, closes: { 1: [11], 2: [12], 3: [13] }, commitsOf: {} },
      push: ["a", "b", "c"],
    },
    "one PR shared by many commits, and a commit in two PRs": {
      g: { prsOf: { a: [1], b: [1], c: [1, 2], d: [] }, closes: { 1: [11, 12], 2: [13] }, commitsOf: {} },
      push: ["a", "b", "c", "d"],
    },
    "promotion merge with empty closingIssues: squash fallback to original commits, overlapping the push": {
      g: {
        prsOf: { m: [100], x: [5], y: [6], z: [5] },
        closes: { 100: [], 5: [51], 6: [61, 62] },
        commitsOf: { 100: ["x", "y", "z", "m"] },
      },
      push: ["m", "x"],
    },
  };
  SHAPES["two PRs close the same issue (M7)"] = {
    g: { prsOf: { a: [1], b: [2] }, closes: { 1: [11], 2: [11, 12] }, commitsOf: {} },
    push: ["a", "b"],
  };
  // PR 101 is first reached at depth 1 (no further fallback), so its own
  // originals, and issue 70, are out of reach. Order is load-bearing.
  SHAPES["PR order decides fallback reach (M12)"] = {
    g: { prsOf: { m: [100, 101], y: [101], z: [7] }, closes: { 100: [], 101: [], 7: [70] }, commitsOf: { 100: ["y"], 101: ["z"] } },
    push: ["m"],
  };
  // A 230-commit promotion: three GraphQL chunks (100, 100, 30).
  const big: Graph = { prsOf: {}, closes: {}, commitsOf: {} };
  const bigPush = Array.from({ length: 230 }, (_, i) => `s${i}`);
  bigPush.forEach((s, i) => {
    big.prsOf[s] = [1000 + Math.floor(i / 5)];
    big.closes[1000 + Math.floor(i / 5)] = i % 3 === 0 ? [i] : [];
  });
  SHAPES["230 commits, PRs of 5, some closing issues"] = { g: big, push: bigPush };
  // A promotion of 50 release merges, each a PR with empty closingIssues over
  // 3 original commits: the fallback level is 150 shas across 50 PRs.
  const fan: Graph = { prsOf: {}, closes: {}, commitsOf: {} };
  const fanPush = Array.from({ length: 50 }, (_, i) => `m${i}`);
  fanPush.forEach((m, i) => {
    fan.prsOf[m] = [2000 + i];
    fan.closes[2000 + i] = [];
    fan.commitsOf[2000 + i] = [0, 1, 2].map((k) => `o${i}-${k}`);
    fan.commitsOf[2000 + i]!.forEach((o, k) => { fan.prsOf[o] = [3000 + i]; fan.closes[3000 + i] = k === 0 && i % 4 === 0 ? [i] : []; });
  });
  SHAPES["50 promotion merges, each falling back to 3 original commits"] = { g: fan, push: fanPush };

  for (const [name, { g, push }] of Object.entries(SHAPES)) {
    it(`same result as the REST walk — ${name}`, async () => {
      const { rest, batched } = ports(g);
      expect(await resolveIssuesForPushCommits(batched, push)).toEqual(await resolveIssuesForPushCommits(rest, push));
    });
  }

  it("no per-commit REST: one GraphQL call per 100 push commits", async () => {
    const { batched, calls } = ports(big);
    await resolveIssuesForPushCommits(batched, bigPush);
    expect(calls).toMatchObject({ listPullsForCommit: 0, closingIssues: 0, batch: 3, batchSizes: [100, 100, 30] });
  });

  it("squash fallback: PR commits come from the batch, then ONE batch for its not-yet-seen original commits", async () => {
    const { g, push } = SHAPES["promotion merge with empty closingIssues: squash fallback to original commits, overlapping the push"]!;
    const { batched, calls } = ports(g);
    await resolveIssuesForPushCommits(batched, push);
    expect(calls).toMatchObject({ listPullsForCommit: 0, closingIssues: 0, listPullCommits: 0, batch: 2, batchSizes: [2, 2] });
    // #252: original commits never fall back again, so their PRs' commits are not asked for.
    expect(calls.batchCommits).toEqual([true, false]);
  });

  it("fallback across many PRs: batched per 100 shas for the whole push, not one round per PR", async () => {
    const { batched, calls } = ports(fan);
    await resolveIssuesForPushCommits(batched, fanPush);
    expect(calls).toMatchObject({ listPullsForCommit: 0, closingIssues: 0, listPullCommits: 0, batch: 3, batchSizes: [50, 100, 50] });
    expect(calls.batchCommits).toEqual([true, false, false]);
  });

  it("a PR the batch gave no commit list for still walks listPullCommits over REST", async () => {
    const { g, push } = SHAPES["promotion merge with empty closingIssues: squash fallback to original commits, overlapping the push"]!;
    const { rest, batched, calls } = ports(g);
    const noCommits: PromoteCloseApi = {
      ...batched,
      pullsWithClosingIssuesForCommits: async (shas, opts) => new Map(
        [...(await batched.pullsWithClosingIssuesForCommits!(shas, opts))]
          .map(([s, c]) => [s, { ...c, prs: c.prs.map(({ commits: _, commitsTotal: __, ...pr }) => pr) }]),
      ),
    };
    expect(await resolveIssuesForPushCommits(noCommits, push)).toEqual(await resolveIssuesForPushCommits(rest, push));
    expect(calls.listPullCommits).toBe(2);
  });

  it("a PR reached over REST (its sha left out of the answer) still gets its originals batched in-walk (M8)", async () => {
    const { g, push } = SHAPES["promotion merge with empty closingIssues: squash fallback to original commits, overlapping the push"]!;
    const { rest, batched, calls } = ports(g);
    let first = true;
    const partial: PromoteCloseApi = {
      ...batched,
      // First answer leaves every push sha out, as the real port does for a
      // sha it cannot inline; those walk REST.
      pullsWithClosingIssuesForCommits: async (shas, opts) => {
        const answer = await batched.pullsWithClosingIssuesForCommits!(shas, opts);
        if (first) { first = false; return new Map(); }
        return answer;
      },
    };
    expect(await resolveIssuesForPushCommits(partial, push)).toEqual(await resolveIssuesForPushCommits(rest, push));
    // The in-walk prefetch batched PR #100's unseen originals.
    expect(calls.batchSizes).toEqual([2, 3]);
    // #265 (mutant F2): the in-walk batch does not ask for PR commits.
    expect(calls.batchCommits).toEqual([true, false]);
  });

  it("the open circuit also holds for a later prefetch in the same push — the squash fallback's in-walk batch (#252)", async () => {
    const { g, push } = SHAPES["promotion merge with empty closingIssues: squash fallback to original commits, overlapping the push"]!;
    const { rest, batched, calls } = ports(g);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing: PromoteCloseApi = { ...batched, pullsWithClosingIssuesForCommits: async () => { calls.batch++; throw new Error("graphql 502"); } };
      expect(await resolveIssuesForPushCommits(failing, push)).toEqual(await resolveIssuesForPushCommits(rest, push));
      expect(calls.batch).toBe(1);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("one failed batch opens the circuit: every later chunk goes straight to REST, one log (#252)", async () => {
    const { rest, batched, calls } = ports(big);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing: PromoteCloseApi = { ...batched, pullsWithClosingIssuesForCommits: async () => { calls.batch++; throw new Error("graphql 502"); } };
      expect(await resolveIssuesForPushCommits(failing, bigPush)).toEqual(await resolveIssuesForPushCommits(rest, bigPush));
      expect(calls.batch).toBe(1);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]!.join(" ")).toContain("graphql 502");
    } finally {
      errors.mockRestore();
    }
  });

  it("a failed batch falls back to the REST walk for that chunk — same result, and it is said", async () => {
    const { g, push } = SHAPES["one PR shared by many commits, and a commit in two PRs"]!;
    const { rest, batched, calls } = ports(g);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing: PromoteCloseApi = { ...batched, pullsWithClosingIssuesForCommits: async () => { calls.batch++; throw new Error("graphql 502"); } };
      expect(await resolveIssuesForPushCommits(failing, push)).toEqual(await resolveIssuesForPushCommits(rest, push));
      expect(errors.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("graphql 502");
    } finally {
      errors.mockRestore();
    }
  });

  it("under 10s of budget left: no batch call (GitHub's GraphQL timeout would outlive waitUntil), REST walk, cutoff logged once", async () => {
    const { batched, calls } = ports(big);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // First read 5s before the deadline, then 1s later per read.
      let t = 20_000;
      const clock = () => (t += 1_000) - 1_000;
      await resolveIssuesForPushCommits(batched, bigPush, { repo: "o/r", budget: { clock, deadline: 25_000 } });
      expect(calls.batch).toBe(0);
      expect(calls.listPullsForCommit).toBeGreaterThan(0);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]!.join(" ")).toContain("Path 1:");
    } finally {
      errors.mockRestore();
    }
  });

  it("10s or more of budget left: the batch call is made", async () => {
    const { batched, calls } = ports(big);
    await resolveIssuesForPushCommits(batched, bigPush, { repo: "o/r", budget: { clock: () => 15_000, deadline: 25_000 } });
    expect(calls.batch).toBe(3);
  });

  it("a connection GitHub cut at its page size is said, once each: repo, sha or PR, walked N of total", async () => {
    const api: PromoteCloseApi = fakeApi({
      pullsWithClosingIssuesForCommits: async (shas) => new Map(shas.map((s) => [s, ({
        a: { prsTotal: 31, prs: [{ number: 1, closingIssues: [11], closingIssuesTotal: 25 }] },
        m: { prsTotal: 1, prs: [{ number: 1772, closingIssues: [], commits: ["x"], commitsTotal: 117 }] },
        x: { prsTotal: 0, prs: [] },
      } as Record<string, { prsTotal: number; prs: BatchedPull[] }>)[s]!])),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await resolveIssuesForPushCommits(api, ["a", "m", "a"], { repo: "o/r" });
      const lines = errors.mock.calls.map((c) => c.join(" "));
      expect(lines).toHaveLength(3);
      expect(lines).toContainEqual(expect.stringMatching(/o\/r.*commit a.*walked 1 of 31 associated PRs/));
      expect(lines).toContainEqual(expect.stringMatching(/o\/r.*PR #1\b.*walked 1 of 25 closing issues/));
      expect(lines).toContainEqual(expect.stringMatching(/o\/r.*PR #1772.*walked 1 of 117 commits/));
    } finally {
      errors.mockRestore();
    }
  });

  it("no connection cut (every total equals its page): nothing logged", async () => {
    const { g, push } = SHAPES["promotion merge with empty closingIssues: squash fallback to original commits, overlapping the push"]!;
    const { batched } = ports(g);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await resolveIssuesForPushCommits(batched, push, { repo: "o/r" });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("an already-exceeded budget makes no batch call and logs its cutoff once (#198 semantics kept)", async () => {
    const { batched, calls } = ports(big);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await resolveIssuesForPushCommits(batched, bigPush, { repo: "o/r", budget: { clock: () => 100, deadline: 0 } });
      expect(result).toEqual([]);
      expect(calls.batch).toBe(0);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });
});
