import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";

/** True when `p` exists and is a directory — NOT existsSync(p, { isDirectory:
 * true }): this Bun build (1.3.12) answers that overload true for plain
 * files (only a missing path gets false), so it cannot tell a file arg from
 * a directory arg here. statSync can, and is already needed for the
 * existsSync leg below. */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

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
 * 2. The LANE (first test): the lane is whatever package.json's "bun-test"
 *    script says it is — the guard derives its spawn argv from that script
 *    (LANE_ARGS below), so it always mirrors the lane as DEFINED and
 *    follows a lane edit automatically instead of needing a paired manual
 *    update of a duplicated constant here. The full lane takes ~16 min, far
 *    too heavy to spawn from inside a test that runs IN that lane. Instead
 *    the guard runs the same invocation with `-t "issue-341-never-matches"`
 *    — a pattern no test name matches, so bun loads and registers every
 *    in-scope file (the footer proves it: all files counted) but executes
 *    zero tests, keeping the spawn at well under a second (measured
 *    ~0.4 s). The footer's M must equal the number of .test.ts files git
 *    lists on disk for that SAME argv-derived scope — the pin that catches
 *    a file silently dropped RELATIVE TO THE LANE: renamed out of the
 *    .test.ts pattern while still on disk, misnamed so the directory glob
 *    misses it, or present-but-untracked-but-listed and deleted since.
 *    Because both sides derive from the same argv, a lane-scope EDIT in
 *    package.json moves them together and stays green — that is honest:
 *    the lane genuinely no longer runs that file, a CI coverage decision
 *    that is visible in the package.json diff for human review, not a
 *    silent drop. What the pin (plus the >100 sanity floor below) owns is
 *    the lane-scope QUESTION: nothing can diverge footer-M from disk for
 *    the scope as defined without turning this guard red. (An unloadable
 *    file still counts in M — but it fails the lane loudly on its own,
 *    `# Unhandled error between tests`, so that class is covered by the
 *    lane's exit code, not this count.)
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

/** The bun-test lane's file/dir arguments, derived from package.json's own
 * "bun-test" script so this guard and the lane can never drift apart: one
 * source of truth. `bun test` is the runner prefix; what follows is the
 * scope. Sanity-pinned: at least two args (the dir plus one named file —
 * today exactly three: test/bun and the two studio files the vitest
 * exclude names), and every arg must exist on disk under apps/fleet, or
 * the script itself has drifted from the repo and the guard must not
 * silently invent a scope. */
const LANE_ARGS: string[] = (() => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"));
  const script = pkg?.scripts?.["bun-test"];
  if (typeof script !== "string") throw new Error("package.json has no bun-test script");
  const args = script
    .replace(/^bun test /, "")
    .split(/\s+/)
    .filter(Boolean);
  expect(args.length).toBeGreaterThanOrEqual(2);
  for (const arg of args) {
    if (!existsSync(join(import.meta.dir, "../..", arg))) {
      throw new Error(`bun-test lane arg not on disk under apps/fleet: ${arg}`);
    }
  }
  return args;
})();

/** Run `bun test <args>` with cwd `dir` and return the number of files its
 * footer says were loaded. Asserts a count line was found at all — a run
 * that prints neither shape is itself a failure, never a skip. */
function footerFiles(dir: string, args: string[] = []): number {
  const env = { ...process.env };
  // The bun-test lane runs with TMUX/TMUX_PANE unset (localci.sh, its
  // `env -u TMUX -u TMUX_PANE`) — CI's shape, not this host's. The guard's
  // spawn must mirror that or it counts a different run than CI does:
  // several in-scope files branch on $TMUX (describe.skip gates that
  // register nothing, constructors that throw), so a TMUX-carrying host
  // environment would load and register a different set of tests than the
  // lane ever sees, and footer M would be an artifact of the caller's
  // environment rather than of the file set.
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
    // The lane, exactly as package.json defines it, minus test execution:
    // the -t pattern matches no test name in the repo, so bun still LOADS
    // every in-scope file (that is the point — a file that fails to load
    // shows up here as a counted error, never as a silent omission) but
    // runs zero tests. The pattern must also never match a name THIS file
    // carries, or the inner run would recurse into running this guard
    // inside itself.
    const loaded = footerFiles(resolve(import.meta.dir, "../.."), [
      ...LANE_ARGS,
      "-t",
      "issue-341-never-matches",
    ]);

    // The same scope, enumerated from git instead — derived from the SAME
    // LANE_ARGS (one source of truth: the guard mirrors the lane as
    // package.json defines it). A directory arg contributes every
    // git-listed .test.ts under it; a file arg contributes itself.
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
    const gitList = ls.stdout.toString().split("\0").filter(Boolean);
    const onDisk: string[] = [];
    for (const arg of LANE_ARGS) {
      const repoRel = "apps/fleet/" + arg;
      const abs = join(import.meta.dir, "../..", arg);
      if (existsSync(abs) && !isDir(abs)) {
        // A file arg: it must be git-listed too, or the lane names
        // something git does not see (untracked in CI's checkout would
        // mean it does not exist there at all).
        if (!gitList.includes(repoRel)) {
          throw new Error(`bun-test lane arg ${arg} is not in git ls-files output`);
        }
        onDisk.push(repoRel);
        continue;
      }
      // A directory arg: every git-listed .test.ts under it.
      const prefix = repoRel.endsWith("/") ? repoRel : repoRel + "/";
      for (const p of gitList) {
        if (p.startsWith(prefix) && p.endsWith(".test.ts")) onDisk.push(p);
      }
    }

    // A file deleted from disk but still in the index desyncs bun's view
    // from git's — catch that before the count compares.
    const missing = onDisk.filter((p) => !existsSync(join(root, p)));
    expect(missing).toEqual([]);

    // The pin: what the lane LOADS must equal what EXISTS for the scope as
    // package.json defines it. A file silently renamed, misnamed, or
    // deleted-from-disk-but-still-listed makes these two numbers diverge —
    // issue #341's hazard: the suite runs green while no longer covering a
    // file everyone assumes is covered.
    expect(loaded).toBe(onDisk.length);
    // Sanity floor: guards against the whole scope being gutted — a lane
    // shrunken to a handful of files (132 today, this guard included) is a
    // change the package.json diff shows, but the count floor makes even
    // a fully-consistent gut visible here instead of passing silently.
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
