import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepoReach } from "../src/github/reach";
import { env } from "cloudflare:test";
import worker from "../src/index";
import * as authModule from "../src/studio/auth";
import { handleStudio, handleFleetSpawn, type BlueprintFetch } from "../src/studio/routes";
import {
  resolveSpawnParent, isSpawnTokenShaped, resolveSpawnPolicy, runSpawn,
  resolveMaxStudios, DEFAULT_MAX_STUDIOS, readInstanceRequest,
  SPAWN_TOKEN_HEADER, OPERATOR_ID as OPERATOR_PARENT_ID, type SpawnDeps, type SpawnParent,
} from "../src/studio/spawn";
import {
  hashSpawnToken, mintSpawnToken, __resetOrgCacheForTests, __resetFleetJsonCacheForTests,
} from "../src/studio/org";
import { ensureSpawnToken, SPAWN_TOKEN_KEY, type SpawnTokenStorage } from "../src/studio/do";
import {
  provisionWithStorage, type ProvisionDeps, type StudioStorage, type RoleEnv,
  type HealAttempt,
  type OperationInFlight,
} from "../src/studio/provision";
import { recordStudio, listStudios } from "../src/studio/registry";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";
import type { Env } from "../src/env";

// P3 Task 2 — /fleet/spawn (machine surface, R-P3-7) and /studio/spawn (the
// operator passthrough). Same testing posture as test/studio.routes.test.ts:
// a live StudioDO cannot be constructed under vitest-pool-workers, so the
// STUDIO binding is a fake namespace whose `provision` calls the REAL
// ensureSpawnToken + provisionWithStorage over an in-memory storage — the
// same two functions do.ts's real provision() method calls, in the same
// order. Everything else on the path (registry reads/writes against real D1,
// org parsing, the org cache, the routes themselves) is the production code.
//
// The ONE injected seam is the blueprint fetch: it is a live GitHub call
// (mintRepoToken + fetchRepoFile) with no test double available, the
// same dependency ProvisionDeps.fetchBlueprintFile already injects for
// provision.

const PARENT_ID = "websites--pilot";
const REPO_SLUG = "acme-org/websites";

const FAKE_FLEET_JSON = JSON.stringify({
  blueprint: { repo: REPO_SLUG, ref: "v1.0.0" },
  roles: ["pilot", "release", "scratch", "cto"],
  instance_type: "standard-2",
});
const FAKE_ROLE_MD = `---
name: release
skills: []
allowedTools: Bash(git *) Edit
may_spawn: []
reports_to: cto
gates: []
---
You are release. Merge carefully.
`;
// The fixture org: pilot may spawn release, and the operator may spawn the
// three roles T3 will add to the real fleet/blueprint/org.json. Until then
// the real file has no `operator` edge at all, and /studio/spawn 403s
// cleanly against it — proven by its own test below.
const FAKE_ORG_JSON = JSON.stringify({
  edges: { pilot: ["release"], operator: ["cto", "pilot", "scratch"] },
  gates: { merge: ["release"] },
});

function fakeBlueprintFetch(overrides: Partial<Record<"fleet" | "org", () => Promise<string>>> = {}) {
  const calls: string[] = [];
  const fetchFile: BlueprintFetch = async (_repo: string, path: string, ref: string) => {
    calls.push(`${path}@${ref}`);
    if (path.endsWith("fleet.json")) return overrides.fleet ? overrides.fleet() : FAKE_FLEET_JSON;
    if (path.endsWith("org.json")) return overrides.org ? overrides.org() : FAKE_ORG_JSON;
    return FAKE_ROLE_MD;
  };
  return { fetchFile, calls };
}

// Same shape as test/studio.routes.test.ts's — one Map behind every key,
// exactly as the real DurableObjectStorage is one keyspace. `| boolean`
// (Task 4, R-P3-6) covers KEEP_ALIVE_KEY.
function fakeStorage(): StudioStorage & SpawnTokenStorage {
  const map = new Map<string, StudioStatus | RoleEnv | string | number | boolean | HealAttempt | OperationInFlight | null>();
  return {
    get: (async (key: string) => map.get(key)) as (StudioStorage & SpawnTokenStorage)["get"],
    put: async (key: string, value: StudioStatus | RoleEnv | string | number | boolean | HealAttempt | OperationInFlight | null) => {
      map.set(key, value);
    },
  };
}

/** A STUDIO namespace whose stubs are keyed by studio id — a spawn
 *  provisions a DIFFERENT id from the parent's, so one shared storage (as in
 *  test/studio.routes.test.ts, which only ever touches one studio) would not
 *  do. */
function fakeStudioNamespace() {
  const storages = new Map<string, StudioStorage & SpawnTokenStorage>();
  const provisioned: ProvisionConfig[] = [];
  const deps: ProvisionDeps = {
    sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
    now: () => "2026-08-17T00:00:00.000Z",
    fetchBlueprintFile: async (_repo: string, path: string) =>
      path.endsWith("fleet.json") ? FAKE_FLEET_JSON : path.endsWith("org.json") ? FAKE_ORG_JSON : FAKE_ROLE_MD,
  };
  function storageFor(id: string): StudioStorage & SpawnTokenStorage {
    let storage = storages.get(id);
    if (!storage) {
      storage = fakeStorage();
      storages.set(id, storage);
    }
    return storage;
  }
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = id as unknown as string;
      const storage = storageFor(name);
      return {
        // Mirrors do.ts's real provision(): ensureSpawnToken (token in DO
        // storage, hash on status + registry, as one early sequence), THEN
        // the long provision work.
        provision: async (cfg: ProvisionConfig) => {
          provisioned.push(cfg);
          await ensureSpawnToken(storage, name, deps.recordStudio);
          return provisionWithStorage(deps, storage, cfg, REPO_SLUG);
        },
      } as unknown as ReturnType<Env["STUDIO"]["get"]>;
    },
    provisioned,
    storageFor,
  };
}

function testEnvWith(ns: ReturnType<typeof fakeStudioNamespace>): Env {
  return { ...env, STUDIO: ns, AGENT_REPO: REPO_SLUG } as unknown as Env;
}

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: PARENT_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

/** Registers a studio row holding only the HASH of a freshly minted token,
 *  exactly as a real provision does, and hands the raw token back to the
 *  test — the only place it ever exists outside a container. */
async function registerStudio(id: string, overrides: Partial<StudioStatus> = {}): Promise<string> {
  const token = mintSpawnToken();
  await recordStudio(env, status({ id, spawnTokenHash: await hashSpawnToken(token), ...overrides }));
  return token;
}

function spawnReq(body: unknown, token?: string, method = "POST", path = "/fleet/spawn") {
  return new Request(`https://x${path}`, {
    method,
    body: method === "POST" ? JSON.stringify(body) : undefined,
    headers: token ? { [SPAWN_TOKEN_HEADER]: token } : {},
  });
}

function authorized() {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  __resetOrgCacheForTests();
  // Fleet Spawn P3, Task 4 (R-P3-3): fleet.json is cached now too (module-
  // level, same as org.json) — without this reset, a fleet.json fetched by
  // an EARLIER test in this file (same REPO_SLUG@main cache key most tests
  // share) would still be within its TTL and get served stale here instead
  // of whatever this test's own fetchFile/override supplies.
  __resetFleetJsonCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});


