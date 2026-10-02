import { describe, it, expect, vi } from "vitest";
import {
  decideHeal, healBareContainer, syncSessionCycle, BARE_SELF_HEALED,
  healDiedInRollout, ROLLOUT_EXIT_MARKER, checkAndRecordReadiness,
} from "../src/studio/do";
import {
  STATUS_KEY, ROLE_ENV_KEY, HEAL_ATTEMPT_KEY, OPERATION_KEY, OPERATION_STALE_MS,
  PROVISIONED_OK,
  type StudioStorage, type RoleEnv, type StudioEnv, type HealAttempt,
  type OperationInFlight,
} from "../src/studio/provision";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import type { StudioStatus, StudioReadiness, StudioState } from "../src/studio/types";

// ---------------------------------------------------------------------------
// Issue #71 — a bare container heals itself, once.
//
// An image rollout replaces every running container. Some come back BARE:
// /workspace empty, pane at a bare bash. #38 (PR #65) shipped the heal -- a
// second bring-up plus on-disk verification -- INSIDE runRestart, and nothing
// ever called runRestart on a replaced container. So the readiness tick took
// a `bare` verdict every 300s, wrote it to the row, and did nothing with it.
//
// MEASURED 2026-09-24: `fleetflare--web-studio`, `acme-os--maestro`,
// `acme-os--scratch`, every `websites--*` and every `sample--*` studio
// bare at the same moment, each one healed by a human running `fleet
// provision`, one container at a time, through a day.
//
// A live StudioDO cannot be constructed under vitest-pool-workers (see
// src/studio/do.ts's header), so this targets the exported decision and the
// storage-level orchestrator the DO's tick is a thin forward to.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-24T09:00:00.000Z");
const STUDIO_ID = "fleetflare--web-studio";

function status(over: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID,
    state: "running",
    tailscaleHost: null,
    lastRefresh: null,
    error: null,
    ...over,
  } as StudioStatus;
}

const bare = (reason = "no git checkout at /workspace/fleetflare"): StudioReadiness =>
  ({ kind: "bare", reason, checkedAt: NOW.toISOString() });
const provisioned = (): StudioReadiness => ({ kind: "provisioned", checkedAt: NOW.toISOString() });
const inconclusive = (): StudioReadiness =>
  ({ kind: "inconclusive", reason: "check produced no verdict (exit 1)", checkedAt: NOW.toISOString() });

const armed = (over: Partial<HealAttempt> = {}): HealAttempt =>
  ({ armed: true, attemptedAt: "2026-09-24T08:00:00.000Z", reason: "bare", ...over });

describe("decideHeal — the four constraints, each one a measured incident", () => {
  it("a running studio whose container came back bare heals", () => {
    expect(decideHeal(status(), bare(), undefined)).toEqual({
      kind: "heal", reason: "no git checkout at /workspace/fleetflare",
    });
  });

  // Constraint 2, and the most expensive one to get wrong: sbExec STARTS a
  // stopped container and billing begins. A heal that touched stopped studios
  // would spend money where the operator cannot see it.
  it.each<StudioState>(["stopped", "provisioning"])(
    "a studio in state %s is never healed, however bare it is",
    (state) => {
      const d = decideHeal(status({ state }), bare(), undefined);
      expect(d.kind).toBe("stand-down");
      expect(d.kind === "stand-down" && d.why).toContain(state);
    },
  );

  // `degraded` is exactly what a bare studio looks like after a heal that did
  // not take -- runRestart catches a killed bring-up and persists degraded
  // rather than throwing. Refusing it protected nothing and disabled the
  // feature outright: a studio that failed one heal could never heal again,
  // for any reason. The marker below is what bounds the retries.
  it("a DEGRADED studio is healable — that is the state a failed heal leaves behind", () => {
    expect(decideHeal(status({ state: "degraded" }), bare(), undefined).kind).toBe("heal");
  });

  // Constraint 1: inconclusive is a statement about the CHECK, never about
  // the studio. Restarting on it turns a network hiccup into a restart.
  it("an inconclusive verdict never heals — it is a statement about the check", () => {
    expect(decideHeal(status(), inconclusive(), undefined).kind).toBe("stand-down");
  });

  // Constraint 3: the loop guard. A studio bare for a real reason would
  // otherwise restart itself every 300s forever.
  it("a second consecutive bare tick stands down, naming when it already healed", () => {
    const d = decideHeal(status(), bare(), armed());
    expect(d.kind).toBe("stand-down");
    expect(d.kind === "stand-down" && d.why).toContain("2026-09-24T08:00:00.000Z");
  });

  // Constraint 4: a marker that armed once and stayed armed would protect the
  // container that is already broken and abandon every future one.
  it("a provisioned verdict disarms, so a LATER bare episode may heal again", () => {
    expect(decideHeal(status(), provisioned(), armed())).toEqual({ kind: "disarm" });
  });

  it("a provisioned verdict with nothing armed is simply nothing to do", () => {
    expect(decideHeal(status(), provisioned(), undefined).kind).toBe("stand-down");
  });

  it("a disarmed marker does not block the next episode", () => {
    expect(decideHeal(status(), bare(), armed({ armed: false })).kind).toBe("heal");
  });
});

