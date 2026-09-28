import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUDIO_GIT_WRAPPER_PATH, STUDIO_REAL_GIT_PATH } from "../../src/studio/credentials";

/**
 * Issue #353 round 2 -- a `bun test` preload (wired up by ../../bunfig.toml's
 * `[test]` section), loaded once before any test file is evaluated. Fixes a
 * TEST HARNESS bug, not a product one: `studioGitWrapperScript()` /
 * `studioGitSafetyCmd()` (credentials.ts) are only ever read here, for their
 * two well-known path constants, and are never modified by this file.
 *
 * THE BUG THIS CLOSES. Every real-git fixture in test/bun (git-wrapper.test.ts,
 * localci-run.test.ts, memory-clone.test.ts, ...) resolves "the real git" via
 * `Bun.which("git")` or a bare `git` word on the CURRENT process's own PATH.
 * On a dev machine, or in ordinary CI, that word IS genuine git. Inside a
 * real studio container it is NOT: this repo's own #253 safety wrapper is
 * installed at STUDIO_GIT_WRAPPER_PATH, deliberately AHEAD of
 * STUDIO_REAL_GIT_PATH on PATH -- that ordering is the entire mechanism
 * #253/#259 built, not an accident. So inside a studio, every one of those
 * fixtures silently gets the wrapper standing in for "real git", and the
 * wrapper does exactly what it is supposed to do: it refuses pushes several
 * of those fixtures make to their own throwaway "main"/"trunk" branches
 * (which look, from the wrapper's point of view, exactly like a push at a
 * real default branch, because that is what the fixture told it to do).
 * Measured (see the #353 plan doc's round-2 update): 13 failures, none of
 * them a product bug -- 10 `git-wrapper.test.ts` "bypass is real" CONTROL
 * tests that need a genuinely unwrapped git to demonstrate a bypass working
 * at all, plus 3 fixture pushes elsewhere that the wrapper correctly, but
 * unhelpfully, refused.
 *
 * THE FIX. Detect whether STUDIO_GIT_WRAPPER_PATH is actually this repo's own
 * wrapper (its generated header names itself unambiguously -- see the marker
 * below, lifted from credentials.ts's studioGitWrapperScript() verbatim, not
 * guessed). If it is: symlink a `git` in a fresh temp directory straight at
 * STUDIO_REAL_GIT_PATH -- the exact absolute path the wrapper itself execs
 * for everything that is not a refused push -- and PREPEND that temp
 * directory to `process.env.PATH`. Every later `Bun.which("git")` / bare
 * `git` call in this same process that does not scope its OWN PATH now
 * resolves to genuine git instead. If STUDIO_GIT_WRAPPER_PATH does not exist,
 * or exists but is not this wrapper (a dev machine's own real git can live at
 * the same path on some systems), this is a straight no-op: PATH is left
 * exactly as it already was.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH. `git-wrapper.test.ts`'s own fixtures
 * build and install a WRAPPER COPY of their own, on a PATH they scope
 * themselves (`PATH: \`${bin}:...\``, see that file's `setup()`) specifically
 * to exercise the wrapper's behavior on purpose. This preload only ever
 * PREPENDS to `process.env.PATH` -- it never removes or reorders anything
 * already there -- so a fixture's own `bin:` entry stays first in ITS scoped
 * PATH string regardless of what this preload already did to the outer
 * process's PATH before that string was built. `REAL_GIT` in
 * git-wrapper.test.ts is `Bun.which("git")` evaluated at module load, i.e.
 * AFTER this preload has already run, so it resolves to the same genuine git
 * this preload found -- one source of truth, not two.
 */
const WRAPPER_HEADER_MARKER = "fleet: issue #253";

/**
 * Exported (rather than only run as a bare side effect) so
 * real-git-preload.test.ts can drive it against FAKE wrapper/real-git paths
 * -- proving both the "wrapper present" and "no wrapper" branches -- without
 * ever touching this machine's own real STUDIO_GIT_WRAPPER_PATH, which the
 * bottom of this file calls with no arguments (the real, production paths)
 * as its actual preload side effect.
 */
export function fixPathIfStudioWrapperIsAheadOfRealGit(
  wrapperPath: string = STUDIO_GIT_WRAPPER_PATH,
  realGitPath: string = STUDIO_REAL_GIT_PATH,
): void {
  if (!existsSync(wrapperPath)) return; // no wrapper installed at all -- dev machine, plain CI
  let content: string;
  try {
    content = readFileSync(wrapperPath, "utf8");
  } catch {
    return; // unreadable / not a regular text file -- cannot be our wrapper, leave PATH alone
  }
  if (!content.includes(WRAPPER_HEADER_MARKER)) return; // something else lives at this path -- not our wrapper
  if (!existsSync(realGitPath)) return; // nothing genuine to fall back to -- no-op rather than break the run

  const shimDir = mkdtempSync(join(tmpdir(), "fleet-real-git-shim-"));
  symlinkSync(realGitPath, join(shimDir, "git"));
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  // This preload runs once, outside any test's own scope, so there is no
  // per-test afterEach/afterAll to hook into -- the same `process.on("exit",
  // ...)` convention cli/fleet.ts already uses for its own process-lifetime
  // cleanup is the closest fit here.
  process.on("exit", () => {
    rmSync(shimDir, { recursive: true, force: true });
  });
}

fixPathIfStudioWrapperIsAheadOfRealGit();
