// Pure provisioning/status logic — deliberately split out of do.ts, for the
// same reason src/agents/do.ts extracts pollOnce/pollAndClearRearm and
// src/deploy/do.ts extracts advanceDeploy: the DO-bound method itself cannot
// be exercised under vitest-pool-workers. StudioDO is container-backed, and
// `env.STUDIO.get(...).fetch(...)` throws "Containers have not been enabled
// for this Durable Object class" (docs/fleet/README.md's "Known gap":
// `@cloudflare/vitest-pool-workers` hardcodes `enableContainers: false`, so
// `ctx.container` is always undefined). Anything left inside the class is
// therefore untested; do.ts keeps only one-line wrappers, and this file holds
// everything worth asserting on.
//
// HISTORICAL (Task 4), resolved by Task 5's Step 0 — kept because the failure
// mode is subtle enough to be worth recognising if the toolchain ever moves
// backwards: `@cloudflare/sandbox`'s bundle does a top-level `import
// { tracing } from "cloudflare:workers"`. The then-pinned test-pool runtime
// (miniflare 4.20260310.0 / workerd 1.20260310.1) had no such export, so
// MERELY importing "@cloudflare/sandbox" threw `SyntaxError: The requested
// module 'cloudflare:workers' does not provide an export named 'tracing'` the
// moment any test's module graph reached it — before any DO construction,
// independent of `enableContainers`, and independent of which named export
// was requested, since ESM executes the whole module body regardless. That
// made do.ts unimportable from any test and blocked `export { StudioDO }`
// from index.ts (which broke all 22 test files at the time). Step 0 upgraded
// the pool to workerd 1.20260730.1, the first version that both provides
// `tracing` and supports this project's compatibility_date — see
// task-5-report.md for the bisect. StudioDO is exported from index.ts now,
// which real `wrangler deploy` requires in order to boot.
//
// test/studio.routes.test.ts still wires a fake StudioDO stub whose
// provision/getStatus/restartStudio call the *WithStorage functions below —
// the SAME functions do.ts's real methods are one-line wrappers around, not
// a hand-copied re-implementation of the storage read/write sequence (see
// the StudioStorage port below — review round 2, Important 2) — over an
// in-memory StudioStorage fake and a `vi.fn()` sbExec.
import { memoryCloneCmd, MEMORY_REF, MEMORY_TOKEN_ENV } from "../memory/store";
import type { ProvisionConfig, StudioStatus } from "./types";
import { redactSecrets } from "./redact";
import { DenylistDialectError, LEAK_DENYLIST_PATH, OPS_DENYLIST_PATH, denylistFileContent, parseDenylist } from "../leak-gate";
import { isDeadlineExit, KILL_GRACE_SECONDS } from "./exec-deadline";
import { ghBlockCmd } from "./gh-wrapper";
import { writeProxyConfigCmd } from "../write-proxy/container-config";
import { STUDIO_TMUX, withStudioTmux } from "./tmux";
// Issue #38: a restart has only the studio ID to work from, and the repo
// segment of that id IS the checkout directory under /workspace. ids.ts
// imports nothing, so there is no cycle.
import { buildStudioId, parseStudioId } from "./ids";
import { repoIdSegment } from "./repo";
import { parseFleetJson, parseRoleFile, assertRoleInFleet, roleBringupEnv } from "./blueprint";
import { parseStudioFile, validateMemberFile, studioBringupEnv, type Studio, type MemberFile } from "./studio-blueprint";
import { restorePlan, sessionDailyPrefix, dailyKeeperKeys, SESSION_FORCE_KEY, type RestoreAction } from "./session-sync";
import { sessionStats, newestMark, SessionArchiveFormatError, type SessionMark } from "./burn";
import { MEMORY_INDEX_PATH } from "../memory/index-file";
import { memoryIndexPrompt } from "../memory/prompt";
import { sessionLatestKey, SESSION_SINGLE_READ_MAX } from "./archive";
import { runInstallCacheRestore, type InstallCacheRestoreDeps } from "./install-cache";
import {
  computeSessionVerdict, bringupObservationCmd, parseBringupObservation, getObserved,
  type ObservedStorage, type BringupVia, type PaneProbeResult, type RestoreOutcome, type Observed,
  type ObservedSession,
  mergeObserved, bringupLeftLeadUntouched, resolveSnapshotAge,
} from "./observed";
import { JUNIOR_HOUSE_RULE } from "../junior/gate";
import { rescuePushPrelude, type RescuePushOptions, type RescueTarget } from "./rescue";

/**
 * Dependency seam — mirrors src/agents/do.ts's `LoopDeps`/src/deploy/do.ts's
 * `DeployDeps`. `sbExec` stands in for the whole sandbox exec layer (the
 * "sandbox mocked" half of the brief's test design); `recordStudio` and
 * `now` are injected for the same reason. `fetchBlueprintFile` (Task 11) is
 * the one network dependency this feature has beyond the sandbox itself —
 * do.ts wires it to a fresh per-owner credential (github/auth.ts's
 * repoTokenMinter) + github/api.ts's
 * fetchRepoFile; tests inject a canned fake. `runRestart` never calls it
 * (restart has no ProvisionConfig to resolve a role/ref from — see
 * runProvision's own header for why blueprint resolution is provision-only),
 * so it's an unused-but-required field on that path. `sbExec`'s `env` param
 * IS used by restart as of Task 12: it forwards the role env provision
 * persisted, rather than re-resolving one.
 */
