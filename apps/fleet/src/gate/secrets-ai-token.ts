// #1346: the Workers AI proxy route's run-scoped bearer token. Minted once
// at leg start (do.ts, alongside legGitToken -- see leg-env.ts's own header
// for that precedent), carried to the container as GATE_SECRET_WORKERS_AI,
// presented back to the AI proxy route as a bearer header. HMAC-SHA256 over
// {runId, leg, exp} with a Worker secret signing key
// (GATE_SECRET_SIGNING_KEY) that no leg container ever holds. `crypto.subtle`
// is the Web Crypto global, identical in the Worker and in `bun test` -- no
// cloudflare:workers import, so this file stays pure.
//
// "Expires with run": `exp` is the mint time plus a TTL the caller passes in
// (do.ts uses the leg's own hard timeout ceiling -- config.ts's legTimeoutMin,
// which clamps to MAX_LEG_TIMEOUT_MIN -- plus a container-start margin) --
// by the time a human could read a leaked token out of a
// log, the run it was minted for is already over. There is no revocation
// list: a short, fixed TTL is the whole mechanism, same as every other
// short-lived credential in this gate (legGitToken's installation token is
// also never explicitly revoked -- it just expires).

export interface RunTokenClaim {
  runId: string;
  leg: string;
  exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(signingKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

export async function mintRunToken(
  claim: { runId: string; leg: string; now: number; ttlMs: number }, signingKey: string,
): Promise<string> {
  const payload: RunTokenClaim = { runId: claim.runId, leg: claim.leg, exp: claim.now + claim.ttlMs };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await hmacKey(signingKey);
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${toBase64Url(payloadBytes)}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Verifies signature, run id, leg name and expiry -- every failure mode
 *  (malformed token, wrong signature, wrong run, wrong leg, expired) returns
 *  false, never throws. `now >= exp` fails (not `now > exp`): the mint call
 *  sets `exp = now + ttlMs`, so a check landing exactly on `exp` is already
 *  past the budget that `ttlMs` promised. */
export async function verifyRunToken(
  token: string, expected: { runId: string; leg: string; now: number }, signingKey: string,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadPart, sigPart] = parts;
  let payloadBytes: Uint8Array<ArrayBuffer>;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    payloadBytes = fromBase64Url(payloadPart);
    sigBytes = fromBase64Url(sigPart);
  } catch {
    return false;
  }
  const key = await hmacKey(signingKey);
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
  if (!valid) return false;
  let claim: RunTokenClaim;
  try {
    claim = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return false;
  }
  if (typeof claim.runId !== "string" || typeof claim.leg !== "string" || typeof claim.exp !== "number") return false;
  if (claim.runId !== expected.runId || claim.leg !== expected.leg) return false;
  return expected.now < claim.exp;
}
