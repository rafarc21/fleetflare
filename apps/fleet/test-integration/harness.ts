/**
 * Shared bootstrap for the two integration scripts (attach.e2e.ts, which
 * drives the Worker/DO/container directly, and cli.acceptance.ts, which
 * drives the `fleet` CLI under a real pty). Both need the same thing: an
 * Access identity, a `.dev.vars`, migrated local D1, and a `wrangler dev`
 * running test-integration/dev-entry.ts. One copy of that, not two.
 */
import { spawn, spawnSync, type Subprocess } from "bun";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const DEV_VARS = join(ROOT, ".dev.vars");

export const ACCESS_TEAM_DOMAIN = "integration.cloudflareaccess.test";
export const ACCESS_AUD = "studio-integration-aud";
export const BLUEPRINT_REPO = "acme-org/websites";
// Public and tiny. The guarded clone inside the container is REAL (it runs in
// the container, where nothing can intercept it), so it needs a repo that
// clones without credentials.
//
// Lower-cased for Fleet Spawn P3 Task 6 (it was `octocat/Hello-World`): the
// operator's own spawn derives its child id from AGENT_REPO's repo half
// (routes.ts's `/studio/spawn`), and the studio id grammar (ids.ts) admits
// only lowercase segments — so the capitalised form makes `fleet spawn` a
// 500 "fleet misconfigured" before it can reach any spawn logic. GitHub
// resolves owner/repo case-insensitively (verified: `git ls-remote` and a
// real clone of the lowercase URL both succeed), and provision.ts's
// guardedCloneCmd clones over plain https with no credentials, so the clone
// this feeds is byte-for-byte the same request it always made.
export const AGENT_REPO = "octocat/hello-world";
export const PILOT = "websites--pilot";
export const SCRATCH = "websites--scratch";
/** The role a spawn test asks for — declared in the fixture fleet.json AND
 *  edged from both `pilot` and `operator` in the fixture org.json. */
export const SPAWN_ROLE = "scratch";
/** A role the fixture org.json edges from `operator` but NOT from `pilot` —
 *  what an org-denied (403) spawn asks for. */
export const DENIED_ROLE = "cto";
/**
 * The child id an OPERATOR-initiated spawn produces. Not `websites--*`: the
 * operator has no studio to inherit a repo segment from, so routes.ts derives
 * it from AGENT_REPO's own repo half (see that route's doc comment) — which
 * in this harness is the clone fixture above, not the `websites` label
 * PILOT/SCRATCH carry. Derived here rather than typed out, so it cannot drift
 * from AGENT_REPO.
 */
export const OPERATOR_SPAWN_CHILD = `${AGENT_REPO.split("/").pop()}--${SPAWN_ROLE}`;
/** The service-token pair dev-entry.ts's Access-edge stand-in recognises. */
export const SERVICE_CLIENT_ID = "integration.client";
export const SERVICE_CLIENT_SECRET = "integration-secret";

// ---------------------------------------------------------------------------
// check runner
// ---------------------------------------------------------------------------
export const results: { name: string; ok: boolean; detail: string }[] = [];

export function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

export async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    record(name, true, (await fn()) || "");
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function reportAndExit(devLog: string[]): never {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length > 0) {
    console.log("failed:", failed.map((f) => f.name).join(", "));
    console.log("\n--- last wrangler dev output ---\n" + devLog.join("").slice(-6000));
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Access identity
// ---------------------------------------------------------------------------
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

export async function makeAccessIdentity(): Promise<{ jwks: unknown[]; jwt: string }> {
  const kp = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
  const kid = "integration-key-1";
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as Record<string, unknown>;
  jwk.kid = kid;

  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ aud: [ACCESS_AUD], exp: Math.floor(Date.now() / 1000) + 3600, email: "e2e@local" }),
    ),
  );
  const sig = await crypto.subtle.sign(RSA.name, kp.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return { jwks: [jwk], jwt: `${header}.${payload}.${b64url(new Uint8Array(sig))}` };
}

async function makeAppPrivateKeyPem(): Promise<string> {
  const kp = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  // One line on purpose: .dev.vars is dotenv-parsed, and src/github/app.ts's
  // pemToArrayBuffer strips the header/footer and ALL whitespace, so a
  // newline-free PEM imports identically and needs no quoting rules.
  return `-----BEGIN PRIVATE KEY-----${btoa(String.fromCharCode(...pkcs8))}-----END PRIVATE KEY-----`;
}

