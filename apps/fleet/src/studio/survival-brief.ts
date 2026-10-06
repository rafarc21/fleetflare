// apps/fleet/src/studio/survival-brief.ts

/**
 * Board issue #107 -- a restarted lead's re-brief, composed. Measured
 * 2026-09-24: a lead told what survived (its task branches still on origin)
 * recovered in 6 minutes; three earlier rounds without that re-brief lost
 * everything. This module is the PURE composition only -- no I/O, no
 * delivery. See docs/superpowers/specs/2026-09-24-row-tells-truth-design.md's
 * "PR4a" section for the full design.
 *
 * Re-review fix (#107): PR1 (#85) merged to main as `075b14a`. This file now
 * imports its real `ObservedSession` TYPE from `./observed` -- a normal
 * same-layer, sibling-file import inside `src/studio/`, not a layering
 * violation: `cli/readiness-format.ts` imports FROM `src/studio/`, never the
 * other way, and that direction is unchanged by importing a type between two
 * files that already live in the same `src/studio/` layer. `formatAge`
 * itself stays duplicated below as `formatSurvivalAge` -- it lives in
 * `cli/`, which imports `src/`, never the reverse, so importing it FROM
 * `cli/readiness-format.ts` INTO this `src/studio/` file would be the
 * illegal direction. Consolidating the two duplicated bucketing functions,
 * once both sides agree to share one, is a one-line follow-up, not a
 * blocker for this PR.
 *
 * Review fix (#107): the composer must never conflate "we never checked"
 * with "we checked and there is genuinely nothing." Every section (tasks,
 * open PRs) is `Checked<T>` -- either `{ok: true, value}` from a completed
 * lookup, or `{ok: false, reason}` from one that failed -- and a failed
 * lookup renders "could not check (<reason>)", never a silently blank
 * section and never a dropped line.
 */

import type { ObservedSession, RestoreOutcome } from "./observed";
import { BRANCH_NAMES_MAX_PAGES, BRANCH_NAMES_PAGE_SIZE } from "../github/api";
import type { AsideShipRecord } from "./session-sync";

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SurvivalTaskBranch {
  taskNumber: number;
  taskTitle: string;
  /** `null` when the task has no branch on origin at all -- distinct from a
   *  branch that exists but has 0 commits ahead of main. */
  branch: string | null;
  /** Already resolved by the caller from GitHub's compare API
   *  (`main...<branch>`, reading `ahead_by` -- same pattern
   *  `src/github/api.ts`'s `commitReachableFromBranch` uses). NEVER `git
   *  log` run inside a studio's own clone: studio clones are shallow and
   *  single-branch, so that count reads a genuinely 0-ahead branch as 1-3
   *  ahead (measured, #107). Issue #98's own lesson still applies: an
   *  empty-but-pushed branch must never read as survived work -- but 0 is a
   *  real, CHECKED value and must render as EMPTY, never be dropped or
   *  confused with "never checked" (null/NaN/negative, which render
   *  "commits ahead unknown"). */
  commitsAheadOfMain: number | null;
  lastCommitAt: string | null;
  /**
   * Issue #234, SOURCE 4's own "never guess" outcome: more than one branch
   * on origin anchored-matched this task's number (`matchesTaskNumber`,
   * survival-delivery.ts) and `resolveSurvivalInput` refused to pick one —
   * same "a wrong guess is worse than silence" reasoning
   * `attributeRescueBranch`'s own doc comment gives for SOURCE 3's ambiguous
   * case. Populated ONLY in that ambiguous case; `branch` stays `null`
   * alongside it, but `taskLine` must render this differently from the
   * ordinary "no branch on origin" (zero matches) — a reader needs to tell
   * "found none" and "found several, could not pick" apart, always.
   */
  ambiguousBranches?: string[];
}

/**
 * Maestro review round 1 on PR #245 (issue #241), MAJOR 2 + MINOR 3 — one
 * live wip-sync ref, paired with the last-commit time `survival-delivery.ts`
 * managed to resolve for it via `compareAhead`, or `null` when it could not
 * (a thrown error, or a `compareAhead` 404 -- the "parentless snapshot"
 * case neither of which means the ref is gone; see that file's own
 * age-filter loop). `branch`'s own embedded boot stamp is still read for
 * SORTING (newest boot first, `composeSurvivalBrief`'s own section) -- a
 * weaker, display-ordering-only use that stays fine even though the boot
 * stamp is no longer trusted for the age/staleness DECISION itself.
 */
export interface SurvivalWipRef {
  branch: string;
  lastCommitAt: string | null;
}

export interface SurvivalOpenPr {
  number: number;
  title: string;
  branch: string;
}

