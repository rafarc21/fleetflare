import { describe, it, expect, vi } from "vitest";
import {
  parseAccountMap, launchAccount, accountDisplay, autoFailoverOn, resolveClaudeAccounts,
} from "../src/studio/accounts";
import { studioEnvVars, launchAccountOrRefuse, LaunchRefusedError } from "../src/studio/do";
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

function envWith(vars: Record<string, string>): Env {
  return vars as unknown as Env;
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
