// apps/fleet/test/studio.survival-brief.test.ts
import { describe, it, expect } from "vitest";
import {
  composeSurvivalBrief, sanitizeBranch, RESUMED_TRUST_ORIGIN_LINE, type SurvivalInput,
} from "../src/studio/survival-brief";
import type { ObservedSession, RestoreOutcome } from "../src/studio/observed";

const NOW = "2026-09-24T14:00:00.000Z";
const CONTROL_CHAR_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

function baseInput(overrides: Partial<SurvivalInput> = {}): SurvivalInput {
  return {
    studioId: "demosite-life--release-studio",
    tasks: { ok: true, value: [] },
    openPrs: { ok: true, value: [] },
    unclaimedRescueBranches: { ok: true, value: [] },
    session: null,
    now: NOW,
    ...overrides,
  };
}

/** A resumed/restored session with nothing else notable -- the "everything
 *  fine" baseline every fixture below overrides from. */
function baseSession(overrides: Partial<ObservedSession> = {}): ObservedSession {
  return {
    verdict: "resumed",
    at: NOW,
    via: "recycle",
    restore: "restored",
    snapshotAgeS: null,
    turnsBefore: 0,
    reason: null,
    ...overrides,
  };
}

describe("composeSurvivalBrief basics (issue #107)", () => {
  it("everything checked and genuinely empty -> empty string", () => {
    expect(composeSurvivalBrief(baseInput())).toBe("");
  });

  it("a task branch with commits ahead is listed, age computed from lastCommitAt", () => {
    const input = baseInput({
      tasks: {
        ok: true,
        value: [{
          taskNumber: 796, taskTitle: "error surface", branch: "fix-796-t6-error-surface",
          commitsAheadOfMain: 3, lastCommitAt: "2026-09-24T13:54:00.000Z",
        }],
      },
    });
    expect(composeSurvivalBrief(input)).toBe(
      "What survived, demosite-life--release-studio:\n" +
      "- Task #796 \"error surface\": fix-796-t6-error-surface — 3 commits ahead of main, last 6m ago\n" +
      "- Open PRs: none\n" +
      "- Session: unknown (no bring-up verdict recorded)",
    );
  });

  it("singular commit word for exactly 1 commit ahead", () => {
    const input = baseInput({
      tasks: {
        ok: true,
        value: [{
          taskNumber: 1, taskTitle: "x", branch: "fix-1-x",
          commitsAheadOfMain: 1, lastCommitAt: "2026-09-24T13:59:00.000Z",
        }],
      },
    });
    expect(composeSurvivalBrief(input)).toContain("1 commit ahead of main");
  });

  it("multiple task branches sort by task number ascending, regardless of input order", () => {
    const input = baseInput({
      tasks: {
        ok: true,
        value: [
          { taskNumber: 90, taskTitle: "later", branch: "fix-90", commitsAheadOfMain: 1, lastCommitAt: "2026-09-24T13:59:00.000Z" },
          { taskNumber: 12, taskTitle: "earlier", branch: "fix-12", commitsAheadOfMain: 2, lastCommitAt: "2026-09-24T13:59:00.000Z" },
        ],
      },
    });
    const out = composeSurvivalBrief(input);
    expect(out.indexOf("#12")).toBeLessThan(out.indexOf("#90"));
  });

  it("open PRs are listed, sorted by number ascending, titles quote-wrapped like task titles", () => {
    const input = baseInput({
      openPrs: {
        ok: true,
        value: [
          { number: 121, title: "row tells the truth", branch: "worktree-row-tells-truth-85-pr1" },
          { number: 55, title: "earlier pr", branch: "fix-55" },
        ],
      },
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("- Open PR #55: \"earlier pr\" (fix-55)");
    expect(out).toContain("- Open PR #121: \"row tells the truth\" (worktree-row-tells-truth-85-pr1)");
    expect(out.indexOf("#55")).toBeLessThan(out.indexOf("#121"));
  });

  it("a known session snapshot age renders in the Session line, not the literal null", () => {
    const input = baseInput({ session: baseSession({ snapshotAgeS: 180 }) });
    expect(composeSurvivalBrief(input)).toBe(
      "What survived, demosite-life--release-studio:\n" +
      "- Task branches: none\n" +
      "- Open PRs: none\n" +
      "- Session: resumed · from snap 3m old\n" +
      // Issue #249 round-2 finding 1: a RESUMED lead is told its files were
      // replaced under a conversation it still remembers. See
      // RESUMED_TRUST_ORIGIN_LINE's own doc comment.
      "- Your conversation resumed; files were replaced — trust origin, not memory.",
    );
  });

  it("lastCommitAt null on a branch that DOES have commits ahead (e.g. the lookup failed) renders 'unknown', never crashes", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 5, taskTitle: "t", branch: "b", commitsAheadOfMain: 2, lastCommitAt: null }] },
    });
    expect(composeSurvivalBrief(input)).toContain("last unknown");
  });

  it("an unparseable lastCommitAt on a branch that DOES have commits ahead renders 'unknown', never a fabricated '0s ago'", () => {
    const input = baseInput({
      tasks: {
        ok: true,
        value: [{ taskNumber: 5, taskTitle: "t", branch: "b", commitsAheadOfMain: 2, lastCommitAt: "not-a-real-date" }],
      },
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("last unknown");
    expect(out).not.toContain("last 0s ago");
  });
});

