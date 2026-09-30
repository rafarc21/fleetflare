// Issue #221 — PR3a Task 1: readActivityFrame, the pure frame reader.
//
// Every fixture replayed here is already committed (test/fixtures/
// rate-limit-panes.ts, or exported from test/studio.failover-real-panes.test.ts
// below) — no real-tmux capture, ever. See docs/superpowers/specs/
// 2026-09-24-row-tells-truth-design.md, "PR3 — activity states", for the full
// state table this pins.
import { describe, it, expect } from "vitest";
import {
  readActivityFrame, nextActivity, clearActivityState, ACTIVITY_KEY, type Activity,
  parseHookHeartbeat, type HookHeartbeat, extractLastVisibleLine, LAST_LINE_MAX_CHARS,
} from "../src/studio/activity";
import { MEMBERS_TICKING_KEY } from "../src/studio/failover";
import { MEMBER_ALERTS_KEY, MEMBER_ROWS_KEY } from "../src/studio/member-alerts";
import {
  REAL_PILOT_PANE, REAL_WEBSTUDIO_PANE, REAL_WEEKLY_TIMEONLY_PANE, V1_THREE_OPTION_PANE,
  NOT_DETECTED, NOT_DETECTED_106, NOT_DETECTED_OUT_OF_CREDITS_PROSE,
} from "./fixtures/rate-limit-panes";
import { IDLE, DEAD_FRAME, RELAXED_TAIL_NEGATIVES } from "./studio.failover-real-panes.test";
import {
  REAL_LEAD_WAITING_MEMBERS_PANE, REAL_LEAD_WAITING_MEMBERS_PANE_LATER,
  WORKING_GLYPH_DOT_FOOTER_ESC_PANE, WORKING_GLYPH_STAR_TIMER_ONLY_PANE, PANEL_GLYPH_2_1_282_PANE,
  REAL_WEBSTUDIO_C1_WORKING_PANE, REAL_WEBSTUDIO_C13_WORKING_PANE, REAL_WEBSTUDIO_C30_WAITING_MEMBERS_PANE,
  REAL_PERMISSION_PROMPT_TAIL_PANE,
} from "./fixtures/activity-panes";

describe("readActivityFrame — working", () => {
  it("REAL_PILOT_PANE with its status line mutated to a live spinner reads working", () => {
    const pane = REAL_PILOT_PANE.replace("✻ Cogitated for 0s", "✻ Cogitating… (3s · esc to interrupt)");
    expect(readActivityFrame(pane)).toEqual({ kind: "working" });
  });
});

// ---------------------------------------------------------------------------
// Issue #221 fix round 2, Fix 1 — mid-turn misread as idle. The original
// detector only ever looked for `esc to interrupt` on the status line, and
// only recognised `✻` as a spinner glyph. Real behaviour, measured live from
// this container's own running lead (test/fixtures/activity-panes.ts):
// the glyph varies ("·", "✶", not just "✻"), and `esc to interrupt` can
// paint into the FOOTER instead of the status line.
// ---------------------------------------------------------------------------
describe("readActivityFrame — Fix 1: mid-turn misread as idle", () => {
  it("footer carries 'esc to interrupt' (glyph '·', no esc-to-interrupt on the status line itself) reads working", () => {
    expect(readActivityFrame(WORKING_GLYPH_DOT_FOOTER_ESC_PANE)).toEqual({ kind: "working" });
  });

  it("a spinner-glyph status line matching the timer shape reads working even with an ordinary footer (glyph '✶')", () => {
    expect(readActivityFrame(WORKING_GLYPH_STAR_TIMER_ONLY_PANE)).toEqual({ kind: "working" });
  });

  // Isolates the FOOTER leg alone (condition (a) in Fix 1's END STATE): a
  // status line with no timer shape of its own at all — "esc to interrupt"
  // living ONLY in the footer is the sole evidence available. This is the
  // fixture the fix round's own mutant test targets: deleting the footer
  // check in readActivityFrame (temporarily, during review) turns this ONE
  // test red while every other test in this file stays green, because every
  // other "working" fixture also carries a status-line timer shape that the
  // (b) leg alone still catches.
  it("footer-only evidence: a status line with no timer shape of its own still reads working from the footer alone", () => {
    const footerOnly = WORKING_GLYPH_DOT_FOOTER_ESC_PANE.replace(
      "· Improvising… (1s · ↓ 3 tokens)", "· Improvising a plan",
    );
    expect(readActivityFrame(footerOnly)).toEqual({ kind: "working" });
  });
});

// Issue #221 fix round 3, LOW — round 2's wrap-join (skills/fleet-cockpit/
// SKILL.md:263: a corrupted render can split a status/footer phrase across
// two rows) only ever re-joined `esc to interrupt` on the status line.
// Generalised so the SAME join is tried for the spinner's own timer shape
// too, not just that one phrase.
describe("readActivityFrame — round 3: wrap-join generalised beyond 'esc to interrupt'", () => {
  it("a corrupted render splitting the spinner's OWN timer parenthetical across two rows still reads working", () => {
    // REAL_PILOT_PANE's own "✻ Cogitated for 0s" (a TURN_ENDED_LINE) becomes
    // a bare timer shape with no 'esc to interrupt' anywhere — the SAME
    // condition (b) WORKING_GLYPH_STAR_TIMER_ONLY_PANE proves unwrapped —
    // but split mid-parenthetical across two rows, the corruption round 2's
    // join logic only ever protected `esc to interrupt` against, never the
    // timer shape itself. The leading `✻ ` keeps the FIRST row a status-line
    // candidate on its own (STATUS_LINE), same as any real corrupted status
    // line would be, so this isolates the timer-join leg specifically.
    const wrapped = REAL_PILOT_PANE.replace(
      "✻ Cogitated for 0s",
      "✻ Cogitating… (3s\n· ↑ 2.1k tokens)",
    );
    expect(wrapped).not.toBe(REAL_PILOT_PANE);
    expect(readActivityFrame(wrapped)).toEqual({ kind: "working" });
  });
});

