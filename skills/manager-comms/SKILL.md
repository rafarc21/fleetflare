---
name: manager-comms
description: Use when writing to a human who runs several agent projects at once - covers the action points block, identifier naming, when to interrupt, and keeping documents from contradicting reality.
---

# Talking to a busy human

Written for someone running three or four agent projects simultaneously, online
throughout, reading fast.

## End every message with action points

Last thing, always, same heading. **Never bury a decision in prose.**

```
## Action points

1. **Imperative verb + object** — what it unblocks. Where.
2. **...**

Nothing else needs you.
```

Verb first: "Press Enter on X", not "X is waiting". One line each, context lives
above. **Nothing pending: say so explicitly**, because silence reads as forgetting.
Separate what needs them from what needs a third party.

## Never write a bare identifier

A number alone is a lookup you pushed onto them.

- **Issue:** `IS#54 (short real title)`
- **Pull request:** `PR#54 (short real title)`

Uppercase, no space. GitHub numbers both in one sequence and cannot be configured
otherwise, so the distinction has to live in the writing.

Same for requirement codes: `R31 (design fidelity)`, never bare `R31`. **Every
mention, not just the first.** Look the title up rather than invent it.

## Contact them when it matters, not on a schedule

No standing meeting beyond sprint open and close. They are reachable throughout.
**A message at the right moment beats an interval meeting nobody needed**, and a
decision that sat unasked for two hours is worse than an interruption.

Interrupt for: a decision blocking work, a discovery that changes scope or risk,
something they asked to be told.

Do not interrupt for: status that has not changed, a decision that is yours, a
question answerable by looking.

## Report only what changed

Repeating an unchanged board every cycle trains them to skim you. If nothing moved,
say nothing moved, in one line.

## Deliver with a verified URL

Never "it works". A **specific route you opened yourself**, never the bare root, plus
what to look for, plus any credentials, plus the action points.

## Correct yourself plainly

State the correction, continue. No ceremony, no self-flagellation. If you overrode
someone who was right, say so.

**Verify before asserting.** When a check produces an alarming result, verify the
check before the finding. A broken check reporting a catastrophe is more common than
the catastrophe.

## When code makes a document false, fix it in the same change

Not a follow-up, not an issue. The same change.

**A document contradicting reality is worse than a missing one, because it gets
trusted.** This costs a reversal every time: someone reads the stale document,
concludes correct work is wrong, and sends its author to break it.

When a human tells you something verbally that changes a documented fact, get it into
the record the same day.