export interface SurvivalInput {
  studioId: string;
  tasks: Checked<SurvivalTaskBranch[]>;
  openPrs: Checked<SurvivalOpenPr[]>;
  /**
   * MAJOR fix (fresh-context review on #207, 2026-10-03): SOURCE 3's own
   * rescue refs (survival-delivery.ts's `rescueBranchesFor`) that
   * `attributeRescueBranch` could NOT safely assign to any unresolved task
   * -- either genuinely ambiguous (more than one unresolved task, more than
   * one candidate ref, or both) or simply left over once attribution ran.
   * `attributeRescueBranch`'s own doc comment explains why a wrong guess is
   * worse than silence, and that silence is exactly the bug this field
   * fixes: before this field existed, every one of these refs vanished —
   * the lead never learned a rescue ref existed for its own studio at all.
   * Rendered as its own line per ref (see `composeSurvivalBrief` below) so
   * a lead can go find it by name even though this composer could not
   * safely guess which task, if any, it belongs to. `{ok: true, value: []}`
   * when nothing is left unclaimed (including the common case: every task
   * already had a branch, or exactly one task matched exactly one ref and
   * was attributed).
   *
   * MEDIUM fix (#228, review on #227): widened from a bare `string[]` to
   * `Checked<string[]>` -- `resolveSurvivalInput`'s own fetch of this list
   * (`sources.rescueBranches()`) can throw (a GitHub 5xx, rate-limit, or
   * network blip), and before this fix that exception propagated out of the
   * WHOLE `resolveSurvivalInput` call, failing every other section's worth of
   * work over one section's transient failure. Same "a failed lookup renders
   * 'could not check (<reason>)', never a silently blank section" discipline
   * `tasks`/`openPrs` already follow (this file's own header comment) --
   * attribution cannot run without the ref list, so a failed fetch leaves
   * every unresolved task's `branch: null`, exactly as it would if there
   * were genuinely zero refs.
   */
  unclaimedRescueBranches: Checked<string[]>;
  /**
   * Issue #241, item 1 — SOURCE 3's own wip-sync refs (`survival-delivery.ts`'s
   * `isWipRescueRef`: main checkout's `wip/<14digits>`, member worktree's
   * `wip/<14digits>-wt-<id>`), partitioned OUT of `unclaimedRescueBranches`
   * and out of `attributeRescueBranch`'s candidate pool entirely, before
   * either ever runs. A wip ref is a LIVE, periodically-refreshed safety
   * net, not an abandoned teardown rescue -- attributing one to a task is
   * nonsense (item 3's own fix, a direct consequence of this exclusion), and
   * labeling it "unclaimed" implies an abandonment it doesn't have. Rendered
   * as its own "Live wip snapshot" line (see `liveWipSnapshotLine` below),
   * worded distinctly from `unclaimedRescueLine` so neither section is ever
   * mistaken for the other. Same `Checked<T>` discipline as
   * `unclaimedRescueBranches` -- a failed rescue-branch fetch, or a failed
   * task lookup, fails this section too, symmetrically.
   *
   * Maestro review round 1 on PR #245 (issue #241), MAJOR 2 + MINOR 3 —
   * widened from a bare `string[]` to `SurvivalWipRef[]`: a wip ref's own
   * embedded boot stamp can no longer be trusted as "the ref is gone" on a
   * `compareAhead` 404 (see `survival-delivery.ts`'s own age-filter loop's
   * doc comment for the full "parentless snapshot" reasoning) -- callers
   * now KEEP a ref whose age could not be confirmed, and need somewhere to
   * carry "age unknown" through to the render side (`liveWipSnapshotLine`
   * below) rather than just a bare name.
   */
  liveWipRefs: Checked<SurvivalWipRef[]>;
  /**
   * Maestro review round 2 on PR #245 (issue #241), problem 3 -- MINOR 4
   * (`survival-delivery.ts`'s own age-filter loop doc comment) now caps
   * `liveWipRefs` ITSELF to the newest `MAX_LINES_PER_SECTION` entries
   * BEFORE any `compareAhead` call runs, so `liveWipRefs.value.length` can
   * never exceed the display cap any more -- the render step's own "+N
   * more" overflow line below, computed from that same length, could then
   * never fire, even for a studio with far more than 8 live wip refs. This
   * carries the TRUE, pre-cap candidate count alongside the already-capped
   * list, so the overflow line can report the real number of refs beyond
   * what was shown (and beyond what ever got `compareAhead`-checked at
   * all) rather than silently dropping the "+N more" indicator. OPTIONAL,
   * defaulting to `liveWipRefs.value.length` when absent (a direct
   * `SurvivalInput` fixture that predates this field, or one with 8 or
   * fewer refs where no capping ever happened) -- same "absent means as
   * before" discipline `branchLookupTruncated` above already follows.
   */
  liveWipRefsTotalCount?: number;
  /** PR1's (#85) own bring-up verdict record, passed through as-is -- null
   *  before any bring-up has completed under that feature. Replaces the
   *  bare `lastSnapshotAgeS: number | null` this field used to be: PR1's
   *  `ObservedSession.snapshotAgeS` is a value computed ONCE, AT RESTORE
   *  TIME (`observed.ts`'s own doc comment on that field) -- never
   *  recomputed from a stored timestamp at composition time the way
   *  `lastCommitAt` below is. See `sessionLine`'s own doc comment for the
   *  exact rendering rule. */
  session: ObservedSession | null;
  /** ISO timestamp -- every OTHER age on this input (task branches'
   *  `lastCommitAt`) is computed from this, never pre-rendered and stored
   *  (Principle 1, same as PR1's Observed record). `session.snapshotAgeS`
   *  is the one exception -- see its own field doc comment above. */
  now: string;
  /**
   * Board issue #208, part 2 -- `Observed.wipSyncedAt` as it stood AT THE
   * MOMENT OF THIS BRING-UP (frozen the same way `session` above is -- see
   * `SurvivalBriefPending.wipSyncedAt`'s own doc comment, observed.ts). Only
   * ever rendered when `session.via === "heal"` (the `BARE_SELF_HEALED` path,
   * do.ts) -- see `composeSurvivalBrief`'s own WIP-safety-net section below
   * for why that gate lives here and not at a caller. OPTIONAL/null means
   * either this is not a heal bring-up, or no WIP sync had ever landed before
   * it -- either way, nothing to say.
   */
  wipSyncedAt?: string | null;
  /**
   * PR #239 review finding 1 -- true when `resolveSurvivalInput`'s own
   * `sources.branchNames()` fetch (SOURCE 4, survival-delivery.ts) hit
   * `listAllBranchNames`'s page cap (`BRANCH_NAMES_MAX_PAGES`,
   * src/github/api.ts) while GitHub still had more branches to offer. The
   * task-number match SOURCE 4 runs is only as complete as the branch list
   * it searched -- a task branch living past the cap reads exactly like one
   * that is not on origin at all, and a reader of this brief must be told
   * the search itself was incomplete rather than trust a false "no branch on
   * origin". Absent/undefined (never a stored `false`) when the lookup never
   * ran or never hit the cap -- same "absent stays absent" discipline every
   * other optional field on this interface already follows.
   */
  branchLookupTruncated?: boolean;
  /**
   * Maestro review round 2 on PR #235 (issue #231), item 1 --
   * `Observed.wipSyncedBootStamp` as it stood AT THE MOMENT OF THIS BRING-UP
   * (frozen the same way `wipSyncedAt` above is) -- the exact ref the last
   * GENUINELY SYNCED push actually targeted. `wipSyncLine` renders this
   * instead of `wipBootStamp` below: `wipBootStamp` answers "what container
   * was this before", which is the wrong question whenever a SECOND bring-up
   * happens with no wip-sync tick in between -- it would then name the
   * FIRST bring-up's own fresh, never-synced stamp right next to an age
   * that describes a push from an even earlier incarnation. OPTIONAL/null:
   * no push has ever landed -- the glob fallback is used, same as
   * `wipBootStamp` below's own absent case.
   */
  wipSyncedBootStamp?: string | null;
  /**
   * Issue #231 fix 2a -- `Observed.wipBootStamp` as it stood AT THE MOMENT OF
   * THIS BRING-UP (frozen the same way `wipSyncedAt` above is).
   *
   * Maestro review round 2 on PR #235 (issue #231), item 1 -- no longer read
   * by `wipSyncLine` (superseded by `wipSyncedBootStamp` above, which names
   * what was actually SYNCED rather than what container this WAS); kept on
   * the wire and still threaded through `resolveSurvivalInput` for
   * back-compat and because `ObservedSession.wipBootStampBefore` (the field
   * this is sourced from) may still matter for other reasoning. OPTIONAL/
   * null: no confirmed boot stamp at bring-up time.
   */
  wipBootStamp?: string | null;
  /**
   * Issue #231 fix 2b -- `Observed.lastSessionAside` as it stood AT THE
   * MOMENT OF THIS BRING-UP (frozen the same way `session` above is): the
   * real on-disk path(s) a confirmed `--fresh-session` move actually went
   * to. Rendered as its own line, only when non-null/non-empty -- a lead
   * told "what survived" after a LATER heal otherwise has no way to learn an
   * old session was moved aside, or where.
   */
  lastSessionAside?: string[] | null;
  /**
   * Maestro review round 1 on PR #235, MAJOR 3 (issue #231) — WHEN
   * `lastSessionAside` above was stamped, so `sessionAsideLine` can render an
   * honest age next to the claim rather than repeat it as freshly-true
   * forever (`lastSessionAside` itself never auto-clears — see its own doc
   * comment, observed.ts). OPTIONAL/null: renders "unknown age" rather than
   * suppressing the line.
   */
  lastSessionAsideAt?: string | null;
  /**
   * Maestro review round 2 on PR #235 (issue #231), item 2b --
   * `Observed`'s own `ASIDE_SHIP_KEY` record (session-sync.ts's
   * `AsideShipRecord`), as it stood AT THE MOMENT OF THIS BRING-UP (frozen
   * the same way `lastSessionAside` above is). Three distinct states, not
   * two:
   *   - UNDEFINED/absent -- no ship attempt has run since the move at all
   *     (`shipAsideSessions` has never ticked, or this bring-up predates the
   *     field). `sessionAsideLine` below must not claim the R2 copy exists
   *     in this case -- nothing has tried yet.
   *   - `null` -- a ship attempt ran and nothing in `lastSessionAside`
   *     failed (`ASIDE_SHIP_KEY`'s own writer, do.ts, stores exactly `null`
   *     once `failed` comes back empty). This is the only state in which
   *     the confident R2 path may be rendered.
   *   - `{ failed: [...] }` -- a ship attempt ran and recorded failures,
   *     keyed by the aside dir's own full name (the same string
   *     `asideRefPath` derives from the local path). A dir NOT in `failed`
   *     still reads as "confirmed" even when this record is present, same
   *     as the `null` case.
   */
  asideShip?: AsideShipRecord | null;
}

