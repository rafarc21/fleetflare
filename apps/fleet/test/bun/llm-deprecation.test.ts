// apps/fleet/test/bun/llm-deprecation.test.ts
// Pure deprecation check for scripts/model-smoke.ts (#1476): a model already
// retired on CF's own catalog must never spend a live inference call before
// the smoke test refuses it. No Workers runtime needed, same as
// llm-models.test.ts / llm-router.test.ts.
import { describe, test, expect } from "bun:test";
import { checkDeprecation } from "../../src/llm/deprecation";

const NOW = new Date("2026-11-26T00:00:00.000Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

describe("checkDeprecation", () => {
  test("no planned_deprecation_date is ok", () => {
    expect(checkDeprecation({ planned_deprecation_date: null }, NOW)).toBe("ok");
    expect(checkDeprecation({}, NOW)).toBe("ok");
  });

  test("a date in the past is retired", () => {
    expect(checkDeprecation({ planned_deprecation_date: new Date(NOW - DAY).toISOString() }, NOW)).toBe("retired");
  });

  test("a date within the warn window is warn", () => {
    expect(checkDeprecation({ planned_deprecation_date: new Date(NOW + 7 * DAY).toISOString() }, NOW)).toBe("warn");
  });

  test("a date right at the warn window boundary is warn", () => {
    expect(checkDeprecation({ planned_deprecation_date: new Date(NOW + 14 * DAY).toISOString() }, NOW)).toBe("warn");
  });

  test("a date well beyond the warn window is ok", () => {
    expect(checkDeprecation({ planned_deprecation_date: new Date(NOW + 15 * DAY).toISOString() }, NOW)).toBe("ok");
  });

  test("a custom warnDays widens or narrows the warn window", () => {
    expect(checkDeprecation({ planned_deprecation_date: new Date(NOW + 20 * DAY).toISOString() }, NOW, 30)).toBe("warn");
    expect(checkDeprecation({ planned_deprecation_date: new Date(NOW + 5 * DAY).toISOString() }, NOW, 2)).toBe("ok");
  });
});
