// Board task #203. `fleet destroy`'s one HTTP round trip AND what this side
// does when that round trip does not come back. Split out of cli/fleet.ts as
// a pure module for the same reason cli/inspect-request.ts is (see its
// header): a test can import it without dragging Bun globals into the root
// type-check.
//
// THE MEASURED BUG (2026-09-24 ~21:20Z, tearing down
// demosite-life--web-studio): `fleet destroy` printed "fleet: The operation
// timed out." and NO teardown line. `fleet ls --fresh` right after showed the
// studio STOPPED and `orca worktree list` showed 0 rows for it; the two
// sibling destroys printed "Orca worktree and attach terminal removed". So
// the request timeout fired on THIS side while the Worker's destroy (#129
// probe-first, session sync, rescue-push, harvest, stop) kept running and
// SUCCEEDED. The operator was shown a failure for a success, and the CLI-side
// Orca teardown (#57/#135) never ran on that path — which is how one studio
// kept its worktree while its siblings did not.
//
// The rule this module encodes: a request that did not come back is not a
// verdict. The only thing that can say what happened to a destroy is the
// studio row itself, so the CLI reads it — GET /studio/:id/status, bounded —
// and reports what it FOUND. `stopped` is the only reading that is allowed to
// print a success or to run the Orca teardown; anything else says plainly
// that the outcome is not known yet. "failed" is never the verdict here: the
// measured case proves that reading is often wrong.
import { repairFailureLine } from "./repair-failure";
import type { StudioStatus } from "../src/studio/types";
// Board task #133: `readStatus` moved to its own module (cli/status-poll.ts)
// so cli/recycle-outcome.ts can import it directly instead of duplicating it
// (recycle-outcome.ts imports it from status-poll.ts, not through this
// re-export — see status-poll.ts's own header). recycle-outcome.ts still
// legitimately imports DESTROY_CLIENT_TIMEOUT_MS/DESTROY_STATUS_TIMEOUT_MS
// from THIS module below, since recycle's own budget genuinely derives from
// destroy's — that dependency was never the thing being removed. Re-exported
// here, verbatim signature, so THIS module's one existing consumer
// (cli/fleet.ts's `import { requestDestroy, readStatus,
// DESTROY_STATUS_TIMEOUT_MS } from "./destroy-outcome"`) needs no change.
import { readStatus } from "./status-poll";
export { readStatus };

/**
 * How long this side waits for POST /studio/:id/destroy before it stops
 * holding the socket open and starts asking the status route instead.
 *
 * Sized for the destroy's own worst case up to the container stop:
 *
 *   120s  #129 F2's boot wait — sbAwaitReady's 30s instanceGet + 90s
 *         portReady (sandbox-api.ts), taken when the container is mid-boot.
 *     8s  CONTAINER_PROBE_MS, the probe that runs before any rescue exec.
 *   120s  #110's `sync` exec class (EXEC_CLASSES.sync), the pre-destroy
 *         session sync's own budget.
 *   ~52s  slack for destroy() itself, the D1 registry write and Access.
 *   ----
 *   300s
 *
 * Deliberately NOT sized for the whole worst case: rescue-push and the
 * learning harvest are `rescue`-class execs at 300s EACH (sandbox-api.ts), so
 * a fully pathological destroy can run past 900s. Waiting that out on one
 * socket buys an operator nothing — Cloudflare's edge, a laptop lid or a
 * dropped Wi-Fi association all cut it anyway, and THAT is the case this
 * module exists to report honestly. Past 300s the answer comes from the
 * status row, not from the socket.
 */
export const DESTROY_CLIENT_TIMEOUT_MS = 300_000;

/** The poll bound: 6 reads, 10s apart — 5 gaps, so ~50s of extra waiting.
 *  Bounded because an unbounded poll is just a longer hang with extra steps;
 *  a destroy still running after this gets an honest "still running", which
 *  is a true statement the operator can act on. */
export const DESTROY_POLL_ATTEMPTS = 6;
export const DESTROY_POLL_INTERVAL_MS = 10_000;

/** A status read is a DO storage read — no container exec — so it gets a
 *  short deadline of its own. A status route that hangs must not eat the
 *  whole poll window. */
export const DESTROY_STATUS_TIMEOUT_MS = 15_000;

export interface DestroyReport {
  /**
   * `ok`              the destroy answered 200 — the normal path.
   * `http-error`      it answered non-2xx (a 409 refusal, a 500) — a real
   *                   verdict from the Worker, printed as it always was.
   * `timeout-stopped` the request never came back, and the row now reads
   *                   stopped: the destroy SUCCEEDED.
   * `timeout-running` the request never came back and the row never reached
   *                   stopped inside the poll window.
   * `timeout-unknown` the request never came back and the status route could
   *                   not be read either.
   */
  kind: "ok" | "http-error" | "timeout-stopped" | "timeout-running" | "timeout-unknown";
  /** The row, when one was actually read. Printed as the one-row table. */
  status: StudioStatus | null;
  /** Operator-facing lines, in order. */
  lines: string[];
  /** May the caller run the Orca teardown? True ONLY for a row this module
   *  read as `stopped` — see the module header. */
  teardown: boolean;
  exitCode: number;
}

