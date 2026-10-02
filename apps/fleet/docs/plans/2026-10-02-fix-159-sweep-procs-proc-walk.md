# Fix `sweep_procs`'s per-`/proc`-entry forking (board issue #159)

## Root cause

`apps/fleet/scripts/localci/localci.sh`'s `sweep_procs()`, Linux branch
(`[ -d /proc/self ]`): looped `for d in /proc/[0-9]*` over **every process on
the whole host** (not just this run's own tree), and for each one forked
`tr '\0' ' '` (cmdline), `readlink` (cwd), and `tr '\0' '\n'` (environ) -- 3
external-process forks per host process, for a cost of
`O(3 × host-wide process count)`, not `O(this run's own processes)`. Called
**twice** per interrupted run: once in `--lanes`' `stop_lanes()` (its
TERM/INT/HUP trap), once in the main flow's `cleanup()` (its EXIT trap).

Issue #382 (`docs/superpowers/plans/2026-09-26-sigterm-timing-flake-382.md`)
measured this exact mechanism on a process-dense `/proc` (~1550-1600
processes): the SIGTERM-mid-lane test and its sibling failed at 18-24s
against widened 15s budgets, and a clean `unshare --pid --mount-proc`
namespace (small, realistic process count) passed the same tests in
~1.6s. That doc explicitly flagged optimizing `sweep_procs` itself as "out of
scope... worth its own follow-up issue" and added `test/bun/localci-run.test.ts`
to `known-flaky.txt` as a stopgap. Issue #159 is that follow-up: the same
mechanism now reproduces as HARD 60s test timeouts on an even more
process-dense host, not just soft budget overruns.

## The fix

Replaced the Linux branch's O(host-process-count) forking with O(1) forking
for the **whole** sweep:

- **cwd**: one batched `ls -la /proc/[0-9]*/cwd` up front, captured once into
  `cwd_hits`. Per-pid membership is then a bash pattern match on the
  in-memory string (`case "$cwd_hits" in *"/proc/$pid/cwd"*)`), no fork.
  Verified the anchor reasoning holds: the match pattern requires `/proc/`
  immediately before the pid digits and `/cwd` immediately after, so a
  shorter pid's pattern (e.g. `/proc/12/cwd`) can never match inside a
  longer pid's line (e.g. `/proc/123/cwd`) -- the character right after `12`
  there is `3`, not `/`.

  **Review fix (post-initial-implementation):** the first version filtered
  `cwd_hits` with a bare `grep -F -- "$wp"`, matching ANY line merely
  *containing* `$wp` as a substring -- including a sibling worktree whose
  path extends `$wp` with no separator in between. `localci.sh`'s own
  `RID="$(date +%Y%m%d-%H%M%S)-$$"` ends in a raw, unpadded pid, so two runs
  close together can produce `wt-...-1` and `wt-...-12` on disk at the same
  time (before the gate lock serializes the lanes) -- `wt-...-1` is a literal
  character-prefix of `wt-...-12`. A fresh-context code review reproduced
  this live: sweeping for `wt-1` also killed `wt-12`'s process, where the
  pre-#159 code correctly spared it. Fixed by anchoring `$wp` the same way
  the old `[[ "$cwd" == "$wp" || "$cwd" == "$wp/"* ]]` did -- `$wp` itself,
  followed by either end of line (exact cwd) or `/` (a child of it):
  `grep -E -- "${wp_re}(/|$)"`, where `wp_re` is `$wp` escaped for ERE
  metacharacters (`sed 's/[.^$*+?()[\]{}|\\]/\\&/g'`, computed once per
  sweep call via one `sed` fork -- still O(1) for the whole sweep, not
  O(host-wide process count); verified the fix's timing claim below still
  holds with this one extra one-time fork in place).
- **cmdline**: bash's own NUL-delimited `read` builtin reads
  `$d/cmdline` directly, one argv element at a time, no fork at all:
  `while IFS= read -r -d '' arg; do case "$arg" in *"$w/"*|*"$wp/"*) ... ;;
  esac; done 2>/dev/null <"$d/cmdline"`.
