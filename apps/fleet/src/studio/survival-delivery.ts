// Issue #249 (PR4b) — DELIVERY of #107/#150's survival re-brief to a restarted
// lead. PR4a (merged as #150) built the pure composer (`survival-brief.ts`);
// this file is everything between "a container was replaced" and "the new lead
// has been told what survived", and nothing else.
//
// Measured origin (spec: docs/superpowers/specs/2026-09-24-row-tells-truth-
// design.md, "#107" section): three recycle rounds on the same studio lost
// everything, and round 4 recovered in minutes once a human hand-wrote the
// re-brief naming the surviving branches. Studio clones are shallow and
// single-branch, so a fresh lead cannot see its own pushed branches at all
// without being told.
//
// NO DO CONSTRUCTION ANYWHERE. Every port is injected, exactly like
// `deliverAssignedTaskOnBringup` (do.ts, board issue #213/#229) — the
// precedent this file follows deliberately, down to the trailing-optional
// `moved` param. StudioDO cannot be constructed under vitest-pool-workers
// (do.ts's own header), so behaviour that is not extractable is behaviour
// that cannot be tested; the wiring in do.ts stays a thin, source-pinned
// forward. See test/studio.survival-delivery.test.ts.

import { aboveAgentPanel, MODAL_TAIL_LINES, PANE_CAPTURE_MARKER, PANE_QUIESCE_SECONDS } from "./failover";
import {
  getObserved, mergeObserved,
  type BringupVia, type ObservedSession, type ObservedStorage, type SurvivalBriefPending,
} from "./observed";
import { redactSecrets } from "./redact";
import {
  composeSurvivalBrief,
  type Checked, type SurvivalInput, type SurvivalOpenPr, type SurvivalTaskBranch,
} from "./survival-brief";
import type { WakeOutcome } from "./wake";
import type { EnvelopeArtifact } from "../board/types";
import { parseGithubUrl } from "../board/verify";

// ---------------------------------------------------------------------------
// 1. THE TRIGGER ALLOWLIST
// ---------------------------------------------------------------------------

/**
 * Does this bring-up earn a survival re-brief? An EXPLICIT ALLOWLIST — the
 * spec's own word — so a `BringupVia` added later is a type error here rather
 * than a silent new trigger that re-briefs the fleet.
 *
 * - `recycle` / `heal`: ALWAYS. Both destroy and rebuild the container by
 *   construction, so work that only existed on its disk is gone whether or
 *   not `Observed.replacedAt` happened to be set first.
 * - `provision` / `restart`: ONLY when a replacement was actually detected.
 *   A first/fresh provision has nothing that could have survived, and the
 *   overwhelmingly common restart is a plain refresh of a container that is
 *   still the one this DO already owned. `replacementDetected` is the
 *   bring-up-time capture of `Observed.replacedAt !== null`
 *   (`ObservedSession.replacementDetected`, observed.ts) — it MUST be that
 *   capture and not a delivery-time read, because `recordBringupObservation`
 *   clears `replacedAt` to null before the bring-up wakes fire.
 * - `adopted` / `failover`: NEVER, and HARD-DENIED — `replacementDetected`
 *   is not even consulted, so no other signal can talk either of them into
 *   firing. `adopted` fires on EVERY already-running studio the instant PR1
 *   deploys (re-briefing the whole fleet at deploy time would be absurd);
 *   `failover` is an account switch, not a container replacement, and
 *   nothing on disk was lost.
 *
 * Written as an exhaustive switch rather than two sets, so the hard denials
 * are unreachable-by-construction from the `replacementDetected` branch
 * instead of merely ordered before it.
 */
export function survivalBriefAllowed(via: BringupVia, replacementDetected: boolean): boolean {
  switch (via) {
    // Hard denials, first and unconditional.
    case "adopted":
    case "failover":
      return false;
    // A container rebuild by construction.
    case "recycle":
    case "heal":
      return true;
    // Only with a detected replacement behind them.
    case "provision":
    case "restart":
      return replacementDetected;
  }
}

// ---------------------------------------------------------------------------
// 2. "THE LEAD IS MID-TASK, DON'T INTERRUPT" — TWO INDEPENDENT BUSY SIGNALS
// ---------------------------------------------------------------------------

/**
 * Signal 2, on its own: claude prints `esc to interrupt` ONLY while a turn is
 * running — it is the tail of its live status line (`✻ Cogitating… (12s · ↑
 * 1.4k tokens · esc to interrupt)`). One capture answers it, so it needs no
 * quiescence interval at all and fires on panes signal 1 cannot read.
 *
 * ANCHORED TO THE END OF A ROW (with claude's own optional closing paren and
 * trailing pane padding), not a bare substring: the phrase appears in prose
 * all over this repo's own transcripts and specs, and a lead that PRINTED the
 * words mid-row must not read as busy. Same anchoring discipline #106 forced
 * on failover.ts's modal matchers for the same reason.
 *
 * Only the last MODAL_TAIL_LINES rows count — reused from failover.ts rather
 * than a second constant, since it answers the identical question ("how far
 * up from the bottom of the VISIBLE pane does chrome still count"). A status
 * line that has scrolled further up than that is transcript, not a live turn.
 *
 * RESIDUAL, stated rather than hidden: a lead whose turn ENDS with a row
 * whose last words are exactly `esc to interrupt)` — a quoted status line as
 * the final output — reads busy. That biases toward a FALSE BUSY, which costs
 * one deferred re-brief retried on the next bring-up; the opposite error
 * interrupts a working lead, which is what this whole gate exists to prevent.
 */
const ESC_TO_INTERRUPT_ROW = /esc to interrupt\)?\s*$/;

export function midTurnRow(capture: string): boolean {
  return capture
    .replace(/\s+$/, "")
    .split("\n")
    .slice(-MODAL_TAIL_LINES)
    .some((line) => ESC_TO_INTERRUPT_ROW.test(line));
}

