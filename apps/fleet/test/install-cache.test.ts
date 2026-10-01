// Board #350 — per-repo install cache. Unit tests for src/studio/
// install-cache.ts: pure gate/key/hash/discovery/slug logic, the aws4fetch
// presign (pure SigV4 math, no network — see presignR2's own doc comment),
// and both orchestration functions (runInstallCacheRestore,
// runInstallCacheSaveTick) against fake sbExec/R2 ports, the same
// hand-rolled-fake convention test/studio.provision.test.ts and
// test/github.auth.test.ts already use.
//
// Round 2 review's own redesign (item 1): a single repo can now cache
// SEVERAL independent directories (example-org/websites' own eight sites,
// none at the checkout root), so runInstallCacheRestore/runInstallCacheSaveTick
// return a `dirs` array, one entry per discovered directory, rather than one
// flat outcome. The shell-level extraction/upload SAFETY guarantees
// (staging dir, member-filtered extraction, path-traversal rejection) need a
// REAL shell (`curl`/`zstd`/`tar`) to prove — vitest-pool-workers (workerd)
// has neither a filesystem nor child_process, so those live in
// test/bun/install-cache-security.test.ts instead (the same "no filesystem
// in workerd" split this repo's own vitest.config.ts documents for
// container/server.ts and studio-bringup.sh). This file only asserts on the
// COMMAND TEXT for those (curl flags present, staging/mv/member-filter
// present), never that the shell actually behaves that way.
//
// Explicit mutant proofs (this file's own + round 2's four extra), each its
// own assertion pinned against a SPECIFIC guard so that guard's removal is
// what turns it red — see each proof's own comment for exactly which line:
//   (a) restoring over an EXISTING node_modules must be provably refused.
//   (b) a repo NOT in the gate must provably make zero R2/network calls.
//   (c) the LRU prune must keep exactly the newest 2 keys, never more, never
//       fewer.
//   (d) SECURITY — extraction scope: test/bun/install-cache-security.test.ts.
//   (e) the SAVE key is built from the directory actually being saved, never
//       another directory's.
//   (f) a restore exec that THROWS is caught and reported, never propagated.
//   (g) the r2Head short-circuit is not trusted forever — a bad object is
//       eventually replaceable.
import { describe, it, expect, vi } from "vitest";
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
  runInstallCacheRestore, type InstallCacheRestoreDeps, INSTALL_CACHE_RESTORE_BUDGET_MS,
  runInstallCacheSaveTick, type InstallCacheSaveDeps, type InstallCacheSaveStorage,
  installCacheHashKey, installCacheReverifyKey, INSTALL_CACHE_REVERIFY_EVERY,
  installCacheFailureKey, parseInstallCacheFailure, installCacheFailureBackoffMs,
  installCacheFailureBackoffActive, INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS, INSTALL_CACHE_FAILURE_BACKOFF_MAX_MS,
  installCacheSaveLeaseFresh, INSTALL_CACHE_SAVE_LEASE_KEY, INSTALL_CACHE_SAVE_LEASE_STALE_MS,
} from "../src/studio/install-cache";
import {
  runProvision, restartWithStorage, BRINGUP_CMD, STATUS_KEY, ROLE_ENV_KEY,
  type ProvisionDeps, type StudioStorage, type RoleEnv,
} from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";

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
  // reasoning, and test/bun/install-cache-security.test.ts's own
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
// in test/bun/install-cache-security.test.ts, which vitest-pool-workers
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
  // See test/bun/install-cache-security.test.ts for the REAL bash-exec proof
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
  // test/bun/install-cache-security.test.ts for the REAL bash-exec proof that
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

// ---------------------------------------------------------------------------
// runInstallCacheRestore — orchestration, now per-directory
// ---------------------------------------------------------------------------

/** `discoverStdout` defaults to a single root directory (`.`) — the
 *  pre-redesign, single-lockfile-at-root shape every repo except
 *  example-org/websites has, so every existing single-dir test keeps
 *  asserting on `result.dirs[0]` without needing to know about discovery at
 *  all. Pass a multi-line stdout to exercise the multi-directory path. */
function fakeRestoreDeps(opts: {
  enabled?: boolean; presign?: string | null; nodeModulesPresent?: boolean;
  lockHashStdout?: string; restoreCode?: number; discoverStdout?: string;
} = {}): { deps: InstallCacheRestoreDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: InstallCacheRestoreDeps = {
    sbExec: async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("find .")) return { code: 0, stdout: opts.discoverStdout ?? ".\n", stderr: "" };
      if (cmd.includes("echo yes || echo no")) {
        return { code: 0, stdout: opts.nodeModulesPresent ? "yes" : "no", stderr: "" };
      }
      if (cmd.includes("sha256sum")) {
        return { code: 0, stdout: opts.lockHashStdout ?? "b".repeat(64), stderr: "" };
      }
      return { code: opts.restoreCode ?? 0, stdout: "", stderr: opts.restoreCode ? "boom" : "" };
    },
    installCacheEnabled: opts.enabled === undefined ? () => true : () => opts.enabled!,
    installCachePresignGet: async () => (opts.presign === undefined ? "https://example.r2.cloudflarestorage.com/x" : opts.presign),
  };
  return { deps, calls };
}

