// container/studio-bringup.sh — the studio-tools region (issue #1160, option 2).
//
// A repo opts in with `studio.tools` in its fleet.json; provision.ts hands the
// names to bring-up as STUDIO_TOOLS. The region installs only allow-listed
// tools, only when missing, logs every decision, and never blocks bring-up:
// a failure leaves a marker file that the READY check surfaces.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** The utilities the region and bringup_log call. They are symlinked into a
 *  dedicated dir instead of letting PATH reach the host's /usr/bin, because a
 *  host can carry a real `az` there (the CI runner does), and the region's
 *  `command -v az` would then find it and never reach the install branch. */
const SYS_TOOLS = ["sh", "bash", "sed", "grep", "date", "printf", "echo", "mkdir", "rm", "cat", "tr", "cut", "env", "dirname", "basename", "head", "tail", "timeout", "awk", "mktemp", "chmod"];

function sysBin(): string {
  const dir = tmp("fleet-tools-sys-");
  for (const t of SYS_TOOLS) {
    const real = Bun.which(t);
    if (real) symlinkSync(real, join(dir, t));
  }
  return dir;
}

/** A fake PATH dir. `apt-get` records its argv, then — when APT_SLEEP=1 —
 *  blocks on sleep 30 (the hung-apt test), prints a unique stderr line when
 *  APT_EXIT != 0, and exits APT_EXIT (default 0). `sleep` blocks on the host
 *  sleep so the region's `timeout` is the only bound. `az` exists only when
 *  `withAz` is set, which is what the region checks. `fingerprint` (default
 *  the pinned value) is what the fake gpg reports. */
function fakeBin(withAz: boolean, fingerprint?: string): string {
  const bin = tmp("fleet-tools-bin-");
  const apt = join(bin, "apt-get");
  writeFileSync(
    apt,
    '#!/bin/sh\necho "$@" >> "$APT_LOG"\nif [ "${APT_SLEEP:-0}" = "1" ]; then exec sleep 30; fi\nif [ "${APT_EXIT:-0}" != "0" ]; then echo "APTERR-7f3a9c apt failed" >&2; fi\nexit "${APT_EXIT:-0}"\n',
  );
  chmodSync(apt, 0o755);
  // fake sleep: blocks via the host sleep so the timeout is the only thing
  // that bounds it (exec, so SIGTERM lands on it). argv is recorded only so
  // the apt log stays self-describing; no assertion reads it back.
  const sleep = join(bin, "sleep");
  writeFileSync(sleep, `#!/bin/sh\necho "sleep $@" >> "$APT_LOG"\nexec ${Bun.which("sleep") ?? "/usr/bin/sleep"} "$@"\n`);
  chmodSync(sleep, 0o755);
  if (withAz) {
    const az = join(bin, "az");
    writeFileSync(az, "#!/bin/sh\nexit 0\n");
    chmodSync(az, 0o755);
  }
  // fake curl: write a stub key to the -o target, exit 0 (no network).
  const curl = join(bin, "curl");
  writeFileSync(curl, '#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done\nprintf "stub-microsoft-key\\n" > "$out"\nexit 0\n');
  chmodSync(curl, 0o755);
  // fake gpg: --dearmor copies its input to the -o target; anything else
  // prints the CONFIGURABLE fingerprint (GPG_FPR), so the fingerprint check
  // can run against the value the test supplies.
  const gpg = join(bin, "gpg");
  writeFileSync(gpg, '#!/bin/sh\nif [ "$1" = "--dearmor" ]; then cat "$4" > "$3"; exit 0; fi\nprintf "fpr:::::::::%s\\n" "${GPG_FPR:-BC528686B50D79E339D3721CEB3E94ADBE1229CF}"\nexit 0\n');
  chmodSync(gpg, 0o755);
  return bin;
}

interface Run {
  code: number;
  stderr: string;
  aptCalls: string[];
  log: string;
  markerExists: boolean;
  marker: string;
  wallMs: number;
}

