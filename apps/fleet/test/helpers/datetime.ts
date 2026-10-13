/** Shared test micro-helpers: fixedNow pins a deps.now, b64 encodes small
 *  byte arrays, b64Utf8 encodes UTF-8 text (large-input chunked encoders
 *  stay local per suite). */
export function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

export function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

/** UTF-8 aware base64 for text fixtures — plain `btoa` throws outright on
 *  anything outside Latin1; same shape as src/base64.ts base64EncodeUtf8. */
export function b64Utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
