// Throughput harness: runs the 50-spec suite against any base URL with a
// k-worker pool. `k` maps to a real Playwright worker count for config A
// (one browser, k contexts, each context owns one page reused across the
// specs it is assigned) and to Browser Run session concurrency for config C.
//
// Timing model:
//   suite wall  = wall clock for ALL 50 specs to complete under k workers
//   per-spec wall = one spec's own run (also recorded, for the shard model)
//
// A spec's isolation comes from its own ACCOUNT id in the app (see specs.ts),
// NOT from a fresh context per spec — contexts are pooled and reused, so the
// measured wall is honest "k real workers" throughput, not "k times fresh-
// boot".
export interface SpecPage {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  valueText(selector: string): Promise<string | null>;
  count(selector: string): Promise<number>;
  waitForSelector(selector: string): Promise<void>;
}

export interface SpecPageFactory {
  open(): Promise<SpecPage>;
  close(page: SpecPage): Promise<void>;
  bootMs(): number;
  dispose?(): Promise<void>;
}

export interface SpecResult {
  spec: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface SuiteResult {
  k: number;
  wallMs: number;
  bootMs: number;
  results: SpecResult[];
  ok: number;
  failed: number;
  flakeRate: number;
}

// Pool: k concurrent workers, each pulls the next spec off a shared index.
// A finished/failed spec does not stop the pool; a slow spec keeps its slot.
export async function runSuiteWithK(
  specs: { name: string; run(page: SpecPage, base: string): Promise<void> }[],
  baseUrl: string,
  k: number,
  factory: SpecPageFactory,
): Promise<SuiteResult> {
  const bootStart = performance.now();
  const pages = await Promise.all(Array.from({ length: k }, () => factory.open()));
  const bootMs = performance.now() - bootStart;

  const results: SpecResult[] = new Array(specs.length);
  let next = 0;
  const startAll = performance.now();

  async function worker(page: SpecPage): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= specs.length) return;
      const spec = specs[i];
      const t0 = performance.now();
      let ok = true;
      let error: string | undefined;
      try {
        await spec.run(page, baseUrl);
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
      }
      results[i] = { spec: spec.name, ok, ms: performance.now() - t0, error };
    }
  }

  await Promise.all(pages.map((p) => worker(p)));
  const wallMs = performance.now() - startAll;
  await Promise.all(pages.map((p) => factory.close(p)));

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return {
    k,
    wallMs,
    bootMs,
    results,
    ok,
    failed,
    flakeRate: failed / results.length,
  };
}