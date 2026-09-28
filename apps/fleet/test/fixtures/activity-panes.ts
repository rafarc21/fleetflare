/**
 * Issue #221 fix round 2, Fix 1 + Fix 6 — activity-state fixtures gathered
 * from THIS container's own running lead (`tmux -L fleet-studio capture-pane
 * -p -t studio:claude`), 2026-09-25, while this very fix round was in flight.
 *
 * PROVENANCE, per fixture, same discipline test/fixtures/rate-limit-panes.ts
 * already uses (VERBATIM vs REBUILT, stated per export):
 *
 * - REAL_LEAD_WAITING_MEMBERS_PANE / _LATER are VERBATIM: two real
 *   `capture-pane -p` reads of the SAME pane, ~16 minutes apart, taken while
 *   this fix round's own dispatching agent (this file's own author) was
 *   running as the lead's background task. The lead is architecturally
 *   BLOCKED on that background task for its own entire duration — it cannot
 *   be coaxed into a live "working" turn from inside the very subagent it is
 *   waiting on — so these two capture waiting-members instead, which the
 *   spec's own Task 4 panel-diff leg needs a real pair of anyway (the agent
 *   panel row's own timer, "3m 15s" -> "16m 3s", is the moving evidence).
 *
 * - WORKING_GLYPH_* fixtures are REBUILT, the same category
 *   test/fixtures/rate-limit-panes.ts's own V2/V3 fixtures already use for
 *   "a coordinator's exact quote, reconstructed context": the spinner line
 *   text is copied VERBATIM from this fix round's own brief (issue #221
 *   round 2, Fix 1 — glyphs and timers the coordinator had already measured
 *   live: "· Improvising… (1s · ↓ 3 tokens)", "✶ Cogitating…", and the
 *   footer shape "⏵⏵ bypass permissions on · esc to interrupt · ← for
 *   agents"), spliced into THIS file's own real, verbatim base capture
 *   (REAL_LEAD_WAITING_MEMBERS_PANE) in place of its one status line and
 *   footer — never invented pane text, no line here that was not either
 *   captured directly or quoted from the round's own measurement.
 */

/** VERBATIM, 2026-09-25T11:24:xxZ (approx — captured mid-tool-call, no
 *  explicit clock read at the instant of capture; the LATER pane below
 *  carries its own explicit UTC stamp). The lead is stopped on its own
 *  dispatched background agent (this fix round itself) — `✻ Waiting for 1
 *  background agent to finish` plus a ticking agent-panel row are BOTH
 *  present, so this single fixture proves both WAITING_MEMBERS legs (the
 *  status-line phrase and, paired with the LATER capture below, the panel
 *  diff) at once. */
export const REAL_LEAD_WAITING_MEMBERS_PANE = [
  "",
  "● Agent \"Test add-on for PR #283 (#274)\" finished · 8m 48s",
  "",
  "● #274 add-on done. Test 1: no real gap found, op-lock already gated correctly — added coverage + mutant proof. Test 2:",
  "  reused V1_STOP_AND_WAIT_PANE fixture for modal case; built question-menu fixture by deleting limit lines from existing",
  "  V1_THREE_OPTION_PANE frame (no invented pane text). 3817/3817 full suite green.",
  "",
  "  Verifying push landed, then reporting + dispatching #221.",
  "",
  "  Ran 1 shell command",
  "",
  "● Push confirmed, PR #283 head matches ef506b3. Reporting #274, then dispatching #221 round 2 (also rebases #283 per",
  "  brief).",
  "",
  "  Read 1 file, ran 1 shell command",
  "",
  "● Flat shape, no envelope/payload nesting. Fixing.",
  "",
  "  Read 1 file",
  "",
  "● #274 reported. Now dispatching #221 round 2 (also rebases #283 onto new head per brief).",
  "",
  "● Agent(PR #280 round-2 fix (#221))",
  "  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)",
  "",
  "● #221 round-2 dispatched (agent a6f91ffed6ce6eeae), 6 fixes + #283 rebase. Rescheduling fallback wake.",
  "",
  "● #274 reported, done. #221 round-2 fix + #283 rebase running (agent a6f91ffed6ce6eeae). #278 round-2 next in queue,",
  "  brief already read. Fallback wake 1500s.",
  "",
  "✻ Waiting for 1 background agent to finish",
  "",
  "─".repeat(124),
  "❯ ",
  "─".repeat(124),
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · ↓ to manage",
  "",
  "  ● main",
  "  ◯ general-purpose  PR #280 round-2 fix (#221)                                                  3m 15s · ↓ 99.1k tokens",
].join("\n");