describe("formatSurvivalAge boundaries via the Session line's 'from snap' suffix (issue #107 review)", () => {
  it("exact hour renders as 'from snap 1h old'", () => {
    const input = baseInput({ session: baseSession({ snapshotAgeS: 3600 }) });
    expect(composeSurvivalBrief(input)).toContain("- Session: resumed · from snap 1h old");
  });

  it("exact day renders as 'from snap 1d old'", () => {
    const input = baseInput({ session: baseSession({ snapshotAgeS: 86400 }) });
    expect(composeSurvivalBrief(input)).toContain("- Session: resumed · from snap 1d old");
  });

  it("non-exact-hour value (61 minutes) falls back to minutes, never rounds up to '1h'", () => {
    const input = baseInput({ session: baseSession({ snapshotAgeS: 3661 }) });
    expect(composeSurvivalBrief(input)).toContain("- Session: resumed · from snap 61m old");
  });

  it("25 hours (>=86400s, multiple of 3600 but not of 86400) falls through to the hours branch, not days", () => {
    const input = baseInput({ session: baseSession({ snapshotAgeS: 90000 }) });
    expect(composeSurvivalBrief(input)).toContain("- Session: resumed · from snap 25h old");
  });

  it("a negative snapshot age does not crash, clamps to 'from snap 0s old'", () => {
    const input = baseInput({ session: baseSession({ snapshotAgeS: -5 }) });
    expect(composeSurvivalBrief(input)).toContain("- Session: resumed · from snap 0s old");
  });
});

describe("Session line names the keeper when a restore used one (board #250/#286 follow-up, board #287 nit)", () => {
  // readiness-format.ts's own formatSession already distinguishes a
  // keeper-sourced restore ("from daily <date> snap N old") from a `latest`
  // restore ("from snap N old") -- see that file's own `from` variable. This
  // composer's `sessionLine` never picked up the same distinction: before
  // this fix, a keeper restore rendered byte-for-byte identically to a
  // `latest` restore, silently dropping a signal an operator reading the
  // survival brief (unlike the CLI table) has no other way to see.
  it("a keeper-sourced restore renders 'from <source> snap N old', naming the keeper", () => {
    const input = baseInput({
      session: baseSession({ snapshotAgeS: 13 * 24 * 60 * 60, snapshotSource: "daily 2026-09-10" }),
    });
    expect(composeSurvivalBrief(input)).toContain("- Session: resumed · from daily 2026-09-10 snap 13d old");
  });

  it("a latest restore (snapshotSource unset) is byte-for-byte unchanged: 'from snap N old', no source named", () => {
    const input = baseInput({ session: baseSession({ snapshotAgeS: 180 }) });
    expect(composeSurvivalBrief(input)).toContain("- Session: resumed · from snap 3m old");
  });
});

describe("session.snapshotAgeS non-finite falls back to the restore word, never renders NaN/Infinity (issue #107 review)", () => {
  it("NaN falls back to the restore word", () => {
    const out = composeSurvivalBrief(baseInput({ session: baseSession({ snapshotAgeS: NaN, restore: "restored" }) }));
    expect(out).toContain("- Session: resumed · restored");
    expect(out).not.toContain("NaN");
  });

  it("Infinity falls back to the restore word", () => {
    const out = composeSurvivalBrief(baseInput({ session: baseSession({ snapshotAgeS: Infinity, restore: "restored" }) }));
    expect(out).toContain("- Session: resumed · restored");
    expect(out).not.toContain("Infinity");
  });
});

// --- Issue #107 review: "cannot tell 'not checked' from 'nothing there'" ---

describe("(a) a failed section lookup never collapses to empty string", () => {
  it("tasks lookup failed -> '- Task branches: could not check (<reason>)'", () => {
    const input = baseInput({ tasks: { ok: false, reason: "github api timeout" } });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("- Task branches: could not check (github api timeout)");
  });

  it("open PR lookup failed -> '- Open PRs: could not check (<reason>)'", () => {
    const input = baseInput({ openPrs: { ok: false, reason: "rate limited" } });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("- Open PRs: could not check (rate limited)");
  });
});

describe("(b) a checked-but-genuinely-empty section renders explicitly, never blank", () => {
  it("no open PRs, but a task exists (so output is non-empty) -> '- Open PRs: none'", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: 1, lastCommitAt: null }] },
    });
    expect(composeSurvivalBrief(input)).toContain("- Open PRs: none");
  });

  it("no assigned tasks, but an open PR exists -> '- Task branches: none'", () => {
    const input = baseInput({
      openPrs: { ok: true, value: [{ number: 1, title: "t", branch: "b" }] },
    });
    expect(composeSurvivalBrief(input)).toContain("- Task branches: none");
  });
});

