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

**A long `--prompt` silently fails.** It creates the worktree and the terminal and
never starts a session. No transcript, nothing responds, no error.

```bash
dev agent create --repo <repo> --name <n>-<slug> --from <integration-branch> \
  --prompt "Read .context/BRIEFING.md in full before anything else and follow it."
# wait for the worktree to exist, THEN write the briefing:
cp <briefing> <worktree>/.context/BRIEFING.md
dev send <id> "Read .context/BRIEFING.md now, it is in place"
# then VERIFY a session opened before believing it
```

`.context/` is gitignored and exists for this.

**`dev send` types, it does not submit.** A long message lands as an unsent paste
block. `"ok": true` means typed, not received. Follow every long message with a short
one-liner to flush it, then confirm the agent actually started running.

**Terminal IDs go stale.** Re-read them fresh every sweep. An instruction sent to a
dead ID returns `Unknown terminal_id` and vanishes.

## The hard rule on killing

**An agent may only be killed once its pull request is merged into the integration
branch AND verified there by QA against green gates.**

Not when the sprint ends. Not when it looks finished. A bug found after the author is
gone means reconstructing the reasoning behind a solution from a diff, which costs far
more than the resources the agent was holding.

Extract all the value first. Everything else hibernates.

## Hibernate instead

Where the CLI has no archive verb, hibernation is:

1. Kill the process. **This frees the RAM, which is the real cost.**
2. Delete `node_modules`. Roughly a third of a worktree, and one install restores it.
3. **Keep the worktree, the branch and the transcript.**

Resurrect with `cc --continue` in that worktree and the agent wakes knowing what it
knew. An agent's context is its transcript, not its process.

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
dev remove <worktree>
git -C <repo> worktree prune          # remove does not always prune
git -C <repo> branch -d <branch>
```

The origin branch stays. It is the PR history and costs nothing locally.

**`dev remove` is not instant.** Removing and immediately recreating the same name
yields `<name>-v1` on a branch nobody asked for.

## Reap on every sweep

Resources to reclaim: finished agents, orphaned dev servers, throwaway gate
worktrees, stopped containers.

**Read memory correctly.** On macOS, free pages alone are meaningless; inactive pages
are reclaimable. Real availability is free + inactive + purgeable + speculative, and
`memory_pressure` gives the honest figure. Blocking work over a misread number is its
own failure.
