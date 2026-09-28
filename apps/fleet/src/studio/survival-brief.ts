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
}

/** Lines per section before the rest collapses to a single "+N more". Keeps
 *  a re-brief with a busy fleet readable and its size predictable. */
const MAX_LINES_PER_SECTION = 8;

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

export function composeSurvivalBrief(input: SurvivalInput): string {
  const genuinelyEmpty =
    input.tasks.ok && input.tasks.value.length === 0 &&
    input.openPrs.ok && input.openPrs.value.length === 0 &&
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

  lines.push(sessionLine(input.session));
  if (input.session?.verdict === "resumed") lines.push(RESUMED_TRUST_ORIGIN_LINE);

  return lines.join("\n");
}
