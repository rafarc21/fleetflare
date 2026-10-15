// Sweep 43 F6 (#883): two suites spelled the same locked-D1 fake — the
// junior_usage_log INSERT throws "database is locked", every other
// statement forwards to the real DB — to prove usage-recording fails
// soft when D1 is locked (#519). Callers keep their own env cast.
export function lockedUsageLogDb(realDb: D1Database): D1Database {
  return {
    prepare: (sql: string) => {
      if (sql.includes("INSERT INTO junior_usage_log")) {
        return {
          bind: () => ({
            run: async () => { throw new Error("D1_ERROR: the database is locked by another connection"); },
          }),
        };
      }
      return realDb.prepare(sql);
    },
  } as unknown as D1Database;
}
