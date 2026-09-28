// Token burn monitor — pure computation only, no storage/exec/telegram I/O
// (the same "constants + math, no I/O" shape archive.ts's own header
// describes for itself). session-sync.ts is the one caller: after its own
// `syncSessionTick` ships a session tar to R2 successfully, it hands the
// SAME in-memory tar bytes to `extractJsonlMembers` here, then threads the
// result through `parseUsageIncrement` -> `rollWindow` -> `shouldAlert`,
// persisting to its own DO storage keys. do.ts wires the telegram alert.
// docs/superpowers/specs/2026-08-16-studio-memory-p2-design.md, Plane 4,
// ruling R-P2-4.
//
// R-P2-4's own text says claude's session jsonl "carries per-message
// usage/cost fields." Verified against a real session file on this machine
// (~/.claude/projects/.../*.jsonl, structure only — jq over keys, never
// printing message content, per this task's own instruction): every
// `type:"assistant"` line does carry `.message.usage` with `input_tokens`/
// `output_tokens` (plus cache/service-tier fields this feature does not
// need); NO line anywhere in that file carried a cost field at all — the
// "cost" half of R-P2-4's assumption does not hold in observed reality.
// `usage.cost_usd`/`usage.costUSD` are still tolerated below (zero when
// absent, exactly like every other field) so a future claude version that
// adds one is picked up for free, without this file needing to change.
//
// Import-safe under vitest-pool-workers (no "@cloudflare/sandbox" value
// import) — same reason every other pure P1/P2 file in this directory
// documents for itself (see e.g. transcript.ts's header).
import { BURN_WINDOW_MS } from "./archive";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-file cursor into decoded jsonl TEXT (not raw container bytes —
 * `jsonlByFile`'s values already arrive as decoded strings, extracted by
 * `extractJsonlMembers` below). `fileOffsets[file]` is a string-index offset,
 * advanced only up to the end of the LAST COMPLETE line (its trailing "\n")
 * a parse has ever seen — see `parseUsageIncrement`'s own doc comment for why
 * a trailing partial line is deliberately left unconsumed rather than
 * offset-advanced past.
 *
 * Session-sync re-tars the WHOLE session directory fresh every tick (its own
 * header: "every tick re-tars... not an offset/append scheme" — unlike
 * transcript.ts's byte-offset shipping cursor over a genuinely append-only
 * container file). So the jsonl TEXT this cursor is measured against is the
 * FULL file content each tick, and this cursor is what makes re-parsing it
 * incremental instead of re-counting every line from scratch every 300s.
 */
export type BurnCursor = {
  /**
   * Per-PATH offset, and the primary cursor: rule (c) of #154's own offset
   * rule reads it back for the very file it was written for, verified against
   * `fileHashes`. Always written, for every member of every tick.
   *
   * Issue #258 round-3 (maestro brief item 1): keyed by `pathMapKey(path)` — a
   * short structural id, not the literal in-archive path — for exactly the
   * same reason `sessions`/`lastSeenAt` already moved off their own literal
   * keys (round 2): this map is MANDATORY (rule (c) reads it back every tick,
   * for every member), so its cost scaled directly with the project-key
   * prefix's length no matter how the other maps were shrunk — measured
   * ~1.60 MB on its own at 10,000 realistic 153-char paths, already over the
   * 2 MB DO cap before `sessions`/`lastSeenAt`/`fileHashes` add a single byte.
   * See `pathMapKey`'s own doc comment for the collision-safety argument this
   * shrink required (round 2's own reviewer had left this map literal-keyed
   * specifically as a collision backstop) and the read-side dual-shape
   * fallback (`ownOffsetFor`) that makes every EXISTING literal-path-keyed
   * cursor a studio's DO storage may still hold keep resolving correctly.
   *
   * A rollback to pre-round-3 code reads this map expecting literal-path
   * keys and finds short ids instead — every entry misreads as an unrelated
   * new path and is recounted from 0 on the rollback's first tick. Over-
   * counting, the one safe direction this whole file is built around, not a
   * crash and not a silent under-count — the same one-tick cost a rollback to
   * pre-#154 code already paid for `sessions`.
   */
  fileOffsets: Record<string, number>;
  /**
   * Issue #154. The fingerprint (`prefixFingerprint`) of each path's first
   * `fileOffsets[path]` chars: the proof that the file now at that path is
   * still the one those chars were counted from. Absent for a member with no
   * session identity (`sessionKeyOf` null), and absent on every cursor
   * persisted before #154 — a missing entry is "trusted on length for one
   * tick", exactly like a hashless session entry.
   *
   * Issue #258 round-3: keyed the SAME way as `fileOffsets` (`pathMapKey`),
   * for the same reason and by the same dual-shape read fallback
   * (`ownHashFor`) — the two maps are always written by the same code, in
   * lockstep, so they are always the same generation (literal or short-id
   * keyed) for any given path at any given moment.
   */
  fileHashes?: Record<string, string>;
  /**
   * Issue #258 round-3: `pathMapKey(path)` -> `sessionMapKey(sessionKeyOf(
   * path))`, for every path with a session identity this cursor has ever
   * resolved an offset for. The ONE piece of bookkeeping `fileOffsets`'s own
   * id-keyed shrink costs elsewhere: `legacySeed`'s cross-path inheritance
   * scan (find the largest offset on ANY path of a given session) and the
   * end-of-resolveOffsets fileHashes compaction pass both used to derive a
   * session's identity straight from the literal path key
   * (`sessionKeyOf(path)`) — impossible once that key is an opaque id. This
   * map is the one place the ASSOCIATION survives the shrink, so those two
   * call sites keep working without ever decoding an id back to a path.
   *
   * Cheap relative to a full id->path reverse map: `sessionMapKey`'s own
   * output (~7-14 base-36 chars) versus a full literal path (70-150+ chars),
   * because this is genuinely all `legacySeed`/compaction ever need to know
   * about a path — WHICH session it belongs to, never the path's own text.
   * Absent for a path with no session identity (`sessionKeyOf` null) and for
   * every cursor persisted before this change — both `legacySeed` and the
   * compaction pass fall back to `sessionKeyOf` applied to the map KEY
   * directly when no entry is found here, which is exactly correct for a
   * literal-path-keyed (pre-round-3) `fileOffsets`/`fileHashes` entry and a
   * silent no-op (the key can never structurally match SESSION_PATH_RE) for a
   * genuine short id one — see `pathMapKey`'s own doc comment.
   */
  pathSession?: Record<string, string>;
  /**
   * Issue #154. INHERITANCE only, keyed by session (`sessionKeyOf`): where
   * this conversation has been counted to, whatever path it lived under at
   * the time. A transcript claude moved into a worktree project key, or the
   * adopt copied back to the root key, finds its place here — the per-path
   * offset above knows nothing about a path it has never seen.
   *
   * Issue #258 (#173 round-3 review): persisted under `sessionMapKey(key)` — a
   * short structural id, not the literal (project-prefix-stripped) session
   * key string — and each entry itself compacted to a plain wire string
   * (`encodeSessionCursor`/`decodeSessionCursor`) rather than a `{counted,
   * hash}` object. The literal key alone ran 70-90 realistic chars
   * (`<uuid>/subagents/agent-<hex>`), doubling this map's real cost on top of
   * the mandatory (rollback-read) `fileOffsets` map. This is NOT what caps
   * the DO value under 1 MB at 6,000 paths — `fileOffsets` is keyed by the
   * FULL literal path, project-key prefix included, so its cost scales with
   * that prefix's length no matter how `sessions` is encoded. The
   * "~0.95 MB" / "~1.18 MB" / "10,600-10,700 paths" numbers this paragraph
   * used to carry were the PRE-round-2 (pre-`lastSeenAt`-fix) measurement —
   * see `lastSeenAt`'s own doc comment below (round-2 review, BLOCKER 2) for
   * why they no longer held, and `fileOffsets`'s own doc comment above (round
   * 3) for why the "`fileOffsets` alone is already ~1.59 MB at 10,000, so
   * 10,000 does not fit" ceiling this paragraph used to state no longer holds
   * either — `fileOffsets` moved off literal-path keys in round 3, and current
   * measured numbers live in test/studio.burn.test.ts's own "burn cursor
   * storage" describe block (the one place to update if this ever moves
   * again), not repeated here to avoid a second copy of a number that drifts.
   * A
   * deploy that changes this encoding makes every already-tracked session
   * invisible under its OLD literal key for exactly one tick — this is not a
   * new risk: it is the SAME one-tick `legacySeed` migration #154 already
   * defined for a pre-#154 cursor's `fileOffsets`, now also covering a
   * pre-#258 cursor's `sessions`, hardened against a divergent seed by issue
   * #258's own N1 fix (see `legacySeed`'s doc comment).
   *
   * Issue #258 round-2 review (BLOCKER 1): this type says `Record<string,
   * string>` because that is all this code ever WRITES — it says nothing
   * about what a cursor written by pre-#258 code and read back on this
   * deploy's very first tick actually HOLDS: `Record<string, SessionCursor>`
   * (a plain `{counted, hash}` object per entry, keyed by the literal session
   * key). `decodeSessionCursor` is the read-side shim that tolerates both —
   * see its own doc comment for why the crash this closes was
   * FLEET-WIDE-on-deploy, not theoretical.
   */
  sessions?: Record<string, string>;
  /**
   * Issue #258 (#173 round-3 review): the wall-clock time `path` was last
   * present in ANY tick's tar, whether or not that tick counted any new
   * content from it — what `pruneCursor` reads to decide staleness. Absent
   * for a path never pruning-tracked (every cursor persisted before this
   * change): `pruneCursor` treats that as "seen right now" on first
   * encounter, never as instantly stale.
   *
   * Issue #258 round-2 review (BLOCKER 2): keyed by `pathMapKey(path)` (a
   * short structural id, not the literal path string) with the value a plain
   * epoch-SECONDS number, not an ISO string — the same "short key, compact
   * value" shrink `sessions`/`sessionMapKey` already applies, but with no
   * legacy shape to stay compatible with (this field has never shipped in any
   * deployed cursor before this same feature introduces it, unlike
   * `sessions`). The original literal-path-keyed, ISO-valued encoding was
   * measured (see test/studio.burn.test.ts's own "burn cursor storage"
   * describe block) adding enough weight on top of the mandatory
   * `fileOffsets` map to push the ACTUAL stored (post-`pruneCursor`) value
   * over the 2 MB DO cap at 6,000 realistic 76-char-project-key paths (2.17
   * MB) — a claim the pre-round-2 test never caught because it measured the
   * PRE-prune, PRE-`lastSeenAt` value instead of what `session-sync.ts`
   * actually persists.
   */
  lastSeenAt?: Record<string, number>;
};

/**
 * One session's place in its own transcript: `counted` chars consumed (always
 * the end of a COMPLETE line, exactly like the per-path offsets above), and
 * `hash` — `prefixFingerprint` over exactly those `counted` chars, the proof
 * that the file offering to resume there really is the SAME conversation and
 * not merely a file that shares its name.
 *
 * `hash === null` marks an entry seeded from a pre-#154 path-keyed cursor
 * (`legacySeed`): the offset is real but nothing was ever hashed for it, so it
 * is trusted on LENGTH only, and ONLY on its own seeding tick — `resolveOffsets`'
 * rule (h) replaces it with a real, hashed entry from that same tick's own
 * first member, even when that member's own end is LOWER than the seed's
 * counted. A hashless entry never outlives the tick it was seeded on.
 */
export type SessionCursor = { counted: number; hash: string | null };

/** One tick's worth of NEW usage, before being folded into a running `Burn`
 *  via `rollWindow`. */
export type BurnDelta = { turns: number; inputTokens: number; outputTokens: number; costUsd: number };

/**
 * Running per-studio counters, persisted in DO storage (session-sync.ts's
 * own `BURN_KEY`) and mirrored (numbers only) onto the registry's
 * `StudioStatus.burn` by do.ts's `mirrorBurnToRegistry`. `turns`/
 * `inputTokens`/`outputTokens`/`costUsd` are lifetime cumulative totals —
 * they never reset, including across a `window5hStart`/`window5hOutput`
 * roll (see `rollWindow`'s own doc comment). `window5hStart` is an ISO
 * string (this file's own `Date.toISOString()` output, never anything
 * derived from parsed jsonl content) and `window5hOutput` is the output-token
 * count accumulated since that timestamp — together, Anthropic's own
 * "5-hour rolling window" shape, tumbling (reset-on-expiry) rather than a
 * continuously-sliding average: the simplest, most testable interpretation
 * of the design's "5h rolling window" wording, and the one real Max-plan
 * usage windows already behave like.
 */
export type Burn = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  window5hStart: string;
  window5hOutput: number;
};

