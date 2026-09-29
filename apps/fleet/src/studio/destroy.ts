// Fleet board task #124: `fleet destroy <id> [--force]` — the operator has
// no way to stop a studio today. `recycle` destroys the container AND
// reprovisions; it can never leave a studio stopped. This module is the
// "pure logic split out of do.ts" half of that feature, the same convention
// provision.ts's own header documents (runProvision/runSessionRestore live
// there, not in do.ts, so they can be unit-tested without a live
// container-backed StudioDO — see that header for why a live StudioDO
// cannot be constructed under vitest-pool-workers at all).
//
// `destroyWithSync` mirrors do.ts's `recycleWithSync` for its pre-teardown
// half: the same 8s probe, the same refusal when a RUNNING container fails
// it (#113 M3; `--discard-unsynced` or `--force` pays that price), the same
// skip for a row already recorded stopped, and the same sync/rescue-push/
// learning-harvest steps. Two things recycle does not need: no exec at all
// into a container that is not running (#113 F1 — an exec boots it), and a
// wait for a mid-boot container before the probe (#129 F2). It
// diverges only at the very end: there is no `awaitReady`/`provision` tail
// at all. A destroyed studio must never come back on its own; reprovisioning
// is exactly the behavior this feature exists to NOT have. Because of that,
// this function needs no readiness wait either — recycleWithSync's own
// awaitReady exists solely to make provision()'s first exec race-free
// against the just-destroyed container (see its doc comment), and nothing
// here ever execs against the container again after `destroy()` returns.
//
// `runDestroy` is the one layer above it: the "does this studio have an
// open assigned board task" refusal gate, gated by its OWN board primitive
// (`openAssignedTasks`, board/board.ts; `openTaskChecker`, board/routes.ts)
// — a sibling of, NOT a reuse of, task #118's `resolveLatestAssignedBrief`/
// `assignedBriefResolver`. That pair fails OPEN on a board lookup failure
// (correct for the bringup fallback it backs); this refusal gate must fail
// CLOSED instead, so it gets its own primitive rather than repurposing
// theirs — see `runDestroy`'s own doc comment for why. The refusal MUST
// happen before any of destroyWithSync's own steps ever run — a board task
// must never race a rescue-push/harvest that could still save work for it —
// so it lives in its own function, ahead of (and outside) destroyWithSync's
// own try/catch scaffold, rather than folded into it. Kept here, not inline
// in do.ts's `destroyStudio` method, for the identical testability reason
// destroyWithSync itself is here: a live StudioDO cannot be constructed
// under vitest-pool-workers, so any branch worth covering has to be a plain
// function taking its dependencies as arguments.
import type { StudioStatus } from "./types";
import { STATUS_KEY, DESTROYING_KEY, freshStatus, bumpDestroyEpoch, type StudioStorage } from "./provision";
import {
  syncSessionTick, shipAsideSessions, asideNotShippedNote, type SessionSyncDeps, type SessionSyncStorage,
} from "./session-sync";
import { redactSecrets } from "./redact";
import {
  rescuePush, harvestLearnings, archiveDoneRecords, learningsLostNote, deliveredTaskIn, recordSnapshotOnSuccess, containerAnswers, CONTAINER_PROBE_MS,
  clearConsumedForceStamp, RescuePushFailedError,
  type ResolveMemoryRepo, type CommitLearningFile, type DoneRecordHashStorage,
} from "./do";
import type { ObservedStorage } from "./observed";
import { recycleCostLine, LIVENESS_RULE } from "./recycle-cost";

/** Every probe refusal starts with this — the same prefix convention as
 *  recycle's RECYCLE_REFUSED_PREFIX (recycle-cost.ts). runDestroy turns it
 *  into its tagged refusal, which routes.ts answers with 409. */
export const DESTROY_REFUSED_PREFIX = "destroy refused: ";

