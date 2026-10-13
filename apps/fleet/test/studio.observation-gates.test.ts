// Board issue #698 (sweep 26 F11, refs #635) — the ship tick's GATES half:
// the incarnationPatch decision table, one-exec adoption, op-lock guard,
// immediate D1 write, hook heartbeat merge, reachability, and adoption
// session verdict, split verbatim from test/studio.observation-tick.test.ts.

import { describe, it, expect, vi } from "vitest";
import {
  incarnationPatch, runShipTickWithObservation, ExecUnreachableError,
} from "../src/studio/do";
import { emptyObserved, getObserved, OBSERVED_KEY, type Observed, type ObservedStorage } from "../src/studio/observed";
import { STATUS_KEY, OPERATION_KEY, type OperationInFlight, type StudioStorage } from "../src/studio/provision";
import type { TranscriptStorage, ShipDeps } from "../src/studio/transcript";
import type { StudioStatus } from "../src/studio/types";
import { SessionBusyError } from "../src/studio/sandbox-api";
import { ACTIVITY_KEY, type Activity } from "../src/studio/activity";
import { MEMBERS_TICKING_KEY } from "../src/studio/failover";
import { MEMBER_ALERTS_KEY, MEMBER_ROWS_KEY, type MemberAlert } from "../src/studio/member-alerts";
import { row } from "./helpers/studio-row";

/** UTF-8 aware base64 — a pane frame carries claude's own box-drawing/emoji
 *  glyphs, which plain `btoa` throws on outright (Latin1 only). */
function b64Utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

const SECTION_PANE_MARKER = "---FLEET-PANE---";
const SECTION_ACTIVITY_HOOK = "---FLEET-ACTIVITY-HOOK---";

/** A minimal idle pane: no `✻` status line, straight into the idle input box. */
const IDLE_PANE = ["⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
/** A minimal working pane: a live spinner as the last `✻` line. */
const WORKING_PANE = ["✻ Cogitating… (3s · esc to interrupt)", "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");

function stdoutWithPane(pane: string | null, incarnation = TOK_1): string {
  const base = ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", incarnation];
  if (pane === null) return base.join("\n");
  return [...base, SECTION_PANE_MARKER, b64Utf8(pane)].join("\n");
}

/** Issue #221 (PR3b) — same shape as `stdoutWithPane`, plus a
 *  SECTION_ACTIVITY_HOOK section carrying a raw heartbeat JSON body (or
 *  omitted entirely when `hookRaw` is null, modelling a pre-feature
 *  container/old image). */
function stdoutWithPaneAndHook(pane: string | null, hookRaw: string | null, incarnation = TOK_1): string {
  const base = stdoutWithPane(pane, incarnation);
  if (hookRaw === null) return base;
  return [base, SECTION_ACTIVITY_HOOK, btoa(hookRaw)].join("\n");
}

const TOK_1 = "11111111-2222-3333-4444-555555555555";
const TOK_2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const status = (o: Partial<StudioStatus> = {}) => row({ id: "websites--pilot", state: "running", ...o });

/**
 * One Map-backed fake satisfying every narrow port `runShipTickWithObservation`
 * needs at once (TranscriptStorage & ObservedStorage & StudioStorage) — same
 * "one object, several structural ports" shape a real `this.ctx.storage`
 * already provides, mirrored here the same way test/studio.replacement.test.ts's
 * `fakeStorageWithObserved` does for its own narrower slice.
 */
function fakeStorage(seed?: {
  observed?: Observed;
  status?: StudioStatus;
  operation?: OperationInFlight | null;
  activity?: Activity;
  membersTickingAt?: string;
  memberAlerts?: MemberAlert[];
  memberRows?: string[];
}): (TranscriptStorage & ObservedStorage & StudioStorage) & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  if (seed?.observed) map.set(OBSERVED_KEY, seed.observed);
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  if (seed?.operation !== undefined && seed.operation !== null) map.set(OPERATION_KEY, seed.operation);
  if (seed?.activity) map.set(ACTIVITY_KEY, seed.activity);
  if (seed?.membersTickingAt !== undefined) map.set(MEMBERS_TICKING_KEY, seed.membersTickingAt);
  if (seed?.memberAlerts !== undefined) map.set(MEMBER_ALERTS_KEY, seed.memberAlerts);
  if (seed?.memberRows !== undefined) map.set(MEMBER_ROWS_KEY, seed.memberRows);
  const storage = {
    map,
    get: (async (key: string) => map.get(key)) as unknown as (TranscriptStorage & ObservedStorage & StudioStorage)["get"],
    put: (async (keyOrEntries: unknown, value?: unknown) => {
      if (typeof keyOrEntries === "object" && keyOrEntries !== null) {
        for (const [k, v] of Object.entries(keyOrEntries as Record<string, unknown>)) map.set(k, v);
        return;
      }
      map.set(keyOrEntries as string, value);
    }) as unknown as (TranscriptStorage & ObservedStorage & StudioStorage)["put"],
  };
  return storage;
}

