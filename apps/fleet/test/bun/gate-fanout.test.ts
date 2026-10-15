// Pure fan-out planning for GateWorkflow (Task 14). No I/O, no bindings:
// the Workflow feeds these results into step.do/waitForEvent calls.
import { describe, it, expect } from "bun:test";
import { bunLegs, legEventType, normalizeLegResult, planLegs, vitestLegs } from "../../src/gate/fanout";
import { MAX_LEGS_PER_PR } from "../../src/gate/config";
import { resolveOutboundTarget } from "../../src/gate/outbound-handler";

const BASE = {
  owner: "acme", repo: "example", pr: 7, runId: "run-a",
  headSha: "h".repeat(40), baseSha: "b".repeat(40),
  install: "bun install --frozen-lockfile",
  legs: ["typecheck", "lint"],
  vitestCmd: "bun run test --shard={i}/{n}",
  vitestShards: 2,
  bunShards: [],
  bunLaneRoot: "apps/fleet",
  baselineKeys: ["gate/acme/example/baselines/x.tar"],
};

const BUN_SHARDS = [["test/bun/alpha.test.ts", "test/bun/beta.test.ts"], ["test/bun/gamma.test.ts"]];

describe("legEventType", () => {
  it("prefixes the leg name, keeping the type inside Workflows' allowed charset", () => {
    expect(legEventType("vitest-1")).toBe("gate-leg-vitest-1");
  });
  it("replaces characters Workflows rejects (a dot is invalid_event_type)", () => {
    const t = legEventType("lint.ts");
    expect(t).toBe("gate-leg-lint_ts");
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("vitestLegs", () => {
  it("substitutes {i} and {n} once per shard, 1-based", () => {
    expect(vitestLegs("bun run test --shard={i}/{n}", 2)).toEqual([
      { leg: "vitest-1", legCmd: "bun run test --shard=1/2" },
      { leg: "vitest-2", legCmd: "bun run test --shard=2/2" },
    ]);
  });
  it("one shard still yields one leg, --shard=1/1", () => {
    expect(vitestLegs("bun run test --shard={i}/{n}", 1)).toEqual([
      { leg: "vitest-1", legCmd: "bun run test --shard=1/1" },
    ]);
  });
  it("renders the default 8-shard fan-out: 8 legs, last one --shard=8/8", () => {
    const legs = vitestLegs("bun run test --shard={i}/{n}", 8);
    expect(legs.map((l) => l.leg)).toEqual(
      ["vitest-1", "vitest-2", "vitest-3", "vitest-4", "vitest-5", "vitest-6", "vitest-7", "vitest-8"],
    );
    expect(legs.map((l) => l.legCmd)).toEqual(
      Array.from({ length: 8 }, (_, idx) => `bun run test --shard=${idx + 1}/8`),
    );
  });
  it("replaces every occurrence of {i} and {n}, not just the first", () => {
    expect(vitestLegs("run {i}-{i} of {n}/{n}", 3)[1].legCmd).toBe("run 2-2 of 3/3");
  });
});

describe("bunLegs", () => {
  it("one leg per bun shard, named bun-1..bun-n", () => {
    expect(bunLegs(BUN_SHARDS, "apps/fleet").map((l) => l.leg)).toEqual(["bun-1", "bun-2"]);
  });
  it("each leg runs bun test on its own files, inside the block's root", () => {
    expect(bunLegs(BUN_SHARDS, "apps/fleet").map((l) => l.legCmd)).toEqual([
      "cd apps/fleet && bun test test/bun/alpha.test.ts test/bun/beta.test.ts",
      "cd apps/fleet && bun test test/bun/gamma.test.ts",
    ]);
  });
  it("a per-repo root moves every bun leg's cd, not just the fleet's", () => {
    expect(bunLegs([["test/bun/a.test.ts"]], "packages/web")[0].legCmd).toBe(
      "cd packages/web && bun test test/bun/a.test.ts",
    );
  });
  it("no shards -> no legs", () => {
    expect(bunLegs([], "apps/fleet")).toEqual([]);
  });
});

describe("planLegs with bun shards", () => {
  it("orders merge-tree, configured legs, bun shards, then vitest shards", () => {
    const legs = planLegs({ ...BASE, bunShards: BUN_SHARDS });
    expect(legs.map((l) => l.leg)).toEqual([
      "merge-tree", "typecheck", "lint", "bun-1", "bun-2", "vitest-1", "vitest-2",
    ]);
  });
  it("each bun leg installs first and runs its own files; no baseline keys skipped", () => {
    const bun = planLegs({ ...BASE, bunShards: BUN_SHARDS }).find((l) => l.leg === "bun-2")!;
    expect(bun.installCmd).toBe(BASE.install);
    expect(bun.legCmd).toBe("cd apps/fleet && bun test test/bun/gamma.test.ts");
    expect(bun.commit).toBe(`${BASE.baseSha}..${BASE.headSha}`);
    expect(bun.baselineKeys).toEqual(BASE.baselineKeys);
  });
  it("bun shards count toward MAX_LEGS_PER_PR: vitest shards shrink to fit", () => {
    const bunShards = Array.from({ length: 6 }, (_, i) => [`test/bun/s${i}.test.ts`]);
    const legs = planLegs({ ...BASE, legs: ["typecheck", "lint"], bunShards, vitestShards: 30 });
    expect(legs.length).toBe(MAX_LEGS_PER_PR);
    expect(legs.filter((l) => l.leg.startsWith("vitest-")).length).toBe(MAX_LEGS_PER_PR - 1 - 2 - 6);
  });
  it("every bun leg has its own event type", () => {
    const types = planLegs({ ...BASE, bunShards: BUN_SHARDS }).map((l) => l.eventType);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe("planLegs", () => {
  it("emits merge-tree first, then configured legs, then vitest shards", () => {
    expect(planLegs(BASE).map((l) => l.leg)).toEqual([
      "merge-tree", "typecheck", "lint", "vitest-1", "vitest-2",
    ]);
  });
  it("merge-tree carries the base..head range and no install or leg command", () => {
    const mt = planLegs(BASE)[0];
    expect(mt.commit).toBe(`${BASE.baseSha}..${BASE.headSha}`);
    expect(mt.installCmd).toBe("");
    expect(mt.legCmd).toBe("");
  });
  it("every leg carries the base..head merge range, never the bare PR head", () => {
    const range = `${BASE.baseSha}..${BASE.headSha}`;
    const legs = planLegs({ ...BASE, legs: ["typecheck", "lint"], bunShards: BUN_SHARDS });
    expect(legs.length).toBeGreaterThan(1);
    for (const l of legs) expect(l.commit).toBe(range);
  });
  it("configured legs run `bun run <name>` after the shared install", () => {
    const lint = planLegs(BASE)[2];
    expect(lint.installCmd).toBe(BASE.install);
    expect(lint.legCmd).toBe("bun run lint");
    expect(lint.commit).toBe(`${BASE.baseSha}..${BASE.headSha}`);
  });
  it("result keys are one distinct gate/ key per leg per run", () => {
    const keys = planLegs(BASE).map((l) => l.resultKey);
    expect(keys[0]).toBe("gate/acme/example/runs/7/run-a/shard-merge-tree.json");
    expect(keys[3]).toBe("gate/acme/example/runs/7/run-a/shard-vitest-1.json");
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("two runs on one PR never collide, even when they gate the same head SHA", () => {
    const first = planLegs({ ...BASE, runId: "run-a" }).map((l) => l.resultKey);
    const second = planLegs({ ...BASE, runId: "run-b" }).map((l) => l.resultKey);
    const overlap = first.filter((k) => second.includes(k));
    expect(overlap).toEqual([]);
  });
  it("every planned result key is accepted by the outbound allow-list, for its own leg", () => {
    for (const leg of planLegs(BASE)) {
      expect(resolveOutboundTarget(`/${leg.resultKey}`)).toEqual({ bucket: "STUDIO_ARCHIVE", key: leg.resultKey });
    }
  });
  it("total legs per PR never exceed MAX_LEGS_PER_PR, even when the shard count asks for more", () => {
    const legs = planLegs({ ...BASE, legs: ["typecheck", "lint"], vitestShards: 30 });
    expect(legs.length).toBe(MAX_LEGS_PER_PR);
    expect(legs.filter((l) => l.leg.startsWith("vitest-")).length).toBe(MAX_LEGS_PER_PR - 1 - 2);
  });
  it("a shard count under the cap is honored as asked", () => {
    const legs = planLegs({ ...BASE, legs: ["typecheck"], vitestShards: 8 });
    expect(legs.filter((l) => l.leg.startsWith("vitest-")).length).toBe(8);
    expect(legs.length).toBe(10);
  });
  it("the default 8-shard fan-out renders --shard=i/8 on each vitest leg", () => {
    const vitest = planLegs({ ...BASE, legs: [], vitestShards: 8 }).filter((l) => l.leg.startsWith("vitest-"));
    expect(vitest.map((l) => l.legCmd)).toContain("bun run test --shard=3/8");
    expect(vitest.every((l) => l.installCmd === BASE.install)).toBe(true);
  });
  it("every leg gets its own event type, so concurrent waits never race", () => {
    const types = planLegs(BASE).map((l) => l.eventType);
    expect(new Set(types).size).toBe(types.length);
  });
  it("only the merge-tree leg skips the baseline; the rest get the baseline keys", () => {
    const legs = planLegs(BASE);
    expect(legs[0].baselineKeys).toEqual([]);
    expect(legs[1].baselineKeys).toEqual(BASE.baselineKeys);
  });
});

describe("normalizeLegResult", () => {
  it("passes a well-formed payload through under the planned leg name", () => {
    expect(normalizeLegResult("lint", { leg: "lint", state: "failure", description: "3 errors" })).toEqual({
      leg: "lint", state: "failure", description: "3 errors",
    });
  });
  it("forces the planned leg name, so a mislabelled payload still maps to its own leg", () => {
    expect(normalizeLegResult("lint", { leg: "typo", state: "success" })).toEqual({
      leg: "lint", state: "success", description: undefined,
    });
  });
  it("an unknown state becomes error, never a silent success", () => {
    expect(normalizeLegResult("lint", { leg: "lint", state: "passed" as never })).toEqual({
      leg: "lint", state: "error", description: "lint returned an unknown state",
    });
  });
});
