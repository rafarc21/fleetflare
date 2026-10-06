# Replaced-studio session loss, wip ref misread, busy-lead wip-sync skip

**Issue:** https://github.com/rafarc21/fleetflare/issues/231

**Scope (maestro brief, revised fix 1):** items 1 (revised), 2, 3, 5. Item 4
only if small.

## 1 (revised) — refuse `--fresh-session` on involuntary-stop recovery

Signals already exist: `Observed.replacedAt !== null` (involuntary last
stop) + `SessionMark.lines` (session-sync.ts, turn-count proxy) over
threshold. Refuse iff `cfg.freshSession === true` (explicit ask, never the
stored pending-key alone) AND `obs.replacedAt !== null` AND `lines >
FRESH_SESSION_INVOLUNTARY_LINE_THRESHOLD` AND `cfg.discardSession !== true`.

Threshold: 30 lines (~turns). Incident was 2305 — anywhere in the tens is
conservative; 30 catches "this session did real work" while leaving a
fresh/near-fresh session (a handful of turns) to proceed normally.

New: `ProvisionConfig.discardSession?: boolean`, threaded exactly like
`cancelFreshSession` (types.ts, cli-args.ts `provision` case only, routes.ts
provision route only, cli/fleet.ts `cmdProvision` only — recycle/task-new
never got `cancelFreshSession` either, same scope).

Check lives in `provisionWithStorage`, before the op-lock/any write — a
fast refuse, no side effects. New optional param `sessionMarkStorage?:
{get(SESSION_MARK_KEY): Promise<SessionMark|undefined>}` (narrow port,
mirrors `observedStorage?`), wired from do.ts's real call site
(`this.ctx.storage` satisfies it structurally, no cast).

Refusal: new `FRESH_SESSION_REFUSED_PREFIX` + builder in provision.ts,
mirroring `RECYCLE_REFUSED_PREFIX`/`recycleRefusal` (recycle-cost.ts). Names
the real line count, says "use plain provision to resume." routes.ts's
provision-route catch recognizes the prefix -> 409, same pattern recycle's
route already has for its own prefix.

Provenance: new `ObservedSession.freshSessionSource?: "flag" | "pending-key"`
(observed.ts) — which trigger caused `freshSession: true` for THIS bring-up.
Set in `recordBringupObservation`'s session-build (same external-spread
pattern `replacementDetected`/`snapshotSource` already use — no change to
`computeSessionVerdict` itself). Rendered by `formatSessionLine`
(readiness-format.ts, `fleet inspect`'s own session: line) — same place
`via`/`reason` already render.

## 2a — survival brief names the exact wip ref

`SurvivalInput.wipBootStamp?: string | null` threaded the same path
`wipSyncedAt` already takes: survival-brief.ts's `SurvivalInput`,
survival-delivery.ts's `resolveSurvivalInput`/`composeSurvivalDelivery`/
`SurvivalBringup`/`SurvivalBriefPending` (observed.ts), do.ts's
`deliverSurvivalOnBringup`/`retrySurvivalBrief`/`survivalCompose`. Local
`wipSyncRefEcho` (survival-brief.ts, its own copy — cannot import
cli/wip-format.ts's, cross-tsconfig-boundary) widens to accept the optional
bootStamp, same signature cli/wip-format.ts's version already has.
`wipSyncLine` calls it with `input.wipBootStamp`.

## 2b — aside path persisted + shown

`runProvision`'s local `moved` (parseFreshSession's successfully-moved
paths) never left the function. New return field
`freshSessionAsidePaths?: string[]` (successful moves only). In
`provisionWithStorage`, when `freshSessionMoved` is true and the list is
non-empty: `mergeObserved(observedStorage, { lastSessionAside: paths })`.
New `Observed.lastSessionAside?: string[] | null` — same "stamped on a real
event, left alone otherwise" convention `wipSyncedAt` uses (not auto-cleared
on a later quiet bring-up).

Threaded the same path as `wipBootStamp` above (`SurvivalInput`,
`resolveSurvivalInput`, `SurvivalBringup`, `SurvivalBriefPending`, do.ts).
New line in `composeSurvivalBrief`, non-null/non-empty only:
`- Old session moved aside to <path>; find it there.`

`genuinelyEmpty`: no new condition needed. Whenever `lastSessionAside` could
be non-null, a bring-up completed and `session !== null` — already covered
by the existing `input.session === null` leg.

## 3a — wip-sync gate widens to non-bare

do.ts's wip-sync gate (~3145): `checked?.readiness?.kind === "provisioned"`
-> `checked?.readiness != null && checked.readiness.kind !== "bare"`. Every
other guard on that `if` (`!stoppedAfterFailover`, `state !== "stopped"`,
`checkedAt >= cycleStartedAt`) unchanged.

