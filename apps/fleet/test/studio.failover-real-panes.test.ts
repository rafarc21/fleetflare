import { describe, it, expect, vi } from "vitest";
import {
  detectRateLimitModal, runAccountFailover, paneCaptureCmd, PANE_CAPTURE_MARKER, type FailoverDeps,
} from "../src/studio/failover";
import { runGatedWake, PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd } from "../src/studio/wake";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import { LIMIT_SIGHTING_KEY, type LimitSighting } from "../src/studio/rate-limit";
import {
  REAL_PILOT_PANE, REAL_WEBSTUDIO_PANE, REAL_WEEKLY_DATED_PANE, REAL_WEEKLY_TIMEONLY_PANE, REAL_PANE_CAPTURED_AT,
  V2_SESSION_LIMIT_PANE, RULE_PROMPT, NOT_DETECTED, NOT_DETECTED_106, NOT_DETECTED_OUT_OF_CREDITS_PROSE,
} from "./fixtures/rate-limit-panes";
import { MEMBERS_TICKING_KEY } from "../src/studio/failover";

// ---------------------------------------------------------------------------
// Issue #106 fix pass B — failover's inline shape (B) must match the panes
// real limited studios draw. Measured by the PR #112 review: B matched 0/4,
// because every real block is followed by a `✻ <Verb>ed for <dur>` turn line,
// prompts carry queued text, and 2 of 4 blocks have no hint row.
// ---------------------------------------------------------------------------

const captured = (pane: string, second = pane) => `${pane}\n${PANE_CAPTURE_MARKER}\n${second}\n`;
const at = (iso: string) => new Date(iso);
const RULE = "─".repeat(80);
const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";

describe("B — the four real studio panes are limits", () => {
  const cases = [
    { name: "pilot (hint, ✻ turn line, queued '❯ keep going')", pane: REAL_PILOT_PANE,
      now: REAL_PANE_CAPTURED_AT.pilot, headline: "You've hit your session limit", resets: "1:30pm (UTC)" },
    { name: "web-studio (NO hint, ✻ line with shells, queued text, agent panel)", pane: REAL_WEBSTUDIO_PANE,
      now: REAL_PANE_CAPTURED_AT.webstudio, headline: "You've hit your session limit", resets: "1:30pm (UTC)" },
    { name: "weekly dated (hint, ✻ 0s, tmux notice), before its reset", pane: REAL_WEEKLY_DATED_PANE,
      now: "2026-09-17T12:00:00.000Z", headline: "You've hit your weekly limit", resets: "Sep 17, 8pm (UTC)" },
    { name: "weekly time-only (NO hint, ✻ 0s)", pane: REAL_WEEKLY_TIMEONLY_PANE,
      now: REAL_PANE_CAPTURED_AT.weeklyTimeOnly, headline: "You've hit your weekly limit", resets: "8pm (UTC)" },
  ];
  for (const c of cases) {
    it(`detects ${c.name}`, () => {
      expect(detectRateLimitModal(captured(c.pane), at(c.now)))
        .toMatchObject({ kind: "modal", headline: c.headline, resets: c.resets, inline: true });
    });
  }

  it("the weekly dated pane, at its own capture instant (Sep 18, reset Sep 17 8pm), is stale", () => {
    expect(detectRateLimitModal(captured(REAL_WEEKLY_DATED_PANE), at(REAL_PANE_CAPTURED_AT.weeklyDated)).kind)
      .toBe("working");
  });

  it("the agent panel ticking under the footer is not a turn in flight", () => {
    const later = REAL_WEBSTUDIO_PANE.replace("1h 1m 15s · ↑ 225.5k tokens", "1h 1m 18s · ↑ 225.5k tokens");
    expect(detectRateLimitModal(captured(REAL_WEBSTUDIO_PANE, later), at(REAL_PANE_CAPTURED_AT.webstudio)).kind)
      .toBe("modal");
  });

  it("a spinner above the input box still means a turn in flight", () => {
    const a = REAL_PILOT_PANE.replace("✻ Cogitated for 0s", "✻ Cogitating… (3s · esc to interrupt)");
    const b = REAL_PILOT_PANE.replace("✻ Cogitated for 0s", "✻ Cogitating… (6s · esc to interrupt)");
    expect(detectRateLimitModal(captured(a, b), at(REAL_PANE_CAPTURED_AT.pilot)).kind).toBe("working");
  });
});

