/**
 * Issue #232 — a `cswap list --json` snapshot, for `src/studio/claude-swap.ts`'s
 * join/decision tests.
 *
 * PROVENANCE: HAND-BUILT, not a recording. claude-swap is not installed in
 * this container (it runs on the operator's Mac only — see issue #232's own
 * "Tool" section) and no real capture exists to quote from; this fixture
 * follows the shape the issue itself documents (`cswap list --json` →
 * `email`, `usageStatus`, `usageAgeSeconds`, `usage.fiveHour.{pct,resetsAt}`,
 * `usage.sevenDay.{pct,resetsAt,willLastToReset}`, `usage.scoped[]`) but
 * every value here is invented for test coverage, never measured.
 *
 * Corrected against the maestro's real-probe findings cited in the PR #237
 * review (board issue #232): real `cswap list --json` reports
 * `usageStatus: "ok"` for a healthy account, never the `"active"` this
 * fixture used to invent — any other status (`relogin_required`,
 * `unavailable`, etc) means `usage` itself is `null`, no pct data at all.
 * Every account also carries its own `usageAgeSeconds`, self-reported by
 * cswap, which can be stale even when `usageStatus` is `"ok"`.
 *
 * Emails are all `@example.com` — never a real email or org id, per the
 * issue's own acceptance criteria.
 */
import type { CswapAccount } from "../../src/studio/claude-swap";

/** Over threshold on fiveHour alone; sevenDay and scoped both comfortably
 *  under. Fresh reading. */
export const OVER_FIVE_HOUR: CswapAccount = {
  email: "primary@example.com",
  usageStatus: "ok",
  usageAgeSeconds: 45,
  usage: {
    fiveHour: { pct: 97, resetsAt: "2026-10-05T14:00:00Z" },
    sevenDay: { pct: 40, resetsAt: "2026-10-10T00:00:00Z", willLastToReset: true },
    scoped: [{ model: "claude-opus-4", pct: 20, resetsAt: "2026-10-10T00:00:00Z" }],
  },
};

/** Comfortably under threshold everywhere. Fresh reading. */
export const UNDER_THRESHOLD: CswapAccount = {
  email: "spare@example.com",
  usageStatus: "ok",
  usageAgeSeconds: 30,
  usage: {
    fiveHour: { pct: 10, resetsAt: "2026-10-05T16:00:00Z" },
    sevenDay: { pct: 25, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
    scoped: [{ model: "claude-opus-4", pct: 5, resetsAt: "2026-10-11T00:00:00Z" }],
  },
};

/** fiveHour and sevenDay both low; only a scoped model is over threshold.
 *  Fresh reading. */
export const OVER_SCOPED_ONLY: CswapAccount = {
  email: "borrow@example.com",
  usageStatus: "ok",
  usageAgeSeconds: 120,
  usage: {
    fiveHour: { pct: 30, resetsAt: "2026-10-05T18:00:00Z" },
    sevenDay: { pct: 45, resetsAt: "2026-10-12T00:00:00Z", willLastToReset: true },
    scoped: [{ model: "claude-opus-4", pct: 96, resetsAt: "2026-10-06T09:00:00Z" }],
  },
};

/** BLOCKER 1 probe: a failed/relogin-required read. `usageStatus` is not
 *  "ok", so `usage` itself is null — no pct data exists at all, regardless
 *  of how old or fresh `usageAgeSeconds` claims to be. */
export const RELOGIN_REQUIRED: CswapAccount = {
  email: "locked@example.com",
  usageStatus: "relogin_required",
  usageAgeSeconds: 86400,
  usage: null,
};

/** A reading that's otherwise healthy (`usageStatus: "ok"`, well-formed
 *  `usage`, a low 1% fiveHour pct) but is 900s old — over the 600s
 *  `MAX_USAGE_AGE_SECONDS` ceiling. Must still gate to "no-data": a stale
 *  reading must never clear or limit anything, even a low-looking one. */
export const STALE_OK: CswapAccount = {
  email: "stale@example.com",
  usageStatus: "ok",
  usageAgeSeconds: 900,
  usage: {
    fiveHour: { pct: 1, resetsAt: "2026-10-05T17:00:00Z" },
    sevenDay: { pct: 2, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
    scoped: [],
  },
};

export const CSWAP_LIST_FIXTURE: CswapAccount[] = [
  OVER_FIVE_HOUR, UNDER_THRESHOLD, OVER_SCOPED_ONLY, RELOGIN_REQUIRED, STALE_OK,
];
