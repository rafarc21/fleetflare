// Config B model: N gate-style shards (containers), each running 50/N specs.
// Pure arithmetic, no browser — folds config A's MEASURED per-shard time with
// the gate's own boot/overhead constants into a wall + cost table.
//
// Inputs:
//   - config A wall at k=4 (one container) from out/config-a/aggregate.json
//   - container cold start: <=60s ASSUMED (unmeasured on CF containers —
//     docs/superpowers/specs/2026-10-15-gate-runner-design.md:227). The one
//     MEASURED fact is an image-pull cold host >60s (apps/fleet/src/gate/run-leg.ts
//     PORT_RETRY_BUDGET_MS comment), so the model spans 30-90s cold.
//   - checkout 2-8s + install 4s (cache hit) per container, in parallel
//   - standard-4 = 4 vCPU/12 GiB/20 GB, ~$0.066/10-min leg run (same doc)
//
// Model: suite wall = cold + checkout + install + (configA_k4 / N). The
// compute term shrinks 1/N, but cold+setup is paid PER container, so sharding
// buys almost nothing once boot dominates. Cost scales N x linearly.
import { readFileSync } from "node:fs";

const here = import.meta.dir;

interface ConfigAAgg {
  k4?: { wall_p50_ms: number };
}

function configA() {
  const p = `${here}/out/config-a/aggregate.json`;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ConfigAAgg;
  } catch {
    console.error(`config A aggregate missing at ${p}; run config A first.`);
    process.exit(1);
  }
}

const a = configA();
if (!a.k4) {
  console.error("config A aggregate has no k4 entry; run config A first.");
  process.exit(1);
}
const oneContainerWallMs = a.k4.wall_p50_ms; // suite wall in ONE container at k=4
const checkoutMs = 5_000; // 2-8s, mid
const installMs = 4_000; // cache hit
const coldMs = Number((process.env.BENCH_B_COLD_MS ?? "60000").replace(/_/g, "")); // <=60s assumed

function fmt(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

console.log(`config A k=4 one-container wall: ${fmt(oneContainerWallMs)} (measured)`);
console.log(`config B overhead/container: cold=${fmt(coldMs)} + checkout=${fmt(checkoutMs)} + install=${fmt(installMs)}\n`);

const rows: string[] = [];
for (let n = 1; n <= 8; n++) {
  const overhead = coldMs + checkoutMs + installMs;
  const compute = oneContainerWallMs / n; // perfectly parallel split
  const wall = overhead + compute;
  const cost = (n * 0.066).toFixed(3);
  rows.push(
    `${n}\t${fmt(wall)}\t${fmt(compute)}\t${fmt(overhead)}\t$${cost}`,
  );
}
console.log("N\tsuite wall\tcompute\tboot+setup\tcost");
console.log(rows.join("\n"));

console.log(`
Read: sharding the 50-spec browser suite buys a ~${fmt(oneContainerWallMs - oneContainerWallMs / 8)} wall saving
(N=8) against a ${fmt(coldMs + checkoutMs + installMs)} per-container overhead that dominates the wall and scales
cost 8x. Sharding pays only when compute >> boot — true for the 674s bun-test
lane, false for a ${fmt(oneContainerWallMs)} browser suite.`);