---
name: agent-lifecycle
description: Use when creating, hibernating, resurrecting or killing agents in a multi-agent fleet - covers the naming convention, the hard rule on when an agent may be killed, and the full teardown that actually frees resources.
---

# Agent lifecycle

## Naming: one string for three things

The branch name, the worktree name and the agent name are **the same string**. In an
IDE sidebar that name is often all a human sees, so it must say what it is alone.

```
<issue-number>-<short-slug>        e.g. 104-directus-types
```

**Every task has an issue before it has an agent.** If none exists, open one. Several
issues in one task: use the primary in the name, cite the rest in the PR body.

Permanent roles keep plain names: `manager`, `release`, `qa`, `devops`. Explorers
prefix `exp-`.

## Creating an agent: the trap that wastes a day

**A message is typed, not submitted.** A long message lands as an unsent draft
block. A send that reports `accepted` (with `observation: "unsupported"`) means
typed, not received. Follow every long message with a short one-liner to flush
it, then confirm the agent actually started running.

**Terminal handles go stale.** Re-read them fresh from
`orca terminal list --worktree <selector> --json` every sweep. An instruction
sent to a dead handle returns `Unknown terminal` and vanishes.

To create the worktree:

```bash
orca worktree create --repo id:<repo-id> --name <name> --no-parent --setup skip
# wait for the worktree to exist, THEN write the briefing:
cp <briefing> <worktree>/.context/BRIEFING.md
orca terminal create --worktree <worktree> --title <name> \
  --command "<agent start command>"
orca terminal send --terminal <handle> --text "Read .context/BRIEFING.md in full before anything else and follow it."
# then VERIFY a session opened before believing it — read the screen, not the
# send's return value: orca terminal read --screen --json
```

`.context/` is gitignored and exists for this.

## The hard rule on killing

**An agent may only be killed once its pull request is merged into the integration
branch AND verified there by QA against green gates.**

Not when the sprint ends. Not when it looks finished. A bug found after the author is
gone means reconstructing the reasoning behind a solution from a diff, which costs far
more than the resources the agent was holding.

Extract all the value first. Everything else hibernates.

## Hibernate instead

Hibernation in this fleet is `fleet destroy <id> --park`: stop the container but
keep it resumable.

1. Kill the process. **This frees the RAM, which is the real cost.**
2. Delete `node_modules`. Roughly a third of a worktree, and one install restores it.
3. **Keep the worktree, the branch and the transcript.**

Resurrect with `fleet provision <id>` and the agent wakes knowing what it knew. An
agent's context is its transcript, not its process. A session that cannot resume
(corrupt, oversize, exits on `--continue`) takes `fleet provision|recycle <id>
--fresh-session` instead.

## Full teardown, when the rule is satisfied

Stopping the conversation frees nothing. Worktree, server and branch stay alive.

**Four checks first, in order, no skipping:**

1. Nothing uncommitted: `git -C <worktree> status --porcelain` is empty.
2. Nothing unpushed: the branch exists on origin and `git log origin/<b>..HEAD` is
   empty. **This one catches real disasters** — a worktree once held 80 commits that
   existed nowhere else.
3. **Every commit is an ancestor of the integration branch, verified one by one**:
   `git merge-base --is-ancestor <commit> origin/<integration>`. A MERGED badge is
   not proof.
4. Leftovers filed as issues, lessons written to memory.

**Then:**

```bash
lsof -ti TCP:<agent-port-range> -sTCP:LISTEN | xargs -r kill
fleet destroy <id>        # stops the container AND tears down the Orca worktree
                          # and attach terminal (board #57)
git -C <repo> worktree prune          # teardown does not always prune
git -C <repo> branch -d <branch>
```

The origin branch stays. It is the PR history and costs nothing locally.

**Teardown is best-effort.** Destroy can degrade (Orca absent, wedged, or erroring)
without failing. When it does, finish by hand: `orca terminal close --terminal
<handle>`, then `orca worktree rm --worktree "path:<abs>"`. A live `fleet attach`
terminal reconnects and boots a new billing container — close it.

**Destroy is not instant.** Destroying and immediately respawning the same id
yields a 409 "studio exists": the registry entry survives destroy; the way back
is `fleet provision <id>` on that same id.

## Reap on every sweep

Resources to reclaim: finished agents, orphaned dev servers, throwaway gate
worktrees, stopped containers.

**Read memory correctly.** On macOS, free pages alone are meaningless; inactive pages
are reclaimable. Real availability is free + inactive + purgeable + speculative, and
`memory_pressure` gives the honest figure. Blocking work over a misread number is its
own failure.
