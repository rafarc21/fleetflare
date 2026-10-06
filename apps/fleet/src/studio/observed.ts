// The DO-storage record answering "is the container this DO thinks it owns
// still the one actually running, and did its last bring-up land on a real
// session" — issue #85. Own file, own DO-storage key, own narrow keyed-
// storage port, the same "own file, own keys, no widening of
// provision.ts's StudioStorage" discipline transcript.ts's TranscriptStorage
// and session-sync.ts's SessionSyncStorage already establish (see either
// file's own header for the full reasoning): a real `this.ctx.storage`
// (DurableObjectStorage) satisfies this structurally, with no cast, because
// DO storage's own get/put are generic over T.
//
// Observation-only (spec Principle 2): nothing in this file, or anything
// that calls it, heals/restarts/wakes/recycles. It only records what was
// seen.

import { redactSecrets } from "./redact";
import { STUDIO_TMUX, withStudioTmux } from "./tmux";
// Issue #221 (PR3a) — type-only: activity.ts imports FROM failover.ts, which
// imports FROM this file (mergeObserved et al.), so a VALUE import here would
// cycle. `import type` erases entirely at build time (no runtime import
// statement), so there is no runtime cycle — only a type reference, which the
// compiler resolves fine either way.
import type { Activity } from "./activity";
// Issue #311 — same type-only reasoning as `Activity` above: member-alerts.ts
// imports (VALUE) FROM activity.ts, which imports FROM failover.ts, which
// imports FROM this file — a value import here would cycle through that
// same chain.
import type { MemberAlert } from "./member-alerts";
// Issue #56 — type-only for the same cycle reason: restarts.ts imports
// BringupVia from this file.
import type { RestartLog } from "./restarts";
// Maestro review round 2 on PR #235 (issue #231), item 2b — type-only, no
// cycle: session-sync.ts imports nothing from this file.
import type { AsideShipRecord } from "./session-sync";

export const OBSERVED_KEY = "observed";

export type SessionVerdict = "resumed" | "fresh" | "lost" | "unknown";

/** Which of the five bring-up paths produced this record. `adopted` is not a
 *  bring-up at all — it is the ship tick's own first-tick-after-deploy (or
 *  pre-feature-studio) adoption case; see the ship-tick task's own doc
 *  comment. */
export type BringupVia = "provision" | "restart" | "heal" | "recycle" | "failover" | "adopted";

/** `runSessionRestore`'s (provision.ts) own outcome, now kept instead of
 *  discarded. `"failed"` and `"not-attempted"` are never returned BY that
 *  function itself — `"not-attempted"` is its own early-return (no r2Get/
 *  writeFile wired), `"failed"` is set by ITS CALLER's catch block, since
 *  runSessionRestore rethrows on a placement failure. */
export type RestoreOutcome = "restored" | "skip:no-snapshot" | "skip:has-projects" | "failed" | "not-attempted";

export interface ObservedSession {
  verdict: SessionVerdict;
  /** When this verdict was computed — an ISO string, same convention every
   *  other timestamp field on this record uses. */
  at: string;
  via: BringupVia;
  restore: RestoreOutcome;
  /** Age, in seconds, of the restored snapshot AT RESTORE TIME — null when
   *  no restore happened, or `lastSnapshotAt` was not yet known. */
  snapshotAgeS: number | null;
  /** Issue #85 review round 3, MUST-FIX 8(d) — true when `snapshotAgeS`
   *  falls back to a raw restore-observed-time measurement because neither
   *  the old container's own stop time nor a `replacedAt` detection time was
   *  known. Rendered with a leading `≤` (cli/readiness-format.ts's
   *  formatSession) — the real age (work genuinely at risk) can only be
   *  LESS THAN OR EQUAL to this number, since time spent stopped before the
   *  restore is not additional lost work and this fallback cannot subtract
   *  it out. Optional, default falsy: absent (or false) means the figure is
   *  exact. See `resolveSnapshotAge`'s own doc comment for the full
   *  priority chain. */
  snapshotAgeIsUpperBound?: boolean;
  /** Issue #249 (PR4b) — true when a replacement had ALREADY been detected
   *  (`Observed.replacedAt` was non-null) at the moment this bring-up ran.
   *
   *  Captured HERE, into the session record, rather than read off
   *  `Observed.replacedAt` at delivery time, because by then it is gone:
   *  `recordBringupObservation` (provision.ts) sets `patch.replacedAt = null`
   *  on every bring-up whose incarnation-token write succeeded, and it runs
   *  BEFORE the bring-up wakes fire. A delivery-time reader would therefore
   *  find `replacedAt === null` on exactly the bring-ups that replaced a
   *  container, and the `replacedAt` half of the survival-brief allowlist
   *  (`survivalBriefAllowed`, survival-delivery.ts) would silently never
   *  fire.
   *
   *  Optional, default falsy — same shape `snapshotAgeIsUpperBound` above
   *  uses, so an `Observed` record written before this field existed reads
   *  as "no replacement detected" rather than `undefined`. */
  replacementDetected?: boolean;
  /** Maestro review round 1 on PR #235, BLOCKER 1 (issue #231) —
   *  `Observed.wipBootStamp` AS IT STOOD IMMEDIATELY BEFORE this bring-up,
   *  frozen here the same way `replacementDetected` above is.
   *
   *  `recordBringupObservation` (provision.ts) sets `patch.wipBootStamp` to a
   *  BRAND-NEW stamp inside the exact same `if (tokenWritten)` block that
   *  clears `replacedAt` — and it does so BEFORE the bring-up wakes
   *  (`deliverSurvivalOnBringup`, do.ts) ever run. A delivery-time reader of
   *  the live `Observed.wipBootStamp` would therefore always see the NEW
   *  container's own (as yet unsynced) stamp, never the OLD one whose ref
   *  actually holds the WIP safety net this bring-up's own brief is pointing
   *  at — exactly the kind of live-re-read bug `replacementDetected`'s own
   *  doc comment already warns about for `Observed.replacedAt`.
   *
   *  Captured from `observedBefore.wipBootStamp` — read at the TOP of
   *  `recordBringupObservation`, before `patch.wipBootStamp` is computed —
   *  and applied to the SAME two "this bring-up" branches
   *  `replacementDetected`/`freshSessionSource` are, never to the "untouched,
   *  keep the prior verdict" branch (which describes an EARLIER bring-up).
   *
   *  OPTIONAL/absent means "no confirmed boot stamp existed before this
   *  bring-up" — `wipSyncLine` (survival-brief.ts) falls back to its own glob
   *  rendering in that case, same as it already does for a null
   *  `SurvivalInput.wipBootStamp`. */
  wipBootStampBefore?: string | null;
  /** Board #250 (#85/#118 follow-up) — the keeper's own source label
   *  (`daily <date>`, `pickRestoreSource`'s own doc comment, provision.ts)
   *  when this restore came from a daily keeper rather than `latest`. Absent
   *  for a `latest` restore, a skip, or a failed restore — a keeper is, by
   *  construction, from a genuinely OLDER snapshot than `latest` (used only
   *  when `latest` is missing/unreadable/empty), so `cli/readiness-format.ts`'s
   *  `formatSession` renders it distinctly (`from daily <date> snap N old`)
   *  rather than the plain `from snap N old` a `latest` restore gets — an
   *  operator reading `snapshotAgeS` alone has no way to tell the two apart
   *  otherwise. Set by `recordBringupObservation` (provision.ts) the same way
   *  `snapshotAgeIsUpperBound` above is: a conditional spread on top of
   *  whatever `computeSessionVerdict` (or the untouched-lead branch) already
   *  built. */
  snapshotSource?: string;
  /**
   * Issue #231 — WHICH of the two triggers caused `requestedFresh: true` for
   * THIS bring-up (provisionWithStorage, provision.ts): the operator's own
   * EXPLICIT `--fresh-session` flag, or a STORED `FRESH_SESSION_PENDING_KEY`
   * left armed by an earlier attempt that never confirmed. Before this
   * field, the two were conflated into one boolean with no record of which
   * one fired — the exact gap #231's own code-reading left unresolved
   * ("4 provisions, 4 lost sessions -- suspect stuck pending key or a
   * --fresh-session passed per rebuild. Cannot tell after the fact:
   * provenance not recorded."). Absent when this bring-up did not go fresh
   * at all. Rendered by `formatSessionLine` (cli/readiness-format.ts),
   * `fleet inspect`'s own `session:` line, the same place `via`/`reason`
   * already render.
   */
  freshSessionSource?: "flag" | "pending-key";
  /** `burn.turns` at the moment of bring-up (lifetime count, never resets). */
  turnsBefore: number;
  /** Why a LOST or unknown verdict landed there — e.g. "cwd
   *  /container-server", "no --continue", or the pane-probe's own exec
   *  error. Null for resumed/fresh. Already scrubbed with `redactSecrets`
   *  by the time it lands here — see computeSessionVerdict/
   *  computeAdoptedVerdict's own doc comments — the same "clean at
   *  construction" convention `StudioStatus.error` follows. */
  reason: string | null;
}

