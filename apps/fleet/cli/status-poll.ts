// Board task #203's `readStatus` helper, split out of cli/destroy-outcome.ts
// (which keeps re-exporting it, so its one existing import site in
// cli/fleet.ts needs no change) so board task #133's cli/recycle-outcome.ts
// can share it without importing destroy-outcome.ts's own destroy-specific
// `requestDestroy`. A status read is a DO storage read — GET
// /studio/:id/status — no matter which repair verb (destroy, recycle, a
// future one) triggered it, so this one bounded read belongs to neither.
import type { StudioStatus } from "../src/studio/types";

/** One bounded GET /studio/:id/status. Never throws: a read that did not
 *  happen is a named reason, not an exception. */
export async function readStatus(
  url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number,
): Promise<{ ok: true; status: StudioStatus } | { ok: false; why: string }> {
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
    return { ok: true, status: (await res.json()) as StudioStatus };
  } catch {
    return { ok: false, why: `HTTP ${res.status}, but the body was not JSON` };
  }
}
