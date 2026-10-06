# Git hazards

Specific traps, each measured against a real incident.

- **Before every `git add`:** `git diff --cached --name-only --diff-filter=D | wc -l`.
  Mass staged deletions with the files still on disk means the index got
  wiped by something upstream — fix with a plain `git reset` (no `--hard`),
  never by re-adding.
- **Test subprocesses that spawn git must scrub `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`** from their environment, or they silently operate on the
  wrong repository.
- **Never bare `git stash` in a shared worktree.** Something else may be
  relying on the working tree state you just hid.
- **Before blaming a worker for "didn't push":** compare `git rev-parse HEAD`
  against `git ls-remote`. Count commits, never refs — an empty, newly-created
  branch pushed with nothing on it still reports success.
- **Commit before any mutation run.** A `git checkout` used to revert a
  mutation wipes uncommitted green work along with the mutant.
- **Never edit a running bash script in place.** Live-editing a script that is
  currently executing shifts byte offsets out from under it; write a new file
  and `mv` it into place instead.
- **Stacked PRs:** `gh pr list --base <branch>` and retarget before merging
  the base PR with `--delete-branch` — deleting the branch a stacked PR targets
  leaves it pointed at nothing.
- **Rescue pushes to a separate remote may be refused** for commits touching
  `.github/workflows/*` unless the credential doing the pushing has Workflows
  permission explicitly, even when it can write everything else in the repo.
- **Screenshots committed to a PR branch ship binaries to main.** A request
  for before/after PR screenshots can result in PNGs committed straight onto
  the PR branch (e.g. under `.github/pr-assets/`) — merging that PR ships
  the binaries into `main` too. Keep image assets on a separate,
  never-merged assets branch cut from `origin/main`, PNGs only, and link the
  raw URLs in the PR body rather than committing them to the PR branch;
  revert any PNG commit found on a PR branch before merge. On a private
  repo, a raw URL 404s for anyone not logged in — verify it resolves via the
  API, never by `curl`ing it logged out.

## Review guards the gate must actually run

- **Check the migration ledger after every studio PR, not just the PR
  body.** A brief that forbids applying migrations is not self-enforcing —
  studios have applied one anyway. Reading the PR's own description is not
  evidence of what actually ran; read the ledger.
- **A role-assignment guard that checks only the TARGET ROLE can still miss
  the real hole.** One guard checking "may this actor assign this role"
  without also checking the TARGET USER let a client-scoped admin demote a
  cross-tenant platform user — a user who, by design, is shared across every
  client the admin can see. Test the property against the qualifying set of
  users derived at RUNTIME for the role in question, never against one named
  fixture user chosen in advance; a fixture-only test can look complete
  while missing exactly the cross-cutting case that matters.

## Portable ids in migrations

Never hardcode a role, policy, or tenant UUID in a migration. Resolve it by
NAME instead, with an exactly-one assert on the lookup. A hardcoded id copied
from one environment's data has silently blocked a production promotion for
an hour, because the id that existed in staging did not exist in prod under
that number.

This is the same evidence-culture failure as "prove the failure path, not the
success path" (see the main `SKILL.md`'s evidence-culture section): a
migration that warns and continues on a missing lookup, prints "done", and
exits 0 without ever creating the row or constraint it existed to create is a
green run that proves nothing. Make the lookup's failure loud, not silent.

**A migration ledger written on exit 0 lies, in more than one shape.** A
runner that records "applied" whenever the underlying script exits 0 cannot
tell "ran and succeeded" apart from "skipped its own DDL on a missing env
var, printed done, and exited 0 anyway" — the row the migration existed to
create is simply absent either way, and the ledger says applied regardless.
A prod-only preflight that merely compares ledger rows between environments
inherits the same lie and degrades to a warning that never blocks, because
the ledger it is trusting was never proof in the first place. The fix is a
promotion gate that diffs the live PROPERTY itself — permission rows, field
masks, constraints — between environments, treating the ledger as advisory
at best, never as the source of truth.

**That live-property diff must be id-insensitive, or it reports phantom
drift on every environment pair.** Role, policy, and tenant UUIDs differ per
environment by construction, including UUIDs embedded inside a rule's own
filter expression — normalize every id to its NAME before comparing
anything. Multiple rules sharing one key compare as a sorted multiset, not a
single value; two objects that share a name need a stable signature beyond
the name alone, or the diff cannot tell them apart either. Prove the
normalization both ways: a fixture where every id is swapped for a
same-named different id must still PASS (nothing really changed); a fixture
missing one whole rule branch must FAIL (something really is missing). A
diff that only passes the first proves nothing about the second, and a diff
that only has one of the two fixtures is unproven in the direction it was
never tested.
