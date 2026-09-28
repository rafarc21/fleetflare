import { describe, it, expect } from "vitest";
import {
  SPRINT_MS, DEMOTION_MIN_AGE_MS, PROMOTION_CITATIONS,
  countCitations, demotionVerdict, surveyMemory, planCompaction,
  type MemorySource, type CompactionProposal,
} from "../src/memory/compact";
import { MEMORY_INDEX_PATH } from "../src/memory/index-file";

const NOW = new Date("2026-09-10T12:00:00.000Z");

/** A harvested file, named exactly as harvestLearnings names one. */
function harvested(studio: string, iso: string, i: number, slug: string, description: string, body?: string): MemorySource {
  const stamp = iso.replace(/[:.]/g, "-");
  const name = `${stamp}-${i}-${slug}`;
  return {
    path: `fleet/memory/${studio}/${name}.md`,
    content: `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: learning\n---\n\n${body ?? description}\n`,
  };
}

const OLD = "2026-08-01T10-00-00-000Z";
const OLD_ISO = "2026-08-01T10:00:00.000Z";

describe("thresholds", () => {
  it("a sprint is two days; demotion needs two sprints of silence", () => {
    expect(SPRINT_MS).toBe(2 * 24 * 60 * 60 * 1000);
    expect(DEMOTION_MIN_AGE_MS).toBe(2 * SPRINT_MS);
    expect(PROMOTION_CITATIONS).toBe(3);
  });
});

describe("countCitations", () => {
  const targets = ["websites--pilot/2026-08-01T10-00-00-000Z-0-a-fact.md", "shared/cf-rollout.md"];

  it("counts DISTINCT tasks, not mentions", () => {
    const counts = countCitations([
      { number: 1, text: "per cf-rollout and cf-rollout again" },
      { number: 2, text: "see cf-rollout" },
    ], targets);
    expect(counts["shared/cf-rollout.md"]).toBe(2);
  });

  it("matches the basename with or without .md", () => {
    const counts = countCitations([{ number: 7, text: "read cf-rollout.md first" }], targets);
    expect(counts["shared/cf-rollout.md"]).toBe(1);
  });

  it("uncited files come back at zero, never absent", () => {
    expect(countCitations([], targets)).toEqual({
      "websites--pilot/2026-08-01T10-00-00-000Z-0-a-fact.md": 0,
      "shared/cf-rollout.md": 0,
    });
  });
});

describe("demotionVerdict — promotion-or-death, measured not judged", () => {
  const old = DEMOTION_MIN_AGE_MS + 1;
  it("3+ citing tasks promotes", () => expect(demotionVerdict(3, old)).toBe("promote"));
  it("1-2 stays indexed", () => {
    expect(demotionVerdict(1, old)).toBe("keep");
    expect(demotionVerdict(2, old)).toBe("keep");
  });
  it("0 citations and two sprints old demotes", () => expect(demotionVerdict(0, old)).toBe("demote"));
  it("0 citations but young holds — a fact filed yesterday is not neglected", () => {
    expect(demotionVerdict(0, SPRINT_MS)).toBe("hold");
  });
  it("an undatable file is never auto-demoted", () => expect(demotionVerdict(0, null)).toBe("hold"));
});

describe("surveyMemory", () => {
  const files = [
    harvested("websites--pilot", OLD_ISO, 0, "cf-rollout", "wrangler diffs the image digest, not rollout_step_percentage"),
    harvested("websites--pilot", OLD_ISO, 1, "ipv6-bind", "curl 127.0.0.1 fakes a dead server when astro binds [::1]"),
  ];

  it("bootstraps an index line per file when there is no index yet — no judgment, pure restatement", () => {
    const s = surveyMemory("", files, [], NOW);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0].summary).toBe("wrangler diffs the image digest, not rollout_step_percentage");
    expect(s.unindexed).toHaveLength(2);
  });

  it("keeps an existing index line rather than regenerating it — a human may have written it", () => {
    const target = `websites--pilot/${OLD}-0-cf-rollout.md`;
    const s = surveyMemory(`- [CF rollout](${target}) — hand-written summary\n`, files, [], NOW);
    expect(s.entries.find((e) => e.target === target)?.summary).toBe("hand-written summary");
    expect(s.unindexed).toEqual([`websites--pilot/${OLD}-1-ipv6-bind.md`]);
  });

  it("measures citations and age per file, and names the candidates", () => {
    const s = surveyMemory("", files, [
      { number: 1, text: `see ${OLD}-0-cf-rollout` },
      { number: 2, text: `see ${OLD}-0-cf-rollout` },
      { number: 3, text: `see ${OLD}-0-cf-rollout` },
    ], NOW);
    const cf = s.files.find((f) => f.target.endsWith("cf-rollout.md"))!;
    expect(cf.citations).toBe(3);
    expect(cf.verdict).toBe("promote");
    expect(s.candidates.promote).toEqual([cf.target]);
    expect(s.candidates.demote).toEqual([`websites--pilot/${OLD}-1-ipv6-bind.md`]);
  });

  it("never surveys archive/ — a demoted file must not be re-demoted or re-indexed", () => {
    const s = surveyMemory("", [
      ...files,
      { path: `fleet/memory/archive/websites--pilot/${OLD}-9-gone.md`, content: "old\n" },
    ], [], NOW);
    expect(s.files.map((f) => f.target)).not.toContain(`archive/websites--pilot/${OLD}-9-gone.md`);
  });
});

