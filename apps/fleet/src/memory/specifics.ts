// P5 spec §9's SECOND compaction rule, made checkable by diff.
//
//   "Numbers, names, commands, dates survive verbatim. Prose around them may
//    go. Same as caveman's own rule 6. What gets lost in a bad compaction is
//    almost always a specific — the exact flag, the exact path — dissolved
//    into a summary."
//
// This module is the mechanical half of that. It cannot judge whether a merged
// line SAYS the right thing; it can prove that every specific token the source
// lines carried still appears, character for character, in what replaces them.
// That is the whole point: judgment is the named risk in this design, so the
// part that can be measured is measured, and the Worker refuses a compaction
// that fails it before a human ever has to read the PR.
//
// Bias, deliberately: OVER-extract. A false positive costs one refused merge,
// which an agent fixes by putting the token back. A false negative costs the
// exact loss this whole feature exists to prevent.

// Each pattern names one kind of specific. Order matters only for readability;
// results are deduped and compared as a set.
const PATTERNS: RegExp[] = [
  // Commands and code, as written. `wrangler deploy --keep-vars` is ONE
  // specific, not three — a merge that keeps the words but reorders the flag
  // has still lost the command.
  /`[^`\n]+`/g,
  // Anything starting with a digit: 100, 21%, 2026-08-27, 1.20260310.1,
  // 41730. Trailing punctuation is stripped afterwards (see normalize), which
  // a closing \b could not do without also dropping a trailing `%`.
  /\b\d[\w.:%/-]*/g,
  // Flags, short and long. The lookbehind keeps `pre-existing` from reading as
  // a flag on the `-existing` half.
  /(?<![\w-])--?[A-Za-z][\w-]*/g,
  // Dotted / slashed / underscored identifiers and paths: do.ts,
  // src/studio/do.ts, rollout_step_percentage, fleet/memory.
  /\b[A-Za-z_][\w-]*(?:[._/][A-Za-z_][\w-]*)+\b/g,
  // Names shouted in caps: VERSION, HARVEST_NO_RECORD, AOV, DO.
  /\b[A-Z][A-Z0-9_]+\b/g,
  // Hex-ish tokens with at least one digit — commit shas, digests. Excludes
  // ordinary lowercase words, which never mix letters and digits.
  /\b(?=[a-f0-9]*\d)[a-f0-9]{7,}\b/g,
];

/**
 * Backticks are part of the match but not part of the specific — the command
 * inside them is what has to survive, in whatever markup the new line uses.
 * Sentence punctuation trailing a number is not part of it either: "measured
 * 2026-08-27." must yield the date, not the date plus a full stop that the
 * merged line has no reason to reproduce.
 */
function normalize(match: string): string {
  const inner = match.startsWith("`") && match.endsWith("`") ? match.slice(1, -1) : match;
  return inner.replace(/[.,:;/-]+$/, "");
}

/**
 * Every specific in `text`, deduped, in first-seen order. Ordinary prose
 * yields an empty list — see this module's header for why that matters: a
 * check that flags every word would refuse every merge and get switched off.
 */
export function extractSpecifics(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const s = normalize(m[0]);
      if (s === "" || seen.has(s)) continue;
      seen.add(s);
      found.push(s);
    }
  }
  return found;
}

/**
 * What a compaction would DESTROY: every specific present in `before` and
 * absent from `after`. Empty means the compaction kept them all, which is the
 * only shape compact.ts accepts.
 *
 * Containment is a literal, case-sensitive substring test against `after`'s
 * raw text — not a re-extraction — so a specific still counts as surviving
 * when the new line embeds it in different surrounding prose (which is exactly
 * what compaction is allowed to change). Case sensitivity is deliberate: `DO`
 * and `do` are different things in this codebase, and so are `Write` and
 * `write`.
 *
 * `before` may be several source lines joined by newlines; the union of their
 * specifics is what must survive into the one line that replaces them.
 */
export function missingSpecifics(before: string, after: string): string[] {
  return extractSpecifics(before).filter((s) => !after.includes(s));
}