export interface Observed {
  /** The last incarnation token this DO wrote AND confirmed via the ship
   *  tick. Null before the first successful write, or after a replacement
   *  is detected and cleared. */
  incarnation: string | null;
  /**
   * Fix round (#208 PR #215 review item 1, maestro DESIGN decision): a
   * 14-digit UTC timestamp (`formatRescueStamp`, survival-delivery.ts —
   * `$(date -u +%Y%m%d%H%M%S)`'s own TypeScript-side equivalent), captured
   * ONCE per container boot, at the EXACT SAME moment `incarnation` (above)
   * is captured — `recordBringupObservation` (provision.ts) sets both inside
   * the same `if (tokenWritten)` block, so the two always move together.
   * do.ts's `wipSync` threads this into `wipSyncCmd`/`wipSyncRef` as the
   * per-boot segment of the WIP-sync ref
   * (`fleet/rescue/<studio>/wip/<wipBootStamp>`), so every tick WITHIN one
   * container's life keeps force-pushing the SAME ref (the rolling-snapshot
   * property `wipSyncRef`'s own doc comment describes), while a DIFFERENT
   * container boot (a fresh `recordBringupObservation` call, a fresh
   * `tokenWritten`) always gets a NEW stamp and therefore a NEW ref — never
   * touching a prior container's own wip ref. Null (or absent, for a row
   * written before this field existed) means "no confirmed bring-up has
   * captured one yet for this container" — `syncSessionCycle`'s own WIP-sync
   * step skips the tick entirely rather than inventing one, since a guessed
   * stamp here is the exact per-container collision this field exists to
   * prevent (see `wipSyncRef`'s own doc comment, rescue.ts, for the full
   * history of why the ref used to be silently clobbered across boots).
   * OPTIONAL, same trailing-optional convention `survivalBriefDeliveredFor`
   * above already uses: absent reads exactly like `null`, so every existing
   * `Observed` fixture across the test suite (written before this field
   * existed) keeps compiling and behaving unchanged.
   */
  wipBootStamp?: string | null;
  /** Set ONCE when the ship tick finds no incarnation token where one was
   *  expected (or a foreign one). Cleared when the container answers with
   *  the DO's own current token again. Never advanced by a later tick while
   *  still set — see the ship-tick task's own doc comment for why. */
  replacedAt: string | null;
  /** Consecutive ship-tick exec failures/timeouts. Reset to 0 on the first
   *  success after any failures. */
  execFailures: number;
  /** Review round 3 (issue #85 PR1), MUST-FIX 7 — stamped at the FIRST
   *  failure of a new streak (execFailures 0->1), not the 3rd: this answers
   *  "since when has ANY failure streak been building", which is a different
   *  question from "since when did it cross the render threshold". Board
   *  issue #183 — the READY-column override and `fleet inspect`'s own
   *  "unreachable:" line both now gate on `isUnreachable` (below): the
   *  time-based rule of `execFailures >= 2` AND `now - lastShipOkAt >= 90s`,
   *  not the old count-only `execFailures >= 3` threshold — see
   *  cli/readiness-format.ts's `readyOverride`/`formatUnreachableLine`.
   *  Cleared on the next success. */
  unreachableSince: string | null;
  /** Board issue #183 — the last time a ship tick (do.ts's
   *  `runShipTickWithObservation`) actually SUCCEEDED, updated on every
   *  successful tick, not merely on a state change. This is what
   *  `isUnreachable` (below) measures elapsed downtime FROM.
   *
   *  Review round 2, SHOULD-FIX 5 — despite the name, "succeeded" here means
   *  "the exec plane ANSWERED", not "the whole tick's work came out clean":
   *  a resolved-but-bad response (nonzero exit, a parse failure, an R2 put
   *  failure, a rotate failure — maestro correction #5) proves the container
   *  is just as alive as a fully clean tick does, and do.ts's
   *  `runShipTickWithObservation` stamps this field (and resets
   *  `execFailures`/`unreachableSince`) on THAT path too, not only on a
   *  clean success. Kept as `lastShipOkAt` rather than renamed to
   *  `lastExecOkAt` — the field is already read/written across do.ts,
   *  cli/readiness-format.ts, and this feature's own test suite; a rename
   *  here would touch every one of those call sites for a purely cosmetic
   *  gain, so this doc comment carries the clarified semantics instead.
   *
   *  Deliberately NOT the same thing as `unreachableSince` above:
   *  `unreachableSince` is stamped at the FIRST FAILURE of a streak, which is
   *  roughly one tick cycle (~SHIP_TRANSCRIPT_SECONDS + the exec's own
   *  deadline, do.ts) AFTER the last real success — a wedged container's exec
   *  takes up to the full deadline to resolve as a failure, and the failure
   *  is only detected/stamped once that resolves. Using `unreachableSince` as
   *  a stand-in for "last known good" would systematically UNDERSTATE real
   *  elapsed downtime by that same gap. `lastShipOkAt` is the genuine "since
   *  when has nothing come back" anchor the time-based unreachable rule
   *  needs. Null until the first successful ship tick ever records one (a
   *  fresh studio, or an `Observed` record that predates this field).
   */
  lastShipOkAt: string | null;
  /** When `syncSessionTick`'s R2 put last succeeded. */
  lastSnapshotAt: string | null;
  /** The most recent bring-up's session verdict, or null before any
   *  bring-up has completed under this feature. */
  session: ObservedSession | null;
  /** Issue #249 (PR4b) — the `incarnation` token this studio's survival
   *  re-brief (#107/#150) was last DELIVERED against, or null if none has
   *  been. At-most-once PER INCARNATION: the re-brief describes what
   *  survived a container replacement, so the container identity is the
   *  thing it can only usefully be said once about. Issue #137 gave board
   *  #213's own bring-up task re-delivery the identical per-incarnation
   *  discipline — see `taskWakesDeliveredFor` below. (Board #213's
   *  `DELIVERED_TASK_KEY`, do.ts, is a SEPARATE record that still exists and
   *  is still per-task-forever, but it no longer gates any delivery; it is
   *  read only by teardown's `harvestLearnings`.)
   *
   *  Written ONLY after a wake lands (`deliverSurvivalBriefOnBringup`,
   *  survival-delivery.ts), so a refusal (modal on screen, stopped,
   *  single-flight busy, lead mid-turn) leaves nothing behind and the next
   *  bring-up retries for free — same discipline `recordDeliveredTask`
   *  (do.ts) already follows.
   *
   *  A bring-up whose `incarnation` is null is SKIPPED rather than recorded
   *  against: writing `null` here would make the dedup comparison
   *  `null === null` true forever and permanently suppress the re-brief on a
   *  studio whose incarnation-token write keeps failing.
   *
   *  OPTIONAL, and absence means exactly what `null` means — "no re-brief has
   *  been delivered against any incarnation yet". Same trailing-optional
   *  shape `snapshotAgeIsUpperBound`/`replacementDetected` above and board
   *  #229's own `deliverAssignedTaskOnBringup` trailing params already use,
   *  so every `Observed` record written before this field existed (and every
   *  pre-#249 test fixture) reads as pre-#249 behavior instead of failing to
   *  type-check. `emptyObserved` below still writes it explicitly as `null`,
   *  so a freshly created record names the field rather than leaving a
   *  reader to infer it. */
  survivalBriefDeliveredFor?: string | null;
  /** Issue #249 (PR4b) round 2, item 2 — a survival re-brief this studio OWES
   *  a lead but has not managed to type yet, or `null` when nothing is owed.
   *
   *  Round 1 shipped delivery as fire-and-forget: a bring-up that found the
   *  lead mid-turn skipped, wrote nothing, and the ONLY thing that could ever
   *  try again was another bring-up — i.e. another container replacement,
   *  which on a healthy studio may never come. That was measurably wrong the
   *  moment #229's assigned-task pointer started typing FIRST from the same
   *  bring-up hook (do.ts's `deliverBringupWakes`): the pointer makes the lead
   *  busy, and the re-brief microseconds behind it read that busy pane and
   *  dropped the brief for good.
   *
   *  So a deferral is now PERSISTED here and retried by the regular per-studio
   *  sync tick (`syncSessionCycle`, do.ts, SYNC_SESSION_SECONDS) whenever the
   *  lead is idle — bounded, and with a visible give-up state. See
   *  `retryPendingSurvivalBrief` (survival-delivery.ts) for the whole state
   *  machine, and `SurvivalBriefPending` below for what each field is for.
   *
   *  OPTIONAL with the same reading `survivalBriefDeliveredFor` above has:
   *  absent means exactly what `null` means, "nothing is owed". */
  survivalBriefPending?: SurvivalBriefPending | null;
  /** Issue #137: task numbers that have already received a bring-up
   *  re-delivery wake for THIS incarnation. Reset implicitly: a record whose
   *  own `incarnation` no longer matches `Observed.incarnation` reads as
   *  empty, so a container replacement (new incarnation) earns every open
   *  working/input_required task exactly one fresh wake again, even a task
   *  that had already been delivered before the replacement — the gap
   *  `DELIVERED_TASK_KEY` (do.ts) left, because that marker is keyed on the
   *  task number alone and never expires.
   *
   *  Written ONLY after a wake lands (`deliverAssignedTaskOnBringup`, do.ts),
   *  same discipline `survivalBriefDeliveredFor` above follows. A null
   *  incarnation uses the key `""` rather than being skipped outright (see
   *  that function's own doc comment for why the two dedup mechanisms differ
   *  here).
   *
   *  OPTIONAL, same trailing-optional shape `survivalBriefDeliveredFor` above
   *  uses: absent means "nothing delivered against any incarnation yet". */
  taskWakesDeliveredFor?: { incarnation: string; numbers: number[] } | null;
  /**
   * Issue #221 (PR3a) — the D1-facing MIRROR of the DO's own `activity` key
   * (activity.ts's `ACTIVITY_KEY`, a genuinely separate storage slot never
   * merged into `OBSERVED_KEY`'s own read-patch-write cycle). do.ts's
   * `withObserved`/`getStatusDetail`/`inspect` attach the DO's freshest
   * `ACTIVITY_KEY` value here on every composition, so `GET /studio/:id/
   * status` and `fleet ls --json` expose it with no further plumbing. Never
   * written by `mergeObserved` itself — see this feature's own "own DO key,
   * never inside the status read-exec-write cycle" rule. `null` before the
   * first successful ship tick, or for a studio that predates this feature.
   */
  activity: Activity | null;
  /**
   * Issue #311 (PR3 addendum) — the D1-facing mirror of the DO's own
   * `memberAlerts` key (member-alerts.ts's `MEMBER_ALERTS_KEY`), same "own
   * key, never inside `OBSERVED_KEY`'s own read-patch-write cycle"
   * convention `activity` (above) already established. Recomputed and
   * OVERWRITTEN wholesale every ship tick — never appended to. `null`
   * before the first ship tick that ran this feature, or for a studio that
   * predates it; an empty array means the tick ran and found nothing to
   * report, a real, different fact from "never checked."
   */
  memberAlerts: MemberAlert[] | null;
  /**
   * Issue #56 — the D1-facing mirror of the DO's own container-restart log
   * (restarts.ts's `RESTARTS_KEY`), attached at the same seam as `activity`.
   * ABSENT while unknown: no boot-id baseline yet, or a row written before
   * this field existed — never a fabricated zero. `{ total: 0 }` only once
   * the ship tick has a baseline and has seen no replacement since.
   */
  restarts?: RestartLog;
  /**
   * Board issue #208: when do.ts's `wipSync` last actually pushed a periodic
   * WIP safety-net snapshot (rescue.ts's `wipSyncCmd`, to this container's
   * own `fleet/rescue/<studio>/wip/<wipBootStamp>` ref — see that field's own
   * doc comment above, #208 fix round item 1) — the bounding evidence for "how stale
   * is the newest copy of this studio's work that survived a platform
   * container replacement with no pre-replacement hook to rescue-push from".
   *
   * OPTIONAL, same absence convention `restarts` above already uses (see
   * that field's own doc comment): ABSENT while unknown — no WIP sync has
   * EVER actually pushed yet, or this row predates the feature — never a
   * fabricated `null`. Rides `mergeObserved` the same way `lastSnapshotAt`
   * does (own value, no separate DO-storage key needed — unlike `restarts`,
   * there is no independent state machine here to keep in its own key), so
   * it flows through `getObserved`/`getObservedWithActivity`/`withObserved`
   * (do.ts) automatically, with no code change needed in either of those two
   * functions: `getObserved`'s own `{ ...emptyObserved(), ...stored }` already
   * passes any stored field through unchanged, and this field is
   * deliberately left OUT of `emptyObserved()` below so an old row (or one
   * that has never had a WIP sync succeed) reads as truly absent, not `null`.
   *
   * Stamped ONLY on an actual successful push (do.ts's `wipSync` returning
   * `pushed: true`) — never on RESCUE_CLEAN/RESCUE_MARKERS_ONLY/
   * RESCUE_NO_CHECKOUT/a failure, each of which leaves whatever was stamped
   * before exactly as it was: a stale timestamp here is still valid evidence
   * of the last REAL sync, and clearing it on a quiet or failed tick would
   * throw away that evidence for no reason.
   */
  wipSyncedAt?: string | null;
  /**
   * Maestro review round 2 on PR #235 (issue #231), item 1 — the EXACT boot
   * stamp the push that stamped `wipSyncedAt` above actually targeted,
   * written in the SAME `mergeObserved` call, same "only on a real push"
   * discipline. Before this field, the survival brief derived the ref to
   * show from BRING-UP ORDERING (`ObservedSession.wipBootStampBefore` —
   * "what container was this before") rather than from the last successful
   * push itself: fine for the FIRST bring-up after a replacement (nothing
   * synced since, so "before" and "last synced" agree), but wrong for a
   * SECOND bring-up with no wip-sync tick in between — that bring-up's own
   * `wipBootStampBefore` is the FIRST bring-up's brand-new, never-synced
   * stamp, while `wipSyncedAt` still describes a push that happened under an
   * EARLIER stamp still. Rides `mergeObserved` exactly like `wipSyncedAt`
   * (own value, no separate DO-storage key) so it flows through
   * `getObserved`/`getObservedWithActivity`/`withObserved` automatically.
   * OPTIONAL/absent, same convention `wipSyncedAt` itself uses: no push has
   * ever landed yet, or this row predates the field.
   */
  wipSyncedBootStamp?: string | null;
  /**
   * Issue #241 item 4: the wip-sync target walk (rescue.ts's `wipSyncCmd`)
   * used to always start at the main checkout, then every member worktree in
   * the SAME fixed `worktree list --porcelain` order, every tick — a slow
   * target early in that order could burn most of the exec's own
   * `wip_budget_ok` budget and starve whichever target sorted last,
   * permanently, not just occasionally. This is the PERSISTED rotation
   * counter `wipSync` (do.ts) reads before building each tick's own command
   * (threaded in as `wipSyncCmd`'s `rotationIndex` param) and increments
   * AFTER, regardless of whether that tick succeeded, partially failed, or
   * fully failed — fairness is over TIME, not only on success. The real `%
   * tcount` (how many targets THIS tick actually found) only ever happens in
   * bash, every run; this value just needs to keep advancing. Absent/undefined
   * reads as `0` (every row that predates this field, or has never had a
   * wip-sync tick run) — same convention `wipSyncedAt` above already uses.
   * Wrapped at 1_000_000 before persisting — a cheap safety valve, never load
   * -bearing at any normal tick cadence (bash's own modulo against the real
   * target count is what actually matters), chosen simply to keep the stored
   * number small forever rather than growing without bound.
   */
  wipRotationIndex?: number;
  /**
   * Fix round (#208 PR #215 review, minor (a)): `wipSyncedAt` above only ever
   * advances on a genuine push — a studio that has been clean for days (the
   * common case) shows the SAME age as a studio whose last three ticks all
   * FAILED, because neither updates `wipSyncedAt` at all. `fleet ls`'s WIP
   * column could not tell "nothing to sync, checked recently" from "sync has
   * been failing" from "pushed recently" — all three rendered identically
   * (or not at all). This stamps EVERY wip-sync attempt, success or failure,
   * with WHAT happened on it — `fleet ls`/`fleet inspect` read this ALONGSIDE
   * `wipSyncedAt` to tell the three cases apart. Absent means "no wip-sync
   * tick has run yet for this row" (a studio not yet provisioned, or one from
   * before this field existed) — same trailing-optional convention every
   * other field in this struct added after its first release already uses.
   */
  wipLastCheck?: { at: string; result: "pushed" | "clean" | "markers-only" | "no-checkout" | "failed" } | null;
  /**
   * Issue #231 — the on-disk path(s) a `--fresh-session` bring-up actually
   * moved an old session aside to (`parseFreshSession`'s own successfully-
   * moved entries, provision.ts), so a lead told "what survived" after a
   * LATER heal/recycle has somewhere to go look rather than nothing: before
   * this field, the move was logged into `StudioStatus.error` only, which a
   * later bring-up overwrites, and a resumed/healed lead had no way to learn
   * an old session existed at all, let alone where.
   *
   * Stamped ONLY on an actual confirmed move (`freshSessionMoved`, a
   * non-empty list) — same "stamped on a real event, left alone otherwise"
   * convention `wipSyncedAt` above already follows: a later bring-up that
   * does not move anything leaves this exactly as it was, since the old
   * aside path is still real, on-disk evidence worth keeping.
   */
  lastSessionAside?: string[] | null;
  /**
   * Maestro review round 1 on PR #235, MAJOR 3 (issue #231) — WHEN
   * `lastSessionAside` above was stamped, same "sibling scalar, not a nested
   * object" shape `wipBootStamp` is to `incarnation`. `lastSessionAside`
   * itself never clears (a stale claim is still real, on-disk-once evidence,
   * same reasoning its own doc comment above gives for never auto-clearing
   * it), so a brief composed many bring-ups later needs this to render an
   * AGE next to the claim rather than repeat it as if it just happened —
   * `sessionAsideLine` (survival-brief.ts) is what reads it. Also the only
   * way that line can tell "this just happened" from "this is from weeks
   * ago, and the container has very likely been replaced since" — see that
   * line's own doc comment for the R2-vs-local-path half of this same fix.
   * OPTIONAL/absent: a record written before this field existed (or a
   * pre-#231 fixture) renders "unknown age" rather than failing to compile.
   */
  lastSessionAsideAt?: string | null;
  /**
   * Board issue #108 (#70 ask 4 remainder) — the lead's last visible,
   * non-chrome message line: redacted (`redactSecrets`, at the ship-tick
   * write boundary), bounded (activity.ts's `LAST_LINE_MAX_CHARS`), so a
   * coordinator reading `fleet ls --json` can tell roughly WHAT the lead is
   * doing/saying without attaching to the pane.
   *
   * Rides `mergeObserved` the same way `session`/`lastShipOkAt` do — NOT its
   * own DO-storage key the way `activity`/`memberAlerts` are, because this
   * field has no since/anchored state-machine semantics of its own, only
   * "the latest known value". `null` before the first ship tick extracts a
   * line, or when the most recent pane frame had no non-chrome content to
   * extract (every visible line was chrome, or the pane was empty).
   */
  lastMessageLine: string | null;
}

