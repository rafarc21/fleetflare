// Org chart parsing + spawn-auth token minting — Fleet Spawn (P3), Task 1.
//
// Two concerns share this file because both are "spawn" plumbing with no
// other home yet (the /fleet/spawn route itself is a later P3 task — this
// file only builds what that route will need, per R-P3-1/R-P3-2):
//   - org.json: the same `{edges, gates}` shape blueprint.ts's fleet.json/
//     role-file parsers already establish (see fleet/blueprint/org.json).
//     Reuses blueprint.ts's own BlueprintError rather than a sibling error
//     class — "BlueprintError naming the field" is this feature's one
//     error contract, not a per-file one. maySpawn(org, parent, child) is
//     the one predicate a spawn route needs: R-P3-1's "Worker is law" —
//     spawn requests validate against org.json's edges SERVER-side.
//   - mintSpawnToken/fetchOrgCached: R-P3-1's per-studio spawn-auth token
//     (`fsp_` + 64 lowercase hex, crypto-random) and a module-level cache
//     for org.json fetches, mirroring auth.ts's JWKS cache SHAPE (TTL,
//     refetch-on-expiry, stale-on-error, retry backoff, __reset/__seed test
//     hooks) minus its one staleness CAP: org.json is repo-controlled
//     config a human wrote, not a security boundary that can be silently
//     revoked out from under a live signing key, so serving a
//     stale-but-once-valid copy indefinitely (once nothing fresher is
//     reachable) is the right failure mode here — unlike JWKS, this never
//     fails closed. See auth.ts's own header for the pattern this mirrors.

import { BlueprintError, parseFleetJson, type FleetConfig } from "./blueprint";

export interface Org {
  edges: Record<string, string[]>;
  gates: Record<string, string[]>;
}

/**
 * Validates `obj[field]` is a `Record<string, string[]>` — the shape both
 * `edges` and `gates` share. Any problem within the section (missing, not
 * an object, or one value not an array of strings) throws BlueprintError
 * naming the top-level field, the same granularity blueprint.ts's
 * parseFleetJson uses for its own `roles` array (one field name covers the
 * whole section's validity, not a per-entry path).
 */
function requireRoleMap(obj: Record<string, unknown>, field: string): Record<string, string[]> {
  const value = obj[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BlueprintError(field, "missing or not an object");
  }
  for (const [role, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list) || !list.every((r) => typeof r === "string")) {
      throw new BlueprintError(field, `value for "${role}" must be an array of strings`);
    }
  }
  return value as Record<string, string[]>;
}

/**
 * Parses org.json (blueprint repo, pinned ref — see fetchOrgCached below
 * for the fetch+cache side). Throws BlueprintError naming the exact
 * missing/malformed field, same contract as blueprint.ts's parsers.
 */