/** Busy, with the reason a log line needs, or proven idle. */
export type BusyVerdict = { busy: false } | { busy: true; reason: string };

/**
 * Both busy signals over ONE `paneCaptureCmd()` stdout (failover.ts) — one
 * exec, two observations PANE_QUIESCE_SECONDS apart, INVISIBLE by
 * construction (that function's own doc comment; nothing here selects,
 * switches, attaches or kills a tmux window).
 *
 * Signal 1 — THE REPAINT TEST, byte-identical to the one
 * `detectRateLimitModal` runs, via the SAME exported `aboveAgentPanel` slice
 * rather than a second copy that could drift: claude repaints its status line
 * every second while a turn runs, so two captures three seconds apart differ
 * iff a turn is in flight. The agent panel under the footer is excluded
 * because it ticks its own timers while the LEAD is idle.
 *
 * Signal 2 — `midTurnRow` above, on a single capture. Checked on BOTH
 * captures: a pane with no readable footer makes `aboveAgentPanel` a no-op
 * passthrough, and there is no reason to prefer one observation over the
 * other when either one showing a live status line is enough to stand down.
 *
 * The two are INDEPENDENT — either one says busy and delivery skips this
 * sweep tick entirely, writing NO dedup marker, so the next bring-up retries
 * for free. Nothing here ever forces a wake through.
 *
 * AN UNREADABLE PROBE IS BUSY, not idle. Delivery requires PROVEN idleness:
 * a stdout with no marker, or an empty capture, is a statement about the
 * PROBE (failover.ts's `inconclusive`, same evidence, same words) and is no
 * evidence that the lead is free. Biasing it to idle would let a broken
 * probe type into a working lead — the one outcome this gate must never
 * produce. The cost of the opposite bias is bounded and cheap: a studio whose
 * probe never reads gets no re-brief, which is exactly what the fleet already
 * lives with today (a human writes it by hand).
 */
export function paneBusy(stdout: string): BusyVerdict {
  const parts = stdout.split(`${PANE_CAPTURE_MARKER}\n`);
  if (parts.length !== 2) {
    return { busy: true, reason: "pane probe produced no second observation — the lead is not proven idle" };
  }
  const [first, second] = parts.map((p) => p.replace(/\s+$/, ""));
  if (first.length === 0 || second.length === 0) {
    return { busy: true, reason: "pane probe captured nothing — the lead is not proven idle" };
  }
  if (aboveAgentPanel(first) !== aboveAgentPanel(second)) {
    return { busy: true, reason: `pane repainted within ${PANE_QUIESCE_SECONDS}s — a turn is in flight` };
  }
  if (midTurnRow(first) || midTurnRow(second)) {
    return { busy: true, reason: "pane shows an `esc to interrupt` row — a turn is in flight" };
  }
  return { busy: false };
}

// ---------------------------------------------------------------------------
// 3. TASK → BRANCH: THE 3 ANCHORED SOURCES
// ---------------------------------------------------------------------------

/** One live task, with the envelope artifacts recorded against it (NEWEST
 *  FIRST — the caller walks a task's comments newest-first, so the most
 *  recent PR/branch claim wins, the same "newest wins" resolution
 *  `resolveLatestAssignedBrief` uses for the task itself). */
export interface SurvivalTaskRef {
  taskNumber: number;
  taskTitle: string;
  artifacts: EnvelopeArtifact[];
}

/**
 * SOURCE 1 — PR numbers a task's envelope artifacts claim, in artifact order.
 *
 * `{kind: "pr", pr: "150"}` is how this fleet's own studios report progress
 * all day (`src/board/verify.ts` defines the kind; `commentEnvelope`,
 * board.ts, already existence-checks the `pr` field before recording it, so a
 * number that got this far names a PR GitHub confirmed). A leading `#` is
 * accepted because board.ts's own check strips one.
 *
 * A `url` is accepted too, but ONLY through `parseGithubUrl` — the shared,
 * anchored github.com url parser (verify.ts), never a regex over the string.
 * That is the difference between reading `/<owner>/<repo>/pull/150` and
 * matching `150` anywhere in a url.
 *
 * `kind` must be exactly `"pr"`: an artifact of some other kind that happens
 * to carry a `pr` field is not a PR claim.
 */
export function prArtifactNumbers(artifacts: EnvelopeArtifact[]): number[] {
  const out: number[] = [];
  for (const art of artifacts) {
    if (art.kind !== "pr") continue;
    const fromField = art.pr === undefined ? null : Number.parseInt(art.pr.replace(/^#/, ""), 10);
    if (fromField !== null && Number.isInteger(fromField) && fromField > 0) {
      if (!out.includes(fromField)) out.push(fromField);
      continue;
    }
    const parsed = art.url === undefined ? null : parseGithubUrl(art.url);
    if (parsed?.kind === "pr" && !out.includes(parsed.number)) out.push(parsed.number);
  }
  return out;
}

/**
 * SOURCE 2 — branches a task's envelope artifacts name DIRECTLY, in artifact
 * order.
 *
 * `{kind: "branch", path: "fix/107-survival"}` — `path` is `EnvelopeArtifact`'s
 * own free locator field (board/types.ts) and is where a branch artifact
 * carries its ref. A `url` is accepted through `parseGithubUrl` only, and
 * only when that parser itself resolves it to a `branch` (a `/tree/<ref>` url
 * with no further path segment); a `/tree/<ref>/<path>` url is a DIRECTORY
 * and is deliberately not read as a branch.
 *
 * Whitespace-only and empty values are dropped rather than passed on as a
 * ref no compare call could ever resolve.
 */
export function branchArtifacts(artifacts: EnvelopeArtifact[]): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const branch = raw.trim();
    if (branch !== "" && !out.includes(branch)) out.push(branch);
  };
  for (const art of artifacts) {
    if (art.kind !== "branch") continue;
    if (art.path !== undefined) push(art.path);
    const parsed = art.url === undefined ? null : parseGithubUrl(art.url);
    if (parsed?.kind === "branch") push(parsed.branch);
  }
  return out;
}

