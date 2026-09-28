import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseOrgJson, maySpawn, mintSpawnToken, hashSpawnToken, fetchOrgCached,
  __resetOrgCacheForTests, __seedOrgCacheForTests, __seedOrgFailureForTests,
  fetchFleetJsonCached, __resetFleetJsonCacheForTests, __seedFleetJsonCacheForTests,
  __seedFleetJsonFailureForTests,
  ORG_CACHE_TTL_MS, ORG_RETRY_MS,
  type Org, type OrgFetchDeps, type FleetJsonFetchDeps,
} from "../src/studio/org";
import { BlueprintError, type FleetConfig } from "../src/studio/blueprint";

const VALID_ORG_JSON = JSON.stringify({
  edges: { cto: ["release", "qa", "dev"] },
  gates: { merge: ["release"], deploy: ["release"] },
});

describe("parseOrgJson", () => {
  it("parses a valid org.json", () => {
    expect(parseOrgJson(VALID_ORG_JSON)).toEqual<Org>({
      edges: { cto: ["release", "qa", "dev"] },
      gates: { merge: ["release"], deploy: ["release"] },
    });
  });

  it("empty edges/gates objects are valid (no edges declared yet)", () => {
    expect(parseOrgJson(JSON.stringify({ edges: {}, gates: {} }))).toEqual<Org>({ edges: {}, gates: {} });
  });

  it("invalid JSON syntax -> BlueprintError naming org.json", () => {
    try {
      parseOrgJson("{not json");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlueprintError);
      expect((err as BlueprintError).field).toBe("org.json");
    }
  });

  it.each([null, "a string", 42, ["array", "not", "object"]])(
    "top-level %j is not an object -> BlueprintError naming org.json",
    (value) => {
      try {
        parseOrgJson(JSON.stringify(value));
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(BlueprintError);
        expect((err as BlueprintError).field).toBe("org.json");
      }
    },
  );

  it("missing edges -> BlueprintError naming it", () => {
    try {
      parseOrgJson(JSON.stringify({ gates: {} }));
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("edges");
    }
  });

  it("missing gates -> BlueprintError naming it", () => {
    try {
      parseOrgJson(JSON.stringify({ edges: {} }));
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("gates");
    }
  });

  it("edges present but not an object -> BlueprintError naming it", () => {
    try {
      parseOrgJson(JSON.stringify({ edges: "cto", gates: {} }));
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("edges");
    }
  });

  it("edges present as an array -> BlueprintError naming it (arrays are objects too in JS)", () => {
    try {
      parseOrgJson(JSON.stringify({ edges: ["cto"], gates: {} }));
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("edges");
    }
  });

  it("an edges value that is not an array of strings -> BlueprintError naming edges", () => {
    try {
      parseOrgJson(JSON.stringify({ edges: { cto: "release" }, gates: {} }));
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("edges");
    }
  });

  it("an edges value that is an array of non-strings -> BlueprintError naming edges", () => {
    try {
      parseOrgJson(JSON.stringify({ edges: { cto: [1, 2] }, gates: {} }));
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("edges");
    }
  });

  it("a gates value that is not an array of strings -> BlueprintError naming gates", () => {
    try {
      parseOrgJson(JSON.stringify({ edges: {}, gates: { merge: "release" } }));
      expect.unreachable();
    } catch (err) {
      expect((err as BlueprintError).field).toBe("gates");
    }
  });

  it("the real shipped fleet/blueprint/org.json parses cleanly", () => {
    // workerd has no filesystem; vitest.config.ts injects the real file's
    // text as env.TEST_ORG_JSON the same way it does for fleet.json/pilot.md
    // (see test/studio.blueprint.test.ts's own "real shipped files" block).
    const org = parseOrgJson(env.TEST_ORG_JSON);
    expect(org.edges.operator).toContain("maestro");
    expect(org.gates.merge).toContain("release");
  });

  // Board issue #10 (2026-09-18): the dead top-level `cto` edges key
  // (targets release/qa/dev — none of which has a role/studio file anywhere
  // in the blueprint) is gone, and so is "cto" inside operator's own target
  // list (same reason — no cto role/studio exists, renamed to maestro long
  // ago). "CTO" stays the operator's vocabulary for the human operator; internally
  // this is still the `operator` edge/role, unrenamed (see this task's plan
  // doc for the full reasoning).
  it("the real org.json's edges: operator may spawn pilot/scratch/maestro/the two studios, never cto", () => {
    const org = parseOrgJson(env.TEST_ORG_JSON);
    expect(maySpawn(org, "operator", "pilot")).toBe(true);
    expect(maySpawn(org, "operator", "scratch")).toBe(true);
    expect(maySpawn(org, "pilot", "scratch")).toBe(true);
    // Not blanket permission: the operator's edge is an explicit allow-list.
    expect(maySpawn(org, "operator", "release")).toBe(false);
    // The dead edge, confirmed gone: no cto role/studio exists.
    expect(maySpawn(org, "operator", "cto")).toBe(false);
    expect(org.edges.cto).toBeUndefined();
  });
});

