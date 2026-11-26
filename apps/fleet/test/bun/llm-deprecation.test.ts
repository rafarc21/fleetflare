// apps/fleet/test/bun/llm-deprecation.test.ts
// Pure deprecation check for scripts/model-smoke.ts (#1476): a model already
// retired on CF's own catalog must never spend a live inference call before
// the smoke test refuses it. No Workers runtime needed, same as
// llm-models.test.ts / llm-router.test.ts.
//
// Round 2 (#1476): CF's catalog semantics are not "entry carries a past
// `planned_deprecation_date`" — a retired id is simply ABSENT from the
// `wrangler ai models list --json` output entirely (0 of 52 live models
// currently carry that field). `checkDeprecation` now takes the FULL catalog
// list + a target id, so "absent" and "present with a past date" are both
// `"retired"`. `planned_deprecation_date` stays a secondary, forward-looking
// check for a model CF has flagged but not yet dropped.
import { describe, test, expect } from "bun:test";
import { checkDeprecation } from "../../src/llm/deprecation";

const NOW = new Date("2026-11-26T00:00:00.000Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const ID = "@cf/zai-org/glm-5.3";
const OTHER = "@cf/other/model";

describe("checkDeprecation", () => {
  test("id absent from the catalog entirely is retired", () => {
    expect(checkDeprecation([{ id: OTHER }], ID, NOW)).toBe("retired");
    expect(checkDeprecation([], ID, NOW)).toBe("retired");
  });

  test("id present, no planned_deprecation_date, is ok", () => {
    expect(checkDeprecation([{ id: ID }], ID, NOW)).toBe("ok");
  });

  test("id present, date far in the future, is ok", () => {
    expect(checkDeprecation([{ id: ID, planned_deprecation_date: new Date(NOW + 15 * DAY).toISOString() }], ID, NOW)).toBe("ok");
  });

  test("id present, date within the warn window, is warn", () => {
    expect(checkDeprecation([{ id: ID, planned_deprecation_date: new Date(NOW + 7 * DAY).toISOString() }], ID, NOW)).toBe("warn");
  });

  test("id present, date right at the warn window boundary, is warn", () => {
    expect(checkDeprecation([{ id: ID, planned_deprecation_date: new Date(NOW + 14 * DAY).toISOString() }], ID, NOW)).toBe("warn");
  });

  test("id present, date in the past, is retired", () => {
    expect(checkDeprecation([{ id: ID, planned_deprecation_date: new Date(NOW - DAY).toISOString() }], ID, NOW)).toBe("retired");
  });

  test("a custom warnDays widens or narrows the warn window", () => {
    expect(checkDeprecation([{ id: ID, planned_deprecation_date: new Date(NOW + 20 * DAY).toISOString() }], ID, NOW, 30)).toBe("warn");
    expect(checkDeprecation([{ id: ID, planned_deprecation_date: new Date(NOW + 5 * DAY).toISOString() }], ID, NOW, 2)).toBe("ok");
  });
});
