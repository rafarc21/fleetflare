/**
 * Issue #221 — PR3a: whether a lead is working, idle, waiting on members, or
 * parked on a limit. See docs/superpowers/specs/2026-09-24-row-tells-truth-
 * design.md, "PR3 — activity states", for the full design this file builds.
 *
 * Task 1: `readActivityFrame`, a PURE reader of one pane capture — no
 * `limit` kind here, `nextActivity` (Task 2) layers that on from
 * `row.rateLimited`, the SAME detector #99/#144 already run. No re-parse.
 *
 * Reuses failover.ts's own bottom-anchoring rules rather than forking them:
 * `footerAtBottom`/`aboveAgentPanel` (#186's own footer-at-bottom rule) and
 * the chrome patterns (`TURN_ENDED_LINE`, `RULE_LINE`, `PROMPT_LINE`,
 * `AGENT_PANEL_LINE`) that already decide what an idle input box looks like.
 */
import {
  footerAtBottom, aboveAgentPanel, TURN_ENDED_LINE, RULE_LINE, PROMPT_LINE, AGENT_PANEL_LINE,
  MODAL_FOOTER_LINE, MODAL_BLOCK_START, MEMBERS_TICKING_KEY, QUEUED_TEXT_ROWS,
  // Issue #311 — cleared alongside ACTIVITY_KEY/MEMBERS_TICKING_KEY by
  // clearActivityState, below. Defined in failover.ts, not member-alerts.ts
  // — see that constant's own doc comment for why.
  MEMBER_ALERTS_KEY, MEMBER_ROWS_KEY,
} from "./failover";
import type { RateLimitObservation } from "./rate-limit";

export type FrameVerdict =
  | { kind: "working" | "waiting-members" | "idle" | "waiting-question" }
  | { kind: "unknown"; reason: string };

/** The LAST `✻ ` line in the head is claude's status line — bottom-anchored,
 *  the same discipline `footerAtBottom`/`lastLineMatching` already use (see
 *  this file's own header: a lead that quotes a stale spinner line into its
 *  own transcript must not shadow a REAL, later turn-ended row).
 *
 * Issue #221 fix round 2, Fix 1 — claude's live spinner glyph is NOT always
 * `✻` (measured: `· Improvising… (1s · ↓ 3 tokens)`, `✶ Cogitating…`), so a
 * candidate status line is now EITHER a literal `✻ ` line (still required for
 * TURN_ENDED_LINE/WAITING_MEMBERS_LINE, which claude always draws with `✻`),
 * OR any line carrying the one shape a live spinner never varies on: a timer
 * parenthetical, `(<n><unit> · `. A turn-ended row never has one (it reads
 * "for <dur>", no parens); ordinary transcript prose measured against the
 * full negative corpus (test/fixtures/rate-limit-panes.ts) never does either. */
const STATUS_LINE = /^\s*✻ /;
// Anchored to the START of the line (a leading glyph token, then the timer
// parenthetical somewhere after it with no OTHER "(" in between) — a status
// line is always the WHOLE line, never a parenthetical aside buried inside
// an ordinary transcript sentence ("⏺ Done (90 tool uses · 281.2k tokens ·
// 18m 53s)" must not qualify merely for containing a "·" after a duration).
const SPINNER_TIMER_LINE = /^\s*\S+ [^(]*\(\d+[dhms](?: \d+[dhms])* ?·/;

function isCandidateStatusLine(line: string): boolean {
  return STATUS_LINE.test(line) || SPINNER_TIMER_LINE.test(line);
}

/** Claude repaints this into its status line every second for as long as a
 *  turn runs, reasoning included (failover.ts's own PANE_QUIESCE_SECONDS doc
 *  comment) — the one phrase that means a turn is genuinely in flight.
 *
 * Issue #221 fix round 2, Fix 1 — measured: `esc to interrupt` actually
 * paints into the FOOTER (`⏵⏵ bypass permissions on · esc to interrupt · ←
 * for agents`), not only the status line above it, which is the ONE thing
 * the original detector never checked at all. Reused against both. */
const WORKING_PHRASE = /esc to interrupt/;

/** `✻ Waiting for <n> background agent(s) to finish` — the lead itself is
 *  stopped, waiting on a member turn; not a turn in flight (failover.ts's own
 *  TURN_ENDED_LINE doc comment: "Not '✻ Waiting for …' … those are turns
 *  still open" — open in the OTHER direction, waiting on someone else). */
const WAITING_MEMBERS_LINE = /^\s*✻ Waiting for \d+ background agents? to finish\s*$/;

/** Issue #86 — background work the lead left running: a footer segment
 *  counting shells/monitors/background tasks (`· 7 shells ·`, `· 2 monitors ·`)
 *  or a turn-ended row saying so (`✻ Cooked for 36m 35s · 7 shells still
 *  running`). The lead waits on it: the same "waiting on someone else" the
 *  waiting-members state already means, so an idle alarm never fires on it.
 *  Matches reap's live-read counter rule (cli/reap.ts chromeRefusal). */
const BACKGROUND_COUNTER = /^\d+ (?:shells?|monitors?|background (?:tasks?|jobs?)|tasks?)$/i;
const STILL_RUNNING = / · .*\bstill running\s*$/;

function hasBackgroundWork(footer: string, statusLine: string | null): boolean {
  if (footer.split("·").some((seg) => BACKGROUND_COUNTER.test(seg.trim()))) return true;
  return statusLine !== null && STILL_RUNNING.test(statusLine);
}

function lastStatusLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isCandidateStatusLine(lines[i])) return i;
  }
  return -1;
}

