import { describe, expect } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deploy, envConfig, expectRefused, setCreds, test, useDeployRescueHarness, writeConfig } from "./helpers/deploy-rescue-harness";

let calls: string;
let fleet: string;
useDeployRescueHarness((s) => {
  calls = s.calls;
  fleet = s.fleet;
});

describe("deploy.sh refuses when wrangler's target Worker is not the credentials fleet (#36)", () => {
  for (const args of [["containers", "delete", "abc123"], ["-e", "prod", "containers", "delete", "abc123"], ["containers", "--json", "delete", "abc123"],
    ["containers", "--profile", "list", "delete", "abc123"]]) {
    test(`"${args.join(" ")}": a container app id names no Worker -> refused even when rescue-all passes`, () => {
      writeConfig(envConfig);
      expectRefused(deploy(args, 0), "containers");
    });
  }

  // PR #44 review round 1.
  for (const args of [["deploy", "-e=prod"], ["deploy", "-eprod"], ["deploy", "-c=other.jsonc"]]) {
    test(`short-flag inline form "${args.join(" ")}" (wrangler reads it) -> refused, never read as no env`, () => {
      writeConfig(envConfig);
      expectRefused(deploy(args, 0), args[1]);
    });
  }

  for (const args of [["deploy", "--env-file", "x.env"], ["deploy", "--env-file=x.env"], ["deploy", "--envFile", "x.env"]]) {
    test(`"${args.join(" ")}" (wrangler loads it into its env) -> refused`, () => {
      expectRefused(deploy(args, 0), "--env-file");
    });
  }

  for (const [file, body, args] of [
    [".env", "CLOUDFLARE_ENV=prod\n", ["deploy"]],
    [".env", "export CLOUDFLARE_ENV=prod\n", ["deploy"]],
    [".env.local", "WRANGLER_CI_OVERRIDE_NAME=fleet-prod\n", ["deploy"]],
    [".env", "# note\nCLOUDFLARE_ACCOUNT_ID = abc\n", ["deploy"]],
    [".env.prod", "WRANGLER_CI_OVERRIDE_NAME=x\n", ["deploy", "-e", "prod"]],
    [".env.prod.local", "CLOUDFLARE_ENV: staging\n", ["deploy", "-e", "prod"]],
  ] as const) {
    test(`${file} in the app dir setting a wrangler var (${body.trim().split("\n").pop()}) -> refused`, () => {
      writeConfig(envConfig);
      // Creds match the target as seen WITHOUT the file: only the file can
      // make the check wrong.
      if ((args as readonly string[]).includes("prod")) setCreds("https://prod.example.com");
      expect(deploy([...args], 0).code).toBe(0);
      rmSync(calls, { force: true });
      writeFileSync(join(fleet, file), body);
      expectRefused(deploy([...args], 0), file);
    });
  }

  test(".env in the app dir with only unrelated vars -> passes", () => {
    writeFileSync(join(fleet, ".env"), "FOO=1\nMY_CLOUDFLARE_THING=2\n");
    expect(deploy(["deploy"], 0).code).toBe(0);
  });

  test("wildcard route alone proves nothing: *.example.com/* with creds on staging.example.com -> refused", () => {
    writeConfig({ name: "fleet-test", routes: [{ pattern: "*.example.com/*", zone_name: "example.com" }] });
    setCreds("https://staging.example.com");
    expectRefused(deploy(["deploy"], 0), "staging.example.com");
  });

  test('"delete --profile fleet-test fleet-prod": a flag before the name may eat a value -> refused', () => {
    expectRefused(deploy(["delete", "--profile", "fleet-test", "fleet-prod"], 0), "delete");
  });

  test('"delete --force fleet-other": known boolean skipped, name found -> refused as mismatch', () => {
    expectRefused(deploy(["delete", "--force", "fleet-other"], 0), "fleet-other");
  });

  test('"delete fleet-test --force" -> passes', () => {
    expect(deploy(["delete", "fleet-test", "--force"], 0).code).toBe(0);
  });

  // PR #44 hold: the real ops config names container images relative to the
  // app dir (./container/Dockerfile). Read from the ops checkout, that path
  // does not exist; the check must read the copy wrangler actually gets.
  // (Issue #40: every test now uses that shape -- beforeEach's default.)
  test("config with a relative container image (./container/Dockerfile, present in the app dir only) -> passes", () => {
    const r = deploy(["deploy"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toEqual(["fleet rescue-all", "wrangler deploy -c wrangler.local.jsonc"]);
  });

  test("same relative-image config, creds on another Worker -> still refused as a mismatch", () => {
    setCreds("https://fleet-other.example.workers.dev");
    expectRefused(deploy(["deploy"], 0), "MISMATCH", "fleet-other.example.workers.dev");
  });

  test("mismatch with --allow-unrescued: loud WARNING naming both, deploy proceeds", () => {
    setCreds("https://fleet-other.example.workers.dev");
    const r = deploy(["--allow-unrescued"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("WARNING");
    expect(r.err).toContain("fleet-other.example.workers.dev");
    expect(r.wrangler).toEqual(["wrangler deploy -c wrangler.local.jsonc"]);
  });

  test("read-only command with no credentials never runs the target check", () => {
    setCreds(null);
    const r = deploy(["whoami"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler whoami -c wrangler.local.jsonc"]);
  });
});
