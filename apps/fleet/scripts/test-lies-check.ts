#!/usr/bin/env bun
/**
 * Board issue #164, Phase 1: a REPORT-ONLY scan for "test lies" — tests that
 * pass but are structurally unable to catch a real bug. Three shapes:
 *
 *   - tautological: `expect(IMPORTED_CONST).toBe(<literal>)` where the
 *     literal is just the import's own declared value, copied back.
 *   - source-reading: a `src/` file read as raw text and string-matched
 *     (`toContain`/`toMatch`/`includes`) instead of imported and exercised.
 *   - own-module-mock: `vi.mock`/`jest.mock`/`mock.module` pointed at one
 *     of this repo's own `src/` modules, instead of a system boundary.
 *
 * Every detector here does plain text-pattern scanning, not real parsing —
 * same spirit as english-check (#66) — so every detector is deliberately
 * conservative: any resolution failure or ambiguity (an import that cannot
 * be resolved, an export the regex cannot find, a multi-declaration
 * `export const A = 1, B = 2;` shape, etc.) is a silent SKIP, never a flag.
 * A noisy check gets disabled, which is worse than no check.
 *
 * Phase 1 (docs/plans/2026-10-01-test-lies-check-phase1.md) was report-only:
 * `scanRepo()` ran, the CLI printed findings and counts, and always exited 0
 * regardless of what it found — the point was to get real, honest counts
 * before committing to a threshold. Phase 2 (#174,
 * docs/plans/2026-10-01-test-lies-check-phase2.md) cleared that backlog to
 * 0 and flipped this into a real gate: the CLI now exits 1 on any finding,
 * 0 on none, and is wired into `local-ci/fleet-check`.
 *
 * Escape hatch for a single line: end it with `test-lies-check: allow`. For
 * a whole deliberate file (this check's own test, whose fixtures are string
 * literals holding example "bad" code text), use ALLOWLIST.
 *
 * Run by hand: `bun run scripts/test-lies-check.ts`, or by its own test
 * (test/bun/test-lies-check.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const ALLOW_ESCAPE = "test-lies-check: allow";

/** Files that hold deliberate example "bad" code as string literals. Each
 *  entry says why. Scanning them for real would flag the check's own
 *  fixtures, since detection here is plain text-pattern scanning, not
 *  real parsing — it cannot tell a fixture string from live code. */
export const ALLOWLIST: Record<string, string> = {
  "apps/fleet/test/bun/test-lies-check.test.ts":
    "its own fixtures are string literals holding example flagged code " +
    "(e.g. `expect(FOO).toBe(5)`) fed straight into the detectors; a real " +
    "text-pattern scan of this file would flag its own test fixtures",
};

export type HitKind = "tautological" | "source-reading" | "own-module-mock";

export interface Hit {
  line: number;
  kind: HitKind;
  detail: string;
}

export interface Finding extends Hit {
  path: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip all whitespace, so `20 * 60` and `20*60` (or the same split across
 *  lines) compare equal. */
function normalizeExpr(s: string): string {
  return s.replace(/\s+/g, "");
}

/** The single copy of the quote-walking logic, shared by hasTopLevelComma,
 *  extractBalanced and firstArgText. Walks `text` from `from`: enters quote
 *  state on `"`, `'` and `` ` `` (the whole backtick span — including any
 *  `${...}` substitution inside it — is walked as opaque string content;
 *  not tracking substitutions is a known, characterized limitation, not a
 *  bug to fix here), and inside quotes skips the char after a backslash.
 *  Every other char is handed to `onChar`, which owns its own bracket-depth
 *  policy and returns an index to stop the walk there (that index becomes
 *  the return value), or nothing to keep walking. Returns null when the
 *  walk never stopped. */
function walkTopLevel(
  text: string,
  from: number,
  onChar: (c: string, i: number) => number | void,
): number | null {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    const stop = onChar(c, i);
    if (stop !== undefined) return stop;
  }
  return null;
}

