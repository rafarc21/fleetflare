import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  STATUS_KEY, OPERATION_KEY, OPERATION_STALE_MS, provisionWithStorage,
  type StudioStorage, type ProvisionDeps,
} from "../src/studio/provision";
import { recordStudio, listStudios } from "../src/studio/registry";
import { destroyWithSync } from "../src/studio/destroy";
import { RESCUE_CLEAN, HARVEST_NO_RECORD } from "../src/studio/do";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import { formatState } from "../cli/readiness-format";
import type { Env } from "../src/env";
import {
  observeContainer, watchStoppedContainers, isWatchMinute,
} from "../src/studio/container-watch";
import type { StudioStatus } from "../src/studio/types";

// Issue #95: `fleet ls` read D1 only, so a studio recorded `stopped` whose
// Cloudflare container was in fact running (and billing) looked identical to
// one that was really off. The detector is OBSERVATION ONLY: it reads the
// runtime's own `ctx.container.running` flag (never an exec — sbExec STARTS a
// stopped container) and records the mismatch on the studio's row.

const ID = "acme-os--maestro";

function status(over: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: ID, state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...over,
  };
}

function memStorage(initial?: StudioStatus): StudioStorage & { puts: StudioStatus[] } {
  let value = initial;
  const puts: StudioStatus[] = [];
  return {
    puts,
    get: (async (key: string) => (key === STATUS_KEY ? value : undefined)) as StudioStorage["get"],
    put: (async (key: string, v: StudioStatus) => {
      if (key === STATUS_KEY) { value = v; puts.push(v); }
    }) as StudioStorage["put"],
  };
}

const T1 = new Date("2026-09-24T12:40:00.000Z");
const T2 = new Date("2026-09-24T12:45:00.000Z");

describe("observeContainer (issue #95)", () => {
  it("records a stopped studio whose container is running, stamped with when it was first seen", async () => {
    const storage = memStorage(status());
    const recorded: StudioStatus[] = [];
    await observeContainer(storage, true, async (s) => { recorded.push(s); }, T1);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0].containerRunningSince).toBe(T1.toISOString());
    expect(storage.puts[0].state).toBe("stopped");
    expect(recorded).toEqual(storage.puts);
  });

  it("keeps the FIRST sighting on a later check that still sees it running, and writes nothing", async () => {
    const storage = memStorage(status({ containerRunningSince: T1.toISOString() }));
    const recorded: StudioStatus[] = [];
    await observeContainer(storage, true, async (s) => { recorded.push(s); }, T2);
    expect(storage.puts).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("clears the mismatch once the container is seen off again", async () => {
    const storage = memStorage(status({ containerRunningSince: T1.toISOString() }));
    const recorded: StudioStatus[] = [];
    await observeContainer(storage, false, async (s) => { recorded.push(s); }, T2);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0].containerRunningSince).toBeNull();
    expect(recorded).toHaveLength(1);
  });

  it("writes nothing for a stopped studio whose container is off (the normal case)", async () => {
    const storage = memStorage(status());
    const recorded: StudioStatus[] = [];
    await observeContainer(storage, false, async (s) => { recorded.push(s); }, T1);
    expect(storage.puts).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("ignores a studio that is not stopped: a running container there is expected, not a leak", async () => {
    for (const state of ["running", "provisioning", "degraded"] as const) {
      const storage = memStorage(status({ state }));
      const recorded: StudioStatus[] = [];
      await observeContainer(storage, true, async (s) => { recorded.push(s); }, T1);
      expect(storage.puts).toHaveLength(0);
      expect(recorded).toHaveLength(0);
    }
  });

  it("ignores a DO with no recorded status at all (never provisioned)", async () => {
    const storage = memStorage(undefined);
    const recorded: StudioStatus[] = [];
    await observeContainer(storage, true, async (s) => { recorded.push(s); }, T1);
    expect(storage.puts).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });
});

describe("watchStoppedContainers (issue #95 cron fan-out)", () => {
  it("probes only the studios the registry records as stopped", async () => {
    const probed: string[] = [];
    await watchStoppedContainers(
      [status({ id: "a--maestro" }), status({ id: "b--pilot", state: "running" }), status({ id: "c--web-studio" })],
      async (id) => { probed.push(id); },
    );
    expect(probed).toEqual(["a--maestro", "c--web-studio"]);
  });

  it("one probe that throws does not stop the rest", async () => {
    const probed: string[] = [];
    await watchStoppedContainers(
      [status({ id: "a--maestro" }), status({ id: "c--web-studio" })],
      async (id) => { probed.push(id); if (id === "a--maestro") throw new Error("DO unreachable"); },
    );
    expect(probed).toEqual(["a--maestro", "c--web-studio"]);
  });
});

describe("isWatchMinute (issue #95 rate limit)", () => {
  it("fires once every 5 minutes of the minute cron", () => {
    const fired = Array.from({ length: 10 }, (_, m) =>
      isWatchMinute(new Date(Date.UTC(2026, 8, 24, 12, m)).getTime()));
    expect(fired).toEqual([true, false, false, false, false, true, false, false, false, false]);
  });
});

// --- PR #109 review: two false "billing" readings ---------------------------

/** Storage that keeps every key, so the #86 in-flight lock can be seeded. */
function mapStorage(seed: StudioStatus, lock?: unknown): StudioStorage & { statusPuts: number } {
  const map = new Map<string, unknown>([[STATUS_KEY, seed]]);
  if (lock !== undefined) map.set(OPERATION_KEY, lock);
  const s = {
    statusPuts: 0,
    get: (async (k: string) => map.get(k)) as StudioStorage["get"],
    put: (async (k: string, v: unknown) => { if (k === STATUS_KEY) s.statusPuts++; map.set(k, v); }) as StudioStorage["put"],
  };
  return s;
}

