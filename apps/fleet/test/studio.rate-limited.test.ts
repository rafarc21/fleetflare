// Board issue #99: rate-limited is a studio STATE. The row says it, and no
// unattended path types into a usage-limit / session-limit / spend modal.
//
// Measured 2026-09-24: the fleet's one claude account hit its session limit
// (resets 13:30Z). Rows read healthy; a coordinator sent two wakes that could
// never work; and each wake typed text + Enter into a select modal whose
// option 2 is a spend path ("Upgrade your plan", "Add funds").
import { describe, it, expect, vi } from "vitest";
import {
  parseResetUtc, formatRateLimited, encodeAccountLimitState, decodeAccountLimitState,
  encodeAccountUsageSnapshot, decodeAccountUsageSnapshot,
} from "../src/studio/rate-limit";
import { detectRateLimitModal, runAccountFailover, paneCaptureCmd, PANE_CAPTURE_MARKER, type FailoverDeps } from "../src/studio/failover";
import { runGatedWake, PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd } from "../src/studio/wake";
import { wakeOnAssign } from "../src/board/assign-wake";
import { formatAssignWake } from "../cli/task-format";
import { formatReady, readyOverride } from "../cli/readiness-format";
import { emptyObserved } from "../src/studio/observed";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import {
  V1_STOP_AND_WAIT_PANE, V2_SESSION_LIMIT_PANE, V3_ADD_FUNDS_PANE, ORG_SPEND_LIMIT_PANE, RULE_PROMPT, NOT_DETECTED,
} from "./fixtures/rate-limit-panes";
import { detectLimitOnScreen, exhaustedMessage } from "../src/studio/failover";
import { sweepWake } from "../src/studio/do";
import { env } from "cloudflare:test";

const STUDIO_ID = "fleetflare--web-studio";
// 12:20Z, inside the measured window; the limit resets 13:30Z.
const NOW = new Date("2026-09-24T12:20:00.000Z");

describe("parseResetUtc — the reset time, as printed, to UTC", () => {
  it("'1:30pm (UTC)' is today 13:30Z", () => {
    expect(parseResetUtc("1:30pm (UTC)", NOW)).toBe("2026-09-24T13:30:00.000Z");
  });

  it("'3:30pm (Europe/Madrid)' is 13:30Z in September (CEST, UTC+2)", () => {
    expect(parseResetUtc("3:30pm (Europe/Madrid)", NOW)).toBe("2026-09-24T13:30:00.000Z");
  });

  it("weekly 'Sep 26 at 12pm (UTC)' is 2026-09-26 12:00Z", () => {
    expect(parseResetUtc("Sep 26 at 12pm (UTC)", NOW)).toBe("2026-09-26T12:00:00.000Z");
  });

  it("a time-only reset picks the NEAREST occurrence: '12am (UTC)' at 22:00Z is tomorrow 00:00Z", () => {
    expect(parseResetUtc("12am (UTC)", new Date("2026-09-24T22:00:00.000Z"))).toBe("2026-09-25T00:00:00.000Z");
  });

  it("an unknown time zone is null — never a guessed time", () => {
    expect(parseResetUtc("1:30pm (Mars/Olympus)", NOW)).toBeNull();
  });
});

describe("detection — the reset comes from the HEADLINE line only", () => {
  const captured = (pane: string) => `${pane}\n${PANE_CAPTURE_MARKER}\n${pane}\n`;

  it("weekly headline 'resets Sep 26 at 12pm (UTC)' carries its reset", () => {
    const pane = V2_SESSION_LIMIT_PANE.replace("resets 1:30pm (UTC)", "resets Sep 26 at 12pm (UTC)");
    expect(detectRateLimitModal(captured(pane))).toMatchObject({ kind: "modal", resets: "Sep 26 at 12pm (UTC)" });
  });

  it("a 'resets <t>' in transcript output above a headline-less modal is NOT the reset", () => {
    const pane = V3_ADD_FUNDS_PANE.replace("3 migrations pending", "cache resets 5pm (UTC)");
    const v = detectRateLimitModal(captured(pane));
    expect(v.kind).toBe("modal");
    expect((v as { resets?: string }).resets).toBeUndefined();
  });
});