/** Storage with just the two keys this path reads and writes. */
function fakeStorage(seed: { status?: StudioStatus; marker?: HealAttempt; inFlight?: OperationInFlight } = {}) {
  const map = new Map<string, StudioStatus | RoleEnv | StudioEnv | boolean | HealAttempt | OperationInFlight | null>();
  if (seed.status) map.set(STATUS_KEY, seed.status);
  if (seed.marker) map.set(HEAL_ATTEMPT_KEY, seed.marker);
  if (seed.inFlight) map.set(OPERATION_KEY, seed.inFlight);
  return {
    map,
    // Returns EXACTLY what was put. Issue #103: this used to read
    // `map.get(key) ?? undefined`, which turned a stored null into undefined
    // -- the one conversion real DO storage never makes. Every provision and
    // restart clears its lock with put(OPERATION_KEY, null), so the fake hid
    // the only lock shape a live studio ever holds between operations.
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: async (
      key: string,
      value: StudioStatus | RoleEnv | StudioEnv | boolean | HealAttempt | OperationInFlight | null,
    ) => {
      map.set(key, value);
    },
  };
}

describe("healBareContainer — once per episode, and armed BEFORE it runs", () => {
  it("restarts the studio and arms the marker", async () => {
    const s = fakeStorage();
    const heal = vi.fn(async () => {});

    const d = await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW, heal, async () => {});

    expect(d.kind).toBe("heal");
    expect(heal).toHaveBeenCalledTimes(1);
    expect(s.map.get(HEAL_ATTEMPT_KEY)).toEqual({
      armed: true,
      attemptedAt: NOW.toISOString(),
      reason: "no git checkout at /workspace/fleetflare",
    });
  });

  // Arming AFTER the restart would let a restart that dies mid-flight retry
  // on every tick forever — the exact loop the marker exists to prevent.
  it("a heal that throws still counts as this episode's one attempt", async () => {
    const s = fakeStorage();
    const heal = vi.fn(async () => { throw new Error("container unreachable"); });

    await expect(
      healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW, heal, async () => {}),
    ).rejects.toThrow("container unreachable");

    expect((s.map.get(HEAL_ATTEMPT_KEY) as HealAttempt).armed).toBe(true);
  });

  // Issue #38 part 3's rule, one level up: a studio that heals cleanly would
  // otherwise read `running, error: null` and the whole episode would be
  // invisible in the one place an operator looks.
  it("a studio that healed cleanly still SAYS it came back bare", async () => {
    const s = fakeStorage({ status: status() });

    await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW,
      // The restart writes a healthy row, exactly as a successful one does.
      async () => { s.map.set(STATUS_KEY, status({ error: null })); },
      async () => {});

    const row = s.map.get(STATUS_KEY) as StudioStatus;
    expect(row.error).toContain(BARE_SELF_HEALED);
    expect(row.error).toContain("no git checkout at /workspace/fleetflare");
  });

  // An error the restart itself recorded is about what is broken NOW and
  // outranks a note about how we got here.
  it("never overwrites an error the restart itself recorded", async () => {
    const s = fakeStorage({ status: status() });

    await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW,
      async () => { s.map.set(STATUS_KEY, status({ error: "bring-up failed on BOTH attempts" })); },
      async () => {});

    expect((s.map.get(STATUS_KEY) as StudioStatus).error).toBe("bring-up failed on BOTH attempts");
  });

  it("the second bare tick calls nothing", async () => {
    const s = fakeStorage({ marker: armed() });
    const heal = vi.fn(async () => {});

    const d = await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW, heal, async () => {});

    expect(d.kind).toBe("stand-down");
    expect(heal).not.toHaveBeenCalled();
  });

  it("a stopped studio is never restarted, so a stopped container never starts billing", async () => {
    const s = fakeStorage();
    const heal = vi.fn(async () => {});

    await healBareContainer(s as never, STUDIO_ID, status({ state: "stopped" }), bare(), () => NOW, heal, async () => {});

    expect(heal).not.toHaveBeenCalled();
    expect(s.map.get(HEAL_ATTEMPT_KEY)).toBeUndefined();
  });

  it("a provisioned verdict disarms the marker in storage", async () => {
    const s = fakeStorage({ marker: armed() });
    const heal = vi.fn(async () => {});

    const d = await healBareContainer(s as never, STUDIO_ID, status(), provisioned(), () => NOW, heal, async () => {});

    expect(d.kind).toBe("disarm");
    expect((s.map.get(HEAL_ATTEMPT_KEY) as HealAttempt).armed).toBe(false);
    expect(heal).not.toHaveBeenCalled();
  });

  it("a disarmed marker lets a LATER episode heal again", async () => {
    const s = fakeStorage({ marker: armed({ armed: false }) });
    const heal = vi.fn(async () => {});

    await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW, heal, async () => {});

    expect(heal).toHaveBeenCalledTimes(1);
  });

  it("the reason is scrubbed on its way into storage", async () => {
    const s = fakeStorage();
    const leaky = bare("clone failed for https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/x/y");

    await healBareContainer(s as never, STUDIO_ID, status(), leaky, () => NOW, async () => {}, async () => {});

    expect(JSON.stringify(s.map.get(HEAL_ATTEMPT_KEY))).not.toContain("ghs_AAAA");
  });
});

