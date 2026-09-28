// Session-state sync — tars the container's `~/.claude/projects` +
// `~/.claude.json` on StudioDO's `syncSession` schedule (do.ts, every 300s,
// plus once before every restart's bring-up and once more right before every
// recycle's destroy — see do.ts's `restartWithSync`/`recycleWithSync`) and
// ships it to R2, so a recycled/restarted container can restore claude's
// own session history and `--continue` finds it.
// docs/superpowers/specs/2026-08-16-studio-memory-p2-design.md, Plane 2
// (rulings R-P2-1 pull-not-push, R-P2-3 best-effort snapshot).
//
// Constants (size thresholds, split-part size, daily-keeper count, R2 key
// formats) all come from src/studio/archive.ts (Task 1) — imported below,
// never redefined here, same discipline transcript.ts's header documents for
// itself.
//
// Unlike transcript.ts's shipTranscriptTick, this tick carries no
// offset/manifest: every tick re-tars the WHOLE session directory fresh (the
// design's own "best-effort snapshot" ruling — a mid-write tar loses at most
// one in-flight jsonl line, and claude's session files are small enough that
// re-tarring from scratch every 300s is cheap, unlike the transcript log
// which can grow unbounded and therefore needs an append/offset scheme).
//
// Import-safe under vitest-pool-workers (no "@cloudflare/sandbox" value
// import) — same reason transcript.ts's header gives for itself — so its
// tests exercise syncSessionTick/restorePlan directly, not a hand-copied
// re-implementation.
import type { RescueTarget } from "./rescue";
import {
  sessionLatestKey, sessionDailyKey, sessionDisplacedKey, sessionSupersededKey,
  SESSION_SINGLE_READ_MAX, SESSION_SPLIT_PART, SESSION_TOTAL_MAX, SESSION_DAILY_KEEPERS,
  SESSION_DISPLACED_KEEPERS, SESSION_SUBAGENT_RAW_BUDGET, SESSION_SUBAGENT_LIVE_WINDOW_SECONDS,
  SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS,
} from "./archive";
// Task 4 (P2 plane 4): burn.ts is pure (no I/O, no storage/exec ports of its
// own — see its own header) — this file is where its output actually gets
// persisted and where the telegram alert decision is acted on, the same
// "orchestration lives in the file that owns the Tick function, pure math
// lives in the imported helper" split archive.ts's constants/transcript.ts's
// shipTranscriptTick already establish for this feature.
import {
  burnIncrement, rollWindow, shouldAlert, freshBurn, pruneCursor, pruneCursorForSize,
  sessionStats, newestMark, poorerThan,
  type BurnCursor, type Burn, type SessionMark, type SessionStats,
} from "./burn";

/** Where the tar lands on the container before it's read back out — mirrors
 *  transcript.ts's TRANSCRIPT_LOG_PATH (a fixed, script-agreed path constant
 *  exported for both the command builders below and any future bring-up
 *  cross-reference). */
export const SESSION_SYNC_DIR = "/workspace/.session-sync";
/** `$HOME` for this container's root user — the directory both the `find`
 *  selection and `tar -C` are relative to. Named rather than inlined because
 *  syncSessionTick now passes it explicitly (it has to pass the watermark,
 *  which comes last), and the default and the real call must never drift. */
const SESSION_HOME = "/root";
export const SESSION_TAR_PATH = `${SESSION_SYNC_DIR}/latest.tar.gz`;
/** Issue #202: `tar -X` list of the subagent transcripts this tick's tar
 *  leaves OUT (see tarAndStatCmd). Lives under SESSION_SYNC_DIR — i.e. under
 *  /workspace, never under /root — so the list can never become a member of
 *  the very archive it shapes. Rewritten from scratch every tick. */
export const SESSION_EXCLUDES_PATH = `${SESSION_SYNC_DIR}/subagent-excludes.txt`;

/** Cadence of the syncSession tick (do.ts's own schedule) — moved here from
 *  do.ts (issue #85) so cli/readiness-format.ts, which must stay import-safe
 *  under the root tsconfig (see that file's own header — no
 *  "@cloudflare/sandbox" in its import graph), can derive its 660s
 *  staleness threshold from the SAME constant do.ts schedules against,
 *  rather than a second hardcoded copy. */
export const SYNC_SESSION_SECONDS = 300;

/** DO storage key: the UTC calendar date (`yyyy-mm-dd`) the daily keeper was
 *  last written for. Exported so a test can seed/read it directly, the same
 *  reason transcript.ts exports TRANSCRIPT_MANIFEST_KEY etc. */
export const SESSION_DAILY_DATE_KEY = "sessionDailyDate";
/** Task 4 (P2 plane 4): this feature's own three new DO storage keys —
 *  same "narrow port owns its own keys" discipline SESSION_DAILY_DATE_KEY
 *  above already follows (and transcript.ts's TranscriptStorage follows for
 *  its own three keys). `BURN_CURSOR_KEY` is the incremental per-file byte
 *  cursor (burn.ts's BurnCursor); `BURN_KEY` the running counters
 *  (burn.ts's Burn); `BURN_ALERTED_WINDOW_KEY` the once-per-window alert
 *  marker — the brief's own literal name, mirroring do.ts's
 *  `lastRefreshError` once-per-streak marker pattern, keyed on the current
 *  window's OWN identity (`Burn.window5hStart`) rather than a boolean, so a
 *  window roll is what resets it (see burn.ts's shouldAlert doc comment). */
export const BURN_CURSOR_KEY = "burnCursor";
export const BURN_KEY = "burn";
export const BURN_ALERTED_WINDOW_KEY = "burnAlertedWindow";
/** Issue #94: the newest session file (and its line count) of the snapshot
 *  last written to `latest` — the sync guard's baseline. */
export const SESSION_MARK_KEY = "sessionMark";
/**
 * Issue #202, review round 3: the BURN WATERMARK — the container epoch at the
 * start of the tar whose burn was last successfully parsed. A `number`,
 * seconds since the epoch, on the CONTAINER's clock (the same clock `date +%s`
 * inside tarAndStatCmd reads), never the Worker's.
 *
 * Written ONLY after `parseBurn` returns cleanly over that tick's bytes —
 * uploaded or displaced, both parse. A tick that threw, that was skipped as
 * oversize, or whose burn parse failed leaves the PRIOR value in place, so
 * the next tick still admits everything the failed one may have missed. That
 * asymmetry is deliberate and always errs the same way: a watermark that is
 * too OLD only over-admits (the per-file byte cursor dedupes, so nothing is
 * double-counted), while one that is too NEW skips a tail permanently.
 */
export const SESSION_BURN_WATERMARK_KEY = "burnWatermark";
/** Issue #94: the most recent refused candidate, or null once a later tick
 *  writes `latest` again. do.ts mirrors it onto StudioStatus.sessionGuard. */
export const SESSION_GUARD_KEY = "sessionGuard";

/**
 * Board #140 (HOLD fix): armed by do.ts's `clearSessionGuard`, consumed
 * (deleted) by the NEXT `syncSessionTick` that actually force-uploads.
 * Deleting SESSION_MARK_KEY alone (the original #140 design) was a no-op in
 * the exact case it exists for: the next tick's `mark ?? seedMark(...)`
 * re-derives a mark from R2's CURRENT `latest`, the same `latest` every
 * candidate has been losing to — so the freshly re-seeded mark displaces the
 * very next candidate for the same reason, unsticking nothing. This key
 * instead tells the next tick to skip the mark/`poorerThan` comparison
 * entirely for exactly one tick (see `syncSessionTick`'s own doc comment).
 * Boolean-shaped (`true` only; absent/`undefined` means disarmed) rather
 * than `SESSION_GUARD_KEY`'s nullable pattern, because there is no
 * meaningful "explicitly disarmed" value distinct from "never armed" — both
 * mean the same thing to the tick, so plain deletion (like
 * `SESSION_MARK_KEY`'s own delete-only precedent) is enough.
 */
