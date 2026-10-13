// The DISK half of the former test/bun/install-cache-security.test.ts (split
// per docs/maintainability/plans/2026-10-13-s26f12-install-cache-security-split-699.md,
// refs #699): round-6 streamed SPACE proof (fakeNoopRmDir, findWorkDirs),
// symlink member guards, round-7 real-full-disk ENOSPC (canUnshareMount,
// runInFullTmpfs). The PARSE half — restore security, atomicity, injection,
// bunInstallRunningCmd, path traversal, symlink guard, tombstone, round-5
// disk-space preflight — lives in test/bun/install-cache-security-parse.test.ts.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import {
  installCacheRestoreCmd, INSTALL_CACHE_URL_ENV,
  INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER,
} from "../../src/studio/install-cache";

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
