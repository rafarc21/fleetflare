// #1169: the merge-precheck pure rules — closing-keyword refusal and the
// PR-content leak scan. All fixture terms neutral/fake (acmeclient): this file
// ships in a public repo, so a real client name or org would be a leak.
import { describe, expect, it } from "bun:test";
import {
  CLOSING_KEYWORD_RE, closingKeywordFailure, leakFailure, mergePrecheckFailures,
  COMPARE_TRUNCATED_FAILURE, truncationFailure, addedLines, unscannableFiles, precheckBlobs, recheckFailures,
  capStatusDescription, UNSCANNABLE_FILE_FAILURE,
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

describe("truncationFailure", () => {
  it("returns the failure string when the compare was truncated", () => {
    expect(truncationFailure(true)).toBe(COMPARE_TRUNCATED_FAILURE);
  });

  it("returns null when the compare was complete", () => {
    expect(truncationFailure(false)).toBeNull();
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

// #1176: a confirmed-private repo skips the leak scan (board/leak.ts's rule)
// and the truncation refusal (leaks cannot leave a private repo) — the
// closing-keyword check still runs.
describe("mergePrecheckFailures: a private repo skips the leak scan", () => {
  it("private:true with leaky blobs returns no leak failure and no truncation failure", () => {
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: ["AcmeClient auth"],
      private: true,
      truncated: true,
    });
    expect(failures).toEqual([]);
  });

  it("private:true with a closing keyword title still returns the keyword failure", () => {
    const failures = mergePrecheckFailures({
      title: "Fix #123",
      body: "",
      patterns: [],
      blobs: [],
      private: true,
    });
    expect(failures).toEqual([CLOSING]);
  });

  it("private:true with empty patterns returns [], not DENYLIST_UNAVAILABLE", () => {
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: [],
      blobs: ["anything"],
      private: true,
    });
    expect(failures).toEqual([]);
  });

  it("private:false/absent keeps the current behavior (leak + truncation)", () => {
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: ["AcmeClient auth"],
      private: false,
      truncated: true,
    });
    expect(failures).toEqual([COMPARE_TRUNCATED_FAILURE, expect.stringContaining("#1")]);
  });
});

// #1176: commit messages are scanned for both a closing keyword (a squash body
// builds from them, so a keyword there closes issues at merge) and leaks.
describe("mergePrecheckFailures: commit messages are scanned", () => {
  it("flags a closing keyword in a commit message", () => {
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: [],
      commitMessages: ["Fix #5"],
    });
    expect(failures).toEqual(["closing keyword in a commit message"]);
  });

  it("scans commit messages for leaks too", () => {
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: [],
      commitMessages: ["AcmeClient note"],
    });
    expect(failures).toEqual([expect.stringContaining("#1")]);
  });

  it("is clean for a plain commit message", () => {
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: [],
      commitMessages: ["plain"],
    });
    expect(failures).toEqual([]);
  });

  it("a private repo still flags a closing keyword in a commit message", () => {
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: [],
      blobs: [],
      commitMessages: ["Fix #5"],
      private: true,
    });
    expect(failures).toEqual(["closing keyword in a commit message"]);
  });
});

// #1176: the leak scan sees only ADDED lines, and a file with no patch (binary
// or oversized) fails closed — never a silent pass.
describe("addedLines", () => {
  // GitHub patches carry no +++/--- file headers (see #1191), so the hunk
  // header (@@) is excluded only because it does not start with `+`, and an
  // added line's leading `+` is the only thing stripped.
  it("extracts added lines only, stripping the leading +", () => {
    expect(addedLines("@@ -1,2 +1,2 @@\n context\n+added line\n-removed line\n+keep me")).toBe(
      "added line\nkeep me",
    );
  });

  it("returns empty for a patch with no additions", () => {
    expect(addedLines("@@ -1 +1 @@\n-removed only\n context")).toBe("");
  });

  // #1191: GitHub patches carry no +++/--- file headers, so the `!+++` guard
  // wrongly drops an added line whose CONTENT starts with `++` (its patch line
  // reads `+++...`). Only the one leading `+` is ever stripped.
  it("keeps a line whose content starts with + (only the leading + is stripped)", () => {
    expect(addedLines("+a\n++b\n-c\nctx\n")).toBe("a\n+b");
    expect(addedLines("+++lead\n")).toBe("++lead");
  });
});

describe("unscannableFiles", () => {
  it("flags a patchless, non-removed file", () => {
    expect(unscannableFiles([{ filename: "bin/blob.png", status: "modified" }])).toEqual(["bin/blob.png"]);
  });

  it("flags a patchless file with no status at all (GitHub omitted it)", () => {
    expect(unscannableFiles([{ filename: "bin/blob.png" }])).toEqual(["bin/blob.png"]);
  });

  it("does not flag a removed file with no patch", () => {
    expect(unscannableFiles([{ filename: "old.ts", status: "removed" }])).toEqual([]);
  });

  it("does not flag a file that has a patch", () => {
    expect(unscannableFiles([{ filename: "a.ts", patch: "diff", status: "modified" }])).toEqual([]);
  });
});