/** Lines per section before the rest collapses to a single "+N more". Keeps
 *  a re-brief with a busy fleet readable and its size predictable.
 *  Exported (maestro review round 1 on PR #245, issue #241, MINOR 4) so
 *  `survival-delivery.ts`'s own wip-ref `compareAhead` cap reuses this exact
 *  number rather than inventing a second display-cap constant that could
 *  drift from it -- there is no point looking up a ref's age that this
 *  section's own cap would immediately truncate into "+N more" anyway. */
export const MAX_LINES_PER_SECTION = 8;

/** Free text (task/PR titles, failure reasons) never enters the pane
 *  unfiltered: C0/C1 controls, collapsed whitespace, a stripped word-leading
 *  '/' (a wrapped `/rate-limit-options` at the start of a row trips #141's
 *  anchored modal check -- measured), and a length cap so one long title
 *  cannot blow the output budget. Review note (#107 round 2): the
 *  word-leading '/' strip is a blunt instrument -- it also fires on a
 *  genuinely absolute path (e.g. a `cwd /container-server` reason renders as
 *  "cwd container-server", silently losing the fact the path was absolute).
 *  Accepted trade-off: this line exists for terminal safety, not path
 *  fidelity, and no failure reason in this composer depends on the leading
 *  slash surviving. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_FREE_TEXT_LENGTH = 60;

function sanitizeText(raw: string): string {
  const noControl = raw.replace(CONTROL_CHARS, " ");
  const collapsed = noControl.replace(/\s+/g, " ").trim();
  const noLeadingSlash = collapsed
    .split(" ")
    .map((word) => word.replace(/^\/+/, ""))
    .join(" ");
  if (noLeadingSlash.length > MAX_FREE_TEXT_LENGTH) {
    return `${noLeadingSlash.slice(0, MAX_FREE_TEXT_LENGTH)}…`;
  }
  return noLeadingSlash;
}

function quoted(raw: string): string {
  return `"${sanitizeText(raw)}"`;
}

/** Review fix (#107 re-review): branch names get the same control-char
 *  strip, whitespace collapse, and word-leading '/' strip as `sanitizeText`
 *  above -- but NO truncation (round 2 fix: an earlier version of this
 *  function dropped the leading-'/' strip, an oversight rather than a
 *  deliberate choice; both sanitizers now share the full defense-in-depth
 *  set, differing only in truncation). The lead fetches the exact branch
 *  name to recover its own work; a truncated-with-ellipsis branch is
 *  unusable, while a truncated title is merely less readable. Whitespace is
 *  still collapsed since a real git ref never legitimately contains it --
 *  any that appears is noise, not signal, same as it would be for a
 *  title.
 *
 *  Round 4 review fix (#107, surviving mutants M31/M32): EXPORTED, so each of
 *  the two defenses this function combines -- the C0/C1 strip and the
 *  whitespace collapse -- can be pinned on its own rather than only through a
 *  rendered task or PR line. Both mutants survived the round-3 suite for the
 *  same reason: every branch fixture exercised at most one defense at a time,
 *  so a fixture carrying control chars but no RUN of whitespace still passes
 *  with the collapse deleted, and one carrying whitespace but no control char
 *  still passes with the strip deleted. test/studio.survival-brief.test.ts's
 *  "(sanitizeBranch, round 4 mutants M31/M32)" block pins each defense
 *  against the exact mutation that used to survive it, and pins that the
 *  SURROUNDING printable text ('[', '2', 'J' -- the tail of an erase-screen
 *  escape whose ESC has just been replaced) travels through untouched. */
