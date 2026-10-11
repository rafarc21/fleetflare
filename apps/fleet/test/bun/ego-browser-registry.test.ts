import { describe, expect, test } from "bun:test";
import { Registry, type TaskCloser } from "../../container/ego-browser/registry";

// Pure bookkeeping only -- no Playwright, no daemon, no child process. Fast
// and deterministic, per the plan doc's test-plan item 1. The fake target/
// context types below stand in for what daemon.ts plugs in for real
// (Playwright Page / BrowserContext) -- Registry never imports Playwright.
type FakeTarget = { id: string };
type FakeContext = { closed: boolean };

function makeRegistry() {
  return new Registry<FakeTarget, FakeContext>();
}

// The fake plug for registry.ts's TaskCloser port (daemon.ts's real one is
// `{ closeTarget: (p) => p.close(), closeContext: (c) => c.close() }).
// Records every close it was asked to perform, so tests assert on OBSERVED
// closes and removals -- never on the record's internals.
function makeRecordingCloser() {
  const closedTargets: string[] = [];
  let contextCloses = 0;
  const closer: TaskCloser<FakeTarget, FakeContext> = {
    async closeTarget(target) {
      closedTargets.push(target.id);
    },
    async closeContext() {
      contextCloses += 1;
    },
  };
  return { closer, closedTargets, contextCloses: () => contextCloses };
}

describe("Registry.resolve", () => {
  test("a fresh numeric id creates a space using that EXACT id", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve(42, () => ({ closed: false }));
    expect(space.spaceId).toBe(42);
  });

  test("resolving the same numeric id again reuses the same space, not a new one", async () => {
    const registry = makeRegistry();
    const first = await registry.resolve(7, () => ({ closed: false }));
    const second = await registry.resolve(7, () => ({ closed: false }));
    expect(second).toBe(first);
  });

  test("a numeric-looking string resolves the same space as the number", async () => {
    const registry = makeRegistry();
    const byNumber = await registry.resolve(9, () => ({ closed: false }));
    const byString = await registry.resolve("9", () => ({ closed: false }));
    expect(byString).toBe(byNumber);
  });

  test("makeContext is NOT called on a reuse -- only real creation invokes it", async () => {
    const registry = makeRegistry();
    let calls = 0;
    const factory = () => {
      calls += 1;
      return { closed: false };
    };
    await registry.resolve(5, factory);
    expect(calls).toBe(1);
    await registry.resolve(5, factory);
    expect(calls).toBe(1);
  });

  test("a non-numeric name creates a space with an auto-assigned id, and resolving the same name again reuses it", async () => {
    const registry = makeRegistry();
    const first = await registry.resolve("scratch", () => ({ closed: false }));
    expect(Number.isInteger(first.spaceId)).toBe(true);
    const second = await registry.resolve("scratch", () => ({ closed: false }));
    expect(second).toBe(first);
    expect(second.name).toBe("scratch");
  });

  test("a new space starts with exactly one lazy label, p1, with no target yet", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("fresh", () => ({ closed: false }));
    const labels = space.listLabels();
    expect(labels.map((l) => l.label)).toEqual(["p1"]);
    expect(labels[0]!.target).toBeUndefined();
  });

  test("auto space ids never collide with an explicitly-created numeric id seen earlier", async () => {
    const registry = makeRegistry();
    await registry.resolve(1, () => ({ closed: false }));
    const named = await registry.resolve("by-name", () => ({ closed: false }));
    // nextAutoSpaceId must have been bumped past 1 by the explicit create.
    expect(named.spaceId).not.toBe(1);
  });
});

