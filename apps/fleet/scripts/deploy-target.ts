#!/usr/bin/env bun
// Issue #36: is the Worker wrangler is about to replace the SAME Worker
// whose studios `fleet rescue-all` rescues?
//
// rescue-all lists the studios of the fleet at ~/.fleet/credentials'
// workerUrl. Wrangler replaces the Worker named by the config deploy.sh hands
// it, the --env/-e flag or CLOUDFLARE_ENV, and --name. When those differ
// (creds on staging, deploy to production) the gate rescues the wrong fleet,
// says SAFE, and production's containers are replaced unrescued.
//
// Usage (from scripts/deploy.sh only): bun deploy-target.ts <config> [wrangler args...]
// Reads the config with wrangler's OWN reader (the pinned package), so env
// selection, env name inheritance (<name>-<env>) and route inheritance are
// exactly what wrangler will deploy. Exit 0: the credentials host is one of
// the target Worker's hosts (a non-wildcard route/custom-domain host, or
// <worker-name>.<subdomain>.workers.dev where <subdomain> is the DEPLOYING
// account's own -- issue #48). Exit 1: it is not. Exit 2: the target (or
// the credentials host, or that account subdomain) cannot be determined --
// fail closed. The target Worker's name goes to stdout (deploy.sh's
// override record); everything else to stderr.
//
// Issue #48: the account subdomain costs a read-only lookup, only for a
// workers.dev credentials host: the account is the config's account_id,
// else CLOUDFLARE_ACCOUNT_ID, else the ONE account `wrangler whoami` lists
// (wrangler's own order; with several accounts wrangler would use its cache
// or prompt -- refused, set CLOUDFLARE_ACCOUNT_ID); the token is `wrangler
// auth token` (CLOUDFLARE_API_TOKEN or the wrangler login); then GET
// /accounts/<id>/workers/subdomain (CLOUDFLARE_API_BASE_URL honoured, as
// wrangler does). Needs network and a logged-in wrangler.
//
// Why refuse instead of pointing rescue-all at the config's Worker: the
// credentials file holds the Access service token of ONE fleet; another
// Worker's /studio sits behind its own Access app, so rescue-all could not
// reach it anyway.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";

const say = (m: string) => console.error(`deploy-target: ${m}`);
function undeterminable(why: string): never {
  say(`cannot determine that wrangler's target Worker is the fleet rescue-all rescues: ${why}`);
  process.exit(2);
}

const [configPath, ...args] = process.argv.slice(2);
if (!configPath) undeterminable("no config path given");

// wrangler flags that decide the target. Any other long flag cannot change
// the Worker name or env. yargs also accepts camelCase (--envFile), so long
// flag names are compared with dashes/underscores dropped, lowercased.
// Short flags: only the exact "-e"/"-c" forms are modelled; any other
// multi-char single-dash arg ("-e=prod", "-eprod") may carry an env or a
// config wrangler reads -- refused, never guessed.
const norm = (f: string) => "--" + f.slice(2).replace(/[-_]/g, "").toLowerCase();
const envs: string[] = [];
const names: string[] = [];
const profiles: string[] = [];
const words: string[] = [];
let deleteAt = -1;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (/^-[^-]./.test(a)) undeterminable(`${a}: combined or inline short-flag form; write "-e <env>" / "-c <file>" as separate words`);
  const eq = a.indexOf("=");
  const flag = a.startsWith("--") ? norm(eq > 0 ? a.slice(0, eq) : a) : a;
  const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
  const value = () => inline ?? args[++i] ?? "";
  if (flag === "-e" || flag === "--env") envs.push(value());
  else if (flag === "--name") names.push(value());
  else if (flag === "--profile") profiles.push(value());
  else if (flag === "-c" || flag === "--config") undeterminable(`${a} in the arguments: deploy.sh passes its own --config; two configs, target unknown`);
  else if (flag === "--cwd") undeterminable(`${a} in the arguments: it moves where wrangler resolves the config`);
  else if (flag === "--envfile") undeterminable(`${a} (--env-file) in the arguments: wrangler loads that file into its environment (CLOUDFLARE_ENV, WRANGLER_CI_OVERRIDE_NAME, ...)`);
  else if (!a.startsWith("-")) {
    if (a === "delete" && deleteAt < 0) deleteAt = i;
    words.push(a);
  }
}
if (words.includes("containers")) {
  undeterminable("`containers delete` takes a container application id, which names no Worker in the config");
}
// `wrangler delete [name]`: the first positional after `delete` is the
// Worker name. A flag we do not know between them may take the next word
// as its value ("delete --profile fleet-test fleet-prod"): refused.
if (deleteAt >= 0) {
  for (let i = deleteAt + 1; i < args.length; i++) {
    const a = args[i];
    const flag = a.startsWith("--") ? norm(a.split("=")[0]) : a;
    if (["-e", "--env", "--name"].includes(flag)) { if (!a.includes("=")) i++; continue; }
    if (flag === "--force" || flag === "--dryrun") continue;
    if (a.startsWith("-")) undeterminable(`delete: flag ${a} before the Worker name may take the next word as its value`);
    names.push(a);
    break;
  }
}

