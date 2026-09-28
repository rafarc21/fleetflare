// Pure R2 key / manifest / rotation logic for studio transcript + session
// archival (P2 plane 1 "transcript durability" + plane 2 "session-state
// sync" — docs/superpowers/specs/2026-08-16-studio-memory-p2-design.md).
// No I/O here: the shipping/sync loops that actually call `sbExec` and the
// R2 binding are later tasks (transcript.ts, session-sync.ts). This file is
// only the deterministic math + string formats every plane 1/2 R2 key must
// agree on, so those loops (and their tests) share one source of truth.

/**
 * Chunk sequence numbers are zero-padded to this width so R2's lexicographic
 * list order matches numeric order (`000009` < `000010`) — R2 has no native
 * numeric sort, only key-prefix/lexicographic listing.
 */
export const CHUNK_SEQ_WIDTH = 6;

/**
 * Rotation threshold, bytes (64 MiB). Once the container's transcript log
 * file reaches this size, `shipTranscript` (a later task) truncates it after
 * a confirmed ship and resets `TranscriptManifest.offset`.
 */
export const ROTATION_THRESHOLD_BYTES = 64 * 1024 * 1024;

/**
 * Per-tick cap on transcript bytes pulled from the container, bytes (1 MiB)
 * — `shipTranscript` (a later task) reads `tail -c +<offset> | head -c
 * <this>`. Plane 1.
 */
export const TRANSCRIPT_PULL_MAX = 1_048_576;

/**
 * Size of the hot-tail preview kept in DO storage (key `transcriptTail`) for
 * the grid card, bytes (8 KiB) — refreshed by `shipTranscript` (a later
 * task) after each ship. Plane 1.
 */
export const HOT_TAIL_BYTES = 8_192;

/**
 * Session tar size, bytes (4 MiB), at or under which `syncSession` (a later
 * task) reads it in a single `sbExec` base64 pull; above this it splits into
 * `SESSION_SPLIT_PART`-sized parts instead. Plane 2.
 */
export const SESSION_SINGLE_READ_MAX = 4_194_304;

/**
 * `split -b` part size for a session tar over `SESSION_SINGLE_READ_MAX` — a
 * shell-arg string (`split`'s `-b` takes a size suffix), not a byte count.
 * Plane 2, `syncSession` (a later task).
 */
export const SESSION_SPLIT_PART = "4m";

/**
 * Hard cap on the session tar (gzip) size, bytes (32 MiB). Over it,
 * `syncSessionTick` refuses the tick LOUDLY (error log + the row's
 * sessionGuard) instead of reading it. Plane 2.
 *
 * Issue #176, MEASURED. With the gunzip read BYOB into one reused view
 * (burn.ts's inflateSliced/walkGzipTar), the streamed sync tick's V8 live
 * set is ~2.25 x gz, first tick's baseline read included: 56.8 MiB at
 * 24.9 MiB gz, 76.5 at 33.9, 95.8 at 43.0. The Worker bundle's own heap
 * after load is 5.8 MiB. At this cap: ~72 + 6 = ~78 MiB, leaving ~50 MiB
 * under the 128 MB isolate cap for workerd's inflate buffer (bounded by the
 * reader keeping pace) and the DO's own state.
 *
 * Why not lower: the largest R2 object measured is a 12.58 MiB daily keeper
 * (fleetflare--web-studio, 2026-09-24), growing 5.32 -> 6.15 -> 8.74 ->
 * 12.58 MiB over four days; a 16 MiB cap would stop that studio's backups
 * within about a day. Unbounded growth itself is #202. It was 64 MiB, which
 * nothing here was measured to survive.
 */
export const SESSION_TOTAL_MAX = 33_554_432;

