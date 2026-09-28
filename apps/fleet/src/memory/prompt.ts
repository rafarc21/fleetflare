// The READ side. P5 §7: "Fleet memory — must be INJECTED at provision and
// REVIEWED in a PR. Git already does both." §9: the index is what always
// loads.
//
// Only the index. Not the files — that is the whole point of the three tiers:
// the index is flat-cost and always present, the files are a fetch away and
// cost nothing until one is actually relevant. A studio boots knowing WHAT the
// fleet learned and where each fact lives; it reads a fact only when it needs
// it.
//
// The files are on disk in the container: issue #341 moved memory to its own
// store (FLEET_OPS_REPO), which provision clones to MEMORY_CLONE_DIR by a Worker
// exec (provision.ts's refreshMemoryClone) -- no image change.

import { MEMORY_CLONE_DIR } from "./store";
import { parseMemoryIndex, MEMORY_DIR, MEMORY_INDEX_PATH, renderIndexLine } from "./index-file";

/**
 * Ceiling on how many index lines reach a system prompt. §9 sizes a healthy
 * index at ~60 lines and says "cost stays FLAT" — this is double that, so it
 * is a runaway guard, not a working limit.
 *
 * Over the cap the block TRUNCATES and says so, naming the file that holds the
 * rest. It does not silently drop the tail (a studio would believe it had the
 * whole index) and it does not refuse outright (no memory at all is worse than
 * most of it). A truncated index is also the signal that the compaction pass
 * is overdue.
 */
export const MEMORY_INDEX_MAX_LINES = 120;

/**
 * The injected block, or null when there is nothing worth injecting.
 *
 * Null on: an empty index, an index with no entries, and an index that fails
 * to parse. That last one matters — a malformed index is a repo-side authoring
 * bug, and pasting its raw text into a lead's system prompt would turn a bad
 * line into confusing instructions. Provisioning proceeds either way; memory
 * is never a reason a studio fails to come up.
 */
export function memoryIndexPrompt(indexMd: string): string | null {
  let entries;
  try {
    entries = parseMemoryIndex(indexMd).entries;
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const shown = entries.slice(0, MEMORY_INDEX_MAX_LINES);
  const lines = [
    "## Fleet memory (index)",
    "",
    "What this fleet has learned. One line per fact — this index is the ONLY",
    "memory you are given up front.",
    "",
    `Each line links a file under \`${MEMORY_DIR}/\` in the fleet's memory repo, already`,
    `cloned at \`${MEMORY_CLONE_DIR}\`. Read a file only when its line is relevant to`,
    "what you are doing; do not read them all.",
    "",
    `Facts demoted out of this index still exist under \`${MEMORY_DIR}/archive/\` and are`,
    "still greppable there. Nothing is ever deleted.",
    "",
    ...shown.map(renderIndexLine),
  ];
  if (entries.length > shown.length) {
    lines.push(
      "",
      `(truncated: ${entries.length - shown.length} more line(s) — read all of them in ` +
      `\`${MEMORY_CLONE_DIR}/${MEMORY_INDEX_PATH}\`)`,
    );
  }
  return lines.join("\n");
}
