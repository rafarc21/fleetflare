// Transcript ship loop — pulls the container's tmux-piped transcript log
// (container/studio-bringup.sh's guarded pipe-pane step writes it) to R2 via
// sbExec, on StudioDO's `shipTranscript` schedule (do.ts, every 30s from
// provision — same idiom as do.ts's own refreshToken loop).
//
// Constants (rotation threshold, per-tick pull cap, hot-tail size, chunk key
// format, manifest advance/rotation math) all come from src/studio/archive.ts
// (Task 1) — imported below, never redefined here.
//
// Pure-ish core (shipTranscriptTick) over an injected ShipDeps port, the same
// DI shape provision.ts/do.ts use throughout this feature: do.ts wires the
// real sbExec + env.STUDIO_ARCHIVE + `new Date()`; tests inject fakes. This
// file is import-safe under vitest-pool-workers (unlike do.ts, which must
// import "@cloudflare/sandbox" for `extends Sandbox<Env>` — see do.ts's own
// header), so its tests exercise the real function directly, not a
// hand-copied re-implementation.
//
// Fleet Spawn P3, Task 5 (R-P3-5 backlog: "ship tick's 3 execs -> 1 chained
// exec per tick"). A ship tick now issues AT MOST 2 execs, down from up to
// 3: ONE chained `shipTickCmd` covering boot-id + stat + chunk-read +
// hot-tail-read (delimited, parsed below), plus a SECOND, conditional
// `rotateCmd` only when this tick actually needs to rotate. Rotation stays
// its own exec deliberately — see shipTranscriptTick's own doc comment for
// why folding it into the first exec would break the TOCTOU re-stat
// semantics the rotation gate depends on.
import { chunkKey, advance, shouldRotate, TRANSCRIPT_PULL_MAX, HOT_TAIL_BYTES, type TranscriptManifest } from "./archive";
import { INCARNATION_PATH, paneLeadProbeCmd, parsePaneLeadProbe, type BringupVia, type PaneProbeResult } from "./observed";
import { RESTARTS_KEY, recordRestart, type RestartLog } from "./restarts";
import { STUDIO_TMUX, withStudioTmux } from "./tmux";
import { readActivityFrame, parseHookHeartbeat, type FrameVerdict, type HookHeartbeat } from "./activity";
import { parseMemguardKillLines, type MemguardKillLogEntry } from "./memguard-log";

/** Where container/studio-bringup.sh's guarded pipe-pane step writes claude's
 *  pane bytes — ANSI included, raw (that script's own comment: "it is the
 *  truth of the terminal"). */
export const TRANSCRIPT_LOG_PATH = "/workspace/.transcript/claude.log";

/**
 * Fix round (Critical): where container/studio-bringup.sh's guarded
 * create-if-absent step writes a fresh UUID once per CONTAINER lifetime
 * (`[ -f ... ] || cat /proc/sys/kernel/random/uuid > ...` — never rewritten
 * once present, so it stays stable across repeat bring-ups on the SAME
 * container, e.g. a restart). A container recycle wipes the whole
 * `/workspace` filesystem (DO storage does not — see provision.ts's
 * `guardedCloneCmd` doc comment for the same class of gap on the clone step),
 * so a NEW boot-id appearing where an OLD one was stored is this file's
 * signal that `TRANSCRIPT_LOG_PATH` is now a DIFFERENT underlying file than
 * the one the stored manifest's `offset` was measured against — see
 * `bootIdChanged` and its use in `shipTranscriptTick`.
 */
export const TRANSCRIPT_BOOT_ID_PATH = "/workspace/.transcript/boot-id";

/**
 * Dependency seam `shipTranscriptTick` runs over. `exec` is the same
 * sbExec-shaped port every other studio subsystem uses (provision.ts's
 * ProvisionDeps, do.ts's RefreshDeps); `r2Put` stands in for
 * `env.STUDIO_ARCHIVE.put` (bound Worker-side in do.ts, faked in tests —
 * test/studio.archive.test.ts's pool-workers R2 smoke already proves the
 * real binding works, so nothing here re-proves that); `now` returns a real
 * `Date` (not an ISO string, unlike RefreshDeps.now) because archive.ts's
 * `advance` takes one directly.
 */
export interface ShipDeps {
  exec(cmd: string): Promise<{ code: number; stdout: string; stderr: string }>;
  r2Put(key: string, bytes: Uint8Array): Promise<void>;
  now(): Date;
}

/**
 * `shipped` — bytes shipped THIS tick (0 when nothing new). `rotated` — true
 * iff this tick truncated the container's log file. `skipped` — set (and the
 * only other field meaningful values are 0/false) when the tick did nothing
 * because there was nothing to do yet, e.g. `"no-file"` (pre-first-bring-up,
 * or a container recycle between bring-ups) — deliberately `string`, not a
 * closed union, matching this feature's sibling `SyncResult` shape.
 */
export interface ShipResult {
  shipped: number;
  rotated: boolean;
  /** Issue #85: the container's `/workspace/.fleet/incarnation` content this
   *  tick, `""` when the file is absent/unreadable. Read UNCONDITIONALLY —
   *  unlike CHUNK/TAIL, this has nothing to do with whether the transcript
   *  log exists, so it is placed before that guard in shipTickCmd and is
   *  always present on every non-throwing return, including "no-file". */
  incarnationToken: string;
  /** Maestro correction #7 — present ONLY when this tick attempted an
   *  adoption (shipTickCmd was given an `adoptionToken`); `undefined` on
   *  every steady-state tick, which never issues the probe fragment at all. */
  adoptionProbe?: PaneProbeResult;
  /** Issue #221 (PR3a, Task 3) — `readShipTickActivity`'s own verdict for
   *  THIS tick's SECTION_PANE, read UNCONDITIONALLY (every tick, steady-state
   *  included — unlike `adoptionProbe`). `undefined` only when the section
   *  itself is absent from stdout (a pre-feature container). */
  paneVerdict?: FrameVerdict;
  /** Issue #274 — the SAME SECTION_PANE capture `paneVerdict` was already
   *  read from (`parsePaneSection`), handed back RAW so do.ts can run
   *  failover.ts's `evaluateDegradedRecovery` against it without a second
   *  exec: the fast (30s) degraded-row-recovery check reuses this frame
   *  rather than capturing its own. `undefined` under the exact same
   *  condition `paneVerdict` is (SECTION_PANE absent — a pre-feature
   *  container); an empty string is a real, meaningful capture (tmux gone),
   *  same distinction `parsePaneSection` itself already makes. */
  paneFrame?: string;
  /** Issue #221 (PR3b) — `readShipTickHookHeartbeat`'s own verdict for THIS
   *  tick's `SECTION_ACTIVITY_HOOK`, read UNCONDITIONALLY (every tick,
   *  steady-state included, same as `paneVerdict`). `undefined` only when
   *  the section itself is absent from stdout (a pre-feature container);
   *  `null` when the section is present but empty/unparseable (no hook
   *  evidence this tick — the file has never been written, or a hook has
   *  not fired since the last write); otherwise the parsed `HookHeartbeat`. */
  hookHeartbeat?: HookHeartbeat | null;
  /** Issue #311 — this tick's `SECTION_MEMGUARD` tail, parsed. Read
   *  UNCONDITIONALLY (every tick, steady-state included, same as
   *  `paneVerdict`/`paneFrame`) — `undefined` only when the section itself
   *  is absent from stdout (a pre-#311 Worker build never emits it; there
   *  is no container-side gate the way SECTION_PANE has, since this
   *  fragment is entirely Worker-authored, but the "absent means old
   *  build" convention is kept for symmetry and defensive parsing). An
   *  empty array is a real, meaningful result (log absent, or present with
   *  no kills yet) — distinct from `undefined`. */
  memguardKills?: MemguardKillLogEntry[];
  skipped?: string;
}