/**
 * Issue #249 (PR4b) round 2, item 2 — one deferred survival re-brief, with
 * everything the retry needs to compose and bound it.
 *
 * SELF-CONTAINED ON PURPOSE. The `session` verdict is COPIED in here rather
 * than re-read off `Observed.session` at retry time, for exactly the reason
 * `resolveSurvivalInput` (survival-delivery.ts) takes no storage port at all:
 * `snapshotAgeS` is a value computed ONCE, AT RESTORE TIME, and a later
 * bring-up (or the ship tick's own adoption verdict, do.ts) overwrites
 * `Observed.session` with a record describing a DIFFERENT moment. A retry that
 * re-read it could describe the wrong container's restore. The same reasoning
 * applies to `via`/`replacementDetected`: the allowlist already said yes to
 * THIS bring-up, and the retry must not re-decide that question against a
 * newer one.
 */
export interface SurvivalBriefPending {
  /** The incarnation token the owed brief is about — the dedup identity, the
   *  same one `survivalBriefDeliveredFor` records on success. A retry whose
   *  `Observed.incarnation` has since moved on drops the record instead of
   *  delivering it: the container it described is gone, and so is the disk
   *  state it was describing. */
  incarnation: string;
  via: BringupVia;
  replacementDetected: boolean;
  /** The bring-up's own session verdict, frozen at bring-up (see this
   *  interface's own doc comment for why it is copied rather than re-read). */
  session: ObservedSession;
  /** ISO timestamp of the FIRST deferral, never re-stamped — the anchor the
   *  time bound (`SURVIVAL_RETRY_WINDOW_MS`) measures from, the same
   *  stamped-once-and-left-alone discipline `replacedAt`/`unreachableSince`
   *  above already follow. */
  since: string;
  /** How many delivery attempts have been made and NOT landed, the bring-up's
   *  own first attempt included. Bounded by `SURVIVAL_RETRY_MAX_ATTEMPTS`. */
  attempts: number;
  /** Why the most recent attempt did not land — a busy pane, a board outage,
   *  a refused/unconfirmed wake. Already scrubbed with `redactSecrets` by the
   *  time it lands here (survival-delivery.ts's `deferPending`), the same
   *  "clean at construction" convention `ObservedSession.reason` follows. */
  reason: string;
  /** ISO timestamp of the moment the bound was exceeded and retrying STOPPED,
   *  or null/absent while retries are still owed. A set value is what
   *  `fleet ls` renders as `re-brief undelivered`
   *  (cli/readiness-format.ts's `formatSurvivalBriefs`); the record is kept
   *  rather than deleted precisely so that line has something to read. */
  gaveUpAt?: string | null;
  /**
   * Board issue #208, part 2 — `Observed.wipSyncedAt` AS IT STOOD at the
   * moment this bring-up happened, frozen here the same way `session` above
   * is: a retry can run several sync ticks after the heal, and by then a
   * fresh `wipSync` tick may already have overwritten `wipSyncedAt` with a
   * NEW timestamp describing time AFTER the heal, not the gap this field
   * exists to describe (the age of the last REAL push relative to the
   * replacement). OPTIONAL/absent reads as "no WIP sync had ever landed at
   * heal time" — the composer (survival-brief.ts) renders nothing for this
   * studio's WIP safety net in that case. */
  wipSyncedAt?: string | null;
  /** Maestro review round 2 on PR #235 (issue #231), item 1 —
   *  `Observed.wipSyncedBootStamp` AS IT STOOD at the moment this bring-up
   *  happened, frozen the same way `wipSyncedAt` just above is: the exact
   *  ref the LAST GENUINELY SYNCED push actually targeted, never derived
   *  from bring-up ordering (`wipBootStamp` below, which answers "what
   *  container was this before", a different question whenever two
   *  bring-ups happen with no wip-sync tick between them). See
   *  `Observed.wipSyncedBootStamp`'s own doc comment for the full bug this
   *  closes. OPTIONAL/absent: no push has ever landed — the composer falls
   *  back to `wipBootStamp` below's glob rendering. */
  wipSyncedBootStamp?: string | null;
  /** Issue #231 — `Observed.wipBootStamp` AS IT STOOD at this bring-up, frozen
   *  the same way `wipSyncedAt` above is: the real, exact wip ref name
   *  (`wipSyncRef(studioId, wipBootStamp)`) rather than survival-brief.ts's
   *  own glob fallback. OPTIONAL/absent reads as "no confirmed boot stamp at
   *  bring-up time" — the composer falls back to the glob in that case. */
  wipBootStamp?: string | null;
  /** Issue #231 — `Observed.lastSessionAside` AS IT STOOD at this bring-up,
   *  frozen the same way `session` above is: a retry can run long after a
   *  LATER bring-up has already overwritten `lastSessionAside` with a
   *  different move's own paths. OPTIONAL/absent reads as "nothing moved
   *  aside as of this bring-up" — the composer renders nothing for it. */
  lastSessionAside?: string[] | null;
  /** Maestro review round 1 on PR #235, MAJOR 3 (issue #231) —
   *  `Observed.lastSessionAsideAt` AS IT STOOD at this bring-up, frozen the
   *  same way `lastSessionAside` above is, so a retry composed long after the
   *  heal still renders the real age rather than "just now". OPTIONAL/absent
   *  reads as "unknown age" — see `Observed.lastSessionAsideAt`'s own doc
   *  comment for the full reasoning. */
  lastSessionAsideAt?: string | null;
  /**
   * Maestro review round 2 on PR #235 (issue #231), item 2b — the DO's own
   * `ASIDE_SHIP_KEY` record (session-sync.ts), AS IT STOOD at this bring-up,
   * frozen the same way `lastSessionAside` above is: a retry runs on a later
   * sync tick, by which point a fresh ship attempt may have overwritten the
   * live key with a record describing a DIFFERENT move. See
   * `SurvivalInput.asideShip`'s own doc comment (survival-brief.ts) for the
   * three states this carries. OPTIONAL/absent reads as "no ship attempt had
   * run yet at bring-up time" — the composer renders "will ship on the next
   * session sync" in that case, never the confident R2 path. */
  asideShip?: AsideShipRecord | null;
}

