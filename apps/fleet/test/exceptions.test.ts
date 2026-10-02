import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordWorkerException, pruneWorkerExceptions, countWorkerExceptions,
  __resetExceptionRateCapForTests,
} from "../src/exceptions";

// Same fire-and-forget fake ExecutionContext test/github.webhook.test.ts's
// own fakeCtx() already establishes for `ctx.waitUntil` — queues the promise
// rather than awaiting it, so a test can assert it was handed off without
// that itself blocking the test.
function fakeCtx() {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { tasks.push(p); p.catch(() => {}); }),
    passThroughOnException: () => {},
  };
  return ctx as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM worker_exceptions").run();
  __resetExceptionRateCapForTests();
});

async function allRows() {
  const res = await env.DB.prepare(
    "SELECT id, ts, route, name, message, stack_head FROM worker_exceptions ORDER BY ts ASC",
  ).all<{ id: string; ts: number; route: string; name: string; message: string; stack_head: string | null }>();
  return res.results ?? [];
}

describe("recordWorkerException", () => {
  it("inserts one row with the route/name/message from a real Error", async () => {
    await recordWorkerException(env.DB, "/health", new Error("boom"), 1000, fakeCtx());
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ts: 1000, route: "/health", name: "Error", message: "boom" });
  });

  it("handles a thrown non-Error value — no crash, no stack, a stand-in name", async () => {
    await recordWorkerException(env.DB, "scheduled", "just a string", 2000, fakeCtx());
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("<non-Error throw>");
    expect(rows[0].message).toBe("just a string");
    expect(rows[0].stack_head).toBeNull();
  });

  it("redacts a secret shape out of BOTH message and stack_head, full-value first, truncated second", async () => {
    const err = new Error("leaked sk-ant-oat01-abc123 in the message");
    err.stack = `Error: leaked sk-ant-oat01-abc123 in the message\n    at leaked ghs_deadbeef0123`;
    await recordWorkerException(env.DB, "/x", err, 3000, fakeCtx());
    const rows = await allRows();
    expect(rows[0].message).not.toContain("sk-ant-oat01-abc123");
    expect(rows[0].message).toContain("«redacted»");
    expect(rows[0].stack_head).not.toContain("sk-ant-oat01-abc123");
    expect(rows[0].stack_head).not.toContain("ghs_deadbeef0123");
  });

  it("never throws when the insert itself fails — best-effort, swallowed", async () => {
    const failingDb = {
      prepare() {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    await expect(recordWorkerException(failingDb, "/x", new Error("original"), 4000, fakeCtx())).resolves.toBeUndefined();
  });

  it("caps message/stack_head at MAX_FIELD_CHARS, AFTER redaction has already run (fresh-context review, PR #198)", async () => {
    // The secret must actually STRADDLE the 2000-char cut point, or this
    // test can pass even against a truncate-then-redact bug (the secret
    // would sit entirely inside the kept prefix either way). A Telegram bot
    // token (`\d{6,}:[A-Za-z0-9_-]{35}`, src/studio/redact.ts) is chosen
    // specifically because its match requires an EXACT 35-char tail — a
    // naive truncate-first implementation that cuts the tail short leaves a
    // partial, UNMATCHED (and so unredacted) fragment behind, whereas
    // redact-first replaces the whole token with "«redacted»" before the cut
    // ever happens.
    const filler = "f".repeat(1980);
    const telegramId = "123456789"; // 9 digits, satisfies \d{6,}
    const bodyPrefix = "A".repeat(10); // the slice that survives a truncate-first bug
    const telegramBody = bodyPrefix + "B".repeat(10) + "C".repeat(15); // exactly 35 chars
    expect(telegramBody).toHaveLength(35);
    const secret = `${telegramId}:${telegramBody}`;
    const huge = filler + secret; // secret occupies chars [1980, 2025) — straddles 2000
    const err = new Error(huge);
    err.stack = `Error: ${huge}`;
    await recordWorkerException(env.DB, "/x", err, 9000, fakeCtx());
    const rows = await allRows();
    // Redact-first (correct): the WHOLE token is gone, including the prefix
    // chunk a truncate-first bug would have left raw in the output.
    expect(rows[0].message).not.toContain(secret);
    expect(rows[0].message).not.toContain(bodyPrefix);
    expect(rows[0].message.length).toBeLessThanOrEqual(2000);
    expect(rows[0].stack_head).not.toBeNull();
    expect(rows[0].stack_head as string).not.toContain(bodyPrefix);
    expect((rows[0].stack_head as string).length).toBeLessThanOrEqual(2000);
  });

  it("never throws when the caught error's own .message/.stack getters throw", async () => {
    class WeirdError extends Error {
      get message(): string {
        throw new Error("getter boom");
      }
      get stack(): string {
        throw new Error("getter boom");
      }
    }
    await expect(recordWorkerException(env.DB, "/x", new WeirdError(), 5000, fakeCtx())).resolves.toBeUndefined();
  });
});

