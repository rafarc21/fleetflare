// Issue #400 (sweep-5 finding F2, parent #394). The two shapes every CLI
// error path re-writes, in one place: `err instanceof Error ? err.message :
// String(err)` was inlined at 30 sites across 10 cli files (ff.ts and
// accounts.ts had already named theirs errText), and the non-2xx body decode
// was held twice, by repair-failure.ts and inspect-request.ts. A pure
// module, Bun/node-free imports, for the same reason cli/repair-failure.ts
// is: a test can import it without dragging Bun globals into the root
// type-check.

/**
 * An unknown caught value, as one printable line. Errors give their message;
 * everything else gives its String form — a handler whose whole job is
 * reporting a failure must never throw at its own reporting, whatever the
 * caught value turns out to be. Same contract ff.ts's and accounts.ts's
 * local errText helpers already carried; this module is the one they (and
 * the 28 anonymous inline copies) fold onto.
 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How much of a non-2xx body a plain error snippet shows — the budget
 *  the fetch-failure lines named in #510 share. Two verbs carry their own
 *  deliberate budgets instead: repair-failure.ts's 2000, and the board/
 *  memory lines' raw `slice(0, 500)` (fleet.ts boardRequest,
 *  taskStateFetch*, cmdMemoryLs). */
export const ERROR_SNIPPET_MAX_CHARS = 300;

/**
 * A non-2xx Worker body, reduced to the DETAIL of one terminal line — the
 * label, the status prefix, and the exit/throw policy all stay at the call
 * site (repair-failure.ts prints `label: status detail`, inspect-request.ts
 * frames `HTTP status from the ... side`). This is the decode both of those
 * already shared: a Cloudflare error page reduced to its <title>, a #217
 * `{"error": ...}` refusal to its reason, anything else to a capped plain
 * text line.
 *
 * `status` is accepted and never used in the return: taking it keeps every
 * call site reading uniformly — `decodeBody(res.status, text, cap)`
 * wherever a body is read next to its status — while the framing stays the
 * caller's own, exactly as both copies shape theirs today.
 *
 * `maxChars` is a parameter, not the old constant, because the two copies
 * differed only in their cap (repair-failure.ts's 2000, inspect-request.ts's
 * 300): the decode is one shape, the cap is each caller's own readability
 * budget.
 */
export function decodeBody(status: number, text: string, maxChars: number): string {
  // A Cloudflare error page (e.g. 1101 "Worker threw exception") is a whole
  // HTML document; its <title> is the only part worth a terminal line.
  // Uncapped: a <title> is Cloudflare's own fixed-format one-liner, not an
  // operator-influenced body — the caps below are for those.
  const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
  if (title) return title;
  // Issue #217: the 409 refusal (routes.ts's launchOrStartRefusalResponse)
  // answers `{"error": "<reason>"}` — without this branch the operator reads
  // the raw JSON blob, braces and quoting included, instead of the reason
  // itself. A JSON body is never also an HTML document, so this never races
  // the <title> check above either way.
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    // Same cap as the plain-text fallback below: `.error` can carry redacted
    // container stderr (the refusal reason passes through uninspected), so
    // this branch must be bounded too — a cap that only reaches some
    // branches bounds nothing.
    if (typeof parsed.error === "string") return parsed.error.slice(0, maxChars);
  } catch {
    // Not JSON — every other body (plain text, or the recycle refusal's own
    // price line in full) falls through to the slice below.
  }
  return text.trim().slice(0, maxChars);
}
