/**
 * Issue #232 — a `cswap list --json` snapshot, for `src/studio/claude-swap.ts`'s
 * join/decision tests.
 *
 * PROVENANCE: HAND-BUILT, not a recording. claude-swap is not installed in
 * this container (it runs on the operator's Mac only — see issue #232's own
 * "Tool" section) and no real capture exists to quote from; this fixture
 * follows the shape the issue itself documents (`cswap list --json` →
 * `email`, `usageStatus`, `usage.fiveHour.{pct,resetsAt}`,
 * `usage.sevenDay.{pct,resetsAt,willLastToReset}`, `usage.scoped[]`) but
 * every value here is invented for test coverage, never measured.
 *
 * Emails are all `@example.com` — never a real email or org id, per the
 * issue's own acceptance criteria.
 */
import type { CswapAccount } from "../../src/studio/claude-swap";

/** Over threshold on fiveHour alone; sevenDay and scoped both comfortably
 *  under. */
export const OVER_FIVE_HOUR: CswapAccount = {
  email: "primary@example.com",
  usageStatus: "active",
  usage: {
    fiveHour: { pct: 97, resetsAt: "2026-10-05T14:00:00Z" },
    sevenDay: { pct: 40, resetsAt: "2026-10-10T00:00:00Z", willLastToReset: true },
    scoped: [{ model: "claude-opus-4", pct: 20, resetsAt: "2026-10-10T00:00:00Z" }],
  },
};

/** Comfortably under threshold everywhere. */
export const UNDER_THRESHOLD: CswapAccount = {
  email: "spare@example.com",
  usageStatus: "active",
  usage: {
    fiveHour: { pct: 10, resetsAt: "2026-10-05T16:00:00Z" },
    sevenDay: { pct: 25, resetsAt: "2026-10-11T00:00:00Z", willLastToReset: true },
    scoped: [{ model: "claude-opus-4", pct: 5, resetsAt: "2026-10-11T00:00:00Z" }],
  },
};

/** fiveHour and sevenDay both low; only a scoped model is over threshold. */
export const OVER_SCOPED_ONLY: CswapAccount = {
  email: "borrow@example.com",
  usageStatus: "active",
  usage: {
    fiveHour: { pct: 30, resetsAt: "2026-10-05T18:00:00Z" },
    sevenDay: { pct: 45, resetsAt: "2026-10-12T00:00:00Z", willLastToReset: true },
    scoped: [{ model: "claude-opus-4", pct: 96, resetsAt: "2026-10-06T09:00:00Z" }],
  },
};

export const CSWAP_LIST_FIXTURE: CswapAccount[] = [OVER_FIVE_HOUR, UNDER_THRESHOLD, OVER_SCOPED_ONLY];
