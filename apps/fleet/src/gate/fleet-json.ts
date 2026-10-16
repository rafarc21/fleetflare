// The GitHub-backed FleetJsonReader (#715, #1072): one repo's fleet.json at a
// ref, read with a token minted for that repo. Shared by the gate Workflow's
// load-config step and the webhook's auto-run gate-block check, so both read
// a PR's config the same way.
import { fetchRepoFile } from "../github/api";
import type { FleetJsonReader } from "./load-config";

export function fleetJsonReader(mintToken: (repo: string) => Promise<string>): FleetJsonReader {
  return async (repoSlug, ref) => {
    const token = await mintToken(repoSlug);
    let text: string;
    try {
      text = await fetchRepoFile(token, repoSlug, "fleet.json", ref);
    } catch (err) {
      // No fleet.json at this ref: not a gated repo. Any other error is infra and retries.
      if (err instanceof Error && /\(404\)/.test(err.message)) return null;
      throw err;
    }
    try { return JSON.parse(text) as unknown; } catch { return null; }
  };
}