/** VERBATIM, 2026-09-25T11:40:14.000Z (explicit UTC read at capture time via
 *  `date -u`, immediately after `tmux capture-pane`). Byte-identical to
 *  REAL_LEAD_WAITING_MEMBERS_PANE above except the agent panel row's own
 *  timer/token count — real proof the panel MOVES while the status line's
 *  own `✻ Waiting for …` wording does not. */
export const REAL_LEAD_WAITING_MEMBERS_PANE_LATER = REAL_LEAD_WAITING_MEMBERS_PANE.replace(
  "3m 15s · ↓ 99.1k tokens", "16m 3s · ↓ 227.1k tokens",
);

/** REBUILT: REAL_LEAD_WAITING_MEMBERS_PANE's own real transcript/footer,
 *  with its ONE status line replaced by a spinner line quoted verbatim from
 *  this fix round's own brief (issue #221 fix round 2, Fix 1) — measured
 *  live, glyph "·" rather than "✻" — AND the footer changed to the shape
 *  the SAME brief quotes: `esc to interrupt` painted into the FOOTER, not
 *  the status line, which is Fix 1's own root cause (the footer was never
 *  checked at all before this fix). Proves condition (a): footer alone,
 *  with a status line that carries no `esc to interrupt` of its own and an
 *  unfamiliar leading glyph. */
export const WORKING_GLYPH_DOT_FOOTER_ESC_PANE = REAL_LEAD_WAITING_MEMBERS_PANE
  .replace("✻ Waiting for 1 background agent to finish", "· Improvising… (1s · ↓ 3 tokens)")
  .replace(
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · ↓ to manage",
    "  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents",
  );

/** REBUILT, same base and same quoted-brief discipline as the fixture above,
 *  but proving condition (b) instead: a spinner-glyph status line matching
 *  the `(Ns ·` timer shape on its OWN, with an ORDINARY footer (no `esc to
 *  interrupt` anywhere) — glyph "✶", also quoted verbatim from the brief. */
export const WORKING_GLYPH_STAR_TIMER_ONLY_PANE = REAL_LEAD_WAITING_MEMBERS_PANE
  .replace("✻ Waiting for 1 background agent to finish", "✶ Cogitating… (4s · ↑ 2.1k tokens)");

/** REBUILT from REAL_WEBSTUDIO_PANE (test/fixtures/rate-limit-panes.ts) —
 *  Claude Code 2.1.282's own panel indicator for the FIRST row uses `⏺`, not
 *  the `●` every other committed panel fixture in this repo draws (the
 *  glyph this file's own AGENT_PANEL_LINE regex was written against). One
 *  line changed, nothing else. */
import { REAL_WEBSTUDIO_PANE } from "./rate-limit-panes";
export const PANEL_GLYPH_2_1_282_PANE = REAL_WEBSTUDIO_PANE.replace("  ● main", "  ⏺ main");

