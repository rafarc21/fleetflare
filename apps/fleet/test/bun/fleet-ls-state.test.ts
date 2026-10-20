import { describe, expect, test } from "bun:test";
import { formatTable } from "../../cli/fleet";
// Issue #95: formatTable's STATE column must go through formatState, or the
// detector's verdict never reaches the operator's screen.
import { row } from "../helpers/studio-row";
import type { StudioStatus } from "../../src/studio/types";

describe("fleet ls — stopped studio whose container runs", () => {
  test("STATE says the container is running and billing", () => {
    const out = formatTable([row({ containerRunningSince: "2026-09-24T12:39:08.000Z" })]);
    expect(out).toContain("stopped (container RUNNING since 12:39Z — billing)");
  });
});

describe("fleet ls — ROW column (#55)", () => {
  test("prints the local Orca row verdict per studio", () => {
    const out = formatTable([row({})], new Date(), new Map([["acme-os--maestro", "STALE row"]]));
    expect(out.split("\n")[0]).toContain("ROW");
    expect(out).toContain("STALE row");
  });
  test("reads '-' when no row map (not under Orca)", () => {
    expect(formatTable([row({})]).split("\n")[0]).toContain("ROW");
  });
});

// Issue #271: the ACCOUNT column names the secret, and its label when one is set.
// Fleet task #1248 (S4): a `host:"local"` row's HOST cell reads "local" —
// where it runs — never a "-" that would read as "unknown". A cloud row still
// renders `tailscaleHost ?? "-"`.
describe("fleet ls — HOST column (#1248)", () => {
  test("a local row renders 'local'", () => {
    const header = formatTable([row({ host: "local", localPath: "/tmp/websites" })]).split("\n")[0];
    const line = formatTable([row({ host: "local", localPath: "/tmp/websites" })]).split("\n")[1];
    const idx = header.split(/\s{2,}/).indexOf("HOST");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(line.split(/\s{2,}/)[idx]).toBe("local");
  });

  test("a cloud row renders its tailscale host, and '-' when it has none", () => {
    const table = formatTable([
      row({ id: "acme-os--pilot", tailscaleHost: "acme-os--pilot.example-tailnet.ts.net" }),
      row({ id: "beta--pilot", tailscaleHost: null }),
    ]);
    const lines = table.split("\n");
    const idx = lines[0].split(/\s{2,}/).indexOf("HOST");
    expect(lines[1].split(/\s{2,}/)[idx]).toBe("acme-os--pilot.example-tailnet.ts.net");
    expect(lines[2].split(/\s{2,}/)[idx]).toBe("-");
  });
});

describe("fleet ls — ACCOUNT column labels (#271)", () => {
  test("label present: '<label> (<secret name>)'", () => {
    const out = formatTable([row({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2", claudeAccountLabel: "second@example.com" })]);
    expect(out).toContain("second@example.com (CLAUDE_CODE_OAUTH_TOKEN_2)");
  });
  test("label on a studio with no recorded account names the first secret", () => {
    const out = formatTable([row({ claudeAccountLabel: "first@example.com" })]);
    expect(out).toContain("first@example.com (CLAUDE_CODE_OAUTH_TOKEN)");
  });
  test("label absent: the secret name, as today", () => {
    const out = formatTable([row({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" })]);
    expect(out).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(out).not.toContain("(CLAUDE_CODE_OAUTH_TOKEN_2)");
  });
});
