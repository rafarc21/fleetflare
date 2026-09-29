import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  rescuePushCmd, rescueSnapshotCmd, RESCUE_CLEAN, RESCUE_MARKERS_ONLY, RESCUE_PUSHED_PREFIX, RESCUE_FAILED_PREFIX,
  RESCUE_NO_CHECKOUT, RESCUE_PUSH_TIMEOUT_SECONDS, RESCUE_SERVER_DEADLINE_SECONDS, RESCUE_BUDGET_MARGIN_SECONDS,
} from "../../src/studio/rescue";
import { discoverRescueRefsCmd } from "../../src/studio/provision";
import { KILL_GRACE_SECONDS } from "../../src/studio/exec-deadline";

/**
 * Issue #217, measured 2026-09-24: origin/fleet/rescue/demosite-life--release-studio-20260924211846
 * held ONE commit whose whole diff was a `.claude/worktrees/agent-…` line —
 * Claude Code's worktree, a nested git worktree that `git add -A` records as
 * a gitlink. A rescue of nothing but that is noise that looks like salvage.
 *
 * Real git, a real origin, and a real nested worktree where Claude Code puts
 * one; rescuePushCmd runs exactly as the Worker ships it, rooted in a temp dir.
 */
const REPO = "fleetflare";
const STUDIO = "fleetflare--pilot";

/**
 * PR #359 round 2 (fresh review, blocker 1): every `git push` in rescue.ts
 * now runs under coreutils `timeout -k ...` (issue #359 round 3, see
 * rescue.ts's own header comment) — a GNU binary macOS does not ship by that
 * name (BSD userland; `brew install coreutils` installs it as `gtimeout`
 * instead). Every test in this file that reaches an actual `git push` (most
 * of them) shells out to that hardcoded `timeout` string, so without a shim
 * this whole file's real-git suite fails on a Mac dev machine with "timeout:
 * command not found" — not a rescue.ts bug (production always runs Linux,
 * where GNU coreutils' `timeout` is standard), a test-fixture gap.
 *
 * Three cases, resolved once at module load and threaded onto every
 * fixture's PATH via `BASE_PATH` below:
 *
 * (a) real `timeout` found directly on PATH — nothing to shim, `TIMEOUT_BIN`
 *     is used as-is and `TIMEOUT_SHIM_DIR` is `null`.
 * (b) `timeout` missing but `gtimeout` found (`brew install coreutils`'s own
 *     naming) — same mechanism test/bun/git-wrapper.test.ts's own header
 *     already established for the identical gap (issue #310,
 *     withKillDeadline's own hardcoded `timeout`): a tiny shim script
 *     literally named `timeout`, `exec`'ing the real `gtimeout` binary found.
 * (c) NEITHER exists (stock macOS: no coreutils installed at all) — PR #359
 *     round 3 review, proven on stock Mac: rather than give up, shim
 *     `timeout` with a small perl script (perl ships with every stock macOS
 *     and virtually every Linux) that reimplements the one `timeout -k
 *     <grace> <secs> <cmd...>` invocation shape rescue.ts's own shell actually
 *     uses — fork, `setpgrp` the child into its own process group so the
 *     whole subtree can be signaled at once, SIGTERM on the outer deadline,
 *     SIGKILL after the grace period if it hasn't exited, exit 124 on a
 *     timeout (matching GNU `timeout`'s own convention) or the child's real
 *     exit status otherwise.
 *
 * Only when not even `perl` is on PATH (case (d) — should never happen on
 * any real Mac or Linux; both ship it) is this genuinely unrecoverable: fail
 * loud, once, right here, instead of 39+ cryptic subprocess failures deep
 * inside individual tests.
 */
const TIMEOUT_BIN = Bun.which("timeout") ?? Bun.which("gtimeout");
const PERL_BIN = Bun.which("perl");
const TIMEOUT_SHIM_DIR = ((): string | null => {
  if (TIMEOUT_BIN !== null && basename(TIMEOUT_BIN) === "timeout") return null;
  if (TIMEOUT_BIN === null && PERL_BIN === null) return null;
  const shimDir = mkdtempSync(join(tmpdir(), "fleet-rescue-timeout-shim-"));
  const shim = join(shimDir, "timeout");
  if (TIMEOUT_BIN !== null) {
    // Case (b): a real `gtimeout` exists, just not spelled `timeout`.
    writeFileSync(shim, `#!/bin/sh\nexec '${TIMEOUT_BIN}' "$@"\n`);
  } else {
    // Case (c): neither `timeout` nor `gtimeout` — reimplement the one
    // invocation shape rescue.ts's shell needs (`timeout -k <grace> <secs>
    // <cmd...>`) in perl, verbatim as proven on stock macOS by the PR #359
    // round 3 review.
    writeFileSync(
      shim,
      `#!${PERL_BIN}\n` +
      `my $k=1; if(@ARGV && $ARGV[0] eq '-k'){shift; $k=shift;}\n` +
      `my $s=shift;\n` +
      `my $pid=fork(); if(!$pid){ setpgrp(0,0); exec @ARGV or exit 127; }\n` +
      `my $t=0;\n` +
      `$SIG{ALRM}=sub{ if(!$t){$t=1; kill 'TERM',-$pid; alarm $k;} else { kill 'KILL',-$pid; } };\n` +
      `alarm $s;\n` +
      `waitpid($pid,0); my $st=$?;\n` +
      `exit 124 if $t; exit($st>>8) unless $st&127; exit 128+($st&127);\n`,
    );
  }
  chmodSync(shim, 0o755);
  return shimDir;
})();
/** Goes FIRST on every fixture's PATH (ahead of the inherited one) so
 *  rescue.ts's hardcoded `timeout` invocation resolves to something real
 *  regardless of which of `timeout`/`gtimeout`/neither/perl-shimmed this host
 *  has. */
const BASE_PATH = `${TIMEOUT_SHIM_DIR ? `${TIMEOUT_SHIM_DIR}:` : ""}${process.env.PATH ?? ""}`;

// Unlike git-wrapper.test.ts's own lane (which skips entirely without a real
// git on PATH), this file has never had a "no real git" escape hatch — a real
// git is assumed always present. The one remaining way this suite can fail to
// even attempt its own real work is "neither timeout/gtimeout NOR perl" —
// should never happen on any real Mac or Linux, but fail loud, once, right
// here, instead of 39+ cryptic subprocess failures deep inside individual
// tests.
if (TIMEOUT_BIN === null && PERL_BIN === null) {
  describe("the fleet rescue-push real-git suite needs GNU coreutils' `timeout`, `gtimeout`, or `perl` (PR #359 round 3 review)", () => {
    test("no `timeout`, `gtimeout`, or `perl` on PATH — every push-bearing test below would otherwise fail with 'command not found'", () => {
      throw new Error(
        "install GNU coreutils (`brew install coreutils` on Mac) or perl to run this suite — " +
        "none of `timeout`, `gtimeout`, or `perl` is on PATH",
      );
    });
  });
}

let dir: string;
let root: string;
let origin: string;
let checkout: string;

function sh(cmd: string, cwd = dir, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], cwd, stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      PATH: BASE_PATH, ...env,
    } });
  // stdout only: it is all the Worker's rescuePush parses (git push talks on stderr).
  return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

