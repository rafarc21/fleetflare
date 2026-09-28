import type { Env } from "../env";

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

async function appJwt(appId: string, privateKeyPem: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(now / 1000) - 60; // clock skew allowance, per GitHub's docs
  const payload = { iat, exp: iat + 540, iss: appId };
  const unsigned =
    `${b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    `${b64urlStr(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

/**
 * An owner's own installation-id var: `acme-hq` -> `GITHUB_INSTALLATION_ID_ACME_HQ`.
 * Literal mirror of auth.ts's `tokenEnvName` (P6c is P6b's pattern, applied to
 * installation ids instead of tokens) — uppercased, every non-alphanumeric
 * replaced with `_`. Same pinned-in-a-test contract: this is what the
 * operator sets, and changing the shape would silently stop finding an
 * already-set per-owner id.
 */
export function installationEnvName(owner: string): string {
  return `GITHUB_INSTALLATION_ID_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Same isolation as auth.ts's own `DynamicEnv` — one computed-name env read,
 *  not a widened `Env` interface. See that file's doc comment for why. */
type DynamicEnv = Readonly<Record<string, unknown>>;

/**
 * This App's slug is whatever the operator named their own GitHub App
 * installation (its bot identity is `<that slug>[bot]`, a GitHub App
 * setting outside this codebase — see webhook.ts's own comment on
 * `sender.login`, which that setting still controls and this constant does
 * not). GitHub asks the User-Agent identify the CALLING CLIENT, which is a
 * separate, neutral concern: "fleetflare" is a fixed, generic value so an
 * OSS adopter running their own App installation never sees any operator's
 * own name/slug in their own outbound requests.
 */
export const USER_AGENT = "fleetflare";

/**
 * Narrows what a minted token can do, beyond the installation boundary it
 * already sits inside — issue #331 (MUST-fix, security). Every real call
 * site should leave every field at its default; see reachRepo's own doc
 * comment (auth.ts) for the one documented `unscoped` exception.
 */
export interface MintTokenOpts {
  /** GitHub's `permissions` field on this same endpoint accepts a NARROWING
   *  (never a widening) of the App's own installed/configured permissions —
   *  used today only for the blueprint credential, which must never be able
   *  to push (studio/do.ts's writeBlueprintCredential). */
  permissions?: Record<string, string>;
  /** true skips the `repositories` scoping field entirely, minting a token
   *  valid for the WHOLE installation — the pre-#331 behaviour. Defaults to
   *  false (scoped): every other caller's token is about to sit in a
   *  container root can reach, and the safe behaviour has to be the
   *  default, not something every call site has to remember to opt into. */
  unscoped?: boolean;
}

/** The name half of `owner/name`, or the whole string when there is no
 *  slash (repoOwner in auth.ts already documents that a slash-less repo
 *  reads as its own owner). GitHub's `POST .../access_tokens` endpoint's
 *  `repositories` field wants SHORT repo names, never "owner/name" slugs —
 *  this codebase's own slugs are usually the latter, and sending the wrong
 *  shape there 422s the whole mint (verified against GitHub's REST API docs
 *  for this endpoint). */
function repoShortName(repo: string): string {
  const i = repo.indexOf("/");
  return i === -1 ? repo : repo.slice(i + 1);
}

/**
 * Mints a short-lived GitHub App installation access token: builds a signed
 * RS256 JWT with Web Crypto (crypto.subtle — there is no Node `crypto` here,
 * and nodejs_compat is not relied on for this) and exchanges it against
 * GitHub's REST API for a token scoped to this installation.
 *
 * Fresh every call, deliberately uncached: this token is handed to a
 * container or spent on a single merge, and the shorter it lives the smaller
 * that exposure. Minting costs one HTTP request; GitHub expires the
 * resulting installation token after 1 hour regardless.
 *
 * P6c — `owner` is required, not decorative: GitHub Apps install per
 * ACCOUNT, so one global `GITHUB_INSTALLATION_ID` only ever covers the ONE
 * org it was minted against (measured 2026-09-16: `acme-org` covered,
 * `demositeltda`/`acme-hq`/`demositellc` not). The id resolved here is the
 * owner's own (`installationEnvName`) if set and non-empty, else the shared
 * `GITHUB_INSTALLATION_ID` — the same one-way fallback P6b already gave
 * per-owner tokens, and for the same reason: a per-owner id is never served
 * for any owner but its own.
 *
 * Issue #331 — `repo` is ALSO required, not decorative: a mint with no
 * request body at all (the pre-#331 shape) is valid for EVERY repo the
 * installation covers, not just the one caller that asked for it. Studios
 * run as root with --dangerously-skip-permissions, so this token sits in a
 * container reachable by anything that container runs — a studio
 * compromised or misbehaving on repo A had write access to every OTHER repo
 * the same installation covers. Requiring `repo` here, rather than an
 * optional param a call site could quietly never pass, forces every real
 * caller to confront which repo its own token should be scoped to (auth.ts's
 * mintRepoToken already has this repo in hand at every real call site — see
 * that function's own doc comment).
 */
export async function mintInstallationToken(
  env: Env, owner: string, repo: string, opts: MintTokenOpts = {},
): Promise<string> {
  const own = (env as unknown as DynamicEnv)[installationEnvName(owner)];
  const installationId = typeof own === "string" && own !== "" ? own : env.GITHUB_INSTALLATION_ID;
  if (!env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_ID || !installationId) {
    throw new Error("GitHub App not configured");
  }
  // GitHub's App-settings page hands out PKCS#1 ("BEGIN RSA PRIVATE KEY");
  // importKey below only accepts PKCS#8 ("BEGIN PRIVATE KEY") — Web Crypto
  // has no PKCS#1 support at all. Left unchecked, a PKCS#1 key reaches
  // importKey and fails with an opaque DataError that doesn't say what's
  // wrong. Caught here with a message that says what to do about it.
  if (env.GITHUB_APP_PRIVATE_KEY.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1. Convert it: " +
      "openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem",
    );
  }
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Date.now());
  // Issue #331: build the scoping body. `repositories` is the actual
  // security boundary (see this function's own doc comment); `permissions`
  // is an additional narrowing a caller may ask for on top of it (never a
  // widening — GitHub rejects a permission the App was never installed
  // with). An empty object (only reachable via `unscoped: true`) sends NO
  // body at all, byte-identical to the pre-#331 request.
  const body: Record<string, unknown> = {};
  if (opts.unscoped !== true) body.repositories = [repoShortName(repo)];
  if (opts.permissions) body.permissions = opts.permissions;
  const hasBody = Object.keys(body).length > 0;
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    // GitHub's error body is safe to surface (e.g. "Bad credentials"); the
    // JWT and any token are not — neither is logged or included here.
    throw new MintTokenError(res.status, `installation token failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text) as { token: string }).token;
}

/**
 * PR #339 round 2 (issue #331) — a typed status code, not a string a caller
 * would have to parse back out of the message. `mintRepoToken` (auth.ts)
 * needs to distinguish "this repo name is stale (422, a renamed/transferred
 * repo not among `repositories[]`)" from every other failure (bad
 * credentials, rate limit, a genuinely unreachable repo) to know when its
 * own canonical-name retry applies — text-matching a message this file owns
 * would be exactly the brittle coupling this codebase has already measured
 * failing elsewhere (issue #310's glob/octal alias bypass).
 */
export class MintTokenError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "MintTokenError";
  }
}