describe("(c) one line per assigned task, always, never drop a task -- 4 states", () => {
  it("commitsAheadOfMain > 0 -> current-style line", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: 4, lastCommitAt: null }] },
    });
    expect(composeSurvivalBrief(input)).toContain("4 commits ahead of main");
  });

  it("commitsAheadOfMain === 0 -> includes EMPTY and '0 commits ahead of main, nothing survived'", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: 0, lastCommitAt: null }] },
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("EMPTY");
    expect(out).toContain("0 commits ahead of main, nothing survived");
  });

  it("commitsAheadOfMain null -> 'commits ahead unknown'", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: null, lastCommitAt: null }] },
    });
    expect(composeSurvivalBrief(input)).toContain("commits ahead unknown");
  });

  it("commitsAheadOfMain NaN -> 'commits ahead unknown', never the literal 'NaN'", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: NaN, lastCommitAt: null }] },
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("commits ahead unknown");
    expect(out).not.toContain("NaN");
  });

  it("commitsAheadOfMain negative -> 'commits ahead unknown'", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: -3, lastCommitAt: null }] },
    });
    expect(composeSurvivalBrief(input)).toContain("commits ahead unknown");
  });

  it("branch === null -> 'no branch on origin'", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: null, commitsAheadOfMain: null, lastCommitAt: null }] },
    });
    expect(composeSurvivalBrief(input)).toContain("no branch on origin");
  });

  it("all 4 states present at once -- every task gets its own line, none dropped", () => {
    const input = baseInput({
      tasks: {
        ok: true,
        value: [
          { taskNumber: 1, taskTitle: "has commits", branch: "b1", commitsAheadOfMain: 2, lastCommitAt: null },
          { taskNumber: 2, taskTitle: "empty branch", branch: "b2", commitsAheadOfMain: 0, lastCommitAt: null },
          { taskNumber: 3, taskTitle: "unknown count", branch: "b3", commitsAheadOfMain: null, lastCommitAt: null },
          { taskNumber: 4, taskTitle: "no branch", branch: null, commitsAheadOfMain: null, lastCommitAt: null },
        ],
      },
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("#1");
    expect(out).toContain("#2");
    expect(out).toContain("#3");
    expect(out).toContain("#4");
    expect(out.split("\n").filter((l) => l.startsWith("- Task #")).length).toBe(4);
  });
});

describe("(e) free-text sanitization", () => {
  it("C0/C1 control chars in a task title become spaces", () => {
    const input = baseInput({
      tasks: {
        ok: true,
        value: [{ taskNumber: 1, taskTitle: `bad${String.fromCharCode(0x01)}title${String.fromCharCode(0x7f)}here`, branch: "b", commitsAheadOfMain: 1, lastCommitAt: null }],
      },
    });
    const out = composeSurvivalBrief(input);
    expect(CONTROL_CHAR_RE.test(out)).toBe(false);
    expect(out).toContain("bad title here");
  });

  it("whitespace is collapsed", () => {
    const input = baseInput({
      tasks: {
        ok: true,
        value: [{ taskNumber: 1, taskTitle: "many    spaces\n\nhere", branch: "b", commitsAheadOfMain: 1, lastCommitAt: null }],
      },
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("many spaces here");
  });

  it("a word-leading slash is stripped, not the whole word (a wrapped '/rate-limit-options' at row start)", () => {
    const input = baseInput({
      tasks: {
        ok: true,
        value: [{ taskNumber: 1, taskTitle: "/rate-limit-options", branch: "b", commitsAheadOfMain: 1, lastCommitAt: null }],
      },
    });
    const out = composeSurvivalBrief(input);
    expect(out).not.toContain("/rate-limit-options");
    expect(out).toContain("rate-limit-options");
  });

  it("free text is truncated to 60 chars plus an ellipsis", () => {
    const longTitle = "x".repeat(100);
    const input = baseInput({
      tasks: {
        ok: true,
        value: [{ taskNumber: 1, taskTitle: longTitle, branch: "b", commitsAheadOfMain: 1, lastCommitAt: null }],
      },
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain(`"${"x".repeat(60)}…"`);
    expect(out).not.toContain("x".repeat(61));
  });

  it("PR titles get the same quote-wrapping task titles already get", () => {
    const input = baseInput({
      openPrs: { ok: true, value: [{ number: 1, title: "fix the thing", branch: "b" }] },
    });
    expect(composeSurvivalBrief(input)).toContain("\"fix the thing\"");
  });
});

describe("(f) caps: at most 8 lines per section, then '- +N more'", () => {
  it("10 tasks -> 8 shown, then '- +2 more'", () => {
    const value = Array.from({ length: 10 }, (_, i) => ({
      taskNumber: i + 1, taskTitle: `t${i + 1}`, branch: `b${i + 1}`, commitsAheadOfMain: 1, lastCommitAt: null,
    }));
    const out = composeSurvivalBrief(baseInput({ tasks: { ok: true, value } }));
    expect(out.split("\n").filter((l) => l.startsWith("- Task #")).length).toBe(8);
    expect(out).toContain("- +2 more");
  });

  it("10 open PRs -> 8 shown, then '- +2 more'", () => {
    const value = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `pr${i + 1}`, branch: `b${i + 1}` }));
    const out = composeSurvivalBrief(baseInput({ openPrs: { ok: true, value } }));
    expect(out.split("\n").filter((l) => l.startsWith("- Open PR #")).length).toBe(8);
    expect(out).toContain("- +2 more");
  });

  it("stress: 40 tasks + 40 PRs, 256-char titles each -> total output <= 3000 chars", () => {
    const longTitle = "y".repeat(256);
    const tasks = Array.from({ length: 40 }, (_, i) => ({
      taskNumber: i + 1, taskTitle: longTitle, branch: `branch-${i + 1}`, commitsAheadOfMain: 5, lastCommitAt: null,
    }));
    const openPrs = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, title: longTitle, branch: `branch-${i + 1}` }));
    const out = composeSurvivalBrief(baseInput({
      tasks: { ok: true, value: tasks },
      openPrs: { ok: true, value: openPrs },
      session: baseSession({ snapshotAgeS: 120 }),
    }));
    expect(out.length).toBeLessThanOrEqual(3000);
  });
});