## 3b — wip-sync covers member worktrees

`wipSyncCmd`/`wipSyncProbeCmd` (rescue.ts) are main-checkout-only by their
own v1 doc comment. Both refactored:

- `wip_sync_one`/`wip_sync_push` (wipSyncCmd) take `(dir, target)` /
  `(dir, target, src)` as shell args instead of closing over build-time
  `${dir}`/`${target}` — lets the same function run once for the main
  checkout and once per member worktree (`git worktree list --porcelain`,
  same `wid=$(basename $(git -C "$w" rev-parse --git-dir))` derivation
  `rescuePushCmd` already uses, here-string `while read` loop). Target ref:
  `fleet/rescue/<studio>/wt/<wid>-<bootStamp>` — same per-boot
  rolling-snapshot property the main ref has (force-pushed, overwritten
  every tick), never the teardown-time fresh-timestamp `wt/` shape. No
  budget ledger (one push per target, no retry-worst-case to bound).
  Per-target CLEAN/MARKERS_ONLY is no longer echoed directly (would corrupt
  do.ts's multi-line `parseRescueExecResult`, which already tolerates
  multiple PUSHED/FAILED lines the same way `rescuePushCmd`'s own
  worktree/branch/stash walk produces them) — aggregated instead, one
  overall CLEAN/MARKERS_ONLY line only when NOTHING across every target
  pushed or failed.
- `wipSyncProbeCmd`: same per-dir decision factored into `wip_probe_one`,
  called for main + every worktree, best-of-N by priority (NEEDED > FAILED >
  MARKERS_ONLY > CLEAN) — required, since do.ts's `wipSync` gates the whole
  expensive push on this probe first; leaving it main-only would silently
  make the wipSyncCmd fix dead code whenever the main checkout is clean but
  a member worktree is dirty.

Old test "never walks a member worktree" (rescue-push.test.ts) asserted the
v1 limitation directly — flipped to assert the new coverage.

## 5 — fleet inspect WIP line

Read `formatWipInspectLines` (cli/wip-format.ts): already renders the ref
via `wipBootStamp` (identification) and the age via `wipSyncedAt` (real
push time) — the same split fix 2a gives the survival brief. No logic bug
found. Clarity fix only: doc comment making the ref-vs-age distinction
explicit, per the issue's own instruction to say so plainly rather than
invent a bug.

## 4 (optional) — ff.ts BARE_SELF_HEALED / inconclusive+running

Scoped only if small; decided after 1/2/3/5 land. See final report for the
call.

## Files touched

- `apps/fleet/src/studio/observed.ts` — `ObservedSession.freshSessionSource`,
  `Observed.lastSessionAside`, `SurvivalBriefPending.wipBootStamp`/
  `.lastSessionAside`.
- `apps/fleet/src/studio/provision.ts` — fix 1's threshold/refusal/
  `sessionMarkStorage` param, `discardSession` field, `freshSessionSource`
  set at session-build, `freshSessionAsidePaths` return + Observed write.
- `apps/fleet/src/studio/types.ts` — `ProvisionConfig.discardSession`.
- `apps/fleet/src/studio/cli-args.ts`, `routes.ts`, `cli/fleet.ts` —
  `--discard-session` plumbing (provision only).
- `apps/fleet/src/studio/recycle-cost.ts` or `provision.ts` —
  `FRESH_SESSION_REFUSED_PREFIX` (lives in provision.ts, scoped to this
  refusal).
- `apps/fleet/src/studio/survival-brief.ts`,
  `apps/fleet/src/studio/survival-delivery.ts` — `wipBootStamp`/
  `lastSessionAside` threading, new brief line.
- `apps/fleet/src/studio/do.ts` — wip-sync gate widen (3a),
  `deliverSurvivalOnBringup`/`retrySurvivalBrief`/`survivalCompose`
  threading (2a/2b).
- `apps/fleet/src/studio/rescue.ts` — `wipSyncCmd`/`wipSyncProbeCmd`
  member-worktree coverage (3b).
- `apps/fleet/cli/readiness-format.ts` — `formatSessionLine` renders
  `freshSessionSource`.
- `apps/fleet/cli/wip-format.ts` — doc-comment clarity only (fix 5).
- Tests: `apps/fleet/test/studio.fresh-session.test.ts`,
  `studio.observation.test.ts`, `studio.survival-brief.test.ts`,
  `studio.survival-delivery.test.ts`, `studio.replacement.test.ts`,
  `studio.session.test.ts`, `test/bun/rescue-push.test.ts`, `readiness-format`
  tests, `cli-args`/`routes` tests for the new flag.