/**
 * Issue #221 fix round 2, Fix 6 — a select-style menu: claude's own `Enter to
 * confirm · Esc to cancel` footer under a `▔`-ruled block (failover.ts's own
 * MODAL_FOOTER_LINE/MODAL_BLOCK_START, reused rather than forked — the SAME
 * shape the rate-limit modal draws). Deliberately headline-agnostic: a
 * permission prompt (`Do you want to proceed?`) draws exactly this shape, and
 * this fleet measured a live studio parked on one misread as IDLE. `LIMIT`
 * already outranks this by construction (`nextActivity`'s own precedence
 * table), so a limit modal also matching here is harmless — it never reaches
 * this file's own verdict for a real limit sighting. */
function hasQuestionMenu(lines: string[]): boolean {
  const lastIdx = lines.length - 1;
  if (lastIdx < 0 || !MODAL_FOOTER_LINE.test(lines[lastIdx])) return false;
  return lines.slice(0, lastIdx).some((l) => MODAL_BLOCK_START.test(l));
}

/** True when `lines` contains a RULE_LINE immediately followed by a
 *  PROMPT_LINE somewhere in it — claude's idle input box, the same shape
 *  `endsInIdleInputBox` (failover.ts) requires between a limit block and the
 *  footer. */
function hasIdleInputBox(lines: string[]): boolean {
  for (let i = 0; i < lines.length - 1; i++) {
    if (RULE_LINE.test(lines[i]) && PROMPT_LINE.test(lines[i + 1])) return true;
  }
  return false;
}

/**
 * One pane capture -> a verdict about the LEAD, never the agent panel below
 * its footer (`aboveAgentPanel` already strips that — Principle: "must never
 * read the agent panel as the lead").
 *
 * First match wins, top to bottom of the state table (this spec's own
 * ordering): the status line decides `working`/`waiting-members`; otherwise
 * an idle input box (with an optional turn-ended row above it) decides
 * `idle`; anything else recognisable-but-unmatched is `unknown` with a
 * reason — never a guess (Principle: "must never guess between thinking and
 * stopped").
 */
export function readActivityFrame(frame: string): FrameVerdict {
  const trimmed = frame.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  const footerIdx = footerAtBottom(lines);
  if (footerIdx < 0) {
    // Issue #221 fix round 2, Fix 6 — a select-style menu (a permission
    // prompt included) REPLACES the normal chrome footer entirely while it
    // is open, the same shape every real limit-modal fixture in this repo
    // draws (V1_FULL_PANE, V1_THREE_OPTION_PANE: the modal's own `Enter to
    // confirm · Esc to cancel` line IS the last thing on screen). Checked
    // here, before falling back to "claude not on screen", so a genuine
    // question does not get misread as claude being gone altogether.
    if (hasQuestionMenu(lines)) return { kind: "waiting-question" };
    return { kind: "unknown", reason: "claude not on screen" };
  }
  // Issue #221 fix round 2, Fix 1 — measured: `esc to interrupt` paints into
  // the FOOTER itself while a turn runs (`⏵⏵ bypass permissions on · esc to
  // interrupt · ← for agents`), a shape the original detector never checked
  // — it only ever looked at the status line above the footer.
  if (WORKING_PHRASE.test(lines[footerIdx])) {
    return { kind: "working" };
  }
  const head = aboveAgentPanel(trimmed).split("\n");
  // A select-style menu can also sit ABOVE the ordinary chrome footer (the
  // footer chrome persisting underneath while the question is open) —
  // checked against `head` for exactly that shape.
  if (hasQuestionMenu(head)) return { kind: "waiting-question" };
  const statusIdx = lastStatusLineIndex(head);
  if (statusIdx >= 0) {
    const line = head[statusIdx];
    // Wrap join (measured, skills/fleet-cockpit/SKILL.md:263): a corrupted
    // render can split a status/timer/footer phrase across two rows.
    // Issue #221 fix round 3 — generalised beyond "esc to interrupt" (round
    // 2's own join only ever re-tested THAT one phrase against the joined
    // string): the SAME corruption can just as easily split the spinner's
    // own timer parenthetical, or the waiting-members phrase, so every
    // pattern checked in this block is now tried against both `line` and
    // `wrapped`, not only WORKING_PHRASE.
    const wrapped = statusIdx + 1 < head.length ? line + head[statusIdx + 1] : line;
    if (WORKING_PHRASE.test(line) || WORKING_PHRASE.test(wrapped)
      || SPINNER_TIMER_LINE.test(line) || SPINNER_TIMER_LINE.test(wrapped)) {
      return { kind: "working" };
    }
    if (WAITING_MEMBERS_LINE.test(line) || WAITING_MEMBERS_LINE.test(wrapped)) {
      return { kind: "waiting-members" };
    }
  }
  const afterStatus = head.slice(statusIdx + 1);
  const turnEndedOrAbsent = statusIdx < 0 || TURN_ENDED_LINE.test(head[statusIdx]);
  if (turnEndedOrAbsent && hasIdleInputBox(afterStatus)) {
    if (hasBackgroundWork(lines[footerIdx], statusIdx >= 0 ? head[statusIdx] : null)) {
      return { kind: "waiting-members" };
    }
    return { kind: "idle" };
  }
  return { kind: "unknown", reason: "unrecognised frame" };
}

