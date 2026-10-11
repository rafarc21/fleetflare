// The one chunked base64 encoder (deep-modules sweep 4, F4). Deliberately
// dependency-free: this module is imported from Worker code, the cli project
// and bun tests, and mint-token-error.ts / reach.ts already document why a
// shared file here must import nothing (an Env-typed import would drag the
// Worker type graph into the cli and bun-test tsconfig projects).
const B64_CHUNK = 0x8000;

/** Byte array → base64, in 0x8000-byte chunks — a single un-chunked
 *  `String.fromCharCode(...bytes)` spread blows the call stack past a few
 *  hundred KiB, and these payloads reach multiple MiB. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

/** String → base64, UTF-8-safe — a bare `btoa(s)` throws outright on any
 *  character outside Latin1, so encode to UTF-8 bytes first. */
export function base64EncodeUtf8(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}