export function sanitizeBranch(raw: string): string {
  const noControl = raw.replace(CONTROL_CHARS, " ");
  const collapsed = noControl.replace(/\s+/g, " ").trim();
  return collapsed
    .split(" ")
    .map((word) => word.replace(/^\/+/, ""))
    .join(" ");
}

function formatSurvivalAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400}d`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}h`;
  if (s < 86400) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function ageFrom(iso: string, now: string): number | null {
  const at = Date.parse(iso);
  const nowMs = Date.parse(now);
  if (Number.isNaN(at) || Number.isNaN(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 1000));
}

function taskLine(b: SurvivalTaskBranch, now: string): string {
  const prefix = `- Task #${b.taskNumber} ${quoted(b.taskTitle)}:`;

  // Issue #234, SOURCE 4's ambiguous case — checked BEFORE `branch === null`
  // below: both states share `branch: null`, but they are different answers
  // ("found several, could not pick" vs "found none") and must render
  // differently.
  if (b.ambiguousBranches !== undefined && b.ambiguousBranches.length > 0) {
    const names = b.ambiguousBranches.map(sanitizeBranch).join(", ");
    return `${prefix} ambiguous: ${b.ambiguousBranches.length} branches match (${names}) — resolve manually`;
  }

  if (b.branch === null) {
    return `${prefix} no branch on origin`;
  }

  const branch = sanitizeBranch(b.branch);
  const count = b.commitsAheadOfMain;

  if (count === null || !Number.isFinite(count) || count < 0) {
    return `${prefix} ${branch} — commits ahead unknown`;
  }

  if (count === 0) {
    return `${prefix} ${branch} — EMPTY, 0 commits ahead of main, nothing survived`;
  }

  const commitWord = count === 1 ? "commit" : "commits";
  const age = b.lastCommitAt === null ? null : ageFrom(b.lastCommitAt, now);
  const lastCommit = age === null ? "unknown" : `${formatSurvivalAge(age)} ago`;
  return `${prefix} ${branch} — ${count} ${commitWord} ahead of main, last ${lastCommit}`;
}

function prLine(pr: SurvivalOpenPr): string {
  return `- Open PR #${pr.number}: ${quoted(pr.title)} (${sanitizeBranch(pr.branch)})`;
}

/** MAJOR fix (fresh-context review on #207): one line per rescue ref nothing
 *  could be safely attributed to. `sanitizeBranch`, same as every other ref
 *  this composer renders (`taskLine`/`prLine`) -- a ref name is still
 *  free-ish text (this fleet's own convention happens to constrain it, but
 *  nothing here should assume that holds for every ref ever pushed). */
function unclaimedRescueLine(ref: string): string {
  return `- Unclaimed rescue ref: ${sanitizeBranch(ref)} (not attributed to any task)`;
}

/**
 * Issue #241, item 1 — one line per LIVE wip-sync ref (`liveWipRefs`),
 * worded distinctly from `unclaimedRescueLine` above: "unclaimed" implies
 * an abandonment a continuously-refreshed safety net doesn't have. Same
 * `sanitizeBranch` treatment as every other ref this composer renders.
 *
 * Maestro review round 1 on PR #245 (issue #241), MAJOR 2 — now takes the
 * full `SurvivalWipRef`, not a bare ref name, so an unresolved `lastCommitAt`
 * (a thrown `compareAhead`, or its own 404 -- see `survival-delivery.ts`'s
 * age-filter loop) renders "age unknown" explicitly, same "unknown" word
 * `taskLine` above already uses for the identical "we checked and could not
 * tell" situation, rather than silently omitting any age at all.
 */
function liveWipSnapshotLine(ref: SurvivalWipRef, now: string): string {
  const age = ref.lastCommitAt === null ? null : ageFrom(ref.lastCommitAt, now);
  const lastCommit = age === null ? "age unknown" : `last commit ${formatSurvivalAge(age)} ago`;
  return (
    `- Live wip snapshot: ${sanitizeBranch(ref.branch)} ` +
    `(refreshed periodically while the studio was running, not attributed to any task, ${lastCommit})`
  );
}

