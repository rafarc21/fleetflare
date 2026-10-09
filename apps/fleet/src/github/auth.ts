// P6a — repo auth: HOW the fleet touches git, as a provider seam.
//
// This is not operator auth. The two axes were conflated for a long time and
// the design spec (docs/superpowers/specs/2026-08-30-fleet-oss-auth-p6-design.md
// §2) separates them: "may this human drive the fleet?" is Cloudflare Access /
// Directus and lives in src/studio/auth.ts; "how does the fleet touch git?" is
// this file. Nothing here decides who may ask.
//
// Two implementations:
//
//   UserToken        one fine-grained PAT (env.GITHUB_TOKEN). Any repo the
//                    token was granted. The DEFAULT, and the whole of what an
//                    OSS adopter has to bring — no GitHub App at all.
//   AppInstallation   the pre-P6a behaviour, unchanged. Org-scoped, a bot
//                    identity, higher rate limits. Better for a team.
//
// Selection is PER REPO OWNER, not global, and that is load-bearing rather
// than a nicety. Measured against the operator's real fine-grained PAT, 2026-08-30:
//
//   GET /repos/rafarc21/sample    -> 200   the token reaches it
//   GET /repos/acme-org/websites  -> 404   the token does NOT
//
// A single global provider is therefore wrong in both directions: the App
// cannot see the personal repo (GitHub Apps install per ACCOUNT, and no org
// installation can ever list a user's repo — installing the App "again" makes
// a SECOND installation with a different id, which is why clicking install
// never fixed the original failure), and the personal token cannot see the org
// repos where fleet.json, the blueprint and the board live. Switching the
// Worker to the token globally would cut the fleet off from its own
// infrastructure.
//
// So: env.GITHUB_REPO_AUTH maps owner -> provider ("acme-org=app"), with an
// automatic fallback for every owner it does not name. A small map and a
// fallback, deliberately not a plugin system.
//
// P6b — the token provider is ALSO per owner, for the same structural reason
// the provider choice is. A fine-grained PAT has exactly ONE resource owner;
// there is no "grant this token another org" setting to find. The deployed
// fleet's token owns `rafarc21`, so `acme-hq/acme-os` was unreachable no
// matter which provider it resolved to — measured 2026-09-11, `fleet onboard`:
//
//   [FAIL] reachable & writable — repo "acme-hq/acme-os" is not writable
//
// One PAT cannot be made to cover both owners; only a SECOND PAT can. So an
// owner may bring its own secret, named from the owner itself
// (`acme-hq` -> GITHUB_TOKEN_ACME_HQ, see tokenEnvName), with GITHUB_TOKEN
// as the declared default for every owner that has none.
//
// The fallback goes ONE way only, and that direction is the whole safety
// property: a per-owner MISS falls back to GITHUB_TOKEN — the same provider,
// the default the operator declared. A per-owner token is NEVER served for an
// owner other than the one it is named for. See resolveRepoAuthKind's comment;
// a credential silently used for the wrong owner is the failure this seam
// exists to make impossible, and a second PAT makes that failure cheaper to
// commit, not rarer.

import type { Env } from "../env";
import { installationEnvName, mintInstallationToken, mintInstallationTokenDetail, MintTokenError, type MintTokenOpts } from "./app";
import { listInstallationRepos, repoIsWritable, resolveCanonicalRepoName } from "./api";
import type { RepoReach } from "./reach";

export type RepoAuthKind = "token" | "app";

/** Re-exported so a caller that already imports this module does not need a
 *  second import; see ./reach.ts for the type and for why it lives there. */
export type { RepoReach } from "./reach";

/**
 * P6c — was a fixed string (`APP_REMEDY`) naming no variable at all. Now it
 * also names the escape hatch for THIS owner: an operator reading a refusal
 * for `demositeltda/site` has no way to discover `GITHUB_INSTALLATION_ID_DEMOSITELTDA`
 * exists unless the message says so.
 *
 * Deliberately NOT a precedence-aware answer (naming whichever variable
 * actually answered — shared default or owner's own, the way `tokenVarName`
 * does for `tokenRemedy`). That shape fits `tokenRemedy` because a token's
 * fix is always "widen THIS SAME credential's grant" — same var, more scope,
 * so naming whichever one answered is exactly the actionable next step. The
 * App has no equivalent:
 * you cannot widen an installation id's reach by env var, and the fix this
 * clause offers is structurally different — "this owner may need its OWN,
 * SEPARATE installation" — which is always the per-owner FORMAT
 * (`installationEnvName(owner)`), regardless of whether one is already set.
 * If one already is, the message still names it: the currently-configured
 * installation just doesn't cover this repo either, and the var it would
 * take a different value in is the same one.
 */
