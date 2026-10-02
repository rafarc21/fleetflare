# Fix `image-repro-check.sh`'s self-wrap lock deadlock (board issue #124)

## Root cause

`apps/fleet/scripts/image-repro-check.sh:33-35` self-wraps under the shared
gate lock unless `IMAGE_REPRO_LOCKED` is already set:

```bash
if [[ -z "${IMAGE_REPRO_LOCKED:-}" ]] && command -v lockf >/dev/null 2>&1; then
  IMAGE_REPRO_LOCKED=1 exec lockf -k "$LOCK" "$0" "$@"
fi
```

`lockf`'s advisory lock is POSIX `fcntl`-based: it is scoped to a
**process**, not inherited across `fork`+`exec`. If a caller already holds
this exact lock on `/tmp/fleetflare-gate.lock` and invokes this script as a
nested child *without* setting `IMAGE_REPRO_LOCKED` itself, the nested
`lockf` call here blocks forever waiting on its own ancestor — which is
itself waiting for this nested call to finish. Deadlock. Measured: a 16-minute
hang that blocked the whole shared gate queue, killed by hand.

Two realistic triggers, both outside this script's control (it can't assume
anything about what called it):

- `localci.sh:407`'s own gate wrap: `if command -v flock >/dev/null 2>&1;
  then LOCKCMD=(flock "$LOCK"); else LOCKCMD=(lockf -k "$LOCK"); fi` — on a
  Mac, which has no `flock`, this falls back to the *same* `lockf -k "$LOCK"`
  construct `image-repro-check.sh` self-wraps with. A lane that then shells
  out to `image-repro-check.sh` nested, without passing
  `IMAGE_REPRO_LOCKED=1`, deadlocks exactly this way.
- A human operator manually wrapping an ad-hoc outer
  `lockf -k /tmp/fleetflare-gate.lock ... image-repro-check.sh ...` around
  the script (e.g. to serialize it against something else by hand), not
  knowing the script already self-wraps.

Confirmed by grepping the whole repo: no in-repo automated caller does this
today (only `test/bun/reproducible-images.test.ts` and docs reference this
script, and neither invokes it nested under the lock) — the realistic
trigger is the human-operator scenario above, or a future lane that calls
this script the way `localci.sh` calls its own `--lanes` re-invocation.

## Why a fixed timeout is the wrong fix

The gate lock legitimately serializes "one heavy job at a time on this
machine" (`localci.sh:20-21`) — a *stranger* process (not an ancestor of this
one) can legitimately hold it for a very long time, e.g. a full `localci.sh`
run. A fixed timeout on the lock-acquire can't distinguish "deadlocked on my
own ancestor, which is itself waiting on me" (should fail/skip immediately,
regardless of how long it's been) from "waiting behind an unrelated
legitimate long job" (should keep waiting, no matter how long) — both look
identical from outside as "lock still held after N seconds." A timeout
trades hanging forever for *sometimes* falsely aborting a legitimate long
wait; it doesn't actually fix the deadlock, it just bounds how long you wait
before giving up on work you should have let finish.

## The fix

A deterministic, caller-agnostic check, with zero timing ambiguity: before
self-wrapping, walk this process's own ancestor chain. If *any* ancestor's
command line is itself a `lockf ... "$LOCK"` invocation, the gate is already
held further up **our own process tree** — self-wrapping here would only
deadlock against our own ancestor, so skip the self-wrap entirely (behave
exactly as if the caller had set `IMAGE_REPRO_LOCKED=1` itself) and run
directly.

This matches issue #124's own proposed option 1 ("non-blocking probe fails
while parent holds it -> treat as locked if parent chain holds it"), but
implemented via ancestor-command-line inspection instead of a lock-probe
race: a probe-and-retry still has a window where "probe failed because an
*unrelated* process grabbed the lock a moment ago" looks the same as "probe
failed because an ancestor holds it," whereas walking the ancestor chain by
PID is exact — either an ancestor literally is a `lockf ... "$LOCK"`
invocation, or it isn't, no race.

```bash
ancestor_holds_lock() {
  local pid=$$ ppid cmd depth=0
  while [ "$pid" != "1" ] && [ "$depth" -lt 50 ]; do
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$ppid" ] && return 1
    cmd=$(ps -o command= -p "$ppid" 2>/dev/null)
    case "$cmd" in *lockf*"$LOCK"*) return 0 ;; esac
    pid=$ppid
    depth=$((depth + 1))
  done
  return 1
}

