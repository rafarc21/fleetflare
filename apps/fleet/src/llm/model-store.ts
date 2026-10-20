// Model pool persistence on the existing fleet_state flag table — no migration
// (spec 2026-10-13-model-pool-design, Task 3). Studio assignment and per-model
// pool state are both just flags: `lead-model:<studioId>` -> model id,
// `model-state:<modelId>` -> ModelState.
import { deleteFlag, getFlag, setFlag } from "../state";
import { POOL, modelById, type ModelState } from "./models";

const ASSIGN = (studioId: string) => `lead-model:${studioId}`;
const STATE = (modelId: string) => `model-state:${modelId}`;
const STATES: readonly ModelState[] = ["active", "overflow", "demoted"];

export async function getAssignedModel(db: D1Database, studioId: string): Promise<string | null> {
  const v = await getFlag(db, ASSIGN(studioId));
  // Never trust a stored id blindly — the pool can shrink between releases.
  return v !== null && modelById(v) ? v : null;
}

export async function setAssignedModel(db: D1Database, studioId: string, modelId: string): Promise<void> {
  if (!modelById(modelId)) throw new Error(`unknown model ${modelId}`);
  await setFlag(db, ASSIGN(studioId), modelId, Date.now());
}

/** Issue #1099: how long a studio avoids a model after a runaway abort. */
export const RUNAWAY_AVOID_MS = 10 * 60_000;

const AVOID = (studioId: string) => `runaway-avoid:${studioId}`;

/** Issue #1099 (review, finding 4): the avoid value is a SET of model ids
 *  (`id1,id2|expiresAtMs`, one shared expiry). Each runaway adds its model to
 *  whatever is still live, so a second runaway does not erase the first. */
function parseAvoid(v: string | null, now: number): string[] {
  if (v === null) return [];
  const bar = v.lastIndexOf("|");
  if (bar === -1 || !(Number(v.slice(bar + 1)) > now)) return [];
  return v.slice(0, bar).split(",").filter((id) => modelById(id) !== undefined);
}

/** Records that `modelId` ran away on this studio's stream. */
export async function markRunawayAvoid(db: D1Database, studioId: string, modelId: string, now: number = Date.now()): Promise<void> {
  if (!modelById(modelId)) throw new Error(`unknown model ${modelId}`);
  const live = parseAvoid(await getFlag(db, AVOID(studioId)), now);
  const ids = [...new Set([...live, modelId])];
  await setFlag(db, AVOID(studioId), `${ids.join(",")}|${now + RUNAWAY_AVOID_MS}`, now);
}

/** The models this studio should avoid right now (empty once they expire). */
export async function getRunawayAvoid(db: D1Database, studioId: string, now: number = Date.now()): Promise<string[]> {
  return parseAvoid(await getFlag(db, AVOID(studioId)), now);
}

export async function getModelStates(db: D1Database): Promise<Record<string, ModelState>> {
  const out: Record<string, ModelState> = {};
  // Read in parallel — one fleet_state row per pool model, same shape as
  // account-usage-store.ts's readFleetAccountUsage / account-limits-store.ts's
  // readFleetAccountLimits.
  await Promise.all(POOL.map(async (m) => {
    const v = await getFlag(db, STATE(m.id));
    out[m.id] = v !== null && (STATES as readonly string[]).includes(v) ? (v as ModelState) : "active";
  }));
  return out;
}

export async function setModelState(db: D1Database, modelId: string, state: ModelState): Promise<void> {
  if (!modelById(modelId)) throw new Error(`unknown model ${modelId}`);
  await setFlag(db, STATE(modelId), state, Date.now());
}

// ---------------------------------------------------------------------------
// no_finish_reason failure tracking (board issue #1228)
// ---------------------------------------------------------------------------

/** Issue #1228: how long a fingerprint's identical-input failure count stays
 *  live. A poison request burns through its 3 tries in seconds; an hour keeps
 *  the counter from leaking into the next genuinely-distinct turn while still
 *  catching a client retry loop minutes later. */
export const NO_FINISH_REASON_WINDOW_MS = 60 * 60_000;

const NFR = (studioId: string, fingerprintHash: string) => `no-finish-reason:${studioId}:${fingerprintHash}`;

/**
 * Issue #1228: a `no_finish_reason` on a request with this fingerprint failed
 * again — record it. The value is a `count|expiresAtMs` pair (one shared
 * expiry) so a sliding window never lets one old failure plus a new one read
 * as a streak.
 *
 * Finding 2 (fresh-context review, PR #1235): this used to be `getFlag` then
 * `setFlag` — two non-atomic round trips, the exact race `state.ts`'s own
 * `incrementCounter` doc comment (PR #9 review, BLOCKER F1) exists to fix:
 * "20 concurrent calls against a cap of 3 all succeed". The retry/failover
 * walk can call this more than once per request across models, plus
 * genuinely concurrent client retries, for the SAME studio+fingerprint — a
 * plausible way to bypass or trip the 3-strike gate early. `incrementCounter`
 * itself has no window-expiry reset, so the window math is folded into ONE
 * atomic statement here instead, same `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING` shape: a live (unexpired) stored expiry increments the count and
 * extends the expiry; an absent or expired one resets to a fresh streak of 1
 * — decided and written inside the SAME statement SQLite resolves the
 * `ON CONFLICT` with, never a separate read first.
 */
export async function recordNoFinishReasonFailure(
  db: D1Database, studioId: string, fingerprintHash: string, now: number = Date.now(),
): Promise<number> {
  const key = NFR(studioId, fingerprintHash);
  const expiresAt = now + NO_FINISH_REASON_WINDOW_MS;
  const row = await db
    .prepare(
      `INSERT INTO fleet_state (key, value, ts) VALUES (?, '1|' || ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE
           WHEN CAST(substr(value, instr(value, '|') + 1) AS INTEGER) > ?
             THEN CAST(CAST(substr(value, 1, instr(value, '|') - 1) AS INTEGER) + 1 AS TEXT) || '|' || ?
           ELSE '1|' || ?
         END,
         ts = excluded.ts
       RETURNING value`,
    )
    .bind(key, expiresAt, now, now, expiresAt, expiresAt)
    .first<{ value: string }>();
  const value = row!.value;
  return Number(value.slice(0, value.indexOf("|")));
}

/** Issue #1228: a successful completion clears the streak — the request is
 *  proven non-poisonous, so an identical-input failure later is a fresh event,
 *  not a continuation. */
export async function clearNoFinishReasonFailures(
  db: D1Database, studioId: string, fingerprintHash: string, now: number = Date.now(),
): Promise<void> {
  await deleteFlag(db, NFR(studioId, fingerprintHash));
}

/** Issue #1228: how many live (unexpired) identical-input failures this
 *  fingerprint has racked up. The entry gate refuses at 3 — before spending
 *  any more AI budget on a request proven to fail. */
export async function getNoFinishReasonFailures(
  db: D1Database, studioId: string, fingerprintHash: string, now: number = Date.now(),
): Promise<number> {
  const v = await getFlag(db, NFR(studioId, fingerprintHash));
  if (v === null) return 0;
  const bar = v.lastIndexOf("|");
  if (bar === -1 || !(Number(v.slice(bar + 1)) > now)) return 0;
  return Number(v.slice(0, v.indexOf("|")));
}
