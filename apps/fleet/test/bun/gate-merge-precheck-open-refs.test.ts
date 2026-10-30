// #1430: a closing keyword in a commit message fails the precheck only while
// the ref it names is still OPEN. A promotion PR re-presents commits whose
// refs already closed; those close nothing at merge. Fail closed: a lookup
// error or a keyword with no readable ref stays red. #1434: a qualified ref
// (`other/repo#5`, a URL) is looked up in its own repo, never the base repo.
// Neutral fixtures only (acme/example): this file ships public.
import { describe, expect, it } from "bun:test";
import {
  closedCommitRefs, mergePrecheckFailures, CLOSING_KEYWORD_COMMIT_FAILURE,
  COMMIT_REFS_CAP, COMMIT_REFS_CAP_FAILURE,
} from "../../src/gate/merge-precheck";

const REPO = "acme/example";

/** The workflow's order: look refs up, then run the pure decision. */
async function commitVerdict(
  messages: string[], state: (n: number, repo: string) => Promise<string>,
): Promise<string[]> {
  const { closed, overCap } = await closedCommitRefs(messages, REPO, state);
  return mergePrecheckFailures({
    title: "plain title", body: "", patterns: [], blobs: [], private: true,
    repo: REPO, commitMessages: messages, closedRefs: closed, closedRefsOverCap: overCap,
  });
}

const states = (m: Record<string, string>) => async (n: number, repo: string) => {
  const key = `${repo}#${n}`;
  if (!(key in m)) throw new Error(`unexpected lookup ${key}`);
  return m[key];
};

