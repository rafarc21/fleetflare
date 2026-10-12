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

/** One row of a "<prefix><repo>:<number>" keyed scan, value included. */
export interface StateTaskKey {
  repo: string;
  number: number;
  value: string;
}

/**
 * The one scan behind the two fleet_state readers keyed
 * "<prefix><repo>:<number>" (junior-auth:…:N and read-repos:…:N). One LIKE
 * pass hands D1 the prefix, then the exact `startsWith` re-check decides:
 * LIKE treats `_` as a wildcard (and ASCII case-folds both sides), and a
 * repo name may hold an `_` — so a same-length near-miss key D1 happily
 * returns dies here. The rest is the shared grammar: split at the LAST
 * colon (a repo name may hold a colon too), repo "" when the suffix is a
 * bare number (the prefix already named the repo — authz's depth), keep
 * iff the suffix is digits and the repo is not empty.
 *
 * Returns UNSORTED: order is a caller's verb (authz sorts numerically,
 * grants by repo then number). `value` is always fetched because one of
 * the two callers needs it and the other must not grow a second query
 * shape. Rows are pure reads — no writer anywhere ships this key shape
 * with a non-numeric suffix or an empty repo, so those die silently,
 * fail-closed, the same way both hand-rolled copies already did.
 */
export async function scanStateTaskKeys(
  db: D1Database, prefix: string,
): Promise<StateTaskKey[]> {
  const rows = await db
    .prepare(`SELECT key, value FROM fleet_state WHERE key LIKE ?`)
    .bind(`${prefix}%`)
    .all<{ key: string; value: string }>();
  const out: StateTaskKey[] = [];
  for (const row of rows.results) {
    if (!row.key.startsWith(prefix)) continue;
    const rest = row.key.slice(prefix.length);
    const colon = rest.lastIndexOf(":");
    const repo = colon < 0 ? "" : rest.slice(0, colon);
    const num = colon < 0 ? rest : rest.slice(colon + 1);
    if (colon === 0 || !/^\d+$/.test(num)) continue;
    out.push({ repo, number: Number(num), value: row.value });
  }
  return out;
}