/** The DO-storage slice this feature touches — same narrow-port style
 *  SweepStorage/TranscriptStorage/SessionSyncStorage take, so callers are
 *  testable over a plain Map with no SDK import. */
export interface ObservedStorage {
  get(key: typeof OBSERVED_KEY): Promise<Observed | undefined>;
  put(key: typeof OBSERVED_KEY, value: Observed): Promise<void>;
}

export function emptyObserved(): Observed {
  return {
    incarnation: null, replacedAt: null, execFailures: 0, unreachableSince: null,
    lastShipOkAt: null, lastSnapshotAt: null, session: null, activity: null, memberAlerts: null,
    survivalBriefDeliveredFor: null, survivalBriefPending: null, lastMessageLine: null,
    taskWakesDeliveredFor: null,
  };
}

/** Board issue #183 — the fix's own threshold: ≥2 consecutive failed ship
 *  ticks AND ≥90s elapsed since the last known-good tick (`lastShipOkAt`).
 *  Review round 7 simplification: this constant (and `isUnreachable` below)
 *  now feeds ONLY the render-side gate (`readyOverride`/
 *  `formatUnreachableLine`, cli/readiness-format.ts) — the DO-side
 *  out-of-cadence D1-write trigger (`runShipTickWithObservation`, do.ts)
 *  lives entirely in that file now, as a plain `execFailures === 2`
 *  checkpoint that never calls `isUnreachable` or reads this constant. See
 *  `isUnreachable`'s own doc comment just below for why that composition
 *  turned out to be dead weight. */
