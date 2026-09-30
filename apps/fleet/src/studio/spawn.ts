// Spawn core — Fleet Spawn P3, Task 2 (R-P3-1/R-P3-2/R-P3-7).
//
// Pure over ports, for the same reason provision.ts is: everything worth
// asserting on lives here, and routes.ts holds only the HTTP shell that wires
// the three ports below to real bindings (registry reads, the blueprint
// fetch, the STUDIO DO stub). Nothing in this file imports "@cloudflare/
// sandbox", touches `env`, or knows a DurableObjectNamespace exists.
//
// The one rule this file exists to enforce is R-P3-1: **the Worker is law**.
// A role file's `may_spawn` frontmatter is advisory documentation that lives
// inside the container an agent controls; org.json's `edges`, fetched
// server-side at the blueprint's pinned ref, is the only thing checked here.
// A studio proves WHICH role it is by presenting the spawn token minted for
// it at provision — the Worker resolves the parent from that token, never
// from anything in the request body.

import { buildStudioId, nextFreeInstance, parseStudioId } from "./ids";
import { fetchOrgCached, fetchFleetJsonCached, hashSpawnToken, maySpawn, type Org } from "./org";
import { FLEET_JSON_PATH, FLEET_JSON_DEFAULT_REF, ORG_JSON_PATH } from "./provision";
import { doClassForRole } from "./container-class";
import type { ProvisionConfig, StudioStatus } from "./types";

/**
 * R-P3-7: the machine surface's credential. Spawn calls originate inside
 * containers, which hold no Access service token and sit outside the Access
 * app's `/studio` path scope — so /fleet/spawn is authenticated by this
 * header alone. Header names are case-insensitive per the Fetch spec, and
 * `Headers.get` normalises, so the casing here is cosmetic (it matches what
 * container/studio-fleet will send).
 */
export const SPAWN_TOKEN_HEADER = "X-Fleet-Spawn-Token";

/**
 * The parent identity recorded on an operator-initiated spawn (POST
 * /studio/spawn, behind Access). Not a studio id — the human has no studio —
 * so it is also the role name looked up in org.json's `edges`, which is what
 * lets the operator's own spawn rights be declared in the same file, in the
 * same shape, as every agent's.
 *
 * Review round 1, Important 1: because this doubles as a ROLE name, it is
 * also a name a studio could legitimately be provisioned into —
 * `websites--operator` is a perfectly valid studio id. resolveSpawnParent
 * therefore refuses to resolve any token to a parent with this role: the
 * operator's edges are the human's, and a machine token must never inherit
 * them. Enforced now, before Task 3 adds the `operator` edge to the real
 * org.json and makes the collision live.
 */
export const OPERATOR_ID = "operator";

// `fsp_` + exactly 64 lowercase hex — the exact shape org.ts's mintSpawnToken
// produces, nothing looser.
const SPAWN_TOKEN_RE = /^fsp_[0-9a-f]{64}$/;

/**
 * Shape gate applied to the presented header BEFORE it is hashed. Two
 * reasons, and only the second is about security:
 *   - a mistyped/empty/absent header costs one regex instead of a SHA-256
 *     and a full registry scan;
 *   - it keeps the hash comparison downstream honest. The stored value is a
 *     digest the caller cannot steer, which is why a plain `===` on hex is
 *     the right compare there (see hashSpawnToken's own doc comment) — but
 *     that argument only holds for inputs that actually go through the
 *     digest. Rejecting everything that is not token-shaped means the only
 *     values ever hashed are ones with 32 bytes of entropy behind them.
 */
export function isSpawnTokenShaped(raw: string | null): raw is string {
  return raw !== null && SPAWN_TOKEN_RE.test(raw);
}

// Fleet Spawn P3, Task 4 (R-P3-3): the spec's own default (100 studios fits
// default account limits — see the design doc's own math). Exported so both
// call sites (routes.ts's direct-provision cap and this file's own runSpawn)
// and the test suite reference the SAME number rather than a re-typed copy.
export const DEFAULT_MAX_STUDIOS = 100;

