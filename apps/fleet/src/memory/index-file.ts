// Fleet memory, tier 1: the INDEX. P5 spec §9.
//
// Three tiers, and only the first costs tokens:
//
//   index         always loaded, one line per fact     cost stays FLAT
//   memory files  full detail, fetched when relevant   free until needed
//   archive/      demoted, unindexed                   still greppable, in git
//
// THE RULE this whole module exists to keep: compaction changes what is
// LOADED, never what EXISTS. the operator's real loss came from a compaction that
// DELETED its source. Fleet memory lives in git, so nothing ever has to be
// deleted — an index line can be merged away and a file can be demoted into
// archive/, and both remain reachable at the same commit.
//
// Everything here is pure text: no fetch, no env, no Worker. The GitHub side
// lives in compact.ts and routes.ts.

/** Where harvestLearnings (src/studio/do.ts) already writes, verbatim —
 *  `fleet/memory/<studio>/<stamp>-<i>-<slug>.md`. This module reads that same
 *  tree; the two must never drift apart. */
export const MEMORY_DIR = "fleet/memory";

/** Tier 1. The ONE file a studio loads at provision (src/studio/provision.ts).
 *  Generated: the Worker is its single writer, same discipline the board keeps
 *  for task state — which is why renderMemoryIndex below always writes the
 *  canonical preamble rather than preserving whatever prose it parsed. */
export const MEMORY_INDEX_PATH = `${MEMORY_DIR}/INDEX.md`;

/** Tier 3. Demoted files land here and DROP their index line. "Lost" becomes
 *  "not loaded by default", which is recoverable by grep at any commit;
 *  deletion is not, so nothing in this module ever deletes a memory file —
 *  it only ever moves one. */
export const MEMORY_ARCHIVE_DIR = `${MEMORY_DIR}/archive`;

/**
 * One index line. `target` is relative to `fleet/memory/` so a line reads the
 * same from the index file itself and from a studio's injected copy.
 *
 * `archived` is the merge citation — spec §9's own example:
 *   `- [CF container rollout](cloudflare-container-image-rollout.md, +2 archived) — ...`
 * It is what makes a merged line honest: the surviving line names ONE file,
 * and the count says how many more went into archive/ behind it. A reader who
 * needs the other two greps archive/ and finds them, unmodified.
 */
export interface IndexEntry {
  title: string;
  target: string;
  archived: number;
  summary: string;
}

// `— ` (em dash), the separator the operator's own memory index already uses. Written
// once here, read back by the same regex, so the format cannot drift between
// the writer and the reader.
const ENTRY_RE = /^- \[([^\]]+)\]\(([^),]+)(?:, \+(\d+) archived)?\)(?: — (.*))?$/;

/** True for a line that CLAIMS to be an entry, whether or not it parses. A
 *  bullet that starts like an entry and fails to parse is an error, never a
 *  silently dropped fact — a swallowed line is exactly the loss this module
 *  exists to prevent. */
function looksLikeEntry(line: string): boolean {
  return line.startsWith("- [");
}

export function parseMemoryIndex(md: string): { entries: IndexEntry[] } {
  const entries: IndexEntry[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!looksLikeEntry(line)) continue;
    const m = ENTRY_RE.exec(line);
    if (!m) throw new Error(`memory index line ${i + 1} is not a valid entry: ${JSON.stringify(line)}`);
    entries.push({
      title: m[1],
      target: m[2],
      archived: m[3] === undefined ? 0 : Number(m[3]),
      summary: m[4] ?? "",
    });
  }
  return { entries };
}

export function renderIndexLine(e: IndexEntry): string {
  const cite = e.archived > 0 ? `, +${e.archived} archived` : "";
  return `- [${e.title}](${e.target}${cite})${e.summary ? ` — ${e.summary}` : ""}`;
}

/**
 * The whole file. The preamble is fixed text, not something parsed and
 * carried forward: this file is generated, and a preamble an agent could edit
 * is a second place the rules could be stated wrong. It tells a reader the two
 * things a cheap index must say — the detail is a fetch away, and a demoted
 * fact is still in the repo.
 */
