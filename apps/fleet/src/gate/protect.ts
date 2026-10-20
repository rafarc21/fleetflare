// #1247 (refs #715, #1132): `fleet gate protect <owner/repo>` — the one verb
// that turns on required-status protection for a repo's default branch, so the
// gate runner becomes the only merge path. Pure over a port: the route wires
// the real GitHub calls (mint + protection API), tests pass a fake. No Env, no
// binding.
import { GATE_STATUS_CONTEXT } from "./status-post";

/** The three GitHub calls a protect needs, injected so tests fake them. */
export interface ProtectPort {
  getDefaultBranch: (repo: string) => Promise<string>;
  /** The required-status contexts currently on the branch, or null when the
   *  branch has no protection rule at all. */
  getProtection: (repo: string, branch: string) => Promise<{ contexts: string[] } | null>;
  /** PUT the protection rule: required status checks (strict=false) + no admin bypass. */
  setProtection: (repo: string, branch: string, contexts: string[]) => Promise<void>;
}

/** One run's outcome, the before/after the CLI prints. */
export interface ProtectResult {
  branch: string;
  before: string[];
  after: string[];
  changed: boolean;
}

/** Ensure the repo's default branch requires gate/verdict. Idempotent: the
 *  required contexts are the existing set plus gate/verdict (deduped), so a
 *  second run is a no-change. The PUT always runs, so a flipped `strict` is
 *  re-pinned to false even when the context list is already correct. */
export async function runGateProtect(port: ProtectPort, repo: string): Promise<ProtectResult> {
  const branch = await port.getDefaultBranch(repo);
  const before = (await port.getProtection(repo, branch))?.contexts ?? [];
  const after = Array.from(new Set([...before, GATE_STATUS_CONTEXT]));
  await port.setProtection(repo, branch, after);
  return { branch, before, after, changed: !before.includes(GATE_STATUS_CONTEXT) };
}