/** Issue #81: what the cap counts. A `stopped` row (destroy keeps it) runs no
 *  container; 62 of them held a fleet at 100/100 with 3 studios running. */
export function liveStudioCount(rows: StudioStatus[]): number {
  return rows.filter((r) => r.state !== "stopped").length;
}

/**
 * Parses `env.MAX_STUDIOS` into the fleet-wide studio cap. Defensive by
 * design, same posture as every other env-sourced numeric this codebase
 * parses (e.g. do.ts's syncDeps `Number(env.BURN_ALERT_OUTPUT_TOKENS_5H ??
 * "0")`) taken one step further: a cap is a SAFETY limit, so a malformed
 * value must fail toward the safe default, never toward "no cap at all" —
 * `Number("")` is `0`, which would 409 every future spawn/provision
 * forever, and a negative or non-integer value is nonsensical as a count.
 * Absent is the ordinary case (no `vars` entry — see Env.MAX_STUDIOS's own
 * doc comment) and returns the default silently; anything PRESENT but
 * unusable is logged so a typo'd `vars` entry doesn't fail silently into a
 * cap nobody chose.
 */
export function resolveMaxStudios(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_STUDIOS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`MAX_STUDIOS="${raw}" is not a positive integer — using default ${DEFAULT_MAX_STUDIOS}`);
    return DEFAULT_MAX_STUDIOS;
  }
  return n;
}

/** Who the Worker decided is asking. Never built from request-body fields. */
export interface SpawnParent {
  /** Studio id, or OPERATOR_ID. Recorded as the child's `spawnedBy`. */
  id: string;
  /** Repo segment the child id is derived from — the parent's own. */
  repo: string;
  /** Role looked up on the left-hand side of org.json's `edges`. */
  role: string;
  /**
   * Dynamic repo selection (P4a): the full `owner/repo` the CHILD will
   * clone. Absent means the fleet default (runProvision's own fallback) —
   * which is every studio that predates this feature.
   *
   * For /fleet/spawn this is INHERITED from the calling studio's own
   * registry row, never taken from the request: a container must not be
   * able to point its child at a repo the Worker did not already bind its
   * parent to. For /studio/spawn it is whatever repo.ts's resolveWorkRepo
   * verified for the operator — the two spawn routes differ in where the
   * parent comes from, and this field follows the same rule.
   */
  repoSlug?: string;
}

