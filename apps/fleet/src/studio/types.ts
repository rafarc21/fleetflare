import type { Burn } from "./burn";
import type { Observed } from "./observed";
import type { RateLimitObservation } from "./rate-limit";
import type { SessionGuard, BurnPersistError } from "./session-sync";

export type StudioState = "provisioning" | "running" | "degraded" | "stopped";

/**
 * Fleet ls readiness fix ("a dead studio looks alive" — P5a Task 5's
 * Finding 2, live-measured: 3 of 4 studios bare, `fleet ls` showed every one
 * `running, error: null`). The last live provisioned-check verdict recorded
 * for a studio, stamped with WHEN it was taken — do.ts's syncSession tick
 * writes this every SYNC_SESSION_SECONDS via checkAndRecordReadiness, which
 * runs the SAME checkProvisionedWithRetry check GET /studio/:id/provisioned
 * and recycle already gate on, so this can never disagree with them about
 * what "provisioned" means.
 *
 * Three kinds, never two — same split do.ts's own ProvisionedVerdict makes
 * (duplicated here rather than imported: a three-line union is cheaper to
 * copy across this file boundary than to import, the same call ff.ts's own
 * local copy already makes for the identical shape). `inconclusive` is a
 * statement about the CHECK, never about the studio — a throw, a timeout, an
 * unrecognisable answer — and must never be read as evidence the studio is
 * broken OR healthy.
 */
export type StudioReadiness =
  | { kind: "provisioned"; checkedAt: string }
  | { kind: "bare"; reason: string; checkedAt: string }
  | { kind: "inconclusive"; reason: string; checkedAt: string };