/** A brand new studio's starting Burn — every counter zero, window opened at
 *  `now`. Callers (session-sync.ts) use this as the fallback when DO storage
 *  has never held a `BURN_KEY` yet. */
export function freshBurn(now: Date): Burn {
  return { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, window5hStart: now.toISOString(), window5hOutput: 0 };
}

// ---------------------------------------------------------------------------
// parseUsageIncrement — tolerant, incremental jsonl usage parser
// ---------------------------------------------------------------------------

function numberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses every COMPLETE line newly appended to each file in `jsonlByFile`
 * since `prev`'s cursor, tolerantly:
 *   - a `type:"assistant"` line counts as one turn regardless of whether it
 *     carries usage at all — "turns" measures completions, not token
 *     presence.
 *   - missing/absent usage fields (no `usage` key, or individual fields
 *     absent) contribute ZERO to that line's tokens — not a parse skip.
 *   - any other recognized-but-non-usage-bearing line (user/system/summary/
 *     every other real claude-jsonl event type) contributes zero and is
 *     likewise never a skip.
 *   - a line that fails to parse as JSON at all, OR parses to something that
 *     isn't a plain object (a bare number/string/array/null) — unknown
 *     shape — is skipped and counted in `parseSkips`.
 *   - blank lines are ignored outright (ordinary trailing-newline noise).
 *
 * Incremental: for each file, only the text AFTER that file's stored offset
 * is considered, and — critically — only up through the LAST "\n" in that
 * unseen slice. A trailing line with no newline yet (an in-flight write, or
 * exactly the "mid-write snapshot loses at most the in-flight line" torn
 * tail the design's R-P2-3 describes, applied here to a growing jsonl file
 * rather than the tar snapshot itself) is left OUT of both the count and the
 * advanced offset, so it is read whole — and counted exactly once — the next
 * time a parse sees it completed. This is what makes "re-parse never
 * double-counts" hold even though session-sync ships the WHOLE file fresh
 * every tick rather than only new bytes.
 *
 * Belt: if a file's current text is SHORTER than its stored offset (the file
 * shrank or was replaced between ticks — not expected for an append-only
 * session jsonl, but never trusted blindly), that file's offset resets to 0
 * rather than throwing or slicing negative — and that reset is persisted
 * into the returned cursor IMMEDIATELY, even on a tick whose (now-reset)
 * content has no complete line yet to otherwise trigger an offset write.
 * Fix round (Important, reviewer-reproduced): the ORIGINAL version only
 * wrote the reset back once a complete line was found, so a shrink
 * immediately followed by an in-flight (no-newline-yet) tick left the STALE,
 * oversized offset sitting in the cursor — and once the file regrew past
 * it, this belt's own "current text is shorter" check stopped tripping,
 * silently skipping every real line from 0 up to the stale value, forever.
 *
 * `prev.fileOffsets` entries for files ABSENT from this tick's `jsonlByFile`
 * are carried through unchanged in the returned cursor — nothing to update,
 * and a session file legitimately never disappears mid-lifetime in practice.
 *
 * Issue #154: everything above still describes a member with NO session
 * identity (`sessionKeyOf` null) — for those, the per-path offset and its
 * shrink belt are the whole story. Every real transcript is resolved by
 * `resolveOffsets` instead, which adds per-path fingerprint VERIFICATION and
 * per-session inheritance on top, so a file that moved, was copied, was
 * re-adopted or was truncated keeps its place. #130's basename-matched
 * "sibling inherit" is subsumed by it and gone.
 */

// ---------------------------------------------------------------------------
// Issue #154: the offset rule — per-path offset VERIFIED, per-session
// INHERITED, identity taken from the tar name alone
// ---------------------------------------------------------------------------

/**
 * Issue #154. #120's sibling inherit (above) only helps when a file with the
 * same basename sits in the SAME tick, and it inherits that sibling's
 * PREVIOUS offset. Five shapes measured on a real transcript (2026-09-24,
 * claude 2.1.224) still re-counted whole conversations:
 *   - claude moves its own transcript into a worktree project key and appends
 *     before the next tick: no sibling at all (+204,602 for 3,000 new);
 *   - a tail lands, THEN the adopt copies: the sibling's previous offset is
 *     older than the tail, so the tail counts under both paths (111,428 for
 *     55,714);
 *   - an adopt copy caught mid-write stores a real 0 for its path, and a
 *     stored 0 is a HIT, so the inherit never runs again (+55,714 for 0);
 *   - a move to a second worktree after a resume (3,030 for 30);
 *   - a truncated copy landing over a counted file: shorter than what was
 *     counted, so the prefix check cannot run and the belt re-reads from 0
 *     (+201,632 for 0).
 *
 * A transcript's identity is the path it has INSIDE its project key, taken
 * from the tar member NAME and nothing else:
 *   `.claude/projects/<project-key>/<rest>.jsonl` -> `<rest>`, lowercased.
 * The project key is the part claude rewrites when a lead enters a worktree,
 * and the part the adopt copy rewrites back; `<rest>` is what survives. So:
 *   - a main transcript keys as `<session-uuid>`;
 *   - a subagent as `<session-uuid>/subagents/agent-<hex>`;
 *   - a workflow agent as `<session-uuid>/subagents/workflows/wf_<x>/agent-<hex>`.
 * Every subagent of one session therefore gets its OWN key — they are
 * separate conversations, and collapsing them onto the parent uuid (which is
 * what an in-file `sessionId` reports: 40 of 40 real subagent files carry the
 * PARENT's uuid) held the shortest one and re-counted all the others.
 *
 * The in-file `sessionId` is never consulted. Besides reporting the parent for
 * a subagent, it is content: a copy keeps the source's value, so two
 * genuinely different transcripts can carry the same one, and an in-flight
 * tar's lines may be torn. The tar NAME is known at the member header, before
 * a single content byte arrives — which is also what keeps `burnIncrement`
 * streaming.
 */
const SESSION_PATH_RE = /(?:^|\/)\.claude\/projects\/[^/]+\/(.+)\.jsonl$/;

/** The cursor key for one jsonl member, or null when the name is not a
 *  transcript under a claude project key at all (then only the per-path
 *  offset applies, which can over-count a move but never skips a line). */
