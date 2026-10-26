// Benchmark runner: spawns the fixture server, drives one engine through N
// passes of the fixed suite, and writes raw numbers to
// scripts/bench/browser/out/<engine>/runs.csv (+ .json summary).
//
//   bun scripts/bench/browser/run.ts chrome      --runs 12
//   bun scripts/bench/browser/run.ts browser-run --runs 12 --target <public-base-url>
//
// chrome:      local playwright-core + /usr/local/bin/chromium (runs today).
// browser-run: needs CF_BROWSER_ACCOUNT_ID + CF_BROWSER_TOKEN (operator);
//              --target must be the tunnel/preview URL that exposes the
//              fixture, because a remote browser cannot reach 127.0.0.1.
//
// What each row records (ms):
//   bootMs     engine cold start (chrome: chromium.launch; browser-run: connect)
//   legMs      one full suite pass, engine already up
//   steps      assertions in that pass (from suite.ts)
//   ok         pass/fail
//   error      reason on failure
// The CSV is append-only across invocations, so re-running accumulates raw
// runs instead of overwriting them.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "./suite.ts";
import { createChromeDriver } from "./drivers/chrome.ts";
import { createBrowserRunDriver } from "./drivers/browser-run.ts";

const here = dirname(fileURLToPath(import.meta.url));

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

interface Row {
  engine: string;
  bootMs: number;
  legMs: number;
  steps: number;
  ok: boolean;
  error?: string;
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/BENCH_READY (http:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    child.once("exit", (code) => reject(new Error(`fixture exited early: ${code}`)));
    setTimeout(() => reject(new Error("fixture did not report BENCH_READY within 10s")), 10_000);
  });
}

async function main(): Promise<void> {
  const engine = process.argv[2];
  if (engine !== "chrome" && engine !== "browser-run") {
    throw new Error("usage: run.ts <chrome|browser-run> [--runs N] [--target URL]");
  }
  const runs = Number(process.argv[process.argv.indexOf("--runs") + 1] ?? "12");
  const targetArg = process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : undefined;
  const outName = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : engine;

  // Start the fixture on 127.0.0.1 for the local engine. For the remote
  // engine the fixture still serves 127.0.0.1, but the DRIVER navigates the
  // tunnel/preview URL instead — the tunnel forwards to this same port.
  const child = spawn("bun", [join(here, "fixture", "server.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, BENCH_PORT: "8317" },
  });
  const localBase = await waitForReady(child);
  // --target overrides the base URL for BOTH engines: chrome-through-tunnel
  // measures the reachability cost a remote engine would pay; browser-run
  // requires it (a remote browser cannot reach 127.0.0.1).
  const baseUrl = targetArg ?? localBase;

  const driver = engine === "chrome" ? createChromeDriver() : createBrowserRunDriver({
    accountId: env("CF_BROWSER_ACCOUNT_ID"),
    token: env("CF_BROWSER_TOKEN"),
  });

  const outDir = join(here, "out", outName);
  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, "runs.csv");
  const rows: Row[] = [];

  try {
    // Cold boot measured once per invocation; each run then uses a fresh page
    // per pass so legMs isolates the leg, not boot.
    const bootStart = performance.now();
    if (engine === "chrome") {
      await (driver as ReturnType<typeof createChromeDriver>).launch();
    } else {
      await (driver as ReturnType<typeof createBrowserRunDriver>).connect();
    }
    const bootMs = Math.round(performance.now() - bootStart);

    for (let i = 0; i < runs; i++) {
      const page = await driver.newPage();
      const t0 = performance.now();
      let ok = true;
      let error: string | undefined;
      let steps = 0;
      try {
        const result = await runSuite(page, baseUrl);
        steps = result.steps;
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
      }
      const legMs = performance.now() - t0;
      const row: Row = { engine, bootMs: i === 0 ? bootMs : 0, legMs, steps, ok, error };
      rows.push(row);
      appendFileSync(csvPath, `${[row.bootMs, row.legMs, row.steps, row.ok, JSON.stringify(row.error ?? "")].join(",")}\n`);
      await pageCloseSafe(page);
      console.log(`run ${i + 1}/${runs}: leg ${legMs.toFixed(1)}ms ${ok ? "ok" : "FAIL " + error}`);
    }
  } finally {
    await driver.close();
    child.kill("SIGTERM");
  }

  const legSorted = rows.map((r) => r.legMs).sort((a, b) => a - b);
  const okCount = rows.filter((r) => r.ok).length;
  const summary = {
    engine,
    baseUrl,
    runs: rows.length,
    ok: okCount,
    flakeRate: (rows.length - okCount) / rows.length,
    bootMsCold: rows[0]?.bootMs ?? null,
    legP50: Math.round(percentile(legSorted, 50)),
    legP95: Math.round(percentile(legSorted, 95)),
    legMin: Math.round(legSorted[0] ?? 0),
    legMax: Math.round(legSorted[legSorted.length - 1] ?? 0),
    legMean: Math.round(legSorted.reduce((a, b) => a + b, 0) / (legSorted.length || 1)),
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\nSUMMARY\n" + JSON.stringify(summary, null, 2));
}

async function pageCloseSafe(page: unknown): Promise<void> {
  const p = page as { close?: () => Promise<void> };
  try { await p.close?.(); } catch { /* a failed close must not kill the run */ }
}

main().catch((e) => { console.error(e); process.exit(1); });