# Test-reachability sweep 23 — orphan tests, unused fixtures (2026-10-12)

Ref #579. Read-only analysis of test runners vs test files at `origin/main`
8cc5ffa. Scope per brief: apps/fleet/test, apps/fleet/vitest.config.ts,
bunfig.toml, package.json test scripts, .github/workflows (READ ONLY).
No code changed. Findings filed as `test(GLM-OK): S23-Fn` issues.

## Method

Enumerated every `*.test.ts` under apps/fleet (336) plus repo-wide strays,
classified each against the four runners that exist:
- vitest (`bun run test`): default `**/*.test.ts` include minus vitest.config.ts
  `exclude` (`test/bun/**`, `test/studio.files.test.ts`,
  `test/studio.studio-blueprint.test.ts`) — 189 files
- bun-test (`bun run bun-test`): `test/bun` + the two named files above — 147 files
- `bun run test:integration` / `test:acceptance`: test-integration/attach.e2e.ts,
  cli.acceptance.ts — manual lanes (docker-gated), package.json only
- skills/: skills/junior (bun test, documented in
  docs/superpowers/plans/2026-09-28-junior-workers-ai.md) and
  skills/release-verification-checklist/worker (own vitest.config.ts +
  package.json test script, documented in SKILL.md) — operator-run lanes
Then grepped for `.only(`/`.skip(`/`.todo(`, and for duplicate it/test names
per file with describe-context tracking (regex over `it(`/`test(` lines;
template-literal names resolved by reading the generating loops).

## Findings

### S23-F1. install-cache-security injection tests litter the checkout with empty `x$(touch …)y` dir trees — GLM-OK

`test/bun/install-cache-security.test.ts` (2026-10-13, #790: file split by #736 into `install-cache-security-parse.test.ts` + `install-cache-security-disk.test.ts`; these proofs now live in `-parse.test.ts` ~:466-620, and the litter fix itself landed via #598) (MUTANT PROOF blocks, lines ~448-500,
539-543) run the FIXED, shipped `installCacheRestoreCmd(evil)` /
`installCacheSaveCmd(evil)` where `evil = x$(touch /tmp/<marker>)y` is a BARE
relative path. The shipped commands' own `mkdir -p ${shQuote(dir)}` /
`[ ! -d ${dir}/node_modules ]` lines materialize that literal name relative to
the test process cwd (`apps/fleet/`): `apps/fleet/x$(touch /` →
`.../tmp/install-cache-sec-pwned-<hex>)y` empty dir trees. Measured twice on
this studio (two hex markers, Oct 11). Empty dirs are invisible to
`git status` and survive `git clean -f` only via `-d`; nobody notices them
accumulate. The PRE-FIX baselines are fine (injection fires, `touch /tmp/...`
is absolute, nothing relative is mkdir'ed); the FIXED-command proofs are the
litter source. Evidence checked: globs are irrelevant here (file IS run by
bun-test); litter confirmed via `find "apps/fleet/x\$(touch " -type d` and
`git clean -nd apps/fleet`. Proposed action: in the two MUTANT PROOF blocks
that pass a bare `evil` (installCacheRestoreCmd full-pipeline proof ~line 479,
installCacheSaveCmd full-pipeline proof ~line 493), pass
`join(base, injectionPayload(marker))` instead — same injection shape
(absolute-prefixed), same bash-parsing proof, zero cwd litter — and add a
teardown `rmSync` safety net for the base tmpdir (already exists as
afterEach). Batch: test-only change, one file.

### S23-F2. test:integration / test:acceptance have no automated lane — observation, no issue

`bun run test:integration` and `bun run test:acceptance` (package.json) run
test-integration/attach.e2e.ts and cli.acceptance.ts. No workflow, no
localci.sh lane, no doc outside their own headers mentions running them;
both need docker + network (headers say so). This is deliberate (docker-gated
manual lanes) but nothing anywhere RUNS them on merge day — silent-rot risk.
Workflows are READ ONLY for this sweep and the change would be a CI-policy
call, so this is recorded here only; proposed action (for the maestro to
decide): a periodic or pre-merge-gate note in CONTRIBUTING.md listing the two
manual lanes, or a localci `--with-integration` opt-in lane. Not filed as a
GLM-OK issue.

## Verified clean (negative results, evidence kept)

- Orphan test files: 0. All 336 `*.test.ts` under apps/fleet match a runner
  glob (189 vitest / 147 bun-test, counts via path classification against
  vitest.config.ts's exclude + package.json's bun-test script). No *.spec.ts,
  no *.test.tsx, no test files outside test/, test/bun/, test-integration/
  (find census). skills/ tests each have their own documented runner.
- Unused fixtures/helpers: 0. All 19 non-test .ts under test/ + test-integration/
  are referenced (test/fixtures/* imported 1-26x each — rate-limit-panes 26,
  activity-panes 4, cswap-list 3, destroy-refusals 2, account-rows-main 1,
  survey-panes 1, envelope-comment-issue-163 1; test/helpers/* 1-16x;
  orca-workspace.exit-code.ts + registry-writer.ts referenced via
  import.meta.dir string join in orca-workspace.test.ts:725,1249;
  dev-entry.ts spawned by attach.e2e.ts via `wrangler dev` — string ref,
  not an import; harness.ts 8x; bunfig preload real-git-preload.ts 1x).
  test/bun/helpers/shell.ts 34x. fixtures/ego-browser/hang-forever-chromium.sh
  referenced from ego-browser-launch-timeout.test.ts.
- describe.only/it.only: 0. Grep for `.only(`, `.skipEach`, `.todo(` across
  test/ + test-integration/: no hits.
- Duplicate test names: 0 true positives. 24 files repeat it-names ACROSS
  different describe blocks (e.g. github.api.test.ts "404: false, not a
  throw" x6 under pullRequestExists/branchExists/... — legal). One candidate,
  git-wrapper.test.ts `x${c.name}: real git DOES move the default branch…`
  x2, resolved: two separate case-loops (lines 1639/1738) generating
  distinct runtime names per case (X6/X7/N1/N1b/N3) in different describes.
- bun-test named-file guard: test/studio.files.test.ts and
  test/studio.studio-blueprint.test.ts exist and appear in BOTH the bun-test
  script AND vitest's exclude — double-wired correctly, not orphaned.
- Litter census (this studio only, untracked, NOT findings by themselves):
  `apps/fleet/x$(touch …)y` trees (S23-F1's product) and an empty
  `apps/fleet/src/studio/.oldreview-cli/` directory (0 files; reference in
  git history only — `git clean -fd` fodder, no repo change needed).