describe("runInstallCacheRestore", () => {
  it("not-configured when either port is absent — zero execs, including discovery", async () => {
    const calls: string[] = [];
    const sbExec = async (cmd: string) => { calls.push(cmd); return { code: 0, stdout: "no", stderr: "" }; };
    const result = await runInstallCacheRestore({ sbExec }, "id", "example-org/websites", "/workspace/websites");
    expect(result).toEqual({ attempted: false, outcome: "not-configured", dirs: [] });
    expect(calls).toEqual([]);
  });

  it("(b) MUTANT PROOF — a repo not in the gate makes ZERO sbExec calls, including discovery", async () => {
    const { deps, calls } = fakeRestoreDeps({ enabled: false });
    const result = await runInstallCacheRestore(deps, "id", "rafarc21/fleetflare", "/workspace/fleetflare");
    expect(result).toEqual({ attempted: false, outcome: "gate:off", dirs: [] });
    expect(calls).toEqual([]); // removing the gate check would make this call sbExec at least once
  });

  it("(a) MUTANT PROOF — an EXISTING node_modules is never restored over", async () => {
    const { deps, calls } = fakeRestoreDeps({ nodeModulesPresent: true });
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.attempted).toBe(false);
    expect(result.dirs).toHaveLength(1);
    expect(result.dirs[0].outcome).toBe("skip:node_modules-present");
    // Discovery, then only the presence check itself ran — no lockHash, no
    // presign, no restore exec.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("node_modules");
  });

  it("skips when the checkout has no cache-worthy directory at all (discovery finds nothing)", async () => {
    const { deps } = fakeRestoreDeps({ discoverStdout: "" });
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result).toEqual({ attempted: false, outcome: "skip:no-lockfile", dirs: [] });
  });

  it("skips when the lockfile hash can't be computed for a discovered directory", async () => {
    const { deps } = fakeRestoreDeps({ lockHashStdout: "" });
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs[0].outcome).toBe("skip:no-lockfile");
  });

  it("skips when no cached object exists for this lockHash — first-ever install, mixed-fleet-safe requirement 2", async () => {
    const { deps } = fakeRestoreDeps({ presign: null });
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs[0].outcome).toBe("skip:no-object");
  });

  it("skips (never throws, never degrades) when the transfer itself fails — mixed-fleet-safe requirement 3", async () => {
    const { deps } = fakeRestoreDeps({ restoreCode: 1 });
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:restore-failed" });
  });

  it("restores on the happy path, and passes the presigned URL via env, not the command string", async () => {
    const envSeen: (Record<string, string> | undefined)[] = [];
    const deps: InstallCacheRestoreDeps = {
      sbExec: async (cmd: string, execEnv?: Record<string, string>) => {
        envSeen.push(execEnv);
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("echo yes || echo no")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "c".repeat(64), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      installCacheEnabled: () => true,
      installCachePresignGet: async (key: string) => {
        const slug = await dirSlug("");
        expect(key).toBe(`caches/example-org/websites/${slug}/${"c".repeat(64)}.tar.zst`);
        return "https://signed.example/url";
      },
    };
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.attempted).toBe(true);
    expect(result.dirs[0].outcome).toBe("restored");
    const restoreEnv = envSeen.at(-1);
    expect(restoreEnv?.[INSTALL_CACHE_URL_ENV]).toBe("https://signed.example/url");
  });

  it("MULTI-DIRECTORY (item 1) — restores each discovered directory independently, one outcome per directory", async () => {
    const { deps } = fakeRestoreDeps({
      discoverStdout: "./site-a\n./site-b\n",
      nodeModulesPresent: false,
    });
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs.map((d) => d.relDir)).toEqual(["site-a", "site-b"]);
    expect(result.dirs.every((d) => d.outcome === "restored")).toBe(true);
    expect(result.outcome).toContain("site-a:restored");
    expect(result.outcome).toContain("site-b:restored");
  });

  it("(e) MUTANT PROOF — restoring site-a never presigns/restores using site-b's directory identity", async () => {
    const presignedKeys: string[] = [];
    const restoredDirs: string[] = [];
    const deps: InstallCacheRestoreDeps = {
      sbExec: async (cmd: string, execEnv?: Record<string, string>) => {
        if (cmd.includes("find .")) return { code: 0, stdout: "./site-a\n./site-b\n", stderr: "" };
        if (cmd.includes("echo yes || echo no")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "d".repeat(64), stderr: "" };
        if (cmd.includes("mktemp -d")) {
          // installCacheRestoreCmd is built with the per-directory absolute
          // path baked into its own text (mkdir -p <dir>, rm -rf <dir>/node_modules) —
          // capture which directory this restore call actually targeted.
          // Round 3 review, item 5: the value is now single-quoted (SECURITY
          // — see shQuote's own doc comment), so the capture strips the quotes.
          // Round 4 review, item 1: `mkdir -p` now `||`-guards its own
          // failure with a stage marker rather than a bare `&&` chain.
          const m = cmd.match(/mkdir -p '([^']+)' \|\|/);
          if (m) restoredDirs.push(m[1]);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      installCacheEnabled: () => true,
      installCachePresignGet: async (key: string) => { presignedKeys.push(key); return "https://signed.example/url"; },
    };
    await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    const slugA = await dirSlug("site-a");
    const slugB = await dirSlug("site-b");
    expect(presignedKeys).toEqual([
      `caches/example-org/websites/${slugA}/${"d".repeat(64)}.tar.zst`,
      `caches/example-org/websites/${slugB}/${"d".repeat(64)}.tar.zst`,
    ]);
    expect(restoredDirs).toEqual(["/workspace/websites/site-a", "/workspace/websites/site-b"]);
  });

  it("(f) MUTANT PROOF — a directory's own sbExec THROWING is caught and reported, not propagated, and does not stop sibling directories", async () => {
    let calls = 0;
    const deps: InstallCacheRestoreDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: "./site-a\n./site-b\n", stderr: "" };
        calls += 1;
        if (cmd.includes("echo yes || echo no") && cmd.includes("site-a")) throw new Error("sandbox connection dropped");
        if (cmd.includes("echo yes || echo no")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "e".repeat(64), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      installCacheEnabled: () => true,
      installCachePresignGet: async () => "https://signed.example/url",
    };
    // Must not throw / reject out of this call.
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs.find((d) => d.relDir === "site-a")).toMatchObject({ attempted: false, outcome: "skip:restore-failed" });
    expect(result.dirs.find((d) => d.relDir === "site-b")).toMatchObject({ outcome: "restored" });
  });

  // ---------------------------------------------------------------------------
  // Round 4 review, item 5(c) — restore wall-clock budget. A monorepo with
  // several directories restores them sequentially in one call; without a
  // budget, a slow enough sequence could run past provision.ts's own
  // OPERATION_STALE_MS (15 minutes) before the rest of provision/restart ever
  // gets its turn.
  // ---------------------------------------------------------------------------

  it("item 5(c) (round 4 review) — once the wall-clock budget is exceeded, remaining directories are skipped with skip:restore-budget-exceeded instead of being attempted", async () => {
    let now = new Date("2026-09-25T00:00:00.000Z");
    const deps: InstallCacheRestoreDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: "./site-a\n./site-b\n./site-c\n", stderr: "" };
        if (cmd.includes("echo yes || echo no")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "a".repeat(64), stderr: "" };
        // The restore transfer itself — simulate the FIRST directory's own
        // restore taking so long that the budget is exhausted by the time it
        // returns, exactly the "9 * 600s curl legs" worst case this budget
        // guards against.
        now = new Date(now.getTime() + INSTALL_CACHE_RESTORE_BUDGET_MS + 1000);
        return { code: 0, stdout: "", stderr: "" };
      },
      installCacheEnabled: () => true,
      installCachePresignGet: async () => "https://signed.example/url",
      installCacheRestoreNow: () => now,
    };
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs.map((d) => d.relDir)).toEqual(["site-a", "site-b", "site-c"]);
    expect(result.dirs[0].outcome).toBe("restored"); // budget not yet exceeded when THIS one started
    expect(result.dirs[1]).toMatchObject({ attempted: false, outcome: "skip:restore-budget-exceeded" });
    expect(result.dirs[2]).toMatchObject({ attempted: false, outcome: "skip:restore-budget-exceeded" });
  });

  it("item 5(c) (round 4 review) — with no clock wired at all (installCacheRestoreNow absent), no budget is enforced: every directory is still attempted, the pre-existing behaviour every caller/test built before this task keeps", async () => {
    const { deps } = fakeRestoreDeps({ discoverStdout: "./site-a\n./site-b\n" });
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs.every((d) => d.outcome === "restored")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Round 5 review, item 3 (SUPERSEDED — see round 6 review, item 2 below):
  // the maestro's own measured overshoot was that round 4's budget check
  // compared elapsed time against the budget ONLY before a directory starts,
  // while each directory's own curl leg could independently run up to a
  // further 600s (installCacheRestoreCmd's own flat `--max-time 600`)
  // regardless of how little budget remained. Round 5's own fix added a
  // "worst-case lookahead" pre-start check (INSTALL_CACHE_RESTORE_DIR_WORST_CASE_MS,
  // now deleted): refuse to START a directory unless `elapsed + 600s` still
  // fit inside the budget. That fix was itself broken: with the lookahead
  // constant EQUAL to the budget itself (both 600,000ms), `elapsed + 600000 >
  // 600000` is true for ANY elapsed > 0 — so only the very FIRST directory in
  // a tick could ever start at all. A `example-org/websites`-shaped restore (9
  // directories) restored at most 1 of 9, every tick, forever — a severe
  // regression the round 6 maestro review caught as a BLOCKER.
  //
  // Round 6 review, item 2 — fixed by threading a DYNAMIC, per-directory
  // `--max-time` into installCacheRestoreCmd instead of a flat 600: each
  // directory gets `min(600, remaining-budget-seconds)` as its own curl
  // timeout, computed fresh at the moment it is about to start. The pre-start
  // check goes back to the simpler round-4 shape (`elapsed >= BUDGET_MS` —
  // skip only once the budget is ALREADY exhausted, never a lookahead), since
  // a directory that starts near the edge now gets a correspondingly SHORT
  // curl timeout instead of being skipped outright — it either finishes fast
  // or fails fast, but it always gets a real attempt.
  // ---------------------------------------------------------------------------
  it("item 2 (round 6 review) — a directory starting near the budget edge is given a DYNAMIC, capped curl --max-time (the remaining budget, never more than 600s) instead of being skipped outright — closes the round-5 regression that starved every directory after the first", async () => {
    const start = new Date("2026-09-25T00:00:00.000Z");
    let now = start;
    const observedMaxTimes: number[] = [];
    const deps: InstallCacheRestoreDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: "./site-a\n./site-b\n", stderr: "" };
        if (cmd.includes("echo yes || echo no")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "b".repeat(64), stderr: "" };
        const m = cmd.match(/--max-time (\d+)/);
        if (m) observedMaxTimes.push(Number(m[1]));
        // A REAL, measured 590s-per-directory attempt (the maestro's own
        // round-5 reported case) — site-a takes 590s, landing site-b right at
        // the edge of the 600s (10 minute) feature budget.
        now = new Date(now.getTime() + 590_000);
        return { code: 0, stdout: "", stderr: "" };
      },
      installCacheEnabled: () => true,
      installCachePresignGet: async () => "https://signed.example/url",
      installCacheRestoreNow: () => now,
    };
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs[0].outcome).toBe("restored"); // site-a: zero spent yet, full 600s budget
    expect(observedMaxTimes[0]).toBe(600);
    // site-b starts at 590s elapsed (still < the 600s budget, so it is NOT
    // skipped — the round-5 regression this fix closes) but only gets the
    // ~10s of budget actually remaining, never the full 600s.
    expect(result.dirs[1].outcome).toBe("restored");
    expect(observedMaxTimes[1]).toBeGreaterThanOrEqual(1);
    expect(observedMaxTimes[1]).toBeLessThanOrEqual(10);
  });

  it("item 2 (round 6 review) — once the budget is genuinely exhausted (elapsed >= budget), a directory is skipped outright, never started with a near-zero timeout", async () => {
    let now = new Date("2026-09-25T00:00:00.000Z");
    const deps: InstallCacheRestoreDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: "./site-a\n./site-b\n", stderr: "" };
        if (cmd.includes("echo yes || echo no")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "b".repeat(64), stderr: "" };
        now = new Date(now.getTime() + INSTALL_CACHE_RESTORE_BUDGET_MS);
        return { code: 0, stdout: "", stderr: "" };
      },
      installCacheEnabled: () => true,
      installCachePresignGet: async () => "https://signed.example/url",
      installCacheRestoreNow: () => now,
    };
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs[0].outcome).toBe("restored");
    expect(result.dirs[1]).toMatchObject({ attempted: false, outcome: "skip:restore-budget-exceeded" });
  });

  // The maestro's own named test requirement (round 6 review, item 2): with a
  // wired/controllable clock and directories that each finish FAST (not
  // actually taking their full allotted time — the realistic case for most
  // real installs), ALL 9 directories in a `example-org/websites`-shaped
  // fixture (this feature's own first and largest named target) must get a
  // real restore attempt in one tick, not just the first.
  it("item 2 (round 6 review) — BLOCKER regression test: 9 fast-finishing directories (example-org/websites' own shape) ALL get a real restore attempt in one tick, not just the first", async () => {
    const start = new Date("2026-09-25T00:00:00.000Z");
    let now = start;
    const dirNames = Array.from({ length: 9 }, (_, i) => `site-${i}`);
    const deps: InstallCacheRestoreDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: dirNames.map((d) => `./${d}\n`).join(""), stderr: "" };
        if (cmd.includes("echo yes || echo no")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "c".repeat(64), stderr: "" };
        // Each directory's own transfer genuinely finishes FAST — 2s, not
        // its full allotted budget — driving the clock forward realistically
        // between iterations, the same pattern the tests above already use.
        now = new Date(now.getTime() + 2_000);
        return { code: 0, stdout: "", stderr: "" };
      },
      installCacheEnabled: () => true,
      installCachePresignGet: async () => "https://signed.example/url",
      installCacheRestoreNow: () => now,
    };
    const result = await runInstallCacheRestore(deps, "id", "example-org/websites", "/workspace/websites");
    expect(result.dirs).toHaveLength(9);
    expect(result.dirs.every((d) => d.outcome === "restored")).toBe(true);
    expect(now.getTime() - start.getTime()).toBe(18_000); // 9 * 2s, nowhere near the 600s budget
  });
});

