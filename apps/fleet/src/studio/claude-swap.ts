/**
 * Issue #232 — pure join/decision logic for `fleet accounts sync`.
 *
 * Today fleet learns an account's limit only reactively: a lead's pane shows
 * the rate-limit modal, failover.ts records `account-limit:<slot>`
 * (account-limits-store.ts). Rows go stale — a reinstated account can stay
 * `dead: true`, blocking every launch until hand-deleted from D1.
 *
 * claude-swap (`cswap`, MIT, `uv tool install claude-swap`) holds OAuth
 * logins on the OPERATOR's own machine. `cswap list --json` reports real
 * per-account usage there. Fleet containers run inference-scope
 * setup-tokens only — the usage API is unreachable from inside a container,
 * so the read happens on the operator's machine, and this module is the
 * PURE half of turning that reading into a fleet decision: no network, no
 * D1, no process spawn — those live in the CLI verb (step 3) and the Worker
 * route (step 2) that call this module's exports.
 *
 * Reworked per the maestro's real-probe review of PR #237 (issue #232):
 * `usageStatus` is "ok" when healthy, not the "active" an earlier draft
 * invented — any other value means `usage` is null, no pct data at all, and
 * a reading can ALSO be stale (`usageAgeSeconds` too high) even when
 * `usageStatus` is "ok". Both gate independently to a new "no-data" action
 * that never limits or clears. Per-account failures are isolated — a single
 * malformed entry degrades to "no-data" for that slot only, never throws.
 *
 * The scope-add STATUS comment on issue #232 (2026-10-05T09:48:22Z) adds a
 * second join pass: real fleet slots mostly don't carry a
 * `CLAUDE_ACCOUNT_<n>_LABEL`, so slots unresolved by label are matched by
 * RESET TIME instead — the slot's own currently-recorded `until` against an
 * unclaimed cswap account's `fiveHour`/`sevenDay` `resetsAt`, within +/-5
 * minutes, only when exactly one candidate qualifies.
 *
 * `pickHeadroomAccount` (issue #232's item 5) is built and unit-tested here
 * but deliberately NOT wired into src/studio/accounts.ts, failover.ts, or
 * do.ts in this dispatch — those three are CI-enforced one-way-door files
 * (scripts/merge-danger.ts's ONE_WAY_GLOBS); wiring the comparator into the
 * live failover cascade is tracked as a separate board issue (#238).
 */

/** One usage window as cswap reports it.
 *
 *  `resetsAt` (maestro real-probe review of PR #242, issue #240): a window
 *  with no readable reset OMITS this key entirely in real output
 *  (`{"pct": 0.0}`, no `resetsAt` property at all) — it is never present and
 *  explicitly `null`. The type marks it optional so BOTH "key absent" and
 *  "key present, `null`" are the same valid shape; every reader in this
 *  module treats them identically (see `resetsAtCandidates` and
 *  `decideAccountSync`'s own `?? null`). */
export interface CswapWindow {
  pct: number;
  resetsAt?: string | null;
}

/** A per-model weekly window — same shape as CswapWindow plus a display
 *  name. `name` (maestro real-probe review, issue #240): real `cswap list
 *  --json` calls this field `name`, never `model` — an earlier draft
 *  invented `model` and every real scoped entry failed shape validation
 *  because of it. Nothing in this module reads `name` for any DECISION
 *  (`decideAccountSync`'s scoped-window threshold check only ever touches
 *  `.pct`/`.resetsAt`) — this is purely a shape/typing correction.
 *
 *  `name` is optional (issue #244's own second finding, same bug class as
 *  `willLastToReset` below): since nothing reads it for a decision, the
 *  shape validator (`isValidWindow`, applied directly to scoped entries —
 *  see `isValidUsage`) never required it either, so the type shouldn't
 *  claim a guarantee the validator doesn't enforce. */
export interface CswapScopedWindow extends CswapWindow {
  name?: string;
}

/** One account's usage, as `cswap list --json` reports it.
 *
 *  `usageStatus`: "ok" when healthy (the real cswap value). Any other value
 *  (seen in the wild: "relogin_required", "unavailable") means a failure
 *  mode — `usage` itself is null, no pct data exists at all.
 *
 *  `usageAgeSeconds`: how many seconds old this reading is, self-reported by
 *  cswap. A reading can be old even when `usageStatus` is "ok" (cswap didn't
 *  refresh recently) — both conditions gate independently in
 *  `decideAccountSync`. */