// Wrangler loads .env files from its cwd (deploy.sh cds into this app dir)
// into process.env BEFORE reading the config: .env, .env.local, and with an
// env also .env.<env>, .env.<env>.local. A CLOUDFLARE_* or WRANGLER_* var
// there (CLOUDFLARE_ENV, WRANGLER_CI_OVERRIDE_NAME, CLOUDFLARE_ACCOUNT_ID,
// ...) can retarget the deploy behind this check's back: refused.
const appDir = join(import.meta.dir, "..");
const envForFiles = envs[0] ?? process.env.CLOUDFLARE_ENV;
const dotenvFiles = [".env", ".env.local", ...(envForFiles ? [`.env.${envForFiles}`, `.env.${envForFiles}.local`] : [])];
for (const f of dotenvFiles) {
  let body: string;
  try { body = readFileSync(join(appDir, f), "utf8"); } catch { continue; }
  const hit = body.split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([\w.-]+)\s*[=:]/.exec(l)?.[1])
    .find((k) => k !== undefined && /^(CLOUDFLARE_|WRANGLER_)/i.test(k));
  if (hit) undeterminable(`${join(appDir, f)} sets ${hit}; wrangler loads it and it can change the deploy target. Move it to the shell environment or remove it`);
}
if (envs.length > 1) undeterminable(`--env given ${envs.length} times (${envs.join(", ")})`);
if (names.length > 1) undeterminable(`Worker name given ${names.length} times (${names.join(", ")})`);
if (profiles.length > 1) undeterminable(`--profile given ${profiles.length} times (${profiles.join(", ")})`);
if (process.env.WRANGLER_CI_OVERRIDE_NAME) {
  undeterminable("WRANGLER_CI_OVERRIDE_NAME is set; wrangler deploys under that name instead of the config's");
}

let config: { name?: string; routes?: unknown[]; route?: unknown; account_id?: string; compliance_region?: string };
try {
  // env undefined -> wrangler itself falls back to CLOUDFLARE_ENV.
  config = unstable_readConfig({ config: configPath, env: envs[0] } as never, { hideWarnings: true }) as typeof config;
} catch (e) {
  undeterminable(`wrangler could not read ${configPath}${envs[0] ? ` for --env ${envs[0]}` : ""}: ${String(e).split("\n").slice(0, 3).join(" ")}`);
}
const worker = (names[0] ?? config.name ?? "").toLowerCase();
if (!worker) undeterminable(`${configPath} names no Worker`);
console.log(worker);

