// Board issue #112 / #70 ask 8: "Two coordinators overlapped on the same
// helper script (two PRs fixing one thing, one wasted). Ask: `task new`
// warns when the brief's paths overlap files touched by open PRs / open
// tasks (a lightweight path-claim check)." Pure, no I/O — same style as
// brief.ts's own header — so the extraction/overlap/formatting rules below
// are unit-tested directly, and board.ts's createTask supplies the I/O
// (open PR files, open task bodies) from GitHub.
//
// "Lightweight" is the ask's own word, twice, and it shapes both halves of
// this file differently:
//
//   - extractPaths errs toward MATCHING. A false positive costs one warning
//     line a human reads and ignores; a false negative silently misses the
//     whole point of the ask (the overlap that mattered goes unreported).
//     So the regex below is loose on purpose — no attempt to validate that
//     a token is a REAL path in the repo, just that it LOOKS like one.
//
//   - findPathOverlaps is exact-string only, no fuzzy/prefix matching. A
//     prefix match ("does `apps/fleet/src` claim `apps/fleet/src/board/
//     board.ts`?") needs a real path-containment model this lightweight
//     check has no business building — and a false positive here is a
//     WARNING wrongly shown, the opposite direction from extractPaths, so
//     staying exact keeps that side's error rate low without new machinery.

/**
 * Path-looking tokens in free text: at least one `/`, each segment made of
 * letters/digits/`._-`. Deduped, order of first appearance.
 *
 * Trailing punctuation a human would type around a path in prose — a
 * sentence-ending `.`, a closing `)` or `]` — is stripped from each match's
 * ends; internal punctuation (a file extension's own `.`) is untouched.
 */
const PATH_CANDIDATE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g;
const TRIM_EDGES = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g;

export function extractPaths(text: string): string[] {
  const raw = text.match(PATH_CANDIDATE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw) {
    const trimmed = m.replace(TRIM_EDGES, "");
    if (trimmed === "" || !trimmed.includes("/") || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** One path the brief named that something else already claims, and who. */
export interface PathOverlap {
  path: string;
  prs: number[];
  tasks: number[];
}

/**
 * Which of `briefPaths` also appear — EXACT string match, see this file's
 * header — in an open PR's changed files or another open task's own claimed
 * paths. Paths with no overlap at all are left out entirely; a caller wants
 * only the ones worth a warning line.
 */
export function findPathOverlaps(
  briefPaths: string[],
  prClaims: { number: number; files: string[] }[],
  taskClaims: { number: number; paths: string[] }[],
): PathOverlap[] {
  const out: PathOverlap[] = [];
  for (const path of briefPaths) {
    const prs = prClaims.filter((pr) => pr.files.includes(path)).map((pr) => pr.number);
    const tasks = taskClaims.filter((t) => t.paths.includes(path)).map((t) => t.number);
    if (prs.length > 0 || tasks.length > 0) out.push({ path, prs, tasks });
  }
  return out;
}

/** One human-readable line per overlap, naming every PR/task that also
 *  touches it — the string createTask attaches to `pathWarnings` and the
 *  CLI prints verbatim. */
export function formatPathOverlapWarnings(overlaps: PathOverlap[]): string[] {
  return overlaps.map((o) => {
    const parts: string[] = [];
    if (o.prs.length > 0) parts.push(`PR ${o.prs.map((n) => `#${n}`).join(", ")}`);
    if (o.tasks.length > 0) parts.push(`task ${o.tasks.map((n) => `#${n}`).join(", ")}`);
    return `path claim overlap: ${o.path} also touched by ${parts.join(" and ")}`;
  });
}
