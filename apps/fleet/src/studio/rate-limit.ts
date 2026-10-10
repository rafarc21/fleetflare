/**
 * Issue #99 — rate-limited is a studio STATE, and the one with a KNOWN end
 * time: claude prints it in the pane ("resets 1:30pm (UTC)"). This module owns
 * the ONE reset grammar (failover.ts's detector imports it), the staleness
 * rule (#106/#112), the conversion to UTC, and the words `fleet ls` renders.
 *
 * Pure: no Env, no imports. The CLI imports it (fleet ls READY), so it must
 * not pull the Worker's graph in.
 */

/** What the failover capture last saw, stored on the row (StudioStatus.rateLimited). */
export interface RateLimitObservation {
  /** The printed reset, as a UTC ISO instant. `null` when the pane showed the
   *  limit but no readable reset. */
  until: string | null;
  /** When this limit was first observed, ISO. */
  seenAt: string;
  /** A numbered select modal (V1, V3, #53), not an inline block: it stays on
   *  screen until someone presses Esc, whatever the clock says. */
  select?: true;
  /** Issue #141 — a dead account (org disabled subscription access): permanent,
   *  no clock ends it. */
  dead?: true;
  /** Issue #336 — the org's MONTHLY spend cap. Not a 5h/7d window: the
   *  account stays limited fleet-wide until the month rolls over (UTC) or an
   *  operator clears it. `until` stays what the pane printed (null). */
  spendCap?: true;
}

/**
 * Issue #127: the Durable Object key holding the FIRST sighting of the inline
 * limit block a studio's pane shows. Its own key, not a StudioStatus field:
 * every STATUS_KEY writer spreads the row, and the row's `rateLimited` is
 * cleared the moment the block scrolls away — this must outlive both, so a
 * `--continue` redraw of an old block is recognised as old.
 */
export const LIMIT_SIGHTING_KEY = "limitSighting";

/**
 * The first sighting of one inline limit block. A time-only reset ("1:30pm")
 * repeats daily, so the text alone cannot say WHICH 1:30pm; `until` is
 * computed ONCE, against `seenAt`, and every later look at the same block
 * reads it back instead of re-parsing the text against a later clock.
 */
export interface LimitSighting {
  /** failover.ts's limitBlockKey: headline + printed reset. */
  block: string;
  /** The reset as printed, or null when the block printed none. */
  printed: string | null;
  /** parseResetUtc(printed, seenAt), ISO; null when unreadable. */
  until: string | null;
  /** When this block was first seen, ISO. */
  seenAt: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A reset as printed: "1:30pm (UTC)", "3:30pm (Europe/Madrid)", weekly "Sep
 * 26 at 12pm (Europe/Madrid)", or Linux claude's "Sep 17, 8pm (UTC)".
 * Groups: 1 time, 2 month, 3 day, 4 hour, 5 minute, 6 am/pm, 7 zone.
 */
const RESET_TIME = String.raw`((?:([A-Z][a-z]{2}) (\d{1,2})(?: at|,) )?(\d{1,2})(?::(\d{2}))?\s*([ap]m)) \(([^)]+)\)`;

/**
 * The reset clause inside a limit HEADLINE. Group 1 names WHICH limit resets
 * (the monthly-spend headline says "your session limit resets …" or "your
 * weekly limit resets …" mid-line); group 2 is the reset kept as printed
 * (RESET_TIME's groups follow, shifted by two).
 */
export const RESETS = new RegExp(String.raw`(session|weekly) limit(?: ·)? resets (${RESET_TIME})`, "i");

/** A session limit resets within its 5-hour window of being printed. */
const SESSION_WINDOW_MINUTES = 5 * 60;

/** `now`'s wall clock in `timeZone`, as UTC-epoch ms of those wall fields, or null for a zone Intl rejects. */
function wallClock(now: Date, timeZone: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
}

/** 24h hour from "1"/"12" + "am"/"pm". */
function hour24(hour: string, ampm: string): number {
  return (Number(hour) % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
}

/**
 * Issue #106: has the reset a RESETS match prints already PASSED at `now`?
 * A block whose limit has reset is stale: the account works again. Anything
 * it cannot decide is NOT stale — that keeps #102's behaviour, never invents
 * a new false negative from a parse miss.
 *
 *   - dated ("Sep 26 at 12pm"): stale once that wall-clock time is reached,
 *     the year taken as the one nearest `now`;
 *   - time only, session limit: the reset lies within 5h of the print, so the
 *     block is live only while the next occurrence of that time is ≤ 5h away;
 *   - time only, weekly limit: undecidable from the time alone, so live.
 */
export function isResetStale(m: RegExpMatchArray, now: Date): boolean {
  const [, kind, , , mon, day, hour, minute, ampm, tz] = m;
  const nowWall = wallClock(now, tz);
  if (nowWall === null) return false;
  const h = hour24(hour, ampm);
  const min = Number(minute ?? 0);
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return false;
    const year = new Date(nowWall).getUTCFullYear();
    const reset = [year - 1, year, year + 1]
      .map((y) => Date.UTC(y, month, Number(day), h, min))
      .reduce((a, b) => (Math.abs(b - nowWall) < Math.abs(a - nowWall) ? b : a));
    return reset <= nowWall;
  }
  if (kind.toLowerCase() !== "session") return false;
  const nowMin = new Date(nowWall).getUTCHours() * 60 + new Date(nowWall).getUTCMinutes();
  const until = (((h * 60 + min) - nowMin) % 1440 + 1440) % 1440;
  return until === 0 || until > SESSION_WINDOW_MINUTES;
}

/**
 * The printed reset (RESETS group 2), as a UTC ISO string, or `null` when it
 * cannot be read — never a guessed time.
 *
 * Wall clock → UTC through the zone's own offset at `now` (wallClock above):
 * the reset is hours away, so a DST edge between the two is the one case this
 * can be off by an hour. A time-only reset takes the occurrence NEAREST `now`
 * (a live one is ≤ 5h ahead; a stale one must read as passed, not tomorrow);
 * a dated one takes the nearest year.
 */
export function parseResetUtc(printed: string, now: Date): string | null {
  const m = printed.trim().match(new RegExp(`^${RESET_TIME}$`, "i"));
  if (!m) return null;
  const [, , mon, day, hour, minute, ampm, tz] = m;
  const nowWall = wallClock(now, tz);
  if (nowWall === null) return null;
  const offset = nowWall - Math.floor(now.getTime() / 60_000) * 60_000;
  const h = hour24(hour, ampm);
  const min = Number(minute ?? 0);
  if (h > 23 || min > 59) return null;
  let candidates: number[];
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return null;
    const year = new Date(nowWall).getUTCFullYear();
    candidates = [year - 1, year, year + 1].map((y) => Date.UTC(y, month, Number(day), h, min));
  } else {
    const d = new Date(nowWall);
    candidates = [-1, 0, 1].map((k) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + k, h, min));
  }
  const wall = candidates.reduce((a, b) => (Math.abs(b - nowWall) < Math.abs(a - nowWall) ? b : a));
  return new Date(wall - offset).toISOString();
}

