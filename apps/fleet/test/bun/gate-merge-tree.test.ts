import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMergeTree, type ExecFn } from "../../container/gate-merge-tree";

const realExec: ExecFn = async (cmd, args, opts) => {
  const proc = Bun.spawn([cmd, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code: exitCode, stdout, stderr };
};

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// Each test gets its own fixture repo so refs (origin/main) never leak between cases.
async function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gate-merge-tree-"));
  dirs.push(dir);
  const git = (args: string[]) => realExec("git", args, { cwd: dir });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "t"]);
  await Bun.write(join(dir, "f.txt"), "base\n");
  await git(["add", "f.txt"]);
  await git(["commit", "-q", "-m", "base"]);
  return { dir, git };
}

const head = async (git: (a: string[]) => Promise<{ stdout: string }>) =>
  (await git(["rev-parse", "HEAD"])).stdout.trim();

describe("resolveMergeTree", () => {
  it("ok on a clean merge; commit has exactly two parents: base then head", async () => {
    const { dir, git } = await makeRepo();
    const base = await head(git);
    await git(["checkout", "-q", "-b", "pr"]);
    await Bun.write(join(dir, "g.txt"), "new\n");
    await git(["add", "g.txt"]);
    await git(["commit", "-q", "-m", "clean add"]);
    const prHead = await head(git);
    await git(["checkout", "-q", "main"]);

    const result = await resolveMergeTree(realExec, dir, base, prHead);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    const parents = (await git(["rev-list", "--parents", "-n1", result.commit])).stdout.trim().split(" ");
    expect(parents.length).toBe(3); // commit + 2 parents
    expect(parents[1]).toBe(base); // first parent = main
    expect(parents[2]).toBe(prHead); // second parent = PR head
  });

  it("conflict on two commits editing the same line → { ok:false, kind:'conflict' }, no throw", async () => {
    const { dir, git } = await makeRepo();
    const base = await head(git);
    await git(["checkout", "-q", "-b", "a"]);
    await Bun.write(join(dir, "f.txt"), "a-edit\n");
    await git(["commit", "-q", "-am", "a edit"]);
    const headA = await head(git);
    await git(["checkout", "-q", base]);
    await Bun.write(join(dir, "f.txt"), "b-edit\n");
    await git(["commit", "-q", "-am", "b edit"]);
    const headB = await head(git);

    const result = await resolveMergeTree(realExec, dir, headA, headB);
    expect(result).toEqual({ ok: false, kind: "conflict" });
  });

  it("error (not conflict) for an unknown ref; message in git's words, no throw", async () => {
    const { dir, git } = await makeRepo();
    const result = await resolveMergeTree(realExec, dir, "not-a-real-ref", await head(git));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("error when base is not the current origin/main (stale gate refused, never silent)", async () => {
    const { dir, git } = await makeRepo();
    const oldMain = await head(git);
    await git(["checkout", "-q", "-b", "pr"]);
    await Bun.write(join(dir, "g.txt"), "pr\n");
    await git(["add", "g.txt"]);
    await git(["commit", "-q", "-m", "pr"]);
    const prHead = await head(git);
    await git(["checkout", "-q", "main"]);
    await Bun.write(join(dir, "h.txt"), "moved\n");
    await git(["add", "h.txt"]);
    await git(["commit", "-q", "-m", "main moved"]);
    const newMain = await head(git);
    await git(["update-ref", "refs/remotes/origin/main", newMain]);

    const result = await resolveMergeTree(realExec, dir, oldMain, prHead);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") expect(result.message).toMatch(/stale/i);
    else throw new Error(`expected stale error, got ${JSON.stringify(result)}`);
  });

  it("ok when base equals current origin/main", async () => {
    const { dir, git } = await makeRepo();
    const base = await head(git);
    await git(["update-ref", "refs/remotes/origin/main", base]);
    await git(["checkout", "-q", "-b", "pr"]);
    await Bun.write(join(dir, "g.txt"), "pr\n");
    await git(["add", "g.txt"]);
    await git(["commit", "-q", "-m", "pr"]);
    const prHead = await head(git);
    await git(["checkout", "-q", "main"]);

    const result = await resolveMergeTree(realExec, dir, base, prHead);
    expect(result.ok).toBe(true);
  });
});
