import { describe, expect, test } from "bun:test";
import { BURN_LEGEND, formatLsHead, formatStudioCount, formatTable, fullErrorLine } from "../../cli/fleet";
import type { StudioStatus } from "../../src/studio/types";

// Issue #205: 2026-09-24 21:12Z the BETA maestro ran `fleet ls 2>&1 | head -20`.
// Rows sort by id, so the 5 demosite-life--* rows sorted last and `head` cut
// exactly them: "zero studios" while 3 idle studios billed. And one 3,382-char
// ERROR padded every line to ~3,600 chars (87 KB), so Claude Code persisted
// the output to a file whose 2 KB preview showed no rows at all.
function row(overrides: Partial<StudioStatus>): StudioStatus {
  return {
    id: "acme-os--maestro", state: "running", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null,
    repoSlug: null, ...overrides,
  };
}

const FLEET: StudioStatus[] = [
  row({ id: "acme-os--maestro", state: "running" }),
  row({ id: "acme-os--pilot", state: "stopped" }),
  row({ id: "fleetflare--scratch", state: "provisioning" }),
  row({ id: "demosite-life--maestro", state: "stopped", containerRunningSince: "2026-09-24T12:39:08.000Z" }),
  row({ id: "demosite-life--pilot", state: "stopped" }),
  row({ id: "demosite-life--web-studio", state: "degraded" }),
];

describe("fleet ls line 1 — the denominator (#205)", () => {
  test("total, billing (not stopped, or stopped with a running container), then per-repo counts", () => {
    expect(formatStudioCount(FLEET)).toBe(
      "STUDIOS: 6 total, 4 billing — acme-os 2, demosite-life 3, fleetflare 1",
    );
  });

  test("an empty fleet still says so", () => {
    expect(formatStudioCount([])).toBe("STUDIOS: 0 total, 0 billing");
  });

  test("the head of fleet ls is the denominator FIRST, then the BURN legend", () => {
    const head = formatLsHead(FLEET);
    expect(head[0]).toBe(formatStudioCount(FLEET));
    expect(head[1]).toBe(BURN_LEGEND);
  });
});

describe("formatTable — no trailing pad, capped ERROR (#205)", () => {
  const longError = "container bring-up failed: " + "x".repeat(3_400);
  const table = formatTable([
    row({ id: "acme-os--maestro", error: longError }),
    row({ id: "fleetflare--scratch" }),
  ]);

  test("no line ends in whitespace", () => {
    for (const line of table.split("\n")) expect(line).toBe(line.trimEnd());
  });

  test("the ERROR cell is capped near 160 chars with an ellipsis", () => {
    const maestro = table.split("\n").find((l) => l.startsWith("acme-os--maestro"))!;
    const cell = maestro.slice(maestro.indexOf("container bring-up failed:"));
    expect(cell.length).toBeLessThanOrEqual(160);
    expect(cell.endsWith("…")).toBe(true);
  });

  test("a 3,400-char error no longer widens every line", () => {
    const other = table.split("\n").find((l) => l.startsWith("fleetflare--scratch"))!;
    expect(other.length).toBeLessThan(400);
  });

  test("a short error is printed whole", () => {
    const t = formatTable([row({ error: "clone failed: 403" })]);
    expect(t).toContain("clone failed: 403");
    expect(t).not.toContain("…");
  });
});

describe("fleet check <id> keeps the full error (#205)", () => {
  test("a capped error is printed whole on its own line", () => {
    const long = "container bring-up failed: " + "y".repeat(500);
    expect(fullErrorLine(row({ error: long }))).toBe(`ERROR (full): ${long}`);
  });

  test("nothing extra when the cell already holds the whole error", () => {
    expect(fullErrorLine(row({ error: "clone failed: 403" }))).toBeNull();
    expect(fullErrorLine(row({ error: null }))).toBeNull();
  });
});