describe("readActivityFrame — Fix 6: waiting-question (permission prompts and other select menus)", () => {
  // Derived from V1_THREE_OPTION_PANE (test/fixtures/rate-limit-panes.ts) by
  // replacing ONLY its question and option lines with non-limit text — the
  // same technique this PR's own sibling fix round used ("built question-menu
  // fixture by deleting limit lines from an existing frame; no invented pane
  // text"). Structure (▔ rule, question, numbered options, "Enter to confirm
  // · Esc to cancel") is real and already committed; only the wording differs
  // from the limit modal, which is the whole point of this test.
  const nonLimitMenu = (question: string, options: string[]) => V1_THREE_OPTION_PANE
    .replace("   What do you want to do?", `   ${question}`)
    .replace(
      [
        "   ❯ 1. Stop and wait for limit to reset",
        "     2. Add funds to continue with usage credits",
        "     3. Upgrade your plan",
      ].join("\n"),
      options.map((o, i) => `   ${i === 0 ? "❯" : " "} ${i + 1}. ${o}`).join("\n"),
    );

  it("a generic question menu ('Esc to cancel', non-limit options) reads waiting-question, never idle or limit-shaped", () => {
    const pane = nonLimitMenu("Which mode do you want?", [
      "Continue in plan mode", "Accept edits automatically", "Manually approve edits",
    ]);
    expect(pane).not.toBe(V1_THREE_OPTION_PANE);
    expect(readActivityFrame(pane)).toEqual({ kind: "waiting-question" });
  });

  // Issue #221 fix round 2 measured a REAL, live web-studio parked on
  // exactly this question and misread as IDLE. This particular fixture
  // reuses the LIMIT MODAL's own footer wording ("Enter to confirm · Esc to
  // cancel", spliced in via nonLimitMenu from V1_THREE_OPTION_PANE) — round
  // 3 discovered that a REAL permission prompt's own footer is actually a
  // DIFFERENT shape (see the REGRESSION test below), so this test is kept
  // for coverage of the classic/limit-style footer wording specifically,
  // not relabelled "measured live" any more.
  it("a permission prompt 'Do you want to proceed?' with the classic modal footer ('Enter to confirm · Esc to cancel') reads waiting-question, never idle", () => {
    const pane = nonLimitMenu("Do you want to proceed?", [
      "Yes", "Yes, and don't ask again for this session", "No, and tell Claude what to do differently (esc)",
    ]);
    const verdict = readActivityFrame(pane);
    expect(verdict).toEqual({ kind: "waiting-question" });
    expect(verdict.kind).not.toBe("idle");
  });

  // Issue #221 fix round 3 — REGRESSION (measured live, this time for real):
  // round 2's Fix 6 assumed every select-style menu, permission prompts
  // included, draws the SAME footer as the limit modal ("Enter to confirm ·
  // Esc to cancel"). A live web-studio capture, 2026-09-25, shows a REAL
  // permission prompt's own footer is `Esc to cancel · Tab to amend ·
  // ctrl+e to explain` instead — a shape MODAL_FOOTER_LINE (failover.ts)
  // never matched before this round's fix, misreading the prompt as
  // "unknown" (claude not on screen) rather than waiting-question.
  it("REGRESSION (measured live): REAL_PERMISSION_PROMPT_TAIL_PANE's own footer ('Esc to cancel · Tab to amend · ctrl+e to explain') reads waiting-question, never idle or unknown", () => {
    const verdict = readActivityFrame(REAL_PERMISSION_PROMPT_TAIL_PANE);
    expect(verdict).toEqual({ kind: "waiting-question" });
    expect(verdict.kind).not.toBe("idle");
  });
});

describe("readActivityFrame — Fix 6: queued-message hint and clipboard chrome must not mask a real working turn", () => {
  it("'Press up to edit queued messages' under a queued prompt does not turn a live spinner into idle", () => {
    const pane = REAL_PILOT_PANE
      .replace("✻ Cogitated for 0s", "✻ Cogitating… (3s · esc to interrupt)")
      .replace("❯ keep going", "❯ keep going\n  (Press up to edit queued messages)");
    expect(readActivityFrame(pane)).toEqual({ kind: "working" });
  });

  it("'Image in clipboard' chrome near the prompt does not turn a live spinner into idle", () => {
    const pane = REAL_PILOT_PANE
      .replace("✻ Cogitated for 0s", "✻ Cogitating… (3s · esc to interrupt)")
      .replace("❯ keep going", "❯ keep going\n  [Image in clipboard]");
    expect(readActivityFrame(pane)).toEqual({ kind: "working" });
  });
});

describe("readActivityFrame — Fix 6: panel glyph '⏺ main' (claude 2.1.282) does not corrupt the parse", () => {
  it("PANEL_GLYPH_2_1_282_PANE (REAL_WEBSTUDIO_PANE with '● main' -> '⏺ main') reads the SAME verdict as the unmutated pane", () => {
    expect(PANEL_GLYPH_2_1_282_PANE).not.toBe(REAL_WEBSTUDIO_PANE);
    // #86: its "7 shells" chrome makes both waiting-members (was idle).
    expect(readActivityFrame(REAL_WEBSTUDIO_PANE)).toEqual({ kind: "waiting-members" });
    expect(readActivityFrame(PANEL_GLYPH_2_1_282_PANE)).toEqual({ kind: "waiting-members" });
  });
});

describe("readActivityFrame — real waiting-members captures (this container's own lead, 2026-09-25)", () => {
  it("REAL_LEAD_WAITING_MEMBERS_PANE reads waiting-members", () => {
    expect(readActivityFrame(REAL_LEAD_WAITING_MEMBERS_PANE)).toEqual({ kind: "waiting-members" });
  });

  it("the LATER real capture (panel timer advanced, status line unchanged) also reads waiting-members", () => {
    expect(REAL_LEAD_WAITING_MEMBERS_PANE_LATER).not.toBe(REAL_LEAD_WAITING_MEMBERS_PANE);
    expect(readActivityFrame(REAL_LEAD_WAITING_MEMBERS_PANE_LATER)).toEqual({ kind: "waiting-members" });
  });
});

describe("readActivityFrame — round 3: REAL fleetflare--web-studio captures (2026-09-25)", () => {
  // VERBATIM `tmux capture-pane -p` reads from a DIFFERENT studio
  // (fleetflare--web-studio) than this file's other real fixtures, both
  // proving Fix 1's FOOTER leg with real field evidence (`esc to interrupt`
  // painted into the chrome footer, not the status line).
  it("REAL_WEBSTUDIO_C1_WORKING_PANE reads working", () => {
    expect(readActivityFrame(REAL_WEBSTUDIO_C1_WORKING_PANE)).toEqual({ kind: "working" });
  });

  it("REAL_WEBSTUDIO_C13_WORKING_PANE (same session, later capture) reads working", () => {
    expect(REAL_WEBSTUDIO_C13_WORKING_PANE).not.toBe(REAL_WEBSTUDIO_C1_WORKING_PANE);
    expect(readActivityFrame(REAL_WEBSTUDIO_C13_WORKING_PANE)).toEqual({ kind: "working" });
  });

  it("REAL_WEBSTUDIO_C30_WAITING_MEMBERS_PANE (same session, no 'esc to interrupt' in the footer) reads waiting-members", () => {
    expect(readActivityFrame(REAL_WEBSTUDIO_C30_WAITING_MEMBERS_PANE)).toEqual({ kind: "waiting-members" });
  });
});

describe("readActivityFrame — waiting-members", () => {
  it("'✻ Waiting for 1 background agent to finish' bottom-anchored reads waiting-members", () => {
    // test/studio.failover-real-panes.test.ts's RELAXED_TAIL_NEGATIVES entry:
    // a block followed by a non-turn ✻ line (waiting on agents).
    const pane = RELAXED_TAIL_NEGATIVES["a block followed by a non-turn ✻ line (waiting on agents)"];
    expect(readActivityFrame(pane)).toEqual({ kind: "waiting-members" });
  });
});

describe("readActivityFrame — #86: a live background shell/monitor/task is waiting, not idle", () => {
  // REAL_WEBSTUDIO_PANE, member row and typed text removed: turn ended, empty
  // input box. Its own "7 shells" chrome is the background counter.
  const base = REAL_WEBSTUDIO_PANE.replace(/\n[^\n]*◯ frontend-developer[^\n]*/, "")
    .replace("❯\u00a0check on task 2 progress", "❯\u00a0");
  const clean = base.replace(" · 7 shells still running", "").replace(" · 7 shells", "");

  it("the clean pane (no counter anywhere) still reads idle", () => {
    expect(readActivityFrame(clean)).toEqual({ kind: "idle" });
  });

  it("footer '7 shells' + turn-ended '7 shells still running' reads waiting-members", () => {
    expect(readActivityFrame(base)).toEqual({ kind: "waiting-members" });
  });

  it("footer '2 monitors' alone reads waiting-members", () => {
    const pane = clean.replace("⏵⏵ bypass permissions on ·", "⏵⏵ bypass permissions on · 2 monitors ·");
    expect(readActivityFrame(pane)).toEqual({ kind: "waiting-members" });
  });

  it("footer '1 shell' alone reads waiting-members", () => {
    const pane = clean.replace("⏵⏵ bypass permissions on ·", "⏵⏵ bypass permissions on · 1 shell ·");
    expect(readActivityFrame(pane)).toEqual({ kind: "waiting-members" });
  });

  it("turn-ended row '1 background task still running' alone reads waiting-members", () => {
    const pane = clean.replace("✻ Cooked for 36m 35s", "✻ Cooked for 36m 35s · 1 background task still running");
    expect(readActivityFrame(pane)).toEqual({ kind: "waiting-members" });
  });

  it("a counter quoted in transcript prose above the box does not count", () => {
    const pane = clean.replace("✻ Cooked for 36m 35s", "  3 shells still running was the old footer\n\n✻ Cooked for 36m 35s");
    expect(readActivityFrame(pane)).toEqual({ kind: "idle" });
  });
});

