/** Shared test micro-helpers: fixedNow pins a deps.now, b64 encodes small
 *  byte arrays (large-input chunked encoders stay local per suite). */
export function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

export function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}
