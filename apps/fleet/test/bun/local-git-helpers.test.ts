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
import { resolveDefaultBranch, resolveGitToplevel } from "../../cli/fleet";

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
});