/** True when `s` contains a comma outside any bracket/paren/brace/string —
 *  the shape a `export const A = 1, B = 2;` multi-declaration's captured
 *  value text would have. Used to skip that ambiguous case entirely. */
function hasTopLevelComma(s: string): boolean {
  let depth = 0;
  return walkTopLevel(s, 0, (c, i) => {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return i;
  }) !== null;
}

/**
 * Starting at `start` (the index right after an opening `(` already
 * consumed by the caller), walks forward tracking paren depth (string
 * literals are skipped over whole, so parens inside them don't confuse the
 * count) until the matching close paren. Returns the text in between and
 * the index of that closing paren, or null if the text ends unbalanced.
 */
function extractBalanced(text: string, start: number): { argText: string; endIndex: number } | null {
  let depth = 1;
  const endIndex = walkTopLevel(text, start, (c, i) => {
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  });
  return endIndex === null ? null : { argText: text.slice(start, endIndex), endIndex };
}

interface CallMatch {
  name: string;
  argText: string;
  start: number;
  end: number; // index of the call's own closing ')'
  line: number;
}

/** The one copy of the line-number calc (`text.slice(0, index).split("\n")`
 *  .length — the count of lines up to and including `index`), so every
 *  finder reports lines through the same idiom. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** How one detector's calls look to `scanCalls`: `open` is the global regex
 *  whose match ends right after the candidate call's opening `(`;
 *  `name(m)` reports the CallMatch's name for a kept candidate; `accept`,
 *  when present, sees each candidate's balanced-arg result and either
 *  returns the one field `scanCalls` honors — the call's own closing-paren
 *  index, possibly extended, e.g. past a `.text()` suffix — or null to
 *  silently skip the candidate, the same conservative
 *  skip-as-ambiguity-avoidance rule every detector here follows. A skipped
 *  candidate is still scanned PAST (lastIndex moves on to its closing
 *  paren): its argument text must not be re-matched, e.g. a `Bun.file(`
 *  sitting inside a skipped candidate's own string literal. */
interface CallMatcher {
  open: RegExp;
  name: (m: RegExpExecArray) => string;
  accept?: (m: RegExpExecArray, bal: { argText: string; endIndex: number }) => { end: number } | null;
}

/** The single scanning core behind every call finder here (findCalls,
 *  findExpectToBeCalls, findBunFileTextCalls) — the one place the
 *  quote-walking logic (walkTopLevel, via extractBalanced) and the
 *  line-number calc (lineOf) get applied to call finding. Per candidate:
 *  one regex-exec loop, one quote-aware balanced-arg extraction, and
 *  `lastIndex` advanced past the kept call's `end` so a kept call's own
 *  text is never rescanned. Unbalanced text (extractBalanced null) is a
 *  silent conservative skip — never a throw, never a flag. */
function scanCalls(text: string, matcher: CallMatcher): CallMatch[] {
  const results: CallMatch[] = [];
  const re = matcher.open;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const bal = extractBalanced(text, m.index + m[0].length);
    if (!bal) continue;
    const kept: Partial<CallMatch> | null = matcher.accept ? matcher.accept(m, bal) : {};
    if (kept === null) {
      re.lastIndex = bal.endIndex + 1;
      continue;
    }
    const end = kept.end ?? bal.endIndex;
    results.push({
      name: matcher.name(m),
      argText: bal.argText,
      start: m.index,
      end,
      line: lineOf(text, m.index),
    });
    re.lastIndex = end + 1;
  }
  return results;
}

/** Finds every call to one of `names` (word-boundary before the name),
 *  extracting its paren-depth-balanced argument text. */
function findCalls(text: string, names: string[]): CallMatch[] {
  return scanCalls(text, {
    open: new RegExp(`\\b(${names.map(escapeRegex).join("|")})\\(`, "g"),
    name: (m) => m[1],
  });
}

