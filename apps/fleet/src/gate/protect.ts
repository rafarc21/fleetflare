// #1247 (refs #715, #1132): `fleet gate protect <owner/repo>` — the one verb
// that turns on required-status protection for a repo's default branch, so the
// gate runner becomes the only merge path. Pure over a port: the route wires
// the real GitHub calls (mint + protection API), tests pass a fake. No Env, no
// binding.
//
// The create/update split is load-bearing: a full PUT replaces the WHOLE rule,
// so it must run only when no rule exists yet. Once a rule exists, the verb
// only APPENDS the one context and re-pins strict — never a PUT that would wipe
// an operator's reviews/restrictions/admin settings.
import { GATE_STATUS_CONTEXT } from "./status-post";

/** The GitHub calls a protect needs, injected so tests fake them. */
export interface ProtectPort {
  getDefaultBranch: (repo: string) => Promise<string>;
  /** The required-status contexts currently on the branch, or null when the
   *  branch has no protection rule at all. */
  getProtection: (repo: string, branch: string) => Promise<{ contexts: string[] } | null>;
  /** Create a fresh rule (full PUT) — only when none exists yet. */
  createProtection: (repo: string, branch: string, contexts: string[]) => Promise<void>;
  /** Append contexts to an existing rule (POST) — touches nothing else. */
  addRequiredContexts: (repo: string, branch: string, contexts: string[]) => Promise<void>;
  /** PATCH strict on an existing rule — touches nothing else. */
  setStrict: (repo: string, branch: string, strict: boolean) => Promise<void>;
}

/** One run's outcome, the before/after the CLI prints. */
export interface ProtectResult {
  branch: string;
  before: string[];
  after: string[];
  changed: boolean;
}

/** Ensure the repo's default branch requires gate/verdict. Idempotent: the
 *  reported `after` is the existing set plus gate/verdict (deduped). No rule
 *  means a full PUT creating one; an existing rule is only appended to, never
 *  rewritten. */
export async function runGateProtect(port: ProtectPort, repo: string): Promise<ProtectResult> {
  const branch = await port.getDefaultBranch(repo);
  const existing = await port.getProtection(repo, branch);
  const before = existing?.contexts ?? [];
  const after = Array.from(new Set([...before, GATE_STATUS_CONTEXT]));
  if (existing === null) {
    await port.createProtection(repo, branch, after);
  } else {
    await port.addRequiredContexts(repo, branch, [GATE_STATUS_CONTEXT]);
    await port.setStrict(repo, branch, false);
  }
  return { branch, before, after, changed: !before.includes(GATE_STATUS_CONTEXT) };
}