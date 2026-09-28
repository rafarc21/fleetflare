import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";

// Board #350, round 5 review, item 1 — gates/install-marker.sh is the NEW
// PostToolUse hook install-cache.ts's own bunInstallRunningCmd now depends
// on: it touches `node_modules/.fleet-install-complete` right after a real
// package-manager install command finishes in a directory and looks like it
// actually succeeded, replacing round 4's own over-broad live-/proc-scan
// signal entirely (see that function's own doc comment in install-cache.ts,
// and this file's sibling test/bun/install-cache-security.test.ts for the
// bunInstallRunningCmd-side proof that a settled marker correctly ignores an
// unrelated long-lived process).
//
// This file exercises the REAL, shipped gates/install-marker.sh — read
// directly off disk, the same "single source of truth, read raw" convention
// test/bun/bringup-hooks.test.ts already uses for lead-gate.sh/
// completion-gate.sh (board issue #2/#17) — run via runSnippet the same way
// Claude Code itself spawns a hook subprocess (sourced: false, the default,
// per exec-snippet.ts's own doc comment on which mode models a hook script).
const INSTALL_MARKER_GATE = readFileSync(join(import.meta.dir, "../../../../gates/install-marker.sh"), "utf8");

const MARKER_NAME = ".fleet-install-complete";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "fleet-install-marker-gate-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A directory with a real, non-empty `node_modules` — the shape this hook
 *  requires before it will ever touch the marker (this file's own header on
 *  install-marker.sh: an empty/absent node_modules is never marked settled,
 *  matching bunInstallRunningCmd's own "never-completed reads as running"
 *  posture). */
function seedInstalledDir(): string {
  const dir = join(base, "site-a");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg.js"), "module.exports = 1;\n");
  return dir;
}

function markerPath(dir: string): string {
  return join(dir, "node_modules", MARKER_NAME);
}

/** Runs the real, shipped hook against a payload, with STUDIO_ID set (a real
 *  cloud studio) unless the test overrides it — same explicit-override
 *  convention test/bun/bringup-hooks.test.ts's own "no-ops without
 *  STUDIO_ID" describe block uses, so this suite is deterministic regardless
 *  of whatever the ambient shell running it happens to have set. */
function runGate(payload: unknown, env: Record<string, string> = {}): ReturnType<typeof runSnippet> {
  return runSnippet({
    script: INSTALL_MARKER_GATE,
    stdin: JSON.stringify(payload),
    shell: "bash",
    env: { STUDIO_ID: "test-studio--role", ...env },
    timeout: 10_000,
  });
}

function bashPayload(command: string, cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    tool_name: "Bash",
    cwd,
    tool_input: { command },
    tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false },
    ...overrides,
  };
}

