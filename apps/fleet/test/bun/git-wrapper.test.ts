import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  studioGitSafetyCmd, studioGitWrapperScript,
  STUDIO_PUSH_REFUSAL, STUDIO_PUSH_UNRESOLVED_DEFAULT,
  STUDIO_PUSH_PROBE_FAILED, STUDIO_PUSH_SHELL_ALIAS_REFUSAL,
  STUDIO_PUSH_PLUMBING_REFUSAL, STUDIO_PUSH_ALIAS_DEPTH_REFUSAL, STUDIO_PUSH_LEAK_REFUSAL,
  STUDIO_PUSH_SUBMODULE_REFUSAL,
} from "../../src/studio/credentials";
import { denylistFileContent, leakScanScript, type LeakGateFile } from "../../src/leak-gate";
import { withKillDeadline } from "../../src/studio/exec-deadline";
import {
  rescuePushCmd, rescueSnapshotCmd, RESCUE_PUSHED_PREFIX, RESCUE_PUSHED_KIND_FILES, RESCUE_PUSHED_KIND_COMMITS,
} from "../../src/studio/rescue";

/**
 * Board issue #253 — the FUNCTIONAL proof that the `/usr/local/bin/git`
 * wrapper `studioGitWrapperScript()` generates, actually installed by the
 * exact command `studioGitSafetyCmd()` returns and actually run by a real
 * git, refuses every push it must refuse and allows every push it must
 * allow. The pure STRING assertions (the shell text contains the right
 * logic) live in test/studio.credentials.test.ts instead — a Worker-safe
 * vitest suite with no real git, per this repo's own split (see
 * blueprint-credential.test.ts's header for the identical reasoning:
 * "asking git" needs a real git binary, unavailable under
 * vitest-pool-workers).
 *
 * NOTHING HERE TOUCHES THE RUNNER'S OWN GIT. Every fixture is a fresh temp
 * directory: its own bare origin, its own clone, its own HOME with its own
 * GIT_CONFIG_GLOBAL, and — the part that matters — its own `bin/` that the
 * wrapper is installed into and that goes FIRST on that subprocess's PATH.
 * The real `/usr/local/bin/git` of the machine running this file is never
 * written, read as a target, or referenced. `studioGitSafetyCmd`'s two path
 * seams (`wrapperPath`, `realGit`) exist for exactly this, and they are the
 * ONLY difference between the string tested here and the string the Worker
 * ships.
 *
 * Skipped, never thrown, when $TMUX is set — that is, when the runner itself
 * lives in a tmux pane, which a studio lead always does. Same guard shape
 * bringup-claude-relaunch.test.ts uses for its own real-process lane, for
 * the same reason: a real-git suite has no business running inside the very
 * kind of container this task exists to protect. Also needs a real git on
 * PATH and `timeout` (withKillDeadline's own dependency, hardcoded there —
 * out of this file's control) reachable by that exact name.
 *
 * Issue #310: a bare `Bun.which("timeout")` is null on a Mac host with no GNU
 * coreutils (BSD ships no binary by that name), which used to make this
 * whole ~89-test lane silently become `describe.skip` — no signal to anyone
 * that real-git coverage did not run. `gtimeout`, what `brew install
 * coreutils` installs on Mac, is checked too, and threaded onto every
 * fixture's PATH under the name `timeout` itself (TIMEOUT_SHIM below) so
 * withKillDeadline's hardcoded string still resolves. If NEITHER binary is on
 * PATH and a real git is, the lane runs anyway with one test that always
 * fails, loudly naming the gap — never a quiet skip.
 *
 * Issue #353 round 2: `Bun.which("git")` with NO options reads a `PATH`
 * bun's native implementation appears to snapshot once at process startup
 * rather than the live `process.env.PATH` (measured: mutating
 * `process.env.PATH` after startup, then calling the no-args form, still
 * returns the pre-mutation answer; passing `{ PATH: process.env.PATH }`
 * explicitly does not). `../../bunfig.toml`'s `[test]` preload
 * (real-git-preload.ts) runs before this file is even parsed and PREPENDS a
 * shim directory holding genuine real git to `process.env.PATH` whenever
 * `/usr/local/bin/git` on this machine is the fleet #253 wrapper — inside a
 * real studio, exactly the case, since the wrapper sits ahead of
 * `/usr/bin/git` on PATH by design. The explicit `PATH:` option here is what
 * actually makes REAL_GIT see that prepended shim rather than the stale,
 * cached, pre-preload answer (which inside a studio is the wrapper itself,
 * not real git at all). `process.env.PATH` is the ONE place the resolved
 * "real git" location lives for this whole test run: the preload's own PATH
 * mutation IS the source of truth, read here rather than re-derived.
 */
const REAL_GIT = Bun.which("git", { PATH: process.env.PATH });
const TIMEOUT_BIN = Bun.which("timeout") ?? Bun.which("gtimeout");
const LANE = REAL_GIT !== null && TIMEOUT_BIN !== null && !process.env.TMUX ? describe : describe.skip;

/** A tiny PATH shim so withKillDeadline's hardcoded `timeout` invocation
 *  resolves even when only `gtimeout` was found: a directory holding one
 *  script literally named `timeout` that execs whichever binary
 *  `TIMEOUT_BIN` actually is. `null` when the real `timeout` was found
 *  directly (nothing to shim) or when neither exists (the loud-failure test
 *  below covers that case instead). */
const TIMEOUT_SHIM_DIR = ((): string | null => {
  if (TIMEOUT_BIN === null || basename(TIMEOUT_BIN) === "timeout") return null;
  const dir = mkdtempSync(join(tmpdir(), "fleet-timeout-shim-"));
  const shim = join(dir, "timeout");
  writeFileSync(shim, `#!/bin/sh\nexec '${TIMEOUT_BIN}' "$@"\n`);
  chmodSync(shim, 0o755);
  return dir;
})();

// A real git present but no `timeout`/`gtimeout` anywhere: the lane SHOULD
// run (a real git is the other half of its guard) but every test in it would
// fail confusingly deep inside withKillDeadline's shelled-out command instead
// of at one obvious spot. Fail loud, right here, instead.
if (REAL_GIT !== null && TIMEOUT_BIN === null && !process.env.TMUX) {
  describe("the fleet git wrapper's real-git lane needs GNU coreutils (issue #310)", () => {
    test("no `timeout` or `gtimeout` on PATH — the ~89-test real-git lane below did not run", () => {
      throw new Error(
        "install GNU coreutils (`brew install coreutils` on Mac) to run this lane — " +
        "neither `timeout` nor `gtimeout` is on PATH",
      );
    });
  });
}

interface Fixture {
  /** The temp root every other path in the fixture lives under. */
  root: string;
  /** PATH-shadow dir: first on the subprocess PATH, holds the wrapper. */
  bin: string;
  /** The installed wrapper, i.e. this fixture's stand-in for /usr/local/bin/git. */
  wrapper: string;
  /** The bare "remote". */
  origin: string;
  /** The studio's checkout, at <root>/ws/<REPO> so rescuePushCmd fits it. */
  clone: string;
  /** The remote's default branch name for this fixture. */
  def: string;
  /** Issue #1: the leak scanner the wrapper calls, and its gate file. */
  scan: string;
  gate: string;
  env: Record<string, string>;
}

const REPO = "fleetflare";
const STUDIO = "fleetflare--pilot";

let fx: Fixture | null = null;
afterEach(() => {
  if (fx) rmSync(fx.root, { recursive: true, force: true });
  fx = null;
});

interface Run { code: number; stdout: string; stderr: string }

