// Carries no import of "@cloudflare/sandbox" or of do.ts's `StudioDO` VALUE
// (a type-only reference flows through `Env`, below, and is erased at build
// time) — it needs neither. Dispatch to the DO goes through profile.ts's
// `getStudioStub(env, id)` (issue #107: it, not this file, is now the one
// place that names `env.STUDIO`/`env.STUDIO_BIG` directly — see that file's
// header), a thin wrapper around the same `env.STUDIO.get(env.STUDIO.
// idFromName(...))` stub shape src/agents/do.ts and src/telegram/webhook.ts
// already use for AgentDO, not `getSandbox()` — confirmed equivalent for
// custom RPC methods; see sandbox-api.ts's provenance notes, section (a).
// Keeping the SDK out of this module also keeps it trivially importable
// from tests, which is how every /studio/* route is covered.
import type { Env } from "../env";
import { verifyAccess } from "./auth";
import { parseStudioId } from "./ids";
import { getStudioStub } from "./profile";
import type { ProvisionConfig, StudioStatus } from "./types";
import { TERMINAL_PATH } from "./terminal";
import { PASTE_MIME_EXT, PASTE_MAX_BYTES } from "./paste";
import { listStudios, expireBurnWindow, claimStudioRow } from "./registry";
import { renderTerminalPage } from "./page";
import { renderGridPage, scrubPreview, type GridCard } from "./grid";
import {
  runSpawn, resolveSpawnParent, resolveSpawnPolicy, resolveMaxStudios, liveStudioCount, isSpawnTokenShaped,
  SPAWN_TOKEN_HEADER, OPERATOR_ID, type SpawnDeps, type SpawnParent,
} from "./spawn";
import { reachRepo, repoTokenMinter, type RepoReach } from "../github/auth";
import { fetchRepoFile } from "../github/api";
import { resolveWorkRepo, parseRepoSlug, type WorkRepoDeps } from "./repo";
import { briefPromptResolver } from "../board/routes";
import { resolveProjectCard } from "../directus/card";
import { redactSecrets } from "./redact";
import type { Observed } from "./observed";
import { logWakeOutcome } from "./wake";
import { threwInsideDurableObject, runtimeFlags, errorMessage, durableObjectUnreachable } from "./rpc-failure";
import { RECYCLE_REFUSED_PREFIX } from "./recycle-cost";

const ROUTE_RE = /^\/studio\/([^/]+)\/(status|provisioned|provision|restart|recycle|destroy|wake|check|rescue|inspect|ws\/terminal|paste|terminal|clear-session-guard)$/;

/**
 * Issue #181, review round 2 — the SECOND read boundary for the 5h burn
 * bucket.
 *
 * Burn lives in two stores, not one. registry.ts's listStudios corrects the
 * D1 `fleet_state` copy, and that covers every reader that goes through the
 * registry. But do.ts's mirrorBurnToRegistry also writes burn into the DO's
 * own STATUS_KEY, and destroy.ts spreads that row forward into the stopped
 * row it stores — so every route below that answers a DO `StudioStatus`
 * reaches a reader without ever touching listStudios.
 *
 * `fleet ls --fresh` is the surface that makes it matter: cli/fleet.ts's
 * refreshAll POSTs /check to every studio and SWAPS each listing row for the
 * answer, so a corrected table gets overwritten with the DO's frozen bucket
 * under a BURN_LEGEND that promises the current one. Measured on this branch
 * before the wrap: /check answered 3,805,818 where listStudios answered 0.
 *
 * Same corrected VIEW listStudios applies, same function, same clock rule —
 * and, identically, NO WRITE: every call site below wraps the value on its
 * way into `Response.json`, after whatever storage the DO already did, so the
 * stored row keeps its stale bucket verbatim and the next real sync tick
 * still rolls the window exactly as before.
 */
const burnView = <T extends StudioStatus>(s: T): T => ({ ...s, burn: expireBurnWindow(s.burn ?? null, new Date()) });

// Task 4 review carry-over, closed by Task 11: blueprintRef used to be cast
// straight from the request body, unvalidated, and defaulted to a literal
// "main" when absent. Tag/branch/sha charset — matches what GitHub itself
// accepts in a ref, deliberately excludes shell/URL metacharacters, since
// this value flows into a Contents API path (src/github/api.ts's
// fetchRepoFile) via the blueprint wiring (provision.ts).
const BLUEPRINT_REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/**
 * Code-reviewer finding (issue #85 PR1): defense-in-depth for
 * `observed.session.reason` at this route's own output boundary, mirroring
 * `readinessOf`'s (do.ts) and `cleanObserved`'s (registry.ts) "belt and
 * braces" posture for the same field. `computeSessionVerdict`/
 * `computeAdoptedVerdict` (observed.ts) now scrub `reason` at the point
 * every `ObservedSession` is CONSTRUCTED, so every NEW write is already
 * clean by the time it reaches DO storage — this second pass only matters
 * for an already-stored record written before that fix landed, or one a
 * test fixture pokes into storage directly. Idempotent: a second
 * `redactSecrets` pass over already-clean text is a no-op.
 */
function redactObservedSession(observed: Observed): Observed {
  return observed.session
    ? { ...observed, session: { ...observed.session, reason: redactSecrets(observed.session.reason ?? "") || null } }
    : observed;
}

/**
 * Task 5 (P2 plane 3): assembles the grid page's per-studio card list and
 * renders it. Lives here, not grid.ts, for the same reason page.ts's own
 * render half never dispatches to a DO stub — routes.ts is this feature's
 * one file allowed to import "@cloudflare/sandbox" transitively via `Env`'s
 * type-only `StudioDO` reference and call `getStudioStub(env, ...)` (see
 * this file's own header comment; issue #107 moved the literal
 * `env.STUDIO.get(...)` one-liner into profile.ts, but the transitive SDK
 * import stays confined to this module the same way).
 *
 * Per-studio hot-tail reads are isolated with their own try/catch — the
 * same "one bad row must not fail the whole listing" posture
 * registry.ts's listStudios already applies to a malformed D1 row, applied
 * here to a DO round trip instead: a single unreachable/erroring studio
 * degrades to an empty preview for its own card, not a 500 for the entire
 * grid.
 */
