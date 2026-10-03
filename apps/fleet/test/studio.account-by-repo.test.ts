import { describe, it, expect, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
  parseAccountMap, launchAccount, accountDisplay, autoFailoverOn, resolveClaudeAccounts,
  launchAccountOrReroute, primaryIsMapped, otherRepoPrimaries, type AccountLimits,
} from "../src/studio/accounts";
import {
  studioEnvVars, launchAccountOrRefuse, LaunchRefusedError, decideAccountClears, applyAccountClears,
} from "../src/studio/do";
import { writeFleetAccountLimit } from "../src/studio/account-limits-store";
import { withAccountDisplay } from "../src/studio/registry";
import { STATUS_KEY, NEVER_MOVED_CTX, type StudioStorage } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// ---------------------------------------------------------------------------
// Issue #271 — a static per-repo PRIMARY account. One Claude account capped
// the whole fleet (91% of its session limit at 08:2xZ, 2026-09-25). A second
// account set as CLAUDE_CODE_OAUTH_TOKEN_2 used to ARM auto-failover for
// every studio; a repo -> account map needs no detector: studios of repo X
// launch on account N, and nothing is killed or relaunched.
//
// Fake tokens only (redact.ts's `sk-ant-` shape); labels use example.com.
// ---------------------------------------------------------------------------

const TOKEN_1 = "sk-ant-oat01-" + "a".repeat(40);
const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
const TOKEN_3 = "sk-ant-oat01-" + "c".repeat(40);
const TOKEN_4 = "sk-ant-oat01-" + "d".repeat(40);

// Issue #209: launchAccountOrRefuse now reads env.DB (when auto-failover is
// on) to consult the fleet-wide AccountLimits map -- merging in ONLY the real
// (migrated, empty-by-default) cloudflare:test D1 keeps every EXISTING test
// below behaving exactly as before (an empty fleet_state table reads back as
// "no limits recorded", i.e. every account free).
function envWith(vars: Record<string, string>): Env {
  return { ...vars, DB: testEnv.DB } as unknown as Env;
}

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "demosite-life--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

function fakeStorage(initial?: StudioStatus): StudioStorage {
  const map = new Map<string, unknown>();
  if (initial) map.set(STATUS_KEY, initial);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as StudioStorage["put"],
  };
}

describe("parseAccountMap", () => {
  it("reads a repo -> account position map", () => {
    expect(parseAccountMap('{"demosite-life":2}')).toEqual({ "demosite-life": 2 });
  });

  it("absent or empty is no map, silently", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseAccountMap(undefined)).toEqual({});
      expect(parseAccountMap("")).toEqual({});
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("bad JSON is no map (every repo on account 1), and it is logged", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseAccountMap("{demosite-life:2")).toEqual({});
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]!.join(" ")).toContain("CLAUDE_ACCOUNT_BY_REPO");
    } finally {
      errors.mockRestore();
    }
  });

  it("an entry that is not a slot 1-9 is dropped and logged; the rest stand", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseAccountMap('{"a":2,"b":0,"c":10,"d":"2","e":1.5}')).toEqual({ a: 2 });
      expect(errors).toHaveBeenCalledTimes(4);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("parseAccountMap — keys that can never match a studio (#273 r2)", () => {
  it("a key that is not a studio-id repo segment is warned once, named, and dropped", () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseAccountMap('{"Demosite-Life":2,"rafarc21/demosite-life":2,"demosite-life":2}')).toEqual({ "demosite-life": 2 });
      expect(warns).toHaveBeenCalledTimes(2);
      const lines = warns.mock.calls.map((c) => c.join(" "));
      expect(lines[0]).toContain('"Demosite-Life"');
      expect(lines[1]).toContain('"rafarc21/demosite-life"');
    } finally {
      warns.mockRestore();
    }
  });
});

