# S29-F2: canonicalize RepoReachFetch + BoardRepoDeps → WorkRepoDeps (refs #647)

Board issue #664. Sweep 29 findings S29-F4 + S29-F10 from
docs/maintainability/2026-10-13-duplicate-types-sweep-29.md. Type-only; zero
runtime change.

- S29-F4: `RepoReachFetch` = `(slug: string) => Promise<RepoReach>` is
  declared identically and exported in src/board/routes.ts:125 and
  src/studio/routes.ts:187, zero importers anywhere. Canonical: one export in
  src/github/reach.ts (where RepoReach lives — binding-free leaf module, so
  the new type-only import keeps every tsconfig project clean). Both routes
  files delete their local declarations and import the alias.
- S29-F10: `BoardRepoDeps` (src/board/board.ts:965) duplicates
  `WorkRepoDeps` (src/studio/repo.ts:224) — identical `{ reachRepo: (slug:
  string) => Promise<RepoReach> }`. Canonical: WorkRepoDeps (already
  exported, already imported by studio/routes.ts:28 and
  test/studio.repo.test.ts:4). board.ts deletes BoardRepoDeps and imports
  WorkRepoDeps from ../studio/repo (edge already exists — parseRepoSlug
  imported from there at board.ts:31).

Steps (TDD):
1. RED: add board.routes test block importing `type RepoReachFetch` from
   ../src/board/routes — fails while routes.ts declares its own local alias
   it does not import (duplicate identifier) and fails at reach.ts (no such
   export) once routes.ts imports it. Run vitest on the two touched test
   files, confirm failure, commit.
2. GREEN: reach.ts gains the alias export; both routes files drop local
   declarations and import it; board.ts drops BoardRepoDeps and imports
   WorkRepoDeps. Run the two test files, confirm pass, commit, push.
3. Grep proof: no `RepoReachFetch`/`BoardRepoDeps` declarations outside
   reach.ts remain.
4. Gates (sequential, one heavy gate at a time, flock the check):
   touched vitest files, `bun run check` under
   `flock /tmp/fleet-gate.lock`, english-check, test-lies-check.

Line refs re-pinned at origin/main 895811d. Lane: GLM-OK — board/routes.ts,
studio/routes.ts, github/reach.ts, board/board.ts, studio/repo.ts touch no
auth, secrets, credentials, rescue, failover, accounts routing, deploy,
migrations, write-proxy, leak-gate, or approvals path.