- **environ**: same shape, exact match per NUL-delimited entry:
  `while IFS= read -r -d '' kv; do [ "$kv" = "LOCALCI_RUN=$rid" ] && ...; done
  2>/dev/null <"$d/environ"`.

One subtlety found while implementing: **redirection order matters**. Bash
applies redirections left to right; `done <"$d/cmdline" 2>/dev/null` tries to
open `$d/cmdline` for stdin *before* stderr is redirected to `/dev/null`, so
an open failure (process already gone) still prints to the real stderr.
Fixed by putting `2>/dev/null` *before* the `<file` redirection on each
`done` line, so stderr is already silenced when the open is attempted.

Net effect: the whole Linux branch of `sweep_procs`, across the entire
`/proc` scan, now forks exactly 2 external processes total (`ls` and `grep`,
piped) instead of up to `3 × (number of host processes)`.

The macOS branch (`ps`/`lsof`, already batched, never per-process forking)
is untouched, per the issue's and #382's scoping.

Also added a test-only `--sweep-procs-only <worktree> <run-id> [spares...]`
hook right after the function definition, so
`test/bun/sweep-procs.test.ts` can call the real `sweep_procs` directly
without running the rest of the script.

## Empirical before/after timing

Measured in this container's own, genuinely process-dense `/proc`
(`ls -d /proc/[0-9]* | wc -l` was **11439** before the fix, **11520** after --
this container runs many concurrent sibling agent sessions sharing a PID
namespace, plus 16 accumulated, never-reaped `ego-browser/daemon.ts`
processes from a separate, out-of-scope leak).

**Before** (unmodified `sweep_procs`, extracted into a standalone throwaway
script reproducing exactly the Linux branch's logic, called once against a
worktree/run-id that matches nothing real, so the measurement is pure
`/proc`-walk overhead):

```
$ time bash sweep_before.sh   # unmodified Linux branch, one call
victims count: 0
real    1m11.940s
user    0m51.471s
sys     0m22.446s
```

Over a **minute** for a single call. `sweep_procs` runs **twice** per
interrupted run (`stop_lanes` + `cleanup`), so an interrupted run on this host
paid upward of two minutes just walking `/proc` twice -- which is exactly why
`localci-run.test.ts`'s SIGTERM-mid-lane tests were hitting hard 60s test
timeouts, not just blowing a soft budget.

**After** (the fix, invoked for real through `localci.sh
--sweep-procs-only`, same host, same `/proc` density range):

```
$ time bash scripts/localci/localci.sh --sweep-procs-only /tmp/nonexistent-worktree-fake-xyz run-id-fake-abc "$$"
real    0m1.337s / 0m1.218s / 0m1.264s   # 3 runs
```

~1.2-1.3s per call -- roughly a **55-60x** reduction, and comfortably inside
every timing budget in `localci-run.test.ts` (10s/15s/60s), including when
`sweep_procs` runs twice per interrupted run.