// ---------------------------------------------------------------------------
// Wiring: the heal is a step of the syncSession cycle, isolated from the four
// before it exactly as board issue #24 made those isolated from each other.
// ---------------------------------------------------------------------------
describe("syncSessionCycle — the bare-container heal step", () => {
  function cycleDeps(checkStdout: string): SessionSyncDeps {
    return {
      // Every exec in the cycle answers the same way. The readiness check is
      // the only one whose stdout this test cares about: anything that is
      // neither PROVISIONED_OK nor PROVISIONED_UNKNOWN is a `bare` verdict.
      exec: vi.fn(async () => ({ code: 0, stdout: checkStdout, stderr: "" })),
      r2Put: vi.fn(async () => {}),
      r2List: vi.fn(async () => []),
      r2Delete: vi.fn(async () => {}),
      now: () => NOW,
      notify: vi.fn(async () => {}),
      burnAlertThresholdTokens: 0,
    } as unknown as SessionSyncDeps;
  }

  it("heals a running studio the tick finds bare", async () => {
    const s = fakeStorage({ status: status() });
    const heal = vi.fn(async () => {});

    await syncSessionCycle(cycleDeps("no git checkout at /workspace/fleetflare"),
      s as never, STUDIO_ID, async () => {}, null, heal);

    expect(heal).toHaveBeenCalledTimes(1);
  });

  it("does not heal a studio the tick finds provisioned", async () => {
    const s = fakeStorage({ status: status() });
    const heal = vi.fn(async () => {});

    await syncSessionCycle(cycleDeps("FLEET_PROVISIONED_OK"),
      s as never, STUDIO_ID, async () => {}, null, heal);

    expect(heal).not.toHaveBeenCalled();
  });

  // The four steps before it each have their own try/catch for this reason;
  // the heal gets the same treatment, and for the stronger version of it: a
  // heal is the only step that can restart a container.
  it("a heal that throws never costs the tick the verdict it already recorded", async () => {
    const s = fakeStorage({ status: status() });
    const recorded: StudioStatus[] = [];

    await syncSessionCycle(cycleDeps("no git checkout at /workspace/fleetflare"),
      s as never, STUDIO_ID, async (st) => { recorded.push(st); },
      null, async () => { throw new Error("restart failed"); });

    expect(recorded.some((st) => st.readiness?.kind === "bare")).toBe(true);
  });

  it("no heal wired at all leaves the cycle exactly as it was", async () => {
    const s = fakeStorage({ status: status() });

    await syncSessionCycle(cycleDeps("no git checkout at /workspace/fleetflare"),
      s as never, STUDIO_ID, async () => {});

    expect(s.map.get(HEAL_ATTEMPT_KEY)).toBeUndefined();
  });

  it("the healed row is loud: BARE_SELF_HEALED names what a silent retry would hide", () => {
    expect(BARE_SELF_HEALED).toContain("BARE");
    expect(BARE_SELF_HEALED).toContain("restarted once");
  });
});

