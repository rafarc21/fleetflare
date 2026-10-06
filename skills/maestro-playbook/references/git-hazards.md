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
