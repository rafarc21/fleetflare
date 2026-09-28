// Issue #136: the wake gate was check-then-act. These pin the Worker half:
// the loose screen check, single-flight per studio, the sweep's log level and
// the runWake reading of the in-container guard's verdict. The container half
// (capture -> type -> recapture -> Enter, one exec) runs for real in
// test/bun/wake-guard.test.ts.
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  runGatedWake, runWake, singleFlightWake, logWakeOutcome, looseLimitOnScreen, LOOSE_TAIL_LINES,
  PANE_PROBE_CMD, PANE_SCREEN_CMD,
} from "../src/studio/wake";
import { runAccountFailover, paneCaptureCmd, PANE_CAPTURE_MARKER, type FailoverDeps } from "../src/studio/failover";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import {
  V1_STOP_AND_WAIT_PANE, V2_SESSION_LIMIT_PANE, REAL_PILOT_PANE, REAL_PANE_CAPTURED_AT,
} from "./fixtures/rate-limit-panes";

const NOW = new Date("2026-09-24T12:20:00.000Z");
const STUDIO_ID = "fleetflare--maestro";

function container(screen: string) {
  const cmds: string[] = [];
  const exec = vi.fn(async (cmd: string) => {
    cmds.push(cmd);
    if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
    if (cmd === PANE_SCREEN_CMD) return { code: 0, stdout: `${screen}\n`, stderr: "" };
    return { code: 0, stdout: "__FLEET_WAKE__ sent\n", stderr: "" };
  });
  return { cmds, exec };
}
const gated = (exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>) =>
  runGatedWake({ recordedState: async () => "running", exec, now: () => NOW, studioId: STUDIO_ID }, "WAKE");

describe("gate 3 is LOOSE: unseen modal shapes are refused before any keystroke", () => {
  const UNSEEN: [string, string][] = [
    ["status row under the modal footer", `${V1_STOP_AND_WAIT_PANE}\n  ⏵⏵ bypass permissions on · 1 background task`],
    ["boxed V1", [
      "╭──────────────────────────────────────────────╮",
      "│ What do you want to do?                      │",
      "│ ❯ 1. Stop and wait for limit to reset        │",
      "│   2. Upgrade your plan                       │",
      "│ Enter to confirm · Esc to cancel             │",
      "╰──────────────────────────────────────────────╯",
    ].join("\n")],
  ];
  for (const [name, screen] of UNSEEN) {
    it(`refuses: ${name}`, async () => {
      const { cmds, exec } = container(screen);
      const outcome = await gated(exec);
      expect(outcome.ok).toBe(false);
      // Strict detector misses these shapes: loose-only, so loud (#141 review).
      expect(outcome.skipped).toBeUndefined();
      expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD]);
    });
  }
});

describe("runWake reads the in-container guard's verdict", () => {
  it("'refused-after modal' is a deliberate skip, not a landed wake", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "__FLEET_WAKE__ refused-after modal\n", stderr: "" }));
    const outcome = await runWake(exec, "WAKE");
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("no Enter sent");
  });

  it("'refused-before modal' is a deliberate skip too", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "__FLEET_WAKE__ refused-before modal\n", stderr: "" }));
    const outcome = await runWake(exec, "WAKE");
    expect(outcome).toMatchObject({ ok: false, skipped: true });
  });

  it("'sent' is a landed wake", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "__FLEET_WAKE__ sent\n", stderr: "" }));
    expect(await runWake(exec, "WAKE")).toEqual({ ok: true });
  });
});

describe("single-flight: one wake in flight per studio", () => {
  it("two concurrent wakes: one types, the other is refused as a skip", async () => {
    const lock = { busy: false };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const typed: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      if (cmd === PANE_SCREEN_CMD) { await gate; return { code: 0, stdout: "idle\n", stderr: "" }; }
      typed.push(cmd);
      return { code: 0, stdout: "__FLEET_WAKE__ sent\n", stderr: "" };
    });
    const a = singleFlightWake(lock, () => gated(exec));
    const b = await singleFlightWake(lock, () => gated(exec));
    release();
    const first = await a;
    expect(first.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.skipped).toBe(true);
    expect(b.error).toContain("another wake is in flight");
    expect(typed).toHaveLength(1);
    expect(lock.busy).toBe(false);
  });

  it("the lock is released when the wake throws", async () => {
    const lock = { busy: false };
    await expect(singleFlightWake(lock, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(lock.busy).toBe(false);
  });
});