function sessionKeyOf(file: string): string | null {
  const matched = SESSION_PATH_RE.exec(file);
  return matched ? matched[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// prefixFingerprint — "is this the very same prefix I already counted?"
// ---------------------------------------------------------------------------

/** Two independent 32-bit FNV-1a-style rolls; `fingerprintOf` renders them. */
const FP_INIT_A = 0x811c9dc5;
const FP_INIT_B = 0x01000193;
const FP_PRIME_A = 16777619;
const FP_PRIME_B = 2166136261;

/**
 * The two rolls as one short string. Base-36 keeps it to 15 chars at the very
 * most (two 32-bit values plus a separator), so a cursor holding one per path
 * and one per session stays far inside a DO value.
 *
 * The LENGTH is deliberately not part of the string: a fingerprint is only
 * ever compared against one taken at the same offset, and that offset is
 * stored next to it (`fileOffsets[path]`, `SessionCursor.counted`).
 *
 * Not a security hash and never used as one — it answers "is this the very
 * same prefix", and a disagreement is always resolved in the over-counting
 * direction (count from 0), never by skipping.
 */
function fingerprintOf(a: number, b: number): string {
  return `${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

/** `text`'s first `end` chars, fingerprinted. UTF-16 code units, matching
 *  every offset in this file. */
function prefixFingerprint(text: string, end: number): string {
  let a = FP_INIT_A;
  let b = FP_INIT_B;
  const stop = Math.min(end, text.length);
  for (let i = 0; i < stop; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, FP_PRIME_A);
    b = Math.imul(b ^ c, FP_PRIME_B);
  }
  return fingerprintOf(a, b);
}

// ---------------------------------------------------------------------------
// Issue #258 (#173 round-3 review): sessions map encoding — a short
// structural KEY id plus a compact wire VALUE, so `BurnCursor.sessions`
// stops doubling the mandatory `fileOffsets` map's own cost at high subagent
// counts.
// ---------------------------------------------------------------------------

/**
 * A short, stable id for a session KEY STRING (never file content — a
 * completely separate use of the same two-roll shape `prefixFingerprint`
 * uses over content). Deliberately one-way and never decoded back to `key`:
 * `resolveOffsets`/`fingerprintOffsetsFor` always have the literal `key`
 * fresh from `sessionKeyOf(member.file)` every tick and only ever need to
 * ADDRESS `sessions` with it, never enumerate its keys back into strings.
 *
 * No separator between the two rolls (unlike `fingerprintOf`): a content
 * fingerprint is rendered for a human/test to compare against a stored copy
 * at the exact same offset, but this id is opaque — nothing ever splits it
 * back into its two halves, so the byte a separator would cost is pure
 * waste. Collision odds at any subagent count this fleet has ever
 * approached are negligible (~9.8e-13 at 6,000 distinct keys, birthday
 * approximation p ~= n^2 / (2 * 2^64) over 2^64 — issue #258 round-4 review
 * (finding 4, LOW): this comment previously claimed ~2e-9 here, roughly three
 * orders of magnitude too large; the formula was always right, the arithmetic
 * plugging 6,000 into it was not) — and even a genuine collision is not silently
 * wrong: two keys landing on the same id share one inherited offset for
 * exactly one tick (the same hashless-trust-then-replace shape rule (h)
 * already gives a fresh `legacySeed`), never a permanent cross-talk, because
 * `fileOffsets`/`fileHashes` remain the source of truth rule (c) reads FIRST
 * — round 3 moved those maps onto `pathMapKey`'s own (separate) id space too,
 * but the "rule (c) is checked before any session-inherited value" ordering
 * this paragraph describes is unchanged; see `pathMapKey`'s own doc comment
 * for that id space's own, much larger-scale collision argument.
 */
function sessionMapKey(key: string): string {
  let a = FP_INIT_A;
  let b = FP_INIT_B;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, FP_PRIME_A);
    b = Math.imul(b ^ c, FP_PRIME_B);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/**
 * Issue #258 round-2 review (BLOCKER 2), elevated to load-bearing in round 3
 * (maestro brief item 1): a short, stable id for a bare tar member PATH —
 * same two-roll FNV-1a-style shape `sessionMapKey` uses over a session KEY
 * substring, applied here to the literal path string instead. One id per
 * PATH (not per session — a session can span several independently-tracked
 * paths, e.g. a worktree move or a #120 adopt copy), so `sessionMapKey(
 * sessionKeyOf(path))` would wrongly collapse those onto one shared entry.
 *
 * Round 2 kept `fileOffsets`/`fileHashes` literal-path-keyed on purpose —
 * that round's own reviewer note: "a collision elsewhere can fall back on
 * fileOffsets/fileHashes remaining literal-keyed ground truth; if fileOffsets
 * itself were also hash-keyed, a genuine collision would silently merge two
 * different files' byte offsets — the one under-count direction this file is
 * built to avoid." Round 3 revisits that call because leaving `fileOffsets`
 * literal-keyed is what kept the DO value's real ceiling near 9,000 paths
 * (measured on 2ce3b860: `fileOffsets` alone ~1.60 MB at 10,000 realistic
 * 153-char paths) — the map every rollback and every tick's rule (c) reads,
 * so shrinking every OTHER map first was never going to move that ceiling.
 *
 * The chosen fix is Option B from that brief, not Option A (a reverse
 * id->path map): a full reverse map costs the SAME bytes `fileOffsets`'s own
 * literal keys already did (a 150-char path is a 150-char path whichever map
 * it sits in) — reintroducing under a different field name the exact weight
 * this shrink exists to remove. Instead:
 *
 *  1. COLLISION MATH, shown, not asserted. Two independent 32-bit rolls give
 *     a ~64-bit id space (the concatenation has no separator — see
 *     `sessionMapKey`'s own doc comment for why — so the true space is
 *     marginally smaller than a full 2^64 for the reason a missing separator
 *     always costs some, negligible against the margins below). Birthday
 *     approximation, p ~= n^2 / (2 * 2^64), for n DISTINCT paths a fleet's
 *     `fileOffsets` map has ever tracked before `pruneCursor` sheds it (not
 *     "paths in one tick" — the map's own lifetime population, generously
 *     upper-bounded):
 *       n =  10,000 (this round's own measured ceiling target): p ~= 2.7e-12
 *       n =  20,000 (this round's own emergency-prune stress test): p ~= 1.1e-11
 *       n = 100,000 (an absurdly large single-studio fleet lifetime, never
 *                    observed): p ~= 2.7e-10
 *     Every one of these is already far below, for comparison, the rate of an
 *     uncorrected single-bit DRAM flip on ECC-less hardware over a studio's
 *     lifetime — a risk this whole system already runs on every other byte it
 *     stores, unremarked.
 *
 *  2. FAIL-SAFE, not merely rare — and, as of round 4, actually verified to
 *     hold against this map's OWN compaction pass, not just asserted. If two
 *     distinct literal paths DID collide, the SAME fingerprint-verification
 *     machinery rule (c)/(d)/the N1 fix already run for every OTHER "is this
 *     really the file I counted before" question (a move, a truncation, a
 *     re-adopt) catches it for free: file A writes its own fingerprint under
 *     the shared id; file B's own content at that same stored offset almost
 *     certainly does NOT reproduce A's fingerprint (it is different bytes),
 *     so rule (c)'s `member.fingerprintAt(stored) === want` check fails,
 *     `own` stays null, and resolveOffsets falls through to rule (g) — start
 *     at 0, count file B in FULL. Over-counting, not the silent merge round 2's
 *     reviewer was guarding against; exactly the one safe direction every
 *     other divergence in this file already resolves to. B's own write then
 *     simply overwrites A's stored offset/hash under the shared id — A's NEXT
 *     appearance sees a stored value that is either too large (the no-session
 *     length-only belt resets it to 0) or fails its OWN fingerprint check the
 *     same way, recovering the same way. Neither path is ever silently
 *     short-changed.
 *
 *     Round-4 review (finding 1): the argument above silently assumed `want`
 *     (rule (c)'s `ownHashFor` read) is always either A's real fingerprint or
 *     genuinely absent — but this map's OWN compaction pass (the loop at the
 *     end of `resolveOffsets`) deliberately strips `fileHashes[pid]` for the
 *     OVERWHELMING MAJORITY of real entries (any ordinary single-path
 *     session, on essentially every tick), so `want === undefined` no longer
 *     meant "never fingerprinted" for most of this map's population — it also
 *     meant "compacted, reconstructable in principle". Rule (c) used to trust
 *     the stored offset by LENGTH ALONE whenever `want` came back undefined
 *     for ANY reason, which — for a collision landing on a compacted,
 *     single-path id — meant zero content verification at all: a real,
 *     silent under-count, exactly the failure mode literal-path-keying was
 *     required to prevent. Fixed by giving rule (c) a way to tell the two
 *     `want === undefined` causes apart: `pathSession[pid]` is written
 *     unconditionally by every tick that resolves `pid` under round-3 code
 *     (rule (h) below) and is never cleared by compaction, so its PRESENCE in
 *     `prev.pathSession` now means "a real fingerprint exists for this id
 *     somewhere, it is just unreadable from here" — length-only trust is only
 *     taken when `prev.pathSession[pid]` is ALSO absent, i.e. `pid` has never
 *     been resolved under round-3 code at all (a still-literal pre-#154
 *     entry, reached only through `ownOffsetFor`'s own literal-key fallback).
 *     See rule (c)'s own comment for the exact branch. This also closes round
 *     2's own LOW-4 disclosure (a multi-path session's sibling advancing past
 *     a compacted path's stored offset) as a side effect, for the same reason.
 *
 *     The one genuine remaining gap: a member with NO session identity
 *     (`sessionKeyOf` null) has no fingerprint at all — pre-#154's "trust
 *     stored offset on length alone" belt is the whole story for it (see
 *     `resolveOffsets`' own key === null branch, which has no `pathSession`
 *     to consult either), so a collision landing on two SUCH paths could in
 *     principle under-count via that belt rather than fail safe. Accepted,
 *     not fixed: every path this feature has ever observed in practice
 *     matches `.claude/projects/<key>/<rest>.jsonl` (session-identified) —
 *     `readJsonlMembersFromTar`'s own real-fixture surface — so `key === null`
 *     paths are not a population this map's realistic collision math above
 *     even applies over, and the odds already sit below routine hardware
 *     error rates regardless.
 *
 * `fileOffsets`/`fileHashes`/`pathSession` all key off this SAME id — one
 * function, one id space, shared across the maps that used to each pay their
 * own literal-path cost separately. See `BurnCursor.fileOffsets`'s own doc
 * comment for the read-side dual-shape fallback (`ownOffsetFor`/
 * `ownHashFor`) that keeps a pre-round-3 (literal-keyed) cursor still
 * fully correct across the one migration tick, and `legacySeed`'s doc
 * comment for how its own cross-path scan handles both key generations.
 */
function realPathMapKey(path: string): string {
  let a = FP_INIT_A;
  let b = FP_INIT_B;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    a = Math.imul(a ^ c, FP_PRIME_A);
    b = Math.imul(b ^ c, FP_PRIME_B);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

// Issue #258 round-4 review (finding 2): a real collision is, by this file's
// own math above, never going to happen from an actual test picking literal
// path strings — the whole point of the birthday bound is that it can't be
// brute-forced in a test suite's lifetime either. `pathMapKeyImpl` is the
// seam that lets a test FORCE one instead of merely asserting the math: every
// internal caller in this file (resolveOffsets, ownOffsetFor, ownHashFor,
// pruneCursor, pruneCursorForSize) always calls the exported `pathMapKey`
// wrapper below, never this variable directly, so replacing it via
// `__setPathMapKeyForTest` changes what EVERY one of those callers sees for
// the lifetime of the override — exactly what proving the fail-safe path
// against a genuine collision requires. Production code never calls the
// setter, so `pathMapKeyImpl` is always `realPathMapKey` outside a test that
// explicitly opts in.
let pathMapKeyImpl: (path: string) => string = realPathMapKey;

export function pathMapKey(path: string): string {
  return pathMapKeyImpl(path);
}

/**
 * TEST-ONLY seam (see `pathMapKeyImpl`'s own comment) — forces every
 * `pathMapKey` call in this module to run through `fn` instead of the real
 * hash, or restores the real hash when called with `null`. A test MUST
 * restore the real implementation (a `finally` block, not just the end of the
 * test body) before the next test runs, since this is a module-level
 * singleton shared across the whole test file's imports.
 */
export function __setPathMapKeyForTest(fn: ((path: string) => string) | null): void {
  pathMapKeyImpl = fn ?? realPathMapKey;
}

/** `SessionCursor` as the single wire string persisted in `BurnCursor.
 *  sessions` — `"<counted>:<hash-or-empty>"`. `counted` is decimal digits
 *  only (never contains ":"), so the FIRST ":" unambiguously ends it even
 *  though `hash` (a `fingerprintOf` string) contains one of its own. */
function encodeSessionCursor(s: SessionCursor): string {
  return `${s.counted}:${s.hash ?? ""}`;
}

/**
 * Inverse of `encodeSessionCursor` — a READ-SIDE compatibility shim, not just
 * a pure inverse. `s: unknown`, not `string`: `BurnCursor.sessions`'s
 * declared `Record<string, string>` type describes what THIS code has ever
 * WRITTEN, never what an already-deployed studio's DO storage necessarily
 * holds. Issue #258 round-2 review, BLOCKER 1: every cursor a studio wrote
 * BEFORE this encoding-shrink deploy still carries the pre-#258 shape — a
 * plain `{counted, hash}` OBJECT, keyed by the literal session key string,
 * not `sessionMapKey`'s short id. The very first tick after deploy that
 * reads such an entry through a decoder assuming a string (`s.indexOf`, a
 * TypeError on a plain object) crashed inside `resolveOffsets`'s own eager
 * decode loop, before any per-member logic ran — session-sync.ts's own
 * `parseBurn` catch swallows it silently, so burn counting stopped
 * FLEET-WIDE on deploy with no signal. Fixed by branching on the runtime
 * shape actually seen, exactly as `resolveOffsets` itself does not need to
 * change: a legacy object decodes straight into the same `SessionCursor`
 * shape (missing/malformed fields fall back to the same "nothing to trust
 * yet" `{counted: 0, hash: null}` a corrupt/foreign string already did) —
 * `sessionMapKey` never applied to ITS key in the first place, so a decoded
 * legacy entry simply never matches any CURRENT tick's `sessionMapKey(key)`
 * lookup and is superseded by `legacySeed` (which reads `prev.fileOffsets`
 * directly, untouched by this whole encoding question) exactly the same way
 * a pre-#154 cursor already was — one migration tick, not a rewrite.
 * `encodeSessionCursor` (the WRITE side) stays string-only: every entry this
 * code touches is rewritten in the new format the very next tick that
 * touches it (rule (h) in `resolveOffsets`), so a legacy entry is never
 * written back out.
 */
function decodeSessionCursor(s: unknown): SessionCursor {
  if (typeof s === "object" && s !== null) {
    const obj = s as Record<string, unknown>;
    const counted = typeof obj.counted === "number" && Number.isFinite(obj.counted) ? obj.counted : 0;
    const hash = typeof obj.hash === "string" ? obj.hash : null;
    return { counted, hash };
  }
  if (typeof s !== "string") return { counted: 0, hash: null };
  const sep = s.indexOf(":");
  if (sep === -1) return { counted: 0, hash: null };
  const counted = Number.parseInt(s.slice(0, sep), 10);
  const hash = s.slice(sep + 1);
  return { counted: Number.isFinite(counted) ? counted : 0, hash: hash === "" ? null : hash };
}

/**
 * Issue #258 round-3: reads `prev.fileOffsets` for the literal path `file`,
 * trying the CURRENT (`pathMapKey(file)`) key first and falling back to the
 * literal `file` string itself when that misses — the one-tick dual-shape
 * read every call site that used to do a bare `prev.fileOffsets[file]` now
 * goes through, so a cursor a studio's DO storage already holds from BEFORE
 * this shrink (literal-path-keyed) keeps resolving exactly as it did, with no
 * separate migration pass. The two key shapes can never collide with each
 * other by construction: `pathMapKey`'s output is base-36 (`[0-9a-z]+`) only,
 * while every real path this file ever sees contains at least one `.`/`/`
 * (a `.jsonl` suffix, a directory separator, or both) — so trying the id
 * first is never ambiguous with a literal hit.
 */
function ownOffsetFor(prev: BurnCursor, file: string): number | undefined {
  const byId = prev.fileOffsets[pathMapKey(file)];
  return byId !== undefined ? byId : prev.fileOffsets[file];
}

/** `ownOffsetFor`'s own twin for `fileHashes` — same dual-shape read, same
 *  reasoning; the two maps are always written together so they are always
 *  the same generation for a given path at a given moment. */
function ownHashFor(prev: BurnCursor, file: string): string | undefined {
  const byId = prev.fileHashes?.[pathMapKey(file)];
  return byId !== undefined ? byId : prev.fileHashes?.[file];
}

// ---------------------------------------------------------------------------
// resolveOffsets — the ONE implementation of #154's offset rule
// ---------------------------------------------------------------------------

/**
 * What the offset rule needs to know about one jsonl member of this tick.
 * Deliberately measurements only, never the member's text: this is the
 * interface `burnIncrement` can satisfy while STREAMING (issue #176 — a
 * member's whole text must never be in memory), and `parseUsageIncrement`
 * satisfies from the text it already holds. One rule, one set of numbers, so
 * the two can never disagree.
 */
type MemberFacts = {
  /** The tar member name, as stored in `fileOffsets`. */
  file: string;
  /** `sessionKeyOf(file)`. */
  key: string | null;
  /** Length in UTF-16 code units. */
  length: number;
  /** Offset just past the member's LAST "\n" — 0 when it has none. Every
   *  offset this rule ever stores is one of these (a complete-line boundary),
   *  which is what leaves a torn trailing line to be counted once, later. */
  endOfComplete: number;
  /** `prefixFingerprint(text, offset)`, or null when this tick did not compute
   *  one at `offset` (the streaming pass only computes the offsets the rule can
   *  ask about). */
  fingerprintAt: (offset: number) => string | null;
};

/** Where each member starts counting this tick, and the cursor that follows. */
type ResolvedOffsets = { starts: Map<string, number>; cursor: BurnCursor };

/**
 * Migration off a pre-#154 cursor (rule i) OR a pre-#258 `sessions` encoding
 * (see `BurnCursor.sessions`'s own doc comment): the largest offset the
 * prior code left on ANY path of this same session, PLUS which path
 * contributed it. Read only when the session has no entry of its own under
 * the CURRENT encoding, so a studio mid-conversation neither re-counts its
 * transcript (a burn spike) nor jumps past lines it never counted.
 *
 * Issue #258 N1 (#173 round-3 review): the winning offset used to be trusted
 * on LENGTH ALONE, with no content check at all — a NEW same-key path whose
 * bytes at `best` have genuinely DIVERGED from the ones `sourcePath` was
 * actually counted against (not a continuation, a different conversation
 * that happens to reuse an old offset number) was trusted anyway,
 * under-counting (the review's own shorthand: "10 vs main 50"). `sourcePath`
 * is reported here so the CALLER (`resolveOffsets`, the only place with the
 * current member's own `fingerprintAt`) can verify it against
 * `prev.fileHashes[sourcePath]` when one survives, falling through to a full
 * recount (rule (g), the safe direction) on a mismatch — legacySeed itself
 * stays a pure "what and where", never touching a member's content.
 *
 * A genuinely pre-#154 cursor never carries `fileHashes` at all, so this
 * verification is a pure no-op for that original migration shape —
 * `sourceHash` is undefined and the seed is trusted on length exactly as
 * before this fix. It only bites for a MIXED-version seed moment: exactly
 * what this file's own #258 `sessions`-encoding change produces on its own
 * deploy tick, where `fileOffsets`/`fileHashes` are already real (post-#154)
 * but `sessions` is momentarily unreadable under its new key.
 *
 * Issue #258 round-3 (maestro brief item 1): renamed `sourcePath` ->
 * `sourceId` and the scan itself now runs over `prev.fileOffsets`'s KEYS
 * exactly as they are stored, WITHOUT decoding any of them back to a literal
 * path — `fileOffsets` is short-id-keyed now (see that field's own doc
 * comment), so this scan can no longer call `sessionKeyOf` on a stored key
 * expecting a literal path. Two generations of key can appear in the SAME
 * `prev.fileOffsets`, entry by entry, during the one-tick migration window:
 *   - a CURRENT (short-id) key: `prev.pathSession[key]` holds exactly the
 *     `sessionMapKey` this path was last resolved for (`resolveOffsets`
 *     writes both together, every tick) — compared directly, no decode;
 *   - a LEGACY (pre-round-3, literal-path) key: absent from `pathSession`
 *     (that map never existed before this round), so the key ITSELF is tried
 *     as a literal path via `sessionKeyOf` — exactly the pre-round-3 scan,
 *     preserved for the one migration tick a studio's existing DO storage
 *     still needs it.
 * `sourceId` — whichever of the two shapes won — is handed back to the
 * caller UNCHANGED as the key to read `prev.fileHashes` with: `fileOffsets`
 * and `fileHashes` are always written together by the same code, so they are
 * always the same generation for a given entry, and `sourceId` needs no
 * translation to address the matching `fileHashes` entry either way.
 */
function legacySeed(prev: BurnCursor, key: string): { counted: number; hash: string | null; sourceId: string | null } {
  let best = 0;
  let sourceId: string | null = null;
  const mapKey = sessionMapKey(key);
  for (const [id, offset] of Object.entries(prev.fileOffsets)) {
    const belongs = prev.pathSession?.[id] !== undefined
      ? prev.pathSession[id] === mapKey
      : sessionKeyOf(id) === key; // legacy literal-path-keyed entry
    if (belongs && offset > best) {
      best = offset;
      sourceId = id;
    }
  }
  return { counted: best, hash: null, sourceId };
}

/**
 * #154's offset rule, in full. Per-path offset is PRIMARY; the session entry
 * is INHERITANCE only. For every member of this tick, in an order that
 * resolves a longer copy before any copy it covers:
 *
 *  (a) group by key; inside a key, longest complete content first, ties in tar
 *      order — so a coverer is always decided before the member it covers.
 *  (b) COVERED: an earlier member of the same key, at least as long, with the
 *      same chars up to my own end of complete lines. Those lines were counted
 *      moments ago under the other path. Start at my end, count nothing.
 *  (c) OWN: my stored path offset `o`, when the file is at least that long and
 *      its first `o` chars still fingerprint the same. A stored offset with no
 *      fingerprint (pre-#154, or pre-#154-seeded) is trusted on length alone.
 *  (d) SESSION: the key's `{counted, hash}`, when the file is at least
 *      `counted` long and fingerprints the same there (hashless: length).
 *  (e) start = max(own, session) whenever either answered.
 *  (f) neither, and the file is SHORTER than `counted`: a truncated copy — a
 *      re-adopt, or a tar taken mid-copy. Its lines are already in the totals,
 *      so hold at my end of complete lines and count nothing. The path offset
 *      and fingerprint are stored THERE, so whatever is appended to this copy
 *      later is counted via rule (c) even though `counted` still runs ahead.
 *  (g) neither otherwise: new content, or a genuine divergence the fingerprint
 *      rejected. Start at 0 and count in FULL — the over-counting direction,
 *      the only safe one.
 *  (h) after counting: the path keeps `{end, fingerprint(end)}`; the session
 *      takes them when `end` is past `counted` (or equal, replacing a hashless
 *      entry). `counted` is never lowered.
 *
 * Under-count safety: every resume past 0 is either a fingerprint match at
 * exactly that offset, or (b)'s same-tick coverage, or (f)'s hold — and (f)
 * holds at MY OWN end of complete lines, never at the session's higher
 * `counted`, so an append to a truncated copy is counted rather than waiting
 * for the file to grow past a number it may never reach.
 */
function resolveOffsets(prev: BurnCursor, members: MemberFacts[]): ResolvedOffsets {
  const fileOffsets: Record<string, number> = { ...prev.fileOffsets };
  const fileHashes: Record<string, string> = { ...(prev.fileHashes ?? {}) };
  // Issue #258 round-3: which session (as a `sessionMapKey` id) each path's
  // OWN `pathMapKey` id belongs to — see `BurnCursor.pathSession`'s own doc
  // comment. Carried forward and extended below, never decoded back to a
  // literal path.
  const pathSession: Record<string, string> = { ...(prev.pathSession ?? {}) };
  // Issue #258: `prev.sessions` is the WIRE form (mapKey -> compact string) —
  // decode once into the logical shape every rule below already expects,
  // still keyed by `sessionMapKey`'s opaque id (nothing here ever needs the
  // literal session key string back out of it).
  const sessions: Record<string, SessionCursor> = {};
  for (const [mapKey, encoded] of Object.entries(prev.sessions ?? {})) sessions[mapKey] = decodeSessionCursor(encoded);
  const starts = new Map<string, number>();

  // (a). A plain string compare, not localeCompare: the order must be the same
  // number in every runtime this file is parsed by (workerd, bun, node).
  const ordered = members.map((member, order) => ({ member, order })).sort((x, y) => {
    const xk = x.member.key ?? "";
    const yk = y.member.key ?? "";
    if (xk !== yk) return xk < yk ? -1 : 1;
    if (x.member.endOfComplete !== y.member.endOfComplete) return y.member.endOfComplete - x.member.endOfComplete;
    return x.order - y.order;
  });

  const done: MemberFacts[] = [];
  for (const { member } of ordered) {
    const { file, key, length, endOfComplete: myEnd } = member;
    // Issue #258 round-3: this path's own short id — the wire key `fileOffsets
    // `/`fileHashes`/`pathSession` all use, computed once per member from the
    // literal path this tick's tar always hands us. Never decoded back.
    const pid = pathMapKey(file);
    let start: number;

    if (key === null) {
      // No session identity: the pre-#154 per-path offset and its shrink
      // belt. `?? fileOffsets[file]`: the dual-shape read for a pre-round-3
      // (literal-path-keyed) entry — see `ownOffsetFor`'s own doc comment;
      // inlined here rather than calling it, since the working copy (not
      // `prev` directly) is what a same-tick id collision needs consulted —
      // see `pathMapKey`'s own fail-safe argument.
      const stored = fileOffsets[pid] ?? fileOffsets[file] ?? 0;
      start = stored > length ? 0 : stored;
    } else {
      const mapKey = sessionMapKey(key);
      const seeded = sessions[mapKey];
      let entry: SessionCursor;
      if (seeded) {
        entry = seeded;
      } else {
        // Issue #258 N1: verify the migration seed against the content its
        // winning offset actually came from, when a fingerprint for that
        // source path survives — see legacySeed's own doc comment.
        const seed = legacySeed(prev, key);
        const sourceHash = seed.sourceId !== null ? prev.fileHashes?.[seed.sourceId] : undefined;
        const verified = seed.counted === 0 || sourceHash === undefined ||
          member.fingerprintAt(seed.counted) === sourceHash;
        entry = verified ? { counted: seed.counted, hash: seed.hash } : { counted: 0, hash: null };
      }

      // (b)
      const covered = done.some((other) =>
        other.key === key && other.endOfComplete >= myEnd &&
        other.fingerprintAt(myEnd) === member.fingerprintAt(myEnd));

      // (c). `ownOffsetFor`/`ownHashFor`: `prev` itself, not the working
      // copy — this path's own stored record from BEFORE this tick, exactly
      // as before round 3, just id-keyed with a literal-key fallback now.
      let own: number | null = null;
      const stored = ownOffsetFor(prev, file);
      if (stored !== undefined && length >= stored) {
        let want = ownHashFor(prev, file);
        // Issue #258: this path's own fingerprint may have been deliberately
        // OMITTED at persist time because it was reconstructable from the
        // session's own inheritance record at this very offset (see the
        // compaction pass below) — recover it here instead of falling
        // through to blind trust-by-length.
        if (want === undefined && seeded && seeded.hash !== null && seeded.counted === stored) want = seeded.hash;
        // Issue #258 round-4 review (finding 1): `want` staying undefined
        // used to mean ONE thing — "no fingerprint was ever computed for
        // this id, trust the stored length" — but round 3's own compaction
        // pass (below) made it ambiguous: a compacted id ALSO reads back as
        // `want === undefined` once its session-reconstruction line above
        // fails to confirm it (a sibling path advanced the session past this
        // one, or `pid` is a genuine `pathMapKey` collision with a wholly
        // unrelated id whose entry does not belong to this path at all).
        // Blindly trusting THAT case by length is exactly the silent
        // under-count `pathMapKey`'s own doc comment used to claim couldn't
        // happen. `prev.pathSession[pid]` is the discriminator: it is set,
        // unconditionally, every tick ANY id is resolved under round-3 code
        // (rule (h) below) and is NEVER cleared by the compaction pass — so
        // its presence means "this id has a real fingerprint history that is
        // merely unreadable from here", not "no fingerprint ever existed".
        // Only a `pid` truly untouched by round-3 (a still-literal pre-#154
        // entry, reached here via `ownOffsetFor`'s own literal-key fallback)
        // gets the length-only belt; every other undefined `want` now falls
        // through to (f)/(g) instead — full recount, the safe direction.
        if (want !== undefined) {
          if (member.fingerprintAt(stored) === want) own = stored;
        } else if (prev.pathSession?.[pid] === undefined) {
          own = stored;
        }
      }

      // (d). A hashless entry (legacy, no verified fingerprint) is trusted
      // on length ONLY on the tick it was just seeded (prev.sessions had no
      // entry for this key yet, so `entry` came from legacySeed this tick,
      // not from a stored prior tick's own decision). Every later tick, a
      // hashless entry is used only through rule (f)'s hold, never (d)'s
      // trust. This gate is now a BELT, not the real fix: rule (h) below
      // makes a hashless seed never outlive its own seeding tick at all
      // (replaced by the first member's verified {end, hash} that tick, even
      // when lower) — so by the time a LATER tick could reach this gate, a
      // hashless `entry.hash` should no longer be possible. Kept for the
      // case where no member reaches (h)'s replacement on the seeding tick
      // either (every member of that key is still held by rule (f)).
      let viaSession: number | null = null;
      if (entry.counted > 0 && length >= entry.counted &&
          (entry.hash === null ? prev.sessions?.[mapKey] === undefined : member.fingerprintAt(entry.counted) === entry.hash)) {
        viaSession = entry.counted;
      }

      if (covered) start = myEnd;
      else if (own !== null || viaSession !== null) start = Math.max(own ?? 0, viaSession ?? 0); // (e)
      else if (entry.counted > 0 && length < entry.counted) start = myEnd; // (f)
      else start = 0; // (g)

      sessions[mapKey] = entry; // present from here on, so (i)'s seed runs once
      // Issue #258 round-3: record which session THIS path's id belongs to,
      // every tick, unconditionally — `legacySeed`'s cross-path scan and the
      // compaction pass below both read this back instead of decoding `pid`.
      pathSession[pid] = mapKey;
    }
    done.push(member);

    // Only complete lines are ever consumed, so the new offset is this
    // member's last line end — unless `start` already sits past it (nothing
    // complete beyond where counting begins), in which case it does not move.
    const end = Math.max(start, myEnd);
    starts.set(file, start);
    fileOffsets[pid] = end; // (j)

    if (key !== null) {
      const mapKey = sessionMapKey(key);
      // (h). Always one of the offsets the streaming pass fingerprinted (0,
      // the stored path offset, the session's `counted`, or this member's own
      // end of complete lines), so this is never null in practice.
      const print = member.fingerprintAt(end);
      if (print !== null) fileHashes[pid] = print;
      const entry = sessions[mapKey]!;
      // A hashless seed (entry.hash === null) is replaced unconditionally by
      // THIS member's own verified {end, print}, even when end is LOWER than
      // the legacy seed's counted — the seed never outlives its own seeding
      // tick, full stop. Without this, a key whose seeding tick holds every
      // member at rule (f) (none reaches the legacy `counted`) keeps the
      // stale, unverified seed alive forever: a later NEW path for that same
      // session can never inherit through it via (d) (which only trusts a
      // hashless seed on ITS seeding tick, per that rule's own comment), and
      // rule (f) holds it too — the lines between are silently lost, an
      // under-count. Once real (a genuine tick actually reached this
      // branch), the normal `end > entry.counted` growth check applies.
      if (end > entry.counted || entry.hash === null) {
        sessions[mapKey] = { counted: end, hash: print };
      }
    }
  }

  // Issue #258: drop a per-path fingerprint that is provably reconstructable
  // from its session's own inheritance record at the exact same offset — see
  // rule (c)'s own fallback above, which recovers it on the next read. This,
  // together with the `sessions` map's own short-id encoding and (round 3)
  // `fileOffsets`/`fileHashes` themselves moving off literal-path keys, is
  // what keeps the persisted cursor's per-path cost roughly constant instead
  // of scaling with the project-key prefix's length — see
  // test/studio.burn.test.ts's own "burn cursor storage" describe block (the
  // one place to update if this ever moves again) for current measured
  // numbers.
  //
  // Round 3: the KEY here (`path`, below) is `fileHashes`'s own wire key —
  // `pid` (a short id) for anything resolved this tick, possibly still a
  // literal path for a pre-round-3 entry this tick never touched. Deriving
  // its session id therefore prefers `pathSession[path]` (correct for a
  // short id) and falls back to `sessionKeyOf(path)` treated as a literal
  // path (correct for a legacy entry, and a guaranteed no-op for a genuine
  // short id, which can never structurally match SESSION_PATH_RE).
  //
  // Issue #258 round-2 review (LOW 4) / round-4 review (finding 1), FIXED as
  // of round 4: "provably reconstructable" above is not quite unconditional
  // for a multi-path session. Rule (c)'s fallback that recovers a compacted
  // fingerprint (`seeded.counted === stored`, above) only fires when the
  // session's OWN inherited `counted` still equals THIS path's stored offset —
  // true on the tick this path was compacted, but a SIBLING path under the
  // same session key can later advance `counted` past this path's own offset
  // (round-2's LOW-4 case), or an unrelated id can collide with this one on
  // `pathMapKey` (round-4's finding 1, the more severe case: no sibling
  // needed, and the "same length" belt alone let it inherit an unrelated
  // path's offset with zero content check). Both leave `want` undefined for a
  // reason OTHER than "never fingerprinted". Rule (c) no longer treats every
  // undefined `want` as license to trust by length: it now also consults
  // `prev.pathSession[pid]` (set unconditionally whenever `pid` is resolved
  // under round-3 code, never cleared by this very compaction pass) to tell
  // "compacted or collided, do not trust" apart from "genuinely never
  // fingerprinted, pre-#154, length-only is the whole story it ever had". See
  // rule (c)'s own comment and `pathMapKey`'s doc comment (fail-safe section)
  // for the full argument. Compaction itself is unchanged — this was a read-
  // side gap, not a reason to give back the byte savings.
  for (const path of Object.keys(fileHashes)) {
    const literalKey = pathSession[path] === undefined ? sessionKeyOf(path) : null;
    const mapKey = pathSession[path] ?? (literalKey !== null ? sessionMapKey(literalKey) : undefined);
    if (mapKey === undefined) continue;
    const entry = sessions[mapKey];
    if (entry && entry.hash !== null && entry.hash === fileHashes[path] && entry.counted === fileOffsets[path]) {
      delete fileHashes[path];
    }
  }

  const encodedSessions: Record<string, string> = {};
  for (const [mapKey, entry] of Object.entries(sessions)) encodedSessions[mapKey] = encodeSessionCursor(entry);

  return { starts, cursor: { fileOffsets, fileHashes, sessions: encodedSessions, lastSeenAt: prev.lastSeenAt, pathSession } };
}

/**
 * Every offset `resolveOffsets` can ask a member about BEFORE the tick's own
 * measurements exist — the stored path offset and the session's `counted`
 * (seeded from a legacy cursor when the session has no entry yet). Both come
 * from `prev` alone, so `burnIncrement`'s first streaming pass knows them at
 * the member header and can fingerprint them as the content flows past.
 *
 * The remaining offsets the rule uses are the member's own end of complete
 * lines (free — the running fingerprint is snapshotted at every "\n") and, for
 * rule (b) only, a SIBLING's end of complete lines, which is not known until
 * every member has been measured.
 */
function fingerprintOffsetsFor(prev: BurnCursor, file: string, key: string | null): number[] {
  const wanted = new Set<number>([0]);
  const stored = ownOffsetFor(prev, file);
  if (stored !== undefined && stored > 0) wanted.add(stored);
  if (key !== null) {
    const encoded = prev.sessions?.[sessionMapKey(key)];
    const entry = encoded !== undefined ? decodeSessionCursor(encoded) : legacySeed(prev, key);
    if (entry.counted > 0) wanted.add(entry.counted);
  }
  return [...wanted].sort((x, y) => x - y);
}

export function parseUsageIncrement(
  prev: BurnCursor,
  jsonlByFile: Map<string, string>,
): { cursor: BurnCursor; delta: BurnDelta; parseSkips: number; presentPaths: Set<string> } {
  const acc = { delta: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } as BurnDelta, parseSkips: 0 };

  // The whole text is right here, so every fingerprint is computed on demand —
  // burnIncrement is the one that has to earn them a slice at a time.
  const members: MemberFacts[] = [...jsonlByFile].map(([file, text]) => ({
    file,
    key: sessionKeyOf(file),
    length: text.length,
    endOfComplete: text.lastIndexOf("\n") + 1,
    fingerprintAt: (offset: number) => prefixFingerprint(text, offset),
  }));
  const { starts, cursor } = resolveOffsets(prev, members);

  for (const [file, text] of jsonlByFile) {
    const startAt = starts.get(file) ?? 0;
    const unseen = text.slice(startAt);
    const lastNewline = unseen.lastIndexOf("\n");
    if (lastNewline === -1) continue; // nothing complete past the start this tick
    const complete = unseen.slice(0, lastNewline);
    if (complete.length === 0) continue;

    for (const line of complete.split("\n")) countUsageLine(line, acc);
  }

  // Issue #258: every member of THIS tick's tar, whether or not resolveOffsets
  // found anything new to count for it — what pruneCursor (below) needs to
  // refresh a path's lastSeenAt, distinct from a path merely absent from a
  // stale prior lastSeenAt. burnIncrement's own streaming pass reports the
  // identical set (see its own doc comment) so the two can never disagree.
  return { cursor, delta: acc.delta, parseSkips: acc.parseSkips, presentPaths: new Set(jsonlByFile.keys()) };
}

