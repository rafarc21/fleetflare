import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runSpawn, type SpawnDeps, type SpawnParent } from "../src/studio/spawn";
import { spawnDeps } from "../src/studio/routes";
import { listStudios, recordStudio } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";

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
});
