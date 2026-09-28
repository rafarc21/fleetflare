// Issue #217: rescue branches that hold no work. Pure — the Worker route
// (src/board/routes.ts) wires it to real GitHub; tests fake the three verbs.

/**
 * Paths a tool writes into a checkout that are NOT work. Claude Code keeps
 * its worktrees at `<repo>/.claude/worktrees/<name>`: nested git worktrees
 * that `git add -A` records as a gitlink — measured 2026-09-24, a rescue
 * branch whose whole diff was one such line. The rescue push excludes these
 * (src/studio/rescue.ts) and the GC treats a diff of only these as empty.
 */
export const RESCUE_MARKER_PATHS: readonly string[] = [".claude/worktrees"];

export function isRescueMarkerPath(path: string): boolean {
  return RESCUE_MARKER_PATHS.some((m) => path === m || path.startsWith(`${m}/`));
}

/** The same list as git pathspec excludes, for `status` and `add`. */
export const RESCUE_MARKER_PATHSPECS = RESCUE_MARKER_PATHS.map((m) => `':(exclude)${m}'`).join(" ");

export type RescueBranch = { name: string; sha: string; date: string };

export interface RescueGcDeps {
  /** Every `fleet/rescue/*` branch: full name without `refs/heads/`, tip sha, tip commit date (ISO). */
  listBranches(): Promise<RescueBranch[]>;
  /** The branch against the default branch: commits ahead, and every file its diff touches. */
  compare(name: string): Promise<{ aheadBy: number; files: string[] }>;
  deleteBranch(name: string): Promise<void>;
}

export type RescueGcOutcome = { branch: string; outcome: "deleted" | "would-delete" | "kept"; reason: string };

/**
 * `fleet rescue-gc`: deletes a rescue branch only when it is older than
 * `olderThanDays` AND provably holds no work — every commit already on the
 * default branch, or a diff of nothing but tool markers. Real work is kept
 * however old; a branch it cannot compare is kept and named. Dry-run
 * (`would-delete`) unless `apply`.
 */
export async function runRescueGc(
  deps: RescueGcDeps,
  opts: { apply: boolean; olderThanDays: number; now: Date; defaultBranch: string },
): Promise<RescueGcOutcome[]> {
  const cutoff = opts.now.getTime() - opts.olderThanDays * 86_400_000;
  const out: RescueGcOutcome[] = [];
  for (const b of await deps.listBranches()) {
    const keep = (reason: string) => out.push({ branch: b.name, outcome: "kept", reason });
    if (new Date(b.date).getTime() > cutoff) {
      keep(`younger than ${opts.olderThanDays} days`);
      continue;
    }
    let cmp: { aheadBy: number; files: string[] };
    try {
      cmp = await deps.compare(b.name);
    } catch (err) {
      keep(`could not compare: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const work = cmp.files.filter((f) => !isRescueMarkerPath(f));
    let reason: string;
    if (cmp.aheadBy === 0) reason = `every commit is already on ${opts.defaultBranch}`;
    else if (work.length === 0 && cmp.files.length > 0) reason = `only tool markers (${RESCUE_MARKER_PATHS.join(", ")})`;
    else {
      keep(`${work.length} file(s) of real work not on ${opts.defaultBranch}`);
      continue;
    }
    if (!opts.apply) {
      out.push({ branch: b.name, outcome: "would-delete", reason });
      continue;
    }
    try {
      await deps.deleteBranch(b.name);
      out.push({ branch: b.name, outcome: "deleted", reason });
    } catch (err) {
      keep(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
