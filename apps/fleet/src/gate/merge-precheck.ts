// The precheck decision core for #1169: closing keyword + denylist leak scan,
// pure over inputs so bun test proves every rule. Fail closed: no denylist or
// a scanner error refuses, never passes (leak-gate.ts's own rule).
import { scanText, leakHitMessage } from "../leak-gate";

/** #1169: any closing keyword at all in a PR's title or body makes the merge
 *  precheck red. Deliberately cruder than promote-close.ts's CLOSING_KEYWORD
 *  (that one asks "does it close issue N"; this one asks "is arming --auto
 *  safe"), per the task's own pattern. */
export const CLOSING_KEYWORD_RE = /(^|[^a-z])(close[sd]?|fix(es|ed)?|resolve[sd]?) #[0-9]/gim;

export const CLOSING_KEYWORD_FAILURE = "closing keyword in PR title or body";
export const DENYLIST_UNAVAILABLE = "gate precheck: denylist unavailable";
export const LEAK_SCAN_ERROR = "gate precheck: leak scan error";
export const COMPARE_TRUNCATED_FAILURE = "gate precheck: compare truncated, cannot scan full diff";

/** #1169: a compare whose file or commit list was cut short cannot be trusted
 *  as a full leak scan — fail closed, same as a missing denylist. */
export function truncationFailure(truncated: boolean): string | null {
  return truncated ? COMPARE_TRUNCATED_FAILURE : null;
}

/** The closing-keyword failure description, or null when clean. */
export function closingKeywordFailure(title: string, body: string): string | null {
  // The exported RE carries `g` (tests assert its exact source/flags), so
  // .test would be stateful via lastIndex. Clone without `g` for the runtime
  // check.
  const re = new RegExp(CLOSING_KEYWORD_RE.source, CLOSING_KEYWORD_RE.flags.replace("g", ""));
  return re.test(`${title}\n${body}`) ? CLOSING_KEYWORD_FAILURE : null;
}

/** The leak-scan failure description (pattern indexes only, never terms), or
 *  null when clean. Fail closed: zero patterns and any scanner error both
 *  refuse. */
export function leakFailure(patterns: string[], blobs: string[]): string | null {
  if (patterns.length === 0) return DENYLIST_UNAVAILABLE;
  let hits: number[];
  try {
    hits = scanText(patterns, blobs.join("\n"));
  } catch {
    return LEAK_SCAN_ERROR;
  }
  return hits.length > 0 ? leakHitMessage(hits) : null;
}

/** Both prechecks, as a list of failure descriptions ([] = clean). */
export interface MergePrecheckInput {
  title: string;
  body: string;
  patterns: string[];
  blobs: string[];
  /** #1176: a confirmed-private repo skips the leak scan (board/leak.ts's rule);
   *  the closing-keyword check still runs. */
  private?: boolean;
  truncated?: boolean;
}

export function mergePrecheckFailures(input: MergePrecheckInput): string[] {
  const out: string[] = [];
  // The workflow always listed truncation first (its own prepend before the
  // pure list), so a truncated compare keeps posting that description.
  if (input.private !== true) {
    const trunc = truncationFailure(input.truncated === true);
    if (trunc !== null) out.push(trunc);
  }
  const closing = closingKeywordFailure(input.title, input.body);
  if (closing !== null) out.push(closing);
  if (input.private === true) {
    // Leaks cannot leave a private repo, so neither the scan nor its truncation
    // guard applies — the same whole-scan skip board/leak.ts makes. Only a
    // CONFIRMED private repo takes this path, never an unknown visibility.
    return out;
  }
  const leak = leakFailure(input.patterns, input.blobs);
  if (leak !== null) out.push(leak);
  return out;
}