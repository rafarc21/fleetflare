import { describe, it, expect, vi } from "vitest";
import {
  detectRateLimitModal, runAccountFailover, paneCaptureCmd, PANE_CAPTURE_MARKER, type FailoverDeps,
} from "../src/studio/failover";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import {
  RULE_PROMPT as RULE_PROMPT_ROWS, V1_STOP_AND_WAIT_PANE, V2_SESSION_LIMIT_PANE, V2_SESSION_LIMIT_RULE_PANE, ORG_SPEND_LIMIT_PANE,
  RESUMED_SESSION_LIMIT_PANE, MONTHLY_SPEND_WRAPPED_PANE, MONTHLY_SPEND_SESSION_PANE, WEEKLY_LIMIT_PANE,
  OUT_OF_CREDITS_PANE, SESSION_LIMIT_LOGIN_HINT_PANE, ORG_HEADLINE_PROSE_ABOVE_V2_PANE,
  NOT_DETECTED, NOT_DETECTED_106, REAL_MONTHLY_SPEND_80COL_PANE, REAL_WEEKLY_COMMA_DATE_PANE,
  NOT_DETECTED_OUT_OF_CREDITS_PROSE,
} from "./fixtures/rate-limit-panes";

// ---------------------------------------------------------------------------
// Issue #106 — failover follow-ups that gate a second claude account. With
// CLAUDE_CODE_OAUTH_TOKEN_2 set, any false positive kills and relaunches a
// working lead, so every change here is precision first.
// ---------------------------------------------------------------------------

function captured(pane: string): string {
  return `${pane}\n${PANE_CAPTURE_MARKER}\n${pane}\n`;
}

const at = (iso: string) => new Date(iso);

describe("#106 item 5 — the missed wordings, anchored like the session limit", () => {
  const cases: { name: string; pane: string; headline: string; marker: string }[] = [
    { name: "weekly limit + /upgrade", pane: WEEKLY_LIMIT_PANE,
      headline: "You've hit your weekly limit", marker: "/upgrade" },
    { name: "monthly spend (session reset) + /usage-credits", pane: MONTHLY_SPEND_SESSION_PANE,
      headline: "You've hit your monthly spend limit", marker: "/usage-credits" },
    { name: "monthly spend, headline WRAPPED onto two lines (measured)", pane: MONTHLY_SPEND_WRAPPED_PANE,
      headline: "You've hit your monthly spend limit", marker: "/usage-credits" },
    { name: "out of usage credits + /usage-credits", pane: OUT_OF_CREDITS_PANE,
      headline: "You're out of usage credits.", marker: "/usage-credits" },
    { name: "session limit + /login hint", pane: SESSION_LIMIT_LOGIN_HINT_PANE,
      headline: "You've hit your session limit", marker: "/login" },
  ];
  for (const c of cases) {
    it(`detects ${c.name}`, () => {
      expect(detectRateLimitModal(captured(c.pane))).toMatchObject({ kind: "modal", headline: c.headline, marker: c.marker });
    });
  }

  it("reads the reset from the headline, including the weekly date form and a wrapped tz", () => {
    expect(detectRateLimitModal(captured(WEEKLY_LIMIT_PANE)))
      .toMatchObject({ resets: "Sep 26 at 12pm (Europe/Madrid)" });
    expect(detectRateLimitModal(captured(MONTHLY_SPEND_WRAPPED_PANE)))
      .toMatchObject({ resets: "Sep 11 at 1am (Europe/Madrid)" });
    expect(detectRateLimitModal(captured(MONTHLY_SPEND_SESSION_PANE)))
      .toMatchObject({ resets: "1:30pm (Europe/Madrid)" });
  });
});

describe("#106 items 2 + 4 — #53 org-spend path anchored, and no early return", () => {
  it("the boxed #53 modal at the bottom of the pane is still detected", () => {
    expect(detectRateLimitModal(captured(ORG_SPEND_LIMIT_PANE)))
      .toMatchObject({ kind: "modal", headline: "You've hit your org's monthly spend limit" });
  });

  it("a #53 headline in prose above a real V2 block does not hide the V2 block", () => {
    expect(detectRateLimitModal(captured(ORG_HEADLINE_PROSE_ABOVE_V2_PANE)))
      .toMatchObject({ kind: "modal", headline: "You've hit your session limit", marker: "/upgrade" });
  });
});