/** Board issue #108 (#70 ask 4 remainder) — a rendered `lastLine` this long
 *  would dwarf everything else in a `fleet ls --json` row; truncated with a
 *  trailing `…` past this many characters. Applied by `truncateLine`, below,
 *  and ONLY ever at the do.ts write boundary, AFTER `redactSecrets` has
 *  already run on the full, untruncated line (see `truncateLine`'s own doc
 *  comment for why the order matters). */
export const LAST_LINE_MAX_CHARS = 200;

/**
 * Board issue #108 (#70 ask 4 remainder) — the lead's last VISIBLE message
 * line, so a coordinator reading `fleet ls --json` can tell roughly WHAT the
 * lead is doing/saying without attaching to the pane. PURE, no redaction and
 * no truncation here — both belong at the write boundary, do.ts's ship tick,
 * in that order: `redactSecrets` first, `truncateLine` second (grid.ts's
 * scrubPreview already establishes this exact order and reasoning: redacting
 * the full value before slicing is what keeps a secret straddling the slice
 * boundary from surviving the cut half-caught — see that function's own doc
 * comment).
 *
 * Reuses EVERY chrome pattern this file already imports/defines to decide
 * "is this the lead's own status chrome" rather than a second, drifting
 * definition of the same question: `footerAtBottom` anchors the search to
 * content ABOVE the bottom footer — the same span `readActivityFrame` calls
 * `head`, MINUS the footer line itself (which `head`, via `aboveAgentPanel`,
 * still includes but this function deliberately never returns as "the
 * lead's message") — then walks backward skipping blank lines, a candidate
 * status line, a turn-ended row, the idle input box, the waiting-members
 * line, and a select-style modal's own footer/block-start — every one of
 * these is chrome `readActivityFrame` itself already treats as "not the
 * lead's own message". The first surviving line is the answer.
 *
 * Issue #108 fix-first (PR #118, maestro review) — the idle input box is
 * treated as ONE chrome block (its opening rule through its closing rule,
 * inclusive), not three independently-matched line patterns: the box's own
 * 1-3 wrapped continuation rows (`endsInIdleInputBox`'s `QUEUED_TEXT_ROWS`,
 * failover.ts) match neither RULE_LINE nor PROMPT_LINE, so scanning line by
 * line alone could surface queued/pasted operator text — a secret-shaped
 * token split across two rows included, defeating redact.ts's per-line
 * pattern on each half — as "the lead's last message". The LAST such box
 * (closest to the footer, the live one) is found first and skipped whole; if
 * its closing rule cannot be found within QUEUED_TEXT_ROWS, the capture is
 * treated as malformed and this falls back to the old per-line scan.
 */
export function extractLastVisibleLine(frame: string): string | null {
  const trimmed = frame.replace(/\s+$/, "");
  if (trimmed === "") return null;
  const lines = trimmed.split("\n");
  const footerIdx = footerAtBottom(lines);
  const content = footerIdx >= 0 ? lines.slice(0, footerIdx) : lines;

  // Find the idle input box closest to the footer and, if well-formed, skip
  // it as one block by starting the per-line scan above its opening rule.
  let scanEnd = content.length - 1;
  for (let j = content.length - 2; j >= 0; j--) {
    if (!RULE_LINE.test(content[j]) || !PROMPT_LINE.test(content[j + 1] ?? "")) continue;
    for (let k = j + 2; k < content.length && k <= j + 2 + QUEUED_TEXT_ROWS; k++) {
      if (RULE_LINE.test(content[k])) { scanEnd = j - 1; break; }
    }
    break;
  }

  for (let i = scanEnd; i >= 0; i--) {
    const line = content[i];
    if (line.trim() === "") continue;
    if (isCandidateStatusLine(line)) continue;
    if (RULE_LINE.test(line)) continue;
    if (PROMPT_LINE.test(line)) continue;
    if (TURN_ENDED_LINE.test(line)) continue;
    if (WAITING_MEMBERS_LINE.test(line)) continue;
    if (MODAL_FOOTER_LINE.test(line)) continue;
    if (MODAL_BLOCK_START.test(line)) continue;
    return line.trim();
  }
  return null;
}