export const SESSION_FORCE_KEY = "sessionForceUpload";

/** Issue #94: what the guard refused, when, where it went (`key`; empty for
 *  an oversize refusal, #176, which writes nothing), and why. An oversize
 *  refusal also carries the tar's size and the cap, and `at` is the FIRST
 *  refusal of the streak — the row says since when the studio stopped
 *  syncing, not the latest tick. */
export type SessionGuard = { at: string; key: string; reason: string; tarBytes?: number; capBytes?: number };

/**
 * Issue #258 round-2 review (MED): the burn cursor/burn PERSIST failure
 * record — its OWN key, distinct from `SESSION_GUARD_KEY`. Round 1 rode
 * `SESSION_GUARD_KEY` for this (the one channel already mirrored onto
 * `StudioStatus`), but that key already means something ELSE — "session sync
 * REFUSED a poorer/blank candidate, `latest` is stale as of `at`" (line 770's
 * write, below) — and the two are unrelated failure modes that can both
 * occur on the very SAME tick: a displaced (poorer-snapshot) candidate is
 * still parsed for burn (`parseBurn` runs even on the displaced branch — see
 * `syncSessionTick`'s own doc comment), so a persist failure on that same
 * tick clobbered the displaced-guard record `storage.put(SESSION_GUARD_KEY,
 * ...)` had JUST written moments earlier, losing the "this candidate was
 * refused" signal entirely. Worse, an operator/automated recovery reading
 * `sessionGuard` and seeing a burn-persist-failure reason where a
 * displaced-snapshot refusal belongs could call `clearSessionGuard` believing
 * it is unsticking a stuck guard, force-uploading straight past the
 * poorer-snapshot check that guard exists to protect — `clearSessionGuard`
 * only special-cases an OVERSIZE refusal (`capBytes !== undefined`), which a
 * burn-persist failure never carries either.
 *
 * do.ts's `mirrorBurnToRegistry` mirrors this onto its own
 * `StudioStatus.burnPersistError` field — never `sessionGuard` — so the two
 * failure modes stay distinguishable on the registry row exactly as they are
 * in storage. `null` once a later tick's persist succeeds again.
 */
export const BURN_PERSIST_ERROR_KEY = "burnPersistError";

/** Issue #258 round-2 review (MED): see `BURN_PERSIST_ERROR_KEY`'s own doc
 *  comment. No `key`/`tarBytes`/`capBytes` — those are `SessionGuard`-specific
 *  (a refused candidate has a destination and, for an oversize refusal, a
 *  size/cap); a burn-persist failure has neither. */
export type BurnPersistError = { at: string; reason: string };

/**
 * Dependency seam `syncSessionTick` runs over — same sbExec-shaped `exec`
 * port every other studio subsystem uses (ProvisionDeps.sbExec,
 * ShipDeps.exec), plus the three R2 verbs this feature's daily-prune needs
 * (do.ts wires all three against env.STUDIO_ARCHIVE; tests fake them).
 * `r2List` returns matching KEYS only (not full R2Object metadata) — the
 * only thing pruneDailyKeepers needs, and simplest to fake. Pagination is
 * deliberately not handled: a single studio's daily-keeper prefix holds at
 * most SESSION_DAILY_KEEPERS+1 objects (a handful), nowhere near R2 list's
 * 1000-key default page.
 */
export interface SessionSyncDeps {
  /** `env`: per-exec env vars (issue #1: the rescue remote's token). */
  exec(cmd: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }>;
  r2Put(key: string, bytes: Uint8Array): Promise<void>;
  r2List(prefix: string): Promise<string[]>;
  r2Delete(keys: string[]): Promise<void>;
  now(): Date;
  /**
   * Task 4 (P2 plane 4): telegram alert, once per 5h burn window — same
   * shape/recipient-fallback idea as do.ts's RefreshDeps.notify (its own doc
   * comment explains the OPERATOR_ID fallback; do.ts's real syncDeps() wires
   * this to the identical sendCard(env.TELEGRAM_BOT_TOKEN, OPERATOR_ID, ...)
   * call).
   */
  notify(message: string): Promise<void>;
  /**
   * `BURN_ALERT_OUTPUT_TOKENS_5H` already parsed to a number by do.ts's
   * syncDeps() — env-var string parsing stays concentrated in do.ts's deps
   * builders (studioEnvVars/refreshDeps/shipDeps/syncDeps all already follow
   * this), not scattered into this file. 0 (or any non-finite/non-positive
   * value) means alerts are off — see burn.ts's shouldAlert.
   */
  burnAlertThresholdTokens: number;
  /**
   * Issue #94: reads `latest` once to seed the guard's baseline when the DO
   * has none yet (a DO that predates the guard, or lost its storage). Absent
   * means no seeding: the first tick uploads unguarded, as before.
   */
  r2Get?(key: string): Promise<Uint8Array | null>;
  /**
   * Issue #361: where a teardown sends the studio's completion records
   * (do.ts's archiveDoneRecords). Absent means no archive: every caller that
   * never heard of it keeps today's exec sequence.
   */
  doneRecords?: DoneRecordPorts;
  /**
   * Issue #335 (public-release scrub): the rescue commit's git identity,
   * read from env by do.ts's real syncDeps() (FLEET_BOT_NAME/_EMAIL) and
   * passed straight to rescuePushCmd/rescueSnapshotCmd. Absent means those
   * functions' own neutral defaults apply — every existing caller/test that
   * never heard of this keeps today's behavior unchanged.
   */
  botName?: string;
  botEmail?: string;
  /**
   * Issue #1 piece 5: where rescue pushes go -- do.ts resolves
   * FLEET_RESCUE_REMOTE + a minted token once per rescue (rescue.ts's
   * resolveRescueTarget). Absent, or `{}`, means origin, leak-gated.
   */
  rescueTarget?(): Promise<RescueTarget>;
}

/** Issue #361: the Worker-side ports for a completion record's one copy
 *  that outlives the container. */
export interface DoneRecordPorts {
  /** owner/name of the repo this studio works -- names the ops-repo path and
   *  the repo whose issue is the board task. */
  workRepoSlug(): Promise<string>;
  /** Create or replace `path` in `repo` (the ops repo) -- replace, since a
   *  later teardown may carry a newer version of the same record (#363). */
  putOpsFile(repo: string, path: string, content: string, message: string): Promise<void>;
  /** A comment on the board task `task` in `repo` -- the record's home when
   *  FLEET_OPS_REPO is unset. */
  commentOnTask(repo: string, task: number, body: string): Promise<void>;
}

/** Keyed storage port for the one key this feature owns — same narrow-port
 *  pattern as transcript.ts's TranscriptStorage (own file, own keys, rather
 *  than widening provision.ts's StudioStorage). A real `this.ctx.storage`
 *  satisfies this structurally, with no cast, for the same reason. */
