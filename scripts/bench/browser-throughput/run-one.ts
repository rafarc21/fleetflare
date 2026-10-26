// One config-A cell: a single k (worker contexts) run for `--runs` suite
// passes, in a FRESH process. run.ts orchestrates by spawning one of these
// per k — each k = one browser = one gate container in the shard model, so a
// fresh process per k is the honest shape, and it also avoids the in-process
// cross-k browser-relaunch stall Chromium shows in this image.
//
// Usage:
//   bun scripts/bench/browser-throughput/run-one.ts --k 4 --runs 5 \
//     --out scripts/bench/browser-throughput/out/config-a/k4
import { spawn, type ChildProcess } from "node:child_process";
import { SPECS } from "./specs.ts";
import { runSuiteWithK, type SuiteResult } from "./harness.ts";
import { createChromeFactory } from "./drivers/chrome.ts";

const here = import.meta.dir;

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    k: Number(get("--k") ?? "1"),
    runs: Number(get("--runs") ?? "5"),
    out: get("--out") ?? `${here}/out/config-a/k1`,
  };
}

const FIXTURE_PORT = Number(process.env.BENCH_PORT ?? "8318");
const FIXTURE_HOST = process.env.BENCH_HOST ?? "127.0.0.1";
const FIXTURE_BASE = `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;

function spawnFixture(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [`${here}/fixture/app.ts`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    proc.stdout!.on("data", (c: Buffer) => (log += c.toString()));
    proc.stderr!.on("data", (c: Buffer) => (log += c.toString()));
    let settled = false;
    proc.on("exit", (code, sig) => {
      Bun.write("/tmp/fixture-crash.log", `${sig ? "signal=" + sig : "code=" + code}\n${log}`);
      if (!settled) {
        settled = true;
        reject(new Error(`fixture app exited early (${sig ?? code})`));
      }
    });
    const poll = setInterval(async () => {
      try {
        const res = await fetch(FIXTURE_BASE + "/");
        if (res.ok) {
          clearInterval(poll);
          settled = true;
          resolve(proc);
        }
      } catch {
        // not up yet
      }
    }, 100);
    setTimeout(() => {
      clearInterval(poll);
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("fixture app never became ready"));
      }
    }, 10_000);
  });
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const proc = await spawnFixture();
  const baseUrl = FIXTURE_BASE;
  await Bun.$`mkdir -p ${args.out}`.quiet();

  const rows: string[] = ["run,k,wall_ms,boot_ms,ok,failed,flake_rate"];
  const suites: SuiteResult[] = [];

  try {
    // One browser for this k, reused across runs: boot paid once, warm
    // contexts on later runs — the warm-gate-container shape.
    const factory = createChromeFactory();
    for (let run = 1; run <= args.runs; run++) {
      await fetch(FIXTURE_BASE + "/reset", { method: "POST" });
      const result = await runSuiteWithK(SPECS, baseUrl, args.k, factory);
      suites.push(result);
      rows.push(
        [run, args.k, result.wallMs.toFixed(0), result.bootMs.toFixed(0), result.ok, result.failed, result.flakeRate.toFixed(3)].join(","),
      );
      const fails = result.results.filter((r) => !r.ok).map((r) => `${r.spec}: ${r.error}`);
      console.log(`k=${args.k} run ${run}: wall=${result.wallMs.toFixed(0)}ms ok=${result.ok}/50 flake=${result.flakeRate.toFixed(3)}`);
      for (const f of fails.slice(0, 3)) console.log(`  FAIL ${f}`);
    }
    await factory.dispose?.();
  } finally {
    proc.kill();
  }

  await Bun.write(`${args.out}/runs.csv`, rows.join("\n") + "\n");

  const walls = suites.map((s) => s.wallMs).sort((a, b) => a - b);
  const p = (q: number) => walls[Math.min(walls.length - 1, Math.floor(q * walls.length))];
  const boots = suites.map((s) => s.bootMs).sort((a, b) => a - b);
  const flakes = suites.reduce((n, s) => n + s.failed, 0);
  const agg = {
    k: args.k,
    n: suites.length,
    wall_p50_ms: Math.round(p(0.5)),
    wall_p95_ms: Math.round(p(0.95)),
    wall_min_ms: Math.round(walls[0]),
    wall_max_ms: Math.round(walls[walls.length - 1]),
    boot_p50_ms: Math.round(boots[Math.floor(boots.length / 2)]),
    flake_rate: flakes / (suites.length * SPECS.length),
    per_spec_median_ms: Math.round(p(0.5) / SPECS.length),
  };
  await Bun.write(`${args.out}/aggregate.json`, JSON.stringify(agg, null, 2) + "\n");
  console.log(`wrote ${args.out}/runs.csv + ${args.out}/aggregate.json`);
}

await main();