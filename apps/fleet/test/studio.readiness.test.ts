import { describe, it, expect } from "vitest";
import { checkAndRecordReadiness, provisionWithFreshVerdict, CHECK_ATTEMPTS } from "../src/studio/do";
import {
  STATUS_KEY, PROVISIONED_OK, provisionedCheckCmd, bringupLogTailCmd, type StudioStorage,
} from "../src/studio/provision";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import { STUDIO_TMUX, withStudioTmux } from "../src/studio/tmux";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";

// Fleet ls readiness fix ("a dead studio looks alive" — P5a Task 5's Finding
// 2, live-measured: 3 of 4 studios bare, `fleet ls` showed every one
// `running, error: null`). checkAndRecordReadiness (do.ts) is do.ts's own
// composition of checkProvisionedWithRetry (already covered by its own
// suite elsewhere) plus the storage/registry write — these tests target
// THAT wiring: does a verdict actually land on StudioStatus.readiness with
// the right shape, does it skip when there is nothing to check, does it
// check the right repo. Kept in its own file, not test/studio.session.test.ts
// (checkProvisionedWithRetry's own home) — this feature's registry/CLI
// surface is a distinct enough concern to earn its own file, the same call
// test/studio.burn.test.ts made for mirrorBurnToRegistry.

const STUDIO_ID = "websites--pilot";
const NOW_ISO = "2026-08-28T12:00:00.000Z";

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

/** Same in-memory Map-backed StudioStorage fake studio.refresh.test.ts's own
 *  fakeStorage uses — kept local rather than imported, matching this
 *  feature's established convention of redefining fakes per file. */
function fakeStorage(seed?: { status?: StudioStatus }): StudioStorage {
  const map = new Map<string, unknown>();
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as StudioStorage["put"],
  };
}

/** `exec` is the one behavior each test varies; everything else is a fixed,
 *  cheap default — no harness expectation is ever seeded (ROLE_ENV_KEY
 *  absent), so checkProvisionedWithRetry always runs the plain two-marker
 *  check, and the fake never actually parses the command text it is handed
 *  (these tests are about the wiring around the check, not the check's own
 *  shell — that suite lives elsewhere). */
function fakeSyncDeps(
  exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): SessionSyncDeps & { execCalls: string[] } {
  const execCalls: string[] = [];
  return {
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      return exec(cmd);
    },
    r2Put: async () => {},
    r2List: async () => [],
    r2Delete: async () => {},
    now: fixedNow(NOW_ISO),
    notify: async () => {},
    burnAlertThresholdTokens: 0,
    execCalls,
  };
}

/**
 * A container that answers the provisioned check with `reason` and carries NO
 * bring-up log at all — one provisioned before issue #38 shipped, or one
 * hollow enough that bring-up never created the file.
 *
 * Needed because issue #38 appends the tail of container/studio-bringup.sh's
 * own log to a BARE verdict, and these tests are about the verdict being the
 * container's own words rather than about that diagnostic: a fake answering
 * every command identically would hand the reason back as its own log tail.
 * The tail's behaviour has its own coverage in test/studio.replacement.test.ts.
 */
function bareWithNoLog(reason: string): (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }> {
  return async (cmd: string) =>
    cmd === bringupLogTailCmd()
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 0, stdout: reason, stderr: "" };
}