describe("formatRateLimited / fleet ls READY", () => {
  it("renders 'rate-limited until 13:30Z' while it holds", () => {
    const rl = { until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() };
    expect(formatRateLimited(rl, NOW)).toBe("rate-limited until 13:30Z");
  });

  it("a weekly reset names its day", () => {
    const rl = { until: "2026-09-26T12:00:00.000Z", seenAt: NOW.toISOString() };
    expect(formatRateLimited(rl, NOW)).toBe("rate-limited until Sep 26 12:00Z");
  });

  it("a modal with no printed reset says so", () => {
    expect(formatRateLimited({ until: null, seenAt: NOW.toISOString() }, NOW)).toBe("rate-limited (reset time not shown)");
  });

  it("is null once the reset time has passed, and when nothing was observed", () => {
    const rl = { until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() };
    expect(formatRateLimited(rl, new Date("2026-09-24T13:31:00.000Z"))).toBeNull();
    expect(formatRateLimited(null, NOW)).toBeNull();
    expect(formatRateLimited(undefined, NOW)).toBeNull();
  });

  it("issue #141: a dead account never reads as null, however far past 'now' — it never resets", () => {
    const rl = { until: null, seenAt: NOW.toISOString(), dead: true as const };
    expect(formatRateLimited(rl, NOW, STUDIO_ID)).toBe(`claude account dead — org disabled subscription access (ff ${STUDIO_ID})`);
    const muchLater = new Date(NOW.getTime() + 365 * 24 * 60 * 60_000);
    expect(formatRateLimited(rl, muchLater, STUDIO_ID)).toBe(
      `claude account dead — org disabled subscription access (ff ${STUDIO_ID})`,
    );
  });

  it("READY overrides 'provisioned' while rate-limited, and falls back once it passes", () => {
    const readiness = { kind: "provisioned" as const, checkedAt: NOW.toISOString() };
    const rl = { until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() };
    const row = { id: STUDIO_ID, state: "running" as const, rateLimited: rl };
    expect(formatReady(readiness, row, NOW)).toBe("rate-limited until 13:30Z");
    expect(formatReady(readiness, row, new Date("2026-09-24T14:00:00.000Z"))).toBe("provisioned");
    expect(formatReady(readiness)).toBe("provisioned");
  });
});

describe("encodeAccountLimitState / decodeAccountLimitState — issue #141's dead flag round-trips", () => {
  it("round-trips dead: true through JSON, same as until/seenAt", () => {
    const state = { until: null, seenAt: NOW.toISOString(), dead: true as const };
    expect(decodeAccountLimitState(encodeAccountLimitState(state))).toEqual(state);
  });

  it("an ordinary (non-dead) state still round-trips with no `dead` key at all", () => {
    const state = { until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() };
    expect(decodeAccountLimitState(encodeAccountLimitState(state))).toEqual(state);
  });

  it("a present but non-true `dead` is corrupt — reads back null, never thrown", () => {
    expect(decodeAccountLimitState(JSON.stringify({ until: null, seenAt: NOW.toISOString(), dead: false }))).toBeNull();
    expect(decodeAccountLimitState(JSON.stringify({ until: null, seenAt: NOW.toISOString(), dead: "yes" }))).toBeNull();
  });

  it("null for a key never written, unchanged by this feature", () => {
    expect(decodeAccountLimitState(null)).toBeNull();
  });
});

describe("encodeAccountUsageSnapshot / decodeAccountUsageSnapshot — issue #238's headroom pct row", () => {
  it("round-trips a snapshot with a real scopedMaxPct", () => {
    const snap = { fiveHourPct: 40, sevenDayPct: 55, scopedMaxPct: 80, seenAt: NOW.toISOString() };
    expect(decodeAccountUsageSnapshot(encodeAccountUsageSnapshot(snap))).toEqual(snap);
  });

  it("round-trips scopedMaxPct: null — no scoped windows reported", () => {
    const snap = { fiveHourPct: 10, sevenDayPct: 20, scopedMaxPct: null, seenAt: NOW.toISOString() };
    expect(decodeAccountUsageSnapshot(encodeAccountUsageSnapshot(snap))).toEqual(snap);
  });

  it("malformed JSON reads back null, never thrown", () => {
    expect(decodeAccountUsageSnapshot("{not json")).toBeNull();
  });

  it("a shape missing required fields reads back null", () => {
    expect(decodeAccountUsageSnapshot(JSON.stringify({ fiveHourPct: 1, seenAt: NOW.toISOString() }))).toBeNull();
    expect(decodeAccountUsageSnapshot(JSON.stringify({
      fiveHourPct: 1, sevenDayPct: 2, scopedMaxPct: "80", seenAt: NOW.toISOString(),
    }))).toBeNull();
  });

  it("null for a key never written", () => {
    expect(decodeAccountUsageSnapshot(null)).toBeNull();
  });
});