export const UNREACHABLE_ELAPSED_MS = 90_000;

/**
 * Board issue #183 — replaces the old fixed `execFailures >= 3` render gate
 * (issue #85 PR1) with the maestro's own stated fix: "unreachable iff ≥2
 * consecutive failed ship ticks AND now − <anchor> ≥ 90s".
 *
 * Anchor, in priority order: `lastShipOkAt` when known (the genuine "since
 * when has nothing come back" timestamp — see that field's own doc comment),
 * falling back to `unreachableSince` when it is not. Review round 2, MUST-FIX
 * 2 — a studio WEDGED FROM THE VERY START (dead immediately at deploy, or a
 * fresh studio whose container never comes up reachable even once) never
 * records a `lastShipOkAt` at all, since that field only ever advances on a
 * SUCCESSFUL tick — under `lastShipOkAt` alone, exactly the studios most in
 * need of the "unreachable" signal (dead from birth) could never show it, no
 * matter how long they stayed dead. `unreachableSince` IS available for such
 * a studio: it is stamped at the FIRST FAILURE of a streak (do.ts), which
 * needs only one failure ever, never a prior success. When BOTH are null (not
 * even one failure has been recorded yet under this feature) there is
 * nothing to measure elapsed time from, so this still correctly returns
 * `false` rather than guessing.
 *
 * Shared by the render-side gate in `cli/readiness-format.ts`
 * (`formatUnreachableLine`). `runShipTickWithObservation`
 * (do.ts) does NOT call this for its own out-of-cadence D1-write trigger —
 * board issue #183 review round 7 found that composing a transition check
 * out of two calls to this predicate (pre- and post-increment
 * `execFailures`, same anchor, same `now`) was provably dead weight: this
 * function only ever consults `execFailures` through the `< 2` gate above,
 * so that composition was always either false or exactly redundant with a
 * plain `execFailures === 2` checkpoint. `runShipTickWithObservation` uses
 * that simpler checkpoint directly instead — see its own doc comment. If
 * this gate ever grows conditions beyond `execFailures < 2`, re-examine that
 * assumption.
 */
export function isUnreachable(
  observed: Pick<Observed, "execFailures" | "lastShipOkAt" | "unreachableSince">, now: Date,
): boolean {
  const anchor = observed.lastShipOkAt ?? observed.unreachableSince;
  if (observed.execFailures < 2 || anchor === null) return false;
  return now.getTime() - Date.parse(anchor) >= UNREACHABLE_ELAPSED_MS;
}

/**
 * Review round 3 (issue #85 PR1), MUST-FIX 10: merges a stored record over
 * `emptyObserved()`'s defaults rather than returning it as-is. Every WRITE
 * path in this feature already goes through `mergeObserved` (below), which
 * itself starts from `getObserved`'s own result — so today, by
 * construction, no stored record is ever partial. But that guarantee is
 * only as good as "every write path forever remembers to route through
 * mergeObserved" — a future field added to `Observed` (or any write that
 * ever bypasses mergeObserved) would otherwise read back `undefined` on an
 * old stored record rather than that field's declared default. Spreading
 * `emptyObserved()` first makes that safe unconditionally, at the one read
 * boundary every caller already goes through, rather than depending on
 * every future writer never getting this wrong.
 */
export async function getObserved(storage: ObservedStorage): Promise<Observed> {
  const stored = await storage.get(OBSERVED_KEY);
  if (stored === undefined) return emptyObserved();
  return { ...emptyObserved(), ...stored };
}

/** Read-patch-write, in one call — every writer in this feature uses this
 *  rather than a bare `storage.put(OBSERVED_KEY, ...)`, so a caller that
 *  only knows ONE field (e.g. the ship tick's execFailures bump) never has
 *  to first re-read and hand-spread the rest itself. */
