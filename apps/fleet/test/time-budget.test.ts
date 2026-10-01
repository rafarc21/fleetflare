import { describe, it, expect } from "vitest";
import { AUTO_CLOSE_BUDGET_MS, makeTimeBudget, budgetExceeded } from "../src/time-budget";

// Board issue #215 (BU7): the 25s constant could be silently raised (e.g. to
// something over -- or merely closer to -- Cloudflare's own ~30s `waitUntil`
// execution ceiling, src/time-budget.ts's own header) with nothing here to
// notice. Pinned to the exact value AND separately checked against the
// ceiling it exists to stay clear of, so either kind of drift is caught.
describe("AUTO_CLOSE_BUDGET_MS (BU7)", () => {
  // The literal 25_000, not the import — exercises makeTimeBudget's REAL
  // default parameter (no override), so a drift between the constant and
  // the default it feeds is caught, not just a re-assertion of the import.
  it("is pinned at exactly the value issue #198 started with, wired through makeTimeBudget's own default", () => {
    const budget = makeTimeBudget(() => 1_000); // no budgetMs override
    expect(budget.deadline).toBe(1_000 + 25_000);
  });

  it("stays comfortably under the ~30s waitUntil execution ceiling", () => {
    // Not the same assertion as the pin above -- this one guards against
    // ANY future bump toward the ceiling, not just this exact number.
    expect(AUTO_CLOSE_BUDGET_MS).toBeLessThan(30_000);
  });
});

// Board issue #215 (BU8): every OTHER budget test in this codebase
// (github.promote-close.test.ts, board.pr-landed.test.ts) hand-builds a
// TimeBudget object and never calls the real makeTimeBudget/budgetExceeded
// at all -- so a regression in either of those two functions themselves
// would go uncaught everywhere else. These exercise the REAL functions.
describe("makeTimeBudget / budgetExceeded -- the real functions (BU8)", () => {
  it("budgetExceeded re-reads the clock live on every call, rather than caching a verdict", () => {
    const readings = [0, 10, 24_999, 25_000, 25_001];
    let i = 0;
    const clock = () => readings[i++];
    // readings[0] = 0 is consumed here, fixing deadline at 0 + 25_000.
    const budget = makeTimeBudget(clock, 25_000);
    expect(budgetExceeded(budget)).toBe(false); // reads readings[1] = 10
    expect(budgetExceeded(budget)).toBe(false); // reads readings[2] = 24_999
    expect(budgetExceeded(budget)).toBe(true);  // reads readings[3] = 25_000
    expect(budgetExceeded(budget)).toBe(true);  // reads readings[4] = 25_001
    // Every reading was actually consumed -- proof this re-read the clock
    // four separate times rather than deciding once and remembering.
    expect(i).toBe(5);
  });

  it("makeTimeBudget fixes the deadline at creation time and never recomputes it on a later clock() call", () => {
    let value = 1_000;
    const clock = () => value;
    const budget = makeTimeBudget(clock, 5_000); // deadline = 1_000 + 5_000
    expect(budget.deadline).toBe(6_000);

    value = 50_000; // the clock moves far into the future...
    expect(budget.deadline).toBe(6_000); // ...but the deadline itself never drifts.
    // ...and budgetExceeded still correctly reads the NEW live value against
    // that fixed deadline -- the live-clock half of the same guarantee.
    expect(budgetExceeded(budget)).toBe(true);
  });

  it("a fresh clock reading below the deadline is never exceeded", () => {
    const budget = makeTimeBudget(() => 1_000, 25_000); // deadline = 26_000
    expect(budgetExceeded(budget)).toBe(false);
  });
});
