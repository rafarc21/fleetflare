import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWLIST, findOwnModuleMocks, findSourceReading, findTautologies, formatFinding,
  REPO_ROOT, scanFile, scanRepo,
} from "../../scripts/test-lies-check";

/**
 * Board issue #164, Phase 1 — a report-only scan for three shapes of "test
 * lie" (a test that passes but structurally cannot catch a real bug):
 * tautological assertions, source-reading, and own-module mocks.
 *
 * Every detector here is conservative by design: any resolution failure or
 * ambiguity is a silent skip, never a flag — a noisy check gets disabled,
 * which is worse than no check (same philosophy as english-check, #66).
 * Every negative case below is a real false positive the heuristic must not
 * produce.
 */

/** A throwaway directory standing in for a slice of the repo, so the
 *  tautology/own-module-mock detectors can resolve real relative imports
 *  against real files on disk, the same way they would against the repo. */
class Fixture {
  readonly dir = mkdtempSync(join(tmpdir(), "test-lies-check-"));
  readonly testDir = join(this.dir, "test");

  constructor() {
    mkdirSync(this.testDir, { recursive: true });
    mkdirSync(join(this.dir, "src"), { recursive: true });
  }

  writeModule(relPath: string, text: string): void {
    const full = join(this.dir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

describe("findTautologies — expect(IMPORTED_CONST).toBe(<its own value>)", () => {
  test("flags the real repeated shape: a constant restating its own declared value", () => {
    const fx = new Fixture();
    try {
      fx.writeModule("src/sweep.ts", "export const SWEEP_SECONDS = 20 * 60;\n");
      const testText = [
        'import { SWEEP_SECONDS } from "../src/sweep";',
        "",
        "test('x', () => {",
        "  expect(SWEEP_SECONDS).toBe(20 * 60);",
        "});",
        "",
      ].join("\n");
      const hits = findTautologies(testText, fx.testDir);
      expect(hits).toHaveLength(1);
      expect(hits[0].kind).toBe("tautological");
      expect(hits[0].line).toBe(4);
    } finally {
      fx.cleanup();
    }
  });

  test("flags a simple numeric-literal match (the PASTE_MAX_BYTES shape)", () => {
    const fx = new Fixture();
    try {
      fx.writeModule("src/paste.ts", "export const PASTE_MAX_BYTES = 10_485_760;\n");
      const testText = [
        'import { PASTE_MAX_BYTES } from "../src/paste";',
        "expect(PASTE_MAX_BYTES).toBe(10_485_760);",
      ].join("\n");
      const hits = findTautologies(testText, fx.testDir);
      expect(hits).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("does NOT flag when the literal does not match the declared value (a real assertion)", () => {
    const fx = new Fixture();
    try {
      fx.writeModule("src/sweep.ts", "export const SWEEP_SECONDS = 20 * 60;\n");
      const testText = [
        'import { SWEEP_SECONDS } from "../src/sweep";',
        "expect(SWEEP_SECONDS).toBe(999);",
      ].join("\n");
      expect(findTautologies(testText, fx.testDir)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  // Mirrors the real test/cli.recycle-outcome.test.ts:320-322 shape — the
  // motivating case for the paren-depth-balanced, multi-line argument
  // extraction in the first place: a real `.toBe(...)` argument that spans
  // several lines and contains its own parens/operators. It is NOT
  // tautological: the declared RHS (`DESTROY_CLIENT_TIMEOUT_MS + 600_000 +
  // 60_000` in the real module) textually differs from the asserted RHS
  // (`DESTROY_CLIENT_TIMEOUT_MS + EXEC_CLASSES.provision.timeoutMs + ...`),
  // even though both may be numerically equal at runtime — this detector
  // compares text, not values, so a real cross-check like this must not be
  // flagged as a restated-constant tautology.
  test("does NOT flag a real multi-line assertion whose RHS differs textually from the declared one", () => {
    const fx = new Fixture();
    try {
      fx.writeModule(
        "src/recycle-outcome.ts",
        "export const DESTROY_CLIENT_TIMEOUT_MS = 120_000;\n" +
        "export const RECYCLE_CLIENT_TIMEOUT_MS = DESTROY_CLIENT_TIMEOUT_MS + 600_000 + 60_000;\n",
      );
      const testText = [
        'import { RECYCLE_CLIENT_TIMEOUT_MS, DESTROY_CLIENT_TIMEOUT_MS } from "../src/recycle-outcome";',
        "",
        "it('covers destroy budget plus provision plus readiness', () => {",
        "  expect(RECYCLE_CLIENT_TIMEOUT_MS).toBe(",
        "    DESTROY_CLIENT_TIMEOUT_MS + EXEC_CLASSES.provision.timeoutMs + EXEC_CLASSES.readiness.timeoutMs,",
        "  );",
        "});",
      ].join("\n");
      expect(findTautologies(testText, fx.testDir)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("does NOT flag when the identifier is a local variable, not an import", () => {
    const fx = new Fixture();
    try {
      const testText = [
        "const SWEEP_SECONDS = 20 * 60;",
        "expect(SWEEP_SECONDS).toBe(20 * 60);",
      ].join("\n");
      expect(findTautologies(testText, fx.testDir)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("does NOT flag when the import cannot be resolved (conservative skip)", () => {
    const fx = new Fixture();
    try {
      const testText = [
        'import { SWEEP_SECONDS } from "../src/does-not-exist";',
        "expect(SWEEP_SECONDS).toBe(20 * 60);",
      ].join("\n");
      expect(findTautologies(testText, fx.testDir)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("a trailing `test-lies-check: allow` exempts that one flagged line only", () => {
    const fx = new Fixture();
    try {
      fx.writeModule("src/sweep.ts", "export const SWEEP_SECONDS = 20 * 60;\n");
      fx.writeModule(
        "test/x.test.ts",
        [
          'import { SWEEP_SECONDS } from "../src/sweep";',
          "expect(SWEEP_SECONDS).toBe(20 * 60); // test-lies-check: allow",
        ].join("\n"),
      );
      const text = readFileSync(join(fx.testDir, "x.test.ts"), "utf8");
      expect(scanFile("test/x.test.ts", text, fx.dir)).toEqual([]);

      fx.writeModule(
        "test/y.test.ts",
        [
          'import { SWEEP_SECONDS } from "../src/sweep";',
          "expect(SWEEP_SECONDS).toBe(20 * 60);",
        ].join("\n"),
      );
      const text2 = readFileSync(join(fx.testDir, "y.test.ts"), "utf8");
      expect(scanFile("test/y.test.ts", text2, fx.dir)).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("expect(foo.bar).toBe(...) — a member expression — is never flagged", () => {
    const fx = new Fixture();
    try {
      fx.writeModule("src/sweep.ts", "export const bar = 20 * 60;\n");
      const testText = [
        'import { bar } from "../src/sweep";',
        "const foo = { bar };",
        "expect(foo.bar).toBe(20 * 60);",
      ].join("\n");
      expect(findTautologies(testText, fx.testDir)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});

describe("findSourceReading — reading src/ as text and string-matching it", () => {
  test("flags the inline case: expect(readFileSync(...).toString()).toContain(...)", () => {
    const text = 'expect(readFileSync("src/foo.ts").toString()).toContain("export const FOO");';
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("source-reading");
    expect(hits[0].line).toBe(1);
  });

  test("flags the captured-variable case", () => {
    const text = [
      'const txt = readFileSync("src/foo.ts", "utf8");',
      "doSomethingUnrelated();",
      'expect(txt).toMatch(/FOO/);',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  test("does NOT flag a src/ file read that is never string-matched", () => {
    const text = [
      'const code = readFileSync("src/foo.ts", "utf8");',
      "const parsed = parseSomething(code);",
      "expect(parsed.ok).toBe(true);",
    ].join("\n");
    expect(findSourceReading(text)).toEqual([]);
  });

  test("does NOT flag a file read whose path has no src/ segment", () => {
    const text = 'expect(readFileSync("test/fixtures/sample.txt").toString()).toContain("hi");';
    expect(findSourceReading(text)).toEqual([]);
  });

  // This repo's own actual idiom (wake-gate-wiring.test.ts,
  // archive-wiring.test.ts): the first argument is not a bare string
  // literal, it's `join(import.meta.dir, "../../src/...")`. The detector
  // must look inside that wrapper call for the literal, not only accept a
  // bare literal as the first argument.
  test('flags the real join(import.meta.dir, "...") idiom, captured-variable case', () => {
    const text = [
      'const src = readFileSync(join(import.meta.dir, "../../src/studio/do.ts"), "utf8");',
      "doSomethingUnrelated();",
      'expect(src).toContain("switchedBlock:");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("../../src/studio/do.ts");
  });

  test('flags the join(import.meta.dir, "...") idiom, inline case too', () => {
    const text = 'expect(readFileSync(join(import.meta.dir, "../../src/studio/do.ts"), "utf8")).toContain("switchedBlock:");';
    expect(findSourceReading(text)).toHaveLength(1);
  });

  test('does NOT flag join(import.meta.dir, "...") when the joined literal has no src/ segment', () => {
    const text = [
      'const fixture = readFileSync(join(import.meta.dir, "fixtures/sample.txt"), "utf8");',
      'expect(fixture).toContain("hi");',
    ].join("\n");
    expect(findSourceReading(text)).toEqual([]);
  });

  test("a trailing `test-lies-check: allow` exempts that one flagged line only (via scanFile)", () => {
    const fx = new Fixture();
    try {
      fx.writeModule(
        "test/x.test.ts",
        'expect(readFileSync("src/foo.ts").toString()).toContain("x"); // test-lies-check: allow\n',
      );
      const text = readFileSync(join(fx.testDir, "x.test.ts"), "utf8");
      expect(scanFile("test/x.test.ts", text, fx.dir)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  // Board issue #174 part 2 — follow simple derivation chains, not just the
  // directly captured variable. Mirrors the real archive-wiring.test.ts
  // shape: src -> method (one hop: .indexOf/.slice) -> call (a second hop,
  // chained off the FIRST derived variable, not off src directly).
  test("flags a two-hop derivation chain: read -> derive once -> derive again -> assert", () => {
    const text = [
      'const src = readFileSync(join(import.meta.dir, "../../src/studio/do.ts"), "utf8");',
      'const methodStart = src.indexOf("shipTranscript");',
      'const method = src.slice(methodStart, methodStart + 200);',
      'const callStart = method.indexOf("runShipTickWithObservation(");',
      'const call = method.slice(callStart, callStart + 80);',
      'expect(call).toContain("doneRecords:");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("../../src/studio/do.ts");
  });

  test("does NOT flag a derivation chain that never reaches an assertion", () => {
    const text = [
      'const src = readFileSync(join(import.meta.dir, "../../src/studio/do.ts"), "utf8");',
      'const methodStart = src.indexOf("shipTranscript");',
      'const method = src.slice(methodStart, methodStart + 200);',
      'expect(methodStart).toBeGreaterThan(-1);',
    ].join("\n");
    expect(findSourceReading(text)).toEqual([]);
  });

  test("does NOT flag .split()/.slice() on a variable that was never tainted by a src/ read", () => {
    const text = [
      'const src = readFileSync(join(import.meta.dir, "../../src/studio/do.ts"), "utf8");',
      'const unrelated = "hello world, not derived from src at all";',
      'const piece = unrelated.split(",")[0].slice(0, 5);',
      'expect(piece).toContain("hello");',
    ].join("\n");
    expect(findSourceReading(text)).toEqual([]);
  });
});

describe("findOwnModuleMocks — mocking this repo's own src/ defeats the test", () => {
  test('flags vi.mock("../../src/studio/paste") — resolves under src/', () => {
    const fx = new Fixture();
    try {
      fx.writeModule("src/studio/paste.ts", "export const x = 1;\n");
      const testText = 'vi.mock("../src/studio/paste");';
      const hits = findOwnModuleMocks(testText, fx.testDir);
      expect(hits).toHaveLength(1);
      expect(hits[0].kind).toBe("own-module-mock");
    } finally {
      fx.cleanup();
    }
  });

  test('flags mock.module("./paste") — resolves under src/, same way', () => {
    const fx = new Fixture();
    try {
      // Resolve "./paste" from inside src/ itself, so it lands on src/paste.ts.
      fx.writeModule("src/paste.ts", "export const x = 1;\n");
      const testText = 'mock.module("./paste");';
      const hits = findOwnModuleMocks(testText, join(fx.dir, "src"));
      expect(hits).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test('does NOT flag vi.mock("node:fs") — a system boundary, bare specifier', () => {
    expect(findOwnModuleMocks('vi.mock("node:fs");', "/tmp/anywhere")).toEqual([]);
  });

  test('does NOT flag vi.mock("playwright-core") — an external package, bare specifier', () => {
    expect(findOwnModuleMocks('vi.mock("playwright-core");', "/tmp/anywhere")).toEqual([]);
  });

  test("a trailing `test-lies-check: allow` exempts that one flagged line only (via scanFile)", () => {
    const fx = new Fixture();
    try {
      fx.writeModule("src/studio/paste.ts", "export const x = 1;\n");
      fx.writeModule(
        "test/x.test.ts",
        'vi.mock("../src/studio/paste"); // test-lies-check: allow\n',
      );
      const text = readFileSync(join(fx.testDir, "x.test.ts"), "utf8");
      expect(scanFile("test/x.test.ts", text, fx.dir)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});

describe("formatFinding", () => {
  test("formats a finding as path:line: [kind] detail", () => {
    const hit = { line: 4, kind: "tautological" as const, detail: "FOO mirrors ./bar's own declared value" };
    expect(formatFinding("test/x.test.ts", hit)).toMatch(/^test\/x\.test\.ts:4: \[tautological\] /);
  });
});

describe("the repository itself", () => {
  test("every allowlisted path still exists and says why it is exempt", () => {
    for (const [path, reason] of Object.entries(ALLOWLIST)) {
      expect(() => readFileSync(join(REPO_ROOT, path))).not.toThrow();
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  // Phase 2 (#174): the backlog is cleared and this IS a pass/fail
  // threshold now — local-ci/fleet-check's test-lies-check lane depends on
  // findings.length being 0 against the real repo, so this test pins that
  // directly, not just that the scan runs without throwing.
  test("scans every real test file in the repo without throwing, and finds nothing", async () => {
    const findings = await scanRepo();
    const byKind: Record<string, number> = {};
    for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    console.log(`test-lies-check: ${findings.length} finding(s) —`, byKind);
    expect(Array.isArray(findings)).toBe(true);
    for (const f of findings) {
      expect(typeof f.path).toBe("string");
      expect(typeof f.line).toBe("number");
    }
    expect(findings.length).toBe(0);
  }, 30_000);

  // The ALLOWLIST entry for this file is load-bearing, not decorative: its
  // own `vi.mock("../src/studio/paste");` fixture above (a string literal
  // standing in for example flagged code) would resolve, for real, from
  // this file's own real test/bun/ directory straight to the real
  // apps/fleet/src/studio/paste.ts and trip findOwnModuleMocks — and since
  // Phase 1 never fails CI, a dropped ALLOWLIST entry would regress this
  // silently. Pin it directly, rather than only trusting a no-throw check.
  test("test-lies-check's own test file never appears in its own real findings", async () => {
    const findings = await scanRepo();
    expect(findings.some((f) => f.path === "apps/fleet/test/bun/test-lies-check.test.ts")).toBe(false);
  }, 30_000);
});

// Phase 2 (#174): the CLI's actual exit-code contract — what
// local-ci/fleet-check's test-lies-check lane depends on — pinned directly
// as a repeatable test, not just proven once by hand during the Phase 2 flip.
describe("the CLI exit code (#174) — Phase 2's real failing-gate contract", () => {
  const SCRIPT = join(import.meta.dir, "../../scripts/test-lies-check.ts");

  test("the real repo today: no findings, exit 0", () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT]);
    expect(p.stdout.toString()).toContain("0 tautological, 0 source-reading, 0 own-module-mock");
    expect(p.exitCode).toBe(0);
  }, 30_000);

  // A synthetic repo, not a mutation of a real tracked file: a throwaway
  // directory shaped like apps/fleet/scripts|test|src/ so a real COPY of the
  // script (REPO_ROOT is computed from import.meta.dir at run time, three
  // levels up from scripts/) resolves its own REPO_ROOT to the throwaway
  // root, scans it for real, and actually exits through the CLI block.
  test("a synthetic repo with one injected tautological finding: exit 1, the finding listed", () => {
    const root = mkdtempSync(join(tmpdir(), "test-lies-check-cli-"));
    try {
      const scriptsDir = join(root, "apps/fleet/scripts");
      const testDir = join(root, "apps/fleet/test");
      const srcDir = join(root, "apps/fleet/src");
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
      mkdirSync(srcDir, { recursive: true });
      const copy = join(scriptsDir, "test-lies-check.ts");
      writeFileSync(copy, readFileSync(SCRIPT, "utf8"));
      // The script imports the shared runner from "./repo-check" — the copy
      // must carry it too, or the CLI dies at module resolution in the throwaway.
      writeFileSync(
        join(scriptsDir, "repo-check.ts"),
        readFileSync(join(import.meta.dir, "../../scripts/repo-check.ts"), "utf8"),
      );
      writeFileSync(join(srcDir, "bad.ts"), "export const BAD_CONST = 42;\n");
      writeFileSync(
        join(testDir, "bad.test.ts"),
        [
          'import { BAD_CONST } from "../src/bad";',
          "",
          "test('x', () => {",
          "  expect(BAD_CONST).toBe(42);",
          "});",
          "",
        ].join("\n"),
      );
      // git ls-files (listTestFiles) needs these tracked in the index — no
      // commit required, `git add` alone is enough.
      Bun.spawnSync(["git", "init", "-q"], { cwd: root });
      Bun.spawnSync(["git", "add", "-A"], { cwd: root });
      const p = Bun.spawnSync([process.execPath, copy]);
      const out = p.stdout.toString();
      expect(out).toContain("[tautological] BAD_CONST mirrors");
      expect(out).toContain("1 tautological, 0 source-reading, 0 own-module-mock");
      expect(p.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