/**
 * The two keys this feature adds to DO storage, kept as transcript.ts's OWN
 * narrow keyed-storage port rather than widening provision.ts's
 * `StudioStorage` (this task's file list does not touch provision.ts — see
 * task-2-brief.md). A real `this.ctx.storage` (DurableObjectStorage)
 * satisfies BOTH ports structurally, with no cast, the same reason
 * provision.ts's own header gives for why `StudioStorage` needs none: DO
 * storage's `get`/`put` are generic over `T`, so they assign to any narrower
 * keyed-overload interface asked of them — do.ts passes the SAME
 * `this.ctx.storage` to both `provisionWithStorage`/`restartWithStorage`
 * (StudioStorage) and `shipTranscriptTick` (TranscriptStorage) with no
 * conflict.
 */
export const TRANSCRIPT_MANIFEST_KEY = "transcriptManifest";
export const TRANSCRIPT_TAIL_KEY = "transcriptTail";
/** Fix round (Critical): the generation marker — last boot-id this DO has
 *  observed at `TRANSCRIPT_BOOT_ID_PATH`. See `bootIdChanged`. */
export const TRANSCRIPT_BOOT_ID_KEY = "transcriptBootId";

export interface TranscriptStorage {
  get(key: typeof TRANSCRIPT_MANIFEST_KEY): Promise<TranscriptManifest | undefined>;
  get(key: typeof TRANSCRIPT_TAIL_KEY): Promise<string | undefined>;
  get(key: typeof TRANSCRIPT_BOOT_ID_KEY): Promise<string | undefined>;
  /** Issue #56: the container-restart log (restarts.ts), appended in the
   *  same atomic write as a changed boot-id. */
  get(key: typeof RESTARTS_KEY): Promise<RestartLog | undefined>;
  put(key: typeof TRANSCRIPT_MANIFEST_KEY, value: TranscriptManifest): Promise<void>;
  put(key: typeof TRANSCRIPT_TAIL_KEY, value: string): Promise<void>;
  put(key: typeof TRANSCRIPT_BOOT_ID_KEY, value: string): Promise<void>;
  put(key: typeof RESTARTS_KEY, value: RestartLog): Promise<void>;
  /**
   * Fix round 2 (Critical residual): atomic multi-key write — the SAME
   * overload shape real `DurableObjectStorage.put` already has natively
   * (`put<T>(entries: Record<string, T>): Promise<void>`, confirmed in
   * `@cloudflare/workers-types`), which is why `this.ctx.storage` satisfies
   * this addition with no adapter needed, exactly like every other member
   * of this port. Used ONLY for the manifest+boot-id reset pair (see
   * `shipTranscriptTick`'s "generation marker" doc comment) — every other
   * write in this file is single-key.
   */
  put(entries: {
    [TRANSCRIPT_MANIFEST_KEY]: TranscriptManifest; [TRANSCRIPT_BOOT_ID_KEY]: string; [RESTARTS_KEY]?: RestartLog;
  }): Promise<void>;
}

/**
 * Task 5 (P2 plane 3, fleet grid): the grid's per-studio hot-tail read —
 * same "pure function do.ts's method forwards to, a test fake calls
 * directly" shape as provision.ts's getStatusWithStorage. Deliberately its
 * own tiny function rather than inlined at each of its two call sites
 * (do.ts's getTranscriptTail(), test/studio.grid.test.ts's fake stub), for
 * the same "exactly one copy of the read sequence" reason registry.ts's own
 * header gives for provisionWithStorage/getStatusWithStorage/
 * restartWithStorage.
 *
 * `Pick<TranscriptStorage, "get">`, not the full port: this reads nothing
 * else, so a caller (or a test fake) only has to satisfy the one member —
 * the same narrow-port idiom this feature's ShipDeps/SessionSyncDeps
 * already follow elsewhere.
 *
 * Returns `""` (never `undefined`) for a studio whose first shipTranscript
 * tick hasn't landed yet, so callers never need their own undefined-guard on
 * top of grid.ts's own scrubPreview.
 *
 * Deliberately returns the RAW stored value, unscrubbed — R-P2-7 (design
 * spec, Plane 1) draws a hard line between the raw archive (this) and the
 * scrubbed preview any HTTP response may carry. The one caller that turns
 * this into an HTTP response (routes.ts's grid path, via grid.ts's
 * scrubPreview) is responsible for that scrub; this function does not do it
 * itself so it stays exactly one thing — a storage read.
 */
export async function getTranscriptTailWithStorage(storage: Pick<TranscriptStorage, "get">): Promise<string> {
  return (await storage.get(TRANSCRIPT_TAIL_KEY)) ?? "";
}

/**
 * Sentinel "nothing ever shipped" manifest. `date: ""` never equals a real
 * UTC date string, so archive.ts's `advance()` always takes its `rolled`
 * branch on the very first call, regardless of `seq`'s seed value here —
 * which is exactly what correctly seeds `{seq: 0, date: <today>}` for a
 * studio's very first chunk, without this file re-deriving "today's UTC
 * date" itself (archive.ts's own date formatter is deliberately private —
 * see that file's header: constants and math are single-sourced there, nothing
 * downstream redefines them).
 */
const NEVER_SHIPPED: TranscriptManifest = { seq: 0, offset: 0, date: "" };

/**
 * True when the freshly-read boot-id proves `TRANSCRIPT_LOG_PATH` is NOT the
 * same file the stored manifest's `offset` was measured against — a
 * container recycle happened between ticks.
 *
 * `stored === undefined` (never observed before — the very first tick ever)
 * is deliberately NOT a change: there is nothing yet to compare against, and
 * the manifest's offset is already correct for whatever file this is (0,
 * from a fresh manifest).
 *
 * Fix round 2 (New breakage): the caller (`shipTranscriptTick`) NEVER calls
 * this with `fresh === ""`. A durably-unreadable boot-id (the file stays
 * unreadable tick after tick — a real, not hypothetical, failure mode) must
 * NOT be compared here at all: since a `""` fresh value was never persisted
 * (see the "never write empty" rule below), `stored` stays at its last real
 * value forever, so `bootIdChanged(stored, "")` would read true on EVERY
 * tick, forever, if it were ever called with an empty `fresh` — triggering
 * an unbounded reset-and-reship loop (this was a real, shipped bug in the
 * PRIOR fix round: fixed by moving the `fresh === ""` check up into the
 * caller, which skips calling this function at all in that case, rather
 * than trying to special-case `""` in here).
 *
 * Fleet Spawn P3, Task 5: `shipTickCmd` below embeds this SAME comparison,
 * in shell, so the container can decide — inside the one chained exec —
 * which offset to read the chunk section from, before the JS side of this
 * decision (this function) ever runs. See `shipTickCmd`'s own doc comment
 * for the equivalence argument; the two must never diverge.
 */
function bootIdChanged(stored: string | undefined, fresh: string): boolean {
  return stored !== undefined && stored !== fresh;
}

// ---------------------------------------------------------------------------
// Shell command builders — exported for direct string assertions, the same
// pattern do.ts's credentialWriteCmd uses.
// ---------------------------------------------------------------------------