/**
 * Board issue #108, Finding 1 (post-ship code review) — the truncation half
 * of `extractLastVisibleLine`'s old, wrong-order contract, moved to run
 * AFTER `redactSecrets` at the do.ts call site rather than before it inside
 * this file's own pure extractor. Slicing before redacting is only
 * accidentally safe today because every `redact.ts` pattern is an
 * open-ended quantifier (`ghs_[A-Za-z0-9]+`, `sk-ant-[A-Za-z0-9_-]+`, etc) —
 * a truncated match still gets caught in practice — but a future
 * FIXED-length secret shape would silently leak a partial token through
 * this exact field under that order. Mirrors grid.ts's scrubPreview:
 * redact the full value first, slice second.
 *
 * `.slice` here is UTF-16-code-unit-based, not surrogate-pair-aware — a
 * truncation boundary could in principle land inside an astral-plane emoji
 * and split it. Left as-is: every glyph claude's own chrome/prose actually
 * draws is BMP, so this is a cosmetic, unmeasured edge case, not worth the
 * extra complexity `transcript.ts`'s `trimPartialLeadingUtf8` pays for a
 * genuinely-measured one.
 */
export function truncateLine(s: string): string {
  return s.length > LAST_LINE_MAX_CHARS ? `${s.slice(0, LAST_LINE_MAX_CHARS)}…` : s;
}

/**
 * Task 4's panel-diff leg (WAITING MEMBERS via the existing 300s two-capture
 * probe): the agent-panel rows below the footer, joined, or null when there
 * is no footer to anchor against. Two captures with different non-null
 * results mean the panel moved — a member turn is genuinely running, the
 * shape `aboveAgentPanel` deliberately excludes from "the lead".
 *
 * Imports `AGENT_PANEL_LINE` for exactly this (see this file's own header) —
 * kept here, pure and directly testable, rather than in failover.ts, which
 * keeps its own private copy to avoid importing back from this file (this
 * file already imports FROM failover.ts).
 */
export function agentPanelRows(capture: string): string | null {
  const lines = capture.replace(/\s+$/, "").split("\n");
  const footer = footerAtBottom(lines);
  if (footer < 0) return null;
  return lines.slice(footer + 1).filter((l) => AGENT_PANEL_LINE.test(l)).join("\n");
}

/**
 * Task 2 — the state machine. Exactly the `Activity` shape the design's own
 * "Storage and the JSON field" section types (this spec, verbatim): own DO
 * key, D1-mirrored as `observed.activity`, `source` always `"pane"` in PR3a
 * (PR3b's hooks are out of scope for this PR).
 */
export type Activity = {
  // Issue #221 fix round 2, Fix 6: "waiting-question" added — a select-style
  // menu (a permission prompt included) is its own state, never a flavour of
  // idle, the same "own state, not a flavour of working" reasoning the
  // design already applies to waiting-members (activity.ts's own header).
  state: "working" | "idle" | "waiting-members" | "waiting-question" | "limit" | "unknown";
  /** First observation of THIS state, ISO. Does not move while the state holds. */
  since: string;
  /** False until a state CHANGE has been observed — before that, `since` is
   *  only a lower bound (renders with `≥`, cli/readiness-format.ts). */
  anchored: boolean;
  /** The capture this verdict came from, ISO. */
  observedAt: string;
  source: "pane" | "hook";
  /** Always set when `state` is `"unknown"`; null otherwise. */
  reason: string | null;
  /** Last 300s probe that saw the agent panel move, ISO, or null. */
  membersTickingAt: string | null;
};

/** How long a `membersTickingAt` observation still forces `waiting-members`
 *  over a fresher frame verdict — twice the 300s panel-diff probe's own
 *  cadence, so one missed probe does not drop the state early. */
const MEMBERS_TICKING_WINDOW_MS = 2 * 5 * 60 * 1000;

function membersTickingFresh(membersTickingAt: string | null, now: Date): boolean {
  if (membersTickingAt === null) return false;
  const at = Date.parse(membersTickingAt);
  return Number.isFinite(at) && now.getTime() - at <= MEMBERS_TICKING_WINDOW_MS;
}