describe("checkAndRecordReadiness (do.ts)", () => {
  it("provisioned: records {kind:'provisioned', checkedAt}, one exec only, writes storage AND calls recordStudioFn", async () => {
    const storage = fakeStorage({ status: status() });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));
    const recorded: StudioStatus[] = [];

    await checkAndRecordReadiness(deps, storage, STUDIO_ID, async (s) => {
      recorded.push(s);
    });

    expect(deps.execCalls).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
    expect((await storage.get(STATUS_KEY))?.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
  });

  it("bare: records {kind:'bare', reason, checkedAt} — the container's own words, verbatim", async () => {
    const storage = fakeStorage({ status: status() });
    const deps = fakeSyncDeps(bareWithNoLog("no git checkout at /workspace/websites"));
    const recorded: StudioStatus[] = [];

    await checkAndRecordReadiness(deps, storage, STUDIO_ID, async (s) => {
      recorded.push(s);
    });

    expect(recorded[0].readiness).toEqual({
      kind: "bare", reason: "no git checkout at /workspace/websites", checkedAt: NOW_ISO,
    });
  });

  it("inconclusive (exec throws every attempt): retries CHECK_ATTEMPTS times, then records {kind:'inconclusive', reason, checkedAt}", async () => {
    const storage = fakeStorage({ status: status() });
    const deps = fakeSyncDeps(async () => {
      throw new Error("sandbox unreachable");
    });
    const recorded: StudioStatus[] = [];

    await checkAndRecordReadiness(deps, storage, STUDIO_ID, async (s) => {
      recorded.push(s);
    });

    expect(deps.execCalls).toHaveLength(CHECK_ATTEMPTS);
    expect(recorded[0].readiness).toMatchObject({ kind: "inconclusive", checkedAt: NOW_ISO });
    expect((recorded[0].readiness as { reason: string }).reason).toContain("sandbox unreachable");
  });

  it("only readiness changes on the recorded status — every other field carries through untouched", async () => {
    const storage = fakeStorage({ status: status({ tailscaleHost: "pilot.tail", error: null }) });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));
    const recorded: StudioStatus[] = [];

    await checkAndRecordReadiness(deps, storage, STUDIO_ID, async (s) => {
      recorded.push(s);
    });

    expect(recorded[0]).toEqual(status({
      tailscaleHost: "pilot.tail", readiness: { kind: "provisioned", checkedAt: NOW_ISO },
    }));
  });

  it("no status ever stored yet: skips silently, never execs, never calls recordStudioFn", async () => {
    const storage = fakeStorage(); // no status seeded
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));
    let called = false;

    await checkAndRecordReadiness(deps, storage, STUDIO_ID, async () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(deps.execCalls).toHaveLength(0);
  });

  it("an id that does not parse as repo--role: skips silently, never execs", async () => {
    const storage = fakeStorage({ status: status({ id: "unknown" }) });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));
    let called = false;

    await checkAndRecordReadiness(deps, storage, "unknown", async () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(deps.execCalls).toHaveLength(0);
  });

  it("checks the REPO segment of the studio id, not the full id, not the role", async () => {
    const storage = fakeStorage({ status: status({ id: "otherrepo--web-studio" }) });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    await checkAndRecordReadiness(deps, storage, "otherrepo--web-studio", async () => {});

    expect(deps.execCalls[0]).toContain("/workspace/otherrepo/.git");
  });

  it("returns the status it stamped, so a caller can report the fresh verdict without a second read", async () => {
    const storage = fakeStorage({ status: status() });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    const returned = await checkAndRecordReadiness(deps, storage, STUDIO_ID, async () => {});

    expect(returned?.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
  });

  it("returns null when it skipped, so a caller can tell 'no verdict taken' from a verdict", async () => {
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    expect(await checkAndRecordReadiness(deps, fakeStorage(), STUDIO_ID, async () => {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #37: a recovery verb that heals a studio must REPORT that it healed
// it. `provision` used to return whatever readiness the last syncSession tick
// had stamped — up to SYNC_SESSION_SECONDS (300s) old — so a measured,
// real recovery on 2026-09-23 (acme-os--release-studio, healed by a single
// `fleet provision`) kept printing "bare: no git checkout" for minutes while
// /workspace/acme-os/.git existed and claude was running. An operator, and
// then a reviewing agent, read that row and concluded the command had done
// nothing. It had.
// ---------------------------------------------------------------------------

describe("provisionWithFreshVerdict (do.ts) — provision reports on the studio it just made", () => {
  const CFG: ProvisionConfig = { repo: "websites", role: "pilot" };
  const STALE_ISO = "2026-08-28T11:00:00.000Z";

  /** A provision that writes its result to storage exactly as the real one
   *  does — runProvision spreads the EXISTING status forward, readiness
   *  included, which is precisely how a stale verdict survives a successful
   *  provision and gets echoed back at the operator. */
  function provisionCore(storage: StudioStorage, next: Partial<StudioStatus> = {}) {
    return async (_cfg: ProvisionConfig): Promise<StudioStatus> => {
      const existing = (await storage.get(STATUS_KEY)) ?? status();
      const written: StudioStatus = { ...existing, state: "running", error: null, ...next };
      await storage.put(STATUS_KEY, written);
      return written;
    };
  }

  it("a studio that was bare and is now healed: returns the NEW verdict, never the stored one", async () => {
    const storage = fakeStorage({
      status: status({ readiness: { kind: "bare", reason: "no git checkout at /workspace/websites", checkedAt: STALE_ISO } }),
    });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));
    const recorded: StudioStatus[] = [];

    const result = await provisionWithFreshVerdict(
      deps, storage, STUDIO_ID, provisionCore(storage), async (s) => { recorded.push(s); }, CFG,
    );

    expect(result.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
    expect(recorded.at(-1)?.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
    expect((await storage.get(STATUS_KEY))?.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
  });

  it("a studio that went bare since the last tick: returns bare with the container's own words, not the stored 'provisioned'", async () => {
    const storage = fakeStorage({ status: status({ readiness: { kind: "provisioned", checkedAt: STALE_ISO } }) });
    const deps = fakeSyncDeps(bareWithNoLog("no git checkout at /workspace/websites"));

    const result = await provisionWithFreshVerdict(
      deps, storage, STUDIO_ID, provisionCore(storage), async () => {}, CFG,
    );

    expect(result.readiness).toEqual({
      kind: "bare", reason: "no git checkout at /workspace/websites", checkedAt: NOW_ISO,
    });
  });

  it("checks AFTER provisioning, once, against the studio's own repo", async () => {
    const storage = fakeStorage({ status: status() });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));
    const order: string[] = [];
    const core = async (cfg: ProvisionConfig): Promise<StudioStatus> => {
      order.push(`provision:${cfg.repo}--${cfg.role}`);
      const written = status({ state: "running" });
      await storage.put(STATUS_KEY, written);
      return written;
    };

    await provisionWithFreshVerdict(deps, storage, STUDIO_ID, core, async () => {}, CFG);

    expect(order).toEqual(["provision:websites--pilot"]);
    expect(deps.execCalls).toHaveLength(1);
    expect(deps.execCalls[0]).toContain("/workspace/websites/.git");
  });

  it("every other field of the provisioned status carries through untouched", async () => {
    const storage = fakeStorage({ status: status() });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    const result = await provisionWithFreshVerdict(
      deps, storage, STUDIO_ID, provisionCore(storage, { tailscaleHost: "pilot.tail" }), async () => {}, CFG,
    );

    expect(result).toEqual(status({
      tailscaleHost: "pilot.tail", readiness: { kind: "provisioned", checkedAt: NOW_ISO },
    }));
  });

  it("a check that could not be taken at all reports inconclusive — never a cached verdict", async () => {
    // An id with no repo--role segment: there is nothing to check against, so
    // checkAndRecordReadiness skips. The stored verdict must NOT be echoed
    // back as if it had just been measured — that is issue #37 itself.
    const storage = fakeStorage({ status: status({ id: "unknown", readiness: { kind: "provisioned", checkedAt: STALE_ISO } }) });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    const result = await provisionWithFreshVerdict(
      deps, storage, "unknown", provisionCore(storage), async () => {}, CFG,
    );

    expect(result.readiness).toMatchObject({ kind: "inconclusive", checkedAt: NOW_ISO });
    expect(deps.execCalls).toHaveLength(0);
  });

  it("a readiness write that throws does not fail the provision, and still never reports the stale verdict", async () => {
    const storage = fakeStorage({ status: status({ readiness: { kind: "bare", reason: "stale", checkedAt: STALE_ISO } }) });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    const result = await provisionWithFreshVerdict(
      deps, storage, STUDIO_ID, provisionCore(storage),
      async () => { throw new Error("D1 unavailable"); }, CFG,
    );

    expect(result.state).toBe("running");
    expect(result.readiness).toMatchObject({ kind: "inconclusive", checkedAt: NOW_ISO });
    expect((result.readiness as { reason: string }).reason).toContain("D1 unavailable");
  });
});

// ---------------------------------------------------------------------------
// Issue #37, follow-up comment: the live check must be INVISIBLE. A probe
// that left tmux window 1 active on a studio made an operator open the tab,
// see a bare `root@cloudchamber:/workspace#` prompt and call a healthy studio
// dead — the third false diagnosis this fleet took from that one cause.
// `tmux display-message -p -t studio:claude` addresses the window BY NAME and
// never requires it to be active, so the check is invisible by construction.
// Pinned here so no future edit can reintroduce a window switch.
// ---------------------------------------------------------------------------

describe("provisionedCheckCmd — the on-demand live check leaves no trace", () => {
  const cmds = () => [provisionedCheckCmd("websites"), provisionedCheckCmd("websites", "Y2xhdWRl")];

  it("addresses the claude window by name and never switches, selects or creates one", () => {
    for (const cmd of cmds()) {
      expect(cmd).toContain("tmux display-message -p -t studio:claude");
      for (const forbidden of ["select-window", "select-pane", "send-keys", "new-window", "attach-session", "switch-client", "kill-window"]) {
        expect(cmd).not.toContain(forbidden);
      }
    }
  });

  it("invokes tmux exactly once, as display-message, so there is nothing to restore", () => {
    for (const cmd of cmds()) {
      // Issue #117: tmux is reached only through the dual-socket builder's
      // function; its own prefix (probe + passthrough) is pinned in
      // test/bun/tmux-socket.test.ts. The body after it is what this pins.
      expect(cmd.startsWith(withStudioTmux(""))).toBe(true);
      const body = cmd.slice(withStudioTmux("").length);
      // Command-position `tmux` only: the string "in tmux studio:claude"
      // inside the human-readable bare reason is prose, not an invocation.
      expect(body.match(new RegExp(`\\$\\(${STUDIO_TMUX} `, "g")) ?? []).toHaveLength(1);
      expect(body).toContain(`$(${STUDIO_TMUX} display-message -p -t studio:claude`);
      expect(body).not.toMatch(/[;&|]\s*(?:__ff_)?tmux /);
    }
  });
});
