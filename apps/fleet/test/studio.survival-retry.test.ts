// Issue #697 (S26-F10): this file is the RETRY half of the split of
// test/studio.survival-delivery.test.ts — deliverSurvivalBriefOnBringup, the
// pending-marker deferral, and retryPendingSurvivalBrief riding the sync
// tick. The input half lives in test/studio.survival-input.test.ts; every
// it() below moved here verbatim in that split.

// Issue #249 (PR4b) — DELIVERY of #107/#150's survival re-brief.
//
// Same discipline as test/studio.wake-gate.test.ts's own
// `deliverAssignedTaskOnBringup` block, which this feature's delivery function
// is deliberately a sibling of: a fake `ObservedStorage` over a plain Map and
// fake thunks, NO DO construction (StudioDO cannot be constructed under
// vitest-pool-workers — src/studio/do.ts's own header), so every gate is
// exercised against the real function rather than through a mock of it.
//
// Every `it` below pins a LOAD-BEARING guard. The mutation checks each one
// answers are named in the PR body; the shape of the suite is "delete one
// guard, one named test goes red".

import { describe, it, expect, vi } from "vitest";
import {
  paneBusy, composeSurvivalDelivery, deliverSurvivalBriefOnBringup,
  retryPendingSurvivalBrief, retryBoundExceeded,
  SURVIVAL_RETRY_MAX_ATTEMPTS, SURVIVAL_RETRY_WINDOW_MS,
  type ComposedBrief, type SurvivalSources, type SurvivalBringup,
} from "../src/studio/survival-delivery";
import { PANE_CAPTURE_MARKER, PANE_QUIESCE_SECONDS } from "../src/studio/failover";
import { composeSurvivalBrief } from "../src/studio/survival-brief";
import {
  OBSERVED_KEY, emptyObserved,
  type BringupVia, type Observed, type ObservedSession, type ObservedStorage,
  type SurvivalBriefPending,
} from "../src/studio/observed";
import type { WakeOutcome } from "../src/studio/wake";
import { TERMINAL_TASK_STATES, LIVE_TASK_STATES } from "../src/board/types";
import { env } from "cloudflare:test";
import { REAL_WEBSTUDIO_PANE } from "./fixtures/rate-limit-panes";

const STUDIO = "fleetflare--web-studio";
const NOW = "2026-09-25T12:00:00.000Z";

/** The narrow ObservedStorage port over a plain Map — the same fakeStorage
 *  shape test/studio.observed.test.ts and test/studio.wake-gate.test.ts use. */
function fakeObserved(seed?: Partial<Observed>) {
  const map = new Map<string, Observed>();
  if (seed) map.set(OBSERVED_KEY, { ...emptyObserved(), ...seed });
  const storage: ObservedStorage = {
    get: async () => map.get(OBSERVED_KEY),
    put: async (_key, value) => { map.set(OBSERVED_KEY, value); },
  };
  return { map, storage, stored: () => map.get(OBSERVED_KEY) };
}

function session(over: Partial<ObservedSession> = {}): ObservedSession {
  return {
    verdict: "resumed", at: NOW, via: "recycle", restore: "restored",
    snapshotAgeS: 600, turnsBefore: 12, reason: null, ...over,
  };
}

// A REAL `tmux capture-pane -p` of fleetflare--web-studio (#106's own capture
// set, test/fixtures/rate-limit-panes.ts): claude's footer at the bottom with
// an agent panel of two members under it. Used rather than a synthetic pane
// precisely because the agent panel is what makes `aboveAgentPanel` load-
// bearing — the panel ticks its own timers while the LEAD is idle.
const IDLE_PANE = REAL_WEBSTUDIO_PANE;

/** The same pane with claude's live status line in it — the one row it prints
 *  only while a turn is actually running. */
const MIDTURN_PANE = IDLE_PANE.replace(
  "✻ Cooked for 36m 35s · 7 shells still running",
  "✻ Cogitating… (12s · ↑ 1.4k tokens · esc to interrupt)",
);

/** `paneCaptureCmd()`'s stdout shape: two observations around the marker. */
const captured = (first: string, second = first) => `${first}\n${PANE_CAPTURE_MARKER}\n${second}\n`;

const IDLE = captured(IDLE_PANE);