// Fresh-context review of PR #211, finding 3 -- extracted so do.ts's
// borrowFields and StudioDO.primaryIsMapped() share this ONE implementation
// rather than each carrying its own hand-copy.
describe("primaryIsMapped", () => {
  const mapped = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}' });

  it("true only when the repo is a genuine key in the map", () => {
    expect(primaryIsMapped(mapped, "demosite-life")).toBe(true);
  });

  it("false for a repo not in the map, even though launchAccount still resolves it (first set account)", () => {
    expect(primaryIsMapped(mapped, "fleetflare")).toBe(false);
  });

  it("false for a null repo", () => {
    expect(primaryIsMapped(mapped, null)).toBe(false);
  });

  it("false with no map at all", () => {
    expect(primaryIsMapped(envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1 }), "demosite-life")).toBe(false);
  });
});

describe("autoFailoverOn", () => {
  it("is off unless FLEET_AUTO_FAILOVER is exactly 'on'", () => {
    expect(autoFailoverOn(envWith({}))).toBe(false);
    expect(autoFailoverOn(envWith({ FLEET_AUTO_FAILOVER: "true" }))).toBe(false);
    expect(autoFailoverOn(envWith({ FLEET_AUTO_FAILOVER: "on" }))).toBe(true);
  });
});

describe("launchAccount", () => {
  const both = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}' };

  it("a mapped repo launches on its account", () => {
    expect(launchAccount(envWith(both), "demosite-life", null))
      .toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
  });

  it("an unmapped repo stays on account 1", () => {
    expect(launchAccount(envWith(both), "fleetflare", null))
      .toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 });
  });

  it("a mapped account whose secret is not set refuses — never a silent fall back to account 1", () => {
    const r = launchAccount(envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}' }), "demosite-life", null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(
      "claude account: demosite-life is mapped to CLAUDE_CODE_OAUTH_TOKEN_2 (CLAUDE_ACCOUNT_BY_REPO), " +
      "and that secret is not set — refusing to launch rather than fall back to another account. " +
      "Set it: wrangler secret put CLAUDE_CODE_OAUTH_TOKEN_2",
    );
    expect(r.error).not.toContain(TOKEN_1);
  });

  it("failover OFF: the recorded account does not override the map — a restart lands on the mapped primary", () => {
    const env = envWith({ ...both, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3 });
    expect(launchAccount(env, "demosite-life", "CLAUDE_CODE_OAUTH_TOKEN_3"))
      .toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
  });

  it("failover ON: a studio that failed over relaunches on the account it moved to (#53, unchanged)", () => {
    const env = envWith({ ...both, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3, FLEET_AUTO_FAILOVER: "on" });
    expect(launchAccount(env, "demosite-life", "CLAUDE_CODE_OAUTH_TOKEN_3"))
      .toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
  });

  it("a label is never read as a token", () => {
    const env = envWith({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_2_LABEL: "second@example.com", CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}',
    });
    expect(resolveClaudeAccounts(env).map((a) => a.name)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(launchAccount(env, "demosite-life", null).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #209 — launchAccount (above) resolves a slot UNCONDITIONALLY: it
// never consults the fleet-wide AccountLimits map (issue #102's
// accountIsFree), so a repo mapped to an account D1 already records, fleet-
// wide, as limited still launched straight onto it. launchAccountOrReroute
// wraps launchAccount with exactly that one extra check, pure (no I/O) --
// launchAccountOrRefuse (do.ts) is the only caller that reads D1 for
// `limits`/burn.
//
// Fresh-context review round of PR #211 (finding A+B) — the ORIGINAL version
// of this function copied only TIER 1 of failover.ts's own three-tier
// account picker (runAccountFailover): it never tried tier 2 (an unclaimed
// spare before this repo's own primary) or tier 3 (borrowing another repo's
// own reserved primary) before refusing. Every `it` below is now async: the
// function itself is, now that tier 3 reads fleet-wide burn (lazily, only on
// that already-rare path) via its own `readBurn` callback parameter.
// ---------------------------------------------------------------------------
describe("launchAccountOrReroute — issue #209: the fleet-wide limit check launchAccountOrRefuse is missing", () => {
  const three = {
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3,
    CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}',
  };
  const NOW = new Date("2026-10-03T12:00:00.000Z");
  const SEEN_AT = "2026-10-03T00:00:00.000Z"; // 12h before NOW -- well inside NULL_UNTIL_CEILING_MS
  const RESET_SOON = "2026-10-03T18:00:00.000Z"; // after NOW
  const RESET_LATER = "2026-10-04T06:00:00.000Z"; // later still

  it("mapped slot fleet-wide limited, another slot free: reroutes to the free one, never the limited mapped slot", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = { CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT } };
    await expect(launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
  });

  // Fresh-context review (finding A+B) — this scenario used to be the
  // ("every OTHER account also limited or reserved: refuses") test, but a
  // RESERVED-and-free account is now exactly what tier 3 exists to borrow
  // rather than refuse against — see the next `it` below for the genuine
  // exhaustion case (the reserved account ALSO limited).
  it("tier 3 — own chain exhausted and no unclaimed spare, but another repo's reserved primary is free: borrows it rather than refusing", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN: { until: RESET_LATER, seenAt: SEEN_AT }, // the only spare before the primary -- also limited
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT },
    };
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3"]); // some OTHER repo's own mapped primary, free
    await expect(launchAccountOrReroute(env, "demosite-life", null, limits, reserved, NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
  });

  it("mapped slot limited, every other account limited too -- INCLUDING the reserved borrow candidate: refuses, naming the earliest reset (the only case that still refuses)", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN: { until: RESET_LATER, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_3: { until: RESET_SOON, seenAt: SEEN_AT }, // reserved AND limited -- the borrow tier misses too
    };
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3"]); // some OTHER repo's own mapped primary
    const result = await launchAccountOrReroute(env, "demosite-life", null, limits, reserved, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`every account limited; earliest reset ${RESET_SOON}`);
  });

  it("tier 2 — every account in this repo's own scoped chain is also limited, but an unclaimed spare BEFORE the primary is free: reroutes there, never refuses", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_3: { until: RESET_SOON, seenAt: SEEN_AT },
    };
    // CLAUDE_CODE_OAUTH_TOKEN (slot 1) sits BEFORE the mapped primary (slot
    // 2) and is claimed by nobody -- an unclaimed spare, never reserved.
    await expect(launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 });
  });

  it("an account recorded dead is never picked by any tier, same as a live limit", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT },
      // dead, with a NULL until -- never free again, no NULL_UNTIL_CEILING_MS
      // re-probe grace the way a plain null-until sighting gets.
      CLAUDE_CODE_OAUTH_TOKEN_3: { until: null, seenAt: SEEN_AT, dead: true },
    };
    // Tier 1's only other own-chain member (account 3) is dead, so this
    // falls through to tier 2's own unclaimed spare (account 1) -- proof
    // `dead` is excluded from every tier, not just the first.
    await expect(launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN", token: TOKEN_1 });
  });

  it("a null-until entry older than the 24h staleness ceiling counts as free again, picked over a genuinely limited one", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const staleSeenAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(); // >24h before NOW
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT }, // the mapped slot, genuinely limited with a readable reset
      CLAUDE_CODE_OAUTH_TOKEN_3: { until: null, seenAt: staleSeenAt }, // a stale null-until sighting -- free again
    };
    await expect(launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
  });

  it("mapped slot limited, every other account limited too, none has a readable reset: refuses, says 'unknown' rather than printing 'null'", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN: { until: null, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: null, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_3: { until: null, seenAt: SEEN_AT },
    };
    const result = await launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("every account limited; earliest reset unknown");
    expect(result.error).not.toContain("earliest reset null");
  });

  it("mapped slot free: unchanged -- launches on it, no reroute (guards against a regression)", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    await expect(launchAccountOrReroute(env, "demosite-life", null, {}, new Set(), NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
  });

  it("auto-failover OFF: a fleet-wide limited mapped slot still launches on it -- today's documented off-semantics, no reroute", async () => {
    const env = envWith(three); // FLEET_AUTO_FAILOVER unset -> off
    const limits: AccountLimits = { CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT } };
    await expect(launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
  });

  it("the reroute never lands on another repo's reserved primary, even when AccountLimits shows it free", async () => {
    const four = { ...three, CLAUDE_CODE_OAUTH_TOKEN_4: TOKEN_4 };
    const env = envWith({ ...four, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = { CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT } };
    // CLAUDE_CODE_OAUTH_TOKEN_3 is reserved (some OTHER repo's own mapped
    // primary) but carries no limits entry at all -- it reads as free.
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3"]);
    await expect(launchAccountOrReroute(env, "demosite-life", null, limits, reserved, NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_4", token: TOKEN_4 });
  });

  // Fresh-context review of PR #211, finding 1 -- `currentOutOfScope` used to
  // be hardcoded `false` here, no matter what the caller actually knows about
  // an active borrow. A studio recorded on (and actively borrowing) an
  // account positioned BEFORE its own mapped primary has no position to step
  // FORWARD from inside `scopedAccounts` (`nextClaudeAccount`'s own `idx < 0`
  // branch returns null immediately -- see accounts.ts:212-213), so tier 1
  // must switch to `firstFreeAccount` over the WHOLE scoped chain instead,
  // exactly as failover.ts's own `currentOutOfScope` derivation
  // (`borrowedActive && currentIdx >= 0 && currentIdx < anchor`) already
  // does. With the hardcoded `false`, tier 1 is a guaranteed no-op for this
  // case, tier 2 (`accounts.slice(0, anchor)`) never covers the in-scope
  // chain either, and the gate wrongly falls through to tier 3 -- borrowing
  // another repo's reserved primary even though a free account is sitting
  // right there in this repo's own scoped chain.
  it("out-of-scope while actively borrowing, own chain also limited but a LATER in-scope account is free: tier 1 picks it, never an unnecessary tier-3 borrow", async () => {
    const four = { ...three, CLAUDE_CODE_OAUTH_TOKEN_4: TOKEN_4 };
    const env = envWith({ ...four, FLEET_AUTO_FAILOVER: "on" });
    // CLAUDE_CODE_OAUTH_TOKEN (slot 1) sits BEFORE the mapped primary (slot
    // 2) -- the studio is recorded on it AND actively borrowing it
    // (existing.borrowedAccount), but it has since gone limited too.
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN: { until: RESET_SOON, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT },
    };
    // CLAUDE_CODE_OAUTH_TOKEN_4 is some OTHER repo's reserved primary, free --
    // exactly what the old hardcoded-false bug wrongly borrowed instead of
    // trying account 3 (this repo's own scoped chain, free) first.
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_4"]);
    await expect(launchAccountOrReroute(
      env, "demosite-life", "CLAUDE_CODE_OAUTH_TOKEN", limits, reserved, NOW,
      "CLAUDE_CODE_OAUTH_TOKEN",
    )).resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
  });

  // #211 review round 3, finding 2 -- `anchor` used to be ALWAYS just the
  // mapped primary's own index, never widened backward the way failover.ts's
  // own `runAccountFailover` derivation already does (`anchor = borrowedActive
  // ? start : (currentIdx < 0 ? start : Math.min(start, currentIdx))`). A
  // studio recorded on an account from BEFORE the repo was ever mapped to a
  // later primary (the "#273 r2" shape), while NOT actively borrowing, hits
  // this directly: `scopedAccounts` (sliced from the unwidened anchor) never
  // even contains the recorded account, so `nextClaudeAccount`'s own
  // `idx < 0` branch returns null immediately -- tier 1 never even tries the
  // primary itself, which sits INSIDE the correctly-widened scope. Tier 2
  // only covers strictly-before-anchor, and tier 3 has nothing reserved to
  // borrow in this fixture -- so, before the fix, this refuses with "every
  // account limited" even though the mapped primary (account 2) is
  // completely free.
  it("stale recorded account from BEFORE a later-mapped primary, not borrowing, primary free: reroutes to the primary rather than refusing", async () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = {
      // The stale recorded account (slot 1) is now fleet-wide limited.
      CLAUDE_CODE_OAUTH_TOKEN: { until: RESET_SOON, seenAt: SEEN_AT },
    };
    // Recorded on slot 1 -- BEFORE the mapped primary (slot 2) -- from
    // before CLAUDE_ACCOUNT_BY_REPO ever existed. NOT actively borrowing (no
    // 7th `borrowedAccount` argument).
    await expect(launchAccountOrReroute(env, "demosite-life", "CLAUDE_CODE_OAUTH_TOKEN", limits, new Set(), NOW))
      .resolves.toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
  });
});

