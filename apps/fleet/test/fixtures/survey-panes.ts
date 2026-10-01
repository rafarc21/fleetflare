/**
 * Issue #158, maestro round-2 review (PR #170) finding 1 — Claude Code's own
 * feedback-survey overlay, redesigned against the REAL shape (Claude Code
 * 2.1.286, directly observed by the repo owner, not a blind guess): ONE row
 * `1: Bad    2: Fine   3: Good   0: Dismiss`, drawn under a header line
 * `● How is Claude doing this session? (optional)`. Not VERBATIM (no raw
 * `tmux capture-pane -p` byte-for-byte exists in this repo yet), but no
 * longer honestly UNMEASURED either — this is the real shape as reported,
 * pending an actual raw capture (follow-up, stated in the plan's own
 * Residuals: replace with a VERBATIM fixture the next time the overlay is
 * captured directly).
 *
 * The ORIGINAL (first-round) fixture here — "1  Great" / "2  Good" /
 * "3  Okay" / "0  Skip" stacked on four separate bare rows — was invented
 * rather than measured, and round-2 review found it didn't match the real
 * shape at all (everything is on ONE row; "Dismiss" alone is 7 characters,
 * past the old stacked-row detector's own 6-character cap) AND still
 * false-positived on an ordinary lead's own short numbered list (e.g.
 * "1. Done" / "2. Merged" — finding 2, same review). Both are why the
 * detector itself was redesigned to anchor on the header line's own text
 * together with the choice row, not bare short rows alone — see
 * `surveyOverlayOnScreen`'s own doc comment (`wake.ts`).
 *
 * Built the SAME way `test/fixtures/activity-panes.ts`'s own REBUILT
 * fixtures are: a real, verbatim base pane (RECOVERED_IDLE-shaped — claude
 * idle, `rate-limit-panes.ts`'s own `RULE_PROMPT` chrome) with the survey
 * block spliced in above the prompt, in place of nothing (the idle pane has
 * no status line to replace).
 */
import { RULE_PROMPT } from "./rate-limit-panes";

/** The real shape, as reported (see this file's own doc comment above). */
export const SURVEY_OVERLAY_PANE = [
  "⏺ Resumed.",
  "",
  "● How is Claude doing this session? (optional)",
  "1: Bad    2: Fine   3: Good   0: Dismiss",
  "",
  ...RULE_PROMPT,
].join("\n");

/** Same idle base, no survey overlay — the ordinary idle pane the new gate
 *  must NOT refuse (no-regression leg). */
export const RECOVERED_IDLE_PANE = ["⏺ Resumed.", "", ...RULE_PROMPT].join("\n");

/**
 * Finding 2 (maestro round-2 review, PR #170) — the false-positive trigger
 * the FIRST-round detector tripped on: a lead's own short numbered status
 * list, no survey header anywhere near it. The redesigned detector
 * (header + choice row, both required) must NOT flag this, since neither
 * row carries the `N: label` colon shape and no header line is present.
 */
export const LEAD_NUMBERED_LIST_PANE = [
  "⏺ Wrapped up the release checklist.",
  "",
  "1. Done",
  "2. Merged",
  "",
  ...RULE_PROMPT,
].join("\n");
