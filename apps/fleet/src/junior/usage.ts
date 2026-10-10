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
  /** Issue #302: why a failed call failed — an error class plus upstream
   *  status/message (anthropic-route.ts's `failureReason`), never prompt or
   *  response text. Absent on ok rows. */
  error?: string;
  /** Issue #335: wall time of the call in ms (glm-lead route only). */
  durationMs?: number;
  /** Issue #335: env.AI.run attempts the call took, 1 = no retry. */
  attempts?: number;
}

/** Single INSERT, one row per /fleet/junior call. Never throws on its own —
 *  route.ts's call site wraps this in its own `.catch(() => {})`, since a
 *  usage-logging failure must never affect the response already streamed to
 *  the studio.
 *
 *  Issue #302: a row WITH an `error` writes migration 0005's `error` column;
 *  a row without one keeps the original column list, so ok rows never depend
 *  on that migration. If the column is missing anyway (Worker deployed before
 *  `migrate:remote` ran), the failure row is retried without it — the call
 *  is still counted, only its reason is lost.
 *
 *  Issue #335: same rule for migration 0006's `duration_ms`/`attempts`. The
 *  fallbacks drop the newest migration's columns first, so a database that
 *  has 0005 but not 0006 still keeps the error reason. */
export async function insertJuniorUsage(db: D1Database, row: JuniorUsageRow): Promise<void> {
  const base: [string, unknown][] = [
    ["id", row.id], ["ts", row.ts], ["studio_id", row.studioId], ["mode", row.mode], ["model", row.model],
    ["input_tokens", row.inputTokens], ["output_tokens", row.outputTokens], ["ok", row.ok ? 1 : 0],
  ];
  const v0005: [string, unknown][] = row.error === undefined ? [] : [["error", row.error]];
  const v0006: [string, unknown][] = [
    ...(row.durationMs === undefined ? [] : [["duration_ms", row.durationMs] as [string, unknown]]),
    ...(row.attempts === undefined ? [] : [["attempts", row.attempts] as [string, unknown]]),
  ];
  // Newest schema first; each fallback is tried only if it differs.
  const shapes = [[...base, ...v0005, ...v0006], [...base, ...v0005], base]
    .filter((cols, i, all) => i === 0 || cols.length !== all[i - 1].length);
  for (let i = 0; i < shapes.length; i++) {
    const cols = shapes[i];
    try {
      await db
        .prepare(
          `INSERT INTO junior_usage_log (${cols.map(([c]) => c).join(", ")})
           VALUES (${cols.map(() => "?").join(", ")})`,
        )
        .bind(...cols.map(([, v]) => v))
        .run();
      return;
    } catch (e) {
      const missingColumn = /no such column|has no column/i.test(e instanceof Error ? e.message : String(e));
      if (!missingColumn || i === shapes.length - 1) throw e;
    }
  }
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
