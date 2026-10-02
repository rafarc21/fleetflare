import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
 *
 * Issue #40/#48: the default config has the real ops config's shape -- a
 * StudioDO container whose image is the RELATIVE path ./container/Dockerfile
 * (PR #44 hold). The gate's read-only probes (wrangler auth token / whoami /
 * containers list / containers info, marked FLEET_DEPLOY_PROBE=1) are
 * answered by the stub wrangler from files in `stubs/`; docker
 * (WRANGLER_DOCKER_BIN) is a stub too; the Cloudflare API
 * (CLOUDFLARE_API_BASE_URL) is a fake server process. Account acct-a's
 * workers.dev subdomain is "example", acct-b's is "acme-sub", acct-err
 * answers 500. Nothing reaches a real account.
 */
const DEPLOY_SH = resolve(import.meta.dir, "../../scripts/deploy.sh");
const DEPLOY_TARGET_TS = resolve(import.meta.dir, "../../scripts/deploy-target.ts");
const CONTAINERS_CHANGED_TS = resolve(import.meta.dir, "../../scripts/deploy-containers-changed.ts");
const DEPLOY_ENV_GUARD_TS = resolve(import.meta.dir, "../../scripts/deploy-env-guard.ts");
const REAL_WRANGLER = resolve(import.meta.dir, "../../node_modules/wrangler");

let root: string;
let fleet: string;
let calls: string;
let config: string;
let home: string;
let stubs: string;

