// apps/fleet/test/account-usage-store.test.ts
//
// Issue #238: the D1 half of the headroom-ordering pct row, mirroring
// account-limits-store.test.ts's own real-D1 posture (no mocking of the
// database, `cloudflare:test`'s `env.DB`).
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { readFleetAccountUsage, writeFleetAccountUsage, readOneAccountUsage } from "../src/studio/account-usage-store";

const ACCOUNT = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: "sk-ant-oat01-" + "a".repeat(40) };
const OTHER_ACCOUNT = { name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: "sk-ant-oat01-" + "b".repeat(40) };

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("writeFleetAccountUsage / readFleetAccountUsage", () => {
  it("round-trips a snapshot with a real scopedMaxPct", async () => {
    const snapshot = {
      fiveHourPct: 40, sevenDayPct: 55, scopedMaxPct: 80,
      seenAt: "2026-10-05T00:00:00.000Z",
    };
    await writeFleetAccountUsage(env.DB, ACCOUNT.name, snapshot);
    const usage = await readFleetAccountUsage(env.DB, [ACCOUNT]);
    expect(usage[ACCOUNT.name]).toEqual(snapshot);
  });

  it("round-trips scopedMaxPct: null — no scoped windows reported", async () => {
    const snapshot = {
      fiveHourPct: 10, sevenDayPct: 20, scopedMaxPct: null,
      seenAt: "2026-10-05T00:00:00.000Z",
    };
    await writeFleetAccountUsage(env.DB, ACCOUNT.name, snapshot);
    const usage = await readFleetAccountUsage(env.DB, [ACCOUNT]);
    expect(usage[ACCOUNT.name]).toEqual(snapshot);
  });

  it("an account with no row is absent from the returned record — not a zero/default entry", async () => {
    const usage = await readFleetAccountUsage(env.DB, [ACCOUNT]);
    expect(ACCOUNT.name in usage).toBe(false);
  });

  it("reads multiple accounts independently — one account's row never leaks onto another's", async () => {
    await writeFleetAccountUsage(env.DB, ACCOUNT.name, {
      fiveHourPct: 90, sevenDayPct: 10, scopedMaxPct: null, seenAt: "2026-10-05T00:00:00.000Z",
    });
    const usage = await readFleetAccountUsage(env.DB, [ACCOUNT, OTHER_ACCOUNT]);
    expect(usage[ACCOUNT.name]).toEqual({
      fiveHourPct: 90, sevenDayPct: 10, scopedMaxPct: null, seenAt: "2026-10-05T00:00:00.000Z",
    });
    expect(OTHER_ACCOUNT.name in usage).toBe(false);
  });
});

// Issue #246: the per-account single-row read the sync route needs PER
// DECISION, before it writes -- mirrors account-limits-store.ts's own
// `readOneAccountLimit` (same shape/style, a different store).
describe("readOneAccountUsage", () => {
  it("round-trips a single account's snapshot", async () => {
    const snapshot = {
      fiveHourPct: 40, sevenDayPct: 55, scopedMaxPct: 80,
      seenAt: "2026-10-05T00:00:00.000Z",
    };
    await writeFleetAccountUsage(env.DB, ACCOUNT.name, snapshot);
    const usage = await readOneAccountUsage(env.DB, ACCOUNT.name);
    expect(usage).toEqual(snapshot);
  });

  it("an account with no row reads as null, not an empty object", async () => {
    const usage = await readOneAccountUsage(env.DB, ACCOUNT.name);
    expect(usage).toBeNull();
  });
});