/**
 * The address a STUDIO CONTAINER must use to reach this run's `wrangler dev`.
 * Fleet Spawn P3, Task 6: `container/studio-fleet spawn` POSTs to
 * `FLEET_WORKER_URL` (do.ts's studioEnvVars, straight from
 * `env.WORKER_PUBLIC_URL`), and inside a container `127.0.0.1` is the
 * container itself — the loopback address the test harness talks to is
 * meaningless there. `host.docker.internal` is Docker Desktop's own name for
 * the host, and it reaches a host listener bound to 127.0.0.1 (verified
 * directly against a throwaway 127.0.0.1 server from inside this exact
 * sandbox image before this was written), so `wrangler dev` keeps its
 * loopback-only bind — nothing here exposes the dev Worker beyond this
 * machine.
 *
 * Written into `.dev.vars`, which overrides wrangler.jsonc's committed
 * `WORKER_PUBLIC_URL` (the real deployed Worker) for local dev — that
 * override is the whole point: without it a container in this test would
 * spawn against PRODUCTION.
 */
export const containerWorkerUrl = (port: number) => `http://host.docker.internal:${port}`;

export async function writeDevVars(
  access: { jwks: unknown[]; jwt: string }, workerPublicUrl: string,
): Promise<void> {
  writeFileSync(
    DEV_VARS,
    [
      `ACCESS_TEAM_DOMAIN=${ACCESS_TEAM_DOMAIN}`,
      `ACCESS_AUD=${ACCESS_AUD}`,
      `AGENT_REPO=${AGENT_REPO}`,
      `WORKER_PUBLIC_URL=${workerPublicUrl}`,
      `GITHUB_APP_PRIVATE_KEY=${await makeAppPrivateKeyPem()}`,
      "GITHUB_APP_ID=1",
      "GITHUB_INSTALLATION_ID=1",
      "GITHUB_WEBHOOK_SECRET=integration-only",
      "TELEGRAM_BOT_TOKEN=integration-only",
      "TELEGRAM_WEBHOOK_SECRET=integration-only",
      "CLAUDE_CODE_OAUTH_TOKEN=integration-only",
      "CLOUDFLARE_DEPLOY_TOKEN=integration-only",
      // Fixture material for test-integration/dev-entry.ts's outbound shim.
      // Single-line JSON: .dev.vars is dotenv-parsed, one key per line.
      `IT_JWKS=${JSON.stringify({ keys: access.jwks })}`,
      "IT_INSTALLATION_TOKEN=ghs_integrationfaketoken",
      `IT_BLUEPRINT_REPO=${BLUEPRINT_REPO}`,
      // Access-edge stand-in: dev-entry swaps this exact service-token pair
      // for the JWT above, the way Access's own edge would in production.
      `IT_SERVICE_CLIENT_ID=${SERVICE_CLIENT_ID}`,
      `IT_SERVICE_CLIENT_SECRET=${SERVICE_CLIENT_SECRET}`,
      `IT_SERVICE_JWT=${access.jwt}`,
      "",
    ].join("\n"),
  );
}

export function removeDevVars(): void {
  if (existsSync(DEV_VARS)) rmSync(DEV_VARS);
}