/**
 * Section markers for `shipTickCmd`'s delimited stdout — each printed by its
 * own `echo` call, ON ITS OWN LINE, never sharing a line with content. Chosen
 * to be structurally unambiguous against base64 content, not just
 * unlikely-to-collide: standard base64 (RFC 4648 §4, what GNU coreutils'
 * `base64` emits — confirmed against the pinned container image, no `-w0`,
 * see `readChunkCmd`'s old doc comment for the wrap reasoning that still
 * applies) uses the alphabet `A-Za-z0-9+/=` — it NEVER contains `-`. A marker
 * built entirely from hyphens plus uppercase letters therefore cannot equal,
 * or even appear as a substring of, any line of genuine base64 output, no
 * matter its content — verified in this file's own test suite
 * (test/studio.transcript.test.ts's "base64's alphabet never contains '-'"
 * check, generated from all 256 byte values). The parser below still matches
 * markers by EXACT LINE EQUALITY (`lines.indexOf(...)`), not substring
 * search, as defense in depth against a hypothetically different base64
 * variant ever being substituted in.
 */
export const SECTION_BOOTID = "---FLEET-BOOTID---";
export const SECTION_STAT = "---FLEET-STAT---";
/** Issue #85 — the incarnation token section, read unconditionally between
 *  STAT and the file-exists guard. Same hyphen-safe alphabet argument as its
 *  siblings above. */
export const SECTION_INCARNATION = "---FLEET-INCARNATION---";
export const SECTION_CHUNK = "---FLEET-CHUNK---";
export const SECTION_TAIL = "---FLEET-TAIL---";
/** Issue #221 (PR3a, Task 3) — the pane-frame section: one `capture-pane -p`
 *  frame, base64'd like SECTION_CHUNK/SECTION_TAIL, folded into the SAME
 *  exec right after the incarnation read (and after the adoption probe
 *  fragment, when one runs) so its own content ends exactly where the
 *  next known marker begins — see `shipTickCmd`'s own doc comment. Same
 *  hyphen-safe alphabet argument as its siblings above. */
export const SECTION_PANE = "---FLEET-PANE---";
/** Issue #221 (PR3b) — the hook-heartbeat section: the container's own
 *  `/workspace/.fleet/activity.json`, catted and base64'd like every other
 *  section here. Placed as the very LAST thing `shipTickCmd` emits (after
 *  the file-exists `if`/`fi` block, unconditionally) rather than beside
 *  `SECTION_PANE` — see `shipTickCmd`'s own doc comment for why appending it
 *  needed only two boundary fixes (`parsePaneSection`, `parseMemguardSection`,
 *  `parseShipTickSections`'s `tailB64`) instead of a parser rewrite. Same
 *  hyphen-safe alphabet argument as its siblings above. */
export const SECTION_ACTIVITY_HOOK = "---FLEET-ACTIVITY-HOOK---";
/** Where `gates/activity-heartbeat.sh`'s atomic tmp-then-mv write lands.
 *  Kept in lockstep with that script's own hardcoded path BY CONVENTION —
 *  the same duplication `TRANSCRIPT_LOG_PATH` already accepts against
 *  `container/studio-bringup.sh`'s pipe-pane write: container and Worker are
 *  different runtimes, and neither can import the other's constant. */
export const ACTIVITY_HOOK_PATH = "/workspace/.fleet/activity.json";
/** Issue #311 — memguard's own kill log, tailed on the SAME exec right
 *  after SECTION_PANE. Same hyphen-safe alphabet argument as its siblings
 *  above. See `shipTickCmd`'s own doc comment for placement. */
export const SECTION_MEMGUARD = "---FLEET-MEMGUARD---";

/** Where container/memguard.ts (issue #169) already writes one line per
 *  kill (`formatLogLine`, memguard.ts:508-516) — matches that file's own
 *  default RESOLUTION ORDER verbatim (`memguard.ts:537`: `MEMGUARD_LOG` env
 *  var first, else `FLEET_WORKSPACE`-derived), resolved by the CONTAINER's
 *  shell at run time, never baked in Worker-side. Maestro review, PR #336
 *  round 2, item 3 — round 1 only mirrored the `FLEET_WORKSPACE` half: a
 *  studio whose bring-up set `MEMGUARD_LOG` directly (bypassing the derived
 *  default entirely) would have this section silently tail the WRONG file
 *  and never see its own kills. This is a READ of an existing, already-
 *  shipped log format — nothing here writes to it, and container/memguard.ts
 *  is unchanged by this feature. */
const MEMGUARD_LOG_PATH = "${MEMGUARD_LOG:-${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log}";

/** How many of the log's most recent lines to read per tick. memguard.ts
 *  trims the file to its last 4000 lines only at guard START (`trimLog`,
 *  memguard.ts:496-506) — an active low-memory episode can log several
 *  kills in a 30s window, so this is comfortably above "one kill per
 *  tick" while staying cheap (a few hundred bytes of stdout at most). */
const MEMGUARD_LOG_TAIL_LINES = 20;

/** Standard POSIX single-quote escaping (`'` -> `'\''`) — used only for
 *  embedding a stored boot-id into `shipTickCmd`'s shell text. In practice
 *  the value is always either absent or a UUID read verbatim from
 *  `TRANSCRIPT_BOOT_ID_PATH` (container/studio-bringup.sh writes it from
 *  `/proc/sys/kernel/random/uuid`, which is never quote-bearing), so this is
 *  belt-and-suspenders correctness, not a response to any known-hostile
 *  input — cheap enough to just always do right. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ONE chained exec a ship tick issues for boot-id + stat + chunk-read +
 * hot-tail-read (Fleet Spawn P3, Task 5 — R-P3-5's "3 execs -> 1"). Produces
 * delimited stdout, each section on the line(s) after its own marker (see
 * SECTION_BOOTID/STAT/CHUNK/TAIL): a boot-id line, always; a stat line,
 * always; then — ONLY when the file exists (`FLEET_SIZE -ge 0`) — a chunk
 * section and a tail section. When the file does not exist, the script's
 * `if` body never runs at all, so CHUNK/TAIL are simply ABSENT from the
 * output (not empty markers) — `shipTranscriptTick`'s own `size < 0` check
 * (parsed from the STAT section) returns `{skipped:"no-file"}` before ever
 * looking for them, the same short-circuit the old 3-exec version made by
 * never issuing the read/tail execs at all when the first one reported no
 * file.
 *
 * The offset the chunk section reads from (`FLEET_EFF`) is computed IN
 * SHELL, from values embedded as literals (`manifestOffset`, `storedBootId`
 * — both already known to the caller from storage BEFORE this exec ever
 * runs) compared against the boot-id/size THIS exec freshly reads. This is
 * necessary, not merely convenient: `shipTranscriptTick`'s own
 * boot-id-changed / offset-belt reset logic (`bootIdChanged`, and the
 * `offset > size` belt) can only decide "read from 0 instead of the stored
 * offset" once it has SEEN the fresh boot-id and size — and this whole
 * function's point is that there is no second round trip in which to react
 * to that before reading the chunk. So the shell script mirrors the EXACT
 * same two checks JS makes, using EXACTLY the same inputs:
 *   - boot-id: shell's `FLEET_FRESH_BOOT_ID non-empty AND FLEET_STORED_BOOT_ID
 *     non-empty AND they differ` is the identical condition to
 *     `freshBootId !== "" && bootIdChanged(storedBootId, freshBootId)` —
 *     `storedBootId ?? ""` is what gets embedded, and a REAL persisted boot-id
 *     is never itself the empty string (nothing in this file ever writes one
 *     — see `shipTranscriptTick`'s "never write empty" rule), so "embedded
 *     literal is empty" and "storedBootId is undefined" are the same fact
 *     observed from two sides.
 *   - belt: shell's `FLEET_EFF -gt FLEET_SIZE` against the SAME size value
 *     JS parses from the STAT section moments later is the identical
 *     `effectiveManifest.offset > size` check.
 * `shipTranscriptTick` still performs its OWN, independent computation of
 * `effectiveManifest`/`resetTriggered` after parsing the response — it does
 * not trust the shell's internal `FLEET_EFF` for what to PERSIST, only for
 * (proven, by the equivalence above) which bytes the CHUNK section actually
 * contains. If this command's shell logic and shipTranscriptTick's JS logic
 * were ever edited out of lockstep, the container-recycle test suite
 * (test/studio.transcript.test.ts's "generation marker" describe block)
 * would fail — it pins the exact resulting ship behavior, not just the
 * command text.
 */