/**
 * Issue #202: per-tick RAW-byte budget for `subagents/*.jsonl` members of the
 * session tar (12 MiB). `syncSession`'s `tarAndStatCmd` admits subagent
 * transcripts newest-mtime-first and excludes the rest, so the snapshot is
 * bounded at (everything that is NOT a subagent transcript) + this budget,
 * no matter how many subagents a studio runs. Nothing is ever deleted or
 * moved on the container — this only chooses what goes INTO the tar.
 *
 * Why a byte budget and not an age rule. Measured read-only inside the live
 * fleetflare--release-studio container, 2026-09-24 (one project key, one root
 * session, 28 jsonl files):
 *
 *   class                     files   raw bytes    gz bytes   share of gz
 *   whole `projects` (today)     28  21,877,297   5,018,969        100%
 *   root session jsonl            1   2,593,739     603,934       12.0%
 *   subagents/*.jsonl            27  18,853,358   4,414,729       88.0%
 *
 * Compression is ~4.28x for BOTH classes (4.29x root, 4.27x subagents), so
 * compression cannot separate them — only exclusion changes the number. And
 * EVERY one of the 28 files is <= 2 days old (`1-7d` and `7-30d` buckets are
 * empty): 18 MiB of subagent transcript accrued in 48 hours. An age rule with
 * N=7 would exclude nothing at all here, leaving the busiest studio's tar
 * exactly the size that trips the cap. Age is not the bound; subagent count
 * and size is.
 *
 * Why 12 MiB — CORRECTED, review round. The first version of this comment
 * sized the budget off a daily average ("measured peak 8.7 MiB per day", "12
 * MiB is ~1.4 peak-days") and concluded that a transcript can only fall out
 * of the budget long after the subagent writing it has finished. That
 * reasoning is simply WRONG for a fan-out studio, where the bytes do not
 * arrive smoothly across a day — they arrive in bursts. Measured on
 * `acme-os--maestro`:
 *
 *   window     subagent transcript bytes written
 *   5 minutes  10.1 MiB
 *   1 hour     26.3 MiB
 *
 * One syncSession tick is 300s. So a single tick interval can easily carry
 * MORE newer subagent bytes than this whole budget, which means a transcript
 * that is still being appended to can be pushed out of the budget — and its
 * tail then never reaches any snapshot at all, so burn silently loses those
 * tokens. That is what SESSION_SUBAGENT_LIVE_WINDOW_SECONDS below exists to
 * prevent; the budget alone can NOT be trusted to keep a live file.
 *
 * With the live-window rule in place the budget no longer has to protect
 * correctness — it only decides how much FINISHED subagent history a snapshot
 * carries, and 12 MiB (~2.9 MiB gz at the measured 4.28x) is a comfortable
 * amount of that. The worst-case snapshot is therefore
 * (everything that is not a subagent transcript) + this budget + whatever is
 * live: 10.1 MiB per 5 min x 2 ticks x 1.2 margin = 24.2 MiB live + 12 MiB
 * budget = ~36 MiB raw, ~8.5 MiB gz. SESSION_TOTAL_MAX bounds the GZIP tar,
 * so ~8.5 MiB gz is the figure that must clear it — far under the 33_554_432
 * (32 MiB) that #176 landed via #191. The ~36 MiB raw is NOT what that cap
 * measures; do not compare it. (#191's title still reads "cap 16 MiB" — that
 * was its first round, which review superseded with the 32 MiB above.)
 *
 * The trade-off this budget buys, stated plainly: a subagent transcript that
 * is left out of the snapshot CANNOT BE CONTINUED (SendMessage to that
 * subagent) after a recycle — the transcript it would resume from is not in
 * the restored tree. `claude --continue` is unaffected: it resumes a ROOT or
 * worktree-keyed session, never a subagent one, and those are archived
 * unconditionally. Claude Code 2.1.281 lists `agent-*.jsonl` via readdir and
 * skips the ones that are missing, so a partial `subagents/` directory is a
 * normal, non-fatal state for it.
 */
export const SESSION_SUBAGENT_RAW_BUDGET = 12_582_912;

/**
 * Issue #202: how recently a `subagents/*.jsonl` file must have been modified
 * to be admitted to the session tar UNCONDITIONALLY, budget or no budget
 * (600s = two 300s syncSession ticks) — the FIRST-TICK rule only. See
 * SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS below for what every later tick
 * uses instead, and why this one cannot be trusted on its own.
 *
 * Why it exists. Burn counts tokens by diffing each tick's tar against a
 * per-file byte cursor (burn.ts). A file that is appended to and THEN pushed
 * out of the budget by newer bytes in the same tick interval never gets its
 * tail into any tar, so the cursor never advances over it and those tokens
 * are lost permanently — no later tick recovers them, because the file has
 * stopped growing by the time it is cheap enough to admit again. Reproduced
 * on a real `acme-os--maestro` tar: one line appended to a kept subagent,
 * 13 MiB of newer subagent files landing before the next tick, the file
 * dropped at ticks 4 and 5, the line never counted.
 *
 * Why 600s and not 300s. The rule has to hold across the gap between the tar
 * that LAST saw a file and the next one. Ticks are not perfectly periodic
 * (do.ts also tars before every restart bring-up and before every recycle
 * destroy), so a one-tick window could let a file age out between two
 * consecutive tars. Two tick intervals is the widest gap a HEALTHY tick loop
 * produces — which is exactly the limit of what this constant can promise.
 *
 * CORRECTED, review round 3. An earlier version of this comment claimed "two
 * tick intervals is the smallest window that cannot" let a file age out
 * between two consecutive tars. That is only true if EVERY tick succeeds.
 * This fleet has had 20-minute DO outages and exec wedges at the memory
 * ceiling, and they happen in the same moments as fan-out bursts — so the
 * assumption fails exactly when it matters. A stalled tick leaves a gap far
 * wider than 600s, the appended file falls outside this window, newer bytes
 * push it outside the budget, and burn loses the tail after all. Only a
 * watermark tied to the last tar whose burn was actually PARSED closes that;
 * this constant survives as the bootstrap value a studio with no watermark
 * yet uses on its very first tick.
 *
 * Cost. During a burst every live transcript is admitted, so the snapshot can
 * exceed (everything else + budget) for as long as the burst lasts — bounded
 * by the burst rate itself, which is what SESSION_SUBAGENT_RAW_BUDGET's
 * worst-case arithmetic above accounts for.
 */