describe("install-marker.sh no-ops without STUDIO_ID (defense in depth, same posture as every other gate in this directory)", () => {
  test("a genuine bun install call writes NO marker when STUDIO_ID is absent", () => {
    const dir = seedInstalledDir();
    const r = runGate(bashPayload("bun install", dir), { STUDIO_ID: "" });
    expect(r.code).toBe(0);
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  test("the SAME call DOES write the marker once STUDIO_ID is set — no regression to real behavior inside a studio", () => {
    const dir = seedInstalledDir();
    runGate(bashPayload("bun install", dir));
    expect(existsSync(markerPath(dir))).toBe(true);
  });
});

describe("install-marker.sh — matches every named install invocation shape", () => {
  for (const command of ["bun install", "bun i", "npm install", "npm ci", "npm i", "yarn", "yarn install", "pnpm install", "pnpm i"]) {
    test(`"${command}" writes the marker`, () => {
      const dir = seedInstalledDir();
      runGate(bashPayload(command, dir));
      expect(existsSync(markerPath(dir))).toBe(true);
    });
  }

  test("a compound command (cd into a subdirectory, then install, as ONE Bash call) still matches on its own install segment", () => {
    const dir = seedInstalledDir();
    // Claude Code updates the hook payload's own `cwd` per real `cd`
    // activity within a session (verified against Claude Code's own hooks
    // documentation) — a `cd site-a && bun install` call already lands here
    // with `cwd` reflecting site-a by the time the hook fires, exactly like
    // the payload this models.
    runGate(bashPayload("cd site-a && bun install", dir));
    expect(existsSync(markerPath(dir))).toBe(true);
  });

  test("--cwd overrides the payload's own cwd — bun/pnpm's own explicit target, which never moves the shell's own cwd at all", () => {
    const other = seedInstalledDir();
    const r = runGate(bashPayload(`bun install --cwd ${other}`, base));
    expect(r.code).toBe(0);
    expect(existsSync(markerPath(other))).toBe(true);
  });

  test("--prefix overrides the payload's own cwd — npm's own equivalent flag", () => {
    const other = seedInstalledDir();
    runGate(bashPayload(`npm install --prefix ${other}`, base));
    expect(existsSync(markerPath(other))).toBe(true);
  });
});

describe("install-marker.sh — never writes on anything short of a matched, plausibly-successful install", () => {
  test("a non-Bash tool call is ignored entirely", () => {
    const dir = seedInstalledDir();
    runGate({ tool_name: "Write", cwd: dir, tool_input: { command: "bun install" } });
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  test("an unrelated Bash command is never mistaken for an install", () => {
    const dir = seedInstalledDir();
    runGate(bashPayload("ls -la", dir));
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  test("a command that merely MENTIONS an install invocation (never runs one) does not match — anchored, not a substring search", () => {
    const dir = seedInstalledDir();
    runGate(bashPayload('echo "please run bun install later"', dir));
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  test("interrupted (killed/timed out) never writes the marker, whatever the command", () => {
    const dir = seedInstalledDir();
    runGate(bashPayload("bun install", dir, { tool_response: { stdout: "", stderr: "", interrupted: true } }));
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  test("a known hard-failure marker in stderr (npm error) never writes the marker", () => {
    const dir = seedInstalledDir();
    runGate(bashPayload("npm install", dir, { tool_response: { stdout: "", stderr: "npm error could not resolve dependency tree", interrupted: false } }));
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  // My own finding, verified live against real bun 1.3.12 in this sandbox:
  // an ordinary `bun install` failure (a dependency that cannot resolve,
  // added to an EXISTING node_modules from a prior successful install —
  // exactly the realistic case, not a fresh/empty checkout) leaves
  // node_modules non-empty AND prints stderr text the original FAILURE_RE
  // (npm/pnpm-shaped only) never matched at all:
  //   error: GET https://registry.npmjs.org/<pkg> - 404
  //   error: <pkg>@<version> failed to resolve
  // RED: the pre-fix pattern misses this real text (reconstructed here,
  // never re-declared in the shipped script, so this can't silently drift
  // out of sync with a future edit there). GREEN: the actual shipped hook,
  // run for real via bash against this exact captured stderr, refuses to
  // write the marker.
  const REAL_BUN_RESOLVE_FAILURE_STDERR =
    "bun install v1.3.12 (700fc117)\n" +
    "Resolving dependencies\n" +
    "Resolved, downloaded and extracted [1]\n" +
    "error: GET https://registry.npmjs.org/this-package-definitely-does-not-exist-xyz-123 - 404\n" +
    "error: this-package-definitely-does-not-exist-xyz-123@1.0.0 failed to resolve\n";

  test("RED: the pre-fix (npm/pnpm-only) failure pattern misses a real bun resolve failure", () => {
    const preFixFailureRe = /npm error|npm ERR!|ERR_PNPM|error: (?:Failed|Cannot|EACCES|ENOENT)/i;
    expect(preFixFailureRe.test(REAL_BUN_RESOLVE_FAILURE_STDERR)).toBe(false);
  });

  test("GREEN: a real bun resolve-failure's own stderr never writes the marker (existing node_modules, the realistic case)", () => {
    const dir = seedInstalledDir();
    runGate(bashPayload("bun install", dir, {
      tool_response: { stdout: "", stderr: REAL_BUN_RESOLVE_FAILURE_STDERR, interrupted: false },
    }));
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  // Item 4 (round 6 review) — the maestro's own live-observed bug: this hook
  // used to check ONLY tool_response.stderr, but Claude Code puts a failed
  // command's own combined output into tool_response.stdout instead whenever
  // the command itself redirects stderr into stdout before piping onward
  // (`bun install 2>&1 | tail` — an ordinary, common shell idiom), leaving
  // tool_response.stderr genuinely EMPTY. The maestro confirmed this "wrote
  // marker live" against a real failure of exactly this shape. Fixed by
  // running the SAME FAILURE_RE check against stdout too — a match in EITHER
  // field refuses to write the marker.
  test("RED: before the fix, a failure whose text lands ONLY in stdout (stderr empty) — the exact `2>&1 | tail` shape the maestro observed live — would slip past a stderr-only check entirely", () => {
    const preFixFailureRe = /npm error|npm ERR!|ERR_PNPM|error: (?:Failed|Cannot|EACCES|ENOENT)|error:.*failed to resolve/i;
    // Pre-fix, only stderr was ever tested against FAILURE_RE — an empty
    // stderr means the check has nothing to catch this failure on, no matter
    // how clearly stdout itself carries the real failure text.
    const preFixStderrOnly = "";
    expect(preFixFailureRe.test(preFixStderrOnly)).toBe(false);
  });

  test("GREEN: the real, shipped hook also checks stdout — the same real bun resolve-failure text landing there, with stderr EMPTY (the `2>&1 | tail` shape), still refuses to write the marker", () => {
    const dir = seedInstalledDir();
    runGate(bashPayload("bun install 2>&1 | tail", dir, {
      tool_response: { stdout: REAL_BUN_RESOLVE_FAILURE_STDERR, stderr: "", interrupted: false },
    }));
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  test("non-regression: ordinary successful stdout output from a `2>&1 | tail` pipeline never accidentally matches FAILURE_RE, and the marker is still written normally", () => {
    const dir = seedInstalledDir();
    runGate(bashPayload("bun install 2>&1 | tail", dir, {
      tool_response: {
        stdout: "bun install v1.3.12 (700fc117)\nResolving dependencies\nResolved, downloaded and extracted [1]\nSaved lockfile\n",
        stderr: "",
        interrupted: false,
      },
    }));
    expect(existsSync(markerPath(dir))).toBe(true);
  });

  test("an ABSENT node_modules never writes the marker — nothing to mark settled yet", () => {
    const dir = join(base, "site-b"); // never created at all
    runGate(bashPayload("bun install", dir));
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  test("an EMPTY node_modules never writes the marker either — present but nothing actually landed", () => {
    const dir = join(base, "site-c");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    runGate(bashPayload("bun install", dir));
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  test("malformed stdin (not JSON) never crashes the hook into an unexpected exit code", () => {
    const r = runSnippet({
      script: INSTALL_MARKER_GATE, stdin: "not json at all", shell: "bash",
      env: { STUDIO_ID: "test-studio--role" }, timeout: 10_000,
    });
    expect(r.code).toBe(0);
  });

  test("PostToolUse semantics: this hook never blocks — exit 0 on every path, matched or not, success or refusal-shaped", () => {
    const dir = seedInstalledDir();
    expect(runGate(bashPayload("bun install", dir)).code).toBe(0); // matched, wrote marker
    expect(runGate(bashPayload("ls -la", dir)).code).toBe(0); // unmatched
    expect(runGate(bashPayload("npm install", dir, { tool_response: { stdout: "", stderr: "npm error boom", interrupted: false } })).code).toBe(0); // matched, refused to mark
  });
});