export interface SpawnDeps {
  /** Registry rows (registry.ts's listStudios) — the parent lookup's haystack
   *  and the child-exists check's source of truth. */
  listStudios: () => Promise<StudioStatus[]>;
  /** org.json + fleet.json's role list at the blueprint's pinned ref — see
   *  resolveSpawnPolicy below for the real wiring. Throwing is a meaningful
   *  outcome (503, never a silent allow). */
  fetchPolicy: () => Promise<SpawnPolicy>;
  /** The EXISTING provision path (R-P3-2: "no new provisioning machinery"):
   *  routes.ts wires this to `getStudioStubForRow(env, {id: childId,
   *  doClass: doClassForRole(cfg.role)}).provision(cfg)` — a spawn always
   *  allocates a FRESH id, so there is no recorded row to defer to yet
   *  (issue #107: which STUDIO/STUDIO_BIG namespace the child's own role
   *  resolves to going forward — see profile.ts). */
  provisionChild: (childId: string, cfg: ProvisionConfig) => Promise<StudioStatus>;
  /**
   * P4a-2 (brief pickup): the board read that turns `{task: <n>}` into the
   * brief block a child studio boots with. Injected rather than called
   * directly for the same reason every other dependency here is — this file
   * imports no `Env` and makes no network call of its own. routes.ts wires it
   * to src/board/routes.ts's briefPromptResolver.
   *
   * Required, not optional: a spawn route that could silently forget to wire
   * this would answer "spawned" to a task-bearing request and hand the studio
   * nothing, which is the exact failure this feature exists to remove.
   */
  resolveBrief: (studioId: string, repoSlug: string | undefined, task: number) =>
    Promise<{ ok: true; value: string } | { ok: false; status: number; message: string }>;
  /**
   * Phase 2, task 4: the "studio spawned" arm of the design spec's re-arm
   * list. A spawn is the one re-arm trigger that produces no GitHub delivery
   * of its own — a task assignment, a PR and an operator wake all arrive
   * through some other path, so without this a fleet that went quiescent and
   * then grew a new studio would stay unsupervised until something touched
   * the board.
   *
   * Required, not optional, for the same reason `resolveBrief` above is: a
   * wiring that could be silently forgotten would leave the fleet
   * unsupervised with nothing to say so.
   */
  notifyMaestro: (studioId: string, prompt: string) => Promise<void>;
  /**
   * Fleet Spawn P3, Task 4 (R-P3-3): the resolved fleet-wide cap
   * (`resolveMaxStudios(env.MAX_STUDIOS)` — see that function's own doc
   * comment). Resolved once per request by routes.ts's `spawnDeps`, not
   * re-read from `env` on every call inside this file — this file imports
   * no `Env` (see this file's own header: "nothing in this file ... touches
   * `env`"), so the parsed number is the only shape the cap can cross that
   * boundary in.
   */
  maxStudios: number;
  /**
   * Issue #296: claim `childId` atomically before anything is provisioned
   * (routes.ts wires it to registry.ts's claimStudioRow, a D1
   * insert-if-absent). Resolves to the claim's release, or null when another
   * spawn already holds the id. Reading the registry and then creating was
   * not atomic: two concurrent `"next"` spawns both allocated `--2` and the
   * idempotent DO provision gave two tasks one lead.
   */
  claimStudioId: (childId: string, placeholder: StudioStatus) => Promise<(() => Promise<void>) | null>;
}

/**
 * Resolves the calling studio from the token it presented: shape-check,
 * hash, then find the registry row whose stored `spawnTokenHash` matches.
 * `null` means "not authenticated" for every distinguishable reason —
 * absent, malformed, unknown, a matched row whose id is not a parseable
 * `<repo>--<role>`, or one whose role is the operator literal — deliberately
 * collapsed into one outcome so the 401 body cannot be used to probe which
 * tokens exist.
 *
 * A registry scan, not a per-request fan-out to every StudioDO: rows are
 * already read as one D1 query for `fleet ls`/the grid, and asking each DO
 * for its own token would be one RPC per studio per spawn call (100 at
 * R-P3-3's scale) AND would put the raw token on the wire repeatedly.
 */
export async function resolveSpawnParent(
  rows: StudioStatus[], presented: string | null,
): Promise<SpawnParent | null> {
  if (!isSpawnTokenShaped(presented)) return null;
  const hash = await hashSpawnToken(presented);
  // The truthiness guard is load-bearing, not decorative: a registry row
  // written before this field existed parses back from D1 with
  // `spawnTokenHash` ABSENT — `undefined`, not `null` — and `undefined ===
  // hash` is false only because `hash` is always a 64-char string. Stating
  // the invariant here means a future change to what `hash` can be (an empty
  // string from a bug, say) cannot silently turn every legacy row into a
  // wildcard match.
  const row = rows.find((r) => Boolean(r.spawnTokenHash) && r.spawnTokenHash === hash);
  if (!row) return null;
  const id = parseStudioId(row.id);
  if (!id) return null;
  // Review round 1, Important 1 — namespace collision. See OPERATOR_ID.
  if (id.role === OPERATOR_ID) {
    console.error(`spawn: refusing to resolve ${row.id} — a studio may not hold the operator role`);
    return null;
  }
  // Dynamic repo selection (P4a): the child inherits the parent's own bound
  // repo. `null` (a pre-P4a row) reads as `undefined` — "the fleet default"
  // — which is exactly what that studio was cloned from.
  return { id: row.id, repo: id.repo, role: id.role, repoSlug: row.repoSlug ?? undefined };
}

