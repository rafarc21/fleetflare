// Pure fan-out planning for GateWorkflow (Task 14). No I/O, no bindings:
// the Workflow feeds these results into step.do/waitForEvent calls.
import { describe, it, expect } from "bun:test";
import { legEventType, normalizeLegResult, planLegs, vitestLegs } from "../../src/gate/fanout";

const BASE = {
  owner: "acme", repo: "example", pr: 7,
  headSha: "h".repeat(40), baseSha: "b".repeat(40),
  install: "bun install --frozen-lockfile",
  legs: ["typecheck", "lint"],
  vitestCmd: "bun run test --shard={i}/{n}",
  vitestShards: 2,
  baselineKeys: ["gate/acme/example/baselines/x.tar"],
};

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
  it("configured legs run `bun run <name>` after the shared install", () => {
    const lint = planLegs(BASE)[2];
    expect(lint.installCmd).toBe(BASE.install);
    expect(lint.legCmd).toBe("bun run lint");
    expect(lint.commit).toBe(BASE.headSha);
  });
  it("result keys are one distinct gate/ key per leg per run", () => {
    const keys = planLegs(BASE).map((l) => l.resultKey);
    expect(keys[0]).toBe("gate/acme/example/runs/7/shard-merge-tree.json");
    expect(keys[3]).toBe("gate/acme/example/runs/7/shard-vitest-1.json");
    expect(new Set(keys).size).toBe(keys.length);
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
