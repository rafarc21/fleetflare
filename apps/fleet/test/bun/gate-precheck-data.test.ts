// #1169: precheckSummary's pure mapping — diff patches, rename old names, and
// commit identities. No network: the function is pure over a raw compare
// response, so fakes prove every branch.
import { describe, expect, it } from "bun:test";
import { precheckSummary } from "../../src/github/api";

describe("precheckSummary", () => {
  it("maps a file with a patch", () => {
    const out = precheckSummary({
      files: [{ filename: "a.ts", patch: "@@ -1 +1 @@" }],
    });
    expect(out.files).toEqual([{ filename: "a.ts", patch: "@@ -1 +1 @@" }]);
    expect(out.commits).toEqual([]);
  });

  it("omits patch and previous_filename when absent", () => {
    const out = precheckSummary({ files: [{ filename: "b.ts" }] });
    expect(out.files).toEqual([{ filename: "b.ts" }]);
    expect("patch" in out.files[0]).toBe(false);
    expect("previous_filename" in out.files[0]).toBe(false);
  });

  it("keeps a rename's previous_filename", () => {
    const out = precheckSummary({
      files: [{ filename: "new.ts", previous_filename: "old.ts", patch: "diff" }],
    });
    expect(out.files).toEqual([
      { filename: "new.ts", previous_filename: "old.ts", patch: "diff" },
    ]);
  });

  it("maps author and committer identities", () => {
    const out = precheckSummary({
      commits: [{
        commit: {
          author: { name: "Acme Dev", email: "dev@example.com" },
          committer: { name: "GitHub", email: "noreply@github.com" },
        },
      }],
    });
    expect(out.commits).toEqual([
      { author: "Acme Dev dev@example.com", committer: "GitHub noreply@github.com" },
    ]);
  });

  it("reads a null author as empty string", () => {
    const out = precheckSummary({
      commits: [{
        commit: {
          author: null,
          committer: { name: "GitHub", email: "noreply@github.com" },
        },
      }],
    });
    expect(out.commits).toEqual([
      { author: "", committer: "GitHub noreply@github.com" },
    ]);
  });

  it("reads missing files and commits arrays as empty", () => {
    const out = precheckSummary({});
    expect(out.files).toEqual([]);
    expect(out.commits).toEqual([]);
  });

  it("drops empty name or email when joining an identity", () => {
    const out = precheckSummary({
      commits: [{
        commit: {
          author: { name: "Acme Dev" },
          committer: { email: "noreply@github.com" },
        },
      }],
    });
    expect(out.commits).toEqual([
      { author: "Acme Dev", committer: "noreply@github.com" },
    ]);
  });
});