export interface StudioStatus {
  id: string;
  state: StudioState;
  tailscaleHost: string | null;
  lastRefresh: string | null;
  error: string | null;
  /**
   * Review round 1, C2: `state`/`error` are a SHARED channel — provision
   * and restart write the same fields the GitHub token refresh loop does,
   * so refresh cannot use `state === "degraded"` as its own private
   * once-per-streak marker (a clone failure and a refresh failure would be
   * indistinguishable, and a successful refresh would silently erase a
   * degradation it didn't cause).
   *
   * Semantics: this field tracks the CREDENTIAL-SUBSYSTEM failure streak
   * specifically — deliberately independent of `state`, and independent of
   * WHICH do.ts entry point last ran the mint+write step. Only
   * src/studio/do.ts's runRefreshToken ever computes its value (via
   * runRefreshCredential); it is scrubbed the same as `error`. Non-null
   * exactly when the most recently ATTEMPTED credential mint/write failed;
   * cleared to null the next time one succeeds, regardless of what `state`
   * does on that same call.
   *
   * "Most recently attempted" matters: `runProvision`/`runRestart`
   * themselves (provision.ts) never touch this field directly — they only
   * spread `existing` through unchanged — but review round 1's I3 and
   * round 2's symmetry fix mean do.ts's `provision()` AND `restartStudio()`
   * BOTH run the shared credential step (runRefreshToken, via
   * refreshWithStorage) before delegating to provisionWithStorage/
   * restartWithStorage. So a credential failure streak that began during a
   * refresh and is still ongoing at the next provision/restart call is the
   * SAME streak — continuous credential failure across an intervening
   * bring-up success (a restart that fixes the tmux session but not the
   * credential) is ONE streak and alerts once, not once per entry point.
   * Symmetrically, a credential success at ANY of these three call sites
   * clears the marker, so the next failure anywhere is correctly read as a
   * new streak. See runRefreshToken's own doc comment (do.ts) for the
   * `ownsDegradation` mechanics this enables.
   */
  lastRefreshError: string | null;
  /**
   * P2 plane 4 (token monitor): numbers-only snapshot of this studio's
   * running token-burn counters. Mirrored from DO storage's own `burn` key
   * (session-sync.ts owns the storage keys; do.ts's `mirrorBurnToRegistry`
   * does the copy) after every successful syncSession tick — see burn.ts's
   * own header for why every field on `Burn` is a plain number or a
   * self-generated ISO timestamp, never anything derived from parsed
   * session/message content. `null` until the first successful sync tick
   * ever runs for this studio (freshly provisioned, or one whose first sync
   * hasn't fired yet).
   */
  burn: Burn | null;
  /**
   * Issue #94: the session sync guard's last refusal — a candidate snapshot
   * poorer than `latest` (blank session, or fewer lines in the newest
   * session file) that went to `key` instead of over `latest`. Mirrored from
   * session-sync.ts's SESSION_GUARD_KEY by do.ts's mirrorBurnToRegistry;
   * null once a later tick writes `latest` again. Optional: rows written
   * before the guard lack it.
   */
  sessionGuard?: SessionGuard | null;
  /**
   * Issue #258 round-2 review (MED): a burn cursor/burn PERSIST failure
   * (session-sync.ts's own `BURN_PERSIST_ERROR_KEY`) — distinct from
   * `sessionGuard` above (which means "session sync REFUSED a poorer
   * snapshot"). The two used to share `sessionGuard`'s own key/field: a
   * burn-persist failure clobbered a legitimate displaced-snapshot record (or
   * vice versa, on the very same tick — a displaced candidate is still
   * parsed for burn), and an operator's `clearSessionGuard` on what LOOKED
   * like a stuck displaced guard could silently force-upload past the real
   * guard's poorer-snapshot check. Mirrored from `BURN_PERSIST_ERROR_KEY`'s
   * own storage state by do.ts's `mirrorBurnToRegistry` (same bridge
   * `sessionGuard` crosses); `null` once a later tick's persist succeeds.
   * Optional: rows written before this field existed lack it.
   */
  burnPersistError?: BurnPersistError | null;
  /**
   * Issue #228 (#192 follow-up, item 5): WHEN the force-next-sync override
   * (session-sync.ts's `SESSION_FORCE_KEY`) was last armed by
   * `clearSessionGuard` (do.ts) — an ISO timestamp while the override is
   * still pending, `null` once a tick actually consumes it. Unlike
   * `sessionGuard` above (a REFUSAL record, mirrored only while one exists),
   * this field exists specifically because an armed override was previously
   * invisible anywhere an operator could see it: `fleet ls`/`fleet inspect`
   * had no way to say "the next sync will bypass the guard's comparison"
   * until it actually happened. Mirrored from `SESSION_FORCE_KEY`'s own
   * storage state by do.ts's `mirrorBurnToRegistry` (same bridge
   * `sessionGuard` already crosses) — `null` while never armed, or once
   * consumed; `undefined`/absent only on a row written before this field
   * existed. See `SESSION_FORCE_KEY`'s own doc comment (session-sync.ts) for
   * the override's full design.
   */
  sessionForceArmedAt?: string | null;
  /**
   * Issue #115 (#100 follow-up): mirrors provision.ts's own
   * `FRESH_SESSION_PENDING_KEY` — `true` while a `--fresh-session` attempt
   * has been requested (or armed by a prior failed attempt) but not yet
   * CONFIRMED applied, `false` once cleared (a confirmed fresh-session
   * success, or an explicit `fleet provision <id> --no-fresh-session`
   * cancel). Before this field existed, a stuck pending intent — one that
   * kept forcing `freshSession: true` on EVERY later provision, flagged or
   * not, with no way to cancel and no way to SEE it was armed — was entirely
   * invisible anywhere an operator could look. Stamped immediately by
   * `provisionWithStorage` on every call (see FRESH_SESSION_PENDING_KEY's own
   * doc comment for the write-order rules), and reconfirmed every sync tick
   * by do.ts's `mirrorBurnToRegistry`, same "stamped immediately + mirrored
   * every tick" treatment `sessionForceArmedAt` above already gets.
   * `undefined` only on a row written before this field existed.
   */
  freshSessionPending?: boolean;
  /**
   * Fleet Spawn P3, Task 2 (R-P3-2): the studio id of the PARENT that
   * spawned this one through /fleet/spawn, or the literal "operator" for a
   * spawn the human initiated through /studio/spawn. `null` for a studio
   * provisioned directly (POST /studio/:id/provision) — no parent exists.
   *
   * Set once, at the provision the spawn triggered (ProvisionConfig.spawnedBy
   * carries it in); a later re-provision of the same studio through the
   * ordinary route leaves it alone, since runProvision spreads the existing
   * status forward and that route never populates the field.
   */
  spawnedBy: string | null;
  /**
   * Issue #59 review round 1: written on EVERY completed destroy (destroy.ts's
   * destroyAndRecord). `true` only when the operator ran `fleet destroy
   * --park` — a studio stopped on purpose so a coordinating studio may
   * `fleet resume` it. A plain destroy writes `false`, and absent (a row from
   * before this field) reads as not parked: resume refuses both.
   */
  parked?: boolean;
  /** Issue #59 review round 1: when the last completed destroy stopped this
   *  studio. Resume's cooldown counts from it. */
  stoppedAt?: string | null;
  /**
   * Fleet Spawn P3, Task 2 (R-P3-1/R-P3-7): sha256 hex of this studio's
   * spawn-auth token (org.ts's mintSpawnToken/hashSpawnToken). The TOKEN
   * itself lives only in the studio's own DO storage (do.ts's
   * SPAWN_TOKEN_KEY) and its container env (FLEET_SPAWN_TOKEN) — it is never
   * written to D1, never returned by any route, and is redacted by shape if
   * it ever surfaces in an error string (redact.ts's `fsp_` pattern).
   *
   * This digest is what makes /fleet/spawn's parent lookup possible without
   * a per-request fan-out to every StudioDO: the route hashes the presented
   * token and matches it against registry rows. `null` for a studio
   * provisioned before this feature existed, or one whose provision never
   * got far enough to mint — such a studio simply cannot spawn until its
   * next provision/restart writes one.
   */
  spawnTokenHash: string | null;
  /**
   * Dynamic repo selection (P4a): the full `owner/repo` this studio's
   * container actually cloned — the WORK repo, never the blueprint one (see
   * src/studio/repo.ts's header for the three-way split those names cover).
   *
   * Written on every provision from the slug the Worker RESOLVED (routes.ts
   * -> repo.ts's resolveWorkRepo), so it records a decision the Worker made,
   * not a value a caller sent. Two later reads depend on it:
   *   - re-provision/recycle, which carry no repo of their own and would
   *     otherwise silently fall back to the fleet default and re-clone the
   *     WRONG repo (provision.ts's runProvision reads it off `existing`);
   *   - the fleet-wide segment claim (repo.ts's claimedBy), which is what
   *     stops two orgs' same-named repos colliding on one `<repo>--<role>`.
   *
   * `null` for a studio provisioned before this feature existed. Every such
   * studio was cloned from AGENT_REPO by construction — there was no other
   * possibility — so both readers treat null as exactly that, rather than as
   * "unknown".
   */
  repoSlug: string | null;
  /**
   * Issue #53: WHICH claude account this studio is running on — the NAME of
   * the Worker secret (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_2`,
   * …), never the token. A variable name is not a credential, so this is safe
   * everywhere a status goes: the registry row, `fleet ls`, a telegram alert.
   *
   * It is the operator's answer to "which account is this studio on, and did
   * it move?" — a silent failover that works is still a failover nobody can
   * audit when the second account drains too. Two things write it:
   * failover.ts's runAccountFailover on a switch, and nothing else; do.ts's
   * studioEnvVars READS it so a recycled container comes back up on the
   * account the studio moved to rather than resetting to the first one
   * (the exact reason a manual in-container `/login` never survived a
   * recycle).
   *
   * OPTIONAL, like `readiness` above and for the same reason: `undefined` (a
   * studio provisioned before this feature) and `null` mean the same thing —
   * "on the first account", which every such studio was by construction,
   * since there was only one. Readers must treat them identically.
   */
  claudeAccount?: string | null;
  /**
   * Issue #102 — WHEN a completed account switch last wrote `claudeAccount`,
   * ISO. failover.ts's own no-flapping guard reads it: an INLINE limit block
   * (the one shape `--continue` can redraw un-guarded after a SELECT-modal
   * switch — see runAccountFailover's own residual notes) within
   * FLAP_GUARD_MINUTES of this timestamp is not, on its own, trusted as fresh
   * evidence to move the studio again; a genuine select-style modal always is,
   * since claude never redraws one of those from a resumed transcript.
   * `null`/absent: never switched, or switched before this field existed —
   * the guard is then simply never armed.
   */
  claudeAccountMovedAt?: string | null;
  /**
   * Issue #102 — HOW the last completed switch matched: `"modal"` for a
   * genuine SELECT-style modal (verdict.inline falsy — never redraw-guarded,
   * since claude can't redraw one of those from a resumed transcript), or
   * `"inline"` for an inline limit block. The no-flapping guard fires ONLY
   * after a `"modal"` switch: that is the one path with an UNGUARDED residual
   * (see runAccountFailover's own doc comment) — the switched-off account's
   * transcript can still hold an old inline message that `--continue` redraws
   * on the very next capture, with no `failoverBlock` recorded to catch it
   * (a select switch always writes `failoverBlock: null`). An `"inline"`
   * switch already IS `failoverBlock`-guarded against its own redraw (the
   * `rerender` check), so a DIFFERENT inline key after one is trusted as a
   * genuinely new limit immediately, cooldown or not.
   */
  claudeAccountMovedVia?: "modal" | "inline" | null;
  /**
   * Review round 1 (#102 review, 2026-09-30) — the block-key (failover.ts's
   * `limitBlockKey`) the no-flapping guard compares a NEW inline observation
   * against, or `null` when none is known. Fixes the escape hatch being
   * UNREACHABLE for a genuinely new limit: the old guard suppressed ANY inline
   * verdict within FLAP_GUARD_MINUTES of a `"modal"`-via switch, so a
   * genuinely NEW limit on the studio's own new account that happened to
   * render inline was indistinguishable from a stale `--continue` redraw of
   * the OLD account's leftover transcript.
   *
   * Written on every completed switch: for an `"inline"`-via switch, the same
   * value as `failoverBlock` (the block that justified it — redundant with
   * that field, kept separate so this one's meaning never depends on which
   * kind of switch wrote it). For a `"modal"`-via switch (a select-style
   * modal has no block of its own), the studio's CURRENTLY-tracked
   * LIMIT_SIGHTING_KEY block, if any — the best available stand-in for
   * "whatever inline text this transcript might still redraw", since a select
   * modal's own capture can never also carry an inline block (the two are
   * position-exclusive in detectLimitOnScreen). `null` when no such sighting
   * exists: there is then nothing this switch was justified by, or already
   * knew about, to compare a later inline observation against, so the guard
   * must not suppress it — see runAccountFailover's own no-flapping doc
   * comment for the full rule.
   *
   * Cleared alongside `failoverBlock` on the same "forget" trigger (a static
   * pane with claude's footer and no limit on it) — this is not the block that
   * survives a redraw either.
   */
  claudeAccountMovedBlock?: string | null;
  /**
   * Issue #131 (Stage B) — set whenever this studio's own repo has a genuine
   * `CLAUDE_ACCOUNT_BY_REPO` entry (failover.ts's `FailoverDeps.primaryIsMapped`)
   * AND the studio is currently away from that mapped primary, for ANY
   * reason: an ordinary in-chain switch that merely stepped forward from
   * primary, a tier-2 landing on an unclaimed spare positioned before
   * primary, or an actual cross-repo borrow of some OTHER repo's own mapped
   * primary (`nextBorrowedAccount`'s second pass, once every account
   * reserved for THIS repo is exhausted at once). NOT narrower than that —
   * review round 3 (2nd review of PR #135, 2026-09-30) generalized this from
   * "only a genuine cross-repo borrow" to "away from primary at all", so
   * hand-back's own `rowNow.borrowedAccount` gate — the ONLY thing that ever
   * brings a studio back to its primary — never goes stale partway through a
   * chain of non-primary switches. The account NAME, same "safe to
   * log/store/card" discipline `claudeAccount` itself already documents —
   * never a token.
   *
   * NEVER set at all for a studio whose own repo has no `CLAUDE_ACCOUNT_BY_REPO`
   * entry — such a studio never opted into Stage B borrow/hand-back
   * semantics, and an ordinary rate-limit switch for it (e.g. account 1 to
   * account 2 with no map configured at all) must never be mistaken for a
   * borrow.
   *
   * Cleared (`null`) the moment a switch lands exactly on the studio's own
   * mapped primary — whether via this ordinary path or via `handBack`'s own
   * dedicated one — attempted regardless of success, same treatment a
   * completed switch's `claudeAccount`/`launchedAccount` fields already get.
   * `undefined`/absent: never borrowed (including every studio with no
   * mapped primary at all), or borrowed before this field existed — readers
   * treat the two identically, same as every other optional account field on
   * this type.
   */
  borrowedAccount?: string | null;
  /**
   * Issue #131 (Stage B) — which repo's own primary `borrowedAccount` is,
   * for logging/audit only (never read to decide anything — the failover
   * DECISION is keyed on the `reservedAccounts` SET alone, accounts.ts's
   * `repoForAccount` is a pure display lookup). `null` when the borrowed
   * account's slot is not (or no longer) in `CLAUDE_ACCOUNT_BY_REPO` at all —
   * an operator alert then names the account alone, same fallback
   * `accountDisplay` already gives an unlabelled account.
   */
  borrowedFromRepo?: string | null;
  /**
   * Issue #289: the account this studio's container was actually LAUNCHED
   * on -- written when the container starts (StudioDO.onStart, from the same
   * launchAccount call that filled its CLAUDE_CODE_OAUTH_TOKEN) and by a
   * completed failover switch. `fleet ls` shows THIS, not the repo map: a map
   * change reaches a studio only at its next launch. `null`: the last launch
   * was refused (#285), nothing named runs. Absent: no launch on record (a
   * row written before #289, or a start whose account could not be read
   * back) -- `fleet ls` shows `?` with the next launch's account (#292 r2).
   */
  launchedAccount?: string | null;
  /**
   * Issue #289: read-time only, like claudeAccountLabel -- the account the
   * NEXT launch would use, when it differs from launchedAccount. `fleet ls`
   * prints `<launched> (next launch: <this>)`.
   */
  claudeAccountNext?: string;
  /**
   * Issue #271: the operator's NON-SECRET label for that account
   * (CLAUDE_ACCOUNT_<n>_LABEL), stamped at read time by listStudios — never
   * stored. `fleet ls` shows `<label> (<secret name>)`; absent, the name.
   */
  claudeAccountLabel?: string;
  /**
   * Issue #106: the limit block the last account switch fired on, as
   * failover.ts's limitBlockKey names it — headline + printed reset
   * ("You've hit your session limit · 1:30pm (UTC)"). runAccountFailover
   * writes it on a switch, reads it to ignore claude's `--continue` redraw of
   * that same block, and CLEARS it on the first static pane with no limit
   * (fix pass B: every other STATUS_KEY writer spreads `existing`, so nothing
   * else ever would). The wake gate reads it too: that block is history.
   * Optional; absent means no switch.
   */
  failoverBlock?: string | null;
  /**
   * Issue #99: the claude account's usage/session limit, as the failover
   * pane capture (every 300s, failover.ts) last saw it. Written when the pane
   * shows the limit, cleared when it no longer does. `fleet ls` READY reads
   * it; past `until` it renders nothing. `null`/absent: not limited.
   */
  rateLimited?: RateLimitObservation | null;
  /**
   * Issue #214: WHEN failover last took this studio back OUT of the
   * `degraded` it wrote for an exhausted account, as an ISO instant.
   *
   * MEASURED 2026-09-24: three leads were degraded at 22:52Z with "claude
   * account exhausted: … is parked on the rate-limit modal", the maestro
   * dismissed each modal with a lone Esc at 23:32Z, all three resumed and
   * kept committing — and every row still read `degraded` with that error
   * 40+ minutes later. The clear itself is invisible without a timestamp
   * ("was this row healed, or never degraded?"), so runAccountFailover
   * stamps it here on the same write that flips the state back to
   * `running`. It is a RECORD, never a flag: nothing reads it to decide
   * anything, later ticks leave it alone, and only the next clear moves it.
   *
   * Reaches `fleet ls --json` / `fleet inspect` the way every other status
   * field does — registry.ts's recordStudio spreads the whole row into D1.
   * Optional; absent means this studio has never been healed from an
   * exhaustion (which is every studio provisioned before this feature).
   */
  exhaustionClearedAt?: string | null;
  /**
   * Issue #109: the earliest readable fleet-wide reset among the accounts
   * tried at the moment this studio's exhaustion was first recorded (reuses
   * earliestAccountReset, already computed for exhaustedMessage at that call
   * site) — null when no tried account had a readable reset (the common
   * case: a select-style modal never prints one). Consumed (set back to
   * null) the first time an auto-continue attempt fires against it, so a
   * known reset that does not actually clear the exhaustion falls back to
   * the same hourly cadence as an unknown one, rather than re-firing every
   * 5-minute tick forever.
   */
  autoContinueAt?: string | null;
  /**
   * Issue #109: when an auto-continue attempt (Esc + wake) was last made,
   * regardless of outcome — the hourly retry-cap clock for an unknown
   * reset, and the anti-hammer clock for a known one that already fired
   * once.
   */
  autoContinueLastTriedAt?: string | null;
  /**
   * See StudioReadiness's own doc comment above for what this records.
   * `null`/absent both mean "no verdict recorded yet" — a studio whose first
   * syncSession tick has not fired, or one written by a call site that
   * predates this field.
   *
   * OPTIONAL, unlike every sibling field above: `undefined` (key absent) and
   * `null` (registry.ts's recordStudio explicitly normalizes an absent value
   * to this on every write) mean exactly the same thing here, so there is no
   * behavioural gain in forcing every existing StudioStatus object literal
   * across the codebase to spell out a value that reads identically either
   * way. Every reader compares with `== null`, never assumes the key exists.
   */
  readiness?: StudioReadiness | null;
  /**
   * Issue #85 — container-replacement/reachability/session-verdict record.
   * OPTIONAL, same reason `readiness` is: `undefined` (a studio predating
   * this feature, or one whose first bring-up under it has not landed yet)
   * carries no signal on its own — `readyOverride`/`formatSession` (Task 8)
   * both treat an absent `observed` as "nothing to override, render as
   * today", never as evidence of a problem.
   */
  observed?: Observed;
  /**
   * Issue #95: when a studio recorded `stopped` was first seen with its
   * Cloudflare container RUNNING (and billing) anyway — a rollout that placed
   * an instance after a destroy, a path that started it. Written only by
   * container-watch.ts's observeContainer, which reads the runtime's own
   * `ctx.container.running` flag and never execs (an exec STARTS a stopped
   * container). `null`/absent: not seen running. Meaningful only while
   * `state` is `stopped`; readers ignore it otherwise.
   */
  containerRunningSince?: string | null;
  /**
   * Issue #116: the LAST bring-up found the lead's newest session under a
   * worktree project key (claude keys a transcript to the worktree's path once
   * the lead enters one) and copied it into the checkout's root key, so
   * bring-up's `--continue` guard saw it. Names the session claude resumed and
   * the key it came from. `null`/absent: that bring-up adopted nothing — the
   * root key already held the newest session, or there was none, or the check
   * could not tell. Written by provision.ts's runProvision/runRestart only.
   */
  sessionAdoption?: { sessionId: string; fromKey: string; at: string } | null;
  /** PR #46 review: the last aside ship's failures (session-sync.ts's
   *  ASIDE_SHIP_KEY), mirrored by mirrorBurnToRegistry; `fleet ls` prints them. */
  asideShip?: { at: string; failed: { dir: string; reason: string }[] } | null;
  /** Issue #39: recycle's pre-destroy rescue, one human line per worktree
   *  (rescue.ts's formatRescueReport). Set only by the recycle that ran it. */
  rescueReport?: string[];
}

