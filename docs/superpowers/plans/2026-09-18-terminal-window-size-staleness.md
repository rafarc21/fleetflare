# Terminal window-size staleness investigation (board issue #4, item 3)

## Scope narrowing (from the coordinator, before this task started)

Board issue #4 originally asked for three fixes. Since filed:

1. **Mouse scroll + `history-limit`** — already shipped on `main` (`5ee8587`).
   `container/studio-bringup.sh` lines ~102-121 (`tmux set -g mouse on`,
   `tmux set -g history-limit 50000`). Not touched here except a documentation
   line added right beside them (below).
2. **tmux prefix change** — CANCELLED. the operator's own words (translated from
   Portuguese): "DON'T change the prefix, it stays C-b." `mouse on` already
   fixed the real pain (scroll now works); the coordinator's own automation
   and the documented headless-probe procedure both key off
   `Ctrl-b 1`/`Ctrl-b 0` to switch windows, so rebinding the prefix would
   break both. Documented instead: one comment block in `studio-bringup.sh`,
   right after the `mouse on` block, explaining the `Ctrl-b Ctrl-b` collision
   (it sends a literal Ctrl-b to claude — its own "run in background" chord —
   not tmux copy-mode; the prefix stays `C-b` on purpose).
3. **Window-size staleness on client detach** — the one real fix this task
   was scoped to. See below.

## The bug, per the operator's own measurement

Two Orca terminals attached to `studio`, both `[studio] 0:claude* 1:shell-`.
Render pinned ~120 columns inside a visibly wider window. the operator closed one
client (`orca terminal close`), confirmed the PTY died, confirmed exactly one
client remained via `tmux list-clients` — and the window stayed pinned to the
departed client's stale ~120-column size instead of recomputing to the
survivor's actual size. His hypothesis: missing a SIGWINCH/redraw on client
detach; proposed investigating `resize-window -A`, `refresh-client -S` on a
`client-detached` hook, and whether `window-size largest`/`smallest` behave
better on detach — "without reopening the size bug that the comment at
:89-101 documents." (translated)

## Why `window-size smallest`/`largest` is out

`studio-bringup.sh`'s own comment (lines ~88-101, unchanged) explains why
`window-size latest` replaced tmux's default: a studio accumulates STALE
clients over time (every `fleet attach` is a new client; a dropped socket is
not reaped promptly), and with tmux's own default negotiation this pins the
window to the SMALLEST of all those accumulated, mostly-stale, clients —
corrupted render, stacked status bars, mid-glyph wrapping. `latest` fixed
that. Switching to `smallest` (or `largest`) to chase THIS bug would directly
reopen that one. Not touched.

## Empirical investigation

Ran entirely in a throwaway, isolated tmux server (`tmux -L test-issue4`, own
socket, killed at the end — never touched the real `studio` session). tmux
version in this environment: 3.2a (`tmux -V`), matching the container image.

A full real-Orca repro isn't possible headless, so the mechanism was proven
directly: a Python `pty.fork()` harness attaches two real tmux clients at
different terminal sizes (via `TIOCSWINSZ` on the pty master before exec'ing
`tmux attach-session`), then removes one of them two different ways and
diffs `tmux list-windows -F '#{window_width}x#{window_height}'` before/after.

Setup common to all runs: `window-size latest`, `aggressive-resize on` (the
two lines this file already sets), client B attaches wide (220x50) first,
client A attaches narrow (120x40) second — so A is "latest" and the window
pins to 120x39, exactly matching the "screen renders ~120 columns" shape of
the operator's report.

