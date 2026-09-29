// Issue #41: `fleet task junior-sweep` follows the Worker's pages. Kept out
// of cli/fleet.ts (bun-only globals) so the root test pool can import it.

export interface SweepPage {
  repo: string;
  apply: boolean;
  results: { number: number; outcome: string; reason: string }[];
  /** Last issue number read; null (or absent, an older Worker) = done. */
  next?: number | null;
}

export async function sweepAllPages(fetchPage: (after: number | null) => Promise<SweepPage>): Promise<SweepPage> {
  const results: SweepPage["results"] = [];
  let after: number | null = null;
  for (;;) {
    const page = await fetchPage(after);
    results.push(...page.results);
    const next = page.next ?? null;
    if (next === null) return { ...page, results, next: null };
    if (after !== null && next <= after) throw new Error(`junior-sweep cursor did not advance (${after} -> ${next})`);
    after = next;
  }
}
