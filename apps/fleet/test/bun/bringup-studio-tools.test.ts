// container/studio-bringup.sh — the studio-tools region (issue #1160, option 2).
//
// A repo opts in with `studio.tools` in its fleet.json; provision.ts hands the
// names to bring-up as STUDIO_TOOLS. The region installs only allow-listed
// tools, only when missing, logs every decision, and never blocks bring-up:
// a failure leaves a marker file that the READY check surfaces.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRINGUP, extractRegion, extractShellFunc, runSnippet } from "./exec-snippet";

const REGION = extractRegion(BRINGUP, "studio-tools");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A fake PATH dir. `apt-get` records its argv and exits APT_EXIT (default 0);
 *  `az` exists only when `withAz` is set, which is what the region checks. */
function fakeBin(withAz: boolean): string {
  const bin = tmp("fleet-tools-bin-");
  const apt = join(bin, "apt-get");
  writeFileSync(apt, '#!/bin/sh\necho "$@" >> "$APT_LOG"\nexit "${APT_EXIT:-0}"\n');
  chmodSync(apt, 0o755);
  if (withAz) {
    const az = join(bin, "az");
    writeFileSync(az, "#!/bin/sh\nexit 0\n");
    chmodSync(az, 0o755);
  }
  return bin;
}

interface Run {
  code: number;
  stderr: string;
  aptCalls: string[];
  log: string;
  markerExists: boolean;
  marker: string;
}

function runRegion(opts: { tools: string; withAz?: boolean; aptExit?: number; preMarker?: boolean }): Run {
  const ws = tmp("fleet-tools-ws-");
  const bin = fakeBin(opts.withAz ?? false);
  const aptLog = join(ws, "apt.log");
  const bringupLog = join(ws, "bringup.log");
  const marker = join(ws, ".fleet", "tools-down");
  mkdirSync(join(ws, ".fleet"), { recursive: true });
  if (opts.preMarker) writeFileSync(marker, "tools: not installed\n");
  const r = runSnippet({
    shell: "bash",
    env: {
      FLEET_WORKSPACE: ws,
      FLEET_BRINGUP_LOG: bringupLog,
      FLEET_BRINGUP_RUN_ID: "run-test",
      APT_LOG: aptLog,
      APT_EXIT: String(opts.aptExit ?? 0),
      STUDIO_TOOLS: opts.tools,
      PATH: `${bin}:/usr/bin:/bin`,
    },
    script:
      "set -euo pipefail\n" +
      `${extractShellFunc(BRINGUP, "bringup_redact")}\n` +
      `${extractShellFunc(BRINGUP, "bringup_log")}\n` +
      `${extractShellFunc(BRINGUP, "bringup_step")}\n` +
      REGION,
  });
  expect(r.parentAlive).toBe(true);
  return {
    code: r.code,
    stderr: r.stderr,
    aptCalls: existsSync(aptLog) ? readFileSync(aptLog, "utf8").trim().split("\n").filter(Boolean) : [],
    log: existsSync(bringupLog) ? readFileSync(bringupLog, "utf8") : "",
    markerExists: existsSync(marker),
    marker: existsSync(marker) ? readFileSync(marker, "utf8") : "",
  };
}

describe("studio-tools region", () => {
  test("is present in the bring-up script", () => {
    expect(REGION).toContain("STUDIO_TOOLS");
  });

  test("no tools declared: nothing installed, no marker, exit 0", () => {
    const r = runRegion({ tools: "" });
    expect(r.code).toBe(0);
    expect(r.aptCalls).toEqual([]);
    expect(r.markerExists).toBe(false);
  });

  test("azure-cli declared and missing: installed via apt-get, logged", () => {
    const r = runRegion({ tools: "azure-cli" });
    expect(r.code).toBe(0);
    expect(r.aptCalls.some((c) => c.includes("install") && c.includes("azure-cli"))).toBe(true);
    expect(r.log).toContain("tools azure-cli");
    expect(r.markerExists).toBe(false);
  });

  test("azure-cli already on PATH: idempotent, apt-get not called", () => {
    const r = runRegion({ tools: "azure-cli", withAz: true });
    expect(r.code).toBe(0);
    expect(r.aptCalls).toEqual([]);
    expect(r.log).toContain("tools azure-cli");
  });

  test("apt-get failure: bring-up continues, marker written, READY note source", () => {
    const r = runRegion({ tools: "azure-cli", aptExit: 100 });
    expect(r.code).toBe(0);
    expect(r.markerExists).toBe(true);
    expect(r.marker).toContain("tools: not installed");
    expect(r.stderr).toContain("studio-bringup: tools");
  });

  test("a later successful install clears the marker", () => {
    const r = runRegion({ tools: "azure-cli", preMarker: true });
    expect(r.code).toBe(0);
    expect(r.markerExists).toBe(false);
  });

  test("unknown tool name: never installed, marker written, bring-up continues", () => {
    const r = runRegion({ tools: "kubectl" });
    expect(r.code).toBe(0);
    expect(r.aptCalls).toEqual([]);
    expect(r.markerExists).toBe(true);
    expect(r.stderr).toContain("kubectl");
  });

  test("mixed list: known tool installed, unknown tool noted", () => {
    const r = runRegion({ tools: "azure-cli kubectl" });
    expect(r.code).toBe(0);
    expect(r.aptCalls.some((c) => c.includes("azure-cli"))).toBe(true);
    expect(r.markerExists).toBe(true);
  });
});
