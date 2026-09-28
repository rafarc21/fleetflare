/**
 * Issue #1: the public-repo leak gate. The fleet develops in a PUBLIC repo,
 * so private text (client names, operator ids) must be unable to leave a
 * studio. The terms live in a private denylist -- one extended regex per
 * line, matched case-insensitively -- at OPS_DENYLIST_PATH in the operator's
 * FLEET_OPS_REPO (src/ops-repo.ts). Never in this repo.
 *
 * Fail closed everywhere: no denylist, a malformed one, or a scanner error
 * all REFUSE the write. A hit names the pattern's INDEX, never the term, so
 * the refusal itself cannot leak.
 *
 * Two consumers:
 *   - the Worker (board writes): parseDenylist + scanText.
 *   - the container: the Worker writes denylistFileContent() to
 *     LEAK_DENYLIST_PATH, and leakScanScript() is installed at LEAK_SCAN_PATH
 *     for the git and gh wrappers to call.
 *
 * Imports nothing: reachable from the Worker and the bun:test lane alike.
 */

/** The denylist's path inside the operator's FLEET_OPS_REPO. */
export const OPS_DENYLIST_PATH = "public-denylist.txt";

/** Where the Worker writes the gate file inside a studio container. */
export const LEAK_DENYLIST_PATH = "/opt/fleet/denylist";

/** Where the container scanner is installed. */
export const LEAK_SCAN_PATH = "/usr/local/bin/fleet-leak-scan";

/** First line of the container gate file. "on" = patterns follow; "off" =
 *  gate disabled for this studio (its work repo is private), reason follows. */
export const LEAK_GATE_ON = "#fleet-leak-gate on";
export const LEAK_GATE_OFF = "#fleet-leak-gate off";

export const LEAK_HIT_PREFIX = "fleet: leak gate: text matches private denylist pattern";

export const LEAK_DENYLIST_MISSING =
  "fleet: leak gate: no denylist in this studio -- refusing every public write (fail closed). " +
  `Operator: add ${OPS_DENYLIST_PATH} to the FLEET_OPS_REPO repo and re-provision.`;

export const LEAK_SCAN_ERROR = "fleet: leak gate: scanner error -- refusing (fail closed)";

/** Lines of the ops-repo denylist, blank lines and CRs dropped. Throws on
 *  zero patterns (an empty list would pass everything) and on a pattern the
 *  two scanners read differently (see denylistDialectError). */
export function parseDenylist(text: string): string[] {
  const patterns = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
  if (patterns.length === 0) throw new Error(`${OPS_DENYLIST_PATH} has no patterns`);
  const bad = denylistDialectError(patterns);
  if (bad !== null) throw new DenylistDialectError(bad);
  return patterns;
}

/** parseDenylist's refusal of a non-portable pattern. Its message names the
 *  index only, so it is safe on a studio row. */
export class DenylistDialectError extends Error {
  constructor(index: number) {
    super(`${OPS_DENYLIST_PATH} pattern #${index} uses syntax grep -E and JS regex read differently`);
    this.name = "DenylistDialectError";
  }
}

/** Escapes both grep -E (GNU) and JS read the same way: a metachar made
 *  literal, a word/space class, a word boundary, a back-reference. */
const PORTABLE_ESCAPE = /[.[\](){}*+?^$|\\wWsSbB1-9]/;

/**
 * 1-based index of the first pattern whose syntax the Worker (JS RegExp) and
 * the container (grep -E) disagree on, else null. A disagreement fails OPEN
 * on one side: GNU grep reads `\d` as a literal d (a warning, exit 1 =
 * "clean") where JS reads a digit. Flagged: any escape outside
 * PORTABLE_ESCAPE (`\d \p \x \u \A \z \< \t` ...), `(?` (lookaround,
 * non-capture, flags), a lazy quantifier, and inside a bracket expression a
 * backslash or a POSIX `[: [. [=` class.
 */
export function denylistDialectError(patterns: string[]): number | null {
  for (let n = 0; n < patterns.length; n++) {
    if (!portable(patterns[n])) return n + 1;
  }
  return null;
}

function portable(p: string): boolean {
  let inBracket = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (inBracket) {
      if (c === "\\") return false;
      if (c === "[" && ":.=".includes(p[i + 1] ?? "")) return false;
      if (c === "]") inBracket = false;
      continue;
    }
    if (c === "\\") {
      if (!PORTABLE_ESCAPE.test(p[i + 1] ?? "")) return false;
      i++;
      continue;
    }
    if (c === "[") {
      inBracket = true;
      // A leading `^` and a leading `]` belong to the set, not its end.
      if (p[i + 1] === "^") i++;
      if (p[i + 1] === "]") i++;
      continue;
    }
    if (c === "(" && p[i + 1] === "?") return false;
    if ("*+?}".includes(c) && p[i + 1] === "?") return false;
  }
  return true;
}