describe("mergePrecheckFailures: patchless files fail closed, added lines only", () => {
  it("a PR that only removes a leak goes green: removed lines are never scanned", () => {
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: precheckBlobs({
        title: "plain title", body: "",
        files: [{ filename: "notes.md", status: "modified", patch: "@@ -1 +1 @@\n-leaked acmeclient\n+clean" }],
        commits: [],
      }),
      files: [{ filename: "notes.md", status: "modified", patch: "@@ -1 +1 @@\n-leaked acmeclient\n+clean" }],
    });
    expect(failures).toEqual([]);
  });

  it("an added line that leaks is caught", () => {
    const files = [{ filename: "notes.md", status: "modified", patch: "@@ -1 +1 @@\n+added AcmeClient here" }];
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: precheckBlobs({ title: "plain title", body: "", files, commits: [] }),
      files,
    });
    expect(failures).toEqual([expect.stringContaining("#1")]);
  });

  it("a patchless binary file fails closed, naming a count, never the filename", () => {
    const files = [{ filename: "bin/blob.png", status: "modified" }];
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: precheckBlobs({ title: "plain title", body: "", files, commits: [] }),
      files,
    });
    expect(failures).toEqual([expect.stringContaining("no diff to scan")]);
    expect(failures[0]).toContain("1 file(s)");
    expect(failures[0]).not.toContain("bin/blob.png");
  });

  it("three patchless files fail closed with a count, none of the filenames", () => {
    const files = [
      { filename: "bin/one.png", status: "modified" },
      { filename: "bin/two.png", status: "modified" },
      { filename: "bin/three.png", status: "modified" },
    ];
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: precheckBlobs({ title: "plain title", body: "", files, commits: [] }),
      files,
    });
    expect(failures[0]).toContain("3 file(s)");
    expect(failures[0]).not.toContain("one.png");
    expect(failures[0]).not.toContain("two.png");
    expect(failures[0]).not.toContain("three.png");
  });

  it("a filename itself still scans whole: a path can carry a client name", () => {
    const files = [{ filename: "notes/acmeclient-notes.md", status: "modified", patch: "@@ -1 +1 @@\n+plain" }];
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: precheckBlobs({ title: "plain title", body: "", files, commits: [] }),
      files,
    });
    expect(failures).toEqual([expect.stringContaining("#1")]);
  });

  it("a rename's previous_filename is scanned whole too", () => {
    const files = [{ filename: "new.md", previous_filename: "old-acmeclient.md", patch: "@@ -1 +1 @@\n+plain" }];
    const failures = mergePrecheckFailures({
      title: "plain title",
      body: "",
      patterns: ["acmeclient"],
      blobs: precheckBlobs({ title: "plain title", body: "", files, commits: [] }),
      files,
    });
    expect(failures).toEqual([expect.stringContaining("#1")]);
  });
});

// #1176: the success-path recheck — same rules, title/body re-read, diff not
// refetched.
describe("recheckFailures", () => {
  it("flags a closing keyword on the re-read title", () => {
    expect(recheckFailures({ title: "Fixes #2", body: "", patterns: ["acmeclient"], private: false })).toEqual([CLOSING]);
  });

  it("flags a leak on the re-read body, naming only the pattern index", () => {
    const failures = recheckFailures({ title: "plain", body: "AcmeClient note", patterns: ["acmeclient"], private: false });
    expect(failures).toEqual([expect.stringContaining("#1")]);
  });

  it("private:true runs the keyword check only, no leak scan", () => {
    expect(recheckFailures({ title: "plain", body: "AcmeClient note", patterns: [], private: true })).toEqual([]);
    expect(recheckFailures({ title: "Fix #2", body: "", patterns: [], private: true })).toEqual([CLOSING]);
  });

  it("fails closed on empty patterns", () => {
    expect(recheckFailures({ title: "plain", body: "plain", patterns: [], private: false })).toEqual([DENYLIST_UNAVAILABLE]);
  });

  it("is clean for a plain re-read", () => {
    expect(recheckFailures({ title: "plain", body: "plain", patterns: ["acmeclient"], private: false })).toEqual([]);
  });
});

// #1176: GitHub 422s a status description over 140 chars.
describe("capStatusDescription", () => {
  it("caps a long description at 140 chars, starting with the failure prefix", () => {
    const long = UNSCANNABLE_FILE_FAILURE + Array.from({ length: 60 }, (_, i) => `file${i}.png`).join(", ");
    const capped = capStatusDescription(long);
    expect(capped.length).toBeLessThanOrEqual(140);
    expect(capped.startsWith("gate precheck: no diff to scan: file0.png")).toBe(true);
  });

  it("leaves a short description unchanged", () => {
    expect(capStatusDescription("closing keyword in PR title or body")).toBe("closing keyword in PR title or body");
  });

  it("trims trailing whitespace after the cut", () => {
    expect(capStatusDescription("short description   ")).toBe("short description");
  });
});