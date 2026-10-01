import { describe, it, expect, vi } from "vitest";
import {
  runAccountFailover, paneCaptureCmd, dismissModalCmd, DISMISS_VERDICT, exhaustedMessage,
  PANE_CAPTURE_MARKER, AUTO_CONTINUE_PROMPT, type FailoverDeps,
} from "../src/studio/failover";
import { PANE_PROBE_CMD, PANE_SCREEN_CMD, wakeCmd } from "../src/studio/wake";
import { STATUS_KEY, OPERATION_KEY, type StudioStorage, type OperationInFlight } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import type { ClaudeAccount } from "../src/studio/accounts";
import { RULE_PROMPT } from "./fixtures/rate-limit-panes";

// ---------------------------------------------------------------------------
// Issue #109 — the auto-continue due-ness/attempt state machine, run inside
// runAccountFailover's own `!next` branch. Same storage-level harness shape
// test/studio.account-failover.test.ts and test/studio.failover-274.test.ts
// already use — a live StudioDO cannot be constructed under
// vitest-pool-workers (see src/studio/do.ts's header).
// ---------------------------------------------------------------------------

const STUDIO_ID = "fleetflare--release-studio";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const TOKEN_1 = "sk-ant-oat01-" + "a".repeat(40);
const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
const ONE_ACCOUNT: ClaudeAccount[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 }];
const TWO_ACCOUNTS: ClaudeAccount[] = [...ONE_ACCOUNT, { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 }];

/** A select-style modal ("You've hit your org's monthly spend limit") — never
 *  inline, and the ONLY shape this feature acts on. Same frame every other
 *  runAccountFailover fixture in this repo already uses. */
const MODAL_PANE = [
  "⏺ Reading the release notes for the batch.",
  "",
  "⏺ Read(docs/release.md)",
  "  ⎿  Read 42 lines",
  "",
  "╭────────────────────────────────────────────────────────────────╮",
  "│ You've hit your org's monthly spend limit                      │",
  "│                                                                │",
  "│ Run /rate-limit-options to see what you can do.                │",
  "│                                                                │",
  "│ ❯ 1. Upgrade your plan                                         │",
  "│   2. Not now                                                   │",
  "╰────────────────────────────────────────────────────────────────╯",
].join("\n");

/** An inline session-limit block — claude prints it and returns to its input
 *  box. Excluded from the ACT step (self-clears through the EXISTING #214
 *  recovery once its own printed reset passes the clock). */
const INLINE_PANE = [
  "⏺ Opening the PR for the pilot fix.",
  "",
  "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
  "     /upgrade to increase your usage limit.",
  "",
  ...RULE_PROMPT,
].join("\n");

/** claude back at its input box: no modal, no limit block anywhere. */
const RECOVERED_IDLE = ["⏺ Resumed.", "", ...RULE_PROMPT].join("\n");

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

function fakeStorage(initial?: StudioStatus): StudioStorage {
  const map = new Map<string, unknown>();
  if (initial) map.set(STATUS_KEY, initial);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as StudioStorage["put"],
  };
}

const captured = (first: string, second = first) => `${first}\n${PANE_CAPTURE_MARKER}\n${second}\n`;

interface Harness {
  deps: FailoverDeps;
  storage: StudioStorage;
  recorded: StudioStatus[];
  execs: string[];
  run(): ReturnType<typeof runAccountFailover>;
  /** Issue #158: lets a test drive TWO ticks with genuinely different pane
   *  content (exhaust, then reset-passed-and-idle) through the SAME harness,
   *  the same `setPane` shape test/studio.account-failover.test.ts's own
   *  richer harness already uses. */
  setPane(pane: string): void;
  /** Issue #158: same reasoning as setPane — a reset-passed test needs the
   *  SECOND tick's clock to be later than the first's. */
  setNow(now: Date): void;
}

