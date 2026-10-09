import { describe, it, expect } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
  launchAccount, launchAccountOrReroute, accountResolution, unmappedFallbackAccount, resolveClaudeAccounts,
  type AccountUsageMap,
} from "../src/studio/accounts";
import { launchAccountOrRefuse, launchFields, LaunchRefusedError, startAccountRefusal } from "../src/studio/do";
import { writeFleetAccountUsage } from "../src/studio/account-usage-store";
import { withAccountResolution } from "../src/studio/registry";
import { formatAccountResolution } from "../cli/accounts-format";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// ---------------------------------------------------------------------------
// Issue #305 — a repo with no CLAUDE_ACCOUNT_BY_REPO entry silently launched
// on the FIRST set account (accounts.ts launchAccount's unmapped branch). If
// that account was at its weekly limit, the only symptom was a rate-limit
// modal on the lead's pane. Four asks: say which account and why; an opt-in
// strict mode that refuses an unmapped repo; fall back by headroom, not slot
// order; document the key format (bare repo name, never owner/repo).
//
// Fake tokens only (redact.ts's `sk-ant-` shape).
// ---------------------------------------------------------------------------

const TOKEN_1 = "sk-ant-oat01-" + "a".repeat(40);
const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
const TOKEN_3 = "sk-ant-oat01-" + "c".repeat(40);
const ALL = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_1, CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_2, CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_3 };
const SLOT_1 = "CLAUDE_CODE_OAUTH_TOKEN";
const SLOT_2 = "CLAUDE_CODE_OAUTH_TOKEN_2";
const SLOT_3 = "CLAUDE_CODE_OAUTH_TOKEN_3";

function envWith(vars: Record<string, string>): Env {
  return { ...vars, DB: testEnv.DB } as unknown as Env;
}

function fakeStorage(initial?: StudioStatus): StudioStorage {
  const map = new Map<string, unknown>();
  if (initial) map.set(STATUS_KEY, initial);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as StudioStorage["put"],
  };
}

function row(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "newrepo--lead", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

const NOW = new Date("2026-10-09T16:00:00Z");
const fresh = (pct: number): AccountUsageMap[string] =>
  ({ fiveHourPct: pct, sevenDayPct: pct, scopedMaxPct: null, seenAt: new Date(NOW.getTime() - 60_000).toISOString() });

describe("accountResolution (#305 ask 1: say which account and why)", () => {
  it("a mapped repo on its mapped slot reads 'mapped'", () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":2}' });
    expect(accountResolution(env, "fleetflare", SLOT_2)).toBe('mapped (CLAUDE_ACCOUNT_BY_REPO "fleetflare": 2)');
  });

  it("a mapped repo launched elsewhere (failover/reroute) says both slots", () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":2}' });
    expect(accountResolution(env, "fleetflare", SLOT_3)).toBe("mapped to slot 2, launched on slot 3 (failover/reroute)");
  });

  it("an unmapped repo reads 'UNMAPPED, fell back to slot N' and names the exact key to add", () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":2}' });
    const why = accountResolution(env, "newrepo", SLOT_1);
    expect(why).toContain("UNMAPPED, fell back to slot 1");
    expect(why).toContain('"newrepo"');
    expect(why).toContain("not owner/repo");
  });

  it("no launched account (refused, or unknown) has no resolution to report", () => {
    expect(accountResolution(envWith(ALL), "newrepo", null)).toBeNull();
    expect(accountResolution(envWith(ALL), "newrepo", undefined)).toBeNull();
  });
});

describe("withAccountResolution (#305: stamped on the spawn/provision response, never stored)", () => {
  it("stamps the reason from the row's launchedAccount", () => {
    const env = envWith(ALL);
    expect(withAccountResolution(env, row({ launchedAccount: SLOT_1 })).accountResolution)
      .toContain("UNMAPPED, fell back to slot 1");
  });

  it("leaves a row with no launched account unchanged", () => {
    const r = row({ launchedAccount: null });
    expect(withAccountResolution(envWith(ALL), r)).toEqual(r);
  });
});

