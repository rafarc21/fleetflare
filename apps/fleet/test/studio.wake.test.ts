import { describe, it, expect, vi } from "vitest";
import {
  runWake, runGatedWake, wakeCmd, flattenPrompt, submitFragment, SUBMIT_HINT_TEXT,
  PANE_PROBE_CMD, PANE_SCREEN_CMD, WAKE_TARGET,
} from "../src/studio/wake";
import { withStudioTmux } from "../src/studio/tmux";

describe("runWake", () => {
  it("sends the emitted wake command through the container exec port", async () => {
    const sent: string[] = [];
    const exec = vi.fn(async (cmd: string) => { sent.push(cmd); return { code: 0, stdout: "", stderr: "" }; });
    const outcome = await runWake(exec, "WAKE sweep 3");
    expect(sent).toEqual([wakeCmd("WAKE sweep 3")]);
    expect(outcome).toEqual({ ok: true });
  });

  it("reports a non-zero exit as a failed wake, carrying tmux's own words", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "can't find window: studio:claude" }));
    const outcome = await runWake(exec, "WAKE sweep 3");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("can't find window");
  });

  it("turns an exec throw into a failed wake instead of propagating it", async () => {
    // The sweep's caller reschedules in `finally`, but a wake that throws
    // through the webhook path would 500 a delivery GitHub retries.
    const exec = vi.fn(async () => { throw new Error("container unreachable"); });
    const outcome = await runWake(exec, "WAKE sweep 3");
    expect(outcome).toEqual({ ok: false, error: "container unreachable" });
  });

  it("refuses an empty prompt without touching the container", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const outcome = await runWake(exec, "   \n  ");
    expect(exec).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("empty");
  });
});

describe("wakeCmd", () => {
  it("addresses the claude window by name, never by index", () => {
    expect(WAKE_TARGET).toBe("studio:claude");
    expect(wakeCmd("hi")).toContain("-t studio:claude");
    expect(wakeCmd("hi")).not.toContain("studio:0");
  });

  it("sends the text literally so a digest word is never read as a key name", () => {
    // Without -l, a digest containing "Enter" or "Space" sends a KEYSTROKE.
    expect(wakeCmd("press Enter")).toContain("send-keys -t studio:claude -l --");
  });

  it("chains typing, the gap and the re-check with && so a dead window fails the whole wake", () => {
    // Issue #136: the command is now a guarded script (scan, type, re-scan,
    // Enter), so `;` appears between its statements; the typing chain itself
    // still stops at the first failure. Proven end to end against a real
    // tmux in test/bun/wake-cmd.test.ts ("a missing target window fails").
    expect(wakeCmd("hi")).toContain("__ff_tmux send-keys -t studio:claude -l -- 'hi' && sleep 1 && {");
  });
});

describe("flattenPrompt", () => {
  it("collapses every newline: one wake is one turn", () => {
    expect(flattenPrompt("a\nb\r\n  c  ")).toBe("a b c");
  });
});

// Board issue #41, half one: the gates a task-assignment wake passes before a
// single keystroke reaches the container. `runWake` above stays exactly as it
// was — wakeMaestro's path is untouched — and this is a separate entry point
// that runs those gates first and then delegates to it.

