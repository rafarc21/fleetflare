// Board task #133. `fleet recycle`'s one HTTP round trip AND what this side
// does when that round trip does not come back — the same problem #203 fixed
// for `fleet destroy`, same fix shape. See cli/destroy-outcome.ts's own
// header for the measured-bug template this module follows; read it first.
//
// THE MEASURED BUG (2026-09-30, board issue #133): `fleet recycle <id>` on a
// studio whose lead sat on a limit modal never returned — the operator killed
// it after 15 minutes — even though the container came back (row showed
// running, restart count 2/2, lead working). cmdRecycle's bare `fetch(...)`
// (cli/fleet.ts) carried no timeout, no AbortSignal: a stalled connection on
// this side held the socket open forever while the Worker's own recycle
// (do.ts's `recycle()`, via `recycleWithSync`) kept running and finished.
//
// Same rule #203 encoded for destroy applies here: a request that did not
// come back is not a verdict. The only thing that can say what happened to a
// recycle is the studio row itself, so the CLI reads it — GET
// /studio/:id/status, bounded — and reports what it FOUND. Unlike destroy,
// there is no single terminal `state` this side can treat as "the recycle
// landed" (a `running` row can mean an OLD bring-up that predates this
// recycle entirely, or a stale row nobody has updated yet) — so the verdict
// here is a specific bring-up: `state === "running"` AND the row's own
// `observed.session` (src/studio/observed.ts's `ObservedSession`, nested
// under `StudioStatus.observed`) says `via === "recycle"` AND that session's
// own `at` timestamp is at/after the moment THIS call's POST fired. Anything
// weaker (a bare `running` check) would call an untouched, already-running
// container a recycle success.
import { repairFailureLine } from "./repair-failure";
// `readStatus` comes straight from status-poll.ts, not through
// destroy-outcome.ts's re-export of it — see status-poll.ts's own header for
// why. `DESTROY_CLIENT_TIMEOUT_MS`/`DESTROY_STATUS_TIMEOUT_MS` DO come from
// destroy-outcome.ts, and that dependency is real, not incidental: recycle's
// own budget genuinely derives from destroy's (see RECYCLE_CLIENT_TIMEOUT_MS's
// own doc comment below), and a status read is the same operation regardless
// of which repair verb triggered it, so there is no reason to duplicate
// either constant.
import { readStatus } from "./status-poll";
import { DESTROY_CLIENT_TIMEOUT_MS, DESTROY_STATUS_TIMEOUT_MS } from "./destroy-outcome";
import type { StudioStatus } from "../src/studio/types";

/**
 * How long this side waits for POST /studio/:id/recycle before it stops
 * holding the socket open and starts asking the status route instead.
 *
 * recycle runs destroy's ENTIRE pre-teardown phase (do.ts's `recycle()` calls
 * `recycleWithSync`, which runs the same probe/sync/rescue-push/harvest phase
 * `destroyWithSync` does — see cli/destroy-outcome.ts's own
 * `DESTROY_CLIENT_TIMEOUT_MS` doc comment for that budget's derivation) PLUS
 * a fresh container boot PLUS `provisionCore`'s own re-clone/re-onboard work
 * (`EXEC_CLASSES.provision`, 600_000ms) PLUS recycle's own post-provision
 * readiness check (do.ts's `recycle()` doc comment: "recycleWithSync already
 * runs (and reports) its own post-provision readiness check" —
 * `EXEC_CLASSES.readiness`, 60_000ms):
 *
 *   300_000ms  DESTROY_CLIENT_TIMEOUT_MS (the shared pre-teardown phase)
 *   600_000ms  EXEC_CLASSES.provision.timeoutMs
 *    60_000ms  EXEC_CLASSES.readiness.timeoutMs
 *   ---------
 *   960_000ms
 *
 * Not imported directly from `sandbox-api.ts`: that module pulls in
 * `@cloudflare/sandbox`'s own workerd-only `proxyTerminal` at load time (see
 * that file's own header comment on why), which this CLI binary does not run
 * under — same reason `cli/fleet.ts`'s own `RESCUE_ALL_STUDIO_TIMEOUT_MS`
 * copies its budget in as a literal rather than importing it. Re-verify
 * against `EXEC_CLASSES.provision`/`EXEC_CLASSES.readiness`
 * (src/studio/sandbox-api.ts) if either value ever changes.
 *
 * Deliberately NOT sized for the fully pathological case, same as destroy's
 * own budget: rescue-push and the learning harvest are `rescue`-class execs
 * at 300_000ms EACH (folded into the 300_000ms DESTROY_CLIENT_TIMEOUT_MS
 * above only covers ONE of the sequence's own worst-case legs), so a fully
 * pathological recycle can still run past this. Past this the answer comes
 * from the status row, not from the socket — that is what the poll fallback
 * below is for.
 */