/** One complete jsonl line's usage, the rules parseUsageIncrement documents.
 *  Shared with burnIncrement, so the two can never count differently. */
function countUsageLine(line: string, acc: { delta: BurnDelta; parseSkips: number }): void {
  if (line.trim() === "") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    acc.parseSkips++;
    return;
  }
  if (!isPlainObject(parsed)) {
    acc.parseSkips++;
    return;
  }
  if (parsed.type !== "assistant") return; // valid, just not usage-bearing — zeros, no skip

  acc.delta.turns++;
  const message = isPlainObject(parsed.message) ? parsed.message : undefined;
  const usage = message && isPlainObject(message.usage) ? message.usage : undefined;
  if (usage) {
    acc.delta.inputTokens += numberOr0(usage.input_tokens);
    acc.delta.outputTokens += numberOr0(usage.output_tokens);
    acc.delta.costUsd += numberOr0(usage.cost_usd ?? usage.costUSD);
  }
}

// ---------------------------------------------------------------------------
// Issue #258 (#173 round-3 review): pruning — a burnCursor entry is never
// dropped once written, so a fleet that spawns one subagent after another
// grows the persisted cursor forever (measured: 1.77 MB at 5,000 paths, the
// 2 MB DO value cap reached near ~5,900). `pruneCursor` is the fix: called
// by session-sync.ts once per tick (never from resolveOffsets itself, which
// stays a pure function of `prev` + this tick's own members, with no `now`
// of its own — matching every other pure function in this file).
// ---------------------------------------------------------------------------

