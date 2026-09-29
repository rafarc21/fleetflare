import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleFleetSpawn, type BlueprintFetch } from "../src/studio/routes";
import {
  runResume, DEFAULT_MAX_STUDIOS, SPAWN_TOKEN_HEADER, type SpawnDeps, type SpawnParent,
} from "../src/studio/spawn";
import {
  hashSpawnToken, mintSpawnToken, __resetOrgCacheForTests, __resetFleetJsonCacheForTests,
} from "../src/studio/org";
import { recordStudio } from "../src/studio/registry";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";
import type { Env } from "../src/env";

// Issue #59: a studio resumes a STOPPED instance under its own org-chart
// edges. Same gate as spawn (maySpawn over ROLES), same provision path
// (the StudioDO's own provision()) — never a second way to start a container.

const REPO_SLUG = "example-org/websites";
const MAESTRO: SpawnParent = { id: "websites--maestro", repo: "websites", role: "maestro", repoSlug: REPO_SLUG };

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--web-studio--5", state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: "operator", spawnTokenHash: null, repoSlug: REPO_SLUG,
    ...overrides,
  };
}

function deps(rows: StudioStatus[], provisioned: { id: string; cfg: ProvisionConfig }[] = []): SpawnDeps {
  return {
    listStudios: async () => rows,
    fetchPolicy: async () => ({
      org: { edges: { maestro: ["web-studio"], pilot: ["scratch"] }, gates: {} },
      roles: ["maestro", "web-studio", "pilot", "scratch", "release-studio"],
    }),
    provisionChild: async (id, cfg) => {
      provisioned.push({ id, cfg });
      return status({ id, state: "running" });
    },
    resolveBrief: async () => ({ ok: false, status: 500, message: "unused" }),
    notifyMaestro: async () => {},
    maxStudios: DEFAULT_MAX_STUDIOS,
    claimStudioId: async () => null,
  };
}

describe("runResume — the org-chart gate", () => {
  it("resumes a stopped instance of an edged role through provisionChild", async () => {
    const provisioned: { id: string; cfg: ProvisionConfig }[] = [];
    const res = await runResume(deps([status()], provisioned), MAESTRO, { role: "web-studio", instance: 5 });
    expect(res.status).toBe(200);
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0].id).toBe("websites--web-studio--5");
    expect(provisioned[0].cfg).toMatchObject({ repo: "websites", role: "web-studio", instance: 5, repoSlug: REPO_SLUG });
    // A resume does not re-parent the studio: spawnedBy stays whatever the
    // original spawn recorded.
    expect(provisioned[0].cfg.spawnedBy).toBeUndefined();
  });

  it("instance 1 addresses the bare id, and omits `instance` from the config", async () => {
    const provisioned: { id: string; cfg: ProvisionConfig }[] = [];
    const res = await runResume(deps([status({ id: "websites--web-studio" })], provisioned), MAESTRO, { role: "web-studio" });
    expect(res.status).toBe(200);
    expect(provisioned[0].id).toBe("websites--web-studio");
    expect("instance" in provisioned[0].cfg).toBe(false);
  });

  it("403s a role outside the caller's edges and provisions nothing", async () => {
    const provisioned: { id: string; cfg: ProvisionConfig }[] = [];
    const rows = [status({ id: "websites--pilot--5" })];
    const res = await runResume(deps(rows, provisioned), MAESTRO, { role: "pilot", instance: 5 });
    expect(res.status).toBe(403);
    expect(provisioned).toEqual([]);
  });

  it("403 is decided before existence — a caller with no edge learns nothing about which studios exist", async () => {
    const res = await runResume(deps([]), MAESTRO, { role: "pilot", instance: 9 });
    expect(res.status).toBe(403);
  });

  it("400s a compound id smuggled into the role field (another repo's studio)", async () => {
    const provisioned: { id: string; cfg: ProvisionConfig }[] = [];
    const rows = [status({ id: "otherrepo--web-studio--5" })];
    for (const role of ["otherrepo--web-studio", "web-studio--5", "otherrepo--web-studio--5"]) {
      const res = await runResume(deps(rows, provisioned), MAESTRO, { role, instance: 5 });
      expect(res.status).toBe(400);
    }
    expect(provisioned).toEqual([]);
  });

  it('400s instance "next" — a resume names the studio it wakes', async () => {
    const res = await runResume(deps([status()]), MAESTRO, { role: "web-studio", instance: "next" });
    expect(res.status).toBe(400);
  });

  it("404s an instance that does not exist — resume never creates", async () => {
    const provisioned: { id: string; cfg: ProvisionConfig }[] = [];
    const res = await runResume(deps([], provisioned), MAESTRO, { role: "web-studio", instance: 5 });
    expect(res.status).toBe(404);
    expect(provisioned).toEqual([]);
  });

  it("409s an instance that is not stopped — a live lead is never re-provisioned from under it", async () => {
    for (const state of ["running", "provisioning", "degraded"] as const) {
      const provisioned: { id: string; cfg: ProvisionConfig }[] = [];
      const res = await runResume(deps([status({ state })], provisioned), MAESTRO, { role: "web-studio", instance: 5 });
      expect(res.status).toBe(409);
      expect(provisioned).toEqual([]);
    }
  });

  it("403s an instance bound to a different work repo than the caller", async () => {
    const provisioned: { id: string; cfg: ProvisionConfig }[] = [];
    const rows = [status({ repoSlug: "example-org/other" })];
    const res = await runResume(deps(rows, provisioned), MAESTRO, { role: "web-studio", instance: 5 });
    expect(res.status).toBe(403);
    expect(provisioned).toEqual([]);
  });

  it("503s when the org chart cannot be read — never a silent allow", async () => {
    const d = deps([status()]);
    d.fetchPolicy = async () => { throw new Error("github down"); };
    const res = await runResume(d, MAESTRO, { role: "web-studio", instance: 5 });
    expect(res.status).toBe(503);
  });
});

