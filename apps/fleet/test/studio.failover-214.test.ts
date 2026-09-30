import { describe, it, expect, vi } from "vitest";
import {
  runAccountFailover, paneCaptureCmd, exhaustedMessage, detectRateLimitModal, PANE_CAPTURE_MARKER,
  type FailoverDeps,
} from "../src/studio/failover";
import {
  STATUS_KEY, OPERATION_KEY, OPERATION_STALE_MS, type StudioStorage,
} from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import { runGatedWake, PANE_PROBE_CMD } from "../src/studio/wake";
import {
  RULE_PROMPT, V2_SESSION_LIMIT_RULE_PANE, REAL_PILOT_PANE,
  MONTHLY_SPEND_THREE_ROW_WRAP_PANE, MONTHLY_SPEND_THREE_ROW_WRAP_MIDTURN_PANE,
  V1_THREE_OPTION_PANE, V1_THREE_OPTION_FLIPPED_PANE, NOT_DETECTED_106,
} from "./fixtures/rate-limit-panes";

// ---------------------------------------------------------------------------
// Issue #214 — a degraded row that keeps lying after the lead came back.
//
// MEASURED 2026-09-24: the shared account hit its session limit ~22:00Z. Pilot,
// release-studio and scratch all went `STATE degraded`, error "claude account
// exhausted: <id> is parked on the rate-limit modal …" (22:52Z). At 23:32Z the
// maestro dismissed each modal with a lone Esc and ALL THREE LEADS RESUMED —
// footer back, `esc to interrupt` ticking, new commits and PRs followed. At
// 23:38Z and well past it, `fleet ls` STILL showed `degraded` with that same
// error on all three, READY `provisioned`.
//
// The #144 verifier predicted it: "degraded sticks until provision or restart".
// A recycle does clear the row (verified 00:12Z on release-studio); a working
// lead does not. A row claiming a lead is parked while it works is the lie #85
// exists to remove, and any gate keyed on `degraded`/`exhausted` can refuse a
// wake to a lead that is working fine.
//
// Same storage-level harness the other failover suites use — a live StudioDO
// cannot be constructed under vitest-pool-workers (see src/studio/do.ts's
// header).
// ---------------------------------------------------------------------------

const STUDIO_ID = "demosite-life--pilot";
const NOW = "2026-09-24T23:38:00.000Z";
const TOKEN = (c: string) => "sk-ant-oat01-" + c.repeat(40);
const ONE_ACCOUNT = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN("a") }];
const TWO_ACCOUNTS = [...ONE_ACCOUNT, { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN("b") }];

/** The error the exhaustion wrote on all three rows, verbatim in shape. */
const EXHAUSTED = exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"]);

const captured = (first: string, second = first) =>
  `${first}\n${PANE_CAPTURE_MARKER}\n${second}\n`;

/** An idle lead, back at its input box: claude's footer IS the bottom row. */
const RECOVERED_IDLE = ["⏺ Resumed after the Esc.", "", ...RULE_PROMPT].join("\n");

/** The measured 23:32Z state: the lead RESUMED and is mid-turn, so the pane
 *  repaints — and claude's footer is still the bottom of the pane. */
const WORKING = (secs: number) => [
  "⏺ Picking the batch back up.",
  "",
  `✻ Cogitating… (${secs}s · ↑ 1.4k tokens · esc to interrupt)`,
  ...RULE_PROMPT,
].join("\n");

/** claude DIED after drawing its last frame: footer on screen, but bash under
 *  it, so footerAtBottom says no claude (fix pass D / #186). */
const DEAD_FRAME = [RECOVERED_IDLE, "root@cloudchamber:/workspace# "].join("\n");