/**
 * How long a path may sit ABSENT from every tick's tar before `pruneCursor`
 * drops it — wall-clock, never a raw tick count (this fleet's own ticks have
 * stalled for 20+ minutes at a time; session-sync.ts's own tarAndStatCmd doc
 * comment records it). Set well clear of
 * `SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS` (archive.ts, 86_400s = 24h) —
 * the worst-case stretch session-sync.ts's own three-admission-rule budget
 * can cycle a LIVE subagent out of a tick's tar before it is guaranteed to
 * reappear. 48h gives a full extra day of margin over that 24h ceiling, so a
 * path merely being squeezed out tick-to-tick by the budget rule is NEVER
 * pruned while its session is still live — only a path absent for two
 * genuinely idle days (the session actually ended, or claude's own 30-day
 * transcript cleanup — `SESSION_CLEANUP_MS` below — already removed it) is
 * ever dropped.
 *
 * Issue #258 round-2 review (LOW, accepted): a subagent transcript pruned
 * after a genuine >= 48h idle stretch and then RESUMED at the same literal
 * path (claude reviving/continuing an old subagent) has no cursor left at
 * all — `resolveOffsets` sees a brand-new path and recounts its entire
 * (already-once-counted) history from 0, a one-time burn spike rather than a
 * silent under-count. Accepted, not fixed: consistent with every other
 * "resolve a divergence by recounting in full" rule in this file (e.g. rule
 * (g) above — over-counting is always the safe direction here, never
 * skipping), and the 48h margin already makes this a genuinely rare edge
 * case (a subagent idle two full days, then reused) rather than a routine
 * one. A future fix, if this proves to matter in practice, would persist a
 * pruned path's last known offset/hash under its SESSION key (not its
 * literal path) so a resume could still inherit through `legacySeed`'s own
 * mechanism — out of scope for this round.
 */
export const CURSOR_PRUNE_MS = 48 * 3_600_000;

/**
 * Drops `fileOffsets`/`fileHashes`/`sessions`/`pathSession` entries for a path
 * absent from `presentPaths` (this tick's own tar member names) for at least
 * `CURSOR_PRUNE_MS` of wall-clock time, tracked per-path (via `pathMapKey`) in
 * `lastSeenAt` (never a counter — see `CURSOR_PRUNE_MS`'s own doc comment). A
 * path in `presentPaths` always has its `lastSeenAt` entry refreshed to `now`
 * (epoch seconds), regardless of whether this tick counted any new content
 * from it. A path with no `lastSeenAt` entry yet (every cursor persisted
 * before this change) is treated as "seen right now" on its first encounter
 * here — never pruned on the very tick pruning itself first runs.
 *
 * Issue #258 round-3: `cursor.fileOffsets`'s own KEYS are the id space this
 * loop iterates directly (`pkey`, below), never a literal path decoded back
 * out of one — `presentPaths` (always literal, straight from the tar) is
 * converted to the SAME id space up front (`presentIds`) so the membership
 * check compares like with like. A key that is still a PRE-round-3 literal
 * path (a cursor this fix hasn't fully migrated yet) can never appear in
 * `presentIds` (which only ever holds `pathMapKey` output), so it reads as
 * "absent" and starts its own 48h countdown the same as any other stale
 * entry — self-cleaning, no special migration case needed here.
 *
 * A session's `sessions` entry is dropped once every path referencing its
 * key has been pruned — the inheritance record is meaningless once nothing
 * is left to inherit through it, and it would otherwise linger forever
 * (nothing else ever removes a `sessions` entry). Issue #258 round-3: which
 * session a surviving path belongs to comes from `cursor.pathSession[pkey]`
 * when present (a short id, current-format entry), falling back to
 * `sessionKeyOf(pkey)` treated as a literal path for a pre-round-3 entry —
 * the same dual-shape reasoning `resolveOffsets`'s own compaction pass uses.
 *
 * Pure — no I/O, matching every other function in this file. session-sync.ts
 * calls this once per tick, after `burnIncrement` returns, over the SAME
 * tar's own present paths (`presentPaths` on `burnIncrement`'s own result).
 */
