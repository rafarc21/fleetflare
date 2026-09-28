# git wrapper vs. genuinely empty repos (board issue #353)

## What the issue described vs. what the repo actually contains

Board #353's own text quotes a `defaults=()` bash array and an
unconditional "cannot resolve the remote's default branch" refusal on
EVERY push, including a brand-new first push, whenever all three of
`ls-remote --symref`, the local `refs/remotes/<name>/HEAD` symref, and
`git remote show`'s "HEAD branch:" line come back empty. That exact shape
— one default resolved ONCE up front, argv-derived, refused outright when
unknown — is real, but it is the **pre-#310** design. `apps/fleet/src/
studio/credentials.ts`'s current `studioGitWrapperScript()` (as of this
branch's base, commit `118caf2`, "resolve default branch from push target
— #310 (#319)") replaced it entirely: the destination comes from the dry-run
probe's own `To <url>` line (never argv, per #310's own hard-won reason —
a renamed remote, `--repo=up`, `remote.pushDefault`, a pushurl/fetchurl
split, or `pushInsteadOf` each moved the default branch under the old
argv-trusting design), the default is asked of THAT url via `ls-remote
--symref`, and the refusal check is PER REF LINE from the probe's porcelain
output:

```
if [ -n "$def" ]; then
  if [ "$dst" = "refs/heads/$def" ]; then refuse; fi
elif [ "$flag" != '*' ]; then
  refuse   # default unknown: only a brand-new ref ("*") passes
