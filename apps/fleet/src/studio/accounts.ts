/**
 * Issue #53 — the fleet's claude ACCOUNTS, as an ordered list of Worker
 * secrets.
 *
 * One account was the whole fleet's single point of failure: when it hit its
 * org monthly spend limit on 2026-09-23, every studio parked on claude's
 * `/rate-limit-options` modal at once and a human logged into each container
 * by hand — twice. The requirement that shapes this file is "adding an account
 * is a SECRET WRITE, not a code change", so the list is discovered from the
 * environment by NAME rather than declared anywhere:
 *
 *   CLAUDE_CODE_OAUTH_TOKEN      the first account, unsuffixed — every deploy
 *                                that exists today already has exactly this
 *                                and keeps working unchanged
 *   CLAUDE_CODE_OAUTH_TOKEN_2    the second, _3 the third, up to
 *                                MAX_CLAUDE_ACCOUNTS
 *
 * `wrangler secret put CLAUDE_CODE_OAUTH_TOKEN_2` is the whole procedure.
 *
 * Lives in src/studio/ and imports NOTHING from do.ts (which pulls in
 * "@cloudflare/sandbox"), and deliberately not src/env.ts either. `Env`'s own
 * module type-imports StudioDO, so a file that names `Env` drags do.ts,
 * terminal.ts and the whole workers-types graph behind it, and the bun:test
 * lane (test/tsconfig.json, `"types": ["bun"]`) cannot compile that. The
 * structural parameter type below is what keeps this module — and failover.ts
 * through it — reachable from a test that can ask a real shell what a command
 * actually does. Same boundary reasoning as credentials.ts's own header.
 *
 * Issue #238 (step 3): the ONE exception is `./claude-swap`, imported below
 * for `usageMaxPct` — that module itself imports nothing at all (no do.ts, no
 * D1, no `Env`), so pulling one pure function out of it costs this file
 * nothing it doesn't already pay for its own pure helpers.
 */
import { usageMaxPct, DEFAULT_LIMIT_THRESHOLD_PCT } from "./claude-swap";

/** Just the part of the Worker environment this module reads. `Env`
 *  (src/env.ts) satisfies it structurally, with no cast at any call site. */
export interface ClaudeAccountEnv {
  CLAUDE_CODE_OAUTH_TOKEN: string;
  /** Issue #271: repo -> account slot, JSON (`{"demosite-life":2}`). */
  CLAUDE_ACCOUNT_BY_REPO?: string;
  /** Issue #271: auto-failover runs only when this is exactly "on". */
  FLEET_AUTO_FAILOVER?: string;
  /** Issue #305: an unmapped repo refuses to launch only when this is exactly "on". */
  FLEET_REQUIRE_ACCOUNT_MAP?: string;
}

/** One account: the SECRET'S NAME, and the token it holds. The name is the
 *  operator-visible identity of an account — it is a variable name, never a
 *  credential, so it is safe to log, store on StudioStatus, print in
 *  `fleet ls` and put in a telegram alert. The token is the opposite: it must
 *  never reach any of those. */
export interface ClaudeAccount {
  name: string;
  token: string;
}

/**
 * How many account slots are scanned. A fixed window rather than "scan until
 * the first gap": an operator who deletes CLAUDE_CODE_OAUTH_TOKEN_2 must not
 * silently lose CLAUDE_CODE_OAUTH_TOKEN_3 as well — a gap is a hole in the
 * list, never its end. Nine is arbitrary and deliberately generous; the cost
 * of the window is nine property reads on an object the Worker already holds.
 */
export const MAX_CLAUDE_ACCOUNTS = 9;

/** The secret name for the nth account, 1-based. The first account keeps the
 *  unsuffixed name the fleet has always used — renaming it would have made
 *  this feature a redeploy-and-re-secret migration for every existing studio,
 *  which is exactly the "code change" the requirement rules out. */
