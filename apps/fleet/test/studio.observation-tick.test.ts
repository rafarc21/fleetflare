// Board issue #85 — the ship tick's incarnation detection, folded exec-level
// deadline, op-lock re-check, and immediate D1 write on a real transition.
// See docs/superpowers/plans/2026-09-24-row-tells-truth-pr1.md's Task 4 (the
// merged detection+reachability rewrite) for the full design narrative —
// this file exercises `incarnationPatch` (pure) and
// `runShipTickWithObservation` (do.ts's exported wrapper) directly, the same
// "pure function/do.ts method forwards to it, tests exercise the function"
// split every other studio subsystem in this feature already uses.
import { describe, it, expect, vi } from "vitest";
import {
  incarnationPatch, runShipTickWithObservation, ExecUnreachableError,
  SHIP_EXEC_DEADLINE_MS, SHIP_TRANSCRIPT_SECONDS, doneRecordsListCmd, ARCHIVE_DEADLINE_MS,
  AUTO_WORKING_KEY, AUTO_WORKING_EVERY_MS,
} from "../src/studio/do";
import { emptyObserved, getObserved, isUnreachable, OBSERVED_KEY, type Observed, type ObservedStorage } from "../src/studio/observed";
import { STATUS_KEY, OPERATION_KEY, type OperationInFlight, type StudioStorage } from "../src/studio/provision";
import type { TranscriptStorage, ShipDeps } from "../src/studio/transcript";
import type { StudioStatus } from "../src/studio/types";
import { SessionBusyError } from "../src/studio/sandbox-api";
import { readyOverride } from "../cli/readiness-format";
import { ACTIVITY_KEY, LAST_LINE_MAX_CHARS, type Activity } from "../src/studio/activity";
import { MEMBERS_TICKING_KEY } from "../src/studio/failover";
import { MEMBER_ALERTS_KEY, MEMBER_ROWS_KEY, type MemberAlert } from "../src/studio/member-alerts";
import { exhaustedMessage } from "../src/studio/failover";
import { redactSecrets } from "../src/studio/redact";

/** UTF-8 aware base64 — a pane frame carries claude's own box-drawing/emoji
 *  glyphs, which plain `btoa` throws on outright (Latin1 only). */
function b64Utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

const SECTION_PANE_MARKER = "---FLEET-PANE---";
const SECTION_MEMGUARD_MARKER = "---FLEET-MEMGUARD---";
const SECTION_ACTIVITY_HOOK = "---FLEET-ACTIVITY-HOOK---";

