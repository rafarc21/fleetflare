---
name: delivery-standards
description: Use before telling anyone that work is ready - the self-verification gate, the delivery message shape, dev server discipline and the port registry that stops agents handing over each other's URLs.
---

# Delivery standards

Spine: **evidence before assertions.** Verify first, then speak, and speak so the
reader can act in one pass.

## The delivery contract

Every "it is ready" message carries three things, in order:

1. **A pre-verified test URL** for a **specific route**, never the bare root, that you
   already opened and confirmed.
2. **A context block**: what changed, what to look for, any credentials or setup.
3. **Numbered action points**, or an explicit "nothing needed from you".

```
✅ <one line: what is ready>

🔗 Test it: <url to the SPECIFIC route>
   I opened this and confirmed <the exact thing>. Console and network clean.

What to look for:
  • <what to click, scroll to, resize>
  • <expected result>

Verification:
  • Gates: <commands> — all clean
  • Tests: <N> passing, coverage <before> -> <after>
  • Browser: <widths>, console clean, network clean

Context:
  <2 to 4 lines: what changed, what you decided, what you left out>

## Action points
  1. <decision answerable by number>
```

Never end with "done", "should be fixed", or "let me know if you have questions".

## The self-verification gate

You may not present work as ready until you have personally verified it:

1. **Server responds.** `curl` it on a real route. "I ran the start command" is not
   "it is up".
2. **Opened and driven in a browser.** Navigate, click, scroll. Not "it probably
   renders".
3. **Console and network clean**, at every width, **after a full scroll** so lazy
   assets actually load.
4. **The specific change confirmed** by doing it and seeing the result, not by
   reading the code.
5. **Screenshot taken and read.** A screenshot you did not look at proves nothing.
   Confirm it shows the right page, right data, no error overlay.

**Console errors are a delivery blocker.** Work that renders correctly and leaves
exceptions behind is not done. It is the most common way broken work reaches a human.

Cannot complete the gate? Say what is blocking. Do not dress it up.

## Never claim what you have not just run

Before "done", "fixed", "passing": run the command, read the output, claim only what
the output proves. Tests failed, say so with the output. Step skipped, say skipped.

**Look at the artefact, not only the number.** Recorded cases: a compression tool cut
a file from 85 MB to 5 MB and delivered blank pages with page count intact; a
measurement tool reported 90,6% where the truth was 98,3%; assets cropped from a
render scored 99,9% against themselves while hand-built sections sat at 84,7%.

A dramatic improvement is a reason to look harder.

**Ask what your gate cannot see.** A tool measuring at exactly two designed widths is
structurally blind to anything breaking between them.

**Sometimes unchanged is the pass condition.** If a fix should not move a number and
the number moved, the fix reached somewhere it should not have.

## Port registry

Every agent gets a **fixed port range**, in one table everyone reads. Two agents on
one port means the URL handed over points at the wrong agent's work, silently.

Check free before binding. Know whether your framework **auto-increments** a busy
port instead of failing: if it does, the port you asked for is not necessarily the
port you got, so confirm what actually bound.

Know your framework's host flag. Some bind IPv6-only by default and browser drivers
then get connection refused for reasons that look like anything but that.

## Clean up

Kill your dev server when you are done. Do not start a second while the first is up.
Remove throwaway worktrees, containers and artefacts. In a fleet, memory and disk are
shared and nobody else can tell which server is yours.

## Review → fix loop

A reviewer that fixes what it finds stops being independent — its own next
finding is now graded against its own last fix. Keep the two apart: a
fresh-context reviewer reports, read-only, never touching code; a SEPARATE
fresh-context fixer — never the original implementer, never the reviewer
itself — applies the fix and commits it directly, before the PR opens. This
closes the loop (findings become landed code, not just comments) without
ever letting the reviewer mark its own homework.

This is not a new process — it is this fleet's existing, already-correct
practice, written down for the first time. See
`fleet/blueprint/studios/web-studio/studio.md` for the live version: Code
Reviewer reports Spec axis and Standards axis separately; Standards-axis
findings go to a fresh-context Developer for a refactor step that commits
the fixes directly, same push discipline and same one-heavy-gate-at-a-time
rule as any other implementation step; Spec-axis findings (and anything the
refactor step can't resolve mechanically) go back as a comment to the
original Developer instead, never silently reworked by the fixer. If this
section and `studio.md` ever read as contradicting each other, `studio.md`
is the live source — fix this section to match, don't let the two drift.

A Standards-axis finding now includes shallow-module findings, not only the
Fowler baseline — see `skills/deep-modules/SKILL.md`'s detection checklist
for what that looks like.
