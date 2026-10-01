// container/studio-bringup.sh — the tailscale-up region (issue #395, item 2).
//
// Two independent bugs on the SAME line, both found investigating issue
// #395's own pipefail concern:
//
// 1. (bigger, found by this task, outside #395's own filed text) The check's
//    literal, `"BackendState":"Running"` with no space, never matched real
//    tailscale output at all: `tailscale status --json` pretty-prints (Go's
//    standard indented JSON), so the real field reads `"BackendState":
//    "Running",` — a space after the colon. Verified live against the real
//    `tailscale` binary on this sandbox (561KB of real status JSON, a real
//    tailnet): the OLD literal matched 0 times; `grep -qE
//    '"BackendState":[[:space:]]*"Running"'` matches every time. This means
//    every bring-up called `tailscale up` unconditionally — the pipefail bug
//    below never had a "correct" case to even race against.
//
// 2. (#395's own filed concern) `tailscale status --json | grep -q '...'`
//    was a bare pipe under this script's own `set -euo pipefail` (line 21):
//    the same SIGPIPE/pipefail mechanism #393 proved live against
//    install-cache.ts's traversal guard. Fixed the same way: capture into a
//    variable, check via process substitution.
//
// Root-cause investigation this task ran into a genuinely surprising result
// forcing item 2's OWN race live: it depends heavily on where the match
// sits relative to newlines, not just total size. `tailscale status --json`
// puts `BackendState` on line 4 of ~11,930 real lines — grep only needs to
// buffer a few dozen bytes to decide, so it exits before the writer has
// gotten anywhere near a full 64KB pipe buffer; racing the REAL binary here,
// 0/5 trials. A COMPACT (no-newline) JSON blob of the same byte size DOES
// race reliably (grep can't test a "line" until it's read one, and with no
// newlines that means nearly the whole blob) — but that shape doesn't match
// what tailscale (or `git diff --name-only`, checked for issue #395's other
// site) actually emits. Forcing an unrealistic shape just to win a race
// would prove the general MECHANISM (already proven by #393), not this
// specific site — so this file tests plain correctness instead: does the
// FIXED, real region correctly read a large, REAL-shaped (multi-line,
// pretty-printed) peer JSON and skip `tailscale up`.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");

function extractRegion(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`region opener ${open} not found in source`);
  const closeAt = src.indexOf(close, openAt);
  if (closeAt === -1) throw new Error(`region terminator ${close} not found in source`);
  return src.slice(src.indexOf("\n", openAt) + 1, closeAt);
}

const REGION = extractRegion(BRINGUP, "tailscale-up");

/** A REAL, large tailscale `status --json` shape: pretty-printed (Go's
 *  standard indented encoding, matching the real binary verified on this
 *  sandbox), `BackendState` near the top, a big `Peer` map after it. */
function buildLargeTailscaleStatusJson(): string {
  const peers: Record<string, unknown> = {};
  for (let i = 0; i < 3000; i++) {
    peers[`peer${i}`] = {
      ID: `n${i}`,
      HostName: `host-${i}`,
      DNSName: `host-${i}.tail.ts.net.`,
      OS: "linux",
      TailscaleIPs: [`100.64.0.${i % 255}`],
      Online: true,
    };
  }
  return JSON.stringify({ Version: "1.70.0", BackendState: "Running", Self: { HostName: "me" }, Peer: peers }, null, 2);
}

