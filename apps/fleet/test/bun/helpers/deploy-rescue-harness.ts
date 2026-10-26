import { afterAll, afterEach, beforeAll, beforeEach, expect, test as bunTest } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Every test below calls deploy(), which spawns a REAL `bash deploy.sh`
 * subprocess (itself invoking the stub wrangler/docker binaries and, for
 * some tests, a real spawned fake-CF-API server process). bun:test's bare
 * 5000ms default was too tight for this container's real subprocess-spawn
 * overhead and flaked 5/138 tests whenever the file ran in full (same class
 * of bug as #216's install-cache-security-parse.test.ts, fixed the same way:
 * measure, then give the test an honest explicit ceiling instead of the
 * bare default).
 *
 * Measured directly in this container (2026-10-05), a single `bash
 * deploy.sh` invocation outside bun:test entirely (Bun.spawnSync, same temp
 * tree shape as beforeEach below, no sibling tests running): 2906ms cold,
 * then 1281-1570ms warm across 4 more runs -- pure subprocess-spawn cost,
 * nothing network- or disk-scan-bound (the fake CF API is unreachable in
 * that probe and the command still returns in under 3s).
 *
 * Measured through bun:test, one test in isolation (`bun test
 * deploy-rescue-gate.test.ts -t <name>`, no contention from the other 137
 * tests): single-deploy()-call tests took 3.5-4.9s -- already within ~100ms
 * of the 5000ms default even with ZERO contention, because this file's own
 * beforeAll (spawns a real bun process for the fake CF API) and beforeEach
 * (builds a fresh temp tree, chmods a stub wrangler, symlinks real
 * node_modules/wrangler) add real setup cost on top of the spawn itself.
 *
 * Measured running the FULL 138-test file (real contention: ~140 sequential
 * bash+wrangler+docker subprocess spawns sharing this container's CPU/IO):
 * the 5 that failed were single-deploy()-call tests at 5109-5315ms and
 * two-deploy()-call tests at 5181-5548ms -- just over the 5000ms line, the
 * sole and complete explanation for all 5 failures. Nothing here points at
 * a genuinely slow underlying command (no network call deploy.sh makes
 * actually succeeds against a real host in these tests; the fake CF API and
 * stub wrangler/docker are both instant local scripts) -- this is pure
 * subprocess-spawn/scheduling overhead under contention, not slow logic.
 *
 * 20s gives >3.6x margin over the worst value measured above (5548ms, a
 * two-deploy()-call test under full contention) for every test in this
 * file, including the handful that call deploy() twice. Scoped to this
 * file's own local `test` (shadowing bun:test's), not bunfig.toml, because
 * no other suite in this repo shares this file's real-subprocess-per-test
 * shape.
 */
const DEPLOY_SUBPROCESS_TIMEOUT_MS = 20_000;
export function test(name: string, fn: () => void | Promise<void>, timeout: number = DEPLOY_SUBPROCESS_TIMEOUT_MS) {
  bunTest(name, fn, timeout);
}

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
const DEPLOY_SH = resolve(import.meta.dir, "../../../scripts/deploy.sh");
const DEPLOY_TARGET_TS = resolve(import.meta.dir, "../../../scripts/deploy-target.ts");
const CONTAINERS_CHANGED_TS = resolve(import.meta.dir, "../../../scripts/deploy-containers-changed.ts");
const GATE_DRAIN_WAIT_TS = resolve(import.meta.dir, "../../../scripts/gate-drain-wait.ts");
const GATE_DESKTOP_IMAGE_TS = resolve(import.meta.dir, "../../../scripts/gate-desktop-image.ts");
const REAL_WRANGLER = resolve(import.meta.dir, "../../../node_modules/wrangler");

// Filled by the hooks below. Each test file copies these into its own `let`s
// through the `assign` callback so test bodies read them as before.
const state = { root: "", fleet: "", calls: "", config: "", home: "", stubs: "", apiBase: "" };
export { state as harnessState };

