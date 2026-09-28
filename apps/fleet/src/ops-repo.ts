/**
 * Issues #341 and #330: the operator's PRIVATE config repo, one `owner/name`
 * in the Worker setting `FLEET_OPS_REPO` (e.g. `rafarc21/fleetflare-ops`).
 * Everything operator-specific that must not ship in the public fleet repo
 * lives there, each feature at its own path: harvested memory
 * (`fleet/memory/`, src/memory/store.ts) and the house-rules overlay (#330).
 *
 * Unset (or blank) = those features OFF: the public default. A value that is
 * not `owner/name` is also off, logged once per call -- never guessed at.
 * Set it with `wrangler secret put FLEET_OPS_REPO`: not a secret, but it
 * survives every deploy and keeps the committed config free of it.
 *
 * Imports nothing: reachable from the Worker and the bun:test lane alike.
 */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function resolveOpsRepo(env: { FLEET_OPS_REPO?: string }): string | null {
  const raw = (env.FLEET_OPS_REPO ?? "").trim();
  if (raw === "") return null;
  if (!REPO_RE.test(raw)) {
    console.error(`ops repo: FLEET_OPS_REPO ${JSON.stringify(raw)} is not owner/name -- ops-repo features are off`);
    return null;
  }
  return raw;
}