export function pruneCursor(cursor: BurnCursor, presentPaths: ReadonlySet<string>, now: Date): BurnCursor {
  const nowMs = now.getTime();
  const nowSec = Math.floor(nowMs / 1000);
  const lastSeenAt: Record<string, number> = { ...(cursor.lastSeenAt ?? {}) };
  const fileOffsets: Record<string, number> = {};
  const fileHashes: Record<string, string> = {};
  const pathSession: Record<string, string> = {};
  const keepMapKeys = new Set<string>();
  const presentIds = new Set([...presentPaths].map(pathMapKey));

  for (const pkey of Object.keys(cursor.fileOffsets)) {
    if (presentIds.has(pkey)) lastSeenAt[pkey] = nowSec;
    else if (lastSeenAt[pkey] === undefined) lastSeenAt[pkey] = nowSec; // first encounter: seen now, not stale

    const seenAtMs = lastSeenAt[pkey]! * 1000;
    if (nowMs - seenAtMs >= CURSOR_PRUNE_MS) {
      delete lastSeenAt[pkey];
      continue; // pruned: fileOffsets/fileHashes for this path are dropped
    }

    fileOffsets[pkey] = cursor.fileOffsets[pkey]!;
    if (cursor.fileHashes?.[pkey] !== undefined) fileHashes[pkey] = cursor.fileHashes[pkey]!;
    const literalKey = cursor.pathSession?.[pkey] === undefined ? sessionKeyOf(pkey) : null;
    const mapKey = cursor.pathSession?.[pkey] ?? (literalKey !== null ? sessionMapKey(literalKey) : undefined);
    if (mapKey !== undefined) {
      keepMapKeys.add(mapKey);
      pathSession[pkey] = mapKey;
    }
  }

  const sessions: Record<string, string> = {};
  for (const [mapKey, encoded] of Object.entries(cursor.sessions ?? {})) {
    if (keepMapKeys.has(mapKey)) sessions[mapKey] = encoded;
  }

  return { fileOffsets, fileHashes, sessions, lastSeenAt, pathSession };
}

// ---------------------------------------------------------------------------
// Issue #258 round-3 (maestro brief item 2): the emergency size-based prune —
// CURSOR_PRUNE_MS's age-based pass above already exists to keep the persisted
// cursor healthy, but nothing previously stopped a fleet that spawns paths
// FASTER than 48h sheds them from eventually blowing the DO value cap anyway.
// That tick's `storage.put` fails outright (BURN_PERSIST_ERROR_KEY,
// session-sync.ts's own doc comment) — advisory burn counting freezing
// fleet-wide is exactly the failure mode this belt exists to prevent.
// ---------------------------------------------------------------------------

/** Above this serialized size, `pruneCursorForSize` starts dropping entries.
 *  Comfortably under the 2 MB DO cap, leaving headroom for the OTHER keys a
 *  DO's storage backend accounts for against the same row. */
export const CURSOR_PERSIST_SOFT_CAP_BYTES = 1_800_000;
/** Where `pruneCursorForSize` stops once it starts — the real margin under
 *  the soft cap this belt aims to land at, not merely "just under" it. */
export const CURSOR_PERSIST_TARGET_BYTES = 1_500_000;

/**
 * Called AFTER `pruneCursor` (age-based), immediately before the persist —
 * session-sync.ts's own `parseBurn` is the one caller. A no-op (`removed:
 * 0`) below `CURSOR_PERSIST_SOFT_CAP_BYTES`; this never fires in the ordinary
 * case `pruneCursor`'s own 48h window already keeps healthy, only as a belt
 * for a fleet growing paths faster than that window sheds them.
 *
 * Drops entries LEAST-RECENTLY-SEEN first (`lastSeenAt` ascending) until the
 * serialized cursor is back under `CURSOR_PERSIST_TARGET_BYTES` — the same
 * "oldest first" bias `pruneCursor`'s own age-based pass already uses, just
 * forced rather than waited for. An id with no `lastSeenAt` entry (a
 * mixed-generation cursor mid-migration — see `pathMapKey`'s own doc
 * comment) sorts as the OLDEST possible entry (epoch 0): pruned first, never
 * last, matching this file's own "when unsure, prune/recount rather than
 * keep a lie" bias throughout.
 *
 * Re-serializes in batches (`RECHECK_BATCH` entries at a time) rather than
 * after every single removal — O(n) `JSON.stringify` calls over a shrinking
 * map would be quadratic in the entry count for a genuinely large fleet
 * (issue #258 round-3's own 20,000-path stress test), not merely slow.
 *
 * `sessions` entries are pruned in lockstep, same rule as `pruneCursor`'s own,
 * with the SAME literal-key fallback for a still-legacy `fileOffsets` entry
 * (`cursor.pathSession[pkey]` when present, else `sessionKeyOf(pkey)` treated
 * as a literal path) — issue #258 round-4 review (finding 3): an earlier
 * version of this function derived `keepMapKeys` from `Object.values(
 * pathSession)` alone, which is only equivalent to `pruneCursor`'s own rule
 * because session-sync.ts always calls `pruneCursor` first and this function
 * on ITS output (which already backfills `pathSession` for every surviving
 * entry, legacy or not). That made a real gap for any OTHER caller (this
 * function is exported): fed a cursor that has NOT already been through
 * `pruneCursor` this tick — the migration window `pruneCursor`'s own doc
 * comment documents, up to 48h post-deploy — a surviving legacy literal-keyed
 * entry with no `pathSession[pkey]` entry yet would have its `sessions` entry
 * dropped even though the entry itself survives, silently losing session
 * inheritance for it one tick early. Matching `pruneCursor`'s own fallback
 * removes the reliance on that caller-order invariant entirely, at the same
 * per-entry cost the surrounding loop already pays. Never throws — every
 * operation here is plain object mutation and `JSON.stringify` over data this
 * same file already produced, matching this whole file's "burn counting must
 * never freeze" design.
 */
export function pruneCursorForSize(
  cursor: BurnCursor,
  maxBytes: number = CURSOR_PERSIST_SOFT_CAP_BYTES,
  targetBytes: number = CURSOR_PERSIST_TARGET_BYTES,
  presentPaths?: ReadonlySet<string>,
): { cursor: BurnCursor; removed: number; compacted: number; bytes: number } {
  const RECHECK_BATCH = 250;
  const fileOffsets: Record<string, number> = { ...cursor.fileOffsets };
  const fileHashes: Record<string, string> = { ...(cursor.fileHashes ?? {}) };
  const lastSeenAt: Record<string, number> = { ...(cursor.lastSeenAt ?? {}) };
  const pathSession: Record<string, string> = { ...(cursor.pathSession ?? {}) };
  const sessions: Record<string, string> = { ...(cursor.sessions ?? {}) };

  const snapshot = () => JSON.stringify({ fileOffsets, fileHashes, sessions, lastSeenAt, pathSession }).length;
  let bytes = snapshot();
  if (bytes <= maxBytes) return { cursor, removed: 0, compacted: 0, bytes };

  // Which `sessions` entry each id keeps alive — pathSession, else the
  // literal-key fallback for a still-legacy entry (pruneCursor's own rule).
  // Counted per session so an entry is dropped the moment its LAST id goes,
  // INSIDE the loop (#309: dropping them only after the loop meant the loop
  // measured sizes they no longer had, and removed more than it needed).
  const mapKeyOf = (id: string): string | undefined => {
    if (pathSession[id] !== undefined) return pathSession[id];
    const literal = sessionKeyOf(id);
    return literal !== null ? sessionMapKey(literal) : undefined;
  };
  const refs = new Map<string, number>();
  const owner = new Map<string, string>();
  for (const id of Object.keys(fileOffsets)) {
    const mk = mapKeyOf(id);
    if (mk === undefined) continue;
    owner.set(id, mk);
    refs.set(mk, (refs.get(mk) ?? 0) + 1);
  }
  for (const mk of Object.keys(sessions)) if (!refs.has(mk)) delete sessions[mk];

  const evict = (id: string) => {
    delete fileOffsets[id];
    delete fileHashes[id];
    delete lastSeenAt[id];
    delete pathSession[id];
    const mk = owner.get(id);
    if (mk === undefined) return;
    const left = (refs.get(mk) ?? 1) - 1;
    refs.set(mk, left);
    if (left === 0) delete sessions[mk];
  };
  // #309: a LIVE path keeps its offset — the file stays counted to where it
  // was — and sheds everything else. resolveOffsets trusts an offset whose id
  // has no pathSession by length alone, so nothing is counted twice; its
  // session entry stays referenced (it is still in `owner`).
  const compact = (id: string) => {
    delete fileHashes[id];
    delete lastSeenAt[id];
    delete pathSession[id];
  };

  const presentIds = new Set<string>();
  if (presentPaths) for (const path of presentPaths) presentIds.add(pathMapKey(path));
  const byAge = (ids: string[]) => ids.sort((a, b) => (lastSeenAt[a] ?? 0) - (lastSeenAt[b] ?? 0));
  // Without a present set every id counts as absent: the pre-#309 behaviour.
  const absent = byAge(Object.keys(fileOffsets).filter((id) => !presentIds.has(id)));
  const live = byAge(Object.keys(fileOffsets).filter((id) => presentIds.has(id)));

  let removed = 0;
  let compacted = 0;
  const pass = (ids: string[], act: (id: string) => void, count: () => void) => {
    let i = 0;
    while (bytes > targetBytes && i < ids.length) {
      const batchEnd = Math.min(i + RECHECK_BATCH, ids.length);
      for (; i < batchEnd; i++) {
        act(ids[i]!);
        count();
      }
      bytes = snapshot();
    }
  };
  // 1. absent paths, oldest first; 2. live paths, compacted to their offset;
  // 3. only if that is still too big, live paths themselves (a recount).
  pass(absent, evict, () => { removed++; });
  pass(live, compact, () => { compacted++; });
  pass(live, evict, () => { removed++; });
  bytes = snapshot();

  return { cursor: { fileOffsets, fileHashes, sessions, lastSeenAt, pathSession }, removed, compacted, bytes };
}

// ---------------------------------------------------------------------------
// rollWindow — 5h rolling window
// ---------------------------------------------------------------------------

/**
 * Folds one tick's `delta` into `burn`. Cumulative totals (`turns`/
 * `inputTokens`/`outputTokens`/`costUsd`) always accumulate, unconditionally
 * — they are lifetime counters and never reset, including on a window roll.
 *
 * The 5h window (`window5hStart`/`window5hOutput`) is a TUMBLING bucket, not
 * a continuously-sliding average: once `now` reaches or passes
 * `window5hStart + BURN_WINDOW_MS`, the window rolls — `window5hStart`
 * becomes `now` and `window5hOutput` resets to (only) this tick's own output
 * delta, discarding the elapsed window's accumulated count. The boundary is
 * inclusive (`>=`): a tick landing EXACTLY `BURN_WINDOW_MS` after the
 * current window's start rolls, not accumulates one tick further — pinned by
 * this file's own tests, chosen for the simpler "the window is fully closed
 * the moment it reaches its nominal length" reading over "still open through
 * its very last millisecond."
 */
export function rollWindow(burn: Burn, delta: BurnDelta, now: Date): Burn {
  const turns = burn.turns + delta.turns;
  const inputTokens = burn.inputTokens + delta.inputTokens;
  const outputTokens = burn.outputTokens + delta.outputTokens;
  const costUsd = burn.costUsd + delta.costUsd;

  const windowStartMs = new Date(burn.window5hStart).getTime();
  const elapsed = now.getTime() - windowStartMs;
  const rolled = !Number.isFinite(windowStartMs) || elapsed >= BURN_WINDOW_MS;

  const window5hStart = rolled ? now.toISOString() : burn.window5hStart;
  const window5hOutput = (rolled ? 0 : burn.window5hOutput) + delta.outputTokens;

  return { turns, inputTokens, outputTokens, costUsd, window5hStart, window5hOutput };
}

// ---------------------------------------------------------------------------
// shouldAlert — once per window, streak-reset on window roll
// ---------------------------------------------------------------------------

/**
 * Pure predicate — no side effect, mirrors do.ts's `runRefreshToken`
 * "isNewStreak" shape exactly (compute the boolean, let the CALLER decide
 * whether to notify and then persist the marker). `threshold` follows the
 * design's own "0/absent = off" rule: any non-finite or non-positive
 * threshold (0, negative, NaN — an unset/malformed
 * `BURN_ALERT_OUTPUT_TOKENS_5H`) always returns false, regardless of `burn`.
 *
 * The "streak" marker here is the WINDOW's OWN identity
 * (`burn.window5hStart`, an ISO string) rather than a boolean — once alerted,
 * `alreadyAlertedWindow` is expected to be set to that exact string by the
 * caller. A later call for the SAME window (`alreadyAlertedWindow ===
 * burn.window5hStart`) suppresses a repeat alert even if `window5hOutput`
 * kept growing; a window ROLL changes `burn.window5hStart` to a new value
 * that no longer matches the stale marker, so the very next crossing alerts
 * again — "once per window, reset on window roll," exactly as required.
 */
export function shouldAlert(burn: Burn, threshold: number, alreadyAlertedWindow: string | null): boolean {
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  if (burn.window5hOutput < threshold) return false;
  return alreadyAlertedWindow !== burn.window5hStart;
}

// ---------------------------------------------------------------------------
// Minimal ustar (POSIX/GNU tar) reader — *.jsonl members only, no dependency
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512;