// Every negative the #102 and #112 reviews collected, plus the ones the
// relaxed tail opens: a turn line and queued text must not turn prose, a
// diff, a grep result or a new turn into a limit.
export const RELAXED_TAIL_NEGATIVES: Record<string, string> = {
  "lead prose quoting the block, then a turn line and a queued prompt": [
    "⏺ The pilot pane showed:",
    "  You've hit your session limit · resets 1:30pm (UTC)",
    "  /upgrade to increase your usage limit.",
    "", "✻ Cooked for 2m 3s", "", RULE, "❯ keep going", RULE, FOOTER,
  ].join("\n"),
  "a hint-less headline inside a longer tool result": [
    "⏺ Bash(rg -n 'session limit' ~/.claude/projects | tail -2)",
    "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
    "     x.jsonl:13: /upgrade to increase your usage limit.",
    "", "✻ Cooked for 4s", "", RULE, "❯ ", RULE, FOOTER,
  ].join("\n"),
  "a block, then a SUBMITTED user message (no rules around it), then a reply": [
    "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
    "     /upgrade to increase your usage limit.",
    "", "✻ Cogitated for 0s", "",
    "❯ limit reset, continue #85",
    "", "⏺ Resumed. #85 batch 2 dispatched.", "", RULE, "❯ ", RULE, FOOTER,
  ].join("\n"),
  "a block followed by a non-turn ✻ line (waiting on agents)": [
    "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
    "     /upgrade to increase your usage limit.",
    "", "✻ Waiting for 1 background agent to finish", "", RULE, "❯ ", RULE, FOOTER,
  ].join("\n"),
  "queued prompt text with no rule above it": [
    "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
    "     /upgrade to increase your usage limit.",
    "", "✻ Cogitated for 0s", "", "❯ keep going", RULE, FOOTER,
  ].join("\n"),
  "a hint-less monthly-spend headline (hint-less is measured for session/weekly only)": [
    "  ⎿  You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your session limit resets 1:30pm (UTC)",
    "", "✻ Cogitated for 0s", "", RULE, "❯ ", RULE, FOOTER,
  ].join("\n"),
  "an agent-panel row ABOVE the footer": [
    "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
    "     /upgrade to increase your usage limit.",
    "", "✻ Cogitated for 0s", "", "  ● main", RULE, "❯ ", RULE, FOOTER,
  ].join("\n"),
};

describe("B — nothing the reviews collected fires, with the relaxed tail", () => {
  const all = { ...NOT_DETECTED, ...NOT_DETECTED_106, ...NOT_DETECTED_OUT_OF_CREDITS_PROSE, ...RELAXED_TAIL_NEGATIVES };
  for (const [name, pane] of Object.entries(all)) {
    it(`does not fire on ${name}`, () => {
      expect(detectRateLimitModal(captured(pane), at("2026-09-24T12:00:00Z")).kind).toBe("working");
    });
  }
});

// ---------------------------------------------------------------------------
// The orchestrator: redraw-guard key, its clearing, first-sighting staleness.
// ---------------------------------------------------------------------------
const TOKEN = (c: string) => "sk-ant-oat01-" + c.repeat(40);
const ACCOUNTS = [
  { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN("a") },
  { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN("b") },
  { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN("c") },
];
export const IDLE = ["⏺ Done.", "", ...RULE_PROMPT].join("\n");

