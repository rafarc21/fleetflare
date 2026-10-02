import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { recordWorkerException, pruneWorkerExceptions, countWorkerExceptions } from "../src/exceptions";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM worker_exceptions").run();
});

async function allRows() {
  const res = await env.DB.prepare(
    "SELECT id, ts, route, name, message, stack_head FROM worker_exceptions ORDER BY ts ASC",
  ).all<{ id: string; ts: number; route: string; name: string; message: string; stack_head: string | null }>();
  return res.results ?? [];
}

describe("recordWorkerException", () => {
  it("inserts one row with the route/name/message from a real Error", async () => {
    await recordWorkerException(env.DB, "/health", new Error("boom"), 1000);
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ts: 1000, route: "/health", name: "Error", message: "boom" });
  });

  it("handles a thrown non-Error value — no crash, no stack, a stand-in name", async () => {
    await recordWorkerException(env.DB, "scheduled", "just a string", 2000);
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("<non-Error throw>");
    expect(rows[0].message).toBe("just a string");
    expect(rows[0].stack_head).toBeNull();
  });

  it("redacts a secret shape out of BOTH message and stack_head, full-value first, truncated second", async () => {
    const err = new Error("leaked sk-ant-oat01-abc123 in the message");
    err.stack = `Error: leaked sk-ant-oat01-abc123 in the message\n    at leaked ghs_deadbeef0123`;
    await recordWorkerException(env.DB, "/x", err, 3000);
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
    await expect(recordWorkerException(failingDb, "/x", new Error("original"), 4000)).resolves.toBeUndefined();
  });
});

describe("countWorkerExceptions", () => {
  it("counts zero against an empty table", async () => {
    expect(await countWorkerExceptions(env.DB)).toBe(0);
  });

  it("counts the real row total", async () => {
    await recordWorkerException(env.DB, "/a", new Error("1"), 1);
    await recordWorkerException(env.DB, "/b", new Error("2"), 2);
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
    await recordWorkerException(env.DB, "/a", new Error("1"), 1);
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