describe("formatAccountResolution (#305: the CLI line)", () => {
  it("prints account and reason on one line", () => {
    expect(formatAccountResolution("fleet spawn", { launchedAccount: SLOT_1, accountResolution: "UNMAPPED, fell back to slot 1" }))
      .toBe("fleet spawn: claude account CLAUDE_CODE_OAUTH_TOKEN — UNMAPPED, fell back to slot 1");
  });

  it("prints nothing when the Worker sent no resolution (older Worker, glm lead)", () => {
    expect(formatAccountResolution("fleet spawn", { launchedAccount: SLOT_1 })).toBeNull();
  });
});

describe("FLEET_REQUIRE_ACCOUNT_MAP=on (#305 ask 2: strict mode)", () => {
  it("refuses an unmapped repo, naming the missing key and its exact spelling", () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":2}', FLEET_REQUIRE_ACCOUNT_MAP: "on" });
    const r = launchAccount(env, "newrepo", null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("FLEET_REQUIRE_ACCOUNT_MAP");
    expect(r.error).toContain('"newrepo"');
    expect(r.error).toContain("CLAUDE_ACCOUNT_BY_REPO");
    expect(r.error).toContain("not owner/repo");
  });

  it("refuses with no map configured at all", () => {
    const r = launchAccount(envWith({ ...ALL, FLEET_REQUIRE_ACCOUNT_MAP: "on" }), "newrepo", null);
    expect(r.ok).toBe(false);
  });

  it("a mapped repo still launches on its slot", () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":2}', FLEET_REQUIRE_ACCOUNT_MAP: "on" });
    expect(launchAccount(env, "fleetflare", null)).toEqual({ ok: true, name: SLOT_2, token: TOKEN_2 });
  });

  it("off (unset, or anything but 'on') keeps the fallback", () => {
    expect(launchAccount(envWith(ALL), "newrepo", null).ok).toBe(true);
    expect(launchAccount(envWith({ ...ALL, FLEET_REQUIRE_ACCOUNT_MAP: "true" }), "newrepo", null).ok).toBe(true);
  });

  it("the launch gate refuses before any container touch: row degraded with the reason, LaunchRefusedError thrown", async () => {
    const env = envWith({ ...ALL, FLEET_REQUIRE_ACCOUNT_MAP: "on" });
    const storage = fakeStorage(row());
    const recorded: StudioStatus[] = [];
    await expect(launchAccountOrRefuse(env, storage, "newrepo--lead", async (s) => { recorded.push(s); }))
      .rejects.toBeInstanceOf(LaunchRefusedError);
    const after = (await storage.get(STATUS_KEY)) as StudioStatus;
    expect(after.state).toBe("degraded");
    expect(after.error).toContain('"newrepo"');
    expect(recorded).toHaveLength(1);
  });
});

describe("unmappedFallbackAccount (#305 ask 3: most headroom, not first set)", () => {
  const accounts = resolveClaudeAccounts(envWith(ALL));

  it("picks the account with the most headroom by fresh usage", () => {
    const usage = { [SLOT_1]: fresh(97), [SLOT_2]: fresh(50), [SLOT_3]: fresh(10) };
    expect(unmappedFallbackAccount(accounts, new Set(), usage, NOW)?.name).toBe(SLOT_3);
  });

  it("no fresh usage at all: the first set account, exactly as before", () => {
    expect(unmappedFallbackAccount(accounts, new Set(), {}, NOW)?.name).toBe(SLOT_1);
  });

  it("stays off another repo's mapped primary when an unreserved account exists", () => {
    const usage = { [SLOT_1]: fresh(97), [SLOT_2]: fresh(50), [SLOT_3]: fresh(10) };
    expect(unmappedFallbackAccount(accounts, new Set([SLOT_3]), usage, NOW)?.name).toBe(SLOT_2);
  });

  it("every account reserved: headroom over all of them", () => {
    const usage = { [SLOT_1]: fresh(97), [SLOT_2]: fresh(50), [SLOT_3]: fresh(10) };
    expect(unmappedFallbackAccount(accounts, new Set([SLOT_1, SLOT_2, SLOT_3]), usage, NOW)?.name).toBe(SLOT_3);
  });

  it("no accounts: null", () => {
    expect(unmappedFallbackAccount([], new Set(), {}, NOW)).toBeNull();
  });
});