function studio(pane: string, opts: {
  now?: string; accounts?: typeof ACCOUNTS; row?: Partial<StudioStatus>; sighting?: LimitSighting;
} = {}) {
  let current = captured(pane);
  let now = at(opts.now ?? "2026-09-24T12:00:00Z");
  const map = new Map<string, unknown>([[STATUS_KEY, {
    id: "demosite-life--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null, ...opts.row,
  } satisfies StudioStatus]]);
  if (opts.sighting) map.set(LIMIT_SIGHTING_KEY, opts.sighting);
  const storage: StudioStorage = {
    get: (async (k: string) => map.get(k)) as StudioStorage["get"],
    put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
  };
  const execs: string[] = [];
  const deps: FailoverDeps = {
    autoFailover: true,
    accounts: opts.accounts ?? ACCOUNTS, now: () => now,
    exec: vi.fn(async (cmd: string) => {
      execs.push(cmd);
      return { code: 0, stdout: cmd === paneCaptureCmd() ? current : "", stderr: "" };
    }),
    relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    notify: vi.fn(async () => {}),
  };
  return {
    execs,
    row: () => map.get(STATUS_KEY) as StudioStatus,
    sighting: () => map.get(LIMIT_SIGHTING_KEY) as LimitSighting | undefined,
    membersTickingAt: () => map.get(MEMBERS_TICKING_KEY) as string | undefined,
    run: () => runAccountFailover(deps, storage, "demosite-life--pilot", async () => {}),
    setPane: (p: string, second = p) => { current = captured(p, second); },
    setNow: (iso: string) => { now = at(iso); },
    switches: () => execs.filter((c) => c.includes("respawn-pane")).length,
  };
}

describe("item 3 — the redraw guard is keyed on headline + resets, and forgets", () => {
  it("a switch records the block's headline AND reset", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE);
    expect(await s.run()).toMatchObject({ kind: "switched" });
    expect(s.row().failoverBlock).toBe("You've hit your session limit · 1:30pm (UTC)");
  });

  it("the same block on the relaunched lead is a rerender", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE);
    await s.run();
    expect(await s.run()).toMatchObject({ kind: "rerender" });
    expect(s.switches()).toBe(1);
  });

  it("a DIFFERENT headline with the same reset text is a new limit, and switches", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE);
    await s.run();
    s.setPane(V2_SESSION_LIMIT_PANE.replace("You've hit your session limit", "You've hit your weekly limit"));
    expect(await s.run()).toMatchObject({ kind: "switched", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
  });

  it("a static pane with no limit block clears the key; the same block after that switches", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE);
    await s.run();
    s.setPane(IDLE);
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.row().failoverBlock ?? null).toBeNull();
    s.setPane(V2_SESSION_LIMIT_PANE);
    expect(await s.run()).toMatchObject({ kind: "switched", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
  });

  it("a REPAINTING pane proves nothing, so the key survives it", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE);
    await s.run();
    s.setPane(IDLE, `${IDLE}\n✻ Thinking… (3s)`);
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.row().failoverBlock).toBe("You've hit your session limit · 1:30pm (UTC)");
  });
});

const V2_KEY = "You've hit your session limit · 1:30pm (UTC)";
const V2_SIGHTING: LimitSighting = {
  block: V2_KEY, printed: "1:30pm (UTC)", until: "2026-09-24T13:30:00.000Z", seenAt: "2026-09-24T12:00:00.000Z",
};
// 21h after the first sighting: 13:30Z is 4.5h ahead, so the clock alone reads live.
const PLUS_21H = "2026-09-25T09:00:00Z";

