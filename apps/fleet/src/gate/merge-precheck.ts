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
export const CLOSING_KEYWORD_COMMIT_FAILURE = "closing keyword in a commit message";
export const DENYLIST_UNAVAILABLE = "gate precheck: denylist unavailable";
export const LEAK_SCAN_ERROR = "gate precheck: leak scan error";
export const COMPARE_TRUNCATED_FAILURE = "gate precheck: compare truncated, cannot scan full diff";
export const UNSCANNABLE_FILE_FAILURE = "gate precheck: no diff to scan: ";

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

/** #1176: added (`+`) lines of one patch — context and removed lines never
 *  reach the scan, so a PR that REMOVES a leak can go green. GitHub patches
 *  carry no `+++` file headers, so a `++`-content line must not be dropped. */
export function addedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1))
    .join("\n");
}

/** #1176: files the scan cannot see — no patch (binary or oversized) and not a
 *  removal. Unscannable = red, never a silent pass. A missing status reads as
 *  changed, so fail closed. */
export function unscannableFiles(files: { filename: string; patch?: string; status?: string }[]): string[] {
  return files
    .filter((f) => f.patch === undefined && f.status !== "removed")
    .map((f) => f.filename);
}

/** #1176: every text the precheck scans, assembled from one compare view:
 *  title, body, whole file paths, ADDED patch lines only, commit identities and
 *  messages. */
export function precheckBlobs(input: {
  title: string;
  body: string;
  files: { filename: string; previous_filename?: string; patch?: string; status?: string }[];
  commits: { author: string; committer: string; message: string }[];
}): string[] {
  return [
    input.title,
    input.body,
    ...input.files.flatMap((f) => [f.filename, f.previous_filename ?? "", addedLines(f.patch ?? "")]),
    ...input.commits.flatMap((c) => [c.author, c.committer, c.message]),
  ];
}

/** #1176: GitHub 422s a status description over 140 chars — an uncapped
 *  description would drop the failure POST entirely and auto-merge would see
 *  nothing. */
export function capStatusDescription(s: string): string {
  return s.slice(0, 140).trimEnd();
}

/** #1176: the success-path recheck — same rules, title/body re-read, diff not
 *  refetched. */
export function recheckFailures(input: { title: string; body: string; patterns: string[]; private: boolean }): string[] {
  const out: string[] = [];
  const closing = closingKeywordFailure(input.title, input.body);
  if (closing !== null) out.push(closing);
  if (input.private) return out;
  const leak = leakFailure(input.patterns, [input.title, input.body]);
  if (leak !== null) out.push(leak);
  return out;
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
  /** #1176: commit messages join the keyword and leak scans (a squash body builds
   *  from them, so a keyword there closes issues at merge). */
  commitMessages?: string[];
  /** #1176: the compare's files, for the patchless-file fail-closed check. */
  files?: { filename: string; previous_filename?: string; patch?: string; status?: string }[];
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
  // #1176: a keyword in any commit message closes issues at merge (GitHub's
  // squash builds the merge commit's message from them), so it refuses too.
  const commitClosing = (input.commitMessages ?? []).some((m) => closingKeywordFailure(m, "") !== null);
  if (commitClosing) out.push(CLOSING_KEYWORD_COMMIT_FAILURE);
  if (input.private === true) {
    // Leaks cannot leave a private repo, so neither the scan nor its truncation
    // guard applies — the same whole-scan skip board/leak.ts makes. Only a
    // CONFIRMED private repo takes this path, never an unknown visibility.
    return out;
  }
  const unscannable = unscannableFiles(input.files ?? []);
  if (unscannable.length > 0) {
    out.push(capStatusDescription(UNSCANNABLE_FILE_FAILURE + unscannable.join(", ")));
  }
  const leak = leakFailure(input.patterns, [...input.blobs, ...(input.commitMessages ?? [])]);
  if (leak !== null) out.push(leak);
  return out;
}