function readCString(bytes: Uint8Array, start: number, len: number): string {
  const stop = Math.min(start + len, bytes.length);
  let end = start;
  while (end < stop && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(start, end));
}

function readOctalField(bytes: Uint8Array, start: number, len: number): number {
  const raw = readCString(bytes, start, len).trim();
  if (raw === "") return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses raw (already-decompressed) tar bytes, returning every REGULAR FILE
 * member whose name ends in ".jsonl", decoded to text and keyed by its full
 * in-archive path — everything else (directories, `.claude.json`, any other
 * member) is skipped without its content ever being decoded to text at all.
 * The parser never stores or inspects message CONTENT beyond deciding "is
 * this a `.jsonl` member" from its NAME — counters, never content, is this
 * whole feature's own constraint (design Plane 4: "parse in-memory, never
 * store parsed PII beyond counters").
 *
 * Handles GNU tar's longname extension (typeflag 'L', the
 * "././@LongLink"-named header GNU tar emits for any member name over the
 * ustar format's 100-byte `name` field): this is not a hypothetical edge
 * case for this feature — real claude session paths
 * (`.claude/projects/<escaped-cwd>/<session-uuid>.jsonl`) routinely exceed
 * 100 bytes, and the studio container's base image
 * (docker.io/cloudflare/sandbox, a Debian-family image) ships GNU tar, whose
 * DEFAULT archive format uses this extension (not POSIX prefix/name
 * splitting) for any such name. An 'L' header's own `size` gives the real
 * name's length; its CONTENT block (not its 100-byte `name` field, which
 * GNU tar itself only ever fills with the "././@LongLink" sentinel) is where
 * the real name lives. Neither PAX extended headers nor any other GNU
 * extension type is handled — genuinely out of scope for "minimal," and this
 * reader stays tolerant of them regardless (an unrecognized typeflag is
 * simply skipped, its content bytes correctly stepped over via the header's
 * own size field, never crashing the parse).
 *
 * Stops at the first all-zero 512-byte block (the standard tar
 * end-of-archive marker). Never trusts a member's declared `size` to reach
 * further than the bytes actually given (`contentEnd` clamps to
 * `tarBytes.length`) — a truncated/corrupt archive is read as far as it
 * goes, not walked off the end of the buffer.
 */
export function readJsonlMembersFromTar(tarBytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + TAR_BLOCK <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker

    const size = readOctalField(header, 124, 12);
    const typeflag = header[156];
    offset += TAR_BLOCK;
    const contentStart = offset;
    const contentEnd = Math.min(contentStart + size, tarBytes.length);
    const paddedSize = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (typeflag === 0x4c /* 'L' */) {
      pendingLongName = readCString(tarBytes, contentStart, size);
    } else {
      const rawName = readCString(header, 0, 100);
      const prefix = readCString(header, 345, 155);
      const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      pendingLongName = null;

      const isRegularFile = typeflag === 0x30 /* '0' */ || typeflag === 0 /* '\0' */;
      if (isRegularFile && name.endsWith(".jsonl")) {
        out.set(name, decoder.decode(tarBytes.subarray(contentStart, contentEnd)));
      }
    }

    offset += paddedSize;
  }

  return out;
}

/** gzip -> tar -> jsonl members. The bytes session-sync.ts's `syncSessionTick`
 *  already holds in memory post-ship (`bytes`) are GZIP-compressed (its own
 *  `tarAndStatCmd` runs `tar -czf`), not raw tar — `DecompressionStream` is a
 *  standard Workers-runtime Web API (same category of "runtime-native, not
 *  an added dependency" as this feature's own `atob`/`crypto.subtle.digest`
 *  elsewhere), used here exactly once to unwrap that compression before
 *  handing raw bytes to `readJsonlMembersFromTar`. */
/**
 * Board #140: genuine gzip/tar corruption — bad magic, a stream the
 * decompressor rejects, or a tar that ends before its end-of-archive block.
 * pickRestoreSource falls back to a daily keeper ONLY on this; any other
 * error (transient, unexpected) propagates and aborts the restore.
 */
export class SessionArchiveFormatError extends Error {}

/** A decompressor rejection (workerd throws TypeError "Decompression
 *  failed.") becomes a SessionArchiveFormatError; anything else is rethrown
 *  unrelabelled (#140 review item 5). */
async function asFormatError<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof TypeError) throw new SessionArchiveFormatError(`burn: gzip decompression failed: ${err.message}`);
    throw err;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await asFormatError(new Response(inflateSliced(bytes)).arrayBuffer()));
}

/** Whole-text extraction: tests' reference for burnIncrement. Production never
 *  calls it — it holds the raw tar and every member's text (issue #176). */
export async function extractJsonlMembers(gzipTarBytes: Uint8Array): Promise<Map<string, string>> {
  const tarBytes = await gunzip(gzipTarBytes);
  return readJsonlMembersFromTar(tarBytes);
}

// ---------------------------------------------------------------------------
// Issue #176: gunzip FED in slices, tar WALKED as it inflates
// ---------------------------------------------------------------------------
// MEASURED (V8 live set, gc'd heapUsed + external, 16 real R2 snapshots):
// restore held gz + raw, the sync tick ~4.1 x raw — 128 MiB at
// acme-os--maestro's 9.1 MiB gz — once workerd's own behaviour is counted:
// it inflates a WHOLE written chunk at once, off-heap (#118/#140), and every
// gunzip here used to write the entire snapshot as one chunk. An OOM resets
// the isolate, no catch runs, and every retry reads the same bytes.

/** Largest chunk ever written into a DecompressionStream. */
export const GUNZIP_SLICE = 65_536;

/** The one reused view walkGzipTar reads the inflated tar into. */
export const INFLATE_READ_VIEW = 1_048_576;

/** Test seam: told how many inflated bytes the reader had consumed at the
 *  moment the gz source was fully fed (#176 review). Production never sets it. */
export const INFLATE_PROBE: { onSourceDone?: (consumed: number) => void } = {};

/**
 * The decompressed bytes of `gz`, fed GUNZIP_SLICE at a time and only as the
 * pipe pulls (highWaterMark 0).
 *
 * Slicing alone does NOT bound memory in workerd (#176 review, measured on
 * workerd 1.20260730.1): its DecompressionStream has no backpressure, so the
 * pipe writes the next slice as soon as the last write settles, and each
 * inflated slice waits in its internal buffer until read. A default reader
 * drains ~4 KiB a turn — acme-os--maestro's source was fully fed when the
 * reader had taken 0.6 of 31.5 MiB. What bounds it is the READER keeping
 * pace: walkGzipTar reads BYOB into a 1 MiB view (31.5/31.5 when fed).
 */
function inflateSliced(gz: Uint8Array, onFed?: () => void): ReadableStream<Uint8Array> {
  // Cheap magic-byte check (RFC 1952) before touching DecompressionStream: a
  // clear error for "not gzip", and no workerd "incomplete data" log noise.
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) {
    throw new SessionArchiveFormatError("burn: not a gzip stream (bad magic header)");
  }
  // @cloudflare/workers-types types .writable as WritableStream<ArrayBuffer |
  // ArrayBufferView>, which pipeThrough's invariant generic refuses for
  // Uint8Array although it is accepted at runtime; a structural cast closes it.
  const ds = new DecompressionStream("gzip") as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  let off = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (off >= gz.length) {
          controller.close();
          return;
        }
        controller.enqueue(gz.subarray(off, off + GUNZIP_SLICE));
        off += GUNZIP_SLICE;
        // Fully fed: the last slice is in. The walker may cancel at the tar's
        // end block before the close above is ever reached.
        if (off >= gz.length) onFed?.();
      },
    },
    { highWaterMark: 0 },
  ).pipeThrough(ds);
}

/** What walkGzipTar hands a member's content to; `end` once it is complete. */
type MemberSink = { data(slice: Uint8Array): void; end(): void };

/** GNU longnames longer than this are not session paths; kept truncated. */
const LONGNAME_CAP = 65_536;

/**
 * One streaming pass over a gzip'd tar: `onMember(name, header)` for every
 * member (same naming rules as readJsonlMembersFromTar: GNU 'L' longnames,
 * ustar prefix), whose sink, if any, receives the content in order. Never
 * holds more than a slice of the tar; stops at the end-of-archive block.
 */
async function walkGzipTar(gz: Uint8Array, onMember: (name: string, header: Uint8Array) => MemberSink | null): Promise<void> {
  let consumed = 0;
  const inflated = inflateSliced(gz, () => INFLATE_PROBE.onSourceDone?.(consumed));
  // BYOB into ONE reused view (see inflateSliced): no sink keeps a slice of
  // it — each copies what it needs (concat, TextDecoder, the header and
  // longname buffers). The default reader only where BYOB is unsupported
  // (bun's DecompressionStream); workerd's supports it.
  // Structural: workers-types and the DOM/node lib disagree on the reader
  // classes; these two methods are all the walk uses.
  type Result = { done: boolean; value?: Uint8Array };
  type ByobReader = { read(view: Uint8Array): Promise<Result>; cancel(): Promise<void> };
  type PlainReader = { read(): Promise<Result>; cancel(): Promise<void> };
  let byob = null as ByobReader | null;
  let plain = null as PlainReader | null;
  try {
    byob = inflated.getReader({ mode: "byob" }) as unknown as ByobReader;
  } catch {
    plain = inflated.getReader() as unknown as PlainReader;
  }
  let buffer: ArrayBuffer = new ArrayBuffer(INFLATE_READ_VIEW);
  const read = async (): Promise<Uint8Array | null> => {
    if (plain) {
      const { done, value } = await asFormatError(plain.read());
      return done || !value ? null : value;
    }
    // The view is built outside the conversion: only the read itself is the
    // decompressor's to reject.
    const view = new Uint8Array(buffer);
    const { done, value } = await asFormatError(byob!.read(view));
    if (done || !value) return null;
    buffer = value.buffer as ArrayBuffer;
    return value;
  };
  const cancel = () => (plain ?? byob!).cancel().catch(() => {});
  const head = new Uint8Array(TAR_BLOCK);
  let headLen = 0;
  let remaining = 0;
  let padding = 0;
  let sink: MemberSink | null = null;
  let longName: Uint8Array | null = null;
  let longLen = 0;
  let pendingLongName: string | null = null;
  let ended = false;

  const finish = () => {
    if (longName) {
      pendingLongName = readCString(longName, 0, longLen);
      longName = null;
    }
    sink?.end();
    sink = null;
  };

  while (!ended) {
    const value = await read();
    if (!value) break;
    consumed += value.length;
    let off = 0;
    while (off < value.length && !ended) {
      if (remaining > 0) {
        const take = Math.min(remaining, value.length - off);
        const slice = value.subarray(off, off + take);
        if (longName) {
          const room = Math.min(take, LONGNAME_CAP - longLen);
          if (room > 0) longName.set(slice.subarray(0, room), longLen);
          longLen += Math.max(room, 0);
        } else sink?.data(slice);
        off += take;
        remaining -= take;
        if (remaining === 0) finish();
        continue;
      }
      if (padding > 0) {
        const skip = Math.min(padding, value.length - off);
        off += skip;
        padding -= skip;
        continue;
      }
      const take = Math.min(TAR_BLOCK - headLen, value.length - off);
      head.set(value.subarray(off, off + take), headLen);
      headLen += take;
      off += take;
      if (headLen < TAR_BLOCK) continue;
      headLen = 0;
      if (head.every((b) => b === 0)) {
        ended = true;
        break;
      }
      const size = readOctalField(head, 124, 12);
      const typeflag = head[156];
      remaining = size;
      padding = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK - size;
      if (typeflag === 0x4c /* 'L' */) {
        longName = new Uint8Array(Math.min(size, LONGNAME_CAP));
        longLen = 0;
      } else {
        const rawName = readCString(head, 0, 100);
        const prefix = readCString(head, 345, 155);
        const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
        pendingLongName = null;
        sink = onMember(name, head);
      }
      if (size === 0) finish();
    }
  }
  if (ended) {
    await cancel();
    return;
  }
  // The gzip stream ran out before the tar's own end-of-archive block: a
  // truncated archive, not a short one (#140 review item 4).
  throw new SessionArchiveFormatError("burn: gzip stream ended before tar end-of-archive block (truncated)");
}

function isJsonlFile(name: string, header: Uint8Array): boolean {
  const typeflag = header[156];
  return (typeflag === 0x30 /* '0' */ || typeflag === 0) && name.endsWith(".jsonl");
}

// ---------------------------------------------------------------------------
// Issue #94: session richness — the sync guard's and restore fallback's view
// of a snapshot, computed in one streaming pass (walkGzipTar), never the raw
// tar in memory.
// ---------------------------------------------------------------------------

/** One jsonl member: complete lines, tar mtime (seconds), and the top-level
 *  `timestamp` of its last complete line (null if that line was over
 *  STATS_LINE_CAP or carried none). Counters only, never content. */