/**
 * `adoptionToken`, maestro correction #6: when supplied (the caller passes
 * one only when `Observed.incarnation` is `null` — the DO has never
 * recorded a token), this command ALSO conditionally writes it into
 * `INCARNATION_PATH`, in the SAME exec, but only if the file currently
 * reads empty — a container that already holds SOME token (a DO that lost
 * its own storage some other way) is never overwritten. Correction #2: the
 * read is always `FLEET_INC="$(cat FILE 2>/dev/null)"` — captured into a
 * shell variable BEFORE anything is echoed — never a bare `cat FILE ||
 * echo ''` piped straight into this command's own stdout, which is exactly
 * what glued a no-trailing-newline token onto the next section marker.
 */
export function shipTickCmd(
  manifestOffset: number, storedBootId: string | undefined, adoptionToken?: string,
): string {
  const storedBootIdLiteral = shellSingleQuote(storedBootId ?? "");
  const incarnationRead = adoptionToken === undefined
    ? `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; `
    : (
      `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; ` +
      `if [ -z "$FLEET_INC" ]; then ` +
      // `$(dirname ${INCARNATION_PATH})`, not a hardcoded `/workspace/.fleet`
      // — the same fix as observed.ts's writeIncarnationCmd/
      // bringupObservationCmd, one source of truth for the directory,
      // derived from the same constant the write/rename targets already use.
      `mkdir -p "$(dirname ${INCARNATION_PATH})" && printf '%s\\n' ${shellSingleQuote(adoptionToken)} > ${INCARNATION_PATH}.tmp ` +
      `&& mv ${INCARNATION_PATH}.tmp ${INCARNATION_PATH} && FLEET_INC=${shellSingleQuote(adoptionToken)}; ` +
      `fi; `
    );
  // Maestro correction #7: fold the pane probe into the SAME exec, but only
  // when this tick MIGHT adopt — a steady-state tick (adoptionToken
  // undefined) never pays for a probe it has no use for.
  //
  // Fix round (BLOCKER 1, #85 review): `paneLeadProbeCmd()`'s own return
  // value ends mid-statement (`...; fi; echo`, its own trailing cwd `echo`
  // with no separator after it) — string-concatenating it directly onto the
  // NEXT fragment below (`if [ "$FLEET_SIZE" -ge 0 ]; then ...`) glued them
  // into one bareword, `echoif`, a bash syntax error (exit 2) on EVERY
  // adoption-path tick. The trailing `; ` here is the fix: it terminates the
  // probe's own last statement before the next fragment's `if` ever begins.
  const probeFragment = adoptionToken === undefined ? "" : `${paneLeadProbeCmd()}; `;
  // Issue #221 (PR3a, Task 3) — B1: ONE `capture-pane -p` frame, no `sleep`,
  // riding this SAME exec. Addressed BY NAME (`withStudioTmux`, same as
  // failover.ts's own paneCaptureCmd) — never selects, switches or attaches.
  // Placed AFTER the (optional) adoption probe fragment and BEFORE the
  // file-exists guard, so its base64 content ends exactly at the next known
  // marker (SECTION_CHUNK when the file exists, or simply the end of stdout
  // when it does not) with nothing else able to land in between.
  const paneFragment = withStudioTmux(
    `echo '${SECTION_PANE}'; ${STUDIO_TMUX} capture-pane -p -t studio:claude 2>/dev/null | base64; `,
  );
  // Issue #221 (PR3b) — the hook-heartbeat read: `2>/dev/null` so a missing
  // file (pre-hook-install studio, or a hook that has never fired yet) never
  // fails the whole chained script, same guard shape `paneFragment` already
  // uses for a gone tmux server. Unconditional, and placed AFTER the
  // if/fi block below (never inside it) — the heartbeat file's existence has
  // nothing to do with whether the transcript log exists yet.
  const activityHookFragment = `echo '${SECTION_ACTIVITY_HOOK}'; cat ${ACTIVITY_HOOK_PATH} 2>/dev/null | base64; `;
  // Issue #311 — memguard's own kill log, tailed and base64'd like every
  // other section, right after the pane. `2>/dev/null` guards BOTH "file
  // does not exist yet" (a studio that has never had a low-memory episode)
  // and any other unreadable-file case — `tail` itself still exits 0 on a
  // missing file with this redirect, so this can never fail the tick the
  // way an unguarded read could. Placed AFTER paneFragment and BEFORE the
  // file-exists guard, same "ends exactly at the next known marker" rule
  // SECTION_PANE's own placement already follows (see `parsePaneSection`'s
  // own doc comment) — `parsePaneSection` now ends its own slice at
  // SECTION_MEMGUARD when present, never swallowing this section's bytes.
  const memguardFragment =
    `echo '${SECTION_MEMGUARD}'; tail -n ${MEMGUARD_LOG_TAIL_LINES} ${MEMGUARD_LOG_PATH} 2>/dev/null | base64; `;
  return (
    `FLEET_FRESH_BOOT_ID=$(cat ${TRANSCRIPT_BOOT_ID_PATH} 2>/dev/null || echo ''); ` +
    `echo '${SECTION_BOOTID}'; echo "$FLEET_FRESH_BOOT_ID"; ` +
    `FLEET_SIZE=$(stat -c %s ${TRANSCRIPT_LOG_PATH} 2>/dev/null || echo -1); ` +
    `echo '${SECTION_STAT}'; echo "$FLEET_SIZE"; ` +
    incarnationRead +
    `echo '${SECTION_INCARNATION}'; echo "$FLEET_INC"; ` +
    probeFragment +
    paneFragment +
    memguardFragment +
    `if [ "$FLEET_SIZE" -ge 0 ]; then ` +
    `FLEET_STORED_BOOT_ID=${storedBootIdLiteral}; ` +
    `if [ -n "$FLEET_FRESH_BOOT_ID" ] && [ -n "$FLEET_STORED_BOOT_ID" ] && [ "$FLEET_FRESH_BOOT_ID" != "$FLEET_STORED_BOOT_ID" ]; then FLEET_EFF=0; else FLEET_EFF=${manifestOffset}; fi; ` +
    `if [ "$FLEET_EFF" -gt "$FLEET_SIZE" ]; then FLEET_EFF=0; fi; ` +
    `echo '${SECTION_CHUNK}'; ` +
    `tail -c +$((FLEET_EFF+1)) ${TRANSCRIPT_LOG_PATH} | head -c ${TRANSCRIPT_PULL_MAX} | base64; ` +
    `echo '${SECTION_TAIL}'; ` +
    `tail -c ${HOT_TAIL_BYTES} ${TRANSCRIPT_LOG_PATH} | base64; ` +
    `fi; ` +
    activityHookFragment
  );
}