/**
 * Everything a spawn decision needs from the blueprint. Two files, because
 * they answer two different questions and can disagree:
 *   - `org` (org.json) — MAY this parent create this role?
 *   - `roles` (fleet.json) — is this role something this fleet can actually
 *     run at all?
 * Review round 1, Important 2: the shipped pair is already inconsistent
 * (org edges `cto -> [release, qa, dev]`, fleet.json `roles: ["pilot",
 * "scratch"]` as of Task 4 — release/qa/dev/cto remain undeclared there), so
 * this is not a hypothetical. See fleet/blueprint/README.md for the
 * coherence rule this inconsistency is measured against: declared roles are
 * the roles with files, org edges are free to lead future work.
 */
export interface SpawnPolicy {
  org: Org;
  /** fleet.json's declared roles — the same list provision's own
   *  assertRoleInFleet checks against, read here so an undeclared role is
   *  refused BEFORE a container is ever started. */
  roles: string[];
}

/**
 * Resolves the spawn policy the way provision.ts already resolves the role
 * file: read fleet.json from the TARGET repo at its default branch
 * (fleet.json is the thing that names the pinned ref, so there is nothing to
 * resolve it with), then read org.json from the blueprint repo at
 * fleet.json's own `blueprint.ref`. Never at a caller-supplied ref — a spawn
 * request that could choose which org chart it is judged against would not
 * be an org chart.
 *
 * BOTH halves now go through org.ts's cache (5 min TTL, stale-on-error,
 * 60s never-successful backoff floor — org.json via fetchOrgCached,
 * fleet.json via fetchFleetJsonCached). fleet.json used to be read live on
 * every call, deliberately — the reasoning was "one small read per spawn
 * call, and caching it would pin the ref against exactly the change an
 * operator makes to move the fleet forward" — but that argument assumed
 * every caller was Access-gated and human-paced (POST /studio/spawn).
 * Fleet Spawn P3, Task 4 (R-P3-3, review carry from Task 2's I4): /fleet/spawn
 * is neither — it is network-reachable and authenticated by a token a
 * CONTAINER holds, so an uncached fleet.json read amplifies against the
 * shared GitHub installation's rate limit exactly the way an uncached
 * org.json read would (Task 2's own carry, already closed for org.json).
 * The tradeoff this cache accepts is the same one org.json's own cache
 * already made: `roles` (and the blueprint ref/repo) can lag a fleet.json
 * edit by up to the TTL, not take effect on the very next spawn call.
 */
export async function resolveSpawnPolicy(
  fetchFile: (repo: string, path: string, ref: string) => Promise<string>, targetRepo: string,
): Promise<SpawnPolicy> {
  const fleet = await fetchFleetJsonCached(
    { fetchFleetJsonFile: (repo: string, ref: string) => fetchFile(repo, FLEET_JSON_PATH, ref) },
    targetRepo, FLEET_JSON_DEFAULT_REF,
  );
  const org = await fetchOrgCached(
    { fetchOrgFile: (ref: string) => fetchFile(fleet.blueprint.repo, ORG_JSON_PATH, ref) },
    fleet.blueprint.ref,
  );
  return { org, roles: fleet.roles };
}

/**
 * The spawn itself, shared verbatim by both routes — only the `parent`
 * differs (token-resolved for /fleet/spawn, the OPERATOR_ID literal for
 * /studio/spawn). Callers have already authenticated and parsed the body;
 * this owns everything from validating the requested role onward.
 *
 * Order is deliberate: role validity (cheap, no I/O) -> org edge -> role
 * declared in fleet.json -> exists. The edge check comes FIRST of the three
 * policy checks so a caller with no right to spawn a role cannot use the
 * 403/400/409 differences to enumerate either fleet.json's roles or which
 * studios the fleet is running.
 */
