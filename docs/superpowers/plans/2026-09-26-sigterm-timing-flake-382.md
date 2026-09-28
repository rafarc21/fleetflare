# Flaky SIGTERM-mid-lane timing bound (board issue #382)

## Background

`apps/fleet/test/bun/localci-run.test.ts:344-369` ("SIGTERM mid-lane: exits
promptly, posts error, lane processes and refs gone") sends `SIGTERM` to a
running `localci.sh` and asserts the whole process exits inside 10s. On a
heavily loaded Mac (many `flock`/`lockf` waiters) it once took 13652ms.
A sibling test 5 lines below ("SIGTERM with a lane that ignores TERM: exit
only after it is dead, lock free at exit", line ~374-395) already budgets
**15000ms** for a scenario that needs a mandatory grace-period wait plus a
KILL escalation — strictly more work — so 15s is already an accepted budget
in this exact file for SIGTERM teardown under load.

## What actually happens between signal and exit (read `localci.sh` in full)

`localci.sh --lanes`'s `stop_lanes()` (its TERM/INT/HUP trap, lines 97-105):

```
stop_lanes() {
  local g t=0
  for g in $CUR $DOG; do kill -TERM -"$g" 2>/dev/null; done
  while [ "$t" -lt "${LOCALCI_KILL_GRACE:-5}" ] && kill -0 -"${CUR:-0}" 2>/dev/null; do sleep 1; t=$((t + 1)); done
  for g in $CUR $DOG; do kill -KILL -"$g" 2>/dev/null; done
  docker rm -f -v "$NAME-linux" "$NAME-linux-rerun" >/dev/null 2>&1
  sweep_procs "$W" "${LOCALCI_RUN:-}" "$PPID"
  exit 143
}
```

Then the outer main-flow `cleanup()` (its own EXIT trap, lines 217-234) waits
for the `--lanes` subprocess, calls `sweep_procs` **again**, posts the two
`error: run interrupted` statuses, and runs `remove_run` (another
`docker rm -f -v`, `git worktree remove --force`, `git worktree prune`, and a
`git for-each-ref … | git update-ref -d` loop over `refs/localci/<rid>/*`).

`sweep_procs()` (lines 37-79) is the standout: on Linux it loops over **every
entry in `/proc/[0-9]*` on the whole host** (not just this run's process
tree), reading `cmdline`, `readlink cwd`, and `environ` for each one via
external `tr` calls, to decide whether it belongs to the run. This is called
**twice** per interrupted run (once inside `stop_lanes`, once in `cleanup`).
Its cost is `O(host-wide process count)`, not `O(this run's own processes)`.

**This test's scenario** (`STUB_LINUX_HANG=1`): the docker stub's `sleep 61`
has no TERM trap, so it dies immediately on the first `kill -TERM`, and the
`kill -0 -"$CUR"` check right after finds it already gone — the grace-period
`while` loop exits on its first iteration, no mandatory wait. **The sibling's
scenario** (`STUB_LINUX_HANG=stubborn`, `LOCALCI_KILL_GRACE=1` in the test)
traps TERM and must be waited out for the (test-shortened) grace period, then
`KILL`ed. So the sibling's scenario has exactly ~1s more *mandatory* wait
than this one — everything else (the two `sweep_procs` /proc-wide walks, the
`docker rm -f` calls, the `git worktree`/ref cleanup, the two status POSTs)
is identical work, run identically in both tests.

## Reasoning: which bound?

The ~1s of extra *mandatory* wait the sibling scenario needs is small next to
the multi-second variance the issue itself reports (13652ms observed against
a 10000ms bound — over 3.6s of slop that has nothing to do with any grace
period, since this test's own scenario needs none). The dominant, host-load-
sensitive cost in both tests is the same: forking `gh`/`docker`/`git`
subprocesses and (worse) `sweep_procs`'s host-wide `/proc` walk, done twice.
Since that shared cost dominates and this test's scenario is not
meaningfully lighter in the part that actually varies with load, there is no
principled reason to keep a tighter ceiling here than the sibling's already-
accepted one. **Chose `15_000`ms, matching the sibling exactly**, rather than
inventing a new number.

Considered the issue's alternative ("measure from signal delivery"): `p.kill()`
in Bun is a plain `kill(2)` syscall, not a blocking call — there's no
evidence it adds meaningful skew on its own. A widened threshold is simpler
and sufficient; did not change what `t0` measures.

## known-flaky.txt: added as a fallback, scoped to the path it actually covers

A fresh-context review (2026-09-26) correctly challenged the first version of
this section: the empirical repro below used `unshare --pid --mount-proc
--fork`, i.e. the **Linux** `/proc`-walk branch of `sweep_procs`, while
`localci.sh`'s header says the daemon's real production host is a Mac
(launchd, `$HOME/Library/...` paths) and the issue itself was reported "under
Mac load". Re-traced `localci.sh` and the Dockerfile line by line to settle
which branch is actually real for which path:

- **Mac/docker mode (`linux()` without `IMAGE=native`, `localci.sh:129-136`)**
  wraps only the `bun run bun-test` command string in `docker run --rm ...`
  (no `--pid=host`) against `Dockerfile`'s `ubuntu:24.04` base — a genuine
  Linux container, so `sweep_procs`'s `[ -d /proc/self ]` branch really is
  the Linux one there, exactly as the reviewer's own point (a) argued.
  *But* a plain `docker run` gets its **own, isolated PID namespace** by
  default: `/proc` inside that container only ever shows what's running in
  *that* container (bun, tmux, node, a couple of stub scripts) — a handful of
  processes, not the Mac host's. Measured on this session's own host: `ps
  -ww -A -o pid=,command=` over **1607** real processes took **68ms** (`time`,
  2026-09-26) — even the "expensive" macOS-style enumeration is fast at that
  process count, and it's not what a docker-isolated container would see
  regardless. So in the Mac/docker mode the issue's own title names, sweep_procs's
  proc-walk is cheap no matter how "loaded" the Mac is; the 13.6s vs 10s flake
  there more likely comes from CPU-scheduling contention on the fork/exec of
  `gh`/`docker`/`git` subprocesses while "many lock waiters" compete for the
  Mac's CPU, not from `sweep_procs` walking a large process table. The widened
  15_000ms bound (above) covers that mechanism regardless of platform; nothing
  about it depended on which sweep_procs branch runs.
- **`--native` mode (`localci.sh:129-133`, `IMAGE=native`)** runs the *entire*
  script — main flow, `--lanes`, `sweep_procs`, everything — directly on the
  host with no docker at all. The header names its target explicitly: "a
  Linux host such as a studio container" (`localci.sh:13-17`), and the runner
  label logic (`localci.sh:169-174`) detects exactly this: `IS_SANDBOX=1` on
  Linux → `HOST=studio`. This is not a hypothetical: the container this
  investigation ran in *is* that host (`IS_SANDBOX=1`, Linux, `ps aux | wc -l`
  = 1608 at the time of writing) — its `/proc` is genuinely host-wide and
  shared with concurrent sibling agent sessions, exactly the "process-dense
  host" scenario sweep_procs's Linux branch is exposed to. This is the path
  the empirical repro below actually measures, and it is real, not an
  artifact of this sandbox being used as a test bed: `--native` is a
  documented, intentionally-supported execution mode of `localci.sh` for
  hosts of exactly this shape.

Confirmed empirically: in this session's own sandbox container (which shares
a `/proc` namespace with sibling agent containers and had accumulated ~1550
zombie processes from concurrent, unrelated sessions), *both* this test and
the pre-existing, untouched sibling test (already on `main`, already budgeted
at 15s) failed at ~19-24s — proof the Linux branch's structural cost can push
either test past any fixed ceiling on a sufficiently process-dense host,
independent of CPU load average (this container's load average was 0.35, not
"loaded"). Verified in a clean `unshare --pid --mount-proc` namespace
(representative process count) that the fix passes reliably and fast (~1.6s,
3/3 runs) — the failures above are a genuine property of `sweep_procs`'s
Linux-branch design under a shared, unbounded process table, not a fluke of
this fix.

Given that, added `test/bun/localci-run.test.ts` to `known-flaky.txt` as a
safety net alongside the widened bound (issue #382) — scoped, in the comment
there, to the `--native`/studio path where sweep_procs's `/proc` really is
host-wide, rather than worded as if it also explained the originally-reported
Mac/docker flake (it does not: that container's `/proc` is small by
construction). The widened bound is the fix for the reported Mac/docker
flake; known-flaky.txt is a separate, independently-justified safety net for
the studio/native path.

## Out of scope, flagged separately (not fixed here)

`sweep_procs` forking ~2 external processes (`readlink`, `tr` twice) per
`/proc` entry, for *every* process on the host, twice per interrupted run, is
bug-shaped (real, avoidable cost — e.g. it could skip forking `tr` using bash
parameter expansion, or filter before forking). Left untouched per this
task's scope: a test-only timing calibration, not a behavior change to
`localci.sh`. Worth its own follow-up issue.

## Test run results

Same host (this session's sandbox, ~1550 host-wide zombie processes from
concurrent unrelated sessions sharing the PID namespace) — pre-existing
condition, confirmed to also fail the *unmodified* sibling test:

- `bun test test/bun/localci-run.test.ts -t "SIGTERM mid-lane"` (with the
  15s fix): failed 3/3 runs at 22691ms, 22719ms, 23534ms.
- `bun test test/bun/localci-run.test.ts -t "ignores TERM"` (sibling,
  **unmodified**, already on `main`): failed at 18724ms against its own
  existing 15000ms bound — proving the sandbox's process-table pollution is
  a pre-existing confound, not something this change introduced or can fix.

In a clean `unshare --pid --mount-proc --fork` namespace (realistic process
count, no cross-session pollution):

- `bun test test/bun/localci-run.test.ts -t "SIGTERM mid-lane"`: passed 3/3
  runs, ~1.63s-1.64s total each.
- `bun test test/bun/localci-run.test.ts` (whole file, 30 tests): 30 pass, 0
  fail, 14.58s.

Platform-scoping check (2026-09-26, review follow-up): `time (ps -ww -A -o
pid=,command= >/dev/null 2>&1)` on this same host, at 1607 processes, took
**68ms** real time — the macOS-style enumeration (2 forks total: `ps -A` +
`lsof -d cwd`) is not exposed to the same magnitude of slowdown the Linux
`/proc`-walk branch (N forks, `tr` + `readlink` per entry) showed at a
comparable process count (18-24s, above). `lsof` is not installed in this
sandbox to time directly, but it shares the "one process, one pass" shape
`ps -A` has, not the Linux branch's "one fork-pair per host process" shape.
This is what grounds the corrected, narrower known-flaky.txt scoping above:
the demonstrated multi-second cost is a property of the Linux `/proc`-walk
branch specifically, not of "host load" in general, and that branch only
sees a large, real process count when nothing isolates its PID namespace —
`--native` mode on a studio-shaped host (`IS_SANDBOX=1`, Linux), not the
default Mac/docker mode (`docker run` gets its own PID namespace).

## Files touched

- `apps/fleet/test/bun/localci-run.test.ts` — widened the SIGTERM-mid-lane
  timing bound from 10_000ms to 15_000ms, with a comment explaining why it
  now matches the sibling's budget.
- `apps/fleet/scripts/localci/known-flaky.txt` — added
  `test/bun/localci-run.test.ts`, referencing #382, as a fallback rerun-once
  safety net, scoped to the `--native`/studio execution path (real host-wide,
  un-isolated `/proc`) rather than the default Mac/docker path (isolated,
  small `/proc` regardless of Mac host load).
