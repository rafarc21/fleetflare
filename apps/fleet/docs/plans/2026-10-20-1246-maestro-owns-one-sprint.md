# Plan — #1246: maestro owns one sprint (repo part)

## Objective

Board issue #1246 adds the "one maestro = one open sprint" ownership rule. The
cloud studio's scope is the REPO part only — items (2) and (3): the skill doc
rule and its public copy. The local tooling (item 1: `~/.fleetflare-maestro`
cloud-gate.sh/assign.sh ownership guards, registry.tsv sprint column) runs on
the operator's machine and is NOT part of this branch.

## The rule

One maestro = one open sprint. A maestro owns the one sprint whose milestone
description carries `Owner: <this-maestro>`, files every task into that sprint
(`fleet task new --sprint "<name>"`), and freezes scope at planning. New asks
and review follow-ups outside the frozen scope go to the backlog (`--backlog`)
or the next sprint, never the current one. Progress is reported as
`Sprint w: x/y (z%)` via `fleet sprint status`.

## Change

- `skills/maestro-playbook/SKILL.md` — add the rule after "One maestro = one
  merge gate".
- `skills/fleet-cockpit/SKILL.md` — add the rule after "One studio per role per
  repo". `skills/` is this repo's public copy of the playbook rule; no separate
  docs/ mirror exists.

## Boundaries

Two skill docs only. No code, no local scripts, no Worker changes. Builds on
#1245's `fleet sprint` verbs (already merged).

## Verification

`bun run english-check` — clean, exit 0. Docs-only; the full test suite is not
a meaningful gate for two markdown paragraphs, but `bun run check` and
`bun run english-check` still run to confirm nothing else broke.