/**
 * The `instance` request field — issue #269's whole wire surface.
 *
 * Three accepted values, and each one means something a caller actually
 * needs:
 *   - ABSENT: instance 1. Byte-for-byte the pre-#269 behaviour, including the
 *     409 when that studio already exists, which is what makes every existing
 *     caller (`fleet spawn <role>`, `ff <role>`, container/studio-fleet, every
 *     test) unchanged by this feature.
 *   - `"next"`: the Worker allocates the lowest free instance. Used by
 *     `fleet spawn <role> --new`, which wants a studio and does not care which
 *     number it gets — one round trip, and the answer comes back on the row.
 *   - a positive integer: that exact instance, 409 if taken. Used by
 *     `ff <role> --new "<task>"`, which has to know the id BEFORE it spawns
 *     (the task is assigned to it by label, and runSpawn verifies the label
 *     names the child it is building), so it allocates client-side off the
 *     listing it already fetched and lets the 409 settle any race.
 *
 * `null` out means "malformed" — a float, a zero, a negative, a numeric
 * string, any other string. Never coerced: `instance: "2"` from a caller that
 * forgot to parse its own argv is a bug worth a 400, not a studio.
 */
export function readInstanceRequest(body: unknown): number | "next" | null {
  const raw = (body as { instance?: unknown } | null)?.instance;
  if (raw === undefined || raw === null) return 1;
  if (raw === "next") return "next";
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return null;
  return raw;
}

/** Issue #296: how many numbers a `"next"` spawn tries after losing races. */
const MAX_CLAIM_ATTEMPTS = 20;