/** Review fix (#107 re-review): the restore outcome's own word, shown
 *  whenever `snapshotAgeS` is unknown (the "from snap" suffix below takes
 *  over once it IS known -- see `sessionLine`'s own doc comment). These
 *  words are THIS composer's own addition -- PR1's own `formatSession`
 *  (cli/readiness-format.ts) never renders the restore outcome at all. */
const RESTORE_WORDS: Record<RestoreOutcome, string> = {
  "restored": "restored",
  "skip:no-snapshot": "no snapshot existed",
  "skip:has-projects": "already had projects",
  "failed": "restore failed",
  "not-attempted": "restore not attempted",
};

/**
 * Review fix (#107 re-review): renders PR1's real `ObservedSession`, not the
 * bare `lastSnapshotAgeS` this line used to compose. Reuses PR1's own
 * verdict/turns/from-snap-age grammar (`cli/readiness-format.ts`'s
 * `formatSession`: `<verdict>[ · had <n> turns][ · from snap [≤]<age> old]`)
 * and adds this composer's OWN restore-outcome words on top (`RESTORE_WORDS`
 * above) -- PR1's own formatter never needed them because its `snap <age>`
 * suffix (a DIFFERENT signal, `Observed.lastSnapshotAt`) is always shown
 * regardless of the session verdict. This composer has no such
 * always-shown fallback signal, so when the restored snapshot's own age is
 * unknown, the restore outcome itself is the next most useful thing to say.
 *
 * Divergence from PR1's grammar (#107 round 2 review): unlike
 * `cli/readiness-format.ts`'s `formatSession`, the "from snap" suffix here
 * has NO staleness threshold -- PR1 only shows it once `snapshotAgeS >
 * UNVERIFIED_AFTER_SECONDS` (660s), because that's a live-updating CLI
 * column that only wants to flag STALE data. This is a static, one-time
 * recovery brief: a lead reading it wants the exact known age even when
 * small, so it is shown unconditionally whenever known. This is the one
 * deliberate divergence from PR1's grammar; everything else about the
 * wording/structure is reused as-is.
 *
 * Precedence, worked from four fixtures (issue #107 re-review; each letter
 * below is that review's own labeled example):
 *   (a) resumed + restore "restored" + snapshotAgeS known -> the "from snap"
 *       age suffix is shown; the restore word is SUPPRESSED. Knowing the
 *       snapshot's age is strictly more useful than knowing the restore
 *       outcome, and showing both would be redundant -- a known age already
 *       implies a restore happened.
 *   (b) fresh + restore "skip:no-snapshot" + snapshotAgeS null -> no age to
 *       show, so the restore word takes over.
 *   (c) lost + restore "failed" + snapshotAgeS null -> "had N turns" is
 *       ALWAYS shown for `lost` (same as PR1's own grammar), independent of
 *       which of the two mutually-exclusive suffixes (age vs. restore word)
 *       follows it. The restore word appears WITH its own reason
 *       parenthesized, since a failure's reason is exactly the thing an
 *       operator needs next.
 *   (d) session null, or verdict "unknown" -> neither turns, age, nor
 *       restore outcome is rendered at all; "unknown" alone (plus its
 *       reason, if one was recorded) is the whole line. A probe that never
 *       ran, or never resolved, has nothing else honest to say.
 *
 * `session.snapshotAgeS` is used exactly as recorded -- never "ago" (that
 * word implies elapsed time since observation; this is an age AT RESTORE
 * TIME, a fixed historical fact, see `ObservedSession.snapshotAgeS`'s own
 * doc comment) and never recomputed from `Observed.lastSnapshotAt` (a
 * different, unrelated field: the age of the CURRENT session's last upload,
 * not the RESTORED snapshot's age at the moment it was restored).
 */
function sessionLine(session: ObservedSession | null): string {
  if (session === null) return "- Session: unknown (no bring-up verdict recorded)";

  // Round 3 review fix (#107): a reason that sanitizes down to EMPTY (raw ""
  // or whitespace/control-chars-only) must be treated exactly like `null` --
  // omitted entirely -- never leaving a dangling " — " or empty "()" behind.
  // Computed once here, checked for emptiness (not `!== null`) at each of
  // the three call sites below.
  const why = session.reason === null ? "" : sanitizeText(session.reason);

  if (session.verdict === "unknown") {
    const reason = why === "" ? "" : ` — ${why}`;
    return `- Session: unknown (no bring-up verdict recorded)${reason}`;
  }

  const parts: string[] = [session.verdict === "lost" ? "LOST" : session.verdict];
  if (session.verdict === "lost") parts.push(`had ${session.turnsBefore} turns`);

  if (session.snapshotAgeS !== null && Number.isFinite(session.snapshotAgeS)) {
    const bound = session.snapshotAgeIsUpperBound ? "≤" : "";
    // Board #250/#286 follow-up (board #287 nit) -- names the keeper
    // (`session.snapshotSource`, e.g. "daily 2026-09-10") the same way
    // `cli/readiness-format.ts`'s `formatSession` already does, so a reader
    // of this brief can tell a keeper restore apart from a `latest` one;
    // absent for a `latest` restore, which renders exactly as before.
    const from = session.snapshotSource ? `${session.snapshotSource} ` : "";
    const ageSuffix = `from ${from}snap ${bound}${formatSurvivalAge(session.snapshotAgeS)} old`;
    // Round 2 review fix (#107 finding 1): `reason` comes from the live
    // pane-probe (`observed.ts`'s `computeSessionVerdict`), independently of
    // whether the snapshot's age is known -- a LOST verdict with a known age
    // (restore succeeded, but the live probe still found no `--continue` or
    // the wrong cwd) is exactly the "blank lead" shape this feature exists
    // to catch, so `reason` must never be dropped just because the age
    // suffix branch fired instead of the restore-word branch below.
    const reasonSuffix = session.verdict === "lost" && why !== "" ? ` (${why})` : "";
    parts.push(`${ageSuffix}${reasonSuffix}`);
  } else {
    const restoreWord = RESTORE_WORDS[session.restore];
    parts.push(why === "" ? restoreWord : `${restoreWord} (${why})`);
  }

  return `- Session: ${parts.join(" · ")}`;
}

