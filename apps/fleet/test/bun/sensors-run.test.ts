import { describe, expect, test } from "bun:test";
import { buildReport, dampenerState, parseState, renderBody } from "../../scripts/sensors/run";

/**
 * Board issue #187 (#168 phase 2) — pure-function coverage for the sensor
 * record-only run script. Only the public, no-subprocess seam is under
 * test here: `dampenerState`, `buildReport`, `parseState`, `renderBody`.
 * The `import.meta.main` I/O shell (gh read/write, file read) is
 * deliberately untested here — see the design doc and plan doc for why
 * this PR stops at the pure-function boundary.
 */
describe("dampenerState", () => {
  test("at baseline+slack exactly — OK", () => {
    expect(dampenerState(3, 2, 1)).toBe("OK");
  });

  test("one over baseline+slack — FIRED", () => {
    expect(dampenerState(4, 2, 1)).toBe("FIRED");
  });

  test("below baseline — OK", () => {
    expect(dampenerState(1, 2, 1)).toBe("OK");
  });

  test("default slack is 1 when omitted", () => {
    expect(dampenerState(3, 2)).toBe("OK");
    expect(dampenerState(4, 2)).toBe("FIRED");
  });
});

describe("buildReport — first run (no previous baseline)", () => {
  test("dampener stays OK even when current is high; baseline becomes current", () => {
    const report = buildReport(
      { ciFailures: 9, ciTotal: 50, knownFlaky: 7 },
      { ciFailures: null, knownFlaky: null },
    );
    expect(report.ciFailures.baseline).toBe(9);
    expect(report.ciFailures.current).toBe(9);
    expect(report.ciFailures.total).toBe(50);
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.baseline).toBe(7);
    expect(report.knownFlaky.current).toBe(7);
    expect(report.knownFlaky.dampener).toBe("OK");
  });
});

describe("buildReport — second run with a previous baseline", () => {
  test("CI sensor FIRED when current rises past baseline+slack, known-flaky independently OK", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 2 },
      { ciFailures: 1, knownFlaky: 2 },
    );
    expect(report.ciFailures.baseline).toBe(1);
    expect(report.ciFailures.current).toBe(4);
    expect(report.ciFailures.dampener).toBe("FIRED");
    expect(report.knownFlaky.baseline).toBe(2);
    expect(report.knownFlaky.current).toBe(2);
    expect(report.knownFlaky.dampener).toBe("OK");
  });

  test("known-flaky FIRED when current rises past baseline+slack, CI sensor independently OK", () => {
    const report = buildReport(
      { ciFailures: 1, ciTotal: 50, knownFlaky: 5 },
      { ciFailures: 1, knownFlaky: 2 },
    );
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.baseline).toBe(2);
    expect(report.knownFlaky.current).toBe(5);
    expect(report.knownFlaky.dampener).toBe("FIRED");
  });

  test("both sensors OK when neither rises past baseline+slack", () => {
    const report = buildReport(
      { ciFailures: 2, ciTotal: 50, knownFlaky: 2 },
      { ciFailures: 1, knownFlaky: 2 },
    );
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.dampener).toBe("OK");
  });
});

describe("renderBody / parseState round trip", () => {
  test("parsing a rendered body returns the same numbers as this run's current (next run's baseline)", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 5 },
      { ciFailures: 1, knownFlaky: 2 },
    );
    const body = renderBody(report, "2026-10-01T10:00:00Z");
    const parsed = parseState(body);
    expect(parsed.ciFailures).toBe(report.ciFailures.current);
    expect(parsed.knownFlaky).toBe(report.knownFlaky.current);
  });

  test("rendered body carries the rate cap line, window, and current/baseline/dampener values", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 5 },
      { ciFailures: 1, knownFlaky: 2 },
    );
    const body = renderBody(report, "2026-10-01T10:00:00Z");
    expect(body).toContain("3/day (filing disabled — record-only)");
    expect(body).toContain("2026-10-01T10:00:00Z");
    expect(body).toContain("50");
    expect(body).toContain("FIRED");
  });
});

describe("parseState — tolerates missing/malformed state", () => {
  test("missing block returns nulls", () => {
    expect(parseState("just a plain issue body, no state block")).toEqual({
      ciFailures: null,
      knownFlaky: null,
    });
  });

  test("absent body (null) returns nulls, never throws", () => {
    expect(parseState(null)).toEqual({ ciFailures: null, knownFlaky: null });
  });

  test("malformed JSON inside the block returns nulls, never throws", () => {
    const body = "body text\n<!-- fleet-sensor-state\n{not valid json\n-->\nmore text";
    expect(parseState(body)).toEqual({ ciFailures: null, knownFlaky: null });
  });

  test("well-formed block with missing fields returns nulls for the missing ones", () => {
    const body = "<!-- fleet-sensor-state\n{\"ciFailures\": 3}\n-->";
    expect(parseState(body)).toEqual({ ciFailures: 3, knownFlaky: null });
  });
});