export const SESSION_SUBAGENT_LIVE_WINDOW_SECONDS = 600;

/**
 * Issue #202, review round 3: how far back the burn WATERMARK may hold a
 * subagent transcript in the session tar (24h).
 *
 * The watermark W is the container epoch at the start of the tar whose burn
 * was last successfully PARSED (see session-sync.ts's
 * SESSION_BURN_WATERMARK_KEY). A subagent transcript modified at or after W
 * cannot have had its tail counted yet, whatever the wall clock says, so
 * `tarAndStatCmd` admits it unconditionally — which is what survives a
 * stalled tick, where SESSION_SUBAGENT_LIVE_WINDOW_SECONDS above does not.
 *
 * The cutoff the command actually applies is `max(W, now - this)`. The cap
 * matters because W only advances on a tick that parsed: a studio whose DO
 * was wedged for a day would come back with a day-old W and admit a whole
 * day of subagent transcript on the recovering tick, blowing past the budget
 * and possibly past SESSION_TOTAL_MAX. 24h is generous enough that no real
 * outage-plus-burst combination loses a count that was still recoverable
 * (a transcript untouched for a day has long stopped growing), and a streak
 * that long is already visible on the fleet row, so shedding the old files
 * there is a known, reported loss rather than a silent one.
 */
export const SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS = 86_400;

/**
 * Number of daily session snapshot keepers (`sessionDailyKey` objects)
 * `syncSession` (a later task) retains before pruning the oldest. Plane 2.
 */
export const SESSION_DAILY_KEEPERS = 7;

/**
 * Issue #94: displaced session snapshots (`sessionDisplacedKey` objects) kept
 * per studio. A blank container displaces one every sync tick, so the prefix
 * is pruned to the newest few on every displaced write.
 */
export const SESSION_DISPLACED_KEEPERS = 3;

/**
 * Rolling burn-alert window, ms (5h) — `burn.ts`'s (a later task)
 * `window5hStart`/`window5hOutput` roll on this period. Plane 4.
 */
export const BURN_WINDOW_MS = 18_000_000;

/**
 * R2 key for one transcript chunk. `dateIso` is the UTC calendar date
 * (`yyyy-mm-dd`) the chunk was shipped on; `seq` is that date's chunk
 * counter (see `TranscriptManifest`/`advance`), zero-padded to
 * `CHUNK_SEQ_WIDTH` digits.
 *
 * `id` is assumed already validated (`parseStudioId` upstream, see
 * `src/studio/ids.ts`) and must not contain `/` — this function does no
 * escaping or validation of its own, so a `/` in `id` would split the R2 key
 * into extra path segments.
 */
export function chunkKey(id: string, dateIso: string, seq: number): string {
  return `transcripts/${id}/${dateIso}/${String(seq).padStart(CHUNK_SEQ_WIDTH, "0")}.log`;
}

/**
 * R2 key for a studio's latest session snapshot. Plane 2's `syncSession`
 * (a later task) overwrites this same object every tick; provision's
 * fresh-container restore step reads it.
 *
 * `id` is assumed already validated (`parseStudioId` upstream); must not
 * contain `/` — same assumption as `chunkKey`, same reason.
 */
export function sessionLatestKey(id: string): string {
  return `sessions/${id}/latest.tar.gz`;
}

/**
 * R2 key for a studio's daily session snapshot keeper — one per UTC date,
 * written once per date and pruned to the newest `SESSION_DAILY_KEEPERS` by
 * `syncSession` (a later task).
 *
 * `id` is assumed already validated (`parseStudioId` upstream); must not
 * contain `/` — same assumption as `chunkKey`, same reason.
 */