/** Recycle's guard (issue #96), applied to destroy (#113 review, M3). */
export interface DestroyGuard {
  /** `this.ctx.container.running` — a property, never an exec: an exec
   *  STARTS a stopped container (#113 F1). */
  containerRunning: () => boolean;
  /** #129 F2: running (start() called) but not yet healthy — mid-boot. */
  containerBooting?: () => Promise<boolean>;
  /** #129 F2: wait that boot out, under bring-up's own bounded budget. */
  awaitBoot?: () => Promise<void>;
  /**
   * #113 review M3: the probe-refusal escape hatch. PR #263 round 3 (#251
   * review), N3: ALSO the escape hatch for a genuine, confirmed rescue-push
   * failure (a `RescuePushFailedError` — see that class's own doc comment,
   * do.ts) — a rejected push, a lock file, a hook, all of which mean "this
   * worktree's work is confirmed NOT on origin", not "we cannot tell". Every
   * OTHER rescue-push throw (a killed exec, the session shell dying outright)
   * stays best-effort, unchanged from round 1: only a CONFIRMED loss gets
   * this gate.
   */
  discardUnsynced?: boolean;
  /** Which flag the caller passed, so the unrescued note names it. */
  discardFlag?: "--discard-unsynced" | "--force";
  /** undefined = age unknown. */
  lastSyncedAt?: () => Promise<Date | null | undefined>;
}

function destroyRefusal(id: string, lastSyncedAt: Date | null | undefined, now: Date): string {
  return DESTROY_REFUSED_PREFIX +
    `the container did not answer an ${CONTAINER_PROBE_MS / 1000}s probe, so session sync, rescue-push and ` +
    "learning harvest cannot run. " + recycleCostLine(lastSyncedAt, now, "the next provision") + " " +
    "Also lost: uncommitted and unpushed work inside the container. " + LIVENESS_RULE + " " +
    `To discard anyway, as a stated choice: fleet destroy ${id} --discard-unsynced`;
}

/**
 * PR #263 round 3, N3: a rescue-push that CONFIRMED at least one worktree's
 * work never reached origin (a `RescuePushFailedError`, thrown only after
 * rescue.ts's own push-with-fallback retry already exhausted both attempts —
 * see that error's own doc comment) must refuse destroy exactly like a
 * failed probe does, unless the caller stated the choice to discard it
 * anyway. Unlike the probe refusal, session sync and learning harvest DID
 * run (the container answered fine) — only the one worktree(s) named in
 * `err.message` are confirmed lost.
 */
function destroyRescueFailedRefusal(id: string, err: RescuePushFailedError): string {
  return DESTROY_REFUSED_PREFIX +
    `rescue-push confirmed it could not save this studio's work before destroy: ${redactSecrets(err.message)} ` +
    `To discard anyway, as a stated choice: fleet destroy ${id} --discard-unsynced`;
}

/**
 * [wait out a boot] -> probe -> sync -> rescue-push -> learning-harvest ->
 * destroy (#104: the probe; #113: no exec at all when the container is not
 * running or the row is already stopped, a refusal when a running one fails
 * the probe; #129: a mid-boot container is waited out first). On success
 * `error` is null, or names the skipped rescue when a discard flag paid for
 * it. No post-destroy awaitReady, no
 * provision, no verdict/retry tail — see this file's header for why none of
 * recycleWithSync's post-destroy machinery belongs here. On a destroy
 * failure the studio is left `degraded` (never `stopped`: destroy() itself
 * not completing means nobody actually knows whether the container is gone),
 * same redactSecrets-at-the-catch-boundary posture recycleWithSync's own
 * failure path takes, and this function throws so callers cannot mistake it
 * for success. On success the studio is persisted `stopped` and recorded
 * to the registry (unlike recycleWithSync's own success path, which never
 * calls `recordStudioFn` itself — there, `provision()` already
 * does that write; here, there is no such downstream step, so this function
 * is the only thing that ever will).
 */