// ---------------------------------------------------------------------------
// wrangler dev
// ---------------------------------------------------------------------------
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export function applyMigrations(): void {
  const mig = spawnSync(["./node_modules/.bin/wrangler", "d1", "migrations", "apply", "fleet", "--local"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(mig.exitCode === 0, `d1 migrations apply failed: ${mig.stderr.toString().slice(-2000)}`);
}

/**
 * Drops every studio row from the LOCAL D1 (`registry.ts`'s `studio:` prefix
 * over `fleet_state`) before a run starts.
 *
 * Fleet Spawn P3, Task 6. `.wrangler/state` survives between runs, so studio
 * rows accumulate: after one integration run, `websites--scratch` is already
 * in the registry, and runSpawn's own exists-check would answer `409 studio
 * exists` on the next run's spawn — a test that passes exactly once per
 * machine and then reports a real, correct behaviour as a failure.
 *
 * The D1 half of the clean slate only — resetPersistedRunState below clears
 * the DO and R2 halves, and the three belong together (see its own comment
 * for what happens when only some of them are reset).
 *
 * Local only, by construction: no `--remote` flag anywhere, and the same
 * `wrangler d1` + `spawnSync` shape applyMigrations above already uses
 * against the same local database.
 */
export function resetStudioRows(): void {
  const res = spawnSync(
    [
      "./node_modules/.bin/wrangler", "d1", "execute", "fleet", "--local",
      "--command", "DELETE FROM fleet_state WHERE key LIKE 'studio:%'",
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  assert(res.exitCode === 0, `d1 studio-row reset failed: ${res.stderr.toString().slice(-2000)}`);
}

/**
 * Deletes the LOCAL persisted Durable Object storage AND R2 bucket
 * (miniflare's own `.wrangler/state/v3/{do,r2}`) before a run starts — the
 * same clean-slate argument resetStudioRows makes for D1, for the two other
 * stores a run writes to. D1 is not deleted wholesale here because its schema
 * comes from `applyMigrations`; the rows are cleared instead.
 *
 * Two hazards, both measured during this task rather than assumed:
 *
 *   1. A previous run leaves each studio DO with SCHEDULED ALARMS (do.ts's
 *      refreshToken / shipTranscript / syncSession). When this run's
 *      `wrangler dev` starts, those alarms are already overdue and fire
 *      immediately — before any test request arrives. Their handlers `exec`
 *      into the studio's container, and an exec is what STARTS a container:
 *      the container therefore launches with whatever `this.envVars` held at
 *      DO-construction time, and container start config cannot be changed
 *      afterwards. This run's own provision then mints a spawn token the
 *      already-running container will never see, and every /fleet/spawn call
 *      from it 401s — caused entirely by the previous run's leftovers.
 *   2. Transcript chunk keys are numbered from the manifest in DO storage
 *      (archive.ts's chunkKey). With DO storage cleared but R2 kept, the
 *      numbering restarts at 1 and a tick OVERWRITES an earlier run's object
 *      instead of creating a new one — so a "exactly one NEW key appeared"
 *      assertion sees zero, and reports a working offset as broken. The two
 *      stores have to be reset together or not at all.
 *
 * A fresh machine, a fresh clone, and CI all start from exactly this state;
 * only a repeatedly-used dev box does not.
 */
export function resetPersistedRunState(): void {
  for (const store of ["do", "r2"]) {
    rmSync(join(ROOT, ".wrangler", "state", "v3", store), { recursive: true, force: true });
  }
}

export function requireDocker(): void {
  const ok = spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  assert(ok, "docker is not running — this test needs a real container");
}

export async function startWrangler(port: number, devLog: string[]): Promise<Subprocess> {
  const proc = spawn({
    cmd: [
      "./node_modules/.bin/wrangler", "dev", "test-integration/dev-entry.ts",
      "--port", String(port), "--ip", "127.0.0.1",
    ],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const text = dec.decode(chunk);
      devLog.push(text);
      if (process.env.E2E_VERBOSE) process.stdout.write(text);
    }
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);

  // Every failure path kills `proc` first. The caller only ever receives a
  // handle by RETURN, so a throw leaves it with nothing to put in its cleanup
  // list — a leaked `wrangler dev` holding the port and its containers, which
  // no `finally` can reach. cli.acceptance.ts's mid-test restart is the sharp
  // edge: `spawned[0] = await startWrangler(...)` never completes the
  // assignment, so the new process would be unkillable by anything.
  try {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const joined = devLog.join("");
      if (/Ready on http/i.test(joined)) return proc;
      if (proc.exitCode !== null) {
        throw new Error(`wrangler dev exited early (code ${proc.exitCode}):\n${joined.slice(-4000)}`);
      }
      await Bun.sleep(500);
    }
    throw new Error(`wrangler dev never became ready:\n${devLog.join("").slice(-4000)}`);
  } catch (err) {
    try {
      proc.kill();
    } catch {
      // already gone (the "exited early" path, most often)
    }
    throw err;
  }
}

export function api(base: string, jwt: string) {
  return (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { "Cf-Access-Jwt-Assertion": jwt, ...(init.headers ?? {}) },
    });
}

// ---------------------------------------------------------------------------
// Container kill — Task 7 (P2 integration/acceptance additions).
// ---------------------------------------------------------------------------

/**
 * Every RUNNING (not `-a`) Docker container that is a StudioDO sandbox — NOT
 * its `-proxy` network sidecar (`@cloudflare/proxy-everything`, a separate
 * image, never the studio's own filesystem). Matched by image name prefix
 * (`cloudflare-dev/studiodo:` — wrangler's own local-dev naming for a
 * container class, derived from `wrangler.jsonc`'s `class_name: "StudioDO"`,
 * confirmed empirically against a live `docker ps` during this task's own
 * development — not guessed), not by container name: the name embeds a hash
 * that is stable per DO id/class but whose exact derivation is undocumented,
 * so matching on it would be guessing at an implementation detail this file
 * has no need to know.
 *
 * Empirically (same manual verification): a SINGLE provisioned studio can
 * show more than one matching container at once — @cloudflare/sandbox's
 * local-dev runtime appears to run the default (unnamed) exec session and
 * the terminal bridge's named `"studio"` session (see sandbox-api.ts's
 * `STUDIO_SESSION_ID`) as separate container processes. Neither this
 * function nor its caller needs to know which is "the real one": every
 * caller either kills ALL matches (killStudioContainers below) or only
 * cares about the count changing, never about picking one out by identity.
 */
export function findStudioContainers(): string[] {
  const ps = spawnSync(["docker", "ps", "--format", "{{.ID}} {{.Image}} {{.Names}}"], { stdout: "pipe", stderr: "pipe" });
  assert(ps.exitCode === 0, `docker ps failed: ${ps.stderr.toString().slice(-1000)}`);
  return ps.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const [, image, name] = line.split(" ");
      return (image ?? "").startsWith("cloudflare-dev/studiodo:") && !(name ?? "").endsWith("-proxy");
    })
    .map((line) => line.split(" ")[0]);
}

