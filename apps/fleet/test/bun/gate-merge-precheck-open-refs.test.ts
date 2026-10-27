// #1430: a closing keyword in a commit message fails the precheck only while
// the ref it names is still OPEN. A promotion PR re-presents commits whose
// refs already closed; those close nothing at merge. Fail closed: a lookup
// error or a keyword with no readable ref stays red. Neutral fixtures only
// (acme/example): this file ships public.
import { describe, expect, it } from "bun:test";
import {
  closedCommitRefs, mergePrecheckFailures, CLOSING_KEYWORD_COMMIT_FAILURE,
} from "../../src/gate/merge-precheck";

const REPO = "acme/example";

/** The workflow's order: look refs up, then run the pure decision. */
async function commitVerdict(messages: string[], state: (n: number) => Promise<string>): Promise<string[]> {
  const closedRefs = await closedCommitRefs(messages, REPO, state);
  return mergePrecheckFailures({
    title: "plain title", body: "", patterns: [], blobs: [], private: true,
    repo: REPO, commitMessages: messages, closedRefs,
  });
}

const states = (m: Record<number, string>) => async (n: number) => {
  if (!(n in m)) throw new Error(`unexpected lookup #${n}`);
  return m[n];
};

describe("#1430: commit-message closing keyword fails only on an OPEN ref", () => {
  it("positive control: a commit closing an OPEN issue still fails", async () => {
    expect(await commitVerdict(["feat: thing\n\nFixes #12"], states({ 12: "open" })))
      .toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  it("a commit closing an already-CLOSED issue passes", async () => {
    expect(await commitVerdict(["Closes #12"], states({ 12: "closed" }))).toEqual([]);
  });

  it("a commit naming an already-MERGED PR passes (REST reports merged as closed)", async () => {
    expect(await commitVerdict(["fix #34"], states({ 34: "closed" }))).toEqual([]);
  });

  it("mixed open + closed refs fail", async () => {
    expect(await commitVerdict(["Closes #12", "Fixes #34 and resolves #56"], states({ 12: "closed", 34: "closed", 56: "open" })))
      .toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  it("a lookup that throws fails closed", async () => {
    const throwing = async () => { throw new Error("GitHub 502"); };
    expect(await commitVerdict(["Closes #12"], throwing)).toEqual([CLOSING_KEYWORD_COMMIT_FAILURE]);
  });

  it("positive control: the scan sees a planted keyword among clean commits", async () => {
    const lookedUp: number[] = [];
    const out = await commitVerdict(["plain one", "closes #99999", "plain two"], async (n) => {
      lookedUp.push(n);
      return "open";
    });
    expect(lookedUp).toEqual([99999]);
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
});
