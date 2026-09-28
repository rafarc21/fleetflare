---
name: sprint-ritual
description: Use when running or planning a two-day agent sprint - covers the open/close sequence, overnight exploration, when to promote to production, and how to record the sprint so it survives a context reset.
---

# Sprint ritual

Two-day sprints run by a manager agent over a fleet of developer agents. The human
appears at two points and is otherwise reachable on demand.

## Shape

```
OPEN     day 1, 08:00   human, 60 to 90 min
BUILD    day 1 -> day 2
CLOSE    day 2, end     human, ~20 min
         + explorers launch for the next sprint, running overnight
```

**No scheduled standup.** The human runs several projects at once and is online
throughout. Contact them the moment something needs them, and otherwise leave them
alone. An interval meeting nobody needed is worse than a message at the right time.

## Open, day 1 at 08:00

1. **Promote the previous sprint to production.** See below.
2. **Sprint planning with the human.** Bring deduped decision sheets from overnight
   exploration, the carryover list, and a proposed scope. They answer by number.
3. **Freeze scope.** Create the milestone, attach the issues, open the record row.
4. **Launch developers** from approved specs, starting at plan-writing, not at
   brainstorming. **Resurrect hibernated developers** rather than replacing them.

## Close, day 2

1. **Drain the merge queue.** Conflicts bounce to authors with the close as deadline.
2. **QA pass** on the integration environment: cross-screen, console, network, every
   width, end to end.
3. **Human review, ~20 min.** They open the URLs. Nothing else.
4. **Extract value, then hibernate or kill.** See `agent-lifecycle`.
5. **Record the sprint** where it survives your death.
6. **Launch explorers for the next sprint.**
7. **Manager, release manager and QA are killed and reborn** from seed prompts.

## Promote at sprint OPEN, never at close

The temptation is to ship the moment QA passes. Resist it.

- **At close the human is leaving.** Never deploy in front of an empty chair.
- **At open the deploy runs while planning happens**, and when planning ends they
  are already at the desk to click around and support it.
- **Work soaks overnight** in the integration environment while explorers run. That
  soak is free, because the time was being spent anyway.
- **The last deploy of the week lands Friday morning**, not Friday evening, which is
  the worst slot there is.

Only ever promote from the integration branch, only after QA is green, and only via
the release role. Never a hotfix straight to production, however small.

## Overnight exploration is the tail of the previous sprint

Exploration is not a phase the human waits through. Explorer agents launch at close
and run all night, so the sheets are ready at 08:00.

Each explorer emits two things: a **decision sheet** of numbered questions with a
recommended option and the cost of getting it wrong, and a **context pack** that
becomes the next developer's briefing so nothing is rediscovered.

Brief explorers for **depth, not speed**. They have hours.

## Do not filter decisions

Deduplicate the same question surfacing across tasks. **Do not drop a decision for
being obvious.** Structural and foundational choices belong to the human. Attach
your recommendation so they can move fast when they agree.

They skip what they want to skip. That is their call, not your filter.

## A mid-sprint question never stops work

The developer builds everything not depending on the answer, marks the gap, and the
question goes to the human when it is ready, not on a schedule.

## Friday sprints

Start a sprint on Friday so it builds through the weekend inside Friday's decisions.
This is not expanded autonomy: a question arising on Saturday waits for Monday and
the developer builds around it. What changes is how many decisions you extract on
Friday, not how much licence agents have.

## The record

The sprint record is what survives the manager's context reset. It carries: scope,
**the decisions the human made and their answers**, what shipped with its URLs, what
carried over, and the new lessons.

Relate it to the requirement tracker so a sprint says which contract items actually
moved. Without that, a sprint is a list of merges.