describe("accountDisplay — CLAUDE_ACCOUNT_<n>_LABEL", () => {
  it("label present: '<label> (<secret name>)'", () => {
    const env = envWith({ CLAUDE_ACCOUNT_2_LABEL: "second@example.com" });
    expect(accountDisplay(env, "CLAUDE_CODE_OAUTH_TOKEN_2")).toBe("second@example.com (CLAUDE_CODE_OAUTH_TOKEN_2)");
  });

  it("the first account's label is CLAUDE_ACCOUNT_1_LABEL", () => {
    const env = envWith({ CLAUDE_ACCOUNT_1_LABEL: "first@example.com" });
    expect(accountDisplay(env, "CLAUDE_CODE_OAUTH_TOKEN")).toBe("first@example.com (CLAUDE_CODE_OAUTH_TOKEN)");
  });

  it("label absent: the secret name, exactly as today", () => {
    expect(accountDisplay(envWith({}), "CLAUDE_CODE_OAUTH_TOKEN_2")).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });
});

describe("studioEnvVars — the launch env carries the mapped account's token", () => {
  const env = envWith({
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}',
    WORKER_PUBLIC_URL: "https://fleet.example.com",
  });

  it("a mapped repo's studio gets account 2's token under the one name claude reads", () => {
    expect(studioEnvVars(env, "demosite-life--lead", "fsp_x").CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_2);
  });

  it("an unmapped repo's studio keeps account 1's token", () => {
    expect(studioEnvVars(env, "fleetflare--lead", "fsp_x").CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_1);
  });
});