function sources(over: Partial<SurvivalSources> = {}): SurvivalSources {
  return {
    studioId: STUDIO,
    pull: async () => null,
    rescueBranches: async () => [],
    compareAhead: async () => ({ aheadBy: 3, lastCommitAt: "2026-09-25T11:00:00.000Z" }),
    openPullNumbers: async () => [],
    branchNames: async () => ({ names: [], truncated: false }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The delivery itself
// ---------------------------------------------------------------------------

const INCARNATION = "inc-aaaaaaaa";

function bringup(over: Partial<SurvivalBringup> = {}): SurvivalBringup {
  return { incarnation: INCARNATION, via: "recycle", replacementDetected: false, session: session(), ...over };
}

/** The five thunks, all defaulted to "a clean, allowed, idle delivery". */
function harness(over: {
  seed?: Partial<Observed>;
  bringup?: SurvivalBringup | null;
  busyStdout?: string;
  brief?: ComposedBrief;
  wake?: WakeOutcome;
  moved?: () => Promise<boolean>;
} = {}) {
  const observed = fakeObserved(over.seed ?? { session: session() });
  const busy = vi.fn(async () => paneBusy(over.busyStdout ?? IDLE));
  const compose = vi.fn(async (): Promise<ComposedBrief> =>
    over.brief ?? "What survived, studio:\n- Task branches: none");
  const wake = vi.fn(async (): Promise<WakeOutcome> => over.wake ?? { ok: true });
  const moved = vi.fn(over.moved ?? (async () => false));
  const trigger = vi.fn(async () => (over.bringup === undefined ? bringup() : over.bringup));
  const run = () =>
    deliverSurvivalBriefOnBringup(observed.storage, trigger, busy, compose, wake, moved);
  return { observed, trigger, busy, compose, wake, moved, run };
}

describe("deliverSurvivalBriefOnBringup — the delivery", () => {
  it("an allowed recycle bring-up on an idle pane: exactly one wake, carrying the composed brief", async () => {
    const h = harness({ brief: "What survived, s:\n- Task #249 \"x\": b — 3 commits ahead of main, last 1h ago" });
    expect(await h.run()).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.wake).toHaveBeenCalledWith(
      "What survived, s:\n- Task #249 \"x\": b — 3 commits ahead of main, last 1h ago",
    );
    expect(h.observed.stored()?.survivalBriefDeliveredFor).toBe(INCARNATION);
  });

  it("no bring-up verdict at all: nothing composed, nothing probed, nothing woken", async () => {
    const h = harness({ bringup: null });
    expect(await h.run()).toEqual({ kind: "skipped", reason: "no bring-up verdict recorded" });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.busy).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("THE ALLOWLIST GATE — a denied `via` costs no I/O at all and writes nothing", async () => {
    for (const via of ["adopted", "failover"] as BringupVia[]) {
      // With replacementDetected TRUE, so only the hard denial can stop it.
      const h = harness({ bringup: bringup({ via, replacementDetected: true }) });
      expect(await h.run()).toEqual({
        kind: "skipped", reason: `via ${via} with a detected replacement is not a re-brief trigger`,
      });
      expect(h.compose).not.toHaveBeenCalled();
      expect(h.busy).not.toHaveBeenCalled();
      expect(h.wake).not.toHaveBeenCalled();
      expect(h.moved).not.toHaveBeenCalled();
      expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
    }
  });

  it("THE ALLOWLIST GATE — a plain provision with no replacement is denied; with one, delivered", async () => {
    const denied = harness({ bringup: bringup({ via: "provision", replacementDetected: false }) });
    expect(await denied.run()).toEqual({
      kind: "skipped", reason: "via provision is not a re-brief trigger",
    });
    expect(denied.wake).not.toHaveBeenCalled();

    const allowed = harness({ bringup: bringup({ via: "provision", replacementDetected: true }) });
    expect(await allowed.run()).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(allowed.wake).toHaveBeenCalledTimes(1);
  });

  it("DEDUP PER INCARNATION — the same incarnation delivers exactly once, across two bring-ups", async () => {
    const h = harness();
    expect(await h.run()).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(await h.run()).toEqual({
      kind: "skipped", reason: `already delivered for incarnation ${INCARNATION}`,
    });
    expect(h.wake).toHaveBeenCalledTimes(1);
  });

  it("DEDUP PER INCARNATION — a NEW incarnation token delivers again", async () => {
    // The re-brief describes what survived a container replacement, so the
    // container identity is what it can only usefully be said once about.
    const observed = fakeObserved({ session: session(), survivalBriefDeliveredFor: "inc-old" });
    const wake = vi.fn(async (): Promise<WakeOutcome> => ({ ok: true }));
    const outcome = await deliverSurvivalBriefOnBringup(
      observed.storage, async () => bringup({ incarnation: "inc-new" }),
      async () => paneBusy(IDLE), async () => "brief", wake,
    );
    expect(outcome).toEqual({ kind: "delivered", incarnation: "inc-new" });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(observed.stored()?.survivalBriefDeliveredFor).toBe("inc-new");
  });

  it("a NULL incarnation is SKIPPED, and no `null` marker is ever written", async () => {
    // Writing `null` would make the dedup comparison `null === null` true
    // forever and permanently suppress the re-brief on a studio whose
    // incarnation write keeps failing.
    const h = harness({ bringup: bringup({ incarnation: null }) });
    expect(await h.run()).toEqual({
      kind: "skipped",
      reason: "this bring-up has no incarnation token to record a delivery against",
    });
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
  });

  it("BUSY SIGNAL 1 — a repainted pane skips, writing NO dedup marker, so the next tick retries", async () => {
    const a = IDLE_PANE.replace("check on task 2 progress", "check on task 2");
    const h = harness({ busyStdout: captured(a, IDLE_PANE) });
    // Round-2 item 2: a busy pane now DEFERS (the brief is owed, and persisted)
    // rather than silently dropping the brief until the next container
    // replacement. Same reason string, a different disposition.
    expect(await h.run()).toEqual({
      kind: "deferred", attempts: 1,
      reason: `pane repainted within ${PANE_QUIESCE_SECONDS}s — a turn is in flight`,
    });
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();

    // And the very next bring-up, on the same storage and a quiet pane, delivers.
    const retry = await deliverSurvivalBriefOnBringup(
      h.observed.storage, async () => bringup(), async () => paneBusy(IDLE), async () => "brief",
      async () => ({ ok: true }),
    );
    expect(retry).toEqual({ kind: "delivered", incarnation: INCARNATION });
  });

  it("BUSY SIGNAL 2 — an `esc to interrupt` row skips, writing NO dedup marker", async () => {
    const h = harness({ busyStdout: captured(MIDTURN_PANE) });
    expect(await h.run()).toEqual({
      kind: "deferred", attempts: 1,
      reason: "pane shows an `esc to interrupt` row — a turn is in flight",
    });
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
  });

  it("MOVED CHECK ONE — a destroy landing BEFORE the busy probe aborts without execing it", async () => {
    // The probe is itself a container exec, and an exec STARTS a stopped
    // container (#152/#174's hazard class) — so the veto must land before it.
    const h = harness({ moved: async () => true });
    expect(await h.run()).toEqual({ kind: "skipped", reason: "a destroy landed before the busy probe" });
    expect(h.busy).not.toHaveBeenCalled();
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
  });

  it("MOVED CHECK TWO — a destroy landing DURING the probe aborts right before the wake", async () => {
    // First call clean (the probe runs), second call moved: the 3-second
    // quiescence interval plus the compose round trips is a real window.
    let calls = 0;
    const h = harness({ moved: async () => ++calls > 1 });
    expect(await h.run()).toEqual({ kind: "skipped", reason: "a destroy landed before the wake" });
    expect(h.busy).toHaveBeenCalledTimes(1);
    expect(h.moved).toHaveBeenCalledTimes(2);
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
  });

  it("`moved` defaults to never-moved, so a caller that does not pass one is unchanged", async () => {
    const observed = fakeObserved({ session: session() });
    const outcome = await deliverSurvivalBriefOnBringup(
      observed.storage, async () => bringup(), async () => paneBusy(IDLE),
      async () => "brief", async () => ({ ok: true }),
    );
    expect(outcome).toEqual({ kind: "delivered", incarnation: INCARNATION });
  });

  it("an EMPTY brief (PR4a's own `nothing survived` signal) skips, and probes nothing", async () => {
    const h = harness({ brief: "" });
    expect(await h.run()).toEqual({ kind: "skipped", reason: "nothing survived worth re-briefing" });
    expect(h.busy).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
  });

  it("A REFUSED WAKE writes NO dedup marker, so the very next bring-up retries and delivers", async () => {
    const refused: WakeOutcome = { ok: false, skipped: true, error: "refused: a modal is on screen" };
    const h = harness({ wake: refused });
    expect(await h.run()).toEqual({ kind: "refused", wake: refused });
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
    // Round-2 item 2: and it leaves the brief OWED, so the sync tick retries
    // too — not only the next container replacement.
    expect(h.observed.stored()?.survivalBriefPending).toEqual(expect.objectContaining({
      incarnation: INCARNATION, attempts: 1, reason: "refused: a modal is on screen",
    }));

    const retry = await deliverSurvivalBriefOnBringup(
      h.observed.storage, async () => bringup(), async () => paneBusy(IDLE), async () => "brief",
      async () => ({ ok: true }),
    );
    expect(retry).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(h.observed.stored()?.survivalBriefDeliveredFor).toBe(INCARNATION);
  });

  it("the dedup write MERGES — every other Observed field survives it", async () => {
    const h = harness({ seed: { session: session(), incarnation: INCARNATION, execFailures: 2, lastShipOkAt: NOW } });
    await h.run();
    expect(h.observed.stored()).toEqual(expect.objectContaining({
      incarnation: INCARNATION, execFailures: 2, lastShipOkAt: NOW,
      survivalBriefDeliveredFor: INCARNATION,
    }));
  });

  it("a pre-#249 Observed record (field absent, not null) is treated as `never delivered`", async () => {
    const map = new Map<string, Observed>();
    // Deliberately NOT spread through emptyObserved: the stored shape a
    // studio provisioned before this feature actually has on disk.
    map.set(OBSERVED_KEY, {
      incarnation: INCARNATION, replacedAt: null, execFailures: 0, unreachableSince: null,
      lastShipOkAt: null, lastSnapshotAt: null, session: session(),
    } as Observed);
    const storage: ObservedStorage = {
      get: async () => map.get(OBSERVED_KEY),
      put: async (_k, v) => { map.set(OBSERVED_KEY, v); },
    };
    const outcome = await deliverSurvivalBriefOnBringup(
      storage, async () => bringup(), async () => paneBusy(IDLE), async () => "brief",
      async () => ({ ok: true }),
    );
    expect(outcome).toEqual({ kind: "delivered", incarnation: INCARNATION });
  });
});

// ---------------------------------------------------------------------------
// Board issue #208, part 2 — `wipSyncedAt` threads from the bring-up's own
// trigger thunk into the pending record it would defer into, frozen the
// SAME way `session`/`via`/`replacementDetected` already are.
// ---------------------------------------------------------------------------

describe("deliverSurvivalBriefOnBringup — wipSyncedAt threading (#208 part 2)", () => {
  it("a bring-up that never names wipSyncedAt at all defers a pending record with NO wipSyncedAt key — byte-identical to before this feature", async () => {
    const h = harness({
      busyStdout: captured(MIDTURN_PANE),
      bringup: bringup(), // no `wipSyncedAt` override at all
    });
    expect(await h.run()).toMatchObject({ kind: "deferred" });
    const pending = h.observed.stored()?.survivalBriefPending;
    expect(pending).not.toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(pending, "wipSyncedAt")).toBe(false);
  });

  it("a bring-up's own wipSyncedAt (set or null) survives into the deferred pending record", async () => {
    const h = harness({
      busyStdout: captured(MIDTURN_PANE),
      bringup: bringup({ wipSyncedAt: "2026-10-03T11:56:00.000Z" }),
    });
    expect(await h.run()).toMatchObject({ kind: "deferred" });
    expect(h.observed.stored()?.survivalBriefPending?.wipSyncedAt).toBe("2026-10-03T11:56:00.000Z");
  });

  it("explicit null (no WIP sync had ever landed) is carried too, not dropped", async () => {
    const h = harness({
      busyStdout: captured(MIDTURN_PANE),
      bringup: bringup({ wipSyncedAt: null }),
    });
    expect(await h.run()).toMatchObject({ kind: "deferred" });
    expect(h.observed.stored()?.survivalBriefPending?.wipSyncedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #231 — `wipBootStamp`/`lastSessionAside` thread the SAME way
// `wipSyncedAt` just above already does: frozen at bring-up, into the
// deferred pending record.
// ---------------------------------------------------------------------------

describe("deliverSurvivalBriefOnBringup — wipBootStamp/lastSessionAside threading (#231)", () => {
  it("a bring-up that never names either at all defers a pending record with NEITHER key — byte-identical to before this feature", async () => {
    const h = harness({
      busyStdout: captured(MIDTURN_PANE),
      bringup: bringup(),
    });
    expect(await h.run()).toMatchObject({ kind: "deferred" });
    const pending = h.observed.stored()?.survivalBriefPending;
    expect(Object.prototype.hasOwnProperty.call(pending, "wipBootStamp")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(pending, "lastSessionAside")).toBe(false);
  });

  it("a bring-up's own wipBootStamp/lastSessionAside survive into the deferred pending record", async () => {
    const h = harness({
      busyStdout: captured(MIDTURN_PANE),
      bringup: bringup({ wipBootStamp: "20261003115000", lastSessionAside: ["~/.claude/projects/fleet-aside-x"] }),
    });
    expect(await h.run()).toMatchObject({ kind: "deferred" });
    const pending = h.observed.stored()?.survivalBriefPending;
    expect(pending?.wipBootStamp).toBe("20261003115000");
    expect(pending?.lastSessionAside).toEqual(["~/.claude/projects/fleet-aside-x"]);
  });
});

// ---------------------------------------------------------------------------
// Maestro review round 2 on PR #235 (issue #231), item 2b (second half) —
// once the brief carrying `lastSessionAside`/`lastSessionAsideAt` has
// actually been DELIVERED, both fields clear in the SAME merge as the dedup
// marker. Neither field ever auto-clears on its own (Observed's own doc
// comment) -- without this fix a LATER brief (composed after a successful
// delivery, for a reason unrelated to the aside move) would repeat the exact
// same "moved aside" claim as though it had just happened again.
// ---------------------------------------------------------------------------

describe("deliverSurvivalBriefOnBringup — lastSessionAside clears once actually delivered (#231 fix 2, second half)", () => {
  const ASIDE_PATH = "~/.claude/projects/fleet-aside-20261003T115000Z-42--workspace-acmeclient";

  it("a landed delivery whose pending record carried lastSessionAside clears both fields on Observed", async () => {
    const h = harness({
      seed: { session: session(), lastSessionAside: [ASIDE_PATH], lastSessionAsideAt: "2026-09-24T13:50:00.000Z" },
      bringup: bringup({ lastSessionAside: [ASIDE_PATH], lastSessionAsideAt: "2026-09-24T13:50:00.000Z" }),
    });
    expect(await h.run()).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(h.observed.stored()?.survivalBriefDeliveredFor).toBe(INCARNATION);
    expect(h.observed.stored()?.lastSessionAside).toBeNull();
    expect(h.observed.stored()?.lastSessionAsideAt).toBeNull();
  });

  it("a landed delivery whose bring-up never carried an aside leaves both fields untouched", async () => {
    const h = harness({ bringup: bringup() });
    expect(await h.run()).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(Object.prototype.hasOwnProperty.call(h.observed.stored() ?? {}, "lastSessionAside")).toBe(false);
  });

  it("a SECOND brief, composed after the first (which carried the aside line) was delivered, does not repeat it", async () => {
    const h = harness({
      seed: { session: session(), lastSessionAside: [ASIDE_PATH], lastSessionAsideAt: "2026-09-24T13:50:00.000Z" },
      bringup: bringup({ lastSessionAside: [ASIDE_PATH], lastSessionAsideAt: "2026-09-24T13:50:00.000Z" }),
      brief: "What survived, s:\n- Old session moved aside to sessions/s/aside/fleet-aside-x/, 10m ago; check it for anything lost since then.",
    });
    expect(await h.run()).toEqual({ kind: "delivered", incarnation: INCARNATION });
    const afterDelivery = h.observed.stored();
    expect(afterDelivery?.lastSessionAside).toBeNull();

    // A later composition reading Observed as it now stands (post-delivery)
    // has nothing left to render the aside line from.
    const secondBrief = composeSurvivalBrief({
      studioId: "s",
      tasks: { ok: true, value: [] },
      openPrs: { ok: true, value: [] },
      unclaimedRescueBranches: { ok: true, value: [] },
      liveWipRefs: { ok: true, value: [] },
      session: session(),
      now: "2026-09-25T12:00:00.000Z",
      lastSessionAside: afterDelivery?.lastSessionAside ?? null,
      lastSessionAsideAt: afterDelivery?.lastSessionAsideAt ?? null,
    });
    expect(secondBrief).not.toContain("moved aside");
  });
});

// ---------------------------------------------------------------------------
// Shared single-flight: one wake path, one lock, source-pinned
// ---------------------------------------------------------------------------

/** Comment lines stripped: a doc comment NAMING `runGatedWake` is exactly how
 *  this file explains that it delegates to it, and must not read as a call. */
const codeOnly = (src: string) =>
  src.split("\n").filter((l) => {
    const t = l.trimStart();
    return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });

describe("shared single-flight — #229's lock is reused, never duplicated", () => {
  it("survival-delivery.ts contains no lock, no runGatedWake and no exec of its own", async () => {
    const code = codeOnly(env.TEST_SURVIVAL_DELIVERY_SRC).join("\n");
    for (const forbidden of ["wakeLock", "runGatedWake", "sweepWake", "wakeStudioWith", "sbExec", "singleFlight"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("do.ts wires BOTH bring-up deliveries through the SAME wakeStudioOnAssignment", async () => {
    const src = env.TEST_STUDIO_DO_SRC;
    // One combined wrapper, calling #229's hook then this one, in sequence.
    expect(src).toContain("private async deliverBringupWakes(cfg: ProvisionConfig | null, ctx: OpCtx)");
    // Round-2 item 2: the SURVIVAL BRIEF IS FIRST. Only it has a busy gate;
    // #229's pointer just types (claude queues a message typed at a busy lead),
    // so typing the pointer first made the lead busy and the brief deferred on
    // exactly the bring-ups it exists for. See deliverBringupWakes' own comment.
    expect(src).toContain("await this.deliverSurvivalOnBringup(cfg, ctx);\n    await this.deliverTaskOnBringup(cfg, ctx);");
    // The survival hook's wake thunk IS the method #229's own delivery calls.
    expect(src).toContain("(prompt) => this.wakeStudioOnAssignment(prompt)");
    // All three bring-up choke points go through the combined wrapper, and
    // none of them calls #229's hook directly any more.
    const code = codeOnly(src);
    const direct = code.filter((l) => /\bthis\.deliverTaskOnBringup\(/.test(l));
    expect(direct).toHaveLength(1); // only the one inside deliverBringupWakes
    expect(code.filter((l) => /\bthis\.deliverBringupWakes\(/.test(l))).toHaveLength(3);
    // Exactly ONE gated-wake call site for the whole survival feature.
    expect(code.filter((l) => /this\.wakeStudioOnAssignment\(/.test(l)).length).toBeLessThanOrEqual(3);
  });

  // SURVIVAL_COMPARE_BASE's real consumer is do.ts's compareAhead wiring,
  // unreachable by import (the DO cannot be constructed here) — pinned by
  // symbol so a hardcoded `"main"` typed in do.ts instead of the constant,
  // or a drift between the two, breaks this. StudioDO cannot be constructed
  // under vitest-pool-workers; source-pinning is this repo's established
  // compromise, see studio.account-launched.test.ts.
  it("do.ts's compareAhead wiring passes SURVIVAL_COMPARE_BASE as the base, not a re-typed literal", () => {
    const src = env.TEST_STUDIO_DO_SRC;
    expect(src).toContain("compareAhead(await token(), repo, SURVIVAL_COMPARE_BASE, branch)"); // test-lies-check: allow — source-pinning, see comment above
  });

  it("maestro review, PR #302 round 2 — ONLY the retry's wake thunk clears a stuck draft first", async () => {
    const src = env.TEST_STUDIO_DO_SRC;
    // The bring-up wake is always the FIRST attempt for its pending record —
    // no draft of this feature's own making can already be in the composer.
    expect(src).toContain("(prompt) => this.wakeStudioOnAssignment(prompt)");
    // The retry's wake can follow an earlier `unconfirmed` attempt that DID
    // type text (wake.ts's wakeCmd, steps 6-8) — clear it before retyping, or
    // the two run together into one doubled, unreadable message.
    expect(src).toContain("(prompt) => this.wakeStudioOnAssignment(prompt, true)");
  });
});

// ---------------------------------------------------------------------------
// Round-2 review, item 2 — A DEFERRED RE-BRIEF IS PERSISTED AND RETRIED
//
// Round 1's delivery was fire-and-forget: a busy lead meant the brief was
// dropped, and the only thing that could ever try again was another BRING-UP,
// i.e. another container replacement. Worse, #229's assigned-task pointer was
// typed from the same hook FIRST, so the lead was reliably busy by the time the
// brief's own probe ran. Every `it` below pins one piece of the fix.
// ---------------------------------------------------------------------------

/** A pending record, defaulted to "one deferral, just now, still in bounds". */
function pending(over: Partial<SurvivalBriefPending> = {}): SurvivalBriefPending {
  return {
    incarnation: INCARNATION, via: "recycle", replacementDetected: false,
    session: session(), since: NOW, attempts: 1, reason: "pane was busy", ...over,
  };
}

/** The retry's four thunks, all defaulted to "idle pane, composable, wake lands". */
function retryHarness(over: {
  seed?: Partial<Observed>;
  busyStdout?: string;
  brief?: ComposedBrief;
  wake?: WakeOutcome;
  moved?: () => Promise<boolean>;
  now?: string;
} = {}) {
  const observed = fakeObserved(over.seed ?? { incarnation: INCARNATION, survivalBriefPending: pending() });
  const busy = vi.fn(async () => paneBusy(over.busyStdout ?? IDLE));
  const compose = vi.fn(async (_p: SurvivalBriefPending): Promise<ComposedBrief> =>
    over.brief ?? "What survived, s:\n- Task branches: none");
  const wake = vi.fn(async (): Promise<WakeOutcome> => over.wake ?? { ok: true });
  const moved = vi.fn(over.moved ?? (async () => false));
  const now = () => new Date(over.now ?? NOW);
  const run = () => retryPendingSurvivalBrief(observed.storage, busy, compose, wake, moved, now);
  return { observed, busy, compose, wake, moved, run };
}

describe("the pending marker — a busy bring-up leaves the brief OWED, not dropped", () => {
  it("a busy-skip persists WHICH incarnation is owed, when, why, and how many attempts", async () => {
    const h = harness({ busyStdout: captured(MIDTURN_PANE) });
    const outcome = await h.run();
    expect(outcome.kind).toBe("deferred");
    // Everything the retry needs to compose and bound the SAME brief later,
    // with no re-read of a record a later bring-up will have overwritten.
    expect(h.observed.stored()?.survivalBriefPending).toEqual({
      incarnation: INCARNATION, via: "recycle", replacementDetected: false,
      session: session(), since: expect.any(String), attempts: 1,
      reason: "pane shows an `esc to interrupt` row — a turn is in flight",
      gaveUpAt: null,
    });
    // NOT the dedup marker — that one means "the lead has been told".
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
  });

  it("the pending record carries the BRING-UP's session, frozen — never a later one", async () => {
    // The whole reason `SurvivalBringup` carries a session at all: by retry
    // time `Observed.session` can describe a DIFFERENT bring-up, and
    // `snapshotAgeS` is a restore-time fact that must not be recomputed.
    const frozen = session({ snapshotAgeS: 600, verdict: "resumed" });
    const observed = fakeObserved({ session: session({ snapshotAgeS: 1, verdict: "fresh" }) });
    await deliverSurvivalBriefOnBringup(
      observed.storage,
      async () => bringup({ session: frozen }),
      async () => paneBusy(captured(MIDTURN_PANE)),
      async () => "brief",
      async () => ({ ok: true }),
    );
    expect(observed.stored()?.survivalBriefPending?.session).toEqual(frozen);
  });

  it("A HARD DENIAL owes nothing: a denied `via` writes no pending record either", async () => {
    for (const via of ["adopted", "failover"] as BringupVia[]) {
      const h = harness({ bringup: bringup({ via, replacementDetected: true }) });
      await h.run();
      expect(h.observed.stored()?.survivalBriefPending ?? null).toBeNull();
    }
  });

  it("A DESTROY VETO owes nothing and burns no attempt — it is not a failed attempt", async () => {
    // Three quick destroy races must not be able to exhaust the retry bound of
    // a brief that was never actually tried.
    const h = harness({
      seed: { session: session(), survivalBriefPending: pending({ attempts: 2 }) },
      moved: async () => true,
    });
    expect(await h.run()).toEqual({ kind: "skipped", reason: "a destroy landed before the busy probe" });
    expect(h.observed.stored()?.survivalBriefPending?.attempts).toBe(2);
  });

  it("AN EMPTY BRIEF clears a pending record — nothing was ever owed", async () => {
    const h = harness({ seed: { session: session(), survivalBriefPending: pending() }, brief: "" });
    expect(await h.run()).toEqual({ kind: "skipped", reason: "nothing survived worth re-briefing" });
    expect(h.observed.stored()?.survivalBriefPending ?? null).toBeNull();
  });

  it("`since` is stamped ONCE — a second deferral for the same incarnation keeps the first anchor", async () => {
    // The time bound measures from the FIRST deferral; re-stamping would make
    // SURVIVAL_RETRY_WINDOW_MS unreachable on a studio that keeps deferring.
    const h = harness({
      seed: { session: session(), survivalBriefPending: pending({ since: "2026-09-25T11:00:00.000Z", attempts: 3 }) },
      busyStdout: captured(MIDTURN_PANE),
    });
    expect(await h.run()).toEqual({ kind: "deferred", attempts: 4, reason: expect.any(String) });
    expect(h.observed.stored()?.survivalBriefPending?.since).toBe("2026-09-25T11:00:00.000Z");
  });
});

describe("retryPendingSurvivalBrief — THE RETRY ITSELF (round-2 item 2's mutant)", () => {
  it("MUTANT: delete the retry and this goes red — an owed brief is delivered on a later idle tick", async () => {
    const h = retryHarness();
    expect(await h.run()).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(h.wake).toHaveBeenCalledTimes(1);
    // One merge, both markers: dedup written, pending cleared.
    expect(h.observed.stored()?.survivalBriefDeliveredFor).toBe(INCARNATION);
    expect(h.observed.stored()?.survivalBriefPending ?? null).toBeNull();
  });

  it("the whole busy-then-retry sequence end to end: bring-up defers, the tick delivers", async () => {
    const observed = fakeObserved({ incarnation: INCARNATION, session: session() });
    const deferred = await deliverSurvivalBriefOnBringup(
      observed.storage, async () => bringup(), async () => paneBusy(captured(MIDTURN_PANE)),
      async () => "What survived, s:\n- Task branches: none", async () => ({ ok: true }),
    );
    expect(deferred.kind).toBe("deferred");

    const wake = vi.fn(async (): Promise<WakeOutcome> => ({ ok: true }));
    const outcome = await retryPendingSurvivalBrief(
      observed.storage, async () => paneBusy(IDLE),
      async (p) => `What survived, s: ${p.incarnation}`, wake,
    );
    expect(outcome).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(wake).toHaveBeenCalledWith(`What survived, s: ${INCARNATION}`);
  });

  it("COSTS NOTHING when nothing is owed: no probe, no compose, no wake", async () => {
    // This runs on every studio every sync tick. The busy probe alone is a
    // container exec, and an exec STARTS a stopped container.
    const h = retryHarness({ seed: { incarnation: INCARNATION } });
    expect(await h.run()).toEqual({ kind: "skipped", reason: "no survival re-brief is owed" });
    expect(h.busy).not.toHaveBeenCalled();
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("a still-busy lead defers again, advancing attempts but not `since`", async () => {
    const h = retryHarness({ busyStdout: captured(MIDTURN_PANE) });
    expect(await h.run()).toEqual({
      kind: "deferred", attempts: 2,
      reason: "pane shows an `esc to interrupt` row — a turn is in flight",
    });
    expect(h.observed.stored()?.survivalBriefPending?.since).toBe(NOW);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("a record whose incarnation has been REPLACED is dropped, never delivered", async () => {
    // Its "what survived" describes a disk that no longer exists, and the
    // replacement's own bring-up already had its turn.
    const h = retryHarness({ seed: { incarnation: "inc-newer", survivalBriefPending: pending() } });
    expect(await h.run()).toEqual({
      kind: "skipped",
      reason: `the owed re-brief describes incarnation ${INCARNATION}, which has since been replaced`,
    });
    expect(h.observed.stored()?.survivalBriefPending ?? null).toBeNull();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("a record for a brief that already landed is dropped without a second wake", async () => {
    const h = retryHarness({
      seed: { incarnation: INCARNATION, survivalBriefPending: pending(), survivalBriefDeliveredFor: INCARNATION },
    });
    expect(await h.run()).toEqual({ kind: "skipped", reason: `already delivered for incarnation ${INCARNATION}` });
    expect(h.observed.stored()?.survivalBriefPending ?? null).toBeNull();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("a REFUSED retry wake defers again rather than writing the dedup marker", async () => {
    const refused: WakeOutcome = { ok: false, skipped: true, error: "refused: another wake is in flight" };
    const h = retryHarness({ wake: refused });
    expect(await h.run()).toEqual({ kind: "refused", wake: refused });
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
    expect(h.observed.stored()?.survivalBriefPending?.attempts).toBe(2);
  });
});

describe("the retry BOUND — retrying stops, and the row says so", () => {
  it("retryBoundExceeded: the attempt limit, named", () => {
    expect(retryBoundExceeded(pending({ attempts: SURVIVAL_RETRY_MAX_ATTEMPTS - 1 }), new Date(NOW))).toBeNull();
    expect(retryBoundExceeded(pending({ attempts: SURVIVAL_RETRY_MAX_ATTEMPTS }), new Date(NOW)))
      .toBe(`${SURVIVAL_RETRY_MAX_ATTEMPTS} delivery attempts, none landed (limit ${SURVIVAL_RETRY_MAX_ATTEMPTS})`);
  });

  it("retryBoundExceeded: the time window, named — and it fires with attempts still to spare", () => {
    const since = new Date(Date.parse(NOW) - SURVIVAL_RETRY_WINDOW_MS);
    expect(retryBoundExceeded(pending({ since: since.toISOString(), attempts: 1 }), new Date(NOW)))
      .toBe(`still undelivered ${SURVIVAL_RETRY_WINDOW_MS / 60_000}m after the bring-up that owed it`);
    // One millisecond short of the window is still inside it.
    const nearly = new Date(Date.parse(NOW) - SURVIVAL_RETRY_WINDOW_MS + 1);
    expect(retryBoundExceeded(pending({ since: nearly.toISOString(), attempts: 1 }), new Date(NOW))).toBeNull();
  });

  it("retryBoundExceeded: an unparseable `since` falls back to the attempt bound, never to forever", () => {
    expect(retryBoundExceeded(pending({ since: "not a date", attempts: 1 }), new Date(NOW))).toBeNull();
    expect(retryBoundExceeded(pending({ since: "not a date", attempts: SURVIVAL_RETRY_MAX_ATTEMPTS }), new Date(NOW)))
      .not.toBeNull();
  });

  it("exhausting the attempts STAMPS gaveUpAt and stops — no probe, no compose, no wake", async () => {
    const h = retryHarness({
      seed: { incarnation: INCARNATION, survivalBriefPending: pending({ attempts: SURVIVAL_RETRY_MAX_ATTEMPTS }) },
    });
    expect(await h.run()).toEqual({
      kind: "gave-up", attempts: SURVIVAL_RETRY_MAX_ATTEMPTS,
      reason: `${SURVIVAL_RETRY_MAX_ATTEMPTS} delivery attempts, none landed (limit ${SURVIVAL_RETRY_MAX_ATTEMPTS})`,
    });
    expect(h.busy).not.toHaveBeenCalled();
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    // KEPT, not deleted: this record is what `fleet ls` renders as
    // `re-brief undelivered`.
    expect(h.observed.stored()?.survivalBriefPending).toEqual(expect.objectContaining({
      incarnation: INCARNATION, gaveUpAt: NOW, attempts: SURVIVAL_RETRY_MAX_ATTEMPTS,
    }));
  });

  it("once it has given up, every later tick stands down instead of retrying forever", async () => {
    const h = retryHarness({
      seed: {
        incarnation: INCARNATION,
        survivalBriefPending: pending({ attempts: SURVIVAL_RETRY_MAX_ATTEMPTS, gaveUpAt: NOW }),
      },
    });
    expect(await h.run()).toEqual({
      kind: "skipped", reason: `re-brief undelivered since ${NOW}, gave up at ${NOW}`,
    });
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("a busy lead for the whole window: defer, defer, … then UNDELIVERED, and never a forced wake", async () => {
    const observed = fakeObserved({ incarnation: INCARNATION, session: session() });
    const wake = vi.fn(async (): Promise<WakeOutcome> => ({ ok: true }));
    const stillBusy = () => retryPendingSurvivalBrief(
      observed.storage, async () => paneBusy(captured(MIDTURN_PANE)), async () => "brief", wake,
      async () => false, () => new Date(NOW),
    );
    // The bring-up's own first attempt.
    await deliverSurvivalBriefOnBringup(
      observed.storage, async () => bringup(), async () => paneBusy(captured(MIDTURN_PANE)),
      async () => "brief", wake, async () => false, () => new Date(NOW),
    );
    const attempts: number[] = [];
    let last = await stillBusy();
    // The `attempts.length` guard is the MUTATION GUARD, not a belt: deleting
    // the bound makes this loop genuinely infinite, and a hanging suite is a
    // worse signal than a failing assertion. With the bound in place the loop
    // ends on its own well inside it.
    while (last.kind === "deferred" && attempts.length < SURVIVAL_RETRY_MAX_ATTEMPTS + 3) {
      attempts.push(last.attempts);
      last = await stillBusy();
    }
    // The bring-up burned attempt 1; the retries burn the rest, then stop.
    expect(attempts).toEqual([2, 3, 4, 5, 6]);
    expect(attempts).toHaveLength(SURVIVAL_RETRY_MAX_ATTEMPTS - 1);
    expect(last.kind).toBe("gave-up");
    expect(wake).not.toHaveBeenCalled();
    expect(observed.stored()?.survivalBriefPending?.gaveUpAt).toBe(NOW);
    expect(observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-2 review, item 4 — A BOARD OUTAGE DEFERS, IT DOES NOT CONSUME THE
// DELIVERY
// ---------------------------------------------------------------------------

describe("a board READ FAILURE defers; a genuinely EMPTY board still delivers", () => {
  it("a deferred compose writes the pending marker and never the dedup one", async () => {
    const h = harness({ brief: { defer: "board unreachable: board read failed (503): upstream" } });
    expect(await h.run()).toEqual({
      kind: "deferred", attempts: 1, reason: "board unreachable: board read failed (503): upstream",
    });
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
    expect(h.observed.stored()?.survivalBriefPending).toEqual(expect.objectContaining({
      incarnation: INCARNATION, attempts: 1, reason: "board unreachable: board read failed (503): upstream",
    }));
  });

  it("a deferred compose costs no pane probe and no wake — the brief was never composed", async () => {
    const h = harness({ brief: { defer: "board unreachable: 502" } });
    await h.run();
    expect(h.busy).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("the retry re-composes and delivers once the board answers again", async () => {
    const h = retryHarness({ brief: { defer: "board unreachable: 503" } });
    expect((await h.run()).kind).toBe("deferred");
    const wake = vi.fn(async (): Promise<WakeOutcome> => ({ ok: true }));
    expect(await retryPendingSurvivalBrief(
      h.observed.storage, async () => paneBusy(IDLE),
      async () => "What survived, s:\n- Task #249 \"x\": b — 3 commits ahead of main", wake,
      // The fixture's `since` is NOW, so the clock has to be NOW too — the real
      // one would be hours past the retry window and give up instead.
      async () => false, () => new Date(NOW),
    )).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("ZERO TASKS is a CHECKED answer and still delivers — never confused with a failure", async () => {
    // `- Task branches: none` is a real statement about a studio with nothing
    // outstanding. Only `survivalTasks` THROWING is an outage (do.ts).
    const brief = await composeSurvivalDelivery(sources(), { ok: true, value: [] }, session(), NOW);
    expect(brief).toContain("- Task branches: none");
    const h = harness({ brief });
    expect(await h.run()).toEqual({ kind: "delivered", incarnation: INCARNATION });
    expect(h.observed.stored()?.survivalBriefDeliveredFor).toBe(INCARNATION);
  });

  it("do.ts DEFERS on a board throw and never composes a `could not check` brief from one", () => {
    const src = env.TEST_STUDIO_DO_SRC;
    // The board read's own catch returns `{defer}`, never a `Checked` failure
    // that would render "could not check" and still get delivered + marked.
    expect(src).toContain("return { defer: `board unreachable: ${err instanceof Error ? err.message : String(err)}` };");
    expect(src).not.toContain("tasks = { ok: false as const, reason:");
  });
});

// ---------------------------------------------------------------------------
// Board issue #110 — `survivalTasks`'s own "live" means NOT TERMINAL, not
// positive LIVE_TASK_STATES membership (the opposite direction from the
// openAssignedTasks/liveTasksOf fix elsewhere in this feature). An
// `awaiting_merge` task has exactly the kind of artifact (a reported PR)
// survival re-brief exists to re-check; excluding it here is a real gap, not
// a stylistic one. `survivalTasks` is private and StudioDO cannot be
// constructed under vitest-pool-workers (do.ts's own header) — no fixture
// here fabricates a DO or a fake board. Instead the EXACT filter expression
// is pulled out of the real, live do.ts source text (same TEST_STUDIO_DO_SRC
// pinning every other `it` in this file already uses) and executed as real
// code against task fixtures covering the whole vocabulary, so this goes red
// against the pre-fix `LIVE_TASK_STATES.includes(t.state)` expression and
// green only once the filter is genuinely "not terminal".
// ---------------------------------------------------------------------------

describe("survivalTasks — crash-survival re-brief means NOT TERMINAL, not positively live (#110)", () => {
  type Predicate = (
    t: { open: boolean; state: string | null },
    TERMINAL_TASK_STATES: readonly string[],
    LIVE_TASK_STATES: readonly string[],
  ) => boolean;

  function extractedFilter(): (t: { open: boolean; state: string | null }) => boolean {
    const src = env.TEST_STUDIO_DO_SRC;
    const m = /const live = result\.value\.filter\(\(t\) => (.+)\);/.exec(src);
    if (!m) throw new Error("survivalTasks's `live` filter line not found in do.ts source");
    // The extracted expression may reference TERMINAL_TASK_STATES and/or
    // LIVE_TASK_STATES by name — both real imports, not stand-ins, so the
    // predicate below is genuinely the shipped expression, not a paraphrase.
    const raw = new Function("t", "TERMINAL_TASK_STATES", "LIVE_TASK_STATES", `return (${m[1]});`) as Predicate;
    return (t) => raw(t, TERMINAL_TASK_STATES, LIVE_TASK_STATES);
  }

  it("an awaiting_merge task (open, with a PR artifact already reported) IS included", () => {
    expect(extractedFilter()({ open: true, state: "awaiting_merge" })).toBe(true);
  });

  it("completed, failed and canceled tasks are NOT included — they are finished, nothing to re-check", () => {
    const filter = extractedFilter();
    for (const state of TERMINAL_TASK_STATES) {
      expect(filter({ open: true, state })).toBe(false);
    }
  });

  it("submitted, working and input_required are still included — the pre-existing live states", () => {
    const filter = extractedFilter();
    for (const state of LIVE_TASK_STATES) {
      expect(filter({ open: true, state })).toBe(true);
    }
  });

  it("a drifted (null) state is excluded, unchanged from before this fix", () => {
    expect(extractedFilter()({ open: true, state: null })).toBe(false);
  });

  it("a closed task is excluded regardless of state", () => {
    expect(extractedFilter()({ open: false, state: "awaiting_merge" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-2 review, item 3 — AN UNCONFIRMED SUBMIT IS NOT A DELIVERY
// ---------------------------------------------------------------------------

describe("an UNCONFIRMED SUBMIT (wake.ts's draft check) never writes the dedup marker", () => {
  it("MUTANT: report `sent` without confirming the box emptied and this goes red", async () => {
    // wake.ts's own post-Enter check is what turns a prompt left sitting in the
    // input box into `ok: false`; this pins that the delivery honours it.
    const unconfirmed: WakeOutcome = {
      ok: false,
      error: "submit unconfirmed: the prompt is still sitting in studio:claude's input box after Enter",
    };
    const h = harness({ wake: unconfirmed });
    expect(await h.run()).toEqual({ kind: "refused", wake: unconfirmed });
    expect(h.observed.stored()?.survivalBriefDeliveredFor ?? null).toBeNull();
    expect(h.observed.stored()?.survivalBriefPending?.reason).toContain("submit unconfirmed");
  });
});

// ---------------------------------------------------------------------------
// Round-2 item 2 — the sync tick is the retry's schedule, source-pinned
// ---------------------------------------------------------------------------

describe("the retry rides the REGULAR per-studio tick, not the maestro-only sweep", () => {
  it("syncSessionCycle takes the retry as its own isolated step, and syncSession wires it", () => {
    const src = env.TEST_STUDIO_DO_SRC;
    expect(src).toContain("retrySurvivalBrief?: (() => Promise<unknown>) | null,");
    // Review round 2 (#210), FINAL round, finding B — also gated on
    // `!stoppedAfterFailover` (a same-tick auto-stop from the failover step
    // above): still the retry's own isolated `if`, still one `try` around
    // one `await retrySurvivalBrief()` call, just no longer firing onto a
    // row the SAME tick just destroyed.
    expect(src).toContain("if (retrySurvivalBrief && !stoppedAfterFailover) {\n    try {\n      await retrySurvivalBrief();");
    expect(src).toContain("() => this.retrySurvivalBrief(),");
    // The maestro-only sweep is NOT the schedule: `armSweep` runs behind
    // `if (this.isMaestro())`, and every studio is owed a re-brief.
    expect(src).not.toContain("sweepMaestro survival");
    const code = codeOnly(src);
    expect(code.filter((l) => /this\.retrySurvivalBrief\(\)/.test(l))).toHaveLength(1);
  });

  it("the retry reuses the SAME busy probe, compose and wake the bring-up path uses", () => {
    const src = env.TEST_STUDIO_DO_SRC;
    // One probe helper, one compose helper, each called from BOTH paths.
    expect(src).toContain("private async survivalBusy(): Promise<BusyVerdict>");
    expect(src).toContain(
      "private survivalCompose(\n    workRepoSlug: string, session: ObservedSession, wipSyncedAt: string | null = null,",
    );
    const code = codeOnly(src);
    expect(code.filter((l) => /this\.survivalBusy\(\)/.test(l))).toHaveLength(2);
    expect(code.filter((l) => /this\.survivalCompose\(/.test(l))).toHaveLength(2);
  });
});
