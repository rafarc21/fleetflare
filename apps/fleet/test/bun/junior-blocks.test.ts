import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseBlocks, applyBlocks, toUnifiedDiff } from "../../../../skills/junior/src/blocks";

const B = (path: string, s: string, r: string) =>
  `${path}\n<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;
const none = () => false;

describe("parseBlocks", () => {
  test("parses one block", () => {
    expect(parseBlocks(B("src/a.ts", "const a = 1;", "const a = 2;")))
      .toEqual([{ path: "src/a.ts", search: "const a = 1;", replace: "const a = 2;" }]);
  });

  test("parses fenced blocks with decorated path lines", () => {
    const text = "Here you go:\n```ts\nFile: `src/a.ts`\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```\n" +
      "**src/b.ts**\n<<<<<<< SEARCH\np\n=======\nq\n>>>>>>> REPLACE\n";
    expect(parseBlocks(text)).toEqual([
      { path: "src/a.ts", search: "x", replace: "y" },
      { path: "src/b.ts", search: "p", replace: "q" },
    ]);
  });

  test("empty SEARCH parses as empty string", () => {
    expect(parseBlocks("new.ts\n<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE")[0].search).toBe("");
  });

  test("no blocks -> empty list", () => {
    expect(parseBlocks("I could not do this.")).toEqual([]);
  });
});

describe("applyBlocks", () => {
  const before = () => new Map([["src/a.ts", "const a = 1;\nconst b = 1;\n"]]);

  test("applies a unique match", () => {
    const r = applyBlocks(before(), parseBlocks(B("src/a.ts", "const a = 1;", "const a = 2;")), none);
    expect(r).toEqual({ ok: true, after: new Map([["src/a.ts", "const a = 2;\nconst b = 1;\n"]]) });
  });

  test("zero matches -> error naming block, file and count", () => {
    const r = applyBlocks(before(), parseBlocks(B("src/a.ts", "nope", "x")), none);
    expect(r).toEqual({ ok: false, error: "block 1 (src/a.ts): SEARCH matched 0 times, must match exactly once" });
  });

  test("two matches -> error", () => {
    const r = applyBlocks(new Map([["a", "x\nx\n"]]), parseBlocks(B("a", "x", "y")), none);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("matched 2 times");
  });

  test("overlapping matches count as 2, not 1", () => {
    // "  " (two spaces) occurs at both index 1-2 and index 2-3 inside "a   b"
    // (three spaces) -- these overlap, but both are real occurrences, so the
    // SEARCH is ambiguous and must be rejected, not silently applied once.
    const r = applyBlocks(new Map([["a", "a   b"]]), parseBlocks(B("a", "  ", "X")), none);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("matched 2 times");
  });

  test("path not given as input -> error", () => {
    const r = applyBlocks(before(), parseBlocks(B("src/other.ts", "x", "y")), none);
    expect(r).toEqual({ ok: false, error: "block 1 names src/other.ts, which was not given as input" });
  });

  test("no blocks -> error", () => {
    expect(applyBlocks(before(), [], none)).toEqual({ ok: false, error: "no edit blocks found in output" });
  });

  test("empty SEARCH creates a new file", () => {
    const r = applyBlocks(before(), parseBlocks("test/a.test.ts\n<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE"), none);
    expect(r.ok && r.after.get("test/a.test.ts")).toBe("export {};\n");
  });

  test("empty SEARCH on existing file -> error", () => {
    const r = applyBlocks(before(), parseBlocks("x.ts\n<<<<<<< SEARCH\n=======\ny\n>>>>>>> REPLACE"), () => true);
    expect(r).toEqual({ ok: false, error: "block 1 (x.ts): empty SEARCH creates a file, but x.ts already exists" });
  });

  test("empty SEARCH on a path already in the before map -> error", () => {
    // Exercises the before.has(...) disjunct specifically: the path is given
    // as input context, not existsOnDisk, and not created earlier in the batch.
    const r = applyBlocks(before(), parseBlocks("src/a.ts\n<<<<<<< SEARCH\n=======\ny\n>>>>>>> REPLACE"), none);
    expect(r).toEqual({ ok: false, error: "block 1 (src/a.ts): empty SEARCH creates a file, but src/a.ts already exists" });
  });

  test("empty SEARCH on a path created earlier in the same batch -> error", () => {
    // Exercises the after.has(...) disjunct specifically: the path is not in
    // before and not existsOnDisk, but a prior block in this same batch already
    // created it via its own empty-SEARCH new-file case.
    const text = "new.ts\n<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE\n" +
      "new.ts\n<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE";
    const r = applyBlocks(before(), parseBlocks(text), none);
    expect(r).toEqual({ ok: false, error: "block 2 (new.ts): empty SEARCH creates a file, but new.ts already exists" });
  });

  test("blank path line before SEARCH marker -> clear error, not a crash", () => {
    // A blank line directly above "<<<<<<< SEARCH" (e.g. two blocks chained
    // with no repeated path header) makes the path-capturing regex match an
    // empty string via ^ + /m. Must surface as a clear parse-level error, not
    // "block N names , which was not given as input".
    const text = "src/a.ts\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n\n" +
      "<<<<<<< SEARCH\nconst b = 1;\n=======\nconst b = 2;\n>>>>>>> REPLACE";
    const r = applyBlocks(before(), parseBlocks(text), none);
    expect(r).toEqual({ ok: false, error: "block 2: missing file path" });
  });

  test("blank path line with empty SEARCH -> clear error, not an EISDIR crash", () => {
    // Same blank-path bug, but hitting the empty-SEARCH (new file) branch,
    // which previously inserted a "" key that crashed toUnifiedDiff with
    // EISDIR when join(root, "b", "") resolved to a directory.
    const text = "src/a.ts\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n\n" +
      "<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE";
    const r = applyBlocks(before(), parseBlocks(text), none);
    expect(r).toEqual({ ok: false, error: "block 2: missing file path" });
  });

  test("rejects paths outside the repo", () => {
    for (const p of ["/etc/passwd", "../x.ts", "a/../../x.ts"]) {
      const r = applyBlocks(before(), parseBlocks(`${p}\n<<<<<<< SEARCH\n=======\ny\n>>>>>>> REPLACE`), none);
      expect(r).toEqual({ ok: false, error: `block 1: path ${p} is outside the repository` });
    }
  });

  test("replacement with dollar patterns is literal", () => {
    const r = applyBlocks(new Map([["a", "x\n"]]), parseBlocks(B("a", "x", "y = '$&$1$$'")), none);
    expect(r.ok && r.after.get("a")).toBe("y = '$&$1$$'\n");
  });

  test("CRLF file matches LF search", () => {
    const r = applyBlocks(new Map([["a", "one\r\ntwo\r\n"]]), parseBlocks(B("a", "one\ntwo", "uno\ndos")), none);
    expect(r.ok && r.after.get("a")).toBe("uno\r\ndos\r\n");
  });

  test("blocks apply in order on the updated text", () => {
    const text = B("a", "x", "y") + "\n" + B("a", "y", "z");
    const r = applyBlocks(new Map([["a", "x\n"]]), parseBlocks(text), none);
    expect(r.ok && r.after.get("a")).toBe("z\n");
  });
});

describe("toUnifiedDiff", () => {
  test("output applies cleanly with git apply --check, including a new file", () => {
    const repo = mkdtempSync(join(tmpdir(), "junior-blocks-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), "const a = 1;\n");
    const before = new Map([["src/a.ts", "const a = 1;\n"]]);
    const after = new Map([["src/a.ts", "const a = 2;\n"], ["src/new.ts", "export {};\n"]]);
    const diff = toUnifiedDiff(before, after);
    expect(diff).toContain("--- a/src/a.ts");
    expect(diff).toContain("+++ b/src/new.ts");
    writeFileSync(join(repo, "p.patch"), diff);
    const check = spawnSync("git", ["apply", "--check", "p.patch"], { cwd: repo, encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  test("no change -> empty string", () => {
    const m = new Map([["a", "x\n"]]);
    expect(toUnifiedDiff(m, new Map(m))).toBe("");
  });
});