/** Issue #296: an in-process stand-in for the D1 claim (registry.ts's
 *  claimStudioRow): first caller for an id wins until released. The real,
 *  racing D1 path is test/studio.spawn-atomic.test.ts. */
function memoryClaim(): SpawnDeps["claimStudioId"] {
  const taken = new Set<string>();
  return async (id) => {
    if (taken.has(id)) return null;
    taken.add(id);
    return async () => { taken.delete(id); };
  };
}

describe("isSpawnTokenShaped (pre-hash rejection)", () => {
  it("accepts exactly the mintSpawnToken shape", () => {
    expect(isSpawnTokenShaped(mintSpawnToken())).toBe(true);
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["no fsp_ prefix", "a".repeat(68)],
    ["wrong prefix", `ghs_${"a".repeat(64)}`],
    ["too short", `fsp_${"a".repeat(63)}`],
    ["too long", `fsp_${"a".repeat(65)}`],
    ["uppercase hex", `fsp_${"A".repeat(64)}`],
    ["non-hex body", `fsp_${"z".repeat(64)}`],
    ["trailing whitespace", `fsp_${"a".repeat(64)} `],
  ])("rejects %s", (_label, value) => {
    expect(isSpawnTokenShaped(value)).toBe(false);
  });
});

describe("resolveSpawnParent", () => {
  it("finds the row whose stored hash matches the presented token's digest", async () => {
    const token = mintSpawnToken();
    const rows = [
      status({ id: "websites--other", spawnTokenHash: await hashSpawnToken(mintSpawnToken()) }),
      status({ id: PARENT_ID, spawnTokenHash: await hashSpawnToken(token) }),
    ];
    expect(await resolveSpawnParent(rows, token)).toEqual({ id: PARENT_ID, repo: "websites", role: "pilot" });
  });

  it("returns null for an absent token", async () => {
    expect(await resolveSpawnParent([], null)).toBeNull();
  });

  it("returns null for a well-shaped but unregistered token", async () => {
    const rows = [status({ spawnTokenHash: await hashSpawnToken(mintSpawnToken()) })];
    expect(await resolveSpawnParent(rows, mintSpawnToken())).toBeNull();
  });

  it("rejects a non-fsp_ input BEFORE hashing it — a row storing that input's own digest still does not match", async () => {
    // The whole point of the shape gate: even a registry deliberately holding
    // sha256("bogus") must not authenticate the literal string "bogus",
    // because the route never gets as far as hashing it.
    const rows = [status({ spawnTokenHash: await hashSpawnToken("bogus") })];
    expect(await resolveSpawnParent(rows, "bogus")).toBeNull();
  });

  it("never matches a row with no stored hash (null must not equal anything)", async () => {
    expect(await resolveSpawnParent([status({ spawnTokenHash: null })], mintSpawnToken())).toBeNull();
  });

  it("returns null when the matched row's id is not a parseable <repo>--<role>", async () => {
    const token = mintSpawnToken();
    const rows = [status({ id: "not-an-id", spawnTokenHash: await hashSpawnToken(token) })];
    expect(await resolveSpawnParent(rows, token)).toBeNull();
  });

  it("never matches a legacy row that predates spawnTokenHash (field absent, not null)", async () => {
    const token = mintSpawnToken();
    const legacy = status({ id: PARENT_ID });
    delete (legacy as Partial<StudioStatus>).spawnTokenHash;
    expect(await resolveSpawnParent([legacy], token)).toBeNull();
  });

  // Review round 1, Important 1 — namespace collision. `operator` is a valid
  // id segment, so a studio provisioned as `websites--operator` would parse
  // to role "operator" and inherit the HUMAN's org edges the moment T3 adds
  // `"operator": [...]` to org.json. A machine token must never resolve to
  // the operator literal.
  it("refuses to resolve a studio whose role is the operator literal, even with a valid token", async () => {
    const token = mintSpawnToken();
    const rows = [status({ id: "websites--operator", spawnTokenHash: await hashSpawnToken(token) })];
    expect(await resolveSpawnParent(rows, token)).toBeNull();
  });
});

describe("resolveSpawnPolicy", () => {
  it("reads fleet.json at the default branch, then org.json at fleet.json's OWN pinned ref", async () => {
    const { fetchFile, calls } = fakeBlueprintFetch();
    const policy = await resolveSpawnPolicy(fetchFile, REPO_SLUG);
    expect(policy.org.edges.pilot).toEqual(["release"]);
    expect(calls).toEqual(["fleet.json@main", "fleet/blueprint/org.json@v1.0.0"]);
  });

  it("carries fleet.json's declared roles alongside the org (review round 1, Important 2)", async () => {
    const { fetchFile } = fakeBlueprintFetch();
    expect((await resolveSpawnPolicy(fetchFile, REPO_SLUG)).roles).toEqual(["pilot", "release", "scratch", "cto"]);
  });

  it("serves org.json from the module cache on a second call (no second org fetch)", async () => {
    const { fetchFile, calls } = fakeBlueprintFetch();
    await resolveSpawnPolicy(fetchFile, REPO_SLUG);
    await resolveSpawnPolicy(fetchFile, REPO_SLUG);
    expect(calls.filter((c) => c.startsWith("fleet/blueprint/org.json"))).toHaveLength(1);
  });

  // Fleet Spawn P3, Task 4 (R-P3-3): this used to assert the OPPOSITE — "the
  // roles list is never served from the org cache", i.e. fleet.json was read
  // live on every call, deliberately (see this file's own resolveSpawnPolicy
  // doc comment for the superseded reasoning). It is cached now, through
  // org.ts's fetchFleetJsonCached — the security carry that closes fleet.json's
  // half of the same amplification concern org.json's own cache already
  // closed (Task 2's carry). The quartet of hit/expiry/stale/floor tests for
  // the cache mechanics itself lives in test/studio.org.test.ts, alongside
  // fetchOrgCached's own — this is the ONE integration-level assertion that
  // resolveSpawnPolicy actually goes through it, not a re-implementation of
  // that suite.
  it("serves fleet.json from the module cache on a second call (no second fleet.json fetch)", async () => {
    const { fetchFile, calls } = fakeBlueprintFetch();
    await resolveSpawnPolicy(fetchFile, REPO_SLUG);
    await resolveSpawnPolicy(fetchFile, REPO_SLUG);
    expect(calls.filter((c) => c.startsWith("fleet.json"))).toHaveLength(1);
  });
});

// --- Fleet Spawn P3, Task 4 (R-P3-3): MAX_STUDIOS ---------------------------

describe("resolveMaxStudios", () => {
  it.each([
    ["absent -> default", undefined, DEFAULT_MAX_STUDIOS],
    ["empty string -> default (Number('') is 0, not a positive integer)", "", DEFAULT_MAX_STUDIOS],
    ["non-numeric garbage -> default", "banana", DEFAULT_MAX_STUDIOS],
    ["zero -> default (a cap of zero would brick every future spawn)", "0", DEFAULT_MAX_STUDIOS],
    ["negative -> default", "-5", DEFAULT_MAX_STUDIOS],
    ["non-integer -> default", "1.5", DEFAULT_MAX_STUDIOS],
    ["whitespace-only -> default", "   ", DEFAULT_MAX_STUDIOS],
  ] as const)("%s", (_label, raw, expected) => {
    expect(resolveMaxStudios(raw)).toBe(expected);
  });

  it("a valid positive integer is used as-is, not just accepted as 'not garbage'", () => {
    expect(resolveMaxStudios("50")).toBe(50);
    expect(resolveMaxStudios("1")).toBe(1);
  });
});

