// PR #343 round-4 review, blocker 4: scripts/deploy.sh's unfilled-placeholder
// check (`grep -q '<YOUR_' "$FLEET_CONFIG"`) scans the WHOLE config file,
// including JSONC `//` comment lines. wrangler.example.jsonc's own
// explanatory comments (e.g. "This template's own placeholders all use the
// literal `<YOUR_` prefix on purpose...") mention that literal substring, so
// a stranger who correctly fills in every REAL config value still gets
// refused by deploy.sh, because the check cannot tell a real unfilled value
// from a comment merely discussing the placeholder syntax.
//
// Fixed by making the check ignore comment lines before searching for
// `<YOUR_`. Runs a COPY of the real scripts/deploy.sh end-to-end (not a
// re-typed copy of its check) inside a temp app dir, with a stubbed
// `wrangler` so the assertion is "did deploy.sh let the wrangler binary get
// invoked", never a `wrangler` network call.
//
// Issue #379 round 2 (BLOCKER): deploy.sh now runs ONLY the app's pinned
// node_modules/.bin/wrangler, never PATH's. This file used to run the real
// scripts/deploy.sh in place with its stub on PATH -- so it ran the REAL
// wrangler deploy from the real apps/fleet (and overwrote its
// wrangler.local.jsonc). The copy + temp app dir + pinned stub is the only
// safe shape; a PATH decoy that must never run proves the stub is the one
// used.
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEPLOY_SH = join(import.meta.dir, "../../scripts/deploy.sh");
const WRANGLER_CALLED = "STUB_WRANGLER_CALLED";
const PATH_DECOY_CALLED = "PATH_DECOY_WRANGLER_CALLED";

/** The app's pinned wrangler: the stub at node_modules/.bin, its installed
 *  package.json, and a bun.lock pinning the same version (#379 version check). */
function writeInstalledWrangler(app: string, stub: string, version = "4.141.0") {
  mkdirSync(join(app, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(app, "node_modules", "wrangler"), { recursive: true });
  writeFileSync(join(app, "node_modules", ".bin", "wrangler"), stub, { mode: 0o755 });
  chmodSync(join(app, "node_modules", ".bin", "wrangler"), 0o755);
  writeFileSync(join(app, "node_modules", "wrangler", "package.json"), JSON.stringify({ name: "wrangler", version }));
  writeFileSync(join(app, "bun.lock"), `{\n  "packages": {\n    "wrangler": ["wrangler@${version}", "", {}, "sha512-x"],\n  }\n}\n`);
}

function run(configBody: string): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "deploy-sh-"));
  try {
    // A temp app dir holding a copy of deploy.sh and a stub at the pinned
    // path: deploy.sh `exec`s it as the very last step, so whether it ran at
    // all is the signal for "the placeholder check let this config through."
    const app = join(dir, "app");
    mkdirSync(join(app, "scripts"), { recursive: true });
    copyFileSync(DEPLOY_SH, join(app, "scripts", "deploy.sh"));
    writeInstalledWrangler(app, `#!/bin/sh\necho ${WRANGLER_CALLED}\n`);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const decoy = join(bin, "wrangler");
    writeFileSync(decoy, `#!/bin/sh\necho ${PATH_DECOY_CALLED}\nexit 97\n`, { mode: 0o755 });
    chmodSync(decoy, 0o755);

    const config = join(dir, "wrangler.jsonc");
    writeFileSync(config, configBody);

    const proc = Bun.spawnSync({
      cmd: ["bash", join(app, "scripts", "deploy.sh")],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FLEET_CONFIG: config },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return {
      code: proc.exitCode ?? -1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scripts/deploy.sh — unfilled-placeholder check must ignore // comment lines", () => {
  test("a fully filled config, with '<YOUR_' appearing only inside // comments, is NOT refused", () => {
    const config = [
      "// This template's own placeholders all use the literal `<YOUR_` prefix",
      "// on purpose: scripts/deploy.sh refuses to deploy while that substring",
      "// is still present.",
      "{",
      '  "name": "acme-fleet",',
      '  "vars": { "AGENT_REPO": "acme/fleetflare" }',
      "}",
    ].join("\n");

    const r = run(config);

    expect(r.stderr).not.toContain("unfilled");
    expect(r.stdout).toContain(WRANGLER_CALLED);
    expect(r.stdout).not.toContain(PATH_DECOY_CALLED);
    expect(r.code).toBe(0);
  });

  test("a real unfilled '<YOUR_...>' VALUE (not in a comment) is still refused", () => {
    const config = [
      "{",
      '  "name": "<YOUR_WORKER_NAME>",',
      '  "vars": { "AGENT_REPO": "acme/fleetflare" }',
      "}",
    ].join("\n");

    const r = run(config);

    expect(r.stdout).not.toContain(WRANGLER_CALLED);
    expect(r.stdout).not.toContain(PATH_DECOY_CALLED);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unfilled");
  });

  // Issue #395: the check's second stage (`grep -q '<YOUR_'`) is a quiet,
  // early-exit-on-match grep fed by a pipe, under this script's own
  // `set -euo pipefail` -- the same shape #393 proved genuinely vulnerable
  // to a SIGPIPE/pipefail misfire on install-cache.ts's traversal guard when
  // its input is large and the match comes early. Real `wrangler.jsonc`
  // configs stay small, so the reviewer marked this one "harmless" rather
  // than exploitable -- this is a correctness regression test against the
  // real, fixed script for a config well past comfortable pipe-buffer size
  // (64KB), not a forced-race mutant proof.
  test("an unfilled placeholder on line 1, followed by >100KB of // comment padding, is still refused", () => {
    const padding = Array.from({ length: 4000 }, (_, i) => `// padding comment line ${i}, just filler text to pad size`).join("\n");
    const config = [
      '{ "name": "<YOUR_WORKER_NAME>",',
      '  "vars": { "AGENT_REPO": "acme/fleetflare" } }',
      padding,
    ].join("\n");
    expect(config.length).toBeGreaterThan(100_000);

    const r = run(config);

    expect(r.stdout).not.toContain(WRANGLER_CALLED);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unfilled");
  });
});