/** "13:30Z" on the same UTC day as `now`, "Sep 26 12:00Z" otherwise. */
function formatUntil(until: Date, now: Date): string {
  const hhmm = `${String(until.getUTCHours()).padStart(2, "0")}:${String(until.getUTCMinutes()).padStart(2, "0")}Z`;
  if (until.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return hhmm;
  const month = MONTHS[until.getUTCMonth()];
  return `${month[0].toUpperCase()}${month.slice(1)} ${until.getUTCDate()} ${hhmm}`;
}

/**
 * Issue #102 — the fleet_state (src/state.ts) key holding ONE account's
 * fleet-wide limit sighting: written by whichever studio first sees that
 * account limited, read by every studio's own next failover decision
 * (accounts.ts's nextClaudeAccount) so one studio hitting a limit marks it
 * for all, not only for its own row. Prefixed and per-account, never a single
 * blob, so N accounts are N independent fleet_state rows — one studio's write
 * can never race another account's.
 */
const ACCOUNT_LIMIT_STATE_PREFIX = "account-limit:";
export function accountLimitStateKey(accountName: string): string {
  return `${ACCOUNT_LIMIT_STATE_PREFIX}${accountName}`;
}

/** The value stored at accountLimitStateKey(name) — JSON, `fleet_state.value`
 *  is TEXT. Same two fields as LimitSighting's own until/seenAt, kept
 *  separate from that type: LimitSighting is a Durable Object's own per-block
 *  sighting, this is D1's fleet-wide per-ACCOUNT one, and the two must never
 *  be read as interchangeable even though their shape matches today. */
export interface AccountLimitState {
  /** ISO instant the limit resets, or null when the pane printed none — see
   *  accounts.ts's AccountLimits for what null means to nextClaudeAccount. */
  until: string | null;
  /** When this sighting was recorded, ISO. */
  seenAt: string;
  /** Issue #141 — set once an account is confirmed dead (org disabled
   *  subscription access): no auto-expiry, unlike a null `until`'s
   *  NULL_UNTIL_CEILING_MS grace. */
  dead?: true;
  /** Issue #232 — set when this sighting came from `fleet accounts sync`'s
   *  cswap usage read (routes.ts's POST /studio/accounts/sync), rather than
   *  failover.ts's own pane-capture detector, which never sets this field
   *  and so always reads `undefined` here — an optional field a caller never
   *  sets is simply absent, same as before this field existed. */
  source?: "usage";
  /** Issue #336 — see AccountLimitKind. Absent: an ordinary window row. */
  kind?: AccountLimitKind;
  /** Issue #336 — the operator's free-text reason for a hold (or the
   *  detector's note for a spend cap), shown by `fleet accounts`. */
  reason?: string;
}

/**
 * Issue #336 — WHY a row is limited, when it is not an ordinary 5h/7d window
 * (absent): `spend_cap` (the org's monthly spend cap, failover.ts's detector)
 * or `hold` (an operator's `fleet accounts hold`). Either one is a HOLD: the
 * usage sync never clears or overwrites it while it is active (see
 * accountHoldActive), and a null `until` means "until cleared", never the
 * 24h NULL_UNTIL_CEILING_MS grace.
 */
export type AccountLimitKind = "spend_cap" | "hold";

/** First instant of the NEXT UTC month — when an org's monthly spend cap
 *  resets. Always strictly after `now`. */
export function startOfNextMonthUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** Issue #336 — the row's hold kind while it holds: a kind set, and its
 *  `until` null (until cleared) or still ahead. `null` for no row, a plain
 *  window row, or a hold whose until has passed. */
export function accountHoldActive(state: AccountLimitState | null, now: Date): AccountLimitKind | null {
  if (!state?.kind) return null;
  if (state.until !== null && Date.parse(state.until) <= now.getTime()) return null;
  return state.kind;
}

export function encodeAccountLimitState(state: AccountLimitState): string {
  return JSON.stringify(state);
}

/** `null` for a key never written, or a value that is not this shape — never
 *  thrown: a corrupt fleet_state row must read as "not limited", not crash a
 *  failover tick that has nothing to do with writing it. */
export function decodeAccountLimitState(raw: string | null): AccountLimitState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" || parsed === null
    || !("seenAt" in parsed) || typeof (parsed as { seenAt: unknown }).seenAt !== "string"
    || !("until" in parsed) || !(typeof (parsed as { until: unknown }).until === "string" || (parsed as { until: unknown }).until === null)
    || ("dead" in parsed && (parsed as { dead: unknown }).dead !== true)
    || ("source" in parsed && (parsed as { source: unknown }).source !== "usage")
    || ("kind" in parsed && (parsed as { kind: unknown }).kind !== "spend_cap" && (parsed as { kind: unknown }).kind !== "hold")
    || ("reason" in parsed && typeof (parsed as { reason: unknown }).reason !== "string")
  ) {
    return null;
  }
  const p = parsed as AccountLimitState;
  return {
    until: p.until, seenAt: p.seenAt,
    ...(p.dead ? { dead: true as const } : {}),
    ...(p.source ? { source: p.source } : {}),
    ...(p.kind ? { kind: p.kind } : {}),
    ...(p.reason !== undefined ? { reason: p.reason } : {}),
  };
}

