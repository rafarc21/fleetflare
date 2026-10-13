# Plan — S26-F12: install-cache-security.test.ts split — parse vs disk (refs #699)

Sweep 26 finding F12 (docs/maintainability/2026-10-13-oversized-test-files-sweep-26.md,
refs #635): apps/fleet/test/bun/install-cache-security.test.ts is 2087 lines,
11 lane-guarded describe blocks, one module under test (src/studio/install-cache).

## Split

Pure move, two new files, original deleted. Seams per the sweep doc:
- install-cache-security-parse.test.ts — lines 1-1294 of the old file:
  item 4 restore security, item 2 truncated-download atomicity, item 5
  injection, bunInstallRunningCmd (fs + /proc), path traversal, symlink
  guard, tombstone, round-5 disk-space preflight (df fake).
- install-cache-security-disk.test.ts — lines 1295-2087 of the old file:
  round-6 streamed SPACE proof (fakeNoopRmDir, findWorkDirs), symlink
  member guards, round-7 real-full-disk ENOSPC (canUnshareMount,
  runInFullTmpfs).

## Rules

- Lane-guard preamble (hasGnuTar/hasZstd/hasGnuFind/hasProcFs probes,
  suite/findSuite/procSuite aliases, mkdtemp base + beforeEach/afterEach,
  sh()) is COPIED VERBATIM into both halves — sweep doc hazard 1. The
  disk half additionally carries the canUnshareMount probe + unshareSuite
  alias (with its CI=true red fallback), verbatim.
- NO helper extraction in this PR. The task body names helpers/shell.ts
  as an extract candidate, but sweep doc hazard 2 forbids mixing a split
  with the sweep-18 dedup lane, and the maestro guard (issue #699 comment)
  demands a pure move. sh()/base stay duplicated per half. Extraction is
  future dedup-lane work.
- describe/test blocks move WHOLE, titles verbatim (sweep hazard 5). No
  assertion text changed. Comment banners between suites travel with the
  suite below them.
- Each new file gets a 3-6 line header comment: what it is (the parse or
  disk half of old install-cache-security.test.ts, split per this plan,
  refs #699), what the sibling file covers. Keep every pre-existing
  comment inside moved code verbatim.
- Block Placement: every function/statement moves to the half that USES
  it; a symbol used by both halves (buildPayload, seedCheckout, runRestore)
  is duplicated in both files, verbatim.
- Symbol-to-half map (verified by grep, line numbers of the OLD file):
  PARSE half keeps: hasGnuTar/hasZstd/suite, hasGnuFind/findSuite,
  hasProcFs/procSuite, base+hooks, sh(), buildPayload, seedCheckout,
  runRestore, preFixRestoreCmd, preFixInstallCacheRestoreCmdNoLocalCheck,
  pwnedMarkerPath, injectionPayload, injectionFired, cwdLitter,
  preFixDiscoverCacheDirsCmd, preFixLockHashCmd,
  preFixNodeModulesPresentCmd, preFixRestoreRmLine, preFixSaveTarLine,
  preFixBunInstallRunningCmdRound4, preFixParseCacheDirs, fakeDfDir
  (defined INSIDE the round-5 suite at old :1138, moves with it — it stays
  parse-side), all 9 suite blocks from old :183 to :1132-1260.
  DISK half keeps: suite, findSuite is NOT needed on disk side (verify: if
  the disk half's blocks all use `suite`/`unshareSuite` aliases, drop the
  unused findSuite/procSuite/hasGnuFind/hasProcFs definitions there, and
  the hasGnuFind comment block above them — but ONLY if truly unused; the
  disk blocks are :1295 suite, :1879-1896 unshareSuite; grep each alias
  in your disk half before deciding), base+hooks, sh(), buildPayload,
  seedCheckout, runRestore, fakeNoopRmDir, preFixFullTarIntermediateCmd,
  findWorkDirs, cleanupWorkDirs, the round-6 suite (:1295), the big banner
  comment :1262-1293, the round-7 pre-banner comment block and
  canUnshareMount/unshareSuite (:1835-1895), buildCompressiblePayload,
  runInFullTmpfs, preFixRound6FileBasedCaptureCmd,
  preFixMainListingStillFileCmd, buildManyFilesPayload, the unshare suite.
  Imports per half: trim to what that half's code actually references
  (tsc will confirm; unused imports are a Standards finding).

## Sibling comment pointers

Old filename appears in comments in 4 sibling test files; update each to
the right new name (comment-only edits):
- test/install-cache.test.ts lines ~17, ~30, ~379, ~436, ~473, ~526: the
  restore/atomicity/df/traversal proofs → parse file name; but line ~526
  and any mention of streamed/ENOSPC/dl-tar materialization → disk file.
  Read each comment, pick the half it points at.
- test/bun/install-marker-gate.test.ts line ~13: mentions the injection
  proofs → parse.
- test/bun/deploy-rescue-gate.test.ts line ~12: mentions injection class
  of bug → parse.
- test/bun/require-tool.test.ts line ~146: zstd mention → parse (the
  lane guard with hasZstd lives there).
Do NOT touch docs/ archives (sweep docs, old plans) — they are historical
records.

## Verification (one heavy gate at a time)

1. `bun test test/bun/install-cache-security-parse.test.ts test/bun/install-cache-security-disk.test.ts` — expect 60 pass 0 fail (44 + 17 test() statements register as 60 run: the 17th disk-side statement is the unshare CI-fallback test() which registers only when the probe fails under CI=true; locally 43+17=60 pass). Baseline before any change was 60 pass 0 fail in 41.82s.
2. `bun run check` (5x tsc) — must be exit 0, run ALONE, nothing else in parallel.
3. `bun run english-check` and `bun run test-lies-check` — exit 0.
4. `grep -cE '^\s*(test|it)\(' <newfile>` — parse half must be 44, disk half 17, and confirm no `test(`/`it(` was lost vs the old file's 61 (61st is the CI-fallback inside canUnshareMount).

## Git discipline

1. First commit: the plan doc, message `docs(fleet): S26-F12 plan — install-cache-security split parse vs disk (refs #699)`. Push immediately: `LEFTHOOK=0 git push -u origin fix-699-install-cache-security-split`. This is a RED-equivalent checkpoint.
2. Second commit: the split itself (two new files, old file deleted via `git rm`, 4 sibling comment edits), message `test(fleet): S26-F12 split install-cache-security.test.ts — parse vs disk (refs #699)`. Push right after.
3. Never run more than 15 min of unpushed work. Never commit to main. Never write /workspace/.fleet/done/699.json — that is the lead's step.

## Report back (final output, to lead)

- Commits pushed (sha + subject), verify with `git log origin/main..HEAD --oneline`.
- Test results verbatim tail (pass/fail counts, duration) for step 1.
- bun run check / english-check / test-lies-check exit codes.
- Test-statement counts: old file 61, parse 44, disk 17.
- Which aliases each half ended up keeping (findSuite/procSuite present or dropped on disk side).
- List of sibling comment edits made (file:line, old → new).
- Anything you deviated from in this brief and why.
