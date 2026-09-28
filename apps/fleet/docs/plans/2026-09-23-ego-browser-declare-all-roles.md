# Declare ego-browser on all roles (board task #33)

## Problem

The `ego-browser` shim binary (apps/fleet/container/ego-browser) ships in
every role's container image — it is not web-studio-specific. But the skill
was only declared in one studio's `skills:` array: `web-studio/studio.md`.
Every studio's brief nonetheless tells every role "use the `ego-browser`
skill, NOT agent-browser," regardless of role. An undeclared skill on a role
whose brief references it means that role's agent either invokes an
undocumented API cold or reports a false browser blocker — the skill
resolution machinery (`skills/<name>/SKILL.md`) simply isn't wired up for
that studio, even though the binary is sitting right there in its image.

## Operator's ruling

Issue #33: declare `ego-browser` on ALL roles, maestro included, even though
maestro itself never implements a browser task. This is the operator's
explicit call, not a judgement made in this pass — maestro gets the
declaration so the mandated brief line stays honest and consistent across
every studio, rather than carving out an exception that would need
re-litigating the next time someone reads maestro's brief next to its
`skills:` list.

## The fix

Two one-line additions to the `skills:` arrays in:
- `fleet/blueprint/studios/maestro/studio.md`
- `fleet/blueprint/studios/release-studio/studio.md`

(`web-studio/studio.md` already declared it from the prior ego-browser shim
work; release-studio and maestro were the two roles missing it.)

## Why resolution, not list membership

Typing a name into a `skills:` array is not proof that anything works.
`provision.ts`'s `harnessCheckSnippet` resolves each declared skill against
`skills/<name>/SKILL.md` (repo root, or a plugin cache) checking for a
matching frontmatter `name:` line — a name that doesn't resolve there
produces a silently-bare studio, invisible until someone actually spawns it
and the harness check fails or quietly no-ops. A test asserting only "the
array contains the string ego-browser" would not catch that class of bug.

So `apps/fleet/test/bun/studio-skills-resolve.test.ts` proves resolution in
general rather than adding one more one-off per-skill assertion: it walks
every studio's `studio.md`, parses its `skills:` array with the same
`parseStudioFile` helper `provision.ts` uses, and for each declared name
asserts it resolves to a real `skills/<name>/SKILL.md` whose frontmatter
`name:` matches the slug. This is a general sweep that will also catch any
future studio/skill mismatch, not just this one. On top of that general
sweep, two explicit per-studio assertions pin the actual point of task #33
(maestro and release-studio each declare `ego-browser`), so the general test
can't pass by coincidence if someone later removed the declaration while the
skill itself still resolves fine elsewhere.

## TDD

The resolution test was written first and confirmed failing (missing
`ego-browser` in maestro's and release-studio's declared `skills:` lists)
before the two `studio.md` edits were made; it passed once both one-line
additions landed.
