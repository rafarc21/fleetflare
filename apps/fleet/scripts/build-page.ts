#!/usr/bin/env bun
/**
 * Emits page/terminal.html from page/terminal.template.html (with
 * @xterm/xterm's UMD bundle and base stylesheet inlined between the fixed
 * XTERM_..._START/END markers, so the served page makes zero external
 * requests — no CDN, no <script src>) AND page/grid.html from
 * page/grid.template.html (Task 5, P2 plane 3 — the fleet grid has nothing
 * to inline, it is hand-authored self-contained JS/CSS already, so its
 * "build" is a guarded straight copy — kept on this same script anyway, per
 * the design spec's own "same build discipline" ruling (R-P2-6), rather
 * than being hand-committed with no build step at all).
 *
 * Both outputs are checked in as build artifacts: src/studio/page.ts and
 * src/studio/grid.ts import them as plain text modules (wrangler's default
 * module rules already treat *.html as Text — see src/studio/html.d.ts — no
 * wrangler.jsonc rule needed), so `wrangler dev`/`deploy` never run this
 * script themselves. Re-run by hand after bumping @xterm/xterm, or after
 * editing either .template.html:
 *   bun run build:page
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGE_DIR = path.join(root, "page");
const XTERM_DIR = path.join(root, "node_modules", "@xterm", "xterm");

/** Replaces the span between two marker comments (inclusive of the
 *  markers) with `content` sandwiched between them, so re-running this
 *  script is idempotent — it always finds the same two markers in its own
 *  previous output, never a growing pile of xterm copies. */
function inject(source: string, startMarker: string, endMarker: string, content: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`build-page: markers ${startMarker} / ${endMarker} not found (or out of order)`);
  }
  return source.slice(0, start + startMarker.length) + content + source.slice(end);
}

/**
 * Drops any line that IS a `//# sourceMappingURL=...` comment, wherever it
 * falls. Line-based rather than a single `$`-anchored regex on purpose: a
 * plain `/\n\/\/# sourceMappingURL=.*$/` anchors `$` to end-of-STRING
 * without the `m` flag, which only happens to match today because this
 * pinned xterm.js build has no trailing newline after the comment — an
 * npm bundle that does end in one (common) would make it silently no-op,
 * quietly reintroducing the same-origin devtools 404 fetch this exists to
 * prevent. Splitting on "\n" sidesteps end-of-string anchoring entirely, so
 * a trailing newline (or its absence) can't change the outcome either way.
 */
function stripSourceMappingComment(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//# sourceMappingURL="))
    .join("\n");
}

/**
 * Guard shared by every emitted page: fails the build loudly rather than
 * shipping a page whose devtools would try (and 404) fetching a same-origin
 * "*.map" that doesn't exist. Originally terminal.html-only; Task 5 applies
 * it to grid.html too — a straight copy has nothing to strip, but this still
 * catches a future grid.template.html hand-edit that pastes in a minified
 * snippet carrying its own sourceMappingURL comment.
 */
function assertNoSourceMappingUrl(html: string, label: string): void {
  if (html.includes("sourceMappingURL")) {
    throw new Error(`build-page: final ${label} artifact still contains a sourceMappingURL reference — strip failed`);
  }
}

async function buildTerminalPage(): Promise<string> {
  const [template, xtermJsRaw, xtermCss] = await Promise.all([
    readFile(path.join(PAGE_DIR, "terminal.template.html"), "utf8"),
    readFile(path.join(XTERM_DIR, "lib", "xterm.js"), "utf8"),
    readFile(path.join(XTERM_DIR, "css", "xterm.css"), "utf8"),
  ]);

  // Strip the sourceMappingURL comment: inlined into a route this Worker
  // serves, a browser's devtools would otherwise try to fetch
  // "xterm.js.map" from a path that does not exist on this origin — a
  // harmless but needless same-origin 404 on every load. xterm.css carries
  // no such comment today (checked directly against the pinned package),
  // so only the JS bundle needs this.
  const xtermJs = stripSourceMappingComment(xtermJsRaw);

  let html = template;
  html = inject(html, "/*XTERM_CSS_START*/", "/*XTERM_CSS_END*/", "\n" + xtermCss + "\n");
  html = inject(html, "/*XTERM_JS_START*/", "/*XTERM_JS_END*/", "\n" + xtermJs + "\n");
  return html;
}

/**
 * No third-party bundle to inline (see this file's own header) — reads the
 * hand-authored template as-is. Still routed through this script rather
 * than checked in directly under the template's own name, so it gets the
 * same sourceMappingURL guard as terminal.html and the same "the build
 * artifact is what src/studio/grid.ts imports, never the template" wiring.
 */
async function buildGridPage(): Promise<string> {
  return readFile(path.join(PAGE_DIR, "grid.template.html"), "utf8");
}

async function main() {
  const pkgRaw = await readFile(path.join(XTERM_DIR, "package.json"), "utf8");
  const xtermVersion = (JSON.parse(pkgRaw) as { version: string }).version;

  const terminalHtml = await buildTerminalPage();
  assertNoSourceMappingUrl(terminalHtml, "terminal.html");
  const terminalOut = path.join(PAGE_DIR, "terminal.html");
  await writeFile(terminalOut, terminalHtml, "utf8");
  console.log(`build-page: wrote ${terminalOut} (${terminalHtml.length} bytes, @xterm/xterm@${xtermVersion})`);

  const gridHtml = await buildGridPage();
  assertNoSourceMappingUrl(gridHtml, "grid.html");
  const gridOut = path.join(PAGE_DIR, "grid.html");
  await writeFile(gridOut, gridHtml, "utf8");
  console.log(`build-page: wrote ${gridOut} (${gridHtml.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
