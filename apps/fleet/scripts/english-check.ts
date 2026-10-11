#!/usr/bin/env bun
/**
 * Board issue #66: all repository content is English. This fails on new
 * Portuguese text in any git-tracked file, and names the file and line.
 *
 * The heuristic is deliberately small, because a noisy check gets disabled,
 * which is worse than no check. A line is flagged when it holds either:
 *   - a whole word from MARKERS — Portuguese words that are neither English
 *     words nor identifiers this repo uses (the list the audit for #66 ran
 *     on, minus the ones that collide: `ja`, `sao`, `uma`, `com`), or
 *   - a word carrying ã or õ, nasal vowels no English word or common
 *     loanword has (café, naïve, façade all pass).
 * Before matching, text is NFC-normalized and URLs are removed, and a "word"
 * includes `_` and `-`, so an identifier (`nunca_used`) or a slug
 * (`nao-sao`) never matches a marker. A path segment can: `src/nunca/x.ts`
 * is flagged — rename it, or use the escape below.
 *
 * Escape hatch for a single line (a proper noun such as a street or city
 * name): end it with `english-check: allow`. For a whole deliberate fixture,
 * use ALLOWLIST; for known lines in a file that must keep catching new ones,
 * LINE_ALLOWLIST.
 *
 * Run by its own workflow (.github/workflows/english-check.yml), by the
 * bun-test lane (test/bun/english-only.test.ts), or by hand:
 *   bun run scripts/english-check.ts
 */
import { join } from "node:path";
import { runRepoCheck, scanRepoFiles } from "./repo-check";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const MARKERS = new Set([
  "nao", "não", "entao", "então", "voce", "você", "tambem", "também",
  "porque", "ficheiro", "ficheiros", "contentor", "estudio", "estúdio",
  "janela", "veredicto", "nunca", "isso", "isto", "mudes", "toques", "obrigado",
  // #128 review: unaccented words with zero hits in English text of this repo.
  "que", "quando", "depois", "ainda", "aqui", "pelo", "pela", "cada", "proprio",
  "mexer", "acima", "tarefa", "sempre", "tudo", "mesmo", "precisa",
  // #66 follow-up: the Worker's close comment ("fechada por <sha> promovido a
  // <branch>") slipped past the list above.
  "fechada", "promovido",
]);

const ALLOW_ESCAPE = "english-check: allow";

/** Agent-written records: rewriting them changes evidence (#66), so never scanned. */
const EXCLUDED_PREFIXES = ["fleet/memory/", ".fleet/"];

/** The select predicate both the scanRepo export and the main wiring share:
 *  every tracked file except the excluded prefixes. */
const isScannable = (p: string): boolean => !EXCLUDED_PREFIXES.some((x) => p.startsWith(x));

/** Files that hold Portuguese on purpose. Each entry says why. */
export const ALLOWLIST: Record<string, string> = {
  "apps/fleet/scripts/english-check.ts": "the marker list itself is Portuguese by definition",
  "apps/fleet/test/bun/english-only.test.ts": "the check's own test needs Portuguese samples to prove it flags them",
  "apps/fleet/test/bun/repo-check-runner.test.ts": "pins english-check's CLI bytes with Portuguese samples it must flag",
  "apps/fleet/test/fixtures/rate-limit-panes.ts": "captured real tmux panes, verbatim; the failover tests need the exact bytes",
};

/**
 * Known Portuguese lines (trimmed, word for word) in a file that must keep
 * catching NEW ones. Each line leaves this list when its file is translated.
 */
export const LINE_ALLOWLIST: Record<string, { reason: string; lines: string[] }> = {
};

export interface Hit {
  line: number;
  marker: string;
  text: string;
}

export interface Finding extends Hit {
  path: string;
}

export function findPortuguese(text: string): Hit[] {
  const hits: Hit[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.includes(ALLOW_ESCAPE)) return;
    const words = raw.normalize("NFC").replace(/https?:\/\/\S+/g, " ").match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const marker = words.find((w) => MARKERS.has(w.toLowerCase()) || /[ãõ]/i.test(w));
    if (marker) hits.push({ line: i + 1, marker, text: raw.trim() });
  });
  return hits;
}

export function formatFinding(path: string, hit: Hit): string {
  return `${path}:${hit.line}: "${hit.marker}" — ${hit.text.slice(0, 120)}`;
}

/** findPortuguese, minus the file's LINE_ALLOWLIST entries. */
export function scanFile(path: string, text: string): Hit[] {
  const known = new Set(LINE_ALLOWLIST[path]?.lines ?? []);
  return findPortuguese(text).filter((h) => !known.has(h.text));
}

/** The findings only, no printing or exiting — the runner's own single
 *  listing + read pass (see ./repo-check.ts), kept exported because
 *  test/bun/english-only.test.ts imports it. */
export async function scanRepo(root = REPO_ROOT): Promise<Finding[]> {
  return (await scanRepoFiles(root, isScannable, scanFile, ALLOWLIST)).findings;
}

if (import.meta.main) {
  process.exit(await runRepoCheck({
    root: REPO_ROOT,
    select: isScannable,
    scanFile,
    allowlist: ALLOWLIST,
    format: formatFinding,
    stream: "stderr",
    failSummary: (findings) => `\n${findings.length} line(s) of Portuguese. Translate them, or allowlist a deliberate fixture in scripts/english-check.ts with its reason.`,
    cleanLine: () => "english-check: clean",
  }));
}