function appRemedy(owner: string): string {
  return (
    "is not reachable by this fleet's GitHub App installation — " +
    "install the app on it (or add it to the installation's repository list) first, " +
    `or set ${installationEnvName(owner)} if this owner needs its own installation`
  );
}

// One message has to be right in BOTH shapes a fine-grained PAT produces for
// an unreachable repo, because they are not the same failure and neither one
// is safe to assert:
//   - a PRIVATE repo outside the grant answers 404, exactly as a repo that
//     does not exist does — GitHub declining to confirm existence. Naming a
//     typo would be a guess.
//   - a PUBLIC repo outside the grant answers 200 with permissions.push false.
//     It plainly exists; what is missing is write access.
// So the wording leads with the write requirement (which covers the second and
// commoner case) and names the 404 reading explicitly rather than implying the
// repo is definitely there.
//
// The variable it names is the one that actually ANSWERED, not a fixed string:
// under a per-owner secret (P6b) the operator's next action is
// `wrangler secret put GITHUB_TOKEN_ACME_HQ`, and naming GITHUB_TOKEN would
// send them to widen a credential this repo never touched while the one that
// did stayed wrong.
function tokenRemedy(varName: string): string {
  return (
    "is not writable by this fleet's GitHub token — a studio clones AND pushes, " +
    `so read-only access is not enough; grant ${varName} write access to it ` +
    '(a fine-grained PAT lists its repos under "Repository access", with ' +
    "Contents: Read and write). GitHub answers 404 for a private repo the token " +
    "was never granted, so check the name too."
  );
}

/** The owner half of `owner/name`, lowercased — github.com treats owner and
 *  repo names case-insensitively, so the map must too. A string with no slash
 *  reads as its own owner; the GitHub call it feeds will fail with GitHub's
 *  own words, which is more useful than a second shape check here. */
export function repoOwner(repo: string): string {
  return (repo.split("/")[0] ?? "").toLowerCase();
}

/** The wildcard key. `*` is not a legal GitHub owner name, so one grammar
 *  covers both "this owner" and "everyone else" with no ambiguity — unlike a
 *  literal `default`, which somebody could actually own. */
export const REPO_AUTH_WILDCARD = "*";

/**
 * An owner's own token secret: `acme-hq` -> `GITHUB_TOKEN_ACME_HQ`.
 * Uppercased, every non-alphanumeric replaced with `_`.
 *
 * THE contract, and the reason it is pinned in a test: this string is what the
 * operator types into `wrangler secret put`. Change the shape and every
 * already-set secret stops being found — silently, because an unset per-owner
 * secret is a legal state that falls back to GITHUB_TOKEN.
 *
 * Two owners cannot collide in practice: GitHub owner names are alphanumerics
 * and hyphens only, so `-` is the only character this ever rewrites, and
 * `_` is not a legal owner name character to collide with.
 */