// ---------------------------------------------------------------------------
// The rollout race, measured on the very deploy that shipped the heal.
// ---------------------------------------------------------------------------
describe("a heal killed by a container rollout is not an attempt", () => {
  const rolloutError =
    "bring-up failed on BOTH attempts. first: Error: Runtime signalled the " +
    "container to exit due to a new version rollout: 0";

  it("recognises the runtime's own message", () => {
    expect(healDiedInRollout(status({ error: rolloutError }))).toBe(true);
    expect(healDiedInRollout(status({ error: "clone failed (128)" }))).toBe(false);
    expect(healDiedInRollout(status({ error: null }))).toBe(false);
    expect(healDiedInRollout(undefined)).toBe(false);
    expect(rolloutError).toContain(ROLLOUT_EXIT_MARKER);
  });

  // The worst possible moment to spend the one attempt: the container is bare
  // precisely BECAUSE it was just replaced, and the marker would hold the
  // studio bare until a human noticed -- the failure #71 exists to end.
  // This test was WRONG in its first version and the fix it guarded was inert
  // because of it. It passed `status()` -- a freshly synthesized `running`
  // row -- to decideHeal, instead of the row the heal had actually just
  // written. The real row is `degraded` (runRestart CATCHES a killed
  // bring-up and persists degraded rather than throwing), and the state gate
  // rejected it before the marker was ever read. Swapping this one line to
  // read `s.map.get(STATUS_KEY)` turned the assertion into
  // `expected 'stand-down' to be 'heal'`.
  //
  // So: always feed the next-tick assertion the row the previous step WROTE,
  // never a hand-built one. A synthesized status tests the test.
  it("gives the attempt back, so the next tick heals the replacement", async () => {
    const s = fakeStorage({ status: status() });

    await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW,
      async () => { s.map.set(STATUS_KEY, status({ state: "degraded", error: rolloutError })); },
      async () => {});

    expect((s.map.get(HEAL_ATTEMPT_KEY) as HealAttempt).armed).toBe(false);
    // The REAL row, as the next tick would read it.
    const nextTickRow = s.map.get(STATUS_KEY) as StudioStatus;
    expect(nextTickRow.state).toBe("degraded");
    expect(decideHeal(nextTickRow, bare(), s.map.get(HEAL_ATTEMPT_KEY) as HealAttempt).kind).toBe("heal");
  });

  // Bounded, not a loop: a rollout ends, and the heal that follows it arms
  // normally.
  it("an ordinary failure still spends the attempt", async () => {
    const s = fakeStorage({ status: status() });

    await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW,
      async () => { s.map.set(STATUS_KEY, status({ state: "degraded", error: "clone failed (128): repository not found" })); },
      async () => {});

    expect((s.map.get(HEAL_ATTEMPT_KEY) as HealAttempt).armed).toBe(true);
    // Same rule as above: the row the heal wrote, not a synthesized one.
    const nextTickRow = s.map.get(STATUS_KEY) as StudioStatus;
    expect(decideHeal(nextTickRow, bare(), s.map.get(HEAL_ATTEMPT_KEY) as HealAttempt).kind).toBe("stand-down");
  });
});

