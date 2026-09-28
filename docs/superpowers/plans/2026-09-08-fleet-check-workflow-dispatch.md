# Fleet Check — add `workflow_dispatch` trigger

**Goal:** `.github/workflows/fleet-check.yml` only triggers on `pull_request`/`push` paths filtered to `apps/fleet/**`. Since PR #108 itself doesn't touch `apps/fleet/**`, the workflow it adds never runs on its own PR — there's no way to see it execute without merging first. Add `workflow_dispatch` so it can be triggered manually from the Actions tab against any branch, including `ci/fleet-check-workflow`, to verify the wiring before merge.

**Scope:** One line, one file: `.github/workflows/fleet-check.yml`, added as a sibling key under the existing `on:` block, alongside `pull_request` and `push`. No changes to path filters, no changes to the job/steps, no changes to `apps/fleet/` itself or to the reporting workflows.

## Change

Commit `f7a550f`:

```diff
   push:
     paths:
       - 'apps/fleet/**'
+  workflow_dispatch:
 
 defaults:
   run:
```

`git show f7a550f --stat`: 1 file changed, `.github/workflows/fleet-check.yml`, 1 insertion(+).

## Secondary purpose — live test of the GitHub App `workflows` permission

Task #107 was blocked because the GitHub App installation lacked the `workflows` permission, so pushes touching `.github/workflows/**` were rejected. The operator has since fixed that permission. This one-line change to `fleet-check.yml` doubled as the first real test of the fix: the commit was pushed to `origin/ci/fleet-check-workflow` successfully, confirming the `workflows` permission block from #107 is resolved.

## Verification run locally

- `git show f7a550f --stat` — exit 0, confirms the single-file, single-line diff described above.
- `bun x js-yaml .github/workflows/fleet-check.yml` — exit 0, parses cleanly; `on:` now shows `pull_request`, `push`, and `workflow_dispatch` (null value, i.e. no inputs) as three sibling keys.
- `git diff main -- apps/fleet/package.json .github/workflows/client-reports.yml .github/workflows/reporting-check.yml` — empty, confirms no scope creep into the fleet app itself or the existing reporting workflows.

## Verification intent (manual, on GitHub)

Open PR #108, confirm the `on:` block now includes `workflow_dispatch` alongside `pull_request`/`push` (both still `apps/fleet/**`-filtered). Then go to the Actions tab, select "Fleet Check", and run it manually against `ci/fleet-check-workflow`. Expect it to run install/check/test as separate steps and then fail specifically on "Container tests (bun-test)" with `error: Script not found "bun-test"` — the same known, already-documented gap from task #107 (`apps/fleet/package.json` has no `bun-test` script yet). Everything before that step passing proves the wiring itself, and the manual-trigger path, are correct.