beforeEach(() => {
  // Fresh review of PR #359 round 2: on macOS, `/var` (mkdtempSync's own
  // parent, `tmpdir()`) is a SYMLINK to `/private/var` — `realpathSync`
  // collapses that up front, once, so every path derived from `dir` below
  // (root/origin/checkout, every `sh()` cwd) uses the SAME canonical
  // spelling git itself reports from `git worktree list --porcelain`.
  // Without this, the main checkout's own `[ "$w" = "${dir}" ]` skip
  // (rescue.ts's worktree walk) compares two DIFFERENT spellings of the
  // identical path and never matches, so the main checkout gets walked a
  // SECOND time as if it were its own member worktree. A no-op on Linux
  // (this sandbox's own platform — `/tmp` is not a symlink here), so this
  // fix cannot be directly re-measured failing in THIS environment; it is
  // provably safe here (realpath of an already-canonical path returns that
  // same path unchanged) and directly addresses the macOS-specific
  // mechanism the review named.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-rescue-")));
  root = join(dir, "workspace");
  origin = join(dir, "origin.git");
  checkout = join(root, REPO);
  mkdirSync(root, { recursive: true });
  sh(`git init -q --bare -b main ${origin}`);
  sh(`git clone -q ${origin} ${checkout} 2>/dev/null; cd ${checkout} && git commit -q --allow-empty -m init && git push -q origin HEAD:main && git remote set-head origin main`);
  // Claude Code's own worktree layout: a nested worktree inside the checkout.
  sh(`cd ${checkout} && git worktree add -q .claude/worktrees/agent-a1b2 -b agent-a1b2`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rescue(): string {
  return sh(rescuePushCmd(REPO, STUDIO, root)).out;
}

/** Issue #39: stdout minus the per-worktree RESCUE_WT report lines, for the
 *  assertions that pin the overall verdict line exactly. */
function bare(out: string): string {
  return out.split("\n").filter((l) => !l.startsWith("RESCUE_WT ")).join("\n");
}

function rescueRefs(): string[] {
  return sh(`git -C ${origin} for-each-ref --format='%(refname)' refs/heads/fleet/rescue/`).out.split("\n").filter(Boolean);
}

describe("#217 — rescue-push never saves a tool marker as work", () => {
  test("a tree whose only change is Claude Code's .claude/worktrees marker: nothing to rescue, no branch, no commit", () => {
    const before = sh(`git -C ${checkout} rev-parse HEAD`).out;
    expect(sh(`git -C ${checkout} status --porcelain`).out).toContain(".claude/");

    const out = rescue();

    expect(bare(out)).toBe(RESCUE_MARKERS_ONLY);
    expect(rescueRefs()).toEqual([]);
    expect(sh(`git -C ${checkout} rev-parse HEAD`).out).toBe(before);
  });

  test("a real change beside the marker: rescued to a branch that holds the change and NOT the marker", () => {
    writeFileSync(join(checkout, "notes.md"), "real work\n");

    const out = bare(rescue());

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`));
    const [ref] = rescueRefs();
    const files = sh(`git -C ${origin} ls-tree -r --name-only ${ref}`).out.split("\n");
    expect(files).toContain("notes.md");
    expect(files.some((f) => f.startsWith(".claude/worktrees"))).toBe(false);
  });

  test("a clean tree is still RESCUE_CLEAN", () => {
    sh(`cd ${checkout} && git worktree remove --force .claude/worktrees/agent-a1b2 && rm -rf .claude`);
    expect(bare(rescue())).toBe(RESCUE_CLEAN);
  });
});

/**
 * Issue #251, measured live the same day as #217: a member subagent's own
 * worktree (`.claude/worktrees/<name>`) is a REAL git worktree, not a plain
 * directory — it can hold real, uncommitted or un-pushed work of its own,
 * and #217's marker exclusion (which is correct for the main checkout's own
 * `status`/`add` scope) had the side effect of making rescue never walk in
 * and look. These are the exact scenarios from the board issue's own
 * "Output format" section.
 */
describe("#251 — rescue-push walks every git worktree, not just the main checkout", () => {
  test("a member worktree with uncommitted changes: rescued to its own fleet/rescue/<studio>/wt/<worktree>-<ts> ref", () => {
    writeFileSync(join(checkout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out = rescue();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1 files$`, "m"));
    const refs = rescueRefs();
    const memberRef = refs.find((r) => r.includes("agent-a1b2"));
    expect(memberRef).toBeDefined();
    const files = sh(`git -C ${origin} ls-tree -r --name-only ${memberRef!.replace("refs/heads/", "")}`).out.split("\n");
    expect(files).toContain("wip.md");
  });

  test("a member worktree that's clean but has 2 unpushed commits: those commits get pushed to the same ref-naming scheme", () => {
    const memberDir = join(checkout, ".claude/worktrees/agent-a1b2");
    sh(`cd ${memberDir} && git commit -q --allow-empty -m "member commit 1" && git commit -q --allow-empty -m "member commit 2"`);

    const out = rescue();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 2 commits$`, "m"));
    const refs = rescueRefs();
    expect(refs.some((r) => r.includes("agent-a1b2"))).toBe(true);
  });

  test("main checkout clean, member worktree dirty: overall result is NOT a bare RESCUE_CLEAN", () => {
    writeFileSync(join(checkout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out = rescue();

    expect(out).not.toBe(RESCUE_CLEAN);
    expect(out).toMatch(/RESCUE_PUSHED fleet\/rescue\/.*\/wt\/agent-a1b2-\d{14} 1/);
  });

  test("everything markers-only across every worktree: nothing rescued, nothing pushed", () => {
    // Main checkout's only diff is the marker (the fresh worktree gitlink,
    // from beforeEach), and the member worktree itself is clean and its
    // HEAD already lives on origin (it was branched off the already-pushed
    // initial commit) — so nothing anywhere is real, unpushed work.
    const out = rescue();

    expect(bare(out)).toBe(RESCUE_MARKERS_ONLY);
    expect(rescueRefs()).toEqual([]);
  });
});

/**
 * Issue #251, review finding (comment 5828325123, sourced from a separate
 * review on #259): `git rev-parse --abbrev-ref HEAD` returns the LITERAL
 * string "HEAD" when a checkout is in detached-HEAD state — a state real
 * teardown can hit (a studio's agent left a worktree mid-`git checkout
 * <sha>`, or mid-rebase). The original target-resolution compared that
 * literal string against the resolved default branch; since "HEAD" is never
 * equal to a real branch name, it fell through to the branch-push path and
 * used the literal string "HEAD" as a push target — creating a real remote
 * ref named `refs/heads/HEAD`, which collides with git's own special
 * symbolic meaning for that name. Detached HEAD must be treated exactly
 * like "checked out branch is the default": always the generated
 * `fleet/rescue/...` ref, never a branch literally named HEAD.
 */
function anyRefNamedHead(): boolean {
  return sh(`git -C ${origin} for-each-ref --format='%(refname)'`)
    .out.split("\n")
    .some((r) => r === "refs/heads/HEAD");
}

describe("#251 review finding — detached HEAD never becomes a literal 'HEAD' push target", () => {
  test("main checkout, detached HEAD, dirty tree: rescued to fleet/rescue/<studio>-<ts>, never refs/heads/HEAD", () => {
    const sha = sh(`git -C ${checkout} rev-parse HEAD`).out;
    sh(`git -C ${checkout} checkout --detach -q ${sha}`);
    writeFileSync(join(checkout, "notes.md"), "detached work\n");

    const out = rescue();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
    expect(anyRefNamedHead()).toBe(false);
  });

  test("main checkout, detached HEAD, clean but unpushed commits: rescued to fleet/rescue/<studio>-<ts>, never refs/heads/HEAD", () => {
    sh(`cd ${checkout} && git worktree remove --force .claude/worktrees/agent-a1b2 && rm -rf .claude`);
    sh(`cd ${checkout} && git commit -q --allow-empty -m "unpushed work"`);
    const sha = sh(`git -C ${checkout} rev-parse HEAD`).out;
    sh(`git -C ${checkout} checkout --detach -q ${sha}`);

    const out = rescue();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 commits$`, "m"));
    expect(anyRefNamedHead()).toBe(false);
  });

  test("member worktree, detached HEAD, dirty tree: rescued to its own fleet/rescue/<studio>/wt/<worktree>-<ts> ref, never refs/heads/HEAD", () => {
    const memberDir = join(checkout, ".claude/worktrees/agent-a1b2");
    const sha = sh(`git -C ${memberDir} rev-parse HEAD`).out;
    sh(`git -C ${memberDir} checkout --detach -q ${sha}`);
    writeFileSync(join(memberDir, "wip.md"), "member detached work\n");

    const out = rescue();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1 files$`, "m"));
    expect(anyRefNamedHead()).toBe(false);
  });
});

/**
 * PR #263 round 2, C1: a failed status/add/commit/push must never read as
 * success. Every scenario below uses a REAL `--depth 1 file://<origin>`
 * clone — the exact shape guardedCloneCmd (provision.ts) produces in
 * production — with the SAME nested `.claude/worktrees/<name>` member
 * worktree layout as the outer suite's own fixture, never gitignoring
 * `.claude/` (this repo's own shape, per #251).
 */
describe("#263 C1 — a failed rescue never reads as RESCUE_CLEAN/RESCUE_MARKERS_ONLY", () => {
  let sroot: string;
  let scheckout: string;

  beforeEach(() => {
    sroot = join(dir, "workspace-shallow");
    scheckout = join(sroot, REPO);
    mkdirSync(sroot, { recursive: true });
    sh(`git clone -q --depth 1 file://${origin} ${scheckout}`);
    sh(`git -C ${scheckout} worktree add -q .claude/worktrees/agent-a1b2 -b agent-a1b2`);
  });

  function srescue(): string {
    return sh(rescuePushCmd(REPO, STUDIO, sroot)).out;
  }

  test("origin rejects every push (pre-receive exit 1): a dirty main checkout reports RESCUE_FAILED, not clean", () => {
    writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
    writeFileSync(join(scheckout, "notes.md"), "should not land\n");

    const out = srescue();
    const outLines = out.split("\n");

    expect(out).toContain(RESCUE_FAILED_PREFIX);
    // Never a bare CLEAN/MARKERS_ONLY tail line appended AFTER the failure —
    // not just "the whole string isn't exactly CLEAN" (a RESCUE_FAILED line
    // beside a wrongly-appended tail line would still pass a looser check).
    expect(outLines).not.toContain(RESCUE_CLEAN);
    expect(outLines).not.toContain(RESCUE_MARKERS_ONLY);
    expect(rescueRefs()).toEqual([]);
  });

  test("origin's hook rejects only the main ref, accepts the member ref: still not a bare success", () => {
    writeFileSync(
      join(origin, "hooks", "pre-receive"),
      "#!/bin/sh\nwhile read old new ref; do\n  case \"$ref\" in\n    *agent-a1b2*) ;;\n    refs/heads/fleet/rescue/*) exit 1 ;;\n  esac\ndone\nexit 0\n",
    );
    chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
    writeFileSync(join(scheckout, "notes.md"), "main work, rejected\n");
    writeFileSync(join(scheckout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work, accepted\n");

    const out = srescue();
    const outLines = out.split("\n");

    expect(out).toMatch(new RegExp(`${RESCUE_FAILED_PREFIX} checkout`));
    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1`));
    expect(outLines).not.toContain(RESCUE_CLEAN);
    expect(outLines).not.toContain(RESCUE_MARKERS_ONLY);
    const refs = rescueRefs();
    expect(refs.some((r) => r.includes("agent-a1b2"))).toBe(true);
    expect(refs.some((r) => !r.includes("agent-a1b2"))).toBe(false);
  });

  test("a stale index.lock in the member worktree: RESCUE_FAILED names that worktree, nothing pushed for it", () => {
    writeFileSync(join(scheckout, ".git/worktrees/agent-a1b2/index.lock"), "");
    writeFileSync(join(scheckout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out = srescue();

    expect(out).toMatch(new RegExp(`${RESCUE_FAILED_PREFIX} agent-a1b2`));
    expect(rescueRefs().some((r) => r.includes("agent-a1b2"))).toBe(false);
  });

  test("a failing pre-commit hook via core.hooksPath does not block the rescue: commits use --no-verify", () => {
    const hooksDir = mkdtempSync(join(tmpdir(), "fleet-hooks-"));
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooksDir, "pre-commit"), 0o755);
    sh(`git -C ${scheckout} config core.hooksPath ${hooksDir}`);
    writeFileSync(join(scheckout, "notes.md"), "main work\n");
    writeFileSync(join(scheckout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out = srescue();

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1`));
    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1`));
  });

  test("a prunable worktree (its directory removed without `git worktree remove`) is skipped quietly, never RESCUE_FAILED", () => {
    sh(`git -C ${scheckout} worktree add -q .claude/worktrees/agent-gone -b agent-gone`);
    rmSync(join(scheckout, ".claude/worktrees/agent-gone"), { recursive: true, force: true });
    writeFileSync(join(scheckout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out = srescue();

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    const pushLines = out.split("\n").filter((l) => l.startsWith(RESCUE_PUSHED_PREFIX));
    expect(pushLines.length).toBe(1);
    expect(pushLines[0]).toMatch(new RegExp(`fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1`));
  });
});

/**
 * PR #263 round 2, C2: the markers-only arm must never short-circuit the
 * "clean but unpushed commits" check. The outer suite's own beforeEach
 * already leaves every main-checkout status carrying the `.claude/
 * worktrees/agent-a1b2` marker (an untracked gitlink), so a main checkout
 * with unpushed commits and no OTHER dirty file hits exactly the arm this
 * closes.
 */
describe("#263 C2 — the lead's own unpushed commits are never masked by the marker-only arm", () => {
  test("member worktree already clean/pushed, lead commits 2 on main with no push: lead's HEAD lands on origin", () => {
    sh(`git -C ${checkout} commit -q --allow-empty -m "lead commit 1" && git -C ${checkout} commit -q --allow-empty -m "lead commit 2"`);
    const leadSha = sh(`git -C ${checkout} rev-parse HEAD`).out;

    const out = rescue();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 2 commits$`, "m"));
    const mainRef = rescueRefs().find((r) => !r.includes("agent-a1b2"));
    expect(mainRef).toBeDefined();
    expect(sh(`git -C ${origin} rev-parse ${mainRef}`).out).toBe(leadSha);
  });

  test("dirty member AND lead on a new upstream-less branch with 1 commit: both HEADs land on origin in the same run", () => {
    sh(`git -C ${checkout} checkout -q -b task/feature && git -C ${checkout} commit -q --allow-empty -m "lead work"`);
    const leadSha = sh(`git -C ${checkout} rev-parse HEAD`).out;
    writeFileSync(join(checkout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out = rescue();

    expect(out).toMatch(/RESCUE_PUSHED task\/feature 1/);
    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1`));
    expect(sh(`git -C ${origin} rev-parse refs/heads/task/feature`).out).toBe(leadSha);
    const memberSha = sh(`git -C ${join(checkout, ".claude/worktrees/agent-a1b2")} rev-parse HEAD`).out;
    const memberRef = rescueRefs().find((r) => r.includes("agent-a1b2"));
    expect(sh(`git -C ${origin} rev-parse ${memberRef}`).out).toBe(memberSha);
  });
});

/**
 * PR #263 round 2, C3: a `--depth 1` clone never gets a local
 * `refs/remotes/origin/<target>` for a generated rescue ref (only the
 * configured single-branch fetch refspec does), so re-running rescue against
 * the SAME checkout re-counts the already-pushed rescue commit as "ahead"
 * forever. A successful push must leave a local tracking ref behind so the
 * second run sees the work as already saved.
 */
describe("#263 C3 — idempotent on a --depth 1 clone: a second run pushes nothing new", () => {
  test("run1 pushes one ref; run2 (1.1s later) pushes nothing and the ref list is unchanged", async () => {
    const sroot = join(dir, "workspace-shallow-c3");
    const scheckout = join(sroot, REPO);
    mkdirSync(sroot, { recursive: true });
    sh(`git clone -q --depth 1 file://${origin} ${scheckout}`);
    sh(`git -C ${scheckout} worktree add -q .claude/worktrees/agent-a1b2 -b agent-a1b2`);
    writeFileSync(join(scheckout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out1 = sh(rescuePushCmd(REPO, STUDIO, sroot)).out;
    expect(out1).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1 files$`, "m"));
    const refsAfter1 = rescueRefs();
    expect(refsAfter1.length).toBe(1);

    await new Promise((r) => setTimeout(r, 1100));

    const out2 = sh(rescuePushCmd(REPO, STUDIO, sroot)).out;
    expect(out2).not.toContain(RESCUE_PUSHED_PREFIX);
    expect(rescueRefs()).toEqual(refsAfter1);
  });
});

/**
 * PR #263 round 2, C4: two worktrees whose DIRECTORIES share a basename
 * (one nested under `.claude/worktrees`, one a sibling of the checkout
 * entirely) must never collide on the same generated ref — git itself
 * already disambiguates their own admin directory names
 * (`.git/worktrees/<name>`, `<name>1`, ...); the ref-naming scheme must use
 * THAT name, not the worktree directory's own basename. `date` is pinned via
 * a PATH shim so both worktrees generate the identical timestamp, forcing
 * the collision a directory-basename scheme would hit.
 */
describe("#263 C4 — colliding worktree-directory basenames never overwrite each other's ref", () => {
  test("agent-dup under .claude/worktrees and agent-dup outside the checkout, same pinned timestamp: both HEADs land on origin", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "fleet-date-shim-"));
    writeFileSync(
      join(shimDir, "date"),
      "#!/bin/sh\nif [ \"$1\" = \"-u\" ] && [ \"$2\" = \"+%Y%m%d%H%M%S\" ]; then echo 20260925120000; else exec /usr/bin/date \"$@\"; fi\n",
    );
    chmodSync(join(shimDir, "date"), 0o755);

    const outsideDir = join(dir, "outside");
    mkdirSync(outsideDir, { recursive: true });
    sh(`git -C ${checkout} worktree add -q .claude/worktrees/agent-dup -b agent-dup-a`);
    sh(`git -C ${checkout} worktree add -q ${join(outsideDir, "agent-dup")} -b agent-dup-b`);
    writeFileSync(join(checkout, ".claude/worktrees/agent-dup", "a.md"), "dup a work\n");
    writeFileSync(join(outsideDir, "agent-dup", "b.md"), "dup b work\n");

    const out = sh(rescuePushCmd(REPO, STUDIO, root), dir, { PATH: `${shimDir}:${BASE_PATH}` }).out;

    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-dup-20260925120000 1 files$`, "m"));
    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-dup1-20260925120000 1 files$`, "m"));
    const dupRefs = rescueRefs().filter((r) => r.includes("agent-dup"));
    expect(dupRefs.length).toBe(2);
  });

  test("rescuePushCmd never force-pushes a member ref (no `+HEAD:` anywhere)", () => {
    const cmd = rescuePushCmd(REPO, STUDIO, root);
    expect(cmd).not.toMatch(/push origin "\+HEAD/);
    expect(cmd).not.toContain(" -f ");
    expect(cmd).not.toContain("--force");
  });
});

/**
 * PR #263 round 2, C5: `for w in $(...)` word-splits on whitespace — a
 * worktree path containing a space is silently skipped, never rescued.
 */
describe("#263 C5 — a worktree path containing a space is never skipped by word-splitting", () => {
  test("member worktree at '.claude/worktrees/agent sp': rescued, not silently skipped", () => {
    sh(`git -C ${checkout} worktree add -q ".claude/worktrees/agent sp" -b agent-sp-branch`);
    writeFileSync(join(checkout, ".claude/worktrees/agent sp", "wip.md"), "space path work\n");

    const out = rescue();

    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-sp-\\d{14} 1`));
    expect(rescueRefs().some((r) => r.includes("agent-sp"))).toBe(true);
  });
});

/**
 * PR #263 round 3 (#251 review), N1: a local branch holding commits with no
 * remote-tracking ref that already has them is invisible to every check
 * above when it is NOT the branch currently checked out anywhere — the
 * per-worktree "clean but ahead" check only ever looks at THAT worktree's
 * own HEAD. Measured live: `git checkout -b feat && git commit ... && git
 * checkout main` leaves `feat` holding a real commit, `main` checked out and
 * clean, and the old rescue-push reports a bare RESCUE_CLEAN — `feat`'s
 * commit is gone the moment the container is torn down. Every local branch
 * NOT attached to any worktree (`git worktree list --porcelain`'s own
 * `branch refs/heads/...` lines say which ARE) is walked once, from the main
 * checkout — `refs/heads` is shared repo-wide, so scanning from every
 * worktree would just re-find the identical set N times — and any such
 * branch with commits `--not --remotes` lands on its own
 * `fleet/rescue/<studio>/<ts>/checkout/<branch>` ref, a deliberately
 * different (nested) shape from the flat C4 naming above: `<branch>` is
 * already unique per repo, so this is collision-safe by construction.
 */
describe("#263 N1 — a local branch not checked out anywhere still gets its unpushed commits rescued", () => {
  test("feat has an unpushed commit, main is checked out and otherwise clean: feat is still rescued", () => {
    sh(`cd ${checkout} && git checkout -q -b feat && git commit -q --allow-empty -m "feat work" && git checkout -q main`);

    const out = rescue();

    expect(out).not.toBe(RESCUE_CLEAN);
    expect(out).not.toBe(RESCUE_MARKERS_ONLY);
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/feat 1 commits$`, "m"));
    const refs = rescueRefs();
    const featRef = refs.find((r) => r.endsWith("/feat"));
    expect(featRef).toBeDefined();
    const featSha = sh(`git -C ${checkout} rev-parse feat`).out;
    expect(sh(`git -C ${origin} rev-parse ${featRef}`).out).toBe(featSha);
  });

  test("a branch checked out in a member worktree is never double-rescued by the N1 walk", () => {
    // agent-a1b2 (the outer fixture's member worktree) is checked out on its
    // own branch of the same name — the N1 walk must skip it: it is already
    // covered by the per-worktree loop above (this test's own beforeEach
    // leaves it clean and already fully on origin, so this asserts no NEW,
    // redundant push for it happens as a side effect of the branch walk).
    const out = rescue();
    expect(bare(out)).toBe(RESCUE_MARKERS_ONLY);
    expect(rescueRefs()).toEqual([]);
  });
});

/**
 * PR #263 round 3, N2: `git stash` is invisible to every check above — never
 * a branch, never a worktree's own HEAD. Verified live against real git:
 * `refs/stash` is REPOSITORY-wide, shared by every worktree (a stash made
 * INSIDE a member worktree shows up in `git stash list` run from the main
 * checkout) — so one scan from the main checkout, after the per-worktree
 * loop, sees every stash entry from every worktree exactly once. Each entry
 * is a real commit (`git rev-parse stash@{N}`); pushed straight to
 * `fleet/rescue/<studio>/<ts>/checkout/stash-<N>` without touching the stash
 * itself, and counted in the summary exactly like any other RESCUE_PUSHED
 * line.
 */
describe("#263 N2 — a stash entry is pushed as its own ref and counted, never silently dropped", () => {
  test("a stash made inside a member worktree: main checkout is otherwise markers-only, but the stash is still saved", () => {
    const memberDir = join(checkout, ".claude/worktrees/agent-a1b2");
    writeFileSync(join(memberDir, "wip.md"), "stash me\n");
    sh(`git -C ${memberDir} add wip.md && git -C ${memberDir} stash -q`);

    const out = rescue();

    expect(out).not.toBe(RESCUE_MARKERS_ONLY);
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/stash-0 1 files$`, "m"));
    const refs = rescueRefs();
    const stashRef = refs.find((r) => r.endsWith("/stash-0"));
    expect(stashRef).toBeDefined();
    const stashSha = sh(`git -C ${memberDir} rev-parse stash@{0}`).out;
    expect(sh(`git -C ${origin} rev-parse ${stashRef}`).out).toBe(stashSha);
  });

  test("two stash entries in the main checkout: both are saved, numbered stash-0 and stash-1", () => {
    sh(`cd ${checkout} && git worktree remove --force .claude/worktrees/agent-a1b2 && rm -rf .claude`);
    writeFileSync(join(checkout, "a.md"), "first stash\n");
    sh(`git -C ${checkout} add a.md && git -C ${checkout} stash -q`);
    writeFileSync(join(checkout, "b.md"), "second stash\n");
    sh(`git -C ${checkout} add b.md && git -C ${checkout} stash -q`);

    const out = rescue();

    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/stash-0 1`));
    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/stash-1 1`));
  });
});

/**
 * PR #263 round 4 (#251 review), Finding 1, HIGH: `git worktree list
 * --porcelain` still emits a `branch refs/heads/<name>` line for a
 * "prunable" worktree — registered, but its DIRECTORY is gone (`rm -rf`'d
 * instead of `git worktree remove`). The per-worktree loop above correctly
 * skips a prunable worktree (`[ -d "$w" ] || continue` — `rescue_one` never
 * runs for it, nothing to walk into), but round 3's N1 walk built its
 * `checked_out` skip-list from EVERY branch line in the porcelain output,
 * live or prunable, and wrongly treated a prunable worktree's branch as
 * "already covered" — so a branch with real unpushed commits, whose
 * worktree directory was removed the wrong way, was invisible to BOTH
 * paths at once: exactly the "worktree gone, work lost" failure #251
 * exists to fix. `checked_out` must only suppress a branch whose worktree
 * directory still exists; a prunable entry's branch must be walked and
 * pushed by N1 like any other not-currently-live local branch.
 */
describe("#263 round 4 Finding 1 — a branch whose worktree directory was removed (rm -rf, not `git worktree remove`) still gets its unpushed commits rescued", () => {
  test("a prunable worktree's branch has an unpushed commit: pushed by N1's branch walk, not silently lost", () => {
    sh(`git -C ${checkout} worktree add -q .claude/worktrees/agent-gone -b agent-gone`);
    sh(`cd ${join(checkout, ".claude/worktrees/agent-gone")} && git commit -q --allow-empty -m "gone work"`);
    const goneSha = sh(`git -C ${checkout} rev-parse agent-gone`).out;
    // Remove the worktree DIRECTORY directly -- git's own registration still
    // lists it as a "prunable" worktree, `branch refs/heads/agent-gone` line
    // intact, exactly the scenario `git worktree list --porcelain` produces
    // in the wild (a container's filesystem torn away, never a clean
    // `git worktree remove`).
    rmSync(join(checkout, ".claude/worktrees/agent-gone"), { recursive: true, force: true });

    const out = rescue();

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/agent-gone 1 commits$`, "m"));
    const refs = rescueRefs();
    const goneRef = refs.find((r) => r.endsWith("/agent-gone"));
    expect(goneRef).toBeDefined();
    expect(sh(`git -C ${origin} rev-parse ${goneRef}`).out).toBe(goneSha);
  });
});

/**
 * PR #263 round 5 (#251 review): a branch literally named after a top-level
 * repo path (`docs`, `src`, `test`, `apps` — this very repo has `apps/`) made
 * N1's own `git rev-list --count "$b" --not --remotes` call ambiguous: git
 * cannot tell whether a bare `docs` means the REVISION `docs` or the
 * PATHSPEC `docs` when a top-level `docs/` directory also exists in the
 * working tree, and refuses to guess — `fatal: ambiguous argument 'docs':
 * both revision and filename`. The old `|| echo 0` fallback swallowed that
 * error identically to "branch has genuinely zero commits ahead" (a real,
 * common, harmless case elsewhere in this same line), so the branch's real
 * unpushed commit was silently never checked, let alone pushed — no
 * RESCUE_FAILED, no RESCUE_PUSHED, nothing. `refs/heads/$b` disambiguates: a
 * ref path is never also a valid pathspec, so git never has to guess.
 */
describe("#263 round 5 — a branch named like a top-level repo path is never silently skipped", () => {
  test("branch 'docs' has an unpushed commit, and a top-level docs/ directory exists: still rescued, not silently swallowed as 'ambiguous argument'", () => {
    mkdirSync(join(checkout, "docs"));
    writeFileSync(join(checkout, "docs", "readme.md"), "a real top-level docs dir\n");
    sh(`git -C ${checkout} add docs && git -C ${checkout} commit -q -m "add docs dir" && git -C ${checkout} push -q origin main`);
    sh(`cd ${checkout} && git checkout -q -b docs && git commit -q --allow-empty -m "docs branch work" && git checkout -q main`);

    const out = rescue();

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/docs 1 commits$`, "m"));
    const refs = rescueRefs();
    const docsRef = refs.find((r) => r.endsWith("/docs"));
    expect(docsRef).toBeDefined();
    const docsSha = sh(`git -C ${checkout} rev-parse docs`).out;
    expect(sh(`git -C ${origin} rev-parse ${docsRef}`).out).toBe(docsSha);
  });
});

