# Studio image git upgrade — >= 2.38 for `merge-tree --write-tree` (board issue #373)

Fix task, image-scoped. `apps/fleet/container/Dockerfile.studio`'s base ships
Ubuntu's stock git 1:2.34.1. No `git merge-tree --write-tree` support (needs
>= 2.38). `scripts/localci/localci.sh:293` uses that flag as its real
dry-run/merge-preview mechanism. NOT the fleet push-guard wrapper
(`src/studio/credentials.ts`'s `studioGitWrapperScript`, issue #253) — that
wrapper does not use merge-tree at all. Confirmed across board issue #353's 3
rounds: purely a git-VERSION gap in the studio image, not an application bug
— maestro's own local CI docker environment (plain git 2.43, no fleet
wrapper) gets 0 failures on the identical `bun-test` lane that fails 23 tests
inside a real studio container.

## What this touches

Only `apps/fleet/container/Dockerfile.studio`. Not `apps/fleet/src`,
`apps/fleet/test`, or `apps/fleet/container/Dockerfile` (task image, genuinely
Debian — see "Why not touch container/Dockerfile"). Image-only change, per
the board issue's own scoping.

## Step 1: identify the actual base OS (don't assume)

Dockerfile's own comment two blocks below (chromium install) says "Ubuntu
jammy's `chromium`/`chromium-browser`" — a hint, verified independently
rather than trusted as-is.

No `docker` binary in this sandbox (`which docker` → nothing). Base image
inspected directly against the Docker Hub v2 registry API instead of
`docker build`/`docker run`:

1. `curl` a pull token for `cloudflare/sandbox` from `auth.docker.io`.
2. Fetched the `0.12.7` manifest, then the image config blob. Its
   `config.Labels` carries `"org.opencontainers.image.version": "22.04"`;
   build `history` includes `ARG RELEASE` / `ARG LAUNCHPAD_BUILD_ARCH` —
   Canonical's Launchpad build-farm args, present only on official Ubuntu
   base images.
3. Downloaded the first (base rootfs) layer tarball, extracted
   `etc/os-release`:
   ```
   PRETTY_NAME="Ubuntu 22.04.5 LTS"
   NAME="Ubuntu"
   VERSION_ID="22.04"
   VERSION="22.04.5 LTS (Jammy Jellyfish)"
   VERSION_CODENAME=jammy
   ID=ubuntu
   ID_LIKE=debian
   ```

**Verdict: Ubuntu 22.04.5 LTS (Jammy Jellyfish), not Debian.** `ID_LIKE=debian`
is expected (Ubuntu is Debian-derived); `ID=ubuntu` is unambiguous. Board
issue's wording ("git-core PPA or newer base image") and the
`oven/bun:1.3-debian` mention are about a DIFFERENT Dockerfile
(`apps/fleet/container/Dockerfile`, the task image, `FROM
oven/bun:1.3-debian` — genuinely Debian, confirmed by reading its line 1) —
not this one.

This sandbox's own OS (`cat /etc/os-release`) is also Ubuntu 22.04.5 LTS
jammy — enabled a much stronger empirical test than research alone (Step 3).

## Step 2: pick the correct upgrade mechanism for Ubuntu 22.04