describe("launchAccountOrRefuse — provision/restart/recycle's gate", () => {
  const missing = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}' });

  it("a mapped-but-missing secret writes a clear row error and throws — nothing launches", async () => {
    const storage = fakeStorage(status());
    const recorded: StudioStatus[] = [];
    await expect(launchAccountOrRefuse(missing, storage, "demosite-life--lead", async (s) => { recorded.push(s); }))
      .rejects.toBeInstanceOf(LaunchRefusedError);
    const row = await storage.get(STATUS_KEY);
    expect(row?.state).toBe("degraded");
    expect(row?.error).toContain("mapped to CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(recorded).toHaveLength(1);
  });

  it("a studio with no row yet still gets one carrying the refusal", async () => {
    const storage = fakeStorage();
    await expect(launchAccountOrRefuse(missing, storage, "demosite-life--lead", async () => {})).rejects.toThrow("refusing to launch");
    expect((await storage.get(STATUS_KEY))?.id).toBe("demosite-life--lead");
  });

  it("a launchable studio writes nothing and answers the account", async () => {
    const storage = fakeStorage(status());
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}' });
    const record = vi.fn(async () => {});
    expect(await launchAccountOrRefuse(env, storage, "demosite-life--lead", record)).toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
    expect(record).not.toHaveBeenCalled();
    expect((await storage.get(STATUS_KEY))?.error).toBeNull();
  });
});

