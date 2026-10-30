// The precheck decision core for #1169: closing keyword + denylist leak scan,
// pure over inputs so bun test proves every rule. Fail closed: no denylist or
// a scanner error refuses, never passes (leak-gate.ts's own rule).
import { scanText, leakHitMessage } from "../leak-gate";
import { closingKeywordRefsDetailed, type ClosingKeywordRef } from "../github/promote-close";

/** #1169: any closing keyword at all in a PR's title or body makes the merge
 *  precheck red. Deliberately cruder than promote-close.ts's CLOSING_KEYWORD
 *  (that one asks "does it close issue N"; this one asks "is arming --auto
 *  safe"), per the task's own pattern. #1434: the crude trigger keeps every
 *  form GitHub's own grammar closes on — plain `#N`, `GH-N`,
 *  `owner/repo#N`, and the full issue URL — so a keyword in an un-scanned
 *  form cannot close an OPEN issue behind the gate's back. */
export const CLOSING_KEYWORD_RE = /(^|[^a-z])(close[sd]?|fix(es|ed)?|resolve[sd]?):?\s+(?:#|GH-|[\w.-]+\/[\w.-]+#|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/)[0-9]/gim;

export const CLOSING_KEYWORD_FAILURE = "closing keyword in PR title or body";
export const CLOSING_KEYWORD_COMMIT_FAILURE = "closing keyword in a commit message";
export const DENYLIST_UNAVAILABLE = "gate precheck: denylist unavailable";
// #1434 r2: a promotion PR can name hundreds of refs; reading each serially
// blows the Worker subrequest/time budget. Unique refs beyond the cap are not
// read at all — the run goes red naming the count, never a partial scan.
export const COMMIT_REFS_CAP = 50;
export const COMMIT_REFS_CAP_FAILURE = "gate precheck: commit refs over cap: ";
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

/** #1430/#1434: the refs each keyword-hit commit message closes, by GitHub's
 *  own grammar (promote-close.ts), qualifiers preserved. An empty list means
 *  a hit with no readable ref (fail closed: nothing proves it already closed). */
function commitClosingRefs(messages: string[], repo: string): { repo: string; number: number }[][] {
  return messages
    .filter((m) => closingKeywordFailure(m, "") !== null)
    .map((m) => closingKeywordRefsDetailed(m).map((r) => ({ repo: r.repo ?? repo, number: r.number })));
}

/** #1430/#1434: the commit-message refs already closed (a merged PR reads
 *  "closed" on the issues API). Fail closed: a base-repo ref whose lookup
 *  throws or answers anything but "closed" is left out, so it stays red.
 *  #1434: a qualified ref (`other/repo#5`, a URL) is looked up in its OWN
 *  repo, never the base repo — the base `#5` and `other/repo#5` are different
 *  issues. #1434 r2: a foreign ref whose lookup throws (the base repo's
 *  credential often cannot reach it, no App install there) is NOT red — it is
 *  treated as already closed and returned as a warning, restoring the pre-#1434
 *  "foreign refs pass" behaviour instead of a permanent new red surface. */
export interface ClosedCommitRefsResult {
  closed: ReadonlySet<string>;
  /** #1434 r2: foreign refs whose state could not be read, each one line. */
  warnings: string[];
  /** #1434 r2: present when unique refs exceeded {@link COMMIT_REFS_CAP}; the
   *  lookups were skipped and the caller goes red naming this count. */
  overCap?: number;
}

export async function closedCommitRefs(
  messages: string[], repo: string,
  refState: (n: number, repo: string) => Promise<string>,
): Promise<ClosedCommitRefsResult> {
  const unique = new Map<string, { repo: string; number: number }>();
  for (const ref of commitClosingRefs(messages, repo).flat()) {
    unique.set(`${ref.repo}#${ref.number}`, ref);
  }
  // #1434 r2: cap the serial lookups — a promotion PR naming hundreds of refs
  // would blow the Worker subrequest/time budget one issueState at a time.
  // Over the cap nothing is read at all; the caller goes red naming the count.
  if (unique.size > COMMIT_REFS_CAP) {
    return { closed: new Set<string>(), warnings: [], overCap: unique.size };
  }
  const closed = new Set<string>();
  const warnings: string[] = [];
  const base = repo.toLowerCase();
  for (const ref of unique.values()) {
    try {
      if (await refState(ref.number, ref.repo) === "closed") closed.add(`${ref.repo}#${ref.number}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ref.repo.toLowerCase() === base) {
        console.error(`gate precheck: ref state of ${ref.repo}#${ref.number} unreadable, keeping it red`, message);
      } else {
        closed.add(`${ref.repo}#${ref.number}`);
        warnings.push(`gate precheck: ${ref.repo}#${ref.number} unreadable — foreign ref treated as already closed, not red`);
      }
    }
  }
  return { closed, warnings };
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
 *  changed, so fail closed. #1191: a rename/copy with `changes` 0 is a pure move
 *  — there is no diff to scan, so it must not go red. */
export function unscannableFiles(
  files: { filename: string; previous_filename?: string; patch?: string; status?: string; changes?: number }[],
): string[] {
  return files
    .filter((f) => f.patch === undefined && f.status !== "removed")
    .filter((f) => !((f.status === "renamed" || f.status === "copied") && f.changes === 0))
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
  /** #1430: the PR's repo, for qualified commit-message refs. */
  repo?: string;
  /** #1430: commit-message refs already closed (closedCommitRefs), keyed
   *  `repo#number` so a qualified ref is not confused with the base repo's
   *  same number. A keyword passes only when every ref it names is here;
   *  absent = all red. */
  closedRefs?: ReadonlySet<string>;
  /** #1434 r2: the number of unique commit refs when they exceeded the cap —
   *  the lookups were skipped, so the run goes red naming this count. */
  closedRefsOverCap?: number;
  /** #1176: the compare's files, for the patchless-file fail-closed check. */
  files?: { filename: string; previous_filename?: string; patch?: string; status?: string; changes?: number }[];
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
  // #1430: unless every ref it names is already closed — a promotion PR
  // re-presents merged commits whose refs can close nothing.
  const closedRefs = input.closedRefs ?? new Set<string>();
  const commitClosing = commitClosingRefs(input.commitMessages ?? [], input.repo ?? "")
    .some((refs) => refs.length === 0 || refs.some((r) => !closedRefs.has(`${r.repo}#${r.number}`)));
  if (input.closedRefsOverCap !== undefined) {
    // #1434 r2: over the cap nothing was looked up, so nothing can prove any
    // ref already closed — red, naming the count rather than a vague keyword hit.
    out.push(capStatusDescription(`${COMMIT_REFS_CAP_FAILURE}${input.closedRefsOverCap} refs`));
  } else if (commitClosing) {
    out.push(CLOSING_KEYWORD_COMMIT_FAILURE);
  }
  if (input.private === true) {
    // Leaks cannot leave a private repo, so neither the scan nor its truncation
    // guard applies — the same whole-scan skip board/leak.ts makes. Only a
    // CONFIRMED private repo takes this path, never an unknown visibility.
    return out;
  }
  const unscannable = unscannableFiles(input.files ?? []);
  if (unscannable.length > 0) {
    // #1191: a count, never the filenames — a filename can carry a denylisted term.
    out.push(capStatusDescription(`${UNSCANNABLE_FILE_FAILURE}${unscannable.length} file(s)`));
  }
  const leak = leakFailure(input.patterns, [...input.blobs, ...(input.commitMessages ?? [])]);
  if (leak !== null) out.push(leak);
  return out;
}