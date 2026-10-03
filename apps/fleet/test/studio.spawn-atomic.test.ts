import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runSpawn, type SpawnDeps, type SpawnParent } from "../src/studio/spawn";
import { spawnDeps } from "../src/studio/routes";
import { listStudios, recordStudio, getStudioRow } from "../src/studio/registry";
import { LaunchRefusedError, StartRefusedError } from "../src/studio/do";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// ---------------------------------------------------------------------------
// Issue #296 — `instance: "next"` was read-then-create: two concurrent spawns
// read the same registry, both allocated `--2`, and the (idempotent) DO
// provision put two tasks on ONE lead. The #281 test's fake allocated
// atomically and hid it. These run the REAL spawn wiring (routes.ts's
// spawnDeps: the D1 registry read AND the D1 claim) against miniflare's D1,
// twice in parallel; only the org policy, the DO provision and the maestro
// wake are faked, since no container runs here.
// ---------------------------------------------------------------------------

const PARENT: SpawnParent = { id: "websites--pilot", repo: "websites", role: "pilot" };

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--release", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

/** One request's deps: the real registry + claim, a provision that takes a
 *  moment (a real one takes minutes) and then records the row like the DO. */
function realDeps(over: Partial<SpawnDeps> = {}): SpawnDeps {
  return {
    ...spawnDeps(env, async () => { throw new Error("no blueprint fetch in this test"); }, async () => ({ ok: true as const, value: "" })),
    fetchPolicy: async () => ({ org: { edges: { pilot: ["release"] }, gates: {} }, roles: ["pilot", "release"] }),
    provisionChild: async (childId: string) => {
      await new Promise((r) => setTimeout(r, 20));
      const row = status({ id: childId, state: "running" });
      await recordStudio(env, row);
      return row;
    },
    notifyMaestro: async () => {},
    ...over,
  };
}

const idOf = async (res: Response) => ((await res.json()) as StudioStatus).id;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await recordStudio(env, status({ id: "websites--release" }));
});

