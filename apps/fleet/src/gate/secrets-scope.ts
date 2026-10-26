// #1346: the two functions every gate-scoped secret grant passes through --
// trustedForSecrets decides WHO, grantedSecretNames decides WHICH NAMES.
// Pure: no fetch, no binding, no secret value -- this file only ever decides
// a boolean and a list of NAMEs, never resolves one to a value
// (secrets-registry.ts/do.ts do that, after both of these already ran).
import { gateSecretsRepoEntry, type GateSecretsAllowlist, type GateSecretsLegEntry } from "./secrets-config";
import { isKnownSecretName } from "./secrets-registry";

/** #1376 security review r1 item 1: the base leg name a `@head`/`@head-<n>`
 *  union-plan leg was renamed FROM, or null when `leg` is not such a name.
 *  Must be the EXACT inverse of fanout.ts's own headLegName:
 *    headLegName("vitest-3") === "vitest@head-3"   (a sharded vitest/bun lane)
 *    headLegName("ai-smoke") === "ai-smoke@head"   (everything else)
 *  A single regex (`^(.+)@head(?:-\d+)?$`) is NOT that inverse: its greedy
 *  `(.+)` strips the WHOLE `@head-<n>` suffix, turning "vitest@head-3" into
 *  base "vitest" (not "vitest-3" -- so a granted "vitest-3" entry can never
 *  match its own head copy) and, worse, turning "bun@head-7" into base "bun"
 *  -- so an OPS entry for a CUSTOM leg literally named "bun" (unrelated to
 *  the auto-generated bun-test shard lanes) would leak its grant to every
 *  bun-shard leg's head copy. The two shapes are checked separately, in the
 *  same order headLegName itself branches: the sharded-lane shape FIRST
 *  (narrower, `vitest`/`bun` only, with a shard number), the plain shape
 *  second (anything else, no shard number) -- so "ai-smoke@head-3," a name
 *  headLegName can never actually produce, matches neither and resolves to
 *  null, not a wrong base. */
export function headLegBaseName(leg: string): string | null {
  const sharded = /^(vitest|bun)@head-(\d+)$/.exec(leg);
  if (sharded !== null) return `${sharded[1]}-${sharded[2]}`;
  const plain = /^(.+)@head$/.exec(leg);
  return plain === null ? null : plain[1];
}

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

/** A leg's own OPS-allowlist entry, looked up prototype-safely. #1346 security
 *  review r1 LOW: a leg literally named "constructor" or "__proto__" must not
 *  resolve through the object's own prototype chain. Belt and suspenders,
 *  both load-bearing against a DIFFERENT construction of `allowlist` than
 *  this file's own parseGateSecretsAllowlist produces (which already uses
 *  Object.create(null) containers, making a bare bracket lookup safe on its
 *  own): Object.hasOwn refuses an inherited property outright, and the
 *  `secrets`-array check refuses whatever that property turns out to be (a
 *  function, `Object.prototype` itself) when it isn't a real entry -- see
 *  gate-secrets-scope.test.ts's own RAW_ALLOWLIST fixture, built as a plain
 *  object specifically to exercise both of these independently of the
 *  parser's own hardening. Undefined for anything that isn't a well-formed
 *  `GateSecretsLegEntry`, never a thrown error. */
function ownLegEntry(
  forRepo: Readonly<Record<string, GateSecretsLegEntry>>, leg: string,
): GateSecretsLegEntry | undefined {
  if (!Object.hasOwn(forRepo, leg)) return undefined;
  const entry = forRepo[leg];
  if (typeof entry !== "object" || entry === null || !Array.isArray(entry.secrets)) return undefined;
  return entry;
}

function filterKnownNames(repo: string, leg: string, names: readonly string[]): string[] {
  return names.filter((name) => {
    const known = isKnownSecretName(name);
    if (!known) console.warn(`gate-secrets: ${repo} leg "${leg}" grants unknown secret name "${name}" -- ignored`);
    return known;
  });
}

/**
 * Independent guards, checked in this order on purpose -- cheapest and most
 * load-bearing first:
 *   1. trust guard     -- `trusted === false` (see trustedForSecrets, above)
 *                         grants nothing, unconditionally, whatever the
 *                         allowlist says. Identical for a leg's base name and
 *                         its @head copy -- #1376 adds no second, looser gate.
 *   2. repo guard      -- the OPS allowlist has no entry for this repo.
 *   3. leg guard       -- neither this leg's own name, nor (#1376) its base
 *                         leg's name with `head: true` when `leg` is a
 *                         `@head`/`@head-<n>` union-plan copy, has an entry.
 *   4. registry guard  -- a name the OPS file lists but this Worker's own
 *                         registry never defined grants nothing (defense in
 *                         depth against an OPS-file typo or a stale entry
 *                         left behind after a registry entry was removed).
 *                         Logged (name only, never a value) so a stale OPS
 *                         entry is visible to the operator, not silent.
 *
 * #1376: a PR that ADDS a secret-needing leg to its own fleet.json runs it as
 * `<leg>@head` under the union plan (fanout.ts's planUnionLegs) -- with no
 * opt-in, that leg would always be a different NAME from the one the OPS file
 * grants, so it would never match guard 3 and would run DID-NOT-RUN forever,
 * never able to land on a green gate. An explicit `head: true` on the BASE
 * leg's own entry (never settable by the PR, same OPS-file-only reach as
 * every other grant here) opts a repo's leg into sharing its grant with its
 * own head copy -- still gated by the exact same trust filter, never a looser
 * one: the risk is unchanged from a base leg running PR-controlled code,
 * because that is exactly what a `@head` leg already is.
 */
export function grantedSecretNames(
  allowlist: GateSecretsAllowlist, repo: string, leg: string, trusted: boolean,
): string[] {
  if (!trusted) return [];
  const forRepo = gateSecretsRepoEntry(allowlist, repo);
  if (forRepo === undefined) return [];
  const direct = ownLegEntry(forRepo, leg);
  if (direct !== undefined) return filterKnownNames(repo, leg, direct.secrets);
  const baseName = headLegBaseName(leg);
  if (baseName === null) return [];
  const base = ownLegEntry(forRepo, baseName);
  if (base === undefined || base.head !== true) return [];
  return filterKnownNames(repo, baseName, base.secrets);
}
