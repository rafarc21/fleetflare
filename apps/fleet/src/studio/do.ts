import { Sandbox } from "@cloudflare/sandbox";
import { resolveMemoryRepo as memoryRepoFromEnv } from "../memory/store";
import type { Env } from "../env";
import type { ProvisionConfig, StudioStatus, StudioReadiness } from "./types";
import type { SessionMark } from "./burn";
import {
  sbExec, sbWriteFile, sbSetKeepAlive, sbAttachPty, sbAwaitReady, sbContainerBooting, EXEC_CLASSES, isDeadlineExit,
  DEADLINE_SLACK_MS,
} from "./sandbox-api";
import { runGatedWake, singleFlightWake, logWakeOutcome, type WakeOutcome, type WakeExec } from "./wake";
import { runInspect, type InspectOutcome } from "./inspect";
import {
  sweepTick, SWEEP_SECONDS, QUIESCENT_STREAK_KEY, SWEEP_STOPPED_KEY,
} from "./sweep";
import type { QuiescenceDeps } from "./quiescence";
import { TerminalBridge, TERMINAL_PATH } from "./terminal";
import { recordStudio, listStudios } from "./registry";
import { buildStudioId, parseStudioId } from "./ids";
import {
  provisionWithStorage, getStatusWithStorage, restartWithStorage, freshStatus, provisionedCheckCmd, PROVISIONED_OK,
  PROVISIONED_UNKNOWN, harnessExpectation, ROLE_ENV_KEY,
  STATUS_KEY, resolveWorkRepoSlug, NO_ROLE_ENV_ERROR, HEAL_ATTEMPT_KEY, relaunchBringup,
  OPERATION_KEY, OPERATION_STALE_MS, DESTROYING_KEY, DESTROY_IN_FLIGHT, LAST_STOP_KEY,
  destroyingMarkerFresh, watchForDestroy, operationLockFresh,
  readDestroyEpoch, createOpCtx, NEVER_MOVED_CTX,
  type ProvisionDeps, type StudioStorage, type RoleEnv, type StudioEnv, type HealAttempt,
  type OperationInFlight, type LastStop, type OpCtx,
} from "./provision";
// Issue #53: the claude ACCOUNT list, and the exhaustion failover that walks
// it. Both live in sandbox-free modules for the usual reason (see
// credentials.ts's header) — this file wires their ports and owns the
// schedule, nothing more.
import {
  resolveClaudeAccounts, claudeAccountToken, launchAccount, autoFailoverOn, accountDisplay, type LaunchAccount,
} from "./accounts";
import {
  runAccountFailover, paneCaptureCmd, evaluateDegradedRecovery, MEMBERS_TICKING_KEY, type FailoverDeps,
} from "./failover";
// Issue #249 (PR4b): #107/#150's survival re-brief, delivered. Own
// sandbox-free module for the usual reason (see credentials.ts's header) —
// `deliverSurvivalOnBringup` below wires its ports and nothing more.
import {
  deliverSurvivalBriefOnBringup, retryPendingSurvivalBrief, composeSurvivalDelivery, paneBusy,
  rescueBranchPrefix, SURVIVAL_COMPARE_BASE,
  type BusyVerdict, type ComposedBrief, type SurvivalDeliveryOutcome,
  type SurvivalSources, type SurvivalTaskRef,
} from "./survival-delivery";
import {
  nextActivity, ACTIVITY_KEY, clearActivityState,
  backgroundShellAgeMs, BACKGROUND_SHELL_STALE_MS,
  type Activity, type ActivityStorage, type FrameVerdict, type HookHeartbeat,
} from "./activity";
import {
  LIMIT_SIGHTING_KEY, type LimitSighting,
  accountLimitStateKey, encodeAccountLimitState, decodeAccountLimitState,
} from "./rate-limit";
import type { AccountLimits, ClaudeAccount } from "./accounts";
// Issue #102: the fleet-wide per-account limit record lives in D1
// (fleet_state), the same generic key/value table issue #5's junior-
// authorization flag already uses — reused via state.ts's own getFlag/setFlag
// rather than a new table, exactly as this file's own header favours no new
// storage mechanism for something an existing one already covers.
import { getFlag, setFlag } from "../state";
import {
  shipTranscriptTick, getTranscriptTailWithStorage, type ShipDeps, type TranscriptStorage, type ShipResult,
} from "./transcript";
import {
  parseMemberRows, buildMemberAlerts, MEMBER_ALERTS_KEY, MEMBER_ROWS_KEY,
  type MemberAlertsStorage, type MemberAlert,
} from "./member-alerts";
import { RESTARTS_KEY, type RestartStorage } from "./restarts";
import type { MemguardKillLogEntry } from "./memguard-log";
import {
  syncSessionTick, shipAsideSessions, asideNotShippedNote, ASIDE_SHIP_KEY, BURN_KEY, SYNC_SESSION_SECONDS, SESSION_GUARD_KEY, SESSION_MARK_KEY, SESSION_FORCE_KEY,
  BURN_PERSIST_ERROR_KEY,
  type SessionSyncDeps, type SessionSyncStorage, type SyncResult,
} from "./session-sync";
import { runDestroy, type DestroyOutcome } from "./destroy";
import {
  isInstallCacheRepo, presignR2, runInstallCacheSaveTick, installCacheSaveLeaseFresh,
  INSTALL_CACHE_SAVE_LEASE_KEY,
  type InstallCacheSaveDeps, type InstallCacheSaveStorage,
} from "./install-cache";
import { pasteWithStorage } from "./paste";
import { redactSecrets } from "./redact";
import { DONE_RECORD_COMMENT_MARKER } from "../board/comment-wake";
import {
  getObserved, mergeObserved, isIncarnationToken, computeAdoptedVerdict,
  type Observed, type ObservedSession, type ObservedStorage, type BringupVia,
} from "./observed";
import { recycleRefusal, recycleRescueFailedRefusal, recycleRescueUnconfirmedRefusal, recycleCostLine, RECYCLE_REFUSED_PREFIX } from "./recycle-cost";
import { sessionLatestKey } from "./archive";
export { RECYCLE_REFUSED_PREFIX };
// Issue #38: the bring-up log's Worker-side half. Deliberately its own import
// line rather than three more names on the bulk `./provision` import above —
// that statement is being rewritten by two other in-flight branches at the
// same time, and a separate line cannot conflict with either.
import { bringupLogTailCmd, BRINGUP_LOG_PATH, BRINGUP_LOG_TAIL_MAX_CHARS } from "./provision";
// Issue #330: the house-rules overlay reads the ops repo #346 resolves.
import { resolveOpsRepo } from "../ops-repo";
// Task 7: FLEET_JUNIOR/JUNIOR_REPOS -> whether this work repo gets the
// junior skill + house rule at bring-up (never the maestro — provision.ts's
// own exclusion).
import { juniorEnabled } from "../junior/gate";
// Board task #149: the credential command builders moved to their own
// sandbox-free module so the bun:test lane can ask real git which
// credential it picks — see credentials.ts's own header. Re-exported
// here so every existing `from "./do"` importer is unchanged.
import { credentialWriteCmd, credentialClearCmd, blueprintCredentialWriteCmd, studioGitSafetyCmd, tokenEnv, FLEET_TOKEN_ENV } from "./credentials";
import { leakGateInstallCmd } from "./gh-wrapper";
export { credentialWriteCmd, credentialClearCmd, blueprintCredentialWriteCmd, studioGitSafetyCmd, tokenEnv, FLEET_TOKEN_ENV };

import { mintSpawnToken, hashSpawnToken } from "./org";
import { mintRepoToken, repoTokenMinter } from "../github/auth";
import { containerToken, resolveWriteMode, studioCredential, writeModeFor, type WriteMode } from "../write-proxy/mode";
import { writeProxyConfigCmd } from "../write-proxy/container-config";
import {
  fetchRepoFile, createRepoFile, upsertRepoFile, listOpenPullNumbers, repoIsPrivate,
  // Issue #249 (PR4b): the survival re-brief's three GitHub reads, all from
  // OUTSIDE the container. `compareAhead` in particular is the spec's loudest
  // correction on this feature — a studio's own clone is shallow and
  // single-branch, so `git log origin/main..origin/<branch>` run inside one
  // overcounts a genuinely 0-ahead branch.
  compareAhead, getPullRequest, listMatchingBranches,
} from "../github/api";
import { sendCard } from "../telegram/api";
import { parseLearnings, parseEnvelopeComment } from "../board/envelope";
import { assignedBriefResolver, openTaskChecker, githubBoardApi } from "../board/routes";
import { listTasks, resolveLatestAssignedBrief, autoStartSubmittedTasks } from "../board/board";
// Issue #249 (PR4b): "live" is the board's own state, not GitHub's open flag —
// a terminal state leaves the issue open, and a finished task's branch is not
// work a fresh lead needs re-briefed on. Same filter
// `resolveLatestAssignedBrief` already applies.
import { LIVE_TASK_STATES } from "../board/types";
// Board issue #213: the SAME one-line pointer format wakeOnAssign already
// types into a RUNNING studio's pane, reused here for a studio's bring-up —
// see deliverAssignedTaskOnBringup's own doc comment for why the multi-line
// resolveLatestAssignedBrief `prompt` field must never be typed into a live
// pane instead. No cycle: assign-wake.ts's only studio/ import is a
// type-only one (WakeOutcome from ./wake), elided at build time.
import { assignDigest } from "../board/assign-wake";
import { observeContainer } from "./container-watch";
// A studio has no chatId of its own, so its alerts address the one human
// operator directly. Board #334: operator and token come from
// telegramConfig — Telegram off → every studio alert is a no-op.
import { telegramConfig } from "../agents/registry";
import { HARVEST_NO_RECORD, doneRecordsListCmd, harvestRecordCmd } from "./harvest-record";
export { HARVEST_NO_RECORD, doneRecordsListCmd, harvestRecordCmd } from "./harvest-record";
export type { DoneRecordPorts } from "./session-sync";
import type { DoneRecordPorts } from "./session-sync";

// StudioDO is container-backed, so it cannot be constructed under
// vitest-pool-workers: `env.STUDIO.get(...).fetch(...)` throws "Containers
// have not been enabled for this Durable Object class" (verified with a
// throwaway probe against the real binding). Every method below is therefore
// a thin forward to something that IS testable — provision.ts for the
// provisioning state machine (including the storage read/write sequence, via
// its StudioStorage port), terminal.ts for the whole WS bridge. Nothing that
// can hold a bug should live in a class method itself.
//
// Task 7 (GitHub token refresh) is the one exception to "extract into its
// own file": its brief scoped this task to do.ts alone, so the pure
// refresh functions (runRefreshCredential, runRefreshToken,
// refreshWithStorage — below, above the class) live directly here instead
// of a sibling refresh.ts, the same way src/agents/do.ts hosts pollOnce/
// pollAndClearRearm/shouldClearRearm alongside AgentDO rather than pulling
// them into tasks/loop.ts. do.ts's own class methods (provision/
// refreshToken) stay thin forwards to them, same as everywhere else in this
// file — see test/studio.refresh.test.ts for the "one code path, two call
// sites" coverage.
//
// It also carries the one required real value import of "@cloudflare/sandbox"
// in this feature (`extends Sandbox<Env>` needs the class at runtime). That
// import used to throw under the test pool, which is why this file was long
// absent from index.ts's exports; Task 5's Step 0 fixed the pool, and
// index.ts exports StudioDO now — see provision.ts's header for the full
// history.

// ---------------------------------------------------------------------------
// Task 7: GitHub token refresh — the ONE mint+credential-write mechanic
// shared by provision() (initial credential, so a private AGENT_REPO's
// clone can authenticate on the very first provision — controller ruling,
// Task 4 discovery) and the recurring refreshToken() schedule callback
// (both below, inside the class). "One code path, two call sites."
// ---------------------------------------------------------------------------

/** 50 minutes. GitHub expires an installation token after 60 (see
 *  src/github/app.ts's mintInstallationToken doc comment); refreshing at 50
 *  leaves a 10-minute margin against the mint round trip and clock drift —
 *  the same conservative-margin idea as appJwt's own 60s iat skew
 *  allowance, one file over. */
export const REFRESH_SECONDS = 3000;

/**
 * P2 plane 1 (transcript durability): how often the `shipTranscript`
 * schedule below fires. Design spec's own number ("StudioDO schedule
 * shipTranscript every 30s") — short, unlike REFRESH_SECONDS above, because
 * an operator watching the grid card (a later task) wants the hot-tail
 * preview to feel close to live, and because R2 chunk objects have no
 * meaningful cost pressure at this cadence (unlike GitHub's 60-minute token
 * lifetime, which is what actually bounds REFRESH_SECONDS).
 */
export const SHIP_TRANSCRIPT_SECONDS = 30;

export interface RefreshDeps {
  /** Issue #7: null = no credential for this studio (proxy mode, no read
   *  token) -- the container's credential files are cleared instead. Gets
   *  the mode `writeProxy` resolved (undefined when that port is absent). */
  mintToken: (mode?: WriteMode) => Promise<string | null>;
  /** Issue #7 (#13 review): the write mode, resolved once per refresh, and
   *  the Worker URL its git config points at. Absent = no proxy step. */
  writeProxy?: { workerUrl: string; mode: () => Promise<WriteMode> };
  // `env`: the credential write's token rides here (#110 review), never in `cmd`.
  sbExec: (cmd: string, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  recordStudio: (status: StudioStatus) => Promise<void>;
  /** Telegram alert. do.ts's real instance plugs in sendCard against
   *  OPERATOR_ID — see the import comment above for why that recipient. */
  notify: (message: string) => Promise<void>;
  now: () => string;
}

/**
 * The shared mint+write mechanic — "one code path, two call sites" per the
 * controller's ruling. Returns a plain ok/error union rather than throwing:
 * the two call sites react to a failure differently (provision routes the
 * result through runRefreshToken too — see provision()'s own comment — and
 * refreshToken degrades the status and alerts), and a thrown error would
 * just force both to wrap this in an identical try/catch anyway.
 *
 * credentialWriteCmd's return value embeds the raw token, but it is only
 * ever handed to deps.sbExec here — never folded into the thrown/returned
 * error message below, which is built from `res.stderr` (the shell's own
 * output) only. redactSecrets is still applied to that error before it is
 * returned, and this pass is LOAD-BEARING, not belt-and-braces: a shell
 * syntax error (e.g. a malformed quote reaching the command bash actually
 * ran) can make bash echo the offending line — including the embedded
 * token — verbatim into stderr. `res.stderr` is therefore a real,
 * reachable path for the raw token to appear in `err.message` above, not
 * just a hypothetical one; do not remove this regex pass on the theory that
 * "we never put the command in the message ourselves."
 */
export async function runRefreshCredential(
  deps: RefreshDeps,
): Promise<{ ok: true; lastRefresh: string } | { ok: false; error: string }> {
  try {
    // Issue #7: git config for the mode FIRST. A studio must never hold a
    // read-only credential without the proxy config that makes pushes work:
    // a failed proxy config leaves the credential as it was.
    let mode: WriteMode | undefined;
    if (deps.writeProxy) {
      mode = await deps.writeProxy.mode();
      const cfg = await deps.sbExec(writeProxyConfigCmd(mode, deps.writeProxy.workerUrl));
      if (cfg.code !== 0 && mode === "proxy") {
        throw new Error(`write proxy config failed (${cfg.code}): ${cfg.stderr.slice(0, 500)} -- credential not swapped`);
      }
    }
    const token = await deps.mintToken(mode);
    const res = token === null
      ? await deps.sbExec(credentialClearCmd())
      : await deps.sbExec(credentialWriteCmd(), tokenEnv(token));
    if (res.code !== 0) {
      throw new Error(`credential write failed (${res.code}): ${res.stderr.slice(0, 500)}`);
    }
    return { ok: true, lastRefresh: deps.now() };
  } catch (err) {
    return { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * Task 6 (P2 ride-along): reads the tailnet hostname studio-bringup.sh wrote
 * to /workspace/.ts-host (guarded there — absent tailscale, or not up yet,
 * skips the write, so the file may legitimately not exist). Deliberately a
 * SEPARATE sbExec call from runRefreshCredential's, not chained onto it:
 * that command's exit code is load-bearing (its own `res.code !== 0` check
 * above), and a merely-missing ts-host file must never be read as
 * "credential write failed".
 *
 * Two distinct "no host" outcomes, matching the design spec exactly:
 *   - the file is genuinely absent or empty (`cat` exits non-zero, or
 *     exits zero with nothing to print) — a real signal, not an error:
 *     {ok:true, host:null}, which runRefreshToken below writes into status
 *     as-is (clearing any stale previously-known host).
 *   - sbExec itself throws — a container communication failure, not a
 *     shell exit code, so it says nothing about whether the host is
 *     actually gone: {ok:false}, which runRefreshToken leaves alone rather
 *     than clobbering a last-known-good host with null on a transient
 *     error. Never lets the throw propagate — the design spec is explicit
 *     that a read failure must never fail the refresh tick that carries it.
 */
export async function readTailscaleHost(
  sbExec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: true; host: string | null } | { ok: false }> {
  try {
    const res = await sbExec("cat /workspace/.ts-host 2>/dev/null");
    // #110 review: a killed read answers nothing — never clear a known host on it.
    if (isDeadlineExit(res.code)) return { ok: false };
    const host = res.stdout.trim();
    return { ok: true, host: host.length > 0 ? host : null };
  } catch (err) {
    console.error("studio tailscaleHost read failed", err);
    return { ok: false };
  }
}

/**
 * refreshToken's pure half — existing-status-in, next-status-out, the same
 * shape as provision.ts's runProvision/runRestart, for the same
 * untestable-DO reason.
 *
 * Review round 1, C2: `state`/`error` are a SHARED channel — provision and
 * restart write the exact same fields. The original version of this
 * function used `state === "degraded"` as its own private streak marker,
 * which broke two ways at once: (a) an unrelated degradation (a failed
 * clone, say) made `state` already "degraded" before refresh ever ran, so
 * refresh's OWN first failure looked like "already alerted" and silently
 * never notified; (b) a successful refresh unconditionally stamped
 * `state: "running", error: null`, silently erasing a degradation refresh
 * never caused (e.g. hiding a still-broken clone behind a falsely healthy
 * status). `lastRefreshError` (types.ts) is refresh's OWN channel — nothing
 * else writes it — so both bugs are fixed by reading/writing it instead of
 * inferring anything from `state`:
 *
 * Success: `lastRefresh` bumped, `lastRefreshError` unconditionally cleared
 * to null. `state`/`error` are touched ONLY when the CURRENT degradation is
 * provably refresh's own — decided by `ownsDegradation` below (the stored
 * `error` is exactly the last error refresh itself wrote) — in which case
 * they flip back to `running`/`null`. Any OTHER degradation (a failed
 * clone/restart) is left completely alone: a successful token refresh
 * cannot fix a checkout that was never cloned, and must not claim to.
 *
 * Failure: `state: "degraded"`, `error` AND `lastRefreshError` both set to
 * the same scrubbed message (already scrubbed by runRefreshCredential).
 * The telegram alert fires once per `lastRefreshError` streak — i.e.
 * whenever the PREVIOUS `lastRefreshError` was null — regardless of what
 * `state` was already set to by some other writer. Because success always
 * clears `lastRefreshError`, the very next failure after a recovery reads
 * as a NEW streak and alerts again.
 */
export async function runRefreshToken(
  deps: RefreshDeps, existing: StudioStatus | null, idFallback: string,
): Promise<StudioStatus> {
  const base: StudioStatus = existing ?? {
    id: idFallback, state: "provisioning", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  };
  const result = await runRefreshCredential(deps);
  let next: StudioStatus;
  if (result.ok) {
    const ownsDegradation = base.lastRefreshError !== null && base.error === base.lastRefreshError;
    next = {
      ...base,
      lastRefresh: result.lastRefresh,
      lastRefreshError: null,
      ...(ownsDegradation ? { state: "running" as const, error: null } : {}),
    };
  } else {
    const isNewStreak = base.lastRefreshError === null;
    next = { ...base, state: "degraded", error: result.error, lastRefreshError: result.error };
    if (isNewStreak) {
      try {
        await deps.notify(`studio ${next.id}: GitHub token refresh failed — ${result.error}`);
      } catch (err) {
        // Same rule as deploy/do.ts's terminalReport and agents/do.ts's
        // abort-on-terminal catch: a failed alert must not unwind an
        // already-computed, already-degraded status.
        console.error("studio refresh telegram alert failed", err);
      }
    }
  }

  // Task 6 (P2 ride-along): runs every tick regardless of the credential
  // mint/write outcome above — a studio's tailnet reachability is unrelated
  // to its GitHub token. See readTailscaleHost's own doc comment for why
  // absent -> null (overwrite) but a throw leaves `next.tailscaleHost`
  // (already carried forward from `base` by the spreads above) untouched.
  const tsHost = await readTailscaleHost(deps.sbExec);
  if (tsHost.ok) next = { ...next, tailscaleHost: tsHost.host };

  await deps.recordStudio(next);
  return next;
}

/**
 * Storage-aware wrapper — mirrors provision.ts's provisionWithStorage/
 * restartWithStorage exactly: read existing from STATUS_KEY, compute the
 * next status via the pure function above, write it back. do.ts's real
 * refreshToken() method and test/studio.refresh.test.ts both call this
 * directly, instead of each separately reimplementing the read/compute/
 * write sequence — review round 2, Important 2's lesson on provision.ts,
 * applied here too.
 */
export async function refreshWithStorage(
  deps: RefreshDeps, storage: StudioStorage, idFallback: string,
  // Issue #152: an outer operation's own epoch claim, checked IN ADDITION TO
  // this function's own pre-existing `watchForDestroy` snapshot below — never
  // replacing it. `watchForDestroy` alone stays exactly what issue #123 built
  // for the plain scheduled-tick call (no ctx supplied, default below is a
  // no-op) — this parameter only tightens the guard for a caller that is
  // itself part of a larger op (provision/restart) already tracking a #152
  // epoch, so a destroy that lands and fully completes before this refresh's
  // OWN watchForDestroy snapshot was even taken (see that function's own doc
  // comment for exactly how it goes blind) is still caught.
  ctx: OpCtx = NEVER_MOVED_CTX,
): Promise<StudioStatus> {
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  // Issue #123: a destroy landing during the refresh exec must not get this
  // stale row (nor its refusal, recorded as a refresh error) written back.
  const destroyLanded = await watchForDestroy(storage, () => new Date());
  const moved = async () => (await destroyLanded()) || (await ctx.moved());
  const status = await runRefreshToken({
    ...deps,
    notify: async (m) => { if (!(await moved())) await deps.notify(m); },
    recordStudio: async (s) => { if (!(await moved())) await deps.recordStudio(s); },
  }, existing, idFallback);
  if (await moved()) return (await storage.get(STATUS_KEY)) ?? status;
  await storage.put(STATUS_KEY, status);
  return status;
}

/**
 * Issue #85 review round 3, MUST-FIX 8(a) — shared by every caller of
 * `syncSessionTick` that must mirror a successful `latest` R2 put into
 * `Observed.lastSnapshotAt`: `syncSessionCycle`'s own 300s tick already did
 * this; `restartWithSync`'s pre-restart sync, `recycleWithSync`'s
 * pre-destroy sync, and `destroyWithSync`'s (destroy.ts) own pre-destroy
 * sync each independently succeed at the identical put and, before this fix,
 * never recorded it — leaving `fleet ls`'s `snap <age>` column able to read
 * stale by up to `SYNC_SESSION_SECONDS` after any of those three ran.
 * `result.skipped` is the ONLY place `syncSessionTick` signals its own R2
 * put did NOT run (the oversize guard, session-sync.ts) — `undefined` here
 * already means the put ran and did not throw.
 */
export async function recordSnapshotOnSuccess(
  observedStorage: ObservedStorage | null | undefined, result: SyncResult, now: string,
): Promise<void> {
  if (observedStorage && result.skipped === undefined) {
    await mergeObserved(observedStorage, { lastSnapshotAt: now });
  }
}

/**
 * Issue #228 HOLD fix, item 1: a pre-teardown sync (restart/recycle/destroy)
 * that CONSUMES the one-shot force-upload override (SESSION_FORCE_KEY
 * deleted, session-sync.ts's `syncSessionTick`) never told STATUS_KEY's own
 * `sessionForceArmedAt` stamp — that field kept whatever ISO string
 * `clearSessionGuard` wrote at arm-time, forever, because the only place that
 * ever cleared it was `mirrorBurnToRegistry`, and `mirrorBurnToRegistry` is
 * ONLY called from `syncSessionCycle`'s own periodic tick (do.ts), never from
 * restartWithSync/recycleWithSync/destroyWithSync's own pre-teardown sync.
 * `fleet ls`/`fleet inspect` then kept printing "force-next-sync armed since
 * <T>" for a studio whose override was long since consumed — sometimes
 * forever, for a destroyed studio whose row will never see another tick.
 *
 * Called from the `finally` of each of those three sites' own sync
 * try/catch, so it runs whether the sync succeeded, failed outright, or
 * threw AFTER already consuming the override (e.g. the daily-keeper R2 put
 * inside the same tick, session-sync.ts) — in every one of those cases the
 * key is gone the moment this reads it, so the stamp is stale and must go.
 *
 * Reads SESSION_FORCE_KEY fresh rather than trusting the tick's own return
 * value: still-armed (`true`) means this tick never consumed it (a displaced
 * candidate, a skipped sync, or no sync attempted at all) and the stamp is
 * legitimately still current, so this is a no-op. Only clears the STATUS_KEY
 * field — never touches SESSION_GUARD_KEY or anything else the row carries.
 */
export async function clearConsumedForceStamp(storage: StudioStorage & SessionSyncStorage): Promise<void> {
  if ((await storage.get(SESSION_FORCE_KEY)) === true) return;
  const status = await storage.get(STATUS_KEY);
  if (status?.sessionForceArmedAt) await storage.put(STATUS_KEY, { ...status, sessionForceArmedAt: null });
}

/**
 * Task 3 (P2 plane 2): restartStudio's own composition — one syncSession
 * tick BEFORE restartWithStorage's bring-up, so a container that's about to
 * be healed/recreated ships its latest session state first. Lives here
 * (not provision.ts) because the task brief scopes "restartStudio runs one
 * sync before bring-up" to do.ts, the same way Task 7 scoped the refresh
 * mechanic here rather than a sibling file (see this file's own header) —
 * and because restartWithStorage's own signature (provision.ts, called
 * directly by test/studio.routes.test.ts's fake StudioDO stub) stays
 * untouched by not folding this into it.
 *
 * Design ruling: "Sync/restore failures NEVER touch state/error/
 * lastRefreshError... restart proceeds regardless" — so the sync attempt is
 * caught and logged here, never allowed to propagate and abort the restart
 * that follows. `storage` is typed as the intersection of both ports
 * (StudioStorage for restartWithStorage, SessionSyncStorage for
 * syncSessionTick) — a real `this.ctx.storage` satisfies both structurally
 * with no cast, the same relationship this file's shipDeps/shipTranscript
 * already rely on for TranscriptStorage alongside StudioStorage.
 */
export async function restartWithSync(
  provisionDeps: ProvisionDeps,
  syncDeps: SessionSyncDeps,
  storage: StudioStorage & SessionSyncStorage,
  idFallback: string,
  // Issue #76: restart now issues the guarded clone, and the clone needs the
  // WORK repo. `resolveWorkRepoSlug` reads the studio's own recorded
  // `repoSlug` first, so this is only the fallback for a studio that never
  // recorded one -- the same precedence runProvision already uses, threaded
  // rather than re-derived so the two paths cannot disagree about which repo
  // a container holds.
  fleetRepoSlug: string,
  via: BringupVia = "restart",
  observedStorage?: ObservedStorage,
  // Issue #152: restartStudio's own ctx, threaded straight through to
  // restartWithStorage — see that function's own doc comment.
  ctx: OpCtx = NEVER_MOVED_CTX,
): Promise<StudioStatus> {
  // Issue #228 item 3 (documenting, not changing, an existing interaction):
  // see destroy.ts's identical comment on its own pre-destroy syncSessionTick
  // call, and recycleWithSync's own below (both do.ts) — an override armed
  // via `fleet clear-session-guard` right before a `fleet restart` gets
  // consumed by THIS pre-restart sync, force-uploading the studio's last
  // session (old `latest` preserved under its own `superseded/` key first).
  // Almost certainly the intended behavior — a restart's own pre-bring-up
  // sync IS the "next real sync" the override exists to let through.
  //
  // Issue #228 item 1: `finally`, not the try's tail — clearConsumedForceStamp
  // must still run when the tick consumes the override and then throws (its
  // own daily-keeper R2 put, say), so the row's sessionForceArmedAt never
  // outlives the key it mirrors. See that function's own doc comment above.
  try {
    const result = await syncSessionTick(syncDeps, storage, idFallback);
    await recordSnapshotOnSuccess(observedStorage, result, syncDeps.now().toISOString());
  } catch (err) {
    console.error(`studio ${idFallback}: pre-restart session sync failed, continuing`, err);
  } finally {
    await clearConsumedForceStamp(storage);
  }
  return restartWithStorage(provisionDeps, storage, idFallback, fleetRepoSlug, via, observedStorage, ctx);
}

import {
  rescuePushCmd, rescueSnapshotCmd, RESCUE_NO_CHECKOUT, RESCUE_CLEAN, RESCUE_MARKERS_ONLY, RESCUE_PUSHED_PREFIX,
  RESCUE_FAILED_PREFIX, resolveRescueTarget, RESCUE_WT_PREFIX, formatRescueReport, rescueMintPermissions,
  type RescueWorktree, type RescueTarget,
} from "./rescue";
// Moved to src/studio/rescue.ts (pure, so a bun test runs it against real
// git — issue #217); re-exported so every existing import keeps working.
export {
  rescuePushCmd, rescueSnapshotCmd, RESCUE_NO_CHECKOUT, RESCUE_CLEAN, RESCUE_MARKERS_ONLY, RESCUE_PUSHED_PREFIX,
  RESCUE_FAILED_PREFIX,
};

/** Issue #266: which kind of count `files` describes on a given push — a
 *  dirty-tree rescue's count is real FILES (`git status --porcelain` line
 *  count); a clean-but-unpushed-commits rescue's count is real COMMITS
 *  (`git rev-list --count`). Every RESCUE_PUSHED line now carries this as its
 *  own field (rescue.ts's RESCUE_PUSHED_KIND_FILES/RESCUE_PUSHED_KIND_COMMITS)
 *  so a caller never mislabels one as the other. */
export type RescuePushKind = "files" | "commits";

/** What one rescue-push saved. `pushed: false` on either quiet outcome
 *  (`skipped` names which — "no checkout" or "clean", neither an error).
 *  `pushed: true` means `branch`/`files` describe a real commit that
 *  reached origin before the kill that follows it. `branch` is wherever the
 *  push ACTUALLY landed — the studio's own checked-out branch, or a
 *  generated `fleet/rescue/<studio>-<stamp>` ref when that branch was (or
 *  could not be proven not to be) the repo's default; see rescuePushCmd's
 *  own doc comment. Never `null` when `pushed` is true. */
export interface RescueResult {
  pushed: boolean;
  branch: string | null;
  files: number;
  /** Issue #266: only set when `pushed` is true — which kind of count
   *  `files` actually is (see RescuePushKind's own doc comment above). Left
   *  entirely absent (never a guessed default) on either quiet `pushed:
   *  false` outcome, matching `files: 0`'s own "not a real count" posture,
   *  and matching every existing test's `toEqual` on that shape unchanged. */
  kind?: RescuePushKind;
  skipped?: string;
  /**
   * Issue #251: rescuePushCmd now walks every git worktree (the main
   * checkout plus every member subagent's own), so a single run can push
   * MORE than one rescue ref at once — the main checkout's dirty tree AND a
   * member worktree's, independently, in the same exec. `branch`/`files`
   * above still describe the FIRST one, unchanged, for every caller that
   * only ever needed one (both destroy.ts and do.ts's own recycle path log
   * exactly one line today); this carries the rest. Left `undefined` (never
   * an empty array) on the single-push shape every existing test already
   * asserts with `toEqual`, so those keep matching unchanged.
   */
  pushes?: { branch: string; files: number; kind: RescuePushKind }[];
  /** Issue #39: one entry per worktree rescue.ts walked (RESCUE_WT lines).
   *  Absent when the script printed none, so every older `toEqual` holds. */
  worktrees?: RescueWorktree[];
}

/**
 * PR #263 round 3 (#251 review), N3: a distinct Error subclass for the ONE
 * throw below that means "we KNOW at least one worktree's work did not
 * reach origin" — a real `RESCUE_FAILED <wt> <step>` line from rescue.ts's
 * own script, which by round 3 only happens after ITS OWN push-with-fallback
 * retry (rescue.ts's `rescue_push`) already exhausted both attempts. Every
 * OTHER throw here (a killed exec, an unparseable exit, the exec call itself
 * throwing — e.g. the sandbox session shell dying outright) stays a plain
 * `Error`: those mean "we cannot tell", not "we confirmed a loss". Issue
 * #62: destroy and recycle refuse on BOTH (only the 409's wording differs);
 * this class is what lets them name the confirmed worktree(s).
 *
 * Issue #371 (#362 follow-up): one `step` value, `"budget"`, now optionally
 * carries a THIRD field — `detail` — the remaining-seconds count rescue.ts's
 * own `rescue_budget_ok` names in its own `RESCUE_FAILED <id> budget <n> not
 * attempted` line. Every other `step` (`push`/`commit`/`add`/`status`/
 * `rev-parse`/`rev-list`) never has one, `detail` is left entirely absent
 * (never a guessed default) for those, matching every existing test's own
 * `toEqual` on this shape unchanged.
 */
export class RescuePushFailedError extends Error {
  readonly pushes: { branch: string; files: number; kind: RescuePushKind }[];
  readonly fails: { worktree: string; step: string; detail?: string }[];
  /** Issue #39: every worktree's outcome, the ones that did not fail too. */
  readonly worktrees: RescueWorktree[];
  constructor(
    message: string,
    pushes: { branch: string; files: number; kind: RescuePushKind }[],
    fails: { worktree: string; step: string; detail?: string }[],
    worktrees: RescueWorktree[] = [],
  ) {
    super(message);
    this.name = "RescuePushFailedError";
    this.pushes = pushes;
    this.fails = fails;
    this.worktrees = worktrees;
  }
}

/**
 * Throws on anything it cannot read as one of the three outcomes above (a
 * push rejected, no remote reachable, the exec itself throwing) —
 * deliberately the SAME contract syncSessionTick (session-sync.ts) already
 * has, for the same reason: this function has no way to know whether ITS
 * failure is safe to ignore, only its caller does. Issue #62: destroy and
 * recycle refuse (409) on ANY throw here, confirmed or not, unless the
 * caller passed --discard-unsynced — the original "never block the kill"
 * posture lost unpushed work whenever the rescue could not tell.
 *
 * `studio` is the DO's own id (do.ts's `idFallback` at the call site),
 * threaded through ONLY to name a generated rescue ref (rescuePushCmd's own
 * doc comment) — `repo` alone still locates the checkout, unchanged.
 *
 * PR #263 round 2, C1: two more ways this exec's output must NEVER read as
 * success. `isDeadlineExit` (exec-deadline.ts, #104/#110) is checked BEFORE
 * any output parsing — a killed exec's stdout proves nothing, even a
 * truncated tail that happens to look like a complete, well-formed
 * RESCUE_PUSHED line. And any `RESCUE_FAILED <wt> <step>` line (rescue.ts)
 * always throws, even beside real RESCUE_PUSHED lines from OTHER worktrees
 * in the same run — the thrown message names both, so the caller's 409 (or,
 * under --discard-unsynced, its log line and row note) carries which ref(s)
 * actually landed and which worktree(s) didn't.
 */
export async function rescuePush(deps: SessionSyncDeps, repo: string, studio: string): Promise<RescueResult> {
  // Issue #335: `undefined` for the skipped positional args triggers
  // rescuePushCmd's OWN defaults for those (root/timeouts unchanged) —
  // only botName/botEmail come from deps, absent (undefined) unless the
  // real do.ts syncDeps() set them from env.
  // Issue #1 piece 5: private rescue remote; its token rides exec env only.
  const t = (await deps.rescueTarget?.()) ?? {};
  const cmd = rescuePushCmd(repo, studio, undefined, undefined, undefined, undefined, deps.botName, deps.botEmail, { remoteUrl: t.remoteUrl });
  const res = await (t.env ? deps.exec(cmd, t.env) : deps.exec(cmd));
  return parseRescueExecResult(res, "rescue-push");
}

/**
 * Issue #266: the live, non-mutating counterpart to `rescuePush` — same
 * output contract (parsed by the SAME `parseRescueExecResult` below), built
 * on `rescueSnapshotCmd` instead of `rescuePushCmd`. See that command's own
 * doc comment (rescue.ts) for the full "why a separate command" reasoning:
 * in short, `rescuePushCmd` mutates the real index/HEAD on purpose (correct
 * at teardown, where the container is doomed regardless) and this studio may
 * still be alive when `rescueNow` (below) calls this. Only the caller
 * differs; every outcome (no checkout/clean/markers-only/pushed/failed) and
 * every field on `RescueResult` means exactly the same thing here.
 */
export async function rescueSnapshot(deps: SessionSyncDeps, repo: string, studio: string): Promise<RescueResult> {
  // Issue #335: see rescuePush's own identical comment above.
  // Issue #1 piece 5: see rescuePush's own identical comment above.
  const t = (await deps.rescueTarget?.()) ?? {};
  const cmd = rescueSnapshotCmd(repo, studio, undefined, undefined, undefined, undefined, deps.botName, deps.botEmail, { remoteUrl: t.remoteUrl });
  const res = await (t.env ? deps.exec(cmd, t.env) : deps.exec(cmd));
  return parseRescueExecResult(res, "rescue-snapshot");
}

/**
 * Throws on anything it cannot read as one of the three outcomes above (a
 * push rejected, no remote reachable, the exec itself throwing) —
 * deliberately the SAME contract syncSessionTick (session-sync.ts) already
 * has, for the same reason: this function has no way to know whether ITS
 * failure is safe to ignore, only its caller does. Issue #62: destroy and
 * recycle refuse (409) on ANY throw here, confirmed or not, unless the
 * caller passed --discard-unsynced — the original "never block the kill"
 * posture lost unpushed work whenever the rescue could not tell.
 *
 * PR #263 round 2, C1: two more ways this exec's output must NEVER read as
 * success. `isDeadlineExit` (exec-deadline.ts, #104/#110) is checked BEFORE
 * any output parsing — a killed exec's stdout proves nothing, even a
 * truncated tail that happens to look like a complete, well-formed
 * RESCUE_PUSHED line. And any `RESCUE_FAILED <wt> <step>` line (rescue.ts)
 * always throws, even beside real RESCUE_PUSHED lines from OTHER worktrees
 * in the same run — the thrown message names both, so the caller's 409 (or,
 * under --discard-unsynced, its log line and row note) carries which ref(s)
 * actually landed and which worktree(s) didn't.
 *
 * Issue #266: factored out of `rescuePush` so `rescueSnapshot` (above) can
 * share the identical parse — `rescuePushCmd` and `rescueSnapshotCmd` emit
 * the exact same line shapes (RESCUE_NO_CHECKOUT/RESCUE_CLEAN/
 * RESCUE_MARKERS_ONLY/RESCUE_PUSHED/RESCUE_FAILED), only how the DIRTY-tree
 * case gets there differs, entirely inside rescue.ts's own shell script.
 * `label` only threads into the two throw messages below, so a caller's log
 * line can tell which exec failed.
 */
async function parseRescueExecResult(
  res: { code: number; stdout: string; stderr: string },
  label: "rescue-push" | "rescue-snapshot",
): Promise<RescueResult> {
  if (isDeadlineExit(res.code)) {
    throw new Error(
      `${label} failed: exec killed by its own deadline (exit ${res.code}), output cannot be trusted: ` +
      `${res.stdout.trim().slice(0, 500) || "no output"}`,
    );
  }
  // Issue #39: the per-worktree report lines come out FIRST, so every check
  // below sees exactly the output it always did. A RESCUE_WT line that does
  // not parse stays in, and so fails closed as unrecognisable output.
  const wtLine = new RegExp(`^${RESCUE_WT_PREFIX} (\\S+) (pushed|nothing|failed|unknown)(?: (.+))?$`);
  const worktrees: RescueWorktree[] = [];
  const rest: string[] = [];
  for (const raw of res.stdout.trim().split("\n")) {
    const m = wtLine.exec(raw.trim());
    if (m) worktrees.push({ worktree: m[1], outcome: m[2] as RescueWorktree["outcome"], ...(m[3] !== undefined ? { detail: m[3] } : {}) });
    else rest.push(raw);
  }
  const wt = worktrees.length > 0 ? { worktrees } : {};
  const out = rest.join("\n").trim();
  if (out === RESCUE_NO_CHECKOUT) return { pushed: false, branch: null, files: 0, skipped: "no checkout", ...wt };
  if (out === RESCUE_CLEAN) return { pushed: false, branch: null, files: 0, skipped: "clean", ...wt };
  if (out === RESCUE_MARKERS_ONLY) return { pushed: false, branch: null, files: 0, skipped: "nothing to rescue (only tool markers)", ...wt };
  // Issue #251: one line per worktree actually rescued.
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  // Issue #371, PR #376 review round 2 (maestro must-fix): the `remote:`
  // hint fix below needs tolerance for exactly ONE unrecognised shape — a
  // benign `remote: ...` line git itself can put on stdout — not tolerance
  // for ANY unrecognised line whatsoever. Filtering `remote:`-prefixed lines
  // out BEFORE computing pushes/fails lets the completeness check below be
  // restored scoped to what's left, so a genuinely malformed line (e.g. a
  // `RESCUE_FAILED` line with an empty/missing worktree id, which fails
  // `failLine`'s own `(\S+)` group) still falls through to the generic
  // "unrecognisable output" throw at the bottom, instead of silently
  // vanishing and letting an unrelated real RESCUE_PUSHED line pass as the
  // whole exec's success.
  const nonRemoteLines = lines.filter((l) => !/^remote:/.test(l));
  // Issue #266: a third field says whether the count is real files or real
  // commits (rescue.ts's RESCUE_PUSHED_KIND_FILES/RESCUE_PUSHED_KIND_COMMITS)
  // — a line missing it (an old-format line, or anything else malformed)
  // fails to match here exactly like before, falling through to the same
  // "unrecognisable output" throw (fail closed).
  const pushLine = new RegExp(`^${RESCUE_PUSHED_PREFIX} (\\S+) (\\d+) (files|commits)$`);
  // Issue #371 (#362 follow-up): the trailing `(?: (.*))?` is OPTIONAL and
  // captures everything after the two required fields — rescue.ts's new
  // `rescue_budget_ok` emits a THIRD field (`RESCUE_FAILED <id> budget <n>
  // not attempted`) that every other RESCUE_FAILED line never had. An old,
  // pre-existing two-token line (`push`/`commit`/`add`/`status`/`rev-parse`/
  // `rev-list`) still matches identically to before, with group 3 simply
  // `undefined` — this regex is still end-anchored, so a line with anything
  // OTHER than exactly two or three space-separated fields still fails to
  // match, falling through to the same "unrecognisable output" throw as ever
  // (fail closed).
  const failLine = new RegExp(`^${RESCUE_FAILED_PREFIX} (\\S+) (\\S+)(?: (.*))?$`);
  const pushes = nonRemoteLines.map((l) => pushLine.exec(l)).filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ branch: m[1], files: Number(m[2]), kind: m[3] as RescuePushKind }));
  const fails = nonRemoteLines.map((l) => failLine.exec(l)).filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ worktree: m[1], step: m[2], ...(m[3] !== undefined ? { detail: m[3] } : {}) }));
  // Issue #371, maestro live incident (2026-09-26, main 57a4e9f4 rescue-all):
  // this used to require `pushes.length === lines.length` — every line of
  // stdout had to parse as a recognised RESCUE_PUSHED line, zero tolerance
  // for anything else. A real, successful rescue-snapshot exec (exit 0, two
  // genuine RESCUE_PUSHED lines, zero RESCUE_FAILED) got thrown as a failure
  // anyway because a benign `remote: ...` hint line (git's own "Create a
  // pull request" nudge, present on stderr for every fresh-branch push
  // against a real GitHub remote) rode along on `res.stdout` instead —
  // live-repro'd against a real bare git repo with a post-receive hook
  // emitting that exact text (see this fix's own report for the transcript);
  // rescue.ts's own push call sites keep it off stdout under clean stream
  // separation, but nothing here controls the production exec transport's
  // own stdout/stderr plumbing.
  //
  // PR #376 review round 2 (maestro must-fix): the fix above over-reached —
  // it dropped `res.code === 0` from the gate entirely (a genuinely FAILED
  // exec, e.g. exit 2 from a mid-script bash syntax error, that happened to
  // print one real RESCUE_PUSHED line before crashing then read as a full
  // success, silently losing any unreached worktree — undoing #251's whole
  // fail-closed guarantee), and it dropped ALL line-completeness checking,
  // not just tolerance for `remote:` lines (so a malformed `RESCUE_FAILED`
  // line — e.g. an empty/missing worktree id that fails `failLine`'s own
  // `(\S+)` group — silently vanished instead of failing the exec). Both are
  // restored here, scoped to `nonRemoteLines` so the original `remote:` fix
  // stays intact: `res.code === 0` is now required explicitly, and every
  // remaining non-`remote:` line must still parse as a recognised
  // RESCUE_PUSHED line (`pushes.length === nonRemoteLines.length`).
  if (res.code === 0 && fails.length === 0 && pushes.length > 0 && pushes.length === nonRemoteLines.length) {
    return {
      pushed: true, branch: pushes[0].branch, files: pushes[0].files, kind: pushes[0].kind,
      ...(pushes.length > 1 ? { pushes } : {}),
      ...wt,
    };
  }
  const stderr = res.stderr.trim();
  if (fails.length > 0) {
    const pushedDesc = pushes.length > 0 ? pushes.map((p) => p.branch).join(", ") : "none";
    // Issue #371: a budget-skip's own remaining-seconds detail now surfaces
    // in the thrown message, not only on raw stdout — everything else keeps
    // its pre-existing `<worktree> (<step>)` shape unchanged.
    const failedDesc = fails.map((f) => `${f.worktree} (${f.step}${f.detail ? `: ${f.detail}` : ""})`).join(", ");
    throw new RescuePushFailedError(
      `${label} failed: pushed [${pushedDesc}], failed [${failedDesc}]${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
      pushes, fails, worktrees,
    );
  }
  throw new Error(`${label} failed (exit ${res.code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}): ${out || "no output"}`);
}


/** What one learning-harvest saved. Mirrors RescueResult's own shape:
 *  `harvested: false` on either quiet outcome (`skipped` names which — "no
 *  record" when the delivered task wrote no `/workspace/.fleet/done/<task>.json`
 *  (#361), "no learnings" when the record exists but names none).
 *  `harvested: true` means `count`
 *  file(s) landed under fleet/memory/<studio>/ — possibly fewer than were
 *  FOUND, if a later commit in the same batch failed; see harvestLearnings'
 *  own body for why that still counts as harvested. */
export interface HarvestResult {
  harvested: boolean;
  count: number;
  skipped?: string;
  /** #346: learnings read but committed nowhere because memory is off. */
  lost?: number;
}

/** #346 review: the row note for learnings a recycle/destroy dropped because
 *  memory is off -- never silent loss. */
export function learningsLostNote(verb: "recycled" | "destroyed", lost: number): string {
  return `${verb} with ${lost} learning(s) not harvested: FLEET_OPS_REPO is unset (memory off)`;
}

/**
 * The Worker-side commit primitive `harvestLearnings` is handed, never the
 * container: "containers hold no blueprint-repo write credentials, by
 * design" (task-4-brief.md's Constraints). Takes `repo` explicitly, per
 * call — resolved once per harvest batch by `resolveMemoryRepo` below,
 * never hardcoded. StudioDO.recycle wires this to a minted installation
 * token + github/api.ts's createRepoFile.
 */
export type CommitLearningFile = (repo: string, path: string, content: string, message: string) => Promise<void>;

/**
 * Issue #341: resolves the memory STORE (FLEET_OPS_REPO, src/memory/store.ts),
 * or null when memory is off -- then harvest reads the learnings and commits
 * nothing. It used to resolve the blueprint repo fleet.json names, which is
 * the fleet repo itself, going public: operator learnings must never land
 * there. Still a closure, so the resolution stays testable and is only paid
 * when there is something to commit.
 */
export type ResolveMemoryRepo = () => Promise<string | null>;

const MEMORY_DESCRIPTION_MAX_CHARS = 100;

/** A short, filesystem-safe slug from the learning's own leading text —
 *  mechanical (lowercase, non-alnum runs collapsed to one hyphen), never an
 *  LLM title: this is Worker code committing what an agent already wrote,
 *  not a rewrite step. Bounded so a long learning cannot produce an
 *  unreasonable path. */
function slugify(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 48).replace(/-+$/g, "") || "learning";
}

/**
 * the operator's own memory format (task-4-brief.md: "frontmatter with name +
 * description + metadata.type, then the fact" — see the memory files under
 * a project's ~/.claude/projects/<project>/memory/ directory for the shape
 * this mirrors). The fact is written VERBATIM in the body — spec section 9's
 * second compaction rule ("numbers, names, commands, dates survive
 * verbatim") applies to this, the ORIGINAL write, not only to a later
 * compaction pass; nothing here summarizes. `description` is the one
 * truncated field, and only because YAML wants it on one line — the body
 * below it always carries the whole string.
 */
function memoryFileContent(name: string, learning: string): string {
  const oneLine = learning.replace(/\s+/g, " ").trim();
  const truncated = oneLine.length > MEMORY_DESCRIPTION_MAX_CHARS
    ? `${oneLine.slice(0, MEMORY_DESCRIPTION_MAX_CHARS - 1)}…`
    : oneLine;
  const description = truncated.replace(/"/g, '\\"');
  return `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: learning\n---\n\n${learning}\n`;
}

/**
 * `learnings` is validated with envelope.ts's OWN rule (parseLearnings,
 * wired here rather than reimplemented — task-4-brief.md: "learnings[]
 * already in the schema — wire it") so a harvested learning is held to the
 * identical bar a board envelope's payload.learnings already enforces: an
 * array of strings, trimmed, blanks dropped.
 *
 * One fact per file (memoryFileContent's own comment; spec section 9:
 * "compaction merges INDEX LINES, never memory files") — each learning
 * lands as its OWN commit under fleet/memory/<studio>/, never appended to a
 * shared file, so a later compaction pass can demote or merge ONE fact
 * without touching the others. Filename: `<timestamp>-<index>-<slug>.md` —
 * timestamp+index guarantee uniqueness (a studio's own recycle is
 * serialized by the DO itself, so no two harvests of the SAME studio ever
 * race), the slug is for a human scanning the directory.
 *
 * A commit failure on ONE learning is caught and logged, not fatal to the
 * rest — losing one saved learning to a transient GitHub error is still
 * better than losing the whole batch over it. Anything upstream of that
 * (the exec itself, unparseable JSON, a `learnings` field shaped wrong)
 * throws instead — same contract rescuePush already has, for the same
 * reason: this function has no way to know whether ITS failure is safe to
 * ignore, only its caller (recycleWithSync, right beside rescuePush's own
 * try/catch) does.
 */
export async function harvestLearnings(
  deps: SessionSyncDeps, repo: string, studio: string,
  resolveMemoryRepo: ResolveMemoryRepo, commitFile: CommitLearningFile,
  /** The task this studio was delivered (deliveredTaskIn) — its record is the
   *  one harvested (#316); null when none was delivered. */
  task: number | null,
): Promise<HarvestResult> {
  const res = await deps.exec(harvestRecordCmd(repo, task));
  const out = res.stdout.trim();
  if (out === HARVEST_NO_RECORD) return { harvested: false, count: 0, skipped: "no record" };

  let record: unknown;
  try {
    record = JSON.parse(out);
  } catch {
    throw new Error(`harvest failed: the completion record for task ${task} is not valid JSON`);
  }
  const field = typeof record === "object" && record !== null ? (record as Record<string, unknown>).learnings : undefined;
  const parsed = parseLearnings(field);
  if (!parsed.ok) throw new Error(`harvest failed: ${parsed.message}`);
  if (parsed.list.length === 0) return { harvested: false, count: 0, skipped: "no learnings" };

  // Resolved HERE, not at the top of this function: fleet.json is a real
  // fetch, and most studios die with no learnings (harvestRecordCmd's own
  // doc comment) — paying for it on every clean recycle would be waste for
  // the common case, the same "nothing to harvest" restraint the rest of
  // this function already takes.
  const memoryRepo = await resolveMemoryRepo();
  if (memoryRepo === null) {
    console.error(`studio ${studio}: ${parsed.list.length} learning(s) NOT harvested: FLEET_OPS_REPO is unset (memory off)`);
    return { harvested: false, count: 0, skipped: "memory store off (FLEET_OPS_REPO unset)", lost: parsed.list.length };
  }
  const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
  let count = 0;
  for (let i = 0; i < parsed.list.length; i++) {
    const learning = parsed.list[i];
    const name = `${stamp}-${i}-${slugify(learning)}`;
    const path = `fleet/memory/${studio}/${name}.md`;
    try {
      await commitFile(memoryRepo, path, memoryFileContent(name, learning), `fleet: harvest learning (${studio})`);
      count++;
    } catch (err) {
      console.error(`studio ${studio}: failed to commit harvested learning to ${path}, continuing`, err);
    }
  }
  return { harvested: count > 0, count };
}

/** What one teardown archive of the completion records did (#361). */
export interface ArchiveResult {
  /** Records committed to the ops repo. */
  archived: number;
  /** Records posted on their board task (FLEET_OPS_REPO unset). */
  commented: number;
  /** Records that reached neither -- each one logged. */
  failed: number;
}

/**
 * #367: the minimal shape archiveDoneRecords actually reads off its deps --
 * just `exec`, to list the local records, and the optional `doneRecords`
 * port. SessionSyncDeps (the teardown call site, recycleWithSync below) and
 * ShipDeps once given a `doneRecords` port (the sync-tick call site,
 * runShipTickWithObservation) both satisfy this structurally, with no cast --
 * narrower than either so this one function can serve both without widening
 * either of THEIR own interfaces.
 *
 * #367 round 2: no longer includes a remove/`rm -f` step -- see
 * archiveDoneRecords' own doc comment for why deleting the local record
 * broke two OTHER readers of the same file.
 */
export interface DoneRecordArchiveDeps {
  exec(cmd: string): Promise<{ code: number; stdout: string; stderr: string }>;
  doneRecords?: DoneRecordPorts;
}

/**
 * #367 round 2: the one DO-storage key this function owns -- a single object
 * map, `{ [task]: sha256Hex(body) }`, one entry per task this studio has ever
 * archived. Same "one key, one JSON object" idiom failover.ts's
 * MEMBER_ROWS_KEY/MEMBER_ALERTS_KEY already use for their own per-studio
 * state, rather than one storage key per task -- a studio's own task count is
 * small and bounded, so there is no pruning need this map's own growth would
 * otherwise force.
 */
export const DONE_RECORD_HASHES_KEY = "doneRecordHashes";

/** Keyed storage port for DONE_RECORD_HASHES_KEY -- same narrow, own-key
 *  port pattern as StudioStorage/SessionSyncStorage/TranscriptStorage's own
 *  per-key overloads (own file, own keys, never widening any of those). A
 *  real `this.ctx.storage` satisfies this structurally, with no cast, for
 *  the same reason those do. */
export interface DoneRecordHashStorage {
  get(key: typeof DONE_RECORD_HASHES_KEY): Promise<Record<string, string> | undefined>;
  put(key: typeof DONE_RECORD_HASHES_KEY, value: Record<string, string>): Promise<void>;
}

/** Standard SHA-256 via crypto.subtle, same helper shape provision.ts's own
 *  sha256Hex (session-restore tar manifest) and org.ts's spawn-token hash
 *  already use -- Worker-only (Web Crypto), never shipped to the container. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issue #361: completion records live OUTSIDE the product checkout
 * (harvest-record.ts's DONE_RECORD_DIR) and die with the container. This is
 * their one surviving copy, made by the Worker -- containers hold no ops-repo
 * write credentials, by design (#346):
 *   - FLEET_OPS_REPO set: each record, byte for byte, at
 *     `done/<owner>/<repo>/<task>.json` in the OPS repo. Never the product
 *     repo. (#367: `workRepo`'s own embedded "/" is used AS-IS -- no more
 *     flattening it to "-", which used to let two different (owner, repo)
 *     pairs collide on the identical flattened path.)
 *   - unset (the public default): each record as a comment on its board task.
 *     No repo write at all, and never a throw for the missing setting.
 * Every record in the dir, not only the delivered task's: a studio can close
 * several tasks between two calls, and the next call starts from whatever is
 * still on disk. One record failing is logged and counted, never fatal to
 * the rest. The exec itself failing throws, same contract as harvestLearnings
 * -- its caller decides whether that can block a destroy (it never does).
 *
 * #367: called from TWO sites -- the pre-destroy teardown sequence
 * (recycleWithSync below, and destroy.ts's destroyWithSync) AND the periodic
 * ship tick (runShipTickWithObservation), closing the loss window for a
 * container that dies any OTHER way (eviction, OOM, wedge+hard-stop) from its
 * whole lifetime down to one tick interval.
 *
 * #367 round 2 (review HOLD fix): round 1 made this idempotent between the
 * two call sites by DELETING the local record file the instant it landed
 * (ops repo write OR board comment) -- which broke two OTHER readers of that
 * SAME file: harvestLearnings (do.ts, called right after this at both call
 * sites, reads the identical record for its `learnings` field) and the
 * container's own completion gate (gates/completion-gate.sh), which polls
 * for the file's PRESENCE on every Stop event to confirm a task is genuinely
 * done. Deleting it out from under either one is silent data loss for the
 * first and a refusal loop for the second. The file is never deleted now --
 * idempotence between the two call sites is instead a per-task content hash
 * kept in DO storage (`storage`, DONE_RECORD_HASHES_KEY): before archiving a
 * record, its CURRENT content is hashed and compared against the hash stored
 * for that task. An unchanged hash means this exact content already landed
 * somewhere -- skipped entirely, no write, no comment, no hash update. A
 * missing or DIFFERENT hash means this is new, or a genuine rewrite of the
 * SAME task (e.g. a corrected `learnings`) -- archived/commented as before,
 * and only THEN is the stored hash updated to match, so a record that
 * reached neither the ops repo nor the board stays eligible for a retry on
 * the very next call, same as every other failure branch below already is.
 */
export async function archiveDoneRecords(
  deps: DoneRecordArchiveDeps, storage: DoneRecordHashStorage, studio: string, resolveOpsRepo: ResolveMemoryRepo,
): Promise<ArchiveResult> {
  const result: ArchiveResult = { archived: 0, commented: 0, failed: 0 };
  const ports = deps.doneRecords;
  if (!ports) return result;
  const res = await deps.exec(doneRecordsListCmd());
  const records: { task: number; body: string }[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = /^([0-9]+)\t([A-Za-z0-9+/=]*)$/.exec(line.trim());
    if (!m) continue;
    const bytes = Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0));
    records.push({ task: Number(m[1]), body: new TextDecoder().decode(bytes) });
  }
  if (records.length === 0) return result;

  const hashes: Record<string, string> = { ...(await storage.get(DONE_RECORD_HASHES_KEY)) };
  const workRepo = await ports.workRepoSlug();
  const opsRepo = await resolveOpsRepo();
  for (const { task, body } of records) {
    const key = String(task);
    const hash = await sha256Hex(body);
    // #367 round 2: already archived, unchanged since -- the OTHER call
    // site's own listing found nothing new here either. No write, no
    // comment, and the local file stays exactly where it is.
    if (hashes[key] === hash) continue;
    let landed = false;
    if (opsRepo !== null) {
      const path = `done/${workRepo}/${task}.json`;
      try {
        await ports.putOpsFile(opsRepo, path, body, `fleet: completion record ${workRepo}#${task} (${studio})`);
        result.archived++;
        landed = true;
      } catch (err) {
        // #363 round 2: never lose it -- the board comment is the fallback.
        console.error(`studio ${studio}: completion record for task ${task} not written to ${opsRepo}:${path}, falling back to a board comment`, err);
      }
    }
    if (!landed) {
      try {
        await ports.commentOnTask(workRepo, task, doneRecordComment(studio, body, opsRepo === null ? "unset" : "failed"));
        result.commented++;
        landed = true;
      } catch (err) {
        result.failed++;
        console.error(`studio ${studio}: completion record for task ${task} reached neither the ops repo nor the board, continuing`, err);
      }
    }
    if (landed) {
      hashes[key] = hash;
      // #367 round 3 (review HOLD fix, item 3): written the INSTANT this one
      // record is confirmed archived, not batched until the whole loop
      // finishes -- a container that dies between record 3 and record 4 of a
      // 5-record pass used to lose ALL FIVE records' hash updates even though
      // 1-3 had already landed, making them re-post needlessly on the very
      // next call. Per-record writes narrow that to exactly the records that
      // never got a chance to write their own hash; also closes the same
      // window for two archive calls that somehow overlap (see #367 round 3
      // item 2's own timeout note on runShipTickWithObservation) -- each
      // record's hash is durable the instant IT lands, never held in memory
      // for a batch write at the end.
      await storage.put(DONE_RECORD_HASHES_KEY, hashes);
    }
  }
  return result;
}

/**
 * #363: the DO's DoneRecordPorts.putOpsFile. Create-or-replace (a later
 * teardown may carry a newer version of the same record), ops-scoped,
 * contents:write -- same mint as memoryDeps().commitFile. `mint` injectable
 * so a test can pin the permissions asked for.
 */
export function doneRecordPutter(
  env: Env, mint: typeof mintRepoToken = mintRepoToken,
): (repo: string, path: string, content: string, message: string) => Promise<void> {
  return async (repo, path, content, message) => {
    await upsertRepoFile(await mint(env, repo, { permissions: { contents: "write" } }), repo, path, content, message);
  };
}

/** GitHub refuses a comment body of 65536 characters or more; the record is
 *  cut well below that so the wrapper always fits (#363). */
export const DONE_RECORD_COMMENT_MAX_CHARS = 60_000;

/**
 * The board comment a record becomes (#361): FLEET_OPS_REPO unset, or the ops
 * write failed. First line is the waker's exclusion marker (comment-wake.ts).
 * The board is public by default, so the record is redacted (redactSecrets)
 * and capped, saying so when cut.
 */
export function doneRecordComment(studio: string, body: string, why: "unset" | "failed" = "unset"): string {
  let text = redactSecrets(body).trimEnd();
  let cut = "";
  if (text.length > DONE_RECORD_COMMENT_MAX_CHARS) {
    cut = `\n\n(record truncated: first ${DONE_RECORD_COMMENT_MAX_CHARS} of ${text.length} characters)`;
    text = text.slice(0, DONE_RECORD_COMMENT_MAX_CHARS);
  }
  const reason = why === "unset"
    ? "FLEET_OPS_REPO is unset, so it is kept here, not in a repo"
    : "the ops-repo write failed, so it is kept here";
  return (
    `${DONE_RECORD_COMMENT_MARKER}\nCompletion record from studio \`${studio}\` (${reason}):\n\n` +
    "```json\n" + text + "\n```" + cut
  );
}

/**
 * Recycle's own composition.
 * Sync -> Rescue-push -> destroy -> AWAIT READY -> provision -> CHECK ->
 * (reprovision once if the container says it is bare, check again) ->
 * return, or record degraded and throw.
 *
 * Rescue-push (Task 3, above) sits between sync and destroy, never after:
 * destroy is the one call in this whole feature that actually removes the
 * running instance (see StudioDO.recycle's own doc comment, further below,
 * for the full case), so anything meant to save what is still on disk must
 * run while it is still reachable. Same best-effort posture as sync just
 * above — caught, logged, never allowed to block the destroy that follows —
 * and for the same reason: losing the LAST few minutes of session/burn
 * bookkeeping is one thing, but refusing to tear down a container over it
 * would leave the operator unable to recover the studio at all. (Task 4:
 * learning-harvest lands in this same pre-destroy slot, beside this call —
 * same reasoning, same shape.)
 *
 * The check/retry tail (2026-08-25): awaitReady alone did not hold. A live
 * recycle still returned `state: running, error: null` over a fresh
 * container with an empty /workspace and no claude, and a plain re-provision
 * on that same container fixed it. `recycleVerdict` (below) is what makes
 * this function's success MEASURED — read back out of the container —
 * instead of inferred from two exec exit codes; the single retry is the
 * operator's own manual recovery for that state, encoded.
 *
 * Three outcomes, not two (second round, same day, after the first version
 * of the check 500'd a healthy studio): the container saying it is BARE is a
 * loud failure; the check failing to reach a verdict at all is INCONCLUSIVE,
 * retried, and — if it stays inconclusive — reported as success carrying an
 * explicit "NOT verified" note. See recycleVerdict for the tradeoff that
 * ruling makes and why.
 *
 * The awaitReady step (second review pass, 2026-08-20): a real
 * `fleet recycle` run exposed that destroy() -> provision() alone RACES.
 * destroy() resolves once the kill is issued, not once the DO's own
 * bookkeeping has caught up to it — see sbAwaitReady's doc comment
 * (sandbox-api.ts) for the exact mechanism, read from the pinned SDK's
 * compiled source. Without an explicit wait, provision()'s first exec can
 * run before any container is confirmed ready, its clone/credential-write/
 * bring-up work lands nowhere durable, and the platform's own later,
 * unrelated container start (triggered by something else entirely) is what
 * actually produces the fresh tmux session an operator sees — with NONE of
 * the Worker-driven provisioning that's supposed to go with it. The route
 * still reported "running, error: null": a recycle that half-worked looked
 * identical to one that fully worked. awaitReady exists to make that
 * impossible — provision() must never run until the container it will run
 * against is genuinely, confirmedly ready.
 *
 * Sync's failure posture is unchanged from before this fix (design ruling:
 * sync/restore failures never gate the operation they precede) — caught,
 * logged, recycle proceeds regardless. destroy() and awaitReady() are
 * different: EITHER failing means this function no longer knows whether a
 * usable container exists, so reprovisioning on top of that would risk
 * racing whatever the platform is still doing. Per the explicit requirement
 * this closes ("a recycle that half-worked must never look identical to one
 * that worked"): a combined try/catch around destroy+awaitReady builds a
 * DEGRADED status (scrubbed, prior fields preserved via `existing`),
 * records it — so `fleet ls`/status reflect the failure even if this one
 * HTTP call is the only thing anyone ever sees — and then THROWS, so the
 * caller (StudioDO.recycle, then routes.ts) can turn this into a non-200
 * instead of a silently-successful-looking response. `provision` is never
 * called on this path.
 *
 * `destroy`/`awaitReady`/`provision` are callbacks, not a *WithStorage pair
 * like restartWithSync's own provisionDeps/storage: all three are real
 * methods/adapters on the live DO (Sandbox.destroy(); sbAwaitReady(this);
 * StudioDO.provision(), itself do.ts's whole provisioning composition), and
 * none has a pure/storage-level equivalent this function could call instead
 * without re-implementing that composition a second time here.
 */
/**
 * How long a dead container gets to answer one trivial exec before recycle
 * stops trying to be polite about it.
 *
 * Why this exists (board #68, measured 2026-09-23): against an unresponsive
 * container each `sbExec` burns its own budget — sandbox-api.ts's
 * `instanceGetTimeoutMS: 30_000` and `portReadyTimeoutMS: 90_000` — and
 * recycleWithSync ran session sync, rescue-push AND learning harvest, each in
 * its own try/catch, BEFORE reaching destroy. Three steps at up to 90s apiece
 * is minutes of wall clock, and the platform killed the whole invocation:
 * `outcome=exceededWallTime` in the Worker tail, surfacing to the operator as
 * `500 internal error; reference = <id>`. The verb documented to
 * rescue-then-rebuild was the one verb that could not run when rescuing was
 * most needed, so a studio with a dead container was unreachable by every
 * verb the operator had.
 *
 * 8s is deliberately far below any single sbExec budget: the question here is
 * only "is anyone home", and a container that cannot answer `printf ok` in 8s
 * will not serve a tar of ~/.claude/projects either.
 */
export const CONTAINER_PROBE_MS = 8_000;

/**
 * One cheap round trip to the container. False means the pre-teardown work
 * CANNOT succeed, so attempting it is pure cost — rescue-push, session sync
 * and harvest all need the same channel this probe just failed on.
 *
 * Never throws: a probe that fails IS the answer.
 */
export async function containerAnswers(syncDeps: SessionSyncDeps): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = syncDeps.exec("printf ok");
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("container probe timed out")), CONTAINER_PROBE_MS);
    });
    const result = await Promise.race([probe, deadline]);
    return result.code === 0;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Issue #96. `lastSyncedAt` is when R2's `sessions/<id>/latest.tar.gz` — the
 * snapshot a recycle restores — was last written; null when none exists.
 * Only consulted when the probe fails.
 */
export interface RecycleGuard {
  discardUnsynced: boolean;
  /** undefined = age unknown (only the default guard, which never looked). */
  lastSyncedAt: () => Promise<Date | null | undefined>;
}

export async function recycleWithSync(
  syncDeps: SessionSyncDeps,
  storage: StudioStorage & SessionSyncStorage,
  idFallback: string,
  destroy: () => Promise<void>,
  awaitReady: () => Promise<void>,
  provision: (cfg: ProvisionConfig) => Promise<StudioStatus>,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  cfg: ProvisionConfig,
  resolveMemoryRepo: ResolveMemoryRepo,
  commitFile: CommitLearningFile,
  // Issue #96: omitted = refuse on a failed probe. The safe side is the
  // default, and it does not KNOW the snapshot's age: undefined, not null.
  guard: RecycleGuard = { discardUnsynced: false, lastSyncedAt: async () => undefined },
  // Review round 3 (issue #85 PR1), MUST-FIX 8(a): trailing optional param,
  // same "absence = today's behavior" shape provisionWithStorage/
  // restartWithStorage/restartWithSync already use for this — do.ts's real
  // recycle() always supplies it.
  observedStorage?: ObservedStorage,
  // Issue #152: recycle's OWN ctx (do.ts's StudioDO.recycle creates it once,
  // at recycle's own entry, via allowingStart) — see OpCtx's doc comment for
  // why recycle's internal `destroy()` above never causes this to read
  // `moved()`: that call is the SDK's own Sandbox.destroy (a raw container
  // kill), never destroy.ts's destroyWithSync, so it never bumps the epoch.
  // `moved()` here only ever answers true when a SEPARATE, EXTERNAL destroy
  // (a concurrent `fleet destroy` against this same studio) lands during
  // recycle's own window.
  ctx: OpCtx = NEVER_MOVED_CTX,
  // Board issue #213: same "absence = today's behavior" trailing-optional
  // shape as `guard`/`observedStorage`/`ctx` just above — every existing
  // caller in this test suite that does not pass one keeps recycleWithSync's
  // pre-#213 behavior unchanged. do.ts's real `recycle()` always supplies
  // `() => this.deliverTaskOnBringup(cfg, ctx)`, a closure rather than raw
  // board/wake ports, for the same reason `destroy`/`awaitReady`/`provision`
  // above are already closures: this function stays storage/session-sync
  // only and never reaches for `this.env` or a board API directly.
  deliverTask: () => Promise<void> = async () => {},
): Promise<StudioStatus> {
  // Review M2: a recorded-STOPPED studio has nothing to rescue — `fleet
  // destroy` already ran the rescue and the container filesystem is gone. The
  // probe would BOOT that stopped container (sbExec starts one), could miss
  // its 8s on a cold start, falsely refuse, and leave a keepAlive container
  // billing under a stopped row. Skip the probe, the guard and the rescue.
  const recordedStopped = (await storage.get(STATUS_KEY))?.state === "stopped";
  if (recordedStopped) {
    console.error(
      `studio ${idFallback}: recorded stopped — destroy already rescued it and its filesystem is gone; ` +
        "skipping the probe, the unsynced-work guard and rescue, straight to destroy + reprovision.",
    );
  }
  // Board #68: ask ONCE whether anyone is home before spending three
  // container round trips finding out the hard way. Everything in the
  // pre-teardown block below needs the very channel this probe tests, so a
  // failed probe makes all of it unwinnable — and attempting it anyway is
  // what blew the platform's wall-time budget and turned a recoverable
  // studio into `500 internal error`.
  const alive = recordedStopped ? false : await containerAnswers(syncDeps);
  if (!alive && !recordedStopped) {
    // Issue #96: this used to go straight on to destroy, and a coordinator
    // recycled wedged-but-alive leads 3 times believing it free. A failed
    // probe now REFUSES, naming the price, unless the caller explicitly chose
    // to pay it. The lookup failing is `undefined` (age unknown), never a
    // reason to proceed.
    const lastSyncedAt = await guard.lastSyncedAt().catch(() => undefined);
    if (!guard.discardUnsynced) {
      throw new Error(recycleRefusal(idFallback, CONTAINER_PROBE_MS, lastSyncedAt, syncDeps.now()));
    }
    console.error(
      `studio ${idFallback}: container did not answer a ${CONTAINER_PROBE_MS}ms probe — ` +
        "skipping session sync, rescue-push and learning harvest, going straight to " +
        "destroy + reprovision because the caller passed --discard-unsynced. " +
        recycleCostLine(lastSyncedAt, syncDeps.now()) + " Uncommitted work inside that container " +
        "cannot be rescued: the channel rescue needs is the one that just failed.",
    );
  }
  if (alive) try {
    // Issue #228 item 5 (documenting, not changing, an existing interaction):
    // see destroy.ts's identical comment on its own pre-destroy syncSessionTick
    // call — an override armed via `fleet clear-session-guard` right before a
    // `fleet recycle` gets consumed by THIS pre-destroy sync, force-uploading
    // the studio's last session (old `latest` preserved under its own
    // `superseded/` key first). Almost certainly the intended behavior — a
    // recycle's own final sync before teardown IS the "next real sync" the
    // override exists to let through — documented here so it is not mistaken
    // for a bug later.
    const syncResult = await syncSessionTick(syncDeps, storage, idFallback);
    await recordSnapshotOnSuccess(observedStorage, syncResult, syncDeps.now().toISOString());
  } catch (err) {
    console.error(`studio ${idFallback}: pre-recycle session sync failed, continuing`, err);
  } finally {
    // Issue #228 item 1: see clearConsumedForceStamp's own doc comment above
    // — runs even when the tick consumed the override and then threw. `alive`
    // is already guaranteed true here: this `finally` only fires when the
    // `if (alive) try` just above actually entered the try block.
    await clearConsumedForceStamp(storage);
  }
  let rescueDiscarded: string | null = null;
  // PR #46 review: an aside dir that did not ship before teardown is named.
  let asideUnshipped: string | null = null;
  // Issue #39: every worktree's outcome, for the row this recycle returns.
  let rescueReport: string[] | null = null;
  // Issue #16: appended to every row this recycle writes after rescue.
  const withDiscardNote = (error: string | null): string | null =>
    {
      // No note: the row's error exactly as it was (undefined stays undefined).
      const notes = [rescueDiscarded, asideUnshipped].filter((n): n is string => n !== null);
      return notes.length === 0 ? error : [error, ...notes].filter((p): p is string => !!p).join("; ");
    };
  // Issue #37: fresh-session aside dirs ship on their own; last chance.
  if (alive) try {
    asideUnshipped = asideNotShippedNote((await shipAsideSessions(syncDeps, idFallback)).failed);
  } catch (err) {
    console.error(`studio ${idFallback}: pre-destroy aside session ship failed, continuing`, err);
    asideUnshipped = asideNotShippedNote([{ dir: "(listing)", reason: err instanceof Error ? err.message : String(err) }]);
  }
  if (alive) try {
    const rescue = await rescuePush(syncDeps, cfg.repo, idFallback);
    if (rescue.worktrees) rescueReport = formatRescueReport(rescue.worktrees);
    if (rescue.pushed) {
      for (const p of rescue.pushes ?? [{ branch: rescue.branch!, files: rescue.files, kind: rescue.kind! }]) {
        // Issue #266: the label now matches what was actually counted —
        // never "file(s)" for a clean-but-unpushed-commits rescue.
        console.error(`studio ${idFallback}: rescue-push saved ${p.files} ${p.kind === "commits" ? "commit(s)" : "file(s)"} to ${p.branch} before destroy`);
      }
    }
  } catch (err) {
    // Issue #16: a CONFIRMED rescue failure refuses, exactly like destroy.ts.
    // Issue #62: so does an UNCONFIRMED one (a killed exec, the shell dying,
    // the deadline): "cannot tell" is unknown state, not "nothing lost".
    // `--discard-unsynced` is the stated way past either.
    if (err instanceof RescuePushFailedError && err.worktrees.length > 0) rescueReport = formatRescueReport(err.worktrees);
    const reason = redactSecrets(err instanceof Error ? err.message : String(err));
    if (!guard.discardUnsynced) {
      if (err instanceof RescuePushFailedError) {
        const perWorktree = rescueReport ? ` Worktrees: ${rescueReport.join("; ")}.` : "";
        throw new Error(recycleRescueFailedRefusal(idFallback, reason + perWorktree));
      }
      const lastSyncedAt = await guard.lastSyncedAt().catch(() => undefined);
      throw new Error(recycleRescueUnconfirmedRefusal(idFallback, reason, lastSyncedAt, syncDeps.now()));
    }
    console.error(`studio ${idFallback}: pre-destroy rescue-push failed, continuing (--discard-unsynced)`, err);
    rescueDiscarded = err instanceof RescuePushFailedError
      ? `recycled with a confirmed rescue-push failure: ${reason} (--discard-unsynced)`
      : `recycled with an unconfirmed rescue-push (${reason}) (--discard-unsynced)`;
  }
  if (alive) try {
    // #367 round 2: `storage` (StudioStorage & SessionSyncStorage) does not
    // itself declare DONE_RECORD_HASHES_KEY -- narrowing every existing
    // caller's storage type just for this one extra key would ripple into
    // every OTHER test in this file that builds a fake StudioStorage &
    // SessionSyncStorage, for a key none of them care about. The real
    // `this.ctx.storage` already supports arbitrary keys structurally (the
    // same "no cast" property every other narrow storage port in this file
    // relies on) -- this cast only tells TypeScript that, it changes nothing
    // at runtime.
    await archiveDoneRecords(syncDeps, storage as unknown as DoneRecordHashStorage, idFallback, resolveMemoryRepo);
  } catch (err) {
    console.error(`studio ${idFallback}: pre-destroy completion-record archive failed, continuing`, err);
  }
  let learningsLost = 0;
  if (alive) try {
    const harvest = await harvestLearnings(syncDeps, cfg.repo, idFallback, resolveMemoryRepo, commitFile, await deliveredTaskIn(storage));
    learningsLost = harvest.lost ?? 0;
    if (harvest.harvested) {
      console.error(`studio ${idFallback}: harvested ${harvest.count} learning(s) to fleet/memory/${idFallback}/ before destroy`);
    }
  } catch (err) {
    console.error(`studio ${idFallback}: pre-destroy learning harvest failed, continuing`, err);
  }
  // Review round 3 (issue #85 PR1), MUST-FIX 5: held across the WHOLE
  // destroy -> reprovision window, cleared in a `finally` so it survives
  // every throw below — same op-lock coverage provision/restart already
  // have (provision.ts's OPERATION_KEY doc comment), both for the heal's
  // "already running" guard and the ship tick's failure-counting skip
  // (do.ts's runShipTickWithObservation).
  await storage.put(OPERATION_KEY, { op: "recycle", since: syncDeps.now().toISOString() });
  try {
    try {
      await destroy();
      await awaitReady();
      // Issue #240 (P-E21, a #174 follow-up): awaitReady() can also resolve
      // SUCCESSFULLY while an EXTERNAL destroy has, by then, already fully
      // landed — the SDK's own retry (#129 F2, destroy.ts) can bring the
      // container back up and let this call complete normally even though
      // the destroy's refusal window (the catch branch right below) was
      // never entered. Before this check, execution fell straight through to
      // `provision(cfg)` below with no guard at all — the NEXT ctx.moved()
      // check (already existing, right after `provision(cfg)` returns) was
      // too late: by the time it ran, provision(cfg) had already exec'd into
      // a container the destroy just finished tearing down. Same return
      // shape as the catch branch's own moved() guard just below.
      if (await ctx.moved()) {
        console.error(`studio ${idFallback}: destroy landed mid-recycle (during its own teardown/readiness step), aborting`);
        return (await storage.get(STATUS_KEY)) ?? freshStatus(idFallback);
      }
    } catch (err) {
      // Round 3 review, fix 2 (verifier sim V6e): an EXTERNAL destroy that
      // bumped the epoch during this exact window (recycle's own internal
      // `destroy()` never bumps it itself) can make `awaitReady()` above get
      // REFUSED by the very same #123 start gate every other start goes
      // through — the row now reads `stopped`, and recycle's own ctx no
      // longer matches the live epoch. That refusal lands right here, and
      // before this fix, this catch had no way to tell it apart from a
      // genuine destroy/awaitReady failure: it unconditionally overwrote the
      // row destroy had JUST correctly left as `stopped` with `degraded`, and
      // published that to D1. `ctx.moved()` is what tells them apart: no
      // write at all, just the row exactly as destroy left it.
      if (await ctx.moved()) {
        console.error(`studio ${idFallback}: destroy landed mid-recycle (during its own teardown/readiness step), aborting`);
        return (await storage.get(STATUS_KEY)) ?? freshStatus(idFallback);
      }
      // Scrubbed at the point the raw message is first held — same rule
      // runProvision's own catch follows (see that function's doc comment for
      // why: a container-startup error string is a real, reachable path for a
      // secret to appear, not just a hypothetical one).
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      const failure = withDiscardNote(`recycle failed before reprovisioning could start: ${message}`)!;
      const existing = (await storage.get(STATUS_KEY)) ?? null;
      const status: StudioStatus = { ...(existing ?? freshStatus(idFallback)), state: "degraded", error: failure };
      await storage.put(STATUS_KEY, status);
      await recordStudioFn(status);
      throw new Error(failure);
    }

    // Provision, then MEASURE. See recycleVerdict below for why a returned
    // "running" is not, on this path, evidence that anything was provisioned.
    let status = await provision(cfg);
    // Issue #152: an EXTERNAL destroy (a concurrent `fleet destroy` against
    // this same studio) landed and fully completed somewhere inside that
    // provision attempt. The row it left behind (`stopped`) is the truth; no
    // verdict exec (which would itself start a container the destroy just
    // stopped), no second provision attempt, no further write of any kind —
    // just hand back the row exactly as destroy left it.
    if (await ctx.moved()) {
      console.error(`studio ${idFallback}: destroy landed mid-recycle, aborting`);
      return (await storage.get(STATUS_KEY)) ?? status;
    }
    // Read AFTER provisioning, never before: provision() is what resolves the
    // blueprint and writes ROLE_ENV_KEY, so a studio whose roster or skill list
    // changed since the last boot is checked against what it was just brought up
    // with, not against a stale copy.
    let verdict = await recycleVerdict(syncDeps, cfg, status, await storedHarness(storage));
    // Round 3 review, fix 1 (verifier sim V6d): recycleVerdict's own
    // readiness check is itself a container exec (checkProvisionedWithRetry)
    // — the SAME shape of exec every other guarded readiness check in this
    // file races a destroy against. A destroy that lands and fully completes
    // WHILE that exec is in flight must be caught here, before the tail
    // writes below ever run, exactly like every other post-exec guard in
    // this codebase.
    if (await ctx.moved()) {
      console.error(`studio ${idFallback}: destroy landed mid-recycle, aborting`);
      return (await storage.get(STATUS_KEY)) ?? status;
    }
    if (verdict.kind === "bare") {
      // One retry, on purpose: this is the operator's own proven manual
      // recovery (a plain `fleet provision <id>` immediately after a
      // half-worked recycle turned the same bare container into a fully
      // provisioned studio — measured 2026-08-25) encoded so nobody has to
      // notice and run it by hand. It needs no fresh awaitReady: by now a
      // container demonstrably exists (the check just talked to one), and
      // provision's own first exec starts one through the SDK's containerFetch
      // if it does not — exactly what the manual re-provision relied on.
      //
      // Only "bare" reprovisions. An INCONCLUSIVE check is not evidence of
      // anything about the studio, so it must never trigger a destroy-adjacent
      // repair — it is retried as a check (inside recycleVerdict), never
      // escalated into another provisioning pass.
      console.error(`studio ${idFallback}: recycle left an unprovisioned studio (${verdict.reason}); reprovisioning once`);
      status = await provision(cfg);
      // Issue #152: same guard as above, after the retry attempt too.
      if (await ctx.moved()) {
        console.error(`studio ${idFallback}: destroy landed mid-recycle, aborting`);
        return (await storage.get(STATUS_KEY)) ?? status;
      }
      verdict = await recycleVerdict(syncDeps, cfg, status, await storedHarness(storage));
      // Round 3 review, fix 1: the same post-readiness-exec guard as above,
      // for the retry's own recycleVerdict call.
      if (await ctx.moved()) {
        console.error(`studio ${idFallback}: destroy landed mid-recycle, aborting`);
        return (await storage.get(STATUS_KEY)) ?? status;
      }
    }
    // Issue #37: the verdict just measured is the verdict this returns, on
    // every one of the three paths below. Before this, recycle ran the check and
    // then answered with the row provisioning had written — whose `readiness`
    // is whatever the last syncSession tick stamped, up to SYNC_SESSION_SECONDS
    // (300s) earlier. A recycle that demonstrably healed a studio could hand
    // back "bare: no git checkout", and a reviewing agent read exactly that and
    // reported "recycle silently succeeds, zero effect" — false, and expensive.
    // The work was always done here; only the reporting was missing.
    const readiness = readinessOf(verdict, syncDeps.now().toISOString());

    if (verdict.kind === "provisioned") {
      // Persisted as well as returned, so the `fleet ls` an operator runs right
      // after a recycle reads the same fresh verdict the recycle just printed,
      // instead of the pre-recycle row until the next tick.
      const fresh: StudioStatus = {
        ...status, readiness,
        // #346: learnings dropped because memory is off show on the row --
        // never over a real error.
        ...(learningsLost > 0 && status.error == null ? { error: learningsLostNote("recycled", learningsLost) } : {}),
      };
      // Issue #16: a discarded confirmed rescue failure is always on the row.
      fresh.error = withDiscardNote(fresh.error);
      if (rescueReport) fresh.rescueReport = rescueReport;
      await storage.put(STATUS_KEY, fresh);
      await recordStudioFn(fresh);
      // Board issue #213: bring-up verified (never before this point) — see
      // deliverTask's own doc comment above for why this is a closure rather
      // than raw board/wake ports. Defensively try/catch'd here too, in case
      // a caller-supplied `deliverTask` is not do.ts's own already-total
      // `deliverTaskOnBringup` wrapper.
      try {
        await deliverTask();
      } catch (err) {
        console.error(`studio ${idFallback}: post-recycle task delivery failed`, err);
      }
      return fresh;
    }

    if (verdict.kind === "inconclusive") {
      // DELIBERATE TRADEOFF (operator ruling, 2026-08-25, after the first
      // version of this check 500'd a demonstrably healthy studio): when the
      // check itself cannot reach a verdict, report SUCCESS and say so, rather
      // than fail. Rationale: a 500 on a working studio is worse than an
      // unverified success, because it trains the operator to ignore the
      // error — and once ignored, the genuine bare-container failure this
      // whole check exists to catch stops being read too. The cost of this
      // choice is real and accepted: a recycle that truly left a bare
      // container, on a container that ALSO cannot answer an exec, returns
      // 200. It is not silent — `state` stays honest and `error` carries the
      // note, so `fleet ls` shows "unverified" in the same column a real
      // failure would appear in, and the studio is one `fleet status` away
      // from the truth.
      const note = redactSecrets(`provisioned, but NOT verified: ${verdict.reason}`);
      const unverified: StudioStatus = {
        ...status, error: withDiscardNote(note), readiness, ...(rescueReport ? { rescueReport } : {}),
      };
      await storage.put(STATUS_KEY, unverified);
      await recordStudioFn(unverified);
      console.error(`studio ${idFallback}: recycle could not verify the studio (${verdict.reason}); reporting unverified success`);
      return unverified;
    }

    const message = withDiscardNote(redactSecrets(`recycle could not produce a provisioned studio: ${verdict.reason}`))!;
    const degraded: StudioStatus = { ...status, state: "degraded", error: message, readiness };
    await storage.put(STATUS_KEY, degraded);
    await recordStudioFn(degraded);
    throw new Error(message);
  } finally {
    await storage.put(OPERATION_KEY, null);
  }
}

/**
 * Three outcomes, never two — the distinction the first version of this fix
 * got wrong and a live 500 on a healthy studio proved (see PROVISIONED_OK's
 * doc comment in provision.ts for the `exit`-kills-the-session mechanism):
 *
 *   provisioned  — the container itself said so (PROVISIONED_OK on stdout).
 *   bare         — the container itself said what is missing, or
 *                  provisioning already reported it failed.
 *   inconclusive — the check did not reach a verdict: the exec threw, or it
 *                  returned nothing recognisable. This is a statement about
 *                  the CHECK, not about the studio, and must never be read
 *                  as evidence that the studio is broken.
 *
 * Inconclusive is RETRIED here (CHECK_ATTEMPTS), before any conclusion is
 * drawn, since the realistic causes — a session shell that just died, a
 * container mid-restart — are exactly the kind that a second attempt clears.
 * A "bare" or "provisioned" verdict is returned immediately: the container
 * answered, and asking it again would only add latency to an answer it has
 * already given.
 *
 * The bug this whole function exists for (2026-08-25, measured on a live
 * studio): `fleet recycle` returned `state: running, error: null` over a
 * fresh container whose /workspace was EMPTY, with claude not running — and
 * a plain `fleet provision` on that same container immediately afterwards
 * produced a fully provisioned studio. Nothing in the recycle path could
 * have caught that, because "running" is inferred entirely from two exec
 * exit codes (the guarded clone's and bring-up's), and an exec that lands in
 * a container which does not survive the call still returns 0. destroy() is
 * exactly where the container an exec reaches stops being guaranteed to be
 * the container that survives: it resolves before the DO's own
 * `container.running` bookkeeping catches up to the kill, and the pinned
 * SDK's `startContainerIfNotRunning` RETURNS EARLY while that flag is still
 * true (`if (this.container.running) return 0`) — so even sbAwaitReady can
 * hand back "ready" without having started anything fresh. Whether that is
 * the mechanism the live failure took was not proven (see
 * .superpowers/sdd/recycle-fix2-report.md), which is the point of checking
 * the container instead of trusting any one theory of how it goes wrong:
 * this catches the whole failure class, including a container the platform
 * replaces AFTER provisioning lands in it.
 *
 * A non-"running" status is "bare" without any exec at all: provisioning
 * that degraded (clone failed, blueprint unreachable) already knows it
 * failed, and a recycle must not answer 200 for it — `provision`'s own
 * 200-with-degraded posture is not the loud failure this path requires.
 */
export const CHECK_ATTEMPTS = 3;

/**
 * Named for the QUESTION it answers, not for recycle — recycle is no longer
 * the only caller. `GET /studio/:id/provisioned` (routes.ts) returns this
 * shape verbatim as JSON, which is what lets `ff` gate an attach on the
 * container's own answer instead of inferring one from the registry.
 *
 * `bare` means NOT provisioned, and `reason` names what is missing (no
 * checkout, or claude not running in the tmux window). The name is kept from
 * the incident that produced this check — a fresh, empty container reporting
 * `state: running` — because that is exactly what it detects.
 */
export type ProvisionedVerdict =
  | { kind: "provisioned" }
  | { kind: "bare"; reason: string }
  | { kind: "inconclusive"; reason: string };

/**
 * One live verdict, stamped with WHEN it was taken — the single mapping every
 * writer of `StudioStatus.readiness` goes through (the syncSession tick, the
 * `provision` and `recycle` recovery verbs, the on-demand check). Duplicated
 * in three places before issue #37 added the second and third caller.
 *
 * `checkedAt` is stamped on EVERY outcome, inconclusive included: a check that
 * could not decide still records when it tried, so a stale "don't know" is
 * visibly stale rather than reading as fresh.
 *
 * `reason` carries container stdout/stderr verbatim, so it is scrubbed HERE,
 * at the point the raw text is first held onto — the same rule runProvision's
 * own catch follows. registry.ts's cleanReadiness scrubs again at the D1
 * write boundary (redactSecrets is idempotent); this one is what keeps an
 * unscrubbed reason out of the provision/recycle/check RESPONSE, which is
 * returned straight from DO storage and never passes through that boundary.
 *
 * WHAT THIS VERDICT DOES AND DOES NOT MEAN: `provisioned` asserts the clone is
 * present, the harness files are in place, and `pane_current_command` in
 * `tmux studio:claude` reads `claude`. That last marker answers ALIVE-or-DEAD,
 * NOT WORKING-or-STOPPED — measured: it reads `claude` in three different
 * states (lead mid-turn, lead stopped waiting on background subagents, lead
 * dead at a shell prompt inside the claude process's own window). Never read a
 * `provisioned` verdict as evidence a studio is spending money productively.
 */
export function readinessOf(verdict: ProvisionedVerdict, checkedAt: string): StudioReadiness {
  return verdict.kind === "provisioned"
    ? { kind: "provisioned", checkedAt }
    : { kind: verdict.kind, reason: redactSecrets(verdict.reason), checkedAt };
}

/**
 * The check, with its inconclusive-retry policy, as ONE reusable unit.
 *
 * Read-only by construction: it execs provision.ts's provisionedCheckCmd and
 * nothing else — no destroy, no provision, no storage write. That is what
 * makes it safe to expose on a GET route, and it is the SAME call recycle
 * makes, so the route and the recycle gate can never drift into disagreeing
 * about what "provisioned" means.
 *
 * Inconclusive is retried (CHECK_ATTEMPTS) before it is reported, since its
 * realistic causes — a session shell that just died, a container mid-restart
 * — are exactly the kind a second attempt clears. The retry is cheap: an
 * inconclusive attempt is one that threw or answered nothing, both fast. The
 * slow case (provisionedCheckCmd's own up-to-PROVISIONED_CHECK_TRIES wait for
 * claude to appear) ends in a `bare` or `provisioned` verdict, which is
 * returned immediately without a second attempt.
 */
export async function checkProvisionedWithRetry(
  syncDeps: SessionSyncDeps, repo: string, harness?: string | null,
): Promise<ProvisionedVerdict> {
  let last: ProvisionedVerdict = { kind: "inconclusive", reason: "check never ran" };
  for (let attempt = 0; attempt < CHECK_ATTEMPTS; attempt++) {
    last = await runProvisionedCheck(syncDeps, repo, harness);
    if (last.kind !== "inconclusive") return last;
  }
  return last;
}

// Issue #123: moved to provision.ts, beside DESTROYING_KEY, so failover.ts's
// write guard can read it without importing this file.
export { destroyingMarkerFresh };

/**
 * The state the wake, inspect and /provisioned gates read: STATUS_KEY's own,
 * from THIS DO's storage (never the D1 mirror), or DESTROY_IN_FLIGHT while a
 * destroy is in flight — each gate refuses that in its own words. `null`
 * means no status was ever recorded — this Durable Object was minted by the
 * `idFromName` call that is asking. (Scheduled ticks and the heal read the
 * marker themselves: runScheduledTick, healBareContainer.)
 */
export async function gatedStateIn(storage: StudioStorage, now: () => Date): Promise<string | null> {
  if (destroyingMarkerFresh(await storage.get(DESTROYING_KEY), now())) return DESTROY_IN_FLIGHT;
  return (await storage.get(STATUS_KEY))?.state ?? null;
}

/** Issue #123: the `code` a start refusal carries. The SDK's
 *  handleErrorResponse builds its thrown error from this JSON body. */
export const START_REFUSED_CODE = "STUDIO_STOPPED";

/**
 * Issue #123: may this studio's container START now? Null = yes, else the
 * refusal. Consulted only when no container is running (StudioDO.refuseStart).
 *
 * `explicit` = a provision / restart / recycle is in progress in this isolate
 * (StudioDO.allowingStart): their first start runs before OPERATION_KEY is
 * taken. OPERATION_KEY itself admits nothing: it is written only inside that
 * allowance, so a lock seen without it is an orphan (isolate reset mid-op)
 * and would boot a stopped studio for up to OPERATION_STALE_MS. A fresh
 * DESTROYING_KEY refuses (#110's late tick exec). Otherwise only a studio the
 * row says should be up — running, degraded, provisioning — may start: a
 * running studio whose container died is still restarted and healed.
 */
export async function startRefusal(
  storage: StudioStorage, id: string, now: Date, explicit: boolean,
): Promise<string | null> {
  if (explicit) return null;
  if (destroyingMarkerFresh(await storage.get(DESTROYING_KEY), now)) {
    return `studio ${id} is being destroyed — it will not start a container`;
  }
  const state = (await storage.get(STATUS_KEY))?.state;
  if (state === "running" || state === "degraded" || state === "provisioning") return null;
  return `studio ${id} is stopped — \`ff ${id}\` to start it`;
}

/** Issue #123: what the start overrides throw — typed like the 409 body. */
export class StartRefusedError extends Error {
  readonly code = START_REFUSED_CODE;
  constructor(message: string) {
    super(message);
    this.name = "StartRefusedError";
  }
}

/**
 * 409, never 503: the SDK's HTTP transport retries only 503 (BaseTransport
 * .fetch, shouldRetry: status === 503), for up to its whole retry budget.
 */
export function startRefusedResponse(message: string): Response {
  return Response.json(
    { code: START_REFUSED_CODE, message, context: {}, httpStatus: 409, timestamp: new Date().toISOString() },
    { status: 409 },
  );
}

/** Issue #127: the first sighting failover recorded (its own key, off
 *  StudioStorage's overloads — see failover.ts's SightingStorage). */
export async function limitSightingIn(storage: StudioStorage): Promise<LimitSighting | null> {
  const s = storage as unknown as { get(key: typeof LIMIT_SIGHTING_KEY): Promise<LimitSighting | undefined> };
  return (await s.get(LIMIT_SIGHTING_KEY)) ?? null;
}

/** Issue #106: the limit block the last account switch fired on, for the wake gate. */
export async function switchedBlockIn(storage: StudioStorage): Promise<string | null> {
  return (await storage.get(STATUS_KEY))?.failoverBlock ?? null;
}

/**
 * Board issue #213: the dedup marker `deliverAssignedTaskOnBringup` (below)
 * reads before waking — the number of the task it last DELIVERED to this
 * studio, or null if it has never delivered one. Storing only the last
 * number is enough: `resolveLatestAssignedBrief`'s own "newest wins"
 * resolution means a studio has exactly one current live task at a time.
 *
 * Its own key, off StudioStorage's overloads — same reason LIMIT_SIGHTING_KEY
 * above keeps its own rather than widening the shared interface for a single
 * reader/writer pair nothing else needs.
 */
export const DELIVERED_TASK_KEY = "deliveredTask";

interface DeliveredTaskStorage {
  get(key: typeof DELIVERED_TASK_KEY): Promise<number | undefined>;
  put(key: typeof DELIVERED_TASK_KEY, value: number): Promise<void>;
}

/** The task number last delivered on this studio's bring-up, or null if none has been. */
export async function deliveredTaskIn(storage: StudioStorage): Promise<number | null> {
  const s = storage as unknown as DeliveredTaskStorage;
  return (await s.get(DELIVERED_TASK_KEY)) ?? null;
}

/** Marks a task delivered. Called ONLY after a wake reports `ok` (see
 *  `deliverAssignedTaskOnBringup`) — never on a refusal, so a refusal leaves
 *  nothing behind and the very next bring-up retries for free. */
export async function recordDeliveredTask(storage: StudioStorage, taskNumber: number): Promise<void> {
  const s = storage as unknown as DeliveredTaskStorage;
  await s.put(DELIVERED_TASK_KEY, taskNumber);
}

/**
 * Issue #100 F1: `StudioDO.wakeStudio`'s whole body, extracted — the class
 * cannot be constructed under vitest-pool-workers (this file's header), so
 * the real behaviour lives here, exactly as syncSessionCycle's does, and the
 * method stays a thin forward (source-pinned in test/studio.wake-gate.test.ts).
 *
 * Every wake resets the 20 minutes (design spec): a busy fleet fires zero
 * sweeps. Only on a landed wake — re-arming on a wake that never reached the
 * TUI would push the crash detector 20 minutes further out precisely when the
 * container is the thing that is broken.
 */
export async function wakeStudioWith(
  storage: StudioStorage, exec: WakeExec, isMaestro: boolean, armSweep: () => Promise<void>,
  prompt: string, now: () => Date = () => new Date(), studioId?: string,
): Promise<WakeOutcome> {
  const outcome = await runGatedWake({ recordedState: () => gatedStateIn(storage, now), switchedBlock: () => switchedBlockIn(storage), limitSighting: () => limitSightingIn(storage), exec, now, studioId }, prompt);
  if (outcome.ok && isMaestro) await armSweep();
  return outcome;
}

/**
 * Issue #99 review: the sweep's wake, behind the FULL gate — stopped, claude
 * in the pane, no limit modal. The sweep typed through the raw `runWake`,
 * so a bash pane got a shell command line and a usage-limit modal got a
 * digit. No armSweep here: the sweep re-arms itself, and a refused sweep
 * wake is simply not landed.
 */
export async function sweepWake(
  storage: StudioStorage, exec: WakeExec, studioId: string, prompt: string, now: () => Date = () => new Date(),
): Promise<WakeOutcome> {
  return runGatedWake({ recordedState: () => gatedStateIn(storage, now), switchedBlock: () => switchedBlockIn(storage), limitSighting: () => limitSightingIn(storage), exec, now, studioId }, prompt);
}

/**
 * Board issue #213: the bring-up half of task delivery.
 *
 * `resolveBringupEnv` (provision.ts) already composes a studio's currently
 * assigned open task into the FRESH bring-up environment's initial prompt
 * (via `deps.resolveAssignedBrief`, wired from `resolveLatestAssignedBrief`)
 * — but that only reaches the lead when claude starts a genuinely NEW
 * conversation. A bring-up that instead RESUMES an existing tmux session
 * (this codebase's own worktree-session-adopt machinery, for a studio that
 * was previously running and only just stopped) never reads a system prompt
 * at all: the resumed pane just continues its old conversation. Measured
 * live: a stopped studio with a task assigned to it came back healthy on a
 * plain `fleet provision` and never heard about the task — the lead just
 * resumed its last summary. The only workaround measured was cancel-and-
 * refile under a new task number, which happens to trigger a normal
 * fresh-assignment wake (`wakeOnAssign`, assign-wake.ts).
 *
 * This is the missing edge: a wake, typed the SAME one-line pointer format
 * (`assignDigest`) `wakeOnAssign` already types into a RUNNING studio's pane,
 * fired here instead for a studio that just came back UP. Called from all
 * three bring-up choke points (provision/restart/recycle — do.ts's own
 * `deliverTaskOnBringup` private helper wires this to each), each AFTER
 * their own "bring-up verified" check, never before: a task typed into a
 * pane that turned out bare/inconclusive would be a wake into nothing.
 *
 * Reuses `wakeStudioOnAssignment`'s existing gate stack (stopped, limit
 * modal, single-flight) via the injected `wake` thunk — this function itself
 * runs NO gate and never execs a container directly, exactly like
 * `wakeStudioWith`/`sweepWake` above delegate their own gating to
 * `runGatedWake` rather than reimplementing it.
 *
 * At-most-once per task id: `deliveredTaskIn` is the dedup marker, written
 * ONLY on a landed wake (`outcome.ok`). A refusal — stopped again mid-race, a
 * limit modal on screen, single-flight busy — persists nothing, so the very
 * next provision/restart/recycle naturally retries: no separate retry queue
 * needed, because each of the three choke points calls this again on its own
 * next run.
 *
 * DI shape mirrors `wakeStudioWith`'s own reasoning (this file's header): a
 * `boardLookup` thunk and a `wake` thunk, both injected rather than reaching
 * for `this.env`/`this.ctx` directly, is what makes this testable with a
 * fake StudioStorage and a fake wake — no DO construction (test/studio.
 * wake-gate.test.ts).
 *
 * Fix round on issue #213 (PR #229), rebased onto issue #174's own
 * `OpCtx`/`ctx.moved()` destroy-epoch guard (issue #152's race-safety
 * mechanism, do.ts's `allowingStart`): a destroy can land and fully complete
 * in the gap between `boardLookup` returning a task (dedup check passed) and
 * the `wake` call actually typing it into the pane — the exact same race
 * #174 already closes for every other bring-up write. `moved` is checked
 * AFTER the dedup check (a duplicate wake into a live pane is harmless; a
 * wake into a container destroy just tore down is not) and RIGHT BEFORE
 * `wake`, so it catches a destroy landing anywhere up to that point,
 * including during `boardLookup` itself. Defaults to "never moved" so every
 * existing caller in this test suite that does not pass one keeps this
 * function's pre-fix-round behavior unchanged, the same trailing-optional
 * shape `recycleWithSync`'s own `ctx`/`observedStorage` params use.
 */
export async function deliverAssignedTaskOnBringup(
  storage: StudioStorage,
  boardLookup: () => Promise<{ taskNumber: number; title: string } | null>,
  wake: (prompt: string) => Promise<WakeOutcome>,
  moved: () => Promise<boolean> = async () => false,
): Promise<void> {
  const task = await boardLookup();
  if (task === null) return;
  if ((await deliveredTaskIn(storage)) === task.taskNumber) return;
  if (await moved()) return;
  const outcome = await wake(assignDigest({ number: task.taskNumber, title: task.title }));
  if (outcome.ok) await recordDeliveredTask(storage, task.taskNumber);
}

/**
 * GET /studio/:id/provisioned, behind the stopped gate every other exec path
 * already has (issue #100): the check execs into the container, and an exec
 * STARTS a stopped one. Refused from storage alone, as `inconclusive` — a
 * statement about the check, which did not run, never about the studio.
 */
export async function checkProvisionedGated(
  storage: StudioStorage, syncDeps: SessionSyncDeps, repo: string,
): Promise<ProvisionedVerdict> {
  const state = await gatedStateIn(storage, syncDeps.now);
  if (state === null) {
    return { kind: "inconclusive", reason: "check not run: this studio was never provisioned — the check would create a container" };
  }
  if (state === "stopped") {
    return { kind: "inconclusive", reason: "check not run: this studio is stopped — the check execs into its container, which starts it" };
  }
  if (state === DESTROY_IN_FLIGHT) {
    return { kind: "inconclusive", reason: "check not run: a destroy is in flight — the check would start the container it is stopping" };
  }
  return checkProvisionedWithRetry(syncDeps, repo, await storedHarness(storage));
}

/**
 * The harness expectation for THIS studio, read from the same DO storage
 * `restartWithStorage` reads its bring-up env from. Storage, not a blueprint
 * refetch: the check must keep working when GitHub is unreachable, exactly
 * the reason ROLE_ENV_KEY exists at all (see its doc comment in provision.ts).
 *
 * A studio provisioned before this feature shipped has a stored StudioEnv
 * already carrying STUDIO_NAME/STUDIO_SKILLS/STUDIO_MEMBERS_B64 — the three
 * fields the expectation is built from — so it is checked as fully as a fresh
 * one, with no migration. A ROLE's stored env has no STUDIO_NAME and
 * `harnessExpectation` returns null for it, which is what keeps the check on
 * `websites--pilot` exactly what it was.
 */
async function storedHarness(storage: StudioStorage): Promise<string | null> {
  return harnessExpectation((await storage.get(ROLE_ENV_KEY)) ?? null);
}

async function recycleVerdict(
  syncDeps: SessionSyncDeps, cfg: ProvisionConfig, status: StudioStatus, harness: string | null,
): Promise<ProvisionedVerdict> {
  if (status.state !== "running") {
    return { kind: "bare", reason: `provisioning reported ${status.state}: ${status.error ?? "no error recorded"}` };
  }
  return checkProvisionedWithRetry(syncDeps, cfg.repo, harness);
}

/** One exec of provision.ts's provisionedCheckCmd, mapped to a verdict. The
 *  container speaks on stdout (PROVISIONED_OK, or the reason it is not
 *  provisioned); a throw or an unrecognisable answer is inconclusive, never
 *  a failure — see recycleVerdict's doc comment. */
async function runProvisionedCheck(
  syncDeps: SessionSyncDeps, repo: string, harness?: string | null,
): Promise<ProvisionedVerdict> {
  try {
    const res = await syncDeps.exec(provisionedCheckCmd(repo, harness));
    const out = res.stdout.trim();
    // UNKNOWN first: it is the container saying the CHECK broke, not the
    // studio. Reading it as "bare" would turn a broken check into a recycle
    // trigger — the exact inversion the three-verdict split exists to stop.
    if (out.includes(PROVISIONED_UNKNOWN)) return { kind: "inconclusive", reason: out };
    if (out.includes(PROVISIONED_OK)) return { kind: "provisioned" };
    // Issue #38: a BARE verdict is the one an operator has to act on, and
    // until now it said only WHAT was missing ("no git checkout at
    // /workspace/acme-os"), never WHERE bring-up stopped trying. The
    // bring-up log holds that, and reading its tail here is what puts the
    // failing step in front of the operator without a container shell — the
    // exact diagnostic that had to be reconstructed from file mtimes on
    // 2026-09-23. Paid ONLY on a bare verdict: a provisioned studio never
    // issues this exec at all.
    if (out.length > 0) return { kind: "bare", reason: await withBringupLogTail(syncDeps, out) };
    const stderr = res.stderr.trim();
    return {
      kind: "inconclusive",
      reason: `check produced no verdict (exit ${res.code}${stderr ? `: ${stderr.slice(0, 300)}` : ""})`,
    };
  } catch (err) {
    return { kind: "inconclusive", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Issue #38: append the tail of container/studio-bringup.sh's own log to a
 * bare verdict's reason, so the verdict names the STEP bring-up died on and
 * not only the artefact that is missing.
 *
 * TOTAL — never throws, never changes the verdict's kind. A container that
 * cannot answer this exec, or one carrying no log at all (predating this
 * feature, or hollow enough that bring-up never created the file), simply
 * gets the reason it already had. The tail is DIAGNOSTIC; the verdict is the
 * decision, and a diagnostic must never be able to alter a decision.
 *
 * Bounded twice over: `bringupLogTailCmd` asks for a fixed line count, and
 * the result is truncated to BRINGUP_LOG_TAIL_MAX_CHARS here in case a single
 * line of that tail is pathological. The reason ends up in
 * `StudioReadiness.reason`, which `readinessOf` scrubs through
 * `redactSecrets` — and the log itself is already redacted on write by
 * bring-up's own `bringup_redact`, so this is the second of two passes, not
 * the only one.
 */
async function withBringupLogTail(syncDeps: SessionSyncDeps, reason: string): Promise<string> {
  try {
    const res = await syncDeps.exec(bringupLogTailCmd());
    const tail = res.stdout.trim();
    if (tail.length === 0) return reason;
    const clipped = tail.length > BRINGUP_LOG_TAIL_MAX_CHARS
      ? `...(truncated)...\n${tail.slice(tail.length - BRINGUP_LOG_TAIL_MAX_CHARS)}`
      : tail;
    return `${reason}\n--- ${BRINGUP_LOG_PATH} (tail) ---\n${clipped}`;
  } catch (err) {
    console.error("studio: bring-up log tail read failed, reporting the verdict without it", err);
    return reason;
  }
}

/**
 * Task 4 (P2 plane 4): mirrors DO storage's own running `Burn` (session-sync
 * .ts's `BURN_KEY`, updated post-success inside `syncSessionTick` itself)
 * onto the studio's registry-facing `StudioStatus.burn` field, then pushes
 * that through `recordStudio` — the same D1-backed `fleet_state` table
 * `provisionWithStorage`/`restartWithStorage`/`refreshWithStorage` already
 * write, so `fleet ls`/the grid (a later task) read one row per studio
 * without hitting each DO directly (registry.ts's own header explains why
 * that table exists at all).
 *
 * Lives here, not session-sync.ts: this needs BOTH `StudioStorage` (for
 * `STATUS_KEY`) AND `SessionSyncStorage` (for `BURN_KEY`) together, and
 * do.ts is already this feature's composition root for exactly that shape
 * (see `restartWithSync` just above, which composes the same two ports for
 * a different reason). session-sync.ts itself deliberately never imports
 * `StudioStorage`/`STATUS_KEY` from provision.ts — provision.ts already
 * imports FROM session-sync.ts (`restorePlan`), so importing back would be
 * circular; do.ts imports both independently and has no such cycle.
 *
 * A studio with no `STATUS_KEY` yet (never provisioned) or no `BURN_KEY` yet
 * (no sync tick has ever completed) has nothing to mirror and is skipped —
 * `syncSession` never fires before `provision` schedules it in practice, but
 * this stays defensive rather than fabricating a status or calling
 * `recordStudio` with a half-formed one.
 *
 * Issue #228 item 5: also mirrors `StudioStatus.sessionForceArmedAt` from
 * `SESSION_FORCE_KEY`'s own CURRENT storage presence — armed keeps whatever
 * arm-time `clearSessionGuard` already stamped on the row (this function
 * never invents a new timestamp), and NOT armed clears it to `null`. Read
 * directly from storage rather than threaded through as a parameter:
 * `syncSessionCycle` (the ONE caller today) already runs `syncSessionTick`
 * immediately before this in its own separate try/catch, so by the time this
 * runs, storage already reflects whatever that tick just did to the key —
 * self-healing regardless of which of `syncSessionTick`'s several call sites
 * (restartWithSync/recycleWithSync/destroyWithSync/this cycle) most recently
 * consumed it, with no second parameter needed to say so.
 */
export async function mirrorBurnToRegistry(
  storage: StudioStorage & SessionSyncStorage,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
): Promise<void> {
  const status = await storage.get(STATUS_KEY);
  const burn = await storage.get(BURN_KEY);
  if (!status || !burn) return;
  // Issue #94: the guard's last refusal rides the same row write. A DO the
  // guard never wrote to (undefined) leaves the row shape as it was.
  const sessionGuard = await storage.get(SESSION_GUARD_KEY);
  // Issue #258 round-2 review (MED): its own field, from its own key — see
  // BURN_PERSIST_ERROR_KEY's own doc comment (session-sync.ts) for why this
  // is never folded into `sessionGuard` above.
  const burnPersistError = await storage.get(BURN_PERSIST_ERROR_KEY);
  const forceArmed = (await storage.get(SESSION_FORCE_KEY)) === true;
  // PR #46 review: unshipped aside dirs are on the row, like the guard.
  const asideShip = await storage.get(ASIDE_SHIP_KEY);
  const updated: StudioStatus = {
    ...status,
    burn,
    ...(asideShip === undefined ? {} : { asideShip }),
    ...(sessionGuard === undefined ? {} : { sessionGuard }),
    ...(burnPersistError === undefined ? {} : { burnPersistError }),
    sessionForceArmedAt: forceArmed ? (status.sessionForceArmedAt ?? null) : null,
  };
  await storage.put(STATUS_KEY, updated);
  await recordStudioFn(updated);
}

/**
 * Fleet ls readiness fix ("a dead studio looks alive" — P5a Task 5's Finding
 * 2, live-measured: 3 of 4 studios bare, `fleet ls` showed every one
 * `running, error: null` throughout). Stamps a FRESH provisioned verdict
 * onto StudioStatus.readiness every syncSession tick — same composition-root
 * placement as mirrorBurnToRegistry just above, same reason: this needs
 * BOTH StudioStorage (STATUS_KEY) and the harness expectation stored under
 * ROLE_ENV_KEY, and do.ts is already where those two come together.
 *
 * Runs checkProvisionedWithRetry — the SAME check GET /studio/:id/provisioned
 * and recycle already gate on — so this can never disagree with either about
 * what "provisioned" means. Deliberately NOT triggered from fleet ls's own
 * request path: fleet ls lists the WHOLE fleet, and a live per-studio exec
 * there could hang the one command an operator reaches for first when
 * something looks wrong. This runs on the studio's own periodic tick
 * instead (SYNC_SESSION_SECONDS-cadenced, the tick that already execs into
 * the container for session sync), so fleet ls only ever reads a value the
 * registry already has — bounded by one D1 read, never N container round
 * trips.
 *
 * `checkedAt` is stamped from `syncDeps.now()` on EVERY outcome, including
 * inconclusive: a check that could not decide still records WHEN it tried,
 * so a stale "don't know" is visibly stale rather than reading as fresh —
 * see StudioReadiness's own doc comment.
 *
 * Skips silently (no exec, no write) when there is no status yet (a studio
 * whose first provision has not landed — same "nothing to mirror yet"
 * posture mirrorBurnToRegistry takes above) or when idFallback does not
 * parse as a studio id (no repo segment to check against — should not
 * happen for a real StudioDO, but a check that cannot name what to check is
 * exactly the kind of thing that must never crash the tick). It RETURNS the
 * status it stamped (null when it skipped), which is what lets issue #37's
 * three on-demand callers — provisionWithFreshVerdict, StudioDO.checkNow and
 * through it POST /studio/:id/check — report the verdict they just took
 * instead of re-reading a row and hoping it is the same one.
 *
 * The periodic tick is no longer the ONLY caller, but `fleet ls` is still
 * never one: a live per-studio exec on the fleet-wide listing path is exactly
 * what issue #37 rules out ("Do NOT make `fleet ls` always check live"). The
 * opt-in `fleet ls --fresh` fans out POST /check per studio from the CLI,
 * where the cost is visible and one slow container cannot wedge the listing.
 */
/**
 * Issue #71's decision, alone and pure: given what the tick just measured and
 * what storage remembers, does this studio heal itself right now?
 *
 * Four hard constraints, each a measured incident rather than a preference:
 *
 * 1. Only a `bare` verdict. `inconclusive` is a statement about the CHECK --
 *    a throw, a timeout, an unreadable answer -- and never about the studio
 *    (StudioReadiness's own doc comment). Restarting a studio because a probe
 *    failed would turn every transient network hiccup into a container
 *    restart.
 * 2. Only `state === "running"`. `sbExec` STARTS a stopped container and
 *    billing begins, so a heal that touched stopped studios would spend money
 *    where the operator cannot see it -- the invariant the whole fleet is
 *    built around. `provisioning` is excluded for a different reason: a
 *    provision is already in flight and its own verification will speak.
 * 3. At most once per episode. The marker is the whole loop guard: a studio
 *    bare for a REAL reason (broken image, deleted repo) would otherwise
 *    restart every 300s forever.
 * 4. A `provisioned` verdict disarms, so a LATER episode can heal again. A
 *    marker that armed once and stayed armed would protect the container that
 *    is already broken and abandon every future one.
 */
export type HealDecision =
  | { kind: "heal"; reason: string }
  | { kind: "disarm" }
  | { kind: "stand-down"; why: string };

export function decideHeal(
  status: StudioStatus,
  readiness: StudioReadiness,
  marker: HealAttempt | undefined,
  // Issue #86. The stored row reads `running` for the WHOLE of an operator's
  // provision or recycle -- `state: "provisioning"` is a local variable that
  // never reaches storage until the operation is already over. So the state
  // gate below could never see an operation in flight, and the tick healed
  // straight into the middle of one: two clones into one directory, two
  // bring-ups into one pane, and this episode's single attempt spent fighting
  // the operator. The lock is the only thing that can answer this question.
  //
  // Issue #103: null is the RELEASED lock -- what every provision and restart
  // writes in its `finally` -- and must read exactly like no lock at all.
  inFlight?: OperationInFlight | null,
  now?: Date,
  // Issue #100 N5: DESTROYING_KEY's value. A heal is a restartStudio, which
  // would write `running` over a destroy and start the container it stops.
  // null is the released marker (#103's lesson) and reads as none.
  destroyingSince?: string | null,
): HealDecision {
  if (readiness.kind === "provisioned") {
    return marker?.armed ? { kind: "disarm" } : { kind: "stand-down", why: "provisioned" };
  }
  if (readiness.kind !== "bare") return { kind: "stand-down", why: `verdict is ${readiness.kind}` };
  if (destroyingMarkerFresh(destroyingSince, now ?? new Date())) {
    return { kind: "stand-down", why: "a destroy is in flight" };
  }
  // The state gate names what it REFUSES, not what it allows -- the
  // difference is the whole of the bug below.
  //
  // `stopped` is the one that matters: sbExec STARTS a stopped container and
  // billing begins. `provisioning` means an operation is already in flight
  // and its own verification will speak.
  //
  // `degraded` is ALLOWED, and the first version of this refused it. Measured
  // by an adversarial re-read of #74, which proved the give-back it added was
  // inert: a heal whose bring-up is killed by a rollout does not throw --
  // runRestart CATCHES it and persists `state: "degraded"` (provision.ts).
  // So the next tick met a degraded row, stood down on state, and never
  // reached the marker #74 had just handed back. A studio that failed one
  // heal could never heal again, for any reason, ever.
  //
  // Degraded is precisely the state a bare studio is in after a heal that did
  // not take. Refusing it protected nothing and disabled the feature; the
  // one-attempt marker below is what bounds the retries, and it is enough.
  if (status.state === "stopped" || status.state === "provisioning") {
    return { kind: "stand-down", why: `state is ${status.state}, which is never healed from` };
  }
  if (inFlight != null) {
    // Stale locks are ignored ON PURPOSE. An isolate evicted mid-provision
    // leaves the marker set with nobody to clear it, and a lock that cannot
    // expire would disable healing for that studio forever -- the exact
    // permanent-disable failure #81 had just removed from the state gate.
    const age = (now ?? new Date()).getTime() - new Date(inFlight.since).getTime();
    if (Number.isFinite(age) && age >= 0 && age < OPERATION_STALE_MS) {
      return {
        kind: "stand-down",
        why: `a ${inFlight.op} started at ${inFlight.since} is still in flight; it verifies itself`,
      };
    }
  }
  if (marker?.armed) {
    return { kind: "stand-down", why: `already healed once at ${marker.attemptedAt}, still bare` };
  }
  return { kind: "heal", reason: readiness.reason };
}

/**
 * What a healed studio's row says. Non-null `error` on a `running` studio is
 * deliberate and is issue #38 part 3's rule applied to this path too: a
 * silent heal is precisely how this class of bug hid for a day. The operator
 * must be able to read, from `fleet ls` alone, that this container came back
 * bare and was restarted for it.
 */
export const BARE_SELF_HEALED = "self-healed: the container came back BARE and was restarted once";

/**
 * What the Cloudflare runtime says while it is replacing a container under a
 * live DO. Verbatim, from the Worker tail during the 2026-09-24 rollout:
 *
 *   Error: Runtime signalled the container to exit due to a new version
 *   rollout: 0
 *
 * Matched as a substring rather than parsed: it is someone else's message and
 * its shape is not ours to depend on beyond the one phrase that names the
 * cause.
 */
export const ROLLOUT_EXIT_MARKER = "container to exit due to a new version rollout";

/**
 * Was this heal's failure the rollout itself, rather than anything about the
 * studio?
 *
 * MEASURED 2026-09-24, on the very deploy that shipped the heal. The rollout
 * replaced every container. Each replacement went BARE, the tick saw it, the
 * heal fired -- and the bring-up it started was killed by the same rollout
 * seconds later. The evidence is that `/workspace/.fleet/bringup.log` held
 * ONLY the worker's own two retry lines and not a single step line: the
 * script never got far enough to write one.
 *
 * That is the worst possible moment to spend the episode's one attempt. The
 * marker would stay armed over a container that is bare precisely BECAUSE it
 * was just replaced, and the studio would sit bare until a human noticed --
 * which is the entire failure #71 exists to end.
 *
 * So a rollout-killed heal is not an attempt. It disarms instead, and the
 * next tick may heal again. This cannot loop: a rollout is a bounded event
 * that ends, and when it does the next heal is an ordinary one that arms
 * normally.
 */
export function healDiedInRollout(status: StudioStatus | undefined | null): boolean {
  return status?.error != null && status.error.includes(ROLLOUT_EXIT_MARKER);
}

/**
 * The heal itself, wired into the tick.
 *
 * `heal()` is injected rather than imported so this stays testable and so
 * do.ts keeps its one composition root: StudioDO hands in the same
 * restart path an operator's `fleet provision` reaches, which already carries
 * #38's verification and its own one-shot retry. Nothing new decides what
 * "came up correctly" means.
 *
 * Returns what it did, for the caller to log. Throws nothing: the marker is
 * armed BEFORE the restart runs, so a heal that dies mid-restart still counts
 * as the one attempt this episode gets. Arming after would let a crashing
 * restart loop forever, which is the failure this guard exists to prevent.
 */
export async function healBareContainer(
  storage: StudioStorage,
  idFallback: string,
  status: StudioStatus,
  readiness: StudioReadiness,
  now: () => Date,
  heal: () => Promise<unknown>,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
): Promise<HealDecision> {
  const marker = await storage.get(HEAL_ATTEMPT_KEY);
  const inFlight = await storage.get(OPERATION_KEY);
  const destroyingSince = await storage.get(DESTROYING_KEY);
  const decision = decideHeal(status, readiness, marker, inFlight, now(), destroyingSince);
  if (decision.kind === "disarm") {
    await storage.put(HEAL_ATTEMPT_KEY, {
      armed: false,
      attemptedAt: marker?.attemptedAt ?? now().toISOString(),
      reason: marker?.reason ?? "",
    });
    return decision;
  }
  if (decision.kind !== "heal") return decision;
  await storage.put(HEAL_ATTEMPT_KEY, {
    armed: true,
    attemptedAt: now().toISOString(),
    reason: redactSecrets(decision.reason),
  });
  console.log(`studio ${idFallback}: container is BARE (${decision.reason}) -- restarting it once`);
  // Issue #152: `heal` IS a call to restartStudio() (syncSessionCycle's own
  // wiring), which creates and manages its OWN op ctx internally — this is
  // deliberately NOT a second ctx registered anywhere (do.ts's `activeOps`
  // stays restartStudio's alone): just a local before/after epoch compare,
  // scoped to guarding the ONE write below that sits outside restartStudio's
  // own ctx-guarded tail. restartStudio()'s own return value already reflects
  // a mid-heal destroy correctly (its own guards saw to that); this is only
  // about whether IT IS SAFE for this function to layer its own
  // BARE_SELF_HEALED note on top of whatever restartStudio just left behind.
  const epochBeforeHeal = await readDestroyEpoch(storage);
  await heal();
  if ((await readDestroyEpoch(storage)) !== epochBeforeHeal) {
    console.error(`studio ${idFallback}: destroy landed mid-heal, skipping the post-heal note`);
    return decision;
  }
  // The loud part, and the reason BARE_SELF_HEALED exists. The restart writes
  // its own row; a studio that came back healthy would therefore read
  // `running, error: null` and the episode would be invisible in the one
  // place an operator actually looks. Issue #38 part 3 made exactly this rule
  // for its own retry ("never report success for the second attempt without
  // saying the first failed"); this is that rule applied one level up.
  //
  // Never overwrites an error the restart itself recorded: that one is about
  // what is broken NOW and outranks a note about how we got here.
  // Known consequence (#330 round 4): a configured-but-unreadable house-rules
  // overlay rides in `error` too (provision.ts's houseRulesOverlayNote), so a
  // heal of such a studio leaves that note and never stamps BARE_SELF_HEALED.
  // Accepted: the overlay note is the standing misconfiguration and outranks
  // a note about the heal, same rule as the line above.
  const after = await storage.get(STATUS_KEY);
  // The rollout race, above. Give the attempt back: this heal never got to
  // touch a container that was going to survive.
  if (healDiedInRollout(after)) {
    await storage.put(HEAL_ATTEMPT_KEY, {
      armed: false,
      attemptedAt: now().toISOString(),
      reason: `heal abandoned: ${ROLLOUT_EXIT_MARKER}`,
    });
    console.log(`studio ${idFallback}: heal was killed by a container rollout -- attempt returned, will heal again next tick`);
    return decision;
  }
  if (after && after.error === null) {
    const healed: StudioStatus = {
      ...after,
      error: `${BARE_SELF_HEALED}: ${redactSecrets(decision.reason)}`,
    };
    await storage.put(STATUS_KEY, healed);
    await recordStudioFn(healed);
  }
  return decision;
}

export async function checkAndRecordReadiness(
  syncDeps: SessionSyncDeps,
  storage: StudioStorage,
  idFallback: string,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  // Issue #152: an outer operation's own ctx (provisionWithFreshVerdict /
  // restartWithFreshVerdict thread their own through). Optional and additive
  // to this function's pre-existing `watchForDestroy` snapshot below, exactly
  // like refreshWithStorage's own `ctx` parameter — the periodic tick's own
  // call (syncSessionCycle) supplies none and keeps issue #123's original
  // tick-scoped behaviour unchanged.
  ctx: OpCtx = NEVER_MOVED_CTX,
): Promise<StudioStatus | null> {
  const status = await storage.get(STATUS_KEY);
  if (!status) return null;
  // A stopped studio has nothing to measure, and the check's exec would boot
  // the very container it asks about. `fleet ls --fresh` checks every studio.
  if (status.state === "stopped") return status;
  // Issue #152: a destroy already landed (fully) before this check even
  // started — never take the exec at all, since it would restart the very
  // container the destroy just stopped.
  if (await ctx.moved()) return (await storage.get(STATUS_KEY)) ?? status;
  const parsed = parseStudioId(idFallback);
  if (!parsed) return null;
  const harness = await storedHarness(storage);
  const destroyLanded = await watchForDestroy(storage, syncDeps.now);
  const verdict = await checkProvisionedWithRetry(syncDeps, parsed.repo, harness);
  const readiness = readinessOf(verdict, syncDeps.now().toISOString());
  // Issue #123: the check's exec opened the input gate; a destroy that landed
  // meanwhile keeps its row. Otherwise build on the row as it is NOW.
  // Issue #152: `ctx.moved()` catches the same race from the OUTER operation's
  // own, epoch-based vantage point, in addition to this function's own
  // point-in-time `destroyLanded` snapshot.
  if ((await destroyLanded()) || (await ctx.moved())) return (await storage.get(STATUS_KEY)) ?? null;
  const updated: StudioStatus = { ...((await storage.get(STATUS_KEY)) ?? status), readiness };
  await storage.put(STATUS_KEY, updated);
  await recordStudioFn(updated);
  return updated;
}

/**
 * Board #140 (#94 follow-up, HOLD fix): the operator's escape from a sync
 * guard stuck displacing every candidate. Today only SESSION_CLEANUP_MS (30
 * days, the `poorerThan`'s own leniency past claude's own transcript-cleanup
 * age) ever unsticks it — an operator who needs it sooner has no lever at
 * all.
 *
 * HISTORY (why this no longer just deletes SESSION_MARK_KEY): the original
 * #140 design deleted the stored mark, expecting the next tick's
 * `mark ?? seedMark(...)` to re-derive a fresh one and let the pending
 * candidate through. That was a no-op in the exact "frozen, stuck
 * displacing everything" case this verb exists for: `seedMark` re-derives
 * its mark from R2's `latest` — the SAME `latest` every candidate has been
 * losing to — so the freshly re-seeded mark is identical to what was just
 * deleted, and the very next tick displaces the very next candidate for the
 * very same reason. Held in review (#192) until fixed.
 *
 * The actual fix: this now ARMS SESSION_FORCE_KEY, a one-shot override
 * session-sync.ts's `syncSessionTick` reads on its NEXT tick. An armed
 * override skips the mark/`poorerThan` comparison entirely for that one
 * tick — not "accept anything forever", just "let the next real candidate
 * through, once" — and copies the `latest` it is about to overwrite to a
 * `sessions/<id>/superseded/<iso>.tar.gz` safety-net key first (see
 * `sessionSupersededKey`'s own doc comment, archive.ts) so the bypassed
 * comparison can never silently destroy session history a human might still
 * want. A blank or unreadable candidate still refuses (the override stays
 * armed for a later, real candidate) — this is a bypass of the COMPARISON,
 * not of every safeguard the guard has. See `syncSessionTick`'s own doc
 * comment (session-sync.ts) for the complete tick-level design.
 *
 * SESSION_GUARD_KEY (the last-refusal record) is cleared unconditionally
 * alongside the arm — an operator who just cleared it should not keep
 * seeing the OLD refusal reason while the override is pending.
 *
 * Mirrors the clear onto StudioStatus.sessionGuard and records it
 * immediately, same as checkAndRecordReadiness just above — an operator who
 * just cleared it should see that on the very next `fleet ls`, not wait up
 * to SYNC_SESSION_SECONDS for the next tick to stamp it.
 *
 * Issue #228 item 5: also stamps StudioStatus.sessionForceArmedAt with WHEN
 * this call armed the override, mirrored and recorded the same way and at
 * the same moment as the sessionGuard clear just above — an armed override
 * was previously invisible on `fleet ls`/`fleet inspect` until the tick that
 * consumed it had already run. Written UNCONDITIONALLY (unlike the
 * sessionGuard clear, which only fires when there was something to clear):
 * `storage.put(SESSION_FORCE_KEY, true)` above always arms the override, so
 * the row must always say so, even for a studio with no PRIOR guard refusal
 * at all — this is the one thing that makes a second call genuinely NOT a
 * no-op the way it used to read. `mirrorBurnToRegistry`'s own tick-side
 * mirror (below) is what clears it again once a tick actually consumes the
 * override — see that function's own doc comment.
 *
 * Storage-only, deliberately: no exec, no direct R2 call from this function
 * (the R2 read/copy happens inside `syncSessionTick` itself, on the tick the
 * override is actually consumed) — safe to call on a STOPPED studio, and
 * idempotent (a second call before any tick runs just re-arms the same
 * already-true value, restamping `sessionForceArmedAt` to the new call's
 * time — nothing here doubles up).
 */
export async function clearSessionGuard(
  storage: StudioStorage & SessionSyncStorage,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  // Issue #228 item 5: injectable, same "a hidden clock is not testable"
  // ruling readiness-format.ts's own header states — every real caller
  // (StudioDO.clearSessionGuard) leaves this at its default.
  now: () => Date = () => new Date(),
): Promise<StudioStatus | null> {
  await storage.put(SESSION_FORCE_KEY, true);
  const armedAt = now().toISOString();
  // Issue #176: an OVERSIZE refusal is not a stale guard the override can
  // resolve — the tar is too big to sync at all. Kept, so the row keeps
  // saying since when the studio stopped syncing.
  const guard = await storage.get(SESSION_GUARD_KEY);
  const oversize = guard?.capBytes !== undefined;
  if (!oversize) await storage.put(SESSION_GUARD_KEY, null);
  const status = await storage.get(STATUS_KEY);
  if (!status) return null;
  const updated: StudioStatus = {
    ...status,
    sessionForceArmedAt: armedAt,
    ...(oversize ? {} : { sessionGuard: null }),
  };
  await storage.put(STATUS_KEY, updated);
  await recordStudioFn(updated);
  return updated;
}

/**
 * Issue #37: `provision` re-runs the readiness check and answers with the
 * FRESH verdict, before responding.
 *
 * The bug this closes, measured 2026-09-23 on the live fleet: a deploy rolled
 * the container image, acme-os--release-studio and --scratch came back BARE
 * (/workspace empty, pane running bash), and a single `fleet provision`
 * healed each one — clone at ec33cca, claude running, 4 procs. The status row
 * `provision` returned still said `bare: no git checkout`, because
 * `runProvision` spreads the EXISTING status forward, `readiness` included,
 * and the only thing that ever re-stamps that field was the syncSession tick,
 * up to SYNC_SESSION_SECONDS (300s) later. An operator who ran provision and
 * read the row concluded the command did nothing. A reviewing agent reported
 * exactly that — "provision and recycle silently succeed, zero effect" — and
 * it was false.
 *
 * One extra container round trip per provision, deliberately: this verb is
 * operator-initiated and already does far more expensive work (clone,
 * bring-up), so the check's cost is noise next to the cost of an unreadable
 * answer. `recycle` does NOT pay it twice — StudioDO.recycle passes
 * provisionCore (the unwrapped body) precisely so recycleWithSync's own
 * post-provision check stays the only one on that path.
 *
 * NEVER echoes the cached verdict, on any path. When the check cannot be
 * taken at all — no parseable studio id, or a storage/registry write that
 * throws — the returned readiness is an `inconclusive` stamped NOW, not the
 * row that was already there: "I could not tell you" is honest, and a stale
 * verdict dressed as fresh is the whole of issue #37. A failed check never
 * fails the provision itself: the studio genuinely came up, and the report is
 * a report.
 */
export async function provisionWithFreshVerdict(
  syncDeps: SessionSyncDeps,
  storage: StudioStorage,
  idFallback: string,
  provisionCore: (cfg: ProvisionConfig) => Promise<StudioStatus>,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  cfg: ProvisionConfig,
  // Issue #152: provision()'s own ctx, threaded to the readiness check below
  // so a destroy landing during THAT exec cannot start a second container or
  // write a fresh verdict over a row destroy already stopped.
  ctx: OpCtx = NEVER_MOVED_CTX,
): Promise<StudioStatus> {
  const status = await provisionCore(cfg);
  try {
    const fresh = await checkAndRecordReadiness(syncDeps, storage, idFallback, recordStudioFn, ctx);
    if (fresh) return fresh;
    return withUntakenVerdict(syncDeps, status, `no readiness check could be taken for ${idFallback}`);
  } catch (err) {
    console.error(`studio ${idFallback}: post-provision readiness check failed`, err);
    return withUntakenVerdict(syncDeps, status, err instanceof Error ? err.message : String(err));
  }
}

/** The one shape a recovery verb may report when its own check did not
 *  happen: `inconclusive`, stamped NOW. Deliberately NOT persisted — nothing
 *  was measured about the studio, so there is nothing to record; this is the
 *  RESPONSE saying so. Same redaction posture as every other reason this file
 *  holds (see runProvision's own catch). */
function withUntakenVerdict(syncDeps: SessionSyncDeps, status: StudioStatus, reason: string): StudioStatus {
  return {
    ...status,
    readiness: {
      kind: "inconclusive",
      reason: redactSecrets(`readiness check did not run: ${reason}`),
      checkedAt: syncDeps.now().toISOString(),
    },
  };
}

/**
 * Issue #38 part 2, the reporting half: a restart answers with a verdict
 * measured AFTER it, never with the one that was already in the row.
 *
 * `runRestart` spreads the EXISTING status forward, `readiness` included.
 * That is harmless when a restart heals the container it is already talking
 * to — the assumption #29's own PR stated when it declined to extend restart
 * — and actively wrong when a container image rollout has REPLACED the
 * container under the DO: the row then carries a `provisioned` verdict taken
 * against a filesystem that no longer exists, and a studio that came back
 * hollow reads as healthy. Measured 2026-09-23 across six `acme-os`
 * studios in a single rollout.
 *
 * REUSES issue #37's machinery rather than building a parallel one:
 * `checkAndRecordReadiness` is the same unit `provisionWithFreshVerdict`,
 * `StudioDO.checkNow` and the syncSession tick all run, so restart cannot
 * drift into a different definition of "ready" than every other surface. The
 * shape mirrors `provisionWithFreshVerdict` deliberately, down to the
 * untaken-verdict fallback — the difference is only that a restart's core has
 * already run by the time this is called (it takes `restarted`, not a
 * callback), because `StudioDO.restartStudio` has other work to do between
 * the restart and the answer (the maestro's sweep arming).
 *
 * The restart's own `error` — including issue #38 part 3's "the first attempt
 * failed" note — survives: `checkAndRecordReadiness` re-reads the status the
 * restart just wrote to storage and stamps `readiness` onto it, touching no
 * other field. A second-attempt success therefore still says the first failed
 * in the very row the operator reads.
 *
 * NEVER echoes the cached verdict, on any path: when the check cannot be
 * taken at all the answer is an `inconclusive` stamped NOW. A failed check
 * never fails the restart itself — the studio genuinely came up, and the
 * report is a report.
 */
export async function restartWithFreshVerdict(
  syncDeps: SessionSyncDeps,
  storage: StudioStorage,
  idFallback: string,
  restarted: StudioStatus,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  // Issue #152: restartStudio's own ctx — see provisionWithFreshVerdict's
  // identical parameter for why.
  ctx: OpCtx = NEVER_MOVED_CTX,
): Promise<StudioStatus> {
  try {
    const fresh = await checkAndRecordReadiness(syncDeps, storage, idFallback, recordStudioFn, ctx);
    if (fresh) return fresh;
    return withUntakenVerdict(syncDeps, restarted, `no readiness check could be taken for ${idFallback}`);
  } catch (err) {
    console.error(`studio ${idFallback}: post-restart readiness check failed`, err);
    return withUntakenVerdict(syncDeps, restarted, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Board issue #24 fix — the real StudioDO.syncSession() body, extracted so
 * it is testable (StudioDO cannot be constructed under vitest-pool-workers,
 * see this file's own header) and so each of its three steps is genuinely
 * independent, not merely commented as if it were.
 *
 * Before this fix, syncSession() ran all three of syncSessionTick /
 * mirrorBurnToRegistry / checkAndRecordReadiness under ONE shared try/catch.
 * The comments sitting right above the second and third calls claimed
 * per-step isolation ("same try/catch as the sync tick above, so a
 * mirror/check failure logs and never blocks the reschedule") that did not
 * actually exist: a throwing FIRST step (syncSessionTick) meant the other
 * two never got a chance to run at all, not merely that their own failures
 * were swallowed. Measured, real: a fresh container tar/stat-ing before
 * claude has ever written ~/.claude/projects
 * (`tar: .claude/projects: Cannot stat: No such file or directory`) rejects
 * syncSessionTick every tick, forever — and with the shared try, that alone
 * was enough to keep StudioStatus.readiness stamped `undefined` forever too,
 * even though checkAndRecordReadiness's own container check has nothing to
 * do with the session tar and could have succeeded independently.
 *
 * Each step below gets its OWN try/catch with its OWN distinct log message,
 * so a Worker tail can tell which step failed, and so any one step's
 * failure can never suppress the other two. The reschedule itself is
 * deliberately NOT here: it lives in the DO method's own try/finally around
 * the single call to this function (unconditional, same SYNC_SESSION_SECONDS
 * cadence, unchanged from before this fix) — this function's own job stops
 * at "run the three steps, isolated", the same division restartWithSync
 * (above) draws between the sync attempt it isolates and the bring-up it
 * still lets propagate.
 */
export async function syncSessionCycle(
  syncDeps: SessionSyncDeps,
  storage: StudioStorage & SessionSyncStorage & InstallCacheSaveStorage,
  idFallback: string,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  failoverDeps?: FailoverDeps | null,
  heal?: (() => Promise<unknown>) | null,
  observedStorage?: ObservedStorage | null,
  retrySurvivalBrief?: (() => Promise<unknown>) | null,
  installCacheDeps?: InstallCacheSaveDeps | null,
  // Round 3 review, item 3: an in-memory in-flight flag for the detached save
  // below, scoped by the CALLER (StudioDO keeps one per DO instance, a field
  // that outlives any single tick but not the isolate itself — see
  // installCacheSaveLeaseFresh's own doc comment in install-cache.ts for why
  // a storage-persisted lease exists ALONGSIDE this rather than instead of
  // it). Absent (every existing caller/test that predates this feature)
  // means exactly what every other optional port here means: behave as
  // before, i.e. never block a detached save on this guard at all — the
  // in-memory half is then simply not in effect, though the storage lease
  // below still is.
  installCacheGuard?: { inFlight: boolean } | null,
): Promise<void> {
  try {
    const now = syncDeps.now().toISOString();
    const result = await syncSessionTick(syncDeps, storage, idFallback);
    await recordSnapshotOnSuccess(observedStorage, result, now);
  } catch (err) {
    console.error(`studio ${idFallback}: session sync tick failed`, err);
  }
  // Issue #37: its own try — an aside failure never costs the main sync.
  // PR #46 review: its failures ride the row (mirrorBurnToRegistry below).
  try {
    const at = syncDeps.now().toISOString();
    let failed: { dir: string; reason: string }[];
    try {
      failed = (await shipAsideSessions(syncDeps, idFallback)).failed;
    } catch (err) {
      console.error(`studio ${idFallback}: aside session ship failed`, err);
      failed = [{ dir: "(listing)", reason: err instanceof Error ? err.message : String(err) }];
    }
    await storage.put(ASIDE_SHIP_KEY, failed.length > 0 ? { at, failed } : null);
  } catch (err) {
    console.error(`studio ${idFallback}: aside ship record failed`, err);
  }
  try {
    await mirrorBurnToRegistry(storage, recordStudioFn);
  } catch (err) {
    console.error(`studio ${idFallback}: burn mirror failed`, err);
  }
  // Issue #53: the account-exhaustion step. Its own try/catch, its own
  // message, exactly like the three around it — a container this tick cannot
  // reach must not cost the studio its readiness verdict.
  //
  // THIRD, deliberately: it can kill and relaunch claude, and the readiness
  // check below is the SAME check every other readiness surface runs. Running
  // it after means the verdict this tick records describes the studio AFTER
  // any switch, and the relaunch gets verified by a check that already exists
  // rather than by a second one written here.
  //
  // Optional: a caller with no accounts wired (every existing test, and any
  // future caller that only wants the other three steps) runs the cycle
  // exactly as it ran before this feature.
  if (failoverDeps) {
    try {
      const outcome = await runAccountFailover(failoverDeps, storage, idFallback, recordStudioFn, observedStorage ?? undefined);
      // Only the decisions worth an operator's attention. `no-modal` is the
      // overwhelmingly common outcome and logging it every 300s per studio
      // would bury everything else in a Worker tail.
      if (outcome.kind !== "no-modal") {
        console.log(`studio ${idFallback}: claude account failover -> ${JSON.stringify(outcome)}`);
      }
    } catch (err) {
      console.error(`studio ${idFallback}: claude account failover failed`, err);
    }
  }
  let checked: StudioStatus | null = null;
  try {
    checked = await checkAndRecordReadiness(syncDeps, storage, idFallback, recordStudioFn);
  } catch (err) {
    console.error(`studio ${idFallback}: readiness check failed`, err);
  }
  // Issue #71, LAST and in its own try/catch like the four steps above: the
  // verdict the tick just took is the only place in the system that knows a
  // RUNNING container came back bare, and until now nothing acted on it. A
  // heal that throws must not cost the studio the verdict already recorded
  // above, which is why this is a separate block and not folded into the
  // check's own.
  //
  // Optional, exactly like failoverDeps: a caller that wires no heal runs
  // the cycle precisely as it ran before this feature.
  if (heal && checked) {
    try {
      const decision = await healBareContainer(
        storage, idFallback, checked,
        checked.readiness ?? { kind: "inconclusive", reason: "no verdict recorded", checkedAt: syncDeps.now().toISOString() },
        syncDeps.now, heal, recordStudioFn,
      );
      // `stand-down` is the overwhelmingly common outcome (every healthy
      // tick, every studio, every 300s) and logging it would bury everything
      // else in a Worker tail — the same reason runAccountFailover above
      // logs everything except `no-modal`.
      if (decision.kind !== "stand-down") {
        console.log(`studio ${idFallback}: bare-container heal -> ${JSON.stringify(decision)}`);
      }
    } catch (err) {
      console.error(`studio ${idFallback}: bare-container heal failed`, err);
    }
  }
  // Issue #249 (PR4b) round 2, item 2, LAST and in its own try/catch like the
  // five steps above: THE REGULAR TICK THAT RETRIES A DEFERRED SURVIVAL
  // RE-BRIEF. Round 1 attempted delivery only from a bring-up, and a bring-up
  // that found the lead mid-turn wrote nothing at all — so the only retry was
  // another container replacement, which on a healthy studio is not a schedule.
  // This is that schedule, and it is THIS cycle rather than `sweepMaestro`
  // because the sweep is armed for the MAESTRO alone (do.ts's `armSweep`, and
  // provision()'s `if (this.isMaestro())` around it) while the brief is owed to
  // every studio.
  //
  // LAST, deliberately, and for the same reason the heal above is: it can type
  // into the pane, and the readiness verdict this tick records should describe
  // the studio BEFORE this feature touched it. It is also the cheapest step to
  // lose — a retry that misses one tick simply happens on the next.
  //
  // Optional, exactly like `failoverDeps` and `heal`: a caller that wires none
  // runs the cycle precisely as it ran before this feature.
  if (retrySurvivalBrief) {
    try {
      await retrySurvivalBrief();
    } catch (err) {
      console.error(`studio ${idFallback}: deferred survival re-brief retry failed`, err);
    }
  }
  // Board #350 round 2, item 5: DETACHED, and LAST. This used to be awaited
  // inline near the top of this function — but its own curl --max-time 900
  // can run longer than this whole tick's 480s deadline (TICK_DEADLINES_MS.
  // syncSession), and awaiting it there meant a slow (or wedged) save
  // consumed the ENTIRE tick budget, so failover/readiness/heal above never
  // even STARTED, not merely ran late. Measured: a save mid-`bun install`
  // (623s on websites, #350's own number) alone exceeds the deadline.
  //
  // Fixed two ways at once: (1) moved to LAST, after every safety-critical
  // step above has already run to completion, so a slow save can no longer
  // starve them of their turn; (2) fire-and-forget (`void`, no `await`) so
  // this function's own promise resolves without waiting on the save at
  // all — runScheduledTick's outer deadline race (do.ts, ~line 2506) governs
  // only the five steps above now, never this one. A promise never awaited
  // by anyone must catch its own rejections; nothing here ever throws past
  // this IIFE. Optional, same "absent = run the cycle exactly as it ran
  // before this feature" contract as failoverDeps/heal/retrySurvivalBrief.
  //
  // Round 2 review, item 1's redesign (install-cache.ts): a single call here
  // can now save SEVERAL directories in one repo, one after another inside
  // runInstallCacheSaveTick itself (a monorepo like example-org/websites has
  // eight). That does not change anything about THIS detachment: it is still
  // exactly one call, still fired last, still unawaited — the tick's own
  // deadline race above never has to know or care how many directories one
  // repo happens to cache.
  if (installCacheDeps) {
    void (async () => {
      // Round 3 review, item 3 — in-flight guard, checked BEFORE
      // runInstallCacheSaveTick is even called, two layers:
      //   (1) the in-memory flag: a save already running in THIS isolate
      //       (from an overlapping tick — session-sync.ts's own 300s cadence
      //       can overlap a save whose own curl legs run up to 900s each)
      //       skips outright, no storage read needed to know that.
      //   (2) the storage-persisted lease: a fresh isolate (this one just
      //       started, or the SAME one after nothing survived in memory)
      //       cannot see (1) at all, so it checks whether a PRIOR isolate
      //       left a lease that is still fresh — installCacheSaveLeaseFresh's
      //       own doc comment (install-cache.ts) has the staleness budget and
      //       why it's sized the way it is.
      // Neither guard ever throws past this point: a storage read/write
      // hiccup here degrades to "just run the save" (matching the file's own
      // "no signal either way = proceed" posture bunInstallRunningCmd's own
      // doc comment states for its own guard) rather than silently and
      // permanently refusing every future save tick.
      if (installCacheGuard?.inFlight) return;
      let leaseFresh = false;
      try {
        leaseFresh = installCacheSaveLeaseFresh(await storage.get(INSTALL_CACHE_SAVE_LEASE_KEY), installCacheDeps.now());
      } catch (err) {
        console.error(`studio ${idFallback}: install cache lease read failed, proceeding`, err);
      }
      if (leaseFresh) return;
      if (installCacheGuard) installCacheGuard.inFlight = true;
      try {
        await storage.put(INSTALL_CACHE_SAVE_LEASE_KEY, installCacheDeps.now().toISOString());
        const repoSlug = (await storage.get(STATUS_KEY))?.repoSlug ?? null;
        const result = await runInstallCacheSaveTick(installCacheDeps, storage, idFallback, repoSlug);
        if (result.attempted) console.log(`studio ${idFallback}: install cache ${result.outcome}`);
      } catch (err) {
        console.error(`studio ${idFallback}: install cache save failed`, err);
      } finally {
        if (installCacheGuard) installCacheGuard.inFlight = false;
        try {
          await storage.put(INSTALL_CACHE_SAVE_LEASE_KEY, "");
        } catch (err) {
          console.error(`studio ${idFallback}: install cache lease release failed`, err);
        }
      }
    })();
  }
}

/**
 * Every scheduled callback StudioDO runs. `destroyStudio` cancels all of them
 * (disarmStudioTicks below); a name missing here is a loop destroy leaves
 * running.
 */
export const STUDIO_TICKS = ["refreshToken", "shipTranscript", "syncSession", "sweepMaestro"] as const;

export function disarmStudioTicks(deleteSchedules: (name: string) => void): void {
  for (const name of STUDIO_TICKS) deleteSchedules(name);
}

const isStoppedIn = async (storage: StudioStorage): Promise<boolean> =>
  ((await storage.get(STATUS_KEY))?.state ?? "stopped") === "stopped";

/**
 * The one gate every scheduled tick passes through. A stopped studio STAYS
 * stopped: sbExec STARTS a container that is not running, so a tick that
 * execs into a stopped studio boots an empty container and billing begins.
 * Measured 2026-09-24 — `fleet destroy` left every loop armed, and all 12
 * stopped studios took an exec every ~5 minutes.
 *
 * Stopped (or never provisioned — getStatus's own default) means: no tick,
 * and no re-arm, so the loop ends here. The state is read again before the
 * re-arm, so a tick already in flight when a destroy lands does not revive
 * the loop that destroy cancelled. Otherwise the re-arm stays in `finally`,
 * exactly as refreshToken()'s own doc comment requires.
 */
export async function runScheduledTick(
  storage: StudioStorage, tick: () => Promise<void>, rearm: () => Promise<void>,
  deadlineFor?: (typeof STUDIO_TICKS)[number],
): Promise<void> {
  const deadlineMs = deadlineFor === undefined ? undefined : TICK_DEADLINES_MS[deadlineFor];
  if (await isStoppedIn(storage)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Issue #100 N5: a destroy in flight is not `stopped` yet (runDestroy
    // writes that only after destroy() resolves), and a tick's exec in that
    // window restarts the container being destroyed. Skip the BODY only: the
    // re-arm rule below is unchanged, so a destroy that FAILS keeps its loops.
    if (!destroyingMarkerFresh(await storage.get(DESTROYING_KEY), new Date())) {
      if (deadlineMs === undefined) {
        await tick();
      } else {
        // Issue #104: Container.alarm awaits each due callback and only
        // re-arms after, so a tick that never settles pins the alarm until the
        // platform's 900s kill. Stop waiting at the deadline; the tick keeps
        // running detached, and every exec inside it has its own kill.
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.error(`studio tick ${deadlineFor} exceeded its ${deadlineMs}ms deadline — re-arming without it`);
            resolve();
          }, deadlineMs);
        });
        await Promise.race([tick(), deadline]);
      }
    }
  } finally {
    clearTimeout(timer);
    if (!(await isStoppedIn(storage))) await rearm();
  }
}

/**
 * Issue #104: each tick's whole-body deadline. Container.alarm runs every
 * due callback in sequence inside ONE alarm invocation, so the budgets must
 * SUM below the platform's 900s alarm kill (705s here), not just each fit.
 *   shipTranscript 45s  two ship-class execs (20s each) + an R2 put, PLUS
 *                       (#367 round 3) the completion-record archive, which
 *                       now runs at the literal END of the tick's own work --
 *                       AFTER the ship exec, degraded-row recovery, activity,
 *                       member alerts, and the lastShipOkAt/reachability
 *                       write, never before any of them, so it can never
 *                       delay the work this deadline actually exists to
 *                       protect. It shares this same 45s budget but also
 *                       carries its own smaller ARCHIVE_DEADLINE_MS (15s)
 *                       cap on top, independent of this whole-tick deadline,
 *                       since its two GitHub API legs have no timeout of
 *                       their own otherwise. See runShipTickWithObservation's
 *                       own doc comment and ARCHIVE_DEADLINE_MS's own.
 *   refreshToken   60s  a GitHub mint + one refresh-class exec (30s).
 *   sweepMaestro  120s  board/GitHub reads + one wake (30s).
 *   syncSession   480s  tar + parts (120s each), failover, readiness (60s);
 *                       a heal it starts (bring-up, 600s) runs on detached.
 *                       Board #350 round 2, item 5: the install-cache save
 *                       step (curl --max-time 900) does NOT count against
 *                       this budget at all — syncSessionCycle fires it
 *                       last, unawaited, so it can never delay or starve
 *                       the failover/readiness/heal steps above it.
 */
export const TICK_DEADLINES_MS = {
  shipTranscript: 45_000,
  refreshToken: 60_000,
  sweepMaestro: 120_000,
  syncSession: 480_000,
} as const satisfies Record<(typeof STUDIO_TICKS)[number], number>;

/**
 * Issue #104: onStop's body. The containers library hands onStop the exit
 * code and reason and the SDK logs them only at debug, so a spontaneous exit
 * (~1-2/day measured) was invisible. Info-level log + the last stop persisted
 * for GET /studio/:id/status. Never throws: this runs inside the library's
 * own stop bookkeeping, which must finish regardless.
 */
export interface LastStopStorage {
  get(key: typeof LAST_STOP_KEY): Promise<LastStop | undefined>;
  put(key: typeof LAST_STOP_KEY, value: LastStop): Promise<void>;
}

export async function recordContainerStop(
  storage: Pick<LastStopStorage, "put">, id: string, params: { exitCode: number; reason: string }, now: Date,
): Promise<void> {
  const stop: LastStop = { exitCode: params.exitCode, reason: params.reason, at: now.toISOString() };
  console.log(`studio ${id}: container stopped — exit code ${stop.exitCode}, reason ${stop.reason}`);
  try {
    await storage.put(LAST_STOP_KEY, stop);
  } catch (err) {
    console.error(`studio ${id}: could not persist the container stop`, err);
  }
}

/** Issue #104: GET /studio/:id/status's answer — the status row plus the
 *  three things that explain a wedge from outside: the container's last
 *  stop, the heal marker and the operation lock. Heal reasons can quote
 *  container output, so they are scrubbed here like `error` is. */
export async function statusDetailWithStorage(
  storage: StudioStorage & Pick<LastStopStorage, "get">, idFallback: string, destroyCallsInFlight = false,
): Promise<
  StudioStatus & {
    lastStop: LastStop | null; healAttempt: HealAttempt | null; operationInFlight: OperationInFlight | null;
    destroyInFlight: boolean;
  }
> {
  const heal = (await storage.get(HEAL_ATTEMPT_KEY)) ?? null;
  const op = (await storage.get(OPERATION_KEY)) ?? null;
  return {
    ...(await getStatusWithStorage(storage, idFallback)),
    lastStop: (await storage.get(LAST_STOP_KEY)) ?? null,
    healAttempt: heal && { ...heal, reason: redactSecrets(heal.reason) },
    // A lock past OPERATION_STALE_MS is not in flight — decideHeal ignores it too.
    operationInFlight: op && destroyingMarkerFresh(op.since, new Date()) ? op : null,
    // Issue #86: a destroy call still running in this DO (its probe, sync and
    // rescue come before DESTROYING_KEY is written), or the marker itself.
    // `fleet reap` reads it to tell a raced destroy from a refusal.
    destroyInFlight: destroyCallsInFlight || destroyingMarkerFresh(await storage.get(DESTROYING_KEY), new Date()),
  };
}

/**
 * The studio container's own process environment — the same mechanism
 * AgentDO/DeployDO already use (`envVars`), and the ONLY way anything from
 * the Worker's secrets reaches a process inside the container. It is not
 * interchangeable with the per-exec env `sbExec` takes: that one is scoped to
 * a single command, while this is inherited by every process the container
 * ever starts, including the tmux SERVER — and container/studio-bringup.sh's
 * header depends on exactly that ("this script is the first thing to ever run
 * `tmux new-session`, so the tmux server's captured environment IS this
 * script's own environment; every pane tmux creates afterward inherits it").
 *
 * Task 12 found all three of these missing, by reading `tmux show-environment
 * -g` inside a real provisioned container: StudioDO declared no `envVars` at
 * all, so the container got none of them. Consequences, each real:
 *   - CLAUDE_CODE_OAUTH_TOKEN absent -> `claude` starts unauthenticated, so
 *     the studio cannot do anything at all. studio-bringup.sh's comment
 *     ("claude reads it straight from its process environment, the same
 *     assumption container/server.ts makes") was true of the ASSUMPTION but
 *     not of this image: server.ts's assumption holds only because AgentDO
 *     supplies the variable.
 *   - TS_AUTHKEY absent -> `tailscale up` is skipped on every bring-up, so no
 *     studio ever joins the tailnet and the iPhone/Moshi path cannot work.
 *   - STUDIO_ID absent -> bring-up falls back to `--hostname=studio`, so every
 *     studio in the fleet would claim the same tailnet hostname.
 *
 * Fleet Spawn P3, Task 1 added the fourth var: FLEET_SPAWN_TOKEN (R-P3-1's
 * per-studio spawn-auth token, org.ts's mintSpawnToken — "a studio proves
 * its identity via a per-studio spawn token minted at provision, stored in
 * DO + injected into container env, presented on the spawn call"). Unlike
 * the other three, this one has no `env.*` source — it's minted fresh, by
 * the caller, and passed in; see StudioDO.provision/restartStudio below for
 * why it's a parameter here rather than resolved inside this function.
 *
 * Fleet Spawn P3, Task 3 added the fifth: FLEET_WORKER_URL, straight from
 * `env.WORKER_PUBLIC_URL` (env.ts's own doc comment) — the address
 * `container/studio-fleet`'s `spawn` command POSTs `/fleet/spawn` to. Unlike
 * FLEET_SPAWN_TOKEN, this one IS a plain `env.*` passthrough (same shape as
 * CLAUDE_CODE_OAUTH_TOKEN above): one Worker, one public URL, no per-studio
 * minting needed.
 *
 * A pure function rather than an inline object literal for this file's usual
 * reason: a container-backed DO cannot be constructed under
 * vitest-pool-workers, so anything written directly as a class field is
 * untestable. See test/studio.refresh.test.ts for the coverage.
 */
function launchTokenFor(env: Env, studioId: string, claudeAccount: string | null | undefined): string {
  const launch = launchAccount(env, parseStudioId(studioId)?.repo ?? null, claudeAccount);
  return launch.ok ? launch.token : "";
}

/** Issue #289: the account NAME studioEnvVars' token belongs to -- what a
 *  container started from those env vars runs on. Null when the launch is
 *  refused (the start is refused too: accountRefusal). */
export function launchAccountName(env: Env, studioId: string, claudeAccount: string | null | undefined): string | null {
  const launch = launchAccount(env, parseStudioId(studioId)?.repo ?? null, claudeAccount);
  return launch.ok ? launch.name : null;
}

/** Issue #289: a container just started on `name` -- the row says so. The
 *  one writer of launchedAccount besides a completed failover switch.
 *  `undefined` (#292 r2): the account is not KNOWN -- the field is removed, so
 *  the column reads `?`, never a guess. Unchanged: no write. */
export async function recordLaunchedAccount(
  storage: StudioStorage, id: string, name: string | null | undefined, recordStudioFn: (status: StudioStatus) => Promise<void>,
): Promise<void> {
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  if (existing === null || existing.launchedAccount === name) return;
  const { launchedAccount: _dropped, ...rest } = existing;
  const updated: StudioStatus = name === undefined
    ? { ...rest, id: existing.id ?? id }
    : { ...existing, id: existing.id ?? id, launchedAccount: name };
  await storage.put(STATUS_KEY, updated);
  await recordStudioFn(updated);
}

/**
 * #292 r2: the StudioDO constructor's start config. A DO can restart while
 * its container keeps running, and onStart can then fire again: re-deriving
 * the account from TODAY's map would record the map, not what runs. So the
 * launch is READ BACK from the row (launchedAccount) -- that account's token,
 * that account's name. No record, or a recorded secret that is gone: today's
 * mapping for the token (a new start needs one), and the account UNKNOWN.
 */
export function constructorLaunch(
  env: Env, studioId: string, spawnToken: string, row: StudioStatus | undefined,
): { envVars: Record<string, string>; envAccount: string | undefined } {
  const recorded = typeof row?.launchedAccount === "string" ? row.launchedAccount : null;
  const on = recorded === null ? undefined : resolveClaudeAccounts(env).find((a) => a.name === recorded);
  if (on !== undefined) {
    return {
      envVars: { ...studioEnvVars(env, studioId, spawnToken, row?.claudeAccount ?? null), CLAUDE_CODE_OAUTH_TOKEN: on.token },
      envAccount: on.name,
    };
  }
  return { envVars: studioEnvVars(env, studioId, spawnToken, row?.claudeAccount ?? null), envAccount: undefined };
}

/**
 * Issue #102 — the fleet-wide read half of FailoverDeps.accountLimits: one
 * fleet_state row per configured account, read in parallel (at most
 * MAX_CLAUDE_ACCOUNTS, and only on a tick that already found a live limit
 * modal — see runAccountFailover's own call site). A row this studio's own
 * write never touched (another studio's sighting, or none at all) reads back
 * exactly the same as one this studio wrote itself; fleet-wide is the point.
 */
async function readFleetAccountLimits(db: D1Database, accounts: ClaudeAccount[]): Promise<AccountLimits> {
  const limits: AccountLimits = {};
  await Promise.all(accounts.map(async (a) => {
    const state = decodeAccountLimitState(await getFlag(db, accountLimitStateKey(a.name)));
    // Review round 1 (#102 review, 2026-09-30): `seenAt` rides along too, not
    // just `until` — accounts.ts's `isFree` needs it for a `null`-until
    // entry's staleness ceiling (NULL_UNTIL_CEILING_MS).
    if (state) limits[a.name] = { until: state.until, seenAt: state.seenAt };
  }));
  return limits;
}

/** Issue #102 — the fleet-wide write half: one fleet_state row, keyed by
 *  account NAME (never a studio id), so every studio's own next
 *  `readFleetAccountLimits` sees it. */
async function writeFleetAccountLimit(
  db: D1Database, name: string, until: string | null, seenAt: string,
): Promise<void> {
  await setFlag(db, accountLimitStateKey(name), encodeAccountLimitState({ until, seenAt }), Date.parse(seenAt));
}

/**
 * Issue #354: the DO's in-memory start config — the token the NEXT container
 * start boots (`envVars`) and the account onStart then records (`envAccount`)
 * — derived from ONE account name, so the two can never disagree. Every site
 * that sets them (provision, restart, recycle, and a completed failover
 * switch) assigns both from one call in one statement.
 */
export function launchFields(
  env: Env, studioId: string, spawnToken: string, name: string,
): { envVars: Record<string, string>; envAccount: string | undefined } {
  // envAccount is resolved exactly as studioEnvVars resolves the token
  // (launchAccount over the same inputs) — not `name` verbatim: with
  // auto-failover off, launchAccount serves the mapped primary whatever
  // `name` says, and the account recorded must be the one whose token boots.
  return {
    envVars: studioEnvVars(env, studioId, spawnToken, name),
    envAccount: launchAccountName(env, studioId, name) ?? undefined,
  };
}

/** Issue #271: what provision/restart/recycle throw for an unlaunchable
 *  account — after the row already says why. */
export class LaunchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchRefusedError";
  }
}

/**
 * Issue #271: the gate provision, restart and recycle pass before touching a
 * container. A repo mapped to an account whose secret is not set REFUSES:
 * the row goes `degraded` with the reason (the operator reads it in `fleet
 * ls`), then this throws — never a silent launch on another account, which would
 * starve the other repo. A launchable studio writes nothing.
 */
export async function launchAccountOrRefuse(
  env: Env, storage: StudioStorage, id: string, recordStudioFn: (status: StudioStatus) => Promise<void>,
): Promise<Extract<LaunchAccount, { ok: true }>> {
  const existing = (await storage.get(STATUS_KEY)) ?? null;
  const launch = launchAccount(env, parseStudioId(id)?.repo ?? null, existing?.claudeAccount ?? null);
  if (launch.ok) {
    // #273 r2: flag off, an earlier failover's recorded account is stale — this
    // launch is on the mapped one, so the row stops naming the old one.
    if (!autoFailoverOn(env) && existing?.claudeAccount != null) {
      const cleared: StudioStatus = { ...existing, claudeAccount: null };
      await storage.put(STATUS_KEY, cleared);
      await recordStudioFn(cleared);
    }
    return launch;
  }
  // #285: nothing launches, so no account name stays on the row -- not an
  // earlier failover's (unless failover is on: then it IS the next launch's
  // input) and not the previous launch's.
  const base = existing ?? {
    id, tailscaleHost: null, lastRefresh: null, lastRefreshError: null, burn: null,
    spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  };
  const refused: StudioStatus = {
    ...base,
    id, state: "degraded", error: launch.error, launchedAccount: null,
    ...(autoFailoverOn(env) ? {} : { claudeAccount: null }),
  };
  await storage.put(STATUS_KEY, refused);
  await recordStudioFn(refused);
  throw new LaunchRefusedError(launch.error);
}

export function studioEnvVars(
  env: Env, studioId: string, spawnToken: string, claudeAccount?: string | null,
): Record<string, string> {
  return {
    // Issue #53: the token of the account this studio is RECORDED on
    // (StudioStatus.claudeAccount), not unconditionally the first secret.
    //
    // This is the half of the failover that survives a recycle, and the reason
    // the manual fix an operator ran on 2026-09-23 could not: `claude` reads
    // this variable from its own process environment at startup and tmux
    // captures the server environment once, at `tmux new-session`, so a
    // studio's token is frozen when its container starts. An in-container
    // `/login` therefore lasted exactly until the next recycle rebuilt that
    // environment from here. A studio that failed over now comes back up on
    // the account it failed over TO.
    //
    // ONE variable reaches the container, always named CLAUDE_CODE_OAUTH_TOKEN
    // — `claude` reads that name and no other, and the container has no use
    // for the accounts it is not on. The alternates stay Worker-side, which is
    // also what keeps a second account's token out of a first account's
    // container. See accounts.ts for the whole list mechanism.
    //
    // Issue #271: which account is launchAccount's call — the repo's mapped
    // primary (CLAUDE_ACCOUNT_BY_REPO), or the recorded one when auto-failover
    // is on. A refused launch reads "" here; provision/restart/recycle refuse
    // it first (launchAccountOrRefuse), so no container is started on it.
    CLAUDE_CODE_OAUTH_TOKEN: launchTokenFor(env, studioId, claudeAccount),
    // Empty string, not omitted: the bring-up guard is `[ -z "${TS_AUTHKEY:-}" ]`,
    // which reads empty and unset identically, and `envVars` is typed as
    // string-valued. See Env.TS_AUTHKEY on why a placeholder would be worse
    // than nothing.
    TS_AUTHKEY: env.TS_AUTHKEY ?? "",
    STUDIO_ID: studioId,
    FLEET_SPAWN_TOKEN: spawnToken,
    FLEET_WORKER_URL: env.WORKER_PUBLIC_URL,
    // Issue #335: same "empty and unset identically" shape as TS_AUTHKEY
    // above — server.ts's own read treats "" as absent (falsy check, not
    // `??`) and falls back to its own neutral default.
    FLEET_BOT_NAME: env.FLEET_BOT_NAME ?? "",
    FLEET_BOT_EMAIL: env.FLEET_BOT_EMAIL ?? "",
  };
}

/**
 * DO storage key for the per-studio spawn-auth token (Fleet Spawn P3, Task
 * 1). Minted once — the first time a studio needs one — and static for its
 * whole lifetime (Task 6 ruling; the original "re-provision REMINTS" model
 * could not work, see ensureSpawnToken's own doc comment for why), so both
 * provision() and restartStudio() call the same ensureSpawnToken and reuse
 * whatever is already on file. Exported so a later task's /fleet/spawn
 * route can read it back out, the same way ROLE_ENV_KEY (provision.ts)
 * already works for the persisted role env.
 */
export const SPAWN_TOKEN_KEY = "spawnToken";

/** Minimal storage port for loadOrMintSpawnToken/ensureSpawnToken below —
 *  single-key-overload shape provision.ts's StudioStorage uses for
 *  STATUS_KEY/ROLE_ENV_KEY. A real `this.ctx.storage` satisfies this
 *  structurally with no cast (its `get`/`put` are generic; the existing
 *  StudioStorage usage elsewhere in this file already proves that pattern
 *  compiles), and a plain in-memory test fake needs no SDK import either. */
export interface SpawnTokenStorage {
  get(key: typeof SPAWN_TOKEN_KEY): Promise<string | undefined>;
  put(key: typeof SPAWN_TOKEN_KEY, value: string): Promise<void>;
}

/**
 * The studio's spawn token, read from DO storage — minted and persisted only
 * when there genuinely is none. Never overwrites one that exists.
 *
 * Storage ONLY: no status write, no registry write, nothing that needs `env`.
 * That narrowness is what lets StudioDO's constructor call it (see the
 * constructor's own comment): construction must be able to put the RIGHT
 * token into `this.envVars` before anything can start a container, and it
 * must do that without publishing a registry row for a studio nobody has
 * provisioned — a bare `GET /studio/<id>/status` on an unknown id constructs
 * a DO, and that must not make the id appear in `fleet ls`. Publishing is
 * ensureSpawnToken's job, and the only callers of THAT are the two paths
 * (provision, restart) that legitimately own a studio's lifecycle.
 */
export async function loadOrMintSpawnToken(storage: SpawnTokenStorage): Promise<string> {
  const existing = await storage.get(SPAWN_TOKEN_KEY);
  if (existing) return existing;
  const token = mintSpawnToken();
  await storage.put(SPAWN_TOKEN_KEY, token);
  return token;
}

/**
 * A studio's spawn identity, made sure of: the token in DO storage, and its
 * sha256 published to the studio's status AND the registry. Returns the token
 * for the caller to put in the container env.
 *
 * **Static per studio, NOT per provision (Task 6 ruling).** This used to be
 * `rotateSpawnToken`, and it reminted on every provision call — the documented
 * "re-provision REMINTS" model. That model cannot work, for a mechanical
 * reason: a container's environment is fixed when the container STARTS
 * (`envVars` is start config — see provision()'s own comment), so a remint
 * against a studio whose container is already up publishes a hash for a token
 * that container will never hold. Re-provisioning a healthy studio therefore
 * GUARANTEED a token/hash desync and broke that studio's spawns until its
 * container recycled. Reminting also bought nothing: rotation here has no
 * threat model behind it (org.ts's mintSpawnToken doc comment: "rotation =
 * churn without threat model; container compromise = token compromise either
 * way").
 *
 * So: mint once, keep forever. `container env == registry hash` now holds by
 * construction rather than by timing. **Rotation is an operator procedure**,
 * not a side effect of a routine call — delete SPAWN_TOKEN_KEY from the
 * studio's DO storage, recycle the container, provision. See
 * docs/superpowers/OPERATOR-FINISH-LIST.md §9.
 *
 * **Ordering invariant (review round 1, Important 3).** The writes are one
 * SHORT early sequence — no clone, no bring-up, no GitHub call inside it —
 * and the hash is deliberately NOT carried as a parameter into the
 * provisioning that follows. Do not move the registry write later, and do not
 * reintroduce the parameter: a slower provision finishing last would write
 * its own stale hash over a newer one while the container held the newer
 * token.
 *
 * **What this does NOT close.** Two provisions of a studio that has NEVER had
 * a token can still interleave inside the sequence (both see it absent, both
 * mint, and the token and the hash can end up from different mints). Now a
 * first-provision-only window rather than a re-provision one, since every
 * later call finds a token and mints nothing. The failure stays closed:
 * spawn.ts's resolveSpawnParent finds no row matching the container's token,
 * so /fleet/spawn answers 401 — never a wrong parent, never an escalation —
 * and it heals when an operator rotates as above. Closing it properly needs
 * single-flighting provision() itself, deliberately out of scope.
 *
 * The hash write is skipped only when the existing hash already MATCHES the
 * current token's — not merely when status carries A hash (final review
 * fix). On the ordinary path (provision/restart, token unchanged) this is
 * two reads, one hash, and nothing else. It republishes for a pre-P3
 * studio, one whose status predates the token, and now also for one whose
 * stored hash has gone STALE: the old code's bare presence check
 * (`existing?.spawnTokenHash` truthy) made the rotation procedure above
 * (delete SPAWN_TOKEN_KEY, recycle, provision) unable to heal — the fresh
 * mint saw the OLD hash still on status, returned early, and never
 * published the new one. The old (compromised) token kept authenticating;
 * the new one 401'd forever. Comparing instead of merely checking presence
 * fixes it: a stale hash is republished exactly like a missing one, so
 * rotation self-heals on the next provision or restart, with nothing to fix
 * by hand.
 *
 * Exported for the same reason every *WithStorage wrapper in this file is: a
 * container-backed DO cannot be constructed under vitest-pool-workers, so the
 * fake StudioDO stubs in test/ call this exact function rather than
 * re-implementing the sequence and drifting from it.
 *
 * This is the second place STATUS_KEY is written outside provision.ts's
 * wrappers — mirrorBurnToRegistry above is the first, for the same reason:
 * do.ts is this feature's composition root, and stamping one field onto the
 * status is not the wrappers' read/compute/write job.
 */
export async function ensureSpawnToken(
  storage: SpawnTokenStorage & StudioStorage,
  idFallback: string,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
): Promise<string> {
  const token = await loadOrMintSpawnToken(storage);
  const existing = await storage.get(STATUS_KEY);
  const tokenHash = await hashSpawnToken(token);
  if (existing?.spawnTokenHash === tokenHash) return token;
  const status: StudioStatus = {
    ...(existing ?? freshStatus(idFallback)),
    spawnTokenHash: tokenHash,
  };
  await storage.put(STATUS_KEY, status);
  await recordStudioFn(status);
  return token;
}

/**
 * Issue #85, maestro correction #1 — the single seam every `StudioStatus`
 * leaving a `StudioDO` passes through, whether it is headed to D1 (via
 * `recordStudio`) or straight back to an HTTP caller. `fleet ls` reads D1
 * only (`routes.ts`'s list handler never touches a DO) — without this at
 * EVERY write, D1 would show `observed: undefined` on every studio forever,
 * no matter how much of Tasks 3-7 landed. Always attaches SOMETHING
 * (`emptyObserved()` at worst) — a `StudioStatus` never leaves this DO with
 * `observed` silently unset because a caller forgot to read it. Never
 * mutates its input — every call site here already treats `StudioStatus` as
 * an immutable snapshot at the point it is written/returned.
 */
/**
 * Issue #221 (PR3a) — `getObserved` plus the DO's own, genuinely separate
 * `ACTIVITY_KEY` (activity.ts): `activity` never rides `OBSERVED_KEY`'s own
 * read-patch-write cycle (`mergeObserved`), so it is attached here, at the
 * ONE seam every outbound `Observed` already passes through. `storage` stays
 * typed `ObservedStorage` (never widened) — the `ACTIVITY_KEY` read is an
 * internal cast, the same "narrow port, cast at the one call site that needs
 * a second key" idiom `SightingStorage`/`MembersTickingStorage` (failover.ts)
 * already use, so no existing `ObservedStorage` test fake has to learn a key
 * only this feature touches.
 */
async function getObservedWithActivity(storage: ObservedStorage): Promise<Observed> {
  const [observed, activity, memberAlerts, restarts] = await Promise.all([
    getObserved(storage),
    (storage as unknown as ActivityStorage).get(ACTIVITY_KEY),
    // Issue #311 — same "own DO key, internal cast at the one call site
    // that needs it" idiom `ACTIVITY_KEY` (above) already uses.
    (storage as unknown as MemberAlertsStorage).get(MEMBER_ALERTS_KEY),
    // Issue #56 — same idiom again: the container-restart log (restarts.ts).
    (storage as unknown as RestartStorage).get(RESTARTS_KEY),
  ]);
  return { ...observed, activity: activity ?? null, memberAlerts: memberAlerts ?? null, ...(restarts === undefined ? {} : { restarts }) };
}

export async function withObserved(storage: ObservedStorage, status: StudioStatus): Promise<StudioStatus> {
  return { ...status, observed: await getObservedWithActivity(storage) };
}

/**
 * Issue #85 — pure decision table for one ship tick's incarnation section.
 * Maestro correction #3 fix, replacing the original (buggy, self-clearing)
 * version: NEVER nulls `before.incarnation` on a missing or foreign
 * reading — it is kept exactly as it was until an EQUAL token is seen
 * again, or a bring-up (Task 6) explicitly overwrites it. `replacedAt` is
 * stamped ONCE and never re-stamped while still set, so its age (rendered
 * by Task 8's `readyOverride`) always reflects the FIRST tick that noticed,
 * never the most recent one. No `needsAdoptionWrite` flag — the adoption
 * write is decided by the CALLER, before the exec runs, from
 * `before.incarnation === null` alone (maestro correction #6: folded into
 * the SAME exec, see `shipTickCmd`'s `adoptionToken` parameter), so by the
 * time this function runs `containerToken` already reflects the outcome of
 * that write attempt.
 */
export function incarnationPatch(before: Observed, containerToken: string, now: string): Partial<Observed> {
  const token = containerToken !== "" && isIncarnationToken(containerToken) ? containerToken : "";
  if (before.incarnation === null) {
    // Adoption territory. `token === ""` here means only that the SAME
    // exec's own conditional write attempt failed (or read back garbage) —
    // nothing to patch, retried next tick.
    return token === "" ? {} : { incarnation: token, replacedAt: null };
  }
  if (token === before.incarnation) {
    // The ONLY clearing path besides an explicit bring-up write.
    return before.replacedAt !== null ? { replacedAt: null } : {};
  }
  // Missing OR foreign: the DO's own token is KEPT. Stamp replacedAt once.
  return before.replacedAt !== null ? {} : { replacedAt: now };
}

/** Distinguishes a genuine "the container did not answer" from every other
 *  failure shape — maestro correction #5. */
export class ExecUnreachableError extends Error {}

/**
 * Maestro correction #5/#6 — wraps ONLY the exec call itself (both the main
 * tick exec and transcript.ts's own rotate exec go through this SAME
 * `deps.exec`, so both get the deadline individually) rather than the whole
 * `shipTranscriptTick` call. Only a genuine timeout, or `exec()`'s own
 * promise rejecting before producing any response at all (a transport
 * failure), counts. `ms` is a parameter, not a hardcoded constant — maestro
 * correction #14: tests inject a small value so 3 consecutive "timeouts" do
 * not cost 45s against vitest's default 20s per-test budget.
 *
 * Issue #85 review round 4, NIT 16(b) — MEASURED double-counting, fixed:
 * production used to default `ms` to `INSPECT_EXEC_MS` (15s, borrowed from
 * `fleet inspect`'s own unrelated budget), strictly SHORTER than the ship
 * exec's own already-established, already-merged per-exec deadline (#110's
 * `EXEC_CLASSES.ship`: a 20s in-container `timeout -k` kill, or a 20s +
 * `DEADLINE_SLACK_MS` Worker-side `ExecDeadlineError` if the container never
 * answers the exec call at all) — so a tick that was merely SLOW but ALIVE
 * (15-20s) got this race's own 15s timer firing FIRST, flagged unreachable,
 * even though the underlying exec was still genuinely in flight and would
 * have answered. `runShipTickWithObservation`'s own default is now looser
 * than #110's own total exec-level deadline, so THAT already-correct,
 * already-tested mechanism is what actually fires in production — this
 * race becomes a backstop for the (never expected in normal operation) case
 * where the underlying `exec()` itself never even arms its own deadline,
 * not the thing that decides "unreachable" on a merely-slow tick anymore.
 *
 * A killed-by-ITS-OWN-deadline RESOLVED response (#110's `isDeadlineExit` —
 * exit 124/137, the in-container `timeout -k` firing) is folded in here
 * too, for the SAME "killed is UNKNOWN, never a real answer" rule this
 * file's own `isDeadlineExit(res.code)` call elsewhere already applies —
 * otherwise a container that stays wedged long enough to actually GET
 * killed (now more likely to resolve, rather than reject, once this
 * race's own timer is looser than the in-container kill) would silently
 * stop being counted as unreachable at all. Every OTHER resolved response,
 * any other exit code, still proves the exec plane answered and is never
 * wrapped here.
 *
 * Issue #85 review round 5 — the cumulative-timing arithmetic this NIT 16(b)
 * fix never ran: `EXEC_CLASSES.ship.timeoutMs` (20_000ms) + `DEADLINE_SLACK_MS`
 * (`KILL_GRACE_SECONDS` 5s * 1000 + 2_000ms slack = 7_000ms) = 27_000ms —
 * #110's own total exec-level deadline this file's `SHIP_EXEC_DEADLINE_MS` is
 * built to stay looser than (27_000ms + this file's own 3_000ms margin =
 * 30_000ms; see the constant below). The ship tick reschedules itself only
 * AFTER its own body returns (`shipTranscript()`'s `runScheduledTick(...,
 * () => this.rearm("shipTranscript", SHIP_TRANSCRIPT_SECONDS), ...)`), so a
 * failing tick's own cycle length is (up to) its own exec deadline PLUS the
 * 30s `SHIP_TRANSCRIPT_SECONDS` reschedule wait, not the wait alone. Three
 * consecutive failures (this file's own `execFailures` threshold) at (27s to
 * 30s) + 30s each ⇒ 3 * 57s to 3 * 60s = 171s to 180s — the ~170-180s the
 * spec now states, not the spec's original ~90s (3 * 30s, counting only the
 * reschedule wait, before this NIT existed).
 *
 * Accepted 2026-09-24 (issue #85 review round 5) over shortening the
 * reschedule backoff, because a shorter backoff probes an already-wedged
 * container more often, and each new probe starts a fresh process inside a
 * container already at its memory ceiling — making the failure worse, not
 * better. Follow-up (NOT this PR): a time-based unreachable rule (>=2
 * consecutive failures AND >=90s since last successful ship) restores ~90s
 * detection with the same cadence and no extra probes; tracked separately by
 * the maestro.
 *
 * Issue #85 review round 6 — round 5's single ~170-180s POINT ESTIMATE was
 * itself incomplete: real-world measurement across three separate failure
 * scenarios put actual unreachable-detection latency at 89s / 120s / 141s,
 * PLUS a 0-30s phase this earlier arithmetic did not account for (where in
 * the alarm's own scheduling window the failing tick happens to land), and
 * container.alarm's own SERIAL execution of every due callback in one
 * invocation (see TICK_DEADLINES_MS's own doc comment) means a worst case
 * with other ticks queued ahead of shipTranscript can push this out to
 * roughly 5 MINUTES. The maestro RE-AFFIRMS decision (b) above with this
 * wider, measured range: the eventual ~90s goal (the same time-based rule
 * sketched in the paragraph above) is tracked separately as board issue
 * #183, not this PR.
 *
 * Board issue #183 (landed) — the 89s/120s/141s/5-minute figures above
 * describe the now-SUPERSEDED count-based `execFailures === 3` gate this
 * comment was originally written against. The RENDER side (`readyOverride`,
 * cli/readiness-format.ts) no longer uses a bare failure count either — it
 * now calls `isUnreachable` (observed.ts), the same time-based rule (>=2
 * consecutive failures AND >=90s since `Observed.lastShipOkAt`) this comment
 * sketched as the "eventual goal". `runShipTickWithObservation`'s own
 * out-of-cadence D1-write trigger (below) is a separate, simpler mandatory
 * checkpoint (`execFailures === 2`) rather than a call into `isUnreachable`
 * itself — see that checkpoint's own doc comment (review round 7) for why.
 * This function's OWN deadline math (SHIP_EXEC_DEADLINE_MS, looser than
 * #110's own exec-level deadline) is unchanged by that fix — it still
 * governs how long a single tick can take before THIS race decides the exec
 * plane itself never answered; only the RULE that turns a run of such
 * failures into "unreachable" changed.
 */
function withExecDeadline(exec: ShipDeps["exec"], ms: number): ShipDeps["exec"] {
  return async (cmd: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res: { code: number; stdout: string; stderr: string };
    try {
      res = await Promise.race([
        exec(cmd),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ExecUnreachableError(`exec did not answer within ${ms / 1000}s`)), ms);
        }),
      ]);
    } catch (err) {
      if (err instanceof ExecUnreachableError) throw err;
      throw new ExecUnreachableError(err instanceof Error ? err.message : String(err));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (isDeadlineExit(res.code)) {
      throw new ExecUnreachableError(`exec was killed by its own deadline (exit ${res.code})`);
    }
    return res;
  };
}

/** Issue #85 review round 4, NIT 16(b) — `runShipTickWithObservation`'s own
 *  production default: looser than #110's own already-established ship-class
 *  exec-level deadline (`EXEC_CLASSES.ship.timeoutMs + DEADLINE_SLACK_MS`,
 *  the real total time a ship-class exec can take before THAT mechanism
 *  itself gives up), plus a few seconds of margin so #110's own mechanism —
 *  not this file's own race — is what actually decides "unreachable" in
 *  normal operation. See `withExecDeadline`'s own doc comment for the full
 *  reasoning. */
export const SHIP_EXEC_DEADLINE_MS = EXEC_CLASSES.ship.timeoutMs + DEADLINE_SLACK_MS + 3_000;

/**
 * #367 round 3 (review HOLD fix, item 2) — the completion-record archive's
 * OWN deadline, separate from `TICK_DEADLINES_MS.shipTranscript`'s whole-tick
 * 45s budget. `archiveDoneRecords`'s in-container list exec already carries a
 * deadline (`shipDeps.exec`, wrapped with `SHIP_EXEC_DEADLINE_MS` by this
 * function below) — but its TWO GitHub API legs (`putOpsFile`/
 * `commentOnTask`) carry none at all. Without a cap here, a slow GitHub
 * response can run past the WHOLE tick's 45s deadline
 * (`runScheduledTick`'s own `Promise.race`, do.ts): that race stops AWAITING
 * the tick, but the archive call keeps running detached, and the NEXT
 * scheduled tick's own archive call (same studio, same
 * `DONE_RECORD_HASHES_KEY`) can then genuinely overlap it. A fixed cap well
 * under the 45s whole-tick budget — a third of it, the same "small fraction
 * of the caller's own budget" shape `CONTAINER_PROBE_MS` and
 * `SHIP_EXEC_DEADLINE_MS` already use relative to THEIR own callers — makes a
 * hung archive fail fast and log (`archiveDoneRecords` is already a "never
 * fatal to the tick" call, see its own call site below), rather than
 * silently outliving the tick that started it.
 */
export const ARCHIVE_DEADLINE_MS = 15_000;

/**
 * #367 round 3 (review HOLD fix, item 2) — same `Promise.race` + `finally
 * clearTimeout` shape as `withExecDeadline` above, generalized to any
 * promise rather than only `ShipDeps["exec"]`: `archiveDoneRecords`'s own
 * return value is `ArchiveResult`, not an exec result, so it cannot reuse
 * `withExecDeadline` itself. A timeout rejects with a plain `Error` (never
 * `ExecUnreachableError` — a slow GitHub call is not evidence the CONTAINER
 * is unreachable, the one thing that error type means elsewhere in this
 * file) so the caller's existing "log and continue" catch handles it exactly
 * like any other archive failure.
 */
function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => reject(new Error(`${label} did not finish within ${ms / 1000}s`)),
      ms,
    );
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Issue #221 (PR3a, Task 4) — the activity write, independent of every ship
 * tick outcome: its own DO storage key (ACTIVITY_KEY), never gated by
 * OPERATION_KEY the way STATUS_KEY's own read-exec-write cycle is. Two
 * carve-outs store NOTHING, matching the design's own state-table `—` row: a
 * stopped studio (no lead to read) and a studio with a FRESH operation lock
 * held (#86/#87 — a bring-up in flight has no lead either). The D1 mirror
 * (`recordStudioFn`) fires immediately only on a STATE change — the routine
 * 300s burn mirror (`mirrorBurnToRegistry`) already calls `recordStudioFn`
 * unconditionally every cycle regardless, via the SAME `withObserved` seam,
 * so `observedAt` rides that write for free with no extra write of its own.
 *
 * Issue #221 fix round 2, Fix 5 — factored out of the success path (it used
 * to be inlined there, gated on `result.paneVerdict !== undefined`) so
 * `runShipTickWithObservation`'s own catch block can call it too, with a
 * synthetic `{kind: "unknown", reason: "probe failed"}` verdict, THREADING a
 * real exec failure into this SAME write path instead of the tick's own
 * `throw err` skipping activity entirely (as it did before this fix — the
 * design's own `? probe failed` state was, until now, never producible for
 * real: only a test injecting it by hand ever put it in storage). The
 * caller decides the verdict; this function only ever decides whether it
 * gets written at all.
 *
 * Issue #221 (PR3b) — `hookHeartbeat` is the same tick's own
 * `SECTION_ACTIVITY_HOOK` read (`result.hookHeartbeat`, transcript.ts),
 * threaded straight into `nextActivity`'s freshest-wins merge alongside
 * `paneVerdict`. `undefined` (the catch-block's synthetic "probe failed"
 * call site, where no exec result exists at all) means exactly what it
 * means for `paneVerdict` there too: no evidence this tick, `nextActivity`
 * falls back to the pane axis alone, unchanged from PR3a.
 *
 * Issue #106 — `onStaleBackgroundShell` mirrors `onLeadWorking`'s own shape
 * just below it (an edge-triggered, rate-bound side effect keyed on a state
 * transition, factored into its own small helper — `staleShellNudge`,
 * matching `autoWorking`'s own shape exactly). The edge is computed from
 * `backgroundShellAgeMs`: THIS tick's age crosses `BACKGROUND_SHELL_STALE_MS`
 * while the PREVIOUS tick's age (computed the same way from `prevActivity`,
 * which is null on the very first tick) did not — never on every tick the
 * age merely stays stale, which would fire on every 30s tick indefinitely
 * without `staleShellNudge`'s own separate rate limit even having a chance
 * to matter for the FIRST nudge.
 */
async function applyActivityVerdict(
  deps: ShipDeps,
  storage: ObservedStorage & StudioStorage,
  recordStudioFn: ((status: StudioStatus) => Promise<void>) | undefined,
  paneVerdict: FrameVerdict,
  hookHeartbeat: HookHeartbeat | null | undefined,
  onLeadWorking?: () => Promise<void>,
  onStaleBackgroundShell?: () => Promise<void>,
): Promise<void> {
  const activityStatus = await storage.get(STATUS_KEY);
  const activityOpFresh = operationLockFresh(await storage.get(OPERATION_KEY), deps.now());
  const live = activityStatus?.state === "running" || activityStatus?.state === "degraded";
  if (!live || activityOpFresh) return;
  const activityStorage = storage as unknown as ActivityStorage;
  const membersTickingStorage = storage as unknown as { get(key: typeof MEMBERS_TICKING_KEY): Promise<string | undefined> };
  const prevActivity = (await activityStorage.get(ACTIVITY_KEY)) ?? null;
  const membersTickingAt = (await membersTickingStorage.get(MEMBERS_TICKING_KEY)) ?? null;
  const nextAct = nextActivity(
    prevActivity, paneVerdict, activityStatus?.rateLimited ?? null, membersTickingAt, deps.now(), hookHeartbeat,
  );
  await activityStorage.put(ACTIVITY_KEY, nextAct);
  if (prevActivity?.state !== nextAct.state && recordStudioFn) {
    const fresh = await storage.get(STATUS_KEY);
    if (fresh) await recordStudioFn(await withObserved(storage, fresh));
  }
  if (onLeadWorking && nextAct.state === "working" && prevActivity?.state !== "working") {
    await autoWorking(deps, storage as unknown as AutoWorkingStorage, onLeadWorking);
  }
  if (onStaleBackgroundShell) {
    const nextAge = backgroundShellAgeMs(nextAct, deps.now());
    // The previous tick's OWN age, as of the moment IT was observed —
    // `backgroundShellSince` carries forward UNCHANGED while the flavour
    // holds (activity.ts's own "holds while unchanged" doc comment), so
    // `prevActivity.backgroundShellSince` is frequently the exact SAME
    // timestamp `nextAct.backgroundShellSince` just carried forward too.
    // Measuring "the previous tick's age" against THIS tick's `deps.now()`
    // would therefore reproduce `nextAge` itself (same since, same now),
    // making `wasStale` always equal `nowStale` — the edge could then only
    // ever fire on the one tick right after the flavour first started
    // (`prevActivity` not yet carrying the flavour at all), never on the
    // real 15-minute crossing. Anchoring against `prevActivity.observedAt`
    // instead answers "how stale was it AS OF the last look", which is the
    // genuinely earlier reading an edge check needs.
    const prevAge = prevActivity ? backgroundShellAgeMs(prevActivity, new Date(prevActivity.observedAt)) : null;
    const nowStale = nextAge !== null && nextAge >= BACKGROUND_SHELL_STALE_MS;
    const wasStale = prevAge !== null && prevAge >= BACKGROUND_SHELL_STALE_MS;
    if (nowStale && !wasStale) {
      await staleShellNudge(deps, storage as unknown as StaleShellNudgeStorage, onStaleBackgroundShell);
    }
  }
}

/** Issue #86: DO key holding the last auto submitted->working attempt, ISO. */
export const AUTO_WORKING_KEY = "autoWorkingAt";
/** At most one board read per studio per this window: a lead enters
 *  `working` on every turn, and each attempt is a GitHub listing. */
export const AUTO_WORKING_EVERY_MS = 10 * 60_000;

type AutoWorkingStorage = {
  get(key: typeof AUTO_WORKING_KEY): Promise<string | undefined>;
  put(key: typeof AUTO_WORKING_KEY, value: string): Promise<void>;
};

/** Issue #86: the lead just started a turn. Leads never flip their own task
 *  to working, so the board read `submitted` while they worked. Rate-bound,
 *  and never fails the tick: a board hiccup waits for the next window. */
async function autoWorking(
  deps: ShipDeps, storage: AutoWorkingStorage, onLeadWorking: () => Promise<void>,
): Promise<void> {
  const last = Date.parse((await storage.get(AUTO_WORKING_KEY)) ?? "");
  if (Number.isFinite(last) && deps.now().getTime() - last < AUTO_WORKING_EVERY_MS) return;
  await storage.put(AUTO_WORKING_KEY, deps.now().toISOString());
  try {
    await onLeadWorking();
  } catch (err) {
    console.error("auto submitted->working failed, next window retries", err);
  }
}

/** Issue #106: DO key holding the last stale-background-shell nudge attempt, ISO. */
export const STALE_SHELL_NUDGE_KEY = "staleShellNudgeAt";
/** Same 15-minute budget as `BACKGROUND_SHELL_STALE_MS` itself (activity.ts)
 *  — a flapping tick that crosses the staleness edge more than once inside
 *  one window still gets at most one wake. */
export const STALE_SHELL_NUDGE_EVERY_MS = 15 * 60_000;

type StaleShellNudgeStorage = {
  get(key: typeof STALE_SHELL_NUDGE_KEY): Promise<string | undefined>;
  put(key: typeof STALE_SHELL_NUDGE_KEY, value: string): Promise<void>;
};

/** Issue #106: the lead's own turn is idle, but the footer/status line has
 *  shown a background-shell/monitor/task counter for `BACKGROUND_SHELL_
 *  STALE_MS` straight — long enough that it may simply be a dead job the
 *  lead forgot about (blueprint.ts's own "never block on nothing" house
 *  rule). Rate-bound the same shape `autoWorking` above already uses, and
 *  never fails the tick: a wake gate refusal (stopped, limit modal, etc.) or
 *  a transient failure just waits for the next crossing/window. */
async function staleShellNudge(
  deps: ShipDeps, storage: StaleShellNudgeStorage, onStaleBackgroundShell: () => Promise<void>,
): Promise<void> {
  const last = Date.parse((await storage.get(STALE_SHELL_NUDGE_KEY)) ?? "");
  if (Number.isFinite(last) && deps.now().getTime() - last < STALE_SHELL_NUDGE_EVERY_MS) return;
  await storage.put(STALE_SHELL_NUDGE_KEY, deps.now().toISOString());
  try {
    await onStaleBackgroundShell();
  } catch (err) {
    console.error("stale background-shell nudge failed, next window retries", err);
  }
}

/** Issue #106 — the nudge itself, typed into the lead's own pane via
 *  `wakeStudioWith` (StudioDO.shipTranscript's own real `onStaleBackgroundShell`
 *  callback). Addresses the lead as "you", same as this file's other wake
 *  prompts (see `deliverAssignedTaskOnBringup`'s own `assignDigest` pointer
 *  format), and names the exact house rule it is enforcing (blueprint.ts's
 *  "never block on nothing" — "never type into a limit modal" is the SAME
 *  refusal `runGatedWake`'s own limit-modal gate already gives this wake for
 *  free, stated here too so the lead's own next turn carries the same
 *  reminder). */
export const STALE_BACKGROUND_SHELL_NUDGE_PROMPT =
  "Background shell counter has been showing in the footer for 15+ minutes with your own turn idle. " +
  "Re-read its output (tail the log / check the Monitor) — rerun it or report what you found. " +
  "Never type into a limit modal.";

/**
 * Set equality on `kind`+`name` identity ONLY — used ONLY to decide whether
 * to fire the out-of-cadence D1 write below — the routine 300s burn-mirror
 * cadence covers the steady state regardless, the same "zero added writes in
 * steady state" property `applyActivityVerdict` already has.
 *
 * PR #336 round 2, item 1 (BLOCKER) — round 1 compared the whole `MemberAlert`
 * objects (`JSON.stringify`). `buildMemberAlerts` (member-alerts.ts) now
 * carries a `poll-loop` alert's `at` forward across ticks for the SAME name
 * (see that file's own fix), so `at` no longer changes tick to tick on its
 * own — but comparing whole objects was always the wrong test for "did the
 * SET OF THINGS WORTH TELLING SOMEONE change": `detail`'s own free text
 * (elapsed minutes, token counts) is EXPECTED to keep changing every tick for
 * a genuinely ongoing alert, and a D1 write on every one of those changes is
 * exactly the unbounded-write bug this fixes. What actually matters for "is
 * this worth an out-of-cadence write" is membership — did an alert APPEAR or
 * DISAPPEAR — not whether its supporting detail text drifted.
 */
function sameAlertSet(a: MemberAlert[], b: MemberAlert[]): boolean {
  if (a.length !== b.length) return false;
  const key = (x: MemberAlert) => `${x.kind}:${x.name}`;
  const setA = new Set(a.map(key));
  return b.every((x) => setA.has(key(x)));
}

/**
 * Issue #311 (PR3 addendum) — the member-alert write, independent of every
 * other ship-tick branch, same "own DO keys, unconditional every tick that
 * carries a pane frame" shape `applyActivityVerdict` (above) already uses,
 * including the SAME two carve-outs (a stopped studio has no panel to read;
 * a fresh operation lock means a bring-up owns this row right now).
 *
 * `paneFrame` is the SAME `SECTION_PANE` capture `applyActivityVerdict`'s
 * own `paneVerdict` was parsed from (no second parse of the base64 — see
 * `ShipResult.paneFrame`'s own doc comment, transcript.ts). `memguardKills`
 * is this tick's `SECTION_MEMGUARD` tail, already parsed
 * (`readShipTickMemguardKills`); an old-Worker-shaped tick that never had a
 * chance to populate it (should not happen in production — see
 * `ShipResult.memguardKills`'s own doc comment — but defended anyway)
 * degrades to "no kills this tick," never a crash.
 *
 * Observation-only (Principle 2, reaffirmed for #311 in the design
 * addendum): this function only ever WRITES what `buildMemberAlerts`
 * (member-alerts.ts, pure) computed. Nothing here kills, wakes, restarts or
 * recycles anything.
 */
async function applyMemberAlerts(
  deps: ShipDeps,
  storage: ObservedStorage & StudioStorage,
  recordStudioFn: ((status: StudioStatus) => Promise<void>) | undefined,
  paneFrame: string,
  memguardKills: MemguardKillLogEntry[],
): Promise<void> {
  const alertStatus = await storage.get(STATUS_KEY);
  const alertOpFresh = operationLockFresh(await storage.get(OPERATION_KEY), deps.now());
  const live = alertStatus?.state === "running" || alertStatus?.state === "degraded";
  if (!live || alertOpFresh) return;
  const memberStorage = storage as unknown as MemberAlertsStorage;
  const prevNames = (await memberStorage.get(MEMBER_ROWS_KEY)) ?? [];
  const prevAlerts = (await memberStorage.get(MEMBER_ALERTS_KEY)) ?? [];
  const currentRows = parseMemberRows(paneFrame);
  const nextAlerts = buildMemberAlerts(memguardKills, prevNames, currentRows, prevAlerts, deps.now());
  await memberStorage.put(MEMBER_ROWS_KEY, currentRows.map((r) => r.name));
  await memberStorage.put(MEMBER_ALERTS_KEY, nextAlerts);
  if (!sameAlertSet(prevAlerts, nextAlerts) && recordStudioFn) {
    const fresh = await storage.get(STATUS_KEY);
    if (fresh) await recordStudioFn(await withObserved(storage, fresh));
  }
}

/**
 * Issue #85 — one exported, directly testable function, called from
 * `StudioDO.shipTranscript()` the same way `mirrorBurnToRegistry` is called
 * from `syncSessionCycle`. `recordStudioFn`, when supplied, is used for an
 * IMMEDIATE, out-of-cadence D1 write on a `replaced`/`unreachable`
 * transition or an adoption (maestro correction #1) — the steady state
 * still rides the existing 300s burn-mirror cadence for zero added writes.
 * `deadlineMs` defaults to `SHIP_EXEC_DEADLINE_MS` (issue #85 review round 4,
 * NIT 16(b) — see `withExecDeadline`'s own doc comment for why); do.ts's real
 * wiring never overrides it, only tests do (maestro correction #14).
 *
 * `archive`, when supplied (#367): this tick ALSO calls archiveDoneRecords,
 * the SAME function/exec (doneRecordsListCmd) the pre-destroy teardown
 * (recycleWithSync/destroyWithSync) already runs — closing the "container
 * dies some way other than recycle/destroy" record-loss window from the
 * whole container lifetime down to one SHIP_TRANSCRIPT_SECONDS tick. Absent
 * means skip entirely, no completion-record exec at all — every caller that
 * never heard of it (every existing test, and any future one) keeps behaving
 * exactly as before this parameter existed. A failure here is logged and
 * never allowed to fail the tick itself, the same "never fatal" contract
 * archiveDoneRecords already gives its teardown caller.
 *
 * #367 round 2 (review HOLD fix, item 4): the archive call runs AFTER
 * `shipTranscriptTick` below, not before it. Round 1 ran it first, inside
 * this tick's own `shipDeps.exec` — meaning a completion-record archive
 * competed with the ship-exec's own time-sensitive work for the SAME
 * TICK_DEADLINES_MS.shipTranscript (45s) whole-tick budget (do.ts's own
 * budget-table comment), delaying the actual ship transcript on every tick
 * that had a record to archive. Moving it after means the ship exec always
 * gets first claim on that 45s budget; the archive still shares it, it
 * simply never runs ahead of the work the tick exists for. A tick that
 * THROWS out of `shipTranscriptTick` (the catch block immediately below)
 * skips the archive entirely for that tick — the exec plane not answering at
 * all means an archive attempt would not answer either, and the next tick
 * (or the teardown call site) picks up the same still-unarchived record.
 *
 * #367 round 3 (review HOLD fix, item 2): round 2's placement (right after
 * `shipTranscriptTick` succeeds) was STILL ahead of this tick's own
 * bookkeeping — issue #274's degraded-row recovery check, the activity
 * write, the member-alert write, and the final `lastShipOkAt`/reachability
 * merge all used to run AFTER the archive, meaning a slow archive could delay
 * every one of them on a tick that had a record to archive, the exact defect
 * round 2 had just fixed for the ship-exec itself. The archive call now runs
 * at the literal END of this function, immediately before BOTH of its
 * `return result` statements (the early-exit branch and the final one) —
 * nothing in this tick's own work follows it anymore. It is also given its
 * OWN, smaller deadline (`ARCHIVE_DEADLINE_MS`, via the local `runArchive`
 * closure below and `withDeadline`) independent of the whole-tick
 * `TICK_DEADLINES_MS.shipTranscript` budget: `archiveDoneRecords`'s two
 * GitHub API legs (`putOpsFile`/`commentOnTask`) carry no timeout of their
 * own, and without this a slow GitHub response could ride the archive call
 * past the WHOLE 45s tick deadline, at which point `runScheduledTick`'s own
 * race stops awaiting the tick while the archive keeps running detached — a
 * real hazard for the NEXT tick's own archive call to overlap it. See
 * `ARCHIVE_DEADLINE_MS`'s own doc comment for the full reasoning.
 */
export async function runShipTickWithObservation(
  deps: ShipDeps,
  storage: TranscriptStorage & ObservedStorage & StudioStorage,
  id: string,
  recordStudioFn?: (status: StudioStatus) => Promise<void>,
  deadlineMs: number = SHIP_EXEC_DEADLINE_MS,
  archive?: { doneRecords: DoneRecordPorts; resolveOpsRepo: ResolveMemoryRepo },
  onLeadWorking?: () => Promise<void>,
  onStaleBackgroundShell?: () => Promise<void>,
): Promise<ShipResult> {
  const observedBefore = await getObserved(storage);
  const adoptionToken = observedBefore.incarnation === null ? crypto.randomUUID() : undefined;
  const shipDeps: ShipDeps = { ...deps, exec: withExecDeadline(deps.exec, deadlineMs) };

  // #367 round 3 (review HOLD fix, item 2): factored into a closure so it can
  // run immediately before EVERY exit from this function below — the
  // early-exit branch (opFresh/incarnationChangedMidTick) and the final
  // return, not merely the first of the two — rather than duplicating the
  // try/catch/log by hand at each call site. Never invoked at all when
  // `shipTranscriptTick` throws (the catch block right below `throw err`s
  // out of this function entirely, same as round 2). Given its own
  // ARCHIVE_DEADLINE_MS deadline (`withDeadline`), separate from the whole
  // tick's TICK_DEADLINES_MS.shipTranscript budget — see this function's own
  // doc comment and ARCHIVE_DEADLINE_MS's for why.
  const runArchive = async (): Promise<void> => {
    if (!archive) return;
    try {
      // #367 round 2: same "real storage supports arbitrary keys
      // structurally" cast recycleWithSync's own identical call takes --
      // see that call site's doc comment.
      await withDeadline(
        archiveDoneRecords(
          { exec: shipDeps.exec, doneRecords: archive.doneRecords },
          storage as unknown as DoneRecordHashStorage, id, archive.resolveOpsRepo,
        ),
        ARCHIVE_DEADLINE_MS,
        `shipTranscript ${id}: completion-record archive`,
      );
    } catch (err) {
      console.error(`shipTranscript ${id}: tick completion-record archive failed, continuing`, err);
    }
  };

  let result: ShipResult;
  try {
    result = await shipTranscriptTick(shipDeps, storage, id, adoptionToken, observedBefore.session?.via ?? null);
  } catch (err) {
    if (err instanceof ExecUnreachableError) {
      // Review round 3 (issue #85 PR1), MUST-FIX 5 — same op-lock freshness
      // check the SUCCESS path below already has (maestro correction #4): a
      // fresh operation means a bring-up is still in flight and simply has
      // not answered this tick's own exec yet, which is not evidence the
      // container is unreachable. Without this, a ship tick racing a slow
      // (but real, in-progress) bring-up would count that bring-up's own
      // window as a reachability failure.
      const operation = await storage.get(OPERATION_KEY);
      const opFresh = operation != null
        && Number.isFinite(Date.parse(operation.since))
        && deps.now().getTime() - Date.parse(operation.since) < OPERATION_STALE_MS;
      if (!opFresh) {
        const failures = observedBefore.execFailures + 1;
        const patch: Partial<Observed> = { execFailures: failures };
        // Review round 3 (issue #85 PR1), MUST-FIX 7 — stamp the FIRST
        // failure of a new streak (0->1), not the 3rd: unreachableSince now
        // answers "since when has ANY failure streak been building", not
        // "since when did it cross the render threshold". That stamping
        // point is genuinely unchanged. What HAS changed (board issue #183):
        // the READY-column override's own render/crossing condition
        // (cli/readiness-format.ts's readyOverride) is no longer the bare
        // `execFailures >= 3` count — it's the new time-based `isUnreachable`
        // rule (execFailures >= 2 AND now - lastShipOkAt >= 90s, called a few
        // lines below). `failures === 1` fires exactly once per streak, the
        // same way the old `=== null` guard did.
        if (failures === 1) {
          patch.unreachableSince = deps.now().toISOString();
        }
        // Board issue #183 — the render-side gate (`readyOverride`,
        // cli/readiness-format.ts) now uses the time-based `isUnreachable`
        // rule (observed.ts): >=2 consecutive failures AND >=90s since
        // `lastShipOkAt`. The D1-write-trigger below lives HERE, not in
        // `isUnreachable` — see round 7's note a few lines down for why it
        // is a plain `failures === 2` checkpoint instead (read from
        // `observedBefore` — the last recorded success, measured from the
        // START of this tick, before any patch below is applied). Replaces
        // the old fixed `execFailures ===
        // 3` threshold (issue #85 PR1), which — composed with this tick's own
        // looser exec deadline and self-perpetuating reschedule — had drifted
        // detection out to 89-141s (review round 6, MUST-FIX 3 measurement),
        // far from the spec's original ~90s goal.
        //
        // "Crossed" (not merely "currently true") still matters: this is an
        // OUT-OF-CADENCE write, meant to fire once per streak, not on every
        // failed tick thereafter — the steady state still rides the existing
        // 300s D1 mirror.
        //
        // Board issue #183 review round 2, BLOCKER 1 — MEASURED, not
        // theoretical: a FAST-failing exec streak (e.g. #110's
        // SessionBusyError, which rejects near-instantly rather than hanging
        // the full deadline, or a hung exec resolved by #110's OWN tighter
        // underlying exec-level deadline rather than this file's looser
        // backstop) reaches execFailures===2 measurably BEFORE 90s has
        // elapsed — `isUnreachable` is still false at that exact instant, so
        // relying on its verdict alone would never fire here, and without a
        // forced write D1 stays stale (still showing the pre-failure healthy
        // state) until either the next tick or the 300s mirror — the exact
        // "fleet ls waits for the sync mirror" gap the review measured
        // (248-408s, main 120s). `failures === 2` is therefore a MANDATORY
        // checkpoint, forced regardless of what `isUnreachable` itself would
        // say at this instant, so D1 always carries a fresh, accurate
        // `lastShipOkAt`/`execFailures` pair the moment a streak is real
        // enough to matter — a LATER render check (readyOverride) can then
        // correctly compute `isUnreachable` against its OWN `now`, once
        // elapsed genuinely crosses 90s, without waiting on any further tick.
        //
        // Board issue #183 review round 7 (non-blocking finding): an earlier
        // version of this line ALSO OR'd in a transition-detection disjunct —
        // `isUnreachable` computed once with the pre-increment `execFailures`
        // and once with the post-increment count, firing on
        // `isUnreachableNow && !wasUnreachableBefore` — framed as a
        // "deliberate two-part composition". That disjunct was provably dead:
        // both calls read the SAME anchor at the SAME `deps.now()`, differing
        // only in `execFailures`, which `isUnreachable` consults ONLY through
        // its own `< 2` gate (observed.ts) — so for every reachable value of
        // `failures` (1, 2, or >=3) the disjunct was always either false or
        // exactly redundant with `failures === 2` alone. It added surface
        // area without adding coverage, so it's gone; the single checkpoint
        // below is complete by itself. This collapse depends on
        // `isUnreachable` staying gated purely on `execFailures < 2` — if
        // that gate ever grows additional conditions, re-examine whether a
        // separate transition check is needed here again.
        const crossedUnreachableThreshold = failures === 2;
        await mergeObserved(storage, patch);
        if (crossedUnreachableThreshold && recordStudioFn) {
          const status = await storage.get(STATUS_KEY);
          if (status) await recordStudioFn(await withObserved(storage, status));
        }
      }
    } else {
      // Maestro correction #5 — a resolved-but-bad response (nonzero exit,
      // a parse failure, an R2 put failure, a rotate failure) proves the
      // exec plane itself is alive; log it, never count it toward
      // reachability (an R2 blip must not show fleet-wide `unreachable`).
      console.error(`shipTranscript ${id}: tick failed (not counted toward reachability)`, err);
      // Board issue #183 review round 2, SHOULD-FIX 5 — "never count it
      // toward reachability" used to mean only "don't increment"; a prior
      // failure streak's `execFailures`/`unreachableSince` were left exactly
      // as they were, and `lastShipOkAt` was never touched here at all. That
      // silently understates recovery: an exec that answers (even with a bad
      // outcome downstream) is the SAME proof-of-life a clean success is —
      // see `lastShipOkAt`'s own doc comment (observed.ts) — so it must reset
      // the streak and advance the anchor exactly the way a clean success
      // does below, or a studio alternating real failures with merely
      // DEGRADED (but answered) ticks could still drift `now - lastShipOkAt`
      // past 90s and misreport unreachable despite the exec plane having
      // proven itself alive repeatedly in between.
      const respondedAt = deps.now().toISOString();
      const reachabilityPatch: Partial<Observed> = {
        lastShipOkAt: respondedAt,
        ...(observedBefore.execFailures > 0 || observedBefore.unreachableSince !== null
          ? { execFailures: 0, unreachableSince: null }
          : {}),
      };
      const clearsUnreachable = observedBefore.unreachableSince !== null;
      await mergeObserved(storage, reachabilityPatch);
      // Review round 3 (issue #85 PR1), MUST-FIX 6 precedent — clearing
      // `unreachable` is an out-of-cadence D1 transition, the same as it is
      // on the clean-success path below.
      if (clearsUnreachable && recordStudioFn) {
        const status = await storage.get(STATUS_KEY);
        if (status) await recordStudioFn(await withObserved(storage, status));
      }
    }
    // Issue #221 fix round 2, Fix 5 — BOTH branches above reach here on a
    // tick that never produced a usable pane read (a genuine "the exec never
    // answered" ExecUnreachableError, or a resolved-but-bad response that
    // never got as far as parsing SECTION_PANE at all): the design's own `?
    // probe failed` verdict (docs/superpowers/specs/2026-09-24-row-tells-
    // truth-design.md, "PR3 — activity states" state table) is a statement
    // about the PROBE, never about the studio, and belongs here regardless
    // of which branch produced the failure. Before this fix the `throw err`
    // below skipped activity entirely, leaving the DO's stored verdict
    // exactly as stale as it was before this tick — `? probe failed` was
    // real design, never real code, only ever reachable in a test that
    // injected it by hand.
    // Never lets a SECOND failure (storage down while recording the first
    // one) replace or swallow the original `err` this function is already
    // on its way to rethrowing — the same "must finish regardless" rule
    // `recordContainerStop`'s own doc comment states for onStop.
    try {
      const probeFailedVerdict: FrameVerdict = { kind: "unknown", reason: "probe failed" };
      // No exec result exists on this path at all (the exec itself never
      // answered) — no hook evidence either, same reasoning as the synthetic
      // pane verdict right above.
      await applyActivityVerdict(deps, storage, recordStudioFn, probeFailedVerdict, undefined);
    } catch (activityErr) {
      console.error(`shipTranscript ${id}: could not record "probe failed" activity, continuing`, activityErr);
    }
    throw err;
  }

  // Issue #274 — fast (30s) degraded-row recovery. Board issue #214's own
  // clear (runAccountFailover's `working` branch) previously ran ONLY on the
  // ~300s failover cadence: a lead that resumed on its own, or an operator
  // who dismissed its limit modal with a lone Esc, could sit behind a row
  // still reading `degraded | limit modal open` for up to five minutes.
  // MEASURED (see this feature's own test file, studio.failover-274.test.ts,
  // for both timelines): 2026-09-25 10:02Z dismissal, still `degraded` at
  // 10:03Z, not actually cleared until ~10:12Z under the OLD 300s-only path.
  //
  // The fix reuses #221's SAME SECTION_PANE frame `paneVerdict` above was
  // already read from (`result.paneFrame`, transcript.ts) to run the exact
  // same check runAccountFailover's own `working` branch performs —
  // failover.ts's extracted `evaluateDegradedRecovery` — on THIS 30s tick,
  // without waiting for the next runAccountFailover cycle. Zero added execs:
  // no second `capture-pane`, just the frame this tick already captured.
  //
  // Gated on `state === "degraded"` (a `running` row has nothing to heal —
  // `evaluateDegradedRecovery`'s own `parked` check would refuse it anyway,
  // this just narrows the read/write to the case that can change anything)
  // and on the SAME op-lock freshness rule the activity block just below
  // uses (#86/#87 — a bring-up in flight owns this row right now, and the
  // 300s path already yields to the identical lock).
  //
  // #239/#232's position-free live-limit veto (`anyLiveLimitLineOnScreen`) is
  // reused UNCHANGED inside `evaluateDegradedRecovery` — a genuinely
  // still-live limit block anywhere in the pane tail keeps the row degraded
  // here exactly as it does on the slower path.
  if (result.paneFrame !== undefined) {
    const degradedRowNow = await storage.get(STATUS_KEY);
    const recoveryOpFresh = operationLockFresh(await storage.get(OPERATION_KEY), deps.now());
    if (degradedRowNow?.state === "degraded" && !recoveryOpFresh) {
      const sightingStorage = storage as unknown as {
        get(key: typeof LIMIT_SIGHTING_KEY): Promise<LimitSighting | undefined>;
      };
      const sighting = (await sightingStorage.get(LIMIT_SIGHTING_KEY)) ?? null;
      const recoveryStudioId = degradedRowNow.id || id;
      const recovery = evaluateDegradedRecovery(degradedRowNow, recoveryStudioId, result.paneFrame, deps.now(), sighting);
      if (recovery.shouldHeal) {
        const clearedAt = deps.now().toISOString();
        const cleared: StudioStatus = {
          ...degradedRowNow, rateLimited: null, state: "running", error: null, exhaustionClearedAt: clearedAt,
        };
        await storage.put(STATUS_KEY, cleared);
        if (recordStudioFn) await recordStudioFn(await withObserved(storage, cleared));
      }
    }
  }

  // Issue #221 (PR3a, Task 4) — activity, independent of every branch above.
  // Issue #221 fix round 2, Fix 5 — factored out of the success path so the
  // catch block above can call it too, threading a real exec failure into
  // the SAME write path a successful probe uses (this file's own
  // `applyActivityVerdict`, above `runShipTickWithObservation`).
  if (result.paneVerdict !== undefined) {
    await applyActivityVerdict(
      deps, storage, recordStudioFn, result.paneVerdict, result.hookHeartbeat, onLeadWorking, onStaleBackgroundShell,
    );
  }

  // Issue #311 (PR3 addendum) — member alerts, same "independent of every
  // branch above" placement as activity, right beside it. Gated on
  // `paneFrame` (not `paneVerdict`) because `parseMemberRows` needs the raw
  // frame, not the lead-focused verdict; `memguardKills` defaults to `[]`
  // when absent (see `ShipResult.memguardKills`'s own doc comment — should
  // not happen in production, defended anyway).
  if (result.paneFrame !== undefined) {
    await applyMemberAlerts(deps, storage, recordStudioFn, result.paneFrame, result.memguardKills ?? []);
  }

  const now = deps.now().toISOString();

  // Maestro correction #4 — re-read AFTER the exec: a concurrent bring-up
  // (Task 6) can finish and write a NEWER truth while this tick's exec was
  // still in flight, and D1's own STATUS_KEY read during an operation is
  // separately, measurably stale (provision.ts's own OPERATION_KEY doc
  // comment) — a fresh operation lock means bring-up simply has not
  // finished writing its own token yet, which is not a real replacement.
  const operation = await storage.get(OPERATION_KEY);
  const opFresh = operation != null
    && Number.isFinite(Date.parse(operation.since))
    && deps.now().getTime() - Date.parse(operation.since) < OPERATION_STALE_MS;
  const observedNow = await getObserved(storage);
  const incarnationChangedMidTick = observedNow.incarnation !== observedBefore.incarnation;
  // Board issue #183 — `lastShipOkAt` updates on EVERY successful tick, not
  // merely one that clears a prior failure streak (see `Observed.
  // lastShipOkAt`'s own doc comment for why: the time-based unreachable rule
  // needs a genuine "since when has nothing come back" anchor, and only a
  // successful tick can ever advance it).
  //
  // Investigated before writing this (Step 1 of this task): does the ship
  // tick's own `shipTranscriptTick` (transcript.ts) already perform an
  // unconditional DO-storage write on every successful tick that this field
  // could ride for free, the same way `lastSnapshotAt` supposedly does? It
  // does — `shipTranscriptTick` unconditionally writes `TRANSCRIPT_TAIL_KEY`
  // every tick (the hot-tail preview, regardless of whether a chunk shipped
  // or a rotation happened) — but that write belongs to transcript.ts's OWN
  // narrow `TranscriptStorage` port, deliberately kept separate from this
  // file's `ObservedStorage` (see observed.ts's own header: "own file, own
  // keys, no widening" — the same discipline transcript.ts's own header
  // states for itself). Piggybacking `lastShipOkAt` onto that write would
  // mean widening `shipTranscriptTick`'s signature to accept `ObservedStorage`
  // too, which this feature's own architecture deliberately avoids.
  //
  // More importantly: the claimed precedent does not actually hold up.
  // `lastSnapshotAt` (this same file, `recordSnapshotOnSuccess`) does NOT
  // ride an existing write either — it issues its OWN separate
  // `mergeObserved(observedStorage, { lastSnapshotAt: now })` call, distinct
  // from whatever write `syncSessionTick` itself performs. So there is no
  // real "zero added writes" pattern to follow here; the honest choice,
  // matching what `lastSnapshotAt` ACTUALLY does (one extra `mergeObserved`
  // call on a successful tick), is to accept one additional small
  // DO-storage write every SHIP_TRANSCRIPT_SECONDS (30s) on success. The
  // ship tick already performs a real exec plus (usually) an R2 put every
  // 30s regardless — one more small field in this already-happening flow is
  // a negligible marginal cost, and it is the only way to get a genuine,
  // per-tick "last known good" timestamp.
  const reachabilityPatch: Partial<Observed> = {
    lastShipOkAt: now,
    ...(observedBefore.execFailures > 0 || observedBefore.unreachableSince !== null
      ? { execFailures: 0, unreachableSince: null }
      : {}),
  };
  // Review round 3 (issue #85 PR1), MUST-FIX 6 — clearing `unreachable` is a
  // D1 transition exactly like `replaced` set/clear or an adoption already
  // are (maestro correction #1): without an explicit write here, a
  // `fleet ls` row can read a stale `unreachable` for up to
  // SYNC_SESSION_SECONDS (300s) after the container has already answered
  // again.
  const clearsUnreachable = observedNow.unreachableSince !== null && reachabilityPatch.unreachableSince === null;

  if (opFresh || incarnationChangedMidTick) {
    // Skip replaced/unreachable/adoption entirely this tick — the exec
    // succeeded, so the container plainly answered; still safe (and
    // correct) to reset reachability, just never touch incarnation/replaced.
    if (Object.keys(reachabilityPatch).length > 0) await mergeObserved(storage, reachabilityPatch);
    if (clearsUnreachable && recordStudioFn) {
      const status = await storage.get(STATUS_KEY);
      if (status) await recordStudioFn(await withObserved(storage, status));
    }
    // #367 round 3 (review HOLD fix, item 2): the true end of this tick's own
    // work, immediately before this early-exit return — see runArchive's own
    // comment above and this function's doc comment for why.
    await runArchive();
    return result;
  }

  const incPatch = incarnationPatch(observedNow, result.incarnationToken, now);
  // Maestro correction #7 — on a genuine adoption (the DO had no token, and
  // this tick's incarnationPatch just set one), fold the SAME pane probe
  // shipTickCmd already issued into a session verdict of its own. Never
  // computed on any other tick — `result.adoptionProbe` is only ever set
  // when `shipTickCmd` was given an adoptionToken in the first place (see
  // transcript.ts's own doc comment).
  const isAdoption = observedNow.incarnation === null && "incarnation" in incPatch;
  let sessionPatch: Partial<Observed> = {};
  if (isAdoption && result.adoptionProbe) {
    const status = await storage.get(STATUS_KEY);
    const repo = status ? parseStudioId(status.id)?.repo ?? null : null;
    const expectedCwd = repo === null ? "" : `/workspace/${repo}`;
    const turnsBefore = status?.burn?.turns ?? 0;
    sessionPatch = { session: computeAdoptedVerdict(result.adoptionProbe, expectedCwd, turnsBefore, now) };
  }
  const combined = { ...reachabilityPatch, ...incPatch, ...sessionPatch };
  if (Object.keys(combined).length > 0) await mergeObserved(storage, combined);

  // Maestro correction #1 (+ review round 3 MUST-FIX 6) — the immediate-D1-
  // write transitions: a replaced set/clear, an adoption, or an unreachable
  // clear.
  const isTransition = "replacedAt" in incPatch || isAdoption || clearsUnreachable;
  if (isTransition && recordStudioFn) {
    const status = await storage.get(STATUS_KEY);
    if (status) await recordStudioFn(await withObserved(storage, status));
  }

  // #367 round 3 (review HOLD fix, item 2): the true end of this tick's own
  // work, immediately before the final return — see runArchive's own comment
  // above and this function's doc comment for why.
  await runArchive();
  return result;
}

/**
 * #330 round 4: the ops repo's read port for ProvisionDeps.fetchOpsFile. A
 * fresh token per call, scoped to `opsRepo` and narrowed to contents:read --
 * the same narrowing memoryToken uses. `mint`/`fetchFile` are injectable so a
 * test can pin the permissions asked for.
 */
export function opsFileFetcher(
  env: Env, opsRepo: string,
  mint: typeof mintRepoToken = mintRepoToken, fetchFile: typeof fetchRepoFile = fetchRepoFile,
): (path: string, ref: string) => Promise<string> {
  return async (path, ref) =>
    fetchFile(await mint(env, opsRepo, { permissions: { contents: "read" } }), opsRepo, path, ref);
}

export class StudioDO extends Sandbox<Env> {
  /** Issue #136: one wake in flight per studio — see singleFlightWake (wake.ts). */
  private wakeLock = { busy: false };

  /** See studioEnvVars above. `this.ctx`/`this.env` are both live here: a
   *  subclass field initializer runs after the base constructor returns.
   *  mintSpawnToken() is synchronous (crypto.getRandomValues, no `await`),
   *  which is what makes calling it from a field initializer possible at all.
   *
   *  This value is a placeholder with a lifetime of microseconds: the
   *  constructor below replaces it with the PERSISTED token before this DO
   *  can serve anything. It survives only if that storage read itself fails,
   *  which is why it is a real token shape rather than an empty string —
   *  bring-up must never see an unset variable. */
  envVars = studioEnvVars(this.env, this.ctx.id.name ?? "studio", mintSpawnToken());

  /**
   * Task 6 (ruling 2): load the STORED spawn token into `this.envVars` before
   * this DO can serve anything at all.
   *
   * The field initializer above cannot do it — it is synchronous and storage
   * is not — and until this constructor existed, that gap was reachable in
   * production: a DO that had been evicted and was then woken by one of its
   * own scheduled alarms (refreshToken / shipTranscript / syncSession) ran
   * its handler with the placeholder token in `envVars`, and those handlers
   * `exec` into the container. An exec STARTS a container, container start
   * config is fixed at start, and the placeholder is persisted nowhere — so
   * the studio came up holding a token that matched no registry row and every
   * one of its `/fleet/spawn` calls answered 401, permanently, without
   * provision() ever being involved.
   *
   * `blockConcurrencyWhile` is the DO idiom for exactly this: no request,
   * alarm or RPC is delivered until it resolves, so there is no interleaving
   * to reason about — every code path in this class can assume `envVars`
   * already carries the persisted token.
   *
   * Storage-only work (loadOrMintSpawnToken — see its own doc comment): a
   * registry write here would make a bare status read on an unknown id
   * materialise a studio row. Caught, because a throw inside
   * blockConcurrencyWhile tears the DO down: a transient storage failure must
   * degrade to the placeholder above (today's behaviour), not brick the
   * object. provision() calls ensureSpawnToken before it touches the
   * container either way, so a studio being provisioned still converges.
   */
  constructor(...args: ConstructorParameters<typeof Sandbox<Env>>) {
    super(...args);
    const [ctx, env] = args;
    ctx.blockConcurrencyWhile(async () => {
      try {
        const token = await loadOrMintSpawnToken(ctx.storage);
        // Issue #53: the account this studio last failed over to, for exactly
        // the reason the spawn token is loaded here — an alarm-woken DO's
        // first exec STARTS the container, and container start config is
        // fixed at start. A studio that had moved to a second account and was
        // then woken by an alarm would otherwise come back up on the
        // exhausted first one.
        //
        // #292 r2: read the LAUNCH back (constructorLaunch) -- a DO restart
        // under a running container must not re-derive it from today's map.
        const launched = constructorLaunch(env, ctx.id.name ?? "studio", token, await ctx.storage.get<StudioStatus>(STATUS_KEY));
        this.envVars = launched.envVars;
        this.envAccount = launched.envAccount;
      } catch (err) {
        console.error("studio: could not load the persisted spawn token at construction", err);
      }
    });
  }

  private bridge: TerminalBridge | null = null;
  /** Issue #289: the account `envVars`' token belongs to, set beside it;
   *  undefined when not known (#292 r2 -- onStart then records `?`). */
  private envAccount: string | undefined = undefined;

  /**
   * `fetch` is the base class's (it fronts every container proxy call,
   * including the pty upgrade this bridge itself makes), so it is
   * intercepted for exactly one path and delegated otherwise. #151: NO
   * webSocketMessage/Close/Error here — the bridge accepts and listens to
   * its viewers itself (terminal.ts header). Hibernation dispatch silently
   * dropped joiners in production on 2026-09-24.
   */
  private terminal(): TerminalBridge {
    this.bridge ??= new TerminalBridge((opts) => sbAttachPty(this, opts));
    return this.bridge;
  }

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === TERMINAL_PATH) {
      // Issue #123: a surviving `fleet attach` reconnected here after a
      // destroy and the pty open booted a new container. Refused before the
      // upgrade check, so a plain GET is the CLI's refusal probe.
      const refusal = await startRefusal(this.ctx.storage, this.selfId(), new Date(), await this.explicitStartAllowed())
        ?? (this.ctx.container?.running ? null : await this.accountRefusal());
      if (refusal !== null) return startRefusedResponse(refusal);
      return this.terminal().attach(req);
    }
    return super.fetch(req);
  }

  /**
   * Issue #152: replaces the old bare `startsAllowed` counter. A counter
   * cannot tell an op that is still genuinely in flight apart from one whose
   * own destroy epoch has since moved out from under it — both looked
   * identical as "startsAllowed > 0". A Set of the operations' own ctx
   * objects can: each entry carries the epoch IT snapshotted, so "explicit
   * start allowed" becomes "does any CURRENTLY LIVE operation's own epoch
   * still match the epoch on file right now" — see explicitStartAllowed()
   * below. A Set, not one shared field, because concurrent ops (provision
   * racing a restart, or recycle's own nested provisionCore reusing its
   * caller's ctx) must never clobber each other's entry.
   */
  private activeOps = new Set<OpCtx>();

  /**
   * Round 3 review, fix 4 (verifier sims T7k/T7kp) — "the kill window". The
   * epoch counter alone cannot close this gap: destroy bumps the epoch
   * (bump 1), then some OTHER op snapshots ITS OWN ctx epoch AFTER that
   * bump — from that op's own perspective its epoch IS the current one,
   * `explicitStartAllowed` would correctly say yes for it PURELY BY EPOCH
   * AGREEMENT, and it starts a container — all while the destroy that just
   * bumped the epoch is still PHYSICALLY in the middle of killing the
   * container (between bump 1 and its own eventual stopped-row write / bump
   * 2). This is not about which epoch value an op saw; it is about a destroy
   * being in progress AT ALL, regardless of epoch. Deliberately in-memory
   * only, NEVER written to DO storage: a `DESTROYING_KEY` marker left behind
   * by a destroy that died mid-flight in a PREVIOUS isolate (the orphan-
   * marker case, T8's own recovery coverage) must keep working exactly as
   * before in a FRESH isolate that never set this flag — this field only
   * ever gets incremented by THIS SAME isolate's own live `destroyStudio`
   * call(s) (below), never inherited from storage.
   *
   * Issue #240 (a #174 follow-up): a COUNTER, not a bare boolean. With TWO
   * overlapping `destroyStudio()` calls in the same isolate (rare, but
   * possible — nothing prevents a second `fleet destroy` from landing while
   * the first is still mid-`runDestroy`), a boolean's own `finally` broke: the
   * SECOND call's `finally` set it back to `false` the instant IT finished,
   * even though the FIRST was still physically mid-kill — reopening this
   * exact kill window for a concurrent restart to slip through while a
   * destroy was still genuinely in progress. Incremented before each call's
   * own `runDestroy`, decremented (never below 0) in each call's own
   * `finally` — `explicitStartAllowed()` below stays closed
   * (`destroyInFlightCount > 0`) until EVERY overlapping destroy in this
   * isolate has genuinely finished, not just the most recent one to start.
   *
   * Issue #240 fix F — the hung-`runDestroy` bound: if `runDestroy` never
   * settles (an isolate wedged mid-destroy, never reaching its own `finally`),
   * this counter stays stuck above 0 forever, and `explicitStartAllowed()`
   * stays `false` for as long as this isolate lives. That does NOT block
   * starts forever in the COMMON case, though: `explicitStartAllowed()` only
   * feeds the `explicit` argument to `startRefusal` (do.ts) — when `explicit`
   * is `false`, `startRefusal` falls through to the PERSISTED `DESTROYING_KEY`
   * marker's own freshness (`destroyingMarkerFresh`, provision.ts), bounded by
   * `OPERATION_STALE_MS` (15 min) entirely independently of this in-memory
   * counter's own value. Past that bound the marker reads stale and
   * `startRefusal` falls through again, to `STATUS_KEY`'s own last-recorded
   * `state` — which a hang occurring BEFORE `runDestroy`'s own stopped-row
   * write left un-rewritten, so a start is correctly allowed again. Verified
   * directly (not just traced) — see
   * `test/studio.destroy-race.test.ts`'s "issue #240 fix F" suite.
   *
   * Round 2 correction (this round's own reviewer): the 15-minute bound above
   * only actually covers a hang that happens BEFORE `destroy.ts`'s stopped-row
   * `STATUS_KEY` write. A hang in the POST-stopped tail — specifically the D1
   * publish right after that write (`destroy.ts`'s `await recordStudioFn(status)`)
   * — is a KNOWN LIMITATION, not bounded at all: `DESTROYING_KEY` still goes
   * stale after 15 minutes as usual, but `STATUS_KEY` already reads "stopped"
   * (written just before the hang), so `startRefusal`'s own fallthrough-to-
   * state-check path ALSO refuses (correctly, for a non-explicit start against
   * a genuinely-stopped row) — and `explicitStartAllowed()` still returns
   * `false` forever in this isolate (the counter never clears, since
   * `runDestroy` never reached its own `finally` either). An EXPLICIT
   * `provision()`/`ff` attempt is refused with no recovery path in this one
   * isolate, for its entire life — not just for 15 minutes. Documented, not
   * fixed: a D1 write is not expected to hang indefinitely in practice,
   * and adding a timeout mechanism for it is out of scope here — see this
   * round's own PR body for the full reasoning.
   */
  private destroyInFlightCount = 0;

  private async allowingStart<T>(op: (ctx: OpCtx) => Promise<T>): Promise<T> {
    const ctx = await createOpCtx(this.ctx.storage);
    this.activeOps.add(ctx);
    try {
      return await op(ctx);
    } finally {
      this.activeOps.delete(ctx);
    }
  }

  /**
   * Issue #152: "explicit start allowed" — true iff some op currently in
   * flight in THIS isolate (activeOps) snapshotted the epoch that is still
   * the one on file. A ctx whose own epoch has fallen behind the live one (a
   * destroy landed since that op began) no longer counts — its own operation
   * is aborting, not starting a container.
   *
   * Round 3 review, fix 4: checked FIRST, ahead of the epoch comparison —
   * see `destroyInFlightCount`'s own doc comment for why an in-progress
   * destroy in THIS isolate must refuse every explicit start regardless of
   * what any ctx's own epoch says, and (issue #240) why a COUNTER rather than
   * a boolean is what closes this for good under overlapping destroys.
   */
  private async explicitStartAllowed(): Promise<boolean> {
    if (this.destroyInFlightCount > 0) return false;
    if (this.activeOps.size === 0) return false;
    const live = await readDestroyEpoch(this.ctx.storage);
    for (const ctx of this.activeOps) {
      if (ctx.epoch === live) return true;
    }
    return false;
  }

  /** A container already running is not a start: never refused. */
  private async refuseStart(): Promise<string | null> {
    if (this.ctx.container?.running) return null;
    return (await startRefusal(this.ctx.storage, this.selfId(), new Date(), await this.explicitStartAllowed()))
      ?? await this.accountRefusal();
  }

  /**
   * #273 r2: an alarm-woken exec (or attach) must not boot a container whose
   * repo is mapped to an unset account — studioEnvVars would hand it token "",
   * a billed container with no credentials. The row already carries the
   * reason from launchAccountOrRefuse; this refuses the start the same way.
   */
  private async accountRefusal(): Promise<string | null> {
    const launch = launchAccount(this.env, parseStudioId(this.selfId())?.repo ?? null, await this.claudeAccountName());
    return launch.ok ? null : launch.error;
  }

  /**
   * Issue #123: the one door the SDK's HTTP transport uses for every exec,
   * writeFile and session call (its stub is this DO). Sandbox.containerFetch
   * would start the container, and turns a start failure into a 503 the
   * transport retries — so the refusal is answered here, as a 409.
   */
  async containerFetch(
    requestOrUrl: Request | string | URL, portOrInit?: number | RequestInit, portParam?: number,
  ): Promise<Response> {
    const refusal = await this.refuseStart();
    if (refusal !== null) return startRefusedResponse(refusal);
    return super.containerFetch(requestOrUrl, portOrInit, portParam);
  }

  /** Issue #123: every start path in the SDK passes through one of these two
   *  (containerFetch, startContainerForRPC and sbAwaitReady call the first). */
  async startAndWaitForPorts(...args: Parameters<Sandbox<Env>["startAndWaitForPorts"]>): Promise<void> {
    const refusal = await this.refuseStart();
    if (refusal !== null) throw new StartRefusedError(refusal);
    return super.startAndWaitForPorts(...args);
  }

  async start(...args: Parameters<Sandbox<Env>["start"]>): Promise<void> {
    const refusal = await this.refuseStart();
    if (refusal !== null) throw new StartRefusedError(refusal);
    return super.start(...args);
  }

  /**
   * Task 11: `fetchBlueprintFile` resolves ONE credential per repo OWNER,
   * lazily, on its first call within this `deps()` instance's lifetime — then
   * reuses it for every subsequent blueprint fetch of that owner's repos in
   * the SAME provision() call (fleet.json, role file, org.json — up to 3
   * fetches). mintInstallationToken's own doc comment (github/app.ts) says
   * "fresh every call, deliberately uncached" for its ORIGINAL use (handed to
   * a container, or spent on a single merge) — that reasoning doesn't extend
   * to 3 back-to-back internal fetches milliseconds apart within one provision
   * cycle, where minting 3x would just be 2 wasted GitHub API round trips
   * (JWT-signing cost included) for no added security margin. Nothing is
   * stored beyond this closure and nothing is reused across separate
   * provision() calls (a fresh `deps()`, and a fresh minter, every time).
   *
   * P6a: keyed by OWNER, not one shared promise. The fleet repo and a work
   * repo can belong to different owners running on different providers, and
   * one owner's credential must never be served for another's repo.
   */
  private deps(): ProvisionDeps {
    const mint = repoTokenMinter(this.env);
    // FLEET_OPS_REPO, resolved once (#330 round 4): memory and the house-rules
    // overlay both live in this one private repo (src/ops-repo.ts).
    const opsRepo = resolveOpsRepo(this.env);
    return {
      sbExec: (cmd: string, env?: Record<string, string>) => sbExec(this, cmd, { ...EXEC_CLASSES.provision, env }),
      recordStudio: async (status: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, status)),
      now: () => new Date().toISOString(),
      fetchBlueprintFile: async (repo: string, path: string, ref: string) =>
        fetchRepoFile(await mint(repo), repo, path, ref),
      // Issue #341: the memory store and a token that reads it (usually
      // private) -- one owner-scoped mint, same minter as blueprint files.
      memoryRepo: opsRepo,
      // #346 (on #339): scoped to the ops repo AND narrowed to read -- this
      // token rides into the container (exec env of the clone).
      memoryToken: async (workRepoSlug: string) => {
        if (opsRepo === null) throw new Error("FLEET_OPS_REPO is unset -- no memory token to mint");
        // Issue #7: never the write PAT on a PAT fleet (write-proxy/mode.ts).
        // The work repo comes from provision: on a first provision the row
        // has none yet, and reading it would fall back to AGENT_REPO.
        const token = await containerToken(this.env, workRepoSlug, opsRepo, { contents: "read" });
        if (token === null) throw new Error("no read-only token for the ops repo -- set GITHUB_READ_TOKEN");
        return token;
      },
      // Issue #330: the operator's house-rules overlay, from the same ops
      // repo -- through its OWN port, a token scoped to that repo and
      // narrowed to contents:read (round 4), never the blueprint minter above.
      opsRepo,
      // Task 7: FLEET_JUNIOR/JUNIOR_REPOS, checked against the WORK repo
      // slug resolveBringupEnv passes in — never the fleet/blueprint repo.
      juniorEnabled: (slug: string) => juniorEnabled(this.env, slug),
      ...(opsRepo === null ? {} : { fetchOpsFile: opsFileFetcher(this.env, opsRepo) }),
      // Task 3 (P2 plane 2): the fresh-container restore step's R2 read —
      // see provision.ts's runSessionRestore and ProvisionDeps.r2Get's own
      // doc comment for why this is optional on the type but always
      // supplied here.
      r2Get: async (key: string) => {
        const obj = await this.env.STUDIO_ARCHIVE.get(key);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      },
      // Review round 3 (issue #85 PR1), MUST-FIX 8(b) — ProvisionDeps.r2Head
      // was declared on the type (Task 6) but never actually wired here, so
      // recordBringupObservation's own R2-uploaded-timestamp fallback (when
      // `lastSnapshotAt` was never recorded yet) could never fire in
      // production. Wrapped in try/catch: an R2 error here must degrade to
      // "age unknown" (the caller's own `if (head)` guard), never throw into
      // a bring-up — the exact same posture every other R2-touching port on
      // this file's deps() already takes implicitly by being awaited inside
      // provision.ts's own try/catch scaffolding, made explicit here since
      // this one has no such wrapper upstream of it.
      r2Head: async (key: string) => {
        try {
          const obj = await this.env.STUDIO_ARCHIVE.head(key);
          return obj ? { uploaded: obj.uploaded } : null;
        } catch (err) {
          console.error(`studio ${this.selfId()}: r2Head(${key}) failed, continuing`, err instanceof Error ? err.message : String(err));
          return null;
        }
      },
      // Issue #85 review round 4, NIT 16(a) — recordBringupObservation's
      // combined token-write + pane-probe exec: a short, cheap check, never
      // the bring-up itself, so it gets its own session/deadline rather than
      // riding `sbExec`'s EXEC_CLASSES.provision (600s, sized for BRINGUP_CMD).
      observationExec: (cmd: string) => sbExec(this, cmd, EXEC_CLASSES.inspect),
      // Issue #94: lists daily keepers for runSessionRestore's fallback.
      r2List: async (prefix: string) => {
        const listed = await this.env.STUDIO_ARCHIVE.list({ prefix });
        return listed.objects.map((o) => o.key);
      },
      // Issue #94: the restored snapshot becomes the sync guard's baseline.
      // Board #140 (HOLD fix): a restore is itself a fresh, deliberate
      // baseline-setting event — cancel any pending force-upload override
      // unconditionally (delete is a harmless no-op when nothing is armed)
      // so an override armed before this restore can never survive to
      // force-upload the very next ORDINARY sync tick with zero comparison,
      // which an operator who ran clear-session-guard and separately
      // triggered a restore would not expect.
      recordRestoredMark: async (mark: SessionMark | null) => {
        if (mark) await this.ctx.storage.put(SESSION_MARK_KEY, mark);
        else await this.ctx.storage.delete(SESSION_MARK_KEY);
        await this.ctx.storage.delete(SESSION_FORCE_KEY);
      },
      writeFile: (path: string, bytes: Uint8Array) => sbWriteFile(this, path, bytes),
      // Fleet Spawn P3, Task 4 (R-P3-6): see provision()'s own doc comment
      // above for why this replaced the old unconditional call at the top of
      // that method, and ProvisionDeps.setKeepAlive's doc comment (provision.ts)
      // for why it lives on this port at all rather than being called inline
      // here.
      setKeepAlive: (keepAlive: boolean) => sbSetKeepAlive(this, keepAlive),
      // Fleet board task #118: the adopted-task fallback resolveBringupEnv
      // reaches for when a caller supplied no cfg.briefPrompt (recycle, a
      // bodyless re-provision) — see ProvisionDeps.resolveAssignedBrief's own
      // doc comment (provision.ts) for why this port exists at all.
      resolveAssignedBrief: assignedBriefResolver(this.env),
      // Board task #149: mint + write the blueprint clone's own credential —
      // see blueprintCredentialWriteCmd's own doc comment (above) for the
      // mechanism, and ProvisionDeps.writeBlueprintCredential's (provision.ts)
      // for why this port exists at all. A fresh mint against `blueprintRepo`
      // specifically (never `workRepoSlug`) — this must never widen to any
      // repo beyond the blueprint one it is handed.
      //
      // Issue #331: also narrowed to `permissions: {contents: "read"}` — the
      // blueprint clone only ever needs to be READ (fleet.json, a role file,
      // org.json), never pushed to, so the mint itself is denied write from
      // the start rather than merely being scoped to the right repo.
      writeBlueprintCredential: async (blueprintRepo: string, _id: string, workRepoSlug: string) => {
        try {
          // Issue #7: never the write PAT on a PAT fleet (write-proxy/mode.ts);
          // work repo from provision, as memoryToken above.
          const token = await containerToken(this.env, workRepoSlug, blueprintRepo, { contents: "read" });
          if (token === null) {
            return { ok: false as const, error: "no read-only token for the blueprint repo -- set GITHUB_READ_TOKEN (a public blueprint still clones anonymously)" };
          }
          const res = await sbExec(this, blueprintCredentialWriteCmd(blueprintRepo), { ...EXEC_CLASSES.provision, env: tokenEnv(token) });
          if (res.code !== 0) {
            throw new Error(`blueprint credential write failed (${res.code}): ${res.stderr.slice(0, 500)}`);
          }
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, error: redactSecrets(err instanceof Error ? err.message : String(err)) };
        }
      },
      // Issue #253: push.default/branch.autoSetupMerge + the
      // /usr/local/bin/git wrapper that refuses a push at the remote's
      // default branch — see credentials.ts's studioGitSafetyCmd for the
      // mechanism (and why it is not a git hook), and
      // ProvisionDeps.applyStudioGitSafety's (provision.ts) for why this
      // port exists. No token, no mint — a plain sbExec, unlike the
      // credential ports above. The body lives in applyStudioGitSafetyPort
      // (just below this class) so a test can reach it at all.
      applyStudioGitSafety: () =>
        applyStudioGitSafetyPort((cmd) => sbExec(this, cmd, EXEC_CLASSES.provision)),
      // Issue #1: leak scanner + gh wrapper, and the work repo's visibility
      // (private = gate off). See provision.ts's applyLeakGate.
      installLeakGate: () =>
        installLeakGatePort((cmd) => sbExec(this, cmd, EXEC_CLASSES.provision)),
      workRepoIsPrivate: async (slug: string) => repoIsPrivate(await mint(slug), slug),
      // Issue #30: discovery reads the same remote rescue writes to.
      rescueTarget: (slug: string) => this.rescueTarget(async () => slug, "discovery"),
      // Issue #7: same visibility answer drives the push/gh routing.
      writeProxy: {
        workerUrl: this.env.WORKER_PUBLIC_URL,
        mode: (slug: string, isPrivate: boolean) => writeModeFor(this.env, slug, isPrivate),
      },
      // Board #350: the repo gate and the presign-GET mint. Both optional on
      // ProvisionDeps (install-cache.ts's InstallCacheRestoreDeps doc
      // comment) — wired here unconditionally, since the gate itself (empty
      // INSTALL_CACHE_REPOS = no repo ever matches) and presignR2's own
      // "unconfigured secrets -> null" fallback are what actually keep this
      // a no-op for every fleet that hasn't opted in yet, not the absence of
      // these two functions.
      installCacheEnabled: (workRepoSlug: string) => isInstallCacheRepo(this.env.INSTALL_CACHE_REPOS, workRepoSlug),
      installCachePresignGet: (key: string) => presignR2(this.env, key, "GET"),
      // Round 4 review, item 1 — tombstone a corrupt-but-present object on a
      // restore failure the module attributes to the archive itself (never a
      // transfer blip). Same plain-binding call installCacheDeps()'s own
      // r2Delete (the save side) already uses.
      r2Delete: async (keys: string[]) => {
        if (keys.length > 0) await this.env.STUDIO_ARCHIVE.delete(keys);
      },
      // Round 4 review, item 5(c) — the restore loop's own wall-clock budget.
      installCacheRestoreNow: () => new Date(),
    };
  }

  /**
   * P6a: which repo this studio's CREDENTIAL must serve — the same repo it
   * clones, resolved by the same rule provisionWithStorage uses one call
   * later (provision.ts's resolveWorkRepoSlug), so the two can never name
   * different owners and therefore never different providers.
   *
   * Reads the stored status directly rather than waiting for
   * provisionWithStorage's own read: the credential write has to happen
   * BEFORE the clone that needs it, and on a first provision into a new repo
   * the only place the answer exists yet is `cfg`. `null` cfg is the
   * restart/refresh case, where the binding on the stored status is the whole
   * truth.
   */
  private async workRepoSlug(cfg: ProvisionConfig | null): Promise<string> {
    const existing = (await this.ctx.storage.get<StudioStatus>(STATUS_KEY)) ?? null;
    return resolveWorkRepoSlug(cfg, existing, this.env.AGENT_REPO);
  }

  /**
   * Board issue #213: this DO's real board lookup for
   * `deliverAssignedTaskOnBringup`'s `boardLookup` thunk — resolves the
   * studio's currently assigned open task (if any) down to just the two
   * fields `assignDigest` needs.
   *
   * `workRepoSlug` is lowercased before the lookup: `resolveLatestAssignedBrief`
   * matches against the board's OWN stored slug casing, and
   * assignedBriefResolver (src/board/routes.ts) already lowercases the exact
   * same way for the exact same reason — a case mismatch here would silently
   * fail to match a task that IS assigned.
   */
  /** Issue #86: the lead started a turn — its submitted tasks go to working.
   *  Lowercased for the same reason as `assignedTaskOnBoard` below. */
  private async autoStartSubmitted(): Promise<void> {
    const repo = (await this.workRepoSlug(null)).toLowerCase();
    const res = await autoStartSubmittedTasks(githubBoardApi(this.env), repo, this.selfId());
    if (res.moved.length > 0) {
      console.log(`studio ${this.selfId()}: lead working — task ${res.moved.map((n) => `#${n}`).join(", ")} submitted -> working`);
    }
    for (const e of res.errors) console.error(`studio ${this.selfId()}: auto submitted->working: ${e}`);
  }

  /** Issue #106 — the real `onStaleBackgroundShell` callback, wired at
   *  `shipTranscript()`'s own call site next to `autoStartSubmitted` above.
   *  Reuses `wakeStudioWith` (issue #100) exactly the way `wakeStudio()`
   *  itself does below — `runGatedWake`'s stopped/limit-modal gates, single-
   *  flighted through the SAME `this.wakeLock` so this scheduled-tick nudge
   *  can never race an operator- or webhook-triggered wake into the same
   *  pane. `isMaestro()`/`armSweep()` are threaded through unchanged from
   *  `wakeStudio()`'s own call shape even though this nudge is not itself an
   *  assignment — a landed wake into a maestro studio still means "maestro
   *  just heard from the Worker", the same signal `wakeStudio()` already
   *  re-arms the crash sweep on. */
  private async notifyStaleBackgroundShell(): Promise<void> {
    const outcome = await singleFlightWake(this.wakeLock, () => wakeStudioWith(
      this.ctx.storage, (cmd: string) => sbExec(this, cmd, EXEC_CLASSES.wake), this.isMaestro(), () => this.armSweep(),
      STALE_BACKGROUND_SHELL_NUDGE_PROMPT, undefined, this.selfId(),
    ));
    logWakeOutcome("stale background-shell nudge", outcome);
  }

  private async assignedTaskOnBoard(workRepoSlug: string): Promise<{ taskNumber: number; title: string } | null> {
    const brief = await resolveLatestAssignedBrief(githubBoardApi(this.env), workRepoSlug.toLowerCase(), this.selfId());
    return brief === null ? null : { taskNumber: brief.taskNumber, title: brief.title };
  }

  /**
   * Board issue #213: wires `deliverAssignedTaskOnBringup` (do.ts's own
   * standalone extraction, tested with no DO construction in test/studio.
   * wake-gate.test.ts) to this DO's real board lookup and real wake.
   *
   * Called from all three bring-up choke points — `provision()`,
   * `restartUngated()`, and `recycle()`'s wiring into `recycleWithSync` —
   * each ONLY after their own "bring-up verified" check passes, never
   * before. Factored into one helper rather than three copies of the same
   * boardLookup/wake wiring, the same "reimplemented, not reused" trap
   * `memoryDeps` (below) already calls out for `recycle`/`destroyStudio`.
   *
   * `cfg` is the SAME `ProvisionConfig | null` `workRepoSlug` above already
   * takes (null on restart's own refresh-only path) — resolved fresh here,
   * not memoized, because provisionCore has by now written this studio's
   * `repoSlug` onto STATUS_KEY and `workRepoSlug` reads storage, not `cfg`
   * alone.
   *
   * `ctx` is the SAME OpCtx threaded through from whichever choke point
   * called this (provision's own `allowingStart`-scoped ctx, recycle's own
   * ctx, restartUngated's own ctx) — `() => ctx.moved()` is
   * `deliverAssignedTaskOnBringup`'s 4th `moved` param, so a destroy landing
   * mid-bring-up vetoes the delivery exactly like issue #174 already vetoes
   * every other bring-up write.
   *
   * TOTAL: never throws, so a delivery failure here can never turn a
   * successful provision/restart/recycle into a failed one — the same
   * log-and-swallow posture this file's own per-step try/catches
   * (syncSessionCycle, recordBringupObservation's callers) already take.
   * A REFUSED wake (stopped, limit modal, single-flight busy) is not an
   * error, but it must still leave a trace: the corrected NO-WAKE message
   * (#229) now PROMISES delivery on bring-up, and a silent refusal would
   * make that promise false with nothing in the logs to show it.
   */
  private async deliverTaskOnBringup(cfg: ProvisionConfig | null, ctx: OpCtx): Promise<void> {
    try {
      const workRepoSlug = await this.workRepoSlug(cfg);
      // Captured by the boardLookup closure below so the wake closure (which
      // only receives the already-rendered `prompt`, not the task itself) can
      // still name the task in a refusal's log line.
      let taskNumber: number | undefined;
      await deliverAssignedTaskOnBringup(
        this.ctx.storage,
        async () => {
          const task = await this.assignedTaskOnBoard(workRepoSlug);
          taskNumber = task?.taskNumber;
          return task;
        },
        async (prompt) => {
          const outcome = await this.wakeStudioOnAssignment(prompt);
          if (!outcome.ok) logWakeOutcome(`studio ${this.selfId()}: bring-up delivery of #${taskNumber}`, outcome);
          return outcome;
        },
        () => ctx.moved(),
      );
    } catch (err) {
      console.error(`studio ${this.selfId()}: post-bringup task delivery failed`, err);
    }
  }

  /**
   * Issue #249 (PR4b): this DO's real ports for the survival re-brief's
   * composition — `SurvivalSources`, wired to GitHub's own APIs from OUTSIDE
   * the container. Nothing here execs anything: the whole point of
   * `compareAhead` over a `git log` is that a studio's clone is shallow and
   * single-branch and cannot answer the question correctly (spec's own
   * measurement, #107).
   *
   * ONE token per delivery, minted lazily and shared across every read — the
   * same "fresh every call, deliberately uncached" tradeoff `deps()` makes,
   * except the sharing is within a single delivery rather than across them.
   *
   * `pull` answers null on a PR GitHub cannot resolve at all rather than
   * throwing, so one deleted/inaccessible PR artifact degrades that ONE task
   * line to its next branch source instead of failing the whole re-brief.
   * `compareAhead`'s own 404-is-null / other-errors-throw split is
   * deliberately left ALONE and handled by `resolveSurvivalInput` (see its doc
   * comment): "no branch on origin" and "we could not check" are different
   * statements and must render differently.
   */
  private survivalSources(workRepoSlug: string): SurvivalSources {
    const repo = workRepoSlug.toLowerCase();
    let minted: Promise<string> | null = null;
    const token = () => (minted ??= mintRepoToken(this.env, repo));
    return {
      studioId: this.selfId(),
      pull: async (prNumber) => {
        try {
          const pr = await getPullRequest(await token(), repo, prNumber);
          return { headRef: pr.headRef, title: pr.title };
        } catch (err) {
          console.error(`studio ${this.selfId()}: survival re-brief could not read ${repo}#${prNumber}`, err);
          return null;
        }
      },
      // A PREFIX query against GitHub's matching-refs endpoint, then
      // re-filtered through `isRescueBranchFor`'s anchored both-ends match
      // (rescueBranchesFor, survival-delivery.ts) — the server-side prefix is
      // a narrowing, never the match itself.
      rescueBranches: async () =>
        (await listMatchingBranches(await token(), repo, rescueBranchPrefix(this.selfId()))).map((b) => b.name),
      compareAhead: async (branch) => compareAhead(await token(), repo, SURVIVAL_COMPARE_BASE, branch),
      openPullNumbers: async () => listOpenPullNumbers(await token(), repo),
    };
  }

  /**
   * Issue #249 (PR4b): the studio's live tasks with the envelope artifacts
   * recorded against each — `SurvivalTaskRef[]`, the input the three anchored
   * branch sources read.
   *
   * Artifacts are collected NEWEST COMMENT FIRST, so the most recent PR or
   * branch claim on a task wins — the same "newest wins" resolution
   * `resolveLatestAssignedBrief` uses to pick the task itself, and the same
   * newest-first comment walk `quiescenceDeps`'s `latestEnvelope` above
   * already does.
   *
   * THROWS on a board read failure rather than degrading to `[]`: an empty
   * task list composes to an empty brief, which PR4a reads as "nothing
   * survived" — the exact silent drop #107 exists to fix. The caller turns a
   * throw into a `Checked` failure, which the composer renders as "could not
   * check (<reason>)".
   */
  private async survivalTasks(workRepoSlug: string): Promise<SurvivalTaskRef[]> {
    const api = githubBoardApi(this.env);
    const repo = workRepoSlug.toLowerCase();
    const result = await listTasks(api, repo, { assignedTo: this.selfId() });
    if (!result.ok) throw new Error(`board read failed (${result.status}): ${result.message}`);
    const live = result.value.filter((t) => t.open && t.state !== null && LIVE_TASK_STATES.includes(t.state));
    const refs: SurvivalTaskRef[] = [];
    for (const task of live) {
      const comments = await api.listComments(repo, task.number);
      const artifacts = [];
      for (let i = comments.length - 1; i >= 0; i--) {
        const doc = parseEnvelopeComment(comments[i]!.body);
        if (doc) artifacts.push(...doc.payload.artifacts);
      }
      refs.push({ taskNumber: task.number, taskTitle: task.title, artifacts });
    }
    return refs;
  }

  /**
   * Issue #249 (PR4b): wires `deliverSurvivalBriefOnBringup`
   * (survival-delivery.ts's standalone extraction, tested with no DO
   * construction in test/studio.survival-delivery.test.ts) to this DO's real
   * Observed record, real pane probe, real GitHub reads and real wake.
   *
   * ONE `getObserved` SNAPSHOT, TAKEN HERE, threaded into everything below —
   * the incarnation token, the `via`, `replacementDetected`, AND the
   * `session` the brief's snapshot age comes from. Delivery runs after
   * bring-up and takes several GitHub round trips plus a 3-second pane probe,
   * so a value re-read at the end of that would describe a different moment:
   * the spec is explicit that the snapshot age must be the RESTORE-TIME value
   * captured at bring-up. `resolveSurvivalInput` takes no storage port at all,
   * so it is structurally incapable of re-reading one.
   *
   * THE WAKE IS `wakeStudioOnAssignment` — the SAME method
   * `deliverTaskOnBringup` above calls, so both bring-up wakes go through the
   * SAME per-DO single-flight `wakeLock` (#141) instead of this feature
   * standing up a second, competing wake path beside it. There is no second
   * lock and no second gated-wake call site anywhere in this feature.
   * `singleFlightWake` REFUSES while the lock is held rather than queueing,
   * which is exactly why `deliverBringupWakes` below awaits the two
   * deliveries in sequence — see its own doc comment.
   *
   * The busy probe rides `EXEC_CLASSES.sync`, the same class `failoverDeps`
   * gives the identical `paneCaptureCmd()` probe — it sleeps
   * PANE_QUIESCE_SECONDS inside the container, so the 15s `inspect` class
   * would be cutting it fine for no gain.
   *
   * TOTAL: never throws, for the same reason `deliverTaskOnBringup` above
   * does not — a delivery failure must never turn a successful
   * provision/restart/recycle into a failed one.
   */
  private async deliverSurvivalOnBringup(cfg: ProvisionConfig | null, ctx: OpCtx): Promise<void> {
    try {
      const workRepoSlug = await this.workRepoSlug(cfg);
      const snapshot = await getObserved(this.ctx.storage);
      const session = snapshot.session;
      if (session === null) return;
      const outcome = await deliverSurvivalBriefOnBringup(
        this.ctx.storage,
        async () => ({
          incarnation: snapshot.incarnation,
          via: session.via,
          replacementDetected: session.replacementDetected === true,
          session,
        }),
        () => this.survivalBusy(),
        this.survivalCompose(workRepoSlug, session),
        (prompt) => this.wakeStudioOnAssignment(prompt),
        () => ctx.moved(),
      );
      this.logSurvivalOutcome("bring-up", outcome);
    } catch (err) {
      console.error(`studio ${this.selfId()}: post-bringup survival re-brief failed`, err);
    }
  }

  /**
   * Issue #249 (PR4b) round 2, item 2 — the DEFERRED re-brief's retry, one
   * step of the regular per-studio sync tick (`syncSessionCycle` above, every
   * SYNC_SESSION_SECONDS).
   *
   * Round 1 only ever attempted delivery from a BRING-UP, and a bring-up that
   * found the lead busy wrote nothing at all — so the retry was "the next time
   * this container is replaced", which on a healthy studio is not a schedule.
   * `retryPendingSurvivalBrief` (survival-delivery.ts) is the state machine;
   * this is its wiring, and it deliberately reuses the SAME busy probe, the
   * SAME compose and the SAME `wakeStudioOnAssignment` (hence the same per-DO
   * single-flight `wakeLock`) the bring-up path uses — not a second set.
   *
   * Maestro review, PR #302 round 2 — `clearDraftFirst: true` on THIS wake
   * call only, never the bring-up one. A prior attempt for the same pending
   * record can have typed text and come back `unconfirmed` (wake.ts's
   * `wakeCmd`, steps 6-8): the draft is still sitting in the composer, and
   * typing this retry's prompt on top of it would run the two together into
   * one doubled, unreadable message. A bring-up's wake is always the FIRST
   * attempt for its pending record, so no draft of THIS feature's own making
   * can already be there. C-u on an empty composer is a no-op, so this is
   * safe on the common case (nothing was ever typed) and correct on the one
   * it exists for.
   *
   * NO `ctx` HERE, and therefore no `moved` thunk: a tick already refuses to
   * run at all on a stopped studio or one with a destroy in flight
   * (`runScheduledTick` above, its own two-part guard), which is the same
   * protection `moved` gives the bring-up path. There is no operation lock to
   * consult on this path because there is no operation.
   *
   * TOTAL, like every other step of the cycle: a re-brief retry must never cost
   * a studio its readiness verdict or its reschedule.
   */
  private async retrySurvivalBrief(): Promise<void> {
    try {
      // The storage read FIRST and, on a healthy studio, the ONLY thing: no
      // container exec, no GitHub read, no board read, no wake when nothing is
      // owed. `retryPendingSurvivalBrief` re-reads and re-decides this itself —
      // this is a cheap pre-filter, not the gate.
      if (((await getObserved(this.ctx.storage)).survivalBriefPending ?? null) === null) return;
      const workRepoSlug = await this.workRepoSlug(null);
      this.logSurvivalOutcome("deferred", await retryPendingSurvivalBrief(
        this.ctx.storage,
        () => this.survivalBusy(),
        (pending) => this.survivalCompose(workRepoSlug, pending.session)(),
        (prompt) => this.wakeStudioOnAssignment(prompt, true),
      ));
    } catch (err) {
      console.error(`studio ${this.selfId()}: deferred survival re-brief retry failed`, err);
    }
  }

  /**
   * Issue #249 (PR4b): the busy probe, shared by the bring-up delivery and the
   * round-2 retry so the two can never disagree about whether a lead is free.
   *
   * Rides `EXEC_CLASSES.sync`, the same class `failoverDeps` gives the
   * identical `paneCaptureCmd()` probe — it sleeps PANE_QUIESCE_SECONDS inside
   * the container, so the 15s `inspect` class would be cutting it fine for no
   * gain.
   */
  private async survivalBusy(): Promise<BusyVerdict> {
    return paneBusy((await sbExec(this, paneCaptureCmd(), EXEC_CLASSES.sync)).stdout);
  }

  /**
   * Issue #249 (PR4b): the brief's composition, as the `compose` thunk both
   * entry points take. `session` is the caller's own frozen capture — the
   * bring-up's snapshot on the bring-up path, the pending record's copy of that
   * same snapshot on the retry path — never a fresh read, for the reason
   * `resolveSurvivalInput` takes no storage port at all.
   *
   * ROUND-2 ITEM 4: a BOARD READ FAILURE now DEFERS instead of composing a
   * brief that says "could not check". The task-branch section is the half of
   * this brief that recovers work (#107's measured recovery came from being
   * told which branches survived), the dedup marker is at-most-once per
   * incarnation, and a 503 from the board lasts seconds — so spending the one
   * delivery on a brief carrying none of the information it exists to carry is
   * the whole of the finding. A board that answers with an EMPTY task list is
   * the opposite case and still delivers normally: "none" is a checked answer,
   * and `survivalTasks` above throws only on a genuine read failure.
   *
   * The OPEN-PR section's own `Checked` failure is deliberately left alone and
   * still delivers as "could not check": that comes from GitHub's pulls API,
   * not the board, and an open-PR list is context rather than the recovery
   * instruction — a brief naming the surviving branches is worth delivering
   * without it.
   */
  private survivalCompose(workRepoSlug: string, session: ObservedSession): () => Promise<ComposedBrief> {
    return async () => {
      let tasks: SurvivalTaskRef[];
      try {
        tasks = await this.survivalTasks(workRepoSlug);
      } catch (err) {
        return { defer: `board unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
      return composeSurvivalDelivery(
        this.survivalSources(workRepoSlug), { ok: true, value: tasks }, session, new Date().toISOString(),
      );
    };
  }

  /**
   * Issue #249 (PR4b): one log line per delivery outcome, for both entry
   * points.
   *
   * A `skipped` is normal and routine (the allowlist alone denies most
   * bring-ups, and the retry skips on every tick that owes nothing), so it says
   * nothing. Everything else leaves a trace, because #107's whole complaint is
   * a lead that was never told and nothing anywhere that said so: a REFUSED
   * wake goes through `logWakeOutcome`'s own info/error split (#100 F5), a
   * DEFERRED attempt says which attempt it was, and GIVING UP is the loud one —
   * it is the moment the studio stops trying, and `fleet ls` grows a
   * `re-brief undelivered` line to match (cli/readiness-format.ts).
   */
  private logSurvivalOutcome(phase: "bring-up" | "deferred", outcome: SurvivalDeliveryOutcome): void {
    const label = `studio ${this.selfId()}: ${phase} survival re-brief`;
    if (outcome.kind === "refused") logWakeOutcome(label, outcome.wake);
    else if (outcome.kind === "deferred") {
      console.log(`${label} deferred (attempt ${outcome.attempts}): ${outcome.reason}`);
    } else if (outcome.kind === "gave-up") {
      console.error(`${label} UNDELIVERED, no longer retrying: ${outcome.reason}`);
    }
  }

  /**
   * Issue #249 (PR4b): BOTH bring-up deliveries, IN SEQUENCE, from one place.
   *
   * The maestro's own instruction on this issue: "Share #229's bring-up
   * delivery hook, so single-flight never refuses the second wake." Sequence,
   * not parallel, is the whole mechanism — the two wakes go through the SAME
   * `wakeStudioOnAssignment` and therefore the same per-DO `wakeLock` (#141),
   * and awaiting the first before starting the second means the second finds
   * the lock free rather than racing it and being refused.
   *
   * ORDER, and it IS a correctness question — round-2 review, item 2. This used
   * to be #229's assigned-task pointer first and the survival re-brief second,
   * on the stated theory that both are plain one-way types into the same pane
   * and the order is therefore only a readability choice. That theory was wrong,
   * and the asymmetry is the reason: ONLY the survival re-brief has a busy gate.
   * It probes the pane and stands down rather than interrupt a lead mid-turn
   * (`paneBusy`, survival-delivery.ts), while the task pointer just types —
   * claude queues a message typed at a busy lead, which is exactly what #229
   * wants. So typing the pointer first MAKES the lead busy, and the re-brief
   * running seconds behind it read that busy pane and deferred on precisely the
   * bring-ups the brief exists for.
   *
   * The re-brief therefore goes FIRST, and the pointer second. The reading order
   * is the better one anyway: the lead is told what survived, then told what to
   * work on, rather than being handed a task and only afterwards the context for
   * it.
   *
   * NOT MERGED INTO ONE TYPED MESSAGE, the review's other offered option,
   * because the two deliveries own SEPARATE at-most-once markers —
   * `DELIVERED_TASK_KEY` per task number, `survivalBriefDeliveredFor` per
   * incarnation — each written only on its own landed wake. One message means
   * one wake outcome deciding both, so a refusal would either re-deliver a task
   * pointer that already landed or suppress a re-brief that never did. Two
   * sequential wakes keep each feature's guarantee its own.
   *
   * `deliverTaskOnBringup` and `deliverSurvivalOnBringup` are each TOTAL
   * (both swallow and log their own failures), so neither can prevent the
   * other from running.
   *
   * This replaces the three individual `deliverTaskOnBringup` call sites at
   * `provision()`, `restartUngated()` and `recycle()`'s `recycleWithSync`
   * wiring — one combined wrapper rather than six call sites, the same
   * "factored into one helper rather than N copies" reasoning
   * `deliverTaskOnBringup`'s own doc comment gives.
   */
  private async deliverBringupWakes(cfg: ProvisionConfig | null, ctx: OpCtx): Promise<void> {
    await this.deliverSurvivalOnBringup(cfg, ctx);
    await this.deliverTaskOnBringup(cfg, ctx);
  }

  /**
   * Task 7's refresh port, concretely wired: mintRepoToken (src/github/auth.ts,
   * reused as-is, never duplicated) for the credential, the same sbExec adapter
   * `deps()` uses for the write, sendCard against OPERATOR_ID for the alert
   * (see this file's OPERATOR_ID import comment for why that recipient).
   *
   * P6a: takes the studio's WORK repo, because the credential written into the
   * container is the one that repo's OWNER uses — an org repo gets the App's
   * installation token, a personal repo gets the fine-grained PAT. Callers
   * resolve it with resolveWorkRepoSlug (provision.ts) so the credential and
   * the checkout can never name different owners.
   */
  private refreshDeps(workRepoSlug: string): RefreshDeps {
    return {
      // Issue #7: read-only unless the work repo is confirmed private (or the
      // operator switched the write proxy off). See write-proxy/mode.ts.
      mintToken: (mode?: WriteMode) => studioCredential(this.env, workRepoSlug, mode ?? "direct"),
      writeProxy: {
        workerUrl: this.env.WORKER_PUBLIC_URL,
        mode: () => resolveWriteMode(this.env, workRepoSlug,
          async (repo) => repoIsPrivate(await mintRepoToken(this.env, repo, { permissions: { contents: "read" } }), repo)),
      },
      sbExec: (cmd: string, env?: Record<string, string>) => sbExec(this, cmd, { ...EXEC_CLASSES.refresh, env }),
      recordStudio: async (status: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, status)),
      notify: async (message: string) => {
        const tg = telegramConfig(this.env);
        if (tg) await sendCard(tg.token, tg.operatorId, message);
      },
      now: () => new Date().toISOString(),
    };
  }

  /** Task 2 (P2)'s port, concretely wired: the same sbExec adapter deps()/
   *  refreshDeps() use, env.STUDIO_ARCHIVE (see env.ts's own doc comment on
   *  that binding) for r2Put, and a plain `new Date()` — shipTranscriptTick
   *  is the only place that needs a real Date rather than an ISO string
   *  (archive.ts's `advance` takes one directly). */
  private shipDeps(): ShipDeps {
    return {
      exec: (cmd: string) => sbExec(this, cmd, EXEC_CLASSES.ship),
      r2Put: async (key: string, bytes: Uint8Array) => {
        await this.env.STUDIO_ARCHIVE.put(key, bytes);
      },
      now: () => new Date(),
    };
  }

  /** Task 3 (P2 plane 2)'s port, concretely wired: the same sbExec adapter
   *  every other *Deps method uses, and the same env.STUDIO_ARCHIVE binding
   *  shipDeps() puts to — r2List/r2Delete are this feature's own addition,
   *  needed for the daily-keeper prune (see session-sync.ts's
   *  pruneDailyKeepers). `r2List` maps R2's list() result down to plain
   *  keys (all SessionSyncDeps needs); pagination is not handled here for
   *  the same reason session-sync.ts's own interface doc comment gives
   *  (a handful of daily keepers per studio, nowhere near R2's 1000-key
   *  default page). */
  private syncDeps(cls: "sync" | "readiness" | "rescue"): SessionSyncDeps {
    return {
      exec: (cmd: string, env?: Record<string, string>) => sbExec(this, cmd, env ? { ...EXEC_CLASSES[cls], env } : EXEC_CLASSES[cls]),
      r2Put: async (key: string, bytes: Uint8Array) => {
        await this.env.STUDIO_ARCHIVE.put(key, bytes);
      },
      r2List: async (prefix: string) => {
        const listed = await this.env.STUDIO_ARCHIVE.list({ prefix });
        return listed.objects.map((o) => o.key);
      },
      r2Delete: async (keys: string[]) => {
        if (keys.length > 0) await this.env.STUDIO_ARCHIVE.delete(keys);
      },
      // Issue #94: seeds the sync guard's baseline from `latest` once.
      r2Get: async (key: string) => {
        const obj = await this.env.STUDIO_ARCHIVE.get(key);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      },
      now: () => new Date(),
      // Task 4 (P2 plane 4): same sendCard(..., OPERATOR_ID, ...) call
      // refreshDeps().notify above already uses — one recipient, one
      // telegram surface, for every studio-originated alert this feature
      // has. BURN_ALERT_OUTPUT_TOKENS_5H is parsed HERE, not in
      // session-sync.ts — env-var access stays concentrated in this file's
      // deps builders (studioEnvVars/refreshDeps/shipDeps/syncDeps all
      // already follow this); "0"/absent both parse to 0, which
      // burn.ts's shouldAlert already treats as "alerts off."
      notify: async (message: string) => {
        const tg = telegramConfig(this.env);
        if (tg) await sendCard(tg.token, tg.operatorId, message);
      },
      burnAlertThresholdTokens: Number(this.env.BURN_ALERT_OUTPUT_TOKENS_5H ?? "0"),
      // Issue #361: completion records' teardown archive.
      doneRecords: this.doneRecordPorts(),
      // Issue #335 (public-release scrub): the real operator's own bot
      // identity, config not code — absent means rescuePushCmd/
      // rescueSnapshotCmd's own neutral defaults apply.
      botName: this.env.FLEET_BOT_NAME,
      botEmail: this.env.FLEET_BOT_EMAIL,
      // Issue #1 piece 5: FLEET_RESCUE_REMOTE + a contents:write token scoped
      // to it; unset or a failed mint → origin, leak-gated, loudly (rescue.ts).
      // Issue #24: only for a PUBLIC work repo; private or unknown → origin.
      rescueTarget: () => this.rescueTarget(() => this.workRepoSlug(null)),
    };
  }

  /**
   * Issue #30: the ONE rescue-target decision. Rescue (syncDeps above) pushes
   * to it; provision's discovery (deps().rescueTarget) lists + fetches from
   * it, so discovery reads exactly what rescue wrote.
   */
  private rescueTarget(
    workRepoSlug: () => Promise<string>, purpose: "push" | "discovery" = "push",
  ): Promise<RescueTarget> {
    // Issue #7: never the fleet's write PAT (containerToken); PAT fleets bring
    // a rescue-only token. And only for a rescue repo confirmed private.
    // Issue #45: discovery only reads the remote — read token, not write.
    return resolveRescueTarget(this.env,
      async (repo) => (await containerToken(this.env, await workRepoSlug(), repo, rescueMintPermissions(purpose)))
        ?? (this.env.FLEET_RESCUE_GITHUB_TOKEN || null),
      async () => {
        const slug = await workRepoSlug();
        return repoIsPrivate(await mintRepoToken(this.env, slug), slug);
      }, purpose,
      async (repo) => repoIsPrivate(await mintRepoToken(this.env, repo, { permissions: { contents: "read" } }), repo));
  }

  /**
   * Issue #361's DoneRecordPorts, concretely wired -- factored out so #367's
   * SECOND archiveDoneRecords call site (the periodic ship tick,
   * shipTranscript() below) can wire the identical ports the teardown call
   * site (syncDeps() above) already builds, rather than a second copy of the
   * same three closures.
   */
  private doneRecordPorts(): DoneRecordPorts {
    return {
      workRepoSlug: () => this.workRepoSlug(null),
      // #363: create-or-replace, ops-scoped, contents:write.
      putOpsFile: doneRecordPutter(this.env),
      commentOnTask: async (repo, task, body) => {
        await githubBoardApi(this.env).createComment(repo, task, body);
      },
    };
  }

  /**
   * Board #350's save-tick port. Its own EXEC_CLASSES.installCache session
   * (sandbox-api.ts's own doc comment on that entry says why: a slow upload
   * must never queue behind the 300s session sync tick's own `sync`
   * session), the same env.STUDIO_ARCHIVE binding syncDeps()/shipDeps() use
   * for everything but the presigned URLs themselves (r2Head/r2List/
   * r2Delete are all plain-binding calls; `presignPut` is the one call that
   * goes through the SigV4 path instead — see install-cache.ts's own header
   * for why the two binding types coexist for this one bucket).
   */
  private installCacheDeps(): InstallCacheSaveDeps {
    return {
      sbExec: (cmd: string, env?: Record<string, string>) => sbExec(this, cmd, { ...EXEC_CLASSES.installCache, env }),
      presignPut: (key: string) => presignR2(this.env, key, "PUT"),
      r2Head: async (key: string) => (await this.env.STUDIO_ARCHIVE.head(key)) !== null,
      r2List: async (prefix: string) => {
        const listed = await this.env.STUDIO_ARCHIVE.list({ prefix });
        return listed.objects.map((o) => ({ key: o.key, uploaded: o.uploaded }));
      },
      r2Delete: async (keys: string[]) => {
        if (keys.length > 0) await this.env.STUDIO_ARCHIVE.delete(keys);
      },
      installCacheRepos: this.env.INSTALL_CACHE_REPOS,
      now: () => new Date(),
    };
  }

  /**
   * Round 3 review, item 3 — the in-memory half of the detached save's
   * in-flight guard (syncSessionCycle's own `installCacheGuard` parameter).
   * A field on the DO instance itself, not a fresh object per tick (unlike
   * `installCacheDeps()` above, rebuilt every call): this must be the SAME
   * object across every `syncSession()` tick this isolate ever runs, so a
   * flag one tick's detached save sets is still visible to the NEXT tick's
   * check, for as long as this isolate lives. A fresh isolate (a redeploy, an
   * eviction) gets a fresh `{ inFlight: false }` by construction — nothing to
   * reset explicitly, which is exactly the property the storage-persisted
   * lease (install-cache.ts's INSTALL_CACHE_SAVE_LEASE_KEY) exists to cover
   * for THAT case instead.
   */
  private installCacheSaveGuard: { inFlight: boolean } = { inFlight: false };

  /**
   * Issue #53's port, concretely wired: the same sbExec adapter every other
   * *Deps method uses, the same sendCard(..., OPERATOR_ID, ...) notify
   * refreshDeps()/syncDeps() already use, and the account list read straight
   * off this Worker's secrets (accounts.ts's resolveClaudeAccounts) — so
   * `wrangler secret put CLAUDE_CODE_OAUTH_TOKEN_2` is the whole of adding an
   * account, with no code change and no redeploy of this file.
   *
   * `relaunch` is deliberately BRINGUP_CMD with the studio's stored role env —
   * byte-identical to what runRestart executes — and not a launch line
   * assembled here. container/studio-bringup.sh owns every launch decision
   * (`--dangerously-skip-permissions`, the `cd` into the checkout, the
   * one-argv `--allowedTools`, `--effort`, the `--append-system-prompt` brief,
   * and the `--continue` resume guard), it only sends the launch when the pane
   * is a plain bash — precisely the state the switch leaves it in — and it is
   * idempotent by design. Reusing it is what keeps this feature from owning a
   * second, drifting copy of the launch, and is why in-flight PR #58's
   * tightened `--continue` guard and its post-send liveness check apply to a
   * failover relaunch the moment that PR lands, with nothing to change here.
   *
   * No stored role env is a REFUSAL, not a bring-up: the script's own
   * `${ROLE_PROMPT_B64:-}` default would launch claude with an empty system
   * prompt and an empty tool policy and report success. Same ruling runRestart
   * already makes, reusing its exact message.
   */
  private failoverDeps(): FailoverDeps {
    return {
      accounts: resolveClaudeAccounts(this.env),
      // Issue #271: off unless FLEET_AUTO_FAILOVER=on; the mapped primary is
      // where an unswitched studio is; cards name labels.
      autoFailover: autoFailoverOn(this.env),
      primary: this.primaryAccount(),
      display: (name: string) => accountDisplay(this.env, name),
      // Issue #102: fleet-wide per-account limit state, D1-backed (fleet_state
      // via ../state.ts) -- kept OUT of accounts.ts/failover.ts on purpose
      // (both stay D1-free and bun:test-compilable; see accounts.ts's own
      // header), wired here where `this.env.DB` already lives.
      accountLimits: {
        read: () => readFleetAccountLimits(this.env.DB, resolveClaudeAccounts(this.env)),
        write: (name: string, until: string | null, seenAt: string) => writeFleetAccountLimit(this.env.DB, name, until, seenAt),
      },
      exec: (cmd: string, env?: Record<string, string>) => sbExec(this, cmd, { ...EXEC_CLASSES.sync, env }),
      now: () => new Date(),
      notify: async (message: string) => {
        const tg = telegramConfig(this.env);
        if (tg) await sendCard(tg.token, tg.operatorId, message);
      },
      // Issue #354: a completed switch wrote the new account to the ROW only;
      // the in-memory start config kept the old one, so the next container
      // start (alarm/exec wake) booted the old token and onStart recorded the
      // old account over the failover's. Re-derive both from the new name.
      onSwitched: async (name: string) => {
        const spawnToken = await loadOrMintSpawnToken(this.ctx.storage);
        ({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(this.env, this.selfId(), spawnToken, name));
      },
      relaunch: async () => {
        const roleEnv = (await this.ctx.storage.get<RoleEnv | StudioEnv>(ROLE_ENV_KEY)) ?? null;
        if (!roleEnv) return { code: 1, stdout: "", stderr: NO_ROLE_ENV_ERROR };
        // Issue #116: adopt a worktree-keyed session first, then BRINGUP_CMD.
        return relaunchBringup((cmd, env) => sbExec(this, cmd, { ...EXEC_CLASSES.provision, env }), roleEnv, this.selfId());
      },
    };
  }

  /** Issue #271: the repo's mapped primary (or the first set account), by name; null when
   *  that mapping cannot launch (launchAccountOrRefuse says why). */
  private primaryAccount(): string | null {
    const launch = launchAccount(this.env, parseStudioId(this.selfId())?.repo ?? null, null);
    return launch.ok ? launch.name : null;
  }

  /** The account this studio is recorded on (StudioStatus.claudeAccount), for
   *  the container's start config. `null` for a studio that never switched,
   *  which accounts.ts resolves to the first account — what every studio that
   *  predates issue #53 was on by construction. */
  private async claudeAccountName(): Promise<string | null> {
    return (await this.ctx.storage.get<StudioStatus>(STATUS_KEY))?.claudeAccount ?? null;
  }

  /** recordStudio with the observed block merged — the writer every op path here uses. */
  private recordFn(): (s: StudioStatus) => Promise<void> {
    return async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s));
  }

  private selfId(): string {
    return this.ctx.id.name ?? "unknown";
  }

  /**
   * Issue #37: provisioning, then the live check, then the answer. The core
   * below does exactly what this method always did; the wrapper is what makes
   * the returned row describe the studio AS IT IS NOW rather than echoing the
   * readiness verdict the last syncSession tick happened to leave behind — up
   * to SYNC_SESSION_SECONDS (300s) stale, and measured stale on 2026-09-23
   * while a `fleet provision` had already healed the studio it was describing.
   *
   * `recycle` calls provisionCore, NOT this, on purpose: recycleWithSync runs
   * its own post-provision check (and now reports it), so routing recycle
   * through here would buy nothing and pay for a second container exec.
   */
  async provision(cfg: ProvisionConfig): Promise<StudioStatus> {
    const id = buildStudioId(cfg);
    // Issue #152: ONE ctx for the whole outer operation — provisioning AND
    // the readiness check that follows it — created here, at provision()'s
    // own entry, rather than inside provisionCore: provisionWithFreshVerdict
    // needs the SAME ctx provisionCore's own provisionUngated used, so its
    // own post-provision readiness check (a container exec) is guarded by
    // the identical epoch snapshot, not a fresh one taken after provisioning
    // already ran.
    const result = await this.allowingStart(async (ctx) => {
      const fresh = await provisionWithFreshVerdict(
        this.syncDeps("readiness"), this.ctx.storage, id,
        (c) => this.provisionUngated(c, "provision", ctx),
        async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)), cfg, ctx,
      );
      // Board issue #213: bring-up verified (never before — a task typed into a
      // pane that turned out bare/inconclusive would be a wake into nothing).
      // Threads THIS callback's own ctx through, so a destroy landing
      // mid-bring-up vetoes the delivery exactly like issue #174's other
      // bring-up writes (see deliverAssignedTaskOnBringup's `moved` param).
      // Issue #249 (PR4b): both bring-up wakes now, through the ONE combined
      // wrapper that shares #229's single-flight lock — see
      // deliverBringupWakes.
      if (fresh.readiness?.kind === "provisioned") await this.deliverBringupWakes(cfg, ctx);
      return fresh;
    });
    return withObserved(this.ctx.storage, result);
  }

  /**
   * Issue #37: the live check, on demand, for this one studio — the answer to
   * "THERE IS NO WAY TO ASK FOR THE TRUTH NOW". Runs the SAME
   * checkProvisionedWithRetry every other readiness surface runs, records the
   * verdict (DO storage + the D1 registry row, so `fleet ls` agrees straight
   * away), and answers the whole status row.
   *
   * Writes nothing to the CONTAINER and switches no tmux window — see
   * provisionedCheckCmd (provision.ts) and the `check` route (routes.ts).
   *
   * A studio with no stored status yet has nothing to check: the fallback is
   * its plain status, whose readiness stays unset ("?" / "never" in
   * `fleet ls`), which is the honest answer rather than a fabricated verdict.
   */
  async checkNow(): Promise<StudioStatus> {
    const fresh = await checkAndRecordReadiness(
      this.syncDeps("readiness"), this.ctx.storage, this.selfId(),
      async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)),
    );
    const result = fresh ?? (await getStatusWithStorage(this.ctx.storage, this.selfId()));
    return withObserved(this.ctx.storage, result);
  }

  /** Board #140: the route's own RPC entry — see the free function's doc
   *  comment for what this actually does and does not guarantee. */
  async clearSessionGuard(): Promise<StudioStatus> {
    const cleared = await clearSessionGuard(this.ctx.storage, (s) => recordStudio(this.env, s));
    return cleared ?? (await getStatusWithStorage(this.ctx.storage, this.selfId()));
  }

  /**
   * Issue #123: an explicit start — see allowingStart. Issue #152: recycle
   * passes its OWN ctx here (`sharedCtx`) so its internal reprovision step
   * reuses the epoch recycle itself snapshotted at ITS OWN entry, rather than
   * taking a fresh one after recycle's own destroy() has already run — a
   * fresh snapshot taken there would never see that destroy as a "move" at
   * all, since it would already be baked into the new snapshot. Called with
   * no ctx (provision()'s own test coverage, and this method's own direct
   * callers), it wraps itself in allowingStart exactly as before.
   */
  private provisionCore(cfg: ProvisionConfig, via: BringupVia = "provision", sharedCtx?: OpCtx): Promise<StudioStatus> {
    if (sharedCtx) return this.provisionUngated(cfg, via, sharedCtx);
    return this.allowingStart((ctx) => this.provisionUngated(cfg, via, ctx));
  }

  private async provisionUngated(cfg: ProvisionConfig, via: BringupVia, ctx: OpCtx): Promise<StudioStatus> {
    // Deliberate cost-governance call (design spec: "$250k expiring
    // Cloudflare credits... keepAlive: true deliberate"). getSandbox(...,
    // {keepAlive:true}) would apply this from the Worker side, but
    // routes.ts never imports "@cloudflare/sandbox" (see its own header for
    // why) — set through the adapter (sbSetKeepAlive — review round 2, Spec
    // 4) rather than calling the SDK method on `this` directly, so this
    // stays do.ts's only direct SDK touch.
    //
    // Fleet Spawn P3, Task 4 (R-P3-6): this USED to be an unconditional
    // `await sbSetKeepAlive(this, true)` right here, before anything else in
    // this method ran. It no longer is: the value is now per-ROLE
    // (blueprint.ts's Role.keep_alive, default true), and the role is not
    // known until provisionWithStorage resolves the blueprint deep inside
    // the call below — so the toggle moved to live beside that resolve, in
    // provision.ts's runProvision (see ProvisionDeps.setKeepAlive's own doc
    // comment), wired here via `deps()` a few lines down instead of called
    // inline. Idempotent to repeat either way, so a re-provision (or a
    // retried request) still costs nothing extra.
    //
    // Task 7 controller ruling: mint + write the credential BEFORE the
    // clone below — provisionWithStorage -> runProvision issues the guarded
    // clone as ITS first exec, and a private AGENT_REPO needs
    // /workspace/.git-credentials to already exist to authenticate that
    // clone.
    //
    // Review round 1, I3: routed through refreshWithStorage — the SAME
    // storage-aware wrapper the scheduled callback uses — rather than the
    // bare runRefreshCredential + a console.error the operator would never
    // see. A mint/write failure here now lands in stored status (state
    // degraded, lastRefreshError set, a telegram alert per the usual
    // once-per-streak rule) exactly like a refresh-time failure does. Still
    // not fatal to provisioning: the clone attempt right below runs
    // regardless, and fails on its own with its own clear "clone failed"
    // error for a private repo (or succeeds anyway for a public one).
    // Post-C2 this composes safely: provisionWithStorage's own clone-error
    // write does not touch `lastRefreshError`, so that clone error can
    // never be mistaken for a refresh-owned degradation and silently
    // erased by some LATER unrelated successful refresh (see
    // runRefreshToken's `ownsDegradation` doc comment).
    const id = buildStudioId(cfg);
    // Fleet Spawn P3, Task 1 (R-P3-1): make sure this studio's spawn token
    // and its published hash are on file. Runs unconditionally on every
    // provision call — the same posture as the credential refresh below —
    // because ensureSpawnToken itself is what decides whether there is
    // already a current one (see the Task 6 paragraph, and its own doc
    // comment, right below). Reassigning `this.envVars` (not just DO
    // storage) is what actually gets that token into the container.
    //
    // Task 6 FIX — this pair must run BEFORE any container interaction, and
    // used to run after the credential refresh below. `envVars` is the
    // container's START configuration (@cloudflare/containers reads
    // `this.envVars` when it launches the container, and an `exec` carries
    // only whatever per-call env it is handed) — so whichever call first
    // touches the container decides, permanently, what the tmux server and
    // every pane under it will see. refreshWithStorage execs
    // `credentialWriteCmd` into the container, which is exactly such a
    // touch: with it running first, the container launched with the
    // class-field bootstrap token (see the `envVars` field below) — a value
    // minted synchronously at DO construction and persisted NOWHERE. The
    // Worker then published a DIFFERENT token's hash to the registry, so the
    // token every studio actually held could match no row, and
    // `/fleet/spawn` answered 401 for every studio in the fleet, forever.
    // Measured, not theorised: the P3 spawn e2e caught it on its first real
    // run (`studio-fleet: spawn failed (401)` with a non-empty token in the
    // pane) and passes with the order below.
    //
    // Task 6 (ruling 1): ensureSpawnToken, not the old rotateSpawnToken —
    // the token is now static for a studio's whole lifetime, so a
    // re-provision returns the SAME one the container is already holding
    // instead of publishing a hash that container could never match. See its
    // own doc comment for why reminting could not work, and for the operator
    // rotation procedure that replaced it.
    const spawnToken = await ensureSpawnToken(
      this.ctx.storage, id,
      async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)),
    );
    // Issue #271: a repo mapped to an unset account refuses here, before any
    // container touch, with the reason on the row.
    const launch = await launchAccountOrRefuse(this.env, this.ctx.storage, id, this.recordFn());
    // Issue #354 (the #348 shape, here too): both fields from the ONE launch.
    ({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(this.env, id, spawnToken, launch.name));
    // #110 review: the refresh write below is this path's FIRST container
    // touch, and the SDK waits for a cold container inside that exec. Wait
    // here, under bring-up's own budget, so the refresh budget never has to.
    if (!this.ctx.container?.running) await sbAwaitReady(this);
    await refreshWithStorage(this.refreshDeps(await this.workRepoSlug(cfg)), this.ctx.storage, id, ctx);
    const status = await provisionWithStorage(
      this.deps(), this.ctx.storage, cfg, this.env.AGENT_REPO, via, this.ctx.storage, ctx,
    );
    // Issue #221 fix round 2, Fix 4 — a fresh bring-up has no continuous
    // activity state for `since`/`anchored` to describe; clear both before
    // the ship tick's next probe writes a fresh one. Best-effort (never
    // throws) — see `clearActivityState`'s own doc comment.
    await clearActivityState(this.ctx.storage);
    // Issue #152: a destroy landed (and fully completed) somewhere in the
    // sequence above — provisionWithStorage's own guard already left the row
    // exactly as destroy did, with no further write. Arming the three loops
    // below would resurrect exactly the loop-driven billing destroy exists to
    // stop, against a container that no longer exists; skip them entirely.
    if (await ctx.moved()) {
      console.error(`studio ${id}: destroy landed mid-provision, ticks stay disarmed`);
      return status;
    }
    // Review round 1, I1: clear any previously-scheduled refreshToken
    // BEFORE creating a new one. provision() is called idempotently (Task
    // 4's own re-provision design, and studio.routes.test.ts's "provision
    // idempotent" coverage) — without this, every repeat provision() call
    // stacks another independent, permanent refresh loop alongside the
    // ones from all its predecessors (the library always inserts a fresh
    // schedule row, never dedupes by callback name). Same idiom
    // agents/do.ts's /rearm handler uses for the identical reason
    // (agents/do.ts:244-252) — deleteSchedules is synchronous, not a
    // Promise, so it is not awaited.
    //
    // Task 2 (P2) / Task 3 (P2 plane 2): shipTranscript and syncSession get
    // the same idempotent-reschedule guard, for the same reason — see
    // armTicks().
    await this.armTicks();
    // Phase 2, task 3: the sweep is armed here and in restartStudio, the two
    // entry points that bring a studio up — and only for a maestro, since
    // only a maestro supervises. armSweep's own deleteSchedules keeps a
    // repeated provision from stacking loops, exactly like the three above.
    if (this.isMaestro()) await this.armSweep();
    return status;
  }

  /**
   * Arm (or re-arm) the three per-studio loops. Every re-arm deletes first —
   * rearm() below — so calling this from inside a running tick (the #71 heal
   * reaches restartStudio from syncSession) never stacks a second loop.
   */
  private async armTicks(): Promise<void> {
    await this.rearm("refreshToken", REFRESH_SECONDS);
    await this.rearm("shipTranscript", SHIP_TRANSCRIPT_SECONDS);
    await this.rearm("syncSession", SYNC_SESSION_SECONDS);
  }

  /** Delete-then-schedule: the library never dedupes by callback name, and a
   *  firing row is only deleted AFTER its callback returns (by id), so this
   *  is safe from inside the callback it re-arms. */
  private async rearm(name: (typeof STUDIO_TICKS)[number], seconds: number): Promise<void> {
    this.deleteSchedules(name);
    await this.schedule(seconds, name);
  }

  /** Issue #104: what GET /studio/:id/status answers. Issue #85, maestro
   *  correction #1: `observed` rides this response too — every StudioStatus
   *  leaving this DO passes through it (withObserved's own doc comment) —
   *  so /status agrees with `fleet ls`/`fleet check` rather than being the
   *  one caller `observed` forgot. */
  async getStatusDetail(): Promise<Awaited<ReturnType<typeof statusDetailWithStorage>> & { observed: Observed }> {
    const detail = await statusDetailWithStorage(this.ctx.storage, this.selfId(), this.destroyInFlightCount > 0);
    // Issue #221: `observed.activity` rides this response too — see
    // `getObservedWithActivity`'s own doc comment.
    return { ...detail, observed: await getObservedWithActivity(this.ctx.storage) };
  }

  /** Issue #104: the library's own onStart, then an info-level line — the
   *  SDK logs "Sandbox started" only at debug. */
  async onStart(): Promise<void> {
    await super.onStart();
    console.log(`studio ${this.selfId()}: container started`);
    // Issue #289: the account this start's CLAUDE_CODE_OAUTH_TOKEN came from.
    // Every start path lands here (provision, restart, recycle, an alarm- or
    // attach-woken start), so the row names what actually runs.
    try {
      await recordLaunchedAccount(this.ctx.storage, this.selfId(), this.envAccount, this.recordFn());
    } catch (err) {
      console.error(`studio ${this.selfId()}: could not record the launched account`, err);
    }
  }

  /** Issue #104: the library's own onStop first (it resets the SDK's session
   *  state), then the exit code and reason, recorded where /status reads it.
   *  Issue #221 fix round 2, Fix 4: also clears ACTIVITY_KEY/
   *  MEMBERS_TICKING_KEY (activity.ts's `clearActivityState`) — a stopped
   *  container has no lead for `since`/`anchored` to keep describing, and
   *  without this a stale `since` would survive the stop and misreport how
   *  long the studio's activity has ACTUALLY held once it comes back up. */
  async onStop(params?: Parameters<Sandbox<Env>["onStop"]>[0]): Promise<void> {
    await super.onStop(params);
    await recordContainerStop(
      this.ctx.storage, this.selfId(),
      { exitCode: params?.exitCode ?? -1, reason: params?.reason ?? "unknown" }, new Date(),
    );
    await clearActivityState(this.ctx.storage);
  }

  /**
   * Task 5 (P2 plane 3): the grid's per-studio hot-tail read. Deliberately
   * NOT folded into getStatus()/StudioStatus — R-P2-7 (design spec, Plane 1)
   * draws a hard line between the RAW archive (this value, straight from DO
   * storage, unscrubbed — it can carry anything the studio's own terminal
   * echoed, secrets included) and the SCRUBBED preview any HTTP response may
   * ever carry. routes.ts's grid path (the only caller) redacts + slices
   * this via grid.ts's scrubPreview before it ever reaches a Response; the
   * plain /status and /studio/ (JSON) routes never call this at all, so
   * neither gets a whiff of raw transcript content.
   */
  async getTranscriptTail(): Promise<string> {
    return getTranscriptTailWithStorage(this.ctx.storage);
  }

  /**
   * Review round 2: routes the credential step through refreshWithStorage
   * BEFORE bring-up, exactly the same wiring provision() uses (round 1,
   * I3) — symmetry, not a restart-specific special case. Without this, a
   * stale `lastRefreshError` from a PRIOR refresh failure survives an
   * unrelated restart untouched (runRestart's own success path never
   * touches it — it only spreads `existing` through), so a later,
   * genuinely NEW refresh failure reads `lastRefreshError` as still
   * non-null and silently never alerts, even though the operator watched
   * the studio go back to "running" in between. Routing restart through
   * the same credential step fixes both directions: a working mint at
   * restart time clears the marker (the next refresh failure is correctly
   * a new streak and alerts); a still-failing mint at restart time updates
   * the marker but does not re-alert (same continuous credential streak —
   * the operator was already told when it began). See lastRefreshError's
   * own doc comment (types.ts) for the general rule this is an instance
   * of.
   *
   * Task 12: `restartWithStorage` also reads the role env provision persisted
   * (ROLE_ENV_KEY) and passes it to bring-up, so a relaunch after a container
   * recycle gets the SAME system prompt and tool policy the original
   * provision resolved — no blueprint refetch at restart time (a restart must
   * not depend on GitHub being reachable), and never a bare claude. A studio
   * with nothing stored there degrades with `NO_ROLE_ENV_ERROR` instead of
   * bringing up a role-less agent.
   *
   * Task 3 (P2 plane 2): routed through restartWithSync (this file, above)
   * rather than restartWithStorage directly — one syncSession tick runs
   * BEFORE bring-up, so a container that's about to be healed/recreated
   * ships its latest session state first. Same ordering position as the
   * credential refresh just above (both run before the actual restart), and
   * same failure posture: a sync failure is caught inside restartWithSync
   * and never blocks the restart that follows.
   *
   * Fleet Spawn P3, Task 1: a restart heals the container's tmux session, it
   * does not rotate identity — and since Task 6's ruling neither does
   * provision, so this and provision now call the SAME ensureSpawnToken and
   * get the same answer. `this.envVars` is reassigned from it unconditionally
   * rather than left at whatever the constructor loaded, so the value handed
   * to bring-up is always the one this call just confirmed on file.
   *
   * **Ordering (final review fix).** That settle now happens BEFORE the
   * credential refresh above, not after — this method used to have it
   * backwards, the mirror image of the bug provision()'s own Task 6 FIX
   * comment (above) describes. The credential refresh execs into the
   * container, and an exec is what STARTS one that is not already running
   * (e.g. right after the documented rotation procedure recycles it); with
   * that exec running first, such a container would boot on whatever stale
   * envVars `this` still held, while the token/hash this call goes on to
   * settle and publish describe a DIFFERENT, newer token that container
   * would never hold — the same permanent 401 provision() was fixed to
   * avoid, just reachable from restart instead.
   *
   * That also covers the pre-P3 studio: one with ROLE_ENV_KEY (so runRestart's
   * NO_ROLE_ENV_ERROR guard does not fire — restart proceeds to bring-up) but
   * no SPAWN_TOKEN_KEY, because provision() never wrote one before P3.
   * ensureSpawnToken mints, persists and publishes for it — one time, stable
   * thereafter.
   */
  /**
   * Issue #123: an explicit start (also the #71 heal) — see allowingStart.
   * Issue #152: ONE ctx for this whole call, created here at restartStudio's
   * own entry — the same outer-entry-point placement provision() uses, and
   * for the identical reason: restartWithFreshVerdict's own post-restart
   * readiness check needs the SAME epoch snapshot restartUngated's own
   * restartWithSync call used, not a fresh one taken after the restart
   * already ran. `heal` (syncSessionCycle's own wiring) IS a call to this
   * method — it reuses this exact machinery by calling straight through it,
   * never by holding a ctx of its own.
   */
  restartStudio(via: BringupVia = "restart"): Promise<StudioStatus> {
    return this.allowingStart((ctx) => this.restartUngated(via, ctx));
  }

  private async restartUngated(via: BringupVia, ctx: OpCtx): Promise<StudioStatus> {
    const id = this.selfId();
    // On the ordinary path this just reads back what provision stored; for a
    // pre-P3 studio it mints AND publishes the hash, which is the only thing
    // that lets a healed token ever authenticate a /fleet/spawn call.
    const spawnToken = await ensureSpawnToken(
      this.ctx.storage, id,
      async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)),
    );
    // Issue #271: a repo mapped to an unset account refuses here, before any
    // container touch, with the reason on the row.
    const launch = await launchAccountOrRefuse(this.env, this.ctx.storage, id, this.recordFn());
    // Issue #354 (the #348 shape, here too): both fields from the ONE launch.
    ({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(this.env, id, spawnToken, launch.name));
    // #110 review: the refresh write below is this path's FIRST container
    // touch, and the SDK waits for a cold container inside that exec. Wait
    // here, under bring-up's own budget, so the refresh budget never has to.
    if (!this.ctx.container?.running) await sbAwaitReady(this);
    await refreshWithStorage(this.refreshDeps(await this.workRepoSlug(null)), this.ctx.storage, id, ctx);
    const restarted = await restartWithSync(
      this.deps(), this.syncDeps("sync"), this.ctx.storage, id, this.env.AGENT_REPO, via, this.ctx.storage, ctx,
    );
    // Issue #221 fix round 2, Fix 4 — same reasoning as provisionUngated's
    // own call: a fresh bring-up (restart/recycle/heal all route through
    // here via `via`) has no continuous activity state to keep describing.
    await clearActivityState(this.ctx.storage);
    // Issue #152: a destroy landed (and fully completed) somewhere above —
    // restartWithStorage's own guard (inside restartWithSync) already left
    // the row exactly as destroy did. Arming the loops below would resurrect
    // them against a container that no longer exists; skip both.
    if (await ctx.moved()) {
      console.error(`studio ${id}: destroy landed mid-restart, ticks stay disarmed`);
    } else {
      // A stopped studio has no loops (destroyStudio disarms them, and
      // runScheduledTick ends any straggler), so a restart that brings one
      // back must arm them, exactly as provision does.
      await this.armTicks();
      // Same arming as provision's tail, for the same reason: a restart is
      // the other way a maestro's container comes back, and a maestro that
      // came back with no sweep clock supervises nothing until someone
      // notices.
      if (this.isMaestro()) await this.armSweep();
    }
    // Issue #38: answer with a verdict measured after this restart, never
    // with the `readiness` row that was already there. A container image
    // rollout replaces the container UNDER this DO, so restart is routinely
    // the first thing to touch a brand new, empty filesystem — and the row it
    // would otherwise echo describes the filesystem that rollout destroyed.
    // Same machinery `provision` uses (issue #37's checkAndRecordReadiness),
    // not a second one. Placed after armSweep so the measurement is the last
    // thing this method does before answering. Issue #152: `ctx` threaded
    // through so a destroy landing DURING this very check is caught too.
    const result = await restartWithFreshVerdict(
      this.syncDeps("readiness"), this.ctx.storage, id, restarted,
      async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)), ctx,
    );
    // Board issue #213: bring-up verified (never before). `null` cfg: same
    // restart/refresh case `workRepoSlug` above already takes.
    // Issue #249 (PR4b): both bring-up wakes, one combined wrapper.
    if (result.readiness?.kind === "provisioned") await this.deliverBringupWakes(null, ctx);
    return withObserved(this.ctx.storage, result);
  }

  /**
   * #96: the snapshot a recycle restores is R2's `latest.tar.gz`, so its
   * upload time IS the age of what survives one. Null = no snapshot.
   */
  private async lastSyncedAt(): Promise<Date | null> {
    return (await this.env.STUDIO_ARCHIVE.head(sessionLatestKey(this.selfId())))?.uploaded ?? null;
  }

  /**
   * Root-cause fix (2026-08-20 operational failure): restart/provision alone
   * can NEVER get a new image onto a studio once its container exists —
   * Cloudflare keeps a container on the image it originally booted with, and
   * both of those RPCs only ever touch whatever container is already
   * running (an exec, same as everything else in this file, never starts a
   * NEW one while the old one is still up). destroy() is Sandbox's own
   * override of Container.destroy (coalesces concurrent callers — see the
   * pinned d.ts's own doc comment) and is the one call in this whole
   * feature that actually removes the running instance.
   *
   * Second review pass (2026-08-20, same day): destroy() ALONE is not
   * enough — a live `fleet recycle` run proved it. `sbAwaitReady` (below,
   * sandbox-api.ts) is what actually closes the gap: its own doc comment
   * has the full mechanism, read from the pinned SDK's compiled source, not
   * guessed. Short version — destroy() resolves before the DO's own
   * bookkeeping catches up to the kill, so calling `this.provision(cfg)`
   * immediately after can run its execs against a container that is not
   * confirmed to exist yet; sbAwaitReady forces the reconciliation AND
   * polls the container-server's own port before this proceeds, so
   * provision()'s guarded clone (first in ITS sequence) is guaranteed to
   * create/reach a fresh instance on whatever image is CURRENTLY configured
   * — THAT combination is the entire fix, not destroy() by itself.
   *
   * `cfg` is built by the route the same way the provision route already
   * builds one (routes.ts) — this studio's own repo/role, parsed from its
   * id. Delegates to `this.provision(cfg)` verbatim (once awaitReady
   * confirms it's safe to) rather than re-implementing any part of its
   * composition: a destroyed container has nothing on disk, so provision's
   * guarded clone genuinely reclones (guardedCloneCmd's shell guard is a
   * no-op only when the checkout survived, which here it never does), its
   * runSessionRestore step rehydrates the session recycleWithSync's own
   * pre-destroy sync just shipped to R2, and bring-up launches claude fresh
   * — cloned, materialized, and with claude launched, never a bare
   * container.
   *
   * A destroy/readiness failure never reaches `this.provision` at all —
   * recycleWithSync builds a degraded StudioStatus, records it, and throws;
   * this method does not catch that throw, so it propagates out of the RPC
   * call and routes.ts turns it into a non-200 (see that file's own recycle
   * branch). This is deliberate and required: the incident this fixes was
   * exactly a recycle that silently reported `running, error: null` over an
   * empty studio, and that must never be possible again.
   *
   * SURVIVES recycle (DO storage — destroy() never touches it): the spawn
   * token and its published hash, the persisted role env / keep_alive
   * provision resolved (ROLE_ENV_KEY/KEEP_ALIVE_KEY), and StudioStatus
   * itself (id, spawnedBy, burn, ...) — provision()'s own `existing` spread
   * carries all of it forward exactly as an ordinary re-provision already
   * does. DOES NOT survive (container filesystem — destroy() wipes it): the
   * git checkout, `~/.claude`, and every other on-disk file the container
   * ever wrote. provision()'s guarded clone and runSessionRestore step
   * exist specifically to rebuild what this feature can persist elsewhere
   * (R2/DO storage) before the container is gone; anything neither of those
   * two covers does not come back.
   */
  async recycle(cfg: ProvisionConfig, discardUnsynced = false): Promise<StudioStatus> {
    // Issue #271: refuse BEFORE recycle's destroy — an unlaunchable account
    // must not cost a running studio its container. Issue #328 fix round 2:
    // this resolution is NOT reused below — recycleWithSync's pre-destroy
    // phase (containerAnswers/syncSessionTick/rescuePush/harvestLearnings) is
    // real async work, uncovered by OPERATION_KEY (that key's own doc
    // comment scopes it to only "the destroy -> reprovision window"), so a
    // concurrent runAccountFailover (failover.ts, driven by this studio's own
    // independent syncSessionCycle alarm) can complete a real account switch
    // and write a new `launchedAccount` while this phase is still running.
    // Reusing this snapshot for envAccount below would then clobber that
    // write with a stale name the moment onStart's recordLaunchedAccount ran
    // — see the awaitReady closure's own comment for the fresh re-derivation
    // that replaces it.
    await launchAccountOrRefuse(this.env, this.ctx.storage, this.selfId(), this.recordFn());
    const { resolveMemoryRepo, commitFile } = this.memoryDeps();
    // Issue #123: an explicit start — the post-destroy sbAwaitReady runs
    // outside provisionCore's own allowance. Issue #152: ONE ctx for this
    // whole recycle call, snapshotted HERE, before `this.destroy()` (the raw
    // Sandbox container kill — NOT destroy.ts's destroyWithSync, so it never
    // bumps the epoch itself) ever runs. Passed straight through to
    // `provisionCore` as `sharedCtx`, so recycle's own internal reprovision
    // step reuses this exact snapshot rather than taking a fresh one — a
    // fresh snapshot taken after recycle's own destroy() would never see an
    // EXTERNAL destroy racing this recycle as a "move" if it happened to land
    // in the gap between the two.
    const result = await this.allowingStart((ctx) => recycleWithSync(
      this.syncDeps("rescue"), this.ctx.storage, this.selfId(),
      // provisionCore, not provision: recycleWithSync runs (and, since issue
      // #37, REPORTS) its own post-provision readiness check, so going
      // through the public provision() would exec the identical check a
      // second time for an answer this function immediately overwrites.
      () => this.destroy(),
      // Issue #328: THIS call is what actually starts the fresh post-destroy
      // container — sbAwaitReady (sandbox-api.ts) wraps startAndWaitForPorts,
      // which (per the pinned @cloudflare/containers compiled source) runs
      // `await this.state.setHealthy(); await this.onStart();` itself, before
      // it resolves — i.e. BEFORE provisionCore below ever gets a chance to
      // run. onStart is launchedAccount's one writer (recordLaunchedAccount),
      // and it reads `this.envAccount` exactly as it stands at that moment.
      // Reassigning `this.envVars`/`this.envAccount` to TODAY's launch HERE,
      // first, is the same envVars/envAccount-before-any-container-touch
      // ordering provisionUngated/restartUngated already use for the
      // identical spawn-token shape of this bug (see the Task 6 FIX comment
      // above provisionUngated) — leaving it only inside provisionCore, as
      // before, updates a field the container has already started (and
      // onStart already recorded) without.
      //
      // Fix round 2 (#328 reopened through a different door): TODAY's launch
      // means re-resolved HERE, not recycle()'s entry-time `launch` — a
      // second, fresh `launchAccountOrRefuse` call, immediately before
      // `envVars`/`envAccount` are set. The entry-time call above still runs
      // first and still refuses early (issue #271: an unlaunchable account
      // must not cost a running studio its container, its own destroy/rescue
      // work), but its resolution is never carried forward into this
      // closure: this studio's syncSessionCycle alarm runs runAccountFailover
      // (failover.ts) independently of recycle's own OPERATION_KEY lock (that
      // key's doc comment: covers only "the destroy -> reprovision window",
      // not this pre-destroy phase), so a failover completing while
      // containerAnswers/syncSessionTick/rescuePush/harvestLearnings above
      // are still running can write a NEW launchedAccount before this point
      // ever runs.
      //
      // Fix round 3 (a fresh review of round 2 found it wasn't literally what
      // it claimed): round 2 fed `envVars` a SECOND, separate storage read
      // (`await this.claudeAccountName()`) rather than this call's own
      // `launch`, and called the two "atomic" — true only in effect, and only
      // because both reads are storage-only, so this codebase's own DO-input-
      // gate semantics happen to keep another invocation from landing between
      // them. That precondition was never itself under test; a later change
      // inserting any non-storage await between them would have silently
      // reopened the race with no test catching it. `envVars` now takes
      // `launch.name` directly — see the closure below — so both fields
      // provably come from this ONE call, structurally, not from two reads
      // that merely happen to agree today. That makes this closure MORE
      // atomic than provisionUngated/restartUngated (see their own
      // launchAccountOrRefuse call above `this.envVars = studioEnvVars(...,
      // await this.claudeAccountName())`): those two sites still carry the
      // same two-separate-calls-with-an-await-between-them shape this round
      // eliminated here, and would benefit from the identical treatment in a
      // future, separate follow-up — not attempted here, out of scope for
      // this fix.
      //
      // Calling launchAccountOrRefuse twice in one recycle is safe: on a
      // launchable account it is a pure re-read (its only write path — an
      // auto-failover-off recorded `claudeAccount` clear — is already
      // idempotent, since the entry call above already performed it if it
      // was going to); on a refusal, this refuses exactly where
      // provisionUngated/restartUngated already refuse, before the new,
      // unlaunchable account's container ever starts, and recycleWithSync's
      // own surrounding try/catch (see its doc comment on that catch)
      // already treats every awaitReady failure identically — a launch
      // refusal reaching it here is not a new case to handle. This reasoning
      // is an invariant of TODAY's launchAccount/failover behavior (the two
      // calls cannot currently disagree on refuse-vs-succeed) — not a
      // structural guarantee. A future change to either launchAccount or the
      // failover write path should re-check this paragraph before assuming
      // the two calls can never diverge.
      //
      // Scope, honestly: this (rounds 2+3, together) closes recycle's OWN
      // extra exposure — the pre-destroy phase above, genuinely uncovered by
      // OPERATION_KEY — bringing recycle to PARITY with provisionUngated/
      // restartUngated, not past them. A window neither this fix nor those
      // two paths close remains, shared by all three: onStart (this file's
      // launchedAccount writer) fires from INSIDE sbAwaitReady itself — real
      // network work, container start + port poll — reading `this.envAccount`
      // as an in-memory snapshot that is never re-read from storage during
      // that wait. A runAccountFailover completing WHILE sbAwaitReady is
      // running (not before it, which is everything above addresses) can
      // still be clobbered the instant onStart runs. This is not new here —
      // provision/restart have always had it — and closing it is a separate,
      // larger task (onStart itself re-deriving fresh, or the whole account-
      // resolution model changing), out of scope for #328's "after recycle"
      // symptom. Flagged for a follow-up issue, not silently left
      // undocumented.
      async () => {
        // loadOrMintSpawnToken, not ensureSpawnToken: storage-only (its own
        // doc comment), no status write/registry publish — this step must
        // never itself put a row on D1 before the destroy-epoch check that
        // follows provision() gets a chance to veto one (issue #152/#240).
        // The token is static for the studio's whole lifetime (Task 6
        // ruling) and provisionCore's own ensureSpawnToken republishes its
        // hash exactly as before if it ever needs to.
        const spawnToken = await loadOrMintSpawnToken(this.ctx.storage);
        const launch = await launchAccountOrRefuse(this.env, this.ctx.storage, this.selfId(), this.recordFn());
        // Review round 3, finding 1: `launch.name` straight from the call
        // just above, NOT a second (now-removed) claudeAccountName() storage
        // read — see this closure's own doc comment for why the second read
        // was never actually atomic with this one, only practically safe on
        // an unstated DO-input-gate precondition. Both fields below now come
        // from the ONE resolved `launch`, with no read, storage-only or not,
        // in between.
        ({ envVars: this.envVars, envAccount: this.envAccount } = launchFields(this.env, this.selfId(), spawnToken, launch.name));
        await sbAwaitReady(this);
      },
      (c) => this.provisionCore(c, "recycle", ctx),
      async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)), cfg,
      resolveMemoryRepo, commitFile, { discardUnsynced, lastSyncedAt: () => this.lastSyncedAt() },
      this.ctx.storage, ctx,
      // Board issue #213: wired only on the "provisioned" branch inside
      // recycleWithSync itself — see that function's own call site. Reuses
      // this SAME `ctx` (recycle's own, snapshotted above) so a destroy
      // landing mid-recycle vetoes the delivery exactly like issue #174's
      // other bring-up writes.
      // Issue #249 (PR4b): both bring-up wakes, one combined wrapper.
      () => this.deliverBringupWakes(cfg, ctx),
    ));
    return withObserved(this.ctx.storage, result);
  }

  /**
   * Task 4's memory adapters (resolveMemoryRepo/commitFile), factored out
   * of `recycle` and `destroyStudio` — both built the identical pair of
   * closures inline before this (code review, board task #124), which is
   * exactly the "reimplemented, not reused" trap `destroyStudio`'s own
   * `workRepoSlug` fix right below this method exists to avoid too. Each
   * commit mints its own token (#346, on #339): scoped to the ops repo,
   * narrowed to contents:write -- a harvest writes only a handful of files.
   *
   * `resolveMemoryRepo` reads FLEET_OPS_REPO (issue #341, src/memory/store.ts)
   * -- null when memory is off; no fetch. `commitFile` itself does not pick a repo: it
   * just writes wherever it's told, which is what makes the resolution
   * TESTABLE (harvestLearnings' own suite fakes this closure and pins the
   * repo it resolves to — see recycleWithSync's own tests).
   */
  private memoryDeps(): { resolveMemoryRepo: ResolveMemoryRepo; commitFile: CommitLearningFile } {
    return {
      resolveMemoryRepo: async () => memoryRepoFromEnv(this.env),
      // #346 (on #339): Worker-side only; scoped to the ops repo, contents:write.
      commitFile: async (repo, path, content, message) => {
        await createRepoFile(await mintRepoToken(this.env, repo, { permissions: { contents: "write" } }), repo, path, content, message);
      },
    };
  }

  /**
   * Fleet board task #124: `fleet destroy <id> [--force]` — recycle can
   * never leave a studio stopped (it always reprovisions); this is the FIRST
   * verb that can. Runs the identical pre-destroy sequence `recycle` does
   * (session sync, rescue-push, learning-harvest — see `destroyWithSync`'s
   * own doc comment, destroy.ts, for why none of that changed) and then
   * destroys the container WITHOUT reprovisioning, persisting `state:
   * "stopped"` rather than recycling back to `"running"`.
   *
   * Refuses (a tagged `{ ok: false, refused: true }`, never a bare throw —
   * see DestroyOutcome's own doc comment for why) when this studio still
   * carries an open assigned board task, OR when that cannot be confirmed at
   * all (a board lookup failure) — unless `force` is passed. Gated by its
   * OWN primitive (`openTaskChecker(this.env)`, board/routes.ts), a sibling
   * of, not the same as, task #118's `resolveAssignedBrief` wiring in
   * `deps()` above — see `runDestroy`'s own doc comment (destroy.ts) for why
   * a destructive action needs a fail-CLOSED check instead of that
   * resolver's fail-open one. `workRepoSlug` is resolved the same way every
   * other bodyless (no-`ProvisionConfig`) entry point resolves it: this
   * studio's own `workRepoSlug()` helper. `repo` (rescue-push/harvest's OWN
   * target, the `/workspace/<repo>` checkout dir) comes from parsing this
   * studio's own id, since a bodyless destroy carries no ProvisionConfig to
   * read `cfg.repo` off of the way `recycle` does.
   *
   * Never touches the board task itself on ANY path — the refusal is read-
   * only, and the destroy path this reaches has no board call in it at all
   * (see this file's own header for why destroy.ts is where the board task's
   * label/state stay untouched by construction, not by a special case here).
   */
  async destroyStudio(force: boolean, discardUnsynced = false, park = false): Promise<DestroyOutcome> {
    const workRepoSlug = await this.workRepoSlug(null);
    const repo = parseStudioId(this.selfId())?.repo ?? this.selfId();
    const { resolveMemoryRepo, commitFile } = this.memoryDeps();
    // Round 3 review, fix 4: incremented for the ENTIRE runDestroy call (the
    // board task refusal gate included — a brief, harmless over-approximation
    // on that early-return path), decremented in this `finally` on every
    // exit, throw included, so it can never outlive this one call. See
    // `destroyInFlightCount`'s own doc comment (its field declaration, above)
    // for why this must be in-memory only, why that is safe for T8's own
    // orphan-marker recovery, and (issue #240) why a counter rather than a
    // boolean is what keeps two overlapping calls from clobbering each other.
    this.destroyInFlightCount += 1;
    try {
      return await runDestroy(
        openTaskChecker(this.env), this.selfId(), workRepoSlug, force,
        this.syncDeps("rescue"), this.ctx.storage, this.selfId(),
        // A stopped studio stays stopped: every loop left armed would exec
        // into the destroyed container on its next tick, and an exec STARTS
        // it. Disarmed only once destroy() resolved — a failed destroy leaves
        // a degraded studio whose loops must keep running.
        async () => {
          await this.destroy();
          disarmStudioTicks((name) => this.deleteSchedules(name));
        },
        async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)), repo,
        resolveMemoryRepo, commitFile,
        // #113: F1 (no exec into a container that is not running) and M3
        // (recycle's refusal on a failed probe). `--force` is "destroy anyway",
        // so it also passes the probe guard.
        {
          containerRunning: () => this.ctx.container?.running === true,
          // #129 F2: a mid-boot container is waited out before the probe.
          containerBooting: () => sbContainerBooting(this),
          awaitBoot: () => sbAwaitReady(this),
          discardUnsynced: discardUnsynced || force,
          discardFlag: discardUnsynced ? "--discard-unsynced" : "--force",
          lastSyncedAt: () => this.lastSyncedAt(),
        },
        this.ctx.storage,
        park,
      );
    } finally {
      // Never below 0 — defensive only; a well-formed increment/decrement
      // pair can never actually underflow this, but a stray extra decrement
      // must never wrap into treating every subsequent destroy as absent.
      this.destroyInFlightCount = Math.max(0, this.destroyInFlightCount - 1);
    }
  }

  /**
   * Issue #251: `fleet rescue-all`'s per-studio exec — the maestro runs this
   * right before any image deploy, against every studio ITS OWN caller
   * already knows is running (routes.ts's `rescue-all` action; cmdRescueAll,
   * cli/fleet.ts). Gated here too, defense in depth, the SAME
   * `ctx.container.running` property check `destroyStudio` above already
   * uses — never an exec, so checking it first never starts a stopped
   * container: `{ ok: false, error: "not running" }` without ever calling
   * `rescuePush`.
   *
   * Running: originally reused `rescuePush` unchanged — but that means `git
   * add -A` + `git commit --no-verify` against THIS studio's real, live
   * index and branch: correct at teardown (the container is dying anyway,
   * mutating its own doomed checkout is fine) but WRONG here — `rescue-all`
   * runs against studios that are still actively worked on, and committing
   * + moving HEAD out from under a live agent's own mid-edit diff is itself
   * a mutation this command must never cause. Issue #266: `rescueNow` now
   * calls `rescueSnapshot` (do.ts, below) instead — same per-worktree walk,
   * same generated `fleet/rescue/...` refs, same `RescueResult` shape, but
   * built on rescueSnapshotCmd (rescue.ts), which commits a dirty tree via a
   * detached, out-of-band `GIT_INDEX_FILE` and `commit-tree` (never the real
   * `.git/index`, never moving HEAD/the checked-out branch) and pushes that
   * floating commit object directly by SHA — the real working tree, index,
   * and HEAD read byte-identical before and after. Teardown's own call sites
   * (destroy.ts, this file's own recycleWithSync) are UNCHANGED: they still
   * call `rescuePush`/`rescuePushCmd`, mutating on purpose, because the
   * container is about to die regardless. `pushes` is `[]` on either quiet
   * outcome (no checkout yet, clean, or markers-only: nothing lost, nothing
   * to report) and the full list of rescue refs actually pushed otherwise.
   */
  async rescueNow(): Promise<
    | { ok: true; pushes: { branch: string; files: number; kind: RescuePushKind }[]; worktrees?: RescueWorktree[] }
    | { ok: false; error: string; worktrees?: RescueWorktree[] }
  > {
    if (this.ctx.container?.running !== true) return { ok: false, error: "not running" };
    const repo = parseStudioId(this.selfId())?.repo ?? this.selfId();
    try {
      const result = await rescueSnapshot(this.syncDeps("rescue"), repo, this.selfId());
      return {
        ok: true,
        pushes: result.pushed ? (result.pushes ?? [{ branch: result.branch!, files: result.files, kind: result.kind! }]) : [],
        // Issue #39: rescue-all prints one line per worktree.
        ...(result.worktrees ? { worktrees: result.worktrees } : {}),
      };
    } catch (err) {
      return {
        ok: false, error: err instanceof Error ? err.message : String(err),
        ...(err instanceof RescuePushFailedError && err.worktrees.length > 0 ? { worktrees: err.worktrees } : {}),
      };
    }
  }

  /**
   * Read-only: "is this studio actually provisioned right now?", answered by
   * the container itself (provision.ts's provisionedCheckCmd) rather than
   * inferred from what the registry last recorded.
   *
   * Destroys nothing, provisions nothing, writes no storage — the whole point
   * of exposing this separately from `recycle`, which answers the same
   * question but only as a side effect of tearing the container down and
   * rebuilding it. `GET /studio/:id/provisioned` (routes.ts) is the caller;
   * `ff` polls it before attaching, so nobody lands in a bare container.
   *
   * `repo` is the SHORT name — the `/workspace/<repo>` checkout directory,
   * i.e. the studio id's own repo segment, which is what routes.ts passes.
   */
  async checkProvisioned(repo: string): Promise<ProvisionedVerdict> {
    return checkProvisionedGated(this.ctx.storage, this.syncDeps("readiness"), repo);
  }

  /**
   * Scheduled callback — named, not an alarm() override: Container/Sandbox
   * owns alarm() (see AgentDO's own doc comment at src/agents/do.ts:263).
   * Confirmed before writing this: the nested Sandbox Container base
   * (@cloudflare/sandbox's own bundled @cloudflare/containers@0.3.7)
   * exposes the identical `schedule<T>(when, callback, payload?):
   * Promise<Schedule<T>>` / `deleteSchedules` / `alarm()` surface as the
   * top-level @cloudflare/containers@0.0.20 AgentDO/DeployDO extend — see
   * task-7-report.md for the exact d.ts grep of both. Reschedules itself
   * at its own tail, exactly like AgentDO's pollTask, so the refresh
   * recurs every REFRESH_SECONDS regardless of whether this cycle succeeded
   * or degraded — a degraded studio keeps retrying on its own; the operator
   * doesn't have to restart it just to get the next mint attempt.
   *
   * Review round 1, I2: the reschedule lives in `finally`, not as a second
   * bare statement after the await above. refreshWithStorage's own
   * runRefreshCredential already catches every mint/sbExec failure, but
   * `deps.recordStudio` (a D1 write) and `storage.put` are real I/O this
   * function does NOT guard — a transient failure in either would otherwise
   * throw straight out of this method. There is no studio watchdog
   * (unlike AgentDO's cron-driven staleTasks() re-arm) to notice a
   * schedule chain that silently stopped, so an unguarded throw here would
   * end the refresh loop forever, not just for one cycle — the same wedge
   * class agents/do.ts's pollAndClearRearm doc comment describes for
   * clearRearm, fixed here by guaranteeing the reschedule instead of
   * guaranteeing the write.
   */
  async refreshToken(): Promise<void> {
    await runScheduledTick(
      this.ctx.storage,
      async () => {
        await refreshWithStorage(this.refreshDeps(await this.workRepoSlug(null)), this.ctx.storage, this.selfId());
      },
      () => this.rearm("refreshToken", REFRESH_SECONDS),
      "refreshToken",
    );
  }

  /**
   * Task 2 (P2)'s scheduled callback — same named-callback/reschedule-in-
   * finally idiom as refreshToken() above (no deleteSchedules here: firing a
   * schedule consumes it, so only provision()'s repeatable ENTRY POINT needs
   * that guard, not this loop's own tail — see refreshToken()'s identical
   * shape). Deliberately a try/catch here, not refreshToken()'s bare
   * try/finally: the task brief's own ruling is explicit — "Ship failure
   * NEVER touches state/error/lastRefreshError — transcript is
   * observability. Your DO catch logs and continues." refreshToken() can
   * let a storage/D1 failure propagate because nothing downstream depends on
   * that promise settling cleanly; shipTranscript's failures must never
   * become a studio-visible error, so this is the one place in the file that
   * swallows instead of only guaranteeing the reschedule.
   *
   * #367: also passes the `archive` config (this studio's own DoneRecordPorts
   * plus resolveMemoryRepo) so `runShipTickWithObservation` archives
   * completion records on THIS tick's own cadence (SHIP_TRANSCRIPT_SECONDS),
   * not only at the pre-destroy teardown — see that function's own doc
   * comment for why this closes the "container dies some other way" record-
   * loss window down to one tick.
   */
  async shipTranscript(): Promise<void> {
    await runScheduledTick(
      this.ctx.storage,
      async () => {
        try {
          await runShipTickWithObservation(
            this.shipDeps(), this.ctx.storage, this.selfId(),
            // Already wrapped via withObserved per Task 2 — kept here anyway
            // for the explicit-transition-write path's own D1 body.
            (s) => recordStudio(this.env, s),
            undefined,
            { doneRecords: this.doneRecordPorts(), resolveOpsRepo: this.memoryDeps().resolveMemoryRepo },
            () => this.autoStartSubmitted(),
            () => this.notifyStaleBackgroundShell(),
          );
        } catch (err) {
          console.error("studio transcript ship failed", err);
        }
      },
      () => this.rearm("shipTranscript", SHIP_TRANSCRIPT_SECONDS),
      "shipTranscript",
    );
  }

  /**
   * Task 3 (P2 plane 2)'s scheduled callback — same reschedule-in-finally
   * idiom as refreshToken()/shipTranscript() above. Board issue #24: the
   * three-step body used to live directly here, all under ONE try/catch, so
   * a throwing syncSessionTick (measured, real: a fresh container tar/stat-
   * ing before claude has ever written ~/.claude/projects) meant
   * mirrorBurnToRegistry and checkAndRecordReadiness never ran at all —
   * StudioStatus.readiness was never stamped, and fleet ls's READY column
   * stuck at "?" forever even for a studio that was actually healthy. Fixed
   * by extracting the body into syncSessionCycle -- the same pattern
   * `restartWithSync` establishes (above) for exactly this constraint:
   * StudioDO cannot be constructed under vitest-pool-workers, see this
   * file's own header, so the method's real logic lives in an exported pure
   * function a real `this.ctx.storage` satisfies structurally, and the
   * class method stays a thin forward. This method now only calls it and
   * guarantees the reschedule, unconditionally, exactly as before.
   */
  async syncSession(): Promise<void> {
    await runScheduledTick(
      this.ctx.storage,
      () => syncSessionCycle(
        this.syncDeps("sync"), this.ctx.storage, this.selfId(),
        async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)),
        this.failoverDeps(),
        // Issue #71's heal. Deliberately `restartStudio()` and not a narrower
        // call: it is the SAME path an operator's own recovery takes, so it
        // carries the credential refresh, #38's on-disk verification, that
        // path's own one-shot retry and a freshly measured verdict. A heal
        // that invented its own notion of "came up correctly" would be a
        // second definition of ready, which is exactly what issue #37 spent a
        // release removing.
        () => this.restartStudio("heal"),
        this.ctx.storage,
        // Issue #249 (PR4b) round 2, item 2: the deferred re-brief's retry.
        // Costs a single storage read on a studio that owes nothing.
        () => this.retrySurvivalBrief(),
        // Board #350: always wired (installCacheDeps() itself is cheap —
        // no exec, no R2 call happens until runInstallCacheSaveTick actually
        // needs one), gated per-studio inside the tick by repoSlug + the
        // INSTALL_CACHE_REPOS gate, not by whether this is passed at all.
        this.installCacheDeps(),
        // Round 3 review, item 3: the SAME guard object every tick this
        // isolate runs — see installCacheSaveGuard's own doc comment above.
        this.installCacheSaveGuard,
      ),
      () => this.rearm("syncSession", SYNC_SESSION_SECONDS),
      "syncSession",
    );
  }

  /**
   * Give this studio's Claude session a turn.
   *
   * The whole waker rests on this one call: a session acts only when
   * something types into its tmux window, and `sbExec` is the Worker's only
   * way in. Board issue #82: this is the SAME point all three of this
   * method's callers reach through — the GitHub webhook's `wakeMaestro`, the
   * post-spawn `notifyMaestro`, and the `POST /studio/:id/wake` route — and
   * NONE of them had established "stopped" before calling it, so a webhook
   * delivery alone could resurrect (and bill) a studio an operator had
   * deliberately shut down. Delegates to `runGatedWake` (wake.ts) — the exact
   * two gates `wakeStudioOnAssignment` below already runs, over the same
   * `recordedState`/`sbExec` deps shape — rather than the raw, unconditional
   * `runWake`, so every caller of THIS method now gets the stopped-or-never-
   * provisioned check and the claude-pane probe before a single keystroke
   * reaches the container. The body lives in `wakeStudioWith` (issue #100),
   * so tests run the real thing. `runGatedWake` delegates to `runWake` once both
   * gates pass, so a landed wake still sends the byte-identical command
   * test/bun/wake-cmd.test.ts runs against a real tmux server.
   *
   * Total by construction — `runGatedWake` never throws. A caller that gets
   * `{ok:false}` has a studio that is stopped, has no claude session in its
   * pane, or whose window is gone — never a broken Worker.
   */
  async wakeStudio(prompt: string): Promise<WakeOutcome> {
    return singleFlightWake(this.wakeLock, () => wakeStudioWith(
      this.ctx.storage, (cmd: string) => sbExec(this, cmd, EXEC_CLASSES.wake), this.isMaestro(), () => this.armSweep(), prompt,
      undefined, this.selfId(),
    ));
  }

  /**
   * Board issue #41, half one: the wake a BOARD ASSIGNMENT fires, for a
   * studio of ANY role.
   *
   * Separate from `wakeStudio` above rather than a flag on it — not because
   * the two run different gates any more (board issue #82 put `wakeStudio`
   * through this same `runGatedWake`), but because they still differ on
   * money the gate can't decide: sweep-arming. Stopped-or-never-provisioned
   * is answered from THIS DO's stored status (never the D1 registry mirror —
   * `sweepMaestro`'s own ruling, for the same reason), and the pane is probed
   * with the same `pane_current_command` signal the readiness check reads
   * before a single keystroke is sent.
   *
   * The stopped gate is what keeps requirement 2 true: `sbExec` STARTS a
   * container that is not running, so the gate has to be answered from
   * storage, before any exec, or the refusal has already cost what it was
   * refusing to spend.
   *
   * Does NOT arm the sweep, unlike `wakeStudio`. Arming is maestro's own
   * supervision clock, and this method's whole reason to exist is the studios
   * that are not maestro. A maestro assigned a task still reaches `armSweep`
   * through every other path that wakes it.
   *
   * Total by construction — `runGatedWake` never throws.
   */
  async wakeStudioOnAssignment(prompt: string, clearDraftFirst = false): Promise<WakeOutcome> {
    return singleFlightWake(this.wakeLock, () => runGatedWake(
      {
        recordedState: () => gatedStateIn(this.ctx.storage, () => new Date()),
        switchedBlock: () => switchedBlockIn(this.ctx.storage),
        limitSighting: () => limitSightingIn(this.ctx.storage),
        exec: (cmd: string) => sbExec(this, cmd, EXEC_CLASSES.wake),
        studioId: this.selfId(),
      },
      prompt,
      clearDraftFirst,
    ));
  }

  /**
   * Board issue #47 — the read-only inspection path. `pane_current_command`
   * for `studio:claude`, whether the checkout exists, and the last N lines
   * of that pane's buffer, all via `tmux capture-pane -p` — never `sbExec
   * ATTACH` (that entry point does not exist; `fleet attach` goes through
   * `sbAttachPty`/`proxyTerminal` entirely separately, see sandbox-api.ts's
   * own doc comments), so this never opens the pty WebSocket, never runs
   * `container/studio-shell.sh`, and therefore never runs `tmux attach` at
   * all. See src/studio/inspect.ts's own header for the full mechanism and
   * the empirical proof (test/bun/inspect-cmd.test.ts, run against a real
   * tmux server) that a `capture-pane -p` call registers zero clients and
   * leaves `window-size`/`aggressive-resize` untouched.
   *
   * Same stopped/never-provisioned gate `wakeStudioOnAssignment` runs above,
   * for the identical reason: `sbExec` starts a container that is not
   * running, so the refusal has to be answered from THIS DO's own stored
   * status, before any exec, or looking at a studio would cost what looking
   * was supposed to avoid.
   *
   * Total by construction — `runInspect` never throws.
   *
   * Issue #85, maestro correction #12: `runInspect` above stays TOTAL and
   * exec-only, exactly as board #91 built it — this wrapper is the one new
   * thing this issue adds at this boundary: the DO's own stored `Observed`
   * record, attached with ZERO additional container exec, on BOTH branches
   * of `runInspect`'s own outcome. A container-side failure (the exec
   * deadline firing, or a refusal) previously left an operator with only an
   * error string — `observed` now rides along regardless, since it costs
   * nothing beyond a storage read and is exactly the signal an operator
   * needs most when the live exec path itself is what just failed.
   *
   * Issue #228 item 5: `sessionForceArmedAt` rides along the same way, on
   * both branches — `fleet inspect`'s own studio-detail view is the other
   * surface (besides `fleet ls`) an armed force-next-sync override was
   * invisible on. Read via `getStatusWithStorage` (provision.ts), not a raw
   * `this.ctx.storage.get(STATUS_KEY)`, so this method's own gate above stays
   * the only thing here that reads the recorded STATE (via `gatedStateIn`) —
   * see test/studio.wake-gate.test.ts's own source-pinned test on this
   * method for why that distinction is enforced.
   */
  async inspect(repo: string, tailLines?: number): Promise<InspectOutcome & { observed: Observed; sessionForceArmedAt: string | null }> {
    const outcome = await runInspect(
      {
        recordedState: () => gatedStateIn(this.ctx.storage, () => new Date()),
        exec: (cmd: string) => sbExec(this, cmd, EXEC_CLASSES.inspect),
        lastSyncedAt: () => this.lastSyncedAt(),
        now: () => new Date(),
      },
      repo, tailLines,
    );
    // Issue #221: `observed.activity` rides `fleet inspect` too — see
    // `getObservedWithActivity`'s own doc comment.
    const observed = await getObservedWithActivity(this.ctx.storage);
    const status = await getStatusWithStorage(this.ctx.storage, this.selfId());
    return { ...outcome, observed, sessionForceArmedAt: status.sessionForceArmedAt ?? null };
  }

  /**
   * Only a maestro sweeps. Every studio shares this class, so the role — the
   * studio id's own second segment — is what decides, never a stored flag
   * that could disagree with the id.
   *
   * Issue #269 (round 2): also requires instance 1. Maestro is a SINGLETON
   * role (`spawn.ts`'s `runSpawn` refuses any instance >1 for it), but this
   * check must not TRUST that refusal alone — a second sweep loop from a
   * stray `x--maestro--2` would double-fire every wake this class arms
   * (wake-events.ts's own `maestroIdFor` only ever wakes the bare id), so
   * `isMaestro()` reads the id's own instance too, the same defense in depth
   * the id grammar already gives every other role-based decision in this
   * file.
   */
  private isMaestro(): boolean {
    const id = parseStudioId(this.selfId());
    return id?.role === "maestro" && id.instance === 1;
  }

  /**
   * Start (or restart) the 20-minute sweep clock.
   *
   * `deleteSchedules` FIRST, for the reason provision()'s own refreshToken
   * arming states: the library always inserts a fresh schedule row and never
   * dedupes by callback name, so without it every wake would stack another
   * permanent sweep loop beside all its predecessors — and a wake is the one
   * thing that happens often.
   *
   * Also the RE-ARM the design spec asks for. Task assigned, studio spawned,
   * PR opened, operator asks: all of them arrive as a wake, and a wake clears
   * the quiescent streak and the recorded stop, so a fleet that went quiet
   * and then got work again resumes supervision from zero rather than from a
   * streak that was already one sweep from stopping.
   */
  private async armSweep(): Promise<void> {
    this.deleteSchedules("sweepMaestro");
    await this.ctx.storage.put(QUIESCENT_STREAK_KEY, 0);
    await this.ctx.storage.delete(SWEEP_STOPPED_KEY);
    await this.schedule(SWEEP_SECONDS, "sweepMaestro");
  }

  /**
   * The quiescence check's four ports, concretely wired — registry for
   * studios, the SAME `githubBoardApi`/`listTasks` pair every board caller
   * uses, and one GitHub read for open PRs.
   *
   * Every port THROWS on failure rather than degrading to an empty answer.
   * That is the whole contract: `checkQuiescence` is fail-CLOSED, and it can
   * only refuse quiescence on a broken check if the break actually reaches
   * it. A port that swallowed its own error into `[]` would report a
   * finished fleet, which is the exact failure this design forbids.
   */
  private quiescenceDeps(repoSlug: string): QuiescenceDeps {
    const api = githubBoardApi(this.env);
    const repo = repoSlug.toLowerCase();
    const assignedTasks = async (studioId: string) => {
      const result = await listTasks(api, repo, { assignedTo: studioId });
      if (!result.ok) throw new Error(`board read failed (${result.status}): ${result.message}`);
      return result.value;
    };
    return {
      // "stopped" is the only state that means nothing is running; a
      // "degraded" or "provisioning" studio is still a container the fleet
      // has to account for.
      runningStudios: async () =>
        (await listStudios(this.env)).filter((s) => s.state !== "stopped").map((s) => s.id),
      openTasksFor: async (studioId) => (await assignedTasks(studioId)).filter((t) => t.open).map((t) => t.number),
      openPulls: async () => listOpenPullNumbers(await mintRepoToken(this.env, repo), repo),
      // The studio's most recent envelope, read off its most recently
      // touched open task. Newest comment first: a task accumulates
      // envelopes, and only the last one describes where the studio is now.
      latestEnvelope: async (studioId) => {
        const open = (await assignedTasks(studioId)).filter((t) => t.open);
        if (!open.length) return null;
        const newest = [...open].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]!;
        const comments = await api.listComments(repo, newest.number);
        for (let i = comments.length - 1; i >= 0; i--) {
          const doc = parseEnvelopeComment(comments[i]!.body);
          if (doc) return doc;
        }
        return null;
      },
    };
  }

  /**
   * Scheduled callback — the sweep. Named, not an `alarm()` override, for the
   * reason refreshToken()'s own comment gives (Container/Sandbox owns alarm).
   *
   * Studios emit no events, so this is the ONLY detector of a container that
   * died, went bare, or left READY stale. It is not a fallback for the
   * webhook branch and does not go away when webhooks are live.
   *
   * THE RESCHEDULE LIVES IN `finally`. Not a bare tail statement — same
   * ruling, same reason, as refreshToken() above: there is no watchdog
   * anywhere that re-arms a studio schedule, so one unguarded throw ends
   * supervision permanently and silently. `stop` starts false and is only
   * ever set from a fully decided sweep (two consecutive confirmed-quiescent
   * checks AND a FINAL wave that landed), so every failure path — a throw, a
   * broken quiescence check, an unlandable wake — falls through to the
   * re-arm. Fail-CLOSED at this layer too: stopping is the gate.
   */
  async sweepMaestro(): Promise<void> {
    let stop = false;
    await runScheduledTick(
      this.ctx.storage,
      async () => {
        try {
          const repoSlug = await this.workRepoSlug(null);
          const result = await sweepTick(
            {
              quiescence: this.quiescenceDeps(repoSlug),
              // Read from THIS DO's own stored status, not the D1 registry: the
              // registry is a mirror, and a sweep that resurrected a stopped
              // container because the mirror lagged would be the same class of
              // bug as trusting a stale readiness row.
              isStopped: async () => (await this.ctx.storage.get<StudioStatus>(STATUS_KEY))?.state === "stopped",
              wake: (prompt: string) => singleFlightWake(this.wakeLock, () => sweepWake(
                this.ctx.storage, (cmd: string) => sbExec(this, cmd, EXEC_CLASSES.wake), this.selfId(), prompt,
              )),
            },
            this.ctx.storage,
          );
          // Issue #136: a limited maestro's refusal is a skip (info), not an
          // error every 20 minutes.
          logWakeOutcome("maestro sweep wake", result.wake);
          stop = result.stop;
        } catch (err) {
          console.error("maestro sweep failed", err);
        }
      },
      async () => {
        if (!stop) await this.rearm("sweepMaestro", SWEEP_SECONDS);
      },
      "sweepMaestro",
    );
  }

  /**
   * Issue #95: the cron's stopped-but-billing probe. Reads the Containers
   * runtime's own `ctx.container.running` — a property, not an exec, so it
   * never starts the container it is asking about. See container-watch.ts.
   */
  async watchContainer(): Promise<void> {
    await observeContainer(
      this.ctx.storage, this.ctx.container?.running === true,
      async (s: StudioStatus) => recordStudio(this.env, await withObserved(this.ctx.storage, s)),
      new Date(),
    );
  }

  async pasteImage(contentType: string, bytes: Uint8Array): Promise<{ path: string }> {
    return pasteWithStorage({ writeFile: (path, b) => sbWriteFile(this, path, b) }, this.ctx.storage, contentType, bytes);
  }
}

/**
 * `ProvisionDeps.applyStudioGitSafety`'s body (issue #253), lifted OUT of
 * `deps()` so that a test can reach it. `deps()` is a private method on a
 * Durable Object, so nothing in the suite could ever call the port it builds —
 * which is exactly why "the port never runs the install command at all"
 * survived every test in the repo (maestro round 2, item 5). `deps()` wires
 * this function and nothing else, so asserting on it is asserting on what the
 * DO really does.
 *
 * Takes the one thing the port depends on: an `sbExec`-shaped callable. No
 * token and no mint, unlike the two credential ports next to it.
 */
export async function applyStudioGitSafetyPort(
  exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await exec(studioGitSafetyCmd());
    if (res.code !== 0) {
      throw new Error(`git safety config/wrapper install failed (${res.code}): ${res.stderr.slice(0, 500)}`);
    }
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: redactSecrets(err instanceof Error ? err.message : String(err)) };
  }
}

/** `ProvisionDeps.installLeakGate`'s body (issue #1), outside `deps()` for
 *  the same testability reason as applyStudioGitSafetyPort just above. */
export async function installLeakGatePort(
  exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await exec(leakGateInstallCmd());
    if (res.code !== 0) throw new Error(`leak gate install failed (${res.code}): ${res.stderr.slice(0, 500)}`);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: redactSecrets(err instanceof Error ? err.message : String(err)) };
  }
}
