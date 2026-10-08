// apps/fleet/src/junior/usage.ts
//
// Issue #218: measure GLM (junior) adoption vs Claude. One row per
// /fleet/junior call (route.ts's handleFleetJunior, written fire-and-forget
// right after the AI call resolves/fails), read back through
// aggregateJuniorUsage for the `GET /studio/junior/usage` stats route below.
//
// #249's glm-lead route (anthropic-route.ts) also writes into this table
// now, tagged `mode: "lead"` — see aggregateJuniorUsage's own doc comment
// for why that mode is excluded from the adoption aggregate by default.
//
// Only counts/ids/booleans ever cross into this module's own signatures —
// never prompt/response text — so there is nothing here to redact, by
// construction (the design doc's own "no secrets, no prompt/response text"
// Boundary).
import type { Env } from "../env";
import { verifyAccess } from "../studio/auth";

export interface JuniorUsageRow {
  id: string;
  ts: number;
  studioId: string;
  mode: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
}

/** Single INSERT, one row per /fleet/junior call. Never throws on its own —
 *  route.ts's call site wraps this in its own `.catch(() => {})`, since a
 *  usage-logging failure must never affect the response already streamed to
 *  the studio. */
export async function insertJuniorUsage(db: D1Database, row: JuniorUsageRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO junior_usage_log (id, ts, studio_id, mode, model, input_tokens, output_tokens, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.ts, row.studioId, row.mode, row.model, row.inputTokens, row.outputTokens, row.ok ? 1 : 0)
    .run();
}

export interface JuniorUsageAggregateRow {
  studioId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface JuniorUsageAggregate {
  rows: JuniorUsageAggregateRow[];
  totals: { calls: number; inputTokens: number; outputTokens: number };
}

/** One GROUP BY studio_id query over rows with `ts >= sinceTs`, plus totals
 *  summed in JS over the grouped rows — cheaper than a second SQL round trip
 *  for a result set this small (one row per studio).
 *
 * Fresh-context review finding 2: `anthropic-route.ts`'s glm-lead route
 * writes into this SAME table, tagged `mode: "lead"` (its own `USAGE_MODE`
 * constant) — a studio's entire lead-inference volume, not an occasional
 * junior delegation. This module's own header doc comment states its
 * purpose is specifically "measure GLM (junior) adoption vs Claude", so
 * `mode: "lead"` rows are excluded here by default — real usage/billing
 * data, still inserted and still readable by a raw query, just not junior-
 * adoption data. `JUNIOR_MODES` (junior/route.ts) isn't imported here to
 * express this — that would create a route.ts <-> usage.ts import cycle
 * (route.ts already imports `insertJuniorUsage` from this file) for the sake
 * of one literal that this file needs to exclude, not enumerate. */
export async function aggregateJuniorUsage(db: D1Database, sinceTs: number): Promise<JuniorUsageAggregate> {
  const result = await db
    .prepare(
      `SELECT studio_id AS studioId, COUNT(*) AS calls,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
       FROM junior_usage_log
       WHERE ts >= ? AND mode != 'lead'
       GROUP BY studio_id
       ORDER BY studio_id`,
    )
    .bind(sinceTs)
    .all<{ studioId: string; calls: number; inputTokens: number; outputTokens: number }>();

  const rows = result.results ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );

  return { rows, totals };
}

/**
 * GET /studio/junior/usage — Access-authenticated the same way every other
 * /studio/* route is (verifyAccess, unconditionally first). `?since=<ms
 * epoch>` defaults to 0 (all time); the CLI layer (a later step on this
 * issue) owns duration/date parsing and always hands this a plain epoch ms.
 */
export async function handleJuniorUsageStats(
  req: Request, env: Env, verifyAccessFn: typeof verifyAccess = verifyAccess,
): Promise<Response> {
  const authFailure = await verifyAccessFn(req, env);
  if (authFailure) return authFailure;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam !== null && Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : 0;

  const aggregate = await aggregateJuniorUsage(env.DB, since);
  return Response.json(aggregate);
}
