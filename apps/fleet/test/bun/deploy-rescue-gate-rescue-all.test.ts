import { describe, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { deploy, expectRefused, setCreds, stub, test, useDeployRescueHarness, withImage, writeConfig } from "./helpers/deploy-rescue-harness";

let stubs: string;
useDeployRescueHarness((s) => {
  stubs = s.stubs;
});

describe("deploy.sh runs rescue-all before a container-replacing command (#20)", () => {
  test("rescue-all exits 1: refuses, says UNSAFE and names --allow-unrescued, wrangler never runs", () => {
    const r = deploy([], 1);
    expect(r.code).toBe(1);
    expect(r.fleet).toEqual(["fleet rescue-all"]);
    expect(r.err).toContain("stub rescue-all output");
    expect(r.err).toContain("rescue-all reported FAILED -- pre-deploy gate UNSAFE; pass --allow-unrescued to override");
    expect(r.wrangler).toEqual([]);
  });

  test("rescue-all exits 1 with --allow-unrescued: loud WARNING, wrangler runs, flag never reaches wrangler", () => {
    const r = deploy(["--allow-unrescued"], 1);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("WARNING");
    expect(r.err).toContain("--allow-unrescued");
    expect(r.wrangler).toEqual(["wrangler deploy -c wrangler.local.jsonc"]);
  });

  test("rescue-all exits 0: rescue first, then wrangler deploy", () => {
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toEqual(["fleet rescue-all", "wrangler deploy -c wrangler.local.jsonc"]);
  });

  for (const args of [["deploy"], ["deploy", "--minify"], ["versions", "deploy"], ["rollback"], ["delete"], ["--profile", "x", "deploy"]]) {
    test(`"${args.join(" ")}" is gated: rescue-all exit 1 refuses it`, () => {
      const r = deploy(args, 1);
      expect(r.code).toBe(1);
      expect(r.fleet).toEqual(["fleet rescue-all"]);
      expect(r.wrangler).toEqual([]);
    });
  }

  for (const args of [
    ["d1", "migrations", "apply", "fleet", "--remote"],
    ["deploy", "--dry-run"],
    ["versions", "list"],
    ["whoami"],
    // Issue #36 (b), measured on a throwaway Worker: secret put/delete/bulk
    // deploy a new Worker version and restart the Durable Object, but the
    // running container kept its boot id (plain Container DO, n=1; StudioDO
    // extends Sandbox, not measured directly). Ungated.
    ["secret", "put", "X"],
    ["secret", "delete", "X"],
    ["secret", "bulk", "secrets.json"],
    ["containers", "list"],
    ["containers", "info", "abc123"],
    ["containers", "images", "delete", "img:tag"],
  ]) {
    test(`"${args.join(" ")}" replaces no container: rescue-all never runs`, () => {
      const r = deploy(args, 1);
      expect(r.code, r.err).toBe(0);
      expect(r.fleet).toEqual([]);
      expect(r.wrangler).toEqual([`wrangler ${args.join(" ")} -c wrangler.local.jsonc`]);
    });
  }

  test("--allow-unrescued on an ungated command is still consumed, never passed to wrangler", () => {
    const r = deploy(["d1", "migrations", "apply", "fleet", "--remote", "--allow-unrescued"], 1);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler d1 migrations apply fleet --remote -c wrangler.local.jsonc"]);
  });
});

/**
 * Issue #48 (#40 scope add): a workers.dev credentials host matched by the
 * Worker NAME alone let a same-named Worker on ANOTHER account pass. The
 * check now resolves the deploying account's workers.dev subdomain (account:
 * config account_id, else CLOUDFLARE_ACCOUNT_ID, else the one account
 * `wrangler whoami` lists; token: `wrangler auth token`) and compares it.
 * Unresolvable -> refused. Route/custom-domain matches need no lookup.
 */
describe("deploy.sh: workers.dev match compares the account subdomain (#48)", () => {

  test("same Worker name, creds on another account's subdomain -> refused, both subdomains named", () => {
    setCreds("https://fleet-test.acme-sub.workers.dev");
    expectRefused(deploy([], 0), "acme-sub", "example.workers.dev");
  });

  test("same Worker name, same subdomain (whoami's single account) -> passes", () => {
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.probe.some((l) => l.startsWith("probe whoami --json"))).toBe(true);
  });

  test("CLOUDFLARE_ACCOUNT_ID picks the account: acct-b + creds on acme-sub -> passes, whoami not needed", () => {
    setCreds("https://fleet-test.acme-sub.workers.dev");
    const r = deploy([], 0, { CLOUDFLARE_ACCOUNT_ID: "acct-b" });
    expect(r.code, r.err).toBe(0);
    expect(r.probe.some((l) => l.startsWith("probe whoami"))).toBe(false);
  });

  test("config account_id wins over CLOUDFLARE_ACCOUNT_ID, as in wrangler", () => {
    writeConfig({ ...withImage("fleet-test"), account_id: "acct-b" });
    expectRefused(deploy([], 0, { CLOUDFLARE_ACCOUNT_ID: "acct-a" }), "acme-sub");
  });

  test("no account id and whoami lists two accounts -> refused (wrangler would pick from its cache or prompt)", () => {
    stub("whoami.json", { loggedIn: true, accounts: [{ id: "acct-a", name: "A" }, { id: "acct-b", name: "B" }] });
    expectRefused(deploy([], 0), "CLOUDFLARE_ACCOUNT_ID");
  });

  test("API error for the account -> refused", () => {
    expectRefused(deploy([], 0, { CLOUDFLARE_ACCOUNT_ID: "acct-err" }), "workers.dev subdomain");
  });

  test("no auth token (not logged in) -> refused", () => {
    rmSync(join(stubs, "auth-token.json"));
    expectRefused(deploy([], 0), "auth token");
  });

  test("API unreachable -> refused", () => {
    expectRefused(deploy([], 0, { CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:9/client/v4" }), "workers.dev subdomain");
  });

  test("unresolvable with --allow-unrescued -> WARNING, deploy proceeds", () => {
    rmSync(join(stubs, "auth-token.json"));
    const r = deploy(["--allow-unrescued"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("WARNING");
    expect(r.wrangler).toEqual(["wrangler deploy -c wrangler.local.jsonc"]);
  });

  test("route match needs no account lookup (no probe calls at all)", () => {
    writeConfig({ ...withImage("fleet-test"), routes: [{ pattern: "fleet.example.com", custom_domain: true }] });
    setCreds("https://fleet.example.com");
    rmSync(join(stubs, "auth-token.json"));
    const r = deploy(["deploy"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.probe).toEqual([]);
  });

  test("--profile is forwarded to the auth probes (it selects the account)", () => {
    const r = deploy(["--profile", "ops", "deploy"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.probe.length).toBeGreaterThan(0);
    expect(r.probe.every((l) => l.includes("--profile ops"))).toBe(true);
  });
});