/** 1-based indexes of every pattern that matches `text`. Throws on an
 *  invalid pattern: a scanner that cannot read its list must refuse. */
export function scanText(patterns: string[], text: string): number[] {
  const hits: number[] = [];
  patterns.forEach((p, i) => {
    // "m": `^`/`$` per line, as grep reads them.
    if (new RegExp(p, "im").test(text)) hits.push(i + 1);
  });
  return hits;
}

/** The refusal line for a set of hit indexes. Indexes only, never terms. */
export function leakHitMessage(hits: number[]): string {
  return `${LEAK_HIT_PREFIX} ${hits.map((n) => `#${n}`).join(", ")} -- refused (the term is never printed)`;
}

export type LeakGateFile = { patterns: string[] } | { off: string };

/** The container gate file the Worker writes to LEAK_DENYLIST_PATH. */
export function denylistFileContent(gate: LeakGateFile): string {
  if ("off" in gate) return `${LEAK_GATE_OFF} ${gate.off.replace(/\n/g, " ")}\n`;
  return `${LEAK_GATE_ON}\n${gate.patterns.join("\n")}\n`;
}

/**
 * The container scanner. Scans its file arguments, or stdin when none.
 * Exit 0 = clean (or gate off), 1 = hit (pattern indexes on stderr), 2 =
 * refused for any other reason: no gate file, a bad header, zero patterns,
 * an unreadable input, an invalid pattern. Callers refuse on ANY non-zero.
 *
 * One `grep -E -i` per pattern, so a hit maps to its index. grep's own exit 2
 * (bad regex, read error) is an error, never "no match". So is ANY stderr,
 * whatever the exit: GNU grep only WARNS on `\d` ("stray \\") and exits 1,
 * which would read as clean. The stderr is never echoed. `-a` treats binary
 * input as text so a NUL byte cannot hide a term.
 */
export function leakScanScript(denylistPath = LEAK_DENYLIST_PATH): string {
  return [
    `#!/bin/bash`,
    `# fleet: issue #1 leak gate scanner. Exit 0 clean, 1 hit, 2 refused.`,
    `list='${denylistPath}'`,
    `missing() { echo "${LEAK_DENYLIST_MISSING}" >&2; exit 2; }`,
    `err() { echo "${LEAK_SCAN_ERROR} ($1)" >&2; exit 2; }`,
    `[ -f "$list" ] && [ -r "$list" ] || missing`,
    `IFS= read -r header < "$list" || missing`,
    `case "$header" in`,
    // Drain stdin first: exiting unread SIGPIPEs the producer, and a caller
    // under pipefail then refuses (maestro review of PR #2, blocker 1).
    `  '${LEAK_GATE_OFF}'*) [ "$#" -gt 0 ] || cat > /dev/null; exit 0 ;;`,
    `  '${LEAK_GATE_ON}') ;;`,
    `  *) missing ;;`,
    `esac`,
    `tmp=$(mktemp) || err "mktemp"`,
    `trap 'rm -f "$tmp"' EXIT`,
    `if [ "$#" -gt 0 ]; then cat -- "$@" > "$tmp" || err "unreadable input"; else cat > "$tmp" || err "unreadable input"; fi`,
    `n=0; i=0; hits=''`,
    `while IFS= read -r p || [ -n "$p" ]; do`,
    `  i=$((i + 1))`,
    `  [ "$i" -eq 1 ] && continue`,
    `  p=\${p%$'\\r'}`,
    `  [ -n "\${p//[[:space:]]/}" ] || continue`,
    `  n=$((n + 1))`,
    `  gerr=$(grep -qEia -e "$p" -- "$tmp" 2>&1)`,
    `  rc=$?`,
    `  [ -z "$gerr" ] || err "pattern #$n unreadable"`,
    `  case $rc in`,
    `    0) hits="$hits #$n" ;;`,
    `    1) ;;`,
    `    *) err "pattern #$n unreadable" ;;`,
    `  esac`,
    `done < "$list"`,
    `[ "$n" -gt 0 ] || missing`,
    `if [ -n "$hits" ]; then`,
    `  echo "${LEAK_HIT_PREFIX}$(printf '%s' "$hits" | sed 's/ #/, #/g; s/^,//') -- refused (the term is never printed)" >&2`,
    `  exit 1`,
    `fi`,
    `exit 0`,
  ].join("\n") + "\n";
}
