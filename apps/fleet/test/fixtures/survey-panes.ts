/**
 * Issue #158 — Claude Code's own feedback-survey overlay. UNMEASURED: no real
 * `tmux capture-pane -p` of this overlay exists anywhere in this repo, unlike
 * every fixture in test/fixtures/rate-limit-panes.ts (VERBATIM/REBUILT, that
 * file's own doc comment). The field note on #158 (2026-10-01 02:56Z,
 * rafarc21) is the only evidence: "options 1/2/3/0 above the prompt", "no ▔
 * rule" — i.e., NOT drawn inside the same boxed-modal chrome every rate-limit
 * / permission-prompt fixture in this repo uses.
 *
 * Built the SAME way test/fixtures/activity-panes.ts's own REBUILT fixtures
 * are: a real, verbatim base pane (RECOVERED_IDLE-shaped — claude idle, RULE_PROMPT
 * chrome, rate-limit-panes.ts's own RULE_PROMPT) with a plausible survey block
 * spliced in above the prompt, in place of nothing (the idle pane has no
 * status line to replace). Deliberately CONSERVATIVE per the #158 plan's own
 * Design §2: each option row is BARE (just a digit and a short, single-word
 * label) and there is no ▔ rule anywhere near it — the two properties the new
 * detector keys on, chosen specifically to avoid the two shapes already
 * REJECTED for LOOSE_LIMIT_PATTERNS (PR #102's first cut, #146): a lead's own
 * numbered prose and the ghost-composer row both carry a full word or
 * sentence after the number, never a bare one.
 *
 * Follow-up, stated in the plan's own Residuals: capture a REAL pane the next
 * time this overlay appears and feed it back as a VERBATIM fixture here,
 * replacing this UNMEASURED one.
 */
import { RULE_PROMPT } from "./rate-limit-panes";

/** UNMEASURED (see this file's own doc comment above). */
export const SURVEY_OVERLAY_PANE = [
  "⏺ Resumed.",
  "",
  "  How is Claude Code working for you?",
  "  1  Great",
  "  2  Good",
  "  3  Okay",
  "  0  Skip",
  "",
  ...RULE_PROMPT,
].join("\n");

/** Same idle base, no survey overlay — the ordinary idle pane the new gate
 *  must NOT refuse (no-regression leg). */
export const RECOVERED_IDLE_PANE = ["⏺ Resumed.", "", ...RULE_PROMPT].join("\n");