export interface CswapAccount {
  email: string;
  usageStatus: string;
  usageAgeSeconds: number;
  usage: {
    fiveHour: CswapWindow;
    // willLastToReset (maestro real-probe review, issue #240, corrected
    // again under board issue #244): real cswap can OMIT this key entirely
    // (observed live, 2026-10-06, on a fresh account whose `sevenDay` had
    // only `pct`/`resetsAt`/`countdown`/`clock`, no `willLastToReset` key
    // at all) -- it is never present, explicitly `null`, AND a real
    // `true`/`false`. The type marks it optional so "key absent", "key
    // present, `null`", and "key present, a real boolean" are all the same
    // valid shape -- same pattern as `CswapWindow.resetsAt`'s own doc
    // comment above. Nothing in this module reads this field for any
    // decision (it is carried through the type only), so the validator
    // (isValidUsage) doesn't check it at all, not even for presence.
    sevenDay: CswapWindow & { willLastToReset?: boolean | null };
    scoped: CswapScopedWindow[];
  } | null;
}

/** How old a usage reading may be, in seconds, before it's untrustworthy for
 *  ANY decision — not just headroom ordering (issue #232 item 5's own "fresh
 *  (<10 min)" language, reused here as the general staleness gate). */
export const MAX_USAGE_AGE_SECONDS = 600;

/** One fleet account slot, as `GET /studio/accounts` reports it. `name` is
 *  the secret name (e.g. `CLAUDE_CODE_OAUTH_TOKEN_2`); `label` is the
 *  operator-set `CLAUDE_ACCOUNT_<n>_LABEL` (accounts.ts's `accountLabel`),
 *  or null when unset. `until` is that route's own currently-D1-recorded
 *  reset time for this slot (account-limit:<slot>'s `until`), used here for
 *  reset-time matching when no label resolves the slot. */
export interface FleetAccountSlot {
  name: string;
  label: string | null;
  until: string | null;
}

/** One join result per fleet slot.
 *    - "label": matched by exact label===email.
 *    - "inferred": matched by reset-time (no label match, exactly one
 *      reset-time candidate within the window).
 *    - "unmapped": no label match and no (or ambiguous) reset-time
 *      candidate.
 *    - "cswap-missing": cswap itself could not run (binary missing/errored)
 *      — every slot reads this, regardless of label/until. */
export type SlotJoin =
  | { name: string; label: string | null; until: string | null; cswap: CswapAccount; matchSource: "label" | "inferred" }
  | { name: string; label: string | null; until: string | null; cswap: null; matchSource: "unmapped" | "cswap-missing" };

/** +/-5 minutes, per the STATUS comment's own number. */
export const RESET_MATCH_WINDOW_MS = 5 * 60 * 1000;

function resetsAtCandidates(account: CswapAccount): (string | null)[] {
  if (account.usage === null) return [];
  // `?? null` normalizes an absent `resetsAt` key (real shape, see
  // CswapWindow's own doc comment) to the same `null` an explicit
  // `resetsAt: null` already produces -- one normalization point, so every
  // reader downstream (just `withinResetWindow` below) never has to care
  // which of the two it actually was.
  return [account.usage.fiveHour.resetsAt ?? null, account.usage.sevenDay.resetsAt ?? null];
}

function withinResetWindow(untilMs: number, account: CswapAccount): boolean {
  return resetsAtCandidates(account).some((resetsAt) => {
    if (resetsAt === null) return false;
    const diff = Math.abs(untilMs - Date.parse(resetsAt));
    return diff <= RESET_MATCH_WINDOW_MS;
  });
}

