// Issue #55: `fleet task reap --terminal --apply` follows the Worker's pages.
// Kept out of cli/fleet.ts (bun-only globals) so the root test pool imports it.

export interface TerminalPage {
  repo: string;
  apply: boolean;
  terminal: true;
  results: { number: number; state: string; outcome: string; reason: string; error?: string }[];
  /** Open terminal tasks this page did not reach. */
  remaining: number;
}

export async function reapTerminalAll(fetchPage: () => Promise<TerminalPage>): Promise<TerminalPage> {
  const results: TerminalPage["results"] = [];
  for (;;) {
    const page = await fetchPage();
    results.push(...page.results);
    // A page that closed nothing would come back identical: stop, report.
    const progressed = page.results.some((r) => r.outcome === "closed");
    if (!page.apply || page.remaining === 0 || !progressed) return { ...page, results };
  }
}