export function parseOrgJson(s: string): Org {
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch (err) {
    throw new BlueprintError("org.json", `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BlueprintError("org.json", "must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  return {
    edges: requireRoleMap(obj, "edges"),
    gates: requireRoleMap(obj, "gates"),
  };
}

/**
 * R-P3-1's server-side spawn check: may `parentRole` spawn `childRole`?
 * Unknown parent (no `edges` entry at all) and unknown/undeclared child
 * (not in the parent's own list) both read as "no array to find it in" and
 * fall through to `false` — no special-casing needed. Self-spawn is the
 * same: false unless the role explicitly lists itself as its own child
 * (`edges: { release: ["release"] }`), which `.includes` already handles
 * with no extra branch. Role files (may_spawn frontmatter) are advisory
 * only — this is the one function the Worker actually trusts.
 */
export function maySpawn(org: Org, parentRole: string, childRole: string): boolean {
  return org.edges[parentRole]?.includes(childRole) ?? false;
}

// 32 random bytes -> 64 hex chars. `fsp_` prefix (Fleet SPawn) is what makes
// this token shape independently greppable/redactable — see redact.ts's own
// FSP_RE, added alongside this.
const SPAWN_TOKEN_BYTES = 32;

/**
 * Mints one spawn-auth token: `fsp_` + 64 lowercase hex, crypto-random
 * (`crypto.getRandomValues` — synchronous Web Crypto, available in the
 * Workers runtime with no `await`, which is what lets do.ts's StudioDO call
 * this from a synchronous class-field initializer as well as from
 * provision()).
 *
 * **Static per STUDIO** — Task 6 ruling, narrowed from the original "static
 * per provision". The design doc's reasoning against rotating on refresh
 * ("rotation = churn without threat model; container compromise = token
 * compromise either way") applies just as squarely to re-provision, and
 * reminting there was actively harmful: a container's environment is fixed
 * when it STARTS, so a remint against a running studio published a hash for a
 * token that container would never hold, breaking its spawns until it
 * recycled. do.ts's ensureSpawnToken therefore mints only when a studio has
 * no token at all; rotation is an explicit operator procedure (delete the DO
 * key, recycle the container, provision — OPERATOR-FINISH-LIST §9).
 */
export function mintSpawnToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SPAWN_TOKEN_BYTES));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `fsp_${hex}`;
}

/**
 * Fleet Spawn P3, Task 2: sha256 of a spawn token, lowercase hex. This is
 * what the registry stores (StudioStatus.spawnTokenHash) — the token itself
 * is never written to D1, only to the studio's own DO storage and its
 * container env. /fleet/spawn resolves the calling studio by hashing the
 * presented token and matching that hash against registry rows.
 *
 * Plain `===` on the resulting hex strings is the intended comparison, and
 * deliberately NOT a hand-rolled timing-safe compare: a timing-safe compare
 * protects a secret the attacker is trying to guess byte by byte, and the
 * stored value here is a DIGEST the attacker cannot steer — every candidate
 * token they try lands on an effectively random 256-bit point, so leaked
 * per-byte timing on the digest comparison reveals nothing about the 32
 * random bytes of the preimage they would actually need. (Web Crypto exposes
 * no timingSafeEqual in the Workers runtime; the alternative would be a
 * hand-rolled double-HMAC, i.e. more crypto code for no threat it closes.)
 * The route still shape-checks the presented value BEFORE hashing — see
 * spawn.ts's isSpawnTokenShaped.
 *
 * Standard SHA-256 via crypto.subtle, same helper shape provision.ts's own
 * sha256Hex uses for the session-restore manifest.
 */
export async function hashSpawnToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// fetchOrgCached — module-level cache, mirrors auth.ts's jwksCache shape
// minus the staleness cap (see this file's own header for why).
// ---------------------------------------------------------------------------

interface CachedOrg {
  fetched: number;
  org: Org;
  /** Set only after a FAILED refresh attempt; absent after a successful
   *  fetch — same meaning as auth.ts's CachedJwks.lastAttempt. */
  lastAttempt?: number;
}

// Keyed by ref alone, not repo+ref: this fleet's blueprint is one repo
// (fleet.json's own `blueprint.repo`) — see this file's header.
const orgCache = new Map<string, CachedOrg>();

/**
 * Fleet Spawn P3, Task 2 (review carry-over from Task 1): the SAME backoff
 * `CachedOrg.lastAttempt` gives a ref that once succeeded, for the ref that
 * NEVER has. Keyed by ref, value = the last failed attempt's timestamp.
 *
 * Task 1's cache only backed off refs with something cached to fall back on;
 * a ref whose very first fetch failed (a bad pin, a deleted tag, a blueprint
 * repo the installation cannot read) fell straight through to the live
 * fetcher on every single call. That was harmless while the only caller was
 * provision (operator-driven, Access-gated), and is not once /fleet/spawn
 * exists: that route is network-reachable and authenticated by a token a
 * container holds, so one studio calling it in a loop against a broken pin
 * would amplify into unbounded outbound GitHub traffic. Same ORG_RETRY_MS
 * floor, same per-ref granularity — a broken ref costs at most one fetch
 * attempt per minute no matter how often it is asked for.
 *
 * A separate map rather than a nullable `org` on CachedOrg: every reader of
 * `orgCache` treats an entry as "an org we can serve", and widening that to
 * "maybe an org" would put a null check on the two hot paths above for the
 * sake of the cold one.
 */
const orgFailures = new Map<string, number>();

export const ORG_CACHE_TTL_MS = 300_000; // 300s — the design spec's own number.
// Same backoff floor as auth.ts's JWKS_RETRY_MS, same reason: an outage must
// not turn every spawn call into a live outbound GitHub fetch.
export const ORG_RETRY_MS = 60_000;

export interface OrgFetchDeps {
  /**
   * Fetches org.json's raw text at the given ref. Deliberately narrow (ref
   * in, text out) — the caller supplies repo/path/installation-token
   * context, the same split auth.ts's fetchJwks draws between `domain`
   * (caller-supplied) and `fetcher` (the generic mechanism). A caller
   * already holding a `ProvisionDeps.fetchBlueprintFile`-shaped function
   * adapts it in one line: `(ref) => fetchBlueprintFile(repo, ORG_JSON_PATH, ref)`.
   */
  fetchOrgFile: (ref: string) => Promise<string>;
}

/**
 * Fetches + parses org.json at `ref`, through a 300s module cache. On a
 * cache hit within the TTL, returns immediately with no fetch. Past the
 * TTL, attempts a refetch: success repopulates the cache; failure serves
 * the held-stale entry instead (logged, never thrown) — UNLIKE auth.ts's
 * JWKS cache, there is no staleness cap here, so a stale-but-once-valid org
 * is served indefinitely rather than eventually failing closed (see this
 * file's header for why that's the right call for repo-controlled config).
 * A failed refetch also gates the same ORG_RETRY_MS backoff JWKS uses, so a
 * sustained GitHub outage costs one fetch attempt per minute, not one per
 * spawn call. Only when NOTHING has ever been cached does a failure
 * propagate — there is nothing to fall back on — and that case gets the SAME
 * one-attempt-per-ORG_RETRY_MS floor via `orgFailures` (see its own doc
 * comment): it keeps throwing for the rest of the window, but without
 * touching the network again.
 */
export async function fetchOrgCached(deps: OrgFetchDeps, ref: string): Promise<Org> {
  const cached = orgCache.get(ref);
  const now = Date.now();
  if (cached && now - cached.fetched < ORG_CACHE_TTL_MS) return cached.org;

  if (cached?.lastAttempt !== undefined && now - cached.lastAttempt < ORG_RETRY_MS) {
    return cached.org;
  }

  // Only reachable with nothing cached for this ref (a cached entry takes one
  // of the two branches above, or refetches below and clears this on
  // success) — the never-successful case, whose only honest answer is the
  // same error, minus the fetch.
  const failedAt = orgFailures.get(ref);
  if (failedAt !== undefined && now - failedAt < ORG_RETRY_MS) {
    throw new Error(`org.json for ref ${ref} is in failure backoff (last attempt ${now - failedAt}ms ago)`);
  }

  try {
    const org = parseOrgJson(await deps.fetchOrgFile(ref));
    orgCache.set(ref, { fetched: now, org });
    orgFailures.delete(ref);
    return org;
  } catch (err) {
    console.error(`org.json refresh failed for ref ${ref}`, err);
    if (!cached) {
      orgFailures.set(ref, now);
      throw err;
    }
    orgCache.set(ref, { ...cached, lastAttempt: now });
    return cached.org;
  }
}

// Test-only surface — same reset/seed pair auth.ts exposes, for the same
// reason: deterministic cache-age control without depending on real
// elapsed time or test execution order (the cache is process-global).
export function __resetOrgCacheForTests(): void {
  orgCache.clear();
  orgFailures.clear();
}

export function __seedOrgCacheForTests(
  ref: string, ageMs: number, org: Org, lastAttemptAgeMs?: number,
): void {
  const now = Date.now();
  const entry: CachedOrg = { fetched: now - ageMs, org };
  if (lastAttemptAgeMs !== undefined) entry.lastAttempt = now - lastAttemptAgeMs;
  orgCache.set(ref, entry);
}

/** Seeds the never-successful backoff (orgFailures) for one ref, `ageMs`
 *  ago — the counterpart of __seedOrgCacheForTests's `lastAttemptAgeMs` for
 *  the case where nothing was ever cached. */
export function __seedOrgFailureForTests(ref: string, ageMs: number): void {
  orgFailures.set(ref, Date.now() - ageMs);
}

// ---------------------------------------------------------------------------
// Fleet Spawn P3, Task 4 (R-P3-3, review carry from Task 2's I4): fleet.json
// gets the SAME cache shape as fetchOrgCached above — TTL, refetch-on-
// expiry, stale-on-error, never-successful backoff floor, all at the same
// 300s/60s numbers (see fetchOrgCached's own doc comment for the full
// reasoning behind each of those). org.json and fleet.json are both files a
// spawn call reads out of the SAME shared GitHub App installation's rate
// limit, via spawn.ts's resolveSpawnPolicy — that function's own doc comment
// used to argue fleet.json should stay uncached ("caching it would pin the
// ref against exactly the change an operator makes... keeps `roles`
// honest"), which was a fine tradeoff while /studio/spawn (Access-gated,
// human-paced) was the only caller. /fleet/spawn is neither: it is
// network-reachable and authenticated by a token a CONTAINER holds, so one
// studio spawning in a loop would amplify into unbounded fleet.json reads
// against the same installation the org cache already had to defend against
// (Task 2's own carry, closed there for org.json — this closes the other
// half). A short cache trades a little staleness (a fleet.json roles/ref
// edit takes up to TTL to take effect on a spawn decision — no worse a
// tradeoff than org.json's own, already-accepted one) for the same
// amplification defence.
//
// Extracted into a small generic helper rather than a hand-copied second
// block: the two caches must behave IDENTICALLY (same TTL/backoff shape,
// stated above), and one shared implementation is what actually guarantees
// that rather than merely documenting it — a future edit to one copy's
// timing logic without the other is exactly the kind of drift this avoids.
// `fetchOrgCached` above is untouched by this (zero behavior change to
// already-shipped, already-reviewed code): this factory is new code, used
// only to build the fleet.json cache below.
// ---------------------------------------------------------------------------

interface CachedRef<T> {
  fetched: number;
  value: T;
  /** Set only after a FAILED refresh attempt — same meaning as CachedOrg's
   *  own `lastAttempt` above. */
  lastAttempt?: number;
}

/**
 * Builds one independent cache instance: its own `Map` pair, closed over by
 * the four functions returned. A factory, not a shared module-level cache,
 * so org.json's cache (above) and fleet.json's (below) never share a
 * keyspace even though both happen to key on a plain string — a fresh call
 * per consumer, not a generic registry keyed by type.
 */
function createRefCache<T>(ttlMs: number, retryMs: number) {
  const cache = new Map<string, CachedRef<T>>();
  const failures = new Map<string, number>();

  // Mirrors fetchOrgCached's own body exactly (see that function's doc
  // comment for the line-by-line reasoning) — `fetchFn`/`key` stand in for
  // `deps.fetchOrgFile`/`ref`.
  async function fetchCached(fetchFn: (key: string) => Promise<T>, key: string): Promise<T> {
    const cached = cache.get(key);
    const now = Date.now();
    if (cached && now - cached.fetched < ttlMs) return cached.value;

    if (cached?.lastAttempt !== undefined && now - cached.lastAttempt < retryMs) {
      return cached.value;
    }

    const failedAt = failures.get(key);
    if (failedAt !== undefined && now - failedAt < retryMs) {
      throw new Error(`ref ${key} is in failure backoff (last attempt ${now - failedAt}ms ago)`);
    }

    try {
      const value = await fetchFn(key);
      cache.set(key, { fetched: now, value });
      failures.delete(key);
      return value;
    } catch (err) {
      console.error(`cached ref fetch failed for ${key}`, err);
      if (!cached) {
        failures.set(key, now);
        throw err;
      }
      cache.set(key, { ...cached, lastAttempt: now });
      return cached.value;
    }
  }

  function __reset(): void {
    cache.clear();
    failures.clear();
  }

  function __seed(key: string, ageMs: number, value: T, lastAttemptAgeMs?: number): void {
    const now = Date.now();
    const entry: CachedRef<T> = { fetched: now - ageMs, value };
    if (lastAttemptAgeMs !== undefined) entry.lastAttempt = now - lastAttemptAgeMs;
    cache.set(key, entry);
  }

  function __seedFailure(key: string, ageMs: number): void {
    failures.set(key, Date.now() - ageMs);
  }

  return { fetchCached, __reset, __seed, __seedFailure };
}

const fleetJsonRefCache = createRefCache<FleetConfig>(ORG_CACHE_TTL_MS, ORG_RETRY_MS);

export interface FleetJsonFetchDeps {
  /** Fetches fleet.json's raw text for `repo` at `ref` — the same split
   *  OrgFetchDeps.fetchOrgFile draws, generalised to also carry `repo`
   *  (fleet.json's cache key, unlike org.json's, is `repo@ref` — see
   *  fetchFleetJsonCached's own doc comment for why). */
  fetchFleetJsonFile: (repo: string, ref: string) => Promise<string>;
}

/**
 * Fetches + parses fleet.json for `repo` at `ref`, through the same
 * TTL/backoff cache fetchOrgCached uses (see this section's own header).
 * Keyed by `repo@ref`, not ref alone: fleet.json is read per TARGET repo
 * (spawn.ts's resolveSpawnPolicy calls this with `env.AGENT_REPO`), and
 * while today's single-repo deployment never actually varies that, keying
 * on the repo too is what keeps this cache correct if that ever changes,
 * for the same reason a cache keyed on the wrong dimension would silently
 * serve one repo's fleet.json to a request about another.
 */
export async function fetchFleetJsonCached(
  deps: FleetJsonFetchDeps, repo: string, ref: string,
): Promise<FleetConfig> {
  return fleetJsonRefCache.fetchCached(
    async () => parseFleetJson(await deps.fetchFleetJsonFile(repo, ref)),
    `${repo}@${ref}`,
  );
}

// Test-only surface — same shape as fetchOrgCached's own __reset/__seed pair,
// keyed by `repo@ref` to match fetchFleetJsonCached above.
export function __resetFleetJsonCacheForTests(): void {
  fleetJsonRefCache.__reset();
}

export function __seedFleetJsonCacheForTests(
  repo: string, ref: string, ageMs: number, fleet: FleetConfig, lastAttemptAgeMs?: number,
): void {
  fleetJsonRefCache.__seed(`${repo}@${ref}`, ageMs, fleet, lastAttemptAgeMs);
}

export function __seedFleetJsonFailureForTests(repo: string, ref: string, ageMs: number): void {
  fleetJsonRefCache.__seedFailure(`${repo}@${ref}`, ageMs);
}