if [[ -z "${IMAGE_REPRO_LOCKED:-}" ]] && command -v lockf >/dev/null 2>&1; then
  if ancestor_holds_lock; then
    IMAGE_REPRO_LOCKED=1
  else
    IMAGE_REPRO_LOCKED=1 exec lockf -k "$LOCK" "$0" "$@"
  fi
fi
```

`$LOCK` is always the hardcoded literal `/tmp/fleetflare-gate.lock` at the
top of the script (never overridden from an env var), so the glob
`*lockf*"$LOCK"*` has no injection concern from glob metacharacters in
`$LOCK` itself. `depth` is capped at 50 as a backstop against a pathological
`ps`/`/proc` loop (e.g. a reparented chain that never reaches pid 1 for some
reason); 50 is far beyond any real process tree depth this script would ever
run under.

`pid=$ppid`-style loop uses POSIX `[ ]` test, not `[[ ]]`, matching this
file's own existing convention: top-level guard conditions use `[[ ]]`
(bash-specific), but logic *inside functions* in this file uses `[ ]`
(POSIX) — see `localci.sh`'s `sweep_procs()` for the same split, which this
fix mirrors for consistency within the repo's shell scripts.

## Test strategy

`lockf` is not installed in this studio container (`command -v lockf`
fails here) — only `flock` is. The top-level self-wrap `if` block (gated on
`command -v lockf`) never executes in this container at all, with or without
this fix, so the fix cannot be exercised end-to-end here by just running
`image-repro-check.sh` normally.

Fix: make `ancestor_holds_lock` callable independently of whether `lockf`
the binary exists, via a test-only CLI hook —
`--ancestor-holds-lock-check` — defined unconditionally (outside/before the
`command -v lockf` gate), printing `yes`/`no` and exiting 0 either way. This
follows the exact precedent of `localci.sh`'s own `--sweep-procs-only` hook
added for issue #159: a thin, never-invoked-by-a-real-run entry point that
lets a test call the pure-introspection logic directly against the real
`/proc`/`ps` on whatever host runs the test.

Verified empirically before writing the test (see commit for the throwaway
check): `ps -o command=` on this container's `ps` (`procps-ng 3.3.17`) does
report the *full* argv of a process, including an `exec -a`-renamed
`argv[0]`, not just a short comm name —
`bash -c 'exec -a "lockf -k /tmp/fleetflare-gate.lock" sleep 30'` shows up
under `ps -o command=` as `lockf -k /tmp/fleetflare-gate.lock 30`. Also
confirmed `exec -a NAME CMD ARGS` replaces the *current* process image (same
pid) rather than forking, so a decoy built as "process A execs into a
renamed `lockf`-looking program, which then plainly forks a child B to run
the check hook" reliably gives B a real ancestor (A) whose own command line
looks exactly like a real `lockf -k "$LOCK"` invocation, with no extra
intermediate shell layer whose own *literal source text* could spuriously
contain the lock path and cause a false match.

Test file: `apps/fleet/test/bun/image-repro-lock.test.ts` (same style as
`test/bun/sweep-procs.test.ts`):

1. Positive: a fake ancestor process built with `exec -a "lockf -k
   $LOCK" ...`, with the `--ancestor-holds-lock-check` hook run as its
   child — asserts `yes`/exit 0.
2. Negative: the same hook run as a plain child of the test runner, no such
   ancestor anywhere in the chain — asserts `no`/exit 1.
3. A `lockf` PATH shim (a tiny script named `lockf` that just `exec`s its
   arguments) to exercise the *full* self-wrap `if` block's branching when
   `command -v lockf` succeeds, confirming the fix's control flow (skip the
   self-wrap and fall through, vs. actually invoking the shim) without
   depending on real POSIX locking semantics.
