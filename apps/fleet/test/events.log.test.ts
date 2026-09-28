import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeEvent } from "../src/events/schema";
import { appendEvent, readSince } from "../src/events/log";

describe("event log", () => {
  it("appends an event and reads it back for the recipient", async () => {
    const e = makeEvent(
      { from: "cto", to: "human", kind: "human", project: "websites", body: "hello" },
      1000,
      "aaa",
    );
    await appendEvent(env.DB, e);

    const rows = await readSince(env.DB, "human", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(e.id);
    expect(rows[0].body).toBe("hello");
    expect(rows[0].requiresAck).toBe(false);
  });

  it("filters by recipient and by timestamp", async () => {
    await appendEvent(env.DB, makeEvent(
      { from: "cto", to: "manager", kind: "task", project: "websites", body: "old" }, 100, "b"));
    await appendEvent(env.DB, makeEvent(
      { from: "cto", to: "manager", kind: "task", project: "websites", body: "new" }, 300, "c"));
    await appendEvent(env.DB, makeEvent(
      { from: "cto", to: "qa", kind: "task", project: "websites", body: "other" }, 300, "d"));

    const rows = await readSince(env.DB, "manager", 200);
    expect(rows.map((r) => r.body)).toEqual(["new"]);
  });

  it("excludes an event exactly at the cursor (sinceTs is exclusive)", async () => {
    await appendEvent(env.DB, makeEvent(
      { from: "cto", to: "boundary", kind: "task", project: "websites", body: "at-cursor" }, 200, "e"));

    const rows = await readSince(env.DB, "boundary", 200);
    expect(rows).toHaveLength(0);
  });
});