/** A minimal idle pane: no `✻` status line, straight into the idle input box. */
const IDLE_PANE = ["⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
/** A minimal working pane: a live spinner as the last `✻` line. */
const WORKING_PANE = ["✻ Cogitating… (3s · esc to interrupt)", "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
/** A pane carrying ONE agent-panel row, name "frontend-developer", the SAME
 *  fixture shape REAL_WEBSTUDIO_PANE (test/fixtures/rate-limit-panes.ts)
 *  uses — issue #311's member-alert tests parameterize the row's own
 *  elapsed/tokens text via `withMemberRow`, below. */
function withMemberRow(rowText: string): string {
  return [
    "⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68),
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)", "",
    `  ◯ ${rowText}`,
  ].join("\n");
}

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

/** Issue #311 — same shape as `stdoutWithPane`, plus a SECTION_MEMGUARD
 *  section carrying `memguardLines` (already-formatted log lines, `\n`-
 *  joined, may be empty). */
function stdoutWithPaneAndMemguard(pane: string, memguardLines: string[], incarnation = TOK_1): string {
  const base = ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", incarnation];
  return [
    ...base, SECTION_PANE_MARKER, b64Utf8(pane), SECTION_MEMGUARD_MARKER, b64Utf8(memguardLines.join("\n")),
  ].join("\n");
}

const TOK_1 = "11111111-2222-3333-4444-555555555555";
const TOK_2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

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

describe("incarnationPatch — pure decision table (issue #85, maestro correction #3 rewrite)", () => {
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

describe("runShipTickWithObservation — adoption folded into one exec (issue #85, maestro correction #6)", () => {
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

describe("runShipTickWithObservation — op-lock guard (issue #85, maestro correction #4)", () => {
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

describe("runShipTickWithObservation — immediate D1 write on a transition (issue #85, maestro correction #1)", () => {
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
describe("runShipTickWithObservation — hook heartbeat merge (issue #221, PR3b)", () => {
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

describe("runShipTickWithObservation — reachability (issue #85)", () => {
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

describe("runShipTickWithObservation — adoption session verdict (issue #85, maestro correction #7)", () => {
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

// Board issue #183 — the maestro's own stated fix: "unreachable iff ≥2
// consecutive failed ship ticks AND now − lastShipOkAt ≥ 90s. Tick cadence
// unchanged." Replaces the old fixed `execFailures >= 3` render gate (issue
// #85 PR1), which — composed with the ship tick's own looser
// SHIP_EXEC_DEADLINE_MS (round 4/5/6 fix) and its self-perpetuating
// SHIP_TRANSCRIPT_SECONDS reschedule — had drifted to 89-141s (round 6,
// MUST-FIX 3 measurement), far from the spec's original ~90s goal.
//
// These tests use the REAL production constants (SHIP_EXEC_DEADLINE_MS,
// SHIP_TRANSCRIPT_SECONDS), not an injected small deadline — unlike this
// file's other reachability tests (SHORT_DEADLINE_MS, maestro correction
// #14), which test different things and stay exactly as they are. The whole
// point here is proving the ACTUAL production timing lands where the fix
// intends.
describe("runShipTickWithObservation — time-based unreachable rule (board issue #183)", () => {
  function successStdout(token: string): { code: number; stdout: string; stderr: string } {
    return {
      code: 0,
      stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", token].join("\n"),
      stderr: "",
    };
  }

  function neverResolvingExec(): ShipDeps["exec"] {
    return vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>(() => {}));
  }

  // Real-numbers arithmetic (SHIP_TRANSCRIPT_SECONDS=30s,
  // SHIP_EXEC_DEADLINE_MS=30_000ms as of this fix):
  //   tick2 fails at T0 + 30s (reschedule) + 30s (hung exec's own deadline)  = T0+60s  -> 1 failure,  60s elapsed
  //   tick3 fails at (T0+60s) + 30s (reschedule) + 30s (hung exec's deadline) = T0+120s -> 2 failures, 120s elapsed
  // 120s is ONE measured scenario — the fully-hung-exec case, where the
  // exec never resolves until THIS FILE's own looser SHIP_EXEC_DEADLINE_MS
  // backstop fires — not THE definitive number for every failure mode. Board
  // issue #183 review round 2 measured a more complete picture: a
  // FAST-failing exec streak (e.g. #110's SessionBusyError, an
  // near-instant reject, or a hung exec resolved by #110's OWN tighter
  // underlying exec-level deadline rather than this file's own backstop)
  // reaches 2 failures at roughly 87-89s — under 90s at that exact instant —
  // see this file's own "BLOCKER 1" test below for that scenario's full
  // worked timing and the D1-write-trigger fix it required. Both this
  // fully-hung 120s figure AND the fast-fail ~87-89s figure exceed, or sit
  // right at the edge of, the 90s threshold once elapsed time is measured
  // correctly — this test pins the fully-hung-exec case specifically, not
  // every failure mode this rule has to handle.
  it("realistic hung-container sequence: NOT unreachable at 1 failure (60s), unreachable at 2 failures (120s)", async () => {
    vi.useFakeTimers();
    try {
      const T0 = new Date("2026-09-24T10:00:00.000Z");
      const storage = fakeStorage();

      // Tick 1 — a genuine success at T0. Sets lastShipOkAt.
      const okDeps: ShipDeps = {
        exec: vi.fn(async () => successStdout(TOK_1)),
        r2Put: vi.fn(async () => {}),
        now: () => T0,
      };
      await runShipTickWithObservation(okDeps, storage, "websites--pilot");
      let observed = await getObserved(storage);
      expect(observed.lastShipOkAt).toBe(T0.toISOString());

      // Tick 2 — starts SHIP_TRANSCRIPT_SECONDS after tick 1, hangs for the
      // FULL production SHIP_EXEC_DEADLINE_MS before resolving as a failure.
      const tick2Start = new Date(T0.getTime() + SHIP_TRANSCRIPT_SECONDS * 1000);
      const tick2Fail = new Date(tick2Start.getTime() + SHIP_EXEC_DEADLINE_MS);
      const hangDeps: ShipDeps = { exec: neverResolvingExec(), r2Put: vi.fn(async () => {}), now: () => tick2Fail };
      const p2 = runShipTickWithObservation(hangDeps, storage, "websites--pilot");
      // The rejection assertion is constructed (attaching a handler to `p2`)
      // BEFORE advancing the fake timers that actually trigger it — deferring
      // that attachment until after `advanceTimersByTimeAsync` resolves would
      // race Node's own unhandled-rejection detection against the moment the
      // assertion's `.catch` is finally attached.
      const rejects2 = expect(p2).rejects.toThrow(ExecUnreachableError);
      await vi.advanceTimersByTimeAsync(SHIP_EXEC_DEADLINE_MS);
      await rejects2;
      observed = await getObserved(storage);
      expect(observed.execFailures).toBe(1);
      const elapsedAtTick2 = tick2Fail.getTime() - T0.getTime();
      expect(elapsedAtTick2).toBe(60_000); // SHIP_TRANSCRIPT_SECONDS + SHIP_EXEC_DEADLINE_MS, from T0
      expect(elapsedAtTick2).toBeLessThan(90_000);
      expect(isUnreachable(observed, tick2Fail)).toBe(false);

      // Tick 3 — starts SHIP_TRANSCRIPT_SECONDS after tick 2's body ends,
      // ALSO hangs the full deadline before resolving as a failure.
      const tick3Start = new Date(tick2Fail.getTime() + SHIP_TRANSCRIPT_SECONDS * 1000);
      const tick3Fail = new Date(tick3Start.getTime() + SHIP_EXEC_DEADLINE_MS);
      const hangDeps2: ShipDeps = { exec: neverResolvingExec(), r2Put: vi.fn(async () => {}), now: () => tick3Fail };
      const p3 = runShipTickWithObservation(hangDeps2, storage, "websites--pilot");
      const rejects3 = expect(p3).rejects.toThrow(ExecUnreachableError);
      await vi.advanceTimersByTimeAsync(SHIP_EXEC_DEADLINE_MS);
      await rejects3;
      observed = await getObserved(storage);
      expect(observed.execFailures).toBe(2);
      const elapsedAtTick3 = tick3Fail.getTime() - T0.getTime();
      expect(elapsedAtTick3).toBe(2 * SHIP_TRANSCRIPT_SECONDS * 1000 + 2 * SHIP_EXEC_DEADLINE_MS);
      expect(elapsedAtTick3).toBe(120_000); // the real number — see this describe block's own doc comment
      expect(elapsedAtTick3).toBeGreaterThanOrEqual(90_000);
      expect(isUnreachable(observed, tick3Fail)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("a slow-but-ultimately-OK exec (just under the deadline) never flips unreachable — resets exactly like any other success", async () => {
    vi.useFakeTimers();
    try {
      const T0 = new Date("2026-09-24T10:00:00.000Z");
      const storage = fakeStorage({
        observed: {
          ...emptyObserved(), execFailures: 1, unreachableSince: T0.toISOString(),
          lastShipOkAt: new Date(T0.getTime() - 60_000).toISOString(),
        },
      });
      const successAt = new Date(T0.getTime() + SHIP_EXEC_DEADLINE_MS - 1_000);
      const deps: ShipDeps = {
        exec: vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          setTimeout(() => resolve(successStdout(TOK_1)), SHIP_EXEC_DEADLINE_MS - 1_000);
        })),
        r2Put: vi.fn(async () => {}),
        now: () => successAt,
      };
      const p = runShipTickWithObservation(deps, storage, "websites--pilot");
      await vi.advanceTimersByTimeAsync(SHIP_EXEC_DEADLINE_MS - 1_000);
      await expect(p).resolves.toBeDefined();
      const observed = await getObserved(storage);
      expect(observed.execFailures).toBe(0);
      expect(observed.unreachableSince).toBeNull();
      expect(observed.lastShipOkAt).toBe(successAt.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovery is immediate on the first success after genuinely unreachable — no lingering state", async () => {
    const T0 = new Date("2026-09-24T10:00:00.000Z");
    const recoveredAt = new Date(T0.getTime() + 130_000);
    const storage = fakeStorage({
      observed: { ...emptyObserved(), execFailures: 2, unreachableSince: T0.toISOString(), lastShipOkAt: T0.toISOString() },
    });
    expect(isUnreachable(await getObserved(storage), recoveredAt)).toBe(true); // sanity: genuinely unreachable going in

    const deps: ShipDeps = {
      exec: vi.fn(async () => successStdout(TOK_1)),
      r2Put: vi.fn(async () => {}),
      now: () => recoveredAt,
    };
    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5_000);
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
    expect(observed.lastShipOkAt).toBe(recoveredAt.toISOString());
  });

  // Board issue #183 review round 2, MUST-FIX 2 — a studio DEAD FROM ITS
  // VERY FIRST TICK never records a `lastShipOkAt` (it has never once
  // succeeded), but `unreachableSince` IS available (stamped at the first
  // failure, do.ts) — the `lastShipOkAt ?? unreachableSince` anchor
  // (observed.ts) means this studio can still correctly report unreachable
  // once 90s have elapsed since THAT first failure, rather than being
  // permanently protected from ever showing the signal.
  it("MUST-FIX 2: lastShipOkAt === null (dead from the first-ever tick) with 2+ failures still reports unreachable once 90s elapse since unreachableSince", async () => {
    const storage = fakeStorage(); // no observed seeded -> emptyObserved(), lastShipOkAt null
    const hangDeps: ShipDeps = { exec: neverResolvingExec(), r2Put: vi.fn(async () => {}), now: () => new Date("2026-09-24T10:00:00.000Z") };
    const SHORT_DEADLINE_MS = 50; // maestro correction #14 — never the real deadline in this test
    for (let i = 0; i < 2; i++) {
      await expect(
        runShipTickWithObservation(hangDeps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
      ).rejects.toThrow(ExecUnreachableError);
    }
    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(2);
    expect(observed.lastShipOkAt).toBeNull();
    expect(observed.unreachableSince).toBe("2026-09-24T10:00:00.000Z"); // stamped at the first failure
    expect(isUnreachable(observed, new Date("2026-09-24T10:00:00.000Z"))).toBe(false); // 0s elapsed yet
    expect(isUnreachable(observed, new Date("2026-09-24T10:10:00.000Z"))).toBe(true); // 10m later — falls back to unreachableSince
  });

  // Board issue #183 review round 2, BLOCKER 1 — a FAST-FAILING exec streak
  // (e.g. #110's SessionBusyError, which rejects near-instantly rather than
  // hanging the full deadline) can reach execFailures===2 while `isUnreachable`
  // itself is STILL false at that exact instant (elapsed since lastShipOkAt
  // has not yet crossed 90s) — the OLD `crossedUnreachableThreshold`
  // (isUnreachableNow && !wasUnreachableBefore) never fires here, since
  // isUnreachableNow is false too. Without a forced write at this exact
  // checkpoint, D1 stays stale (still reflecting the pre-failure healthy
  // state) until either the next tick or the 300s mirror — exactly the "fleet
  // ls waits for the sync mirror" gap the review measured.
  //
  // Real production constants: tick 1's own hung exec resolves as a failure
  // via #110's OWN underlying exec-level deadline (EXEC_CLASSES.ship.timeoutMs
  // 20s + DEADLINE_SLACK_MS 7s = 27s) — NOT this file's own looser
  // SHIP_EXEC_DEADLINE_MS (30s) backstop race, which exists precisely so the
  // tighter, real mechanism fires first (see withExecDeadline's own doc
  // comment). Starting SHIP_TRANSCRIPT_SECONDS (30s) after the T0 success,
  // that lands tick 1's failure at T0+30s+27s = T0+57s — matching the
  // review's own measured "T0+57" number exactly once the REAL underlying
  // exec deadline (27s), not this file's own backstop (30s), is used. Tick 2
  // (an instant SessionBusyError reject, no hang at all) starts exactly
  // SHIP_TRANSCRIPT_SECONDS later and fails immediately, at T0+57s+30s =
  // T0+87s — also matching the review's own number.
  it("BLOCKER 1: a fast-failing streak (SessionBusyError-style instant rejects) forces the D1 write the moment execFailures reaches 2, even though isUnreachable itself is not yet true at that instant", async () => {
    const T0 = new Date("2026-09-24T10:00:00.000Z");
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });

    // Tick 0 — a genuine success at T0. Sets lastShipOkAt.
    const okDeps: ShipDeps = {
      exec: vi.fn(async () => successStdout(TOK_1)),
      r2Put: vi.fn(async () => {}),
      now: () => T0,
    };
    await runShipTickWithObservation(okDeps, storage, "websites--pilot");

    // Tick 1 — fails at T0+57s (see this test's own doc comment for why 57s,
    // not this file's own 30s backstop, is the real number).
    const tick1Now = new Date(T0.getTime() + 57_000);
    const failDeps1: ShipDeps = {
      exec: vi.fn(async () => { throw new SessionBusyError("fleet-ship"); }),
      r2Put: vi.fn(async () => {}),
      now: () => tick1Now,
    };
    await expect(
      runShipTickWithObservation(failDeps1, storage, "websites--pilot", undefined, 5_000),
    ).rejects.toThrow(ExecUnreachableError);
    let observed = await getObserved(storage);
    expect(observed.execFailures).toBe(1);

    // Tick 2 — an INSTANT reject, SHIP_TRANSCRIPT_SECONDS (30s) after tick 1's
    // own failure: T0+87s. execFailures becomes 2 here. Elapsed since
    // lastShipOkAt is 87s < 90s, so `isUnreachable` is still FALSE at this
    // exact instant — the crux of the bug.
    const tick2Now = new Date(tick1Now.getTime() + 30_000);
    expect(tick2Now.getTime() - T0.getTime()).toBe(87_000);
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    const failDeps2: ShipDeps = {
      exec: vi.fn(async () => { throw new SessionBusyError("fleet-ship"); }),
      r2Put: vi.fn(async () => {}),
      now: () => tick2Now,
    };
    await expect(
      runShipTickWithObservation(failDeps2, storage, "websites--pilot", recordStudioFn, 5_000),
    ).rejects.toThrow(ExecUnreachableError);
    observed = await getObserved(storage);
    expect(observed.execFailures).toBe(2);
    expect(isUnreachable(observed, tick2Now)).toBe(false); // not yet true AT this instant

    // THE FIX: the D1 write must fire the moment execFailures reaches 2,
    // regardless of whether isUnreachable itself is already true right now.
    expect(recordStudioFn).toHaveBeenCalledTimes(1);
    const written = recordStudioFn.mock.calls[0][0] as StudioStatus;
    expect(written.observed?.execFailures).toBe(2);

    // With the row now carrying a fresh, accurate lastShipOkAt/execFailures,
    // a LATER render check (readyOverride, cli/readiness-format.ts) at T0+90s
    // correctly reads unreachable — this is what the forced write above buys:
    // without it, D1 would still show the pre-failure healthy state here.
    const t90 = new Date(T0.getTime() + 90_000);
    const override = readyOverride(written, t90);
    expect(override).not.toBeNull();
    expect(override).toContain("unreachable");
  });

  // Board issue #183 review round 2, MUST-FIX 3(d) — the UNREACHABLE
  // checkpoint's own out-of-cadence D1 write (`recordStudioFn`) is meant to
  // fire EXACTLY ONCE per failure streak, at the `failures === 2` mandatory
  // checkpoint (BLOCKER 1 above), never again on later failing ticks in the
  // SAME streak (the steady state still rides the existing 300s burn-mirror
  // cadence). `now` is held CONSTANT across every tick here specifically so
  // the transition-based trigger (`isUnreachableNow && !wasUnreachableBefore`)
  // never fires on its own — the only thing that can cause a write from THIS
  // mechanism in this sequence is the `failures === 2` checkpoint itself.
  //
  // Issue #221 fix round 2, Fix 5 layers a SECOND, independent trigger on
  // top: the ship tick's own activity write now fires even on a probe
  // failure (`{kind: "unknown", reason: "probe failed"}`), and that is
  // itself a state CHANGE the first time it happens (tick 1: `null` ->
  // `unknown`), so it contributes its OWN immediate D1 write there. The
  // counts below (1 after tick 1, 2 after tick 2, unchanged at 2 after tick
  // 3) are the sum of both mechanisms — this still kills the SAME two
  // mutants MUST-FIX 3(d) originally named: a "never writes" mutant (the
  // count would stay lower than expected after tick 2) and a "writes on
  // every failure" mutant (tick 3 would add a THIRD call it must not add).
  it("MUST-FIX 3(d): recordStudioFn is called EXACTLY ONCE across a failure streak crossing into unreachable, never again on a later failing tick in the same streak", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    const hangDeps: ShipDeps = {
      exec: neverResolvingExec(), r2Put: vi.fn(async () => {}), now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
    const SHORT_DEADLINE_MS = 50;

    // Tick 1 — first failure of the streak (execFailures 0->1). Below the
    // `failures === 2` mandatory checkpoint, so THIS mechanism must not write
    // yet — but issue #221 fix round 2, Fix 5 added a SEPARATE, independent
    // trigger: the first probe failure is also the first time `activity`
    // changes (null -> `unknown`/"probe failed"), and that state CHANGE
    // fires its own immediate D1 write (do.ts's `applyActivityVerdict`),
    // exactly as any other activity state change would. One call, from Fix
    // 5, not from the unreachable checkpoint this test targets.
    await expect(
      runShipTickWithObservation(hangDeps, storage, "websites--pilot", recordStudioFn, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    expect(recordStudioFn).toHaveBeenCalledTimes(1);

    // Tick 2 — crosses execFailures 1->2, the mandatory checkpoint: the ONE
    // moment THIS streak's own out-of-cadence write must fire. Activity
    // itself does NOT change again (still `unknown`/"probe failed" from tick
    // 1), so this tick's only NEW call is the unreachable checkpoint's own —
    // cumulative 2 (1 from Fix 5's activity write in tick 1, 1 from this
    // checkpoint), never 3.
    await expect(
      runShipTickWithObservation(hangDeps, storage, "websites--pilot", recordStudioFn, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    expect(recordStudioFn).toHaveBeenCalledTimes(2);

    // Tick 3 — one more failing tick in the SAME streak (execFailures 2->3).
    // Neither trigger fires again: activity is unchanged, and the unreachable
    // checkpoint only ever fires at the `failures === 2` crossing.
    await expect(
      runShipTickWithObservation(hangDeps, storage, "websites--pilot", recordStudioFn, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    expect(recordStudioFn).toHaveBeenCalledTimes(2); // still exactly 2 across the whole sequence

    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(3);
  });
});

// Board issue #183 review round 2, SHOULD-FIX 5 — "never count it toward
// reachability" (maestro correction #5, do.ts) used to mean only "don't
// increment `execFailures`"; a resolved-but-degraded response (nonzero exit,
// an R2 put failure, a parse failure, a rotate failure) proved the exec plane
// was alive just as much as a clean success does, but left any PRIOR failure
// streak's `execFailures`/`unreachableSince` frozen exactly where they were,
// and never touched `lastShipOkAt` at all. A studio alternating real
// failures with merely degraded-but-answered ticks could therefore still
// drift `now - lastShipOkAt` past 90s and misreport unreachable, despite the
// exec plane having repeatedly proven itself alive in between. The fix:
// treat a resolved-but-degraded response exactly like a clean success for
// reachability purposes — reset `execFailures`/`unreachableSince` and stamp
// `lastShipOkAt` to the moment it answered.
describe("runShipTickWithObservation — SHOULD-FIX 5: a resolved-but-degraded response resets reachability like a clean success (board issue #183 review round 2)", () => {
  function successStdout(token: string): { code: number; stdout: string; stderr: string } {
    return {
      code: 0,
      stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", token].join("\n"),
      stderr: "",
    };
  }

  function neverResolvingExec(): ShipDeps["exec"] {
    return vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>(() => {}));
  }

  function nonzeroExitExec(): ShipDeps["exec"] {
    return vi.fn(async () => ({ code: 1, stdout: "", stderr: "container-side error" }));
  }

  const SHORT_DEADLINE_MS = 50;

  it("alternating real failures and degraded-but-answered responses never crosses the unreachable threshold, because each degraded response resets the anchor", async () => {
    const T0 = new Date("2026-09-24T10:00:00.000Z");
    const storage = fakeStorage();

    // Tick 0 — a genuine success at T0. Sets lastShipOkAt.
    const okDeps: ShipDeps = { exec: vi.fn(async () => successStdout(TOK_1)), r2Put: vi.fn(async () => {}), now: () => T0 };
    await runShipTickWithObservation(okDeps, storage, "websites--pilot");
    let observed = await getObserved(storage);
    expect(observed.lastShipOkAt).toBe(T0.toISOString());

    // Tick 1 — a genuine timeout at T0+30s: execFailures 0->1.
    const t1 = new Date(T0.getTime() + 30_000);
    const hangDeps1: ShipDeps = { exec: neverResolvingExec(), r2Put: vi.fn(async () => {}), now: () => t1 };
    await expect(
      runShipTickWithObservation(hangDeps1, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    observed = await getObserved(storage);
    expect(observed.execFailures).toBe(1);
    expect(isUnreachable(observed, t1)).toBe(false);

    // Tick 2 — another genuine timeout at T0+60s: execFailures 1->2. Elapsed
    // since lastShipOkAt (still T0) is 60s — under 90s, not unreachable yet.
    const t2 = new Date(T0.getTime() + 60_000);
    const hangDeps2: ShipDeps = { exec: neverResolvingExec(), r2Put: vi.fn(async () => {}), now: () => t2 };
    await expect(
      runShipTickWithObservation(hangDeps2, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    observed = await getObserved(storage);
    expect(observed.execFailures).toBe(2);
    expect(isUnreachable(observed, t2)).toBe(false);

    // Tick 3 — a RESOLVED-BUT-DEGRADED response at T0+70s (exec answered,
    // nonzero exit). THE FIX: resets execFailures/unreachableSince and stamps
    // lastShipOkAt to THIS instant, exactly as a clean success would.
    const t3 = new Date(T0.getTime() + 70_000);
    const badDeps: ShipDeps = { exec: nonzeroExitExec(), r2Put: vi.fn(async () => {}), now: () => t3 };
    await expect(
      runShipTickWithObservation(badDeps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.not.toThrow(ExecUnreachableError);
    observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
    expect(observed.lastShipOkAt).toBe(t3.toISOString());
    expect(isUnreachable(observed, t3)).toBe(false);

    // Without this fix, lastShipOkAt would STILL read T0 here — by t5 below
    // (T0+150s), elapsed since that STALE anchor would already exceed 90s,
    // misreporting unreachable despite the exec plane having just proven
    // itself alive at t3.

    // Tick 4 — a genuine failure at T0+80s (10s after the degraded tick): a
    // FRESH streak, execFailures 0->1.
    const t4 = new Date(T0.getTime() + 80_000);
    const hangDeps4: ShipDeps = { exec: neverResolvingExec(), r2Put: vi.fn(async () => {}), now: () => t4 };
    await expect(
      runShipTickWithObservation(hangDeps4, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    observed = await getObserved(storage);
    expect(observed.execFailures).toBe(1);
    expect(isUnreachable(observed, t4)).toBe(false);

    // Tick 5 — another genuine failure at T0+150s: execFailures 1->2. Elapsed
    // since the RESET anchor (t3 = T0+70s) is 80s — still under 90s, so
    // isUnreachable correctly stays false, even though 150s have elapsed
    // since the ORIGINAL T0 success (which, unfixed, would already have read
    // unreachable, since 150s > 90s).
    const t5 = new Date(T0.getTime() + 150_000);
    const hangDeps5: ShipDeps = { exec: neverResolvingExec(), r2Put: vi.fn(async () => {}), now: () => t5 };
    await expect(
      runShipTickWithObservation(hangDeps5, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    observed = await getObserved(storage);
    expect(observed.execFailures).toBe(2);
    expect(isUnreachable(observed, t5)).toBe(false); // 80s since the RESET anchor, not 150s since the stale one
  });

  it("a degraded response after a genuinely unreachable streak clears unreachableSince and fires the immediate D1 write, same as a clean recovery does", async () => {
    const T0 = new Date("2026-09-24T10:00:00.000Z");
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      observed: { ...emptyObserved(), execFailures: 2, unreachableSince: T0.toISOString(), lastShipOkAt: T0.toISOString() },
    });
    const recoveredAt = new Date(T0.getTime() + 130_000);
    expect(isUnreachable(await getObserved(storage), recoveredAt)).toBe(true); // sanity: genuinely unreachable going in

    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    const badDeps: ShipDeps = { exec: nonzeroExitExec(), r2Put: vi.fn(async () => {}), now: () => recoveredAt };
    await expect(
      runShipTickWithObservation(badDeps, storage, "websites--pilot", recordStudioFn, SHORT_DEADLINE_MS),
    ).rejects.not.toThrow(ExecUnreachableError);

    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
    expect(observed.lastShipOkAt).toBe(recoveredAt.toISOString());
    // 2, not 1: the "clears unreachable" transition this test targets fires
    // once, and issue #221 fix round 2, Fix 5 independently fires a SECOND
    // time — a resolved-but-bad response is still a probe failure for
    // activity purposes (`{kind: "unknown", reason: "probe failed"}`), and no
    // `activity` was seeded on this row, so `null -> unknown` is itself a
    // fresh state change with its own immediate D1 write.
    expect(recordStudioFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3a, Task 4) — activity wired into the ship tick and storage.
// Own DO key (ACTIVITY_KEY), written every successful tick independent of
// the incarnation/reachability branches above; the D1 mirror (recordStudioFn)
// fires immediately only on a STATE change, never merely because a tick ran.
// ---------------------------------------------------------------------------
describe("runShipTickWithObservation — activity (issue #221)", () => {
  function deps(stdout: string, now = "2026-09-25T12:00:00.000Z") {
    return {
      exec: vi.fn(async () => ({ code: 0, stdout, stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date(now),
    };
  }

  it("writes ACTIVITY_KEY every successful tick that carries a pane verdict", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    await runShipTickWithObservation(deps(stdoutWithPane(IDLE_PANE)), storage, "websites--pilot", undefined, 5000);
    const activity = storage.map.get(ACTIVITY_KEY) as Activity | undefined;
    expect(activity?.state).toBe("idle");
    expect(activity?.source).toBe("pane");
  });

  it("an old-image tick with no SECTION_PANE at all stores nothing for activity", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    await runShipTickWithObservation(deps(stdoutWithPane(null)), storage, "websites--pilot", undefined, 5000);
    expect(storage.map.has(ACTIVITY_KEY)).toBe(false);
  });

  it("the D1 mirror is NOT called merely because a steady-state activity tick ran (no state change)", async () => {
    const prior: Activity = {
      state: "idle", since: "2026-09-25T11:59:00.000Z", anchored: true,
      observedAt: "2026-09-25T11:59:30.000Z", source: "pane", reason: null, membersTickingAt: null,
    };
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      observed: { ...emptyObserved(), incarnation: TOK_1 }, // already adopted — isolates the activity-only path
      activity: prior,
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    await runShipTickWithObservation(deps(stdoutWithPane(IDLE_PANE)), storage, "websites--pilot", recordStudioFn, 5000);
    expect(recordStudioFn).not.toHaveBeenCalled();
    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("idle");
    expect(activity.since).toBe(prior.since); // held across the same-state observation
  });

  it("the D1 mirror IS called immediately when activity's state changes", async () => {
    const prior: Activity = {
      state: "working", since: "2026-09-25T11:59:00.000Z", anchored: true,
      observedAt: "2026-09-25T11:59:30.000Z", source: "pane", reason: null, membersTickingAt: null,
    };
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      observed: { ...emptyObserved(), incarnation: TOK_1 }, // already adopted — isolates the activity-only path
      activity: prior,
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    await runShipTickWithObservation(deps(stdoutWithPane(IDLE_PANE)), storage, "websites--pilot", recordStudioFn, 5000);
    expect(recordStudioFn).toHaveBeenCalledTimes(1);
    const written = recordStudioFn.mock.calls[0][0] as StudioStatus;
    expect(written.observed?.activity?.state).toBe("idle");
  });

  it("a stopped studio stores nothing for activity, even with a valid pane section", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "stopped" }) });
    await runShipTickWithObservation(deps(stdoutWithPane(WORKING_PANE)), storage, "websites--pilot", undefined, 5000);
    expect(storage.map.has(ACTIVITY_KEY)).toBe(false);
  });

  it("a studio with a fresh operation lock held stores nothing for activity (#86/#87 carve-out)", async () => {
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      operation: { op: "recycle", since: "2026-09-25T11:59:50.000Z" },
    });
    await runShipTickWithObservation(deps(stdoutWithPane(WORKING_PANE)), storage, "websites--pilot", undefined, 5000);
    expect(storage.map.has(ACTIVITY_KEY)).toBe(false);
  });

  it("an empty pane section (tmux gone) never throws and yields unknown, never crashing the tick", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    await expect(
      runShipTickWithObservation(deps(stdoutWithPane("")), storage, "websites--pilot", undefined, 5000),
    ).resolves.toBeDefined();
    const activity = storage.map.get(ACTIVITY_KEY) as Activity | undefined;
    expect(activity).toMatchObject({ state: "unknown", reason: "pane empty" });
  });

  it("a fresh membersTickingAt (300s panel-diff evidence) reaches waiting-members even over an idle frame", async () => {
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      membersTickingAt: "2026-09-25T12:00:00.000Z",
    });
    await runShipTickWithObservation(deps(stdoutWithPane(IDLE_PANE)), storage, "websites--pilot", undefined, 5000);
    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("waiting-members");
  });

  it("row.rateLimited outranks the frame verdict", async () => {
    const storage = fakeStorage({
      status: status({
        id: "websites--pilot", state: "running",
        rateLimited: { until: "2026-09-25T13:30:00.000Z", seenAt: "2026-09-25T12:00:00.000Z" },
      }),
    });
    await runShipTickWithObservation(deps(stdoutWithPane(WORKING_PANE)), storage, "websites--pilot", undefined, 5000);
    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.state).toBe("limit");
  });
});

// ---------------------------------------------------------------------------
// Issue #311 — member alerts wired into the ship tick and storage. Own DO
// keys (MEMBER_ALERTS_KEY/MEMBER_ROWS_KEY), overwritten wholesale every
// successful tick that carries a pane frame, same gating (live state, no
// fresh op lock) applyActivityVerdict already uses.
// ---------------------------------------------------------------------------
describe("runShipTickWithObservation — member alerts (issue #311)", () => {
  function deps(stdout: string, now = "2026-09-25T12:00:00.000Z") {
    return {
      exec: vi.fn(async () => ({ code: 0, stdout, stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date(now),
    };
  }

  const KILL_LINE =
    "2026-09-25T11:59:30.000Z SIGKILL pid=42 comm=vitest rss_mib=612 avail_mib=88 total_mib=11930 source=cgroup cmd=vitest run";

  it("MUTANT PROOF (a): a real memguard kill in the SAME tick's stdout always surfaces as a memguard-kill alert", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    const stdout = stdoutWithPaneAndMemguard(IDLE_PANE, [KILL_LINE]);
    await runShipTickWithObservation(deps(stdout), storage, "websites--pilot", undefined, 5000);
    const alerts = storage.map.get(MEMBER_ALERTS_KEY) as MemberAlert[];
    expect(alerts).toContainEqual(expect.objectContaining({ kind: "memguard-kill", confidence: "measured" }));
  });

  it("a poll-loop row in the pane frame surfaces as a measured poll-loop alert", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    const pane = withMemberRow("frontend-developer  Track A e2e harness tasks 1… 1h 10m 0s · ↑ 506.3k tokens");
    await runShipTickWithObservation(deps(stdoutWithPaneAndMemguard(pane, [])), storage, "websites--pilot", undefined, 5000);
    const alerts = storage.map.get(MEMBER_ALERTS_KEY) as MemberAlert[];
    expect(alerts).toContainEqual(expect.objectContaining({ kind: "poll-loop", confidence: "measured" }));
  });

  it("MUTANT PROOF (b): a row present last tick and gone this tick, with NO nearby kill, produces no member-gone alert", async () => {
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      memberRows: ["frontend-developer"],
    });
    await runShipTickWithObservation(deps(stdoutWithPaneAndMemguard(IDLE_PANE, [])), storage, "websites--pilot", undefined, 5000);
    const alerts = storage.map.get(MEMBER_ALERTS_KEY) as MemberAlert[];
    expect(alerts.some((a) => a.kind === "member-gone")).toBe(false);
  });

  it("MUTANT PROOF (b), other direction: a row gone WITH a corroborating kill in the same tick DOES produce an inferred member-gone alert", async () => {
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      memberRows: ["frontend-developer"],
    });
    const stdout = stdoutWithPaneAndMemguard(IDLE_PANE, [KILL_LINE]); // 30s before deps' NOW
    await runShipTickWithObservation(deps(stdout), storage, "websites--pilot", undefined, 5000);
    const alerts = storage.map.get(MEMBER_ALERTS_KEY) as MemberAlert[];
    expect(alerts).toContainEqual(expect.objectContaining({ kind: "member-gone", confidence: "inferred" }));
  });

  it("persists this tick's row names for the NEXT tick's gone-row diff", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    const pane = withMemberRow("frontend-developer  doing work 1m 0s · ↑ 100 tokens");
    await runShipTickWithObservation(deps(stdoutWithPaneAndMemguard(pane, [])), storage, "websites--pilot", undefined, 5000);
    expect(storage.map.get(MEMBER_ROWS_KEY)).toEqual(["frontend-developer"]);
  });

  it("an old-image tick with no SECTION_PANE at all stores nothing for member alerts", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    await runShipTickWithObservation(deps(stdoutWithPane(null)), storage, "websites--pilot", undefined, 5000);
    expect(storage.map.has(MEMBER_ALERTS_KEY)).toBe(false);
  });

  it("a stopped studio stores nothing for member alerts, even with a valid pane section", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "stopped" }) });
    const stdout = stdoutWithPaneAndMemguard(IDLE_PANE, [KILL_LINE]);
    await runShipTickWithObservation(deps(stdout), storage, "websites--pilot", undefined, 5000);
    expect(storage.map.has(MEMBER_ALERTS_KEY)).toBe(false);
  });

  it("a studio with a fresh operation lock held stores nothing for member alerts (#86/#87 carve-out)", async () => {
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      operation: { op: "recycle", since: "2026-09-25T11:59:50.000Z" },
    });
    const stdout = stdoutWithPaneAndMemguard(IDLE_PANE, [KILL_LINE]);
    await runShipTickWithObservation(deps(stdout), storage, "websites--pilot", undefined, 5000);
    expect(storage.map.has(MEMBER_ALERTS_KEY)).toBe(false);
  });

  it("the D1 mirror IS called immediately when the alert set changes", async () => {
    // Isolates the member-alerts-only path: a matching prior `activity` and
    // an already-adopted `observed.incarnation` suppress THOSE two D1
    // triggers, the same isolation the "no state change"/"IS called" pair
    // of activity tests above already use for their own axis.
    const priorActivity: Activity = {
      state: "idle", since: "2026-09-25T11:59:00.000Z", anchored: true,
      observedAt: "2026-09-25T11:59:30.000Z", source: "pane", reason: null, membersTickingAt: null,
    };
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      activity: priorActivity,
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    const stdout = stdoutWithPaneAndMemguard(IDLE_PANE, [KILL_LINE]);
    await runShipTickWithObservation(deps(stdout), storage, "websites--pilot", recordStudioFn, 5000);
    expect(recordStudioFn).toHaveBeenCalledTimes(1);
    const written = recordStudioFn.mock.calls[0][0] as StudioStatus;
    expect(written.observed?.memberAlerts).toContainEqual(expect.objectContaining({ kind: "memguard-kill" }));
  });

  it("the D1 mirror is NOT called merely because a steady-state tick ran with no alerts at all", async () => {
    // Seeds a matching prior `activity` too, so this isolates the
    // member-alerts-only path from activity's OWN state-change trigger
    // (applyActivityVerdict), the same isolation the analogous activity
    // "no state change" test above achieves.
    const priorActivity: Activity = {
      state: "idle", since: "2026-09-25T11:59:00.000Z", anchored: true,
      observedAt: "2026-09-25T11:59:30.000Z", source: "pane", reason: null, membersTickingAt: null,
    };
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      activity: priorActivity,
      memberAlerts: [],
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    await runShipTickWithObservation(deps(stdoutWithPaneAndMemguard(IDLE_PANE, [])), storage, "websites--pilot", recordStudioFn, 5000);
    expect(recordStudioFn).not.toHaveBeenCalled();
  });

  it("PR #336 round 2, item 1 (BLOCKER fix): a STEADY poll-loop alert across ticks does NOT call the D1 mirror again — only its first appearance did", async () => {
    // Same isolation the two tests above already use: a prior `activity` that
    // will not itself transition state across either tick, so this stays on
    // the member-alerts axis alone.
    const priorActivity: Activity = {
      state: "idle", since: "2026-09-25T11:00:00.000Z", anchored: true,
      observedAt: "2026-09-25T11:59:30.000Z", source: "pane", reason: null, membersTickingAt: null,
    };
    const pane = withMemberRow("frontend-developer  doing work 1h 10m 0s · ↑ 506.3k tokens");
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      observed: { ...emptyObserved(), incarnation: TOK_1 },
      activity: priorActivity,
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});

    // Tick 1 — the poll-loop alert APPEARS for the first time. This IS the
    // one write that's owed: a set-membership change.
    await runShipTickWithObservation(
      deps(stdoutWithPaneAndMemguard(pane, []), "2026-09-25T12:00:00.000Z"),
      storage, "websites--pilot", recordStudioFn, 5000,
    );
    expect(recordStudioFn).toHaveBeenCalledTimes(1);

    // Tick 2, 30s later — the SAME member, still over threshold, elapsed
    // time and token text both naturally higher (claude's own printed
    // clock keeps advancing). Round 1's whole-JSON `sameAlertSet` compare
    // read this as "changed" (different `at`, different `detail`) and fired
    // AGAIN; round 2's kind+name identity (with `at` now carried forward
    // from tick 1, per member-alerts.ts's own fix) must not.
    const pane2 = withMemberRow("frontend-developer  doing work 1h 10m 30s · ↑ 507.1k tokens");
    await runShipTickWithObservation(
      deps(stdoutWithPaneAndMemguard(pane2, []), "2026-09-25T12:00:30.000Z"),
      storage, "websites--pilot", recordStudioFn, 5000,
    );
    expect(recordStudioFn).toHaveBeenCalledTimes(1); // still 1, not 2 — no repeat write
    const alerts = storage.map.get(MEMBER_ALERTS_KEY) as MemberAlert[];
    const alert = alerts.find((a) => a.kind === "poll-loop");
    expect(alert?.at).toBe("2026-09-25T12:00:00.000Z"); // first-seen time, carried forward, not tick 2's "now"
  });
});

// ---------------------------------------------------------------------------
// Issue #221 fix round 2, Fix 5 — before this fix, `? probe failed` was ONLY
// ever producible by injecting `Activity` by hand (test/cli.fleet.test.ts's
// own formatActivity test) — the REAL exec-failure path rethrew past the
// activity write entirely, so this verdict never actually reached storage in
// production. These tests go through `runShipTickWithObservation` itself,
// the same public entry point every OTHER activity test in this file uses,
// with a genuinely failing `exec` — never constructing an `Activity` object
// directly.
// ---------------------------------------------------------------------------
describe("runShipTickWithObservation — Fix 5: '? probe failed' through the REAL exec-failure path", () => {
  const SHORT_DEADLINE_MS = 50;

  it("a genuinely unreachable exec (never answers) writes ACTIVITY_KEY as unknown/'probe failed', not stale silence", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    const hangDeps: ShipDeps = {
      exec: () => new Promise(() => {}), // never resolves — a real ExecUnreachableError, not an injected verdict
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(hangDeps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    const activity = storage.map.get(ACTIVITY_KEY) as Activity | undefined;
    expect(activity).toMatchObject({ state: "unknown", reason: "probe failed" });
  });

  it("a resolved-but-bad response (nonzero exit) ALSO writes '? probe failed' — the probe never got as far as reading the pane", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    const badDeps: ShipDeps = {
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "container-side error" })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(badDeps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow();
    const activity = storage.map.get(ACTIVITY_KEY) as Activity | undefined;
    expect(activity).toMatchObject({ state: "unknown", reason: "probe failed" });
  });

  it("the original exec failure still propagates — recording activity never swallows the real error", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "running" }) });
    const hangDeps: ShipDeps = {
      exec: () => new Promise(() => {}),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(hangDeps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toBeInstanceOf(ExecUnreachableError);
  });

  it("a stopped studio still stores nothing for activity, even on a real exec failure", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot", state: "stopped" }) });
    const hangDeps: ShipDeps = {
      exec: () => new Promise(() => {}),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(hangDeps, storage, "websites--pilot", undefined, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    expect(storage.map.has(ACTIVITY_KEY)).toBe(false);
  });

  it("a prior 'probe failed' does not re-fire the D1 mirror on a second consecutive probe failure (no state change)", async () => {
    const priorProbeFailed: Activity = {
      state: "unknown", since: "2026-09-25T11:59:00.000Z", anchored: true,
      observedAt: "2026-09-25T11:59:30.000Z", source: "pane", reason: "probe failed", membersTickingAt: null,
    };
    const storage = fakeStorage({
      status: status({ id: "websites--pilot", state: "running" }),
      activity: priorProbeFailed,
    });
    const recordStudioFn = vi.fn(async (_s: StudioStatus) => {});
    const hangDeps: ShipDeps = {
      exec: () => new Promise(() => {}),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    };
    await expect(
      runShipTickWithObservation(hangDeps, storage, "websites--pilot", recordStudioFn, SHORT_DEADLINE_MS),
    ).rejects.toThrow(ExecUnreachableError);
    // The point of this test: `since` held (no spurious "change" from
    // probe-failed to probe-failed) — this file's own recordStudioFn-call
    // tests elsewhere already cover the immediate-D1-write-on-change rule.
    const activity = storage.map.get(ACTIVITY_KEY) as Activity;
    expect(activity.since).toBe(priorProbeFailed.since);
    expect(activity.reason).toBe("probe failed");
  });
});

// Issue #367: archiveDoneRecords (do.ts) used to run from exactly one call
// site, the recycle/destroy teardown -- a container that died any other way
// (eviction, OOM, wedge+hard-stop) lost every unarchived completion record
// for its whole lifetime. This proves the periodic ship tick now ALSO
// archives, closing that window to one tick interval, given a `doneRecords`
// port and a `resolveOpsRepo` the same shape the teardown call site already
// uses.
describe("runShipTickWithObservation — completion-record archive on the periodic tick (issue #367)", () => {
  it("archives a completion record during a normal tick, not only at teardown", async () => {
    const listCmd = doneRecordsListCmd();
    const record = { plan: "docs/p.md", verification: [] };
    const recordB64 = btoa(unescape(encodeURIComponent(JSON.stringify(record))));
    const puts: { repo: string; path: string; content: string; message: string }[] = [];
    const deps: ShipDeps = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === listCmd) return { code: 0, stdout: `42\t${recordB64}`, stderr: "" };
        return { code: 0, stdout: stdoutWithPane(IDLE_PANE), stderr: "" };
      }),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-26T10:00:00.000Z"),
    };
    const storage = fakeStorage();

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000, {
      doneRecords: {
        workRepoSlug: async () => "acme/websites",
        putOpsFile: async (repo, path, content, message) => { puts.push({ repo, path, content, message }); },
        commentOnTask: async () => {},
      },
      resolveOpsRepo: async () => "acme/ops",
    });

    expect(puts).toEqual([{
      repo: "acme/ops", path: "done/acme/websites/42.json", content: JSON.stringify(record),
      message: expect.stringContaining("42"),
    }]);
  });

  // #367 round 2, item 4: round 1 ran the archive exec BEFORE shipTranscriptTick,
  // inside the SAME whole-tick budget the ship-exec itself needs (do.ts's own
  // TICK_DEADLINES_MS.shipTranscript budget-table comment) -- delaying the
  // actual ship-exec work on every tick that had a record to archive. It now
  // runs AFTER shipTranscriptTick succeeds, so the ship-exec always gets
  // first claim on that budget. See runShipTickWithObservation's own doc
  // comment for the full reasoning.
  it("the archive's own exec lands AFTER the ship tick's own exec, never before", async () => {
    const listCmd = doneRecordsListCmd();
    const recordB64 = btoa(unescape(encodeURIComponent(JSON.stringify({ plan: "docs/p.md", verification: [] }))));
    const execOrder: string[] = [];
    const deps: ShipDeps = {
      exec: vi.fn(async (cmd: string) => {
        execOrder.push(cmd);
        if (cmd === listCmd) return { code: 0, stdout: `42\t${recordB64}`, stderr: "" };
        return { code: 0, stdout: stdoutWithPane(IDLE_PANE), stderr: "" };
      }),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-26T10:00:00.000Z"),
    };
    const storage = fakeStorage();

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000, {
      doneRecords: {
        workRepoSlug: async () => "acme/websites",
        putOpsFile: async () => {},
        commentOnTask: async () => {},
      },
      resolveOpsRepo: async () => "acme/ops",
    });

    expect(execOrder).toContain(listCmd);
    expect(execOrder[0]).not.toBe(listCmd); // the ship tick's own exec(s) ran first
    expect(execOrder.indexOf(listCmd)).toBeGreaterThan(0);
  });

  // #367 round 3 (review HOLD fix, item 2): round 2 only proved the archive
  // ran after the SHIP EXEC -- it was still positioned ahead of this tick's
  // OWN bookkeeping (issue #274's degraded-row recovery, the activity write,
  // the member-alert write, and the final lastShipOkAt/reachability merge).
  // This drives a tick that exercises ALL FOUR of those writes (a degraded
  // row that genuinely heals, on a pane carrying a member row) and proves the
  // archive's own exec is the LAST thing that happens -- after every one of
  // them, not merely after the ship exec.
  it("the archive call lands at the true end of the tick, after degraded recovery, activity, member alerts, and the lastShipOkAt/reachability write", async () => {
    const listCmd = doneRecordsListCmd();
    const recordB64 = btoa(unescape(encodeURIComponent(JSON.stringify({ plan: "docs/p.md", verification: [] }))));
    const studioId = "websites--pilot";
    const events: string[] = [];
    const deps: ShipDeps = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === listCmd) {
          events.push("exec:archive-list");
          return { code: 0, stdout: `42\t${recordB64}`, stderr: "" };
        }
        events.push("exec:ship");
        // IDLE_PANE's own footer satisfies `evaluateDegradedRecovery`'s
        // `claudeOnScreen` check with no limit block anywhere -- a degraded
        // row seeded below genuinely heals on this tick (parked && recovered).
        return { code: 0, stdout: stdoutWithPane(IDLE_PANE), stderr: "" };
      }),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-26T10:00:00.000Z"),
    };
    const degraded = status({ state: "degraded", error: exhaustedMessage(studioId, ["CLAUDE_CODE_OAUTH_TOKEN"]) });
    const storage = fakeStorage({ status: degraded });
    const originalPut = storage.put;
    storage.put = (async (keyOrEntries: unknown, value?: unknown) => {
      if (typeof keyOrEntries === "string") events.push(`put:${keyOrEntries}`);
      return originalPut(keyOrEntries as never, value as never);
    }) as typeof storage.put;

    await runShipTickWithObservation(deps, storage, studioId, undefined, 5000, {
      doneRecords: {
        workRepoSlug: async () => "acme/websites",
        putOpsFile: async () => {},
        commentOnTask: async () => {},
      },
      resolveOpsRepo: async () => "acme/ops",
    });

    // Sanity: the degraded row actually healed on this tick -- proves the
    // degraded-recovery branch genuinely ran (and wrote STATUS_KEY), not just
    // that it was skipped.
    expect((storage.map.get(STATUS_KEY) as StudioStatus).state).toBe("running");

    const archiveIdx = events.indexOf("exec:archive-list");
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(archiveIdx).toBeGreaterThan(events.indexOf(`put:${STATUS_KEY}`)); // degraded recovery's own write
    expect(archiveIdx).toBeGreaterThan(events.indexOf(`put:${MEMBER_ALERTS_KEY}`)); // member alerts
    // The final lastShipOkAt/reachability merge (mergeObserved) is the LAST
    // bookkeeping write in the whole function -- the archive must follow it.
    expect(archiveIdx).toBeGreaterThan(events.lastIndexOf(`put:${OBSERVED_KEY}`));
  });

  // #367 round 3 (review HOLD fix, item 2): `archiveDoneRecords`'s two GitHub
  // API legs (`putOpsFile`/`commentOnTask`) carry NO timeout of their own --
  // only its in-container list exec does (via `shipDeps.exec`). Without the
  // archive call's own ARCHIVE_DEADLINE_MS wrapper, a hung GitHub response
  // would hang the archive (and, via the tick's own `runScheduledTick` race,
  // eventually the WHOLE 45s tick) forever. This pins that the archive call
  // is bounded by its OWN, much smaller deadline: a `putOpsFile` that never
  // resolves still lets the whole tick settle at ARCHIVE_DEADLINE_MS, logged
  // and swallowed exactly like any other archive failure, never riding the
  // tick out to the full TICK_DEADLINES_MS.shipTranscript (45s) budget.
  it("a hung GitHub call (putOpsFile) is bounded by the archive's own ARCHIVE_DEADLINE_MS, not the whole 45s tick deadline", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const listCmd = doneRecordsListCmd();
      const recordB64 = btoa(unescape(encodeURIComponent(JSON.stringify({ plan: "docs/p.md", verification: [] }))));
      const T0 = new Date("2026-09-26T10:00:00.000Z");
      const deps: ShipDeps = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd === listCmd) return { code: 0, stdout: `42\t${recordB64}`, stderr: "" };
          return { code: 0, stdout: stdoutWithPane(IDLE_PANE), stderr: "" };
        }),
        r2Put: vi.fn(async () => {}),
        now: () => T0,
      };
      const storage = fakeStorage();

      const p = runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000, {
        doneRecords: {
          workRepoSlug: async () => "acme/websites",
          // Never resolves -- exactly the "no timeout of its own" gap this
          // round's fix closes.
          putOpsFile: vi.fn(() => new Promise<void>(() => {})),
          commentOnTask: async () => {},
        },
        resolveOpsRepo: async () => "acme/ops",
      });
      let settled = false;
      p.then(() => { settled = true; }, () => { settled = true; });

      // One tick before ARCHIVE_DEADLINE_MS: still hanging.
      await vi.advanceTimersByTimeAsync(ARCHIVE_DEADLINE_MS - 1);
      expect(settled).toBe(false);

      // The final ms: the archive's own deadline fires, is caught and
      // logged, and the WHOLE tick resolves -- nowhere near the 45s whole-
      // tick budget (TICK_DEADLINES_MS.shipTranscript).
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(p).resolves.toBeDefined();
      const loggedErrors = errors.mock.calls.flat().join(" ");
      expect(loggedErrors).toContain("completion-record archive");
      expect(loggedErrors).toContain(`${ARCHIVE_DEADLINE_MS / 1000}s`);
    } finally {
      vi.useRealTimers();
      errors.mockRestore();
    }
  });

  it("no `archive` config passed: behaves exactly as before, no completion-record exec at all", async () => {
    const execCalls: string[] = [];
    const deps: ShipDeps = {
      exec: vi.fn(async (cmd: string) => {
        execCalls.push(cmd);
        return { code: 0, stdout: stdoutWithPane(IDLE_PANE), stderr: "" };
      }),
      r2Put: vi.fn(async () => {}),
      now: () => new Date("2026-09-26T10:00:00.000Z"),
    };
    const storage = fakeStorage();

    await runShipTickWithObservation(deps, storage, "websites--pilot", undefined, 5000);

    expect(execCalls.some((c) => c === doneRecordsListCmd())).toBe(false);
  });
});

