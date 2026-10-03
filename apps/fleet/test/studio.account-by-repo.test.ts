import { describe, it, expect, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
  parseAccountMap, launchAccount, accountDisplay, autoFailoverOn, resolveClaudeAccounts,
  launchAccountOrReroute, type AccountLimits,
} from "../src/studio/accounts";
import { studioEnvVars, launchAccountOrRefuse, LaunchRefusedError } from "../src/studio/do";
import { writeFleetAccountLimit } from "../src/studio/account-limits-store";
import { withAccountDisplay } from "../src/studio/registry";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
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
// `limits`.
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

  it("mapped slot fleet-wide limited, another slot free: reroutes to the free one, never the limited mapped slot", () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = { CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT } };
    expect(launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW))
      .toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_3", token: TOKEN_3 });
  });

  it("mapped slot limited, every OTHER account also limited or reserved: refuses, naming the earliest reset", () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN: { until: RESET_LATER, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT },
    };
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3"]); // some OTHER repo's own mapped primary
    const result = launchAccountOrReroute(env, "demosite-life", null, limits, reserved, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`every account limited; earliest reset ${RESET_SOON}`);
  });

  it("mapped slot limited, every other account limited too, none has a readable reset: refuses, says 'unknown' rather than printing 'null'", () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = {
      CLAUDE_CODE_OAUTH_TOKEN: { until: null, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_2: { until: null, seenAt: SEEN_AT },
      CLAUDE_CODE_OAUTH_TOKEN_3: { until: null, seenAt: SEEN_AT },
    };
    const result = launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("every account limited; earliest reset unknown");
    expect(result.error).not.toContain("earliest reset null");
  });

  it("mapped slot free: unchanged -- launches on it, no reroute (guards against a regression)", () => {
    const env = envWith({ ...three, FLEET_AUTO_FAILOVER: "on" });
    expect(launchAccountOrReroute(env, "demosite-life", null, {}, new Set(), NOW))
      .toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
  });

  it("auto-failover OFF: a fleet-wide limited mapped slot still launches on it -- today's documented off-semantics, no reroute", () => {
    const env = envWith(three); // FLEET_AUTO_FAILOVER unset -> off
    const limits: AccountLimits = { CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT } };
    expect(launchAccountOrReroute(env, "demosite-life", null, limits, new Set(), NOW))
      .toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 });
  });

  it("the reroute never lands on another repo's reserved primary, even when AccountLimits shows it free", () => {
    const four = { ...three, CLAUDE_CODE_OAUTH_TOKEN_4: TOKEN_4 };
    const env = envWith({ ...four, FLEET_AUTO_FAILOVER: "on" });
    const limits: AccountLimits = { CLAUDE_CODE_OAUTH_TOKEN_2: { until: RESET_SOON, seenAt: SEEN_AT } };
    // CLAUDE_CODE_OAUTH_TOKEN_3 is reserved (some OTHER repo's own mapped
    // primary) but carries no limits entry at all -- it reads as free.
    const reserved = new Set(["CLAUDE_CODE_OAUTH_TOKEN_3"]);
    expect(launchAccountOrReroute(env, "demosite-life", null, limits, reserved, NOW))
      .toEqual({ ok: true, name: "CLAUDE_CODE_OAUTH_TOKEN_4", token: TOKEN_4 });
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