/**
 * Simulates a studio's container crashing mid-session — `docker kill`
 * (SIGKILL) on every currently-running sandbox container matched above, then
 * polls (up to 5s) until none remain. Kills ALL matches rather than trying to
 * single one out (see findStudioContainers's own doc comment on why there can
 * be more than one for a single studio) — over-killing an unrelated leftover
 * from an earlier local run is harmless in this environment (verified no
 * OTHER `wrangler dev` process was ever running against this same worker
 * during this task's own development), and under-killing would leave exactly
 * the warm state a "fresh container" assertion depends on being gone.
 *
 * Callers verify recovery through the WORKER's own APIs afterward (a
 * `/studio/<id>/provision` call, then a WS/PTY or CLI round trip) — never by
 * `docker exec`ing back into whatever container happens to exist post-kill,
 * which is exactly the ambiguity this function's own doc comment describes.
 */
export function killStudioContainers(): string[] {
  const ids = findStudioContainers();
  assert(ids.length > 0, "killStudioContainers: no running StudioDO sandbox container found to kill");
  const kill = spawnSync(["docker", "kill", ...ids], { stdout: "pipe", stderr: "pipe" });
  assert(kill.exitCode === 0, `docker kill failed: ${kill.stderr.toString().slice(-1000)}`);
  return ids;
}

export async function waitForContainersGone(ids: string[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillUp = findStudioContainers().filter((id) => ids.includes(id));
    if (stillUp.length === 0) return;
    await Bun.sleep(200);
  }
  const stillUp = findStudioContainers().filter((id) => ids.includes(id));
  assert(stillUp.length === 0, `containers still running after kill: ${JSON.stringify(stillUp)}`);
}

// ---------------------------------------------------------------------------
// Test-only route clients — Task 7. Thin wrappers around dev-entry.ts's
// `/__it__/*` routes (see that file's own header for the containment
// argument). Unauthenticated on purpose: those routes carry no Access check
// of their own, so no jwt/service-token header is sent here — matching the
// routes themselves, not a shortcut this file is taking.
// ---------------------------------------------------------------------------

/** Forces one StudioDO schedule callback to fire now, over the DO's own RPC
 *  surface — see dev-entry.ts's `handleTestOnlyRoutes` for why this calls the
 *  exact same method a real alarm fire would call. */
export async function forceTick(base: string, id: string, name: "shipTranscript" | "syncSession"): Promise<void> {
  const res = await fetch(`${base}/__it__/tick/${encodeURIComponent(id)}/${name}`, { method: "POST" });
  assert(res.ok, `forceTick ${name} ${id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** Raw (unscrubbed) `transcriptTail` DO storage read — contrast against a
 *  served HTML response's own scrubbed preview (grid.ts's scrubPreview). */
export async function readRawTail(base: string, id: string): Promise<string> {
  const res = await fetch(`${base}/__it__/tail/${encodeURIComponent(id)}`);
  assert(res.ok, `readRawTail ${id}: HTTP ${res.status}`);
  const body = (await res.json()) as { tail: string };
  return body.tail;
}

/** R2 keys under `prefix`, sorted — same bucket (`env.STUDIO_ARCHIVE`) a real
 *  ship/sync tick writes to; miniflare-local under `wrangler dev`. */
export async function r2List(base: string, prefix: string): Promise<string[]> {
  const res = await fetch(`${base}/__it__/r2/list?prefix=${encodeURIComponent(prefix)}`);
  assert(res.ok, `r2List ${prefix}: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: string[] };
  return body.keys;
}

/** Raw bytes of one R2 object, or `null` if it does not exist (404). */
export async function r2Get(base: string, key: string): Promise<Uint8Array | null> {
  const res = await fetch(`${base}/__it__/r2/get?key=${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  assert(res.ok, `r2Get ${key}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
