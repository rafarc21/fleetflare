# deploy-ops-guard.test.ts throwaway fixture never pushes a default branch (board issue #126)

Fix task. `bun run bun-test` (apps/fleet) could not exit 0 in any studio
container, independent of any feature branch's own changes. Confirmed on
`origin/main` itself: `bun test test/bun/deploy-ops-guard.test.ts` produced
59 pass / 6 fail, every failure the identical error thrown from the test's
own `git()` helper:

```
error: git push -q origin main: fleet: studios never push the default branch — open a PR
    at git (apps/fleet/test/bun/deploy-ops-guard.test.ts:28:77)
```

## Root cause

`apps/fleet/test/bun/deploy-ops-guard.test.ts` builds its own throwaway git
repos entirely inside `mkdtempSync` tmp dirs — a bare "origin" fixture
(`git init -q --bare -b main`) and a clone of it — explicitly documented in
the file's own header comment as "never a real ops clone". Several test
scenarios legitimately need to push straight to that throwaway repo's own
`main` branch, to exercise `scripts/deploy.sh`'s ops-checkout guard.

`/usr/local/bin/git` (installed fleet-wide, issue #253) intercepts every
`git push` in the container and refuses one whose dry-run shows it would
move a remote's *resolved default branch* — by design, deliberately blind to
WHICH remote, specifically so it can't be fooled by a decoy/local remote
standing in for the real one (see the wrapper's own header comments, issues
#310/#344). That design is correct for protecting the studio's real GitHub
remote, but it has no way to distinguish "the real rafarc21/fleetflare
default branch" from "a disposable bare repo a test created two lines ago in
`/tmp`" — so it refuses the test's own internal fixture pushes too. The
first push to the bare repo's `main` succeeds (the ref is still unborn, so
the wrapper cannot yet resolve a default to protect); every later push that
moves `main` is refused once the wrapper can resolve it.

Verified directly (by experiment, this session): leaving the bare repo's
placeholder default branch permanently unborn instead of seeding it does
**not** fix this — the wrapper then fails closed on every later push
(`cannot resolve the remote's default branch`), not just default-named
ones. The wrapper needs a real, resolvable default to leave alone, plus a
genuinely separate branch for the fixture's actual work.

## Fix

`apps/fleet/test/bun/deploy-ops-guard.test.ts` only:

- The bare throwaway "origin" repo's default branch is renamed from `main`
  to `unused-default`, seeded with exactly one throwaway commit
  (`--allow-empty`), and never pushed to again.
- All real fixture work (the `fleet/wrangler.jsonc` seed commit and every
  subsequent push/clone) moved onto a separate branch, `trunk`, which is
  never the bare repo's resolved default — so the wrapper's push-refusal
  logic never fires for these fixture pushes.
- All four `git clone` calls of the throwaway `origin` now pass
  `--branch trunk` explicitly (otherwise they would check out the now-empty
  `unused-default` branch).
- Every `git(..., "push", "-q", "origin", "main")` → `"trunk"`; the one
  `git(origin, "rev-parse", "main")` → `"trunk"`.

`apps/fleet/scripts/deploy.sh` is untouched — it is already
branch-name-agnostic (works off generic HEAD/upstream comparisons, never a
hardcoded branch name), confirmed by inspection.

## Out of scope (per the issue, and confirmed unnecessary)

- `/usr/local/bin/git` — shared fleet-wide safety infrastructure, outside
  any single task's authority; its own comments document a real arms race
  (#310/#344) against "is this push really going somewhere harmless" that a
  narrow carve-out would have to answer correctly. Not touched.
- `apps/fleet/scripts/deploy.sh` — confirmed branch-name-agnostic; no change
  needed.

## Files touched

- `apps/fleet/test/bun/deploy-ops-guard.test.ts` — fixture rework described
  above (30 insertions, 14 deletions).
- This plan doc.

## Provenance note

The fix itself was diagnosed and written by a prior session of this same
studio (commit `8e16b86`, authored by Rafael Rjeille), which was cut off by
a weekly API-limit recycle before it could open a PR. That commit's diff was
confirmed byte-identical and cleanly cherry-pickable onto current
`origin/main` (the target file had not changed since the stale branch
forked off an older point of main), so this task cherry-picks `8e16b86`
verbatim rather than re-deriving the same fix.

## Verification

`cd apps/fleet`, one command at a time (never in parallel — shared
container memory ceiling):

- `bun test test/bun/deploy-ops-guard.test.ts` → 65 pass, 0 fail (was 59
  pass / 6 fail on `origin/main` before this fix).
- `bun run bun-test` → the full bun suite, must exit 0 (this is literally
  what #126 is about).
- `bun run test` (vitest run) → full vitest suite green.
- `bun run check` → tsc --noEmit across all 5 projects, clean.
- `bun run english-check` → clean.
- `bun run build:page` → clean.

Real command output for each is recorded in this task's completion record,
`.fleet/done/126.json` (outside the repo checkout, not committed).
