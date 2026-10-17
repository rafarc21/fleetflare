// #1176: drives the exact decision table workflow.ts's precheck step performs,
// end to end, against the pure functions — direct GateWorkflow execution is not
// harnessable here: cloudflare:workers' Workflows engine has no bun-test harness
// in this repo (the vitest pool imports workflow.ts but does not run the engine).
// The workflow wires precheckBlobs -> mergePrecheckFailures ->
// capStatusDescription for its precheck verdict, and recheckFailures for the
// success-path recheck, so this asserts the posted description each scenario
// would produce. Neutral fixtures only (acme/example): this file ships public.
import { describe, expect, it } from "bun:test";
import {
  capStatusDescription, mergePrecheckFailures, precheckBlobs, recheckFailures,
  CLOSING_KEYWORD_COMMIT_FAILURE, UNSCANNABLE_FILE_FAILURE,
} from "../../src/gate/merge-precheck";

const TITLE = "plain title";
const BODY = "";
const PATTERNS = ["acmeclient"];

/** The workflow's precheck step: build blobs, run the decision, cap the first
 *  failure into the description GitHub posts. */
function precheckDescription(input: Parameters<typeof mergePrecheckFailures>[0]): string | null {
  const failures = mergePrecheckFailures(input);
  return failures.length > 0 ? capStatusDescription(failures[0]) : null;
}

describe("gate precheck flow: the posted description per scenario", () => {
  it("a private repo with a leaky blob posts nothing (denylist skipped)", () => {
    const desc = precheckDescription({
      title: TITLE, body: BODY, patterns: [], blobs: ["AcmeClient auth"],
      private: true, files: [], commitMessages: [],
    });
    expect(desc).toBeNull();
  });

  it("a patchless binary file posts the unscannable-file failure", () => {
    const files = [{ filename: "bin/blob.png", status: "modified" }];
    const desc = precheckDescription({
      title: TITLE, body: BODY, patterns: PATTERNS,
      blobs: precheckBlobs({ title: TITLE, body: BODY, files, commits: [] }),
      files, commitMessages: [],
    });
    expect(desc).not.toBeNull();
    expect(desc!.startsWith(UNSCANNABLE_FILE_FAILURE)).toBe(true);
    // #1191: the failure names a count, never the filename.
    expect(desc).toContain("1 file(s)");
    expect(desc).not.toContain("bin/blob.png");
  });

  it("a commit message with a closing keyword posts the commit-keyword failure", () => {
    const files = [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n+plain" }];
    const commits = [{ author: "Acme Dev", committer: "Acme Bot", message: "Fix #9" }];
    const desc = precheckDescription({
      title: TITLE, body: BODY, patterns: PATTERNS,
      blobs: precheckBlobs({ title: TITLE, body: BODY, files, commits }),
      files, commitMessages: commits.map((c) => c.message),
    });
    expect(desc).toBe(CLOSING_KEYWORD_COMMIT_FAILURE);
  });

  it("a re-read title with a closing keyword posts the keyword failure via recheckFailures", () => {
    const failures = recheckFailures({ title: "Fixes #2", body: "", patterns: PATTERNS, private: false });
    expect(failures.length).toBeGreaterThan(0);
    expect(capStatusDescription(failures[0])).toBe("closing keyword in PR title or body");
  });

  it("an all-clean PR posts nothing", () => {
    const files = [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n+plain" }];
    const commits = [{ author: "Acme Dev", committer: "Acme Bot", message: "plain commit" }];
    const desc = precheckDescription({
      title: TITLE, body: BODY, patterns: PATTERNS,
      blobs: precheckBlobs({ title: TITLE, body: BODY, files, commits }),
      files, commitMessages: commits.map((c) => c.message),
    });
    expect(desc).toBeNull();
  });

  it("a long multi-file unscannable description is capped at 140 chars", () => {
    const files = Array.from({ length: 60 }, (_, i) => ({ filename: `bin/blob-${i}.png`, status: "modified" }));
    const desc = precheckDescription({
      title: TITLE, body: BODY, patterns: PATTERNS,
      blobs: precheckBlobs({ title: TITLE, body: BODY, files, commits: [] }),
      files, commitMessages: [],
    });
    expect(desc).not.toBeNull();
    expect(desc!.length).toBeLessThanOrEqual(140);
    expect(desc!.startsWith(UNSCANNABLE_FILE_FAILURE)).toBe(true);
  });
});