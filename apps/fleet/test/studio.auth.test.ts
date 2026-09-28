import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  verifyAccess, __resetJwksCacheForTests, __seedJwksCacheForTests,
  JWKS_TTL_MS, JWKS_MAX_STALE_MS, JWKS_RETRY_MS,
} from "../src/studio/auth";

// RS256 JWT signing helpers, local to this file only — verifyAccess itself
// never signs anything, only verifies, so nothing here belongs in src/.
// Mirrors src/github/app.ts's appJwt() (same algorithm, same b64url shape)
// run in the opposite direction: that file signs a JWT this fleet sends to
// GitHub; this signs a JWT standing in for one Cloudflare Access would send
// to this fleet.
const KID = "test-key-1";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

async function makeKeypair(): Promise<CryptoKeyPair> {
  // @cloudflare/workers-types declares generateKey with a single,
  // non-overloaded signature (Promise<CryptoKey | CryptoKeyPair>) — unlike
  // lib.dom.d.ts, it can't narrow the return type from the algorithm arg.
  // True at runtime either way; the cast only satisfies tsc (same carve-out
  // as test/github.app.test.ts's beforeAll).
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
    },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function signJwt(priv: CryptoKey, claims: { aud: string; exp: number }): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const payload = { aud: [claims.aud], iat: Math.floor(Date.now() / 1000), exp: claims.exp };
  const unsigned =
    `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

// The raw JWKS `keys` array for `pub` — shared by jwksFetcher (serves it
// over a mock fetch) and the cache-seeding tests (plant it directly).
async function jwksFor(pub: CryptoKey): Promise<JsonWebKeyWithKid[]> {
  const jwk = (await crypto.subtle.exportKey("jwk", pub)) as JsonWebKey;
  return [{ ...jwk, kid: KID }];
}

// Serves `pub`'s JWKS for any request — the real verifyAccess only ever
// calls this fetcher for the one certs URL it builds itself, so the mock
// does not need to inspect the input to be a faithful stand-in.
function jwksFetcher(pub: CryptoKey): typeof fetch {
  return (async () => Response.json({ keys: await jwksFor(pub) })) as typeof fetch;
}

// Same as jwksFetcher, but counts invocations — used to prove the
// module-level JWKS cache actually short-circuits (or doesn't) a fetch.
function countingJwksFetcher(pub: CryptoKey): { fetcher: typeof fetch; calls: () => number } {
  let n = 0;
  const fetcher = (async () => {
    n++;
    return Response.json({ keys: await jwksFor(pub) });
  }) as typeof fetch;
  return { fetcher, calls: () => n };
}

function reqWithToken(token: string): Request {
  return new Request("https://x/studio/a--b/status", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
}

const env = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud123" } as any;

// Review round 1, Important 2: every test in this file shares the
// module-level JWKS cache (it's process-global, not per-test — see
// auth.ts). Reset it before each test so no test's result depends on
// which one happened to run first or on which domain string it picked;
// correctness here comes from this reset, not from coincidence.
beforeEach(() => {
  __resetJwksCacheForTests();
});

describe("verifyAccess", () => {
  let goodKeypair: CryptoKeyPair;
  let rogueKeypair: CryptoKeyPair;

  beforeAll(async () => {
    goodKeypair = await makeKeypair();
    rogueKeypair = await makeKeypair();
  });

  it("null on valid jwt", async () => {
    const jwt = await signJwt(goodKeypair.privateKey, {
      aud: "aud123",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = new Request("https://x/studio/a--b/status", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    const r = await verifyAccess(req, env, jwksFetcher(goodKeypair.publicKey));
    expect(r).toBeNull();
  });

  it("401 when header missing", async () => {
    const r = await verifyAccess(new Request("https://x/studio/a--b/status"), env, fetch);
    expect(r?.status).toBe(401);
  });

  it("403 on wrong aud", async () => {
    const jwt = await signJwt(goodKeypair.privateKey, {
      aud: "not-aud123",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = new Request("https://x/studio/a--b/status", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    const r = await verifyAccess(req, env, jwksFetcher(goodKeypair.publicKey));
    expect(r?.status).toBe(403);
  });

  it("403 on expired", async () => {
    const jwt = await signJwt(goodKeypair.privateKey, {
      aud: "aud123",
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const req = new Request("https://x/studio/a--b/status", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    const r = await verifyAccess(req, env, jwksFetcher(goodKeypair.publicKey));
    expect(r?.status).toBe(403);
  });

  it("403 on bad signature", async () => {
    const jwt = await signJwt(rogueKeypair.privateKey, {
      aud: "aud123",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = new Request("https://x/studio/a--b/status", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    const r = await verifyAccess(req, env, jwksFetcher(goodKeypair.publicKey));
    expect(r?.status).toBe(403);
  });
});

describe("verifyAccess JWKS cache", () => {
  let kp: CryptoKeyPair;

  beforeAll(async () => {
    kp = await makeKeypair();
  });

  async function verifyWith(domainEnv: any, fetcher: typeof fetch): Promise<Response | null> {
    const jwt = await signJwt(kp.privateKey, {
      aud: domainEnv.ACCESS_AUD,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return verifyAccess(reqWithToken(jwt), domainEnv, fetcher);
  }

  it("does not invoke fetcher again on a second call for the same domain", async () => {
    const domainEnv = { ACCESS_TEAM_DOMAIN: "cache-hit.cloudflareaccess.com", ACCESS_AUD: "aud123" };
    const { fetcher, calls } = countingJwksFetcher(kp.publicKey);
    expect(await verifyWith(domainEnv, fetcher)).toBeNull();
    expect(await verifyWith(domainEnv, fetcher)).toBeNull();
    expect(calls()).toBe(1);
  });

  it("caches different domains independently", async () => {
    const envA = { ACCESS_TEAM_DOMAIN: "domain-a.cloudflareaccess.com", ACCESS_AUD: "aud123" };
    const envB = { ACCESS_TEAM_DOMAIN: "domain-b.cloudflareaccess.com", ACCESS_AUD: "aud123" };
    const a = countingJwksFetcher(kp.publicKey);
    const b = countingJwksFetcher(kp.publicKey);
    expect(await verifyWith(envA, a.fetcher)).toBeNull();
    expect(await verifyWith(envB, b.fetcher)).toBeNull();
    // Each domain must reach its OWN fetcher exactly once — if the cache
    // were keyed globally instead of per-domain, domain B's call would be
    // served from domain A's entry and b.calls() would read 0.
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it("refetches once a cached entry is past the TTL", async () => {
    const domain = "ttl-expiry.cloudflareaccess.com";
    const domainEnv = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud123" };
    __seedJwksCacheForTests(domain, JWKS_TTL_MS + 1000, await jwksFor(kp.publicKey)); // 1s past the TTL
    const { fetcher, calls } = countingJwksFetcher(kp.publicKey);
    expect(await verifyWith(domainEnv, fetcher)).toBeNull();
    expect(calls()).toBe(1); // the stale entry was not served as-is — a fresh fetch happened
  });

  it("does not refetch a cached entry still within the TTL", async () => {
    const domain = "ttl-fresh.cloudflareaccess.com";
    const domainEnv = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud123" };
    __seedJwksCacheForTests(domain, 1000, await jwksFor(kp.publicKey)); // 1s old, well within TTL
    const { fetcher, calls } = countingJwksFetcher(kp.publicKey);
    expect(await verifyWith(domainEnv, fetcher)).toBeNull();
    expect(calls()).toBe(0); // served straight from the seeded entry
  });

  it("does not cache a non-ok JWKS response", async () => {
    // Review round 1, Important 1 regression: a 429/5xx from the certs
    // endpoint must not get cached — that would 403 every /studio/* request
    // for a full TTL after upstream recovers.
    const domain = "bad-response.cloudflareaccess.com";
    const domainEnv = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud123" };
    let call = 0;
    const failThenSucceed = (async () => {
      call++;
      if (call === 1) return new Response("rate limited", { status: 429 });
      return Response.json({ keys: await jwksFor(kp.publicKey) });
    }) as typeof fetch;

    const first = await verifyWith(domainEnv, failThenSucceed);
    expect(first?.status).toBe(403); // fails closed, not thrown

    const second = await verifyWith(domainEnv, failThenSucceed);
    expect(second).toBeNull(); // second attempt refetches instead of reusing a poisoned entry
    expect(call).toBe(2);
  });

  it("does not cache a JWKS response without a keys array", async () => {
    const domain = "bad-shape.cloudflareaccess.com";
    const domainEnv = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud123" };
    let call = 0;
    const malformedThenSucceed = (async () => {
      call++;
      if (call === 1) return Response.json({ error: "internal" }); // 200, but no `keys`
      return Response.json({ keys: await jwksFor(kp.publicKey) });
    }) as typeof fetch;

    const first = await verifyWith(domainEnv, malformedThenSucceed);
    expect(first?.status).toBe(403);

    const second = await verifyWith(domainEnv, malformedThenSucceed);
    expect(second).toBeNull();
    expect(call).toBe(2);
  });

  it("serves stale cached keys when a refresh attempt fails", async () => {
    const domain = "stale-fallback.cloudflareaccess.com";
    const domainEnv = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud123" };
    __seedJwksCacheForTests(domain, JWKS_TTL_MS + 1000, await jwksFor(kp.publicKey)); // stale, but good, keys
    const alwaysFails = (async () => new Response("down", { status: 500 })) as typeof fetch;

    const r = await verifyWith(domainEnv, alwaysFails);
    expect(r).toBeNull(); // verified against the stale cache instead of the failing refresh
  });

  it("does not retry within the backoff window after a failed refresh", async () => {
    // Review round 2, Important 2: an outage must not turn every request
    // into a live outbound fetch. The FIRST failed refresh here should
    // still serve the stale-but-within-cap entry (same mechanism as the
    // test above); the point of THIS test is the second call, right after,
    // which must not touch the network again.
    const domain = "backoff.cloudflareaccess.com";
    const domainEnv = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud123" };
    __seedJwksCacheForTests(domain, JWKS_TTL_MS + 1000, await jwksFor(kp.publicKey)); // stale, within the cap
    let calls = 0;
    const alwaysFails = (async () => {
      calls++;
      return new Response("down", { status: 500 });
    }) as typeof fetch;

    const first = await verifyWith(domainEnv, alwaysFails);
    expect(first).toBeNull();
    expect(calls).toBe(1);

    const second = await verifyWith(domainEnv, alwaysFails);
    expect(second).toBeNull(); // still served from the same stale entry
    expect(calls).toBe(1); // backoff: no second network attempt within JWKS_RETRY_MS
  });

  it("fails closed once a cached entry is past the staleness cap", async () => {
    const domain = "past-cap.cloudflareaccess.com";
    const domainEnv = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud123" };
    __seedJwksCacheForTests(domain, JWKS_MAX_STALE_MS + 1000, await jwksFor(kp.publicKey)); // past the cap
    const alwaysFails = (async () => new Response("down", { status: 500 })) as typeof fetch;

    const r = await verifyWith(domainEnv, alwaysFails);
    expect(r?.status).toBe(403); // no key set is trusted forever, even a once-valid one
  });

  it("retries the fetcher once the backoff window has elapsed", async () => {
    const domain = "backoff-elapsed.cloudflareaccess.com";
    const domainEnv = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud123" };
    // Stale enough to need a refresh, well within the staleness cap; the
    // last (failed) attempt was just over JWKS_RETRY_MS ago, so the backoff
    // window has already elapsed by the time this request lands.
    __seedJwksCacheForTests(
      domain, JWKS_TTL_MS + 1000, await jwksFor(kp.publicKey), JWKS_RETRY_MS + 1000,
    );
    const { fetcher, calls } = countingJwksFetcher(kp.publicKey); // this attempt succeeds
    const r = await verifyWith(domainEnv, fetcher);
    expect(r).toBeNull();
    expect(calls()).toBe(1); // backoff had lapsed, so a fresh fetch WAS attempted
  });
});

describe("verifyAccess never throws on a malformed token", () => {
  // Review round 1, Important 3 regression: the fix that put JWKS-fetch and
  // signature verification inside one try/catch (so verifyAccess always
  // resolves a Response, never throws) is only real if something exercises
  // the paths it was fixing. An assertion on r?.status is enough on its
  // own: if verifyAccess threw instead of resolving, the `await` below
  // would reject and fail the test before reaching the expect() at all.
  const domainEnv = { ACCESS_TEAM_DOMAIN: "malformed.cloudflareaccess.com", ACCESS_AUD: "aud123" } as any;

  it("resolves 403 for a token with no dots", async () => {
    const r = await verifyAccess(reqWithToken("abc"), domainEnv, fetch);
    expect(r?.status).toBe(403);
  });

  it("resolves 403 for a token with only two segments", async () => {
    const r = await verifyAccess(reqWithToken("a.b"), domainEnv, fetch);
    expect(r?.status).toBe(403);
  });

  it("resolves 403 for a structurally valid header/payload with a garbage signature segment", async () => {
    const kp = await makeKeypair();
    const jwt = await signJwt(kp.privateKey, { aud: "aud123", exp: Math.floor(Date.now() / 1000) + 3600 });
    const [headerB64, payloadB64] = jwt.split(".");
    const garbageToken = `${headerB64}.${payloadB64}.###not-base64url###`;
    const r = await verifyAccess(reqWithToken(garbageToken), domainEnv, jwksFetcher(kp.publicKey));
    expect(r?.status).toBe(403);
  });
});