describe("runGatedWake — the gates an assignment wake passes before typing", () => {
  /** What the probe prints for a healthy studio: the window tmux ACTUALLY
   *  answered about, then that pane's command. */
  const ok = { code: 0, stdout: "studio:claude claude\n", stderr: "" };

  it("refuses a STOPPED studio without touching the container at all", async () => {
    // sbExec STARTS a container that is not running. A wake that resurrected
    // a studio the operator deliberately shut down would spend money silently.
    const exec = vi.fn(async () => ok);
    const outcome = await runGatedWake({ recordedState: async () => "stopped", exec }, "WAKE TASK #42");
    expect(exec).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("stopped");
  });

  it("refuses a studio with no recorded status — a wake must never create a container", async () => {
    const exec = vi.fn(async () => ok);
    const outcome = await runGatedWake({ recordedState: async () => null, exec }, "WAKE TASK #42");
    expect(exec).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("never provisioned");
  });

  it("probes the pane with the SAME tmux signal the readiness check uses, before typing", async () => {
    const sent: string[] = [];
    const exec = vi.fn(async (cmd: string) => { sent.push(cmd); return ok; });
    await runGatedWake({ recordedState: async () => "running", exec }, "WAKE TASK #42");
    expect(sent[0]).toBe(PANE_PROBE_CMD);
    expect(PANE_PROBE_CMD).toContain("#{pane_current_command}");
    expect(PANE_PROBE_CMD).toContain(WAKE_TARGET);
  });

  it("asks tmux WHICH window it answered about, and refuses when that is not studio:claude", async () => {
    // MEASURED against tmux 3.2a: `display-message -p -t studio:claude` on a
    // server where that window does NOT exist silently answers about the
    // CURRENT pane and exits 0. Without this check a studio whose claude
    // window is gone reads as whatever its active window happens to run.
    const sent: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      sent.push(cmd);
      return { code: 0, stdout: "studio:shell claude\n", stderr: "" };
    });
    const outcome = await runGatedWake({ recordedState: async () => "running", exec }, "WAKE TASK #42");
    expect(sent).toEqual([PANE_PROBE_CMD]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("studio:shell");
  });

  it("refuses an unreadable probe answer rather than guessing what it meant", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "\n", stderr: "" }));
    const outcome = await runGatedWake({ recordedState: async () => "running", exec }, "WAKE TASK #42");
    expect(outcome.ok).toBe(false);
  });

  it("types the real wake command once the pane reads claude", async () => {
    const sent: string[] = [];
    const exec = vi.fn(async (cmd: string) => { sent.push(cmd); return ok; });
    const outcome = await runGatedWake({ recordedState: async () => "running", exec }, "WAKE TASK #42");
    expect(sent).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE TASK #42")]);
    expect(outcome).toEqual({ ok: true });
  });

  it("sends NO keystrokes when the pane is a bare shell, and names what the pane runs", async () => {
    const sent: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      sent.push(cmd);
      return { code: 0, stdout: "studio:claude bash\n", stderr: "" };
    });
    const outcome = await runGatedWake({ recordedState: async () => "running", exec }, "WAKE TASK #42");
    expect(sent).toEqual([PANE_PROBE_CMD]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("bash");
  });

  it("refuses when the probe itself fails, rather than typing blind", async () => {
    const sent: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      sent.push(cmd);
      return { code: 1, stdout: "", stderr: "can't find window: studio:claude" };
    });
    const outcome = await runGatedWake({ recordedState: async () => "running", exec }, "WAKE TASK #42");
    expect(sent).toEqual([PANE_PROBE_CMD]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("can't find window");
  });

  it("is total — an exec throw is a failed wake, never an exception", async () => {
    const exec = vi.fn(async () => { throw new Error("container unreachable"); });
    const outcome = await runGatedWake({ recordedState: async () => "running", exec }, "WAKE TASK #42");
    expect(outcome).toEqual({ ok: false, error: "container unreachable" });
  });
});

// Board issue #82's wakeStudio source pins moved (issue #100 F1): the body is
// now `wakeStudioWith` (do.ts), tested for REAL behaviour in
// test/studio.wake-gate.test.ts, with the method's forward pinned there.

// ---------------------------------------------------------------------------
// Issue #249 round-2 review, ITEM 3 — THE SUBMIT CONFIRMATION.
//
// The bug, exactly: wakeCmd pressed Enter and printed `sent` on the strength of
// `send-keys` exiting 0. That exit code means tmux delivered a keystroke to a
// pane; it says nothing about the TUI having taken it as a SUBMIT. A prompt left
// sitting in the composer was therefore reported as delivered, and every caller
// wrote its at-most-once dedup marker on that report — #107's silent loss,
// reproduced by the code meant to fix it (and, for board #229, a task that stays
// `submitted` while the row claims delivery).
//
// SHARED wake code, so both #229's task pointer and #249's survival re-brief get
// the fix from one place.
// ---------------------------------------------------------------------------