describe("Registry.resolve concurrency", () => {
  // Reproduces the TOCTOU race the reviewer flagged: two concurrent
  // resolve() calls for a key NEITHER has ever seen before both used to
  // observe "nothing exists yet" and both created their own space, with
  // the second write silently orphaning the first (last write wins in
  // `spaces`/`nameToId`). Fired via Promise.all with NO await in between
  // the two resolve() calls -- exactly the shape a concurrent
  // `taskSpace("same-new-name")` from two RPC handlers takes.
  test("two concurrent resolves of a never-before-seen NAME converge on exactly one space, not two", async () => {
    const registry = makeRegistry();
    let calls = 0;
    const factory = () => {
      calls += 1;
      return { closed: false };
    };
    const [a, b] = await Promise.all([
      registry.resolve("brand-new-name", factory),
      registry.resolve("brand-new-name", factory),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(registry.list().length).toBe(1);
  });

  test("two concurrent resolves of a never-before-seen NUMERIC id converge on exactly one space, not two", async () => {
    const registry = makeRegistry();
    let calls = 0;
    const factory = () => {
      calls += 1;
      return { closed: false };
    };
    const [a, b] = await Promise.all([registry.resolve(999, factory), registry.resolve(999, factory)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(registry.list().length).toBe(1);
  });

  test("three-way concurrent resolve of the same never-before-seen name still converges on one space", async () => {
    const registry = makeRegistry();
    let calls = 0;
    const factory = () => {
      calls += 1;
      return { closed: false };
    };
    const results = await Promise.all([
      registry.resolve("triple", factory),
      registry.resolve("triple", factory),
      registry.resolve("triple", factory),
    ]);
    expect(calls).toBe(1);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  test("the in-flight lock is released once settled -- a later, non-concurrent resolve of a DIFFERENT never-before-seen name still creates its own space", async () => {
    const registry = makeRegistry();
    const first = await registry.resolve("after-race-1", () => ({ closed: false }));
    const second = await registry.resolve("after-race-2", () => ({ closed: false }));
    expect(second.spaceId).not.toBe(first.spaceId);
  });
});

describe("TaskSpaceRecord.resolveTarget concurrency", () => {
  // This is the race board issue #30 explicitly flagged: two concurrent
  // calls converging on the same still-lazy label (daemon.ts's
  // `resolvePage`, e.g. `Promise.all([p1.goto(url), p1.evaluate(fn)])` on a
  // page never touched yet) must materialize exactly ONE real target, not
  // two -- the second silently orphaned and unreachable.
  test("two concurrent resolveTarget calls for the same never-materialized label converge on one target, not two", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("race-space", () => ({ closed: false }));
    let calls = 0;
    const create = async (): Promise<FakeTarget> => {
      calls += 1;
      // A real await point, like `context.newPage()` -- this is exactly
      // the window the old check-then-act code raced inside of.
      await Promise.resolve();
      return { id: `page-${calls}` };
    };

    const [a, b] = await Promise.all([space.resolveTarget("p1", create), space.resolveTarget("p1", create)]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(space.getTarget("p1")).toBe(a);
  });

  test("five-way concurrent resolveTarget for the same label still converges on one target", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("race-space-5", () => ({ closed: false }));
    let calls = 0;
    const create = async (): Promise<FakeTarget> => {
      calls += 1;
      await Promise.resolve();
      return { id: `page-${calls}` };
    };

    const results = await Promise.all(Array.from({ length: 5 }, () => space.resolveTarget("p1", create)));

    expect(calls).toBe(1);
    for (const result of results) expect(result).toBe(results[0]);
  });

  test("resolveTarget for two DIFFERENT labels does not serialize -- each gets its own target", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("race-space-diff", () => ({ closed: false }));
    let calls = 0;
    const create = async (): Promise<FakeTarget> => {
      calls += 1;
      await Promise.resolve();
      return { id: `page-${calls}` };
    };

    const [p1, p2] = await Promise.all([space.resolveTarget("p1", create), space.resolveTarget("p2", create)]);
    expect(calls).toBe(2);
    expect(p1).not.toBe(p2);
  });

  test("resolveTarget reuses an already-materialized target without ever calling create again", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("race-space-reuse", () => ({ closed: false }));
    space.setTarget("p1", { id: "already-real" });
    let calls = 0;
    const result = await space.resolveTarget("p1", () => {
      calls += 1;
      return { id: "should-not-be-used" };
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ id: "already-real" });
  });
});

describe("TaskSpaceRecord label bookkeeping", () => {
  test("nextAutoLabel produces p2, p3, ... and never reuses a number even after removal", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("labels", () => ({ closed: false }));
    expect(space.nextAutoLabel()).toBe("p2");
    const third = space.nextAutoLabel();
    expect(third).toBe("p3");
    space.removeLabel(third);
    expect(space.nextAutoLabel()).toBe("p4");
  });

  test("setTarget materializes a previously-lazy label", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("mat", () => ({ closed: false }));
    expect(space.getTarget("p1")).toBeUndefined();
    space.setTarget("p1", { id: "real-page" });
    expect(space.getTarget("p1")).toEqual({ id: "real-page" });
  });
});

// Task-space close is now the record's own behavior (injected closer, same
// shape daemon.ts plugs real Playwright into), so these tests characterize
// the whole ordering the daemon used to sequence itself: per-label target
// close (swallowed errors), label removal, context close only when the
// whole space is done. Receipt fields asserted identically to the old
// pure-receipt tests.
describe("TaskSpaceRecord.finish(keep, closer)", () => {
  test('keep: "all" retains every label and closes nothing', async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("finish-all", () => ({ closed: false }));
    space.setTarget(space.nextAutoLabel(), { id: "p2-page" }); // p2
    const { closer, closedTargets, contextCloses } = makeRecordingCloser();
    const receipt = await space.finish("all", closer);
    expect(receipt.retained.sort()).toEqual(["p1", "p2"]);
    expect(receipt.closed).toEqual([]);
    expect(receipt.spaceClosed).toBe(false);
    expect(closedTargets).toEqual([]);
    expect(contextCloses()).toBe(0);
    expect(space.listLabels().map((l) => l.label).sort()).toEqual(["p1", "p2"]);
  });

  test("keep: an array retains only those labels, closing the rest", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("finish-some", () => ({ closed: false }));
    const p2 = space.nextAutoLabel();
    space.ensureLabel(p2);
    const p3 = space.nextAutoLabel();
    space.setTarget(p3, { id: "p3-page" });
    const { closer, closedTargets, contextCloses } = makeRecordingCloser();
    const receipt = await space.finish(["p1"], closer);
    expect(receipt.retained).toEqual(["p1"]);
    expect(receipt.closed).toEqual([p2, p3]);
    expect(receipt.spaceClosed).toBe(false);
    // Only the CLOSED labels' targets were closed, in receipt order.
    expect(closedTargets).toEqual(["p3-page"]);
    expect(contextCloses()).toBe(0);
    // The kept label survived; the closed labels are gone from the record.
    expect(space.listLabels().map((l) => l.label)).toEqual(["p1"]);
  });

  test("keep: [] closes the whole space -- every target, every label, the context", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("finish-empty", () => ({ closed: false }));
    space.setTarget("p1", { id: "p1-page" });
    const p2 = space.nextAutoLabel();
    space.setTarget(p2, { id: "p2-page" });
    const { closer, closedTargets, contextCloses } = makeRecordingCloser();
    const receipt = await space.finish([], closer);
    expect(receipt.retained).toEqual([]);
    expect(receipt.closed).toEqual(["p1", p2]);
    expect(receipt.spaceClosed).toBe(true);
    expect(closedTargets).toEqual(["p1-page", "p2-page"]);
    expect(contextCloses()).toBe(1);
    expect(space.listLabels()).toEqual([]);
  });

  test("a lazy label (no target materialized) is removed WITHOUT a closeTarget call", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("finish-lazy", () => ({ closed: false }));
    // p1 stays lazy: registered, but nothing ever materialized it.
    const { closer, closedTargets, contextCloses } = makeRecordingCloser();
    const receipt = await space.finish([], closer);
    expect(receipt.closed).toEqual(["p1"]);
    expect(closedTargets).toEqual([]);
    expect(contextCloses()).toBe(1);
    expect(space.listLabels()).toEqual([]);
  });

  test("a closer.closeTarget that REJECTS is swallowed: receipt still returned, all labels still removed, context still closed", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("finish-swallow", () => ({ closed: false }));
    space.setTarget("p1", { id: "p1-page" });
    const contextCloses: FakeContext[] = [];
    const closer: TaskCloser<FakeTarget, FakeContext> = {
      async closeTarget() {
        throw new Error("page already gone");
      },
      async closeContext(context) {
        contextCloses.push(context);
      },
    };
    const receipt = await space.finish([], closer);
    expect(receipt).toEqual({ retained: [], closed: ["p1"], spaceClosed: true });
    expect(space.listLabels()).toEqual([]);
    expect(contextCloses).toEqual([space.context]);
  });
});