function studio(pane: string, opts: {
  row?: Partial<StudioStatus>; accounts?: typeof TWO_ACCOUNTS; now?: string;
} = {}) {
  let current = captured(pane);
  let now = new Date(opts.now ?? NOW);
  const map = new Map<string, unknown>([[STATUS_KEY, {
    id: STUDIO_ID, state: "degraded", tailscaleHost: null, lastRefresh: null, error: EXHAUSTED,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN", ...opts.row,
  } satisfies StudioStatus]]);
  const storage: StudioStorage = {
    get: (async (k: string) => map.get(k)) as StudioStorage["get"],
    put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
  };
  const execs: string[] = [];
  const recorded: StudioStatus[] = [];
  const notifications: string[] = [];
  const deps: FailoverDeps = {
    autoFailover: true,
    accounts: opts.accounts ?? ONE_ACCOUNT,
    now: () => now,
    exec: vi.fn(async (cmd: string) => {
      execs.push(cmd);
      return { code: 0, stdout: cmd === paneCaptureCmd() ? current : "", stderr: "" };
    }),
    relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    notify: vi.fn(async (message: string) => { notifications.push(message); }),
  };
  return {
    execs, recorded, notifications,
    row: () => map.get(STATUS_KEY) as StudioStatus,
    lock: () => map.get(OPERATION_KEY),
    setLock: (v: unknown) => { map.set(OPERATION_KEY, v); },
    setPane: (p: string, second = p) => { current = captured(p, second); },
    setNow: (iso: string) => { now = new Date(iso); },
    switches: () => execs.filter((c) => c.includes("respawn-pane")).length,
    run: () => runAccountFailover(deps, storage, STUDIO_ID, async (s) => { recorded.push(s); }),
  };
}

// ---------------------------------------------------------------------------
// 1 — the bug itself: the row must stop lying WITHIN ONE TICK.
// ---------------------------------------------------------------------------
describe("#214 (1) — a dismissed modal clears degraded on the next tick", () => {
  it("modal dismissed, lead back at its input box: running, error gone, one tick", async () => {
    const s = studio(RECOVERED_IDLE);

    expect(await s.run()).toMatchObject({ kind: "recovered" });

    expect(s.row().state).toBe("running");
    expect(s.row().error).toBeNull();
  });

  it("the measured 23:32Z case: a lead that RESUMED and is repainting clears it too", async () => {
    const s = studio(WORKING(12));
    s.setPane(WORKING(12), WORKING(15));

    expect(await s.run()).toMatchObject({ kind: "recovered" });

    expect(s.row().state).toBe("running");
    expect(s.row().error).toBeNull();
  });

  it("the row is written to the registry too, not only to DO storage", async () => {
    const s = studio(RECOVERED_IDLE);
    await s.run();
    expect(s.recorded.at(-1)?.state).toBe("running");
    expect(s.recorded.at(-1)?.error).toBeNull();
  });

  it("clearing costs no switch, no relaunch and no second exec", async () => {
    const s = studio(RECOVERED_IDLE);
    await s.run();
    expect(s.execs).toEqual([paneCaptureCmd()]);
    expect(s.switches()).toBe(0);
  });

  it("the tick AFTER the clear writes nothing — no-spam is kept", async () => {
    const s = studio(RECOVERED_IDLE);
    await s.run();
    const writes = s.recorded.length;

    expect((await s.run()).kind).toBe("no-modal");
    expect(s.recorded).toHaveLength(writes);
  });
});