describe("item 4 — a time-only reset is bounded by its FIRST sighting", () => {
  it("a session block first seen 12:00Z (reset 13:30Z) is stale the next morning, though the clock repeats", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE, { accounts: ACCOUNTS.slice(0, 1) });
    expect((await s.run()).kind).toBe("exhausted");
    expect(s.row().rateLimited).toMatchObject({ until: "2026-09-24T13:30:00.000Z", seenAt: "2026-09-24T12:00:00.000Z" });
    // 09:00Z next day: 13:30 is 4.5h ahead, so the time alone reads live.
    s.setNow("2026-09-25T09:00:00Z");
    expect(await s.run()).toMatchObject({ kind: "no-modal" });
    expect(s.sighting()?.seenAt).toBe("2026-09-24T12:00:00.000Z");
  });

  it("a weekly time-only block first seen 15:27Z (reset 20:00Z) is stale at 21:00Z", async () => {
    const s = studio(REAL_WEEKLY_TIMEONLY_PANE, { now: REAL_PANE_CAPTURED_AT.weeklyTimeOnly, accounts: ACCOUNTS.slice(0, 1) });
    expect((await s.run()).kind).toBe("exhausted");
    expect(s.row().rateLimited?.until).toBe("2026-09-17T20:00:00.000Z");
    s.setNow("2026-09-17T21:00:00Z");
    // Issue #214: this run's outcome is now `recovered`, not `no-modal` — the
    // first run above degraded this single-account studio, and a STALE block
    // is not a limit (the line right below was already clearing `rateLimited`
    // on it), so the row stops saying "parked on the rate-limit modal". The
    // claim this test exists to make is unchanged and pinned harder below: at
    // 21:00Z the block is stale, so nothing switches. The sibling test above
    // keeps reading `no-modal` because V2's older BOX_PROMPT chrome draws no
    // footer, and no footer at the bottom is no proof claude is up (#186).
    expect(await s.run()).toMatchObject({ kind: "recovered" });
    expect(s.row().rateLimited ?? null).toBeNull();
    expect(s.switches()).toBe(0);
  });

  it("a stale-by-first-sighting block never switches", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE, { now: "2026-09-25T09:00:00Z", sighting: V2_SIGHTING });
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.switches()).toBe(0);
  });
});

describe("item 5 — the wake gate treats the block it switched on as history", () => {
  function gate(screen: string, switchedBlock: string | null) {
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      if (cmd === PANE_SCREEN_CMD) return { code: 0, stdout: `${screen}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const run = () => runGatedWake({
      recordedState: async () => "running", exec, now: () => at("2026-09-24T12:20:00Z"),
      switchedBlock: async () => switchedBlock,
    }, "WAKE");
    return { cmds, run };
  }

  it("the block recorded at the last switch does not refuse the wake", async () => {
    const g = gate(V2_SESSION_LIMIT_PANE, "You've hit your session limit · 1:30pm (UTC)");
    expect((await g.run()).ok).toBe(true);
    expect(g.cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE")]);
  });

  it("a different block still refuses", async () => {
    const g = gate(V2_SESSION_LIMIT_PANE, "You've hit your weekly limit · 1:30pm (UTC)");
    expect((await g.run()).ok).toBe(false);
    expect(g.cmds.some((c) => c.includes("send-keys"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #127 (folded in): the FIRST sighting of a limit block — printed reset
// + computed until — persists under its own DO key, and seen text is never
// re-parsed. The same block at +21h reads stale in detector, row and wake gate.
// ---------------------------------------------------------------------------
describe("#127 — first sighting persisted, never re-parsed", () => {
  it("detector: the recorded block at +21h is stale; without the record the clock says live", () => {
    expect(detectRateLimitModal(captured(V2_SESSION_LIMIT_PANE), at(PLUS_21H), V2_SIGHTING).kind).toBe("working");
    expect(detectRateLimitModal(captured(V2_SESSION_LIMIT_PANE), at(PLUS_21H)).kind).toBe("modal");
  });

  it("detector: a sighting of a DIFFERENT block does not make this one stale", () => {
    const other = { ...V2_SIGHTING, block: "You've hit your weekly limit · 1:30pm (UTC)" };
    expect(detectRateLimitModal(captured(V2_SESSION_LIMIT_PANE), at(PLUS_21H), other).kind).toBe("modal");
  });

  it("row: the first tick records the sighting; +21h clears rateLimited and keeps the sighting as first seen", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE, { accounts: ACCOUNTS.slice(0, 1) });
    await s.run();
    expect(s.sighting()).toEqual(V2_SIGHTING);
    expect(s.row().rateLimited?.until).toBe("2026-09-24T13:30:00.000Z");
    s.setNow(PLUS_21H);
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.row().rateLimited ?? null).toBeNull();
    expect(s.sighting()).toEqual(V2_SIGHTING);
  });

  it("the sighting survives the block scrolling away; its redraw at +21h is still stale", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE, { accounts: ACCOUNTS.slice(0, 1) });
    await s.run();
    s.setPane(IDLE);
    await s.run();
    expect(s.sighting()).toEqual(V2_SIGHTING);
    s.setNow(PLUS_21H);
    s.setPane(V2_SESSION_LIMIT_PANE);
    expect((await s.run()).kind).toBe("no-modal");
  });

  it("a different block replaces the sighting", async () => {
    const weekly = V2_SESSION_LIMIT_PANE.replace("session limit · resets 1:30pm (UTC)", "weekly limit · resets Sep 26 at 12pm (UTC)");
    const s = studio(weekly, { accounts: ACCOUNTS.slice(0, 1), sighting: V2_SIGHTING });
    await s.run();
    expect(s.sighting()).toEqual({
      block: "You've hit your weekly limit · Sep 26 at 12pm (UTC)", printed: "Sep 26 at 12pm (UTC)",
      until: "2026-09-26T12:00:00.000Z", seenAt: "2026-09-24T12:00:00.000Z",
    });
  });

  function wakeGate(sighting: LimitSighting | null) {
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      if (cmd === PANE_SCREEN_CMD) return { code: 0, stdout: `${V2_SESSION_LIMIT_PANE}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const run = () => runGatedWake({
      recordedState: async () => "running", exec, now: () => at(PLUS_21H), limitSighting: async () => sighting,
    }, "WAKE");
    return { cmds, run };
  }

  it("wake gate: the recorded block at +21h is history, the wake goes through", async () => {
    const g = wakeGate(V2_SIGHTING);
    expect((await g.run()).ok).toBe(true);
    expect(g.cmds).toEqual([PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd("WAKE")]);
  });

  it("wake gate: with no sighting the clock still refuses at +21h (unchanged)", async () => {
    const g = wakeGate(null);
    expect((await g.run()).ok).toBe(false);
  });

  it("wake gate: a live recorded block names the FIRST sighting's until", async () => {
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      return { code: 0, stdout: `${V2_SESSION_LIMIT_PANE}\n`, stderr: "" };
    });
    const out = await runGatedWake({
      recordedState: async () => "running", exec, now: () => at("2026-09-24T12:20:00Z"),
      limitSighting: async () => V2_SIGHTING,
    }, "WAKE");
    expect(out.error).toMatch(/^rate-limited until 13:30Z/);
  });
});

