// Dynamic repo selection (P4a, §10's `ff`): which repo does a studio clone?
//
// Until this file existed the answer was one hardcoded string —
// `env.AGENT_REPO` — passed straight into provision.ts's guardedCloneCmd. It
// now names THREE different things that this file keeps apart:
//
//   1. the FLEET repo (`env.AGENT_REPO`): where fleet.json lives, and the
//      DEFAULT work repo. Deployment config, not client input.
//   2. the BLUEPRINT repo (`fleet.json`'s own `blueprint.repo`): where
//      studios/, roles/, org.json and skills live. Already separate in
//      provision.ts; it must NEVER follow the detected repo, or a client
//      repo could choose which prompts run with the fleet's credentials.
//   3. the WORK repo (`ProvisionConfig.repoSlug`): the ONLY one this file
//      resolves, and the only one a caller may steer.
//
// Pure over one port, for the same reason spawn.ts is: everything worth
// asserting on is here, routes.ts holds only the wiring. Nothing in this
// file imports `Env` or touches a binding.
//
// The rule it exists to enforce: a caller NAMES a repo, the Worker VERIFIES
// it. Verification is reachability by the fleet's OWN credential — the same
// boundary that already decides what that credential can read — checked
// server-side, never inferred from the request. P6a moved WHERE that answer
// comes from (an App installation's repository list, or a token's own view of
// the repo, per owner — src/github/auth.ts's reachRepo) without softening it:
// still mandatory, still server-side, still fail-closed. A short name alone
// (`beta`) is ambiguous across orgs and is therefore never accepted as
// input; the CLI sends the full `owner/repo` it read out of `git remote
// origin`, and this file decides whether the fleet may have it.

import { buildStudioId, isIdSegment, parseStudioId, parseStudioTarget } from "./ids";
import type { StudioStatus } from "./types";
// Type-only, and from reach.ts rather than auth.ts on purpose: this module
// imports no binding and touches no Env, and cli/fleet.ts type-checks against
// it under a tsconfig with no workers-types. See github/reach.ts's header.
import type { RepoReach } from "../github/reach";

// GitHub's own repo/owner charset. Deliberately excludes every path and
// shell metacharacter: this value reaches a `git clone https://github.com/
// <slug>.git` command line (provision.ts's guardedCloneCmd), so "looks like
// a repo name" and "cannot break out of that URL" have to be the same check.
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Every remote form `git remote get-url origin` can hand back for a
// github.com repo: https/http (optionally with an embedded user), ssh://,
// git://, and the scp-style `git@github.com:owner/repo`. An enterprise or
// non-GitHub host matches none of them ON PURPOSE — the App is installed on
// github.com, so anything else has no owner this fleet could resolve.
const GITHUB_REMOTE_RE =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]*@)?github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/**
 * `git remote get-url origin` output -> `owner/repo`, or null when the
 * remote is not a github.com repo at all. Null is a REASON to fall back to
 * the fleet default with a message (cli/fleet.ts prints one), never a
 * reason to guess an owner — a guessed owner is exactly the silent-wrong-
 * target failure this feature exists to remove.
 *
 * Only a `.git` SUFFIX is stripped; a repo whose name merely contains a dot
 * (`example.dev`) survives intact.
 */
export function parseGitRemote(url: string): string | null {
  const m = GITHUB_REMOTE_RE.exec(url.trim());
  if (!m) return null;
  const [, owner, repo] = m;
  if (!REPO_NAME_RE.test(owner) || !REPO_NAME_RE.test(repo)) return null;
  return `${owner}/${repo}`;
}

/** `owner/repo` -> its two halves, or null for anything else. Takes
 *  `unknown` so a raw request-body field can be validated in one call. */
export function parseRepoSlug(raw: unknown): { owner: string; repo: string } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!REPO_NAME_RE.test(owner) || !REPO_NAME_RE.test(repo)) return null;
  return { owner, repo };
}

// GitHub's separator charset inside a repo name: `.`, `_` and `-`. A RUN of
// them folds to ONE hyphen, and the run part is load-bearing rather than
// tidiness — mapping each character on its own would turn `a..b` into
// `a--b`, and `--` is the studio id's repo/role delimiter (ids.ts), so the
// fold would invent an id that parses as repo "a" / role "b".
const SEPARATOR_RUN_RE = /[._-]+/g;

