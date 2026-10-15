import { describe, expect } from "bun:test";
import { deploy, envConfig, expectRefused, setCreds, test, useDeployRescueHarness, writeConfig } from "./helpers/deploy-rescue-harness";

useDeployRescueHarness(() => {});

/**
 * Issue #36 (a): rescue-all rescues the fleet ~/.fleet/credentials names;
 * wrangler replaces the Worker the config (+ --env/CLOUDFLARE_ENV, --name)
 * names. Mismatch = the gate rescues the wrong fleet and says SAFE while the
 * real target's containers are replaced unrescued. deploy.sh now refuses a
 * gated command unless the credentials host is the target Worker's host, and
 * fails closed when the target cannot be determined.
 */
describe("deploy.sh refuses when wrangler's target Worker is not the credentials fleet (#36)", () => {
  test("workers.dev mismatch: config Worker fleet-test, creds another Worker -> refused, both named", () => {
    setCreds("https://fleet-other.example.workers.dev");
    expectRefused(deploy([], 0), "fleet-test", "fleet-other.example.workers.dev");
  });

  test("workers.dev match (default beforeEach) passes; host compare ignores case and path", () => {
    setCreds("https://FLEET-TEST.example.workers.dev/studio/");
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toEqual(["fleet rescue-all", "wrangler deploy -c wrangler.local.jsonc"]);
  });

  test("route match: creds on a custom host the config routes to the Worker -> passes", () => {
    writeConfig({ name: "fleet-test", routes: [{ pattern: "fleet.example.com/*", zone_name: "example.com" }] });
    setCreds("https://fleet.example.com");
    const r = deploy(["deploy"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler deploy -c wrangler.local.jsonc"]);
  });

  test("custom_domain route match -> passes", () => {
    writeConfig({ name: "fleet-test", routes: [{ pattern: "fleet.example.com", custom_domain: true }] });
    setCreds("https://fleet.example.com");
    expect(deploy(["deploy"], 0).code).toBe(0);
  });

  test("route mismatch: creds on a custom host the config does not route -> refused", () => {
    writeConfig({ name: "fleet-test", routes: [{ pattern: "fleet.example.com/*", zone_name: "example.com" }] });
    setCreds("https://staging.example.com");
    expectRefused(deploy(["deploy"], 0), "staging.example.com", "fleet.example.com");
  });


  for (const args of [["deploy", "-e", "prod"], ["deploy", "--env", "prod"], ["deploy", "--env=prod"], ["-e", "prod", "versions", "deploy"], ["rollback", "-e", "prod"]]) {
    test(`"${args.join(" ")}" selects Worker fleet-prod while creds point at fleet-test -> refused`, () => {
      writeConfig(envConfig);
      expectRefused(deploy(args, 0), "fleet-prod", "fleet-test.example.workers.dev");
    });
  }

  test("CLOUDFLARE_ENV=prod selects fleet-prod exactly as --env does -> refused", () => {
    writeConfig(envConfig);
    expectRefused(deploy(["deploy"], 0, { CLOUDFLARE_ENV: "prod" }), "fleet-prod");
  });

  test("--env prod with creds on prod's custom domain -> passes", () => {
    writeConfig(envConfig);
    setCreds("https://prod.example.com");
    const r = deploy(["deploy", "-e", "prod"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler deploy -e prod -c wrangler.local.jsonc"]);
  });

  test("--env staging (no name) targets <name>-staging, like wrangler -> creds on fleet-test refused", () => {
    writeConfig(envConfig);
    expectRefused(deploy(["deploy", "-e", "staging"], 0), "fleet-test-staging");
  });

  test("--env staging with creds on fleet-test-staging.<sub>.workers.dev -> passes", () => {
    writeConfig(envConfig);
    setCreds("https://fleet-test-staging.example.workers.dev");
    expect(deploy(["deploy", "-e", "staging"], 0).code).toBe(0);
  });

  for (const args of [["deploy", "--name", "fleet-other"], ["deploy", "--name=fleet-other"], ["delete", "fleet-other"], ["delete", "--name", "fleet-other"]]) {
    test(`"${args.join(" ")}" overrides the Worker name -> refused while creds point at fleet-test`, () => {
      expectRefused(deploy(args, 0), "fleet-other");
    });
  }

  test("--name matching the creds Worker -> passes", () => {
    setCreds("https://fleet-other.example.workers.dev");
    expect(deploy(["deploy", "--name", "fleet-other"], 0).code).toBe(0);
  });

  // Undeterminable target -> fail closed.
  test("no credentials file -> refused (cannot tell which fleet rescue-all would rescue)", () => {
    setCreds(null);
    expectRefused(deploy([], 0), "credentials");
  });

  test("unknown --env -> refused (wrangler's own config reader rejects it)", () => {
    writeConfig(envConfig);
    expectRefused(deploy(["deploy", "-e", "nope"], 0), "nope");
  });

  test("custom-host creds with a config that routes nowhere -> refused", () => {
    setCreds("https://fleet.example.com");
    expectRefused(deploy([], 0), "fleet.example.com", "fleet-test");
  });

  test("a -c/--config in the args (a second config next to deploy.sh's own) -> refused", () => {
    expectRefused(deploy(["deploy", "-c", "other.jsonc"], 0), "--config");
    expectRefused(deploy(["deploy", "--config=other.jsonc"], 0), "--config");
  });

  test("--env given twice -> refused", () => {
    writeConfig(envConfig);
    expectRefused(deploy(["deploy", "-e", "staging", "--env", "prod"], 0), "--env");
  });

  test("WRANGLER_CI_OVERRIDE_NAME set -> refused (it renames the deployed Worker)", () => {
    expectRefused(deploy(["deploy"], 0, { WRANGLER_CI_OVERRIDE_NAME: "fleet-test" }), "WRANGLER_CI_OVERRIDE_NAME");
  });
});