// ---------------------------------------------------------------------------
// PR #144 verifier (BLOCK) — fix pass C.
// ---------------------------------------------------------------------------
import { V1_STOP_AND_WAIT_PANE, V3_ADD_FUNDS_PANE, ORG_SPEND_LIMIT_PANE } from "./fixtures/rate-limit-panes";

describe("fix C item 2 — a select modal is never redraw-guarded", () => {
  for (const [name, pane] of [
    ["V1", V1_STOP_AND_WAIT_PANE], ["V3", V3_ADD_FUNDS_PANE], ["#53 org", ORG_SPEND_LIMIT_PANE],
  ] as const) {
    it(`${name} on 3 accounts: switched TOKEN_2, switched TOKEN_3, exhausted`, async () => {
      const s = studio(pane);
      expect(await s.run()).toMatchObject({ kind: "switched", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
      expect(s.row().failoverBlock ?? null).toBeNull();
      expect(await s.run()).toMatchObject({ kind: "switched", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
      expect((await s.run()).kind).toBe("exhausted");
    });
  }
});

describe("fix C item 3 — the turn row takes every claude verb and a day unit", () => {
  const verbs = ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked"];
  const cases = [
    { name: "pilot", pane: REAL_PILOT_PANE, row: "✻ Cogitated for 0s", now: REAL_PANE_CAPTURED_AT.pilot },
    { name: "web-studio", pane: REAL_WEBSTUDIO_PANE, row: "✻ Cooked for 36m 35s · 7 shells still running", now: REAL_PANE_CAPTURED_AT.webstudio },
    { name: "weekly time-only", pane: REAL_WEEKLY_TIMEONLY_PANE, row: "✻ Baked for 0s", now: REAL_PANE_CAPTURED_AT.weeklyTimeOnly },
    { name: "weekly dated", pane: REAL_WEEKLY_DATED_PANE, row: "✻ Churned for 0s", now: "2026-09-17T19:00:00.000Z" },
  ];
  for (const c of cases) {
    for (const verb of verbs) {
      it(`${c.name} with '✻ ${verb} for 0s' is a limit`, () => {
        const pane = c.pane.replace(c.row, `✻ ${verb} for 0s`);
        expect(detectRateLimitModal(captured(pane), at(c.now)).kind).toBe("modal");
      });
    }
  }

  it("a duration with days ('1d 2h 3m') is a turn row", () => {
    const pane = REAL_PILOT_PANE.replace("✻ Cogitated for 0s", "✻ Cogitated for 1d 2h 3m");
    expect(detectRateLimitModal(captured(pane), at(REAL_PANE_CAPTURED_AT.pilot)).kind).toBe("modal");
  });

  it("'✻ Waiting for 1 background agent to finish' is not a turn row", () => {
    const pane = REAL_PILOT_PANE.replace("✻ Cogitated for 0s", "✻ Waiting for 1 background agent to finish");
    expect(detectRateLimitModal(captured(pane), at(REAL_PANE_CAPTURED_AT.pilot)).kind).toBe("working");
  });

  it("a selected panel row ('❯ ● main') under the footer is still the panel", () => {
    const pane = REAL_WEBSTUDIO_PANE.replace("  ● main", "  ❯ ● main");
    expect(detectRateLimitModal(captured(pane), at(REAL_PANE_CAPTURED_AT.webstudio)).kind).toBe("modal");
  });
});

const WEEKLY_8PM_PANE = REAL_WEEKLY_TIMEONLY_PANE;

describe("fix C item 4 — a live time-only reset is the NEXT occurrence", () => {
  it("weekly '8pm (UTC)' first seen 02:00Z: until is 20:00Z the same day, and 10:00Z still refuses", async () => {
    const s = studio(WEEKLY_8PM_PANE, { now: "2026-09-17T02:00:00Z", accounts: ACCOUNTS.slice(0, 1) });
    expect((await s.run()).kind).toBe("exhausted");
    expect(s.sighting()?.until).toBe("2026-09-17T20:00:00.000Z");
    s.setNow("2026-09-17T10:00:00Z");
    expect(detectRateLimitModal(captured(WEEKLY_8PM_PANE), at("2026-09-17T10:00:00Z"), s.sighting()).kind).toBe("modal");
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      return { code: 0, stdout: `${WEEKLY_8PM_PANE}\n`, stderr: "" };
    });
    const out = await runGatedWake({
      recordedState: async () => "running", exec, now: () => at("2026-09-17T10:00:00Z"),
      limitSighting: async () => s.sighting() ?? null,
    }, "WAKE");
    expect(out.ok).toBe(false);
    expect(cmds.some((c) => c.includes("send-keys"))).toBe(false);
  });
});

describe("fix C item 5 — a block already stale when first seen is recorded", () => {
  it("the pilot pane first seen 20:00Z (reset 13:30Z passed) does not fire at 08:31Z next day", async () => {
    const s = studio(REAL_PILOT_PANE, { now: "2026-09-24T20:00:00Z" });
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.sighting()).toMatchObject({ block: V2_KEY, until: "2026-09-24T13:30:00.000Z" });
    s.setNow("2026-09-25T08:31:00Z");
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.switches()).toBe(0);
  });
});