describe("(mutation safety) input arrays are never mutated -- .slice() before .sort()", () => {
  it("frozen tasks and openPrs arrays do not throw, and produce the same output as unfrozen equivalents", () => {
    const taskValues = [
      { taskNumber: 90, taskTitle: "later", branch: "fix-90", commitsAheadOfMain: 1, lastCommitAt: null },
      { taskNumber: 12, taskTitle: "earlier", branch: "fix-12", commitsAheadOfMain: 2, lastCommitAt: null },
    ];
    const prValues = [
      { number: 121, title: "later pr", branch: "b121" },
      { number: 55, title: "earlier pr", branch: "b55" },
    ];
    const unfrozenOut = composeSurvivalBrief(baseInput({
      tasks: { ok: true, value: taskValues.map((v) => ({ ...v })) },
      openPrs: { ok: true, value: prValues.map((v) => ({ ...v })) },
    }));

    const frozenTasks = Object.freeze(taskValues.map((v) => Object.freeze({ ...v })));
    const frozenPrs = Object.freeze(prValues.map((v) => Object.freeze({ ...v })));
    expect(() => {
      const out = composeSurvivalBrief(baseInput({
        tasks: { ok: true, value: frozenTasks as typeof taskValues },
        openPrs: { ok: true, value: frozenPrs as typeof prValues },
      }));
      expect(out).toBe(unfrozenOut);
    }).not.toThrow();
  });
});

describe("(h) full output invariants", () => {
  function complexInput(): SurvivalInput {
    return baseInput({
      tasks: {
        ok: true,
        value: [
          { taskNumber: 1, taskTitle: "/rate-limit-options wrapped", branch: "b1", commitsAheadOfMain: 3, lastCommitAt: "2026-09-24T13:54:00.000Z" },
          { taskNumber: 2, taskTitle: "zero", branch: "b2", commitsAheadOfMain: 0, lastCommitAt: null },
          { taskNumber: 3, taskTitle: "unknown", branch: "b3", commitsAheadOfMain: NaN, lastCommitAt: null },
          { taskNumber: 4, taskTitle: "gone", branch: null, commitsAheadOfMain: null, lastCommitAt: null },
        ],
      },
      openPrs: { ok: true, value: [{ number: 9, title: "/some-pr-title", branch: "b9" }] },
      session: baseSession({ snapshotAgeS: 300 }),
    });
  }

  it("starts with 'What survived'", () => {
    expect(composeSurvivalBrief(complexInput()).startsWith("What survived")).toBe(true);
  });

  it("ends with the Session line — and, for a RESUMED lead, the sentence that follows it", () => {
    // Issue #249 round-2 finding 1: the session line is still the last thing
    // the brief SAYS ABOUT THE STUDIO; the one line after it is an instruction
    // to the lead, and only a resumed conversation gets it.
    const out = composeSurvivalBrief(complexInput());
    const lines = out.split("\n");
    expect(lines.at(-2)).toBe("- Session: resumed · from snap 5m old");
    expect(lines.at(-1)).toBe(RESUMED_TRUST_ORIGIN_LINE);

    const fresh = composeSurvivalBrief({ ...complexInput(), session: baseSession({ verdict: "fresh", snapshotAgeS: 300 }) });
    expect(fresh.split("\n").at(-1)).toBe("- Session: fresh · from snap 5m old");
  });

  it("no token anywhere starts with '/'", () => {
    const out = composeSurvivalBrief(complexInput());
    for (const token of out.split(/\s+/)) {
      expect(token.startsWith("/")).toBe(false);
    }
  });

  it("no control character present except newline", () => {
    const out = composeSurvivalBrief(complexInput());
    expect(CONTROL_CHAR_RE.test(out)).toBe(false);
  });

  it("the literal strings 'NaN' and 'Infinity' never appear", () => {
    const out = composeSurvivalBrief(complexInput());
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("Infinity");
  });
});

describe("(i) empty string is returned ONLY when both sections are checked-and-empty and session is null", () => {
  it("tasks empty, PRs empty, session null -> ''", () => {
    expect(composeSurvivalBrief(baseInput())).toBe("");
  });

  it("a FAILED tasks check with everything else empty must NOT collapse to '' -- shows 'could not check'", () => {
    const out = composeSurvivalBrief(baseInput({ tasks: { ok: false, reason: "boom" } }));
    expect(out).not.toBe("");
    expect(out).toContain("could not check (boom)");
  });

  it("a FAILED openPrs check with everything else empty must NOT collapse to '' -- shows 'could not check'", () => {
    const out = composeSurvivalBrief(baseInput({ openPrs: { ok: false, reason: "boom" } }));
    expect(out).not.toBe("");
    expect(out).toContain("could not check (boom)");
  });

  it("a known (non-null) session with everything else empty must NOT collapse to ''", () => {
    const out = composeSurvivalBrief(baseInput({ session: baseSession() }));
    expect(out).not.toBe("");
  });
});

// --- Issue #107 re-review (board #107): PR1's real ObservedSession replaces
// the bare lastSnapshotAgeS field. Fixtures (a)-(g) below are the review's
// own worked examples, verbatim -- see this PR's own commit message / report
// for the composition rule they pin down. ---