/**
 * Join-time shape guard (maestro review round 2, finding 3): `cswapAccounts`
 * is untrusted (parsed from a subprocess's stdout, same provenance as the
 * JSON `decideAccountSync` already treats defensively) — a genuinely
 * malformed entry (a bare `null` in the array, a non-object, a non-string/
 * empty `email`, or a non-null `usage` that isn't well-formed) must never
 * reach label matching (`.email`) or reset-time matching
 * (`.usage.fiveHour.resetsAt`/`.usage.sevenDay.resetsAt`) — both throw the
 * instant they touch it. Reuses `isValidUsage`, the SAME shape validator
 * `decideAccountSync` already uses for this exact purpose, rather than a
 * second copy of it. A failing entry is treated as entirely ABSENT from the
 * matching pool — it cannot be matched by label OR reset-time, same as if it
 * were never in `cswapAccounts` at all. */
function isValidCswapAccountForJoin(a: unknown): a is CswapAccount {
  if (typeof a !== "object" || a === null) return false;
  const acc = a as Record<string, unknown>;
  if (typeof acc.email !== "string" || acc.email.length === 0) return false;
  return acc.usage === null || isValidUsage(acc.usage);
}

/**
 * Pure join, two passes.
 *
 * `cswapAvailable: false` means cswap itself could not run at all: every
 * slot reads "cswap-missing", regardless of label/until — checked first,
 * before anything else.
 *
 * Pass -1 (shape validation, maestro review round 2 finding 3): every entry
 * in `cswapAccounts` is validated ONCE, up front, by
 * `isValidCswapAccountForJoin` — a malformed entry is dropped from the pool
 * entirely before pass 0 even runs, so it can never reach label or
 * reset-time matching (both would otherwise throw on it).
 *
 * Pass 0: any email appearing more than once in `cswapAccounts` is a
 * duplicate — removed from the matching pool entirely, so neither label nor
 * reset-time matching may ever select it (the minor fix noted in the PR
 * review: a duplicate must never be silently first-wins).
 *
 * Pass 1 (label): for each slot with a non-null label, if the pool holds an
 * account whose email matches, assign it ("label") and remove it from the
 * pool — a cswap account backs at most one slot.
 *
 * Pass 2 (reset-time): for each slot not resolved in pass 1, if `until` is
 * non-null, look for exactly one remaining pool account whose
 * `fiveHour.resetsAt` or `sevenDay.resetsAt` falls within +/-5 min of
 * `until`. Zero or more than one candidate -> unmapped. Exactly one ->
 * tentative match.
 *
 * Cross-slot collision: if two or more slots tentatively resolve to the SAME
 * pool account, that collision invalidates ALL of them (a cswap account
 * cannot correspond to two real fleet slots) — they fall back to unmapped,
 * and the account stays unconsumed, matching nobody.
 */
export function joinAccountsToCswap(
  slots: FleetAccountSlot[], cswapAccounts: CswapAccount[], cswapAvailable: boolean,
): SlotJoin[] {
  if (!cswapAvailable) {
    return slots.map((slot) => ({
      name: slot.name, label: slot.label, until: slot.until, cswap: null, matchSource: "cswap-missing" as const,
    }));
  }

  // Pass -1 (shape validation, applied ONCE, up front): drop every malformed
  // entry from the pool before any label/reset-time matching logic runs —
  // see `isValidCswapAccountForJoin`'s own doc comment.
  const validAccounts = cswapAccounts.filter(isValidCswapAccountForJoin);

  const emailCounts = new Map<string, number>();
  for (const a of validAccounts) emailCounts.set(a.email, (emailCounts.get(a.email) ?? 0) + 1);
  const remaining = new Set(validAccounts.filter((a) => emailCounts.get(a.email) === 1));

  const resolved = new Map<string, { account: CswapAccount; matchSource: "label" | "inferred" }>();

  // Pass 1: label match.
  for (const slot of slots) {
    if (slot.label === null) continue;
    const match = [...remaining].find((a) => a.email === slot.label);
    if (match) {
      resolved.set(slot.name, { account: match, matchSource: "label" });
      remaining.delete(match);
    }
  }

  // Pass 2: reset-time match, for slots not resolved in pass 1.
  const tentative = new Map<string, CswapAccount>();
  for (const slot of slots) {
    if (resolved.has(slot.name)) continue;
    if (slot.until === null) continue;
    const untilMs = Date.parse(slot.until);
    const candidates = [...remaining].filter((a) => withinResetWindow(untilMs, a));
    if (candidates.length === 1) tentative.set(slot.name, candidates[0]);
  }

  // Cross-slot collision: group tentative assignments by which account they
  // resolved to; anything claimed by more than one slot is invalidated.
  const accountToSlotNames = new Map<CswapAccount, string[]>();
  for (const [slotName, account] of tentative) {
    const list = accountToSlotNames.get(account) ?? [];
    list.push(slotName);
    accountToSlotNames.set(account, list);
  }
  for (const [account, slotNames] of accountToSlotNames) {
    if (slotNames.length !== 1) continue;
    resolved.set(slotNames[0], { account, matchSource: "inferred" });
    remaining.delete(account);
  }

  return slots.map((slot) => {
    const match = resolved.get(slot.name);
    if (match) return { name: slot.name, label: slot.label, until: slot.until, cswap: match.account, matchSource: match.matchSource };
    return { name: slot.name, label: slot.label, until: slot.until, cswap: null, matchSource: "unmapped" as const };
  });
}