/** A brief resolver that is never expected to be called — every test above
 *  this point spawns WITHOUT a task, and calling it would mean runSpawn read
 *  the board for a request that named no task at all. */
const noBrief: SpawnDeps["resolveBrief"] = async () => {
  throw new Error("resolveBrief must not be called for a spawn that names no task");
};

describe("runSpawn — MAX_STUDIOS cap (R-P3-3)", () => {
  const CAP_PARENT: SpawnParent = { id: PARENT_ID, repo: "websites", role: "pilot" };

  // "count from registry fake" (brief) — a pure runSpawn call with a fake
  // listStudios returning N synthetic rows, no real D1 writes at all.
  function fillerRows(n: number): StudioStatus[] {
    return Array.from({ length: n }, (_, i) => status({ id: `websites--filler-${i}` }));
  }

  function capDeps(rowCount: number, maxStudios: number, provisionChild?: SpawnDeps["provisionChild"]): SpawnDeps {
    return {
      listStudios: async () => fillerRows(rowCount),
      fetchPolicy: async () => ({
        org: { edges: { pilot: ["release"] }, gates: {} },
        roles: ["pilot", "release"],
      }),
      provisionChild: provisionChild ?? (async (childId: string) => status({ id: childId, state: "running" })),
      resolveBrief: noBrief,
      notifyMaestro: async () => {},
      maxStudios,
      claimStudioId: memoryClaim(),
    };
  }

  it("99 existing studios, cap 100: spawn proceeds", async () => {
    const res = await runSpawn(capDeps(99, DEFAULT_MAX_STUDIOS), CAP_PARENT, { role: "release" });
    expect(res.status).toBe(200);
  });

  it("100 existing studios, cap 100 (AT capacity): spawn 409s with an actionable body, before any provision attempt", async () => {
    let provisioned = false;
    const deps = capDeps(100, DEFAULT_MAX_STUDIOS, async (childId: string) => {
      provisioned = true;
      return status({ id: childId });
    });
    const res = await runSpawn(deps, CAP_PARENT, { role: "release" });
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("100");
    expect(body).toContain("capacity");
    expect(body).toContain("websites--release"); // actionable: names the child that couldn't spawn
    expect(provisioned).toBe(false);
  });

  it("respects a non-default maxStudios from deps, not a hardcoded 100", async () => {
    expect((await runSpawn(capDeps(4, 5), CAP_PARENT, { role: "release" })).status).toBe(200);
    expect((await runSpawn(capDeps(5, 5), CAP_PARENT, { role: "release" })).status).toBe(409);
  });

  it("the cap is checked before the exists-check, but a request that fails both still just 409s", async () => {
    // A child that ALREADY exists, counted among the 100 filler-shaped rows —
    // still 409 either way; this only proves the ordering doesn't crash or
    // somehow let an over-capacity fleet spawn a duplicate through.
    const deps: SpawnDeps = {
      listStudios: async () => [...fillerRows(99), status({ id: "websites--release" })],
      fetchPolicy: async () => ({ org: { edges: { pilot: ["release"] }, gates: {} }, roles: ["pilot", "release"] }),
      provisionChild: async (childId: string) => status({ id: childId }),
      resolveBrief: noBrief,
      notifyMaestro: async () => {},
      maxStudios: DEFAULT_MAX_STUDIOS,
      claimStudioId: memoryClaim(),
    };
    expect((await runSpawn(deps, CAP_PARENT, { role: "release" })).status).toBe(409);
  });
});

