---
name: spec-driven-delivery
description: Use when running spec-driven development across a fleet where the human does not talk to implementers - the role split, and the testing requirements every implementation plan must satisfy before it is approved.
---

# Spec-driven delivery in a fleet

Extends the Superpowers plan skills. **Where this and the skill disagree, this wins.**

## The problem it solves

Superpowers `brainstorming` is a live dialogue: one question at a time, approval per
section. That works for one human and one agent. It breaks the moment the human does
not talk to implementers.

**Brainstorming has two halves and the skill conflates them.** The expensive half is
machine work: read the code, read the design, find constraints, generate options with
real tradeoffs. The half needing the human is a handful of genuine decisions.

Split them and the constraint disappears.

## The split

```
explorer   -> decision sheet + context pack     (no human contact)
human      -> answers the sheet, batched
developer  -> starts at plan-writing with an approved spec
```

Explorers do exploration and never talk to the human. The manager batches, dedupes,
and brings one sheet. Developers never brainstorm: they receive a settled design.

A decision sheet entry is: the question, the recommended option, the alternative, and
**the cost of getting it wrong**. Numbered so it can be answered by number.

## When the full process is wrong

Mechanical work — a typo, a stale link, a rename, a version bump — does not need
brainstorming. The implementer proposes skipping to implementation with tests, in one
line, and the manager decides. When in doubt, run the full process.

**The verification gate never drops, at any task size.** There is no work too small
to verify.

## Every plan carries a Verification section

A plan without it is not finished and gets sent back. Rejecting a plan is cheap;
rejecting a branch is expensive.

### A. Automated tests

Written before or alongside implementation.

- One test per acceptance criterion. If a criterion cannot be a test, say so and say
  how it will be verified instead.
- **Rendering tests, not only logic tests.** The output contains the expected
  elements with the expected values.
- A regression test for every bug fixed. Red first, then green.
- Edge cases the spec implies: empty, one, many, missing optional field, longest
  realistic string.
- **Name the seams.** List the public interface each test goes through — the
  exported function, the HTTP route, the CLI command, the rendered element. A test
  that goes around a seam instead of through it (rereads a `src/` file as text,
  mocks the module under test, echoes an imported constant back at itself — this
  repo's own `test-lies-check` catches exactly these three shapes) needs a stated
  reason in the plan. No reason, no pass.

### B. Browser verification, as steps

Not "verify in the browser". Steps somebody else could follow: start the server,
curl a real route, open it, what to see at each width, what to click, what to expect.

Take a screenshot **and read it**.

### C. Console and network, explicitly

**The part that is always missing.**

Console clean on every route delivered. Network clean, no 4xx or 5xx, no failed
asset. **At every width**, because a media query can hide a broken asset at one and
load it at another. **After a full scroll**, because lazy assets do not fail until
reached.

### D. Self-QA gate

Gates clean and output read · tests green and output read · server curl-verified on a
real route · page driven in a browser · console and network clean after full scroll ·
screenshot read · every claim traceable to something seen.

Any box unchecked means not finished.

## Coverage

Keep coverage above 50% and have the manager track it. Every plan states the coverage
it expects to add; every delivery reports before and after. **Coverage going down is
a finding, not a detail.**

Coverage is a floor, not a target. 50% with untested rendering is worse than 40% with
it covered. Say what is covered, not only how much.

Coverage percentage can reward a test that cannot fail. The 50% floor counts
**behavior tests only** — a tautological assertion, a mock of the module under
test, or a source-text read standing in for the real seam inflates the number
without proving anything. Strip those before reporting coverage; don't bank them.

## Record what you learn, while you learn it

Implementers are killed eventually and their context goes with them. Write a memory
file the moment you learn something: a trap that fails silently, a bug fixed
non-obviously, a decision that changes how the next person builds. One file per fact,
with the reasoning.

Use a code knowledge graph before grepping the tree, where one is available.
