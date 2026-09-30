import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { runResume, RESUME_COOLDOWN_MS, DEFAULT_MAX_STUDIOS, type ResumeDeps, type SpawnParent } from "../src/studio/spawn";
import { destroyWithSync } from "../src/studio/destroy";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { SessionSyncDeps, SessionSyncStorage } from "../src/studio/session-sync";
import { destroyPath } from "../cli/repair-failure";
import { parseCliArgs } from "../src/studio/cli-args";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";
import type { Env } from "../src/env";

// Issue #59, review round 1. Blocker 1: `resume` must not revive a studio the
// operator DESTROYED. Only a studio the operator PARKED (`fleet destroy
// --park`) is resumable, and never within RESUME_COOLDOWN_MS of its stop — so
// a park <-> resume cycle cannot spin up a container every few seconds.

const REPO_SLUG = "example-org/websites";
const MAESTRO: SpawnParent = { id: "websites--maestro", repo: "websites", role: "maestro", repoSlug: REPO_SLUG };
const NOW = new Date("2026-09-29T12:00:00.000Z");
const LONG_AGO = new Date(NOW.getTime() - RESUME_COOLDOWN_MS - 1000).toISOString();

function row(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--web-studio--5", state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: "operator", spawnTokenHash: null, repoSlug: REPO_SLUG,
    parked: true, stoppedAt: LONG_AGO, ...overrides,
  };
}

function deps(rows: StudioStatus[], provisioned: string[] = [], roles = ["maestro", "web-studio"]): ResumeDeps {
  return {
    listStudios: async () => rows,
    fetchPolicy: async () => ({ org: { edges: { maestro: ["web-studio"] }, gates: {} }, roles }),
    provisionChild: async (id: string, _cfg: ProvisionConfig) => {
      provisioned.push(id);
      return row({ id, state: "running" });
    },
    resolveBrief: async () => ({ ok: false, status: 500, message: "unused" }),
    notifyMaestro: async () => {},
    maxStudios: DEFAULT_MAX_STUDIOS,
    claimStudioId: async () => null,
    claimStopped: async () => async () => {},
    now: () => NOW,
  };
}

const RESUME = { role: "web-studio", instance: 5, resume: true };

describe("runResume — parked, not destroyed", () => {
  it("resumes a PARKED studio past the cooldown", async () => {
    const provisioned: string[] = [];
    const res = await runResume(deps([row()], provisioned), MAESTRO, RESUME);
    expect(res.status).toBe(200);
    expect(provisioned).toEqual(["websites--web-studio--5"]);
  });

  it("403s a studio the operator destroyed (parked: false) and starts nothing", async () => {
    const provisioned: string[] = [];
    const res = await runResume(deps([row({ parked: false })], provisioned), MAESTRO, RESUME);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("destroyed by the operator");
    expect(provisioned).toEqual([]);
  });

  it("403s a legacy stopped row with no park marker at all — absent is not parked", async () => {
    const provisioned: string[] = [];
    const legacy = row();
    delete legacy.parked;
    const res = await runResume(deps([legacy], provisioned), MAESTRO, RESUME);
    expect(res.status).toBe(403);
    expect(provisioned).toEqual([]);
  });

  it("409s inside the cooldown and names when it opens", async () => {
    const provisioned: string[] = [];
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const res = await runResume(deps([row({ stoppedAt: recent })], provisioned), MAESTRO, RESUME);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("cooldown");
    expect(provisioned).toEqual([]);
  });

  it("409s a parked row with no stop time — the cooldown cannot be proven over", async () => {
    const provisioned: string[] = [];
    const res = await runResume(deps([row({ stoppedAt: null })], provisioned), MAESTRO, RESUME);
    expect(res.status).toBe(409);
    expect(provisioned).toEqual([]);
  });

  // Merge with main (#81): the cap counts LIVE studios, so a stopped row is
  // free — and a resume makes it live again. A studio's resume respects the
  // cap; only the operator's own provision may heal past it.
  it("409s at capacity: a resume would add a live studio past the cap", async () => {
    const provisioned: string[] = [];
    const live = Array.from({ length: 3 }, (_, i) => row({ id: `websites--filler-${i}`, state: "running" }));
    const d = deps([row(), ...live], provisioned);
    d.maxStudios = 3;
    const res = await runResume(d, MAESTRO, RESUME);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("capacity");
    expect(provisioned).toEqual([]);
  });

  it("400s a role fleet.json no longer declares, even with an edge", async () => {
    const provisioned: string[] = [];
    const res = await runResume(deps([row()], provisioned, ["maestro"]), MAESTRO, RESUME);
    expect(res.status).toBe(400);
    expect(provisioned).toEqual([]);
  });
});