describe("#106 — an idle lead talking about the new wordings is not a limit", () => {
  for (const [name, pane] of Object.entries({ ...NOT_DETECTED, ...NOT_DETECTED_106 })) {
    it(`does not fire on ${name}`, () => {
      expect(detectRateLimitModal(captured(pane), at("2026-09-24T12:00:00Z")).kind).toBe("working");
    });
  }

  it("the measured resumed pane (block redrawn, more output under it) does not fire", () => {
    expect(detectRateLimitModal(captured(RESUMED_SESSION_LIMIT_PANE)).kind).toBe("working");
  });
});

describe("#106 item 3 — a limit block whose reset has PASSED is stale", () => {
  const madrid = V2_SESSION_LIMIT_PANE.replace("1:30pm (UTC)", "3:30pm (Europe/Madrid)");
  const cases: { name: string; pane: string; now: string; kind: "modal" | "working" }[] = [
    { name: "UTC session, 1.5h before reset", pane: V2_SESSION_LIMIT_PANE, now: "2026-09-24T12:00:00Z", kind: "modal" },
    { name: "UTC session, 4.5h before reset", pane: V2_SESSION_LIMIT_RULE_PANE, now: "2026-09-24T09:00:00Z", kind: "modal" },
    { name: "UTC session, AT the reset", pane: V2_SESSION_LIMIT_PANE, now: "2026-09-24T13:30:00Z", kind: "working" },
    { name: "UTC session, after the reset", pane: V2_SESSION_LIMIT_RULE_PANE, now: "2026-09-24T14:00:00Z", kind: "working" },
    { name: "UTC session, next reset 5.5h away: yesterday's block", pane: V2_SESSION_LIMIT_PANE, now: "2026-09-24T08:00:00Z", kind: "working" },
    { name: "Madrid session (UTC+2), before reset", pane: madrid, now: "2026-09-24T13:00:00Z", kind: "modal" },
    { name: "Madrid session (UTC+2), after reset", pane: madrid, now: "2026-09-24T13:31:00Z", kind: "working" },
    { name: "weekly, two days before", pane: WEEKLY_LIMIT_PANE, now: "2026-09-24T12:00:00Z", kind: "modal" },
    { name: "weekly, at the reset (12pm Madrid = 10:00Z)", pane: WEEKLY_LIMIT_PANE, now: "2026-09-26T10:00:00Z", kind: "working" },
    { name: "weekly, a day after", pane: WEEKLY_LIMIT_PANE, now: "2026-09-27T10:00:00Z", kind: "working" },
    { name: "monthly wrapped, when measured (Sep 9)", pane: MONTHLY_SPEND_WRAPPED_PANE, now: "2026-09-09T09:49:00Z", kind: "modal" },
    { name: "monthly wrapped, today (Sep 11 long gone)", pane: MONTHLY_SPEND_WRAPPED_PANE, now: "2026-09-24T12:00:00Z", kind: "working" },
    { name: "monthly with session reset, after it", pane: MONTHLY_SPEND_SESSION_PANE, now: "2026-09-24T12:00:00Z", kind: "working" },
    { name: "out of credits: no reset printed, never stale", pane: OUT_OF_CREDITS_PANE, now: "2026-09-24T12:00:00Z", kind: "modal" },
    { name: "headline-less V1 modal: no reset, never stale", pane: V1_STOP_AND_WAIT_PANE, now: "2026-09-24T12:00:00Z", kind: "modal" },
  ];
  for (const c of cases) {
    it(`${c.name} -> ${c.kind}`, () => {
      expect(detectRateLimitModal(captured(c.pane), at(c.now)).kind).toBe(c.kind);
    });
  }

  it("a timezone it cannot resolve is not evidence of staleness", () => {
    const mars = V2_SESSION_LIMIT_PANE.replace("(UTC)", "(Mars/Olympus)");
    expect(detectRateLimitModal(captured(mars), at("2026-09-24T14:00:00Z")).kind).toBe("modal");
  });
});