/**
 * Issue #221 fix round 2, Fix 3 — a limit observation only outranks the
 * frame while it is actually still live: a `select` modal has no clock (a
 * human must press Esc, whatever the clock says) and an unreadable reset
 * (`until: null`) cannot be judged expired either, so both stay live
 * unconditionally (unchanged from before this fix — `formatReady`/
 * `formatActivity` already treat them the same way). A REAL, parsed
 * `until` in the past is the one case this fixes: without this check,
 * `nextActivity` kept forcing `"limit"` forever once `row.rateLimited` was
 * first set, even long after its own printed reset had come and gone,
 * degrading `fleet ls` to a bare `?` permanently (readiness-format.ts's own
 * `activity.state === "limit"` render never had a real verdict to fall back
 * to, because the DO-stored state was never anything else).
 */
function limitStillLive(limit: RateLimitObservation | null, now: Date): boolean {
  if (limit === null) return false;
  if (limit.select || limit.until === null) return true;
  const untilMs = Date.parse(limit.until);
  return Number.isFinite(untilMs) && untilMs > now.getTime();
}

/** The 3 states a hook can actually assert — kept as a runtime set (not just
 *  `HookHeartbeat`'s own type) as defense in depth in `nextActivity` below:
 *  `parseHookHeartbeat` already whitelists this, but a caller could in
 *  principle hand-build a `HookHeartbeat`-shaped object (a test, or a future
 *  caller that skips the parser) claiming `"limit"`/`"waiting-members"` —
 *  this is the SECOND, independent place that can never be reached by
 *  either. */
const HOOK_AXIS_STATES = new Set<HookHeartbeat["state"]>(["working", "idle", "waiting-question"]);

/** Issue #221 fix round 2 (maestro review, PR #352, HIGH finding) — the
 *  staleness budget for CONSUMING a hook heartbeat, independent of the
 *  "newer than the last look" check `hookWinsAxis` does below. Without this,
 *  a lead killed mid-turn (crash, OOM) leaves a single stale hook stamp that
 *  the "newer than last look" check alone cannot age out IF ship ticks
 *  themselves stop running for a while — a stopped studio, or a fresh
 *  operation lock (`applyActivityVerdict`'s own `!live || activityOpFresh`
 *  carve-out, do.ts) skips writing `ACTIVITY_KEY` entirely, so
 *  `prevActivity.observedAt` freezes right along with the gap. A hook
 *  stamped just after the gap began could still read as "newer than last
 *  look" once ticks resume, despite being minutes old in real wall-clock
 *  terms by then. Mirrors `ACTIVITY_DO_STALE_SECONDS` (cli/readiness-
 *  format.ts, 90s = 3 × the 30s ship-tick cadence, that constant's own doc
 *  comment) as a plain number rather than an import — studio/ is a layer
 *  BELOW cli/ (cli imports `Activity` from here, never the reverse), and 90s
 *  is already the established "how stale is too stale" budget for this
 *  EXACT stored value elsewhere in the codebase, so reusing the NUMBER (not
 *  a cross-layer import) keeps the two budgets honestly in sync without
 *  inverting that dependency direction.
 *
 *  Known residual, accepted and named (maestro review, PR #352 round 3): a
 *  lead killed mid-turn can still render `WORKING` for up to one ship tick
 *  (≤30s) after death — the hook's last `working` stamp is still within this
 *  budget and `hookWinsAxis` has no way to know the process behind it is
 *  gone until the NEXT pane capture (or this budget's own expiry) corrects
 *  it. Bounded, self-healing within one tick, and strictly better than PR3a
 *  alone (up to 30s late either way, never permanently stuck). */
const HOOK_STALE_BUDGET_MS = 90_000;

