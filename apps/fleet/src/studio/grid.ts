// Fleet grid page — pure render half (Task 5, P2 plane 3). Mirrors page.ts's
// own split exactly: this file never dispatches to a StudioDO stub (no
// "@cloudflare/sandbox" in its import graph, so it stays importable under
// vitest-pool-workers the same way page.ts does — see routes.ts's own header
// for why that distinction matters); routes.ts is the impure half that reads
// the registry, calls each studio's DO for its hot-tail preview, and hands
// the assembled card list to renderGridPage below.
import type { StudioState } from "./types";
import type { Burn } from "./burn";
import { redactSecrets } from "./redact";
import gridHtml from "../../page/grid.html";

// Must match the quoted placeholder in page/grid.template.html exactly —
// same "one literal in both places, not a shared constant" reasoning as
// page.ts's own STUDIO_ID_TOKEN (the template isn't TypeScript, so there is
// nothing to import a constant from).
const STUDIO_DATA_TOKEN = '"__FLEET_STUDIO_DATA__"';

/** Fleet Spawn P3, Task 5 (R-P3-4: "Grid header row: fleet-wide
 *  turns/output/5h aggregate"). Same "one literal in both places" reasoning
 *  as STUDIO_DATA_TOKEN just above — a second, independent placeholder
 *  rather than folding totals into the existing STUDIO_DATA array, so the
 *  card-list injection (and every test that already pins its exact shape)
 *  stays untouched. */
const TOTALS_TOKEN = '"__FLEET_TOTALS__"';

/** Both placeholders in one alternation, so renderGridPage below can do its
 *  two substitutions in a single pass over the untouched artifact (see its
 *  own comment for why that matters). Built from the two constants directly
 *  with no escaping step: both are quotes, capitals and underscores only —
 *  no regex metacharacter is expressible in the placeholder grammar the
 *  template shares with this file. */
const TOKENS_RE = new RegExp(`${STUDIO_DATA_TOKEN}|${TOTALS_TOKEN}`, "g");

/**
 * "Last ~15 lines" per the design spec / task brief. A plain module const,
 * not exported: nothing outside scrubPreview needs to know this number, the
 * same reasoning archive.ts's own header gives for keeping its constants
 * private to callers that need them directly.
 */
const PREVIEW_MAX_LINES = 15;

/** One card's worth of data injected server-side. `preview` is the ONLY
 *  content-bearing field (design ruling R-P2-7) — every other field here is
 *  already what StudioStatus itself carries (numbers, an id, a validated
 *  hostname), already scrubbed at the registry write boundary
 *  (registry.ts's recordStudio). */
export interface GridCard {
  id: string;
  state: StudioState;
  lastRefresh: string | null;
  tailscaleHost: string | null;
  burn: Burn | null;
  preview: string;
}

/**
 * Scrubs a raw hot-tail transcript (DO storage's own `transcriptTail`,
 * unscrubbed — see transcript.ts's getTranscriptTailWithStorage) down to
 * what the grid may safely embed in a served page: redactSecrets first (the
 * exact same scrub the /status route's error/lastRefreshError fields get —
 * redact.ts's masks are shape-based, not content-aware, so running it twice
 * anywhere is always safe), THEN sliced to the last PREVIEW_MAX_LINES lines
 * — in that order, so a secret that happens to straddle the slice boundary
 * is still caught (redacting the full tail first, not just the slice).
 */
export function scrubPreview(rawTail: string): string {
  const scrubbed = redactSecrets(rawTail);
  const lines = scrubbed.split("\n");
  return lines.slice(-PREVIEW_MAX_LINES).join("\n");
}

/** Fleet Spawn P3, Task 5 (R-P3-4). Numbers only, mirroring `Burn`'s own
 *  "every field is a plain number" contract (burn.ts's own header) — nothing
 *  here ever needs redactSecrets the way `preview` does. */
export interface FleetTotals {
  turns: number;
  outputTokens: number;
  window5hOutput: number;
}