/**
 * A repo's short name as a studio id segment (ids.ts's grammar), or null
 * when no fold can make it one.
 *
 * Lowercasing is safe — github.com treats owner/repo names
 * case-insensitively, so `Beta` and `beta` cannot both exist in one org, and
 * folding them together invents no collision.
 *
 * Dots and underscores FOLD to hyphens (board #21). They used to be refused
 * outright, on the grounds that mapping `a.b` and `a-b` onto one segment
 * manufactures a collision — true, and the cost of that refusal was measured:
 * `exampleorg.com`, `demosite.life`, `acmevault.ai` and
 * `example-owner.com` could have no studio at all, so their CTOs fell back to
 * local agents. The dot cannot simply be ALLOWED into the segment either: a
 * studio id becomes a DNS label — container/studio-bringup.sh runs `tailscale
 * up --hostname="$STUDIO_ID"`, and `fleet ls`'s HOST column is that label
 * plus the tailnet suffix (observed: `fleetflare--web-studio-8.example-tailnet
 * .ts.net`) — and a dot would split that label in two.
 *
 * So the collision is not prevented here, it is REFUSED downstream and
 * loudly: `resolveWorkRepo`'s fleet-wide segment claim 409s the second repo
 * to reach for a segment another repo already holds, and `ffDecision`
 * (studio/ff.ts) refuses to ATTACH across that same disagreement. Folding
 * without those two checks would be the silent-wrong-target failure this
 * module exists to remove; with them, `a.b` and `a-b` in one fleet is an
 * error message naming both slugs.
 *
 * This is the ONE fold in the system. Every comparison between a repo name
 * and a studio id's repo half goes through it — studio/onboard.ts's
 * existing-studio check, cli/fleet.ts's provision/id agreement and
 * cli/orca-workspace.ts's Orca repo lookup all call it rather than
 * lowercasing a short name themselves.
 */
export function repoIdSegment(repo: string): string | null {
  const folded = repo.toLowerCase().replace(SEPARATOR_RUN_RE, "-");
  return isIdSegment(folded) ? folded : null;
}