export interface SessionSyncStorage {
  get(key: typeof SESSION_DAILY_DATE_KEY): Promise<string | undefined>;
  get(key: typeof BURN_CURSOR_KEY): Promise<BurnCursor | undefined>;
  get(key: typeof BURN_KEY): Promise<Burn | undefined>;
  get(key: typeof BURN_ALERTED_WINDOW_KEY): Promise<string | undefined>;
  put(key: typeof SESSION_DAILY_DATE_KEY, value: string): Promise<void>;
  put(key: typeof BURN_CURSOR_KEY, value: BurnCursor): Promise<void>;
  put(key: typeof BURN_KEY, value: Burn): Promise<void>;
  put(key: typeof BURN_ALERTED_WINDOW_KEY, value: string): Promise<void>;
  get(key: typeof SESSION_MARK_KEY): Promise<SessionMark | undefined>;
  get(key: typeof SESSION_GUARD_KEY): Promise<SessionGuard | null | undefined>;
  put(key: typeof SESSION_MARK_KEY, value: SessionMark): Promise<void>;
  put(key: typeof SESSION_GUARD_KEY, value: SessionGuard | null): Promise<void>;
  /** Issue #258 round-2 review (MED): its OWN key — see
   *  `BURN_PERSIST_ERROR_KEY`'s own doc comment for why this is not folded
   *  into `SESSION_GUARD_KEY`. */
  get(key: typeof BURN_PERSIST_ERROR_KEY): Promise<BurnPersistError | null | undefined>;
  put(key: typeof BURN_PERSIST_ERROR_KEY, value: BurnPersistError | null): Promise<void>;
  get(key: typeof SESSION_BURN_WATERMARK_KEY): Promise<number | undefined>;
  put(key: typeof SESSION_BURN_WATERMARK_KEY, value: number): Promise<void>;
  /**
   * Board #140 (HOLD fix): the one-shot force-upload override — see
   * SESSION_FORCE_KEY's own doc comment above for the design, and
   * `syncSessionTick`'s for how a tick reads it. `get` answers `true` only
   * while armed (never `false` — the key is simply absent when disarmed, the
   * same "absence IS the off state" shape `SESSION_DAILY_DATE_KEY`/
   * `BURN_ALERTED_WINDOW_KEY` already use elsewhere in this interface).
   */
  get(key: typeof SESSION_FORCE_KEY): Promise<true | undefined>;
  put(key: typeof SESSION_FORCE_KEY, value: true): Promise<void>;
  /**
   * Consumes the override (`syncSessionTick`, after a successful forced
   * upload) — delete, not `put(key, false)`, matching the "absence is the
   * off state" shape above. No `put(key, null)`/`put(key, false)` overload
   * exists for this key on purpose, the same reason the ORIGINAL #140 design
   * gave for `SESSION_MARK_KEY`'s own now-removed delete-only override (see
   * git history): a value explicitly meaning "disarmed" would be redundant
   * with "never armed".
   *
   * Issue #228 HOLD fix round, item 4: REQUIRED, not optional. A port
   * without `delete` silently never consumes the override — every tick
   * after the first force-upload would force-upload again, forever, with
   * no comparison ever run again. All real production callers already pass
   * real DO storage (which has `delete`), so this never manifested — but
   * the TYPE must not allow it. Every `SessionSyncStorage` fake across the
   * test suite implements `delete`, including the ones that never arm the
   * override — see `test/studio.backup-guard.test.ts`'s own compile-pin
   * test ("delete is required") for the proof: it asserts, via
   * `@ts-expect-error` against the BARE port type, that a `{ get, put }`
   * object with no `delete` fails to compile as a `SessionSyncStorage`.
   */
  delete(key: typeof SESSION_FORCE_KEY): Promise<boolean>;
  /**
   * Fix round (ruled-in minor): atomic multi-key write — the SAME overload
   * shape real `DurableObjectStorage.put` already has natively
   * (`put<T>(entries: Record<string, T>): Promise<void>`), and the exact
   * pattern transcript.ts's own `TranscriptStorage` already established for
   * its manifest+boot-id pair (see that interface's own doc comment). Used
   * ONLY for the cursor+burn pair: two sequential single-key puts would let
   * a mid-tick eviction/crash advance the persisted cursor past a delta the
   * persisted totals never actually received (cursor written, burn put
   * never reached) — silently losing that delta on the next tick, since the
   * cursor already claims it was consumed. The alert marker
   * (`BURN_ALERTED_WINDOW_KEY`) deliberately stays a separate, single-key
   * put — a crash between the atomic pair and the marker write is, at worst,
   * one duplicate alert, acceptable for an advisory-only telegram ping.
   */
  put(entries: { [BURN_CURSOR_KEY]: BurnCursor; [BURN_KEY]: Burn }): Promise<void>;
}

/**
 * `bytes` — total tar bytes shipped to R2's `latest` key this tick (0 when
 * skipped). `split` — true iff the tar exceeded SESSION_SINGLE_READ_MAX and
 * was read back via `split` parts rather than one exec. `parts` — how many
 * part reads that took (1 when not split). `dailyWritten`/`pruned` — whether
 * this tick was the first of a new UTC date (daily keeper written) and how
 * many stale keepers that triggered deleting. `skipped` — deliberately
 * `string`, not a closed union: transcript.ts's own ShipResult.skipped doc
 * comment calls this out as the sibling shape it was written to match.
 */
export interface SyncResult {
  bytes: number;
  split: boolean;
  parts: number;
  dailyWritten: boolean;
  pruned: number;
  skipped?: string;
  /** Issue #94: R2 key the refused candidate went to (skipped "displaced"). */
  displaced?: string;
}

// ---------------------------------------------------------------------------
// Shell command builders — exported for direct string assertions, the same
// pattern transcript.ts's shipTickCmd/rotateCmd use.
// ---------------------------------------------------------------------------