async function renderStudioGrid(env: Env): Promise<Response> {
  const studios = await listStudios(env);
  const cards: GridCard[] = await Promise.all(
    studios.map(async (s): Promise<GridCard> => {
      let preview = "";
      try {
        const stub = getStudioStub(env, s.id);
        preview = scrubPreview(await stub.getTranscriptTail());
      } catch (err) {
        console.error(`grid: transcript tail read failed for ${s.id}`, err);
      }
      return {
        id: s.id, state: s.state, lastRefresh: s.lastRefresh,
        tailscaleHost: s.tailscaleHost, burn: s.burn, preview,
      };
    }),
  );
  return new Response(renderGridPage(cards), { headers: { "content-type": "text/html; charset=utf-8" } });
}

// --- Fleet Spawn P3, Task 2: the spawn routes -------------------------------

/**
 * One file's raw text from a repo at a ref. The one dependency of the spawn
 * path that cannot run under the test pool (it mints a GitHub App
 * installation token and makes a live API call), so both handlers below take
 * it as a defaulted parameter — the same dependency, in the same shape, that
 * `ProvisionDeps.fetchBlueprintFile` already injects for provisioning.
 */
export type BlueprintFetch = (repo: string, path: string, ref: string) => Promise<string>;

/**
 * The real `BlueprintFetch`: one credential per repo OWNER, minted lazily on
 * first use and reused for the (at most two) reads a single spawn call makes —
 * identical reasoning to StudioDO.deps()'s own minter, and for the same reason
 * it is per-call rather than module-level (a credential is never held across
 * requests).
 *
 * P6a: keyed by owner rather than a single shared promise, because the fleet
 * repo and a work repo can belong to different owners running on different
 * providers — see src/github/auth.ts's repoTokenMinter.
 */
function githubBlueprintFetch(env: Env): BlueprintFetch {
  const mint = repoTokenMinter(env);
  return async (repo: string, path: string, ref: string) => fetchRepoFile(await mint(repo), repo, path, ref);
}

/**
 * Dynamic repo selection (P4a): whether the fleet's own credential can reach
 * the repo a caller named, which is what repo.ts's resolveWorkRepo verifies
 * against. Per-call rather than module-level for the same reason
 * githubBlueprintFetch above is.
 *
 * P6a: this used to be the GitHub App installation's repository LIST. It is
 * now one question about one repo, answered by whichever provider owns that
 * repo's owner (src/github/auth.ts's reachRepo) — the App still answers from
 * its installation list, a token answers by asking whether it can GET the
 * repo. The boundary moved; it did not widen.
 *
 * Deliberately UNCACHED, unlike org.json/fleet.json (org.ts's caches exist
 * to stop the token-authenticated, container-driven /fleet/spawn amplifying
 * against the shared installation's rate limit). Both callers of this are
 * Access-gated and human-paced, and resolveWorkRepo skips the call entirely
 * whenever the resolved repo is the fleet default — so the existing
 * `websites` studios make no extra GitHub request at all, and the only
 * requests this adds are one per operator-initiated spawn/provision that
 * actually names a different repo.
 */
export type RepoReachFetch = (slug: string) => Promise<RepoReach>;

function githubRepoReach(env: Env): RepoReachFetch {
  return (slug: string) => reachRepo(env, slug);
}

function repoDeps(reach: RepoReachFetch): WorkRepoDeps {
  return { reachRepo: reach };
}

/**
 * P4a-2: the board read every entry point that builds a studio shares — "is
 * task #n assigned to the studio I am about to build, and what does its brief
 * say?". ONE resolver, so the ownership rule cannot be enforced differently at
 * two entry points.
 *
 * A defaulted parameter on both handlers below, for the same reason
 * `fetchFile` and `reach` already are: the real implementation mints an
 * installation token and calls GitHub, neither of which runs under the test
 * pool.
 */
export type BriefResolve = SpawnDeps["resolveBrief"];

export function spawnDeps(env: Env, fetchFile: BlueprintFetch, resolveBrief: BriefResolve): SpawnDeps {
  // Memoised for the lifetime of ONE request (spawnDeps is built per call),
  // the same lazy-once idiom githubBlueprintFetch above uses for its token:
  // /fleet/spawn reads the registry twice — once to resolve the parent from
  // its token, once for runSpawn's child-exists check — and those are two
  // reads of the same table, milliseconds apart, in service of one decision.
  let rows: Promise<StudioStatus[]> | null = null;
  return {
    listStudios: () => (rows ??= listStudios(env)),
    fetchPolicy: () => resolveSpawnPolicy(fetchFile, env.AGENT_REPO),
    // P5c: the project card is attached HERE rather than inside runSpawn,
    // so src/studio/spawn.ts keeps its "imports no Env, makes no network call
    // of its own" property (see SpawnDeps' own header) and both spawn routes
    // — /fleet/spawn and the operator's /studio/spawn — get the card through
    // one call site instead of two.
    //
    // `cfg.repo` is the estate key: the studio id's repo segment, which
    // resolveWorkRepo already refuses to let disagree with the work repo's
    // short name. It is also the only estate handle the Worker holds.
    //
    // resolveProjectCard is TOTAL — it never throws and never rejects (see
    // its own doc comment). That is what makes adding it to this path safe:
    // it introduces no new way for a spawn to fail.
    provisionChild: async (childId: string, cfg: ProvisionConfig) => {
      const projectCard = await resolveProjectCard(env, cfg.repo);
      const stub = getStudioStub(env, childId);
      return stub.provision(projectCard === null ? cfg : { ...cfg, projectCard });
    },
    resolveBrief,
    // Phase 2, task 4: the "studio spawned" re-arm. Same DO-stub shape
    // provisionChild uses just above — issue #107: which STUDIO/STUDIO_BIG
    // namespace a given id resolves to now lives in profile.ts, not here,
    // but this is still the one place in routes.ts that knows a spawned
    // studio needs waking. runSpawn already guards the maestro-spawning-
    // itself case and swallows a failure, so nothing is re-checked here.
    notifyMaestro: async (studioId: string, prompt: string) => {
      const outcome = await getStudioStub(env, studioId).wakeStudio(prompt);
      logWakeOutcome(`spawn: maestro wake (${studioId})`, outcome);
    },
    maxStudios: resolveMaxStudios(env.MAX_STUDIOS),
    claimStudioId: (_childId: string, placeholder: StudioStatus) => claimStudioRow(env, placeholder),
  };
}