// ---------------------------------------------------------------------------
// Issue #86 — the guard that was vacuous.
//
// decideHeal's own doc said `provisioning` was excluded because "an operation
// is already in flight and its own verification will speak". It never could:
// runProvision/runRestart build `state: "provisioning"` as a LOCAL variable
// and STATUS_KEY is written only AFTER they return, so the stored row reads
// `running` for the whole multi-minute operation. Nothing serializes the
// alarm against the RPC either -- a DO's input gate is open across every
// non-storage await, and every sbExec in a provision is one.
//
// Found by three independent adversarial verifiers, unanimous.
// ---------------------------------------------------------------------------
describe("decideHeal — an operation in flight is the only thing that can say so", () => {
  const since = new Date(NOW.getTime() - 30_000).toISOString();

  it.each<OperationInFlight["op"]>(["provision", "restart"])(
    "stands down while a %s is running, however bare the studio looks",
    (op) => {
      const d = decideHeal(status(), bare(), undefined, { op, since }, NOW);
      expect(d.kind).toBe("stand-down");
      expect(d.kind === "stand-down" && d.why).toContain(op);
    },
  );

  it("heals normally once the operation has released the lock", () => {
    expect(decideHeal(status(), bare(), undefined, undefined, NOW).kind).toBe("heal");
  });

  // A lock that cannot expire is worse than no lock: an isolate evicted
  // mid-provision leaves it set with nobody to clear it, and the studio could
  // never heal again — the exact permanent-disable failure #81 removed from
  // the state gate.
  it("ignores a STALE lock, so a provision that died cannot disable healing forever", () => {
    const dead = new Date(NOW.getTime() - OPERATION_STALE_MS - 1000).toISOString();
    expect(decideHeal(status(), bare(), undefined, { op: "provision", since: dead }, NOW).kind)
      .toBe("heal");
  });

  it("a lock just under the staleness bound is still believed", () => {
    const fresh = new Date(NOW.getTime() - OPERATION_STALE_MS + 1000).toISOString();
    expect(decideHeal(status(), bare(), undefined, { op: "provision", since: fresh }, NOW).kind)
      .toBe("stand-down");
  });

  // An unparseable or future-dated `since` must not be read as "fresh
  // forever". Both fall through to the ordinary decision.
  it("a nonsense timestamp does not wedge the studio", () => {
    expect(decideHeal(status(), bare(), undefined, { op: "provision", since: "not-a-date" }, NOW).kind)
      .toBe("heal");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(decideHeal(status(), bare(), undefined, { op: "provision", since: future }, NOW).kind)
      .toBe("heal");
  });

  it("healBareContainer reads the lock from storage and refuses", async () => {
    const s = fakeStorage({ status: status(), inFlight: { op: "provision", since } });
    const heal = vi.fn(async () => {});

    const d = await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW, heal, async () => {});

    expect(d.kind).toBe("stand-down");
    expect(heal).not.toHaveBeenCalled();
    // And it did NOT spend the episode's one attempt fighting the operator.
    expect(s.map.get(HEAL_ATTEMPT_KEY)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #103 — the lock a FINISHED operation leaves behind.
//
// provisionWithStorage and restartWithStorage release the #86 lock with
// put(OPERATION_KEY, null). Real DO storage hands that null straight back.
// decideHeal tested `inFlight !== undefined` and then read `inFlight.since`,
// so every tick on any studio that had ever been provisioned, restarted or
// healed threw `Cannot read properties of null (reading 'since')`. The cycle
// caught it and logged `bare-container heal failed`; the marker never armed
// and no heal ever ran. MEASURED 2026-09-24: acme-os--web-studio sat bare
// 12:13-12:33Z, one `heal failed` per tick, until a human provisioned it.
// ---------------------------------------------------------------------------
describe("a cleared operation lock (stored null) does not disable the heal", () => {
  it("decideHeal treats a null lock as no lock", () => {
    expect(decideHeal(status(), bare(), undefined, null, NOW)).toEqual({
      kind: "heal", reason: "no git checkout at /workspace/fleetflare",
    });
  });

  it("healBareContainer heals a bare studio whose lock a finished provision cleared", async () => {
    const s = fakeStorage({ status: status() });
    // Exactly what provisionWithStorage's `finally` writes.
    await s.put(OPERATION_KEY, null);
    const heal = vi.fn(async () => {});

    const d = await healBareContainer(s as never, STUDIO_ID, status(), bare(), () => NOW, heal, async () => {});

    expect(d.kind).toBe("heal");
    expect(heal).toHaveBeenCalledTimes(1);
    expect((s.map.get(HEAL_ATTEMPT_KEY) as HealAttempt).armed).toBe(true);
  });

  // The path that hid it: the cycle swallows a heal that throws, so the
  // failure was a log line every 300s and nothing else.
  it("syncSessionCycle heals it too, instead of logging `heal failed` forever", async () => {
    const s = fakeStorage({ status: status() });
    await s.put(OPERATION_KEY, null);
    const heal = vi.fn(async () => {});
    const deps = {
      exec: vi.fn(async () => ({ code: 0, stdout: "no git checkout at /workspace/fleetflare", stderr: "" })),
      r2Put: vi.fn(async () => {}),
      r2List: vi.fn(async () => []),
      r2Delete: vi.fn(async () => {}),
      now: () => NOW,
      notify: vi.fn(async () => {}),
      burnAlertThresholdTokens: 0,
    } as unknown as SessionSyncDeps;

    await syncSessionCycle(deps, s as never, STUDIO_ID, async () => {}, null, heal);

    expect(heal).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #191 — the tailnet warning (#189/#190) goes missing specifically on
// the SELF-HEAL path, even though the exact same marker-reading machinery
// (runProvisionedCheck / checkAndRecordReadiness) is already covered, green,
// for the plain provision/restart path (test/studio.readiness.test.ts).
//
// Every `heal` callback above is hand-written: it pokes STATUS_KEY directly
// and never calls the real readiness machinery at all. That is the gap this
// suite closes — `heal` here replicates what restartUngated's real sequence
// does: runRestart carries the EXISTING (stale) readiness forward onto
// STATUS_KEY first, and only THEN does restartWithFreshVerdict's
// checkAndRecordReadiness overwrite it with a verdict measured against the
// container AFTER the restart.
// ---------------------------------------------------------------------------
describe("the real heal path — issue #191, tailnet warning after heal", () => {
  function realSyncDeps(responses: string[]): SessionSyncDeps & { execCalls: string[] } {
    const execCalls: string[] = [];
    let call = 0;
    return {
      exec: async (cmd: string) => {
        execCalls.push(cmd);
        const stdout = responses[Math.min(call, responses.length - 1)];
        call++;
        return { code: 0, stdout, stderr: "" };
      },
      r2Put: async () => {},
      r2List: async () => [],
      r2Delete: async () => {},
      now: () => NOW,
      notify: async () => {},
      burnAlertThresholdTokens: 0,
      execCalls,
    };
  }

  it("records the tailnet marker on the row after a REAL heal-restart, not a hand-mocked one", async () => {
    const s = fakeStorage({ status: status() });
    const recorded: StudioStatus[] = [];
    const recordStudioFn = async (st: StudioStatus) => { recorded.push(st); };

    // First exec answer: the tick's OWN pre-heal check — bare, no claude pane.
    // Second exec answer: the post-heal-restart check — provisioned, with the
    // tailnet marker line riding its stdout, same shape studio-bringup.sh
    // actually writes it in (test/studio.readiness.test.ts:115).
    const deps = realSyncDeps([
      "claude is not running (no claude pane found)",
      `${PROVISIONED_OK}\ntailnet: quota reached\n`,
    ]);

    // Step 1: the tick's pre-heal readiness check, for real.
    const checked = await checkAndRecordReadiness(deps, s as never, STUDIO_ID, recordStudioFn);
    expect(checked?.readiness?.kind).toBe("bare");

    // Step 2: the heal fires. Replicates restartUngated's real two-phase
    // write: runRestart carries the stale (bare) readiness forward onto
    // STATUS_KEY first (restartWithStorage, provision.ts), and only THEN
    // does restartWithFreshVerdict's checkAndRecordReadiness overwrite it
    // with a verdict measured after the restart actually ran.
    const heal = async () => {
      const stale = await s.get(STATUS_KEY);
      await s.put(STATUS_KEY, { ...stale, error: null, state: "running" } as StudioStatus);
      await checkAndRecordReadiness(deps, s as never, STUDIO_ID, recordStudioFn);
    };

    await healBareContainer(
      s as never, STUDIO_ID, checked as StudioStatus, (checked as StudioStatus).readiness as StudioReadiness,
      () => NOW, heal, recordStudioFn,
    );

    const finalRow = s.map.get(STATUS_KEY) as StudioStatus;
    expect(finalRow.readiness).toEqual({
      kind: "provisioned", warning: "tailnet: quota reached", checkedAt: NOW.toISOString(),
    });
    expect(recorded.at(-1)?.readiness).toEqual({
      kind: "provisioned", warning: "tailnet: quota reached", checkedAt: NOW.toISOString(),
    });
  });
});