describe("readActivityFrame — idle", () => {
  it("IDLE (⏺ Done. + empty input box) reads idle", () => {
    expect(readActivityFrame(IDLE)).toEqual({ kind: "idle" });
  });

  it("REAL_WEEKLY_TIMEONLY_PANE's tail (turn-ended row, then the input box) reads idle", () => {
    expect(readActivityFrame(REAL_WEEKLY_TIMEONLY_PANE)).toEqual({ kind: "idle" });
  });
});

describe("readActivityFrame — unknown", () => {
  it("DEAD_FRAME (claude's last frame, dead, above a bash prompt) reads unknown: claude not on screen", () => {
    expect(readActivityFrame(DEAD_FRAME)).toEqual({ kind: "unknown", reason: "claude not on screen" });
  });
});

// Issue #108 (#70 ask 4 remainder) — the lead's last VISIBLE message line,
// PURE extraction from one pane frame. Reuses every chrome pattern this file
// already imports/defines to decide "is this the lead's status chrome" —
// never a fresh copy of the same detection.
describe("extractLastVisibleLine", () => {
  const IDLE_INPUT_BOX = ["", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"];

  it("a working frame with real assistant/tool-output text above the footer returns the last non-blank content line, trimmed", () => {
    const frame = [
      "⏺ Done (90 tool uses · 281.2k tokens · 18m 53s)",
      "",
      "✻ Cogitating… (3s · esc to interrupt)",
      "",
      "─".repeat(68),
      "❯ ",
      "─".repeat(68),
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("⏺ Done (90 tool uses · 281.2k tokens · 18m 53s)");
  });

  it("an idle frame whose content above the input box is blank/only chrome returns null", () => {
    const frame = ["", ...IDLE_INPUT_BOX].join("\n");
    expect(extractLastVisibleLine(frame)).toBeNull();
  });

  it("an empty frame returns null", () => {
    expect(extractLastVisibleLine("")).toBeNull();
    expect(extractLastVisibleLine("   \n  \n")).toBeNull();
  });

  // Finding 1 (post-ship code review) — truncation moved OUT of this pure
  // extractor entirely (see `truncateLine`'s own doc comment for why): a
  // content line longer than LAST_LINE_MAX_CHARS must come back whole, so
  // do.ts can redact the FULL line before truncating it, never the reverse.
  it("a content line longer than LAST_LINE_MAX_CHARS is returned whole, untruncated", () => {
    const long = "x".repeat(250);
    const frame = [long, ...IDLE_INPUT_BOX].join("\n");
    const result = extractLastVisibleLine(frame);
    expect(result).toBe(long);
    expect(result?.length).toBe(250);
    expect(result?.length).toBeGreaterThan(LAST_LINE_MAX_CHARS);
  });

  it("a real content line sitting directly above the idle input box is returned, the box itself skipped", () => {
    const frame = ["Some real message here.", ...IDLE_INPUT_BOX].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("Some real message here.");
  });

  // Finding 2 (post-ship code review) — the chrome-skip coverage below never
  // exercised a live status/spinner line, a turn-ended row, the
  // waiting-members row, the question-modal shape, or the "no footer at all"
  // fallback branch. Each fixture puts the real answer directly BEHIND the
  // chrome line under test, proving the chrome itself is skipped rather than
  // returned as "the message".
  it("skips a live status/spinner line (SPINNER_TIMER_LINE shape) sitting above the idle input box", () => {
    const frame = [
      "Real message before the spinner.",
      "✻ Cogitating… (3s · esc to interrupt)",
      ...IDLE_INPUT_BOX,
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("Real message before the spinner.");
  });

  it("skips a TURN_ENDED_LINE row ('✻ Cooked for 36m 35s') sitting above the idle input box", () => {
    const frame = [
      "Real message before the turn-ended row.",
      "✻ Cooked for 36m 35s",
      ...IDLE_INPUT_BOX,
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("Real message before the turn-ended row.");
  });

  it("skips a WAITING_MEMBERS_LINE row ('✻ Waiting for 2 background agents to finish')", () => {
    const frame = [
      "Real message before waiting on members.",
      "✻ Waiting for 2 background agents to finish",
      "",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("Real message before waiting on members.");
  });

  // Only the modal's own block-start rule and footer are chrome this
  // function skips (its own doc comment); a real question/option line
  // between them is ordinary content this narrow function does not also
  // recognise, so this fixture keeps the modal shape to just those two
  // lines — the ones the finding asks this function to prove it skips.
  it("skips a question-modal block (MODAL_BLOCK_START + MODAL_FOOTER_LINE), no footer chrome present", () => {
    const frame = [
      "Real message before the question.",
      "▔".repeat(68),
      "   Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("Real message before the question.");
  });

  it("footerAtBottom's 'no footer found' fallback: a frame with no recognisable footer at all still skips its own trailing chrome line", () => {
    const frame = [
      "Real message with no footer anywhere below it.",
      "✻ Cooked for 36m 35s",
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("Real message with no footer anywhere below it.");
  });

  // Issue #108 fix-first (PR #118, maestro review) — the idle input box is
  // ONE chrome block (open rule, `❯` row, up to QUEUED_TEXT_ROWS wrapped
  // continuation rows, close rule), not three independently-matched line
  // patterns. The wrapped continuation rows match neither RULE_LINE nor
  // PROMPT_LINE — a line-by-line scan alone surfaces one of THEM as "the
  // lead's last message" instead of skipping the whole box, which can leak
  // queued/pasted operator text (secret-shaped tokens split across rows
  // included — see the next test) onto `fleet ls --json`.
  const RULE = "─".repeat(68);

  it("an idle input box with wrapped continuation rows is skipped as ONE block, not scanned row by row", () => {
    const frame = [
      "Real message above the box.",
      "",
      RULE,
      "❯ some queued",
      "text that wraps",
      "across two rows",
      RULE,
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("Real message above the box.");
  });

  it("a secret-shaped token split across two continuation rows is never returned, even though neither half matches redact.ts's own pattern alone", () => {
    const row1 = "sk-ant-";
    const row2 = "api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    // Confirm the split genuinely defeats redact.ts's ANTHROPIC_KEY_RE
    // (/sk-ant-[A-Za-z0-9_-]+/) per row before relying on it below.
    expect(/sk-ant-[A-Za-z0-9_-]+/.test(row1)).toBe(false);
    expect(/sk-ant-[A-Za-z0-9_-]+/.test(row2)).toBe(false);
    const frame = [
      "Real message above the box.",
      "",
      RULE,
      "❯ ",
      row1,
      row2,
      RULE,
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("Real message above the box.");
  });

  // Fallback contract (documented on extractLastVisibleLine's own doc
  // comment): when no well-formed closing rule is found within
  // QUEUED_TEXT_ROWS of the opening rule — a corrupted/truncated capture —
  // this falls back to the OLD per-line chrome scan for the whole span
  // rather than inventing new "not a real box" handling. That means a
  // continuation row of a genuinely malformed box can still surface as "the
  // message" here; this is a known, accepted edge case (a malformed capture
  // already fails other detectors, e.g. `endsInIdleInputBox`), not a silent
  // regression.
  it("a malformed/unclosed idle input box (no closing rule within bound) falls back to the old per-line chrome scan", () => {
    const frame = [
      "Real message above malformed box.",
      RULE,
      "❯ ",
      "continuation row one, never closed",
      "continuation row two, never closed",
    ].join("\n");
    expect(extractLastVisibleLine(frame)).toBe("continuation row two, never closed");
  });
});

describe("readActivityFrame — the negative corpus never reads working", () => {
  const all = { ...NOT_DETECTED, ...NOT_DETECTED_106, ...NOT_DETECTED_OUT_OF_CREDITS_PROSE, ...RELAXED_TAIL_NEGATIVES };
  for (const [name, pane] of Object.entries(all)) {
    it(`does not read working on ${name}`, () => {
      expect(readActivityFrame(pane).kind).not.toBe("working");
    });
  }
});

describe("readActivityFrame — wrap join", () => {
  it("'esc to interrupt' split across two wrapped rows still reads working", () => {
    const pane = REAL_PILOT_PANE.replace(
      "✻ Cogitated for 0s",
      "✻ Cogitating… (3s · esc to inter\nrupt)",
    );
    expect(readActivityFrame(pane)).toEqual({ kind: "working" });
  });

  it("'esc to interrupt' quoted in ⏺ prose above a LATER turn-ended line does not read working", () => {
    // Bottom-anchoring: the lead printed a stale spinner line into its own
    // transcript (this spec's own "known residual"), but its real turn ended
    // AFTER that quote — the LAST ✻ line is the real one.
    const pane = [
      "⏺ The pane showed:",
      "✻ Cogitating… (3s · esc to interrupt)",
      "",
      "✻ Cooked for 2m",
      "",
      "─".repeat(80),
      "❯ ",
      "─".repeat(80),
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(readActivityFrame(pane)).toEqual({ kind: "idle" });
  });
});

// ---------------------------------------------------------------------------
// Task 2 — nextActivity, the state machine.
// ---------------------------------------------------------------------------
describe("nextActivity", () => {
  const T0 = new Date("2026-09-25T12:00:00.000Z");
  const T1 = new Date("2026-09-25T12:00:30.000Z");
  const T2 = new Date("2026-09-25T12:01:00.000Z");

  it("since holds across same-state observations", () => {
    const first = nextActivity(null, { kind: "working" }, null, null, T0);
    const second = nextActivity(first, { kind: "working" }, null, null, T1);
    expect(second.since).toBe(first.since);
    expect(second.observedAt).toBe(T1.toISOString());
  });

  it("since resets on a state change", () => {
    const first = nextActivity(null, { kind: "working" }, null, null, T0);
    const second = nextActivity(first, { kind: "idle" }, null, null, T1);
    expect(second.since).toBe(T1.toISOString());
    expect(second.since).not.toBe(first.since);
  });

  it("anchored is false until the first observed change, then stays true", () => {
    const first = nextActivity(null, { kind: "working" }, null, null, T0);
    expect(first.anchored).toBe(false);
    const same = nextActivity(first, { kind: "working" }, null, null, T1);
    expect(same.anchored).toBe(false);
    const changed = nextActivity(same, { kind: "idle" }, null, null, T2);
    expect(changed.anchored).toBe(true);
    const stillIdle = nextActivity(changed, { kind: "idle" }, null, null, T2);
    expect(stillIdle.anchored).toBe(true);
  });

  it("a limit observation outranks every frame verdict", () => {
    const limit = { until: "2026-09-25T13:30:00.000Z", seenAt: T0.toISOString() };
    const result = nextActivity(null, { kind: "working" }, limit, null, T0);
    expect(result.state).toBe("limit");
  });

  it("a waiting-members frame verdict reaches waiting-members", () => {
    const result = nextActivity(null, { kind: "waiting-members" }, null, null, T0);
    expect(result.state).toBe("waiting-members");
  });

  it("a fresh membersTickingAt reaches waiting-members even over an idle frame", () => {
    const result = nextActivity(null, { kind: "idle" }, null, T0.toISOString(), T0);
    expect(result.state).toBe("waiting-members");
  });

  it("an unknown verdict never inherits the previous state's word", () => {
    const working = nextActivity(null, { kind: "working" }, null, null, T0);
    const result = nextActivity(working, { kind: "unknown", reason: "unrecognised frame" }, null, null, T1);
    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("unrecognised frame");
    expect(result.since).toBe(T1.toISOString());
  });

  it("reason is null whenever state is not unknown", () => {
    const result = nextActivity(null, { kind: "working" }, null, null, T0);
    expect(result.reason).toBeNull();
  });

  it("membersTickingAt carries forward when the caller does not pass a fresh one", () => {
    const first = nextActivity(null, { kind: "waiting-members" }, null, T0.toISOString(), T0);
    const second: Activity = nextActivity(first, { kind: "idle" }, null, null, T2);
    expect(second.membersTickingAt).toBe(T0.toISOString());
  });

  it("a waiting-question frame verdict reaches waiting-question", () => {
    const result = nextActivity(null, { kind: "waiting-question" }, null, null, T0);
    expect(result.state).toBe("waiting-question");
  });
});

// ---------------------------------------------------------------------------
// Issue #221 fix round 2, Fix 2 — spec order: WORKING must outrank a merely
// fresh `membersTickingAt`, not the other way around (docs/superpowers/specs/
// 2026-09-24-row-tells-truth-design.md's own state table lists WORKING above
// WAITING MEMBERS). Before this fix, `nextActivity` checked
// `membersTickingFresh` BEFORE `verdict.kind === "working"`, so a lead
// visibly typing right now on its OWN status line could still be reported as
// waiting-members purely because a member's panel row had ticked up to 10
// minutes earlier.
// ---------------------------------------------------------------------------
describe("nextActivity — Fix 2: WORKING outranks a merely-fresh membersTickingAt", () => {
  const T0 = new Date("2026-09-25T12:00:00.000Z");

  it("a working frame verdict wins over a fresh membersTickingAt", () => {
    const result = nextActivity(null, { kind: "working" }, null, T0.toISOString(), T0);
    expect(result.state).toBe("working");
  });

  it("waiting-members still wins when the frame itself is not working (unchanged behaviour)", () => {
    const result = nextActivity(null, { kind: "idle" }, null, T0.toISOString(), T0);
    expect(result.state).toBe("waiting-members");
  });
});

// ---------------------------------------------------------------------------
// Issue #221 fix round 2, Fix 3 — a limit observation stops outranking the
// frame once its OWN printed reset has passed; before this fix, `nextActivity`
// forced `"limit"` forever the moment `row.rateLimited` was first set,
// regardless of how long ago its reset time had come and gone, degrading
// `fleet ls`'s ACTIVITY column to a bare "?" permanently (readiness-format.ts's
// `activity.state === "limit"` render had no other real verdict to fall back
// to, because the stored state was never anything else).
// ---------------------------------------------------------------------------
describe("nextActivity — Fix 3: a limit past its own reset drops to the real verdict", () => {
  const SEEN = new Date("2026-09-25T12:00:00.000Z");
  const PAST_RESET = new Date("2026-09-25T14:00:00.000Z"); // 2h after the printed reset below
  const limit = { until: "2026-09-25T13:00:00.000Z", seenAt: SEEN.toISOString() };

  it("while the reset is still ahead, limit wins as before", () => {
    const now = new Date("2026-09-25T12:30:00.000Z"); // before the 13:00 reset
    const result = nextActivity(null, { kind: "working" }, limit, null, now);
    expect(result.state).toBe("limit");
  });

  it("once the printed reset has passed, the real frame verdict takes over instead of staying parked on limit", () => {
    const result = nextActivity(null, { kind: "working" }, limit, null, PAST_RESET);
    expect(result.state).toBe("working");
  });

  it("never degrades silently to unknown-with-no-reason: a genuinely unknown frame past reset still carries its own reason", () => {
    const result = nextActivity(null, { kind: "unknown", reason: "unrecognised frame" }, limit, null, PAST_RESET);
    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("unrecognised frame");
  });

  it("a full ship-tick sequence self-heals within one tick after reset, never stuck on limit forever", () => {
    const beforeReset = nextActivity(null, { kind: "idle" }, limit, null, new Date("2026-09-25T12:30:00.000Z"));
    expect(beforeReset.state).toBe("limit");
    const afterReset = nextActivity(beforeReset, { kind: "idle" }, limit, null, PAST_RESET);
    expect(afterReset.state).toBe("idle");
    // since resets too — this is a genuine new state, not a stale carry-forward.
    expect(afterReset.since).toBe(PAST_RESET.toISOString());
  });

  it("select modals never expire on the clock (no reset to check against)", () => {
    const select = { until: "2026-09-25T13:00:00.000Z", seenAt: SEEN.toISOString(), select: true as const };
    const result = nextActivity(null, { kind: "idle" }, select, null, PAST_RESET);
    expect(result.state).toBe("limit");
  });

  it("an unreadable reset (until: null) never expires either — unchanged from before this fix", () => {
    const noReset = { until: null, seenAt: SEEN.toISOString() };
    const result = nextActivity(null, { kind: "idle" }, noReset, null, PAST_RESET);
    expect(result.state).toBe("limit");
  });
});

// ---------------------------------------------------------------------------
// Issue #221 fix round 2, Fix 4 — clearActivityState: ACTIVITY_KEY and
// MEMBERS_TICKING_KEY must not survive a stop or a bring-up. See do.ts's
// onStop and provision.ts's recordBringupObservation for the two real call
// sites; this proves the shared primitive itself, plus the causal chain a
// caller relies on (a cleared key reads back as null, which is exactly what
// makes nextActivity treat the next observation as a fresh state).
// ---------------------------------------------------------------------------
describe("clearActivityState — Fix 4", () => {
  function fakeDeletableStorage(seed: Record<string, unknown> = {}) {
    const map = new Map<string, unknown>(Object.entries(seed));
    return {
      map,
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => { map.set(key, value); },
      delete: async (key: string) => map.delete(key),
    };
  }

  it("deletes both ACTIVITY_KEY and MEMBERS_TICKING_KEY", async () => {
    const storage = fakeDeletableStorage({
      [ACTIVITY_KEY]: { state: "working" }, [MEMBERS_TICKING_KEY]: "2026-09-25T12:00:00.000Z",
    });
    await clearActivityState(storage);
    expect(storage.map.has(ACTIVITY_KEY)).toBe(false);
    expect(storage.map.has(MEMBERS_TICKING_KEY)).toBe(false);
  });

  // Issue #311 — MEMBER_ALERTS_KEY/MEMBER_ROWS_KEY (member-alerts.ts) carry
  // the SAME "describes the CURRENT incarnation only" property ACTIVITY_KEY/
  // MEMBERS_TICKING_KEY already do (a stopped-then-brought-up studio has no
  // continuous member-row history for a "row vanished" diff to describe),
  // so they route through this SAME shared primitive rather than growing
  // their own clear call.
  it("also deletes MEMBER_ALERTS_KEY and MEMBER_ROWS_KEY (issue #311)", async () => {
    const storage = fakeDeletableStorage({
      [MEMBER_ALERTS_KEY]: [{ kind: "poll-loop" }], [MEMBER_ROWS_KEY]: ["frontend-developer"],
    });
    await clearActivityState(storage);
    expect(storage.map.has(MEMBER_ALERTS_KEY)).toBe(false);
    expect(storage.map.has(MEMBER_ROWS_KEY)).toBe(false);
  });

  it("never throws when the storage has no delete method at all (an older narrow-port test fake)", async () => {
    const noDelete = {} as { delete(key: string): Promise<unknown> };
    await expect(clearActivityState(noDelete)).resolves.toBeUndefined();
  });

  it("never throws when delete itself rejects", async () => {
    const throwing = { delete: async () => { throw new Error("storage down"); } };
    await expect(clearActivityState(throwing)).resolves.toBeUndefined();
  });

  it("REGRESSION: since resets after a stop -> bring-up cycle instead of surviving it", async () => {
    const OLD = new Date("2026-09-25T09:00:00.000Z");
    const AFTER_BRINGUP = new Date("2026-09-25T12:00:00.000Z"); // 3h later
    const storage = fakeDeletableStorage();
    // Before the stop: the studio was WORKING, anchored, since 09:00.
    const beforeStop = nextActivity(null, { kind: "working" }, null, null, OLD);
    await storage.put(ACTIVITY_KEY, beforeStop);
    expect(beforeStop.since).toBe(OLD.toISOString());
    // Stop, then bring-up: both call sites clear activity state.
    await clearActivityState(storage);
    expect(await storage.get(ACTIVITY_KEY)).toBeUndefined();
    // The next ship tick after bring-up reads back `undefined` -> null, so
    // nextActivity treats this as a FRESH state, never the 09:00 survivor,
    // even though the frame verdict happens to be "working" again.
    const prevActivity = ((await storage.get(ACTIVITY_KEY)) as Activity | undefined) ?? null;
    const afterBringup = nextActivity(prevActivity, { kind: "working" }, null, null, AFTER_BRINGUP);
    expect(afterBringup.since).toBe(AFTER_BRINGUP.toISOString());
    expect(afterBringup.since).not.toBe(beforeStop.since);
    expect(afterBringup.anchored).toBe(false); // a lower bound again, never inherited
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3b) — parseHookHeartbeat: the container's own heartbeat file
// (gates/activity-heartbeat.sh's atomic write to /workspace/.fleet/
// activity.json), validated whitelist-strict on `state` — this is the ONE
// seam that keeps a malformed/hostile heartbeat file from ever claiming
// "limit"/"waiting-members" (no hook event exists for either), or any state
// outside the union the hook can actually observe.
// ---------------------------------------------------------------------------
describe("parseHookHeartbeat (PR3b)", () => {
  it("parses a valid working heartbeat", () => {
    const raw = JSON.stringify({ state: "working", at: "2026-09-25T12:00:40.000Z" });
    expect(parseHookHeartbeat(raw)).toEqual({ state: "working", at: "2026-09-25T12:00:40.000Z" });
  });

  it("parses idle and waiting-question too", () => {
    expect(parseHookHeartbeat(JSON.stringify({ state: "idle", at: "2026-09-25T12:00:00.000Z" })))
      .toEqual({ state: "idle", at: "2026-09-25T12:00:00.000Z" });
    expect(parseHookHeartbeat(JSON.stringify({ state: "waiting-question", at: "2026-09-25T12:00:00.000Z" })))
      .toEqual({ state: "waiting-question", at: "2026-09-25T12:00:00.000Z" });
  });

  it("rejects state: 'limit' — a hook has no event to originate this from", () => {
    expect(parseHookHeartbeat(JSON.stringify({ state: "limit", at: "2026-09-25T12:00:00.000Z" }))).toBeNull();
  });

  it("rejects state: 'waiting-members' — same reasoning", () => {
    expect(parseHookHeartbeat(JSON.stringify({ state: "waiting-members", at: "2026-09-25T12:00:00.000Z" }))).toBeNull();
  });

  it("rejects an unrecognised state entirely", () => {
    expect(parseHookHeartbeat(JSON.stringify({ state: "bogus", at: "2026-09-25T12:00:00.000Z" }))).toBeNull();
  });

  it("rejects malformed JSON, never throws", () => {
    expect(() => parseHookHeartbeat("not json")).not.toThrow();
    expect(parseHookHeartbeat("not json")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parseHookHeartbeat("")).toBeNull();
  });

  it("rejects a missing/unparseable `at`", () => {
    expect(parseHookHeartbeat(JSON.stringify({ state: "working" }))).toBeNull();
    expect(parseHookHeartbeat(JSON.stringify({ state: "working", at: "not a date" }))).toBeNull();
  });

  // Issue #221 fix round 3, LOW (maestro review, PR #352) —
  // gates/activity-heartbeat.sh's write_state now stamps millisecond
  // precision (`date -u +%Y-%m-%dT%H:%M:%S.%3NZ`), not the old whole-second
  // `...:SSZ`. A real captured string from that format must parse cleanly —
  // parseHookHeartbeat's own `at` check is just
  // `Number.isFinite(Date.parse(at))`, so this also pins that no format
  // regex anywhere rejects the added `.mmm` component.
  it("parses a real millisecond-bearing timestamp exactly as write_state's new format produces (round 3, LOW)", () => {
    const raw = JSON.stringify({ state: "working", at: "2026-09-26T01:30:00.123Z" });
    expect(parseHookHeartbeat(raw)).toEqual({ state: "working", at: "2026-09-26T01:30:00.123Z" });
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3b) — nextActivity's freshest-wins hook merge. Spec, verbatim
// (docs/superpowers/specs/2026-09-24-row-tells-truth-design.md, "PR3 —
// activity states"): "Hooks never override the pane. LIMIT and WAITING
// MEMBERS come only from the pane. On the WORKING/IDLE axis the FRESHER
// observation wins, ties to the pane."
// ---------------------------------------------------------------------------
describe("nextActivity — PR3b hook merge", () => {
  const NOW = new Date("2026-09-25T12:00:00.000Z");
  const FRESHER = "2026-09-25T12:00:00.500Z"; // strictly later than NOW
  const STALER = "2026-09-25T11:59:59.500Z"; // strictly earlier than NOW

  // Issue #221 fix round 3 — this used to assert the OPPOSITE direction
  // (hook `idle` overriding a pane verdict of `working`). That direction is
  // now guarded against (see the dedicated "round 3 MED fix" describe block
  // below); a fresher, CONTRADICTING hook claim on the direction that
  // remains unchanged — `working` overriding a stale, contradicting `idle`
  // pane — still wins, which is what this proves now.
  it("MUTANT PROOF (a): a fresher, CONTRADICTING hook `working` claim wins the WORKING/IDLE axis, sourced as hook, since = the hook's own timestamp", () => {
    const hook: HookHeartbeat = { state: "working", at: FRESHER };
    const result = nextActivity(null, { kind: "idle" }, null, null, NOW, hook);
    expect(result.state).toBe("working");
    expect(result.source).toBe("hook");
    expect(result.since).toBe(FRESHER);
  });

  // Issue #221 fix round 2 (maestro review, PR #352, HIGH finding) — the
  // comparison basis changed from "hook.at vs a freshly-read `now`" (never
  // reachable in production, see hookWinsAxis's own doc comment) to
  // "hook.at vs prev.observedAt", the PREVIOUS tick's own capture instant.
  // A "tie or stale" hook now means `hook.at <= prev.observedAt` — a claim
  // that tells us nothing we did not already know as of the last look —
  // not `hook.at <= now`, which no real hook stamp ever fails to satisfy
  // (a real hook.at is always in the past by the time anything reads it).
  it("a hook no newer than the last look never wins — ties go to the pane", () => {
    const PREV_OBSERVED = "2026-09-25T12:00:00.000Z";
    const prev = nextActivity(null, { kind: "idle" }, null, null, new Date(PREV_OBSERVED));
    expect(prev.observedAt).toBe(PREV_OBSERVED);

    const LATER = new Date("2026-09-25T12:00:30.000Z");
    const tie: HookHeartbeat = { state: "idle", at: PREV_OBSERVED }; // exactly prev.observedAt
    const result = nextActivity(prev, { kind: "working" }, null, null, LATER, tie);
    expect(result.state).toBe("working");
    expect(result.source).toBe("pane");

    const stale: HookHeartbeat = { state: "idle", at: STALER }; // strictly before prev.observedAt
    const result2 = nextActivity(prev, { kind: "working" }, null, null, LATER, stale);
    expect(result2.state).toBe("working");
    expect(result2.source).toBe("pane");
  });

  // The realistic-clock cases the maestro's review explicitly demanded: a
  // hook.at that is OLDER than the moment it's compared against (never in
  // the future, unlike FRESHER above) but still NEWER than the last look —
  // exactly what a real Stop/UserPromptSubmit hook stamp looks like.
  // MUTANT PROOF: reverting hookWinsAxis to the OLD `hook.at > now`
  // comparison turns every one of these red, since none of these hook.at
  // values is ever later than `now`.
  //
  // Issue #221 fix round 3 — these use a pane verdict of `idle` (agreeing
  // with the hook), not `working` as before: after round 3's asymmetry fix,
  // an `idle` hook can never win over a `working` pane verdict regardless of
  // timestamp, so exercising that combination here would test the round 3
  // guard instead of `hookWinsAxis`'s own timing logic, which is what these
  // cases are actually about (the hook and pane agreeing, but the hook still
  // winning the `source`/`since` precision, per `nextActivity`'s own
  // "Evaluated and DECLINED" doc comment above). The MED bug scenario itself
  // (hook `idle`, pane `working`) has its own dedicated tests below.
  describe("realistic (past, whole-second) hook timestamps still win when newer than the last look", () => {
    const PREV_OBSERVED = "2026-09-25T12:00:00.000Z";

    it("(a) a hook timestamp 12 seconds in the past relative to when it's read", () => {
      const prev = nextActivity(null, { kind: "working" }, null, null, new Date(PREV_OBSERVED));
      const readAt = new Date("2026-09-25T12:00:30.000Z"); // 30s tick later
      const hook: HookHeartbeat = { state: "idle", at: "2026-09-25T12:00:18.000Z" }; // 12s before readAt
      const result = nextActivity(prev, { kind: "idle" }, null, null, readAt, hook);
      expect(result.state).toBe("idle");
      expect(result.source).toBe("hook");
      expect(result.since).toBe("2026-09-25T12:00:18.000Z");
    });

    it("(b) a hook timestamp in the SAME SECOND as `now` (whole-second truncation edge case)", () => {
      const prev = nextActivity(null, { kind: "working" }, null, null, new Date(PREV_OBSERVED));
      const readAt = new Date("2026-09-25T12:00:30.900Z"); // same second as the hook, later ms
      const hook: HookHeartbeat = { state: "idle", at: "2026-09-25T12:00:30.000Z" };
      const result = nextActivity(prev, { kind: "idle" }, null, null, readAt, hook);
      expect(result.state).toBe("idle");
      expect(result.source).toBe("hook");
    });

    it("(c) a hook timestamp stamped DURING what would be the exec's own round trip", () => {
      // The exec is issued at 12:00:30, the hook fires mid-flight at
      // 12:00:35, and the Worker's own `now` is only read at 12:00:42 once
      // the whole round trip (including the hook read) has returned — the
      // exact shape the review measured in `applyActivityVerdict`.
      const prev = nextActivity(null, { kind: "working" }, null, null, new Date("2026-09-25T12:00:30.000Z"));
      const readAt = new Date("2026-09-25T12:00:42.000Z");
      const hook: HookHeartbeat = { state: "idle", at: "2026-09-25T12:00:35.000Z" };
      const result = nextActivity(prev, { kind: "idle" }, null, null, readAt, hook);
      expect(result.state).toBe("idle");
      expect(result.source).toBe("hook");
      expect(result.since).toBe("2026-09-25T12:00:35.000Z");
    });
  });

  // Issue #221 fix round 2 — the staleness budget (HOOK_STALE_BUDGET_MS,
  // activity.ts) closes the gap a pure "newer than last look" comparison
  // cannot: a lead killed mid-turn leaves a stale hook stamp, and if ship
  // ticks themselves pause for a while (a stopped studio, a held operation
  // lock) `prev.observedAt` freezes right along with the gap — so once
  // ticking resumes, a stale hook could otherwise still read as "newer
  // than last look" despite being minutes old in real terms.
  it("a hook older than the staleness budget never wins, even when it IS newer than a frozen prev.observedAt", () => {
    // Ticking paused for a long gap: prev.observedAt is old.
    const prev = nextActivity(null, { kind: "working" }, null, null, new Date("2026-09-25T12:00:00.000Z"));
    // Ticking resumes 20 minutes later. The hook fired 10 minutes ago —
    // newer than prev.observedAt, but 600s old, well past the 90s budget.
    const readAt = new Date("2026-09-25T12:20:00.000Z");
    const hook: HookHeartbeat = { state: "idle", at: "2026-09-25T12:10:00.000Z" };
    const result = nextActivity(prev, { kind: "working" }, null, null, readAt, hook);
    expect(result.state).toBe("working"); // the pane's own verdict, not the stale hook
    expect(result.source).toBe("pane");
  });

  // Issue #221 fix round 3 — pane verdict `idle` here too (see the note on
  // the "realistic ..." describe block above): this proves the staleness
  // BUDGET boundary on its own, independent of the round 3 asymmetry guard.
  it("a hook just inside the staleness budget still wins", () => {
    const prev = nextActivity(null, { kind: "working" }, null, null, new Date("2026-09-25T12:00:00.000Z"));
    const readAt = new Date("2026-09-25T12:01:29.000Z"); // 89s after the hook
    const hook: HookHeartbeat = { state: "idle", at: "2026-09-25T12:00:00.500Z" };
    const result = nextActivity(prev, { kind: "idle" }, null, null, readAt, hook);
    expect(result.state).toBe("idle");
    expect(result.source).toBe("hook");
  });

  it("MUTANT PROOF (b): LIMIT is never overridden by a fresher, contradicting hook claim", () => {
    const limit = { until: "2026-09-25T13:00:00.000Z", seenAt: NOW.toISOString() };
    const hook: HookHeartbeat = { state: "working", at: FRESHER };
    const result = nextActivity(null, { kind: "idle" }, limit, null, NOW, hook);
    expect(result.state).toBe("limit");
    expect(result.source).toBe("pane");
  });

  it("MUTANT PROOF (b): WAITING MEMBERS is never overridden by a fresher, contradicting hook claim", () => {
    const hook: HookHeartbeat = { state: "working", at: FRESHER };
    const result = nextActivity(null, { kind: "waiting-members" }, null, null, NOW, hook);
    expect(result.state).toBe("waiting-members");
    expect(result.source).toBe("pane");
  });

  it("MUTANT PROOF (b): a fresh membersTickingAt is never overridden by a fresher, contradicting hook claim", () => {
    const hook: HookHeartbeat = { state: "working", at: FRESHER };
    const result = nextActivity(null, { kind: "idle" }, null, NOW.toISOString(), NOW, hook);
    expect(result.state).toBe("waiting-members");
    expect(result.source).toBe("pane");
  });

  it("a malformed hook state (bypassing parseHookHeartbeat's own whitelist, e.g. a hand-built object) never wins the axis either — defense in depth", () => {
    const hostile = { state: "limit", at: FRESHER } as unknown as HookHeartbeat;
    const result = nextActivity(null, { kind: "idle" }, null, null, NOW, hostile);
    expect(result.state).toBe("idle"); // the pane's own verdict, never "limit"
    expect(result.source).toBe("pane");
  });

  it("hook agreeing with the pane: state and since behave exactly as pane-only, source still reflects the winner", () => {
    const hook: HookHeartbeat = { state: "working", at: FRESHER };
    const result = nextActivity(null, { kind: "working" }, null, null, NOW, hook);
    expect(result.state).toBe("working");
    expect(result.source).toBe("hook");
    expect(result.since).toBe(FRESHER);
  });

  it("no hook argument at all (existing 5-arg call shape) behaves identically to before this task", () => {
    const result = nextActivity(null, { kind: "working" }, null, null, NOW);
    expect(result.state).toBe("working");
    expect(result.source).toBe("pane");
  });

  it("hook is null (section present, unparseable) behaves identically to hook being absent", () => {
    const result = nextActivity(null, { kind: "working" }, null, null, NOW, null);
    expect(result.state).toBe("working");
    expect(result.source).toBe("pane");
  });

  it("since holds across same-state ticks even when the hook keeps winning on freshness", () => {
    const hook1: HookHeartbeat = { state: "working", at: FRESHER };
    const first = nextActivity(null, { kind: "idle" }, null, null, NOW, hook1);
    expect(first.state).toBe("working");
    expect(first.since).toBe(FRESHER);
    const LATER = new Date("2026-09-25T12:00:30.000Z");
    const hook2: HookHeartbeat = { state: "working", at: "2026-09-25T12:00:30.500Z" };
    const second = nextActivity(first, { kind: "idle" }, null, null, LATER, hook2);
    expect(second.state).toBe("working");
    expect(second.since).toBe(FRESHER); // unchanged — same state, holds
  });
});

// ---------------------------------------------------------------------------
// Issue #221 fix round 3 (maestro review, PR #352, MED finding) — a `Stop`
// event does not mean the lead is genuinely done: gates/completion-gate.sh is
// ALSO registered on `Stop` and can exit 2, blocking the stop outright, with
// no new hook event ever firing to correct the record. activity-heartbeat.sh
// has therefore already written `idle`, stamped genuinely newer than the
// last look, before the block happens — a stale-but-fresher `idle` claim
// that must never beat THIS tick's own pane capture when that capture, taken
// AFTER the hook fired, plainly shows the lead's spinner still running. See
// `hookIdleOverruledByWorkingPane`'s own doc comment (activity.ts) for the
// full reasoning.
// ---------------------------------------------------------------------------
describe("nextActivity — round 3 MED fix: a hook `idle` claim never overrides a pane verdict of `working` this tick", () => {
  const NOW = new Date("2026-09-26T01:00:00.000Z");
  const PREV_OBSERVED = "2026-09-26T00:59:30.000Z"; // one tick before NOW

  // RED FIRST (per the task): this is the exact blocked-stop scenario —
  // hook `idle`, timestamped newer than prev.observedAt (so `hookWinsAxis`
  // itself would say yes), well within the staleness budget, but THIS
  // tick's own pane capture (taken after the hook fired) still reads
  // `working` (the spinner never actually stopped, because the stop was
  // blocked). Before this fix, the hook won and flipped the row to IDLE for
  // one tick; after this fix, the pane's own working verdict must stand.
  it("blocked-stop scenario: hook idle (fresher, in-budget) loses to a working pane verdict this tick", () => {
    const prev = nextActivity(null, { kind: "working" }, null, null, new Date(PREV_OBSERVED));
    expect(prev.observedAt).toBe(PREV_OBSERVED);

    const hook: HookHeartbeat = { state: "idle", at: "2026-09-26T00:59:45.000Z" }; // newer than prev, in budget
    const result = nextActivity(prev, { kind: "working" }, null, null, NOW, hook);

    expect(result.state).toBe("working");
    expect(result.source).toBe("pane");
  });

  // MUTANT PROOF (maestro's own explicit ask, round 3 item 1): removing the
  // `!hookIdleOverruledByWorkingPane(...)` guard from nextActivity's
  // hook-wins branch reverts to the old behaviour and turns this red again
  // (state would come back as "idle", source "hook").
  it("MUTANT PROOF: the guard, not mere staleness, is what blocks the hook here — a hook idle claim that is ALSO fresh enough to win on every other axis still loses to a working pane", () => {
    const hook: HookHeartbeat = { state: "idle", at: NOW.toISOString() }; // as fresh as it gets
    const result = nextActivity(null, { kind: "working" }, null, null, NOW, hook);
    expect(result.state).toBe("working");
    expect(result.source).toBe("pane");
  });

  // The UNCHANGED direction: a fresher hook `working` claim still overrides
  // a stale pane, exactly as before this fix — this asymmetry is
  // deliberate, not a blanket "hooks can never override the pane."
  it("unchanged direction: a fresher hook working claim still overrides a stale, contradicting idle pane verdict", () => {
    const prev = nextActivity(null, { kind: "idle" }, null, null, new Date(PREV_OBSERVED));
    const hook: HookHeartbeat = { state: "working", at: "2026-09-26T00:59:45.000Z" };
    const result = nextActivity(prev, { kind: "idle" }, null, null, NOW, hook);
    expect(result.state).toBe("working");
    expect(result.source).toBe("hook");
    expect(result.since).toBe("2026-09-26T00:59:45.000Z");
  });

  // The guard is narrowly scoped to hook-idle-vs-pane-working: a hook idle
  // claim still wins normally when the pane's own verdict is NOT working
  // (idle agreeing, or waiting-question) — this fix must not disable the
  // hook-idle path altogether, only the one specific contradiction.
  it("a hook idle claim still wins when the pane verdict is not working (idle, agreeing)", () => {
    const prev = nextActivity(null, { kind: "working" }, null, null, new Date(PREV_OBSERVED));
    const hook: HookHeartbeat = { state: "idle", at: "2026-09-26T00:59:45.000Z" };
    const result = nextActivity(prev, { kind: "idle" }, null, null, NOW, hook);
    expect(result.state).toBe("idle");
    expect(result.source).toBe("hook");
  });

  it("a hook idle claim still wins when the pane verdict is waiting-question, not working", () => {
    const prev = nextActivity(null, { kind: "working" }, null, null, new Date(PREV_OBSERVED));
    const hook: HookHeartbeat = { state: "idle", at: "2026-09-26T00:59:45.000Z" };
    const result = nextActivity(prev, { kind: "waiting-question" }, null, null, NOW, hook);
    expect(result.state).toBe("idle");
    expect(result.source).toBe("hook");
  });
});

// ---------------------------------------------------------------------------
// Issue #221 fix round 3, LOW (maestro review, PR #352) —
// gates/activity-heartbeat.sh's write_state now stamps millisecond
// precision (`%3N`) instead of the old whole-second truncation. The gap
// this closes: `hookWinsAxis` (activity.ts) compares `hook.at` against
// `prev.observedAt` — a real, full-millisecond `Date.now().toISOString()`
// reading from an EARLIER tick. A real hook event that fires LATER but
// within that SAME wall-clock second is genuinely newer, but the old
// whole-second truncation always floors away its fractional part — so its
// truncated `at` reads as EARLIER-OR-EQUAL to any full-precision
// `prev.observedAt` landing anywhere in that same second, and the event is
// wrongly treated as a stale tie, losing to the pane. Millisecond precision
// closes exactly this gap.
// ---------------------------------------------------------------------------
describe("nextActivity — round 3 LOW fix: millisecond-precision hook timestamps", () => {
  const PREV_OBSERVED = "2026-09-26T01:30:00.500Z"; // mid-second, a real tick's own full-ms clock reading
  const REAL_INSTANT = "2026-09-26T01:30:00.800Z"; // a genuinely LATER hook event, same wall-clock second

  it("a hook event later in the SAME second as prev.observedAt, stamped with millisecond precision, correctly wins", () => {
    const prev = nextActivity(null, { kind: "working" }, null, null, new Date(PREV_OBSERVED));
    expect(prev.observedAt).toBe(PREV_OBSERVED);

    // The real millisecond-precision stamp write_state now produces for
    // this same real instant. Pane verdict is `idle` (agreeing), not
    // `working` — this test isolates the timestamp-precision fix from
    // round 3's separate hook-idle-vs-working-pane asymmetry guard (see the
    // "round 3 MED fix" describe block above), which has its own dedicated
    // coverage.
    const hook: HookHeartbeat = { state: "idle", at: REAL_INSTANT };
    const result = nextActivity(prev, { kind: "idle" }, null, null, new Date("2026-09-26T01:30:30.000Z"), hook);
    expect(result.state).toBe("idle");
    expect(result.source).toBe("hook");
    expect(result.since).toBe(REAL_INSTANT);
  });

  // BEFORE/AFTER CONTRAST (not a code mutant — the fix is the shell script's
  // date FORMAT, not this function): the SAME real instant (REAL_INSTANT
  // above), stamped the OLD way (whole-second truncated, no `%3N`), always
  // floors to the START of its second — `2026-09-26T01:30:00.000Z` here,
  // regardless of which millisecond within that second it actually
  // occurred at. That floored value is `<= PREV_OBSERVED` (500ms into the
  // SAME second), so `hookWinsAxis` reads it as a stale tie and the event
  // is lost to the pane — this is the "same-second events lost" gap
  // millisecond precision (the test above) closes.
  it("BEFORE/AFTER: the SAME real instant, whole-second truncated as before round 3, is wrongly read as a stale tie and lost to the pane", () => {
    const prev = nextActivity(null, { kind: "working" }, null, null, new Date(PREV_OBSERVED));
    expect(prev.observedAt).toBe(PREV_OBSERVED);

    // Pane verdict `idle` (agreeing), same reasoning as the test above —
    // isolates the timestamp-truncation effect from round 3's separate
    // asymmetry guard, which would otherwise block this hook claim for an
    // unrelated reason (pane verdict `working`) and mask what this test is
    // actually pinning.
    const truncatedHook: HookHeartbeat = { state: "idle", at: "2026-09-26T01:30:00.000Z" }; // REAL_INSTANT, whole-second truncated
    const result = nextActivity(prev, { kind: "idle" }, null, null, new Date("2026-09-26T01:30:30.000Z"), truncatedHook);
    // The tie loses the tick to the PANE's own verdict — still `idle`
    // here (the pane agrees), but sourced from the pane, not the hook, and
    // without the hook's own precise `since` — the OLD, degraded outcome
    // this fix moves away from, pinned here only to prove the millisecond
    // fix (above) is what actually changes it.
    expect(result.state).toBe("idle");
    expect(result.source).toBe("pane");
    expect(result.since).not.toBe(REAL_INSTANT);
  });
});
