# Rescue push fails when a private rescue remote lacks the work repo's base objects (board issue #140)

## Measured incident (2026-09-30)

Studio clones are shallow (`--depth 1`). Rescue pushes to a separate
private rescue remote. When that remote's history is genuinely disjoint
from the work repo's (a fresh public repo whose rescue remote has never
seen it, possibly already holding OTHER studios' unrelated refs/objects),
the push failed: `did not receive expected object <sha>` /
`[remote rejected] ... (failed)`. `rescue-all` then marked the gate
UNSAFE and refused the deploy (correct), but only a manual seed of the
rescue remote with the work repo's main unblocked it.

Issue #16 already built the exact fallback this needed: a parentless
snapshot commit (`commit-tree "$src^{tree}"`, no `-p`) pushed to the same
ref when the first attempt fails, because a parentless commit has no
history for ANY disjoint-remote check to trip on. That fallback
(`rescue_try_push`, `apps/fleet/src/studio/rescue.ts`) is well-tested
(`test/bun/rescue-push.test.ts`'s "issue #16" describe block, real git,
real `--depth 1` clones, real empty/non-fast-forward private remotes via
`file://`). The gap #140 reports is narrower: the trigger condition is a
literal `grep -qi 'shallow update not allowed'`, and the REAL error text
observed against a real private remote was different wording entirely —
so the already-correct fallback never fired.

## What was verified, not just suspected

The board issue's own "Want" section offered two fixes. The second —
"pushes with enough history to be self-contained" — is exactly what the
existing parentless-snapshot fallback already does. The first — seed/
refresh a base ref on the rescue remote from `origin/main` before pushing
— doesn't hold up: the studio's own clone is ITSELF `--depth 1`, so there
is no local "full main history" to seed the rescue remote with beyond
what's already being pushed, and a whole separate seeding push per
rescue is a lot of new surface (an extra network round-trip, an extra ref
namespace, an extra failure mode) for no real gain over widening the
fallback that already exists and is already proven correct for the
closely related shallow-empty-remote case. Went with widening the grep.

### Step 1: reproducing the real error, live, against real git

Set up a real `--depth 1` clone of a real bare origin, and a real bare
private remote with genuinely disjoint history (seeded from an unrelated
local repo), exactly the shape `test/bun/rescue-push.test.ts`'s own issue
#16 fixture already uses. Tried, all against the REAL `/usr/bin/git`
(2.55.0), all real pushes, no network:

