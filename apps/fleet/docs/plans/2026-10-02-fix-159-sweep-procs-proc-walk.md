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

- **cwd**: one batched `ls -la /proc/[0-9]*/cwd 2>/dev/null | grep -F -- "$wp"`
  up front, captured once into `cwd_hits`. Per-pid membership is then a bash
  pattern match on the in-memory string (`case "$cwd_hits" in
  *"/proc/$pid/cwd"*)`), no fork. Verified the anchor reasoning holds: the
  match pattern requires `/proc/` immediately before the pid digits and `/cwd`
  immediately after, so a shorter pid's pattern (e.g. `/proc/12/cwd`) can
  never match inside a longer pid's line (e.g. `/proc/123/cwd`) -- the
  character right after `12` there is `3`, not `/`.
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

## Verification run (this container, same dense `/proc`)

- `bun test test/bun/sweep-procs.test.ts`: 1 pass, 0 fail, ~2.5s (new
  correctness test, final GREEN).
- `bun test test/bun/localci-run.test.ts` (whole file, 34 tests), run 3 times
  back to back: 34 pass / 0 fail each time, ~62s / ~65s / ~66s total (no
  per-test timeout failures).
- `bun test test/bun/localci-run.test.ts -t "a hung lane is killed at its
  timeout|start sweeps a killed run|SIGTERM mid-lane|SIGTERM with a lane that
  ignores TERM"` (the 4 tests #159 named), run 3 times back to back: 4 pass /
  0 fail each time, ~22s total each run.

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