// Board #350: `installCacheEnabled`/`installCachePresignGet` (both optional,
// same "absence means behave exactly as today" contract every port since
// Task 3 already follows) arrive via this extension rather than being
// redeclared here — install-cache.ts's own InstallCacheRestoreDeps doc
// comment is the one place their contract is documented; `sbExec` above and
// the extended interface's own `sbExec` are the identical signature, so
// nothing about the existing field changes.
export interface ProvisionDeps extends InstallCacheRestoreDeps {
  sbExec: (cmd: string, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  recordStudio: (status: StudioStatus) => Promise<void>;
  now: () => string;
  /**
   * Task 7: also reused, unmodified, to LIST a directory (a studio's
   * `members/`) — verified live against api.github.com: the Contents API
   * returns the same JSON array for a directory path regardless of the raw
   * media type fetchRepoFile always requests (that media type only alters a
   * FILE response; a directory response ignores it). One function, two
   * result shapes depending on what path it's pointed at, same as the real
   * GitHub endpoint it wraps.
   */
  fetchBlueprintFile: (repo: string, path: string, ref: string) => Promise<string>;
  /**
   * Issue #341: the memory store (FLEET_OPS_REPO, src/memory/store.ts), or
   * null/absent when memory is off. The provision index is read from it (at
   * MEMORY_REF), and it is cloned for the lead at MEMORY_CLONE_DIR.
   */
  memoryRepo?: string | null;
  /** Issue #341: a token that can read `memoryRepo` (usually private). Rides
   *  the clone's exec env only. */
  memoryToken?: (workRepoSlug: string) => Promise<string>;
  /**
   * Issue #330 round 2: the resolved `FLEET_OPS_REPO` slug (resolveOpsRepo's
   * own result), or `null`/absent when unset — `resolveBringupEnv` cannot
   * resolve this itself the way it resolves `fleet.blueprint.repo` (from
   * fleet.json, fetched through this very deps object), because the ops
   * repo is Worker CONFIG (env.ts), not blueprint content, and no other
   * ProvisionDeps port surfaces env. do.ts's `deps()` wires this to
   * `resolveOpsRepo(this.env)`, mirroring exactly how `fetchBlueprintFile`
   * itself is wired to a fresh per-owner credential + github/api.ts's
   * fetchRepoFile just above. Optional for the same reason every other port
   * added after this interface's first task is: every ProvisionDeps literal
   * built before this fix (every existing test fixture) omits it, and its
   * absence MUST mean "off" — `resolveOperatorHouseRules(deps, deps.opsRepo
   * ?? null)` treats `undefined` and `null` identically, so an existing test
   * that never heard of this field keeps getting the neutral house rules
   * default only, exactly as it did before this field existed.
   */
  opsRepo?: string | null;
  /**
   * Junior (Workers AI delegation): true when FLEET_JUNIOR is on for this
   * work repo (src/junior/gate.ts's juniorEnabled). do.ts wires it from env.
   * Optional like opsRepo, and absent means off: every existing fixture keeps
   * getting no junior skill and no junior house rule.
   */
  juniorEnabled?: (workRepoSlug: string) => boolean;
  /**
   * #330 round 4: reads one file of `opsRepo` with a token scoped to that repo
   * and narrowed to contents:read (do.ts's opsFileFetcher). The overlay is
   * read ONLY through this port, never `fetchBlueprintFile`, whose minter
   * hands out the installation's full permissions. Absent = overlay off.
   */
  fetchOpsFile?: (path: string, ref: string) => Promise<string>;
  /**
   * Task 3 (P2 plane 2) — the fresh-container session restore step's R2
   * read (see runSessionRestore below): env.STUDIO_ARCHIVE.get(key) mapped
   * to raw bytes, `null` when the object doesn't exist. Optional — deps
   * built before this task (and every EXISTING test's own ProvisionDeps
   * literal) never supplied it, and runSessionRestore treats its absence
   * exactly like a genuine restore failure: skip silently, log nothing,
   * never touch provisioning's own success/degraded outcome. do.ts's real
   * deps() always supplies it.
   */
  r2Get?: (key: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  /**
   * Issue #94: R2 keys under a prefix — runSessionRestore lists a studio's
   * daily keepers to fall back on when `latest` is poorer. Optional: absent
   * means `latest` only, as before.
   */
  r2List?: (prefix: string) => Promise<string[]>;
  /**
   * Issue #94: after a restore, the newest session file of the snapshot now
   * on the container — do.ts stores it as the sync guard's baseline, so a
   * keeper restore does not leave the guard comparing against the poorer
   * `latest` it replaced (which would displace every later sync). Optional.
   */
  recordRestoredMark?: (mark: SessionMark | null) => Promise<void>;
  /** Same sbWriteFile-shaped port paste.ts's PasteDeps.writeFile uses —
   *  the restore step's transport for each chunked tar part. Optional for
   *  the same reason r2Get is. */
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
  /**
   * Fleet Spawn P3, Task 4 (R-P3-6): do.ts's real wiring is
   * `(keepAlive) => sbSetKeepAlive(this, keepAlive)` — the sandbox-api.ts
   * adapter, called with the RESOLVED role's `keep_alive` (blueprint.ts's
   * `Role.keep_alive`, default true) rather than the unconditional `true`
   * do.ts used to pass directly. Routed through this port, not called
   * inline in do.ts, for the same reason every other SDK-touching effect
   * here is: `runProvision`/`runRestart` are the only place the resolved
   * value ever exists, and they are the only testable half of this feature
   * (do.ts's own `deps()` one-line wiring cannot be exercised under
   * vitest-pool-workers — see this file's header). Optional for the same
   * reason r2Get/writeFile are: existing ProvisionDeps literals built before
   * this task never supplied it, and a provision/restart with no keepAlive
   * port configured simply never toggles it — do.ts's real deps() always
   * supplies it.
   */
  setKeepAlive?: (keepAlive: boolean) => Promise<void>;
  /**
   * The adopted-task fallback (Fleet board task #118 — see resolveBringupEnv's
   * own doc comment for the failure this closes): resolves the board's own
   * `studio:<id>` label to a brief, for the two callers of `resolveBringupEnv`
   * that carry no `cfg.briefPrompt` at all — recycle, and a bodyless
   * re-provision. `(studioId, workRepoSlug) -> prompt | undefined`, `undefined`
   * meaning "no open task carries this studio's label" (or the lookup itself
   * failed) — never a throw. Optional for the same reason r2Get/writeFile/
   * setKeepAlive above are: every ProvisionDeps literal built before this
   * task, including every existing test fixture, never supplies it, and its
   * absence must mean "behave exactly as today" — no board lookup attempted
   * at all, not even a network call. do.ts's real `deps()` wires it to
   * board/routes.ts's `assignedBriefResolver`.
   */
  resolveAssignedBrief?: (studioId: string, workRepoSlug: string) => Promise<string | undefined>;
  /**
   * Board task #149 — the blueprint clone's OWN credential, entirely
   * separate from do.ts's work-repo one (RefreshDeps/refreshDeps()/
   * refreshWithStorage, untouched by this task). `(blueprintRepo, id) ->
   * ok/error`, mint+write already folded into one call the same shape
   * runRefreshCredential (do.ts) returns, because the two call sites below
   * (runProvision/runRestart) react to a failure identically: log and move
   * on, never degrade the studio over it (see maybeWriteBlueprintCredential's
   * own doc comment for why). `id` is passed through only for that log line.
   * Optional for the same reason resolveAssignedBrief/r2Get/writeFile/
   * setKeepAlive above are: every ProvisionDeps literal built before this
   * task, including every existing test fixture, never supplies it, and its
   * absence must mean "behave exactly as today" — no blueprint credential
   * write attempted at all, the same silent-clone-failure posture
   * studio-bringup.sh already ships for a `websites--*`-shaped studio that
   * happens not to need one. do.ts's real `deps()` wires it to
   * blueprintCredentialWriteCmd + mintRepoToken.
   */
  writeBlueprintCredential?: (blueprintRepo: string, id: string, workRepoSlug: string) =>
    Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Issue #253 — the studio git-safety config + the /usr/local/bin/git
   * wrapper (see credentials.ts's `studioGitSafetyCmd` for the mechanism:
   * push.default, branch.autoSetupMerge, and the installed wrapper, one
   * sbExec call). `() -> ok/error`, same union shape as `writeBlueprintCredential`
   * directly above, for the same reason: `applyStudioGitSafety` (this
   * file's wrapper) reacts to a failure identically at both call sites —
   * log and move on, never degrade the studio over it. This is a
   * defense-in-depth safety net alongside the board's own PR-review
   * process, not provisioning's only correctness gate; failing a whole
   * provision over a transient git-config exec would make the studio less
   * available for a strictly auxiliary safeguard. Optional for the same
   * reason writeBlueprintCredential is: every ProvisionDeps literal built
   * before this task, including every existing test fixture, never
   * supplies it, and its absence must mean "behave exactly as today" — no
   * git-safety config applied at all. do.ts's real `deps()` wires it to
   * `studioGitSafetyCmd()`.
   */
  applyStudioGitSafety?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Issue #1: installs the leak scanner + gh wrapper (gh-wrapper.ts's
   * leakGateInstallCmd, one sbExec). Same union as applyStudioGitSafety.
   * Absent = no leak gate step at all (old fixtures); do.ts always wires it.
   */
  installLeakGate?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Issue #1: is the WORK repo private? true = gate off for this studio.
   * false, a throw, or absence = public: the denylist is delivered (fail closed).
   */
  workRepoIsPrivate?: (slug: string) => Promise<boolean>;
  /**
   * Issue #30: where rescue pushes go -- do.ts wires the SAME
   * resolveRescueTarget call its rescue uses, so discovery reads what rescue
   * wrote. `{}`, absence or a throw = origin-only discovery.
   */
  rescueTarget?: (workRepoSlug: string) => Promise<RescueTarget>;
  /**
   * Issue #7: route pushes and gh writes through the Worker. `mode` gets the
   * same visibility answer as the gate above (unknown = public) and decides
   * (write-proxy/mode.ts's writeModeFor). Absent = no step.
   */
  writeProxy?: { workerUrl: string; mode: (slug: string, isPrivate: boolean) => "direct" | "proxy" };
  /**
   * Maestro correction #10 — issue #90 (currently blocked, but also touches
   * `runProvision`/`runRestart` directly) makes widening either function's
   * RETURN type a real conflict risk. Both keep their existing signatures;
   * this optional callback is how a caller (`provisionWithStorage`/
   * `restartWithStorage`, this task's Step 5) learns the restore outcome
   * instead — invoked exactly once, inside each function's EXISTING
   * `runSessionRestore` try/catch, with no other change to either function's
   * control flow. Absent for every existing caller/test, exactly like
   * `r2Get`/`writeFile`.
   *
   * WIRED (board #250, an #85/#118 follow-up): this callback's second
   * argument is `runSessionRestore`'s own `source` ("latest" or "daily
   * <date>" — `pickRestoreSource`'s own doc comment, board #118), forwarded
   * as-is (`restoreResult.source ?? null`) by both call sites below. A keeper
   * restore (`source: "daily <date>"`) reads from a genuinely OLDER snapshot
   * than `latest` by construction, so `recordBringupObservation` (this task's
   * Step 5) now measures ITS snapshot age against the keeper's OWN R2
   * `uploaded` timestamp — read fresh, once, right there — rather than
   * against `Observed.lastSnapshotAt`/`sessionLatestKey`'s, which describe
   * `latest` and nothing else. `null` for every path that predates this: no
   * restore attempted at all, or a restore that never went through
   * `pickRestoreSource` (`deps.r2List` not wired — `runSessionRestore`'s own
   * doc comment) and so carries no `source` to forward.
   */
  onRestoreOutcome?: (outcome: RestoreOutcome, source: string | null) => void;
  /**
   * Maestro correction #8 — R2's own `uploaded` timestamp for a session
   * snapshot object, used ONLY as a fallback inside `recordBringupObservation`
   * (this task's Step 5) when `Observed.lastSnapshotAt` was never recorded
   * yet but a restore genuinely happened. Optional for the same reason every
   * other R2-touching port on this interface is; do.ts's real `deps()`
   * always supplies it once wired.
   */
  r2Head?: (key: string) => Promise<{ uploaded: Date } | null>;
  /**
   * Issue #85 review round 4, NIT 16(a) — `recordBringupObservation`'s
   * combined token-write + pane-probe exec is a short, read-only-ish check,
   * never the bring-up itself; it must not ride `sbExec`'s own EXEC_CLASSES
   * (do.ts's `deps()`'s `sbExec` field wires the whole bring-up under
   * `EXEC_CLASSES.provision`'s 600s budget and default session, sized for
   * BRINGUP_CMD, not a probe). Optional, same "absence = fall back to
   * `sbExec`" idiom every other narrow deps field here uses — do.ts's real
   * `deps()` always supplies it, wired to `EXEC_CLASSES.inspect`.
   */
  observationExec?: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Minimal storage port `runProvision`/`runRestart`/`runGetStatus` are
 * wrapped in below (`*WithStorage`) — a real `this.ctx.storage`
 * (DurableObjectStorage) satisfies this structurally with no cast; tests
 * pass a plain in-memory fake with no SDK import either. Review round 2,
 * Important 2: this is what lets do.ts's real methods and the test's fake
 * StudioDO stub call the EXACT SAME wrapper code, instead of the test
 * hand-copying do.ts's read/compute/write sequence — a copy that could
 * silently drift from the real thing and never get caught.
 *
 * Task 12: this port now holds TWO keys, so its methods are keyed OVERLOADS
 * rather than one `(key: string)` pair. That is what makes
 * `storage.get(ROLE_ENV_KEY)` come back typed `RoleEnv | undefined` and
 * `storage.get(STATUS_KEY)` typed `StudioStatus | undefined` from the same
 * object, with no cast and no `unknown` at either read site — the key
 * literal itself selects the value type. A widened `get(key: string):
 * Promise<StudioStatus | RoleEnv | undefined>` would have forced a cast at
 * every read, i.e. exactly the place a wrong-key bug would stop being a
 * compile error.
 */
export interface StudioStorage {
  get(key: typeof STATUS_KEY): Promise<StudioStatus | undefined>;
  // Task 7: widened RoleEnv -> RoleEnv | StudioEnv — the same key now holds
  // either shape, depending on which branch resolveBringupEnv took. A
  // pre-Task-7 RoleEnv value already in storage still satisfies this union
  // unchanged, so existing pilot/scratch records keep round-tripping with
  // no migration.
  get(key: typeof ROLE_ENV_KEY): Promise<RoleEnv | StudioEnv | undefined>;
  get(key: typeof KEEP_ALIVE_KEY): Promise<boolean | undefined>;
  get(key: typeof HEAL_ATTEMPT_KEY): Promise<HealAttempt | undefined>;
  // Issue #103: `null` is what every finished provision/restart leaves here
  // (put(OPERATION_KEY, null) below), and real DO storage returns it as null,
  // not undefined. Typed so a reader that only rules out undefined no longer
  // compiles.
  get(key: typeof OPERATION_KEY): Promise<OperationInFlight | null | undefined>;
  get(key: typeof DESTROYING_KEY): Promise<string | null | undefined>;
  // Review round 6, MUST-FIX 4 — #129's own onStop record, read here so
  // provisionWithStorage/restartWithStorage can feed `lastStop.at` into
  // resolveSnapshotAge as its first-priority stop-time rung.
  get(key: typeof LAST_STOP_KEY): Promise<LastStop | undefined>;
  // Issue #152: the destroy epoch — see DESTROY_EPOCH_KEY's own doc comment
  // for why this is a monotonically increasing counter, never a boolean.
  get(key: typeof DESTROY_EPOCH_KEY): Promise<number | undefined>;
  // Issue #100: read before every provision — see FRESH_SESSION_PENDING_KEY's
  // own doc comment for what "undefined" vs "true"/"false" mean here.
  get(key: typeof FRESH_SESSION_PENDING_KEY): Promise<boolean | undefined>;
  put(key: typeof STATUS_KEY, value: StudioStatus): Promise<void>;
  put(key: typeof ROLE_ENV_KEY, value: RoleEnv | StudioEnv): Promise<void>;
  put(key: typeof KEEP_ALIVE_KEY, value: boolean): Promise<void>;
  put(key: typeof HEAL_ATTEMPT_KEY, value: HealAttempt): Promise<void>;
  put(key: typeof OPERATION_KEY, value: OperationInFlight | null): Promise<void>;
  put(key: typeof DESTROYING_KEY, value: string | null): Promise<void>;
  put(key: typeof DESTROY_EPOCH_KEY, value: number): Promise<void>;
  // Issue #37: armed by a --fresh-session provision (see provisionWithStorage).
  put(key: typeof SESSION_FORCE_KEY, value: boolean): Promise<void>;
  // Issue #100: see FRESH_SESSION_PENDING_KEY's own doc comment.
  put(key: typeof FRESH_SESSION_PENDING_KEY, value: boolean): Promise<void>;
}

/**
 * The three env vars container/studio-bringup.sh reads to launch claude —
 * the exact shape blueprint.ts's `roleBringupEnv` produces, named here so the
 * persisted record is a fixed triple rather than an open
 * Record<string,string> that could silently gain (or lose) a key.
 * ROLE_EFFORT (Fleet CTO effort default, operator directive 2026-08-19)
 * joined the original pair the same way: always present, an empty string
 * meaning "no override" rather than the key being absent — see
 * roleBringupEnv's own doc comment for how each of the three resolves.
 *
 * A `type`, not an `interface`, on purpose: `deps.sbExec`'s env parameter is
 * `Record<string, string>`, and only a type alias gets TypeScript's implicit
 * index signature — an interface with the identical members is rejected
 * there ("Index signature for type 'string' is missing").
 */
export type RoleEnv = {
  ROLE_PROMPT_B64: string;
  ROLE_ALLOWED_TOOLS: string;
  ROLE_EFFORT: string;
};

/**
 * Task 7: the studio-path counterpart to RoleEnv above — persisted under
 * the SAME ROLE_ENV_KEY (see StudioStorage's own doc comment on that
 * overload) when `<name>` resolves as a studio rather than a role.
 * studio-blueprint.ts's StudioBringupEnv (8 fields) plus BLUEPRINT_REPO —
 * the resolved blueprint repo slug, added here because only provision.ts
 * (via fleet.json) knows it; studioBringupEnv itself never sees a repo,
 * only a parsed Studio + its members.
 *
 * Fields spelled out flat rather than `StudioBringupEnv & { BLUEPRINT_REPO:
 * string }`: verified (bunx tsc) that intersecting with StudioBringupEnv —
 * an interface — does NOT carry through the implicit Record<string,string>
 * index signature deps.sbExec's env param needs; a type alias object
 * literal gets that treatment, an interface (or an intersection touching
 * one) doesn't. Same "a type, not an interface, on purpose" reasoning
 * RoleEnv's own doc comment already gives, applied here too.
 */
export type StudioEnv = {
  ROLE_PROMPT_B64: string;
  ROLE_ALLOWED_TOOLS: string;
  ROLE_EFFORT: string;
  STUDIO_NAME: string;
  STUDIO_SKILLS: string;
  STUDIO_MEMBERS_B64: string;
  STUDIO_MCP: string;
  STUDIO_LEAD_DISALLOWED: string;
  /** Optional on the TYPE, always set by studioBringupEnv: a studio
   *  provisioned before the completion gate existed has a stored env with no
   *  such key, and `restartWithStorage` hands that stored object straight to
   *  bring-up. Bring-up reads it as `${STUDIO_COMPLETION_GATE:-}`, so absent
   *  and "" mean the same thing there — no gate until the next provision
   *  re-resolves the blueprint. */
  STUDIO_COMPLETION_GATE?: string;
  BLUEPRINT_REPO: string;
  /** The blueprint ref this provision resolved (issue #11): bring-up resets
   *  /opt/blueprint onto it every time, so a skill added after the container
   *  booted still resolves. Optional on the TYPE for the same reason as
   *  STUDIO_COMPLETION_GATE: an env stored before this field existed reads as
   *  `${BLUEPRINT_REF:-}`, and bring-up falls back to the remote's HEAD. */
  BLUEPRINT_REF?: string;
};

/** The keys this feature stores. Exported so tests can seed/read storage
 *  through the exact same keys the real wrappers use, instead of duplicating
 *  the strings. */
export const STATUS_KEY = "status";
/**
 * Where provision persists the role env it resolved from the blueprint, so
 * `restartStudio()` — which takes no ProvisionConfig and therefore cannot
 * re-resolve one — can pass the SAME env to bring-up. DO storage is durable
 * across the container recycle that a restart exists to recover from, which
 * is exactly why the answer is storage and not a refetch: a restart must not
 * depend on GitHub being reachable, on a mintable installation token, or on
 * the blueprint ref still existing at restart time.
 */
export const ROLE_ENV_KEY = "roleEnv";
/**
 * Fleet Spawn P3, Task 4 (R-P3-6): where provision persists the RESOLVED
 * role's `keep_alive` (blueprint.ts's `Role.keep_alive`), for the same
 * restart-must-not-refetch reason ROLE_ENV_KEY exists — see that constant's
 * own doc comment. A separate key rather than folded into `RoleEnv`: that
 * type is deliberately the fixed pair container/studio-bringup.sh's env
 * contract needs (see RoleEnv's own doc comment — "a fixed pair ... that
 * could silently gain (or lose) a key"), and a boolean is not a bring-up env
 * var at all.
 */
export const KEEP_ALIVE_KEY = "keepAlive";

/**
 * Issue #71: the one-heal-per-bare-episode marker.
 *
 * An image rollout replaces every running container. Some come back BARE --
 * /workspace empty, pane at a bare bash. #38 shipped the heal (a second
 * bring-up) INSIDE runRestart, and nothing ever called runRestart on a
 * replaced container, so it never fired: the readiness tick saw `bare` every
 * 300s and did nothing with it. Measured 2026-09-24 across `fleetflare--`,
 * `acme-os--`, `websites--` and `sample--` studios simultaneously, all
 * healed by hand, one `fleet provision` at a time.
 *
 * `armed` is what makes the heal fire AT MOST ONCE per episode. A studio
 * that is bare for a real reason -- a broken image, a repo that no longer
 * exists -- would otherwise restart itself every tick forever, which is a
 * container billing in a loop with nobody watching. The marker is set before
 * the heal runs and cleared only by a LATER `provisioned` verdict, so:
 *
 *   bare -> heal, arm        (one restart)
 *   bare -> armed, stand down (silence, but the row still says bare)
 *   provisioned -> disarm     (a future bare episode may heal again)
 *
 * Stored, never derived: the tick is the only thing that runs, the DO is the
 * only thing that persists, and a marker in memory would be lost by exactly
 * the eviction that precedes most of these episodes.
 */
export const HEAL_ATTEMPT_KEY = "healAttempt";

/**
 * Issue #86: the in-flight lock that makes the heal's "an operation is
 * already running" guard real.
 *
 * `decideHeal` refuses to heal a studio in state `provisioning`, on the
 * stated reasoning that a provision already in flight will speak for itself.
 * That guard was VACUOUS, and an adversarial re-read proved it unanimously:
 * `runProvision` and `runRestart` build `state: "provisioning"` as a LOCAL
 * variable, and STATUS_KEY is written only AFTER they return
 * (provisionWithStorage / restartWithStorage). So for the whole multi-minute
 * clone-and-bring-up the STORED row still reads `running`.
 *
 * Nothing serializes the alarm against the RPC either: StudioDO uses
 * `blockConcurrencyWhile` only in its constructor, and a Durable Object's
 * input gate is open across every non-storage await -- which is what every
 * `sbExec` in a provision is. So the syncSession tick fires mid-provision,
 * the readiness check answers `bare` (the clone has not landed yet), the
 * stale row says `running`, and the heal starts a SECOND bring-up racing the
 * operator's own. Two clones into one directory, two `send-keys` into one
 * pane, and the episode's single heal attempt spent fighting the operator.
 *
 * So the lock is written to storage BEFORE the work and cleared in a
 * `finally`, which is the only shape that survives a throw.
 *
 * It carries a timestamp because a lock that cannot go stale is worse than no
 * lock: an isolate evicted mid-provision would leave it set forever and the
 * studio could never heal again -- the exact permanent-disable failure #81
 * had just removed from the state gate.
 */
export const OPERATION_KEY = "operationInFlight";

/** How long an in-flight marker is believed. Past this it is treated as the
 *  wreckage of an operation that died, and the heal is allowed again.
 *  Deliberately generous: a cold provision (blueprint fetch, clone, bring-up
 *  with its bounded waits) is minutes, and a heal that fires one tick too
 *  late costs one cycle, while a heal that fires too early costs a race. */
export const OPERATION_STALE_MS = 15 * 60 * 1000;

/**
 * Issue #100: "a --fresh-session provision was requested and not yet
 * CONFIRMED applied", set true BEFORE `runProvision` is ever called with
 * `freshSession: true` (provisionWithStorage), cleared only after a LATER
 * attempt actually reaches `state: "running"` with the flag effectively on.
 *
 * Before this key existed, `cfg.freshSession` lived only as a local variable
 * for the ONE attempt carrying it (cli-args.ts's own doc comment: "the
 * Worker never persists it" -- true for a SUCCESSFUL bring-up, where the
 * container itself is the durable record, but also true, silently, for a
 * FAILED one). `runProvision`'s own try/catch (see its doc comment) turns
 * every failure anywhere in the clone/blueprint/bring-up sequence --
 * including a bring-up exec that throws or exits non-zero -- into a
 * `"degraded"` status with `freshSessionMoved` left at its initial `false`,
 * and returns NORMALLY: nothing durable ever recorded that a fresh session
 * was asked for. The next plain `fleet provision <id>` (no flag) then read
 * `cfg.freshSession` as absent, took the ordinary `adoptBeforeBringup`
 * branch, and resumed whatever session state the container actually held --
 * silently dropping the operator's fresh-session intent. Measured live
 * 2026-09-30: `--fresh-session` -> 500 mid-bring-up -> plain retry ->
 * "resumed · snap 152m STALE".
 *
 * Same "write the intent before the risky work, clear only on a genuine
 * later success" shape OPERATION_KEY's own doc comment already establishes
 * for the identical class of problem (an in-flight claim that must survive a
 * throw) -- chosen over "refuse the plain retry outright" (the issue's own
 * other acceptable fix) because this codebase already has the durable-intent
 * idiom and no precedent for a provision verb that refuses a bodyless retry.
 * A `boolean`, not a timestamped/stale-able marker like OPERATION_KEY: an
 * un-consumed fresh-session request never goes stale on its own -- an
 * operator who asked for fresh a week ago still wants fresh, not a silent
 * expiry back to resume.
 *
 * Issue #115: there is a SECOND clearing path besides the confirmed-`running`
 * one above -- an explicit `cfg.cancelFreshSession === true` cancel, handled
 * in `provisionWithStorage`, clears this key UNCONDITIONALLY and FIRST,
 * before `runProvision` ever runs, regardless of whether any provision ever
 * reaches `state: "running"`. See the cancel's own call-site comment in
 * `provisionWithStorage` for the mechanism.
 */
export const FRESH_SESSION_PENDING_KEY = "freshSessionPending";

/**
 * Issue #100 F3: "a destroy is in flight", as an ISO timestamp, or null.
 *
 * runDestroy writes `stopped` only AFTER destroy() resolves, so a wake that
 * read `running` just before could exec into the container mid-destroy and
 * start it again. Written immediately before destroy(), cleared in a
 * `finally` (destroy.ts) and by every provision and restart, which bring the
 * container back up (covers recycle and heal, and a destroy that died
 * mid-flight). The wake, inspect and /provisioned gates read it as
 * DESTROY_IN_FLIGHT; scheduled ticks and the heal stand down on it. A separate key, not an
 * early `stopped`: a FAILED destroy must leave a degraded studio whose loops
 * keep running, and an early `stopped` would end any tick finishing inside
 * the destroy window. Stale past OPERATION_STALE_MS, for OPERATION_KEY's own
 * reason — an isolate evicted mid-destroy must not block wakes forever.
 */
export const DESTROYING_KEY = "destroyingSince";

/** The state do.ts's gatedStateIn reports while DESTROYING_KEY is fresh.
 *  Every gate that refuses `stopped` refuses this too, in its own words. */
export const DESTROY_IN_FLIGHT = "destroying";

/**
 * Issue #100 F3: is a destroy in flight? `since` is DESTROYING_KEY's value.
 * Stale past OPERATION_STALE_MS, for the reason decideHeal ignores a stale
 * OPERATION_KEY: an isolate evicted mid-destroy must not block wakes forever.
 */
export function destroyingMarkerFresh(since: string | null | undefined, now: Date): boolean {
  if (!since) return false;
  const age = now.getTime() - new Date(since).getTime();
  return Number.isFinite(age) && age >= 0 && age < OPERATION_STALE_MS;
}

/**
 * Issue #123: call BEFORE an exec; the returned check answers "did a destroy
 * land since?" — the row went to `stopped`, or a new DESTROYING marker is
 * fresh. An exec opens the DO's input gate, and a write built on the row read
 * before it would put `running` back over the destroy, re-opening the start
 * gate and re-arming the ticks. The #99 rule (failover.ts), for every writer:
 * check right before each write — storage, recordStudio, notify — and skip
 * them all when it answers true.
 *
 * Relative to the snapshot, not absolute: a provision or restart of a studio
 * already `stopped` (or past a destroy that died) still records its refresh.
 */
export async function watchForDestroy(storage: StudioStorage, now: () => Date): Promise<() => Promise<boolean>> {
  const wasStopped = (await storage.get(STATUS_KEY))?.state === "stopped";
  const markerBefore = (await storage.get(DESTROYING_KEY)) ?? null;
  return async () => {
    if (!wasStopped && (await storage.get(STATUS_KEY))?.state === "stopped") return true;
    const marker = (await storage.get(DESTROYING_KEY)) ?? null;
    return marker !== markerBefore && destroyingMarkerFresh(marker, now());
  };
}

/**
 * Issue #152: a genuine destroy EPOCH, replacing the snapshot heuristics
 * above (`watchForDestroy`'s own "did the row go stopped, or did a marker
 * change" check) everywhere an operation needs to know "did a destroy land
 * SINCE I started", not merely "does one look to be in flight right now".
 *
 * `watchForDestroy` snapshots STATUS_KEY/DESTROYING_KEY and compares them
 * LATER — which goes blind exactly when a destroy runs start-to-finish
 * inside the window between the snapshot and the check: destroy.ts's own
 * `finally` clears DESTROYING_KEY at the very end of `destroyWithSync`, so a
 * check taken after that clears sees no marker at all, and a write racing in
 * between un-stops the row before a LATER, OUTER snapshot ever notices it
 * went stopped. A counter that only ever increases cannot go blind that way:
 * every completed (or aborted) destroy leaves a permanent, unmissable trace
 * an earlier snapshot can be compared against at any later point, no matter
 * how many storage reads happened in between.
 *
 * Never cleared, never reset — see destroy.ts's own two call sites (round 3
 * review, fix 3: AFTER the #129 probe-refusal decision inside
 * `destroyWithSync` — a destroy that refuses outright, e.g. a running-but-
 * unresponsive container with no --force/--discard-unsynced, leaves the
 * epoch completely untouched — but still BEFORE syncSessionTick/rescue-push/
 * harvestLearnings and the DESTROYING_KEY marker write; and right after the
 * stopped-row STATUS_KEY write) for exactly when and how often it bumps.
 */
export const DESTROY_EPOCH_KEY = "destroyEpoch";

/** Absent (a studio never destroyed) reads as epoch 0. */
export async function readDestroyEpoch(storage: StudioStorage): Promise<number> {
  return (await storage.get(DESTROY_EPOCH_KEY)) ?? 0;
}

/** Issue #152: called ONLY from destroy.ts — see DESTROY_EPOCH_KEY's own doc
 *  comment for the two call sites and why each is exactly where it is. */
export async function bumpDestroyEpoch(storage: StudioStorage): Promise<void> {
  await storage.put(DESTROY_EPOCH_KEY, (await readDestroyEpoch(storage)) + 1);
}

/**
 * Issue #152: one operation's own claim on "the destroy epoch as of when I
 * started". `moved()` answers "has a destroy landed (fully, or far enough to
 * have bumped the epoch) since this ctx was created" — the single question
 * every write/start guard in do.ts and this file now asks instead of
 * `watchForDestroy`'s point-in-time snapshot comparison.
 *
 * Created exactly once per OUTER operation entry point (do.ts's `provision`,
 * `restartStudio`, `recycle` — see `StudioDO.allowingStart`) and threaded
 * DOWN through every nested call that operation makes, rather than each
 * nested step creating (and racing) its own — see recycle's own doc comment
 * in do.ts for the one case that matters: its internal reprovision step
 * reuses the SAME ctx recycle itself was handed, not a fresh one taken after
 * recycle's own `destroy()` has already run.
 */
export interface OpCtx {
  readonly epoch: number;
  moved(): Promise<boolean>;
}

export async function createOpCtx(storage: StudioStorage): Promise<OpCtx> {
  const epoch = await readDestroyEpoch(storage);
  return { epoch, moved: async () => (await readDestroyEpoch(storage)) !== epoch };
}

/**
 * The default for every optional `ctx` parameter below: a ctx that never
 * reports `moved()`, for every EXISTING caller that predates this feature
 * and passes no ctx at all (do.ts's scheduled ticks, and the many tests that
 * call these *WithStorage functions directly without exercising #152's own
 * race). Its `epoch` is never read by anything — `moved()` is hardcoded, not
 * epoch-compared — so `-1` is just a value that could never coincide with a
 * real stored epoch (which starts at 0 and only increases).
 */
export const NEVER_MOVED_CTX: OpCtx = { epoch: -1, moved: async () => false };

export interface OperationInFlight {
  // Review round 3 (issue #85 PR1), MUST-FIX 5: "recycle" joins the pair —
  // recycleWithSync destroys and reprovisions, exactly the same
  // multi-minute, container-touching window "provision"/"restart" already
  // cover, and needs the identical op-lock coverage (both the heal's
  // "already running" guard, and the ship tick's failure-counting skip).
  //
  // Review round 5, Finding 3: "failover" joins the set for the same
  // reason — runAccountFailover's own token-write + mergeObserved two-step
  // (failover.ts) is the identical container-exec-then-DO-patch shape, and
  // needs the same guard against a concurrent ship tick racing the two
  // writes.
  op: "provision" | "restart" | "recycle" | "failover";
  since: string;
}

/**
 * Review round 6 (issue #85 review round 6), Blocker 2: is an EXISTING
 * OPERATION_KEY value genuinely still in flight, or wreckage an isolate left
 * behind before it ever reached its own `finally`? The three call sites below
 * used to read "already locked" as "this key is non-null, at all" (review
 * round 5, Finding 1's own fix) — correct for a lock a live nested call just
 * set, but wrong for a STALE one: a lock that can never expire is worse than
 * no lock, the exact #81 permanent-disable lesson decideHeal's own inFlight
 * check (do.ts) already applies to this identical key. Before this, a stale
 * lock made `alreadyLocked` read true FOREVER, so these functions never
 * refreshed it and never cleared it — a heal or a NEW provision/restart/
 * failover could then run concurrently with what looked like, but was not
 * really, an in-flight bring-up.
 *
 * Same age, same comparison, same direction as decideHeal's own inFlight
 * check: `age >= 0 && age < OPERATION_STALE_MS`. Deliberately NOT reused as a
 * shared call (decideHeal takes the lock as an argument already computed by
 * its own caller, and importing across that boundary would cost more than it
 * saves) — but the formula must never drift from it, so read decideHeal
 * before changing this.
 */
export function operationLockFresh(inFlight: OperationInFlight | null | undefined, now: Date): boolean {
  if (inFlight == null) return false;
  const age = now.getTime() - new Date(inFlight.since).getTime();
  return Number.isFinite(age) && age >= 0 && age < OPERATION_STALE_MS;
}

/** Issue #104: the container's most recent stop, as the containers library
 *  reported it to onStop. Before this the exit code was logged only at
 *  debug level, so a spontaneous exit left nothing an operator could read.
 *  Read it for what it is (#113 review): the library reports `reason` as
 *  "exit" on every path it takes, an `exitCode` of 0 can be its own synthetic
 *  default rather than the process's, and some stops never reach onStop at
 *  all — so this is the last stop onStop SAW, not a complete stop history. */
export const LAST_STOP_KEY = "lastStop";

export interface LastStop {
  exitCode: number;
  reason: string;
  at: string;
}

/** The marker HEAL_ATTEMPT_KEY holds. `armed: false` is a disarmed marker,
 *  which is how "no heal outstanding" is written without a storage delete --
 *  StudioStorage exposes get/put and no delete, deliberately. */
export interface HealAttempt {
  armed: boolean;
  attemptedAt: string;
  reason: string;
}

/** The zero value for a studio nothing has been recorded about yet.
 *  Exported since P3 Task 2: do.ts's ensureSpawnToken publishes the spawn
 *  token hash before any provisioning has run, so it may be the first thing
 *  ever to write this studio's status — and it must write the SAME defaults
 *  every other entry point does, not a hand-rolled near-copy.
 *
 *  Issue #107 fix-first round 2: deliberately does NOT stamp `doClass`.
 *  This file is Env-free by design (see this file's own header), so it has
 *  no way to know whether env.STUDIO_BIG is actually reachable in THIS
 *  deploy — computing it from role alone here would risk exactly the lie
 *  doClassForRole's own doc comment (container-class.ts) warns against. The
 *  one caller that can genuinely be first-to-write a row, do.ts's
 *  ensureSpawnToken, threads its own Env-aware value down as an explicit
 *  parameter instead (see that function's own doc comment) — this only
 *  supplies every OTHER field's zero value. */
export function freshStatus(id: string): StudioStatus {
  return {
    id, state: "provisioning", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  };
}

/**
 * Idempotent (shell-guarded) clone: a no-op if the target dir is already a
 * git checkout. Task 4 controller ruling: this + the bring-up script are
 * the ENTIRE exec sequence — no separate "tailscale up" exec; that lives
 * inside studio-bringup.sh (Task 8). No credential is embedded here — see
 * task-4-report.md's "clone auth" note; Task 7's refresh alarm is where
 * GitHub token wiring lands.
 *
 * Review round 2, Important 1: ALWAYS issued, on every provision call — no
 * "already cloned, skip the exec" tracking in DO storage (that was the
 * previous design; removed). DO storage is durable across a container
 * recycle; the container FILESYSTEM is not. A "cloned:true" flag surviving
 * in storage past a recycle would skip this exec entirely, bring-up would
 * then run against a missing checkout, and the studio would pin to
 * "degraded" forever — restartStudio never clones either, so nothing could
 * ever recover it. The guard is what makes re-issuing safe (a no-op when
 * the checkout is intact) AND necessary (a real clone when it isn't) — the
 * shell, which actually knows the filesystem's state, decides; DO storage
 * no longer pretends to.
 */
export function guardedCloneCmd(workRepoSlug: string, targetDir: string): string {
  return `test -d ${targetDir}/.git || git clone --depth 1 https://github.com/${workRepoSlug}.git ${targetDir}`;
}

/**
 * Best-effort discovery of rescue branches a PRIOR incarnation of THIS
 * studio may have pushed before teardown, plus a general discoverability
 * aid for every OTHER branch on origin (board issue #9). Exists because
 * `guardedCloneCmd`'s `--depth 1` implies `--single-branch` — git's own
 * documented default — so the checkout it produces knows about the
 * default branch ONLY: `git branch -a` shows nothing else, `git log`
 * shows `(grafted, ...)`. Any branch that isn't the default is otherwise
 * invisible to the next container that provisions this same studio, with
 * no local trace it even exists — the exact gap measured live: a lead
 * told to resume from a specific rescue branch could not find it via
 * `git branch -a` and only recovered after a human manually ran `git
 * ls-remote` + `git fetch origin <branch>:<branch>`. This function
 * automates that manual recovery for the one case it CAN automate.
 *
 * do.ts's `rescuePushCmd` (read-only context for this function — not
 * edited here) pushes a dying studio's dirty tree to one of two targets:
 * the branch checked out at teardown (an arbitrary name), or, when that
 * branch equals the repo's resolved default (or the default couldn't be
 * resolved at all — fail safe), a freshly generated
 * `fleet/rescue/<studio>-<UTC YYYYMMDDHHMMSS>` ref. The
 * `fleet/rescue/<studio>-` PREFIX is deterministic per studio; only the
 * timestamp suffix varies.
 *
 * Deliberately scoped (see this feature's plan doc,
 * docs/superpowers/plans/2026-09-18-rescue-branch-discovery.md, for the
 * full three-mechanism tradeoff) — NOT a blanket `--no-single-branch` on
 * the clone itself, which would fetch the tip of every branch on every
 * provision and regress the ~5-minute bring-up this repo's operator
 * guidance treats as a valued property, for the 99% of provisions that
 * will never need to recover a rescue branch. Instead:
 *
 *   1. `git ls-remote --heads origin` — a pure ref-advertisement round
 *      trip (name + sha per branch), never an object fetch, cheap
 *      regardless of how many branches exist — written verbatim to
 *      `REMOTE_BRANCHES_LIST_FILE` (`/workspace/.fleet/remote-branches.txt`
 *      — ONE LEVEL ABOVE `targetDir`, deliberately OUTSIDE the studio's own
 *      git checkout, mirroring exactly where container/studio-bringup.sh
 *      writes its own `working-set.md`
 *      (`${FLEET_WORKSPACE:-/workspace}/.fleet/working-set.md`) for the same
 *      reason: `targetDir` is a real git working tree with no
 *      `.gitignore`/exclude mechanism for `.fleet/` anywhere in this repo,
 *      and do.ts's `rescuePushCmd` (read-only context) decides "anything to
 *      rescue" via `git status --porcelain` and then unconditionally `git
 *      add -A`s before committing — a listing file living INSIDE the
 *      checkout would exist from every studio's very first provision
 *      onward, permanently defeating the `RESCUE_CLEAN` fast path and
 *      getting swept into every real rescue commit as unrelated noise).
 *      This alone closes the GENERAL discoverability gap: a resuming lead
 *      (or a future automated working-set-replay step) can grep a file
 *      instead of having to think to run `git ls-remote` themselves, for
 *      ANY branch name, not only rescue-prefixed ones.
 *   2. From that same listing, only refs matching THIS studio's own
 *      deterministic `refs/heads/fleet/rescue/<studio>-` prefix FOLLOWED BY
 *      EXACTLY THE 14-DIGIT UTC TIMESTAMP SHAPE `rescuePushCmd` generates
 *      (`$(date -u +%Y%m%d%H%M%S)`) AND NOTHING ELSE get a real, small,
 *      bounded `git fetch` — a rescue branch is at most a handful of
 *      commits, never the whole default-branch history — so it shows up in
 *      a plain `git branch` with no further action from the lead. One loud
 *      stderr line per branch actually fetched. The match is anchored (both
 *      the exact digit count and end-of-line), not a bare prefix-plus-
 *      wildcard: an unanchored `[^[:space:]]*` would let one studio's
 *      prefix match as a literal substring of a DIFFERENT, longer studio
 *      id's own rescue ref (e.g. `websites--maestro`'s prefix is a literal
 *      prefix of `websites--maestro-2`'s ref name) and wrongly fetch that
 *      other studio's rescued work.
 *
 *      PR #263 round 4 (#251 review, Finding 2): rescue.ts's round 3 N1/N2
 *      push a SECOND ref shape under this same studio-scoped tree —
 *      `refs/heads/fleet/rescue/<studio>/<14-digit UTC timestamp>/checkout/
 *      <branch-or-stash-name>` (a local branch not checked out anywhere at
 *      teardown, or a stash entry) — and this function's grep now matches
 *      BOTH shapes, not only the flat one. Anchored the identical way: a `/`
 *      immediately after `<studio>` (never `-`, the flat scheme's own
 *      separator) rather than an unanchored substring, for the same
 *      collision reason as above — a studio id is never a literal prefix of
 *      a DIFFERENT studio id followed by `/`.
 *
 * Coverage, stated honestly (repeated in the plan doc and this feature's
 * completion record):
 *   - SOLVED, fully automatic: a rescue-push that landed on a freshly
 *     generated `fleet/rescue/<studio>-*` ref (nothing else was checked
 *     out at teardown), OR on rescue.ts's own N1/N2 nested
 *     `fleet/rescue/<studio>/<ts>/checkout/*` ref (an unpushed
 *     not-checked-out branch, or a stash entry), is discovered and fetched
 *     here with zero manual steps on the next provision.
 *   - PARTIALLY solved: a rescue-push (or any earlier normal push) that
 *     landed on an ARBITRARY, already-existing branch name (e.g. a task
 *     branch a prior incarnation was on) is NOT auto-fetched by this
 *     mechanism — there is no way to know it belongs to "this studio"
 *     from the branch name alone — but it now at least APPEARS in
 *     `REMOTE_BRANCHES_LIST_FILE`'s full listing, greppable by a human or a
 *     future automated step, instead of being totally invisible as it is
 *     today.
 *   - NOT solved by this function, named explicitly as follow-up work
 *     out of this task's boundary: a durable, closed-loop "this studio's
 *     last known active branch" record would need do.ts/destroy.ts
 *     (where rescue-push's actual target decision and
 *     `RescueResult.branch` already exist, at teardown time) to persist
 *     that branch name somewhere durable (DO storage) for the next
 *     provision to read directly — no grepping required.
 *
 * Never fails hard: this is a recovery/discoverability aid, not part of
 * the critical provisioning path. Every step is shell-guarded (chained
 * with `&&` so a failure anywhere short-circuits the rest) and the whole
 * command ends `|| true`, so a failure (network blip, no rescue
 * branches, an unwritable dir, whatever) degrades to "did nothing
 * extra," never to a nonzero exit. runProvision wires this in its own
 * try/catch too, beside (not inside) the session-restore one — same
 * "provision proceeds regardless" discipline, belt and braces.
 */

/** Where the raw `git ls-remote --heads origin` listing gets written — ONE
 *  LEVEL ABOVE any studio's `targetDir` (`/workspace/${cfg.repo}`), never
 *  inside it, deliberately mirroring container/studio-bringup.sh's own
 *  `${FLEET_WORKSPACE:-/workspace}/.fleet/working-set.md` placement. See
 *  discoverRescueRefsCmd's own doc comment for why living inside the
 *  checkout was a real bug, not a style choice. */
export const REMOTE_BRANCHES_LIST_FILE = "/workspace/.fleet/remote-branches.txt";

/**
 * Issue #30: `rescue` is the SAME target rescue pushes to (do.ts's
 * resolveRescueTarget, via ProvisionDeps.rescueTarget). `remoteUrl` set = a
 * public work repo whose rescues land on the private rescue remote, so that
 * remote is listed + fetched too, after origin. Absent (`{}`: private work
 * repo, remote unset, mint failed) = origin only, byte-identical to before.
 * Token: FLEET_RESCUE_TOKEN in exec env, expanded by a credential helper
 * (rescuePushPrelude), never argv.
 *
 * Precedence when one ref name exists on BOTH remotes: origin's copy keeps
 * the branch name (fetched first, same as before #30). Same commit on the
 * private remote = nothing more to fetch. Different commit = the private
 * copy lands as `<name>-rescue-remote`, loudly. Neither is dropped.
 *
 * Private remote unreachable = one loud WARNING line; origin's results stand
 * and the command still exits 0.
 *
 * PR #42 review (same class as the #14 review): every git network call here
 * runs under `timeout -k`, `timeoutSeconds` each. A server that accepts and
 * never answers used to hold the provision to its 600 s exec deadline. A
 * timed-out origin list = the "skipped" line; a timed-out private list = the
 * WARNING line; the other remote's results stand.
 */
export const RESCUE_DISCOVERY_TIMEOUT_SECONDS = 30;

export function discoverRescueRefsCmd(
  targetDir: string, studio: string, listFile = REMOTE_BRANCHES_LIST_FILE, rescue: RescuePushOptions = {},
  timeoutSeconds = RESCUE_DISCOVERY_TIMEOUT_SECONDS,
): string {
  const bounded = `timeout -k ${KILL_GRACE_SECONDS} ${timeoutSeconds}`;
  const listDir = listFile.slice(0, listFile.lastIndexOf("/"));
  const flatPrefix = `refs/heads/fleet/rescue/${studio}-`;
  // PR #263 round 4 (#251 review, Finding 2): rescue.ts's round 3 N1/N2 push
  // a SECOND ref shape under this same studio-scoped tree, deliberately
  // different from the flat one above — `fleet/rescue/<studio>/<14-digit
  // UTC timestamp>/checkout/<branch-or-stash-name>` (a local branch not
  // checked out anywhere, or a stash entry; see rescue.ts's own N1/N2
  // comments for why). Without a second pattern here, neither ever matched
  // the flat-anchored regex above (it requires a literal `-` right after
  // `<studio>`, followed by EXACTLY 14 digits and end-of-line — this nested
  // shape has a `/` there instead, then more path after the digits), so an
  // N1/N2 rescue sat on origin invisible to the very auto-fetch this
  // function exists to provide — a silent asymmetry with every OTHER rescue
  // shape, which IS auto-discovered. Anchored the same defensive way as the
  // flat prefix (see that pattern's own comment on the
  // `websites--maestro`/`websites--maestro-2` collision it guards against):
  // a studio id can never itself be a literal prefix of a DIFFERENT studio
  // id immediately followed by `/` — studio ids don't contain `/` — so this
  // nested prefix cannot match a longer studio's own nested ref the way an
  // unanchored flat prefix could. `[^[:space:]]+` (never a bare `.+`) for
  // the trailing branch/stash name: a git ref name cannot contain
  // whitespace, and stopping at the first whitespace keeps this immune to
  // `ls-remote`'s own tab-separated sha column reappearing anywhere odd.
  const nestedPrefix = `refs/heads/fleet/rescue/${studio}/`;
  // Issue #266 (follow-up on #251/#263): rescue.ts's rescue_target() names a
  // member worktree's own rescue ref `fleet/rescue/<studio>/wt/<id>-<14-digit
  // UTC timestamp>` — a THIRD shape, distinct from both the flat main-
  // checkout fallback above and the nested N1/N2 `checkout/...` shape below.
  // It used to be flat too (`fleet/rescue/<studio>-<id>-<timestamp>`), which
  // never matched the flat pattern's own `[0-9]{14}$` anchor (extra `<id>-`
  // characters between the dash and the digit run) — the exact same silent-
  // loss class Finding 2 (round 4, see rescue.ts's own C4 comment) already
  // closed for the nested shape, just for this one instead. Moving `$id`
  // under its own `wt/` segment makes it unambiguous AND lets it reuse this
  // same nested-prefix collision guard (a studio id can't be a literal
  // prefix of a different studio id immediately followed by `/`).
  const wtPrefix = `${nestedPrefix}wt/`;
  const pattern =
    `${flatPrefix}[0-9]{14}$|${nestedPrefix}[0-9]{14}/checkout/[^[:space:]]+$|${wtPrefix}[^[:space:]]+-[0-9]{14}$`;
  const originCmd = (
    `{ mkdir -p ${listDir} && ` +
    `${bounded} git -C ${targetDir} ls-remote --heads origin > ${listFile} && ` +
    `grep -oE '${pattern}' ${listFile} | sort -u | while IFS= read -r ref; do ` +
    `name="\${ref#refs/heads/}"; ` +
    // Issue #45 item 4: every fetch says how it went. `fetch && echo` let a
    // failed LAST fetch end the loop non-zero, so the `||` below printed a
    // false "could not list" line; an earlier failed fetch was silent.
    `if ${bounded} git -C ${targetDir} fetch origin "$ref:$name" </dev/null; then ` +
    `echo "studio-bringup: found rescued work from a prior incarnation of this studio on branch $name -- fetched (not checked out), see git log $name" >&2; ` +
    `else echo "studio-bringup: WARNING: could not fetch rescue branch $ref from origin -- fetch it by hand" >&2; fi; ` +
    // PR #312 round 3: still never fails provisioning, but no longer silent --
    // an unwritable list dir or a failed ls-remote used to vanish into `|| true`.
    `done; } || echo "studio-bringup: rescue discovery skipped (could not list origin's branches into ${listFile})" >&2`
  );
  if (rescue.remoteUrl === undefined) return originCmd;
  // Issue #30. GIT_TERMINAL_PROMPT=0: a missing token fails, never waits.
  const rgit = `GIT_TERMINAL_PROMPT=0 ${bounded} "\${__rgit[@]}" -C ${targetDir}`;
  return (
    `${originCmd}\n` +
    `{ ${rescuePushPrelude(rescue)}` +
    `__rl="$(${rgit} ls-remote --heads "$__rdest")" && ` +
    `{ printf '%s\\n' "$__rl" | grep -oE '${pattern}' | sort -u | while IFS= read -r ref; do ` +
    `name="\${ref#refs/heads/}"; ` +
    `sha="$(printf '%s\\n' "$__rl" | awk -v r="$ref" '$2 == r { print $1 }')"; ` +
    `have="$(git -C ${targetDir} rev-parse -q --verify "refs/heads/$name" 2>/dev/null)"; ` +
    // Same commit already fetched from origin: nothing to add.
    `[ "$have" = "$sha" ] && continue; ` +
    `if [ -n "$have" ]; then ` +
    // PR #42 review: the local branch may be origin's or the lead's own.
    `echo "studio-bringup: local branch $name already exists at a different commit -- kept; the private rescue remote's copy fetched as $name-rescue-remote" >&2; ` +
    `name="$name-rescue-remote"; fi; ` +
    `if ${rgit} fetch "$__rdest" "$ref:$name" </dev/null; then ` +
    `echo "studio-bringup: found rescued work from a prior incarnation of this studio on branch $name (private rescue remote) -- fetched (not checked out), see git log $name" >&2; ` +
    `else echo "studio-bringup: WARNING: could not fetch rescue branch $ref from the private rescue remote -- fetch it by hand" >&2; fi; ` +
    `done; }; } || echo "studio-bringup: WARNING: rescue discovery could not list the private rescue remote -- rescued work there NOT fetched; origin results kept" >&2`
  );
}

/**
 * The one command both `runProvision` and `runRestart` sbExec to bring a
 * studio up. Deliberately the same for both, and the answer to issue #67's
 * "check the sibling path": there is no second launch site for the restart
 * path to share provision's fault with. The guard lives once, in the script
 * (`claude_launch_needed` / `claude_stop`), and therefore covers both entry
 * points and any future caller of BRINGUP_CMD.
 *
 * What that guard changed for callers here: re-issuing provision against a
 * studio whose lead is ALIVE is now a no-op for the lead — it launches
 * nothing and says so — instead of stacking another process. Measured before
 * the guard, on `fleetflare--release-studio` after a day of repeated
 * provisions: 62 claude processes, 458 MB free, the lead dying every few
 * minutes; after a recycle, same container and same work, 3 processes and
 * 4978 MB free. Replacing a wedged lead is now an explicit act
 * (STUDIO_REPLACE_CLAUDE=1), never a side effect of a routine provision.
 */
export const BRINGUP_CMD = "/opt/fleet/studio-bringup.sh";

/**
 * How long `provisionedCheckCmd` waits, in the container, for claude to
 * appear. Bring-up does NOT launch claude synchronously — it `send-keys` the
 * launch line into the tmux window (see container/studio-bringup.sh's own
 * comment on why the window always runs a plain bash), so
 * `pane_current_command` can still read "bash" for a second or two after the
 * launch is sent. A check with no wait at all would therefore fail a
 * perfectly good provision; the wait is what makes "claude is running" a
 * fact rather than a coin flip. Seconds, one probe per second.
 *
 * Issue #54 added bring-up's own wait on the same signal, budgeted to this
 * same number of seconds (`CLAUDE_ALIVE_TRIES`, defaulted in
 * claude_launch_landed): a BRINGUP_CMD that exits 0 now also means claude
 * was running a moment ago, so this check is no longer the first thing to
 * ever look at the pane. Kept at full length regardless — this check runs on
 * paths bring-up never touches (the syncSession tick, `fleet check`,
 * recycle's own post-provision check), and shortening it would only trade a
 * cheap sleep for a false "not running" on a slow container.
 */
export const PROVISIONED_CHECK_TRIES = 20;

/**
 * How long the harness check waits for the caveman plugin's SessionStart hook
 * to write its flag file, once claude is already up. Shorter than
 * PROVISIONED_CHECK_TRIES because the race is much tighter: the hook fires at
 * session start, not at some later point (measured live: the flag appeared 5s
 * after bring-up wrote settings.json). Seconds, one probe per second.
 */
export const CAVEMAN_FLAG_TRIES = 10;

/**
 * The one token that means "this studio is provisioned". Anything else the
 * check prints is the reason it is not; nothing printed at all is a check
 * that did not reach a verdict (see do.ts's own three-outcome handling).
 *
 * A stdout token, NOT an exit code, and this is the load-bearing part of
 * this whole file's second fix round (2026-08-25, measured on the deployed
 * Worker): a command containing `exit` KILLS THE SANDBOX SESSION. Every
 * sbExec in this feature runs inside one long-lived container-server
 * session ("sandbox-default"), and a bare `exit 0` in the command text
 * terminates that session's shell rather than the command — the SDK then
 * THROWS `Session 'sandbox-default' shell exited (exit code: 0)` instead of
 * returning a result. The first version of this check ended both branches
 * in `exit 0`/`exit 1`, so it destroyed its own transport on the way to
 * reporting success: a fully healthy `websites--maestro` (repo cloned,
 * session restored, hook installed, 6 skills, claude running) came back as
 * a 500. Verified deterministic, not flaky — it fired on every studio.
 *
 * The idiom used instead is the one already proven in this file:
 * CONTAINER_HAS_PROJECTS_CMD answers "yes"/"no" on stdout and never exits.
 * Non-zero exit codes are fine per se (`cat /workspace/.ts-host` exits 1
 * routinely); it is the `exit` BUILTIN that is fatal.
 */
export const PROVISIONED_OK = "FLEET_PROVISIONED_OK";

/**
 * The check's third answer: "I could not tell." Printed by the harness block
 * below when its own input did not survive the trip into the container (the
 * base64 blob failed to decode) — a statement about the CHECK, never about
 * the studio, and do.ts maps it to `inconclusive` for exactly that reason.
 *
 * It exists because the harness block adds the first failure mode this check
 * has that is NOT the container answering honestly. Without a token of its
 * own, an undecodable expectation would produce an empty missing-list and the
 * check would print PROVISIONED_OK — a false green, which is the one outcome
 * this whole feature exists to remove. Fail-open on the CHECK, fail-closed on
 * the GATE: the same split the `inconclusive` verdict already encodes.
 */
export const PROVISIONED_UNKNOWN = "FLEET_PROVISIONED_UNKNOWN";

// --- the bring-up log (issue #38) -------------------------------------------
// container/studio-bringup.sh writes every step it reaches, timestamped and
// tagged with a per-run id, to this file — see that script's own "bring-up
// log" region for WHY (measured 2026-09-23: six `acme-os` studios came back
// from an image rollout with an EMPTY /workspace, and the only forensic
// evidence anywhere was the mtime of two unrelated files, read from inside a
// container shell).
//
// These three exports are the Worker's half of it: where the file is, how to
// READ its tail onto a failed readiness verdict (so an operator sees the
// failing step without a shell), and how to APPEND to it (so the Worker's own
// retry decision lands in the same stream as the two bring-up runs it is
// about, instead of only in a status row that the next write overwrites).

/** Must stay byte-identical to `FLEET_BRINGUP_LOG`'s default in
 *  container/studio-bringup.sh. One level ABOVE any studio's checkout, beside
 *  working-set.md — see discoverRescueRefsCmd's doc comment for why a file
 *  inside the checkout is a real bug rather than a style choice. */
export const BRINGUP_LOG_PATH = "/workspace/.fleet/bringup.log";

/** How much of the log a failed verdict carries. Enough for one whole run's
 *  step list plus its stderr (a healthy run writes ~10 lines), short enough
 *  that a `fleet ls` row stays readable. */
export const BRINGUP_LOG_TAIL_LINES = 60;

/** Hard ceiling on the tail, in characters, applied after the read. The
 *  line count above bounds a WELL-FORMED log; this bounds a pathological one
 *  (a step that printed a megabyte on one line), so a runaway container can
 *  never turn a status row into an unbounded payload. */
export const BRINGUP_LOG_TAIL_MAX_CHARS = 4000;

/**
 * Read the last lines of the bring-up log.
 *
 * READ-ONLY and INVISIBLE, which is a hard fleet rule on anything that runs
 * against a live studio, not a preference: it touches no tmux window, selects
 * nothing, switches nothing, and leaves no trace an operator attaching later
 * could see. A probe that left window 1 active once made a healthy studio
 * look dead and cost an hour; that has now happened three times here.
 *
 * Never uses the `exit` builtin — the same HARD RULE PROVISIONED_OK's own doc
 * comment spells out: every sbExec in this feature runs inside one long-lived
 * "sandbox-default" session, and `exit` there terminates that session's shell
 * rather than the command, which once turned a fully healthy studio's check
 * into a 500.
 *
 * A container with no log at all (one that predates this feature, or one
 * whose bring-up died before it could create the file) answers with empty
 * output and exit 0, never a failed exec — `|| true` makes "there is nothing
 * to show you" a normal answer rather than an error the caller has to
 * special-case.
 */
export function bringupLogTailCmd(lines: number = BRINGUP_LOG_TAIL_LINES): string {
  return `tail -n ${lines} ${BRINGUP_LOG_PATH} 2>/dev/null || true`;
}

/**
 * Append one Worker-written line to the bring-up log.
 *
 * The payload is SINGLE-QUOTED, the only quoting that is total: everything
 * inside a single-quoted string is literal, so the sole case to handle is the
 * quote itself — closed, escaped, reopened. `reason` here is container
 * stdout/stderr echoed back, so a `;` or a backtick in it must reach the log
 * as text and never as shell. Same rule wake.ts's own shellQuote follows for
 * the same class of input.
 *
 * Callers must pass an ALREADY-REDACTED string. This function cannot redact
 * for them: it is a command builder, and the honest place to scrub is the
 * point the raw text is first held (the same rule runProvision's catch
 * follows). runRestart does exactly that before calling here.
 *
 * Best-effort by construction — `|| true`, no `exit` — for the same reason
 * the read above is: a log append must never be able to fail the studio
 * operation it is describing.
 */
export function bringupLogAppendCmd(line: string): string {
  const quoted = `'${line.replace(/'/g, `'\\''`)}'`;
  return `printf '%s\\n' ${quoted} >> ${BRINGUP_LOG_PATH} 2>/dev/null || true`;
}

/**
 * What a restart says when bring-up only worked the SECOND time.
 *
 * Issue #38 part 3, verbatim: "Never report success for the second attempt
 * without saying the first failed — a silent retry is how this class of bug
 * hides." So the studio goes back to `running` (it genuinely is), and `error`
 * stays NON-NULL carrying this prefix plus the first attempt's own reason.
 * `state: "running"` with a non-null `error` is an established shape here —
 * do.ts's recycleWithSync already reports its `inconclusive` outcome exactly
 * that way.
 *
 * Exported so the test asserts on the same string an operator reads, not a
 * re-typed approximation of it.
 */
export const BRINGUP_RETRY_HEALED =
  "bring-up succeeded only on the SECOND attempt; the FIRST attempt failed";

/**
 * What bring-up must have left on the container's own disk, re-read FROM the
 * container, before any path may report that studio as anything but broken.
 *
 * Board issue #28 introduced these two checks on the provision path and its
 * PR said plainly that `runRestart` was deliberately NOT extended, reasoning
 * that a restart heals the same container it is already talking to. Issue #38
 * is the case that reasoning left open: an image rollout replaces the
 * container UNDER an existing Durable Object, so the container a restart
 * brings up is a brand new, empty one — neither a provision nor a
 * restart-in-place. Measured 2026-09-23: six `acme-os` studios came back
 * from one rollout with /workspace EMPTY and the claude pane running `bash`,
 * and the restart path reported every one of them `running`.
 *
 * Extracted here, called by BOTH `runProvision` and `runRestart`, precisely
 * so there is one definition of "did it land" and the two paths cannot drift
 * into disagreeing about it.
 *
 * Exit-code only (no stdout marker), deliberately: that composes with every
 * existing sbExec fake in this suite, which already answers `{code: 0, ...}`
 * to any command it does not recognise.
 *
 * `repo` may be null when the studio id does not parse into a repo segment
 * (it always does for a real StudioDO). The clone assertion is then skipped
 * rather than guessed at — a check that cannot name what it is checking must
 * not invent a path — while the harness assertion, which needs no repo name,
 * still runs.
 *
 * The harness half is STUDIO-ONLY. Bring-up unconditionally
 * `mkdir -p ~/.claude/agents` for a studio, empty roster or not; a plain role
 * never gets that directory at all (measured live: websites--pilot, HOOK=0
 * SKILLS=0) and must not be failed over its absence.
 */
export async function verifyBringupLanded(
  deps: ProvisionDeps, repo: string | null, isStudio: boolean,
): Promise<void> {
  if (repo !== null) {
    const cloneLandedRes = await deps.sbExec(`test -d /workspace/${repo}/.git`);
    if (cloneLandedRes.code !== 0) {
      throw new Error(
        `bring-up reported success but /workspace/${repo}/.git is missing -- clone did not land on this container`,
      );
    }
  }
  if (isStudio) {
    const agentsLandedRes = await deps.sbExec(`test -d "$HOME/.claude/agents"`);
    if (agentsLandedRes.code !== 0) {
      throw new Error(
        `bring-up reported success but ~/.claude/agents is missing -- studio materialization did not land on this container`,
      );
    }
  }
}

/**
 * What bring-up MUST have materialized inside a studio container, encoded for
 * the check to read back. One line per assertion, base64'd:
 *
 *   s <skill-name>     a declared skill, resolvable to a real skill dir
 *   m <member-file>    a declared member, present in ~/.claude/agents/
 *   g                  the Tier-0 completion gate (Stop hook) must be
 *                      installed — present only when STUDIO_COMPLETION_GATE
 *                      is set (a code-writing roster); never for the
 *                      Maestro or any other non-implementing studio
 *   end                sentinel — a decode that produces nothing is a broken
 *                      check, not an empty expectation (see PROVISIONED_UNKNOWN)
 *
 * Base64, not a quoted list, and read back into a shell VARIABLE rather than
 * spliced into the command text: skill and member names come out of a
 * blueprint file this Worker does not own, and a name carrying a quote or a
 * `;` spliced into a shell command would be an injection. Base64's alphabet
 * cannot express either, and a value read from a variable is never re-parsed
 * by the shell.
 *
 * `null` for a ROLE (no STUDIO_NAME): a plain role provisions correctly with
 * no hooks, no members and no skills — measured live on `websites--pilot`
 * (HOOK=0 SKILLS=0) — so asserting on them would fail a healthy studio. The
 * asymmetry is the point: this Worker knows which of the two it resolved, and
 * that knowledge is what makes "no gate" detectable at all.
 */
export function harnessExpectation(env: RoleEnv | StudioEnv | null | undefined): string | null {
  if (!env || !("STUDIO_NAME" in env) || env.STUDIO_NAME === "") return null;
  const lines: string[] = [];
  for (const skill of env.STUDIO_SKILLS.split(",")) {
    if (skill !== "") lines.push(`s ${skill}`);
  }
  // Member FILENAMES, which is what bring-up writes into ~/.claude/agents —
  // the bundle's own keys, so the check asserts on the exact names the
  // materialization step used rather than on a re-derivation of them.
  try {
    const bundle = JSON.parse(atob(env.STUDIO_MEMBERS_B64 || "e30=")) as Record<string, string>;
    for (const filename of Object.keys(bundle)) lines.push(`m ${filename}`);
  } catch {
    // A member bundle this Worker itself wrote should always parse. If it
    // ever does not, assert on what IS readable (skills + the gate) rather
    // than dropping the whole expectation — a partial check beats none.
  }
  // Tier-0 completion gate (Stop hook): a bare marker, not a name — there is
  // exactly one gate script, so unlike skills/members there is nothing to
  // enumerate, and the line's mere presence in the decoded expectation IS
  // the assertion (see harnessCheckSnippet's "g" branch). Added only when
  // THIS studio's own persisted env says it writes code — the same
  // STUDIO_COMPLETION_GATE flag studio-blueprint.ts's writesCode derives
  // from the roster and studioBringupEnv installs from — so a Maestro
  // (writesCode() false, flag "") never gets this line and is never checked
  // for a gate bring-up never installs on it. A studio persisted before the
  // gate feature existed carries no key at all here either, which reads
  // exactly as falsy as "" — see StudioEnv.STUDIO_COMPLETION_GATE's own doc
  // comment.
  if (env.STUDIO_COMPLETION_GATE) lines.push("g");
  lines.push("end");
  return btoa(lines.join("\n"));
}

/**
 * Reads back, FROM THE CONTAINER, the two facts that separate a provisioned
 * studio from a bare one — the repo checkout `guardedCloneCmd` creates, and
 * claude actually running in the tmux window `BRINGUP_CMD` launches it in.
 * Prints PROVISIONED_OK when both hold, else the reason. Never calls `exit`
 * (see PROVISIONED_OK's doc comment for why that matters).
 *
 * Why this exists at all (2026-08-25 live incident): every "success" this
 * feature reports is inferred from two exec EXIT CODES — the guarded clone's
 * and bring-up's — and never from an observation of the container those
 * execs supposedly changed. That inference holds only while the container an
 * exec lands in is the same container that survives the call. A recycle is
 * exactly where that stops being guaranteed (destroy() resolves before the
 * DO's own `container.running` bookkeeping catches up — see sbAwaitReady's
 * doc comment for the pinned-SDK mechanism), and the observed failure was a
 * studio reporting `state: running, error: null` over a fresh container with
 * an EMPTY /workspace and no claude: both execs really did return 0,
 * somewhere. This command is the missing observation. `recycleWithSync`
 * (do.ts) runs it after provisioning and refuses to call a recycle
 * successful without it.
 *
 * The two universal markers are checked for EVERY container. A studio gets a
 * third block on top of them — the HARNESS check — driven by `harness`, the
 * base64 expectation `harnessExpectation` builds from the studio env this
 * Worker actually resolved. `undefined` (a plain role) keeps the old
 * two-marker behavior exactly: a role provisions correctly with no hooks, no
 * members and no skills (measured live on `websites--pilot`: HOOK=0
 * SKILLS=0), so asserting on them there would fail a healthy studio.
 *
 * Why the harness block exists (2026-08-26, measured on the live fleet):
 * `websites--maestro` was found running with SKILLS=0 AGENTS=0 BP=0
 * HOOKDIR=0 and a settings.json carrying no `hooks` key at all — an UNGATED
 * LEAD holding Edit/Write, which is precisely what spec decision 11 exists to
 * prevent — and this route answered `{"kind":"provisioned"}` throughout,
 * because "repo cloned + claude running" was the whole of what it measured.
 * That false green is what hid it: the condition is transient and self-heals
 * on the next provision, so nothing but a check that MEASURES THE HARNESS can
 * ever see the window. A studio without its gate must never read
 * `provisioned`.
 *
 * What the harness block asserts, and why each one:
 *   - lead-gate.sh present AND executable — the settings.json entry's own
 *     fail-closed guard keys on `[ -x ]`, so a non-executable script is the
 *     same as none.
 *   - settings.json references it — the hook file alone runs nothing; the
 *     reference is what makes claude call it.
 *   - ~/.claude/.caveman-active exists — the caveman plugin's SessionStart
 *     hook writes this flag and nothing else does, so its presence is proof
 *     the plugin's hooks FIRED in this container, not merely that the plugin
 *     is listed as enabled (measured: written 5s after bring-up, at claude's
 *     own session start). Enabled is not firing; this asserts firing.
 *   - every declared skill resolves — against the blueprint checkout first,
 *     then the baked plugin cache, the exact two-source rule bring-up itself
 *     uses (a Tier-0 superpowers skill legitimately has no symlink).
 *   - every declared member file is on disk — a lead with no members to
 *     dispatch cannot obey decision 11 even if it wants to.
 *   - for a code-writing studio ONLY (STUDIO_COMPLETION_GATE): the Tier-0
 *     completion gate (Stop hook) present AND executable, AND referenced by
 *     settings.json — the same two-part shape as the lead-gate check above,
 *     and for the same reason (P5a closed this gap for the PreToolUse
 *     lead-gate; a code studio could otherwise run with no Stop gate and
 *     still read `{"kind":"provisioned"}`, exactly the false green the
 *     harness block itself exists to remove). Never asserted for the
 *     Maestro or any other non-implementing studio — see
 *     harnessExpectation's own doc comment for why that studio never gets
 *     the "g" line this branch keys on.
 *
 * The caveman flag gets a bounded wait of its own: `pane_current_command`
 * reads "claude" the moment the process starts, which can be a beat before
 * its SessionStart hooks have run. Without the wait this would report a
 * missing gate on a studio that was merely two seconds young.
 *
 * Missing items are collected and reported TOGETHER, named individually —
 * "harness incomplete: skills-unresolvable: qa; member qa-engineer.md" —
 * because an operator who fixes one at a time learns nothing about the
 * shape of the failure.
 *
 * Addresses the tmux window by NAME (`studio:claude`), never by index, and
 * asserts nothing about which window is active or how many exist: live
 * studios accumulate windows (bring-up's own `shell`, an operator's or a
 * probe's extras), and `fleet attach` leaves whichever one it left. Verified
 * live with windows `0: claude | 1: shell | 2: probe` and window 2 ACTIVE —
 * the check still reads claude's own pane.
 *
 * `pane_current_command` reads "bash" exactly when nothing is running in the
 * pane — the same signal bring-up itself keys its relaunch off, reused here
 * rather than a second, differently-shaped liveness test that could disagree
 * with it.
 *
 * INVISIBLE BY CONSTRUCTION (issue #37 follow-up, and a hard requirement on
 * anything that surfaces this check on demand): `display-message -p -t
 * studio:claude` addresses the window BY NAME and does not require it to be
 * active, so this command switches nothing and leaves no trace. That matters
 * because the alternative — a probe that selects a window and relies on the
 * operator to switch back — HAS failed here: a probe left window 1 active on
 * a studio, the operator opened the tab, saw a bare
 * `root@cloudchamber:/workspace#` prompt, and called a healthy studio dead.
 * Third false diagnosis this fleet took from that one cause. If a future
 * variant of this check ever DOES need a window switch, it must restore it in
 * the SAME command line (`{ <cmd>; } ; tmux select-window -t studio:claude`),
 * never as a separate step an operator has to remember.
 *
 * KNOWN LIMIT, measured: `pane_current_command` returns `claude` in THREE
 * different states — the lead mid-turn, the lead stopped waiting on
 * background subagents, and the lead dead at a shell prompt inside that same
 * window. It answers ALIVE-or-DEAD. It does NOT answer WORKING-or-STOPPED.
 * Nothing may read PROVISIONED_OK as evidence that a studio is doing work, or
 * that it is spending money productively.
 */
export function provisionedCheckCmd(repo: string, harness?: string | null): string {
  return withStudioTmux(
    `if [ ! -d /workspace/${repo}/.git ]; then echo "no git checkout at /workspace/${repo}"; else ` +
    `p=""; i=0; while [ "$i" -lt ${PROVISIONED_CHECK_TRIES} ]; do ` +
    `p="$(${STUDIO_TMUX} display-message -p -t studio:claude '#{pane_current_command}' 2>/dev/null || true)"; ` +
    `if [ "$p" = claude ]; then break; fi; i=$((i+1)); sleep 1; done; ` +
    `if [ "$p" != claude ]; then echo "claude is not running in tmux studio:claude (pane runs: \${p:-none})"; ` +
    `else ${harness ? harnessCheckSnippet(harness) : `echo "${PROVISIONED_OK}"`}; fi; fi; ` +
    `cat "${TAILNET_DOWN_PATH}" 2>/dev/null || true`
  );
}

/** Issue #189: written by container/studio-bringup.sh's tailscale-up region
 *  when `tailscale up` fails (bring-up continues without the tailnet),
 *  removed when it succeeds. Holds one fixed line, `tailnet: quota reached`
 *  or `tailnet: down`. `${FLEET_WORKSPACE:-/workspace}` is the same
 *  expansion bring-up uses, so the two always name one file. */
export const TAILNET_DOWN_PATH = "${FLEET_WORKSPACE:-/workspace}/.fleet/tailnet-down";

/** The marker line out of the check's stdout, or null. A strict match:
 *  anything else the container printed is not a tailnet warning. */
export function tailnetWarningIn(stdout: string): string | null {
  return stdout.match(/^tailnet: (?:quota reached|down)$/m)?.[0] ?? null;
}

/**
 * The harness half of the check, as one POSIX-sh expression. Never `exit` —
 * same rule the rest of this command follows (see PROVISIONED_OK's own doc
 * comment: the `exit` BUILTIN kills the sandbox session shell, not the
 * command, and took down a healthy studio's check once already).
 *
 * Shape note: every missing item is ECHOED from inside one command
 * substitution rather than appended to a variable. A `while read` loop fed by
 * a pipe runs in a subshell, so a variable accumulated inside it is lost the
 * moment the loop ends — the classic version of this function that "found
 * nothing missing" every time. Printing from the subshell and capturing the
 * whole block is what makes the result survive.
 */
function harnessCheckSnippet(harness: string): string {
  const gate = '"$HOME/.claude/hooks/lead-gate.sh"';
  const completionGate = '"$HOME/.claude/hooks/completion-gate.sh"';
  const settings = '"$HOME/.claude/settings.json"';
  const flag = '"$HOME/.claude/.caveman-active"';
  return (
    // Decode once, into a variable. Empty means the expectation did not
    // survive the trip (no base64 in the image, a truncated command) — that
    // is a broken CHECK, and it says so with its own token rather than
    // reporting a healthy studio as bare, or a bare studio as healthy.
    `dec="$(printf '%s' '${harness}' | base64 -d 2>/dev/null)"; ` +
    `if [ -z "$dec" ]; then echo "${PROVISIONED_UNKNOWN} harness expectation did not decode in the container"; else ` +
    // Bounded wait for caveman's SessionStart flag — see this file's doc
    // comment above on why claude can be "running" a beat before it fires.
    `j=0; while [ "$j" -lt ${CAVEMAN_FLAG_TRIES} ]; do if [ -f ${flag} ]; then break; fi; j=$((j+1)); sleep 1; done; ` +
    `miss="$( { ` +
    `[ -x ${gate} ] || echo "lead-gate hook missing or not executable (~/.claude/hooks/lead-gate.sh)"; ` +
    `grep -q lead-gate.sh ${settings} 2>/dev/null || echo "settings.json does not reference the lead-gate hook"; ` +
    `[ -f ${flag} ] || echo "caveman never activated (no ~/.claude/.caveman-active flag: the plugin hooks did not fire)"; ` +
    // `case` is deliberately NOT used here: its patterns carry an unbalanced
    // `)`, and inside a `$( ... )` the shell reads that as the end of the
    // substitution (measured — the whole block died with "syntax error near
    // unexpected token"). Two `if`s on a parameter-expansion split have no
    // parentheses at all, so nothing can close the substitution early. The
    // `end` sentinel line matches neither branch and is simply skipped.
    `printf '%s\\n' "$dec" | while IFS= read -r l; do k=\${l%% *}; n=\${l#* }; ` +
    `if [ "$k" = s ]; then ok=0; ` +
    // Resolution, not existence (2026-08-19 measured failure, this session):
    // a skill directory can be present and NOT invocable — bring-up
    // materializing program.md instead of SKILL.md (34 vendored skills
    // carry only program.md, dormant), or a marketplace version label
    // re-resolving mid-session out from under a running studio (the exact
    // "Unknown skill" this fix closes). The loader reads SKILL.md's `name:`
    // frontmatter key; a directory holding anything short of that is a name
    // on disk claude refuses to call.
    `for f in "$HOME/.claude/skills/$n/SKILL.md" "$HOME"/.claude/plugins/cache/*/*/*/skills/"$n"/SKILL.md; do ` +
    `[ -f "$f" ] && grep -q '^name:' "$f" 2>/dev/null && ok=1 && break; done; ` +
    `[ "$ok" = 1 ] || echo "skills-unresolvable: $n"; ` +
    `elif [ "$k" = m ]; then [ -f "$HOME/.claude/agents/$n" ] || echo "member $n"; ` +
    // Tier-0 completion gate: the "g" line carries no name (there is
    // exactly one gate script, nothing to enumerate), so its mere presence
    // in the decoded expectation IS the assertion — harnessExpectation adds
    // it exactly when STUDIO_COMPLETION_GATE is set on this studio's own
    // env, so this branch never runs at all for the Maestro. Same two-part
    // check as lead-gate above: file executable, AND settings.json
    // references it — an installed-but-unreferenced hook runs nothing.
    `elif [ "$k" = g ]; then ` +
    `[ -x ${completionGate} ] || echo "completion-gate hook missing or not executable (~/.claude/hooks/completion-gate.sh)"; ` +
    `grep -q completion-gate.sh ${settings} 2>/dev/null || echo "settings.json does not reference the completion-gate hook"; ` +
    `fi; ` +
    `done; } )"; ` +
    `if [ -z "$miss" ]; then echo "${PROVISIONED_OK}"; ` +
    `else echo "harness incomplete: $(printf '%s' "$miss" | tr '\\n' ';' | sed 's/;/; /g')"; fi; fi`
  );
}

// --- Task 11: blueprint resolution ------------------------------------------
// fleet.json lives at the FLEET repo's own root (`env.AGENT_REPO`), and
// names the BLUEPRINT repo that holds studios/, roles/ and org.json. It is
// always read from this fixed default branch — there is no ref to resolve
// it WITH yet (fleet.json is the thing that names the ref), so this mirrors
// routes.ts's own pre-existing "main" default for an unset blueprintRef,
// not a new convention.
//
// Dynamic repo selection (P4a) RULING: this is the fleet repo, NOT the work
// repo the studio clones. Those were the same string until P4a (websites
// played blueprint host and client at once), and the split is deliberate in
// both directions:
//   - reading fleet.json from a detected client repo would mean every new
//     client repo needs one committed before a studio can start there, and
//     — much worse — that repo's own `blueprint.repo` would then choose
//     which prompts, skills and org chart run with the fleet's credentials.
//     A work repo must not be able to redirect the blueprint.
//   - so the blueprint chain (fleet.json -> blueprint.repo -> role/studio
//     files + org.json) stays anchored to the fleet's own repo, and the
//     ONLY thing a detected repo changes is guardedCloneCmd's target.
// The cost accepted: role sets are fleet-wide, not per client repo. When a
// per-repo role set is genuinely wanted, the extension is an OPTIONAL
// fleet.json in the client repo that may NARROW `roles` and nothing else —
// never one that may move `blueprint.repo`.
// Exported since P3 Task 2: src/studio/spawn.ts resolves org.json through the
// exact same two-step (fleet.json at the default branch, then the blueprint
// at fleet.json's own pinned ref), and a second copy of these three strings
// is precisely the kind of drift that would let the spawn route judge a
// request against a different file than the one provision reads.
export const FLEET_JSON_DEFAULT_REF = "main";
export const FLEET_JSON_PATH = "fleet.json";
const roleFilePath = (role: string): string => `fleet/blueprint/roles/${role}.md`;
// Task 7: studio-first counterparts — a directory per studio (studio.md +
// members/), not a flat file like roles/. Matches fleet/blueprint/studios/
// as landed by Task 6 (maestro, web-studio, release-studio).
const studioFilePath = (name: string): string => `fleet/blueprint/studios/${name}/studio.md`;
const studioMembersDirPath = (name: string): string => `fleet/blueprint/studios/${name}/members`;
// Fetched (not throw-on-404-silently) to prove the blueprint's org chart is
// reachable at the resolved ref — its content is consumed by the spawn route
// (P3 Task 2), not by provisioning itself.
export const ORG_JSON_PATH = "fleet/blueprint/org.json";

// Issue #330 round 2 (HIGH-severity architecture correction): this used to
// read `fleet/blueprint/house-rules.md` out of the BLUEPRINT repo
// (fleet.blueprint.repo) — for this fleet, rafarc21/fleetflare, which the
// public-release plan makes PUBLIC. An operator's own house-rules overlay
// committed there would ship straight into the open-source repo, the exact
// leak #330 exists to prevent. Fixed: the overlay now lives in a SEPARATE,
// PRIVATE, operator-owned repo named by its own config var, FLEET_OPS_REPO
// (env.ts) — resolved by src/ops-repo.ts's resolveOpsRepo (#346), settled jointly with
// issue #341 (that issue's own maestro comment names this exact var: both
// #341's harvested-memory feature and this one read the SAME private ops
// repo, different paths — `fleet/memory/` there, this path here, at root).
// Entirely optional: an operator who never sets FLEET_OPS_REPO (or never
// adds this file to it) gets the neutral HOUSE_RULES default (blueprint.ts)
// and nothing else — see resolveOperatorHouseRules below for the graceful
// "absent" handling, and its own doc comment for why "configured but
// unreadable" is a DIFFERENT, loudly-logged case.
export const OPS_HOUSE_RULES_PATH = "house-rules.md";

// Contents API `?ref=` value for "the ops repo's own default branch" —
// #341's own maestro comment measured this live (200, not 404) against
// api.github.com, so it is reused here verbatim rather than re-derived via
// an extra getDefaultBranch call this feature does not otherwise need.
const OPS_REPO_REF = "HEAD";

/**
 * P5d, the memory READ side (spec §7: fleet memory "must be INJECTED at
 * provision"; §9: the index is what always loads).
 *
 * Read from the blueprint repo at the SAME ref every other blueprint read
 * uses, so a studio boots from ONE coherent snapshot rather than a role pinned
 * to one commit and memory read from another. The tradeoff, recorded rather
 * than hidden: the WRITE side (do.ts's harvestLearnings, and the compaction PR
 * src/memory/routes.ts opens) always targets the blueprint repo's DEFAULT
 * branch, so a studio deliberately pinned to an older `blueprint.ref` reads an
 * index older than the newest harvest. Pinning is the unusual case, and
 * coherence is worth more there than freshness.
 *
 * Never throws. Absent index (the state of every fleet before its first
 * compaction pass), a fetch failure, an index too malformed to parse — all
 * resolve to null and the studio boots with no memory block. §7's own ruling
 * for the optional stores, applied here: a store that can block provisioning
 * is another way to have no fleet.
 *
 * Only the INDEX is ever read. The memory FILES are already on disk in the
 * container — studio-bringup.sh's `/opt/blueprint` clone — and cost nothing
 * until the lead opens one, which is the entire point of §9's tiering.
 */
async function resolveMemoryIndex(deps: ProvisionDeps): Promise<string | null> {
  // Issue #341: read from the memory STORE at its default branch; no store
  // configured means no index (memory off), and no fetch at all.
  const repo = deps.memoryRepo ?? null;
  if (repo === null) return null;
  try {
    return memoryIndexPrompt(await deps.fetchBlueprintFile(repo, MEMORY_INDEX_PATH, MEMORY_REF));
  } catch (err) {
    if (!isNotFoundError(err)) {
      console.error(`memory index unreadable at ${repo}@${MEMORY_REF}, provisioning without it`, err);
    }
    return null;
  }
}

/**
 * Issue #341: the lead's on-disk copy of the memory store, at
 * MEMORY_CLONE_DIR -- the files the index lines point at. Only when a store is
 * configured. Never degrades provisioning: memoryCloneCmd is fail-soft, and a
 * token mint or exec that throws is logged here.
 */
async function refreshMemoryClone(deps: ProvisionDeps, id: string, workRepoSlug: string): Promise<void> {
  const repo = deps.memoryRepo ?? null;
  if (repo === null) return;
  try {
    // Issue #7: the work repo decides what the token may be (write-proxy/mode.ts).
    const env = deps.memoryToken ? { [MEMORY_TOKEN_ENV]: await deps.memoryToken(workRepoSlug) } : undefined;
    await deps.sbExec(memoryCloneCmd(repo), env);
  } catch (err) {
    console.error(`studio ${id}: memory clone failed, proceeding without it`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Round-2 fix's own return shape: `text` is what appendHouseRules actually
 * appends (null = nothing to add, same as before this fix existed); `note`
 * is the DIFFERENT, loudly-visible signal item 2 of the round-2 review adds
 * — see resolveOperatorHouseRules's own doc comment for exactly when it is
 * non-null.
 */
export interface OpsHouseRulesOutcome {
  text: string | null;
  note: string | null;
}

/**
 * Issue #330 round 2 — the operator's OWN house-rules overlay, now read from
 * the PRIVATE ops repo (`opsRepo`, resolveOpsRepo's own result) rather than
 * the public blueprint repo (see OPS_HOUSE_RULES_PATH's own doc comment for
 * why that moved). Two states this function must NOT confuse, per the
 * round-2 review's own item 2:
 *
 *   - `opsRepo === null` (FLEET_OPS_REPO unset, or malformed): the ordinary
 *     state for every operator who has not opted in. Silent — `{text: null,
 *     note: null}` — same "an optional store must never block provisioning,
 *     and absence is not a fault" ruling resolveMemoryIndex's own doc
 *     comment already states for a different optional store.
 *   - `opsRepo !== null` but the fetch fails (a 404 — the file was never
 *     created — or any other error): this is CONFIGURED-BUT-BROKEN, a
 *     materially different situation an operator would want to know about
 *     (their custom house rules are silently not applying), so `note` is
 *     non-null here specifically. `text` still resolves to null either way
 *     — a broken overlay fetch degrading a studio to the neutral default is
 *     a far better failure mode than a bring-up that never happens, exactly
 *     the same "never block provisioning" ruling as the unset case, just
 *     with the failure made VISIBLE on the studio's own row (runProvision
 *     folds `note` into `status.error`, the same "recorded on the ROW, not
 *     only a Worker log" convention runRestart's own `cloneRefusal` already
 *     uses) instead of a console.error an operator would have to already be
 *     tailing Worker logs to ever see.
 */
async function resolveOperatorHouseRules(
  deps: ProvisionDeps, opsRepo: string | null,
): Promise<OpsHouseRulesOutcome> {
  const fetchOpsFile = deps.fetchOpsFile;
  if (opsRepo === null || fetchOpsFile === undefined) return { text: null, note: null };
  try {
    return { text: await fetchOpsFile(OPS_HOUSE_RULES_PATH, OPS_REPO_REF), note: null };
  } catch (err) {
    const reason = isNotFoundError(err)
      ? `${OPS_HOUSE_RULES_PATH} was not found there`
      : `${OPS_HOUSE_RULES_PATH} is unreadable (${err instanceof Error ? err.message : String(err)})`;
    const note =
      `FLEET_OPS_REPO is set to "${opsRepo}" but ${reason} -- provisioned with the neutral house rules default ` +
      `only. Create ${OPS_HOUSE_RULES_PATH} in ${opsRepo} to restore the operator overlay (issue #330's deploy ` +
      "prerequisite).";
    console.error(note);
    return { text: null, note };
  }
}

/**
 * True iff a caught fetchBlueprintFile error is the Contents API's own 404
 * shape (github/api.ts's fetchRepoFile: `fetch ${path}@${ref} failed
 * (404): ...`) — read back the same format it's written in, nothing new.
 * Used by BOTH studio-side reads below (tryFetchStudio's existence probe and
 * listStudioMembers' missing-dir case): "absent" is a 404, everything else is
 * a real failure that must propagate.
 */
function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("(404)");
}

/**
 * Studio-first existence probe (Task 7). Returns null — "resolve `name` as a
 * role instead" — for exactly two cases: the studio.md fetch 404s (no such
 * studio directory), or parseStudioFile rejects the frontmatter (a name that
 * fails to parse as a studio is the set the role path must keep handling; a
 * name is either a declared role or a studio directory, never both).
 *
 * Fix wave (T7 deferred, promoted to blocking): the fetch catch used to
 * swallow EVERY error, so a transient network failure against a REAL studio
 * fell through to the role path and surfaced as spawn's "role not declared in
 * fleet.json" — an operator could not tell a blip from a misconfiguration,
 * and fleet.json now declares all three studios, which makes the misleading
 * message the common case. Only a 404 means "not a studio"; anything else
 * propagates as itself.
 */
async function tryFetchStudio(
  deps: ProvisionDeps, repo: string, name: string, ref: string,
): Promise<Studio | null> {
  let text: string;
  try {
    text = await deps.fetchBlueprintFile(repo, studioFilePath(name), ref);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
  try {
    return parseStudioFile(text);
  } catch {
    return null;
  }
}

/**
 * Lists, fetches, and validates every file under a studio's members/ dir —
 * reuses deps.fetchBlueprintFile VERBATIM for the listing too (see that
 * field's own doc comment): a directory path returns GitHub's JSON listing
 * regardless of the raw media type the file-fetch case also uses, so no
 * second fetch mechanism exists to reuse.
 *
 * A missing members/ dir (404) resolves to an empty roster, not a failure —
 * maestro ships with none at all (Task 6's own report: solo, no members dir
 * on disk; git cannot track an empty one). Any OTHER failure — a listed
 * member's own fetch failing, or validateMemberFile rejecting bad content —
 * propagates UNCAUGHT: once members/ is known to exist, a broken member is
 * a real authoring bug and must fail loudly, never get silently downgraded
 * into an empty roster (a studio launching with zero dispatchable members
 * and no error is a worse outcome than refusing to provision).
 */
async function listStudioMembers(
  deps: ProvisionDeps, repo: string, name: string, ref: string,
): Promise<MemberFile[]> {
  let listingText: string;
  try {
    listingText = await deps.fetchBlueprintFile(repo, studioMembersDirPath(name), ref);
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
  const entries = JSON.parse(listingText) as { name: string; path: string; type: string }[];
  const members: MemberFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const raw = await deps.fetchBlueprintFile(repo, entry.path, ref);
    members.push(validateMemberFile(entry.name, raw));
  }
  return members;
}

/**
 * Fetches fleet.json (FLEET repo, default branch — see this section's own
 * header for why it is never the work repo), resolves which ref to
 * pull the blueprint FROM (cfg.blueprintRef overrides fleet.json's own
 * pinned ref when the caller supplied one — routes.ts already validated
 * it), then resolves `cfg.role` studio-first (Task 7): `fleet/blueprint/
 * studios/<name>/studio.md` tried before `fleet/blueprint/roles/<name>.md`
 * — see tryFetchStudio's own comment for the fallback rule. Below the
 * studio branch, the role path is UNCHANGED from before Task 7: validates
 * `cfg.role` against fleet.json's declared roles, fetches + parses the role
 * file and (existence-only) org.json from the blueprint repo at the same
 * ref. Returns the env vars the bring-up exec needs, plus the resolved
 * keep_alive (Fleet Spawn P3, Task 4 — R-P3-6) — both come from the SAME
 * parsed Role or Studio, and runProvision needs both from this one resolve.
 * Throws on any failure (bad JSON, missing field, unknown role, a bad
 * member, 404) INCLUDING a non-404 failure of the studio probe itself
 * (fix wave: a transient fetch error must not masquerade as "not a
 * studio" — see tryFetchStudio) — runProvision's own try/catch
 * turns that into a degraded status, same as a clone/bring-up failure;
 * there is no separate error channel for "blueprint broken" vs. "container
 * broken".
 *
 * `instance_type` (also on Role) is deliberately never read here — see
 * Role.instance_type's own doc comment (blueprint.ts) for the ruling: it is
 * recorded for the operator's deploy-time wrangler.jsonc config, not a
 * runtime knob this function (or anything downstream of it) applies.
 */
/**
 * P5c: the ONE prompt-append block a bring-up env carries, composed from the
 * project card and the task brief in that order.
 *
 * Order is deliberate: estate context first (which repo, what is at stake,
 * what is still open), the specific task second. A lead reads the standing
 * constraints before the instruction they apply to, and a brief that
 * contradicts the card is then visibly a contradiction rather than the last
 * word.
 *
 * Composed HERE rather than by widening `roleBringupEnv`/`studioBringupEnv`:
 * both already take exactly one optional append block (blueprint.ts's
 * `appendBrief`), and giving them a second parameter would mean two call
 * sites, two orderings to keep in step, and a studio path that could silently
 * gain the card while the role path did not. One string in, one behaviour.
 *
 * Either half absent — which is the NORMAL case for the card, since Directus
 * is optional at boot — collapses to the other, and both absent yields
 * `undefined`, i.e. exactly the pre-P5c call.
 */
export function composePromptBlocks(
  projectCard: string | undefined, briefPrompt: string | undefined,
): string | undefined {
  const blocks = [projectCard, briefPrompt]
    .map((b) => b?.trim() ?? "")
    .filter((b) => b !== "");
  return blocks.length === 0 ? undefined : blocks.join("\n\n");
}

/**
 * Fleet board task #118 — the adopted-task fix. `cfg.briefPrompt` is set on
 * ONLY two paths (src/studio/spawn.ts's runSpawn, and routes.ts's `POST
 * /studio/:id/provision?task=N`), and both require a CALLER to name a task
 * number. Neither recycle nor a bodyless re-provision ever does — they spread
 * the studio's existing repo/role forward with no `briefPrompt` field at all
 * — so a studio first created without a task, later ADOPTED for one on the
 * board (`fleet task assign`), never received it: the container's
 * working-set carried the role prompt and zero task text, forever, until a
 * human typed a prompt at it by hand.
 *
 * `deps.resolveAssignedBrief` closes that gap: whenever the caller supplied
 * no `briefPrompt`, this asks the BOARD itself which open task currently
 * carries this studio's `studio:<id>` label, rather than requiring a task
 * number nobody here has. `cfg.briefPrompt ?? ...` means a caller-supplied
 * brief always wins and the board is never even queried in that case — the
 * spawn/operator-provision paths are completely unaffected.
 *
 * Queried against `workRepoSlug`, NOT `fleetRepoSlug`: per this file's own
 * P4a header and `resolveWorkRepoSlug`'s doc comment, "board repo = repo
 * being worked" (§5), which on a recycle is `existing.repoSlug` — the fleet's
 * OWN repo only when nothing else was ever bound. This function has no access
 * to `existing` (only `runProvision` does), which is exactly why the resolved
 * value is a parameter here rather than re-derived — `runProvision` already
 * computes it, one call before this one.
 *
 * The studio id is `buildStudioId(cfg)` (ids.ts) — the SAME formula
 * `runProvision` computes as its own local `id`. Recomputed here rather than
 * threaded through as yet another parameter: it is a one-line pure function
 * of fields `cfg` already carries, not a stateful value that could drift.
 * Issue #269: `cfg.instance` is one of those fields, so this reads instance
 * N's assigned task rather than instance 1's.
 */
export async function resolveBringupEnv(
  deps: ProvisionDeps, cfg: ProvisionConfig, fleetRepoSlug: string, workRepoSlug: string,
): Promise<{ bringupEnv: RoleEnv | StudioEnv; keepAlive: boolean; houseRulesOverlayNote: string | null }> {
  const fleetJsonText = await deps.fetchBlueprintFile(fleetRepoSlug, FLEET_JSON_PATH, FLEET_JSON_DEFAULT_REF);
  const fleet = parseFleetJson(fleetJsonText);
  const ref = cfg.blueprintRef ?? fleet.blueprint.ref;

  const briefPrompt = cfg.briefPrompt ?? await deps.resolveAssignedBrief?.(buildStudioId(cfg), workRepoSlug);

  // Issue #330 round 2: resolved ONCE per call, off deps.opsRepo (do.ts's
  // deps() wires it from resolveOpsRepo(this.env)) — NOT from
  // fleet.blueprint.repo/ref like every other fetch in this function, since
  // the whole point of this fix is that the overlay no longer lives
  // anywhere near the (soon-public) blueprint repo.
  const opsOverlay = await resolveOperatorHouseRules(deps, deps.opsRepo ?? null);

  const studio = await tryFetchStudio(deps, fleet.blueprint.repo, cfg.role, ref);
  if (studio !== null) {
    const members = await listStudioMembers(deps, fleet.blueprint.repo, cfg.role, ref);
    // The maestro authorizes junior use; it never uses it. Its own session
    // gets neither the skill nor the rule (studio.md "Junior — your call").
    //
    // Checked against BOTH `cfg.role` (the id that actually selected this
    // studio.md -- `tryFetchStudio`'s own `name` argument, and the same
    // literal role identifier spawn.ts/do.ts already gate maestro behaviour
    // on elsewhere) and `studio.name` (the file's own frontmatter, which
    // studio-blueprint.ts documents as "matches its directory name" but
    // never actually enforces against it anywhere in this file). A studio.md
    // fetched via role "maestro" whose frontmatter `name:` field has drifted
    // from "maestro" -- an operator rename, or any other mismatch -- must
    // still be excluded: `cfg.role` alone already guards that case, and
    // `studio.name` is kept as a second, independent signal rather than
    // trusted alone, since blueprint content is comparatively easy to edit
    // and this exclusion is a real safety property, not a display nicety.
    const isMaestro = cfg.role === "maestro" || studio.name === "maestro";
    const junior = !isMaestro && deps.juniorEnabled?.(workRepoSlug) === true;
    // "junior" is stripped out of the blueprint-parsed skills list
    // UNCONDITIONALLY, then re-added only when `junior` above says so. Never
    // the reverse (pass `studio` through untouched when not authorized):
    // `studio.skills` came straight off studio.md frontmatter
    // (parseSimpleArray, no allow-list) via `tryFetchStudio`, so a typo, a
    // bad merge, or anyone with blueprint-repo write access could put
    // "junior" directly in ANY studio's (including the maestro's) skills
    // array and, without this filter, it would materialize into the
    // container regardless of cfg.role/studio.name/FLEET_JUNIOR. Filtering
    // first means blueprint content alone can never decide this; only
    // `junior` (computed above from server-side signals) can.
    const skills = studio.skills.filter((s) => s !== "junior");
    const finalSkills = junior ? [...skills, "junior"] : skills;
    return {
      bringupEnv: {
        ...studioBringupEnv(
          { ...studio, skills: finalSkills },
          members,
          composePromptBlocks(composePromptBlocks(junior ? JUNIOR_HOUSE_RULE : undefined, cfg.projectCard), briefPrompt),
          await resolveMemoryIndex(deps),
          opsOverlay.text,
        ),
        BLUEPRINT_REPO: fleet.blueprint.repo,
        BLUEPRINT_REF: ref,
      },
      keepAlive: studio.keep_alive,
      houseRulesOverlayNote: opsOverlay.note,
    };
  }

  // --- role path, unchanged since before Task 7 ---
  assertRoleInFleet(fleet, cfg.role);
  const roleMdText = await deps.fetchBlueprintFile(fleet.blueprint.repo, roleFilePath(cfg.role), ref);
  const role = parseRoleFile(roleMdText);

  await deps.fetchBlueprintFile(fleet.blueprint.repo, ORG_JSON_PATH, ref);

  return {
    houseRulesOverlayNote: opsOverlay.note,
    bringupEnv: roleBringupEnv(
      role, composePromptBlocks(cfg.projectCard, briefPrompt),
      await resolveMemoryIndex(deps),
      opsOverlay.text,
    ),
    keepAlive: role.keep_alive,
  };
}

// --- Task 3 (P2 plane 2): fresh-container session restore -------------------
// Runs inside runProvision, AFTER the clone succeeds and BEFORE bring-up —
// bring-up's own restore-untar step (container/studio-bringup.sh) needs the
// chunked parts already sitting on disk, and claude's `--continue` (also
// bring-up) needs the untarred `~/.claude/projects` to already exist by the
// time it checks for it. Wrapped in its OWN try/catch at the runProvision
// call site (not this function's), deliberately separate from the
// clone/bring-up try/catch above: a restore failure must never turn into a
// "degraded" status — the design's own ruling is "provision proceeds fresh,
// logged" — whereas a clone/bring-up failure is exactly what SHOULD degrade.

export const SESSION_RESTORE_DIR = "/workspace/.session-restore";

/** Zero-padded to 2 digits ("part-NN", the design's own literal naming) —
 *  SESSION_TOTAL_MAX (32 MiB) / SESSION_SINGLE_READ_MAX (4 MiB) bounds the
 *  real part count to at most 8, well inside 2-digit range. */
export function restorePartPath(index: number): string {
  return `${SESSION_RESTORE_DIR}/part-${String(index).padStart(2, "0")}`;
}

/**
 * Fix round (Critical, C2 — reviewer-reproduced): written LAST, only after
 * every part write below has succeeded. Its mere PRESENCE is
 * container/studio-bringup.sh's own signal that a restore write is
 * complete — parts without a manifest (an interrupted write) must never be
 * trusted. Compact JSON (`JSON.stringify` with no indentation — no
 * whitespace between keys/colons/values), on purpose: bring-up parses it
 * with `sed`, not `jq` (not guaranteed present in the container image), and
 * the sed patterns there depend on this exact compact shape.
 */
export const SESSION_RESTORE_MANIFEST_PATH = `${SESSION_RESTORE_DIR}/manifest.json`;

/**
 * Is this container still FRESH — i.e. does it hold no claude state of its
 * own, so restoring the R2 archive over it can clobber nothing? That is the
 * only question this command answers, and directory existence is the right
 * test for it: `~/.claude/projects` exists iff claude (or a previous
 * restore) has already put something there.
 *
 * NOT the same question as "can claude resume a conversation", and issue #54
 * is what forced the distinction. This comment used to claim the launch
 * guard was the identical test reused verbatim, and it was — both keyed on
 * the directory, and both were wrong together. The launch guard now tests
 * for a session FILE under the launch cwd's own project dir
 * (`claude_has_conversation`, container/studio-bringup.sh): a directory
 * holding only `memory/` is a container that is NOT fresh AND has nothing to
 * continue, and those two answers must be allowed to differ. Deliberately
 * left keyed on the directory, so it keeps agreeing with bring-up's own
 * restore-freshness entry guard (`[ ! -d ~/.claude/projects ]`, same file) —
 * the guard it actually has to agree with.
 *
 * Same `~` (`$HOME` = `/root` for this container's root user) resolution
 * bring-up uses, rather than a hard-coded `/root/...` path.
 */
export const CONTAINER_HAS_PROJECTS_CMD = "[ -d ~/.claude/projects ] && echo yes || echo no";

/** sha256 of the full (pre-chunking) tar, hex-encoded — embedded in the
 *  manifest so bring-up can verify the reassembled parts are byte-identical
 *  to what the Worker actually fetched from R2, not just the right total
 *  size (see runSessionRestore's own doc comment for why total-bytes alone
 *  is not enough). Computed Worker-side via the standard Web Crypto API
 *  (available in the Workers runtime; no extra dependency). */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decides + performs the fresh-container restore: checks the container
 * first (one cheap exec) and ONLY calls `deps.r2Get` when it's fresh — a
 * container that already has `~/.claude/projects` never triggers an R2 read
 * at all, avoiding a wasted fetch of a potentially-large tar on every
 * ordinary (already-warm) re-provision call. `restorePlan` (session-sync.ts)
 * is still the single source of truth for the actual restore/skip decision,
 * called here with BOTH real booleans once they're known.
 *
 * `deps.r2Get`/`deps.writeFile` absent (see ProvisionDeps's own doc comment)
 * short-circuits to skip before any exec at all — the same posture a real
 * restore failure gets, just without even trying.
 *
 * On "restore", the fetched tar is sliced into SESSION_SINGLE_READ_MAX-sized
 * parts and written sequentially to `restorePartPath(0..n)` via
 * `deps.writeFile` (the same sbWriteFile-shaped transport paste.ts uses),
 * THEN a manifest (partCount/totalBytes/sha256, see
 * SESSION_RESTORE_MANIFEST_PATH's own doc comment) — bring-up's own
 * restore-untar step verifies against it before trusting anything.
 *
 * Fix round (Critical C2 / Important I2 — reviewer-reproduced): a torn
 * multi-part transfer (a part write throws partway through — network blip,
 * container OOM, anything) used to leave a PARTIAL, unmarked set of parts
 * sitting in SESSION_RESTORE_DIR, silently reused by the NEXT bring-up call
 * (a restart) that ran before the studio had a chance to complete a fresh
 * sync — bring-up would then extract a truncated tar, partially populating
 * `~/.claude`. Fixed on this side by construction: any exception between the
 * first `mkdir` and the manifest write (inclusive) triggers `rm -rf` of the
 * WHOLE restore dir before the error propagates, so a torn attempt can never
 * leave a stale, ambiguous part set behind for a later bring-up to
 * misinterpret — the next provision/restart attempt starts from a clean
 * slate. This function does not itself swallow the error (see
 * runProvision's own call site for the try/catch that does) — cleanup, then
 * rethrow, same "never catch what you can't also correctly resume" posture
 * this file uses elsewhere.
 */
export async function runSessionRestore(
  deps: ProvisionDeps, id: string,
): Promise<{ plan: RestoreAction; parts: number; restore: RestoreOutcome; source?: string }> {
  if (!deps.r2Get || !deps.writeFile) return { plan: "skip", parts: 0, restore: "not-attempted" };

  const checkRes = await deps.sbExec(CONTAINER_HAS_PROJECTS_CMD);
  // #110 review: a killed check answers nothing. Reading its empty stdout as
  // "no" would restore an old tar over a container that may have history.
  if (isDeadlineExit(checkRes.code)) {
    throw new Error(`session restore skipped: ~/.claude/projects check was killed (exit ${checkRes.code}), state unknown`);
  }
  const containerHasProjects = checkRes.stdout.trim() === "yes";
  const latest = containerHasProjects ? null : await deps.r2Get(sessionLatestKey(id));
  const chosen = containerHasProjects ? null : await pickRestoreSource(deps, id, latest);
  const tarBytes = chosen ? chosen.bytes : latest;
  const plan = restorePlan(tarBytes !== null, containerHasProjects);
  const restoreOutcome: RestoreOutcome =
    containerHasProjects ? "skip:has-projects" : tarBytes === null ? "skip:no-snapshot" : "restored";
  if (plan === "skip" || tarBytes === null) return { plan, parts: 0, restore: restoreOutcome };

  const numParts = Math.max(1, Math.ceil(tarBytes.length / SESSION_SINGLE_READ_MAX));
  try {
    // Fix round (C2 adjacent — closes a gap the manifest fix would otherwise
    // leave open): clear the dir FIRST, every attempt, success or a retry
    // after a prior failure alike. Without this, a leftover part file from
    // an EARLIER attempt (one whose own catch-block cleanup below never
    // reached the container — e.g. the exec channel itself died) could
    // survive alongside this attempt's freshly-written parts. Bring-up's own
    // guard treats "parts present, no manifest" as nothing-to-restore (so a
    // stale leftover alone is harmless) — but if THIS attempt later
    // succeeds and writes fewer parts than the stale leftover (a smaller
    // snapshot than before), the leftover's extra part files would inflate
    // `find ... | wc -l` past this attempt's own correct manifest.partCount,
    // turning a perfectly valid new restore into a false verification
    // failure on the bring-up side.
    await deps.sbExec(`rm -rf ${SESSION_RESTORE_DIR} && mkdir -p ${SESSION_RESTORE_DIR}`);
    for (let i = 0; i < numParts; i++) {
      const start = i * SESSION_SINGLE_READ_MAX;
      await deps.writeFile(restorePartPath(i), tarBytes.subarray(start, start + SESSION_SINGLE_READ_MAX));
    }
    // Issue #94: the guard's baseline follows the restored snapshot, set
    // before the manifest makes the restore visible to bring-up.
    if (chosen) await deps.recordRestoredMark?.(chosen.mark);
    const sha256 = await sha256Hex(tarBytes);
    const manifestJson = JSON.stringify({ partCount: numParts, totalBytes: tarBytes.length, sha256 });
    await deps.writeFile(SESSION_RESTORE_MANIFEST_PATH, new TextEncoder().encode(manifestJson));
  } catch (err) {
    await deps.sbExec(`rm -rf ${SESSION_RESTORE_DIR}`);
    throw err;
  }
  if (!chosen) return { plan, parts: numParts, restore: restoreOutcome };
  console.warn(`studio ${id}: session restored from ${chosen.source}`);
  return { plan, parts: numParts, restore: restoreOutcome, source: chosen.source };
}

/**
 * Issue #94: which snapshot to restore. `latest` whenever it holds a session:
 * a keeper is older by construction, and `latest` lacking the keeper's newest
 * file most often means the studio moved on to a new session (no line count
 * tells "blank" from "moved on"), so a keeper never replaces a `latest` that
 * holds one — and is not even read then (#118 review: restore peak stays one
 * tar). The newest daily keeper only when `latest` is missing, unreadable, or
 * holds no jsonl at all — and the keeper itself holds one. Any failure
 * listing or reading keepers is logged and `latest` is used. `null` when
 * `deps.r2List` is not wired (latest only, as before).
 */
async function pickRestoreSource(
  deps: ProvisionDeps, id: string, latest: Uint8Array<ArrayBuffer> | null,
): Promise<{ bytes: Uint8Array<ArrayBuffer> | null; source: string; mark: SessionMark | null } | null> {
  if (!deps.r2List || !deps.r2Get) return null;
  // Board #140 (#94 follow-up, verifier nit): ONLY a genuine gzip/tar format
  // error (latest is actually corrupt/unreadable) may fall through to the
  // keeper below — anything else (a transient Worker exception, a future bug
  // elsewhere in the parse) propagates and aborts the restore entirely
  // (runProvision/runRestart's own try/catch around runSessionRestore
  // already treats that as "proceed fresh, logged"). Swallowing every throw
  // used to mean a one-off blip silently swapped a perfectly good `latest`
  // for stale daily-keeper history.
  const latestStats = latest ? await sessionStats(latest).catch((err) => {
    if (err instanceof SessionArchiveFormatError) return null;
    throw err;
  }) : null;
  const latestMark = latestStats ? newestMark(latestStats) : null;
  const fromLatest = { bytes: latest, source: "latest", mark: latestMark };
  if (latestMark) return fromLatest;
  try {
    const keeperKey = dailyKeeperKeys(await deps.r2List(sessionDailyPrefix(id))).at(-1);
    const keeper = keeperKey ? await deps.r2Get(keeperKey) : null;
    if (!keeperKey || !keeper) return fromLatest;
    const keeperMark = newestMark(await sessionStats(keeper).catch(() => ({})));
    if (!keeperMark) return fromLatest;
    const keeperDate = keeperKey.slice(-"yyyy-mm-dd.tar.gz".length, -".tar.gz".length);
    return { bytes: keeper, source: `daily ${keeperDate}`, mark: keeperMark };
  } catch (err) {
    console.error(`studio ${id}: daily keeper lookup failed, restoring latest`, err);
    return fromLatest;
  }
}

/**
 * Board task #149 — the blueprint clone's own credential, mint+write. Mirrors
 * runSessionRestore's own posture just above: `deps.writeBlueprintCredential`
 * already returns an ok/error union rather than throwing, and this function
 * itself never lets a failure escape as an exception — deliberately NOT
 * folded into runProvision's/runRestart's outer try/catch, because a
 * mint/write failure here must never degrade the studio the way a
 * clone/bring-up failure does. This is the mint-side mirror of
 * studio-bringup.sh's own already-shipped tolerance for a blueprint CLONE
 * failure (`|| echo ... >&2`, container/studio-bringup.sh:339-341): an empty
 * skill list is the accepted, already-shipped failure mode for that symptom,
 * not something this fix should make WORSE by degrading the whole studio
 * over it. No telegram alert either, for the same reason — the clone failure
 * this precedes doesn't alert, so alerting on the mint side while the clone
 * side stays silent would draw a new, inconsistent severity line around one
 * half of the same symptom.
 *
 * Skips entirely on the ROLE path: a plain RoleEnv carries no BLUEPRINT_REPO
 * field at all, which means studio-bringup.sh will never attempt a blueprint
 * clone for it, so there is nothing here to authenticate.
 */
async function maybeWriteBlueprintCredential(
  deps: ProvisionDeps, bringupEnv: RoleEnv | StudioEnv, id: string, workRepoSlug: string,
): Promise<void> {
  if (!("BLUEPRINT_REPO" in bringupEnv)) return;
  const cred = await deps.writeBlueprintCredential?.(bringupEnv.BLUEPRINT_REPO, id, workRepoSlug);
  if (cred && !cred.ok) {
    console.error(`studio ${id}: blueprint credential write failed, skills may be missing`, cred.error);
  }
}

/**
 * Issue #253 — applies push.default/branch.autoSetupMerge + the
 * /usr/local/bin/git wrapper (credentials.ts's studioGitSafetyCmd) on EVERY
 * provision and EVERY restart. A rollout-replaced container comes up with a
 * fresh filesystem, so the wrapper has to be reinstalled every time or the
 * guard silently is not there at all.
 *
 * Unconditionally, too (unlike maybeWriteBlueprintCredential just
 * above, this is not gated on the bringup env carrying BLUEPRINT_REPO — a
 * plain role studio still gets its own git config). Same never-degrade
 * posture: a failure here is logged and provisioning proceeds, for the
 * reasoning ProvisionDeps.applyStudioGitSafety's own doc comment (this
 * file) gives.
 */
async function applyStudioGitSafety(deps: ProvisionDeps, id: string): Promise<void> {
  const res = await deps.applyStudioGitSafety?.();
  if (res && !res.ok) {
    console.error(`studio ${id}: git safety config/wrapper install failed`, res.error);
  }
}

/**
 * Issue #1: the public-repo leak gate, on EVERY provision and restart (a
 * replaced container has a fresh filesystem). Installs scanner + gh wrapper,
 * then writes the gate file: "off" for a private work repo, else the ops-repo
 * denylist. Written via writeFile, never a command string, so no term reaches
 * an exec or a log. When no denylist can be delivered, any stale gate file is
 * REMOVED so the wrappers refuse every public write (fail closed).
 *
 * Never throws, never degrades the studio. Returns a row note (never a term)
 * or null. Skipped entirely when `installLeakGate` is absent.
 */
async function applyLeakGate(deps: ProvisionDeps, id: string, workRepoSlug: string): Promise<string | null> {
  if (!deps.installLeakGate) return null;
  const notes: string[] = [];
  const install = await deps.installLeakGate();
  if (!install.ok) {
    console.error(`studio ${id}: leak gate install failed`, install.error);
    // Fail closed: an ungated gh must not run. Block it; a later install restores it.
    let blocked = false;
    try {
      const res = await deps.sbExec(ghBlockCmd());
      blocked = res.code === 0;
      if (!blocked) console.error(`studio ${id}: gh block failed (${res.code})`, res.stderr.slice(0, 500));
    } catch (err) {
      console.error(`studio ${id}: gh block failed`, err instanceof Error ? err.message : String(err));
    }
    notes.push(blocked
      ? "leak gate: scanner/gh wrapper install failed -- gh is blocked in this studio until the next restart re-installs the gate."
      : "leak gate: scanner/gh wrapper install failed and the gh block also failed -- public gh writes are NOT gated in this studio.");
  }

  let isPrivate = false;
  try {
    isPrivate = (await deps.workRepoIsPrivate?.(workRepoSlug)) ?? false;
  } catch (err) {
    console.error(`studio ${id}: leak gate privacy lookup failed, treating ${workRepoSlug} as public`,
      err instanceof Error ? err.message : String(err));
  }

  // Issue #7. A failed exec leaves pushes pointed at GitHub on the read-only
  // token: they fail, they never leak. Noted on the row.
  if (deps.writeProxy) {
    const mode = deps.writeProxy.mode(workRepoSlug, isPrivate);
    let ok = false;
    try {
      const res = await deps.sbExec(writeProxyConfigCmd(mode, deps.writeProxy.workerUrl));
      ok = res.code === 0;
      if (!ok) console.error(`studio ${id}: write proxy config failed (${res.code})`, res.stderr.slice(0, 500));
    } catch (err) {
      console.error(`studio ${id}: write proxy config failed`, err instanceof Error ? err.message : String(err));
    }
    if (!ok) {
      notes.push(`write proxy: git config failed (${mode}) -- pushes and gh writes from this studio fail until the next restart.`);
    }
  }

  let content: string | null = null;
  let reason: string;
  if (isPrivate) {
    content = denylistFileContent({ off: `work repo ${workRepoSlug} is private` });
    reason = "";
  } else if (deps.opsRepo == null || !deps.fetchOpsFile) {
    reason = "FLEET_OPS_REPO is unset";
  } else {
    try {
      content = denylistFileContent({ patterns: parseDenylist(await deps.fetchOpsFile(OPS_DENYLIST_PATH, OPS_REPO_REF)) });
      reason = "";
    } catch (err) {
      // Class only: a parse error's message is safe, but keep terms off the row by construction.
      // A dialect error's message is built from an index alone (leak-gate.ts).
      reason = isNotFoundError(err) ? `${OPS_DENYLIST_PATH} not found`
        : err instanceof DenylistDialectError ? err.message
        : `${OPS_DENYLIST_PATH} unreadable or empty`;
    }
  }

  if (content !== null) {
    try {
      if (!deps.writeFile) throw new Error("no writeFile port");
      await deps.sbExec(`mkdir -p ${LEAK_DENYLIST_PATH.slice(0, LEAK_DENYLIST_PATH.lastIndexOf("/"))}`);
      await deps.writeFile(LEAK_DENYLIST_PATH, new TextEncoder().encode(content));
    } catch (err) {
      console.error(`studio ${id}: leak gate file write failed`, err instanceof Error ? err.message : String(err));
      content = null;
      reason = "gate file write failed";
    }
  }

  if (content === null) {
    try {
      await deps.sbExec(`rm -f ${LEAK_DENYLIST_PATH}`);
    } catch (err) {
      console.error(`studio ${id}: leak gate stale file removal failed`, err instanceof Error ? err.message : String(err));
    }
    notes.push(
      `leak gate: no denylist (${reason}) -- every public write in this studio is refused. ` +
      `Add ${OPS_DENYLIST_PATH} to FLEET_OPS_REPO.`,
    );
  }
  return notes.length === 0 ? null : notes.join(" ");
}

/**
 * Pure provisioning state machine: resolve the blueprint, guarded clone,
 * then bring-up (with the resolved ROLE_PROMPT_B64/ROLE_ALLOWED_TOOLS/
 * ROLE_EFFORT env),
 * in that order, every call — see guardedCloneCmd's doc comment for why
 * there is no "skip the clone" branch. `existing` (or null on a cold DO)
 * seeds the returned status's id/tailscaleHost so a re-provision doesn't
 * lose fields bring-up itself won't repopulate.
 *
 * Returns the resolved `roleEnv`/`keepAlive` alongside the status (both null
 * when resolution itself failed) so `provisionWithStorage` can persist them
 * for restart to reuse — see ROLE_ENV_KEY/KEEP_ALIVE_KEY. Returned rather
 * than written here because this function is deliberately storage-free; the
 * wrapper owns every write.
 *
 * Fleet Spawn P3, Task 4 (R-P3-6): `deps.setKeepAlive` — when the role
 * resolves — is called with its `keep_alive` right here, as early as the
 * value can possibly be known (immediately after `resolveBringupEnv`,
 * before the clone). This replaces do.ts's old unconditional
 * `sbSetKeepAlive(this, true)` call, which ran BEFORE this function was ever
 * invoked and so could not have known the role yet; see do.ts's provision()
 * for the removed call site. Folding the toggle into this function's own
 * try/catch is a deliberate, considered behavior change from that: a
 * setKeepAlive failure now degrades the studio the same way a clone/bring-up
 * failure does, rather than throwing out of provision() entirely with no
 * status ever recorded — strictly safer, and the natural place for it once
 * the call lives beside everything else provisioning does.
 *
 * Fleet Spawn P3, Task 2: `spawnTokenHash` is deliberately NOT a parameter
 * here. do.ts's ensureSpawnToken publishes it before this function is ever
 * called, and this function carries it forward through the `existing` spread
 * like any other field — see ensureSpawnToken's own doc comment for the
 * ordering invariant that depends on it staying out of this signature.
 */
/**
 * The WORK repo — what a studio clones — in three-step precedence, most
 * explicit first. Exported (P6a) because it now answers TWO questions, and
 * they must not be allowed to disagree: which repo gets cloned, and which
 * owner's credential the container is given for it (src/github/auth.ts routes
 * per owner). do.ts calls this before the credential write for exactly that
 * reason — a container handed the org's App token while cloning a personal
 * repo would fail at the clone with a credential error that names nothing
 * useful.
 *
 * The middle step is what makes recycle and a bodyless re-provision safe: both
 * run with no `cfg.repoSlug` at all, and without reading the binding back off
 * the stored status they would silently fall back to the fleet default and
 * re-clone the WRONG repo into a beta studio. The last step is the pre-P4a
 * behaviour, unchanged, and is what every existing `websites` studio still
 * lands on.
 */
export function resolveWorkRepoSlug(
  cfg: ProvisionConfig | null, existing: StudioStatus | null, fleetRepoSlug: string,
): string {
  return cfg?.repoSlug ?? existing?.repoSlug ?? fleetRepoSlug;
}

export async function runProvision(
  deps: ProvisionDeps,
  cfg: ProvisionConfig,
  fleetRepoSlug: string,
  existing: StudioStatus | null,
): Promise<{
  status: StudioStatus; roleEnv: RoleEnv | StudioEnv | null; keepAlive: boolean | null;
  /** Issue #37: a --fresh-session bring-up confirmed it moved a session aside. */
  freshSessionMoved?: boolean;
  /** Issue #100 review round 1: see freshSessionConfirmed's own doc comment
   *  above (local variable of the same name) -- true iff the flag was
   *  actually honored (a marker line printed, no failed entries), which is
   *  NOT the same thing as freshSessionMoved (false both when unconfirmed
   *  AND when confirmed-but-nothing-to-move). */
  freshSessionConfirmed?: boolean;
}> {
  const id = buildStudioId(cfg);
  // Dynamic repo selection (P4a) — see resolveWorkRepoSlug's own doc comment
  // for the precedence and why each step is there.
  const workRepoSlug = resolveWorkRepoSlug(cfg, existing, fleetRepoSlug);
  let status: StudioStatus = {
    ...(existing ?? freshStatus(id)),
    state: "provisioning",
    ...(cfg.spawnedBy ? { spawnedBy: cfg.spawnedBy } : {}),
    // Bound on every provision, not only the first: this is the record of
    // which repo the container was actually pointed at, and it has to stay
    // true across a re-provision that moved it.
    repoSlug: workRepoSlug,
    containerRunningSince: null,
  };
  // Task 7: widened RoleEnv -> RoleEnv | StudioEnv — resolveBringupEnv now
  // returns either shape; this just carries whichever one through to the
  // caller/storage unchanged.
  let roleEnv: RoleEnv | StudioEnv | null = null;
  let keepAlive: boolean | null = null;
  // Issue #330 round 2, item 2: captured here (not just inside `resolved`)
  // so BOTH the success assignment below AND the catch block's degraded
  // status can fold it into `status.error` — a maestro must see this note
  // regardless of whether a LATER step in this same provision also fails.
  let houseRulesOverlayNote: string | null = null;
  // Issue #1: same row-note channel as houseRulesOverlayNote.
  let leakGateNote: string | null = null;
  // Issue #28: where a --fresh-session bring-up put the old session. Same
  // channel: a discard nobody is told about is the thing this must never be.
  let freshSessionNote: string | null = null;
  let freshSessionMoved = false;
  // Issue #100 review round 1: distinct from `freshSessionMoved` above, which
  // is ALSO `false` for the legitimate "flag honored, nothing to move" case
  // (`moved` is `[]`) -- indistinguishable there from "never confirmed at
  // all" (`moved === null`, no marker line) or "every move failed" without
  // this separate flag. `provisionWithStorage` needs exactly this signal to
  // decide whether FRESH_SESSION_PENDING_KEY may clear: true iff bring-up
  // printed at least one FLEET_SESSION_FRESH line and none of them failed
  // (empty array counts as confirmed -- there was nothing to move).
  let freshSessionConfirmed = false;

  try {
    const resolved = await resolveBringupEnv(deps, cfg, fleetRepoSlug, workRepoSlug);
    roleEnv = resolved.bringupEnv;
    keepAlive = resolved.keepAlive;
    houseRulesOverlayNote = resolved.houseRulesOverlayNote;
    await deps.setKeepAlive?.(resolved.keepAlive);
    // Board task #149: the blueprint clone below (studio-bringup.sh) needs
    // its OWN credential before it runs, same reasoning do.ts's provision()
    // already applies to the work-repo credential and the clone it precedes.
    await maybeWriteBlueprintCredential(deps, resolved.bringupEnv, id, workRepoSlug);
    // Issue #253: git-safety config + the git wrapper, before the clone below
    // ever gives this container something to push.
    await applyStudioGitSafety(deps, id);
    leakGateNote = await applyLeakGate(deps, id, workRepoSlug);

    const cloneRes = await deps.sbExec(guardedCloneCmd(workRepoSlug, `/workspace/${cfg.repo}`));
    if (cloneRes.code !== 0) {
      throw new Error(`clone failed (${cloneRes.code}): ${cloneRes.stderr.slice(0, 500)}`);
    }

    // Board issue #9: own try/catch, same reasoning as the session-restore
    // one immediately below — a rescue-branch-discovery failure (network
    // blip, no rescue branches, whatever) must never degrade provisioning.
    // discoverRescueRefsCmd's own shell is already `|| true`-guarded so its
    // exec practically never returns nonzero either; this catches the case
    // sbExec itself throws (e.g. the sandbox connection drops mid-call).
    try {
      // Issue #30: a target failure must not cost origin's discovery.
      let target: RescueTarget = {};
      try {
        target = (await deps.rescueTarget?.(workRepoSlug)) ?? {};
      } catch (err) {
        console.error(`studio ${id}: rescue target lookup failed, discovering from origin only`,
          err instanceof Error ? err.message : String(err));
      }
      const res = await deps.sbExec(
        discoverRescueRefsCmd(`/workspace/${cfg.repo}`, id, undefined, { remoteUrl: target.remoteUrl }), target.env);
      for (const line of res.stderr.split("\n")) {
        if (line.includes("WARNING") || line.includes("rescue discovery skipped")) console.error(`studio ${id}: ${line}`);
      }
    } catch (err) {
      console.error(
        `studio ${id}: rescue-branch discovery failed, proceeding without it`,
        err instanceof Error ? err.message : String(err),
      );
    }
    await refreshMemoryClone(deps, id, workRepoSlug);

    // Task 3 (P2 plane 2): own try/catch, deliberately NOT folded into this
    // function's outer one — a restore failure must never degrade
    // provisioning (design ruling: "provision proceeds fresh, logged"),
    // unlike a clone/bring-up failure just above/below, which SHOULD.
    let restoreOutcome: RestoreOutcome = "not-attempted";
    let restoreSource: string | null = null;
    try {
      const restoreResult = await runSessionRestore(deps, id);
      restoreOutcome = restoreResult.restore;
      restoreSource = restoreResult.source ?? null;
    } catch (err) {
      restoreOutcome = "failed";
      console.error(
        `studio ${id}: session restore failed, proceeding fresh`,
        err instanceof Error ? err.message : String(err),
      );
    }
    // Issue #85, maestro correction #10: `runProvision`'s return type stays
    // untouched (issue #90 also touches this function) — the restore outcome
    // reaches `provisionWithStorage` through this optional callback instead.
    // Board #250: `restoreSource` rides along as the callback's second
    // argument — see `ProvisionDeps.onRestoreOutcome`'s own doc comment.
    deps.onRestoreOutcome?.(restoreOutcome, restoreSource);

    // Board #350: same own-try/catch posture as the session restore just
    // above, right after it and before bring-up per the design's own stated
    // restore point — a failure here (network, an expired/invalid presign,
    // a corrupt object) must never degrade provisioning any more than a
    // session-restore failure does.
    try {
      const installCacheResult = await runInstallCacheRestore(deps, id, workRepoSlug, `/workspace/${cfg.repo}`);
      if (installCacheResult.attempted) {
        console.warn(`studio ${id}: install cache ${installCacheResult.outcome}`);
      }
    } catch (err) {
      console.error(`studio ${id}: install cache restore failed, proceeding without it`, err instanceof Error ? err.message : String(err));
    }

    // Issue #116: after the restore, before bring-up's --continue guard.
    // Issue #28: a fresh-session bring-up adopts nothing (bring-up moves the
    // old session aside instead), and the flag rides THIS exec's env only --
    // `resolved.bringupEnv` is what gets persisted and replayed on restart.
    let adoption = cfg.freshSession ? null : await adoptBeforeBringup(deps, cfg.repo);

    const bringupRes = await deps.sbExec(
      BRINGUP_CMD, cfg.freshSession ? { ...resolved.bringupEnv, FLEET_FRESH_SESSION: "1" } : resolved.bringupEnv,
    );
    if (bringupRes.code !== 0) {
      throw new Error(`bring-up failed (${bringupRes.code}): ${bringupRes.stderr.slice(0, 500)}`);
    }
    // Issue #146: on a fresh container it is bring-up's own adopt, after the
    // restore untar, that finds the session.
    adoption = keepAdopted(adoption, parseSessionAdoption(bringupRes.stdout, deps.now()));
    if (cfg.freshSession) {
      const moved = parseFreshSession(bringupRes.stdout);
      freshSessionNote = freshSessionNoteFor(moved, id);
      freshSessionMoved = moved !== null && moved.some((m) => !m.startsWith("failed "));
      // Issue #100 review round 1: see freshSessionConfirmed's own doc
      // comment above -- `moved !== null` (a marker line printed) and no
      // entry failed. `[]` (nothing to move) is confirmed; `null` or any
      // `failed ` entry is not.
      freshSessionConfirmed = moved !== null && !moved.some((m) => m.startsWith("failed "));
    }

    // Board issue #28 — the missing observation. `bringupRes.code === 0`
    // (and, above it, `cloneRes.code === 0`) prove those two execs ran to
    // completion SOMEWHERE; they do NOT prove the clone/materialization
    // they performed actually landed, durably, on the SAME container this
    // call is about to report as "running" — BRINGUP_CMD's own script does
    // not launch claude synchronously (see PROVISIONED_CHECK_TRIES' own doc
    // comment above: it `tmux send-keys`s the launch line, and since issue
    // #54 waits for the pane to actually be running claude before exiting 0
    // — a launch that dies immediately now exits 1 and lands in the `throw`
    // above), and a mid-provision container swap can make the clone
    // exec and this line disagree about which container's filesystem is
    // real. Measured live: a studio reporting `state: "running", error:
    // null` over a fresh, empty container — both execs genuinely returned
    // exit 0, just not against the disk this line is about to trust. A
    // cheap, synchronous, on-disk re-check closes the gap AT THIS POINT,
    // before success is ever reported: exit-code only (no stdout marker),
    // so it composes with every existing sbExec fake in this suite that
    // already answers `{code: 0, ...}` to any unrecognized command. Both
    // failures throw into the SAME catch block below that already degrades
    // a clone/bring-up failure — no new error-handling path, one more thing
    // that can throw into the existing, already-correct chain. Does NOT
    // catch a container swap that happens AFTER this call has already
    // returned "running" — a synchronous, provision-time check cannot see a
    // LATER event; that residual risk is named, not solved, here.
    //
    // Issue #38: the two assertions themselves moved to `verifyBringupLanded`
    // above, unchanged in what they check or in the words they fail with, so
    // that the RESTART path — where a rollout-replaced container comes up
    // under an existing DO, the case #29's own PR named as deliberately out
    // of scope — runs the identical check instead of a second, drifting copy
    // of it. The studio/role asymmetry below is preserved exactly: a plain
    // role never gets ~/.claude/agents at all (measured live:
    // websites--pilot, HOOK=0 SKILLS=0) and must not be failed over it.
    await verifyBringupLanded(
      deps, cfg.repo,
      "STUDIO_NAME" in resolved.bringupEnv && resolved.bringupEnv.STUDIO_NAME !== "",
    );

    // Issue #330 round 2, item 2: `houseRulesOverlayNote` rides in `error`
    // even on a SUCCESSFUL provision — `state` stays "running" regardless,
    // same "error is a general notice channel, not only a failure flag"
    // convention runRestart's own `cloneRefusal` join already establishes
    // for a different non-fatal misconfiguration (see that function's own
    // status assignment). `null` when there is nothing to report — the
    // ordinary case for every operator who never set FLEET_OPS_REPO, or
    // whose overlay loaded fine.
    // Side effect (#330 round 4): a non-null note here means do.ts's heal never
    // stamps BARE_SELF_HEALED on this row -- it only writes over `error: null`.
    status = {
      ...status, state: "running", lastRefresh: deps.now(),
      error: [houseRulesOverlayNote, leakGateNote, freshSessionNote].filter((part) => part !== null).join(" | ") || null,
      sessionAdoption: adoptionRecord(adoption),
    };
  } catch (err) {
    // Review round 1 (issue #100): server-side diagnostic ONLY, logged
    // before any redaction — every OTHER nested try/catch in this function
    // (rescue-branch discovery, install-cache restore, session restore) already
    // logs its raw error via console.error; this outer catch-all, the one the
    // historical 500 this issue investigated actually disappeared into, did
    // not. Does not change what the operator sees: `status.error` below is
    // still built from the redacted message exactly as before.
    console.error(`studio ${id}: provision failed`, err instanceof Error ? (err.stack ?? err.message) : String(err));
    // Scrubbed immediately, at the point the raw message is first held —
    // simpler and strictly safer than container/server.ts's "raw in
    // storage, scrub only at the output boundary" split (which exists
    // there because OTHER internal consumers need the exact raw value; no
    // such consumer exists for StudioStatus.error). recordStudio and the
    // returned value are therefore both already clean. (registry.ts's
    // recordStudio also scrubs on its own now — review round 2, Spec 5 —
    // so this is belt and braces, not the only line of defence.)
    //
    // Issue #330 round 2: `houseRulesOverlayNote` rides along here too,
    // same "both parts named" reasoning runRestart's own two-part `error`
    // join uses — a later step failing must not erase an earlier,
    // already-known misconfiguration an operator would otherwise lose.
    status = {
      ...status, state: "degraded",
      error: [houseRulesOverlayNote, leakGateNote, freshSessionNote, redactSecrets(err instanceof Error ? err.message : String(err))]
        .filter((part) => part !== null).join(" | ") || null,
      sessionAdoption: null,
    };
  }

  await deps.recordStudio(status);
  return {
    status, roleEnv, keepAlive,
    ...(freshSessionMoved ? { freshSessionMoved } : {}),
    ...(freshSessionConfirmed ? { freshSessionConfirmed } : {}),
  };
}

/**
 * The degraded-status message a restart produces when nothing was ever
 * persisted under ROLE_ENV_KEY. Exported so the test asserts on the same
 * string the operator reads, not a re-typed approximation of it.
 */
export const NO_ROLE_ENV_ERROR =
  "restart aborted: no role env stored for this studio (never provisioned, " +
  "or provisioned before the role env was persisted). Bring-up would launch " +
  "claude with no system prompt and no tool policy. Fix: POST /studio/<id>/provision";

/** Bring-up only (no clone) — restart heals/recreates the tmux session
 *  without re-touching the checkout. Same success/failure shape as
 *  runProvision's tail. `idFallback` covers the "never provisioned" edge:
 *  restartStudio() takes no config (brief's interface), so on a cold DO
 *  with nothing in storage, the caller's own `this.ctx.id.name` is the only
 *  source of an id.
 *
 *  `roleEnv` is whatever provision persisted (ROLE_ENV_KEY), read by
 *  `restartWithStorage` and passed straight through to bring-up — the same
 *  env the original provision used. `null` means nothing was ever stored,
 *  and this function then degrades WITHOUT running bring-up at all: the
 *  script's own `${ROLE_PROMPT_B64:-}` / `${ROLE_ALLOWED_TOOLS:-}` defaults
 *  mean an env-less bring-up does not fail loudly, it launches claude with
 *  an empty system prompt and an empty tool policy and reports success. A
 *  studio silently running with no role is strictly worse than a studio that
 *  says why it won't start, so this is the one place restart refuses to
 *  proceed instead of degrading after the fact.
 *
 *  Fleet Spawn P3, Task 4 (R-P3-6): `keepAlive` is whatever
 *  `restartWithStorage` read back from KEEP_ALIVE_KEY (defaulting `true` for
 *  a studio that predates this feature — see that function's own doc
 *  comment), passed straight to `deps.setKeepAlive` on the SAME bring-up
 *  path `roleEnv` gates — a restart that refuses to run bring-up at all (no
 *  stored role env) has no container to toggle keepAlive on, so it is
 *  skipped there too, deliberately mirroring `roleEnv`'s own null-guard
 *  rather than running unconditionally before it. */
export async function runRestart(
  deps: ProvisionDeps, existing: StudioStatus | null, idFallback: string, roleEnv: RoleEnv | StudioEnv | null,
  keepAlive: boolean, fleetRepoSlug: string,
): Promise<StudioStatus> {
  let status: StudioStatus = { ...(existing ?? freshStatus(idFallback)), state: "provisioning" };
  if (roleEnv === null) {
    status = { ...status, state: "degraded", error: NO_ROLE_ENV_ERROR, sessionAdoption: null };
    await deps.recordStudio(status);
    return status;
  }
  // Issue #38 part 2: the repo segment of this studio's own id IS the
  // directory the checkout lives in (`/workspace/<repo>`, the same
  // `cfg.repo` runProvision clones into). Read from the id rather than
  // threaded in as a new parameter, so `restartWithStorage`'s signature —
  // called directly by test/studio.routes.test.ts's fake StudioDO stub —
  // stays untouched.
  const repo = parseStudioId(status.id)?.repo ?? null;
  const isStudio = "STUDIO_NAME" in roleEnv && roleEnv.STUDIO_NAME !== "";
  let firstFailure: string | null = null;
  // Survives into the success path below for the same reason `firstFailure`
  // does: a restart that came up "fine" while refusing to put the checkout
  // back is not fine, and the row is the only place an operator looks.
  let cloneRefusal: string | null = null;
  // Issue #1: rides `error` like cloneRefusal.
  let leakGateNote: string | null = null;

  try {
    await deps.setKeepAlive?.(keepAlive);
    // Board task #149: same as runProvision's own call above — a container
    // recycled/healed by restart needs the blueprint clone's credential
    // re-minted too (the clone is idempotent, retried whenever the PREVIOUS
    // attempt never created /opt/blueprint/.git), or a studio whose
    // credential mint failed/was never attempted keeps retrying the clone on
    // every restart, forever.
    // Issue #7: the row's own repo, resolved once for every port below.
    const rowRepoSlug = resolveWorkRepoSlug(null, existing, fleetRepoSlug);
    await maybeWriteBlueprintCredential(deps, roleEnv, status.id, rowRepoSlug);
    // Issue #253: a rollout-replaced container's fresh filesystem carries
    // none of this config either — re-apply on every restart, same
    // reasoning as the blueprint credential just above.
    await applyStudioGitSafety(deps, status.id);
    // Issue #1: fresh filesystem = no scanner, no wrapper, no gate file.
    leakGateNote = await applyLeakGate(deps, status.id, rowRepoSlug);
    // Issue #341: a replaced container lost /opt/memory too.
    await refreshMemoryClone(deps, status.id, rowRepoSlug);

    // THE CLONE. Issue #76, and the reason every rollout-replaced container
    // stayed bare no matter how often it was restarted or healed.
    //
    // #29 put the guarded clone in runProvision only, and its PR said plainly
    // that runRestart was deliberately left out because a restart heals the
    // same container it is already talking to. True of a restart in place.
    // FALSE of a container image rollout, which replaces the container UNDER
    // this DO -- restart then talks to a brand new, empty filesystem and
    // brings up a lead with nothing to lead.
    //
    // MEASURED 2026-09-24, on the deploy that shipped #71's self-heal. Every
    // studio in the fleet went bare and stayed bare. The container's own
    // bring-up log named the gap exactly: nine steps, every one exit=0 --
    // tailscaled, tailscale-up, tailscale-host, tmux-session,
    // session-restore, studio-materialization, claude-launch,
    // transcript-pipe, launch-verdict -- and no clone among them, because the
    // clone was never bring-up's job. Part 2 below added the VERIFICATION
    // that caught this ("clone did not land on this container"); it did not
    // add the clone. So every heal detected the same truth, retried, and
    // could not fix it by construction.
    //
    // Idempotent by the same construction provision relies on:
    // guardedCloneCmd is `test -d <dir>/.git || git clone`, so a restart of a
    // container that still HAS its checkout issues one `test` and moves on.
    // That is what makes it safe on the path every restart takes.
    //
    // Before bring-up, never after: bring-up's claude-launch cds into the
    // checkout, and a lead started in the image's own WORKDIR reasons about
    // the wrong tree (measured 2026-08-20, studio-bringup.sh's own comment).
    //
    // ONE guard, and it is not paranoia. `resolveWorkRepoSlug(null, existing,
    // fleetRepoSlug)` falls back to the FLEET repo when a studio never
    // recorded a `repoSlug` of its own -- which is correct for provision,
    // where `cfg.repo` and the slug were chosen together, and wrong here: it
    // would clone fleetflare into `/workspace/websites` and hand a lead a
    // repo that is not its own, silently. So the clone only runs when the
    // slug's repo NAME matches this studio's own id segment. When it does
    // not, say so and leave the container bare rather than wrong: a bare
    // studio is visibly broken, a studio holding someone else's code is not.
    // Compared through repoIdSegment, NOT as raw strings. A studio id's repo
    // segment is the repo's short name with `.` and `_` folded onto `-`
    // (repo.ts's repoIdSegment, issue #5) -- so `demositeltda/demosite.life`
    // legitimately owns the studios named `demosite-life--*`, and a raw
    // comparison would refuse to clone the BETA/Gamma repo into every one of
    // them. Caught before shipping, on the live fleet's own ids.
    const workRepoSlug = repo === null ? null : resolveWorkRepoSlug(null, existing, fleetRepoSlug);
    const slugSegment = workRepoSlug === null ? null : repoIdSegment(workRepoSlug.split("/").pop() ?? "");
    // Board #350: `cloned` is also what the install-cache restore call below
    // gates on — an install-cache restore into a checkout that was never
    // (this call) confirmed cloned as THIS studio's own repo would restore
    // into the wrong, or a stale, directory.
    const cloned = repo !== null && workRepoSlug !== null && slugSegment === repo;
    if (repo !== null && workRepoSlug !== null && slugSegment === repo) {
      const cloneRes = await deps.sbExec(guardedCloneCmd(workRepoSlug, `/workspace/${repo}`));
      if (cloneRes.code !== 0) {
        throw new Error(`clone failed (${cloneRes.code}): ${cloneRes.stderr.slice(0, 500)}`);
      }
    } else if (repo !== null) {
      // Recorded on the ROW, not only in a Worker log. Measured by an
      // adversarial re-read: a studio whose stored `repoSlug` is null (never
      // re-provisioned since P4a bound the field) and whose id segment is not
      // the fleet repo's falls here on EVERY restart and every self-heal --
      // so it stays bare forever, and the only explanation lived in a
      // console.warn no operator reads. That is the silence this whole night
      // was about.
      cloneRefusal =
        `restart issued NO clone: the resolved work repo ${workRepoSlug} (id segment ${slugSegment}) does not name ${repo}, ` +
        `and cloning it into /workspace/${repo} would hand this lead the wrong repository. ` +
        `This studio cannot self-heal until it records its own repo -- run fleet provision, which resolves it from config.`;
      console.warn(`studio ${status.id}: ${cloneRefusal}`);
    }

    // THE SESSION RESTORE. Issue #88, and the reason the heal was DESTROYING
    // lead history rather than only failing to preserve it.
    //
    // runProvision does clone -> rescue-refs -> session-restore -> bring-up.
    // When #76 put the clone on this path it stopped there, and the omission
    // is not symmetrical with the others: without a staged restore,
    // bring-up's own session-restore step finds nothing, claude launches
    // WITHOUT --continue, and then CREATES an empty ~/.claude/projects. From
    // that moment CONTAINER_HAS_PROJECTS_CMD answers "yes", restorePlan
    // returns "skip" for every later provision, and the next sync tick
    // r2Put's the empty session OVER sessions/<id>/latest.tar.gz. The backup
    // is gone, and every future heal of that studio starts blank.
    //
    // So a heal that ran without this did not merely lose one lead's memory:
    // it overwrote the only copy. Measured 2026-09-24 as leads coming back to
    // an empty prompt after a rollout, with `session tar/stat failed: tar:
    // .claude/projects: Cannot stat` 137 times in one night's Worker tail.
    //
    // Same own-try/catch posture as runProvision's call: a restore that fails
    // must not fail the restart. A studio that comes up without its history
    // is degraded; one that does not come up at all is dead.
    let restoreOutcome: RestoreOutcome = "not-attempted";
    let restoreSource: string | null = null;
    try {
      const restoreResult = await runSessionRestore(deps, status.id);
      restoreOutcome = restoreResult.restore;
      restoreSource = restoreResult.source ?? null;
    } catch (err) {
      restoreOutcome = "failed";
      console.error(
        `studio ${status.id}: session restore failed on restart, continuing without it`,
        err instanceof Error ? err.message : String(err),
      );
    }
    // Issue #85, maestro correction #10: `runRestart`'s return type stays
    // untouched — see runProvision's identical call site's own comment.
    // Board #250: `restoreSource` forwarded the same way — see that call
    // site's own comment.
    deps.onRestoreOutcome?.(restoreOutcome, restoreSource);

    // Board #350: same call, same placement, as runProvision's identical
    // block above — gated on `cloned`, not merely `repo`/`workRepoSlug`
    // non-null, so a restart that issued NO clone (cloneRefusal above) never
    // restores install-cache bytes into a checkout that may not even hold
    // this studio's own repo.
    if (cloned && repo !== null && workRepoSlug !== null) {
      try {
        const installCacheResult = await runInstallCacheRestore(deps, status.id, workRepoSlug, `/workspace/${repo}`);
        if (installCacheResult.attempted) {
          console.warn(`studio ${status.id}: install cache ${installCacheResult.outcome}`);
        }
      } catch (err) {
        console.error(`studio ${status.id}: install cache restore failed on restart, continuing without it`, err instanceof Error ? err.message : String(err));
      }
    }

    // Issue #38 parts 2 and 3. ONE retry, never two, and never silent.
    //
    // Part 2 — the verification. Before this, restart read bring-up's exit
    // code and reported `running` over a container it never looked at. An
    // image rollout replaces the container UNDER the DO, so restart is
    // routinely the first thing to touch a brand new, EMPTY filesystem; six
    // `acme-os` studios came back from one rollout on 2026-09-23 with
    // /workspace empty and were reported healthy throughout.
    //
    // Part 3 — the heal. A second bring-up on a container that now
    // demonstrably exists is the operator's own proven manual recovery
    // (recycleWithSync encodes the same one-retry rule, for the same
    // measured reason), so it runs automatically. It runs AT MOST ONCE: this
    // is a straight try/catch pair, not a loop, so a studio that is broken
    // for a real reason (a missing lead-gate hook, say) costs exactly two
    // bring-ups and then says so, instead of spinning.
    //
    // And it is LOUD. `firstFailure` survives into the success path below,
    // where it keeps `error` non-null on a `running` studio — a silent retry
    // is precisely how this class of bug hides.
    //
    // Issue #116: the worktree-session adopt runs before EACH bring-up, and
    // lives out here rather than inside bringUpAndVerify so a first attempt
    // that adopted and then failed verification still reports it: the retry's
    // own adopt finds the copy root-newest and says "root", which would
    // otherwise erase the only record of what claude actually resumed.
    let adoption: SessionAdoption | null = null;
    const seen = (a: SessionAdoption | null) => {
      adoption = keepAdopted(adoption, a);
    };
    try {
      seen(await adoptBeforeBringup(deps, repo));
      await bringUpAndVerify(deps, roleEnv, repo, isStudio, seen);
    } catch (err) {
      firstFailure = redactSecrets(err instanceof Error ? err.message : String(err));
      await recordRetryAttempt(deps, firstFailure);
      seen(await adoptBeforeBringup(deps, repo));
      await bringUpAndVerify(deps, roleEnv, repo, isStudio, seen);
    }

    status = {
      ...status,
      state: "running",
      lastRefresh: deps.now(),
      error: [
        cloneRefusal,
        leakGateNote,
        firstFailure === null
          ? null
          : `${BRINGUP_RETRY_HEALED}: ${firstFailure}. Both runs are in ${BRINGUP_LOG_PATH} on the container.`,
      ].filter((part) => part !== null).join(" | ") || null,
      sessionAdoption: adoptionRecord(adoption),
    };
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    status = {
      ...status,
      state: "degraded",
      sessionAdoption: null,
      // Both attempts named, never just the last one: a second failure that
      // differs from the first is the most informative thing this path can
      // hand an operator, and reporting only one of them throws that away.
      error: [
        leakGateNote,
        firstFailure === null
          ? message
          : `bring-up failed on BOTH attempts. first: ${firstFailure}. second: ${message}. See ${BRINGUP_LOG_PATH} on the container.`,
      ].filter((part) => part !== null).join(" | "),
    };
  }
  await deps.recordStudio(status);
  return status;
}

/** One bring-up exec plus the on-disk verification that it actually landed —
 *  the unit `runRestart` retries. Bring-up's own non-zero exit and a failed
 *  verification both surface as a throw, so the retry decision above does not
 *  have to tell them apart: either way, this container is not yet a studio. */
async function bringUpAndVerify(
  deps: ProvisionDeps, roleEnv: RoleEnv | StudioEnv, repo: string | null, isStudio: boolean,
  onAdoption: (a: SessionAdoption) => void = () => {},
): Promise<void> {
  const bringupRes = await deps.sbExec(BRINGUP_CMD, roleEnv);
  // Issue #146: reported BEFORE the exit check and the verify, so an attempt
  // that adopted and then failed (non-zero exit, or verification) still
  // counts — the retry's own adopt sees the copy and says "root" (#185 review).
  onAdoption(parseSessionAdoption(bringupRes.stdout, deps.now()));
  if (bringupRes.code !== 0) {
    throw new Error(`bring-up failed (${bringupRes.code}): ${bringupRes.stderr.slice(0, 500)}`);
  }
  await verifyBringupLanded(deps, repo, isStudio);
}

// --- worktree session adoption (issue #116) ---------------------------------
// Measured 2026-09-24 on fleetflare--web-studio: the lead had entered a Claude
// Code worktree, so claude keyed its WHOLE transcript to
// ~/.claude/projects/-workspace-fleetflare--claude-worktrees-<name>/. Bring-up's
// claude_has_conversation looks only under -workspace-<repo>/, found nothing,
// and the heal launched a blank lead over an intact 1.4 MB session.
//
// Measured locally (claude 2.1.281, that real transcript, no prompt sent):
//   - a SYMLINK in the root key is NOT resumed: "No conversation found to continue";
//   - a COPY is resumed, same session id, and claude then appends to the
//     root-key copy — the worktree original is never written again.
// So the Worker copies, never links. Worker-side because a container image
// change replaces every container fleet-wide; teaching claude_has_conversation
// itself about worktree keys is the batched image follow-up.
//
// Limit, named: runs BEFORE bring-up, so on a fresh container whose
// ~/.claude is still a staged, un-untarred restore it finds nothing. It covers
// the same-container heal/restart/failover this issue measured.

export const SESSION_ADOPT_MARKER = "FLEET_SESSION_ADOPT";

/** Issue #146: the image's adopt script (container/studio-adopt.sh). */
export const SESSION_ADOPT_SCRIPT = "/opt/fleet/studio-adopt.sh";

/** The in-container kill: `timeout -k 2 <this>` around the whole snippet, so a
 *  hung step (an unreadable file, a stalled disk) is killed where it runs. */
export const SESSION_ADOPT_KILL_SECONDS = 15;

/** The Worker's own backstop, past the in-container kill plus its 2s grace.
 *  It only fires when the container cannot answer at all. Past it, bring-up
 *  proceeds exactly as before. */
export const SESSION_ADOPT_DEADLINE_MS = 20_000;

export type SessionAdoption =
  | { outcome: "adopted"; sessionId: string; fromKey: string; at: string }
  | { outcome: "root" | "none" }
  | { outcome: "unknown"; reason: string };

/** claude's project key for a launch cwd: every non-alphanumeric character
 *  becomes `-`. Same rule as studio-bringup.sh's claude_project_dir. */
function rootProjectKey(repo: string): string {
  return `/workspace/${repo}`.replace(/[^a-zA-Z0-9]/g, "-");
}

function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The adopt, as one command. Rules, each one a reviewed failure (PR #120):
 *
 * - WORKTREE KEYS ONLY: `<root key>--claude-worktrees-*`, the prefix claude
 *   itself uses for `<repo>/.claude/worktrees/<name>`. A looser `<root key>-*`
 *   also matches sibling repos (/workspace/fleetflare-web) and checkout
 *   subfolders (/workspace/fleetflare/apps/fleet) — someone else's session.
 * - RESUMABLE ONLY: a UUID file name, `"entrypoint":"cli"` in its first 50
 *   lines, and no `"teamName":`. `claude --continue` skips `claude -p`
 *   (sdk-cli) and teammate sessions; adopting one makes it print "No
 *   conversation found to continue" and exit, and since the copy stays newest,
 *   every later heal fails the same way. Root is judged by the same rule: an
 *   sdk-cli file there is not what --continue would resume.
 * - Newest-first per directory, from `ls -t` of the DIRECTORY piped into a
 *   read loop, never a glob of files as arguments (ARG_MAX on a big key).
 * - EXTEND-ONLY (#155): a same-id root file is replaced only by a candidate
 *   that starts with its exact bytes (`head -c <root size> | cmp -`); otherwise it is
 *   kept, the adopt reports `root`, and one line goes to stderr and the log.
 * - Copies only when the worktree candidate is STRICTLY newer than root's
 *   newest resumable one (`-nt`; a tie keeps root), via a temp name that is
 *   not `*.jsonl` then `mv`, so bring-up never sees half a file. A same-name
 *   root file is first kept as `<id>.jsonl.pre-adopt-<epoch>` — never lost,
 *   never resumable — and only the newest such backup per id is kept (#131:
 *   each is a full transcript inside the 64 MiB session tar). Plain `cp` (not `-p`): the copy's fresh mtime makes it
 *   root's newest, which is what `--continue` picks and what stops the next
 *   run re-adopting.
 * - Runs as `timeout -k 2 <secs> sh -c '<snippet>'`: a real kill in the
 *   container, and a child shell, so nothing it does can touch the exec
 *   session's own shell (see PROVISIONED_OK on `exit`).
 */
export function adoptWorktreeSessionCmd(
  repo: string, logPath: string = BRINGUP_LOG_PATH, killAfterSeconds: number = SESSION_ADOPT_KILL_SECONDS,
  scriptPath: string = SESSION_ADOPT_SCRIPT,
): string {
  const m = SESSION_ADOPT_MARKER;
  const snippet = [
    `P="$HOME/.claude/projects"; R=${singleQuote(rootProjectKey(repo))}; LOG=${singleQuote(logPath)}`,
    `ok() {`,
    `  head -n 50 -- "$1" 2>/dev/null | grep -q '"entrypoint":"cli"' || return 1`,
    `  ! head -n 50 -- "$1" 2>/dev/null | grep -q '"teamName":'`,
    `}`,
    `first() {`,
    `  ls -t -- "$1" 2>/dev/null | grep -E '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jsonl$' | while IFS= read -r f; do`,
    `    if ok "$1/$f"; then printf '%s\\n' "$1/$f"; break; fi`,
    `  done`,
    `}`,
    `root=$(first "$P/$R")`,
    `wt=`,
    `for d in "$P/$R"--claude-worktrees-*/; do`,
    `  [ -d "$d" ] || continue`,
    `  c=$(first "\${d%/}")`,
    `  [ -n "$c" ] || continue`,
    `  if [ -z "$wt" ] || [ "$c" -nt "$wt" ]; then wt=$c; fi`,
    `done`,
    `if [ -z "$wt" ]; then if [ -n "$root" ]; then echo "${m} root"; else echo "${m} none"; fi`,
    `elif [ -n "$root" ] && ! [ "$wt" -nt "$root" ]; then echo "${m} root"`,
    `else`,
    `  id=$(basename -- "$wt" .jsonl); k=$(basename -- "$(dirname -- "$wt")"); dst="$P/$R/$id.jsonl"`,
    // Issue #155, extend-only: same rule as container/studio-adopt.sh.
    `  if [ -e "$dst" ] && ! head -c "$(($(wc -c < "$dst")))" -- "$wt" | cmp -s - "$dst"; then`,
    `    msg="studio-adopt: skipped $id from $k: not a byte-extension of $R/$id.jsonl, root copy kept (issue #155)"`,
    `    echo "$msg" >&2; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg" >> "$LOG" 2>/dev/null || true`,
    `    echo "${m} root"`,
    `  elif mkdir -p -- "$P/$R" && { [ ! -e "$dst" ] || cp -p -- "$dst" "$dst.pre-adopt-$(date +%s)"; } && cp -- "$wt" "$dst.adopt-tmp" && mv -f -- "$dst.adopt-tmp" "$dst"; then`,
    // Issue #131: keep only the newest backup per session id. Epochs are 10
    // digits until 2286, so a reverse name sort is newest-first. The pattern
    // only ever matches `<uuid>.jsonl.pre-adopt-<digits>` — never a transcript.
    `    ls -- "$P/$R" 2>/dev/null | grep -E "^$id\\.jsonl\\.pre-adopt-[0-9]+\$" | sort -r | tail -n +2 | while IFS= read -r b; do rm -f -- "$P/$R/$b"; done`,
    `    echo "${m} adopted $id $k"`,
    `    printf '%s worker session-adopt: copied %s from %s into %s so --continue resumes it (issue #116)\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id" "$k" "$R" >> "$LOG" 2>/dev/null || true`,
    `  else rm -f -- "$dst.adopt-tmp"; echo "${m} failed"; fi`,
    `fi`,
  ].join("\n");
  // Issue #146: the image's own script when it is there (the same rules, and
  // what bring-up itself runs after the restore untar); this inline copy only
  // for a container still on an older image during the rollout.
  return (
    `if [ -x ${scriptPath} ]; then timeout -k 2 ${killAfterSeconds} ${scriptPath} ${singleQuote(repo)} ${singleQuote(logPath)} || echo "${m} failed"; ` +
    `else timeout -k 2 ${killAfterSeconds} sh -c ${singleQuote(snippet)} || echo "${m} failed"; fi`
  );
}

/** Issue #28: bring-up's own stdout marker for a `--fresh-session` bring-up. */
export const FRESH_SESSION_MARKER = "FLEET_SESSION_FRESH";

/**
 * Issue #28: where a `--fresh-session` bring-up moved the old session.
 * `null` = no fresh-session marker at all (the flag was not set, or an older
 * image ignored it). `[]` = flag honored, nothing to move. Otherwise every
 * aside dir. A `failed` line is surfaced as `failed <path>` so the caller
 * never reports a clean move that did not happen. Untrusted text: only the
 * two shapes bring-up prints count.
 */
export function parseFreshSession(stdout: string): string[] | null {
  const lines = stdout.split("\n").filter((l) => l.startsWith(`${FRESH_SESSION_MARKER} `));
  if (lines.length === 0) return null;
  const out: string[] = [];
  for (const l of lines) {
    const [, verb, ...rest] = l.trim().split(" ");
    const path = rest.join(" ");
    if (verb === "moved" && /^~\/\.claude\/projects\/fleet-aside-[A-Za-z0-9-]+$/.test(path)) out.push(path);
    else if (verb === "failed" && path !== "") out.push(`failed ${path}`);
  }
  return out;
}

/** Issue #28: the row note for a --fresh-session bring-up. */
export function freshSessionNoteFor(moved: string[] | null, studioId: string): string {
  if (moved === null) {
    return "fresh session not confirmed: bring-up printed no FLEET_SESSION_FRESH line (older image?) -- " +
      "the old session was NOT moved aside and claude may have resumed it";
  }
  const failed = moved.filter((m) => m.startsWith("failed ")).map((m) => m.slice("failed ".length));
  const aside = moved.filter((m) => !m.startsWith("failed "));
  const parts: string[] = [];
  // Issue #37: aside dirs leave the main snapshot and ship on their own.
  if (aside.length > 0) {
    parts.push(
      `fresh session: old session moved aside to ${aside.join(", ")} (kept on disk; the next session sync ` +
      `ships it to R2 under sessions/${studioId}/aside/<dir>/)`,
    );
  }
  if (failed.length > 0) parts.push(`fresh session: could not move ${failed.join(", ")} -- left in place`);
  if (parts.length === 0) parts.push("fresh session: no old session to move aside");
  return parts.join("; ");
}

/** Container stdout is untrusted text: only a well-formed marker line with a
 *  UUID session id and a key-shaped key counts as an adoption. */
export function parseSessionAdoption(stdout: string, at: string): SessionAdoption {
  const line = stdout.split("\n").find((l) => l.startsWith(`${SESSION_ADOPT_MARKER} `));
  if (!line) return { outcome: "unknown", reason: "no marker in adopt output" };
  const [, outcome, sessionId, fromKey, ...rest] = line.trim().split(" ");
  if ((outcome === "root" || outcome === "none") && sessionId === undefined) return { outcome };
  if (
    outcome === "adopted" && rest.length === 0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId ?? "") &&
    /^-[A-Za-z0-9-]+--claude-worktrees-[A-Za-z0-9-]+$/.test(fromKey ?? "")
  ) {
    return { outcome, sessionId: sessionId!, fromKey: fromKey!, at };
  }
  return { outcome: "unknown", reason: `unexpected adopt output: ${line.slice(0, 200)}` };
}

type ExecResult = { code: number; stdout: string; stderr: string };

type ExecFn = (cmd: string, env?: Record<string, string>) => Promise<ExecResult>;

/** The one deadlined exec. Never throws: a failed or slow adopt leaves
 *  bring-up exactly as it was before this feature. */
export async function adoptWorktreeSession(
  exec: (cmd: string) => Promise<ExecResult>, repo: string, at: string, deadlineMs: number = SESSION_ADOPT_DEADLINE_MS,
): Promise<SessionAdoption> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`session adopt timed out after ${deadlineMs}ms`)), deadlineMs);
    });
    const res = await Promise.race([exec(adoptWorktreeSessionCmd(repo)), deadline]);
    return parseSessionAdoption(res.stdout, at);
  } catch (err) {
    return { outcome: "unknown", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** runProvision/runRestart's adopt step: skipped when the id names no repo. */
async function adoptBeforeBringup(deps: ProvisionDeps, repo: string | null): Promise<SessionAdoption | null> {
  return repo === null ? null : adoptWorktreeSession((cmd) => deps.sbExec(cmd), repo, deps.now());
}

/**
 * Issue #146: two adopt results per bring-up now — the Worker's, before it,
 * and bring-up's own, after the restore untar. An adoption is never replaced
 * by a later result: the later run finds the copy root-newest and says
 * "root", which would erase the only record of what claude resumed.
 */
function keepAdopted(prev: SessionAdoption | null, next: SessionAdoption | null): SessionAdoption | null {
  return prev?.outcome === "adopted" ? prev : next;
}

/** The row's record of the last bring-up's adoption (StudioStatus.sessionAdoption). */
function adoptionRecord(a: SessionAdoption | null): StudioStatus["sessionAdoption"] {
  return a?.outcome === "adopted" ? { sessionId: a.sessionId, fromKey: a.fromKey, at: a.at } : null;
}

/**
 * do.ts's failover relaunch: adopt, then the same BRINGUP_CMD runRestart
 * executes, with the role env. A studio id with no repo segment skips the
 * adopt. do.ts's `exec` MUST put `env` inside the exec-class bag —
 * `sbExec(this, cmd, { ...EXEC_CLASSES.provision, env })`. After #110 a
 * lambda handing `env` over AS the bag still type-checks and silently drops
 * it: claude relaunches with an empty system prompt and tool policy (PR #120
 * review). test/studio.worktree-session.test.ts pins that line.
 */
export async function relaunchBringup(
  exec: ExecFn, roleEnv: RoleEnv | StudioEnv, studioId: string,
): Promise<ExecResult> {
  const repo = parseStudioId(studioId)?.repo ?? null;
  if (repo !== null) {
    const adoption = await adoptWorktreeSession((cmd) => exec(cmd), repo, new Date().toISOString());
    if (adoption.outcome === "adopted") {
      console.log(`studio ${studioId}: failover relaunch adopted worktree session ${adoption.sessionId} from ${adoption.fromKey}`);
    }
  }
  return exec(BRINGUP_CMD, roleEnv);
}

/**
 * Write the retry decision into the container's own bring-up log, between the
 * two runs — so the log an operator tails carries the whole story in order:
 * the first run's steps under its own run id, this line naming why it was not
 * enough, then the second run's steps under a run id of its own.
 *
 * Deliberately best-effort and swallowed. The container may be gone, the disk
 * may be full, /workspace/.fleet may not exist on a container hollow enough
 * that even bring-up's own `mkdir -p` never ran. None of that may change the
 * verdict: recording is never load-bearing, and a studio must not be reported
 * broken because the note about it failed to write. The status row carries
 * the same facts regardless (`BRINGUP_RETRY_HEALED`), so nothing is lost when
 * this fails — only the ordering against the two runs is.
 *
 * `reason` arrives already scrubbed (runRestart redacts at the point it first
 * holds the raw message), and `bringupLogAppendCmd` single-quotes it, so
 * neither a secret nor a shell metacharacter can travel this path.
 */
async function recordRetryAttempt(deps: ProvisionDeps, reason: string): Promise<void> {
  const stamp = deps.now();
  try {
    await deps.sbExec(bringupLogAppendCmd(
      `${stamp} worker attempt 1 FAILED verification: ${reason}`,
    ));
    await deps.sbExec(bringupLogAppendCmd(
      `${stamp} worker attempt 2 starting: re-running ${BRINGUP_CMD} once (issue #38 part 3)`,
    ));
  } catch (err) {
    console.error(
      "studio restart: could not record the bring-up retry in the container log, proceeding",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * getStatus's pure half. Defaults to "stopped" when nothing was ever
 * provisioned (StudioStatus has no "unprovisioned" state, and a status
 * route is expected to answer with an object, not a 404, per the design
 * spec's "state for `fleet ls`" framing). Always re-scrubs before
 * returning — this is the defensive second pass (belt and braces, same
 * lesson container/deploy-server.ts's "Fix round 2" comment documents for
 * itself): runProvision/runRestart already scrub at catch time, but this
 * path may read a status some OTHER write path stored raw (or, in tests,
 * one seeded directly to prove the scrub boundary holds regardless of how
 * the data got there).
 *
 * Task 7 review round 1, C2: `lastRefreshError` (src/studio/do.ts's own
 * refresh-streak marker) carries the exact same secret-shaped risk `error`
 * does — src/studio/do.ts's runRefreshCredential already scrubs it before
 * it is ever stored, so this is the same defensive second pass, not the
 * only guard.
 */
export function runGetStatus(existing: StudioStatus | null, idFallback: string): StudioStatus {
  const status = existing ?? {
    id: idFallback, state: "stopped" as const, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  };
  if (status.error === null && status.lastRefreshError === null) return status;
  return {
    ...status,
    error: status.error === null ? null : redactSecrets(status.error),
    lastRefreshError: status.lastRefreshError === null ? null : redactSecrets(status.lastRefreshError),
  };
}

// ---------------------------------------------------------------------------
// Storage-aware wrappers — the ONLY place `STATUS_KEY` is read/written.
// do.ts's real StudioDO methods and test/studio.routes.test.ts's fake
// StudioDO stub both call these directly (passing `this.ctx.storage` vs. an
// in-memory StudioStorage fake) instead of each independently reimplementing
// "read existing, call the pure function, write the result back" — that
// duplication is exactly what review round 2, Important 2 flagged: a test
// that hand-copies do.ts's wrapper logic can drift from it silently and
// never notice. There is now exactly one copy of that sequence.
// ---------------------------------------------------------------------------

/**
 * Issue #85 — the shared post-bring-up finisher `provisionWithStorage`/
 * `restartWithStorage` both call once bring-up has succeeded. Folds the
 * incarnation token write and the pane-lead probe into ONE `sbExec` call
 * (maestro correction #6) and records a session verdict from the LIVE lead
 * process, never bring-up's own intent. `lastSnapshotAtBefore` is read by
 * the CALLER before `runProvision`/`runRestart` ran — maestro correction
 * #8 — never re-read here, since the independent 300s sync tick can
 * complete WHILE this bring-up was still in flight, and would otherwise
 * overwrite it with a freshness that does not describe what THIS restore
 * actually used.
 *
 * Issue #240 (VM1/VM1r, a #174 follow-up): `ctx` is threaded through so the
 * FINAL write below (`mergeObserved`) can re-check `ctx.moved()` right before
 * it happens. The callers' own `!(await ctx.moved())` check (issue #152 fix
 * 5) only guards the DECISION to call this function at all, taken BEFORE the
 * exec below (`bringupObservationCmd`) ever runs — real container I/O that
 * can take long enough for an EXTERNAL destroy to land and bump the epoch
 * WHILE this function's own exec is in flight. Without this second check, the
 * `observed` write below could land a couple of milliseconds after that
 * destroy's own `stopped` row, resurrecting session/incarnation state for a
 * studio the destroy had already finished tearing down.
 */
export async function recordBringupObservation(
  deps: ProvisionDeps, observedStorage: ObservedStorage | undefined, status: StudioStatus,
  existing: StudioStatus | null, restoreOutcome: RestoreOutcome, via: BringupVia,
  lastSnapshotAtBefore: string | null, bringupStartedAt: string,
  // Review round 3 (issue #85 PR1), MUST-FIX 8(c) — the timestamp the CALLER
  // captured the moment `onRestoreOutcome` actually fired (right after
  // `runSessionRestore` resolved, well before bring-up's own long tail —
  // launching claude, letting it settle). Null when no restore was
  // attempted at all. Used ONLY as resolveSnapshotAge's fallback stop time
  // (8d) — never as a substitute for `now` anywhere else in this function.
  restoreObservedAt: string | null,
  // Board #250 (#85/#118 follow-up) — `runSessionRestore`'s own `source`
  // ("latest" or "daily <date>", `pickRestoreSource`'s own doc comment),
  // captured by the CALLER's `onRestoreOutcome` callback in the same breath
  // as `restoreOutcome`/`restoreObservedAt` just above. Null for every path
  // that predates this: no restore attempted, or a restore that never went
  // through `pickRestoreSource` (`deps.r2List` not wired) and so carries no
  // `source` at all. A keeper restore (`source` starting with `"daily "`) is
  // from a genuinely OLDER snapshot than `latest` by construction (a keeper
  // is only ever chosen when `latest` is missing, unreadable, or holds no
  // session at all — `pickRestoreSource` never returns one while `latest`
  // holds a session) — measuring its age against `latest`'s own upload time
  // (the branch below this function already took, unchanged, for every
  // other case) would understate the real work-at-risk age. See the `if`
  // below for the keeper's own branch this now takes instead.
  restoreSource: string | null,
  // Review round 6, MUST-FIX 4 — the CALLER's own `LAST_STOP_KEY` read
  // (board #129), passed through rather than re-read here so this function
  // stays storage-agnostic beyond `observedStorage`. `resolveSnapshotAge`'s
  // own sanity window decides whether it is actually usable.
  lastStopAt: string | null,
  // Issue #240: the calling op's own ctx (provisionWithStorage/
  // restartWithStorage's own `ctx` parameter) — see this function's own doc
  // comment above for why the callers' pre-call check alone is insufficient.
  ctx: OpCtx,
): Promise<void> {
  if (!observedStorage) return;
  const token = crypto.randomUUID();
  let tokenWritten = false;
  let answered = false;
  let probe: PaneProbeResult;
  try {
    const execFn = deps.observationExec ?? deps.sbExec;
    const res = await execFn(bringupObservationCmd(token));
    answered = true;
    const parsed = parseBringupObservation(res.stdout);
    tokenWritten = res.code === 0 && parsed.tokenWritten;
    probe = parsed.probe;
    if (res.code !== 0) {
      console.error(`studio ${status.id}: bring-up observation exec failed (${res.code}): ${res.stderr.slice(0, 300)}`);
    }
  } catch (err) {
    probe = { ok: false, found: false, hasContinue: false, cwd: null, leadAgeS: null, error: err instanceof Error ? err.message : String(err) };
    console.error(`studio ${status.id}: bring-up observation exec failed`, err instanceof Error ? err.message : String(err));
  }

  const repo = parseStudioId(status.id)?.repo ?? null;
  const expectedCwd = repo === null ? "" : `/workspace/${repo}`;
  const turnsBefore = existing?.burn?.turns ?? 0;
  const now = deps.now();
  const observedBefore = await getObserved(observedStorage);

  // Maestro correction #8, review round 3 MUST-FIX 8(c)/8(d) — snapshotAgeS
  // only when a restore actually happened. The snapshot's own upload time
  // comes from `lastSnapshotAtBefore`, falling back to R2's own `uploaded`
  // timestamp only when it was never recorded yet (correction #8's original
  // fallback, now wired do.ts-side too — 8b). The AGE itself is
  // `resolveSnapshotAge`'s own ruling (8d): measured against the OLD
  // container's stop time (`observedBefore.replacedAt`, when known), never
  // against `now`/bring-up's own record time — `restoreObservedAt` (8c) is
  // only the FALLBACK stop time when no better signal exists.
  // Board #250: the keeper's own source label ("daily <date>"), when this
  // restore actually used one — see this function's own `restoreSource`
  // param doc comment. Computed once, reused both for the age's own R2 key
  // below and for `snapshotSource` on the session record further down.
  const keeperSource = restoreOutcome === "restored" && restoreSource != null && restoreSource.startsWith("daily ")
    ? restoreSource
    : null;
  let snapshotAgeS: number | null = null;
  let snapshotAgeIsUpperBound = false;
  if (restoreOutcome === "restored") {
    let snapshotUploadedAt: string | null;
    if (keeperSource !== null) {
      // Board #250: a keeper's own R2 upload time, read FRESH right here,
      // every time — unlike `latest`'s (below), there is no persisted cache
      // like `lastSnapshotAtBefore` for a keeper to serve this from, since
      // that field is only ever written by the periodic sync tick's
      // `latest` r2 put (board #118's own `pickRestoreSource` doc comment).
      // One read per bring-up, the same "read once" discipline
      // `lastSnapshotAtBefore` already established for `latest`, just
      // without a cache behind it.
      const keeperDate = keeperSource.slice("daily ".length);
      const keeperKey = `${sessionDailyPrefix(status.id)}${keeperDate}.tar.gz`;
      const head = deps.r2Head ? await deps.r2Head(keeperKey) : null;
      snapshotUploadedAt = head ? head.uploaded.toISOString() : null;
    } else {
      // Untouched by board #250 — `latest`'s own upload time, exactly as
      // before: `lastSnapshotAtBefore` first, falling back to R2's own
      // `uploaded` timestamp only when it was never recorded yet (maestro
      // correction #8, review round 3 MUST-FIX 8(c)/8(d)). Taken whenever
      // `restoreSource` is `"latest"` or null — a keeper never widens this
      // branch's own logic.
      snapshotUploadedAt = lastSnapshotAtBefore;
      if (snapshotUploadedAt === null && deps.r2Head) {
        const head = await deps.r2Head(sessionLatestKey(status.id));
        if (head) snapshotUploadedAt = head.uploaded.toISOString();
      }
    }
    if (snapshotUploadedAt !== null) {
      const resolved = resolveSnapshotAge(
        snapshotUploadedAt, observedBefore.replacedAt, restoreObservedAt ?? now, lastStopAt,
      );
      snapshotAgeS = resolved.snapshotAgeS;
      snapshotAgeIsUpperBound = resolved.snapshotAgeIsUpperBound;
    }
  }

  // Review round 3 (issue #85 PR1), MUST-FIX 3 — bring-up no-ops when claude
  // is already running in the pane (container/studio-bringup.sh's "ALREADY
  // running ... left the existing lead untouched"), but always answers
  // success regardless. If the live lead PREDATES this bring-up
  // (bringupLeftLeadUntouched), this bring-up did not touch it: keep
  // whatever verdict was already recorded rather than recompute a fresh
  // (and likely wrong — a long-lived lead's first-ever launch has no
  // --continue) one from a process this bring-up never launched.
  const priorSession = observedBefore.session;
  const untouched = bringupLeftLeadUntouched(probe.leadAgeS, bringupStartedAt, now);
  // Issue #249 (PR4b): captured HERE, BEFORE the `patch.replacedAt = null`
  // below clears it, because that clear happens on every bring-up whose
  // incarnation-token write succeeded and runs before the bring-up wakes
  // fire. See `ObservedSession.replacementDetected`'s own doc comment
  // (observed.ts) for why a delivery-time read of `Observed.replacedAt` can
  // never work. Deliberately NOT stamped onto the `priorSession` branch
  // below: that branch keeps an EARLIER bring-up's verdict verbatim (its own
  // `at`, its own `via`), and mixing this bring-up's replacement flag into
  // that record would describe a bring-up that never happened. A lead that
  // predates this bring-up is also, by construction, not a lead a
  // replacement just took away.
  const replacementDetected = observedBefore.replacedAt !== null;
  const replacementFlag = replacementDetected ? { replacementDetected: true } : {};
  // Review round 6, MUST-FIX 9: MUST-FIX 3 above only covers the case where a
  // PRIOR verdict exists to fall back on. An untouched lead with NO prior
  // verdict at all (a studio's very first bring-up ever, or a pre-#85 studio
  // observed for the first time) has nothing honest to fall back to EITHER —
  // recomputing from the untouched process's own launch state is exactly as
  // wrong here as it was in MUST-FIX 3 (a long-lived lead's first-ever launch
  // has no --continue and would misread as LOST, or simply describe a launch
  // this bring-up never performed). `unknown`/"lead predates bring-up" says
  // plainly that nothing is known, rather than guessing.
  const session: ObservedSession = untouched && priorSession !== null
    ? priorSession
    : untouched
      ? {
          verdict: "unknown", at: now, via, restore: restoreOutcome, snapshotAgeS, turnsBefore,
          reason: "lead predates bring-up",
          ...(snapshotAgeIsUpperBound ? { snapshotAgeIsUpperBound: true } : {}),
          ...replacementFlag,
          ...(keeperSource ? { snapshotSource: keeperSource } : {}),
        }
      : {
          ...computeSessionVerdict(probe, expectedCwd, restoreOutcome, turnsBefore, snapshotAgeS, now, via),
          ...(snapshotAgeIsUpperBound ? { snapshotAgeIsUpperBound: true } : {}),
          ...replacementFlag,
          ...(keeperSource ? { snapshotSource: keeperSource } : {}),
        };

  // Maestro correction #13 — a successful bring-up proves the exec plane is
  // alive; reset reachability the same way a successful ship tick does. An
  // ANSWERED observation exec (`answered`, set the moment the exec above
  // resolves — even if what it observed, like the session verdict, ends up
  // unrelated or a non-zero exit) is itself proof-of-life for the exec
  // plane, so it also re-anchors `lastShipOkAt` to `now` — not just a
  // routine successful ship tick. A THROWN exec never sets `answered`, so a
  // dead exec plane never resets this clock.
  const patch: Partial<Observed> = {
    session, execFailures: 0, unreachableSince: null,
    ...(answered ? { lastShipOkAt: now } : {}),
  };
  if (tokenWritten) {
    patch.incarnation = token;
    patch.replacedAt = null;
  }
  // Issue #240 (VM1/VM1r): re-checked HERE, immediately before the write —
  // the callers' own pre-call check (issue #152 fix 5) cannot see a destroy
  // that lands DURING the exec above. A destroy that has landed since makes
  // everything just computed (the session verdict, the token) a claim about a
  // container this op no longer owns; skip the write entirely rather than
  // race the destroy's own `stopped` row.
  if (await ctx.moved()) return;
  await mergeObserved(observedStorage, patch);
}

/** Issue #152: wraps `deps.recordStudio` so `runProvision`/`runRestart`'s own
 *  D1 publish — otherwise completely unguarded — can never tell the registry
 *  a destroyed studio is running or degraded. Checked at the point the D1
 *  write is ABOUT to happen, not once up front: `runProvision`/`runRestart`
 *  call it exactly once, at their own tail, so this is a single extra check
 *  right there, not a poll loop. */
function guardRecordStudio(deps: ProvisionDeps, ctx: OpCtx): ProvisionDeps["recordStudio"] {
  return async (status: StudioStatus) => {
    if (await ctx.moved()) return;
    await deps.recordStudio(status);
  };
}

export async function provisionWithStorage(
  deps: ProvisionDeps, storage: StudioStorage, cfg: ProvisionConfig, fleetRepoSlug: string,
  via: BringupVia = "provision", observedStorage?: ObservedStorage,
  // Issue #152: the calling operation's own epoch claim — see OpCtx's doc
  // comment. Optional, defaulting to a ctx that never reports `moved()`, for
  // every caller (scheduled ticks, and the many tests that call this function
  // directly) that predates this feature and does not exercise the race.
  ctx: OpCtx = NEVER_MOVED_CTX,
): Promise<StudioStatus> {
  // Review round 3 (issue #85 PR1), MUST-FIX 3 — stamped BEFORE doing
  // anything else, so recordBringupObservation can tell whether the live
  // lead it later finds PREDATES this bring-up (left untouched) or was
  // genuinely (re)launched by it.
  const bringupStartedAt = deps.now();
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  // Maestro correction #8: read BEFORE runProvision, so a concurrent sync
  // tick finishing mid-bring-up cannot make this read describe a snapshot
  // fresher than the one the restore actually used.
  const lastSnapshotAtBefore = observedStorage ? (await getObserved(observedStorage)).lastSnapshotAt : null;
  // Review round 6, MUST-FIX 4 — board #129's own onStop record, read the
  // same "before the work" way as lastSnapshotAtBefore just above, so a
  // container that stops again mid-bring-up (unlikely, but the same
  // discipline) cannot make this describe a stop THIS bring-up never saw.
  const lastStopAt = (await storage.get(LAST_STOP_KEY))?.at ?? null;
  let restoreOutcome: RestoreOutcome = "not-attempted";
  // Review round 3 (issue #85 PR1), MUST-FIX 8(c): captured the MOMENT this
  // callback fires — right after runSessionRestore resolves, well before
  // bring-up's own long tail (launching claude, letting it settle) — rather
  // than reusing recordBringupObservation's own much-later `deps.now()`.
  let restoreObservedAt: string | null = null;
  // Board #250: captured in the same breath as `restoreOutcome`/
  // `restoreObservedAt` above — threaded into `recordBringupObservation`
  // below so a keeper-sourced restore measures its own age correctly.
  let restoreSource: string | null = null;
  const provisionDeps: ProvisionDeps = {
    ...deps,
    onRestoreOutcome: (r, s) => { restoreOutcome = r; restoreSource = s; restoreObservedAt = deps.now(); },
  };
  // Issue #86. Taken BEFORE the work and released in the `finally` below:
  // the stored row reads `running` for this whole call, so the periodic heal
  // has nothing else to tell it an operation is under way.
  //
  // Review round 5, Finding 1: `recycleWithSync` (do.ts) holds its OWN
  // OPERATION_KEY (`{op: "recycle", ...}`) across its entire destroy ->
  // reprovision window, INCLUDING this call — its `provision` callback is,
  // in real wiring, `(c) => this.provisionCore(c, "recycle")`, which lands
  // here. Before this fix, this function unconditionally overwrote that
  // lock and cleared it in its own `finally` the instant IT returned, years
  // before recycleWithSync's own remaining work (recycleVerdict's container
  // exec, a possible second retry pass, the final D1 writes) was done — a
  // ship tick racing an exec failure in that window then wrongly counted
  // toward execFailures/unreachableSince. Check-before-set/check-before-clear
  // fixes it with no signature change: if a lock is ALREADY held and FRESH
  // (the outer caller's), this function neither overwrites it nor clears it;
  // only the OUTERMOST setter (whoever found it unheld) ever touches it.
  // `provision()`/`restartStudio()` (do.ts) — this function's own DIRECT
  // callers, never nested under another lock — see no behavior change:
  // OPERATION_KEY is null when they call in, exactly as today.
  //
  // Review round 6, Blocker 2: "already held" now means genuinely fresh, not
  // merely non-null — see operationLockFresh's own doc comment above. A
  // STALE value (an isolate evicted mid-provision, never reaching its own
  // `finally`) used to make `alreadyLocked` read true forever, so this
  // function never refreshed it and never cleared it either; treated here
  // exactly as if there were no lock at all, so this call puts its OWN fresh
  // lock and clears it in its own `finally` below.
  const alreadyLocked = operationLockFresh(await storage.get(OPERATION_KEY), new Date(deps.now()));
  if (!alreadyLocked) await storage.put(OPERATION_KEY, { op: "provision", since: deps.now() });
  // Issue #115: `cfg.cancelFreshSession` (`fleet provision <id>
  // --no-fresh-session`) explicitly clears a stuck FRESH_SESSION_PENDING_KEY
  // — cleared UNCONDITIONALLY (whether or not a pending intent was actually
  // armed, so cancelling an already-clear marker is a safe no-op) and FIRST,
  // before runProvision ever runs — same "durability first" ordering the
  // key's own arm side (just below) already uses. See ProvisionConfig's own
  // doc comment on this field.
  if (cfg.cancelFreshSession === true) await storage.put(FRESH_SESSION_PENDING_KEY, false);
  // Issue #100: a PRIOR --fresh-session attempt that never reached
  // `state: "running"` left FRESH_SESSION_PENDING_KEY armed (see its own doc
  // comment) — this bodyless retry must still honor it, never silently
  // resume. Armed BEFORE runProvision is ever called with the flag on, same
  // "write the intent before the risky work" ordering OPERATION_KEY uses.
  //
  // Issue #115: a cancel on THIS call wins over any `freshSession` also
  // present on it — never both honored on the same call. routes.ts refuses
  // that combination outright (400) before it ever reaches here; this is the
  // defensive floor for any other caller (direct provisionWithStorage calls,
  // tests). Reading the key AFTER the clear above means `freshSessionPending`
  // already reads false in the cancel case, so `requestedFresh` would be
  // false either way — the explicit `cfg.cancelFreshSession === true` check
  // below exists only to also strip a `cfg.freshSession: true` the caller
  // still sent alongside the cancel.
  const freshSessionPending = (await storage.get(FRESH_SESSION_PENDING_KEY)) === true;
  const requestedFresh = cfg.cancelFreshSession === true ? false : (cfg.freshSession === true || freshSessionPending);
  const provisionCfg: ProvisionConfig = cfg.cancelFreshSession === true
    ? { ...cfg, freshSession: false }
    : requestedFresh ? { ...cfg, freshSession: true } : cfg;
  if (requestedFresh) await storage.put(FRESH_SESSION_PENDING_KEY, true);
  let status: StudioStatus;
  let roleEnv: RoleEnv | StudioEnv | null;
  let keepAlive: boolean | null;
  let freshSessionMoved: boolean | undefined;
  let freshSessionConfirmed: boolean | undefined;
  try {
    ({ status, roleEnv, keepAlive, freshSessionMoved, freshSessionConfirmed } = await runProvision(
      { ...provisionDeps, recordStudio: guardRecordStudio(deps, ctx) }, provisionCfg, fleetRepoSlug, existing,
    ));
    // Review round 3 (issue #85 PR1), MUST-FIX 9 (maestro correction #4):
    // this must run INSIDE the op-lock's own try, before the `finally`
    // below releases it — recordBringupObservation issues its own exec
    // (the combined token-write + pane-probe call), and a concurrent ship
    // tick reading OPERATION_KEY must still see a fresh lock for that whole
    // window, not just for runProvision's own duration. Its own try/catch:
    // a failure recording the bring-up observation (e.g. observedStorage
    // itself throwing) must never fail a bring-up that already succeeded.
    //
    // Issue #152 fix 5: also skipped once a destroy has moved this op's own
    // ctx — a destroyed studio's exec plane may already be gone, and even if
    // the exec succeeds it is observing a container this op no longer owns.
    if (status.state === "running" && !(await ctx.moved())) {
      try {
        await recordBringupObservation(deps, observedStorage, status, existing, restoreOutcome, via, lastSnapshotAtBefore, bringupStartedAt, restoreObservedAt, restoreSource, lastStopAt, ctx);
      } catch (err) {
        console.error(`studio ${status.id}: recordBringupObservation failed, continuing`, err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    if (!alreadyLocked) await storage.put(OPERATION_KEY, null);
  }
  // Issue #152: a destroy landed somewhere inside runProvision's own clone/
  // bring-up sequence and has already fully landed (or is still landing) —
  // see destroy.ts's two epoch bumps. The row destroy left behind is the
  // truth; this call's own `status` (computed against a container that may
  // already be gone) must never overwrite it. No further write at all: not
  // the role env, not keepAlive, not the row, not the destroy marker.
  if (await ctx.moved()) {
    console.error(`studio ${buildStudioId(cfg)}: destroy landed mid-provision, aborting`);
    return (await storage.get(STATUS_KEY)) ?? status;
  }
  // Only on a successful resolve. A provision that failed to reach the
  // blueprint (network, bad ref, unknown role) must not clobber the role env
  // a PREVIOUS successful provision stored — the container is very likely
  // still running that role, and restart should keep being able to relaunch
  // it rather than being bricked by one transient GitHub failure.
  if (roleEnv !== null) await storage.put(ROLE_ENV_KEY, roleEnv);
  // Fleet Spawn P3, Task 4 (R-P3-6): same null-guard, same reason — a failed
  // resolve must not clobber a PREVIOUSLY resolved keepAlive either.
  if (keepAlive !== null) await storage.put(KEEP_ALIVE_KEY, keepAlive);
  // Issue #37: the old session left the main snapshot (it ships as its own
  // aside archive), so the sync guard's baseline — its newest file — is gone
  // from every later candidate, which would be displaced forever. The same
  // one-shot force upload `fleet clear-session-guard` arms: the old `latest`
  // is kept under superseded/ by the upload itself, and a blank candidate
  // (claude has not written yet) still waits.
  if (freshSessionMoved) {
    await storage.put(SESSION_FORCE_KEY, true);
    // PR #46 review: the row says so, like clear-session-guard does.
    status = { ...status, sessionForceArmedAt: deps.now() };
  }
  // Issue #100: retire the pending marker ONLY once a fresh-session attempt
  // has actually reached `state: "running"` — any other outcome (a clone
  // failure, a bring-up throw, anything runProvision's own try/catch turned
  // into "degraded") leaves it armed, so the NEXT provision call — flagged
  // or not — still forces `freshSession: true` rather than silently
  // resuming. See FRESH_SESSION_PENDING_KEY's own doc comment.
  //
  // Review round 1: `state === "running"` alone is NOT enough — it is set by
  // runProvision purely on bring-up exit code 0 + verifyBringupLanded, and
  // says nothing about whether the fresh-session move was ever confirmed.
  // `freshSessionConfirmed` is the real signal (see its own doc comment on
  // runProvision's return type): false when bring-up printed no
  // FLEET_SESSION_FRESH line at all, or every entry it printed was
  // `failed `. Without this, a bring-up that "succeeds" (exit 0) without
  // confirming the move would still clear the marker, reproducing the exact
  // bug this fix exists for via a different path than the throw it was
  // written against.
  if (requestedFresh && status.state === "running" && freshSessionConfirmed) {
    await storage.put(FRESH_SESSION_PENDING_KEY, false);
  }
  // Issue #115: mirrored for fleet ls visibility — read AFTER every write
  // path above (cancel, arm, confirmed-clear) has run, so the persisted row
  // is never stale. See StudioStatus.freshSessionPending's own doc comment.
  status = { ...status, freshSessionPending: (await storage.get(FRESH_SESSION_PENDING_KEY)) === true };
  await storage.put(STATUS_KEY, status);
  // Issue #100 N1: the container is up again, so no destroy is in flight —
  // including one that died before its own `finally` could say so.
  await storage.put(DESTROYING_KEY, null);
  return status;
}

export async function restartWithStorage(
  deps: ProvisionDeps, storage: StudioStorage, idFallback: string, fleetRepoSlug: string,
  via: BringupVia = "restart", observedStorage?: ObservedStorage,
  // Issue #152: see provisionWithStorage's own doc comment on this parameter.
  ctx: OpCtx = NEVER_MOVED_CTX,
): Promise<StudioStatus> {
  // Review round 3 (issue #85 PR1), MUST-FIX 3 — see provisionWithStorage's
  // identical stamp above for why.
  const bringupStartedAt = deps.now();
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  const roleEnv = (await storage.get(ROLE_ENV_KEY)) ?? null;
  // Fleet Spawn P3, Task 4 (R-P3-6): the smallest honest source for a
  // restart is DO storage, same as roleEnv just above and for the same
  // reason (no blueprint refetch at restart time — see runRestart's own doc
  // comment). Defaults to `true` — blueprint.ts's own Role.keep_alive
  // default, and do.ts's pre-Task-4 unconditional behavior — for a studio
  // provisioned before this feature existed and therefore never wrote
  // KEEP_ALIVE_KEY at all; this is the same "undefined reads as the
  // always-on default" self-heal shape ensureSpawnToken (do.ts)
  // already established for a pre-P3 studio's missing spawn token.
  const keepAlive = (await storage.get(KEEP_ALIVE_KEY)) ?? true;
  // Maestro correction #8 — see provisionWithStorage's identical read above.
  const lastSnapshotAtBefore = observedStorage ? (await getObserved(observedStorage)).lastSnapshotAt : null;
  // Review round 6, MUST-FIX 4 — see provisionWithStorage's identical read
  // above.
  const lastStopAt = (await storage.get(LAST_STOP_KEY))?.at ?? null;
  let restoreOutcome: RestoreOutcome = "not-attempted";
  // Review round 3 (issue #85 PR1), MUST-FIX 8(c) — see provisionWithStorage's
  // identical capture above.
  let restoreObservedAt: string | null = null;
  // Board #250: captured in the same breath as `restoreOutcome`/
  // `restoreObservedAt` above — threaded into `recordBringupObservation`
  // below so a keeper-sourced restore measures its own age correctly.
  let restoreSource: string | null = null;
  const provisionDeps: ProvisionDeps = {
    ...deps,
    onRestoreOutcome: (r, s) => { restoreOutcome = r; restoreSource = s; restoreObservedAt = deps.now(); },
  };
  // Issue #86, same lock and same reason as provisionWithStorage: a restart
  // is exactly as long as a provision and just as invisible in the row.
  //
  // Review round 5, Finding 1 — same check-before-set/check-before-clear fix
  // as provisionWithStorage's identical block above, and for the same
  // reason: nothing today nests a call through this function under an
  // existing lock, but the two functions manage OPERATION_KEY identically
  // and the review flagged both, so both get the same guard rather than
  // leaving this one to silently regress the same way if a future caller
  // ever does nest through it.
  //
  // Review round 6, Blocker 2 — same freshness fix as provisionWithStorage's
  // identical block above: "already held" means fresh, not merely non-null.
  const alreadyLocked = operationLockFresh(await storage.get(OPERATION_KEY), new Date(deps.now()));
  if (!alreadyLocked) await storage.put(OPERATION_KEY, { op: "restart", since: deps.now() });
  let status: StudioStatus;
  try {
    status = await runRestart(
      { ...provisionDeps, recordStudio: guardRecordStudio(deps, ctx) }, existing, idFallback, roleEnv, keepAlive, fleetRepoSlug,
    );
    // Review round 3 (issue #85 PR1), MUST-FIX 9 — same placement fix as
    // provisionWithStorage's identical block above: inside the op-lock try,
    // before the finally, with its own try/catch.
    //
    // Issue #152 fix 5: same ctx.moved() skip as provisionWithStorage's
    // identical block above.
    if (status.state === "running" && !(await ctx.moved())) {
      try {
        await recordBringupObservation(deps, observedStorage, status, existing, restoreOutcome, via, lastSnapshotAtBefore, bringupStartedAt, restoreObservedAt, restoreSource, lastStopAt, ctx);
      } catch (err) {
        console.error(`studio ${status.id}: recordBringupObservation failed, continuing`, err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    if (!alreadyLocked) await storage.put(OPERATION_KEY, null);
  }
  // Issue #152: same guard as provisionWithStorage's own, same reason — a
  // destroy that landed somewhere inside runRestart's own bring-up sequence
  // left the row `stopped`, and this call's own `status` must never
  // overwrite it.
  if (await ctx.moved()) {
    console.error(`studio ${idFallback}: destroy landed mid-restart, aborting`);
    return (await storage.get(STATUS_KEY)) ?? status;
  }
  await storage.put(STATUS_KEY, status);
  // Issue #100 N1: same as provisionWithStorage.
  await storage.put(DESTROYING_KEY, null);
  return status;
}

export async function getStatusWithStorage(storage: StudioStorage, idFallback: string): Promise<StudioStatus> {
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  return runGetStatus(existing, idFallback);
}