/**
 * Issue #249 (PR4b) round-2 review, finding 1 — the one sentence a RESUMED
 * lead needs and a fresh one does not.
 *
 * The round-2 review asked whether a resumed conversation should be re-briefed
 * at all, and kept the approved spec: `recycle`/`heal` REPLACE the filesystem
 * whether or not the conversation resumes, so a resumed lead is precisely the
 * one whose memory of its own working tree is now wrong — it remembers files
 * that no longer exist on the disk it is looking at. Its own transcript is the
 * thing misleading it, which is why the brief is MORE useful there, not less.
 *
 * Shown ONLY on `resumed`. A `fresh` lead has no memory to mistrust, a `lost`
 * one already knows it lost the thread (and its own line says so), and
 * `unknown`/no-verdict cannot honestly claim a conversation resumed at all.
 */
export const RESUMED_TRUST_ORIGIN_LINE =
  "- Your conversation resumed; files were replaced — trust origin, not memory.";

/**
 * Board issue #208, part 2 -- the SAME per-boot-stamped-ref prefix
 * `wipSyncRef` (rescue.ts) pushes under. Issue #231 fix 2a: `SurvivalInput`
 * now threads `wipBootStamp` through the same path `wipSyncedAt` already
 * takes, so this renders the EXACT, real ref when it is known -- the same
 * 2-arg signature cli/wip-format.ts's own `wipSyncRefEcho` already has, kept
 * as a separate copy here (not imported) because this file lives under
 * src/studio/ and cli/wip-format.ts cannot be imported from here without
 * crossing the cli/ tsconfig boundary (that file's own header). A trailing
 * `/*` when the stamp is unknown makes the glob nature explicit rather than
 * printing a literal ref that may not exist.
 */
function wipSyncRefEcho(studioId: string, bootStamp?: string | null): string {
  return bootStamp ? `fleet/rescue/${studioId}/wip/${bootStamp}` : `fleet/rescue/${studioId}/wip/*`;
}

/**
 * Board issue #208, part 2 -- the sentence a healed lead needs that no other
 * line in this brief carries: a BARE container (`BARE_SELF_HEALED`, do.ts)
 * was restarted from a BLANK disk, so whatever was dirty or
 * committed-but-unpushed since the LAST periodic WIP sync (rescue.ts's
 * `wipSyncCmd`, every ~5 minutes while the studio was alive) is not on this
 * filesystem and not in this brief's task-branch section either -- that
 * section only ever reads origin, and a WIP snapshot's whole point is a push
 * no task branch resolution will find. Naming the ref and its age is the
 * ONLY way this brief can point a resumed lead at it.
 *
 * GATED ON `session.via === "heal" OR session.replacementDetected`,
 * deliberately -- fix round (#208 PR #215 review, minor (c)): round-2 review
 * traced a real gap `via === "heal"` alone misses -- `replacementDetected`
 * (ObservedSession's own field, set whenever `Observed.replacedAt` was
 * already non-null at bring-up time, see that field's own doc comment,
 * observed.ts) can be true on a bring-up whose `via` is `restart`/
 * `provision`/`recycle` too, not only `heal` -- any bring-up that landed
 * AFTER a replacement was already detected is exactly the case this line
 * exists for: the filesystem under the new lead is not the one the WIP sync
 * was protecting continuity for. Widening the gate to an OR, never an AND,
 * means neither condition can SUPPRESS a case the other alone would have
 * caught. A plain `restart`/`provision`/`recycle` with NO replacement
 * detected still gets no WIP-ref line, unchanged: that is the ordinary case
 * this line was never for, stamping it there would describe a container
 * that was never silently replaced out from under a running lead, which is
 * the one thing `wipSyncedAt` exists to bound. `wipSyncedAt` absent/null (no
 * WIP sync had ever landed before this bring-up) renders nothing, same "no
 * fabricated evidence" rule every other section of this composer already
 * follows.
 */
function wipSyncLine(input: SurvivalInput): string | null {
  const session = input.session;
  if (session == null) return null;
  if (!(session.via === "heal" || session.replacementDetected === true)) return null;
  if (input.wipSyncedAt == null) return null;
  const age = ageFrom(input.wipSyncedAt, input.now);
  const ageText = age === null ? "unknown age" : `${formatSurvivalAge(age)} ago`;
  // Maestro review round 2 on PR #235 (issue #231), item 1 -- `wipSyncedBootStamp`
  // (the stamp the push that set `wipSyncedAt` actually targeted), never
  // `wipBootStamp` (which answers "what container was this before", a
  // different and sometimes WRONG question across a second bring-up with no
  // sync tick between it and the first -- see `SurvivalInput.wipSyncedBootStamp`'s
  // own doc comment for the full bug this closes).
  return `- WIP safety net: ${wipSyncRefEcho(input.studioId, input.wipSyncedBootStamp)}, last synced ${ageText} — check it for anything lost since then.`;
}

/**
 * Maestro review round 1 on PR #235, MAJOR 3 (issue #231) — a replacement
 * AFTER the move wipes the local disk `lastSessionAside` names
 * (`~/.claude/projects/fleet-aside-<dir>`), so a lead reading that path on a
 * NEW container finds nothing there; only the R2-shipped copy
 * (`sessions/<studioId>/aside/<dir>/`, named in `freshSessionNoteFor`'s own
 * row note, provision.ts) is guaranteed to still exist. `<dir>` is the exact
 * same segment both paths share by construction (`parseFreshSession`'s own
 * regex, provision.ts, anchors the local path to
 * `fleet-aside-[A-Za-z0-9-]+`) — this just re-derives the R2 key from it
 * rather than keeping a second, parallel path around.
 */