/**
 * Issue #221 (PR3b) — "freshest wins, ties to the pane" (spec, verbatim):
 * "Hooks never override the pane. LIMIT and WAITING MEMBERS come only from
 * the pane. On the WORKING/IDLE axis the FRESHER observation wins, ties to
 * the pane."
 *
 * Issue #221 fix round 2 (maestro review, PR #352, HIGH finding) — this
 * doc comment used to claim the hook was compared "against `now`, captured
 * once at the START of a ship tick, before its chained exec runs." That
 * claim was FALSE: `now` here was always `deps.now()` read fresh inside
 * `applyActivityVerdict` (do.ts), called from `runShipTickWithObservation`'s
 * SUCCESS path — i.e. AFTER `shipTranscriptTick`'s chained exec had already
 * returned with the hook heartbeat already in hand. That `now` is therefore
 * always chronologically LATER than any real hook stamp could ever be
 * (combined with the hook's own whole-second-truncated `at`,
 * gates/activity-heartbeat.sh's `write_state`), making `hook.at > now`
 * unreachable outside a test handing it an artificially future timestamp.
 * The hook leg of this feature was a silent no-op in production.
 *
 * "Freshest" cannot honestly mean "newer than the instant we're checking
 * at" — anything already written IS in the past relative to whenever it is
 * read, hook included; a real hook timestamp is NEVER later than the
 * moment something goes looking for it. The only instant that means
 * anything here is "the last time we ourselves looked" — `prevObservedAt`,
 * the PREVIOUS tick's own `Activity.observedAt`, a value safely anchored in
 * the past by construction (it was written on an earlier tick, and
 * `nextActivity` below always stamps a fresh `observedAt` every call,
 * hook-sourced or pane-sourced alike). `hook.at > prevObservedAt` correctly
 * answers "does the hook know about something that happened SINCE we last
 * looked" — genuinely new information a 30s-granularity pane read cannot
 * have on its own — without "now always exceeds a past stamp"
 * contaminating the comparison. `prevObservedAt === null` (no prior tick at
 * all — a freshly-provisioned studio's first observation) treats any
 * within-budget hook as new: there is no earlier look for it to be newer
 * than. A tie (`hook.at === prevObservedAt`) still goes to the pane, per
 * spec, unchanged — and is why this is `<=`, not `<`.
 *
 * This is also naturally self-limiting without any extra bookkeeping: once
 * a hook wins a tick, THAT tick's own `observedAt` becomes the new
 * `prevObservedAt` for the next one — and a real hook stamp is always
 * chronologically before the tick that reads it, so the SAME `hook.at`
 * value can never win two ticks in a row on its own. Only a genuinely
 * newer hook event (or a gap in ticking, handled by the staleness budget
 * above) lets the hook win again.
 *
 * Evaluated and DECLINED: a separate "hook and pane agree, sharpen `since`
 * anyway" path (the review's other suggested direction, for the case where
 * `hookWinsAxis` itself does not fire but the pane's OWN verdict this tick
 * happens to already match the hook's claimed state). Once the comparison
 * basis above is fixed, any hook stamp that is genuinely newer than the
 * last look wins arbitration on its own merits via the branch below —
 * agreement with the pane or not — and produces the sharpened `since`
 * there. A hook stamp that is NOT newer than the last look offers no
 * information the pane did not already independently establish by now
 * (whichever tick `prevObservedAt` itself came from already reflects
 * everything as of that instant), so there is nothing left for a second
 * path to usefully sharpen — and admitting one risks resurrecting an old,
 * unrelated hook stamp as a fabricated `since` for a transition it may not
 * have caused. The single comparison below is enough.
 */
function hookWinsAxis(
  hook: HookHeartbeat | null | undefined,
  prevObservedAt: string | null,
  now: Date,
): hook is HookHeartbeat {
  if (hook == null || !HOOK_AXIS_STATES.has(hook.state)) return false;
  const at = Date.parse(hook.at);
  if (!Number.isFinite(at)) return false;
  if (now.getTime() - at > HOOK_STALE_BUDGET_MS) return false;
  if (prevObservedAt !== null) {
    const prevAt = Date.parse(prevObservedAt);
    if (Number.isFinite(prevAt) && at <= prevAt) return false;
  }
  return true;
}

/**
 * Issue #221 fix round 3 (maestro review, PR #352, MED finding) — a `Stop`
 * hook event firing does not mean the lead is genuinely done: this
 * codebase's own `gates/completion-gate.sh` is ALSO registered on `Stop`
 * (installed alongside this heartbeat hook — container/studio-bringup.sh's
 * own settings.json merge block, both entries in the SAME `hooks.Stop`
 * array) and can exit 2, BLOCKING the stop outright — the lead is forced to
 * keep working, with no new hook event ever firing to correct the record
 * (there is no "stop was blocked, resume working" event in Claude Code's
 * hook vocabulary). `gates/activity-heartbeat.sh` has therefore already
 * written `idle`, stamped with a timestamp that IS genuinely newer than the
 * last look (satisfying `hookWinsAxis` above on its own, freshest-wins
 * terms), before the block even happens — a stale-but-technically-fresher
 * `idle` claim that must not be allowed to beat THIS tick's own pane
 * capture when that capture, taken AFTER the hook fired, plainly shows the
 * lead's spinner still running (`verdict.kind === "working"`).
 *
 * This is what makes the WORKING/IDLE axis asymmetric rather than a pure
 * freshest-wins comparison: a hook claiming `working` still overrides a
 * stale pane exactly as before (unchanged — the whole point of a
 * higher-precision second signal), because nothing routinely vetoes a
 * `UserPromptSubmit` the way `completion-gate.sh` routinely vetoes a `Stop`.
 * A hook claiming `idle` is, in contrast, strictly less trustworthy than a
 * pane verdict that says `working` THIS tick — so it may never override
 * one, regardless of the hook's own timestamp freshness.
 */
function hookIdleOverruledByWorkingPane(hook: HookHeartbeat, verdict: FrameVerdict): boolean {
  return hook.state === "idle" && verdict.kind === "working";
}

