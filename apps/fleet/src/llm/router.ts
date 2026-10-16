// Pure model picker (spec 2026-10-13-model-pool-design, Components 3).
import { POOL, type ModelState, type PoolModel } from "./models";

const SMALL = /haiku|small|fast|mini/i;

/** Claude Code names its helper/background calls with a small-model id. Anything else = lead role. */
export function isSmallModelName(requested: unknown): boolean {
  return typeof requested === "string" && requested.length > 0 && SMALL.test(requested);
}

function stateOf(states: Record<string, ModelState>, id: string): ModelState {
  return states[id] ?? "active";
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Round-robin default: stable per studio id over smoke-passed active models (any eligible model if none active).
 * Falls back to the full unfiltered pool when zero models have passed the smoke test, so a model id is always
 * returned rather than crashing on an empty selection.
 */
export function defaultModelFor(studioId: string, pool: readonly PoolModel[], states: Record<string, ModelState>): string {
  const smokePassed = pool.filter((m) => m.smokePassed);
  const eligible = smokePassed.length > 0 ? smokePassed : pool;
  const active = eligible.filter((m) => stateOf(states, m.id) === "active");
  const from = active.length > 0 ? active : eligible;
  return from[hash(studioId) % from.length].id;
}

export function pickModels(input: {
  studioId: string;
  requestedModel: unknown;
  assigned: string | null;
  states: Record<string, ModelState>;
  pool?: readonly PoolModel[];
  poolOn: boolean;
  overflowOn: boolean;
  /** Issue #1099: a model this studio just ran away on. Only moved to the
   *  back of the order, and only with overflow on (so a retry can move on). */
  avoid?: string | null;
}): string[] {
  const pool = input.pool ?? POOL;
  if (!input.poolOn) return [pool[0].id];
  const eligible = pool.filter((m) => m.smokePassed);
  const rank = (id: string) => ({ active: 0, overflow: 1, demoted: 2 })[stateOf(input.states, id)];
  const known = input.assigned !== null && eligible.some((m) => m.id === input.assigned);
  const main = known && rank(input.assigned!) === 0 ? input.assigned! : defaultModelFor(input.studioId, pool, input.states);
  // LEAD_MODEL_OVERFLOW=off (#768): each model has its own 20 rpm budget, so
  // keeping a studio on its ONE assigned model spreads capacity across models;
  // cross-model overflow mid-conversation ended GLM turns badly.
  if (!input.overflowOn) return [main];
  const rest = eligible
    .map((m) => m.id)
    .filter((id) => id !== main)
    .sort((a, b) => rank(a) - rank(b));
  let order = rank(main) === 0 ? [main, ...rest] : [...rest, main].sort((a, b) => rank(a) - rank(b));
  if (isSmallModelName(input.requestedModel)) {
    const roleId = nextActiveAfter(main, eligible.map((m) => m.id), rank);
    if (roleId !== null) order = [roleId, main, ...order.filter((id) => id !== roleId && id !== main)];
  }
  if (input.avoid && order.includes(input.avoid) && order.length > 1) {
    order = [...order.filter((id) => id !== input.avoid), input.avoid];
  }
  return order;
}

/** Circular search for the next `active` model after `afterId`'s position in `idsInOrder` — the pool's own catalog order, not the rank-sorted call order. */
function nextActiveAfter(afterId: string, idsInOrder: string[], rank: (id: string) => number): string | null {
  const start = idsInOrder.indexOf(afterId);
  if (start === -1) return null;
  for (let step = 1; step < idsInOrder.length; step++) {
    const id = idsInOrder[(start + step) % idsInOrder.length];
    if (rank(id) === 0) return id;
  }
  return null;
}