// Fake Cloudflare API: GET /accounts/<id>/workers/subdomain, bearer
// "stub-token" only. A separate process: deploy() blocks this one.
let api: ReturnType<typeof Bun.spawn>;
let apiBase: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-cf-api-"));
  const script = join(dir, "server.ts");
  writeFileSync(script, [
    'const subs: Record<string, string> = { "acct-a": "example", "acct-b": "acme-sub" };',
    "const s = Bun.serve({ port: 0, fetch(req) {",
    "  const m = /^\\/client\\/v4\\/accounts\\/([^/]+)\\/workers\\/subdomain$/.exec(new URL(req.url).pathname);",
    '  if (req.headers.get("authorization") !== "Bearer stub-token") return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });',
    '  if (!m || !(m[1] in subs)) return Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: m?.[1] === "acct-err" ? 500 : 404 });',
    "  return Response.json({ success: true, result: { subdomain: subs[m[1]] } });",
    "} });",
    "console.log(s.port);",
    "",
  ].join("\n"));
  api = Bun.spawn(["bun", script], { stdout: "pipe" });
  const reader = (api.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  apiBase = `http://127.0.0.1:${new TextDecoder().decode(value).trim()}/client/v4`;
});
afterAll(() => api.kill());

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);
const REPO = "registry.cloudflare.com/acct-a/fleet-test-studiodo";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-rescue-"));
  fleet = join(root, "fleet-app");
  mkdirSync(join(fleet, "scripts"), { recursive: true });
  copyFileSync(DEPLOY_SH, join(fleet, "scripts", "deploy.sh"));
  if (existsSync(DEPLOY_TARGET_TS)) copyFileSync(DEPLOY_TARGET_TS, join(fleet, "scripts", "deploy-target.ts"));
  if (existsSync(CONTAINERS_CHANGED_TS)) copyFileSync(CONTAINERS_CHANGED_TS, join(fleet, "scripts", "deploy-containers-changed.ts"));
  if (existsSync(DEPLOY_ENV_GUARD_TS)) copyFileSync(DEPLOY_ENV_GUARD_TS, join(fleet, "scripts", "deploy-env-guard.ts"));
  calls = join(root, "calls");
  stubs = join(root, "stubs");
  mkdirSync(stubs);
  const bin = join(fleet, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "wrangler"), [
    "#!/bin/sh",
    'if [ -n "$FLEET_DEPLOY_PROBE" ]; then',
    `  echo "probe $*" >> "${calls}"`,
    '  case "$1 $2" in',
    `    "auth token") f="${stubs}/auth-token.json" ;;`,
    `    "whoami --json") f="${stubs}/whoami.json" ;;`,
    `    "containers list") f="${stubs}/containers-list.json" ;;`,
    `    "containers info") f="${stubs}/info-$3.json" ;;`,
    "    *) exit 9 ;;",
    "  esac",
    '  [ -f "$f" ] || { echo "stub: no $f" >&2; exit 1; }',
    '  cat "$f"; exit 0',
    "fi",
    `echo "wrangler $*" >> "${calls}"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "wrangler"), 0o755);
  const docker = join(root, "docker");
  writeFileSync(docker, [
    "#!/bin/sh",
    `echo "docker $*" >> "${calls}"`,
    'case "$1 $2" in',
    '  "build "*) cat > /dev/null; exit "${STUB_DOCKER_BUILD_EXIT:-0}" ;;',
    `  "image inspect") [ -f "${stubs}/repo-digests.json" ] && cat "${stubs}/repo-digests.json" || echo "[]" ;;`,
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(docker, 0o755);
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
  // The real ops config's shape: the image path is relative to the app dir.
  mkdirSync(join(fleet, "container"));
  writeFileSync(join(fleet, "container", "Dockerfile"), "FROM scratch\n");
  config = join(root, "wrangler.jsonc");
  writeConfig(withImage("fleet-test"));
  home = join(root, "home");
  setCreds("https://fleet-test.example.workers.dev");
  stub("auth-token.json", { type: "api_token", token: "stub-token" });
  stub("whoami.json", { loggedIn: true, accounts: [{ id: "acct-a", name: "Acme" }] });
  stub("containers-list.json", []);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function withImage(name: string, container: object = {}) {
  return {
    name,
    durable_objects: { bindings: [{ name: "STUDIO", class_name: "StudioDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["StudioDO"] }],
    containers: [{ class_name: "StudioDO", image: "./container/Dockerfile", max_instances: 1, ...container }],
  };
}

function stub(file: string, body: unknown) {
  writeFileSync(join(stubs, file), JSON.stringify(body));
}

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
    ...process.env, HOME: home, FLEET_CONFIG: config, STUB_RESCUE_EXIT: String(rescueExit),
    CLOUDFLARE_API_BASE_URL: apiBase, WRANGLER_DOCKER_BIN: join(root, "docker"), ...extraEnv,
  };
  for (const k of ["CLOUDFLARE_ENV", "WRANGLER_CI_OVERRIDE_NAME", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  const r = Bun.spawnSync(["bash", join(fleet, "scripts", "deploy.sh"), ...args], { env });
  const all = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
  const log = all.filter((l) => l.startsWith("fleet ") || l.startsWith("wrangler "));
  return {
    code: r.exitCode,
    err: r.stderr.toString(),
    fleet: log.filter((l) => l.startsWith("fleet ")),
    wrangler: log.filter((l) => l.startsWith("wrangler ")),
    probe: all.filter((l) => l.startsWith("probe ")),
    docker: all.filter((l) => l.startsWith("docker ")),
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
 * Issue #204: wrangler auto-loads `.env`/`.env.local` from ITS OWN cwd
 * (deploy.sh cds into the app dir before exec-ing it) into process.env
 * BEFORE it reads the config or authenticates. A stray CLOUDFLARE_* or
 * WRANGLER_* var left in the app dir's `.env` (e.g. from local `wrangler
 * dev` against a sandbox account) silently overrides whatever the operator
 * exported on the command line, retargeting the deploy to a different,
 * unauthorized account. This hit real, reported in #204: `d1 migrations
 * apply --remote` failed with Cloudflare API error [code: 7403] "account not
 * authorized", while the identical bare `wrangler` call (never loading that
 * .env, different cwd) worked.
 *
 * deploy-target.ts's own #36/#48 target check already guards against this
 * same hazard, but it only runs for the container-replacing subset of
 * commands (replaces_containers) -- never for d1, secret, kv, r2, ... This
 * suite proves the NEW guard, scripts/deploy-env-guard.ts, closes that gap
 * for every non-read-only command.
 */
describe("deploy.sh refuses when a stray CLOUDFLARE_*/WRANGLER_* .env var could retarget the deploy (#204)", () => {
  test("d1 migrations apply --remote with a stray CLOUDFLARE_ACCOUNT_ID in .env: refused, wrangler never runs", () => {
    writeFileSync(join(fleet, ".env"), "CLOUDFLARE_ACCOUNT_ID=acct-wrong\n");
    const r = deploy(["d1", "migrations", "apply", "fleet", "--remote"], 0);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(join(fleet, ".env"));
    expect(r.err).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(r.wrangler).toEqual([]);
  });

  test("d1 migrations apply --remote with only an unrelated .env var: not refused, wrangler runs", () => {
    writeFileSync(join(fleet, ".env"), "SOME_OTHER_VAR=x\n");
    const r = deploy(["d1", "migrations", "apply", "fleet", "--remote"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler d1 migrations apply fleet --remote -c wrangler.local.jsonc"]);
  });

  test("d1 migrations apply --local with the same stray CLOUDFLARE_ACCOUNT_ID: not refused (read-only/local is out of scope)", () => {
    writeFileSync(join(fleet, ".env"), "CLOUDFLARE_ACCOUNT_ID=acct-wrong\n");
    const r = deploy(["d1", "migrations", "apply", "fleet", "--local"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler d1 migrations apply fleet --local -c wrangler.local.jsonc"]);
  });

  test("secret put with the same stray .env var: also refused (the fix is not d1-specific)", () => {
    writeFileSync(join(fleet, ".env"), "CLOUDFLARE_ACCOUNT_ID=acct-wrong\n");
    const r = deploy(["secret", "put", "X"], 0);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(join(fleet, ".env"));
    expect(r.err).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(r.wrangler).toEqual([]);
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

  // Issue #204: this exact hazard is now caught EARLIER, by deploy.sh's own
  // unconditional scripts/deploy-env-guard.ts call (before deploy-target.ts
  // even runs), as a hard, non-overridable refusal — not the #36
  // target-mismatch soft gate (--allow-unrescued-eligible) these tests used
  // to exercise. Still refused, still no wrangler/rescue-all run, still
  // names the file; the message no longer offers --allow-unrescued, because
  // there is nothing to override here.
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
      const r = deploy([...args], 0);
      expect(r.code).not.toBe(0);
      expect(r.wrangler).toEqual([]);
      expect(r.fleet).toEqual([]);
      expect(r.err).toContain(file);
    });
  }

  // The property above (refused) is also satisfied by the OLD, pre-#204
  // behavior: a target mismatch from deploy-target.ts's own dotenv scan,
  // overridable with --allow-unrescued. These two cases are the ones that
  // actually distinguish the new hard, non-overridable #204 guard from that
  // old soft gate: a stray dotenv var must still refuse a container-replacing
  // command EVEN WITH --allow-unrescued (and --allow-dirty-ops, which sits
  // outside this check entirely) present.
  test("--allow-unrescued does NOT override the #204 guard: still refused, wrangler and rescue-all never run", () => {
    writeFileSync(join(fleet, ".env"), "CLOUDFLARE_ACCOUNT_ID=acct-wrong\n");
    const r = deploy(["deploy", "--allow-unrescued"], 0);
    expect(r.code).not.toBe(0);
    expect(r.wrangler).toEqual([]);
    expect(r.fleet).toEqual([]);
    expect(r.err).toContain(join(fleet, ".env"));
    expect(r.err).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("--allow-dirty-ops does NOT override the #204 guard either: still refused before the ops-checkout logic it controls", () => {
    writeFileSync(join(fleet, ".env"), "CLOUDFLARE_ACCOUNT_ID=acct-wrong\n");
    const r = deploy(["deploy", "--allow-dirty-ops"], 0);
    expect(r.code).not.toBe(0);
    expect(r.wrangler).toEqual([]);
    expect(r.fleet).toEqual([]);
    expect(r.err).toContain(join(fleet, ".env"));
    expect(r.err).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

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

/**
 * Issue #40 item 1: a Worker-only deploy (same studio image, same container
 * settings) replaces no container, so a failing rescue-all must not block
 * it: rescue-all still runs, its failure is a WARNING, the deploy proceeds.
 * The signal is wrangler 4.141's own: it builds each Dockerfile image, and
 * when the built image's RepoDigests already hold the registry digest the
 * container application runs, it pushes nothing and its apply diff is empty
 * -- no rollout. Anything the probe cannot prove unchanged counts as
 * changed: the gate stays hard.
 */
describe("deploy.sh: rescue-all failure only warns when no container changes (#40)", () => {
  const deployedImage = `${REPO}@${DIGEST_A}`;
  function deployed(app: Record<string, unknown> = {}, configuration: Record<string, unknown> = {}) {
    stub("containers-list.json", [{ id: "app-1", name: "fleet-test-studiodo", image: deployedImage }]);
    stub("info-app-1.json", {
      id: "app-1", name: "fleet-test-studiodo", max_instances: 1, scheduling_policy: "default",
      configuration: { image: deployedImage, vcpu: 0.0625, memory_mib: 256, disk: { size_mb: 2000 }, ...configuration },
      constraints: { tiers: [1, 2] }, rollout_active_grace_period: 0, ...app,
    });
  }
  function builtDigests(list: string[]) {
    stub("repo-digests.json", list);
  }
  function expectHard(r: ReturnType<typeof deploy>, ...mentions: string[]) {
    expect(r.code, r.err).toBe(1);
    expect(r.fleet).toEqual(["fleet rescue-all"]);
    expect(r.wrangler).toEqual([]);
    expect(r.err).toContain("rescue-all reported FAILED -- pre-deploy gate UNSAFE; pass --allow-unrescued to override");
    for (const m of mentions) expect(r.err).toContain(m);
  }

  test("same image digest, same settings: rescue-all fails -> WARNING, Worker-only deploy proceeds", () => {
    deployed();
    builtDigests(["other.example/x@" + DIGEST_B, deployedImage]);
    const r = deploy([], 1);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toEqual(["fleet rescue-all", "wrangler deploy -c wrangler.local.jsonc"]);
    expect(r.err).toContain("WARNING");
    expect(r.err).toContain("no container changes");
    expect(r.err).toContain("fleet-test-studiodo");
  });

  test("the probe builds exactly as wrangler does: linux/amd64, no provenance, Dockerfile on stdin, app-dir context", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { image_vars: { NODE_V: "22" } }));
    const r = deploy(["deploy"], 1);
    expect(r.code, r.err).toBe(0);
    const build = r.docker.find((l) => l.startsWith("docker build "));
    expect(build).toBeDefined();
    expect(build).toContain("--load");
    expect(build).toContain("--platform linux/amd64 --provenance=false");
    expect(build).toContain("--build-arg NODE_V=22");
    expect(build).toContain(`-f - ${join(realpathSync(fleet), "container")}`);
    expect(r.docker.some((l) => l.startsWith("docker image rm "))).toBe(true);
  });

  test("rescue-all passes: the image probe never runs (no docker, no containers calls)", () => {
    deployed();
    builtDigests([deployedImage]);
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.docker).toEqual([]);
    expect(r.probe.filter((l) => l.includes("containers"))).toEqual([]);
  });

  test("SAFETY: image digest changed + rescue-all fails -> still refused", () => {
    deployed();
    builtDigests([`${REPO}@${DIGEST_B}`]);
    expectHard(deploy([], 1), "image changed");
  });

  test("built image never pushed from this machine (no RepoDigests) -> treated as changed, refused", () => {
    deployed();
    builtDigests([]);
    expectHard(deploy([], 1), "image changed");
  });

  test("no deployed container application (first deploy) -> refused", () => {
    builtDigests([deployedImage]);
    expectHard(deploy([], 1), "fleet-test-studiodo");
  });

  test("docker build fails -> undeterminable, refused", () => {
    deployed();
    builtDigests([deployedImage]);
    expectHard(deploy([], 1, { STUB_DOCKER_BUILD_EXIT: "1" }), "cannot tell");
  });

  test("containers list fails (no auth, offline) -> undeterminable, refused", () => {
    builtDigests([deployedImage]);
    rmSync(join(stubs, "containers-list.json"));
    expectHard(deploy([], 1), "cannot tell");
  });

  test("containers info fails -> undeterminable, refused", () => {
    deployed();
    rmSync(join(stubs, "info-app-1.json"));
    builtDigests([deployedImage]);
    expectHard(deploy([], 1), "cannot tell");
  });

  test("same image, max_instances changed -> a rollout, refused", () => {
    deployed({ max_instances: 5 });
    builtDigests([deployedImage]);
    expectHard(deploy([], 1), "max_instances");
  });

  test("same image, instance_type changed (config standard-4, deployed lite) -> refused", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { instance_type: "standard-4" }));
    expectHard(deploy([], 1), "instance");
  });

  test("same image, instance_type standard-4 both sides -> Worker-only, proceeds", () => {
    deployed({}, { vcpu: 4, memory_mib: 12288, disk: { size_mb: 20000 } });
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { instance_type: "standard-4" }));
    const r = deploy([], 1);
    expect(r.code, r.err).toBe(0);
  });

  test("custom instance_type object matching the deployed limits -> proceeds", () => {
    deployed({}, { vcpu: 4, memory_mib: 12288, disk: { size_mb: 20000 } });
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { instance_type: { vcpu: 4, memory_mib: 12288, disk_mb: 20000 } }));
    const r = deploy([], 1);
    expect(r.code, r.err).toBe(0);
  });

  test("rollout_step_percentage (rollout pacing, not part of wrangler's application diff) -> still Worker-only, proceeds", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { rollout_step_percentage: 100 }));
    const r = deploy([], 1);
    expect(r.code, r.err).toBe(0);
  });

  test("an unmodelled key on ANY container is refused BEFORE any image build", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig({
      ...withImage("fleet-test"),
      durable_objects: { bindings: [{ name: "STUDIO", class_name: "StudioDO" }, { name: "AGENT", class_name: "AgentDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StudioDO", "AgentDO"] }],
      containers: [
        { class_name: "StudioDO", image: "./container/Dockerfile", max_instances: 1 },
        { class_name: "AgentDO", image: "./container/Dockerfile", max_instances: 1, constraints: { tiers: [1, 2] } },
      ],
    });
    const r = deploy([], 1);
    expect(r.code).toBe(1);
    expect(r.docker).toEqual([]);
  });

  test("a container setting the probe does not model (constraints) -> undeterminable, refused", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { constraints: { tiers: [1, 2] } }));
    expectHard(deploy([], 1), "constraints");
  });

  // PR #60 review F1: wrangler 4.141 derives each container application's
  // logs setting from the Worker's TOP-LEVEL `observability`
  // (isRootObservabilityLogsEnabled) and, for an app still on the legacy
  // configuration.observability, writes it there -- inside `configuration`,
  // so the rollout diff sees it and containers are replaced.
  describe("top-level observability (F1)", () => {
    test("logs on in config and on the deployed app (legacy configuration.observability) -> unchanged, proceeds", () => {
      deployed({}, { observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: true } });
      const r = deploy([], 1);
      expect(r.code, r.err).toBe(0);
    });

    test("SAFETY: observability flipped off, same image, deployed legacy logs on -> refused", () => {
      deployed({}, { observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: false } });
      expectHard(deploy([], 1), "observability");
    });

    test("SAFETY: observability.logs.enabled false overrides enabled true (wrangler's rule) -> refused vs deployed logs on", () => {
      deployed({}, { observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: true, logs: { enabled: false } } });
      expectHard(deploy([], 1), "observability");
    });

    test("SAFETY: observability turned on, deployed app has none -> refused", () => {
      deployed();
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: true } });
      expectHard(deploy([], 1), "observability");
    });

    test("deployed app on top-level observability, logs on both sides -> unchanged, proceeds", () => {
      deployed({ observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { logs: { enabled: true } } });
      const r = deploy([], 1);
      expect(r.code, r.err).toBe(0);
    });

    test("deployed app with BOTH top-level and legacy logs on (wrangler migrates it) -> refused", () => {
      deployed({ observability: { logs: { enabled: true } } }, { observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: true } });
      expectHard(deploy([], 1), "observability");
    });

    test("top-level `unsafe` set -> cannot tell, refused", () => {
      deployed();
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), unsafe: { metadata: { x: 1 } } });
      expectHard(deploy([], 1), "unsafe");
    });
  });

  // PR #60 review F2: a DO migration deleting, renaming or transferring a
  // container's class changes the container application's Durable Object.
  describe("DO migrations naming a container class (F2)", () => {
    for (const m of [
      { tag: "v2", deleted_classes: ["StudioDO"] },
      { tag: "v2", renamed_classes: [{ from: "StudioDO", to: "StudioDO2" }] },
      { tag: "v2", transferred_classes: [{ from: "StudioDO", from_script: "other", to: "StudioDO" }] },
    ]) {
      test(`${Object.keys(m)[1]} names StudioDO -> cannot tell, refused`, () => {
        deployed();
        builtDigests([deployedImage]);
        const base = withImage("fleet-test");
        writeConfig({ ...base, migrations: [...base.migrations, m] });
        expectHard(deploy([], 1), "migration");
      });
    }

    test("new_sqlite_classes only (the real config's shape) -> not a reason to refuse", () => {
      deployed();
      builtDigests([deployedImage]);
      const r = deploy([], 1);
      expect(r.code, r.err).toBe(0);
    });
  });

  // PR #60 review F4: deploy.sh's own is_plain_deploy layer, independent of
  // the probe's argument check: a non-plain command never reaches the probe.
  describe("is_plain_deploy (F4)", () => {
    for (const args of [[], ["deploy"], ["deploy", "-e", "staging"], ["deploy", "--env=staging"], ["--profile", "ops", "deploy"]]) {
      test(`"${args.join(" ")}" is plain: the probe runs`, () => {
        const base = withImage("fleet-test");
        writeConfig({ ...base, env: { staging: { durable_objects: base.durable_objects, containers: base.containers } } });
        if (args.some((a) => a.includes("staging"))) setCreds("https://fleet-test-staging.example.workers.dev");
        const r = deploy(args, 1);
        expect(r.probe.some((l) => l.startsWith("probe containers list"))).toBe(true);
      });
    }
    for (const args of [
      ["versions", "deploy"], ["rollback"], ["delete", "fleet-test"],
      ["deploy", "--containers-rollout", "immediate"], ["deploy", "--name", "fleet-test"],
      ["deploy", "--var", "X:1"], ["deploy", "--minify"], ["deploy", "extra-word"],
    ]) {
      test(`"${args.join(" ")}" is NOT plain: refused, the probe never runs`, () => {
        deployed();
        builtDigests([deployedImage]);
        const r = deploy(args, 1);
        expect(r.code).toBe(1);
        expect(r.wrangler).toEqual([]);
        expect(r.docker).toEqual([]);
        expect(r.probe.filter((l) => l.includes("containers"))).toEqual([]);
        // deploy.sh itself never started the probe script.
        expect(r.err).not.toContain("deploy-containers:");
      });
    }
  });

  test("config with no containers at all -> undeterminable, refused", () => {
    writeConfig({ name: "fleet-test" });
    expectHard(deploy([], 1), "no containers");
  });

  test("two containers, one unchanged and one changed -> refused", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig({
      ...withImage("fleet-test"),
      durable_objects: { bindings: [{ name: "STUDIO", class_name: "StudioDO" }, { name: "AGENT", class_name: "AgentDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StudioDO", "AgentDO"] }],
      containers: [
        { class_name: "StudioDO", image: "./container/Dockerfile", max_instances: 1 },
        { class_name: "AgentDO", image: "./container/Dockerfile", max_instances: 1 },
      ],
    });
    expectHard(deploy([], 1), "fleet-test-agentdo");
  });

  for (const args of [["versions", "deploy"], ["rollback"], ["deploy", "--containers-rollout", "immediate"]]) {
    test(`"${args.join(" ")}" is not a plain deploy: same image, rescue fails -> refused`, () => {
      deployed();
      builtDigests([deployedImage]);
      const r = deploy(args, 1);
      expect(r.code).toBe(1);
      expect(r.wrangler).toEqual([]);
    });
  }

  test("--env selects the env container app, named by wrangler own reader (fleet-test-studiodo-staging)", () => {
    const base = withImage("fleet-test");
    // durable_objects and containers are not inherited by an env.
    writeConfig({ ...base, env: { staging: { durable_objects: base.durable_objects, containers: base.containers } } });
    setCreds("https://fleet-test-staging.example.workers.dev");
    const img = "registry.cloudflare.com/acct-a/fleet-test-studiodo-staging@" + DIGEST_A;
    stub("containers-list.json", [{ id: "app-2", name: "fleet-test-studiodo-staging", image: img }]);
    stub("info-app-2.json", {
      id: "app-2", name: "fleet-test-studiodo-staging", max_instances: 1, scheduling_policy: "default",
      configuration: { image: img, vcpu: 0.0625, memory_mib: 256, disk: { size_mb: 2000 } },
      constraints: { tiers: [1, 2] }, rollout_active_grace_period: 0,
    });
    builtDigests([img]);
    const r = deploy(["deploy", "-e", "staging"], 1);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler deploy -e staging -c wrangler.local.jsonc"]);
  });
});

/**
 * Issue #40 item 2: --allow-unrescued (and the Worker-only soft pass) used
 * to leave only a stderr line. Each now appends one JSON line to
 * ~/.fleet/deploy-overrides.jsonl -- the same small local ~/.fleet/ record
 * convention as orca-workspaces.json and locks/. No email in it.
 */
describe("deploy.sh records every rescue-gate override durably (#40)", () => {
  const logPath = () => join(home, ".fleet", "deploy-overrides.jsonl");
  const records = () => readFileSync(logPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const gitUser = (name: string | null) => {
    const f = join(root, "gitconfig");
    writeFileSync(f, name === null ? "" : `[user]\n\tname = ${name}\n\temail = op@example.com\n`);
    return { GIT_CONFIG_GLOBAL: f, GIT_CONFIG_NOSYSTEM: "1", USER: "op-user" };
  };

  test("--allow-unrescued with rescue-all failing: one record with time, command, Worker, verdicts, operator", () => {
    const r = deploy(["deploy", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(r.code, r.err).toBe(0);
    const [rec, ...rest] = records();
    expect(rest).toEqual([]);
    expect(Date.now() - Date.parse(rec.ts)).toBeLessThan(120_000);
    expect(rec.override).toBe("--allow-unrescued");
    expect(rec.command).toBe("deploy");
    expect(rec.target_worker).toBe("fleet-test");
    expect(rec.target_check).toBe("matched");
    expect(rec.rescue_all).toBe("exit 1");
    expect(rec.operator).toBe("Op Tester");
    expect(readFileSync(logPath(), "utf8")).not.toContain("@");
    expect(r.err).toContain(logPath());
  });

  test("no git user.name: operator falls back to $USER", () => {
    deploy(["--allow-unrescued"], 1, gitUser(null));
    expect(records()[0].operator).toBe("op-user");
  });

  test("target mismatch overridden: the record says so and names the target Worker", () => {
    setCreds("https://fleet-other.example.workers.dev");
    deploy(["--allow-unrescued"], 0, gitUser("Op Tester"));
    const rec = records()[0];
    expect(rec.target_check).toBe("mismatch (exit 1)");
    expect(rec.target_worker).toBe("fleet-test");
    expect(rec.rescue_all).toBe("passed");
  });

  test("records append: two overrides -> two lines", () => {
    deploy(["--allow-unrescued"], 1, gitUser("Op Tester"));
    deploy(["--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(records()).toHaveLength(2);
  });

  test("Worker-only soft pass is recorded too", () => {
    stub("containers-list.json", [{ id: "app-1", name: "fleet-test-studiodo", image: `${REPO}@${DIGEST_A}` }]);
    stub("info-app-1.json", {
      id: "app-1", name: "fleet-test-studiodo", max_instances: 1, scheduling_policy: "default",
      configuration: { image: `${REPO}@${DIGEST_A}`, vcpu: 0.0625, memory_mib: 256, disk: { size_mb: 2000 } },
      constraints: { tiers: [1, 2] }, rollout_active_grace_period: 0,
    });
    stub("repo-digests.json", [`${REPO}@${DIGEST_A}`]);
    const r = deploy([], 1, gitUser("Op Tester"));
    expect(r.code, r.err).toBe(0);
    const rec = records()[0];
    expect(rec.override).toBe("worker-only");
    expect(rec.rescue_all).toBe("exit 1");
  });

  test("no override needed (rescue passes, target matches): nothing recorded", () => {
    expect(deploy([], 0).code).toBe(0);
    expect(existsSync(logPath())).toBe(false);
  });

  // PR #60 review F3: --var/--define values and a secrets file path may be
  // secrets. The record keeps flag names only.
  test("flag values never land in the record: --var, --var=, --define, --secrets-file", () => {
    const r = deploy(["deploy", "--var", "API_KEY:s3cr3t-one", "--var=K2:s3cr3t-two", "--define", "D:s3cr3t-three",
      "--secrets-file", "s3cr3t-four.json", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(r.code, r.err).toBe(0);
    const raw = readFileSync(logPath(), "utf8");
    expect(raw).not.toContain("s3cr3t");
    expect(raw).not.toContain("API_KEY");
    expect(records()[0].command).toBe("deploy --var --var --define --secrets-file");
  });

  // Issue #69: wrangler's --var/--define take EVERY following word until the
  // next flag. Dropping only the first leaked the rest into the record.
  test("multi-value --var / --var= / --define: every value dropped, not only the first", () => {
    const r = deploy(["deploy", "--var", "A:s3cr3t-one", "B:s3cr3t-two", "--var=C:s3cr3t-three", "D:s3cr3t-four",
      "--define", "E:s3cr3t-five", "F:s3cr3t-six", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(r.code, r.err).toBe(0);
    const raw = readFileSync(logPath(), "utf8");
    expect(raw).not.toContain("s3cr3t");
    expect(records()[0].command).toBe("deploy --var --var --define");
  });

  test("-e after a multi-value --var still keeps its env value", () => {
    const base = withImage("fleet-test");
    writeConfig({ ...base, env: { staging: { durable_objects: base.durable_objects, containers: base.containers } } });
    setCreds("https://fleet-test-staging.example.workers.dev");
    deploy(["deploy", "--var", "A:s3cr3t-one", "B:s3cr3t-two", "-e", "staging", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(readFileSync(logPath(), "utf8")).not.toContain("s3cr3t");
    expect(records()[0].command).toBe("deploy --var -e staging");
  });

  test("-e keeps its env value (not secret, needed to know the target)", () => {
    const base = withImage("fleet-test");
    writeConfig({ ...base, env: { staging: { durable_objects: base.durable_objects, containers: base.containers } } });
    setCreds("https://fleet-test-staging.example.workers.dev");
    deploy(["deploy", "-e", "staging", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(records()[0].command).toBe("deploy -e staging");
  });

  test("the record cannot be written -> refused (an override must leave a trace)", () => {
    mkdirSync(logPath(), { recursive: true });
    const r = deploy(["--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(r.code).toBe(1);
    expect(r.wrangler).toEqual([]);
    expect(r.err).toContain("deploy-overrides.jsonl");
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
  function expectRefused(r: ReturnType<typeof deploy>, ...mentions: string[]) {
    expect(r.code, r.err).toBe(1);
    expect(r.wrangler).toEqual([]);
    expect(r.fleet).toEqual([]);
    expect(r.err).toContain("pass --allow-unrescued to override");
    for (const m of mentions) expect(r.err).toContain(m);
  }

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