- Empty disjoint remote, brand-new ref → `shallow update not allowed`
  (the case #16 already handles).
- Disjoint remote with UNRELATED existing refs/history (not empty),
  brand-new ref → still `shallow update not allowed` (the "ours/theirs"
  history on the remote doesn't matter to this check).
- Existing ref name with unrelated content (forces a non-new-branch
  negotiation) → the ordinary client-side non-fast-forward rejection
  (`! [rejected] ... (fetch first)`) — a different, ALREADY-correctly-
  unhandled case (this is a REAL conflict, not a shallow-history gap; the
  existing grep correctly does NOT match it, and shouldn't).
- Multiple local commits ahead of the shallow boundary, pushed to a
  brand-new ref → same `shallow update not allowed`.
- `receive.shallowUpdate=true` on the remote → every one of the above
  scenarios (including a merge-commit shallow boundary, and a client that
  `fetch --depth=2`-deepened before pushing) succeeded CLEANLY, no error
  at all — vanilla git's `receive-pack` has its own grace window for a
  genuinely shallow client (`setup_temporary_shallow`'s `alt_shallow_file`,
  gated on `prepare_shallow_info`'s `nr_ours`/`nr_theirs` classification;
  read straight from `git/git`'s own `builtin/receive-pack.c` and
  `shallow.c`, cloned locally via `git clone --depth 1
  https://github.com/git/git.git` to check — real source, not guessed).
  `receive.fsckObjects=true` alongside `shallowUpdate=true` didn't change
  this either: the grace window's temporary shallow file is threaded
  through to the STRICT/fsck connectivity check too.
- Protocol v0 vs v2, thin vs `--no-thin` pushes: no difference in any of
  the above.
- A smart-HTTP transport via `git-http-backend` (closer to how a real
  hosted remote like GitHub actually receives a push than local `file://`)
  was attempted (a local CGI server via Python's `http.server --cgi`) to
  see whether the wire-level negotiation differs from `file://`'s direct
  pack transfer — blocked by this container's own sandbox refusing
  `execve` of a dynamically-written CGI script from a background Python
  subprocess (`PermissionError: [Errno 13]`), not a git limitation. Not
  pursued further given the direct evidence found instead (below).

None of these, across every combination reachable with this sandbox's
real local git, ever produced `did not receive expected object` through
an ACTUAL `git push` — vanilla git's own receive-pack is specifically
hardened against it for a genuinely shallow client.

Found the actual mechanism by reading git's own source instead of
guessing further. `did not receive expected object %s` is not a
paraphrase — it's the EXACT string `die()`'d by `check_object()` in
`git/git`'s `builtin/index-pack.c:265` (confirmed present verbatim in this
container's own installed git binary too, via `grep -a -o` against
`/usr/bin/git`), fired by index-pack's STRICT/fsck connectivity check
(`receive.fsckObjects`, common on a real hosted git backend that validates
incoming pushes) when a "linked" object — a commit's own parent pointer,
or a tree's blob/tree entry — resolves to an OID that is neither in the
incoming pack nor already in the receiving repo's own object database.
A shallow clone's boundary commit still literally contains a `parent
<sha>` field in its raw bytes (git never rewrites it away; `.git/shallow`
just tells the LOCAL client to stop walking past it) — exactly the
"missing linked object" shape `check_object()` flags, UNLESS the
receiving side's OWN grace window (above) suppresses it for this push.

Reproduced the literal message directly, for real, with real git: built a
real two-commit repo (`X` → `Y`), extracted the object list for `Y` alone
(`git rev-list --objects Y ^X`, i.e. exactly what a shallow boundary at `Y`
looks like from the outside — `Y`'s commit references parent `X`, which
is NOT in this object list), packed it with `git pack-objects --stdout`
(no `--thin`, so every object in the pack is stored whole, not as an
unresolved delta — ruling out "unresolved delta" as a confound), and fed
that pack into a FRESH empty bare repo via `git index-pack --strict
--stdin`:

```
fatal: did not receive expected object 1a3e2a9f0d708b8dcec96badfd1bdad433f97cc7
```

Byte-identical to the board issue's own quoted text, with `X`'s own real
sha. This confirms the mechanism directly: a genuinely hosted backend
whose receive path runs strict/fsck connectivity checking on an incoming
shallow push, WITHOUT carrying vanilla local git's own shallow-grace
window through to that check, hits exactly this message for exactly the
scenario #140 describes — a rescue remote that has never seen the history
behind the shallow boundary. Mechanically identical in kind to "shallow
update not allowed" (both are the receiving side discovering the same
fact), just surfaced by a different code path/config combination than
this sandbox's own local git ever reaches. The broadened-grep hypothesis
(step 3 below) is the right fix; no genuinely different root cause was
found that it can't reach.

## The fix

### `rescue_try_push`'s fallback trigger (`apps/fleet/src/studio/rescue.ts`)

One grep, one call site, shared by both `rescuePushCmd` and
`rescueSnapshotCmd` (line ~287, was line ~253 before this fix's doc
comment grew):

```diff
-  printf '%s' "$perr" | grep -qi 'shallow update not allowed' || return 1
+  printf '%s' "$perr" | grep -qiE 'shallow update not allowed|did not receive expected object' || return 1
```

Deliberately NOT broadened to something generic like `(failed)` or
`rejected` alone — that would fire the parentless-snapshot retry on a
genuine, unrelated rejection (permission denied, branch protection, a
repo's own pre-receive hook) too, masking the real error with a second,
equally-doomed push and burning budget for no reason. `rescueTryPushFn`'s
own doc comment (above the function) and the "issue #16" describe block's
leading comment (`test/bun/rescue-push.test.ts`) were both extended to
document the broadened trigger and point at issue #140.

## TDD

RED first, real commit, pushed before the fix. `test/bun/
rescue-push.test.ts`'s existing "issue #16" describe block gained one new
test, since vanilla local git (per the step-1 investigation above) can't
be coaxed into producing the real wording end-to-end through an actual
`git push` — the same test seam every other private-remote test in this
file already uses (a `realGit` shim) stands in for the hosted backend
instead: the shim answers the FIRST push attempt with the real observed
wording (`did not receive expected object <sha>` + `[remote rejected]
... (failed)`, non-zero exit), then `exec`s the REAL git for the SECOND
attempt (the snapshot fallback's own retry), so the recovery is proven
for real — content landing on `priv`, checked the same way every other
issue #16 test checks it (`git -C priv show <ref>:...`, tree/commit-count
assertions) — not just asserted by exit code.

Confirmed RED before the fix, for the right reason:

```
expect(out).not.toContain(RESCUE_FAILED_PREFIX)
Expected to not contain: "RESCUE_FAILED"
Received: "RESCUE_FAILED checkout push\nRESCUE_WT checkout failed push"
```

— today's code hits the shim's fabricated failure, doesn't match the old
grep, and returns 1 immediately: the snapshot fallback never even
attempts a second push (confirmed separately: the shim's own attempt
counter stayed at 1). After widening the grep, GREEN: `RESCUE_PUSHED
fleet/rescue/<studio>-<ts> 1 files`, a parentless single-commit ref on
`priv` holding the right tree, and the shim's counter at 2 (both the
failed first attempt and the landed second).

**Mutation / bite-proof check** (not committed, run live): temporarily
reverted the grep back to `grep -qi 'shallow update not allowed'` (the
pre-fix text). The new issue #140 test went RED again, for the same
reason as before the fix (`RESCUE_FAILED checkout push`, snapshot never
attempted). `git diff --stat` after reverting the revert showed zero diff
(the file was back to the fixed state exactly). Reconfirmed the full
"issue #16" describe block green again (8/8) after restoring the fix.

## Regression guard

Re-ran the "issue #16" describe block in full (8 tests, including the
pre-existing "shallow + non-fast-forward: a push the budget cannot cover
is never started" test, which depends on the grep's specificity around
non-fast-forward vs. shallow) — all 8 green, no change in behavior for
any of them.

Negative case ("a genuinely unrelated real rejection still fails loud,
never masked by an inappropriate snapshot retry"): this is already
effectively covered by several pre-existing tests in this same file that
exercise `rescue_try_push` against a REAL rejecting `pre-receive` hook
with arbitrary, unrelated wording (`"policy says no"`, `"branch policy
says no"`, `"stash policy says no"`, and a bare `exit 1` with no output
at all) — none of that text contains either grep alternative, so all of
them stay `RESCUE_FAILED <wt> push` with the real rejection's stderr
surfaced verbatim, exactly as before this change. Re-ran the `"REJECTS"`-
named tests (6 of them) after the fix: 6/6 pass, unaffected. No new test
added for this case — the existing coverage already proves the grep's
specificity, and the one substring this fix adds (`did not receive
expected object`) is specific enough that no existing hook-message
fixture in this file accidentally contains it.

## Deviation from the task's own suggestion

The task's "Want" quote offered "rescue seeds/refreshes a base ref on the
rescue remote ... before pushing" as one option. Not implemented — see
"What was verified" above: the studio's own clone is itself `--depth 1`,
so there's no local "full main history" to seed with, and it would add a
new push, a new ref namespace, and a new failure mode for no benefit over
widening a fallback that's already built, already tested, and already
proven correct for the closely related empty-remote case.

## Verification

Run sequentially, one gate at a time, per this container's memory-ceiling
discipline.

1. Scoped (`test/bun/rescue-push.test.ts` lives under `bun-test`'s scope,
   not vitest's `test` script — confirmed directly: `cd apps/fleet && bun
   run test -- test/bun/rescue-push.test.ts` returns `No test files
   found, exiting with code 1` because this script's vitest `exclude`
   list explicitly excludes `test/bun/**/*.test.ts`). Ran the real scoped
   suite instead, `bun test test/bun/rescue-push.test.ts` (bun-test's own
   underlying invocation, scoped to one file):
   - Before the fix (RED): `-t "issue #140"` → `0 pass / 1 fail`, the
     exact failure quoted above.
   - After the fix (GREEN): `-t "issue #140"` → `1 pass / 0 fail`.
   - `-t "issue #16"` → `8 pass / 0 fail` (50 expect() calls).
   - Full file → `132 pass / 0 fail` (491 expect() calls), `71.55s`.
2. `bun run check` (once, alone) — all 5 tsconfig projects (`tsc --noEmit`,
   `container`, `cli`, `test-integration`, `test`), clean, no output.
3. `bun run bun-test` (full bun test suite, once, alone) — exit code 1:
   `2125 pass, 2 skip, 10 fail, 1 error, 5861 expect() calls. Ran 2137
   tests across 113 files. [1951.51s]`. All 11 failures (10 fail + 1
   error) confirmed pre-existing and environmental by reading the full
   failure list, none touching `rescue.ts` or `rescue-push.test.ts`:
   - 5 in `test/bun/localci-run.test.ts`: wall-clock timing budgets
     flexing under this run's host load — e.g. `expect(Date.now() -
     t0).toBeLessThan(30_000)` received `55371.09ms`; two more timed out
     at their own 60000ms test timeout (`55371.09ms`/`60050.64ms`/
     `60052.24ms` fail entries: "a hung lane is killed at its timeout",
     "SIGTERM mid-lane", "SIGTERM with a lane that ignores TERM"; a 4th,
     "start sweeps a killed run", hit a 60000ms test timeout directly at
     100999.38ms); the 5th surfaced as "# Unhandled error between tests"
     — a `toBeLessThan(15_000)` assertion in the same file's sweep-timing
     test, same host-load class, firing async after its own test's window
     closed.
   - 6 in `test/bun/deploy-ops-guard.test.ts`: this container's own
     git-push safety wrapper refusing the test's own throwaway
     local-origin push with `error: git push -q origin main: fleet:
     studios never push the default branch — open a PR` — the wrapper
     can't distinguish the test's local sandbox push from a real one.
     Tests: "deploy.sh refuses a dirty or stale ops checkout (#365) > HEAD
     behind its upstream...", "round 2 (#368 review): 'committed' means
     tracked AND equal to HEAD (#365) > a gitignored, never-committed
     config...", two under "#377: only the config's own history decides",
     "#380: the config path is matched literally...", "#383: follow-ups
     from the #381 review...".
   This is the same failure class already documented as pre-existing/
   environmental in `docs/superpowers/plans/2026-09-30-recycle-cli-hang-133.md`'s
   own Verification section (that run saw a smaller instance of the same
   two classes).
4. `bun run test` (full vitest suite, once, alone) — exit code 0:
   `Test Files 153 passed (153); Tests 5384 passed (5384); Duration
   161.41s`. Clean, no failures.
5. `bun run english-check` — exit code 0: `english-check: clean`.

## Fresh review round 1 (maestro, FIX-FIRST, 2026-10-01) — test fixture made faithful, a missing failure-path test added

PR #155 was converted to draft by a maestro review verdict FIX-FIRST,
test-only — the production fix in `rescue.ts` was confirmed correct as-is,
no change made to it this round. Board comment posted 2026-10-01 on issue
#140. Two findings.

Finding 1 (block): the original "issue #140" test (the one quoted in this
doc's own Verification section above) was a shim, not a reproduction — a
`realGit` wrapper that counted its own invocations in a file and
fabricated the real-world error text on attempt 1 only, then `exec`'d real
git on attempt 2. That pins rescue.ts's OWN code path faithfully (the grep
really does match, the retry really does run) but proves nothing about
whether a REAL remote would ever produce that failure+recovery shape
against this fix's actual mechanism (a parentless commit with no history
for ANY connectivity check to trip on). Replaced with a fully real
reproduction: a non-empty bare remote carrying disjoint history (an
orphan repo's own commit pushed to an unrelated `task/other` branch, the
same shape the existing "shallow + non-fast-forward" fixture already uses
for `task/lead`), `receive.shallowUpdate=true` (so vanilla git's own pre-
transfer "shallow update not allowed" can never fire here — isolating the
coverage to the grep's NEW alternative only, not re-proving the old one),
and a real `pre-receive` hook on the remote side that rejects a push
whose new history still carries a parent pointer to an object this repo
never received, printing the real `fatal: did not receive expected object
<sha>` text and exiting 1. No `realGit` override anywhere in either new
test: real git, both sides, the whole way.

Building that hook correctly took two live corrections, both verified
against real git in a scratch directory before being trusted in the test
(this fix's own established convention — "verified live," never assumed):

- **A one-level parent check is not enough.** The maestro's own wording
  ("walks the new commit's own parent(s)") reads as checking only the ref
  tip's immediate parent. Verified live that this is insufficient: with a
  shallow clone carrying 2 real local commits ahead of the shallow
  boundary (the maestro's own explicit ask — "a shallow clone WITH local
  commits", not just a dirty file), the ref tip pushed is the newest local
  commit, whose own immediate parent is the OTHER new local commit — also
  part of the same push, so present post-unpack. The missing object (the
  boundary commit's own parent) sits two hops further back. A hook that
  checks only `$new`'s own direct parents never saw it; the push
  succeeded outright, silently proving nothing. Fixed by walking the FULL
  set of commits newly reachable from each ref update's tip (a worklist,
  not a single level) — the same shape real git's own `index-pack`
  connectivity check actually walks (the whole pack, not just the tip),
  which is what this fix is reproducing in the first place.
- **`git rev-parse <sha>^@` is shallow-aware and lies once the RECEIVING
  repo itself turns shallow.** First hook draft read parents via
  `rev-parse "$c"^@`. Verified live: `receive.shallowUpdate=true`'s own
  mechanism writes a `.git/shallow` entry on the RECEIVING bare repo,
  recording the boundary commit as a graft point, as a side effect of the
  very push under test — before the hook even runs. Once that file
  exists, `rev-parse <boundary-sha>^@` on the receiver returns EMPTY, even
  though `git cat-file -p <boundary-sha>` still shows the real `parent
  <sha>` line in the object's raw bytes. A hook built on `rev-parse` never
  saw the missing parent at all and accepted every push unconditionally.
  Fixed by reading each commit's parent lines straight off `git cat-file
  -p ... | sed -n 's/^parent //p'` — the raw bytes, never shallow-aware,
  exactly what `check_object()` in `index-pack.c` itself inspects.

Both corrections were caught by building the exact fixture by hand in a
scratch directory first (a throwaway bare remote, the same orphan-branch
seeding, the hook script, a real `--depth 1` clone with 2 real commits on
top) and confirming with real git: the first plain push attempt genuinely
fails with stderr containing `did not receive expected object <sha>`, and
a parentless snapshot genuinely lands (`rev-list --count` = 1) against
the identical hook — before either line of the actual test file was
written as a foregone conclusion.

Finding 2 (should-fix): no test pinned that `rescue_try_push`'s own
snapshot RETRY push is checked for failure, not assumed to succeed — a
mutant that dropped the second `[ "$prc" = 0 ] && return 0` check (or
otherwise ignored the retry's exit code) would stay green under every
existing test, since none of them ever made the snapshot push itself
fail. Added a second test: same disjoint-history/`shallowUpdate` remote,
but the hook now rejects EVERY push unconditionally — first attempt and
the parentless retry alike — with wording the grep still matches either
way. Confirmed RED first against a deliberately broken version of this
exact test (hook mutated to accept everything) to prove the assertion can
actually fail before trusting it: `expect(out).toMatch(/^RESCUE_FAILED
checkout push$/m)` failed with `Received: "RESCUE_PUSHED fleet/rescue/...
1 files\nRESCUE_WT checkout pushed ..."` — then reverted to the real
always-reject hook and reran GREEN. The new-fixture-1 test ("issue #140")
was separately RED-checked the same way, with the hook mutated to accept
everything: the `rev-list --count` assertion failed with `Received: "3"`
(a normal 3-commit push landed, not the parentless snapshot) — confirming
that test's own assertions are load-bearing on the real rejection+
recovery mechanism, not vacuously true against any real git push.

### Round 1 re-verification (2026-10-01)

- Scoped bun test (`apps/fleet`, `bun test test/bun/rescue-push.test.ts`):
  133 pass, 0 fail, 494 `expect()` calls — 1 more test than before (the old
  shimmed "issue #140" test replaced by 2 new real-hook-based tests, net
  +1).
- `bun run check` (fast, scoped tsc run across this repo's 5 tsconfig
  projects) — clean, no output, re-run once after the test file's final
  state.
- Heavy gates (full `bun-test`/`test`/`english-check`) intentionally not
  re-run this round — out of scope for a test-only fixture fix, sequenced
  by the lead afterward per this round's own instructions.
