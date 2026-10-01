---
name: retro-ritual
description: Use when running a weekly retro, turning learnings into checks, or someone says "retro the fleet" — reads recent PRs/reviews/envelopes/memory and produces a numbered decision sheet of environment changes.
---

# Retro ritual

Retro turns learnings into environment changes. It is **not itself a memory
system** — the memory already exists (`fleet memory ls`, board envelopes'
`learnings` field); retro is the periodic pass that reads what has piled up
there and converts it into something that changes the fleet: a check, a
standard, a pointer, a fix, a trim, a prune.

Cadence: **weekly**. The weekly board task that runs this ritual is filed
with `fleet task new --template retro` — see "Filing the weekly task" below.
That is the only thing this skill files. Everything else it finds is a
*proposal*, not a task.

## What it reads

Four sources, concretely:

- **Last N merged PRs.** `gh pr list --repo <owner/name> --state merged --limit N`.
- **Review findings** on those PRs. PR review comments, and whatever the
  `code-review` skill produced while reviewing them.
- **Envelopes.** Board task comments — `fleet task show <n>` for each task
  behind those PRs. `apps/fleet/src/board/envelope.ts`'s `learnings` field is
  already a structured carrier for exactly this: every studio's envelope can
  carry learnings, and this is the one place they get read back in bulk
  instead of sitting on a closed issue forever.
- **Harvested ops memory.** `fleet memory ls`
  (`apps/fleet/src/memory/store.ts`), the `FLEET_OPS_REPO`-backed store that
  the teardown harvest already writes to. Absent ops repo = this source is
  **empty**, say so and move on — never refuse the retro for lack of it.

## Candidate categories

Each candidate you propose belongs to exactly one of these:

- **New deterministic check** — mechanical, enforceable without judgement
  (a gate script, a lint rule, a CI step).
- **Standards entry** — a judgement call that belongs in a house-rule doc,
  not a script (a convention, a naming rule, a "do it this way" note).
- **Navigation pointer** — a where-to-look doc or comment that would have
  saved the time that was spent hunting.
- **Tool-economy fix** — an expensive or wasteful tool-call pattern seen
  more than once (a heavy gate run redundantly, a search that should have
  been a grep, a full build where a scoped one would do).
- **Bloat** — a redundant doc, skill, or check that duplicates something
  else and should be trimmed.
- **Prune** — a check that has been silent 30 days straight, or allowlisted
  more than N times. Name it as a removal CANDIDATE here. Retro never
  removes it itself.

## Output: a numbered decision sheet

Same shape sprint-ritual's explorers already produce. Each line:

1. The candidate (what, exactly).
2. A recommended action.
3. The cost of getting it wrong (what happens if the operator skips this, or
   if the recommendation is wrong).
4. A citation — the concrete PR/issue/session moment this traces to. **No
   candidate ships without a citation.** A pattern you vaguely recall is not
   a candidate; a pattern you can point at (PR #, issue #, a session's own
   transcript moment) is.

Do not filter. Deduplicate the same candidate surfacing from two PRs, but
never drop one for seeming small or obvious — that is the operator's call,
not the retro's filter, same rule sprint-ritual's decision sheets already
follow.

## Proposes only

This skill never files the fix tasks it proposes. The operator reads the
decision sheet and picks by number. Turning a picked number into a board
task is an ordinary `fleet task new` — same as any other task — done
afterward by whoever is running the retro. The retro's own output is the
sheet, nothing more.

## Filing the weekly task

The retro board task itself (the one that runs this whole ritual, not the
fix tasks it proposes) is filed with:

```
fleet task new --template retro
```

That fills the brief's four required sections — title, objective, output
format, boundaries — from a fixed template
(`apps/fleet/src/studio/retro-template.ts`) describing exactly the sources
and output shape above, so the weekly task does not need retyping by hand.
`--studio`, `--sprint`, and every other brief flag still work alongside it —
a template supplies the four required sections, nothing more; assignment,
scheduling, and everything else about the task is decided the same way as
any other `fleet task new` call.

`--template retro` only exists on the operator's Mac CLI
(`apps/fleet/src/studio/cli-args.ts`). A cloud maestro session runs a
different, more limited in-container binary
(`apps/fleet/container/studio-fleet`) whose own `fleet task new` takes
`[--studio <id>]` plus brief JSON on stdin — no `--template` flag at all.
That's not a grant maestro lacks, the way `--junior` is (see
`fleet/blueprint/studios/maestro/studio.md`'s "Junior" section) — the
template's four fields are fixed, public strings, reproduced above and in
`apps/fleet/src/studio/retro-template.ts`. So a cloud maestro session doesn't
wait on the operator to file the weekly retro task: it reads those four
fields itself and types them into the brief JSON by hand against
`fleet task new --studio <id>`.