// Issue #209: the real end-to-end wiring (the bug's own repro shape) --
// launchAccountOrRefuse reading the REAL D1 (fleet_state, via
// readFleetAccountLimits/writeFleetAccountLimit) rather than a pure-function
// AccountLimits literal. `until` timestamps are relative to Date.now() (no
// fake clock) since launchAccountOrRefuse's own `now` default is `new Date()`.
describe("launchAccountOrRefuse — fleet-wide limit reroute, real D1 (#209)", () => {
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();
  const seenAt = () => new Date().toISOString();

  it("auto-failover on, mapped slot fleet-wide limited, another slot free: reroutes away from the mapped slot", async () => {
    const env = envWith({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3,
      CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}', FLEET_AUTO_FAILOVER: "on",
    });
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", future(60 * 60 * 1000), seenAt());
    const storage = fakeStorage(status());
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--lead", async () => {});
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(launch.name).not.toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("auto-failover off: a fleet-wide limited mapped slot still launches on it -- the D1 round trip is never even paid", async () => {
    const env = envWith({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}',
    });
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", future(60 * 60 * 1000), seenAt());
    const storage = fakeStorage(status());
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--lead", async () => {});
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  // #211 review round 3, finding 3 -- strengthened to assert the ROW itself,
  // not just the thrown error: a genuine exhaustion must degrade the row
  // and name the earliest reset there too (what `fleet ls` actually reads),
  // not merely reject the promise.
  it("auto-failover on, every configured account fleet-wide limited: refuses, naming the earliest reset", async () => {
    const env = envWith({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2,
      CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}', FLEET_AUTO_FAILOVER: "on",
    });
    const earliest = future(60 * 60 * 1000);
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN", earliest, seenAt());
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", future(2 * 60 * 60 * 1000), seenAt());
    const storage = fakeStorage(status());
    await expect(launchAccountOrRefuse(env, storage, "demosite-life--lead", async () => {}))
      .rejects.toThrow(`every account limited; earliest reset ${earliest}`);
    const row = await storage.get(STATUS_KEY);
    expect(row?.state).toBe("degraded");
    expect(row?.error).toContain(`every account limited; earliest reset ${earliest}`);
  });
});

// Fresh-context review round of PR #211 (#209 follow-up, finding A+B) --
// the launch gate's own tier 3 (borrowing another repo's own reserved
// primary), exercised end-to-end through the REAL D1 wiring
// launchAccountOrRefuse uses, and finding C -- a transient D1 read failure
// must fail OPEN (never strand a studio that recycle's own flow already
// destroyed before this call runs).
describe("launchAccountOrRefuse — borrow tier 3 and D1 failure handling, real D1 (#209 review)", () => {
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();
  const seenAt = () => new Date().toISOString();
  // Two repos mapped: demosite-life on slot 2 (its own primary), "otherrepo"
  // on slot 3 -- otherRepoPrimaries(env, "demosite-life") therefore reserves
  // CLAUDE_CODE_OAUTH_TOKEN_3 for "otherrepo" alone.
  const twoRepos = {
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3,
    CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2,"otherrepo":3}', FLEET_AUTO_FAILOVER: "on",
  };

  it("own chain and spares exhausted, another repo's reserved primary free: borrows it, and the row records borrowedAccount/borrowedFromRepo", async () => {
    const env = envWith(twoRepos);
    // The only spare before the primary (account 1) and the mapped primary
    // itself (account 2) are both fleet-wide limited; the reserved primary
    // (account 3, "otherrepo"'s own) carries no limit entry -- free.
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN", future(60 * 60 * 1000), seenAt());
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", future(60 * 60 * 1000), seenAt());
    const storage = fakeStorage(status());
    const recorded: StudioStatus[] = [];
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--lead", async (s) => { recorded.push(s); });
    expect(launch).toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
    const row = await storage.get(STATUS_KEY);
    expect(row?.borrowedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(row?.borrowedFromRepo).toBe("otherrepo");
    expect(recorded).toHaveLength(1);
  });

  // #211 review round 3, finding 1 -- the test directly above only ever
  // exercises launchAccountOrRefuse's DEFAULT `commitOkClears=true` branch,
  // which no real production caller uses: provisionUngated, restartUngated,
  // and recycle's post-destroy closure (the only decide/apply caller that
  // actually commits) all pass `commitOkClears=false` and go through
  // `decideAccountClears`/`applyAccountClears` instead. Before this fix,
  // `accountClears` (what those two functions call) never computed
  // borrowedAccount/borrowedFromRepo at all -- that computation lived only
  // in launchAccountOrRefuse's own inline `commitOkClears` branch, dead code
  // for every real caller. Without it, a studio that reroutes onto a spare
  // or borrows another repo's reserved primary never gets `borrowedAccount`
  // written, so the hand-back mechanism (failover.ts, gated on exactly that
  // field) never fires and the studio squats on the borrowed account
  // forever, even once its own primary frees up.
  it("the REAL commitOkClears=false path (decide/apply) also records borrowedAccount/borrowedFromRepo -- not just the unused commitOkClears=true default", async () => {
    const env = envWith(twoRepos);
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN", future(60 * 60 * 1000), seenAt());
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", future(60 * 60 * 1000), seenAt());
    const storage = fakeStorage(status());
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };
    // commitOkClears=false -- the ONLY mode every real production caller uses.
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--lead", recordFn, false);
    expect(launch).toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
    // The caller's own success continuation: decide from the pre-touch
    // snapshot, then apply once the (simulated) container start succeeds --
    // the exact shape provisionUngated/restartUngated/recycle's closure use.
    const clears = await decideAccountClears(env, storage, launch, "demosite-life", otherRepoPrimaries(env, "demosite-life"));
    await applyAccountClears(storage, recordFn, clears, NEVER_MOVED_CTX);
    const row = await storage.get(STATUS_KEY);
    expect(row?.borrowedAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(row?.borrowedFromRepo).toBe("otherrepo");
  });

  // #211 review round 4 -- a row already carrying a STALE `borrowedAccount`
  // from an EARLIER launch's reroute/borrow must get cleared once a LATER
  // launch lands back on the repo's own primary, even though that later
  // launch never rerouted at all: `plain` (limit-unaware) and `launch`
  // (limit-aware) both resolve straight to the primary here, so the old
  // `rerouted` gate (`plain.name !== launch.name`) reads false and
  // `borrowFields` never ran, leaving `borrowedAccount`/`borrowedFromRepo`
  // standing even though the studio is actually back home. That stale pair
  // later fires a bogus hand-back switch (failover.ts, gated on exactly
  // `borrowedAccount != null`) -- including a `respawn-pane -k` kill of the
  // lead's own pane -- against a studio that was never away to begin with.
  it("a later launch that lands squarely on the primary clears a STALE borrowedAccount/borrowedFromRepo from an earlier borrow", async () => {
    const env = envWith(twoRepos);
    // The mapped primary (account 2) is free again here, unlike the fixture
    // above -- explicitly overwritten with an already-expired `until` so this
    // test does not depend on whether the earlier test in this describe
    // block (which limits accounts 1 and 2 for an hour) ran first against
    // the same real D1. The row still carries the borrow an EARLIER launch
    // (while account 2 was limited) left behind.
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN", future(-1), seenAt());
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", future(-1), seenAt());
    const storage = fakeStorage(status({ borrowedAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", borrowedFromRepo: "otherrepo" }));
    const recordFn = async (s: StudioStatus) => { await storage.put(STATUS_KEY, s); };
    const launch = await launchAccountOrRefuse(env, storage, "demosite-life--lead", recordFn, false);
    expect(launch).toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
    const clears = await decideAccountClears(env, storage, launch, "demosite-life", otherRepoPrimaries(env, "demosite-life"));
    await applyAccountClears(storage, recordFn, clears, NEVER_MOVED_CTX);
    const row = await storage.get(STATUS_KEY);
    expect(row?.borrowedAccount).toBeNull();
    expect(row?.borrowedFromRepo).toBeNull();
  });

  // Fresh-context review of PR #211, finding 2 -- the try/catch around
  // readFleetAccountBurn (do.ts) had ZERO test coverage: the existing
  // "env.DB.prepare throws" test just below only ever breaks the LIMITS
  // read, in a scenario where tier 1 already resolves, so the burn callback
  // is never even invoked there. This poisons ONLY the burn-prefixed D1 key
  // (`account-burn:...`), leaving the limits read hitting the real D1, in
  // the exact same tiers-1+2-miss fixture as the test above -- the one
  // scenario that actually reaches the lazy tier-3 burn read.
  it("readFleetAccountBurn throws when tiers 1+2 miss: tier 3 still succeeds, burn treated as empty (fail open), and the hiccup is warned", async () => {
    const env = envWith(twoRepos);
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN", future(60 * 60 * 1000), seenAt());
    await writeFleetAccountLimit(env.DB, "CLAUDE_CODE_OAUTH_TOKEN_2", future(60 * 60 * 1000), seenAt());
    const realPrepare = env.DB.prepare.bind(env.DB);
    const poisonedDb = {
      prepare(sql: string) {
        const stmt = realPrepare(sql);
        return {
          bind(...args: unknown[]) {
            if (typeof args[0] === "string" && args[0].startsWith("account-burn:")) {
              return { first: async () => { throw new Error("D1 burn read unavailable"); } };
            }
            return stmt.bind(...args);
          },
        };
      },
    } as unknown as D1Database;
    const poisoned = { ...env, DB: poisonedDb } as unknown as Env;
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = fakeStorage(status());
      const launch = await launchAccountOrRefuse(poisoned, storage, "demosite-life--lead", async () => {});
      expect(launch).toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
      expect(warns).toHaveBeenCalled();
      expect(warns.mock.calls.some((c) => c.join(" ").includes("readFleetAccountBurn"))).toBe(true);
    } finally {
      warns.mockRestore();
    }
  });

  it("env.DB.prepare throws: the fleet-wide limits read is caught, the launch still succeeds using limits = {} (fail open), and the hiccup is warned -- never an uncaught throw", async () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2,
      CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}', FLEET_AUTO_FAILOVER: "on",
      DB: { prepare: () => { throw new Error("D1 unavailable"); } },
    } as unknown as Env;
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = fakeStorage(status());
      const launch = await launchAccountOrRefuse(env, storage, "demosite-life--lead", async () => {});
      expect(launch).toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
      expect(warns).toHaveBeenCalled();
      expect(warns.mock.calls.some((c) => c.join(" ").includes("readFleetAccountLimits"))).toBe(true);
    } finally {
      warns.mockRestore();
    }
  });
});