/**
 * PR #263 round 6 (#251 review, MEDIUM): round 5's own fix above used
 * `2>&1` on the disambiguated `rev-list --count "refs/heads/$b" --not
 * --remotes` call, reasoning it would help surface an ambiguous-argument
 * failure — but the `RESCUE_FAILED` line printed on that path is a static
 * string that never reads the captured text, so `2>&1` bought nothing there.
 * What it DOES do is merge stderr into `$bahead` on the SUCCESS path too,
 * where `$bahead` is echoed verbatim as the count field of `RESCUE_PUSHED
 * $btarget $bahead` — a line `do.ts`'s own `pushLine` regex
 * (`^RESCUE_PUSHED (\S+) (\d+)$`) requires to be a single line ending in a
 * bare number. A real, documented git behavior — a benign warning on stderr
 * (e.g. `warning: ignoring dangling symref refs/remotes/origin/HEAD`, which
 * can fire after a shallow/single-branch clone drifts, exactly the shape
 * `guardedCloneCmd` produces) — while the command still exits 0, turns
 * `$bahead` multi-line and breaks that regex, even though the push itself
 * genuinely succeeded. A PATH-shimmed `git` reproduces this deterministically:
 * it prints a warning to stderr for exactly this rev-list invocation, then
 * `exec`s the real git, which still exits 0 with a clean count on stdout.
 */
describe("#263 round 6 — a benign stderr warning during N1's rev-list must never corrupt the RESCUE_PUSHED count field", () => {
  test("a git warning on stderr while counting a not-checked-out branch's commits: RESCUE_PUSHED stays single-line with a clean numeric count", () => {
    sh(`cd ${checkout} && git checkout -q -b feat && git commit -q --allow-empty -m "feat work" && git checkout -q main`);

    const shimDir = mkdtempSync(join(tmpdir(), "fleet-git-warn-shim-"));
    writeFileSync(
      join(shimDir, "git"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"-C\" ] && [ \"$3\" = \"rev-list\" ] && [ \"$4\" = \"--count\" ] && [ \"$5\" = \"refs/heads/feat\" ]; then\n" +
        "  echo 'warning: ignoring dangling symref refs/remotes/origin/HEAD' >&2\n" +
        "fi\n" +
        "exec /usr/bin/git \"$@\"\n",
    );
    chmodSync(join(shimDir, "git"), 0o755);

    const out = sh(rescuePushCmd(REPO, STUDIO, root), dir, { PATH: `${shimDir}:${BASE_PATH}` }).out;

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    // Never leaked into the output at all -- proves the warning was
    // discarded, not merely "happened to land somewhere harmless".
    expect(out).not.toContain("dangling symref");
    // A single, clean RESCUE_PUSHED line -- never the warning text folded
    // into the count field (which would make this line multi-line and fail
    // do.ts's own single-line `^RESCUE_PUSHED (\S+) (\d+)$` parse).
    const pushLines = out.split("\n").filter((l) => l.startsWith(RESCUE_PUSHED_PREFIX));
    expect(pushLines.length).toBe(1);
    expect(pushLines[0]).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/feat 1 commits$`));
  });
});

/**
 * PR #263 round 3, N3: a push rejected non-fast-forward (the checked-out
 * branch moved on origin since this worktree last knew about it — a lead's
 * own PR branch, pushed to from somewhere else entirely) used to fall
 * straight into RESCUE_FAILED, destroying the container's only copy of that
 * work right after. Verified live against real git (a second clone pushes
 * ahead of the lead's own checkout, exactly reproducing the "fetch first"
 * rejection this file's own header already documents for the shallow-clone
 * case): the SAME commit is retried, once, to a freshly generated
 * `fleet/rescue/...` ref that has no existing tip on origin to reject
 * against — landing clean. Only if THAT retry also fails does this become a
 * genuine RESCUE_FAILED.
 */
describe("#263 N3 — a non-fast-forward push rejection retries to a generated fallback ref", () => {
  test("the checked-out branch moved on origin: retried to a generated ref, never RESCUE_FAILED", () => {
    sh(`cd ${checkout} && git checkout -q -b task/lead && git push -q origin task/lead`);
    const otherClone = join(dir, "other-clone");
    sh(`git clone -q ${origin} ${otherClone}`);
    sh(`cd ${otherClone} && git checkout -q task/lead && git commit -q --allow-empty -m "someone else moved this branch" && git push -q origin task/lead`);
    writeFileSync(join(checkout, "notes.md"), "lead work that must not be lost\n");

    const out = rescue();

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    // HOLD-round fix: the fallback ref used to sit flat between two dashes
    // (`fleet/rescue/<studio>-<id>-<ts>-nff`) — the exact same shape #266's
    // own fix already moved the member-worktree ref OFF of, for the exact
    // same reason (discoverRescueRefsCmd's flat pattern anchors to EXACTLY
    // 14 digits right after `<studio>-`; the extra `<id>-nff-` characters
    // never matched it, so an nff-retried rescue sat on origin invisible to
    // the very auto-fetch this whole feature exists to provide). Moved under
    // the same `wt/` segment (`fleet/rescue/<studio>/wt/<id>-nff-<ts>`) so it
    // matches discoverRescueRefsCmd's existing `wt/` pattern alternative
    // unchanged — no new pattern needed, `-nff` just replaces the timestamp
    // as the trailing literal before the real 14-digit timestamp.
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/checkout-nff-\\d{14} 1 files$`, "m"));
    const refs = rescueRefs();
    const fallbackRef = refs.find((r) => r.includes("-nff-"));
    expect(fallbackRef).toBeDefined();
    const leadSha = sh(`git -C ${checkout} rev-parse HEAD`).out;
    expect(sh(`git -C ${origin} rev-parse ${fallbackRef}`).out).toBe(leadSha);
    // The branch's own ref on origin is untouched — never force-pushed over.
    expect(sh(`git -C ${otherClone} rev-parse HEAD`).out).toBe(sh(`git -C ${origin} rev-parse refs/heads/task/lead`).out);
  });

  test("the -nff fallback ref is auto-discoverable by discoverRescueRefsCmd, same as the ordinary wt/ shape", () => {
    sh(`cd ${checkout} && git checkout -q -b task/lead2 && git push -q origin task/lead2`);
    const otherClone = join(dir, "other-clone-nff-discover");
    sh(`git clone -q ${origin} ${otherClone}`);
    sh(`cd ${otherClone} && git checkout -q task/lead2 && git commit -q --allow-empty -m "someone else moved this branch" && git push -q origin task/lead2`);
    writeFileSync(join(checkout, "notes.md"), "lead work that must not be lost\n");

    const out = rescue();
    const fallbackRef = rescueRefs().find((r) => r.includes("-nff-"));
    expect(fallbackRef).toBeDefined();
    const branchName = fallbackRef!.replace(/^refs\/heads\//, "");

    // Simulate the NEXT provision, from a fresh clone that knows nothing
    // about this rescue yet.
    const freshClone = join(dir, "fresh-clone-nff");
    sh(`git clone -q ${origin} ${freshClone}`);
    // PR #312 round 3: the list file's path is injectable -- the default
    // /workspace/.fleet does not exist (or is unwritable) off a studio, and
    // the old command's `|| true` hid that, so this test failed on a Mac
    // for a reason nothing printed.
    sh(discoverRescueRefsCmd(freshClone, STUDIO, join(dir, ".fleet", "remote-branches.txt")), dir);

    expect(sh(`git -C ${freshClone} rev-parse --verify ${branchName}`).code).toBe(0);
    expect(out).toContain(branchName);
  });

  test("discovery that cannot write its list file says so on stderr, and still never fails provisioning", () => {
    const freshClone = join(dir, "fresh-clone-unwritable");
    sh(`git clone -q ${origin} ${freshClone}`);
    const r = sh(discoverRescueRefsCmd(freshClone, STUDIO, "/dev/null/no-such-dir/remote-branches.txt"), dir);
    expect(r.code).toBe(0);
    expect(r.err).toContain("rescue discovery skipped");
  });
});

/**
 * PR #263 round 3, N4: every git invocation inside `rescue_one` runs inside
 * the outer `while IFS= read -r w; do ... done <<< "$wtlist"` here-string
 * loop (C5, above) — an inner command that reads its OWN stdin without an
 * explicit redirect inherits that SAME here-string as its fd 0. Verified
 * live in plain bash first (a child process's own `read` drains the next
 * line meant for the outer loop's `read -r w`, silently truncating the
 * list); real git's OWN hooks turned out already immune (pre-commit,
 * post-commit, pre-push: git itself redirects/pipes their stdin, verified
 * live against this exact git version) — but nothing in `rescue_one` was
 * defending the general case, only relying on git's hooks happening to be
 * safe today. A `git` on PATH that ALSO happens to read a line of stdin (the
 * general shape of "any command inside the loop that touches stdin", not
 * relying on hook-specific isolation) reproduces the exact truncation this
 * fixes: `rescue_one </dev/null` (or an equivalent per-command redirect)
 * means that read hits EOF instead, and the outer list survives intact.
 */
describe("#263 N4 — a command inside rescue_one can never consume the outer worktree list from stdin", () => {
  test("a stdin-reading 'add' shim eats the NEXT worktree's line unless rescue_one's own stdin is /dev/null", () => {
    const scheckout = join(dir, "workspace-n4", REPO);
    mkdirSync(join(dir, "workspace-n4"), { recursive: true });
    sh(`git clone -q file://${origin} ${scheckout}`);
    sh(`git -C ${scheckout} worktree add -q .claude/worktrees/agent-a1b2 -b agent-a1b2`);
    sh(`git -C ${scheckout} worktree add -q .claude/worktrees/agent-zz -b agent-zz`);
    writeFileSync(join(scheckout, ".claude/worktrees/agent-a1b2", "a.md"), "a work\n");
    writeFileSync(join(scheckout, ".claude/worktrees/agent-zz", "z.md"), "z work\n");

    const shimDir = mkdtempSync(join(tmpdir(), "fleet-git-shim-"));
    writeFileSync(
      join(shimDir, "git"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"-C\" ]; then\n" +
        "  case \"$2\" in\n" +
        "    */.claude/worktrees/*) [ \"$3 $4\" = \"add -A\" ] && read -r _leaked ;;\n" +
        "  esac\n" +
        "fi\n" +
        "exec /usr/bin/git \"$@\"\n",
    );
    chmodSync(join(shimDir, "git"), 0o755);

    const out = sh(rescuePushCmd(REPO, STUDIO, join(dir, "workspace-n4")), dir, { PATH: `${shimDir}:${BASE_PATH}` }).out;

    // Both member worktrees are real, independent dirty trees; a leaked line
    // means the SECOND one's own worktree path was consumed as the "next"
    // loop line and it is never processed at all — no RESCUE_PUSHED for it.
    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1`));
    expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-zz-\\d{14} 1`));
  });
});

/**
 * Issue #266 (follow-up on #251/#263): `fleet rescue-all` runs against LIVE
 * studios — `rescuePushCmd` above is correct at teardown (mutating a doomed
 * container's own checkout is harmless) but WRONG here: `git add -A` + `git
 * commit` against a studio that is still being worked on commits and moves
 * HEAD on a real, live branch, possibly capturing a lead/member's own
 * mid-edit diff and changing what a still-running agent sees underneath it.
 * `rescueSnapshotCmd` is the non-mutating replacement `rescueNow` (do.ts)
 * calls instead — same real-git rigor as the suite above, but the load-
 * bearing assertion in every test below is that the STUDIO'S OWN state
 * (working tree, index, HEAD) reads byte-identical before and after, even
 * though a real commit genuinely lands on origin.
 */
