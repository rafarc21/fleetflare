import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { installationEnvName, mintInstallationToken } from "../src/github/app";

let pem: string;
let publicKey: CryptoKey;
let headers: Record<string, string>[] = [];
let urls: string[] = [];
let bodies: (string | undefined)[] = [];
let realFetch: typeof globalThis.fetch;
let respond: () => Response;

beforeAll(async () => {
  // @cloudflare/workers-types declares generateKey/exportKey with single,
  // non-overloaded signatures (Promise<CryptoKey | CryptoKeyPair>,
  // Promise<ArrayBuffer | JsonWebKey>) — unlike lib.dom.d.ts, it can't narrow
  // the return type from the algorithm/format arguments. True at runtime
  // either way; the casts only satisfy tsc.
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  publicKey = kp.publicKey;
});

const env = () => ({
  GITHUB_APP_ID: "12345",
  GITHUB_INSTALLATION_ID: "99",
  GITHUB_APP_PRIVATE_KEY: pem,
}) as any;

beforeEach(() => {
  headers = [];
  urls = [];
  bodies = [];
  respond = () => Response.json({ token: "ghs_installation_token" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    urls.push(typeof input === "string" ? input : input.url);
    headers.push(init.headers as Record<string, string>);
    bodies.push(init.body as string | undefined);
    return respond();
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

function decodeJwtPayload(auth: string): any {
  const jwt = auth.replace("Bearer ", "");
  const [, payload] = jwt.split(".");
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
}

describe("mintInstallationToken", () => {
  it("returns the installation token GitHub issues", async () => {
    expect(await mintInstallationToken(env(), "acme-org", "acme-org/websites")).toBe("ghs_installation_token");
  });

  it("authenticates with a three-segment RS256 JWT", async () => {
    await mintInstallationToken(env(), "acme-org", "acme-org/websites");
    const jwt = headers[0].authorization.replace("Bearer ", "");
    expect(jwt.split(".")).toHaveLength(3);
    const header = JSON.parse(atob(jwt.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    expect(header.alg).toBe("RS256");
  });

  it("produces a signature that verifies against the app's own public key", async () => {
    // Carve-out B (final-review fix wave). None of the tests in this file
    // cryptographically verify the signature — they only inspect the JWT's
    // shape and claims. Swapping hash: "SHA-256" for SHA-512 in appJwt's
    // signing importKey call, while leaving the header's alg: "RS256"
    // untouched, would pass every other test here (three segments, correct
    // alg string, iss, exp/iat, the PKCS#1 message) and still 401 in
    // production the moment GitHub verifies it against RS256/SHA-256. This
    // is the only assertion that would catch that.
    await mintInstallationToken(env(), "acme-org", "acme-org/websites");
    const jwt = headers[0].authorization.replace("Bearer ", "");
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(
      atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0),
    );

    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" }, publicKey, signature, signedData,
    );

    expect(valid).toBe(true);
  });

  it("issues the JWT for the app, within GitHub's 10-minute ceiling", async () => {
    await mintInstallationToken(env(), "acme-org", "acme-org/websites");
    const p = decodeJwtPayload(headers[0].authorization);
    expect(p.iss).toBe("12345");
    expect(p.exp - p.iat).toBeLessThanOrEqual(600);
  });

  it("back-dates iat to absorb clock skew", async () => {
    await mintInstallationToken(env(), "acme-org", "acme-org/websites");
    const p = decodeJwtPayload(headers[0].authorization);
    expect(p.iat).toBeLessThan(Math.floor(Date.now() / 1000));
  });

  it("throws GitHub's own message on a non-2xx", async () => {
    respond = () => new Response('{"message":"Bad credentials"}', { status: 401 });
    await expect(mintInstallationToken(env(), "acme-org", "acme-org/websites")).rejects.toThrow(/Bad credentials/);
  });

  it("refuses to run unconfigured rather than sending an empty JWT", async () => {
    await expect(
      mintInstallationToken({ ...env(), GITHUB_APP_PRIVATE_KEY: "" }, "acme-org", "acme-org/websites"),
    ).rejects.toThrow(/not configured/);
  });

  it("fails actionably on a PKCS#1 key instead of an opaque Web Crypto error", async () => {
    // Review round 1, Important 2: GitHub's App-settings page hands out
    // PKCS#1 (`BEGIN RSA PRIVATE KEY`); importKey("pkcs8", …) only accepts
    // PKCS#8 (`BEGIN PRIVATE KEY`, what this file's own beforeAll generates
    // via exportKey("pkcs8", …) — this suite could never catch the mismatch
    // on its own). Left unchecked, this reaches crypto.subtle.importKey and
    // fails with an opaque DataError that doesn't say what's wrong or how
    // to fix it — the operator's very first real merge.
    const pkcs1 =
      "-----BEGIN RSA PRIVATE KEY-----\nnot-real-key-bytes\n-----END RSA PRIVATE KEY-----";
    await expect(
      mintInstallationToken({ ...env(), GITHUB_APP_PRIVATE_KEY: pkcs1 }, "acme-org", "acme-org/websites"),
    ).rejects.toThrow(/PKCS#1/);
  });
});

// ---------------------------------------------------------------------------
// P6c — per-owner installation ids, the App-side mirror of P6b's per-owner
// tokens. GitHub Apps install per ACCOUNT, so ONE GITHUB_INSTALLATION_ID can
// only ever cover the one org it was minted for — measured 2026-09-16, only
// `acme-org` (2222222) was reachable through the App path; `demositeltda`,
// `acme-hq` and `demositellc` had no installation path at all. An owner may
// now bring its own `GITHUB_INSTALLATION_ID_<OWNER>`, with the shared
// `GITHUB_INSTALLATION_ID` as the declared default for every owner with none.

describe("installationEnvName — the owner -> installation-id-var contract", () => {
  it("uppercases and replaces every non-alphanumeric with _, mirroring tokenEnvName", () => {
    // THE contract the operator types into `wrangler secret put` (or, for this
    // one, `vars` — an installation id is not a secret, but the name shape is
    // pinned the same way tokenEnvName's is: change it and an already-set
    // per-owner id silently stops being found.
    expect(installationEnvName("acme-hq")).toBe("GITHUB_INSTALLATION_ID_ACME_HQ");
    expect(installationEnvName("demositeltda")).toBe("GITHUB_INSTALLATION_ID_DEMOSITELTDA");
    expect(installationEnvName("acme-org")).toBe("GITHUB_INSTALLATION_ID_ACME_ORG");
    expect(installationEnvName("foo.bar")).toBe("GITHUB_INSTALLATION_ID_FOO_BAR");
  });
});

describe("mintInstallationToken — per-owner installation ids", () => {
  it("mints against the owner's OWN installation id when set, not the shared default", async () => {
    const perOwner = { ...env(), GITHUB_INSTALLATION_ID_ACME_HQ: "555" };
    await mintInstallationToken(perOwner, "acme-hq", "acme-hq/acme-os");
    expect(urls[0]).toBe("https://api.github.com/app/installations/555/access_tokens");
  });

  it("falls back to the shared GITHUB_INSTALLATION_ID when the owner has none of its own", async () => {
    await mintInstallationToken(env(), "demositeltda", "demositeltda/site");
    expect(urls[0]).toBe("https://api.github.com/app/installations/99/access_tokens");
  });

  it("never lets one owner's installation id answer for another owner", async () => {
    const perOwner = { ...env(), GITHUB_INSTALLATION_ID_ACME_HQ: "555" };
    await mintInstallationToken(perOwner, "acme-org", "acme-org/websites");
    expect(urls[0]).toBe("https://api.github.com/app/installations/99/access_tokens");
  });

  it("treats an empty per-owner installation id as absent, falling back to the shared default", async () => {
    const perOwner = { ...env(), GITHUB_INSTALLATION_ID_ACME_HQ: "" };
    await mintInstallationToken(perOwner, "acme-hq", "acme-hq/acme-os");
    expect(urls[0]).toBe("https://api.github.com/app/installations/99/access_tokens");
  });

  it("refuses to run when NEITHER the owner's own id nor the shared default is set", async () => {
    await expect(
      mintInstallationToken({ ...env(), GITHUB_INSTALLATION_ID: "" }, "acme-hq", "acme-hq/acme-os"),
    ).rejects.toThrow(/not configured/);
  });
});

// ---------------------------------------------------------------------------
// Issue #331 — MUST-fix, security. A token minted with no request body at all
// is valid for EVERY repo the installation covers, not just the one caller
// that asked for it. Studios run root + --dangerously-skip-permissions, so
// this token sits in a container reachable by anything that container runs —
// a studio compromised or misbehaving on repo A had write access to every
// OTHER repo the same installation covers. `repositories` on this same
// `access_tokens` POST body narrows the mint to exactly the repo(s) named.

describe("mintInstallationToken — scopes the mint to the caller's own repo (#331)", () => {
  it("sends the SHORT repo name (not the owner/name slug) in `repositories`", async () => {
    // GitHub's `POST /app/installations/{id}/access_tokens` wants short repo
    // names in `repositories` — a full "owner/name" slug is the wrong shape
    // and GitHub 422s the whole mint, which would break every studio's
    // bring-up if shipped wrong.
    await mintInstallationToken(env(), "acme-org", "acme-org/websites");
    const body = JSON.parse(bodies[0]!);
    expect(body.repositories).toEqual(["websites"]);
  });

  it("MUTANT PROOF: an empty/missing `repositories` array must not pass", async () => {
    // Fails against the pre-#331 code (no body at all -> bodies[0] is
    // undefined, JSON.parse throws) and must pass once the mint sends a
    // scoped body. This is the test that turns RED on a silently-dropped
    // scoping regression.
    await mintInstallationToken(env(), "acme-org", "acme-org/websites");
    expect(bodies[0]).toBeTruthy();
    const body = JSON.parse(bodies[0]!);
    expect(Array.isArray(body.repositories)).toBe(true);
    expect(body.repositories.length).toBeGreaterThan(0);
  });

  it("takes the repo as-is when it carries no owner prefix", async () => {
    await mintInstallationToken(env(), "acme-org", "websites");
    const body = JSON.parse(bodies[0]!);
    expect(body.repositories).toEqual(["websites"]);
  });

  it("sends a `permissions` narrowing when the caller asks for one", async () => {
    // The blueprint-credential call site (studio/do.ts's writeBlueprintCredential)
    // must never be able to push — this is the field that enforces that at the
    // GitHub API layer, on top of never widening past the App's own installed
    // permissions.
    await mintInstallationToken(
      env(), "acme-org", "acme-org/blueprint", { permissions: { contents: "read" } },
    );
    const body = JSON.parse(bodies[0]!);
    expect(body.permissions).toEqual({ contents: "read" });
  });

  it("omits `permissions` when the caller asks for no narrowing", async () => {
    await mintInstallationToken(env(), "acme-org", "acme-org/websites");
    const body = JSON.parse(bodies[0]!);
    expect(body.permissions).toBeUndefined();
  });

  it("sends NO `repositories` field at all when explicitly told to opt out (unscoped)", async () => {
    // The one documented exception: reachRepo's own mint (auth.ts) never
    // leaves the Worker, answers one GET, and is discarded immediately — see
    // that function's doc comment. Every other caller leaves this false.
    await mintInstallationToken(env(), "acme-org", "acme-org/websites", { unscoped: true });
    expect(bodies[0]).toBeFalsy();
  });

  it("sends a neutral User-Agent, not the App's own bot slug", async () => {
    // The App's slug names the operator's own fleet specifically — an OSS
    // adopter running their own App installation should not see the
    // operator's name in their own outbound requests.
    await mintInstallationToken(env(), "acme-org", "acme-org/websites");
    expect(headers[0]["user-agent"]).not.toBe("acme-org-fleet");
    expect(headers[0]["user-agent"]).toBe("fleetflare");
  });
});
