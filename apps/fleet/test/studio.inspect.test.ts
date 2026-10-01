// Board issue #47 — the read-only inspect path. Same test shape and same
// reasoning `test/studio.wake.test.ts`'s `runGatedWake` describe block
// already uses for the sibling "gate before touching the container" feature:
// pure command-string assertions for `inspectCmd`, and a fake
// `{recordedState, exec}` deps object (no live DO, no live tmux — that is
// test/bun/inspect-cmd.test.ts's job) for `runInspect`'s gating logic.
import { describe, it, expect, vi } from "vitest";
import {
  inspectCmd, parseInspectOutput, runInspect, INSPECT_DEFAULT_TAIL_LINES,
  INSPECT_EXEC_MS, CHECKOUT_PRESENT, CHECKOUT_MISSING, TAIL_BEGIN,
} from "../src/studio/inspect";
import { INCARNATION_PATH } from "../src/studio/observed";
import { BRINGUP_LOG_PATH } from "../src/studio/provision";

describe("inspectCmd — the command path a coordinator's inspect actually runs", () => {
  it("never attaches a tmux client and never sends a keystroke", () => {
    // The whole reason this feature exists (issue #47): `fleet attach`'s own
    // path runs `tmux attach`/`send-keys` (container/studio-shell.sh,
    // wake.ts's wakeCmd) — a real client joining the session and typed
    // input landing in the pane. This command must contain NEITHER, ever.
    const cmd = inspectCmd("websites");
    for (const forbidden of [
      "attach", "send-keys", "new-session", "new-window",
      "select-window", "select-pane", "switch-client", "kill-window", "kill-session",
    ]) {
      expect(cmd).not.toContain(forbidden);
    }
  });

  it("uses capture-pane -p — the read-only primitive that never creates a client", () => {
    const cmd = inspectCmd("websites");
    expect(cmd).toContain("tmux capture-pane -p -t studio:claude");
  });

  it("addresses the claude window by name, never by index — same target wake.ts and provision.ts read", () => {
    const cmd = inspectCmd("websites");
    // The literal, not the import — ties the test to the real emitted text.
    expect(cmd).toContain("-t studio:claude");
    expect(cmd).not.toContain("studio:0");
  });

  it("never calls the shell `exit` builtin — that kills the shared sandbox-default session, not the command", () => {
    // Same measured 2026-08-25 incident provision.ts's PROVISIONED_OK doc
    // comment records: a bare `exit 0/1` inside an sbExec command destroys
    // the exec transport instead of reporting a verdict.
    const cmd = inspectCmd("websites");
    expect(cmd).not.toMatch(/(^|[;&|]\s*)exit\b/);
  });

  it("checks the checkout with a plain -d test, no shell injection surface from the repo segment", () => {
    const cmd = inspectCmd("websites");
    expect(cmd).toContain("if [ -d /workspace/websites/.git ]");
    expect(cmd).toContain(CHECKOUT_PRESENT);
    expect(cmd).toContain(CHECKOUT_MISSING);
  });

  it("defaults the tail length and accepts an override", () => {
    expect(inspectCmd("websites")).toContain(`-S -${INSPECT_DEFAULT_TAIL_LINES}`);
    expect(inspectCmd("websites", 200)).toContain("-S -200");
  });

  it("falls back to the default for a non-finite or non-positive tail length rather than emitting garbage into the command", () => {
    expect(inspectCmd("websites", 0)).toContain(`-S -${INSPECT_DEFAULT_TAIL_LINES}`);
    expect(inspectCmd("websites", -5)).toContain(`-S -${INSPECT_DEFAULT_TAIL_LINES}`);
    expect(inspectCmd("websites", Number.NaN)).toContain(`-S -${INSPECT_DEFAULT_TAIL_LINES}`);
  });

  it("ends with the tail sentinel followed immediately by the raw capture-pane call — nothing parses the tail further", () => {
    const cmd = inspectCmd("websites");
    expect(cmd.trim().endsWith("tmux capture-pane -p -t studio:claude -S -60 2>/dev/null || true")).toBe(true);
    expect(cmd).toContain(`echo ${TAIL_BEGIN}`);
  });
});