export type SessionFileStat = { lines: number; mtime: number; lastTs: string | null };
export type SessionStats = Record<string, SessionFileStat>;
/** The one file the guard compares against: the snapshot's newest session. */
export type SessionMark = { file: string; lines: number; lastTs: string | null };

/** A last line longer than this is counted but not parsed for its timestamp. */
const STATS_LINE_CAP = 1_048_576;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function lastTimestamp(line: Uint8Array | null): string | null {
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(line));
    return isPlainObject(parsed) && typeof parsed.timestamp === "string" ? parsed.timestamp : null;
  } catch {
    return null;
  }
}

/**
 * Per-jsonl-member stats of a gzip'd tar, in one streaming pass. Same member
 * rules as readJsonlMembersFromTar (regular files ending `.jsonl`, GNU
 * longname honoured); a trailing line with no newline is not counted,
 * matching parseUsageIncrement's "complete lines only". Throws on a non-gzip
 * input (bad magic).
 */
export async function sessionStats(gzipTarBytes: Uint8Array): Promise<SessionStats> {
  const out: SessionStats = {};
  await walkGzipTar(gzipTarBytes, (name, header) => {
    if (!isJsonlFile(name, header)) return null;
    const stat: SessionFileStat = { lines: 0, mtime: readOctalField(header, 136, 12), lastTs: null };
    let line: Uint8Array = new Uint8Array(0);
    let over = false;
    let last: Uint8Array | null = null;
    return {
      data(slice) {
        let start = 0;
        for (;;) {
          const nl = slice.indexOf(0x0a, start);
          const seg = slice.subarray(start, nl === -1 ? slice.length : nl);
          if (!over) {
            if (line.length + seg.length > STATS_LINE_CAP) {
              over = true;
              line = new Uint8Array(0);
            } else if (seg.length > 0) {
              line = concat(line, seg);
            }
          }
          if (nl === -1) return;
          stat.lines++;
          if (!over) last = line;
          line = new Uint8Array(0);
          over = false;
          start = nl + 1;
        }
      },
      end() {
        stat.lastTs = lastTimestamp(last);
        out[name] = stat;
      },
    };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Issue #176: the burn increment, streaming — parseUsageIncrement's exact
// semantics without the raw tar or any member's whole text in memory.
// ---------------------------------------------------------------------------

/** One jsonl member, measured a slice at a time: everything `resolveOffsets`
 *  asks a `MemberFacts` for, and nothing else. */
type Measured = {
  length: number;
  endOfComplete: number;
  /** Offset -> `prefixFingerprint` there, for every offset the rule can ask
   *  about: 0, the stored path offset, the session's `counted`, this member's
   *  own end of complete lines, and (pass 2) a same-key sibling's. */
  prints: Map<number, string>;
  /** Index of the LAST tar header carrying this name. A tar may hold a name
   *  twice; `extractJsonlMembers`'s Map keeps the last member's content, so
   *  only that occurrence is measured and counted. */
  occurrence: number;
};

/** Pass 1/2's shared work: fingerprint a member's bytes as they stream past,
 *  snapshotting at `wanted` and at every "\n". */
function measureMember(wanted: number[], onDone: (m: Omit<Measured, "occurrence">) => void): MemberSink {
  const prints = new Map<number, string>([[0, fingerprintOf(FP_INIT_A, FP_INIT_B)]]);
  const decoder = new TextDecoder();
  let a = FP_INIT_A;
  let b = FP_INIT_B;
  let length = 0;
  let endOfComplete = 0;
  let endA = FP_INIT_A;
  let endB = FP_INIT_B;
  let next = 0;
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, FP_PRIME_A);
      b = Math.imul(b ^ c, FP_PRIME_B);
      const at = length + i + 1;
      // The last complete line's end, and the rolls exactly there — free, and
      // the one offset the rule needs that is not known before the walk.
      if (c === 0x0a /* "\n" */) {
        endOfComplete = at;
        endA = a;
        endB = b;
      }
      while (next < wanted.length && wanted[next] <= at) {
        if (wanted[next] === at) prints.set(at, fingerprintOf(a, b));
        next++;
      }
    }
    length += text.length;
  };
  return {
    data: (slice) => feed(decoder.decode(slice, { stream: true })),
    end: () => {
      feed(decoder.decode());
      prints.set(endOfComplete, fingerprintOf(endA, endB));
      onDone({ length, endOfComplete, prints });
    },
  };
}

/**
 * parseUsageIncrement(prev, extractJsonlMembers(gz)) — same cursor, same
 * delta, same skips — in streaming passes over `gz`. Memory: a slice of the
 * inflated tar, the line being parsed, and a handful of numbers per member;
 * never the raw tar, never a member's text (issue #176).
 *
 * Pass 1 measures every jsonl member: its length in UTF-16 code units, its
 * last complete line's end, and a prefix fingerprint at each offset #154's
 * rule can ask about BEFORE the tick is measured — the stored path offset and
 * the session's `counted` (`fingerprintOffsetsFor`), both read from `prev` at
 * the member header, plus the member's own end of complete lines, taken for
 * free from the same roll. One fingerprint pass per member.
 *
 * Pass 2 runs ONLY when some session key has two or more members in this tar —
 * a copy sitting beside its original, i.e. an adopt tick. Rule (b) has to
 * compare a longer copy against the SHORTER one's end of complete lines, and
 * no member's end is known until pass 1 is done. Only the members of such keys
 * are fingerprinted, and only up to the furthest sibling end.
 *
 * Pass 3 parses the complete lines past each resolved start, and nothing else.
 *
 * Issue #258: also reports `presentPaths` — every member name pass 1 actually
 * walked this tick, regardless of what resolveOffsets did with it — the exact
 * same set `parseUsageIncrement` reports from `jsonlByFile`'s own keys (see
 * that function's own doc comment). `order` (pass 1's own deduped member-name
 * list, already the source `resolveOffsets` above is built from) is reused
 * rather than re-walking anything a second time.
 */
export async function burnIncrement(
  prev: BurnCursor, gzipTarBytes: Uint8Array,
): Promise<{ cursor: BurnCursor; delta: BurnDelta; parseSkips: number; presentPaths: Set<string> }> {
  // Pass 1.
  const measured = new Map<string, Measured>();
  let headers = 0;
  await walkGzipTar(gzipTarBytes, (name, header) => {
    if (!isJsonlFile(name, header)) return null;
    const occurrence = headers++;
    return measureMember(fingerprintOffsetsFor(prev, name, sessionKeyOf(name)), (m) => {
      // Map.set on a seen name keeps its first POSITION and takes the last
      // VALUE — exactly what extractJsonlMembers's own Map does.
      measured.set(name, { ...m, occurrence });
    });
  });
  const order = [...measured.keys()];

  // Pass 2, only for keys a copy shares with its original.
  const byKey = new Map<string, string[]>();
  for (const file of order) {
    const key = sessionKeyOf(file);
    if (key === null) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  const siblingEnds = new Map<string, number[]>();
  for (const files of byKey.values()) {
    if (files.length < 2) continue;
    const ends = files.map((f) => measured.get(f)!.endOfComplete);
    for (const file of files) {
      const m = measured.get(file)!;
      const want = [...new Set(ends)].filter((e) => e <= m.length && !m.prints.has(e)).sort((x, y) => x - y);
      if (want.length > 0) siblingEnds.set(file, want);
    }
  }
  if (siblingEnds.size > 0) {
    let seen = 0;
    await walkGzipTar(gzipTarBytes, (name, header) => {
      if (!isJsonlFile(name, header)) return null;
      const mine = seen++;
      const m = measured.get(name);
      const want = siblingEnds.get(name);
      if (!m || !want || m.occurrence !== mine) return null;
      return measureMember(want, (extra) => {
        for (const offset of want) {
          const print = extra.prints.get(offset);
          if (print !== undefined) m.prints.set(offset, print);
        }
      });
    });
  }

  const { starts, cursor } = resolveOffsets(prev, order.map((file) => {
    const m = measured.get(file)!;
    return {
      file,
      key: sessionKeyOf(file),
      length: m.length,
      endOfComplete: m.endOfComplete,
      fingerprintAt: (offset: number) => m.prints.get(offset) ?? null,
    };
  }));

  // Pass 3: the complete lines past each start, counted exactly once.
  const acc = { delta: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } as BurnDelta, parseSkips: 0 };
  let occurrence = 0;
  await walkGzipTar(gzipTarBytes, (name, header) => {
    if (!isJsonlFile(name, header)) return null;
    const mine = occurrence++;
    const m = measured.get(name);
    if (!m || m.occurrence !== mine) return null;
    const start = starts.get(name)!;
    const decoder = new TextDecoder();
    let pos = 0;
    let line: string[] = [];
    const feed = (text: string): void => {
      let i = 0;
      if (pos < start) i = Math.min(start - pos, text.length);
      pos += text.length;
      while (i < text.length) {
        const nl = text.indexOf("\n", i);
        if (nl === -1) {
          line.push(text.slice(i));
          return;
        }
        line.push(text.slice(i, nl));
        countUsageLine(line.join(""), acc);
        line = [];
        i = nl + 1;
      }
    };
    return {
      data: (slice) => feed(decoder.decode(slice, { stream: true })),
      end: () => feed(decoder.decode()),
    };
  });

  return { cursor, delta: acc.delta, parseSkips: acc.parseSkips, presentPaths: new Set(order) };
}

/** Issue #94 review: Claude's own transcript cleanup (`cleanupPeriodDays`,
 *  default 30) may delete the baseline file; past this age its absence is
 *  cleanup, not a blank session. */
export const SESSION_CLEANUP_MS = 30 * 86_400_000;

/** A file's time for ordering: its last entry's timestamp, else its tar
 *  mtime (newer Claude builds end live files with timestamp-less lines, and
 *  a restored or copied file keeps or gets a real mtime). */
function effectiveTs(s: SessionFileStat): string {
  return s.lastTs ?? new Date(s.mtime * 1000).toISOString();
}

/**
 * The snapshot's newest MAIN session file (a `subagents/` transcript only
 * when no main file exists): latest effective time, then tar mtime, then
 * name — deterministic. `lastTs` on the mark is that effective time.
 * `null` when the snapshot holds no session file at all.
 */
export function newestMark(stats: SessionStats): SessionMark | null {
  const all = Object.entries(stats);
  const main = all.filter(([name]) => !name.includes("/subagents/"));
  let best: [string, SessionFileStat] | null = null;
  for (const entry of main.length > 0 ? main : all) {
    if (!best) {
      best = entry;
      continue;
    }
    const [name, s] = entry;
    const [bName, b] = best;
    const ts = effectiveTs(s);
    const bTs = effectiveTs(b);
    if (ts > bTs || (ts === bTs && (s.mtime > b.mtime || (s.mtime === b.mtime && name > bName)))) best = entry;
  }
  return best ? { file: best[0], lines: best[1].lines, lastTs: effectiveTs(best[1]) } : null;
}

/** A session file's id: its basename (`<session-uuid>.jsonl`). */
function sessionIdOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Issue #94 (maestro addendum): the stat for `file`'s SESSION, found by id
 * rather than path — Claude moves a transcript to a new project key when a
 * lead enters a worktree (same id, new folder), and #120 copies one back.
 * A `subagents/` file never stands in for a main one. Several matches (a
 * copy beside its original) → the one with the most lines.
 */
function sameSession(stats: SessionStats, file: string): SessionFileStat | undefined {
  const id = sessionIdOf(file);
  const sub = file.includes("/subagents/");
  let best: SessionFileStat | undefined;
  for (const [name, s] of Object.entries(stats)) {
    if (sessionIdOf(name) !== id || name.includes("/subagents/") !== sub) continue;
    if (!best || s.lines > best.lines) best = s;
  }
  return best;
}

/**
 * Why `stats` is poorer than the snapshot `mark` was taken from, or null if
 * it is not. Only the mark's own session (by id, see sameSession) is
 * compared: a new session alongside it never counts as poorer, and neither
 * does its absence once the mark is older than SESSION_CLEANUP_MS at `now`
 * (Claude's cleanup removed it). A snapshot with no session file at all is
 * always poorer.
 */
export function poorerThan(stats: SessionStats, mark: SessionMark, now?: Date): string | null {
  if (Object.keys(stats).length === 0) return `no session files (baseline ${mark.file})`;
  const s = sameSession(stats, mark.file);
  if (!s) {
    const age = now && mark.lastTs ? now.getTime() - Date.parse(mark.lastTs) : Number.NaN;
    if (age > SESSION_CLEANUP_MS) return null;
    return `missing newest session file ${mark.file}`;
  }
  if (s.lines < mark.lines) return `newest session file ${mark.file} has fewer lines (${s.lines} < ${mark.lines})`;
  return null;
}
