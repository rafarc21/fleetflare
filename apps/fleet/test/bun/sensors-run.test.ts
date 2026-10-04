import { describe, expect, test } from "bun:test";
import { buildReport, dampenerState, parseState, renderBody } from "../../scripts/sensors/run";

/**
 * Board issue #187 (#168 phase 2) — pure-function coverage for the sensor
 * record-only run script. Only the public, no-subprocess seam is under
 * test here: `dampenerState`, `buildReport`, `parseState`, `renderBody`.
 * The `import.meta.main` I/O shell (gh read/write, file read) is
 * deliberately untested here — see the design doc and plan doc for why
 * this PR stops at the pure-function boundary.
 *
 * Board issue #208 (ask 3) added a THIRD sensor, "platform replacements" —
 * threaded through `buildReport`/`PreviousBaselines`/`SensorResult`/
 * `renderBody`/`parseState` exactly like `knownFlaky` already was, so every
 * `buildReport`/`parseState` fixture below now carries a
 * `platformReplacements` value alongside the original two.
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
      { ciFailures: 9, ciTotal: 50, knownFlaky: 7, platformReplacements: 3 },
      { ciFailures: null, knownFlaky: null, platformReplacements: null },
    );
    expect(report.ciFailures.baseline).toBe(9);
    expect(report.ciFailures.current).toBe(9);
    expect(report.ciFailures.total).toBe(50);
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.baseline).toBe(7);
    expect(report.knownFlaky.current).toBe(7);
    expect(report.knownFlaky.dampener).toBe("OK");
    expect(report.platformReplacements.baseline).toBe(3);
    expect(report.platformReplacements.current).toBe(3);
    expect(report.platformReplacements.dampener).toBe("OK");
  });
});

describe("buildReport — zero run history (brand-new fleet-check.yml, no runs yet)", () => {
  test("ciTotal: 0, ciFailures: 0 computes without throwing and stays OK (not FIRED)", () => {
    const report = buildReport(
      { ciFailures: 0, ciTotal: 0, knownFlaky: 0, platformReplacements: 0 },
      { ciFailures: null, knownFlaky: null, platformReplacements: null },
    );
    expect(report.ciFailures.total).toBe(0);
    expect(report.ciFailures.current).toBe(0);
    expect(report.ciFailures.baseline).toBe(0);
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.current).toBe(0);
    expect(report.knownFlaky.baseline).toBe(0);
    expect(report.knownFlaky.dampener).toBe("OK");
    expect(report.platformReplacements.current).toBe(0);
    expect(report.platformReplacements.baseline).toBe(0);
    expect(report.platformReplacements.dampener).toBe("OK");
  });
});

describe("buildReport — second run with a previous baseline", () => {
  test("CI sensor FIRED when current rises past baseline+slack, known-flaky and platform replacements independently OK", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 2, platformReplacements: 2 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 2 },
    );
    expect(report.ciFailures.baseline).toBe(1);
    expect(report.ciFailures.current).toBe(4);
    expect(report.ciFailures.dampener).toBe("FIRED");
    expect(report.knownFlaky.baseline).toBe(2);
    expect(report.knownFlaky.current).toBe(2);
    expect(report.knownFlaky.dampener).toBe("OK");
    expect(report.platformReplacements.baseline).toBe(2);
    expect(report.platformReplacements.current).toBe(2);
    expect(report.platformReplacements.dampener).toBe("OK");
  });

  test("known-flaky FIRED when current rises past baseline+slack, CI sensor and platform replacements independently OK", () => {
    const report = buildReport(
      { ciFailures: 1, ciTotal: 50, knownFlaky: 5, platformReplacements: 2 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 2 },
    );
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.baseline).toBe(2);
    expect(report.knownFlaky.current).toBe(5);
    expect(report.knownFlaky.dampener).toBe("FIRED");
    expect(report.platformReplacements.dampener).toBe("OK");
  });

  test("platform replacements FIRED when current rises past baseline+slack, the other two independently OK", () => {
    const report = buildReport(
      { ciFailures: 1, ciTotal: 50, knownFlaky: 2, platformReplacements: 6 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 2 },
    );
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.dampener).toBe("OK");
    expect(report.platformReplacements.baseline).toBe(2);
    expect(report.platformReplacements.current).toBe(6);
    expect(report.platformReplacements.dampener).toBe("FIRED");
  });

  test("all three sensors OK when none rises past baseline+slack", () => {
    const report = buildReport(
      { ciFailures: 2, ciTotal: 50, knownFlaky: 2, platformReplacements: 2 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 1 },
    );
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.dampener).toBe("OK");
    expect(report.platformReplacements.dampener).toBe("OK");
  });
});

/**
 * Fix round (#208 PR #215 review item 3, BLOCKER): `loadCredentials()`'s
 * own `process.exit(1)` on a missing `~/.fleet/credentials` file (every real
 * GitHub Actions runner) used to kill the WHOLE `bun run sensors` process —
 * including the two other sensors in the same `Promise.all`, which need no
 * credential at all. `readPlatformReplacements` now soft-fails to `null`
 * instead (via `loadCredentialsIfPresent`, cli/fleet.ts's own non-exiting
 * variant); `buildReport`/`renderBody` both need to carry that `null`
 * through as "n/a" rather than crash on a `number` they no longer always get.
 */