// --- Issue #269: multiple studios per role per repo -------------------------
//
// The fleet-WIDE cap above is a different and unrelated limit; nothing in this
// block touches maxStudios, and the last test here proves it still bites at
// exactly 100 however many instances of one role are running.
describe("runSpawn — instance allocation (#269)", () => {
  const PARENT: SpawnParent = { id: PARENT_ID, repo: "websites", role: "pilot" };

  function deps(ids: string[], provisioned?: { repo: string; role: string; instance?: number }[]): SpawnDeps {
    return {
      listStudios: async () => ids.map((id) => status({ id })),
      fetchPolicy: async () => ({
        org: { edges: { pilot: ["release", "web-studio"] }, gates: {} },
        roles: ["pilot", "release", "web-studio"],
      }),
      provisionChild: async (childId: string, cfg) => {
        provisioned?.push({ repo: cfg.repo, role: cfg.role, ...(cfg.instance === undefined ? {} : { instance: cfg.instance }) });
        return status({ id: childId, state: "running" });
      },
      resolveBrief: noBrief,
      notifyMaestro: async () => {},
      maxStudios: DEFAULT_MAX_STUDIOS,
      claimStudioId: memoryClaim(),
    };
  }

  const spawnedId = async (res: Response) => ((await res.json()) as StudioStatus).id;

  describe('instance: "next" — the Worker allocates', () => {
    it("lands on instance 1 when the role has nothing running: the BARE id, no suffix", async () => {
      const res = await runSpawn(deps([]), PARENT, { role: "release", instance: "next" });
      expect(res.status).toBe(200);
      expect(await spawnedId(res)).toBe("websites--release");
    });

    it("lands on instance 2 when the bare id is taken", async () => {
      const res = await runSpawn(deps(["websites--release"]), PARENT, { role: "release", instance: "next" });
      expect(await spawnedId(res)).toBe("websites--release--2");
    });

    it("fills the LOWEST hole: {1,2,4} occupied -> 3, never 5", async () => {
      const res = await runSpawn(
        deps(["websites--release", "websites--release--2", "websites--release--4"]),
        PARENT, { role: "release", instance: "next" },
      );
      expect(await spawnedId(res)).toBe("websites--release--3");
    });

    it("skips a long unbroken run correctly: {1,2,3,4,5} -> 6", async () => {
      const res = await runSpawn(
        deps([1, 2, 3, 4, 5].map((n) => (n === 1 ? "websites--release" : `websites--release--${n}`))),
        PARENT, { role: "release", instance: "next" },
      );
      expect(await spawnedId(res)).toBe("websites--release--6");
    });

    it("counts only the SAME role in the SAME repo", async () => {
      const res = await runSpawn(
        deps(["beta--release", "beta--release--2", "websites--pilot", "websites--web-studio", "websites--web-studio--2"]),
        PARENT, { role: "release", instance: "next" },
      );
      expect(await spawnedId(res)).toBe("websites--release");
    });

    it("keeps a hyphenated role whole — the ambiguous-looking case", async () => {
      const res = await runSpawn(
        deps(["websites--web-studio"]), PARENT, { role: "web-studio", instance: "next" },
      );
      expect(await spawnedId(res)).toBe("websites--web-studio--2");
    });

    it("passes the allocated instance down on the ProvisionConfig, and omits it at 1", async () => {
      const first: { repo: string; role: string; instance?: number }[] = [];
      await runSpawn(deps([], first), PARENT, { role: "release", instance: "next" });
      expect(first).toEqual([{ repo: "websites", role: "release" }]);

      const second: { repo: string; role: string; instance?: number }[] = [];
      await runSpawn(deps(["websites--release"], second), PARENT, { role: "release", instance: "next" });
      expect(second).toEqual([{ repo: "websites", role: "release", instance: 2 }]);
    });
  });

  describe("instance: <n> — the caller names it", () => {
    it("spawns exactly that instance", async () => {
      const res = await runSpawn(deps(["websites--release"]), PARENT, { role: "release", instance: 2 });
      expect(await spawnedId(res)).toBe("websites--release--2");
    });

    it("409s when that instance already exists, rather than sliding to a free one", async () => {
      const res = await runSpawn(
        deps(["websites--release", "websites--release--2"]), PARENT, { role: "release", instance: 2 },
      );
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("studio exists");
    });

    it("instance 1 means the bare id — the same thing as sending no instance at all", async () => {
      expect(await spawnedId(await runSpawn(deps([]), PARENT, { role: "release", instance: 1 })))
        .toBe("websites--release");
      expect((await runSpawn(deps(["websites--release"]), PARENT, { role: "release", instance: 1 })).status)
        .toBe(409);
    });

    it("does not need to be contiguous — a caller may name a gap", async () => {
      const res = await runSpawn(deps(["websites--release"]), PARENT, { role: "release", instance: 7 });
      expect(await spawnedId(res)).toBe("websites--release--7");
    });
  });

  describe("refusals", () => {
    it.each([
      ["zero", 0], ["negative", -2], ["a float", 2.5],
      ["a numeric STRING (never coerced)", "2"],
      ["some other string", "second"], ["true", true], ["an object", { n: 2 }],
    ] as const)("400 on %s", async (_label, instance) => {
      const res = await runSpawn(deps([]), PARENT, { role: "release", instance });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("instance");
    });

    it("a bad instance is refused BEFORE the org chart is even fetched", async () => {
      let fetched = false;
      const d = deps([]);
      const res = await runSpawn(
        { ...d, fetchPolicy: async () => { fetched = true; return d.fetchPolicy(); } },
        PARENT, { role: "release", instance: 0 },
      );
      expect(res.status).toBe(400);
      expect(fetched).toBe(false);
    });

    // An instance suffix must never reach the org chart as part of a role, or
    // `maySpawn` would be judging a name org.json cannot contain.
    it("400 on an instance smuggled into the ROLE field", async () => {
      for (const role of ["release--2", "release--", "--2"]) {
        const res = await runSpawn(deps([]), PARENT, { role });
        expect(res.status, role).toBe(400);
        expect(await res.text()).toBe("bad role");
      }
    });

    it("org-chart 403 still wins over allocation — instances inherit their ROLE's edges", async () => {
      const res = await runSpawn(deps([]), PARENT, { role: "cto", instance: "next" });
      expect(res.status).toBe(403);
    });
  });

  it("the fleet-wide cap still refuses at exactly 100, however many instances of one role are running", async () => {
    // 100 rows, all of them instances of ONE role in ONE repo — the shape #269
    // makes possible — and the cap is untouched by that.
    const hundred = Array.from({ length: 100 }, (_, i) => (i === 0 ? "websites--release" : `websites--release--${i + 1}`));
    const atCap = await runSpawn(deps(hundred), PARENT, { role: "release", instance: "next" });
    expect(atCap.status).toBe(409);
    expect(await atCap.text()).toContain("capacity");
    // One fewer, and the same request goes through — proving the 409 above is
    // the cap and not the allocator running out of numbers.
    const underCap = await runSpawn(deps(hundred.slice(0, 99)), PARENT, { role: "release", instance: "next" });
    expect(underCap.status).toBe(200);
    expect(await spawnedId(underCap)).toBe("websites--release--100");
  });
});