// --- the route: /fleet/spawn {resume: true} ---------------------------------

const FLEET_JSON = JSON.stringify({
  blueprint: { repo: REPO_SLUG, ref: "v1.0.0" },
  roles: ["maestro", "web-studio", "pilot"],
  instance_type: "standard-2",
});
const ORG_JSON = JSON.stringify({ edges: { maestro: ["web-studio"] }, gates: {} });
const fetchFile: BlueprintFetch = async (_repo, path) => (path.endsWith("fleet.json") ? FLEET_JSON : ORG_JSON);

function fakeNamespace() {
  const provisioned: { id: string; cfg: ProvisionConfig }[] = [];
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      provision: async (cfg: ProvisionConfig) => {
        provisioned.push({ id: id as unknown as string, cfg });
        return status({ id: id as unknown as string, state: "running" });
      },
      wakeStudio: async () => ({ woke: false }),
    }) as unknown as ReturnType<Env["STUDIO"]["get"]>,
    provisioned,
  };
}

async function register(id: string, overrides: Partial<StudioStatus> = {}): Promise<string> {
  const token = mintSpawnToken();
  await recordStudio(env, status({ id, state: "running", spawnTokenHash: await hashSpawnToken(token), ...overrides }));
  return token;
}

function post(body: unknown, token: string) {
  return new Request("https://x/fleet/spawn", {
    method: "POST", body: JSON.stringify(body), headers: { [SPAWN_TOKEN_HEADER]: token },
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  __resetOrgCacheForTests();
  __resetFleetJsonCacheForTests();
  vi.restoreAllMocks();
});

describe("POST /fleet/spawn {resume: true}", () => {
  it("resumes a stopped, edged instance through the DO's own provision()", async () => {
    const token = await register("websites--maestro");
    await recordStudio(env, status());
    const ns = fakeNamespace();
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    const res = await handleFleetSpawn(post({ role: "web-studio", instance: 5, resume: true }, token), testEnv, fetchFile);
    expect(res.status).toBe(200);
    expect(ns.provisioned.map((p) => p.id)).toEqual(["websites--web-studio--5"]);
  });

  it("403s a non-edge resume at the route and touches no DO", async () => {
    const token = await register("websites--maestro");
    await recordStudio(env, status({ id: "websites--pilot--5" }));
    const ns = fakeNamespace();
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    const res = await handleFleetSpawn(post({ role: "pilot", instance: 5, resume: true }, token), testEnv, fetchFile);
    expect(res.status).toBe(403);
    expect(ns.provisioned).toEqual([]);
  });

  it("an old binary's body (no resume field) is still an ordinary spawn: 409 on an existing id", async () => {
    const token = await register("websites--maestro");
    await recordStudio(env, status());
    const ns = fakeNamespace();
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    const res = await handleFleetSpawn(post({ role: "web-studio", instance: 5 }, token), testEnv, fetchFile);
    expect(res.status).toBe(409);
    expect(ns.provisioned).toEqual([]);
  });

  it("an old binary's bare `{role}` spawn is unchanged: 200 for a fresh edged role", async () => {
    const token = await register("websites--maestro");
    const ns = fakeNamespace();
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    const res = await handleFleetSpawn(post({ role: "web-studio" }, token), testEnv, fetchFile);
    expect(res.status).toBe(200);
    expect(ns.provisioned.map((p) => p.id)).toEqual(["websites--web-studio"]);
  });
});