describe("runAccountFailover records rateLimited from the capture it already takes (no extra exec)", () => {
  function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
    return {
      id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      ...overrides,
    };
  }
  function harness(pane: string, initial = status()) {
    const map = new Map<string, unknown>([[STATUS_KEY, initial]]);
    const storage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    };
    const execs: string[] = [];
    let current = pane;
    const deps: FailoverDeps = {
      autoFailover: true,
      accounts: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", token: "sk-ant-oat01-" + "a".repeat(40) }],
      now: () => NOW,
      exec: vi.fn(async (cmd: string) => {
        execs.push(cmd);
        return { code: 0, stdout: cmd === paneCaptureCmd() ? current : "", stderr: "" };
      }),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
    };
    const recorded: StudioStatus[] = [];
    const run = () => runAccountFailover(deps, storage, STUDIO_ID, async (s) => { recorded.push(s); });
    return { map, execs, recorded, run, setPane: (p: string) => { current = p; } };
  }
  const captured = (pane: string) => `${pane}\n${PANE_CAPTURE_MARKER}\n${pane}\n`;

  it("the session-limit pane records until 13:30Z on the row, with one exec", async () => {
    const h = harness(captured(V2_SESSION_LIMIT_PANE));
    await h.run();
    expect(h.execs).toEqual([paneCaptureCmd()]);
    const stored = h.map.get(STATUS_KEY) as StudioStatus;
    expect(stored.rateLimited).toEqual({ until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() });
    expect(h.recorded.at(-1)?.rateLimited?.until).toBe("2026-09-24T13:30:00.000Z");
  });

  it("clears once the pane no longer shows it", async () => {
    const h = harness(captured(RULE_PROMPT.join("\n")), status({
      rateLimited: { until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() },
    }));
    await h.run();
    expect((h.map.get(STATUS_KEY) as StudioStatus).rateLimited ?? null).toBeNull();
    expect(h.recorded).toHaveLength(1);
  });

  it("an unchanged observation on a later tick writes nothing new", async () => {
    const h = harness(captured(V2_SESSION_LIMIT_PANE));
    await h.run();
    const writes = h.recorded.length;
    await h.run();
    expect(h.recorded.length).toBe(writes);
  });
});

// --- (b) the wake gate ------------------------------------------------------