// ---------------------------------------------------------------------------
// runInstallCacheSaveTick — orchestration, now per-directory
// ---------------------------------------------------------------------------

function fakeSaveStorage(seed?: Record<string, string>): InstallCacheSaveStorage & { puts: Record<string, string[]> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  const puts: Record<string, string[]> = {};
  return {
    puts,
    get: (async (key: string) => map.get(key)) as InstallCacheSaveStorage["get"],
    put: (async (key: string, value: string) => {
      (puts[key] ??= []).push(value);
      map.set(key, value);
    }) as InstallCacheSaveStorage["put"],
  };
}

function fakeSaveDeps(opts: {
  repos?: string; lockHashStdout?: string; head?: boolean; presign?: string | null;
  saveStdout?: string; saveCode?: number; listed?: { key: string; uploaded: Date }[];
  discoverStdout?: string; installRunning?: boolean; now?: () => Date;
} = {}): { deps: InstallCacheSaveDeps; calls: { sbExec: string[]; r2Head: string[]; r2List: string[]; r2Delete: string[][] } } {
  const calls = { sbExec: [] as string[], r2Head: [] as string[], r2List: [] as string[], r2Delete: [] as string[][] };
  const deps: InstallCacheSaveDeps = {
    sbExec: async (cmd: string) => {
      calls.sbExec.push(cmd);
      if (cmd.includes("find .")) return { code: 0, stdout: opts.discoverStdout ?? ".\n", stderr: "" };
      if (cmd.includes("-newermt")) return { code: 0, stdout: opts.installRunning ? "yes" : "no", stderr: "" };
      if (cmd.includes("sha256sum")) return { code: 0, stdout: opts.lockHashStdout ?? "d".repeat(64), stderr: "" };
      return { code: opts.saveCode ?? 0, stdout: opts.saveStdout ?? "saved:12345", stderr: opts.saveCode ? "boom" : "" };
    },
    presignPut: async () => (opts.presign === undefined ? "https://signed.example/put" : opts.presign),
    r2Head: async (key: string) => { calls.r2Head.push(key); return opts.head ?? false; },
    r2List: async (prefix: string) => { calls.r2List.push(prefix); return opts.listed ?? []; },
    r2Delete: async (keys: string[]) => { calls.r2Delete.push(keys); },
    installCacheRepos: opts.repos === undefined ? "example-org/websites" : opts.repos,
    now: opts.now ?? (() => new Date("2026-09-25T00:00:00.000Z")),
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// Round 3 review, item 4 — save failure backoff (pure logic).
// ---------------------------------------------------------------------------

describe("parseInstallCacheFailure", () => {
  it("round-trips a well-formed record", () => {
    const record = { lockHash: "a".repeat(64), attempts: 3, lastFailedAt: "2026-09-25T00:00:00.000Z", reason: "skip:oversize:99" };
    expect(parseInstallCacheFailure(JSON.stringify(record))).toEqual(record);
  });

  it("refuses absent, empty, malformed JSON, and a shape missing a required field", () => {
    expect(parseInstallCacheFailure(undefined)).toBeNull();
    expect(parseInstallCacheFailure("")).toBeNull();
    expect(parseInstallCacheFailure("not json")).toBeNull();
    expect(parseInstallCacheFailure(JSON.stringify({ attempts: 1 }))).toBeNull();
  });

  it("defaults a missing/non-string reason to 'unknown' rather than refusing the whole record", () => {
    const parsed = parseInstallCacheFailure(JSON.stringify({ lockHash: "a".repeat(64), attempts: 1, lastFailedAt: "2026-09-25T00:00:00.000Z" }));
    expect(parsed?.reason).toBe("unknown");
  });
});

describe("installCacheFailureBackoffMs", () => {
  it("doubles per consecutive attempt, capped at INSTALL_CACHE_FAILURE_BACKOFF_MAX_MS", () => {
    expect(installCacheFailureBackoffMs(1)).toBe(INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS);
    expect(installCacheFailureBackoffMs(2)).toBe(INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS * 2);
    expect(installCacheFailureBackoffMs(3)).toBe(INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS * 4);
    // MUTANT PROOF — the schedule must actually hit its own ceiling for a
    // large enough attempt count, never grow unbounded.
    expect(installCacheFailureBackoffMs(20)).toBe(INSTALL_CACHE_FAILURE_BACKOFF_MAX_MS);
  });

  it("never returns less than the base for the first attempt, even for a 0/negative attempts value", () => {
    expect(installCacheFailureBackoffMs(0)).toBe(INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS);
    expect(installCacheFailureBackoffMs(-5)).toBe(INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS);
  });
});

describe("installCacheFailureBackoffActive", () => {
  const hash = "a".repeat(64);
  const now = new Date("2026-09-25T01:00:00.000Z");

  it("false with no record at all", () => {
    expect(installCacheFailureBackoffActive(null, hash, now)).toBe(false);
  });

  it("false for a DIFFERENT lockHash than the one that failed — a new lockfile never inherits an old cooldown", () => {
    const failure = { lockHash: "b".repeat(64), attempts: 5, lastFailedAt: now.toISOString(), reason: "skip:oversize:1" };
    expect(installCacheFailureBackoffActive(failure, hash, now)).toBe(false);
  });

  it("true while still inside the backoff window for the SAME lockHash", () => {
    const failure = { lockHash: hash, attempts: 1, lastFailedAt: now.toISOString(), reason: "skip:oversize:1" };
    const stillWithin = new Date(now.getTime() + INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS - 1000);
    expect(installCacheFailureBackoffActive(failure, hash, stillWithin)).toBe(true);
  });

  it("false once the backoff window for this attempt count has elapsed", () => {
    const failure = { lockHash: hash, attempts: 1, lastFailedAt: now.toISOString(), reason: "skip:oversize:1" };
    const afterWindow = new Date(now.getTime() + INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS + 1000);
    expect(installCacheFailureBackoffActive(failure, hash, afterWindow)).toBe(false);
  });

  it("false for an unparseable lastFailedAt — never grants infinite backoff over a storage-shape problem", () => {
    const failure = { lockHash: hash, attempts: 1, lastFailedAt: "not-a-date", reason: "x" };
    expect(installCacheFailureBackoffActive(failure, hash, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round 3 review, item 3 — the detached-save lease (pure logic; the
// in-memory half of the guard lives in do.ts and is exercised in
// test/studio.session.test.ts against the real syncSessionCycle).
// ---------------------------------------------------------------------------

describe("installCacheSaveLeaseFresh", () => {
  it("false for no lease held (absent or the empty-string 'cleared' sentinel)", () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    expect(installCacheSaveLeaseFresh(undefined, now)).toBe(false);
    expect(installCacheSaveLeaseFresh("", now)).toBe(false);
  });

  it("true for a lease taken well within INSTALL_CACHE_SAVE_LEASE_STALE_MS", () => {
    const since = new Date("2026-09-25T00:00:00.000Z");
    const now = new Date(since.getTime() + 60_000);
    expect(installCacheSaveLeaseFresh(since.toISOString(), now)).toBe(true);
  });

  it("MUTANT PROOF — false once the lease is older than INSTALL_CACHE_SAVE_LEASE_STALE_MS (a dead isolate's lease must eventually be reclaimable)", () => {
    const since = new Date("2026-09-25T00:00:00.000Z");
    const now = new Date(since.getTime() + INSTALL_CACHE_SAVE_LEASE_STALE_MS + 1);
    expect(installCacheSaveLeaseFresh(since.toISOString(), now)).toBe(false);
  });

  it("false for a lease timestamp in the future (a clock skew / malformed value) — never trusted as fresher than 'now'", () => {
    const since = new Date("2026-09-25T02:00:00.000Z");
    const now = new Date("2026-09-25T00:00:00.000Z");
    expect(installCacheSaveLeaseFresh(since.toISOString(), now)).toBe(false);
  });
});

describe("runInstallCacheSaveTick", () => {
  it("(b) MUTANT PROOF — a repo not in the gate makes ZERO sbExec/R2 calls", async () => {
    const { deps, calls } = fakeSaveDeps({ repos: "" });
    const result = await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", "rafarc21/fleetflare");
    expect(result).toEqual({ attempted: false, outcome: "gate:off", dirs: [] });
    expect(calls.sbExec).toEqual([]);
    expect(calls.r2Head).toEqual([]);
    expect(calls.r2List).toEqual([]);
  });

  it("no-repo when the studio's repoSlug isn't known yet — zero calls, same as gate:off", async () => {
    const { deps, calls } = fakeSaveDeps();
    const result = await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", null);
    expect(result).toEqual({ attempted: false, outcome: "no-repo", dirs: [] });
    expect(calls.sbExec).toEqual([]);
  });

  it("skip:no-lockfile (repo-level) when discovery finds no cache-worthy directory at all", async () => {
    const { deps } = fakeSaveDeps({ discoverStdout: "" });
    const result = await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", "example-org/websites");
    expect(result).toEqual({ attempted: false, outcome: "skip:no-lockfile", dirs: [] });
  });

  it("item 3 — skip:install-running when a bun install is mid-flight in that directory, before any tar/hash work", async () => {
    const { deps, calls } = fakeSaveDeps({ installRunning: true });
    const result = await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", "example-org/websites");
    expect(result.dirs[0].outcome).toBe("skip:install-running");
    expect(calls.sbExec.some((c) => c.includes("sha256sum"))).toBe(false);
    expect(calls.r2Head).toEqual([]);
  });

  it("skip:no-lockfile (per-directory) when a discovered directory's hash can't be computed", async () => {
    const { deps } = fakeSaveDeps({ lockHashStdout: "" });
    const result = await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", "example-org/websites");
    expect(result.dirs[0].outcome).toBe("skip:no-lockfile");
  });

  it("unchanged — same lockHash already handled this directory's own storage marker, zero R2 calls", async () => {
    const hash = "d".repeat(64);
    const slug = await dirSlug("");
    const { deps, calls } = fakeSaveDeps({ lockHashStdout: hash });
    const storage = fakeSaveStorage({ [installCacheHashKey(slug)]: hash });
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0].outcome).toBe("unchanged");
    expect(calls.r2Head).toEqual([]);
  });

  it("already-cached — another studio wrote this hash first; stores the marker, uploads nothing", async () => {
    const { deps } = fakeSaveDeps({ head: true });
    const storage = fakeSaveStorage();
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0].outcome).toBe("already-cached");
    const slug = await dirSlug("");
    expect(storage.puts[installCacheHashKey(slug)]).toEqual(["d".repeat(64)]);
  });

  it("(g) MUTANT PROOF — the r2Head short-circuit is NOT trusted forever: once the reverify streak is exhausted, the next tick performs a REAL save even though r2Head still says the object exists", async () => {
    const { deps, calls } = fakeSaveDeps({ head: true });
    const slug = await dirSlug("");
    const storage = fakeSaveStorage({ [installCacheReverifyKey(slug)]: String(INSTALL_CACHE_REVERIFY_EVERY) });
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    // Falls through to the real upload path — proven by the fact that a
    // genuine save/PUT-shaped exec ran (parseSaveOutcome-shaped stdout) and
    // the outcome is "saved", not "already-cached".
    expect(result.dirs[0].outcome).toBe("saved");
    expect(storage.puts[installCacheReverifyKey(slug)]).toContain("0");
  });

  it("the reverify streak increments on every already-cached hit, up to the threshold", async () => {
    const { deps } = fakeSaveDeps({ head: true });
    const slug = await dirSlug("");
    const storage = fakeSaveStorage({ [installCacheReverifyKey(slug)]: "3" });
    await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(storage.puts[installCacheReverifyKey(slug)]).toEqual(["4"]);
  });

  // ---------------------------------------------------------------------------
  // Round 3 review, item 1 — the bug the maestro found: (g) above and the
  // "increments... up to the threshold" test just above BOTH hand-set the
  // reverify counter directly and never seed `installCacheHashKey`, so they
  // only ever exercise the "genuinely NEW hash, r2Head already true" branch —
  // which was NEVER the buggy one. The real bug was the `lastHandled ===
  // lockHash` fast path (an UNCHANGED hash, ticked repeatedly): before the
  // fix, that path returned "unchanged" immediately, before ever touching the
  // streak counter, so once a hash was first marked handled, EVERY later tick
  // for that SAME hash took that exact branch and the counter froze forever
  // — measured "50 ticks: 0 re-verifies". This test drives the counter to and
  // past the threshold via REPEATED REAL TICKS on an UNCHANGED hash (never
  // hand-setting the counter), and proves a real r2Head call — and a real
  // save attempt when that call comes back empty — actually happens at the
  // threshold, not merely that a number increments in isolation.
  // ---------------------------------------------------------------------------
  it("(g2) MUTANT PROOF — threshold crossed BY TICKS on an UNCHANGED hash: repeated real ticks eventually force a genuine re-verify/re-save, not a permanently frozen counter", async () => {
    const hash = "9".repeat(64);
    let r2HeadCalls = 0;
    let realSaveExecCalls = 0;
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: hash, stderr: "" };
        // Anything else is the real tar/zstd/curl save command.
        realSaveExecCalls += 1;
        return { code: 0, stdout: "saved:123", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => {
        r2HeadCalls += 1;
        // The object is reported present on the very first (hash-establishing)
        // check, then gone/corrupted the NEXT time r2Head is ever consulted —
        // which, if the fix works, is only once the reverify streak is
        // exhausted, many ticks later. If the streak stayed frozen (the bug),
        // r2Head would never be called a second time at all, and this test's
        // own r2HeadCalls/realSaveExecCalls assertions below would catch that.
        return r2HeadCalls <= 1;
      },
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    };
    const storage = fakeSaveStorage();
    const slug = await dirSlug("");

    // Tick 1: brand-new hash, r2Head says already cached — establishes the
    // "handled" marker and starts the reverify streak at 0->1.
    let result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0].outcome).toBe("already-cached");
    expect(r2HeadCalls).toBe(1);

    // Ticks 2..INSTALL_CACHE_REVERIFY_EVERY: the SAME hash every time (the
    // lockfile never changed). Pre-fix, every one of these took the
    // "unchanged" fast path forever and froze the counter, never calling
    // r2Head again. Post-fix, each one still takes the cheap fast path
    // (identical cost — zero r2Head calls) but genuinely advances the
    // counter, so it is actually due once the window elapses.
    for (let i = 2; i <= INSTALL_CACHE_REVERIFY_EVERY; i++) {
      result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
      expect(result.dirs[0].outcome).toBe("unchanged");
    }
    expect(r2HeadCalls).toBe(1); // still just the one from tick 1 — the cheap path held for the whole window, at no extra cost
    expect(realSaveExecCalls).toBe(0);

    // The tick that crosses the threshold: this MUST genuinely call r2Head
    // again (a real re-verify) — and because this check reports the object
    // gone, it must fall all the way through into a REAL save attempt, not
    // merely flip a counter back to zero in isolation.
    result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(r2HeadCalls).toBe(2); // the real re-verify actually ran
    expect(realSaveExecCalls).toBe(1); // and a genuine tar/upload was attempted
    expect(result.dirs[0].outcome).toBe("saved");
    expect(storage.puts[installCacheReverifyKey(slug)]).toContain("0");

    // And the window starts fresh from here: the very next tick (same,
    // still-unchanged hash) takes the cheap path again, not another forced
    // re-verify immediately.
    result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0].outcome).toBe("unchanged");
    expect(r2HeadCalls).toBe(2);
  });

  it("skip:no-object-url when presign fails/is unconfigured — retried next tick (hash not persisted)", async () => {
    const { deps } = fakeSaveDeps({ presign: null });
    const storage = fakeSaveStorage();
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0].outcome).toBe("skip:no-object-url");
    expect(storage.puts).toEqual({});
  });

  it("skip:save-failed on a nonzero exec (never throws) — hash not persisted, retried next tick", async () => {
    const { deps } = fakeSaveDeps({ saveCode: 1, saveStdout: "" });
    const storage = fakeSaveStorage();
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:save-failed" });
    // The lockHash itself is never marked "handled" on a failure (unchanged
    // from before item 4) — but round 3 review, item 4 now DOES persist a
    // FAILURE record, which is the entire point of the backoff fix below.
    expect(storage.puts[installCacheHashKey(await dirSlug(""))]).toBeUndefined();
    expect(storage.puts[installCacheFailureKey(await dirSlug(""))]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Round 3 review, item 4 — a failed save must not re-tar every single tick.
  // ---------------------------------------------------------------------------

  it("item 4 — a save failure is persisted with attempts=1, and the VERY NEXT tick (still inside the backoff window) is skipped WITHOUT a real save exec", async () => {
    let saveExecs = 0;
    const now = new Date("2026-09-25T00:00:00.000Z");
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "c".repeat(64), stderr: "" };
        saveExecs += 1;
        return { code: 0, stdout: "skip:oversize:99999999999", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => now,
    };
    const storage = fakeSaveStorage();
    const slug = await dirSlug("");

    const first = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(first.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:save-failed" });
    expect(saveExecs).toBe(1);
    const record = JSON.parse(storage.puts[installCacheFailureKey(slug)].at(-1)!);
    expect(record).toMatchObject({ lockHash: "c".repeat(64), attempts: 1, reason: "skip:oversize:99999999999" });

    // Same tick cadence, same hash, well within the backoff window — MUTANT
    // PROOF: no second tar/curl attempt.
    const second = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(second.dirs[0]).toMatchObject({ attempted: false, outcome: "skip:save-backoff" });
    expect(saveExecs).toBe(1); // unchanged — the real save exec never ran a second time
  });

  it("item 4 — consecutive failures of the SAME hash escalate the attempts count once the backoff window has elapsed", async () => {
    let now = new Date("2026-09-25T00:00:00.000Z");
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "c".repeat(64), stderr: "" };
        return { code: 0, stdout: "skip:disk-full", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => now,
    };
    const storage = fakeSaveStorage();
    const slug = await dirSlug("");

    await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    let record = JSON.parse(storage.puts[installCacheFailureKey(slug)].at(-1)!);
    expect(record.attempts).toBe(1);

    // Advance past attempt 1's own backoff window (base MS) before ticking
    // again — otherwise this tick would be skipped by the backoff itself
    // rather than genuinely re-attempting and failing again.
    now = new Date(now.getTime() + INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS + 1000);
    await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    record = JSON.parse(storage.puts[installCacheFailureKey(slug)].at(-1)!);
    expect(record.attempts).toBe(2);
  });

  it("item 4 — a NEW lockHash gets an immediate attempt, no inherited cooldown from the OLD hash's failure", async () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    let hashToReturn = "c".repeat(64);
    let saveExecs = 0;
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: hashToReturn, stderr: "" };
        saveExecs += 1;
        return { code: 0, stdout: "skip:oversize:1", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => now,
    };
    const storage = fakeSaveStorage();

    await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(saveExecs).toBe(1); // first hash fails once

    // A NEW lockfile hash: the old hash's fresh failure record must not
    // block this genuinely different hash at all.
    hashToReturn = "e".repeat(64);
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(saveExecs).toBe(2); // the new hash got its own real attempt, not a backoff skip
    expect(result.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:save-failed" });
  });

  // ---------------------------------------------------------------------------
  // Round 4 review, item 4 — a THROWN save exec (an exec deadline,
  // "session busy") used to bypass the backoff entirely: the catch block in
  // runInstallCacheSaveTick's own per-directory loop pushed a `skip:save-failed`
  // outcome but never wrote a failure record the way `saveOneDir`'s own
  // internal (non-throwing) failure path already does — so a throw retried,
  // and re-tarred, on EVERY tick, forever. Fixed by recording a failure here
  // too (recomputing lockHash with one more, cheap, read-only exec, since the
  // one that was in scope inside saveOneDir is gone along with its stack
  // frame — this function's own doc comment).
  // ---------------------------------------------------------------------------

  it("item 4 (round 4 review) — a THROWN save exec (not just a nonzero exit) also gets a failure record, and backoff suppresses the SECOND attempt within the window", async () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    let saveExecs = 0;
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "f".repeat(64), stderr: "" };
        saveExecs += 1;
        throw new Error("exec deadline exceeded");
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => now,
    };
    const storage = fakeSaveStorage();
    const slug = await dirSlug("");

    const first = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    // Round 5 review, item 2 — this throw happens AFTER saveOneDir already
    // computed lockHash successfully (the "sha256sum" branch above never
    // throws in this test), so it is now caught INTERNALLY by saveOneDir
    // itself, using that already-known hash — never propagated up into
    // runInstallCacheSaveTick's own outer catch (which used to be the only
    // thing that ever wrote a record for this case, via a now-unnecessary
    // recompute). `attempted: true` here (not `false`) is the direct,
    // observable proof: that shape only ever comes from saveOneDir's own
    // normal return path, never from the outer catch's fallback push.
    expect(first.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:save-failed" });
    expect(saveExecs).toBe(1);
    const record = JSON.parse(storage.puts[installCacheFailureKey(slug)].at(-1)!);
    expect(record).toMatchObject({ lockHash: "f".repeat(64), attempts: 1 });

    // Still within the backoff window, same hash — MUTANT PROOF: the
    // throwing save exec must not run a second time; the failure record
    // above is what suppresses it.
    const second = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(second.dirs[0]).toMatchObject({ attempted: false, outcome: "skip:save-backoff" });
    expect(saveExecs).toBe(1); // unchanged — backoff suppressed the second throw
  });

  // ---------------------------------------------------------------------------
  // Round 5 review, item 2 — the maestro's own reported bug: after the
  // restore/save loop's own exec deadline fires, sbExec's session is
  // ABANDONED (sandbox-api.ts's SessionBusyError/abandoned WeakMap) — every
  // FURTHER call against that same session throws immediately, including a
  // RECOMPUTE. Before this fix, a later-stage throw (the real save exec
  // itself) propagated out of saveOneDir entirely, and runInstallCacheSaveTick's
  // outer catch tried to recover by calling `deps.sbExec(lockHashCmd(dir))`
  // AGAIN to learn the hash it needed to record a failure — but that
  // recompute hits the exact same abandoned session and throws too, caught by
  // its OWN inner try/catch, logged, and NOTHING is ever recorded. The next
  // tick re-tars a potentially multi-GiB node_modules from scratch, forever,
  // exactly the cost round 4's own item 4 fix was supposed to prevent.
  //
  // Reproduced here precisely: sha256sum succeeds EXACTLY ONCE (the initial,
  // successful computation inside saveOneDir), and every sbExec call after
  // that — the real save exec, AND what would have been the outer catch's own
  // recompute — throws, modeling a session that is genuinely abandoned for
  // the rest of this tick.
  // ---------------------------------------------------------------------------
  it("item 2 (round 5 review) — a later-stage throw after a genuinely abandoned session still records a failure, using the ALREADY-COMPUTED lockHash, with no recompute attempted at all", async () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    let sha256sumCalls = 0;
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) {
          sha256sumCalls += 1;
          return { code: 0, stdout: "a".repeat(64), stderr: "" };
        }
        // The real save exec — throws, modeling the deadline-abandoned
        // session. If the fix regresses back to a recompute, THIS branch is
        // also what that recompute would hit (lockHashCmd also runs through
        // this same sbExec), so a second "sha256sum" call would never
        // happen — it would land here and throw instead, which is exactly
        // what sha256sumCalls===1 below proves did NOT happen.
        throw new Error("SessionBusyError: session abandoned after exec deadline");
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => now,
    };
    const storage = fakeSaveStorage();
    const slug = await dirSlug("");

    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0]).toMatchObject({ attempted: true, outcome: "skip:save-failed" });
    expect(sha256sumCalls).toBe(1); // no recompute — saveOneDir already had the hash
    const record = JSON.parse(storage.puts[installCacheFailureKey(slug)].at(-1)!);
    expect(record).toMatchObject({ lockHash: "a".repeat(64), attempts: 1 });
  });

  it("item 4 (round 4 review) — if recomputing the lockHash ALSO throws, no failure record is written (never guess a lockHash, which would silently never activate backoff for the hash that actually failed)", async () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        // Both the FIRST hash computation (inside saveOneDir) and the catch
        // block's own RECOMPUTE hit this same wedged condition.
        if (cmd.includes("sha256sum")) throw new Error("sandbox wedged");
        throw new Error("exec deadline exceeded");
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => now,
    };
    const storage = fakeSaveStorage();
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0]).toMatchObject({ attempted: false, outcome: "skip:save-failed" });
    expect(storage.puts[installCacheFailureKey(await dirSlug(""))]).toBeUndefined();
  });

  it("saves on the happy path, persists the hash, and prunes the LRU afterward", async () => {
    const slug = await dirSlug("");
    const listed = [
      { key: `caches/example-org/websites/${slug}/oldest.tar.zst`, uploaded: new Date("2026-08-01") },
      { key: `caches/example-org/websites/${slug}/old2.tar.zst`, uploaded: new Date("2026-09-02") },
      { key: `caches/example-org/websites/${slug}/old1.tar.zst`, uploaded: new Date("2026-09-10") },
      { key: `caches/example-org/websites/${slug}/new.tar.zst`, uploaded: new Date("2026-09-24") },
    ];
    const { deps, calls } = fakeSaveDeps({ listed });
    const storage = fakeSaveStorage();
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs[0].outcome).toBe("saved");
    expect(storage.puts[installCacheHashKey(slug)]).toEqual(["d".repeat(64)]);
    expect(calls.r2List).toEqual([`caches/example-org/websites/${slug}/`]);
    expect(calls.r2Delete).toHaveLength(1);
    expect(calls.r2Delete[0].sort()).toEqual([
      `caches/example-org/websites/${slug}/oldest.tar.zst`, `caches/example-org/websites/${slug}/old2.tar.zst`,
    ].sort());
  });

  it("saves without pruning when there's nothing stale (<=2 objects)", async () => {
    const { deps, calls } = fakeSaveDeps({ listed: [{ key: "only.tar.zst", uploaded: new Date() }] });
    await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", "example-org/websites");
    expect(calls.r2Delete).toEqual([]);
  });

  it("MULTI-DIRECTORY (item 1) — saves each discovered directory independently, each with its OWN hash/storage marker", async () => {
    const { deps } = fakeSaveDeps({ discoverStdout: "./site-a\n./site-b\n" });
    const storage = fakeSaveStorage();
    const result = await runInstallCacheSaveTick(deps, storage, "id", "example-org/websites");
    expect(result.dirs.map((d) => d.relDir)).toEqual(["site-a", "site-b"]);
    expect(result.dirs.every((d) => d.outcome === "saved")).toBe(true);
    const slugA = await dirSlug("site-a");
    const slugB = await dirSlug("site-b");
    expect(storage.puts[installCacheHashKey(slugA)]).toBeDefined();
    expect(storage.puts[installCacheHashKey(slugB)]).toBeDefined();
  });

  it("(e) MUTANT PROOF — saving site-a never presigns/uploads under site-b's key, and vice versa", async () => {
    const presignedKeys: string[] = [];
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: "./site-a\n./site-b\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "f".repeat(64), stderr: "" };
        return { code: 0, stdout: "saved:99", stderr: "" };
      },
      presignPut: async (key: string) => { presignedKeys.push(key); return "https://signed.example/put"; },
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    };
    await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", "example-org/websites");
    const slugA = await dirSlug("site-a");
    const slugB = await dirSlug("site-b");
    expect(presignedKeys).toEqual([
      `caches/example-org/websites/${slugA}/${"f".repeat(64)}.tar.zst`,
      `caches/example-org/websites/${slugB}/${"f".repeat(64)}.tar.zst`,
    ]);
    expect(new Set(presignedKeys).size).toBe(2); // never the same key twice
  });

  it("(f) MUTANT PROOF — a directory's own sbExec THROWING is caught and reported, not propagated, and does not stop sibling directories", async () => {
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: "./site-a\n./site-b\n", stderr: "" };
        if (cmd.includes("-newermt") && cmd.includes("site-a")) throw new Error("sandbox connection dropped");
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "1".repeat(64), stderr: "" };
        return { code: 0, stdout: "saved:1", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    };
    const result = await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", "example-org/websites");
    expect(result.dirs.find((d) => d.relDir === "site-a")).toMatchObject({ attempted: false, outcome: "skip:save-failed" });
    expect(result.dirs.find((d) => d.relDir === "site-b")).toMatchObject({ outcome: "saved" });
  });

  it("repoDir is built through repoCheckoutDirName, not a raw split — a dotted repo name's discovery targets the REAL checkout directory", async () => {
    const seenDirs: string[] = [];
    const deps: InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        const m = cmd.match(/cd '([^']+)' &&/);
        if (m) seenDirs.push(m[1]);
        if (cmd.includes("find .")) return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/example.app",
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    };
    await runInstallCacheSaveTick(deps, fakeSaveStorage(), "id", "example-org/example.app");
    expect(seenDirs).toContain("/workspace/example-app");
    expect(seenDirs).not.toContain("/workspace/example.app");
  });
});

