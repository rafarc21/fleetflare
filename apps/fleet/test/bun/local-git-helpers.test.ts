// `resolveGitToplevel` / `resolveDefaultBranch` — the two git subprocess
// helpers behind `fleet spawn --local` / `ff --local` (fleet task #1248,
// finding T3). Both take a `run` port defaulting to Bun.spawn, so their
// parsing is unit-testable over canned subprocess outputs — no real `git`
// ever runs here. The three default-branch fallback paths (symbolic-ref,
// `git remote show origin`'s HEAD branch line, `git branch -r`'s first
// origin/* entry) and the null/refusal case are each pinned.
//
// bun:test lane, not vitest: cli/fleet.ts is Bun-only and never imported from
// the vitest suite — same precedent as orca-workspace.test.ts's own header.
import { describe, expect, test } from "bun:test";
import { resolveDefaultBranch, resolveGitToplevel, resolveCloneOriginSlug, localTeardownDecision, gitIsDirty, gitAheadCount } from "../../cli/fleet";

/** A canned `run` port: `(args) => {code, stdout, stderr}`. */
function runner(answers: Record<string, { code: number; stdout: string; stderr?: string }>) {
  return async (args: string[]) => {
    const key = args.join(" ");
    const a = answers[key];
    if (a === undefined) return { code: 128, stdout: "", stderr: `no canned answer for ${key}` };
    return { code: a.code, stdout: a.stdout, stderr: a.stderr ?? "" };
  };
}

describe("resolveGitToplevel", () => {
  test("returns the trimmed toplevel from a clean `git rev-parse --show-toplevel`", async () => {
    const run = runner({ "rev-parse --show-toplevel": { code: 0, stdout: "/abs/clone\n" } });
    expect(await resolveGitToplevel(run)).toBe("/abs/clone");
  });

  test("returns null on a non-zero exit (outside a repo)", async () => {
    const run = runner({ "rev-parse --show-toplevel": { code: 128, stdout: "", stderr: "fatal: not a git repository\n" } });
    expect(await resolveGitToplevel(run)).toBeNull();
  });

  test("returns null on empty stdout", async () => {
    const run = runner({ "rev-parse --show-toplevel": { code: 0, stdout: "\n" } });
    expect(await resolveGitToplevel(run)).toBeNull();
  });

  test("with a cwd, -C <cwd> is prepended to the git argv", async () => {
    const run = runner({ "-C /other/clone rev-parse --show-toplevel": { code: 0, stdout: "/other/clone\n" } });
    expect(await resolveGitToplevel(run, "/other/clone")).toBe("/other/clone");
  });
});

describe("resolveDefaultBranch", () => {
  test("symbolic-ref path: strips refs/remotes/origin/", async () => {
    const run = runner({ "symbolic-ref refs/remotes/origin/HEAD": { code: 0, stdout: "refs/remotes/origin/main\n" } });
    expect(await resolveDefaultBranch(run)).toBe("main");
  });

  test("remote show fallback: the HEAD branch line", async () => {
    const run = runner({
      "symbolic-ref refs/remotes/origin/HEAD": { code: 128, stdout: "" },
      "remote show origin": { code: 0, stdout: "* remote origin\n  HEAD branch: develop\n  Remote branch:\n    develop tracked\n" },
    });
    expect(await resolveDefaultBranch(run)).toBe("develop");
  });

  test("branch -r fallback: the first origin/* entry, skipping origin/HEAD", async () => {
    const run = runner({
      "symbolic-ref refs/remotes/origin/HEAD": { code: 128, stdout: "" },
      "remote show origin": { code: 0, stdout: "* remote origin\n  Fetch URL: x\n" },
      "branch -r": { code: 0, stdout: "  origin/HEAD -> origin/main\n  origin/main\n  origin/feature-a\n" },
    });
    expect(await resolveDefaultBranch(run)).toBe("main");
  });

  test("all three fail -> null", async () => {
    const run = runner({
      "symbolic-ref refs/remotes/origin/HEAD": { code: 128, stdout: "" },
      "remote show origin": { code: 0, stdout: "* remote origin\n" },
      "branch -r": { code: 0, stdout: "" },
    });
    expect(await resolveDefaultBranch(run)).toBeNull();
  });

  test("with a cwd, -C <cwd> is prepended to every fallback argv", async () => {
    const run = runner({
      "-C /other/clone symbolic-ref refs/remotes/origin/HEAD": { code: 0, stdout: "refs/remotes/origin/develop\n" },
    });
    expect(await resolveDefaultBranch(run, "/other/clone")).toBe("develop");
  });
});