describe("incarnationPatch — pure decision table", () => {
  const NOW = "2026-09-24T10:00:00.000Z";

  it("missing token, DO has a stored incarnation: sets replacedAt once, KEEPS the token", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    expect(incarnationPatch(before, "", NOW)).toEqual({ replacedAt: NOW });
  });

  it("missing token, replacedAt already set: does not reset the age, still keeps the token", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1, replacedAt: "2026-09-24T09:59:00.000Z" };
    expect(incarnationPatch(before, "", NOW)).toEqual({});
  });

  it("multi-tick sequence: replaced stays replaced across 3 more missing ticks, never self-clears (maestro correction #3)", () => {
    let observed: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    for (let i = 0; i < 4; i++) {
      const patch = incarnationPatch(observed, "", NOW);
      observed = { ...observed, ...patch };
    }
    expect(observed.incarnation).toBe(TOK_1);
    expect(observed.replacedAt).toBe(NOW);
  });

  it("adoption: DO has no stored incarnation, container reports none (the folded-in write itself failed this tick)", () => {
    const before: Observed = { ...emptyObserved(), incarnation: null };
    expect(incarnationPatch(before, "", NOW)).toEqual({});
  });

  it("adoption: DO has no stored incarnation, container now reports one (the folded-in write succeeded, or a foreign token was already there)", () => {
    const before: Observed = { ...emptyObserved(), incarnation: null };
    expect(incarnationPatch(before, TOK_1, NOW)).toEqual({ incarnation: TOK_1, replacedAt: null });
  });

  it("matching tokens: clears a stale replacedAt", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1, replacedAt: "2026-09-24T09:00:00.000Z" };
    expect(incarnationPatch(before, TOK_1, NOW)).toEqual({ replacedAt: null });
  });

  it("matching tokens, no prior replacedAt: no-op patch", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    expect(incarnationPatch(before, TOK_1, NOW)).toEqual({});
  });

  it("foreign token: sets replacedAt once, KEEPS the DO's own token — never adopts the foreign one, never self-clears next tick (maestro correction #3)", () => {
    let observed: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    const tick1 = incarnationPatch(observed, TOK_2, NOW);
    expect(tick1).toEqual({ replacedAt: NOW });
    observed = { ...observed, ...tick1 };
    const tick2 = incarnationPatch(observed, TOK_2, "2026-09-24T10:00:30.000Z");
    expect(tick2).toEqual({}); // still foreign, still no-op — incarnation never became TOK_2
    expect(observed.incarnation).toBe(TOK_1);
  });

  it("garbage (non-UUID-shaped) container content is treated as no token, never stored or compared", () => {
    const before: Observed = { ...emptyObserved(), incarnation: TOK_1 };
    expect(incarnationPatch(before, "not-a-real-token", NOW)).toEqual({ replacedAt: NOW });
  });
});

