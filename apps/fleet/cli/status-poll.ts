// Board task #203's `readStatus` helper, split out of cli/destroy-outcome.ts
// (which keeps re-exporting it, so its one existing import site in
// cli/fleet.ts needs no change) so board task #133's cli/recycle-outcome.ts
// can import the bounded status read directly, once, instead of duplicating
// it. A status read is a DO storage read — GET /studio/:id/status — no
// matter which repair verb (destroy, recycle, a future one) triggered it,
// so the read itself belongs to neither destroy- nor recycle-specific code.
//
// This does NOT fully decouple recycle-outcome.ts from destroy-outcome.ts:
// recycle-outcome.ts still imports `DESTROY_CLIENT_TIMEOUT_MS` and
// `DESTROY_STATUS_TIMEOUT_MS` from there, and that coupling is intentional
// — recycle's own client-side timeout budget genuinely derives from
// destroy's own (see recycle-outcome.ts's `RECYCLE_CLIENT_TIMEOUT_MS` doc
// comment), and a status-read deadline is the same number regardless of
// caller. Only `readStatus` itself moved; the two constants did not.
import type { StudioStatus } from "../src/studio/types";
import type { OperationInFlight } from "../src/studio/provision";

// Board issue #149: GET /studio/:id/status's real JSON body already carries
// `operationInFlight` (do.ts's `statusDetailWithStorage` return type,
// ~line 3193) — it was just not previously visible to this module's own
// `StudioStatus`-typed return value. Widening here, rather than narrowing a
// caller's cast, keeps the type honest about what the route actually
// returns: every caller of `readStatus` reads a real `/status` body that
// carries this field at runtime regardless of whether the type said so.
export type StatusWithOperation = StudioStatus & { operationInFlight: OperationInFlight | null };

/** One bounded GET /studio/:id/status. Never throws: a read that did not
 *  happen is a named reason, not an exception. */
export async function readStatus(
  url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number,
): Promise<{ ok: true; status: StatusWithOperation } | { ok: false; why: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { ...headers, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { ok: false, why: `HTTP ${res.status} ${(await res.text().catch(() => "")).trim().slice(0, 200)}`.trim() };
  try {
    return { ok: true, status: (await res.json()) as StatusWithOperation };
  } catch {
    return { ok: false, why: `HTTP ${res.status}, but the body was not JSON` };
  }
}