/**
 * Maestro review round 2 on PR #235 (issue #231), item 2a — the stripped
 * prefix is `~/.claude/projects/` ONLY, never the longer
 * `~/.claude/projects/fleet-aside-`. The REAL R2 key
 * (`sessionAsideManifestKey`/`sessionAsidePartKey`, session-sync.ts) is
 * built from the aside dir's OWN FULL NAME, which `ASIDE_DIR_RE`
 * (session-sync.ts, `/^fleet-aside-[A-Za-z0-9-]+$/`) anchors as including
 * that `fleet-aside-` prefix — stripping it here produced an R2 path this
 * composer's own claim never actually pointed at.
 */
function asideDirName(localPath: string): string {
  const prefix = "~/.claude/projects/";
  return localPath.startsWith(prefix) ? localPath.slice(prefix.length) : localPath;
}

function asideRefPath(studioId: string, localPath: string): string {
  return `sessions/${studioId}/aside/${asideDirName(localPath)}/`;
}

/**
 * Maestro review round 1 on PR #235, MAJOR 3 — same reasoning
 * `SURVIVAL_RESCUE_REF_MAX_AGE_DAYS` (survival-delivery.ts) gives for its own
 * 14-day cap: an aside move from over 2 weeks ago is very unlikely to still
 * be relevant to today's lead, and unlike a kept ref or a retry budget, this
 * costs nothing but a brief-rendering line, so there is no pressure to cut it
 * close. A separate constant, not an import of that one — importing FROM
 * survival-delivery.ts here would cycle (that file imports
 * `composeSurvivalBrief` FROM this one).
 */
export const SURVIVAL_ASIDE_MAX_AGE_DAYS = 14;

/**
 * Issue #231 fix 2b, revised by maestro review round 1 on PR #235 (MAJOR 3)
 * -- the real on-disk path(s) a confirmed `--fresh-session` move went to.
 * `null` when nothing was moved aside (or this bring-up predates the field)
 * — never rendered in that case, same "no fabricated evidence" rule every
 * other section of this composer follows.
 *
 * Renders the R2 destination, not the local path `Observed.lastSessionAside`
 * actually stores -- see `asideRefPath`'s own doc comment for why the local
 * one may no longer exist by the time anyone reads this. An AGE is rendered
 * alongside, the same way every other timestamp-bearing line in this
 * composer already does (`wipSyncLine` above) -- `lastSessionAside` itself
 * is never auto-cleared (observed.ts's own doc comment), so this is the
 * mechanism by which a stale claim visibly ages out in the text itself,
 * rather than silently repeating as fresh fact forever. Past
 * `SURVIVAL_ASIDE_MAX_AGE_DAYS`, the line still renders (the move is still
 * real, on-disk-once evidence worth keeping) but is marked stale in words,
 * not suppressed -- dropping it would throw away the one thing this line
 * exists to preserve for no safety gain.
 *
 * Maestro review round 2 on PR #235 (issue #231), item 2b -- the confident
 * R2-path rendering above must never be asserted before a ship attempt has
 * actually CONFIRMED the copy landed. Three branches, keyed off
 * `input.asideShip` (see that field's own doc comment, `SurvivalInput`,
 * for the three states):
 *   - absent -- no ship has run since the move; renders "it will ship to
 *     R2 on the next session sync" instead of naming any R2 path at all.
 *   - this path's own dir name (`asideDirName`, same derivation
 *     `asideRefPath` uses) appears in `asideShip.failed` -- renders the
 *     recorded failure reason and says the copy has NOT reached R2 yet.
 *   - otherwise (including `asideShip: null`, or a `failed` list that
 *     names only OTHER dirs) -- the original confident R2-path rendering,
 *     unchanged.
 * With multiple paths (`lastSessionAside.length > 1`), the failed check is
 * PER DIR: any one of the moved paths landing in `asideShip.failed` is
 * enough to take the failed branch, naming that path's own reason --
 * consistent with the single-path case rather than a special case bolted
 * on beside it.
 */
function sessionAsideLine(input: SurvivalInput): string | null {
  const paths = input.lastSessionAside;
  if (paths == null || paths.length === 0) return null;
  const age = input.lastSessionAsideAt != null ? ageFrom(input.lastSessionAsideAt, input.now) : null;
  const ageText = age === null ? "unknown age" : `${formatSurvivalAge(age)} ago`;

  if (input.asideShip === undefined) {
    return (
      `- Old session moved aside locally; it will ship to R2 on the next session sync, ${ageText}; ` +
      "check it for anything lost since then."
    );
  }

  const failedByDir = new Map((input.asideShip?.failed ?? []).map((f) => [f.dir, f.reason] as const));
  const failedPath = paths.find((p) => failedByDir.has(asideDirName(p)));
  if (failedPath !== undefined) {
    const reason = sanitizeText(failedByDir.get(asideDirName(failedPath))!);
    return (
      `- Old session moved aside locally, but a prior ship attempt to R2 failed: ${reason} -- it has not ` +
      `reached R2 yet, ${ageText}; check it for anything lost since then.`
    );
  }

  const refs = paths.map((p) => asideRefPath(input.studioId, p));
  const stale = age !== null && age >= SURVIVAL_ASIDE_MAX_AGE_DAYS * 24 * 60 * 60;
  const staleNote = stale ? " (stale -- may no longer be relevant)" : "";
  return (
    `- Old session moved aside to ${refs.join(", ")} (R2 -- the local copy is gone if this container was ` +
    `later replaced), ${ageText}${staleNote}; check it for anything lost since then.`
  );
}

