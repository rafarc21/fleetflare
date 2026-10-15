// #715 Phase 1, v2 correction: no GATE_KV. A baseline's identity is fully
// determined by (mainSha, lockfileHash) — R2's own strong read-after-write
// consistency makes a deterministic key the lookup; there is no mutable
// pointer to go stale. Container snapshots (Cloudflare Containers,
// durable_object policy only, snapshotContainer()) are the PRIMARY restore
// mechanism once Task 0a's spike confirms acceptable restore time; the R2
// tarball key below is the FALLBACK until that's measured (Task 11).

export function baselineId(mainSha: string, lockfileHash: string): string {
  return `${mainSha}-${lockfileHash}`;
}

export function baselineTarballKey(
  owner: string, repo: string, mainSha: string, lockfileHash: string,
): string {
  return `gate/${owner}/${repo}/baselines/${baselineId(mainSha, lockfileHash)}.tar`;
}

// Snapshot names are restricted to lower-kebab ASCII; same rule as
// install-cache.ts's readableSource slug. Owners/repos can carry dots and
// underscores, so sanitize the whole name rather than trusting the caller.
export function baselineSnapshotName(
  owner: string, repo: string, mainSha: string, lockfileHash: string,
): string {
  return `${owner}-${repo}-${baselineId(mainSha, lockfileHash)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