describe("Session line composition (issue #107 re-review, fixtures a-e)", () => {
  it("(a) resumed + restore 'restored' + upper-bound snapshot age -> 'from snap' suffix wins, restore word suppressed, never 'ago'", () => {
    const input = baseInput({
      session: {
        verdict: "resumed", at: NOW, via: "recycle", restore: "restored",
        snapshotAgeS: 3660, snapshotAgeIsUpperBound: true, turnsBefore: 5, reason: null,
      },
    });
    const out = composeSurvivalBrief(input);
    const sessionLine = out.split("\n").find((l) => l.startsWith("- Session:"));
    expect(sessionLine).toBe("- Session: resumed · from snap ≤61m old");
    expect(sessionLine).not.toContain("ago");
  });

  it("(b) fresh + restore 'skip:no-snapshot' + no snapshot age -> restore word shown", () => {
    const input = baseInput({
      session: {
        verdict: "fresh", at: NOW, via: "provision", restore: "skip:no-snapshot",
        snapshotAgeS: null, turnsBefore: 0, reason: null,
      },
    });
    expect(composeSurvivalBrief(input)).toContain("- Session: fresh · no snapshot existed");
  });

  it("(c) lost + restore 'failed' -> BOTH 'had N turns' AND the restore word + reason", () => {
    const input = baseInput({
      session: {
        verdict: "lost", at: NOW, via: "restart", restore: "failed",
        snapshotAgeS: null, turnsBefore: 412, reason: "no --continue",
      },
    });
    expect(composeSurvivalBrief(input)).toContain("- Session: LOST · had 412 turns · restore failed (no --continue)");
  });

  it("(d) session null -> 'unknown (no bring-up verdict recorded)'", () => {
    const input = baseInput({
      openPrs: { ok: true, value: [{ number: 1, title: "t", branch: "b" }] },
      session: null,
    });
    expect(composeSurvivalBrief(input)).toContain(
      "- Session: unknown (no bring-up verdict recorded)",
    );
  });

  it("(d) verdict 'unknown' with a reason -> same base text plus the sanitized reason", () => {
    const input = baseInput({
      session: {
        verdict: "unknown", at: NOW, via: "heal", restore: "not-attempted",
        snapshotAgeS: null, turnsBefore: 0, reason: "no lead process found",
      },
    });
    expect(composeSurvivalBrief(input)).toContain(
      "- Session: unknown (no bring-up verdict recorded) — no lead process found",
    );
  });

  it("(c2, round 2 review finding 1) lost + snapshotAgeS known + reason set -> the age suffix wins but the reason is still appended, never silently dropped", () => {
    const input = baseInput({
      session: {
        verdict: "lost", at: NOW, via: "restart", restore: "restored",
        snapshotAgeS: 180, turnsBefore: 9, reason: "no --continue",
      },
    });
    expect(composeSurvivalBrief(input)).toContain(
      "- Session: LOST · had 9 turns · from snap 3m old (no --continue)",
    );
  });

  it("(e) fixtures a-d produce 4 distinct Session lines", () => {
    const lineFor = (session: ObservedSession | null): string | undefined =>
      composeSurvivalBrief(baseInput({
        openPrs: { ok: true, value: [{ number: 1, title: "t", branch: "b" }] },
        session,
      })).split("\n").find((l) => l.startsWith("- Session:"));
    const a = lineFor({
      verdict: "resumed", at: NOW, via: "recycle", restore: "restored",
      snapshotAgeS: 3660, snapshotAgeIsUpperBound: true, turnsBefore: 5, reason: null,
    });
    const b = lineFor({
      verdict: "fresh", at: NOW, via: "provision", restore: "skip:no-snapshot",
      snapshotAgeS: null, turnsBefore: 0, reason: null,
    });
    const c = lineFor({
      verdict: "lost", at: NOW, via: "restart", restore: "failed",
      snapshotAgeS: null, turnsBefore: 412, reason: "no --continue",
    });
    const d = lineFor(null);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("(e) snapshotAgeIsUpperBound false -> no '≤'", () => {
    const input = baseInput({
      session: {
        verdict: "resumed", at: NOW, via: "recycle", restore: "restored",
        snapshotAgeS: 3660, snapshotAgeIsUpperBound: false, turnsBefore: 0, reason: null,
      },
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("- Session: resumed · from snap 61m old");
    expect(out).not.toContain("≤");
  });

  it("(f) '' only when tasks ok+empty AND openPrs ok+empty AND session null", () => {
    expect(composeSurvivalBrief(baseInput())).toBe("");
    expect(composeSurvivalBrief(baseInput({ session: baseSession() }))).not.toBe("");
  });

  it("(f/h) the output always ends with the Session line, even with both other sections populated", () => {
    const input = baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: 1, lastCommitAt: null }] },
      openPrs: { ok: true, value: [{ number: 1, title: "t", branch: "b" }] },
      session: baseSession({ verdict: "fresh", restore: "skip:has-projects" }),
    });
    const out = composeSurvivalBrief(input);
    expect(out.split("\n").at(-1)).toBe("- Session: fresh · already had projects");
  });
});

