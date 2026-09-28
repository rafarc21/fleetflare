import type { Env } from "../env";

interface AccessJwtHeader {
  kid?: string;
}

interface AccessJwtPayload {
  aud?: string | string[];
  exp?: number;
}

interface CachedJwks {
  fetched: number;
  keys: JsonWebKeyWithKid[];
  /** Set only after a FAILED refresh attempt; absent after a successful
   * fetch. Gates the JWKS_RETRY_MS backoff below — cleared implicitly the
   * next time a fetch succeeds, since that write replaces the whole entry. */
  lastAttempt?: number;
}

// Per-team-domain, not per-request: the same JWKS backs every /studio/*
// request an isolate handles, and Cloudflare's own certs endpoint expects
// callers to cache rather than hit it on every verification.
const jwksCache = new Map<string, CachedJwks>();
export const JWKS_TTL_MS = 3600 * 1000;
// Review round 2, Important: without a cap, a permanently-failing certs
// endpoint means a stale entry is trusted forever — including through a
// key rotation that revoked the signing key mid-outage. Without a retry
// floor, an outage turns every single /studio/* request into a live
// outbound fetch for its whole duration. Exported so
// test/studio.auth.test.ts asserts against these by name instead of
// duplicating the numbers as magic constants — not because verifyAccess's
// callers (Task 4) need them.
export const JWKS_MAX_STALE_MS = 2 * JWKS_TTL_MS;
export const JWKS_RETRY_MS = 60_000;

// Serves the held-stale entry if it's still within the staleness cap;
// fails closed (throws, logging the staleness) once it isn't. Shared by
// both places a refresh can end up not happening: backing off a retry, and
// a retry that was attempted but failed.
function staleOrThrow(domain: string, cached: CachedJwks, now: number): JsonWebKeyWithKid[] {
  const age = now - cached.fetched;
  if (age < JWKS_MAX_STALE_MS) return cached.keys;
  console.error(
    `JWKS for ${domain} is ${age}ms stale (cap ${JWKS_MAX_STALE_MS}ms) and the last refresh ` +
    "attempt failed — refusing to serve",
  );
  throw new Error(`JWKS for ${domain} exceeds max staleness`);
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToStr(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function fetchJwks(domain: string, fetcher: typeof fetch): Promise<JsonWebKeyWithKid[]> {
  const cached = jwksCache.get(domain);
  const now = Date.now();
  if (cached && now - cached.fetched < JWKS_TTL_MS) return cached.keys;

  // Review round 2, Important 2: an outage must not turn every single
  // /studio/* request into a live outbound fetch. Once a refresh has
  // failed, wait JWKS_RETRY_MS before trying the network again — serve the
  // held-stale entry (or fail closed past the staleness cap) in the
  // meantime, exactly as a fresh failure does below.
  if (cached?.lastAttempt !== undefined && now - cached.lastAttempt < JWKS_RETRY_MS) {
    return staleOrThrow(domain, cached, now);
  }

  try {
    const res = await fetcher(`https://${domain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error("JWKS response missing a keys array");
    const keys = body.keys as JsonWebKeyWithKid[];
    jwksCache.set(domain, { fetched: now, keys });
    return keys;
  } catch (err) {
    // Review round 1, Important 1: a bad or unreachable JWKS response must
    // never get cached — that would poison every /studio/* request for the
    // full TTL, well after upstream recovers, with nothing logged. If a
    // previous good fetch is still on hand, serve that instead of treating
    // one failed refresh as a hard failure — a stale-but-once-valid key set
    // still fails a live JWT safely if the signing key has actually rotated
    // since, up to the staleness cap enforced by staleOrThrow. Only when
    // there is no prior fetch to fall back on does this propagate, for
    // verifyAccess's own catch to turn into a 403.
    console.error(`JWKS refresh failed for ${domain}`, err);
    if (!cached) throw err;
    jwksCache.set(domain, { ...cached, lastAttempt: now });
    return staleOrThrow(domain, cached, now);
  }
}

// Test-only surface: verifyAccess's public contract (what Task 4 consumes)
// is exactly the one export at the bottom of this file. These two exist
// solely so test/studio.auth.test.ts can reset and seed the module-level
// cache deterministically, instead of depending on real elapsed time or on
// which test happens to run first.
export function __resetJwksCacheForTests(): void {
  jwksCache.clear();
}

export function __seedJwksCacheForTests(
  domain: string, ageMs: number, keys: JsonWebKeyWithKid[], lastAttemptAgeMs?: number,
): void {
  const now = Date.now();
  const entry: CachedJwks = { fetched: now - ageMs, keys };
  if (lastAttemptAgeMs !== undefined) entry.lastAttempt = now - lastAttemptAgeMs;
  jwksCache.set(domain, entry);
}

/**
 * Gate for every /studio/* route. Cloudflare Access sits in front of this
 * Worker and injects `Cf-Access-Jwt-Assertion` on every request it lets
 * through; this re-verifies that JWT rather than trusting the header's mere
 * presence, since anything reaching the Worker's own origin (not just
 * through Access) could set the same header itself.
 *
 * Returns `null` when the request is authorized — the caller proceeds.
 * Otherwise returns the Response to send back directly: 401 only when the
 * header is missing outright (the request never went through Access at
 * all); every other failure — malformed token, unknown `kid`, bad
 * signature, wrong audience, expired — is 403, since each of those is a
 * token Access (or an attacker) did present, just not a valid one.
 */
export async function verifyAccess(
  req: Request, env: Env, fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return new Response("unauthorized", { status: 401 });

  // One try/catch around the whole verification path, not just JSON.parse:
  // a malformed base64url segment (bad length, stray characters) throws out
  // of atob, and a JWKS fetch can throw outright (network error) rather than
  // resolve to a non-ok Response. Both are attacker- or environment-
  // triggerable, and this function's entire contract is to resolve to a
  // Response, never throw — every route behind it depends on that.
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return new Response("forbidden", { status: 403 });
    const [headerB64, payloadB64, sigB64] = parts;

    const header: AccessJwtHeader = JSON.parse(b64urlToStr(headerB64));
    const payload: AccessJwtPayload = JSON.parse(b64urlToStr(payloadB64));

    const keys = await fetchJwks(env.ACCESS_TEAM_DOMAIN, fetcher);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return new Response("forbidden", { status: 403 });

    const publicKey = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlToBytes(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return new Response("forbidden", { status: 403 });

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return new Response("forbidden", { status: 403 });

    if (!payload.exp || payload.exp * 1000 <= Date.now()) {
      return new Response("forbidden", { status: 403 });
    }
    return null;
  } catch {
    return new Response("forbidden", { status: 403 });
  }
}
