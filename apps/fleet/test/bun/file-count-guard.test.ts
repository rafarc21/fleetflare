import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #341, part 3: a file-count regression guard for the bun-test lane.
 *
 * The hazard: a test file can pass only because an alphabetically earlier
 * file in the same run already mocked a dependency (order dependence), or a
 * file can be silently dropped from a directory-shaped run (unloadable,
 * misnamed, filtered out) — either way the suite proves nothing about that
 * file, and nothing red ever appears. bun's own footer — `Ran N tests
 * across M files.` — is the cheap, honest signal: M counts every .test.ts
 * file bun LOADED in the run, so a dropped file moves M immediately.
 *
 * This guard pins two things:
 *
 * 1. The MECHANISM (second test): in a throwaway dir, two tiny .test.ts files
 *    produce `across 2 files`; renaming one out of the .test.ts pattern
 *    drops it from the run and the footer says `across 1 file`. That is the
 *    mutation proof — the exact dropping this guard exists to catch.
 * 2. The LANE (first test): CI's bun-test lane is
 *    `bun test test/bun test/studio.files.test.ts test/studio.studio-blueprint.test.ts`
 *    (package.json's "bun-test" script). The full lane takes ~16 min, far
 *    too heavy to spawn from inside a test that runs IN that lane. Instead
 *    the guard runs the same invocation with `-t "issue-341-never-matches"`
 *    — a pattern no test name matches, so bun loads and registers every
 *    in-scope file (the footer proves it: all files counted) but executes
 *    zero tests, keeping the spawn at well under a second (measured
 *    ~0.4 s). The footer's M must equal the number of .test.ts files git
 *    lists on disk for that same scope — a file silently scoped OUT of the
 *    run (renamed, misnamed, lane scope edited in package.json without the
 *    matching on-disk change) makes those two numbers diverge. (An
 *    unloadable file still counts in M — but it fails the lane loudly on
 *    its own, `# Unhandled error between tests`, so that class is covered
 *    by the lane's exit code, not this count.)
 *
 * The `Searched N files` early-exit line is parsed too: when every test in
 * scope is filterable (none skipped at registration time) bun exits early
 * with `error: regex ... matched 0 tests. Searched N files (skipping N
 * tests)` instead of a standard footer — N there is the same file count.
 */
// The lane spawn loads every in-scope file's module graph under whatever
// load the host carries; the mechanism pin is a handful of small spawns.
// bun's 5 s default is plenty today but thin under load — same budget as
// the localci-run tests that spawn similar subprocess trees.
setDefaultTimeout(60_000);

/** Run `bun test <args>` with cwd `dir` and return the number of files its
 * footer says were loaded. Asserts a count line was found at all — a run
 * that prints neither shape is itself a failure, never a skip. */
function footerFiles(dir: string, args: string[] = []): number {
  const env = { ...process.env };
  // The bun-test lane runs with TMUX/TMUX_PANE unset (localci.sh, its
  // `env -u TMUX -u TMUX_PANE`); some in-scope files refuse to load with
  // $TMUX set, which would make the footer's M an artifact of the
  // caller's environment rather than of the file set.
  delete env.TMUX;
  delete env.TMUX_PANE;
  const p = Bun.spawnSync([process.execPath, "test", ...args], { cwd: dir, env });
  const out = p.stdout.toString() + p.stderr.toString();
  const footer = out.match(/Ran \d+ tests? across (\d+) files?\./);
  const earlyExit = out.match(/matched 0 tests\. Searched (\d+) files?/);
  const m = footer?.[1] ?? earlyExit?.[1];
  if (m === undefined) {
    throw new Error(`no bun footer line in output:\n${out}`);
  }
  return Number(m);
}

/** The two .test.ts fixtures the mechanism pin drops and counts. */
const TINY = 'import { test, expect } from "bun:test";\ntest("x", () => { expect(1).toBe(1); });\n';

describe("file-count guard (issue #341)", () => {
  // Both tests spawn the same real bun binary (process.execPath), so a
  // runner swap (the guard's own point — what runs must match what exists
  // on disk) cannot silently change what is counted.

  test("the bun-test lane's footer counts every on-disk .test.ts file in its scope (issue #341)", () => {
    // The lane, exactly as CI runs it, minus test execution: the -t pattern
    // matches no test name in the repo, so bun still LOADS every in-scope
    // file (that is the point — a file that fails to load shows up here as
    // a counted error, never as a silent omission) but runs zero tests.
    // The pattern must also never match a name THIS file carries, or the
    // inner run would recurse into running this guard inside itself.
    const loaded = footerFiles(resolve(import.meta.dir, "../.."), [
      "test/bun",
      "test/studio.files.test.ts",
      "test/studio.studio-blueprint.test.ts",
      "-t",
      "issue-341-never-matches",
    ]);

    // The same scope, enumerated from git instead: every .test.ts on disk
    // under test/bun plus the two studio files the lane names explicitly.
    // `--cached --others --exclude-standard` lists tracked AND untracked-
    // not-ignored files — bun loads whatever is on disk, not what is
    // tracked, so a just-created not-yet-added test file counts on both
    // sides (this guard file itself was one while being written). In CI's
    // clean checkout tracked == on-disk, so the flag set changes nothing
    // there. import.meta.dir is apps/fleet/test/bun — four levels up is
    // the repo root git lists paths against (two is apps/fleet, the
    // lane's cwd).
    const root = resolve(import.meta.dir, "../../../..");
    const ls = Bun.spawnSync(
      ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root },
    );
    if (ls.exitCode !== 0) throw new Error(`git ls-files failed: ${ls.stderr.toString()}`);
    const onDisk = ls.stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      .filter((p) => p.startsWith("apps/fleet/test/bun/") && p.endsWith(".test.ts"))
      .concat(["apps/fleet/test/studio.files.test.ts", "apps/fleet/test/studio.studio-blueprint.test.ts"]);

    // A file deleted from disk but still in the index desyncs bun's view
    // from git's — catch that before the count compares.
    const missing = onDisk.filter((p) => !existsSync(join(root, p)));
    expect(missing).toEqual([]);

    // The pin: what the lane LOADS must equal what EXISTS. A file silently
    // renamed, or scoped out of the run while still on disk (or vice versa),
    // makes these two numbers diverge — issue #341's hazard: the suite runs
    // green while no longer covering a file everyone assumes is covered.
    expect(loaded).toBe(onDisk.length);
    // Sanity floor: the guard is about the LANE, so a scope that has
    // shrunk to a handful of files would mean the lane itself changed
    // shape (132 files at the time of writing, this guard included) —
    // update this pin and package.json together, never silently.
    expect(onDisk.length).toBeGreaterThan(100);
  });

  test("bun's footer counts a dropped file (mechanism pin)", () => {
    // GREEN first: two loadable .test.ts files → footer counts 2.
    const dir = mkdtempSync(join(tmpdir(), "341-footer-pin-"));
    try {
      writeFileSync(join(dir, "a.test.ts"), TINY);
      writeFileSync(join(dir, "b.test.ts"), TINY);
      // No -t filter here: both tests actually run (milliseconds), so the
      // pin is the footer's real shape, not the early-exit line.
      expect(footerFiles(dir)).toBe(2);

      // RED mechanism proof: drop one file out of the .test.ts pattern —
      // the exact silent-drop this guard exists to catch — and the footer
      // must count one fewer. If bun ever stopped counting loaded files
      // honestly, this is where it shows.
      renameSync(join(dir, "b.test.ts"), join(dir, "b.ts"));
      expect(footerFiles(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
