// #1169: the merge-precheck pure rules — closing-keyword refusal and the
// PR-content leak scan. All fixture terms neutral/fake (acmeclient): this file
// ships in a public repo, so a real client name or org would be a leak.
import { describe, expect, it } from "bun:test";
import {
  CLOSING_KEYWORD_RE, closingKeywordFailure, leakFailure, mergePrecheckFailures,
} from "../../src/gate/merge-precheck";

const CLOSING = "closing keyword in PR title or body";
const DENYLIST_UNAVAILABLE = "gate precheck: denylist unavailable";
const LEAK_SCAN_ERROR = "gate precheck: leak scan error";

describe("closingKeywordFailure", () => {
  it("flags a title that closes an issue", () => {
    expect(closingKeywordFailure("Fix #123", "")).toBe(CLOSING);
  });

  it("flags a body that closes an issue", () => {
    expect(closingKeywordFailure("", "this closes #9 for real")).toBe(CLOSING);
  });

  it("flags resolved/fixed forms too", () => {
    expect(closingKeywordFailure("resolved #42", "")).toBe(CLOSING);
    expect(closingKeywordFailure("fixed #7", "")).toBe(CLOSING);
  });

  it("is case-insensitive", () => {
    expect(closingKeywordFailure("FIXES #3", "")).toBe(CLOSING);
  });

  it("is clean when no closing keyword appears", () => {
    expect(closingKeywordFailure("Not a close keyword", "still no keyword")).toBeNull();
    expect(closingKeywordFailure("no number at all", "")).toBeNull();
  });

  it("requires a # followed by digits", () => {
    expect(closingKeywordFailure("fixes #abc", "")).toBeNull();
    expect(closingKeywordFailure("fixes 123", "")).toBeNull();
  });

  it("does not match a keyword inside a longer word", () => {
    // `fix` preceded by `f` — a letter, so the (^|[^a-z]) guard fails.
    expect(closingKeywordFailure("affix #1", "")).toBeNull();
    expect(closingKeywordFailure("suffixes #1", "")).toBeNull();
  });

  it("exposes the task's exact regex", () => {
    expect(CLOSING_KEYWORD_RE.source).toBe("(^|[^a-z])(close[sd]?|fix(es|ed)?|resolve[sd]?) #[0-9]");
    expect(CLOSING_KEYWORD_RE.flags).toBe("gim");
  });
});

describe("leakFailure", () => {
  it("flags a blob that matches a pattern, naming only the pattern index", () => {
    const msg = leakFailure(["acmeclient"], ["intro", "AcmeClient auth"]);
    expect(msg).toContain("#1");
    expect(msg).not.toMatch(/acmeclient/i);
  });

  it("is clean when no blob matches", () => {
    expect(leakFailure(["acmeclient"], ["nothing to see"])).toBeNull();
  });

  it("fails closed on an empty denylist", () => {
    expect(leakFailure([], ["AcmeClient"] as string[])).toBe(DENYLIST_UNAVAILABLE);
  });

  it("fails closed when a pattern cannot be scanned", () => {
    // `acme(` is not a valid regex: scanText throws, the scan refuses.
    expect(leakFailure(["acme("], ["AcmeClient"])).toBe(LEAK_SCAN_ERROR);
  });
});

describe("mergePrecheckFailures", () => {
  it("returns both failures when title has a closing keyword and blobs leak", () => {
    const failures = mergePrecheckFailures({
      title: "Fix #123",
      body: "",
      patterns: ["acmeclient"],
      blobs: ["AcmeClient auth"],
    });
    expect(failures).toEqual([CLOSING, expect.stringContaining("#1")]);
  });

  it("returns [] when all clean", () => {
    expect(mergePrecheckFailures({
      title: "plain title", body: "plain body", patterns: ["acmeclient"], blobs: ["clean"],
    })).toEqual([]);
  });
});