// Operator fix-first review on PR #198 (issue #188): three hot-path safety
// changes so a struggling D1 cannot turn one failing request into a feedback
// loop against the same struggling D1 (insert + prune, every single failed
// request, with no cap).
describe("recordWorkerException — hot-path safety (operator review, PR #198)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("1a: an insert that hangs past the timeout resolves anyway, as an insert failure", async () => {
    vi.useFakeTimers();
    const hangingDb = {
      prepare() {
        return { bind: () => ({ run: () => new Promise(() => {}) }) };
      },
    } as unknown as D1Database;
    const p = recordWorkerException(hangingDb, "/x", new Error("boom"), 6000, fakeCtx());
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeUndefined();
  });

  it("1b: prune runs behind ctx.waitUntil, not awaited inline in the hot path", async () => {
    const ctx = fakeCtx();
    await recordWorkerException(env.DB, "/x", new Error("boom"), 7000, ctx);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("1b: a hanging prune never blocks recordWorkerException's own resolution", async () => {
    const realDb = env.DB;
    const hangingPruneDb = {
      prepare(sql: string) {
        if (sql.includes("DELETE FROM worker_exceptions")) {
          return { bind: () => ({ run: () => new Promise(() => {}) }) };
        }
        return realDb.prepare(sql);
      },
    } as unknown as D1Database;
    const ctx = fakeCtx();
    await expect(
      recordWorkerException(hangingPruneDb, "/x", new Error("boom"), 8000, ctx),
    ).resolves.toBeUndefined();
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("1c: caps at ~20 records/minute per isolate, dropping the rest with no DB call attempted", async () => {
    for (let i = 0; i < 25; i++) {
      await recordWorkerException(env.DB, "/x", new Error(`err-${i}`), 10_000, fakeCtx());
    }
    const rows = await allRows();
    expect(rows).toHaveLength(20);
  });

  it("1c: the window rolls — a record after 60s of the first one is not capped", async () => {
    for (let i = 0; i < 20; i++) {
      await recordWorkerException(env.DB, "/x", new Error(`a-${i}`), 0, fakeCtx());
    }
    await recordWorkerException(env.DB, "/x", new Error("still in window"), 1000, fakeCtx());
    expect(await allRows()).toHaveLength(20);

    await recordWorkerException(env.DB, "/x", new Error("after window"), 61_000, fakeCtx());
    expect(await allRows()).toHaveLength(21);
  });

  it("1b: a ctx.waitUntil that throws synchronously never masks recordWorkerException's own resolution (fresh-context review, PR #198)", async () => {
    // A `ctx`-shaped object whose `waitUntil` itself throws — the same class
    // of bug `describeError`'s throwing getters already covers above:
    // nothing upstream of this call may be allowed to override the function's
    // own "best-effort, NEVER throws" contract.
    const throwingCtx = {
      waitUntil: () => { throw new Error("waitUntil is broken"); },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    await expect(
      recordWorkerException(env.DB, "/x", new Error("boom"), 8500, throwingCtx),
    ).resolves.toBeUndefined();
  });

  it("1c: logs the drop once via console.error, not once per dropped record", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 25; i++) {
      await recordWorkerException(env.DB, "/x", new Error(`e-${i}`), 20_000, fakeCtx());
    }
    const dropLogs = spy.mock.calls.filter((c) => String(c[0]).toLowerCase().includes("rate cap"));
    expect(dropLogs).toHaveLength(1);
  });
});

describe("countWorkerExceptions", () => {
  it("counts zero against an empty table", async () => {
    expect(await countWorkerExceptions(env.DB)).toBe(0);
  });

  it("counts the real row total", async () => {
    await recordWorkerException(env.DB, "/a", new Error("1"), 1, fakeCtx());
    await recordWorkerException(env.DB, "/b", new Error("2"), 2, fakeCtx());
    expect(await countWorkerExceptions(env.DB)).toBe(2);
  });
});

describe("pruneWorkerExceptions", () => {
  it("caps the table at `keep` rows, keeping the newest by ts", async () => {
    const total = 1005;
    const keep = 1000;
    for (let i = 0; i < total; i++) {
      await env.DB.prepare(
        "INSERT INTO worker_exceptions (id, ts, route, name, message, stack_head) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(`exc-${i}`, i, "/x", "Error", "boom", null).run();
    }

    await pruneWorkerExceptions(env.DB, keep);

    const rows = await allRows();
    expect(rows).toHaveLength(keep);
    // The newest `keep` rows are ts = total-keep .. total-1 (0-indexed).
    const tsValues = rows.map((r) => r.ts).sort((a, b) => a - b);
    expect(tsValues[0]).toBe(total - keep);
    expect(tsValues[tsValues.length - 1]).toBe(total - 1);
  });

  it("is a no-op when the table is already under the cap", async () => {
    await recordWorkerException(env.DB, "/a", new Error("1"), 1, fakeCtx());
    await pruneWorkerExceptions(env.DB, 1000);
    expect(await countWorkerExceptions(env.DB)).toBe(1);
  });

  it("never throws when the delete itself fails — best-effort, swallowed", async () => {
    const failingDb = {
      prepare() {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    await expect(pruneWorkerExceptions(failingDb, 1000)).resolves.toBeUndefined();
  });
});