fi
```

A genuinely empty bare repo (`git init --bare`, zero refs) can only ever
produce **new-ref ("*")** lines in that porcelain output — there is nothing
existing there yet to fast-forward, force, or delete — so this `elif`
already lets every one of them through, unconditionally, with no separate
"is the remote empty" check needed. Verified hands-on (see below) and via
the file's OWN existing coverage: `test/studio.credentials.test.ts`'s pure
string test named exactly this ("an unknown default refuses every EXISTING
ref moving — only a new ref (`*`) passes"), and `test/bun/git-wrapper.test.ts`
already had a real-git test proving the literal #353 scenario passes today
("a feature push to a FRESH EMPTY remote (no HEAD to resolve) goes through").

## Hands-on verification of the `ls-remote` discriminator

Confirmed with real git (2.34.1), independent of any wrapper:

- `git init --bare empty.git && git ls-remote empty.git` — exit 0, **zero
  bytes of output**. Zero refs, unambiguous.
- `git ls-remote --symref empty.git HEAD` — also empty: an unborn HEAD
  symref (pointing at a branch that does not exist yet) is never advertised.
- A repo with ONE real ref but no advertised HEAD symref for it (`git
  symbolic-ref HEAD refs/heads/master` where only `orphanbranch` actually
  exists): `git ls-remote` on it is **non-empty** (lists `orphanbranch`),
  while `git ls-remote --symref ... HEAD` is still empty (case 2: has refs,
  default unresolvable).
- Regenerating the CURRENT (unmodified) `studioGitWrapperScript()` and
  running it, by hand, against a genuinely empty bare repo for the exact
  fixture-setup shape (`git push origin trunk:refs/heads/trunk` as the
  literal first-ever push): **exit 0**, the branch lands. No refusal.

So the discriminator described by the issue (`git ls-remote <url>`,
unrestricted, empty output ⟺ genuinely empty repo) is sound and exactly
matches what the CURRENT per-ref `flag == '*'` check already encodes
implicitly (empty repo ⟹ every ref line is necessarily new).

## Why no functional change was made

I looked hard for a place to apply the literal ask (an explicit "is this
remote verifiably empty" check, inserted before the existing per-ref
decision) without functional risk, and could not find one that is both
*needed* and *safe*:

- It cannot go BEFORE the probe: the current design deliberately does not
  know the destination URL until the probe's own `To <url>` line reports
  it (#310's whole point — trusting argv/remote-config for the destination
  is exactly the class of bug #310 fixed, five different ways, all still
  covered by Group 13's tests). Determining "is it empty" ahead of the
  probe would mean going back to resolving a destination from argv/config,
  reintroducing that exact vulnerability class.
- It cannot usefully go AFTER the probe fails (`rc -ne 0`): a `git
  init --bare`-empty destination that fails its OWN dry-run early (a
  broken `receive-pack`, an unsupported push option, a malformed alias
  expansion) never prints a `To <url>` line before dying — verified
  hands-on with a synthetic flaky `receive-pack` and with `-o
  ci.skip` against a repo with no push-option support: both fail with
  **no** `To` line at all. Without a captured URL there is nothing to ask
  `ls-remote` about, so there is no safe way to except a failed probe from
  the existing fail-closed behavor even for a genuinely empty destination.
- Within the per-ref loop itself (after a `To` line IS captured), a
  genuinely empty remote produces ONLY `flag == '*'` lines by construction
  (nothing pre-existing to move any other way) — so adding an explicit
  "is it empty" branch there is a functional no-op: the `elif` already
  passes every one of those lines today.

Making a change I could not demonstrate any real behavioral need for, in
a security-critical push guard whose whole hardening history (#253, #310,
#319, #344) is "every line is deliberate, every line is measured" felt like
the wrong instinct — adding surface area / complexity for no proven gain.
So `studioGitWrapperScript()` is **unchanged** on this branch (`git diff`
against origin/main shows no functional diff in `credentials.ts`).

## What actually caused "178 bun-test failures inside a studio container"

Traced conclusively to an ENVIRONMENT artifact, not a wrapper bug — and
one the raw GitHub issue text itself already flagged as the likely
explanation ("Mac/docker localci lane clean → env quirk, not product bug"):

`test/bun/git-wrapper.test.ts` (and `localci-run.test.ts`, and every bare
`git ...` inside `bash -c` scripts in `rescue-push.test.ts` /
`bringup-hooks.test.ts` / `harvest-record.test.ts`) resolve "the real git"
via `Bun.which("git")` or plain PATH lookup. Inside a studio container,
`/usr/local/bin/git` — the studio's OWN installed safety wrapper — sits
ahead of `/usr/bin/git` on PATH BY DESIGN (that is the entire mechanism
#253/#259 built). The test file's own header names this exact hazard and
tries to skip the whole real-git lane whenever `$TMUX` is set (a studio
lead always runs inside a live tmux pane) — but in the container used to
measure #353 (and in the one this fix was built in), `$TMUX` itself is
unset even though the session runs under a studio's tmux plumbing, so the
skip never fires and the lane runs anyway with a contaminated "real git".

Measured, this session, in-container:

- Full `bun run bun-test`, `git` resolving to whatever this container's
  pre-existing `/usr/local/bin/git` was (a demonstrably STALE, pre-#310
  wrapper — its own `defaults=()` design matched the issue's quoted
  snippet verbatim, byte for byte): **117 of 117** `git-wrapper.test.ts`
  tests failed on `realGit()` fixture-setup steps, all with the exact
  quoted refusal.
- Redeploying `/usr/local/bin/git` to the CURRENT (unmodified)
  `studioGitWrapperScript()` output and rerunning the full lane: failures
  dropped from the reported ballpark straight to **33**, all now a
  DIFFERENT, clearly-named category — "real git DOES move the default
  branch — the bypass is real" tests, which need a genuinely UNWRAPPED git
  to demonstrate a bypass technique working; they fail because my
  redeployed wrapper correctly guards even THAT probe call, not because of
  any bug.
- Rerunning again with `PATH` rearranged so `/usr/bin/git` resolves ahead
  of any studio wrapper (i.e. `Bun.which("git")` is genuinely real):
  **0 failures**, `1096` tests, `1` skip (see Verification below).

This confirms the fix for "0 failures in a studio's own bun-test lane" is
test/harness hermeticity (the issue's OWN named alternative — "tests
hermetic: fixtures invoke real git ... or env var bypass scoped to the
test process"), not a `studioGitWrapperScript()` change. That is a
DIFFERENT, larger piece of work (touching `REAL_GIT` resolution across five
test files) than this task's mandate ("fix the wrapper, not the tests"), so
it is named here and left for a follow-up rather than folded into this
branch.

## What this branch actually delivers

Two new real-git tests in `test/bun/git-wrapper.test.ts`, Group 15 (renumbered
from 14 after merging origin/main, which independently landed its own
Group 14 for issue #344 at the same anchor point), citing
#353 directly, that PIN the already-correct behavior so a future change
cannot silently regress it:

1. The literal #353 scenario: a brand-new `git init --bare` remote (zero
   refs, proven via `ls-remote` printing nothing) accepts its very first
   push, even under the exact branch name a later default would take.
2. The paired case-2 guard, in the SAME test so the two cannot drift apart:
   a remote with SOME refs but an unresolvable default still REFUSES moving
   an EXISTING ref, while a brand-new ref to that SAME remote still goes
   through.

Both were GREEN against the unmodified wrapper (no RED phase for the
underlying feature — there is no bug to reproduce). The mutant-style proof
substitutes for that: `elif [ "$flag" != '*' ]` was temporarily mutated
two ways and reverted immediately after each:

- `[ "$flag" != '@@@MUTANT@@@' ]` (never true as a match ⟹ the branch always
  refuses): both new tests went RED.
- `elif false` (never refuses ⟹ any unresolved-default line passes
  regardless of flag): only the case-2 half of test 2 went RED; test 1
  stayed GREEN.

Both mutant runs (and the final revert-and-confirm-green run) were done
with `PATH` rearranged so `Bun.which("git")` in the test file resolves to
genuine `/usr/bin/git`, not this container's own studio wrapper — running
the mutant proof through a DOUBLE-wrapped "real git" (my own earlier,
unmutated wrapper reinstalled at `/usr/local/bin/git`) silently masked both
mutations the first time (the inner, unmutated wrapper re-guarded the same
push independently and produced a confusing two-message refusal) — a small
extra, concrete demonstration of exactly the test-hermeticity hazard
described above.

`git diff` against `origin/main` after reverting both mutants shows
`credentials.ts` byte-identical: this branch's only diff is the two new
tests plus this plan doc.

## Round 2 correction (2026-09-26): round 1's "0 failures" claim was measured wrong

**Round 1's PR #358 body claimed "0 failures" and "Closes #353". Both were
false, or at least measured under the wrong condition, and the maestro's
review of PR #358 caught it.** This section is the honest retraction and the
actual fix.

What round 1 got right: `studioGitWrapperScript()` itself needed no change —
that finding stands, confirmed again this round (`git diff` against
`origin/main` on `apps/fleet/src/studio/credentials.ts` is still byte-empty).

What round 1 got wrong: its own "0 failures" verification run rearranged
`PATH` by hand (`PATH=/usr/bin:/bin:$PATH`, or equivalent) so that
`Bun.which("git")` resolved to genuine git — a condition round 1's OWN plan
doc (the section above) names as needed for a clean run, but never actually
built into the test suite itself, only into the one-off command line it
happened to run by hand. A REAL studio container never runs `bun test` with
PATH rearranged that way; it always has the #253 wrapper sitting ahead of
real git, permanently, by design. Verified this round, live, inside an
actual container running the real, unmodified `studioGitSafetyCmd()` wrapper
at `/usr/local/bin/git` (no simulation needed — this task's own execution
environment turned out to already be exactly that container, confirmed by
reading `/usr/local/bin/git`'s own header text before touching anything):
with `bunfig.toml`'s preload removed, `test/bun/git-wrapper.test.ts`,
`test/bun/localci-run.test.ts` and `test/bun/memory-clone.test.ts` show
**13** wrapper-caused failures, not 0 — the exact 13 the maestro's review
named:

- 10 `git-wrapper.test.ts` "bypass is real" CONTROL tests (X1, X2, the X3-X7
  group of 7) — each one needs a genuinely UNWRAPPED git to demonstrate a
  bypass technique working at all, and each one's own `realGit()` fixture
  step throws `fleet: studios never push the default branch` instead,
  because `REAL_GIT = Bun.which("git")` resolved to the wrapper, not real
  git.
- 2 `localci-run.test.ts` fixture pushes (`sh()`'s bare
  `git push -q origin HEAD:main`, lines 206 and 222) to the test's own
  throwaway local bare repo — refused, correctly, by the wrapper, because
  from the wrapper's point of view a push at a branch literally named `main`
  IS a push at the default branch; the fixture never scoped its own PATH to
  avoid the wrapper.
- 1 `memory-clone.test.ts` fixture push (`sh()`'s second
  `git push -q ../o/fleet-memory.git main`, line 37) — same shape, refused
  for the same reason, with the refusal masked because that file's own
  `sh()` helper throws on the push's own nonzero exit rather than surfacing
  it directly at the assertion that actually fails.

## Round 2's actual fix

Test harness only, `credentials.ts` untouched:

- `apps/fleet/bunfig.toml` — a new `[test]` `preload` entry pointing at
  `apps/fleet/test/bun/real-git-preload.ts`.
- `apps/fleet/test/bun/real-git-preload.ts` (new) — runs once, before any
  test file. Reads `/usr/local/bin/git` (`STUDIO_GIT_WRAPPER_PATH`); if its
  content contains the fleet wrapper's own literal header text
  (`"fleet: issue #253"`, read off `studioGitWrapperScript()`'s actual
  generated output, not guessed), symlinks a `git` in a fresh temp dir
  straight at `/usr/bin/git` (`STUDIO_REAL_GIT_PATH` — the exact absolute
  path the wrapper itself execs) and PREPENDS that temp dir to
  `process.env.PATH`. A no-op — PATH untouched — when nothing at that path
  is the fleet wrapper (a dev machine, plain CI, or nothing installed at all).
- `apps/fleet/test/bun/git-wrapper.test.ts:56` — `REAL_GIT` changed from
  `Bun.which("git")` to `Bun.which("git", { PATH: process.env.PATH })`.
  Necessary because of a measured Bun 1.3.12 quirk: the zero-argument form of
  `Bun.which` appears to resolve against a `PATH` snapshotted once at process
  startup rather than the live `process.env.PATH` — mutating
  `process.env.PATH` after startup (exactly what the preload does) has no
  effect on a later bare `Bun.which("git")` call, only on the explicit-`PATH`
  form. Confirmed directly: a scratch test file calling both forms back to
  back, after mutating `process.env.PATH`, got the STALE wrapper path from
  the bare form and the correct, fixed real-git path from the explicit form.
  `process.env.PATH` (set exactly once, by the preload) remains the single
  source of truth either way — this is reading it correctly, not
  re-deriving it.
- `apps/fleet/test/bun/localci-run.test.ts` and `memory-clone.test.ts`
  needed NO changes: their own `sh()` helpers spread `...process.env` at
  CALL time (not module-load time), so they pick up the preload's PATH fix
  automatically once it runs first.
- `apps/fleet/test/bun/real-git-preload.test.ts` (new) — unit coverage for
  the preload's own detection logic against fake wrapper/real-git paths
  (never this machine's own `/usr/local/bin/git`), proving both the
  wrapper-detected and no-op branches, and that detection is CONTENT-based
  (the header text) rather than path-based.

## Round 2 verification, live in a real studio container (not simulated)

This task's own execution environment already had a real, unmodified
`studioGitSafetyCmd()` wrapper installed at `/usr/local/bin/git` — confirmed
by reading its header before making any change, not assumed. So this
round's proof is a REAL reproduction, not the "closest simulation" fallback
the task anticipated might be necessary:

- Preload removed (RED, the real studio condition round 1's "0 failures"
  claim never actually tested): `git-wrapper.test.ts` 109 pass / 10 fail,
  `localci-run.test.ts` 2 of its failures are wrapper refusals (the other
  ~21 are a separate, pre-existing, already-documented git-version gap —
  see below), `memory-clone.test.ts` 3 pass / 1 fail. 13 wrapper-caused
  failures total, matching the maestro's count exactly.
- Preload restored + `REAL_GIT` fix applied (GREEN, the same real studio
  condition): `git-wrapper.test.ts` 119 pass / 0 fail,
  `memory-clone.test.ts` 4 pass / 0 fail, `real-git-preload.test.ts` 5 pass /
  0 fail. `localci-run.test.ts` still shows failures, but ZERO of them are
  `fleet: studios never push the default branch` any more — every remaining
  one is `git merge-tree --write-tree: fatal: unknown rev --write-tree`,
  this sandbox's git 2.34.1 lacking a subcommand added in git 2.38, a
  pre-existing gap round 1's own `.fleet/done/353.json` already named and
  scoped out (unrelated to #353, unrelated to this fix, present identically
  on `origin/main`).
- Mutant bite-proof: temporarily changed `real-git-preload.ts`'s own
  `WRAPPER_HEADER_MARKER` to a string that can never match (the "preload
  ALWAYS thinks there's no wrapper" full-bypass mutant the task named).
  Result: 2 of `real-git-preload.test.ts`'s own 5 tests went RED (the ones
  that need detection to actually fire), AND `git-wrapper.test.ts`'s 10
  "bypass is real" controls went RED again too, with the same loud
  `fleet: studios never push the default branch` failure as the original
  bug — proving the fix is load-bearing, not a placebo, and that a full
  bypass leaves those controls MEANINGFULLY failing rather than silently
  passing for the wrong reason. Reverted immediately after; `diff` against
  the pre-mutant file confirmed byte-identical.
- `bun run check` (all 5 tsconfig projects): clean.
- `bun run apps/fleet/scripts/english-check.ts`: clean.
- `bun run bun-test` (full lane, preload active): `1095 pass, 1 skip, 23
  fail`, `1119` tests across `74` files, `[283.62s]`. Zero occurrences of
  `fleet: studios never push the default branch` anywhere in the full lane
  output. All 23 remaining failures are `localci-run.test.ts`'s pre-existing
  merge-tree gap, same count and same test names round 1 already measured
  and scoped out as unrelated.

The PR body for #358 is being corrected on this same branch to retract the
"Closes #353" / "0 failures" claim and describe this round's actual fix
instead.