export function tokenEnvName(owner: string): string {
  return `GITHUB_TOKEN_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Env carries per-owner secrets whose NAMES are not knowable at compile time,
 * and Env is a closed interface every other consumer relies on. Rather than
 * widening it with an index signature — which would make every typo in every
 * other `env.FOO` read as `string | undefined` instead of failing the build —
 * the dynamic read is isolated to this one function behind an `unknown`-routed
 * cast. No `any`, no change to Env, and exactly one line in the codebase where
 * an env var is looked up by a computed name.
 */
type DynamicEnv = Readonly<Record<string, unknown>>;

/**
 * The token for this owner: its own secret if set, else GITHUB_TOKEN.
 * `undefined` means this owner has no token at all — not that it has a blank
 * one, since an empty secret is indistinguishable from an unset one in
 * practice and treating it as configured would send `Bearer ` at GitHub.
 *
 * Never reaches a log or an error message; callers hand the return value
 * straight to a request header or to studio/do.ts's credentialWriteCmd.
 */
export function repoToken(env: Env, owner: string): string | undefined {
  const own = (env as unknown as DynamicEnv)[tokenEnvName(owner)];
  if (typeof own === "string" && own !== "") return own;
  return typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN !== "" ? env.GITHUB_TOKEN : undefined;
}

/** Which variable supplied this owner's token — for messages only, never the
 *  value. Mirrors repoToken's own precedence, so an operator is always sent to
 *  the secret that actually answered. */
export function tokenVarName(env: Env, owner: string): string {
  const name = tokenEnvName(owner);
  const own = (env as unknown as DynamicEnv)[name];
  return typeof own === "string" && own !== "" ? name : "GITHUB_TOKEN";
}

/**
 * `GITHUB_REPO_AUTH` -> owner -> provider. Comma-separated `owner=provider`,
 * e.g. `acme-org=app` or `acme-org=app, *=token`.
 *
 * Every malformed entry THROWS rather than being skipped. A dropped entry
 * would silently run an owner on a provider nobody chose, and the whole point
 * of this map is that the choice is explicit — a config typo must surface as a
 * configuration error, not as work quietly done under the wrong credential.
 */
export function parseRepoAuthMap(raw: string | undefined): Map<string, RepoAuthKind> {
  const map = new Map<string, RepoAuthKind>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    const owner = (eq === -1 ? "" : trimmed.slice(0, eq)).trim().toLowerCase();
    const kind = (eq === -1 ? "" : trimmed.slice(eq + 1)).trim().toLowerCase();
    if (owner === "" || kind === "") {
      throw new Error(
        `GITHUB_REPO_AUTH entry ${JSON.stringify(trimmed)} is not "owner=provider" ` +
        '(e.g. "acme-org=app, *=token")',
      );
    }
    if (kind !== "token" && kind !== "app") {
      throw new Error(`GITHUB_REPO_AUTH: ${JSON.stringify(owner)} must map to "token" or "app", not ${JSON.stringify(kind)}`);
    }
    map.set(owner, kind);
  }
  return map;
}

/** Per OWNER, because a per-owner secret configures the token path for THAT
 *  owner on its own — an operator who sets only GITHUB_TOKEN_ACME_HQ has
 *  configured the token provider for acme-hq and for nobody else. */
function hasToken(env: Env, owner: string): boolean {
  return repoToken(env, owner) !== undefined;
}

/** Same isolation as `repoToken`'s own `DynamicEnv` cast — one computed-name
 *  env read, not a widened `Env` interface. See that function's doc comment. */
function hasInstallationId(env: Env, owner: string): boolean {
  const own = (env as unknown as DynamicEnv)[installationEnvName(owner)];
  if (typeof own === "string" && own !== "") return true;
  return typeof env.GITHUB_INSTALLATION_ID === "string" && env.GITHUB_INSTALLATION_ID !== "";
}

/** Per OWNER, like `hasToken`: configured if EITHER the owner's own
 *  installation id is set OR the shared `GITHUB_INSTALLATION_ID` is — an
 *  operator who sets only GITHUB_INSTALLATION_ID_ACME_HQ has configured the
 *  App for acme-hq and for nobody else (P6c, mirrors P6b's hasToken). */
function hasApp(env: Env, owner: string): boolean {
  return !!env.GITHUB_APP_ID && !!env.GITHUB_APP_PRIVATE_KEY && hasInstallationId(env, owner);
}

/** Named refusals, so a misconfiguration says which variable to set rather
 *  than failing later against GitHub with "Bad credentials". */
function assertConfigured(env: Env, owner: string, kind: RepoAuthKind, why: string): void {
  if (kind === "token" && !hasToken(env, owner)) {
    throw new Error(`${why} but GITHUB_TOKEN is not set — \`wrangler secret put GITHUB_TOKEN\` (a fine-grained PAT)`);
  }
  if (kind === "app" && !hasApp(env, owner)) {
    const missing = [
      env.GITHUB_APP_ID ? null : "GITHUB_APP_ID",
      env.GITHUB_APP_PRIVATE_KEY ? null : "GITHUB_APP_PRIVATE_KEY",
      // Generic name here, same as GITHUB_TOKEN above stays generic on the
      // token side — this refusal names what's missing, not per-owner; see
      // appRemedy for the message that IS per-owner-aware.
      hasInstallationId(env, owner) ? null : "GITHUB_INSTALLATION_ID",
    ].filter((v): v is string => v !== null);
    throw new Error(`${why} but the GitHub App is not fully configured — missing ${missing.join(", ")}`);
  }
}

/**
 * Which provider owns this repo, by its OWNER.
 *
 * Order: an explicit map entry for the owner, then the map's wildcard, then
 * the automatic fallback — token first, because a lone PAT is the OSS story
 * and "token is the default when both could apply" is the design ruling
 * (spec §4). An App-only fleet still resolves to the App for every owner,
 * which is what keeps the deployed Worker's behaviour identical until a token
 * is actually added.
 *
 * Throws, rather than falling back, when the chosen provider is not
 * configured: falling back would run an owner on a credential the operator
 * did not pick, and that is precisely the silent-wrong-credential failure this
 * seam exists to make impossible.
 */
