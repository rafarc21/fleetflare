// Task #119: `fleet task verify <n>` — a READ-ONLY verb that closes the gap
// the Stop gate (P5a) leaves open. That gate refuses task completion unless a
// §6 result envelope carries a `verification` block, but nothing checks the
// STEPS in it are actually followable. Measured live on task #109: the
// envelope's own words ("Actions tab -> Fleet Check -> Run workflow, against
// branch ci/fleet-check-workflow") 404'd when followed literally, because
// `workflow_dispatch` only fires from a repo's DEFAULT branch. A confidently
// worded wrong intent reads identically to a correct one, and it is the exact
// artifact a human is meant to trust most.
//
// This module mechanically attempts what it can and classifies every check —
// it never blocks, never gates, never changes task state, and never closes
// anything. `api.createComment` is the ONLY write it makes, ever.
//
// Pure over the same BoardApi port board.ts already defines, plus one more
// injected seam (VerifyFetch) for the live HTTP GET against
// `verification.url` — no `Env`, no live `fetch` baked in, so every rule here
// is provable without a network.

import { showTask, type BoardApi, type BoardResult, type TaskComment } from "./board";

export type StepVerdict = "attempted-ok" | "attempted-failed" | "not-mechanically-checkable";

export interface StepResult {
  /** The step's own text (or, for the url check, the url itself) — what a
   *  human skims to see WHICH check this line is about. */
  label: string;
  verdict: StepVerdict;
  /** The real error/status text on a failure, or a one-line reason on
   *  not-mechanically-checkable, or a short confirmation on attempted-ok. */
  detail: string;
}

/** The one live-HTTP seam this module needs — a thin GET, injected so no test
 *  needs a network. `status` is all attemptVerification reads. */
export interface VerifyFetch {
  (url: string): Promise<{ status: number }>;
}

/**
 * The newest §6 envelope on the task whose `intent` is "result" — searched
 * BACKWARDS from the end of the comment list, not just "the last comment",
 * because a later plain human comment (or an earlier non-result envelope,
 * e.g. a `clarify`) must not shadow the actual result being verified.
 */
export function findLatestResultEnvelope(comments: TaskComment[]) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const env = comments[i].envelope;
    if (env && env.envelope.intent === "result") return env;
  }
  return null;
}

// --- ref extraction ----------------------------------------------------
//
// Design call (left open by the brief): keyword-anchored, not a bare
// "anything that looks like a number/hex string" scan. The brief's own
// framing is the reason — "a false 'not-mechanically-checkable' is safe; a
// false ref match that then reports the wrong verdict is not" — so every
// pattern below requires an explicit signal a plain English sentence is
// unlikely to produce by accident:
//
//   PR      — `#123`, or `pull/123` (GitHub's own URL segment). `#` is not
//             English punctuation in this position, so it is a safe anchor
//             on its own; `pull/` likewise never appears outside a GitHub
//             URL path.
//   branch  — the literal keyword `branch` immediately before a
//             git-ref-shaped token ([A-Za-z0-9._/-]+). This is a narrower
//             net than PR/commit — "the branch of a tree" would (falsely)
//             extract "of" — but it is the exact phrasing the motivating
//             failure (#109) used ("against branch
//             ci/fleet-check-workflow"), and the false-positive cost here is
//             bounded: `branchExists` on a bogus one-word "ref" just answers
//             404 -> attempted-failed, which is a wrong VERDICT on a step a
//             human still reads and can dismiss, not a silently wrong
//             success.
//   commit  — a standalone 7-40 char hex word, REQUIRED to contain at least
//             one a-f letter. A pure-decimal word of the same length (a
//             date like 20260908, an issue number typed without `#`) is
//             indistinguishable from a sha by charset alone, and it is far
//             more likely to be one of those than a truncated sha — so it is
//             excluded rather than risk exactly the false-ref-match the
//             brief calls out as the unsafe direction.
//
// A step may match more than one candidate (all are checked); a step
// matching none is not-mechanically-checkable.

