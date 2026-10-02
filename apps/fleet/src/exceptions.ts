// #168 sensor 4, option (b) (design doc
// docs/superpowers/specs/2026-10-01-sensor-task-control-loop-168-design.md,
// section "4. Worker exceptions"): the Worker's own `fetch`/`scheduled`
// entry points (src/index.ts) wrap their ENTIRE body in one outer
// try/catch and call `recordWorkerException` on anything that escapes,
// before rethrowing the SAME error unchanged. No new credential — the
// Worker already holds D1 write access via `env.DB`.
import { redactSecrets } from "./studio/redact";

/**
 * A thrown non-Error value (reject with a string, a plain object, etc) has
 * no `.stack` and no real name — this is the name this module records for
 * that shape rather than crashing trying to read `.name` off something that
 * might not have one.
 */
const NON_ERROR_NAME = "<non-Error throw>";

/**
 * `stack_head` is the top of a stack trace, not the whole thing — a full
 * stack can run to dozens of frames deep into framework/runtime noise this
 * table has no use keeping forever at 1000+ rows. Picked as a line count
 * (not a char cap) because a stack's useful signal is almost always in its
 * first few call frames, and frame lines vary wildly in length.
 */
const STACK_HEAD_MAX_LINES = 10;

function stackHead(stack: string): string {
  return stack.split("\n").slice(0, STACK_HEAD_MAX_LINES).join("\n");
}

/**
 * Extracts `name`/`message`/`stack` from whatever was thrown. Redaction
 * runs here, on the FULL message/stack, BEFORE any truncation — the same
 * order src/studio/activity.ts's `truncateLine`/`extractLastVisibleLine` doc
 * comments establish and src/studio/grid.ts's `scrubPreview` already
 * implements: redact the full value first, slice second, so a secret
 * straddling the truncation boundary never survives half-caught.
 */
function describeError(err: unknown): { name: string; message: string; stackHead: string | null } {
  if (err instanceof Error) {
    const message = redactSecrets(err.message);
    const stackHead_ = err.stack ? stackHead(redactSecrets(err.stack)) : null;
    return { name: err.name, message, stackHead: stackHead_ };
  }
  return { name: NON_ERROR_NAME, message: redactSecrets(String(err)), stackHead: null };
}

/**
 * Caps `worker_exceptions` at `keep` rows, oldest-first by `ts`. No
 * existing "cap at N rows" precedent elsewhere in this repo (every other
 * table's delete is a timestamp-cutoff, not a row-count cap), so this is
 * new. NEVER throws — a prune failure must not surface any differently
 * than the insert failure it's always called right after (see
 * `recordWorkerException`'s own doc comment for why).
 */
export async function pruneWorkerExceptions(db: D1Database, keep: number = 1000): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM worker_exceptions WHERE id NOT IN (
           SELECT id FROM worker_exceptions ORDER BY ts DESC LIMIT ?
         )`,
      )
      .bind(keep)
      .run();
  } catch (err) {
    console.error("pruneWorkerExceptions failed", err);
  }
}

/**
 * Best-effort, NEVER throws — the issue's own ruling: "insert failure must
 * never change response behavior", i.e. the original error (or the
 * original successful response) must reach the caller exactly as if this
 * feature did not exist. A D1 outage recording the symptom must never also
 * become the symptom. Called from the outer try/catch src/index.ts's
 * `fetch`/`scheduled` wrap their entire body in, right before each
 * rethrows the SAME error it caught.
 */
export async function recordWorkerException(
  db: D1Database, route: string, err: unknown, now: number,
): Promise<void> {
  const { name, message, stackHead: head } = describeError(err);
  try {
    await db
      .prepare(
        `INSERT INTO worker_exceptions (id, ts, route, name, message, stack_head)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), now, route, name, message, head)
      .run();
  } catch (insertErr) {
    console.error("recordWorkerException insert failed", insertErr);
    return;
  }
  await pruneWorkerExceptions(db);
}

/**
 * Read-only — backs the future sensor 4 (and, today, `GET
 * /studio/worker-exceptions/count`, src/studio/routes.ts). Unlike
 * `recordWorkerException`, this one CAN throw/propagate normally: nothing
 * downstream depends on it being silent, since it's a plain read with no
 * response-shape contract to protect.
 */
export async function countWorkerExceptions(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM worker_exceptions`).first<{ n: number }>();
  return row?.n ?? 0;
}
