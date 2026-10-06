/**
 * Issue #238 — the D1 read/write half of an account's headroom-ordering
 * usage pct, mirroring account-limits-store.ts's own structure/boundary
 * exactly: only imports state.ts (getFlag/setFlag) and rate-limit.ts (the
 * key/encode/decode this module doesn't own), same "pure persistence, no
 * do.ts" boundary so it's reachable from anywhere that has `env.DB` without
 * dragging in "@cloudflare/sandbox" (do.ts's own import, which
 * src/studio/routes.ts deliberately never pulls in — see profile.ts's
 * doClassForRole).
 *
 * Separate store from account-limits-store.ts's `account-limit:<slot>` row
 * on purpose — see rate-limit.ts's own doc comment on
 * `accountUsageStateKey`/`AccountUsageSnapshot` for why the two are never
 * merged even though both are "one fleet_state row per account".
 */
import { getFlag, setFlag } from "../state";
import { accountUsageStateKey, encodeAccountUsageSnapshot, decodeAccountUsageSnapshot } from "./rate-limit";
import type { AccountUsageSnapshot } from "./rate-limit";
import type { ClaudeAccount } from "./accounts";

/**
 * The fleet-wide read half: one fleet_state row per configured account, read
 * in parallel (same shape as `readFleetAccountLimits`). An account with no
 * row (never synced, or its last sync produced "unmanaged"/"no-data") is
 * absent from the returned record entirely — never a zero/default entry,
 * same "absent means nothing observed" convention `readFleetAccountLimits`
 * uses for its own missing rows.
 */
export async function readFleetAccountUsage(
  db: D1Database, accounts: ClaudeAccount[],
): Promise<Record<string, AccountUsageSnapshot>> {
  const usage: Record<string, AccountUsageSnapshot> = {};
  await Promise.all(accounts.map(async (a) => {
    const snapshot = decodeAccountUsageSnapshot(await getFlag(db, accountUsageStateKey(a.name)));
    if (snapshot) usage[a.name] = snapshot;
  }));
  return usage;
}

/**
 * The fleet-wide write half: one fleet_state row, keyed by account NAME
 * (never a studio id), so every studio's own next `readFleetAccountUsage`
 * sees it. Written by the sync route (step 2 of #238's dispatch split) on
 * BOTH a "limit" and a "clear" decision — see this snapshot's own doc
 * comment (rate-limit.ts) for why "no trustworthy pct" decisions
 * ("unmanaged"/"no-data") never call this at all.
 */
export async function writeFleetAccountUsage(
  db: D1Database, name: string, snapshot: AccountUsageSnapshot,
): Promise<void> {
  await setFlag(db, accountUsageStateKey(name), encodeAccountUsageSnapshot(snapshot), Date.parse(snapshot.seenAt));
}

/**
 * Issue #246 — the single-account read the sync route (routes.ts) needs PER
 * DECISION, before it writes: whether this row currently carries a `seenAt`
 * at least as fresh as the usage reading about to be written. Mirrors
 * account-limits-store.ts's own `readOneAccountLimit` exactly (same
 * per-account, single-row read shape) — a different store, kept separate
 * on purpose, see this file's own header comment for why.
 */
export async function readOneAccountUsage(db: D1Database, name: string): Promise<AccountUsageSnapshot | null> {
  return decodeAccountUsageSnapshot(await getFlag(db, accountUsageStateKey(name)));
}
