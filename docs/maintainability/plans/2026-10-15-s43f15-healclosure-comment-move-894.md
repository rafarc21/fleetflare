# S43-F15: healClosure() doc comment -> do.ts heal wiring, cited from both suites (refs #850, refs #894)

Census: sweep 43, finding F15 (dup fixtures,
docs/maintainability/2026-10-14-dup-fixtures-sweep-43.md).
`studio.replacement-restart.test.ts:1307` and
`studio.replacement-restore.test.ts:201` carry a byte-identical 6-line doc
comment above their local 3-line `healClosure()` adapters. Task #894's
ruling: NO-ACTION on the function fold (marginal at 3 lines); the comment
is the real duplication — move it next to the heal wiring in
src/studio/do.ts and cite it from both tests.

## What

- do.ts gains one comment block directly above the
  `() => this.restartStudio("heal")` closure inside `syncSession()`
  (~line 8318), stating the distilled form a restore-path test may drive
  (`restartWithStorage(deps, storage, id, slug, "heal", storage)`) and why
  the rest of the real closure (credential refresh / spawn-token settle)
  is out of a Worker-side restore test's scope.
- Both test files replace their verbatim 6-line comment with a short
  citation pointing at that do.ts comment. The `healClosure()` functions
  themselves stay byte-identical in both files — comment move only, no
  fold, no deletion.
- The restart file's copy is uncalled (dead since the capstone describe
  moved into the restore suite); its citation says so honestly. Deleting
  it is function-fold territory, out of scope per #894's ruling.

## Steps (TDD)

Comment-only change: no new test is possible — a test asserting a
comment's presence would be a source-reading test, which test-lies-check
forbids. The existing suites are the green gate; run them after the edit.

1. `git fetch origin && git checkout -b fix-894-healclosure-comment-move origin/main`
2. Write this plan doc; commit `docs(maintainability): #894 plan — S43-F15 healClosure comment move into do.ts (refs #894)`; push with `LEFTHOOK=0 git push -u origin fix-894-healclosure-comment-move`.
3. Insert the do.ts comment block (verbatim in Exact text below).
4. Replace both test files' comments (verbatim in Exact text below).
5. Verify, one command at a time, nothing parallel:
   - `cd apps/fleet && bun x vitest run test/studio.replacement-restart.test.ts test/studio.replacement-restore.test.ts` — all pass
   - `cd apps/fleet && bun run english-check` — clean
   - `cd apps/fleet && bun run test-lies-check` — clean
6. Commit `test(fleet): S43-F15 move the duplicated healClosure doc comment into do.ts, cite from both suites (refs #894)`; push.
7. Write /workspace/.fleet/done/894.json (NOT committed, outside the repo) with the real output tails from step 5.

## Verification (gate budget)

Light only: one vitest run over the two touched suites plus two check
scripts. No full vitest lane, no tsc, no build, no e2e. One command at a
time, nothing parallel.

## Boundaries

- Files touched: this plan doc, src/studio/do.ts, and the two replacement
  test files. Nothing else.
- No code change of any kind: no function moves, no deletions, no import
  changes. `healClosure()` stays byte-identical in both files.
- The dead `healClosure`/`scriptedProbe` tail in the restart file stays
  as-is — only healClosure's doc comment changes.
- All comments English (english-check gate).

## Exact text

### do.ts — insert directly above `() => this.restartStudio("heal"),` in syncSession(), same 8-space indent as the Issue #71 comment block above it (which ends `// release removing.`):

```ts
        // Sweep 43 F15 (issue #894): this closure's distilled form for tests.
        // `restartWithStorage(deps, storage, id, slug, "heal", storage)` is
        // the one call a restore-path test needs to drive a real staged
        // heal; the credential refresh / spawn-token settle restartStudio()
        // also does along the way are DO-only concerns, already covered by
        // test/studio.refresh.test.ts and test/studio.self-heal.test.ts.
        // The two replacement suites cite THIS comment from their local
        // healClosure() adapters rather than restating it (it used to be
        // byte-identical in both test files).
```

### studio.replacement-restore.test.ts — replace the whole `/** Drives a real staged restore ... */` block (lines ~201-209, directly above `function healClosure(`) with:

```ts
/**
 * The heal closure `syncSession()` builds (do.ts), boiled down to the one
 * call that actually matters for this test — see do.ts's own comment on
 * that heal wiring (sweep 43 F15, issue #894) for why this distilled form
 * is the whole contract a restore-path test needs.
 */
```

### studio.replacement-restart.test.ts — replace the byte-identical `/** Drives a real staged restore ... */` block (lines ~1307-1315, directly above `function healClosure(`) with:

```ts
/**
 * The heal closure `syncSession()` builds (do.ts), boiled down to the one
 * call that actually matters — see do.ts's own comment on that heal wiring
 * (sweep 43 F15, issue #894). Uncalled in this file: the capstone describe
 * that consumed it lives in studio.replacement-restore.test.ts, and sweep
 * 43 F15 ruled comment move only, no function fold or deletion.
 */
```