describe("runShipTickWithObservation — adoption folded into one exec", () => {
  it("T1b: adoption writes a token via the SAME exec as the tick itself — never a second exec", async () => {
    let execCount = 0;
    const deps = {
      exec: vi.fn(async (_cmd: string) => {
        execCount += 1;
        return {
          code: 0,
          stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
          stderr: "",
        };
      }),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage();

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    expect(execCount).toBe(1);
    const observed = await getObserved(storage);
    expect(observed.incarnation).not.toBeNull();
    expect(observed.replacedAt).toBeNull();
  });
});

describe("runShipTickWithObservation — op-lock guard", () => {
  it("T10: a fresh operation lock suppresses a replaced/adoption verdict even though the container reports no token (the REAL op-lock proof — see Task 8's own T10 note)", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", ""].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      operation: { op: "provision", since: "2026-09-24T09:59:30.000Z" }, // 30s ago, well inside OPERATION_STALE_MS
    });

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.replacedAt).toBeNull();
    expect(observed.incarnation).toBe(TOK_1); // untouched
  });

  it("a stale operation lock (older than OPERATION_STALE_MS) does NOT suppress the verdict", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", ""].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:30:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      operation: { op: "provision", since: "2026-09-24T09:00:00.000Z" }, // 90 minutes ago — stale
    });

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.replacedAt).not.toBeNull();
  });

  it("an incarnation that changed mid-tick (a concurrent bring-up finished during the exec) also suppresses the verdict", async () => {
    let calls = 0;
    const storage = fakeStorage({ observed: { ...emptyObserved(), incarnation: TOK_1 } });
    const deps = {
      exec: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          // Simulate a concurrent bring-up finishing mid-exec: it overwrites
          // the DO's own stored incarnation while this tick's exec is still
          // "in flight" from this test's point of view.
          const storageAny = storage as unknown as ObservedStorage;
          await storageAny.put(OBSERVED_KEY, { ...emptyObserved(), incarnation: TOK_2 });
        }
        return {
          code: 0,
          stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", ""].join("\n"),
          stderr: "",
        };
      }),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.replacedAt).toBeNull(); // skipped — the incarnation changed mid-tick
    expect(observed.incarnation).toBe(TOK_2); // the concurrent write is left standing, not clobbered
  });
});

describe("runShipTickWithObservation — immediate D1 write on a transition", () => {
  it("a replaced transition calls recordStudioFn with the status carrying the new observed", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", ""].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      status: status({ id: "websites--pilot" }),
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});

    await runShipTickWithObservation(deps, storage, "websites--pilot", recordStudioFn, 5000);

    expect(recordStudioFn).toHaveBeenCalledTimes(1);
    const written = recordStudioFn.mock.calls[0][0] as StudioStatus;
    expect(written.observed?.replacedAt).not.toBeNull();
  });

  it("a steady-state successful tick (no transition) never calls recordStudioFn — rides the 300s mirror instead", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      status: status({ id: "websites--pilot" }),
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});

    await runShipTickWithObservation(deps, storage, "websites--pilot", recordStudioFn, 5000);

    expect(recordStudioFn).not.toHaveBeenCalled();
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 6: clearing `unreachable` is
  // exactly as much a D1 transition as setting/clearing `replaced` or an
  // adoption already are — without an explicit write here, a row can read
  // stale `unreachable` for up to SYNC_SESSION_SECONDS (300s) after the
  // container answers again.
  it("MUST-FIX 6: a successful tick that CLEARS unreachableSince calls recordStudioFn immediately", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:06:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1, execFailures: 3, unreachableSince: "2026-09-24T09:58:00.000Z" },
      status: status({ id: "websites--pilot" }),
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});

    await runShipTickWithObservation(deps, storage, "websites--pilot", recordStudioFn, 5000);

    expect(recordStudioFn).toHaveBeenCalledTimes(1);
    const written = recordStudioFn.mock.calls[0][0] as StudioStatus;
    expect(written.observed?.unreachableSince).toBeNull();
  });

  it("MUST-FIX 6: the SAME clear also writes immediately when it happens on the op-lock-fresh early-return path", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", ""].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:06:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1, execFailures: 3, unreachableSince: "2026-09-24T09:58:00.000Z" },
      status: status({ id: "websites--pilot" }),
      operation: { op: "provision", since: "2026-09-24T10:05:50.000Z" }, // fresh
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});

    await runShipTickWithObservation(deps, storage, "websites--pilot", recordStudioFn, 5000);

    const observed = await getObserved(storage);
    expect(observed.unreachableSince).toBeNull(); // reachability still resets even though op-fresh
    expect(recordStudioFn).toHaveBeenCalledTimes(1);
  });

  it("an adoption transition also calls recordStudioFn", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({ status: status({ id: "websites--pilot" }) }); // no observed seeded -> incarnation null
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});

    await runShipTickWithObservation(deps, storage, "websites--pilot", recordStudioFn, 5000);

    expect(recordStudioFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3b), Task 3 — the hook heartbeat threaded through