/**
 * Tars `.claude/projects` + `.claude.json` (both relative to `/root`, i.e.
 * `$HOME` for this container's root user — same assumption do.ts's
 * credentialWriteCmd doc comment records), integrity-verifies the result,
 * then stats it — ONE exec, all four steps chained with `&&`.
 *
 * Fix round (Critical, reviewer-reproduced): the PRIOR version chained tar
 * and stat with `;` (stat always runs regardless of tar's exit code) and
 * suppressed tar's own stderr (`2>/dev/null`). That made the overall exec
 * code ALWAYS 0 (the trailing `stat ... || echo -1` never itself fails), so
 * a tar that died partway through — disk pressure, a killed process, any
 * cause that leaves a truncated-but-nonzero-size file behind — still
 * reported success and shipped the corrupt bytes to R2's `latest` key,
 * silently clobbering the last KNOWN-GOOD backup. `gzip -t` (gzip's own
 * integrity check — a tar.gz is a gzip stream, and a truncated/corrupted one
 * fails this check even when its container-visible byte size looks
 * plausible) closes that gap: the chain now only reaches `stat` when tar
 * fully succeeded (exit 0 — every named member archived) AND the archive
 * verifies intact. `2>/dev/null` is REMOVED from the tar half on purpose —
 * its stderr must flow into this exec's own `stderr` result, because
 * `syncSessionTick`'s `code !== 0` branch below throws using exactly that
 * text, and a swallowed stderr would throw a useless, contentless message.
 *
 * Consequence, accepted deliberately (controller ruling, not an oversight):
 * a container that hasn't launched claude yet (no `.claude/projects`, no
 * `.claude.json`) makes tar itself fail (a named member is missing), so
 * EVERY tick before claude's first run throws — caught, logged, retried
 * next tick, per this function's own failure-isolation contract. This
 * trades some expected early-lifecycle log noise for the much stronger
 * guarantee that `latest` is NEVER overwritten with anything that didn't
 * fully tar and pass `gzip -t`.
 *
 * Issue #202 — WHICH session files go in. The snapshot used to be the WHOLE
 * `projects` tree, and that grows without bound: measured on the live
 * fleetflare--release-studio container, `subagents/*.jsonl` were 88.0% of the
 * gz tar (4,414,729 of 5,018,969 bytes, 27 of 28 files) and every one of
 * those files was <= 2 days old — 18 MiB of subagent transcript in 48 hours.
 * An age rule prunes nothing on that corpus; the bound has to key on what
 * actually varies with load. So: every member that is NOT a
 * `subagents/*.jsonl` file is archived unconditionally (that is the whole
 * `claude --continue` restore contract — root sessions, worktree-keyed
 * sessions and their #120 adopt copies, `memory/`, `.claude.json`), and
 * subagent transcripts are admitted newest-mtime-first until
 * SESSION_SUBAGENT_RAW_BUDGET raw bytes are spent.
 *
 * REVIEW ROUND — three admission rules, not one. A pure byte budget LOSES
 * BURN COUNTS. Burn (burn.ts) diffs each tick's tar against a per-file byte
 * cursor, so a transcript that is appended to and then pushed out of the
 * budget by newer bytes in the SAME tick interval never gets its tail into
 * any tar, and nothing ever counts those tokens: by the time the file is
 * cheap enough to be admitted again it has stopped growing. That is not a
 * corner case at fan-out load — `acme-os--maestro` writes 10.1 MiB of
 * subagent transcript in five minutes and 26.3 MiB in an hour, against a
 * 300s tick and a 12 MiB budget. So a subagent member is admitted when ANY
 * of these holds:
 *
 *   1. it was modified at or after the admission CUTOFF `n` (below) — i.e.
 *      its tail may not have been counted yet, so the budget never applies
 *      to it and burn always sees that tail;
 *   2. it is the NEWEST subagent transcript — which is also what covers a
 *      single transcript larger than the whole budget (the old rule added
 *      its size first and then asked `total > budget`, so a lone 13 MiB
 *      transcript was dropped even while it was the freshest thing there);
 *   3. the running newest-first raw-byte total is still within the budget.
 *
 * REVIEW ROUND 3 — the cutoff is a WATERMARK, not the wall clock. Rule 1 used
 * to read `mtime >= now - 600` (two tick intervals), which bounds the gap
 * between two tars only if EVERY tick succeeds. This fleet has had 20-minute
 * DO outages and exec wedges at the memory ceiling, in the same moments as
 * fan-out bursts, so the ticks stall exactly when the bursts happen.
 * Reproduced on a real `acme-os--maestro` tar: subagent G2 appended (+2
 * lines, +14 output tokens), the next tick 700s later than G2's last write,
 * 14 MiB of newer subagent bytes in between — G2 excluded at ticks 4 and 5,
 * those lines never counted by anything.
 *
 * So the cutoff is now
 *
 *     n = max(W, now - SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS)
 *
 * where W is the burn watermark (SESSION_BURN_WATERMARK_KEY): the container
 * epoch at the START of the tar whose burn was last successfully PARSED,
 * passed in as awk's `k`. Anything modified at or after W demonstrably has
 * not been counted yet, however long the stall was. The 24h lookback caps how
 * far back a watermark can hold the tree, so an outage sheds genuinely old
 * files instead of blowing the budget on the recovering tick — and a streak
 * that long is already on the fleet row.
 *
 * `k = 0` means no watermark yet (a studio's very first tick, or a DO that
 * lost its storage), and only then does the cutoff fall back to the
 * wall-clock `now - SESSION_SUBAGENT_LIVE_WINDOW_SECONDS`.
 *
 * The archive is therefore bounded at "everything else" + budget + whatever
 * is unaccounted-for; see archive.ts for the burst arithmetic behind those
 * constants, and for the one thing this trades away (a dropped subagent
 * transcript cannot be continued via SendMessage after a recycle; `claude
 * --continue` is unaffected).
 *
 * Mechanics, each part deliberate:
 *   - `( cd <home> && find ... )` — a SUBSHELL. sbExec runs every studio
 *     command in ONE long-lived container shell, so a bare `cd` would leak
 *     into every later command that shell ever runs.
 *   - `-printf '%T@\t%s\t%p\n'` then `LC_ALL=C sort -rn` — newest mtime
 *     first; ties fall back to sort's whole-line comparison, so the order is
 *     total and deterministic. `LC_ALL=C` because `%T@`'s fractional second
 *     always uses a `.`, which a comma-decimal locale would stop reading at,
 *     and because it makes that tie-break byte order rather than collation
 *     order. GNU findutils/coreutils, which the Debian-family container base
 *     image ships (same assumption burn.ts's tar reader records for GNU
 *     tar's longname extension). test/bun/session-tar-budget.test.ts skips
 *     itself when those two are not the local `find`/`stat` (BSD has neither
 *     `-printf` nor `stat -c`), so a macOS checkout reports a skip rather
 *     than five failures that say nothing about this code.
 *   - `find .claude/projects <the subagents -path test> \( -type l -printf
 *     '-1\t0\t%p\n' -o <the jsonl branch> \)` — the `-path` test now sits
 *     OUTSIDE the parens and gates BOTH branches, so every symlink under a
 *     `subagents` directory is listed
 *     with the sentinel mtime `-1` and size 0. `-1` sorts last under `sort
 *     -rn` and is matched by awk's own `$1 < 0` rule, so the link is ALWAYS
 *     excluded. Reason: `-type f` alone made a symlinked transcript invisible
 *     to the selection, so it was archived as a link while the real file it
 *     points at could be excluded by this very command — a dangling link in
 *     the restored tree. A link carries no transcript bytes of its own (its
 *     target, if it is inside the tree, is archived on its own merits).
 *     Review round 3 narrowed the scope from "every symlink anywhere under
 *     `.claude/projects`" to `subagents/` only: subagent transcripts are the
 *     one class this command ever excludes, so they are the only class whose
 *     links can dangle, and the only real symlink in the fleet
 *     (`websites--web-studio`) is a subagent one. A link elsewhere under
 *     `projects` now rides into the tar as a link, as it did before #202 —
 *     its target is never excluded, so it cannot dangle. Still covers a
 *     symlinked DIRECTORY under `subagents/` (also `-type l`, and find does
 *     not descend into one without `-L`).
 *   - `awk 'BEGIN { n = ... } { t += $2 } $1 < 0 { print $3 } $1 >= 0 && NR >
 *     1 && t > b && $1 < n { print $3 }'` — running raw-byte total, printing
 *     the members that fall OUTSIDE the budget AND older than the cutoff AND
 *     are not the newest one. Admission is a prefix of the newest-first
 *     order, not a knapsack: once the budget is spent, later — older — files
 *     are excluded even if a small one would still have fit. `t > b`, never
 *     `>=`: bytes summing EXACTLY to the budget all survive (pinned by its
 *     own test). A BEGIN block plus three pattern-action blocks, so the
 *     program needs no `;` and the "no `;` anywhere in this command" rule
 *     below survives. Tab-separated, and `$3` is the path: a path containing
 *     a literal tab (claude never writes one) would be truncated and
 *     therefore simply fail to match any member — erring towards INCLUDING a
 *     transcript, never towards excluding the wrong one.
 *   - `-v n="$(date +%s)"` rather than awk's `systime()` — the container's
 *     awk is mawk, and `systime()` is a gawk extension mawk only happens to
 *     carry; `date` is coreutils and is already assumed. Command
 *     substitution, so it is this tick's wall clock, and it contains no `;`.
 *   - `BEGIN { n = k > 0 ? (k > n - d ? k : n - d) : n - w }` — `n` ARRIVES as
 *     that wall clock and BEGIN rewrites it, once, into the admission cutoff
 *     before a single record is read: `max(W, now - 24h)` when a watermark
 *     was passed (`k`), `now - 600` when there is none. Rebinding the same
 *     variable is deliberate: the clock keeps its one and only spelling
 *     (`-v n="$(date +%s)"`, the mawk-safe form) while the per-record test
 *     stays the flat `$1 < n`. Ternaries and BEGIN are both plain POSIX awk,
 *     verified against the container's mawk 1.3.4.
 *   - the pipeline's exit status is awk's, so a `find` that fails (no
 *     `.claude/projects` yet) yields an EMPTY exclude list and leaves the
 *     failure to `tar` itself, exactly as before this change.
 *   - `--anchored --no-wildcards` BEFORE `-X` — the list holds literal full
 *     member names, matched from the start of the name, so a `*` or `?` that
 *     somehow reached a transcript's filename can never glob an unrelated
 *     member out of the archive.
 *   - `stat -c %s <tar> && stat -c %Y <excludes>` — TWO lines out: the tar's
 *     size, then this tar's own start epoch. The excludes list is the last
 *     thing written before `tar` runs, so its mtime IS that start, taken from
 *     the container's clock (the same one `date +%s` above read), never the
 *     Worker's. syncSessionTick stores it as the next tick's `k`, but only
 *     once burn has actually parsed these bytes. Chained with `&&` like every
 *     other step, so a failed stat takes the whole exec down rather than
 *     printing a watermark this tar never earned.
 *
 * `home`/`syncDir`/`subagentBudget`/`liveWindowSeconds` are defaulted to the
 * real container paths and the real constants; `watermark` defaults to 0, the
 * first-tick value. Production (syncSessionTick) passes all five explicitly —
 * it has to pass the watermark, which comes last. The first four exist for
 * test/bun/session-tar-budget.test.ts, which runs this exact string in a real
 * shell against a temp HOME — the same test-only parameter shape
 * provision.ts's `adoptWorktreeSessionCmd(repo, log, killAfterSeconds)`
 * already uses.
 */
