import { describe, it, expect, vi } from "vitest";
import {
  resolveIssuesForPushCommits, resolveIssuesFromEnvelopeArtifacts, mergeClosable, closesIssueByKeyword,
  type PromoteCloseApi,
  type BatchedPull,
} from "../src/github/promote-close";
import type { TimeBudget } from "../src/time-budget";

// Board issue #8's core resolver: pure, DI'd over a tiny port, no HTTP
// anywhere — every rule here is proven without a network, same discipline
// as src/board/verify.ts's own pure core.

function fakeApi(overrides: Partial<PromoteCloseApi> = {}): PromoteCloseApi {
  return {
    listPullsForCommit: async () => [],
    closingIssues: async () => [],
    listPullCommits: async () => [],
    getPullRequestMergeCommit: async () => null,
    ...overrides,
  };
}

describe("resolveIssuesForPushCommits — the primary commit -> PR -> issue path", () => {
  it("a commit whose PR's GraphQL closingIssuesReferences names an issue resolves it", async () => {
    const api = fakeApi({
      listPullsForCommit: async (sha) => (sha === "c1" ? [{ number: 7 }] : []),
      closingIssues: async (pr) => (pr === 7 ? [42] : []),
    });
    const result = await resolveIssuesForPushCommits(api, ["c1"]);
    expect(result).toEqual([{ issue: 42, sha: "c1", viaPr: 7 }]);
  });

  it("a commit belonging to no PR resolves nothing", async () => {
    const api = fakeApi({ listPullsForCommit: async () => [] });
    expect(await resolveIssuesForPushCommits(api, ["orphan"])).toEqual([]);
  });

  it("one PR can close more than one issue", async () => {
    const api = fakeApi({
      listPullsForCommit: async () => [{ number: 7 }],
      closingIssues: async () => [42, 43],
    });
    const result = await resolveIssuesForPushCommits(api, ["c1"]);
    expect(result).toEqual([
      { issue: 42, sha: "c1", viaPr: 7 },
      { issue: 43, sha: "c1", viaPr: 7 },
    ]);
  });

  it("walks every commit in the push, not just the first", async () => {
    const api = fakeApi({
      listPullsForCommit: async (sha) => [{ number: sha === "c1" ? 7 : 8 }],
      closingIssues: async (pr) => [pr === 7 ? 42 : 43],
    });
    const result = await resolveIssuesForPushCommits(api, ["c1", "c2"]);
    expect(result).toEqual([
      { issue: 42, sha: "c1", viaPr: 7 },
      { issue: 43, sha: "c2", viaPr: 8 },
    ]);
  });

  // The load-bearing case: staging -> main promotion is almost always a
  // squash, which creates ONE NEW commit that was never part of any
  // original small PR. Step 1's lookup on that new sha returns the
  // PROMOTION PR itself, and a promotion PR's body never carries "Fixes
  // #N" -- so its own closingIssuesReferences comes back EMPTY, and the
  // fallback has to walk the promotion PR's own /commits to recover the
  // original pre-squash shas.
  describe("squash-merge fallback", () => {
    it("an empty closingIssuesReferences on the found PR falls back to its own original commits", async () => {
      const api = fakeApi({
        // The push's one commit (the squash) belongs only to the promotion PR (#100).
        listPullsForCommit: async (sha) => {
          if (sha === "squash-sha") return [{ number: 100 }];
          if (sha === "orig-sha") return [{ number: 7 }]; // the ORIGINAL small PR into staging
          return [];
        },
        // The promotion PR (#100) closes nothing directly -- no keyword in its body.
        // The original PR (#7) DOES close an issue.
        closingIssues: async (pr) => (pr === 100 ? [] : pr === 7 ? [42] : []),
        // GitHub's own record of PR #100's constituent commits survives the squash.
        listPullCommits: async (pr) => (pr === 100 ? ["orig-sha"] : []),
      });
      const result = await resolveIssuesForPushCommits(api, ["squash-sha"]);
      expect(result).toEqual([{ issue: 42, sha: "orig-sha", viaPr: 7 }]);
    });

    it("depth-limited to one extra level -- a second-order fallback is skipped, not looped", async () => {
      const api = fakeApi({
        listPullsForCommit: async (sha) => {
          if (sha === "squash-sha") return [{ number: 100 }];
          if (sha === "nested-sha") return [{ number: 200 }];
          return [];
        },
        // Both #100 and #200 close nothing directly -- every level looks like
        // another promotion PR.
        closingIssues: async () => [],
        listPullCommits: async (pr) => {
          if (pr === 100) return ["nested-sha"];
          if (pr === 200) return ["never-reached-sha"];
          return [];
        },
      });
      const result = await resolveIssuesForPushCommits(api, ["squash-sha"]);
      // #200's own closingIssuesReferences was checked (empty), but the
      // fallback into ITS commits never runs -- depth 1 is already spent.
      expect(result).toEqual([]);
    });

    it("multiple original commits under one promotion PR each resolve independently", async () => {
      const api = fakeApi({
        listPullsForCommit: async (sha) => {
          if (sha === "squash-sha") return [{ number: 100 }];
          if (sha === "orig-a") return [{ number: 7 }];
          if (sha === "orig-b") return [{ number: 8 }];
          return [];
        },
        closingIssues: async (pr) => (pr === 100 ? [] : pr === 7 ? [42] : pr === 8 ? [43] : []),
        listPullCommits: async (pr) => (pr === 100 ? ["orig-a", "orig-b"] : []),
      });
      const result = await resolveIssuesForPushCommits(api, ["squash-sha"]);
      expect(result).toEqual([
        { issue: 42, sha: "orig-a", viaPr: 7 },
        { issue: 43, sha: "orig-b", viaPr: 8 },
      ]);
    });

    it("a failed listPullCommits during fallback is logged and skipped, not thrown", async () => {
      const api = fakeApi({
        listPullsForCommit: async () => [{ number: 100 }],
        closingIssues: async () => [],
        listPullCommits: async () => { throw new Error("rate limited"); },
      });
      await expect(resolveIssuesForPushCommits(api, ["squash-sha"])).resolves.toEqual([]);
    });
  });

  it("a thrown listPullsForCommit is logged and skipped, not thrown to the caller", async () => {
    const api = fakeApi({ listPullsForCommit: async () => { throw new Error("boom"); } });
    await expect(resolveIssuesForPushCommits(api, ["c1"])).resolves.toEqual([]);
  });

  it("a thrown closingIssues reads as no closing issues found for that PR, not a crash", async () => {
    const api = fakeApi({
      listPullsForCommit: async () => [{ number: 7 }],
      closingIssues: async () => { throw new Error("boom"); },
      listPullCommits: async () => [],
    });
    await expect(resolveIssuesForPushCommits(api, ["c1"])).resolves.toEqual([]);
  });

  // Board issue #198: a big promotion's squash-fallback recursion used to
  // re-walk the SAME PR's closingIssues/listPullCommits once per top-level
  // commit that happens to belong to it -- measured live (acme-os,
  // 2026-09-24): 53/137/747 calls for three real promotion pushes, collapsing
  // to 31/77/381 once deduped. This must not change WHICH issues end up
  // closable -- only how many redundant calls it takes to find them.
  describe("cross-push dedup (#198)", () => {
    it("two top-level commits mapping to the SAME PR call closingIssues only once", async () => {
      const closingIssues = vi.fn(async (pr: number) => (pr === 7 ? [42] : []));
      const api = fakeApi({
        listPullsForCommit: async () => [{ number: 7 }],
        closingIssues,
      });
      const result = await resolveIssuesForPushCommits(api, ["c1", "c2"]);
      // First sha wins -- same evidence, one entry, not two duplicates.
      expect(result).toEqual([{ issue: 42, sha: "c1", viaPr: 7 }]);
      expect(closingIssues).toHaveBeenCalledTimes(1);
      expect(closingIssues).toHaveBeenCalledWith(7);
    });

    it("a PR reached via the squash fallback from TWO different top-level commits only walks listPullCommits once", async () => {
      const listPullCommits = vi.fn(async (pr: number) => (pr === 100 ? ["orig-sha"] : []));
      const api = fakeApi({
        listPullsForCommit: async (sha) => {
          if (sha === "squash-a" || sha === "squash-b") return [{ number: 100 }];
          if (sha === "orig-sha") return [{ number: 7 }];
          return [];
        },
        closingIssues: async (pr) => (pr === 100 ? [] : pr === 7 ? [42] : []),
        listPullCommits,
      });
      const result = await resolveIssuesForPushCommits(api, ["squash-a", "squash-b"]);
      expect(result).toEqual([{ issue: 42, sha: "orig-sha", viaPr: 7 }]);
      expect(listPullCommits).toHaveBeenCalledTimes(1);
    });

    it("the same sha reached twice (a top-level commit that is also a fallback's original commit) is walked only once", async () => {
      const listPullsForCommit = vi.fn(async (sha: string) => {
        if (sha === "squash-sha") return [{ number: 100 }];
        if (sha === "shared-sha") return [{ number: 7 }];
        return [];
      });
      const api = fakeApi({
        listPullsForCommit,
        closingIssues: async (pr) => (pr === 100 ? [] : pr === 7 ? [42] : []),
        listPullCommits: async (pr) => (pr === 100 ? ["shared-sha"] : []),
      });
      // "shared-sha" appears both as a top-level push commit AND as PR #100's
      // own original commit (an unusual but possible shape) -- it must only
      // be walked (listPullsForCommit) once across the whole push.
      const result = await resolveIssuesForPushCommits(api, ["squash-sha", "shared-sha"]);
      expect(result).toEqual([{ issue: 42, sha: "shared-sha", viaPr: 7 }]);
      expect(listPullsForCommit).toHaveBeenCalledTimes(2); // squash-sha, then shared-sha (first encounter only)
      expect(listPullsForCommit).toHaveBeenCalledWith("shared-sha");
    });

    it("multiple issues from one PR are still all resolved even though the PR itself is only resolved once", async () => {
      const closingIssues = vi.fn(async () => [42, 43]);
      const api = fakeApi({ listPullsForCommit: async () => [{ number: 7 }], closingIssues });
      const result = await resolveIssuesForPushCommits(api, ["c1", "c2", "c3"]);
      expect(result).toEqual([
        { issue: 42, sha: "c1", viaPr: 7 },
        { issue: 43, sha: "c1", viaPr: 7 },
      ]);
      expect(closingIssues).toHaveBeenCalledTimes(1);
    });
  });

  // Board issue #198, finding 3: a ~25s shared wall-clock budget, checked
  // before each top-level commit in this loop -- in ADDITION to the
  // per-commit resolution work itself, never replacing it. A fake, fully
  // controllable clock proves the early-stop without a real sleep.
  describe("time budget (#198)", () => {
    function fakeBudget(overrides: Partial<TimeBudget> = {}): TimeBudget {
      return { clock: () => 0, deadline: 1, ...overrides };
    }

    it("an already-exceeded budget stops before a single commit is processed, logs once with repo + done/total", async () => {
      const listPullsForCommit = vi.fn(async () => [{ number: 7 }]);
      const api = fakeApi({ listPullsForCommit });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const budget = fakeBudget({ clock: () => 100, deadline: 0 });

      const result = await resolveIssuesForPushCommits(api, ["c1", "c2", "c3"], { repo: "o/r", budget });

      expect(result).toEqual([]);
      expect(listPullsForCommit).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(1);
      const [msg] = errors.mock.calls[0] as [string];
      expect(msg).toContain("o/r");
      expect(msg).toContain("Path 1");
      expect(msg).toContain("0/3");
      errors.mockRestore();
    });

    it("stops mid-loop once the budget is exceeded after N commits, reporting done/total once", async () => {
      const listPullsForCommit = vi.fn(async (sha: string) => [{ number: sha === "c1" ? 7 : 8 }]);
      const api = fakeApi({ listPullsForCommit, closingIssues: async () => [42] });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let calls = 0;
      // Board issue #215, Gap 2: c1 now costs TWO budget checks, not one --
      // this loop's own top-level check, THEN resolveForCommit's own check
      // before c1's single PR (#7). Both must read as within-budget for c1
      // to fully resolve; the third check (c2's own top-level check) is the
      // one that trips.
      const budget = fakeBudget({ clock: () => (calls++ < 2 ? 0 : 100), deadline: 1 });

      const result = await resolveIssuesForPushCommits(api, ["c1", "c2", "c3"], { repo: "o/r", budget });

      expect(result).toEqual([{ issue: 42, sha: "c1", viaPr: 7 }]);
      expect(errors).toHaveBeenCalledTimes(1);
      const [msg] = errors.mock.calls[0] as [string];
      expect(msg).toContain("1/3");
      errors.mockRestore();
    });

    it("no budget given at all -- existing callers unaffected, never checked, never exceeded", async () => {
      const api = fakeApi({
        listPullsForCommit: async () => [{ number: 7 }],
        closingIssues: async () => [42],
      });
      const result = await resolveIssuesForPushCommits(api, ["c1"]);
      expect(result).toEqual([{ issue: 42, sha: "c1", viaPr: 7 }]);
    });

    // Board issue #215, Gap 2's own regression test: the OLD code checked
    // the budget only once per TOP-LEVEL commit -- a single top-level commit
    // whose PR has many original commits (a genuine squash-merge shape, no
    // closing keyword anywhere) could blow through the WHOLE budget entirely
    // inside ONE top-level loop iteration's own fallback, with no check and
    // no log anywhere. Six original commits stands in for the real,
    // synthetic-but-realistic 57-commit case this issue measured live.
    it("a squash PR's own fallback loop over its original commits stops mid-way when the budget runs out, logging once with the nested loop's own done/total", async () => {
      const closingIssues = vi.fn(async (pr: number) => (pr === 100 ? [] : [1000 + pr]));
      const listPullCommits = vi.fn(async (pr: number) =>
        pr === 100 ? ["o1", "o2", "o3", "o4", "o5", "o6"] : [],
      );
      const listPullsForCommit = vi.fn(async (sha: string) => {
        if (sha === "squash-sha") return [{ number: 100 }];
        const origIndex = ["o1", "o2", "o3", "o4", "o5", "o6"].indexOf(sha);
        return origIndex === -1 ? [] : [{ number: 700 + origIndex }];
      });
      const api = fakeApi({ listPullsForCommit, closingIssues, listPullCommits });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      // 8 within-budget clock reads get consumed before the fallback's own
      // loop trips on its 4th original commit (o4, j=3): 1 for the
      // top-level loop's own check (the one push commit), 1 for
      // resolveForCommit's PR-loop check (PR #100), then one PAIR per
      // original commit fully resolved (the fallback loop's own check, then
      // that commit's OWN nested resolveForCommit PR-loop check) for o1, o2,
      // o3 = 6 more -- 1 + 1 + 6 = 8. The 9th read (before o4) is exceeded.
      let calls = 0;
      const budget: TimeBudget = { clock: () => (calls++ < 8 ? 0 : 100), deadline: 1 };

      const result = await resolveIssuesForPushCommits(api, ["squash-sha"], { repo: "acme-test/scratch", budget });

      // Only o1, o2, o3 (PRs 700, 701, 702) resolved -- o4, o5, o6 never reached.
      expect(result).toEqual([
        { issue: 1700, sha: "o1", viaPr: 700 },
        { issue: 1701, sha: "o2", viaPr: 701 },
        { issue: 1702, sha: "o3", viaPr: 702 },
      ]);
      // Logged exactly once -- not once per nested check that later sees the
      // same already-exceeded budget (the outer loop never gets a second
      // top-level commit to check here, but the fix's own budgetLogged flag
      // is what would prevent a double-log in a push with more commits too).
      expect(errors).toHaveBeenCalledTimes(1);
      const [msg] = errors.mock.calls[0] as [string];
      expect(msg).toContain("acme-test/scratch");
      // The NESTED loop's own progress (3 of the PR's 6 original commits),
      // not the flat top-level "N of M pushed commits" framing.
      expect(msg).toContain("3/6");
      expect(msg).toContain("#100");
      errors.mockRestore();
    });
  });
});