export const DIGEST_A = "sha256:" + "a".repeat(64);
export const DIGEST_B = "sha256:" + "b".repeat(64);
export const REPO = "registry.cloudflare.com/acct-a/fleet-test-studiodo";
export const deployedImage = `${REPO}@${DIGEST_A}`;

export const envConfig = {
  name: "fleet-test",
  env: {
    prod: { name: "fleet-prod", routes: [{ pattern: "prod.example.com", custom_domain: true }] },
    staging: {},
  },
};

/**
 * Registers this file's hooks: a fake Cloudflare API process (beforeAll) and a
 * fresh temp tree per test (beforeEach). `assign` receives the fixture paths
 * for each test so the calling file can bind them to its own locals.
 */
export function useDeployRescueHarness(assign: (s: typeof state) => void) {
  // Fake Cloudflare API: GET /accounts/<id>/workers/subdomain, bearer
  // "stub-token" only. A separate process: deploy() blocks this one.
  let api: ReturnType<typeof Bun.spawn>;
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
    state.apiBase = `http://127.0.0.1:${new TextDecoder().decode(value).trim()}/client/v4`;
  });
  afterAll(() => api.kill());

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "deploy-rescue-"));
    const fleet = join(root, "fleet-app");
    const calls = join(root, "calls");
    const stubs = join(root, "stubs");
    const config = join(root, "wrangler.jsonc");
    const home = join(root, "home");
    Object.assign(state, { root, fleet, calls, stubs, config, home });
    mkdirSync(join(fleet, "scripts"), { recursive: true });
    copyFileSync(DEPLOY_SH, join(fleet, "scripts", "deploy.sh"));
    if (existsSync(DEPLOY_TARGET_TS)) copyFileSync(DEPLOY_TARGET_TS, join(fleet, "scripts", "deploy-target.ts"));
    if (existsSync(CONTAINERS_CHANGED_TS)) copyFileSync(CONTAINERS_CHANGED_TS, join(fleet, "scripts", "deploy-containers-changed.ts"));
    if (existsSync(GATE_DRAIN_WAIT_TS)) copyFileSync(GATE_DRAIN_WAIT_TS, join(fleet, "scripts", "gate-drain-wait.ts"));
    if (existsSync(GATE_DESKTOP_IMAGE_TS)) copyFileSync(GATE_DESKTOP_IMAGE_TS, join(fleet, "scripts", "gate-desktop-image.ts"));
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
      'case "$1 $2 $3" in',
      '  "workflows instances list")',
      `    [ -f "${stubs}/gate-instances.json" ] && cat "${stubs}/gate-instances.json" || echo "[]"`,
      "    exit 0 ;;",
      '  "d1 execute fleet")',
      '    case "$*" in',
      '      *"\'gate_drain\',\'1\'"*)',
      '        [ "${STUB_SET_FAIL:-0}" = "1" ] && exit 1',
      '        # STUB_RESTAMP_FAIL fails every set AFTER the first: the initial set',
      '        # (deploy.sh) succeeds, then the heartbeat re-stamp (gate-drain-wait)',
      '        # fails, so the wait must refuse (exit 2).',
      '        if [ "${STUB_RESTAMP_FAIL:-0}" = "1" ]; then',
      `          n=0; [ -f "${stubs}/set-count" ] && n=$(cat "${stubs}/set-count")`,
      `          n=$((n+1)); echo "$n" > "${stubs}/set-count"`,
      '          [ "$n" -ge 2 ] && exit 1',
      "        fi",
      '        ;;',
      '      *"\'gate_drain\',\'0\'"*) [ "${STUB_CLEAR_FAIL:-0}" = "1" ] && exit 1 ;;',
      "    esac",
      "    exit 0 ;;",
      '  "deploy "*) exit "${STUB_DEPLOY_EXIT:-0}" ;;',
      "esac",
      "exit 0",
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
    writeConfig(withImage("fleet-test"));
    setCreds("https://fleet-test.example.workers.dev");
    stub("auth-token.json", { type: "api_token", token: "stub-token" });
    stub("whoami.json", { loggedIn: true, accounts: [{ id: "acct-a", name: "Acme" }] });
    stub("containers-list.json", []);
    assign(state);
  });
  afterEach(() => rmSync(state.root, { recursive: true, force: true }));
}