export function renderMemoryIndex(entries: IndexEntry[]): string {
  return [
    "# Fleet memory index",
    "",
    "One line per fact. This index is the ONLY memory tier loaded by default.",
    `Full detail lives in the linked file under \`${MEMORY_DIR}/\` — fetch one only`,
    "when its line is relevant to what you are doing.",
    "",
    `A \`+N archived\` citation means N more sources were merged into that line;`,
    `they were MOVED to \`${MEMORY_ARCHIVE_DIR}/\`, never deleted. Anything demoted out`,
    "of this index is still in git and still greppable there.",
    "",
    ...entries.map(renderIndexLine),
    "",
  ].join("\n");
}

/**
 * Where a demoted file goes. The studio subdirectory is preserved, so an
 * archived fact is still traceable to the studio that learned it — the same
 * `<studio>/` grouping harvestLearnings writes in the first place.
 *
 * Throws rather than returning something odd for the two paths that must never
 * reach it: a file already under archive/ (demotion is one-way; re-nesting
 * would make the original unfindable at the path the index once cited) and a
 * file outside fleet/memory/ entirely (this function must not be usable to
 * move arbitrary repo files into a memory archive).
 */
export function archivePathFor(path: string): string {
  if (path.startsWith(`${MEMORY_ARCHIVE_DIR}/`)) {
    throw new Error(`${path} is already archived`);
  }
  if (!path.startsWith(`${MEMORY_DIR}/`)) {
    throw new Error(`${path} is not under ${MEMORY_DIR}/ and cannot be archived as memory`);
  }
  return `${MEMORY_ARCHIVE_DIR}/${path.slice(MEMORY_DIR.length + 1)}`;
}

// harvestLearnings names a file `<stamp>-<i>-<slug>.md` where stamp is
// `now.toISOString().replace(/[:.]/g, "-")` — so `2026-08-27T17:50:08.684Z`
// is written `2026-08-27T17-50-08-684Z`. Read back by reversing exactly that
// substitution, nothing looser: a hand-written memory file has no date at all
// and must read as null rather than as "today" or "the epoch".
const HARVEST_STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/;

/**
 * When a memory file was harvested, from its own name. Null for anything not
 * written by harvestLearnings.
 *
 * Null is load-bearing downstream: age is one of the two mechanical conditions
 * for demotion (spec §9: "0 tasks, 2 sprints old"), and a file whose age
 * cannot be MEASURED is never auto-demoted. Judgment is the risk this design
 * names; a guessed date would be judgment wearing a number's clothes.
 */
export function harvestDateOf(fileName: string): Date | null {
  const m = HARVEST_STAMP_RE.exec(fileName);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `fleet/memory/websites--pilot/x.md` -> `websites--pilot/x.md`. */
export function targetFor(path: string): string {
  return path.startsWith(`${MEMORY_DIR}/`) ? path.slice(MEMORY_DIR.length + 1) : path;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function frontmatterField(fm: string, field: string): string | null {
  const m = new RegExp(`^${field}:\\s*(.*)$`, "m").exec(fm);
  if (!m) return null;
  const raw = m[1].trim();
  const unquoted = /^"([\s\S]*)"$/.exec(raw);
  return unquoted ? unquoted[1].replace(/\\"/g, '"') : raw;
}

/**
 * One memory file -> one index line, MECHANICALLY. This is what bootstraps an
 * index over a memory tree that has none, and it deliberately takes no
 * judgment: `name`/`description` are the frontmatter fields harvestLearnings
 * already writes, so the first index over a harvested tree is a pure
 * restatement of what is on disk. Nothing here summarizes; the only thing
 * that ever merges lines is a proposal a human can reject (compact.ts).
 */
export function indexEntryFromFile(path: string, content: string): IndexEntry {
  const fm = FRONTMATTER_RE.exec(content);
  const body = fm ? content.slice(fm[0].length) : content;
  const fallbackTitle = path.split("/").pop()!.replace(/\.md$/, "");
  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return {
    title: (fm && frontmatterField(fm[1], "name")) || fallbackTitle,
    target: targetFor(path),
    archived: 0,
    summary: (fm && frontmatterField(fm[1], "description")) || firstLine,
  };
}