describe("#1430: commit-message closing keyword fails only on an OPEN ref", () => {
  it("positive control: a commit closing an OPEN issue still fails", async () => {
    expect(await commitVerdict(["feat: thing\n\nFixes #12"], states({ "acme/example#12": "open" })))
      .toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  it("a commit closing an already-CLOSED issue passes", async () => {
    expect(await commitVerdict(["Closes #12"], states({ "acme/example#12": "closed" }))).toEqual([]);
  });

  it("a commit naming an already-MERGED PR passes (REST reports merged as closed)", async () => {
    expect(await commitVerdict(["fix #34"], states({ "acme/example#34": "closed" }))).toEqual([]);
  });

  it("mixed open + closed refs fail", async () => {
    expect(await commitVerdict(
      ["Closes #12", "Fixes #34 and resolves #56"],
      states({ "acme/example#12": "closed", "acme/example#34": "closed", "acme/example#56": "open" }),
    )).toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  it("a lookup that throws fails closed", async () => {
    const throwing = async () => { throw new Error("GitHub 502"); };
    expect(await commitVerdict(["Closes #12"], throwing)).toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  it("positive control: the scan sees a planted keyword among clean commits", async () => {
    const lookedUp: string[] = [];
    const out = await commitVerdict(["plain one", "closes #99999", "plain two"], async (n, repo) => {
      lookedUp.push(`${repo}#${n}`);
      return "open";
    });
    expect(lookedUp).toEqual(["acme/example#99999"]);
    expect(out).toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  it("a keyword whose ref the GitHub grammar cannot read fails closed", async () => {
    // The crude scan hits `2fixes #1`; GitHub's grammar (word boundary) reads
    // no ref from it, so nothing proves it closed.
    expect(await commitVerdict(["v2fixes #1"], states({}))).toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  it("no ref state supplied keeps the keyword red (fail-closed default)", () => {
    expect(mergePrecheckFailures({
      title: "plain title", body: "", patterns: [], blobs: [], private: true,
      repo: REPO, commitMessages: ["Closes #12"],
    })).toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  // #1434: a qualified ref is looked up in its OWN repo, not the base repo.
  describe("#1434: qualified refs resolve against their own repo", () => {
    it("a foreign qualified ref is looked up in its own repo", async () => {
      const lookedUp: string[] = [];
      await commitVerdict(["fixes other/repo#5"], async (n, repo) => {
        lookedUp.push(`${repo}#${n}`);
        return "closed";
      });
      expect(lookedUp).toEqual(["other/repo#5"]);
    });

    it("the base #5 and other/repo#5 are different issues: base closed, other open stays red", async () => {
      // Old code dropped the qualifier and looked up only base #5; with base #5
      // closed it wrongly passed even though other/repo#5 is still open.
      expect(await commitVerdict(
        ["fixes other/repo#5 and fixes #5"],
        states({ "other/repo#5": "open", "acme/example#5": "closed" }),
      )).toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
    });

    it("base #5 and other/repo#5 both closed passes", async () => {
      expect(await commitVerdict(
        ["fixes other/repo#5 and fixes #5"],
        states({ "other/repo#5": "closed", "acme/example#5": "closed" }),
      )).toEqual([]);
    });

    it("a full issue URL ref is looked up in its own repo", async () => {
      const lookedUp: string[] = [];
      await commitVerdict(["resolves https://github.com/other/repo/issues/5"], async (n, repo) => {
        lookedUp.push(`${repo}#${n}`);
        return "closed";
      });
      expect(lookedUp).toEqual(["other/repo#5"]);
    });

    it("a foreign qualified ref whose lookup throws is treated as closed, not red (#1434 r2)", async () => {
      const throwing = async () => { throw new Error("GitHub 404"); };
      // #1434 r2: an unreadable FOREIGN ref is a warning, not red — the base
      // credential often cannot reach it (no App install), so red would be a
      // permanent new failure surface, not a fail-closed guard on the base repo.
      expect(await commitVerdict(["fixes other/repo#5"], throwing)).toEqual([]);
    });

    it("a colon form qualifies too: fixes: other/repo#5 in its own repo", async () => {
      const lookedUp: string[] = [];
      await commitVerdict(["fixes: other/repo#5"], async (n, repo) => {
        lookedUp.push(`${repo}#${n}`);
        return "open";
      });
      expect(lookedUp).toEqual(["other/repo#5"]);
    });
  });

  // #1434 r2: a foreign ref whose state cannot be read (no App install there,
  // the base token 404s) is treated as already closed — a warning, not red.
  // A base-repo unreadable ref stays red (fail closed).
  describe("#1434 r2: unreadable foreign ref warns, base ref stays red", () => {
    it("a foreign ref whose lookup throws is treated as closed, not red", async () => {
      const warnings: string[] = [];
      const result = await closedCommitRefs(["fixes other/repo#5"], REPO, async (n, repo) => {
        throw new Error("GitHub 404");
      });
      expect(result.closed.has("other/repo#5")).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("other/repo#5");
      // The pure decision then passes the keyword: every ref is "closed".
      expect(mergePrecheckFailures({
        title: "plain title", body: "", patterns: [], blobs: [], private: true,
        repo: REPO, commitMessages: ["fixes other/repo#5"], closedRefs: result.closed,
      })).toEqual([]);
    });

    it("a base-repo ref whose lookup throws stays red (fail closed)", async () => {
      const result = await closedCommitRefs(["Closes #12"], REPO, async () => {
        throw new Error("GitHub 502");
      });
      expect(result.closed.has("acme/example#12")).toBe(false);
      expect(result.warnings).toEqual([]);
    });
  });

  // #1434 r2: cap the serial lookups — over COMMIT_REFS_CAP unique refs nothing
  // is read and the run goes red naming the count.
  describe("#1434 r2: commit-ref cap", () => {
    it("over the cap no lookup runs and the verdict names the count", async () => {
      const messages = Array.from({ length: COMMIT_REFS_CAP + 1 }, (_, i) => `fixes #${i}`);
      const result = await closedCommitRefs(messages, REPO, async () => {
        throw new Error("must not be called");
      });
      expect(result.overCap).toBe(COMMIT_REFS_CAP + 1);
      expect(result.closed.size).toBe(0);
      expect(mergePrecheckFailures({
        title: "plain title", body: "", patterns: [], blobs: [], private: true,
        repo: REPO, commitMessages: messages, closedRefs: result.closed, closedRefsOverCap: result.overCap,
      })).toEqual([`${COMMIT_REFS_CAP_FAILURE}${COMMIT_REFS_CAP + 1} refs`]);
    });

    it("at the cap every ref is looked up, none skipped", async () => {
      const messages = Array.from({ length: COMMIT_REFS_CAP }, (_, i) => `fixes #${i}`);
      const lookedUp: string[] = [];
      const result = await closedCommitRefs(messages, REPO, async (n, repo) => {
        lookedUp.push(`${repo}#${n}`);
        return "closed";
      });
      expect(result.overCap).toBeUndefined();
      expect(lookedUp).toHaveLength(COMMIT_REFS_CAP);
    });
  });

  // #1434 r2: the crude trigger must NOT read a non-keyword word as a closing
  // keyword, so these commit messages stay green and never hit the issues API.
  describe("#1434 r2: non-keyword words do not trip the commit scan", () => {
    const clean: [string, string][] = [
      ["prefix #5", "keyword prefix inside a longer word"],
      ["fixed-width #3", "keyword hyphenated, not followed by a ref"],
      ["closest #2", "keyword leading a longer word"],
      ["Refs other/repo#5", "Refs mention of a qualified ref"],
      ["Refs GH-7", "Refs mention of a GH- ref"],
    ];
    for (const [message, why] of clean) {
      it(`passes: ${why}`, async () => {
        const result = await closedCommitRefs([message], REPO, async () => {
          throw new Error("must not be called");
        });
        expect(result.closed.size).toBe(0);
        expect(result.warnings).toEqual([]);
        expect(mergePrecheckFailures({
          title: "plain title", body: "", patterns: [], blobs: [], private: true,
          repo: REPO, commitMessages: [message], closedRefs: result.closed,
        })).toEqual([]);
      });
    }
  });
});