export function tarAndStatCmd(
  home = SESSION_HOME, syncDir = SESSION_SYNC_DIR, subagentBudget = SESSION_SUBAGENT_RAW_BUDGET,
  liveWindowSeconds = SESSION_SUBAGENT_LIVE_WINDOW_SECONDS,
  watermark = 0,
): string {
  const tar = `${syncDir}/latest.tar.gz`;
  const excludes = `${syncDir}/subagent-excludes.txt`;
  return (
    `mkdir -p ${syncDir} && ` +
    `( cd ${home} && find .claude/projects -path '*/subagents/*' ` +
      `\\( -type l -printf '-1\\t0\\t%p\\n' ` +
      `-o -name '*.jsonl' -type f -printf '%T@\\t%s\\t%p\\n' \\) ) ` +
    `| LC_ALL=C sort -rn ` +
    `| awk -F'\\t' -v b=${subagentBudget} -v w=${liveWindowSeconds} ` +
      `-v d=${SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS} -v k=${watermark} -v n="$(date +%s)" ` +
      `'BEGIN { n = k > 0 ? (k > n - d ? k : n - d) : n - w } ` +
      `{ t += $2 } $1 < 0 { print $3 } $1 >= 0 && NR > 1 && t > b && $1 < n { print $3 }' ` +
    `> ${excludes} && ` +
    `tar -C ${home} --anchored --no-wildcards -X ${excludes} -czf ${tar} .claude/projects .claude.json && ` +
    `gzip -t ${tar} && ` +
    `stat -c %s ${tar} && ` +
    `stat -c %Y ${excludes}`
  );
}

/** Whole-file base64 read — used when the tar is at or under
 *  SESSION_SINGLE_READ_MAX. Plain `base64 <path>` (no `-w0`): same
 *  coreutils-wrap tolerance reasoning as transcript.ts's shipTickCmd —
 *  `base64ToBytes` below strips all whitespace before decoding. */
export function singleReadCmd(): string {
  return `base64 ${SESSION_TAR_PATH}`;
}

/**
 * Splits the tar into SESSION_SPLIT_PART-sized parts, numeric 4-digit
 * suffixes (`-d -a 4`) so the part count is fully deterministic from the
 * stat size alone (`Math.ceil(size / SESSION_SINGLE_READ_MAX)` — no `ls`
 * round trip needed to discover how many parts exist). `rm -f
 * <path>.part-*` runs FIRST, unconditionally: this tick's tar may produce
 * fewer parts than a PRIOR tick's split left behind (the session shrank, or
 * simply crossed back under SESSION_SINGLE_READ_MAX), and stale extra parts
 * from an earlier tick would otherwise accumulate on the container forever
 * — each tick's split is a full, clean re-split, not an incremental one.
 */
export function splitCmd(): string {
  return (
    `rm -f ${SESSION_TAR_PATH}.part-* && ` +
    `split -b ${SESSION_SPLIT_PART} -d -a 4 ${SESSION_TAR_PATH} ${SESSION_TAR_PATH}.part-`
  );
}

/** Reads one split part back out, zero-padded to the same 4-digit width
 *  splitCmd's `-a 4` produces. */
export function partReadCmd(index: number): string {
  return `base64 ${SESSION_TAR_PATH}.part-${String(index).padStart(4, "0")}`;
}

/** The R2 prefix under which BOTH `latest.tar.gz` and every dated daily
 *  keeper for a studio live (see archive.ts's sessionLatestKey/
 *  sessionDailyKey) — exported so pruneDailyKeepers's own r2List call is
 *  directly assertable, the same reason transcript.ts exports chunkKey's
 *  callers' building blocks. Callers filtering this prefix's list result
 *  MUST exclude the `latest.tar.gz` entry — see pruneDailyKeepers below. */
export function sessionDailyPrefix(id: string): string {
  return `sessions/${id}/`;
}

// ---------------------------------------------------------------------------
// Restore decision — pure. The actual restore WRITE (chunking a fetched tar
// into container-bound parts) lives in provision.ts's runSessionRestore,
// which is the one caller of this function — kept here (not there) because
// it is this plane's own R2-latest-exists concept, and provision.ts already
// imports session-sync.ts for it.
// ---------------------------------------------------------------------------

export type RestoreAction = "restore" | "skip";

/**
 * Restores only when there IS an R2 snapshot to restore AND the container
 * has no session state of its own yet — a container that already has
 * `~/.claude/projects` must never be clobbered by an R2 snapshot (it is
 * already running with real, possibly newer, history; see restorePlan's own
 * truth table test for all four combinations).
 */
export function restorePlan(r2Head: boolean, containerHasProjects: boolean): RestoreAction {
  return r2Head && !containerHasProjects ? "restore" : "skip";
}

// ---------------------------------------------------------------------------
// base64 decode — container -> Worker. Same shape as transcript.ts's own
// private base64ToBytes (that file's header explains why this isn't shared:
// each direction/feature keeps its own tiny copy rather than an extracted
// util for two ~8-line functions).
// ---------------------------------------------------------------------------

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  if (clean.length === 0) return new Uint8Array(0);
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Issue #94: the dated keepers among a prefix listing, oldest first —
 *  `latest.tar.gz` and `displaced/` objects share the prefix and are not
 *  keepers. */
export function dailyKeeperKeys(keys: string[]): string[] {
  return keys.filter((k) => /\/\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(k)).sort();
}

