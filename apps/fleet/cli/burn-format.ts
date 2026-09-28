// Pure formatting for fleet ls's BURN column and its legend. Split out of
// cli/fleet.ts into its own tiny pure module for the SAME reason
// cli/fleet-totals.ts and cli/readiness-format.ts already are (see those
// files' own headers): cli/fleet.ts pulls in `node:os`/`node:fs` and
// `Bun.file`/`Bun.spawn` (via ./paste-mac), fine for cli/tsconfig.json's own
// `"types": ["bun"]`, but importing it from ANYWHERE under test/ would drag
// those Bun-touching declarations into the ROOT tsconfig.json's compilation
// graph too, and that project's `types` array has no "bun" entry — `bun run
// check` would then fail to resolve the `Bun` global. Keeping this pure (no
// node:*/Bun imports) means a test can import it directly.
//
// Moved here verbatim from cli/fleet.ts, which re-exports both names so
// test-integration/cli.acceptance.ts's existing import keeps working.
import type { StudioStatus } from "../src/studio/types";

/**
 * Task 7 (P2): compact numbers-only burn summary for one table cell. `null`
 * (no sync tick has ever landed for this studio yet) reads as "-", same
 * convention every other absent-value column here already uses.
 * Cumulative output tokens is the headline figure (the number
 * BURN_ALERT_OUTPUT_TOKENS_5H actually gates on is the 5h-window one, shown
 * alongside it) — both are plain numbers, per StudioStatus.burn's own
 * "numbers only" contract (registry.ts's cleanBurn), so there is nothing
 * here that needs redactSecrets the way the ERROR column already gets.
 */
export function formatBurn(burn: StudioStatus["burn"]): string {
  if (!burn) return "-";
  return `${burn.outputTokens}o/5h:${burn.window5hOutput}`;
}

/**
 * Fleet Spawn P3, Task 3 (R-P3-5 backlog: "formatBurn legend"). `fleet ls`
 * prints this once, above the table — formatBurn's own compact shape
 * ("<n>o/5h:<n>") is not self-explanatory in a plain terminal column with no
 * room for a wrapped header, and there was previously nothing anywhere in
 * this CLI's own output explaining it (the grid page's equivalent column has
 * a page around it to add context; this one is bare stdout).
 *
 * Issue #181: "trailing 5h window" was wrong twice over. The bucket never
 * was a trailing/sliding window — burn.ts's rollWindow describes it as a
 * TUMBLING bucket that resets whole — and for a stopped studio the old text
 * promised a live trailing figure while the number was hours dead. It now
 * reads "current 5h bucket", which is what registry.ts's expireBurnWindow
 * actually guarantees: the output of the bucket that is open right now, and
 * 0 once that bucket's 5h have elapsed.
 */
export const BURN_LEGEND = "BURN column: <cumulative output tokens>o/5h:<output tokens in the current 5h bucket, 0 once that bucket has elapsed>";