export async function destroyWithSync(
  syncDeps: SessionSyncDeps,
  storage: StudioStorage & SessionSyncStorage,
  idFallback: string,
  destroy: () => Promise<void>,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  repo: string,
  resolveMemoryRepo: ResolveMemoryRepo,
  commitFile: CommitLearningFile,
  // Omitted = assume running and refuse on a failed probe: the safe side.
  guard: DestroyGuard = { containerRunning: () => true },
  // Review round 3 (issue #85 PR1), MUST-FIX 8(a): trailing optional param,
  // same "absence = today's behavior" shape provisionWithStorage/
  // restartWithStorage/recycleWithSync already use for this — do.ts's real
  // destroyStudio() always supplies it.
  observedStorage?: ObservedStorage,
  // Issue #59 review round 1: the operator's `--park` — see StudioStatus.parked.
  park = false,
): Promise<StudioStatus> {
  // #113 F1: a container that is not running has nothing to rescue (its disk
  // is ephemeral and already gone), and ANY exec would boot it. A probe that
  // gave up mid-boot left the SDK retrying the failed start after destroy()
  // — a second container, billing under a `stopped` row. So: no exec at all.
  let running = guard.containerRunning();
  // #129 F2: running but mid-boot. A probe that quits at 8s, then a destroy()
  // that kills the boot, leaves the in-flight exec's 503 to the SDK's retry —
  // which starts a SECOND container after destroy, billing under a stopped
  // row. Wait the boot out first; if it never completes, carry on as below.
  if (running && guard.containerBooting && (await guard.containerBooting())) {
    console.error(`studio ${idFallback}: container is booting — waiting for it before the probe`);
    try {
      await guard.awaitBoot?.();
    } catch (err) {
      console.error(`studio ${idFallback}: boot did not complete`, err);
    }
    running = guard.containerRunning();
  }
  // Same ruling as recycle's review M2: a row already recorded STOPPED was
  // rescued by the destroy that stopped it; its container (if something
  // restarted one) holds nothing worth an exec. No probe, no refusal.
  const recordedStopped = (await storage.get(STATUS_KEY))?.state === "stopped";
  if (!running) {
    console.error(
      `studio ${idFallback}: container is not running — nothing to rescue (its disk is ephemeral) and an ` +
        "exec would boot it; skipping the probe, session sync, rescue-push and harvest, straight to destroy.",
    );
  } else if (recordedStopped) {
    console.error(
      `studio ${idFallback}: recorded stopped — an earlier destroy already rescued it; ` +
        "skipping the probe, session sync, rescue-push and harvest, straight to destroy.",
    );
    running = false;
  }
  // Issue #104: probe first, exactly as recycleWithSync does (board #68). A
  // wedged container accepts every exec and answers none, so without this
  // the three steps below hung and destroy() — the one thing that clears a
  // wedge — never ran.
  const alive = running && (await containerAnswers(syncDeps));
  let unrescued: string | null = null;
  if (running && !alive) {
    // #113 M3: recycle's guard (issue #96). A failed probe on a RUNNING
    // container means the rescue cannot run — refuse, naming the price,
    // unless the caller chose to pay it.
    const lastSyncedAt = await (guard.lastSyncedAt ?? (async () => undefined))().catch(() => undefined);
    if (!guard.discardUnsynced) throw new Error(destroyRefusal(idFallback, lastSyncedAt, syncDeps.now()));
    const flag = guard.discardFlag ?? "--discard-unsynced";
    unrescued = `destroyed without rescue: container did not answer an ${CONTAINER_PROBE_MS / 1000}s probe (${flag})`;
    console.error(
      `studio ${idFallback}: container did not answer a probe — skipping session sync, rescue-push and ` +
        `learning harvest, going straight to destroy because the caller passed ${flag}. ` +
        recycleCostLine(lastSyncedAt, syncDeps.now(), "the next provision"),
    );
  }
  if (alive) {
    try {
      // Issue #228 item 5 (documenting, not changing, an existing
      // interaction): `syncSessionTick` does not know WHY it is being
      // called, so if `fleet clear-session-guard` armed SESSION_FORCE_KEY and
      // this destroy follows before any other tick ran, THIS pre-destroy sync
      // is the one that consumes the override — the studio's LAST session
      // gets force-uploaded to `latest`, bypassing the mark/`poorerThan`
      // comparison entirely, exactly as it would on any other tick that
      // consumed it. This is almost certainly what an operator who armed the
      // override wants: a destroy's own final sync IS the "next real sync"
      // the override exists to let through. The `latest` it overwrites is not
      // lost — `syncSessionTick`'s own forced-upload path always copies it to
      // `sessions/<id>/superseded/<iso>.tar.gz` first (see SESSION_FORCE_KEY's
      // own doc comment, session-sync.ts) — but this was previously
      // undocumented anywhere a future reader could find it. `recycleWithSync`
      // (do.ts)'s own pre-destroy sync has the identical interaction, for the
      // identical reason.
      const result = await syncSessionTick(syncDeps, storage, idFallback);
      await recordSnapshotOnSuccess(observedStorage, result, syncDeps.now().toISOString());
    } catch (err) {
      console.error(`studio ${idFallback}: pre-destroy session sync failed, continuing`, err);
    } finally {
      // Issue #228 item 1: see clearConsumedForceStamp's own doc comment
      // (do.ts) — runs even when the tick consumed the override and then
      // threw. Without this, a destroy that consumes an armed override left
      // STATUS_KEY.sessionForceArmedAt stamped forever: a destroyed studio's
      // row never sees another sync tick (mirrorBurnToRegistry, do.ts's only
      // other consumer) to self-heal it, so `fleet ls` kept printing
      // "force-next-sync armed since <T>" for a studio whose override was
      // already spent.
      await clearConsumedForceStamp(storage);
    }
    // Issue #37: fresh-session aside dirs ship on their own; last chance.
    // PR #46 review: an aside that did not ship is named on the stopped row.
    let asideNote: string | null;
    try {
      asideNote = asideNotShippedNote((await shipAsideSessions(syncDeps, idFallback)).failed);
    } catch (err) {
      console.error(`studio ${idFallback}: pre-destroy aside session ship failed, continuing`, err);
      asideNote = asideNotShippedNote([{ dir: "(listing)", reason: err instanceof Error ? err.message : String(err) }]);
    }
    if (asideNote) unrescued = unrescued ? `${unrescued}; ${asideNote}` : asideNote;
    try {
      const rescue = await rescuePush(syncDeps, repo, idFallback);
      if (rescue.pushed) {
        for (const p of rescue.pushes ?? [{ branch: rescue.branch!, files: rescue.files, kind: rescue.kind! }]) {
          // Issue #266: the label now matches what was actually counted —
          // never "file(s)" for a clean-but-unpushed-commits rescue.
          console.error(`studio ${idFallback}: rescue-push saved ${p.files} ${p.kind === "commits" ? "commit(s)" : "file(s)"} to ${p.branch} before destroy`);
        }
      }
    } catch (err) {
      // PR #263 round 3, N3: a CONFIRMED rescue failure (RescuePushFailedError
      // — see its own doc comment, do.ts) refuses destroy exactly like a
      // failed probe does, unless the caller stated the choice to discard it
      // anyway — same `guard.discardUnsynced`/`discardFlag` the probe refusal
      // above already uses. This check runs BEFORE bumpDestroyEpoch below, on
      // purpose: a destroy that refuses here must leave the epoch untouched,
      // exactly like the probe refusal does (see that bump's own doc comment
      // for why). Every OTHER rescue-push throw (a killed exec, the session
      // shell itself dying) stays best-effort, unchanged from round 1 — those
      // mean "we cannot tell", not "we confirmed a loss".
      if (err instanceof RescuePushFailedError && !guard.discardUnsynced) {
        throw new Error(destroyRescueFailedRefusal(idFallback, err));
      }
      console.error(`studio ${idFallback}: pre-destroy rescue-push failed, continuing`, err);
      if (err instanceof RescuePushFailedError) {
        const flag = guard.discardFlag ?? "--discard-unsynced";
        unrescued = `destroyed with a confirmed rescue-push failure: ${redactSecrets(err.message)} (${flag})`;
      }
    }
  }
  // Round 3 review, fix 3 (verifier sim V10): bump the destroy epoch here —
  // AFTER the #129 probe-refusal decision AND (round 3, N3) the rescue-push
  // confirmed-failure refusal just above have both been made (and survived,
  // i.e. this destroy is actually going to proceed), but still BEFORE
  // harvestLearnings and the DESTROYING_KEY marker write below. This USED to
  // be the very first line of this function, before the refusal check —
  // which meant a destroy attempt that accomplished nothing at all (a
  // running-but-unresponsive container, refused outright with no --force/
  // --discard-unsynced) still bumped the epoch once, wrongly aborting any op
  // that happened to be mid-flight at the exact same moment. A destroy that
  // refuses now leaves the epoch completely untouched — see
  // DESTROY_EPOCH_KEY's own doc comment (provision.ts) for the full two-bump
  // mechanism and the second bump below.
  await bumpDestroyEpoch(storage);
  if (alive) {
    try {
      // #367 round 2: `storage` (StudioStorage & SessionSyncStorage) does not
      // itself declare DONE_RECORD_HASHES_KEY -- see do.ts's recycleWithSync,
      // its own identical call site, for why this is a cast rather than a
      // widened parameter type.
      await archiveDoneRecords(syncDeps, storage as unknown as DoneRecordHashStorage, idFallback, resolveMemoryRepo);
    } catch (err) {
      console.error(`studio ${idFallback}: pre-destroy completion-record archive failed, continuing`, err);
    }
    try {
      const harvest = await harvestLearnings(syncDeps, repo, idFallback, resolveMemoryRepo, commitFile, await deliveredTaskIn(storage));
      // #346: learnings dropped because memory is off go on the stopped row.
      if (harvest.lost) {
        const note = learningsLostNote("destroyed", harvest.lost);
        unrescued = unrescued ? `${unrescued}; ${note}` : note;
      }
      if (harvest.harvested) {
        console.error(`studio ${idFallback}: harvested ${harvest.count} learning(s) to fleet/memory/${idFallback}/ before destroy`);
      }
    } catch (err) {
      console.error(`studio ${idFallback}: pre-destroy learning harvest failed, continuing`, err);
    }
  }

  // Issue #100 F3: the stop marker, BEFORE destroy() — see DESTROYING_KEY.
  // Cleared in the `finally`, on every path out, a throw included.
  await storage.put(DESTROYING_KEY, syncDeps.now().toISOString());
  try {
    return await destroyAndRecord(
      storage, idFallback, destroy, recordStudioFn, unrescued, park, syncDeps.now().toISOString(),
    );
  } finally {
    await storage.put(DESTROYING_KEY, null);
  }
}