export type StudioIdResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * The studio id a ROLE names inside a detected repo — `<repo-segment>--<role>`.
 *
 * The Mac CLIs speak roles ("web-studio") because that is what an operator
 * knows; the board speaks studio ids because that is what an assignment label
 * carries. This is the one place that bridge is crossed, and it exists as a
 * function rather than three inline lines because getting it wrong is SILENT:
 * a wrong repo segment produces a perfectly valid id belonging to a different
 * repo's studio, and a task assigned to it simply never reaches anyone.
 *
 * A folder that names no repo is a refusal, never a fallback. The fleet's
 * default repo is deployment config no route publishes (see src/studio/ff.ts's
 * ffDecision, which reaches the same conclusion from the other direction), so
 * guessing here would mean assigning the operator's task to a studio in a repo he was
 * not standing in.
 *
 * Issue #269: `instance` defaults to 1, which is the two-segment id this
 * function has always produced. A caller that names an instance gets
 * `<repo>--<role>--<n>` from the same builder every other id goes through
 * (ids.ts's buildStudioId), never a hand-joined string.
 */
export function studioIdIn(slug: string | null, role: string, instance = 1): StudioIdResult {
  if (slug === null) {
    return {
      ok: false,
      message: `this folder names no repo, so "${role}" names no studio — cd into the repo you mean`,
    };
  }
  const short = slug.split("/")[1] ?? "";
  const segment = repoIdSegment(short);
  if (segment === null) {
    return {
      ok: false,
      message: `repo "${slug}" cannot name a studio: "${short}" is not a valid id segment ` +
        "(lowercase alphanumerics joined by single hyphens; dots and underscores fold to hyphens)",
    };
  }
  if (!isIdSegment(role)) {
    return {
      ok: false,
      message: `"${role}" is not a role: lowercase alphanumerics joined by single hyphens`,
    };
  }
  return { ok: true, id: buildStudioId({ repo: segment, role, instance }) };
}

/**
 * The studio id a `fleet task assign <n> <target>` target names — issue #269
 * item 3, and the only place the three target shapes are turned into one id.
 *
 * `parseStudioTarget` (ids.ts) decides WHAT was typed; this decides what it
 * RESOLVES to, which is the half that needs a repo:
 *   - a role (`pilot`, `pilot--2`) is resolved against the detected repo, the
 *     same `studioIdIn` bridge `fleet spawn` and `ff` already cross;
 *   - a full id (`websites--pilot`, `websites--pilot--2`) is already qualified
 *     and is used verbatim — standing in another folder is irrelevant to it,
 *     so it deliberately does NOT go through repo detection at all.
 *
 * A target that is neither is a refusal naming all three shapes, never a
 * best-effort guess: see `studioIdIn`'s own comment for why a wrong id here is
 * silent rather than loud.
 */
export function studioIdForTarget(slug: string | null, target: string): StudioIdResult {
  const parsed = parseStudioTarget(target);
  if (parsed === null) {
    return {
      ok: false,
      message: `"${target}" names no studio — expected a role ("pilot"), a role with an ` +
        'instance ("pilot--2"), or a full studio id ("websites--pilot", "websites--pilot--2")',
    };
  }
  if (parsed.kind === "role") return studioIdIn(slug, parsed.role, parsed.instance);
  return { ok: true, id: buildStudioId(parsed) };
}

/** The one thing this module cannot do purely: whether the fleet's own
 *  credential can actually reach a repo. Throwing is a meaningful outcome —
 *  503, never a silent allow — the same posture SpawnDeps.fetchPolicy already
 *  takes toward org.json.
 *
 *  P6a: this used to be `listInstallationRepos: () => Promise<string[]>` and a
 *  membership test right here. It is a per-repo question now because the
 *  answer depends on which provider owns that repo's OWNER (src/github/auth.ts's
 *  reachRepo) — an installation list is one provider's way of answering it, not
 *  the question itself. The refusal wording comes back WITH the answer for the
 *  same reason: only the provider knows whether the remedy is "install the app"
 *  or "grant the token", and a refusal naming the wrong fix is worse than a
 *  vague one. */
export interface WorkRepoDeps {
  reachRepo: (slug: string) => Promise<RepoReach>;
}

export interface WorkRepoRequest {
  /** The caller's raw `repo` body field. `undefined` = "no opinion", which
   *  falls back to `boundSlug` then `defaultSlug` and skips verification
   *  entirely — neither of those came from a caller. */
  requested: unknown;
  /**
   * The slug this studio is ALREADY bound to (its registry row's
   * `repoSlug`), when the id names an existing studio. It is what a
   * bodyless re-provision resolves to, which is what stops `fleet provision
   * beta--maestro` — run from anywhere, carrying no repo — from quietly
   * re-cloning the fleet default over a beta studio.
   */
  boundSlug?: string | null;
  /** `env.AGENT_REPO` — the fleet's own repo, deployment config. */
  defaultSlug: string;
  /** Registry rows, for the segment claim below. */
  rows: StudioStatus[];
  /** When the studio id is already fixed (POST /studio/:id/provision), the
   *  repo segment it carries — the resolved repo must agree with it, or the
   *  id would name one repo while the container cloned another. Absent for
   *  a spawn, where the id is DERIVED from the resolved repo instead. */
  idRepo?: string;
}

export type WorkRepoResult =
  | { ok: true; slug: string; segment: string }
  | { ok: false; status: number; message: string };

/**
 * The repo segment is claimed FLEET-WIDE by the first studio bound to a
 * slug, not per studio id: two orgs that both own an `beta` would otherwise
 * put `beta--maestro` and `beta--web-studio` in one fleet pointing at
 * different code, and `fleet ls`'s REPO column would read identically for
 * both. Returns the slug already holding `segment`, or null.
 *
 * A row with a null `repoSlug` predates this feature and was therefore
 * cloned from AGENT_REPO — it reads as `defaultSlug`, so a legacy
 * `websites--pilot` still guards `websites` against a foreign
 * `other-org/websites`. A row whose id does not parse is skipped, the same
 * "one bad row must not fail the whole decision" posture registry.ts's
 * listStudios already takes.
 */
function claimedBy(rows: StudioStatus[], segment: string, defaultSlug: string): string | null {
  for (const r of rows) {
    if (parseStudioId(r.id)?.repo !== segment) continue;
    return (r.repoSlug ?? defaultSlug).toLowerCase();
  }
  return null;
}

/**
 * Decides the WORK repo for one provision/spawn.
 *
 * Order is deliberate, cheapest and most local first: shape -> id agreement
 * -> segment claim -> reachability. The network call is LAST, so
 * every malformed or already-conflicting request costs zero outbound
 * traffic, the same discipline routes.ts's paste handler and spawn.ts's
 * runSpawn already follow.
 *
 * The reachability call is skipped entirely when the resolved repo IS the
 * fleet default: that value comes from wrangler.jsonc, not from a caller,
 * so there is nothing to verify — and skipping it means the existing
 * `websites` studios provision through exactly the code path (and exactly
 * the outbound calls) they always did.
 */
export async function resolveWorkRepo(
  deps: WorkRepoDeps, req: WorkRepoRequest,
): Promise<WorkRepoResult> {
  const defaultLower = req.defaultSlug.toLowerCase();
  let slug: string;
  if (req.requested === undefined) {
    slug = (req.boundSlug ?? req.defaultSlug).toLowerCase();
  } else {
    const parsed = parseRepoSlug(req.requested);
    if (!parsed) {
      return { ok: false, status: 400, message: `bad repo ${JSON.stringify(req.requested)} — expected "owner/name"` };
    }
    slug = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  }

  const short = slug.split("/")[1];
  const segment = repoIdSegment(short);
  if (segment === null) {
    // A default that cannot produce an id segment is a DEPLOYMENT fault, not
    // a bad request — answering 400 would send the operator hunting the
    // wrong problem entirely. 500, and it names the variable to fix. Same
    // ruling routes.ts's /studio/spawn already applied to AGENT_REPO.
    if (req.requested === undefined && slug === defaultLower) {
      return {
        ok: false, status: 500,
        message: `fleet misconfigured: AGENT_REPO ("${req.defaultSlug}") has no valid studio repo segment`,
      };
    }
    return {
      ok: false, status: 400,
      message: `repo "${slug}" cannot name a studio: "${short}" is not a valid id segment ` +
        "(lowercase alphanumerics joined by single hyphens; dots and underscores fold to hyphens)",
    };
  }

  if (req.idRepo !== undefined && req.idRepo !== segment) {
    return {
      ok: false, status: 400,
      message: `repo "${slug}" does not match studio id repo segment "${req.idRepo}" — ` +
        "the id and the checkout would name different repos" +
        (req.requested === undefined
          ? `; this studio is not bound to a repo yet, so run the command from a "${req.idRepo}" checkout`
          : ""),
    };
  }

  const claim = claimedBy(req.rows, segment, defaultLower);
  if (claim !== null && claim !== slug) {
    return {
      ok: false, status: 409,
      message: `studio repo segment "${segment}" is already claimed by "${claim}" — ` +
        `"${slug}" would collide with it (dots and underscores fold to hyphens, so "a.b" and ` +
        `"a-b" reach for the same segment); rename one repo or run it in its own fleet`,
    };
  }

  // Verify only what a CALLER supplied, and only when it is not the fleet's
  // own configured repo. The two skipped cases are skipped on the same
  // principle, not as an optimisation: `defaultSlug` comes from
  // wrangler.jsonc, and `boundSlug` is a slug THIS Worker already verified
  // when it bound it — neither is client input, so neither has anything to
  // verify. Re-checking a bound slug would also put a live GitHub call in
  // front of every re-provision, which is the operator's own recovery path
  // for a degraded studio; a repo the fleet genuinely lost access to still
  // fails, loudly and specifically, at the clone.
  if (req.requested !== undefined && slug !== defaultLower) {
    let reach: RepoReach;
    try {
      reach = await deps.reachRepo(slug);
    } catch (err) {
      // 503, not 500: the request is not wrong, the answer is temporarily
      // unavailable, and retrying later is the right client behaviour. The
      // caught error can carry an upstream GitHub message (and, on some
      // failures, a token) — logged server-side only, the same posture
      // spawn.ts's org-unavailable branch takes.
      console.error(`repo: reachability unavailable for "${slug}"`, err);
      return { ok: false, status: 503, message: "repo reachability unavailable" };
    }
    if (!reach.reachable) {
      // The remedy comes from the provider that actually answered, so the
      // message tells an operator to install an App or to grant a token
      // depending on which one governs that owner — never the wrong one.
      return { ok: false, status: 403, message: `repo "${slug}" ${reach.remedy}` };
    }
  }

  return { ok: true, slug, segment };
}
