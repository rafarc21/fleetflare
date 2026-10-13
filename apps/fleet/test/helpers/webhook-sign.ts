// Shared HMAC-SHA256 signer for GitHub webhook tests: signs the raw body
// string the way x-hub-signature-256 verification expects. WebCrypto only —
// runs under the cloudflare:test workerd pool, no Node imports.
export async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
