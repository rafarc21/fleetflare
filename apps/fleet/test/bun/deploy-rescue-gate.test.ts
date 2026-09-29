import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #20: the pre-deploy rescue gate was a README convention
 * (`fleet rescue-all && bun run deploy`). Run `bun run deploy` alone and
 * nothing rescued anything; a FAILED rescue printed no verdict. deploy.sh now
 * runs `fleet rescue-all` itself before any container-replacing wrangler
 * command and refuses on a non-zero exit, unless `--allow-unrescued`.
 *
 * Each test runs a COPY of deploy.sh in a temp tree with a stub
 * cli/fleet.ts (controlled exit code, records its argv) and a stub pinned
 * wrangler (records its argv). The config sits outside any git repo, so the
 * #365 ops-checkout guard only warns.
 *
 * Issue #36: node_modules/wrangler is the REAL pinned wrangler package
 * (symlink), so scripts/deploy-target.ts reads the config exactly as wrangler
 * does. HOME is a temp dir whose ~/.fleet/credentials points, by default, at
 * the config's own Worker (fleet-test.example.workers.dev).
 */
const DEPLOY_SH = resolve(import.meta.dir, "../../scripts/deploy.sh");
const DEPLOY_TARGET_TS = resolve(import.meta.dir, "../../scripts/deploy-target.ts");
const REAL_WRANGLER = resolve(import.meta.dir, "../../node_modules/wrangler");

let root: string;
let fleet: string;
let calls: string;
let config: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-rescue-"));
  fleet = join(root, "fleet-app");
  mkdirSync(join(fleet, "scripts"), { recursive: true });
  copyFileSync(DEPLOY_SH, join(fleet, "scripts", "deploy.sh"));
  if (existsSync(DEPLOY_TARGET_TS)) copyFileSync(DEPLOY_TARGET_TS, join(fleet, "scripts", "deploy-target.ts"));
  calls = join(root, "calls");
  const bin = join(fleet, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "wrangler"), `#!/bin/sh\necho "wrangler $*" >> "${calls}"\n`);
  chmodSync(join(bin, "wrangler"), 0o755);
  symlinkSync(REAL_WRANGLER, join(fleet, "node_modules", "wrangler"));
  const version = JSON.parse(readFileSync(join(REAL_WRANGLER, "package.json"), "utf8")).version;
  writeFileSync(join(fleet, "bun.lock"), `{\n  "packages": {\n    "wrangler": ["wrangler@${version}", "", {}, "sha512-x"],\n  }\n}\n`);
  mkdirSync(join(fleet, "cli"));
  writeFileSync(join(fleet, "cli", "fleet.ts"), [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(calls)}, "fleet " + process.argv.slice(2).join(" ") + "\\n");`,
    'console.error("stub rescue-all output");',
    'process.exit(Number(process.env.STUB_RESCUE_EXIT ?? "0"));',
    "",
  ].join("\n"));
  config = join(root, "wrangler.jsonc");
  writeConfig({ name: "fleet-test" });
  home = join(root, "home");
  setCreds("https://fleet-test.example.workers.dev");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeConfig(c: object) {
  writeFileSync(config, JSON.stringify({ main: "src/index.ts", compatibility_date: "2026-08-01", ...c }, null, 2) + "\n");
}

function setCreds(workerUrl: string | null) {
  rmSync(join(home, ".fleet"), { recursive: true, force: true });
  if (workerUrl === null) return;
  mkdirSync(join(home, ".fleet"), { recursive: true });
  writeFileSync(join(home, ".fleet", "credentials"),
    JSON.stringify({ workerUrl, accessClientId: "x", accessClientSecret: "y" }), { mode: 0o600 });
}

function deploy(args: string[], rescueExit: number, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, FLEET_CONFIG: config, STUB_RESCUE_EXIT: String(rescueExit), ...extraEnv,
  };
  if (!("CLOUDFLARE_ENV" in extraEnv)) delete env.CLOUDFLARE_ENV;
  if (!("WRANGLER_CI_OVERRIDE_NAME" in extraEnv)) delete env.WRANGLER_CI_OVERRIDE_NAME;
  const r = Bun.spawnSync(["bash", join(fleet, "scripts", "deploy.sh"), ...args], { env });
  const log = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  return {
    code: r.exitCode,
    err: r.stderr.toString(),
    fleet: log.filter((l) => l.startsWith("fleet ")),
    wrangler: log.filter((l) => l.startsWith("wrangler ")),
    log,
  };
}

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
 * Issue #36 (a): rescue-all rescues the fleet ~/.fleet/credentials names;
 * wrangler replaces the Worker the config (+ --env/CLOUDFLARE_ENV, --name)
 * names. Mismatch = the gate rescues the wrong fleet and says SAFE while the
 * real target's containers are replaced unrescued. deploy.sh now refuses a
 * gated command unless the credentials host is the target Worker's host, and
 * fails closed when the target cannot be determined.
 */
describe("deploy.sh refuses when wrangler's target Worker is not the credentials fleet (#36)", () => {
  function expectRefused(r: ReturnType<typeof deploy>, ...mentions: string[]) {
    expect(r.code, r.err).toBe(1);
    expect(r.wrangler).toEqual([]);
    expect(r.fleet).toEqual([]);
    expect(r.err).toContain("pass --allow-unrescued to override");
    for (const m of mentions) expect(r.err).toContain(m);
  }

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

  const envConfig = {
    name: "fleet-test",
    env: {
      prod: { name: "fleet-prod", routes: [{ pattern: "prod.example.com", custom_domain: true }] },
      staging: {},
    },
  };

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
  const withImage = (name: string) => ({
    name,
    durable_objects: { bindings: [{ name: "STUDIO", class_name: "StudioDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["StudioDO"] }],
    containers: [{ class_name: "StudioDO", image: "./container/Dockerfile", max_instances: 1 }],
  });

  test("config with a relative container image (./container/Dockerfile, present in the app dir only) -> passes", () => {
    mkdirSync(join(fleet, "container"));
    writeFileSync(join(fleet, "container", "Dockerfile"), "FROM scratch\n");
    writeConfig(withImage("fleet-test"));
    const r = deploy(["deploy"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toEqual(["fleet rescue-all", "wrangler deploy -c wrangler.local.jsonc"]);
  });

  test("same relative-image config, creds on another Worker -> still refused as a mismatch", () => {
    mkdirSync(join(fleet, "container"));
    writeFileSync(join(fleet, "container", "Dockerfile"), "FROM scratch\n");
    writeConfig(withImage("fleet-test"));
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