describe("maySpawn", () => {
  const org: Org = {
    edges: { cto: ["release", "qa", "dev"], release: ["release"] },
    gates: { merge: ["release"] },
  };

  it("true when the edge is explicitly declared", () => {
    expect(maySpawn(org, "cto", "release")).toBe(true);
    expect(maySpawn(org, "cto", "qa")).toBe(true);
    expect(maySpawn(org, "cto", "dev")).toBe(true);
  });

  it("false when the parent has edges but not to this child", () => {
    expect(maySpawn(org, "cto", "pilot")).toBe(false);
  });

  it("false for an unknown parent role (no edges entry at all)", () => {
    expect(maySpawn(org, "nobody", "release")).toBe(false);
  });

  it("false for self-spawn by default (not explicitly edged)", () => {
    expect(maySpawn(org, "cto", "cto")).toBe(false);
  });

  it("true for self-spawn when explicitly edged", () => {
    expect(maySpawn(org, "release", "release")).toBe(true);
  });

  it("false against an org with empty edges", () => {
    expect(maySpawn({ edges: {}, gates: {} }, "cto", "release")).toBe(false);
  });
});

describe("mintSpawnToken", () => {
  it("matches fsp_ + 64 lowercase hex chars", () => {
    expect(mintSpawnToken()).toMatch(/^fsp_[0-9a-f]{64}$/);
  });

  it("uniqueness smoke: 500 mints never collide", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => mintSpawnToken()));
    expect(tokens.size).toBe(500);
  });
});

