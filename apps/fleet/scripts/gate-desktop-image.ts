#!/usr/bin/env bun
// Issue #1314: a digest-pinned `desktop` named image on GateRunnerDO is
// invisible to `wrangler deploy` (wrangler treats a `{ "image": ... }` entry
// as already-built), so a Dockerfile.gate-desktop edit leaves the pin stale.
//
// DEFAULT (probe) is DETECT ONLY, no docker: hash Dockerfile.gate-desktop plus
// the files it COPYs, and compare against a `dockerfile-sha:` marker the
// operator records next to the pin. Unchanged -> exit 0 (deploy continues
// silently); changed -> print the manual build/push/repin steps and exit a
// DISTINCT code so deploy.sh refuses. No docker means a Docker-less host can
// still run Worker-only deploys.
//
// Opt-in `--repin-desktop-image`: build once, push through `wrangler
// containers push`, print the new digest. It NEVER writes FLEET_CONFIG or the
// ops clone — the operator commits the pin bump themselves.
//
// Usage (from scripts/deploy.sh only):
//   bun gate-desktop-image.ts <config>                    detect only
//   bun gate-desktop-image.ts <config> --repin-desktop-image
// Exit 0: unchanged (or not a pinned desktop image). 1: changed (refuse).
// 2: cannot tell. The new digest goes to stdout (repin mode); all else stderr.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";

const say = (m: string) => console.error(`gate-desktop-image: ${m}`);
function cannotTell(why: string): never {
  say(`cannot tell whether the desktop gate image changed: ${why}`);
  process.exit(2);
}

// The digest-pinned image entry shape (wrangler config-schema.json
// DurableObjectContainerImage, the `{ "image": ... }` variant).
export type PinnedImage = { image: string };

/** A Dockerfile-backed named image: what wrangler builds and pushes itself. */
export type DockerfileImage = { dockerfile: string; build_context?: string; build_vars?: Record<string, string> };

export type DesktopImageEntry = PinnedImage | DockerfileImage | undefined;

/** A digest-pinned ref: `{ "image": "<repo>@sha256:..." }`. */
export function isPinned(entry: DesktopImageEntry): entry is PinnedImage {
  return entry !== undefined && typeof (entry as { image?: unknown }).image === "string";
}

/** The config text carries the Dockerfile's recorded hash as
 *  `/* dockerfile-sha: <64hex> *` next to the pin — what the operator commits
 *  alongside the pin bump. */
export function recordedDesktopSha(configText: string): string | null {
  const m = /dockerfile-sha:\s*([0-9a-f]{64})/i.exec(configText);
  return m ? m[1].toLowerCase() : null;
}

/** Deterministic sha256 over ordered parts, each length-prefixed so `["ab","c"]`
 *  and `["a","bc"]` never collide. */
export function hashContent(parts: string[]): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(String(p.length));
    h.update(":");
    h.update(p);
    h.update("\n");
  }
  return h.digest("hex");
}

/** COPY/ADD sources of a Dockerfile (not `--from=` stage copies, not flags). */
export function extractCopySources(src: string): string[] {
  const joined = src.replace(/\\\n/g, " ");
  const out: string[] = [];
  for (const raw of joined.split("\n")) {
    const m = raw.trim().match(/^(COPY|ADD)\s+(.*)$/);
    if (!m) continue;
    if (raw.includes("--from=")) continue;
    const args = m[2].split(/\s+/).filter((a) => !a.startsWith("--"));
    out.push(...args.slice(0, -1));
  }
  return out;
}

/** Hash of Dockerfile.gate-desktop and the files it COPYs, from the app dir. */
export function desktopDockerfileSha(appDir: string): string {
  const df = join(appDir, "container", "Dockerfile.gate-desktop");
  const src = readFileSync(df, "utf8");
  const parts = [src];
  for (const s of extractCopySources(src)) {
    const p = join(appDir, "container", s);
    parts.push(readFileSync(p, "utf8"));
  }
  return hashContent(parts);
}

/** changed -> the recorded hash (or null) does not match the current hash. */
export function decideDesktopChange(recorded: string | null, current: string): "no-change" | "changed" {
  if (recorded === null) return "changed"; // fail closed: unrecorded = not proven unchanged
  return recorded === current ? "no-change" : "changed";
}

/** Swap the digest on a pinned image ref, keeping the repo path. */
export function repin(oldRef: string, newDigest: string): string | null {
  const at = oldRef.lastIndexOf("@");
  if (at < 0) return null;
  return `${oldRef.slice(0, at)}@${newDigest}`;
}

// --- runner (shells out) -------------------------------------------------

type Container = {
  class_name?: string;
  scheduling_policy?: string;
  images?: Record<string, DesktopImageEntry>;
};

