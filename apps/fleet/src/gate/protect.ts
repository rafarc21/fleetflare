// #1247 (refs #715, #1132): `fleet gate protect <owner/repo>` — the one verb
// that turns on required-status protection for a repo's default branch, so the
// gate runner becomes the only merge path. Pure over a port: the route wires
// the real GitHub calls (mint + protection API), tests pass a fake. No Env, no
// binding.
//
// The create/update split is load-bearing: a full PUT replaces the WHOLE rule,
// so it must run only when no rule exists yet. Once a rule exists, the verb
// appends the one context and re-pins strict. If the rule has no
// required_status_checks block, the contexts POST would 404, so we PATCH that
// whole block. We also turn off enforce_admins so the gate is not bypassable.
// We never issue a PUT that would wipe an operator's reviews/restrictions/admin
// settings.
import { GATE_STATUS_CONTEXT } from "./status-post";

/** One branch's protection state as protect reads it. */
export interface ProtectionState {
  contexts: string[];
  hasRequiredStatusChecks: boolean;
  enforceAdmins: boolean;
}

/** The GitHub calls a protect needs, injected so tests fake them. */
export interface ProtectPort {
  getDefaultBranch: (repo: string) => Promise<string>;
  /** The branch's protection state, or null when it has no rule at all. */
  getProtection: (repo: string, branch: string) => Promise<ProtectionState | null>;
  /** Create a fresh rule (full PUT) — only when none exists yet. */
  createProtection: (repo: string, branch: string, contexts: string[]) => Promise<void>;
  /** Append contexts to an existing rule (POST) — touches nothing else. */
  addRequiredContexts: (repo: string, branch: string, contexts: string[]) => Promise<void>;
  /** PATCH strict on an existing rule — touches nothing else. */
  setStrict: (repo: string, branch: string, strict: boolean) => Promise<void>;
  /** PATCH the whole required_status_checks block (strict + contexts) — the
   *  fallback for a rule with no required-status block, where the contexts
   *  POST would 404. */
  setRequiredStatusChecks: (repo: string, branch: string, strict: boolean, contexts: string[]) => Promise<void>;
  /** DELETE the enforce_admins sub-resource — turn admin enforcement off. */
  disableEnforceAdmins: (repo: string, branch: string) => Promise<void>;
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
    if (existing.hasRequiredStatusChecks) {
      await port.addRequiredContexts(repo, branch, [GATE_STATUS_CONTEXT]);
      await port.setStrict(repo, branch, false);
    } else {
      // No required-status block: the contexts POST would 404, so PATCH the
      // whole block (strict + the union of contexts) instead.
      await port.setRequiredStatusChecks(repo, branch, false, after);
    }
    if (existing.enforceAdmins) {
      await port.disableEnforceAdmins(repo, branch);
    }
  }
  return { branch, before, after, changed: !before.includes(GATE_STATUS_CONTEXT) };
}