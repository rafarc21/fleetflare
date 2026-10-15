// #715 Phase 1 Task 14: pure fan-out planning for GateWorkflow. No I/O, no
// Workflow/DO bindings — this file is what bun test can load, so
// workflow.ts (which imports cloudflare:workers) stays a thin driver over
// the decisions made here.
import { MAX_LEGS_PER_PR } from "./config";
import { bunLaneCwd } from "./bun-lane";
import type { LegResult, Verdict } from "./verdict";

export function verdictToStatusArgs(
  verdict: Exclude<Verdict, { state: "pending" }>,
): { state: "success" | "failure" | "error"; description: string } {
  if (verdict.state === "success") return { state: "success", description: "all legs green" };
  // GitHub 422s a commit-status description over 140 chars, which would
  // silently drop the verdict entirely — truncate instead.
  return { state: verdict.state, description: verdict.description.slice(0, 140) };
}

export interface PlanInput {
  owner: string; repo: string; pr: number;
  /** The Workflow instance id: unique per run, so a second run on the same PR
   *  writes its own result keys (a write-once key would 412 otherwise). */
  runId: string;
  headSha: string; baseSha: string;
  install: string; legs: string[];
  /** The bun-test lane, already packed: one array of lane files per leg. */
  bunShards: string[][];
  /** The block's bunLaneRoot: each bun leg enters this directory first. */
  bunLaneRoot: string;
  vitestCmd: string; vitestShards: number;
  baselineKeys: string[];
}

export interface PlannedLeg {
  leg: string; commit: string; installCmd: string; legCmd: string;
  resultKey: string; baselineKeys: string[];
}

/** `{i}`/`{n}` are 1-based, matching vitest's own --shard=i/n. Every occurrence
 *  is replaced, so a template that names the shard twice renders consistently. */
export function vitestLegs(vitestCmd: string, shards: number): { leg: string; legCmd: string }[] {
  return Array.from({ length: shards }, (_, idx) => {
    const i = idx + 1;
    return {
      leg: `vitest-${i}`,
      legCmd: vitestCmd.replaceAll("{i}", String(i)).replaceAll("{n}", String(shards)),
    };
  });
}

/** One leg per bun-lane shard, named bun-1..bun-n. Each runs `bun test` on
 *  its own files, entering the block's root first (bunLaneCwd). */
export function bunLegs(shards: string[][], root: string): { leg: string; legCmd: string }[] {
  return shards.map((files, idx) => ({
    leg: `bun-${idx + 1}`,
    legCmd: `${bunLaneCwd(root)}bun test ${files.join(" ")}`,
  }));
}

/** Every leg of one run, in configured order: merge-tree first (it is the
 *  cheap one that proves the PR merges at all), then fleet.json's legs, then
 *  the bun-test shards, then vitest shards. aggregateVerdict reads this order,
 *  so "first failing leg" is deterministic regardless of which container
 *  reports first.
 *
 *  The vitest shard count is clamped so the whole plan never exceeds
 *  MAX_LEGS_PER_PR. Bun shards count against that cap too; parseGateConfig
 *  already rejects configs that leave no room for one vitest shard, so the
 *  floor of 1 holds. */
export function planLegs(input: PlanInput): PlannedLeg[] {
  const {
    owner, repo, pr, runId, headSha, baseSha, install, legs, bunShards, bunLaneRoot, vitestCmd, vitestShards, baselineKeys,
  } = input;
  const keyFor = (leg: string) => `gate/${owner}/${repo}/runs/${pr}/${runId}/shard-${leg}.json`;
  const fixedLegs = 1 + legs.length + bunShards.length; // merge-tree + fleet.json legs + bun shards
  const shards = Math.max(1, Math.min(vitestShards, MAX_LEGS_PER_PR - fixedLegs));
  const leg = (name: string, commit: string, installCmd: string, legCmd: string, keys: string[]): PlannedLeg => ({
    leg: name, commit, installCmd, legCmd, resultKey: keyFor(name), baselineKeys: keys,
  });
  return [
    leg("merge-tree", `${baseSha}..${headSha}`, "", "", []),
    ...legs.map((name) => leg(name, headSha, install, `bun run ${name}`, baselineKeys)),
    ...bunLegs(bunShards, bunLaneRoot).map((b) => leg(b.leg, headSha, install, b.legCmd, baselineKeys)),
    ...vitestLegs(vitestCmd, shards).map((v) => leg(v.leg, headSha, install, v.legCmd, baselineKeys)),
  ];
}

const LEG_STATES = new Set<LegResult["state"]>(["success", "failure", "error"]);

/** The leg name is forced to the planned one, whatever the DO echoed back. An
 *  unknown state becomes error: a malformed report must never read as success. */
export function normalizeLegResult(planned: string, payload: LegResult): LegResult {
  if (!LEG_STATES.has(payload.state)) {
    return { leg: planned, state: "error", description: `${planned} returned an unknown state` };
  }
  return { leg: planned, state: payload.state, description: payload.description };
}
