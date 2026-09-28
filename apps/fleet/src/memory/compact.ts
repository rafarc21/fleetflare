// The compaction pass. P5 spec §9, and the named risk it carries:
//
//   "An agent decides what to demote. That is judgment, and judgment is where
//    the original loss came from. Mitigations, all three required:
//      - demotion is archival, never deletion
//      - compaction lands as a PR the operator can reject
//      - the specifics rule is checkable by diff"
//
// All three are here. This module is PURE — survey in, plan out, no fetch, no
// env — which is what lets every refusal below be a unit test rather than a
// live incident. routes.ts does the I/O; github/api.ts turns a plan into one
// branch, one commit and one pull request.
//
// The division of labour is the same single-writer rule the board already
// keeps: the AGENT decides what to merge, demote and promote (that is
// judgment, and it needs the context an agent has); the WORKER decides whether
// the proposal is allowed (that is measurement, and it must not be
// negotiable). An agent cannot talk this file out of a threshold.

import {
  MEMORY_DIR, MEMORY_INDEX_PATH, archivePathFor, harvestDateOf,
  indexEntryFromFile, parseMemoryIndex, renderMemoryIndex, targetFor,
  type IndexEntry,
} from "./index-file";
import { missingSpecifics } from "./specifics";

/** Two days — the same sprint length board/types.ts's BACKLOG_STALE_MS is
 *  reasoned against ("longer than the two-day sprint a task could plausibly be
 *  waiting out"). One number, one meaning, two files. */
export const SPRINT_MS = 2 * 24 * 60 * 60 * 1000;

/** §9's "0 tasks, 2 sprints old" made arithmetic. Below this age a file with
 *  no citations is HOLD, not demote: a fact harvested yesterday has not been
 *  neglected, it has not been given a chance yet. */
export const DEMOTION_MIN_AGE_MS = 2 * SPRINT_MS;

/** §9's "3+ tasks -> promote to a SKILL". */
export const PROMOTION_CITATIONS = 3;

/** One memory file as it exists in the blueprint repo. */
export interface MemorySource {
  /** Repo path, e.g. `fleet/memory/websites--pilot/2026-…-0-slug.md`. */
  path: string;
  content: string;
}

/** One task's text, for citation counting. `number` is the issue number, so
 *  three mentions in ONE task cannot masquerade as three tasks. */
export interface TaskCitation {
  number: number;
  text: string;
}

export type Verdict = "promote" | "keep" | "demote" | "hold";

export interface MemoryFileMeta {
  /** Path relative to `fleet/memory/` — what an index line's target is. */
  target: string;
  path: string;
  citations: number;
  /** Null when the filename carries no harvest timestamp (a hand-written
   *  memory file). Such a file is never auto-demoted — see demotionVerdict. */
  ageMs: number | null;
  indexed: boolean;
  verdict: Verdict;
}

export interface MemorySurvey {
  /** The EFFECTIVE index: existing lines, plus a mechanically bootstrapped
   *  line for every memory file that has none. */
  entries: IndexEntry[];
  files: MemoryFileMeta[];
  /** Targets that had no index line before this pass. */
  unindexed: string[];
  candidates: { promote: string[]; keep: string[]; demote: string[]; hold: string[] };
  /** target -> file content, so planCompaction can move a file into archive/
   *  without a second read. */
  contents: Record<string, string>;
}

/**
 * How many DISTINCT tasks cite each memory file.
 *
 * A citation is the file's own basename appearing in a task's text — the
 * board's issue bodies and envelope comments (§9's "cited by N tasks"). The
 * basename is what an agent writes when it says where a fact came from, and a
 * harvested name carries its own timestamp, so it is distinctive enough to
 * match on. `.md` optional, since both spellings are natural in prose.
 *
 * Over-counting is the safer error in one direction and not the other:
 * it BLOCKS a demotion (good — a file that might be in use stays indexed) but
 * it also ENABLES a promotion, which archives the sources. That second path is
 * still archival, still lands in a rejectable PR, and still has to pass the
 * specifics check, so no fact can be lost by it.
 */
export function countCitations(tasks: TaskCitation[], targets: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const target of targets) {
    const base = target.split("/").pop()!.replace(/\.md$/, "");
    const seen = new Set<number>();
    for (const task of tasks) if (task.text.includes(base)) seen.add(task.number);
    counts[target] = seen.size;
  }
  return counts;
}

/**
 * §9's promotion-or-death table, evaluated mechanically. This is the whole
 * guard against the risk the spec names: an agent may PROPOSE anything, but
 * the outcome a file qualifies for is arithmetic on two measured numbers.
 *
 * `hold` is the fourth outcome the table does not spell out and needs: zero
 * citations but not yet old enough. Silence about a young file is not evidence
 * of anything.
 */