/** SOURCE 3's flat/main-checkout prefix: `fleet/rescue/<studio>-`, byte-
 *  identical to the one `discoverRescueRefsCmd` (provision.ts) greps for
 *  (its own `flatPrefix`) and `rescuePushCmd` (rescue.ts) pushes to. */
export function rescueBranchPrefix(studioId: string): string {
  return `fleet/rescue/${studioId}-`;
}

/** The nested tree every OTHER rescue-ref shape lives under: the member-
 *  worktree shape, the not-checked-out-branch/stash shape, and the WIP-sync
 *  shape (#208). Byte-identical to `discoverRescueRefsCmd`'s own
 *  `nestedPrefix`. Trailing slash, so it cannot match a DIFFERENT, longer
 *  studio id's own nested ref the way an unanchored flat prefix could —
 *  studio ids never contain `/`. */
export function rescueBranchNestedPrefix(studioId: string): string {
  return `fleet/rescue/${studioId}/`;
}

/** Both prefixes a server-side "list branches starting with X" query must
 *  run to cover every rescue-ref shape this fleet produces: the flat shape
 *  and the nested tree every other shape lives under. The two are disjoint
 *  (the flat prefix's next character is always `-`, the nested prefix's is
 *  always `/`), so querying both can never double-count the same ref. */
export function rescueBranchPrefixes(studioId: string): string[] {
  return [rescueBranchPrefix(studioId), rescueBranchNestedPrefix(studioId)];
}

/**
 * #216 item 2 — the pure core of `StudioDO.survivalSources`'s own
 * `rescueBranches` port: query EVERY prefix `rescueBranchPrefixes` returns,
 * through the injected `listByPrefix` (do.ts's thin forward of
 * `listMatchingBranches`), and union the results.
 *
 * Pulled out here, rather than left inline in do.ts, for the same reason
 * every other piece of this feature's logic lives outside do.ts: `StudioDO`
 * cannot be constructed under vitest-pool-workers (do.ts's own header), so
 * behaviour that stays inline is behaviour this suite cannot pin. do.ts's
 * own `rescueBranches` port is now a one-line forward to this.
 *
 * `listByPrefix` may legitimately be called more than once with the SAME
 * studio across the two prefixes of two DIFFERENT studios only in theory —
 * in practice the two prefixes this function queries are disjoint by
 * construction (`rescueBranchPrefixes`'s own doc comment), so the union
 * below needs a `Set` only to be defensive against a port that duplicates a
 * ref across calls, not because real overlap is expected.
 */
export async function fetchRescueBranchesForStudio(
  studioId: string,
  listByPrefix: (prefix: string) => Promise<string[]>,
): Promise<string[]> {
  const names = new Set<string>();
  for (const prefix of rescueBranchPrefixes(studioId)) {
    for (const name of await listByPrefix(prefix)) names.add(name);
  }
  return [...names];
}

/** `$(date -u +%Y%m%d%H%M%S)` — exactly 14 digits, no more, no fewer. */
export const RESCUE_STAMP_DIGITS = 14;

/**
 * SOURCE 3 — this fleet's own rescue-ref naming conventions, matched
 * ANCHORED AT BOTH ENDS and nothing else, across every shape `rescue.ts` /
 * `discoverRescueRefsCmd` (provision.ts) actually produce:
 *
 *  - FLAT (main checkout): `fleet/rescue/<studio>-<14 digits>`.
 *  - NESTED, not-checked-out-branch/stash (#263 N1/N2):
 *    `fleet/rescue/<studio>/<14 digits>/checkout/<name>`.
 *  - NESTED, member worktree (#266), and its nff-retry variant:
 *    `fleet/rescue/<studio>/wt/<id>-<14 digits>` or
 *    `fleet/rescue/<studio>/wt/<id>-nff-<14 digits>`.
 *  - NESTED, WIP sync (#208, anticipated ahead of that ref existing in the
 *    wild): `fleet/rescue/<studio>/wip`, exactly, literal, no digits.
 *
 * NEVER a bare substring or a `*<studio>*` wildcard — the spec forbids it by
 * name, and the reason is concrete. `fleet/rescue/other--web-studio-
 * 20260925120000` CONTAINS `web-studio-` and is ANOTHER studio's rescued
 * work; reporting it as this studio's surviving branch would hand a fresh
 * lead a branch it must not touch. Equally, `fleet/rescue/<studio>-
 * 20260925120000-wip` merely starts with the flat prefix and is not a rescue
 * ref this fleet ever pushed. Every shape above is anchored the same way:
 * `startsWith` on the fixed, data-only prefix, then a FIXED regex (never one
 * assembled from `studioId`) over the remainder, so no studio id ever needs
 * escaping to stay safe.
 */
export function isRescueBranchFor(studioId: string, branch: string): boolean {
  const flatPrefix = rescueBranchPrefix(studioId);
  if (branch.startsWith(flatPrefix)) {
    const stamp = branch.slice(flatPrefix.length);
    return stamp.length === RESCUE_STAMP_DIGITS && /^[0-9]+$/.test(stamp);
  }
  const nestedPrefix = rescueBranchNestedPrefix(studioId);
  if (!branch.startsWith(nestedPrefix)) return false;
  const rest = branch.slice(nestedPrefix.length);
  if (rest === "wip") return true;
  if (/^[0-9]{14}\/checkout\/\S+$/.test(rest)) return true;
  return /^wt\/\S+-[0-9]{14}$/.test(rest);
}

/** Every ref in `branches` that is genuinely one of THIS studio's rescue
 *  refs, newest stamp first (the stamps are fixed-width, so a lexical sort IS
 *  a chronological one). */
export function rescueBranchesFor(studioId: string, branches: string[]): string[] {
  return branches.filter((b) => isRescueBranchFor(studioId, b)).sort().reverse();
}