// --- destroy records the marker ------------------------------------------

function syncDeps(): SessionSyncDeps {
  return {
    exec: async (cmd: string) => cmd.startsWith("mkdir -p")
      ? { code: 0, stdout: "0\n1758067200", stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
    r2Put: async () => {}, r2List: async () => [], r2Delete: async () => {},
    now: () => NOW, notify: async () => {}, burnAlertThresholdTokens: 0,
  } as unknown as SessionSyncDeps;
}

function storage(): StudioStorage & SessionSyncStorage {
  const map = new Map<string, unknown>();
  return {
    get: (async (k: string) => map.get(k)) as never,
    put: (async (k: string, v: unknown) => { map.set(k, v); }) as never,
    delete: (async (k: string) => map.delete(k)) as never,
  } as StudioStorage & SessionSyncStorage;
}

describe("destroyWithSync — the stopped row says whether the operator parked it", () => {
  const notRunning = { containerRunning: () => false };

  it("a plain destroy records parked: false and the stop time", async () => {
    const s = storage();
    const result = await destroyWithSync(syncDeps(), s, "websites--web-studio--5", async () => {}, async () => {},
      "websites", async () => "x/y", async () => {}, notRunning);
    expect(result.state).toBe("stopped");
    expect(result.parked).toBe(false);
    expect(result.stoppedAt).toBe(NOW.toISOString());
  });

  it("a parked destroy records parked: true", async () => {
    const s = storage();
    const result = await destroyWithSync(syncDeps(), s, "websites--web-studio--5", async () => {}, async () => {},
      "websites", async () => "x/y", async () => {}, notRunning, undefined, true);
    expect(result.parked).toBe(true);
    expect(((await s.get(STATUS_KEY)) as StudioStatus).parked).toBe(true);
  });

  it("a plain destroy CLEARS an earlier park — a resumed-then-destroyed studio is not resumable", async () => {
    const s = storage();
    await s.put(STATUS_KEY, row({ state: "running", parked: true }));
    const result = await destroyWithSync(syncDeps(), s, "websites--web-studio--5", async () => {}, async () => {},
      "websites", async () => "x/y", async () => {}, notRunning);
    expect(result.parked).toBe(false);
  });
});

describe("the operator's park lever", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POST /studio/:id/destroy?park=true reaches the DO with park", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const destroyStudio = vi.fn(async () => ({ ok: true as const, status: row() }));
    const testEnv = { ...env, STUDIO: { idFromName: (n: string) => n, get: () => ({ destroyStudio }) } } as unknown as Env;
    const res = await handleStudio(new Request("https://x/studio/websites--web-studio--5/destroy?park=true", {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": "t" },
    }), testEnv);
    expect(res.status).toBe(200);
    expect(destroyStudio).toHaveBeenLastCalledWith(false, false, true);
  });

  it("`fleet destroy <id> --park` parses, and rides ?park=true", () => {
    expect(parseCliArgs(["destroy", "websites--web-studio--5", "--park"])).toEqual({
      cmd: "destroy", id: "websites--web-studio--5", force: false, discardUnsynced: false, park: true,
    });
    expect(destroyPath(false, false, true)).toBe("/destroy?park=true");
    expect(destroyPath(true, false, true)).toBe("/destroy?force=true&park=true");
  });
});
