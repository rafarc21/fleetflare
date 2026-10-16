// #715: where a PR's gate config comes from. Pure: the caller hands in the one
// reader that fetches a repo's fleet.json at a ref, so bun test can run the
// whole lookup against an in-memory repo.
//
// Lookup order:
//   1. `gates[repo]` in the FLEET repo's fleet.json (read at HEAD). An entry
//      wins, and a malformed entry is a skip, never a fall-through.
//   2. Else the PR repo's OWN root fleet.json `gate` block, read at the PR's
//      BASE sha. Never the head or the merge commit: a PR must not be able to
//      edit its own gate.
//   3. Missing or malformed → null → the gate skips, same as today.
import { gateMapEntry, parseGateBlock, type GateConfig } from "./config";

/** Parsed fleet.json for `repo` at `ref`, or null when the file is absent or
 *  unparseable. Anything thrown is a transient fetch error and fails the step. */
export type FleetJsonReader = (repo: string, ref: string) => Promise<unknown>;

export interface LoadGateConfigInput {
  /** The PR's own "owner/repo". */
  repo: string;
  /** The repo fleet.json's `gates` map lives in (env.AGENT_REPO). */
  fleetRepo: string;
  /** The PR base branch's sha (resolve-pr's baseSha). Never the head. */
  baseSha: string;
}

export async function loadGateConfig(
  input: LoadGateConfigInput,
  readFleetJson: FleetJsonReader,
): Promise<GateConfig | null> {
  const fleet = await readFleetJson(input.fleetRepo, "HEAD");
  if (fleet === null) return null;
  const entry = gateMapEntry(fleet, input.repo);
  if (entry !== undefined) return parseGateBlock(entry);
  const own = await readFleetJson(input.repo, input.baseSha);
  const block = typeof own === "object" && own !== null ? (own as Record<string, unknown>).gate : undefined;
  return parseGateBlock(block);
}