describe("(g) close mutation gaps -- failure-reason sanitization and un-truncated branch names", () => {
  it("a tasks check failure reason with a newline and a leading '/rate-limit-options' is sanitized", () => {
    const out = composeSurvivalBrief(baseInput({
      tasks: { ok: false, reason: "boom\n/rate-limit-options happened" },
    }));
    expect(out).toContain("- Task branches: could not check (boom rate-limit-options happened)");
    expect(out).not.toContain("/rate-limit-options");
  });

  it("an openPrs check failure reason with a newline and a leading '/rate-limit-options' is sanitized", () => {
    const out = composeSurvivalBrief(baseInput({
      openPrs: { ok: false, reason: "boom\n/rate-limit-options happened" },
    }));
    expect(out).toContain("- Open PRs: could not check (boom rate-limit-options happened)");
    expect(out).not.toContain("/rate-limit-options");
  });

  it("(round 2 review finding 2) a branch name with a mid-string leading slash is stripped, matching sanitizeText, while still not being truncated even if long", () => {
    const branch = `weird/ /leading-slash-branch-${"b".repeat(70)}`;
    const out = composeSurvivalBrief(baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch, commitsAheadOfMain: 1, lastCommitAt: null }] },
    }));
    expect(out).not.toContain("weird/ /leading-slash-branch");
    expect(out).toContain(`weird/ leading-slash-branch-${"b".repeat(70)}`);
    expect(out).not.toContain("…");
  });

  it("a 70-char task branch name renders intact, never truncated with an ellipsis", () => {
    const branch = "b".repeat(70);
    const out = composeSurvivalBrief(baseInput({
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch, commitsAheadOfMain: 1, lastCommitAt: null }] },
    }));
    expect(out).toContain(branch);
    expect(out).not.toContain("…");
  });

  it("a 70-char open-PR branch name renders intact, never truncated with an ellipsis", () => {
    const branch = "c".repeat(70);
    const out = composeSurvivalBrief(baseInput({
      openPrs: { ok: true, value: [{ number: 1, title: "t", branch }] },
    }));
    expect(out).toContain(branch);
    expect(out).not.toContain("…");
  });
});

// --- Issue #107 round 4 review: mutants M31 and M32 SURVIVED against
// `sanitizeBranch`, i.e. deleting one of its two defenses left the whole
// round-3 suite green. Hand-tracing the unmutated function shows it already
// produces the right answer for both cases below -- the gap was never a bug in
// the function, only a hole in the fixtures: every existing branch fixture
// exercised at most ONE defense at a time.
//
//   M31 (the C0/C1 strip, `raw.replace(CONTROL_CHARS, " ")`): survived because
//        no branch fixture carried a control char at all -- the leading-slash
//        and 70-char fixtures are pure printable text.
//   M32 (the whitespace collapse, `.replace(/\s+/g, " ")`): survived because
//        no branch fixture carried a RUN of whitespace -- the one fixture with
//        a space ("weird/ /leading-slash-...") has exactly one, so collapsing
//        it is a no-op.
//
// The two pins below are the issue's own Output format, verbatim. Each is
// verified RED against its own mutation and green against the real function
// (the PR body carries the run): deleting the strip breaks the first, deleting
// the collapse breaks the second, and neither mutation breaks the other -- so
// the two together, and only together, close both mutants. ---

describe("(sanitizeBranch, round 4 mutants M31/M32)", () => {
  it("M31: ESC/BEL controls each become ONE space and the surrounding printable text survives untouched", () => {
    // `fix-1` ESC `[2J` ESC `x` BEL `y` -- an erase-screen escape plus a bell,
    // the shape parseGithubUrl's own percent-decoding (board/verify.ts) can
    // hand this composer from an agent-supplied branch name. The literal `[`,
    // `2`, `J`, `x` and `y` must all survive: this pins the strip AND the
    // surrounding text in combination, not either in isolation.
    expect(sanitizeBranch("fix-1[2Jxy")).toBe("fix-1 [2J x y");
  });

  it("M31: a C1 control (U+009B, the 8-bit CSI) is stripped exactly like a C0 one", () => {
    expect(sanitizeBranch("fix-12Jx")).toBe("fix-1 2Jx");
  });

  it("M32: a mixed run of whitespace -- two spaces, a tab, a space -- collapses to exactly one space", () => {
    expect(sanitizeBranch("a  \t b")).toBe("a b");
  });

  it("the two defenses compose: a tab-and-ESC run collapses to one space, not four", () => {
    expect(sanitizeBranch("a\t b")).toBe("a b");
  });

  it("both pins hold through the rendered task line, not only through the helper", () => {
    const out = composeSurvivalBrief(baseInput({
      tasks: {
        ok: true,
        value: [{
          taskNumber: 1, taskTitle: "t", branch: "fix-1[2Jxy",
          commitsAheadOfMain: 2, lastCommitAt: null,
        }],
      },
    }));
    expect(out).toContain("fix-1 [2J x y — 2 commits ahead of main");
    expect(CONTROL_CHAR_RE.test(out)).toBe(false);
  });

  it("both pins hold through the rendered open-PR line", () => {
    const out = composeSurvivalBrief(baseInput({
      openPrs: { ok: true, value: [{ number: 9, title: "t", branch: "a  \t b" }] },
    }));
    expect(out).toContain("- Open PR #9: \"t\" (a b)");
    expect(CONTROL_CHAR_RE.test(out)).toBe(false);
  });
});

// --- Issue #107 round 3 review: a reason that sanitizes down to EMPTY (raw
// "" or whitespace/control-chars-only) must be treated as if it were null --
// omitted entirely, never leaving a dangling separator or empty "()" behind.
// Three call sites in `sessionLine` are affected; each gets its own fixture
// below plus a "does the sanitize call actually bite here" pin. ---

function sessionLineOf(out: string): string | undefined {
  return out.split("\n").find((l) => l.startsWith("- Session:"));
}

const HOSTILE = "exec failed\n/rate-limit-options at /tmp/x";
const SAFE = "exec failed rate-limit-options at tmp/x";