/** The default pct at or above which a window counts as limited. */
export const DEFAULT_LIMIT_THRESHOLD_PCT = 95;

/** The sync decision for one slot.
 *
 *  "no-data": the join found a real cswap account, but its reading isn't
 *  trustworthy (failed status, no usage, stale, or malformed shape) — never
 *  limit, never clear, same "no D1 write" treatment as "unmanaged".
 *
 *  `until` on "limit" is ALWAYS string | null, never undefined — a window
 *  with no resetsAt produces `until: null` explicitly.
 *
 *  `usageAgeSeconds` on BOTH "limit" and "clear" (maestro review round 2,
 *  finding 6, and round-2-of-round-2 MAJOR 1): the cswap reading this
 *  decision was computed FROM is itself up to this many seconds stale —
 *  `seenAt` (this decision's own wall-clock instant) minus `usageAgeSeconds`
 *  is the real DATA time the reading describes. On "clear" this is what a
 *  clear must be judged fresher-than, never the wall-clock instant the whole
 *  batch's snapshot happened to be taken at (threaded through to routes.ts so
 *  its MAJOR 6 freshness check can anchor to the right clock). On "limit" it
 *  is the SAME correction, needed so routes.ts can stamp the persisted
 *  `account-usage:<slot>` row's own `seenAt` as real data time rather than
 *  CLI-run-time — a reading already ~10 minutes stale at CLI-run-time would
 *  otherwise be stored as if it were taken AT CLI-run-time, letting its real
 *  age reach ~20 minutes by the time a live failover reads the row.
 *
 *  Issue #238 step 2: `usage` on "limit"/"clear" is the SAME `UsageHeadroom`
 *  `toUsageHeadroom` extracts (defined further below in this file) — present
 *  on BOTH, because a cleared/under-threshold reading's pct is just as
 *  useful for headroom ordering as a limited one's (the whole reason the new
 *  `account-usage:<slot>` D1 store, written by routes.ts, is separate from
 *  the binary `account-limit:<slot>` row). Attached only on the branch that
 *  already passed every trustworthiness gate below (`usageStatus === "ok"`,
 *  non-null, fresh, well-formed) — "unmanaged"/"no-data" never carry it,
 *  since neither has a trustworthy pct to attach. */