Base is genuinely Ubuntu, not Debian: the Ubuntu `git-core` PPA
(`ppa:git-core/ubuntu/ppa`, "Git stable releases", "Ubuntu Git Maintainers"
team) applies. PPAs are Launchpad/Ubuntu-specific — would NOT work on Debian
(why `container/Dockerfile`, genuinely Debian, can't use this mechanism).

Verified live against Launchpad's archive API
(`https://api.launchpad.net/1.0/~git-core/+archive/ubuntu/ppa`) and its
packages listing, for jammy:

```
git - 1:2.55.0-0ppa1~ubuntu22.04.2
```

Comfortably above the 2.38 floor. Pulled the PPA's own
`signing_key_fingerprint` from that same API
(`F911AB184317630C59970973E363C90F8F1B6217`) — not guessed, not copied from a
blog post.

Mechanism, applied only to the FIRST `apt-get install` block (lines ~26-59
after this change): fetch the PPA's signing key from `keyserver.ubuntu.com`
by that fingerprint, `gpg --dearmor` into a keyring file, write
`/etc/apt/sources.list.d/git-core-ppa.list` pointing at
`https://ppa.launchpadcontent.net/git-core/ppa/ubuntu jammy main`, then
`apt-get update && apt-get install git`. Same curl-key + `sources.list.d` +
`signed-by` idiom the Dockerfile already uses two blocks below for `gh`'s
apt repo. Chosen over `add-apt-repository`/`software-properties-common`:
avoids pulling in an early python3 stack (`software-properties-common`
depends on `python3-*` on jammy) for one repo, and stays consistent with an
already-trusted pattern in this file.

## Step 3: the two `apt-get install` blocks — why two, what changed

Read both before touching either.

- **Block 1** (`RUN apt-get update && apt-get install -y --no-install-recommends
  tmux git curl ca-certificates && curl ... tailscale.com/install.sh | sh`):
  installs `git`/`curl`/`ca-certificates` as runtime deps of the bring-up
  script and the tailscale installer, plus `tmux` for the long-lived studio
  session. Real, meaningful git install site — **the block that changed**:
  adds the git-core PPA key + source before installing `git`, so `git`
  resolves to `1:2.55.0-0ppa1~ubuntu22.04.2` instead of stock
  `1:2.34.1-1ubuntu1.11`. `gnupg` added to this block's package list (needed
  for `gpg --dearmor`; wasn't there before, nothing in this block needed it).

- **Block 2** (`RUN apt-get update && apt-get install -y --no-install-recommends
  git ca-certificates curl gnupg && curl ... githubcli-archive-keyring.gpg
  ... && apt-get install gh`): own comment already explains it is "copied
  verbatim from `container/Dockerfile` (task image) — same install mechanism,
  so the two images can never silently drift on how `gh` gets
  authenticated/resolved," and that re-installing `git`/`ca-certificates`/
  `curl` here is "a harmless no-op ... already satisfied above."
  **Deliberately NOT touched** (package list byte-identical to before, and
  to `container/Dockerfile`'s own line): editing it to add its own PPA
  mechanism would (a) duplicate a key-fetch + dearmor + sources-file write
  for no gain — PPA's `sources.list.d` entry and upgraded `git` package
  already on disk by the time block 2 starts (Docker RUN instructions run
  strictly in written order; no scenario where block 2 runs before block 1),
  and `apt-get install` never downgrades an installed package; and (b) break
  the "verbatim means verbatim, not hand-merged" invariant the block's
  comment describes, since `container/Dockerfile`'s matching line would then
  differ for no reason grounded in its own actual base. Comment ADDED
  (not the install line) explaining this, so a future reader isn't left
  wondering why block 2 wasn't "fixed" too.

**Why not touch `container/Dockerfile`**: `FROM oven/bun:1.3-debian` is
genuinely Debian (confirmed reading line 1) — git-core PPA mechanism doesn't
apply. Board issue scopes this fix to the studio image
(`apps/fleet/container/Dockerfile.studio`) only. Whether the task image needs
its own git-version fix is a separate, unasked question — out of scope, not
silently addressed here.

Label bump: `LABEL fleet.image.rev` moved from `"p7b-ego-browser"` to
`"git-core-ppa"` — load-bearing per the file's own comment (wrangler diffs
the built image DIGEST; a cached rebuild with no label bump can leave a real
change unshipped).

## Step 4: verification — what was and wasn't actually confirmed

No `docker` binary in this sandbox, so the literal `docker build
-f Dockerfile.studio . && docker run ... git --version` end-to-end proof the
board issue's "Proof" section asks for could NOT be produced directly.
Instead, in order of strength:

1. **Confirmed the base image's actual OS** (Step 1) — pulled directly from
   the registry and the image's own root layer, not inferred.
2. **Confirmed the git-core PPA genuinely serves git >= 2.38 for jammy**
   (Step 2) — via Launchpad's live archive API, not a cached/remembered
   claim.
3. **Ran the EXACT mechanism from the Dockerfile diff live**, in this
   sandbox — itself Ubuntu 22.04.5 jammy (confirmed via its own
   `/etc/os-release`), a genuinely representative dry run, not a guess:
   - fetched the same key by the same fingerprint from
     `keyserver.ubuntu.com`, `gpg --dearmor`'d it, wrote the same
     `sources.list.d` entry, ran `apt-get update`;
   - `apt-cache policy git` showed `Candidate: 1:2.55.0-0ppa1~ubuntu22.04.2`
     outranking installed `1:2.34.1-1ubuntu1.17`;
   - installed it (`apt-get install -y git`), confirmed `git --version` →
     `git version 2.55.0`;
   - ran a real `git merge-tree --write-tree <a> <b>` against a throwaway
     repo with a genuine three-way merge — printed a tree oid and a
     conflicted blob listing cleanly, the exact operation flatly unsupported
     on 2.34.1 (`error: unknown option 'write-tree'`).
4. **Ran the actual `bun-test` lane** (`bun run bun-test` — `test/bun`,
   `test/studio.files.test.ts`, `test/studio.studio-blueprint.test.ts`; 1153
   tests across 73 files) in this same now-upgraded-git sandbox. One caveat,
   worked around: this sandbox has its own `/usr/local/bin/git` push-guard
   wrapper (issue #253) ahead of real git on `PATH` (provisioned for THIS
   task's own safety, unrelated to the studio image build) — legitimately
   refuses a `git push origin HEAD:main` the test suite's own scratch
   fixtures perform against their OWN throwaway local "origin". A real,
   working-as-designed refusal, not a git-version bug, but a confound for
   this measurement. Re-ran with `PATH="/usr/bin:/bin:$PATH"` (real
   `/usr/bin/git` first, `bun` still resolved from `/usr/local/bin`) to match
   what an unprovisioned container's raw `git` looks like. Result:
   ```
   1150 pass
   1 skip
   2 fail
   3084 expect() calls
   Ran 1153 tests across 73 files. [502.54s]
   ```
   The 2 failures (`localci.sh > SIGTERM mid-lane`, `localci.sh > SIGTERM
   with a lane that ignores TERM`) are pure wall-clock assertions
   (`expect(Date.now() - t0).toBeLessThan(10_000)` received `24091`;
   `toBeLessThan(15_000)` received `20678`) — signal-promptness timing, not
   `merge-tree`/git-version related. Consistent with this shared sandbox's
   own throttling (file's own comment documents "~150 ms in the Linux lane"
   normally; this run took 502.54 s total, ~3 orders of magnitude slower —
   resource-starved container, not a code or git-version defect). Every
   `test/bun/git-wrapper.test.ts`, `test/bun/rescue-push.test.ts`, and every
   other `localci-run.test.ts` scenario passed clean.
5. **Also ran `bun run check` (5 tsconfig projects, clean) and `bun run
   test` (128 files, 4502 tests, all green)** — due diligence; this
   Dockerfile-only change can't mechanically affect `tsc`/`vitest` results
   either way (`Dockerfile.studio` is an image recipe, never imported,
   parsed, or executed by either tool) — green here confirms repo
   pre-existing state, not this diff.

**What remains genuinely unconfirmed**: an actual `docker build` of the
modified `Dockerfile.studio` and a `git --version`/full `bun-test` run
INSIDE a container built from that exact image. Everything short of that was
verified as directly as this sandbox allows — same OS, same PPA, same key,
same mechanism, same test suite, real upgraded git — but this is a
reconstruction alongside the real Dockerfile, not its own build output.
Re-confirm once the image is rebuilt and rolled out (scheduled, announced —
not this task's job, gated to the maestro's explicit approval per the board
issue's own boundaries).

## Step 5: confirmed no code depends on old git behavior

Grepped `apps/fleet/src` and `apps/fleet/test` for `2.34`, `2.38`,
`merge-tree`, `git --version`. Every hit in
`src/studio/credentials.ts`/`test/bun/git-wrapper.test.ts`/
`test/studio.credentials.test.ts` is a "measured, git 2.34.1" comment
documenting when a specific bypass/normalization behavior was verified — most
cross-checked "measured on 2.34.1 and 2.43" in the SAME comment, i.e. already
written forward-compatible, consistent with #253/#310/#319 being designed
against more than one git version. No test asserts `2.34`-specific behavior
as a requirement; none of the passing/failing `bun-test` results above
changed in a way that suggests otherwise.

## Step 6: safe.directory guard (found in review, added same-branch)

Fresh-context code review on this PR flagged a real, unaddressed gap: git
>= 2.35.2 (CVE-2022-24765) hard-refuses to operate on a repository whose
directory owner doesn't match the running process's EUID ("fatal: detected
dubious ownership in repository at ...") unless `safe.directory` explicitly
allows it. This upgrade (1:2.34.1 -> 2.55.0) crosses that boundary — 2.34.1
never enforced this check, so the studio image's git behavior re: repo
ownership genuinely changes as a side effect of the version bump, not just
gains a new flag.

Repo already knows it needs this guard: both sibling images —
`apps/fleet/container/Dockerfile:25` and
`apps/fleet/scripts/localci/Dockerfile:13` — set `git config --global --add
safe.directory '*'` for exactly this reason. Applied the identical one-liner
to `Dockerfile.studio`'s git-core-PPA `apt-get install` block, right after
`git` installs (same block, same `&&`-chained RUN step — no separate RUN
layer).

**Why the Dockerfile, not `studioGitSafetyCmd` (`src/studio/credentials.ts`)**:
that function runs later, per-container provision; its two `git config` keys
(`push.default`, `branch.autoSetupMerge`) are already covered end to end by
`test/studio.credentials.test.ts`'s exact-two-keys assertions — a third,
unrelated key there would break that invariant for no reason, since the
image-level fix already covers every git invocation in the container from
build time onward. Both `Dockerfile.studio` and the sibling `Dockerfile` have
no `USER` directive — both build AND run entirely as root: a build-time `git
config --global` write lands in `/root/.gitconfig` and is still there, still
root's, at container runtime — same mechanism the sibling `Dockerfile`
already relies on (its own comment notes its own process, e.g. `claude`,
also runs as root at runtime). No separate runtime-set mechanism needed.

**Verification**: this sandbox is itself Ubuntu 22.04.5 jammy (same OS as the
image base, Step 1), already has git 2.55.0 and root as its running user
(Step 4) — enabled a genuine cross-UID repro without a real second login:
created a throwaway repo (`git init /tmp/dubious-repro/repo`), `chown -R
nobody:nogroup` on it so its owning UID (65534) no longer matches the
shell's EUID (0), no `safe.directory` entries set beforehand (confirmed via
`git config --global --get-all safe.directory` returning nothing). `git
status` inside it failed exactly as the CVE predicts:

```
fatal: detected dubious ownership in repository at '/tmp/dubious-repro/repo'
To add an exception for this directory, call:

	git config --global --add safe.directory /tmp/dubious-repro/repo
```

Running `git config --global --add safe.directory '*'` (the exact line now
added to `Dockerfile.studio`) and re-running `git status` in the same
directory then succeeded cleanly (`On branch master ... nothing to commit`);
`git config --global --get-all safe.directory` printed `*` — confirms both
the refusal and the fix are real, not merely documented behavior. Throwaway
repo and global config change both removed afterward — this sandbox's own
git state unchanged by the check.

## Step 7: hardening (maestro review, added same-branch)

Maestro review: MERGE after two fail-closed build-time guards, in the same
`&&`-chained RUN block, plus a comment fix.

**Key fingerprint check.** After the `gpg --dearmor` step: extract the
downloaded key's fingerprint via `gpg --show-keys --with-colons
/usr/share/keyrings/git-core-ppa-archive-keyring.gpg` (works on a dearmored
binary keyring passed as a file argument — verified live), parse the `fpr:`
colon-record's field 10, compare against
`F911AB184317630C59970973E363C90F8F1B6217`. Mismatch → `exit 1`, build fails.
Verified live: real key from `keyserver.ubuntu.com` extracts to exactly that
fingerprint (MATCH); a deliberately wrong expected value exits 1 with a
clear stderr message (MISMATCH, confirmed).

**Git version + merge-tree smoke test.** Right after `apt-get install git`:
(a) `dpkg --compare-versions "$(git --version | awk '{print $3}')" ge 2.38`,
fail closed otherwise; (b) build a throwaway repo under `/tmp`, two diverging
commits, run `git merge-tree --write-tree "$BASE" "$SHA"` — the exact
two-commit-arg shape `scripts/localci/localci.sh:293` calls, not a weaker
proxy — fail closed (`exit 1`) on nonzero exit. Verified live on this
sandbox's git 2.55.0: both checks pass, full chain exits 0. Verified the
fail path: a simulated `git version 2.34.1` string fails the `dpkg
--compare-versions` check with `exit 1`. The real 2.34.1 failure mode was
already measured this same round (Step 4 above): `git merge-tree
--write-tree` on 2.34.1 → `error: unknown option 'write-tree'`.

**Comment fix.** Lines ~33-36 previously said the git upgrade was needed
because the push-guard mechanism (#253/#310/#319) relied on `git merge-tree
--write-tree`. Wrong: that wrapper does not use merge-tree at all. Only
`scripts/localci/localci.sh:293` does (read directly to confirm: `TREE=$(git
merge-tree --write-tree "$BASE" "$SHA" ...)`, with a comment above it citing
PR #306). Comment corrected to cite `scripts/localci/localci.sh:293`
specifically, not the push-guard wrapper.

## Completion-record convention (checked, not assumed)

`origin/main` HEAD at the time this branch was cut (`35a22f3`, board issues
#361/#363) moved the per-task completion record OUTSIDE the product checkout
entirely: `gates/completion-gate.sh` now reads
`$FLEET_WORKSPACE/.fleet/done/<task>.json` and REFUSES a branch that adds or
changes any `.fleet/done/*` path in-tree. Older convention (#316,
`.fleet/done/<task>.json` committed to the branch) superseded. This task's
gate record lives at `/workspace/.fleet/done/373.json` (`$FLEET_WORKSPACE`
defaults to `/workspace`), never committed to this branch — confirmed by
reading `gates/completion-gate.sh` at `origin/main` HEAD directly, not
assumed from older plan docs.

## Touched

- `apps/fleet/container/Dockerfile.studio` — git-core PPA added to the first
  `apt-get install` block; key fingerprint check and git version/merge-tree
  smoke test added to the same block (both fail-closed); explanatory comment
  corrected (Step 7); `LABEL fleet.image.rev` bumped; `git config --global
  --add safe.directory '*'` added to the same block right after `git`
  installs (Step 6).
- This plan doc.

Untouched: everything else, including `apps/fleet/container/Dockerfile` (task
image, genuinely Debian, out of scope), all application code, every test
file.