/**
 * Issue #221 fix round 3 — VERBATIM `tmux capture-pane -p` reads from
 * `fleetflare--web-studio` (a DIFFERENT studio from this file's other
 * fixtures, all captured from this container's own lead), 2026-09-25,
 * attach view, with one corrupted panel row already removed before capture
 * was handed off. Three real captures, two labelled `working`, one
 * `waiting-members` — kept as three separate VERBATIM exports rather than
 * picking one "representative" working capture, since c1 and c13 are
 * usefully different transcripts (different agents finishing, different
 * board states) even though they share the same footer shape.
 *
 * Both working captures carry `esc to interrupt` in the FOOTER itself
 * (`⏵⏵ bypass permissions on (shift+tab to cycle) · PR #282 · esc to
 * interrupt · ← for agents · ↓ to manage`) — Fix 1's own footer leg, not the
 * status-line leg — so together they are direct field evidence for that
 * fix, not just the REBUILT/spliced fixtures above.
 */
export const REAL_WEBSTUDIO_C1_WORKING_PANE = [
  "❯ Maestro: PR #286 (#250) conflicts with main. Merge origin/main into its branch, resolve, re-run targeted tests, push",
  "  explicit refspec. Also: stop pushing plan/done.json commits straight to main (d73e5c42, c78549b0 today) — they go on",
  "  the PR branch.",
  "● Fixing #286's merge conflict now. Correction noted: plan/done.json commits belong on the PR branch, never straight to",
  "  main — applying that from here on.",
  "● backend-developer(Merge main into #250 branch, resolve conflicts)",
  "  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)",
  "● #286 merge fix dispatched, ~10 min. Rule applied going forward: plan doc + done.json land on the PR branch, never",
  "  main.",
  "State: #183 merging, #251 round-3 fixing, #262/#258 ready, #250 merging conflict fix. Next: wait for merge fix, then",
  "Stre-v rify and update2PR.",
  "✻ Waiting for 2 background agents to finish",
  "❯ Read task #258 latest maestro comment (PR #282 round 3: shrink keys, prune at cap, render error). Dispatch when a",
  "  member slot frees.",
  "● Reading #258's round-3 comment now.",
  "  Ran 1 shell command",
  "● Round 3: maestro rejects the lower-ceiling acceptance — wants fileOffsets/lastSeenAt actually shrunk, pre-persist",
  "  pruning at cap, and burnPersistError rendered in fleet ls. Dispatching now, no slot conflict.",
  "✻ Dilly-dallying… (36s · ↓ 2.2k tokens)",
  "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  "─".repeat(120),
  "❯",
  "─".repeat(120),
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #282 · esc to interrupt · ← for agents · ↓ to manage",
  "  ● main",
  "  ◯ backend-developer  Fix #251 round-3 review findings                                        20m 41s · ↓ 137.7k tokens",
].join("\n");

/** VERBATIM, same studio/session as REAL_WEBSTUDIO_C1_WORKING_PANE above, a
 *  later capture (different transcript: #250's merge report, board state
 *  moved on). Same footer shape (`esc to interrupt` in the footer). Kept
 *  byte-for-byte, corruption artifacts included ("Ra2.", " a3.", trailing
 *  "Ne") — genuine tmux redraw noise, not something this fixture should
 *  clean up. */
export const REAL_WEBSTUDIO_C13_WORKING_PANE = [
  "● #250 merge resolved cleanly, all gates green (116 files/3659 tests). Quick scope sanity check myself since only",
  "  done.json conflicted, no functional changes.",
  "Ran 1 shell command",
  "● Functional diff unchanged — merge only resolved done.json, no code drift. Posting board update for #250's merge fix.",
  "  Ran 1 shell command",
  "● #250 merge fix reported: https://github.com/rafarc21/fleetflare/issues/250#issuecomment-5832235769",
  "  State now:",
  "  1. #183 — merging",
  "Ra2. #251 — round-3 fix (3 findings) in progress",
  " a3. #262 — PR #264, ready",
  "  4. #258 — round-3 fix (real shrink + prune-at-cap + render) in progress",
  "  5. #250 — PR #286, conflict resolved, ready",
  "Next: wait for #251 or #258 round-3 to land.",
  "Ne",
  "✻ Waiting for 2 background agents to finish",
  "● Agent \"Fix #251 round-3 review findings\" finished · 21m 39s",
  "●eAll 3 findings fixed (finding 2 solved properly, not just documented). Dispatching fresh review before applying PR",
  " ebody.",
  "✢ Dilly-dallying… (4s · ↓ 81 tokens)",
  "─".repeat(120),
  "❯",
  "─".repeat(120),
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #282 · esc to interrupt · ← for agents · ↓ to manage",
  "  ● main",
  "  ◯ backend-developer  Fix #251 round-3 review findings                                        21m 39s · ↓ 142.9k tokens",
].join("\n");

