// Issue #927 (S45-F14): this file is the COMPOSE half of the split of
// test/studio.survival-brief.test.ts — the composition basics, the Session-line
// age/keeper/non-finite boundaries, and the (a)/(b) section-lookup behaviors.
// The invariants half lives in test/studio.brief-invariants.test.ts; every
// it() below moved here verbatim in that split.

import { describe, it, expect } from "vitest";
import {
  composeSurvivalBrief, type SurvivalInput, type SurvivalWipRef,
} from "../src/studio/survival-brief";
import type { ObservedSession } from "../src/studio/observed";

const NOW = "2026-09-24T14:00:00.000Z";
const CONTROL_CHAR_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

function baseInput(overrides: Partial<SurvivalInput> = {}): SurvivalInput {
  return {
    studioId: "demosite-life--release-studio",
    tasks: { ok: true, value: [] },
    openPrs: { ok: true, value: [] },
    unclaimedRescueBranches: { ok: true, value: [] },
    liveWipRefs: { ok: true, value: [] },
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

  // Issue #241 item 1 — a checked-but-non-empty liveWipRefs must NOT be
  // swallowed by genuinelyEmpty, same as unclaimedRescueBranches already is.
  it("a non-empty liveWipRefs alone is enough to NOT collapse to empty string", () => {
    const out = composeSurvivalBrief(baseInput({
      liveWipRefs: {
        ok: true,
        value: [{ branch: "fleet/rescue/demosite-life--release-studio/wip/20261004120000", lastCommitAt: NOW }],
      },
    }));
    expect(out).not.toBe("");
    expect(out).toContain("- Live wip snapshot:");
  });

  // Issue #241 items 1+3 — the new "Live wip snapshot" line is distinct
  // wording from "Unclaimed rescue ref", and neither section absorbs or
  // replaces the other when both are present at once.
  it("liveWipRefs renders as its own 'Live wip snapshot' line, distinct from and alongside 'Unclaimed rescue ref'", () => {
    const out = composeSurvivalBrief(baseInput({
      unclaimedRescueBranches: { ok: true, value: ["fleet/rescue/demosite-life--release-studio-20260920120000"] },
      liveWipRefs: {
        ok: true,
        value: [{
          branch: "fleet/rescue/demosite-life--release-studio/wip/20261004120000",
          lastCommitAt: "2026-09-24T13:58:00.000Z",
        }],
      },
    }));
    expect(out).toContain(
      "- Unclaimed rescue ref: fleet/rescue/demosite-life--release-studio-20260920120000 (not attributed to any task)",
    );
    expect(out).toContain(
      "- Live wip snapshot: fleet/rescue/demosite-life--release-studio/wip/20261004120000 " +
      "(refreshed periodically while the studio was running, not attributed to any task, last commit 2m ago)",
    );
    // Neither line's wording is a substring of the other.
    const unclaimedLine = out.split("\n").find((l) => l.startsWith("- Unclaimed rescue ref:"))!;
    const liveWipLine = out.split("\n").find((l) => l.startsWith("- Live wip snapshot:"))!;
    expect(unclaimedLine).not.toBe(liveWipLine);
    expect(liveWipLine).not.toContain("Unclaimed");
    expect(unclaimedLine).not.toContain("Live wip snapshot");
  });

  // Maestro review round 1 on PR #245 (issue #241), MAJOR 2 -- a wip ref
  // whose age could not be resolved (compareAhead's own 404 for a
  // parentless shallow-clone snapshot, or a thrown lookup) is kept, never
  // dropped, and must render "age unknown" rather than silently omitting
  // any age at all or fabricating one.
  it("a liveWipRef with lastCommitAt: null renders 'age unknown', never a fabricated age", () => {
    const out = composeSurvivalBrief(baseInput({
      liveWipRefs: {
        ok: true,
        value: [{ branch: "fleet/rescue/demosite-life--release-studio/wip/20261004120000", lastCommitAt: null }],
      },
    }));
    expect(out).toContain(
      "- Live wip snapshot: fleet/rescue/demosite-life--release-studio/wip/20261004120000 " +
      "(refreshed periodically while the studio was running, not attributed to any task, age unknown)",
    );
  });

  // Maestro review round 1 on PR #245 (issue #241), MINOR 3 -- sorted
  // newest-boot-stamp-first before the MAX_LINES_PER_SECTION cap, so the
  // newest ref is never the one pushed into "+N more".
  it("liveWipRefs are sorted newest-boot-stamp-first before the per-section cap, so the newest never falls into '+N more'", () => {
    const stamps = Array.from({ length: 9 }, (_, i) => `202610040000${String(10 + i).padStart(2, "0")}`);
    const prefix = "fleet/rescue/demosite-life--release-studio/wip/";
    const value: SurvivalWipRef[] = stamps.map((s) => ({ branch: `${prefix}${s}`, lastCommitAt: NOW }));
    const out = composeSurvivalBrief(baseInput({ liveWipRefs: { ok: true, value } }));
    const lines = out.split("\n").filter((l) => l.startsWith("- Live wip snapshot:"));
    expect(lines).toHaveLength(8);
    // The newest stamp (last in the ascending list) must be rendered, not
    // the oldest.
    expect(out).toContain(`${prefix}${stamps[stamps.length - 1]}`);
    expect(out).not.toContain(`${prefix}${stamps[0]}`);
    expect(out).toContain("- +1 more");
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

  it("rescue-ref lookup failed -> '- Rescue refs: could not check (<reason>)'", () => {
    const input = baseInput({ unclaimedRescueBranches: { ok: false, reason: "git ls-remote timeout" } });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("- Rescue refs: could not check (git ls-remote timeout)");
  });

  // Issue #241 item 1 — `liveWipRefs` follows the identical Checked<T>
  // "could not check" discipline as every other section above.
  it("live-wip-ref lookup failed -> '- Live wip snapshots: could not check (<reason>)'", () => {
    const input = baseInput({ liveWipRefs: { ok: false, reason: "git ls-remote timeout" } });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("- Live wip snapshots: could not check (git ls-remote timeout)");
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