describe("parseInspectOutput — the parser side of inspectCmd's own contract", () => {
  it("reads a healthy claude pane", () => {
    const stdout =
      `${CHECKOUT_PRESENT}\nFLEET_INSPECT_PANE:claude\n${TAIL_BEGIN}\n` +
      "some prior turn\nmore output\n";
    const snap = parseInspectOutput(stdout);
    expect(snap.checkoutExists).toBe(true);
    expect(snap.paneCommand).toBe("claude");
    expect(snap.tail).toBe("some prior turn\nmore output\n");
  });

  it("reads a dead pane (bash, not claude) with no checkout", () => {
    const stdout = `${CHECKOUT_MISSING}\nFLEET_INSPECT_PANE:bash\n${TAIL_BEGIN}\nroot@cloudchamber:/workspace#\n`;
    const snap = parseInspectOutput(stdout);
    expect(snap.checkoutExists).toBe(false);
    expect(snap.paneCommand).toBe("bash");
  });

  it("reads a MISSING studio:claude window as paneCommand null — same tmux 3.2a fallback PANE_PROBE_CMD guards", () => {
    const stdout = `${CHECKOUT_PRESENT}\nFLEET_INSPECT_PANE:none\n${TAIL_BEGIN}\n`;
    expect(parseInspectOutput(stdout).paneCommand).toBeNull();
  });

  it("degrades empty/malformed stdout to the least-informative honest reading, never throws", () => {
    expect(() => parseInspectOutput("")).not.toThrow();
    const snap = parseInspectOutput("");
    expect(snap).toEqual({
      checkoutExists: false, paneCommand: null, incarnationPresent: false, bringupLogTail: "", tail: "",
      capturedAt: null,
    });
  });

  it("preserves tail content verbatim, including text that happens to look like a sentinel", () => {
    const stdout = `${CHECKOUT_PRESENT}\nFLEET_INSPECT_PANE:claude\n${TAIL_BEGIN}\nFLEET_INSPECT_PANE:not-a-real-line\n`;
    expect(parseInspectOutput(stdout).tail).toBe("FLEET_INSPECT_PANE:not-a-real-line\n");
  });
});

// #151: a tail with no capture time let two coordinators read a frozen
// screen as live. The time comes from the container's own clock, in the SAME
// exec as capture-pane, so it dates exactly what was captured.
describe("inspect frame age (#151)", () => {
  it("stamps the capture time with date -u +%s in the same command, right before the tail", () => {
    const cmd = inspectCmd("websites");
    const stamp = cmd.indexOf("FLEET_INSPECT_CAPTURED_AT:$(date -u +%s)");
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(cmd.indexOf(`echo ${TAIL_BEGIN}`));
    expect(cmd.indexOf(`echo ${TAIL_BEGIN}`)).toBeLessThan(cmd.indexOf("capture-pane"));
  });

  it("parses the capture time as epoch seconds", () => {
    const stdout = `${CHECKOUT_PRESENT}\nFLEET_INSPECT_PANE:claude\nFLEET_INSPECT_CAPTURED_AT:1790270000\n${TAIL_BEGIN}\nx\n`;
    expect(parseInspectOutput(stdout).capturedAt).toBe(1790270000);
  });

  it("reads a missing or garbled capture time as null, never a guess", () => {
    expect(parseInspectOutput(`${CHECKOUT_PRESENT}\n${TAIL_BEGIN}\nx\n`).capturedAt).toBeNull();
    expect(parseInspectOutput(`FLEET_INSPECT_CAPTURED_AT:soon\n${TAIL_BEGIN}\n`).capturedAt).toBeNull();
  });

  it("a capture-time-shaped line INSIDE the tail is tail content, not the stamp", () => {
    const stdout = `${CHECKOUT_PRESENT}\n${TAIL_BEGIN}\nFLEET_INSPECT_CAPTURED_AT:1\n`;
    expect(parseInspectOutput(stdout).capturedAt).toBeNull();
  });
});

