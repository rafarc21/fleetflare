// Model pool persistence on the existing fleet_state flag table — no migration
// (spec 2026-10-13-model-pool-design, Task 3). Studio assignment and per-model
// pool state are both just flags: `lead-model:<studioId>` -> model id,
// `model-state:<modelId>` -> ModelState.
import { getFlag, setFlag } from "../state";
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

/** Records that `modelId` ran away on this studio's stream. The value
 *  carries its own expiry (`modelId|expiresAtMs`) so no extra column is needed. */
export async function markRunawayAvoid(db: D1Database, studioId: string, modelId: string, now: number = Date.now()): Promise<void> {
  if (!modelById(modelId)) throw new Error(`unknown model ${modelId}`);
  await setFlag(db, AVOID(studioId), `${modelId}|${now + RUNAWAY_AVOID_MS}`, now);
}

/** The model this studio should avoid right now, or null once it has expired. */
export async function getRunawayAvoid(db: D1Database, studioId: string, now: number = Date.now()): Promise<string | null> {
  const v = await getFlag(db, AVOID(studioId));
  if (v === null) return null;
  const bar = v.lastIndexOf("|");
  if (bar === -1) return null;
  const modelId = v.slice(0, bar);
  const expiresAt = Number(v.slice(bar + 1));
  return modelById(modelId) && expiresAt > now ? modelId : null;
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