export function demotionVerdict(citations: number, ageMs: number | null): Verdict {
  if (citations >= PROMOTION_CITATIONS) return "promote";
  if (citations > 0) return "keep";
  if (ageMs === null || ageMs < DEMOTION_MIN_AGE_MS) return "hold";
  return "demote";
}

/** archive/ is tier 3 and deliberately invisible to this pass: a demoted file
 *  must never be re-surveyed, re-indexed, or demoted a second time. */
function isArchived(path: string): boolean {
  return path.startsWith(`${MEMORY_DIR}/archive/`);
}

/**
 * What the memory tree looks like right now, measured. The GET side of the
 * pass — this is what an agent reads before it proposes anything.
 *
 * An existing index line is kept VERBATIM rather than regenerated from
 * frontmatter: a human may have written it, and rewriting a human's line from
 * a machine-truncated `description` would be a silent compaction nobody asked
 * for. Only a file with NO line gets one bootstrapped (indexEntryFromFile,
 * pure restatement of what is on disk).
 *
 * Index lines whose target is not a memory file (a promoted skill's line from
 * a previous pass, a hand-written line) are preserved untouched. Nothing here
 * removes a line it did not understand.
 */
export function surveyMemory(
  indexMd: string, sources: MemorySource[], tasks: TaskCitation[], now: Date,
): MemorySurvey {
  const live = sources.filter((s) => !isArchived(s.path) && s.path !== MEMORY_INDEX_PATH);
  const contents: Record<string, string> = {};
  for (const s of live) contents[targetFor(s.path)] = s.content;

  const existing = parseMemoryIndex(indexMd).entries;
  const indexedTargets = new Set(existing.map((e) => e.target));

  const unindexed: string[] = [];
  const entries: IndexEntry[] = [...existing];
  for (const s of live) {
    const target = targetFor(s.path);
    if (indexedTargets.has(target)) continue;
    unindexed.push(target);
    entries.push(indexEntryFromFile(s.path, s.content));
  }

  const targets = live.map((s) => targetFor(s.path));
  const counts = countCitations(tasks, targets);
  const candidates: MemorySurvey["candidates"] = { promote: [], keep: [], demote: [], hold: [] };
  const files: MemoryFileMeta[] = live.map((s) => {
    const target = targetFor(s.path);
    const harvested = harvestDateOf(target.split("/").pop()!);
    const ageMs = harvested === null ? null : now.getTime() - harvested.getTime();
    const verdict = demotionVerdict(counts[target], ageMs);
    candidates[verdict].push(target);
    return { target, path: s.path, citations: counts[target], ageMs, indexed: indexedTargets.has(target), verdict };
  });

  return { entries, files, unindexed, candidates, contents };
}

/** Merge several index LINES into one. Never merges files. `sources[0]` keeps
 *  its file in place and becomes the surviving line's target; the rest move to
 *  archive/ and are cited by the `+N archived` count. */
export interface MergeOp {
  title: string;
  summary: string;
  sources: string[];
}

/** §9's promotion: "memories collapse into it, originals archived". The skill
 *  body travels IN the proposal so the PR is self-contained — a line citing a
 *  skill that does not exist yet would be exactly the dangling reference this
 *  design refuses to create. */
export interface PromoteOp {
  /** Repo path under `skills/`. */
  path: string;
  title: string;
  summary: string;
  content: string;
  sources: string[];
}

export interface CompactionProposal {
  merges?: MergeOp[];
  demote?: string[];
  promote?: PromoteOp[];
}

/** One file write, or — for a source being MOVED into archive/ — the delete
 *  half of that move. `content: null` never appears without a matching create
 *  at the archive path; planCompaction is the only thing that builds these. */
export interface FileChange {
  path: string;
  content: string | null;
}

export interface CompactionPlan {
  branch: string;
  title: string;
  body: string;
  changes: FileChange[];
  summary: { merged: number; demoted: number; promoted: number; archived: number; indexLines: number };
}

export type PlanResult =
  | { ok: true; plan: CompactionPlan }
  | { ok: false; status: number; message: string };

function refuse(message: string): PlanResult {
  return { ok: false, status: 400, message };
}