describe("runInspect — the gates an inspect passes before touching the container", () => {
  const ok = { code: 0, stdout: `${CHECKOUT_PRESENT}\nFLEET_INSPECT_PANE:claude\n${TAIL_BEGIN}\nhi\n`, stderr: "" };

  it("refuses a STOPPED studio without calling exec at all", async () => {
    // sbExec STARTS a container that is not running — the same fact
    // runGatedWake's GATE 1 states. An inspect that resurrected a studio the
    // operator deliberately shut down would spend money silently just to
    // look at it.
    const exec = vi.fn(async () => ok);
    const outcome = await runInspect({ recordedState: async () => "stopped", exec }, "websites");
    expect(exec).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      ok: false,
      error: expect.stringContaining("stopped"),
    });
  });

  it("refuses a studio with no recorded status — inspect must never create a container", async () => {
    const exec = vi.fn(async () => ok);
    const outcome = await runInspect({ recordedState: async () => null, exec }, "websites");
    expect(exec).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("never provisioned");
  });

  it("proceeds for a running studio and hands exec the exact command inspectCmd builds", async () => {
    const sent: string[] = [];
    const exec = vi.fn(async (cmd: string) => { sent.push(cmd); return ok; });
    const outcome = await runInspect({ recordedState: async () => "running", exec }, "websites");
    expect(sent).toEqual([inspectCmd("websites")]);
    expect(outcome).toEqual({
      ok: true,
      snapshot: {
        checkoutExists: true, paneCommand: "claude", incarnationPresent: false, bringupLogTail: "", tail: "hi\n",
        capturedAt: null,
      },
    });
  });

  it("also proceeds for degraded and provisioning studios — only STOPPED and never-provisioned refuse", async () => {
    const exec = vi.fn(async () => ok);
    for (const state of ["degraded", "provisioning"]) {
      exec.mockClear();
      const outcome = await runInspect({ recordedState: async () => state, exec }, "websites");
      expect(exec).toHaveBeenCalledTimes(1);
      expect(outcome.ok).toBe(true);
    }
  });

  it("turns a recordedState throw into a refusal, never propagates", async () => {
    const exec = vi.fn(async () => ok);
    const outcome = await runInspect(
      { recordedState: async () => { throw new Error("DO storage unreachable"); }, exec }, "websites",
    );
    expect(exec).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, error: "DO storage unreachable" });
  });

  it("turns an exec throw into a refusal, never propagates", async () => {
    const exec = vi.fn(async () => { throw new Error("container unreachable"); });
    const outcome = await runInspect({ recordedState: async () => "running", exec }, "websites");
    expect(outcome).toEqual({ ok: false, error: "container unreachable" });
  });

  it("fails fast when the container never answers, and names the container as the side that failed (#91)", async () => {
    // Measured 2026-09-24: the exec had no deadline, so a wedged container
    // held the DO call for minutes (737s, 182s, 50s in this Worker's own
    // analytics) until the platform failed it — surfacing as a Cloudflare
    // 500 page, then a hang past the caller's own 600s timeout.
    vi.useFakeTimers();
    try {
      const exec = vi.fn(() => new Promise<never>(() => {}));
      const pending = runInspect({ recordedState: async () => "running", exec }, "websites");
      await vi.advanceTimersByTimeAsync(INSPECT_EXEC_MS);
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain("container did not answer");
        expect(outcome.error).toContain(`${INSPECT_EXEC_MS / 1000}s`);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("#96: a wedged container keeps #91's line VERBATIM and appends the price of a recycle", async () => {
    // Measured 2026-09-24: a coordinator read "only the container side failed"
    // as permission and recycled a live lead, discarding ~63 min.
    vi.useFakeTimers();
    try {
      const exec = vi.fn(() => new Promise<never>(() => {}));
      const pending = runInspect({
        recordedState: async () => "running", exec,
        lastSyncedAt: async () => new Date("2026-09-24T11:12:00.000Z"),
        now: () => new Date("2026-09-24T12:15:00.000Z"),
      }, "websites");
      await vi.advanceTimersByTimeAsync(INSPECT_EXEC_MS);
      const outcome = await pending;
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.error).toContain(
        "The Worker and Durable Object are fine; only the container side failed. " +
          "The LEAD MAY STILL BE WORKING — a recycle restores the last synced snapshot (1h 3m old) " +
          "and discards everything since.",
      );
      expect(outcome.error).toContain("No commits is NOT evidence of death");
    } finally {
      vi.useRealTimers();
    }
  });

  it("#96: a failing snapshot lookup still names the price, with the age unknown", async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn(() => new Promise<never>(() => {}));
      const pending = runInspect({
        recordedState: async () => "running", exec,
        lastSyncedAt: async () => { throw new Error("R2 down"); },
        now: () => new Date("2026-09-24T12:15:00.000Z"),
      }, "websites");
      await vi.advanceTimersByTimeAsync(INSPECT_EXEC_MS);
      const outcome = await pending;
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.error).toContain("only the container side failed.");
      expect(outcome.error).toContain("The LEAD MAY STILL BE WORKING");
      expect(outcome.error).toContain("age unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the deadline well under any caller's patience — a read-only look must not cost minutes", () => {
    expect(INSPECT_EXEC_MS).toBeLessThanOrEqual(20_000);
  });

  it("passes a caller-supplied tail length straight through to inspectCmd", async () => {
    const sent: string[] = [];
    const exec = vi.fn(async (cmd: string) => { sent.push(cmd); return ok; });
    await runInspect({ recordedState: async () => "running", exec }, "websites", 250);
    expect(sent).toEqual([inspectCmd("websites", 250)]);
  });
});

