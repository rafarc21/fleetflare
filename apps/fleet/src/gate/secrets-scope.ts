// #1346: the two functions every gate-scoped secret grant passes through --
// trustedForSecrets decides WHO, grantedSecretNames decides WHICH NAMES.
// Pure: no fetch, no binding, no secret value -- this file only ever decides
// a boolean and a list of NAMEs, never resolves one to a value
// (secrets-registry.ts/do.ts do that, after both of these already ran).
import { gateSecretsRepoEntry, type GateSecretsAllowlist } from "./secrets-config";
import { isKnownSecretName } from "./secrets-registry";

/** #1346 security review r1: author_association values trusted enough to
 *  receive a gate-scoped secret. CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR and NONE
 *  are deliberately excluded -- those are exactly the associations a fork PR
 *  or an outside contributor's same-repo branch (if branch creation were ever
 *  opened to non-collaborators) would carry. */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface SecretsTrustInput {
  /** head.repo === base.repo (never a fork). */
  sameRepo: boolean;
  /** GitHub's own author_association for this PR. */
  authorAssociation: string;
  /** The PR author's GitHub account type is "Bot" (dependabot[bot] etc). */
  authorIsBot: boolean;
  /** The PR's own base ref name. */
  baseRef: string;
  /** The repo's actual default branch name (read fresh, never assumed). */
  defaultBranch: string;
}

/**
 * Four independent guards, checked in this order on purpose -- cheapest and
 * most load-bearing first. All four must hold, or nothing is granted:
 *   1. same-repo guard   -- never a fork, unconditionally.
 *   2. association guard -- only OWNER/MEMBER/COLLABORATOR; a same-repo PR
 *                            from anyone with lesser standing (CONTRIBUTOR,
 *                            FIRST_TIME_CONTRIBUTOR, NONE) is refused the
 *                            same as a fork.
 *   3. bot guard          -- never an automated account (dependabot etc).
 *   4. default-base guard -- the PR's base must be the repo's actual default
 *                            branch, never a branch the PR author could have
 *                            created themselves. Without this, a same-repo
 *                            collaborator could open a PR against a
 *                            self-created base branch -- fully
 *                            self-controlled on both ends -- and still pass
 *                            every other check here.
 *
 * This is NOT a defense against a malicious collaborator's PR code running
 * inside the leg that gets a secret -- that PR code always runs (that is the
 * gate's whole job). It only narrows WHO can ever reach a grant at all, down
 * from "anyone who can open a same-repo PR" to "someone GitHub itself already
 * calls a trusted collaborator, on the repo's own default branch." See the
 * design doc's "Residual risk" for what this does and does not contain.
 */
export function trustedForSecrets(input: SecretsTrustInput): boolean {
  if (!input.sameRepo) return false;
  if (!TRUSTED_ASSOCIATIONS.has(input.authorAssociation)) return false;
  if (input.authorIsBot) return false;
  if (input.baseRef !== input.defaultBranch) return false;
  return true;
}

/**
 * Four independent guards, checked in this order on purpose -- cheapest and
 * most load-bearing first:
 *   1. trust guard     -- `trusted === false` (see trustedForSecrets, above)
 *                         grants nothing, unconditionally, whatever the
 *                         allowlist says.
 *   2. repo guard      -- the OPS allowlist has no entry for this repo.
 *   3. leg guard       -- this repo's entry does not name this leg.
 *   4. registry guard  -- a name the OPS file lists but this Worker's own
 *                         registry never defined grants nothing (defense in
 *                         depth against an OPS-file typo or a stale entry
 *                         left behind after a registry entry was removed).
 *                         Logged (name only, never a value) so a stale OPS
 *                         entry is visible to the operator, not silent.
 */
export function grantedSecretNames(
  allowlist: GateSecretsAllowlist, repo: string, leg: string, trusted: boolean,
): string[] {
  if (!trusted) return [];
  const forRepo = gateSecretsRepoEntry(allowlist, repo);
  if (forRepo === undefined) return [];
  // #1346 security review r1 LOW: a leg literally named "constructor" or
  // "__proto__" must not resolve through the object's own prototype chain.
  // Belt and suspenders, both load-bearing against a DIFFERENT construction
  // of `allowlist` than this file's own parseGateSecretsAllowlist produces
  // (which already uses Object.create(null) containers, making a bare
  // bracket lookup safe on its own): Object.hasOwn refuses an inherited
  // property outright, and Array.isArray refuses whatever that property
  // turns out to be (a function, `Object.prototype` itself) when it isn't
  // actually an array -- see gate-secrets-scope.test.ts's own RAW_ALLOWLIST
  // fixture, built as a plain object specifically to exercise both of these
  // independently of the parser's own hardening.
  if (!Object.hasOwn(forRepo, leg)) return [];
  const names = forRepo[leg];
  if (!Array.isArray(names)) return [];
  return names.filter((name) => {
    const known = isKnownSecretName(name);
    if (!known) console.warn(`gate-secrets: ${repo} leg "${leg}" grants unknown secret name "${name}" -- ignored`);
    return known;
  });
}
