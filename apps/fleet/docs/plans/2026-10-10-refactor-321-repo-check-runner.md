# Deepen repo check scripts behind one `repo-check.ts` runner (board issue #321)

Ref #259. Implements finding F6 of
`docs/maintainability/2026-10-10-deep-modules-sweep-2.md` (§3): the same
4-step dance (list → read → scan → report + exit) exists twice, in
`scripts/english-check.ts` and `scripts/test-lies-check.ts`, and the two
copies have drifted (stderr vs stdout findings, escape applied inside the
detector vs after, a second `git ls-files` run only to count files).
Tier: GLM-OK, behavior-preserving. Detectors stay deep; both mains become
~5 lines behind one shared runner.

## Goal

One new module `apps/fleet/scripts/repo-check.ts` exports
`runRepoCheck(opts)`, hiding the whole dance: `git ls-files -z`, allowlist
filtering, file read (text vs binary skip), per-file scan, finding
collection, stream routing (stderr vs stdout), summary line, and exit code.
Both existing scripts keep their exact CLI bytes: same messages, same
streams, same exit codes, and every caller (CI workflows, localci lanes,
bun-test lanes) runs them unchanged.

## Behavior-preserving contract (byte-identical, per script)

- english-check: findings + failure summary to **stderr**, `english-check:
  clean` to stdout on success; exit 1 iff any finding.
- test-lies-check: findings + count summary to **stdout**; exit 1 iff any
  finding; summary counts by kind and total test-file count.
- Both scripts keep their own ALLOWLIST, escape syntax
  (`english-check: allow` / `test-lies-check: allow`), and where the
  escape is applied (english-check inside `findPortuguese`;
  test-lies-check after all detectors in `scanFile`). The runner must not
  move or unify the escape point — only the list/read/report/exit dance is
  shared.
- english-check skips binary files (NUL byte check) and EXCLUDED_PREFIXES;
  test-lies-check selects `*.test.ts(x)` only. Runner takes a `select`
  predicate so each script keeps its own file universe.

## Interface (the new seam)

```ts
// scripts/repo-check.ts
export interface RepoCheckOpts<F> {
  root: string;                                    // repo root; git runs here
  select: (path: string) => boolean;               // file universe per script
  scanFile: (path: string, text: string) => F[];   // per-file hits
  allowlist: Record<string, string>;                // whole-file exemptions
  format: (path: string, hit: F) => string;        // one finding's line
  stream: "stdout" | "stderr";                     // findings + failSummary stream
  failSummary: (findings: Array<F & { path: string }>) => string; // printed to stream when findings exist
  cleanLine: (fileCount: number | string | undefined) => string;  // printed to stdout when none
  cleanExit: number;                               // exit code with no findings
  fileCount?: (listed: string[]) => number | string; // test-lies-check's "across N test files"
}
export async function runRepoCheck<F>(opts: RepoCheckOpts<F>): Promise<number>;
```