describe("withAccountDisplay — what fleet ls reads", () => {
  // #292 r2: a row with no launch record never claims an account -- `?`, and
  // the mapped one only as the NEXT launch's.
  it("a mapped studio with no launch record: `?`, the mapped secret as the next launch", () => {
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}' });
    const shown = withAccountDisplay(env, status());
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("the label rides along with a launched account", () => {
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_ACCOUNT_1_LABEL: "first@example.com" });
    expect(withAccountDisplay(env, status({ id: "fleetflare--lead", launchedAccount: "CLAUDE_CODE_OAUTH_TOKEN" })).claudeAccountLabel)
      .toBe("first@example.com");
  });

  it("no map, no launch record: `?` with the first account as the next launch", () => {
    const shown = withAccountDisplay(envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1 }), status({ id: "fleetflare--lead" }));
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("never carries a token", () => {
    const env = envWith({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}' });
    expect(JSON.stringify(withAccountDisplay(env, status()))).not.toContain("sk-ant-");
  });
});

// #273 review round 2: a claudeAccount recorded by an EARLIER failover, with
// the flag now off, is not what launches — so it is not what the operator sees.
describe("stale recorded account with auto-failover off (#273 r2)", () => {
  const vars = {
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3,
    CLAUDE_ACCOUNT_BY_REPO: '{"demosite-life":2}',
  };

  it("fleet ls never shows the stale recorded account: `?`, the mapped one as the next launch", () => {
    const shown = withAccountDisplay(envWith(vars), status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }));
    expect(shown.claudeAccount).toBe("?");
    expect(shown.claudeAccountNext).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  it("with the flag on, the recorded account is what the NEXT launch uses", () => {
    const env = envWith({ ...vars, FLEET_AUTO_FAILOVER: "on" });
    expect(withAccountDisplay(env, status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" })).claudeAccountNext)
      .toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
  });

  it("the next launch clears the stale recorded account from the row", async () => {
    const storage = fakeStorage(status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }));
    const recorded: StudioStatus[] = [];
    const launch = await launchAccountOrRefuse(envWith(vars), storage, "demosite-life--lead", async (s) => { recorded.push(s); });
    expect(launch.name).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect((await storage.get(STATUS_KEY))?.claudeAccount ?? null).toBeNull();
    expect(recorded).toHaveLength(1);
  });

  it("with the flag on, the recorded account stays on the row", async () => {
    const storage = fakeStorage(status({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3" }));
    const record = vi.fn(async () => {});
    await launchAccountOrRefuse(envWith({ ...vars, FLEET_AUTO_FAILOVER: "on" }), storage, "demosite-life--lead", record);
    expect((await storage.get(STATUS_KEY))?.claudeAccount).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(record).not.toHaveBeenCalled();
  });
});
