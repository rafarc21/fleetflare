// Board #91. `fleet inspect`'s one HTTP round trip, split out of cli/fleet.ts
// as a pure module for the same reason cli/fleet-totals.ts is (see its
// header): a test can import it without dragging Bun globals into the root
// type-check.
import { INSPECT_EXEC_MS } from "../src/studio/inspect";

/**
 * How long `fleet inspect` waits for the Worker. Before #91 the fetch had no
 * timeout at all, and a third attempt hung past the caller's own 600s budget.
 * Set above the DO's own container deadline (INSPECT_EXEC_MS) plus headroom,
 * so a wedged container comes back as the DO's named "container did not
 * answer" and this timeout only fires when the Worker/DO itself is silent.
 */
export const INSPECT_CLIENT_TIMEOUT_MS = INSPECT_EXEC_MS + 15_000;

export type InspectRequestResult =
  | { ok: true; body: unknown }
  | { ok: false; message: string };

/** Never throws. Every failure names the side it came from. */
export async function requestInspect(
  url: string,
  headers: Record<string, string>,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<InspectRequestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? INSPECT_CLIENT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        message: `the Worker did not answer within ${timeoutMs / 1000}s — the Worker/Durable Object ` +
          "side is stuck, not just the container (a wedged container answers by itself " +
          `after ${INSPECT_EXEC_MS / 1000}s)`,
      };
    }
    return { ok: false, message: `could not reach the Worker: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A Cloudflare error page (e.g. 1101 "Worker threw exception") is a whole
    // HTML document; its <title> is the only part worth a terminal line.
    const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    const detail = title ?? text.trim().slice(0, 300);
    return {
      ok: false,
      message: `HTTP ${res.status} from the Worker/Durable Object side (the container was never ` +
        `reported on): ${detail}`,
    };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, message: `HTTP ${res.status} from the Worker, but the body was not JSON` };
  }
}

/** Inspect's success body, as the Worker sends it. `capturedAt` is epoch
 *  seconds from the container clock; absent from a Worker older than #151.
 *  `incarnationPresent`/`bringupLogTail` are issue #85's own two facts;
 *  absent from a Worker older than that feature. `sessionForceArmedAt` is
 *  issue #228 item 5's own fact (do.ts's `inspect()` DO method, mirroring
 *  StudioStatus.sessionForceArmedAt) — absent from a Worker older than that
 *  fix, `null` when the override is not currently armed. */
export interface InspectBody {
  ok: true;
  checkoutExists: boolean;
  paneCommand: string | null;
  tail: string;
  capturedAt?: number | null;
  incarnationPresent?: boolean;
  bringupLogTail?: string;
  sessionForceArmedAt?: string | null;
}

/**
 * Issue #228 HOLD fix, item 4: split out of `renderInspect` below, the same
 * "pure formatter, called BEFORE the ok-check exits" shape
 * `formatObservedLines` (readiness-format.ts) already established for
 * `fleet inspect`'s `observed:`/`replaced:`/`unreachable:`/`session:` lines.
 * Before this fix, an `ok: false` inspect (a stopped studio, a container
 * exec failure) never printed the armed-override line at all —
 * `cmdInspect` (cli/fleet.ts) exits at its `!body.ok` check, well before
 * `renderInspect` (the only place that ever read `sessionForceArmedAt`)
 * ever ran. The Worker already sends the field on BOTH branches
 * (src/studio/routes.ts, right next to its own `outcome.ok` check) — only
 * the CLI was throwing it away on the failure path.
 *
 * `undefined` (a Worker older than issue #228 item 5, which never sent the
 * field at all) and `null` (not currently armed) both print nothing — only
 * an actual ISO timestamp is worth a line.
 */
export function formatSessionForceArmedLine(sessionForceArmedAt: string | null | undefined): string[] {
  return typeof sessionForceArmedAt === "string"
    ? [`session guard: force-next-sync armed since ${sessionForceArmedAt}`]
    : [];
}

/**
 * #151: the lines `fleet inspect` prints. NEVER a tail without its age — a
 * frozen screen read as live misled two coordinators for 20+ minutes. No
 * capture time → `ok: false`, and the tail is withheld.
 */
export function renderInspect(body: InspectBody, nowMs: number): { ok: boolean; lines: string[] } {
  const head = [
    `checkout: ${body.checkoutExists ? "present" : "MISSING"}`,
    `pane:     ${body.paneCommand ?? "(studio:claude window not found)"}`,
  ];
  // Issue #85's own two facts, when the Worker sends them — absent from a
  // Worker deployed before that feature, so printed only when present rather
  // than a misleading "MISSING"/"(empty)" for a Worker that never sent them.
  if (typeof body.incarnationPresent === "boolean") {
    head.push(`incarnation: ${body.incarnationPresent ? "present" : "MISSING"}`);
  }
  if (typeof body.bringupLogTail === "string") {
    head.push("--- bring-up log (tail) ---", body.bringupLogTail || "(empty)");
  }
  if (typeof body.capturedAt !== "number") {
    return { ok: false, lines: [...head, "tail withheld: the Worker sent no capture time, so its age is unknown (Worker older than #151?)"] };
  }
  const at = new Date(body.capturedAt * 1000);
  const age = Math.max(0, Math.round(nowMs / 1000 - body.capturedAt));
  return {
    ok: true,
    lines: [...head, `captured ${at.toISOString().slice(11, 19)}Z (age ${age}s)`, "--- tail ---", body.tail],
  };
}
