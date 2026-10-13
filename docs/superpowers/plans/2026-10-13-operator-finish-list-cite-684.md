# S28-F2 — Fix stale OPERATOR-FINISH-LIST.md cite in do.ts comment (refs #684, refs #643)

Sweep 28 finding: `apps/fleet/src/studio/do.ts:4654` cites
`docs/superpowers/OPERATOR-FINISH-LIST.md §9`. No file matching
`*OPERATOR-FINISH-LIST*` exists in the tree and `git ls-tree` across all
commits shows it was never committed anywhere. docs/superpowers/ holds
only evidence/plans/specs.

## Scope

Comment-only change. Never code. Drop the stale repo path; the §9
procedure (delete SPAWN_TOKEN_KEY from DO storage, recycle, provision)
is already spelled out in the same comment, so the pointer adds nothing
a reader can follow. Sibling at src/studio/org.ts:109 already spells it
path-free: "OPERATOR-FINISH-LIST §9".

## Steps

1. Edit the comment at do.ts:4652-4654 from
   `recycle the container, provision. See
   docs/superpowers/OPERATOR-FINISH-LIST.md §9.` to
   `recycle the container, provision. See the operator's own
   finish-list notes (kept outside this repo), §9.`
   (org.ts:109 keeps "OPERATOR-FINISH-LIST §9" as the shared name.)
2. Verify: `grep -rn "OPERATOR-FINISH-LIST" apps/fleet/src` shows no
   `.md` path anywhere — only path-free §9 references.
3. Run english-check (comment text is repo content).

## Verification

- `grep -rn "OPERATOR-FINISH-LIST" apps/fleet/src` → no `.md` suffix,
  no `docs/superpowers/` path.
- `cd apps/fleet && bun run english-check` → exit 0.
- `cd apps/fleet && bun run test-lies-check` → exit 0.
