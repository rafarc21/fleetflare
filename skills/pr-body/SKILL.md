---
name: pr-body
description: Use every time you open a PR, on any repo that already uses `.github/pull_request_template.md`'s Summary/Evidence/Merge-Danger shape — this skill documents and extends that exact template, it does not replace it. Covers what makes a Summary legible without reading the diff (pseudocode plus one small diagram), what makes Evidence actually trustworthy (a runnable before/after, not a transcript to take on faith), and how to fill Merge Danger's Door and Blast Radius fields honestly. Model-invoked: reach for this on every PR, not only when asked.
---

# PR body

This skill is `.github/pull_request_template.md`, documented — not a second
template. If this file and that one ever look like they disagree, the
template wins; open an issue, don't silently pick one. There is exactly one
source of truth for PR-body shape in this repo, and it's the file GitHub
actually renders into every new PR.

The template's three sections, unchanged:

```
## Summary

## Evidence

## Merge Danger

- **Door:** one-way | two-way
- **Blast Radius:**
```

What follows is guidance for filling each section well — nothing here adds
a new heading or reorders the existing three.

## Summary

The template already says: smallest visual that shows the change, not a
restatement of the title. Two concrete ways to hit that:

- **Pseudocode of the change's actual shape** — not the real diff, not a
  code dump. A few lines of "what changed, in order", written so a reader
  who has never opened the diff still knows what moved. If the whole PR is
  a one-line fix, pseudocode isn't needed — the template's own screenshot-
  or-diff-snippet guidance already covers that case.
- **One small diagram when the change has more than one moving part worth
  drawing** — mermaid or ASCII, whichever renders faster to write. A
  single function renamed needs no diagram. A new data flow, a new state
  machine, a new module boundary usually does. "Small" is the operative
  word: a diagram that takes longer to read than the diff defeats its own
  purpose.

## Evidence

The template already says: before -> after, real test output, not "tests
pass." The one thing to add: make it **runnable**, not just quoted. A
reviewer should be able to copy a command straight out of the PR body and
get the same before/after result themselves — a pasted transcript they have
to trust is weaker evidence than a command they can run. Where there's a
genuine before/after state (a bug reproduced, then fixed; a metric, then
improved), show both, not just the after.

## Merge Danger

The template's Door/Blast-Radius structure is unchanged — this section is
guidance on filling it honestly, not new structure.

- **Door** — `one-way` or `two-way`. See
  `fleet/blueprint/studios/web-studio/studio.md`'s own classification rule:
  a path-based classifier (`apps/fleet/scripts/merge-danger.ts`'s
  `ONE_WAY_GLOBS`) is a FLOOR, never a ceiling — it can force `one-way`,
  but your own judgment can call a PR one-way even when no path matches.
  Never let the classifier downgrade your own one-way call to two-way.
- **Blast Radius** — one line: what breaks, and for whom, if this change is
  wrong. Name the actual blast, not the intent behind the change — "fixes
  the login bug" is not a blast radius; "every login attempt fails closed
  if the token check regresses" is.

## When to reach for this

Every PR, on any repo already using this template — not only when asked to
review PR quality. If a repo has no `pull_request_template.md` yet, that's
a separate, bigger decision (adopt the template first) outside this skill's
scope; this skill only extends an existing one, it doesn't introduce the
shape to a repo that lacks it.

See `skills/deep-modules/SKILL.md` for the companion maintainability
checklist a reviewer applies to the diff itself, separate from how the PR
body describes it.
