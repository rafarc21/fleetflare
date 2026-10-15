// Board #350 — per-repo install cache, command/pure half. Unit tests for
// src/studio/install-cache.ts's pure gate/key/hash/discovery/slug helpers,
// the command-TEXT builders (restore/save shell one-liners), and the
// aws4fetch presign (pure SigV4 math, no network — see presignR2's own doc
// comment). vitest-pool-workers (workerd) has neither a filesystem nor
// child_process, so this file only asserts on the COMMAND TEXT (curl flags,
// staging/mv/member-filter/quoting present), never that the shell actually
// behaves that way — the real-shell proofs live in
// test/bun/install-cache-security-parse.test.ts (same "no filesystem in
// workerd" split this repo's own vitest.config.ts documents).

import { describe, it, expect } from "vitest";
import {
  parseInstallCacheRepos, isInstallCacheRepo, repoCheckoutDirName,
  installCacheKey, installCachePrefix, keysToPrune,
  WORKSPACE_LOCK_MARKERS, LOCKFILE_CANDIDATES, discoverCacheDirsCmd,
  normalizeCacheDir, parseCacheDirs, absoluteCacheDir, dirSlug,
  lockHashCmd, parseLockHash,
  nodeModulesPresentCmd, bunInstallRunningCmd, parseBunInstallRunning, INSTALL_ACTIVITY_WINDOW_SECONDS,
  installCacheRestoreCmd, installCacheSaveCmd, parseSaveOutcome, parseRestoreFailureReason,
  INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER,
  INSTALL_CACHE_URL_ENV, INSTALL_CACHE_MAX_BYTES,
  presignR2, R2_BUCKET_NAME_DEFAULT,
} from "../src/studio/install-cache";
// ---------------------------------------------------------------------------
// Repo gate
// ---------------------------------------------------------------------------

describe("parseInstallCacheRepos", () => {
  it("is empty when unset or blank", () => {
    expect(parseInstallCacheRepos(undefined)).toEqual([]);
    expect(parseInstallCacheRepos("")).toEqual([]);
    expect(parseInstallCacheRepos("   ")).toEqual([]);
  });

  it("splits, trims, lowercases a comma list", () => {
    expect(parseInstallCacheRepos("Example-Org/Websites, Some-Owner/Repo"))
      .toEqual(["example-org/websites", "some-owner/repo"]);
  });

  it("drops empty entries from stray commas", () => {
    expect(parseInstallCacheRepos("example-org/websites,,")).toEqual(["example-org/websites"]);
  });
});