/** Printed as `rotateCmd`'s own last line so shipTranscriptTick can tell,
 *  from stdout alone, whether the truncate actually happened. Plain words
 *  rather than some unlikely-collision token: the caller only ever looks for
 *  these when it KNOWS (from having decided to issue this exec at all) that
 *  one of the two is guaranteed present as the command's one and only output
 *  line, so there is no scenario where anything else could be mistaken for
 *  one. */
const ROTATED_MARKER = "ROTATED";
const SKIPPED_MARKER = "SKIPPED";

/**
 * The rotation exec — Fleet Spawn P3, Task 5's deliberately-still-separate
 * second exec (R-P3-5: consolidating this into `shipTickCmd` would break the
 * TOCTOU re-stat semantics below). Issued ONLY when `shipTranscriptTick`
 * has already determined, from `shipTickCmd`'s OWN stat (read moments
 * earlier, in the first exec), that the file is over `ROTATION_THRESHOLD_BYTES`
 * AND this tick's ship fully caught up to it — never unconditionally, and
 * never chained onto the first exec, because that decision itself depends on
 * bytes this tick only just finished shipping.
 *
 * Fix round (Important, rotation TOCTOU — carried over from the pre-Task-5
 * design unchanged): `shippedSize` is the byte count this tick has actually
 * confirmed durable in R2 (`nextManifest.offset` at the call site). The `if`
 * RE-STATS the file immediately before truncating, closing the window
 * between `shipTickCmd`'s stat (used to decide whether to even attempt
 * rotation) and the truncate itself. If the file grew past `shippedSize` in
 * that window, the truncate is skipped and `SKIPPED_MARKER` prints instead;
 * next tick's own stat sees the larger size and ships the rest normally, so
 * nothing already written is ever lost to a truncate racing an in-flight
 * write. Both branches of the `if`/`else` succeed as shell commands, so ONLY
 * a genuine truncate failure (permission, I/O) still surfaces as a non-zero
 * exec.
 *
 * Fleet Spawn P3, Task 5 (P2 minor, truncate-label fix): unlike the OLD
 * combined `hotTailCmd(true, ...)` this replaces — which chained a hot-tail
 * READ onto the SAME exec as this truncate, so a non-zero exit could mean
 * EITHER half failed, yet the catch always blamed "hot-tail read failed" —
 * this exec does only a re-stat and a truncate, nothing else. Its own
 * failure message (`shipTranscriptTick`'s `transcript rotation failed`) is
 * now accurate for everything that could actually make THIS exec fail.
 */
export function rotateCmd(shippedSize: number): string {
  return (
    `if [ "$(stat -c %s ${TRANSCRIPT_LOG_PATH} 2>/dev/null || echo -1)" -le ${shippedSize} ]; then ` +
    `truncate -s 0 ${TRANSCRIPT_LOG_PATH} && echo ${ROTATED_MARKER}; else echo ${SKIPPED_MARKER}; fi`
  );
}

/** Defensive fallback (unreachable in production — `rotateCmd`'s own
 *  if/else always prints exactly one of the two markers as its entire
 *  output) treats anything else as not-rotated, the same posture the old
 *  `stripRotationMarker` documented for its own equivalent fallback. */
function parseRotateResult(stdout: string): boolean {
  return stdout.trim() === ROTATED_MARKER;
}

/**
 * Splits `shipTickCmd`'s delimited stdout into its four sections, matching
 * markers by EXACT LINE EQUALITY (never substring/`.includes`) — see
 * SECTION_BOOTID's own doc comment for why that is provably safe against
 * base64 content, and belt-and-suspenders even if it weren't.
 *
 * A marker that isn't found at all yields `undefined` for CHUNK/TAIL (the
 * caller decides what "missing when it was expected" means — see
 * `shipTranscriptTick`), or `""` for BOOTID/STAT after the `?? "" `
 * fallbacks below, which is deliberately indistinguishable from "the marker
 * was found but its line was empty" — the old `parseStatAndBootId`'s
 * `lines[1] ?? ""` made exactly the same "missing reads the same as empty"
 * choice for the boot-id line, and an empty/unparseable STAT section both
 * already collapse to the SAME "no-file" skip in `shipTranscriptTick` (its
 * `!Number.isFinite(size) || size < 0` check), matching the old "empty/
 * garbage stat output is also treated as no-file, not a crash" behavior.
 *
 * Sections are read in the FIXED order this file's own `shipTickCmd` always
 * emits them (BOOTID, STAT, CHUNK, TAIL) — a genuinely out-of-order or
 * duplicated-marker response is not a shape this exec ever produces, so this
 * parser does not attempt to handle it as anything other than however the
 * fixed-order slicing below happens to read it (never a crash, just not a
 * scenario this file's tests need to pin a specific interpretation for).
 *
 * Issue #85, maestro correction #7: `incarnationToken` is read as EXACTLY
 * the one line after its marker, never sliced to the next marker the way
 * CHUNK/TAIL are. `shipTickCmd` now conditionally emits the pane-lead
 * probe's OWN sections between INCARNATION and the CHUNK guard (on an
 * adoption attempt only) — a slice-to-next-marker read would swallow those
 * probe lines into `incarnationToken` whenever CHUNK is either absent
 * (no-file) or simply comes after the probe fragment. `$FLEET_INC` is
 * always a single `echo` of a UUID or an empty string, so the one-line read
 * is also simply correct, never a narrowing of what the command can emit.
 */
function parseShipTickSections(
  stdout: string,
): { freshBootId: string; size: number; incarnationToken: string; chunkB64: string | undefined; tailB64: string | undefined } {
  const lines = stdout.split("\n");
  const bootIdx = lines.indexOf(SECTION_BOOTID);
  const statIdx = lines.indexOf(SECTION_STAT);
  const incIdx = lines.indexOf(SECTION_INCARNATION);
  const chunkIdx = lines.indexOf(SECTION_CHUNK);
  const tailIdx = lines.indexOf(SECTION_TAIL);
  // Issue #221 (PR3b) — SECTION_ACTIVITY_HOOK now follows TAIL unconditionally
  // (shipTickCmd's own doc comment). tailB64's end must stop there instead of
  // running to the true end of stdout, or the hook section's own marker+body
  // would be swallowed into "tail content".
  const hookIdx = lines.indexOf(SECTION_ACTIVITY_HOOK);

  const slice = (start: number, end: number): string | undefined =>
    start === -1 ? undefined : lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
  const oneLine = (idx: number): string => (idx === -1 ? "" : (lines[idx + 1] ?? "").trim());

  const freshBootId = (slice(bootIdx, statIdx) ?? "").trim();
  const sizeText = (slice(statIdx, incIdx) ?? "").trim();
  const size = Number.parseInt(sizeText, 10);
  const incarnationToken = oneLine(incIdx);
  const chunkB64 = slice(chunkIdx, tailIdx);
  const tailB64 = slice(tailIdx, hookIdx);

  return { freshBootId, size, incarnationToken, chunkB64, tailB64 };
}