/**
 * Resolves a relative (`.`/`..`-prefixed) specifier against `fromDir`,
 * trying the exact path, `.ts`, `.tsx`, `/index.ts`, `/index.tsx` in order.
 * A bare specifier (no leading `.`) always returns null — callers treat
 * that as "not a repo-relative import", not as a resolution failure.
 * Reads each candidate at most once; `cache` can be shared across calls to
 * avoid re-reading the same module file for every reference to it.
 */
export function resolveRelative(
  fromDir: string,
  spec: string,
  cache: Map<string, string | null> = new Map(),
): { path: string; text: string } | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(fromDir, spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const c of candidates) {
    if (cache.has(c)) {
      const cached = cache.get(c);
      if (cached !== null && cached !== undefined) return { path: c, text: cached };
      continue;
    }
    try {
      const text = readFileSync(c, "utf8");
      cache.set(c, text);
      return { path: c, text };
    } catch {
      cache.set(c, null);
    }
  }
  return null;
}

/** Parses `import { A, B as C } from "./relative/path"` statements (relative
 *  specifiers only) into a local-name → {modulePath, exportedName} map. */
function parseImports(text: string): Map<string, { modulePath: string; exportedName: string }> {
  const map = new Map<string, { modulePath: string; exportedName: string }>();
  const re = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, names, modulePath] = m;
    if (!modulePath.startsWith(".")) continue;
    for (const raw of names.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const asMatch = part.match(/^(\S+)\s+as\s+(\S+)$/);
      if (asMatch) map.set(asMatch[2], { modulePath, exportedName: asMatch[1] });
      else map.set(part, { modulePath, exportedName: part });
    }
  }
  return map;
}

