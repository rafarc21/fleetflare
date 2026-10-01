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
 * Phase 1 is report-only: `scanRepo()` runs, the CLI prints findings and
 * counts, and always exits 0 regardless of what it finds. Phase 2 (wiring
 * this in as a failing gate) is a separate, future piece of work — see
 * docs/plans/2026-10-01-test-lies-check-phase1.md.
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

/** True when `s` contains a comma outside any bracket/paren/brace/string —
 *  the shape a `export const A = 1, B = 2;` multi-declaration's captured
 *  value text would have. Used to skip that ambiguous case entirely. */
function hasTopLevelComma(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return true;
  }
  return false;
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
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { argText: text.slice(start, i), endIndex: i };
    }
  }
  return null;
}

interface CallMatch {
  name: string;
  argText: string;
  start: number;
  end: number; // index of the call's own closing ')'
  line: number;
}

/** Finds every call to one of `names` (word-boundary before the name),
 *  extracting its paren-depth-balanced argument text. */
function findCalls(text: string, names: string[]): CallMatch[] {
  const results: CallMatch[] = [];
  const re = new RegExp(`\\b(${names.map(escapeRegex).join("|")})\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const argStart = m.index + m[0].length;
    const bal = extractBalanced(text, argStart);
    if (!bal) continue;
    results.push({
      name: m[1],
      argText: bal.argText,
      start: m.index,
      end: bal.endIndex,
      line: text.slice(0, m.index).split("\n").length,
    });
    re.lastIndex = bal.endIndex + 1;
  }
  return results;
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
  const results: Array<{ line: number; ident: string; argText: string }> = [];
  const re = /\bexpect\(\s*([A-Za-z_$][\w$]*)\s*\)\.toBe\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const argStart = m.index + m[0].length;
    const bal = extractBalanced(text, argStart);
    if (!bal) continue;
    results.push({ line: text.slice(0, m.index).split("\n").length, ident: m[1], argText: bal.argText });
    re.lastIndex = bal.endIndex + 1;
  }
  return results;
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

/** Detector 2: a `src/` file read as text, then string-matched instead of
 *  exercised. See the file header for the algorithm and its known,
 *  documented limitation (the captured-variable scan is file-scoped). */
export function findSourceReading(text: string): Hit[] {
  const hits: Hit[] = [];
  const calls = [...findCalls(text, ["readFileSync", "readFile"]), ...findBunFileTextCalls(text)];
  for (const call of calls) {
    const litMatch = call.argText.match(/^\s*["'`]([^"'`]*)["'`]/);
    if (!litMatch || !/\bsrc\//.test(litMatch[1])) continue;
    const pathLiteral = litMatch[1];

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
    // substring-style assertion against that variable.
    const beforeWindow = text.slice(Math.max(0, call.start - 80), call.start);
    const assignMatch = beforeWindow.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/)
      ?? beforeWindow.match(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/);
    if (!assignMatch) continue;
    const varName = assignMatch[1];
    const esc = escapeRegex(varName);
    const rest = text.slice(call.end + 1);
    const direct = new RegExp(`\\b${esc}\\s*\\.(?:toContain|toMatch|includes)\\(`);
    const viaExpect = new RegExp(`expect\\(\\s*${esc}\\s*\\)[\\s\\S]{0,80}?\\.(?:toContain|toMatch)\\(`);
    if (direct.test(rest) || viaExpect.test(rest)) {
      hits.push({ line: call.line, kind: "source-reading", detail: `${pathLiteral} read as text, then string-matched via ${varName}` });
    }
  }
  return hits;
}

/** `Bun.file(path).text()` — a distinct chained-call shape from the plain
 *  `readFileSync`/`readFile` calls `findCalls` already handles. */
function findBunFileTextCalls(text: string): CallMatch[] {
  const results: CallMatch[] = [];
  const re = /\bBun\.file\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const argStart = m.index + m[0].length;
    const bal = extractBalanced(text, argStart);
    if (!bal) continue;
    const after = text.slice(bal.endIndex + 1, bal.endIndex + 1 + 10);
    const textCall = after.match(/^\s*\.text\(\)/);
    if (textCall) {
      results.push({
        name: "Bun.file",
        argText: bal.argText,
        start: m.index,
        end: bal.endIndex + 1 + textCall[0].length - 1,
        line: text.slice(0, m.index).split("\n").length,
      });
      re.lastIndex = bal.endIndex + 1 + textCall[0].length;
    } else {
      re.lastIndex = bal.endIndex + 1;
    }
  }
  return results;
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
    const line = text.slice(0, m.index).split("\n").length;
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
    `\ntest-lies-check (report-only): ${counts.tautological} tautological, ` +
    `${counts["source-reading"]} source-reading, ${counts["own-module-mock"]} own-module-mock ` +
    `across ${fileCount} test files`,
  );
  // Phase 1 (#164): report-only — never fails CI. Phase 2 wires this in as a failing gate.
  process.exit(0);
}