function run(cmd: string[], cwd: string, env: Record<string, string>): Run {
  const r = Bun.spawnSync({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** A fixture step, run with the REAL git so building the fixture is never
 *  itself subject to the guard under test. Throws on failure: a silently
 *  failed setup step is how a green test ends up proving nothing. */
function realGit(f: Fixture, args: string[], cwd = f.clone): Run {
  const r = run([REAL_GIT as string, ...args], cwd, f.env);
  if (r.code !== 0) throw new Error(`fixture step \`git ${args.join(" ")}\` failed (${r.code}): ${r.stderr}`);
  return r;
}

/** The subject: git, as a studio invokes it — through the wrapper. */
function git(f: Fixture, args: string[], cwd = f.clone): Run {
  return run([f.wrapper, ...args], cwd, f.env);
}

/** A shell line, with the fixture's PATH — so a bare `git` word inside it
 *  resolves to the wrapper exactly as it does in a studio's own shell. */
function bash(f: Fixture, script: string, cwd = f.clone): Run {
  return run(["bash", "-c", script], cwd, f.env);
}

/** Every ref on the "remote", so a refusal can be proven to have pushed
 *  NOTHING rather than merely printed something. */
function originRefs(f: Fixture): string[] {
  return realGit(f, ["for-each-ref", "--format=%(refname)"], f.origin)
    .stdout.split("\n").filter(Boolean);
}

/** Every ref on the "remote" WITH the commit it points at. `originRefs` alone
 *  cannot see a push that FAST-FORWARDS an existing branch — the ref list is
 *  identical before and after — which is exactly the shape of a push at the
 *  default branch. Every "nothing moved" assertion uses this one. */
function originState(f: Fixture): string[] {
  return realGit(f, ["for-each-ref", "--format=%(refname) %(objectname)"], f.origin)
    .stdout.split("\n").filter(Boolean);
}

/**
 * Installs the wrapper through the EXACT production path: the command string
 * `studioGitSafetyCmd()` returns, wrapped by `withKillDeadline` and handed to
 * `bash -c`, which is precisely what `sbExec` does with it (sandbox-api.ts).
 * Only the two path seams differ from production. The install's own last link
 * — `hash -r && [ "$(command -v git)" = <wrapper> ]` — is what makes this
 * throw if the PATH shadowing ever stopped working, so no test below can pass
 * against a wrapper that was not actually reached.
 */
function installWrapper(f: Fixture): void {
  const cmd = studioGitSafetyCmd({ wrapperPath: f.wrapper, realGit: REAL_GIT as string, scanPath: f.scan });
  const r = run(["bash", "-c", withKillDeadline(cmd, 30_000)], f.clone, f.env);
  if (r.code !== 0) throw new Error(`wrapper install failed (${r.code}): ${r.stderr}${r.stdout}`);
}

/** Issue #1: (re)writes the fixture's leak gate file. The default pattern
 *  matches nothing any fixture writes, so every pre-#1 test pushes clean. */
function writeGate(f: Fixture, gate: LeakGateFile = { patterns: ["fleet-harmless-999999999"] }): void {
  writeFileSync(f.gate, denylistFileContent(gate));
}

/** A bare origin whose default branch is `def`, one seeded commit on it, a
 *  clone of it at <root>/ws/<REPO>, and the wrapper installed into <root>/bin.
 *  `install: false` builds everything EXCEPT the wrapper, for the tests that
 *  are about the install command itself rather than about the guard. */
function setup(def = "trunk", install = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), "fleet-git-wrapper-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const ws = join(root, "ws");
  const seed = join(root, "seed");
  for (const d of [home, bin, ws, seed]) mkdirSync(d, { recursive: true });

  const f: Fixture = {
    root, bin, wrapper: join(bin, "git"),
    origin: join(root, "origin.git"), clone: join(ws, REPO), def,
    scan: join(root, "fleet-leak-scan"), gate: join(root, "denylist"),
    env: {
      ...process.env as Record<string, string>,
      HOME: home,
      // TIMEOUT_SHIM_DIR goes between `bin` and the inherited PATH: `bin`'s
      // own `git` must stay first, but a `gtimeout`-only host still needs
      // withKillDeadline's hardcoded `timeout` to resolve to SOMETHING.
      PATH: `${bin}:${TIMEOUT_SHIM_DIR ? `${TIMEOUT_SHIM_DIR}:` : ""}${process.env.PATH ?? ""}`,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "fleet-test", GIT_AUTHOR_EMAIL: "fleet-test@example.com",
      GIT_COMMITTER_NAME: "fleet-test", GIT_COMMITTER_EMAIL: "fleet-test@example.com",
    },
  };
  fx = f;
  writeFileSync(f.scan, leakScanScript(f.gate));
  chmodSync(f.scan, 0o755);
  writeGate(f);

  realGit(f, ["init", "-q", "--bare", "-b", def, f.origin], root);
  realGit(f, ["init", "-q", "-b", def, seed], root);
  writeFileSync(join(seed, "README.md"), "seed\n");
  realGit(f, ["add", "-A"], seed);
  realGit(f, ["commit", "-q", "-m", "seed"], seed);
  realGit(f, ["remote", "add", "origin", f.origin], seed);
  realGit(f, ["push", "-q", "origin", `${def}:refs/heads/${def}`], seed);
  realGit(f, ["clone", "-q", f.origin, f.clone], root);
  // What a real clone already does; set explicitly so no git version's own
  // choice about origin/HEAD can make this fixture lie.
  realGit(f, ["remote", "set-head", "origin", def]);
  if (install) installWrapper(f);
  return f;
}

/** A repo pre-push hook that appends to `marker` every time it runs, so a test
 *  can prove the guard's own probe fired NO hook (the marker must not exist)
 *  while a real, allowed push fires it exactly once. */
function markerHook(f: Fixture, marker: string): void {
  const hooks = join(f.clone, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\nprintf 'ran\\n' >> '${marker}'\nexit 0\n`);
  chmodSync(join(hooks, "pre-push"), 0o755);
}

/** One local commit on whatever is checked out, so a push has something to do. */
function commit(f: Fixture, name = "work.txt", cwd = f.clone): void {
  writeFileSync(join(cwd, name), `${name}\n`);
  realGit(f, ["add", "-A"], cwd);
  realGit(f, ["commit", "-q", "-m", `work: ${name}`], cwd);
}

function expectRefused(r: Run): void {
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain(STUDIO_PUSH_REFUSAL);
}

/** #321: a push the guard stopped on EITHER of its two refusal paths — the
 *  probe named the default branch, or the probe itself failed and the guard
 *  failed closed. Both exit non-zero and print a fleet line; callers still
 *  assert the remote did not move, which is the property that matters. Used
 *  only where git's own dry-run can die of SIGPIPE (dangling push options). */
function expectRefusedOrFailedClosed(r: Run): void {
  expect(r.code).not.toBe(0);
  expect(r.stderr.includes(STUDIO_PUSH_REFUSAL) || r.stderr.includes(STUDIO_PUSH_PROBE_FAILED)).toBe(true);
}

function expectAliasRefused(r: Run): void {
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain(STUDIO_PUSH_SHELL_ALIAS_REFUSAL);
}

LANE("the fleet git wrapper REFUSES a push at the default branch (issue #253)", () => {
  test("a bare `git push` from a local branch named for the default branch — the #253 incident shape", () => {
    const f = setup();
    commit(f);
    const before = originState(f);

    // The clone is already ON `trunk` (its default), tracking origin/trunk:
    // exactly the worktree state the incident happened in.
    expectRefused(git(f, ["push"]));
    expect(originState(f)).toEqual(before);
  });

  test("the same bare push from a WORKTREE checked out on the default branch", () => {
    const f = setup();
    const wt = join(f.root, "wt");
    // A second worktree cannot re-check-out `trunk`, so it gets its own
    // branch pointed at the same place and an upstream aimed at origin/trunk
    // — the "old worktree provisioned before this fix" case.
    realGit(f, ["worktree", "add", "-q", "-b", "wt-work", wt, f.def]);
    realGit(f, ["branch", "--set-upstream-to", `origin/${f.def}`, "wt-work"], wt);
    realGit(f, ["config", "push.default", "upstream"], wt);
    commit(f, "wt.txt", wt);

    expectRefused(git(f, ["push"], wt));
  });

  test.each([
    ["HEAD:<default>", (d: string) => ["push", "origin", `HEAD:${d}`]],
    ["HEAD:refs/heads/<default>", (d: string) => ["push", "origin", `HEAD:refs/heads/${d}`]],
    ["+HEAD:<default> (the force-with-plus spelling)", (d: string) => ["push", "origin", `+HEAD:${d}`]],
    ["--force", (d: string) => ["push", "--force", "origin", `HEAD:${d}`]],
    ["--force-with-lease", (d: string) => ["push", "--force-with-lease", "origin", `HEAD:${d}`]],
    ["--all (the default branch is one of the local branches)", () => ["push", "--all", "origin"]],
    ["--mirror", () => ["push", "--mirror", "origin"]],
    ["--delete <default>", (d: string) => ["push", "origin", "--delete", d]],
    [":<default> (delete by empty source)", (d: string) => ["push", "origin", `:${d}`]],
    ["-q", (d: string) => ["push", "-q", "origin", `HEAD:${d}`]],
    ["--quiet", (d: string) => ["push", "--quiet", "origin", `HEAD:${d}`]],
    ["--no-verify (the guard is not a hook, so there is no hook to skip)", (d: string) =>
      ["push", "--no-verify", "origin", `HEAD:${d}`]],
    ["-c core.hooksPath=/dev/null", (d: string) =>
      ["-c", "core.hooksPath=/dev/null", "push", "origin", `HEAD:${d}`]],
    ["--porcelain (the user's own, not only the guard's)", (d: string) =>
      ["push", "--porcelain", "origin", `HEAD:${d}`]],
  ])("%s", (_label, argv) => {
    const f = setup();
    commit(f);
    const before = originState(f);

    expectRefused(git(f, argv(f.def)));
    expect(originState(f)).toEqual(before);
  });

  test("a push by URL instead of a remote name", () => {
    const f = setup();
    commit(f);

    expectRefused(git(f, ["push", f.origin, `HEAD:${f.def}`]));
  });

  test("a push to a SECOND remote, at that remote's own same-named default branch", () => {
    const f = setup();
    const fork = join(f.root, "fork.git");
    // Cloned FROM origin rather than initialized empty: issue #310 (X2)
    // resolves the default branch from the push's own TARGET remote, which
    // needs that remote to have something to advertise -- "ls-remote
    // --symref" reports nothing at all for a branch with no commit yet
    // (measured). A clone gives fork its own resolvable HEAD, sharing
    // origin's seed commit, so the push below is a genuine fast-forward and
    // not merely rejected by git itself as unrelated histories.
    realGit(f, ["clone", "-q", "--bare", f.origin, fork], f.root);
    realGit(f, ["remote", "add", "fork", fork]);
    commit(f);
    const before = run([REAL_GIT as string, "for-each-ref", "--format=%(refname) %(objectname)"], fork, f.env).stdout;

    expectRefused(git(f, ["push", "fork", `HEAD:${f.def}`]));
    // The guard keys on the default branch NAME, not on which remote is
    // named: any remote's refs/heads/<default> is refused.
    expect(run([REAL_GIT as string, "for-each-ref", "--format=%(refname) %(objectname)"], fork, f.env).stdout)
      .toBe(before);
  });

  test("remote.origin.push configured to point at the default branch, then a bare push", () => {
    const f = setup();
    realGit(f, ["checkout", "-q", "-b", "feature/work"]);
    realGit(f, ["config", "remote.origin.push", `HEAD:refs/heads/${f.def}`]);
    commit(f);

    expectRefused(git(f, ["push"]));
  });

  test("a repo-LOCAL core.hooksPath (husky, a checked-in .githooks) cannot bypass it either", () => {
    const f = setup();
    const hooks = join(f.clone, ".githooks");
    mkdirSync(hooks, { recursive: true });
    realGit(f, ["config", "core.hooksPath", ".githooks"]);
    commit(f);

    expectRefused(git(f, ["push", "origin", `HEAD:${f.def}`]));
  });

  test("an alias that expands to a push at the default branch", () => {
    const f = setup();
    realGit(f, ["config", "alias.yolo", `push origin HEAD:${f.def}`]);
    commit(f);

    expectRefused(git(f, ["yolo"]));
  });

  test("an alias that expands to a partial push, with the dangerous refspec in the caller's argv", () => {
    const f = setup();
    realGit(f, ["config", "alias.up", "push origin"]);
    commit(f);

    expectRefused(git(f, ["up", `HEAD:${f.def}`]));
  });

  test.each(["main", "master", "trunk"])(
    "the default branch is whatever the remote says it is, never a hardcoded name: %s", (def) => {
      const f = setup(def);
      commit(f);

      expectRefused(git(f, ["push", "origin", `HEAD:${def}`]));
    },
  );

  test("refs/remotes/origin/HEAD missing, but the remote still reachable: resolved by fallback, still refused", () => {
    const f = setup();
    realGit(f, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
    expect(run([REAL_GIT as string, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], f.clone, f.env).code)
      .not.toBe(0);
    commit(f);

    expectRefused(git(f, ["push", "origin", `HEAD:${f.def}`]));
  });

  test("refs/remotes/origin/HEAD missing AND the remote unreachable: FAILS CLOSED, never a silent allow", () => {
    const f = setup();
    realGit(f, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
    realGit(f, ["remote", "set-url", "origin", join(f.root, "gone.git")]);
    commit(f);

    // Issue #310 r2: the destination comes from the dry-run probe, which is
    // what fails first against an unreachable remote -- still fail closed.
    const r = git(f, ["push", "origin", `HEAD:${f.def}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(STUDIO_PUSH_PROBE_FAILED);
    // And the same posture for a push that names no default-branch ref at
    // all: a blind guard refuses it too.
    const feature = git(f, ["push", "origin", "HEAD:refs/heads/feature/work"]);
    expect(feature.code).toBe(1);
    expect(feature.stderr).toContain(STUDIO_PUSH_PROBE_FAILED);
  });

  test("a bare `git` word in a shell resolves to the wrapper through PATH, refusal and all", () => {
    const f = setup();
    commit(f);

    const r = bash(f, `git push origin HEAD:${f.def}`);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_REFUSAL);
  });

  test("a hook manager that overwrites the repo's pre-push (lefthook install --force) changes nothing", () => {
    const f = setup();
    // The repo's own pre-push first, so the installer has something to rename
    // — exactly what was measured: the guard became `pre-push.old` and stopped
    // running. That whole failure mode needs the guard to BE a hook.
    const hooks = join(f.clone, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(hooks, "pre-push"), 0o755);

    const installer = join(f.root, "fake-lefthook-install");
    writeFileSync(installer, [
      "#!/bin/sh",
      "set -e",
      'hooks="$(git rev-parse --git-path hooks)"',
      'mkdir -p "$hooks"',
      'if [ -e "$hooks/pre-push" ]; then mv -f "$hooks/pre-push" "$hooks/pre-push.old"; fi',
      `printf '%s\\n' '#!/bin/sh' 'exit 0' > "$hooks/pre-push"`,
      'chmod +x "$hooks/pre-push"',
    ].join("\n") + "\n");
    chmodSync(installer, 0o755);

    const installed = bash(f, installer);
    expect(installed.code).toBe(0);
    expect(existsSync(join(hooks, "pre-push.old"))).toBe(true);
    commit(f);

    // The guard lives on PATH, not in .git/hooks, so nothing a hook manager
    // does to that directory can reach it.
    expectRefused(git(f, ["push", "origin", `HEAD:${f.def}`]));
  });
});