describe("wakeCmd — the post-Enter submit confirmation (#249 item 3)", () => {
  const cmd = wakeCmd("hi");

  it("MUTANT: delete the confirmation and this goes red — the command re-reads the pane after Enter", () => {
    // A capture AFTER the Enter, not only the two modal scans before it.
    expect(cmd).toContain("__ffw_submitted()");
    expect(cmd).toContain("__ffw_submitted; __ffw_s=$?");
    // The Enter is no longer followed by an unconditional `echo sent`.
    expect(cmd).not.toContain("send-keys -t studio:claude Enter && echo");
  });

  it("recognises the composer row by claude's own cursor, anchored at the row start", () => {
    // Measured from this repo's real captures: an EMPTY box is the row `❯`
    // alone; a drafted one is `❯ check on task 2 progress`.
    expect(cmd).toContain("❯");
    // Proven against a REAL tmux, on real pane shapes, in
    // test/bun/wake-submit-check.test.ts — a source assertion cannot tell a
    // correct grep/tail pipeline from one a shell tears apart.
    // POSIX ERE, C-locale safe: the `?` binds to a GROUP, never to the last
    // byte of a multibyte `│` (wake.ts's own LOOSE_LIMIT_PATTERNS rule).
    expect(cmd).toContain("^[[:space:]]*(│[[:space:]]*)?❯");
    expect(cmd).not.toContain("│?");
  });

  it("asks whether THIS WAKE'S OWN TEXT is still in the box, not whether the box is empty", () => {
    // The difference is load-bearing. claude draws GHOST SUGGESTIONS inside an
    // EMPTY composer (test/bun/wake-guard.test.ts's PR #144 N8 rows), and its own
    // hints sit in the box too — one of them on exactly the submit being
    // confirmed. An emptiness test reads all of those as an unsent draft and
    // reports every wake on an idle lead as a failure.
    expect(SUBMIT_HINT_TEXT).toEqual(["Press up to edit queued messages", "Image in clipboard"]);
    expect(submitFragment("What survived, fleetflare--pilot: nothing")).toBe("What survived, f");
    // A FIXED-STRING search for that fragment: a prompt is data, and a prompt
    // compiled into a regex would need escaping to be safe.
    expect(wakeCmd("What survived, fleetflare--pilot: nothing")).toContain("grep -F -q -e 'What survived, f'");
    // …read from the LAST composer row DOWNWARD, so the transcript's echo of a
    // submitted prompt is invisible to it and a wrapped draft is not.
    expect(cmd).toContain("grep -n -E -e");
    expect(cmd).toContain('tail -n +"${__ffw_box%%:*}"');
  });

  it("a genuine draft gets ONE bare Enter, behind a fresh modal scan, then ONE recheck", () => {
    // Exactly two Enters in the whole command, never a loop.
    const enters = cmd.split("send-keys -t studio:claude Enter").length - 1;
    expect(enters).toBe(2);
    // The second Enter is gated on the modal scan running again: a modal drawn
    // in the second after the first Enter must not receive the retry keystroke,
    // which is the one thing #136 exists to prevent.
    expect(cmd).toContain('elif [ "$__ffw_s" = 1 ]; then { __ffw_scan; __ffw_r=$?; ');
    expect(cmd).toContain("unconfirmed modal-before-resubmit");
    expect(cmd).toContain("unconfirmed still-drafted");
  });

  it("FAILS CLOSED on an unreadable box — never `sent` on a guess", () => {
    // The opposite bias to __ffw_scan's, deliberately: wrongly reporting
    // failure costs one bounded duplicate, wrongly reporting success costs the
    // message entirely plus a dedup marker that stops anything retrying.
    expect(cmd).toContain("unconfirmed unreadable");
    expect(cmd).toContain("|| return 2");
  });

  it("still exits the whole wake non-zero when tmux itself cannot reach the window", () => {
    // Unchanged from before: the typing chain is still `&&`-joined, proven end
    // to end against a real tmux in test/bun/wake-cmd.test.ts.
    expect(cmd).toContain("__ff_tmux send-keys -t studio:claude -l -- 'hi' && sleep 1 && {");
  });
});

describe("runWake — an unconfirmed submit is a FAILED wake, not a skip (#249 item 3)", () => {
  const execWith = (stdout: string) => vi.fn(async () => ({ code: 0, stdout, stderr: "" }));

  it("MUTANT: treat `unconfirmed` as success and this goes red", async () => {
    const outcome = await runWake(execWith("__FLEET_WAKE__ unconfirmed still-drafted\n"), "WAKE");
    expect(outcome.ok).toBe(false);
    // NOT a skip: a skip is the gate WORKING and says which keystrokes did not
    // happen. Here the keystrokes DID happen and the message is still not in
    // front of the lead, with a draft left in the pane for a human to find.
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.error).toContain("submit unconfirmed");
    expect(outcome.error).toContain("still sitting in studio:claude's input box");
    // The message tells the operator what will happen next, because it is what
    // makes the bounded-duplicate trade-off honest.
    expect(outcome.error).toContain("no dedup marker written");
  });

  it("a modal that appeared before the retry Enter says so, and says no key was sent", async () => {
    const outcome = await runWake(execWith("__FLEET_WAKE__ unconfirmed modal-before-resubmit\n"), "WAKE");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("no second keystroke was sent");
  });

  it("an unreadable box is unconfirmed, never a landed wake", async () => {
    const outcome = await runWake(execWith("__FLEET_WAKE__ unconfirmed unreadable\n"), "WAKE");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("could not be read after Enter");
  });

  it("a CONFIRMED submit is still a plain landed wake", async () => {
    expect(await runWake(execWith("__FLEET_WAKE__ sent\n"), "WAKE")).toEqual({ ok: true });
  });

  it("the modal refusals are unchanged — still deliberate SKIPS, not submit failures", async () => {
    // #136's own verdicts must not have been swept into the new branch.
    const before = await runWake(execWith("__FLEET_WAKE__ refused-before modal: x\n"), "WAKE");
    expect(before).toEqual({ ok: false, skipped: true, error: expect.stringContaining("nothing typed") });
    const after = await runWake(execWith("__FLEET_WAKE__ refused-after modal: x\n"), "WAKE");
    expect(after.skipped).toBe(true);
  });
});