describe("hashSpawnToken", () => {
  it("is a 64-char lowercase hex sha256 digest", async () => {
    expect(await hashSpawnToken(mintSpawnToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same token and different for different tokens", async () => {
    const a = mintSpawnToken();
    const b = mintSpawnToken();
    expect(await hashSpawnToken(a)).toBe(await hashSpawnToken(a));
    expect(await hashSpawnToken(a)).not.toBe(await hashSpawnToken(b));
  });

  it("matches the known sha256 of a fixed input (not a private digest scheme)", async () => {
    // Pinned against the published sha256 of the ASCII string "abc" — proves
    // this is plain SHA-256 hex, so an operator can reproduce a stored hash
    // with `printf %s <token> | shasum -a 256` when debugging a 401.
    expect(await hashSpawnToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("fetchOrgCached", () => {
  beforeEach(() => {
    __resetOrgCacheForTests();
  });

  const org1: Org = { edges: { cto: ["release"] }, gates: {} };
  const org2: Org = { edges: { cto: ["qa"] }, gates: {} };

  function countingDeps(text: string): { deps: OrgFetchDeps; calls: () => number } {
    let n = 0;
    return {
      deps: {
        fetchOrgFile: async () => {
          n++;
          return text;
        },
      },
      calls: () => n,
    };
  }

  it("fetches on first call and returns the parsed org", async () => {
    const { deps } = countingDeps(JSON.stringify(org1));
    expect(await fetchOrgCached(deps, "main")).toEqual(org1);
  });

  it("cache hit: a second call within the TTL does not refetch", async () => {
    const { deps, calls } = countingDeps(JSON.stringify(org1));
    await fetchOrgCached(deps, "main");
    await fetchOrgCached(deps, "main");
    expect(calls()).toBe(1);
  });

  it("keys the cache by ref: two different refs each fetch independently", async () => {
    const a = countingDeps(JSON.stringify(org1));
    const b = countingDeps(JSON.stringify(org2));
    expect(await fetchOrgCached(a.deps, "main")).toEqual(org1);
    expect(await fetchOrgCached(b.deps, "v2")).toEqual(org2);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it("refetches once a cached entry is past the TTL", async () => {
    __seedOrgCacheForTests("main", ORG_CACHE_TTL_MS + 1000, org1);
    const { deps, calls } = countingDeps(JSON.stringify(org2));
    expect(await fetchOrgCached(deps, "main")).toEqual(org2);
    expect(calls()).toBe(1);
  });

  it("does not refetch a cached entry still within the TTL", async () => {
    __seedOrgCacheForTests("main", 1000, org1);
    const { deps, calls } = countingDeps(JSON.stringify(org2));
    expect(await fetchOrgCached(deps, "main")).toEqual(org1);
    expect(calls()).toBe(0);
  });

  it("stale-on-error: a refresh failure past the TTL serves the old cached org instead of throwing", async () => {
    __seedOrgCacheForTests("main", ORG_CACHE_TTL_MS + 1000, org1);
    const deps: OrgFetchDeps = { fetchOrgFile: async () => { throw new Error("network down"); } };
    await expect(fetchOrgCached(deps, "main")).resolves.toEqual(org1);
  });

  it("no staleness cap: an org cached far past what would be a JWKS-style cap is still served on error", async () => {
    // Deliberately much older than auth.ts's JWKS_MAX_STALE_MS (2x its own
    // TTL) would ever tolerate — org.json is repo-controlled config, not a
    // security boundary, so this module never fails closed the way JWKS
    // does (design spec ruling).
    __seedOrgCacheForTests("main", ORG_CACHE_TTL_MS * 1000, org1);
    const deps: OrgFetchDeps = { fetchOrgFile: async () => { throw new Error("still down"); } };
    await expect(fetchOrgCached(deps, "main")).resolves.toEqual(org1);
  });

  it("throws when the very first fetch ever fails (nothing cached to fall back on)", async () => {
    const deps: OrgFetchDeps = { fetchOrgFile: async () => { throw new Error("network down"); } };
    await expect(fetchOrgCached(deps, "main")).rejects.toThrow("network down");
  });

  it("a malformed org.json response is not cached and propagates (nothing cached yet)", async () => {
    const deps: OrgFetchDeps = { fetchOrgFile: async () => "{not json" };
    await expect(fetchOrgCached(deps, "main")).rejects.toThrow(BlueprintError);
  });

  it("does not retry within the backoff window after a failed refresh", async () => {
    __seedOrgCacheForTests("main", ORG_CACHE_TTL_MS + 1000, org1);
    let calls = 0;
    const deps: OrgFetchDeps = {
      fetchOrgFile: async () => {
        calls++;
        throw new Error("down");
      },
    };
    const first = await fetchOrgCached(deps, "main");
    expect(first).toEqual(org1);
    expect(calls).toBe(1);

    const second = await fetchOrgCached(deps, "main");
    expect(second).toEqual(org1);
    expect(calls).toBe(1); // backoff: no second network attempt within ORG_RETRY_MS
  });

  it("retries the fetcher once the backoff window has elapsed", async () => {
    __seedOrgCacheForTests("main", ORG_CACHE_TTL_MS + 1000, org1, ORG_RETRY_MS + 1000);
    const { deps, calls } = countingDeps(JSON.stringify(org2));
    expect(await fetchOrgCached(deps, "main")).toEqual(org2);
    expect(calls()).toBe(1);
  });

  // --- P3 Task 2: the never-successful-ref amplification bound ---------------
  // Until now the backoff above only protected refs that had ALREADY been
  // fetched successfully once. A ref that never succeeded (a bad pin, a
  // deleted tag, a blueprint repo the installation cannot read) hit the live
  // fetcher on EVERY call — and /fleet/spawn is a network-reachable route, so
  // that turned one repeated spawn call into unbounded outbound GitHub
  // traffic. Same 60s floor, same per-ref granularity, applied to the case
  // with nothing cached to fall back on.

  it("never-successful ref: a second call within the backoff window does not hit the fetcher again", async () => {
    let calls = 0;
    const deps: OrgFetchDeps = {
      fetchOrgFile: async () => {
        calls++;
        throw new Error("fetch org.json@bad failed (404): Not Found");
      },
    };
    await expect(fetchOrgCached(deps, "bad")).rejects.toThrow("404");
    expect(calls).toBe(1);

    // Still an error (there is nothing to serve), but NOT another fetch.
    await expect(fetchOrgCached(deps, "bad")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("never-successful ref: a malformed (unparseable) response backs off the same way a network failure does", async () => {
    let calls = 0;
    const deps: OrgFetchDeps = {
      fetchOrgFile: async () => {
        calls++;
        return "{not json";
      },
    };
    await expect(fetchOrgCached(deps, "bad")).rejects.toThrow(BlueprintError);
    await expect(fetchOrgCached(deps, "bad")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("never-successful backoff is per-ref, not global", async () => {
    const failing: OrgFetchDeps = { fetchOrgFile: async () => { throw new Error("down"); } };
    await expect(fetchOrgCached(failing, "bad")).rejects.toThrow();

    const { deps, calls } = countingDeps(JSON.stringify(org1));
    expect(await fetchOrgCached(deps, "good")).toEqual(org1);
    expect(calls()).toBe(1);
  });

  it("never-successful ref: retries the fetcher once the backoff window has elapsed", async () => {
    __seedOrgFailureForTests("bad", ORG_RETRY_MS + 1000);
    const { deps, calls } = countingDeps(JSON.stringify(org1));
    expect(await fetchOrgCached(deps, "bad")).toEqual(org1);
    expect(calls()).toBe(1);
  });

  it("a successful fetch clears the never-successful backoff for that ref", async () => {
    __seedOrgFailureForTests("bad", ORG_RETRY_MS + 1000);
    const { deps } = countingDeps(JSON.stringify(org1));
    await fetchOrgCached(deps, "bad");

    // Past the TTL again, and failing now: the entry is a normal cached one,
    // so it serves stale rather than falling back into the never-successful
    // path (which would throw).
    __seedOrgCacheForTests("bad", ORG_CACHE_TTL_MS + 1000, org1);
    const failing: OrgFetchDeps = { fetchOrgFile: async () => { throw new Error("down"); } };
    await expect(fetchOrgCached(failing, "bad")).resolves.toEqual(org1);
  });

  it("__resetOrgCacheForTests clears the never-successful backoff too", async () => {
    let calls = 0;
    const deps: OrgFetchDeps = {
      fetchOrgFile: async () => {
        calls++;
        throw new Error("down");
      },
    };
    await expect(fetchOrgCached(deps, "bad")).rejects.toThrow();
    __resetOrgCacheForTests();
    await expect(fetchOrgCached(deps, "bad")).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Fleet Spawn P3, Task 4 (R-P3-3): fetchFleetJsonCached — the SAME cache
// shape as fetchOrgCached above (see that describe block for the full
// hit/expiry/stale/floor rationale; this covers the same four behaviors plus
// the one property fleet.json's cache has that org.json's does not: keying
// by repo@ref, not ref alone).
// ---------------------------------------------------------------------------

describe("fetchFleetJsonCached", () => {
  beforeEach(() => {
    __resetFleetJsonCacheForTests();
  });

  const fleet1: FleetConfig = { blueprint: { repo: "o/r", ref: "main" }, roles: ["pilot"], instance_type: "standard-2" };
  const fleet2: FleetConfig = {
    blueprint: { repo: "o/r", ref: "v2" }, roles: ["pilot", "scratch"], instance_type: "standard-2",
  };

  function countingDeps(text: string): { deps: FleetJsonFetchDeps; calls: () => number } {
    let n = 0;
    return {
      deps: { fetchFleetJsonFile: async () => { n++; return text; } },
      calls: () => n,
    };
  }

  it("fetches on first call and returns the parsed fleet.json", async () => {
    const { deps } = countingDeps(JSON.stringify(fleet1));
    expect(await fetchFleetJsonCached(deps, "acme-org/websites", "main")).toEqual(fleet1);
  });

  it("cache hit: a second call within the TTL does not refetch", async () => {
    const { deps, calls } = countingDeps(JSON.stringify(fleet1));
    await fetchFleetJsonCached(deps, "acme-org/websites", "main");
    await fetchFleetJsonCached(deps, "acme-org/websites", "main");
    expect(calls()).toBe(1);
  });

  it("keys the cache by repo@ref: the SAME ref but a different repo fetches independently", async () => {
    const a = countingDeps(JSON.stringify(fleet1));
    const b = countingDeps(JSON.stringify(fleet2));
    expect(await fetchFleetJsonCached(a.deps, "acme-org/websites", "main")).toEqual(fleet1);
    expect(await fetchFleetJsonCached(b.deps, "acme-org/other", "main")).toEqual(fleet2);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it("refetches once a cached entry is past the TTL", async () => {
    __seedFleetJsonCacheForTests("acme-org/websites", "main", ORG_CACHE_TTL_MS + 1000, fleet1);
    const { deps, calls } = countingDeps(JSON.stringify(fleet2));
    expect(await fetchFleetJsonCached(deps, "acme-org/websites", "main")).toEqual(fleet2);
    expect(calls()).toBe(1);
  });

  it("stale-on-error: a refresh failure past the TTL serves the old cached fleet.json instead of throwing", async () => {
    __seedFleetJsonCacheForTests("acme-org/websites", "main", ORG_CACHE_TTL_MS + 1000, fleet1);
    const deps: FleetJsonFetchDeps = { fetchFleetJsonFile: async () => { throw new Error("network down"); } };
    await expect(fetchFleetJsonCached(deps, "acme-org/websites", "main")).resolves.toEqual(fleet1);
  });

  it("throws when the very first fetch ever fails (nothing cached to fall back on)", async () => {
    const deps: FleetJsonFetchDeps = { fetchFleetJsonFile: async () => { throw new Error("network down"); } };
    await expect(fetchFleetJsonCached(deps, "acme-org/websites", "main")).rejects.toThrow("network down");
  });

  // --- the never-successful-ref amplification floor (same as org.json's) ---

  it("never-successful ref: a second call within the backoff window does not hit the fetcher again", async () => {
    let calls = 0;
    const deps: FleetJsonFetchDeps = {
      fetchFleetJsonFile: async () => {
        calls++;
        throw new Error("fetch fleet.json@bad failed (404): Not Found");
      },
    };
    await expect(fetchFleetJsonCached(deps, "acme-org/websites", "bad")).rejects.toThrow("404");
    expect(calls).toBe(1);
    await expect(fetchFleetJsonCached(deps, "acme-org/websites", "bad")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("never-successful ref: retries the fetcher once the backoff window has elapsed", async () => {
    __seedFleetJsonFailureForTests("acme-org/websites", "bad", ORG_RETRY_MS + 1000);
    const { deps, calls } = countingDeps(JSON.stringify(fleet1));
    expect(await fetchFleetJsonCached(deps, "acme-org/websites", "bad")).toEqual(fleet1);
    expect(calls()).toBe(1);
  });

  it("__resetFleetJsonCacheForTests clears both the cache and the never-successful backoff", async () => {
    __seedFleetJsonCacheForTests("acme-org/websites", "main", 1000, fleet1);
    let calls = 0;
    const failing: FleetJsonFetchDeps = { fetchFleetJsonFile: async () => { calls++; throw new Error("down"); } };
    // Within the TTL: served from the seeded cache, no fetch at all.
    expect(await fetchFleetJsonCached(failing, "acme-org/websites", "main")).toEqual(fleet1);
    expect(calls).toBe(0);

    __resetFleetJsonCacheForTests();
    await expect(fetchFleetJsonCached(failing, "acme-org/websites", "main")).rejects.toThrow("down");
    expect(calls).toBe(1);
  });

  it("a malformed fleet.json response is not cached and propagates as a BlueprintError", async () => {
    const deps: FleetJsonFetchDeps = { fetchFleetJsonFile: async () => "{not json" };
    await expect(fetchFleetJsonCached(deps, "acme-org/websites", "main")).rejects.toThrow(BlueprintError);
  });
});