export interface DestroyUrls {
  destroy: string;
  status: string;
}

export interface DestroyOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
  statusTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * POST the destroy; if it does not come back, poll the status route and
 * report the TRUE outcome. Never throws.
 *
 * ANY failure of the request itself — the timeout, a dropped connection, a
 * DNS blip mid-flight — takes the poll path, not just the timeout: every one
 * of them leaves the Worker's own destroy running, and none of them is
 * evidence about what it did.
 */
export async function requestDestroy(
  urls: DestroyUrls, headers: Record<string, string>, id: string, opts: DestroyOpts = {},
): Promise<DestroyReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DESTROY_CLIENT_TIMEOUT_MS;
  const attempts = opts.pollAttempts ?? DESTROY_POLL_ATTEMPTS;
  const intervalMs = opts.pollIntervalMs ?? DESTROY_POLL_INTERVAL_MS;
  const statusTimeoutMs = opts.statusTimeoutMs ?? DESTROY_STATUS_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let res: Response;
  try {
    res = await fetchImpl(urls.destroy, { method: "POST", headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const cause = name === "TimeoutError" || name === "AbortError"
      ? `the request timed out after ${Math.round(timeoutMs / 1000)}s`
      : `the request did not complete (${err instanceof Error ? err.message : String(err)})`;
    return pollAfterNoAnswer(urls.status, headers, id, cause, {
      fetchImpl, attempts, intervalMs, statusTimeoutMs, sleep,
    });
  }
  if (!res.ok) {
    return {
      kind: "http-error", status: null,
      lines: [repairFailureLine("destroy", res.status, await res.text())], teardown: false, exitCode: 1,
    };
  }
  return { kind: "ok", status: (await res.json()) as StudioStatus, lines: [], teardown: true, exitCode: 0 };
}

/** The whole point of #203: ask the row, bounded, and say what it said. */
async function pollAfterNoAnswer(
  statusUrl: string, headers: Record<string, string>, id: string, cause: string,
  deps: {
    fetchImpl: typeof fetch; attempts: number; intervalMs: number; statusTimeoutMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<DestroyReport> {
  const windowS = Math.round(((deps.attempts - 1) * deps.intervalMs) / 1000);
  let lastState: StudioStatus["state"] | null = null;
  let lastWhy: string | null = null;

  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    const read = await readStatus(statusUrl, headers, deps.fetchImpl, deps.statusTimeoutMs);
    if (read.ok) {
      lastWhy = null;
      lastState = read.status.state;
      // The ONLY reading that proves the destroy landed, and the only one
      // that may print a success or unlock the Orca teardown.
      if (read.status.state === "stopped") {
        return {
          kind: "timeout-stopped",
          status: read.status,
          lines: [
            `fleet destroy: ${cause}, but the Worker kept going — ${id} now reads stopped ` +
              `(status poll ${attempt} of ${deps.attempts}), so the destroy SUCCEEDED.`,
          ],
          teardown: true,
          exitCode: 0,
        };
      }
    } else {
      lastWhy = read.why;
    }
    if (attempt < deps.attempts) await deps.sleep(deps.intervalMs);
  }

  // Read the row, and it is not stopped. Could be a destroy still working
  // (rescue-push and harvest are 300s each), could be one that died and left
  // the row degraded — this side cannot tell those apart and must not guess.
  if (lastWhy === null && lastState !== null) {
    return {
      kind: "timeout-running",
      status: null,
      lines: [
        `fleet destroy: ${cause} and ${id} still reads "${lastState}" after ${deps.attempts} status polls ` +
          `over ${windowS}s — destroy still running, check fleet ls. The outcome is not known yet, so ` +
          "no Orca teardown ran and none is claimed.",
      ],
      teardown: false,
      exitCode: 1,
    };
  }

  // Could not read the row at all. Say exactly that. Never a verdict.
  return {
    kind: "timeout-unknown",
    status: null,
    lines: [
      `fleet destroy: ${cause} and the status route did not answer either ` +
        `(${deps.attempts} tries over ${windowS}s; last: ${lastWhy ?? "no reason recorded"}) — ` +
        `the outcome of this destroy is UNKNOWN, not a verdict. Check fleet ls. No Orca teardown ran.`,
    ],
    teardown: false,
    exitCode: 1,
  };
}