export interface ProvisionConfig {
  repo: string;
  role: string;
  /**
   * Issue #269: WHICH instance of `role` in `repo` this config provisions.
   *
   * `repo` and `role` alone stopped naming a studio the moment a repo could
   * run more than one of a role, and this config is what every id-rebuilding
   * site downstream reads: provision.ts's runProvision and resolveBringupEnv,
   * do.ts's provision and provisionCore all compute their own id as
   * `buildStudioId(cfg)`. Absent means 1 — the bare `<repo>--<role>` id — so
   * every caller written before this field existed keeps naming exactly the
   * studio it always did.
   *
   * Set from the id the Worker already parsed (routes.ts) or resolved
   * (spawn.ts's allocation), never from a request body field of its own: the
   * id and the container must name the same studio, and a caller that could
   * send an instance the id does not carry would break that.
   */
  instance?: number;
  /**
   * Fleet Spawn P3, Task 2: the parent studio id to record on the child's
   * status (see StudioStatus.spawnedBy). Only src/studio/spawn.ts's core
   * sets this, from a parent it resolved server-side — the operator-facing
   * POST /studio/:id/provision route builds its config field by field and
   * never reads this from a request body, so a caller cannot claim a
   * parentage the Worker did not verify.
   */
  spawnedBy?: string;
  /**
   * Task 11: an explicit override for which blueprint ref (tag/branch/sha)
   * to pull the role file + org.json from. Optional — when absent, the
   * blueprint wiring (provision.ts) falls back to fleet.json's OWN pinned
   * `blueprint.ref`, which is the normal case. routes.ts validates this
   * (non-empty, tag/branch/sha charset) before it ever reaches here; it must
   * NOT be defaulted to a literal "main" at the route layer any more — doing
   * so would make every request look like an explicit override and silently
   * defeat fleet.json's own pin.
   */
  blueprintRef?: string;
  /**
   * Issue #28: `fleet provision|recycle --fresh-session`. THIS bring-up only
   * skips the worktree-session adopt and runs with FLEET_FRESH_SESSION=1, so
   * studio-bringup.sh moves the old session aside (never deletes) and claude
   * starts without `--continue`. Never persisted: the stored role env every
   * later restart/heal replays does not carry it.
   */
  freshSession?: boolean;
  /**
   * Issue #115: `fleet provision <id> --no-fresh-session`. This call's own
   * explicit clear of a STUCK `FRESH_SESSION_PENDING_KEY` (provision.ts's own
   * doc comment on that key) — the marker a failed `--fresh-session` attempt
   * left armed, which no route or CLI verb could previously clear other than
   * a LATER, successful, CONFIRMED fresh-session attempt. Mutually exclusive
   * with `freshSession` above at the route layer (routes.ts refuses a request
   * carrying both, 400, rather than silently resolving the contradiction);
   * `provisionWithStorage` (provision.ts) also treats this as winning over
   * any `freshSession` present on the SAME call, as the defensive floor for
   * any other caller. Cleared UNCONDITIONALLY and FIRST, before `runProvision`
   * ever runs — same "durability first" ordering the key's own arm side
   * already uses. The provision then proceeds as an ordinary (non-fresh)
   * call. Never persisted onto the stored role env, same as `freshSession`.
   */
  cancelFreshSession?: boolean;
  /**
   * Board task #131 ask 2: `fleet recycle <id> --account mapped`. With
   * FLEET_AUTO_FAILOVER=on, `launchAccount` (src/studio/accounts.ts) serves a
   * studio's RECORDED account verbatim, without even consulting
   * CLAUDE_ACCOUNT_BY_REPO — a map change never reaches a studio an earlier
   * failover recorded elsewhere, and until this field existed the only lever
   * was flipping failover off and recycling. `true` only when the operator
   * passed `--account mapped` — `do.ts`'s `recycle()` then clears the
   * recorded account (and its moved-audit trail) as the very first thing it
   * does, before touching the container, so the studio relaunches on its
   * plain mapped slot instead. Absent/false: an ordinary recycle, unaffected.
   * Only ever set from routes.ts's `?account=mapped` query param, same
   * "resolved by the Worker, never read straight from a request body"
   * posture as every other override on this type.
   */
  forceMappedAccount?: true;
  /**
   * Dynamic repo selection (P4a): the full `owner/repo` of the WORK repo to
   * clone. Absent means "whatever this studio is already bound to, else the
   * fleet default" — runProvision resolves that fallback, which is what
   * makes a bodyless re-provision or a recycle keep cloning the same repo.
   *
   * Only ever set from a slug the Worker itself resolved and verified
   * against the GitHub App installation (routes.ts -> repo.ts's
   * resolveWorkRepo). Never read straight from a request body here, for the
   * same reason `spawnedBy` isn't: a caller must not be able to name the
   * repo a container checks out.
   *
   * Deliberately NOT the same field as `repo` above, which stays the SHORT
   * name — it is the studio id's own repo segment and the `/workspace/<x>`
   * checkout directory, both of which must keep their existing values for
   * every studio that already exists.
   */
  repoSlug?: string;
  /**
   * P4a-2 (brief pickup): the task brief block to append to this studio's
   * lead prompt, already rendered (src/board/brief.ts's renderBriefPrompt).
   * Absent means "no task" — every studio spawned without one, and every
   * studio that predates this feature.
   *
   * A rendered STRING rather than a task number or a BoardTask, for the same
   * boundary reason `repoSlug` is a resolved slug and not a request field:
   * provisioning must not have to know what the board is. The Worker reads
   * the issue, checks it is assigned to the studio it is about to build
   * (src/board/board.ts's resolveBriefPrompt), renders, and hands the result
   * down. Only ever set from that path — never read from a request body, for
   * exactly the reason `spawnedBy` isn't: a caller that could write a lead's
   * system prompt could write anything.
   *
   * Not persisted separately: it rides into ROLE_ENV_KEY inside
   * ROLE_PROMPT_B64, so a RESTART reuses it unchanged. A later brief-less
   * re-provision re-resolves the env from the blueprint and drops it — by
   * then claude is already running with the brief in its own system prompt,
   * and the task is still on the board under this studio's own label.
   */
  briefPrompt?: string;
  /**
   * P5c (Directus estate): the rendered PROJECT CARD — 10-20 lines of estate
   * fact (which repo, which account, which URLs, what is at stake, which
   * decisions are open), appended to this studio's lead prompt ahead of any
   * task brief. src/directus/card.ts renders it; §7 rules its shape and its
   * tiering.
   *
   * A rendered STRING, resolved by the Worker, for exactly the reasons
   * `briefPrompt` above is one — a caller that could write a lead's system
   * prompt could write anything, and provisioning must not have to know what
   * Directus is. Only ever set from src/studio/routes.ts, which calls
   * `resolveProjectCard(env, cfg.repo)`; never read from a request body.
   *
   * OPTIONAL, AND THAT IS A DESIGN RULING, not an oversight: "Directus must
   * be optional at boot — a studio still comes up when it is unreachable. A
   * fifth store that can block provisioning is a fifth way to have no
   * fleet." Absent means no credential, an unreachable instance, or a repo
   * with no estate row; all three provision identically to pre-P5c.
   *
   * Not persisted separately: like `briefPrompt` it rides into ROLE_ENV_KEY
   * inside ROLE_PROMPT_B64, so a RESTART reuses the card unchanged without
   * needing Directus to be reachable at restart time.
   *
   * STAKES TIER ONLY. The card renderer's input type carries no commercial
   * field, so a price cannot arrive here. See src/directus/card.ts.
   */
  projectCard?: string;
}
