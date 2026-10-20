// Local studio = studio, backend half (fleet task #1248). A local studio
// runs on the operator's Mac instead of a Cloudflare container; only WHERE
// differs. This file holds the registry write and the row builder — the
// bring-up env the CLI launches claude with is resolved in routes.ts (which
// has `Env`), not here, so this stays a pure module in the same "imports no
// Env" discipline spawn.ts's own header states. No @cloudflare/sandbox, no
// env, no network.
import type { ProvisionConfig, StudioStatus } from "./types";

/**
 * The running row for a local studio. The same zero fields freshStatus
 * (provision.ts) writes for a cloud row, plus the local identity: `host:
 * "local"` and `localPath` (the Mac-side absolute path to the clone). A
 * local studio never mints a spawn token, never gets a tailscale host, and
 * never burns credits in a container — every one of those reads as its null
 * default, the same "not this kind of studio" shape a cloud row reads before
 * its first provision.
 */
export function localRowStatus(id: string, cfg: ProvisionConfig): StudioStatus {
  return {
    id,
    state: "running",
    tailscaleHost: null,
    lastRefresh: null,
    error: null,
    lastRefreshError: null,
    burn: null,
    spawnedBy: cfg.spawnedBy ?? null,
    repoSlug: cfg.repoSlug ?? null,
    spawnTokenHash: null,
    ...(cfg.leadType !== undefined ? { leadType: cfg.leadType } : {}),
    host: "local",
    localPath: cfg.localPath ?? null,
  };
}