// apps/fleet/test/bun/junior-auth.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTransport, juniorConfigPath, defaultAuthDeps } from "../../../../skills/junior/src/auth";
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

  // Task 3 review, note 3: only the PAIR selects the proxy. Either var alone
  // is documented here as falling through to account-id/API-token/wrangler
  // resolution — the existing, intentional behavior, not a bug being fixed.
  test("FLEET_WORKER_URL set without FLEET_SPAWN_TOKEN falls through to direct resolution", () => {
    const t = resolveTransport({ FLEET_WORKER_URL: "https://w", CLOUDFLARE_ACCOUNT_ID: "a" }, deps());
    expect(t.kind).toBe("direct");
  });
  test("FLEET_SPAWN_TOKEN set without FLEET_WORKER_URL falls through to direct resolution", () => {
    const t = resolveTransport({ FLEET_SPAWN_TOKEN: "s", CLOUDFLARE_ACCOUNT_ID: "a" }, deps());
    expect(t.kind).toBe("direct");
  });
});

test("config path", () => {
  expect(juniorConfigPath("/h")).toBe("/h/.config/fleet/junior.json");
});

/**
 * Task 3 review: `resolveTransport` above is only ever exercised through
 * hand-injected fake `deps` closures — the REAL `defaultAuthDeps(env)` (the
 * `wrangler auth token` subprocess and the on-disk config file) had zero
 * coverage. These tests run that real implementation: a real `spawnSync`
 * against a fake `wrangler` script placed on PATH (same PATH-shim convention
 * as test/bun/rescue-push.test.ts and test/bun/git-wrapper.test.ts — a
 * mkdtemp'd bin dir prepended to PATH, cleaned up afterward), and a real
 * `readFileSync`/`JSON.parse` against a real temp HOME.
 *
 * Note: `defaultAuthDeps(env).wranglerToken` spawns using `process.env`
 * directly (not the `env` object passed to `defaultAuthDeps`), so the PATH
 * shim below mutates `process.env.PATH` itself rather than passing a `PATH`
 * key through `defaultAuthDeps`'s `env` argument — that argument only ever
 * reaches `readConfig`.
 */
describe("defaultAuthDeps — real wranglerToken (real spawnSync, real PATH)", () => {
  let origPath: string | undefined;
  let tmpDirs: string[] = [];

  beforeEach(() => { origPath = process.env.PATH; });
  afterEach(() => {
    process.env.PATH = origPath;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  /** Installs a fake `wrangler` script and puts it first on `process.env.PATH`. */
  function fakeWrangler(script: string): void {
    const dir = mkdtempSync(join(tmpdir(), "fleet-junior-wrangler-"));
    tmpDirs.push(dir);
    const bin = join(dir, "wrangler");
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  }

  /** Points `process.env.PATH` at a directory with nothing in it: no `wrangler` anywhere. */
  function emptyPath(): void {
    const dir = mkdtempSync(join(tmpdir(), "fleet-junior-empty-path-"));
    tmpDirs.push(dir);
    process.env.PATH = dir;
  }

  test("a single-line token on stdout, exit 0 -> returned exactly", async () => {
    fakeWrangler("#!/bin/sh\necho fake-token-abc123-abc123-abc123\n");
    const tok = await defaultAuthDeps({}).wranglerToken("acct-1");
    expect(tok).toBe("fake-token-abc123-abc123-abc123");
  });

  test("an update-available banner before the token — only the last non-blank line is the token", async () => {
    fakeWrangler(
      "#!/bin/sh\n" +
      "echo '⛅️ wrangler 3.99.0 update available'\n" +
      "echo 'run npm i wrangler@latest to update'\n" +
      "echo\n" + // a blank line, which the parse must skip too
      "echo fake-token-xyz-xyz-xyz-xyz-xyz\n",
    );
    const tok = await defaultAuthDeps({}).wranglerToken("acct-1");
    expect(tok).toBe("fake-token-xyz-xyz-xyz-xyz-xyz");
  });

  test("non-zero exit -> AuthError, never returns a token", async () => {
    fakeWrangler("#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
    await expect(defaultAuthDeps({}).wranglerToken("acct-1")).rejects.toThrow(AuthError);
  });

  test("no `wrangler` binary anywhere on PATH -> AuthError (spawnSync's natural not-found case)", async () => {
    emptyPath();
    await expect(defaultAuthDeps({}).wranglerToken("acct-1")).rejects.toThrow(AuthError);
  });

  test("exit 0 with empty stdout -> AuthError", async () => {
    fakeWrangler("#!/bin/sh\nexit 0\n");
    await expect(defaultAuthDeps({}).wranglerToken("acct-1")).rejects.toThrow(AuthError);
  });

  test("exit 0 but the last real line has internal whitespace (an error sentence) -> AuthError, not treated as a token", async () => {
    fakeWrangler("#!/bin/sh\necho 'Please run wrangler login first'\n");
    await expect(defaultAuthDeps({}).wranglerToken("acct-1")).rejects.toThrow(AuthError);
  });

  // Task 3 review, note 2: a single WORD with no whitespace can still slip
  // past a whitespace-only check. Tightened to also require a minimum
  // plausible token length (real wrangler/Cloudflare tokens run 40+ chars).
  test("exit 0 with a short single word (no whitespace, not a plausible token) -> AuthError", async () => {
    fakeWrangler("#!/bin/sh\necho NotLoggedIn\n");
    await expect(defaultAuthDeps({}).wranglerToken("acct-1")).rejects.toThrow(AuthError);
  });
});

describe("defaultAuthDeps — real readConfig (real fs, real temp HOME)", () => {
  let home: string;

  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  test("no config file at all -> null", () => {
    home = mkdtempSync(join(tmpdir(), "fleet-junior-home-"));
    expect(defaultAuthDeps({ HOME: home }).readConfig()).toBeNull();
  });

  test("a valid JSON config file -> parsed object", () => {
    home = mkdtempSync(join(tmpdir(), "fleet-junior-home-"));
    const p = juniorConfigPath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ accountId: "acct-from-disk" }));
    expect(defaultAuthDeps({ HOME: home }).readConfig()).toEqual({ accountId: "acct-from-disk" });
  });

  test("a corrupt (non-JSON) config file -> null, never a thrown exception", () => {
    home = mkdtempSync(join(tmpdir(), "fleet-junior-home-"));
    const p = juniorConfigPath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ not valid json");
    expect(() => defaultAuthDeps({ HOME: home }).readConfig()).not.toThrow();
    expect(defaultAuthDeps({ HOME: home }).readConfig()).toBeNull();
  });
});
