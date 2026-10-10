// apps/fleet/test/account-limits-store.test.ts
//
// Issue #232: `clearFleetAccountLimit` — the D1 half of the proactive clear
// (a fresh low-pct cswap reading clears even a `dead: true` row, no separate
// dead check). Real D1 via `cloudflare:test`'s `env.DB`, no mocking of the
// database — same posture as junior.usage.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  writeFleetAccountLimit, readFleetAccountLimits, clearFleetAccountLimit, readOneAccountLimit,
  writeAccountHold, writeObservedAccountLimit,
} from "../src/studio/account-limits-store";

const ACCOUNT = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: "sk-ant-oat01-" + "a".repeat(40) };

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("clearFleetAccountLimit", () => {
  it("removes even a dead:true row entirely, not just its dead flag", async () => {
    await writeFleetAccountLimit(env.DB, ACCOUNT.name, null, new Date("2026-10-05T00:00:00Z").toISOString(), true);
    const before = await readFleetAccountLimits(env.DB, [ACCOUNT]);
    expect(before[ACCOUNT.name]).toEqual({ until: null, seenAt: "2026-10-05T00:00:00.000Z", dead: true });

    await clearFleetAccountLimit(env.DB, ACCOUNT.name);

    const after = await readFleetAccountLimits(env.DB, [ACCOUNT]);
    expect(ACCOUNT.name in after).toBe(false);
  });

  it("is a no-op when no row exists for the name", async () => {
    await clearFleetAccountLimit(env.DB, ACCOUNT.name);
    const after = await readFleetAccountLimits(env.DB, [ACCOUNT]);
    expect(ACCOUNT.name in after).toBe(false);
  });
});

// Issue #232 review round: the sync route's own per-decision read, and the
// optional `source` field that distinguishes a usage-sync write
// (routes.ts's POST /studio/accounts/sync) from failover.ts's own
// pane-capture write, which never sets it.
describe("readOneAccountLimit", () => {
  it("reads null for a name with no row", async () => {
    expect(await readOneAccountLimit(env.DB, ACCOUNT.name)).toBeNull();
  });

  it("carries source through a write/read round trip, dead and source together", async () => {
    const seenAt = new Date("2026-10-05T00:00:00Z").toISOString();
    await writeFleetAccountLimit(env.DB, ACCOUNT.name, null, seenAt, true, "usage");
    expect(await readOneAccountLimit(env.DB, ACCOUNT.name)).toEqual({
      until: null, seenAt, dead: true, source: "usage",
    });
  });

  it("omits source when the write never passed one — failover.ts's own write shape", async () => {
    const seenAt = new Date("2026-10-05T00:00:00Z").toISOString();
    await writeFleetAccountLimit(env.DB, ACCOUNT.name, "2026-10-05T05:00:00.000Z", seenAt);
    const state = await readOneAccountLimit(env.DB, ACCOUNT.name);
    expect(state?.source).toBeUndefined();
  });
});

// Issue #336 — the org monthly spend cap and the operator hold. Both carry a
// `kind`; while one is active, a plain window sighting from a studio's pane
// must not shorten it.
describe("issue #336 — held rows (spend_cap / hold)", () => {
  const NOW = new Date("2026-10-10T10:28:00.000Z");
  const seenAt = NOW.toISOString();

  it("readFleetAccountLimits carries kind through", async () => {
    await writeAccountHold(env.DB, ACCOUNT.name, { until: "2026-11-01T00:00:00.000Z", seenAt, kind: "spend_cap" });
    const limits = await readFleetAccountLimits(env.DB, [ACCOUNT]);
    expect(limits[ACCOUNT.name]).toEqual({ until: "2026-11-01T00:00:00.000Z", seenAt, kind: "spend_cap" });
  });

  it("writeAccountHold round-trips an operator hold with its reason and no until", async () => {
    await writeAccountHold(env.DB, ACCOUNT.name, { until: null, seenAt, kind: "hold", reason: "org cap, admin asked" });
    expect(await readOneAccountLimit(env.DB, ACCOUNT.name)).toEqual({
      until: null, seenAt, kind: "hold", reason: "org cap, admin asked",
    });
  });

  it("writeObservedAccountLimit: a window sighting never shortens an active hold", async () => {
    await writeAccountHold(env.DB, ACCOUNT.name, { until: "2026-11-01T00:00:00.000Z", seenAt, kind: "spend_cap" });
    const wrote = await writeObservedAccountLimit(env.DB, ACCOUNT.name, "2026-10-10T12:00:00.000Z", seenAt, undefined, undefined, NOW);
    expect(wrote).toBe(false);
    expect((await readOneAccountLimit(env.DB, ACCOUNT.name))?.kind).toBe("spend_cap");
  });

  it("writeObservedAccountLimit: a spend_cap sighting is written over a plain window row", async () => {
    await writeFleetAccountLimit(env.DB, ACCOUNT.name, "2026-10-10T12:00:00.000Z", seenAt);
    const wrote = await writeObservedAccountLimit(env.DB, ACCOUNT.name, "2026-11-01T00:00:00.000Z", seenAt, undefined, "spend_cap", NOW);
    expect(wrote).toBe(true);
    expect(await readOneAccountLimit(env.DB, ACCOUNT.name)).toEqual({
      until: "2026-11-01T00:00:00.000Z", seenAt, kind: "spend_cap",
    });
  });

  it("writeObservedAccountLimit: a spend_cap sighting never shortens a longer or open-ended operator hold", async () => {
    await writeAccountHold(env.DB, ACCOUNT.name, { until: null, seenAt, kind: "hold", reason: "r" });
    expect(await writeObservedAccountLimit(env.DB, ACCOUNT.name, "2026-11-01T00:00:00.000Z", seenAt, undefined, "spend_cap", NOW)).toBe(false);
    expect(await readOneAccountLimit(env.DB, ACCOUNT.name)).toEqual({ until: null, seenAt, kind: "hold", reason: "r" });

    await writeAccountHold(env.DB, ACCOUNT.name, { until: "2026-10-20T00:00:00.000Z", seenAt, kind: "hold" });
    expect(await writeObservedAccountLimit(env.DB, ACCOUNT.name, "2026-11-01T00:00:00.000Z", seenAt, undefined, "spend_cap", NOW)).toBe(true);
    expect((await readOneAccountLimit(env.DB, ACCOUNT.name))?.kind).toBe("spend_cap");
  });

  it("writeObservedAccountLimit: a window sighting is written once the hold has expired", async () => {
    await writeAccountHold(env.DB, ACCOUNT.name, { until: "2026-10-01T00:00:00.000Z", seenAt, kind: "spend_cap" });
    const wrote = await writeObservedAccountLimit(env.DB, ACCOUNT.name, "2026-10-10T12:00:00.000Z", seenAt, undefined, undefined, NOW);
    expect(wrote).toBe(true);
    expect(await readOneAccountLimit(env.DB, ACCOUNT.name)).toEqual({ until: "2026-10-10T12:00:00.000Z", seenAt });
  });
});
