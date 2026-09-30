/**
 * Issue #53 — detect a claude account that has hit its limit, and move the
 * studio to the next account by itself.
 *
 * WHAT WAS MEASURED, 2026-09-23: both `fleetflare` studios and both
 * `demosite-life` studios sat on claude's `/rate-limit-options` modal ("You've
 * hit your org's monthly spend limit"). Containers `running`, READY
 * `provisioned`, `pane_current_command` still `claude`, and BURN ticking UP as
 * the failure messages printed. Every cheap signal this fleet has said
 * healthy while nothing worked, so none of them can be the trigger: not
 * silence, not burn, not readiness. The modal's own TEXT is the only thing
 * that distinguishes an exhausted lead from a busy one, which is why this file
 * reads the pane.
 *
 * Lives in src/studio/ next to accounts.ts and imports nothing from do.ts, for
 * this feature's usual reason (do.ts imports "@cloudflare/sandbox"; see
 * provision.ts's header). do.ts wires the ports and owns the schedule.
 */
import type { ClaudeAccount, AccountLimits } from "./accounts";
import {
  accountsTried, nextClaudeAccount, earliestAccountReset, nextBorrowedAccount, accountIsFree, firstFreeAccount,
} from "./accounts";
import { STATUS_KEY, OPERATION_KEY, watchForDestroy, operationLockFresh, type StudioStorage } from "./provision";
import { redactSecrets } from "./redact";
import {
  RESETS, isResetStale, parseResetUtc, LIMIT_SIGHTING_KEY, type LimitSighting, type RateLimitObservation,
} from "./rate-limit";
import { FLEET_TOKEN_ENV, tokenEnv } from "./credentials";
import type { StudioStatus } from "./types";
import { STUDIO_TMUX, withStudioTmux } from "./tmux";

export { FLEET_TOKEN_ENV };
import {
  mergeObserved, computeSessionVerdict, bringupObservationCmd, parseBringupObservation,
  type ObservedStorage, type PaneProbeResult, type Observed,
} from "./observed";
import { parseStudioId } from "./ids";
// Issue #109: TYPE only — see autoContinueAttempt's own doc comment for why
// this file cannot import a VALUE from wake.ts at its top level (a genuine
// module-load cycle, MEASURED). `import type` is erased entirely at compile
// time, so this line carries no runtime import at all.
import type { GatedWakeDeps } from "./wake";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The headline strings the exhaustion modal renders. The FIRST one is what was
 * measured on all four live studios on 2026-09-23; the others are the same
 * modal's wording for a personal plan rather than an org one.
 *
 * Data, not logic, and deliberately one exported array: adding a wording claude
 * introduces later is a one-line change in a list, reviewable on its own, with
 * no detection code to re-reason about.
 */
export const RATE_LIMIT_HEADLINES = [
  "You've hit your org's monthly spend limit",
  "You've hit your usage limit",
  "Claude usage limit reached",
] as const;

/**
 * Strings only the MODAL FRAME renders — the option list a human would answer.
 * A headline on its own is just text; a headline plus an option line is a
 * dialog waiting for an answer.
 *
 * `/rate-limit-options` is the modal's own slash command, printed in its body.
 * "Upgrade your plan" is the highlighted option — the one the issue warns a
 * wrong Enter would cost money on, which is exactly why nothing in this file
 * ever sends a key to this pane.
 */
export const RATE_LIMIT_MODAL_MARKERS = [
  "Upgrade your plan",
  "/rate-limit-options",
] as const;

// ---------------------------------------------------------------------------
// Issue #101 — the wordings measured 2026-09-24. Matched by POSITION, never
// as substrings anywhere in the tail: PR #102's first cut did that and fired on
// idle leads that merely talked about the limit (a report quoting it, a git
// diff of this file, a numbered list of the options). An idle lead's pane ends
// in its input box; a limited one ends in the limit itself.
// ---------------------------------------------------------------------------

/**
 * The session-limit headline (demosite-life--pilot/--web-studio): claude prints
 * it INLINE as the turn's last output, then returns to its input box —
 *
 *     ⎿  You've hit your session limit · resets 1:30pm (UTC)
 *        /upgrade to increase your usage limit.
 *
 * Counted only as that block: the headline line START-anchored with its
 * " · resets " tail, a hint line start-anchored within the next 4 lines
 * with no transcript glyph between, and nothing after it but input chrome.
 */
export const SESSION_LIMIT_HEADLINE = "You've hit your session limit";

/**
 * Issue #141 — "Your organization has disabled Claude subscription access for
 * Claude Code · Use an Anthropic API key instead": NOT a rate limit (nothing
 * about it ever resets — a human has to re-enable the account outside this
 * fleet) and NOT a select-style modal (no numbered options, no Enter/Esc
 * footer). One self-contained `⎿` line, then straight back to claude's own
 * idle input box — same shape as the "out of usage credits" inline block, but
 * with no separate hint row and no RESETS-parseable clause at all, which is
 * why it is detected independently below (`deadAccountBlock`) rather than
 * folded into INLINE_LIMIT_HEADLINES/inlineLimitBlock, whose `block()` closure
 * requires one of those two grammars to accept a candidate.
 */
export const DEAD_ACCOUNT_HEADLINE = "Your organization has disabled Claude subscription access for Claude Code";
/** The full sentence, unwrapped — what a wrapped capture's lines must
 *  reconstruct exactly (trim each line, join with one space) to count.
 *  Review fix pass (2026-09-30): a REAL pane (studio on a disabled account,
 *  2026-09-30, ~120-col pane) showed this WRAPPED across two rows, drawn
 *  with claude's own message glyph (`●`), not the fabricated single `⎿` line
 *  the original detector matched — that shape never happens on a real pane. */
const DEAD_ACCOUNT_FULL_TEXT =
  "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
/** The line this message STARTS on: claude's own message glyph (both
 *  measured forms, see TRANSCRIPT_GLYPH's own doc comment), immediately
 *  followed by the sentence's own first words — never merely CONTAINING
 *  them (a `⎿` tool-output line, or prose, quoting the sentence mid-line
 *  must not match this). */
const DEAD_ACCOUNT_START_LINE = /^\s*[⏺●]\s+Your organization has disabled Claude subscription access for Claude Code\b/;
/** How many physical rows the wrapped sentence may span. Two is what both
 *  measured widths (120-col real pane, hand-wrapped 80-col) need; generous
 *  headroom for a narrower pane without being unbounded. */
const DEAD_ACCOUNT_WRAP_LINES = 3;

/**
 * Issue #106: every inline limit headline, each with a pattern for the START
 * of its line as printed. Counted from rate_limit entries in real transcripts,
 * 2026-09-24: session 83, monthly spend 19 (its reset clause names the session
 * OR the weekly limit), weekly 9, out of credits 2. Same block shape as the
 * session limit; only the headline differs.
 *
 * PR #112 review: each pattern ends at a word boundary OR end of row — tmux
 * trims trailing spaces, and on the default 80-col pane the monthly-spend row
 * ends at "raise it at". The out-of-credits sentence is plain English a lead
 * can write, so it counts only with a continuation claude itself prints.
 */
