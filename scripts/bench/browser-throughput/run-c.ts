// Config C runner: the 50-spec suite against a BASE URL (a throwaway preview
// deploy of the fixture), with k Browser Run sessions in parallel — one
// connectOverCDP session per worker, opened lazily so the connect wall is paid
// in parallel. This is the "50 sessions fan-out" the task names; k defaults to
// 50 (one session per spec). CF limits bind the fan-out: 200 concurrent
// sessions, 3 new/s acquisition.
//
// A studio holds no CF credential, so this runs from the MAESTRO's session:
//
//   CF_BROWSER_ACCOUNT_ID=… CF_BROWSER_TOKEN=… \
//   bun scripts/bench/browser-throughput/run-c.ts \
//     --target https://<preview>/ --k 50 --runs 5 \
//     --out scripts/bench/browser-throughput/out/config-c
//
// It does NOT spawn the fixture (the target is already deployed); it only
// needs to reach the target over the public internet.
import { SPECS } from "./specs.ts";
import { runSuiteWithK, type SuiteResult } from "./harness.ts";
import { createBrowserRunFactory, type BrowserRunEnv } from "./drivers/browser-run.ts";

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    target: get("--target"),
    k: Number(get("--k") ?? "50"),
    runs: Number(get("--runs") ?? "5"),
    out: get("--out") ?? `${import.meta.dir}/out/config-c`,
    keepAliveMs: Number(get("--keep-alive") ?? "1200000"),
  };
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const accountId = process.env.CF_BROWSER_ACCOUNT_ID;
  const token = process.env.CF_BROWSER_TOKEN;
  if (!accountId || !token) {
    console.error("CF_BROWSER_ACCOUNT_ID and CF_BROWSER_TOKEN are required (maestro session only).");
    process.exit(2);
  }
  if (!args.target) {
    console.error("--target <base-url> is required: the deployed fixture preview.");
    process.exit(2);
  }
  await Bun.$`mkdir -p ${args.out}`.quiet();

  const env: BrowserRunEnv = { accountId, token, keepAliveMs: args.keepAliveMs };
  const rows: string[] = ["run,k,wall_ms,boot_ms,ok,failed,flake_rate"];
  const suites: SuiteResult[] = [];

  for (let run = 1; run <= args.runs; run++) {
    // One fresh factory per run: every run pays the full 50-session fan-out
    // acquisition, which IS the setup cost this config exists to measure.
    const factory = createBrowserRunFactory(env);
    const result = await runSuiteWithK(SPECS, args.target, args.k, factory);
    suites.push(result);
    rows.push(
      [run, args.k, result.wallMs.toFixed(0), result.bootMs.toFixed(0), result.ok, result.failed, result.flakeRate.toFixed(3)].join(","),
    );
    const fails = result.results.filter((r) => !r.ok).map((r) => `${r.spec}: ${r.error}`);
    console.log(`run ${run}: wall=${result.wallMs.toFixed(0)}ms ok=${result.ok}/50 flake=${result.flakeRate.toFixed(3)} boot=${result.bootMs.toFixed(0)}ms`);
    for (const f of fails.slice(0, 3)) console.log(`  FAIL ${f}`);
  }

  await Bun.write(`${args.out}/runs.csv`, rows.join("\n") + "\n");

  const walls = suites.map((s) => s.wallMs).sort((a, b) => a - b);
  const p = (q: number) => walls[Math.min(walls.length - 1, Math.floor(q * walls.length))];
  const boots = suites.map((s) => s.bootMs).sort((a, b) => a - b);
  const flakes = suites.reduce((n, s) => n + s.failed, 0);
  const agg = {
    k: args.k,
    target: args.target,
    n: suites.length,
    wall_p50_ms: Math.round(p(0.5)),
    wall_p95_ms: Math.round(p(0.95)),
    wall_min_ms: Math.round(walls[0]),
    wall_max_ms: Math.round(walls[walls.length - 1]),
    boot_p50_ms: Math.round(boots[Math.floor(boots.length / 2)]),
    flake_rate: flakes / (suites.length * SPECS.length),
  };
  await Bun.write(`${args.out}/aggregate.json`, JSON.stringify(agg, null, 2) + "\n");
  console.log(`\nwrote ${args.out}/runs.csv + ${args.out}/aggregate.json`);
}

await main();