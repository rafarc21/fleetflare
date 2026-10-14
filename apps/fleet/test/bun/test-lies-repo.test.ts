import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWLIST, REPO_ROOT, findSourceReading, findTautologies, scanRepo,
} from "../../scripts/test-lies-check";

/**
 * Repo + CLI half of the old test-lies-check.test.ts (split #803, sweep-35
 * F10, refs #735): the repository-itself scan (ALLOWLIST + scanRepo), the
 * CLI exit-code contract (#174 Phase 2's real failing gate), and the
 * quote/escape/bracket-depth walker characterization (#323). The detector
 * unit cases live in test-lies-detectors.test.ts.
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

  // The ALLOWLIST entries for the check's own test files are load-bearing,
  // not decorative: both split halves hold fixtures as string literals that
  // textually contain flagged shapes (e.g. `vi.mock("../src/studio/paste")`
  // resolving, for real, from test/bun/ straight to apps/fleet/
  // src/studio/paste.ts), so without the ALLOWLIST entries the gate would
  // fail on its own fixtures. Since the gate now fails CI on any finding,
  // a dropped entry would break CI rather than regress silently — pin it
  // directly. The deleted single-file original stays in the list so a
  // half-done ALLOWLIST edit cannot pass unnoticed.
  test("test-lies' own test files never appear in its real findings", async () => {
    const findings = await scanRepo();
    const ownPaths = [
      "apps/fleet/test/bun/test-lies-check.test.ts",
      "apps/fleet/test/bun/test-lies-detectors.test.ts",
      "apps/fleet/test/bun/test-lies-repo.test.ts",
    ];
    for (const path of ownPaths) {
      expect(findings.some((f) => f.path === path)).toBe(false);
    }
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
      // git ls-files (the runner's listing) needs these tracked in the index — no
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

// #323 — characterization of the quote/escape/bracket-depth walking that
// findCalls/findExpectToBeCalls/extractBalanced/firstArgText do inline today,
// BEFORE it is merged behind one scanCalls core. These pin CURRENT behavior
// (including its known limitations), not ideal behavior: the refactor must
// keep every one of these passing. All through public detectors — the walkers
// are private, and the public interface is the test surface (deep-modules).
//
// Some cases come in pairs: the shape named by the plan (often the real
// join(...)/template-literal repo idiom) plus a "discriminator" companion
// whose in-string , ( ) \ sits where a quote-blind walk would actually
// mis-balance and change the output — verified against a quote-handling-
// stripped copy of the script (kept in /tmp, never the repo file): the
// companion shapes produce 0 hits there but 1 hit on the real code, so they
// are the ones that make the quote walk load-bearing.
describe("quote/escape/bracket-depth walking (characterization, #323)", () => {
  test("escaped quote inside a read path string does not break arg extraction", () => {
    // `readFileSync('src/f\'oo.ts', 'utf8')` — the escape-skip must keep the
    // string open past the inner quote so the args still balance.
    const text = [
      "const t = readFileSync('src/f\\'oo.ts', 'utf8');",
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    // Pins current behavior: the WALK keeps the string whole (hence the
    // hit), but pathLiteralOf's quote-class literal regex cuts the reported
    // path at the escaped quote — the detail carries "src/f\", not the full
    // "src/f\'oo.ts" the case might naively expect.
    expect(hits[0].detail).toContain("src/f\\");
  });

  test("an escaped ) in a path string does not close the call's args early (escape-skip discriminator)", () => {
    // `readFileSync('src/x\)', 'utf8')` — without the escape-skip the walk
    // sees a raw ) one char in, extractBalanced returns a truncated arg text
    // that pathLiteralOf cannot read a path out of, and the read is
    // silently dropped (conservative skip, 0 hits). The escape-skip is what
    // keeps the args balanced up to the call's real closing paren.
    const text = [
      "const t = readFileSync('src/x\\)', 'utf8');",
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("src/x\\)");
  });

  test("commas and brackets inside a string in a join(...) first arg are not argument separators", () => {
    // The joined literal "../../src/a,[b.ts" carries both a comma and an
    // unbalanced [ — neither may be seen by the bracket-depth walk.
    const text = [
      'const t = readFileSync(join(import.meta.dir, "../../src/a,[b.ts"), "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("../../src/a,[b.ts");
  });

  test("a bare path literal with a comma and bracket inside is not cut at the string's comma (firstArgText discriminator)", () => {
    // `readFileSync("src/a,[b.ts", "utf8")` — if firstArgText saw the comma
    // inside the string, the first argument would end mid-literal at
    // `"src/a` with no closing quote, pathLiteralOf would find no path, and
    // the hit would vanish. The string-skipping in the walk is what keeps
    // the whole literal as one argument.
    const text = [
      'const t = readFileSync("src/a,[b.ts", "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("src/a,[b.ts");
  });

  test("template-literal read path with ${} keeps its full text", () => {
    // The whole backtick span is walked as opaque string content — the ${}
    // inside is never entered, so the call's args still close on the real
    // paren. This is the documented walker limitation #323 must preserve.
    const text = [
      'const t = readFileSync(`src/${name}.ts`, "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("src/${name}.ts");
  });

  test("a ( inside a template literal's ${} is skipped like any other quote content", () => {
    // `src/${join(base, name)}.ts` — the plan's documented limitation: the
    // quote machine does NOT track ${} inside template literals, so the
    // parens and comma of the nested call inside ${} are opaque string
    // content; the read call's args still close on the real paren and the
    // full literal text (parens and all) is kept.
    const text = [
      'const t = readFileSync(`src/${join(base, name)}.ts`, "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("src/${join(base, name)}.ts");
  });

  test("a comma inside a template literal is not a top-level argument separator", () => {
    // Discriminating companion to the two template-literal cases above: with
    // the backtick arm of the quote machine deleted, the template contents
    // count as code and the in-template comma splits the first argument —
    // 0 hits on that mutant, 1 hit on the real code. Without a case like
    // this, the backtick flavor of the quote walk is unpinned: all other
    // template cases keep passing on a backtick-blind core.
    const text = [
      'const t = readFileSync(`src/a, b.ts`, "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("src/a, b.ts");
  });

  test("a string containing ) inside nested call args does not close the call early", () => {
    // `readFileSync(join(a, "src/x(1).ts"), "utf8")` — the ( and ) inside
    // the literal must not perturb the paren-depth walk closing the nested
    // join and the outer readFileSync on their real parens.
    const text = [
      'const t = readFileSync(join(a, "src/x(1).ts"), "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("src/x(1).ts");
  });

  test("a bare first-arg string containing ) does not close the call early (extractBalanced discriminator)", () => {
    // `readFileSync("src/x).ts", "utf8")` — if extractBalanced saw the )
    // inside the string, the call would "close" mid-literal, the arg text
    // would end at `"src/x` with no closing quote, no path could be
    // extracted, and the hit would vanish. Quote-awareness is what keeps
    // the args balanced up to the real closing paren.
    const text = [
      'const t = readFileSync("src/x).ts", "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain("src/x).ts");
  });

  test("multi-line call args: hit line number is the call's opening line", () => {
    // The line is computed from the call NAME's index, not from where the
    // args happen to close — the read opens on line 1, its literal sits on
    // line 2, and the hit must report the opening line.
    const text = [
      "const t = readFileSync(",
      '  "src/foo.ts",',
      '  "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  test("a skipped Bun.file candidate is scanned past, its argument text not rescanned", () => {
    // The first Bun.file( has no .text() in its 10-char window (it is followed
    // by .json()), so scanCalls's accept hook returns null and the candidate
    // is skipped — but its ARG text still contains a second, real
    // Bun.file("src/inner.ts").text() call. The skip must advance lastIndex
    // past the skipped candidate's own closing paren (the
    // `re.lastIndex = bal.endIndex + 1` in scanCalls's kept-null branch): a
    // bare `continue` would leave lastIndex inside the skipped candidate's
    // args and re-match the nested Bun.file(, attributing src/inner.ts to
    // line 1 on top of the real line-2 hit. No other test in this file
    // protects that line — deleting it passes every one of them.
    //
    // The nested call must sit in expect(...).toContain(...) position inside
    // the skipped candidate's arg text: findSourceReading drops a candidate
    // that has no assertion or var-capture around it, so a plainly-concatenated
    // nested call would be silently dropped on the mutant too and the test
    // could not see the difference. In the inline-assert position the mutant's
    // rescanned candidate survives the detector's gates and misreports —
    // verified against a /tmp copy of the script with the skip-advance line
    // deleted (never the repo file): real code reports exactly this one hit;
    // the mutant reports a second, line-1 hit for src/inner.ts.
    const text = [
      'const q = Bun.file("outer " + expect(Bun.file("src/inner.ts").text()).toContain("hi")).json();',
      'const inner = await Bun.file("src/real.ts").text();',
      'expect(inner).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    // Pin current behavior (measured): exactly the real line-2 read is
    // flagged — nothing attributed to the skipped line-1 candidate, and the
    // nested src/inner.ts inside its arg text is never double-counted.
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
    expect(hits[0].detail).toContain("src/real.ts");
  });

  test("expect(...).toBe with a ) inside the asserted string does not end the args early", () => {
    // `S` declared as "a)b" and asserted as "a)b" IS the restated-value
    // tautology shape: extractBalanced must keep the string whole so the
    // asserted arg text is seen in full and the hit lands on the expect
    // line — a quote-blind walk closes the args at `"a` and the mismatch
    // silently drops the finding.
    const fx = new Fixture();
    try {
      fx.writeModule("src/s.ts", 'export const S = "a)b";\n');
      const testText = [
        'import { S } from "../src/s";',
        'expect(S).toBe("a)b");',
      ].join("\n");
      const hits = findTautologies(testText, fx.testDir);
      expect(hits).toHaveLength(1);
      expect(hits[0].kind).toBe("tautological");
      expect(hits[0].line).toBe(2);
    } finally {
      fx.cleanup();
    }
  });
});