// ---------------------------------------------------------------------------
// #106 item 1 — MEASURED 2026-09-24: `claude --resume` redraws a persisted
// limit block and its hint (RESUMED_SESSION_LIMIT_PANE). So after a switch,
// the relaunched lead can show the SAME block again. The guard: a block whose
// `resets` equals the one recorded at the last switch is that re-render.
// ---------------------------------------------------------------------------
describe("#106 item 1 — runAccountFailover ignores a re-render of the block it already switched on", () => {
  const TOKEN_1 = "sk-ant-oat01-" + "a".repeat(40);
  const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
  const TOKEN_3 = "sk-ant-oat01-" + "c".repeat(40);
  const ACCOUNTS = [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 },
    { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 },
  ];
  const NOW = at("2026-09-24T12:00:00Z");

  function setup(pane: string, overrides: Partial<StudioStatus> = {}) {
    const map = new Map<string, unknown>([[STATUS_KEY, {
      id: "demosite-life--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null, ...overrides,
    } satisfies StudioStatus]]);
    const storage: StudioStorage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    };
    const execs: string[] = [];
    const deps: FailoverDeps = {
      autoFailover: true,
      accounts: ACCOUNTS, now: () => NOW,
      exec: vi.fn(async (cmd: string) => {
        execs.push(cmd);
        return { code: 0, stdout: cmd === paneCaptureCmd() ? captured(pane) : "", stderr: "" };
      }),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
    };
    const run = () => runAccountFailover(deps, storage, "demosite-life--pilot", async () => {});
    return { storage, execs, run };
  }

  it("a switch records the reset time it switched on", async () => {
    const s = setup(V2_SESSION_LIMIT_PANE);
    expect(await s.run()).toMatchObject({ kind: "switched", to: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect((await s.storage.get(STATUS_KEY))?.failoverBlock).toBe("You've hit your session limit · 1:30pm (UTC)");
  });

  it("the same block on the next tick (the --continue redraw) does not walk to the next account", async () => {
    const s = setup(V2_SESSION_LIMIT_PANE);
    await s.run();
    const out = await s.run();
    expect(out).toEqual({ kind: "rerender", block: "You've hit your session limit · 1:30pm (UTC)" });
    expect((await s.storage.get(STATUS_KEY))?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(s.execs.filter((c) => c.includes("respawn-pane"))).toHaveLength(1);
  });

  it("a DIFFERENT reset on the new account is a new limit, and switches again", async () => {
    const s = setup(V2_SESSION_LIMIT_PANE.replace("1:30pm (UTC)", "4:00pm (UTC)"), {
      claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", failoverBlock: "You've hit your session limit · 1:30pm (UTC)",
    });
    expect(await s.run()).toMatchObject({ kind: "switched", to: "CLAUDE_CODE_OAUTH_TOKEN_3" });
  });

  it("a stale block (reset passed) never switches, recorded or not", async () => {
    const s = setup(V2_SESSION_LIMIT_PANE.replace("1:30pm (UTC)", "11:00am (UTC)"));
    expect((await s.run()).kind).toBe("no-modal");
    expect(s.execs).toEqual([paneCaptureCmd()]);
  });
});

// ---------------------------------------------------------------------------
// PR #112 review, fix pass A.
// ---------------------------------------------------------------------------
describe("#112 fix A — review nits", () => {
  for (const [name, pane] of Object.entries(NOT_DETECTED_OUT_OF_CREDITS_PROSE)) {
    it(`1. out-of-credits sentence in prose is not a limit: ${name}`, () => {
      expect(detectRateLimitModal(captured(pane), at("2026-09-24T12:00:00Z")).kind).toBe("working");
    });
  }

  it("1. the real out-of-credits line (claude's own continuation) is still a limit", () => {
    expect(detectRateLimitModal(captured(OUT_OF_CREDITS_PANE), at("2026-09-24T12:00:00Z")))
      .toMatchObject({ kind: "modal", headline: "You're out of usage credits." });
  });

  it("2. the real 80-col monthly-spend pane, 'raise it at' ending its row, is a limit", () => {
    expect(detectRateLimitModal(captured(REAL_MONTHLY_SPEND_80COL_PANE), at("2026-09-23T16:17:27Z")))
      .toMatchObject({ kind: "modal", headline: "You've hit your monthly spend limit", marker: "/upgrade" });
  });

  it("3. the Linux dated form 'Sep 17, 8pm (UTC)' parses", () => {
    expect(detectRateLimitModal(captured(REAL_WEEKLY_COMMA_DATE_PANE), at("2026-09-17T12:00:00Z")))
      .toMatchObject({ kind: "modal", headline: "You've hit your weekly limit", resets: "Sep 17, 8pm (UTC)" });
  });

  it("3. the real 09-18 block is judged stale after Sep 17 8pm UTC", () => {
    expect(detectRateLimitModal(captured(REAL_WEEKLY_COMMA_DATE_PANE), at("2026-09-18T09:00:00Z")).kind).toBe("working");
  });

  it("4. a headline row ending exactly at its prefix, hint directly under it, never throws", () => {
    const pane = (tail: string) => [
      "⏺ x", "", `  ⎿  You've hit your monthly spend limit · raise it at${tail}`,
      "     /usage-credits to adjust your monthly spend limit.", "", ...RULE_PROMPT_ROWS,
    ].join("\n");
    for (const tail of [" ", " \u00a0", ""]) {
      expect(() => detectRateLimitModal(captured(pane(tail)))).not.toThrow();
    }
  });
});