/**
 * SOURCE 3's ATTRIBUTION, and the whole of it: a rescue ref names the STUDIO
 * and the MOMENT of the push, and has no slot for a task number by
 * construction — issue #107's own re-review records this as a KNOWN,
 * ACCEPTED GAP, and the spec explicitly leaves general attribution to a
 * future design pass rather than guessing at one here.
 *
 * So this attributes in the ONE case where no guess is involved: exactly one
 * live task with no branch from source 1 or 2, and exactly one anchored
 * rescue ref for this studio. With a single candidate on each side there is
 * only one possible assignment, and it is not a heuristic. Anything else —
 * two tasks, two refs, or both — stays UNATTRIBUTED (`branch: null`, which
 * the composer renders as "no branch on origin"), because attributing it
 * would require exactly the design decision #107 deferred.
 *
 * A wrong attribution is the expensive error here: it tells a fresh lead that
 * work belongs to a task it does not belong to, which is worse than PR4a's
 * own honest silence.
 */
export function attributeRescueBranch(unresolvedTasks: number, rescueRefs: string[]): string | null {
  if (unresolvedTasks !== 1 || rescueRefs.length !== 1) return null;
  return rescueRefs[0]!;
}

// ---------------------------------------------------------------------------
// 4. COMPOSING THE SurvivalInput
// ---------------------------------------------------------------------------

/**
 * The narrow GitHub/board ports composing a `SurvivalInput` needs. All
 * injected, all outside the container: nothing here ever execs `git log`
 * inside a studio's own clone, which is the spec's single loudest correction
 * on this feature — studio clones are shallow and single-branch, so a `git
 * log origin/main..origin/<branch>` run inside one counts a genuinely
 * 0-ahead branch as 1-3 ahead (measured, #107).
 */
export interface SurvivalSources {
  studioId: string;
  /** A PR's head branch and title, or null when GitHub cannot resolve the
   *  PR at all. Called at most once per PR number (memoized below). */
  pull: (prNumber: number) => Promise<{ headRef: string; title: string } | null>;
  /** Every branch on origin under EITHER of `rescueBranchPrefixes(studioId)`
   *  — prefix queries, then re-filtered through `isRescueBranchFor`'s
   *  anchored match, so a server-side prefix hit that is not a real rescue
   *  ref is still rejected. The prefix queries are a narrowing optimization
   *  only, never the real match. */
  rescueBranches: () => Promise<string[]>;
  /** `main...<branch>` from GitHub's compare API (`compareAhead`,
   *  src/github/api.ts): `{aheadBy, lastCommitAt}`, or null when GitHub
   *  cannot resolve the ref (404 — the branch is not on origin). THROWS on
   *  any other failure, which this module turns into per-branch "unknown". */
  compareAhead: (branch: string) => Promise<{ aheadBy: number; lastCommitAt: string | null } | null>;
  /** Open PR numbers in the work repo (`listOpenPullNumbers`). */
  openPullNumbers: () => Promise<number[]>;
}

/** What `main` is called here. The compare's base — never hardcoded at a
 *  call site, so a repo whose default branch is named otherwise has exactly
 *  one place to change. */
export const SURVIVAL_COMPARE_BASE = "main";

/**
 * Turns the studio's live tasks into PR4a's `SurvivalInput`.
 *
 * TAKES NO STORAGE PORT, ON PURPOSE. `session` arrives as a PARAMETER,
 * captured at bring-up and threaded in by the caller, so this function is
 * STRUCTURALLY INCAPABLE of re-reading the DO record at delivery time. The
 * spec's caveat is precise about why that matters: delivery happens AFTER
 * bring-up, possibly several sweep ticks later, and the DO's own
 * `lastSnapshotAt` is refreshed by the very next post-bring-up session sync —
 * so by delivery time it can describe the NEW session's first upload rather
 * than the snapshot that was actually restored. `ObservedSession.snapshotAgeS`
 * is the restore-time value and the only one this feature may use, and the
 * way to guarantee that is to make the stale source unreachable rather than
 * merely unused.
 *
 * `commitsAheadOfMain`, per branch, has exactly three outcomes and no fourth:
 *   - a number, INCLUDING 0 — a genuinely CHECKED zero, which the composer
 *     renders as "EMPTY … nothing survived". Dropping or fabricating it is
 *     the exact silent drop #107 exists to fix.
 *   - `branch: null` on a 404 — GitHub cannot resolve the ref, i.e. the
 *     branch is not on origin, which is a real answer ("nothing survived
 *     under that name") and is what PR4a's `branch: null` already means.
 *   - `commitsAheadOfMain: null` on a thrown API error — "commits ahead
 *     unknown", never a fabricated 0. Caught PER BRANCH, so one unreachable
 *     compare cannot turn every other task line unknown.
 *
 * A failed TASK lookup collapses both sections to `Checked` failures rather
 * than a silently blank brief — `openPrs` is derived from the tasks' own PR
 * artifacts, so it genuinely cannot be answered without them.
 */