async function destroyAndRecord(
  storage: StudioStorage,
  idFallback: string,
  destroy: () => Promise<void>,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  unrescued: string | null,
  park: boolean,
  stoppedAt: string,
): Promise<StudioStatus> {
  try {
    await destroy();
  } catch (err) {
    // Scrubbed at the point the raw message is first held — same rule
    // recycleWithSync's own destroy/awaitReady catch follows (do.ts).
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    const failure = `destroy failed: ${message}`;
    const existing = (await storage.get(STATUS_KEY)) ?? null;
    const status: StudioStatus = { ...(existing ?? freshStatus(idFallback)), state: "degraded", error: failure };
    await storage.put(STATUS_KEY, status);
    await recordStudioFn(status);
    throw new Error(failure);
  }

  const existing = (await storage.get(STATUS_KEY)) ?? null;
  // A destroy that skipped the rescue must not read like a clean one.
  // Issue #59 review round 1: `parked` is written on EVERY completed destroy,
  // false unless the operator asked to park — so a plain destroy clears an
  // earlier park, and only the operator's latest word decides resumability.
  const status: StudioStatus = {
    ...(existing ?? freshStatus(idFallback)), state: "stopped", error: unrescued, containerRunningSince: null,
    parked: park, stoppedAt,
  };
  await storage.put(STATUS_KEY, status);
  // Issue #152: the SECOND bump, right after the stopped row lands and still
  // BEFORE destroyWithSync's own `finally` clears DESTROYING_KEY. Net effect
  // across both bumps (this one, and the one right after the #129
  // probe-refusal decision, above): a destroy that dies before reaching this
  // point (the catch branch above, `degraded`) bumps the epoch exactly once;
  // a destroy that completes cleanly, here, bumps it exactly twice. A racing
  // operation's own single epoch snapshot therefore always disagrees with the
  // live epoch once this point is reached, however many storage reads
  // separate the two in time.
  await bumpDestroyEpoch(storage);
  await recordStudioFn(status);
  return status;
}

