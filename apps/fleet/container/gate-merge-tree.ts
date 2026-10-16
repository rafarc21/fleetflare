// TS port of localci.sh:350-363's `git merge-tree --write-tree` /
// `git commit-tree` two-parent shape. The gated merge commit has two parents,
// base (origin/main) then head (PR), exactly as localci builds it, so the
// tested tree is PR head merged onto main.
//
// `git merge-tree` exits 1 on a real conflict; any other non-zero exit is git
// failing for another reason and is reported in git's own words, never
// flattened to "conflict" (the distinction localci.sh:350-352 draws).
// Expected git outcomes are returned as data; this function does not throw
// for them.
//
// `exec` is injected so production (container/gate-server.ts, wired to
// Bun.spawn against the real checkout) and the test (wired to Bun.spawn
// against a fixture repo) share one implementation.

export type ExecFn = (
  cmd: string, args: string[], opts: { cwd: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type MergeTreeResult =
  | { ok: true; commit: string; baseMoved?: string }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "error"; message: string };

const firstLine = (s: string) => s.split("\n")[0].trim();

// The container has no git identity, and commit-tree refuses to write a commit
// without one. The gate commit is internal (never pushed), so a fixed identity
// carried on the call itself is enough.
const GATE_IDENTITY = ["-c", "user.name=fleet gate", "-c", "user.email=gate@fleet.invalid"];

export async function resolveMergeTree(
  exec: ExecFn, cwd: string, base: string, head: string, baseRef: string,
): Promise<MergeTreeResult> {
  const baseRes = await exec("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd });
  if (baseRes.code !== 0) return { ok: false, kind: "error", message: `unknown base ref: ${base}` };
  const baseSha = baseRes.stdout.trim();

  const headRes = await exec("git", ["rev-parse", "--verify", "--quiet", `${head}^{commit}`], { cwd });
  if (headRes.code !== 0) return { ok: false, kind: "error", message: `unknown head ref: ${head}` };
  const headSha = headRes.stdout.trim();

  // The base branch may have moved since the run was pinned. That is not a leg
  // error: the merge still uses the pinned base, and the moved tip is reported
  // so the leg can say which commit it tested.
  let baseMoved: string | undefined;
  const branchRes = await exec("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseRef}`], { cwd });
  if (branchRes.code === 0) {
    const branchSha = branchRes.stdout.trim();
    if (branchSha !== baseSha) baseMoved = branchSha;
  }

  const mt = await exec("git", ["merge-tree", "--write-tree", baseSha, headSha], { cwd });
  if (mt.code === 1) return { ok: false, kind: "conflict" };
  if (mt.code !== 0) {
    return { ok: false, kind: "error", message: firstLine(mt.stderr) || `git merge-tree exited ${mt.code}` };
  }
  const tree = firstLine(mt.stdout);

  const ct = await exec(
    "git", [...GATE_IDENTITY, "commit-tree", tree, "-p", baseSha, "-p", headSha, "-m", `gate: ${headSha} onto ${baseSha}`], { cwd },
  );
  if (ct.code !== 0) {
    return { ok: false, kind: "error", message: firstLine(ct.stderr) || `git commit-tree exited ${ct.code}` };
  }
  const commit = ct.stdout.trim();

  // Defensive: prove the parents are exactly [base, head] before handing the commit out.
  const parentsRes = await exec("git", ["rev-list", "--parents", "-n1", commit], { cwd });
  if (parentsRes.code !== 0) {
    return { ok: false, kind: "error", message: firstLine(parentsRes.stderr) || "git rev-list failed" };
  }
  const [, p1, p2, extra] = parentsRes.stdout.trim().split(" ");
  if (p1 !== baseSha || p2 !== headSha || extra !== undefined) {
    return { ok: false, kind: "error", message: `merge commit parents mismatch: ${parentsRes.stdout.trim()}` };
  }

  return baseMoved === undefined ? { ok: true, commit } : { ok: true, commit, baseMoved };
}
