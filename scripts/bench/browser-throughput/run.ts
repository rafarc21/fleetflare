// Config A runner: in-container Chromium, k worker contexts (k=1,2,4,8), the
// 50-spec suite repeated >=5 times per k. Emits per-suite wall + per-spec
// timings to out/config-a/{runs.csv, aggregate.json}.
//
// Each k runs in its OWN child process (run-one.ts) — one browser per k, one
// gate container per shard in the shard model. The child runs are SEQUENTIAL:
// running k in parallel would measure CPU contention between k's, not each
// k's own throughput. run-one.ts reuses one browser across its runs (warm).
//
// Usage:
//   BENCH_CHROMIUM_PATH=/usr/local/bin/chromium \
//   bun scripts/bench/browser-throughput/run.ts \
//     --k 1,2,4,8 --runs 5 --out scripts/bench/browser-throughput/out/config-a
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { SPECS } from "./specs.ts";

const here = import.meta.dir;

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    ks: (get("--k") ?? "1,2,4,8").split(",").map((s) => Number(s.trim())),
    runs: Number(get("--runs") ?? "5"),
    out: get("--out") ?? `${here}/out/config-a`,
  };
}

function main() {
  const args = parseArgs(Bun.argv.slice(2));

  for (const k of args.ks) {
    console.log(`# k=${k} (fresh process)`);
    const res = spawnSync("bun", [`${here}/run-one.ts`, "--k", String(k), "--runs", String(args.runs), "--out", `${args.out}/k${k}`], {
      stdio: "inherit",
    });
    if (res.status !== 0) {
      console.error(`k=${k} run failed (status ${res.status})`);
      process.exit(res.status ?? 1);
    }
  }

  // Fold the per-k aggregates into one config-A aggregate.
  const byK: Record<string, unknown> = {};
  for (const k of args.ks) {
    const agg = JSON.parse(readFileSync(`${args.out}/k${k}/aggregate.json`, "utf8")) as Record<string, unknown>;
    byK[`k${k}`] = agg;
  }
  // Also emit the full runs.csv (union of per-k CSVs).
  const header = "run,k,wall_ms,boot_ms,ok,failed,flake_rate";
  const rows: string[] = [header];
  for (const k of args.ks) {
    const csv = readFileSync(`${args.out}/k${k}/runs.csv`, "utf8").trim().split("\n");
    rows.push(...csv.slice(1)); // drop each per-k header
  }
  writeFileSync(`${args.out}/runs.csv`, rows.join("\n") + "\n");
  const agg = {
    suite_specs: SPECS.length,
    ks: args.ks,
    ...byK,
  };
  writeFileSync(`${args.out}/aggregate.json`, JSON.stringify(agg, null, 2) + "\n");
  console.log(`\nwrote ${args.out}/runs.csv + ${args.out}/aggregate.json`);
}

main();