/** `runDestroy`'s own tagged result — a REFUSAL (an open assigned board task
 *  exists, and `--force` was not passed) must read differently at every
 *  layer above this from an actual operational failure: the route layer
 *  turns this into 409, never 500 (see routes.ts's own destroy branch), and
 *  neither the board task nor its labels are ever touched on this path — see
 *  this file's header. A bare throw here would make that distinction
 *  invisible to a caller without inspecting Error subclasses across what is,
 *  in production, a Durable Object RPC boundary; a plain tagged return
 *  avoids that entirely. */
export type DestroyOutcome =
  | { ok: true; status: StudioStatus }
  | { ok: false; refused: true; reason: string };

/** `runDestroy`'s own dependency for the refusal gate — `openTaskChecker`
 *  (board/routes.ts), NOT task #118's `resolveAssignedBrief`. That resolver
 *  collapses "no open task" and "couldn't tell" into the SAME `undefined`,
 *  which is correct for the bringup fallback it backs but is exactly the
 *  fail-OPEN behavior a destructive-action gate must never have — see this
 *  function's own doc comment below. This type keeps "confirmed no open
 *  task" and "lookup failed" as two DIFFERENT return shapes, on purpose. */
export type OpenTaskChecker = (
  studioId: string, workRepoSlug: string,
) => Promise<{ ok: true; hasOpenTask: boolean; tasks?: number[]; drifted?: number[] } | { ok: false; message: string }>;