export async function resolveSurvivalInput(
  sources: SurvivalSources,
  tasks: Checked<SurvivalTaskRef[]>,
  session: ObservedSession | null,
  now: string,
): Promise<SurvivalInput> {
  if (!tasks.ok) {
    return {
      studioId: sources.studioId,
      tasks,
      openPrs: { ok: false, reason: tasks.reason },
      // MAJOR fix (fresh-context review on #207): a failed task lookup
      // means attribution never ran at all (it needs the task list to know
      // how many unresolved tasks there are) -- `[]`, never a guess.
      unclaimedRescueBranches: [],
      session,
      now,
    };
  }

  // One lookup per PR number for the whole composition: a PR resolved for a
  // task's branch is the same PR the open-PR section reports.
  const pulls = new Map<number, { headRef: string; title: string } | null>();
  const pull = async (n: number) => {
    if (!pulls.has(n)) pulls.set(n, await sources.pull(n));
    return pulls.get(n) ?? null;
  };

  const resolved: { task: SurvivalTaskRef; prs: number[]; branch: string | null }[] = [];
  for (const task of tasks.value) {
    const prs = prArtifactNumbers(task.artifacts);
    let branch: string | null = null;
    // SOURCE 1 — the linked PR's own head branch, first resolvable wins.
    for (const n of prs) {
      const info = await pull(n);
      if (info !== null) { branch = info.headRef; break; }
    }
    // SOURCE 2 — a {kind:"branch"} artifact, named directly.
    if (branch === null) branch = branchArtifacts(task.artifacts)[0] ?? null;
    resolved.push({ task, prs, branch });
  }

  // SOURCE 3 — the rescue-ref convention, anchored, attributed only in the
  // unambiguous single-candidate case (see attributeRescueBranch).
  //
  // MAJOR fix (fresh-context review on #207, 2026-10-03): the ambiguous-or-
  // leftover case used to just fall through here, silently -- `refs` was
  // computed, `attributeRescueBranch` returned null, and nothing further
  // ever looked at `refs` again. The lead never learned a rescue ref
  // existed for its own studio at all. `unclaimedRescueBranches` now
  // carries every ref this attribution attempt did NOT assign to a task,
  // so `composeSurvivalBrief` can render it as its own line instead of
  // dropping it.
  //
  // MAJOR fix (#216 item 1, 2026-10-03): `sources.rescueBranches()` must be
  // fetched UNCONDITIONALLY. It used to live inside the `unresolved.length >
  // 0` guard, so a studio where EVERY task already resolved a branch via
  // source 1/2 -- or a studio with zero tasks at all -- never fetched rescue
  // refs, and a genuine rescue ref sitting on origin (e.g. a periodic WIP
  // sync, or a rescue that landed after the task's PR was already resolved)
  // was never shown. Attribution still only makes sense with something
  // unresolved to attribute to, so that part alone stays gated.
  const refs = rescueBranchesFor(sources.studioId, await sources.rescueBranches());
  const unresolved = resolved.filter((r) => r.branch === null);
  let unclaimedRescueBranches: string[] = refs;
  if (unresolved.length > 0) {
    const attributed = attributeRescueBranch(unresolved.length, refs);
    if (attributed !== null) {
      unresolved[0]!.branch = attributed;
      unclaimedRescueBranches = refs.filter((r) => r !== attributed);
    }
  }

  const taskBranches: SurvivalTaskBranch[] = [];
  for (const r of resolved) {
    const base = { taskNumber: r.task.taskNumber, taskTitle: r.task.taskTitle };
    if (r.branch === null) {
      taskBranches.push({ ...base, branch: null, commitsAheadOfMain: null, lastCommitAt: null });
      continue;
    }
    try {
      const cmp = await sources.compareAhead(r.branch);
      if (cmp === null) {
        // 404: GitHub cannot resolve the ref — the branch is not on origin.
        taskBranches.push({ ...base, branch: null, commitsAheadOfMain: null, lastCommitAt: null });
      } else {
        taskBranches.push({ ...base, branch: r.branch, commitsAheadOfMain: cmp.aheadBy, lastCommitAt: cmp.lastCommitAt });
      }
    } catch (err) {
      console.error(`survival re-brief: compare ${SURVIVAL_COMPARE_BASE}...${r.branch} failed`, err);
      taskBranches.push({ ...base, branch: r.branch, commitsAheadOfMain: null, lastCommitAt: null });
    }
  }

  let openPrs: Checked<SurvivalOpenPr[]>;
  try {
    const open = new Set(await sources.openPullNumbers());
    const list: SurvivalOpenPr[] = [];
    for (const r of resolved) {
      for (const n of r.prs) {
        if (!open.has(n) || list.some((p) => p.number === n)) continue;
        const info = await pull(n);
        if (info !== null) list.push({ number: n, title: info.title, branch: info.headRef });
      }
    }
    openPrs = { ok: true, value: list };
  } catch (err) {
    openPrs = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  return {
    studioId: sources.studioId, tasks: { ok: true, value: taskBranches }, openPrs, unclaimedRescueBranches,
    session, now,
  };
}

/** `resolveSurvivalInput` + PR4a's composer, in one call — the `compose`
 *  thunk the delivery function below takes. An EMPTY string is PR4a's own
 *  signal that there is nothing worth re-briefing about. */
export async function composeSurvivalDelivery(
  sources: SurvivalSources,
  tasks: Checked<SurvivalTaskRef[]>,
  session: ObservedSession | null,
  now: string,
): Promise<string> {
  return composeSurvivalBrief(await resolveSurvivalInput(sources, tasks, session, now));
}

// ---------------------------------------------------------------------------
// 5. THE DELIVERY
// ---------------------------------------------------------------------------

/** The bring-up this delivery is about, read ONCE at the start of delivery
 *  and never re-read (see `deliverSurvivalBriefOnBringup`). */
export interface SurvivalBringup {
  /** PR1's incarnation token for the container this bring-up produced. The
   *  dedup identity: at most one re-brief per incarnation. */
  incarnation: string | null;
  via: BringupVia;
  /** `ObservedSession.replacementDetected` — captured at bring-up, never
   *  read off `Observed.replacedAt` at delivery time (that field is cleared
   *  to null before the bring-up wakes fire). */
  replacementDetected: boolean;
  /** Round-2 item 2: the bring-up's own session verdict, so a DEFERRED brief
   *  can be retried later from a frozen copy of it (`SurvivalBriefPending`,
   *  observed.ts) rather than from whatever `Observed.session` happens to hold
   *  by then — the same "captured at bring-up, never re-read" discipline every
   *  other field on this interface already follows. */
  session: ObservedSession;
}

/**
 * Round-2 review, item 4 — what `compose` may answer.
 *
 * A plain STRING is a brief (or PR4a's own empty-string "nothing survived
 * worth saying"). `{defer}` is the other, genuinely different answer: the
 * brief could not be composed from information the studio trusts, which is
 * NOT the same statement as "here is a brief that says we could not check".
 *
 * The distinction is item 4's whole finding, and it is narrow on purpose. A
 * BOARD READ FAILURE is transient infrastructure: the brief's task-branch
 * section is the load-bearing half (#107's measured recovery came from being
 * told which branches survived), and shipping "- Task branches: could not
 * check (board read failed (503))" while stamping the dedup marker spends the
 * studio's one at-most-once delivery on a brief that carries none of the
 * information it exists to carry. A GENUINELY EMPTY task list is the opposite
 * case and still delivers normally — "none" is a checked answer.
 *
 * A widened union rather than a changed return type, so every existing caller
 * (and every round-1 test) that returns a bare string keeps type-checking
 * exactly as it did.
 */
export type ComposedBrief = string | { defer: string };

/** Why this tick delivered nothing, or that it did — enough for one log line,
 *  and the shape the tests assert on. */
export type SurvivalDeliveryOutcome =
  /** A HARD stand-down: nothing is owed, and nothing is persisted. */
  | { kind: "skipped"; reason: string }
  /** Round-2 item 2: the brief IS owed and the attempt did not land, so the
   *  pending marker was written/advanced and the sync tick will retry. */
  | { kind: "deferred"; reason: string; attempts: number }
  /** A wake the gate stack refused. Also deferred (the pending marker is
   *  written) — kept as its own kind because the caller logs `wake` through
   *  `logWakeOutcome`, which needs the outcome itself, not a reason string. */
  | { kind: "refused"; wake: WakeOutcome }
  /** The bound in `SURVIVAL_RETRY_MAX_ATTEMPTS`/`SURVIVAL_RETRY_WINDOW_MS`
   *  was exceeded: retrying has STOPPED and the row now says so. */
  | { kind: "gave-up"; reason: string; attempts: number }
  | { kind: "delivered"; incarnation: string };

/**
 * Round-2 item 2, BOUND ONE — how many delivery attempts a single owed brief
 * gets before the studio stops trying and says so on the row. Counts the
 * bring-up's own first attempt, so this is 1 bring-up + 5 sync-tick retries.
 *
 * Six is chosen against the retry cadence: the retry rides
 * `SYNC_SESSION_SECONDS` (300s, session-sync.ts), so six attempts is ~25
 * minutes of a lead that is continuously mid-turn or a board that is
 * continuously unreachable. Bounding the COUNT (and not only the elapsed
 * window below) matters because the tick cadence is not a constant this
 * feature owns: a future faster tick, or a heal that re-arms the loop, must
 * not turn "retry while idle" into an unbounded typing loop.
 */
export const SURVIVAL_RETRY_MAX_ATTEMPTS = 6;

/**
 * Round-2 item 2, BOUND TWO — how long an owed brief stays worth delivering,
 * measured from the FIRST deferral (`SurvivalBriefPending.since`).
 *
 * 30 minutes, and the reason is staleness rather than cost. The brief is a
 * recovery aid for the minutes right after a container replacement — #107's
 * own measurement is a lead that recovered in 6 minutes once told. A lead that
 * has been working for half an hour since the replacement has already either
 * recovered on its own or wedged, and typing "what survived" at it then is
 * interrupting whatever it is doing now with a description of a moment it has
 * left behind. The two bounds are deliberately near-equivalent at today's tick
 * cadence; they answer different questions (work done vs. information age) and
 * whichever trips first ends the retries.
 */
export const SURVIVAL_RETRY_WINDOW_MS = 30 * 60_000;

/**
 * Issue #249 (PR4b): the bring-up half of the survival re-brief.
 *
 * SIBLING OF, AND DELIBERATELY SHAPED LIKE, `deliverAssignedTaskOnBringup`
 * (do.ts) — same injected-thunks DI, same trailing-optional `moved`, same
 * "record the dedup marker ONLY on a landed wake" discipline, tested the same
 * way with fakes and no DO construction. It runs IN SEQUENCE ALONGSIDE that
 * hook from the same three bring-up choke points (do.ts's
 * `deliverBringupWakes`), never instead of it.
 *
 * WAKE REUSE — ONE SINGLE-FLIGHT LOCK, NOT A SECOND ONE. The `wake` thunk
 * must be the DO's OWN `wakeStudioOnAssignment(prompt)`, the very method
 * #229's delivery already calls, so both wakes go through the SAME per-DO
 * `wakeLock` (#141) rather than this feature standing up a second, competing
 * wake path beside it. `singleFlightWake` REFUSES a wake while the lock is
 * held (it does not queue) and releases in a `finally`, so the two deliveries
 * must run IN SEQUENCE — awaited one after the other — for the second to find
 * the lock free. That sequencing is the caller's job and is exactly what
 * do.ts's `deliverBringupWakes` exists to guarantee.
 *
 * This file therefore contains NO lock, NO `runGatedWake` call and NO
 * container exec of its own — exactly like `deliverAssignedTaskOnBringup`
 * delegates its whole gate stack (stopped, limit modal, rate limit,
 * single-flight) to the injected thunk.
 *
 * ORDER OF GATES, and why each sits where it does:
 *  1. `bringup()` — null (no bring-up verdict recorded) means there is
 *     nothing to describe.
 *  2. The ALLOWLIST (`survivalBriefAllowed`). Before any I/O: a `failover`
 *     or `adopted` bring-up must cost nothing at all.
 *  3. DEDUP, PER INCARNATION. A null incarnation is SKIPPED rather than
 *     recorded against — writing `null` as the marker would make the
 *     comparison `null === null` true forever and permanently suppress the
 *     re-brief on a studio whose incarnation write keeps failing.
 *  4. `moved()`, CHECK ONE — BEFORE the busy probe, because that probe is
 *     itself a container exec and an exec STARTS a stopped container
 *     (#152/#174's hazard class: a destroy that already landed must not be
 *     undone by this feature's own observation).
 *  5. `compose()` — no container exec, no writes. Deliberately before the
 *     probe: composing takes several GitHub round trips, and quiescence
 *     evidence goes stale fast, so the probe sits as close to the wake as it
 *     can. An EMPTY brief (PR4a's own "nothing survived" signal) skips
 *     without writing a marker.
 *  6. BUSY (`paneBusy`) — either signal true and this tick delivers nothing
 *     and writes NOTHING, so the next bring-up retries for free. Never
 *     forced.
 *  7. `moved()`, CHECK TWO — immediately before the wake, so a destroy that
 *     landed during the 3-second probe or the compose still vetoes.
 *
 * `moved` defaults to "never moved", the same trailing-optional shape
 * `deliverAssignedTaskOnBringup`'s own `moved` param uses, so a test that
 * does not care about the destroy race need not pass one. `now` is the same
 * shape and exists for the round-2 pending marker's timestamps.
 *
 * ROUND-2 ITEM 2: everything from the `moved` check down now lives in
 * `attemptSurvivalDelivery` below, shared byte-for-byte with
 * `retryPendingSurvivalBrief` — the retry must run the IDENTICAL gate stack
 * (destroy veto, compose, busy probe, destroy veto, wake, marker) or it would
 * be a second definition of "safe to type into this pane".
 */
export async function deliverSurvivalBriefOnBringup(
  storage: ObservedStorage,
  bringup: () => Promise<SurvivalBringup | null>,
  busy: () => Promise<BusyVerdict>,
  compose: () => Promise<ComposedBrief>,
  wake: (prompt: string) => Promise<WakeOutcome>,
  moved: () => Promise<boolean> = async () => false,
  now: () => Date = () => new Date(),
): Promise<SurvivalDeliveryOutcome> {
  const b = await bringup();
  if (b === null) return { kind: "skipped", reason: "no bring-up verdict recorded" };

  if (!survivalBriefAllowed(b.via, b.replacementDetected)) {
    return {
      kind: "skipped",
      reason: `via ${b.via}${b.replacementDetected ? " with a detected replacement" : ""} is not a re-brief trigger`,
    };
  }

  if (b.incarnation === null) {
    return { kind: "skipped", reason: "this bring-up has no incarnation token to record a delivery against" };
  }
  const observed = await getObserved(storage);
  if ((observed.survivalBriefDeliveredFor ?? null) === b.incarnation) {
    return { kind: "skipped", reason: `already delivered for incarnation ${b.incarnation}` };
  }

  // The pending record this bring-up would DEFER into, if it defers. `since`
  // is carried over from an existing record for the SAME incarnation (stamped
  // once, never re-stamped — the time bound must measure from the first
  // deferral, not the most recent one); a record for an older incarnation is
  // superseded outright, since it describes a container that is gone.
  const carried = observed.survivalBriefPending ?? null;
  const priorForThis = carried !== null && carried.incarnation === b.incarnation ? carried : null;
  const pending: SurvivalBriefPending = {
    incarnation: b.incarnation,
    via: b.via,
    replacementDetected: b.replacementDetected,
    session: b.session,
    since: priorForThis?.since ?? now().toISOString(),
    attempts: priorForThis?.attempts ?? 0,
    reason: "",
  };
  return attemptSurvivalDelivery(storage, pending, busy, compose, wake, moved);
}

/**
 * Issue #249 (PR4b) round 2, item 2 — THE RETRY, run by the regular per-studio
 * sync tick (`syncSessionCycle`, do.ts, every SYNC_SESSION_SECONDS).
 *
 * Round 1's delivery was fire-and-forget: a busy lead meant the brief was
 * dropped, and the only thing that could try again was another BRING-UP. That
 * reads fine until you notice what actually happens at bring-up — #229's
 * assigned-task pointer is typed from the SAME hook, and a lead that has just
 * been handed a task pointer is a lead mid-turn. The re-brief's own busy probe,
 * running seconds later, therefore saw a busy pane on exactly the bring-ups
 * that needed the brief most, and "the next bring-up retries" meant "the next
 * time this container is destroyed and rebuilt", which on a healthy studio may
 * be never. (The bring-up ORDER is fixed too — see do.ts's
 * `deliverBringupWakes` — but order alone is not enough: a lead can be mid-turn
 * for its own reasons, and a board outage can defer a brief with no busy lead
 * involved at all.)
 *
 * SO: this reads the persisted `Observed.survivalBriefPending` and, when one is
 * owed, runs the SAME `attemptSurvivalDelivery` the bring-up path runs. It is
 * NOT a second delivery implementation, and it decides nothing the bring-up
 * already decided: the allowlist verdict, the incarnation identity and the
 * session record all come off the frozen pending record.
 *
 * COSTS NOTHING ON A HEALTHY STUDIO. The storage read is the FIRST thing and
 * the only thing when nothing is owed — no container exec, no GitHub read, no
 * board read, no wake. That ordering is load-bearing, not incidental: this runs
 * on every studio every 300s, and the busy probe alone is a container exec that
 * would START a stopped container (the #152/#174 hazard class the bring-up path
 * already guards with `moved`).
 *
 * THE BOUND is checked before any of that work, from the record's own
 * `attempts`/`since` — see `SURVIVAL_RETRY_MAX_ATTEMPTS` and
 * `SURVIVAL_RETRY_WINDOW_MS` for the two numbers and why each exists. Exceeding
 * it stamps `gaveUpAt` and stops; the record is KEPT so `fleet ls` can render
 * `re-brief undelivered` (cli/readiness-format.ts's `formatSurvivalBriefs`)
 * instead of the brief simply disappearing, which is #107's original complaint
 * in miniature.
 *
 * A RECORD WHOSE INCARNATION HAS MOVED ON IS DROPPED, not delivered: the
 * container it describes has been replaced, so its "what survived" is about a
 * disk that no longer exists — and the replacement's own bring-up has already
 * had its own turn at delivering a fresh brief.
 */
export async function retryPendingSurvivalBrief(
  storage: ObservedStorage,
  busy: () => Promise<BusyVerdict>,
  compose: (pending: SurvivalBriefPending) => Promise<ComposedBrief>,
  wake: (prompt: string) => Promise<WakeOutcome>,
  moved: () => Promise<boolean> = async () => false,
  now: () => Date = () => new Date(),
): Promise<SurvivalDeliveryOutcome> {
  const observed = await getObserved(storage);
  const pending = observed.survivalBriefPending ?? null;
  if (pending === null) return { kind: "skipped", reason: "no survival re-brief is owed" };

  if (observed.incarnation !== null && observed.incarnation !== pending.incarnation) {
    await mergeObserved(storage, { survivalBriefPending: null });
    return {
      kind: "skipped",
      reason: `the owed re-brief describes incarnation ${pending.incarnation}, which has since been replaced`,
    };
  }

  if ((observed.survivalBriefDeliveredFor ?? null) === pending.incarnation) {
    await mergeObserved(storage, { survivalBriefPending: null });
    return { kind: "skipped", reason: `already delivered for incarnation ${pending.incarnation}` };
  }

  if (pending.gaveUpAt) {
    return {
      kind: "skipped",
      reason: `re-brief undelivered since ${pending.since}, gave up at ${pending.gaveUpAt}`,
    };
  }

  const exhausted = retryBoundExceeded(pending, now());
  if (exhausted !== null) {
    const gaveUpAt = now().toISOString();
    await mergeObserved(storage, { survivalBriefPending: { ...pending, gaveUpAt, reason: exhausted } });
    return { kind: "gave-up", reason: exhausted, attempts: pending.attempts };
  }

  return attemptSurvivalDelivery(storage, pending, busy, () => compose(pending), wake, moved);
}

/**
 * Round-2 item 2 — the two bounds, as one answer: the reason retrying must
 * stop, or null while it may continue. Pure, so both numbers are pinned by a
 * test rather than only observed through a sequence of fake ticks.
 *
 * An UNPARSEABLE `since` does not grant infinite retries: it falls through to
 * the attempt bound alone, which is total. The alternative (treating it as
 * "elapsed unknown, therefore expired") would throw away a genuinely owed
 * brief over a storage-shape problem.
 */
export function retryBoundExceeded(pending: SurvivalBriefPending, now: Date): string | null {
  if (pending.attempts >= SURVIVAL_RETRY_MAX_ATTEMPTS) {
    return `${pending.attempts} delivery attempts, none landed (limit ${SURVIVAL_RETRY_MAX_ATTEMPTS})`;
  }
  const since = Date.parse(pending.since);
  if (!Number.isNaN(since) && now.getTime() - since >= SURVIVAL_RETRY_WINDOW_MS) {
    const minutes = Math.floor(SURVIVAL_RETRY_WINDOW_MS / 60_000);
    return `still undelivered ${minutes}m after the bring-up that owed it`;
  }
  return null;
}

/**
 * Round-2 item 2 — the gate stack BOTH entry points run, and the only place
 * that ever writes either marker.
 *
 * ORDER OF GATES is `deliverSurvivalBriefOnBringup`'s own documented order,
 * unchanged from round 1 (destroy veto, compose, busy probe, destroy veto,
 * wake) — see that function's doc comment for why each step sits where it
 * does. What round 2 changes is only what happens on the way OUT:
 *
 *  - DELIVERED: the dedup marker is written and the pending record CLEARED, in
 *    one merge. Two separate writes would leave a window where a crash between
 *    them re-delivers (marker missing) or never retries (pending missing).
 *  - A DESTROY VETO persists nothing at all, and deliberately does not even
 *    advance `attempts`: a destroy is not a failed delivery attempt, it is the
 *    studio going away, and burning an attempt on it would let three quick
 *    destroy races exhaust a brief that was never actually tried.
 *  - AN EMPTY BRIEF clears the pending record. PR4a's empty string means
 *    "nothing survived worth saying", and continuing to retry saying nothing
 *    would keep a `re-brief undelivered` line on the row over a brief that was
 *    never owed.
 *  - EVERYTHING ELSE (a busy lead, a deferred compose, a refused or
 *    unconfirmed wake) DEFERS: `attempts` advances, `since` does not, and the
 *    sync tick tries again.
 */
async function attemptSurvivalDelivery(
  storage: ObservedStorage,
  pending: SurvivalBriefPending,
  busy: () => Promise<BusyVerdict>,
  compose: () => Promise<ComposedBrief>,
  wake: (prompt: string) => Promise<WakeOutcome>,
  moved: () => Promise<boolean>,
): Promise<SurvivalDeliveryOutcome> {
  const defer = async (reason: string): Promise<SurvivalBriefPending> => {
    const next: SurvivalBriefPending = {
      ...pending, attempts: pending.attempts + 1, reason: redactSecrets(reason), gaveUpAt: null,
    };
    await mergeObserved(storage, { survivalBriefPending: next });
    return next;
  };

  if (await moved()) return { kind: "skipped", reason: "a destroy landed before the busy probe" };

  const composed = await compose();
  if (typeof composed !== "string") {
    const next = await defer(composed.defer);
    return { kind: "deferred", reason: composed.defer, attempts: next.attempts };
  }
  if (composed.trim() === "") {
    await mergeObserved(storage, { survivalBriefPending: null });
    return { kind: "skipped", reason: "nothing survived worth re-briefing" };
  }

  const verdict = await busy();
  if (verdict.busy) {
    const next = await defer(verdict.reason);
    return { kind: "deferred", reason: verdict.reason, attempts: next.attempts };
  }

  if (await moved()) return { kind: "skipped", reason: "a destroy landed before the wake" };

  const outcome = await wake(composed);
  if (!outcome.ok) {
    await defer(outcome.error ?? "the wake did not land, with no reason given");
    return { kind: "refused", wake: outcome };
  }
  await mergeObserved(storage, {
    survivalBriefDeliveredFor: pending.incarnation, survivalBriefPending: null,
  });
  return { kind: "delivered", incarnation: pending.incarnation };
}
