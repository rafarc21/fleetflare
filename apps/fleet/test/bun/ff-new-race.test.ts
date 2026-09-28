// Issue #281: `ff <role> --new "<task>"` picked the instance number
// client-side, from a listing it had already fetched, and LABELLED the task
// for that id before spawning. Two concurrent `--new` calls read the same
// listing, both labelled their task for `x--pilot--2`, one spawn won and the
// loser 409ed — with its task already assigned to the WINNER's studio.
//
// ffSpawnNew now spawns first (the Worker allocates the instance), waits for
// the studio, and only then files or adopts the task, against the id the spawn
// returned. bun:test: cli/ff.ts is Bun-only (see ff-file-task-retry.test.ts).
import { describe, expect, test } from "bun:test";
import { ffSpawnNew, type FfSpawnNewDeps } from "../../cli/ff";
import type { FfDecision } from "../../src/studio/ff";

/** A Worker that allocates atomically, a board that records each label. */
function world() {
  let next = 2;
  const labels: { task: number; assignee: string }[] = [];
  let issue = 100;
  const deps: FfSpawnNewDeps = {
    spawn: async () => {
      const id = `x--pilot--${next++}`;
      await new Promise((r) => setTimeout(r, 5)); // a real spawn takes a while
      return id;
    },
    wait: async () => true,
    file: async (id) => {
      const n = issue++;
      labels.push({ task: n, assignee: id });
      return n;
    },
    adopt: async (id, number) => {
      labels.push({ task: number, assignee: id });
      return number;
    },
  };
  return { deps, labels };
}

// What both callers computed from the same stale listing.
const STALE: Extract<FfDecision, { kind: "spawn" }> = { kind: "spawn", id: "x--pilot--2", instance: 2 };

describe("ff --new: the task is labelled AFTER the Worker allocates the id (#281)", () => {
  test("two concurrent --new each label their task with their OWN studio", async () => {
    const w = world();
    const [a, b] = await Promise.all([
      ffSpawnNew(STALE, { kind: "new", text: "task A" }, w.deps),
      ffSpawnNew(STALE, { kind: "new", text: "task B" }, w.deps),
    ]);
    expect(a && b).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
    expect(w.labels).toHaveLength(2);
    for (const r of [a!, b!]) expect(w.labels.find((l) => l.task === r.task)?.assignee).toBe(r.id);
  });

  test("adoption follows the same order", async () => {
    const w = world();
    const [a, b] = await Promise.all([
      ffSpawnNew(STALE, { kind: "adopt", number: 7 }, w.deps),
      ffSpawnNew(STALE, { kind: "adopt", number: 8 }, w.deps),
    ]);
    expect(w.labels.find((l) => l.task === 7)?.assignee).toBe(a!.id);
    expect(w.labels.find((l) => l.task === 8)?.assignee).toBe(b!.id);
  });

  test("#294 r2: a studio that never comes up says the task was NOT filed, and how to retry", async () => {
    const w = world();
    const lines: string[] = [];
    const orig = console.error;
    const origLog = console.log;
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      await ffSpawnNew(STALE, { kind: "new", text: "task A" }, { ...w.deps, wait: async () => false }, "pilot");
      await ffSpawnNew(STALE, { kind: "adopt", number: 42 }, { ...w.deps, wait: async () => false }, "pilot");
    } finally {
      console.error = orig;
      console.log = origLog;
    }
    const out = lines.join("\n");
    expect(out).toContain('task NOT filed: "task A"');
    expect(out).toContain('ff pilot --new "task A"');
    expect(out).toContain("issue #42 NOT adopted");
    expect(out).toContain("ff pilot --new 42");
    expect(out).toMatch(/fleet destroy x--pilot--\d/);
  });

  test("a studio that never comes up gets no task at all", async () => {
    const w = world();
    const out = await ffSpawnNew(STALE, { kind: "new", text: "task A" }, { ...w.deps, wait: async () => false });
    expect(out).toBeNull();
    expect(w.labels).toHaveLength(0);
  });
});
