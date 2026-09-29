#!/usr/bin/env bun
// Issue #40: will this `wrangler deploy` replace any running container?
//
// deploy.sh asks only after `fleet rescue-all` FAILED. A Worker-only deploy
// (same image, same container settings) replaces no container -- measured
// in #36: a new Worker version restarts the Durable Object, the container
// keeps its boot id -- so a failed rescue then costs nothing and only warns.
//
// The signal is the pinned wrangler's own (4.141, containers deploy): it
// builds each Dockerfile image (`docker build --load --platform linux/amd64
// --provenance=false -f - <context>`), and when the built image's
// RepoDigests already hold the registry digest (pushed from this machine
// before), it pushes nothing and applies that digest. Its apply then diffs
// the application against the deployed one; an empty diff means no rollout.
// This probe does the same build and compares:
//   - the deployed application's configuration.image (`wrangler containers
//     info`) with the built image's RepoDigests -- exact string match;
//   - the settings a config here can carry (max_instances, instance_type)
//     with the deployed limits; scheduling_policy, constraints.tiers and
//     rollout_active_grace_period (a config here cannot set them, so
//     wrangler sends its defaults) with those defaults.
// Any other container key, a missing application, a failed build or call:
// cannot tell -> treated as changed.
//
// Usage (from scripts/deploy.sh only): bun deploy-containers-changed.ts <config> [wrangler args...]
// Exit 0: no container changes. 1: something changes. 2: cannot tell.
// Everything is printed on stderr.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";

const say = (m: string) => console.error(`deploy-containers: ${m}`);
function cannotTell(why: string): never {
  say(`cannot tell whether this deploy replaces containers: ${why}`);
  process.exit(2);
}

const [configPath, ...args] = process.argv.slice(2);
if (!configPath) cannotTell("no config path given");

// A plain `deploy` only; flags beyond env/profile may change what wrangler
// does to containers (--containers-rollout, --name, ...): not modelled.
let env: string | undefined;
const probeFlags: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "deploy") continue;
  if (a === "-e" || a === "--env") { env = args[++i]; continue; }
  if (a.startsWith("--env=")) { env = a.slice(6); continue; }
  if (a === "--profile") { probeFlags.push(a, args[++i] ?? ""); continue; }
  cannotTell(`argument ${a} is not modelled here (only a plain deploy, -e/--env, --profile)`);
}
env ??= process.env.CLOUDFLARE_ENV || undefined;
if (env) probeFlags.push("-e", env);

type Container = Record<string, unknown> & { name?: string; image?: string; image_build_context?: string; image_vars?: Record<string, string> };
type Observability = { enabled?: boolean; logs?: { enabled?: boolean } };
type Migration = { deleted_classes?: string[]; renamed_classes?: { from?: string; to?: string }[]; transferred_classes?: { from?: string; to?: string }[] };
let config: { containers?: Container[]; observability?: Observability; unsafe?: Record<string, unknown>; migrations?: Migration[] };
try {
  config = unstable_readConfig({ config: configPath, env } as never, { hideWarnings: true }) as typeof config;
} catch (e) {
  cannotTell(`wrangler could not read ${configPath}: ${String(e).split("\n")[0]}`);
}
const containers = config.containers ?? [];
if (containers.length === 0) cannotTell(`${configPath} declares no containers`);

// rollout_step_percentage / rollout_kind pace a rollout; wrangler leaves
// them out of the application it diffs, so they never cause one.
const MODELLED = new Set(["class_name", "name", "image", "image_build_context", "image_vars", "max_instances", "instance_type", "rollout_step_percentage", "rollout_kind"]);
// wrangler 4.141's instance types (its instanceTypes table).
const TYPES: Record<string, [number, number, number]> = {
  lite: [0.0625, 256, 2000], dev: [0.0625, 256, 2000], basic: [0.25, 1024, 4000],
  standard: [0.5, 4096, 8000], "standard-1": [0.5, 4096, 8000], "standard-2": [1, 6144, 12000],
  "standard-3": [2, 8192, 16000], "standard-4": [4, 12288, 20000],
};