export function sessionDailyKey(id: string, dateIso: string): string {
  return `sessions/${id}/${dateIso}.tar.gz`;
}

/**
 * Issue #94: R2 key for a candidate snapshot the sync guard refused to write
 * over `latest` (it lacked the newest session file, or had fewer lines in
 * it). `atIso` is the full ISO instant of the refused tick. Lives under its
 * own `displaced/` segment so a dated-keeper listing never mistakes it for a
 * keeper.
 */
export function sessionDisplacedKey(id: string, atIso: string): string {
  return `sessions/${id}/displaced/${atIso}.tar.gz`;
}

/**
 * Board #140 (HOLD fix): R2 key for the `latest` snapshot a one-shot forced
 * upload (do.ts's `clearSessionGuard` arming SESSION_FORCE_KEY,
 * session-sync.ts's `syncSessionTick`) overwrote WITHOUT the usual
 * `poorerThan` comparison — the safety net for that bypass. `atIso` is the
 * full ISO instant of the tick that forced the upload, same shape as
 * `sessionDisplacedKey`'s own `atIso`.
 *
 * Lives under its own `superseded/` segment, deliberately outside both
 * `dailyKeeperKeys`'s dated-keeper pattern (`\/\d{4}-\d{2}-\d{2}\.tar\.gz$`
 * never matches an ISO-instant filename — it has a `T...Z` tail after the
 * date) and `pruneDisplaced`'s own `displaced/`-prefixed r2List (a distinct
 * path segment, never returned by a `displaced/`-prefixed listing) — neither
 * `pruneDailyKeepers` nor `pruneDisplaced` (session-sync.ts) can ever delete
 * an object under this prefix, by construction, not by a runtime check. A
 * human operator is the only intended reader/deleter of a `superseded/`
 * object.
 */
export function sessionSupersededKey(id: string, atIso: string): string {
  return `sessions/${id}/superseded/${atIso}.tar.gz`;
}

/**
 * Per-studio transcript shipping cursor, persisted in DO storage between
 * `shipTranscript` ticks.
 *
 * - `seq` — next chunk's sequence number under `date`'s key prefix.
 * - `offset` — bytes already shipped from the container's transcript log
 *   file. Accumulates across UTC date rolls (the log file is one continuous
 *   stream — a calendar day boundary does not truncate it, only rotation
 *   does; see `shouldRotate`).
 * - `date` — UTC calendar date (`yyyy-mm-dd`) `seq` is counting under.
 */
export type TranscriptManifest = { seq: number; offset: number; date: string };

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** One past the largest seq `chunkKey` can represent at `CHUNK_SEQ_WIDTH`
 *  digits (10^6 — `999999` is the last valid zero-padded value). */
const SEQ_OVERFLOW_AT = 10 ** CHUNK_SEQ_WIDTH;

/**
 * Advances a manifest after shipping `bytesShipped` new bytes at `now`.
 *
 * `offset` always accumulates by `bytesShipped` — it tracks a byte position
 * in the container's log file, which a date roll does not reset. `seq`
 * increments to prepare the next chunk's key within the same UTC date, and
 * resets to 0 the moment `now`'s UTC date differs from `m.date` (a new day
 * starts a new `chunkKey` prefix, so its chunk numbering restarts under it).
 *
 * Throws if the next `seq` would reach `SEQ_OVERFLOW_AT` (1,000,000): past
 * that, `chunkKey`'s zero-padding silently stops representing it correctly
 * (a 7-digit seq breaks the lexicographic-sort guarantee `chunkKey`'s own
 * tests rely on) — one studio shipping a million chunks in a single UTC day
 * signals a different problem, not a case to paper over.
 */
export function advance(m: TranscriptManifest, bytesShipped: number, now: Date): TranscriptManifest {
  const date = utcDateString(now);
  const rolled = date !== m.date;
  const seq = rolled ? 0 : m.seq + 1;
  if (seq >= SEQ_OVERFLOW_AT) {
    throw new Error(`archive: seq ${seq} would overflow chunkKey's ${CHUNK_SEQ_WIDTH}-digit width`);
  }
  return { seq, offset: m.offset + bytesShipped, date };
}

/**
 * True once the container's transcript log file is due for rotation (see
 * `ROTATION_THRESHOLD_BYTES`) — truncate + offset reset is `shipTranscript`'s
 * job (a later task), not this pure check's.
 */
export function shouldRotate(fileSize: number): boolean {
  return fileSize >= ROTATION_THRESHOLD_BYTES;
}