describe("#266 — rescueSnapshotCmd saves a dirty tree WITHOUT touching the live studio's own index/HEAD", () => {
  function snapshot(): string {
    return sh(rescueSnapshotCmd(REPO, STUDIO, root)).out;
  }

  test("a dirty main checkout: pushes a real snapshot commit, but git status --porcelain and HEAD are byte-identical before and after", () => {
    writeFileSync(join(checkout, "notes.md"), "real work\n");
    const statusBefore = sh(`git -C ${checkout} status --porcelain`).out;
    const headBefore = sh(`git -C ${checkout} rev-parse HEAD`).out;

    const out = snapshot();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
    const [ref] = rescueRefs();
    const files = sh(`git -C ${origin} ls-tree -r --name-only ${ref}`).out.split("\n");
    expect(files).toContain("notes.md");

    // The load-bearing proof: the real working tree, index, and HEAD read
    // EXACTLY as they did before the snapshot — the dirty file is still
    // sitting there, uncommitted, exactly as a live agent left it.
    expect(sh(`git -C ${checkout} status --porcelain`).out).toBe(statusBefore);
    expect(sh(`git -C ${checkout} rev-parse HEAD`).out).toBe(headBefore);
    // The pushed commit's parent IS that same real HEAD -- a genuine
    // snapshot of "HEAD plus this diff", not an orphan.
    expect(sh(`git -C ${origin} log -1 --format=%P ${ref}`).out).toBe(headBefore);
  });

  test("a dirty member worktree: pushes to its own wt/ ref, and the member worktree's own status/HEAD are untouched", () => {
    writeFileSync(join(checkout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");
    const memberDir = join(checkout, ".claude/worktrees/agent-a1b2");
    const statusBefore = sh(`git -C ${memberDir} status --porcelain`).out;
    const headBefore = sh(`git -C ${memberDir} rev-parse HEAD`).out;

    const out = snapshot();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1 files$`, "m"));
    expect(sh(`git -C ${memberDir} status --porcelain`).out).toBe(statusBefore);
    expect(sh(`git -C ${memberDir} rev-parse HEAD`).out).toBe(headBefore);
  });

  // The issue's own outline (`GIT_INDEX_FILE=<tmp> git add -A`) would, taken
  // literally, start from a BLANK throwaway index -- `add -A` can only stage
  // a deletion it can already see reflected as an entry in ITS OWN starting
  // index, so a blank one silently drops every deleted-file staging from the
  // snapshot. rescueSnapshotCmd seeds the throwaway index from a byte copy of
  // the real one first (a read, never a write) specifically to close this.
  test("a dirty tree that DELETES a previously-committed file: the deletion is captured in the pushed snapshot, and the real working tree/index are still untouched", () => {
    writeFileSync(join(checkout, "keep.md"), "will be committed then deleted\n");
    sh(`git -C ${checkout} add keep.md && git -C ${checkout} commit -q -m "add keep.md" && git -C ${checkout} push -q origin main`);
    rmSync(join(checkout, "keep.md"));
    const statusBefore = sh(`git -C ${checkout} status --porcelain`).out;
    expect(statusBefore).toContain("keep.md");
    const headBefore = sh(`git -C ${checkout} rev-parse HEAD`).out;

    const out = snapshot();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
    const ref = rescueRefs().find((r) => !r.includes("agent-a1b2"))!;
    const pushedFiles = sh(`git -C ${origin} ls-tree -r --name-only ${ref}`).out.split("\n");
    expect(pushedFiles).not.toContain("keep.md");

    // Real state: unchanged. The file is still gone from the working tree
    // (that was the agent's own edit, left exactly as it was) and the real
    // index still reflects it as deleted-but-uncommitted, same as before.
    expect(sh(`git -C ${checkout} status --porcelain`).out).toBe(statusBefore);
    expect(sh(`git -C ${checkout} rev-parse HEAD`).out).toBe(headBefore);
  });

  test("a clean tree with unpushed commits: pushed exactly like rescuePushCmd (an existing commit by ref never touches local state)", () => {
    sh(`git -C ${checkout} commit -q --allow-empty -m "lead commit 1" && git -C ${checkout} commit -q --allow-empty -m "lead commit 2"`);
    const leadSha = sh(`git -C ${checkout} rev-parse HEAD`).out;

    const out = snapshot();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 2 commits$`, "m"));
    const mainRef = rescueRefs().find((r) => !r.includes("agent-a1b2"));
    expect(sh(`git -C ${origin} rev-parse ${mainRef}`).out).toBe(leadSha);
    expect(sh(`git -C ${checkout} rev-parse HEAD`).out).toBe(leadSha);
  });

  test("no checkout, clean tree, and markers-only all read exactly like rescuePushCmd", () => {
    expect(sh(rescueSnapshotCmd(REPO, "nope", join(dir, "no-such-workspace"))).out).toBe(RESCUE_NO_CHECKOUT);
    sh(`cd ${checkout} && git worktree remove --force .claude/worktrees/agent-a1b2 && rm -rf .claude`);
    expect(bare(snapshot())).toBe(RESCUE_CLEAN);
  });

  test("markers-only: nothing pushed, and rescueSnapshotCmd never even builds a throwaway index for it", () => {
    expect(bare(snapshot())).toBe(RESCUE_MARKERS_ONLY);
    expect(rescueRefs()).toEqual([]);
  });

  test("never force-pushes (no `+HEAD`/`--force`/a `push ... -f`), same guarantee as rescuePushCmd", () => {
    const cmd = rescueSnapshotCmd(REPO, STUDIO, root);
    expect(cmd).not.toMatch(/push origin "\+/);
    // Not a bare `not.toContain(" -f ")` -- this script legitimately contains
    // `[ -f "$realidx" ]` (a shell file-existence test, unrelated to git's
    // own `-f`/`--force` flag). Scoped to an actual `git ... push` line.
    expect(cmd).not.toMatch(/git[^\n]*push[^\n]*(-f\b|--force)/);
    expect(cmd).not.toContain("--force");
  });

  test("never touches the real .git/index path directly as a write target -- every add/write-tree is GIT_INDEX_FILE-scoped to a mktemp file", () => {
    const cmd = rescueSnapshotCmd(REPO, STUDIO, root);
    expect(cmd).toContain("idxfile=$(mktemp");
    expect(cmd).toContain('GIT_INDEX_FILE="$idxfile" git -C "$w" add -A');
    expect(cmd).toContain('GIT_INDEX_FILE="$idxfile" git -C "$w" write-tree');
    // The real index is only ever READ (a `cp` FROM it), never opened as a
    // write target by this script.
    expect(cmd).not.toMatch(/>\s*"?\$realidx/);
  });

  test("running rescueSnapshotCmd twice in a row against the SAME unchanged dirty tree never fails, and both runs leave local state untouched (each pushes its own fresh snapshot, by design -- see this command's own doc comment)", () => {
    writeFileSync(join(checkout, "notes.md"), "real work\n");
    const statusBefore = sh(`git -C ${checkout} status --porcelain`).out;
    const headBefore = sh(`git -C ${checkout} rev-parse HEAD`).out;

    const out1 = snapshot();
    expect(out1).toContain(RESCUE_PUSHED_PREFIX);
    expect(sh(`git -C ${checkout} status --porcelain`).out).toBe(statusBefore);
    expect(sh(`git -C ${checkout} rev-parse HEAD`).out).toBe(headBefore);

    const out2 = snapshot();
    expect(out2).toContain(RESCUE_PUSHED_PREFIX);
    expect(sh(`git -C ${checkout} status --porcelain`).out).toBe(statusBefore);
    expect(sh(`git -C ${checkout} rev-parse HEAD`).out).toBe(headBefore);
  });
});

/**
 * HOLD-round fix (real-git review on PR #312): rescueSnapshotCmd's dirty-tree
 * branch called the SAME rescue_target() checkout-mode resolution
 * rescuePushCmd uses to pick a push destination. In checkout mode, when the
 * checked-out branch is NOT the repo's resolved default (the ordinary case
 * once a studio's own agent branches), rescue_target() returns that branch's
 * OWN name as the target — correct for rescuePushCmd (which WANTS to push
 * straight to the current branch, an existing/real commit, at teardown) but
 * wrong for rescueSnapshotCmd's dirty-tree branch, which builds a synthetic
 * snapshot commit foreign to the studio's own history and must NEVER land it
 * on a ref the live studio itself still owns, regardless of what
 * branch-vs-default the checked-out branch happens to resolve to.
 *
 * Measured: a studio on `task/feature` (not the default branch) ran a
 * snapshot rescue against a dirty tree; the old code printed `RESCUE_PUSHED
 * task/feature ...` and origin/task/feature moved from the studio's own tip
 * to the synthetic snapshot SHA — the studio's own NEXT real push from that
 * branch is then rejected non-fast-forward, because the remote moved out
 * from under it as a side effect of a rescue that was supposed to be
 * non-mutating. The local working tree/index/HEAD were already correctly
 * left alone (see the #266 suite above) — this closes the gap at the
 * remote-branch level, both on origin AND in the local remote-tracking ref
 * (rescue_one's own `update-ref refs/remotes/origin/$target` line would
 * otherwise silently repoint the studio's OWN local tracking ref at the
 * snapshot SHA too, on the buggy path).
 */
describe("HOLD round (PR #312 real-git review) — rescueSnapshotCmd on a live feature branch never targets that branch's own ref", () => {
  test("dirty checkout on a real (non-default) feature branch: origin/<branch> and the local refs/remotes/origin/<branch> tracking ref are BOTH unchanged; the snapshot lands under its own generated fleet/rescue/... ref instead", () => {
    sh(`git -C ${checkout} checkout -q -b task/feature`);
    sh(`git -C ${checkout} push -q origin task/feature`);
    // Populate the local remote-tracking ref the way a real clone/fetch
    // would — this is the second thing the bug silently mutated.
    sh(`git -C ${checkout} fetch -q origin`);
    writeFileSync(join(checkout, "notes.md"), "in-progress feature work, still uncommitted\n");

    const originBefore = sh(`git -C ${origin} rev-parse refs/heads/task/feature`).out;
    const trackingBefore = sh(`git -C ${checkout} rev-parse refs/remotes/origin/task/feature`).out;
    expect(originBefore).toBe(trackingBefore); // sanity: both start in sync

    const out = sh(rescueSnapshotCmd(REPO, STUDIO, root)).out;

    // Never the bare branch name as a push target.
    expect(out).not.toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} task/feature `, "m"));
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));

    // The load-bearing proof: the live branch's ref, both on origin and in
    // this checkout's own local remote-tracking ref, is byte-identical to
    // before the rescue — the studio's next real push from `task/feature`
    // is still a clean fast-forward.
    expect(sh(`git -C ${origin} rev-parse refs/heads/task/feature`).out).toBe(originBefore);
    expect(sh(`git -C ${checkout} rev-parse refs/remotes/origin/task/feature`).out).toBe(trackingBefore);

    // The snapshot commit really did land, reachable under its own generated
    // ref, and holds the dirty content.
    const snapshotRef = rescueRefs().find((r) => r.startsWith(`refs/heads/fleet/rescue/${STUDIO}-`));
    expect(snapshotRef).toBeDefined();
    const files = sh(`git -C ${origin} ls-tree -r --name-only ${snapshotRef}`).out.split("\n");
    expect(files).toContain("notes.md");
  });

  // PR #312 round 3 (MED): the CLEAN-but-ahead branch had the same harm as
  // round 2's dirty branch -- rescue_target() returned the checked-out
  // feature branch's own name, so a live snapshot rescue pushed the studio's
  // unpushed commits onto origin/<branch> and moved the local tracking ref.
  test("clean checkout on a feature branch with UNPUSHED commits: origin/<branch> and the tracking ref are unchanged; the commits land under fleet/rescue/...", () => {
    sh(`git -C ${checkout} checkout -q -b task/feature`);
    sh(`git -C ${checkout} push -q origin task/feature`);
    sh(`git -C ${checkout} fetch -q origin`);
    sh(`git -C ${checkout} commit -q --allow-empty -m "unpushed feature work 1"`);
    sh(`git -C ${checkout} commit -q --allow-empty -m "unpushed feature work 2"`);
    const head = sh(`git -C ${checkout} rev-parse HEAD`).out;
    const originBefore = sh(`git -C ${origin} rev-parse refs/heads/task/feature`).out;
    const trackingBefore = sh(`git -C ${checkout} rev-parse refs/remotes/origin/task/feature`).out;
    expect(head).not.toBe(originBefore); // sanity: really ahead

    const out = sh(rescueSnapshotCmd(REPO, STUDIO, root)).out;

    expect(out).not.toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} task/feature `, "m"));
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 2 commits$`, "m"));
    expect(sh(`git -C ${origin} rev-parse refs/heads/task/feature`).out).toBe(originBefore);
    expect(sh(`git -C ${checkout} rev-parse refs/remotes/origin/task/feature`).out).toBe(trackingBefore);
    const rescued = rescueRefs().find((r) => r.startsWith(`refs/heads/fleet/rescue/${STUDIO}-`));
    expect(rescued).toBeDefined();
    expect(sh(`git -C ${origin} rev-parse ${rescued}`).out).toBe(head);
  });
});

// Issue #313 (PR #263's own round-5 review): three findings duplicated
// across BOTH command builders (rescuePushCmd's own N1/branch-walk and
// rescue_one, and rescueSnapshotCmd's near-identical copies of the same
// shell) -- every fixture below runs against both.
const RESCUE_CMDS = [
  ["rescuePushCmd", rescuePushCmd] as const,
  ["rescueSnapshotCmd", rescueSnapshotCmd] as const,
];

for (const [label, cmdFn] of RESCUE_CMDS) {
  /**
   * #313 Finding 1: `grep -qxF "$b"` treats a pattern starting with `-` as an
   * OPTION, not a search pattern. A branch literally named `-x` -- refused by
   * `git branch`/`git checkout -b` themselves, but createable via the plain
   * ref plumbing (`update-ref` + `symbolic-ref`), exactly as a corrupted or
   * externally-written ref could leave one -- makes `grep -qxF "-x"` exit 2
   * with a usage error on stderr, never a clean 0 (matched) or 1 (not
   * matched). The checked-out-branch skip (`... && continue`) then never
   * fires for this one branch name, so the branch walk unconditionally
   * re-examines a branch its own worktree walk already covered. Verified
   * live: `grep -qxF "-x"` (real GNU grep) exits 2 printing "Usage: grep
   * [OPTION]..." on stderr; `grep -qxF -e "-x"` exits 0/1 correctly either
   * way, silently, matching every other branch name.
   *
   * (Verified live, real git 2.34.1: in THIS design, `--not --remotes`
   * reachability against the remote-tracking ref the worktree walk's own
   * push just created means the branch walk's re-examination does not end up
   * pushing a second time even with the skip fully removed -- the count it
   * (re)computes is 0. So the observable, provable regression here is the
   * skip silently failing to do its job at all for this one input -- a
   * needless re-walk plus a raw grep usage error on stderr -- not a second
   * `RESCUE_PUSHED` line. The fix is still correct and still required: a
   * skip check that silently no-ops for one specific literal value is a bug
   * regardless of what currently happens to paper over its consequence, the
   * same reasoning this file already applies to `refs/heads/$b`.)
   */
  describe(`#313 Finding 1 (${label}) — a branch literally named '-x' never breaks the checked-out-branch skip`, () => {
    test("a member worktree checked out on branch '-x' with a real unpushed commit: rescued once, cleanly, with no grep usage error on stderr", () => {
      const wtx = join(checkout, ".claude/worktrees/agent-x");
      sh(`git -C ${checkout} worktree add -q ${wtx} --detach`);
      sh(`git -C ${wtx} update-ref refs/heads/-x HEAD`);
      sh(`git -C ${wtx} symbolic-ref HEAD refs/heads/-x`);
      sh(`git -C ${wtx} commit -q --allow-empty -m "work on -x branch"`);

      const result = sh(cmdFn(REPO, STUDIO, root));

      // The real, provable regression: `grep -qxF "$b"` (no `-e`) treats
      // "-x" as an unrecognized OPTION and prints its own usage banner to
      // stderr instead of silently succeeding or failing the match.
      // GNU prints "Usage: grep", BSD (macOS) "usage: grep" -- match both.
      expect(result.err).not.toMatch(/usage:\s*grep/i);
      expect(result.out).not.toContain(RESCUE_FAILED_PREFIX);
      const pushLines = result.out.split("\n").filter((l) => l.startsWith(RESCUE_PUSHED_PREFIX));
      const forDashX = pushLines.filter((l) => l.includes("agent-x") || l.includes("/-x"));
      expect(forDashX.length).toBe(1);
    });
  });

  /**
   * #313 Finding 2: `%(refname:short)` only strips the leading `refs/heads/`
   * component when the RESULT is unambiguous across every ref namespace. A
   * tag named identically to a branch (`refs/tags/docs` alongside
   * `refs/heads/docs`) forces `:short` to leave one path component in place
   * (`heads/docs`) to disambiguate from the tag -- so the branch walk's own
   * `refs/heads/$b` lookup becomes `refs/heads/heads/docs`, which does not
   * exist, and the branch is reported as a loud, spurious RESCUE_FAILED
   * instead of being rescued. `%(refname:lstrip=2)` strips exactly two path
   * components unconditionally -- safe here because the query is already
   * scoped to `refs/heads` alone, with no cross-namespace ambiguity to guard
   * against. Verified live: `for-each-ref --format='%(refname:short)'
   * refs/heads` prints `heads/docs`, not `docs`, the moment a tag `docs`
   * exists; `:lstrip=2` prints `docs` regardless.
   */
  describe(`#313 Finding 2 (${label}) — a branch same-named as a tag is never a spurious RESCUE_FAILED`, () => {
    test("branch 'docs' has an unpushed commit, and a same-named tag 'docs' also exists: rescued cleanly, never RESCUE_FAILED", () => {
      sh(`cd ${checkout} && git checkout -q -b docs && git commit -q --allow-empty -m "docs branch work" && git checkout -q main`);
      sh(`git -C ${checkout} tag docs`);

      const out = sh(cmdFn(REPO, STUDIO, root)).out;

      expect(out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(out).toMatch(new RegExp(`${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/docs 1 commits`));
    });
  });

  /**
   * #313 Finding 3: `wahead=$(git rev-list --count HEAD --not --remotes
   * 2>/dev/null || echo 0)` cannot distinguish "genuinely zero commits ahead"
   * from a real git failure -- a literal top-level file named `HEAD` (a real,
   * tracked file; nothing to do with `.git/HEAD`) makes a bare `HEAD`
   * argument ambiguous between "the revision HEAD" and "the pathspec HEAD",
   * and git refuses to guess. The old fallback swallows that failure into a
   * false "0 unpushed commits" and silently skips a real push. Verified live:
   * `git rev-list --count HEAD --not --remotes` against a tree with a tracked
   * `HEAD` file and real unpushed commits prints nothing on stdout (exit
   * 128), which `|| echo 0` turns into a bare `0`; resolving `HEAD` to its
   * SHA via `rev-parse` first (never ambiguous -- verified live against the
   * same tree) and using that SHA in the `rev-list` call reports the correct
   * count.
   */
  describe(`#313 Finding 3 (${label}) — a literal top-level file named HEAD never masks a real unpushed commit as zero`, () => {
    test("main checkout has a tracked file literally named HEAD, and a real unpushed commit: rescued, never silently read as RESCUE_CLEAN", () => {
      writeFileSync(join(checkout, "HEAD"), "not a ref -- a real tracked file\n");
      sh(`git -C ${checkout} add HEAD && git -C ${checkout} commit -q -m "add a file named HEAD"`);

      const out = sh(cmdFn(REPO, STUDIO, root)).out;

      expect(out).not.toBe(RESCUE_CLEAN);
      expect(out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} \\S+ 1 commits$`, "m"));
    });
  });
}

/**
 * Board issue #359, measured live 2026-09-26: 4/5 busy acme-life studios'
 * `fleet rescue-all` runs failed "the operation timed out" — one run's own
 * error named the push step itself ("finalize-902 (push)"). Rescue's own
 * `git push` calls have never carried `--no-verify` (see this file's C1
 * comment above: "pushes deliberately do NOT [use --no-verify] — issue #259's
 * own push guard has to see them"), so a slow or hanging `lefthook` pre-push
 * hook configured in the TARGET repo — a hook this fleetflare codebase has no
 * control over — stalls exactly at the push step, matching the measured
 * failure precisely.
 *
 * Fix: `--no-verify` on the push itself, but ONLY when the push target is
 * a generated `fleet/rescue/...` ref — never when it is a real branch name
 * (the main checkout's own current branch, pushed straight there when that
 * branch is not the repo's resolved default; see rescue_target()'s own doc
 * comment above). A real branch push must still go through #259's guard and
 * any repo's own pre-push hook, exactly as before — only the throwaway
 * rescue refs this whole file invents get to skip a hook that has nothing
 * to review.
 *
 * Every OTHER push in both commands (worktree member refs, the branch walk's
 * `checkout/<branch>` refs, the stash walk's `checkout/stash-N` refs, and
 * rescueSnapshotCmd's own snapshot_target() in every mode) is ALREADY,
 * unconditionally, a generated `fleet/rescue/...` ref — verified by reading
 * every push call site in rescue.ts, not assumed — so the shared test below
 * (parametrized across both command builders, same RESCUE_CMDS list used
 * throughout this file) covers the one push shape common to both. The
 * rescuePushCmd-only test after it covers the ONE call site — the main
 * checkout's own branch-vs-default resolution — capable of naming a real
 * branch as its push target, which is exactly the case `--no-verify` must
 * never reach.
 */
describe("#359 — a failing pre-push hook never blocks a rescue push to a generated fleet/rescue/... ref", () => {
  function installFailingPrePushHook(): void {
    const hooksDir = mkdtempSync(join(tmpdir(), "fleet-prepush-hooks-"));
    writeFileSync(join(hooksDir, "pre-push"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooksDir, "pre-push"), 0o755);
    sh(`git -C ${checkout} config core.hooksPath ${hooksDir}`);
  }

  for (const [label, cmdFn] of RESCUE_CMDS) {
    test(`${label}: dirty tree on the DEFAULT branch pushes to a generated fleet/rescue/... ref, bypassing a failing pre-push hook`, () => {
      installFailingPrePushHook();
      writeFileSync(join(checkout, "notes.md"), "real work\n");

      const out = sh(cmdFn(REPO, STUDIO, root)).out;

      expect(out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
    });
  }

  // The mutant this guards against: applying `--no-verify` unconditionally to
  // EVERY push (not only generated refs) would make this test go red for the
  // wrong reason — a real branch push must still be blockable by a repo's own
  // pre-push hook. Only rescuePushCmd's rescue_target() can ever name a real
  // branch as a push target (the checked-out branch, when it is not the
  // repo's resolved default) — rescueSnapshotCmd's snapshot_target() never
  // does, in either mode (see this function's own HOLD-round doc comment).
  test("rescuePushCmd: dirty tree on a REAL (non-default) feature branch still honors a failing pre-push hook — RESCUE_FAILED, never silently bypassed", () => {
    sh(`git -C ${checkout} checkout -q -b task/feature`);
    sh(`git -C ${checkout} push -q origin task/feature`);
    installFailingPrePushHook();
    writeFileSync(join(checkout, "notes.md"), "real work\n");

    const out = sh(rescuePushCmd(REPO, STUDIO, root)).out;

    expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
    expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
  });

  /**
   * Fresh review of PR #359 round 1, Finding 1: `rescue_push()` decided
   * whether to apply `--no-verify` by pattern-matching the RESULTING string
   * (`case "$target" in fleet/rescue/*) ...`), never by tracking which of
   * `rescue_target()`'s own two branches actually produced it. Git branch
   * names may legally contain slashes, so a real, currently-checked-out
   * branch that happens to be named `fleet/rescue/<anything>` (nothing to do
   * with this tool's own generated refs — just a human/agent branch that
   * collides with the naming scheme by coincidence) makes `rescue_target()`
   * return that branch's OWN name unchanged (the "else" arm: not the
   * default), the `case` pattern matches it anyway, and `--no-verify`
   * silently bypasses the target repo's own pre-push hook for a genuine
   * branch push — exactly the failure mode this whole file exists to
   * prevent. The fix threads rescue_target()'s own provenance (which branch
   * of ITS logic ran) through to rescue_push() directly, rather than
   * reconstructing the answer later from the string's shape.
   */
  test("rescuePushCmd: a REAL (non-default) branch that happens to be NAMED fleet/rescue/collision still honors a failing pre-push hook — RESCUE_FAILED, never silently bypassed by string-shape coincidence", () => {
    sh(`git -C ${checkout} checkout -q -b fleet/rescue/collision`);
    sh(`git -C ${checkout} push -q origin fleet/rescue/collision`);
    installFailingPrePushHook();
    writeFileSync(join(checkout, "notes.md"), "real work on a coincidentally-named branch\n");

    const out = sh(rescuePushCmd(REPO, STUDIO, root)).out;

    expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
    expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
  });
});

/**
 * Fresh review of PR #359 round 2 (board issue #359), Finding 1 (the most
 * severe): the round-2 fix only ever bounded the WHOLE multi-push walk
 * (cli/fleet.ts's client-side RESCUE_ALL_STUDIO_TIMEOUT_MS, and the server's
 * own pre-existing EXEC_CLASSES.rescue exec deadline) — a SINGLE stalled
 * `git push` (a slow or hanging pre-push hook in the TARGET repo) still hung
 * the entire exec until that outer 300s deadline fired, at which point
 * `isDeadlineExit` (do.ts's parseRescueExecResult) discards every line this
 * script already printed, INCLUDING which target's push was in flight —
 * exactly the "opaque whole-operation timeout, no step named" gap the fresh
 * review flagged. Fixed at the source: every `git push` in this file now
 * runs under `timeout -k <grace> <seconds>` (see this file's own header
 * comment on RESCUE_PUSH_TIMEOUT_SECONDS), so a single stalled push fails
 * FAST and named (`RESCUE_FAILED <id> push`, the SAME line a rejected push
 * already produces) instead of consuming the whole exec's own budget.
 *
 * `pushTimeoutSeconds` (both command builders' 4th, optional parameter) is
 * the test seam: a SLOW-but-eventually-successful hook (`sleep`, not `exit
 * 1`) that outlives a tiny 1s push budget proves the SCRIPT ITSELF bounds
 * the push — a merely-failing hook (the #359 describe block above) would
 * fail fast on its own regardless of any timeout, so it cannot tell "the
 * push was bounded" apart from "the push failed instantly", which is why
 * this needs its own, separate, slow-not-failing fixture.
 *
 * A `post-receive` hook on the ORIGIN (the bare repo), not a client-side
 * `pre-push` (core.hooksPath, used by the #359 describe block above): every
 * push in this file to a GENERATED `fleet/rescue/...` ref already carries
 * `--no-verify` (round 2's own fix), which skips the CLIENT's own hooks —
 * `pre-push` included — so a client-side hook would never even run for most
 * of this file's push call sites, proving nothing about them. A server-side
 * `post-receive` hook is not something `--no-verify` can skip (it is the
 * REMOTE's own hook, unaffected by any flag the client passes), so it
 * genuinely slows down every push in this file identically, regardless of
 * which of the 8 call sites or which command builder is under test.
 */
// Fresh review of PR #359 round 2: hoisted to module scope (was local to the
// "#359 round 3" describe block below) so the item-3 describe block further
// down — covering the branch-walk and non-fast-forward-retry push call sites
// specifically — can reuse the identical fixture.
function installSlowPostReceiveHook(sleepSeconds: number): void {
  const hooksDir = join(origin, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "post-receive"), `#!/bin/sh\nsleep ${sleepSeconds}\n`);
  chmodSync(join(hooksDir, "post-receive"), 0o755);
}

describe("#359 round 3 — a single stalled push fails fast and named, never hangs the whole rescue walk", () => {
  for (const [label, cmdFn] of RESCUE_CMDS) {
    test(`${label}: a push whose remote-side hook outlives a 1s budget is killed and reported as RESCUE_FAILED <id> push, well before the hook's own 3s sleep elapses`, () => {
      installSlowPostReceiveHook(3);
      writeFileSync(join(checkout, "notes.md"), "real work behind a slow remote hook\n");

      const start = Date.now();
      const out = sh(cmdFn(REPO, STUDIO, root, 1)).out;
      const elapsedMs = Date.now() - start;

      expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
      expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
      // The hook itself sleeps 3s; a genuinely-bounded push returns close to
      // its own 1s budget (+ KILL_GRACE_SECONDS worst case), never anywhere
      // near the hook's full 3s — 2500ms is a generous margin for CI jitter
      // while still cleanly separating "bounded" from "waited out the hook".
      expect(elapsedMs).toBeLessThan(2500);
    });
  }
});

/**
 * Fresh review of PR #359 round 2, item 3: the "#359 round 3" describe block
 * above only ever exercises ONE of rescue.ts's 8 `timeout -k`-wrapped `git
 * push` call sites — `rescue_push()`'s own FIRST attempt (the main
 * checkout's dirty-tree/clean-but-ahead push). Removing the `timeout -k`
 * wrapping from the branch-walk push (N1's `checkout:$b` push) or the
 * non-fast-forward retry push (N3's `$ftarget` fallback) left the whole test
 * suite green — no test proved those two call sites' own wrapping was
 * actually there, let alone load-bearing.
 *
 * Same fixture as the pre-existing N1 ("#263 N1") describe block above,
 * reused here with `installSlowPostReceiveHook` (module-scope now, hoisted
 * from the "#359 round 3" block) instead of that block's own instant-success
 * remote. Unlike N1's branch-walk logic (identical between both command
 * builders — verified by reading rescue.ts's own comment on that shared
 * code), the retry test below is `rescuePushCmd`-only, matching "#263 N3"'s
 * own precedent: `rescueSnapshotCmd`'s `snapshot_target()` ALWAYS returns a
 * freshly generated ref for the checkout-mode dirty-tree push (never the
 * checked-out branch's own name), so its FIRST attempt can never be rejected
 * non-fast-forward by a real branch collision the way `rescuePushCmd`'s own
 * `rescue_push()` first attempt can — there is no real-branch-collision
 * fixture that reaches `rescueSnapshotCmd`'s own retry call site at all.
 * Confirmed live: parametrizing this second test across both builders made
 * the `rescueSnapshotCmd` copy pass even with line 855's own wrapping
 * removed — its FIRST attempt (still wrapped, at line 848, targeting the
 * already-fresh generated ref) was what produced the correct RESCUE_FAILED,
 * never reaching the retry branch this test meant to isolate. Scoped to
 * `rescuePushCmd` only, exactly like N3 above, to avoid a parametrized test
 * that looks like it covers both builders' retry sites but only genuinely
 * exercises one.
 */
describe("#359 round 2 review, item 3 — the branch-walk and non-fast-forward-retry push call sites are ALSO bounded, not only rescue_push()'s first attempt", () => {
  for (const [label, cmdFn] of RESCUE_CMDS) {
    test(`${label}: N1's branch-walk push (a local branch not checked out anywhere) is killed and reported as RESCUE_FAILED, never waits out the hook's own 3s sleep`, () => {
      // Same fixture as "#263 N1"'s own first test: a branch with a real
      // unpushed commit, not checked out anywhere, walked from the main
      // checkout — but here the origin's own post-receive hook is slow, and
      // the command builder's pushTimeoutSeconds seam is tiny.
      sh(`cd ${checkout} && git checkout -q -b feat && git commit -q --allow-empty -m "feat work" && git checkout -q main`);
      installSlowPostReceiveHook(3);

      const start = Date.now();
      const out = sh(cmdFn(REPO, STUDIO, root, 1)).out;
      const elapsedMs = Date.now() - start;

      expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout:feat push$`, "m"));
      expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
      // Same margin as the "#359 round 3" test above: bounded near the 1s
      // budget (+ KILL_GRACE_SECONDS), never anywhere near the hook's full 3s.
      expect(elapsedMs).toBeLessThan(2500);
    });
  }

  test("rescuePushCmd: rescue_push()'s own non-fast-forward RETRY push is killed and reported as RESCUE_FAILED, never waits out the hook's own 3s sleep", () => {
    // Same fixture as "#263 N3": the checked-out branch moved on origin
    // since this checkout last knew about it, so the FIRST push attempt is
    // rejected non-fast-forward (instantly — the hook never runs for a
    // rejected push, since `post-receive` only fires once a push actually
    // updates refs) and rescue_push() retries to a freshly generated
    // `-nff-` fallback ref, which DOES land — and DOES trigger the slow
    // hook. Isolates the RETRY's own `timeout -k` wrapping specifically,
    // never the first attempt's.
    sh(`cd ${checkout} && git checkout -q -b task/lead && git push -q origin task/lead`);
    const otherClone = join(dir, "other-clone-item3-retry");
    sh(`git clone -q ${origin} ${otherClone}`);
    sh(`cd ${otherClone} && git checkout -q task/lead && git commit -q --allow-empty -m "someone else moved this branch" && git push -q origin task/lead`);
    installSlowPostReceiveHook(3);
    writeFileSync(join(checkout, "notes.md"), "lead work racing a slow retry push\n");

    const start = Date.now();
    const out = sh(rescuePushCmd(REPO, STUDIO, root, 1)).out;
    const elapsedMs = Date.now() - start;

    expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
    expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
    expect(elapsedMs).toBeLessThan(2500);
  });
});

/**
 * Maestro's PR #362 round 3 review, minor/optional item: the "#359 round 2
 * review, item 3" describe block above covers the branch-walk push
 * (rescue.ts:651/997) and rescue_push()'s own non-fast-forward retry push
 * (rescue.ts:419/855), but neither command builder's STASH-walk push
 * (rescue.ts:701, rescueSnapshotCmd's near-identical copy at rescue.ts:1031)
 * had a dedicated per-push-timeout test — same "#263 N2" fixture (a stash
 * entry, always pushed to a generated `fleet/rescue/.../checkout/stash-N`
 * ref, unconditionally `--no-verify`) as the pre-existing stash tests above,
 * reused here with `installSlowPostReceiveHook` instead of an instant-success
 * remote, exactly like the branch-walk test's own adaptation of "#263 N1".
 */
describe("#362 round 3 review — the stash-walk push call site is ALSO bounded, not only the branch-walk and rescue_push() call sites", () => {
  for (const [label, cmdFn] of RESCUE_CMDS) {
    test(`${label}: a stash entry pushed to a slow remote hook is killed and reported as RESCUE_FAILED checkout:stash-0 push, never waits out the hook's own 3s sleep`, () => {
      // Same fixture as "#263 N2"'s own second test: a real stash entry in
      // the main checkout, with a real diff (never touches the stash itself),
      // pushed to a generated fleet/rescue/.../checkout/stash-0 ref — but
      // here the origin's own post-receive hook is slow, and the command
      // builder's pushTimeoutSeconds seam is tiny.
      writeFileSync(join(checkout, "wip.md"), "stash me\n");
      sh(`git -C ${checkout} add wip.md && git -C ${checkout} stash -q`);
      installSlowPostReceiveHook(3);

      const start = Date.now();
      const out = sh(cmdFn(REPO, STUDIO, root, 1)).out;
      const elapsedMs = Date.now() - start;

      expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout:stash-0 push$`, "m"));
      expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
      // Same margin as the other "bounded, not waited-out" tests above:
      // close to the 1s budget (+ KILL_GRACE_SECONDS), never anywhere near
      // the hook's full 3s.
      expect(elapsedMs).toBeLessThan(2500);
    });
  }
});

/**
 * Board issue #371 (#362 follow-up review): each stalled push already costs
 * up to `pushTimeoutSeconds + KILL_GRACE_SECONDS` (this file's own header
 * comment) — but nothing previously stopped rescue.ts from STARTING a new
 * push once too little of the server's own EXEC_CLASSES.rescue deadline
 * (sandbox-api.ts, 300s default) remained. >=6 stalled pushes (6 * 50s =
 * 300s in production) can exhaust the whole exec, and do.ts's own
 * `isDeadlineExit` then discards EVERY line this script already printed —
 * including already-successful RESCUE_PUSHED lines from earlier worktrees in
 * the SAME run — as untrustworthy, with no indication of which
 * worktree/branch/stash was even in flight.
 *
 * `rescue_budget_ok` (rescue.ts) is checked once before every logical push
 * attempt (a first try together with its own immediate non-fast-forward
 * retry counts as one — they run back-to-back with no new iteration between
 * them). Once too little of `serverDeadlineSeconds` (5th, optional
 * parameter — a test seam, same convention as `pushTimeoutSeconds`;
 * production always uses the real default, 300) remains for even ONE more
 * push's own worst case (`pushTimeoutSeconds + KILL_GRACE_SECONDS`), every
 * remaining worktree is reported `RESCUE_FAILED <id> budget <n> not
 * attempted` WITHOUT ever starting its own doomed push, instead of silently
 * hanging for its own full stall.
 *
 * 7 member worktrees, each genuinely dirty, each pushing to a generated ref
 * behind the SAME slow (`sleep 3`) `post-receive` hook this file's own #359
 * round 3 fixture already uses (`installSlowPostReceiveHook`) — the issue's
 * own "test with 7 stalled pushes". Each worktree's push runs through
 * `rescue_one`'s own dirty-tree branch, one of the 4 call sites the #371
 * review's own Finding 1 doubled the threshold at (see rescue.ts's own
 * RESCUE_SERVER_DEADLINE_SECONDS doc comment) — `mult=2` applies there
 * regardless of whether THIS particular worktree's push can actually retry
 * (a member's target is always freshly generated and never rejected
 * non-fast-forward in practice), because the budget guard is parameterized
 * per CALL SITE, not per runtime outcome.
 *
 * PR #376 review (maestro, flaky on Mac — 4/5 failures observed): the
 * original `serverDeadlineSeconds=14` sat EXACTLY on the doubled threshold
 * (`2 * (pushTimeoutSeconds(2) + KILL_GRACE_SECONDS(5)) = 14`) — `remaining`
 * (computed from `date +%s`, whole-second truncation, never rounding) needed
 * to land at precisely 14 vs 13 for the second worktree's check to pass or
 * fail, a real sub-second timing race that a loaded/unevenly-scheduled
 * machine can flip either way. `serverDeadlineSeconds=17` gives ~3s of slack
 * clear of that exact boundary. Recomputed empirically (this file's own real
 * git + real slow-hook fixture, not hand-derived): with the extra margin,
 * remaining after the first stalled-and-killed push (~2 real seconds) is
 * still >= 14, so a SECOND push is also let through before the third
 * worktree's own check finally reads remaining < 14 and starts skipping —
 * 2 pushes attempted and killed, 5 skipped as budget failures, still nowhere
 * near the 7 * (pushTimeoutSeconds + KILL_GRACE_SECONDS) a fully serial,
 * unguarded walk would cost.
 */
describe("#371 (#362 follow-up) — budget guard: rescue never starts a push it cannot finish before the exec's own outer server deadline", () => {
  for (const [label, cmdFn] of RESCUE_CMDS) {
    test(`${label}: 7 stalled worktree pushes — a couple are attempted and killed, the rest are skipped as RESCUE_FAILED <id> budget <n> not attempted, never hanging for their own full stall`, () => {
      const ids: string[] = [];
      for (let i = 1; i <= 7; i++) {
        const name = `wt${i}`;
        const wtPath = join(checkout, ".claude/worktrees", name);
        sh(`git -C ${checkout} worktree add -q ${wtPath} -b ${name}`);
        writeFileSync(join(wtPath, "wip.md"), `member work ${i}\n`);
        ids.push(name);
      }
      installSlowPostReceiveHook(3);

      const start = Date.now();
      // budgetMarginSeconds=0: this test's own pushFails/budgetFails counts
      // are hand-derived against the exact zero-margin threshold math (see
      // this describe block's own doc comment) — production's own
      // RESCUE_BUDGET_MARGIN_SECONDS default is exercised separately (rescue.ts).
      const out = sh(cmdFn(REPO, STUDIO, root, 2, 17, 0)).out;
      const elapsedMs = Date.now() - start;

      const pushFails = ids.filter((id) => new RegExp(`^${RESCUE_FAILED_PREFIX} ${id} push$`, "m").test(out));
      const budgetFails = ids.filter((id) => new RegExp(`^${RESCUE_FAILED_PREFIX} ${id} budget -?\\d+ not attempted$`, "m").test(out));

      expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
      expect(pushFails.length).toBe(2);
      expect(budgetFails.length).toBe(5);
      expect(pushFails.length + budgetFails.length).toBe(7);
      // The real point: this must be fast — 7 genuinely stalled pushes at
      // ~7 * (pushTimeoutSeconds + KILL_GRACE_SECONDS) each would take well
      // over a minute; the budget guard keeps this to roughly one push's own
      // worst case, not seven.
      expect(elapsedMs).toBeLessThan(8000);
    }, 15000);
  }
});

/**
 * Fresh review of the #371 fix above, Finding 1 [BLOCKING]: every test in the
 * "#371 (#362 follow-up)" describe block above uses only MEMBER worktrees,
 * whose target is always a freshly-generated `fleet/rescue/.../wt/<id>-<ts>`
 * ref (rescue_target()'s own `mode = "member"` branch) — a ref with no
 * existing tip on origin, so it can never be rejected non-fast-forward and
 * `rescue_push()`'s own retry branch is structurally unreachable from any of
 * those fixtures. That left `rescue_budget_ok`'s threshold unproven against
 * the ACTUAL worst case rescue_push() can hit at these two call sites (the
 * dirty-tree and clean-but-ahead branches of `rescue_one`, in BOTH command
 * builders): a first attempt AND its own immediate non-fast-forward retry,
 * each independently bounded by its own `pushTimeoutSeconds + KILL_GRACE_SECONDS`
 * — up to `2 * (pushTimeoutSeconds + KILL_GRACE_SECONDS)` combined, not the
 * single-push figure the pre-fix threshold budgeted for.
 *
 * Same real-non-fast-forward fixture as "#263 N3" above (a checked-out,
 * non-default branch — `task/lead` — pushed-to from a second clone so this
 * checkout's own first attempt is genuinely rejected `(fetch first)`, forcing
 * `rescue_push()` into its retry branch against a freshly generated `-nff-`
 * fallback ref), PLUS a slow `post-receive` hook on the retry's own
 * destination so the retry itself takes real, measurable wall-clock time
 * (the rejected first attempt is instant — a rejected push never reaches the
 * remote's `post-receive` hook at all, verified by every pre-existing N3/#359
 * fixture's own comments above).
 *
 * Scoped to `rescuePushCmd` only, matching "#359 round 2 review, item 3"'s own
 * precedent (see that describe block's own comment): `rescueSnapshotCmd`'s
 * dirty-tree/clean-but-ahead pushes always target a freshly generated
 * `snapshot_target()` ref, so a real non-fast-forward rejection forcing its
 * retry branch has no equivalent fixture — parametrizing this test across both
 * builders would silently exercise only `rescuePushCmd`'s retry path while
 * looking like it covered both.
 *
 * `pushTimeoutSeconds=2` (`threshold_single = 2 + KILL_GRACE_SECONDS = 7`,
 * `threshold_double = 2 * 7 = 14`):
 *   (a) `serverDeadlineSeconds=doubledThreshold + 3` — comfortably clear of
 *       the DOUBLED threshold at the very top of the walk (`remaining` starts
 *       at `serverDeadlineSeconds`, nothing has elapsed yet), rather than
 *       sitting exactly on it. PR #376 review (maestro): the original
 *       `serverDeadlineSeconds=doubledThreshold` (no margin) put `remaining`
 *       right at 14 vs 13 depending on how long git's own setup work before
 *       the first check took — `date +%s` truncates, not rounds, so that's a
 *       real sub-second race, not a hypothetical one (4/5 Mac failures
 *       observed). ~3s of slack here keeps the checkpoint reliably let
 *       through without changing what this test proves: the checkpoint is
 *       let through, the instant-reject-then-retry pair runs, and the
 *       eventually-successful (if slow) retry lands as a real RESCUE_PUSHED,
 *       never a budget skip.
 *   (b) `serverDeadlineSeconds=10` — strictly between the single (7) and
 *       doubled (14) thresholds: enough remaining for ONE push's own worst
 *       case, but not for a first-attempt-plus-retry pair. Before this fix,
 *       `rescue_budget_ok` compared `remaining` only against the SINGLE
 *       threshold and let this through (10 >= 7) — exactly the undercount
 *       Finding 1 named. After the fix, the checkpoint is skipped up front,
 *       `RESCUE_FAILED checkout budget 10 not attempted`, and rescue_push()
 *       never runs at all (no RESCUE_PUSHED, no push-hook side effect).
 */
describe("#371 review Finding 1 — the budget guard doubles its threshold at rescue_push()'s own retry-capable call sites", () => {
  function setUpNonFastForwardRetryFixture(hookSleepSeconds: number): void {
    sh(`cd ${checkout} && git checkout -q -b task/lead && git push -q origin task/lead`);
    const otherClone = join(dir, "other-clone-371-budget");
    sh(`git clone -q ${origin} ${otherClone}`);
    sh(`cd ${otherClone} && git checkout -q task/lead && git commit -q --allow-empty -m "someone else moved this branch" && git push -q origin task/lead`);
    // The rejected FIRST attempt never reaches this hook (a rejected push
    // updates no ref, so post-receive never fires) -- only the retry's own
    // push to the generated -nff- fallback ref does, so this sleep measures
    // the RETRY's own timeout budget specifically, never the first attempt's.
    installSlowPostReceiveHook(hookSleepSeconds);
    writeFileSync(join(checkout, "notes.md"), "lead work racing a slow retry push, budget-guard review\n");
  }

  test(`rescuePushCmd: remaining budget covers the DOUBLED (retry-pair) threshold — the checkpoint is let through and the slow-but-successful retry lands as RESCUE_PUSHED`, () => {
    setUpNonFastForwardRetryFixture(1);
    const pushTimeoutSeconds = 2;
    const doubledThreshold = 2 * (pushTimeoutSeconds + KILL_GRACE_SECONDS);
    // ~3s slack clear of the exact doubled-threshold boundary — see this
    // describe block's own doc comment, case (a) (PR #376 review, maestro).
    const marginSeconds = 3;

    // budgetMarginSeconds=0: this test's own margin is the explicit
    // `marginSeconds` above, kept independent of production's own
    // RESCUE_BUDGET_MARGIN_SECONDS default (rescue.ts) so this test's exact
    // threshold math stays legible.
    const out = sh(rescuePushCmd(REPO, STUDIO, root, pushTimeoutSeconds, doubledThreshold + marginSeconds, 0)).out;

    expect(out).not.toContain("budget");
    expect(out).not.toContain(`${RESCUE_FAILED_PREFIX} checkout`);
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/checkout-nff-\\d{14} 1 files$`, "m"));
  });

  test(`rescuePushCmd: remaining budget covers only a SINGLE push (between the single and doubled thresholds) — the checkpoint is skipped as RESCUE_FAILED checkout budget <n> not attempted, never allowed to attempt the retry`, () => {
    setUpNonFastForwardRetryFixture(1);
    const pushTimeoutSeconds = 2;
    const singleThreshold = pushTimeoutSeconds + KILL_GRACE_SECONDS;
    const doubledThreshold = 2 * singleThreshold;
    const serverDeadlineSeconds = Math.floor((singleThreshold + doubledThreshold) / 2);
    expect(serverDeadlineSeconds).toBeGreaterThanOrEqual(singleThreshold);
    expect(serverDeadlineSeconds).toBeLessThan(doubledThreshold);

    const start = Date.now();
    // budgetMarginSeconds=0: keeps this test's own single-vs-doubled midpoint
    // math (above) exact, independent of production's own
    // RESCUE_BUDGET_MARGIN_SECONDS default (rescue.ts).
    const out = sh(rescuePushCmd(REPO, STUDIO, root, pushTimeoutSeconds, serverDeadlineSeconds, 0)).out;
    const elapsedMs = Date.now() - start;

    expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout budget ${serverDeadlineSeconds} not attempted$`, "m"));
    expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
    // Never even attempted the first push (let alone the retry) -- fast,
    // nowhere near the hook's own 1s sleep, let alone pushTimeoutSeconds.
    expect(elapsedMs).toBeLessThan(1000);
  });
});

// Issue #335 (public-release scrub): the git identity used to be a bare
// hardcoded real-name literal in rescue.ts's own source, which would have
// shipped in the public export. Now an optional trailing param
// (this file's own established "trailing optional param, same absence =
// today's behavior" shape, see do.ts), neutral default "fleetflare[bot]"
// when the caller passes nothing.
describe("issue #335 — the rescue commit's git identity is configurable, neutral by default", () => {
  // This file's own `sh()` forces GIT_AUTHOR_NAME/EMAIL="t"/"t@t" for every
  // invocation (deterministic commits for the OTHER tests here, none of
  // which care about author identity) — those env vars take priority over
  // rescue.ts's own `-c user.name=...` in real git, which would silently
  // mask exactly the behavior these tests exist to prove. A dedicated
  // runner that leaves them unset, so rescue.ts's own `-c` flags are what
  // actually decides the commit's author here.
  function shRealIdentity(cmd: string): { code: number; out: string } {
    const r = Bun.spawnSync({
      cmd: ["bash", "-c", cmd], cwd: dir, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, PATH: BASE_PATH },
    });
    return { code: r.exitCode ?? -1, out: r.stdout.toString().trim() };
  }

  test("rescuePushCmd with no override commits as the neutral default identity", () => {
    writeFileSync(join(checkout, "dirty.txt"), "x");
    expect(shRealIdentity(rescuePushCmd(REPO, STUDIO, root)).out).toContain(RESCUE_PUSHED_PREFIX);
    const [ref] = rescueRefs();
    const author = shRealIdentity(`git -C ${origin} log --format='%an <%ae>' -1 ${ref}`).out;
    expect(author).toBe("fleetflare[bot] <fleetflare[bot]@users.noreply.github.com>");
  });

  test("rescuePushCmd with an explicit botName/botEmail commits under THAT identity instead", () => {
    writeFileSync(join(checkout, "dirty2.txt"), "x");
    const out = shRealIdentity(
      rescuePushCmd(
        REPO, STUDIO, root, RESCUE_PUSH_TIMEOUT_SECONDS, RESCUE_SERVER_DEADLINE_SECONDS, RESCUE_BUDGET_MARGIN_SECONDS,
        "acme-bot[bot]", "acme-bot[bot]@users.noreply.github.com",
      ),
    ).out;
    expect(out).toContain(RESCUE_PUSHED_PREFIX);
    const [ref] = rescueRefs();
    const author = shRealIdentity(`git -C ${origin} log --format='%an <%ae>' -1 ${ref}`).out;
    expect(author).toBe("acme-bot[bot] <acme-bot[bot]@users.noreply.github.com>");
  });

  test("rescueSnapshotCmd with no override commits as the neutral default identity", () => {
    writeFileSync(join(checkout, "dirty3.txt"), "x");
    const out = shRealIdentity(rescueSnapshotCmd(REPO, STUDIO, root)).out;
    expect(out).toContain(RESCUE_PUSHED_PREFIX);
    const [ref] = rescueRefs();
    const author = shRealIdentity(`git -C ${origin} log --format='%an <%ae>' -1 ${ref}`).out;
    expect(author).toBe("fleetflare[bot] <fleetflare[bot]@users.noreply.github.com>");
  });
});

// Issue #1 piece 5: origin can be PUBLIC. With `remoteUrl` set, every rescue
// push (rescue_push + its nff retry, branch walk, stash walk, both builders)
// lands on that private remote instead. Private pushes run the REAL git by
// absolute path (`realGit`), past the leak-gate wrapper: a private rescue
// never loses data. `realGit` applies ONLY there: origin pushes use plain
// `git` on PATH (the wrapper), leak-gated -- see rescue-leak-gate.test.ts.
describe("issue #1 — rescue pushes go to a configurable private remote, never origin", () => {
  let priv: string;
  // Issue #8: the explicit PATH is load-bearing. No-options Bun.which reads
  // the startup PATH, not the preload's real-git shim (real-git-preload.ts),
  // so in a studio it returned the leak-gate wrapper; the wrapper's unborn-HEAD
  // refusal hid "(fetch first)" and the -nff retry never ran.
  const REAL_GIT = Bun.which("git", { PATH: process.env.PATH }) ?? "/usr/bin/git";

  beforeEach(() => {
    priv = join(dir, "private.git");
    sh(`git init -q --bare -b main ${priv}`);
  });

  function privRefs(): string[] {
    return sh(`git -C ${priv} for-each-ref --format='%(refname)' refs/heads/`).out.split("\n").filter(Boolean);
  }
  function pushPriv(opts: { realGit?: string } = {}): string {
    return sh(rescuePushCmd(REPO, STUDIO, root, undefined, undefined, undefined, undefined, undefined,
      { remoteUrl: priv, realGit: opts.realGit ?? REAL_GIT })).out;
  }
  function snapPriv(): string {
    return sh(rescueSnapshotCmd(REPO, STUDIO, root, undefined, undefined, undefined, undefined, undefined,
      { remoteUrl: priv, realGit: REAL_GIT })).out;
  }

  test("rescuePushCmd, dirty main checkout: the rescue ref lands on the private remote, NOT origin", () => {
    writeFileSync(join(checkout, "notes.md"), "private work\n");

    const out = pushPriv();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
    const [ref] = privRefs().filter((r) => r.includes("fleet/rescue/"));
    expect(ref).toBeDefined();
    expect(sh(`git -C ${priv} ls-tree -r --name-only ${ref}`).out.split("\n")).toContain("notes.md");
    expect(rescueRefs()).toEqual([]);
  });

  // Issue #7 review, finding 4: proxy mode sets a global pushInsteadOf that
  // rewrites every github.com push to the Worker -- the rescue URL too. The
  // rescue push pins its own URL (longest pushInsteadOf match wins).
  test("rescuePushCmd: an ambient pushInsteadOf covering the private remote does not redirect it", () => {
    sh(`git -C ${checkout} config url./nonexistent/hijack/.pushInsteadOf ${dir}/`);
    writeFileSync(join(checkout, "notes.md"), "private work\n");

    const out = pushPriv();

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    expect(privRefs().some((r) => r.includes("fleet/rescue/"))).toBe(true);
  });

  test("rescuePushCmd, dirty member worktree: its wt/ ref lands on the private remote, NOT origin", () => {
    writeFileSync(join(checkout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out = pushPriv();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1 files$`, "m"));
    expect(privRefs().some((r) => r.includes("/wt/agent-a1b2-"))).toBe(true);
    expect(rescueRefs()).toEqual([]);
  });

  test("rescuePushCmd, real feature branch: pushed under its own name to the private remote; origin never gets the branch", () => {
    sh(`git -C ${checkout} checkout -q -b task/lead`);
    writeFileSync(join(checkout, "notes.md"), "lead work\n");

    const out = pushPriv();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} task/lead 1 files$`, "m"));
    expect(privRefs()).toContain("refs/heads/task/lead");
    expect(sh(`git -C ${origin} for-each-ref --format='%(refname)' refs/heads/task/lead`).out).toBe("");
  });

  test("rescuePushCmd, non-fast-forward on the private remote: the -nff fallback ALSO lands on the private remote", () => {
    sh(`git -C ${checkout} checkout -q -b task/lead`);
    const other = join(dir, "other-clone");
    sh(`git clone -q ${origin} ${other} 2>/dev/null && git -C ${other} checkout -q -b task/lead && git -C ${other} commit -q --allow-empty -m moved && git -C ${other} push -q ${priv} task/lead`);
    writeFileSync(join(checkout, "notes.md"), "lead work that must not be lost\n");

    const out = pushPriv();

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/checkout-nff-\\d{14} 1 files$`, "m"));
    const fallback = privRefs().find((r) => r.includes("-nff-"));
    expect(fallback).toBeDefined();
    expect(sh(`git -C ${priv} rev-parse ${fallback}`).out).toBe(sh(`git -C ${checkout} rev-parse HEAD`).out);
    expect(rescueRefs()).toEqual([]);
  });

  test("rescuePushCmd, branch walk: a not-checked-out branch's commits land on the private remote, NOT origin", () => {
    sh(`cd ${checkout} && git checkout -q -b feat && git commit -q --allow-empty -m "feat work" && git checkout -q main`);

    const out = pushPriv();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/feat 1 commits$`, "m"));
    const featRef = privRefs().find((r) => r.endsWith("/checkout/feat"));
    expect(featRef).toBeDefined();
    expect(sh(`git -C ${priv} rev-parse ${featRef}`).out).toBe(sh(`git -C ${checkout} rev-parse feat`).out);
    expect(rescueRefs()).toEqual([]);
  });

  test("rescuePushCmd, stash walk: a stash entry lands on the private remote, NOT origin", () => {
    writeFileSync(join(checkout, "a.md"), "stash me\n");
    sh(`git -C ${checkout} add a.md && git -C ${checkout} stash -q`);

    const out = pushPriv();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/\\d{14}/checkout/stash-0 1 files$`, "m"));
    expect(privRefs().some((r) => r.endsWith("/checkout/stash-0"))).toBe(true);
    expect(rescueRefs()).toEqual([]);
  });

  test("rescuePushCmd, private remote: a second run pushes nothing new (local bookkeeping still marks the ref pushed)", () => {
    writeFileSync(join(checkout, "notes.md"), "once\n");
    expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
    const refs = privRefs();

    expect(pushPriv()).not.toContain(RESCUE_PUSHED_PREFIX);
    expect(privRefs()).toEqual(refs);
  });

  // Issue #16: provision clones `--depth 1`. An empty private remote rejects
  // a shallow push ("shallow update not allowed") -- it lacks the parents
  // behind the shallow boundary. Rescue now pushes a parentless snapshot of
  // the same tree instead: the content survives, the history cut does not.
  describe("issue #16 — a --depth 1 checkout still rescues to an empty private remote", () => {
    beforeEach(() => {
      const origin3 = join(dir, "origin3.git");
      const seed = join(dir, "seed");
      sh(`git init -q --bare -b main ${origin3}`);
      sh(`git clone -q ${origin3} ${seed} 2>/dev/null; cd ${seed} && ` +
        `for f in a b c; do echo "$f" > "$f.md" && git add "$f.md" && git commit -q -m "$f"; done && git push -q origin HEAD:main`);
      rmSync(checkout, { recursive: true, force: true });
      sh(`git clone -q --depth 1 file://${origin3} ${checkout}`);
      expect(sh(`git -C ${checkout} rev-parse --is-shallow-repository`).out).toBe("true");
    });

    function privTreeFiles(ref: string): string[] {
      return sh(`git -C ${priv} ls-tree -r --name-only ${ref}`).out.split("\n").filter(Boolean);
    }

    test("rescuePushCmd, dirty shallow checkout: RESCUE_PUSHED, and the private ref holds the whole tree plus the dirty file", () => {
      writeFileSync(join(checkout, "notes.md"), "shallow work\n");

      const out = pushPriv();

      expect(out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
      const ref = privRefs().find((r) => r.includes("fleet/rescue/"));
      expect(ref).toBeDefined();
      expect(privTreeFiles(ref!)).toEqual(["a.md", "b.md", "c.md", "notes.md"]);
      expect(sh(`git -C ${priv} show ${ref}:notes.md`).out).toBe("shallow work");
      expect(sh(`git -C ${priv} rev-parse ${ref}^{tree}`).out).toBe(sh(`git -C ${checkout} rev-parse HEAD^{tree}`).out);
    });

    test("rescuePushCmd, clean-but-ahead shallow checkout: RESCUE_PUSHED, and the private ref holds HEAD's exact tree", () => {
      writeFileSync(join(checkout, "d.md"), "d\n");
      sh(`git -C ${checkout} add d.md && git -C ${checkout} commit -q -m d`);

      const out = pushPriv();

      expect(out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 commits$`, "m"));
      const ref = privRefs().find((r) => r.includes("fleet/rescue/"));
      expect(ref).toBeDefined();
      expect(sh(`git -C ${priv} rev-parse ${ref}^{tree}`).out).toBe(sh(`git -C ${checkout} rev-parse HEAD^{tree}`).out);
      expect(privTreeFiles(ref!)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    });

    test("rescueSnapshotCmd, dirty shallow checkout: RESCUE_PUSHED, and the private ref holds the dirty file", () => {
      writeFileSync(join(checkout, "notes.md"), "live shallow work\n");

      const out = snapPriv();

      expect(out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
      const ref = privRefs().find((r) => r.includes("fleet/rescue/"));
      expect(ref).toBeDefined();
      expect(privTreeFiles(ref!)).toEqual(["a.md", "b.md", "c.md", "notes.md"]);
      expect(sh(`git -C ${priv} show ${ref}:notes.md`).out).toBe("live shallow work");
    });

    // PR #31 review MEDIUM: the shallow fallback adds pushes past the two the
    // caller's budget check reserved (first try + -nff retry). Each extra push
    // is budget-checked too, so none starts past the server deadline -- the
    // worktree is a confirmed RESCUE_FAILED instead of an exec killed mid-run.
    test("rescuePushCmd, shallow + non-fast-forward: a push the budget cannot cover is never started", () => {
      const realTimeout = Bun.which("timeout", { PATH: BASE_PATH });
      expect(realTimeout).not.toBeNull();
      const slowDir = join(dir, "slow-timeout");
      mkdirSync(slowDir);
      writeFileSync(join(slowDir, "timeout"), `#!/bin/sh\nsleep 5\nexec '${realTimeout}' "$@"\n`);
      chmodSync(join(slowDir, "timeout"), 0o755);
      // An unrelated history on the private remote's task/lead: the first push
      // is rejected, and so is its snapshot, forcing the -nff path.
      const orphan = join(dir, "orphan");
      sh(`git init -q -b task/lead ${orphan} && cd ${orphan} && git commit -q --allow-empty -m other && git push -q ${priv} task/lead`);
      sh(`git -C ${checkout} checkout -q -b task/lead`);
      writeFileSync(join(checkout, "notes.md"), "work\n");
      const pushTimeoutSeconds = 3;
      const single = pushTimeoutSeconds + KILL_GRACE_SECONDS;
      // Caller's check (2 pushes) passes; after two 5s-slow pushes, less than
      // one push of budget is left.
      const serverDeadlineSeconds = 2 * single + 1;

      const out = sh(rescuePushCmd(REPO, STUDIO, root, pushTimeoutSeconds, serverDeadlineSeconds, 0, undefined, undefined,
        { remoteUrl: priv, realGit: REAL_GIT }), dir, { PATH: `${slowDir}:${BASE_PATH}` }).out;

      expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
      expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
    }, 60_000);

    // PR #31 review HIGH: the branch walk and stash walk pushed raw, so a
    // shallow checkout with an ahead side branch or any stash failed forever.
    for (const [label, run] of [["rescuePushCmd", () => pushPriv()], ["rescueSnapshotCmd", () => snapPriv()]] as const) {
      test(`${label}, shallow checkout with an ahead side branch and a stash: both land on the private remote with the right trees`, () => {
        sh(`cd ${checkout} && git checkout -q -b feat && echo f > f.md && git add f.md && git commit -q -m feat && git checkout -q main`);
        writeFileSync(join(checkout, "s.md"), "stash me\n");
        sh(`git -C ${checkout} add s.md && git -C ${checkout} stash -q`);
        const featTree = sh(`git -C ${checkout} rev-parse feat^{tree}`).out;
        const stashTree = sh(`git -C ${checkout} rev-parse 'stash@{0}^{tree}'`).out;

        const out = run();

        expect(out).not.toContain(RESCUE_FAILED_PREFIX);
        const refs = privRefs();
        const feat = refs.find((r) => r.endsWith("/checkout/feat"));
        const stash = refs.find((r) => r.endsWith("/checkout/stash-0"));
        expect(feat).toBeDefined();
        expect(stash).toBeDefined();
        expect(sh(`git -C ${priv} rev-parse ${feat}^{tree}`).out).toBe(featTree);
        expect(sh(`git -C ${priv} rev-parse ${stash}^{tree}`).out).toBe(stashTree);
        expect(sh(`git -C ${priv} show ${stash}:s.md`).out).toBe("stash me");
      });
    }
  });

  test("rescueSnapshotCmd: dirty tree, branch walk and stash walk all land on the private remote, NOT origin", () => {
    writeFileSync(join(checkout, "notes.md"), "snap\n");
    sh(`cd ${checkout} && git checkout -q -b feat && git commit -q --allow-empty -m "feat work" && git checkout -q main`);
    writeFileSync(join(checkout, "s.md"), "stash me\n");
    sh(`git -C ${checkout} add s.md && git -C ${checkout} stash -q`);
    writeFileSync(join(checkout, "notes.md"), "snap\n");

    const out = snapPriv();

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
    const refs = privRefs();
    expect(refs.some((r) => new RegExp(`fleet/rescue/${STUDIO}-\\d{14}$`).test(r))).toBe(true);
    expect(refs.some((r) => r.endsWith("/checkout/feat"))).toBe(true);
    expect(refs.some((r) => r.endsWith("/checkout/stash-0"))).toBe(true);
    expect(rescueRefs()).toEqual([]);
  });

  test("rescueSnapshotCmd, dirty member worktree: its wt/ ref lands on the private remote, NOT origin", () => {
    writeFileSync(join(checkout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");

    const out = snapPriv();

    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/agent-a1b2-\\d{14} 1 files$`, "m"));
    expect(privRefs().some((r) => r.includes("/wt/agent-a1b2-"))).toBe(true);
    expect(rescueRefs()).toEqual([]);
  });

  test("rescueSnapshotCmd, its generated ref already taken on the private remote: the -nff fallback ALSO lands there", () => {
    const shimDir = join(dir, "date-shim");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "date"),
      "#!/bin/sh\nif [ \"$1\" = \"-u\" ] && [ \"$2\" = \"+%Y%m%d%H%M%S\" ]; then echo 20260925120000; exit 0; fi\n" +
      "for d in /bin/date /usr/bin/date; do [ -x \"$d\" ] && exec \"$d\" \"$@\"; done\n");
    chmodSync(join(shimDir, "date"), 0o755);
    const other = join(dir, "other-clone");
    sh(`git clone -q ${origin} ${other} 2>/dev/null && git -C ${other} commit -q --allow-empty -m squat && git -C ${other} push -q ${priv} HEAD:refs/heads/fleet/rescue/${STUDIO}-20260925120000`);
    writeFileSync(join(checkout, "notes.md"), "snap\n");

    const out = sh(rescueSnapshotCmd(REPO, STUDIO, root, undefined, undefined, undefined, undefined, undefined,
      { remoteUrl: priv, realGit: REAL_GIT }), dir, { PATH: `${shimDir}:${BASE_PATH}` }).out;

    expect(out).not.toContain(RESCUE_FAILED_PREFIX);
    expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}/wt/checkout-nff-20260925120000 1 files$`, "m"));
    expect(privRefs()).toContain(`refs/heads/fleet/rescue/${STUDIO}/wt/checkout-nff-20260925120000`);
    expect(rescueRefs()).toEqual([]);
  });

  test("remoteUrl unset: rescue still goes to origin, as before", () => {
    writeFileSync(join(checkout, "notes.md"), "origin work\n");

    const out = sh(rescuePushCmd(REPO, STUDIO, root)).out;

    expect(out).toContain(RESCUE_PUSHED_PREFIX);
    expect(rescueRefs().length).toBe(1);
    expect(privRefs()).toEqual([]);
  });

  describe("every private rescue push runs realGit; the token rides a credential helper, never argv", () => {
    let log: string;
    let shim: string;
    beforeEach(() => {
      log = join(dir, "realgit.log");
      shim = join(dir, "realgit-shim");
      writeFileSync(shim, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\nexec '${REAL_GIT}' "$@"\n`);
      chmodSync(shim, 0o755);
      // Every push shape at once: dirty main, dirty member, branch walk, stash walk.
      writeFileSync(join(checkout, "notes.md"), "x\n");
      writeFileSync(join(checkout, ".claude/worktrees/agent-a1b2", "wip.md"), "y\n");
      sh(`cd ${checkout} && git checkout -q -b feat && git commit -q --allow-empty -m f && git checkout -q main`);
      writeFileSync(join(checkout, "s.md"), "z\n");
      sh(`git -C ${checkout} add s.md && git -C ${checkout} stash -q`);
    });
    function pushLines(): string[] {
      return sh(`cat '${log}' 2>/dev/null || true`).out.split("\n").filter((l) => / push /.test(` ${l} `));
    }

    for (const [label, cmdFn] of [["rescuePushCmd", rescuePushCmd], ["rescueSnapshotCmd", rescueSnapshotCmd]] as const) {
      test(`${label}: FLEET_RESCUE_TOKEN set — all 4 push shapes go through realGit with the helper; the token value never in argv`, () => {
        const cmd = cmdFn(REPO, STUDIO, root, undefined, undefined, undefined, undefined, undefined, { remoteUrl: priv, realGit: shim });
        expect(cmd).not.toContain("s3cr3t-fake-token");

        const out = sh(cmd, dir, { FLEET_RESCUE_TOKEN: "s3cr3t-fake-token" }).out;

        expect(out).not.toContain(RESCUE_FAILED_PREFIX);
        const lines = pushLines();
        expect(lines.length).toBe(4);
        for (const l of lines) {
          expect(l).toContain("credential.helper=!f()");
          expect(l).toContain(priv);
          expect(l).not.toContain("s3cr3t-fake-token");
        }
      });

      test(`${label}: FLEET_RESCUE_TOKEN unset — pushes still run realGit, no helper injected`, () => {
        const out = sh(cmdFn(REPO, STUDIO, root, undefined, undefined, undefined, undefined, undefined, { remoteUrl: priv, realGit: shim })).out;

        expect(out).not.toContain(RESCUE_FAILED_PREFIX);
        const lines = pushLines();
        expect(lines.length).toBe(4);
        for (const l of lines) expect(l).not.toContain("credential.helper");
      });

      test(`${label}: remoteUrl unset — realGit ignored; origin pushes run plain git on PATH (the leak-gate wrapper), never the rescue helper`, () => {
        const cmd = cmdFn(REPO, STUDIO, root, undefined, undefined, undefined, undefined, undefined, { realGit: shim });
        expect(cmd).not.toContain(shim);
        expect(cmd).not.toContain("credential.helper");

        const out = sh(cmd, dir, { FLEET_RESCUE_TOKEN: "s3cr3t-fake-token" }).out;

        expect(out).not.toContain(RESCUE_FAILED_PREFIX);
        expect(pushLines()).toEqual([]);
        expect(rescueRefs().length).toBe(4);
      });
    }
  });

  // Issue #30: rescue pushed to the private remote (public work repo) but
  // discovery listed and fetched from origin only. Those refs never came back
  // on the next provision. Discovery now also reads the private remote, under
  // the SAME target rescue resolved (do.ts resolveRescueTarget): a private
  // work repo gets `{}`, so the private remote is never consulted.
  describe("issue #30 — discovery also fetches rescue refs from the private rescue remote", () => {
    function listFile(): string {
      return join(dir, ".fleet", "remote-branches.txt");
    }
    function freshClone(name: string): string {
      const c = join(dir, name);
      sh(`git clone -q ${origin} ${c}`);
      return c;
    }
    function privRescueRef(): string {
      const ref = privRefs().find((r) => r.includes("fleet/rescue/"));
      expect(ref).toBeDefined();
      return ref!;
    }
    const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, "");

    test("public-repo studio: a rescue on the private remote is fetched into a fresh checkout", () => {
      writeFileSync(join(checkout, "notes.md"), "private work\n");
      expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
      const ref = privRescueRef();
      const name = branchOf(ref);
      const fresh = freshClone("fresh-priv");

      const r = sh(discoverRescueRefsCmd(fresh, STUDIO, listFile(), { remoteUrl: priv, realGit: REAL_GIT }), dir);

      expect(r.code).toBe(0);
      expect(sh(`git -C ${fresh} rev-parse --verify refs/heads/${name}`).out).toBe(sh(`git -C ${priv} rev-parse ${ref}`).out);
      expect(sh(`git -C ${fresh} show ${name}:notes.md`).out).toBe("private work");
      expect(r.err).toContain(`on branch ${name}`);
    });

    test("public-repo studio: origin's own rescue refs are still fetched beside the private remote's", () => {
      writeFileSync(join(checkout, "notes.md"), "origin work\n");
      expect(rescue()).toContain(RESCUE_PUSHED_PREFIX);
      const originName = branchOf(rescueRefs()[0]);
      const fresh = freshClone("fresh-both");

      const r = sh(discoverRescueRefsCmd(fresh, STUDIO, listFile(), { remoteUrl: priv, realGit: REAL_GIT }), dir);

      expect(r.code).toBe(0);
      expect(sh(`git -C ${fresh} rev-parse --verify refs/heads/${originName}`).code).toBe(0);
    });

    test("private-repo studio (target {}): the private remote is never consulted", () => {
      writeFileSync(join(checkout, "notes.md"), "private work\n");
      expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
      const name = branchOf(privRescueRef());
      const fresh = freshClone("fresh-private-repo");

      const cmd = discoverRescueRefsCmd(fresh, STUDIO, listFile(), {});
      const r = sh(cmd, dir);

      expect(r.code).toBe(0);
      expect(cmd).not.toContain(priv);
      expect(cmd).toBe(discoverRescueRefsCmd(fresh, STUDIO, listFile()));
      expect(sh(`git -C ${fresh} rev-parse --verify -q refs/heads/${name}`).code).not.toBe(0);
    });

    test("private remote unreachable: origin refs still fetched, a loud warning, exit 0", () => {
      writeFileSync(join(checkout, "notes.md"), "origin work\n");
      expect(rescue()).toContain(RESCUE_PUSHED_PREFIX);
      const originName = branchOf(rescueRefs()[0]);
      const fresh = freshClone("fresh-unreachable");

      const r = sh(discoverRescueRefsCmd(fresh, STUDIO, listFile(),
        { remoteUrl: join(dir, "no-such-remote.git"), realGit: REAL_GIT }), dir);

      expect(r.code).toBe(0);
      expect(sh(`git -C ${fresh} rev-parse --verify refs/heads/${originName}`).code).toBe(0);
      expect(r.err).toContain("WARNING: rescue discovery could not list the private rescue remote");
    });

    test("same ref on both remotes, different commits: origin's keeps the name, the private one lands beside it -- neither lost", () => {
      writeFileSync(join(checkout, "notes.md"), "private copy\n");
      expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
      const ref = privRescueRef();
      const name = branchOf(ref);
      // An unrelated commit under the SAME name on origin.
      const other = join(dir, "other-origin-copy");
      sh(`git init -q -b x ${other} && cd ${other} && git commit -q --allow-empty -m origin-copy && git push -q ${origin} HEAD:${ref}`);
      const fresh = freshClone("fresh-collide");

      const r = sh(discoverRescueRefsCmd(fresh, STUDIO, listFile(), { remoteUrl: priv, realGit: REAL_GIT }), dir);

      expect(r.code).toBe(0);
      expect(sh(`git -C ${fresh} rev-parse refs/heads/${name}`).out).toBe(sh(`git -C ${origin} rev-parse ${ref}`).out);
      expect(sh(`git -C ${fresh} rev-parse refs/heads/${name}-rescue-remote`).out).toBe(sh(`git -C ${priv} rev-parse ${ref}`).out);
      expect(r.err).toContain(`${name}-rescue-remote`);
      // PR #42 review: the local branch may be the lead's own, not origin's;
      // the line names only what discovery actually knows.
      expect(r.err).toContain(`local branch ${name} already exists at a different commit`);
      expect(r.err).not.toContain("exists on origin AND");
    });

    test("same ref on both remotes, same commit: fetched once, no duplicate branch", () => {
      writeFileSync(join(checkout, "notes.md"), "same\n");
      expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
      const ref = privRescueRef();
      const name = branchOf(ref);
      sh(`git -C ${priv} push -q ${origin} ${ref}:${ref}`);
      const fresh = freshClone("fresh-same");

      const r = sh(discoverRescueRefsCmd(fresh, STUDIO, listFile(), { remoteUrl: priv, realGit: REAL_GIT }), dir);

      expect(r.code).toBe(0);
      expect(sh(`git -C ${fresh} rev-parse refs/heads/${name}`).out).toBe(sh(`git -C ${priv} rev-parse ${ref}`).out);
      expect(sh(`git -C ${fresh} rev-parse --verify -q refs/heads/${name}-rescue-remote`).code).not.toBe(0);
    });

    test("issue #16 parentless snapshot on the private remote: fetched into a fresh --depth 1 checkout", () => {
      const origin3 = join(dir, "origin3-discover.git");
      const seed = join(dir, "seed-discover");
      sh(`git init -q --bare -b main ${origin3}`);
      sh(`git clone -q ${origin3} ${seed} 2>/dev/null; cd ${seed} && ` +
        `for f in a b c; do echo "$f" > "$f.md" && git add "$f.md" && git commit -q -m "$f"; done && git push -q origin HEAD:main`);
      rmSync(checkout, { recursive: true, force: true });
      sh(`git clone -q --depth 1 file://${origin3} ${checkout}`);
      writeFileSync(join(checkout, "notes.md"), "shallow work\n");
      expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
      const ref = privRescueRef();
      // Parentless: the snapshot shape #16 pushes when the remote refuses a shallow push.
      expect(sh(`git -C ${priv} rev-list --count ${ref}`).out).toBe("1");
      const name = branchOf(ref);
      const fresh = join(dir, "fresh-shallow");
      sh(`git clone -q --depth 1 file://${origin3} ${fresh}`);

      const r = sh(discoverRescueRefsCmd(fresh, STUDIO, listFile(), { remoteUrl: priv, realGit: REAL_GIT }), dir);

      expect(r.code).toBe(0);
      expect(sh(`git -C ${fresh} show ${name}:notes.md`).out).toBe("shallow work");
    });

    /**
     * PR #42 review (same class as the #14 review): a server that accepts
     * and never answers held discovery -- and the provision -- to the 600 s
     * exec deadline, and the WARNING relay never ran. Every discovery git
     * call now runs under `timeout -k`. The stalled server accepts, reads,
     * never writes; the kernel completes the handshake from the listen
     * backlog, so git stalls even while spawnSync blocks this event loop.
     * spawnSync's own 60 s timeout keeps a regression a failure, not a hang.
     */
    describe("a stalled remote never holds provision past the discovery bound", () => {
      let server: Server;
      const sockets: Socket[] = [];
      let stalled = "";
      beforeAll(async () => {
        server = createServer((sock) => {
          sockets.push(sock);
          sock.on("data", () => {});
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("stalled server has no port");
        stalled = `http://127.0.0.1:${addr.port}/rescue.git`;
      });
      afterAll(() => {
        for (const s of sockets) s.destroy();
        server.close();
      });

      function shBounded(cmd: string): { code: number; err: string; ms: number } {
        const t0 = Date.now();
        const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 60_000,
          env: { ...process.env, PATH: BASE_PATH } });
        return { code: r.exitCode ?? -1, err: r.stderr.toString(), ms: Date.now() - t0 };
      }

      test("stalled private remote: ends within the bound, WARNING, origin refs still fetched", () => {
        writeFileSync(join(checkout, "notes.md"), "origin work\n");
        expect(rescue()).toContain(RESCUE_PUSHED_PREFIX);
        const originName = branchOf(rescueRefs()[0]);
        const fresh = freshClone("fresh-stalled-priv");

        const r = shBounded(discoverRescueRefsCmd(fresh, STUDIO, listFile(), { remoteUrl: stalled, realGit: REAL_GIT }, 2));

        expect(r.code).toBe(0);
        expect(r.ms).toBeLessThan(20_000);
        expect(sh(`git -C ${fresh} rev-parse --verify refs/heads/${originName}`).code).toBe(0);
        expect(r.err).toContain("WARNING: rescue discovery could not list the private rescue remote");
      }, 70_000);

      test("stalled origin: ends within the bound, says so, private refs still fetched", () => {
        writeFileSync(join(checkout, "notes.md"), "private work\n");
        expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
        const name = branchOf(privRescueRef());
        const fresh = freshClone("fresh-stalled-origin");
        sh(`git -C ${fresh} remote set-url origin ${stalled}`);

        const r = shBounded(discoverRescueRefsCmd(fresh, STUDIO, listFile(), { remoteUrl: priv, realGit: REAL_GIT }, 2));

        expect(r.code).toBe(0);
        expect(r.ms).toBeLessThan(20_000);
        expect(r.err).toContain("rescue discovery skipped");
        expect(sh(`git -C ${fresh} rev-parse --verify refs/heads/${name}`).code).toBe(0);
      }, 70_000);
    });

    /**
     * Issue #45 items 4-5 (#47 review): ls-remote answers, the FETCH fails or
     * stalls. A failed last origin fetch used to exit the loop non-zero and
     * print the false "could not list origin's branches" line; an earlier
     * one failed silently. Every fetch now says WARNING on its own, and a
     * stalled fetch (origin or private) ends within the discovery bound.
     * The shim passes everything but `fetch` to real git; `exec sleep` so the
     * process `timeout` kills IS the sleeper.
     */
    describe("#45 — a failing or stalled FETCH (ls-remote fine) is named, bounded, never a false skip", () => {
      function fetchShim(mode: "fail" | "stall"): string {
        const d = join(dir, `fetch-shim-${mode}`);
        mkdirSync(d, { recursive: true });
        const body = mode === "fail" ? `echo "fatal: shim fetch failure" >&2; exit 1` : "exec sleep 60";
        writeFileSync(join(d, "git"),
          `#!/bin/bash\nfor a in "$@"; do if [ "$a" = fetch ]; then ${body}; fi; done\nexec '${REAL_GIT}' "$@"\n`);
        chmodSync(join(d, "git"), 0o755);
        return d;
      }
      function run(cmd: string, pathPrefix?: string): { code: number; err: string; ms: number } {
        const t0 = Date.now();
        const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 60_000,
          env: { ...process.env, PATH: pathPrefix ? `${pathPrefix}:${BASE_PATH}` : BASE_PATH } });
        return { code: r.exitCode ?? -1, err: r.stderr.toString(), ms: Date.now() - t0 };
      }

      test("origin fetch FAILS: WARNING naming the ref, never the false 'could not list' skip", () => {
        writeFileSync(join(checkout, "notes.md"), "origin work\n");
        expect(rescue()).toContain(RESCUE_PUSHED_PREFIX);
        const fresh = freshClone("fresh-origin-fetch-fail");

        const r = run(discoverRescueRefsCmd(fresh, STUDIO, listFile(), {}, 2), fetchShim("fail"));

        expect(r.code).toBe(0);
        expect(r.err).toContain("WARNING: could not fetch rescue branch refs/heads/fleet/rescue/");
        expect(r.err).toContain("from origin");
        expect(r.err).not.toContain("rescue discovery skipped");
      }, 70_000);

      test("origin fetch STALLS: ends within the bound, WARNING, no false skip", () => {
        writeFileSync(join(checkout, "notes.md"), "origin work\n");
        expect(rescue()).toContain(RESCUE_PUSHED_PREFIX);
        const fresh = freshClone("fresh-origin-fetch-stall");

        const r = run(discoverRescueRefsCmd(fresh, STUDIO, listFile(), {}, 2), fetchShim("stall"));

        expect(r.code).toBe(0);
        expect(r.ms).toBeLessThan(20_000);
        expect(r.err).toContain("WARNING: could not fetch rescue branch");
        expect(r.err).not.toContain("rescue discovery skipped");
      }, 70_000);

      test("private-remote fetch STALLS: ends within the bound, WARNING names the private remote", () => {
        writeFileSync(join(checkout, "notes.md"), "private work\n");
        expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
        const fresh = freshClone("fresh-priv-fetch-stall");

        const r = run(discoverRescueRefsCmd(fresh, STUDIO, listFile(),
          { remoteUrl: priv, realGit: join(fetchShim("stall"), "git") }, 2));

        expect(r.code).toBe(0);
        expect(r.ms).toBeLessThan(20_000);
        expect(r.err).toContain("WARNING: could not fetch rescue branch");
        expect(r.err).toContain("private rescue remote");
      }, 70_000);
    });

    test("FLEET_RESCUE_TOKEN rides a credential helper on the private list + fetch, never argv", () => {
      const log = join(dir, "realgit-discover.log");
      const shim = join(dir, "realgit-discover-shim");
      writeFileSync(shim, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\nexec '${REAL_GIT}' "$@"\n`);
      chmodSync(shim, 0o755);
      writeFileSync(join(checkout, "notes.md"), "x\n");
      expect(pushPriv()).toContain(RESCUE_PUSHED_PREFIX);
      const fresh = freshClone("fresh-token");
      const cmd = discoverRescueRefsCmd(fresh, STUDIO, listFile(), { remoteUrl: priv, realGit: shim });
      expect(cmd).not.toContain("s3cr3t-fake-token");

      const r = sh(cmd, dir, { FLEET_RESCUE_TOKEN: "s3cr3t-fake-token" });

      expect(r.code).toBe(0);
      const lines = sh(`cat '${log}'`).out.split("\n").filter(Boolean);
      expect(lines.some((l) => l.includes(" ls-remote "))).toBe(true);
      expect(lines.some((l) => l.includes(" fetch "))).toBe(true);
      for (const l of lines) {
        expect(l).toContain("credential.helper=!f()");
        expect(l).not.toContain("s3cr3t-fake-token");
      }
    });
  });
});

// Issue #39: the operator needs one line per worktree after every rescue —
// pushed (which ref), nothing to push, or failed (which step). Both builders.
describe("#39 — one RESCUE_WT line per worktree", () => {
  for (const [label, cmdFn] of RESCUE_CMDS) {
    test(`${label}: clean checkout + dirty member worktree → checkout nothing, member pushed <its ref>`, () => {
      writeFileSync(join(checkout, ".claude/worktrees/agent-a1b2", "wip.md"), "member work\n");
      const out = sh(cmdFn(REPO, STUDIO, root)).out;
      expect(out).toMatch(/^RESCUE_WT checkout nothing$/m);
      const pushed = /^RESCUE_PUSHED (\S+) 1 files$/m.exec(out)![1];
      expect(pushed).toContain("/wt/agent-a1b2-");
      expect(out).toMatch(new RegExp(`^RESCUE_WT agent-a1b2 pushed ${pushed}$`, "m"));
      expect(out.split("\n").filter((l) => l.startsWith("RESCUE_WT "))).toHaveLength(2);
    });

    test(`${label}: a push that fails → RESCUE_WT checkout failed push`, () => {
      installSlowPostReceiveHook(3);
      writeFileSync(join(checkout, "notes.md"), "work behind a slow remote hook\n");
      const out = sh(cmdFn(REPO, STUDIO, root, 1)).out;
      expect(out).toMatch(/^RESCUE_WT checkout failed push$/m);
    });
  }
});

/**
 * Issue #49: destroy 409 `failed [checkout (push)]` on a CLEAN checkout whose
 * HEAD already equals its branch on origin. Provision clones `--depth 1`
 * (implies `--single-branch`), so a branch the lead pushed itself gets no
 * `refs/remotes/origin/<branch>`, and `rev-list --not --remotes` counts its
 * already-pushed commits as ahead. Rescue then pushes to that REAL branch,
 * where the repo's own pre-push hook runs (#359: real branches keep hooks);
 * a hook resolving `@{u}` on an upstream-less branch dies with
 * `fatal: no upstream configured for branch` — and no stderr reached the 409.
 */
describe("#49 — a clean checkout whose HEAD is already on origin is nothing to rescue", () => {
  function upstreamHook(): void {
    const hooksDir = mkdtempSync(join(tmpdir(), "fleet-upstream-hook-"));
    writeFileSync(join(hooksDir, "pre-push"), "#!/bin/sh\ngit rev-parse --abbrev-ref '@{u}' >/dev/null || exit 1\n");
    chmodSync(join(hooksDir, "pre-push"), 0o755);
    sh(`git -C ${checkout} config core.hooksPath ${hooksDir}`);
  }
  /** The lead's own PR branch, pushed by refspec: on origin, but no tracking
   *  ref and no upstream here (what a single-branch clone leaves). */
  function pushedPrBranch(): void {
    sh(`cd ${checkout} && git checkout -q -b task/pr && git commit -q --allow-empty -m "pr work" && ` +
      `git push -q origin HEAD:refs/heads/task/pr && git update-ref -d refs/remotes/origin/task/pr; ` +
      `git branch --unset-upstream 2>/dev/null; true`);
    sh(`cd ${checkout} && git worktree remove --force .claude/worktrees/agent-a1b2 2>/dev/null; rm -rf .claude; true`);
  }

  for (const [label, cmdFn] of RESCUE_CMDS) {
    test(`${label}: HEAD == origin's branch, no tracking ref, upstream hook installed → RESCUE_CLEAN, no push, no failure`, () => {
      pushedPrBranch();
      upstreamHook();
      const before = sh(`git -C ${origin} for-each-ref --format='%(refname)'`).out;

      const r = sh(cmdFn(REPO, STUDIO, root));

      expect(r.out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(r.out).not.toContain(RESCUE_PUSHED_PREFIX);
      expect(bare(r.out)).toBe(RESCUE_CLEAN);
      expect(r.out).toMatch(/^RESCUE_WT checkout nothing$/m);
      expect(sh(`git -C ${origin} for-each-ref --format='%(refname)'`).out).toBe(before);
    });
  }

  test("a GENUINE unpushed commit on that branch still fails under the hook — and the push stderr is surfaced", () => {
    pushedPrBranch();
    sh(`cd ${checkout} && git commit -q --allow-empty -m "really unpushed"`);
    upstreamHook();

    const r = sh(rescuePushCmd(REPO, STUDIO, root));

    expect(r.out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
    expect(r.err).toContain("no upstream configured");
  });
});

/**
 * Issue #58 (#52 review follow-ups): the already-on-origin check is budgeted,
 * never reads a failed or untrustworthy listing as "already saved", and every
 * push failure — snapshot builder, branch walk, stash walk — carries its
 * stderr out.
 */
describe("#58 — on-origin check: budgeted, fail-safe, push URL aware; every push failure has stderr", () => {
  function prBranchOnOrigin(): void {
    sh(`cd ${checkout} && git checkout -q -b task/pr && git commit -q --allow-empty -m "pr work" && ` +
      `git push -q origin HEAD:refs/heads/task/pr && git update-ref -d refs/remotes/origin/task/pr; ` +
      `git branch --unset-upstream 2>/dev/null; true`);
    sh(`cd ${checkout} && git worktree remove --force .claude/worktrees/agent-a1b2 2>/dev/null; rm -rf .claude; true`);
  }
  /** `git` on PATH that logs every call; `failLsRemote` makes ls-remote fail. */
  function gitShim(failLsRemote: boolean): { dir: string; log: string } {
    const d = mkdtempSync(join(tmpdir(), "fleet-git-shim-"));
    const log = join(d, "calls.log");
    const real = Bun.which("git", { PATH: process.env.PATH })!;
    writeFileSync(join(d, "git"),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\n` +
      (failLsRemote ? `for a in "$@"; do [ "$a" = ls-remote ] && { echo "fatal: shim listing failure" >&2; exit 128; }; done\n` : "") +
      `exec '${real}' "$@"\n`);
    chmodSync(join(d, "git"), 0o755);
    return { dir: d, log };
  }
  function originRejects(msg: string): void {
    mkdirSync(join(origin, "hooks"), { recursive: true });
    writeFileSync(join(origin, "hooks", "pre-receive"), `#!/bin/sh\necho "${msg}" >&2\nexit 1\n`);
    chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
  }

  for (const [label, cmdFn] of RESCUE_CMDS) {
    test(`${label}: a FAILED origin listing never reads as already-saved — the push runs`, () => {
      prBranchOnOrigin();
      const shim = gitShim(true);
      const r = sh(cmdFn(REPO, STUDIO, root), dir, { PATH: `${shim.dir}:${BASE_PATH}` });
      expect(bare(r.out)).not.toBe(RESCUE_CLEAN);
      expect(r.out).toContain(RESCUE_PUSHED_PREFIX);
    });

    test(`${label}: out of budget → no ls-remote at all (never spends the last seconds listing)`, () => {
      prBranchOnOrigin();
      const shim = gitShim(false);
      // pushTimeout 2 + KILL_GRACE -> single-push threshold 7s; a 5s server
      // deadline leaves no budget for anything.
      const r = sh(cmdFn(REPO, STUDIO, root, 2, 5, 0), dir, { PATH: `${shim.dir}:${BASE_PATH}` });
      const calls = existsSync(shim.log) ? readFileSync(shim.log, "utf8") : "";
      expect(calls).not.toMatch(/ls-remote --heads origin/);
      expect(bare(r.out)).not.toBe(RESCUE_CLEAN);
    });

    test(`${label}: a dirty-tree push the origin REJECTS carries the remote's stderr out`, () => {
      originRejects("policy says no");
      writeFileSync(join(checkout, "notes.md"), "work\n");
      const r = sh(cmdFn(REPO, STUDIO, root));
      expect(r.out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
      expect(r.err).toContain("policy says no");
    });

    test(`${label}: a branch-walk push the origin REJECTS carries stderr too`, () => {
      sh(`cd ${checkout} && git checkout -q -b feat && git commit -q --allow-empty -m "feat work" && git checkout -q main`);
      sh(`cd ${checkout} && git worktree remove --force .claude/worktrees/agent-a1b2 2>/dev/null; rm -rf .claude; true`);
      originRejects("branch policy says no");
      const r = sh(cmdFn(REPO, STUDIO, root));
      expect(r.out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout:feat push$`, "m"));
      expect(r.err).toContain("branch policy says no");
    });

    test(`${label}: a stash-walk push the origin REJECTS carries stderr too`, () => {
      sh(`cd ${checkout} && git worktree remove --force .claude/worktrees/agent-a1b2 2>/dev/null; rm -rf .claude; true`);
      writeFileSync(join(checkout, "s.md"), "stash me\n");
      sh(`git -C ${checkout} add s.md && git -C ${checkout} stash -q`);
      originRejects("stash policy says no");
      const r = sh(cmdFn(REPO, STUDIO, root));
      expect(r.out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout:stash-0 push$`, "m"));
      expect(r.err).toContain("stash policy says no");
    });
  }

  test("rescuePushCmd: pushurl differs from the fetch url → the listing cannot vouch for the push destination → push runs", () => {
    prBranchOnOrigin();
    const elsewhere = join(dir, "push-dest.git");
    sh(`git init -q --bare -b main ${elsewhere}`);
    sh(`git -C ${checkout} config remote.origin.pushurl ${elsewhere}`);
    const r = sh(rescuePushCmd(REPO, STUDIO, root));
    expect(bare(r.out)).not.toBe(RESCUE_CLEAN);
    expect(sh(`git -C ${elsewhere} for-each-ref --format='%(refname)'`).out).toContain("refs/heads/task/pr");
  });
});