// Issue #86 item 4: the lead's first observed working turn moves its
// submitted task to working (the DO wires `onLeadWorking` to the board).
describe("runShipTickWithObservation — onLeadWorking (issue #86)", () => {
  const NOW = new Date("2026-09-30T12:00:00.000Z");
  const deps = (pane: string): ShipDeps => ({
    exec: vi.fn(async () => ({ code: 0, stdout: stdoutWithPane(pane), stderr: "" })),
    r2Put: vi.fn(async () => {}),
    now: () => NOW,
  });
  const idleBefore: Activity = {
    state: "idle", since: "2026-09-30T11:50:00.000Z", anchored: true, observedAt: "2026-09-30T11:59:30.000Z",
    source: "pane", reason: null, membersTickingAt: null,
  };
  const run = (pane: string, storage: ReturnType<typeof fakeStorage>, cb: () => Promise<void>) =>
    runShipTickWithObservation(deps(pane), storage, "websites--pilot", undefined, 5000, undefined, cb);

  it("idle -> working: called once, the attempt stamped", async () => {
    const storage = fakeStorage({ status: status(), activity: idleBefore });
    const cb = vi.fn(async () => {});
    await run(WORKING_PANE, storage, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(storage.map.get(AUTO_WORKING_KEY)).toBe(NOW.toISOString());
  });

  it("working -> working: not called", async () => {
    const storage = fakeStorage({ status: status(), activity: { ...idleBefore, state: "working" } });
    const cb = vi.fn(async () => {});
    await run(WORKING_PANE, storage, cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("idle -> idle: not called", async () => {
    const storage = fakeStorage({ status: status(), activity: idleBefore });
    const cb = vi.fn(async () => {});
    await run(IDLE_PANE, storage, cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("at most once per AUTO_WORKING_EVERY_MS: a recent attempt skips, an old one does not", async () => {
    const recent = fakeStorage({ status: status(), activity: idleBefore });
    recent.map.set(AUTO_WORKING_KEY, new Date(NOW.getTime() - AUTO_WORKING_EVERY_MS + 1000).toISOString());
    const cb1 = vi.fn(async () => {});
    await run(WORKING_PANE, recent, cb1);
    expect(cb1).not.toHaveBeenCalled();
    const old = fakeStorage({ status: status(), activity: idleBefore });
    old.map.set(AUTO_WORKING_KEY, new Date(NOW.getTime() - AUTO_WORKING_EVERY_MS).toISOString());
    const cb2 = vi.fn(async () => {});
    await run(WORKING_PANE, old, cb2);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("a throwing callback never fails the tick; activity is still stored", async () => {
    const storage = fakeStorage({ status: status(), activity: idleBefore });
    await expect(run(WORKING_PANE, storage, async () => { throw new Error("GitHub 502"); })).resolves.toBeDefined();
    expect((storage.map.get(ACTIVITY_KEY) as Activity).state).toBe("working");
  });
});

// Issue #108 (#70 ask 4 remainder) — Observed.lastMessageLine, extracted from
// the SAME paneFrame the ship tick already captures every 30s, redacted at
// this write boundary, and left alone (never reset to null) when the tick's
// own paneFrame is absent (old image, or a exec that never reached the pane
// section) — same "absent means don't touch it" discipline paneVerdict/
// hookHeartbeat already follow in this file.
describe("runShipTickWithObservation — lastMessageLine (issue #108)", () => {
  function deps(stdout: string, now = "2026-09-25T12:00:00.000Z") {
    return {
      exec: vi.fn(async () => ({ code: 0, stdout, stderr: "" })),
      r2Put: vi.fn(async () => {}),
      now: () => new Date(now),
    };
  }

  function paneWithMessage(msg: string): string {
    return ["⏺ Done.", msg, "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
  }

  it("a tick whose paneFrame carries a real content line stores it as lastMessageLine", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot" }) });
    const msg = "Fixed the auth bug, tests are green now.";
    await runShipTickWithObservation(deps(stdoutWithPane(paneWithMessage(msg))), storage, "websites--pilot", undefined, 5000);
    const observed = await getObserved(storage);
    expect(observed.lastMessageLine).toBe(msg);
  });

  it("a secret-shaped token in the last content line is redacted before it is stored, never the raw secret", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot" }) });
    const msg = "Pushed with token ghs_abcdEFGH1234 to remote.";
    await runShipTickWithObservation(deps(stdoutWithPane(paneWithMessage(msg))), storage, "websites--pilot", undefined, 5000);
    const observed = await getObserved(storage);
    expect(observed.lastMessageLine).toBe(redactSecrets(msg));
    expect(observed.lastMessageLine).not.toContain("ghs_");
    expect(observed.lastMessageLine).toContain("«redacted»");
  });

  // Finding 1 (post-ship code review) — redact FIRST, truncate SECOND. Mirrors
  // grid.ts's own scrubPreview, which redacts the full tail before slicing
  // specifically so a secret straddling the slice boundary is still caught
  // whole (see that function's own doc comment). Truncating first, as the
  // original code did, is only accidentally safe today because every
  // redact.ts pattern is an open-ended quantifier (`[A-Za-z0-9_-]+` etc) — a
  // future FIXED-length secret shape could leak a partial token through this
  // exact field. This fixture positions a secret-shaped token so the naive
  // "truncate then redact" order slices INSIDE the token, well before its
  // real end, permanently dropping the real trailing prose (" end") and
  // stamping a misleading "…" where no genuine truncation was needed — the
  // fixed order redacts the full untruncated line first (collapsing the
  // 207-char token down to the short "«redacted»" marker), so the whole
  // line easily fits under LAST_LINE_MAX_CHARS and no truncation happens at
  // all.
  it("a secret-shaped token straddling the truncation boundary is redacted on the FULL line before truncation, not after (regression, issue #108 finding 1)", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot" }) });
    const secret = `sk-ant-${"a".repeat(200)}`;
    const msg = `token ${secret} end`;
    await runShipTickWithObservation(deps(stdoutWithPane(paneWithMessage(msg))), storage, "websites--pilot", undefined, 5000);
    const observed = await getObserved(storage);
    expect(observed.lastMessageLine).toBe("token «redacted» end");
    expect(observed.lastMessageLine).not.toMatch(/a{3,}/);
    expect(observed.lastMessageLine).not.toMatch(/…$/);
  });

  // Finding 1/2 (post-ship code review) — truncation moved OUT of
  // extractLastVisibleLine (activity.ts) and into this call site, applied
  // AFTER redactSecrets; this is the truncation coverage that used to live
  // on extractLastVisibleLine's own unit test, re-homed here since it is now
  // do.ts's own behaviour, not activity.ts's.
  it("a content line longer than LAST_LINE_MAX_CHARS (no secret involved) is truncated with a trailing ellipsis", async () => {
    const storage = fakeStorage({ status: status({ id: "websites--pilot" }) });
    const long = "x".repeat(250);
    await runShipTickWithObservation(deps(stdoutWithPane(paneWithMessage(long))), storage, "websites--pilot", undefined, 5000);
    const observed = await getObserved(storage);
    expect(observed.lastMessageLine).toBe(`${"x".repeat(LAST_LINE_MAX_CHARS)}…`);
    expect(observed.lastMessageLine?.length).toBe(LAST_LINE_MAX_CHARS + 1);
  });

  it("a tick with no paneFrame at all (old-image or absent section) leaves lastMessageLine untouched", async () => {
    const storage = fakeStorage({
      status: status({ id: "websites--pilot" }),
      observed: { ...emptyObserved(), lastMessageLine: "previous message" },
    });
    await runShipTickWithObservation(deps(stdoutWithPane(null)), storage, "websites--pilot", undefined, 5000);
    const observed = await getObserved(storage);
    expect(observed.lastMessageLine).toBe("previous message");
  });
});
