# Rescue Branch Discovery (board issue #9)

**Measured incident, today, this repo's own lead:** a lead was told to
resume from a specific rescue branch, ran `git branch -a` inside its
studio, saw only `main`, correctly refused to guess/fabricate work on the
evidence in front of it, and only recovered after a human manually ran
`git ls-remote` + `git fetch origin <branch>:<branch>`. That manual
recovery step is exactly what this task automates for the one case it CAN
automate, and documents honestly for the case it can't.

## Root cause

`provision.ts`'s `guardedCloneCmd` (~line 291):

```
git clone --depth 1 https://github.com/${workRepoSlug}.git ${targetDir}
```

`--depth 1` with no override implies `--single-branch` — git's own
documented default. Every studio's work-repo checkout therefore only ever
knows about the default branch. `git branch -a` shows `main` and nothing
else; `git log` shows `(grafted, ...)`. Any branch that isn't the default
— a task branch a prior incarnation was on, or a rescue-push's landing
spot — is invisible to the next container that provisions this same
studio, with no local trace that it even exists.

`do.ts`'s `rescuePushCmd` (read-only context for this task, not edited)
pushes a dying studio's dirty tree to one of two targets: the branch that
was checked out at teardown (an arbitrary name), or — when that branch
equals the resolved default, or the default couldn't be resolved at all
(fail safe) — a freshly generated `fleet/rescue/<studio>-<UTC
YYYYMMDDHHMMSS>` ref. The prefix (`fleet/rescue/<studio>-`) is
deterministic per studio; the timestamp suffix isn't.

## Three candidate mechanisms, and why this one

The board issue named three:

**(a) widen the clone refspec** to pull in rescue branches too.
**(b) a bring-up-time discovery step** that fetches rescue-prefixed
branches after the (still-narrow) clone.
**(c) process/coordination fix** — have whatever generates a resume brief
name the branch explicitly, and have the working-set state say how to
fetch it.

Chosen: **(a)+(b), scoped** — NOT a blanket switch to
`--no-single-branch`, and NOT (c) alone.

- Rejected: full `--no-single-branch`. This repo alone already carries
  dozens of `fix/`/`feat/`/`docs/`/`release/` branches accumulated over
  its history. Fetching the tip of every one of them on EVERY provision
  adds real bring-up latency and container disk cost to the 99% of
  provisions that will never need to recover a rescue branch.
  Provisioning speed is an explicitly measured, valued property elsewhere
  in this codebase (~5 minutes, "leave a provisioning studio alone" is
  documented operator guidance) — not worth regressing to fix a rare
  recovery path.
- Rejected as the WHOLE fix: (c) alone. It's a real improvement, but it's
  a process fix, not a code-level guarantee — it lives in whatever
  generates a resume brief (out of this task's code boundary:
  `provision.ts`/`spawn.ts`/`studio-bringup.sh`), and a human/coordinator
  can still forget to include the branch name, which is the exact same
  fragility as today. Doesn't get built here.
- Chosen: (a)+(b) scoped to what's cheap and unambiguous. `git ls-remote
  --heads origin` is a pure ref-advertisement round trip — name + sha for
  every branch, no object fetch — cheap regardless of branch count. From
  that, only refs matching this studio's OWN deterministic rescue prefix
  get a real (small, bounded) `git fetch`. Everything else stays
  single-branch, untouched, same cost as today.

## What gets built

One new function in `provision.ts`, `discoverRescueRefsCmd(targetDir,
studio)`, mirroring `guardedCloneCmd`'s own shape (a shell-command
builder, string in, string out, never executed at plan-authoring time).

The shell it returns, run via `deps.sbExec` right after the clone exec
succeeds, in the same neighborhood `runProvision` already runs session
restore (own try/catch, never allowed to degrade the provision):

1. `git -C <targetDir> ls-remote --heads origin`, output written verbatim
   to `<targetDir>/.fleet/remote-branches.txt` (creating `.fleet/` if
   absent). This alone closes the GENERAL discoverability gap: a
   resuming lead, or a future automated working-set-replay step, can
   `cat`/`grep` a file instead of having to think to run `git ls-remote`
   themselves — for ANY branch name, not only rescue-prefixed ones.
2. From that same output, grep for `refs/heads/fleet/rescue/<studio>-`
   (the deterministic prefix `rescuePushCmd` already uses for this exact
   studio id). Zero matches is the overwhelmingly common case; one is
   the rare-but-real recovery case; more than one only if several
   teardowns happened without ever being consumed. For each match: `git
   -C <targetDir> fetch origin <ref>:<localname>` — small and bounded, a
   rescue branch is at most a handful of commits, never the whole
   default-branch history — so it shows up in a plain `git branch` with
   no further action from the lead. One loud stderr line per branch
   found.
3. Never fails hard. Every step shell-guarded (`&&` chains inside, whole
   sequence wrapped so a failure anywhere — network blip, no rescue
   branches, whatever — degrades to "did nothing extra," never aborts
   provisioning. Same discipline `runProvision`'s own session-restore
   step already applies (own try/catch around the `deps.sbExec` call,
   `console.error` + proceed, never rethrown).

Wired into `runProvision` right after the existing clone-success check,
beside (not inside) the session-restore try/catch.

## Honesty about coverage — three tiers

- **Solved, fully automatic:** a rescue-push that landed on a
  freshly-generated `fleet/rescue/<studio>-*` ref (nothing else was
  checked out at teardown) is discovered and fetched with zero manual
  steps on the next provision.
- **Partially solved:** a rescue-push (or any earlier normal push) that
  landed on an ARBITRARY, already-existing branch name (like
  `fix/orca-terminal-idempotency` in the issue's own cited incident) is
  NOT auto-fetched — there is no way to know from the branch name alone
  that it belongs to "this studio." It now at least APPEARS in
  `<targetDir>/.fleet/remote-branches.txt`'s full listing, greppable by a
  human or a future automated step, instead of being totally invisible.
- **Not solved here, named as explicit follow-up:** a durable,
  closed-loop "this studio's last known active branch" record. That
  needs `do.ts`/`destroy.ts` — where rescue-push's actual target decision
  and `RescueResult.branch` already exist, at teardown time — to persist
  that branch name somewhere durable (DO storage) for the next provision
  to read directly, no grepping required. Those files are explicitly out
  of this task's boundary.

## Boundary

Only: `apps/fleet/src/studio/provision.ts`, `apps/fleet/src/studio/spawn.ts`
(read first; touched only if it turns out to need it), `apps/fleet/container/
studio-bringup.sh` (read/edit only if actually needed — not executed,
ever, in this session), their tests, this plan doc, `.fleet/done.json`.
Not touched: `do.ts`/`destroy.ts` (read-only context, `rescuePushCmd`/
`RescueResult` live there), `cli/orca-workspace.ts` (#6), `skills/`/
`.github/` (#7), `src/github/`/`src/board/` (#8).

## Verification plan

`cd apps/fleet && bun run check`, `bun run test` (vitest — where
`provision.ts` actually runs), `bun run bun-test`. `3072ae6` (wake-cmd
tmux-kill fix) confirmed present on this branch before running
`bun-test` — branched from current `main`, which already carries it.

Real ls-remote/fetch-against-a-live-repo verification is NOT possible
from inside this container (no live studio provision to run end-to-end).
Named explicitly as a limitation in `.fleet/done.json`'s
`verification_intent`, with manual steps a human can follow against a
real repo with a real `fleet/rescue/*` branch.
