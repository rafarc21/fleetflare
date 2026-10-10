import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepoCheck } from "../../scripts/repo-check";

/**
 * Board issue #321 — characterization pins of both check CLIs
 * (scripts/english-check.ts, scripts/test-lies-check.ts): the exact stdout /
 * stderr bytes and exit codes each `import.meta.main` block produces today,
 * recorded BEFORE the shared runRepoCheck runner (Task 2) migrates those
 * mains, so any drift in stream, message, or exit code fails a test here
 * first. Same trick as test-lies-check.test.ts's own CLI block: both scripts
 * derive REPO_ROOT from import.meta.dir (three levels up from scripts/), so
 * a copy of the script at <tmp>/apps/fleet/scripts/<name>.ts scans <tmp>,
 * not the real repo — a synthetic throwaway repo, never a mutation of a
 * real tracked file.
 */

/** A throwaway git repo with the real script copied to apps/fleet/scripts/
 *  so its import.meta.dir-derived REPO_ROOT resolves here. `track` git-adds
 *  everything written (git ls-files reads the index; no commit needed). */
function scriptRepo(script: "english-check" | "test-lies-check"): {
  root: string;
  write: (rel: string, bytes: string | Uint8Array) => void;
  run: () => { out: string; err: string; code: number };
} {
  const root = mkdtempSync(join(tmpdir(), "repo-check-runner-"));
  const dir = join(root, "apps/fleet/scripts");
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `${script}.ts`);
  writeFileSync(copy, readFileSync(join(import.meta.dir, `../../scripts/${script}.ts`), "utf8"));
  // Both scripts import the shared runner from "./repo-check" — the copy must
  // carry it too, or the first used import fails to resolve in the throwaway.
  writeFileSync(join(dir, "repo-check.ts"), readFileSync(join(import.meta.dir, "../../scripts/repo-check.ts"), "utf8"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  return {
    root,
    write: (rel, bytes) => {
      mkdirSync(join(root, dirnameOf(rel)), { recursive: true });
      writeFileSync(join(root, rel), bytes);
      Bun.spawnSync(["git", "add", "-A"], { cwd: root });
    },
    run: () => {
      const p = Bun.spawnSync([process.execPath, copy], { cwd: root });
      return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
    },
  };
}

/** dirname("a/b") = "a"; dirname("f") = "." — mkdirSync of "." is a no-op. */
function dirnameOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "." : rel.slice(0, i);
}