describe("fix C item 6 — the guard is forgotten only with claude on screen", () => {
  it("switch, then a static BASH prompt, then the --continue redraw: rerender, not a second switch", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE);
    await s.run();
    s.setPane("root@cloudchamber:/workspace#");
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.row().failoverBlock).toBe(V2_KEY);
    s.setPane(V2_SESSION_LIMIT_PANE);
    expect((await s.run()).kind).toBe("rerender");
    expect(s.switches()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fix pass D (#170) — the X3 defect. claude died AFTER drawing its last frame,
// so that frame, footer and all, is still on screen ABOVE a bash prompt.
// `some(FOOTER_LINE)` read that as "claude is up", retired the redraw guard,
// and the next `--continue` redraw switched account again. MEASURED on the
// #144 verifier: TOKEN_2 → TOKEN_3.
// ---------------------------------------------------------------------------
/** claude's last frame left on screen, dead, with bash underneath it. */
export const DEAD_FRAME = [IDLE, "root@cloudchamber:/workspace# "].join("\n");

describe("fix D item 1 — the guard retires only with claude's footer at the BOTTOM", () => {
  it("switch, then claude's dead frame above a bash prompt, then the redraw: rerender, 1 switch", async () => {
    const s = studio(V2_SESSION_LIMIT_PANE);
    expect(await s.run()).toMatchObject({ kind: "switched", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    s.setPane(DEAD_FRAME);
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.row().failoverBlock).toBe(V2_KEY);
    s.setPane(V2_SESSION_LIMIT_PANE);
    expect(await s.run()).toMatchObject({ kind: "rerender" });
    expect(s.switches()).toBe(1);
  });
});

describe("fix D item 2 — a block first seen STALE keeps the PREVIOUS occurrence (C6)", () => {
  it("pilot block (reset 1:30pm) first seen 02:00Z reads back to yesterday's 13:30Z, and never switches", async () => {
    // 02:00Z: "1:30pm" is 11.5h ahead by the clock, past the session window, so
    // the detector calls it stale. The until must go BACKWARD from the nearest
    // occurrence (09-25 13:30Z) to the one that already passed — without that,
    // the same block five minutes later reads live and burns an account.
    const s = studio(REAL_PILOT_PANE, { now: "2026-09-25T02:00:00Z" });
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.sighting()?.until).toBe("2026-09-24T13:30:00.000Z");
    s.setNow("2026-09-25T02:05:00Z");
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.switches()).toBe(0);
  });
});

// A hinted session block with its turn-ended row — everything ABOVE the input
// box, so each pin below varies only the tail claude draws under it.
const HINTED_BLOCK = [
  "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
  "     /upgrade to increase your usage limit.",
  "", "✻ Cogitated for 0s", "",
];
const tailed = (...rows: string[]) => [...HINTED_BLOCK, ...rows].join("\n");

describe("fix D item 5 — B's tail rules, each pinned (M9/M10/M11/M11b)", () => {
  it("M9: a 4th wrapped row of queued text is past QUEUED_TEXT_ROWS", () => {
    const pane = tailed(RULE, "❯ keep going", "and going", "and going", "and going", "and going", RULE, FOOTER);
    expect(detectRateLimitModal(captured(pane), at("2026-09-24T12:00:00Z")).kind).toBe("working");
  });

  for (const glyph of ["⏺ ", "● "]) {
    it(`M10: a queued row starting '${glyph.trim()}' is transcript, not wrapped prompt text`, () => {
      const pane = tailed(RULE, "❯ keep going", `${glyph}Done.`, RULE, FOOTER);
      expect(detectRateLimitModal(captured(pane), at("2026-09-24T12:00:00Z")).kind).toBe("working");
    });
  }

  it("M11: an agent-panel row BETWEEN the closing rule and the footer is not the panel", () => {
    const pane = tailed(RULE, "❯ ", RULE, "  ● main", FOOTER);
    expect(detectRateLimitModal(captured(pane), at("2026-09-24T12:00:00Z")).kind).toBe("working");
  });

  it("M11b: a bash prompt UNDER the footer is not the agent panel", () => {
    const pane = tailed(RULE, "❯ ", RULE, FOOTER, "root@x# ");
    expect(detectRateLimitModal(captured(pane), at("2026-09-24T12:00:00Z")).kind).toBe("working");
  });

  it("the same tail WITHOUT those rows is still a limit", () => {
    const pane = tailed(RULE, "❯ keep going", "and going", RULE, FOOTER, "  ● main");
    expect(detectRateLimitModal(captured(pane), at("2026-09-24T12:00:00Z")).kind).toBe("modal");
  });
});

describe("fix C item 7 — pins", () => {
  function screenGate(screen: string, deps: { switchedBlock?: () => Promise<string | null>; limitSighting?: () => Promise<LimitSighting | null> }) {
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      return { code: 0, stdout: `${screen}\n`, stderr: "" };
    });
    const run = () => runGatedWake({ recordedState: async () => "running", exec, now: () => at("2026-09-24T12:20:00Z"), ...deps }, "WAKE");
    return { cmds, run };
  }

  it("a select modal whose key equals switchedBlock is still refused", async () => {
    const g = screenGate(V1_STOP_AND_WAIT_PANE, { switchedBlock: async () => "(null) · " });
    const g2 = screenGate(V1_STOP_AND_WAIT_PANE, { switchedBlock: async () => "Stop and wait for limit to reset · " });
    for (const x of [g, g2]) {
      expect((await x.run()).ok).toBe(false);
      expect(x.cmds.some((c) => c.includes("send-keys"))).toBe(false);
    }
  });

  // Fix pass D (#170, W6): the gate's two storage reads are BOTH total. A
  // rejected switchedBlock must land as a refused wake, never as a throw out
  // of runGatedWake — its callers treat it as total by construction.
  it("a switchedBlock that rejects never throws out of the gate", async () => {
    const g = screenGate(V2_SESSION_LIMIT_PANE, { switchedBlock: async () => { throw new Error("storage down"); } });
    const out = await g.run();
    expect(out.ok).toBe(false);
  });

  it("a limitSighting that rejects never throws out of the gate", async () => {
    const g = screenGate(V2_SESSION_LIMIT_PANE, { limitSighting: async () => { throw new Error("storage down"); } });
    const out = await g.run();
    expect(out.ok).toBe(false);
  });

  it("a hint-less headline row with trailing text stays working", () => {
    const pane = REAL_WEEKLY_TIMEONLY_PANE.replace("resets 8pm (UTC)", "resets 8pm (UTC) — see docs");
    expect(detectRateLimitModal(captured(pane), at(REAL_PANE_CAPTURED_AT.weeklyTimeOnly)).kind).toBe("working");
  });

  it("an option row ('❯ 1. …') in the ruled box is not queued prompt text", () => {
    // The real row has a NO-BREAK SPACE after ❯, as claude draws it.
    const pane = REAL_PILOT_PANE.replace(/❯\s+keep going/u, "❯\u00a01. Stop and wait for limit to reset");
    expect(pane).not.toBe(REAL_PILOT_PANE);
    expect(detectRateLimitModal(captured(pane), at(REAL_PANE_CAPTURED_AT.pilot)).kind).toBe("working");
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3a, Task 4) — the panel-diff leg: runAccountFailover already
// takes two captures PANE_QUIESCE_SECONDS apart on its existing 300s probe;
// when the agent panel's own rows move between them, that is member-turn
// evidence, recorded under MEMBERS_TICKING_KEY for the ship tick's own
// nextActivity to read back.
// ---------------------------------------------------------------------------
describe("runAccountFailover — MEMBERS_TICKING_KEY (issue #221)", () => {
  it("records a fresh membersTickingAt when the agent panel moves between the two captures", async () => {
    const later = REAL_WEBSTUDIO_PANE.replace("1h 1m 15s · ↑ 225.5k tokens", "1h 1m 18s · ↑ 225.5k tokens");
    const s = studio(REAL_WEBSTUDIO_PANE, { now: REAL_PANE_CAPTURED_AT.webstudio });
    s.setPane(REAL_WEBSTUDIO_PANE, later);
    await s.run();
    expect(s.membersTickingAt()).toBe(REAL_PANE_CAPTURED_AT.webstudio);
  });

  it("byte-identical captures record no member evidence", async () => {
    const s = studio(REAL_WEBSTUDIO_PANE, { now: REAL_PANE_CAPTURED_AT.webstudio });
    await s.run();
    expect(s.membersTickingAt()).toBeUndefined();
  });

  it("a panel with no footer to anchor against (DEAD_FRAME) records no member evidence, even split across two different captures", async () => {
    const s = studio(DEAD_FRAME);
    s.setPane(DEAD_FRAME, IDLE);
    await s.run();
    expect(s.membersTickingAt()).toBeUndefined();
  });
});