export function resolveRepoAuthKind(env: Env, repo: string): RepoAuthKind {
  const map = parseRepoAuthMap(env.GITHUB_REPO_AUTH);
  const owner = repoOwner(repo);
  const mapped = map.get(owner) ?? map.get(REPO_AUTH_WILDCARD);
  if (mapped !== undefined) {
    assertConfigured(env, owner, mapped, `GITHUB_REPO_AUTH maps "${owner}" to "${mapped}"`);
    return mapped;
  }
  if (hasToken(env, owner)) return "token";
  if (hasApp(env, owner)) return "app";
  throw new Error(
    `no GitHub repo auth configured for "${owner}" — set GITHUB_TOKEN (a fine-grained PAT), ` +
    "or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_INSTALLATION_ID for a GitHub App",
  );
}

/**
 * A credential that can act on `repo` — the ONE function the rest of the fleet
 * calls where it used to call mintInstallationToken directly.
 *
 * Under the App this is a freshly minted, 1-hour installation token, exactly
 * as before (see src/github/app.ts for why it is deliberately uncached). Under
 * a token it is the PAT configured FOR THIS OWNER — its own secret if it has
 * one, else GITHUB_TOKEN (repoToken) — which is long-lived by nature: the
 * fleet did not mint it and cannot shorten it. That is the honest cost of the
 * token path, recorded in the spec (§4) and not papered over here — the
 * mitigations are unchanged and unrelated to lifetime: the value never reaches
 * a log, never reaches an error message, and reaches a container only through
 * the credential helper (src/studio/do.ts's credentialWriteCmd), never as a
 * plain environment variable.
 *
 * Issue #331: `opts` forwards straight to mintInstallationToken (app.ts's own
 * doc comment covers what each field does) and is simply ignored under a
 * token — a fine-grained PAT's scope is fixed by GitHub at issue time, not by
 * anything this call sends, so there is nothing here to narrow further.
 * `repo` itself is what scopes the App path's mint (`repositories`) — this
 * function already had `repo` in hand at every real call site, it just used
 * to discard it before reaching mintInstallationToken.
 *
 * PR #339 round 2 (issue #331), RISK — a scoped mint's `repositories: [repo]`
 * names the STORED slug; a repo renamed or transferred since that slug was
 * last resolved is no longer among the repos the installation can see under
 * that name, and GitHub 422s the whole mint (`MintTokenError`, app.ts).
 * Recovered ONCE, never looped: mint UNSCOPED (Worker-only — spent on
 * exactly one GraphQL call below and then discarded; this token is never
 * returned from this function and never reaches a container), resolve the
 * repo's CURRENT canonical name (#268's `resolveCanonicalRepoName`), and
 * retry the REAL scoped mint against that name. If the canonical name comes
 * back unchanged, this was not a rename — the 422 is real and propagates
 * rather than retrying the identical failing request. `opts.unscoped` skips
 * this entirely: a caller who already asked for the unscoped shape (today,
 * only `reachRepo`) gets the original error untouched.
 */
export async function mintRepoToken(env: Env, repo: string, opts?: MintTokenOpts): Promise<string> {
  const owner = repoOwner(repo);
  if (resolveRepoAuthKind(env, repo) === "token") return repoToken(env, owner) as string;
  try {
    return await mintInstallationToken(env, owner, repo, opts);
  } catch (err) {
    if (opts?.unscoped === true || !(err instanceof MintTokenError) || err.status !== 422) throw err;
    const lookup = await mintInstallationToken(env, owner, repo, { unscoped: true });
    const canonical = await resolveCanonicalRepoName(lookup, repo);
    if (canonical === repo) throw err;
    console.error(`mintRepoToken: ${repo} appears renamed to ${canonical}; retrying the scoped mint`);
    return mintInstallationToken(env, repoOwner(canonical), canonical, opts);
  }
}

/** Issue #291: most repos one read-only sibling token may cover. */
export const READ_REPOS_MAX = 15;

/** Issue #291: the ONLY permissions the sibling-repo token is ever minted
 *  with. Frozen: nothing downstream may widen it. */
export const READ_REPOS_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  contents: "read", metadata: "read",
});