describe("TaskSpaceRecord.closeLabel(label, closer)", () => {
  test("closes the label's target and removes the label", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("close-label", () => ({ closed: false }));
    space.setTarget("p1", { id: "p1-page" });
    const { closer, closedTargets, contextCloses } = makeRecordingCloser();
    await space.closeLabel("p1", closer);
    expect(closedTargets).toEqual(["p1-page"]);
    expect(space.hasLabel("p1")).toBe(false);
    expect(contextCloses()).toBe(0); // closeLabel never touches the context.
  });

  test("a label with no materialized target is just removed -- no closer call, no throw", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("close-lazy-label", () => ({ closed: false }));
    const { closer, closedTargets } = makeRecordingCloser();
    await space.closeLabel("p1", closer);
    expect(closedTargets).toEqual([]);
    expect(space.hasLabel("p1")).toBe(false);
  });

  test("an unknown label is a no-op -- no closer call, no throw", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("close-unknown-label", () => ({ closed: false }));
    const { closer, closedTargets } = makeRecordingCloser();
    await space.closeLabel("never-registered", closer);
    expect(closedTargets).toEqual([]);
  });

  test("a rejecting closeTarget PROPAGATES and the label is NOT removed -- the failure must be heard", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("close-label-throws", () => ({ closed: false }));
    space.setTarget("p1", { id: "p1-page" });
    const closer: TaskCloser<FakeTarget, FakeContext> = {
      async closeTarget() {
        throw new Error("close refused");
      },
      async closeContext() {},
    };
    await expect(space.closeLabel("p1", closer)).rejects.toThrow(/close refused/);
    // daemon.ts's old page.close order: `if (target) await target.close();`
    // then `removeLabel` -- a throw means removal never runs.
    expect(space.hasLabel("p1")).toBe(true);
    expect(space.getTarget("p1")).toEqual({ id: "p1-page" });
  });
});

