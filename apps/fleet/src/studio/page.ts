// Text-module import (see html.d.ts) of the build artifact scripts/build-page.ts
// emits — xterm's JS+CSS already inlined, no bundler step at Worker
// build/deploy time. Regenerate with `bun run build:page` after bumping
// @xterm/xterm.
import terminalHtml from "../../page/terminal.html";

// Must match the quoted placeholder in page/terminal.template.html exactly
// (kept as one literal in both places rather than a shared constant — the
// template isn't TypeScript, so there is nothing to import it from).
const STUDIO_ID_TOKEN = '"__FLEET_STUDIO_ID__"';

/**
 * Injects the requesting studio's id into the pre-bundled terminal page so
 * its own script knows which WS to open. The build artifact itself is
 * studio-id-agnostic (built once, reused by every studio); this is the one
 * per-request substitution routes.ts needs before serving it.
 *
 * `studioId` has already passed parseStudioId's charset (lowercase
 * alnum, single hyphens, one `--`) by the time a route calls this — see
 * routes.ts's `id.full` — so nothing in it can break out of the JSON
 * string literal being substituted in. JSON.stringify is used anyway
 * rather than trusting that invariant here too.
 */
export function renderTerminalPage(studioId: string): string {
  if (!terminalHtml.includes(STUDIO_ID_TOKEN)) {
    // A stale/hand-edited build artifact with no placeholder would silently
    // serve the SAME page to every studio, pointed at nothing in
    // particular — fail loudly instead.
    throw new Error("terminal.html is missing its studio id placeholder — run `bun run build:page`");
  }
  return terminalHtml.replace(STUDIO_ID_TOKEN, JSON.stringify(studioId));
}
