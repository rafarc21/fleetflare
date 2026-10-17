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
          message: "plain commit",
        },
      }],
    });
    expect(out.commits).toEqual([
      { author: "Acme Dev dev@example.com", committer: "GitHub noreply@github.com", message: "plain commit" },
    ]);
  });

  it("maps the commit message", () => {
    const out = precheckSummary({
      commits: [{
        commit: {
          author: { name: "Acme Dev", email: "dev@example.com" },
          committer: { name: "GitHub", email: "noreply@github.com" },
          message: "Fix #5 in the commit",
        },
      }],
    });
    expect(out.commits[0].message).toBe("Fix #5 in the commit");
  });

  it("reads a missing commit message as empty string", () => {
    const out = precheckSummary({
      commits: [{
        commit: {
          author: { name: "Acme Dev", email: "dev@example.com" },
          committer: { name: "GitHub", email: "noreply@github.com" },
        },
      }],
    });
    expect(out.commits[0].message).toBe("");
  });

  it("reads a null author as empty string", () => {
    const out = precheckSummary({
      commits: [{
        commit: {
          author: null,
          committer: { name: "GitHub", email: "noreply@github.com" },
          message: "plain",
        },
      }],
    });
    expect(out.commits).toEqual([
      { author: "", committer: "GitHub noreply@github.com", message: "plain" },
    ]);
  });

  it("reads missing files and commits arrays as empty", () => {
    const out = precheckSummary({});
    expect(out.files).toEqual([]);
    expect(out.commits).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it("sets truncated when the file list hits GitHub's 300-file cap", () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` }));
    const out = precheckSummary({ files });
    expect(out.truncated).toBe(true);
  });

  it("sets truncated when the commit list hits GitHub's 250-commit cap", () => {
    const commits = Array.from({ length: 250 }, (_, i) => ({
      commit: {
        author: { name: `Acme Author ${i}`, email: `author${i}@example.com` },
        committer: { name: `Acme Committer ${i}`, email: `committer${i}@example.com` },
      },
    }));
    const out = precheckSummary({ commits });
    expect(out.truncated).toBe(true);
  });

  it("is not truncated when both lists are below their caps", () => {
    const files = Array.from({ length: 299 }, (_, i) => ({ filename: `f${i}.ts` }));
    const commits = Array.from({ length: 249 }, (_, i) => ({
      commit: {
        author: { name: `Acme Author ${i}`, email: `author${i}@example.com` },
        committer: { name: `Acme Committer ${i}`, email: `committer${i}@example.com` },
      },
    }));
    const out = precheckSummary({ files, commits });
    expect(out.truncated).toBe(false);
  });

  it("drops empty name or email when joining an identity", () => {
    const out = precheckSummary({
      commits: [{
        commit: {
          author: { name: "Acme Dev" },
          committer: { email: "noreply@github.com" },
          message: "plain",
        },
      }],
    });
    expect(out.commits).toEqual([
      { author: "Acme Dev", committer: "noreply@github.com", message: "plain" },
    ]);
  });
});