/** `owner/name` and nothing else: GitHub's owner grammar, a repo name of
 *  word chars, dots and dashes. The value lands in a git config KEY inside a
 *  single-quoted shell word (studio/credentials.ts), so no quote, space or
 *  slash beyond the one separator may pass. A name of dots only (`.`, `..`)
 *  is a path segment, not a repo. */
const READ_REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Issue #291's guards, one function for both the board route (refuse before
 * any write) and the mint (refuse before any GitHub call). Returns the list
 * lowercased and de-duplicated, or the reason it is refused.
 *
 * Same owner as the task repo is the boundary: one owner = one App
 * installation, which is all this token can ever be minted from — and a
 * maestro filing a task for one org must not reach into another's repos.
 */
export function checkReadRepos(
  repos: readonly string[], taskRepo: string,
): { ok: true; repos: string[] } | { ok: false; message: string } {
  const owner = repoOwner(taskRepo);
  const out: string[] = [];
  for (const raw of repos) {
    const repo = raw.trim().toLowerCase();
    if (!READ_REPO_NAME.test(repo) || /\/\.+$/.test(repo)) {
      return { ok: false, message: `read-repos: ${JSON.stringify(raw)} is not an owner/name repo` };
    }
    if (repoOwner(repo) !== owner) {
      return {
        ok: false,
        message: `read-repos: ${repo} is not owned by ${owner} — a task may only read repos of its own repo's owner (${taskRepo})`,
      };
    }
    if (!out.includes(repo)) out.push(repo);
  }
  if (out.length > READ_REPOS_MAX) {
    return { ok: false, message: `read-repos: ${out.length} repos, over the limit of ${READ_REPOS_MAX}` };
  }
  return { ok: true, repos: out };
}

/**
 * Issue #291 — a SECOND installation token for a studio, read-only, scoped to
 * the sibling repos its task's maestro listed. The primary write token
 * (mintRepoToken, one repo) is untouched by this; the two are never the same
 * credential and never written to the same place.
 *
 * App provider only. A fine-grained PAT's permissions are fixed when it is
 * issued — nothing sent here could make it read-only, so handing the PAT out
 * as a "read" token would hand out write. Refused instead.
 *
 * Every guard runs before the JWT is even signed: an empty list, a foreign
 * owner, over the cap. `taskRepo` decides the owner, never the list itself.
 */
export async function mintReadReposToken(
  env: Env, taskRepo: string, repos: readonly string[],
): Promise<{ token: string; canonical: string[] }> {
  if (repos.length === 0) throw new Error("read-repos: no repos to grant — no opt-in mints nothing");
  const checked = checkReadRepos(repos, taskRepo);
  if (!checked.ok) throw new Error(checked.message);
  const owner = repoOwner(taskRepo);
  if (resolveRepoAuthKind(env, taskRepo) !== "app") {
    throw new Error(
      `read-repos needs the GitHub App provider for "${owner}" — a fine-grained PAT cannot be narrowed to read-only`,
    );
  }
  // PR #292 review: `canonical` = GitHub's own casing of each granted repo.
  // git matches a credential URL's path case-sensitively, so the helper is
  // keyed on these as well as on the lowercase grant.
  const minted = await mintInstallationTokenDetail(env, owner, taskRepo, {
    repositories: checked.repos,
    permissions: { ...READ_REPOS_PERMISSIONS },
  });
  return { token: minted.token, canonical: minted.repositories };
}

/**
 * A per-request minter memoised BY REPO.
 *
 * Every call site that used to hold one `tokenPromise ??=` closure now holds
 * one of these: a single provision reads fleet.json from the fleet repo and a
 * role file from the blueprint repo, a single board request makes up to three
 * calls against one repo, and minting once per repo instead of once per call
 * saves the same round trips it always did.
 *
 * PR #339 round 2 (issue #331) — BLOCKER, was keyed by OWNER: under the App
 * path a mint is now scoped to `repositories: [repo]` (app.ts's own doc
 * comment), so two DIFFERENT repos under the SAME owner are two DIFFERENT
 * tokens, not one shared one. A single provision reading fleet.json from the
 * fleet repo and a role file from a blueprint repo owned by the SAME org
 * (measured shape: `fleet.json` in one repo, `studios`/`roles` in another)
 * would mint the FLEET repo's scoped token first, cache it under the owner,
 * and hand that SAME repo-A-scoped token to the blueprint repo B read — which
 * 404s, because the token is not valid for B at all. The same class of bug
 * hits memory harvest (reads AGENT_REPO, commits to a blueprint repo) and
 * reap/rescue-gc's own multi-repo sweeps. Keying by the full repo string
 * fixes it: each repo gets its own correctly-scoped mint, still memoised
 * within the one request so N calls against the SAME repo still cost one
 * round trip, exactly as before.
 *
 * Under the token path this costs nothing extra worth noting — `mintRepoToken`
 * already returns the SAME per-owner PAT for every repo under that owner
 * (opts is ignored there, nothing to scope), so caching per-repo instead of
 * per-owner just means a few more (free, synchronous, no network) map
 * entries holding equal values, never a second real credential.
 *
 * Per-call, never module-level: a credential is not held across requests.
 */