export interface RefCandidate {
  kind: "pr" | "branch" | "commit";
  value: string;
}

const PR_HASH_RE = /#(\d+)\b/g;
const PR_PULL_RE = /\bpull\/(\d+)\b/gi;
const BRANCH_RE = /\bbranch\s+([A-Za-z0-9._/-]+)/gi;
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/gi;

export function extractRefCandidates(text: string): RefCandidate[] {
  const found: RefCandidate[] = [];
  const seen = new Set<string>();
  const push = (kind: RefCandidate["kind"], value: string) => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, value });
  };

  for (const m of text.matchAll(PR_HASH_RE)) push("pr", m[1]);
  for (const m of text.matchAll(PR_PULL_RE)) push("pr", m[1]);
  for (const m of text.matchAll(BRANCH_RE)) {
    // Strip trailing punctuation a sentence puts right after the token
    // (a period ending the step, a comma before the next clause) — none of
    // that is part of a git ref, and leaving it on would make an otherwise
    // real branch name fail to resolve.
    const value = m[1].replace(/[.,;:]+$/, "");
    if (value !== "") push("branch", value);
  }
  for (const m of text.matchAll(COMMIT_RE)) {
    const word = m[0];
    if (!/[a-f]/i.test(word)) continue; // see the module doc comment above
    push("commit", word.toLowerCase());
  }
  return found;
}

function candidateLabel(c: RefCandidate): string {
  return c.kind === "pr" ? `PR #${c.value}` : c.kind === "branch" ? `branch ${c.value}` : `commit ${c.value}`;
}

/** One candidate's existence, never throwing: a thrown check counts as that
 *  candidate FAILING (with the real error text), not as an uncaught
 *  exception — the whole point of this verb is surfacing exactly this kind
 *  of problem to a human, so a check that could not be answered is reported
 *  the same as one that answered "no". */