export const RECYCLE_CLIENT_TIMEOUT_MS = DESTROY_CLIENT_TIMEOUT_MS + 600_000 + 60_000;

/** Same poll bound as destroy: 6 reads, 10s apart — 5 gaps, ~50s of extra
 *  waiting. Bounded because an unbounded poll is just a longer hang with
 *  extra steps. */
export const RECYCLE_POLL_ATTEMPTS = 6;
export const RECYCLE_POLL_INTERVAL_MS = 10_000;

export interface RecycleReport {
  /**
   * `ok`                  the recycle answered 200 — the normal path.
   * `http-error`          it answered non-2xx (a 409 refusal, a 500) — a real
   *                       verdict from the Worker, printed as it always was.
   * `timeout-provisioned` the request never came back, and the row now shows
   *                       THIS recycle's own bring-up landed: the recycle
   *                       SUCCEEDED.
   * `timeout-pending`     the request never came back and the row never
   *                       showed that verdict inside the poll window.
   * `timeout-unknown`     the request never came back and the status route
   *                       could not be read either.
   */
  kind: "ok" | "http-error" | "timeout-provisioned" | "timeout-pending" | "timeout-unknown";
  /** The row, when one was actually read as the confirmed outcome. Printed
   *  as the one-row table. */
  status: StudioStatus | null;
  /** Operator-facing lines, in order. */
  lines: string[];
  exitCode: number;
}

export interface RecycleUrls {
  recycle: string;
  status: string;
}

export interface RecycleOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
  statusTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam — same `now: () => Date` convention do.ts's own
   *  `syncDeps.now` uses elsewhere in this codebase. Captured once, right
   *  before the POST fires, so the poll's "did THIS recycle's bring-up land"
   *  check has a fixed, deterministic anchor to compare `observed.session.at`
   *  against. */
  now?: () => Date;
}

/**
 * POST the recycle; if it does not come back, poll the status route and
 * report the TRUE outcome. Never throws.
 *
 * ANY failure of the request itself — the timeout, a dropped connection, a
 * DNS blip mid-flight — takes the poll path, not just the timeout: every one
 * of them leaves the Worker's own recycle running, and none of them is
 * evidence about what it did.
 */
