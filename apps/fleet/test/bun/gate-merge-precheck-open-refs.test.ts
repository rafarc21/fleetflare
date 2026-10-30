// #1430: a closing keyword in a commit message fails the precheck only while
// the ref it names is still OPEN. A promotion PR re-presents commits whose
// refs already closed; those close nothing at merge. Fail closed: a lookup
// error or a keyword with no readable ref stays red. #1434: a qualified ref
// (`other/repo#5`, a URL) is looked up in its own repo, never the base repo.
// Neutral fixtures only (acme/example): this file ships public.
import { describe, expect, it } from "bun:test";
import {
  closedCommitRefs, mergePrecheckFailures, CLOSING_KEYWORD_COMMIT_FAILURE,
} from "../../src/gate/merge-precheck";

const REPO = "acme/example";

/** The workflow's order: look refs up, then run the pure decision. */
async function commitVerdict(
  messages: string[], state: (n: number, repo: string) => Promise<string>,
): Promise<string[]> {
  const closedRefs = await closedCommitRefs(messages, REPO, state);
  return mergePrecheckFailures({
    title: "plain title", body: "", patterns: [], blobs: [], private: true,
    repo: REPO, commitMessages: messages, closedRefs,
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

    it("a foreign qualified ref whose lookup throws fails closed", async () => {
      const throwing = async () => { throw new Error("GitHub 404"); };
      expect(await commitVerdict(["fixes other/repo#5"], throwing)).toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
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
});
