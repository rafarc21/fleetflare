import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import {
  installCacheRestoreCmd, INSTALL_CACHE_URL_ENV, discoverCacheDirsCmd, lockHashCmd,
  nodeModulesPresentCmd, installCacheSaveCmd, LOCKFILE_CANDIDATES, WORKSPACE_LOCK_MARKERS,
  bunInstallRunningCmd, parseBunInstallRunning, INSTALL_ACTIVITY_WINDOW_SECONDS,
  parseCacheDirs, absoluteCacheDir, guardDirWithinRepo,
  runInstallCacheRestore, type InstallCacheRestoreDeps,
  INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER,
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
    const evil = injectionPayload(marker);
    // The full, real, shipped restore command — not just the isolated line —
    // run with no real presigned URL (curl will fail; irrelevant to this
    // proof, which only cares whether the payload's OWN touch ever fired).
    const fired = injectionFired(installCacheRestoreCmd(evil), marker, { [INSTALL_CACHE_URL_ENV]: "file:///does/not/exist" });
    expect(fired).toBe(false);
  });

  test("MUTANT BASELINE — installCacheSaveCmd's own PRE-FIX 'tar -C ${dir} -c node_modules' line genuinely executes an injected payload", () => {
    const marker = pwnedMarkerPath();
    expect(injectionFired(preFixSaveTarLine(injectionPayload(marker)), marker)).toBe(true);
  });
  test("MUTANT PROOF — the FIXED, shipped installCacheSaveCmd (full pipeline) blocks the identical payload", () => {
    const marker = pwnedMarkerPath();
    const evil = injectionPayload(marker);
    // The full, real, shipped save command — `[ ! -d <dir>/node_modules ]`
    // is false for this nonexistent directory, so this legitimately takes
    // the "skip:no-node_modules" branch; the only thing this proof cares
    // about is whether the payload's OWN touch ever fired while bash parsed
    // it, which happens (or, post-fix, does not) regardless of that outcome.
    const fired = injectionFired(installCacheSaveCmd(evil), marker);
    expect(fired).toBe(false);
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

  // My own finding: both tests below spawn a real 8s child process and run
  // it through a real bash snippet (its own internal timeout already 10s) —
  // measured wall-clock ~8.6s on this sandbox, which is UNDER bun:test's own
  // default PER-TEST timeout of 5s, so bun:test itself was killing these as
  // "timed out after 5000ms" before the real assertion ever ran — a flake
  // whose rate tracks machine load, not a real correctness gap in either the
  // mutant or the fix. Fixed with an explicit per-test timeout comfortably
  // above the measured wall-clock time, the same way `runSnippet`'s own
  // internal timeout is already sized generously above its own expected
  // duration.
  //
  // Separate, known limitation observed live in a long-running studio
  // container specifically (not a portable code bug): the MUTANT BASELINE
  // test right below reconstructs round 4's own already-abandoned `/proc`
  // scan, which can be intermittently slow to find the freshly-spawned child
  // in a container that has accumulated a very large number of processes
  // over a long session (many defunct/zombie entries under `/proc`) — the
  // scan is a plain shell `for p in /proc/[0-9]*` loop with no bound on how
  // many entries it walks. Measured directly in one such container: a bare
  // `for p in /proc/[0-9]*; do cat "$p/cmdline"; done` loop over ~13,000+
  // zombie-laden `/proc` entries took ~20s wall-clock. Rather than race that
  // scan against an 8s child (which is exactly what used to flake), the
  // child below is given 35s of lifetime — comfortably above the measured
  // ~20s scan time with real headroom as the container's zombie count keeps
  // growing (monotonic; PID 1 here is `sandbox`, not a reaping init) — and
  // `runSnippet`'s own timeout and this test's own bun:test per-test timeout
  // are both bumped to stay above that in turn. This affects ONLY the
  // historical reconstruction of the abandoned round-4 command; the sibling
  // "MUTANT PROOF" test right after it (proving the ACTUAL shipped, current
  // command never scans `/proc` at all) is unaffected and passes reliably
  // regardless of process count.
  test("MUTANT BASELINE — the round-4 shipped command genuinely OVER-BLOCKS: a settled install with an UNRELATED long-lived bun process sitting in the directory (a dev server / MCP server stand-in) still reads as RUNNING", () => {
    const dir = seedSettledInstall();
    // An UNRELATED long-lived bun process sitting in this same directory —
    // the maestro's own named repro shape (a dev server, an MCP server
    // started via `bun x` from the repo root), never an install of any kind.
    const child = spawn("bun", ["-e", "await new Promise((r) => setTimeout(r, 35000))"], { cwd: dir, stdio: "ignore" });
    try {
      const r = runSnippet({ script: preFixBunInstallRunningCmdRound4(dir), shell: "bash", sourced: true, timeout: 40_000 });
      expect(parseBunInstallRunning(r.stdout)).toBe(true); // the bug: over-blocks on ANY matching process
    } finally {
      child.kill("SIGKILL");
    }
  }, 45_000);

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

// ---------------------------------------------------------------------------
// Board #350, round 6 review, item 3 — the ENOSPC preflight above still
// tombstoned a good remote object on close-to-the-edge disk pressure: round
// 5's own materialize-then-list-then-extract pipeline wrote the WHOLE
// decompressed archive to a real `$work/dl.tar` file, needing that full
// decompressed copy AND the extracted `stage/node_modules` copy to coexist on
// disk at once — the maestro measured a real ~4.2x decompression ratio, so
// the real peak need (~2 * 4.2 = 8.4x the compressed download's own size) was
// just OVER round 5's own 8x preflight multiplier, letting some restores
// through that then genuinely ran out of space mid zstd/tar and got
// mislabeled `restore-failed:archive` (tombstoning a perfectly good object).
//
// Fixed by decompressing the SAME compressed download via a STREAMED pipe
// directly into tar, TWICE — once into `tar -tf -` for the listing/
// traversal-guard pass, once into `tar -x -f -` for the real extraction —
// never materializing a full decompressed `.tar` file on disk at either
// stage. This suite proves BOTH halves of that fix for real:
//   (1) SPACE — the new shipped command genuinely never creates a
//       `$work/dl.tar` file, unlike the pre-round-6 pipeline (reconstructed
///      here as the mutant baseline), proven by shadowing `rm` on PATH so the
//       command's own `trap 'rm -rf "$work"' EXIT` cleanup never fires,
//       leaving `$work` on disk to inspect directly.
//   (2) SECURITY — the traversal guard still fires correctly on the NEW
//       streamed pipeline, rebuilt explicitly here (the item 4 SECURITY suite
//       above already re-validates this implicitly, since it calls the same
//       real, exported `installCacheRestoreCmd` — this test makes the
//       streamed-pipeline claim explicit and inspects $work directly to
//       confirm no extraction ever ran).
//   (3) DEFENSE IN DEPTH — a literal "No space left on device" surfacing from
//       the streamed EXTRACTION stage specifically is classified
//       restore-failed:local, never restore-failed:archive.
// ---------------------------------------------------------------------------

suite("install-cache restore — round 6 review, item 3 SECURITY/SPACE: streamed zstd|tar never materializes a full decompressed .tar on disk", () => {
  /** Shadows `rm` on PATH with a no-op, so the pipeline's own `trap 'rm -rf
   *  "$work"' EXIT` never actually deletes `$work` — the same "shadow one
   *  real tool via PATH" technique `fakeDfDir` above already uses for `df`,
   *  applied to `rm` instead, so this test can inspect what was left on disk
   *  right before cleanup would have wiped it. Safe here specifically because
   *  every test in this suite restores into a FRESH checkout with no
   *  pre-existing `node_modules` of its own, so the no-op'd `rm -rf
   *  <checkout>/node_modules` precondition step has nothing to actually
   *  remove either way. */
  function fakeNoopRmDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "fleet-fake-rm-"));
    writeFileSync(join(dir, "rm"), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
    return dir;
  }

  /** The pre-round-6 shape of installCacheRestoreCmd's own zstd/tar stages —
   *  decompresses the WHOLE archive to a real `$work/dl.tar` file before ever
   *  listing or extracting it. Reconstructed verbatim from the pre-this-task
   *  install-cache.ts (same "kept only as the mutant baseline" pattern this
   *  file's other preFix* helpers already use) — never imported from src/, it
   *  no longer exists there. */
  function preFixFullTarIntermediateCmd(dir: string): string {
    return (
      `(set -o pipefail && ` +
      `work=$(mktemp -d /tmp/.install-cache-restore.XXXXXX) && ` +
      `trap 'rm -rf "$work"' EXIT && ` +
      `{ mkdir -p '${dir}' || { echo restore-failed:precondition; exit 1; }; } && ` +
      `{ curl --fail --silent --show-error --max-time 600 ` +
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

  /** `installCacheRestoreCmd`'s own fixed `mktemp` prefix — real and unique
   *  enough for this suite's own duration that scanning `tmpdir()` for it
   *  (rather than needing the command to report its own `$work` path, which
   *  it never does) reliably finds the ONE work dir a given test run left
   *  behind, now that `rm` is shadowed. */
  function findWorkDirs(): string[] {
    return readdirSync(tmpdir())
      .filter((n) => n.startsWith(".install-cache-restore."))
      .map((n) => join(tmpdir(), n));
  }

  function cleanupWorkDirs() {
    for (const d of findWorkDirs()) rmSync(d, { recursive: true, force: true });
  }

  test("MUTANT BASELINE — the pre-round-6 pipeline genuinely materializes a full decompressed dl.tar on disk", () => {
    cleanupWorkDirs();
    const payload = buildPayload();
    const checkout = seedCheckout();
    const rmShim = fakeNoopRmDir();
    try {
      const result = runSnippet({
        script: preFixFullTarIntermediateCmd(checkout),
        shell: "bash",
        sourced: true,
        env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}`, PATH: `${rmShim}:${process.env.PATH}` },
        timeout: 20_000,
      });
      expect(result.stdout.trim()).toBe("restored");
      const workDirs = findWorkDirs();
      expect(workDirs.length).toBeGreaterThan(0);
      expect(existsSync(join(workDirs[0], "dl.tar"))).toBe(true);
    } finally {
      cleanupWorkDirs();
      rmSync(rmShim, { recursive: true, force: true });
    }
  });

  test("GREEN — the NEW shipped command restores identically but NEVER materializes a full decompressed dl.tar anywhere under $work", () => {
    cleanupWorkDirs();
    const payload = buildPayload();
    const checkout = seedCheckout();
    const rmShim = fakeNoopRmDir();
    try {
      const result = runSnippet({
        script: installCacheRestoreCmd(checkout),
        shell: "bash",
        sourced: true,
        env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}`, PATH: `${rmShim}:${process.env.PATH}` },
        timeout: 20_000,
      });
      expect(result.stdout.trim()).toBe("restored");
      expect(readFileSync(join(checkout, "node_modules", "pkg", "index.js"), "utf8")).toContain("legit-dep");
      const workDirs = findWorkDirs();
      expect(workDirs.length).toBeGreaterThan(0);
      // The one file the OLD design always left behind — genuinely absent now.
      expect(existsSync(join(workDirs[0], "dl.tar"))).toBe(false);
      // What IS still there, proving this isn't just "nothing ran": the
      // original compressed download (the extracted `stage/node_modules`
      // copy is `mv`d OUT of $work into the checkout at the very end —
      // already asserted above via the checkout's own node_modules — so
      // `stage` itself remains, now empty). `listing.txt` is deliberately
      // ABSENT — issue #387 moved the listing itself into a shell variable,
      // never a file, the same as round 7 already did for each streamed
      // stage's own stderr.
      expect(existsSync(join(workDirs[0], "dl.tar.zst"))).toBe(true);
      expect(existsSync(join(workDirs[0], "listing.txt"))).toBe(false);
      expect(existsSync(join(workDirs[0], "stage"))).toBe(true);
    } finally {
      cleanupWorkDirs();
      rmSync(rmShim, { recursive: true, force: true });
    }
  });

  test("SECURITY — the traversal guard still fires on the NEW streamed pipeline: a path-traversal member is rejected before any extraction ever runs", () => {
    cleanupWorkDirs();
    const build = join(base, "build-trav-stream");
    mkdirSync(join(build, "node_modules"), { recursive: true });
    writeFileSync(join(build, "node_modules", "ok.js"), "fine\n");
    writeFileSync(join(build, "evil.txt"), "evil\n");
    const plantedName = "install-cache-sec-planted-stream.txt";
    rmSync(join(tmpdir(), plantedName), { force: true });
    const rTar = sh(
      `cd ${JSON.stringify(build)} && ` +
      `tar --transform 's#^evil\\.txt#../../../../../../${plantedName}#' ` +
      `-cf ${JSON.stringify(join(base, "trav-stream.tar"))} node_modules evil.txt`,
    );
    expect(rTar.status).toBe(0);
    const payload = join(base, "trav-stream.tar.zst");
    const rZ = sh(`zstd -q -c ${JSON.stringify(join(base, "trav-stream.tar"))} > ${JSON.stringify(payload)}`);
    expect(rZ.status).toBe(0);

    const checkout = seedCheckout();
    const rmShim = fakeNoopRmDir();
    try {
      const result = runRestore(checkout, `file://${payload}`);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("restore-failed:archive");
      expect(existsSync(join(tmpdir(), plantedName))).toBe(false);
      // Confirms this was refused at the LISTING stage — no extraction ever
      // ran, so `$work/stage/node_modules` never came into existence.
      const workDirs = findWorkDirs();
      if (workDirs.length > 0) {
        expect(existsSync(join(workDirs[0], "stage", "node_modules"))).toBe(false);
      }
    } finally {
      rmSync(join(tmpdir(), plantedName), { force: true });
      cleanupWorkDirs();
      rmSync(rmShim, { recursive: true, force: true });
    }
  });

  // Issue #393 (SECURITY) — the traversal-guard test above uses a TINY
  // archive (2 members) — nowhere near the ~64KB kernel pipe buffer needed
  // to ever trigger the pipefail/SIGPIPE interaction issue #387's own
  // follow-up already found for the ENOSPC checks (see this file's own
  // round-6/round-7 header comments for the full mechanism: `cmd | grep -q`
  // exits on its FIRST match, SIGPIPEs the upstream writer if the pipe is
  // still mid-write, and `set -o pipefail` reports the whole pipeline as
  // failed even though grep itself found the match). The traversal check
  // ALREADY uses process substitution in the shipped code (confirmed by
  // reading `installCacheRestoreCmd`'s own source directly, on `main`,
  // before writing this test) — this exists so a FUTURE accidental
  // regression back to a plain pipe is caught HERE, instead of silently
  // shipping a path-traversal bypass no existing test would ever flag.
  //
  // Verified live, manually, before writing this as a permanent test: the
  // real shipped command correctly rejects this exact payload; a
  // hand-mutated plain-pipe version of just this one check does not — the
  // `../evil` member genuinely extracts.
  function buildLargeListingTraversalFirstPayload(): string {
    const build = mkdtempSync(join(tmpdir(), "fleet-trav-large-src-"));
    writeFileSync(join(build, "evil.txt"), "evil\n");
    // Flat directory, long padded names: one mkdirSync total (not one per
    // file) keeps generation fast (~5-6s for 6000 files here vs 30s+ timing
    // out for the same listing size via 20,000 nested per-package dirs) while
    // still clearing the >1MB listing size the pipe-buffer/SIGPIPE bug needs.
    const modulesDir = join(build, "node_modules");
    mkdirSync(modulesDir, { recursive: true });
    const pad = "x".repeat(180);
    for (let i = 0; i < 6_000; i++) {
      writeFileSync(join(modulesDir, `pkg-${pad}-${String(i).padStart(5, "0")}.js`), "1");
    }
    const tarPath = join(base, "trav-large.tar");
    const payload = join(base, "trav-large.tar.zst");
    // `evil.txt` named FIRST on tar's own command line, transformed to a
    // traversal-shaped member name — GNU tar writes members in the order
    // given, so this lands as the archive's FIRST entry, matching the
    // issue's own live repro ("../evil first").
    const rTar = sh(
      `cd ${JSON.stringify(build)} && ` +
      `tar --transform 's#^evil\\.txt#../evil#' -cf ${JSON.stringify(tarPath)} evil.txt node_modules`,
    );
    if (rTar.status !== 0) throw new Error(`failed to build traversal-first tar: ${rTar.stderr}`);
    const rZ = sh(`zstd -q -3 -c ${JSON.stringify(tarPath)} > ${JSON.stringify(payload)}`);
    rmSync(build, { recursive: true, force: true });
    if (rZ.status !== 0) throw new Error(`failed to compress traversal-first payload: ${rZ.stderr}`);
    // Confirm the two properties issue #393's own live repro actually needed
    // to reach the pipefail bug — a large listing AND the traversal member
    // first — rather than trusting the archive-build steps above alone.
    const listing = sh(`tar --absolute-names -tf ${JSON.stringify(tarPath)}`);
    if (listing.status !== 0) throw new Error(`failed to list traversal-first tar: ${listing.stderr}`);
    if (listing.stdout.length <= 1_000_000) {
      throw new Error(`test payload listing too small (${listing.stdout.length} bytes) to exercise the pipe-buffer/SIGPIPE bug — need >1MB`);
    }
    if (!listing.stdout.startsWith("../evil")) {
      throw new Error(`traversal member is not first in the built archive: ${listing.stdout.slice(0, 100)}`);
    }
    return payload;
  }

  /** The shipped `installCacheRestoreCmd`'s combined name/symlink check
   *  (issue #395 review round 2 folded it into ONE awk pass over `-tvf`
   *  output), mutated back to a plain pipe — derived from the REAL current
   *  function's own output (never hand-retyped) via regex so this mutant can
   *  never silently drift out of sync with the real command as it evolves;
   *  throws loudly if the exact wrapping text it patches ever changes,
   *  rather than testing something else by accident. The awk script itself
   *  ALSO uses early-`exit` on a match, same shape as `grep -q` — feeding it
   *  through a bare pipe instead of process substitution reintroduces the
   *  identical SIGPIPE/pipefail bug #393 proved.
   *
   *  Restructured into a DIRECT `if <pipe>; then` condition (piping awk's
   *  own "x" output through a final `grep -q x`), not a captured-variable
   *  assignment — verified live that the assignment shape fails a
   *  DIFFERENT, LOUDER way under this exact race (the whole command exits
   *  141 with no output at all, since `symlinkHit=$(...)`'s own reported
   *  exit status mirrors the pipe's pipefail-computed status regardless of
   *  what text landed in the variable, short-circuiting the surrounding
   *  `&&` chain before the `-n "$symlinkHit"` check ever runs). The
   *  `if`-condition shape matches the ORIGINAL #393 bug's exact mechanism:
   *  the pipe's own exit status alone decides the branch, so an
   *  early-exiting reader anywhere upstream of the final stage silently
   *  flips a genuine match into "no match" instead of crashing loudly. */
  function mutantPlainPipeTraversalCmd(dir: string): string {
    const real = installCacheRestoreCmd(dir);
    const re =
      /\{ symlinkHit=\$\(awk '(.*)' <\(printf '%s' "\$listing"\)\); \} && \{ if \[ -n "\$symlinkHit" \]; then echo restore-failed:archive; exit 1; fi; \} && /;
    const m = real.match(re);
    if (!m) {
      throw new Error(
        "mutantPlainPipeTraversalCmd's patch point not found in the real installCacheRestoreCmd -- " +
          "the combined name/symlink check's own text changed; update this mutant to match before trusting this test again",
      );
    }
    // A DIRECT `if <pipe>; then` condition (never a captured-variable
    // assignment, which fails a different, LOUDER way under pipefail — see
    // this function's own doc comment) — matching the ORIGINAL #393 bug's
    // exact shape: the pipe's own exit status silently decides the
    // condition, so an early-exiting reader anywhere upstream of the FINAL
    // stage flips a genuine match into "no match", falling through to
    // extract and report "restored" instead of refusing the archive.
    return real.replace(re, `{ if printf '%s' "$listing" | awk '${m[1]}' | grep -q x; then echo restore-failed:archive; exit 1; fi; } && `);
  }

  test("SECURITY — MUTANT BASELINE: a plain-pipe traversal check genuinely misses a REAL traversal member when the listing is large enough to trigger pipefail/SIGPIPE (issue #393)", () => {
    const payload = buildLargeListingTraversalFirstPayload();
    const checkout = seedCheckout();
    const result = runSnippet({
      script: mutantPlainPipeTraversalCmd(checkout),
      shell: "bash",
      sourced: true,
      env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}` },
      timeout: 25_000,
    });
    // the bug: the traversal member is missed, extraction proceeds, the
    // command reports success instead of refusing the archive
    expect(result.stdout.trim()).toBe("restored");
  }, 30_000);

  test("SECURITY — MUTANT PROOF: the FIXED, shipped traversal check (process substitution) correctly rejects the IDENTICAL large-listing traversal-first payload (issue #393)", () => {
    cleanupWorkDirs();
    const payload = buildLargeListingTraversalFirstPayload();
    const checkout = seedCheckout();
    const rmShim = fakeNoopRmDir();
    try {
      const result = runRestore(checkout, `file://${payload}`);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("restore-failed:archive");
      // no extraction ever ran
      const workDirs = findWorkDirs();
      if (workDirs.length > 0) {
        expect(existsSync(join(workDirs[0], "stage", "node_modules"))).toBe(false);
      }
    } finally {
      cleanupWorkDirs();
      rmSync(rmShim, { recursive: true, force: true });
    }
  }, 30_000);

  /** A real archive containing a LEGITIMATE relative bin-shim-shaped symlink
   *  (`node_modules/.bin/tool -> ../real-pkg/bin/tool.js`, the exact shape
   *  every real bun/npm install produces — verified against this repo's own
   *  `node_modules/.bin/tsc -> ../typescript/bin/tsc`) and, when set, a
   *  LEGITIMATE workspace-link (`node_modules/core -> ../packages/core`, the
   *  shape a hoisted monorepo linker plants — one level up from
   *  `node_modules` lands back at the checkout root, still inside it; review
   *  round 2 measured this live against example.app's real node_modules,
   *  8700 such links) plus, when set, malicious symlinks: `outward` (absolute,
   *  `node_modules/passwd -> /etc/passwd`, issue #395's own named example),
   *  `outwardRelative` (`node_modules/passwd2 -> ../../../etc/passwd` — no
   *  absolute path at all, purely relative `..` climbing back out past the
   *  checkout root), and `mixed` (`node_modules/pkg/x -> real/../../../../etc/passwd`
   *  — a `..` AFTER a real path segment, never a legitimate shim/link shape).
   *  GNU tar does not dereference symlinks by default (no `-h`), so these
   *  land in the archive AS symlink members, not as copies of their
   *  targets — confirmed live via `tar -tv` before writing this test. */
  function buildSymlinkPayload(
    opts: { workspaceLink?: boolean; outward?: boolean; outwardRelative?: boolean; mixed?: boolean } = {},
  ): string {
    const build = join(base, "build-symlink");
    mkdirSync(join(build, "node_modules", "real-pkg", "bin"), { recursive: true });
    mkdirSync(join(build, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(build, "node_modules", "real-pkg", "bin", "tool.js"), "#!/usr/bin/env node\n");
    symlinkSync("../real-pkg/bin/tool.js", join(build, "node_modules", ".bin", "tool"));
    if (opts.workspaceLink) {
      symlinkSync("../packages/core", join(build, "node_modules", "core"));
    }
    if (opts.outward) {
      symlinkSync("/etc/passwd", join(build, "node_modules", "passwd"));
    }
    if (opts.outwardRelative) {
      symlinkSync("../../../etc/passwd", join(build, "node_modules", "passwd2"));
    }
    if (opts.mixed) {
      mkdirSync(join(build, "node_modules", "pkg"), { recursive: true });
      symlinkSync("real/../../../../etc/passwd", join(build, "node_modules", "pkg", "x"));
    }
    const payload = join(base, "symlink.tar.zst");
    const r = sh(`cd ${JSON.stringify(build)} && tar -c node_modules | zstd -q -c > ${JSON.stringify(payload)}`);
    if (r.status !== 0) throw new Error(`failed to build symlink test payload: ${r.stderr}`);
    return payload;
  }

  test("SECURITY — an outward ABSOLUTE symlink (node_modules/passwd -> /etc/passwd) is rejected at the listing pass, never extracted (issue #395)", () => {
    const payload = buildSymlinkPayload({ outward: true });
    const checkout = seedCheckout();
    const result = runRestore(checkout, `file://${payload}`);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("restore-failed:archive");
    expect(existsSync(join(checkout, "node_modules", "passwd"))).toBe(false);
  }, 30_000);

  test("SECURITY — an outward RELATIVE symlink (node_modules/passwd2 -> ../../../etc/passwd, no absolute path at all) is rejected (issue #395 review round 2)", () => {
    const payload = buildSymlinkPayload({ outwardRelative: true });
    const checkout = seedCheckout();
    const result = runRestore(checkout, `file://${payload}`);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("restore-failed:archive");
    expect(existsSync(join(checkout, "node_modules", "passwd2"))).toBe(false);
  }, 30_000);

  test("SECURITY — a MIXED symlink target (a real path segment, then '..' climbing out — node_modules/pkg/x -> real/../../../../etc/passwd) is rejected (issue #395 review round 2)", () => {
    const payload = buildSymlinkPayload({ mixed: true });
    const checkout = seedCheckout();
    const result = runRestore(checkout, `file://${payload}`);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("restore-failed:archive");
    expect(existsSync(join(checkout, "node_modules", "pkg"))).toBe(false);
  }, 30_000);

  test("SECURITY — a legitimate relative bin-shim symlink AND a workspace-link (hoisted-monorepo shape) both still restore correctly (issue #395 review round 2)", () => {
    const payload = buildSymlinkPayload({ workspaceLink: true });
    const checkout = seedCheckout();
    const result = runRestore(checkout, `file://${payload}`);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("restored");
    expect(readFileSync(join(checkout, "node_modules", ".bin", "tool"), "utf8")).toContain("#!/usr/bin/env node");
    // a DANGLING symlink (its target, ../packages/core, doesn't really exist
    // in this test checkout) -- existsSync() follows the target and would
    // wrongly report false; lstat the link itself instead.
    expect(lstatSync(join(checkout, "node_modules", "core")).isSymbolicLink()).toBe(true);
  }, 30_000);

  /** The shipped `installCacheRestoreCmd`'s own symlink-check text with the
   *  `dots>depth` half of the guard clause dropped — derived by string-
   *  replace from the real command so it can never silently drift. Proves
   *  the depth check is load-bearing: without it, a purely-relative outward
   *  escape (no `mixed` shape, so the OTHER half of the guard clause would
   *  never catch it either) restores successfully. */
  function mutantNoDepthCheckCmd(dir: string): string {
    const real = installCacheRestoreCmd(dir);
    const from = 'if(mixed||dots>depth){print "x";exit}';
    const to = 'if(mixed){print "x";exit}';
    if (!real.includes(from)) {
      throw new Error(
        "mutantNoDepthCheckCmd's patch point not found in the real installCacheRestoreCmd -- " +
          "the symlink check's own text changed; update this mutant to match before trusting this test again",
      );
    }
    return real.replace(from, to);
  }

  /** Same technique, the `mixed` half dropped instead — proves THAT half is
   *  load-bearing: without it, a down-then-back-up target (which has
   *  `dots <= depth` measured naively, since the depth-vs-dots comparison
   *  alone cannot see the intervening real segment) restores successfully. */
  function mutantNoMixedCheckCmd(dir: string): string {
    const real = installCacheRestoreCmd(dir);
    const from = 'if(mixed||dots>depth){print "x";exit}';
    const to = "if(dots>depth){print \"x\";exit}";
    if (!real.includes(from)) {
      throw new Error(
        "mutantNoMixedCheckCmd's patch point not found in the real installCacheRestoreCmd -- " +
          "the symlink check's own text changed; update this mutant to match before trusting this test again",
      );
    }
    return real.replace(from, to);
  }

  test("SECURITY — MUTANT BASELINE: dropping the 'dots>depth' half of the guard genuinely lets the outward-RELATIVE escape restore successfully (proves that check is load-bearing)", () => {
    const payload = buildSymlinkPayload({ outwardRelative: true });
    const checkout = seedCheckout();
    const result = runSnippet({
      script: mutantNoDepthCheckCmd(checkout),
      shell: "bash",
      sourced: true,
      env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}` },
      timeout: 25_000,
    });
    expect(result.stdout.trim()).toBe("restored"); // the bug: escape gets through
  }, 30_000);

  test("SECURITY — MUTANT BASELINE: dropping the 'mixed' half of the guard genuinely lets the down-then-up escape restore successfully (proves that check is load-bearing)", () => {
    const payload = buildSymlinkPayload({ mixed: true });
    const checkout = seedCheckout();
    const result = runSnippet({
      script: mutantNoMixedCheckCmd(checkout),
      shell: "bash",
      sourced: true,
      env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}` },
      timeout: 25_000,
    });
    expect(result.stdout.trim()).toBe("restored"); // the bug: escape gets through
  }, 30_000);

  test("DEFENSE IN DEPTH — a real ENOSPC-shaped error surfacing from the streamed EXTRACTION stage specifically is classified restore-failed:local, never restore-failed:archive", () => {
    // Real ENOSPC is impractical to reproduce without root/loop-device
    // support in this sandbox (this file's own header, round 5 section) — so,
    // matching that established precedent, this injects the EXACT stderr
    // shape a real ENOSPC produces via a fake `tar` on PATH that fails ONLY
    // the extraction call (`-x`), delegating every other call (the listing
    // pass) through to the REAL tar untouched — isolating the property under
    // test to exactly the extraction stage's own stderr classification.
    //
    // My own follow-up: this fixture used to ALSO inject a fabricated bare
    // "No space left on device" line alongside tar's own real message — a
    // string no real GNU tar actually prints (verified live in this sandbox,
    // extracting into a 1MB tmpfs: real tar wraps a failed write as `tar:
    // <member>: Wrote only N of M bytes`, never the raw errno text). That
    // extra injected line was propping up a shipped grep pattern that only
    // matched the raw string and would never have fired against a REAL tar
    // ENOSPC. Removed the fabricated line; this fixture now reproduces
    // exactly what real tar 1.34 emits.
    cleanupWorkDirs();
    const payload = buildPayload();
    const checkout = seedCheckout();
    const fakeTarDir = mkdtempSync(join(tmpdir(), "fleet-fake-tar-enospc-"));
    const realTar = spawnSync("which", ["tar"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/tar";
    writeFileSync(
      join(fakeTarDir, "tar"),
      `#!/bin/sh\n` +
      `for a in "$@"; do\n` +
      `  if [ "$a" = "-x" ]; then\n` +
      `    echo "tar: node_modules/pkg/index.js: Wrote only 0 of 512 bytes" >&2\n` +
      `    echo "tar: Exiting with failure status due to previous errors" >&2\n` +
      `    exit 2\n` +
      `  fi\n` +
      `done\n` +
      `exec ${realTar} "$@"\n`,
      { mode: 0o755 },
    );
    try {
      const result = runSnippet({
        script: installCacheRestoreCmd(checkout),
        shell: "bash",
        sourced: true,
        env: { [INSTALL_CACHE_URL_ENV]: `file://${payload}`, PATH: `${fakeTarDir}:${process.env.PATH}` },
        timeout: 20_000,
      });
      expect(result.stdout.trim()).toBe("restore-failed:local");
      expect(result.stdout).not.toContain("restore-failed:archive");
      expect(existsSync(join(checkout, "node_modules"))).toBe(false);
    } finally {
      rmSync(fakeTarDir, { recursive: true, force: true });
      cleanupWorkDirs();
    }
  });
});

// ---------------------------------------------------------------------------
// Board #350, round 7 review — BLOCKER: the round-6 shipped fix classified
// ENOSPC correctly ONLY when it could still WRITE its own diagnostic file
// (`$work/list.err`/`$work/extract.err`) to report it — but that file lived
// on the EXACT SAME filesystem being diagnosed as full. On a REAL full disk,
// the write that CREATES the error-capturing file can itself fail (silently:
// a failed redirect target just produces nothing to grep), so the ENOSPC
// report tar/zstd tried to print is NEVER SEEN, this falls through to
// `restore-failed:archive`, and a perfectly good remote object gets
// tombstoned for a failure that was this studio's own disk. The fake-tar-shim
// tests above (round 6) could never catch this: a shim just prints text to
// its OWN real stdout/stderr streams, which the file-based `2>` redirect
// captures into a file just fine regardless of how full `$work` is — they
// prove the GREP PATTERN is right, never that the FILE CAPTURE can survive a
// genuinely full disk. This suite proves the actual property: a REAL
// `installCacheRestoreCmd` run, against a REAL full filesystem (a tmpfs
// mounted small enough that an archive's real extraction cannot fit),
// classifies the failure `restore-failed:local`, never `restore-failed:
// archive`.
//
// ISOLATION: `unshare --mount --pid --fork` gives the test's own bash
// subprocess a PRIVATE mount namespace before mounting a tiny tmpfs AT
// `/tmp` inside it — `installCacheRestoreCmd`'s own `mktemp -d
// /tmp/.install-cache-restore.XXXXXX` is a fixed, unparameterized path (by
// design — it is not meant to take an operator-controlled base dir), so a
// real disk-full test of the REAL shipped command has to make `/tmp` itself
// small, not redirect the command elsewhere. Verified live, outside this
// test file, that the outer container's own real `/tmp` is provably
// unaffected once the namespaced process exits (`mountpoint /tmp` reports
// "not a mountpoint" immediately after) — this is real Linux mount namespace
// isolation, the same primitive containers themselves are built from, not a
// destructive operation on shared state. Requires the same root/CAP_SYS_ADMIN
// this container already runs test infrastructure as; skipped, not failed,
// wherever `unshare --mount` itself is unusable (a stricter sandbox, an
// unprivileged CI runner).
//
// PREFLIGHT-DEFEATING PAYLOAD: a naive too-big-to-fit-anywhere archive would
// get refused by the disk-space PREFLIGHT above (`df`-based, checked before
// any streamed stage even starts) rather than reaching the streamed stage
// this fix is actually about — proven live while building this test: the
// SAME setup with a random-content (near-incompressible) 2MB archive against
// a 2.5MB tmpfs reported `restore-failed:local` even on the OLD, pre-round-7
// command, because the preflight itself already caught it first. To reach
// and exercise the STREAMED STAGE'S OWN failure specifically, this payload
// is instead HIGHLY COMPRESSIBLE (3MB of a single repeated byte, verified
// live to compress to ~243 bytes) — the preflight's own multiplier
// (`dl_size * INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER`) sees a tiny
// `dl_size` and passes easily, exactly reproducing the maestro's own
// reported shape: the preflight is satisfied, and it is the REAL streamed
// zstd/tar write that then genuinely runs out of room.
// Issue #388 (round-7 follow-up) — `unshare --mount` alone needs real
// root + CAP_SYS_ADMIN, unavailable in the default docker bun lane and any
// unprivileged CI runner, so this whole suite skipped everywhere except a
// manual --privileged run — the RED/GREEN proof above never actually ran in
// CI. `-r` (`--map-root-user`) creates a USER namespace first, mapping the
// CALLING user to root INSIDE it, which is then permitted to create its own
// mount namespace and mount a real tmpfs without needing any real privilege
// on the host — verified live as a genuinely unprivileged user (uid 1000, no
// capabilities, created specifically to test this): reproduces BOTH the RED
// (old command misclassifies) and GREEN (shipped command classifies
// correctly) cases identically to running as real root.
// Round-2 review on PR #390 — `unshare -r` (issue #388's own fix above) still
// does not run everywhere: Docker's DEFAULT seccomp profile blocks the
// underlying `unshare(CLONE_NEWUSER|...)` syscall combination outright
// ("Operation not permitted", for both root and an unprivileged user) unless
// the container is started with `--security-opt seccomp=unconfined` or
// `--cap-add SYS_ADMIN` (this repo's own `scripts/localci/localci.sh` now
// does the former — its own doc comment on that flag has the full reasoning)
// — and a bare `ubuntu-latest` GitHub Actions runner (no docker at all) can
// ALSO refuse it, independently, via Ubuntu 24.04's own
// `kernel.apparmor_restrict_unprivileged_userns` AppArmor restriction (a
// HOST-level sysctl, unrelated to docker/seccomp — `.github/workflows/
// fleet-check.yml` resets it before the bun-test step; see that file's own
// comment). Both are real, independently-documented gaps this suite's own
// `canUnshareMount` probe cannot tell apart from "dev machine, no docker" —
// which is exactly why a bare `describe.skip` here is dangerous: a
// regression in EITHER fix (the docker flag or the sysctl reset) silently
// drops this whole suite's coverage again, with no signal anywhere that it
// happened, since a skip and a "correctly not applicable" skip look
// identical in a green CI run.
//
// Fixed by checking `CI=true` — set automatically by GitHub Actions and
// effectively every other CI system, not scoped to one pinned image the way
// `require-tool.ts`'s own `LOCALCI_IMAGE` convention is (deliberately NOT
// reused here: `LOCALCI_IMAGE` is unset entirely on the bare `ubuntu-latest`
// runner, which never runs inside `scripts/localci/Dockerfile`'s own image
// at all, so gating on it would leave that lane silently skipping exactly
// the case this fix exists to catch). Missing `unshare -r` capability
// outside CI (a dev's own machine, this studio's own sandbox before either
// fix landed, whatever) still quietly skips — no behavior change for that
// case, matching every other tool-presence gate in this file.
const canUnshareMount = spawnSync("unshare", ["-r", "--mount", "--pid", "--fork", "true"], { encoding: "utf8" }).status === 0;
const unshareSuite = canUnshareMount
  ? describe
  : process.env.CI === "true"
    ? (name: string, fn: () => void): void => {
        describe(name, () => {
          test("unshare -r --mount unavailable in CI — this suite's own RED/GREEN ENOSPC proof would silently skip instead of running", () => {
            throw new Error(
              "CI=true but `unshare -r --mount --pid --fork true` failed — this lane lost the ability to run " +
                "the real-full-disk ENOSPC test suite (issue #388). If this is the docker-based lane, confirm " +
                "`docker run` still has `--security-opt seccomp=unconfined` (scripts/localci/localci.sh). If " +
                "this is a bare GitHub Actions runner, confirm the AppArmor unprivileged-userns sysctl reset " +
                "step in .github/workflows/fleet-check.yml still runs before this one and actually succeeded.",
            );
          });
        });
      }
    : describe.skip;

unshareSuite("install-cache restore — round 7 review, BLOCKER: ENOSPC classification survives a REAL full disk (in-memory stderr capture, not a file on the same filesystem)", () => {
  /** A highly compressible archive — see this suite's own header for why:
   *  defeats the disk-space PREFLIGHT (tiny `dl_size`) so the test reaches
   *  and exercises the streamed zstd/tar stage's OWN ENOSPC handling, not the
   *  preflight's. */
  function buildCompressiblePayload(): string {
    const build = mkdtempSync(join(tmpdir(), "fleet-enospc-real-src-"));
    mkdirSync(join(build, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(build, "node_modules", "pkg", "big.txt"), "A".repeat(3 * 1024 * 1024));
    const payload = join(base, "enospc-real-payload.tar.zst");
    const r = sh(`cd ${JSON.stringify(build)} && tar -c node_modules | zstd -q -19 -c > ${JSON.stringify(payload)}`);
    rmSync(build, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`failed to build compressible test payload: ${r.stderr}`);
    return payload;
  }

  /** Runs `cmd` (a REAL `installCacheRestoreCmd(...)` string, or a
   *  hand-reconstructed pre-round-7 mutant of it) inside a private user +
   *  mount namespace (issue #388's own `-r` — see this suite's own header)
   *  whose OWN `/tmp` is a small, genuinely full-able tmpfs — see this
   *  suite's own top-level header for the isolation argument. `payload` and
   *  the script itself are staged OUTSIDE `/tmp` first, under the CALLING
   *  user's own home directory (never a hardcoded `/root` — issue #388: that
   *  broke the moment this suite runs as anyone but root, which `-r` now
   *  lets it do) since remounting `/tmp` inside the namespace would otherwise
   *  shadow anything left there beforehand. `tmpfsKb` sizes the tmpfs
   *  deliberately too small for the payload's own real decompressed/listed
   *  size but comfortably large enough for its tiny compressed download. */
  function runInFullTmpfs(cmd: string, payload: string, tmpfsKb: number): { code: number | null; stdout: string } {
    const stageDir = mkdtempSync(join(homedir(), "fleet-enospc-stage-"));
    const scriptPath = join(stageDir, "cmd.sh");
    const payloadPath = join(stageDir, "payload.tar.zst");
    writeFileSync(scriptPath, cmd);
    writeFileSync(payloadPath, readFileSync(payload));
    try {
      const r = spawnSync(
        "unshare",
        [
          "-r", "--mount", "--pid", "--fork", "bash", "-c",
          `mount -t tmpfs -o size=${tmpfsKb}k tmpfs /tmp && mkdir -p /tmp/restore-target && ` +
          `INSTALL_CACHE_URL=${JSON.stringify(`file://${payloadPath}`)} bash ${JSON.stringify(scriptPath)}`,
        ],
        { encoding: "utf8", timeout: 20_000 },
      );
      return { code: r.status, stdout: r.stdout ?? "" };
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  /** The round-6 shipped shape of the two streamed stages — file-based
   *  stderr capture (`2>"$work/list.err"` / `2>"$work/extract.err"`) —
   *  reconstructed verbatim as the mutant baseline; never imported from
   *  src/, round 7 replaced it there with the in-memory capture below. */
  function preFixRound6FileBasedCaptureCmd(dir: string): string {
    return (
      `(set -o pipefail && ` +
      `work=$(mktemp -d /tmp/.install-cache-restore.XXXXXX) && ` +
      `trap 'rm -rf "$work"' EXIT && ` +
      `{ mkdir -p '${dir}' || { echo restore-failed:precondition; exit 1; }; } && ` +
      `{ curl --fail --silent --show-error --max-time 600 ` +
      `-o "$work/dl.tar.zst" "$${INSTALL_CACHE_URL_ENV}" || { echo restore-failed:transfer; exit 1; }; } && ` +
      `{ dl_size=$(stat -c%s "$work/dl.tar.zst" 2>/dev/null || echo 0); ` +
      `avail_kb=$(df -Pk "$work" 2>/dev/null | tail -1 | awk '{print $4}'); ` +
      `if [ -n "$avail_kb" ] && [ "$avail_kb" -eq "$avail_kb" ] 2>/dev/null; then ` +
      `avail_bytes=$((avail_kb * 1024)); needed=$((dl_size * ${INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER})); ` +
      `if [ "$avail_bytes" -lt "$needed" ]; then echo restore-failed:local; exit 1; fi; ` +
      `fi; } && ` +
      `{ zstd -dc "$work/dl.tar.zst" 2>"$work/list.err" | tar --absolute-names -tf - > "$work/listing.txt" 2>>"$work/list.err" || ` +
      `{ if grep -qiE 'no space left on device|wrote only [0-9]+ of [0-9]+ bytes' "$work/list.err" 2>/dev/null; then echo restore-failed:local; else echo restore-failed:archive; fi; exit 1; }; } && ` +
      `{ if grep -Eq '^/|(^|/)\\.\\.($|/)' "$work/listing.txt"; then echo restore-failed:archive; exit 1; fi; } && ` +
      `mkdir -p "$work/stage" && ` +
      `{ zstd -dc "$work/dl.tar.zst" 2>"$work/extract.err" | tar -x -C "$work/stage" -f - node_modules 2>>"$work/extract.err" || ` +
      `{ if grep -qiE 'no space left on device|wrote only [0-9]+ of [0-9]+ bytes' "$work/extract.err" 2>/dev/null; then echo restore-failed:local; else echo restore-failed:archive; fi; exit 1; }; } && ` +
      `{ [ -d "$work/stage/node_modules" ] || { echo restore-failed:archive; exit 1; }; } && ` +
      `{ rm -rf '${dir}'/node_modules || { echo restore-failed:precondition; exit 1; }; } && ` +
      `{ mv "$work/stage/node_modules" '${dir}'/node_modules || { echo restore-failed:precondition; exit 1; }; } && ` +
      `echo restored)`
    );
  }

  test("MUTANT BASELINE — the round-6 shipped (file-based stderr capture) command genuinely misclassifies a REAL full-tmpfs ENOSPC as restore-failed:archive", () => {
    const payload = buildCompressiblePayload();
    const result = runInFullTmpfs(preFixRound6FileBasedCaptureCmd("/tmp/restore-target"), payload, 1024);
    expect(result.stdout.trim()).toBe("restore-failed:archive"); // the bug: the error-capturing file itself couldn't be written
  }, 25_000);

  test("MUTANT PROOF — the FIXED, shipped command correctly classifies the IDENTICAL real full-tmpfs ENOSPC as restore-failed:local", () => {
    const payload = buildCompressiblePayload();
    const cmd = installCacheRestoreCmd("/tmp/restore-target");
    const result = runInFullTmpfs(cmd, payload, 1024);
    expect(result.stdout.trim()).toBe("restore-failed:local");
    expect(result.stdout).not.toContain("restore-failed:archive");
  }, 25_000);

  // Issue #387 (round-7 follow-up) — the two tests above target the
  // EXTRACTION stage's own ENOSPC. This targets the LISTING stage
  // specifically: `zstd -dc ... | tar --absolute-names -tf - > listing.txt`
  // writes the member listing to a FILE, and on a real full disk THAT write
  // can fail too — verified live: real GNU tar prints ONLY `tar: stdout:
  // write error` for a failed listing write, a different message than
  // "wrote only N of M bytes" (which is specific to failed FILE CONTENT
  // writes during real extraction). The shipped ENOSPC pattern doesn't match
  // it, so a listing-pass ENOSPC still falls through to restore-failed:
  // archive, tombstoning a good object.
  //
  // Reaching this specific stage (rather than the disk-space PREFLIGHT
  // catching it first) needs a payload whose LISTING TEXT is
  // disproportionately larger than its own COMPRESSED size relative to the
  // preflight's own multiplier — a large file count with long, repetitive
  // path names compresses very well (small `dl_size`, the preflight's own
  // only input) while the `-tf` listing itself is uncompressed raw path text
  // that scales with file count, not compressed size. Verified live: 6,000
  // trivial files compress to ~47.7KB but their own listing is ~660KB — a
  // ratio comfortably past the preflight's own multiplier, so a tmpfs sized
  // to have enough room for the tiny download (preflight passes) but not for
  // the much larger listing text reproduces exactly the real-world "listing
  // ~0.3 MB for 507 MB node_modules" shape issue #387 itself measured,
  // without needing to simulate a live concurrent writer on the same disk.
  function buildManyFilesPayload(): string {
    const build = mkdtempSync(join(tmpdir(), "fleet-enospc-listing-src-"));
    for (let i = 0; i < 6000; i++) {
      const pkgDir = join(build, "node_modules", `some-longish-package-name-here-${String(i).padStart(5, "0")}`);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "index.js"), "module.exports = 1;\n");
    }
    const payload = join(base, "enospc-listing-payload.tar.zst");
    const r = sh(`cd ${JSON.stringify(build)} && tar -c node_modules | zstd -q -19 -c > ${JSON.stringify(payload)}`);
    rmSync(build, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`failed to build many-files test payload: ${r.stderr}`);
    return payload;
  }

  // Round-2 review on PR #390 — the listing-pass RED test above used to reuse
  // `preFixRound6FileBasedCaptureCmd`, which reconstructs round 6's shape:
  // BOTH stderr AND the listing itself still file-based. But `main` (before
  // this PR) already has round 7's OWN fix applied to the listing pass too —
  // `err=$( { ...; } 2>&1 >/dev/null )` already captures this stage's stderr
  // in memory, it is ONLY `listing.txt` (tar's real stdout, the member
  // listing itself) that still lands in a file. Testing against round 6's
  // cruder, doubly-broken shape does not isolate what THIS PR's own #387 fix
  // actually changes — it also exercises round 7's stderr fix, which is not
  // this PR's own work and was already correct. Reconstructed here verbatim
  // from `origin/main` at the commit this PR branches from (confirmed via
  // `git show origin/main:apps/fleet/src/studio/install-cache.ts`, not
  // guessed) so the RED test isolates exactly the one line #387 changes:
  // `> "$work/listing.txt"` moving to `listing=$(...)`.
  function preFixMainListingStillFileCmd(dir: string): string {
    return (
      `(set -o pipefail && ` +
      `work=$(mktemp -d /tmp/.install-cache-restore.XXXXXX) && ` +
      `trap 'rm -rf "$work"' EXIT && ` +
      `{ mkdir -p '${dir}' || { echo restore-failed:precondition; exit 1; }; } && ` +
      `{ curl --fail --silent --show-error --max-time 600 ` +
      `-o "$work/dl.tar.zst" "$${INSTALL_CACHE_URL_ENV}" || { echo restore-failed:transfer; exit 1; }; } && ` +
      `{ dl_size=$(stat -c%s "$work/dl.tar.zst" 2>/dev/null || echo 0); ` +
      `avail_kb=$(df -Pk "$work" 2>/dev/null | tail -1 | awk '{print $4}'); ` +
      `if [ -n "$avail_kb" ] && [ "$avail_kb" -eq "$avail_kb" ] 2>/dev/null; then ` +
      `avail_bytes=$((avail_kb * 1024)); needed=$((dl_size * ${INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER})); ` +
      `if [ "$avail_bytes" -lt "$needed" ]; then echo restore-failed:local; exit 1; fi; ` +
      `fi; } && ` +
      // This is main's REAL round-7 shape: stderr already in memory
      // (`err=$(...) 2>&1 >/dev/null`), listing itself still `>
      // "$work/listing.txt"` — the ONE thing #387 changes.
      `{ err=$( { zstd -dc "$work/dl.tar.zst" | tar --absolute-names -tf - > "$work/listing.txt"; } 2>&1 >/dev/null ) || ` +
      `{ if echo "$err" | grep -qiE 'no space left on device|wrote only [0-9]+ of [0-9]+ bytes'; then echo restore-failed:local; else echo restore-failed:archive; fi; exit 1; }; } && ` +
      `{ if grep -Eq '^/|(^|/)\\.\\.($|/)' "$work/listing.txt"; then echo restore-failed:archive; exit 1; fi; } && ` +
      `mkdir -p "$work/stage" && ` +
      `{ err=$( { zstd -dc "$work/dl.tar.zst" | tar -x -C "$work/stage" -f - node_modules; } 2>&1 >/dev/null ) || ` +
      `{ if echo "$err" | grep -qiE 'no space left on device|wrote only [0-9]+ of [0-9]+ bytes'; then echo restore-failed:local; else echo restore-failed:archive; fi; exit 1; }; } && ` +
      `{ [ -d "$work/stage/node_modules" ] || { echo restore-failed:archive; exit 1; }; } && ` +
      `{ rm -rf '${dir}'/node_modules || { echo restore-failed:precondition; exit 1; }; } && ` +
      `{ mv "$work/stage/node_modules" '${dir}'/node_modules || { echo restore-failed:precondition; exit 1; }; } && ` +
      `echo restored)`
    );
  }

  test("MUTANT BASELINE — main's REAL pre-#387 command (round 7's stderr-in-memory fix already applied, listing.txt still a file) genuinely misclassifies a REAL listing-pass ENOSPC (preflight satisfied, only the listing write itself fails) as restore-failed:archive", () => {
    const payload = buildManyFilesPayload();
    const result = runInFullTmpfs(preFixMainListingStillFileCmd("/tmp/restore-target"), payload, 400);
    expect(result.stdout.trim()).toBe("restore-failed:archive"); // the bug: "tar: stdout: write error" never matched the pattern
  }, 25_000);

  test("MUTANT PROOF — the FIXED, shipped command correctly classifies the IDENTICAL real listing-pass ENOSPC as restore-failed:local", () => {
    const payload = buildManyFilesPayload();
    const cmd = installCacheRestoreCmd("/tmp/restore-target");
    const result = runInFullTmpfs(cmd, payload, 400);
    expect(result.stdout.trim()).toBe("restore-failed:local");
    expect(result.stdout).not.toContain("restore-failed:archive");
  }, 25_000);
});