describe("studio-bringup.sh — tailscale-up region (issue #395)", () => {
  test("bug 1 — the OLD literal (no space) never matches real tailscale's own pretty-printed JSON; the FIXED pattern does", () => {
    const json = buildLargeTailscaleStatusJson();
    expect(json).toContain('"BackendState": "Running"'); // real tailscale's own shape (space after the colon)
    const oldPattern = /"BackendState":"Running"/;
    const fixedPattern = /"BackendState":[ \t]*"Running"/;
    expect(oldPattern.test(json)).toBe(false); // the bug: this NEVER matched
    expect(fixedPattern.test(json)).toBe(true);
  });

  test("MUTANT PROOF — the FIXED, shipped tailscale-up region correctly detects a large, real-shaped peer-JSON as running and never calls `tailscale up`", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-tailscale-proof-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const statusJsonFile = join(dir, "status.json");
      writeFileSync(statusJsonFile, buildLargeTailscaleStatusJson());
      const upCallsFile = join(dir, "up-calls.log");
      writeFileSync(upCallsFile, "");
      writeFileSync(
        join(bin, "tailscale"),
        `#!/bin/bash\n` +
          `if [ "$1" = "status" ]; then cat ${JSON.stringify(statusJsonFile)}; exit 0; fi\n` +
          `if [ "$1" = "up" ]; then echo "$@" >> ${JSON.stringify(upCallsFile)}; exit 0; fi\n` +
          `exit 1\n`,
      );
      chmodSync(join(bin, "tailscale"), 0o755);

      const scriptPath = join(dir, "region.sh");
      writeFileSync(scriptPath, `set -euo pipefail\n${REGION}`);
      const r = Bun.spawnSync({
        cmd: ["bash", scriptPath],
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, TS_AUTHKEY: "dummy-key", STUDIO_ID: "test-studio" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      expect(r.exitCode).toBe(0);
      expect(readFileSync(upCallsFile, "utf8").trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a genuinely down tailscale (no BackendState:Running anywhere) still calls `tailscale up`", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-tailscale-down-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const upCallsFile = join(dir, "up-calls.log");
      writeFileSync(upCallsFile, "");
      writeFileSync(
        join(bin, "tailscale"),
        `#!/bin/bash\n` +
          `if [ "$1" = "status" ]; then echo '{"BackendState": "Stopped"}'; exit 1; fi\n` +
          `if [ "$1" = "up" ]; then echo "$@" >> ${JSON.stringify(upCallsFile)}; exit 0; fi\n` +
          `exit 1\n`,
      );
      chmodSync(join(bin, "tailscale"), 0o755);

      const scriptPath = join(dir, "region.sh");
      writeFileSync(scriptPath, `set -euo pipefail\n${REGION}`);
      const r = Bun.spawnSync({
        cmd: ["bash", scriptPath],
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, TS_AUTHKEY: "dummy-key", STUDIO_ID: "test-studio" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      expect(r.exitCode).toBe(0);
      expect(readFileSync(upCallsFile, "utf8")).toContain("--hostname=test-studio");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Issue #189: a full tailnet (`node quota reached`) made `tailscale up` exit
// 1, `set -e` killed bring-up, and every new studio came back bare. Nothing
// a studio does needs the tailnet (attach is a WSS through the Worker), so
// the region must log, leave a marker the provisioned check reads, and go on.
describe("studio-bringup.sh — tailscale-up failure is non-fatal (issue #189)", () => {
  function runRegion(upBehaviour: string, opts: { seedMarker?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "fleet-tailscale-189-"));
    const bin = join(dir, "bin");
    const ws = join(dir, "ws");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(ws, ".fleet"), { recursive: true });
    if (opts.seedMarker) writeFileSync(join(ws, ".fleet", "tailnet-down"), "tailnet: down\n");
    writeFileSync(
      join(bin, "tailscale"),
      `#!/bin/bash\n` +
        `if [ "$1" = "status" ]; then echo '{"BackendState": "NeedsLogin"}'; exit 1; fi\n` +
        `if [ "$1" = "up" ]; then ${upBehaviour}; fi\n` +
        `exit 1\n`,
    );
    chmodSync(join(bin, "tailscale"), 0o755);
    const scriptPath = join(dir, "region.sh");
    writeFileSync(scriptPath, `set -euo pipefail\n${REGION}\necho REACHED-NEXT-STEP\n`);
    const r = Bun.spawnSync({
      cmd: ["bash", scriptPath],
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, TS_AUTHKEY: "dummy-key", STUDIO_ID: "test-studio", FLEET_WORKSPACE: ws },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const markerPath = join(ws, ".fleet", "tailnet-down");
    let marker: string | null = null;
    try { marker = readFileSync(markerPath, "utf8"); } catch { marker = null; }
    rmSync(dir, { recursive: true, force: true });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), marker };
  }

  test("quota error: bring-up continues, logs the FAILED line with tailscale's own first stderr line, marker says quota reached", () => {
    const r = runRegion(`echo "backend error: node quota reached on this tailnet" >&2; echo "second line" >&2; exit 1`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("REACHED-NEXT-STEP");
    expect(r.stderr).toContain(
      "studio-bringup: tailscale-up FAILED (backend error: node quota reached on this tailnet), continuing without tailnet",
    );
    expect(r.stderr).not.toContain("second line), continuing");
    expect(r.marker).toBe("tailnet: quota reached\n");
  });

  test("any other tailscale-up failure: continues, marker says down", () => {
    const r = runRegion(`echo "invalid key: unable to validate API key" >&2; exit 1`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("REACHED-NEXT-STEP");
    expect(r.stderr).toContain("studio-bringup: tailscale-up FAILED (invalid key: unable to validate API key), continuing without tailnet");
    expect(r.marker).toBe("tailnet: down\n");
  });

  test("a successful tailscale up clears a stale marker from an earlier run", () => {
    const r = runRegion(`exit 0`, { seedMarker: true });
    expect(r.code).toBe(0);
    expect(r.marker).toBeNull();
  });
});
