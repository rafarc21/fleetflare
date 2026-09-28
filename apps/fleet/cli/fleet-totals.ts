// Fleet Spawn P3, Task 5 (R-P3-4: "fleet ls totals line if cheap"). Split
// out from cli/fleet.ts into its own tiny pure module for the SAME reason
// cli/backoff.ts and cli/input.ts already are (see test/cli.backoff.test.ts
// / test/cli.input.test.ts): cli/fleet.ts itself pulls in `node:os`/
// `node:fs` and `Bun.file`/`Bun.spawn` (via ./paste-mac) — fine for cli/
// tsconfig.json (which declares `"types": ["bun"]`), but importing it from
// ANYWHERE under test/ would transitively drag those same Bun-touching
// declarations into the ROOT tsconfig.json's compilation graph too (any
// file a test imports becomes part of that project's type-check, regardless
// of `include`/`exclude`), and the root project's own `types` array has no
// "bun" entry — `bun run check`'s first step would then fail to resolve the
// `Bun` global. Keeping this pure (no node:*/Bun imports of its own) means a
// test can import it directly without pulling any of that in.
import type { StudioStatus } from "../src/studio/types";

/**
 * The SAME turns/outputTokens/window5hOutput sum src/studio/grid.ts's own
 * computeFleetTotals computes for the grid header, duplicated here as its
 * own tiny function rather than an import — cli/fleet.ts is a plain bun
 * script, unbundled, while grid.ts pulls in page/grid.html as a text module
 * (a Workers-build-only loader `wrangler` provides but a bare `bun`
 * invocation of this CLI does not). Same "one tiny copy per file, no
 * cross-boundary import for a few lines of arithmetic" precedent
 * transcript.ts's and session-sync.ts's own base64ToBytes headers already
 * establish for this codebase.
 */
export function fleetTotals(studios: StudioStatus[]): { turns: number; outputTokens: number; window5hOutput: number } {
  return studios.reduce(
    (acc, s) => ({
      turns: acc.turns + (s.burn?.turns ?? 0),
      outputTokens: acc.outputTokens + (s.burn?.outputTokens ?? 0),
      window5hOutput: acc.window5hOutput + (s.burn?.window5hOutput ?? 0),
    }),
    { turns: 0, outputTokens: 0, window5hOutput: 0 },
  );
}

/**
 * Issue #181: the printed FLEET TOTALS line, split out of cli/fleet.ts's own
 * `console.log` so its WORDING is pinned by a test the same way BURN_LEGEND's
 * now is — this one line is where the 4.38M-of-5.42M phantom was read off.
 *
 * "in the trailing 5h window" is gone for the same two reasons it left
 * BURN_LEGEND (see cli/burn-format.ts): the bucket never was trailing or
 * sliding — burn.ts's rollWindow calls it a TUMBLING bucket that resets whole
 * — and for a stopped studio the old wording promised a live trailing figure
 * over an hours-dead number. registry.ts's expireBurnWindow now makes the
 * NUMBER honest; this makes the label match it. A corrected number under a
 * wrong label is still a wrong reading.
 */
export function formatFleetTotalsLine(t: { turns: number; outputTokens: number; window5hOutput: number }): string {
  return `FLEET TOTALS: ${t.turns} turns, ${t.outputTokens} output tokens, ${t.window5hOutput} in the current 5h bucket`;
}