describe("(bug fix, #107 round 3) a reason that sanitizes to empty is omitted, never a dangling separator", () => {
  it.each([
    ["empty string", ""],
    ["whitespace/control-chars-only", "\n\t "],
  ])("(a) verdict 'unknown', reason %s -> exactly the base text, no trailing ' — '", (_label, reason) => {
    const input = baseInput({
      session: {
        verdict: "unknown", at: NOW, via: "heal", restore: "not-attempted",
        snapshotAgeS: null, turnsBefore: 0, reason,
      },
    });
    const out = composeSurvivalBrief(input);
    expect(sessionLineOf(out)).toBe("- Session: unknown (no bring-up verdict recorded)");
  });

  it("(b) verdict 'lost', restore 'failed', empty reason -> restore word with no empty parens", () => {
    const input = baseInput({
      session: {
        verdict: "lost", at: NOW, via: "restart", restore: "failed",
        snapshotAgeS: null, turnsBefore: 2, reason: "",
      },
    });
    const out = composeSurvivalBrief(input);
    expect(sessionLineOf(out)).toBe("- Session: LOST · had 2 turns · restore failed");
  });

  it("(c) verdict 'lost', known snapshot age, whitespace-only reason -> age suffix with no empty parens", () => {
    const input = baseInput({
      session: {
        verdict: "lost", at: NOW, via: "restart", restore: "restored",
        snapshotAgeS: 180, turnsBefore: 2, reason: " ",
      },
    });
    const out = composeSurvivalBrief(input);
    expect(sessionLineOf(out)).toBe("- Session: LOST · had 2 turns · from snap 3m old");
  });
});

describe("(pin, #107 round 3) sanitizeText actually bites at each sessionLine call site", () => {
  it("(d) verdict 'unknown' with a hostile reason -> the unknown-branch's own sanitize call bites", () => {
    const input = baseInput({
      session: {
        verdict: "unknown", at: NOW, via: "heal", restore: "not-attempted",
        snapshotAgeS: null, turnsBefore: 0, reason: HOSTILE,
      },
    });
    const out = composeSurvivalBrief(input);
    expect(sessionLineOf(out)).toBe(`- Session: unknown (no bring-up verdict recorded) — ${SAFE}`);
  });

  it("(e) verdict 'lost', restore 'failed' with a hostile reason -> the restore-word branch's own sanitize call bites", () => {
    const input = baseInput({
      session: {
        verdict: "lost", at: NOW, via: "restart", restore: "failed",
        snapshotAgeS: null, turnsBefore: 3, reason: HOSTILE,
      },
    });
    const out = composeSurvivalBrief(input);
    expect(sessionLineOf(out)).toBe(`- Session: LOST · had 3 turns · restore failed (${SAFE})`);
  });

  it("(f) verdict 'lost', known snapshot age with a hostile reason -> the age branch's own sanitize call bites", () => {
    const input = baseInput({
      session: {
        verdict: "lost", at: NOW, via: "restart", restore: "restored",
        snapshotAgeS: 180, turnsBefore: 3, reason: HOSTILE,
      },
    });
    const out = composeSurvivalBrief(input);
    expect(sessionLineOf(out)).toBe(`- Session: LOST · had 3 turns · from snap 3m old (${SAFE})`);
  });
});

describe("(g, #107 round 3) all 5 RestoreOutcome words are pinned, including the previously-unpinned 'not-attempted'", () => {
  it.each<[RestoreOutcome, string]>([
    ["restored", "restored"],
    ["skip:no-snapshot", "no snapshot existed"],
    ["skip:has-projects", "already had projects"],
    ["failed", "restore failed"],
    ["not-attempted", "restore not attempted"],
  ])("restore '%s' -> word '%s'", (restore, word) => {
    const input = baseInput({
      session: {
        verdict: "resumed", at: NOW, via: "recycle", restore,
        snapshotAgeS: null, turnsBefore: 0, reason: null,
      },
    });
    const out = composeSurvivalBrief(input);
    expect(sessionLineOf(out)).toBe(`- Session: resumed · ${word}`);
  });
});

// ---------------------------------------------------------------------------
// Issue #249 round-2 review, FINDING 1 — the one extra sentence a RESUMED lead
// gets.
//
// The review asked whether a resumed conversation should be re-briefed at all
// and KEPT the approved spec: recycle/heal replace the filesystem whether or
// not the conversation resumes, so a resumed lead is exactly the one whose
// memory of its own working tree is now wrong. The sentence says so.
// ---------------------------------------------------------------------------

