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
 * Lives in src/studio/ and imports NOTHING — not do.ts (which pulls in
 * "@cloudflare/sandbox"), and deliberately not src/env.ts either. `Env`'s own
 * module type-imports StudioDO, so a file that names `Env` drags do.ts,
 * terminal.ts and the whole workers-types graph behind it, and the bun:test
 * lane (test/tsconfig.json, `"types": ["bun"]`) cannot compile that. The
 * structural parameter type below is what keeps this module — and failover.ts
 * through it — reachable from a test that can ask a real shell what a command
 * actually does. Same boundary reasoning as credentials.ts's own header.
 */

/** Just the part of the Worker environment this module reads. `Env`
 *  (src/env.ts) satisfies it structurally, with no cast at any call site. */
export interface ClaudeAccountEnv {
  CLAUDE_CODE_OAUTH_TOKEN: string;
  /** Issue #271: repo -> account slot, JSON (`{"demosite-life":2}`). */
  CLAUDE_ACCOUNT_BY_REPO?: string;
  /** Issue #271: auto-failover runs only when this is exactly "on". */
  FLEET_AUTO_FAILOVER?: string;
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
const NULL_UNTIL_CEILING_MS = 24 * 60 * 60 * 1000;

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
 */
export function nextClaudeAccount(
  accounts: ClaudeAccount[], currentName: string | null | undefined,
  limits: AccountLimits = {}, now: Date = new Date(), reserved: Set<string> = new Set(),
): ClaudeAccount | null {
  const idx = currentIndex(accounts, currentName);
  if (idx < 0 || accounts.length === 0) return null;
  const isFree = (a: ClaudeAccount): boolean => !reserved.has(a.name) && accountIsFree(a, limits, now);
  for (let step = 1; step < accounts.length; step++) {
    const candidate = accounts[(idx + step) % accounts.length];
    if (isFree(candidate)) return candidate;
  }
  return null;
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
 */
export function firstFreeAccount(
  accounts: ClaudeAccount[], reserved: Set<string>, limits: AccountLimits = {}, now: Date = new Date(),
): ClaudeAccount | null {
  for (const a of accounts) {
    if (reserved.has(a.name)) continue;
    if (accountIsFree(a, limits, now)) return a;
  }
  return null;
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
 */
export function selectFreeAccount(
  accounts: ClaudeAccount[], anchor: number, current: string | null, currentOutOfScope: boolean,
  reserved: Set<string>, limits: AccountLimits, now: Date,
): ClaudeAccount | null {
  const scopedAccounts = accounts.slice(anchor);
  const tier1 = currentOutOfScope
    ? firstFreeAccount(scopedAccounts, reserved, limits, now)
    : nextClaudeAccount(scopedAccounts, current, limits, now, reserved);
  if (tier1 !== null) return tier1;
  return firstFreeAccount(accounts.slice(0, anchor), reserved, limits, now);
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

export type LaunchAccount = { ok: true; name: string; token: string } | { ok: false; error: string };

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
 */
export function launchAccount(env: ClaudeAccountEnv, repo: string | null, recorded: string | null | undefined): LaunchAccount {
  const accounts = resolveClaudeAccounts(env);
  if (autoFailoverOn(env) && recorded != null) {
    const on = accounts.find((a) => a.name === recorded);
    if (on) return { ok: true, name: on.name, token: on.token };
  }
  const slot = repo === null ? undefined : parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO)[repo];
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
 * `anchor`: this repo's own mapped primary position (`launchAccount(env,
 * repo, null)`'s own resolution, the identical "mapped slot, or the first
 * set account" rule `primaryAccount()` (do.ts) already uses), or 0 when that
 * cannot itself launch.
 *
 * `currentOutOfScope` (fresh-context review of PR #211, finding 1 — the
 * ORIGINAL version of this function hardcoded this `false` unconditionally,
 * which disabled tier 1 ENTIRELY for a studio restarting while actively
 * borrowing an account positioned BEFORE its own primary: `scopedAccounts`
 * never contains that account, so `nextClaudeAccount`'s own `idx < 0` branch
 * returned null immediately, and `accounts.slice(0, anchor)` — tier 2 — never
 * covers the in-scope chain either, so a genuinely free in-scope account was
 * skipped entirely in favour of an unnecessary tier-3 borrow, or an outright
 * refusal): derived the identical way failover.ts's own `runAccountFailover`
 * already does — `borrowedAccount != null` (this studio IS actively
 * borrowing something, caller-supplied, the same `existing.borrowedAccount`
 * failover.ts's own `borrowedActive` reads) AND the resolved account's own
 * position is BEFORE `anchor`. Every other studio (never borrowed, or
 * borrowed onto something at/after its own primary) computes `false` here,
 * same as the function's pre-existing behaviour and tests.
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
 */
export async function launchAccountOrReroute(
  env: ClaudeAccountEnv, repo: string | null, recorded: string | null | undefined,
  limits: AccountLimits, reserved: Set<string>, now: Date = new Date(),
  borrowedAccount: string | null | undefined = null,
  readBurn: () => Promise<Record<string, { window5hOutput: number }>> = async () => ({}),
): Promise<LaunchAccount> {
  const launch = launchAccount(env, repo, recorded);
  if (!launch.ok || !autoFailoverOn(env)) return launch;
  const accounts = resolveClaudeAccounts(env);
  const resolved = accounts.find((a) => a.name === launch.name);
  if (resolved === undefined || accountIsFree(resolved, limits, now)) return launch;
  const primary = launchAccount(env, repo, null);
  const anchor = primary.ok ? Math.max(0, accounts.findIndex((a) => a.name === primary.name)) : 0;
  const currentIdx = accounts.findIndex((a) => a.name === launch.name);
  const currentOutOfScope = borrowedAccount != null && currentIdx >= 0 && currentIdx < anchor;
  const free = selectFreeAccount(accounts, anchor, launch.name, currentOutOfScope, reserved, limits, now);
  if (free !== null) return { ok: true, name: free.name, token: free.token };
  const borrowed = nextBorrowedAccount(accounts, reserved, limits, await readBurn(), now);
  if (borrowed !== null) return { ok: true, name: borrowed.name, token: borrowed.token };
  const resetAt = earliestAccountReset(accounts, limits, now);
  return {
    ok: false,
    error: `claude account: every account limited; earliest reset ${resetAt ?? "unknown"}`,
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