export async function mergeObserved(storage: ObservedStorage, patch: Partial<Observed>): Promise<Observed> {
  const current = await getObserved(storage);
  const next: Observed = { ...current, ...patch };
  await storage.put(OBSERVED_KEY, next);
  return next;
}

/** Where every bring-up path writes a fresh random id, and where the ship
 *  tick reads it back. A replaced (or slept, disk-wiped) container has no
 *  file here — see the ship-tick task's own doc comment for the read side. */
export const INCARNATION_PATH = "/workspace/.fleet/incarnation";

/** POSIX single-quoting — the only quoting that is total (everything inside
 *  a single-quoted string is literal). Same private, per-file copy every
 *  other command builder in this feature keeps (wake.ts's shellQuote,
 *  transcript.ts's shellSingleQuote, failover.ts's shellQuote) — this
 *  file's own token is always a crypto.randomUUID() output and never
 *  quote-bearing in practice, but the escaping is cheap enough to always do
 *  right regardless. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Never uses the shell `exit` builtin — same HARD RULE every sbExec command
 * in this feature follows (provision.ts's PROVISIONED_OK doc comment):
 * every exec here runs inside the shared long-lived "sandbox-default"
 * session, and `exit` there kills that session's shell rather than the
 * command.
 *
 * Maestro correction #2 (replayed, confirmed the bug): writes with a
 * TRAILING NEWLINE (`printf '%s\n'`, not `'%s'`) to a tmp file, then `mv`s
 * it into place. The newline matters because every reader of this file
 * (Task 4's ship tick, Task 9's `fleet inspect`) echoes it directly into a
 * multi-section stdout stream — a file with no trailing newline glues onto
 * whatever the reader's NEXT `echo` prints, on the same line, and every
 * downstream section-line parser in this feature splits on `\n` and looks
 * for an EXACT line match. The tmp+`mv` (rather than a direct `>` redirect)
 * makes the write atomic: a concurrent reader (the ship tick can fire while
 * a bring-up's own token write is still in flight — see Task 4's op-lock
 * section) never observes a partially-written file, only the old token or
 * the new one, never a truncated one.
 */
export function writeIncarnationCmd(token: string): string {
  const quoted = shellQuote(token);
  // `$(dirname ${INCARNATION_PATH})`, not a hardcoded `/workspace/.fleet`:
  // one source of truth for the directory this file lives in, derived from
  // the SAME constant the write/rename targets below already use, computed
  // by the shell at run time rather than baked in here. A CI fix
  // (test/bun/incarnation-newline.test.ts) surfaced the hardcoded-prefix
  // version's real bug — it only ever rewrote INCARNATION_PATH's leaf file
  // path into a throwaway test dir, never this directory string, so
  // `mkdir -p /workspace/.fleet` on a non-root runner failed regardless of
  // where the test pointed the file itself.
  return (
    `mkdir -p "$(dirname ${INCARNATION_PATH})" && ` +
    `printf '%s\\n' ${quoted} > ${INCARNATION_PATH}.tmp && mv ${INCARNATION_PATH}.tmp ${INCARNATION_PATH}`
  );
}

/**
 * Maestro correction #2 — the ONE reading convention every consumer of
 * `INCARNATION_PATH` (Task 4's ship tick, Task 9's `fleet inspect`) must use
 * instead of a bare `cat FILE 2>/dev/null || echo ''` glued straight into
 * the surrounding command's stdout. `echo "$(cat FILE 2>/dev/null)"`
 * captures the file's content into a subshell first (so a missing trailing
 * newline never bleeds into whatever the caller echoes next) and `echo` on
 * the outside always terminates with exactly one newline, whether the file
 * existed, was empty, or was missing entirely — the `|| echo ''` fallback
 * is unnecessary once the read is inside `$(...)`, since a failed `cat`
 * inside a command substitution just yields an empty string, not a
 * shell-level failure that would need `||` to survive.
 */
export function readFileLineCmd(path: string): string {
  return `echo "$(cat ${path} 2>/dev/null)"`;
}

/**
 * Maestro correction #3 — every token this feature stores or trusts as "the
 * container's own" is a `crypto.randomUUID()` output. Validated in its
 * canonical shape before EITHER storing it or comparing it against a stored
 * one, so a truncated/garbled read — a race against this task's own atomic
 * write, or genuinely arbitrary content some other process left at this
 * path — is never mistaken for a real replacement or a real match.
 */