/**
 * `prev` -> the next `Activity`, given this tick's frame verdict, the row's
 * OWN rate-limit observation (never re-parsed here — Principle: "One source
 * of truth (row.rateLimited), two renderings"), the last panel-diff
 * timestamp, and (PR3b) the container's own hook heartbeat for this tick, if
 * any.
 *
 * Precedence, top to bottom, exactly the design's own state table order
 * (docs/superpowers/specs/2026-09-24-row-tells-truth-design.md, "PR3 —
 * activity states"), with the hook slotted in at the ONE point Principle 5
 * allows it a say:
 *   1. A still-live `limit` outranks everything, hook included — a hook has
 *      no event for it, so it is never even consulted.
 *   2. A `waiting-members` frame OR a still-fresh `membersTickingAt`, UNLESS
 *      the frame's OWN verdict is `working` — a live spinner on the lead's
 *      own status line is unambiguous evidence happening right now, and
 *      must never be masked by a merely-fresh (possibly minutes-stale)
 *      `membersTickingAt` carried from an earlier probe (issue #221 fix
 *      round 2, Fix 2). This step, like step 1, never consults the hook —
 *      no hook event exists for `waiting-members` either.
 *   3. (PR3b) The hook, on the WORKING/IDLE/waiting-question axis alone —
 *      `hookWinsAxis` above decides whether it tells us something we did
 *      not already know as of `prev.observedAt` (fix round 2: NOT whether
 *      it is newer than a freshly-read `now` — see that function's own doc
 *      comment for why that comparison was unreachable in production),
 *      ties going to the pane. Reachable even when the frame's own verdict
 *      is `working` (step 2's exclusion is narrower than a full
 *      short-circuit): a fresher hook can still override a pane that
 *      currently reads `working`, which is the whole point of a
 *      higher-precision second signal.
 *
 *      Issue #221 fix round 3 (maestro review, PR #352, MED finding) — this
 *      step is ASYMMETRIC, not pure freshest-wins, on the one direction
 *      `hookIdleOverruledByWorkingPane` below guards against: a hook
 *      claiming `idle` may NEVER win over a pane verdict that says
 *      `working` THIS tick, however fresh the hook's own timestamp is. A
 *      hook claiming `working` is unaffected and still overrides a stale
 *      pane exactly as before — see that function's own doc comment for why
 *      the two directions are not symmetric.
 *   4. Otherwise the frame verdict stands as-is, unknown included — an
 *      `unknown` verdict is its own fresh entry, never a stale
 *      carry-forward of `prev.state`, and the hook can never produce
 *      `unknown` itself (its own state union has no such member).
 */
export function nextActivity(
  prev: Activity | null,
  verdict: FrameVerdict,
  limit: RateLimitObservation | null,
  membersTickingAt: string | null,
  now: Date,
  hook?: HookHeartbeat | null,
): Activity {
  const nowIso = now.toISOString();
  let state: Activity["state"];
  let source: Activity["source"];
  // Set only on the hook-wins branch below, and read back only when
  // `source === "hook"` — kept as its own variable (rather than
  // re-narrowing `hook` at the `since` computation further down) because
  // TS's flow analysis does not carry a type guard evaluated inside an
  // `else if` condition forward into a LATER, independent statement.
  let hookSinceCandidate: string | null = null;
  if (limitStillLive(limit, now)) {
    state = "limit";
    source = "pane";
  } else if (
    verdict.kind !== "working"
    && (verdict.kind === "waiting-members" || membersTickingFresh(membersTickingAt, now))
  ) {
    state = "waiting-members";
    source = "pane";
  } else if (hookWinsAxis(hook, prev?.observedAt ?? null, now) && !hookIdleOverruledByWorkingPane(hook, verdict)) {
    state = hook.state;
    source = "hook";
    hookSinceCandidate = hook.at;
  } else {
    state = verdict.kind;
    source = "pane";
  }
  // `state === "unknown"` can only ever be reached via the final `else`
  // branch above (the hook's own state union has no `"unknown"` member),
  // so checking `verdict.kind === "unknown"` directly — rather than the
  // already-computed `state` — is what lets TS narrow `verdict` far enough
  // to read `.reason` off it, and is equivalent in practice.
  const reason = state === "unknown" && verdict.kind === "unknown" ? verdict.reason : null;
  const sameState = prev !== null && prev.state === state;
  // Same-state: `since` holds, whichever source is reporting this tick.
  // A genuinely NEW state uses `now` (tick granularity) when the pane
  // decided it, or (PR3b) the hook's own precise transition instant when
  // the hook decided it — this is what lets the rendered string report an
  // age more precise than the 30s tick (`WORKING 40s (hook)`).
  const since = sameState ? prev.since : (hookSinceCandidate ?? nowIso);
  // False (a lower bound) until the FIRST observed change; once a change
  // lands it is anchored for good, same-state observations included.
  const anchored = sameState ? prev.anchored : prev !== null;
  return {
    state,
    since,
    anchored,
    observedAt: nowIso,
    source,
    reason,
    membersTickingAt: membersTickingAt ?? prev?.membersTickingAt ?? null,
  };
}