// ---------------------------------------------------------------------------
// 2 — the modal still up must STAY degraded.
// ---------------------------------------------------------------------------
describe("#214 (2) — a modal still on screen never clears anything", () => {
  it("still parked on the limit: already-degraded, row untouched", async () => {
    const s = studio(V2_SESSION_LIMIT_RULE_PANE, { now: "2026-09-24T12:10:00.000Z" });

    expect((await s.run()).kind).toBe("already-degraded");

    expect(s.row().state).toBe("degraded");
    expect(s.row().error).toBe(EXHAUSTED);
    expect(s.row().exhaustionClearedAt ?? null).toBeNull();
  });

  it("a STILL-LIVE block on the first capture never clears, even when the pane repaints", async () => {
    // The pane repaints (so detectRateLimitModal short-circuits to `working`
    // before it ever looks at the shape) but the FIRST capture still holds a
    // live limit block, with claude's footer at the bottom under it. The clear
    // reads that first capture itself, so it must refuse.
    const s = studio(V2_SESSION_LIMIT_RULE_PANE, { now: "2026-09-24T12:10:00.000Z" });
    s.setPane(V2_SESSION_LIMIT_RULE_PANE, `${V2_SESSION_LIMIT_RULE_PANE}\n✻ Thinking… (3s)`);

    expect((await s.run()).kind).toBe("no-modal");

    expect(s.row().state).toBe("degraded");
    expect(s.row().error).toBe(EXHAUSTED);
    expect(s.row().exhaustionClearedAt ?? null).toBeNull();
  });

  it("a STALE block IS cleared — its reset passed, so the lead is not parked", async () => {
    // The other half of the live/stale split this file's detector already
    // makes everywhere else (`rateLimited` is cleared on a stale block too):
    // the text is still on screen, but the limit it names is over, claude is
    // back at its input box, and the wake gate lets wakes through. A row
    // still reading "parked on the rate-limit modal" then is the same lie.
    const s = studio(V2_SESSION_LIMIT_RULE_PANE, { now: "2026-09-24T14:00:00.000Z" });

    expect(await s.run()).toMatchObject({ kind: "recovered" });

    expect(s.row().state).toBe("running");
    expect(s.switches()).toBe(0);
  });

  it("a degradation this feature did NOT write is never healed", async () => {
    const s = studio(RECOVERED_IDLE, { row: { error: "clone failed: repository not found" } });

    expect((await s.run()).kind).toBe("no-modal");

    expect(s.row().state).toBe("degraded");
    expect(s.row().error).toBe("clone failed: repository not found");
  });

  it("an exhaustion message naming a DIFFERENT studio is never healed", async () => {
    const s = studio(RECOVERED_IDLE, {
      row: { error: exhaustedMessage("fleetflare--scratch", ["CLAUDE_CODE_OAUTH_TOKEN"]) },
    });

    expect((await s.run()).kind).toBe("no-modal");
    expect(s.row().state).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// 3 — #186's rule, unchanged: no claude at the bottom, no clear.
// ---------------------------------------------------------------------------
describe("#214 (3) — the switched-block redraw path still behaves per #186", () => {
  it("claude's dead frame above a bash prompt clears NOTHING: not the row, not the guard", async () => {
    const s = studio(DEAD_FRAME, {
      row: { failoverBlock: "You've hit your session limit · 1:30pm (UTC)" },
    });

    expect((await s.run()).kind).toBe("no-modal");

    expect(s.row().state).toBe("degraded");
    expect(s.row().error).toBe(EXHAUSTED);
    expect(s.row().failoverBlock).toBe("You've hit your session limit · 1:30pm (UTC)");
  });

  it("a REPAINTING pane clears the row but keeps the redraw guard (#186)", async () => {
    const s = studio(WORKING(12), {
      row: { failoverBlock: "You've hit your session limit · 1:30pm (UTC)" },
    });
    s.setPane(WORKING(12), WORKING(15));

    expect(await s.run()).toMatchObject({ kind: "recovered" });

    expect(s.row().state).toBe("running");
    expect(s.row().failoverBlock).toBe("You've hit your session limit · 1:30pm (UTC)");
  });

  it("a STATIC pane with claude at the bottom still retires the guard (#186), and clears the row", async () => {
    const s = studio(RECOVERED_IDLE, {
      row: { failoverBlock: "You've hit your session limit · 1:30pm (UTC)" },
    });

    expect(await s.run()).toMatchObject({ kind: "recovered" });

    expect(s.row().state).toBe("running");
    expect(s.row().failoverBlock ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4 — WHEN it cleared, recorded.
// ---------------------------------------------------------------------------
describe("#214 (4) — the clear is stamped", () => {
  it("records the instant it cleared, on the row and in the outcome", async () => {
    const s = studio(RECOVERED_IDLE);

    expect(await s.run()).toEqual({ kind: "recovered", clearedAt: NOW });

    expect(s.row().exhaustionClearedAt).toBe(NOW);
  });

  it("the stamp survives later ticks — it is a record, not a flag", async () => {
    const s = studio(RECOVERED_IDLE);
    await s.run();
    s.setNow("2026-09-25T00:12:00.000Z");
    await s.run();
    expect(s.row().exhaustionClearedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// 5 — #85 PR1's op lock. The token write on the switch path holds
// OPERATION_KEY; a provision/restart/recycle holds the SAME lock while it
// rewrites this row. The clear must not race it.
// ---------------------------------------------------------------------------
describe("#214 (5) — the clear yields to a FRESH op lock (#85 PR1)", () => {
  it("a provision holding the lock keeps its row: no clear this tick", async () => {
    const s = studio(RECOVERED_IDLE);
    const fresh = new Date(Date.parse(NOW) - 5 * 60 * 1000).toISOString();
    s.setLock({ op: "provision", since: fresh });

    expect((await s.run()).kind).toBe("no-modal");

    expect(s.row().state).toBe("degraded");
    // And the lock is the provision's, untouched — this path never takes it.
    expect(s.lock()).toEqual({ op: "provision", since: fresh });
  });

  it("the very next tick, with the lock released, clears it", async () => {
    const s = studio(RECOVERED_IDLE);
    s.setLock({ op: "provision", since: new Date(Date.parse(NOW) - 5 * 60 * 1000).toISOString() });
    await s.run();
    s.setLock(null);

    expect(await s.run()).toMatchObject({ kind: "recovered" });
    expect(s.row().state).toBe("running");
  });

  it("a STALE lock is no lock at all — it must not block the clear forever", async () => {
    const s = studio(RECOVERED_IDLE);
    s.setLock({ op: "provision", since: new Date(Date.parse(NOW) - OPERATION_STALE_MS - 1000).toISOString() });

    expect(await s.run()).toMatchObject({ kind: "recovered" });
    expect(s.row().state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// #232 — a LIVE limit block anywhere on screen vetoes the heal.
//
// inlineLimitBlock (this file's own bottom-anchored detector) only recognizes
// a limit block immediately followed by claude's idle input box (or,
// hint-less, ending at its own reset) within a few lines. PR #225 (#214)
// healed a degraded row the moment THAT check missed the block — but the
// block can still be sitting on screen, just not right at the very bottom: a
// mid-turn "/loop wakeup" line, a "Waiting for N background agent" row,
// wrapped queued text past its row budget, or a stray line before the footer
// all push the very same still-live block out of the bottom-anchored
// detector's reach without moving it off screen at all. Every pane below is
// REAL_PILOT_PANE (measured 2026-09-24 12:28:38Z; session limit resets 1:30pm
// UTC = 13:30Z that day) with exactly that kind of line inserted.
// ---------------------------------------------------------------------------
describe("#232 — a LIVE limit block anywhere on screen vetoes the heal", () => {
  const AT_WRITE = "2026-09-24T12:28:38.000Z";
  const AT_TICK = "2026-09-24T12:33:00.000Z";

  const MIDTURN_PANE = REAL_PILOT_PANE.replace(
    "✻ Cogitated for 0s",
    "✻ Claude resuming /loop wakeup (Sep 24 12:33pm)\n✻ Cogitating… (0s · esc to interrupt)",
  );
  const BACKGROUND_AGENT_PANE = REAL_PILOT_PANE.replace(
    "✻ Cogitated for 0s", "✻ Waiting for 1 background agent to finish",
  );
  const WRAPPED_QUEUED_INPUT_PANE = REAL_PILOT_PANE.replace(
    /❯\s+keep going/u,
    [
      "❯ keep going",
      "  and don't stop until the gallery task is fully done, tests green,",
      "  PR opened, and the loop checklist ticked off before handing it back",
      "  — keep pushing through any transient CI flake on your own instead",
      "  of waiting for me to confirm each step along the way, understood?",
    ].join("\n"),
  );
  const STRAY_ROW_BEFORE_FOOTER_PANE = REAL_PILOT_PANE.replace(
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    "  [CAVEMAN]\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  );

  // Issue #241 (f): a hint-less session-limit headline whose OWN zone wraps
  // onto the next row ("(UTC)" is not on the headline's own line) — a
  // genuinely different wrap shape from MONTHLY_SPEND_THREE_ROW_WRAP_PANE
  // (which wraps a HINT-CARRYING headline). inlineLimitBlock's own hint-less
  // branch never recognizes this one bottom-anchored either way (it tests
  // the headline's row alone), so this pane exercises the position-free veto
  // no matter what follows the block — pins mutant V5, the EXISTING 1-line
  // then 2-line fallback inlineLimitCandidate already tries when no hint
  // line is found in the window.
  const SESSION_LIMIT_WRAPPED_ZONE_PANE = [
    "⏺ Opening the PR for the pilot fix.", "",
    "  ⎿  You've hit your session limit · resets 3pm",
    "     (UTC)",
    "", ...RULE_PROMPT,
  ].join("\n");

  // Issue #241 (g): an OLDER block, already stale by the time of this check
  // ("4:30am (UTC)", checked at 12:33Z the same day), sits ABOVE a second,
  // genuinely live block (REAL_PILOT_PANE's own "1:30pm (UTC)" wording) —
  // realistic mid-turn content ("Waiting for 1 background agent to finish")
  // between them, and more mid-turn content after the live one so the
  // bottom-anchored detector cannot find it either. Pins mutant V9:
  // anyLiveLimitLineOnScreen must scan EVERY INLINE_LIMIT_LINE row in the
  // tail, not stop at the first (stale) one.
  const STALE_THEN_LIVE_SESSION_LIMIT_PANE = [
    "✻ Claude resuming /loop wakeup (Sep 24 4:35am)",
    "  ⎿  You've hit your session limit · resets 4:30am (UTC)",
    "     /upgrade to increase your usage limit.",
    "",
    "✻ Waiting for 1 background agent to finish",
    "",
    "⏺ Agent failed: You've hit your session limit · resets 1:30pm (UTC)",
    "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
    "     /upgrade to increase your usage limit.",
    "",
    "❯ go on",
    "",
    "⏺ Resumed; batch 2 running.",
    "",
    "✻ Cooked for 2m 1s",
    "",
    ...RULE_PROMPT,
  ].join("\n");

  /** Degrade the row FOR REAL — an actual `exhausted` tick against the
   *  unmodified, fully-recognized real pilot pane — so the notify mock
   *  carries exactly the one legitimate card, and any later call this test
   *  sees is provably a DUPLICATE rather than an artifact of a hand-set
   *  fixture row (studio()'s own default preset is degraded already; this
   *  bypasses it on purpose). */
  async function degradedByRealExhaustion() {
    const s = studio(REAL_PILOT_PANE, { row: { state: "running", error: null }, now: AT_WRITE });
    expect(await s.run()).toMatchObject({ kind: "exhausted" });
    expect(s.row().state).toBe("degraded");
    expect(s.notifications).toHaveLength(1);
    return s;
  }

  it("(a) a mid-turn '/loop wakeup' + spinner between the block and the footer stays degraded", async () => {
    const s = await degradedByRealExhaustion();

    s.setNow(AT_TICK);
    s.setPane(MIDTURN_PANE, MIDTURN_PANE.replace("(0s · esc to interrupt)", "(1s · esc to interrupt)"));
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");
    expect(s.notifications).toHaveLength(1);

    // A second tick, 12:38Z, with a brand-new bottom-anchored capture of the
    // SAME still-live block: the anti-loop guard (same message, still
    // degraded) must answer `already-degraded`, never write a second card.
    s.setNow("2026-09-24T12:38:00.000Z");
    s.setPane(REAL_PILOT_PANE);
    expect((await s.run()).kind).toBe("already-degraded");
    expect(s.row().state).toBe("degraded");
    expect(s.notifications).toHaveLength(1);
  });

  it("(b) '✻ Waiting for 1 background agent to finish' in place of the turn-ended row stays degraded", async () => {
    const s = await degradedByRealExhaustion();

    s.setNow(AT_TICK);
    s.setPane(BACKGROUND_AGENT_PANE);
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");
    expect(s.notifications).toHaveLength(1);
  });

  it("(c) queued input wrapped past its row budget stays degraded", async () => {
    const s = await degradedByRealExhaustion();

    s.setNow(AT_TICK);
    s.setPane(WRAPPED_QUEUED_INPUT_PANE);
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");
    expect(s.notifications).toHaveLength(1);
  });

  it("(d) a stray row between the closing rule and the footer stays degraded", async () => {
    const s = await degradedByRealExhaustion();

    s.setNow(AT_TICK);
    s.setPane(STRAY_ROW_BEFORE_FOOTER_PANE);
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");
    expect(s.notifications).toHaveLength(1);
  });

  it("positive control: a genuinely recovered pane with NO limit block anywhere still heals", async () => {
    const s = await degradedByRealExhaustion();

    s.setNow("2026-09-24T13:37:00.000Z");
    s.setPane(WORKING(12), WORKING(15));
    expect(await s.run()).toMatchObject({ kind: "recovered" });
    expect(s.row().state).toBe("running");
  });

  it("positive control: a STALE block that is not bottom-anchored does not veto the heal", async () => {
    const s = await degradedByRealExhaustion();

    // Past the block's own printed reset (13:30Z): the SAME position-broken
    // pane as (a), but now the block itself is stale, so the veto must not
    // fire — PR #225's own "a stale block clears" behaviour, unchanged.
    s.setNow("2026-09-24T14:00:00.000Z");
    s.setPane(MIDTURN_PANE);
    expect(await s.run()).toMatchObject({ kind: "recovered" });
    expect(s.row().state).toBe("running");
  });

  // -------------------------------------------------------------------------
  // Issue #241 — a reviewer follow-up to this very veto: inlineLimitCandidate
  // (the position-free candidate builder just above) only ever tried a 1- or
  // 2-line join before giving up on a readable reset, while inlineLimitBlock's
  // OWN block() closure (the bottom-anchored detector right next to it) scans
  // forward for the hint line and joins however many rows that scan needs. A
  // real monthly-spend headline can wrap across THREE rows before its hint —
  // the headline text itself splits, then the reset sits on a third row — and
  // the 2-line cap never reached it: `m` stayed null, and a block with NO
  // readable reset reads LIVE FOREVER by limitKeyIsLive's own rule. MEASURED:
  // a stale monthly block stayed `degraded` under this bug while the SAME pane
  // correctly read as recovered by inlineLimitBlock's own detector once it was
  // (re-)bottom-anchored.
  // -------------------------------------------------------------------------
  it("(e) a monthly-spend headline wrapped across THREE rows before its hint: live while its reset is ahead, heals once it passes, even off the bottom anchor", async () => {
    const s = studio(MONTHLY_SPEND_THREE_ROW_WRAP_PANE, {
      row: { state: "running", error: null }, now: "2026-09-25T20:00:00.000Z",
    });
    // Bottom-anchored: inlineLimitBlock's own block() already joins all three
    // rows correctly, so this direction was already right even with the bug.
    expect(await s.run()).toMatchObject({ kind: "exhausted" });
    expect(s.row().state).toBe("degraded");

    // The SAME block, now off the bottom anchor (a resumed turn ran above the
    // ruled box), clock still before the block's own reset (Sep 26 1am
    // Europe/Madrid = Sep 25 23:00Z): the position-free veto must find the
    // SAME reset the bottom-anchored detector found and keep this degraded.
    s.setNow("2026-09-25T22:00:00.000Z");
    s.setPane(MONTHLY_SPEND_THREE_ROW_WRAP_MIDTURN_PANE);
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");

    // Past the reset now (00:30Z the next day): the SAME position-broken pane
    // must heal. Today's bug leaves `m` null forever in inlineLimitCandidate
    // (its 2-line join never reaches the 3rd row), so the veto never sees the
    // reset pass and this stays wrongly degraded.
    s.setNow("2026-09-26T00:30:00.000Z");
    expect(await s.run()).toMatchObject({ kind: "recovered" });
    expect(s.row().state).toBe("running");
  });

  it("(f) a hint-less session headline whose zone wraps to the next row still vetoes while live, and lifts once its own reset passes [pins mutant V5: the existing 1-then-2-line fallback]", async () => {
    const s = await degradedByRealExhaustion();

    // Before the wrapped block's own reset (3pm UTC, ~2.5h ahead, so still
    // within the session window): must veto. The headline row alone has no
    // readable reset ("(UTC)" is on the next line), so this exercises the
    // SAME 1-line-then-2-line fallback inlineLimitCandidate already falls
    // back to when no hint line is found in the window — unrelated to the
    // new multi-row HINT-aware join (e) exercises, and must keep working
    // exactly as it does today.
    s.setNow(AT_TICK);
    s.setPane(SESSION_LIMIT_WRAPPED_ZONE_PANE);
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");

    // Just past 3pm UTC: the SAME pane must now heal. An unreadable reset
    // (`m` null) reads LIVE FOREVER by limitKeyIsLive's own rule, so this
    // second half is what actually distinguishes "the fallback found the
    // reset" from "the fallback found nothing and defaulted to live" — the
    // first half alone cannot tell those apart.
    s.setNow("2026-09-24T15:05:00.000Z");
    expect(await s.run()).toMatchObject({ kind: "recovered" });
    expect(s.row().state).toBe("running");
  });

  it("(g) an older stale block above a genuinely live one still vetoes the heal [pins mutant V9: scan EVERY tail candidate, not just the first]", async () => {
    const s = await degradedByRealExhaustion();

    s.setNow(AT_TICK);
    s.setPane(STALE_THEN_LIVE_SESSION_LIMIT_PANE);
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");
  });

  const MIDTURN_TAIL = ["", "❯ go on", "", "⏺ Resumed; batch 2 running.", "", "✻ Cooked for 2m 1s", "", ...RULE_PROMPT];
  /** NOT_DETECTED_106 (p)'s row: a reset-less out-of-credits row with no hint under it. */
  const OOC_NO_HINT = NOT_DETECTED_106["(p) out-of-credits line with no hint under it"].split("\n")[1];
  /** SYNTHETIC narrow pane: headline wraps over FOUR rows, hint on the window's last row (at + UPGRADE_HINT_WINDOW). */
  const MONTHLY_SPEND_FOUR_ROW_WRAP_BLOCK = [
    "  ⎿  You've hit your monthly spend limit · raise it at",
    "     claude.ai/settings/usage?from=cc_cli_limit_message",
    "     · your weekly limit resets Sep 26 at",
    "     1am (Europe/Madrid)",
    "     /usage-credits to adjust your monthly spend limit.",
  ];

  it("(h) a headline wrapped over FOUR rows, hint on the window's last row: heals off-anchor once its reset passes [pins the hint-window bound]", async () => {
    const s = studio(["⏺ Opening the PR for the pilot fix.", "", ...MONTHLY_SPEND_FOUR_ROW_WRAP_BLOCK, "", "✻ Worked for 3s", "", ...RULE_PROMPT].join("\n"), {
      row: { state: "running", error: null }, now: "2026-09-25T20:00:00.000Z",
    });
    expect(await s.run()).toMatchObject({ kind: "exhausted" });
    s.setPane(["⏺ Opening the PR for the pilot fix.", "", ...MONTHLY_SPEND_FOUR_ROW_WRAP_BLOCK, "", "✻ Worked for 3s", ...MIDTURN_TAIL].join("\n"));
    s.setNow("2026-09-26T00:30:00.000Z");
    expect(await s.run()).toMatchObject({ kind: "recovered" });
    expect(s.row().state).toBe("running");
  });

  it("(i) a reset-less, hint-less row never borrows the NEXT block's reset across that block's ⎿ row [pins the glyph stop]", async () => {
    const s = await degradedByRealExhaustion();
    s.setNow(AT_TICK);
    s.setPane(["⏺ Checked the billing page.", OOC_NO_HINT, "",
      "  ⎿  You've hit your session limit · resets 4:30am (UTC)",
      "     /upgrade to increase your usage limit.", ...MIDTURN_TAIL].join("\n"));
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");
  });

  it("(j) a live block ABOVE an older stale one still vetoes [mirror of (g): every row, not last-only]", async () => {
    const s = await degradedByRealExhaustion();
    s.setNow(AT_TICK);
    s.setPane([
      "✻ Claude resuming /loop wakeup (Sep 24 12:26pm)",
      "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
      "     /upgrade to increase your usage limit.",
      "", "✻ Waiting for 1 background agent to finish", "",
      "⏺ Agent \"batch 1\" failed: You've hit your session limit · resets 4:30am (UTC)",
      "  ⎿  You've hit your session limit · resets 4:30am (UTC)",
      "     /upgrade to increase your usage limit.",
      ...MIDTURN_TAIL,
    ].join("\n"));
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");
  });

  it("(k) a hint-like row one past UPGRADE_HINT_WINDOW is never joined [pins the window's upper bound]", async () => {
    const s = await degradedByRealExhaustion();
    s.setNow(AT_TICK);
    s.setPane(["⏺ Checked the billing page.", OOC_NO_HINT,
      "─".repeat(68), "❯ note", "  your session limit resets 4:30am (UTC)", "  more", "  /login later",
      "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n"));
    expect((await s.run()).kind).not.toBe("recovered");
    expect(s.row().state).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Issue #241 (fix 4) — claude 2.1.281 draws a THIRD option in this modal
// ("Add funds to continue with usage credits") alongside "Stop and wait" and
// "Upgrade your plan", in either order depending on account state.
// bottomLimitModal already answers "is STOP_FOR_LIMIT_OPTION among the
// options", which does not care how many options there are or where it sits
// among them — so this pins that the EXISTING gate already refuses this
// shape correctly, end to end: a modal verdict (never inline), a degraded row
// left alone, and a wake that reaches the container with no send-keys.
// ---------------------------------------------------------------------------
describe("#241 (4) — the 3-option rate-limit modal is a modal, never inline, and heals nothing while it's up", () => {
  const VARIANTS = [
    ["numbered 1. Stop / 2. Add funds / 3. Upgrade", V1_THREE_OPTION_PANE],
    ["reordered 1. Add funds / 2. Upgrade / 3. Stop", V1_THREE_OPTION_FLIPPED_PANE],
  ] as const;

  for (const [name, pane] of VARIANTS) {
    it(`${name}: detectRateLimitModal reads it as a modal, never inline`, () => {
      const v = detectRateLimitModal(captured(pane));
      expect(v.kind).toBe("modal");
      if (v.kind === "modal") {
        expect(v.inline).toBeUndefined();
        expect(v.marker).toBe("Stop and wait for limit to reset");
      }
    });

    // Issue #109: this row is select-modal-shaped and genuinely exhausted, so
    // the auto-continue step now fires (an unknown-reset first attempt) on
    // this very tick — its own kind (`auto-continued`) REPLACES the old
    // silent `already-degraded` here, exactly as designed. The invariant
    // this test exists to pin — state/error stay `degraded`/EXHAUSTED,
    // untouched — is unaffected: that step never writes either field.
    it(`${name}: a degraded row stays degraded (state/error untouched by auto-continue)`, async () => {
      const s = studio(pane);
      expect((await s.run()).kind).toBe("auto-continued");
      expect(s.row().state).toBe("degraded");
      expect(s.row().error).toBe(EXHAUSTED);
    });

    it(`${name}: runGatedWake refuses — no send-keys reaches the container`, async () => {
      const cmds: string[] = [];
      const exec = vi.fn(async (cmd: string) => {
        cmds.push(cmd);
        if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
        return { code: 0, stdout: `${pane}\n`, stderr: "" };
      });
      const out = await runGatedWake({ recordedState: async () => "running", exec, now: () => new Date(NOW) }, "WAKE");
      expect(out.ok).toBe(false);
      expect(out.skipped).toBe(true);
      expect(out.error).toMatch(/^usage-limit modal open in studio:claude/);
      expect(cmds.some((c) => c.includes("send-keys"))).toBe(false);
    });
  }
});