// ---------------------------------------------------------------------------
// Mixed-fleet-safe: runProvision/runRestart (via restartWithStorage) wiring.
// #350's own four requirements, each its own test below, run against the
// REAL orchestration functions (not a re-implementation) so a regression in
// the actual call sites — not just install-cache.ts's own unit surface —
// would be caught here.
// ---------------------------------------------------------------------------

const REPO = "websites";
const REPO_SLUG = "example-org/websites";
const STUDIO_ID = `${REPO}--pilot`;
const NOW = "2026-09-25T00:00:00.000Z";
const ROLE_ENV: RoleEnv = { ROLE_PROMPT_B64: "aGk=", ROLE_ALLOWED_TOOLS: "Bash(git *)", ROLE_EFFORT: "" };

function scratchBlueprint(): ProvisionDeps["fetchBlueprintFile"] {
  return vi.fn(async (_repo: string, path: string) => {
    if (path === "fleet.json") {
      return JSON.stringify({ blueprint: { repo: REPO_SLUG, ref: "main" }, roles: ["pilot"], instance_type: "standard-2" });
    }
    if (path === "fleet/blueprint/org.json") return JSON.stringify({ edges: {}, gates: {} });
    if (path.startsWith("fleet/blueprint/studios/")) throw new Error(`fetch ${path}@main failed (404): Not Found`);
    return "---\nname: pilot\nskills: []\nallowedTools: Bash(git *)\nmay_spawn: []\nreports_to: operator\ngates: []\n---\nhi\n";
  });
}

