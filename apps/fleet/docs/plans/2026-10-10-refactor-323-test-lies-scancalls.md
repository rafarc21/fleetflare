# Refactor #323: deepen test-lies-check scanning behind one scanCalls

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the three hand-written quote/escape/bracket-depth walkers in `apps/fleet/scripts/test-lies-check.ts` behind one private scanning core so a quote-handling fix lands in one place, with detector output byte-identical on the whole repo.

**Architecture:** One private function `scanCalls(text, matcher)` walks quote state + bracket depth once and returns `CallMatch[]` (name, argText, start, end, line). The three call finders (`findCalls`, `findExpectToBeCalls`, `findBunFileTextCalls`) keep their public names and become thin matchers over it. The three walkers (`hasTopLevelComma`, `extractBalanced`, `firstArgText`) collapse into the scanning core. Line-number calculation moves inside the core — the `text.slice(0, m.index).split("\n").length` idiom currently appears 4×.

**Tech Stack:** Bun, TypeScript, no new dependencies. Pure in-process code.

**Spec:** `docs/maintainability/2026-10-10-deep-modules-sweep-2.md` §F8 (https://github.com/rafarc21/fleetflare/issues/323); skill step: deep-modules CD "Deep vs shallow" + deletion test (3 walkers merge, nothing lost).

## Global Constraints

- Board issue: https://github.com/rafarc21/fleetflare/issues/323 (PR refs #323, never "closes").
- Tier GLM-OK: behavior-preserving, ≤400 changed lines, this module only.
- **Behavior-preserving rule:** `bun run test-lies-check` output on the whole repo byte-identical before/after. Current baseline on main: `test-lies-check: 0 tautological, 0 source-reading, 0 own-module-mock across 311 test files`, exit 0.
- Walkers stay private — no new exports from `scripts/test-lies-check.ts`. Detectors keep their public names (`findTautologies`, `findSourceReading`, `findOwnModuleMocks`, `scanFile`, `scanRepo`, `formatFinding`, `ALLOWLIST`, `REPO_ROOT`, `resolveRelative`, `Hit`, `Finding`, `HitKind`).
- Characterization tests go through the public detectors only (the interface is the test surface).
- English only in all repo content. Commit identity: fleet-studio noreply (already configured).
- Targeted tests only: `bun test test/bun/test-lies-check.test.ts` and `bun run test-lies-check`. Never run full suite + build together (memory ceiling); full suite belongs to CI.

## Current shape (verified on main, 7ca9db2)

`apps/fleet/scripts/test-lies-check.ts` has three private walkers, each with the SAME quote-state machine inline:

- `hasTopLevelComma(s)` :78-94 — depth counter over `()[]{}`, skips quote contents, returns true on top-level comma.
- `extractBalanced(text, start)` :103-121 — paren-depth walk from after an opening `(`, skips quotes, returns `{argText, endIndex}` or null.
- `firstArgText(argText)` :263-279 — same depth walk over already-extracted arg text, cuts at first top-level comma.

And three call finders, each with the SAME loop skeleton (regex exec loop → extractBalanced → line via `text.slice(0, m.index).split("\n").length` → advance lastIndex past `)`):

- `findCalls(text, names)` :133-151 — `\b(name1|name2)\(` regex, returns `CallMatch[]`.
- `findExpectToBeCalls(text)` :206-218 — `\bexpect\(\s*ident\s*\)\.toBe\(` regex, returns `{line, ident, argText}[]`.
- `findBunFileTextCalls(text)` :425-449 — `\bBun\.file\(` regex, then requires `.text()` within 10 chars after the close paren; `end` includes the `.text()` suffix.

Known walker limitation (characterized, must be preserved): the quote machine does NOT track `${}` inside template literals or comment lines — a `(` inside a template literal's `${}` expression is skipped like any other quote content (the whole backtick span is treated as opaque), and `//` comments are not skipped at all. These tests pin current behavior, not ideal behavior. That is deliberate: characterization tests pin what IS, so the refactor provably preserves it.

## Design

One private scanning core:

```ts
/** One quote/escape/bracket-depth state machine. Enters quote state on
 *  " ' ` , skips escaped chars inside quotes, tracks ()[]{} depth, and
 *  reports what it sees through `onChar`. This is the single copy of the
 *  quote-walking logic that used to exist three times (hasTopLevelComma,
 *  extractBalanced, firstArgText). */
```

`scanCalls(text, matcher)` where matcher describes the call shape:

```ts
interface CallMatcher {
  /** Global regex whose last group end is the char right after the
   *  opening `(` of a candidate call. */
  open: RegExp;
  /** Called with the balanced-arg result for each candidate; return the
   *  CallMatch to keep (may extend `end`, e.g. Bun.file(...).text()),
   *  or null to skip the candidate. */
  accept?: (m: RegExpExecArray, bal: { argText: string; endIndex: number }) => Partial<CallMatch> | null;
}
```

`scanCalls` body: regex loop like today's finders; for each match, extract balanced args via the shared core; compute line via one shared `lineOf(text, index)` helper (or inline — one copy either way); skip on unbalanced text (same silent conservative skip as today); advance `lastIndex` past the kept call's `end`.

`findCalls`, `findExpectToBeCalls`, `findBunFileTextCalls` become ~5-line functions over `scanCalls` with their regexes unchanged (byte-identical regex sources). `hasTopLevelComma` and `firstArgText` keep their public-to-file behavior but are expressed over the same state machine (e.g. a `walkTopLevel(s, stopAt: (c, i) => number | void)`-style internal helper, or scanCalls-with-matcher reused where it fits — implementer's choice, as long as there is exactly ONE quote-state machine in the file).

Interface check (deep-modules): deletion test passes — delete `scanCalls`, the complexity reappears in 3 callers. Interface shrinks: 6 private functions → 3 finders + 1 core; the line-calc idiom 4× → 1×.

## Task 1: Characterization tests (RED where new, then GREEN on main behavior)

**Files:**
- Modify: `apps/fleet/test/bun/test-lies-check.test.ts` (append one new describe block; no changes to existing tests)

**Steps:**

1. **Write the new tests** — a `describe("quote/escape/bracket-depth walking (characterization, #323)")` block at the end of the file (before the CLI exit-code describe is fine too — anywhere top-level). Cases, each through a PUBLIC detector:

```ts
describe("quote/escape/bracket-depth walking (characterization, #323)", () => {
  // All through public detectors: the walkers are private; the interface
  // is the test surface (deep-modules).

  test("escaped quote inside a read path string does not break arg extraction", () => {
    // readFileSync("src/f\\'oo.ts") — the \' must not end the string early
    // nor confuse the paren depth walk. Exercised through findSourceReading
    // via the captured-variable case.
    const text = [
      'const t = readFileSync("src/f\\'oo.ts", "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("src/f\\'oo.ts");
  });

  test("commas inside brackets/strings in a join(...) first arg are not argument separators", () => {
    // join(import.meta.dir, "../../src/x") — the inner comma is a call
    // argument separator at depth 0 of the OUTER call's arg text, but the
    // literals with commas inside [] must not cut firstArgText early.
    const text = [
      'const t = readFileSync(join(import.meta.dir, "../../src/a,[b.ts"), "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("../../src/a,[b.ts");
  });

  test("template-literal read path with ${} keeps its full text", () => {
    const text = [
      'const t = readFileSync(`src/${name}.ts`, "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("src/${name}.ts");
  });

  test("nested parens and a string containing ) do not end the call early", () => {
    const text = [
      'const t = readFileSync(join(a, "src/x(1).ts"), "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    expect(findSourceReading(text)).toHaveLength(1);
  });

  test("multi-line call args: line number is the call's opening line", () => {
    const text = [
      'const t = readFileSync(',
      '  "src/foo.ts",',
      '  "utf8");',
      'expect(t).toContain("hi");',
    ].join("\n");
    const hits = findSourceReading(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  test("expect(...).toBe argument containing a ) inside a string does not end args early", () => {
    // Through findTautologies — but with a NON-matching literal so it is a
    // skip case either way; the point is it does not mis-split.
    const fx = new Fixture();
    try {
      fx.writeModule("src/s.ts", 'export const S = "a)b";\n');
      const testText = [
        'import { S } from "../src/s";',
        'expect(S).toBe("a)b");',
      ].join("\n");
      // Not tautological per normalizeExpr? "a)b" === "a)b" IS a match —
      // this IS the tautology shape. Pin it as a flagged hit at line 2.
      const hits = findTautologies(testText, fx.testDir);
      expect(hits).toHaveLength(1);
      expect(hits[0].line).toBe(2);
    } finally {
      fx.cleanup();
    }
  });
});
```

IMPORTANT — before committing: RUN the tests (`bun test test/bun/test-lies-check.test.ts` from `/workspace/fleetflare/apps/fleet`) and FIX the expected values to whatever current behavior actually is. These are characterization tests: they pin CURRENT behavior. If a case finds 0 hits where the sketch above expects 1, do not "fix" the walker — investigate why (e.g. pathLiteralOf's `src/` regex on the literal), adjust the case so it still exercises the quote/bracket walk meaningfully, and record the real expected value with a one-line comment saying what current behavior is. The tests must PASS on the UNCHANGED main code — that is the point: they must keep passing after the refactor.

2. **Run:** `bun test test/bun/test-lies-check.test.ts` from `/workspace/fleetflare/apps/fleet`. Expect: all pass (30 existing + 6 new = 36).

3. **Commit:**
```bash
git add apps/fleet/test/bun/test-lies-check.test.ts
git commit -m "test: characterize test-lies-check quote/bracket walking (refs #323)"
```

4. **Push:** `LEFTHOOK=0 git push -u origin refactor-323-test-lies-scancalls`

## Task 2: Refactor walkers behind scanCalls

**Files:**
- Modify: `apps/fleet/scripts/test-lies-check.ts` only.

**Steps:**

1. **Before touching code:** capture the full CLI output for the behavior-preserving diff: from `/workspace/fleetflare/apps/fleet`, `bun run test-lies-check > /tmp/tlc-before.txt; echo $? >> /tmp/tlc-before.txt`.

2. **Implement** per the Design section above. Rules:
   - Regex sources byte-identical to today (copy the literal regex sources from the current code).
   - `CallMatch` interface unchanged (name, argText, start, end, line) — `findCalls` and `findBunFileTextCalls` still return `CallMatch[]`; `findExpectToBeCalls` still returns `{line, ident, argText}[]` (map from CallMatch).
   - The `Bun.file(...).text()` lookahead logic (10-char window, `end` extended by the `.text()` match length, skip candidate when absent) moves into its matcher's accept hook — same 10-char window, same regex.
   - Silent skip on unbalanced text preserved (continue, no throw).
   - exactly ONE quote-state machine in the file afterwards (grep: the `if (c === "\\") { i++; continue; }` escape-skip line must appear once).
   - Update the file-header doc comment only if it mentions walker names — it doesn't (checked), so no header changes.
   - No new exports. No import changes.
3. **Verify behavior-preserving:** `bun run test-lies-check > /tmp/tlc-after.txt; echo $? >> /tmp/tlc-after.txt; diff /tmp/tlc-before.txt /tmp/tlc-after.txt && echo IDENTICAL`
4. **Run targeted tests:** `bun test test/bun/test-lies-check.test.ts` — all pass.
5. **Check line budget:** `git diff --stat` on main — changed lines ≤400 (expect ~120 per the sweep doc).
6. **Commit:**
```bash
git add apps/fleet/scripts/test-lies-check.ts
git commit -m "refactor: one scanCalls core behind test-lies-check detectors (refs #323)"
```

7. **Push:** `LEFTHOOK=0 git push`

## Verification (the completion record's evidence)

Each with real exit code and real output tail, from `/workspace/fleetflare/apps/fleet`:

1. `bun test test/bun/test-lies-check.test.ts` — exit 0, N pass, 0 fail.
2. `bun run test-lies-check` — exit 0, byte-identical to the pre-refactor baseline recorded above.

Boundaries: neither command is a heavy gate (the full bun-test suite and vite builds are; these two are not — one test file, one scan script). Run them sequentially anyway.