export function claudeAccountVarName(position: number): string {
  return position === 1 ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${position}`;
}

/**
 * The ordered account list for this Worker. Order IS the failover order:
 * position 1 first, then 2, then 3.
 *
 * The computed-name reads are isolated behind one `unknown` cast, the same
 * call src/github/auth.ts's `repoToken` already makes for GITHUB_TOKEN_<OWNER>
 * and for the same reason: `Env` is closed on purpose, and widening it with an
 * index signature would stop every other `env.FOO` typo from failing the
 * build. Only CLAUDE_CODE_OAUTH_TOKEN itself is declared on `Env`.
 *
 * Empty string is not an account: `wrangler secret` can hold one, and a studio
 * launched with an empty CLAUDE_CODE_OAUTH_TOKEN starts unauthenticated, which
 * is a worse failure than having one account fewer.
 */
export function resolveClaudeAccounts(env: ClaudeAccountEnv): ClaudeAccount[] {
  const bag = env as unknown as Record<string, string | undefined>;
  const accounts: ClaudeAccount[] = [];
  for (let position = 1; position <= MAX_CLAUDE_ACCOUNTS; position++) {
    const name = claudeAccountVarName(position);
    const token = bag[name];
    if (typeof token === "string" && token.length > 0) accounts.push({ name, token });
  }
  return accounts;
}

/** The account a studio is recorded on (StudioStatus.claudeAccount), or the
 *  first one. `null` is what every studio provisioned before this feature
 *  reads as, and every such studio was launched from the unsuffixed secret by
 *  construction — there was no other possibility — so null resolves to
 *  position 1 rather than to "unknown". */
function currentIndex(accounts: ClaudeAccount[], currentName: string | null | undefined): number {
  if (currentName == null) return 0;
  return accounts.findIndex((a) => a.name === currentName);
}

/**
 * The token to launch a container with. Falls back to the first account when
 * the studio is on no recorded account, or on one whose secret no longer
 * exists — a container must always come up with SOME credential, and the
 * fallback is the same one the fleet used before this feature.
 *
 * Returns "" when no account is configured at all. Empty, not omitted, for the
 * reason studioEnvVars' TS_AUTHKEY already is: `envVars` is string-valued.
 */
export function claudeAccountToken(accounts: ClaudeAccount[], currentName: string | null | undefined): string {
  if (accounts.length === 0) return "";
  const idx = currentIndex(accounts, currentName);
  return (idx >= 0 ? accounts[idx] : accounts[0]).token;
}

/**
 * Issue #102 — one account's fleet-wide-observed limit: the ISO instant it
 * resets, or `null` when a limit was seen but printed no readable reset (an
 * "unknown reset", same as rate-limit.ts's RateLimitObservation.until), and
 * WHEN that sighting was recorded (ISO) — review round 1 (#102 review,
 * 2026-09-30): `seenAt` is what lets `isFree` give a `null`-until entry a
 * staleness ceiling instead of blacklisting the account forever (see
 * NULL_UNTIL_CEILING_MS below). An account with NO entry here has never been
 * seen limited (by ANY studio — see failover.ts's FailoverDeps.accountLimits)
 * and is free.
 */
export interface AccountLimitEntry {
  until: string | null;
  seenAt: string;
  /** Issue #141 — set once an account is confirmed dead (org disabled
   *  subscription access); never expires, unlike a null `until`'s
   *  NULL_UNTIL_CEILING_MS grace below. */
  dead?: true;
}
export type AccountLimits = Record<string, AccountLimitEntry>;

/**
 * RESIDUAL/FIX, review round 1 (#102 review, 2026-09-30) — a `null`-until
 * entry (a select-style modal sighting: it never carries a parseable reset
 * text, see failover.ts's `limitObservation`) used to blacklist an account
 * FOREVER: nothing ever routes a studio back onto it to re-probe whether the
 * underlying limit (a monthly/org spend cap) has actually cleared, since
 * `nextClaudeAccount` skips it on every future wrap. That is exactly the #53
 * incident shape this whole feature exists to fix, made WORSE: a true deadlock
 * with no self-healing path.
 *
 * The fix is a bounded staleness ceiling: a `null`-until entry counts as
 * limited only while `now - seenAt` is within this window; past it, `isFree`
 * treats the account as free again, giving the fleet a chance to re-probe and
 * either observe a fresh sighting with a real reset, or find the account
 * genuinely healthy. 24h, matching failover.ts's own DAY_MS/`firstSighting`
 * day-boundary granularity (this module imports nothing — see this file's own
 * header — so the constant is repeated here, not imported): Claude's
 * documented limits are daily/weekly/monthly, and no more precise a figure for
 * "how long a select-modal limit typically lasts" exists anywhere else in this
 * codebase.
 */
export const NULL_UNTIL_CEILING_MS = 24 * 60 * 60 * 1000;

/**
 * Issue #238 (step 3) — the live-failover-cascade half of headroom ordering.
 * Steps 1+2 (claude-swap.ts, account-usage-store.ts) built the pure
 * comparator and the D1-backed persistence; this is the shape a caller here
 * hands both of them in. Keyed by account NAME (account-usage-store.ts's own
 * `readFleetAccountUsage` return shape) — absent key means "never observed",
 * same "absent means nothing observed" convention `AccountLimits` already
 * uses, never a default/zero entry.
 */
export type AccountUsageMap = Record<
  string,
  { fiveHourPct: number; sevenDayPct: number; scopedMaxPct: number | null; seenAt: string }
>;

/**
 * Issue #238 (step 3) — how old a PERSISTED `account-usage:<slot>` D1 row may
 * be before a live failover decision trusts it enough to reorder candidates
 * by it. Distinct from claude-swap.ts's own `MAX_USAGE_AGE_SECONDS`: that one
 * gates cswap's own self-reported reading age at DECISION time (inside
 * `decideAccountSync`, before a row is even written) — this one gates how
 * stale the row itself has gone since it was written, from a live failover's
 * own point of view, potentially many sync cycles later. Same 10-minute
 * number the plan doc's "fresh (<10 min)" language already specifies.
 */
export const USAGE_ORDERING_FRESHNESS_MS = 10 * 60 * 1000;

/**
 * Maestro review round 2, MINOR 3 — the pct, above which a fresh-but-known
 * candidate must NOT be promoted over a genuinely unknown (no fresh data)
 * one. Only gates "fresh vs no-data": two candidates that BOTH have fresh
 * data are compared on pct alone, regardless of this ceiling (see
 * `selectByHeadroom`'s own doc comment, rule 4 vs rule 5).
 */
const UNKNOWN_PROMOTION_CEILING_PCT = 80;

/**
 * Issue #238 (step 3) — picks the FRESH candidate with the most headroom
 * (lowest `usageMaxPct`) among `candidates`, or null when none has a fresh
 * usage row at all — the caller's own cue to fall back to today's plain
 * order/wrap behaviour unchanged. Never excludes anything itself beyond
 * "stale or missing data": `candidates` is always handed in ALREADY filtered
 * to free (not fleet-wide-limited, not reserved) accounts by the caller
 * (`nextClaudeAccount`/`firstFreeAccount` below), so this can never pick an
 * account carrying a live limit row — it never even sees one.
 *
 * Strict `<` (never `<=`): the FIRST candidate at the best pct seen so far
 * keeps winning a tie, i.e. ties resolve to `candidates`' own order — the
 * forward-wrap/list order every caller already uses as its own fallback, so
 * "current order wins ties" holds whether headroom ordering fired or not.
 *
 * Maestro review round 2, MINOR 3 — a fresh-but-nearly-spent reading must
 * never jump ahead of an UNKNOWN (no fresh data at all) candidate: knowing
 * one account is nearly out of headroom is not a reason to prefer it over one
 * we simply have no fresh reading for (which might be fine). The real
 * algorithm, in full:
 *
 *   1. Partition `candidates` into a "fresh" set (real, fresh usage entry)
 *      and a "rest" set (no entry at all, or stale).
 *   2. Fresh set empty -> null (defer entirely, same as before this fix).
 *   3. Among the fresh set, find the lowest `usageMaxPct` (ties: first in
 *      `candidates`' own order, same rule as always).
 *   4. Rest set EMPTY (every candidate has fresh data, nothing unknown to
 *      defer to instead) -> that best-fresh candidate wins regardless of its
 *      own pct — picking the best of several known quantities is still
 *      correct even when none of them are great.
 *   5. Rest set NON-empty AND best-fresh's own pct is over
 *      `UNKNOWN_PROMOTION_CEILING_PCT` -> null — do not promote a
 *      nearly-spent-but-known account over a genuinely unknown one.
 *   6. Otherwise (rest non-empty, best-fresh's pct at or below the ceiling)
 *      -> that best-fresh candidate wins, same as rule 4.
 */
/**
 * Issue #251 — the NaN-safe "is this usage row fresh enough to trust"
 * check `selectByHeadroom` already had inline, factored out so
 * `freshUnderThresholdAccount` (below, the admission fallback) shares the
 * IDENTICAL staleness rule rather than carrying a second, driftable copy.
 * Maestro review round 2, MINOR 5 (on the original inline version):
 * `Date.parse` on a malformed `seenAt` returns NaN, and `NaN >= freshnessMs`
 * is `false` in JS, so a row with a genuinely unparseable `seenAt` would
 * otherwise survive the filter as if it were fresh — `Number.isFinite(age)`
 * closes that.
 */
function isFreshUsage(
  u: AccountUsageMap[string] | undefined, now: Date, freshnessMs: number,
): u is AccountUsageMap[string] {
  const age = u ? now.getTime() - Date.parse(u.seenAt) : NaN;
  return !!u && Number.isFinite(age) && age < freshnessMs;
}

/**
 * Issue #251 (maestro review) — a usage row can sit inside its own absolute
 * `isFreshUsage` window and STILL predate a newer, more authoritative
 * `account-limit` sighting for the same account: a sync wrote a reading 8
 * minutes ago showing headroom, then 2 minutes ago a live detector wrote a
 * NEWER limit row for that same account. The usage reading is stale RELATIVE
 * TO that newer sighting even though it is still "fresh" on its own clock —
 * same hazard class as #237 finding 6 (a stale-relative-to-a-newer-sighting
 * comparison, not just an absolute staleness check). `freshUnderThresholdAccount`
 * must never rescue onto an account whose newest known signal is the LIMIT,
 * not the usage reading.
 *
 * Same NaN-safe convention `isFreshUsage` above already established: an
 * unparseable `seenAt` on EITHER side (`Date.parse` returning `NaN`) never
 * counts as "newer" — ambiguous data never overrides a limit, the identical
 * "non-finite counts as the unsafe outcome" rule #238's own staleness fix
 * used.
 */
function isUsageNewerThanLimit(usageSeenAt: string, limitSeenAt: string): boolean {
  const usage = Date.parse(usageSeenAt);
  const limit = Date.parse(limitSeenAt);
  return Number.isFinite(usage) && Number.isFinite(limit) && usage > limit;
}

export function selectByHeadroom(
  candidates: ClaudeAccount[], usage: AccountUsageMap, now: Date, freshnessMs: number = USAGE_ORDERING_FRESHNESS_MS,
): ClaudeAccount | null {
  const fresh: { account: ClaudeAccount; pct: number }[] = [];
  let hasRest = false;
  for (const c of candidates) {
    const u = usage[c.name];
    if (isFreshUsage(u, now, freshnessMs)) {
      fresh.push({ account: c, pct: usageMaxPct(u) });
    } else {
      hasRest = true;
    }
  }
  if (fresh.length === 0) return null;
  let best = fresh[0];
  for (const f of fresh.slice(1)) {
    if (f.pct < best.pct) best = f;
  }
  if (hasRest && best.pct > UNKNOWN_PROMOTION_CEILING_PCT) return null;
  return best.account;
}

/**
 * CTO decision 2026-09-30 (issue #102) — the account to fail over TO, or null
 * when every OTHER account is still limited. Superseded rule, stated so the
 * change is legible against #53's original one below: issue #53 shipped
 * FORWARD ONLY with no wrap as its whole anti-loop mechanism, so a studio on
 * the last slot had nowhere to go, and a studio could be handed an account
 * that was itself already exhausted. Both are the bugs #102 fixes.
 *
 * WRAPS, and skips both `currentName` and any account whose fleet-wide limit
 * (`limits`, issue #102 — one record per account, written by ANY studio that
 * hits it, read by every studio's own next failover decision) has not yet
 * reset as of `now`:
 *
 *   - no entry in `limits` for an account: free;
 *   - an entry with a `until` at or before `now`: the reset has passed, free
 *     again — the fleet's own words for the rule ("an account whose reset has
 *     passed counts as free again");
 *   - an entry with `until` still ahead of `now`: limited, skipped;
 *   - an entry with `until: null` (a limit seen with no readable reset, so the
 *     clock can never clear it — a select-style modal sighting, see
 *     failover.ts's `limitObservation`): limited, skipped, UNLESS
 *     `now - seenAt` exceeds NULL_UNTIL_CEILING_MS, in which case it counts as
 *     free again too — review round 1 (#102 review, 2026-09-30), see
 *     NULL_UNTIL_CEILING_MS's own doc comment for why a `null` until must not
 *     blacklist an account forever.
 *
 * Anti-loop is now the limits map, not the list order: an account already
 * limited is skipped on every lap around the list, so a studio can only ever
 * land on one that is, as far as the fleet's own fleet-wide sightings know,
 * currently free — never one already known to be exhausted, wrap or no wrap.
 * `now`/`limits` default so every EXISTING call site (no #102 awareness)
 * keeps behaving as "no fleet-wide limit is known" — i.e. plain wrap.
 *
 * An account name that is NOT in `accounts` (its secret was deleted or
 * renamed while the studio was running on it) still returns null: there is no
 * position to wrap FROM. Degrading and naming the account is the honest
 * answer, same as before #102.
 *
 * Issue #103 — `reserved`: account names that are UNCONDITIONALLY excluded,
 * skipped exactly like a live fleet-wide limit regardless of what `limits`
 * says about them. This is what lets a caller keep a wrap off an account that
 * is some OTHER repo's own `CLAUDE_ACCOUNT_BY_REPO`-mapped primary (see
 * `otherRepoPrimaries` below): that boundary is a fixed reservation, not a
 * limit sighting, so it must hold even for an account nobody has ever seen
 * exhausted. Defaults to empty so every call site written before #103 keeps
 * its old behaviour exactly.
 *
 * Issue #238 (step 3) — `usage`: an OPTIONAL fleet-wide headroom snapshot
 * (account-usage-store.ts's own read shape). Defaults to `{}` so every
 * EXISTING call site keeps the plain forward-wrap behaviour above BYTE
 * IDENTICAL. When non-empty, every free candidate found walking the wrap is
 * collected (same order as before) and handed to `selectByHeadroom`: a fresh
 * usage row picks the one with the most headroom; stale/missing data for
 * every candidate falls back to exactly the first-found-walking-forward
 * account above, i.e. today's behaviour, unchanged.
 */
export function nextClaudeAccount(
  accounts: ClaudeAccount[], currentName: string | null | undefined,
  limits: AccountLimits = {}, now: Date = new Date(), reserved: Set<string> = new Set(),
  usage: AccountUsageMap = {},
): ClaudeAccount | null {
  const idx = currentIndex(accounts, currentName);
  if (idx < 0 || accounts.length === 0) return null;
  const isFree = (a: ClaudeAccount): boolean => !reserved.has(a.name) && accountIsFree(a, limits, now);
  const free: ClaudeAccount[] = [];
  for (let step = 1; step < accounts.length; step++) {
    const candidate = accounts[(idx + step) % accounts.length];
    if (isFree(candidate)) free.push(candidate);
  }
  if (free.length === 0) return null;
  return selectByHeadroom(free, usage, now) ?? free[0];
}

/**
 * Issue #131 (Stage B) — extracted from `nextClaudeAccount`'s own `isFree`
 * closure (its doc comment above states the rule in full: no entry in
 * `limits` is free; a passed `until` is free again; a `null`-until entry is
 * free once `now - seenAt` exceeds NULL_UNTIL_CEILING_MS) so every OTHER
 * caller that needs to ask "is this account free right now" — the borrow
 * second pass's `nextBorrowedAccount` below, and failover.ts's own hand-back
 * check ("is the studio's own primary free again") — judges freeness by the
 * EXACT same rule the first pass always has, never a second, drifting copy
 * of the null-until staleness ceiling. Deliberately does NOT take `reserved`:
 * reservation is a boundary about WHICH studio may use an account, not about
 * whether the account is limited, and the two callers above each apply it (or
 * not) on their own terms.
 */
export function accountIsFree(a: ClaudeAccount, limits: AccountLimits, now: Date): boolean {
  if (!(a.name in limits)) return true;
  const { until, seenAt, dead } = limits[a.name];
  // Issue #141 — dead wins over everything else, unconditionally, regardless
  // of `seenAt` age: a dead account never gets NULL_UNTIL_CEILING_MS's
  // re-probe grace, since nothing about it clears on its own.
  if (dead) return false;
  if (until !== null) return Date.parse(until) <= now.getTime();
  // Review round 1 (#102 review, 2026-09-30) — see NULL_UNTIL_CEILING_MS's
  // own doc comment: a `null` until must not blacklist an account forever.
  return now.getTime() - Date.parse(seenAt) > NULL_UNTIL_CEILING_MS;
}

/**
 * Issue #131 (Stage B) — the borrow second pass. Called ONLY when the first
 * pass (`nextClaudeAccount`, above) already returned null: this studio's own
 * chain is genuinely exhausted, not merely skipped as reserved. Considers
 * ONLY the accounts `reserved` names (every other repo's own mapped primary
 * — accounts.ts's own `otherRepoPrimaries`), filtered to free
 * (`accountIsFree`, the identical rule the first pass uses), and picks the
 * LOWEST 5h-window burn among them — not list order, unlike the first pass's
 * forward wrap, since a borrow has no "next in line" to respect: it is
 * picking the least-loaded account to lean on, a different question than
 * "which account comes next".
 *
 * `burn` mirrors `limits`'s own "absent means nothing observed" shape: an
 * account with no entry in it reads as 0 burn, not excluded — an account
 * nobody has ever mirrored burn for is exactly the kind of account this pass
 * should prefer, not skip. Ties keep the first (list-order) match, same
 * stability rule a plain `<` comparison gives for free.
 */
export function nextBorrowedAccount(
  accounts: ClaudeAccount[], reserved: Set<string>, limits: AccountLimits = {},
  burn: Record<string, { window5hOutput: number }> = {}, now: Date = new Date(),
): ClaudeAccount | null {
  let best: ClaudeAccount | null = null;
  let bestBurn = Infinity;
  for (const a of accounts) {
    if (!reserved.has(a.name)) continue;
    if (!accountIsFree(a, limits, now)) continue;
    const b = burn[a.name]?.window5hOutput ?? 0;
    if (b < bestBurn) { bestBurn = b; best = a; }
  }
  return best;
}

/**
 * Review round 2 (maestro review of PR #135), finding 3/4 — a plain,
 * position-0-inclusive scan in LIST ORDER: the first account in `accounts`
 * that is neither `reserved` (someone else's mapped primary) nor fleet-wide
 * limited. Two different callers in failover.ts share this exact shape for
 * two different reasons:
 *
 *   - finding 3's own tier 2 (the "unclaimed spare" pass, tried BETWEEN the
 *     first pass's own scoped chain and the third pass's reserved-primary
 *     borrow): an account positioned BEFORE this studio's own mapped primary
 *     that is ALSO not reserved for another repo — nobody's primary, a
 *     genuine blind spot neither the first pass (scoped to this studio's own
 *     chain) nor the borrow pass (scoped to `reserved` names only) ever
 *     looks at;
 *   - finding 4's own fallback for the first pass itself, when the studio's
 *     recorded `current` is not a member of `scopedAccounts` at all (an
 *     active borrow positioned before the search anchor): `nextClaudeAccount`
 *     needs a position to step FORWARD from, and an out-of-scope `current`
 *     has none — passing it unchanged returns null immediately (current not
 *     found), and passing `null` (nextClaudeAccount's own "no recorded
 *     account" convention) wrongly SKIPS position 0 (that convention treats
 *     position 0 as "already there"). Neither models "not anywhere in this
 *     list right now, so every position — including the first — is a
 *     genuine candidate", which is exactly what this scan is.
 *
 * List order, not lowest-burn: unlike `nextBorrowedAccount`'s own
 * reserved-primary pass, there is no fairness concern between spares nobody
 * has claimed, or between this studio's own scoped accounts — the first free
 * one wins, same "first match in order" rule the ordinary forward wrap
 * already uses everywhere else in this file.
 *
 * Issue #238 (step 3) — `usage`: same optional headroom snapshot
 * `nextClaudeAccount` now takes, same `{}`-default byte-identical-behaviour
 * guarantee. Every free candidate in list order is collected first, then
 * handed to `selectByHeadroom`; stale/missing data for all of them falls back
 * to the first one found in list order, i.e. today's behaviour.
 */
export function firstFreeAccount(
  accounts: ClaudeAccount[], reserved: Set<string>, limits: AccountLimits = {}, now: Date = new Date(),
  usage: AccountUsageMap = {},
): ClaudeAccount | null {
  const free: ClaudeAccount[] = [];
  for (const a of accounts) {
    if (reserved.has(a.name)) continue;
    if (accountIsFree(a, limits, now)) free.push(a);
  }
  if (free.length === 0) return null;
  return selectByHeadroom(free, usage, now) ?? free[0];
}

/**
 * #211 review round 3, finding 2 — the search anchor/`currentOutOfScope`
 * derivation failover.ts's own `runAccountFailover` has always computed
 * inline (around its own `start`/`currentIdx`/`borrowedActive` locals),
 * factored out so `launchAccountOrReroute` below shares the IDENTICAL
 * formula instead of carrying its own, simplified (and wrong) copy. The
 * launch gate's own copy hardcoded `anchor = start` unconditionally — it
 * never widened backward for a studio recorded on an account from BEFORE
 * the repo was ever mapped to a LATER primary (the "#273 r2" shape) while
 * NOT actively borrowing, so `scopedAccounts` never even contained the
 * recorded account and tier 1 (`nextClaudeAccount`'s own `idx < 0` branch)
 * returned null immediately — a false "every account limited" refusal even
 * when the mapped primary itself was completely free.
 *
 *   - `anchor`: this repo's own mapped primary position (`start`), UNLESS
 *     the studio is NOT actively borrowing anything (`borrowedActive`
 *     false) AND its recorded `current` sits BEFORE `start` — in that case
 *     the anchor widens backward to `current`'s own position, so the
 *     ordinary forward wrap can still reach everything from there through
 *     the primary and beyond. A `current` not found in `accounts` at all
 *     (`currentIdx < 0` — secret deleted/renamed, or no recorded account)
 *     never widens; the primary is the only sane anchor then.
 *   - `currentOutOfScope`: true only while ACTIVELY borrowing an account
 *     positioned before the (unwidened) anchor — the one case `anchor`
 *     deliberately stays PINNED at `start` rather than widening, so the
 *     borrowed-before-primary account is excluded from `scopedAccounts` and
 *     needs the caller's own separate out-of-scope fallback instead.
 *
 * `current: null` reads as position 0 (failover.ts's own convention — a
 * never-switched studio has no recorded account and is on the first slot by
 * construction), never as "not found" — only a NAMED `current` that is
 * genuinely absent from `accounts` reads as not found.
 */
export function deriveSearchAnchor(
  accounts: ClaudeAccount[], start: number, current: string | null, borrowedActive: boolean,
): { anchor: number; currentOutOfScope: boolean } {
  const currentIdx = current == null ? 0 : accounts.findIndex((a) => a.name === current);
  const anchor = borrowedActive ? start : (currentIdx < 0 ? start : Math.min(start, currentIdx));
  const currentOutOfScope = borrowedActive && currentIdx >= 0 && currentIdx < anchor;
  return { anchor, currentOutOfScope };
}

/**
 * Fresh-context review of PR #211 (#209 follow-up) — tiers 1+2 of the
 * three-tier cascade failover.ts's own `runAccountFailover` already runs
 * (its own doc comment, around the `candidate`/`outOfScopeSpare` locals,
 * states the rule in full), factored out so every OTHER caller that needs
 * "where would this studio's own chain send it, falling back to an
 * unclaimed spare before its primary" shares the ONE implementation —
 * `launchAccountOrReroute` below used to carry its own, weaker, tier-1-only
 * copy that silently dropped tier 2 (and tier 3) entirely.
 *
 * Tier 1: `scopedAccounts = accounts.slice(anchor)` — this studio's own
 * chain, from its mapped primary onward (`anchor`'s own meaning, both
 * callers' own `start`/their own anchor-of-the-mapped-primary). `current`
 * steps FORWARD via `nextClaudeAccount` when it is itself a member of
 * `scopedAccounts` (`currentOutOfScope: false`); otherwise there is no
 * position to step forward FROM (failover.ts's own active-borrow-before-
 * anchor case), and `firstFreeAccount` over `scopedAccounts` treats every
 * position — including the first — as a genuine candidate instead.
 *
 * Tier 2, tried ONLY when tier 1 found nothing: `firstFreeAccount` over
 * `accounts.slice(0, anchor)` — an "unclaimed spare" positioned BEFORE this
 * studio's own primary that is ALSO not `reserved` for another repo, in
 * LIST ORDER (never lowest-burn — see `firstFreeAccount`'s own doc comment
 * for why).
 *
 * Returns null when BOTH tiers miss — the caller's own cue to fall through
 * to tier 3 (`nextBorrowedAccount`, already its own shared export, never
 * folded in here: a borrow is a different KIND of pick, lowest-5h-burn
 * rather than list order, and is read from fleet-wide burn lazily, on this
 * rare path only, by callers that have I/O to pay for it — this module
 * stays pure, see its own header).
 *
 * Issue #238 (step 3) — `usage`: threaded unchanged to BOTH of this
 * function's own tier-1/tier-2 calls below (never to the borrow tier, out of
 * scope — see this module's own header for why). Same optional `{}` default,
 * same byte-identical-when-absent guarantee the two functions it calls
 * already give.
 */
export function selectFreeAccount(
  accounts: ClaudeAccount[], anchor: number, current: string | null, currentOutOfScope: boolean,
  reserved: Set<string>, limits: AccountLimits, now: Date, usage: AccountUsageMap = {},
): ClaudeAccount | null {
  const scopedAccounts = accounts.slice(anchor);
  const tier1 = currentOutOfScope
    ? firstFreeAccount(scopedAccounts, reserved, limits, now, usage)
    : nextClaudeAccount(scopedAccounts, current, limits, now, reserved, usage);
  if (tier1 !== null) return tier1;
  return firstFreeAccount(accounts.slice(0, anchor), reserved, limits, now, usage);
}

/**
 * Issue #102 requirement 3 — "all exhausted: … show earliest reset in fleet
 * ls". The earliest `until` among `accounts` that `limits` records as
 * currently limited as of `now`, or null when none of them have a readable
 * reset (every live limit is `until: null`) or none are limited at all.
 * Called only once `nextClaudeAccount` has already found nowhere to go, so
 * every account this looks at is, by construction, still limited.
 */
export function earliestAccountReset(
  accounts: ClaudeAccount[], limits: AccountLimits, now: Date,
): string | null {
  let earliest: string | null = null;
  for (const a of accounts) {
    if (!(a.name in limits)) continue;
    const { until } = limits[a.name];
    if (until === null || Date.parse(until) <= now.getTime()) continue;
    if (earliest === null || Date.parse(until) < Date.parse(earliest)) earliest = until;
  }
  return earliest;
}

/**
 * Issue #251 — the same scan as `earliestAccountReset` above, but carrying
 * the NAME of the account that reset belongs to as well. A separate
 * function rather than widening that one's own return shape: failover.ts's
 * own caller (`earliestReset`, around its own `parkedOn`/`exhaustedMessage`)
 * only ever wants the bare string, and this file's header rule is "never a
 * second, drifting copy of a formula" — not "never a second caller of the
 * same scan with a different return shape" — so this stays its own small
 * function rather than forcing an unrelated caller to carry a name it would
 * just discard. Used only by `launchAccountOrReroute`'s own refusal message
 * below, so an operator reading "every account limited" knows WHICH account
 * to watch, not just when.
 */
function accountWithEarliestReset(
  accounts: ClaudeAccount[], limits: AccountLimits, now: Date,
): { name: string; until: string } | null {
  let best: { name: string; until: string } | null = null;
  for (const a of accounts) {
    if (!(a.name in limits)) continue;
    const { until } = limits[a.name];
    if (until === null || Date.parse(until) <= now.getTime()) continue;
    if (best === null || Date.parse(until) < Date.parse(best.until)) best = { name: a.name, until };
  }
  return best;
}

/**
 * Issue #251 — the admission-time rescue for a stale `account-limit` row: a
 * fresh (<USAGE_ORDERING_FRESHNESS_MS) `account-usage` reading that already
 * disagrees with a D1 limit row this studio's own tiers 1-3 (selectFreeAccount,
 * nextBorrowedAccount) just read as still limited. A 5h-window reset clears
 * the ACCOUNT before any studio's `fleet accounts sync` corrects the row
 * that recorded it — the bug this whole fix exists for (#251: `fleet
 * provision`/`fleet recycle` answered "409 every account limited" while
 * `fleet accounts` already showed the mapped slot at 14%).
 *
 * Only called once every ordinary tier has already missed — see
 * `launchAccountOrReroute`'s own call site, immediately before it would
 * build the "every account limited" refusal — so this never second-guesses
 * an account `accountIsFree` already calls free (that path already works
 * unchanged); it only rescues one D1 STILL calls limited when a fresher
 * reading already knows better. Admits for THIS decision only — nothing is
 * written back to D1, `fleet accounts sync` remains the thing that corrects
 * the stale row itself; this just stops admission from trusting a row sync's
 * own last reading already disagrees with.
 *
 * Qualifies: never `dead` (issue #141 — a permanently dead account has no
 * working subscription at all; a fresh, under-threshold usage reading can
 * never speak to that, so this exclusion is unconditional and checked before
 * `accountIsFree`, not folded into it), not already free (`accountIsFree` —
 * nothing to rescue otherwise), not `reserved` (same exclusion every other
 * selection function in this file already respects), a fresh usage entry
 * (`isFreshUsage`, the IDENTICAL staleness rule `selectByHeadroom` uses —
 * one copy, not two that could drift), STRICTLY NEWER than the limit row's
 * own `seenAt` for that same account (`isUsageNewerThanLimit` — maestro
 * review: a usage reading fresh on its own absolute clock can still predate
 * a newer, more authoritative limit sighting, same hazard class as #237
 * finding 6), and `usageMaxPct` strictly below `DEFAULT_LIMIT_THRESHOLD_PCT`
 * (claude-swap.ts, 95 — the same number `decideAccountSync` itself uses to
 * call an account limited vs clear, imported rather than re-hardcoded).
 *
 * Among qualifying candidates the lowest `usageMaxPct` wins (ties: first in
 * `accounts`' own order) — same tie-breaking spirit as `selectByHeadroom`.
 * `null` when nothing qualifies, the caller's own cue to fall through to the
 * ordinary refusal exactly as before this fix.
 */
export function freshUnderThresholdAccount(
  accounts: ClaudeAccount[], limits: AccountLimits, usage: AccountUsageMap, now: Date, reserved: Set<string>,
): ClaudeAccount | null {
  let best: { account: ClaudeAccount; pct: number } | null = null;
  for (const a of accounts) {
    if (reserved.has(a.name)) continue;
    // Issue #251 review — `accountIsFree` returning false folds two different
    // reasons into one boolean: genuinely rate-limited (this rescue's whole
    // point) and `dead` (issue #141: a permanently dead account, no working
    // subscription at all). A fresh, under-threshold usage reading says
    // nothing about a dead account's actual problem, so `dead` must be
    // excluded unconditionally, before ever reaching the free/limited check.
    if (limits[a.name]?.dead) continue;
    if (accountIsFree(a, limits, now)) continue;
    const u = usage[a.name];
    if (!isFreshUsage(u, now, USAGE_ORDERING_FRESHNESS_MS)) continue;
    // Issue #251 (maestro review) — fresh on its own clock is not enough: the
    // usage reading must also be NEWER than the limit sighting it is about to
    // override, or it is stale relative to that newer, more authoritative
    // signal. See `isUsageNewerThanLimit`'s own doc comment.
    if (!isUsageNewerThanLimit(u.seenAt, limits[a.name].seenAt)) continue;
    const pct = usageMaxPct(u);
    if (pct >= DEFAULT_LIMIT_THRESHOLD_PCT) continue;
    if (best === null || pct < best.pct) best = { account: a, pct };
  }
  return best?.account ?? null;
}

/** Every account this studio has been on, in order, up to and including the
 *  one it is on now — what the degraded message and the operator alert name.
 *  An unknown current account (secret deleted) is reported as itself, so the
 *  operator sees the name that no longer resolves. */
export function accountsTried(accounts: ClaudeAccount[], currentName: string | null | undefined): string[] {
  const idx = currentIndex(accounts, currentName);
  if (idx < 0) return currentName == null ? [] : [currentName];
  return accounts.slice(0, idx + 1).map((a) => a.name);
}

/**
 * Issue #271 — a static PRIMARY account per repo. One account capped the whole
 * fleet (91% of its session limit at 08:2xZ, 2026-09-25), and adding a second
 * secret used to ARM auto-failover for every studio, which the detector is not
 * yet safe for (#239 review). A repo -> slot map needs no detector: studios of
 * repo X launch on account N, and nothing is killed or relaunched.
 *
 * `CLAUDE_ACCOUNT_BY_REPO` is a Worker VAR holding JSON keyed by the repo
 * segment of a studio id (`{"demosite-life":2}`), not a fleet.json field: the
 * launch env is built synchronously at DO construction, where fleet.json would
 * cost a GitHub read, and a map change is then a var edit, not a commit to the
 * fleet repo. It names slots, never tokens, so it is not a secret.
 *
 * Absent or empty: no map, every repo on the first SET account. Bad JSON, or an
 * entry that is not a slot 1..MAX_CLAUDE_ACCOUNTS: dropped and LOGGED
 * (console.error), the rest stand — a typo must be visible in a tail, never a
 * silent move. A KEY that can never match a studio (not a studio-id repo
 * segment: upper case, `owner/name`, spaces) is WARNED once per parse, by
 * name, and dropped (#273 review round 2).
 */
/** The repo half of a studio id — ids.ts's SEGMENT, repeated here because this
 *  module imports nothing (see its header). */
const REPO_SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseAccountMap(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`claude account: CLAUDE_ACCOUNT_BY_REPO is not valid JSON — every repo on the first set account`, err instanceof Error ? err.message : err);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("claude account: CLAUDE_ACCOUNT_BY_REPO must be a JSON object of repo -> slot — every repo on the first set account");
    return {};
  }
  const map: Record<string, number> = {};
  for (const [repo, slot] of Object.entries(parsed)) {
    if (!REPO_SEGMENT_RE.test(repo)) {
      console.warn(`claude account: CLAUDE_ACCOUNT_BY_REPO key ${JSON.stringify(repo)} can never match a studio (keys are the repo part of <repo>--<role>, lower case) — ignored`);
      continue;
    }
    if (typeof slot === "number" && Number.isInteger(slot) && slot >= 1 && slot <= MAX_CLAUDE_ACCOUNTS) {
      map[repo] = slot;
    } else {
      console.error(`claude account: CLAUDE_ACCOUNT_BY_REPO entry ${JSON.stringify(repo)} is not a slot 1-${MAX_CLAUDE_ACCOUNTS} — ignored, that repo stays on the first set account`);
    }
  }
  return map;
}

/**
 * Review round 3 (2nd review of PR #135, 2026-09-30) — true only when `repo`
 * is a genuine KEY in the parsed `CLAUDE_ACCOUNT_BY_REPO` map, never merely
 * because `launchAccount`/`primaryAccount` resolved to SOME account (they
 * always do, mapped or not — see `launchAccount`'s own "first set account"
 * fallback). See failover.ts's `FailoverDeps.primaryIsMapped` for the full
 * reasoning this exists to satisfy.
 *
 * Fresh-context review of PR #211, finding 3 — extracted so do.ts's
 * `borrowFields` and `StudioDO.primaryIsMapped()` share the ONE
 * implementation rather than each carrying its own hand-copy of this same
 * formula.
 */
export function primaryIsMapped(env: ClaudeAccountEnv, repo: string | null): boolean {
  return repo !== null && parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO)[repo] !== undefined;
}

/**
 * Issue #103 — the cross-repo boundary a wrap-around search must never
 * cross: every account `CLAUDE_ACCOUNT_BY_REPO` maps to some OTHER repo,
 * named as its secret. #271's own scoping (failover.ts's `scopedAccounts`)
 * only ever excludes accounts BEFORE the CALLING studio's own mapped
 * primary, walking backward from where it starts; nothing stopped a wrap
 * from walking FORWARD onto an account reserved for a different repo
 * entirely, four slots away, that repo's own primary and nobody else's to
 * use. Fed to `nextClaudeAccount`'s `reserved` param, which skips a name in
 * it unconditionally — same treatment as a live fleet-wide limit.
 *
 * `ownRepo`'s OWN mapped SLOT is never in the result — exclusion is by slot
 * NUMBER, not by repo key: a repo's own primary is exactly where it starts
 * and is free to land back on (the whole point of the #103 fix — wrap back
 * to it rather than steal someone else's), and that stays true even if the
 * map also (invalidly) assigns some OTHER repo key to that same slot number
 * — a collision does not make a repo's own primary reservable against
 * itself. `null`, or a repo the map does not mention, reserves every mapped
 * slot: an unmapped caller has no "own" slot to exempt, so every entry in
 * the map belongs to some OTHER repo from its point of view.
 */
export function otherRepoPrimaries(env: ClaudeAccountEnv, ownRepo: string | null): Set<string> {
  const map = parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO);
  const ownSlot = ownRepo !== null ? map[ownRepo] : undefined;
  const reserved = new Set<string>();
  for (const slot of Object.values(map)) {
    if (slot === ownSlot) continue;
    reserved.add(claudeAccountVarName(slot));
  }
  return reserved;
}

/**
 * Issue #131 (Stage B) — the reverse of `otherRepoPrimaries`: which repo (if
 * any) `CLAUDE_ACCOUNT_BY_REPO` maps `name`'s slot to. Used ONLY for naming a
 * borrowed account in an operator-facing message (failover.ts's
 * `borrowedMessage`) — never for a failover DECISION, which stays keyed on
 * the `otherRepoPrimaries` SET alone. `null` for an unmapped slot, a name
 * outside the list, or an absent/empty map — the caller then falls back to
 * naming the account alone, same as `accountDisplay` does for an unlabelled
 * one.
 */
export function repoForAccount(env: ClaudeAccountEnv, name: string): string | null {
  const slot = slotOf(name);
  if (slot === null) return null;
  const map = parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO);
  for (const [repo, s] of Object.entries(map)) {
    if (s === slot) return repo;
  }
  return null;
}

/** Issue #271: auto-failover is OFF unless FLEET_AUTO_FAILOVER is exactly "on". */
export function autoFailoverOn(env: ClaudeAccountEnv): boolean {
  return env.FLEET_AUTO_FAILOVER === "on";
}

/** Issue #305: strict mode is OFF unless FLEET_REQUIRE_ACCOUNT_MAP is exactly "on". */
export function requireAccountMapOn(env: ClaudeAccountEnv): boolean {
  return env.FLEET_REQUIRE_ACCOUNT_MAP === "on";
}

/**
 * PR #307 review round 1: when a limited account frees up again, as epoch ms
 * -- `until`, or for a null `until` the NULL_UNTIL_CEILING_MS re-probe point
 * (`accountIsFree`'s own rule). `null` for a dead account: it never resets.
 */
function limitResetAt(entry: AccountLimitEntry): number | null {
  if (entry.dead) return null;
  const at = entry.until !== null ? Date.parse(entry.until) : Date.parse(entry.seenAt) + NULL_UNTIL_CEILING_MS;
  return Number.isFinite(at) ? at : null;
}

/** PR #307 review round 1: the limited account that resets soonest, or null
 *  when none of them has a known reset (all dead). Ties keep slot order. */
function soonestResetAccount(
  accounts: ClaudeAccount[], limits: AccountLimits,
): { account: ClaudeAccount; resetAt: number } | null {
  let best: { account: ClaudeAccount; resetAt: number } | null = null;
  for (const a of accounts) {
    const entry = limits[a.name];
    const at = entry === undefined ? null : limitResetAt(entry);
    if (at !== null && (best === null || at < best.resetAt)) best = { account: a, resetAt: at };
  }
  return best;
}

/**
 * Issue #305: where an UNMAPPED repo lands. Was always `accounts[0]`, so a
 * new repo inherited slot 1 even when slot 1 was at its weekly limit, and the
 * only symptom was the limit modal on the lead's pane. Now:
 *   1. Only FREE accounts (`accountIsFree` over the `account-limit` rows --
 *      PR #307 review round 1: usage alone missed a limited slot 1 whose
 *      usage row was missing or stale).
 *   2. Among them, the most headroom by fresh `account-usage` rows
 *      (`selectByHeadroom`, the same rule failover uses), kept off other
 *      repos' mapped primaries (`reserved`) while any unreserved free account
 *      exists. No fresh usage: the first free account in slot order.
 *   3. Every account limited: the one that resets soonest (`accountResolution`
 *      says so). None with a known reset (all dead): the first set account.
 */
export function unmappedFallbackAccount(
  accounts: ClaudeAccount[], reserved: Set<string>, usage: AccountUsageMap, now: Date, limits: AccountLimits = {},
): ClaudeAccount | null {
  if (accounts.length === 0) return null;
  const free = accounts.filter((a) => accountIsFree(a, limits, now));
  if (free.length === 0) return soonestResetAccount(accounts, limits)?.account ?? accounts[0];
  const open = free.filter((a) => !reserved.has(a.name));
  const pool = open.length > 0 ? open : free;
  return selectByHeadroom(pool, usage, now) ?? pool[0];
}

/**
 * Issue #305: one line saying which account a studio launched on and WHY —
 * what `fleet spawn`/`fleet provision` print. `null` when no account is
 * known (refused launch, glm lead, or a start whose account was not read
 * back). Names slots and keys only, never a token.
 */
export function accountResolution(
  env: ClaudeAccountEnv, repo: string | null, launched: string | null | undefined,
  limits: AccountLimits = {}, now: Date = new Date(),
): string | null {
  if (launched == null) return null;
  const slot = slotOf(launched);
  const mapped = repo === null ? undefined : parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO)[repo];
  if (mapped !== undefined) {
    return mapped === slot
      ? `mapped (CLAUDE_ACCOUNT_BY_REPO ${JSON.stringify(repo)}: ${mapped})`
      : `mapped to slot ${mapped}, launched on slot ${slot ?? "?"} (failover/reroute)`;
  }
  const key = JSON.stringify(repo ?? "<repo>");
  const why = `UNMAPPED, fell back to slot ${slot ?? "?"} — add ${key}: <slot> to CLAUDE_ACCOUNT_BY_REPO ` +
    "(key is the studio-id repo prefix, bare repo name, not owner/repo)";
  // PR #307 review round 1: the fallback only lands on a limited account when
  // every account is limited (unmappedFallbackAccount step 3) -- say so.
  const entry = limits[launched];
  const accounts = resolveClaudeAccounts(env);
  const on = accounts.find((a) => a.name === launched);
  if (entry === undefined || on === undefined || accountIsFree(on, limits, now)) return why;
  if (accounts.some((a) => accountIsFree(a, limits, now))) return `${why}; slot ${slot ?? "?"} is limited`;
  const soonest = soonestResetAccount(accounts.filter((a) => !accountIsFree(a, limits, now)), limits);
  return soonest === null
    ? `${why}; every account limited, soonest reset unknown`
    : `${why}; every account limited, soonest reset ${new Date(soonest.resetAt).toISOString()} (slot ${slotOf(soonest.account.name) ?? "?"})`;
}

export type LaunchAccount = { ok: true; name: string; token: string } | { ok: false; error: string };

/** Issue #217: every `LaunchAccount` refusal (`{ ok: false, error }`) above
 *  feeds do.ts's `LaunchRefusedError`, thrown from INSIDE the StudioDO —
 *  Workers RPC keeps an error's message across that boundary but not its
 *  class (confirmed: every RPC-crossing throw this codebase simulates in a
 *  test does `Object.assign(new Error(message), { remote: true })`, a plain
 *  `Error`, never the real subclass). A prefix is therefore the only thing
 *  routes.ts can reliably recognise a launch refusal by once it has crossed
 *  that boundary — same convention `RECYCLE_REFUSED_PREFIX` (recycle-cost.ts)
 *  already established for recycle's own refusal. Lives here (not do.ts,
 *  which pulls in "@cloudflare/sandbox" — see this file's own header) so
 *  routes.ts can import it directly, the same reason account-limits-store.ts
 *  exists as its own module. */
export const LAUNCH_REFUSED_PREFIX = "launch refused: ";

/**
 * Issue #271: the account a studio of `repo` launches on.
 *
 *   - Auto-failover ON and the studio is RECORDED on an account that still
 *     exists: that account (#53 — a studio that failed over comes back up on
 *     the account it moved to).
 *   - Otherwise the repo's mapped slot, or when unmapped the FIRST SET
 *     account in slot order (normally CLAUDE_CODE_OAUTH_TOKEN). With
 *     failover off nothing ever moves a studio, so a restart is how a map
 *     change reaches it.
 *   - A MAPPED slot whose secret is not set REFUSES, never falls back: account
 *     1 would silently carry the other repo's load, the starvation the map
 *     exists to stop.
 *   - Unmapped with no account at all: token "" — today's behaviour.
 *   - Issue #305: unmapped with FLEET_REQUIRE_ACCOUNT_MAP=on REFUSES, naming
 *     the key to add. The first-set fallback here is only the pure, sync
 *     answer; the launch gate (`launchAccountOrReroute`) swaps it for the
 *     most-headroom account when usage rows are fresh.
 */
export function launchAccount(env: ClaudeAccountEnv, repo: string | null, recorded: string | null | undefined): LaunchAccount {
  const accounts = resolveClaudeAccounts(env);
  if (autoFailoverOn(env) && recorded != null) {
    const on = accounts.find((a) => a.name === recorded);
    if (on) return { ok: true, name: on.name, token: on.token };
  }
  const slot = repo === null ? undefined : parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO)[repo];
  if (slot === undefined && repo !== null && requireAccountMapOn(env)) {
    return {
      ok: false,
      error:
        `claude account: ${repo} has no CLAUDE_ACCOUNT_BY_REPO entry and FLEET_REQUIRE_ACCOUNT_MAP=on — refusing to launch. ` +
        `Add the key ${JSON.stringify(repo)} (the studio-id repo prefix, bare repo name, not owner/repo): ` +
        `CLAUDE_ACCOUNT_BY_REPO={..., ${JSON.stringify(repo)}: <slot>}`,
    };
  }
  if (slot === undefined) {
    const first = accounts[0];
    return first ? { ok: true, name: first.name, token: first.token } : { ok: true, name: claudeAccountVarName(1), token: "" };
  }
  const name = claudeAccountVarName(slot);
  const mapped = accounts.find((a) => a.name === name);
  if (!mapped) {
    return {
      ok: false,
      error:
        `claude account: ${repo} is mapped to ${name} (CLAUDE_ACCOUNT_BY_REPO), and that secret is not set — ` +
        `refusing to launch rather than fall back to another account. Set it: wrangler secret put ${name}`,
    };
  }
  return { ok: true, name: mapped.name, token: mapped.token };
}

/**
 * Issue #209 — `launchAccount` (above) resolves the mapped slot, or a
 * RECORDED failed-over account, UNCONDITIONALLY: it never consults the
 * fleet-wide `AccountLimits` map (issue #102's `accountIsFree`) at all. A
 * repo mapped to a slot the fleet already recorded as limited — or a
 * studio recorded on one — still launched straight onto it, into the
 * weekly-limit modal, every time provision/restart/recycle ran.
 *
 * Wraps `launchAccount` with exactly that one extra check: if the account it
 * resolved to is free, `launchAccount`'s own answer stands COMPLETELY
 * unchanged — this never touches that function's own behaviour (see its own
 * tests, including the "(#53, unchanged)" one). If it is limited, this runs
 * the SAME three-tier cascade `runAccountFailover` (failover.ts) already
 * runs for an ALREADY-RUNNING studio, so the two never disagree about where
 * a studio may land:
 *
 *   - tiers 1+2 via the shared `selectFreeAccount` above (this repo's own
 *     scoped chain, forward from the resolved account, then an unclaimed
 *     spare before this repo's own mapped primary) — fresh-context review
 *     of PR #211 found the ORIGINAL version of this function carried its
 *     own weaker, tier-1-only copy of that cascade (a plain `nextClaudeAccount`
 *     over the FULL, unscoped account list) that silently dropped tier 2
 *     (and tier 3, below) entirely: a repo whose own chain was fully limited
 *     refused the whole launch with "every account limited" even when
 *     another repo's own reserved primary — or a plain unclaimed spare — was
 *     genuinely free right now;
 *   - tier 3, tried only once tiers 1+2 both miss: `nextBorrowedAccount`
 *     (already its own shared export, no wrapper needed), fed fleet-wide 5h
 *     burn via `readBurn` — read LAZILY, only on this already-rare path,
 *     exactly as failover.ts's own `deps.accountBurn.read()` is. Async for
 *     exactly that one reason; every other branch above resolves
 *     synchronously and this function stays pure either way (no I/O of its
 *     own — `readBurn` is the caller's own callback, same shape
 *     `FailoverDeps.accountBurn.read` already is).
 *
 * REFUSES — same `{ ok: false, error }` shape `launchAccount`'s own refusal
 * already uses — only once ALL THREE tiers miss, naming the earliest reset
 * (`earliestAccountReset`, over the full account list, matching this
 * function's own pre-existing behaviour and tests) an operator reading the
 * degraded row can expect a studio back by.
 *
 * `start`: this repo's own mapped primary position (`launchAccount(env,
 * repo, null)`'s own resolution, the identical "mapped slot, or the first
 * set account" rule `primaryAccount()` (do.ts) already uses), or 0 when that
 * cannot itself launch. `anchor`/`currentOutOfScope` (#211 review round 3,
 * finding 2 — the ORIGINAL version of this function hardcoded `anchor =
 * start` unconditionally, never widening backward for a studio recorded on
 * an account from BEFORE the repo was ever mapped to a LATER primary, which
 * false-refused "every account limited" even when the primary itself was
 * free) are now `deriveSearchAnchor`'s own shared formula — see that
 * function's own doc comment for the full anchor-widening/
 * currentOutOfScope-pinning rule, identical to failover.ts's own
 * `runAccountFailover` derivation. `borrowedAccount != null` (this studio IS
 * actively borrowing something, caller-supplied, the same
 * `existing.borrowedAccount` failover.ts's own `borrowedActive` reads) is
 * the `borrowedActive` input.
 *
 * Gated on `autoFailoverOn(env)`, same as every other reroute/switch
 * mechanism in this file: with failover off nothing ever moves a studio
 * away from its mapped primary (see `launchAccount`'s own doc comment,
 * and `autoFailoverOn`'s) — a restart is the documented way an operator's
 * own map edit reaches it, and this function must not quietly override
 * that. The caller (do.ts's `launchAccountOrRefuse`) is the one that reads
 * D1 for `limits`/burn, and only when `autoFailoverOn(env)` is already true
 * — this function's own check is a second, redundant guard, not the only
 * one, so a caller that forgets the outer gate still cannot make this
 * reroute.
 *
 * Issue #238 (step 3) — `usage`: threaded unchanged to the tiers-1+2
 * `selectFreeAccount` call below only (never to the tier-3 borrow pass,
 * out of scope — see this module's own header). Same optional `{}` default,
 * same byte-identical-when-absent guarantee.
 */
export async function launchAccountOrReroute(
  env: ClaudeAccountEnv, repo: string | null, recorded: string | null | undefined,
  limits: AccountLimits, reserved: Set<string>, now: Date = new Date(),
  borrowedAccount: string | null | undefined = null,
  readBurn: () => Promise<Record<string, { window5hOutput: number }>> = async () => ({}),
  usage: AccountUsageMap = {},
): Promise<LaunchAccount> {
  let launch = launchAccount(env, repo, recorded);
  const accounts = resolveClaudeAccounts(env);
  // Issue #305: an unmapped repo's plain first-set fallback becomes the
  // most-headroom FREE account (limit rows honoured, PR #307 round 1) — with
  // failover off too, since that fallback is not a failover. A recorded
  // account honoured above (flag on) stays put, strict mode or not.
  const honouredRecorded = autoFailoverOn(env) && recorded != null && accounts.some((a) => a.name === recorded);
  if (launch.ok && !primaryIsMapped(env, repo) && !honouredRecorded) {
    const pick = unmappedFallbackAccount(accounts, reserved, usage, now, limits);
    if (pick !== null) launch = { ok: true, name: pick.name, token: pick.token };
  }
  if (!launch.ok || !autoFailoverOn(env)) return launch;
  const resolved = accounts.find((a) => a.name === launch.name);
  if (resolved === undefined || accountIsFree(resolved, limits, now)) return launch;
  const primary = launchAccount(env, repo, null);
  const start = primary.ok ? Math.max(0, accounts.findIndex((a) => a.name === primary.name)) : 0;
  const { anchor, currentOutOfScope } = deriveSearchAnchor(accounts, start, launch.name, borrowedAccount != null);
  const free = selectFreeAccount(accounts, anchor, launch.name, currentOutOfScope, reserved, limits, now, usage);
  if (free !== null) return { ok: true, name: free.name, token: free.token };
  const borrowed = nextBorrowedAccount(accounts, reserved, limits, await readBurn(), now);
  if (borrowed !== null) return { ok: true, name: borrowed.name, token: borrowed.token };
  // Issue #251 — the last chance before refusing: a fresh account-usage
  // reading that already contradicts a stale D1 account-limit row. See
  // `freshUnderThresholdAccount`'s own doc comment for the full rule.
  const rescue = freshUnderThresholdAccount(accounts, limits, usage, now, reserved);
  if (rescue !== null) return { ok: true, name: rescue.name, token: rescue.token };
  const earliest = accountWithEarliestReset(accounts, limits, now);
  return {
    ok: false,
    error: earliest === null
      ? `claude account: every account limited; earliest reset unknown -- try 'fleet accounts sync' first`
      : `claude account: every account limited; earliest reset ${earliest.until} (${earliest.name}) -- try 'fleet accounts sync' first`,
  };
}

/** The slot a secret name holds, or null for a name outside the list. */
function slotOf(name: string): number | null {
  for (let position = 1; position <= MAX_CLAUDE_ACCOUNTS; position++) {
    if (claudeAccountVarName(position) === name) return position;
  }
  return null;
}

/**
 * Issue #271: the operator's optional NON-SECRET label for an account,
 * `CLAUDE_ACCOUNT_<n>_LABEL` (an email, say). Read only for display; it is
 * never a token and resolveClaudeAccounts never reads it.
 */
export function accountLabel(env: ClaudeAccountEnv, name: string): string | null {
  const slot = slotOf(name);
  if (slot === null) return null;
  const label = (env as unknown as Record<string, string | undefined>)[`CLAUDE_ACCOUNT_${slot}_LABEL`];
  return typeof label === "string" && label.trim() !== "" ? label.trim() : null;
}

/** `<label> (<secret name>)`, or the secret name alone when unlabelled. */
export function accountDisplay(env: ClaudeAccountEnv, name: string): string {
  const label = accountLabel(env, name);
  return label === null ? name : `${label} (${name})`;
}