// Issue #269 round 2: maestro is a SINGLETON role. wake-events.ts's own
// maestroIdFor always builds the bare two-segment id, and do.ts's isMaestro()
// (the sweep gate) only recognizes instance 1 — a second `x--maestro--2`
// would run a second, unwoken sweep loop. Refused before any org.json fetch.
describe("runSpawn — maestro is a singleton role (#269 round 2)", () => {
  const PARENT: SpawnParent = { id: PARENT_ID, repo: "websites", role: "pilot" };

  function deps(ids: string[]): SpawnDeps {
    return {
      listStudios: async () => ids.map((id) => status({ id })),
      // maestro is NOT in this org's edges — if the refusal below did not
      // fire before the org.json fetch/maySpawn check, this would 403
      // instead of 409, proving the ordering (cheapest check first) too.
      fetchPolicy: async () => ({ org: { edges: { pilot: ["release"] }, gates: {} }, roles: ["pilot", "release"] }),
      provisionChild: async (childId: string) => status({ id: childId, state: "running" }),
      resolveBrief: noBrief,
      notifyMaestro: async () => {},
      maxStudios: DEFAULT_MAX_STUDIOS,
      claimStudioId: memoryClaim(),
    };
  }

  it("refuses instance: \"next\" for maestro with 409, not 403", async () => {
    const res = await runSpawn(deps([]), PARENT, { role: "maestro", instance: "next" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("singleton");
  });

  it("refuses an explicit instance >1 for maestro with 409", async () => {
    const res = await runSpawn(deps(["websites--maestro"]), PARENT, { role: "maestro", instance: 2 });
    expect(res.status).toBe(409);
  });

  it("instance 1 (absent, the pre-#269 default) is unaffected — still the ordinary 409-on-existing path", async () => {
    const maestroCanSpawn: SpawnDeps = {
      ...deps(["websites--maestro"]),
      fetchPolicy: async () => ({ org: { edges: { pilot: ["maestro"] }, gates: {} }, roles: ["pilot", "maestro"] }),
    };
    const res = await runSpawn(maestroCanSpawn, PARENT, { role: "maestro" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("studio exists");
  });
});

describe("readInstanceRequest", () => {
  it("absent, null and an absent body all mean instance 1 — the pre-#269 default", () => {
    expect(readInstanceRequest({})).toBe(1);
    expect(readInstanceRequest({ role: "pilot" })).toBe(1);
    expect(readInstanceRequest({ instance: null })).toBe(1);
    expect(readInstanceRequest(null)).toBe(1);
    expect(readInstanceRequest(undefined)).toBe(1);
  });
  it('passes "next" through for the Worker to allocate', () => {
    expect(readInstanceRequest({ instance: "next" })).toBe("next");
  });
  it("accepts a positive integer verbatim", () => {
    expect(readInstanceRequest({ instance: 1 })).toBe(1);
    expect(readInstanceRequest({ instance: 42 })).toBe(42);
  });
  it("refuses everything else rather than coercing it", () => {
    for (const bad of [0, -1, 1.5, "1", "next ", "", true, false, {}, [], NaN, Infinity]) {
      expect(readInstanceRequest({ instance: bad }), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("POST /fleet/spawn", () => {
  it("405 on a non-POST method (checked before anything else — no token needed to learn this)", async () => {
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(spawnReq(null, undefined, "GET"), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(405);
  });

  it("404 on any other /fleet/ path", async () => {
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(
      spawnReq({ role: "release" }, undefined, "POST", "/fleet/nonsense"), testEnvWith(ns), fetchFile,
    );
    expect(res.status).toBe(404);
  });

  it("401 when the spawn token header is absent", async () => {
    await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile, calls } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(spawnReq({ role: "release" }), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(401);
    // Auth runs first: no blueprint fetched, no studio provisioned.
    expect(calls).toEqual([]);
    expect(ns.provisioned).toEqual([]);
  });

  it("401 for a well-shaped token that belongs to no registered studio", async () => {
    await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(spawnReq({ role: "release" }, mintSpawnToken()), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(401);
    expect(ns.provisioned).toEqual([]);
  });

  it("401 for a malformed (non-fsp_) token", async () => {
    await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(spawnReq({ role: "release" }, "hunter2"), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(401);
  });

  it.each([
    ["an empty body", {}],
    ["a non-string role", { role: 42 }],
    ["an empty role", { role: "" }],
    ["a role with an invalid charset", { role: "Bad Role!" }],
    ["a role that smuggles the id delimiter", { role: "release--extra" }],
  ])("400 on %s (authenticated — auth still runs first)", async (_label, body) => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(spawnReq(body, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(400);
    expect(ns.provisioned).toEqual([]);
  });

  it("400 on a body that is not JSON at all", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const req = new Request("https://x/fleet/spawn", {
      method: "POST", body: "not json", headers: { [SPAWN_TOKEN_HEADER]: token },
    });
    expect((await handleFleetSpawn(req, testEnvWith(ns), fetchFile)).status).toBe(400);
  });

  it("403 when org.json declares no edge from the parent's role to the requested one", async () => {
    const token = await registerStudio(PARENT_ID); // pilot: may only spawn release
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(spawnReq({ role: "cto" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(403);
    expect(ns.provisioned).toEqual([]);
  });

  it("403 for a parent role with no edges entry at all", async () => {
    const token = await registerStudio("websites--scratch");
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    expect((await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile)).status).toBe(403);
  });

  // Review round 1, Important 1: `websites--operator` is a perfectly valid
  // studio id, so without an explicit guard a studio provisioned into that
  // role would inherit the human operator's org edges as soon as T3 declares
  // them. Same opaque 401 as any other unrecognised token.
  it("401 for a studio whose own role is the operator literal", async () => {
    const token = await registerStudio("websites--operator");
    const ns = fakeStudioNamespace();
    const { fetchFile, calls } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(spawnReq({ role: "pilot" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]); // never even reached the org chart
    expect(ns.provisioned).toEqual([]);
  });

  // Review round 1, Important 2: org.json and fleet.json are separate files
  // that can disagree — the SHIPPED pair already does (org edges cto ->
  // [release, qa, dev]; fleet.json roles: ["pilot", "scratch"] as of Task 4 —
  // release/qa/dev/cto are still undeclared there). Provisioning an
  // org-approved but fleet-undeclared role used to start a container and
  // only then degrade, i.e. a billable studio that can never work.
  it("400 for a role the org allows but fleet.json does not declare — before any DO touch", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch({
      fleet: async () =>
        JSON.stringify({
          blueprint: { repo: REPO_SLUG, ref: "v1.0.0" }, roles: ["pilot"], instance_type: "standard-2",
        }),
    });

    const res = await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("fleet.json"); // actionable: names the file to fix
    expect(body).toContain("release");
    // No container was ever started, and nothing was written to the registry.
    expect(ns.provisioned).toEqual([]);
    expect((await listStudios(env)).some((s) => s.id === "websites--release")).toBe(false);
  });

  it("403 still wins over the fleet-undeclared 400 — a caller with no edge learns nothing about fleet.json", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch({
      fleet: async () =>
        JSON.stringify({
          blueprint: { repo: REPO_SLUG, ref: "v1.0.0" }, roles: ["pilot"], instance_type: "standard-2",
        }),
    });
    // pilot has no edge to `cto`, and `cto` is also undeclared in fleet.json.
    expect((await handleFleetSpawn(spawnReq({ role: "cto" }, token), testEnvWith(ns), fetchFile)).status).toBe(403);
  });

  it("409 when the derived child id already exists in the registry", async () => {
    const token = await registerStudio(PARENT_ID);
    await recordStudio(env, status({ id: "websites--release" }));
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const res = await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(409);
    expect(ns.provisioned).toEqual([]);
  });

  it("403 is decided BEFORE 409 — a caller with no edge learns nothing about which studios exist", async () => {
    const token = await registerStudio(PARENT_ID);
    await recordStudio(env, status({ id: "websites--cto" }));
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    expect((await handleFleetSpawn(spawnReq({ role: "cto" }, token), testEnvWith(ns), fetchFile)).status).toBe(403);
  });

  it("200 happy path: provisions <parentRepo>--<role> with spawnedBy set to the parent id", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();

    const res = await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(200);

    const body = (await res.json()) as StudioStatus;
    expect(body.id).toBe("websites--release");
    expect(body.state).toBe("running");
    expect(body.spawnedBy).toBe(PARENT_ID);

    // The child was provisioned through the ordinary provision path — no new
    // provisioning machinery (R-P3-2).
    expect(ns.provisioned).toEqual([{ repo: "websites", role: "release", spawnedBy: PARENT_ID }]);
  });

  it("200 response never carries a spawn token (neither the caller's nor the child's freshly minted one)", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();

    const text = await (await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile)).text();
    expect(text).not.toContain("fsp_");
    expect(text).not.toContain(token);
  });

  it("the child's registry row holds the token's HASH and never the token itself", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile);

    const childToken = await ns.storageFor("websites--release").get(SPAWN_TOKEN_KEY);
    expect(childToken).toMatch(/^fsp_[0-9a-f]{64}$/);

    const raw = await env.DB
      .prepare("SELECT value FROM fleet_state WHERE key = ?")
      .bind("studio:websites--release")
      .first<{ value: string }>();
    // Asserted on the SERIALIZED row: no `fsp_` token anywhere in D1.
    expect(raw?.value).not.toContain("fsp_");
    expect(raw?.value).toContain(await hashSpawnToken(childToken!));

    const child = (await listStudios(env)).find((s) => s.id === "websites--release");
    expect(child?.spawnTokenHash).toBe(await hashSpawnToken(childToken!));
    expect(child?.spawnedBy).toBe(PARENT_ID);
  });

  it("a child, once spawned, can itself present its own token (the hash round-trips through the registry)", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile);

    const childToken = (await ns.storageFor("websites--release").get(SPAWN_TOKEN_KEY))!;
    const parent = await resolveSpawnParent(await listStudios(env), childToken);
    expect(parent).toEqual({ id: "websites--release", repo: "websites", role: "release", repoSlug: REPO_SLUG });
  });

  // T3: the real org.json's `pilot: ["scratch"]` edge (added alongside the
  // operator one the /studio/spawn describe block below exercises) — same
  // machine path, same PARENT_ID (pilot) fixture as every other test in this
  // block, only the org half swapped for the real shipped file.
  it("200 against the REAL shipped org.json: T3's pilot->scratch edge (the e2e parent T6 needs)", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch({ org: async () => env.TEST_ORG_JSON });
    const res = await handleFleetSpawn(spawnReq({ role: "scratch" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.id).toBe("websites--scratch");
    expect(body.spawnedBy).toBe(PARENT_ID);
  });

  it("503 when org.json cannot be fetched, with a short static body", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch({
      org: async () => {
        throw new Error("fetch org.json@v1.0.0 failed (404): Not Found — ghs_leakytoken");
      },
    });
    const res = await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text.length).toBeLessThan(64);
    expect(text).not.toContain("ghs_"); // the upstream error never reaches the caller
    expect(ns.provisioned).toEqual([]);
  });

  it("503s do not amplify: a second call within the backoff window never refetches org.json", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile, calls } = fakeBlueprintFetch({
      org: async () => {
        throw new Error("still down");
      },
    });
    const req = () => handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile);

    expect((await req()).status).toBe(503);
    expect((await req()).status).toBe(503);
    expect((await req()).status).toBe(503);

    expect(calls.filter((c) => c.startsWith("fleet/blueprint/org.json"))).toHaveLength(1);
  });

  it("503 when fleet.json itself cannot be fetched (no ref to resolve org.json with)", async () => {
    const token = await registerStudio(PARENT_ID);
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch({
      fleet: async () => {
        throw new Error("fetch fleet.json@main failed (500)");
      },
    });
    expect((await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile)).status).toBe(503);
  });
});

describe("POST /studio/spawn (operator passthrough, Access side)", () => {
  function operatorReq(body: unknown, method = "POST") {
    return new Request("https://x/studio/spawn", {
      method,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
    });
  }

  it("401 without an Access header (real verifyAccess, not mocked)", async () => {
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const req = new Request("https://x/studio/spawn", { method: "POST", body: JSON.stringify({ role: "cto" }) });
    expect((await handleStudio(req, testEnvWith(ns), fetchFile)).status).toBe(401);
  });

  it("405 on a non-POST method", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    expect((await handleStudio(operatorReq(null, "GET"), testEnvWith(ns), fetchFile)).status).toBe(405);
  });

  it("200: the operator spawns an edged role, with spawnedBy 'operator' and NO spawn token involved", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();

    const res = await handleStudio(operatorReq({ role: "cto" }), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.id).toBe("websites--cto");
    expect(body.spawnedBy).toBe(OPERATOR_PARENT_ID);
    expect(ns.provisioned).toEqual([{ repo: "websites", role: "cto", spawnedBy: OPERATOR_PARENT_ID, repoSlug: REPO_SLUG }]);
  });

  it("403 for a role the operator has no edge to", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    expect((await handleStudio(operatorReq({ role: "release" }), testEnvWith(ns), fetchFile)).status).toBe(403);
  });

  // T3 added the real `operator` edge (`["cto", "pilot", "scratch"]`) —
  // `release` is deliberately not on that list (it stays reachable only
  // through `cto`'s own pre-existing edge), so this still 403s, but now for
  // the true reason: an edge exists and does not cover this role, not "no
  // edge at all". See the success case right below for the edge actually
  // taking effect against the same real file.
  it("403 against the REAL shipped org.json for a role outside the operator's edge (T3 added operator->[cto,pilot,scratch]; release isn't one)", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch({ org: async () => env.TEST_ORG_JSON });
    expect((await handleStudio(operatorReq({ role: "release" }), testEnvWith(ns), fetchFile)).status).toBe(403);
  });

  it("200 against the REAL shipped org.json: T3's operator->scratch edge now succeeds", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    // Only `org` is overridden to the real file — `fleet` still falls back
    // to fakeBlueprintFetch's own FAKE_FLEET_JSON (roles: [pilot, release,
    // scratch, cto]), the same split every other real-org.json test in this
    // describe block uses. As of Task 4 the real fleet.json ALSO declares
    // "scratch" (see fleet/blueprint/README.md's coherence rule and
    // test/studio.blueprint.test.ts's own scratch.md test), so this split is
    // no longer load-bearing for THIS test — kept anyway for consistency
    // with its sibling tests in this describe block, all of which still need
    // FAKE_FLEET_JSON for roles the real file does not declare (release, cto).
    const { fetchFile } = fakeBlueprintFetch({ org: async () => env.TEST_ORG_JSON });
    const res = await handleStudio(operatorReq({ role: "scratch" }), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.id).toBe("websites--scratch");
    expect(body.spawnedBy).toBe(OPERATOR_PARENT_ID);
    expect(ns.provisioned).toEqual([{ repo: "websites", role: "scratch", spawnedBy: OPERATOR_PARENT_ID, repoSlug: REPO_SLUG }]);
  });

  it("409 when the studio already exists", async () => {
    authorized();
    await recordStudio(env, status({ id: "websites--cto" }));
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    expect((await handleStudio(operatorReq({ role: "cto" }), testEnvWith(ns), fetchFile)).status).toBe(409);
  });

  it("400 on a malformed role", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    expect((await handleStudio(operatorReq({}), testEnvWith(ns), fetchFile)).status).toBe(400);
  });

  // Review round 1, minor (b): the operator's child repo segment is derived
  // from AGENT_REPO, so a bad AGENT_REPO is a CONFIG fault, not a bad
  // request — answering "bad role" would send the operator hunting the wrong
  // problem.
  it("500 with a config message (not 'bad role') when AGENT_REPO has no valid studio repo segment", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    // Trailing separator: since board #21 `Web_Sites` folds to the perfectly
    // valid `web-sites`, while `Web_Sites_` folds to `web-sites-` and no fold
    // can rescue that.
    const brokenEnv = { ...testEnvWith(ns), AGENT_REPO: "acme-org/Web_Sites_" } as unknown as Env;
    const res = await handleStudio(operatorReq({ role: "cto" }), brokenEnv, fetchFile);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("AGENT_REPO");
    expect(body).not.toContain("bad role");
    expect(ns.provisioned).toEqual([]);
  });

  it("the id-scoped /studio/:id/* routes still work — /studio/spawn does not shadow them", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const req = new Request(`https://x/studio/${PARENT_ID}/provision`, {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
    });
    const res = await handleStudio(req, testEnvWith(ns), fetchFile);
    expect(res.status).toBe(200);
    // Straight through the ordinary provision route: no parent, no spawnedBy.
    expect(ns.provisioned).toEqual([{ repo: "websites", role: "pilot", blueprintRef: undefined, repoSlug: REPO_SLUG }]);
  });

  // Issue #269, the end-to-end flow the CLI actually drives: `fleet spawn
  // <role> --new` sends `instance: "next"` to this route, and every verb that
  // takes an id afterwards has to resolve the THREE-segment id it got back.
  it("`--new` spawns a distinct second studio, and the id-addressed routes all resolve it", async () => {
    authorized();
    // Instance 1 already exists, both in the registry and in the DO namespace,
    // exactly as it would after an earlier `fleet spawn cto`.
    await recordStudio(env, status({ id: "websites--cto", state: "running" }));
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();

    // Without `--new` this is the 409 it always was.
    expect((await handleStudio(operatorReq({ role: "cto" }), testEnvWith(ns), fetchFile)).status).toBe(409);

    // With it, a distinct studio on the lowest free number.
    const spawned = await handleStudio(
      operatorReq({ role: "cto", instance: "next" }), testEnvWith(ns), fetchFile,
    );
    expect(spawned.status).toBe(200);
    const child = (await spawned.json()) as StudioStatus;
    expect(child.id).toBe("websites--cto--2");
    expect(child.id).not.toBe("websites--cto");
    expect(child.spawnedBy).toBe(OPERATOR_PARENT_ID);
    // The container was built for instance 2, not for instance 1's config.
    expect(ns.provisioned).toEqual([
      { repo: "websites", role: "cto", instance: 2, spawnedBy: OPERATOR_PARENT_ID, repoSlug: REPO_SLUG },
    ]);

    // `fleet ls` — GET /studio/ — lists both, as two separate rows.
    const listed = (await (await handleStudio(
      new Request("https://x/studio/", { headers: { "Cf-Access-Jwt-Assertion": "test-jwt" } }),
      testEnvWith(ns), fetchFile,
    )).json()) as StudioStatus[];
    const ids = listed.map((s) => s.id);
    expect(ids).toContain("websites--cto");
    expect(ids).toContain("websites--cto--2");

    // Every id-addressed verb (`inspect`, `attach`, `status`, `destroy`,
    // `recycle`, `provision`, `tabs`, `rescue-all`) reaches its studio through
    // ONE shared gate — routes.ts's ROUTE_RE plus parseStudioId — so
    // `provision` standing in for the family is not a shortcut: it is the gate
    // under test. Re-provisioning instance 2 by id rebuilds instance 2, never
    // instance 1's container. (The 400 case is its own test right below.)
    const reprov = await handleStudio(
      new Request("https://x/studio/websites--cto--2/provision", {
        method: "POST", headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
      }),
      testEnvWith(ns), fetchFile,
    );
    expect(reprov.status).toBe(200);
    expect(((await reprov.json()) as StudioStatus).id).toBe("websites--cto--2");
    expect(ns.provisioned[1]).toEqual({
      repo: "websites", role: "cto", instance: 2, blueprintRef: undefined, repoSlug: REPO_SLUG,
    });
  });

  // The canonical-id refusal, at the route boundary rather than only in the
  // parser: `--1` is the same studio as the bare id, so accepting it would
  // give one studio two addresses.
  it("a non-canonical instance id is a 400 at the route, not a second address for one studio", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    for (const bad of ["websites--cto--1", "websites--cto--0", "websites--cto--01", "websites--cto--x"]) {
      const res = await handleStudio(
        new Request(`https://x/studio/${bad}/provision`, {
          method: "POST", headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
        }),
        testEnvWith(ns), fetchFile,
      );
      expect(res.status, bad).toBe(400);
      expect(await res.text()).toBe("bad studio id");
    }
  });
});