/**
 * The text a merge or promotion must not destroy: the source line's SUMMARY.
 * The file itself is never at risk — it is moved, not rewritten — so the
 * summary is exactly where a specific can be dissolved into prose.
 *
 * The title is deliberately NOT checked. A bootstrapped title is the harvest
 * FILENAME (`2026-08-27T17-50-08-684Z-0-cf-rollout`), which extractSpecifics
 * reads — correctly — as a date and a path; demanding it verbatim inside a
 * merged line would refuse every merge there is. A filename is preserved by
 * the archive path it moves to, not by the sentence that replaces its line.
 */
function sourceText(entries: Map<string, IndexEntry>, target: string): string {
  return entries.get(target)?.summary ?? "";
}

function days(ms: number): string {
  return `${Math.floor(ms / (24 * 60 * 60 * 1000))} day(s)`;
}

/**
 * Validate a proposal against the measurements, then build the branch, the
 * file changes and the PR text. Every failure is a 400 naming the file and the
 * number that failed — an agent must be able to fix its own proposal from the
 * message without guessing.
 *
 * The order of checks is deliberate: existence, then double-use, then the
 * per-operation thresholds, then the specifics rule LAST. Specifics is the one
 * a well-meaning agent will hit most often, and it reads best when everything
 * cheaper has already passed.
 *
 * An empty proposal is legal and is the expected FIRST run: it rewrites
 * INDEX.md from the survey and touches nothing else. That is how a memory tree
 * that has never been indexed gets an index, with no judgment involved at all.
 */
export function planCompaction(
  survey: MemorySurvey, proposal: CompactionProposal, now: Date,
): PlanResult {
  const merges = proposal.merges ?? [];
  const demote = proposal.demote ?? [];
  const promote = proposal.promote ?? [];

  const byTarget = new Map(survey.files.map((f) => [f.target, f]));
  const entryByTarget = new Map(survey.entries.map((e) => [e.target, e]));

  // 1. Every named source must be a live memory file.
  const named: string[] = [
    ...merges.flatMap((m) => m.sources), ...demote, ...promote.flatMap((p) => p.sources),
  ];
  for (const target of named) {
    if (!byTarget.has(target)) {
      return refuse(`${target} is not a memory file under ${MEMORY_DIR}/ — nothing to compact`);
    }
  }

  // 2. One outcome per file. A file merged AND demoted has two futures.
  const seen = new Set<string>();
  for (const target of named) {
    if (seen.has(target)) return refuse(`${target} appears in more than one operation — a file gets one outcome, not twice`);
    seen.add(target);
  }

  // 3. Thresholds. Judgment proposes; arithmetic decides.
  for (const target of demote) {
    const f = byTarget.get(target)!;
    if (f.citations > 0) {
      return refuse(`${target} is cited by ${f.citations} task(s) — only an uncited file is demoted (§9)`);
    }
    if (f.ageMs === null) {
      return refuse(`${target} carries no harvest timestamp, so its age cannot be measured — it is never auto-demoted`);
    }
    if (f.ageMs < DEMOTION_MIN_AGE_MS) {
      return refuse(`${target} is ${days(f.ageMs)} old — demotion needs two sprints (${days(DEMOTION_MIN_AGE_MS)}) of silence`);
    }
  }
  for (const p of promote) {
    if (!p.path.startsWith("skills/")) {
      return refuse(`${p.path} is not under skills/ — a promotion writes a skill and nothing else`);
    }
    if (p.content.trim() === "") return refuse(`${p.path} has no content — a promotion may not create an empty skill`);
    if (p.sources.length === 0) return refuse(`${p.path} promotes no memory file — nothing to collapse`);
    for (const target of p.sources) {
      const f = byTarget.get(target)!;
      if (f.citations < PROMOTION_CITATIONS) {
        return refuse(
          `${target} is cited by ${f.citations} task(s); promotion to a skill needs ${PROMOTION_CITATIONS}+ (§9)`,
        );
      }
    }
  }
  for (const m of merges) {
    if (m.sources.length < 2) {
      return refuse(`a merge needs two or more sources; ${JSON.stringify(m.title)} names ${m.sources.length}`);
    }
    if (m.summary.trim() === "") return refuse(`merge ${JSON.stringify(m.title)} has an empty summary`);
  }

  // 4. The specifics rule, checkable by diff (§9). Every number, command,
  //    date and path the source LINES carried must survive verbatim into what
  //    replaces them. This is the check that makes "compaction keeps
  //    specifics" enforceable rather than aspirational.
  for (const m of merges) {
    const before = m.sources.map((t) => sourceText(entryByTarget, t)).join("\n");
    const lost = missingSpecifics(before, `${m.title} ${m.summary}`);
    if (lost.length > 0) {
      return refuse(
        `merge ${JSON.stringify(m.title)} would destroy ${lost.length} specific(s): ${lost.join(", ")} — ` +
        "compaction keeps numbers, names, commands and dates verbatim (§9)",
      );
    }
  }
  for (const p of promote) {
    const before = p.sources.map((t) => sourceText(entryByTarget, t)).join("\n");
    const lost = missingSpecifics(before, `${p.title} ${p.summary}\n${p.content}`);
    if (lost.length > 0) {
      return refuse(
        `skill ${p.path} would destroy ${lost.length} specific(s): ${lost.join(", ")} — ` +
        "a promotion carries every specific its memories carried (§9)",
      );
    }
  }

  // --- build ---------------------------------------------------------------

  // Replacement lines take the POSITION of their first source, so the diff a
  // reviewer reads is local instead of a wholesale reshuffle.
  const replacement = new Map<string, IndexEntry>();
  const dropped = new Set<string>();
  const archived: string[] = [];

  for (const m of merges) {
    const [head, ...rest] = m.sources;
    replacement.set(head, { title: m.title, target: head, archived: rest.length, summary: m.summary });
    for (const t of rest) { dropped.add(t); archived.push(t); }
  }
  for (const p of promote) {
    const [head, ...rest] = p.sources;
    // `../../` walks out of fleet/memory/ — index targets are relative to that
    // directory, and a promoted skill lives outside it.
    replacement.set(head, {
      title: p.title, target: `../../${p.path}`, archived: p.sources.length, summary: p.summary,
    });
    archived.push(head, ...rest);
    for (const t of rest) dropped.add(t);
  }
  for (const t of demote) { dropped.add(t); archived.push(t); }

  const nextEntries: IndexEntry[] = [];
  for (const e of survey.entries) {
    if (dropped.has(e.target)) continue;
    nextEntries.push(replacement.get(e.target) ?? e);
  }

  const changes: FileChange[] = [{ path: MEMORY_INDEX_PATH, content: renderMemoryIndex(nextEntries) }];
  for (const p of promote) changes.push({ path: p.path, content: p.content });
  for (const target of archived) {
    const path = `${MEMORY_DIR}/${target}`;
    // Move, in two halves of one commit: the archive copy is written FIRST in
    // the change list, so a reviewer reading the diff sees the file arrive
    // before it sees it leave. Nothing here deletes a fact — the bytes are
    // identical at the new path and the old one is still in every earlier
    // commit.
    changes.push({ path: archivePathFor(path), content: survey.contents[target] });
    changes.push({ path, content: null });
  }

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const summary = {
    merged: merges.length, demoted: demote.length, promoted: promote.length,
    archived: archived.length, indexLines: nextEntries.length,
  };

  return {
    ok: true,
    plan: {
      branch: `fleet/memory-compaction-${stamp}`,
      title: `fleet: compact memory index (${summary.indexLines} lines)`,
      body: compactionBody(summary, merges, demote, promote),
      changes,
      summary,
    },
  };
}