// ---------------------------------------------------------------------------
// base64 decode — container -> Worker. The reverse direction of
// sandbox-api.ts's bytesToBase64 (Worker -> container), needed here because
// exec's stdout is text-only and pipe-pane's captured bytes are NOT
// guaranteed printable (claude's own screen can carry arbitrary control
// bytes) — base64 is what survives that round trip intact.
// ---------------------------------------------------------------------------

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, ""); // strips base64's own 76-col wrap (see shipTickCmd)
  if (clean.length === 0) return new Uint8Array(0);
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Fleet Spawn P3, Task 5 (U+FFFD trim). `tail -c HOT_TAIL_BYTES` cuts the
 * container's log file at a fixed byte position with no regard for UTF-8
 * character boundaries — when that cut lands inside a multi-byte character
 * (its lead byte fell in the portion of the file this read excludes), the
 * slice's own leading byte(s) are orphaned continuation bytes (`10xxxxxx`)
 * with no lead byte of their own. `TextDecoder`'s default (non-fatal) mode
 * renders each orphan as a U+FFFD replacement character — a stray "�" glyph
 * at the very top of an otherwise-clean grid preview.
 *
 * `TextDecoder({stream:true})` does NOT help here, despite being the more
 * commonly reached-for fix for "chunk boundary splits a character": stream
 * mode exists to WITHHOLD an incomplete sequence at the END of a chunk for a
 * LATER decode() call to complete. This cut is at the START of the slice —
 * the file's own true end is what closes the OTHER side of `tail -c`'s
 * window, and that end is always complete (barring an in-flight write racing
 * this exact read, a separate and much narrower concern this trim does not
 * attempt to cover). A trailing-incomplete-sequence guard would silently
 * solve a problem this function does not have, while leaving the one it does
 * have (a leading orphan) completely untouched — `stream:true` never even
 * inspects a run's LEADING bytes for validity beyond normal decoding.
 *
 * A UTF-8 sequence is at most 4 bytes, so a cut can orphan at most 3
 * continuation bytes (the 4th, the lead byte, is what got excluded) — this
 * skips exactly that many from the front, landing on the next genuine
 * character boundary, whatever follows (ASCII or another complete
 * multi-byte character).
 */
function trimPartialLeadingUtf8(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < 3 && i < bytes.length && (bytes[i] & 0xc0) === 0x80) i++;
  return bytes.subarray(i);
}

/** Decode + trim, exported as one step so it is directly testable without
 *  routing a whole shipTranscriptTick through it — see
 *  trimPartialLeadingUtf8's own doc comment for the "why" this exists at
 *  all. */
export function decodeTailPreview(bytes: Uint8Array): string {
  return new TextDecoder().decode(trimPartialLeadingUtf8(bytes));
}

// ---------------------------------------------------------------------------
// Issue #221 (PR3a, Task 3) — the pane section, decoded independently of
// parseShipTickSections above: `shipTickCmd` places SECTION_PANE right after
// the (optional) adoption-probe fragment and before the file-exists guard,
// so its content always ends exactly at SECTION_CHUNK when the file exists,
// or at the end of stdout when it does not (`slice`'s own `-1 -> end` rule,
// same as every other section here).
// ---------------------------------------------------------------------------

/**
 * The decoded pane frame from `shipTickCmd`'s stdout, or `undefined` when
 * `SECTION_PANE` itself is absent — a pre-feature container (old image),
 * never a throw. An EMPTY string is a real, meaningful result (tmux gone —
 * see `readShipTickActivity` below), distinct from `undefined`.
 */
export function parsePaneSection(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  const paneIdx = lines.indexOf(SECTION_PANE);
  if (paneIdx === -1) return undefined;
  // Issue #311 — SECTION_MEMGUARD now sits between SECTION_PANE and the
  // file-exists guard (SECTION_CHUNK/TAIL), so the pane slice must end
  // there when it is present, never fall through to SECTION_CHUNK and
  // swallow the memguard bytes into the pane content. Falls back to the
  // OLD chunk-or-end behavior when SECTION_MEMGUARD is absent (defensive;
  // in practice every Worker build that emits SECTION_PANE also emits
  // SECTION_MEMGUARD, since both come from the same shipTickCmd call).
  const memguardIdx = lines.indexOf(SECTION_MEMGUARD);
  const chunkIdx = lines.indexOf(SECTION_CHUNK);
  // Issue #221 (PR3b) — CHUNK is present only on a file-exists tick; on a
  // no-file tick (CHUNK/TAIL never emitted at all) SECTION_ACTIVITY_HOOK is
  // the very next marker instead, since it now trails the whole if/fi block
  // unconditionally (shipTickCmd's own doc comment). Falls back to end of
  // stdout only when NONE of the later markers is present (a pre-both-
  // features image). Priority order matches emission order: MEMGUARD always
  // sits immediately after PANE when present (issue #311's own comment
  // above), so it takes precedence over CHUNK/HOOK when found.
  const hookIdx = lines.indexOf(SECTION_ACTIVITY_HOOK);
  const end = memguardIdx !== -1 ? memguardIdx : chunkIdx !== -1 ? chunkIdx : hookIdx !== -1 ? hookIdx : lines.length;
  const b64 = lines.slice(paneIdx + 1, end).join("\n");
  try {
    return decodeTailPreview(base64ToBytes(b64));
  } catch {
    // Never throw into the caller's own tick/alarm path over pane content —
    // malformed base64 (a torn exec response) degrades to the same "nothing
    // usable" outcome an empty section already gets (readShipTickActivity's
    // own "pane empty" verdict), never an uncaught exception.
    return "";
  }
}

/**
 * `shipTickCmd`'s pane section -> a `FrameVerdict`, or `undefined` when the
 * section itself is absent (old image — the caller keeps whatever activity
 * it already had, per this feature's own "tolerates it being absent" rule).
 * An empty section (present marker, no bytes — tmux itself is gone) is its
 * own `unknown` verdict, never `readActivityFrame`'s "claude not on screen"
 * wording, which describes a DIFFERENT thing (a real, non-empty frame whose
 * footer is not at the bottom).
 */
export function readShipTickActivity(stdout: string): FrameVerdict | undefined {
  const frame = parsePaneSection(stdout);
  if (frame === undefined) return undefined;
  if (frame.trim() === "") return { kind: "unknown", reason: "pane empty" };
  return readActivityFrame(frame);
}

// ---------------------------------------------------------------------------
// Issue #311 — the memguard-log section, decoded the same way SECTION_PANE
// is: sliced to the next known marker, base64-decoded, never thrown on.
// ---------------------------------------------------------------------------

/**
 * The decoded memguard-log tail from `shipTickCmd`'s stdout, or `undefined`
 * when `SECTION_MEMGUARD` itself is absent (a pre-#311 Worker build) —
 * never a throw. An EMPTY string is a real, meaningful result (the log
 * file does not exist yet, or exists but is empty), distinct from
 * `undefined`, same convention `parsePaneSection` already uses.
 */
export function parseMemguardSection(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  const idx = lines.indexOf(SECTION_MEMGUARD);
  if (idx === -1) return undefined;
  const chunkIdx = lines.indexOf(SECTION_CHUNK);
  // Issue #221 (PR3b) — same fix `parsePaneSection` needed: on a no-file
  // tick CHUNK is absent and SECTION_ACTIVITY_HOOK is the very next marker
  // instead (it trails the whole if/fi block unconditionally), so this must
  // stop there too, or a no-file tick's memguard slice would swallow the
  // hook section's own marker+body.
  const hookIdx = lines.indexOf(SECTION_ACTIVITY_HOOK);
  const end = chunkIdx !== -1 ? chunkIdx : hookIdx !== -1 ? hookIdx : lines.length;
  const b64 = lines.slice(idx + 1, end).join("\n");
  try {
    return decodeTailPreview(base64ToBytes(b64));
  } catch {
    // Same "never throw into the caller's own tick path" rule
    // `parsePaneSection` already follows for a torn/malformed section.
    return "";
  }
}

/**
 * `shipTickCmd`'s memguard section -> parsed kill entries, or `undefined`
 * when the section itself is absent (see `parseMemguardSection`). An empty
 * section (log absent, or empty) yields an empty array, not `undefined` —
 * mirrors `readShipTickActivity`'s own "pane empty is still a real result"
 * shape, but there is no equivalent of `readActivityFrame`'s "unknown"
 * verdict here: an empty/no-kills memguard tail is simply zero alerts,
 * never itself a statement about the studio.
 */
