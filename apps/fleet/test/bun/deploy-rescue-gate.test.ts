import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 */
const DEPLOY_SH = resolve(import.meta.dir, "../../scripts/deploy.sh");

let root: string;
let fleet: string;
let calls: string;
let config: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-rescue-"));
  fleet = join(root, "fleet-app");
  mkdirSync(join(fleet, "scripts"), { recursive: true });
  copyFileSync(DEPLOY_SH, join(fleet, "scripts", "deploy.sh"));
  calls = join(root, "calls");
  const bin = join(fleet, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "wrangler"), `#!/bin/sh\necho "wrangler $*" >> "${calls}"\n`);
  chmodSync(join(bin, "wrangler"), 0o755);
  mkdirSync(join(fleet, "node_modules", "wrangler"), { recursive: true });
  writeFileSync(join(fleet, "node_modules", "wrangler", "package.json"), '{ "version": "4.141.0" }');
  writeFileSync(join(fleet, "bun.lock"), '{\n  "packages": {\n    "wrangler": ["wrangler@4.141.0", "", {}, "sha512-x"],\n  }\n}\n');
  mkdirSync(join(fleet, "cli"));
  writeFileSync(join(fleet, "cli", "fleet.ts"), [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(calls)}, "fleet " + process.argv.slice(2).join(" ") + "\\n");`,
    'console.error("stub rescue-all output");',
    'process.exit(Number(process.env.STUB_RESCUE_EXIT ?? "0"));',
    "",
  ].join("\n"));
  config = join(root, "wrangler.jsonc");
  writeFileSync(config, '{ "name": "fleet-test" }\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deploy(args: string[], rescueExit: number) {
  const r = Bun.spawnSync(["bash", join(fleet, "scripts", "deploy.sh"), ...args], {
    env: { ...process.env, FLEET_CONFIG: config, STUB_RESCUE_EXIT: String(rescueExit) },
  });
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

  for (const args of [["deploy"], ["deploy", "--minify"], ["versions", "deploy"], ["rollback"], ["delete"], ["--profile", "x", "deploy"],
    ["containers", "delete", "abc123"], ["-e", "prod", "containers", "delete", "abc123"], ["containers", "--json", "delete", "abc123"]]) {
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
    ["secret", "put", "X"],
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
