export async function getFlag(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setFlag(
  db: D1Database, key: string, value: string, now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
    )
    .bind(key, value, now)
    .run();
}

export async function deleteFlag(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM fleet_state WHERE key = ?`).bind(key).run();
}

/**
 * PR #9 review, BLOCKER F1: an atomic "increment `key` and tell me the new
 * total", as ONE D1 statement — never getFlag-then-setFlag, which is a read
 * and a write as two separate round-trips with nothing atomic between them.
 * N genuinely concurrent callers against the same key can all read the same
 * pre-increment value under that shape, all decide they are under a cap, and
 * all then write — a live measurement against ratelimit.ts's old
 * implementation found 20 concurrent calls against a cap of 3 all succeeding.
 *
 * `fleet_state.value` is TEXT (every other flag in this table is a string),
 * so the increment casts to INTEGER, adds one, and casts back — done inside
 * the SAME statement SQLite runs to resolve the `ON CONFLICT`, with the new
 * value read back via `RETURNING` in that one round-trip rather than a
 * follow-up SELECT. A first call for a key that does not exist yet inserts
 * `1` directly, so `RETURNING value` always answers with the post-increment
 * count either way.
 */
export async function incrementCounter(
  db: D1Database, key: string, now: number,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO fleet_state (key, value, ts) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
         ts = excluded.ts
       RETURNING value`,
    )
    .bind(key, now)
    .first<{ value: string }>();
  return Number(row!.value);
}