function findExpectToBeCalls(text: string): Array<{ line: number; ident: string; argText: string }> {
  return scanCalls(text, {
    open: /\bexpect\(\s*([A-Za-z_$][\w$]*)\s*\)\.toBe\(/g,
    name: (m) => m[1],
  }).map((cm) => ({ line: cm.line, ident: cm.name, argText: cm.argText }));
}

/** The declared RHS text of `export const <exportedName> = ...;` in
 *  `moduleText`, or null if not found, or if it looks like a
 *  multi-declaration (`export const A = 1, B = 2;`) — genuinely ambiguous
 *  from a regex alone, so skipped rather than mis-attributed. */
function findDeclaredConstValue(moduleText: string, exportedName: string): string | null {
  const re = new RegExp(`export const ${escapeRegex(exportedName)}(?:\\s*:[^=]+)?\\s*=\\s*([^;]+);`);
  const m = moduleText.match(re);
  if (!m) return null;
  if (hasTopLevelComma(m[1])) return null;
  return m[1];
}

/** Detector 1: `expect(IMPORTED_CONST).toBe(<literal>)` that just restates
 *  the import's own declared value. See the file header for the algorithm
 *  and its conservative-skip cases. */
export function findTautologies(
  testText: string,
  testDir: string,
  cache: Map<string, string | null> = new Map(),
): Hit[] {
  const imports = parseImports(testText);
  const hits: Hit[] = [];
  for (const call of findExpectToBeCalls(testText)) {
    const imp = imports.get(call.ident);
    if (!imp) continue;
    const resolved = resolveRelative(testDir, imp.modulePath, cache);
    if (!resolved) continue;
    const declared = findDeclaredConstValue(resolved.text, imp.exportedName);
    if (declared === null) continue;
    if (normalizeExpr(declared) !== normalizeExpr(call.argText)) continue;
    hits.push({
      line: call.line,
      kind: "tautological",
      detail: `${call.ident} mirrors ${imp.modulePath}'s own declared value`,
    });
  }
  return hits;
}

/** The text of `argText`'s first top-level argument — up to the first
 *  top-level comma, respecting nested parens/brackets/braces/strings (so a
 *  nested call's own commas, e.g. `join(a, b)` as the first argument,
 *  don't get mistaken for the outer call's argument separator). */
function firstArgText(argText: string): string {
  let depth = 0;
  const comma = walkTopLevel(argText, 0, (c, i) => {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return i;
  });
  return comma === null ? argText : argText.slice(0, comma);
}

/** The effective `src/`-segment path literal fed to a read call's first
 *  argument, or null if none carries one. Handles both a bare literal
 *  (`readFileSync("src/foo.ts")`) and this repo's actual real-world idiom —
 *  `readFileSync(join(import.meta.dir, "../../src/foo.ts"), "utf8")` — by
 *  falling back to any string literal found inside the first argument's own
 *  expression text (so a `join(...)`/similar wrapper around the literal is
 *  still caught) when the first argument is not itself a bare literal. */
function pathLiteralOf(argText: string): string | null {
  const first = firstArgText(argText);
  const bare = first.match(/^\s*["'`]([^"'`]*)["'`]\s*$/);
  if (bare) return /\bsrc\//.test(bare[1]) ? bare[1] : null;
  const litRe = /["'`]([^"'`]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = litRe.exec(first))) {
    if (/\bsrc\//.test(m[1])) return m[1];
  }
  return null;
}

/** Derivation methods the captured-variable case follows past the directly
 *  captured variable, repo-idiom-driven: the exact four the board issue
 *  names (`.split`/`.indexOf`/`.slice`/`.match`), plus `.substring`/
 *  `.replace` (the same shape, reasonable string-derivation siblings) and
 *  `.map` — needed for the real `src.split(...).slice(...).map(...)` idiom
 *  (test/bun/wake-gate-wiring.test.ts), which slices each piece again
 *  inside the callback. Deliberately NOT broader than this: a method here
 *  only ever matters when chained directly off an already-tainted variable,
 *  so widening this list only risks following an unrelated derivation, not
 *  missing one of the detector's own false positives. */
const DERIVE_METHODS = ["split", "indexOf", "slice", "match", "substring", "replace", "map"];

/** Bounds the fixed-point propagation below. Five hops comfortably covers
 *  every real chain found in the repo (the deepest is two hops: raw text ->
 *  one `.indexOf`/`.slice`-derived body -> a second body sliced out of the
 *  first) with headroom to spare, while still keeping a single scan O(n). */
const MAX_DERIVE_HOPS = 5;

/** Starting from `seedVar` (the variable directly assigned the read call's
 *  result), follows simple derivation forward through the rest of the file
 *  (text at and after `fromIndex`, i.e. after the read call itself) to a
 *  fixed point: a `const`/`let`/`var X = ...;` statement taints `X` when its
 *  right-hand side is a call chained directly off an already-tainted
 *  variable through one of DERIVE_METHODS (e.g. `body.slice(...)` once
 *  `body` is tainted); a `for (const X of Y)` taints `X` when `Y` is tainted
 *  (the wake-gate-wiring idiom: `.map()`'s per-item pieces, iterated).
 *
 *  Same conservative, file-scoped (not block-scoped) limitation as the
 *  original single-variable scan: this is plain text-pattern matching, not
 *  real parsing, so a same-named variable in an unrelated scope could in
 *  principle be mistaken for a derived one. Accepted for the same reason the
 *  original single-hop scan accepted it — narrow and real-case-driven over
 *  broad and noisy. */
function deriveTaintedVars(text: string, seedVar: string, fromIndex: number): Set<string> {
  const tainted = new Set<string>([seedVar]);
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);/g;
  const forOfRe = /\bfor\s*\(\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
  const chainRe = new RegExp(`^\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:${DERIVE_METHODS.join("|")})\\s*\\(`);
  for (let hop = 0; hop < MAX_DERIVE_HOPS; hop++) {
    let addedAny = false;

    declRe.lastIndex = fromIndex;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(text))) {
      const [, varName, rhs] = m;
      if (tainted.has(varName)) continue;
      const chain = rhs.match(chainRe);
      if (chain && tainted.has(chain[1])) {
        tainted.add(varName);
        addedAny = true;
      }
    }

    forOfRe.lastIndex = fromIndex;
    while ((m = forOfRe.exec(text))) {
      const [, loopVar, iterVar] = m;
      if (tainted.has(loopVar)) continue;
      if (tainted.has(iterVar)) {
        tainted.add(loopVar);
        addedAny = true;
      }
    }

    if (!addedAny) break;
  }
  return tainted;
}

/** Detector 2: a `src/` file read as text, then string-matched instead of
 *  exercised — including through a simple derivation chain (board issue
 *  #174 part 2): capture -> `.split`/`.indexOf`/`.slice`/`.match`/
 *  `.substring`/`.replace`/`.map`, repeated up to a fixed point, -> assert.
 *  See the file header for the overall algorithm and its known, documented
 *  limitations (the whole-chain scan is file-scoped, not block-scoped). */
export function findSourceReading(text: string): Hit[] {
  const hits: Hit[] = [];
  const calls = [...findCalls(text, ["readFileSync", "readFile"]), ...findBunFileTextCalls(text)];
  for (const call of calls) {
    const pathLiteral = pathLiteralOf(call.argText);
    if (!pathLiteral) continue;

    // Easy, high-confidence case first: the call sits directly inside
    // expect(...), itself followed by .toContain(/.toMatch( — handled
    // before the variable-capture case, since it needs no lookahead at all.
    const before = text.slice(Math.max(0, call.start - 20), call.start);
    const afterWindow = text.slice(call.end + 1, call.end + 1 + 60);
    const inline = /expect\(\s*$/.test(before) && /^(?:\.toString\(\))?\)+\s*\.(?:toContain|toMatch)\(/.test(afterWindow);
    if (inline) {
      hits.push({ line: call.line, kind: "source-reading", detail: `${pathLiteral} read as text, then string-matched inline` });
      continue;
    }

    // Captured-variable case: const/let/plain assignment, then a forward
    // (file-scoped, not block-scoped — documented limitation) scan for a
    // substring-style assertion against that variable, or any variable
    // simply derived from it (deriveTaintedVars above).
    const beforeWindow = text.slice(Math.max(0, call.start - 80), call.start);
    const assignMatch = beforeWindow.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/)
      ?? beforeWindow.match(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/);
    if (!assignMatch) continue;
    const varName = assignMatch[1];
    const rest = text.slice(call.end + 1);
    const tainted = deriveTaintedVars(text, varName, call.end + 1);
    for (const candidate of tainted) {
      const esc = escapeRegex(candidate);
      const direct = new RegExp(`\\b${esc}\\s*\\.(?:toContain|toMatch|includes)\\(`);
      // `[^;]` (not `[\s\S]`), so the lookahead can't cross a statement
      // boundary into a DIFFERENT expect(...) call's own .toContain/.toMatch
      // — real when the tainted set has multiple candidates in play, e.g.
      // `expect(methodStart).toBeGreaterThan(-1); expect(method).toContain(
      // ...)` back to back (test/bun/archive-wiring.test.ts): without this,
      // the unrelated `method` match would misattribute to `methodStart`.
      const viaExpect = new RegExp(`expect\\(\\s*${esc}\\s*\\)[^;]{0,80}?\\.(?:toContain|toMatch)\\(`);
      if (direct.test(rest) || viaExpect.test(rest)) {
        const via = candidate === varName ? candidate : `${candidate} (derived from ${varName})`;
        hits.push({ line: call.line, kind: "source-reading", detail: `${pathLiteral} read as text, then string-matched via ${via}` });
        break;
      }
    }
  }
  return hits;
}

/** `Bun.file(path).text()` — a distinct chained-call shape from the plain
 *  `readFileSync`/`readFile` calls `findCalls` already handles. The
 *  `.text()` lookahead lives in the matcher's accept hook: a candidate
 *  without `.text()` within the 10 chars after its close paren is skipped
 *  (but still scanned past, via its own `end`), and a kept one's `end` is
 *  extended over the `.text()` suffix so the match covers the whole idiom. */
function findBunFileTextCalls(text: string): CallMatch[] {
  return scanCalls(text, {
    open: /\bBun\.file\(/g,
    name: () => "Bun.file",
    accept: (_m, bal) => {
      const after = text.slice(bal.endIndex + 1, bal.endIndex + 1 + 10);
      const textCall = after.match(/^\s*\.text\(\)/);
      if (!textCall) return null;
      return { end: bal.endIndex + 1 + textCall[0].length - 1 };
    },
  });
}

/** Detector 3: `vi.mock`/`jest.mock`/`mock.module` pointed at one of this
 *  repo's own `src/` modules, instead of a system boundary. */
export function findOwnModuleMocks(
  text: string,
  testDir: string,
  cache: Map<string, string | null> = new Map(),
): Hit[] {
  const hits: Hit[] = [];
  const re = /\b(?:vi\.mock|jest\.mock|mock\.module)\(\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue; // bare specifier — a system boundary, never flagged
    const line = lineOf(text, m.index);
    const resolved = resolveRelative(testDir, spec, cache);
    if (!resolved) continue;
    if (!/\/src\//.test(resolved.path.replace(/\\/g, "/"))) continue;
    hits.push({ line, kind: "own-module-mock", detail: `${spec} resolves into this repo's own src/` });
  }
  return hits;
}

export function formatFinding(path: string, hit: Hit): string {
  return `${path}:${hit.line}: [${hit.kind}] ${hit.detail}`;
}

/** All three detectors' hits for one test file, minus any line carrying the
 *  `test-lies-check: allow` escape. `path` is the file's path relative to
 *  `repoRoot` (used only to locate its directory for import resolution). */
export function scanFile(path: string, text: string, repoRoot: string = REPO_ROOT): Hit[] {
  const testDir = dirname(join(repoRoot, path));
  const cache = new Map<string, string | null>();
  const hits = [
    ...findTautologies(text, testDir, cache),
    ...findSourceReading(text),
    ...findOwnModuleMocks(text, testDir, cache),
  ];
  const lines = text.split("\n");
  return hits.filter((h) => !(lines[h.line - 1] ?? "").includes(ALLOW_ESCAPE));
}

function listTestFiles(root: string): string[] {
  const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (ls.exitCode !== 0) throw new Error(`git ls-files failed: ${ls.stderr.toString()}`);
  return ls.stdout.toString().split("\0").filter(Boolean).filter((p) => /\.test\.tsx?$/.test(p));
}

export async function scanRepo(root: string = REPO_ROOT): Promise<Finding[]> {
  const paths = listTestFiles(root).filter((p) => !(p in ALLOWLIST));
  const findings: Finding[] = [];
  for (const path of paths) {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) continue;
    const text = await file.text();
    for (const hit of scanFile(path, text, root)) findings.push({ path, ...hit });
  }
  return findings;
}

if (import.meta.main) {
  const findings = await scanRepo();
  const counts: Record<HitKind, number> = { tautological: 0, "source-reading": 0, "own-module-mock": 0 };
  for (const f of findings) {
    counts[f.kind]++;
    console.log(formatFinding(f.path, f));
  }
  const fileCount = listTestFiles(REPO_ROOT).filter((p) => !(p in ALLOWLIST)).length;
  console.log(
    `\ntest-lies-check: ${counts.tautological} tautological, ` +
    `${counts["source-reading"]} source-reading, ${counts["own-module-mock"]} own-module-mock ` +
    `across ${fileCount} test files`,
  );
  // Phase 2 (#174): report-only period is over — this is now a real failing gate.
  // Phase 1 (#164) left this at process.exit(0) regardless of findings while the
  // backlog of real findings was cleared; now that the count is 0, any new finding fails CI.
  process.exit(findings.length > 0 ? 1 : 0);
}