describe("StudioDO source pins (#136)", () => {
  const src: string = env.TEST_STUDIO_DO_SRC;
  const body = (sig: string) => {
    const start = src.indexOf(sig);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }\n", start));
  };

  it("every wake path goes through the one per-studio lock", () => {
    for (const sig of [
      "  async wakeStudio(prompt: string): Promise<WakeOutcome> {",
      "  async wakeStudioOnAssignment(prompt: string, clearDraftFirst = false): Promise<WakeOutcome> {",
      "  async sweepMaestro(): Promise<void> {",
    ]) {
      expect(body(sig)).toContain("singleFlightWake(this.wakeLock,");
    }
  });

  it("the sweep logs its wake by the shared rule: a limited maestro is info, not an error every 20 min", () => {
    const b = body("  async sweepMaestro(): Promise<void> {");
    expect(b).toContain('logWakeOutcome("maestro sweep wake", result.wake)');
    expect(b).not.toContain("maestro sweep wake failed");
  });
});

describe("a completed account switch clears the limit (#136 C4)", () => {
  it("rateLimited is null after the switch lands", async () => {
    const pane = `${V2_SESSION_LIMIT_PANE}\n${PANE_CAPTURE_MARKER}\n${V2_SESSION_LIMIT_PANE}\n`;
    const map = new Map<string, unknown>([[STATUS_KEY, {
      id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      rateLimited: { until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() },
    } as StudioStatus]]);
    const storage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    };
    const deps: FailoverDeps = {
      autoFailover: true,
      accounts: [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", token: "sk-ant-oat01-" + "a".repeat(40) },
        { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: "sk-ant-oat01-" + "b".repeat(40) },
      ],
      now: () => NOW,
      exec: vi.fn(async (cmd: string) => ({ code: 0, stdout: cmd === paneCaptureCmd() ? pane : "", stderr: "" })),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
    };
    const out = await runAccountFailover(deps, storage, STUDIO_ID, async () => {});
    expect(out.kind).toBe("switched");
    expect((map.get(STATUS_KEY) as StudioStatus).rateLimited ?? null).toBeNull();
  });
});

// --- #141 review: anchor on modal ROWS; a loose-only refusal is loud --------