describe("inspectCmd / parseInspectOutput — incarnation + bringup log (issue #85)", () => {
  it("inspectCmd's command reads the incarnation file and the bringup log tail, both before TAIL_BEGIN's pane capture, newline-safe (maestro correction #2)", () => {
    const cmd = inspectCmd("acme-os");
    const incarnationIdx = cmd.indexOf(INCARNATION_PATH);
    const logIdx = cmd.indexOf(BRINGUP_LOG_PATH);
    const tailBeginIdx = cmd.indexOf("TAIL_BEGIN");
    expect(incarnationIdx).toBeGreaterThan(0);
    expect(logIdx).toBeGreaterThan(0);
    expect(incarnationIdx).toBeLessThan(tailBeginIdx);
    expect(logIdx).toBeLessThan(tailBeginIdx);
    expect(cmd).not.toMatch(new RegExp(`cat ${INCARNATION_PATH}[^)]*\\|\\| echo`));
  });

  it("parseInspectOutput: incarnation present, bringup log tail captured, pane tail still parses correctly", () => {
    const stdout = [
      CHECKOUT_PRESENT,
      "FLEET_INSPECT_PANE:claude",
      "FLEET_INSPECT_INCARNATION",
      "abc-123-token",
      "FLEET_INSPECT_BRINGUP_LOG",
      "step-ok clone",
      "step-ok bring-up",
      TAIL_BEGIN,
      "⏺ working on something",
    ].join("\n");
    const snapshot = parseInspectOutput(stdout);
    expect(snapshot.incarnationPresent).toBe(true);
    expect(snapshot.bringupLogTail).toBe("step-ok clone\nstep-ok bring-up");
    expect(snapshot.tail).toBe("⏺ working on something");
    expect(snapshot.checkoutExists).toBe(true);
    expect(snapshot.paneCommand).toBe("claude");
  });

  it("parseInspectOutput: incarnation absent (empty line) reads MISSING", () => {
    const stdout = [
      CHECKOUT_MISSING, "FLEET_INSPECT_PANE:none",
      "FLEET_INSPECT_INCARNATION", "",
      "FLEET_INSPECT_BRINGUP_LOG", "",
      TAIL_BEGIN, "",
    ].join("\n");
    expect(parseInspectOutput(stdout).incarnationPresent).toBe(false);
  });
});