function fakeRestartStorage(): StudioStorage {
  const status: StudioStatus = {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: REPO_SLUG,
  };
  const map = new Map<string, unknown>([[STATUS_KEY, status], [ROLE_ENV_KEY, ROLE_ENV]]);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as StudioStorage["put"],
  };
}

/** Base ProvisionDeps builder: records every sbExec command, answers
 *  `discoverCacheDirsCmd`/`nodeModulesPresentCmd`/lockHash/restore per
 *  `opts` (discovery defaults to a single root directory, so these tests
 *  exercise the pre-redesign, single-lockfile-at-root shape every OTHER
 *  repo has), everything else (clone, bring-up, rescue-refs, git-safety,
 *  etc.) with a bland success. */
function fakeInstallDeps(opts: {
  enabled?: boolean; presign?: string | null; nodeModulesPresent?: boolean; restoreCode?: number;
} = {}): { deps: ProvisionDeps; cmds: string[] } {
  const cmds: string[] = [];
  const deps: ProvisionDeps = {
    sbExec: vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
      if (cmd.includes("node_modules") && cmd.includes("echo yes || echo no")) return { code: 0, stdout: opts.nodeModulesPresent ? "yes" : "no", stderr: "" };
      if (cmd.includes("sha256sum")) return { code: 0, stdout: "e".repeat(64), stderr: "" };
      if (cmd.includes(INSTALL_CACHE_URL_ENV) || cmd.includes("mktemp -d /tmp/.install-cache-restore")) {
        return { code: opts.restoreCode ?? 0, stdout: "", stderr: opts.restoreCode ? "curl: connection reset" : "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
    recordStudio: vi.fn(async () => {}),
    now: () => NOW,
    fetchBlueprintFile: scratchBlueprint(),
    installCacheEnabled: opts.enabled === undefined ? () => true : () => opts.enabled!,
    installCachePresignGet: async () =>
      (opts.presign === undefined ? "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=abc" : opts.presign),
  };
  return { deps, cmds };
}

describe("mixed-fleet-safe (#350) — runProvision", () => {
  it("(1) a repo NOT in the gate: zero install-cache execs, zero behavior change from before this feature existed", async () => {
    const { deps, cmds } = fakeInstallDeps({ enabled: false });
    const { status } = await runProvision(deps, { repo: REPO, role: "pilot" }, "rafarc21/fleetflare", null);
    expect(status.state).toBe("running");
    expect(cmds.some((c) => c.includes("find ."))).toBe(false);
    expect(cmds.some((c) => c.includes("sha256sum"))).toBe(false);
    expect(cmds).toContain(BRINGUP_CMD);
  });

  it("(2) gated repo, no cached object for this lockHash yet: falls through to today's behavior, never an error, never degraded", async () => {
    const { deps } = fakeInstallDeps({ presign: null });
    const { status } = await runProvision(deps, { repo: REPO, role: "pilot" }, "rafarc21/fleetflare", null);
    expect(status.state).toBe("running");
    expect(status.error).toBeNull();
  });

  it("(3) gated repo whose restore FAILS: logs and falls through, never an error, never degraded", async () => {
    const { deps, cmds } = fakeInstallDeps({ restoreCode: 1 });
    const { status } = await runProvision(deps, { repo: REPO, role: "pilot" }, "rafarc21/fleetflare", null);
    expect(status.state).toBe("running");
    expect(status.error).toBeNull();
    expect(cmds).toContain(BRINGUP_CMD); // bring-up still ran despite the restore failure
  });

  it("(4) an existing node_modules is NEVER overwritten by a restore", async () => {
    const { deps, cmds } = fakeInstallDeps({ nodeModulesPresent: true });
    const { status } = await runProvision(deps, { repo: REPO, role: "pilot" }, "rafarc21/fleetflare", null);
    expect(status.state).toBe("running");
    // The presence check ran, but no restore transfer followed it.
    expect(cmds.some((c) => c.includes("node_modules"))).toBe(true);
    expect(cmds.some((c) => c.includes("mktemp -d /tmp/.install-cache-restore"))).toBe(false);
  });

  it("restores on the happy path — absent node_modules, gate on, an object exists", async () => {
    const { deps, cmds } = fakeInstallDeps();
    const { status } = await runProvision(deps, { repo: REPO, role: "pilot" }, "rafarc21/fleetflare", null);
    expect(status.state).toBe("running");
    expect(cmds.some((c) => c.includes("mktemp -d /tmp/.install-cache-restore"))).toBe(true);
    // Restore happens after the clone, before bring-up.
    const cloneIdx = cmds.findIndex((c) => c.includes("git clone"));
    const restoreIdx = cmds.findIndex((c) => c.includes("mktemp -d /tmp/.install-cache-restore"));
    const bringupIdx = cmds.indexOf(BRINGUP_CMD);
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeGreaterThan(cloneIdx);
    expect(bringupIdx).toBeGreaterThan(restoreIdx);
  });
});

describe("mixed-fleet-safe (#350) — restartWithStorage", () => {
  it("(1) a repo NOT in the gate: zero install-cache execs on restart either", async () => {
    const { deps, cmds } = fakeInstallDeps({ enabled: false });
    const status = await restartWithStorage(deps, fakeRestartStorage(), STUDIO_ID, "rafarc21/fleetflare");
    expect(status.state).toBe("running");
    expect(cmds.some((c) => c.includes("find ."))).toBe(false);
  });

  it("(4) an existing node_modules survives a restart's own restore point untouched", async () => {
    const { deps, cmds } = fakeInstallDeps({ nodeModulesPresent: true });
    const status = await restartWithStorage(deps, fakeRestartStorage(), STUDIO_ID, "rafarc21/fleetflare");
    expect(status.state).toBe("running");
    expect(cmds.some((c) => c.includes("mktemp -d /tmp/.install-cache-restore"))).toBe(false);
  });

  it("(3) a restore failure on restart logs and falls through — restart still comes up running", async () => {
    const { deps } = fakeInstallDeps({ restoreCode: 1 });
    const status = await restartWithStorage(deps, fakeRestartStorage(), STUDIO_ID, "rafarc21/fleetflare");
    expect(status.state).toBe("running");
  });
});