describe("planCompaction — merges, demotions, promotions, all as ONE rejectable PR", () => {
  const cf = harvested("websites--pilot", OLD_ISO, 0, "cf-rollout", "bump rollout_step_percentage to 100, the VERSION column lies");
  const digest = harvested("websites--pilot", OLD_ISO, 1, "cf-digest", "a deployed image never reaches a running container without a digest bump");
  const ipv6 = harvested("websites--web-studio", OLD_ISO, 2, "ipv6-bind", "curl 127.0.0.1 fakes a dead server when astro binds [::1]");
  const files = [cf, digest, ipv6];
  const t = (f: MemorySource) => f.path.slice("fleet/memory/".length);

  const survey = (tasks: { number: number; text: string }[] = []) => surveyMemory("", files, tasks, NOW);

  it("merging two lines keeps the first file in place, archives the second, cites the count", () => {
    const proposal: CompactionProposal = {
      merges: [{
        title: "CF container rollout",
        summary: "bump rollout_step_percentage to 100; the VERSION column lies; a deployed image never reaches a running container without a digest bump",
        sources: [t(cf), t(digest)],
      }],
    };
    const res = planCompaction(survey(), proposal, NOW);
    if (!res.ok) throw new Error(res.message);
    const index = res.plan.changes.find((c) => c.path === MEMORY_INDEX_PATH)!.content!;
    expect(index).toContain(`- [CF container rollout](${t(cf)}, +1 archived) —`);
    // the merged-away source MOVED, never deleted
    expect(res.plan.changes).toContainEqual({ path: `fleet/memory/archive/${t(digest)}`, content: digest.content });
    expect(res.plan.changes).toContainEqual({ path: digest.path, content: null });
    // the surviving source is untouched on disk
    expect(res.plan.changes.map((c) => c.path)).not.toContain(cf.path);
  });

  it("refuses a merge that dissolves a specific — the exact number, named", () => {
    const res = planCompaction(survey(), {
      merges: [{ title: "CF rollout", summary: "bump the rollout percentage and mind the version column", sources: [t(cf), t(digest)] }],
    }, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.message).toMatch(/100/);
    expect(res.message).toMatch(/VERSION/);
    expect(res.message).toMatch(/specific/i);
  });

  // The title of a bootstrapped line is the harvest FILENAME, which reads as a
  // date plus a path. Demanding it verbatim inside the merged line would refuse
  // every merge; the filename is preserved by the archive path instead.
  it("does not demand the source's machine-generated title inside the merged line", () => {
    const res = planCompaction(survey(), {
      merges: [{
        title: "CF container rollout",
        summary: "bump rollout_step_percentage to 100; the VERSION column lies; a deployed image never reaches a running container without a digest bump",
        sources: [t(cf), t(digest)],
      }],
    }, NOW);
    expect(res.ok).toBe(true);
  });

  it("refuses a merge of one source — that is a rename, not a compaction", () => {
    const res = planCompaction(survey(), { merges: [{ title: "x", summary: "y", sources: [t(cf)] }] }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/two or more/);
  });

  it("demotion drops the index line and MOVES the file — no delete anywhere in the plan", () => {
    const res = planCompaction(survey(), { demote: [t(ipv6)] }, NOW);
    if (!res.ok) throw new Error(res.message);
    const index = res.plan.changes.find((c) => c.path === MEMORY_INDEX_PATH)!.content!;
    expect(index).not.toContain(t(ipv6));
    expect(res.plan.changes).toContainEqual({ path: `fleet/memory/archive/${t(ipv6)}`, content: ipv6.content });
    expect(res.plan.changes).toContainEqual({ path: ipv6.path, content: null });
    // every null-content change is paired with a create at the archive path
    for (const c of res.plan.changes.filter((x) => x.content === null)) {
      expect(res.plan.changes.some((x) => x.path === `fleet/memory/archive/${c.path.slice("fleet/memory/".length)}` && x.content !== null)).toBe(true);
    }
  });

  it("refuses to demote a cited file — judgment does not override the measurement", () => {
    const res = planCompaction(survey([{ number: 1, text: `see ${OLD}-2-ipv6-bind` }]), { demote: [t(ipv6)] }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/cited by 1/);
  });

  it("refuses to demote a file younger than two sprints", () => {
    const fresh = harvested("websites--pilot", "2026-09-09T10:00:00.000Z", 0, "fresh", "brand new fact");
    const s = surveyMemory("", [fresh], [], NOW);
    const res = planCompaction(s, { demote: [fresh.path.slice("fleet/memory/".length)] }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/two sprints|too recent|1 day/);
  });

  it("promotion writes the skill, archives every source, and points the index at the skill", () => {
    const tasks = [1, 2, 3].map((n) => ({ number: n, text: `used ${OLD}-0-cf-rollout and ${OLD}-1-cf-digest` }));
    const res = planCompaction(survey(tasks), {
      promote: [{
        path: "skills/cf-rollout/SKILL.md",
        title: "CF container rollout",
        summary: "the digest bump, the VERSION column, rollout_step_percentage 100",
        content: "# CF rollout\n\nbump rollout_step_percentage to 100. the VERSION column lies. a deployed image never reaches a running container without a digest bump.\n",
        sources: [t(cf), t(digest)],
      }],
    }, NOW);
    if (!res.ok) throw new Error(res.message);
    expect(res.plan.changes).toContainEqual({ path: "skills/cf-rollout/SKILL.md", content: expect.stringContaining("rollout_step_percentage") });
    const index = res.plan.changes.find((c) => c.path === MEMORY_INDEX_PATH)!.content!;
    expect(index).toContain("- [CF container rollout](../../skills/cf-rollout/SKILL.md, +2 archived) —");
    for (const f of [cf, digest]) {
      expect(res.plan.changes).toContainEqual({ path: `fleet/memory/archive/${t(f)}`, content: f.content });
      expect(res.plan.changes).toContainEqual({ path: f.path, content: null });
    }
  });

  it("refuses a promotion whose sources are not cited by three tasks", () => {
    const res = planCompaction(survey([{ number: 1, text: `${OLD}-0-cf-rollout` }]), {
      promote: [{ path: "skills/x/SKILL.md", title: "x", summary: "y", content: "z", sources: [t(cf)] }],
    }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/cited by 1.*3|3\+/s);
  });

  it("refuses a promotion whose skill body drops a specific the memories carried", () => {
    const tasks = [1, 2, 3].map((n) => ({ number: n, text: `${OLD}-0-cf-rollout` }));
    const res = planCompaction(survey(tasks), {
      promote: [{ path: "skills/x/SKILL.md", title: "x", summary: "y", content: "bump the percentage\n", sources: [t(cf)] }],
    }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/100/);
  });

  it("refuses a promotion that writes outside skills/", () => {
    const tasks = [1, 2, 3].map((n) => ({ number: n, text: `${OLD}-0-cf-rollout` }));
    const res = planCompaction(survey(tasks), {
      promote: [{ path: "src/evil.ts", title: "x", summary: "y", content: "bump rollout_step_percentage to 100, the VERSION column lies", sources: [t(cf)] }],
    }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/skills\//);
  });

  it("refuses an unknown source", () => {
    const res = planCompaction(survey(), { demote: ["nope/missing.md"] }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/nope\/missing\.md/);
  });

  it("refuses the same file in two operations", () => {
    const res = planCompaction(survey(), {
      merges: [{ title: "a", summary: "bump rollout_step_percentage to 100, the VERSION column lies, a deployed image never reaches a running container without a digest bump", sources: [t(cf), t(digest)] }],
      demote: [t(digest)],
    }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/twice|more than one/);
  });

  it("an empty proposal still rewrites the index (the bootstrap run) and touches no file", () => {
    const res = planCompaction(survey(), {}, NOW);
    if (!res.ok) throw new Error(res.message);
    expect(res.plan.changes).toHaveLength(1);
    expect(res.plan.changes[0].path).toBe(MEMORY_INDEX_PATH);
    expect(res.plan.summary).toEqual({ merged: 0, demoted: 0, promoted: 0, archived: 0, indexLines: 3 });
  });

  it("the PR body states the rule a reviewer checks it against", () => {
    const res = planCompaction(survey(), { demote: [t(ipv6)] }, NOW);
    if (!res.ok) throw new Error(res.message);
    expect(res.plan.body).toMatch(/never delete|nothing deleted|not deleted/i);
    expect(res.plan.body).toMatch(/archive/);
    expect(res.plan.body).toMatch(/specific/i);
    expect(res.plan.branch).toMatch(/^fleet\/memory-compaction-/);
  });
});