/**
 * Deletes the oldest daily keepers beyond SESSION_DAILY_KEEPERS. ISO date
 * strings (`yyyy-mm-dd.tar.gz`) sort lexicographically in chronological
 * order, so a plain string sort is enough to find the oldest — no date
 * parsing needed. `sessionLatestKey`'s own object shares this prefix and
 * MUST be filtered out (it is not a dated keeper and would otherwise be
 * mistaken for the "oldest" one on a naive sort, since "latest.tar.gz" sorts
 * before any `2026-...` date string).
 *
 * Best-effort: called only from the daily-write branch of syncSessionTick,
 * so a tick that fails here (r2List/r2Delete throwing) simply leaves the
 * excess for the NEXT daily-write tick (tomorrow) to catch up on — a few
 * extra R2 objects lingering one day is cheap and self-heals; there is no
 * separate retry mechanism for pruning specifically.
 */
async function pruneDailyKeepers(deps: SessionSyncDeps, id: string): Promise<number> {
  const keys = await deps.r2List(sessionDailyPrefix(id));
  const dailyKeys = dailyKeeperKeys(keys);
  const excess = dailyKeys.length - SESSION_DAILY_KEEPERS;
  if (excess <= 0) return 0;
  const toDelete = dailyKeys.slice(0, excess);
  await deps.r2Delete(toDelete);
  return toDelete.length;
}

/**
 * One syncSession tick: tar the session dir fresh, stat it, read it back
 * (single exec under SESSION_SINGLE_READ_MAX, else split+sequential reads),
 * ship to R2's `latest` key every tick, and to a dated daily-keeper key once
 * per UTC date (tracked via the SESSION_DAILY_DATE_KEY storage marker),
 * pruning old keepers to SESSION_DAILY_KEEPERS on that same tick.
 *
 * Oversize (> SESSION_TOTAL_MAX): logged and skipped BEFORE any read exec —
 * a session dir that size signals a different problem, per the design's own
 * ruling, not something to fight through a dozen split-part reads for.
 *
 * Failure isolation: `latest`'s r2Put must succeed before the daily branch
 * is even considered, and the daily marker (SESSION_DAILY_DATE_KEY) is
 * written to storage ONLY after the daily r2Put itself resolves — same
 * "storage write only after the corresponding R2 write is durable" rule
 * transcript.ts's shipTranscriptTick documents for its own manifest. This
 * function never catches anything itself; do.ts's syncSession()/
 * restartWithSync() callbacks are where a throw here is caught, logged, and
 * the caller moves on — session sync is best-effort, never studio health.
 *
 * Fix round (Important, I1): after the single/split read completes, the
 * DECODED byte count is re-verified against `size` (the value `stat`
 * reported, before any base64 round trip) — a mismatch throws, and NOTHING
 * ships. This catches a truncated exec/base64 round trip that the
 * gzip-integrity check above (which only proves the CONTAINER-side file is
 * intact) cannot: tarAndStatCmd's `gzip -t` says nothing about whether the
 * read-back-out bytes this function itself assembled are complete.
 *
 * Board #140 (HOLD fix): when SESSION_FORCE_KEY is armed (do.ts's
 * `clearSessionGuard`), this ONE tick skips the mark/`poorerThan` comparison
 * entirely — no `seedMark` read, no `poorerThan` call — and ships the
 * candidate to `latest` unconditionally, UNLESS the candidate itself is
 * blank (no session files) or unreadable, in which case it is displaced
 * exactly as an unforced tick would be and the override is left armed for a
 * later, non-blank candidate to consume. This is the actual fix for the
 * bug the original #140 design missed: deleting the mark alone let the very
 * next tick re-derive an identical mark from R2's own CURRENT `latest` (via
 * `seedMark`) and displace the same candidate for the same reason — a
 * complete no-op in the "frozen, stuck displacing everything" case the
 * escape hatch exists for. Before the forced `latest` r2Put, the OLD
 * `latest` (read via `deps.r2Get`) is copied to `sessionSupersededKey` — a
 * safety net so the bypassed comparison never silently destroys session
 * history a human might still want; see that key's own doc comment
 * (archive.ts) for why neither prune function can ever touch it. No
 * `deps.r2Get` wired (some deployments/tests) means no way to take that
 * safety-net copy, so the tick refuses to force at all (logged) rather than
 * uploading unconditionally with no net under it — the override stays armed
 * either way in that case, since nothing about this tick's inability to
 * force is itself durable. On a successful forced upload, SESSION_MARK_KEY
 * is set to the candidate's OWN newest mark (not re-derived from `latest`)
 * and the override is deleted (one-shot, consumed).
 */