describe("gate 3 loose check anchors on modal ROWS (#141 review)", () => {
  const idleWith = (row: string) => ["─".repeat(68), row, "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");

  for (const ghost of ["❯ What do you want to do next?", "❯ 1. Upgrade deps", "❯ WAKE TASK #2 \"retry: 2. Upgrade your plan\""]) {
    it(`composer row ${JSON.stringify(ghost)} is not a modal: the wake lands`, async () => {
      const { cmds, exec } = container(idleWith(ghost));
      const outcome = await gated(exec);
      expect(outcome.ok).toBe(true);
      expect(cmds.length).toBe(3);
    });
  }

  it("a loose-only refusal (strict says working) is NOT a skip: it names the row and logs as an error", async () => {
    const screen = `${V1_STOP_AND_WAIT_PANE}\n  ⏵⏵ bypass permissions on · 1 background task`;
    const { exec } = container(screen);
    const outcome = await gated(exec);
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.error).toContain("Enter to confirm · Esc to cancel");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    logWakeOutcome("wake", outcome);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it(`a footer ${6} rows above the bottom is still within LOOSE_TAIL_LINES (${LOOSE_TAIL_LINES})`, () => {
    expect(LOOSE_TAIL_LINES).toBe(12);
    const screen = [V1_STOP_AND_WAIT_PANE, ...Array.from({ length: 6 }, (_, i) => `  status ${i}`)].join("\n");
    expect(looseLimitOnScreen(screen)).not.toBeNull();
  });
});

// --- PR #144: the anchors themselves are pinned -----------------------------
//
// Mutant N1 — ROW_LEAD = "" and ROW_TAIL = "" — left every test green, so the
// anchoring was carrying no weight: the patterns would have matched the phrase
// ANYWHERE in a row, which is exactly what PR #102's first detector did and
// what the #141 review forbade. Every case below is a row whose phrase is NOT
// the whole row (or whose cursor sits at column 0, mutant N8), so it must not
// refuse; under N1 or N8 each one refuses instead and the wake never lands.

describe("the loose patterns' row anchors are load-bearing (#144, mutants N1/N8)", () => {
  const idleWith = (...rows: string[]) =>
    ["─".repeat(68), ...rows, "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");

  /** N1: the phrase is real, but MID-row — text before it and after it. */
  const MID_ROW: [string, string][] = [
    ["footer, echoed back by the composer",
      "❯ WAKE TASK #77 \"the pane footer read Enter to confirm · Esc to cancel, so nothing was typed\""],
    ["/rate-limit-options, named in the middle of a sentence",
      "❯ WAKE: see /rate-limit-options for what the account can still do"],
    ["a #53 headline quoted inside a row",
      "❯ WAKE: yesterday You've hit your usage limit was on screen; it is gone now"],
  ];
  /** N1's tail half: the phrase OPENS the row but does not end it. */
  const TRAILING: [string, string][] = [
    ["footer with trailing prose", "  Enter to confirm · Esc to cancel — quoted from the #53 modal"],
    ["a #53 headline with trailing prose", "  You've hit your usage limit was the wording on 09-23"],
  ];
  /** N8: the SAME rows as ghost suggestions — a cursor at column 0, no border. */
  const GHOST: [string, string][] = [
    ["ghost footer", "❯ Enter to confirm · Esc to cancel"],
    ["ghost /rate-limit-options", "❯ /rate-limit-options"],
    ["ghost Run /rate-limit-options", "❯ Run /rate-limit-options to see what you can do."],
    ["ghost #53 headline", "❯ You've hit your usage limit"],
  ];

  for (const [name, row] of [...MID_ROW, ...TRAILING, ...GHOST]) {
    it(`${name}: not a modal row, so the wake lands`, async () => {
      const screen = idleWith(row);
      expect(looseLimitOnScreen(screen)).toBeNull();
      const { cmds, exec } = container(screen);
      const outcome = await gated(exec);
      expect(outcome.ok).toBe(true);
      expect(cmds).toHaveLength(3);
    });
  }

  it("an echoing composer: the wake lands, and the NEXT wake over the echo lands too", async () => {
    const first = container(idleWith("❯ "));
    expect((await gated(first.exec)).ok).toBe(true);
    // What the composer now shows: the text just typed, footer phrase and all.
    const echoed = container(idleWith("❯ WAKE #77 retry — pane said Enter to confirm · Esc to cancel"));
    expect((await gated(echoed.exec)).ok).toBe(true);
    expect([...first.cmds, ...echoed.cmds].filter((c) => c.includes("send-keys"))).toHaveLength(2);
  });

  it("the same phrases AS whole rows, inside a border, are still refused", async () => {
    for (const row of [
      "  Enter to confirm · Esc to cancel",
      "│ Run /rate-limit-options to see what you can do.              │",
      "│ ❯ You've hit your usage limit                                │",
    ]) {
      const { cmds, exec } = container(idleWith(row));
      const outcome = await gated(exec);
      expect(outcome.ok).toBe(false);
      expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD]);
    }
  });
});

// --- PR #144: the loose gate also covers the SWITCHED-BLOCK path ------------
//
// #106 fix B gave the gate an early return: the inline block the last account
// switch fired on, redrawn by `--continue`, is history, so the wake goes
// through it. That return skipped the loose check, so a modal footer on the
// SAME pane was seen by the container guard alone — safe for spend (nothing is
// typed) but SILENT: a skip, no operator-facing error, and the reason never
// names the row. The loose check now lives INSIDE afterLimitGate, which both
// call sites reach.

describe("gate 3 loose check covers the switched-block redraw too (#144)", () => {
  /** The pilot pane's own block key — what failover records at a switch. */
  const SWITCHED = "You've hit your session limit · 1:30pm (UTC)";
  /** The real row carries a NO-BREAK SPACE after ❯, as claude draws it. */
  const withQueued = (rows: string[]) =>
    REAL_PILOT_PANE.replace(/❯\s+keep going/u, ["❯ keep going", ...rows].join("\n"));

  const gatedSwitched = (exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>) =>
    runGatedWake({
      recordedState: async () => "running", exec, studioId: STUDIO_ID,
      now: () => new Date(REAL_PANE_CAPTURED_AT.pilot),
      switchedBlock: async () => SWITCHED,
    }, "WAKE");

  it("a footer row among the queued rows: loud refusal naming the row, and NOTHING typed", async () => {
    const { cmds, exec } = container(withQueued(["  Enter to confirm · Esc to cancel"]));
    const outcome = await gatedSwitched(exec);
    expect(outcome.ok).toBe(false);
    // Loose-only, so loud: an error the operator sees, never a silent skip.
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.error).toContain("Enter to confirm · Esc to cancel");
    expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    logWakeOutcome("wake", outcome);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("the same switched-block redraw with NO modal row still lands the wake", async () => {
    const { cmds, exec } = container(REAL_PILOT_PANE);
    const outcome = await gatedSwitched(exec);
    expect(outcome.ok).toBe(true);
    expect(cmds).toHaveLength(3);
  });
});