/**
 * Fleet-wide burn aggregate for the grid header row. A card whose studio has
 * no burn yet (`burn === null` — no syncSession tick has landed for it)
 * contributes zero to every field, the same "absent reads as zero"
 * convention burn.ts's own freshBurn/rollWindow already establish for a
 * single studio's own counters — a fleet with a freshly-provisioned,
 * not-yet-synced studio alongside established ones must not have its totals
 * thrown off (or crash) because of the newcomer.
 *
 * `Pick<GridCard, "burn">[]`, not the full `GridCard[]`: this reads nothing
 * else, the same narrow-input idiom this feature's ports already follow
 * elsewhere (e.g. transcript.ts's getTranscriptTailWithStorage).
 */
export function computeFleetTotals(cards: Pick<GridCard, "burn">[]): FleetTotals {
  return cards.reduce<FleetTotals>(
    (acc, c) => ({
      turns: acc.turns + (c.burn?.turns ?? 0),
      outputTokens: acc.outputTokens + (c.burn?.outputTokens ?? 0),
      window5hOutput: acc.window5hOutput + (c.burn?.window5hOutput ?? 0),
    }),
    { turns: 0, outputTokens: 0, window5hOutput: 0 },
  );
}

/**
 * Safe for embedding inside an inline `<script>` tag. `JSON.stringify`
 * already escapes quotes/backslashes/control characters for a JS string
 * context, but NOT a literal `</script>` or `<!--` sequence — and unlike
 * page.ts's single validated studio id, this payload's `preview` field is
 * arbitrary (if scrubbed-of-secrets) text a studio's own terminal produced,
 * which could easily contain either. Escaping every `<` defeats both, since
 * neither can form without one — the standard minimal-safe JSON-in-HTML
 * technique (used by, among others, Rails' `j` filter and Next.js's own
 * data-injection helper).
 */
function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Injects the server-assembled card list (plus the fleet-wide totals row,
 * Fleet Spawn P3 Task 5 — R-P3-4) into the pre-bundled grid page. The build
 * artifact itself carries no per-request data (studio-agnostic, same as
 * page.ts's terminal artifact); these are the two substitutions routes.ts
 * needs before serving it.
 */
export function renderGridPage(cards: GridCard[]): string {
  if (!gridHtml.includes(STUDIO_DATA_TOKEN) || !gridHtml.includes(TOTALS_TOKEN)) {
    // A stale/hand-edited build artifact with no placeholder would silently
    // serve the same empty-data page to every request — fail loudly
    // instead, same discipline as page.ts's own guard.
    throw new Error("grid.html is missing its studio data or totals placeholder — run `bun run build:page`");
  }
  // ONE pass over the ORIGINAL artifact, not two chained ones (Fleet Spawn
  // P3, Task 6 fold — Task 5 review minor). Chaining `withCards.replace(
  // TOTALS_TOKEN, ...)` scanned text that ALREADY contained the injected
  // card list, and a card whose `preview` is exactly `__FLEET_TOTALS__`
  // serialises to the totals placeholder byte for byte — so `.replace`
  // (first match only) rewrote that card's preview and left the real
  // placeholder in the page. A studio can put anything in its own preview,
  // so that was studio-steerable. Matching only against the original means
  // injected content is never rescanned: String.replace never re-examines
  // what a replacement produced, so neither substitution can land inside the
  // other's output.
  //
  // A replacement FUNCTION, not a string — the $-pattern lesson applies
  // unconditionally to any non-literal `.replace`, not only where the
  // replacement text is studio-influenced: safeJsonForScript(cards) carries a
  // card's hot-tail preview (genuinely studio-influenced), while totals is
  // numbers-only and could never itself contain a `$`-pattern sequence — but
  // the SAME function form covers both anyway, so there is exactly one safe
  // idiom in this file, not one safe and one merely-currently-safe.
  // String.replace reads $&/$`/$'/$$ as replacement-pattern syntax whenever
  // the replacement argument is a plain string; a function return value is
  // inserted verbatim, with no such interpretation.
  return gridHtml.replace(TOKENS_RE, (match) =>
    match === STUDIO_DATA_TOKEN ? safeJsonForScript(cards) : safeJsonForScript(computeFleetTotals(cards)),
  );
}