describe("index.ts prefix routing (the /fleet/ mount does not shadow /studio/)", () => {
  it("/fleet/spawn reaches the fleet handler, not the generic 404", async () => {
    // A GET is answered by the fleet handler's own 405 — proof it was routed
    // there, and cheap enough to need no network.
    const res = await worker.fetch(new Request("https://x/fleet/spawn"), env as unknown as Env, {} as any);
    expect(res.status).toBe(405);
  });

  it("/studio/* still reaches handleStudio (Access-gated as before)", async () => {
    const res = await worker.fetch(new Request(`https://x/studio/${PARENT_ID}/status`), env as unknown as Env, {} as any);
    expect(res.status).toBe(401);
  });

  it("an unrelated path is still a 404", async () => {
    const res = await worker.fetch(new Request("https://x/nope"), env as unknown as Env, {} as any);
    expect(res.status).toBe(404);
  });

  it("/health is untouched", async () => {
    const res = await worker.fetch(new Request("https://x/health"), env as unknown as Env, {} as any);
    expect(res.status).toBe(200);
  });
});

// Dynamic repo selection (P4a): the operator runs `fleet spawn <role>` from
// a local repo folder, cli/fleet.ts reads `git remote origin` and sends the
// full `owner/repo` — and the Worker verifies it against the GitHub App
// installation before any container exists. src/studio/repo.ts owns every
// decision; these pin the ROUTE wiring: that the requested repo reaches it,
// that a rejection never reaches the DO, and that the resolved slug becomes
// both halves of the child (its id segment and its clone target).
describe("POST /studio/spawn — dynamic repo selection", () => {
  function operatorReq(body: unknown) {
    return new Request("https://x/studio/spawn", {
      method: "POST", body: JSON.stringify(body),
      headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
    });
  }

  /** The P6a reachability seam handleStudio takes as its 4th argument — a
   *  live GitHub call in production, with no test double. Given a LIST it
   *  stands in for a provider that can reach exactly those repos;
   *  src/github/auth.ts covers the real App and token answers. */
  function repos(list: string[] | Error) {
    const calls: string[] = [];
    return {
      calls,
      reach: async (slug: string): Promise<RepoReach> => {
        calls.push(slug);
        if (list instanceof Error) throw list;
        return list.some((full) => full.toLowerCase() === slug.toLowerCase())
          ? { reachable: true }
          : { reachable: false, remedy: "is not reachable by this fleet — grant it access first" };
      },
    };
  }

  it("spawns into the DETECTED repo: child id, spawn target and clone slug all follow it", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const { reach } = repos(["acme-org/beta"]);

    const res = await handleStudio(
      operatorReq({ role: "scratch", repo: "acme-org/beta" }), testEnvWith(ns), fetchFile, reach,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).id).toBe("beta--scratch");
    expect(ns.provisioned).toEqual([
      { repo: "beta", role: "scratch", spawnedBy: OPERATOR_PARENT_ID, repoSlug: "acme-org/beta" },
    ]);
  });

  it("403s a repo outside the installation, and never touches the DO", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const { reach } = repos(["acme-org/websites"]);

    const res = await handleStudio(
      operatorReq({ role: "scratch", repo: "attacker/payload" }), testEnvWith(ns), fetchFile, reach,
    );
    expect(res.status).toBe(403);
    expect(ns.provisioned).toEqual([]);
  });

  it("503s when the installation list is unreachable — never a silent allow", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const { reach } = repos(new Error("github down"));

    const res = await handleStudio(
      operatorReq({ role: "scratch", repo: "acme-org/beta" }), testEnvWith(ns), fetchFile, reach,
    );
    expect(res.status).toBe(503);
    expect(ns.provisioned).toEqual([]);
  });

  it("no repo in the body (not a git repo, no origin, a non-GitHub remote) still spawns on the fleet default, with no installation call at all", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const { reach, calls } = repos(new Error("must not be called"));

    const res = await handleStudio(operatorReq({ role: "scratch" }), testEnvWith(ns), fetchFile, reach);
    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).id).toBe("websites--scratch");
    expect(calls).toEqual([]);
  });

  it("409s a second org's same-named repo rather than colliding on one studio id", async () => {
    authorized();
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    await recordStudio(env, status({ id: "beta--scratch", repoSlug: "acme-org/beta" }));

    const res = await handleStudio(
      operatorReq({ role: "cto", repo: "other-org/beta" }), testEnvWith(ns), fetchFile, repos(["other-org/beta"]).reach,
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("acme-org/beta");
    expect(ns.provisioned).toEqual([]);
  });

  it("a spawned CHILD inherits the parent's bound repo — /fleet/spawn never reads a repo from the container's request", async () => {
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const token = await registerStudio("beta--pilot", { repoSlug: "acme-org/beta" });

    const res = await handleFleetSpawn(spawnReq({ role: "release", repo: "attacker/payload" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(200);
    expect(ns.provisioned).toEqual([
      { repo: "beta", role: "release", spawnedBy: "beta--pilot", repoSlug: "acme-org/beta" },
    ]);
  });

  it("a pre-P4a parent (no bound repo) spawns children on the fleet default, exactly as before", async () => {
    const ns = fakeStudioNamespace();
    const { fetchFile } = fakeBlueprintFetch();
    const token = await registerStudio(PARENT_ID);

    const res = await handleFleetSpawn(spawnReq({ role: "release" }, token), testEnvWith(ns), fetchFile);
    expect(res.status).toBe(200);
    expect(ns.provisioned).toEqual([
      { repo: "websites", role: "release", spawnedBy: PARENT_ID, repoSlug: undefined },
    ]);
  });
});

describe("runSpawn — {task} (P4a-2 brief pickup)", () => {
  const PARENT: SpawnParent = { id: PARENT_ID, repo: "websites", role: "pilot", repoSlug: REPO_SLUG };

  function taskDeps(
    resolveBrief: SpawnDeps["resolveBrief"],
    provisionChild?: SpawnDeps["provisionChild"],
  ): SpawnDeps {
    return {
      listStudios: async () => [],
      fetchPolicy: async () => ({ org: { edges: { pilot: ["release"] }, gates: {} }, roles: ["pilot", "release"] }),
      provisionChild: provisionChild ?? (async (childId: string) => status({ id: childId, state: "running" })),
      resolveBrief,
      notifyMaestro: async () => {},
      maxStudios: DEFAULT_MAX_STUDIOS,
      claimStudioId: memoryClaim(),
    };
  }

  it("passes the resolved brief into the child's ProvisionConfig", async () => {
    let seen: ProvisionConfig | null = null;
    const deps = taskDeps(
      async () => ({ ok: true, value: "## Your task — board issue #71" }),
      async (childId: string, cfg: ProvisionConfig) => { seen = cfg; return status({ id: childId }); },
    );
    const res = await runSpawn(deps, PARENT, { role: "release", task: 71 });
    expect(res.status).toBe(200);
    expect(seen!.briefPrompt).toContain("#71");
  });

  it("checks the task against the id the WORKER derived, not one the caller sent", async () => {
    const seen: { studioId: string; repoSlug: string | undefined; task: number }[] = [];
    const deps = taskDeps(async (studioId, repoSlug, task) => {
      seen.push({ studioId, repoSlug, task });
      return { ok: true, value: "brief" };
    });
    // The body's own `assignee`/`studio` fields are not read by anything.
    await runSpawn(deps, PARENT, { role: "release", task: 71, assignee: "websites--somebody-else" });
    expect(seen).toEqual([{ studioId: "websites--release", repoSlug: REPO_SLUG, task: 71 }]);
  });

  it("refuses a task not assigned to the child, and provisions NOTHING", async () => {
    let provisioned = false;
    const deps = taskDeps(
      async () => ({ ok: false, status: 404, message: "task #71 is not assigned to websites--release" }),
      async (childId: string) => { provisioned = true; return status({ id: childId }); },
    );
    const res = await runSpawn(deps, PARENT, { role: "release", task: 71 });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not assigned");
    expect(provisioned).toBe(false);
  });

  it("400s a task that is not a positive integer, before the board is read", async () => {
    const resolveBrief = vi.fn(async () => ({ ok: true as const, value: "brief" }));
    for (const task of ["71", 0, -3, 1.5]) {
      const res = await runSpawn(taskDeps(resolveBrief), PARENT, { role: "release", task });
      expect(res.status).toBe(400);
    }
    expect(resolveBrief).not.toHaveBeenCalled();
  });

  it("never reads the board when no task is named", async () => {
    const resolveBrief = vi.fn(async () => ({ ok: true as const, value: "brief" }));
    expect((await runSpawn(taskDeps(resolveBrief), PARENT, { role: "release" })).status).toBe(200);
    expect(resolveBrief).not.toHaveBeenCalled();
  });

  it("resolves the brief LAST — an org-chart refusal costs no board read", async () => {
    const resolveBrief = vi.fn(async () => ({ ok: true as const, value: "brief" }));
    const deps: SpawnDeps = {
      ...taskDeps(resolveBrief),
      fetchPolicy: async () => ({ org: { edges: { pilot: [] }, gates: {} }, roles: ["pilot", "release"] }),
    };
    expect((await runSpawn(deps, PARENT, { role: "release", task: 71 })).status).toBe(403);
    expect(resolveBrief).not.toHaveBeenCalled();
  });
});

/**
 * The design spec's re-arm list: "new task assigned, studio spawned, PR
 * opened, operator `fleet watch on`". Three of those arrive as a wake through
 * some other path; a spawn is the one that has to be wired here.
 */
describe("runSpawn -> maestro re-arm", () => {
  const PARENT: SpawnParent = { id: "websites--pilot", repo: "websites", role: "pilot", repoSlug: "acme-org/websites" };

  function armDeps(over: Partial<SpawnDeps> = {}): { deps: SpawnDeps; woke: [string, string][] } {
    const woke: [string, string][] = [];
    return {
      woke,
      deps: {
        listStudios: async () => [],
        fetchPolicy: async () => ({ org: { edges: { pilot: ["release"] }, gates: {} }, roles: ["pilot", "release"] }),
        provisionChild: async (childId: string) => status({ id: childId, state: "running" }),
        resolveBrief: noBrief,
        maxStudios: DEFAULT_MAX_STUDIOS,
        claimStudioId: memoryClaim(),
        notifyMaestro: async (studioId: string, prompt: string) => { woke.push([studioId, prompt]); },
        ...over,
      },
    };
  }

  it("wakes the repo's maestro once the child is actually up", async () => {
    const { deps, woke } = armDeps();
    expect((await runSpawn(deps, PARENT, { role: "release" })).status).toBe(200);
    expect(woke.length).toBe(1);
    expect(woke[0]![0]).toBe("websites--maestro");
    expect(woke[0]![1]).toContain("websites--release");
    expect(woke[0]![1]).toContain("spawned");
  });

  it("wakes nobody when the spawn was refused", async () => {
    const { deps, woke } = armDeps();
    expect((await runSpawn(deps, PARENT, { role: "nope" })).status).toBe(403);
    expect(woke).toEqual([]);
  });

  it("still returns the child status when the wake itself fails", async () => {
    // A spawn is not undone by an unreachable maestro. The sweep re-detects
    // the new studio within 20 minutes either way.
    const { deps } = armDeps({ notifyMaestro: async () => { throw new Error("container unreachable"); } });
    expect((await runSpawn(deps, PARENT, { role: "release" })).status).toBe(200);
  });

  it("never wakes a maestro with itself", async () => {
    // A maestro spawning a maestro would wake the studio that is mid-spawn.
    const { deps, woke } = armDeps({
      fetchPolicy: async () => ({ org: { edges: { maestro: ["maestro"] }, gates: {} }, roles: ["maestro"] }),
    });
    const maestroParent: SpawnParent = { id: "websites--maestro", repo: "websites", role: "maestro", repoSlug: "acme-org/websites" };
    expect((await runSpawn(deps, maestroParent, { role: "maestro" })).status).toBe(200);
    expect(woke).toEqual([]);
  });
});