export function isIncarnationToken(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Session verdict — issue #85, signal 3. Maestro correction #9 redesign: the
// pane-lead probe never returns raw argv to the Worker (a member's
// --append-system-prompt payload can be many KB); it decides yes/no on
// --continue IN THE SHELL, per-argv-element, and returns only that boolean
// plus the resolved cwd.
// ---------------------------------------------------------------------------

export const SESSION_FOUND_SECTION = "---FLEET-SESSION-FOUND---";
export const SESSION_CONTINUE_SECTION = "---FLEET-SESSION-CONTINUE---";
export const SESSION_CWD_SECTION = "---FLEET-SESSION-CWD---";
/** Issue #85 review round 3, MUST-FIX 3 — the lead's own age (`ps -o
 *  etimes=`, elapsed seconds since the process started), so a caller can
 *  tell whether THIS bring-up actually launched the lead it is now looking
 *  at, or found one that predates it and left it untouched. See
 *  `bringupLeftLeadUntouched`'s own doc comment below for why this matters. */
export const SESSION_LEAD_AGE_SECTION = "---FLEET-SESSION-LEAD-AGE---";

/** Matches inspect.ts's own INSPECT_TARGET value ("studio:claude"). A
 *  private, per-file copy rather than an import — inspect.ts (Task 9)
 *  imports FROM this file (INCARNATION_PATH), so importing back would be
 *  circular; the same "own copy of a small shared value when importing
 *  would cycle" reasoning shellQuote's own doc comment already gives. */
const LEAD_PANE_TARGET = "studio:claude";

/**
 * Issue #85, signal 3, maestro correction #9 — ONE exec: verify
 * `#{session_name}:#{window_name}` is ACTUALLY `studio:claude` before
 * trusting anything read from it (a missing window can otherwise answer
 * `tmux display -p -t studio:claude` with a DIFFERENT pane and exit 0 —
 * measured, not theorised, the exact bug `inspect.ts`'s own `inspectCmd`
 * already guards against with the identical case-match pattern). Then the
 * pane_pid's DIRECT child NAMED `claude` (`pgrep -x claude -P` — a member
 * `claude -p` subprocess sits at least one level deeper under the LEAD, and
 * `-x` rules out a wrapper/shell process with a similar name). Reports
 * yes/no on `--continue` via a PER-ARGV-ELEMENT exact match
 * (`tr '\0' '\n' | grep -qxF -- --continue`) rather than returning the raw
 * argv to the Worker — the argv can carry an `--append-system-prompt`
 * payload up to 8KB, and a naive substring check on the whole line could
 * false-positive on an unrelated flag that merely CONTAINS the text
 * `--continue`. Never `exit` (same HARD RULE every command in this feature
 * follows — see writeIncarnationCmd's own doc comment).
 *
 * Review round 3 (issue #85 PR1), MUST-FIX 3: also reports the lead's own
 * AGE (`ps -o etimes=`, elapsed seconds since the process started) — procps
 * IS present in the studio image (this function already relies on `pgrep`
 * above; ps ships in the same package), so this is not a new dependency.
 * `bringupLeftLeadUntouched` (below) is what this age is for.
 *
 * CI-caught (#117/#85): the `tmux display` call below is the one this whole
 * function exists to run against the studio session, so it is wrapped in
 * `withStudioTmux` (tmux.ts) and calls `${STUDIO_TMUX}` rather than the raw
 * binary — same reasoning as `inspectCmd`'s (inspect.ts) identical fix,
 * `test/bun/tmux-socket-pin.test.ts`'s source scan pins it fleet-wide. A
 * caller that embeds this function's return value into a larger command
 * that ALSO wraps itself with `withStudioTmux` (none does today) would
 * define `__ff_tmux` twice in the combined script — `tmux.ts`'s own doc
 * comment calls that explicitly harmless, and `test/bun/cmd-syntax.test.ts`
 * verifies every embedding still parses under `bash -n`.
 */
export function paneLeadProbeCmd(): string {
  return withStudioTmux(
    `FLEET_PANE="$(${STUDIO_TMUX} display -p -t ${LEAD_PANE_TARGET} '#{session_name}:#{window_name} #{pane_pid}' 2>/dev/null)"; ` +
    `case "$FLEET_PANE" in ` +
    `"${LEAD_PANE_TARGET} "*) FLEET_PANE_PID="\${FLEET_PANE#${LEAD_PANE_TARGET} }" ;; ` +
    `*) FLEET_PANE_PID="" ;; ` +
    `esac; ` +
    `FLEET_LEAD_PID=""; ` +
    `if [ -n "$FLEET_PANE_PID" ]; then FLEET_LEAD_PID="$(pgrep -x claude -P "$FLEET_PANE_PID" 2>/dev/null | head -n1)"; fi; ` +
    `echo '${SESSION_FOUND_SECTION}'; ` +
    `if [ -n "$FLEET_LEAD_PID" ]; then echo yes; else echo no; fi; ` +
    `echo '${SESSION_CONTINUE_SECTION}'; ` +
    `if [ -n "$FLEET_LEAD_PID" ] && tr '\\0' '\\n' < /proc/$FLEET_LEAD_PID/cmdline 2>/dev/null | grep -qxF -- --continue; then echo yes; else echo no; fi; ` +
    `echo '${SESSION_CWD_SECTION}'; ` +
    `if [ -n "$FLEET_LEAD_PID" ]; then readlink /proc/$FLEET_LEAD_PID/cwd 2>/dev/null; fi; echo; ` +
    `echo '${SESSION_LEAD_AGE_SECTION}'; ` +
    `if [ -n "$FLEET_LEAD_PID" ]; then ps -o etimes= -p "$FLEET_LEAD_PID" 2>/dev/null | tr -d ' '; fi; echo`
  );
}

export interface PaneProbeResult {
  ok: boolean;
  /** Whether a lead process was actually located. `false` is its own
   *  outcome — maestro correction #9 — never folded into fresh/lost. */
  found: boolean;
  hasContinue: boolean;
  cwd: string | null;
  /** Issue #85 review round 3, MUST-FIX 3 — elapsed seconds since the lead
   *  process started (`ps -o etimes=`), or null when no lead was found, the
   *  probe itself failed, or `ps` produced nothing parseable. */
  leadAgeS: number | null;
  error: string | null;
}

/**
 * Issue #85 review round 3, MUST-FIX 4 (board #120): a resumed session can
 * legitimately re-enter the studio through a worktree sub-checkout under
 * `<expectedCwd>/.claude/worktrees/<name>` — the lead's actual cwd is then
 * that sub-path, never `expectedCwd` itself, and a bare `===` compare read
 * that as a mismatch (cwd wrong -> LOST) even though the lead is exactly
 * the same studio, resumed. A cwd that merely starts with the SAME PREFIX
 * STRING but is not actually a worktree path under it (e.g.
 * `${expectedCwd}-other`) must NOT match — the boundary check requires the
 * `/.claude/worktrees/` segment literally, not just a shared string prefix.
 */
function cwdMatchesExpected(cwd: string | null, expectedCwd: string): boolean {
  if (cwd === expectedCwd) return true;
  if (cwd === null) return false;
  return cwd.startsWith(`${expectedCwd}/.claude/worktrees/`);
}

export function parsePaneLeadProbe(stdout: string): PaneProbeResult {
  const lines = stdout.split("\n");
  const at = (marker: string): string => {
    const idx = lines.indexOf(marker);
    return idx === -1 ? "" : (lines[idx + 1] ?? "").trim();
  };
  const found = at(SESSION_FOUND_SECTION) === "yes";
  const hasContinue = at(SESSION_CONTINUE_SECTION) === "yes";
  const cwd = at(SESSION_CWD_SECTION);
  const rawAge = at(SESSION_LEAD_AGE_SECTION);
  const parsedAge = rawAge === "" ? NaN : Number(rawAge);
  const leadAgeS = Number.isFinite(parsedAge) ? parsedAge : null;
  return { ok: true, found, hasContinue, cwd: cwd === "" ? null : cwd, leadAgeS, error: null };
}

/**
 * Issue #85 review round 3, MUST-FIX 3 — bring-up NO-OPS when claude is
 * already running in the pane (container/studio-bringup.sh: "claude is
 * ALREADY running in tmux studio:claude -- launched nothing and left the
 * existing lead untouched"), but bring-up itself never learns that fact —
 * it always answers success. Reading the LIVE lead's argv/cwd after such a
 * no-op recomputes a session verdict from a launch THIS bring-up never
 * performed: on that lead's first-ever launch (no `--continue`, because
 * nothing has restarted it since), the recompute reads LOST even though
 * bring-up changed nothing.
 *
 * `leadAgeS` (etimes) answers whether the lead PREDATES this bring-up: if
 * the lead is older than the time elapsed since bring-up itself started,
 * bring-up cannot have launched it, so the caller must keep whatever
 * session verdict was already recorded rather than recompute a fresh
 * (and wrong) one from a process it never touched.
 */
export function bringupLeftLeadUntouched(leadAgeS: number | null, bringupStartedAt: string, now: string): boolean {
  if (leadAgeS === null) return false;
  const bringupAgeS = Math.floor((Date.parse(now) - Date.parse(bringupStartedAt)) / 1000);
  return leadAgeS > bringupAgeS;
}

/**
 * Issue #85 review round 3, MUST-FIX 8(d) — maestro ruling on what a
 * restore's snapshot age MEANS: work genuinely AT RISK, i.e. (the OLD
 * container's STOP time) minus (the snapshot's own R2 upload time) — never
 * (restore time, or bring-up's own record time) minus (snapshot time), since
 * time spent STOPPED before the restore is not additional lost work (a
 * clean destroy whose final sync just succeeded, restored a week later,
 * lost nothing in that week — only whatever was unsynced at the moment it
 * actually stopped).
 *
 * Old-container stop time, in priority order:
 *   (i)   a persisted `lastStop.at` (board issue #129, landed — do.ts's
 *         `LAST_STOP_KEY`/`LastStop`, `onStop`'s own record of the exact
 *         moment the containers library saw the container exit) — used ONLY
 *         when it falls inside the sane window `snapshotUploadedAt <=
 *         lastStop.at <= restoreObservedAt`. Outside that window (a stale or
 *         nonsensical value — e.g. a `lastStop` left over from a PRIOR
 *         incarnation, predating this snapshot, or one somehow after the
 *         restore was already observed) this rung is skipped entirely rather
 *         than trusted; the sanity bound exists precisely so a bad
 *         `lastStop.at` can never produce a negative or absurd age.
 *   (ii)  `Observed.replacedAt` — the ship tick's own first-evidence
 *         timestamp that the old container was already gone (Task 4). A
 *         real, exact stop-time signal for a genuine replacement (an image
 *         rollout, say), though it is null for an ordinary intentional
 *         destroy/recreate, which sets no such marker.
 *   (iii) unknown: falls back to `restoreObservedAt` (when the restore
 *         outcome itself was learned — see recordBringupObservation's own
 *         `onRestoreOutcome` capture), rendered as an explicit UPPER BOUND
 *         (`snapshotAgeIsUpperBound: true`) — restore time can only be LATER
 *         than the real stop time, so the figure can only overstate the
 *         real risk, never understate it.
 *
 * Clamped at 0: a snapshot uploaded AFTER the resolved stop time (clock
 * skew, or a sync that raced the stop and won) must never render a negative
 * age.
 *
 * WIRED (board #250, an #85/#118 follow-up): this function itself is
 * unchanged — it still only ever sees ONE `snapshotUploadedAt` string and has
 * no notion of `latest` vs. a daily keeper. What changed is which upload time
 * `recordBringupObservation` (provision.ts) now passes in: `latest`'s own
 * (`lastSnapshotAtBefore`/`r2Head(sessionLatestKey(...))`, exactly as before)
 * when the restore that just ran used `latest` or no `source` is known at
 * all, but a FRESH `r2Head` read of the keeper's OWN R2 object when
 * `runSessionRestore`'s `source` (`ProvisionDeps.onRestoreOutcome`'s own
 * second argument, now forwarded) is `"daily <date>"` — a keeper is, by
 * construction, from a genuinely OLDER snapshot than `latest`, so measuring
 * its age against `latest`'s own upload time would understate the real
 * work-at-risk age. See `recordBringupObservation`'s own doc comment for the
 * key-selection logic itself.
 */
export function resolveSnapshotAge(
  snapshotUploadedAt: string, replacedAt: string | null, restoreObservedAt: string,
  lastStopAt: string | null = null,
): { snapshotAgeS: number; snapshotAgeIsUpperBound: boolean } {
  const lastStopInRange = lastStopAt !== null
    && Date.parse(snapshotUploadedAt) <= Date.parse(lastStopAt)
    && Date.parse(lastStopAt) <= Date.parse(restoreObservedAt);
  const stopAt = lastStopInRange ? lastStopAt : (replacedAt ?? restoreObservedAt);
  const snapshotAgeIsUpperBound = !lastStopInRange && replacedAt === null;
  const seconds = Math.floor((Date.parse(stopAt) - Date.parse(snapshotUploadedAt)) / 1000);
  return { snapshotAgeS: Math.max(0, seconds), snapshotAgeIsUpperBound };
}

/**
 * Issue #85, signal 3 — pure verdict decision. `expectedCwd` is
 * `/workspace/<repo-segment>`, resolved by the caller from the studio's own
 * id (parseStudioId) — this function stays free of ids.ts so it composes
 * cleanly with failover.ts too, which never imports ids.ts today. Maestro
 * correction #9: a probe that succeeded but found no lead pid is its own
 * `unknown` outcome, never treated as `fresh` (no history) or `lost` (has
 * history) — the process simply was not there to ask.
 *
 * Code-reviewer finding (issue #85 PR1): `reason` is scrubbed with
 * `redactSecrets` HERE, at construction, rather than only at the D1-mirror
 * write boundary (registry.ts's cleanObserved) — the same "clean at the
 * point the raw value is first held" convention `error`/`readiness.reason`
 * already follow (provision.ts's catch-time scrub, do.ts's readinessOf).
 * `probe.error` is a raw exec error message and `probe.cwd` is a
 * container-reported path — either can carry FLEET_SPAWN_TOKEN/
 * CLAUDE_CODE_OAUTH_TOKEN-shaped content echoed back from a failed
 * bring-up, exactly like `StudioStatus.error` can. Fixing it here (rather
 * than at each of the six routes that can return an `Observed` record)
 * means every writer of `mergeObserved({ session: ... })` — provision.ts's
 * recordBringupObservation, do.ts's ship tick — stores an already-clean
 * value, so no route-level patch can be missed.
 */
export function computeSessionVerdict(
  probe: PaneProbeResult, expectedCwd: string, restore: RestoreOutcome,
  turnsBefore: number, snapshotAgeS: number | null, at: string, via: BringupVia,
): ObservedSession {
  if (!probe.ok) {
    const reason = probe.error === null ? null : redactSecrets(probe.error);
    return { verdict: "unknown", at, via, restore, snapshotAgeS, turnsBefore, reason };
  }
  if (!probe.found) {
    return { verdict: "unknown", at, via, restore, snapshotAgeS, turnsBefore, reason: "no lead process found" };
  }
  const cwdMatches = cwdMatchesExpected(probe.cwd, expectedCwd);
  const hasHistory = turnsBefore > 0 || restore === "restored";
  if (probe.hasContinue && cwdMatches) {
    return { verdict: "resumed", at, via, restore, snapshotAgeS, turnsBefore, reason: null };
  }
  if (!hasHistory) {
    return { verdict: "fresh", at, via, restore, snapshotAgeS, turnsBefore, reason: null };
  }
  const reason = !cwdMatches ? redactSecrets(`cwd ${probe.cwd ?? "unknown"}`) : "no --continue";
  return { verdict: "lost", at, via, restore, snapshotAgeS, turnsBefore, reason };
}

/**
 * Issue #85, maestro correction #7 — the ship tick's OWN verdict, used only
 * on an adoption (the DO never recorded a token — a pre-feature studio, or
 * the first tick after this deploy). Deliberately narrower than
 * `computeSessionVerdict`: adoption genuinely does not know the launch
 * history, so it is never allowed to answer `lost` (which would routinely
 * be wrong the moment a long-lived pre-feature studio is simply mid-turn
 * with no `--continue` because it was launched fresh, once, a long time
 * ago) or `fresh` (which would be wrong the moment it has real history).
 * `restore` is always `"not-attempted"` — an adoption is not a bring-up.
 *
 * Same code-reviewer fix as `computeSessionVerdict` above: `probe.error` is
 * scrubbed at construction, not only at a later write/output boundary.
 */
export function computeAdoptedVerdict(
  probe: PaneProbeResult, expectedCwd: string, turnsBefore: number, at: string,
): ObservedSession {
  // Same worktree-cwd widening as computeSessionVerdict's own cwdMatches
  // above (#120, MUST-FIX 4) — an adoption probing a resumed session that
  // re-entered through a worktree sub-checkout must not read it as a
  // mismatch either.
  if (probe.ok && probe.found && probe.hasContinue && cwdMatchesExpected(probe.cwd, expectedCwd)) {
    return { verdict: "resumed", at, via: "adopted", restore: "not-attempted", snapshotAgeS: null, turnsBefore, reason: null };
  }
  const reason = !probe.ok
    ? (probe.error === null ? null : redactSecrets(probe.error))
    : "adopted: launch history unknown";
  return { verdict: "unknown", at, via: "adopted", restore: "not-attempted", snapshotAgeS: null, turnsBefore, reason };
}

export const BRINGUP_TOKEN_WRITE_SECTION = "---FLEET-BRINGUP-TOKEN---";

/**
 * Issue #85, maestro correction #6 — folds the incarnation token write and
 * the pane-lead probe into ONE `sbExec` call, so a bring-up never issues
 * two sequential container calls where a hang in the first would otherwise
 * silently skip the second. `$?` right after the `mkdir && printf && mv`
 * chain reflects that WHOLE chain's own success (the last-executed step's
 * exit code, whether that is `mv` succeeding or an earlier step failing and
 * short-circuiting the rest) — captured into `FLEET_TOKEN_OK` before
 * anything else can reset `$?`.
 */
export function bringupObservationCmd(token: string): string {
  const quoted = shellQuote(token);
  // Same fix as `writeIncarnationCmd` above: `$(dirname ${INCARNATION_PATH})`,
  // not a hardcoded `/workspace/.fleet` — one source of truth for the
  // directory, derived from the same constant the write/rename targets
  // already use, computed by the shell at run time rather than baked in as
  // a second string that can drift.
  return (
    `mkdir -p "$(dirname ${INCARNATION_PATH})" && printf '%s\\n' ${quoted} > ${INCARNATION_PATH}.tmp && mv ${INCARNATION_PATH}.tmp ${INCARNATION_PATH}; ` +
    `FLEET_TOKEN_OK=$?; ` +
    `echo '${BRINGUP_TOKEN_WRITE_SECTION}'; if [ "$FLEET_TOKEN_OK" -eq 0 ]; then echo yes; else echo no; fi; ` +
    paneLeadProbeCmd()
  );
}

export function parseBringupObservation(stdout: string): { tokenWritten: boolean; probe: PaneProbeResult } {
  const lines = stdout.split("\n");
  const idx = lines.indexOf(BRINGUP_TOKEN_WRITE_SECTION);
  const tokenWritten = idx !== -1 && (lines[idx + 1] ?? "").trim() === "yes";
  return { tokenWritten, probe: parsePaneLeadProbe(stdout) };
}