**Test 1 — graceful `tmux detach-client -t <A's tty>`** (the well-behaved
case): window recomputed to 220x49 (B's size) immediately. No staleness.

**Test 2 — `kill -9` the client process + close its pty master fd, no tmux
command involved** (closer to "orca terminal close" — the app dies, not a
polite in-band detach): same result, window recomputed to 220x49
immediately. No staleness.

**Test 3 — repeat of both, with `aggressive-resize off`**: identical result.
Not the variable.

**Test 4 — three simultaneous clients** (C 300x60 attached first/stalest, B
200x45, A 120x40 attached last/"latest"), then kill A the same way as Test 2:
window recomputed to 200x44 (the correct next-latest survivor), not the
smallest (200 < 300, so this run didn't fully distinguish latest-vs-smallest
among survivors, but confirms multi-client teardown converges correctly too).

**Test 5 — the exact candidate fix, applied**: `tmux set-hook -g
client-detached 'set-option -g window-size latest'` — syntax confirmed valid
in 3.2a (`show-hooks -g` lists it registered under `client-detached[0]`).
Re-ran Test 2 with the hook installed: identical result, 220x49. The hook is
syntactically correct and inert here — tmux was already correct before it
fired.

**Conclusion: the empirical test contradicts the hypothesis.** In tmux 3.2a,
with `window-size latest` + `aggressive-resize on` (the config this file
already ships), a REAL client-detached event — whether a graceful
`detach-client` or an abrupt process-kill/fd-close — already makes tmux
recompute the window size to the surviving client's actual dimensions
immediately, with no hook needed. Per this task's own dispatch instruction
("if your empirical test contradicts the hypothesis... STOP and report back
... rather than forcing a fix you're not confident in"), no `client-detached`
hook was added to `studio-bringup.sh`. Shipping an unverified fix for a bug
that direct testing could not reproduce would be worse than reporting the
contradiction.

## A second, independent reason the scenario should now be rarer anyway

`docs/superpowers/plans/2026-09-18-orca-terminal-idempotency.md` (board issue
#6, already merged to `main`, already an ancestor of this branch — confirmed
via `git merge-base --is-ancestor 1950cc7 HEAD`) fixed the actual mechanism
that was putting a SECOND Orca client on one studio in the first place:
`ensure()` in `cli/orca-workspace.ts` checked terminal `title === id`, a
value the Orca API never actually produces, so every `fleet
spawn`/`provision`/`recycle`/`ff` call believed the studio had no attach
terminal yet and opened ANOTHER one — unbounded duplicate tabs, each its own
tmux client on the same session. That plan doc's own words: "which is also
what pins `window-size latest` to the wrong size (the corrupted render /
white band the operator is seeing)." With that idempotency bug fixed, the scenario
the operator measured (two live Orca clients on one studio) should occur far less
often going forward, independent of anything in this task.

## Discovered but out-of-bounds: why two clients existed at all

`container/studio-shell.sh`'s own reattach loop already runs `tmux attach -d
-t studio`, and its own comment explains `-d` exists specifically to detach
every OTHER client as this one attaches — "a studio has one operator but
accumulates clients ... leaving them attached is what makes tmux size the
window to the smallest of them." So the two-Orca-clients scenario the operator
measured almost certainly did NOT come through `studio-shell.sh`'s own attach
path (that path actively prevents exactly this). It came through some other
attach mechanism — most likely Orca's own terminal integration or the fleet
Worker's websocket pty bridge, both under `src/`/the container-server,
outside this task's boundary ("DON'T touch src/", translated, is explicit in
the original issue, and this coordinator's dispatch repeats it). Not diagnosed
further here — noted for whoever picks up the real attach-path code, since
board issue #6 already independently closed the most likely instance of it
(the Orca-side duplicate-terminal creation bug).

## Result

- Item 1 (mouse/history-limit): untouched, already shipped, confirmed intact.
- Item 2 (prefix): untouched code-wise; one documentation comment added in
  `container/studio-bringup.sh`, right after the `mouse on` block, recording
  the coordinator's "stays C-b" decision (internal tooling, delegated by
  the operator) and the `Ctrl-b Ctrl-b` collision as a known, accepted tradeoff.
- Item 3 (window-size staleness): investigated per the issue's own discipline
  ("Investigate 3 BEFORE touching 1 and 2", translated). Empirically could not
  reproduce the staleness at the tmux-config layer in this environment's tmux
  version (3.2a) across five distinct scenarios (graceful detach, abrupt kill,
  aggressive-resize on/off, 2-client, 3-client) — tmux already self-heals
  `window-size latest` on any real client-detached event. No code change made
  to `window-size`/`aggressive-resize`/hooks. A regression-guard test pins
  that `window-size` never becomes anything but `latest` anywhere in the file
  (guards against reopening the :88-101 bug in any FUTURE edit, not just this
  one).

## Provision vs. recycle

Not applicable in the sense the dispatch expected (no `set -g`/`set-hook -g`
line was added), but stated for completeness following the same reasoning
the file's own existing lines already establish: `tmux set -g mouse on` and
`tmux set -g window-size latest`/`aggressive-resize on` are session-scoped
options applied with `set -g`, which re-take-effect on an ALREADY-RUNNING
studio the moment `studio-bringup.sh` re-runs (i.e. on `fleet provision`
alone) — no `fleet recycle`/fresh container needed. This is unlike
`history-limit`, which the file's own comment already notes only affects
windows created AFTER the option is set. Had a `client-detached` hook been
added, it would follow the same `set -g`/`set-hook -g` idempotent-overwrite
property (stated for the record, in case a future investigation revisits
this and does add one).

## Boundary

Touched: `apps/fleet/container/studio-bringup.sh` (one documentation
comment, no functional/config change), `apps/fleet/test/studio.session.test.ts`
(one new `describe` block: a `window-size`-stays-`latest` regression guard +
a pin of the new documentation comment), this plan doc, `.fleet/done.json`.
Nothing under `apps/fleet/src/`, `gates/`, `skills/`, `.github/`,
`fleet/blueprint/` touched. `container/studio-shell.sh` read only, not
modified — read/reference need only (see "discovered but out-of-bounds"
above), no code change required there.

## Verification plan

`cd apps/fleet && bun run check`, `bun run test`, `bun run bun-test`. TDD:
the new prefix-documentation test was written first (against the reverted
comment), confirmed RED (`expected -1 to be greater than 6117` — the comment
wasn't there yet), then the comment was re-added and the same test run
confirmed GREEN. The `window-size`-stays-`latest` regression-guard test
passed immediately since no `window-size` line was ever changed away from
`latest`.