/**
 * Issue #221 (PR3b) — one line of the container's own heartbeat file
 * (`/workspace/.fleet/activity.json`, written atomically by
 * `gates/activity-heartbeat.sh` on `UserPromptSubmit`/`Stop`/`Notification`;
 * `SessionStart` fires too but writes nothing — see that script's own header
 * for why). Deliberately narrower than `Activity` itself: this is the RAW
 * hook-observed claim, before `nextActivity`'s own freshest-wins merge below
 * decides whether it wins THIS tick. Only ever one of the three states a
 * hook can actually observe — `LIMIT` and `WAITING MEMBERS` have no hook
 * event to originate from (no `Notification` payload means "you're
 * rate-limited" or "members are ticking").
 */
export type HookHeartbeat = {
  state: "working" | "idle" | "waiting-question";
  /** When THIS hook fired, ISO, the container's own clock — compared
   *  against `now` in `nextActivity`'s freshest-wins merge, and used
   *  verbatim as `since` when the hook's claim wins a NEW state. */
  at: string;
};

/**
 * Validates one heartbeat-file JSON payload. Whitelist-strict on `state` —
 * this is the ONE seam (Principle 5: "must never assert a state from a hook
 * alone" where the pane can contradict it) that keeps a malformed or
 * malicious heartbeat file from ever claiming `"limit"`/`"waiting-members"`,
 * or any state outside the union a hook can actually observe. Malformed
 * JSON, a non-object payload, a missing/wrong-typed field, or an
 * unparseable `at` all collapse to `null` — "no hook evidence this tick",
 * the exact same outcome `nextActivity` gives the file being entirely
 * absent (a pre-feature container, or a hook that has never fired yet).
 * Never throws — this runs on every ship tick.
 */
export function parseHookHeartbeat(raw: string): HookHeartbeat | null {
  if (raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { state, at } = parsed as Record<string, unknown>;
    if (state !== "working" && state !== "idle" && state !== "waiting-question") return null;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
    return { state, at };
  } catch {
    return null;
  }
}

/** The DO's own storage key for `Activity` — never merged into
 *  `OBSERVED_KEY`'s own read-patch-write cycle (observed.ts), never inside
 *  `status.error`: an independent, unconditional write every ship tick. */
export const ACTIVITY_KEY = "activity";

export interface ActivityStorage {
  get(key: typeof ACTIVITY_KEY): Promise<Activity | undefined>;
  put(key: typeof ACTIVITY_KEY, value: Activity): Promise<void>;
}

/**
 * Issue #221 fix round 2, Fix 4 — `ACTIVITY_KEY`/`MEMBERS_TICKING_KEY` must
 * not survive a container stop or a fresh bring-up (provision/restart/
 * recycle): both answer "how long has the CURRENT activity state held", and
 * a stopped-then-brought-up studio has no continuous state for `since`/
 * `anchored` to describe — without this, a `since`/`anchored` pair stamped
 * before a stop silently survives it, misreporting how long the studio's
 * CURRENT (post-bring-up) activity has actually held.
 *
 * Lives here, not in do.ts or provision.ts, because BOTH call it and neither
 * may import the other: do.ts is this feature's composition root (imports
 * FROM provision.ts), so a shared helper both call has to sit one layer
 * below them, exactly where `ACTIVITY_KEY`/the `Activity` type already live.
 *
 * Duck-typed on `delete` alone — real DO storage (`this.ctx.storage`, both
 * call sites) always has one, but this deliberately does not widen
 * `ActivityStorage`/narrow bring-up ports (`ObservedStorage`) to declare it,
 * which would force every existing Map-backed test fake across dozens of
 * provision/do tests to grow a method they have no reason to need. Never
 * throws — this is best-effort housekeeping, same "must finish regardless"
 * rule `recordContainerStop`'s own doc comment states for onStop, never
 * allowed to fail a stop or a bring-up over a missing/throwing `delete`. */
export async function clearActivityState(storage: { delete(key: string): Promise<unknown> }): Promise<void> {
  try {
    await storage.delete(ACTIVITY_KEY);
    await storage.delete(MEMBERS_TICKING_KEY);
    // Issue #311 — same "describes only the CURRENT incarnation" reasoning
    // as the two keys above: a stopped-then-brought-up studio has no
    // continuous member-row history for goneMemberNames's diff to describe.
    await storage.delete(MEMBER_ALERTS_KEY);
    await storage.delete(MEMBER_ROWS_KEY);
  } catch (err) {
    console.error("clearActivityState: could not clear activity state, continuing", err instanceof Error ? err.message : String(err));
  }
}