export function readShipTickMemguardKills(stdout: string): MemguardKillLogEntry[] | undefined {
  const text = parseMemguardSection(stdout);
  if (text === undefined) return undefined;
  if (text.trim() === "") return [];
  return parseMemguardKillLines(text);
}

// ---------------------------------------------------------------------------
// Issue #221 (PR3b) — the hook-heartbeat section. Decoded independently of
// every other section: `shipTickCmd` places SECTION_ACTIVITY_HOOK as the
// very LAST thing it emits, so this always runs to the end of stdout with
// nothing else able to land after it — no boundary ambiguity, unlike PANE
// or MEMGUARD (both of which now have to know about this marker too, see
// their own doc comments above).
// ---------------------------------------------------------------------------

/**
 * The decoded heartbeat-file text from `shipTickCmd`'s stdout, or `undefined`
 * when `SECTION_ACTIVITY_HOOK` itself is absent — a pre-feature container
 * (old image), never a throw. An EMPTY string is a real, meaningful result
 * (no heartbeat file yet — a fresh studio the hooks have never fired in),
 * distinct from `undefined`.
 */
export function parseActivityHookSection(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  const idx = lines.indexOf(SECTION_ACTIVITY_HOOK);
  if (idx === -1) return undefined;
  const b64 = lines.slice(idx + 1).join("\n");
  try {
    return decodeTailPreview(base64ToBytes(b64));
  } catch {
    // Never throw into the caller's own tick/alarm path over heartbeat
    // content — malformed base64 (a torn exec response) degrades to the
    // same "no evidence this tick" outcome an empty/malformed JSON body
    // already gets (readShipTickHookHeartbeat's own `null`), never an
    // uncaught exception.
    return "";
  }
}

/**
 * `shipTickCmd`'s hook-heartbeat section -> a `HookHeartbeat`, `null`, or
 * `undefined`. `undefined` only when the section itself is absent (old
 * image — `nextActivity` treats this exactly like the hook never having a
 * say this tick, same as `paneVerdict` being absent keeps whatever activity
 * already existed). `null` when the section is present but empty or its
 * content fails `parseHookHeartbeat`'s own validation — "no hook evidence
 * this tick", never a throw.
 */
export function readShipTickHookHeartbeat(stdout: string): HookHeartbeat | null | undefined {
  const raw = parseActivityHookSection(stdout);
  if (raw === undefined) return undefined;
  return parseHookHeartbeat(raw);
}

// ---------------------------------------------------------------------------
// Core tick
// ---------------------------------------------------------------------------

/**
 * One shipTranscript tick.
 *
 * Sequence: read the manifest + last-seen boot-id -> ONE chained exec
 * (`shipTickCmd`) that reads the container's current boot-id, stats the log
 * file, and (when the file exists) reads both the next unshipped chunk and a
 * fresh hot-tail preview -> resolve the EFFECTIVE offset the chunk section
 * was actually read from (see "generation marker" below) -> if there were
 * unshipped bytes, R2-put the chunk keyed by `chunkKey(id, advanced.date,
 * advanced.seq)` (`advanced` = `archive.ts`'s `advance(effectiveManifest,
 * bytesShipped, now)`) -> persist the refreshed hot-tail preview -> rotate
 * (truncate + offset reset) via a SECOND, separate exec, once the file is
 * both over threshold AND fully caught up, re-verified immediately before
 * truncating (see `rotateCmd`).
 *
 * Fleet Spawn P3, Task 5 (R-P3-5, exec consolidation): the boot-id read,
 * stat, chunk read, and hot-tail read that used to be up to 3 separate
 * `deps.exec()` round trips are now ONE (`shipTickCmd`) — see that
 * function's own doc comment for how it still lets the chunk section read
 * from the CORRECT offset despite the boot-id-changed/offset-belt decision
 * depending on a boot-id this same exec is the one reading. Rotation stays
 * a genuinely separate, conditional exec: whether to even ATTEMPT it can
 * only be known after this tick's own ship has completed (it depends on
 * `nextManifest.offset`, computed below from THIS exec's results), and its
 * own TOCTOU re-stat exists specifically to close a window that folding it
 * into the first exec would reopen — a single combined exec cannot re-stat
 * "immediately before truncating" a size that exec itself hasn't finished
 * deciding yet.
 *
 * Generation marker (container-recycle offset staleness): DO storage
 * survives a container recycle; `TRANSCRIPT_LOG_PATH` does not — a recycle
 * silently makes the stored manifest's `offset` a position in a FILE THAT NO
 * LONGER EXISTS, measured against a DIFFERENT file that happens to live at
 * the same path now. Two independent detectors:
 *   1. `bootIdChanged` (identity-based, catches the case a raw size
 *      comparison CANNOT): the fresh file may have already grown PAST the
 *      stale offset by the time a tick observes it — offset < size would
 *      look like ordinary continuation, and blindly reading from the stale
 *      offset would skip everything between 0 and it FOREVER, since that
 *      range belongs to a file that no longer exists.
 *   2. The belt: `effectiveManifest.offset > size` is impossible for the
 *      SAME file (offset only ever grows, capped by TRANSCRIPT_PULL_MAX per
 *      tick) — fires for any path the marker itself misses.
 * Either detector resets `offset` to 0 (never `seq`/`date` — those are left
 * exactly as `advance()`'s own normal date-roll rules would set them
 * regardless, because reusing a seq number could silently overwrite an R2
 * chunk that still holds pre-recycle content; a fresh boot-id gets a fresh,
 * never before used seq, continuing the SAME counter). `shipTickCmd` mirrors
 * both detectors in shell so the SAME tick's chunk section already reads
 * from the corrected offset — see that function's own doc comment for the
 * equivalence argument.
 *
 * Fix round 2 (Critical residual — two-tick race): whichever detector fires,
 * the reset manifest is persisted IMMEDIATELY, atomically alongside the
 * current boot-id, via `TranscriptStorage`'s multi-key `put` overload —
 * BEFORE the ship block below even runs, not as a side effect of it. Without
 * this, a "detection tick" that finds the post-recycle file at 0 bytes (a
 * real window: pipe-pane creates the file before claude's first byte, and
 * this 30s tick is fully decoupled from recycle timing) would consume the
 * boot-id mismatch, update `storedBootId` in storage, but ship nothing —
 * leaving the STALE offset sitting in storage. The NEXT tick would then read
 * "boot-ids already match" (since the fresh one was written) and silently
 * skip the reset it still owed: the original loss bug, through a narrower
 * door. Persisting both together closes it — there is no tick boundary where
 * the boot-id can be updated without the offset reset landing too.
 *
 * The boot-id value in that atomic write is never `""`: an unreadable
 * boot-id must never overwrite a known-good stored one (that would
 * manufacture a FUTURE false-positive mismatch the moment the file becomes
 * readable again with the SAME identity), and when NEITHER a fresh nor a
 * stored value exists yet, the write silently drops to a manifest-only
 * single-key `put` — there is nothing meaningful to record either way.
 *
 * Failure isolation: a non-zero `shipTickCmd` exit throws immediately, with
 * NOTHING parsed or persisted for that tick (Fleet Spawn P3, Task 5: a
 * deliberate, documented tightening from the pre-consolidation version,
 * where a failure of the OLD 3rd exec — hot-tail — could still leave an
 * already-successful ship's manifest write standing; now that read+tail
 * share one exec, a hard failure of that exec is treated as a whole-tick
 * failure, not a partial one — the SAME chunk key/bytes are simply
 * re-attempted next tick, an idempotent R2 overwrite, not a lost chunk). A
 * STRUCTURALLY malformed response (exit 0, but a section this tick expected
 * is missing — see `parseShipTickSections`) is handled more granularly:
 * a missing CHUNK section throws before anything is persisted, but a missing
 * TAIL section throws AFTER the chunk-driven ship (if any) has already been
 * persisted — the exec genuinely returned usable ship data even though its
 * tail section was absent, so that data is not discarded. This is the one
 * case that still preserves the pre-consolidation behavior of "a later
 * step's failure does not roll back an already-durable ship."
 */
