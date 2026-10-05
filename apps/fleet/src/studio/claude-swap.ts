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
 * `pickHeadroomAccount` (issue #232's item 5) is built and unit-tested here
 * but deliberately NOT wired into src/studio/accounts.ts, failover.ts, or
 * do.ts in this dispatch — those three are CI-enforced one-way-door files
 * (scripts/merge-danger.ts's ONE_WAY_GLOBS); wiring the comparator into the
 * live failover cascade is a follow-up board issue.
 */

/** One usage window as cswap reports it. */
export interface CswapWindow {
  pct: number;
  resetsAt: string | null;
}

/** A per-model weekly window — same shape as CswapWindow plus which model. */
export interface CswapScopedWindow extends CswapWindow {
  model: string;
}

/** One account's usage, as `cswap list --json` reports it. */
export interface CswapAccount {
  email: string;
  usageStatus: string;
  usage: {
    fiveHour: CswapWindow;
    sevenDay: CswapWindow & { willLastToReset: boolean };
    scoped: CswapScopedWindow[];
  };
}

/** One fleet account slot, as `GET /studio/accounts` reports it. `name` is
 *  the secret name (e.g. `CLAUDE_CODE_OAUTH_TOKEN_2`); `label` is the
 *  operator-set `CLAUDE_ACCOUNT_<n>_LABEL` (accounts.ts's `accountLabel`),
 *  or null when unset. */
export interface FleetAccountSlot {
  name: string;
  label: string | null;
}

/** One join result per fleet slot. `cswap: null` means unmatched — the
 *  caller distinguishes WHY via `reason`:
 *    - "no-label": the slot has no CLAUDE_ACCOUNT_<n>_LABEL set.
 *    - "cswap-missing": cswap itself could not run (binary missing/errored)
 *      — every slot reads this, regardless of label.
 *    - "not-managed": cswap ran fine, but no row's `email` matched this
 *      slot's own label. */
export type SlotJoin =
  | { name: string; label: string; cswap: CswapAccount }
  | { name: string; label: string | null; cswap: null; reason: "no-label" | "cswap-missing" | "not-managed" };

/**
 * Pure join by `label === email` — exact string match, case-sensitive, no
 * normalization (cswap emails and operator-set labels are both plain
 * strings; the issue implies no normalization anywhere).
 *
 * `cswapAvailable: false` means cswap itself could not run at all: every
 * slot reads "cswap-missing", regardless of whether it has a label — this
 * is checked FIRST, before the no-label/not-managed distinction, since a
 * missing binary makes the label irrelevant.
 */
export function joinAccountsToCswap(
  slots: FleetAccountSlot[], cswapAccounts: CswapAccount[], cswapAvailable: boolean,
): SlotJoin[] {
  return slots.map((slot) => {
    if (!cswapAvailable) return { name: slot.name, label: slot.label, cswap: null, reason: "cswap-missing" as const };
    if (slot.label === null) return { name: slot.name, label: null, cswap: null, reason: "no-label" as const };
    const match = cswapAccounts.find((a) => a.email === slot.label);
    if (!match) return { name: slot.name, label: slot.label, cswap: null, reason: "not-managed" as const };
    return { name: slot.name, label: slot.label, cswap: match };
  });
}

/** The default pct at or above which a window counts as limited. */
export const DEFAULT_LIMIT_THRESHOLD_PCT = 95;

/** The sync decision for one slot. */
export type SyncDecision =
  | { name: string; action: "limit"; until: string | null; seenAt: string }
  | { name: string; action: "clear" }
  | { name: string; action: "unmanaged"; reason: "no-label" | "cswap-missing" | "not-managed" };

/**
 * pct >= thresholdPct on EITHER usage.fiveHour.pct, usage.sevenDay.pct, OR
 * any usage.scoped[].pct => "limit", `until` is the SPECIFIC window's own
 * resetsAt that tripped it — fiveHour's own resetsAt if fiveHour tripped,
 * sevenDay's if sevenDay tripped, a scoped window's own resetsAt if a
 * scoped model tripped it. Checked in that order; the first window to trip
 * wins (so a case where more than one window is simultaneously over
 * threshold still picks a single, well-defined `until`).
 *
 * All three below threshold => "clear", unconditionally — this is also the
 * dead-row clear path: a fresh low-pct reading is itself the "operator
 * re-login proved it's alive" signal the issue describes. This function
 * knows nothing about `dead` at all; that is the caller's/route's own
 * concern of which D1 helper (writeFleetAccountLimit vs
 * clearFleetAccountLimit) to call.
 *
 * An unjoined slot (`join.cswap === null`) always returns "unmanaged" with
 * its own `reason`, never defaults to limit or clear.
 */
export function decideAccountSync(
  join: SlotJoin, now: Date, thresholdPct: number = DEFAULT_LIMIT_THRESHOLD_PCT,
): SyncDecision {
  if (join.cswap === null) return { name: join.name, action: "unmanaged", reason: join.reason };
  const { fiveHour, sevenDay, scoped } = join.cswap.usage;
  if (fiveHour.pct >= thresholdPct) return { name: join.name, action: "limit", until: fiveHour.resetsAt, seenAt: now.toISOString() };
  if (sevenDay.pct >= thresholdPct) return { name: join.name, action: "limit", until: sevenDay.resetsAt, seenAt: now.toISOString() };
  const trippedScoped = scoped.find((w) => w.pct >= thresholdPct);
  if (trippedScoped) return { name: join.name, action: "limit", until: trippedScoped.resetsAt, seenAt: now.toISOString() };
  return { name: join.name, action: "clear" };
}

/** Item 5's pure comparator input: a candidate account with however fresh
 *  the caller's own snapshot of it is. */
export interface HeadroomCandidate {
  name: string;
  cswap: CswapAccount;
  dataAgeMs: number;
}

const DEFAULT_FRESHNESS_MS = 10 * 60 * 1000;

/** maxPct(a) = max(fiveHour.pct, sevenDay.pct). */
function maxPct(cswap: CswapAccount): number {
  return Math.max(cswap.usage.fiveHour.pct, cswap.usage.sevenDay.pct);
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