describe("repo-check runner — characterization pins of both check CLIs (board issue #321)", () => {
  test("english-check: clean repo — stdout 'english-check: clean', empty stderr, exit 0", () => {
    const repo = scriptRepo("english-check");
    try {
      repo.write("file.ts", "export const x = 1;\n");
      const { out, err, code } = repo.run();
      expect(code).toBe(0);
      expect(out.trimEnd()).toBe("english-check: clean");
      expect(err).toBe("");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("english-check: marker line — finding and summary on stderr, empty stdout, exit 1", () => {
    const repo = scriptRepo("english-check");
    try {
      repo.write("file.ts", "line one\n// nao pode ficar\n");
      const { out, err, code } = repo.run();
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain('file.ts:2: "nao" — // nao pode ficar');
      expect(err).toContain("line(s) of Portuguese");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("english-check: line ending in the escape hatch passes clean", () => {
    const repo = scriptRepo("english-check");
    try {
      repo.write("file.ts", "Rua João, São Paulo // english-check: allow\n");
      const { out, code } = repo.run();
      expect(code).toBe(0);
      expect(out.trimEnd()).toBe("english-check: clean");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("english-check: binary file (NUL byte) is skipped, not flagged", () => {
    const repo = scriptRepo("english-check");
    try {
      repo.write("file.bin", Buffer.from("nao\0bin"));
      const { out, err, code } = repo.run();
      expect(code).toBe(0);
      expect(out.trimEnd()).toBe("english-check: clean");
      expect(err).toBe("");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("test-lies-check: clean repo — count line on stdout, empty stderr, exit 0", () => {
    const repo = scriptRepo("test-lies-check");
    try {
      repo.write("src/x.ts", "export const X = 1;\n");
      repo.write(
        "t/clean.test.ts",
        'import { X } from "../src/x";\nimport { test, expect } from "bun:test";\ntest("x", () => { expect(X).toBe(2); });\n',
      );
      const { out, err, code } = repo.run();
      expect(code).toBe(0);
      expect(out).toContain("0 tautological, 0 source-reading, 0 own-module-mock across 1 test files");
      expect(err).toBe("");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("test-lies-check: tautological test — finding and count on stdout, empty stderr, exit 1", () => {
    const repo = scriptRepo("test-lies-check");
    try {
      repo.write("src/bad.ts", "export const BAD_CONST = 42;\n");
      repo.write(
        "test/bad.test.ts",
        'import { BAD_CONST } from "../src/bad";\n\ntest(\'x\', () => {\n  expect(BAD_CONST).toBe(42);\n});\n',
      );
      const { out, err, code } = repo.run();
      expect(code).toBe(1);
      expect(out).toContain("[tautological] BAD_CONST mirrors");
      expect(out).toContain("1 tautological, 0 source-reading, 0 own-module-mock across 1 test files");
      expect(err).toBe("");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("test-lies-check: line ending in the escape hatch passes clean", () => {
    const repo = scriptRepo("test-lies-check");
    try {
      repo.write("src/bad.ts", "export const BAD_CONST = 42;\n");
      repo.write(
        "test/bad.test.ts",
        'import { BAD_CONST } from "../src/bad";\n\ntest(\'x\', () => {\n  expect(BAD_CONST).toBe(42); // test-lies-check: allow\n});\n',
      );
      const { out, code } = repo.run();
      expect(code).toBe(0);
      expect(out).toContain("0 tautological, 0 source-reading, 0 own-module-mock across 1 test files");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  // Task 3's runner gap: test-lies-check's count line prints on BOTH the clean
  // and the findings path, and needs the file count in both. That pins the
  // runner contract directly: `failSummary` receives the file count as its 2nd
  // argument (the same `fileCount(listed)` value `cleanLine` gets), so the
  // findings path never has to count `git ls-files` a second time.
  test("runRepoCheck: failSummary receives (findings, fileCount), cleanLine receives fileCount", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-check-runner-gap-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: root });
      writeFileSync(join(root, "a.test.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "b.test.ts"), "export const b = 2;\n");
      Bun.spawnSync(["git", "add", "-A"], { cwd: root });

      const saw: string[] = [];
      const failCode = await runRepoCheck({
        root,
        select: (p) => /\.test\.tsx?$/.test(p),
        scanFile: () => [{ line: 1, marker: "x" }],
        allowlist: {},
        format: () => "",
        stream: "stdout",
        failSummary: (findings, fileCount) => {
          saw.push(`fail:${findings.length}:${fileCount}`);
          return "";
        },
        cleanLine: (fileCount) => {
          saw.push(`clean:${fileCount}`);
          return "";
        },
        cleanExit: 0,
        fileCount: (listed) => listed.length,
      });
      expect(failCode).toBe(1);
      expect(saw).toEqual(["fail:2:2"]);

      const cleanCode = await runRepoCheck({
        root,
        select: (p) => /\.test\.tsx?$/.test(p),
        scanFile: () => [],
        allowlist: {},
        format: () => "",
        stream: "stdout",
        failSummary: () => "never",
        cleanLine: (fileCount) => {
          saw.push(`clean:${fileCount}`);
          return "";
        },
        cleanExit: 0,
        fileCount: (listed) => listed.length,
      });
      expect(cleanCode).toBe(0);
      expect(saw).toEqual(["fail:2:2", "clean:2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