const REPO_SLUG = "acme-org/websites";
const WID = "websites--scratch";
const ROLE_MD = `---
name: scratch
skills: []
allowedTools: Bash(git *) Edit Write
may_spawn: []
reports_to: operator
gates: []
---
You are scratch.
`;
const fetchBlueprintFile: ProvisionDeps["fetchBlueprintFile"] = async (_r, path, ref) => {
  if (path === "fleet.json") {
    return JSON.stringify({ blueprint: { repo: REPO_SLUG, ref: "main" }, roles: ["scratch"], instance_type: "standard-2" });
  }
  if (path === "fleet/blueprint/roles/scratch.md") return ROLE_MD;
  if (path === "fleet/blueprint/org.json") return JSON.stringify({ edges: {}, gates: {} });
  throw new Error(`fetch ${path}@${ref} failed (404): Not Found`);
};
const ws = (over: Partial<StudioStatus> = {}) => status({ id: WID, repoSlug: REPO_SLUG, ...over });

describe("observeContainer stands down while an operation holds the #86 lock", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM fleet_state").run(); });

  it("fresh lock: provision keeps the row stopped through bring-up, and that container is its own — no write", async () => {
    const storage = mapStorage(ws(), { op: "provision", since: new Date(T1.getTime() - 60_000).toISOString() });
    const recorded: StudioStatus[] = [];
    await observeContainer(storage, true, async (s) => { recorded.push(s); }, T1);
    expect(storage.statusPuts).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("stale lock (a dead isolate's wreckage): judged again", async () => {
    const storage = mapStorage(ws(), { op: "provision", since: new Date(T1.getTime() - OPERATION_STALE_MS - 1000).toISOString() });
    const recorded: StudioStatus[] = [];
    await observeContainer(storage, true, async (s) => { recorded.push(s); }, T1);
    expect(recorded.map((s) => s.containerRunningSince)).toEqual([T1.toISOString()]);
  });

  it("released lock (null, #103) reads exactly like no lock", async () => {
    const storage = mapStorage(ws(), null);
    const recorded: StudioStatus[] = [];
    await observeContainer(storage, true, async (s) => { recorded.push(s); }, T1);
    expect(recorded).toHaveLength(1);
  });

  it("end to end: a watch landing mid-provision leaves the registry row plain \"stopped\"", async () => {
    const storage = mapStorage(ws());
    await recordStudio(env as unknown as Env, ws());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const execReached = new Promise<void>((r) => { reached = r; });
    let first = true;
    const deps: ProvisionDeps = {
      sbExec: async () => {
        if (first) { first = false; reached(); await gate; }
        return { code: 0, stdout: "", stderr: "" };
      },
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
      now: () => new Date(T1.getTime() - 30_000).toISOString(),
      fetchBlueprintFile,
    };
    const p = provisionWithStorage(deps, storage, { repo: "websites", role: "scratch" }, REPO_SLUG);
    await execReached;
    await observeContainer(storage, true, (s) => recordStudio(env as unknown as Env, s), T1);
    const row = (await listStudios(env as unknown as Env)).find((s) => s.id === WID)!;
    expect(formatState(row)).toBe("stopped");
    release();
    await p;
  });
});

describe("every stopped episode starts clean", () => {
  it("destroy clears a sighting carried from an earlier episode", async () => {
    const storage = mapStorage(ws({ state: "running", containerRunningSince: "2026-09-24T09:05:00.000Z" }));
    const syncDeps = {
      exec: async (cmd: string) => {
        if (cmd.startsWith("mkdir -p")) return { code: 0, stdout: "0\n1758067200", stderr: "" }; // #202: size + tar-start watermark
        if (cmd.includes("status --porcelain")) return { code: 0, stdout: RESCUE_CLEAN, stderr: "" };
        if (cmd.includes(HARVEST_NO_RECORD)) return { code: 0, stdout: HARVEST_NO_RECORD, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      r2Put: async () => {}, r2List: async () => [], r2Delete: async () => {},
      now: () => new Date("2026-09-24T15:00:00.000Z"), notify: async () => {}, burnAlertThresholdTokens: 0,
    } as unknown as SessionSyncDeps;
    const destroyed = await destroyWithSync(
      syncDeps, storage as never, WID, async () => {}, async () => {}, "websites",
      async () => "unused/blueprint", async () => {},
    );
    expect(destroyed.containerRunningSince ?? null).toBeNull();
    expect(formatState(destroyed)).toBe("stopped");
  });

  it("provision clears it too, so no later row carries a stale sighting", async () => {
    const storage = mapStorage(ws({ containerRunningSince: "2026-09-24T09:05:00.000Z" }));
    const deps: ProvisionDeps = {
      sbExec: async () => ({ code: 0, stdout: "", stderr: "" }),
      recordStudio: async () => {},
      now: () => "2026-09-24T10:00:00.000Z",
      fetchBlueprintFile,
    };
    const provisioned = await provisionWithStorage(deps, storage, { repo: "websites", role: "scratch" }, REPO_SLUG);
    expect(provisioned.state).toBe("running");
    expect(provisioned.containerRunningSince ?? null).toBeNull();
  });
});

describe("first sighting is logged", () => {
  it("logs one line naming the studio when a mismatch is first seen, none on a repeat", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const storage = mapStorage(ws());
      await observeContainer(storage, true, async () => {}, T1);
      await observeContainer(storage, true, async () => {}, T2);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain(WID);
    } finally {
      log.mockRestore();
    }
  });
});
