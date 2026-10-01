import { describe, it, expect, vi } from "vitest";
import {
  checkQuiescence, nextStreak, shouldStop,
  type QuiescenceDeps,
} from "../src/studio/quiescence";
import type { EnvelopeDoc } from "../src/board/types";

function envelope(over: Partial<EnvelopeDoc["envelope"]>, payload: Partial<EnvelopeDoc["payload"]>): EnvelopeDoc {
  return {
    envelope: { msg_id: "m1", task_id: 1, sender: "websites--web-studio", intent: "result", schema_version: "1", ...over },
    payload: { status: "ok", artifacts: [], evidence: [], open_questions: [], context_digest: [], learnings: [], ...payload },
    notes: "",
  };
}

function deps(over: Partial<QuiescenceDeps> = {}): QuiescenceDeps {
  return {
    runningStudios: async () => [],
    openTasksFor: async () => [],
    openPulls: async () => [],
    latestEnvelope: async () => null,
    ...over,
  };
}

describe("checkQuiescence", () => {
  it("is quiescent when nothing runs, nothing is open, nothing is unfinished", async () => {
    expect(await checkQuiescence(deps())).toEqual({ quiescent: true });
  });

  it("is NOT quiescent while a board task is in flight on a running studio", async () => {
    const v = await checkQuiescence(deps({
      runningStudios: async () => ["websites--web-studio"],
      openTasksFor: async () => [131],
    }));
    expect(v.quiescent).toBe(false);
    expect(v.reason).toContain("websites--web-studio");
    expect(v.reason).toContain("131");
  });

  it("is NOT quiescent while a fleet PR is still open", async () => {
    const v = await checkQuiescence(deps({ openPulls: async () => [138, 139] }));
    expect(v.quiescent).toBe(false);
    expect(v.reason).toContain("#138");
  });

  it("is NOT quiescent while a running studio's last envelope is unfinished", async () => {
    const v = await checkQuiescence(deps({
      runningStudios: async () => ["websites--web-studio"],
      latestEnvelope: async () => envelope({ intent: "escalate" }, { status: "blocked" }),
    }));
    expect(v.quiescent).toBe(false);
    expect(v.reason).toContain("websites--web-studio");
  });

  it("counts a finished envelope as finished", async () => {
    const v = await checkQuiescence(deps({
      runningStudios: async () => ["websites--web-studio"],
      latestEnvelope: async () => envelope({ intent: "result" }, { status: "ok" }),
    }));
    expect(v).toEqual({ quiescent: true });
  });

  it("never asks a stopped studio for an envelope", async () => {
    // "every studio stopped, OR running with no unfinished envelope" — the
    // stopped arm is satisfied by the studio being stopped, full stop.
    const latestEnvelope = vi.fn(async () => null);
    await checkQuiescence(deps({ runningStudios: async () => [], latestEnvelope }));
    expect(latestEnvelope).not.toHaveBeenCalled();
  });

  /**
   * THE load-bearing test. Stopping the sweep is a GATE, and this branch
   * fails gates CLOSED: a check that cannot answer never means "done".
   * Its fail-OPEN sibling (task #118's assignedBriefResolver) collapses a
   * lookup failure into "nothing found", which here would stop supervision
   * of a fleet that is mid-flight because GitHub had a bad minute.
   */
  it("REFUSES quiescence when a check throws — fail-CLOSED", async () => {
    const v = await checkQuiescence(deps({
      openPulls: async () => { throw new Error("GitHub 503"); },
    }));
    expect(v.quiescent).toBe(false);
    expect(v.reason).toContain("GitHub 503");
    expect(v.reason?.toLowerCase()).toContain("check failed");
  });

  it("REFUSES quiescence when the studio listing itself throws", async () => {
    const v = await checkQuiescence(deps({
      runningStudios: async () => { throw new Error("D1 unavailable"); },
    }));
    expect(v.quiescent).toBe(false);
    expect(v.reason).toContain("D1 unavailable");
  });

  it("REFUSES quiescence when an envelope read throws, even with everything else clear", async () => {
    const v = await checkQuiescence(deps({
      runningStudios: async () => ["websites--web-studio"],
      latestEnvelope: async () => { throw new Error("comments 500"); },
    }));
    expect(v.quiescent).toBe(false);
    expect(v.reason).toContain("comments 500");
  });
});

describe("the two-consecutive-sweeps guard", () => {
  it("takes TWO consecutive quiescent sweeps to stop — one flaps", () => {
    const first = nextStreak(0, { quiescent: true });
    expect(shouldStop(first)).toBe(false);
    expect(shouldStop(nextStreak(first, { quiescent: true }))).toBe(true);
  });

  it("resets the streak on any non-quiescent sweep, including a failed check", () => {
    expect(nextStreak(1, { quiescent: false, reason: "PR #138 open" })).toBe(0);
    expect(nextStreak(1, { quiescent: false, reason: "check failed: GitHub 503" })).toBe(0);
  });
});
