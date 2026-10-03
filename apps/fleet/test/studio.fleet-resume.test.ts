import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleFleetSpawn, type BlueprintFetch } from "../src/studio/routes";
import {
  runResume, DEFAULT_MAX_STUDIOS, SPAWN_TOKEN_HEADER, type ResumeDeps, type SpawnParent,
} from "../src/studio/spawn";
import {
  hashSpawnToken, mintSpawnToken, __resetOrgCacheForTests, __resetFleetJsonCacheForTests,
} from "../src/studio/org";
import { recordStudio } from "../src/studio/registry";
import { LaunchRefusedError, StartRefusedError } from "../src/studio/do";
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
    // Review round 1: only an operator-PARKED studio, stopped past the
    // cooldown, is resumable (test/studio.resume-guards.test.ts).
    parked: true, stoppedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function deps(rows: StudioStatus[], provisioned: { id: string; cfg: ProvisionConfig }[] = []): ResumeDeps {
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
    claimStopped: async () => async () => {},
    now: () => new Date("2026-09-29T12:00:00.000Z"),
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
    // Said in words: without the explicit refusal it still 400s ("bad
    // instance"), but the caller would not learn why.
    expect(await res.text()).toContain('never "next"');
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

// Review round 1 (M1): the registry row reads `stopped` for the whole
// multi-minute provision, so two resumes (a lead retrying a timed-out call)
// both passed the state check and started two bring-ups. The claim flips
// stopped -> provisioning atomically in D1: one winner, the other a 409.
describe("POST /fleet/spawn {resume: true} — one resume at a time", () => {
  it("two concurrent resumes of one stopped studio: exactly one provision, the other 409", async () => {
    const token = await register("websites--maestro");
    await recordStudio(env, status());
    const provisioned: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ns = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: (id: DurableObjectId) => ({
        provision: async () => {
          provisioned.push(id as unknown as string);
          await gate;
          return status({ id: id as unknown as string, state: "running" });
        },
      }) as unknown as ReturnType<Env["STUDIO"]["get"]>,
    };
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    const body = { role: "web-studio", instance: 5, resume: true };
    const first = handleFleetSpawn(post(body, token), testEnv, fetchFile);
    const second = handleFleetSpawn(post(body, token), testEnv, fetchFile);
    // Let both reach the claim before either provision can finish.
    await new Promise((r) => setTimeout(r, 50));
    release();
    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(provisioned).toEqual(["websites--web-studio--5"]);
  });

  it("a provision that throws releases the claim: the studio reads stopped again", async () => {
    const token = await register("websites--maestro");
    await recordStudio(env, status());
    const ns = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({ provision: async () => { throw new Error("container refused"); } }) as unknown as ReturnType<Env["STUDIO"]["get"]>,
    };
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    await expect(handleFleetSpawn(post({ role: "web-studio", instance: 5, resume: true }, token), testEnv, fetchFile))
      .rejects.toThrow("container refused");
    const row = await env.DB.prepare("SELECT value FROM fleet_state WHERE key LIKE '%websites--web-studio--5'")
      .first<{ value: string }>();
    expect(JSON.parse(row!.value).state).toBe("stopped");
  });

  // Issue #217 review round 2: the DO stub's `provision` above is the SAME
  // `stub.provision(cfg)` RPC call routes.ts's own POST /studio/:id/provision
  // already catches LaunchRefusedError/StartRefusedError for — reached here
  // via /fleet/spawn's `{resume: true}` body instead. The test just above
  // still pins the bare-rethrow behaviour for an ORDINARY error (a genuine
  // container failure must keep surfacing uncaught, not get silently turned
  // into a 409/500). A LaunchRefusedError/StartRefusedError is a known, NAMED
  // refusal, never a transport failure, and must become the same 409
  // `{error}` body instead of an uncaught throw — while the claim's own
  // cleanup (the stopped -> provisioning flip reverting) still runs exactly
  // as it does for the ordinary-error case above. Real class, `remote: true`
  // tag — same RPC-crossing convention as studio.routes.test.ts's own #217
  // suite, never a hand-typed already-prefixed string.
  it("a LaunchRefusedError is a 409, not an uncaught throw — and the claim is released (studio resumable again)", async () => {
    const token = await register("websites--maestro");
    await recordStudio(env, status());
    const ns = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({
        provision: async () => {
          throw Object.assign(new LaunchRefusedError("every account fleet-wide limited"), { remote: true });
        },
      }) as unknown as ReturnType<Env["STUDIO"]["get"]>,
    };
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    const res = await handleFleetSpawn(post({ role: "web-studio", instance: 5, resume: true }, token), testEnv, fetchFile);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("every account fleet-wide limited");
    const row = await env.DB.prepare("SELECT value FROM fleet_state WHERE key LIKE '%websites--web-studio--5'")
      .first<{ value: string }>();
    expect(JSON.parse(row!.value).state).toBe("stopped");
  });

  it("a StartRefusedError is also a 409, not an uncaught throw — and the claim is released", async () => {
    const token = await register("websites--maestro");
    await recordStudio(env, status());
    const ns = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({
        provision: async () => {
          throw Object.assign(new StartRefusedError("studio websites--web-studio--5 is stopped"), { remote: true });
        },
      }) as unknown as ReturnType<Env["STUDIO"]["get"]>,
    };
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    const res = await handleFleetSpawn(post({ role: "web-studio", instance: 5, resume: true }, token), testEnv, fetchFile);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("is stopped");
    const row = await env.DB.prepare("SELECT value FROM fleet_state WHERE key LIKE '%websites--web-studio--5'")
      .first<{ value: string }>();
    expect(JSON.parse(row!.value).state).toBe("stopped");
  });
});

// Review round 1 (M2): identity is the TOKEN's, never the body's. A studio
// with no edges claiming to be the maestro in any identity-shaped field is
// still itself.
describe("POST /fleet/spawn {resume: true} — identity never comes from the body", () => {
  it("a web-studio token claiming maestro in the body is refused 403", async () => {
    await register("websites--maestro");
    const token = await register("websites--web-studio");
    await recordStudio(env, status());
    const ns = fakeNamespace();
    const testEnv = { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
    const body = {
      role: "web-studio", instance: 5, resume: true,
      caller: "websites--maestro", parent: "websites--maestro", spawnedBy: "websites--maestro",
      sender: "websites--maestro", studio: "websites--maestro", id: "websites--maestro",
    };
    const res = await handleFleetSpawn(post(body, token), testEnv, fetchFile);
    expect(res.status).toBe(403);
    expect(ns.provisioned).toEqual([]);
  });
});