const routeHosts = [...(config.routes ?? []), ...(config.route ? [config.route] : [])]
  .map((r) => (typeof r === "string" ? r : (r as { pattern?: string }).pattern ?? ""))
  .map((p) => p.replace(/^[a-z]+:\/\//i, "").split("/")[0].toLowerCase())
  .filter(Boolean);

const credsPath = join(homedir(), ".fleet", "credentials");
let credsHost: string;
try {
  credsHost = new URL(JSON.parse(readFileSync(credsPath, "utf8")).workerUrl).hostname.toLowerCase();
} catch (e) {
  undeterminable(`no readable workerUrl in the credentials file ${credsPath} (${String(e).split("\n")[0]})`);
}

// Exact host only. A wildcard route ("*.example.com/*") also matches hosts
// other Workers serve (a more specific route wins), so it proves nothing.
const viaRoute = routeHosts.find((h) => !h.includes("*") && h === credsHost);
const credsSubdomain = new RegExp(`^${worker.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}\\.([^.]+)\\.workers\\.dev$`).exec(credsHost)?.[1];

const env = envs[0] ?? process.env.CLOUDFLARE_ENV;
let workersDev = `${worker}.<subdomain>.workers.dev`;
let viaWorkersDev = false;
if (!viaRoute && credsSubdomain) {
  const sub = await accountSubdomain();
  workersDev = `${worker}.${sub}.workers.dev`;
  viaWorkersDev = sub === credsSubdomain;
}
const target = `Worker "${worker}"${env ? ` (env ${env})` : ""}, hosts: ${[...routeHosts, workersDev].join(", ")}`;
if (viaRoute || viaWorkersDev) {
  say(`wrangler targets ${target}; credentials host ${credsHost} matches -- rescue-all rescues this fleet.`);
  process.exit(0);
}
say(`MISMATCH -- wrangler targets ${target}; but ${credsPath} points rescue-all at ${credsHost}. The gate would rescue the wrong fleet.`);
process.exit(1);

// Issue #48: the deploying account's workers.dev subdomain (see header).
// The wrangler calls are read-only; FLEET_DEPLOY_PROBE marks them for the
// tests' stub wrangler.
async function accountSubdomain(): Promise<string> {
  const flags = ["-c", configPath, ...(envs[0] ? ["-e", envs[0]] : []), ...(profiles[0] ? ["--profile", profiles[0]] : [])];
  const wranglerJson = (argv: string[], what: string) => {
    const r = spawnSync(join(appDir, "node_modules", ".bin", "wrangler"), [...argv, ...flags], {
      cwd: appDir, encoding: "utf8", timeout: 60_000, env: { ...process.env, FLEET_DEPLOY_PROBE: "1" },
    });
    const out = r.stdout ?? "";
    try {
      if (r.status !== 0) throw new Error(`exit ${r.status}`);
      return JSON.parse(out.slice(out.search(/[[{]/)));
    } catch (e) {
      undeterminable(`${what} (\`wrangler ${argv.join(" ")}\`) failed: ${String(e)} ${(r.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
    }
  };
  if (config.compliance_region && config.compliance_region !== "public") {
    undeterminable(`compliance_region ${config.compliance_region}: its workers.dev host differs; not modelled`);
  }
  let account = config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const accounts = (wranglerJson(["whoami", "--json"], "listing the logged-in accounts").accounts ?? []) as { id: string }[];
    if (accounts.length !== 1) {
      undeterminable(`the deploying account is not pinned (no account_id in the config, no CLOUDFLARE_ACCOUNT_ID) and wrangler whoami lists ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID`);
    }
    account = accounts[0].id;
  }
  const auth = wranglerJson(["auth", "token", "--json"], "reading the wrangler auth token") as { type?: string; token?: string; key?: string; email?: string };
  const headers: Record<string, string> = auth.type === "api_key"
    ? { "X-Auth-Key": auth.key ?? "", "X-Auth-Email": auth.email ?? "" }
    : { Authorization: `Bearer ${auth.token ?? ""}` };
  const base = (process.env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/accounts/${account}/workers/subdomain`, { headers, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as { success?: boolean; result?: { subdomain?: string }; errors?: { message?: string }[] };
    const sub = body.result?.subdomain;
    if (!res.ok || !sub) throw new Error(`HTTP ${res.status} ${body.errors?.map((e) => e.message).join("; ") ?? ""}`);
    return sub.toLowerCase();
  } catch (e) {
    undeterminable(`could not read the workers.dev subdomain of account ${account}: ${String(e)}`);
  }
}