/** VERBATIM, same studio/session, ~last capture before this fix round —
 *  status line reads `✻ Waiting for 2 background agents to finish` and the
 *  footer carries no `esc to interrupt` at all: the waiting-members leg,
 *  not the working leg. */
export const REAL_WEBSTUDIO_C30_WAITING_MEMBERS_PANE = [
  "● Functional diff unchanged — merge only resolved done.json, no code drift. Posting board update for #250's merge fix.",
  "Ran 1 shell command",
  "● #250 merge fix reported: https://github.com/rafarc21/fleetflare/issues/250#issuecomment-5832235769",
  "State now:",
  "  1. #183 — merging",
  "  2. #251 — round-3 fix (3 findings) in progress",
  "  3. #262 — PR #264, ready",
  "  4. #258 — round-3 fix (real shrink + prune-at-cap + render) in progress",
  "  5. #250 — PR #286, conflict resolved, ready",
  "Ne",
  "Next: wait for #251 or #258 round-3 to land.",
  "✻ Waiting for 2 background agents to finish",
  "● Agent \"Fix #251 round-3 review findings\" finished · 21m 39s",
  "●eAll 3 findings fixed (finding 2 solved properly, not just documented). Dispatching fresh review before applying PR",
  "Nebody.",
  "● code-reviewer(Review #251 round-4 findings fix)",
  "  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)",
  "● #251 round-4 review running, ~20 min. State: #183 merging, #250 PR ready, #262/#258-r1 ready, #251 reviewing round-4,",
  "  #258 round-3 fixing. Next: wait for whichever lands first.",
  "✻ Waiting for 2 background agents to finish",
  "─".repeat(120),
  "❯",
  "─".repeat(120),
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #282 · ← for agents · ↓ to manage",
  "  ● main",
  "  ◯ backend-developer  Fix #258 round-3: real shrink, pre-persist prune, render                  2m 13s · ↓ 39.7k tokens",
].join("\n");

/**
 * Issue #221 fix round 3, footer fix — REBUILT: REAL_LEAD_WAITING_MEMBERS_PANE's
 * own real transcript, with its own chrome tail (status line through the
 * agent panel) replaced by a permission prompt's own tail, quoted VERBATIM
 * from a live web-studio capture, 2026-09-25: `Do you want to proceed?` /
 * `❯ 1. Yes` / `  2. No` / `Esc to cancel · Tab to amend · ctrl+e to
 * explain`. Round 2's Fix 6 (MODAL_FOOTER_LINE, failover.ts) only ever
 * matched the limit modal's own wording (`Enter to confirm · Esc to
 * cancel`) — this real footer is a DIFFERENT shape claude actually draws
 * for a permission prompt, which round 2 never measured. This fixture is
 * the regression proof: misread as unknown before round 3's fix,
 * waiting-question after. */
export const REAL_PERMISSION_PROMPT_TAIL_PANE = REAL_LEAD_WAITING_MEMBERS_PANE.replace(
  [
    "✻ Waiting for 1 background agent to finish",
    "",
    "─".repeat(124),
    "❯ ",
    "─".repeat(124),
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · ↓ to manage",
    "",
    "  ● main",
    "  ◯ general-purpose  PR #280 round-2 fix (#221)                                                  3m 15s · ↓ 99.1k tokens",
  ].join("\n"),
  [
    "▔".repeat(120),
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "Esc to cancel · Tab to amend · ctrl+e to explain",
  ].join("\n"),
);