async function checkCandidate(api: BoardApi, repo: string, c: RefCandidate): Promise<{ ok: boolean; detail: string }> {
  try {
    const exists =
      c.kind === "pr" ? await api.pullRequestExists(repo, Number.parseInt(c.value, 10))
        : c.kind === "branch" ? await api.branchExists(repo, c.value)
          : await api.commitExists(repo, c.value);
    return exists
      ? { ok: true, detail: `${candidateLabel(c)} exists in ${repo}` }
      : { ok: false, detail: `${candidateLabel(c)} does not exist in ${repo}` };
  } catch (err) {
    return { ok: false, detail: `checking ${candidateLabel(c)} in ${repo} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One §6 verification step -> one classified line. ALL candidates in a step
 *  must exist for it to read attempted-ok; any missing or errored one makes
 *  it attempted-failed, naming which and why. */
async function checkStep(api: BoardApi, repo: string, step: string): Promise<StepResult> {
  const candidates = extractRefCandidates(step);
  if (candidates.length === 0) {
    return {
      label: step, verdict: "not-mechanically-checkable",
      detail: "no branch, PR or commit reference found in this step — a human has to follow it by hand",
    };
  }
  const checks = await Promise.all(candidates.map((c) => checkCandidate(api, repo, c)));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    return { label: step, verdict: "attempted-failed", detail: failed.map((f) => f.detail).join("; ") };
  }
  return { label: step, verdict: "attempted-ok", detail: checks.map((c) => c.detail).join("; ") };
}

/** `verification.url`, fetched through the injected seam. Never throws: a
 *  network failure counts as attempted-failed with the caught message, same
 *  posture checkCandidate takes for a thrown existence check. */
async function checkUrl(fetchUrl: VerifyFetch, url: string): Promise<StepResult> {
  try {
    const res = await fetchUrl(url);
    const verdict: StepVerdict = res.status >= 200 && res.status < 300 ? "attempted-ok" : "attempted-failed";
    return { label: url, verdict, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { label: url, verdict: "attempted-failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

// --- github.com url parsing (task #126) ---------------------------------
//
// checkUrl's own live-HTTP seam (VerifyFetch, above) used to treat EVERY
// verification.url as a plain anonymous GET — which is wrong for this fleet
// specifically, because every repo it works is PRIVATE, so an anonymous
// fetch of a real, existing commit/PR/issue/path/branch/compare 404s exactly
// as often as a fabricated one does. Measured live (board task #126): a
// real commit url read HTTP 404 unauthenticated while `gh repo view` and the
// authenticated REST API both confirmed the commit exists. A verifier that
// fails on everything is worse than no verifier — it trains the reader to
// ignore it.
//
// This function answers no HTTP itself and stays a PURE parser, unit
// testable with no token/fetch/network at all: src/board/routes.ts's
// realVerifyFetch is what turns a recognized shape into an authenticated
// existence check.

/** One recognized github.com url shape, and the repo + identifier(s) an
 *  authenticated existence check needs to answer it. `repo` is already
 *  lowercased, matching this codebase's repo-slug convention elsewhere
 *  (board.ts's resolveBoardRepo). */
export type GithubUrlCheck =
  | { kind: "commit"; repo: string; sha: string }
  | { kind: "pr"; repo: string; number: number }
  | { kind: "issue"; repo: string; number: number }
  | { kind: "branch"; repo: string; branch: string }
  | { kind: "path"; repo: string; ref: string; path: string }
  | { kind: "compare"; repo: string; base: string; head: string };

/**
 * Parses a github.com url into one of the shapes above, or `null` for
 * anything this module does not recognize — deliberately including BOTH
 * "not a github.com url at all" and "a github.com url this fleet has no
 * authenticated existence check for" (the repo root, `/settings`,
 * `/actions/runs/...`, and so on). Both cases get the exact same treatment
 * from the caller (realVerifyFetch): fall back to the plain unauthenticated
 * fetch every url got before this fix — there is no authenticated way to
 * answer "is this the right settings page", so the honest fallback is the
 * same anonymous GET a human clicking the link would make. This is the
 * fallback rule in full; nothing else in this module implements it.
 *
 * Recognized shapes (`<owner>`/`<repo>` are generic non-slash path
 * segments, not a fixed charset):
 *   `/<owner>/<repo>/commit/<sha>`             -> commit
 *   `/<owner>/<repo>/pull/<n>`                 -> pr
 *   `/<owner>/<repo>/issues/<n>`               -> issue
 *   `/<owner>/<repo>/blob/<ref>/<path>`        -> path (a file)
 *   `/<owner>/<repo>/tree/<ref>`               -> branch (a tree url with NO
 *                                                  further path segment IS
 *                                                  the branch/ref itself)
 *   `/<owner>/<repo>/tree/<ref>/<path>`        -> path (a directory)
 *   `/<owner>/<repo>/compare/<base>...<head>`  -> compare
 *
 * A branch name containing a `/` (e.g. `release/109`) is genuinely
 * ambiguous against a bare `/tree/<ref>` url — GitHub's own UI has the same
 * ambiguity and resolves it server-side against real branches, which this
 * pure parser cannot do. Left unresolved deliberately: a false
 * `not-recognized` here only costs the plain-fetch fallback, never a wrong
 * verdict.
 */
export function parseGithubUrl(url: string): GithubUrlCheck | null {
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== "github.com") return null;
    const segments = u.pathname.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
    if (segments.length < 4) return null; // need at least owner/repo/<verb>/<id>
    const [owner, repoName, verb, ...rest] = segments;
    const repo = `${owner}/${repoName}`.toLowerCase();

    if (verb === "commit" && rest.length === 1) return { kind: "commit", repo, sha: rest[0] };
    if (verb === "pull" && rest.length >= 1 && /^\d+$/.test(rest[0])) {
      return { kind: "pr", repo, number: Number.parseInt(rest[0], 10) };
    }
    if (verb === "issues" && rest.length >= 1 && /^\d+$/.test(rest[0])) {
      return { kind: "issue", repo, number: Number.parseInt(rest[0], 10) };
    }
    if (verb === "blob" && rest.length >= 2) {
      return { kind: "path", repo, ref: rest[0], path: rest.slice(1).join("/") };
    }
    if (verb === "tree" && rest.length === 1) return { kind: "branch", repo, branch: rest[0] };
    if (verb === "tree" && rest.length >= 2) {
      return { kind: "path", repo, ref: rest[0], path: rest.slice(1).join("/") };
    }
    if (verb === "compare" && rest.length >= 1) {
      const cmp = rest.join("/");
      const idx = cmp.indexOf("...");
      if (idx === -1) return null;
      const base = cmp.slice(0, idx);
      const head = cmp.slice(idx + 3);
      if (base === "" || head === "") return null;
      return { kind: "compare", repo, base, head };
    }
    return null;
  } catch {
    // A malformed url (bad %-escape, not a url at all) is not recognized —
    // same fallback-to-plain-fetch treatment as a well-formed but
    // unmatched one.
    return null;
  }
}

const VERDICT_ICON: Record<StepVerdict, string> = {
  "attempted-ok": "✅",
  "attempted-failed": "❌",
  "not-mechanically-checkable": "➖",
};

const VERDICT_LABEL: Record<StepVerdict, string> = {
  "attempted-ok": "attempted-ok",
  "attempted-failed": "attempted-FAILED",
  "not-mechanically-checkable": "not-mechanically-checkable",
};

/**
 * The one comment this whole verb ever posts. A heading naming the task and
 * which result envelope (`msg_id`) was checked, then one skimmable line per
 * check — the url first, then every step in order. Pure, so the exact text
 * that lands on a real issue is the text a test asserts on, same discipline
 * board.ts's own renderLineageComment already follows.
 */
export function renderVerifyComment(
  taskNumber: number, envelopeMsgId: string, urlResult: StepResult, stepResults: StepResult[],
): string {
  const line = (r: StepResult) => `- ${VERDICT_ICON[r.verdict]} **${VERDICT_LABEL[r.verdict]}** — ${r.label}: ${r.detail}`;
  return [
    `### Verify — task #${taskNumber}, checking result envelope \`${envelopeMsgId}\``,
    "",
    "Mechanical only: this checks whether the envelope's own verification steps are FOLLOWABLE, " +
      "not whether the work is correct. It never blocks, never changes task state, and never closes anything.",
    "",
    line(urlResult),
    ...stepResults.map(line),
    "",
  ].join("\n");
}

/**
 * The whole verb. Reads the newest result envelope, mechanically attempts
 * its url and every step, posts exactly ONE comment classifying each, and
 * returns what it found. Never gates, never transitions, never closes —
 * `api.createComment` is the only write anywhere in this function.
 *
 * A 404-shaped no-op (nothing posted) when there is no result envelope yet,
 * or — defensively, since the Stop gate already requires it on every result
 * — when the one found somehow carries no `verification` block at all.
 */
export async function attemptVerification(
  api: BoardApi, fetchUrl: VerifyFetch, repo: string, number: number,
): Promise<BoardResult<{ comment: { id: number; url: string }; envelopeMsgId: string; results: StepResult[] }>> {
  const shown = await showTask(api, repo, number);
  if (!shown.ok) return shown;

  const envelope = findLatestResultEnvelope(shown.value.comments);
  if (!envelope) {
    return { ok: false, status: 404, message: `task #${number} has no result envelope yet -- nothing to verify` };
  }
  const verification = envelope.payload.verification;
  if (!verification) {
    return {
      ok: false, status: 404,
      message: `task #${number}'s latest result envelope (${envelope.envelope.msg_id}) carries no verification block -- nothing to verify`,
    };
  }

  const urlResult = await checkUrl(fetchUrl, verification.url);
  const stepResults = await Promise.all(verification.steps.map((step) => checkStep(api, repo, step)));

  const body = renderVerifyComment(number, envelope.envelope.msg_id, urlResult, stepResults);
  const comment = await api.createComment(repo, number, body);
  return { ok: true, value: { comment, envelopeMsgId: envelope.envelope.msg_id, results: [urlResult, ...stepResults] } };
}