/**
 * Issue #131 (Stage B) — the fleet_state key holding ONE account's mirrored
 * 5h-window burn, the read half of `FailoverDeps.accountBurn`. Same shape and
 * same reasoning as `accountLimitStateKey` just above (see its own doc
 * comment): one account, one independent row, written by whichever studio is
 * currently launched on it (do.ts's `mirrorBurnToRegistry`), read by every
 * studio's own borrow second pass (accounts.ts's `nextBorrowedAccount`) so a
 * borrow decision sees the WHOLE fleet's burn on a candidate account, not
 * only what this studio's own row happens to say.
 */
const ACCOUNT_BURN_STATE_PREFIX = "account-burn:";
export function accountBurnStateKey(accountName: string): string {
  return `${ACCOUNT_BURN_STATE_PREFIX}${accountName}`;
}

/** The value stored at accountBurnStateKey(name) — JSON, `fleet_state.value`
 *  is TEXT. Mirrors AccountLimitState's own shape/encode/decode discipline;
 *  kept as its own type rather than reused, same "must never be read as
 *  interchangeable" reasoning AccountLimitState's own doc comment gives. */
export interface AccountBurnState {
  window5hOutput: number;
}

export function encodeAccountBurnState(state: AccountBurnState): string {
  return JSON.stringify(state);
}

/** `null` for a key never written, or a value that is not this shape — never
 *  thrown: a corrupt fleet_state row must read as "no burn observed", never
 *  crash a borrow decision that has nothing to do with writing it. */