describe("(#249 round-2 finding 1) the resumed-conversation sentence", () => {
  /** Enough in the brief that it is never the genuinely-empty early return. */
  const withSession = (session: ObservedSession | null) =>
    composeSurvivalBrief(baseInput({ session, tasks: { ok: true, value: [] } }));

  it("a RESUMED session gets the sentence, immediately after its own session line", () => {
    const out = withSession(baseSession({ verdict: "resumed" }));
    expect(out).toContain(RESUMED_TRUST_ORIGIN_LINE);
    // Wording pinned verbatim: it is the review's own sentence, and it has to
    // say `trust origin` (the remote), not "trust the repo".
    expect(RESUMED_TRUST_ORIGIN_LINE)
      .toBe("- Your conversation resumed; files were replaced — trust origin, not memory.");
    const lines = out.split("\n");
    const session = lines.findIndex((l) => l.startsWith("- Session:"));
    expect(session).toBeGreaterThan(-1);
    expect(lines[session + 1]).toBe(RESUMED_TRUST_ORIGIN_LINE);
    // And it is the LAST line: nothing after it to dilute the instruction.
    expect(lines.at(-1)).toBe(RESUMED_TRUST_ORIGIN_LINE);
  });

  it("FRESH, LOST and unknown verdicts do NOT get it", () => {
    // A fresh lead has no memory to mistrust; a lost one already knows it lost
    // the thread (and its own line says so); unknown cannot honestly claim a
    // conversation resumed at all.
    for (const verdict of ["fresh", "lost", "unknown"] as const) {
      const out = withSession(baseSession({ verdict, turnsBefore: 2, reason: "no --continue" }));
      expect(out).not.toContain(RESUMED_TRUST_ORIGIN_LINE);
      expect(out).not.toContain("trust origin");
    }
  });

  it("no session record at all does NOT get it", () => {
    const out = composeSurvivalBrief(baseInput({
      session: null,
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: 1, lastCommitAt: NOW }] },
    }));
    expect(out).toContain("- Session: unknown (no bring-up verdict recorded)");
    expect(out).not.toContain(RESUMED_TRUST_ORIGIN_LINE);
  });

  it("it does not resurrect the genuinely-empty early return", () => {
    // A studio with nothing checked-and-found AND no session record composes to
    // the empty string, which the delivery reads as "nothing worth saying".
    // Appending a sentence unconditionally would have broken that.
    expect(composeSurvivalBrief(baseInput())).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Board issue #208, part 2 -- the WIP safety-net line. A BARE container heal
// (do.ts's `BARE_SELF_HEALED` path, `session.via === "heal"`) restarted from a
// blank disk; this is the one sentence telling a resumed lead that a periodic
// snapshot ref exists and how old it was at heal time.
// ---------------------------------------------------------------------------

describe("(#208 part 2) the WIP safety-net line", () => {
  const WIP_NOW = "2026-10-03T12:00:00.000Z";

  it("via 'heal' + wipSyncedAt set -> names the ref and the age", () => {
    const out = composeSurvivalBrief(baseInput({
      session: baseSession({ via: "heal" }),
      wipSyncedAt: "2026-10-03T11:56:00.000Z",
      now: WIP_NOW,
    }));
    expect(out).toContain(
      "- WIP safety net: fleet/rescue/demosite-life--release-studio/wip/*, last synced 4m ago — check it for anything lost since then.",
    );
  });

  it("is the LAST line when the session is not 'resumed' (no RESUMED_TRUST_ORIGIN_LINE after it)", () => {
    const out = composeSurvivalBrief(baseInput({
      session: baseSession({ via: "heal", verdict: "fresh", restore: "skip:no-snapshot" }),
      wipSyncedAt: "2026-10-03T11:56:00.000Z",
      now: WIP_NOW,
    }));
    expect(out.split("\n").at(-1)).toContain("WIP safety net");
  });

  it("comes AFTER RESUMED_TRUST_ORIGIN_LINE when both apply", () => {
    const out = composeSurvivalBrief(baseInput({
      session: baseSession({ via: "heal", verdict: "resumed" }),
      wipSyncedAt: "2026-10-03T11:56:00.000Z",
      now: WIP_NOW,
    }));
    const lines = out.split("\n");
    expect(lines.at(-2)).toBe(RESUMED_TRUST_ORIGIN_LINE);
    expect(lines.at(-1)).toContain("WIP safety net");
  });

  it("any OTHER via -- never rendered, even with wipSyncedAt set", () => {
    for (const via of ["recycle", "restart", "provision", "failover", "adopted"] as const) {
      const out = composeSurvivalBrief(baseInput({
        session: baseSession({ via }),
        wipSyncedAt: "2026-10-03T11:56:00.000Z",
        now: WIP_NOW,
      }));
      expect(out).not.toContain("WIP safety net");
    }
  });

  it("via 'heal' but wipSyncedAt absent/null -- no WIP sync had ever landed, nothing to say", () => {
    const out = composeSurvivalBrief(baseInput({
      session: baseSession({ via: "heal" }),
      wipSyncedAt: null,
      now: WIP_NOW,
    }));
    expect(out).not.toContain("WIP safety net");
  });

  it("no session at all -- never rendered regardless of wipSyncedAt", () => {
    const out = composeSurvivalBrief(baseInput({
      session: null,
      wipSyncedAt: "2026-10-03T11:56:00.000Z",
      now: WIP_NOW,
      tasks: { ok: true, value: [{ taskNumber: 1, taskTitle: "t", branch: "b", commitsAheadOfMain: 1, lastCommitAt: null }] },
    }));
    expect(out).not.toContain("WIP safety net");
  });

  // Fix round (#208 PR #215 review, minor (c)): round-2 review's own traced
  // gap -- `via === "heal"` alone missed a bring-up that detected a
  // replacement under a DIFFERENT via (restart/provision/recycle landing
  // right after Observed.replacedAt was already set).
  it("replacementDetected true, via NOT 'heal' -- the line still renders (the gate is an OR, not just via === heal)", () => {
    for (const via of ["recycle", "restart", "provision"] as const) {
      const out = composeSurvivalBrief(baseInput({
        session: baseSession({ via, replacementDetected: true }),
        wipSyncedAt: "2026-10-03T11:56:00.000Z",
        now: WIP_NOW,
      }));
      expect(out).toContain("WIP safety net");
    }
  });

  it("replacementDetected false/absent AND via NOT 'heal' -- still never rendered (the OR does not become an always-on)", () => {
    const out = composeSurvivalBrief(baseInput({
      session: baseSession({ via: "restart", replacementDetected: false }),
      wipSyncedAt: "2026-10-03T11:56:00.000Z",
      now: WIP_NOW,
    }));
    expect(out).not.toContain("WIP safety net");
  });
});