export async function runSpawn(deps: SpawnDeps, parent: SpawnParent, body: unknown): Promise<Response> {
  const requested = (body as { role?: unknown } | null)?.role;
  if (typeof requested !== "string" || requested.length === 0) {
    return new Response("bad role", { status: 400 });
  }
  // parseStudioId is the id grammar's single source of truth — deriving the
  // child id and validating the role are therefore the same step. It also
  // rejects a role that smuggles the `--` delimiter (`release--extra` would
  // otherwise produce an id that parses back to a DIFFERENT repo/role pair
  // than the one this request was authorised for); the explicit `role`
  // comparison pins that property rather than leaving it implied by the
  // regex.
  //
  // Issue #269 keeps this check exactly as load-bearing as it was: `requested`
  // must be a BARE role, so `pilot--2` in the `role` field is a 400 rather
  // than an instance smuggled past the org chart. An instance is named by the
  // `instance` field below and nowhere else, which is what lets
  // `maySpawn(org, parent.role, requested)` stay a judgment about ROLES with
  // no changes at all — every instance inherits its role's own edges.
  const roleProbe = parseStudioId(buildStudioId({ repo: parent.repo, role: requested }));
  if (!roleProbe || roleProbe.role !== requested) return new Response("bad role", { status: 400 });

  // Shape-checked here, resolved to a number after `rows` is read below: an
  // `instance` a caller spelled wrong costs no org.json fetch and no registry
  // scan, the same cheapest-check-first discipline the rest of this function
  // follows.
  const wanted = readInstanceRequest(body);
  if (wanted === null) {
    return new Response(
      `bad instance ${JSON.stringify((body as { instance?: unknown }).instance)} — ` +
      'expected a positive integer or "next"',
      { status: 400 },
    );
  }

  // Issue #269 round 2: maestro is a SINGLETON role. A repo has exactly one
  // maestro — wake-events.ts's own maestroIdFor always builds the bare
  // two-segment id, and do.ts's isMaestro() (the sweep gate) only recognizes
  // instance 1 — so a second `x--maestro--2` would run a second, unwoken
  // sweep loop nothing ever talks to. Refused here, before any org.json
  // fetch, same cheapest-check-first order the rest of this function keeps.
  if (requested === "maestro" && wanted !== 1) {
    return new Response('maestro is a singleton role — no "--new" instance', { status: 409 });
  }

  let policy: SpawnPolicy;
  try {
    policy = await deps.fetchPolicy();
  } catch (err) {
    // Static body, and a 503 rather than a 500: the org chart is temporarily
    // unreachable, the request is not wrong, and retrying later is the right
    // client behaviour. The caught error can carry an upstream GitHub message
    // (and, on some failures, a token) — it is logged server-side only, the
    // same posture routes.ts's paste write-failure branch already takes.
    // org.ts's own per-ref backoff is what stops a caller that ignores this
    // from turning a broken pin into unbounded outbound GitHub traffic.
    console.error(`spawn: org.json unavailable for ${parent.id}`, err);
    return new Response("org unavailable", { status: 503 });
  }

  if (!maySpawn(policy.org, parent.role, requested)) {
    return new Response("spawn not permitted by org chart", { status: 403 });
  }

  // Review round 1, Important 2: org.json can edge a role that fleet.json
  // never declared. Provisioning one anyway used to start a real container
  // and only degrade afterwards (provision's own assertRoleInFleet fires
  // after the clone), i.e. a billable studio that could never work and that
  // an operator then has to find and tear down. Refused here instead, with a
  // 400 that names both halves of the mismatch — the caller can do nothing
  // about it, but the human reading the studio's terminal can.
  if (!policy.roles.includes(requested)) {
    return new Response(
      `role "${requested}" is not declared in fleet.json roles [${policy.roles.join(", ")}] — ` +
      "the org chart allows this spawn but the fleet cannot run it; add the role to fleet.json",
      { status: 400 },
    );
  }

  const rows = await deps.listStudios();
  // Issue #269. The instance is resolved HERE, against the rows the two checks
  // below already read, and it is the only thing about this request that
  // depends on what the fleet is currently running.
  //
  // `"next"` means "the lowest free instance for this repo+role", which on a
  // role with nothing running at all is instance 1 — the ordinary
  // `<repo>--<role>` id, with no suffix. `--new` is an opt-in to FINDING a
  // free slot, not a demand for a second one, so it never leaves a hole at 1.
  // Absent means instance 1 explicitly, which is the pre-#269 behaviour: the
  // 409 below still refuses when that id is taken.
  let instance = wanted === "next"
    ? nextFreeInstance(rows.map((r) => r.id), parent.repo, requested)
    : wanted;
  const child = parseStudioId(buildStudioId({ repo: parent.repo, role: requested, instance }));
  // Unreachable with a validated role and a validated instance, and checked
  // anyway: this is the one place an id is minted from three separately
  // validated parts, and a 400 here beats provisioning a studio whose id the
  // rest of the fleet cannot parse back.
  if (!child) return new Response("bad instance", { status: 400 });
  // Fleet Spawn P3, Task 4 (R-P3-3): the fleet-wide cap, checked here rather
  // than inside provision so it governs every entry point that creates a
  // studio (routes.ts's direct POST /studio/:id/provision runs the
  // equivalent check itself, right before its own DO dispatch). The brake
  // this comment used to describe — wrangler.jsonc's `max_instances` on the
  // StudioDO container class, alone, with no app-level check at all — is
  // gone: that value is now raised to match DEFAULT_MAX_STUDIOS (5 -> 100,
  // same commit that added this check) and demoted to a platform-level
  // backstop UNDER this one, not the only brake. A route-level 409 like this
  // is strictly better than the old failure mode (max_instances refusing the
  // CONTAINER produced a degraded studio, not a clean rejection) — this
  // check is what makes that the normal case again, not just the rare one.
  const live = liveStudioCount(rows);
  if (live >= deps.maxStudios) {
    return new Response(
      `fleet is at capacity (${live}/${deps.maxStudios} live studios) — cannot spawn "${child.full}"`,
      { status: 409 },
    );
  }
  if (rows.some((r) => r.id === child.full)) return new Response("studio exists", { status: 409 });

  // Issue #296: the registry read above is a snapshot, not a lock. The id is
  // CLAIMED atomically (claimStudioId: a D1 insert-if-absent of the child's
  // own registry row). `"next"` that loses a race moves on to the next number;
  // an explicit instance that loses answers the same 409 as the check above.
  let release: (() => Promise<void>) | null = null;
  let target = child;
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    release = await deps.claimStudioId(target.full, {
      id: target.full, state: "provisioning", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: parent.id, spawnTokenHash: null,
      repoSlug: parent.repoSlug ?? null,
      // Issue #107 follow-up: this IS a first-ever write for `target.full`'s
      // row (see StudioStatus.doClass's own doc comment) — provision.ts's
      // freshStatus is not the only one. Stamped here, from the same pure
      // doClassForRole(role) provisionChild will call moments later on the
      // identical role, so a reader that hits this placeholder before the
      // DO's own write lands (getStudioRow/getStudioStub, mid-spawn) still
      // resolves the right namespace instead of falling back to the default.
      doClass: doClassForRole(target.role),
    });
    if (release !== null || wanted !== "next") break;
    instance = target.instance + 1;
    const next = parseStudioId(buildStudioId({ repo: parent.repo, role: requested, instance }));
    if (!next) return new Response("bad instance", { status: 400 });
    target = next;
  }
  if (release === null) return new Response("studio exists", { status: 409 });
  const claimed = target;
  const releaseClaim = release;

  // P4a-2: the brief, resolved LAST — after every policy check and the
  // exists check, immediately before the container is built. A board read
  // spent on a request that was going to 403 or 409 anyway is wasted, and
  // this ordering also means a task that turns out not to belong to the child
  // refuses BEFORE anything is provisioned rather than after.
  //
  // The studio id checked against the task's assignment label is `claimed.full`
  // — derived here, from the parent's own repo segment and the requested
  // role. A caller names a task NUMBER and nothing else; it cannot name the
  // studio the task is checked against, so it cannot hand a child a task
  // belonging to some other studio.
  let briefPrompt: string | undefined;
  const requestedTask = (body as { task?: unknown } | null)?.task;
  if (requestedTask !== undefined && requestedTask !== null) {
    if (typeof requestedTask !== "number" || !Number.isInteger(requestedTask) || requestedTask <= 0) {
      await releaseClaim();
      return new Response(`bad task ${JSON.stringify(requestedTask)} — expected a positive issue number`, { status: 400 });
    }
    const brief = await deps.resolveBrief(claimed.full, parent.repoSlug, requestedTask);
    if (!brief.ok) {
      await releaseClaim();
      return new Response(brief.message, { status: brief.status });
    }
    briefPrompt = brief.value;
  }

  // `instance` rides the config because provision.ts and do.ts rebuild the id
  // from it (buildStudioId over cfg) rather than being handed `claimed.full`.
  // Omitting it would silently provision instance 1's container under instance
  // N's row.
  //
  // Omitted rather than set to 1 on the ordinary path, the same discipline
  // routes.ts's `projectCard` already follows: absent means 1 to every reader,
  // so an instance-1 spawn sends the byte-identical RPC payload it sent before
  // issue #269 existed.
  let status: StudioStatus;
  try {
    status = await deps.provisionChild(claimed.full, {
      repo: claimed.repo, role: claimed.role,
      ...(claimed.instance === 1 ? {} : { instance: claimed.instance }),
      spawnedBy: parent.id, repoSlug: parent.repoSlug, briefPrompt,
    });
  } catch (err) {
    // A provision that threw may have left nothing but the placeholder: free
    // the id (the release never touches a row provision itself wrote).
    await releaseClaim();
    throw err;
  }
  // AFTER the child is up, and never before: a wake that announced a studio
  // whose provision then failed would put maestro to work on something that
  // does not exist. A maestro is never woken with its own spawn.
  //
  // Swallowed on failure, deliberately: a spawn is not undone by an
  // unreachable maestro, and the 20-minute sweep re-detects the new studio
  // regardless. The response the caller gets is the child's status either way.
  if (claimed.role !== "maestro") {
    try {
      await deps.notifyMaestro(
        // A repo has ONE maestro — a singleton role — so this is always the
        // bare two-segment id, whatever instance the child is.
        buildStudioId({ repo: claimed.repo, role: "maestro" }),
        `WAKE EVENT(studio.spawned) ${claimed.full} spawned by ${parent.id} state=${status.state}` +
        (briefPrompt === undefined ? "" : ` task=#${String(requestedTask)}`),
      );
    } catch (err) {
      console.error(`spawn: maestro wake failed for ${claimed.full}`, err);
    }
  }
  return Response.json(status);
}