export async function requestRecycle(
  urls: RecycleUrls, headers: Record<string, string>, id: string, opts: RecycleOpts = {},
): Promise<RecycleReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? RECYCLE_CLIENT_TIMEOUT_MS;
  const attempts = opts.pollAttempts ?? RECYCLE_POLL_ATTEMPTS;
  const intervalMs = opts.pollIntervalMs ?? RECYCLE_POLL_INTERVAL_MS;
  const statusTimeoutMs = opts.statusTimeoutMs ?? DESTROY_STATUS_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());

  // Captured BEFORE the fetch fires: the anchor a later poll compares
  // `observed.session.at` against, so a stale row from an OLD bring-up (one
  // that finished before this call ever started) never gets mistaken for
  // this recycle's own verdict.
  const startedAt = now();

  let res: Response;
  try {
    res = await fetchImpl(urls.recycle, { method: "POST", headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const cause = name === "TimeoutError" || name === "AbortError"
      ? `the request timed out after ${Math.round(timeoutMs / 1000)}s`
      : `the request did not complete (${err instanceof Error ? err.message : String(err)})`;
    return pollAfterNoAnswer(urls.status, headers, id, cause, startedAt, {
      fetchImpl, attempts, intervalMs, statusTimeoutMs, sleep,
    });
  }
  if (!res.ok) {
    return {
      kind: "http-error", status: null,
      lines: [repairFailureLine("recycle", res.status, await res.text())], exitCode: 1,
    };
  }
  return { kind: "ok", status: (await res.json()) as StudioStatus, lines: [], exitCode: 0 };
}

/** The recycle-specific verdict: does this row prove THIS call's own recycle
 *  bring-up landed, not merely that SOME bring-up (possibly an old one that
 *  predates this call, possibly a different verb entirely) did.
 *
 *  Review round 2 (maestro, FIX-FIRST), finding 1 — the ORDERING bug this
 *  function used to miss, not just a clock-skew edge case: do.ts's
 *  `recycleWithSync` runs `provisionCore`'s bring-up FIRST (which stamps
 *  `observed.session` with `via: "recycle"` and a fresh `at`) and only THEN
 *  runs its own post-provision readiness check (`recycleVerdict`,
 *  `EXEC_CLASSES.readiness`, up to 60s). During that window the row already
 *  reads `state: "running"` with a fresh `via: "recycle"` session — the OLD
 *  version of this check accepted that alone — but the readiness check can
 *  still come back "bare", which flips `state` to `"degraded"` and makes
 *  do.ts throw (the Worker answers 500, not 200). A poll landing inside that
 *  window used to report a false `timeout-provisioned` success for a studio
 *  about to be marked degraded.
 *
 *  The fix: also require `status.readiness` to exist and its own
 *  `checkedAt` to be at/after `startedAt`. This closes the gap because
 *  do.ts writes `readiness` with a fresh `checkedAt` on EVERY one of
 *  `recycleVerdict`'s three outcomes — `provisioned` (do.ts ~line 1600),
 *  `inconclusive` (~1628, a deliberate operator ruling: an unverifiable
 *  check still reports success), and `bare`/degraded (~1652, where `state`
 *  itself flips away from `"running"`, which this function's own
 *  `state !== "running"` check already rejects once THAT write lands). So
 *  once both `state === "running"` AND `readiness.checkedAt >= startedAt`
 *  are true, the only two ways to get there are the `provisioned` or
 *  `inconclusive` branches — both genuinely terminal, real successes for
 *  THIS recycle, never the degraded one. Before any readiness write for
 *  this recycle lands at all, `readiness.checkedAt` is either absent or
 *  still dated from before `startedAt`, so this function correctly holds
 *  off.
 *
 *  Clock-skew caveat, deliberately NOT compensated for, and now NARROWER
 *  than before this fix: `startedAt` is this side's own (CLI) clock;
 *  `session.at` and `readiness.checkedAt` are both stamped by the Worker on
 *  Cloudflare's edge. The two are never synchronized here, so both
 *  comparisons trust the two clocks to agree closely enough. The failure
 *  this produces is still ASYMMETRIC:
 *    - CLI clock ahead of the Worker's (or the two agree): at worst this
 *      rejects a genuinely-just-landed bring-up as not-yet-proven, which
 *      only costs an extra `timeout-pending` poll cycle or two — a safe,
 *      recoverable direction (the true state is still "running", the CLI
 *      just doesn't claim victory a beat early).
 *    - Worker clock ahead of the CLI's: a STALE row from an unrelated,
 *      already-finished OLDER `via: "recycle"` bring-up can satisfy BOTH
 *      `session.at >= startedAt` AND `readiness.checkedAt >= startedAt`
 *      even though it has nothing to do with THIS call, reporting
 *      `timeout-provisioned` (a false success) for a recycle that might
 *      still be pending or might have failed outright. This is the risky
 *      direction, and this function does not guard against it — no NTP
 *      handshake, no skew budget, nothing. Requiring TWO independent
 *      fresh-looking stamps (rather than one) shrinks this from "any
 *      stale row with a recent-looking session" to "a stale row where BOTH
 *      of its own timestamps independently look fresh" — a much smaller
 *      surface, but not zero. Accepted because: (1) both sides are
 *      Cloudflare-adjacent infrastructure (a CLI on an operator's machine
 *      talking to a Worker), not systems with an adversarial or wildly
 *      divergent clock; (2) a skew-tolerance window would need its own
 *      magic number with no principled way to size it without a real
 *      measured incident to anchor it, exactly the kind of unfounded
 *      constant this codebase's own plan docs warn against inventing. If a
 *      real false-success incident is ever measured, that measurement is
 *      what should size the fix, not a guess made here. */
function bringupLanded(status: StudioStatus, startedAt: Date): boolean {
  if (status.state !== "running") return false;
  const session = status.observed?.session;
  if (!session || session.via !== "recycle") return false;
  if (new Date(session.at) < startedAt) return false;
  if (status.readiness == null) return false;
  return new Date(status.readiness.checkedAt) >= startedAt;
}

/** The whole point of #133, mirroring #203's own `pollAfterNoAnswer`: ask the
 *  row, bounded, and say what it said. */
async function pollAfterNoAnswer(
  statusUrl: string, headers: Record<string, string>, id: string, cause: string, startedAt: Date,
  deps: {
    fetchImpl: typeof fetch; attempts: number; intervalMs: number; statusTimeoutMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<RecycleReport> {
  const windowS = Math.round(((deps.attempts - 1) * deps.intervalMs) / 1000);
  let lastRow: StudioStatus | null = null;
  let lastWhy: string | null = null;

  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    const read = await readStatus(statusUrl, headers, deps.fetchImpl, deps.statusTimeoutMs);
    if (read.ok) {
      lastWhy = null;
      lastRow = read.status;
      // The ONLY reading that proves THIS recycle landed, and the only one
      // that may print a success.
      if (bringupLanded(read.status, startedAt)) {
        return {
          kind: "timeout-provisioned",
          status: read.status,
          lines: [
            `fleet recycle: ${cause}, but the Worker kept going — ${id} completed its recycle bring-up ` +
              `(status poll ${attempt} of ${deps.attempts}), so recycle SUCCEEDED.`,
          ],
          exitCode: 0,
        };
      }
    } else {
      lastWhy = read.why;
    }
    if (attempt < deps.attempts) await deps.sleep(deps.intervalMs);
  }

  // Read the row, and it never showed this recycle's own bring-up. Could be
  // one still working (rescue-push and harvest are 300s each, on top of a
  // fresh boot and re-provision), could be one that died and left the row on
  // an old bring-up — this side cannot tell those apart and must not guess.
  // There is no separate server-side step-reporting channel to read a "last
  // step reached" from, so this names the closest honest thing this side
  // actually knows: the row's own last state and readiness reading.
  if (lastWhy === null && lastRow !== null) {
    const readinessKind = lastRow.readiness?.kind ?? "unknown";
    return {
      kind: "timeout-pending",
      status: null,
      lines: [
        `fleet recycle: ${cause} and ${id} still reads "${lastRow.state}" (readiness: ${readinessKind}) ` +
          `after ${deps.attempts} status polls over ${windowS}s — recycle still running, check fleet ls. ` +
          "The outcome is not known yet.",
      ],
      exitCode: 1,
    };
  }

  // Could not read the row at all. Say exactly that. Never a verdict.
  return {
    kind: "timeout-unknown",
    status: null,
    lines: [
      `fleet recycle: ${cause} and the status route did not answer either ` +
        `(${deps.attempts} tries over ${windowS}s; last: ${lastWhy ?? "no reason recorded"}) — ` +
        `the outcome of this recycle is UNKNOWN, not a verdict. Check fleet ls.`,
    ],
    exitCode: 1,
  };
}