export function decodeAccountBurnState(raw: string | null): AccountBurnState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" || parsed === null
    || !("window5hOutput" in parsed) || typeof (parsed as { window5hOutput: unknown }).window5hOutput !== "number"
  ) {
    return null;
  }
  return { window5hOutput: (parsed as AccountBurnState).window5hOutput };
}

/**
 * Issue #238 — the fleet_state key holding ONE account's most recent
 * TRUSTWORTHY usage reading, for headroom ordering. Separate row, separate
 * key prefix, separate type from `accountLimitStateKey`/`AccountLimitState`
 * just above: that pair answers "is this account currently limited"
 * (consumed by `accountIsFree`, no hard staleness ceiling beyond the 24h
 * null-until grace); this answers "how much headroom does it have" (consumed
 * by headroom ordering, a hard 10-minute freshness cutoff — see
 * claude-swap.ts's `pickHeadroomAccount`). Widening `AccountLimitState` to
 * also carry pct would conflate two different staleness rules under one
 * type; this module's own convention (see `AccountBurnState` below) is one
 * type per concern, never merged even where today's shapes happen to
 * overlap.
 */
const ACCOUNT_USAGE_STATE_PREFIX = "account-usage:";
export function accountUsageStateKey(accountName: string): string {
  return `${ACCOUNT_USAGE_STATE_PREFIX}${accountName}`;
}

/** The value stored at accountUsageStateKey(name) — JSON, `fleet_state.value`
 *  is TEXT. Written by the sync route (routes.ts's POST
 *  /studio/accounts/sync) on BOTH a "limit" and a "clear" decision — a
 *  cleared/under-threshold account still has a real pct worth recording for
 *  ordering; only an "unmanaged"/"no-data" decision carries no trustworthy
 *  pct, and writes nothing here. */
export interface AccountUsageSnapshot {
  /** usage.fiveHour.pct, as cswap reported it. */
  fiveHourPct: number;
  /** usage.sevenDay.pct, as cswap reported it. */
  sevenDayPct: number;
  /** max(usage.scoped[].pct), or null when usage.scoped was empty — never 0,
   *  which would wrongly read as "a scoped window exists and it's at 0%". */
  scopedMaxPct: number | null;
  /** When THIS reading was taken, ISO — same seenAt convention as
   *  AccountLimitState, headroom ordering's own 10-minute freshness cutoff is
   *  computed against this, not against when the row was written. */
  seenAt: string;
}

export function encodeAccountUsageSnapshot(s: AccountUsageSnapshot): string {
  return JSON.stringify(s);
}

/** `null` for a key never written, or a value that is not this shape — never
 *  thrown: a corrupt fleet_state row must read as "no usage observed", never
 *  crash a headroom-ordering decision that has nothing to do with writing
 *  it. */
export function decodeAccountUsageSnapshot(raw: string | null): AccountUsageSnapshot | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.fiveHourPct !== "number"
    || typeof p.sevenDayPct !== "number"
    || !("scopedMaxPct" in p) || !(typeof p.scopedMaxPct === "number" || p.scopedMaxPct === null)
    || typeof p.seenAt !== "string"
  ) {
    return null;
  }
  return {
    fiveHourPct: p.fiveHourPct, sevenDayPct: p.sevenDayPct,
    scopedMaxPct: p.scopedMaxPct as number | null, seenAt: p.seenAt,
  };
}

/**
 * The row's words while the limit holds:
 *   - "claude account dead — org disabled subscription access (ff <id>)" —
 *     issue #141: permanent, no clock ever ends it;
 *   - "org monthly spend cap hit — held until month end (ff <id>)" — issue
 *     #336: the org's monthly cap, which no 5h/7d reset ends;
 *   - "rate-limited until 13:30Z" — a readable reset still ahead;
 *   - "limit modal open — Esc to dismiss (ff <id>)" — a select modal, which
 *     no clock ends;
 *   - "rate-limited (reset time not shown)" — an inline block with no
 *     readable reset.
 * `null` when nothing is observed or a printed reset has passed — a stale row
 * must not keep claiming a limit the clock already ended.
 */
export function formatRateLimited(
  rl: RateLimitObservation | null | undefined, now: Date, studioId = "<id>",
): string | null {
  if (!rl) return null;
  if (rl.dead) return `claude account dead — org disabled subscription access (ff ${studioId})`;
  if (rl.spendCap) return `org monthly spend cap hit — held until month end (ff ${studioId})`;
  if (rl.select) return `limit modal open — Esc to dismiss (ff ${studioId})`;
  const until = rl.until === null ? NaN : new Date(rl.until).getTime();
  if (Number.isNaN(until)) return "rate-limited (reset time not shown)";
  if (until <= now.getTime()) return null;
  return `rate-limited until ${formatUntil(new Date(until), now)}`;
}