// applyActivityVerdict, exercised via the FULL runShipTickWithObservation
// path (not just the pure nextActivity function Task 1 already covers) —
// proves the wiring, not just the merge logic in isolation.
// ---------------------------------------------------------------------------
describe("runShipTickWithObservation — hook heartbeat merge", () => {
  const NOW = new Date("2026-09-25T12:00:00.000Z");
  const FRESHER = "2026-09-25T12:00:00.500Z";

  it("MUTANT PROOF (a): a fresher, contradicting hook claim wins the stored Activity's WORKING/IDLE axis", async () => {
    const hookRaw = JSON.stringify({ state: "working", at: FRESHER });
    const deps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(IDLE_PANE, hookRaw), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => NOW,
    };
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("working");
    expect(activity.source).toBe("hook");
    expect(activity.since).toBe(FRESHER);
  });

  it("MUTANT PROOF (b): a live rate limit is never overridden by a fresher, contradicting hook claim", async () => {
    const hookRaw = JSON.stringify({ state: "working", at: FRESHER });
    const deps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(IDLE_PANE, hookRaw), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => NOW,
    };
    const storage = fakeStorage({
      status: status({
        id: "websites--pilot", state: "running",
        rateLimited: { until: "2026-09-25T13:00:00.000Z", seenAt: NOW.toISOString() },
      }),
    });

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("limit");
    expect(activity.source).toBe("pane");
  });

  it("MUTANT PROOF (b): a fresh membersTickingAt is never overridden by a fresher, contradicting hook claim", async () => {
    const hookRaw = JSON.stringify({ state: "working", at: FRESHER });
    const deps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(IDLE_PANE, hookRaw), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => NOW,
    };
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      membersTickingAt: NOW.toISOString(),
    });

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("waiting-members");
    expect(activity.source).toBe("pane");
  });

  // Issue #221 fix round 2 (maestro review, PR #352, HIGH finding) — the
  // comparison basis is `hook.at` vs `prev.observedAt` (the LAST tick's own
  // capture instant), never a freshly-read `now` (see hookWinsAxis's own
  // doc comment, activity.ts, for why that comparison was unreachable in
  // production). A "tie" is only meaningful against a REAL prior
  // observation, so this seeds one via a first tick before exercising the
  // tie itself on the second.
  it("a hook no newer than the last look never wins — the pane's own verdict stands", async () => {
    const seedDeps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(WORKING_PANE, null), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => NOW,
    };
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    await runShipTickWithObservation(seedDeps, storage, "websites--pilot", undefined, 5000);
    expect((storage.map.get(ACTIVITY_KEY) as Activity).observedAt).toBe(NOW.toISOString());

    const LATER = new Date("2026-09-25T12:00:30.000Z");
    const hookRaw = JSON.stringify({ state: "idle", at: NOW.toISOString() }); // == prev.observedAt, a tie
    const deps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(WORKING_PANE, hookRaw), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => LATER,
    };

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("working");
    expect(activity.source).toBe("pane");
  });

  // The realistic-clock case the maestro's review explicitly demanded,
  // exercised through the FULL wiring: a hook.at that is OLDER than the
  // Worker-side `now` it's compared against (never in the future) but
  // still newer than the last look — exactly what a real hook stamp looks
  // like. MUTANT PROOF: reverting hookWinsAxis to the OLD `hook.at > now`
  // comparison turns this red, since FRESHER here is always in the past
  // relative to `now`.
  //
  // Issue #221 fix round 3 — the second tick's own pane is IDLE_PANE here
  // (agreeing with the hook), not WORKING_PANE as before: after round 3's
  // asymmetry fix (activity.ts's `hookIdleOverruledByWorkingPane`), a hook
  // `idle` claim can never win over a pane verdict of `working` this tick
  // regardless of timestamp, so pairing WORKING_PANE with a hook `idle`
  // claim here would exercise the round 3 guard instead of the timestamp
  // logic this test is actually about. The blocked-stop scenario itself
  // (hook idle vs. a working pane) has its own dedicated coverage in
  // studio.activity.test.ts's "round 3 MED fix" describe block.
  it("MUTANT PROOF (realistic clock): a hook timestamp seconds in the past, but newer than the last look, still wins", async () => {
    const seedDeps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(WORKING_PANE, null), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => NOW,
    };
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    await runShipTickWithObservation(seedDeps, storage, "websites--pilot", undefined, 5000);

    const readAt = new Date("2026-09-25T12:00:30.000Z"); // the next 30s tick
    const hookRaw = JSON.stringify({ state: "idle", at: "2026-09-25T12:00:18.000Z" }); // 12s before readAt
    const deps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(IDLE_PANE, hookRaw), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => readAt,
    };

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("idle");
    expect(activity.source).toBe("hook");
    expect(activity.since).toBe("2026-09-25T12:00:18.000Z");
  });

  // Issue #221 fix round 3 (maestro review, PR #352, MED finding) — the
  // blocked-stop scenario, exercised through the FULL wiring: a hook idle
  // claim, fresher than the last look and well within the staleness budget,
  // must still lose to THIS tick's own pane capture when that capture reads
  // working (the spinner never actually stopped, because completion-gate.sh
  // blocked the Stop). RED before the fix (the hook won, flipping the row
  // to idle for one tick); GREEN after.
  it("blocked-stop scenario: a hook idle claim never overrides a working pane verdict this tick, even through the full ship-tick wiring", async () => {
    const seedDeps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(WORKING_PANE, null), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => NOW,
    };
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    await runShipTickWithObservation(seedDeps, storage, "websites--pilot", undefined, 5000);

    const readAt = new Date("2026-09-25T12:00:30.000Z"); // the next 30s tick
    const hookRaw = JSON.stringify({ state: "idle", at: "2026-09-25T12:00:18.000Z" }); // 12s before readAt, in budget
    const deps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(WORKING_PANE, hookRaw), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => readAt,
    };

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("working");
    expect(activity.source).toBe("pane");
  });

  it("a hook-driven state CHANGE fires the immediate D1 write, same as a pane-driven one", async () => {
    const hookRaw = JSON.stringify({ state: "working", at: FRESHER });
    const deps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(IDLE_PANE, hookRaw), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => NOW,
    };
    // observed seeded with the SAME incarnation the stdout reports, so the
    // only transition this tick can produce is the activity one under test
    // — otherwise a null->TOK_1 "adoption" transition (unrelated to this
    // feature) would also call recordStudioFn, double-counting the assertion.
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      status: status({ id: "websites--pilot", state: "running" }),
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});

    await runShipTickWithObservation(deps, storage, "websites--pilot", recordStudioFn, 5000);

    expect(recordStudioFn).toHaveBeenCalledTimes(1);
  });

  it("a hook-driven tick that AGREES with the already-stored state does not fire an extra D1 write", async () => {
    const hookRaw1 = JSON.stringify({ state: "working", at: FRESHER });
    const deps1: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(IDLE_PANE, hookRaw1), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => NOW,
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      status: status({ id: "websites--pilot", state: "running" }),
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    await runShipTickWithObservation(deps1, storage, "websites--pilot", recordStudioFn, 5000);
    expect(recordStudioFn).toHaveBeenCalledTimes(1);

    const LATER = new Date("2026-09-25T12:00:30.000Z");
    const hookRaw2 = JSON.stringify({ state: "working", at: "2026-09-25T12:00:30.500Z" });
    const deps2: ShipDeps = {
      exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPaneAndHook(IDLE_PANE, hookRaw2), stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => LATER,
    };
    await runShipTickWithObservation(deps2, storage, "websites--pilot", recordStudioFn, 5000);
    expect(recordStudioFn).toHaveBeenCalledTimes(1); // still 1 — no new transition
  });
});