export function withImage(name: string, container: object = {}) {
  return {
    name,
    durable_objects: { bindings: [{ name: "STUDIO", class_name: "StudioDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["StudioDO"] }],
    containers: [{ class_name: "StudioDO", image: "./container/Dockerfile", max_instances: 1, ...container }],
  };
}

export function stub(file: string, body: unknown) {
  writeFileSync(join(state.stubs, file), JSON.stringify(body));
}

export function writeConfig(c: object) {
  writeFileSync(state.config, JSON.stringify({ main: "src/index.ts", compatibility_date: "2026-08-01", ...c }, null, 2) + "\n");
}

export function setCreds(workerUrl: string | null) {
  rmSync(join(state.home, ".fleet"), { recursive: true, force: true });
  if (workerUrl === null) return;
  mkdirSync(join(state.home, ".fleet"), { recursive: true });
  writeFileSync(join(state.home, ".fleet", "credentials"),
    JSON.stringify({ workerUrl, accessClientId: "x", accessClientSecret: "y" }), { mode: 0o600 });
}

/** Replace the copied gate-desktop-image.ts with a stub that exits `code`, so
 *  deploy.sh's probe branches (proceed/refuse/repin) are testable without a
 *  real Dockerfile build. */
export function stubDesktopProbe(code: number): void {
  writeFileSync(join(state.fleet, "scripts", "gate-desktop-image.ts"), `process.exit(${code});\n`);
}

export function deploy(args: string[], rescueExit: number, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: state.home, FLEET_CONFIG: state.config, STUB_RESCUE_EXIT: String(rescueExit),
    CLOUDFLARE_API_BASE_URL: state.apiBase, WRANGLER_DOCKER_BIN: join(state.root, "docker"), ...extraEnv,
  };
  for (const k of ["CLOUDFLARE_ENV", "WRANGLER_CI_OVERRIDE_NAME", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  const r = Bun.spawnSync(["bash", join(state.fleet, "scripts", "deploy.sh"), ...args], { env });
  const all = existsSync(state.calls) ? readFileSync(state.calls, "utf8").trim().split("\n").filter(Boolean) : [];
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

export function expectRefused(r: ReturnType<typeof deploy>, ...mentions: string[]) {
  expect(r.code, r.err).toBe(1);
  expect(r.wrangler).toEqual([]);
  expect(r.fleet).toEqual([]);
  expect(r.err).toContain("pass --allow-unrescued to override");
  for (const m of mentions) expect(r.err).toContain(m);
}

export function deployed(app: Record<string, unknown> = {}, configuration: Record<string, unknown> = {}) {
  stub("containers-list.json", [{ id: "app-1", name: "fleet-test-studiodo", image: deployedImage }]);
  stub("info-app-1.json", {
    id: "app-1", name: "fleet-test-studiodo", max_instances: 1, scheduling_policy: "default",
    configuration: { image: deployedImage, vcpu: 0.0625, memory_mib: 256, disk: { size_mb: 2000 }, ...configuration },
    constraints: { tiers: [1, 2] }, rollout_active_grace_period: 0, ...app,
  });
}

export function builtDigests(list: string[]) {
  stub("repo-digests.json", list);
}

export function expectHard(r: ReturnType<typeof deploy>, ...mentions: string[]) {
  expect(r.code, r.err).toBe(1);
  expect(r.fleet).toEqual(["fleet rescue-all"]);
  expect(r.wrangler).toEqual([]);
  expect(r.err).toContain("rescue-all reported FAILED -- pre-deploy gate UNSAFE; pass --allow-unrescued to override");
  for (const m of mentions) expect(r.err).toContain(m);
}