export const INLINE_LIMIT_HEADLINES = [
  { headline: SESSION_LIMIT_HEADLINE, line: /You've hit your session limit · resets(?:\s|$)/ },
  { headline: "You've hit your weekly limit", line: /You've hit your weekly limit · resets(?:\s|$)/ },
  { headline: "You've hit your monthly spend limit", line: /You've hit your monthly spend limit · raise it at(?:\s|$)/ },
  {
    headline: "You're out of usage credits.",
    line: /You're out of usage credits(?:\. Run \/usage-credits|\. \/model|\. Switch to another model| · resets )/,
  },
] as const;
/**
 * Fix pass B: the `⎿` is REQUIRED. Every measured block (4 real studio panes,
 * 2 resumed sessions, the #101 quotes) is a `⎿` result row; a lead's own prose
 * never starts with one, so a quoted block in prose cannot match.
 */
const INLINE_LIMIT_LINE = new RegExp(
  `^\\s*⎿\\s+(?:${INLINE_LIMIT_HEADLINES.map((h) => h.line.source).join("|")})`,
);
/**
 * A block with NO hint row, measured on 2 of 4 real studio panes (web-studio
 * 09-24, weekly 09-17): a session or weekly headline whose row ends at its
 * reset's `(zone)`. Nothing else is accepted hint-less — a monthly-spend or
 * out-of-credits block without its hint was never seen.
 */
const HINTLESS_LIMIT_LINE = /^\s*⎿\s+You've hit your (?:session|weekly) limit · resets .*\)\s*$/;
/**
 * The hint claude draws under the headline. Each is a PREFIX (the tails vary:
 * "/usage-credits to adjust your monthly spend limit.", "... to finish what
 * you're working on.", "/login to switch to an API usage-billed account.") —
 * strings from the claude 2.1.281 binary.
 */
const LIMIT_HINT_LINE = /^\s*\/(upgrade|usage-credits|login)\b/;
const UPGRADE_HINT_WINDOW = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Transcript glyphs: a message, a tool call, a spinner, a tool result. */
const TRANSCRIPT_GLYPH = /^\s*[⏺●✻⎿]/;

/**
 * What claude draws BELOW the transcript while it waits for input: blank lines,
 * rules and box borders, an EMPTY prompt (`❯` or `│ > │`), and the footer. A
 * prompt WITH text is a new turn, so it is not chrome.
 */
function isInputChrome(line: string): boolean {
  return /^[\s─━▔╭╮╰╯│]*$/.test(line)
    || /^\s*│?\s*[❯>]\s*│?\s*$/.test(line)
    || FOOTER_LINE.test(line);
}

const FOOTER_LINE = /^\s*(?:⏵⏵ |\? for shortcuts)/;
/** `✻ <Verb>ed for <dur>[ · …]` — claude's row for a turn that has ENDED
 *  ("✻ Cogitated for 0s", "✻ Cooked for 36m 35s · 7 shells still running").
 *  Not "✻ Waiting for …" or a live spinner: those are turns still open. */
// PR #144 review: every verb claude 2.1.224 + 2.1.277-281 ships (Baked Brewed
// Churned Cogitated Cooked Crunched Sautéed Worked — note the é), and a day unit.
export const TURN_ENDED_LINE = /^\s*✻ \p{Lu}\p{Ll}+ed for \d+[dhms](?: \d+[dhms])*(?: · .*)?$/u;
const TMUX_SCROLL_NOTICE = /^\s*tmux detected · scroll with PgUp\/PgDn\b/;
export const RULE_LINE = /^\s*─{8,}\s*$/;
/** Not a numbered option row (`❯ 1. Stop and wait …`): that is a select modal, never queued text. */
export const PROMPT_LINE = /^\s*❯(?!\s*\d+\.\s)(?:\s.*)?$/;
/** A row of the agent panel claude draws UNDER its footer (`● main`,
 *  `◯ frontend-developer …`). Issue #221 fix round 2, Fix 6: claude 2.1.282
 *  draws the SAME first row with `⏺` instead of `●` (measured) — without it
 *  here, `footerAtBottom`'s own "nothing under the footer but blanks and
 *  agent-panel rows" rule fails on an otherwise-ordinary frame, corrupting
 *  the whole parse (footer not found at all) rather than just missing one
 *  row. Only ever tested against lines AFTER the footer (`footerAtBottom`,
 *  `aboveAgentPanel`), so widening it here cannot swallow a real `⏺` message
 *  line from the transcript ABOVE the footer, where `⏺` always means. */
export const AGENT_PANEL_LINE = /^\s*(?:❯\s*)?[●◯⏺]\s+\S/;
/** How many wrapped rows of queued prompt text the input box may hold.
 *  Exported (issue #108 fix-first, PR #118) so activity.ts's
 *  `extractLastVisibleLine` can skip the SAME box shape as one chrome block,
 *  rather than re-deriving or hardcoding this bound a second time. */
export const QUEUED_TEXT_ROWS = 3;

/**
 * Fix pass B: does everything AFTER a limit block say "this turn ended, and
 * claude is waiting for input"? Real limited panes (PR #112 review) never end
 * in bare chrome. In order, each optional unless named:
 *
 *   1. the turn-ended row (`✻ Cogitated for 0s`);
 *   2. tmux's scroll notice;
 *   3. REQUIRED, the input box: a ─ rule, the `❯` row — with QUEUED text or a
 *      dim prompt suggestion, both of which claude draws there — up to
 *      QUEUED_TEXT_ROWS wrapped rows, and the closing rule;
 *   4. the footer, and only under it the agent panel.
 *
 * The `❯` row counts only BETWEEN RULES: a submitted message is drawn with
 * `❯` in the transcript too, and that one starts a new turn. The pre-B shape
 * (nothing after the block but input chrome) is still accepted as is, unless
 * the turn-ended row is `required` — a hint-less block, which every measured
 * one is followed by, and which without it is just a result row.
 */
function endsInIdleInputBox(after: string[], turnEnded: "optional" | "required" = "optional"): boolean {
  if (turnEnded === "optional" && after.every(isInputChrome)) return true;
  let i = 0;
  const blanks = () => { while (i < after.length && after[i].trim() === "") i++; };
  blanks();
  if (i < after.length && TURN_ENDED_LINE.test(after[i])) { i++; blanks(); }
  else if (turnEnded === "required") return false;
  if (i < after.length && TMUX_SCROLL_NOTICE.test(after[i])) { i++; blanks(); }
  if (!RULE_LINE.test(after[i] ?? "") || !PROMPT_LINE.test(after[i + 1] ?? "")) return false;
  i += 2;
  for (let rows = 0; !RULE_LINE.test(after[i] ?? ""); rows++, i++) {
    if (i >= after.length || rows >= QUEUED_TEXT_ROWS || TRANSCRIPT_GLYPH.test(after[i])) return false;
  }
  i++;
  let footer = false;
  for (; i < after.length; i++) {
    if (after[i].trim() === "") continue;
    if (FOOTER_LINE.test(after[i])) { footer = true; continue; }
    if (footer && AGENT_PANEL_LINE.test(after[i])) continue;
    return false;
  }
  return true;
}

/**
 * Index of claude's footer when it is the BOTTOM of the pane — the last
 * FOOTER_LINE row with nothing under it but blanks and the agent panel — or
 * -1. ONE bottom rule, two callers: the quiescence slice below, and fix pass
 * D's "is claude actually up" test in runAccountFailover.
 */
export function footerAtBottom(lines: string[]): number {
  const footer = lastLineMatching(lines, FOOTER_LINE);
  if (footer < 0 || !lines.slice(footer + 1).every((l) => l.trim() === "" || AGENT_PANEL_LINE.test(l))) return -1;
  return footer;
}

/**
 * The part of a capture the quiescence test compares: everything down to the
 * footer. The agent panel under it ticks its own timers ("1h 1m 15s · ↑
 * 225.5k tokens") while the LEAD is idle, so it says nothing about a turn in
 * flight; the lead's own spinner is drawn above the input box and still counts.
 *
 * Issue #249 (PR4b): EXPORTED, so the survival-brief's own "lead is mid-task,
 * don't interrupt" probe (`paneBusy`, survival-delivery.ts) runs the
 * BYTE-IDENTICAL repaint comparison this detector runs rather than a second,
 * drifting copy of it. Both callers ask the same question of the same two
 * captures — "did anything above the agent panel change in
 * PANE_QUIESCE_SECONDS" — and only the ACTION on the answer differs.
 */
export function aboveAgentPanel(capture: string): string {
  const lines = capture.split("\n");
  const footer = footerAtBottom(lines);
  if (footer < 0) return capture;
  return lines.slice(0, footer + 1).join("\n");
}

/**
 * The limit modal ALONE, with no headline on screen (fleetflare--web-studio's
 * whole 127-line pane carried none). Counted only when it is the BOTTOM of the
 * pane: the last non-blank line is the modal's own footer, and option lines
 * count only inside the block that opens with its question or its ▔ rule. A
 * modal quoted in prose has more output under it; a numbered list in a reply
 * has no footer at all.
 */
/** Issue #221 fix round 2, Fix 6: exported (one line, no logic change) so
 *  activity.ts can recognise ANY select-style menu drawn in this same ▔-ruled
 *  shape — a permission prompt (`Do you want to proceed?`), a plan-mode
 *  choice, anything — without forking this regex or hardcoding the limit
 *  modal's own question text. */
/** Issue #221 fix round 3 — a permission prompt draws a DIFFERENT footer
 *  than the limit modal's own `Enter to confirm · Esc to cancel` (measured,
 *  live web-studio capture, 2026-09-25): `Esc to cancel · Tab to amend ·
 *  ctrl+e to explain`. Round 2's Fix 6 assumed every select-style menu
 *  shared the limit modal's wording; both are accepted here rather than
 *  forking a second regex per caller. */
export const MODAL_FOOTER_LINE = /^\s*│?\s*(?:Enter to confirm · Esc to cancel|Esc to cancel · Tab to amend · ctrl\+e to explain)\s*│?\s*$/;
export const MODAL_BLOCK_START = /^\s*(?:What do you want to do\?|▔+)\s*$/;
const MODAL_OPTION_LINE = /^\s*│?\s*(?:❯\s*)?\d\.\s+(.*?)\s*│?\s*$/;
/** Limit-specific on its own. Plain "Stop and wait" needs a paid option beside it. */
const STOP_FOR_LIMIT_OPTION = "Stop and wait for limit to reset";

// The reset grammar (RESETS) and its staleness rule (isResetStale) live in
// rate-limit.ts — one parser for the detector, the row and the wake gate.

/**
 * How far up from the BOTTOM of the visible pane a headline still counts.
 *
 * A modal is a blocking dialog: it is drawn where the input box normally is,
 * at the bottom of the screen. Text that has scrolled above that is output —
 * a grep result, a file the lead printed, this very file quoted into a
 * transcript — and must not fire anything.
 */
export const MODAL_TAIL_LINES = 25;

/**
 * Seconds between the two pane observations. Long enough that a turn in
 * progress cannot look static: claude repaints its status line ("✻ Thinking…
 * (12s · ↑ 1.4k tokens · esc to interrupt)") every second for as long as a
 * turn is running, so two captures three seconds apart are byte-identical only
 * when the UI is genuinely blocked.
 */
export const PANE_QUIESCE_SECONDS = 3;

/**
 * Separates the two observations in the single exec's stdout. Chosen so no
 * pane content can be mistaken for it: it is not a phrase, and a capture that
 * does not contain it is treated as a failed probe rather than as a pane.
 */
export const PANE_CAPTURE_MARKER = "__FLEET_PANE_CAPTURE_2__";

/**
 * The probe. ONE exec, TWO observations, PANE_QUIESCE_SECONDS apart.
 *
 * INVISIBLE BY CONSTRUCTION, which is a hard fleet rule and not a style
 * choice: `capture-pane -p -t studio:claude` addresses the window BY NAME and
 * prints to stdout, so it neither requires the window to be active nor makes
 * it active. An operator already lost an hour to a probe that left a window
 * selected and made a healthy studio look dead. Nothing here selects, switches,
 * attaches or kills anything.
 *
 * Both captures in one command rather than two Worker round trips: the gap has
 * to be a known, short interval for the quiescence test below to mean
 * anything, and two separate execs would put an unbounded Worker/network delay
 * in the middle of it.
 *
 * No `set -e`, no `exit`: sbExec commands run inside the container's ONE
 * long-lived session shell (see provision.ts's PROVISIONED_OK doc comment),
 * where either would take that shell down with them.
 */
export function paneCaptureCmd(): string {
  return withStudioTmux(
    `${STUDIO_TMUX} capture-pane -p -t studio:claude 2>/dev/null; ` +
    `printf '%s\\n' '${PANE_CAPTURE_MARKER}'; ` +
    `sleep ${PANE_QUIESCE_SECONDS}; ` +
    `${STUDIO_TMUX} capture-pane -p -t studio:claude 2>/dev/null`
  );
}

/**
 * What the claude pane is doing, as far as the modal is concerned.
 *
 * Three kinds, never two — the same split every other verdict in this codebase
 * makes (do.ts's ProvisionedVerdict, types.ts's StudioReadiness).
 * `inconclusive` is a statement about the PROBE, never about the studio, and
 * must never be read as evidence either way.
 */
export type PaneVerdict =
  // `headline` is null when the modal alone matched (issue #101's V1 pane).
  // `resets` is the reset time exactly as printed, when the pane shows one.
  // `inline` (issue #99): an inline limit block — printed above claude's own
  // input box, no options. Every other modal is a numbered select whose
  // options include a spend path, and never carries it.
  // `dead` (issue #141): the org-disabled-subscription message — permanent,
  // never a select modal, never a reset.
  | { kind: "modal"; headline: string | null; marker: string; resets?: string; inline?: true; dead?: true }
  // `repainted`: the two captures differed. A static pane with no limit is
  // evidence the limit is gone; a repainting one is evidence of nothing.
  // `stale` (PR #144 review): the inline block at the bottom WOULD have matched
  // but its reset has passed — handed out so failover can record a block that
  // was already stale when first seen, before its daily window comes back.
  | { kind: "working"; reason: string; repainted?: true; stale?: { block: string; resets: string | null } }
  | { kind: "inconclusive"; reason: string };

/** Index of the last line before `end` matching `re`, or -1. (lib is es2022: no findLastIndex.) */
function lastLineMatching(lines: string[], re: RegExp, end = lines.length): number {
  for (let i = end - 1; i >= 0; i--) if (re.test(lines[i])) return i;
  return -1;
}

/**
 * Issue #232: the ONE liveness rule for an inline limit block's key, shared by
 * inlineLimitBlock's own bottom-anchored `block()` closure and the
 * position-free veto (anyLiveLimitLineOnScreen) below — extracted so the two
 * can never drift on what counts as "live":
 *
 *   - a block already SEEN (issue #127: `sighting.block === key`) is judged by
 *     the until its FIRST sighting computed, never by re-parsing its text
 *     against today's clock: live unless that until is set and has passed;
 *   - otherwise, judged by the clock via `m` (a RESETS match against the
 *     block's own text): live unless `isResetStale` says it has passed;
 *   - `m` null (no readable reset, and no matching sighting either) is never
 *     stale by this rule, so it reads LIVE — an unreadable reset is never
 *     grounds to let a heal through.
 */
function limitKeyIsLive(
  key: string, m: RegExpMatchArray | null, now: Date, sighting?: LimitSighting | null,
): boolean {
  if (sighting && sighting.block === key) {
    return !(sighting.until !== null && Date.parse(sighting.until) <= now.getTime());
  }
  return !(m !== null && isResetStale(m, now));
}

/**
 * An inline limit block (see SESSION_LIMIT_HEADLINE and INLINE_LIMIT_HEADLINES),
 * or null. The reset is read from the HEADLINE only: its own line plus any
 * lines it wrapped onto before the hint (a measured monthly-spend headline
 * puts its "(Europe/Madrid)" on the next line). With `now`, a block whose
 * reset has passed is stale and is not a limit.
 */
function inlineLimitBlock(lines: string[], now?: Date, sighting?: LimitSighting | null): PaneVerdict | null {
  const at = lastLineMatching(lines, INLINE_LIMIT_LINE);
  if (at < 0) return null;
  const block = (end: number, marker: string): PaneVerdict | null => {
    const headlineText = lines.slice(at, end).map((l) => l.trim()).join(" ");
    const text = headlineText.replace(/^⎿\s+/, "");
    const found = INLINE_LIMIT_HEADLINES.find((h) => text.search(h.line) === 0);
    if (!found) return null;
    const m = headlineText.match(RESETS);
    const verdict = { kind: "modal", headline: found.headline, marker, inline: true, ...(m ? { resets: m[2] } : {}) } as const;
    if (!now) return verdict;
    const key = limitBlockKey(verdict);
    const stale: PaneVerdict = {
      kind: "working", reason: `limit block at the bottom of the pane is stale: ${key}`,
      stale: { block: key, resets: m ? m[2] : null },
    };
    return limitKeyIsLive(key, m, now, sighting) ? verdict : stale;
  };
  if (HINTLESS_LIMIT_LINE.test(lines[at]) && RESETS.test(lines[at]) && endsInIdleInputBox(lines.slice(at + 1), "required")) {
    return block(at + 1, "(no hint)");
  }
  for (let j = at + 1; j <= Math.min(at + UPGRADE_HINT_WINDOW, lines.length - 1); j++) {
    if (TRANSCRIPT_GLYPH.test(lines[j])) return null;
    const hint = lines[j].match(LIMIT_HINT_LINE);
    if (!hint) continue;
    if (!endsInIdleInputBox(lines.slice(j + 1))) return null;
    return block(j, `/${hint[1]}`);
  }
  return null;
}

/**
 * Issue #141 — the org-disabled-subscription message (issue #141) — permanent,
 * never a select modal, never a reset. Unlike an inline limit block, it has no
 * hint line and no resets grammar at all: the FULL SENTENCE, however it
 * wrapped, is the only signal. Bottom-anchored (endsInIdleInputBox) the same
 * way an inline limit block is.
 *
 * Review fix pass (2026-09-30): rewritten to be wrap-tolerant — the original
 * detector matched one fabricated, unwrapped `⎿` line that a real pane never
 * draws. This scans forward from the message's own start line
 * (DEAD_ACCOUNT_START_LINE) up to DEAD_ACCOUNT_WRAP_LINES rows, stopping at
 * the next transcript glyph, and accepts only an EXACT reconstruction of the
 * full sentence — not a substring match, so a quoted copy inside a `⎿`
 * tool-output line or prose never fires this.
 */
function deadAccountBlock(lines: string[]): PaneVerdict | null {
  const at = lastLineMatching(lines, DEAD_ACCOUNT_START_LINE);
  if (at < 0) return null;
  for (let end = at + 1; end <= Math.min(at + DEAD_ACCOUNT_WRAP_LINES, lines.length); end++) {
    if (end < lines.length && TRANSCRIPT_GLYPH.test(lines[end])) break;
    const joined = lines.slice(at, end).map((l) => l.trim()).join(" ").replace(/^[⏺●]\s+/, "");
    if (joined === DEAD_ACCOUNT_FULL_TEXT) {
      if (!endsInIdleInputBox(lines.slice(end))) return null;
      return { kind: "modal", headline: DEAD_ACCOUNT_HEADLINE, marker: "dead-account", inline: true, dead: true };
    }
  }
  return null;
}

/**
 * Issue #232: the key + RESETS match for ONE row that already matched
 * INLINE_LIMIT_LINE, built the same way inlineLimitBlock's own `block()`
 * closure builds it — except this is never anchored to a hint or an idle
 * input box, because the whole point of this candidate is to be found
 * regardless of what follows it on screen.
 *
 * Issue #241: tries the 1-line form first, then — same forward scan `block()`
 * itself runs — looks ahead up to UPGRADE_HINT_WINDOW rows for a
 * LIMIT_HINT_LINE, and joins `lines.slice(at, j)` exactly as `block()`'s own
 * `end = j` does; a TRANSCRIPT_GLYPH row stops that scan early, same as
 * `block()`. A real monthly-spend headline can wrap across MULTIPLE rows
 * before its hint (the headline text itself splits, then the reset lands on
 * a further row) — the join has to reach as far as `block()`'s own does, or
 * this candidate never finds the same reset the bottom-anchored detector
 * finds, and a block with a genuinely readable — but not yet stale — reset
 * reads as live forever.
 *
 * The 2-row fallback below fires whenever THIS hint-aware attempt ends
 * without a readable reset — not only when no hint line is found in the
 * window at all (a HINTLESS_LIMIT_LINE block, or a glyph row cutting the scan
 * short), but equally when a hint line IS found yet the text it joins to
 * still fails to match RESETS. Either way the ORIGINAL fallback applies
 * unchanged: the row joined with just its next line, since a hint-less
 * headline only ever measured wrapping its zone that one line over.
 * Either way, once the row's own text confirms a recognized headline
 * (INLINE_LIMIT_LINE already guarantees this will find one), the candidate is
 * returned even with `m` null: an unreadable reset is a candidate too, never
 * silently skipped.
 */
function inlineLimitCandidate(lines: string[], at: number): { key: string; m: RegExpMatchArray | null } | null {
  const oneLine = lines[at].trim();
  const text = oneLine.replace(/^⎿\s+/, "");
  const found = INLINE_LIMIT_HEADLINES.find((h) => text.search(h.line) === 0);
  if (!found) return null;
  let headlineText = oneLine;
  let m = headlineText.match(RESETS);
  if (!m) {
    let hintRow = -1;
    for (let j = at + 1; j <= Math.min(at + UPGRADE_HINT_WINDOW, lines.length - 1); j++) {
      if (TRANSCRIPT_GLYPH.test(lines[j])) break;
      if (LIMIT_HINT_LINE.test(lines[j])) { hintRow = j; break; }
    }
    if (hintRow >= 0) {
      const hintJoined = lines.slice(at, hintRow).map((l) => l.trim()).join(" ");
      const mHint = hintJoined.match(RESETS);
      if (mHint) { headlineText = hintJoined; m = mHint; }
    }
    if (!m && at + 1 < lines.length) {
      const twoLine = [lines[at], lines[at + 1]].map((l) => l.trim()).join(" ");
      const m2 = twoLine.match(RESETS);
      if (m2) { headlineText = twoLine; m = m2; }
    }
  }
  const verdict = { kind: "modal", headline: found.headline, marker: "", inline: true, ...(m ? { resets: m[2] } : {}) } as const;
  return { key: limitBlockKey(verdict), m };
}

/**
 * Issue #232 — the position-free veto. inlineLimitBlock only recognizes a
 * limit block anchored at the BOTTOM of the pane: immediately followed by
 * claude's idle input box (or, hint-less, ending at its own reset), within
 * UPGRADE_HINT_WINDOW lines. Anything else printed between a still-live block
 * and the bottom of the pane — a `/loop` wakeup line mid-turn, a "Waiting for
 * N background agent to finish" row, a stray statusline row, wrapped
 * queued-input rows past QUEUED_TEXT_ROWS, a line slipped between the ruled
 * box and the footer — leaves the block still PHYSICALLY on screen, within
 * the last MODAL_TAIL_LINES lines, while the bottom-anchored detector no
 * longer sees it there.
 *
 * This scans every INLINE_LIMIT_LINE row in that same tail, position or no
 * position, and answers only "is any one of them still live" — by
 * limitKeyIsLive, the exact rule inlineLimitBlock's own `block()` closure
 * uses, so the two can never disagree on what counts as live. A row this
 * finds STALE never vetoes anything: that is PR #225's (#214) own "a stale
 * block clears" behaviour, preserved exactly. ANY single live row anywhere in
 * the window vetoes the whole tick, regardless of where (or whether) the
 * bottom-anchored detector itself landed.
 */
function anyLiveLimitLineOnScreen(screen: string, now: Date, sighting: LimitSighting | null): boolean {
  const lines = screen.replace(/\s+$/, "").split("\n").slice(-MODAL_TAIL_LINES);
  for (let at = 0; at < lines.length; at++) {
    if (!INLINE_LIMIT_LINE.test(lines[at])) continue;
    const candidate = inlineLimitCandidate(lines, at);
    if (candidate && limitKeyIsLive(candidate.key, candidate.m, now, sighting)) return true;
  }
  return false;
}

/**
 * The #53 modal (a RATE_LIMIT_HEADLINES headline), anchored like the others
 * (issue #106): the headline line START-anchored inside the modal's frame (a
 * `│` box border, or a modal footer under it), and every line after it a line
 * the modal itself draws — its /rate-limit-options line, a numbered option,
 * its question, rule or footer — or input chrome. At least one of those must
 * be a RATE_LIMIT_MODAL_MARKERS line. Prose quoting the headline has prose
 * under it; a list quoting its options has no frame.
 */
const ORG_HEADLINE_LINE = new RegExp(
  `^\\s*(│\\s*)?(${RATE_LIMIT_HEADLINES.map(escapeRegExp).join("|")})\\s*│?\\s*$`,
);
const RATE_LIMIT_OPTIONS_LINE = /^\s*│?\s*(?:Run )?\/rate-limit-options\b/;

function orgLimitModal(lines: string[]): PaneVerdict | null {
  const at = lastLineMatching(lines, ORG_HEADLINE_LINE);
  if (at < 0) return null;
  const [, boxed, headline] = lines[at].match(ORG_HEADLINE_LINE)!;
  const after = lines.slice(at + 1);
  let marker: string | null = null;
  for (const l of after) {
    if (RATE_LIMIT_OPTIONS_LINE.test(l)) { marker ??= "/rate-limit-options"; continue; }
    const option = l.match(MODAL_OPTION_LINE)?.[1];
    if (option !== undefined) {
      if (option.startsWith("Upgrade your plan")) marker = "Upgrade your plan";
      continue;
    }
    if (MODAL_FOOTER_LINE.test(l) || MODAL_BLOCK_START.test(l) || isInputChrome(l)) continue;
    return null;
  }
  if (!marker) return null;
  if (!boxed && !after.some((l) => MODAL_FOOTER_LINE.test(l))) return null;
  return { kind: "modal", headline, marker };
}

/** The headline-less limit modal at the bottom of the pane, or null. */
function bottomLimitModal(lines: string[]): PaneVerdict | null {
  const footer = lines.length - 1;
  if (footer < 0 || !MODAL_FOOTER_LINE.test(lines[footer])) return null;
  const start = lastLineMatching(lines, MODAL_BLOCK_START, footer);
  if (start < 0) return null;
  const options = lines.slice(start + 1, footer)
    .map((l) => l.match(MODAL_OPTION_LINE)?.[1])
    .filter((o): o is string => o !== undefined);
  if (options.includes(STOP_FOR_LIMIT_OPTION)) {
    return { kind: "modal", headline: null, marker: STOP_FOR_LIMIT_OPTION };
  }
  const paid = options.find((o) => o.startsWith("Add funds") || o.startsWith("Upgrade"));
  if (options.includes("Stop and wait") && paid) return { kind: "modal", headline: null, marker: paid };
  return null;
}

/**
 * THE detection, and the one thing in this feature that must not be able to
 * false-positive. Every path requires BOTH guards:
 *
 *   - the match lies within the last MODAL_TAIL_LINES lines of the VISIBLE
 *     pane (`capture-pane -p` with no `-S` prints the screen, not the
 *     scrollback), and
 *   - the pane is byte-identical across two captures PANE_QUIESCE_SECONDS
 *     apart.
 *
 * and then ONE of three shapes:
 *
 *   A. (#53) a RATE_LIMIT_HEADLINES headline in its modal frame with a
 *      RATE_LIMIT_MODAL_MARKERS line under it, anchored as orgLimitModal says
 *      (#106: no longer substrings anywhere in the tail);
 *   B. (#101, #106) an inline limit block — session, weekly, monthly spend,
 *      out of credits — anchored as inlineLimitBlock says, and not STALE:
 *      given `now`, a block whose printed reset has passed is not a limit;
 *   C. (#101) the headline-less limit modal, anchored as bottomLimitModal says.
 *
 * Each shape is tried on its own: a headline of one shape elsewhere in the
 * tail never short-circuits another (#106 — a quoted #53 headline used to
 * return `working` early and hide a real B block below it).
 *
 * WHY A NORMAL TURN CANNOT PRODUCE THIS. The static-pane guard is the
 * load-bearing one: a lead mid-turn repaints its status line every second, so
 * its pane is never byte-identical three seconds apart — a working lead fails
 * the test on the text it is CURRENTLY writing, regardless of what its output
 * happens to say (test/studio.account-failover.test.ts's MID_TURN_PANE fixture
 * greps both #53 strings and does not fire). The SHAPE is what keeps a merely
 * IDLE lead — the state that looks identical to an exhausted one on every
 * other signal this fleet has — from firing: an idle pane ends in an input
 * box, and B and C both require the limit to be what the pane ends in.
 * test/fixtures/rate-limit-panes.ts's NOT_DETECTED is that argument as data.
 *
 * Every guard biases the same way, toward a FALSE NEGATIVE, and that is
 * deliberate: a missed modal costs what the fleet already pays today (a human
 * runs `/login`), while a false positive kills a working lead mid-turn.
 *
 * RESIDUALS, stated rather than hidden:
 *   - THE EXACT BLOCK AS THE FINAL OUTPUT. Every shape is text at the bottom
 *     of an idle pane, so a lead whose turn ENDS with exactly that text above
 *     its empty prompt matches: a code-fenced copy of the two-line B block, a
 *     tool result or `! cat` of a file holding it, a boxed #53 modal drawn by
 *     a tool, and then three still seconds. Nothing on screen tells those
 *     apart from the real thing.
 *   - B's TAIL (fix pass B) accepts what real limited panes draw under the
 *     block — the `✻ <Verb>ed for <dur>` row, tmux's scroll notice, queued
 *     text or a dim prompt suggestion inside the ruled input box, the agent
 *     panel under the footer — and the quiescence test ignores that panel.
 *     So a subagent still ticking in the panel does not keep a limited lead
 *     from failing over; the switch kills it with the lead.
 *   - B hint-less: a `⎿` session/weekly headline ending at its reset, then
 *     the turn-ended row, matches. A tool result whose ONLY row is exactly
 *     that headline, ending the turn, is indistinguishable.
 *   - B staleness. A block already seen (issue #127: LIMIT_SIGHTING_KEY,
 *     passed in as `sighting`) is judged ONLY by the until its first sighting
 *     computed; its text is never re-parsed. A time-only reset's until goes
 *     by direction: the next occurrence for a live block, the previous one
 *     for a block already stale when first seen — which is recorded too, so
 *     its next daily window does not fire. A block never seen is judged by
 *     the clock: a time-only session reset by the 5-hour window. Two consequences, both false negatives: a GENUINE new
 *     limit printing the very same headline and reset text as the recorded
 *     one (a later day's "1:30pm") reads stale; and a reset in a zone Intl
 *     rejects, or no reset at all, is never judged stale.
 *   - B: a transcript RE-RENDER. MEASURED 2026-09-24 (#106): `claude --resume`
 *     redraws a persisted limit block with its hint. runAccountFailover skips
 *     an INLINE block whose headline + reset equal the ones recorded at the
 *     last switch, until EITHER a still pane with claude's footer and no
 *     limit retires that record, OR FLAP_GUARD_MINUTES has passed since the
 *     switch (maestro review of PR #152, 2026-09-30, item 1 — a NO-VARIABLE-
 *     TEXT block, the dead-account message, produces the identical key for
 *     every account that shows it, so an unbounded version of this guard
 *     suppressed a genuinely second dead account forever). Select modals are
 *     never guarded: `--continue` does not redraw them. A new account limited
 *     by the very same headline and reset text within that window COLLIDES
 *     and is skipped; the only trace is the `rerender` outcome the tick logs.
 *     A RESET-LESS inline block (out of usage credits, or the dead-account
 *     message) keys on its headline alone, so the next account's own
 *     identically-keyed block reads as that redraw until the record retires
 *     or the window passes.
 *   - B: the first sighting (LIMIT_SIGHTING_KEY) is never cleared, only
 *     replaced by a different block. A genuinely new limit with identical
 *     headline + reset text reads stale for its whole window.
 *
 * RESIDUALS AFTER FIX PASS D (#170). Three that are LEFT, on purpose —
 * limitations, not bugs waiting on a patch:
 *   - A WEEKLY TIME-ONLY BLOCK FIRST SEEN AFTER ITS RESET reads LIVE for up
 *     to 24h. firstSighting goes by DIRECTION, and direction is all a
 *     time-only reset gives: "8pm (UTC)" first seen at 21:00Z on a weekly
 *     block is recorded as TOMORROW's 20:00Z, because a live block's reset is
 *     the next occurrence. The reset it names has already PASSED: claude
 *     prints a time-only reset only when it is at most 24h away, so a
 *     sighting after it is LATE. The first tick acts on it (exhausted, or an
 *     account switch), then wakes are refused until tomorrow's same time.
 *     Bounded by 24h. Reachable by a weekly time-only reset and by a
 *     monthly-spend block whose clause is a weekly time-only reset; typical
 *     trigger: an old block still on an idle pane at deploy.
 *   - A DST-EDGE BLOCK MISJUDGED STALE AT FIRST SIGHT STAYS STALE for its
 *     whole window. wallClock reads the zone's offset at `now`, and the reset
 *     is hours away, so a DST change between the two moves the computed until
 *     by an hour — enough, at the edge of the session window, to call a live
 *     block stale. #127's whole point is that a recorded block is never
 *     re-parsed, so that one-hour error is frozen: the block is skipped, the
 *     wake goes through, and the account keeps refusing until the real reset.
 *     One missed switch per edge, twice a year, per zone that observes DST.
 *   - AFTER A SELECT-MODAL SWITCH, A `--continue` REDRAW OF THE PERSISTED
 *     LIMIT MESSAGE IS GUARDED ONLY WHEN THE BLOCK WAS ALREADY KNOWN. Select
 *     modals are deliberately not redraw-guarded (a select modal on the next
 *     account is that account's own limit). The transcript the switched-off
 *     account left behind can still hold an INLINE limit message that
 *     `--continue` redraws; the no-flapping guard below
 *     (`claudeAccountMovedBlock`, review round 1, #102 review, 2026-09-30)
 *     catches this ONLY when this studio already had a LIMIT_SIGHTING_KEY
 *     sighting for that exact block at the moment the select-modal switch
 *     fired. An inline message that was printed but never sighted (it never
 *     matched the strict idle-ending shape this file requires — see the
 *     detection doc comment below) leaves `claudeAccountMovedBlock: null`, so
 *     its `--continue` redraw is NOT suppressed and could read as a new
 *     inline limit and switch again. UNMEASURED — no capture of this sequence
 *     exists; it is written down because the code path admits it, not because
 *     it was seen. Traded deliberately (finding 2, same review): the OLD,
 *     unconditional guard suppressed every genuinely new inline limit on a
 *     freshly-switched account for up to FLAP_GUARD_MINUTES too, which
 *     measured far more often than this residual ever has.
 * The cost of each false positive is a kill-and-`--continue` of a lead that
 * was already doing nothing, not a lost turn; of each false negative, one
 * missed switch.
 */
export function detectRateLimitModal(stdout: string, now?: Date, sighting?: LimitSighting | null): PaneVerdict {
  const parts = stdout.split(`${PANE_CAPTURE_MARKER}\n`);
  if (parts.length !== 2) {
    return { kind: "inconclusive", reason: "pane probe produced no second observation" };
  }
  const [first, second] = parts.map((p) => p.replace(/\s+$/, ""));
  if (first.length === 0 || second.length === 0) {
    return { kind: "inconclusive", reason: "pane probe captured nothing" };
  }
  if (aboveAgentPanel(first) !== aboveAgentPanel(second)) {
    return {
      kind: "working",
      reason: `pane repainted within ${PANE_QUIESCE_SECONDS}s — a turn is in flight`,
      repainted: true,
    };
  }
  return detectLimitOnScreen(first, now, sighting);
}

/**
 * The shape half of detectRateLimitModal, over ONE screen, with no
 * quiescence guard. Issue #99's wake gate reads it before typing: there the
 * bias flips — a false positive costs one wake, a false negative can type a
 * digit into a spend option — so a single capture is enough to refuse.
 */
export function detectLimitOnScreen(screen: string, now?: Date, sighting?: LimitSighting | null): PaneVerdict {
  const lines = screen.replace(/\s+$/, "").split("\n").slice(-MODAL_TAIL_LINES);
  const inline = inlineLimitBlock(lines, now, sighting);
  return orgLimitModal(lines) ?? deadAccountBlock(lines) ?? (inline?.kind === "modal" ? inline : null)
    ?? bottomLimitModal(lines) ?? inline
    ?? { kind: "working", reason: "no limit block or limit modal at the bottom of the pane" };
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/**
 * Move the studio to the next account (its token in `$FLEET_TOKEN`) WITHOUT ever answering the modal.
 *
 * NOTHING HERE TOUCHES THE DIALOG. Issue #53 is explicit about why: the
 * highlighted option sits one line from "Upgrade your plan", and a wrong Enter
 * costs money. So the modal is not answered, it is removed — the process
 * drawing it is killed out from under it.
 *
 * Four steps, chained with `&&` so a failure stops the sequence rather than
 * half-applying it:
 *
 *   1. `set-environment -t studio` puts the next token into the tmux SESSION
 *      environment. This is the fix for the thing that made `/login` useless:
 *      tmux captures the server environment once, at `tmux new-session`, so
 *      the token a studio uses is otherwise frozen at container start.
 *   2. `respawn-pane -k -t studio:claude` kills whatever the pane is running
 *      and restarts the pane's own command (the plain bash the window is built
 *      on — see container/studio-bringup.sh's "window 0" comment). tmux's OWN
 *      kill, not `pkill` — not because procps is absent (it IS present in the
 *      studio image: measured, `pgrep -fc claude` answers real counts in
 *      production, and observed.ts's own paneLeadProbeCmd already relies on
 *      `pgrep`/`ps`), but because addressing the pane BY NAME is more precise
 *      than a process-name match and selects nothing else on the box.
 *   3. a bounded wait for `pane_current_command` to read `bash` — the script's
 *      own signal for "nothing is running in the pane", reused rather than
 *      invented. Bounded by construction; it cannot spin.
 *   4. `C-c`, only into a pane that reads `bash`, then one `send-keys` of a
 *      shell line that ADOPTS the new token by reading it back out of the
 *      tmux session environment.
 *
 * WHY THE C-c (#90): an attach client answers tmux's DA2/XTVERSION queries,
 * and replies tmux does not consume land in readline as keystrokes. `ESC P`
 * opens a history search, the adopt line is eaten, and the leftover
 * `0;276;0c` is glued onto the launch line bring-up types next — a lead with
 * a corrupted argv. MEASURED (tmux 3.2a): the queries go out once per ATTACH
 * and never on respawn-pane, so the hazard is an attach landing inside the
 * respawn -> adopt window. C-c clears only junk that arrived BEFORE it;
 * replies arriving later still corrupt the relaunch. Full closure is the
 * image half (#145: C-c + one retry inside bring-up's own launch) plus a
 * reply filter in the TerminalBridge. Gated on `bash` so it never reaches a
 * claude still drawing the modal.
 *
 * WHY STEP 4 EXISTS AT ALL, given step 1: the relaunch is a `send-keys` into
 * the pane's bash (that is how bring-up launches claude), so claude inherits
 * THAT SHELL's environment. respawn-pane is expected to start the new shell
 * from the session environment step 1 just wrote, but this must not depend on
 * that: the export line makes the pane's shell hold the new token whether or
 * not tmux propagated it, and is a no-op when it already does.
 *
 * WHY THE TOKEN IS NEVER IN THE send-keys TEXT: everything typed into this
 * pane is echoed in the pane, mirrored byte-for-byte by bring-up's
 * `pipe-pane` into /workspace/.transcript/claude.log, and shipped to R2 by
 * transcript.ts. The token would be in an archive forever. The pane therefore
 * receives a command that READS the secret, never the secret.
 *
 * #110 review: the returned string carries NO token. Step 1 reads
 * `$FLEET_TOKEN` (handed over in the exec's env, credentials.ts's tokenEnv)
 * and pipes a `set-environment` line into `tmux source-file -` from printf,
 * a bash builtin — so the token is in no argv, not even tmux's. Measured in
 * the studio image (tmux 3.2a): `source-file -` reads stdin.
 */
export function accountSwitchCmd(): string {
  // No single quote anywhere in this line: the whole line is itself passed to
  // send-keys inside single quotes. `sed -n s/.../p` needs no quoting of its
  // own because the expression contains no whitespace.
  const adopt =
    `__ff_t=$(tmux show-environment -t studio CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null | ` +
    `sed -n s/^CLAUDE_CODE_OAUTH_TOKEN=//p); ` +
    `[ -n "$__ff_t" ] && export CLAUDE_CODE_OAUTH_TOKEN="$__ff_t"; unset __ff_t`;
  return withStudioTmux([
    `printf "set-environment -t studio CLAUDE_CODE_OAUTH_TOKEN '%s'\\n" "$${FLEET_TOKEN_ENV}" | ${STUDIO_TMUX} source-file - &&`,
    `${STUDIO_TMUX} respawn-pane -k -t studio:claude &&`,
    // Issue #136: the wait must FAIL on timeout. A bare `for … && break`
    // loop exits 0 either way, so a pane that never returned to bash still
    // got the adopt line + Enter typed into whatever was running in it.
    `{ __ff_ok=1; for _ in $(seq 1 10); do ` +
      `if [ "$(${STUDIO_TMUX} display-message -p -t studio:claude '#{pane_current_command}')" = bash ]; then __ff_ok=0; break; fi; ` +
      `sleep 1; done; [ "$__ff_ok" = 0 ]; } &&`,
    // #90's C-c, gated on bash. No trailing `; true` (#141 review): a pane
    // that fails this re-check must stop the chain, not still get the adopt
    // line + Enter.
    `{ [ "$(${STUDIO_TMUX} display-message -p -t studio:claude '#{pane_current_command}')" = bash ] && ${STUDIO_TMUX} send-keys -t studio:claude C-c; } &&`,
    `${STUDIO_TMUX} send-keys -t studio:claude -- '${adopt}' Enter`,
  ].join("\n"));
}

/**
 * POSIX single-quoting for dismissModalCmd's own grep patterns below — the
 * same construction wake.ts's own private `shellQuote` makes. Duplicated
 * rather than imported: see DISMISS_LIMIT_PATTERNS's own doc comment for why
 * this file cannot import ANYTHING from wake.ts at its top level.
 */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Matches wake.ts's own LOOSE_TAIL_LINES (issue #136) — the bottom slice of
 *  the pane a loose, false-positive-biased modal check is run over. */
const DISMISS_TAIL_LINES = 12;

/**
 * Issue #109 — the SAME loose, false-positive-biased modal check wake.ts's
 * own `LOOSE_LIMIT_PATTERNS`/`looseLimitOnScreen` run (see dismissModalCmd's
 * own doc comment for why this file cannot import it), rebuilt here from
 * THIS file's own RATE_LIMIT_HEADLINES — the single upstream source both
 * copies share, so only the fixed POSIX-ERE scaffolding (never the wording
 * list) is duplicated. Same POSIX ERE, C-locale-safe discipline wake.ts's
 * own copy is written under.
 */
const DISMISS_ROW_LEAD = "^[[:space:]]*(│[[:space:]]*(❯[[:space:]]*)?)?";
const DISMISS_ROW_TAIL = "[[:space:]]*(│)?[[:space:]]*$";
const DISMISS_LIMIT_PATTERNS: readonly string[] = [
  `${DISMISS_ROW_LEAD}Enter to confirm · Esc to cancel${DISMISS_ROW_TAIL}`,
  `${DISMISS_ROW_LEAD}(Run )?/rate-limit-options`,
  `${DISMISS_ROW_LEAD}(${RATE_LIMIT_HEADLINES.join("|")})${DISMISS_ROW_TAIL}`,
];

/** Prefix of the one verdict line dismissModalCmd's shell prints — did it
 *  actually find the modal still there and send Escape, or was it already
 *  gone (a no-op)? Parsed by runAccountFailover's own auto-continue step to
 *  fill in FailoverOutcome's `dismissed` field. */
export const DISMISS_VERDICT = "__FLEET_DISMISS__";

/**
 * Issue #109 — the one narrow, sanctioned exception to wake.ts's gate 3
 * ("not the wake, not an Esc"): a single Esc into the rate-limit modal's own
 * CANCEL, sent only after re-confirming, in the SAME shell invocation, that
 * the modal is still on screen.
 *
 * WHY A LONE ESC IS SAFE where gate 3 refuses a wake (text + Enter) into the
 * identical modal shape: Esc is the modal's own CANCEL —
 * RATE_LIMIT_MODAL_MARKERS'/bottomLimitModal's own footer line reads `Enter
 * to confirm · Esc to cancel`, and every measured select variant draws that
 * footer or an equivalent (MODAL_FOOTER_LINE). Esc cancels the dialog
 * outright; it can never land on a highlighted option ("Upgrade your plan",
 * "Add funds") the way a stray digit followed by Enter could — there is no
 * digit, no Enter, and no text in the keystroke at all for the modal to
 * interpret as a choice.
 *
 * ONE shell invocation, no Worker round trip in between — the same reasoning
 * accountSwitchCmd's own doc comment gives for why races matter here: a
 * modal that clears between an earlier probe and this exec must not get
 * answered by the keystroke.
 *
 *   1. re-capture the pane and re-confirm a select-style modal is STILL on
 *      screen, immediately before sending anything. The check reused is the
 *      SAME loose, false-positive-biased shape wake.ts's own
 *      `looseLimitOnScreen`/`LOOSE_LIMIT_PATTERNS` runs (see
 *      DISMISS_LIMIT_PATTERNS's own doc comment for why it is rebuilt here
 *      rather than imported) — deliberately biased toward false positives,
 *      which is the right bias here too: this command must never refuse to
 *      act on a genuine modal, and a false positive costs at most one
 *      harmless Esc into an idle pane.
 *   2. if still there: send exactly ONE keystroke, Escape. Nothing else — no
 *      Enter, no digit, no C-u, ever.
 *   3. if the modal is no longer there (or the pane could not be read at
 *      all): do nothing. A no-op, not an error — the race window is real (the
 *      pane can recover, or a human can already have dismissed it, between
 *      this tick's earlier paneCaptureCmd probe and this exec) and must fail
 *      toward doing nothing.
 *
 * Prints ONE verdict line (DISMISS_VERDICT …) so the caller can tell which of
 * (2)/(3) happened, without a second exec.
 */
export function dismissModalCmd(): string {
  const es = DISMISS_LIMIT_PATTERNS.map((p) => `-e ${shellSingleQuote(p)}`).join(" ");
  return withStudioTmux([
    `__ffd_c=$(${STUDIO_TMUX} capture-pane -p -t studio:claude 2>/dev/null);`,
    `__ffd_t=$(printf '%s\\n' "$__ffd_c" | sed '/^[[:space:]]*$/d' | tail -n ${DISMISS_TAIL_LINES});`,
    `if printf '%s\\n' "$__ffd_t" | grep -E -m 1 ${es} >/dev/null 2>&1; then`,
    `  ${STUDIO_TMUX} send-keys -t studio:claude Escape;`,
    `  echo '${DISMISS_VERDICT} escaped';`,
    `else`,
    `  echo '${DISMISS_VERDICT} no-modal';`,
    `fi`,
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/** What the failover step needs from the outside world. Same narrow-port shape
 *  every other unit in this feature uses (RefreshDeps, SessionSyncDeps), so it
 *  is drivable from a plain test with no container and no DO. */
export interface FailoverDeps {
  // `env`: the next account's token rides here (#110 review), never in `cmd`.
  exec(cmd: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Relaunch claude THE SAME WAY BRING-UP DOES — by re-running BRINGUP_CMD
   * with this studio's stored role env, not by assembling a launch line here.
   *
   * That is the whole point of the port. container/studio-bringup.sh only
   * sends its launch line when `pane_current_command` reads `bash`, which is
   * exactly the state accountSwitchCmd leaves the pane in, and it is the file
   * that owns every launch decision: `--dangerously-skip-permissions`, the
   * `cd` into the checkout, the one-argv `--allowedTools`, `--effort`, the
   * 8KB `--append-system-prompt` brief, and the `--continue` guard. Re-running
   * it means this feature copies none of them and cannot drift from them.
   *
   * RESUME: `--continue` is claude's own resume, and it is what keeps the lead
   * on its existing session instead of starting cold. It is bring-up's flag,
   * applied by bring-up's guard — which in-flight PR #58 (issue #54) tightens
   * from "the project directory exists" to "a `*.jsonl` session file exists
   * for the launch cwd", the exact failure mode ("No conversation found to
   * continue", claude exits) a resume flag would otherwise inherit here.
   */
  relaunch(): Promise<{ code: number; stdout: string; stderr: string }>;
  notify(message: string): Promise<void>;
  /** Issue #354: called once after a COMPLETED switch is recorded, with the
   *  new account — the DO re-derives its in-memory start config from it, so
   *  the next container start boots, and onStart records, that account. */
  onSwitched?(name: string): Promise<void>;
  now(): Date;
  /** The ordered account list (accounts.ts's resolveClaudeAccounts). A field
   *  rather than a function because it is a pure read of Worker secrets the
   *  caller already holds. */
  accounts: ClaudeAccount[];
  /** Issue #271: FLEET_AUTO_FAILOVER=on. Off, a limit is marked on the row
   *  and carded once, and no account is switched. */
  autoFailover: boolean;
  /** Issue #271: the account an unswitched studio is on — its repo's mapped
   *  primary. Absent/null: the first account, as before. */
  primary?: string | null;
  /**
   * Issue #131 (Stage B) review round 3 (2nd review of PR #135, 2026-09-30) —
   * true ONLY when THIS studio's own repo has a genuine `CLAUDE_ACCOUNT_BY_REPO`
   * entry (a real #271 mapped primary); false when `primary` above merely
   * fell back to the first configured account because no such entry exists.
   *
   * WHY THIS EXISTS, AND `primary != null` DOES NOT SUFFICE: `primary` is
   * NEVER null in real deployment. do.ts's `failoverDeps()` always wires it
   * from `primaryAccount()` -> accounts.ts's `launchAccount`, which — in the
   * no-map case — falls through to `accounts[0]` rather than returning null.
   * So `primary != null` is true for every studio with at least one
   * CLAUDE_CODE_OAUTH_TOKEN* secret set, mapped repo or not; it was only ever
   * false inside this file's own test harness, where `primary` defaults to
   * `undefined`. A generalized write condition gated on that (review round 2,
   * finding 4) wrongly armed Stage B's borrowedAccount/hand-back machinery
   * for every PLAIN multi-account fleet that never configured
   * CLAUDE_ACCOUNT_BY_REPO at all — an ordinary rate-limit switch from
   * account 1 to account 2 got recorded as a "borrow", and hand-back would
   * later kill+relaunch the pane to yank it back to account 1, uninvited.
   *
   * Absent (every caller/test that predates this field): `undefined` reads
   * falsy in the write condition below, the same safe "never opted into
   * Stage B" default production now gives an unmapped repo.
   *
   * RESIDUAL, stated rather than hidden (round 3 review escalation, resolved
   * 2026-09-30): this field can itself read `true` while `primary` above
   * reads `null` — REACHABLE, not merely theoretical. Trigger: a studio
   * already RUNNING on a recorded, non-primary account (`FLEET_AUTO_FAILOVER`
   * on, `launchAccount`'s recorded-account fast path, accounts.ts) keeps
   * running untouched if an operator later deletes the MAPPED slot's own
   * secret without recycling the studio — do.ts's `primaryAccount()` then
   * refuses that now-secretless slot on every later tick, while
   * `primaryIsMapped()` stays true (it checks only that the map KEY exists,
   * never the secret).
   *
   * BOUNDED AND NON-DESTRUCTIVE while this holds: hand-back's own guard
   * (runAccountFailover, `deps.autoFailover && rowNow.borrowedAccount &&
   * deps.primary && !verdict.repainted`) has exactly one call site and
   * requires `deps.primary` truthy as a hard precondition — with `primary`
   * null it simply never fires: no `accountSwitchCmd`, no pane kill, no
   * relaunch. A skipped hand-back just leaves the studio on its current
   * account for one more tick, same as any other skipped tick (the fresh
   * op-lock / mid-turn guards beside it skip the same way). Ordinary account
   * switching, driven by genuine exhaustion observed on the pane, keeps
   * working throughout: its target account (`current`, runAccountFailover)
   * resolves from `existing.launchedAccount`/`claudeAccount`, never from
   * `primary`, and it never crosses the #103 cross-repo reserved-primary
   * boundary (`reserved` is threaded into `nextClaudeAccount`/
   * `firstFreeAccount` untouched either way). One narrower side effect: the
   * wrap-search anchor (`start`, computed from `deps.primary` a few lines
   * into runAccountFailover) collapses to 0 while primary is null, widening
   * the ordinary first pass to the WHOLE account list instead of
   * primary-forward-only — it can still only land on an account the
   * dedicated unclaimed-spare tier (`firstFreeAccount`) already treats as
   * fair game, never a reserved primary.
   *
   * SELF-CORRECTING: `primary` and this field are both recomputed FRESH from
   * live `this.env` on every tick — do.ts's `failoverDeps()` is never cached
   * or memoized, called fresh inline at its one call site
   * (`StudioDO.syncSession()` -> `syncSessionCycle`, every
   * `SYNC_SESSION_SECONDS`) — so the moment the missing secret is restored,
   * `primary` resolves again on the very next tick and hand-back's guard
   * evaluates normally, using whatever `borrowedAccount` is still on the row
   * from before.
   *
   * The precondition itself — deleting a slot's secret while a studio is
   * actively running on it, without a recycle — is an anomalous operator
   * action outside this feature's normal operating envelope, not something
   * ordinary failover/borrow/hand-back operation would ever produce on its
   * own.
   */
  primaryIsMapped?: boolean;
  /**
   * Issue #103 — the fleet's cross-repo boundary: accounts that are some
   * OTHER repo's own `CLAUDE_ACCOUNT_BY_REPO`-mapped primary (accounts.ts's
   * `otherRepoPrimaries`), which a wrap for THIS studio must never land on,
   * regardless of position in the list or fleet-wide limit state. `primary`
   * above only ever excludes accounts BEFORE this studio's own mapped slot
   * (walking backward, `scopedAccounts` below); this is the forward half of
   * the same boundary — an account further along the list that belongs to a
   * different repo entirely. Absent: no cross-repo boundary is known, same
   * as every caller written before #103.
   */
  reservedAccounts?: Set<string>;
  /** Issue #271: how cards name an account (`<label> (<secret name>)`).
   *  Absent: the secret name. */
  display?: (name: string) => string;
  /**
   * Issue #102 — fleet-wide per-account limit state (fleet_state via
   * src/state.ts, do.ts's own read/write), read once per tick and handed to
   * accounts.ts's nextClaudeAccount so a switch skips ANY account a limit has
   * ever been seen on — not only this row's own past. `write` is called
   * whenever THIS studio's own observation of its current account's limit
   * changes, so every OTHER studio's own next failover decision sees it too.
   * Absent (every caller/test that predates this feature): no fleet-wide
   * skip — nextClaudeAccount then wraps seeing every OTHER account as free,
   * same as a fleet with no recorded limits at all.
   */
  accountLimits?: {
    read(): Promise<AccountLimits>;
    /** `dead` (issue #141): true only for the org-disabled-subscription
     *  observation — see rate-limit.ts's RateLimitObservation.dead. */
    write(name: string, until: string | null, seenAt: string, dead?: true): Promise<void>;
  };
  /**
   * Issue #131 (Stage B) — fleet-wide per-account 5h-window burn, mirrored the
   * same way `accountLimits` is (do.ts's `mirrorBurnToRegistry` writes it,
   * wherever burn already reaches the registry; a parallel `account-burn:
   * <name>` fleet_state row, rate-limit.ts's `accountBurnStateKey`). Read only
   * on the borrow second pass (accounts.ts's `nextBorrowedAccount`), which
   * only ever runs once the first pass has already found nowhere to go — see
   * that function's own doc comment for why LOWEST burn, not list order,
   * orders the candidates there. Absent (every caller/test that predates this
   * feature): the second pass treats every candidate as 0 burn, i.e. ties on
   * list order — never a crash, never a skipped candidate.
   */
  accountBurn?: {
    read(): Promise<Record<string, { window5hOutput: number }>>;
  };
  /**
   * Issue #131 (Stage B) — accounts.ts's `repoForAccount`, wired here for the
   * SAME reason `display` is: a pure naming lookup, never a failover
   * decision. Used only to name the repo a borrowed account belongs to, in
   * the loud "borrowed"/"returned" notify messages (`borrowedMessage`,
   * `returnedMessage`) — absent, or an account the map does not (or no
   * longer) mention, and the message names the account alone.
   */
  otherRepoOf?: (name: string) => string | null;
}

export type FailoverOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "inconclusive"; reason: string }
  | { kind: "no-modal"; reason: string }
  // PR #112 review: the re-render guard skipped a block. Its own kind so the
  // tick logs it (do.ts logs every outcome but `no-modal`): a guard collision
  // — a NEW limit printed with the same reset text — is otherwise silent.
  | { kind: "rerender"; block: string }
  // Issue #102: the no-flapping guard skipped an inline-only block within
  // FLAP_GUARD_MINUTES of the last switch. Its own kind, same reason
  // `rerender` has one — a skipped move nobody can see in a tail is a
  // decision nobody can audit.
  | { kind: "flap-guarded"; reason: string }
  | { kind: "switched"; from: string | null; to: string }
  // Issue #131 (Stage B) — the borrow second pass landed: `to` is some OTHER
  // repo's own mapped primary (never a routine candidate — see
  // nextBorrowedAccount's own doc comment for when this is even reachable),
  // and `fromRepo` names the repo it was borrowed from (null when the map no
  // longer names one, for display only).
  | { kind: "borrowed"; from: string | null; to: string; fromRepo: string | null }
  // Issue #131 (Stage B) — hand-back: a studio that was on `from` (the
  // borrowed account) moved back to its own mapped primary, `to`, because a
  // periodic tick observed it free again.
  | { kind: "returned"; from: string | null; to: string }
  | { kind: "exhausted"; tried: string[] }
  // Issue #271: auto-failover off, another account existed, none was used.
  | { kind: "parked"; account: string }
  | { kind: "already-degraded"; tried: string[] }
  // Issue #214: the row said `degraded … parked on the rate-limit modal` and
  // the pane says otherwise, so the row was taken back to `running`. Its own
  // kind for the same reason `rerender` has one: do.ts logs every outcome but
  // `no-modal`, and a state change nobody can see in a tail is a state change
  // nobody can audit. At most one per degradation — see runAccountFailover.
  | { kind: "recovered"; clearedAt: string }
  // Issue #109 — the auto-continue due-ness/attempt step, evaluated on every
  // `!next` tick that is genuinely exhausted (`parkedOn === null`) and
  // select-modal-shaped (`verdict.kind === "modal" && !verdict.inline`);
  // never on `"parked"`, and never touched on an inline-exhausted row (its
  // own reset self-clears through the EXISTING #214 recovery). Replaces
  // `"already-degraded"` ONLY on that path — a caller with no auto-continue
  // wiring at all, or an inline-exhausted row, keeps returning
  // `"already-degraded"` unchanged.
  //
  // A currently-exhausted, select-modal-shaped row whose due-check said "not
  // yet" — carries what an operator needs to know WHY nothing happened.
  | { kind: "auto-continue-waiting"; tried: string[]; dueAt: string | null }
  // An attempt was made: `dismissed` is whether the re-check found the modal
  // still there (and so actually sent Esc) vs. already gone (no-op);
  // `wake` is runGatedWake's outcome, coarsened to never carry a token or a
  // raw error string, matching every other outcome in this file.
  | { kind: "auto-continued"; tried: string[]; dismissed: boolean; wake: "ok" | "skipped" | "failed" };

/**
 * What a studio with nowhere left to go records, and what the operator is
 * told. Names every account tried, in order, and never a token.
 *
 * Deterministic in its inputs, which is what makes the anti-loop guard below a
 * plain string comparison: the same exhausted studio produces the same message
 * every tick, so a second tick can see it has already said this.
 *
 * `earliestReset` (issue #102 requirement 3) — the earliest fleet-wide reset
 * among the accounts just tried (accounts.ts's earliestAccountReset), or null
 * when none of them have a readable one. Appended, never required: every
 * caller that predates #102 passes nothing and gets exactly today's message.
 */
export function exhaustedMessage(studioId: string, tried: string[], earliestReset?: string | null): string {
  const names = tried.length > 0 ? tried.join(", ") : "none configured";
  return (
    `${exhaustedMessagePrefix(studioId)} in tmux studio:claude ` +
    `and every account has been tried (${names}). No switch attempted. ` +
    `Add another CLAUDE_CODE_OAUTH_TOKEN_<n> secret to give the fleet somewhere to go.` +
    (earliestReset ? ` Earliest reset: ${earliestReset}.` : "")
  );
}

/**
 * Issue #214: the part of exhaustedMessage that does NOT depend on which
 * accounts were tried — which is how the clear below recognises a degradation
 * as THIS feature's own, and never heals one it did not write (a clone
 * failure, a credential streak, a failed switch: `state`/`error` are a shared
 * channel, see StudioStatus.lastRefreshError's doc comment).
 *
 * Exported and shared with exhaustedMessage so the two cannot drift: a reword
 * of the message that forgot this prefix would silently stop every degraded
 * row from ever clearing, and no test of the message alone would notice.
 * Names the studio, so one studio's row can never be healed by another's
 * message.
 */
export function exhaustedMessagePrefix(studioId: string): string {
  return `claude account exhausted: ${studioId} is parked on the rate-limit modal`;
}

/** Issue #271: what a studio parked on the limit with auto-failover OFF
 *  records and cards. Starts with exhaustedMessagePrefix so #214's heal clears
 *  it the same way once the pane recovers. */
export function parkedMessage(studioId: string, account: string): string {
  return (
    `${exhaustedMessagePrefix(studioId)} in tmux studio:claude on ${account}. ` +
    `Auto-failover is off (set FLEET_AUTO_FAILOVER=on to enable it); no switch attempted.`
  );
}

/** What an operator is told when a studio moves itself. Names both accounts,
 *  never a token, and says what it matched on — a failover nobody can audit is
 *  the failure this message exists to prevent. */
export function switchedMessage(
  studioId: string, from: string | null, to: string, headline: string,
): string {
  return (
    `claude account switch: ${studioId} matched the rate-limit modal ("${headline}") in tmux studio:claude ` +
    `and moved from ${from ?? "its first account"} to ${to}. claude was relaunched with its own resume.`
  );
}

/**
 * Issue #131 (Stage B) — "log it loudly". What an operator is told when a
 * studio borrows another repo's own mapped primary: names BOTH repos (its
 * own, and the one the account is reserved for), so the alert is legible on
 * its own, without a second lookup at `CLAUDE_ACCOUNT_BY_REPO`, about exactly
 * the boundary #103/#117 exist to protect — this is the one deliberate,
 * bounded exception to it.
 */
export function borrowedMessage(
  studioId: string, from: string | null, to: string, ownRepo: string | null, borrowedFromRepo: string | null,
  headline: string,
): string {
  return (
    `claude account BORROW: ${studioId} (repo ${ownRepo ?? "?"}) matched the rate-limit modal ("${headline}") ` +
    `in tmux studio:claude and moved from ${from ?? "its first account"} to ${to} — every account reserved for ` +
    `${ownRepo ?? "this repo"} was limited, so it borrowed ${to}, ${borrowedFromRepo ?? "another repo"}'s own ` +
    `mapped primary. Hand-back is automatic the moment ${ownRepo ?? "this repo"}'s own primary frees up again. ` +
    `claude was relaunched with its own resume.`
  );
}

/**
 * Issue #131 (Stage B) — hand-back's own notify. `from` is the borrowed
 * account the studio is moving OFF of; `to` is always this studio's own
 * mapped primary.
 */
export function returnedMessage(studioId: string, from: string | null, to: string, show: (name: string) => string): string {
  return (
    `claude account RETURN: ${studioId} moved back from the borrowed account ${from !== null ? show(from) : "(unknown)"} ` +
    `to its own mapped primary ${show(to)} — the primary is free again. claude was relaunched with its own resume.`
  );
}

/**
 * The redraw guard's key for a limit block: headline + printed reset (fix
 * pass B — the reset alone let a DIFFERENT limit with the same reset text,
 * say a weekly block after a session one, pass as the old block's redraw).
 */
export function limitBlockKey(verdict: Extract<PaneVerdict, { kind: "modal" }>): string {
  return `${verdict.headline ?? verdict.marker} · ${verdict.resets ?? ""}`;
}

/**
 * Issue #127: the slice of the SAME Durable Object storage that holds the
 * first sighting. Kept off StudioStorage's overloads on purpose: every test
 * fake of that interface would have to learn a key only failover uses.
 */
interface SightingStorage {
  get(key: typeof LIMIT_SIGHTING_KEY): Promise<LimitSighting | undefined>;
  put(key: typeof LIMIT_SIGHTING_KEY, value: LimitSighting): Promise<void>;
}

/**
 * Issue #221 (PR3a, Task 4) — the `WAITING MEMBERS` panel-diff leg (design
 * table option A: the existing 300s two-capture probe, never a new exec).
 * Own DO key, same "kept off StudioStorage's overloads" reasoning
 * `SightingStorage` above states for itself. activity.ts's `nextActivity`
 * reads it back on the 30s ship tick and forces `waiting-members` while it
 * is still fresh — see that file's own `membersTickingFresh`.
 */
export const MEMBERS_TICKING_KEY = "membersTickingAt";

interface MembersTickingStorage {
  get(key: typeof MEMBERS_TICKING_KEY): Promise<string | undefined>;
  put(key: typeof MEMBERS_TICKING_KEY, value: string): Promise<void>;
}

/**
 * Issue #311 — member-alerts.ts's own two DO keys, DEFINED here rather than
 * there, for the same reason `MEMBERS_TICKING_KEY` lives here rather than in
 * activity.ts: member-alerts.ts imports (VALUE) `agentPanelRows` FROM
 * activity.ts, and activity.ts's own `clearActivityState` needs to delete
 * BOTH of these keys alongside `ACTIVITY_KEY`/`MEMBERS_TICKING_KEY` — a
 * value import of them FROM member-alerts.ts would cycle back through
 * activity.ts at runtime. failover.ts sits below both (member-alerts.ts and
 * activity.ts each import these two constants FROM here), the same
 * DAG-not-cycle shape this file's own header already establishes for
 * MEMBERS_TICKING_KEY.
 */
export const MEMBER_ALERTS_KEY = "memberAlerts";
export const MEMBER_ROWS_KEY = "memberRows";

/**
 * The agent-panel rows below claude's footer, joined — or null when there is
 * no footer to anchor against. A private copy of the same shape activity.ts's
 * own `agentPanelRows` exports (that file imports FROM this one already, so a
 * reverse import here would cycle); kept in lockstep by construction, since
 * both are built from the SAME `footerAtBottom`/`AGENT_PANEL_LINE` primitives
 * this file already owns.
 */
function agentPanelRows(capture: string): string | null {
  const lines = capture.replace(/\s+$/, "").split("\n");
  const footer = footerAtBottom(lines);
  if (footer < 0) return null;
  return lines.slice(footer + 1).filter((l) => AGENT_PANEL_LINE.test(l)).join("\n");
}

/**
 * Issue #127: the first sighting for an inline block — `sighting` itself when
 * it already records this block (so nothing is re-parsed), a fresh one
 * computed against `now` otherwise. `null` for a select modal: it has no
 * reset to remember.
 */
function sightingFor(
  verdict: Extract<PaneVerdict, { kind: "modal" }>, now: Date, sighting: LimitSighting | null,
): LimitSighting | null {
  if (!verdict.inline) return null;
  const block = limitBlockKey(verdict);
  if (sighting?.block === block) return sighting;
  return firstSighting(block, verdict.resets ?? null, now, "live");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A new first sighting. PR #144 review: a time-only reset ("8pm (UTC)") goes
 * by DIRECTION, never the nearest occurrence — claude prints time-only for any
 * reset ≤ 24h away, so a weekly block seen at 02:00Z means TONIGHT's 20:00Z,
 * not yesterday's. A LIVE block's reset is the next occurrence at or after
 * `now`; a block already STALE when first seen reset at the previous one.
 * A dated reset keeps parseResetUtc's nearest year.
 */
function firstSighting(block: string, printed: string | null, now: Date, as: "live" | "stale"): LimitSighting {
  let until = printed ? parseResetUtc(printed, now) : null;
  if (until !== null && /^\d/.test(printed!)) {
    const t = Date.parse(until);
    if (as === "live" && t < now.getTime()) until = new Date(t + DAY_MS).toISOString();
    if (as === "stale" && t > now.getTime()) until = new Date(t - DAY_MS).toISOString();
  }
  return { block, printed, until, seenAt: now.toISOString() };
}

/** The row's limit observation for a modal verdict. Returns `prior` itself
 *  when nothing changed, so the caller can tell "nothing new". An inline
 *  block's until and seenAt come from its FIRST sighting (#127). Issue #141:
 *  `dead` is compared too, so a dead sighting is never discarded as
 *  "unchanged" before the dead flag itself is captured on the very first
 *  tick (a dead verdict's `until` is always null, same as a plain unreadable
 *  inline block's, so `until`/`select` alone cannot tell the two apart). */
function limitObservation(
  verdict: Extract<PaneVerdict, { kind: "modal" }>, now: Date, prior: RateLimitObservation | null,
  sighting: LimitSighting | null,
): RateLimitObservation {
  const select = !verdict.inline;
  const until = sighting ? sighting.until : verdict.resets ? parseResetUtc(verdict.resets, now) : null;
  const dead = verdict.dead === true;
  if (prior && prior.until === until && !!prior.select === select && !!prior.dead === dead) return prior;
  return {
    until, seenAt: sighting?.seenAt ?? now.toISOString(),
    ...(select ? { select: true as const } : {}), ...(dead ? { dead: true as const } : {}),
  };
}

/**
 * Issue #274 — the degraded-row-recovery CHECK itself, extracted from
 * runAccountFailover's own `working` branch (issue #214's doc comment there
 * states the evidence rule in full; this is that rule, pulled out to a pure
 * function) so BOTH the slow 300s `runAccountFailover` path and the fast 30s
 * ship-tick path (do.ts's `runShipTickWithObservation`, reusing #221's
 * already-captured pane frame) make EXACTLY the same call from the same
 * evidence, and can never fork into two subtly different implementations.
 *
 * Pure by construction: no storage, no exec, no clock read of its own —
 * `now` is a parameter. The operation-lock freshness check
 * (`operationLockFresh(await storage.get(OPERATION_KEY), ...)`) is
 * deliberately left OUT and OWNED BY EACH CALLER, since that is an async
 * storage read this function must not perform to stay callable from a plain
 * test (or the other call site) with no storage at all: `shouldHeal` here
 * means "parked and recovered", and a caller ANDs its own lock check onto it
 * before actually writing anything.
 *
 * `claudeOnScreen`/`parked`/`recovered` are returned individually (not just
 * `shouldHeal`) because runAccountFailover's own `forget` (the redraw-guard
 * retirement, unrelated to this feature) reuses the SAME `claudeOnScreen`
 * bit computed here, and must keep doing so rather than recomputing it a
 * second time from the same screen.
 */
export interface DegradedRecoveryVerdict {
  /** #186's rule: claude's own footer is the BOTTOM of the pane. */
  claudeOnScreen: boolean;
  /** The row is THIS feature's own degradation (exhaustedMessagePrefix), never
   *  a clone failure or another studio's message (issue #214). */
  parked: boolean;
  /** claude is up, AND no limit modal/inline block bottom-anchored, AND #232's
   *  position-free veto (anyLiveLimitLineOnScreen) finds no OTHER live block
   *  anywhere else in the same tail. */
  recovered: boolean;
  /** `parked && recovered` — the caller still ANDs its own operation-lock
   *  freshness check onto this before treating it as "heal now". */
  shouldHeal: boolean;
}

export function evaluateDegradedRecovery(
  existing: StudioStatus, studioId: string, screen: string, now: Date, sighting: LimitSighting | null,
): DegradedRecoveryVerdict {
  const trimmed = screen.replace(/\s+$/, "");
  const claudeOnScreen = footerAtBottom(trimmed.split("\n")) >= 0;
  const parked = existing.state === "degraded"
    && (existing.error?.startsWith(exhaustedMessagePrefix(studioId)) ?? false);
  const recovered = claudeOnScreen
    && detectLimitOnScreen(trimmed, now, sighting).kind !== "modal"
    && !anyLiveLimitLineOnScreen(trimmed, now, sighting);
  return { claudeOnScreen, parked, recovered, shouldHeal: parked && recovered };
}

/**
 * Issue #102 — the no-flapping cooldown, in minutes. One SYNC_SESSION_SECONDS
 * tick (300s = 5m, session-sync.ts): long enough for a just-completed switch's
 * `--continue` resume to finish drawing its own transcript (the redraw window
 * the guard exists to cover — see runAccountFailover's own doc comment at the
 * check), short enough that a genuinely new limit on the very next tick is
 * still caught the tick after that, rather than sitting silently blocked.
 */
export const FLAP_GUARD_MINUTES = 5;

/** Issue #109: the short, generic resume nudge an auto-continue attempt's
 *  `runGatedWake` types — not a claim that work exists, just enough to get a
 *  turn started once the pane is no longer blocked on the modal. */
export const AUTO_CONTINUE_PROMPT = "usage limit reset — resuming";

/** Issue #109: the hourly retry cap for an unknown-reset select modal, and
 *  the anti-hammer cadence after a known reset's first attempt (consumed
 *  back to null on fire either way — see StudioStatus.autoContinueAt's own
 *  doc comment). */
const AUTO_CONTINUE_RETRY_MS = 60 * 60_000;

/**
 * Issue #131 (Stage B) — the hand-back switch: move a studio off a borrowed
 * account back onto its own mapped primary. Called from runAccountFailover's
 * `working` branch (see that branch's own doc comment for WHY there, and why
 * no separate periodic hook is needed) the moment a periodic tick observes
 * the primary free again.
 *
 * Mirrors the shape of the ordinary account switch further down in this file
 * (exec the switch, relaunch, record, notify) but deliberately does LESS:
 *   - no redraw-guard bookkeeping (`failoverBlock`/`claudeAccountMovedBlock`
 *     are cleared, not set) — there is no limit block to key a future guard
 *     on, since hand-back fires on a CLEAN pane, not a freshly-observed one;
 *   - no `claudeAccountMovedVia` — that field's only reader is the
 *     no-flapping guard, which exists to judge whether a fresh INLINE
 *     observation is a stale `--continue` redraw of a SELECT-modal switch;
 *     hand-back is neither, so leaving it unset (rather than mislabelling it
 *     `"modal"`) keeps that guard's own meaning intact for whatever switch
 *     comes next;
 *   - no `observedStorage` bring-up re-verification (the incarnation-token
 *     write + session-verdict machinery near the bottom of
 *     `runAccountFailover`) — that exists specifically for a FRESH
 *     limit-triggered switch's own post-switch session-verdict write; a
 *     hand-back is not one, and STATED as a residual in this feature's own
 *     plan doc rather than silently left out.
 */
async function handBack(
  deps: FailoverDeps, storage: StudioStorage, studioId: string, existing: StudioStatus,
  ownPrimary: ClaudeAccount, recordStudioFn: (status: StudioStatus) => Promise<void>,
): Promise<FailoverOutcome> {
  const from = existing.borrowedAccount ?? null;
  const switchRes = await deps.exec(accountSwitchCmd(), tokenEnv(ownPrimary.token));
  const relaunchRes = switchRes.code === 0
    ? await deps.relaunch()
    : { code: switchRes.code, stdout: "", stderr: switchRes.stderr };
  const failed = switchRes.code !== 0 || relaunchRes.code !== 0;
  const show = deps.display ?? ((name: string) => name);
  const error = failed
    ? redactSecrets(
        `claude account hand-back to ${ownPrimary.name} did not complete (exit ${relaunchRes.code}): ` +
        `${relaunchRes.stderr.slice(0, 500)}`,
      )
    : null;
  const returned: StudioStatus = {
    ...existing,
    state: failed ? "degraded" : "running",
    error,
    claudeAccount: ownPrimary.name,
    // #289: a completed switch is a launch on the new account.
    ...(failed ? {} : { launchedAccount: ownPrimary.name }),
    claudeAccountMovedAt: deps.now().toISOString(),
    // See this function's own doc comment for why this is cleared, not set.
    claudeAccountMovedVia: null,
    failoverBlock: null,
    claudeAccountMovedBlock: null,
    // The whole point: no longer borrowed, whether the switch landed or not
    // — same "attempted regardless of success" treatment `claudeAccount`
    // itself already gets above.
    borrowedAccount: null,
    borrowedFromRepo: null,
  };
  await storage.put(STATUS_KEY, returned);
  // Issue #354: the in-memory start config follows the ROW before any other
  // await, same ordering the ordinary switch path uses below.
  if (!failed) await deps.onSwitched?.(ownPrimary.name);
  await recordStudioFn(returned);
  const message = returnedMessage(studioId, from, ownPrimary.name, show);
  await deps.notify(failed ? `${message} RELAUNCH FAILED: ${error}` : message);
  return { kind: "returned", from, to: ownPrimary.name };
}

/**
 * Issue #109 — is an auto-continue attempt DUE, given the row's own
 * bookkeeping? Pure, so the state machine is testable with no exec at all.
 *
 *   - a KNOWN reset (`autoContinueAt` set): due once `now` has reached it;
 *   - an UNKNOWN reset (`autoContinueAt` null/absent — the overwhelmingly
 *     common select-modal case, #4 above): due immediately the first time
 *     (`autoContinueLastTriedAt` null/absent), then hourly.
 */
function autoContinueDue(row: StudioStatus, now: Date): boolean {
  if (row.autoContinueAt) return now.getTime() >= Date.parse(row.autoContinueAt);
  if (!row.autoContinueLastTriedAt) return true;
  return now.getTime() - Date.parse(row.autoContinueLastTriedAt) >= AUTO_CONTINUE_RETRY_MS;
}

/**
 * Issue #109 — the due-ness check and, when due, the dismiss+wake attempt,
 * for a genuinely exhausted (`parkedOn === null`), select-style-modal row.
 * Called from BOTH the fresh-degrade write and the anti-loop-guard tick
 * inside runAccountFailover's `!next` branch — see that function's own doc
 * comment for why this is a bounded exception to "no retry loop", never a
 * retry of the account list itself.
 *
 * Returns the fields to patch onto the row (never `state`/`error` —
 * recovery to `running` stays the EXISTING #214 `working`-branch's own job)
 * and the outcome to report. `patch` is null when not due: no write happens
 * at all, matching the anti-loop guard's own "no write" invariant for the
 * overwhelming majority of ticks.
 *
 * `runGatedWake` (not the raw `runWake`) is imported LAZILY, inside this
 * function, rather than statically at this file's own top: wake.ts's own
 * `LOOSE_LIMIT_PATTERNS` is built, AT ITS OWN MODULE TOP LEVEL, from THIS
 * file's `RATE_LIMIT_HEADLINES` — MEASURED, a static import back into this
 * file throws `ReferenceError: Cannot access 'RATE_LIMIT_HEADLINES' before
 * initialization` the moment any entry point reaches this file before
 * wake.ts (several test files do: they import failover.ts before do.ts's
 * own chain ever reaches wake.ts). A dynamic `import()` resolves against the
 * already-settled module registry, at CALL time — well after every module
 * has finished loading — so it closes no cycle at all. `GatedWakeDeps`
 * itself is imported as a TYPE only (erased at compile time, no runtime
 * import), which is why it can sit in this function's own signature.
 */
async function autoContinueAttempt(
  deps: FailoverDeps, studioId: string, row: StudioStatus, tried: string[], sighting: LimitSighting | null,
): Promise<{ patch: Partial<StudioStatus> | null; outcome: FailoverOutcome }> {
  const now = deps.now();
  if (!autoContinueDue(row, now)) {
    return { patch: null, outcome: { kind: "auto-continue-waiting", tried, dueAt: row.autoContinueAt ?? null } };
  }
  const dismissRes = await deps.exec(dismissModalCmd());
  const dismissed = dismissRes.stdout.includes(`${DISMISS_VERDICT} escaped`);
  const { runGatedWake } = await import("./wake");
  const gatedDeps: GatedWakeDeps = {
    recordedState: async () => row.state,
    exec: deps.exec,
    now: deps.now,
    studioId,
    switchedBlock: async () => row.failoverBlock ?? null,
    limitSighting: async () => sighting,
  };
  const wakeOutcome = await runGatedWake(gatedDeps, AUTO_CONTINUE_PROMPT);
  const wake: "ok" | "skipped" | "failed" = wakeOutcome.ok ? "ok" : wakeOutcome.skipped ? "skipped" : "failed";
  return {
    patch: { autoContinueAt: null, autoContinueLastTriedAt: now.toISOString() },
    outcome: { kind: "auto-continued", tried, dismissed, wake },
  };
}

/**
 * One failover step, for one studio. Called from do.ts's syncSession cycle.
 *
 * Does NOTHING unless the pane is showing the modal — the common case is one
 * container exec and no writes at all.
 *
 * NO RETRY LOOP ANYWHERE, and three separate things guarantee it:
 *   - accounts.ts's nextClaudeAccount only ever moves FORWARD through the
 *     ordered list, so a studio can switch at most (accounts - 1) times, ever;
 *   - a switch attempt records its account whether the container steps
 *     succeeded or not, so a container that is broken in some other way walks
 *     the list to its end and stops instead of retrying the same account;
 *   - once the list is spent the studio is written `degraded` ONCE and every
 *     later tick that still SEES THE LIMIT returns `already-degraded` without
 *     a write, a notify or a container command.
 * An operator un-sticks it by writing another CLAUDE_CODE_OAUTH_TOKEN_<n>
 * secret: the next tick then has somewhere to go.
 *
 * ISSUE #214 qualifies that last bullet, and nothing else. A tick that sees
 * claude's footer at the bottom of the pane with no limit on it writes the row
 * back to `running` ONCE — the degradation described a pane, the pane has
 * changed, and the row must not outlive it. Still at most one write per
 * degradation in each direction, still no retry loop: the clear's own
 * precondition is the state its own write removes. See the block in the
 * `working` branch below for the evidence it requires and why.
 *
 * ISSUE #109 adds one more, deliberate and narrow amendment, on top of #214.
 * It is still true that no ACCOUNT is ever retried, and the three guarantees
 * above (forward-only account walk, switch-always-recorded, degrade-once)
 * are untouched — this adds a SEPARATE, explicitly bounded retry of the
 * DISMISSAL, capped at once per known-reset-due-moment plus once per hour
 * thereafter, never of the account list itself. See autoContinueAttempt's
 * own doc comment for the mechanics, and StudioStatus.autoContinueAt's for
 * the bookkeeping it reads and writes.
 */
export async function runAccountFailover(
  deps: FailoverDeps,
  storage: StudioStorage,
  idFallback: string,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  observedStorage?: ObservedStorage,
): Promise<FailoverOutcome> {
  const stored = await storage.get(STATUS_KEY);
  if (!stored) return { kind: "skipped", reason: "no status recorded yet" };
  let existing: StudioStatus = stored;
  // A stopped studio has no container to probe, and probing one would START
  // it — an exec is what brings a container up (see do.ts's restartStudio
  // ordering comment). Nothing about an account is decidable here.
  if (existing.state === "stopped") return { kind: "skipped", reason: "studio is stopped" };
  const destroyLanded = await watchForDestroy(storage, deps.now);

  const sightings = storage as unknown as SightingStorage;
  const sighting = (await sightings.get(LIMIT_SIGHTING_KEY)) ?? null;
  const probe = await deps.exec(paneCaptureCmd());
  const verdict = detectRateLimitModal(probe.stdout, deps.now(), sighting);
  if (verdict.kind === "inconclusive") return { kind: "inconclusive", reason: verdict.reason };
  // Issue #221 (PR3a, Task 4) — both captures are already in hand here (the
  // SAME exec `paneCaptureCmd` always takes): if the agent panel's own rows
  // differ between them, a member turn is genuinely running. Never fired when
  // either capture has no footer to anchor against (`agentPanelRows` returns
  // null) — that is a statement about the probe, not evidence of movement.
  {
    const [rawFirst, rawSecond] = probe.stdout.split(`${PANE_CAPTURE_MARKER}\n`);
    if (rawFirst !== undefined && rawSecond !== undefined) {
      const firstPanel = agentPanelRows(rawFirst);
      const secondPanel = agentPanelRows(rawSecond);
      if (firstPanel !== null && secondPanel !== null && firstPanel !== secondPanel) {
        await (storage as unknown as MembersTickingStorage).put(MEMBERS_TICKING_KEY, deps.now().toISOString());
      }
    }
  }
  // Issue #99 review: the capture is an outbound exec, a Durable Object's input
  // gate is open across it, and a destroy can land meanwhile. Every write
  // below builds on the row as it is NOW; a studio that stopped (or vanished)
  // during the capture is left exactly as the destroy wrote it.
  const fresh = await storage.get(STATUS_KEY);
  if (!fresh || fresh.state === "stopped" || (await destroyLanded())) {
    return { kind: "skipped", reason: "studio stopped during the pane capture" };
  }
  existing = fresh;
  // Hoisted (#214): the clear below names the studio too, and the row's own
  // id cannot change between here and the exhaustion branch that also uses it.
  const studioId = existing.id || idFallback;
  if (verdict.kind === "working") {
    // Issue #99: the pane no longer shows the limit, so the row stops saying it.
    // Fix pass B: a STATIC pane with no limit also retires the redraw guard —
    // the switched-on block has scrolled away, so a later one is new. A
    // repainting pane proves nothing either way and keeps it — and neither
    // does a still pane with no claude on it (PR #144 review: a bash prompt
    // after a failed relaunch). Only claude's own footer proves claude is up.
    //
    // Fix pass D (#170, X3): the footer must be at the BOTTOM of the FIRST
    // capture, by footerAtBottom's rule. A claude that DIED after drawing
    // leaves its whole last frame — footer included — on screen above the
    // bash prompt that replaced it, so a footer ANYWHERE read dead claude as
    // live, retired the guard, and let the next `--continue` redraw switch
    // account again. MEASURED on the #144 verifier: TOKEN_2 -> TOKEN_3.
    const screen = probe.stdout.split(`${PANE_CAPTURE_MARKER}\n`)[0].replace(/\s+$/, "");
    // Issue #274: ONE evaluation of the evidence, shared with the fast 30s
    // ship-tick path (do.ts) — see evaluateDegradedRecovery's own doc
    // comment for why claudeOnScreen/parked/recovered live there now, not
    // here.
    const recovery = evaluateDegradedRecovery(existing, studioId, screen, deps.now(), sighting);
    // Review round 1 (#102 review, 2026-09-30): claudeAccountMovedBlock is
    // forgotten on the same trigger as failoverBlock — it is not the block
    // that survives a redraw either, and a select-modal switch can carry one
    // (from `sighting`) even when `failoverBlock` itself is null.
    const forget = !verdict.repainted && recovery.claudeOnScreen
      && (existing.failoverBlock != null || existing.claudeAccountMovedBlock != null);
    // PR #144 review: a block already STALE when first seen is recorded too,
    // or it comes back in its next daily window and fires.
    if (verdict.stale && sighting?.block !== verdict.stale.block) {
      await sightings.put(LIMIT_SIGHTING_KEY, firstSighting(verdict.stale.block, verdict.stale.resets, deps.now(), "stale"));
    }
    // ISSUE #214 — the row stops claiming the lead is parked.
    //
    // MEASURED 2026-09-24: three leads degraded at 22:52Z with
    // exhaustedMessage; the maestro dismissed each modal with a lone Esc at
    // 23:32Z; all three resumed and kept committing; `fleet ls` still read
    // `degraded … parked on the rate-limit modal` at 23:38Z and 40+ minutes
    // on. A recycle cleared it (verified 00:12Z); a working lead never did.
    // The doc comment above this function states the mechanism as an
    // invariant — the studio is written `degraded` ONCE and every later tick
    // returns `already-degraded` without a write — and nothing else in this
    // file ever wrote `state` back. So the row outlived the thing it
    // described, which is the lie #85 exists to remove, and every gate keyed
    // on `degraded`/`exhausted` refused wakes to a lead that was working.
    //
    // The evidence required is the FIRST capture and nothing else, by ONE
    // rule for both a still and a repainting pane:
    //   - claude's footer is the BOTTOM of it — #186's footerAtBottom, the
    //     same call `forget` above makes, so "claude is up" means here
    //     exactly what it means there (a dead claude's last frame above a
    //     bash prompt is not claude); and
    //   - detectLimitOnScreen finds no limit block and no select modal on it,
    //     AND issue #232's position-free veto (anyLiveLimitLineOnScreen) finds
    //     no OTHER live inline block anywhere else in the same tail.
    //     THAT VETO IS WHAT MAKES THE NEXT SENTENCE TRUE, not the
    //     bottom-anchored detector by itself: detectLimitOnScreen only
    //     recognizes a block immediately followed by claude's idle input box,
    //     so anything else printed between a still-live block and the bottom
    //     of the pane — a mid-turn `/loop` wakeup line, a "Waiting for N
    //     background agent" row, queued input wrapped past its row limit, a
    //     stray line before the footer — used to slip the block past it and
    //     read the pane as recovered while the limit was still live (#232). A
    //     STILL-LIVE block therefore never clears anything, even when the
    //     pane repainted past the shape test or printed elsewhere in the tail
    //     than where the bottom-anchored detector looks — `working` with
    //     `repainted` is a statement about the two captures, never about the
    //     screen.
    // A REPAINTING pane clears the row but still does not retire the redraw
    // guard: `forget` keeps #186's rule untouched, and the two are separate
    // judgements about separate things (this row's honesty; which block the
    // last switch fired on).
    //
    // Only THIS feature's own degradation is healed (exhaustedMessagePrefix):
    // `state`/`error` are a shared channel, and a clone failure or a failed
    // switch must survive a healthy pane.
    //
    // #85 PR1's op lock (OPERATION_KEY): a provision/restart/recycle holds it
    // across its own container-exec-then-DO-patch two-step, and this tick's
    // pane capture is an outbound exec with the input gate open across it, so
    // one can land between the `fresh` read above and the write below and
    // have its row overwritten by this one. Same check-before-write
    // provisionWithStorage and the switch path below already make, and the
    // same freshness rule (review round 6, Blocker 2 — a STALE lock is no
    // lock): when someone else holds it, this tick declines and the next one
    // (300s) clears instead. A recycle clears the row itself anyway.
    //
    // NO SPAM, which the invariant above was protecting: the clear writes at
    // most ONCE per degradation. Its own precondition is `state === degraded`
    // with that error, and its own write removes both.
    const heal = recovery.shouldHeal
      && !operationLockFresh(await storage.get(OPERATION_KEY), deps.now());
    const clearedAt = heal ? deps.now().toISOString() : null;
    let rowNow = existing;
    if (existing.rateLimited || forget || clearedAt !== null) {
      const cleared: StudioStatus = {
        ...existing,
        rateLimited: null,
        ...(forget ? { failoverBlock: null, claudeAccountMovedBlock: null } : {}),
        // Issue #109 (#214 recovery): a row that genuinely recovers carries
        // no stale auto-continue bookkeeping into its next, unrelated
        // exhaustion.
        ...(clearedAt !== null
          ? { state: "running" as const, error: null, exhaustionClearedAt: clearedAt, autoContinueAt: null, autoContinueLastTriedAt: null }
          : {}),
      };
      await storage.put(STATUS_KEY, cleared);
      await recordStudioFn(cleared);
      rowNow = cleared;
    }
    // Issue #131 (Stage B) — hand-back. This exact tick already runs on a
    // FIXED CADENCE (SYNC_SESSION_SECONDS, do.ts's syncSessionCycle)
    // regardless of whether a limit is currently observed — confirmed by
    // reading do.ts's own call site before writing this code, not assumed;
    // see this feature's plan doc for the full finding. `verdict.kind ===
    // "working"` (this whole branch) is precisely "nothing is currently
    // broken on this pane", which is the state hand-back must fire in — an
    // operator cannot wait for a FRESH limit sighting that, by definition,
    // never comes once the studio is happily running on a borrowed account.
    // Guarded on `rowNow.borrowedAccount` so the overwhelming majority of
    // ticks (never borrowed) pay nothing beyond that one field read.
    //
    // Review round 2 (maestro review of PR #135), finding 1 — this whole
    // `"working"` branch fires on ANY working verdict, including a THINKING
    // lead: `verdict.repainted` is set whenever the two captures differed
    // (PANE_QUIESCE_SECONDS apart), which is precisely "a turn is in
    // flight" — the exact signal `forget` just above already refuses to act
    // on for the identical reason. Hand-back's own `accountSwitchCmd`
    // (`respawn-pane -k`) kills whatever is running in the pane, so firing
    // it mid-turn loses in-flight work; skipping it here costs nothing but
    // one more 300s tick before the studio genuinely comes home. Likewise
    // gated on a FRESH `OPERATION_KEY` — the same lock the `heal` check
    // above already reads before its own write, and the same lock the
    // ordinary switch path further below takes for its own container-exec-
    // then-DO-patch two-step: a concurrent provision/restart/recycle/
    // failover already touching this container must not be interrupted by
    // hand-back's own respawn-pane. Neither guard errors — a skipped tick
    // just leaves the studio borrowed for one more cycle, and the next tick
    // tries again.
    if (deps.autoFailover && rowNow.borrowedAccount && deps.primary && !verdict.repainted) {
      const ownPrimary = deps.accounts.find((a) => a.name === deps.primary);
      if (ownPrimary) {
        const limits = deps.accountLimits ? await deps.accountLimits.read() : {};
        if (
          accountIsFree(ownPrimary, limits, deps.now())
          && !operationLockFresh(await storage.get(OPERATION_KEY), deps.now())
        ) {
          return handBack(deps, storage, studioId, rowNow, ownPrimary, recordStudioFn);
        }
      }
    }
    if (clearedAt !== null) return { kind: "recovered", clearedAt };
    return { kind: "no-modal", reason: verdict.reason };
  }
  // Issue #106, MEASURED 2026-09-24: `claude --resume` redraws a persisted
  // limit block and its hint. The lead this studio relaunched with
  // `--continue` can therefore show the very block it was switched off —
  // same headline and reset, printed by the OLD account. Not a new limit.
  // Inline blocks only (PR #144 review): a select modal is not a transcript
  // message, so `--continue` never redraws it — the same modal on the next
  // account is that account's limit, and must walk on to exhausted.
  //
  // Maestro review of PR #152 (2026-09-30), item 1 — this check used to have
  // NO time bound at all, on the assumption that a genuinely new limit always
  // produces a DIFFERENT key (a different headline or reset). The
  // dead-account message (issue #141) breaks that assumption: it has NO
  // variable text at all, so a SECOND account that is ALSO genuinely,
  // currently dead produces the exact same key as the FIRST account's own
  // departure evidence — and the guard used to suppress it as a "rerender"
  // FOREVER, so the second account was never marked dead and the switch never
  // happened. Bounded the same way the select-modal flap-guard just below
  // already is: past FLAP_GUARD_MINUTES since the switch, a still-matching
  // inline block is trusted as fresh evidence for the CURRENT account, not
  // presumed to be an infinite `--continue` echo of the one just departed. A
  // genuine `--continue` redraw only ever replays ONCE, right at relaunch;
  // real, ongoing evidence that persists past this window is real.
  const key = verdict.inline ? limitBlockKey(verdict) : null;
  const movedRecently = existing.claudeAccountMovedAt != null
    && !Number.isNaN(Date.parse(existing.claudeAccountMovedAt))
    && deps.now().getTime() - Date.parse(existing.claudeAccountMovedAt) < FLAP_GUARD_MINUTES * 60_000;
  if (key !== null && existing.failoverBlock === key && movedRecently) {
    return { kind: "rerender", block: key };
  }
  // Issue #102 — no flapping. Guards ONLY the one path with a genuinely
  // unguarded residual: a switch that matched a SELECT-style modal
  // (`claudeAccountMovedVia === "modal"`) always records `failoverBlock:
  // null` (select modals have no block key), so the `rerender` check above
  // cannot catch a `--continue` redraw of an INLINE message the switched-off
  // account's transcript still holds. An `"inline"`-via switch is already
  // protected by its own `failoverBlock`/`rerender` pairing, ALSO bounded by
  // FLAP_GUARD_MINUTES since review round above — and a genuine SELECT-style
  // modal (`!verdict.inline`) always overrides the guard either way: claude
  // can never redraw one of those from a resumed transcript.
  //
  // Review round 1 (#102 review, 2026-09-30), finding 2 — the escape hatch
  // was UNREACHABLE for a genuinely new limit: the guard used to fire on ANY
  // inline verdict in the window, so a genuinely NEW limit on the studio's
  // OWN NEW account that happened to render inline (session/weekly/monthly-
  // spend blocks — measured, INLINE_LIMIT_HEADLINES's own doc comment, the
  // overwhelmingly common shape) was indistinguishable from a stale
  // `--continue` redraw of the OLD account's leftover transcript.
  //
  // Fixed by reusing the SAME comparison primitive the redraw guard above
  // already uses (`limitBlockKey`/`key`), via `claudeAccountMovedBlock`
  // (types.ts): the block-key this studio already knew about — from its own
  // LIMIT_SIGHTING_KEY, since a select modal's own capture can never also
  // carry an inline block (position-exclusive in detectLimitOnScreen) — at
  // the moment the select-modal switch fired, or `null` when it knew of none.
  // ONLY a NEW inline observation whose key MATCHES that recorded one is a
  // genuine stale redraw and is suppressed; a DIFFERENTLY-keyed block, or one
  // appearing when nothing at all was known at switch time
  // (`claudeAccountMovedBlock` null/absent), is trusted immediately.
  if (
    verdict.inline && existing.claudeAccountMovedVia === "modal" && existing.claudeAccountMovedAt != null
    && existing.claudeAccountMovedBlock != null && existing.claudeAccountMovedBlock === key
  ) {
    const movedMs = Date.parse(existing.claudeAccountMovedAt);
    if (!Number.isNaN(movedMs) && deps.now().getTime() - movedMs < FLAP_GUARD_MINUTES * 60_000) {
      return {
        kind: "flap-guarded",
        reason:
          `studio moved accounts within the last ${FLAP_GUARD_MINUTES}m via a select-style modal, and this inline ` +
          `limit block matches the one it already knew about then — a stale --continue redraw, not new evidence`,
      };
    }
  }
  // Issue #127: remember the FIRST sighting of this block (the detector
  // above already judged staleness from it). Written only when it changes,
  // never cleared: a `--continue` redraw days later must still read as old.
  const first = sightingFor(verdict, deps.now(), sighting);
  if (first && first !== sighting) await sightings.put(LIMIT_SIGHTING_KEY, first);

  // Issue #99: the limit is a studio STATE with a known end time — record it
  // from this capture (no second exec). Kept as-is while the reset is
  // unchanged, so a studio parked on the limit writes once, not every tick.
  const seen = limitObservation(verdict, deps.now(), existing.rateLimited ?? null, first);
  const limitChanged = seen !== (existing.rateLimited ?? null);
  existing = { ...existing, rateLimited: seen };

  // #273 r2: flag off, a claudeAccount an earlier failover recorded is stale —
  // the studio launched on its mapped primary.
  // #289: the account the lead was LAUNCHED on is the one it is on -- a map
  // change since then has not reached it.
  const current = (typeof existing.launchedAccount === "string" ? existing.launchedAccount : null)
    ?? (deps.autoFailover ? existing.claudeAccount : null) ?? deps.primary ?? null;
  const show = deps.display ?? ((name: string) => name);
  // The account the studio is on, NAMED. A studio that has never switched has
  // no recorded account and is on the first one by construction (see
  // StudioStatus.claudeAccount) — reporting that as `null` would make the one
  // message an operator reads say "moved from nothing". accountsTried's last
  // entry is that resolution, reused rather than re-derived.
  const from = accountsTried(deps.accounts, current).at(-1) ?? current;
  // Issue #102: this account is limited RIGHT NOW — mark it FLEET-WIDE (every
  // studio's own next failover decision reads this, not only this row's own
  // sighting) whenever the observation actually changed. `from` resolves a
  // never-switched studio's `null` to the real first-account name; an empty
  // fleet (no accounts at all) has no name to mark.
  if (deps.accountLimits && from !== null && limitChanged) {
    await deps.accountLimits.write(from, seen.until, seen.seenAt, seen.dead);
  }
  // Issue #271: a studio starts at its mapped primary, so accounts before it
  // were never its to try — computed once, reused below for both the
  // wrap-around search range and the "tried" list.
  const start = deps.primary ? Math.max(0, deps.accounts.findIndex((a) => a.name === deps.primary)) : 0;
  const currentIdx = current == null ? 0 : deps.accounts.findIndex((a) => a.name === current);
  // Review round 2 (maestro review of PR #135), finding 4 — the #273 r2
  // widening just below (a stale recorded `current` from BEFORE the primary
  // stepping FORWARD into scope) must NOT apply while this studio is in an
  // ACTIVE borrow: widening it then would expose an account positioned
  // before the primary to the ordinary first-pass wrap below, which #271
  // forbids landing on outside the two dedicated tiers further down.
  // `existing.borrowedAccount` is the discriminator — set ONLY by a genuine
  // Stage-B switch (finding 3's own unclaimed-spare tier, or a
  // reserved-primary borrow), never by the #273 r2 stale-legacy case: that
  // field did not exist before Stage B, and every #273 r2 test leaves it
  // unset, so this never changes that fixture's own anchor.
  const borrowedActive = existing.borrowedAccount != null;
  // Issue #102: a stale recorded `current` from BEFORE the primary (#273 r2)
  // must still be able to step FORWARD into scope, so the search range
  // extends back to cover it; a `current` already at or past the primary
  // never wraps BEHIND it — an account before a repo's mapped primary is
  // never that repo's to use, wrap or no wrap. Not while actively borrowed —
  // see `borrowedActive` above.
  const anchor = borrowedActive ? start : (currentIdx < 0 ? start : Math.min(start, currentIdx));
  const scopedAccounts = deps.accounts.slice(anchor);
  const limits = deps.accountLimits ? await deps.accountLimits.read() : {};
  const reserved = deps.reservedAccounts ?? new Set();
  // Review round 2, finding 4 — `current` falls OUTSIDE `scopedAccounts`
  // only in the new borrowed-before-`start` case the anchor above pins:
  // every other caller still lands inside it by construction. Ordinary
  // `nextClaudeAccount(scopedAccounts, current, ...)` cannot handle that
  // case on its own — see `firstFreeAccount`'s own doc comment for why
  // (there is no position to step FORWARD from, and its own `null`
  // convention wrongly skips position 0 rather than treating it as a
  // genuine candidate).
  const currentOutOfScope = borrowedActive && currentIdx >= 0 && currentIdx < anchor;
  const candidate = currentOutOfScope
    ? firstFreeAccount(scopedAccounts, reserved, limits, deps.now())
    : nextClaudeAccount(scopedAccounts, current, limits, deps.now(), reserved);
  // Review round 2 (maestro review of PR #135), finding 3 — tier 2, tried
  // ONLY once the first pass just above found nothing: an "unclaimed spare"
  // — an account positioned BEFORE this studio's own primary (never visible
  // to the first pass, which only ever scans `scopedAccounts`) that is ALSO
  // not `reserved` for another repo (never visible to the third pass below
  // either, which only ever considers `reserved` names) — a genuine blind
  // spot the original two passes left between them. List order, never
  // lowest-burn (see `firstFreeAccount`'s own doc comment) — tried BEFORE
  // the third pass: a plain free spare nobody has claimed must never lose
  // to someone else's mapped primary.
  const outOfScopeSpare = candidate === null && deps.autoFailover
    ? firstFreeAccount(deps.accounts.slice(0, anchor), reserved, limits, deps.now())
    : null;
  // Issue #131 (Stage B) — the borrow third pass, entered ONLY when BOTH
  // passes above found NOTHING (`candidate === null && outOfScopeSpare ===
  // null`): this studio's own chain (the reserved-primaries-respecting wrap
  // #103/#117 protect) AND every unclaimed spare are genuinely exhausted,
  // not merely skipped as reserved the way an account in `scopedAccounts`
  // with a live fleet-wide limit is. Borrowing is the fleet's last resort,
  // never a routine candidate — a reserved account with the lowest burn
  // must NEVER outrank a free account still in this studio's own chain or a
  // plain unclaimed spare, which is exactly why this is gated on both
  // passes returning null rather than computed unconditionally and compared
  // against them. `deps.accountBurn` is read lazily, here, on this
  // already-rare path only — the overwhelming majority of ticks (an earlier
  // pass finds somewhere to go) never pay for it.
  const borrowed = candidate === null && outOfScopeSpare === null && deps.autoFailover
    ? nextBorrowedAccount(
        deps.accounts, reserved, limits,
        deps.accountBurn ? await deps.accountBurn.read() : {}, deps.now(),
      )
    : null;
  // Issue #271: with auto-failover off, a studio that COULD move is parked
  // instead — marked and carded once, never switched. With nowhere to go the
  // message is today's, so a single-account fleet reads exactly as before.
  const next = deps.autoFailover ? (candidate ?? outOfScopeSpare ?? borrowed) : null;
  // Issue #131 (Stage B): true only when `next` came from the THIRD
  // (reserved-primary) pass — every downstream decision (the outcome kind,
  // the StudioStatus borrow fields, the notify wording) reads off this ONE
  // flag, so they can never disagree about which pass actually landed the
  // switch.
  const isBorrow = candidate === null && outOfScopeSpare === null && borrowed !== null;

  if (!next) {
    const tried = deps.accounts.map((a) => a.name).slice(start);
    const parkedOn = candidate ? (from ?? tried.at(-1) ?? "CLAUDE_CODE_OAUTH_TOKEN") : null;
    // Issue #102 requirement 3: every account genuinely exhausted (parkedOn
    // null means nextClaudeAccount found nowhere to go at all) — the
    // earliest fleet-wide reset among them, so `fleet ls`/the degraded
    // message can say when a retry might work instead of just "no switch".
    const earliestReset = parkedOn === null ? earliestAccountReset(scopedAccounts, limits, deps.now()) : null;
    const message = parkedOn !== null
      ? parkedMessage(studioId, show(parkedOn))
      : exhaustedMessage(studioId, tried.map(show), earliestReset);
    // Issue #109: the auto-continue step is gated on the SAME `parkedOn ===
    // null` split #271's own comment above states — genuinely exhausted,
    // never the operator's own deliberate "parked" choice — and on this
    // tick's own already-captured `verdict` being a genuine select-style
    // modal. An inline-exhausted row self-clears through the EXISTING #214
    // `working`-branch recovery once its own printed reset passes the clock,
    // so it needs no Esc at all (see autoContinueAttempt's own doc comment).
    const autoContinueEligible = parkedOn === null && !verdict.inline;
    // The anti-loop guard. This studio has already been degraded for exactly
    // this reason, so there is nothing new to record and nobody new to tell
    // — UNLESS an auto-continue attempt is eligible and due, the one
    // deliberate, bounded exception this file's own doc comment now states.
    if (existing.state === "degraded" && existing.error === message) {
      if (autoContinueEligible) {
        const attempt = await autoContinueAttempt(deps, studioId, existing, tried, sighting);
        const row = attempt.patch ? { ...existing, ...attempt.patch } : existing;
        if (attempt.patch || limitChanged) {
          await storage.put(STATUS_KEY, row);
          await recordStudioFn(row);
        }
        return attempt.outcome;
      }
      if (limitChanged) {
        await storage.put(STATUS_KEY, existing);
        await recordStudioFn(existing);
      }
      return { kind: "already-degraded", tried };
    }
    const degraded: StudioStatus = {
      ...existing, state: "degraded", error: message, claudeAccount: existing.claudeAccount ?? null,
      // Issue #109: only on the SAME eligible path the attempt step itself
      // evaluates (genuinely exhausted, select-style modal) — an
      // inline-exhausted row gets no bookkeeping at all, since it is never
      // acted on and self-clears through the EXISTING #214 recovery.
      // `autoContinueLastTriedAt` is spread from `existing` rather than
      // reset — a message-text refresh (a fresher `earliestReset`) must not
      // silently re-arm the hourly cap (see StudioStatus.autoContinueAt's
      // own doc comment, "message-text refresh" residual).
      ...(autoContinueEligible ? { autoContinueAt: earliestReset, autoContinueLastTriedAt: existing.autoContinueLastTriedAt ?? null } : {}),
    };
    await storage.put(STATUS_KEY, degraded);
    await recordStudioFn(degraded);
    await deps.notify(message);
    // Issue #109: run on THIS tick too (not only later `already-degraded`
    // ones) — the due-ness check itself decides whether anything fires; the
    // OUTCOME this call reports stays `"exhausted"`/`"parked"` either way, the
    // same auditable signal (plus the notify above) this tick has always
    // given. Only the anti-loop-guard tick's own outcome is replaced, since
    // that one was previously silent.
    if (autoContinueEligible) {
      const attempt = await autoContinueAttempt(deps, studioId, degraded, tried, sighting);
      if (attempt.patch) {
        const row = { ...degraded, ...attempt.patch };
        await storage.put(STATUS_KEY, row);
        await recordStudioFn(row);
      }
    }
    return parkedOn !== null ? { kind: "parked", account: parkedOn } : { kind: "exhausted", tried };
  }

  // The switch itself. The token rides the exec's env (#110 review), never
  // the command, and `switchRes` is still NOT recorded verbatim: only the
  // exit code and stderr (container output, scrubbed) are.
  const switchRes = await deps.exec(accountSwitchCmd(), tokenEnv(next.token));
  const relaunchRes = switchRes.code === 0
    ? await deps.relaunch()
    : { code: switchRes.code, stdout: "", stderr: switchRes.stderr };
  // Issue #123: same rule across the switch execs. A destroy that landed
  // meanwhile refused them; recording that as a failed switch would put
  // `degraded` back over `stopped` and re-arm the ticks.
  if (await destroyLanded()) return { kind: "skipped", reason: "studio stopped during the account switch" };
  const failed = switchRes.code !== 0 || relaunchRes.code !== 0;
  const error = failed
    ? redactSecrets(
        `claude account switch to ${next.name} did not complete (exit ${relaunchRes.code}): ` +
        `${relaunchRes.stderr.slice(0, 500)}`,
      )
    : null;
  const switched: StudioStatus = {
    ...existing,
    // A completed switch HEALS the studio, including one degraded by an
    // earlier exhaustion that an operator has since given another account to.
    state: failed ? "degraded" : "running",
    error,
    claudeAccount: next.name,
    // #289: a completed switch is a launch on the new account.
    ...(failed ? {} : { launchedAccount: next.name }),
    // Issue #102: WHEN this switch landed, and HOW it matched — the
    // no-flapping guard above reads both, unconditionally on `failed` for the
    // same reason `claudeAccount: next.name` already is (the account changed
    // either way; only the relaunch's own success is conditional).
    claudeAccountMovedAt: deps.now().toISOString(),
    claudeAccountMovedVia: verdict.inline ? "inline" : "modal",
    failoverBlock: key,
    // Review round 1 (#102 review, 2026-09-30), finding 2 — the no-flapping
    // guard's own comparison key (types.ts's own doc comment states the full
    // rule): `key` itself for an inline-via switch (the same value
    // `failoverBlock` just got), or the block this studio already knew about
    // from an earlier tick (`sighting`, read at the TOP of this call, before
    // this tick's own observation) for a select-modal-via switch — `null`
    // when it knew of none.
    claudeAccountMovedBlock: key ?? sighting?.block ?? null,
    // A completed switch is a new account: the old one's limit is not its.
    rateLimited: failed ? existing.rateLimited : null,
    // Review round 2 (maestro review of PR #135), finding 4 (write-condition
    // half) — generalized from `isBorrow` (true only for the third,
    // reserved-primary pass): ANY switch that lands the studio somewhere
    // other than its own configured primary now keeps `borrowedAccount` set
    // (updating it when the studio moves from one non-own account to
    // another), so hand-back's own `rowNow.borrowedAccount` gate — the ONLY
    // thing that ever brings a studio back to its primary — never goes
    // stale partway through a chain of non-primary switches (tier 2's own
    // unclaimed spare included: without this, the first plain own-chain
    // switch after landing on a tier-2 spare would silently clear the flag,
    // and hand-back would never fire again). Cleared ONLY by a switch that
    // lands exactly on `deps.primary` — a genuine return, whether via this
    // ordinary path or via `handBack`'s own dedicated one.
    //
    // Review round 3 (2nd, independent review of PR #135, 2026-09-30) —
    // FIXED: gated on `deps.primaryIsMapped`, not `deps.primary != null`.
    // `primary` is never null in real deployment (see that field's own doc
    // comment above); the old guard therefore armed Stage B's whole
    // borrowedAccount/hand-back machinery for every PLAIN multi-account
    // fleet that never configured CLAUDE_ACCOUNT_BY_REPO at all, turning an
    // ordinary account-1 -> account-2 switch into a recorded "borrow" that
    // hand-back would later forcibly undo. `primaryIsMapped` is the one
    // thing that actually distinguishes "this repo opted into #271" from
    // "primaryAccount() merely fell back to the first configured account" —
    // see do.ts's `failoverDeps()` for how it is computed.
    // `borrowedFromRepo` stays keyed on `isBorrow` specifically: an
    // unclaimed spare (tier 2) or a plain own-chain landing was never
    // "borrowed FROM" any repo, so it carries no such repo to name.
    ...(deps.primaryIsMapped && next.name !== deps.primary
      ? { borrowedAccount: next.name, borrowedFromRepo: isBorrow ? (deps.otherRepoOf?.(next.name) ?? null) : null }
      : { borrowedAccount: null, borrowedFromRepo: null }),
  };
  await storage.put(STATUS_KEY, switched);
  // Issue #354: the in-memory start config follows the ROW before any other
  // await — recordStudioFn below is a D1 write, and a container start the DO
  // runs in that window must already boot, and record, the new account.
  if (!failed) await deps.onSwitched?.(next.name);
  await recordStudioFn(switched);
  if (!failed && observedStorage) {
    // Review round 5, Finding 3: the same "container-exec-then-DO-patch"
    // two-step provisionWithStorage/restartWithStorage/recycleWithSync all
    // wrap in OPERATION_KEY specifically to stop a concurrent ship tick from
    // racing the two writes — a ship tick that reads the fresh incarnation
    // token this exec just wrote before this function's OWN mergeObserved
    // below has landed would wrongly read the container as "replaced".
    // Review round 6, MUST-FIX 10(a) — corrected: failover runs from inside
    // the SYNC tick (do.ts's `syncSessionCycle`, on SYNC_SESSION_SECONDS'
    // cadence), never the ship tick (`runShipTickWithObservation`, on
    // SHIP_TRANSCRIPT_SECONDS' own separate, shorter cadence) — the two are
    // distinct scheduled alarm callbacks. A Durable Object's input gate is
    // open across every one of the exec awaits above, so a genuine provision/
    // restart/recycle — OR a concurrently-scheduled ship tick's own exec —
    // can already hold this same lock when this code runs.
    // Check-before-set/check-before-clear, same guard provisionWithStorage/
    // restartWithStorage now use (issue #85 review round 5, Finding 1): if a
    // lock is already held, this narrow window neither overwrites it nor
    // clears it — only the OUTERMOST setter (whoever found it unheld) touches
    // it either way.
    //
    // Review round 6, Blocker 2 — "already held" now means genuinely FRESH,
    // not merely non-null: see operationLockFresh's own doc comment
    // (provision.ts). A STALE value here used to make `alreadyLocked` read
    // true forever, so this function never refreshed it and never cleared it
    // — permanently defeating the exact guard this block exists to provide.
    const alreadyLocked = operationLockFresh(await storage.get(OPERATION_KEY), deps.now());
    if (!alreadyLocked) await storage.put(OPERATION_KEY, { op: "failover", since: deps.now().toISOString() });
    try {
      const token = crypto.randomUUID();
      let tokenWritten = false;
      let answered = false;
      let probe: PaneProbeResult;
      try {
        const res = await deps.exec(bringupObservationCmd(token));
        answered = true;
        const parsed = parseBringupObservation(res.stdout);
        tokenWritten = res.code === 0 && parsed.tokenWritten;
        probe = parsed.probe;
        if (res.code !== 0) {
          console.error(`studio ${studioId}: bring-up observation exec failed after failover (${res.code})`);
        }
      } catch (err) {
        probe = { ok: false, found: false, hasContinue: false, cwd: null, leadAgeS: null, error: err instanceof Error ? err.message : String(err) };
        console.error(`studio ${studioId}: bring-up observation exec failed after failover`, err);
      }
      const repo = parseStudioId(existing.id)?.repo ?? null;
      const expectedCwd = repo === null ? "" : `/workspace/${repo}`;
      const turnsBefore = existing.burn?.turns ?? 0;
      const nowIso = deps.now().toISOString();
      // Maestro correction #8: a failover never restores (restore is always
      // "not-attempted" here), so snapshotAgeS stays null — no R2 fallback
      // needed on this path.
      const session = computeSessionVerdict(probe, expectedCwd, "not-attempted", turnsBefore, null, nowIso, "failover");
      // Maestro correction #13 — a successful failover proves the exec plane
      // is alive; reset reachability the same way a successful ship tick
      // does. An ANSWERED observation exec (`answered`, set the moment the
      // exec above resolves — even if what it observed, like the session
      // verdict, ends up unrelated or a non-zero exit) is itself proof-of-
      // life for the exec plane, so it also re-anchors `lastShipOkAt` to
      // `nowIso` — not just a routine successful ship tick. A THROWN exec
      // never sets `answered`, so a dead exec plane never resets this clock.
      const patch: Partial<Observed> = {
        session, execFailures: 0, unreachableSince: null,
        ...(answered ? { lastShipOkAt: nowIso } : {}),
      };
      if (tokenWritten) { patch.incarnation = token; patch.replacedAt = null; }
      await mergeObserved(observedStorage, patch);
    } finally {
      if (!alreadyLocked) await storage.put(OPERATION_KEY, null);
    }
  }
  // Issue #131 (Stage B) — "log it loudly": a borrow names both repos, never
  // just the plain switchedMessage every other landing gets.
  const borrowedFromRepo = isBorrow ? (deps.otherRepoOf?.(next.name) ?? null) : null;
  const message = isBorrow
    ? borrowedMessage(
        studioId, from === null ? null : show(from), show(next.name),
        parseStudioId(existing.id)?.repo ?? null, borrowedFromRepo, verdict.headline ?? verdict.marker,
      )
    : switchedMessage(studioId, from === null ? null : show(from), show(next.name), verdict.headline ?? verdict.marker);
  await deps.notify(failed ? `${message} RELAUNCH FAILED: ${error}` : message);
  return isBorrow
    ? { kind: "borrowed", from, to: next.name, fromRepo: borrowedFromRepo }
    : { kind: "switched", from, to: next.name };
}