Chose the standalone-script method (rather than only the end-to-end test) so
the "before" number is unambiguous: a single call to the unmodified Linux
branch, not conflated with `gh`/`docker`/`git` fork overhead or test-harness
setup cost that the full `localci-run.test.ts` tests also carry (and which
#382 already attributed much of the Mac/docker-mode flake to). The same
method, re-run against the fixed code, gives an apples-to-apples comparison.

## TDD: a direct correctness test, RED-checked before relying on it

This is a performance fix with no new externally-visible behavior (same
three match criteria, same `kill -TERM`/sleep/`kill -KILL` behavior), so a
conventional RED/GREEN against new behavior doesn't apply. Instead, added
`test/bun/sweep-procs.test.ts`: a direct, fast test that calls the real
`sweep_procs` (via the new `--sweep-procs-only` hook) against four real decoy
processes -- one whose cmdline names a path under a fake worktree, one whose
cwd is under it, one carrying `LOCALCI_RUN=<rid>`, and one unrelated decoy
that must survive -- and asserts the three matching ones die while the
unrelated one doesn't.

RED check: with the fix's three match arms each temporarily broken in turn
(cmdline arm matched against a string that can never occur; cwd arm matched
against `cwd_hits` with an impossible substring; env arm compared against a
value that can never occur), the test failed each time, pointing at exactly
the broken decoy (`dead(cmdlineDecoy.pid)`, `dead(cwdDecoy.pid)`,
`dead(envDecoy.pid)` respectively). Reverted each break immediately after
confirming the failure; `diff` against a saved copy of the fixed file
confirmed the working tree was restored exactly.

One deviation from a literal "write the test against the still-unfixed
code first" ordering: the **unmodified** `sweep_procs` takes over a minute
per call on this host (see the "before" measurement above), which blows
through any reasonable bun test default timeout regardless of whether a
match arm is broken or not -- running the RED check against the genuinely
unfixed function would fail on a timeout, not a meaningful assertion,
and isn't a useful safety-net signal. So the RED check was performed by
injecting synthetic breakage into the already-fixed implementation instead
(three separate, reverted edits, one per match arm) -- this still satisfies
the stated intent ("confirm this test can actually fail before relying on it
as a refactoring safety net") without spending minutes of container time per
broken-arm trial against code already known to be too slow to use under any
test budget.

Added a second correctness test for the review finding specifically: "a
sibling worktree whose path is a literal character-prefix extension is never
matched by cwd" -- creates `wt-1` and `wt-12` as siblings, puts a decoy
process in each, sweeps for `wt-1`, and asserts `wt-12`'s process survives
while `wt-1`'s own exact-cwd process still dies (proving the fix didn't just
disable cwd matching altogether). RED-checked by reverting *only* the
`cwd_hits` line to the original bare `grep -F -- "$wp"` (reusing a saved
backup of the review-fixed file for the revert) and re-running: the new
sibling test failed exactly as the reviewer described (`wt-12` killed when
targeting `wt-1`), while the first (pre-existing) correctness test still
passed (it doesn't exercise prefix siblings). Restored the fix immediately
after confirming (`diff` against the backup showed the restore was exact).

## Verification run (this container, same dense `/proc`)

- `bun test test/bun/sweep-procs.test.ts`: 2 pass, 0 fail, ~5.2-5.6s (both
  correctness tests, final GREEN, review fix in place).
- Re-measured the fix's timing claim after the review fix (`/proc` density
  ~12900 at the time): `real 0m1.447s / 0m1.303s / 0m1.267s` across 3 runs of
  `localci.sh --sweep-procs-only` -- the one extra one-time `sed` fork for
  escaping `$wp` adds no measurable regression versus the ~1.2-1.3s measured
  before the review fix, both still ~55-60x faster than the ~72s pre-#159
  baseline.
- `bun test test/bun/localci-run.test.ts` (whole file, 34 tests), run 2 more
  times after the review fix: 34 pass / 0 fail each time, ~66s / ~70s total
  (no per-test timeout failures; consistent with the pre-review-fix runs).
- `bun test test/bun/localci-run.test.ts -t "a hung lane is killed at its
  timeout|start sweeps a killed run|SIGTERM mid-lane|SIGTERM with a lane that
  ignores TERM"` (the 4 tests #159 named), run 3 times back to back (before
  the review fix, same code path for these tests either way since none of
  them exercise sibling-prefix worktrees): 4 pass / 0 fail each time, ~22s
  total each run.

## Files touched

- `apps/fleet/scripts/localci/localci.sh` -- the fix (Linux branch of
  `sweep_procs`, O(1) forking), plus the `--sweep-procs-only` test hook.
- `apps/fleet/test/bun/sweep-procs.test.ts` -- new direct correctness test.
- `apps/fleet/docs/plans/2026-10-02-fix-159-sweep-procs-proc-walk.md` -- this
  doc.

Not touched, per this task's scope: `apps/fleet/scripts/localci/known-flaky.txt`
(the existing #382 safety-net entry stays -- this fix should make it fire
less, but removing the fallback is a separate decision); the ego-browser
daemon idle-shutdown leak that keeps this container's `/proc` dense (a
separate, already-flagged concern).