/** A running studio with claude in the pane, whose screen reads `screen`. */
function container(screen: string) {
  const cmds: string[] = [];
  const exec = vi.fn(async (cmd: string) => {
    cmds.push(cmd);
    if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
    if (cmd === PANE_SCREEN_CMD) return { code: 0, stdout: `${screen}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  return { cmds, exec };
}

// Digits on purpose: '#2', '20s', '3' — each could pick a numbered option.
const DIGIT_WAKE = "WAKE TASK ASSIGNED #2 \"retry in 20s\" | option 3 | read it: fleet task show 2";

const MODAL_VARIANTS: { name: string; screen: string }[] = [
  { name: "'1. Stop and wait for limit to reset' / '2. Upgrade your plan' (fleetflare--web-studio)", screen: V1_STOP_AND_WAIT_PANE },
  { name: "'You've hit your session limit · resets 1:30pm (UTC)' + '/upgrade' (demosite-life)", screen: V2_SESSION_LIMIT_PANE },
  { name: "'1. Stop and wait' / '2. Add funds' / '3. Upgrade' (acme-os--web-studio)", screen: V3_ADD_FUNDS_PANE },
  { name: "#53 org spend limit modal", screen: ORG_SPEND_LIMIT_PANE },
];

describe("runGatedWake — digits in wake text never reach a modal pane", () => {
  for (const v of MODAL_VARIANTS) {
    it(`refuses, zero keystrokes: ${v.name}`, async () => {
      const { cmds, exec } = container(v.screen);
      const outcome = await runGatedWake({ recordedState: async () => "running", exec, now: () => NOW }, DIGIT_WAKE);
      expect(outcome.ok).toBe(false);
      expect(outcome.skipped).toBe(true);
      expect(outcome.error).toMatch(/^rate-limited until 13:30Z|^usage-limit modal open in studio:claude/);
      expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD]);
      expect(cmds.some((c) => c.includes("send-keys"))).toBe(false);
    });
  }

  it("the session-limit refusal names the reset: 'rate-limited until 13:30Z'", async () => {
    const { exec } = container(V2_SESSION_LIMIT_PANE);
    const outcome = await runGatedWake({ recordedState: async () => "running", exec, now: () => NOW }, "WAKE");
    expect(outcome.error).toMatch(/^rate-limited until 13:30Z/);
  });

  it("a select modal is refused even after its printed reset has passed — the spend option is still on screen", async () => {
    const screen = ORG_SPEND_LIMIT_PANE;
    const { cmds, exec } = container(screen);
    const later = () => new Date("2026-09-25T12:00:00.000Z");
    const outcome = await runGatedWake({ recordedState: async () => "running", exec, now: later }, DIGIT_WAKE);
    expect(outcome.ok).toBe(false);
    expect(cmds.some((c) => c.includes("send-keys"))).toBe(false);
  });

  it("a STALE inline session-limit block (reset passed, input box below) is wakeable", async () => {
    const { cmds, exec } = container(V2_SESSION_LIMIT_PANE);
    const later = () => new Date("2026-09-24T14:00:00.000Z");
    const outcome = await runGatedWake({ recordedState: async () => "running", exec, now: later }, "WAKE");
    expect(outcome.ok).toBe(true);
    expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE")]);
  });

  it("an idle pane with an empty input box still wakes", async () => {
    const { cmds, exec } = container(RULE_PROMPT.join("\n"));
    const outcome = await runGatedWake({ recordedState: async () => "running", exec, now: () => NOW }, "WAKE");
    expect(outcome.ok).toBe(true);
    expect(cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE")]);
  });

  it("an unreadable screen is refused, never typed into blind", async () => {
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "no server" };
    });
    const outcome = await runGatedWake({ recordedState: async () => "running", exec, now: () => NOW }, "WAKE");
    expect(outcome.ok).toBe(false);
    expect(cmds.some((c) => c.includes("send-keys"))).toBe(false);
  });
});

describe("fleet task assign — prints the rate-limit reason, never 'woke the studio'", () => {
  it("the assign report carries the gate's own words", async () => {
    const { exec } = container(V2_SESSION_LIMIT_PANE);
    const report = await wakeOnAssign(
      {
        studioState: async () => ({ state: "running", repoSlug: null }),
        wake: (_id, prompt) => runGatedWake({ recordedState: async () => "running", exec, now: () => NOW }, prompt),
        resolveCanonicalRepo: async (slug) => slug,
      },
      STUDIO_ID, { number: 2, title: "retry in 20s", repo: "acme/widgets" },
    );
    expect(report.woke).toBe(false);
    const line = formatAssignWake(report)!;
    expect(line).not.toContain("woke the studio");
    expect(line).toContain("rate-limited until 13:30Z");
  });
});

// --- PR #114 review fix pass (verdict BLOCK: two spend-hazard holes) --------

const gate = (screen: string, now: Date, studioId = STUDIO_ID) => {
  const c = container(screen);
  return { ...c, run: (prompt = DIGIT_WAKE) =>
    runGatedWake({ recordedState: async () => "running", exec: c.exec, now: () => now, studioId }, prompt) };
};
const noKeys = (cmds: string[]) => expect(cmds.some((c) => c.includes("send-keys"))).toBe(false);

describe("gate 3 — select modals are refused ALWAYS, inline blocks by the clock", () => {
  it("a select modal under a printed reset that has PASSED is still refused (pins !inline)", async () => {
    const screen = V1_STOP_AND_WAIT_PANE.replace(
      "What do you want to do?", "You've hit your session limit · resets 1:30pm (UTC)\n   What do you want to do?",
    );
    const g = gate(screen, new Date("2026-09-24T15:30:00.000Z"));
    const outcome = await g.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);
    noKeys(g.cmds);
    expect(outcome.error).toMatch(/^usage-limit modal open in studio:claude/);
  });

  it("select copy names the modal, the spend options and the hand dismissal — never an Esc of its own", async () => {
    const g = gate(V3_ADD_FUNDS_PANE, NOW);
    const outcome = await g.run();
    expect(outcome.error).toBe(
      "usage-limit modal open in studio:claude; no keystroke sent (spend options on screen). " +
      `Dismiss by hand: ff ${STUDIO_ID}, press Esc, detach, re-assign.`,
    );
    expect(g.cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD]);
  });

  it("V3 with a headline inside the modal is refused, zero keystrokes", async () => {
    const screen = V3_ADD_FUNDS_PANE.replace("   What do you want to do?", "   You've hit your usage limit\n   What do you want to do?");
    const g = gate(screen, NOW);
    expect((await g.run()).ok).toBe(false);
    noKeys(g.cmds);
  });

  it("V3 under a QUOTED #53 headline is refused, zero keystrokes (no early return)", async () => {
    const screen = V3_ADD_FUNDS_PANE.replace(
      "⏺ Running the migration dry-run before the release.",
      "⏺ Earlier the pane said: You've hit your usage limit — see /rate-limit-options",
    );
    const g = gate(screen, NOW);
    expect((await g.run()).ok).toBe(false);
    noKeys(g.cmds);
  });

  it("inline block, reset ahead: 'rate-limited until 13:30Z', a deliberate skip", async () => {
    const outcome = await gate(V2_SESSION_LIMIT_PANE, NOW).run("WAKE");
    expect(outcome.error).toMatch(/^rate-limited until 13:30Z/);
    expect(outcome.skipped).toBe(true);
  });

  it("inline block, reset unreadable: refused, 'reset time not shown'", async () => {
    const g = gate(V2_SESSION_LIMIT_PANE.replace("(UTC)", "(Mars/Olympus)"), NOW);
    const outcome = await g.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("reset time not shown");
    noKeys(g.cmds);
  });

  it("stale inline block at reset + 2h wakes", async () => {
    const g = gate(V2_SESSION_LIMIT_PANE, new Date("2026-09-24T15:30:00.000Z"));
    const outcome = await g.run("WAKE");
    expect(outcome.ok).toBe(true);
    expect(g.cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE")]);
  });

  for (const name of ["(b) V2's two lines quoted in a report", "(c) git diff of the new wording, then a ⏺ line"]) {
    it(`an idle pane quoting the limit wakes: ${name}`, async () => {
      const g = gate(NOT_DETECTED[name]!, NOW);
      const outcome = await g.run("WAKE");
      expect(outcome.ok).toBe(true);
      expect(g.cmds.at(-1)).toBe(wakeCmd("WAKE"));
    });
  }
});

describe("shape A reads no reset from its body lines", () => {
  it("a 'resets' clause on an option line is not the headline's reset", () => {
    const screen = ORG_SPEND_LIMIT_PANE.replace("2. Not now          ", "2. session limit resets 5pm (UTC)");
    const v = detectLimitOnScreen(screen, NOW);
    expect(v.kind).toBe("modal");
    expect((v as { resets?: string }).resets).toBeUndefined();
    expect((v as { inline?: true }).inline).toBeUndefined();
  });
});

describe("the sweep gets the FULL gate (#99 fix pass)", () => {
  function sweepStorage(state = "running") {
    const map = new Map<string, unknown>([[STATUS_KEY, { id: "fleetflare--maestro", state } as StudioStatus]]);
    return { get: (async (k: string) => map.get(k)) as StudioStorage["get"], put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"] };
  }
  for (const [name, screen] of [["V1", V1_STOP_AND_WAIT_PANE], ["V3", V3_ADD_FUNDS_PANE], ["#53", ORG_SPEND_LIMIT_PANE]] as const) {
    it(`sweep over ${name}: zero send-keys`, async () => {
      const { cmds, exec } = container(screen);
      const outcome = await sweepWake(sweepStorage(), exec, "fleetflare--maestro", "WAKE sweep 3", () => NOW);
      expect(outcome.ok).toBe(false);
      noKeys(cmds);
    });
  }

  it("sweep over a bash pane: zero send-keys", async () => {
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      return { code: 0, stdout: cmd === PANE_PROBE_CMD ? "studio:claude bash\n" : "", stderr: "" };
    });
    const outcome = await sweepWake(sweepStorage(), exec, "fleetflare--maestro", "WAKE sweep 3", () => NOW);
    expect(outcome.ok).toBe(false);
    noKeys(cmds);
  });

  it("sweepMaestro's wake port is sweepWake, with no raw runWake(", () => {
    const src: string = env.TEST_STUDIO_DO_SRC;
    const start = src.indexOf("  async sweepMaestro(): Promise<void> {");
    expect(start).toBeGreaterThan(-1);
    const b = src.slice(start, src.indexOf("\n  }\n", start));
    expect(b.split("sweepWake(").length - 1).toBe(1);
    expect(b).not.toContain("runWake(");
  });
});

describe("runAccountFailover writes race-safe", () => {
  function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
    return {
      id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      ...overrides,
    };
  }
  const captured = (pane: string) => `${pane}\n${PANE_CAPTURE_MARKER}\n${pane}\n`;
  function harness(initial: StudioStatus, onCapture?: (map: Map<string, unknown>) => void) {
    const map = new Map<string, unknown>([[STATUS_KEY, initial]]);
    const storage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    };
    const recorded: StudioStatus[] = [];
    const deps: FailoverDeps = {
      autoFailover: true,
      accounts: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", token: "sk-ant-oat01-" + "a".repeat(40) }],
      now: () => NOW,
      exec: vi.fn(async (cmd: string) => {
        if (cmd === paneCaptureCmd()) { onCapture?.(map); return { code: 0, stdout: captured(V2_SESSION_LIMIT_PANE), stderr: "" }; }
        return { code: 0, stdout: "", stderr: "" };
      }),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
    };
    return { map, recorded, run: () => runAccountFailover(deps, storage, STUDIO_ID, async (s) => { recorded.push(s); }) };
  }

  it("a destroy that lands during the capture keeps the row stopped: nothing written", async () => {
    const h = harness(status(), (map) => map.set(STATUS_KEY, status({ state: "stopped" })));
    await h.run();
    expect((h.map.get(STATUS_KEY) as StudioStatus).state).toBe("stopped");
    expect((h.map.get(STATUS_KEY) as StudioStatus).rateLimited ?? null).toBeNull();
    expect(h.recorded).toEqual([]);
  });

  it("a select modal is recorded AS a select modal, so READY says how to dismiss it", async () => {
    const h = harness(status());
    const map = h.map;
    const probeStorage = { pane: captured(V1_STOP_AND_WAIT_PANE) };
    const deps: FailoverDeps = {
      autoFailover: true,
      accounts: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", token: "sk-ant-oat01-" + "a".repeat(40) }],
      now: () => NOW,
      exec: vi.fn(async (cmd: string) => ({ code: 0, stdout: cmd === paneCaptureCmd() ? probeStorage.pane : "", stderr: "" })),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
    };
    const storage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    };
    await runAccountFailover(deps, storage, STUDIO_ID, async () => {});
    const row = map.get(STATUS_KEY) as StudioStatus;
    expect(row.rateLimited).toMatchObject({ until: null, select: true });
    expect(formatReady(null, row, NOW)).toBe(`limit modal open — Esc to dismiss (ff ${STUDIO_ID})`);
  });

  it("a readiness verdict written during the capture survives the limit write (#136 C4)", async () => {
    const readiness = { kind: "bare" as const, reason: "checked mid-capture", checkedAt: NOW.toISOString() };
    const h = harness(status(), (map) => map.set(STATUS_KEY, { ...(map.get(STATUS_KEY) as StudioStatus), readiness }));
    await h.run();
    const row = h.map.get(STATUS_KEY) as StudioStatus;
    expect(row.rateLimited?.until).toBe("2026-09-24T13:30:00.000Z");
    expect(row.readiness).toEqual(readiness);
  });

  it("already-degraded: a changed limit is still written, and only that", async () => {
    const message = exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    const h = harness(status({ state: "degraded", error: message }));
    const out = await h.run();
    expect(out.kind).toBe("already-degraded");
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.rateLimited?.until).toBe("2026-09-24T13:30:00.000Z");
    expect(h.recorded[0]!.error).toBe(message);
  });
});

describe("READY overrides only a live row", () => {
  const readiness = { kind: "provisioned" as const, checkedAt: NOW.toISOString() };
  const rl = { until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() };

  it("running and degraded rows say rate-limited", () => {
    expect(formatReady(readiness, { id: STUDIO_ID, state: "running", rateLimited: rl }, NOW)).toBe("rate-limited until 13:30Z");
    expect(formatReady(readiness, { id: STUDIO_ID, state: "degraded", rateLimited: rl }, NOW)).toBe("rate-limited until 13:30Z");
  });

  it("a stopped row never does", () => {
    expect(formatReady(readiness, { id: STUDIO_ID, state: "stopped", rateLimited: rl }, NOW)).toBe("provisioned");
  });

  it("an open select modal (no printed reset) tells the operator how to dismiss it", () => {
    const modal = { until: null, seenAt: NOW.toISOString(), select: true as const };
    expect(formatReady(readiness, { id: STUDIO_ID, state: "running", rateLimited: modal }, NOW))
      .toBe(`limit modal open — Esc to dismiss (ff ${STUDIO_ID})`);
  });
});

// Issue #85 review round 4 (TEST 12f) — the merge of this PR's own
// readyOverride (Task 8) and #99/#114's rate-limit rendering (both now live
// in cli/fleet.ts's own `readyOverride(s, now) ?? formatReady(s.readiness,
// s, now)` composition) must resolve in one direction only: on a `running`
// row, readyOverride's replaced/unreachable/unverified evidence is about a
// container the DO no longer trusts at all — strictly more urgent than "the
// lead is merely rate-limited" — and must win outright, never merely being
// raced against or blended with the rate-limit text. `readyOverride` itself
// only ever fires for `state === "running"` (its own doc comment), so a
// `degraded` row's rate-limited rendering is untouched by construction —
// asserted here directly rather than left as an inference.
describe("READY override vs. rate-limited — one wins outright, the other renders untouched (issue #85 review round 4)", () => {
  const rl = { until: "2026-09-24T13:30:00.000Z", seenAt: NOW.toISOString() };

  it("running + replaced AND rate-limited: the override wins, the rate-limit text never renders", () => {
    const s: StudioStatus = {
      id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      rateLimited: rl,
      observed: { ...emptyObserved(), replacedAt: "2026-09-24T12:14:00.000Z" },
    };
    const rendered = readyOverride(s, NOW) ?? formatReady(s.readiness, s, NOW);
    expect(rendered).toBe("replaced 6m ago — not brought up");
    expect(rendered).not.toContain("rate-limited");
  });

  it("running + unreachable (3 failures) AND rate-limited: the override still wins", () => {
    const s: StudioStatus = {
      id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      rateLimited: rl,
      observed: {
        ...emptyObserved(), unreachableSince: "2026-09-24T12:14:00.000Z", execFailures: 3,
        lastShipOkAt: "2026-09-24T12:13:00.000Z", // 7m before NOW — well past board issue #183's 90s
      },
    };
    const rendered = readyOverride(s, NOW) ?? formatReady(s.readiness, s, NOW);
    expect(rendered).toContain("unreachable");
    expect(rendered).not.toContain("rate-limited");
  });

  it("degraded + rate-limited, no PR1 override applies: renders exactly as main's own rate-limit text, untouched", () => {
    const s: StudioStatus = {
      id: STUDIO_ID, state: "degraded", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      rateLimited: rl,
      // Carries observed evidence too — readyOverride must not reach for it
      // on a non-"running" row (its own state === "running" gate), so this
      // proves the degraded row's rate-limit text is untouched even when
      // there IS override-shaped evidence sitting right there.
      observed: { ...emptyObserved(), replacedAt: "2026-09-24T12:14:00.000Z" },
    };
    expect(readyOverride(s, NOW)).toBeNull();
    const rendered = readyOverride(s, NOW) ?? formatReady(s.readiness, s, NOW);
    expect(rendered).toBe("rate-limited until 13:30Z");
  });
});
