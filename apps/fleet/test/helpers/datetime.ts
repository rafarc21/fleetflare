/** Test-lane shared micro-helpers — moved verbatim from the suites that
 *  duplicated them (sweep-3 S3-F5). fixedNow pins a deps.now; b64 encodes
 *  small byte arrays (large-input chunked encoders stay local per file). */
export function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

export function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}
