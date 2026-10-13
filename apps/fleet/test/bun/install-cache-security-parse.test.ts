// The PARSE half of the former test/bun/install-cache-security.test.ts (split
// per docs/maintainability/plans/2026-10-13-s26f12-install-cache-security-split-699.md,
// refs #699): restore security (item 4), truncated-download atomicity (item 2),
// item 5 injection, bunInstallRunningCmd (fs + /proc), path traversal, symlink
// guard, tombstone, round-5 disk-space preflight. The DISK half — round-6
// streamed SPACE proof, symlink member guards, round-7 real-full-disk ENOSPC —
// lives in test/bun/install-cache-security-disk.test.ts.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import {
  installCacheRestoreCmd, INSTALL_CACHE_URL_ENV, discoverCacheDirsCmd, lockHashCmd,
  nodeModulesPresentCmd, installCacheSaveCmd, LOCKFILE_CANDIDATES, WORKSPACE_LOCK_MARKERS,
  bunInstallRunningCmd, parseBunInstallRunning, INSTALL_ACTIVITY_WINDOW_SECONDS,
  parseCacheDirs, absoluteCacheDir, guardDirWithinRepo,
  runInstallCacheRestore, type InstallCacheRestoreDeps,
} from "../../src/studio/install-cache";

// Board #350, round 2 review, items 2 (truncated-download atomicity) and 4
// (SECURITY — extraction scope). Both are guarantees about what a REAL
// shell (bash + curl + zstd + GNU tar) does with a real archive on a real
// filesystem — vitest-pool-workers (workerd, test/install-cache.test.ts's
// own lane) has neither a filesystem nor child_process and can only assert
// on the command TEXT, never on the behaviour those flags/pipes actually
// produce. This file is the "no filesystem in workerd" split
// vitest.config.ts's own header describes for container/server.ts and
// studio-bringup.sh, applied to install-cache.ts's shell commands the same
// way test/bun/session-tar-budget.test.ts already applies it to
// session-sync.ts's tarAndStatCmd.
//
// `curl`'s own `file://` scheme (RFC-standard, no network involved) stands
// in for the presigned R2 GET — this is the REAL curl binary, the REAL
// `installCacheRestoreCmd()` string this repo ships, run through the REAL
// `bash -c` sbExec itself uses (verified: sandbox-api.ts's own doc comment
// on `bash -c`'s argv), against a REAL hand-built archive. Nothing here is a
// re-implementation or a simulation of the command; it is the shipped
// command, executed.
//
// LANE GUARD, same pattern as session-tar-budget.test.ts's own `gnuLane()`:
// `tar --absolute-names` is GNU-specific (BSD tar has no such flag), and
// `zstd` may not be installed on every dev machine. Skipped, not failed,
// when either is missing — CI's Linux lane (this repo's own container base
// image, which already ships both, since the pre-existing `zstd -dc`/`zstd
// -q -c` calls this feature's FIRST commit shipped already assumed it) is
// where the real coverage lives.
function hasGnuTar(): boolean {
  const r = spawnSync("tar", ["--version"], { encoding: "utf8" });
  return r.status === 0 && /GNU tar/.test(r.stdout ?? "");
}
function hasZstd(): boolean {
  const r = spawnSync("zstd", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}
const suite = hasGnuTar() && hasZstd() ? describe : describe.skip;

/** `bunInstallRunningCmd` (round 3 review, item 2) uses `find -newermt`, a
 *  GNU findutils extension (BSD find has no such flag) — same "skip, don't
 *  fail" lane guard as hasGnuTar/hasZstd above. Checked FUNCTIONALLY (does
 *  `-newermt` actually work), not by matching a specific version-banner
 *  string: this container's own `find` is `bfs` (a GNU-find-compatible
 *  reimplementation, not GNU findutils itself) which supports `-newermt`
 *  correctly — a banner-string check would skip real, working local
 *  coverage for no reason. CI's own container base image (this repo's own
 *  Linux lane) ships real GNU coreutils either way. */
function hasGnuFind(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "fleet-find-probe-"));
  try {
    const r = spawnSync("find", [dir, "-newermt", "-30 seconds", "-print", "-quit"], { encoding: "utf8" });
    return r.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const findSuite = hasGnuFind() ? describe : describe.skip;

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "fleet-install-cache-sec-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function sh(script: string, opts: { maxBuffer?: number } = {}): { status: number | null; stdout: string; stderr: string } {
  // Node/Bun's spawnSync default maxBuffer (~1MB) silently truncates and
  // kills the child (status null, empty stderr) once stdout exceeds it --
  // callers capturing a large listing (issue #393's own >1MB payload) must
  // raise this explicitly or the failure looks like a shell error instead
  // of a buffer limit.
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 10 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Builds `<base>/payload.tar.zst`: a real `node_modules` (one package, one
 *  file with known content) plus, when `poison` is set, extra top-level
 *  archive members representing exactly what a poisoned cache object could
 *  carry — an overwrite of a real tracked file (`app.ts`) and a planted git
 *  hook (`.git/hooks/pre-commit`), the two board #350 itself measured live
 *  against the old, unfixed code. */
function buildPayload(opts: { poison?: boolean } = {}): string {
  const build = join(base, "build");
  mkdirSync(join(build, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(build, "node_modules", "pkg", "index.js"), "module.exports = 'legit-dep';\n");
  let members = "node_modules";
  if (opts.poison) {
    mkdirSync(join(build, "src"), { recursive: true });
    mkdirSync(join(build, ".git", "hooks"), { recursive: true });
    writeFileSync(join(build, "app.ts"), "console.log('poisoned direct app.ts')\n");
    writeFileSync(join(build, "src", "app.ts"), "console.log('poisoned src/app.ts')\n");
    writeFileSync(join(build, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho planted-malicious-hook\n");
    members = "node_modules src app.ts .git";
  }
  const payload = join(base, "payload.tar.zst");
  const r = sh(`cd ${JSON.stringify(build)} && tar -c ${members} | zstd -q -c > ${JSON.stringify(payload)}`);
  if (r.status !== 0) throw new Error(`failed to build test payload: ${r.stderr}`);
  return payload;
}

/** A checkout directory seeded with the two files a poisoned archive tries
 *  to clobber, so a test can assert they are UNCHANGED afterward — the same
 *  live-checkout shape board #350's own round 2 review measured against
 *  (real `src/app.ts`, a real `.git/hooks/pre-commit`). */
function seedCheckout(): string {
  const dir = join(base, "checkout");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  writeFileSync(join(dir, "app.ts"), "original top-level app.ts\n");
  writeFileSync(join(dir, "src", "app.ts"), "original src/app.ts\n");
  writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "original pre-commit hook\n");
  return dir;
}

function runRestore(repoDir: string, urlEnv: string): ReturnType<typeof runSnippet> {
  return runSnippet({
    script: installCacheRestoreCmd(repoDir),
    shell: "bash",
    sourced: true, // sbExec's own shared-shell model — see exec-snippet.ts's doc comment
    env: { [INSTALL_CACHE_URL_ENV]: urlEnv },
    timeout: 20_000,
  });
}

/** The command this feature shipped with BEFORE round 2's item 2/4 fixes —
 *  a bare `curl | zstd -d | tar -x -C <dir>` pipe, kept here ONLY as the
 *  mutant baseline these tests prove the real, current command improves on.
 *  Never imported from src/ — it no longer exists there; this is what
 *  git history (the pre-883267e install-cache.ts) actually shipped. */
function preFixRestoreCmd(repoDir: string): string {
  return `curl --fail --silent --show-error --max-time 600 "$${INSTALL_CACHE_URL_ENV}" | zstd -dc | tar -x -C ${repoDir}`;
}

/** `installCacheRestoreCmd`'s own shape BEFORE round 5 review, item 4's disk-
 *  space preflight — i.e. the real, shipped, round-4 command with the new
 *  `df`-based check spliced back OUT, kept here ONLY as the mutant baseline
 *  the test below proves the real, current command improves on. Never
 *  imported from src/ — reconstructed verbatim from the pre-this-task
 *  install-cache.ts (same "kept only as the mutant baseline" pattern this
 *  file's other preFix* helpers already use). Demonstrates the BEHAVIORAL gap
 *  this fix closes: this reconstruction never reads `df` at all, so a
 *  controlled "disk is full" report has zero effect on it whatsoever — it
 *  runs the SAME zstd/tar stages on the SAME valid archive regardless, which
 *  is exactly the missing capability round 5's own fix adds. */
function preFixInstallCacheRestoreCmdNoLocalCheck(dir: string): string {
  return (
    `(set -o pipefail && ` +
    `work=$(mktemp -d /tmp/.install-cache-restore.XXXXXX) && ` +
    `trap 'rm -rf "$work"' EXIT && ` +
    `{ mkdir -p '${dir}' || { echo restore-failed:precondition; exit 1; }; } && ` +
    `{ curl --fail --silent --show-error --connect-timeout 30 --speed-limit 1024 --speed-time 60 --max-time 600 ` +
    `-o "$work/dl.tar.zst" "$${INSTALL_CACHE_URL_ENV}" || { echo restore-failed:transfer; exit 1; }; } && ` +
    `{ zstd -dc "$work/dl.tar.zst" > "$work/dl.tar" 2>/dev/null || { echo restore-failed:archive; exit 1; }; } && ` +
    `{ tar --absolute-names -tf "$work/dl.tar" > "$work/listing.txt" 2>/dev/null || { echo restore-failed:archive; exit 1; }; } && ` +
    `{ if grep -Eq '^/|(^|/)\\.\\.($|/)' "$work/listing.txt"; then echo restore-failed:archive; exit 1; fi; } && ` +
    `mkdir -p "$work/stage" && ` +
    `{ tar -x -C "$work/stage" -f "$work/dl.tar" node_modules 2>/dev/null || { echo restore-failed:archive; exit 1; }; } && ` +
    `{ [ -d "$work/stage/node_modules" ] || { echo restore-failed:archive; exit 1; }; } && ` +
    `{ rm -rf '${dir}'/node_modules || { echo restore-failed:precondition; exit 1; }; } && ` +
    `{ mv "$work/stage/node_modules" '${dir}'/node_modules || { echo restore-failed:precondition; exit 1; }; } && ` +
    `echo restored)`
  );
}

suite("install-cache restore — item 4 (SECURITY): real GNU tar, real staging dir, real member filter", () => {
  test("happy path: a clean archive restores node_modules end-to-end through a real curl file:// transfer", () => {
    const payload = buildPayload();
    const checkout = seedCheckout();
    const result = runRestore(checkout, `file://${payload}`);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("restored");
    expect(readFileSync(join(checkout, "node_modules", "pkg", "index.js"), "utf8")).toContain("legit-dep");
  });

  test("MUTANT PROOF — a poisoned archive's app.ts overwrite and planted .git hook never reach the checkout; only node_modules lands", () => {
    const payload = buildPayload({ poison: true });
    const checkout = seedCheckout();
    const result = runRestore(checkout, `file://${payload}`);
    // The SECURITY property, checked FIRST and independent of this command's
    // own success/output conventions — this is what must go red if the
    // staging-dir/member-scoping is ever removed, not an incidental
    // stdout-marker mismatch. Everything the poisoned archive tried to
    // plant/overwrite must be UNCHANGED.
    expect(readFileSync(join(checkout, "app.ts"), "utf8")).toBe("original top-level app.ts\n");
    expect(readFileSync(join(checkout, "src", "app.ts"), "utf8")).toBe("original src/app.ts\n");
    expect(readFileSync(join(checkout, ".git", "hooks", "pre-commit"), "utf8")).toBe("original pre-commit hook\n");
    // Secondary: the current command's own success shape (checked AFTER the
    // security property above, deliberately — a future edit to the success
    // marker/exit convention should never be what this proof turns red on).
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("restored");
    expect(readFileSync(join(checkout, "node_modules", "pkg", "index.js"), "utf8")).toContain("legit-dep");
  });

  test("MUTANT BASELINE — the SAME poisoned archive against the pre-fix bare pipe genuinely overwrites app.ts and plants the hook (proves the proof above is discriminating, not vacuous)", () => {
    const payload = buildPayload({ poison: true });
    const checkout = seedCheckout();
    const result = runSnippet({
      script: preFixRestoreCmd(checkout),
      shell: "bash",
      sourced: true,
      env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}` },
      timeout: 20_000,
    });
    expect(result.code).toBe(0); // the old pipe "succeeds" — that IS the bug
    expect(readFileSync(join(checkout, "app.ts"), "utf8")).toContain("poisoned direct app.ts");
    expect(readFileSync(join(checkout, ".git", "hooks", "pre-commit"), "utf8")).toContain("planted-malicious-hook");
  });

  test("a path-traversal member (../../../tmp/...) is rejected before anything is extracted, even for an otherwise-legitimate archive", () => {
    const build = join(base, "build2");
    mkdirSync(join(build, "node_modules"), { recursive: true });
    writeFileSync(join(build, "node_modules", "ok.js"), "fine\n");
    writeFileSync(join(build, "evil.txt"), "evil\n");
    const plantedName = "install-cache-sec-planted.txt";
    rmSync(join(tmpdir(), plantedName), { force: true });
    // Build an archive whose OWN stored member name is a traversal path —
    // real GNU tar refuses to CREATE such a member without -P, so this
    // constructs it via --transform on a RELATIVE input name (a transform
    // pattern anchored on an ABSOLUTE path never matches: tar strips the
    // leading "/" from its own argv name before the transform ever runs,
    // the same stripping this file's restore command defends against on
    // the EXTRACT side) — the same technique hand-verified against this
    // sandbox's real GNU tar before writing this file.
    const rTar = sh(
      `cd ${JSON.stringify(build)} && ` +
      `tar --transform 's#^evil\\.txt#../../../../../../${plantedName}#' ` +
      `-cf ${JSON.stringify(join(base, "trav.tar"))} node_modules evil.txt`,
    );
    expect(rTar.status).toBe(0);
    const payload = join(base, "trav.tar.zst");
    const rZ = sh(`zstd -q -c ${JSON.stringify(join(base, "trav.tar"))} > ${JSON.stringify(payload)}`);
    expect(rZ.status).toBe(0);

    const checkout = seedCheckout();
    const result = runRestore(checkout, `file://${payload}`);
    expect(result.code).not.toBe(0); // refused, not silently "succeeded"
    expect(existsSync(join(tmpdir(), plantedName))).toBe(false);
    rmSync(join(tmpdir(), plantedName), { force: true });
  });
});

suite("install-cache restore — item 2: truncated-download atomicity", () => {
  /** Truncates `payload` to `fraction` of its own size — the real shape of a
   *  dropped connection mid-transfer, not a hand-typed empty file. */
  function truncate(payload: string, fraction: number): string {
    const full = readFileSync(payload);
    const cut = Math.floor(full.length * fraction);
    const truncated = join(base, "truncated.tar.zst");
    writeFileSync(truncated, full.subarray(0, cut));
    return truncated;
  }

  test("MEASURED MUTANT BASELINE — the pre-fix bare pipe against a truncated archive leaves a genuinely PARTIAL node_modules on disk (the board's own '200/400 files' shape, reproduced)", () => {
    const build = join(base, "build3");
    mkdirSync(join(build, "node_modules"), { recursive: true });
    for (let i = 0; i < 200; i++) {
      mkdirSync(join(build, "node_modules", `pkg${i}`), { recursive: true });
      writeFileSync(join(build, "node_modules", `pkg${i}`, "index.js"), randomBytes(2000));
    }
    const full = join(base, "full.tar.zst");
    const rBuild = sh(`cd ${JSON.stringify(build)} && tar -c node_modules | zstd -q -c > ${JSON.stringify(full)}`);
    expect(rBuild.status).toBe(0);
    const truncated = truncate(full, 0.5);
    const checkout = join(base, "checkout-old");
    mkdirSync(checkout, { recursive: true });
    const result = runSnippet({
      script: preFixRestoreCmd(checkout),
      shell: "bash",
      sourced: true,
      env: { [INSTALL_CACHE_URL_ENV]: `file://${truncated}` },
      timeout: 20_000,
    });
    // Deliberately NOT asserting on `result.code` here: measured live, GNU
    // tar reading a truncated stream off a pipe sometimes DOES exit nonzero
    // ("Unexpected EOF in archive") and sometimes exits 0 — whether it
    // notices depends on where the cut happens to land relative to tar's own
    // 512-byte record blocking, which a real dropped connection has no
    // reason to respect. That inconsistency is itself part of the bug this
    // proof is about: the old pipe can EITHER fail loudly OR silently report
    // success, and in BOTH cases already left a genuinely partial
    // `node_modules` behind by the time anything notices — which is exactly
    // what the next tick's presence check (nodeModulesPresentCmd) then finds
    // and treats as "already there", skipping forever on broken deps.
    expect(existsSync(join(checkout, "node_modules"))).toBe(true);
    const partialCount = readdirSync(join(checkout, "node_modules")).length;
    expect(partialCount).toBeGreaterThan(0);
    expect(partialCount).toBeLessThan(200);
  });

  test("the FIXED command against the SAME truncated archive leaves NOTHING — no partial node_modules ever becomes visible", () => {
    const build = join(base, "build4");
    mkdirSync(join(build, "node_modules"), { recursive: true });
    for (let i = 0; i < 200; i++) {
      mkdirSync(join(build, "node_modules", `pkg${i}`), { recursive: true });
      writeFileSync(join(build, "node_modules", `pkg${i}`, "index.js"), randomBytes(2000));
    }
    const full = join(base, "full2.tar.zst");
    const rBuild = sh(`cd ${JSON.stringify(build)} && tar -c node_modules | zstd -q -c > ${JSON.stringify(full)}`);
    expect(rBuild.status).toBe(0);
    const truncated = truncate(full, 0.5);
    const checkout = join(base, "checkout-new");
    mkdirSync(checkout, { recursive: true });
    const result = runRestore(checkout, `file://${truncated}`);
    expect(result.code).not.toBe(0);
    expect(existsSync(join(checkout, "node_modules"))).toBe(false);
  });

  test("a pre-existing GOOD node_modules survives untouched when a later restore attempt hits a truncated/corrupt archive", () => {
    const build = join(base, "build5");
    mkdirSync(join(build, "node_modules"), { recursive: true });
    writeFileSync(join(build, "node_modules", "x.js"), "x".repeat(5000));
    const full = join(base, "full3.tar.zst");
    const rBuild = sh(`cd ${JSON.stringify(build)} && tar -c node_modules | zstd -q -c > ${JSON.stringify(full)}`);
    expect(rBuild.status).toBe(0);
    const truncated = truncate(full, 0.3);
    const checkout = join(base, "checkout-existing");
    mkdirSync(join(checkout, "node_modules", "existing-pkg"), { recursive: true });
    writeFileSync(join(checkout, "node_modules", "existing-pkg", "index.js"), "pre-existing good content\n");
    const result = runRestore(checkout, `file://${truncated}`);
    expect(result.code).not.toBe(0);
    expect(readFileSync(join(checkout, "node_modules", "existing-pkg", "index.js"), "utf8")).toBe(
      "pre-existing good content\n",
    );
  });

  test("a missing/unreachable object (curl itself fails) exits nonzero and touches nothing — mirrors an expired or wrong-signature presigned URL", () => {
    const checkout = join(base, "checkout-missing");
    mkdirSync(checkout, { recursive: true });
    const result = runRestore(checkout, `file://${join(base, "does-not-exist.tar.zst")}`);
    expect(result.code).not.toBe(0);
    expect(existsSync(join(checkout, "node_modules"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Board #350, round 3 review, item 5 — SECURITY (shell command injection).
// Every command builder in install-cache.ts takes a `dir`/`repoDir` that
// traces back to a directory name `discoverCacheDirsCmd`'s own `find`
// discovered on the checkout's filesystem — nominally attacker-controllable
// the moment an untrusted commit introduces an oddly-named directory that
// happens to carry a lockfile. Before the fix, EVERY such interpolation was
// raw (`cd ${dir}`, `${dir}/node_modules`, `tar -C ${dir}`, ...): bash
// expands a `$(...)`/backtick command substitution the instant it PARSES the
// command line, before `cd`/`tar`/`find`/whatever downstream ever runs, so a
// directory shaped like the maestro's own repro (`x$(touch
// /tmp/pwned-inject)y`) executes arbitrary shell regardless of whether the
// rest of the command ever succeeds or fails.
//
// This runs the REAL bash `sbExec` itself uses (`bash -c`), the same
// `runSnippet` harness the suite above uses for the restore pipeline — no
// filesystem/child_process exists under vitest-pool-workers (this file's own
// header), which is why this SECURITY proof lives here and not in
// test/install-cache.test.ts (that file can only assert on command TEXT).
//
// RED-BEFORE-GREEN, independently reproduced rather than merely trusted from
// the maestro's own report: each pair below runs the exact PRE-FIX command
// text (hand-reconstructed from git history — the SAME "kept only as the
// mutant baseline" pattern this file's own `preFixRestoreCmd` above already
// uses for a different bug) against a real bash, proves the injection
// payload's marker file genuinely gets created, THEN proves the FIXED,
// shipped command (the real, current install-cache.ts export, imported
// above) never creates it for the identical payload.
// ---------------------------------------------------------------------------

/** A fresh, unique marker path per assertion — never a shared fixed path,
 *  the same "no two runs collide" reasoning `buildPayload`'s own `mktemp`-
 *  style uniqueness gives the rest of this file. */
function pwnedMarkerPath(): string {
  return join(tmpdir(), `install-cache-sec-pwned-${randomBytes(6).toString("hex")}`);
}

/** The maestro's own repro shape, parameterized on the marker file a
 *  successful injection would create: `x$(touch <marker>)y`. */
function injectionPayload(marker: string): string {
  return `x$(touch ${marker})y`;
}

/** Runs `script` (a full shell command STRING, not a file) through the real
 *  `bash -c` sbExec itself uses, and reports only whether the marker file
 *  the injection payload targets now exists — independent of the command's
 *  own exit code or stdout, since the injected `touch` fires the instant
 *  bash PARSES the vulnerable argument, whether or not whatever comes after
 *  it (a `cd` into a directory that doesn't exist, a `find`/`tar` that then
 *  fails) ever succeeds. */
function injectionFired(script: string, marker: string, env: Record<string, string> = {}): boolean {
  rmSync(marker, { force: true });
  runSnippet({ script, shell: "bash", sourced: true, env, timeout: 10_000 });
  const fired = existsSync(marker);
  rmSync(marker, { force: true });
  return fired;
}

/** Scans the test process's own CWD (apps/fleet/) for the empty
 *  `x$(touch …)y` dir trees a BARE relative injection payload leaves
 *  behind when the shipped restore command's own mkdir line
 *  materializes the literal payload name — the cwd litter finding #598
 *  is about, which `git status` cannot see (empty dirs). */
function cwdLitter(): string[] {
  return readdirSync(".").filter((n) => n.startsWith("x$("));
}

// Pre-fix command text, reconstructed verbatim from git history (the exact
// shapes install-cache.ts shipped before round 3's shQuote fix) — never
// imported from src/, they no longer exist there.
function preFixDiscoverCacheDirsCmd(repoDir: string): string {
  const nameTests = WORKSPACE_LOCK_MARKERS.map((m) => `-name '${m}'`).join(" -o ");
  return (
    `(cd ${repoDir} && find . \\( -name node_modules -o -name .git \\) -prune -o ` +
    `\\( ${nameTests} \\) -print | sed 's#/[^/]*$##' | sort -u)`
  );
}
function preFixLockHashCmd(dir: string): string {
  const files = LOCKFILE_CANDIDATES.join(" ");
  return (
    `(cd ${dir} && present=""; for f in ${files}; do [ -f "$f" ] && present="$present $f"; done; ` +
    `if [ -z "$present" ]; then :; else sha256sum $present | sha256sum | cut -d' ' -f1; fi)`
  );
}
function preFixNodeModulesPresentCmd(dir: string): string {
  return `[ -d ${dir}/node_modules ] && echo yes || echo no`;
}
// installCacheRestoreCmd's own vulnerable line (`rm -rf ${dir}/node_modules`,
// install-cache.ts:557 at review time) and installCacheSaveCmd's own
// (`tar -C ${dir} -c node_modules`, :688) reconstructed as the minimal
// snippet isolating each exact interpolation site — the injection fires the
// instant bash parses `${dir}` at that textual position, regardless of what
// the rest of either multi-stage pipeline goes on to do.
function preFixRestoreRmLine(dir: string): string {
  return `rm -rf ${dir}/node_modules; echo done`;
}
function preFixSaveTarLine(dir: string): string {
  return `tar -C ${dir} -c node_modules > /dev/null 2>&1; echo done`;
}

describe("install-cache — item 5 SECURITY: shell metacharacter injection via dir/repoDir", () => {
  test("MUTANT BASELINE — discoverCacheDirsCmd's PRE-FIX text genuinely executes an injected payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(preFixDiscoverCacheDirsCmd(injectionPayload(marker)), marker)).toBe(true);
  });
  test("MUTANT PROOF — the FIXED, shipped discoverCacheDirsCmd blocks the identical payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(discoverCacheDirsCmd(injectionPayload(marker)), marker)).toBe(false);
  });

  test("MUTANT BASELINE — lockHashCmd's PRE-FIX text genuinely executes an injected payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(preFixLockHashCmd(injectionPayload(marker)), marker)).toBe(true);
  });
  test("MUTANT PROOF — the FIXED, shipped lockHashCmd blocks the identical payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(lockHashCmd(injectionPayload(marker)), marker)).toBe(false);
  });

  test("MUTANT BASELINE — nodeModulesPresentCmd's PRE-FIX text genuinely executes an injected payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(preFixNodeModulesPresentCmd(injectionPayload(marker)), marker)).toBe(true);
  });
  test("MUTANT PROOF — the FIXED, shipped nodeModulesPresentCmd blocks the identical payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(nodeModulesPresentCmd(injectionPayload(marker)), marker)).toBe(false);
  });

  test("MUTANT BASELINE — installCacheRestoreCmd's own PRE-FIX 'rm -rf ${dir}/node_modules' line genuinely executes an injected payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(preFixRestoreRmLine(injectionPayload(marker)), marker)).toBe(true);
  });
  test("MUTANT PROOF — the FIXED, shipped installCacheRestoreCmd (full pipeline) blocks the identical payload", () => {
    const marker = pwnedMarkerPath();
    // Absolute, inside the per-test tmpdir (finding #598): the `$( )` must
    // still be shQuote'd or the marker fires, while the command's own
    // mkdir line materializes any literal name under `base`, not the
    // test cwd.
    const evil = join(base, injectionPayload(marker));
    // The full, real, shipped restore command — not just the isolated line —
    // run with no real presigned URL (curl will fail; irrelevant to this
    // proof, which only cares whether the payload's OWN touch ever fired).
    const fired = injectionFired(installCacheRestoreCmd(evil), marker, { [INSTALL_CACHE_URL_ENV]: "file:///does/not/exist" });
    expect(fired).toBe(false);
    // Finding #598: the proof must not pay for itself in cwd litter — the
    // bare payload's literal dir name belongs under `base`, never here.
    expect(cwdLitter()).toEqual([]);
  });

  test("MUTANT BASELINE — installCacheSaveCmd's own PRE-FIX 'tar -C ${dir} -c node_modules' line genuinely executes an injected payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(preFixSaveTarLine(injectionPayload(marker)), marker)).toBe(true);
  });
  test("MUTANT PROOF — the FIXED, shipped installCacheSaveCmd (full pipeline) blocks the identical payload", () => {
    const marker = pwnedMarkerPath();
    // Absolute, inside the per-test tmpdir (finding #598) — same reasoning
    // the save command's own stat line never materializes anything — but
    // the absolute prefix keeps the literal name inside `base` should any
    // future command line ever mkdir it, and the litter assertion below
    // guards exactly that.
    const evil = join(base, injectionPayload(marker));
    // The full, real, shipped save command — `[ ! -d <dir>/node_modules ]`
    // is false for this nonexistent directory, so this legitimately takes
    // the "skip:no-node_modules" branch; the only thing this proof cares
    // about is whether the payload's OWN touch ever fired while bash parsed
    // it, which happens (or, post-fix, does not) regardless of that outcome.
    const fired = injectionFired(installCacheSaveCmd(evil), marker);
    expect(fired).toBe(false);
    // Finding #598, same reasoning as the restore proof above.
    expect(cwdLitter()).toEqual([]);
  });

  test("a directory name with a literal single quote is also handled safely (the escape shQuote itself needs)", () => {
    const marker = pwnedMarkerPath();
    // A quote-embedding payload that would break a naive `'${dir}'` wrap
    // without the `'\''` escape — proves the escaping, not just the common
    // case with no embedded quote.
    const evil = `it's-$(touch ${marker})-evil`;
    expect(injectionFired(nodeModulesPresentCmd(evil), marker)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Round 4 review, item 5(b) — of this file's own 6 shell-command builders
  // (discoverCacheDirsCmd, lockHashCmd, nodeModulesPresentCmd,
  // bunInstallRunningCmd, installCacheRestoreCmd, installCacheSaveCmd),
  // `bunInstallRunningCmd` had NO injection RED/GREEN pair of its own at all
  // — closed below. And for `installCacheRestoreCmd`/`installCacheSaveCmd`,
  // the existing "full pipeline" GREEN proofs above (lines ~438, ~452) use an
  // UNREACHABLE URL / a NONEXISTENT directory specifically so the proof stays
  // simple — which means they short-circuit BEFORE ever reaching the LATER
  // `shQuote(dir)` sites each command also has (installCacheRestoreCmd's own
  // `rm -rf`/`mv` lines; installCacheSaveCmd's own `tar -C` line — the same
  // ones each already has an ISOLATED baseline for, above). Closed below with
  // a real, SUCCESSFUL run reaching those exact lines for a genuinely hostile
  // directory NAME (not just the isolated snippet), never just the shorter
  // early-exit path.
  // ---------------------------------------------------------------------------

  /** `bunInstallRunningCmd`'s own vulnerable `cd ${dir}` line as it shipped
   *  BEFORE round 3's shQuote fix — the isolated-snippet pattern this file's
   *  own `preFixRestoreRmLine`/`preFixSaveTarLine` already use. Never
   *  imported from src/, it no longer exists there. */
  function preFixBunInstallRunningCdLine(dir: string): string {
    return `(cd ${dir} 2>/dev/null || { echo no; exit 0; }; echo checked)`;
  }

  test("MUTANT BASELINE — bunInstallRunningCmd's own PRE-FIX (unquoted) 'cd ${dir}' line genuinely executes an injected payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(preFixBunInstallRunningCdLine(injectionPayload(marker)), marker)).toBe(true);
  });
  test("MUTANT PROOF — the FIXED, shipped bunInstallRunningCmd (full command) blocks the identical payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(bunInstallRunningCmd(injectionPayload(marker)), marker)).toBe(false);
  });

  // Needs a real zstd/GNU tar to BUILD the fixture payload (not merely to
  // detect the injection, which fires purely from bash's own parsing,
  // independent of whether zstd/tar are even installed) — same lane guard as
  // the `suite(...)`-gated restore-pipeline tests above.
  suite("installCacheRestoreCmd — deepened injection proof (needs real zstd/tar to build the fixture)", () => {
    test("DEEPENED MUTANT PROOF — installCacheRestoreCmd's rm-rf/mv lines (unreached by the short-circuited-on-curl-failure proof above) are ALSO safe: a real, SUCCESSFUL restore into a hostile directory NAME never fires the injected payload", () => {
      const marker = pwnedMarkerPath();
      rmSync(marker, { force: true });
      const build = join(base, "build-deep-restore");
      mkdirSync(join(build, "node_modules"), { recursive: true });
      writeFileSync(join(build, "node_modules", "ok.js"), "fine\n");
      const payload = join(base, "deep-restore.tar.zst");
      const r = sh(`cd ${JSON.stringify(build)} && tar -c node_modules | zstd -q -c > ${JSON.stringify(payload)}`);
      expect(r.status).toBe(0);

      const evilDir = join(base, `evil-checkout-${injectionPayload(marker)}`);
      mkdirSync(evilDir, { recursive: true });
      const result = runSnippet({
        script: installCacheRestoreCmd(evilDir),
        shell: "bash", sourced: true,
        env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}` },
        timeout: 20_000,
      });
      // The injection never fired at ANY of mkdir/rm/mv's own shQuote sites —
      // checked independently of the restore's own success below.
      expect(existsSync(marker)).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("restored");
      expect(readFileSync(join(evilDir, "node_modules", "ok.js"), "utf8")).toBe("fine\n");
      rmSync(marker, { force: true });
    });
  });

  test("DEEPENED MUTANT PROOF — installCacheSaveCmd's tar line (unreached by the no-node_modules short-circuit proof above) is ALSO safe: a real save attempt against a hostile directory NAME (with real node_modules to tar) never fires the injected payload", () => {
    const marker = pwnedMarkerPath();
    rmSync(marker, { force: true });
    const evilDir = join(base, `evil-save-${injectionPayload(marker)}`);
    mkdirSync(join(evilDir, "node_modules"), { recursive: true });
    writeFileSync(join(evilDir, "node_modules", "x.js"), "x\n");
    // No INSTALL_CACHE_URL_ENV set — the upload leg is expected to fail
    // (curl against an empty/unset URL), which is irrelevant to this proof:
    // it only cares whether the payload's OWN touch ever fired while bash
    // parsed the `tar -C ${dir}` line, which the "else" branch (real
    // node_modules present) genuinely reaches, unlike the short-circuit
    // proof above.
    runSnippet({ script: installCacheSaveCmd(evilDir), shell: "bash", sourced: true, timeout: 20_000 });
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
  });
});

// ---------------------------------------------------------------------------
// Board #350, round 5 review, item 1 — install-running detection, real shell
// behavior. test/install-cache.test.ts (vitest-pool-workers) can only assert
// on the command TEXT; this proves the completion-marker signal genuinely
// answers yes/no correctly against a REAL filesystem, the same "no
// filesystem in workerd" split this file's own header describes for the
// restore pipeline above.
//
// History: round 3 review, item 2 replaced argv/`/proc`-cwd matching with a
// package-manager-agnostic mtime signal. Round 4 review, item 2 replaced HALF
// of that (the permanently-stuck "lockfile newer than node_modules" check)
// with a LIVE-PROCESS scan. Round 5 review, item 1 — the maestro's own
// finding — judges that live-process scan itself OVER-BROAD: it matches ANY
// live bun/node/npm/npx/yarn/pnpm process with a matching cwd/argv, not just
// a genuine in-progress install, so a repo whose studio also runs a
// long-lived dev server or an MCP server (real on fleetflare--web-studio,
// started via `bun x` from the repo root) never saves its install cache at
// all. Fixed by dropping the live-process scan ENTIRELY in favor of a
// COMPLETION MARKER (`node_modules/.fleet-install-complete`) a NEW
// PostToolUse hook writes — see install-cache.ts's own bunInstallRunningCmd
// doc comment and gates/install-marker.sh's own header for the full design;
// test/bun/install-marker-gate.test.ts exercises that hook script itself.
//
// The maestro named an EXACT test that must FLIP here: a long-lived `bun -e`
// process sitting in the directory used to prove the round-4 live-process
// scan correctly caught a genuine install. Under the marker-based design,
// that exact same live process must NO LONGER block a save once the
// directory's own completion marker is present and fresh — it is no longer a
// signal this function reads AT ALL. See the MUTANT BASELINE/PROOF pair
// below for the flip itself.
// ---------------------------------------------------------------------------

/** `bunInstallRunningCmd`'s shape as it shipped through round 4 review (this
 *  branch's own base commit, acafbcc) — the live-`/proc`-scan half round 5
 *  review, item 1 removes entirely. Reconstructed verbatim — never imported
 *  from src/, it no longer exists there. Kept only as the mutant baseline the
 *  test below proves the real, current command fixes. */
function preFixBunInstallRunningCmdRound4(dir: string): string {
  const commCases = ["bun", "node", "npm", "npx", "yarn", "pnpm"].join("|");
  return (
    `(cd '${dir}' 2>/dev/null || { echo no; exit 0; }; ` +
    `recent=no; ` +
    `if [ -d node_modules ] && [ -n "$(find node_modules -newermt '-${INSTALL_ACTIVITY_WINDOW_SECONDS} seconds' -print -quit 2>/dev/null)" ]; then recent=yes; fi; ` +
    `live=no; target='${dir}'; ` +
    `for p in /proc/[0-9]*; do ` +
    `comm=$(cat "$p/comm" 2>/dev/null) || continue; ` +
    `case "$comm" in ${commCases}) ;; *) continue ;; esac; ` +
    `cwd=$(readlink "$p/cwd" 2>/dev/null); ` +
    `if [ "$cwd" = "$target" ]; then live=yes; break; fi; ` +
    `if tr '\\0' '\\n' < "$p/cmdline" 2>/dev/null | grep -qxF -- "$target"; then live=yes; break; fi; ` +
    `done; ` +
    `if [ "$recent" = yes ] || [ "$live" = yes ]; then echo yes; else echo no; fi)`
  );
}

/** `/proc` is a Linux-only pseudo-filesystem (this container's own base
 *  image, but not necessarily a developer's own machine) — needed only by the
 *  MUTANT BASELINE reconstruction above, which itself scans `/proc`; the
 *  shipped command under test no longer touches `/proc` at all. Same "skip,
 *  don't fail" lane guard as hasGnuTar/hasZstd/hasGnuFind above. */
function hasProcFs(): boolean {
  return existsSync("/proc/self/comm");
}
const procSuite = hasProcFs() ? describe : describe.skip;

findSuite("bunInstallRunningCmd — real filesystem behavior (round 5 review, item 1: completion marker, no process scan)", () => {
  function runIsRunning(dir: string): boolean {
    const r = runSnippet({ script: bunInstallRunningCmd(dir), shell: "bash", sourced: true, timeout: 10_000 });
    return parseBunInstallRunning(r.stdout);
  }
  /** Sets an mtime `secondsAgo` seconds in the past — GNU touch's own
   *  relative `-d` parsing, same convention this suite's own header notes
   *  this file already assumes GNU coreutils throughout install-cache.ts. */
  function touchSecondsAgo(path: string, secondsAgo: number): void {
    const r = spawnSync("touch", ["-d", `-${secondsAgo} seconds`, path]);
    if (r.status !== 0) throw new Error(`touch -d failed: ${r.stderr?.toString()}`);
  }
  /** Writes the completion marker `secondsAgo` seconds in the past — the
   *  exact shape gates/install-marker.sh itself produces (a plain touched
   *  file under node_modules), reconstructed here independent of that hook's
   *  own runtime (test/bun/install-marker-gate.test.ts exercises the hook
   *  script itself). */
  function writeMarker(nodeModulesDir: string, secondsAgo: number): void {
    const marker = join(nodeModulesDir, ".fleet-install-complete");
    writeFileSync(marker, "");
    touchSecondsAgo(marker, secondsAgo);
  }

  test("no node_modules, no marker, nothing ever completed: RUNNING — never-completed reads the same as still-running", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-install-running-"));
    expect(runIsRunning(dir)).toBe(true);
  });

  test("node_modules exists with a file just written (within the activity window), no marker yet: RUNNING — the extraction-phase signal, UNCHANGED by round 5 review, item 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-install-running-"));
    writeFileSync(join(dir, "bun.lock"), "{}\n");
    mkdirSync(join(dir, "node_modules"));
    touchSecondsAgo(join(dir, "node_modules"), 3600); // old, so only the FILE below is "recent"
    writeFileSync(join(dir, "node_modules", "just-written.js"), "// mid-extraction\n");
    expect(runIsRunning(dir)).toBe(true);
  });

  test("marker present and FRESH (newer than the lockfile), no recent write activity: NOT running — the core settled case", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-install-running-"));
    writeFileSync(join(dir, "bun.lock"), "{}\n");
    touchSecondsAgo(join(dir, "bun.lock"), 3600);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.js"), "module.exports = 1;\n");
    touchSecondsAgo(join(dir, "node_modules"), 120);
    touchSecondsAgo(join(dir, "node_modules", "pkg.js"), 120);
    writeMarker(join(dir, "node_modules"), 60); // written after the lockfile, before "now"
    // Creating the marker file bumps node_modules' OWN mtime back to "now"
    // (adding a directory entry updates the parent directory's mtime) — resat
    // old again here so the recent-write-activity signal (component (a),
    // unrelated to this test) reflects "well past the window", not "a file
    // was just created a moment ago", which would otherwise be a genuinely
    // correct "recent" reading for the first ~30s after ANY marker write
    // (including a real one) rather than the failure mode this test targets.
    touchSecondsAgo(join(dir, "node_modules"), 120);
    expect(runIsRunning(dir)).toBe(false);
  });

  test("marker present but STALE (a lockfile is newer than it — a NEW install that has not completed/marked yet): RUNNING", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-install-running-"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.js"), "module.exports = 1;\n");
    touchSecondsAgo(join(dir, "node_modules"), 3600);
    touchSecondsAgo(join(dir, "node_modules", "pkg.js"), 3600);
    writeMarker(join(dir, "node_modules"), 3000); // an OLD install's own marker
    // Re-settle node_modules' own mtime after the marker write bumped it back
    // to "now" — see the identical note on the "marker present and FRESH"
    // test above. Isolates the STALE-marker branch this test targets from the
    // (unrelated, always-true-for-~30s-after-any-write) recent-activity
    // signal.
    touchSecondsAgo(join(dir, "node_modules"), 3600);
    writeFileSync(join(dir, "bun.lock"), "{}\n"); // a brand-new lockfile change, newer than the marker
    expect(runIsRunning(dir)).toBe(true);
  });

  test("marker absent entirely, otherwise settled-looking node_modules: RUNNING — absence reads as never-completed, never as settled", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-install-running-"));
    writeFileSync(join(dir, "bun.lock"), "{}\n");
    touchSecondsAgo(join(dir, "bun.lock"), 3600);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.js"), "module.exports = 1;\n");
    touchSecondsAgo(join(dir, "node_modules"), 120);
    touchSecondsAgo(join(dir, "node_modules", "pkg.js"), 120);
    expect(runIsRunning(dir)).toBe(true);
  });
});

procSuite("bunInstallRunningCmd — round 5 review, item 1 MUTANT PROOF: a long-lived, unrelated process no longer blocks a settled install", () => {
  function touchSecondsAgo(path: string, secondsAgo: number): void {
    const r = spawnSync("touch", ["-d", `-${secondsAgo} seconds`, path]);
    if (r.status !== 0) throw new Error(`touch -d failed: ${r.stderr?.toString()}`);
  }
  function seedSettledInstall(): string {
    const dir = mkdtempSync(join(tmpdir(), "fleet-install-running-"));
    writeFileSync(join(dir, "bun.lock"), "{}\n");
    touchSecondsAgo(join(dir, "bun.lock"), 3600);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.js"), "module.exports = 1;\n");
    touchSecondsAgo(join(dir, "node_modules"), 120);
    touchSecondsAgo(join(dir, "node_modules", "pkg.js"), 120);
    return dir;
  }

  // My own finding: both tests below spawn a real child process and run
  // it through a real bash snippet. Originally the child had a FIXED
  // lifetime (first 8s, then bumped to 35s) racing against the MUTANT
  // BASELINE's own `/proc` scan below — a race against an unpredictable,
  // load-dependent scan duration is the wrong shape: under this container's
  // own accumulating zombie count (PID 1 here is `sandbox`, not a reaping
  // init, so `/proc` only grows over a long session), a plain shell
  // `for p in /proc/[0-9]*; do cat "$p/cmdline"; done` loop was measured at
  // ~20s in one run and then took LONGER than a 35s child/40s timeout margin
  // in a later, more-loaded run of the very same container — bumping the
  // numbers again would just be guessing at a moving target.
  //
  // Fixed by removing the race entirely: the child below never resolves on
  // its own (`await new Promise(() => {})`) and lives for exactly as long as
  // this test's own `finally { child.kill("SIGKILL") }` lets it — i.e. it is
  // now GUARANTEED to still be alive no matter how slow the scan runs. That
  // removes the "which side timed out" ambiguity entirely: the child can
  // NEVER be the thing that expires mid-scan, so a failure can only mean the
  // scan itself didn't finish. What's left is sizing that one remaining
  // ceiling against real CPU-contended `/proc`-scan time under FULL-SUITE
  // concurrency (120 test files each forking their own subprocesses), not
  // against a single-process baseline (~20s) or a single prior failure
  // observed at ~40s — both of those are moving targets, not the thing we
  // actually need to bound. `runSnippet`'s own timeout and this test's own
  // bun:test per-test timeout are both set to a generous ABSOLUTE ceiling
  // (180s / 185s) against that contended-scan time. This affects ONLY the
  // historical reconstruction of the abandoned round-4 command; the sibling
  // "MUTANT PROOF" test right after it (proving the ACTUAL shipped, current
  // command never scans `/proc` at all) already used a short-lived child and
  // is unaffected.
  test("MUTANT BASELINE — the round-4 shipped command genuinely OVER-BLOCKS: a settled install with an UNRELATED long-lived bun process sitting in the directory (a dev server / MCP server stand-in) still reads as RUNNING", () => {
    const dir = seedSettledInstall();
    // An UNRELATED long-lived bun process sitting in this same directory —
    // the maestro's own named repro shape (a dev server, an MCP server
    // started via `bun x` from the repo root), never an install of any kind.
    // Never resolves on its own — lifetime is controlled entirely by this
    // test's own `finally` block below, so it cannot expire mid-scan no
    // matter how slow a loaded container's `/proc` walk gets.
    const child = spawn("bun", ["-e", "await new Promise(() => {})"], { cwd: dir, stdio: "ignore" });
    try {
      const r = runSnippet({ script: preFixBunInstallRunningCmdRound4(dir), shell: "bash", sourced: true, timeout: 180_000 });
      expect(parseBunInstallRunning(r.stdout)).toBe(true); // the bug: over-blocks on ANY matching process
    } finally {
      child.kill("SIGKILL");
    }
  }, 185_000);

  test("MUTANT PROOF — the FIXED, shipped command correctly saves through the SAME long-lived, unrelated process once the completion marker is present and fresh", () => {
    const dir = seedSettledInstall();
    writeFileSync(join(dir, "node_modules", ".fleet-install-complete"), "");
    touchSecondsAgo(join(dir, "node_modules", ".fleet-install-complete"), 60);
    // Re-settle node_modules' own mtime — see the identical note in the
    // "marker present and FRESH" test above (creating the marker file just
    // now bumped the parent directory's own mtime back to "now").
    touchSecondsAgo(join(dir, "node_modules"), 120);
    // The IDENTICAL long-lived, unrelated bun process as the baseline above —
    // still alive, still sitting in this same directory.
    const child = spawn("bun", ["-e", "await new Promise((r) => setTimeout(r, 8000))"], { cwd: dir, stdio: "ignore" });
    try {
      const r = runSnippet({ script: bunInstallRunningCmd(dir), shell: "bash", sourced: true, timeout: 10_000 });
      expect(parseBunInstallRunning(r.stdout)).toBe(false); // saves proceed — the flip the maestro asked for
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Board #350, round 4 review, item 3 — SECURITY (path traversal). The
// maestro's own reported exploit: a directory literally named `x\n..`
// (a real, legal Linux filename — only `/` and NUL are forbidden) makes
// `discoverCacheDirsCmd`'s real `find` output, once split on "\n", yield a
// SPURIOUS extra "directory" reading exactly `..` — which, before this fix,
// `parseCacheDirs` trusted verbatim. `absoluteCacheDir(repoDir, "..")`
// resolves to `repoDir`'s own PARENT, so both the save path (tars/uploads
// from outside the checkout) and the restore path (extracts INTO outside the
// checkout) would operate on `/workspace/outside` for a repo checked out at
// `/workspace/<repo>` — a real, exploitable escape, not a theoretical one.
// This runs the REAL `find`-based `discoverCacheDirsCmd` against a REAL
// directory with this exact hostile name on disk — no filesystem/
// child_process exists under vitest-pool-workers, the same "no filesystem in
// workerd" split this file's own header states for the restore pipeline.
// ---------------------------------------------------------------------------

/** `parseCacheDirs`'s shape as it shipped BEFORE round 4 review, item 3 —
 *  trusts every non-blank, trimmed, normalized line verbatim, with no
 *  rejection of a `..` segment/absolute path at all. Reconstructed verbatim
 *  (the same "kept only as the mutant baseline" pattern this file's own
 *  `preFixDiscoverCacheDirsCmd` etc. already use) — never imported from
 *  src/, it no longer exists there. `normalizeCacheDir` itself is unchanged
 *  by this fix (it was never the security boundary — `parseCacheDirs` is),
 *  so this baseline still calls the REAL, current `normalizeCacheDir`
 *  indirectly via the same trim/strip logic inlined here to stay
 *  self-contained. */
function preFixParseCacheDirs(stdout: string): string[] {
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const norm = trimmed === "." ? "" : trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
    seen.add(norm);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

describe("install-cache — round 4 review, item 3 SECURITY: path traversal via a directory name with an embedded newline", () => {
  /** Builds a real checkout with a directory whose ACTUAL on-disk name
   *  contains a literal newline byte followed by `..` (the maestro's own
   *  repro shape), carrying a real lockfile marker so `discoverCacheDirsCmd`
   *  genuinely discovers it as a cache-worthy directory. Returns the
   *  checkout root and the REAL stdout `discoverCacheDirsCmd` produces
   *  against it. */
  function buildHostileDiscoveryStdout(): { checkout: string; stdout: string } {
    const checkout = mkdtempSync(join(tmpdir(), "fleet-traversal-checkout-"));
    const hostileName = "x\n..";
    const hostileDir = join(checkout, hostileName);
    mkdirSync(hostileDir, { recursive: true });
    writeFileSync(join(hostileDir, "bun.lock"), "{}\n");
    const result = runSnippet({ script: discoverCacheDirsCmd(checkout), shell: "bash", sourced: true, timeout: 10_000 });
    expect(result.code).toBe(0);
    return { checkout, stdout: result.stdout };
  }

  test("MUTANT BASELINE — the real find-based discovery stdout, run through the PRE-FIX parser, genuinely yields '..' as a discovered directory", () => {
    const { checkout, stdout } = buildHostileDiscoveryStdout();
    const dirs = preFixParseCacheDirs(stdout);
    expect(dirs).toContain("..");
    rmSync(checkout, { recursive: true, force: true });
  });

  test("MUTANT PROOF — the FIXED, shipped parseCacheDirs rejects '..' for the IDENTICAL real discovery stdout", () => {
    const { checkout, stdout } = buildHostileDiscoveryStdout();
    const dirs = parseCacheDirs(stdout);
    expect(dirs).not.toContain("..");
    // Nothing in the real, fixed output resolves outside the checkout: every
    // survivor, once passed through absoluteCacheDir, must still start with
    // the checkout root itself.
    for (const relDir of dirs) {
      const abs = absoluteCacheDir(checkout, relDir);
      expect(abs === checkout || abs.startsWith(checkout + "/")).toBe(true);
    }
    rmSync(checkout, { recursive: true, force: true });
  });

  test("documents the actual escape the rejection above closes: absoluteCacheDir(checkoutRoot, '..') really does resolve to the parent directory", () => {
    const checkout = mkdtempSync(join(tmpdir(), "fleet-traversal-checkout-"));
    const escaped = absoluteCacheDir(checkout, "..");
    expect(escaped).toBe(`${checkout}/..`);
    // The resolved, canonical form (what a real `cd`/`tar -C` would actually
    // land on) is genuinely the PARENT directory, one level up from the
    // checkout — this is the real escape, not just a cosmetic ".." suffix.
    expect(join(escaped)).toBe(join(checkout, ".."));
    expect(join(escaped)).not.toBe(checkout);
    rmSync(checkout, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Board #350, round 4 review, item 3 — SECURITY, second layer: a REAL
// filesystem symlink planted inside the checkout, pointing outside it. Pure
// string-checking on the relative path (parseCacheDirs's own rejection,
// above) cannot see this at all: the discovered relative path
// (`site-a`) contains no ".." segment and is not absolute — it looks exactly
// like an ordinary, safe directory. Only asking the REAL filesystem
// (`realpath`, resolving symlinks) can tell it actually points elsewhere —
// guardDirWithinRepo's own doc comment (install-cache.ts).
// ---------------------------------------------------------------------------

describe("install-cache — round 4 review, item 3 SECURITY: guardDirWithinRepo catches a symlink escape pure string-checking cannot", () => {
  test("a directory that IS a symlink pointing outside the checkout is refused, even though its relative path contains no '..' at all", () => {
    const base = mkdtempSync(join(tmpdir(), "fleet-symlink-escape-"));
    const repoDir = join(base, "checkout");
    const outside = join(base, "outside");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel.txt"), "should never be touched\n");
    const relDir = "site-a"; // no ".." segment, not absolute — passes parseCacheDirs cleanly
    symlinkSync(outside, join(repoDir, relDir));
    const absDir = absoluteCacheDir(repoDir, relDir);

    // Documents the residual gap: pure string checking on `relDir` alone
    // sees nothing wrong here at all.
    expect(relDir.includes("..")).toBe(false);
    expect(relDir.startsWith("/")).toBe(false);

    const guarded = guardDirWithinRepo(repoDir, absDir, "echo probe-ran");
    const result = runSnippet({ script: guarded, shell: "bash", sourced: true, timeout: 10_000 });
    expect(result.stdout.trim()).toBe("unsafe-path");
    expect(result.stdout).not.toContain("probe-ran"); // the wrapped command never ran

    rmSync(base, { recursive: true, force: true });
  });

  test("an ORDINARY (non-symlink) directory inside the checkout passes the guard and the wrapped command actually runs", () => {
    const base = mkdtempSync(join(tmpdir(), "fleet-symlink-escape-ok-"));
    const repoDir = join(base, "checkout");
    mkdirSync(join(repoDir, "site-a"), { recursive: true });
    const absDir = absoluteCacheDir(repoDir, "site-a");

    const guarded = guardDirWithinRepo(repoDir, absDir, "echo probe-ran");
    const result = runSnippet({ script: guarded, shell: "bash", sourced: true, timeout: 10_000 });
    expect(result.stdout.trim()).toBe("probe-ran");

    rmSync(base, { recursive: true, force: true });
  });

  test("the checkout root itself (relDir '') always passes — real_dir and real_repo resolve identically", () => {
    const base = mkdtempSync(join(tmpdir(), "fleet-symlink-escape-root-"));
    const repoDir = join(base, "checkout");
    mkdirSync(repoDir, { recursive: true });
    const guarded = guardDirWithinRepo(repoDir, repoDir, "echo probe-ran");
    const result = runSnippet({ script: guarded, shell: "bash", sourced: true, timeout: 10_000 });
    expect(result.stdout.trim()).toBe("probe-ran");
    rmSync(base, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Board #350, round 4 review, item 1 — TOMBSTONE. A restore failure caused by
// the ARCHIVE ITSELF being corrupt (not a transient transfer blip) must
// delete the bad R2 object, so the next save tick's r2Head check correctly
// sees it as gone and re-uploads — see parseRestoreFailureReason's own doc
// comment (install-cache.ts) for why `r2Head` alone can never detect this
// (it only ever checks EXISTENCE). This runs the REAL, shipped
// `runInstallCacheRestore` orchestration end-to-end against a REAL corrupt
// archive (valid zstd wrapping garbage — not a valid tar at all) through the
// REAL bash `installCacheRestoreCmd` produces, with only the R2/presign
// PORTS faked (there is no real R2 in a test) — the same "real shell, faked
// Worker-side ports" split this suite's other orchestration-level proofs
// use. Existing coverage (test/install-cache.test.ts, round 3's own "g2"
// mutant proof) already models a BAD object as GONE (r2Head says false); this
// is the maestro's own explicitly-requested complement: a bad object that is
// genuinely PRESENT.
// ---------------------------------------------------------------------------

suite("runInstallCacheRestore — round 4 review, item 1: real corrupt-archive tombstone (needs real zstd/tar)", () => {
  function realSbExec(cmd: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    const r = runSnippet({ script: cmd, shell: "bash", sourced: true, env, timeout: 20_000 });
    return Promise.resolve({ code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr });
  }

  /** A real checkout with exactly one lockfile-bearing root directory (no
   *  pre-existing node_modules), so discovery finds exactly one directory and
   *  the restore attempt genuinely runs. */
  function realCheckout(): string {
    const dir = mkdtempSync(join(tmpdir(), "fleet-tombstone-checkout-"));
    writeFileSync(join(dir, "bun.lock"), "{}\n");
    return dir;
  }

  test("MUTANT PROOF — a genuinely corrupt-but-PRESENT object (valid zstd wrapping garbage, not a valid tar) triggers a real r2Delete call with the exact presigned key", async () => {
    const corrupt = join(base, "corrupt.tar.zst");
    const rZ = sh(`printf 'not a tar archive, just garbage bytes\\n' | zstd -q -c > ${JSON.stringify(corrupt)}`);
    expect(rZ.status).toBe(0);
    // Confirm the fixture is genuinely what it claims to be: a valid zstd
    // frame (decompresses cleanly) wrapping content that is NOT a valid tar
    // archive (tar -tf on it fails) — the exact "archive corrupt, not a
    // transfer problem" shape parseRestoreFailureReason categorizes.
    const decompress = sh(`zstd -dc ${JSON.stringify(corrupt)} | tar -tf - 2>&1; echo "exit:$?"`);
    expect(decompress.stdout).toContain("exit:");
    expect(decompress.stdout).not.toContain("exit:0");

    const checkout = realCheckout();
    const deletedKeysCalls: string[][] = [];
    let presignedKey: string | null = null;
    const deps: InstallCacheRestoreDeps = {
      sbExec: realSbExec,
      installCacheEnabled: () => true,
      installCachePresignGet: async (key: string) => { presignedKey = key; return `file://${corrupt}`; },
      r2Delete: async (keys: string[]) => { deletedKeysCalls.push(keys); },
    };

    const result = await runInstallCacheRestore(deps, "id", "owner/repo", checkout);
    if (presignedKey === null) throw new Error("presignedKey was never captured");
    expect(result.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:restore-failed-tombstoned" });
    expect(deletedKeysCalls).toEqual([[presignedKey]]);

    rmSync(checkout, { recursive: true, force: true });
  });

  test("NEGATIVE CONTRAST — a MISSING object (curl itself fails, the ordinary 'nobody has cached this yet' case) is never tombstoned: r2Delete is never called", async () => {
    const checkout = realCheckout();
    const deletedKeysCalls: string[][] = [];
    const deps: InstallCacheRestoreDeps = {
      sbExec: realSbExec,
      installCacheEnabled: () => true,
      installCachePresignGet: async () => `file://${join(base, "does-not-exist.tar.zst")}`,
      r2Delete: async (keys: string[]) => { deletedKeysCalls.push(keys); },
    };

    const result = await runInstallCacheRestore(deps, "id", "owner/repo", checkout);
    expect(result.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:restore-failed" });
    expect(deletedKeysCalls).toEqual([]);

    rmSync(checkout, { recursive: true, force: true });
  });

  test("without r2Delete wired at all, a corrupt-present object degrades to the ordinary (non-tombstoned) failure outcome — never crashes", async () => {
    const corrupt = join(base, "corrupt2.tar.zst");
    const rZ = sh(`printf 'also not a tar\\n' | zstd -q -c > ${JSON.stringify(corrupt)}`);
    expect(rZ.status).toBe(0);
    const checkout = realCheckout();
    const deps: InstallCacheRestoreDeps = {
      sbExec: realSbExec,
      installCacheEnabled: () => true,
      installCachePresignGet: async () => `file://${corrupt}`,
      // r2Delete deliberately absent.
    };

    const result = await runInstallCacheRestore(deps, "id", "owner/repo", checkout);
    expect(result.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:restore-failed" });

    rmSync(checkout, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Board #350, round 5 review, item 4 — a LOCAL out-of-disk-space failure on
// this studio's own container must never be mistaken for the REMOTE archive
// being corrupt: install-cache.ts's own restoreOneDir TOMBSTONES (deletes)
// any failure categorized "archive", and before this fix, an ENOSPC on
// EITHER of $work's own local writes (zstd -dc's decompressed output, tar
// -x's extracted stage copy) fell through to that exact same
// restore-failed:archive marker — deleting a perfectly good object shared by
// every OTHER studio of this repo, for a failure that had nothing to do with
// its content. installCacheRestoreCmd now checks available disk space on
// $work's own filesystem BEFORE those writes, emitting a NEW, distinct
// restore-failed:local marker instead.
//
// REAL bash-exec, same "no filesystem in workerd" split this whole file's
// header states: this runs the REAL, shipped installCacheRestoreCmd string
// against a REAL, VALID archive (buildPayload() — genuinely restorable, so
// any failure below is provably the disk check firing, never a coincidentally
// broken fixture) through the REAL curl/zstd/tar this container ships. The
// "disk is full" CONDITION itself is injected the same way this suite
// already fakes environment-dependent conditions it cannot reliably
// reproduce by actually filling a real disk (no root, no loop devices, no
// quota support available here): a tiny fake `df` executable placed first on
// PATH, so the REAL command's own `df -Pk "$work" | ...` pipeline runs
// UNMODIFIED and genuinely parses this fake df's output — not a
// re-implementation of the check, the shipped shell fragment fed a
// controlled df result, the same way this suite's own curl file:// URLs feed
// it a controlled "network" transfer.
// ---------------------------------------------------------------------------

suite("install-cache restore — round 5 review, item 4 SECURITY: local disk-space failure vs archive corruption", () => {
  /** A fake `df` on PATH ahead of the real one, reporting a fixed
   *  "Available" column (POSIX -P format: header line + one data line,
   *  whitespace-separated, 4th field = available 1024-byte blocks) regardless
   *  of what path it is asked about — this is ALL installCacheRestoreCmd's
   *  own disk check ever reads (see that function's own doc comment). */
  function fakeDfDir(availKb: number): string {
    const dir = mkdtempSync(join(tmpdir(), "fleet-fake-df-"));
    writeFileSync(
      join(dir, "df"),
      `#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "fake 100 100 ${availKb} 100% /fake"\n`,
      { mode: 0o755 },
    );
    return dir;
  }

  test("with plenty of reported free space, a REAL valid archive still restores normally (non-regression — the check never blocks a healthy restore)", () => {
    const payload = buildPayload();
    const checkout = seedCheckout();
    const df = fakeDfDir(10 * 1024 * 1024); // ~10 GiB reported available
    try {
      const result = runSnippet({
        script: installCacheRestoreCmd(checkout),
        shell: "bash",
        sourced: true,
        env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}`, PATH: `${df}:${process.env.PATH}` },
        timeout: 20_000,
      });
      expect(result.stdout.trim()).toBe("restored");
    } finally {
      rmSync(df, { recursive: true, force: true });
    }
  });

  test("MUTANT BASELINE — the PRE-round-5 command (no disk check at all) ignores a reported zero-availability df entirely and restores anyway, proving the check below is a genuinely NEW capability, not a no-op", () => {
    const payload = buildPayload();
    const checkout = seedCheckout();
    const df = fakeDfDir(0);
    try {
      const result = runSnippet({
        script: preFixInstallCacheRestoreCmdNoLocalCheck(checkout),
        shell: "bash",
        sourced: true,
        env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}`, PATH: `${df}:${process.env.PATH}` },
        timeout: 20_000,
      });
      expect(result.stdout.trim()).toBe("restored"); // never even looks at df
    } finally {
      rmSync(df, { recursive: true, force: true });
    }
  });

  test("MUTANT PROOF — with reported free space at zero, the SAME real, valid archive fails with restore-failed:local, never restore-failed:archive, and nothing is extracted", () => {
    const payload = buildPayload();
    const checkout = seedCheckout();
    const df = fakeDfDir(0);
    try {
      const result = runSnippet({
        script: installCacheRestoreCmd(checkout),
        shell: "bash",
        sourced: true,
        env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}`, PATH: `${df}:${process.env.PATH}` },
        timeout: 20_000,
      });
      expect(result.stdout.trim()).toBe("restore-failed:local");
      // Never the archive-corruption marker — this archive is genuinely
      // valid; only the disk-space preflight is what failed here.
      expect(result.stdout).not.toContain("restore-failed:archive");
      expect(result.code).not.toBe(0);
      // Nothing was extracted — the checkout's own node_modules must never
      // appear, exactly like every other "failed before mv" case above.
      expect(existsSync(join(checkout, "node_modules"))).toBe(false);
    } finally {
      rmSync(df, { recursive: true, force: true });
    }
  });

  test("a df that cannot be read (exits nonzero, no usable output) fails OPEN — the preflight never turns a healthy restore into a failure just because it could not measure disk space", () => {
    const payload = buildPayload();
    const checkout = seedCheckout();
    const brokenDf = mkdtempSync(join(tmpdir(), "fleet-broken-df-"));
    // A portable no-op failing command standing in for `df` specifically —
    // prepended ahead of the REAL PATH (never replacing it), so curl/zstd/tar
    // still resolve normally; only `df` itself becomes unreadable, exercising
    // the "ran but produced nothing usable" branch of the check.
    writeFileSync(join(brokenDf, "df"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
    try {
      const result = runSnippet({
        script: installCacheRestoreCmd(checkout),
        shell: "bash",
        sourced: true,
        env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}`, PATH: `${brokenDf}:${process.env.PATH}` },
        timeout: 20_000,
      });
      expect(result.stdout.trim()).toBe("restored");
    } finally {
      rmSync(brokenDf, { recursive: true, force: true });
    }
  });

  test("orchestration level — a local disk-space failure is never tombstoned: r2Delete is never called for it, unlike a genuine archive corruption (contrast with the archive-corruption tombstone test above)", async () => {
    const payload = buildPayload();
    const checkout = mkdtempSync(join(tmpdir(), "fleet-local-fail-checkout-"));
    writeFileSync(join(checkout, "bun.lock"), "{}\n");
    const df = fakeDfDir(0);
    const deletedKeysCalls: string[][] = [];
    try {
      const deps: InstallCacheRestoreDeps = {
        sbExec: (cmd: string, env?: Record<string, string>) => {
          const r = runSnippet({
            script: cmd, shell: "bash", sourced: true,
            env: { ...(env ?? {}), PATH: `${df}:${process.env.PATH}` },
            timeout: 20_000,
          });
          return Promise.resolve({ code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr });
        },
        installCacheEnabled: () => true,
        installCachePresignGet: async () => `file://${payload}`,
        r2Delete: async (keys: string[]) => { deletedKeysCalls.push(keys); },
      };
      const result = await runInstallCacheRestore(deps, "id", "owner/repo", checkout);
      expect(result.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:restore-failed" });
      expect(deletedKeysCalls).toEqual([]);
    } finally {
      rmSync(df, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
