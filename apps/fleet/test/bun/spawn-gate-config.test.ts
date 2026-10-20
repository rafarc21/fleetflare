// #1247 (refs #1132): a gated repo must have a valid default-branch gate
// block before a studio spawns into it — the old silent skip let a studio run
// where no PR could ever go green. Pure surface only: no Worker binding, no
// DO, no registry — runSpawn is exercised over a hand-built SpawnDeps, the
// same shape the vitest spawn suites use.
import { describe, it, expect } from "bun:test";
import {
  runSpawn, spawnGateConfigRefusal, type SpawnDeps, type SpawnParent,
} from "../../src/studio/spawn";
import type { GateConfig } from "../../src/gate/config";
import type { StudioStatus } from "../../src/studio/types";

const PARENT: SpawnParent = {
  id: "websites--pilot", repo: "websites", role: "pilot", repoSlug: "acme/websites",
};

const status = (id: string): StudioStatus => ({
  id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
  lastRefreshError: null, burn: null, spawnedBy: "websites--pilot", spawnTokenHash: null, repoSlug: "acme/websites",
});

/** A fake SpawnDeps mirroring the vitest spawn fixtures. `over` supplies the
 *  two #1247 ports (and anything else a test wants); provisionChild records
 *  that it ran so a refusal can be proven to have never reached it. */
function deps(over: Partial<SpawnDeps> = {}) {
  let provisioned = false;
  const gateCalls: string[] = [];
  const innerGateBlock = over.gateBlock;
  const d = {
    listStudios: async () => [] as StudioStatus[],
    fetchPolicy: async () => ({ org: { edges: { pilot: ["release"] }, gates: {} }, roles: ["pilot", "release"] }),
    provisionChild: async (childId: string) => {
      provisioned = true;
      return status(childId);
    },
    resolveBrief: async () => ({ ok: true as const, value: "brief" }),
    notifyMaestro: async () => {},
    maxStudios: 100,
    claimStudioId: async () => async () => {},
    assignModel: async () => {},
    ...over,
    // The recording wrapper is always the final gateBlock: `over.gateBlock` is
    // captured above and delegated to, so every invocation is observable.
    gateBlock: async (repoSlug: string) => {
      gateCalls.push(repoSlug);
      return innerGateBlock ? innerGateBlock(repoSlug) : null;
    },
  } as SpawnDeps;
  return { d, provisioned: () => provisioned, gateCalls };
}

const VALID_GATE: GateConfig = {
  install: "x",
  legs: [],
  pathRules: ["a/**"],
  vitestShards: 8,
  bunShards: 6,
};

describe("spawnGateConfigRefusal", () => {
  it("is a 400 naming the gated repo, 'gated', and 'gate block'", async () => {
    const res = spawnGateConfigRefusal("acme/websites");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("acme/websites");
    expect(text).toContain("gated");
    expect(text).toContain("gate block");
    expect(text).toContain("GATE_RUNNER_REPOS");
  });
});

describe("runSpawn — gated repo gate-config guard (#1247)", () => {
  it("A: a gated repo with no valid gate block 400s, and provisionChild is NOT called", async () => {
    const { d, provisioned, gateCalls } = deps({
      gatedRepos: ["acme/websites"],
      gateBlock: async () => null,
    });
    const res = await runSpawn(d, PARENT, { role: "release" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("gate block");
    expect(provisioned()).toBe(false);
    expect(gateCalls).toEqual(["acme/websites"]);
  });

  it("B: a gated repo with a valid gate block spawns (200) and provisions", async () => {
    const { d, provisioned, gateCalls } = deps({
      gatedRepos: ["acme/websites"],
      gateBlock: async () => VALID_GATE,
    });
    const res = await runSpawn(d, PARENT, { role: "release" });
    expect(res.status).toBe(200);
    expect(provisioned()).toBe(true);
    expect(gateCalls).toEqual(["acme/websites"]);
  });

  it("C: a repo NOT in gatedRepos spawns, and gateBlock is never invoked", async () => {
    const { d, provisioned, gateCalls } = deps({
      gatedRepos: ["other/repo"],
      gateBlock: async () => {
        throw new Error("gateBlock must not be called for a non-gated repo");
      },
    });
    const res = await runSpawn(d, PARENT, { role: "release" });
    expect(res.status).toBe(200);
    expect(provisioned()).toBe(true);
    expect(gateCalls).toEqual([]);
  });

  it("D: no gatedRepos (undefined) spawns, and gateBlock is never invoked", async () => {
    const { d, provisioned, gateCalls } = deps({
      gateBlock: async () => {
        throw new Error("gateBlock must not be called when gatedRepos is absent");
      },
    });
    delete d.gatedRepos;
    const res = await runSpawn(d, PARENT, { role: "release" });
    expect(res.status).toBe(200);
    expect(provisioned()).toBe(true);
    expect(gateCalls).toEqual([]);
  });

  it("a gated repo with no repoSlug on the parent is not checked (spawns)", async () => {
    const { d, gateCalls } = deps({
      gatedRepos: ["acme/websites"],
      gateBlock: async () => {
        throw new Error("gateBlock must not be called when the parent has no repoSlug");
      },
    });
    const noSlug: SpawnParent = { id: "websites--pilot", repo: "websites", role: "pilot" };
    const res = await runSpawn(d, noSlug, { role: "release" });
    expect(res.status).toBe(200);
    expect(gateCalls).toEqual([]);
  });

  it("a gated repo's gate check runs AFTER the org-edge gate: a non-edged role 403s with no gateBlock call", async () => {
    const { d, gateCalls } = deps({
      gatedRepos: ["acme/websites"],
      gateBlock: async () => {
        throw new Error("gateBlock must not be called for a request the org chart already refused");
      },
    });
    const res = await runSpawn(d, PARENT, { role: "cto" });
    expect(res.status).toBe(403);
    expect(gateCalls).toEqual([]);
  });
});