describe("resolveCloneOriginSlug (B4)", () => {
  test("parses the clone's origin through parseGitRemote", async () => {
    const run = runner({ "-C /other/clone remote get-url origin": { code: 0, stdout: "https://github.com/acme-org/websites.git\n" } });
    expect(await resolveCloneOriginSlug(run, "/other/clone")).toBe("acme-org/websites");
  });

  test("null on a non-github origin or a non-zero exit (no origin)", async () => {
    expect(await resolveCloneOriginSlug(runner({ "-C /x remote get-url origin": { code: 128, stdout: "", stderr: "No such remote" } }), "/x")).toBeNull();
    expect(await resolveCloneOriginSlug(runner({ "-C /x remote get-url origin": { code: 0, stdout: "https://gitlab.com/acme/websites\n" } }), "/x")).toBeNull();
  });
});

// Fleet task #1248 review BLOCKER B1: the pure local-teardown decision and
// its two git reads — a local destroy must keep a dirty or unpushed worktree,
// and must never remove on --park or without the explicit price.
describe("local teardown decision (B1)", () => {
  const F = { force: false, discardUnsynced: false, park: false };

  test("--park always keeps, even clean and explicitly forced", () => {
    expect(localTeardownDecision({ force: true, discardUnsynced: true, park: true }, false, false).action).toBe("keep");
  });

  test("without --force --discard-unsynced it keeps, however clean", () => {
    expect(localTeardownDecision(F, false, false).action).toBe("keep");
    expect(localTeardownDecision({ ...F, force: true }, false, false).action).toBe("keep");
    expect(localTeardownDecision({ ...F, discardUnsynced: true }, false, false).action).toBe("keep");
  });

  test("dirty or ahead keeps even with the explicit price", () => {
    const forced = { force: true, discardUnsynced: true, park: false };
    expect(localTeardownDecision(forced, true, false).action).toBe("keep");
    expect(localTeardownDecision(forced, false, true).action).toBe("keep");
  });

  test("only clean + not ahead + forced removes", () => {
    expect(localTeardownDecision({ force: true, discardUnsynced: true, park: false }, false, false).action).toBe("remove");
  });

  test("gitIsDirty reads git -C <path> status --porcelain", async () => {
    expect(await gitIsDirty(runner({ "-C /p status --porcelain": { code: 0, stdout: "M file.txt\n" } }), "/p")).toBe(true);
    expect(await gitIsDirty(runner({ "-C /p status --porcelain": { code: 0, stdout: "" } }), "/p")).toBe(false);
    // A non-zero exit (unreadable tree) is dirty — the safe side.
    expect(await gitIsDirty(runner({ "-C /p status --porcelain": { code: 128, stdout: "" } }), "/p")).toBe(true);
  });

  test("gitAheadCount reads rev-list --count @{u}.. and 0s on a missing upstream", async () => {
    expect(await gitAheadCount(runner({ "-C /p rev-list --count @{u}..": { code: 0, stdout: "3\n" } }), "/p")).toBe(3);
    // No upstream (non-zero exit) reads as 0 — nothing is "ahead of" a
    // missing upstream; the dirty check is what still protects the tree.
    expect(await gitAheadCount(runner({ "-C /p rev-list --count @{u}..": { code: 128, stdout: "" } }), "/p")).toBe(0);
  });
});