export type SyncDecision =
  | { name: string; action: "limit"; until: string | null; seenAt: string; usageAgeSeconds: number; usage?: UsageHeadroom }
  | { name: string; action: "clear"; seenAt: string; usageAgeSeconds: number; usage?: UsageHeadroom }
  | { name: string; action: "unmanaged" }
  | { name: string; action: "no-data"; reason: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Maestro real-probe review of PR #242 (issue #240): real `cswap list
// --json` output omits `resetsAt` entirely on a reset-less window rather
// than setting it `null` -- `win.resetsAt === undefined` (an absent key
// reads as `undefined` off a plain object, same as `in` would say "not
// present") is accepted here as the SAME valid "no reset" case an explicit
// `null` already was. Extra unrecognized keys on `w` (real cswap carries
// `countdown`/`clock`/`expectedPct`/`aheadOfPace`, none of which this
// codebase models) never affect this check -- it only ever reads the two
// named properties it cares about, never an exact-keys comparison.
function isValidWindow(w: unknown): w is CswapWindow {
  if (typeof w !== "object" || w === null) return false;
  const win = w as Record<string, unknown>;
  return isFiniteNumber(win.pct)
    && (win.resetsAt === undefined || win.resetsAt === null || typeof win.resetsAt === "string");
}

// issue #244: `name` used to be required here (string-typed), but nothing
// in this module reads `.scoped[].name` for any decision -- see
// CswapScopedWindow's own doc comment. A scoped window is validated with
// the SAME `isValidWindow` every other window uses; there's no scoped-only
// shape requirement left to check, so the separate function this used to be
// (`isValidScopedWindow`) is gone -- `isValidUsage` below calls
// `isValidWindow` directly on each scoped entry.

function isValidUsage(usage: unknown): usage is NonNullable<CswapAccount["usage"]> {
  if (typeof usage !== "object" || usage === null) return false;
  const u = usage as Record<string, unknown>;
  if (!isValidWindow(u.fiveHour) || !isValidWindow(u.sevenDay)) return false;
  // issue #244: `willLastToReset` used to be required here (boolean or
  // explicit null) -- real cswap can OMIT the key entirely (see
  // CswapAccount["usage"]'s own doc comment). Nothing downstream reads its
  // value for a decision, so this validator doesn't check it at all, not
  // even for presence.
  return Array.isArray(u.scoped) && u.scoped.every(isValidWindow);
}

/**
 * pct >= thresholdPct on EITHER usage.fiveHour.pct, usage.sevenDay.pct, OR
 * any usage.scoped[].pct => "limit", `until` is the SPECIFIC window's own
 * resetsAt that tripped it (explicit `null` when that window has none,
 * never undefined). Checked in that order; the first window to trip wins.
 *
 * All three below threshold => "clear", unconditionally — this is also the
 * dead-row clear path: a fresh low-pct reading is itself the "operator
 * re-login proved it's alive" signal the issue describes.
 *
 * Trustworthiness is validated FIRST, defensively, before any threshold
 * logic runs — this function never throws, by construction, for any input
 * shape:
 *   - `usageStatus !== "ok"` -> "no-data" (failure mode, no pct data).
 *   - `usage === null` -> "no-data".
 *   - `usageAgeSeconds >= MAX_USAGE_AGE_SECONDS` -> "no-data" (stale, even
 *     if usageStatus is "ok").
 *   - malformed usage shape (missing/non-numeric fields, non-array scoped)
 *     -> "no-data".
 *
 * An unjoined slot (`join.cswap === null`) always returns "unmanaged",
 * never defaults to limit or clear — which of "unmapped"/"cswap-missing" it
 * was lives on the join's own `matchSource`, not here.
 */
export function decideAccountSync(
  join: SlotJoin, now: Date, thresholdPct: number = DEFAULT_LIMIT_THRESHOLD_PCT,
): SyncDecision {
  if (join.cswap === null) return { name: join.name, action: "unmanaged" };
  const cswap = join.cswap;

  if (cswap.usageStatus !== "ok") {
    return { name: join.name, action: "no-data", reason: `usageStatus: ${cswap.usageStatus}` };
  }
  if (cswap.usage === null) {
    return { name: join.name, action: "no-data", reason: "no usage data" };
  }
  if (!isFiniteNumber(cswap.usageAgeSeconds) || cswap.usageAgeSeconds >= MAX_USAGE_AGE_SECONDS) {
    return { name: join.name, action: "no-data", reason: `usage data is ${cswap.usageAgeSeconds}s old (>= ${MAX_USAGE_AGE_SECONDS}s)` };
  }
  if (!isValidUsage(cswap.usage)) {
    return { name: join.name, action: "no-data", reason: "malformed usage shape" };
  }

  const { fiveHour, sevenDay, scoped } = cswap.usage;
  const usage = toUsageHeadroom(cswap);
  if (fiveHour.pct >= thresholdPct) {
    return {
      name: join.name, action: "limit", until: fiveHour.resetsAt ?? null, seenAt: now.toISOString(),
      usageAgeSeconds: cswap.usageAgeSeconds, usage,
    };
  }
  if (sevenDay.pct >= thresholdPct) {
    return {
      name: join.name, action: "limit", until: sevenDay.resetsAt ?? null, seenAt: now.toISOString(),
      usageAgeSeconds: cswap.usageAgeSeconds, usage,
    };
  }
  const trippedScoped = scoped.find((w) => w.pct >= thresholdPct);
  if (trippedScoped) {
    return {
      name: join.name, action: "limit", until: trippedScoped.resetsAt ?? null, seenAt: now.toISOString(),
      usageAgeSeconds: cswap.usageAgeSeconds, usage,
    };
  }
  return { name: join.name, action: "clear", seenAt: now.toISOString(), usageAgeSeconds: cswap.usageAgeSeconds, usage };
}

/** Item 5's pure comparator input: a candidate account with however fresh
 *  the caller's own snapshot of it is. */
export interface HeadroomCandidate {
  name: string;
  cswap: CswapAccount;
  dataAgeMs: number;
}

const DEFAULT_FRESHNESS_MS = 10 * 60 * 1000;

/** The three numbers `usageMaxPct` compares — already-extracted, so it never
 *  touches `CswapAccount`'s own nested shape. */
export interface UsageHeadroom {
  fiveHourPct: number;
  sevenDayPct: number;
  /** null when no scoped windows exist/are reported — never 0, which would
   *  wrongly dominate a real low reading. */
  scopedMaxPct: number | null;
}

/**
 * Issue #238: the real "how limited is this account" number — the fold-in
 * `pickHeadroomAccount` was missing before this fix (it only ever compared
 * fiveHourPct/sevenDayPct, silently blind to a scoped per-model window that
 * is itself the tightest constraint). `scopedMaxPct ?? -Infinity` means a
 * null (no scoped windows) never wins/dominates the max — it simply drops
 * out, leaving plain max(fiveHourPct, sevenDayPct).
 */
export function usageMaxPct(u: UsageHeadroom): number {
  return Math.max(u.fiveHourPct, u.sevenDayPct, u.scopedMaxPct ?? -Infinity);
}

/**
 * Extracts a `CswapAccount`'s three headroom numbers. Assumes well-formed,
 * already-validated input (same posture `decideAccountSync`'s own
 * threshold-check code takes once past its own validation gates) — callers
 * of `pickHeadroomAccount` only ever pass candidates with a real usage
 * reading already in hand, so `usage` is asserted non-null here rather than
 * re-validated.
 */
export function toUsageHeadroom(cswap: CswapAccount): UsageHeadroom {
  const usage = cswap.usage!;
  return {
    fiveHourPct: usage.fiveHour.pct,
    sevenDayPct: usage.sevenDay.pct,
    scopedMaxPct: usage.scoped.length ? Math.max(...usage.scoped.map((s) => s.pct)) : null,
  };
}

/** maxPct(a) = usageMaxPct(toUsageHeadroom(a)) — folds the scoped window in,
 *  fixed per issue #238 (previously `max(fiveHour.pct, sevenDay.pct)` only,
 *  silently blind to a scoped window that was itself the tightest
 *  constraint). Callers of `pickHeadroomAccount` only ever pass candidates
 *  with a real usage reading already in hand (item 5 is unchanged/out of
 *  scope for the #232 rework — see this module's own header), so `usage` is
 *  asserted non-null inside `toUsageHeadroom` rather than re-validated. */
function maxPct(cswap: CswapAccount): number {
  return usageMaxPct(toUsageHeadroom(cswap));
}

/**
 * Picks the candidate with the LOWEST maxPct (most headroom) among those
 * with `dataAgeMs < freshnessMs` (default 10 minutes). Returns null when
 * none are fresh enough — the caller's own cue to fall back to current
 * (reactive) failover behaviour; this function only picks, never falls
 * back itself, and takes no wall-clock of its own (pure in `dataAgeMs`).
 *
 * NOT wired into any live failover path in this dispatch — see this
 * module's own header for why.
 */
export function pickHeadroomAccount(
  candidates: HeadroomCandidate[], freshnessMs: number = DEFAULT_FRESHNESS_MS,
): string | null {
  const fresh = candidates.filter((c) => c.dataAgeMs < freshnessMs);
  if (fresh.length === 0) return null;
  let best = fresh[0];
  for (const c of fresh.slice(1)) {
    if (maxPct(c.cswap) < maxPct(best.cswap)) best = c;
  }
  return best.name;
}