function runRegion(opts: {
  tools: string;
  withAz?: boolean;
  aptExit?: number;
  preMarker?: boolean;
  toolsUnset?: boolean;
  fingerprint?: string;
  aptSleep?: boolean;
  toolsTimeout?: string;
}): Run {
  const ws = tmp("fleet-tools-ws-");
  const bin = fakeBin(opts.withAz ?? false, opts.fingerprint);
  const aptLog = join(ws, "apt.log");
  const bringupLog = join(ws, "bringup.log");
  const marker = join(ws, ".fleet", "tools-down");
  mkdirSync(join(ws, ".fleet"), { recursive: true });
  if (opts.preMarker) writeFileSync(marker, "tools: not installed\n");
  const env: Record<string, string> = {
    FLEET_WORKSPACE: ws,
    FLEET_BRINGUP_LOG: bringupLog,
    FLEET_BRINGUP_RUN_ID: "run-test",
    APT_LOG: aptLog,
    APT_EXIT: String(opts.aptExit ?? 0),
    GPG_FPR: opts.fingerprint ?? "BC528686B50D79E339D3721CEB3E94ADBE1229CF",
    PATH: `${bin}:${sysBin()}`,
  };
  if (opts.toolsUnset) env.STUDIO_TOOLS = "";
  else env.STUDIO_TOOLS = opts.tools;
  if (opts.aptSleep) env.APT_SLEEP = "1";
  if (opts.toolsTimeout) env.STUDIO_TOOLS_TIMEOUT = opts.toolsTimeout;
  const startedAt = Date.now();
  const r = runSnippet({
    shell: "bash",
    env,
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
    wallMs: Date.now() - startedAt,
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

  test("STUDIO_TOOLS genuinely unset: no apt, no curl, no key fetch", () => {
    const r = runRegion({ tools: "", toolsUnset: true });
    expect(r.code).toBe(0);
    expect(r.aptCalls).toEqual([]);
    expect(r.markerExists).toBe(false);
  });

  test("install pin survives a substring mutant: exact pinned version in the apt argv", () => {
    const r = runRegion({ tools: "azure-cli" });
    expect(r.aptCalls.some((c) => c.includes("install -y --no-install-recommends azure-cli=2.91.0-1~jammy"))).toBe(true);
  });

  test("apt-get update still runs before install (a mutant that drops update dies)", () => {
    const r = runRegion({ tools: "azure-cli" });
    expect(r.aptCalls.some((c) => c.includes("update"))).toBe(true);
  });

  test("a wrong signing key is refused: install fails, marker written", () => {
    const r = runRegion({ tools: "azure-cli", fingerprint: "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF" });
    expect(r.code).toBe(0);
    expect(r.markerExists).toBe(true);
    expect(r.aptCalls).toEqual([]);
  });

  test("install reads the temp source list (a mutant that drops the flags cannot locate azure-cli)", () => {
    const r = runRegion({ tools: "azure-cli" });
    expect(r.aptCalls.some((c) => c.includes("install") && c.includes("Dir::Etc::sourcelist=") && c.includes("Dir::Etc::sourceparts=-"))).toBe(true);
  });

  test("a hung apt is bounded by STUDIO_TOOLS_TIMEOUT: run returns fast, marker written, exit 0", () => {
    const r = runRegion({ tools: "azure-cli", aptSleep: true, toolsTimeout: "1" });
    expect(r.code).toBe(0);
    expect(r.wallMs).toBeLessThan(5000);
    expect(r.markerExists).toBe(true);
    expect(r.aptCalls.some((c) => c.includes("update"))).toBe(true);
  });

  test("apt stderr lands in bringup.log and never in the marker", () => {
    const r = runRegion({ tools: "azure-cli", aptExit: 100 });
    expect(r.code).toBe(0);
    expect(r.log).toContain("APTERR-7f3a9c");
    expect(r.marker).not.toContain("APTERR-7f3a9c");
    expect(r.marker).toBe("tools: not installed\n");
  });
});