export async function syncSessionTick(
  deps: SessionSyncDeps, storage: SessionSyncStorage, id: string,
): Promise<SyncResult> {
  const now = deps.now();

  // Issue #202 review round 3: the watermark THIS tick selects against. 0 (no
  // stored value) means the awk program falls back to its wall-clock
  // first-tick rule — see tarAndStatCmd.
  const priorWatermark = (await storage.get(SESSION_BURN_WATERMARK_KEY)) ?? 0;
  const statRes = await deps.exec(tarAndStatCmd(
    SESSION_HOME, SESSION_SYNC_DIR, SESSION_SUBAGENT_RAW_BUDGET,
    SESSION_SUBAGENT_LIVE_WINDOW_SECONDS, priorWatermark,
  ));
  if (statRes.code !== 0) {
    throw new Error(`session tar/stat failed (${statRes.code}): ${statRes.stderr.slice(0, 500)}`);
  }
  // Two lines: the tar's size, then the epoch this tar started at.
  const statLines = statRes.stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const size = Number.parseInt(statLines[0] ?? "", 10);
  if (!Number.isFinite(size) || size < 0) {
    // Defensive belt only — tarAndStatCmd's `&&` chain plus `gzip -t` mean
    // `code === 0` should already guarantee a valid, non-negative size; a
    // throw (not a soft skip) is still the right reaction to an unparseable
    // result, matching this function's "never silently treat a surprise as
    // success" posture rather than reintroducing the old no-op skip path.
    throw new Error(`session tar/stat produced an unparseable size: ${JSON.stringify(statRes.stdout)}`);
  }
  const tarStartedAt = Number.parseInt(statLines[1] ?? "", 10);
  if (!Number.isFinite(tarStartedAt) || tarStartedAt <= 0) {
    // Same posture as the size check above, and for a sharper reason: a tick
    // that shipped without a watermark would leave the PRIOR one in place
    // forever, and the admission cutoff would silently drift back towards the
    // wall-clock rule this whole change exists to replace. Better a loud,
    // retried failure than a snapshot selected against a stale cutoff.
    throw new Error(`session tar/stat produced an unparseable tar-start watermark: ${JSON.stringify(statRes.stdout)}`);
  }
  if (size > SESSION_TOTAL_MAX) {
    // Issue #176: LOUD, on the row as well as the log. `latest` stops moving
    // from here on, and a snapshot this size is exactly one the DO could not
    // restore later — refusing it now is the whole point, never a quiet skip.
    const reason = `oversize: session tar ${size} bytes exceeds SESSION_TOTAL_MAX ${SESSION_TOTAL_MAX}; not synced, latest is stale`;
    console.error(`syncSession ${id}: REFUSED ${reason}`);
    // #192's clear-session-guard override is not consumed here: it stays
    // armed and fires on the first tick under the cap — possibly days later,
    // so it is said, every refused tick.
    if ((await storage.get(SESSION_FORCE_KEY)) === true) {
      console.error(`syncSession ${id}: clear-session-guard override still armed; it forces the first sync under the cap`);
    }
    const prior = await storage.get(SESSION_GUARD_KEY);
    const since = prior?.capBytes !== undefined ? prior.at : now.toISOString();
    await storage.put(SESSION_GUARD_KEY, { at: since, key: "", reason, tarBytes: size, capBytes: SESSION_TOTAL_MAX });
    return { bytes: 0, split: false, parts: 0, dailyWritten: false, pruned: 0, skipped: "oversize" };
  }

  let bytes: Uint8Array;
  let split = false;
  let parts = 1;
  if (size <= SESSION_SINGLE_READ_MAX) {
    const readRes = await deps.exec(singleReadCmd());
    if (readRes.code !== 0) {
      throw new Error(`session read failed (${readRes.code}): ${readRes.stderr.slice(0, 500)}`);
    }
    bytes = base64ToBytes(readRes.stdout);
  } else {
    split = true;
    const splitRes = await deps.exec(splitCmd());
    if (splitRes.code !== 0) {
      throw new Error(`session split failed (${splitRes.code}): ${splitRes.stderr.slice(0, 500)}`);
    }
    parts = Math.ceil(size / SESSION_SINGLE_READ_MAX);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < parts; i++) {
      const partRes = await deps.exec(partReadCmd(i));
      if (partRes.code !== 0) {
        throw new Error(`session part ${i} read failed (${partRes.code}): ${partRes.stderr.slice(0, 500)}`);
      }
      chunks.push(base64ToBytes(partRes.stdout));
    }
    bytes = concatBytes(chunks);
  }

  if (bytes.length !== size) {
    throw new Error(`session read length mismatch: stat reported ${size} bytes, decoded ${bytes.length} (no ship)`);
  }

  // Issue #94 / board #140 (HOLD fix): the guard. A candidate poorer than
  // the snapshot `latest` holds (missing its newest session file, or fewer
  // lines in it) is written aside, never over `latest`, and never as a
  // daily keeper — UNLESS SESSION_FORCE_KEY is armed, in which case this one
  // tick skips the comparison altogether (see this function's own doc
  // comment above for the full design and why deleting the mark alone,
  // the original #140 fix, was a no-op).
  const candidate = await statsOrNull(bytes);
  const forceArmed = (await storage.get(SESSION_FORCE_KEY)) === true;
  let forcing = false;
  let reason: string | null;
  if (forceArmed && deps.r2Get) {
    // Still refuse a blank or unreadable candidate — forcing a KNOWN-empty
    // or unparseable snapshot over `latest` would trade a stuck guard for a
    // silently destroyed one. The override stays armed either way (neither
    // branch below ever deletes SESSION_FORCE_KEY): the operator's escape
    // hatch survives to the next candidate that is actually forceable.
    if (!candidate) reason = "candidate unreadable";
    else if (Object.keys(candidate).length === 0) reason = "no session files (forced upload pending)";
    else { reason = null; forcing = true; }
  } else {
    if (forceArmed && !deps.r2Get) {
      // Can't take the sessionSupersededKey safety-net copy without a way to
      // read the OLD `latest` first — refuse to force rather than upload
      // with no net under it. Falls through to the ordinary (unforced)
      // comparison below, same as if the override were never armed.
      console.error(`syncSession ${id}: cannot force upload, no r2Get available`);
    }
    const mark = (await storage.get(SESSION_MARK_KEY)) ?? (await seedMark(deps, storage, id));
    reason = mark ? (candidate ? poorerThan(candidate, mark, now) : "candidate unreadable") : null;
  }
  if (reason) {
    const key = sessionDisplacedKey(id, now.toISOString());
    await deps.r2Put(key, bytes);
    console.error(`syncSession ${id}: KEPT latest, candidate displaced to ${key}: ${reason}`);
    await storage.put(SESSION_GUARD_KEY, { at: now.toISOString(), key, reason });
    await pruneDisplaced(deps, id);
    // A displaced candidate is still a real snapshot of the same session
    // files, so burn parses it and — if that succeeds — the watermark moves.
    await advanceWatermark(storage, await parseBurn(deps, storage, id, bytes, now), tarStartedAt);
    return { bytes: 0, split, parts: split ? parts : 1, dailyWritten: false, pruned: 0, skipped: "displaced", displaced: key };
  }

  if (forcing) {
    // Safety net: the `latest` this forced upload is about to overwrite,
    // preserved verbatim under its own prefix before it's gone — see
    // sessionSupersededKey's own doc comment (archive.ts) for why neither
    // prune function can ever reap it.
    const oldLatest = await deps.r2Get!(sessionLatestKey(id));
    if (oldLatest) await deps.r2Put(sessionSupersededKey(id, now.toISOString()), oldLatest);
  }
  await deps.r2Put(sessionLatestKey(id), bytes);
  const nextMark = candidate ? newestMark(candidate) : null;
  if (nextMark) await storage.put(SESSION_MARK_KEY, nextMark);
  // Consumes the override. `delete` is required on SessionSyncStorage — see its doc comment.
  if (forcing) await storage.delete(SESSION_FORCE_KEY);
  if (await storage.get(SESSION_GUARD_KEY)) await storage.put(SESSION_GUARD_KEY, null);

  await advanceWatermark(storage, await parseBurn(deps, storage, id, bytes, now), tarStartedAt);

  const today = now.toISOString().slice(0, 10);
  const priorDate = await storage.get(SESSION_DAILY_DATE_KEY);
  let dailyWritten = false;
  let pruned = 0;
  if (priorDate !== today) {
    await deps.r2Put(sessionDailyKey(id, today), bytes);
    await storage.put(SESSION_DAILY_DATE_KEY, today);
    dailyWritten = true;
    pruned = await pruneDailyKeepers(deps, id);
  }

  return { bytes: bytes.length, split, parts: split ? parts : 1, dailyWritten, pruned };
}

/** Issue #94: stats of a candidate, or null when it cannot be read as a
 *  gzip'd tar (never expected after `gzip -t`; treated as poorer when a
 *  baseline exists). */
async function statsOrNull(bytes: Uint8Array): Promise<SessionStats | null> {
  try {
    return await sessionStats(bytes);
  } catch {
    return null;
  }
}

/** Issue #94: first guarded tick of a DO with no baseline — take it from the
 *  snapshot `latest` already holds, and persist it so later ticks never
 *  re-read R2. An R2 GET that throws propagates: the tick fails and retries,
 *  rather than uploading unguarded over a `latest` it could not see. A
 *  missing or unreadable `latest` means no baseline: the tick uploads. */
async function seedMark(deps: SessionSyncDeps, storage: SessionSyncStorage, id: string): Promise<SessionMark | null> {
  if (!deps.r2Get) return null;
  const latest = await deps.r2Get(sessionLatestKey(id));
  const stats = latest ? await statsOrNull(latest) : null;
  const mark = stats ? newestMark(stats) : null;
  if (mark) await storage.put(SESSION_MARK_KEY, mark);
  return mark;
}

/** Issue #94: keep only the newest SESSION_DISPLACED_KEEPERS displaced
 *  snapshots (ISO keys sort in time order). Best-effort, like
 *  pruneDailyKeepers. */
async function pruneDisplaced(deps: SessionSyncDeps, id: string): Promise<void> {
  try {
    const keys = (await deps.r2List(`${sessionDailyPrefix(id)}displaced/`)).sort();
    const excess = keys.length - SESSION_DISPLACED_KEEPERS;
    if (excess > 0) await deps.r2Delete(keys.slice(0, excess));
  } catch (err) {
    console.error(`syncSession ${id}: displaced prune failed`, err);
  }
}

