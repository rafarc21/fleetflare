// apps/fleet/test/bun/junior-auth.test.ts
import { describe, expect, test } from "bun:test";
import { resolveTransport, juniorConfigPath } from "../../../../skills/junior/src/auth";
import { AuthError } from "../../../../skills/junior/src/client";

const deps = (cfg: { accountId?: string } | null = null, tok = "wr-tok") => ({
  readConfig: () => cfg,
  wranglerToken: async () => tok,
});

describe("resolveTransport", () => {
  test("studio env -> proxy, even when an API token is also set", () => {
    const t = resolveTransport({ FLEET_WORKER_URL: "https://w", FLEET_SPAWN_TOKEN: "s", CLOUDFLARE_API_TOKEN: "x" }, deps());
    expect(t).toEqual({ kind: "proxy", url: "https://w", spawnToken: "s" });
  });
  test("API token + account env -> direct api-token", async () => {
    const t = resolveTransport({ CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "a" }, deps());
    expect(t).toMatchObject({ kind: "direct", accountId: "a", source: "api-token", base: "https://api.cloudflare.com/client/v4" });
    if (t.kind === "direct") expect(await t.token()).toBe("x");
  });
  test("no API token -> wrangler, token fetched per call", async () => {
    let n = 0;
    const t = resolveTransport({}, { readConfig: () => ({ accountId: "cfg" }), wranglerToken: async () => `t${++n}` });
    expect(t).toMatchObject({ kind: "direct", accountId: "cfg", source: "wrangler" });
    if (t.kind === "direct") { expect(await t.token()).toBe("t1"); expect(await t.token()).toBe("t2"); }
  });
  test("env account beats config account", () => {
    const t = resolveTransport({ CLOUDFLARE_ACCOUNT_ID: "env" }, deps({ accountId: "cfg" }));
    expect(t.kind === "direct" && t.accountId).toBe("env");
  });
  test("JUNIOR_API_BASE overrides base", () => {
    const t = resolveTransport({ CLOUDFLARE_ACCOUNT_ID: "a", JUNIOR_API_BASE: "http://127.0.0.1:9" }, deps());
    expect(t.kind === "direct" && t.base).toBe("http://127.0.0.1:9");
  });
  test("no account anywhere -> AuthError telling how to fix", () => {
    expect(() => resolveTransport({}, deps())).toThrow(AuthError);
    expect(() => resolveTransport({}, deps())).toThrow("fleet junior enable --account <id>");
  });
});

test("config path", () => {
  expect(juniorConfigPath("/h")).toBe("/h/.config/fleet/junior.json");
});