LANE("the fleet git wrapper ALLOWS every push a studio actually needs (issue #253)", () => {
  test("a normal feature-branch push", () => {
    const f = setup();
    realGit(f, ["checkout", "-q", "-b", "feature/work"]);
    commit(f);

    const r = git(f, ["push", "origin", "feature/work"]);
    expect(r.code).toBe(0);
    expect(originRefs(f)).toContain("refs/heads/feature/work");
  });

  test("a push to a fleet/rescue/* branch — rescue.ts's own ref shape", () => {
    const f = setup();
    const ref = `fleet/rescue/${STUDIO}-20260925060200`;
    realGit(f, ["checkout", "-q", "-b", ref]);
    commit(f);

    const r = git(f, ["push", "origin", `HEAD:refs/heads/${ref}`]);
    expect(r.code).toBe(0);
    expect(originRefs(f)).toContain(`refs/heads/${ref}`);
  });

  test("a tag push", () => {
    const f = setup();
    commit(f);
    realGit(f, ["tag", "v1"]);

    const r = git(f, ["push", "origin", "v1"]);
    expect(r.code).toBe(0);
    expect(originRefs(f)).toContain("refs/tags/v1");
  });

  test("a bare push from a branch CUT OFF the default branch but with no live upstream", () => {
    const f = setup();
    // branch.autoSetupMerge=false (the install set it) means this branch gets
    // no upstream at all; push.default=current (ditto) sends a bare push to a
    // same-named remote branch. The guard is about the push's TARGET, never
    // about where the branch came from.
    realGit(f, ["checkout", "-q", "-b", "work", `origin/${f.def}`]);
    expect(run([REAL_GIT as string, "config", "branch.work.merge"], f.clone, f.env).code).not.toBe(0);
    commit(f);

    const r = git(f, ["push"]);
    expect(r.code).toBe(0);
    expect(originRefs(f)).toContain("refs/heads/work");
  });

  test("rescuePushCmd's EXACT generated command string still pushes (teardown salvage must never break)", () => {
    const f = setup();
    // On the default branch, which is the case rescue.ts redirects to a
    // generated fleet/rescue/* ref — and the case that would break loudest if
    // the guard were wrong.
    writeFileSync(join(f.clone, "unsaved.md"), "work that must not be lost\n");

    const r = bash(f, rescuePushCmd(REPO, STUDIO, join(f.root, "ws")), f.root);

    expect(r.code).toBe(0);
    // #266 (PR #312): every RESCUE_PUSHED line now names its kind.
    expect(r.stdout.trim()).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 ${RESCUE_PUSHED_KIND_FILES}$`));
    expect(originRefs(f).some((ref) => ref.startsWith(`refs/heads/fleet/rescue/${STUDIO}-`))).toBe(true);
  });

  // #266 (PR #312): the LIVE snapshot rescue (`fleet rescue-all`) pushes a
  // commit-tree SHA by value, and round 3 routes its clean-ahead branch to a
  // generated ref too. Both must pass the guard exactly as generated, or
  // salvage from a running studio silently breaks.
  test("rescueSnapshotCmd's EXACT generated command string still pushes a dirty tree (live salvage must never break)", () => {
    const f = setup();
    writeFileSync(join(f.clone, "unsaved.md"), "work that must not be lost\n");
    const head = realGit(f, ["rev-parse", "HEAD"]).stdout.trim();

    const r = bash(f, rescueSnapshotCmd(REPO, STUDIO, join(f.root, "ws")), f.root);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 ${RESCUE_PUSHED_KIND_FILES}$`));
    expect(originRefs(f).some((ref) => ref.startsWith(`refs/heads/fleet/rescue/${STUDIO}-`))).toBe(true);
    // Live: the studio's own HEAD is untouched by the snapshot.
    expect(realGit(f, ["rev-parse", "HEAD"]).stdout.trim()).toBe(head);
  });

  test("rescueSnapshotCmd's EXACT generated command string still pushes a clean feature branch's unpushed commits", () => {
    const f = setup();
    realGit(f, ["checkout", "-q", "-b", "task/feature"]);
    commit(f, "feature.txt");
    const featureBefore = originState(f).filter((l) => l.startsWith("refs/heads/task/feature"));

    const r = bash(f, rescueSnapshotCmd(REPO, STUDIO, join(f.root, "ws")), f.root);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 ${RESCUE_PUSHED_KIND_COMMITS}$`));
    expect(originRefs(f).some((ref) => ref.startsWith(`refs/heads/fleet/rescue/${STUDIO}-`))).toBe(true);
    expect(originState(f).filter((l) => l.startsWith("refs/heads/task/feature"))).toEqual(featureBefore);
  });

  test("the repo's OWN .git/hooks/pre-push still runs — exactly once — on an allowed push", () => {
    const f = setup();
    const marker = join(f.root, "pre-push-ran");
    const hooks = join(f.clone, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\nprintf 'ran\\n' >> '${marker}'\nexit 0\n`);
    chmodSync(join(hooks, "pre-push"), 0o755);
    realGit(f, ["checkout", "-q", "-b", "feature/hooked"]);
    commit(f);

    const r = git(f, ["push", "origin", "feature/hooked"]);

    expect(r.code).toBe(0);
    // Once, not twice: the guard's own probe carries --no-verify precisely so
    // a repo's hook is not fired by a dry run it never asked for.
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
  });

  test("a repo pre-push hook that REFUSES still refuses — the wrapper never smuggles a push past it", () => {
    const f = setup();
    const hooks = join(f.clone, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho 'client CI says no' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-push"), 0o755);
    realGit(f, ["checkout", "-q", "-b", "feature/gated"]);
    commit(f);

    const r = git(f, ["push", "origin", "feature/gated"]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("client CI says no");
    expect(originRefs(f)).not.toContain("refs/heads/feature/gated");
  });

  test("every non-push subcommand goes straight through, output and exit code untouched", () => {
    const f = setup();
    commit(f);

    expect(git(f, ["--version"]).stdout).toContain("git version");
    expect(git(f, ["status", "--porcelain"]).code).toBe(0);
    expect(git(f, ["log", "--oneline", "-1"]).stdout).toContain("work: work.txt");
    expect(git(f, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe(f.def);
    expect(git(f, ["-C", f.origin, "for-each-ref", "--format=%(refname)"]).stdout)
      .toContain(`refs/heads/${f.def}`);
    // A non-push alias is handed over, not intercepted.
    realGit(f, ["config", "alias.st", "status --porcelain"]);
    expect(git(f, ["st"]).code).toBe(0);
    // A '!' shell alias, even a harmless one, is refused outright as of issue
    // #310 (X1) — see the round-4 block near the bottom of this file for why
    // a harmless-looking one still has to go.
    realGit(f, ["config", "alias.who", "!echo shell-alias-ran"]);
    expectAliasRefused(git(f, ["who"]));
  });
});

/**
 * Maestro's round-2 review of PR #259 measured EIGHT argv spellings that got a
 * real push onto the default branch past the round-1 wrapper, in three groups.
 * Each one below was reproduced by hand against the round-1 script first (git
 * 2.34.1), so every test here is a bypass that actually happened, not a
 * hypothetical.
 *
 * Group 1 — PROBE AUTHORITY. The round-1 script put its own enforcing flags
 * BEFORE the user's args (`push --dry-run --porcelain --no-verify "${dry[@]}"`).
 * Git's option parser is last-wins, so a later, hostile spelling in the user's
 * own argv simply overrode them. Measured: `--no-dry-run` made the PROBE do the
 * real push (origin moved before the wrapper printed a word); `--no-porcelain`,
 * `--quie` (an abbreviation git still resolves to `--quiet`) and `-qf` (the
 * bundled short form) each left the probe with no ref line to read, so the
 * guard saw nothing and handed over; `--verify` re-enabled the repo's pre-push
 * hook on a dry run nobody asked for.
 */
LANE("the probe's own flags OUTRANK the user's argv — maestro round 2, item 1 (issue #253)", () => {
  test.each([
    ["--no-dry-run — the probe itself did the push", (d: string) =>
      ["push", "--no-dry-run", "origin", `HEAD:${d}`]],
    ["--no-porcelain — no ref line for the guard to read", (d: string) =>
      ["push", "--no-porcelain", "origin", `HEAD:${d}`]],
    ["--quie — an abbreviation git still resolves to --quiet", (d: string) =>
      ["push", "--quie", "origin", `HEAD:${d}`]],
    ["-qf — the bundled short-option spelling", (d: string) =>
      ["push", "-qf", "origin", `HEAD:${d}`]],
    ["--quiet AFTER the refspec, not before it", (d: string) =>
      ["push", "origin", `HEAD:${d}`, "--quiet"]],
    ["--no-porcelain --no-dry-run together, both after the refspec", (d: string) =>
      ["push", "origin", `HEAD:${d}`, "--no-porcelain", "--no-dry-run"]],
    ["a bare -- , so the refspec is a positional argument", (d: string) =>
      ["push", "origin", "--", `HEAD:${d}`]],
  ])("%s", (_label, argv) => {
    const f = setup();
    commit(f);
    const before = originState(f);

    expectRefused(git(f, argv(f.def)));
    // The point of this whole group: the refusal must come BEFORE anything
    // moves, not after. Round 1 printed the same message for --no-dry-run and
    // origin had already moved.
    expect(originState(f)).toEqual(before);
  });

  test("--verify cannot make the probe fire the repo's own pre-push hook", () => {
    const f = setup();
    const marker = join(f.root, "pre-push-ran");
    markerHook(f, marker);
    commit(f);

    expectRefused(git(f, ["push", "--verify", "origin", `HEAD:${f.def}`]));
    // The probe carries --no-verify LAST, so no user spelling can re-enable
    // hooks on it: a refused push must never have run the repo's CI hook.
    expect(existsSync(marker)).toBe(false);
  });

  test("a legitimate --no-verify push to a feature branch still skips the hook, exactly as the user asked", () => {
    const f = setup();
    const marker = join(f.root, "pre-push-ran");
    markerHook(f, marker);
    realGit(f, ["checkout", "-q", "-b", "feature/quiet"]);
    commit(f);

    // The wrapper appends its own flags to the PROBE only. The real push at
    // the end still gets the user's ORIGINAL argv, --no-verify and all.
    const r = git(f, ["push", "--no-verify", "origin", "feature/quiet"]);
    expect(r.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(originRefs(f)).toContain("refs/heads/feature/quiet");
  });
});

/**
 * Group 2 — FAIL CLOSED ON PROBE FAILURE. The round-1 script never looked at
 * the probe's exit code. A probe that FAILED produced an empty `$out`, the
 * porcelain loop found nothing to refuse, and execution fell through to the
 * `exec "$real" "$@"` at the very end — the real push ran, unguarded, exactly
 * as if the probe had legitimately found nothing to push. Those are not the
 * same thing, and conflating them is what let these through.
 */
LANE("a probe that FAILED refuses the push — maestro round 2, item 2 (issue #253)", () => {
  /** A receive-pack that fails its FIRST connection and works from then on —
   *  the shape of a transient network failure, made deterministic. The probe
   *  eats the failure; the real push that followed it succeeded. */
  function flakyReceivePack(f: Fixture): string {
    const rp = join(f.root, "flaky-receive-pack");
    const marker = join(f.root, "rp-seen");
    writeFileSync(rp, [
      "#!/bin/sh",
      `if [ ! -e '${marker}' ]; then`,
      `  : > '${marker}'`,
      `  echo 'flaky: connection reset by peer' >&2`,
      "  exit 1",
      "fi",
      'exec git-receive-pack "$@"',
    ].join("\n") + "\n");
    chmodSync(rp, 0o755);
    return rp;
  }

  test("a remote that fails only the probe's connection — round 1 let the retry land on the default branch", () => {
    const f = setup();
    realGit(f, ["config", "remote.origin.receivepack", flakyReceivePack(f)]);
    commit(f);
    const before = originState(f);

    const r = git(f, ["push", "origin", `HEAD:${f.def}`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_PROBE_FAILED);
    // git's own words about what went wrong, not only fleet's.
    expect(r.stderr).toContain("flaky: connection reset by peer");
    expect(originState(f)).toEqual(before);
  });

  test("an alias whose expansion carries literal QUOTES — round 1's naive word split broke the probe, real git pushed", () => {
    const f = setup();
    // Word-splitting this without quote removal hands the probe a refspec
    // spelled `"HEAD` — git errors, round 1 read that as "nothing to refuse",
    // and the real git then expanded the same alias CORRECTLY and pushed.
    realGit(f, ["config", "alias.qq", `push origin "HEAD:${f.def}"`]);
    commit(f);
    const before = originState(f);

    const r = git(f, ["qq"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_PROBE_FAILED);
    expect(originState(f)).toEqual(before);
  });

  test("a push option the receiving end cannot take — the probe's hard error refuses, it never hands over", () => {
    const f = setup();
    commit(f);
    const before = originState(f);

    // `-o` needs a receiving end that advertises push options; this bare repo
    // does not, so the probe exits 128. Round 1 fell through to the real push.
    const r = git(f, ["push", "-o", "ci.skip", "origin", `HEAD:${f.def}`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_PROBE_FAILED);
    expect(r.stderr).toContain("push options");
    expect(originState(f)).toEqual(before);
  });

  test("a probe that FAILS but still names the default branch gets the SPECIFIC refusal, not the generic one", () => {
    const f = setup();
    commit(f);
    // A stale lease makes --force-with-lease exit non-zero while STILL printing
    // its `!` ref line for refs/heads/<default>. The exit-code check sits AFTER
    // the porcelain parse precisely so this reads as "studios never push the
    // default branch" and not as "could not check" — the operator needs the
    // reason, not the symptom.
    realGit(f, ["update-ref", `refs/remotes/origin/${f.def}`, "HEAD"]);
    const before = originState(f);

    expectRefused(git(f, ["push", "--force-with-lease", "origin", `HEAD:${f.def}`]));
    expect(originState(f)).toEqual(before);
  });

  test("a probe that legitimately finds NOTHING to push is still handed over — fail closed, not fail loud", () => {
    const f = setup();
    realGit(f, ["checkout", "-q", "-b", "feature/uptodate"]);
    realGit(f, ["push", "-q", "origin", "feature/uptodate"]);

    // Nothing to push, probe exits 0 with an "=" (up to date) line: that is a
    // successful probe reporting no movement, not a failure, so git runs and
    // reports its own "Everything up-to-date".
    const r = git(f, ["push", "origin", "feature/uptodate"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain(STUDIO_PUSH_PROBE_FAILED);
  });
});

/**
 * Group 3 — SHELL ALIASES. Round 1 handed every `!`-prefixed alias straight to
 * the real git on the claim that "any git inside THAT resolves through PATH and
 * lands back here already guarded". That claim is FALSE, measured: git prepends
 * its own exec-path onto the PATH of anything it runs, the studio image's
 * `/usr/lib/git-core/git` is a SECOND real git binary (different inode from
 * `/usr/bin/git`), so a `git` word inside a `!` alias reaches the real git
 * directly and never the wrapper.
 *
 * SUPERSEDED by issue #310 (X1, see the round-4 block near the bottom of this
 * file): rounds 2 and 3 refused on the alias TEXT (a literal "push"/"git"
 * mention, then a normalized one), which is an arms race against arbitrary
 * shell obfuscation and eventually lost it. Every `!` alias is refused
 * outright now, whether or not its text mentions git at all — so every test
 * below that expects a refusal still passes (a text-based refusal is a
 * subset of an unconditional one), but a couple that expected a HARMLESS `!`
 * alias to run were flipped; see their own comments.
 *
 * KNOWN RESIDUAL GAP, not closed by ANY round yet: the same exec-path prepend
 * makes `git rebase -x '<cmd>'`, a repo's own hooks, `git submodule foreach`
 * and `git bisect run` unguarded too (the review measured `rebase -x` and a
 * pushing hook each moving the default branch). Refusing `!` aliases closes
 * the alias door only. Replacing `/usr/lib/git-core/git` is NOT the answer:
 * measured, it breaks dashed git subcommands and `git clone file://`.
 */
LANE("a '!' shell alias that mentions push is REFUSED — maestro round 2, item 3 (issue #253)", () => {
  test("alias.x = '!git push origin HEAD:<default>' — round 1 handed it over and the default branch moved", () => {
    const f = setup();
    realGit(f, ["config", "alias.x", `!git push origin HEAD:${f.def}`]);
    commit(f);
    const before = originState(f);

    const r = git(f, ["x"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_SHELL_ALIAS_REFUSAL);
    expect(originState(f)).toEqual(before);
  });

  test("git's own exec-path really does hold a SECOND real git — the reason the round-1 claim was false", () => {
    const f = setup();
    // Not an assertion about the guard: an assertion about the platform the
    // guard runs on. If this ever stops being true the refusal above can be
    // relaxed, and this is what will say so.
    const execPath = run([REAL_GIT as string, "--exec-path"], f.clone, f.env).stdout.trim();
    const inside = run(["bash", "-c", `PATH='${execPath}':"$PATH" command -v git`], f.clone, f.env);
    expect(inside.stdout.trim()).toBe(join(execPath, "git"));
    expect(inside.stdout.trim()).not.toBe(f.wrapper);
  });

  test("an indirect push spelling built from a variable is refused too (kept as a pin, unconditional now)", () => {
    const f = setup();
    realGit(f, ["config", "alias.ship", `!p=push; git $p origin HEAD:${f.def}`]);
    commit(f);
    const before = originState(f);

    expectAliasRefused(git(f, ["ship"]));
    expect(originState(f)).toEqual(before);
  });

  test("a '!' alias's own ARGUMENTS carrying a push are refused too (kept as a pin, unconditional now)", () => {
    const f = setup();
    realGit(f, ["config", "alias.run", "!sh -c"]);
    commit(f);
    const before = originState(f);

    expectAliasRefused(git(f, ["run", `git push origin HEAD:${f.def}`]));
    expect(originState(f)).toEqual(before);
  });

  test("a '!' alias that touches no git at all is refused too, now that every '!' alias is (issue #310)", () => {
    const f = setup();
    // Round 2 allowed `!git rev-list --count HEAD` here on the grounds that its
    // text does not mention push, and round 3 narrowed that to "any '!' alias
    // that reaches git" -- both still judged the alias by its TEXT. Issue #310
    // (X1) stopped judging text at all: no scan can prove an alias harmless
    // when arbitrary shell obfuscation can hide anything a scan looks for
    // (see the round-4 block at the bottom of this file), so even one that
    // touches no git and could not conceivably push is refused now.
    realGit(f, ["config", "alias.hello", "!echo shell-alias-ran"]);
    commit(f);

    const r = git(f, ["hello"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_SHELL_ALIAS_REFUSAL);
  });
});

/**
 * Group 4 — SELF-REPAIR. `studioGitSafetyCmd` ran its two `git config --global`
 * steps through a BARE `git`, which PATH resolves to the wrapper itself. A live
 * wrapper that is broken therefore failed those steps, and the `&&` chain
 * aborted long before reaching the step that would have REPLACED the broken
 * wrapper: a broken wrapper could never repair itself, and every later
 * provision and restart failed the same way.
 */
LANE("a re-provision repairs a BROKEN live wrapper — maestro round 2, item 4 (issue #253)", () => {
  test("the wrapper is replaced byte-for-byte even when the live one exits 1 for everything", () => {
    const f = setup();
    const good = readFileSync(f.wrapper, "utf8");
    // A wrapper that a bad install, a truncated write or a bad edit left
    // unconditionally broken. It is FIRST on PATH, so a bare `git` finds it.
    writeFileSync(f.wrapper, "#!/bin/sh\nexit 1\n");
    chmodSync(f.wrapper, 0o755);
    expect(run([f.wrapper, "--version"], f.clone, f.env).code).toBe(1);

    installWrapper(f);

    expect(readFileSync(f.wrapper, "utf8")).toBe(good);
    expect(good).toBe(studioGitWrapperScript(REAL_GIT as string, f.scan));
    // And the repaired wrapper guards again.
    commit(f);
    expectRefused(git(f, ["push", "origin", `HEAD:${f.def}`]));
  });

  test("the two git config steps land their values even through a broken live wrapper", () => {
    const f = setup();
    writeFileSync(f.wrapper, "#!/bin/sh\nexit 1\n");
    chmodSync(f.wrapper, 0o755);

    installWrapper(f);

    expect(run([REAL_GIT as string, "config", "--global", "push.default"], f.clone, f.env).stdout.trim())
      .toBe("current");
    expect(run([REAL_GIT as string, "config", "--global", "branch.autoSetupMerge"], f.clone, f.env).stdout.trim())
      .toBe("false");
  });
});

/**
 * Group 5 — the PINS themselves. Two mutants survived round 1's suite: joining
 * the install chain's steps with a bare `;` instead of `&&` (the vitest pin only
 * looked for `" ; "`, with spaces on both sides), and dropping the `(unknown)`
 * alternative from the default-branch case so an unresolvable remote HEAD read
 * as a branch literally named `(unknown)`. Both are killed here by behaviour,
 * not only by a string match.
 */
LANE("the install chain and the default-branch resolve fail loudly — maestro round 2, item 5 (issue #253)", () => {
  test("the FIRST step's failure aborts the whole install: no wrapper is left behind", () => {
    const f = setup("trunk", false);
    expect(existsSync(f.wrapper)).toBe(false);

    // A global config file that cannot be locked, so `git config --global`
    // fails. Joined by `&&` the chain stops dead; joined by `;` it would sail
    // on and install the wrapper anyway.
    const cmd = studioGitSafetyCmd({ wrapperPath: f.wrapper, realGit: REAL_GIT as string });
    const r = run(["bash", "-c", withKillDeadline(cmd, 30_000)], f.clone, {
      ...f.env, GIT_CONFIG_GLOBAL: join(f.root, "no-such-dir", ".gitconfig"),
    });

    expect(r.code).not.toBe(0);
    expect(existsSync(f.wrapper)).toBe(false);
  });

  test("a MID-chain failure aborts it too — the exit code covers every step, not only the first", () => {
    const f = setup("trunk", false);
    // The two config steps succeed; the staged write is the one that cannot
    // happen, because its directory does not exist. That is a failure at join
    // three of six, and the exec's single exit code has to carry it.
    const wrapper = join(f.root, "no-such-dir", "git");
    const cmd = studioGitSafetyCmd({ wrapperPath: wrapper, realGit: REAL_GIT as string });

    const r = run(["bash", "-c", withKillDeadline(cmd, 30_000)], f.clone, f.env);

    expect(r.code).not.toBe(0);
    expect(existsSync(wrapper)).toBe(false);
    // Proof the failure really was mid-chain and not at step one.
    expect(run([REAL_GIT as string, "config", "--global", "push.default"], f.clone, f.env).stdout.trim())
      .toBe("current");
  });

  test("the remote's HEAD points at a branch that does not exist: `(unknown)`, so FAIL CLOSED", () => {
    const f = setup();
    // The local symref goes first, so the wrapper must fall back to asking the
    // remote — which is reachable, and answers `HEAD branch: (unknown)`.
    realGit(f, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
    realGit(f, ["symbolic-ref", "HEAD", "refs/heads/never-existed"], f.origin);
    expect(realGit(f, ["remote", "show", "origin"]).stdout).toContain("HEAD branch: (unknown)");
    commit(f);
    const before = originState(f);

    // `(unknown)` is an UNRESOLVED default, never a branch by that name: a
    // guard that took it literally would compare against
    // refs/heads/(unknown) and wave the real default branch straight through.
    const r = git(f, ["push", "origin", `HEAD:${f.def}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(STUDIO_PUSH_UNRESOLVED_DEFAULT);
    expect(originState(f)).toEqual(before);
  });
});

/**
 * Group 6 — maestro's round-3 review, item 1 (HIGH): the regression round 2's
 * own fix introduced. Moving the probe's four enforcing flags to the END of the
 * argv (so git's last-wins parse makes them outrank the caller's) put them
 * directly behind whatever the caller's LAST token is. If that last token is an
 * option that expects a SEPARATE value and the caller supplied none — a
 * "dangling" option — git's parser consumes the very next token as that value,
 * and the very next token is the probe's own `--dry-run`. Swallowed, the probe
 * is no longer a dry run: it is the REAL push, carrying the probe's own
 * `--no-verify` (still parsed as itself, once the parser resumes after the
 * consumed value), so the repo's hooks are skipped too. The refusal still
 * prints, off the ref line the porcelain output correctly reports — after the
 * default branch has already moved.
 *
 * Measured on this file's own fixture shape, git 2.34.1: `--repo`, `--rep` (an
 * abbreviation git still resolves) and `-o`/`--push-option` against a remote
 * that advertises push options each MOVED the default branch. The fix is one
 * sacrificial `--no-verify` between the caller's args and the four real flags:
 * a dangling option eats THAT and the four survive intact, and when nothing is
 * dangling it is an ordinary, redundant flag.
 */
LANE("a DANGLING option cannot swallow the probe's flags — maestro round 3, item 1 (issue #253)", () => {
  test.each([
    ["--repo, with no value", "--repo"],
    ["--rep, an abbreviation git still resolves to --repo, with no value", "--rep"],
  ])("%s", (_label, dangling) => {
    const f = setup();
    commit(f);
    const before = originState(f);

    expectRefused(git(f, ["push", "origin", `HEAD:${f.def}`, dangling]));
    // The whole point: the refusal has to come BEFORE anything moves. Round 2
    // printed this same message with origin already fast-forwarded.
    expect(originState(f)).toEqual(before);
  });

  test.each([
    ["-o, with no value", "-o"],
    ["--push-option, with no value", "--push-option"],
  ])("%s, against a remote that advertises push options", (_label, dangling) => {
    const f = setup();
    // Without this the probe's connection fails (exit 128) and round 2's
    // fail-closed check catches the push by accident. A real remote — GitHub —
    // advertises push options, and then the swallowed --dry-run is a real push.
    realGit(f, ["config", "receive.advertisePushOptions", "true"], f.origin);
    commit(f);
    const before = originState(f);

    // #321: either refusal — git's dry run races to SIGPIPE here now and then
    // (pinned deterministically below). Main not moving is the proof.
    expectRefusedOrFailedClosed(git(f, ["push", "origin", `HEAD:${f.def}`, dangling]));
    expect(originState(f)).toEqual(before);
  });

  // #321, measured on the Linux lane image (git 2.43, docker, host load
  // 25-42): the probe argv above -- `-o` swallowing the sacrificial flag, then
  // `--dry-run --porcelain` -- against a remote that advertises push options
  // dies of SIGPIPE (exit 141, NO output) in 6 of 200 raw runs: a race between
  // the dry run and the local receive-pack exiting. The wrapper then FAILS
  // CLOSED with its probe-failed line, not the specific refusal, and origin
  // never moves (0 of 200 instrumented pushes moved it). Pinned here with a
  // real-git shim that forces that exact 141, so the dangling cases above are
  // proven on the path the race takes, every run, instead of 3-9% of them.
  test.each([
    ["-o, with no value", "-o"],
    ["--push-option, with no value", "--push-option"],
  ])("%s, when the probe dies of SIGPIPE (git's dry-run race, #321): refused, main never moves", (_label, dangling) => {
    const f = setup(undefined, false);
    const shim = join(f.root, "sigpipe-git");
    writeFileSync(shim, `#!/bin/bash\nfor a in "$@"; do [ "$a" = "--dry-run" ] && exit 141; done\nexec ${REAL_GIT} "$@"\n`);
    chmodSync(shim, 0o755);
    const cmd = studioGitSafetyCmd({ wrapperPath: f.wrapper, realGit: shim, scanPath: f.scan });
    const inst = run(["bash", "-c", withKillDeadline(cmd, 30_000)], f.clone, f.env);
    if (inst.code !== 0) throw new Error(`wrapper install failed (${inst.code}): ${inst.stderr}${inst.stdout}`);
    realGit(f, ["config", "receive.advertisePushOptions", "true"], f.origin);
    commit(f);
    const before = originState(f);

    const r = git(f, ["push", "origin", `HEAD:${f.def}`, dangling]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_PROBE_FAILED);
    expect(originState(f)).toEqual(before);
  });

  test("the sacrificial flag does not disturb a push that is allowed", () => {
    const f = setup();
    realGit(f, ["checkout", "-q", "-b", "feature/dangle"]);
    commit(f);

    const r = git(f, ["push", "origin", "feature/dangle"]);
    expect(r.code).toBe(0);
    expect(originRefs(f)).toContain("refs/heads/feature/dangle");
  });

  test("a dangling option whose swallowed value git cannot use still fails CLOSED, never open", () => {
    const f = setup();
    commit(f);
    const before = originState(f);

    // `--exec` eats the sacrificial flag and hands `--no-verify` to the remote
    // as a receive-pack path, which cannot run: the probe exits non-zero and
    // round 2's fail-closed check refuses. Measured to behave the same way with
    // and without the fix — the point is that no spelling of this reaches the
    // default branch.
    const r = git(f, ["push", "origin", `HEAD:${f.def}`, "--exec"]);
    expect(r.code).not.toBe(0);
    expect(originState(f)).toEqual(before);
  });
});

/**
 * Group 7 — round 3, item 2 (MED): `git send-pack`. The push PORCELAIN is not
 * the only command that pushes. `git send-pack <url> HEAD:refs/heads/<default>`
 * is the plumbing underneath it and moves a remote ref on its own (measured
 * below against a throwaway second remote, so this file proves the gap rather
 * than asserting it). Round 2's scanner only recognized `push`, so `send-pack`
 * fell through to `exec "$real" "$@"` entirely unguarded.
 *
 * REFUSED OUTRIGHT rather than guarded. `send-pack` has `--dry-run` but no
 * `--porcelain` (measured), so guarding it would mean a refspec parser of this
 * wrapper's own — the one thing the porcelain probe exists to avoid. No studio
 * has a legitimate reason to reach for the plumbing, and `git push` is right
 * there. `http-push`, the dumb-HTTP twin, is refused by the same line.
 */
LANE("git send-pack and git http-push are REFUSED outright — maestro round 3, item 2 (issue #253)", () => {
  test("send-pack really does push a remote ref, which is why it needs its own line", () => {
    const f = setup();
    const fork = join(f.root, "fork.git");
    realGit(f, ["init", "-q", "--bare", "-b", f.def, fork], f.root);
    commit(f);

    // The REAL git, deliberately: an assertion about the platform, not about the
    // guard. If send-pack ever stops being able to do this, this is what says so.
    realGit(f, ["send-pack", fork, `HEAD:refs/heads/${f.def}`]);
    expect(run([REAL_GIT as string, "for-each-ref", "--format=%(refname)"], fork, f.env).stdout)
      .toContain(`refs/heads/${f.def}`);
  });

  test("send-pack at the default branch is refused, and nothing moves", () => {
    const f = setup();
    commit(f);
    const before = originState(f);

    const r = git(f, ["send-pack", f.origin, `HEAD:refs/heads/${f.def}`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_PLUMBING_REFUSAL);
    expect(originState(f)).toEqual(before);
  });

  test("send-pack at a FEATURE branch is refused too — the command itself is out of bounds", () => {
    const f = setup();
    realGit(f, ["checkout", "-q", "-b", "feature/plumbing"]);
    commit(f);

    const r = git(f, ["send-pack", f.origin, "HEAD:refs/heads/feature/plumbing"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_PLUMBING_REFUSAL);
    expect(originRefs(f)).not.toContain("refs/heads/feature/plumbing");
  });

  test("http-push, the dumb-HTTP twin, is refused by the same line", () => {
    const f = setup();

    const r = git(f, ["http-push", "https://example.invalid/repo.git", `HEAD:refs/heads/${f.def}`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_PLUMBING_REFUSAL);
  });

  test("an ALIAS that expands to send-pack is refused as well — the rescan sees the real subcommand", () => {
    const f = setup();
    realGit(f, ["config", "alias.sneak", `send-pack ${f.origin} HEAD:refs/heads/${f.def}`]);
    commit(f);
    const before = originState(f);

    const r = git(f, ["sneak"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_PLUMBING_REFUSAL);
    expect(originState(f)).toEqual(before);
  });
});

/**
 * Group 8 — round 3, item 3 (LOW): the alias-chain depth cap FAILED OPEN. The
 * cap exists so a self-referential alias cannot spin the resolver forever, but
 * round 2 spent it on `exec "$real" "$@"` — hand the argv to the real git and
 * hope. Measured, git 2.34.1: a ten-link chain ending in `push origin
 * HEAD:trunk` resolved fine for git and moved the default branch. A resolver
 * that gave up has to REFUSE, the same posture every other unknown in this
 * wrapper already takes.
 */
LANE("an alias chain deeper than the cap REFUSES — maestro round 3, item 3 (issue #253)", () => {
  /** A chain of `n` aliases whose last link is `tail`. `a0` calls `a1`, and so
   *  on — no loop, so git itself resolves it happily. */
  function aliasChain(f: Fixture, n: number, tail: string): void {
    for (let i = 0; i < n - 1; i += 1) realGit(f, ["config", `alias.a${i}`, `a${i + 1}`]);
    realGit(f, ["config", `alias.a${n - 1}`, tail]);
  }

  test("a ten-link chain ending in a push at the default branch: refused, fail closed", () => {
    const f = setup();
    aliasChain(f, 10, `push origin HEAD:${f.def}`);
    commit(f);
    const before = originState(f);

    const r = git(f, ["a0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(STUDIO_PUSH_ALIAS_DEPTH_REFUSAL);
    expect(originState(f)).toEqual(before);
  });

  test("a ten-link chain ending in something HARMLESS is refused too — a resolver that gave up knows nothing", () => {
    const f = setup();
    aliasChain(f, 10, "status --porcelain");
    commit(f);

    const r = git(f, ["a0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(STUDIO_PUSH_ALIAS_DEPTH_REFUSAL);
  });

  test("a chain WITHIN the cap still resolves, and still gets the specific refusal", () => {
    const f = setup();
    aliasChain(f, 3, `push origin HEAD:${f.def}`);
    commit(f);
    const before = originState(f);

    expectRefused(git(f, ["a0"]));
    expect(originState(f)).toEqual(before);
  });

  test("a chain within the cap that ends somewhere harmless still runs", () => {
    const f = setup();
    aliasChain(f, 3, "rev-parse --abbrev-ref HEAD");

    const r = git(f, ["a0"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(f.def);
  });
});

/**
 * Group 9 — round 3, item 4 (LOW): the default branch was read from
 * `refs/remotes/origin/HEAD`, a LOCAL symref, and `git remote set-head origin
 * <other>` rewrites it. One command from the studio's own shell and the guard
 * was watching the wrong branch while the real default branch sat unprotected.
 *
 * Fixed by asking the REMOTE: `git ls-remote --symref origin HEAD` is
 * unaffected by `set-head` (measured — after poisoning, the local symref said
 * the decoy and ls-remote still said `trunk`). Every source that resolves is
 * ADDED to the protected list rather than replacing it, so the poisonable local
 * symref can only ever protect one MORE name, never one fewer.
 */
LANE("the default branch comes from the REMOTE, not a poisonable local symref — round 3, item 4 (issue #253)", () => {
  /** A second branch on the remote, so `set-head` has something to point at. */
  function secondBranch(f: Fixture, name = "decoy"): string {
    realGit(f, ["push", "-q", "origin", `HEAD:refs/heads/${name}`]);
    realGit(f, ["fetch", "-q", "origin"]);
    return name;
  }

  test("`git remote set-head origin <other>` cannot un-protect the real default branch", () => {
    const f = setup();
    const decoy = secondBranch(f);
    realGit(f, ["remote", "set-head", "origin", decoy]);
    expect(realGit(f, ["symbolic-ref", "refs/remotes/origin/HEAD"]).stdout.trim())
      .toBe(`refs/remotes/origin/${decoy}`);
    commit(f);
    const before = originState(f);

    expectRefused(git(f, ["push", "origin", `HEAD:${f.def}`]));
    expect(originState(f)).toEqual(before);
  });

  test("the bare-push shape of the same poisoning is refused too", () => {
    const f = setup();
    const decoy = secondBranch(f);
    realGit(f, ["remote", "set-head", "origin", decoy]);
    commit(f);
    const before = originState(f);

    // Still checked out on the default branch, so a bare push aims there.
    expectRefused(git(f, ["push"]));
    expect(originState(f)).toEqual(before);
  });

  // Issue #310 round 2: the local symref is no longer read at all -- it is the
  // one source this container can rewrite, and the push URL's own HEAD is the
  // only answer. A branch it merely NAMES is not the remote's default, so a
  // push to it is an ordinary branch push. (Round 3 of #253 protected it as an
  // extra name; this pins the new, narrower rule.)
  test("a branch only the LOCAL symref names is NOT the default — pushing it goes through (issue #310 r2)", () => {
    const f = setup();
    const decoy = secondBranch(f);
    realGit(f, ["remote", "set-head", "origin", decoy]);
    realGit(f, ["checkout", "-q", "-b", "work"]);
    commit(f);

    expect(git(f, ["push", "origin", `HEAD:${decoy}`]).code).toBe(0);
  });

  test("a push at neither name still goes through", () => {
    const f = setup();
    const decoy = secondBranch(f);
    realGit(f, ["remote", "set-head", "origin", decoy]);
    realGit(f, ["checkout", "-q", "-b", "feature/unpoisoned"]);
    commit(f);

    const r = git(f, ["push", "origin", "feature/unpoisoned"]);
    expect(r.code).toBe(0);
    expect(originRefs(f)).toContain("refs/heads/feature/unpoisoned");
  });
});

/**
 * Group 10 — round 3, item 5 (LOW): a `!` alias could hide the word `push` from
 * a plain substring scan. Measured, git 2.34.1, each of these moved the default
 * branch for real past round 2's `*push*` check: `!git pu""sh …`, `!git pu''sh
 * …`, `!git pu\sh …`, and `!s=sh; git pu$s …` — the last one hides `push`
 * behind a variable, which no amount of quote-stripping can reach.
 *
 * So the refusal had TWO triggers, not one: the alias text normalized (the
 * quote and expansion characters a word can hide a literal substring behind
 * removed) before the `push` match, which killed the quoting family; and any
 * `!` alias that reached `git` AT ALL refused, which killed the variable
 * family. Both are STILL true below (every test in this block still passes,
 * a text-based refusal being a subset of an unconditional one) but are no
 * longer why the refusal fires: issue #310 (X1) found a glob+octal spelling
 * that defeated BOTH triggers at once (`g?t` is a shell glob that only
 * becomes the literal word "git" once bash runs the alias, and
 * `$(printf "\160ush")` computes "push" from an octal escape at runtime —
 * neither ever appears as a literal substring for a text scan to catch), and
 * concluded that no text scan of any sophistication can close a door shell
 * obfuscation opens. Every `!` alias is refused outright now, unconditionally
 * — see the round-4 block near the bottom of this file. The LAST test below
 * ("never mentions git keeps working") is flipped for exactly that reason: a
 * harmless-looking `!` alias is no longer distinguishable from one that
 * merely looks harmless.
 */
LANE("a '!' shell alias cannot hide a push behind quotes — maestro round 3, item 5 (issue #253)", () => {
  test.each([
    ['pu""sh — empty double-quote concatenation', (d: string) => `!git pu""sh origin HEAD:${d}`],
    ["pu''sh — empty single-quote concatenation", (d: string) => `!git pu''sh origin HEAD:${d}`],
    ["pu\\sh — a backslash inside the word", (d: string) => `!git pu\\sh origin HEAD:${d}`],
    ["pu$s — the word built from a variable, which no quote-stripping can reach",
      (d: string) => `!s=sh; git pu$s origin HEAD:${d}`],
    ['"push" — the quoted spelling round 2 already caught, kept as a pin',
      (d: string) => `!git "push" origin HEAD:${d}`],
  ])("%s", (_label, expansion) => {
    const f = setup();
    realGit(f, ["config", "alias.z", expansion(f.def)]);
    commit(f);
    const before = originState(f);

    expectAliasRefused(git(f, ["z"]));
    expect(originState(f)).toEqual(before);
  });

  test("both the git word AND the push word hidden behind quotes — only normalizing catches this one", () => {
    const f = setup();
    // `gi""t pu""sh` contains neither `git` nor `push` as literal bytes, so
    // NEITHER trigger fires without the stripping step, and the shell that runs
    // the alias assembles both words and pushes for real (measured, git
    // 2.34.1). This is the case that makes the normalization load-bearing
    // rather than belt-and-braces.
    realGit(f, ["config", "alias.hid", `!gi""t pu""sh origin HEAD:${f.def}`]);
    commit(f);
    const before = originState(f);

    expectAliasRefused(git(f, ["hid"]));
    expect(originState(f)).toEqual(before);
  });

  test("a '!' alias that reaches git at all is refused, even one that could not push anything", () => {
    const f = setup();
    realGit(f, ["config", "alias.count", "!git rev-list --count HEAD"]);
    commit(f);

    expectAliasRefused(git(f, ["count"]));
  });

  test("git reached by absolute path inside a '!' alias is refused as well", () => {
    const f = setup();
    realGit(f, ["config", "alias.raw", `!${REAL_GIT as string} rev-parse HEAD`]);
    commit(f);

    expectAliasRefused(git(f, ["raw"]));
  });

  test("a '!' alias that never mentions git is refused too now — issue #310 made this unconditional", () => {
    const f = setup();
    // This alias's text never mentions "git" as a substring (only inside the
    // github.com URL, which is why round 3 needed a WORD match, not a
    // substring one) and could not push anything. Round 3 still let it run,
    // on the theory that a scoped refusal was enough. Issue #310 (X1)
    // concluded no text-based scope is trustworthy — the glob+octal bypass
    // hid BOTH "git" and "push" from round 3's own trigger — so this is
    // refused unconditionally now, exactly like a `!` alias that plainly
    // pushes.
    realGit(f, ["config", "alias.link", "!echo https://github.com/rafarc21/fleetflare"]);

    const r = git(f, ["link"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_SHELL_ALIAS_REFUSAL);
  });
});

/**
 * Group 11 — a maestro review round of the merged #259 fix, item X1 (issue
 * #310, HIGH): round 3's text scan (strip quote/expansion characters, then
 * refuse on a literal "push"/"send-pack"/"git" match) is a losing arms race
 * against ARBITRARY shell obfuscation, not a closed set of tricks. Measured,
 * git 2.34.1: `alias.p = '!/usr/bin/g?t $(printf "\160ush") origin
 * HEAD:main'` moved main for real, past BOTH round-3 triggers at once. "g?t"
 * is a shell GLOB (a single-char wildcard matched against actual files in
 * `/usr/bin`) that only becomes the literal word "git" once bash RUNS the
 * alias — the wrapper's own string scan sees "g?t", never "git" — and
 * `$(printf "\160ush")` computes the string "push" from an OCTAL escape at
 * runtime inside a command substitution, so after stripping the scan's
 * quote/expansion characters the leftover text is "printf 160ush", which
 * contains neither "push" nor "git" as a literal substring.
 *
 * The fix: every `!` alias is refused OUTRIGHT now, unconditionally, with no
 * text inspection of any kind — see credentials.ts's studioGitWrapperScript
 * for the full reasoning (globbing is one obfuscation of arbitrarily many;
 * hex/octal/base64 encoding, variable indirection, eval and `printf %b` can
 * each hide any substring a scan might look for).
 */
LANE("every '!' shell alias is refused outright, with no text inspection at all — maestro review, X1 (issue #310)", () => {
  test("the glob+octal alias really does reach a real push when git resolves it directly — the bypass this closes is real", () => {
    const f = setup();
    // The glob needs a real directory listing to match against: git's own
    // binary directory, which really does contain a file named exactly
    // "git" (three letters) for "g?t" (one wildcard char) to match.
    const gitDir = dirname(REAL_GIT as string);
    realGit(f, ["config", "alias.p", `!${gitDir}/g?t $(printf "\\160ush") origin HEAD:${f.def}`]);
    commit(f);
    const before = originState(f);

    // The REAL git, deliberately, resolving its own alias with no wrapper in
    // the way: proof the glob+octal spelling really does reach a real
    // "git push", not merely that a text scan cannot see it.
    realGit(f, ["p"]);
    expect(originState(f)).not.toEqual(before);
  });

  test("the same glob+octal alias is refused by the wrapper, unconditionally, and nothing moves", () => {
    const f = setup();
    const gitDir = dirname(REAL_GIT as string);
    realGit(f, ["config", "alias.p", `!${gitDir}/g?t $(printf "\\160ush") origin HEAD:${f.def}`]);
    commit(f);
    const before = originState(f);

    const r = git(f, ["p"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_SHELL_ALIAS_REFUSAL);
    expect(originState(f)).toEqual(before);
  });

  test("a totally harmless '!' alias is refused too — there is no text scope left to spare it", () => {
    const f = setup();
    realGit(f, ["config", "alias.noop", "!true"]);
    commit(f);

    expectAliasRefused(git(f, ["noop"]));
  });
});

/**
 * Group 12 — the same maestro review round, item X2 (issue #310, HIGH):
 * round 3's default-branch resolution (`ls-remote --symref origin HEAD`, and
 * its local-symref and `remote show` fallbacks) is HARDCODED to the remote
 * literally named "origin". Measured, git 2.34.1:
 *
 *   git remote rename origin up
 *   git remote add origin <decoy repo whose HEAD is a branch called "decoy">
 *   git push up HEAD:main
 *
 * moves the REAL main, on the remote now named "up" (still the real repo —
 * only its NAME changed), for real. After the rename, "origin" points at
 * attacker-controlled decoy content whose HEAD is a branch called "decoy",
 * so a hardcoded `ls-remote --symref origin HEAD` never finds "main" among
 * its answers, and a push to "up HEAD:main" is never recognized as touching
 * a default branch at all.
 *
 * The fix: the default branch is resolved from the push's OWN target
 * repository (parsed out of the push subcommand's own argv), never a
 * hardcoded "origin" — see credentials.ts's studioGitWrapperScript for the
 * full reasoning, including why the local-symref and `remote show` fallbacks
 * moved to the same target too.
 */
LANE("the default branch resolves from the push's OWN target, not a hardcoded 'origin' — maestro review, X2 (issue #310)", () => {
  /** A second bare repo, cloned from origin so it has its own resolvable
   *  default branch, that stands in for the decoy: its own HEAD points at a
   *  branch named "decoy" rather than the real default. */
  function decoyOrigin(f: Fixture): string {
    const decoy = join(f.root, "decoy-origin.git");
    realGit(f, ["clone", "-q", "--bare", f.origin, decoy], f.root);
    // "decoy" needs an actual commit, not merely a symref pointed at an
    // unborn branch: "ls-remote --symref" reports NOTHING at all for a
    // branch with no commit (measured), which would accidentally hide this
    // bug's shape rather than demonstrate it.
    realGit(f, ["branch", "decoy", `refs/heads/${f.def}`], decoy);
    realGit(f, ["symbolic-ref", "HEAD", "refs/heads/decoy"], decoy);
    return decoy;
  }

  test("real git really does move the real main through the rename+decoy trick — the bypass this closes is real", () => {
    const f = setup();
    const decoy = decoyOrigin(f);
    realGit(f, ["remote", "rename", "origin", "up"]);
    realGit(f, ["remote", "add", "origin", decoy]);
    commit(f);
    const before = originState(f);

    // The REAL git, deliberately: proof the rename+decoy trick really does
    // reach the real default branch when nothing resolves it from the actual
    // push target — not merely that a hardcoded "origin" lookup would miss
    // it.
    realGit(f, ["push", "up", `HEAD:${f.def}`]);
    expect(originState(f)).not.toEqual(before);
  });

  test("the wrapper refuses the same rename+decoy push, and nothing moves", () => {
    const f = setup();
    const decoy = decoyOrigin(f);
    realGit(f, ["remote", "rename", "origin", "up"]);
    realGit(f, ["remote", "add", "origin", decoy]);
    commit(f);
    const before = originState(f);

    expectRefused(git(f, ["push", "up", `HEAD:${f.def}`]));
    expect(originState(f)).toEqual(before);
  });

  test("a push to an UNRELATED branch on the decoy still goes through — the fix does not overprotect", () => {
    const f = setup();
    const decoy = decoyOrigin(f);
    realGit(f, ["remote", "rename", "origin", "up"]);
    realGit(f, ["remote", "add", "origin", decoy]);
    realGit(f, ["checkout", "-q", "-b", "feature/decoy-side"]);
    commit(f);

    // Neither "up"'s default (f.def) nor "origin" (the decoy)'s own resolved
    // default ("decoy", set by decoyOrigin) — an ordinary feature push to
    // the decoy remote is unaffected by any of this.
    const r = git(f, ["push", "origin", "HEAD:feature/decoy-side"]);
    expect(r.code).toBe(0);
  });

  test("a push by URL to the renamed remote is refused too — target resolution is not name-only", () => {
    const f = setup();
    realGit(f, ["remote", "rename", "origin", "up"]);
    commit(f);
    const before = originState(f);

    expectRefused(git(f, ["push", f.origin, `HEAD:${f.def}`]));
    expect(originState(f)).toEqual(before);
  });
});

/**
 * Group 13 — maestro review round 2 of PR #319 (issue #310): the push target
 * is whatever GIT picks, not what the argv names. Measured in docker (git
 * 2.43), each of these moved the real default branch through the round-1
 * wrapper, which parsed the positional argv and fell back to "origin":
 *   X3  rename origin -> up, decoy "origin", bare `git push` (branch remote up)
 *   X4  same, `git push --repo=up` / `--repo up`
 *   X5  same, `remote.pushDefault=up`, bare `git push`
 *   X6  pushurl = real, url = decoy (ls-remote reads the FETCH url)
 *   X7  url = decoy, url.<real>.pushInsteadOf = <decoy>
 * The wrapper now takes the destination from the dry-run probe's own
 * `To <url>` line and asks THAT url for its HEAD.
 */
LANE("the push destination comes from the probe's `To <url>`, never the argv — maestro review round 2, X3-X7 (issue #310)", () => {
  function decoyRepo(f: Fixture): string {
    const decoy = join(f.root, "decoy.git");
    realGit(f, ["clone", "-q", "--bare", f.origin, decoy], f.root);
    realGit(f, ["branch", "decoy", `refs/heads/${f.def}`], decoy);
    realGit(f, ["symbolic-ref", "HEAD", "refs/heads/decoy"], decoy);
    return decoy;
  }
  /** Rename the real remote to "up" and put a decoy where "origin" was. */
  function renamed(f: Fixture): void {
    const decoy = decoyRepo(f);
    realGit(f, ["remote", "rename", "origin", "up"]);
    realGit(f, ["remote", "add", "origin", decoy]);
    realGit(f, ["fetch", "-q", "origin"]);
  }

  const cases: { name: string; arrange: (f: Fixture) => void; push: string[] }[] = [
    { name: "X3 bare `git push`, branch remote is the renamed real one", arrange: renamed, push: ["push"] },
    { name: "X4 `git push --repo=up`", arrange: renamed, push: ["push", "--repo=up"] },
    { name: "X4b `git push --repo up`", arrange: renamed, push: ["push", "--repo", "up"] },
    {
      name: "X5 remote.pushDefault=up, bare `git push`",
      arrange: (f) => {
        renamed(f);
        realGit(f, ["config", `branch.${f.def}.remote`, "origin"]);
        realGit(f, ["config", "remote.pushDefault", "up"]);
      },
      push: ["push"],
    },
    {
      name: "X6 pushurl = real, url = decoy, set-head at the decoy",
      arrange: (f) => {
        const decoy = decoyRepo(f);
        realGit(f, ["remote", "set-url", "origin", decoy]);
        realGit(f, ["remote", "set-url", "--push", "origin", f.origin]);
        realGit(f, ["fetch", "-q", "origin"]);
        realGit(f, ["remote", "set-head", "origin", "decoy"]);
      },
      push: ["push", "origin", "HEAD:__DEF__"],
    },
    {
      name: "X7 url = decoy, pushInsteadOf rewrites it to the real repo",
      arrange: (f) => {
        const decoy = decoyRepo(f);
        realGit(f, ["remote", "set-url", "origin", decoy]);
        realGit(f, ["config", `url.${f.origin}.pushInsteadOf`, decoy]);
        realGit(f, ["fetch", "-q", "origin"]);
        realGit(f, ["remote", "set-head", "origin", "decoy"]);
      },
      push: ["push", "origin", "HEAD:__DEF__"],
    },
    {
      name: "two push urls, the decoy first and the real repo second",
      arrange: (f) => {
        const decoy = decoyRepo(f);
        realGit(f, ["remote", "set-url", "--push", "origin", decoy]);
        realGit(f, ["remote", "set-url", "--add", "--push", "origin", f.origin]);
      },
      push: ["push", "origin", "HEAD:__DEF__"],
    },
  ];
  const argv = (f: Fixture, push: string[]) => push.map((a) => a.replace("__DEF__", f.def));

  for (const c of cases) {
    test(`${c.name}: real git DOES move the default branch — the bypass is real`, () => {
      const f = setup();
      c.arrange(f);
      commit(f);
      const before = originState(f);
      realGit(f, argv(f, c.push));
      expect(originState(f)).not.toEqual(before);
    });

    test(`${c.name}: the wrapper refuses it, and nothing moves`, () => {
      const f = setup();
      c.arrange(f);
      commit(f);
      const before = originState(f);
      expectRefused(git(f, argv(f, c.push)));
      expect(originState(f)).toEqual(before);
    });
  }

  test("a feature push through the same renamed setup still goes through — no overprotection", () => {
    const f = setup();
    renamed(f);
    realGit(f, ["checkout", "-q", "-b", "feature/x3"]);
    commit(f);
    expect(git(f, ["push", "up", "HEAD:refs/heads/feature/x3"]).code).toBe(0);
  });

  // Addendum: an unresolvable remote HEAD refuses only what could be the
  // default -- an EXISTING ref moving. A plain new branch to a fresh, empty
  // remote passes.
  test("a feature push to a FRESH EMPTY remote (no HEAD to resolve) goes through", () => {
    const f = setup();
    const fresh = join(f.root, "fresh.git");
    realGit(f, ["init", "-q", "--bare", fresh], f.root);
    realGit(f, ["remote", "add", "fresh", fresh]);
    realGit(f, ["checkout", "-q", "-b", "feature/fresh"]);
    commit(f);
    const r = git(f, ["push", "fresh", "HEAD:refs/heads/feature/fresh"]);
    expect(r.code, r.stderr).toBe(0);
    expect(realGit(f, ["ls-remote", fresh]).stdout).toContain("refs/heads/feature/fresh");
  });

  test("the remote HEAD unresolvable: moving an EXISTING branch is refused (it could be the default)", () => {
    const f = setup();
    realGit(f, ["symbolic-ref", "HEAD", "refs/heads/never-existed"], f.origin);
    commit(f);
    const before = originState(f);
    const r = git(f, ["push", "origin", `HEAD:${f.def}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(STUDIO_PUSH_UNRESOLVED_DEFAULT);
    expect(originState(f)).toEqual(before);
  });
});

/**
 * Group 14 — issue #344 (LOW, deliberate evasion): a fetch-side insteadOf
 * makes `ls-remote --symref <url>` ask a DECOY for HEAD while the push itself
 * (the probe's `To <url>`, kept by an identity pushInsteadOf) goes to the
 * real repo. Measured by the #319 round-2 review in docker (git 2.43): the
 * decoy's HEAD is not the real default, so the push was allowed and the real
 * default branch MOVED. The guard now trusts ls-remote only when
 * `ls-remote --get-url -- <url>` names that same url; otherwise (or when
 * ls-remote itself fails) it refuses the default branch and anything
 * ambiguous, and still lets a feature branch through.
 *   N1   repo config: url.<decoy>.insteadOf=<real>, url.<real>.pushInsteadOf=<real>
 *   N1b  the same through a PREFIX rewrite (insteadOf a leading part of <real>)
 *   N3   the same pair passed as `git -c ... -c ... push`
 */
LANE("an insteadOf decoy cannot make ls-remote answer for another repo (issue #344)", () => {
  function decoyRepo(f: Fixture): string {
    const decoy = join(f.root, "decoy.git");
    realGit(f, ["clone", "-q", "--bare", f.origin, decoy], f.root);
    realGit(f, ["branch", "decoy", `refs/heads/${f.def}`], decoy);
    realGit(f, ["symbolic-ref", "HEAD", "refs/heads/decoy"], decoy);
    return decoy;
  }
  const n1 = (f: Fixture) => {
    const decoy = decoyRepo(f);
    realGit(f, ["config", `url.${decoy}.insteadOf`, f.origin]);
    realGit(f, ["config", `url.${f.origin}.pushInsteadOf`, f.origin]);
  };
  const n1b = (f: Fixture) => {
    decoyRepo(f);
    // f.origin is <root>/origin.git: rewrite its LEADING part only.
    realGit(f, ["config", `url.${join(f.root, "decoy")}.insteadOf`, join(f.root, "origin")]);
    realGit(f, ["config", `url.${f.origin}.pushInsteadOf`, f.origin]);
  };
  const n3flags = (f: Fixture) => {
    const decoy = decoyRepo(f);
    return ["-c", `url.${decoy}.insteadOf=${f.origin}`, "-c", `url.${f.origin}.pushInsteadOf=${f.origin}`];
  };

  const cases: { name: string; argv: (f: Fixture) => string[] }[] = [
    { name: "N1 repo-config insteadOf decoy + identity pushInsteadOf", argv: (f) => { n1(f); return ["push", "origin", `HEAD:${f.def}`]; } },
    { name: "N1b prefix insteadOf decoy + identity pushInsteadOf", argv: (f) => { n1b(f); return ["push", "origin", `HEAD:${f.def}`]; } },
    { name: "N3 the same pair as `git -c ... push`", argv: (f) => [...n3flags(f), "push", "origin", `HEAD:${f.def}`] },
  ];

  for (const c of cases) {
    test(`${c.name}: real git DOES move the default branch — the bypass is real`, () => {
      const f = setup();
      const argv = c.argv(f);
      commit(f);
      const before = originState(f);
      realGit(f, argv);
      expect(originState(f)).not.toEqual(before);
    });

    test(`${c.name}: the wrapper refuses it, and nothing moves`, () => {
      const f = setup();
      const argv = c.argv(f);
      commit(f);
      const before = originState(f);
      const r = git(f, argv);
      expect(r.code, r.stderr).not.toBe(0);
      expect(originState(f)).toEqual(before);
    });
  }

  // #355 review: the untrusted path's candidate lookup (init.defaultBranch,
  // refs/remotes/*/HEAD) must read the repo the push targets — the caller's
  // -C / --git-dir / --work-tree — never the wrapper's own cwd. Run from
  // OUTSIDE the clone, the round-1 lookup read nothing and trunk moved.
  const outside: { name: string; flags: (f: Fixture) => string[] }[] = [
    { name: "-C <clone>", flags: (f) => ["-C", f.clone] },
    { name: "--git-dir/--work-tree", flags: (f) => [`--git-dir=${join(f.clone, ".git")}`, `--work-tree=${f.clone}`] },
  ];
  for (const o of outside) {
    test(`N1 decoy + \`git ${o.name} push\` run from OUTSIDE the clone: refused, nothing moves`, () => {
      const f = setup();
      n1(f);
      commit(f);
      const before = originState(f);
      const r = git(f, [...o.flags(f), "push", "origin", `HEAD:${f.def}`], f.root);
      expect(r.code, r.stderr).not.toBe(0);
      expect(originState(f)).toEqual(before);
    });
  }

  test("under the same N1 decoy, UPDATING an existing feature branch still goes through", () => {
    const f = setup();
    realGit(f, ["checkout", "-q", "-b", "feature/n1"]);
    commit(f, "a.txt");
    realGit(f, ["push", "-q", "origin", "HEAD:refs/heads/feature/n1"]);
    n1(f);
    commit(f, "b.txt");
    const r = git(f, ["push", "origin", "HEAD:refs/heads/feature/n1"]);
    expect(r.code, r.stderr).toBe(0);
  });

  test("ls-remote itself FAILING does not refuse a feature-branch update, only the default branch", () => {
    const f = setup();
    realGit(f, ["checkout", "-q", "-b", "feature/lsr"]);
    commit(f, "a.txt");
    realGit(f, ["push", "-q", "origin", "HEAD:refs/heads/feature/lsr"]);
    // Fetch-side rewrite to a path that does not exist: ls-remote fails, the
    // push (kept on the real url by pushInsteadOf) still works.
    realGit(f, ["config", `url.${join(f.root, "gone.git")}.insteadOf`, f.origin]);
    realGit(f, ["config", `url.${f.origin}.pushInsteadOf`, f.origin]);
    commit(f, "b.txt");
    const feature = git(f, ["push", "origin", "HEAD:refs/heads/feature/lsr"]);
    expect(feature.code, feature.stderr).toBe(0);
    const before = originState(f);
    const def = git(f, ["push", "origin", `HEAD:${f.def}`]);
    expect(def.code).not.toBe(0);
    expect(originState(f)).toEqual(before);
  });
});

/**
 * Group 15 — issue #353. Board text described a `defaults=()` bash array and
 * an unconditional "cannot resolve the remote's default branch" refusal on
 * EVERY push to a genuinely empty bare repo (init --bare, zero refs, zero
 * commits), including the very first push that could not possibly move any
 * branch that does not yet exist. That shape of bug does not exist in this
 * wrapper's CURRENT script: it belongs to the pre-#310 design that resolved
 * ONE default up front and refused outright when nothing named it. #310
 * replaced that with the PER-URL, PER-REF loop above (Group 13), which reads
 * `<flag>` off the probe's own porcelain output rather than pre-computing a
 * yes/no "is this safe" verdict: a genuinely empty remote can only ever
 * produce brand-new-ref ("*") lines, since nothing exists there yet to
 * fast-forward, force, or delete, so `elif [ "$flag" != '*' ]` already lets
 * every one of them through — with no separate "is the remote empty" check
 * needed, and nothing here to fix.
 *
 * These two tests exist to PIN that: one exercising #353's literal scenario
 * (a `git init --bare` remote with zero refs at all, verified by `ls-remote`
 * printing nothing, pushed for the very first time under the branch name
 * that would become its default), and one exercising the case #353 asked to
 * keep refused — a remote with SOME refs already but an unresolvable default
 * — in the SAME test as the new-ref case that must stay allowed, so a future
 * change cannot quietly re-merge the two. Both were already green against
 * this file's HEAD before this commit (confirmed by running them against the
 * unmodified wrapper); the mutant-style proof in this issue's own PR
 * description is what shows they are load-bearing rather than decorative.
 */
LANE("issue #353 — a genuinely empty remote's very first push, and its non-empty-but-unresolvable cousin", () => {
  test("the literal first-ever push to a brand-new `git init --bare` remote succeeds, even under the name a default would take", () => {
    const f = setup();
    const bare = join(f.root, "brand-new.git");
    realGit(f, ["init", "-q", "--bare", bare], f.root);
    // Not just claimed empty: DEMONSTRATED empty, the same way the wrapper's
    // own `ls-remote --symref` sees it -- zero refs, so no output at all.
    expect(realGit(f, ["ls-remote", bare]).stdout).toBe("");
    realGit(f, ["remote", "add", "brandnew", bare]);

    // Pushed under f.def's own name (e.g. "trunk") on purpose: the branch
    // this push creates is exactly the one a later push would have to guard,
    // and there is nothing yet on `bare` for it to be confused with.
    const r = git(f, ["push", "brandnew", `HEAD:refs/heads/${f.def}`]);

    expect(r.code, r.stderr).toBe(0);
    expect(realGit(f, ["ls-remote", bare]).stdout).toContain(`refs/heads/${f.def}`);
  });

  test("a remote with SOME refs but an unresolvable default: an EXISTING ref move is refused, a brand-new ref still goes through", () => {
    const f = setup();
    realGit(f, ["symbolic-ref", "HEAD", "refs/heads/never-existed"], f.origin);
    commit(f);
    const before = originState(f);

    // The existing default-shaped branch: refused exactly as Group 13 above.
    const existing = git(f, ["push", "origin", `HEAD:${f.def}`]);
    expect(existing.code).toBe(1);
    expect(existing.stderr).toContain(STUDIO_PUSH_UNRESOLVED_DEFAULT);
    expect(originState(f)).toEqual(before);

    // The SAME remote, the SAME unresolvable HEAD, a brand-new branch name:
    // nothing existing can be "moved" by creating a ref that never existed,
    // so this one goes through.
    realGit(f, ["checkout", "-q", "-b", "feature/new-353"]);
    const r = git(f, ["push", "origin", "feature/new-353"]);
    expect(r.code, r.stderr).toBe(0);
    expect(originRefs(f)).toContain("refs/heads/feature/new-353");
  });
});

/**
 * Issue #1 — the LEAK GATE on push. The repo is public, so a push carrying a
 * denylisted term (commit metadata, message, added line, new path, pushed ref
 * name) is refused before the real git runs. Fail closed: no gate file, a
 * bad pattern, a missing scanner each refuse. `acmeclient` stands in for a
 * private term.
 */
LANE("the fleet git wrapper runs the leak gate on every push (issue #1)", () => {
  const TERM = "acmeclient";

  /** A leak-gated fixture on a fresh feature branch. */
  function gated(): Fixture {
    const f = setup();
    writeGate(f, { patterns: ["fleet-harmless-999999999", TERM] });
    realGit(f, ["checkout", "-q", "-b", "feature"]);
    return f;
  }

  function commitWith(f: Fixture, file: string, content: string, message: string): void {
    writeFileSync(join(f.clone, file), content);
    realGit(f, ["add", "-A"]);
    realGit(f, ["commit", "-q", "-m", message]);
  }

  function pushFeature(f: Fixture): Run {
    return git(f, ["push", "origin", "HEAD:refs/heads/feature"]);
  }

  function expectLeakRefused(f: Fixture, r: Run, before: string[]): void {
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_LEAK_REFUSAL);
    expect(r.stderr.toLowerCase()).not.toContain(TERM);
    expect(originState(f)).toEqual(before);
  }

  function expectLanded(f: Fixture, r: Run): void {
    expect(r.code, r.stderr).toBe(0);
    const head = realGit(f, ["rev-parse", "HEAD"]).stdout.trim();
    expect(originState(f)).toContain(`refs/heads/feature ${head}`);
  }

  test("a hit in the commit MESSAGE is refused, pattern index only (mutant: hit found but push allowed)", () => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", `work for ${TERM.toUpperCase()}`);
    const before = originState(f);

    const r = pushFeature(f);

    expectLeakRefused(f, r, before);
    expect(r.stderr).toContain("#2");
  });

  test("a hit in an ADDED line is refused", () => {
    const f = gated();
    commitWith(f, "a.txt", `notes about ${TERM}\n`, "clean message");
    const before = originState(f);
    expectLeakRefused(f, pushFeature(f), before);
  });

  test("a hit in a NEW file path is refused", () => {
    const f = gated();
    commitWith(f, `${TERM}-notes.txt`, "clean\n", "clean message");
    const before = originState(f);
    expectLeakRefused(f, pushFeature(f), before);
  });

  test("a hit in an EMPTY new file's path is refused (no +++ line in its diff)", () => {
    const f = gated();
    commitWith(f, `${TERM}.txt`, "", "clean message");
    const before = originState(f);
    expectLeakRefused(f, pushFeature(f), before);
  });

  test("a hit in the author identity is refused", () => {
    const f = gated();
    writeFileSync(join(f.clone, "a.txt"), "clean\n");
    realGit(f, ["add", "-A"]);
    realGit(f, ["-c", `user.name=x`, "commit", "-q", "-m", "clean", `--author=Someone <someone@${TERM}.example>`]);
    const before = originState(f);
    expectLeakRefused(f, pushFeature(f), before);
  });

  test("a hit in the pushed BRANCH NAME is refused", () => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    const before = originState(f);
    expectLeakRefused(f, git(f, ["push", "origin", `HEAD:refs/heads/fix-${TERM}`]), before);
  });

  test("a clean push is allowed and lands", () => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    expectLanded(f, pushFeature(f));
  });

  test("a term only in a commit ALREADY on the remote does not block a new clean commit (mutant: no exclusion)", () => {
    const f = gated();
    commitWith(f, "old.txt", `${TERM}\n`, `old ${TERM} work`);
    // Landed before the gate existed: pushed with the REAL git.
    realGit(f, ["push", "-q", "origin", "HEAD:refs/heads/feature"]);
    commitWith(f, "a.txt", "clean\n", "clean message");
    expectLanded(f, pushFeature(f));
  });

  test("a REMOVED line containing the term is allowed", () => {
    const f = gated();
    commitWith(f, "old.txt", `keep\n${TERM}\n`, "old work");
    realGit(f, ["push", "-q", "origin", "HEAD:refs/heads/feature"]);
    commitWith(f, "old.txt", "keep\n", "scrub");
    expectLanded(f, pushFeature(f));
  });

  test("gate file MISSING refuses a clean push (mutant: denylist missing reads as a pass)", () => {
    const f = gated();
    rmSync(f.gate);
    commitWith(f, "a.txt", "clean\n", "clean message");
    const before = originState(f);
    expectLeakRefused(f, pushFeature(f), before);
  });

  test("an INVALID pattern refuses a clean push (mutant: scanner errors swallowed)", () => {
    const f = gated();
    writeGate(f, { patterns: ["("] });
    commitWith(f, "a.txt", "clean\n", "clean message");
    const before = originState(f);
    expectLeakRefused(f, pushFeature(f), before);
  });

  test("the scanner binary MISSING refuses a clean push", () => {
    const f = gated();
    rmSync(f.scan);
    commitWith(f, "a.txt", "clean\n", "clean message");
    const before = originState(f);
    expectLeakRefused(f, pushFeature(f), before);
  });

  test("a FAILING history read refuses a clean push (mutant: pipefail dropped, log error swallowed)", () => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    const before = originState(f);
    // Measured, git 2.50: a bad log.date fails `git log` (128) but not the push probe.
    expectLeakRefused(f, git(f, ["-c", "log.date=bogus", "push", "origin", "HEAD:refs/heads/feature"]), before);
  });

  test("gate `off` lets a hit through", () => {
    const f = gated();
    writeGate(f, { off: "work repo is private" });
    commitWith(f, "a.txt", `${TERM}\n`, `work for ${TERM}`);
    expectLanded(f, pushFeature(f));
  });

  test("a hit in an ANNOTATED TAG's message is refused (mutant: tag object text unscanned)", () => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    realGit(f, ["tag", "-a", "v1", "-m", `release for ${TERM}`]);
    const before = originState(f);
    expectLeakRefused(f, git(f, ["push", "origin", "v1"]), before);
  });

  test("a hit in a NESTED annotated tag (tag of a tag) is refused", () => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    realGit(f, ["tag", "-a", "inner", "-m", `inner ${TERM}`]);
    realGit(f, ["tag", "-a", "outer", "-m", "outer clean", "inner"]);
    const before = originState(f);
    expectLeakRefused(f, git(f, ["push", "origin", "refs/tags/outer"]), before);
  });

  test("a hit in the tagger identity is refused, even when the tagged commit is already on the remote", () => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    realGit(f, ["push", "-q", "origin", "HEAD:refs/heads/feature"]);
    // The tagger ident comes from GIT_COMMITTER_*, which the fixture env pins.
    const t = run([REAL_GIT as string, "tag", "-a", "v2", "-m", "clean"], f.clone,
      { ...f.env, GIT_COMMITTER_EMAIL: `x@${TERM}.example` });
    expect(t.code, t.stderr).toBe(0);
    const before = originState(f);
    expectLeakRefused(f, git(f, ["push", "origin", "v2"]), before);
  });

  test("a clean annotated tag is allowed and lands", () => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    realGit(f, ["tag", "-a", "v3", "-m", "clean release"]);
    const r = git(f, ["push", "origin", "v3"]);
    expect(r.code, r.stderr).toBe(0);
    expect(originRefs(f)).toContain("refs/tags/v3");
  });

  test("a NON-ASCII term in a new path is refused (mutant: core.quotePath octal-escapes it)", () => {
    const f = setup();
    const U = "acme\u00e7\u00e3o";
    writeGate(f, { patterns: ["fleet-harmless-999999999", U] });
    realGit(f, ["checkout", "-q", "-b", "feature"]);
    commitWith(f, `${U}.txt`, "", "clean message");
    const before = originState(f);
    const r = pushFeature(f);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_LEAK_REFUSAL);
    expect(originState(f)).toEqual(before);
  });

  test.each([
    ["-o", (t: string) => ["-o", `note=${t}`]],
    ["--push-option=", (t: string) => [`--push-option=note ${t}`]],
    ["--push-option <v>", (t: string) => ["--push-option", `note ${t}`]],
  ])("a hit in a push option (%s) is refused (mutant: push options unscanned)", (_n, opt) => {
    const f = gated();
    realGit(f, ["-C", f.origin, "config", "receive.advertisePushOptions", "true"], f.origin);
    commitWith(f, "a.txt", "clean\n", "clean message");
    const before = originState(f);
    expectLeakRefused(f, git(f, ["push", ...opt(TERM), "origin", "HEAD:refs/heads/feature"]), before);
  });

  test("a hit in a push.pushOption config value is refused", () => {
    const f = gated();
    realGit(f, ["-C", f.origin, "config", "receive.advertisePushOptions", "true"], f.origin);
    commitWith(f, "a.txt", "clean\n", "clean message");
    const before = originState(f);
    expectLeakRefused(f, git(f, ["-c", `push.pushOption=note ${TERM}`, "push", "origin", "HEAD:refs/heads/feature"]), before);
  });

  test("a clean push option is allowed and lands", () => {
    const f = gated();
    realGit(f, ["-C", f.origin, "config", "receive.advertisePushOptions", "true"], f.origin);
    commitWith(f, "a.txt", "clean\n", "clean message");
    expectLanded(f, git(f, ["push", "-o", "ci.skip", "origin", "HEAD:refs/heads/feature"]));
  });

  test.each([
    ["--recurse-submodules=on-demand", [], ["--recurse-submodules=on-demand"]],
    ["--recurse-submodules=only", [], ["--recurse-submodules=only"]],
    ["--recurse-submodules on-demand", [], ["--recurse-submodules", "on-demand"]],
    ["abbreviated --recurse=on-demand", [], ["--recurse=on-demand"]],
    ["check then on-demand (last wins)", [], ["--recurse-submodules=check", "--recurse-submodules=on-demand"]],
    ["config push.recurseSubmodules=on-demand", ["-c", "push.recurseSubmodules=on-demand"], []],
    ["config push.recurseSubmodules=only", ["-c", "push.recurseSubmodules=only"], []],
    ["config submodule.recurse=true", ["-c", "submodule.recurse=true"], []],
  ])("a submodule-recursing push (%s) is refused, nothing moves (mutant: submodule commits pushed unscanned)", (_n, g, a) => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    const before = originState(f);
    const r = git(f, [...(g as string[]), "push", ...(a as string[]), "origin", "HEAD:refs/heads/feature"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(STUDIO_PUSH_SUBMODULE_REFUSAL);
    expect(originState(f)).toEqual(before);
  });

  test.each([
    ["--recurse-submodules=check", [], ["--recurse-submodules=check"]],
    ["--no-recurse-submodules", [], ["--no-recurse-submodules"]],
    ["on-demand then no (last wins)", [], ["--recurse-submodules=on-demand", "--recurse-submodules=no"]],
    ["config push.recurseSubmodules=check", ["-c", "push.recurseSubmodules=check"], []],
    ["submodule.recurse=true overridden by --recurse-submodules=check", ["-c", "submodule.recurse=true"], ["--recurse-submodules=check"]],
  ])("a non-recursing push (%s) is allowed and lands", (_n, g, a) => {
    const f = gated();
    commitWith(f, "a.txt", "clean\n", "clean message");
    expectLanded(f, git(f, [...(g as string[]), "push", ...(a as string[]), "origin", "HEAD:refs/heads/feature"]));
  });

  test("nothing to push is handed over without a scan, even with no gate file", () => {
    const f = gated();
    rmSync(f.gate);
    realGit(f, ["checkout", "-q", f.def]);
    const r = git(f, ["push", "origin", f.def]);
    expect(r.code, r.stderr).toBe(0);
  });
});