/**
 * Issue #202 review round 3: moves the burn watermark to the epoch THIS tick's
 * tar started at — and only when `parsed` says burn actually consumed this
 * tick's bytes. A failed parse (or a tick that never got here at all: thrown,
 * or skipped oversize) leaves the prior value, so the next tick's cutoff still
 * covers everything this one may have missed.
 *
 * Called AFTER parseBurn's own atomic cursor+burn put, never before. A crash
 * in between leaves an older watermark, which only over-admits next tick — the
 * per-file cursor dedupes, so no line is counted twice. The reverse order
 * would advance the cutoff past a tail the totals never received, which is
 * exactly the permanent loss this whole change exists to prevent.
 *
 * Its own try/catch, for the same reason parseBurn has one: the sync this tick
 * came for has already succeeded, and the burn monitor is advisory (R-P2-4).
 */
async function advanceWatermark(
  storage: SessionSyncStorage, parsed: boolean, tarStartedAt: number,
): Promise<void> {
  if (!parsed) return;
  try {
    await storage.put(SESSION_BURN_WATERMARK_KEY, tarStartedAt);
  } catch (err) {
    console.error("syncSession: burn watermark write failed, sync itself still succeeded", err);
  }
}

/** Returns true iff burn parsing consumed `bytes` without throwing — the one
 *  condition under which the caller may advance the burn watermark. */
async function parseBurn(
  deps: SessionSyncDeps, storage: SessionSyncStorage, id: string, bytes: Uint8Array, now: Date,
): Promise<boolean> {
  // Task 4 (P2 plane 4): "post-success" — `bytes` is the SAME tar this tick
  // just confirmed durable in R2, parsed in-memory with no extra sbExec.
  // Own try/catch, deliberately never allowed to propagate: the sync this
  // tick came here to do has ALREADY succeeded by this point, and the burn
  // monitor is advisory-only (design ruling R-P2-4: "monitor is advisory,
  // never a gate"). parseUsageIncrement/rollWindow/shouldAlert are
  // themselves tolerant of malformed jsonl (skip+count, never throw) — a
  // throw reaching this catch signals a genuine bug (e.g. gunzip choking on
  // a corrupt stream), not ordinary bad session data, and must still never
  // turn an already-successful sync tick into a failed one.
  try {
    const prevCursor: BurnCursor = (await storage.get(BURN_CURSOR_KEY)) ?? { fileOffsets: {} };
    const prevBurn: Burn = (await storage.get(BURN_KEY)) ?? freshBurn(now);
    // Issue #176: streamed — never the raw tar or a member's whole text.
    const { cursor, delta, parseSkips, presentPaths } = await burnIncrement(prevCursor, bytes);
    if (parseSkips > 0) {
      console.warn(`syncSession ${id}: burn parser skipped ${parseSkips} malformed/unrecognized jsonl line(s)`);
    }
    const nextBurn = rollWindow(prevBurn, delta, now);
    // Issue #258: a burnCursor entry is never dropped once written otherwise
    // (see pruneCursor's own doc comment — measured 1.77 MB at 5,000 paths,
    // the 2 MB DO cap reached near ~5,900). `presentPaths` is THIS tick's own
    // tar member set, so a path merely squeezed out by session-sync's own
    // budget/watermark admission rule (never pruned inside CURSOR_PRUNE_MS)
    // is told apart from one genuinely gone for two idle days.
    const prunedCursor = pruneCursor(cursor, presentPaths, now);
    // Issue #258 round-3 (maestro brief item 2): a belt on top of the
    // age-based prune just above — a fleet spawning paths faster than
    // CURSOR_PRUNE_MS's 48h window sheds them can still cross the DO value
    // cap, and the `storage.put` below failing outright is worse than
    // anything pruning could ever cost (BURN_PERSIST_ERROR_KEY, this
    // function's own next try/catch — burn counting freezes fleet-wide until
    // an operator notices). No-op below CURSOR_PERSIST_SOFT_CAP_BYTES; see
    // pruneCursorForSize's own doc comment (burn.ts) for the least-recently-
    // seen eviction order. Logged ONCE per prune event (counts + resulting
    // size), never once per removed entry.
    const sized = pruneCursorForSize(prunedCursor, undefined, undefined, presentPaths);
    if (sized.removed > 0 || sized.compacted > 0) {
      console.warn(
        `syncSession ${id}: burn cursor emergency-pruned ${sized.removed} least-recently-seen entries ` +
        `(and compacted ${sized.compacted} live ones to their offset) to stay under the DO storage cap (now ~${sized.bytes} bytes)`,
      );
    }
    // Fix round (ruled-in minor): one atomic multi-key put, not two
    // sequential single-key ones — see SessionSyncStorage's own doc comment
    // on this overload for why (a mid-tick eviction between two separate
    // puts could advance the cursor past a delta the totals never received).
    //
    // Issue #258 (fix 3): this specific put failing (a genuine DO storage
    // error, e.g. "value too large") is worse than everything else this
    // function's own try/catch already covers — a parse failure means burn
    // never computed anything for this tick, but a PUT failure here means it
    // computed a correct delta and then LOST it, silently: the outer catch's
    // generic "burn parsing failed" log line would say nothing about that
    // distinction, and nothing about it ever reached the registry row. Own
    // try/catch, own distinct/greppable message, and (round-2 review, MED)
    // its OWN key, BURN_PERSIST_ERROR_KEY — never SESSION_GUARD_KEY, which
    // already means something else (a displaced/refused candidate, written
    // moments ago by this SAME tick when this parse runs on the displaced
    // branch — see BURN_PERSIST_ERROR_KEY's own doc comment for the
    // clobbering this used to cause). Returns false exactly like the outer
    // catch: the watermark must not advance over a tick whose burn state
    // never actually became durable.
    try {
      await storage.put({ [BURN_CURSOR_KEY]: sized.cursor, [BURN_KEY]: nextBurn });
    } catch (err) {
      console.error(
        `syncSession ${id}: burn cursor/burn PERSIST FAILED (storage.put rejected) — this tick's burn state is lost`,
        err,
      );
      await storage.put(BURN_PERSIST_ERROR_KEY, {
        at: now.toISOString(),
        reason: `burn cursor/burn persist failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
    // The persist just succeeded: clear a stale failure record from an
    // earlier tick, the same "clear once it stops failing" idiom
    // SESSION_GUARD_KEY's own clear (this file's syncSessionTick, on a
    // non-displaced ship) already follows.
    if (await storage.get(BURN_PERSIST_ERROR_KEY)) await storage.put(BURN_PERSIST_ERROR_KEY, null);

    const alertedWindow = (await storage.get(BURN_ALERTED_WINDOW_KEY)) ?? null;
    if (shouldAlert(nextBurn, deps.burnAlertThresholdTokens, alertedWindow)) {
      try {
        await deps.notify(
          `studio ${id}: 5h output tokens ${nextBurn.window5hOutput} crossed alert threshold ${deps.burnAlertThresholdTokens}`,
        );
      } catch (err) {
        // Same rule as do.ts's runRefreshToken's own telegram catch: a
        // failed alert must not unwind an already-computed burn state.
        console.error(`syncSession ${id}: burn alert telegram send failed`, err);
      }
      // Written regardless of whether notify itself succeeded — same
      // "the marker tracks the streak, not delivery success" rule
      // runRefreshToken's lastRefreshError follows, so a persistently
      // unreachable telegram cannot turn into a repeat-alert-every-tick spam
      // loop once it recovers.
      await storage.put(BURN_ALERTED_WINDOW_KEY, nextBurn.window5hStart);
    }
    return true;
  } catch (err) {
    console.error(`syncSession ${id}: burn parsing failed, session sync itself still succeeded`, err);
    return false;
  }
}