function gateRunnerDesktop(configPath: string): DesktopImageEntry {
  let config: { containers?: Container[] };
  try {
    config = unstable_readConfig({ config: configPath } as never, { hideWarnings: true }) as typeof config;
  } catch (e) {
    cannotTell(`wrangler could not read ${configPath}: ${String(e).split("\n")[0]}`);
  }
  const gate = (config.containers ?? []).find((c) => c.class_name === "GateRunnerDO");
  return gate?.images?.desktop;
}

const WRANGLER = join(import.meta.dir, "..", "node_modules", ".bin", "wrangler");

function buildOnce(appDir: string): string {
  const docker = process.env.WRANGLER_DOCKER_BIN || "docker";
  const tag = `fleet-desktop-repin:${crypto.randomUUID()}`;
  const src = readFileSync(join(appDir, "container", "Dockerfile.gate-desktop"), "utf8");
  const b = spawnSync(docker, ["build", "--load", "-t", tag, "--platform", "linux/amd64", "--provenance=false", "-f", "-", join(appDir, "container")], {
    input: src, stdio: ["pipe", "inherit", "inherit"],
  });
  if (b.status !== 0) cannotTell(`docker build of Dockerfile.gate-desktop failed (exit ${b.status})`);
  return tag;
}

function pushAndDigest(configPath: string, appDir: string): string {
  const docker = process.env.WRANGLER_DOCKER_BIN || "docker";
  const tag = buildOnce(appDir);
  const pin = gateRunnerDesktop(configPath);
  const repo = isPinned(pin) ? pin.image.slice(0, pin.image.lastIndexOf("@")) : tag;
  const t = spawnSync(docker, ["tag", tag, repo], { stdio: "inherit" });
  if (t.status !== 0) cannotTell(`docker tag ${tag} ${repo} failed (exit ${t.status})`);
  const p = spawnSync(WRANGLER, ["containers", "push", repo, "-c", configPath], { stdio: "inherit" });
  if (p.status !== 0) cannotTell(`wrangler containers push of ${repo} failed (exit ${p.status})`);
  const i = spawnSync(docker, ["image", "inspect", repo, "--format", "{{ json .RepoDigests }}"], { encoding: "utf8" });
  spawnSync(docker, ["image", "rm", repo], { stdio: "ignore" });
  spawnSync(docker, ["image", "rm", tag], { stdio: "ignore" });
  let digests: string[];
  try { digests = JSON.parse(i.stdout); } catch { cannotTell(`docker image inspect of pushed ${repo} failed`); }
  const pushed = digests.find((d) => d.includes("@"));
  if (!pushed) cannotTell(`pushed image had no RepoDigest`);
  return pushed;
}

function manualSteps(pin: string | undefined, appDir: string): string {
  const repo = pin ?? "<repo>";
  return [
    "desktop gate image changed. Rebuild, push, and re-pin by hand (image change ships only in an operator window):",
    "",
    `  cd ${appDir}`,
    "  docker build --load -t desktop-repin --platform linux/amd64 --provenance=false -f - container < container/Dockerfile.gate-desktop",
    `  docker tag desktop-repin ${repo}`,
    `  wrangler containers push ${repo} -c wrangler.local.jsonc`,
    `  # record the new digest and its dockerfile-sha (sha256 of Dockerfile + COPYs) next to the pin`,
    "  # in the ops config, e.g. /* dockerfile-sha: <64hex> */, then commit.",
  ].join("\n");
}

if (import.meta.main) {
  const [configPath, ...args] = process.argv.slice(2);
  const appDir = join(import.meta.dir, "..");
  if (!configPath) cannotTell("no config path given");

  const entry = gateRunnerDesktop(configPath);
  const repinMode = args.includes("--repin-desktop-image");
  if (!isPinned(entry)) {
    say("GateRunnerDO images.desktop is not digest-pinned — wrangler builds and pushes it; nothing to do.");
    process.exit(0);
  }

  if (repinMode) {
    say("building and pushing the desktop gate image...");
    const pushed = pushAndDigest(configPath, appDir);
    const pin = entry.image;
    const newRef = repin(pin, pushed.slice(pushed.lastIndexOf("@") + 1));
    if (newRef === null) cannotTell(`could not repin ${pin} from ${pushed}`);
    console.log(newRef);
    process.exit(0);
  }

  const current = desktopDockerfileSha(appDir);
  const recorded = recordedDesktopSha(readFileSync(configPath, "utf8"));
  const verdict = decideDesktopChange(recorded, current);
  if (verdict === "no-change") {
    say("desktop gate image unchanged (dockerfile-sha matches); continue.");
    process.exit(0);
  }
  say(`desktop gate image changed (dockerfile-sha ${recorded ?? "(unrecorded)"} != ${current}).`);
  say(manualSteps(entry.image, appDir));
  process.exit(1);
}