describe("Registry.finish(spaceId, keep, closer)", () => {
  test("unknown spaceId throws the same message daemon's resolveSpace throws", async () => {
    const registry = makeRegistry();
    const { closer } = makeRecordingCloser();
    await expect(registry.finish(777, [], closer)).rejects.toThrow(
      /ego-browser: no task space 777 \(finished, or never created\)/,
    );
  });

  test("spaceClosed: the space is removed from the registry, not just closed", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("registry-finish-gone", () => ({ closed: false }));
    space.setTarget("p1", { id: "p1-page" });
    const { closer, contextCloses } = makeRecordingCloser();
    const receipt = await registry.finish(space.spaceId, [], closer);
    expect(receipt).toEqual({ retained: [], closed: ["p1"], spaceClosed: true });
    expect(contextCloses()).toBe(1);
    expect(registry.get(space.spaceId)).toBeUndefined();
    // Removal cleared the name mapping too: resolving the same name again
    // is a genuinely NEW space, never the finished one.
    const recreated = await registry.resolve("registry-finish-gone", () => ({ closed: false }));
    expect(recreated.spaceId).not.toBe(space.spaceId);
  });

  test("not spaceClosed: the space stays registered with exactly the kept labels", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("registry-finish-partial", () => ({ closed: false }));
    const p2 = space.nextAutoLabel();
    space.setTarget(p2, { id: "p2-page" });
    const { closer, closedTargets, contextCloses } = makeRecordingCloser();
    const receipt = await registry.finish(space.spaceId, ["p1"], closer);
    expect(receipt).toEqual({ retained: ["p1"], closed: [p2], spaceClosed: false });
    expect(closedTargets).toEqual(["p2-page"]);
    expect(contextCloses()).toBe(0);
    expect(registry.get(space.spaceId)).toBe(space);
    expect(space.listLabels().map((l) => l.label)).toEqual(["p1"]);
  });
});

describe("Registry.remove / list", () => {
  test("remove() drops the space and its name mapping so it can never be resolved by either again", async () => {
    const registry = makeRegistry();
    const space = await registry.resolve("gone", () => ({ closed: false }));
    registry.remove(space.spaceId);
    expect(registry.get(space.spaceId)).toBeUndefined();
    const recreated = await registry.resolve("gone", () => ({ closed: false }));
    expect(recreated.spaceId).not.toBe(space.spaceId);
  });

  test("list() reflects every currently-registered space", async () => {
    const registry = makeRegistry();
    await registry.resolve(101, () => ({ closed: false }));
    await registry.resolve(102, () => ({ closed: false }));
    expect(registry.list().map((s) => s.spaceId).sort()).toEqual([101, 102]);
  });
});
