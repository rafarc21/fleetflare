// Pure fan-out planning for GateWorkflow (Task 14). No I/O, no bindings:
// the Workflow feeds these results into step.do calls.
import { describe, it, expect } from "bun:test";
import {
  bunLegs, carriedGreenByLeg, normalizeLegResult, outcomeLegs, planFingerprint, planLegs, planUnionLegs, vitestLegs,
  type CarryGreen,
} from "../../src/gate/fanout";
import { MAX_LEGS_PER_PR } from "../../src/gate/config";
import { resolveOutboundTarget } from "../../src/gate/outbound-handler";

const LEGS = [
  { name: "typecheck", cmd: "bun run typecheck" },
  { name: "lint", cmd: "bun run lint" },
];

const BASE = {
  owner: "acme", repo: "example", pr: 7, runId: "run-a",
  headSha: "h".repeat(40), baseSha: "b".repeat(40),
  install: "bun install --frozen-lockfile",
  legs: LEGS,
  vitestCmd: "bun run test --shard={i}/{n}",
  vitestShards: 2,
  bunShards: [],
  bunLaneRoot: "apps/fleet",
  baselineKeys: ["gate/acme/example/baselines/x.tar"],
};

const BUN_SHARDS = [["test/bun/alpha.test.ts", "test/bun/beta.test.ts"], ["test/bun/gamma.test.ts"]];


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
    const legs = planLegs({ ...BASE, legs: LEGS, bunShards, vitestShards: 30 });
    expect(legs.length).toBe(MAX_LEGS_PER_PR);
    expect(legs.filter((l) => l.leg.startsWith("vitest-")).length).toBe(MAX_LEGS_PER_PR - 1 - 2 - 6);
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
    const legs = planLegs({ ...BASE, legs: LEGS, bunShards: BUN_SHARDS });
    expect(legs.length).toBeGreaterThan(1);
    for (const l of legs) expect(l.commit).toBe(range);
  });
  it("a leg's own cmd is its command, verbatim, after the shared install", () => {
    const legs = planLegs({ ...BASE, legs: [{ name: "e2e", cmd: "cd apps/web && bun run e2e -- --bail" }] });
    const e2e = legs.find((l) => l.leg === "e2e")!;
    expect(e2e.legCmd).toBe("cd apps/web && bun run e2e -- --bail");
    expect(e2e.installCmd).toBe(BASE.install);
  });
  it("a configured leg's timeoutMin is carried onto its planned leg; a leg without one carries none", () => {
    const legs = planLegs({ ...BASE, legs: [{ name: "e2e", cmd: "make e2e", timeoutMin: 9 }, { name: "lint", cmd: "bun run lint" }] });
    expect(legs.find((l) => l.leg === "e2e")?.timeoutMin).toBe(9);
    expect(legs.find((l) => l.leg === "lint")?.timeoutMin).toBeUndefined();
  });
  it("vitest absent -> zero vitest legs; the plan is merge-tree, configured legs, bun shards", () => {
    const legs = planLegs({ ...BASE, vitestCmd: undefined, bunShards: BUN_SHARDS });
    expect(legs.map((l) => l.leg)).toEqual(["merge-tree", "typecheck", "lint", "bun-1", "bun-2"]);
    expect(legs.some((l) => l.leg.startsWith("vitest-"))).toBe(false);
  });
  it("vitest absent -> the cap admits 23 configured legs: merge-tree + 23 = 24", () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ name: `leg-${i}`, cmd: `echo ${i}` }));
    const legs = planLegs({ ...BASE, legs: many, vitestCmd: undefined, bunShards: [] });
    expect(legs.length).toBe(MAX_LEGS_PER_PR);
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
    const legs = planLegs({ ...BASE, legs: LEGS, vitestShards: 30 });
    expect(legs.length).toBe(MAX_LEGS_PER_PR);
    expect(legs.filter((l) => l.leg.startsWith("vitest-")).length).toBe(MAX_LEGS_PER_PR - 1 - 2);
  });
  it("a shard count under the cap is honored as asked", () => {
    const legs = planLegs({ ...BASE, legs: [LEGS[0]], vitestShards: 8 });
    expect(legs.filter((l) => l.leg.startsWith("vitest-")).length).toBe(8);
    expect(legs.length).toBe(10);
  });
  it("the default 8-shard fan-out renders --shard=i/8 on each vitest leg", () => {
    const vitest = planLegs({ ...BASE, legs: [], vitestShards: 8 }).filter((l) => l.leg.startsWith("vitest-"));
    expect(vitest.map((l) => l.legCmd)).toContain("bun run test --shard=3/8");
    expect(vitest.every((l) => l.installCmd === BASE.install)).toBe(true);
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

describe("normalizeLegResult keeps ms and summary (#1049)", () => {
  it("passes both through beside the leg, state and description", () => {
    expect(normalizeLegResult("vitest-1", {
      leg: "x", state: "failure", description: "f", ms: 1200, summary: "Tests 1 failed | 1640 passed (1641)",
    })).toEqual({
      leg: "vitest-1", state: "failure", description: "f", ms: 1200, summary: "Tests 1 failed | 1640 passed (1641)",
    });
  });
});

describe("outcomeLegs (#1049: per-leg output in plan order)", () => {
  it("maps each leg to its state, ms, summary and description, in the order given", () => {
    expect(outcomeLegs([
      { leg: "merge-tree", state: "success", ms: 900 },
      { leg: "lint", state: "failure", description: "3 errors", ms: 83_000, summary: "Tests 3 failed" },
    ])).toEqual([
      { leg: "merge-tree", state: "success", ms: 900 },
      { leg: "lint", state: "failure", ms: 83_000, summary: "Tests 3 failed", description: "3 errors" },
    ]);
  });
});

// #1091 review (refs #715): a PR that changes fleet.json runs the base plan in
// full, plus each head leg whose content differs from base, named `<leg>@head`.
describe("planUnionLegs: base plan + differing head legs (#1091 review)", () => {
  it("a weakening head (typecheck = true) still runs base typecheck; head's runs as typecheck@head", () => {
    const head = { ...BASE, legs: [{ name: "typecheck", cmd: "true" }, { name: "lint", cmd: "bun run lint" }] };
    const legs = planUnionLegs(BASE, head);
    expect(legs.map((l) => l.leg)).toEqual(["merge-tree", "typecheck", "lint", "vitest-1", "vitest-2", "typecheck@head"]);
    expect(legs.find((l) => l.leg === "typecheck")?.legCmd).toBe("bun run typecheck");
    expect(legs.find((l) => l.leg === "typecheck@head")?.legCmd).toBe("true");
  });

  it("a shard-count-only change runs every base shard and every head shard", () => {
    const legs = planUnionLegs(BASE, { ...BASE, vitestShards: 4 });
    expect(legs.map((l) => l.leg)).toEqual([
      "merge-tree", "typecheck", "lint", "vitest-1", "vitest-2",
      "vitest@head-1", "vitest@head-2", "vitest@head-3", "vitest@head-4",
    ]);
    expect(legs.find((l) => l.leg === "vitest@head-4")?.legCmd).toBe("bun run test --shard=4/4");
  });

  it("an identical config adds no @head legs: the union is the base plan", () => {
    expect(planUnionLegs(BASE, { ...BASE })).toEqual(planLegs(BASE));
  });

  it("each leg keeps its own block's image: base legs use base's, head legs use head's", () => {
    const legs = planUnionLegs({ ...BASE, image: "gate" }, { ...BASE, image: "desktop", legs: [{ name: "lint", cmd: "true" }] });
    expect(legs.find((l) => l.leg === "typecheck")?.image).toBe("gate");
    expect(legs.find((l) => l.leg === "lint@head")?.image).toBe("desktop");
  });

  it("an install change runs every head leg as @head: the install is part of the leg", () => {
    const legs = planUnionLegs(BASE, { ...BASE, install: "bun install" });
    expect(legs.map((l) => l.leg)).toEqual([
      "merge-tree", "typecheck", "lint", "vitest-1", "vitest-2",
      "typecheck@head", "lint@head", "vitest@head-1", "vitest@head-2",
    ]);
  });

  it("a vitestCmd change runs only the head vitest shards as @head", () => {
    const legs = planUnionLegs(BASE, { ...BASE, vitestCmd: "bun run test --shard={i}/{n} --changed" });
    expect(legs.map((l) => l.leg)).toEqual([
      "merge-tree", "typecheck", "lint", "vitest-1", "vitest-2", "vitest@head-1", "vitest@head-2",
    ]);
    expect(legs.find((l) => l.leg === "vitest@head-1")?.legCmd).toBe("bun run test --shard=1/2 --changed");
  });

  it("an image-only change (same commands, gate to desktop) still runs every head leg as @head", () => {
    const legs = planUnionLegs({ ...BASE, image: "gate" }, { ...BASE, image: "desktop" });
    expect(legs.map((l) => l.leg)).toEqual([
      "merge-tree", "typecheck", "lint", "vitest-1", "vitest-2",
      "typecheck@head", "lint@head", "vitest@head-1", "vitest@head-2",
    ]);
    expect(legs.find((l) => l.leg === "typecheck@head")?.image).toBe("desktop");
    expect(legs.find((l) => l.leg === "typecheck")?.image).toBe("gate");
  });

  it("a gate added with no base runs the head legs, all named @head", () => {
    const legs = planUnionLegs(null, BASE);
    expect(legs.map((l) => l.leg)).toEqual([
      "merge-tree", "typecheck@head", "lint@head", "vitest@head-1", "vitest@head-2",
    ]);
  });

  it("an omitted image and an explicit default image are the same leg: no @head copy", () => {
    expect(planUnionLegs(BASE, { ...BASE, image: "gate" })).toEqual(planLegs(BASE));
  });
});

// #1230: a plan's fingerprint over its own runnable content (leg name +
// install/cmd/timeout/image), used to tell whether a carried run's green legs
// still apply to a NEW run's plan.
describe("planFingerprint (#1230)", () => {
  it("the same legs from the same plan fingerprint equal", () => {
    expect(planFingerprint(planLegs(BASE))).toBe(planFingerprint(planLegs(BASE)));
  });
  it("a different legCmd changes the fingerprint", () => {
    const a = planLegs(BASE);
    const b = planLegs({ ...BASE, legs: [{ name: "typecheck", cmd: "true" }, LEGS[1]] });
    expect(planFingerprint(a)).not.toBe(planFingerprint(b));
  });
  it("a different timeoutMin changes the fingerprint", () => {
    const a = planLegs(BASE);
    const b = planLegs({ ...BASE, legs: [{ name: "typecheck", cmd: LEGS[0].cmd, timeoutMin: 9 }, LEGS[1]] });
    expect(planFingerprint(a)).not.toBe(planFingerprint(b));
  });
  it("a different image changes the fingerprint", () => {
    const a = planLegs({ ...BASE, image: "gate" });
    const b = planLegs({ ...BASE, image: "desktop" });
    expect(planFingerprint(a)).not.toBe(planFingerprint(b));
  });
  it("a different leg name changes the fingerprint", () => {
    const a = planLegs(BASE);
    const b = planLegs({ ...BASE, legs: [{ name: "typecheck2", cmd: LEGS[0].cmd }, LEGS[1]] });
    expect(planFingerprint(a)).not.toBe(planFingerprint(b));
  });
});

// #1230: the prior run's green legs, valid ONLY while head sha, base sha and
// the plan fingerprint all match this run's own resolve — any mismatch must
// never count, so the caller replans and reruns every leg as if uncarried.
describe("carriedGreenByLeg (#1230)", () => {
  const CTX = { headSha: "h".repeat(40), baseSha: "b".repeat(40), configHash: "fp-1" };
  const CARRY: CarryGreen = {
    headSha: CTX.headSha, baseSha: CTX.baseSha, configHash: CTX.configHash,
    legs: [
      { leg: "merge-tree", state: "success" },
      { leg: "typecheck", state: "success" },
      { leg: "lint", state: "failure", description: "3 errors" },
    ],
  };

  it("a matching ctx carries only the success legs, dropping any failure/error entry", () => {
    const byLeg = carriedGreenByLeg(CARRY, CTX);
    expect([...byLeg.keys()].sort()).toEqual(["merge-tree", "typecheck"]);
    expect(byLeg.get("merge-tree")).toEqual({ leg: "merge-tree", state: "success" });
  });

  it("a mismatched headSha returns an empty map", () => {
    expect(carriedGreenByLeg(CARRY, { ...CTX, headSha: "c".repeat(40) }).size).toBe(0);
  });

  it("a mismatched baseSha returns an empty map", () => {
    expect(carriedGreenByLeg(CARRY, { ...CTX, baseSha: "c".repeat(40) }).size).toBe(0);
  });

  it("a mismatched configHash returns an empty map", () => {
    expect(carriedGreenByLeg(CARRY, { ...CTX, configHash: "fp-2" }).size).toBe(0);
  });

  it("no carry (undefined) returns an empty map", () => {
    expect(carriedGreenByLeg(undefined, CTX).size).toBe(0);
  });
});