describe('runSpawn — instance allocation is atomic (#296)', () => {
  it('two concurrent `"next"` spawns get two DISTINCT instances', async () => {
    const [a, b] = await Promise.all([
      runSpawn(realDeps(), PARENT, { role: "release", instance: "next" }),
      runSpawn(realDeps(), PARENT, { role: "release", instance: "next" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ids = [await idOf(a), await idOf(b)].sort();
    expect(ids).toEqual(["websites--release--2", "websites--release--3"]);
    expect((await listStudios(env)).map((r) => r.id).sort())
      .toEqual(["websites--release", "websites--release--2", "websites--release--3"]);
  });

  it("two concurrent spawns of the SAME explicit instance: one wins, one 409s", async () => {
    const [a, b] = await Promise.all([
      runSpawn(realDeps(), PARENT, { role: "release", instance: 2 }),
      runSpawn(realDeps(), PARENT, { role: "release", instance: 2 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("a spawn refused after the claim (its task is not the child's) releases the id", async () => {
    const res = await runSpawn(
      realDeps({ resolveBrief: async () => ({ ok: false as const, status: 409, message: "task is not assigned to this studio" }) }),
      PARENT, { role: "release", instance: "next", task: 7 },
    );
    expect(res.status).toBe(409);
    expect((await listStudios(env)).map((r) => r.id)).toEqual(["websites--release"]);
  });

  it("a provision that throws releases the id it claimed", async () => {
    await expect(runSpawn(
      realDeps({ provisionChild: async () => { throw new Error("container would not start"); } }),
      PARENT, { role: "release", instance: "next" },
    )).rejects.toThrow("container would not start");
    expect((await listStudios(env)).map((r) => r.id)).toEqual(["websites--release"]);
  });

  // Issue #217 review round 2: provisionChild (realDeps above) is the SAME
  // `stub.provision(cfg)` RPC call routes.ts's own POST /studio/:id/provision
  // already catches this refusal for — reached here via /fleet/spawn instead.
  // Before this fix, runSpawn's catch bare-rethrew every provisionChild
  // failure alike (the test just above still pins that behaviour for an
  // ORDINARY error — a genuine container failure must still propagate so the
  // caller sees it, not a silent 500/409 substitute). A LaunchRefusedError/
  // StartRefusedError is a known, NAMED refusal, not a transport failure, and
  // must become the same 409 `{error}` body routes.ts's provision/restart
  // already answer with — a real throw crossing the RPC boundary
  // (`Object.assign(<real class instance>, { remote: true })`, same
  // convention as studio.routes.test.ts's own #217 suite), never a
  // hand-typed already-prefixed string.
  it("a LaunchRefusedError from provisionChild is a 409 (not an uncaught throw), and the claimed id is released", async () => {
    const res = await runSpawn(
      realDeps({
        provisionChild: async () => {
          throw Object.assign(new Error(new LaunchRefusedError("every account fleet-wide limited").message), { remote: true });
        },
      }),
      PARENT, { role: "release", instance: "next" },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("every account fleet-wide limited");
    // Cleanup still ran: the claimed id is free again, not stuck.
    expect((await listStudios(env)).map((r) => r.id)).toEqual(["websites--release"]);
  });

  it("a StartRefusedError from provisionChild is also a 409, and the claimed id is released", async () => {
    const res = await runSpawn(
      realDeps({
        provisionChild: async () => {
          throw Object.assign(new Error(new StartRefusedError("studio websites--release--2 is stopped").message), { remote: true });
        },
      }),
      PARENT, { role: "release", instance: "next" },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("is stopped");
    expect((await listStudios(env)).map((r) => r.id)).toEqual(["websites--release"]);
  });
});

// ---------------------------------------------------------------------------
// Issue #107 follow-up — the claim placeholder itself must already carry the
// requested role's doClass. Between claimStudioId's write and
// provisionChild's own DO-recorded write there is a real window (a project
// card fetch, DO dispatch, ensureSpawnToken's own write) during which ANY
// other reader hitting getStudioRow/getStudioStub for this exact id would
// see the placeholder — a `release-studio` (BIG_PROFILE_ROLES) child with no
// doClass reads as the default STUDIO namespace, misrouting to a DO that was
// never provisioned. Captured here by reading the row back from inside a
// provisionChild fake, BEFORE it does anything of its own — that read sees
// exactly what claimStudioId wrote and nothing claimStudioId's caller added
// after the fact.
// ---------------------------------------------------------------------------
describe("runSpawn — the claim placeholder carries the requested role's doClass (#107)", () => {
  it('a "release-studio" child\'s CLAIMED placeholder is already STUDIO_BIG, before provisionChild runs', async () => {
    let placeholderDoClassAtProvisionStart: string | undefined;
    const res = await runSpawn(
      realDeps({
        fetchPolicy: async () => ({ org: { edges: { pilot: ["release-studio"] }, gates: {} }, roles: ["pilot", "release-studio"] }),
        provisionChild: async (childId: string) => {
          placeholderDoClassAtProvisionStart = (await getStudioRow(env, childId))?.doClass;
          const row = status({ id: childId, state: "running" });
          await recordStudio(env, row);
          return row;
        },
      }),
      PARENT, { role: "release-studio", instance: "next" },
    );
    expect(res.status).toBe(200);
    expect(placeholderDoClassAtProvisionStart).toBe("STUDIO_BIG");
  });

  // Issue #107 fix-first round 2 — the critical regression: a real deploy
  // window where this code is live but env.STUDIO_BIG itself is not yet
  // bound (the container/ change ships in a separate, batched rollout — see
  // the issue's own body). The claim placeholder must NEVER stamp
  // "STUDIO_BIG" purely from role in that window — doing so would write a
  // lie into the row that a later read, once the binding finally exists,
  // would believe and misroute to a brand-new, empty STUDIO_BIG DO.
  it('a "release-studio" child\'s CLAIMED placeholder is STUDIO, never STUDIO_BIG, when env.STUDIO_BIG is undefined', async () => {
    const envWithoutBig = { ...env, STUDIO_BIG: undefined } as unknown as Env;
    let placeholderDoClassAtProvisionStart: string | undefined;
    const res = await runSpawn(
      {
        ...spawnDeps(envWithoutBig, async () => { throw new Error("no blueprint fetch in this test"); }, async () => ({ ok: true as const, value: "" })),
        fetchPolicy: async () => ({ org: { edges: { pilot: ["release-studio"] }, gates: {} }, roles: ["pilot", "release-studio"] }),
        provisionChild: async (childId: string) => {
          placeholderDoClassAtProvisionStart = (await getStudioRow(env, childId))?.doClass;
          const row = status({ id: childId, state: "running" });
          await recordStudio(env, row);
          return row;
        },
        notifyMaestro: async () => {},
      },
      PARENT, { role: "release-studio", instance: "next" },
    );
    expect(res.status).toBe(200);
    expect(placeholderDoClassAtProvisionStart).toBe("STUDIO");
  });
});
