// #715: where a PR's gate config comes from. Pure: the caller hands in the one
// reader that fetches a repo's fleet.json at a ref, so bun test can run the
// whole lookup against an in-memory repo.
//
// Lookup order:
//   1. `gates[repo]` in the FLEET repo's fleet.json (read at HEAD). An entry
//      wins, and a malformed entry is a skip, never a fall-through.
//   2. Else the PR repo's OWN root fleet.json `gate` block, read at the PR's
//      BASE sha. Never the head or the merge commit: a PR must not be able to
//      edit its own gate. Exception (#1091): a PR that changes fleet.json is
//      gated on the head's block, the config it introduces.
//   3. Missing or malformed → null → the gate skips, same as today.
import { fleetJsonChanged, gateMapEntry, parseGateBlock, type GateConfig } from "./config";

/** Parsed fleet.json for `repo` at `ref`, or null when the file is absent or
 *  unparseable. Anything thrown is a transient fetch error and fails the step. */
export type FleetJsonReader = (repo: string, ref: string) => Promise<unknown>;

export interface LoadGateConfigInput {
  /** The PR's own "owner/repo". */
  repo: string;
  /** The repo fleet.json's `gates` map lives in (env.AGENT_REPO). */
  fleetRepo: string;
  /** The sha the PR's own fleet.json is read at: the base sha (resolve-pr's
   *  baseSha), or the head for a PR that changes fleet.json (#1091 review: the
   *  workflow reads both). */
  configSha: string;
}

/** Whether `repo` is the fleet repo itself (case-insensitive). */
export function isFleetRepo(repo: string, fleetRepo: string): boolean {
  return repo.toLowerCase() === fleetRepo.toLowerCase();
}

export async function loadGateConfig(
  input: LoadGateConfigInput,
  readFleetJson: FleetJsonReader,
): Promise<GateConfig | null> {
  const fleet = await readFleetJson(input.fleetRepo, "HEAD");
  // For the fleet repo itself, its gates map is also read at configSha (#1095
  // round 3): a PR that edits its own gates entry is validated by its own run.
  // An entry at configSha wins, even when malformed. Only a missing entry falls
  // through to HEAD's, so a bad entry is never masked by an older good one.
  const atSha = isFleetRepo(input.repo, input.fleetRepo) ? await readFleetJson(input.fleetRepo, input.configSha) : null;
  const shaEntry = gateMapEntry(atSha, input.repo);
  const entry = shaEntry !== undefined ? shaEntry : gateMapEntry(fleet, input.repo);
  if (entry !== undefined) return parseGateBlock(entry);
  if (fleet === null) return null;
  const own = await readFleetJson(input.repo, input.configSha);
  const block = typeof own === "object" && own !== null ? (own as Record<string, unknown>).gate : undefined;
  return parseGateBlock(block);
}

/** Whether a PR changed its repo's root fleet.json (#1095 round 3): content at the
 *  PR's MERGE-BASE against content at its head. The base branch's tip is not
 *  compared. A change that landed on the base after the PR branched is not the
 *  PR's, so a PR that never touched fleet.json takes no union path. */
export async function prConfigChanged(
  readFleetJson: FleetJsonReader, repo: string, mergeBaseSha: string, headSha: string,
): Promise<boolean> {
  return fleetJsonChanged(await readFleetJson(repo, mergeBaseSha), await readFleetJson(repo, headSha));
}