`runRepoCheck` runs `git ls-files -z` once (drops the second
listTestFiles call test-lies-check's main used for counting), reads each
selected non-allowlisted file, skips binaries (NUL byte) for text-decoding
safety in both scripts, calls `scanFile`, prints each
`format(path, hit)` to `opts.stream`; on findings it also prints
`failSummary(findings)` to `opts.stream` and returns 1, with zero
findings it prints `cleanLine(fileCount)` to stdout (always stdout —
both scripts' clean/summary output is stdout; english-check's findings
are stderr but its clean line is stdout; test-lies-check's count line
prints on both paths, so it supplies it as both `cleanLine` and
`failSummary`) and returns `opts.cleanExit`. The `import.meta.main`
block of each script becomes:

```ts
process.exit(await runRepoCheck({ ...scriptOpts }));
```

Both scripts keep `REPO_ROOT`, their `ALLOWLIST`, detectors, and
`scanFile`/`formatFinding` exports — the tests import them today and the
runner only replaces `scanRepo` + main.

## Plan

Characterization first: pin today's CLI bytes on a synthetic repo so any
drift in stream, message, or exit code fails a test before the refactor
moves a line. Then extract the runner, migrate both mains, prove the pins
still pass, then delete the duplicated dance.

### Task 1 — characterization tests (RED)

New file `apps/fleet/test/bun/repo-check-runner.test.ts`, bun:test, same
Fixture style as `test/bun/test-lies-check.test.ts` (mkdtempSync root,
`git init -q` + `git add -A`, write files, run script copy with
`Bun.spawnSync([process.execPath, scriptPath])`, assert on
stdout/stderr/exitCode):

- english-check pin, clean temp repo → exit 0, stdout ends
  `english-check: clean`, stderr empty.
- english-check pin, one tracked file with a marker line → exit 1, stderr
  contains `path:line: "marker" — text` exactly as `formatFinding` shapes
  it, stdout empty.
- english-check pin, escaped line (`// english-check: allow`) → exit 0.
- english-check pin, binary file (NUL byte) tracked → not flagged, exit 0.
- test-lies-check pin, clean temp repo → exit 0, stdout contains
  `0 tautological, 0 source-reading, 0 own-module-mock`.
- test-lies-check pin, one tautological test file → exit 1, stdout
  contains the `[tautological]` finding line AND the count line
  `1 tautological, 0 source-reading, 0 own-module-mock across N test
  files`, stderr empty.
- test-lies-check pin, escaped line (`// test-lies-check: allow`) → exit 0.

Run: `bun test test/bun/repo-check-runner.test.ts` — must FAIL (runner not
written yet; english-check pins pass already, so RED = the test-lies
count/exit pins against the not-yet-migrated main… to keep RED honest,
write these pins, run, and record which fail; the english-check pins
passing at RED is expected — they pin current behavior). Commit:
`test(repo-check): characterization pins for both check CLIs (refs #321)`.

### Task 2 — runner module (GREEN part 1)

Create `apps/fleet/scripts/repo-check.ts` per the interface above. No
main block (it is a library, not a CLI). Keep it small: the dance only.
Commit: `refactor(repo-check): shared runRepoCheck runner (refs #321)`.

### Task 3 — migrate english-check.ts

- `scanRepo` becomes a thin call: keep the export (tests import it) but
  route through the runner's listing, or keep `scanRepo` as-is and use the
  runner only in `import.meta.main` — choose the smaller diff; the main
  block shrinks to one `runRepoCheck` call with
  `stream: "stderr"` and the existing message strings.
- Byte-identical outputs required: the pins from Task 1 plus
  `bun run english-check` on the real repo print `english-check: clean`.
Commit: `refactor(english-check): main behind runRepoCheck (refs #321)`.

### Task 4 — migrate test-lies-check.ts

- `import.meta.main` routes through the runner with
  `stream: "stdout"`, its count summary, and `fileCount` supplied so the
  second `git ls-files` disappears (count derived from the runner's own
  listed file set — same number, one spawn).
- `scanRepo` export stays (tests import it).
- Pins + real-repo run: `bun run test-lies-check` prints
  `0 tautological, 0 source-reading, 0 own-module-mock across N test
  files` and exits 0. N must equal the pre-refactor N (record it before
  migrating).
Commit: `refactor(test-lies-check): main behind runRepoCheck (refs #321)`.

### Task 5 — suite + drift sweep

- `bun test test/bun/repo-check-runner.test.ts test/bun/english-only.test.ts test/bun/test-lies-check.test.ts` green.
- `bun run english-check && bun run test-lies-check` against the real repo:
  same bytes as recorded before the refactor.
- No other file changed; no export removed that a test or lane imports.
Commit (if anything drifted): `test(repo-check): pin post-refactor drift (refs #321)`.

## Boundaries

- Only `apps/fleet/scripts/repo-check.ts` (new),
  `apps/fleet/scripts/english-check.ts`,
  `apps/fleet/scripts/test-lies-check.ts`, and
  `apps/fleet/test/bun/repo-check-runner.test.ts` (new) are in scope.
- No change to `.github/workflows/*`, `scripts/localci/localci.sh`, or any
  package.json script — callers run both CLIs unchanged.
- The escape application point does NOT move (inside `findPortuguese` /
  after detectors in `scanFile`), and no detector logic is touched.
- Heavy gates: none beyond targeted bun-test files. Never run the full
  `bun run test` (vitest) alongside builds; targeted tests only.
- English only, conventional commits, fleet-studio identity.

## Verification (for the completion record)

- `bun test test/bun/repo-check-runner.test.ts` exit 0
- `bun run english-check` exit 0, `english-check: clean`
- `bun run test-lies-check` exit 0, `0 tautological, 0 source-reading, 0 own-module-mock`
- `bun run check` (tsc) exit 0