export function repoTokenMinter(env: Env): (repo: string) => Promise<string> {
  const byRepo = new Map<string, Promise<string>>();
  return (repo: string) => {
    const cached = byRepo.get(repo);
    if (cached !== undefined) return cached;
    const minted = mintRepoToken(env, repo);
    byRepo.set(repo, minted);
    return minted;
  };
}

/**
 * THE reachability check: may this fleet touch this repo?
 *
 * It is the boundary a client can never move. src/studio/repo.ts's
 * resolveWorkRepo and src/board/board.ts's resolveBoardRepo both call it for
 * any repo a CALLER named, server-side, and refuse on a `false` — a client
 * cannot make a studio clone, or a board write to, a repo the fleet's own
 * credential cannot reach.
 *
 * The check MOVED between providers; it did not soften. Under the App it is
 * still "is this repo in the installation's repository list", byte-identical
 * to P4a including the message. Under a token it is "may this credential WRITE
 * to this repo" (github/api.ts's repoIsWritable) — the same question asked of
 * a different credential, and it works for any owner, which is what the org
 * installation structurally could not do.
 *
 * WRITE rather than the spec's original "can this credential GET this repo",
 * because GET turned out not to be a boundary at all: measured 2026-08-30, a
 * fine-grained PAT answers 200 for EVERY public repo on GitHub, granted or
 * not, so a GET check would accept any public repo in the world as a studio
 * target — with the fleet's own credential sitting in that studio's container.
 * `permissions.push` restores the intended set: repos this token was actually
 * granted. See repoIsWritable's own doc comment for the measurements.
 *
 * A transient failure THROWS rather than returning `{reachable: false}`. That
 * distinction is the whole reason this returns a union instead of a boolean:
 * both callers turn a throw into 503 ("ask again") and a false into 403
 * ("no"), and collapsing the two would make a GitHub outage read to an
 * operator as a permission problem they would then go and "fix".
 *
 * Issue #331 — a DOCUMENTED, DELIBERATE exception to "every mint is scoped to
 * its own repo": the mint below passes `unscoped: true` and asks
 * `listInstallationRepos` (the App's FULL repository list) rather than
 * scoping to `repo` and reinterpreting a mint failure as "not reachable".
 * Both shapes were considered; this one was chosen because the token minted
 * here never leaves this function — it answers one GET
 * (`/installation/repositories`) and is discarded immediately, unlike every
 * OTHER mint in this codebase, which is handed to a container or spent on a
 * merge and sits somewhere a compromised studio could reach it. Scoping a
 * token that never reaches a container narrows nothing that #331 actually
 * cares about, while trading a well-understood "is repo in this list" check
 * for "did a scoped mint 422" — a failure mode this function would then have
 * to start distinguishing from every OTHER reason a mint can fail (a bad
 * key, a revoked installation, a GitHub outage), none of which mean
 * "unreachable". `resolveWorkRepo` (src/studio/repo.ts) calls this for a repo
 * that may not be anyone's `workRepoSlug` yet — BEFORE any studio is bound to
 * it — so this is also the one place asking "is this repo in reach at all"
 * is the actual question, not "scope a credential that's about to ship".
 */
export async function reachRepo(env: Env, repo: string): Promise<RepoReach> {
  const owner = repoOwner(repo);
  if (resolveRepoAuthKind(env, repo) === "token") {
    const ok = await repoIsWritable(repoToken(env, owner) as string, repo);
    return ok ? { reachable: true } : { reachable: false, remedy: tokenRemedy(tokenVarName(env, owner)) };
  }
  const reachable = await listInstallationRepos(await mintInstallationToken(env, owner, repo, { unscoped: true }));
  const wanted = repo.toLowerCase();
  return reachable.some((full) => full.toLowerCase() === wanted)
    ? { reachable: true }
    : { reachable: false, remedy: appRemedy(owner) };
}
