# Which PRs earn a checklist item

**The rule:** an item earns its place only when manual verification proves
something the repo's automated gates do not.

A checklist that re-checks what CI already proved wastes the reviewer's
attention and trains them to skim. Fewer, sharper items get read.

## Fill this in once per repo

> **GATES:** _<list this repo's automated gates here>_

Everything below is relative to that list. A repo with no e2e gate needs items
for things a repo with one does not.

Acme states its list in `scripts/checklist/README.md`.

## The table

| Needs an item | No item |
|---|---|
| New/changed UI, route, permission, or user-triggered action | docs-only |
| Tenancy / cross-tenant scoping change (verify the isolation live) | CI-config / workflow |
| A refactor with no test of the *wired* behaviour (regression smoke) | dependency / lockfile bump |
| A migration whose effect a user sees | test-only (un-quarantine, add tests) |
| Anything outward-facing (email, export, webhook) | type-only typecheck fixes |
| A spike/feature the deploy actually ships | a spike **not** wired/deployed |

## Method

Go PR-by-PR through the batch — the merge log (`git log <prod>..<staging>`) or
`gh pr list --base <integration-branch>` history.

If unsure, open the diff. A change touching only tests, CI config, markdown, or
lockfiles has no verification need.

## Ordering

Put the **lowest-privilege / client-facing roles first**. Admin sessions bypass
row-filters and presets, so an admin walkthrough hides exactly the scoping and
permission bugs real users hit. Administrator goes last and is worth least.

If a role is included only as a control, label it so — a reviewer who does not
know that will read a clean admin pass as coverage.

## Write items the reviewer can act on

- One observable claim per item. "Approve" must be unambiguous.
- Say **where** — the exact route.
- Say what **correct** looks like, not just what to click. A reviewer who does
  not know the expected outcome approves anything that renders.
- If the automated pass already proved part of it, say so in `verdict.t` so the
  reviewer spends attention on the rest.
