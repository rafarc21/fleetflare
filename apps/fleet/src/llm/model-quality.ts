// Per-model PR quality + auto-demote rule (spec 2026-10-13-model-pool-design,
// Quality). Pure only, deliberately: test/bun/llm-model-quality.test.ts runs
// these under bun:test (test/tsconfig.json's own "types": ["bun"] override,
// no @cloudflare/workers-types), so nothing in this file may reference a
// Workers ambient type (D1Database, Env, …) — doing so would pull the whole
// Worker type graph into that bun-only compilation and break it. The I/O
// shell around these (collectOutcomes, the daily cron glue) lives in the
// sibling model-quality-cron.ts instead, which only ever runs under vitest's
// cloudflare:test pool — see that file's own header for why the split exists.
export interface PrOutcome {
  model: string;
  closedAt: number;
  firstCiPassed: boolean;
  bounced: boolean;
  reverted: boolean;
}

export interface ModelStats {
  model: string;
  prs: number;
  firstCiPassRate: number;
  bounces: number;
  reverts: number;
}

const MIN_PRS = 5;
const GAP = 0.25;
const MAX_REVERTS = 2;

export function modelStats(outcomes: PrOutcome[], window = 10): ModelStats[] {
  const by = new Map<string, PrOutcome[]>();
  for (const o of outcomes) by.set(o.model, [...(by.get(o.model) ?? []), o]);
  return [...by.entries()].map(([model, list]) => {
    const w = [...list].sort((a, b) => b.closedAt - a.closedAt).slice(0, window);
    return {
      model,
      prs: w.length,
      firstCiPassRate: w.length ? w.filter((o) => o.firstCiPassed).length / w.length : 0,
      bounces: w.filter((o) => o.bounced).length,
      reverts: w.filter((o) => o.reverted).length,
    };
  });
}

/** Fewer than MIN_PRS closed PRs is never enough signal to judge a model —
 *  see this file's header and the spec's Quality section. */
export function shouldDemote(stats: ModelStats[]): string[] {
  const eligible = stats.filter((s) => s.prs >= MIN_PRS);
  const best = Math.max(0, ...eligible.map((s) => s.firstCiPassRate));
  return eligible
    .filter((s) => s.reverts >= MAX_REVERTS || best - s.firstCiPassRate >= GAP)
    .map((s) => s.model);
}

export function statsTable(stats: ModelStats[]): string {
  const head = "| model | prs | first-try CI | bounces | reverts |\n|---|---|---|---|---|";
  return [head, ...stats.map((s) => `| ${s.model} | ${s.prs} | ${Math.round(s.firstCiPassRate * 100)}% | ${s.bounces} | ${s.reverts} |`)].join("\n");
}