describe("isInstallCacheRepo", () => {
  it("matches case-insensitively", () => {
    expect(isInstallCacheRepo("example-org/websites", "Example-Org/Websites")).toBe(true);
  });

  it("refuses a repo not in the list", () => {
    expect(isInstallCacheRepo("example-org/websites", "rafarc21/fleetflare")).toBe(false);
  });

  it("refuses everything when unset — the safe, opt-in default", () => {
    expect(isInstallCacheRepo(undefined, "example-org/websites")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round 2 review, smaller items — the dotted-repo-name checkout dir mismatch.
// ---------------------------------------------------------------------------

describe("repoCheckoutDirName", () => {
  it("passes an ordinary repo name through unchanged", () => {
    expect(repoCheckoutDirName("example-org/websites")).toBe("websites");
  });

  it("MUTANT PROOF — folds a DOTTED repo name the same way the clone target does (repo.ts's repoIdSegment), fixing the save-side/restore-side directory mismatch", () => {
    // Pre-fix, the save side computed `/workspace/example.app` (a raw
    // `.split("/").pop()`) while the real checkout — built by the SAME fold
    // provision.ts's clone target and studio id already use — lives at
    // `/workspace/example-app`. A save against the wrong directory always
    // found no node_modules and silently skipped forever.
    expect(repoCheckoutDirName("example-org/example.app")).toBe("example-app");
    expect(repoCheckoutDirName("example-org/example.app")).not.toBe("example.app");
  });

  it("folds underscores too, same as repoIdSegment", () => {
    expect(repoCheckoutDirName("acme/my_repo")).toBe("my-repo");
  });
});

// ---------------------------------------------------------------------------
// Key format + LRU prune
// ---------------------------------------------------------------------------

describe("installCacheKey / installCachePrefix", () => {
  it("renders caches/<owner>/<repo>/<dirSlug>/<lockHash>.tar.zst", () => {
    expect(installCacheKey("example-org/websites", "root-abc123", "a".repeat(64)))
      .toBe(`caches/example-org/websites/root-abc123/${"a".repeat(64)}.tar.zst`);
  });

  it("lowercases the repo slug (dirSlug/lockHash pass through verbatim — they're not user-facing repo names)", () => {
    expect(installCacheKey("Example-Org/Websites", "root-abc", "abc")).toBe("caches/example-org/websites/root-abc/abc.tar.zst");
  });

  it("prefix is the key's directory, matching what a listing over one cached directory needs", () => {
    const prefix = installCachePrefix("example-org/websites", "root-abc123");
    expect(prefix).toBe("caches/example-org/websites/root-abc123/");
    expect(installCacheKey("example-org/websites", "root-abc123", "abc").startsWith(prefix)).toBe(true);
  });

  it("two different dirSlugs never share a prefix, even for the same repo", () => {
    const a = installCachePrefix("example-org/websites", "site-a-111111111111");
    const b = installCachePrefix("example-org/websites", "site-b-222222222222");
    expect(a).not.toBe(b);
  });
});

describe("keysToPrune — LRU to the newest N", () => {
  const obj = (key: string, uploaded: string) => ({ key, uploaded: new Date(uploaded) });

  it("(c) keeps exactly the newest 2 by default, prunes the rest, whatever the input order", () => {
    const objects = [
      obj("a", "2026-09-20T00:00:00Z"),
      obj("b", "2026-09-24T00:00:00Z"), // newest
      obj("c", "2026-09-22T00:00:00Z"),
      obj("d", "2026-09-23T00:00:00Z"),
    ];
    expect(keysToPrune(objects).sort()).toEqual(["a", "c"].sort());
  });

  it("(c) never more, never fewer: exactly `keep` survive for varying counts", () => {
    expect(keysToPrune([obj("only", "2026-09-24T00:00:00Z")])).toEqual([]);
    expect(keysToPrune([obj("x", "2026-09-24T00:00:00Z"), obj("y", "2026-09-23T00:00:00Z")])).toEqual([]);
    expect(keysToPrune([])).toEqual([]);
  });

  it("(c) MUTANT PROOF — keep=1 (a stand-in for a guard that silently widened/narrowed the LRU depth) prunes everything but the single newest", () => {
    const objects = [obj("old", "2026-09-20T00:00:00Z"), obj("new", "2026-09-24T00:00:00Z")];
    expect(keysToPrune(objects, 1)).toEqual(["old"]);
  });

  // INSTALL_CACHE_KEEP_GENERATIONS's real behavior coverage: the "(c) keeps
  // exactly the newest 2 by default" test above already exercises the
  // DEFAULT (no override passed) against a hardcoded 4-object fixture —
  // would break if the constant's value ever drifted from 2.
});

// ---------------------------------------------------------------------------
// Directory discovery — round 2 review, item 1's main redesign.
// ---------------------------------------------------------------------------

describe("WORKSPACE_LOCK_MARKERS / discoverCacheDirsCmd", () => {
  it("looks for every mainstream lockfile shape, not just bun's own", () => {
    expect(WORKSPACE_LOCK_MARKERS).toEqual(
      expect.arrayContaining(["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]),
    );
    // Deliberately NOT a discovery marker — see its own doc comment for why
    // a bare package.json would over-discover a hoisted workspace monorepo.
    expect(WORKSPACE_LOCK_MARKERS).not.toContain("package.json");
  });

  it("prunes node_modules and .git from the walk, and cds into repoDir first", () => {
    const cmd = discoverCacheDirsCmd("/workspace/websites");
    // Round 3 review, item 5 — SECURITY: repoDir is single-quoted (shQuote),
    // never interpolated bare, so a directory name with a shell metacharacter
    // can never break out of the `cd`.
    expect(cmd).toContain("cd '/workspace/websites'");
    expect(cmd).toContain("-name node_modules");
    expect(cmd).toContain("-prune");
    expect(cmd).toContain("-name .git");
    for (const marker of WORKSPACE_LOCK_MARKERS) expect(cmd).toContain(marker);
    expect(cmd).toContain("sort -u");
  });
});

describe("normalizeCacheDir", () => {
  it("the checkout root (find's own '.') normalizes to the empty string", () => {
    expect(normalizeCacheDir(".")).toBe("");
    expect(normalizeCacheDir("")).toBe("");
  });

  it("strips a leading './' and any trailing slash", () => {
    expect(normalizeCacheDir("./apps/site-a")).toBe("apps/site-a");
    expect(normalizeCacheDir("./apps/site-a/")).toBe("apps/site-a");
  });
});

describe("parseCacheDirs", () => {
  it("parses find's own output shape: one relative dir per line, root as '.'", () => {
    const stdout = ".\n./site-a\n./site-b\n./site-c\n";
    expect(parseCacheDirs(stdout)).toEqual(["", "site-a", "site-b", "site-c"]);
  });

  it("dedupes and sorts, regardless of input order (two markers in one dir count once)", () => {
    const stdout = "./site-b\n./site-a\n./site-a\n";
    expect(parseCacheDirs(stdout)).toEqual(["site-a", "site-b"]);
  });

  it("empty stdout (nothing discovered at all) parses to an empty list, not a spurious root entry", () => {
    expect(parseCacheDirs("")).toEqual([]);
    expect(parseCacheDirs("\n\n")).toEqual([]);
  });

  it("root always sorts first when present", () => {
    expect(parseCacheDirs("./zzz\n.\n./aaa\n")).toEqual(["", "aaa", "zzz"]);
  });
});

describe("absoluteCacheDir", () => {
  it("the root ('') resolves to repoDir itself", () => {
    expect(absoluteCacheDir("/workspace/websites", "")).toBe("/workspace/websites");
  });

  it("a subdirectory resolves under repoDir", () => {
    expect(absoluteCacheDir("/workspace/websites", "apps/site-a")).toBe("/workspace/websites/apps/site-a");
  });
});

describe("dirSlug", () => {
  it("is deterministic — the same directory always produces the same slug", async () => {
    expect(await dirSlug("apps/site-a")).toBe(await dirSlug("apps/site-a"));
  });

  it("the root gets the readable prefix 'root'", async () => {
    expect(await dirSlug("")).toMatch(/^root-[0-9a-f]{12}$/);
  });

  it("a subdirectory gets a sanitized, readable prefix plus a hash suffix", async () => {
    expect(await dirSlug("apps/site-a")).toMatch(/^apps-site-a-[0-9a-f]{12}$/);
  });

  it("MUTANT PROOF — collision-safety: two different paths that a naive '/'->'-' replace would collide never produce the same slug", async () => {
    // A naive scheme would render both "apps/site-a" and "apps-site-a" (a
    // real, if unusual, sibling directory name) as the literal string
    // "apps-site-a" — indistinguishable, and thus a genuine cache-key
    // collision (two unrelated directories restoring each other's
    // node_modules). The hash suffix, over the FULL un-flattened path,
    // keeps them apart.
    const a = await dirSlug("apps/site-a");
    const b = await dirSlug("apps-site-a");
    expect(a).not.toBe(b);
  });

  it("normalizes before hashing — a trailing slash or leading './' does not change the slug", async () => {
    expect(await dirSlug("./apps/site-a/")).toBe(await dirSlug("apps/site-a"));
  });

  it("is filesystem/URL safe: only lowercase letters, digits and hyphens", async () => {
    const slug = await dirSlug("Apps/Site A!!");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });
});

// ---------------------------------------------------------------------------
// Lockfile hash
// ---------------------------------------------------------------------------

describe("lockHashCmd / parseLockHash", () => {
  it("hashes every LOCKFILE_CANDIDATES entry, guarded against absence", () => {
    const cmd = lockHashCmd("/workspace/websites/site-a");
    expect(cmd).toContain("cd '/workspace/websites/site-a'");
    for (const f of LOCKFILE_CANDIDATES) expect(cmd).toContain(f);
    expect(cmd).toContain("[ -f");
    expect(cmd).toContain("sha256sum");
  });

  it("LOCKFILE_CANDIDATES is WORKSPACE_LOCK_MARKERS plus package.json", () => {
    expect(LOCKFILE_CANDIDATES).toEqual([...WORKSPACE_LOCK_MARKERS, "package.json"]);
  });

  it("parses a clean 64-hex sha256 line", () => {
    const hash = "a".repeat(64);
    expect(parseLockHash(`${hash}\n`)).toBe(hash);
    expect(parseLockHash(`${hash}  -\n`)).toBeNull(); // sha256sum's real output includes a filename; only the bare form parses
  });

  it("refuses anything that isn't exactly 64 lowercase hex chars", () => {
    expect(parseLockHash("")).toBeNull();
    expect(parseLockHash("not-a-hash")).toBeNull();
    expect(parseLockHash("A".repeat(64))).toBeNull(); // uppercase refused — sha256sum never emits it
    expect(parseLockHash("a".repeat(63))).toBeNull();
  });

  // Round 2 review, item 1(c) — kept from the prior fix commit. This test
  // file runs under vitest-pool-workers (workerd), which has no real
  // filesystem or child_process — it cannot spawn `bash` itself. So the
  // "real shell output" this proof is built from was captured OUTSIDE this
  // test, by literally running the OLD pipeline's own text against a real
  // empty directory. See git history (6072de7) for the exact command run.
  const REAL_CAPTURED_EMPTY_INPUT_STDOUT =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n";

  it("MUTANT PROOF — parseLockHash refuses the REAL stdout an empty-candidate directory's old pipeline genuinely produced (not a hand-typed \"\")", () => {
    expect(parseLockHash(REAL_CAPTURED_EMPTY_INPUT_STDOUT)).toBeNull();
  });

  it("lockHashCmd's OWN fix: the new command's shape never even reaches sha256sum when nothing was found", () => {
    const cmd = lockHashCmd("/workspace/websites");
    expect(cmd).toMatch(/\[ -f "\$f" \]/);
    expect(cmd).toContain('if [ -z "$present" ]');
  });
});

// ---------------------------------------------------------------------------
// Restore-side / save-side guards
// ---------------------------------------------------------------------------

describe("nodeModulesPresentCmd", () => {
  it("answers yes/no on the exact same shape as provision.ts's CONTAINER_HAS_PROJECTS_CMD", () => {
    const cmd = nodeModulesPresentCmd("/workspace/websites/site-a");
    expect(cmd).toBe("[ -d '/workspace/websites/site-a'/node_modules ] && echo yes || echo no");
  });

  it("SECURITY (round 3 review, item 5) — quotes the directory: a metacharacter in `dir` never breaks out of the `[ -d ... ]` test", () => {
    const cmd = nodeModulesPresentCmd("x$(touch /tmp/pwned-inject)y");
    expect(cmd).toBe("[ -d 'x$(touch /tmp/pwned-inject)y'/node_modules ] && echo yes || echo no");
  });
});

describe("bunInstallRunningCmd / parseBunInstallRunning", () => {
  // Round 3 review, item 2: argv/`/proc` matching missed `bun i`, `npm ci`, a
  // bare `yarn`, and `bun install --cwd <dir>` run from elsewhere — none of
  // those spell "install" in a way a regex can generically catch, and the
  // LAST one defeats cwd-matching entirely (the installing process's real
  // cwd is wherever it was launched from, not `dir`). Replaced with a
  // package-manager-AGNOSTIC filesystem signal instead: recent write activity
  // under node_modules.
  //
  // Round 4 review, item 2: the OTHER half of that replacement — "a real
  // lockfile newer than node_modules" — was itself permanently, falsely true
  // after any normal, completed install, so the guard reported "still
  // running" forever. Fixed (that round) by replacing THAT half with a
  // live-PROCESS check instead.
  //
  // Round 5 review, item 1 — round 4's own live-process check is now judged
  // OVER-BROAD: it caught ANY live bun/node/npm/npx/yarn/pnpm process with a
  // matching cwd/argv, not just an actual in-progress install — a long-lived
  // dev server or an MCP server started via `bun x` from the repo root (real
  // on fleetflare--web-studio) matches identically, so a repo with a root
  // lockfile whose studio also runs one of those never saves its install
  // cache at all. The process scan is REMOVED entirely (no more `/proc`
  // scanning, no more package-manager-binary matching) in favor of a
  // COMPLETION MARKER (`node_modules/.fleet-install-complete`) written by a
  // NEW PostToolUse hook (gates/install-marker.sh) right after a real
  // install command finishes — see that file's own header for exactly how
  // and why a hook, not fleet's own code, is what writes it. This function
  // now asks a purely filesystem-shaped question: does that marker exist,
  // and is it NEWER than every lockfile in the directory (not stale)? See
  // this function's own doc comment (install-cache.ts) for the full
  // reasoning, and test/bun/install-cache-security-parse.test.ts's own
  // `bunInstallRunningCmd` section for real-filesystem proof this file
  // (vitest-pool-workers, no filesystem/child_process) cannot give.
  it("scopes the check to the ONE directory given (cd's into it), and checks for the completion marker rather than scanning /proc", () => {
    const cmd = bunInstallRunningCmd("/workspace/websites/site-a");
    expect(cmd).toContain("cd '/workspace/websites/site-a'");
    expect(cmd).toContain(".fleet-install-complete");
  });

  it("checks for recent write activity under node_modules (mtime-based) — UNCHANGED by round 5 review, item 1", () => {
    const cmd = bunInstallRunningCmd("/workspace/websites");
    expect(cmd).toContain("find node_modules -newermt");
    expect(cmd).toContain(`-${INSTALL_ACTIVITY_WINDOW_SECONDS} seconds`);
  });

  it("checks the marker against every real lockfile marker, never node_modules' own mtime alone (round 4's own permanently-stuck bug must not resurface)", () => {
    const cmd = bunInstallRunningCmd("/workspace/websites");
    for (const marker of WORKSPACE_LOCK_MARKERS) expect(cmd).toContain(marker);
    expect(cmd).toContain("-nt node_modules/.fleet-install-complete");
  });

  it("round 5 review, item 1 — no /proc scan, no package-manager-binary matching, no argv/cwd reading of any kind: the over-broad live-process signal is GONE, not merely narrowed", () => {
    const cmd = bunInstallRunningCmd("/workspace/websites");
    expect(cmd).not.toContain("/proc");
    expect(cmd).not.toContain("cmdline");
    expect(cmd).not.toContain("readlink");
    // The old case-statement's own comm-name list, joined with "|" — checked
    // as that exact pattern (not a bare substring search for e.g. "bun",
    // which would also — correctly — match the STILL-PRESENT lockfile marker
    // name "bun.lock").
    expect(cmd).not.toContain("bun|node|npm|npx|yarn|pnpm");
    expect(cmd).not.toContain("live=");
    expect(cmd).not.toContain("target=");
  });

  it("always echoes a final yes/no — never leaves the guard unresolved", () => {
    const cmd = bunInstallRunningCmd("/workspace/websites");
    expect(cmd).toMatch(/echo (yes|no); fi\)$/);
  });

  it("SECURITY — quotes the directory: a metacharacter in `dir` never breaks out of the `cd`", () => {
    const cmd = bunInstallRunningCmd("x$(touch /tmp/pwned-inject)y");
    expect(cmd).toContain("cd 'x$(touch /tmp/pwned-inject)y'");
  });

  it("parseBunInstallRunning recognizes only the exact 'yes'", () => {
    expect(parseBunInstallRunning("yes\n")).toBe(true);
    expect(parseBunInstallRunning("no\n")).toBe(false);
    expect(parseBunInstallRunning("")).toBe(false);
    expect(parseBunInstallRunning("yesish")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transport commands — command-TEXT assertions only. The real shell
// behaviour (staging dir, member-filtered extraction, path-traversal
// rejection, exit-code propagation) is proven against a real bash/tar/zstd
// in test/bun/install-cache-security-parse.test.ts, which vitest-pool-workers
// cannot run itself (no filesystem, no child_process).
// ---------------------------------------------------------------------------

describe("installCacheRestoreCmd", () => {
  const cmd = installCacheRestoreCmd("/workspace/websites/site-a");

  it("reads the URL from the env var, never the command string", () => {
    expect(cmd).toContain(`"$${INSTALL_CACHE_URL_ENV}"`);
    expect(cmd).not.toMatch(/https?:\/\//);
  });

  it("item 2 — atomicity: pipefail, a materialized download (never a bare pipe into tar), a staging dir, and an atomic mv into place", () => {
    expect(cmd).toContain("set -o pipefail");
    expect(cmd).toContain("mktemp -d");
    expect(cmd).toContain("-o \"$work/dl.tar.zst\"");
    expect(cmd).toContain("mkdir -p \"$work/stage\"");
    expect(cmd).toContain("mv \"$work/stage/node_modules\"");
  });

  it("item 4 — SECURITY: lists with --absolute-names for its OWN path validation, rejects '..'/absolute members (and, issue #395, outward symlink targets), and filters extraction to node_modules only", () => {
    expect(cmd).toContain("tar --absolute-names -tvf -");
    expect(cmd).toContain('nparts[i]==".."');
    expect(cmd).toContain("symlinkHit=$(awk");
    expect(cmd).toMatch(/tar -x -C "\$work\/stage" -f - node_modules/);
  });

  // ---------------------------------------------------------------------------
  // Round 6 review, item 3 — SECURITY/SPACE: the pre-round-6 pipeline wrote
  // the WHOLE decompressed archive to a real `$work/dl.tar` file before ever
  // listing or extracting it — needing that full decompressed copy AND the
  // extracted `stage/node_modules` copy to coexist on disk at once, on top of
  // the original compressed download. Fixed by decompressing via a STREAMED
  // pipe directly into tar, twice: once into `tar -tf -` for the listing pass
  // (the traversal-guard's own security check, which must still run BEFORE
  // any extraction), once into `tar -x -f -` for the real extraction — never
  // materializing a full decompressed `.tar` file on disk at either stage.
  // See test/bun/install-cache-security-disk.test.ts for the REAL bash-exec proof
  // that both the traversal guard AND the disk-space saving actually hold —
  // this file only pins the command TEXT (no filesystem in workerd).
  // ---------------------------------------------------------------------------
  it("item 3 (round 6 review) — SECURITY/SPACE: never materializes a full decompressed .tar on disk — decompresses via a streamed pipe, once for the listing (name + symlink-target check folded together), once for extraction, in that order", () => {
    expect(cmd).not.toMatch(/zstd -dc "\$work\/dl\.tar\.zst" > "\$work\/dl\.tar"/);
    expect(cmd).not.toContain('"$work/dl.tar"');
    const zstdPipeCount = (cmd.match(/zstd -dc "\$work\/dl\.tar\.zst"/g) ?? []).length;
    // Issue #395 review round 2: the symlink-target check folded INTO this
    // one `-tvf` listing pass (no separate `-tf` pass, no third
    // decompression of a potentially 0.5-1.1 GiB archive) — back to 2.
    expect(zstdPipeCount).toBe(2);
    const listingAt = cmd.indexOf("tar --absolute-names -tvf -");
    const symlinkCheckAt = cmd.indexOf("symlinkHit=$(awk");
    const extractAt = cmd.indexOf('tar -x -C "$work/stage" -f -');
    expect(listingAt).toBeGreaterThan(-1);
    expect(symlinkCheckAt).toBeGreaterThan(listingAt);
    expect(extractAt).toBeGreaterThan(symlinkCheckAt);
  });

  it("item 3 (round 6 review) — DEFENSE IN DEPTH: a 'No space left on device' error from either streamed stage is classified restore-failed:local, distinct from a genuine archive-corruption failure", () => {
    expect(cmd.toLowerCase()).toContain("no space left on device");
    // Preflight + listing-stage + extraction-stage: three independent places
    // this exact marker can now be emitted from.
    expect((cmd.match(/restore-failed:local/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("smaller items — connect-timeout and speed-limit/speed-time, distinct from --max-time alone", () => {
    expect(cmd).toContain("--connect-timeout 30");
    expect(cmd).toContain("--speed-limit 1024");
    expect(cmd).toContain("--speed-time 60");
    expect(cmd).toContain("--max-time 600");
  });

  it("never extracts directly into the target directory — 'tar -x -C <dir>' (no staging) never appears", () => {
    expect(cmd).not.toMatch(/tar -x -C \/workspace\/websites\/site-a\b/);
  });

  it("SECURITY (round 3 review, item 5) — quotes the directory at every interpolation site (mkdir/rm/mv)", () => {
    const evil = installCacheRestoreCmd("x$(touch /tmp/pwned-inject)y");
    expect(evil).toContain("mkdir -p 'x$(touch /tmp/pwned-inject)y'");
    expect(evil).toContain("rm -rf 'x$(touch /tmp/pwned-inject)y'/node_modules");
    expect(evil).toContain('mv "$work/stage/node_modules" \'x$(touch /tmp/pwned-inject)y\'/node_modules');
  });

  // ---------------------------------------------------------------------------
  // Round 5 review, item 4 — a local out-of-disk-space failure must not be
  // mislabeled as archive corruption (which tombstones a perfectly good
  // remote object for every OTHER studio). A disk-space precheck runs BEFORE
  // the risky zstd/tar writes, using the DOWNLOADED archive's own size (never
  // pulled back to the Worker — computed with `stat` on the already-
  // materialized `$work/dl.tar.zst`) against `df`'s own reported available
  // space on the SAME filesystem `$work` lives on. See
  // test/bun/install-cache-security-parse.test.ts for the REAL bash-exec proof that
  // this check actually fires (and never tombstones) — this file only pins
  // the command TEXT (no filesystem in workerd — this file's own header).
  // ---------------------------------------------------------------------------
  it("item 4 (round 5 review) — checks available disk space against the downloaded archive's own size BEFORE the zstd/tar stages, emitting the new restore-failed:local marker", () => {
    expect(cmd).toContain("restore-failed:local");
    expect(cmd).toContain("df -Pk");
    expect(cmd).toContain(`dl_size * ${INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER}`);
    // The check runs after the download materializes and before the FIRST
    // risky write (zstd -dc) — never after it, which would defeat the whole
    // point of a PRE-check.
    const diskCheckAt = cmd.indexOf("restore-failed:local");
    const downloadAt = cmd.indexOf('-o "$work/dl.tar.zst"');
    const zstdAt = cmd.indexOf("zstd -dc");
    expect(downloadAt).toBeGreaterThan(-1);
    expect(diskCheckAt).toBeGreaterThan(downloadAt);
    expect(diskCheckAt).toBeLessThan(zstdAt);
  });
});

describe("parseRestoreFailureReason", () => {
  it("categorizes an archive-stage failure as archive (tombstone-eligible)", () => {
    expect(parseRestoreFailureReason("restore-failed:archive\n")).toBe("archive");
  });

  it("categorizes a transfer/precondition failure as transfer (never tombstoned)", () => {
    expect(parseRestoreFailureReason("restore-failed:transfer\n")).toBe("transfer");
    expect(parseRestoreFailureReason("restore-failed:precondition\n")).toBe("transfer");
  });

  it("item 4 (round 5 review) — categorizes a local disk-space failure as its OWN reason, distinct from archive, never tombstone-eligible", () => {
    expect(parseRestoreFailureReason("restore-failed:local\n")).toBe("local");
    expect(parseRestoreFailureReason("restore-failed:local\n")).not.toBe("archive");
  });

  it("falls back to unknown for anything unrecognized (a killed exec, no marker at all)", () => {
    expect(parseRestoreFailureReason("")).toBe("unknown");
    expect(parseRestoreFailureReason("some garbage stdout\n")).toBe("unknown");
  });
});

describe("installCacheSaveCmd / parseSaveOutcome", () => {
  it("guards on an absent node_modules — skip:no-node_modules, no tar/curl attempted", () => {
    const cmd = installCacheSaveCmd("/workspace/websites/site-a");
    expect(cmd).toContain("[ ! -d '/workspace/websites/site-a'/node_modules ]");
    expect(cmd).toContain("skip:no-node_modules");
  });

  it("SECURITY (round 3 review, item 5) — quotes the directory in every interpolation site", () => {
    const cmd = installCacheSaveCmd("x$(touch /tmp/pwned-inject)y");
    expect(cmd).toContain("[ ! -d 'x$(touch /tmp/pwned-inject)y'/node_modules ]");
    expect(cmd).toContain("tar -C 'x$(touch /tmp/pwned-inject)y' -c node_modules");
  });

  it("item 3 — a unique tmp filename (mktemp, not a fixed path)", () => {
    const cmd = installCacheSaveCmd("/workspace/websites");
    expect(cmd).toContain("mktemp /tmp/.install-cache-upload.XXXXXX");
    expect(cmd).not.toContain("/tmp/.install-cache-upload.tar.zst");
  });

  it("item 3 — every stage's exit code is checked (pipefail'd tar|zstd, then archive integrity verified before upload)", () => {
    const cmd = installCacheSaveCmd("/workspace/websites");
    expect(cmd).toContain("set -o pipefail");
    expect(cmd).toContain("if tar -C '/workspace/websites' -c node_modules");
    expect(cmd).toContain("zstd -t \"$tmp\"");
    expect(cmd).toContain("tar -tf -");
    expect(cmd).toContain("skip:corrupt-archive");
    expect(cmd).toContain("skip:tar-or-compress-failed");
  });

  it("enforces the byte cap BEFORE the PUT, and always cleans up the temp file", () => {
    const cmd = installCacheSaveCmd("/workspace/websites", 100);
    expect(cmd).toContain("-gt 100");
    expect(cmd).toContain("skip:oversize");
    expect(cmd).toContain("rm -f");
    expect(cmd).not.toMatch(/https?:\/\//);
  });

  it("default cap is 1.5 GiB", () => {
    expect(INSTALL_CACHE_MAX_BYTES).toBe(1_610_612_736);
  });

  it("smaller items — connect-timeout and speed-limit/speed-time on the PUT too", () => {
    const cmd = installCacheSaveCmd("/workspace/websites");
    expect(cmd).toContain("--connect-timeout 30");
    expect(cmd).toContain("--speed-limit 1024");
    expect(cmd).toContain("--speed-time 60");
    expect(cmd).toContain("--max-time 900");
  });

  it("parseSaveOutcome recognizes a genuine save vs every guarded skip", () => {
    expect(parseSaveOutcome("saved:12345\n")).toEqual({ saved: true, reason: "saved:12345" });
    expect(parseSaveOutcome("skip:no-node_modules\n")).toEqual({ saved: false, reason: "skip:no-node_modules" });
    expect(parseSaveOutcome("skip:empty\n")).toEqual({ saved: false, reason: "skip:empty" });
    expect(parseSaveOutcome("skip:oversize:99999\n")).toEqual({ saved: false, reason: "skip:oversize:99999" });
    expect(parseSaveOutcome("skip:corrupt-archive\n")).toEqual({ saved: false, reason: "skip:corrupt-archive" });
    expect(parseSaveOutcome("")).toEqual({ saved: false, reason: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// presignR2 — pure SigV4 math, no network, no fetch mock needed
// ---------------------------------------------------------------------------

describe("presignR2", () => {
  const FAKE_ENV = { R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "AKIAFAKE", R2_SECRET_ACCESS_KEY: "fakesecret" };

  it("returns null when any of the three secrets is missing — the safe pre-provisioning default", async () => {
    expect(await presignR2({}, "caches/x/y/z/z.tar.zst", "GET")).toBeNull();
    expect(await presignR2({ R2_ACCOUNT_ID: "a" }, "k", "GET")).toBeNull();
    expect(await presignR2({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b" }, "k", "GET")).toBeNull();
  });

  it("mints a signed URL against the R2 S3 endpoint, for the requested bucket/key/method", async () => {
    const url = await presignR2(FAKE_ENV, "caches/example-org/websites/root-abc/abc123.tar.zst", "GET");
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.hostname).toBe("acct123.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe(`/${R2_BUCKET_NAME_DEFAULT}/caches/example-org/websites/root-abc/abc123.tar.zst`);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("1800");
    expect(parsed.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(parsed.searchParams.get("X-Amz-Credential")).toContain("AKIAFAKE");
  });

  it("issue #335 — env.R2_BUCKET_NAME overrides the neutral default when set", async () => {
    const url = await presignR2({ ...FAKE_ENV, R2_BUCKET_NAME: "acme-studio-archive" }, "caches/x/y/z.tar.zst", "GET");
    expect(url).not.toBeNull();
    expect(new URL(url!).pathname).toBe("/acme-studio-archive/caches/x/y/z.tar.zst");
  });

  it("a GET and a PUT presign of the same key produce different signatures (method is part of what's signed)", async () => {
    const get = await presignR2(FAKE_ENV, "caches/x/y/z/z.tar.zst", "GET");
    const put = await presignR2(FAKE_ENV, "caches/x/y/z/z.tar.zst", "PUT");
    expect(new URL(get!).searchParams.get("X-Amz-Signature")).not.toBe(new URL(put!).searchParams.get("X-Amz-Signature"));
  });

  it("honors a custom TTL", async () => {
    const url = await presignR2(FAKE_ENV, "k", "GET", 60);
    expect(new URL(url!).searchParams.get("X-Amz-Expires")).toBe("60");
  });
});