describe("buildReport — platform-replacements sensor unavailable (no credentials, #208 fix round item 3)", () => {
  test("raw platformReplacements: null -> current null, dampener OK, baseline carried from the previous run", () => {
    const report = buildReport(
      { ciFailures: 1, ciTotal: 50, knownFlaky: 1, platformReplacements: null },
      { ciFailures: 1, knownFlaky: 1, platformReplacements: 5 },
    );
    expect(report.platformReplacements.current).toBeNull();
    expect(report.platformReplacements.baseline).toBe(5);
    expect(report.platformReplacements.dampener).toBe("OK");
    // The other two sensors are completely unaffected.
    expect(report.ciFailures.dampener).toBe("OK");
    expect(report.knownFlaky.dampener).toBe("OK");
  });

  test("raw platformReplacements: null on the very first run ever (no previous baseline either) -> baseline also null, never a crash", () => {
    const report = buildReport(
      { ciFailures: 0, ciTotal: 0, knownFlaky: 0, platformReplacements: null },
      { ciFailures: null, knownFlaky: null, platformReplacements: null },
    );
    expect(report.platformReplacements.current).toBeNull();
    expect(report.platformReplacements.baseline).toBeNull();
    expect(report.platformReplacements.dampener).toBe("OK");
  });
});

describe("renderBody — platform-replacements sensor unavailable renders n/a, never a crash", () => {
  test("current null renders 'n/a' in the table row, and the hidden state carries the PREVIOUS baseline forward (not null) so the next run still has a real comparison point", () => {
    const report = buildReport(
      { ciFailures: 1, ciTotal: 50, knownFlaky: 1, platformReplacements: null },
      { ciFailures: 1, knownFlaky: 1, platformReplacements: 5 },
    );
    const body = renderBody(report, "2026-10-04T00:00:00Z");
    const row = body.split("\n").find((l) => l.includes("platform replacements"));
    expect(row).toContain("n/a");
    const parsed = parseState(body);
    expect(parsed.platformReplacements).toBe(5);
  });

  test("current AND baseline both null (first run ever, no creds) renders n/a for both, round-trips to null", () => {
    const report = buildReport(
      { ciFailures: 0, ciTotal: 0, knownFlaky: 0, platformReplacements: null },
      { ciFailures: null, knownFlaky: null, platformReplacements: null },
    );
    const body = renderBody(report, "2026-10-04T00:00:00Z");
    const row = body.split("\n").find((l) => l.includes("platform replacements"));
    expect(row).toMatch(/n\/a.*n\/a/);
    expect(parseState(body).platformReplacements).toBeNull();
  });
});

describe("renderBody / parseState round trip", () => {
  test("parsing a rendered body returns the same numbers as this run's current (next run's baseline)", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 5, platformReplacements: 3 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 1 },
    );
    const body = renderBody(report, "2026-10-01T10:00:00Z");
    const parsed = parseState(body);
    expect(parsed.ciFailures).toBe(report.ciFailures.current);
    expect(parsed.knownFlaky).toBe(report.knownFlaky.current);
    expect(parsed.platformReplacements).toBe(report.platformReplacements.current);
  });

  test("includes the rate-cap line", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 5, platformReplacements: 3 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 1 },
    );
    const body = renderBody(report, "2026-10-01T10:00:00Z");
    expect(body).toContain("Rate cap: TBD, pending operator decision — filing disabled (record-only)");
  });

  test("includes the run timestamp", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 5, platformReplacements: 3 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 1 },
    );
    const body = renderBody(report, "2026-10-01T10:00:00Z");
    expect(body).toContain("2026-10-01T10:00:00Z");
  });

  test("includes the CI run window total value", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 5, platformReplacements: 3 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 1 },
    );
    const body = renderBody(report, "2026-10-01T10:00:00Z");
    expect(body).toContain("50");
  });

  test("includes a FIRED dampener value", () => {
    const report = buildReport(
      { ciFailures: 4, ciTotal: 50, knownFlaky: 5, platformReplacements: 3 },
      { ciFailures: 1, knownFlaky: 2, platformReplacements: 1 },
    );
    const body = renderBody(report, "2026-10-01T10:00:00Z");
    expect(body).toContain("FIRED");
  });

  test("includes a platform-replacements row naming the sensor and its current/baseline/dampener", () => {
    const report = buildReport(
      { ciFailures: 1, ciTotal: 50, knownFlaky: 1, platformReplacements: 6 },
      { ciFailures: 1, knownFlaky: 1, platformReplacements: 2 },
    );
    const body = renderBody(report, "2026-10-01T10:00:00Z");
    expect(body).toContain("platform replacements");
    const row = body.split("\n").find((l) => l.includes("platform replacements"));
    expect(row).toContain("| 6 |");
    expect(row).toContain("| 2 |");
    expect(row).toContain("FIRED");
  });
});

describe("parseState — tolerates missing/malformed state", () => {
  test("missing block returns nulls", () => {
    expect(parseState("just a plain issue body, no state block")).toEqual({
      ciFailures: null,
      knownFlaky: null,
      platformReplacements: null,
    });
  });

  test("absent body (null) returns nulls, never throws", () => {
    expect(parseState(null)).toEqual({ ciFailures: null, knownFlaky: null, platformReplacements: null });
  });

  test("malformed JSON inside the block returns nulls, never throws", () => {
    const body = "body text\n<!-- fleet-sensor-state\n{not valid json\n-->\nmore text";
    expect(parseState(body)).toEqual({ ciFailures: null, knownFlaky: null, platformReplacements: null });
  });

  test("well-formed block with missing fields returns nulls for the missing ones", () => {
    const body = "<!-- fleet-sensor-state\n{\"ciFailures\": 3}\n-->";
    expect(parseState(body)).toEqual({ ciFailures: 3, knownFlaky: null, platformReplacements: null });
  });

  test("well-formed block with only platformReplacements returns nulls for the other two", () => {
    const body = "<!-- fleet-sensor-state\n{\"platformReplacements\": 4}\n-->";
    expect(parseState(body)).toEqual({ ciFailures: null, knownFlaky: null, platformReplacements: 4 });
  });
});
