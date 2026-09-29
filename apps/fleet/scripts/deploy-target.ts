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
// the target Worker's hosts (a route/custom-domain host, or
// <worker-name>.<subdomain>.workers.dev). Exit 1: it is not. Exit 2: the
// target (or the credentials host) cannot be determined -- fail closed.
// Everything is printed on stderr.
//
// Why refuse instead of pointing rescue-all at the config's Worker: the
// credentials file holds the Access service token of ONE fleet; another
// Worker's /studio sits behind its own Access app, so rescue-all could not
// reach it anyway.
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

// wrangler flags that decide the target. Any flag we do not model is
// harmless here: it cannot change the Worker name or env.
const envs: string[] = [];
const names: string[] = [];
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const eq = a.indexOf("=");
  const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
  const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
  const value = () => inline ?? args[++i] ?? "";
  if (flag === "-e" || flag === "--env") envs.push(value());
  else if (flag === "--name") names.push(value());
  else if (flag === "-c" || flag === "--config") undeterminable(`${a} in the arguments: deploy.sh passes its own --config; two configs, target unknown`);
  else if (flag === "--cwd") undeterminable(`${a} in the arguments: it moves where wrangler resolves the config`);
  else if (!a.startsWith("-")) words.push(a);
}
if (words.includes("containers")) {
  undeterminable("`containers delete` takes a container application id, which names no Worker in the config");
}
// `wrangler delete [name]`: the positional is the Worker name.
const del = words.indexOf("delete");
if (del >= 0 && words[del + 1] !== undefined) names.push(words[del + 1]);
if (envs.length > 1) undeterminable(`--env given ${envs.length} times (${envs.join(", ")})`);
if (names.length > 1) undeterminable(`Worker name given ${names.length} times (${names.join(", ")})`);
if (process.env.WRANGLER_CI_OVERRIDE_NAME) {
  undeterminable("WRANGLER_CI_OVERRIDE_NAME is set; wrangler deploys under that name instead of the config's");
}

let config: { name?: string; routes?: unknown[]; route?: unknown };
try {
  // env undefined -> wrangler itself falls back to CLOUDFLARE_ENV.
  config = unstable_readConfig({ config: configPath, env: envs[0] } as never, { hideWarnings: true }) as typeof config;
} catch (e) {
  undeterminable(`wrangler could not read ${configPath}${envs[0] ? ` for --env ${envs[0]}` : ""}: ${String(e).split("\n").slice(0, 3).join(" ")}`);
}
const worker = (names[0] ?? config.name ?? "").toLowerCase();
if (!worker) undeterminable(`${configPath} names no Worker`);

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

const glob = (pattern: string) =>
  new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const viaRoute = routeHosts.find((h) => glob(h).test(credsHost));
const viaWorkersDev = new RegExp(`^${worker.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}\\.[^.]+\\.workers\\.dev$`).test(credsHost);

const env = envs[0] ?? process.env.CLOUDFLARE_ENV;
const target = `Worker "${worker}"${env ? ` (env ${env})` : ""}, hosts: ${[...routeHosts, `${worker}.<subdomain>.workers.dev`].join(", ")}`;
if (viaRoute || viaWorkersDev) {
  say(`wrangler targets ${target}; credentials host ${credsHost} matches -- rescue-all rescues this fleet.`);
  process.exit(0);
}
say(`MISMATCH -- wrangler targets ${target}; but ${credsPath} points rescue-all at ${credsHost}. The gate would rescue the wrong fleet.`);
process.exit(1);