export function composeSurvivalBrief(input: SurvivalInput): string {
  const genuinelyEmpty =
    input.tasks.ok && input.tasks.value.length === 0 &&
    input.openPrs.ok && input.openPrs.value.length === 0 &&
    // #228: a FAILED rescue-ref check is never "genuinely nothing to
    // report" -- only a CHECKED, empty list is. Otherwise a studio whose
    // rescue-ref fetch failed and had nothing else to say would suppress the
    // whole brief, which drops the one line ("could not check") this fix
    // exists to add.
    input.unclaimedRescueBranches.ok && input.unclaimedRescueBranches.value.length === 0 &&
    // Issue #241, item 1 -- same "a FAILED check is never genuinely nothing
    // to report" discipline as `unclaimedRescueBranches` just above.
    input.liveWipRefs.ok && input.liveWipRefs.value.length === 0 &&
    input.session === null;
  if (genuinelyEmpty) return "";

  const lines: string[] = [`What survived, ${input.studioId}:`];

  if (!input.tasks.ok) {
    lines.push(`- Task branches: could not check (${sanitizeText(input.tasks.reason)})`);
  } else if (input.tasks.value.length === 0) {
    lines.push("- Task branches: none");
  } else {
    const sorted = input.tasks.value.slice().sort((a, b) => a.taskNumber - b.taskNumber);
    for (const b of sorted.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(taskLine(b, input.now));
    }
    if (sorted.length > MAX_LINES_PER_SECTION) {
      lines.push(`- +${sorted.length - MAX_LINES_PER_SECTION} more`);
    }
  }

  // PR #239 review finding 1 -- the task-branch section above is only as
  // complete as the branch list SOURCE 4 searched; say so when it was cut.
  if (input.branchLookupTruncated === true) {
    lines.push(
      `- Branch lookup truncated — results may be incomplete past ` +
      `${BRANCH_NAMES_PAGE_SIZE * BRANCH_NAMES_MAX_PAGES} branches`,
    );
  }

  if (!input.openPrs.ok) {
    lines.push(`- Open PRs: could not check (${sanitizeText(input.openPrs.reason)})`);
  } else if (input.openPrs.value.length === 0) {
    lines.push("- Open PRs: none");
  } else {
    const sorted = input.openPrs.value.slice().sort((a, b) => a.number - b.number);
    for (const pr of sorted.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(prLine(pr));
    }
    if (sorted.length > MAX_LINES_PER_SECTION) {
      lines.push(`- +${sorted.length - MAX_LINES_PER_SECTION} more`);
    }
  }

  // #228: same Checked-section rendering discipline as tasks/openPrs above --
  // a failed fetch says so by name, never a silently blank/missing section.
  if (!input.unclaimedRescueBranches.ok) {
    lines.push(`- Rescue refs: could not check (${sanitizeText(input.unclaimedRescueBranches.reason)})`);
  } else if (input.unclaimedRescueBranches.value.length > 0) {
    const sorted = input.unclaimedRescueBranches.value.slice().sort();
    for (const ref of sorted.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(unclaimedRescueLine(ref));
    }
    if (sorted.length > MAX_LINES_PER_SECTION) {
      lines.push(`- +${sorted.length - MAX_LINES_PER_SECTION} more`);
    }
  }

  // Issue #241, item 1 -- same Checked-section rendering discipline as
  // unclaimedRescueBranches just above, right next to it (both are SOURCE
  // 3's own output), but worded distinctly: a live wip snapshot is not an
  // "unclaimed" rescue ref.
  if (!input.liveWipRefs.ok) {
    lines.push(`- Live wip snapshots: could not check (${sanitizeText(input.liveWipRefs.reason)})`);
  } else if (input.liveWipRefs.value.length > 0) {
    // Maestro review round 1 on PR #245 (issue #241), MINOR 3 — DESCENDING
    // (newest boot stamp first), not the plain ascending `.sort()` this used
    // to be: an ascending sort put the OLDEST refs first, so the newest one
    // -- the one most worth a reader's attention -- was exactly the one that
    // fell into "+N more" once the list ran past the cap. `localeCompare`
    // reversed (`b` before `a`) sorts on the full ref NAME, which embeds the
    // boot stamp at a fixed position for every wip shape (`SurvivalWipRef`'s
    // own doc comment) -- a weaker, display-only use of that stamp that
    // stays fine even though it is no longer trusted for the age DECISION.
    const sorted = input.liveWipRefs.value.slice().sort((a, b) => b.branch.localeCompare(a.branch));
    const shown = sorted.slice(0, MAX_LINES_PER_SECTION);
    for (const ref of shown) {
      lines.push(liveWipSnapshotLine(ref, input.now));
    }
    // Problem 3 (review round 2 on PR #245) -- `liveWipRefsTotalCount` is
    // the TRUE pre-cap count when the caller capped `liveWipRefs` itself
    // before this composer ever saw it (MINOR 4); absent/equal to
    // `sorted.length` falls back to the plain cap-overflow check this used
    // to be.
    const total = input.liveWipRefsTotalCount ?? sorted.length;
    if (total > shown.length) {
      lines.push(`- +${total - shown.length} more`);
    }
  }

  lines.push(sessionLine(input.session));
  if (input.session?.verdict === "resumed") lines.push(RESUMED_TRUST_ORIGIN_LINE);
  // Issue #231 fix 2b — right after the session line(s), before the WIP
  // safety-net line: both describe this bring-up's own session, grouped.
  const asideLine = sessionAsideLine(input);
  if (asideLine !== null) lines.push(asideLine);
  const wipLine = wipSyncLine(input);
  if (wipLine !== null) lines.push(wipLine);

  return lines.join("\n");
}
