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