const appDir = join(import.meta.dir, "..");
const wrangler = join(appDir, "node_modules", ".bin", "wrangler");
function probe(argv: string[]): unknown {
  const r = spawnSync(wrangler, [...argv, "-c", configPath, ...probeFlags], {
    cwd: appDir, encoding: "utf8", env: { ...process.env, CI: "1", FLEET_DEPLOY_PROBE: "1" }, timeout: 60_000,
  });
  if (r.status !== 0) cannotTell(`wrangler ${argv.join(" ")} failed (exit ${r.status}): ${(r.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
  const out = r.stdout ?? "";
  const start = out.search(/[[{]/);
  try { return JSON.parse(out.slice(start)); } catch { cannotTell(`wrangler ${argv.join(" ")} printed no JSON`); }
}

const docker = process.env.WRANGLER_DOCKER_BIN || "docker";
const builds = new Map<string, string[]>();
function builtRepoDigests(c: Container): string[] {
  const buildArgs = Object.entries(c.image_vars ?? {}).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]);
  const key = JSON.stringify([c.image, c.image_build_context, buildArgs]);
  const cached = builds.get(key);
  if (cached) return cached;
  let dockerfile: string;
  try { dockerfile = readFileSync(String(c.image), "utf8"); } catch { cannotTell(`cannot read the Dockerfile ${c.image}`); }
  const tag = `fleet-deploy-probe:${crypto.randomUUID()}`;
  say(`building ${c.image} as wrangler will, to compare digests (cached layers make wrangler's own build fast)...`);
  const b = spawnSync(docker, ["build", "--load", "-t", tag, "--platform", "linux/amd64", "--provenance=false", ...buildArgs, "-f", "-", String(c.image_build_context)], {
    input: dockerfile, stdio: ["pipe", "inherit", "inherit"],
  });
  if (b.status !== 0) cannotTell(`docker build of ${c.image} failed (exit ${b.status})`);
  const i = spawnSync(docker, ["image", "inspect", tag, "--format", "{{ json .RepoDigests }}"], { encoding: "utf8" });
  spawnSync(docker, ["image", "rm", tag], { stdio: "ignore" });
  let digests: string[];
  try { digests = JSON.parse(i.stdout); } catch { cannotTell(`docker image inspect of ${tag} failed`); }
  builds.set(key, digests);
  return digests;
}

type AppObs = { logs?: { enabled?: boolean }; target_instance_percentage?: number; target_instance_count?: number };
type App = {
  id: string; name: string; max_instances?: number; scheduling_policy?: string; constraints?: { tiers?: number[] };
  rollout_active_grace_period?: number; observability?: AppObs;
  scheduling_hint?: { target?: { configuration?: { observability?: AppObs } } };
  configuration?: { image?: string; vcpu?: number; memory_mib?: number; disk?: { size_mb?: number }; observability?: AppObs } };

// Would wrangler 4.141's apply write an observability change for this app?
// A port of its selectObservabilityWriteTarget,
// buildTopLevelObservabilityPatch, buildConfigurationObservabilityPatch and
// its legacy-migration triggers, for containers with no observability of
// their own. `logsEnabled` is defined below, before any call.
function observabilityChange(app: App): string | undefined {
  const legacyOn = (o?: AppObs) => o?.logs?.enabled === true;
  const hasLegacy = legacyOn(app.configuration?.observability) || legacyOn(app.scheduling_hint?.target?.configuration?.observability);
  if (hasLegacy && (app.observability?.logs?.enabled === true || (app.observability !== undefined && logsEnabled))) {
    return "legacy observability migration";
  }
  const target = hasLegacy ? "configuration" : "top-level";
  const top = app.observability;
  if (!(target === "configuration" && top === undefined)) {
    const topOnly = top?.target_instance_percentage !== undefined || top?.target_instance_count !== undefined;
    if (!logsEnabled) {
      if (top !== undefined && (top.logs?.enabled === true || topOnly)) return `top-level logs ${top.logs?.enabled} -> false`;
    } else if (!(top?.logs?.enabled === true && !topOnly)) {
      return `top-level logs ${top?.logs?.enabled} -> true`;
    }
  }
  if (target === "configuration") {
    const latest = (app.scheduling_hint?.target?.configuration?.observability ?? app.configuration?.observability)?.logs?.enabled;
    if (logsEnabled !== latest && !(!logsEnabled && latest === undefined)) return `configuration logs ${latest} -> ${logsEnabled}`;
  }
  return undefined;
}
// Every container is checked before any (slow) build.
for (const c of containers) {
  const extra = Object.keys(c).filter((k) => c[k] !== undefined && !MODELLED.has(k));
  if (extra.length) cannotTell(`container ${c.name} sets ${extra.join(", ")}, which this probe does not compare`);
  if (typeof c.image !== "string" || !c.image.startsWith("/")) cannotTell(`container ${c.name}'s image is not a Dockerfile (a registry image is not compared here)`);
  if (c.instance_type === "dev" || c.instance_type === "standard") cannotTell(`container ${c.name}: legacy instance_type ${c.instance_type} (wrangler infers the deployed type's canonical name)`);
}
// PR #60 review F1: top-level keys that feed the container application.
if (config.unsafe && Object.keys(config.unsafe).length > 0) cannotTell("the config sets top-level `unsafe`, which this probe does not model");
// PR #60 review F2: a migration deleting/renaming/transferring a container's
// Durable Object class changes the application's namespace.
const classes = new Set(containers.map((c) => String(c.class_name)));
for (const m of config.migrations ?? []) {
  const named = [...(m.deleted_classes ?? []), ...(m.renamed_classes ?? []).flatMap((r) => [r.from, r.to]), ...(m.transferred_classes ?? []).flatMap((r) => [r.from, r.to])];
  const hit = named.find((n) => n !== undefined && classes.has(n));
  if (hit) cannotTell(`a DO migration deletes, renames or transfers container class ${hit}`);
}
// wrangler 4.141 isRootObservabilityLogsEnabled: every container's logs
// setting comes from the Worker's top-level `observability` (a
// container-level `observability` is not in MODELLED).
const root = config.observability;
const logsEnabled = root?.logs?.enabled === true || (root?.enabled === true && root?.logs?.enabled !== false);
const list = probe(["containers", "list", "--json"]) as { id: string; name: string }[];
const changes: string[] = [];
for (const c of containers) {
  const listed = list.find((a) => a.name === c.name);
  if (!listed) { changes.push(`${c.name}: no deployed container application (a new one)`); continue; }
  const app = probe(["containers", "info", listed.id]) as App;
  const deployedImage = app.configuration?.image;
  if (!deployedImage || !builtRepoDigests(c).includes(deployedImage)) {
    changes.push(`${c.name}: image changed (built image is not the deployed ${deployedImage ?? "unknown"})`);
  }
  const maxInstances = (c.max_instances as number | undefined) ?? 20;
  if (app.max_instances !== maxInstances) changes.push(`${c.name}: max_instances ${app.max_instances} -> ${maxInstances}`);
  const t = c.instance_type ?? "lite";
  const want = typeof t === "string" ? TYPES[t] : [(t as { vcpu?: number }).vcpu ?? 0.0625, (t as { memory_mib?: number }).memory_mib ?? 256, (t as { disk_mb?: number }).disk_mb ?? 2000];
  if (!want) cannotTell(`container ${c.name}: unknown instance_type ${String(t)}`);
  const have = [app.configuration?.vcpu, app.configuration?.memory_mib, app.configuration?.disk?.size_mb];
  if (want.join() !== have.join()) changes.push(`${c.name}: instance limits (vcpu, memory MiB, disk MB) ${have.join("/")} -> ${want.join("/")}`);
  // Settings this config cannot carry (MODELLED), so wrangler sends its
  // defaults; a deployed value set elsewhere would be diffed back.
  if ((app.scheduling_policy ?? "default") !== "default") changes.push(`${c.name}: scheduling_policy ${app.scheduling_policy} -> default`);
  if ((app.constraints?.tiers ?? []).join() !== "1,2") changes.push(`${c.name}: constraints.tiers ${app.constraints?.tiers?.join() ?? "none"} -> 1,2`);
  if ((app.rollout_active_grace_period ?? 0) !== 0) changes.push(`${c.name}: rollout_active_grace_period ${app.rollout_active_grace_period} -> 0`);
  const obs = observabilityChange(app);
  if (obs) changes.push(`${c.name}: observability (${obs}; from the Worker's top-level observability)`);
}
if (changes.length) {
  for (const ch of changes) say(`CHANGES ${ch}`);
  process.exit(1);
}
say(`no container changes (${containers.map((c) => c.name).join(", ")}: same image digest, same settings) -- a Worker-only deploy replaces no container.`);
process.exit(0);