export async function shipTranscriptTick(
  deps: ShipDeps, storage: TranscriptStorage, id: string, adoptionToken?: string,
  bringupVia: BringupVia | null = null,
): Promise<ShipResult> {
  const now = deps.now();
  const manifest = (await storage.get(TRANSCRIPT_MANIFEST_KEY)) ?? NEVER_SHIPPED;
  const storedBootId = await storage.get(TRANSCRIPT_BOOT_ID_KEY);

  const tickRes = await deps.exec(shipTickCmd(manifest.offset, storedBootId, adoptionToken));
  if (tickRes.code !== 0) {
    throw new Error(`transcript ship tick failed (${tickRes.code}): ${tickRes.stderr.slice(0, 500)}`);
  }
  const { freshBootId, size, incarnationToken, chunkB64, tailB64 } = parseShipTickSections(tickRes.stdout);
  // Maestro correction #7: parsed ONLY when this tick attempted an adoption
  // — a steady-state tick's own shipTickCmd never issued the probe fragment
  // at all, so parsing its absence here would be meaningless.
  const adoptionProbe = adoptionToken === undefined ? undefined : parsePaneLeadProbe(tickRes.stdout);
  // Issue #221 (PR3a, Task 3) — read on EVERY tick, steady-state included:
  // unlike `adoptionProbe`, `shipTickCmd` always emits SECTION_PANE.
  const paneVerdict = readShipTickActivity(tickRes.stdout);
  // Issue #274 — the raw frame `paneVerdict` was read from, handed back too
  // (see ShipResult.paneFrame's own doc comment): same section, no second
  // parse of the base64, just the one `parsePaneSection` call this file's
  // `readShipTickActivity` already makes internally, called again here
  // (cheap: a string slice + a base64 decode, not a second exec) so this
  // function does not have to reach into readShipTickActivity's own
  // internals to get at what it already computed.
  const paneFrame = parsePaneSection(tickRes.stdout);
  // Issue #221 (PR3b) — read on EVERY tick, steady-state AND no-file alike:
  // the hook heartbeat has nothing to do with whether the transcript log
  // file exists yet (see SECTION_ACTIVITY_HOOK's own doc comment for why it
  // is emitted unconditionally, after the file-exists if/fi block).
  const hookHeartbeat = readShipTickHookHeartbeat(tickRes.stdout);
  // Issue #311 — read on EVERY tick, steady-state included, same as
  // paneVerdict/paneFrame above: shipTickCmd always emits SECTION_MEMGUARD.
  const memguardKills = readShipTickMemguardKills(tickRes.stdout);
  if (!Number.isFinite(size) || size < 0) {
    return {
      shipped: 0, rotated: false, incarnationToken, adoptionProbe, paneVerdict, paneFrame, hookHeartbeat, memguardKills,
      skipped: "no-file",
    };
  }

  let effectiveManifest = manifest;
  let resetTriggered = false;
  // Issue #56: a new container generation — counted in the SAME atomic write
  // that records the new boot-id below, so it lands exactly once.
  let restarts: RestartLog | undefined;

  if (freshBootId === "") {
    // Fix round 2 (New breakage): NEVER call bootIdChanged with an empty
    // fresh value — see that function's own doc comment for why doing so
    // would loop forever. The belt below is still fully active this tick.
    console.warn(
      `shipTranscript ${id}: boot-id unreadable this tick — generation-marker check skipped (offset>size belt remains active)`,
    );
  } else if (bootIdChanged(storedBootId, freshBootId)) {
    effectiveManifest = { ...manifest, offset: 0 };
    resetTriggered = true;
    restarts = recordRestart(await storage.get(RESTARTS_KEY), now, bringupVia);
  } else {
    if (freshBootId !== storedBootId) {
      // Only reachable when storedBootId is undefined (first-ever
      // observation) — seed the marker going forward; nothing to reset.
      await storage.put(TRANSCRIPT_BOOT_ID_KEY, freshBootId);
    }
    // Issue #56 review: a boot-id baseline now exists, so "no replacement
    // seen since" is a real fact from here on — seed the count at 0 once.
    // Until this runs the key stays absent and `fleet ls` shows "-".
    if ((await storage.get(RESTARTS_KEY)) === undefined) await storage.put(RESTARTS_KEY, { total: 0, recent: [] });
  }

  if (effectiveManifest.offset > size) {
    effectiveManifest = { ...effectiveManifest, offset: 0 }; // belt — see doc comment above
    resetTriggered = true;
  }

  if (resetTriggered) {
    // Fix round 2 (Critical residual): persist NOW, atomically — see this
    // function's own doc comment for why this cannot wait for the ship
    // block below.
    const bootIdToWrite = freshBootId !== "" ? freshBootId : storedBootId;
    if (bootIdToWrite !== undefined) {
      await storage.put({
        [TRANSCRIPT_MANIFEST_KEY]: effectiveManifest, [TRANSCRIPT_BOOT_ID_KEY]: bootIdToWrite,
        ...(restarts === undefined ? {} : { [RESTARTS_KEY]: restarts }),
      });
    } else {
      await storage.put(TRANSCRIPT_MANIFEST_KEY, effectiveManifest); // nothing meaningful known for boot-id yet
    }
  }

  let nextManifest = effectiveManifest;
  let shipped = 0;
  if (size > effectiveManifest.offset) {
    if (chunkB64 === undefined) {
      throw new Error(`transcript read failed: malformed ship-tick output (missing ${SECTION_CHUNK})`);
    }
    const bytes = base64ToBytes(chunkB64);
    if (bytes.length > 0) {
      const advanced = advance(effectiveManifest, bytes.length, now);
      await deps.r2Put(chunkKey(id, advanced.date, advanced.seq), bytes);
      await storage.put(TRANSCRIPT_MANIFEST_KEY, advanced);
      nextManifest = advanced;
      shipped = bytes.length;
    }
  }

  if (tailB64 === undefined) {
    throw new Error(`transcript hot-tail read failed: malformed ship-tick output (missing ${SECTION_TAIL})`);
  }
  await storage.put(TRANSCRIPT_TAIL_KEY, decodeTailPreview(base64ToBytes(tailB64)));

  const rotate = shouldRotate(size) && nextManifest.offset >= size;
  let rotated = false;
  if (rotate) {
    const rotateRes = await deps.exec(rotateCmd(nextManifest.offset));
    if (rotateRes.code !== 0) {
      throw new Error(`transcript rotation failed (${rotateRes.code}): ${rotateRes.stderr.slice(0, 500)}`);
    }
    rotated = parseRotateResult(rotateRes.stdout);
    if (rotated) {
      await storage.put(TRANSCRIPT_MANIFEST_KEY, { ...nextManifest, offset: 0 });
    }
  }

  return { shipped, rotated, incarnationToken, adoptionProbe, paneVerdict, paneFrame, hookHeartbeat, memguardKills };
}
