// apps/fleet/src/http/capped-body.ts
//
// Extracted out of junior/route.ts (PR #9 review, F3) so `/fleet/junior` and
// #249's `/fleet/llm/anthropic/v1/messages` share one copy rather than two —
// see this function's own doc comment below for why it has to read the
// actual byte stream, never `req.text()`.

/**
 * The request body, or `null` if it is over `cap` — read off the actual byte
 * STREAM, never via `req.text()`. `.text()` fully materializes the body into
 * one JS string before anything downstream can compare its size against
 * `cap`, which is exactly the DoS shape a body cap exists to prevent: a
 * declared-or-actual size under whatever platform ceiling exists but still
 * large enough to matter gets fully allocated regardless of what this
 * function would have said about it.
 *
 * Pumps the reader chunk by chunk, summing byte lengths as it goes, and
 * cancels the reader (never reads another byte) the instant the running
 * total crosses `cap` — a lying-or-absent Content-Length header (a caller's
 * own early header check catches an HONEST one) is caught here from the real
 * bytes, without ever concatenating an oversized body into one buffer.
 *
 * `req.body === null` (a GET, or a POST with a genuinely empty body) reads
 * as the empty string — the same shape `req.text()` would have produced.
 */
export async function readCappedBody(req: Request, cap: number): Promise<string | null> {
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}