describe("runShipTickWithObservation — reachability", () => {
  const SHORT_DEADLINE_MS = 50; // maestro correction #14 — never the real 15s in a test

  function hangingDeps(): ShipDeps {
    return {
      exec: vi.fn((_cmd: string) => new Promise<{ code: number; stdout: string; stderr: string }>(() => {})), // never resolves — the deadline must fire
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
  }

  it("3 consecutive timeouts sets unreachableSince", async () => {
    const deps = hangingDeps();
    const storage = fakeStorage();
    for (let i = 0; i < 3; i++) {
      await expect(
        runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
      ).rejects.toThrow(ExecUnreachableError);
    }
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(3);
    expect(observed.unreachableSince).toBe("2026-09-24T10:00:00.000Z");
  }, 10000);

  it("a 4th consecutive timeout does not move unreachableSince forward", async () => {
    const storage = fakeStorage({
      observed: { ...emptyObserved(), execFailures: 3, unreachableSince: "2026-09-24T09:58:00.000Z" },
    });
    const deps = { ...hangingDeps(), now: () => new Date("2026-09-24T10:05:00.000Z") };
    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(4);
    expect(observed.unreachableSince).toBe("2026-09-24T09:58:00.000Z");
  }, 10000);

  it("a nonzero-exit response (exec plane alive, command failed) does NOT count toward execFailures (maestro correction #5)", async () => {
    const storage = fakeStorage();
    const deps = {
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "container-side error" })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.not.toThrow(ExecUnreachableError);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 5: the success path already
  // skips replaced/unreachable/adoption entirely while OPERATION_KEY is
  // fresh (a bring-up simply has not finished writing its own token yet).
  // The FAILURE path (an ExecUnreachableError) had no such check at all — a
  // ship tick racing a slow-but-real bring-up would count that bring-up's
  // own in-flight exec as a reachability failure. Mirrors the exact op-lock
  // freshness check the success path already has.
  it("MUST-FIX 5: a fresh operation lock suppresses failure-counting on a timeout, same as it already does on success", async () => {
    const storage = fakeStorage({
      operation: { op: "provision", since: "2026-09-24T09:59:30.000Z" }, // 30s ago, fresh
    });
    const deps = { ...hangingDeps(), now: () => new Date("2026-09-24T10:00:00.000Z") };

    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);

    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
  });

  it("a STALE operation lock does NOT suppress failure-counting on a timeout", async () => {
    const storage = fakeStorage({
      operation: { op: "provision", since: "2026-09-24T09:00:00.000Z" }, // 60 minutes ago — stale
    });
    const deps = { ...hangingDeps(), now: () => new Date("2026-09-24T10:00:00.000Z") };

    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);

    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(1);
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 7: unreachableSince stamps at
  // the FIRST failure (0->1), not the 3rd — that stamping point is
  // unchanged. Board issue #183: the READY-column render/crossing condition
  // (cli/readiness-format.ts's readyOverride) is no longer a bare
  // execFailures >= 3 count; it's the new time-based isUnreachable rule
  // (execFailures >= 2 AND now - lastShipOkAt >= 90s).
  it("MUST-FIX 7: unreachableSince stamps at the first failure and does not move on the 2nd or 3rd — advancing clock", async () => {
    const storage = fakeStorage();
    const times = ["2026-09-24T10:00:00.000Z", "2026-09-24T10:00:05.000Z", "2026-09-24T10:00:10.000Z"];
    let i = 0;
    const deps: ShipDeps = {
      exec: vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>(() => {})), // never resolves
      r2Put: vi.fn(async () => {}),
      now: () => new Date(times[i]),
    };

    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    let observed = await getObserved(storage);
    expect(observed.execFailures).toBe(1);
    expect(observed.unreachableSince).toBe(times[0]); // stamped on failure 1

    i = 1;
    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    observed = await getObserved(storage);
    expect(observed.execFailures).toBe(2);
    expect(observed.unreachableSince).toBe(times[0]); // unchanged — 2 failures is not yet "unreachable"

    i = 2;
    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    observed = await getObserved(storage);
    expect(observed.execFailures).toBe(3);
    expect(observed.unreachableSince).toBe(times[0]); // still the ORIGINAL 1st-failure timestamp
  }, 10000);

  // Issue #85 review round 4, NIT 16(b) — a RESOLVED response killed by ITS
  // OWN in-container deadline (#110's isDeadlineExit — exit 124/137) is the
  // same "genuinely unreachable" signal a transport-level timeout already
  // is, never a real answer the exec plane gave. Folded into
  // withExecDeadline so this keeps counting once the outer race is loosened
  // (below) past the point where an in-container kill can actually resolve
  // rather than reject.
  it("NIT 16(b): a RESOLVED response killed by its own deadline (isDeadlineExit) counts as unreachable too", async () => {
    const storage = fakeStorage();
    const deps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 124, stdout: "", stderr: "" })), // timeout(1)'s own exit code
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(1);
    expect(observed.unreachableSince).toBe("2026-09-24T10:00:00.000Z");
  });

  // Issue #85 review round 6, MUST-FIX 7 pin — `SessionBusyError`
  // (sandbox-api.ts) is `sbExec`'s own refusal when a session still holds an
  // exec the Worker already abandoned: a REJECTION from the underlying
  // `exec()`, exactly like a transport-level timeout. `withExecDeadline`
  // (do.ts) wraps every non-`ExecUnreachableError` rejection into one (the
  // same catch-all its own doc comment describes), so this already counts
  // toward `execFailures`/`unreachableSince` with no code change — this pins
  // that behaviour rather than changing it.
  it("MUST-FIX 7 pin: a SessionBusyError rejection counts toward execFailures, same as any other exec failure", async () => {
    const storage = fakeStorage();
    const deps: ShipDeps = {
      exec: vi.fn(async () => { throw new SessionBusyError("fleet-ship"); }),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(deps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(1);
    expect(observed.unreachableSince).toBe("2026-09-24T10:00:00.000Z");
  });

  // Issue #85 review round 4, NIT 16(b) — MEASURED double-counting: this
  // suite's OWN default deadline (production, no explicit deadlineMs passed)
  // used to be INSPECT_EXEC_MS (15s), strictly SHORTER than #110's own
  // already-merged ship-class exec-level deadline (20s in-container kill, or
  // 20s + DEADLINE_SLACK_MS Worker-side) — a tick that was merely SLOW but
  // ALIVE (15-20s) got flagged unreachable by this file's own redundant race
  // firing first. Proven here with fake timers: a 18s-late but genuine
  // success must resolve cleanly on the PRODUCTION default, never throw.
  it("NIT 16(b): a slow-but-alive 18s tick on the PRODUCTION default deadline succeeds, never flagged unreachable", async () => {
    vi.useFakeTimers();
    try {
      const storage = fakeStorage();
      const deps: ShipDeps = {
        exec: vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          setTimeout(() => resolve({
            code: 0,
            stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1"].join("\n"),
            stderr: "",
          }), 18_000);
        })),
        r2Put: vi.fn(async () => {}),
        now: () => new Date("2026-09-24T10:00:00.000Z"),
      };
      // No 5th argument here — this is the one test in this suite that
      // exercises the REAL production default, deliberately.
      const p = runShipTickWithObservation(deps, storage, "websites--pilot");
      await vi.advanceTimersByTimeAsync(18_000);
      await expect(p).resolves.toBeDefined();
      const observed = await getObserved(storage);
      expect(observed.execFailures).toBe(0);
      expect(observed.unreachableSince).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a success after failures resets both fields to zero/null", async () => {
    const storage = fakeStorage({
      observed: { ...emptyObserved(), execFailures: 3, unreachableSince: "2026-09-24T09:58:00.000Z", incarnation: TOK_1 },
    });
    const okDeps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:06:00.000Z"),
    };
    await runShipTickWithObservation(okDeps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
  });
});