function harness(opts: {
  accounts: ClaudeAccount[];
  pane: string;
  initial?: StudioStatus;
  now?: Date;
  autoFailover?: boolean;
}): Harness {
  const execs: string[] = [];
  const recorded: StudioStatus[] = [];
  const storage = fakeStorage(opts.initial ?? status());
  let pane = opts.pane;
  let now = opts.now ?? NOW;
  const deps: FailoverDeps = {
    accounts: opts.accounts,
    autoFailover: opts.autoFailover ?? true,
    now: () => now,
    exec: vi.fn(async (cmd: string) => {
      execs.push(cmd);
      if (cmd === paneCaptureCmd()) return { code: 0, stdout: captured(pane), stderr: "" };
      // dismissModalCmd()'s own shell — the fake never runs a real shell, so
      // this stands in for it: report "escaped" (the modal was still there),
      // the common case for a fresh select-modal capture.
      if (cmd === dismissModalCmd()) return { code: 0, stdout: `${DISMISS_VERDICT} escaped\n`, stderr: "" };
      // runGatedWake's own gate 2 (pane_current_command) and gate 3
      // (screen). Answering both lets a due attempt reach a definite
      // ok/skipped verdict rather than the generic "no window" refusal.
      if (cmd === PANE_PROBE_CMD) return { code: 0, stdout: "studio:claude claude\n", stderr: "" };
      if (cmd === PANE_SCREEN_CMD) return { code: 0, stdout: `${RECOVERED_IDLE}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }),
    relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    notify: vi.fn(async () => {}),
  };
  return {
    deps, storage, recorded, execs,
    run: () => runAccountFailover(deps, storage, STUDIO_ID, async (s) => { recorded.push(s); }),
    setPane: (p: string) => { pane = p; },
    setNow: (n: Date) => { now = n; },
  };
}

const EXHAUSTED_ONE = exhaustedMessage(STUDIO_ID, ["CLAUDE_CODE_OAUTH_TOKEN"]);

describe("issue #109 — auto-continue due-ness", () => {
  it("known reset, not yet due: no exec beyond the probe, no write, auto-continue-waiting", async () => {
    const dueAt = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    const h = harness({
      accounts: ONE_ACCOUNT, pane: MODAL_PANE,
      initial: status({
        state: "degraded", error: EXHAUSTED_ONE, autoContinueAt: dueAt, autoContinueLastTriedAt: null,
        // Matches what THIS tick's own capture would compute — keeps
        // limitChanged false, so the pre-existing "a changed limit is still
        // written" path (unrelated to this feature) does not also fire and
        // obscure the "no write at all" claim this test is pinning.
        rateLimited: { until: null, seenAt: NOW.toISOString(), select: true },
      }),
    });

    const out = await h.run();

    expect(out).toEqual({ kind: "auto-continue-waiting", tried: ["CLAUDE_CODE_OAUTH_TOKEN"], dueAt });
    expect(h.recorded).toEqual([]);
    expect(h.execs).toEqual([paneCaptureCmd()]);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.autoContinueAt).toBe(dueAt);
    expect(stored?.autoContinueLastTriedAt ?? null).toBeNull();
  });

  it("known reset, due: dismiss + wake attempted, autoContinueLastTriedAt set, autoContinueAt consumed", async () => {
    const dueAt = new Date(NOW.getTime() - 1000).toISOString();
    const h = harness({
      accounts: ONE_ACCOUNT, pane: MODAL_PANE,
      initial: status({
        state: "degraded", error: EXHAUSTED_ONE, autoContinueAt: dueAt, autoContinueLastTriedAt: null,
      }),
    });

    const out = await h.run();

    expect(out.kind).toBe("auto-continued");
    if (out.kind === "auto-continued") {
      expect(out.dismissed).toBe(true);
      expect(["ok", "skipped", "failed"]).toContain(out.wake);
    }
    expect(h.execs).toContain(dismissModalCmd());
    expect(h.execs).toContain(PANE_PROBE_CMD);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.autoContinueAt ?? null).toBeNull();
    expect(stored?.autoContinueLastTriedAt).toBe(NOW.toISOString());
  });

  it("unknown reset, first tick: attempted immediately (autoContinueLastTriedAt was never set)", async () => {
    const h = harness({
      accounts: ONE_ACCOUNT, pane: MODAL_PANE,
      initial: status({
        state: "degraded", error: EXHAUSTED_ONE, autoContinueAt: null, autoContinueLastTriedAt: null,
      }),
    });

    const out = await h.run();

    // Same tick, so this row's own !next branch is the anti-loop-guard path
    // (already degraded for exactly this message) — the very first tick the
    // due-ness step ever runs against it.
    expect(out.kind).toBe("auto-continued");
    expect(h.execs).toContain(dismissModalCmd());
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.autoContinueLastTriedAt).toBe(NOW.toISOString());
  });

  it("unknown reset, second tick within 1h: no attempt, auto-continue-waiting", async () => {
    const lastTried = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    const h = harness({
      accounts: ONE_ACCOUNT, pane: MODAL_PANE,
      initial: status({
        state: "degraded", error: EXHAUSTED_ONE, autoContinueAt: null, autoContinueLastTriedAt: lastTried,
      }),
    });

    const out = await h.run();

    expect(out).toEqual({ kind: "auto-continue-waiting", tried: ["CLAUDE_CODE_OAUTH_TOKEN"], dueAt: null });
    expect(h.execs).toEqual([paneCaptureCmd()]);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.autoContinueLastTriedAt).toBe(lastTried);
  });

  it("unknown reset, after 1h: attempted again", async () => {
    const lastTried = new Date(NOW.getTime() - 61 * 60_000).toISOString();
    const h = harness({
      accounts: ONE_ACCOUNT, pane: MODAL_PANE,
      initial: status({
        state: "degraded", error: EXHAUSTED_ONE, autoContinueAt: null, autoContinueLastTriedAt: lastTried,
      }),
    });

    const out = await h.run();

    expect(out.kind).toBe("auto-continued");
    expect(h.execs).toContain(dismissModalCmd());
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.autoContinueLastTriedAt).toBe(NOW.toISOString());
  });
});

describe("issue #109 — never attempts outside the genuinely-exhausted select-modal path", () => {
  it("an inline exhausted block (nowhere to fail over) never attempts Esc or wake", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: INLINE_PANE });

    const first = await h.run();
    expect(first.kind).toBe("exhausted");

    const second = await h.run();

    // Unchanged: still the old, silent already-degraded — this feature never
    // evaluates an inline-exhausted row at all.
    expect(second.kind).toBe("already-degraded");
    expect(h.execs.filter((c) => c === dismissModalCmd())).toEqual([]);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.autoContinueAt).toBeUndefined();
    expect(stored?.autoContinueLastTriedAt).toBeUndefined();
  });

  it("'parked' (auto-failover off, a candidate exists) never writes or attempts auto-continue", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: MODAL_PANE, autoFailover: false });

    const out = await h.run();

    expect(out).toEqual({ kind: "parked", account: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(h.execs.filter((c) => c === dismissModalCmd())).toEqual([]);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.autoContinueAt).toBeUndefined();
    expect(stored?.autoContinueLastTriedAt).toBeUndefined();

    // The tick after stays silently parked — this feature's own step never
    // evaluates the "parked" path, matching parkedMessage's own "no switch
    // attempted" contract.
    const second = await h.run();
    expect(second.kind).toBe("already-degraded");
    expect(h.execs.filter((c) => c === dismissModalCmd())).toEqual([]);
  });
});

describe("issue #158 — inline exhaustion gets a wake once its own reset passes (#214 heal)", () => {
  it("inline exhausted, reset still live: #214 heal never fires, so no wake attempt either", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: INLINE_PANE });

    const first = await h.run();
    expect(first.kind).toBe("exhausted");

    // Still showing the SAME inline block (the pane never changed, and the
    // reset — 1:30pm UTC — is still ahead of NOW, noon UTC): #214's own
    // evidence rule never heals it, so this feature's new wake never gets a
    // chance to fire either. The existing "never attempts Esc or wake" test
    // above pins the silent already-degraded outcome; this pins the
    // wake-specific half of the same still-live tick.
    const second = await h.run();
    expect(second.kind).toBe("already-degraded");
    expect(h.execs.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toEqual([]);
  });

  it("inline exhausted, reset passed and the pane is idle: exactly one gated wake with AUTO_CONTINUE_PROMPT", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: INLINE_PANE });

    const first = await h.run();
    expect(first.kind).toBe("exhausted");

    // The reset (1:30pm UTC) has passed, and the pane has genuinely
    // recovered — claude's own footer at the bottom, no limit anywhere —
    // so #214's own heal fires, and this is the healing tick.
    h.setPane(RECOVERED_IDLE);
    h.setNow(new Date("2026-09-30T14:00:00.000Z"));
    const second = await h.run();

    expect(second.kind).toBe("recovered");
    // Never the select-modal path's own Esc — this row was never eligible
    // for that (verdict.inline was true throughout).
    expect(h.execs.filter((c) => c === dismissModalCmd())).toEqual([]);
    expect(h.execs.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toHaveLength(1);
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.state).toBe("running");
  });

  // Maestro review round 2 (PR #170, direct against real Claude Code
  // behavior), finding 3 — the test THIS replaces got the exclusion wrong.
  // #158's own text is explicit: the inline-reset wake fires "independent of
  // FLEET_AUTO_FAILOVER" — only a SELECT-MODAL-triggered park must stay
  // permanently manual (that's #109's ORIGINAL scope, via `rateLimited.select`,
  // nothing to do with auto-failover). An INLINE-triggered park (a free
  // second account existed, but `autoFailover` was off so nothing switched)
  // is, evidence-wise, indistinguishable from a genuine inline exhaustion —
  // same reset, same self-clearing shape — and #158 explicitly wants THIS
  // case to heal and wake too, same as any other inline block. `exhaustionKind`
  // (stamped from `verdict.inline`/`verdict.dead` at write time, independent
  // of `parkedOn`/auto-failover) is what the heal now reads, replacing the
  // old `operatorParked` exclusion that wrongly blocked this case.
  it("'parked' via an INLINE block (auto-failover off, a candidate existed) still gets the heal wake, same as any inline exhaustion", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: INLINE_PANE, autoFailover: false });

    const first = await h.run();
    expect(first).toEqual({ kind: "parked", account: "CLAUDE_CODE_OAUTH_TOKEN" });

    // The pane recovers and its printed reset has passed.
    h.setPane(RECOVERED_IDLE);
    h.setNow(new Date("2026-09-30T14:00:00.000Z"));
    const second = await h.run();

    expect(second.kind).toBe("recovered");
    expect(h.execs.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toHaveLength(1);
  });

  // Finding 3's counterpart: a SELECT-MODAL-triggered park must stay
  // permanently manual — #109's original scope, untouched by this change.
  // Pins the existing "'parked' (auto-failover off...) never writes or
  // attempts auto-continue" test's own claim specifically against the heal
  // wake too (that test, above, only pins the INITIAL tick; this one drives
  // a second, healing tick the same way the inline case above does).
  it("'parked' via a SELECT-MODAL block (auto-failover off) never gets a heal wake — stays permanently manual", async () => {
    const h = harness({ accounts: TWO_ACCOUNTS, pane: MODAL_PANE, autoFailover: false });

    const first = await h.run();
    expect(first).toEqual({ kind: "parked", account: "CLAUDE_CODE_OAUTH_TOKEN" });

    h.setPane(RECOVERED_IDLE);
    h.setNow(new Date("2026-09-30T14:00:00.000Z"));
    const second = await h.run();

    expect(second.kind).toBe("recovered");
    expect(h.execs.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toEqual([]);
  });

  // Maestro review round 2 (PR #170), finding 4 — `runAccountFailover`'s
  // `working` branch independently nulls `existing.rateLimited` whenever the
  // pane shows no current limit, REGARDLESS of whether heal itself fired
  // this tick (the `else if (existing.rateLimited || forget)` write,
  // unrelated to the heal gate). Before `exhaustionKind`, the heal wake's own
  // `existing.rateLimited != null` check read this nulled value on a LATER
  // tick where heal genuinely succeeds, silently losing the wake.
  // `exhaustionKind` is never touched by that independent write, so it
  // survives across ticks the way `rateLimited`'s own live shape never did.
  it("a tick that nulls rateLimited WITHOUT healing (op lock fresh) does not cost a LATER genuine heal its wake", async () => {
    const h = harness({ accounts: ONE_ACCOUNT, pane: INLINE_PANE });

    const first = await h.run();
    expect(first.kind).toBe("exhausted");

    // Tick 2: the pane has ALREADY recovered and the reset has passed (the
    // evidence `evaluateDegradedRecovery` would otherwise heal on), but a
    // bring-up holds a FRESH operation lock — `healDegradedRowAndWake`'s own
    // `opLockFresh` gate refuses to heal this tick. The row stays `degraded`,
    // yet `runAccountFailover`'s OWN independent `rateLimited`-null write
    // still fires (the pane shows no current limit).
    const operation: OperationInFlight = { op: "restart", since: "2026-09-30T13:58:00.000Z" };
    await h.storage.put(OPERATION_KEY, operation);
    h.setPane(RECOVERED_IDLE);
    h.setNow(new Date("2026-09-30T14:00:00.000Z"));
    const second = await h.run();
    expect(second.kind).toBe("no-modal");
    const midStored = await h.storage.get(STATUS_KEY);
    expect(midStored?.state).toBe("degraded");
    expect(midStored?.rateLimited ?? null).toBeNull();

    // Tick 3: the lock has released — heal genuinely fires now. Before the
    // fix, `rateLimited` was already nulled by tick 2, so the heal wake's own
    // shape check silently refused to fire even though this IS the genuine
    // healing tick.
    await h.storage.put(OPERATION_KEY, null);
    h.setNow(new Date("2026-09-30T14:16:00.000Z")); // past OPERATION_STALE_MS too, belt and suspenders
    const third = await h.run();

    expect(third.kind).toBe("recovered");
    expect(h.execs.filter((c) => c === wakeCmd(AUTO_CONTINUE_PROMPT))).toHaveLength(1);
  });
});

describe("issue #109 — the #214 working-branch recovery clears both new fields", () => {
  it("a genuinely recovered row carries no stale auto-continue bookkeeping forward", async () => {
    const h = harness({
      accounts: ONE_ACCOUNT, pane: RECOVERED_IDLE,
      initial: status({
        state: "degraded", error: EXHAUSTED_ONE,
        autoContinueAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
        autoContinueLastTriedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      }),
    });

    const out = await h.run();

    expect(out.kind).toBe("recovered");
    const stored = await h.storage.get(STATUS_KEY);
    expect(stored?.state).toBe("running");
    expect(stored?.autoContinueAt ?? null).toBeNull();
    expect(stored?.autoContinueLastTriedAt ?? null).toBeNull();
  });
});