/** The one body both spawn routes accept: `{role}`. Malformed JSON reads as
 *  an empty object and falls through to runSpawn's own 400, same shape the
 *  provision route already uses for its optional body. */
function spawnBody(req: Request): Promise<unknown> {
  return req.json().catch(() => ({}));
}

/**
 * R-P3-7's machine surface, mounted in index.ts for every path starting
 * `/fleet/` — deliberately OUTSIDE the `/studio` path the Access app
 * protects, because the callers are containers holding no Access service
 * token. The spawn token is therefore the ENTIRE authentication for this
 * route; it is checked before the body is even read.
 *
 * Order: path -> method -> auth -> parse -> delegate, the same discipline
 * handleStudio follows (with the token check standing in for verifyAccess).
 * Method before auth so a wrong-verb request gets a 405 rather than a
 * misleading 401; auth before parse so an unauthenticated caller learns
 * nothing about what this route accepts.
 */
export async function handleFleetSpawn(
  req: Request, env: Env,
  fetchFile: BlueprintFetch = githubBlueprintFetch(env),
  resolveBrief: BriefResolve = briefPromptResolver(env),
): Promise<Response> {
  if (new URL(req.url).pathname !== "/fleet/spawn") return new Response("not found", { status: 404 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // The shape gate runs here, before any I/O at all, so an unauthenticated
  // flood against this (deliberately Access-less) route costs one regex
  // rather than a D1 query each. resolveSpawnParent applies the identical
  // check again — it is the security-relevant one, and must not depend on a
  // caller having run it first. Same 401, same body, either way: absent,
  // malformed and unknown are one indistinguishable outcome (see
  // resolveSpawnParent's own doc comment).
  const presented = req.headers.get(SPAWN_TOKEN_HEADER);
  if (!isSpawnTokenShaped(presented)) return new Response("unauthorized", { status: 401 });

  const deps = spawnDeps(env, fetchFile, resolveBrief);
  const parent = await resolveSpawnParent(await deps.listStudios(), presented);
  if (!parent) return new Response("unauthorized", { status: 401 });

  return runSpawn(deps, parent, await spawnBody(req));
}

/**
 * Mounted in index.ts for every path starting `/studio/`. Order is: auth
 * (verifyAccess, unconditionally first — the gate for every /studio/*
 * request, per its own doc comment) -> route/id parse -> DO dispatch.
 *
 * `fetchFile` exists only for POST /studio/spawn below; see BlueprintFetch.
 * `reach` is the same kind of seam for dynamic repo selection — a live
 * GitHub call with no test double available.
 */
export async function handleStudio(
  req: Request, env: Env,
  fetchFile: BlueprintFetch = githubBlueprintFetch(env),
  reach: RepoReachFetch = githubRepoReach(env),
  resolveBrief: BriefResolve = briefPromptResolver(env),
): Promise<Response> {
  const authFailure = await verifyAccess(req, env);
  if (authFailure) return authFailure;

  const url = new URL(req.url);

  /**
   * The operator's own spawn (R-P3-7's "the Mac CLI also gains `fleet
   * spawn`"): the SAME core as /fleet/spawn, with the parent fixed to the
   * OPERATOR_ID literal instead of resolved from a token — Access has
   * already proven who is asking, and the human has no studio to be
   * resolved to. The repo segment the child id is derived from comes from
   * env.AGENT_REPO's own repo half, which is exactly the repo every
   * provision clones (StudioDO.provision passes AGENT_REPO through as its
   * repoSlug), so an operator-spawned id can never name a repo the studio
   * would not then check out.
   *
   * Handled before ROUTE_RE, which cannot match this path anyway (it
   * requires a second segment after the id) — placed here so the two spawn
   * routes read together, not because of an ordering hazard.
   */
  if (url.pathname === "/studio/spawn") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = (await spawnBody(req)) as { repo?: unknown };
    // Dynamic repo selection (P4a): `repo` is the full `owner/repo` the CLI
    // read out of the local `git remote origin`. resolveWorkRepo owns every
    // decision about it — shape, id-segment validity, the fleet-wide segment
    // claim, and reachability by the fleet's own credential — so this branch
    // holds no repo policy of its own, only the mapping to a Response.
    // Absent (not a git repo, no origin, a non-GitHub remote) resolves to
    // the fleet default, which is exactly the pre-P4a behavior, including
    // the "AGENT_REPO has no valid studio repo segment" 500 that used to
    // live inline here (review round 1, minor (b) — a DEPLOYMENT fault, not
    // a bad request, and it still names the variable to fix).
    //
    // `deps` is built first so the segment claim reads the registry through
    // the SAME memoised `listStudios` runSpawn's own child-exists check
    // uses — one D1 read serving both, not two (see spawnDeps).
    const deps = spawnDeps(env, fetchFile, resolveBrief);
    const repo = await resolveWorkRepo(repoDeps(reach), {
      requested: body.repo, defaultSlug: env.AGENT_REPO, rows: await deps.listStudios(),
    });
    if (!repo.ok) return new Response(repo.message, { status: repo.status });
    const parent: SpawnParent = {
      id: OPERATOR_ID, role: OPERATOR_ID, repo: repo.segment, repoSlug: repo.slug,
    };
    return runSpawn(deps, parent, body);
  }

  /**
   * Board task #125: `fleet onboard`'s check #2 ("reachable AND writable by
   * the fleet's GitHub credential"). Plain read-only GET, Access-gated the
   * same as every other /studio/* route (verifyAccess already ran above,
   * unconditionally, before any path is even inspected) — an operator/CLI
   * verb, not a spawn-token path, so it carries no body and makes no write.
   *
   * Does nothing but validate the `repo` query param's shape (parseRepoSlug
   * — the same "owner/name" grammar resolveWorkRepo/resolveBoardRepo already
   * validate request bodies against, reused rather than a second regex) and
   * hand the answer straight back from `reach` (src/github/auth.ts's
   * reachRepo, unmodified — this route adds no policy of its own, it only
   * exposes the existing check standalone for a caller with no studio to
   * provision yet).
   */
  if (url.pathname === "/studio/reach" && req.method === "GET") {
    const repoParam = url.searchParams.get("repo");
    const parsed = parseRepoSlug(repoParam);
    if (!parsed) {
      return new Response(`bad repo ${JSON.stringify(repoParam)} — expected "owner/name"`, { status: 400 });
    }
    return Response.json(await reach(`${parsed.owner}/${parsed.repo}`));
  }

  // The one route with no studio id in its path — `fleet ls` (Task 9). Falls
  // outside ROUTE_RE by construction (that pattern requires a non-empty
  // `[^/]+` id segment between the two slashes; "/studio/" alone never
  // satisfies it, so this can't shadow any id-scoped route below). Registry
  // rows are already scrubbed at the recordStudio write boundary (see that
  // file's own comment), so nothing further to redact on this read path.
  //
  // Task 5 (P2 plane 3): content-negotiated. A browser's `Accept` header
  // carries "text/html" (among others) for a plain navigation — that gets
  // the grid page; `fleet ls` (cli/fleet.ts) now sends `Accept:
  // application/json` explicitly, and anything else (no header at all, an
  // older CLI, a bare curl) falls through to the exact same JSON this route
  // always returned, unchanged. A substring check, not full Accept-header
  // parsing (q-values, multiple types) — deliberately: the design's own
  // ruling is "Accept containing text/html", and this route only ever needs
  // to pick between two fixed representations, not negotiate a general set.
  // `.toLowerCase()` guards against a technically-valid but non-lowercase
  // media type string; every test still exercises this by name in the more
  // common lowercase form.
  if (url.pathname === "/studio/" && req.method === "GET") {
    const accept = (req.headers.get("Accept") ?? "").toLowerCase();
    if (accept.includes("text/html")) return renderStudioGrid(env);
    return Response.json(await listStudios(env));
  }

  const m = ROUTE_RE.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404 });
  const [, rawId, action] = m;

  const id = parseStudioId(rawId);
  if (!id) return new Response("bad studio id", { status: 400 });

  const stub = getStudioStub(env, id.full);

  if (action === "status" && req.method === "GET") {
    return Response.json(burnView(await stub.getStatusDetail()));
  }
  /**
   * Read-only: does the CONTAINER say this studio is provisioned — repo
   * checkout present AND claude running in `tmux studio:claude`?
   *
   * The same check `recycle` gates on (do.ts's checkProvisionedWithRetry,
   * one shared function so the two can never disagree), minus every
   * destructive part of recycle: nothing is destroyed, provisioned, or
   * written. `ff` polls this before attaching, which is the whole reason it
   * exists — until it did, a client could only INFER provisioned-ness from
   * `state`/`error`, and the 2026-08-25 incident is precisely a container
   * reporting `state: running` over an empty /workspace.
   *
   * Three outcomes, verbatim from the shared check: `provisioned`, `bare`
   * (with the reason naming what is missing), `inconclusive` (a statement
   * about the CHECK — an exec that could not run — never about the studio).
   *
   * ALWAYS 200, including when the DO round trip itself throws: the caller's
   * correct response to "no verdict" is identical either way (fall back to
   * its own signal and say so), and a 5xx here would tempt a client into
   * treating an unreachable check as a broken studio — the exact inversion
   * this check was built to prevent. The failure is not silent: the reason
   * rides the body and the throw is logged server-side.
   *
   * `reason` can carry container stdout/stderr, so it is redacted at this
   * output boundary — the same posture recycle's own error path takes before
   * a reason reaches stored status.
   */
  if (action === "provisioned" && req.method === "GET") {
    try {
      const verdict = await stub.checkProvisioned(id.repo);
      return Response.json(
        verdict.kind === "provisioned" ? verdict : { ...verdict, reason: redactSecrets(verdict.reason) },
      );
    } catch (err) {
      console.error(`studio ${id.full} provisioned check failed`, err);
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      return Response.json({ kind: "inconclusive", reason: `check unreachable: ${message}` });
    }
  }
  /**
   * Issue #37: force a live check for ONE studio, now, and record it.
   *
   * The sibling of GET /provisioned, not a duplicate of it. That route answers
   * a bare three-way verdict and writes nothing — it exists for `ff`, which
   * polls it before attaching. This one answers the whole StudioStatus ROW and
   * RECORDS the verdict, which is what an operator needs: the `fleet ls` they
   * run next agrees with what they were just told, instead of showing the
   * pre-check value until the next syncSession tick (up to 300s).
   *
   * POST, not GET: it writes (DO storage + the D1 registry row). Nothing about
   * the CONTAINER changes — no clone, no bring-up, no destroy — and, per the
   * follow-up ruling on this issue, no tmux window is switched or created
   * either: provisionedCheckCmd addresses `studio:claude` BY NAME via
   * `display-message -p -t`, which never requires the window to be active. An
   * operator who attaches after a check sees exactly the window they left.
   *
   * WHAT THE ANSWER MEANS: `provisioned` is ALIVE-or-DEAD, never
   * WORKING-or-STOPPED — `pane_current_command` reads "claude" for a lead
   * mid-turn, a lead stopped waiting on background subagents, and a lead dead
   * at a shell prompt alike. See readinessOf's own doc comment (do.ts).
   *
   * Deliberately per-studio, with no fleet-wide variant on the listing route:
   * a live check is one container exec, and `fleet ls` is the first command an
   * operator runs when something looks wrong. `fleet ls --fresh` fans these
   * out from the CLI, so the cost is visible at the call site and one slow
   * container cannot wedge the whole listing.
   */
  if (action === "check" && req.method === "POST") {
    let checked: Awaited<ReturnType<typeof stub.checkNow>>;
    try {
      checked = await stub.checkNow();
    } catch (err) {
      // #96: an error the DO's own code threw is unchanged (rethrown); only a
      // Worker->DO failure is named here.
      if (threwInsideDurableObject(err)) throw err;
      return durableObjectUnreachable("check", err);
    }
    // Issue #181: the 5h bucket is corrected HERE, not inside checkNow —
    // checkAndRecordReadiness answers a stopped studio's stored row verbatim
    // (no exec, by design), and that row is exactly the frozen bucket
    // `fleet ls --fresh` then prints over the whole table. Applied before the
    // redaction below so the redacted copy carries the corrected view; both
    // are output-boundary corrections over the same answer, neither writes.
    const status = burnView(checked);
    // Same output-boundary redaction GET /provisioned applies to the same
    // container-echoed text. Belt and braces: do.ts's readinessOf already
    // scrubs the reason where it is first held.
    const readiness = status.readiness;
    return Response.json(
      readiness == null || readiness.kind === "provisioned"
        ? status
        : { ...status, readiness: { ...readiness, reason: redactSecrets(readiness.reason) } },
    );
  }
  /**
   * Issue #251: `fleet rescue-all`'s per-studio call — the maestro runs this
   * against every RUNNING studio right before an image deploy, closing the
   * "an image rollout replaces every studio's container with no rescue
   * mechanism at all" gap. Deliberately per-studio, no fleet-wide variant
   * here: cmdRescueAll (cli/fleet.ts) fans these out itself, exactly the way
   * `fleet ls --fresh` fans `/check` out, so a stopped studio is filtered
   * BEFORE this route is ever called (the CLI's own listStudios read, never
   * an exec) rather than trusting this route to refuse safely — do.ts's
   * `rescueNow` gates on `ctx.container.running` too, defense in depth,
   * never a substitute for that filter. `pushes` is `[]` on a clean/no-
   * checkout/markers-only studio: not an error, nothing to report.
   */
  if (action === "rescue" && req.method === "POST") {
    let result: Awaited<ReturnType<typeof stub.rescueNow>>;
    try {
      result = await stub.rescueNow();
    } catch (err) {
      if (threwInsideDurableObject(err)) throw err;
      return durableObjectUnreachable("rescue", err);
    }
    // Same output-boundary redaction /check and /provisioned already apply
    // to container-echoed text — a rejected push's error can carry a repo
    // URL/credential fragment from git's own stderr.
    return Response.json(result.ok ? result : {
      ok: false, error: redactSecrets(result.error),
      // Issue #39: worktree ids, refs and step names only — no git stderr.
      ...(result.worktrees ? { worktrees: result.worktrees } : {}),
    });
  }
  /**
   * Board #140 (#94 follow-up, HOLD fix): the operator's escape from a sync
   * guard stuck displacing every candidate — see do.ts's `clearSessionGuard`
   * for the full design (it now ARMS a one-shot force-upload override for
   * the next sync tick, rather than the original "delete the mark" design
   * that turned out to be a no-op — see that function's own doc comment for
   * why). POST, not GET: it writes DO storage (and, when the row carried a
   * refusal, the D1 registry row too). Storage-only: this route does no
   * exec and no R2 call of its own — the R2 read/copy this override
   * eventually triggers happens inside `syncSessionTick`, on the tick that
   * actually consumes it, never here — so this stays safe to call on a
   * STOPPED studio. Always 200 with the resulting row — there is no refusal
   * shape for this verb (a studio with no guard state at all is a harmless
   * no-op, not an error), and calling it twice in a row before any tick runs
   * is idempotent (the second call just re-arms the same already-armed
   * override).
   */
  if (action === "clear-session-guard" && req.method === "POST") {
    try {
      return Response.json(await stub.clearSessionGuard());
    } catch (err) {
      if (threwInsideDurableObject(err)) throw err;
      return durableObjectUnreachable("clear-session-guard", err);
    }
  }
  /**
   * Board issue #47 — the read-only inspection path. `fleet inspect <id>`'s
   * whole reason to exist: a coordinator that needs to know whether a
   * studio's lead is alive, right now, without attaching a tmux client and
   * risking exactly the repaint corruption that issue measured (a client
   * attaching/detaching forces a shared-pane redraw into every OTHER
   * client, the human operator's own terminal included).
   *
   * `?lines=<n>` overrides the default pane-tail length
   * (INSPECT_DEFAULT_TAIL_LINES, inspect.ts); anything non-numeric is
   * ignored and the default is used, same "never throw on a malformed query
   * param" posture as everywhere else this route parses one.
   *
   * ALWAYS 200, same posture POST /wake already takes and for the identical
   * reason (this route's own doc comment above): the outcome — including a
   * refusal ("this studio is stopped") — rides the JSON body's `ok` field,
   * because a coordinator polling for liveness needs an answer to act on,
   * never a 5xx to catch. `tail` and `bringupLogTail` are redacted at this
   * output boundary, same as GET /provisioned's `reason` and POST /check's
   * `readiness.reason` — both are raw container content and can carry
   * anything the studio's own terminal or bring-up log ever wrote, secrets
   * included.
   *
   * Issue #85, maestro correction #12: `observed` (the DO's own stored
   * `Observed` record — do.ts's `getObserved`) rides the body on BOTH the
   * `ok: true` and `ok: false` outcome shapes — a container-side failure
   * (the exec deadline firing) previously left an operator with only an
   * error string; the DO's own `replaced`/`unreachable`/session verdict now
   * rides along regardless, for free.
   */
  if (action === "inspect" && req.method === "GET") {
    const linesParam = Number(url.searchParams.get("lines"));
    const tailLines = Number.isFinite(linesParam) && linesParam > 0 ? linesParam : undefined;
    // Board #91: `runInspect` is total, but the RPC to reach it is not — a
    // DO reset or lost connection rejects right here. Uncaught, that became
    // Cloudflare's own HTML 500 page, which names no side at all.
    let outcome: Awaited<ReturnType<typeof stub.inspect>>;
    try {
      outcome = await stub.inspect(id.repo, tailLines);
    } catch (err) {
      // #96: say only what is known. "Network connection lost" also comes
      // from the DO->container link, and a drop on the return path after a
      // successful exec gets the same label — so the container may or may not
      // have been reached.
      return Response.json({
        ok: false,
        error: "Worker->DO call failed; the container may or may not have been reached: " +
          `${errorMessage(err)}${runtimeFlags(err)}`,
      });
    }
    // Issue #85, maestro correction #12: `observed` rides BOTH branches —
    // it is already attached by StudioDO.inspect() (do.ts), a plain storage
    // read with zero additional exec cost, so the ok:false branch below
    // needs no extra work to include it.
    // Code-reviewer finding (issue #85 PR1): the ok:false branch used to
    // return `outcome` (and its `observed`) with zero redaction — the
    // ok:true branch below was the only one scrubbing `session.reason`.
    // Both branches now run through the same `redactObservedSession` helper.
    if (!outcome.ok) return Response.json({ ...outcome, observed: redactObservedSession(outcome.observed) });
    return Response.json({
      ok: true,
      checkoutExists: outcome.snapshot.checkoutExists,
      paneCommand: outcome.snapshot.paneCommand,
      incarnationPresent: outcome.snapshot.incarnationPresent,
      bringupLogTail: redactSecrets(outcome.snapshot.bringupLogTail),
      tail: redactSecrets(outcome.snapshot.tail),
      capturedAt: outcome.snapshot.capturedAt,
      observed: redactObservedSession(outcome.observed),
      // Issue #228 item 5: rides both branches — the ok:false branch above
      // already gets it for free via `...outcome` (do.ts's inspect() method
      // attaches it regardless of runInspect's own outcome).
      sessionForceArmedAt: outcome.sessionForceArmedAt,
    });
  }
  if (action === "provision" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Partial<ProvisionConfig>;
    // Task 11: an explicit override for which blueprint ref to pull the
    // role file + org.json from — validated when the caller supplies one,
    // left absent otherwise (provision.ts's wiring falls back to
    // fleet.json's own pinned ref in that case; defaulting to "main" HERE
    // would make every request look like an explicit override and silently
    // defeat that pin — see ProvisionConfig.blueprintRef's own doc comment).
    let blueprintRef: string | undefined;
    if (body.blueprintRef !== undefined) {
      if (typeof body.blueprintRef !== "string" || !BLUEPRINT_REF_RE.test(body.blueprintRef)) {
        return new Response("bad blueprintRef", { status: 400 });
      }
      blueprintRef = body.blueprintRef;
    }
    // Fleet Spawn P3, Task 4 (R-P3-3): the same fleet-wide cap spawn.ts's
    // runSpawn enforces, applied at this — the OTHER — entry point that
    // creates a studio (see spawn.ts's own cap comment). Exempts an id
    // that already exists: provision is idempotently REPEATABLE by design
    // (do.ts's provision() doc comment — a re-provision is how an operator
    // recovers a degraded studio), so a fleet already at capacity must not
    // lose the ability to heal a studio it already counts.
    const existingRows = await listStudios(env);
    const maxStudios = resolveMaxStudios(env.MAX_STUDIOS);
    const live = liveStudioCount(existingRows);
    if (live >= maxStudios && !existingRows.some((r) => r.id === id.full)) {
      return new Response(
        `fleet is at capacity (${live}/${maxStudios} live studios) — cannot provision "${id.full}"`,
        { status: 409 },
      );
    }
    // Dynamic repo selection (P4a): verified LAST of the checks above — the
    // only one that can make an outbound GitHub call, so a malformed ref or
    // a full fleet is still rejected for free. `existingRows` is reused
    // rather than re-read: the cap check just fetched it, and the segment
    // claim needs exactly the same rows. `id.repo` is passed so a repo whose
    // short name disagrees with the id is refused outright — the id and the
    // checkout naming different repos is the silent-wrong-target failure
    // this whole feature exists to remove.
    const repo = await resolveWorkRepo(repoDeps(reach), {
      requested: (body as { repo?: unknown }).repo,
      boundSlug: existingRows.find((r) => r.id === id.full)?.repoSlug,
      defaultSlug: env.AGENT_REPO, rows: existingRows, idRepo: id.repo,
    });
    if (!repo.ok) return new Response(repo.message, { status: repo.status });
    // P4a-2 (brief pickup): the same `{task: <n>}` runSpawn accepts, at the
    // OTHER entry point that builds a studio — `ff <role> "<task>"` provisions
    // rather than spawns whenever the studio already exists but is not up.
    // Same resolver, so the ownership rule is enforced identically; the studio
    // id checked against the task's label is `id.full`, parsed from the PATH,
    // never from the body.
    let briefPrompt: string | undefined;
    const requestedTask = (body as { task?: unknown }).task;
    if (requestedTask !== undefined && requestedTask !== null) {
      if (typeof requestedTask !== "number" || !Number.isInteger(requestedTask) || requestedTask <= 0) {
        return new Response(`bad task ${JSON.stringify(requestedTask)} — expected a positive issue number`, { status: 400 });
      }
      const brief = await resolveBrief(id.full, repo.slug, requestedTask);
      if (!brief.ok) return new Response(brief.message, { status: brief.status });
      briefPrompt = brief.value;
    }
    // P5c: same total, fail-open estate read the spawn path above uses. A
    // null card (no credential, unreachable Directus, or a repo with no
    // estate row) provisions exactly as this route did before P5c — the
    // key is omitted rather than set to undefined so the RPC payload is
    // byte-identical to the pre-P5c one in that case.
    const projectCard = await resolveProjectCard(env, id.repo);
    const cfg: ProvisionConfig = {
      // Issue #269: the instance comes off the id this route was ADDRESSED
      // with, so re-provisioning `websites--pilot--2` rebuilds that studio and
      // not instance 1's. There is no `instance` request field here on purpose
      // — the id is the address, and a body that could disagree with it would
      // point the container at a different studio than the row it writes.
      // Omitted at instance 1 (which is what absent means), so provisioning an
      // ordinary studio sends the byte-identical payload it sent before #269.
      repo: id.repo, role: id.role, ...(id.instance === 1 ? {} : { instance: id.instance }),
      blueprintRef, repoSlug: repo.slug, briefPrompt,
      ...(projectCard === null ? {} : { projectCard }),
      // Issue #28: one bring-up with a fresh claude session, old one set aside.
      ...(url.searchParams.get("fresh-session") === "true" ? { freshSession: true } : {}),
    };
    try {
      return Response.json(burnView(await stub.provision(cfg)));
    } catch (err) {
      if (threwInsideDurableObject(err)) throw err;
      return durableObjectUnreachable("provision", err);
    }
  }
  /**
   * The waker's only entry point: type one prompt into this studio's claude
   * window and submit it. A Claude session acts only on a turn, and nothing
   * else in this Worker can give it one.
   *
   * Never 500s on a failed wake — the outcome rides the JSON body with a 200:
   * the caller is an operator's own HTTP request (the /gh webhook and the
   * sweep reach the DO directly, never this route), and a wake that did not
   * land is an answer about the container, not a server error. A 400 is
   * reserved for a malformed REQUEST, which is the caller's bug, not the
   * container's state. A 503 (#96) is reserved for the Worker->DO call
   * itself failing: then nothing answered about the container at all.
   */
  if (action === "wake" && req.method === "POST") {
    let prompt: unknown;
    try {
      const parsed: unknown = await req.json();
      prompt = (parsed as { prompt?: unknown } | null)?.prompt;
    } catch {
      return new Response("bad json body", { status: 400 });
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      return new Response("missing prompt — expected {\"prompt\": \"<one line>\"}", { status: 400 });
    }
    try {
      return Response.json(await stub.wakeStudio(prompt));
    } catch (err) {
      if (threwInsideDurableObject(err)) throw err;
      return durableObjectUnreachable("wake", err);
    }
  }
  if (action === "restart" && req.method === "POST") {
    try {
      return Response.json(burnView(await stub.restartStudio()));
    } catch (err) {
      if (threwInsideDurableObject(err)) throw err;
      return durableObjectUnreachable("restart", err);
    }
  }
  if (action === "recycle" && req.method === "POST") {
    // Root-cause fix for the stranded-image bug: recycle destroys the
    // container outright, so it needs a full ProvisionConfig to re-provision
    // with — the same repo/role the provision branch above builds, parsed
    // from this studio's own id. No body: unlike provision, recycle takes no
    // blueprintRef override (cli/fleet.ts's cmdRecycle POSTs empty, same as
    // cmdProvision) — the image recycle fixes is a container build artifact,
    // unrelated to which blueprint ref a role/studio file resolves from.
    // P5c: the card IS re-resolved here, unlike `briefPrompt` which recycle
    // deliberately drops. The two are not the same kind of thing — a brief is
    // one task's instruction and is still on the board under this studio's
    // label, while the card is the standing estate context. A recycled studio
    // that came back not knowing its own go-live or scope boundary would be a
    // silent downgrade of exactly the facts this feature exists to inject.
    // Total and fail-open, same as every other call site.
    const recycleCard = await resolveProjectCard(env, id.repo);
    const cfg: ProvisionConfig = {
      // Issue #269, same reason and same omit-at-1 as the provision route above.
      repo: id.repo, role: id.role, ...(id.instance === 1 ? {} : { instance: id.instance }),
      ...(recycleCard === null ? {} : { projectCard: recycleCard }),
      // Issue #28: same query param as the provision route above.
      ...(url.searchParams.get("fresh-session") === "true" ? { freshSession: true } : {}),
    };
    // Second review pass (2026-08-20): a live run found destroy+reprovision
    // racing — see do.ts's recycleWithSync/sbAwaitReady for the mechanism.
    // recycleWithSync already recorded a degraded status before throwing;
    // this catch's ONLY job is turning that throw into a non-200 response,
    // never a 200 body that could be mistaken for success. Deliberately NOT
    // the same posture as provision's own route above: a blueprint/clone/
    // bring-up failure there is a known DOMAIN outcome (runProvision's own
    // try/catch already turned it into a valid "degraded" StudioStatus, 200
    // is correct); a destroy/readiness failure here means recycle could not
    // even confirm a container to provision against, which is an
    // operational failure the caller must not be able to mistake for one.
    //
    // #96: `?discard-unsynced=true` is the ONLY way past recycleWithSync's
    // guard — a failed container probe otherwise refuses (409) with the price.
    const discardUnsynced = url.searchParams.get("discard-unsynced") === "true";
    try {
      return Response.json(burnView(await stub.recycle(cfg, discardUnsynced)));
    } catch (err) {
      // The refusal is recognised by its text FIRST: it is a decision, not a
      // failure, whatever the RPC layer did or did not mark on the error.
      const message = errorMessage(err);
      if (message.startsWith(RECYCLE_REFUSED_PREFIX)) {
        console.error(`studio ${id.full} recycle refused`, message);
        return new Response(message, { status: 409 });
      }
      console.error(`studio ${id.full} recycle failed`, err);
      if (!threwInsideDurableObject(err)) return durableObjectUnreachable("recycle", err);
      return new Response(`recycle failed: ${message}${runtimeFlags(err)}`, { status: 500 });
    }
  }
  /**
   * Fleet board task #124: `fleet destroy <id> [--force]` — stop a studio
   * for good, without recycle's own reprovision tail. `?force=true` is the
   * only body this route reads (no JSON, unlike provision/recycle — there is
   * nothing else to configure): the CLI's own `--force` flag
   * (cli-args.ts/cli/fleet.ts) maps straight onto it.
   *
   * `stub.destroyStudio` returns a tagged `DestroyOutcome`
   * (src/studio/destroy.ts) rather than throwing on a refusal, specifically
   * so this route can tell "an open board task blocks this" (409 — the
   * caller can fix it with `--force` or by finishing the task) apart from
   * every OTHER failure (500 — the same "recycle could not even confirm a
   * container" posture the recycle branch above already takes, for the
   * identical reason: an operational failure the caller must not be able to
   * mistake for a normal outcome). A genuine `destroyStudio` throw (the
   * container kill itself failing) is still caught here and mapped to 500,
   * same as recycle's own catch.
   */
  if (action === "destroy" && req.method === "POST") {
    const force = url.searchParams.get("force") === "true";
    // #113 M3: recycle's --discard-unsynced, for destroy — same query name.
    const discardUnsynced = url.searchParams.get("discard-unsynced") === "true";
    try {
      const result = await stub.destroyStudio(force, discardUnsynced);
      if (!result.ok) return new Response(result.reason, { status: 409 });
      return Response.json(burnView(result.status));
    } catch (err) {
      console.error(`studio ${id.full} destroy failed`, err);
      if (!threwInsideDurableObject(err)) return durableObjectUnreachable("destroy", err);
      return new Response(`destroy failed: ${errorMessage(err)}${runtimeFlags(err)}`, { status: 500 });
    }
  }
  if (action === "ws/terminal" && req.method === "GET") {
    // Issue #123: a non-upgrade GET reaches the DO too — it is `fleet attach`'s
    // refusal probe. The DO answers 409 for a stopped or destroying studio,
    // else 426 from TerminalBridge.attach, which opens nothing.
    //
    // Rewritten to the DO's own internal path (see TERMINAL_PATH) rather than
    // forwarded as-is: StudioDO.fetch has to tell our upgrade apart from the
    // container traffic its Sandbox base class routes through the same
    // method, and pinning the path here keeps that test independent of
    // whatever the public URL looks like. The Upgrade header must survive the
    // rewrite or the DO answers 426 — asserted in test/studio.ws.test.ts.
    return stub.fetch(new Request(`https://studio${TERMINAL_PATH}`, { headers: req.headers }));
  }
  if (action === "terminal" && req.method === "GET") {
    // The zero-install browser fallback page (Task 10) — xterm.js attached
    // to the same `ws/terminal` route above. Auth already ran first, same
    // as every other /studio/* route; the page itself isn't secret, but
    // consistency with the rest of this handler is free. No DO round trip:
    // the page is a static, pre-bundled artifact (page.ts) with just the
    // studio id substituted in, so it never touches `stub`.
    return new Response(renderTerminalPage(id.full), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (action === "paste" && req.method === "POST") {
    // Validation order (Task 6 brief, binding): mime, then size — both
    // checked before the body is buffered where possible. The Content-Type
    // check costs nothing to do first. The Content-Length check is the fast
    // path for size: an honest oversized upload is rejected off the header
    // alone, no read at all.
    const contentType = req.headers.get("Content-Type") ?? "";
    if (!PASTE_MIME_EXT[contentType]) return new Response("unsupported content type", { status: 415 });

    const declaredLength = req.headers.get("Content-Length");
    if (declaredLength !== null) {
      const declared = Number(declaredLength);
      if (Number.isFinite(declared) && declared > PASTE_MAX_BYTES) {
        return new Response("payload too large", { status: 413 });
      }
    }

    // Content-Length is a client-supplied claim, not a guarantee — a
    // missing or lying header must not bypass the cap. This still reads the
    // whole body via arrayBuffer() (brief's prescribed Step 3 shape) rather
    // than aborting a stream mid-read, so the check below is the actual hard
    // enforcement point, not the Content-Length branch above (that one is
    // only ever a fast-reject for an honest caller).
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > PASTE_MAX_BYTES) return new Response("payload too large", { status: 413 });

    try {
      const { path } = await stub.pasteImage(contentType, bytes);
      return Response.json({ path });
    } catch (err) {
      // Static body, not the caught error's message: simpler than routing
      // through redactSecrets, and just as safe — see provision.ts's own
      // status.error handling for the case where a raw message DOES need to
      // reach a caller (it doesn't here; nothing about a paste failure is
      // actionable client-side beyond "it failed"). Logged server-side only,
      // same as sandbox-api.ts's own failStream does for a dead pty socket.
      console.error("studio paste write failed", err);
      return new Response("write failed", { status: 500 });
    }
  }
  return new Response("not found", { status: 404 });
}
