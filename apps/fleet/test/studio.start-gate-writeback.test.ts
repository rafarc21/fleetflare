import { describe, it, expect, vi } from "vitest";
import { startRefusal, runScheduledTick, syncSessionCycle, refreshWithStorage, checkAndRecordReadiness } from "../src/studio/do";
import { runAccountFailover, PANE_CAPTURE_MARKER, type FailoverDeps } from "../src/studio/failover";
import { STATUS_KEY, DESTROYING_KEY } from "../src/studio/provision";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import type { StudioStatus, StudioState } from "../src/studio/types";

// ---------------------------------------------------------------------------
// Issue #123, fix round (verifier S2): a tick exec that STARTED before a
// destroy must not write its stale row back over the destroy.
//
// checkAndRecordReadiness, refreshWithStorage and the failover switch read
// STATUS before their exec and wrote after it. A destroy that lands while the
// exec is in flight writes `stopped`; the exec then reaches the start gate and
// is refused; and the stale write put `running`/`degraded` back. That
// re-opened the gate, runScheduledTick re-armed, and the NEXT tick booted a
// container under a `running` row the #95 watch cannot see.
//
// Every exec below that lands a destroy then goes through the REAL
// startRefusal, exactly as it would behind StudioDO's gate.
// ---------------------------------------------------------------------------

const ID = "fleetflare--web-studio";

function row(state: StudioState): StudioStatus {
  return {
    id: ID, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  };
}

function store(state: StudioState = "running") {
  const map = new Map<string, unknown>([[STATUS_KEY, row(state)]]);
  return {
    map,
    get: async (k: string | string[]) => (Array.isArray(k) ? new Map() : map.get(k)),
    put: async (k: string | Record<string, unknown>, v?: unknown) => {
      if (typeof k === "object") for (const [kk, vv] of Object.entries(k)) map.set(kk, vv);
      else map.set(k, v);
    },
    delete: async (k: string) => map.delete(k),
  };
}
type Store = ReturnType<typeof store>;

/** What destroyAndRecord + destroyWithSync's `finally` leave behind. */
function destroyCompletes(s: Store) {
  s.map.set(STATUS_KEY, { ...(s.map.get(STATUS_KEY) as StudioStatus), state: "stopped", error: null });
  s.map.set(DESTROYING_KEY, null);
}

/** destroyWithSync's marker, set just before destroy() — still in flight. */
function destroyStarts(s: Store) {
  s.map.set(DESTROYING_KEY, new Date().toISOString());
}

async function gatedExec(s: Store) {
  const refusal = await startRefusal(s as never, ID, new Date(), false);
  if (refusal !== null) throw new Error(refusal);
  return { code: 0, stdout: "", stderr: "" };
}

const state = (s: Store) => (s.map.get(STATUS_KEY) as StudioStatus).state;

function syncDeps(exec: SessionSyncDeps["exec"]) {
  return {
    exec, r2Put: async () => {}, r2List: async () => [], r2Delete: async () => {},
    now: () => new Date(), notify: vi.fn(async () => {}), burnAlertThresholdTokens: 0,
  } as unknown as SessionSyncDeps;
}

describe("#123 write-back — syncSession readiness exec", () => {
  it("destroy completes during the readiness exec: row stays stopped, no re-arm, gate still refuses", async () => {
    const s = store();
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("pane_current_command")) {
        destroyCompletes(s);
        return gatedExec(s);
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const rearm = vi.fn(async () => {});
    const recorded: StudioStatus[] = [];
    await runScheduledTick(
      s as never,
      () => syncSessionCycle(syncDeps(exec), s as never, ID, async (r) => { recorded.push(r); }, null, vi.fn(async () => {})),
      rearm, "syncSession",
    );
    expect(state(s)).toBe("stopped");
    expect(recorded.filter((r) => r.state !== "stopped")).toEqual([]);
    expect(rearm).not.toHaveBeenCalled();
    expect(await startRefusal(s as never, ID, new Date(), false)).not.toBeNull();
  });

  it("destroy still in flight during the readiness exec: no readiness write", async () => {
    const s = store();
    const record = vi.fn(async () => {});
    const deps = syncDeps(vi.fn(async () => {
      destroyStarts(s);
      return gatedExec(s);
    }));
    await checkAndRecordReadiness(deps, s as never, ID, record);
    expect((s.map.get(STATUS_KEY) as StudioStatus).readiness).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it("no destroy: readiness is still recorded (regression guard)", async () => {
    const s = store();
    const record = vi.fn(async () => {});
    await checkAndRecordReadiness(syncDeps(vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }))), s as never, ID, record);
    expect((s.map.get(STATUS_KEY) as StudioStatus).readiness).toBeDefined();
    expect(record).toHaveBeenCalled();
  });
});