describe("resolveIssuesFromEnvelopeArtifacts — the no-closing-keyword-at-all cross-check", () => {
  it("matches when the PR's merge commit sha is in the push's own commit list", async () => {
    const api = fakeApi({ getPullRequestMergeCommit: async (pr) => (pr === 9 ? "merge-sha" : null) });
    const result = await resolveIssuesFromEnvelopeArtifacts(
      api, [{ taskNumber: 55, prNumber: 9 }], new Set(["merge-sha", "other-sha"]),
    );
    expect(result).toEqual([{ issue: 55, sha: "merge-sha", viaPr: 9 }]);
  });

  it("falls back to the PR's own original commits when the merge commit itself isn't in the push", async () => {
    const api = fakeApi({
      getPullRequestMergeCommit: async () => "not-in-push",
      listPullCommits: async (pr) => (pr === 9 ? ["c1", "c2"] : []),
    });
    const result = await resolveIssuesFromEnvelopeArtifacts(
      api, [{ taskNumber: 55, prNumber: 9 }], new Set(["c2"]),
    );
    expect(result).toEqual([{ issue: 55, sha: "c2", viaPr: 9 }]);
  });

  it("no intersection at all resolves nothing for that task", async () => {
    const api = fakeApi({
      getPullRequestMergeCommit: async () => "unrelated",
      listPullCommits: async () => ["also-unrelated"],
    });
    const result = await resolveIssuesFromEnvelopeArtifacts(
      api, [{ taskNumber: 55, prNumber: 9 }], new Set(["c1"]),
    );
    expect(result).toEqual([]);
  });

  it("a thrown lookup for one candidate does not stop the others", async () => {
    const api = fakeApi({
      getPullRequestMergeCommit: async (pr) => {
        if (pr === 1) throw new Error("boom");
        return pr === 2 ? "sha2" : null;
      },
      listPullCommits: async () => [],
    });
    const result = await resolveIssuesFromEnvelopeArtifacts(
      api, [{ taskNumber: 1, prNumber: 1 }, { taskNumber: 2, prNumber: 2 }], new Set(["sha2"]),
    );
    expect(result).toEqual([{ issue: 2, sha: "sha2", viaPr: 2 }]);
  });
});

describe("mergeClosable — combine + dedup by issue", () => {
  it("keeps the primary path's evidence when both paths find the same issue", () => {
    const primary = [{ issue: 42, sha: "primary-sha", viaPr: 7 }];
    const extra = [{ issue: 42, sha: "extra-sha", viaPr: 9 }];
    expect(mergeClosable(primary, extra)).toEqual(primary);
  });

  it("adds an extra-path issue the primary path never found", () => {
    const primary = [{ issue: 42, sha: "s1", viaPr: 7 }];
    const extra = [{ issue: 55, sha: "s2", viaPr: 9 }];
    expect(mergeClosable(primary, extra)).toEqual([...primary, ...extra]);
  });

  it("empty + empty is empty", () => {
    expect(mergeClosable([], [])).toEqual([]);
  });
});

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