/**
 * The refusal gate, ahead of destroyWithSync's own sequence. Fails CLOSED,
 * not open: a `checkOpenTask` result of `{ ok: false }` (board API error,
 * `listTasks` itself resolving `!ok`, or the checker's own catch) refuses
 * the destroy EXACTLY like a confirmed open task would — the same verdict a
 * transient board hiccup and a real in-progress task both get, per this
 * codebase's own documented discipline (`do.ts`'s `rescuePushCmd`: "fail
 * SAFE, not fail open"). Only `{ ok: true, hasOpenTask: false }` — a
 * POSITIVE confirmation that no open task carries this studio's label —
 * lets a non-forced destroy proceed. `force` skips the check ENTIRELY —
 * `checkOpenTask` is not even called — so an operator who explicitly
 * overrides never pays for, or races, a board read they told this call to
 * ignore.
 */
export async function runDestroy(
  checkOpenTask: OpenTaskChecker | undefined,
  studioId: string,
  workRepoSlug: string,
  force: boolean,
  syncDeps: SessionSyncDeps,
  storage: StudioStorage & SessionSyncStorage,
  idFallback: string,
  destroy: () => Promise<void>,
  recordStudioFn: (status: StudioStatus) => Promise<void>,
  repo: string,
  resolveMemoryRepo: ResolveMemoryRepo,
  commitFile: CommitLearningFile,
  guard?: DestroyGuard,
  // Review round 3 (issue #85 PR1), MUST-FIX 8(a) — threaded straight
  // through to destroyWithSync's own identical trailing param.
  observedStorage?: ObservedStorage,
  park = false,
): Promise<DestroyOutcome> {
  if (!force) {
    const result = checkOpenTask ? await checkOpenTask(studioId, workRepoSlug) : { ok: false as const, message: "no open-task checker configured" };
    if (!result.ok) {
      return {
        ok: false, refused: true,
        reason: `studio ${studioId}: could not confirm no open assigned board task (${result.message}); pass --force to destroy anyway`,
      };
    }
    if (result.hasOpenTask && result.tasks?.length) {
      // Board #55: name the blockers — "an open task" left the operator to
      // go find it, and reach for --force instead.
      // #124 N1: `completed` is the verifier's verdict, not an unblock
      // lever — offer cancel/reassign. A drifted task has no state to move
      // from; only hand-fixing its labels clears it.
      const drifted = result.drifted ?? [];
      const driftNote = drifted.length
        ? `; ${drifted.map((n) => `#${n}`).join(", ")} ${drifted.length === 1 ? "has" : "have"} drifted state labels `
          + "(not exactly one of submitted/working/input_required/completed/failed/canceled) — fix them by hand on GitHub"
        : "";
      return {
        ok: false, refused: true,
        reason: `studio ${studioId} has open assigned board task(s) ${result.tasks.map((n) => `#${n}`).join(", ")}; `
          + "cancel (fleet task state <n> canceled), reassign (fleet task assign <n> <role>), or pass --force to destroy anyway"
          + driftNote,
      };
    }
    if (result.hasOpenTask) {
      return {
        ok: false, refused: true,
        reason: `studio ${studioId} has an open assigned board task; pass --force to destroy anyway`,
      };
    }
  }
  try {
    const status = await destroyWithSync(
      syncDeps, storage, idFallback, destroy, recordStudioFn, repo, resolveMemoryRepo, commitFile, guard, observedStorage,
      park,
    );
    return { ok: true, status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith(DESTROY_REFUSED_PREFIX)) return { ok: false, refused: true, reason: message };
    throw err;
  }
}
