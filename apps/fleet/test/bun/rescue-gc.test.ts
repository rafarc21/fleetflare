import { describe, expect, test } from "bun:test";
import { runRescueGc, isRescueMarkerPath, type RescueGcDeps, type RescueBranch } from "../../src/studio/rescue-gc";

/**
 * Issue #217: fleet/rescue/* branches pile up forever. The GC deletes one only
 * when it is OLD and provably empty of work: every commit already an ancestor
 * of the default branch, or a diff touching nothing but tool markers. Anything
 * else is kept and said why. Dry-run unless `apply`.
 */
const NOW = new Date("2026-09-25T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function deps(
  branches: RescueBranch[],
  compare: Record<string, { aheadBy: number; files: string[] } | Error>,
): RescueGcDeps & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    listBranches: async () => branches,
    compare: async (name) => {
      const c = compare[name];
      if (c instanceof Error) throw c;
      return c!;
    },
    deleteBranch: async (name) => {
      deleted.push(name);
    },
  };
}

const B = (name: string, ageDays: number): RescueBranch => ({ name: `fleet/rescue/${name}`, sha: "abc1234def", date: days(ageDays) });

describe("#217 — fleet rescue-gc", () => {
  test("markers: Claude Code's worktree paths, and nothing else", () => {
    expect(isRescueMarkerPath(".claude/worktrees/agent-a1b2")).toBe(true);
    expect(isRescueMarkerPath(".claude/worktrees")).toBe(true);
    expect(isRescueMarkerPath(".claude/settings.json")).toBe(false);
    expect(isRescueMarkerPath("src/.claude/worktrees-notes.md")).toBe(false);
  });

  test("dry-run: an old branch whose commits are all on the default branch would be deleted, and nothing is", async () => {
    const d = deps([B("a-20260901000000", 24)], { "fleet/rescue/a-20260901000000": { aheadBy: 0, files: [] } });
    const r = await runRescueGc(d, { apply: false, olderThanDays: 14, now: NOW, defaultBranch: "main" });
    expect(r).toEqual([{ branch: "fleet/rescue/a-20260901000000", outcome: "would-delete", reason: "every commit is already on main" }]);
    expect(d.deleted).toEqual([]);
  });

  test("apply: old + marker-only is deleted", async () => {
    const d = deps([B("b-20260901000000", 20)], { "fleet/rescue/b-20260901000000": { aheadBy: 1, files: [".claude/worktrees/agent-x"] } });
    const r = await runRescueGc(d, { apply: true, olderThanDays: 14, now: NOW, defaultBranch: "main" });
    expect(r).toEqual([{ branch: "fleet/rescue/b-20260901000000", outcome: "deleted", reason: "only tool markers (.claude/worktrees)" }]);
    expect(d.deleted).toEqual(["fleet/rescue/b-20260901000000"]);
  });

  test("real work is KEPT however old, and says how much", async () => {
    const d = deps([B("c-20260801000000", 55)], { "fleet/rescue/c-20260801000000": { aheadBy: 1, files: [".claude/worktrees/x", "src/a.ts", "notes.md"] } });
    const r = await runRescueGc(d, { apply: true, olderThanDays: 14, now: NOW, defaultBranch: "main" });
    expect(r).toEqual([{ branch: "fleet/rescue/c-20260801000000", outcome: "kept", reason: "2 file(s) of real work not on main" }]);
    expect(d.deleted).toEqual([]);
  });

  test("a young branch is KEPT even when empty — someone may still be reading it", async () => {
    const d = deps([B("d-20260920000000", 5)], { "fleet/rescue/d-20260920000000": { aheadBy: 0, files: [] } });
    const r = await runRescueGc(d, { apply: true, olderThanDays: 14, now: NOW, defaultBranch: "main" });
    expect(r).toEqual([{ branch: "fleet/rescue/d-20260920000000", outcome: "kept", reason: "younger than 14 days" }]);
  });

  test("a compare that fails is KEPT and named — never deleted on a guess", async () => {
    const d = deps([B("e-20260901000000", 24)], { "fleet/rescue/e-20260901000000": new Error("compare 404") });
    const r = await runRescueGc(d, { apply: true, olderThanDays: 14, now: NOW, defaultBranch: "main" });
    expect(r).toEqual([{ branch: "fleet/rescue/e-20260901000000", outcome: "kept", reason: "could not compare: compare 404" }]);
    expect(d.deleted).toEqual([]);
  });
});
