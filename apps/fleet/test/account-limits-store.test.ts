// apps/fleet/test/account-limits-store.test.ts
//
// Issue #232: `clearFleetAccountLimit` — the D1 half of the proactive clear
// (a fresh low-pct cswap reading clears even a `dead: true` row, no separate
// dead check). Real D1 via `cloudflare:test`'s `env.DB`, no mocking of the
// database — same posture as junior.usage.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { writeFleetAccountLimit, readFleetAccountLimits, clearFleetAccountLimit } from "../src/studio/account-limits-store";

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