function refreshDeps(s: Store, onFirstExec: () => void) {
  let first = true;
  return {
    mintToken: async () => "gh-token",
    sbExec: vi.fn(async () => {
      if (first) {
        first = false;
        onFirstExec();
      }
      return gatedExec(s);
    }),
    recordStudio: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    now: () => new Date().toISOString(),
  };
}

describe("#123 write-back — refreshToken", () => {
  it("destroy completes during the refresh exec: row stays stopped, no alert, no record, no re-arm", async () => {
    const s = store();
    const deps = refreshDeps(s, () => destroyCompletes(s));
    const rearm = vi.fn(async () => {});
    await runScheduledTick(s as never, async () => { await refreshWithStorage(deps, s as never, ID); }, rearm, "refreshToken");
    expect(state(s)).toBe("stopped");
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.recordStudio).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
    expect(await startRefusal(s as never, ID, new Date(), false)).not.toBeNull();
  });

  it("destroy starts during the refresh exec: nothing written over it", async () => {
    const s = store();
    const deps = refreshDeps(s, () => destroyStarts(s));
    const out = await refreshWithStorage(deps, s as never, ID);
    expect(state(s)).toBe("running");
    expect((s.map.get(STATUS_KEY) as StudioStatus).lastRefreshError).toBeNull();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.recordStudio).not.toHaveBeenCalled();
    expect(out.state).toBe("running");
  });

  it("re-provision of a stopped studio (no destroy during it) still records its refresh", async () => {
    const s = store("stopped");
    const deps = { ...refreshDeps(s, () => {}), sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
    await refreshWithStorage(deps, s as never, ID);
    expect((s.map.get(STATUS_KEY) as StudioStatus).lastRefresh).not.toBeNull();
    expect(deps.recordStudio).toHaveBeenCalled();
  });
});

const MODAL_PANE = [
  "╭────────────────────────────────────────────────────────────────╮",
  "│ You've hit your org's monthly spend limit                      │",
  "│                                                                │",
  "│ Run /rate-limit-options to see what you can do.                │",
  "│                                                                │",
  "│ ❯ 1. Upgrade your plan                                         │",
  "│   2. Not now                                                   │",
  "╰────────────────────────────────────────────────────────────────╯",
].join("\n");

describe("#123 write-back — failover switch", () => {
  it("destroy lands during the account switch: no switched row, no record, no alert", async () => {
    const s = store();
    let calls = 0;
    const deps: FailoverDeps = {
      autoFailover: true,
      exec: vi.fn(async () => {
        calls++;
        if (calls === 1) return { code: 0, stdout: `${MODAL_PANE}\n${PANE_CAPTURE_MARKER}\n${MODAL_PANE}\n`, stderr: "" };
        destroyCompletes(s);
        return gatedExec(s).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
      }),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
      now: () => new Date(),
      accounts: [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", token: "t1" },
        { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: "t2" },
      ],
    };
    const record = vi.fn(async () => {});
    const outcome = await runAccountFailover(deps, s as never, ID, record);
    expect(state(s)).toBe("stopped");
    expect((s.map.get(STATUS_KEY) as StudioStatus).claudeAccount).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("skipped");
  });

  it("destroy starts during the pane capture: no exhausted row, no record, no alert", async () => {
    const s = store();
    const deps: FailoverDeps = {
      autoFailover: true,
      exec: vi.fn(async () => {
        destroyStarts(s);
        return { code: 0, stdout: `${MODAL_PANE}\n${PANE_CAPTURE_MARKER}\n${MODAL_PANE}\n`, stderr: "" };
      }),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
      now: () => new Date(),
      accounts: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", token: "t1" }],
    };
    const record = vi.fn(async () => {});
    const outcome = await runAccountFailover(deps, s as never, ID, record);
    expect(state(s)).toBe("running");
    expect(record).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("skipped");
  });
});