describe("runShipTickWithObservation — adoption session verdict", () => {
  it("an adoption records a session verdict via: \"adopted\" (maestro correction #7)", async () => {
    const deps = {
      exec: vi.fn(async (_cmd: string) => ({
        code: 0,
        stdout: [
          "---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1,
          "---FLEET-SESSION-FOUND---", "yes", "---FLEET-SESSION-CONTINUE---", "yes", "---FLEET-SESSION-CWD---", "/workspace/acme-os",
        ].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({ status: status({ id: "acme-os--pilot" }) });

    await runShipTickWithObservation(deps, storage, "acme-os--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("adopted");
    expect(observed.session?.verdict).toBe("resumed"); // --continue found, cwd matches
  });

  it("an adoption with an unclear pane never records LOST (maestro correction #7)", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: [
          "---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1,
          "---FLEET-SESSION-FOUND---", "no", "---FLEET-SESSION-CONTINUE---", "no", "---FLEET-SESSION-CWD---", "",
        ].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({ status: status({ id: "acme-os--pilot" }) });

    await runShipTickWithObservation(deps, storage, "acme-os--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.session?.verdict).not.toBe("lost");
    expect(observed.session?.verdict).toBe("unknown");
  });

  // Board issue #223 fix: the two tests above (resumed / found:false) both
  // happen to land on the same verdict whether `runShipTickWithObservation`'s
  // adoption branch calls `computeAdoptedVerdict` OR the normal bring-up
  // `computeSessionVerdict` by mistake — `found:false` reads `unknown` either
  // way, and `found:true, hasContinue:true, cwd matches` reads `resumed`
  // either way. Neither would go red if the call site were swapped to the
  // wrong function. This test's own combination — found, NO --continue, and
  // REAL prior turn history (turnsBefore>0) — is the one case where the two
  // functions genuinely disagree: `computeSessionVerdict` would read this as
  // `lost` (has history, no --continue), while `computeAdoptedVerdict`'s own
  // deliberate design (maestro correction #7) never guesses `lost` on an
  // adoption, because adoption genuinely does not know the launch history.
  it("an adoption with the container found, no --continue, but real prior turn history still records unknown — never guesses lost (maestro correction #7)", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: [
          "---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1,
          "---FLEET-SESSION-FOUND---", "yes", "---FLEET-SESSION-CONTINUE---", "no", "---FLEET-SESSION-CWD---", "/workspace/acme-os",
        ].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({
      status: status({
        id: "acme-os--pilot",
        burn: { turns: 40, inputTokens: 0, outputTokens: 0, costUsd: 0, window5hStart: "2026-09-24T09:00:00.000Z", window5hOutput: 0 },
      }),
    });

    await runShipTickWithObservation(deps, storage, "acme-os--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("adopted");
    expect(observed.session?.verdict).toBe("unknown");
    expect(observed.session?.reason).toBe("adopted: launch history unknown");
  });

  it("a steady-state tick (no adoption) never sets a session verdict", async () => {
    const deps = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", TOK_1].join("\n"),
        stderr: "",
      })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const storage = fakeStorage({
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      status: status({ id: "acme-os--pilot" }),
    });

    await runShipTickWithObservation(deps, storage, "acme-os--pilot", undefined, 5000);

    const observed = await getObserved(storage);
    expect(observed.session).toBeNull();
  });
});