/**
 * The PR body. Caveman-compressed, and written so a reviewer can check the
 * claim rather than trust it: it states the rule, then lists every file that
 * moved and where it went. Rejecting the PR costs nothing — that sentence is
 * in the body on purpose, because the mitigation only works if the reviewer
 * knows rejection is free.
 */
function compactionBody(
  summary: CompactionPlan["summary"], merges: MergeOp[], demote: string[], promote: PromoteOp[],
): string {
  const lines: string[] = [
    "Memory compaction. Index lines change. Memory files do not.",
    "",
    `Merged ${summary.merged} line(s). Demoted ${summary.demoted} file(s). Promoted ${summary.promoted} skill(s).`,
    `${summary.archived} file(s) MOVED to \`${MEMORY_DIR}/archive/\`. Nothing deleted.`,
    `Index now ${summary.indexLines} line(s) — the only tier a studio loads.`,
    "",
    "Specifics check PASSED. Every number, name, command, date and path from",
    "the source lines survives verbatim in what replaces them. Enforced by diff,",
    "not by review (src/memory/specifics.ts).",
    "",
    "Reject and nothing is lost. Every archived file is still in git, still",
    "greppable under archive/, byte-identical.",
  ];
  if (merges.length > 0) {
    lines.push("", "## Merged");
    for (const m of merges) lines.push(`- ${m.title} <- ${m.sources.join(", ")}`);
  }
  if (promote.length > 0) {
    lines.push("", "## Promoted to skills");
    for (const p of promote) lines.push(`- ${p.path} <- ${p.sources.join(", ")}`);
  }
  if (demote.length > 0) {
    lines.push("", "## Demoted to archive/");
    for (const t of demote) lines.push(`- ${t}`);
  }
  return lines.join("\n");
}
