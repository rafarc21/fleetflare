/**
 * Issue #141 — the D1 read/write half of an account's fleet-wide limit
 * state, extracted from do.ts so it's reachable from anywhere that has
 * `env.DB` WITHOUT dragging in "@cloudflare/sandbox" (do.ts's own import,
 * which src/studio/routes.ts deliberately never pulls in — see profile.ts's
 * doClassForRole). Only imports state.ts (getFlag/setFlag) and rate-limit.ts
 * (the key/encode/decode this module doesn't own), same "pure persistence,
 * no do.ts" boundary accounts.ts's own header states for itself.
 */
import { getFlag, setFlag, deleteFlag } from "../state";
import { accountLimitStateKey, encodeAccountLimitState, decodeAccountLimitState } from "./rate-limit";
import type { AccountLimitState } from "./rate-limit";
import type { AccountLimits, ClaudeAccount } from "./accounts";

/**
 * Issue #102 — the fleet-wide read half of FailoverDeps.accountLimits: one
 * fleet_state row per configured account, read in parallel (at most
 * MAX_CLAUDE_ACCOUNTS, and only on a tick that already found a live limit
 * modal — see runAccountFailover's own call site). A row this studio's own
 * write never touched (another studio's sighting, or none at all) reads back
 * exactly the same as one this studio wrote itself; fleet-wide is the point.
 */
export async function readFleetAccountLimits(db: D1Database, accounts: ClaudeAccount[]): Promise<AccountLimits> {
  const limits: AccountLimits = {};
  await Promise.all(accounts.map(async (a) => {
    const state = decodeAccountLimitState(await getFlag(db, accountLimitStateKey(a.name)));
    // Review round 1 (#102 review, 2026-09-30): `seenAt` rides along too, not
    // just `until` — accounts.ts's `isFree` needs it for a `null`-until
    // entry's staleness ceiling (NULL_UNTIL_CEILING_MS). Issue #141: `dead`
    // rides along too, and is NEVER subject to that ceiling.
    if (state) limits[a.name] = { until: state.until, seenAt: state.seenAt, ...(state.dead ? { dead: true as const } : {}) };
  }));
  return limits;
}

/** Issue #102 — the fleet-wide write half: one fleet_state row, keyed by
 *  account NAME (never a studio id), so every studio's own next
 *  `readFleetAccountLimits` sees it. Issue #141: `dead` is passed through
 *  unchanged to `encodeAccountLimitState` — no auto-expiry TTL logic here,
 *  the D1 row itself is written with no different treatment than any other
 *  account-limit sighting; only `accountIsFree`'s own read of it treats it
 *  as permanent. Issue #232: `source` is passed through the same way — the
 *  sync route (routes.ts) always passes `"usage"` on its own "limit" writes;
 *  every other caller (failover.ts's pane-capture path) omits it, same as it
 *  omits `dead` today. */
export async function writeFleetAccountLimit(
  db: D1Database, name: string, until: string | null, seenAt: string, dead?: true, source?: "usage",
): Promise<void> {
  await setFlag(
    db, accountLimitStateKey(name),
    encodeAccountLimitState({
      until, seenAt,
      ...(dead ? { dead: true as const } : {}),
      ...(source ? { source } : {}),
    }),
    Date.parse(seenAt),
  );
}

/**
 * Issue #232 — the single-account read the sync route (routes.ts) needs
 * PER DECISION, before it writes: whether this row currently carries
 * `dead: true` (a "limit" write must never drop it — see
 * `writeFleetAccountLimit`'s own call site there) and, for a "clear"
 * decision, whether the row's own `seenAt` is already fresher than the
 * usage snapshot being applied (a "clear" must never stomp a sighting a
 * different path — e.g. failover.ts's pane-capture detector — recorded
 * after this snapshot was taken).
 *
 * `readFleetAccountLimits` above reads MANY accounts in parallel, built for
 * the GET listing route; this is the per-decision counterpart, one row at a
 * time, kept as small/pure a persistence function as the rest of this file.
 */
export async function readOneAccountLimit(db: D1Database, name: string): Promise<AccountLimitState | null> {
  return decodeAccountLimitState(await getFlag(db, accountLimitStateKey(name)));
}

/**
 * Issue #232 — the proactive clear: a fresh cswap reading below threshold
 * for an account, including one whose row currently carries `dead: true`
 * (operator re-login proves it's alive again — there is no separate "dead"
 * check anywhere in this path, a fresh low-pct reading IS the proof).
 * Deletes the row rather than writing `until: null`: a null-until WRITE
 * would trip the 24h NULL_UNTIL_CEILING_MS grace period `accountIsFree`
 * (rate-limit.ts) applies to a null-until entry — wrong semantics for
 * "clear now". A fully absent row reads free immediately via
 * `accountIsFree`'s own `!(a.name in limits)` branch.
 */
export async function clearFleetAccountLimit(db: D1Database, name: string): Promise<void> {
  await deleteFlag(db, accountLimitStateKey(name));
}
