# Refactor #346: deepen repo-check.ts — narrow the 10-field opts bag, delete the pass-through, 2-line header

**Goal:** Make `scripts/repo-check.ts` deep instead of shallow: interface shrinks to what its 2 callers actually vary; the `collectRepoCheck` pass-through dies; the 28-line history header shrinks to 2 lines of why. Plus one pinned test from #343's review: how far `scanCalls` advances past a skipped `Bun.file` candidate.

**Spec:** https://github.com/rafarc21/fleetflare/issues/346 (from #344's review). Behavior-preserving, GLM-OK. Refs #321 #323.

## Findings being fixed (all verified on this branch's main)

1. `RepoCheckOpts` has 10 fields for 2 callers. Real variance across english-check vs test-lies-check: `select`, `scanFile`, `format`, `stream` (stderr|stdout), `failSummary`, `cleanLine`, `fileCount` (only test-lies). Constant or derivable: `root` (both REPO_ROOT; but tests pass throwaway roots — keep as param), `allowlist` (each script's own ALLOWLIST), `cleanExit` (always 0 — delete the field, return 0 unconditionally on clean).
2. `collectRepoCheck` (repo-check.ts:82-89) is a pass-through wrapping private `scanOnce` — deletion test: callers could call the shared listing directly. Delete it; export `scanOnce`'s shape under one honest name.
3. Header (repo-check.ts:1-28) narrates history (issue numbers, plan task numbers, drift story). Keep 2 lines: what the module owns (one `git ls-files -z`, select/allowlist filtering, binary skip, collect, report, exit code) and the stream contract (findings+failSummary→`stream`, cleanLine→always stdout). The stream-contract WHY may move onto the fields that need it.
4. #343 review follow-up: removing the skip-advance line (`re.lastIndex = bal.endIndex + 1` in `scanCalls`'s kept-null branch, test-lies-check.ts) passes all current tests. Add a pin test THROUGH `findBunFileTextCalls`/`findSourceReading` (public surface): a `Bun.file(...)` WITHOUT `.text()` whose argument text contains another `Bun.file(` that WOULD match — the skipped candidate must not be rescanned.

## Task 1 — pin test first (RED)

New test in `test/bun/test-lies-check.test.ts` (#323 characterize block or its own): fixture text `const a = Bun.file(join(dir, "src/x.ts")).json(); const b = Bun.file("src/y.ts").text(); const t = await b.text();` — wait, shape precisely: first `Bun.file(` candidate has NO `.text()` (skipped) and its ARG text contains a nested `Bun.file("src/y.ts").text()` string literal... Use: `const q = Bun.file("src/no.text(" + Bun.file("src/inner.ts").text() + ")");` — outer candidate skipped (no `.text()` in the 10-char window), inner candidate IS a real `Bun.file(...).text()` call that must still be found and flagged by `findSourceReading` (with the captured-variable assertion). Run it: it must PASS on current code; deleting the skip-advance line must make it FAIL (verify by /tmp mutant run, never by editing the repo file). Pin whatever current behavior is — investigate if it differs.

## Task 2 — the refactor

`repo-check.ts` after: 2-line header; `scanOnce` logic + collect + report + exit in one exported surface — design freedom within these constraints: `runRepoCheck` name + `(opts)` shape may change to a narrower options type; `collectRepoCheck` deleted; english-check.ts:103 + test-lies-check.ts:532 `scanRepo` bodies and main blocks updated to the new shape; CLI bytes unchanged (pinned by repo-check-runner.test.ts, 8 tests). The runner-gap pin test (repo-check-runner.test.ts:160-210) may need its `cleanExit: 0` line dropped when the field dies — that is a test edit reflecting the narrowed interface, allowed; everything else in that test must pass unchanged.

## Verification (sequential, from apps/fleet)

- `bun test test/bun/repo-check-runner.test.ts test/bun/test-lies-check.test.ts test/bun/english-only.test.ts` — pass (65 incl. new pin).
- `bun run test-lies-check` — `0 tautological, 0 source-reading, 0 own-module-mock across 314 test files`, exit 0.
- `bun run english-check` — `english-check: clean`, exit 0.