describe("launchAccountOrReroute on an unmapped repo (#305 ask 3)", () => {
  const usage = { [SLOT_1]: fresh(97), [SLOT_2]: fresh(50), [SLOT_3]: fresh(10) };

  it("auto-failover OFF: lands on the most-headroom account", async () => {
    const env = envWith(ALL);
    expect(await launchAccountOrReroute(env, "newrepo", null, {}, new Set(), NOW, null, undefined, usage))
      .toEqual({ ok: true, name: SLOT_3, token: TOKEN_3 });
  });

  it("auto-failover ON: lands on the most-headroom account too", async () => {
    const env = envWith({ ...ALL, FLEET_AUTO_FAILOVER: "on" });
    expect(await launchAccountOrReroute(env, "newrepo", null, {}, new Set(), NOW, null, undefined, usage))
      .toEqual({ ok: true, name: SLOT_3, token: TOKEN_3 });
  });

  it("a MAPPED repo is untouched by usage (flag off)", async () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":1}' });
    expect(await launchAccountOrReroute(env, "fleetflare", null, {}, new Set(), NOW, null, undefined, usage))
      .toEqual({ ok: true, name: SLOT_1, token: TOKEN_1 });
  });

  it("flag ON with a recorded account that still exists: recorded wins, as before (#53)", async () => {
    const env = envWith({ ...ALL, FLEET_AUTO_FAILOVER: "on" });
    expect(await launchAccountOrReroute(env, "newrepo", SLOT_2, {}, new Set(), NOW, null, undefined, usage))
      .toEqual({ ok: true, name: SLOT_2, token: TOKEN_2 });
  });
});

describe("launchAccountOrRefuse reads account-usage rows for an unmapped repo even with failover off (#305 ask 3)", () => {
  it("lands on the most-headroom slot from D1", async () => {
    const seenAt = new Date(Date.now() - 60_000).toISOString();
    await writeFleetAccountUsage(testEnv.DB, SLOT_1, { fiveHourPct: 99, sevenDayPct: 99, scopedMaxPct: null, seenAt });
    await writeFleetAccountUsage(testEnv.DB, SLOT_2, { fiveHourPct: 40, sevenDayPct: 40, scopedMaxPct: null, seenAt });
    await writeFleetAccountUsage(testEnv.DB, SLOT_3, { fiveHourPct: 70, sevenDayPct: 70, scopedMaxPct: null, seenAt });
    const launch = await launchAccountOrRefuse(envWith(ALL), fakeStorage(row()), "newrepo--lead", async () => {}, false);
    expect(launch.name).toBe(SLOT_2);
  });
});

describe("launchFields boots the unmapped pick's own token (#305 ask 3)", () => {
  it("unmapped repo, failover off: token and recorded account are the picked slot's", () => {
    const f = launchFields(envWith(ALL), "newrepo--lead", "spawn-token", SLOT_3);
    expect(f.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_3);
    expect(f.envAccount).toBe(SLOT_3);
  });

  it("MAPPED repo, failover off: still the mapped primary whatever name says (unchanged)", () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: '{"fleetflare":1}' });
    const f = launchFields(env, "fleetflare--lead", "spawn-token", SLOT_3);
    expect(f.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_1);
    expect(f.envAccount).toBe(SLOT_1);
  });
});

describe("startAccountRefusal — the container-start gate under strict mode (#305)", () => {
  const strict = () => envWith({ ...ALL, FLEET_REQUIRE_ACCOUNT_MAP: "on" });

  it("refuses an unmapped claude-lead studio's start, with the same reason", () => {
    expect(startAccountRefusal(strict(), "newrepo--lead", row())).toContain('"newrepo"');
  });

  it("never refuses a glm-lead studio: it runs on no Claude account", () => {
    expect(startAccountRefusal(strict(), "newrepo--lead", row({ leadType: "glm" }))).toBeNull();
  });

  it("a mapped repo starts", () => {
    const env = envWith({ ...ALL, CLAUDE_ACCOUNT_BY_REPO: '{"newrepo":2}', FLEET_REQUIRE_ACCOUNT_MAP: "on" });
    expect(startAccountRefusal(env, "newrepo--lead", row())).toBeNull();
  });
});
