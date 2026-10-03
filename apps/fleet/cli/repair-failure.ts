// Issue #96. A repair verb's non-2xx, printed whole. Split out of cli/fleet.ts
// as a pure module for the same reason cli/inspect-request.ts is: a test can
// import it without dragging Bun globals into the root type-check.

/** Upper bound for a pathological body. Well above the longest line the
 *  Worker writes on purpose (the recycle refusal, ~900 chars). */
const MAX_CHARS = 2000;

/**
 * Before #96 every verb printed `text.slice(0, 300)`. The side-naming line
 * and the recycle refusal are both longer, and the cut half was the fallback
 * — the only actionable part.
 */
export function repairFailureLine(
  verb: string, status: number, text: string, label: string = `fleet ${verb}`,
): string {
  // A Cloudflare error page (e.g. 1101 "Worker threw exception") is a whole
  // HTML document; its <title> is the only part worth a terminal line.
  const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
  if (title) {
    return `${label}: ${status} ${title} ` +
      "(a Cloudflare error page: the Worker threw — this page does not say which side failed)";
  }
  // Issue #217: provision/restart/recycle's 409 refusal (routes.ts's
  // `launchOrStartRefusalResponse`) answers `{"error": "<reason>"}`. Without
  // this, the operator read the raw JSON blob, braces and quoting included,
  // instead of the reason itself. A JSON body is never also an HTML document,
  // so this never races the <title> check above either way.
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    // Issue #217 review round 2: same cap as the plain-text fallback below —
    // `parsed.error` can carry redacted container stderr (routes.ts's
    // launchOrStartRefusalResponse passes a refusal reason through
    // uninspected), and an uncapped reason here was the one path this
    // function's own MAX_CHARS bound did not actually reach.
    if (typeof parsed.error === "string") return `${label}: ${status} ${parsed.error.slice(0, MAX_CHARS)}`;
  } catch {
    // Not JSON — every other repair verb's body (plain text, or the
    // RECYCLE_REFUSED_PREFIX price in full) falls through to the slice below.
  }
  return `${label}: ${status} ${text.trim().slice(0, MAX_CHARS)}`;
}

/** `fleet destroy`'s route path — the flags ride recycle's own query names. */
export function destroyPath(force: boolean, discardUnsynced: boolean, park = false): string {
  const query = [force && "force=true", discardUnsynced && "discard-unsynced=true", park && "park=true"]
    .filter(Boolean).join("&");
  return query ? `/destroy?${query}` : "/destroy";
}

/** Stderr note after a recycle run with --discard-unsynced: it bypassed the
 *  refusal on purpose, and this says what that cost. */
export function discardNote(id: string): string {
  return `fleet recycle: --discard-unsynced was passed for ${id}. If its container could not answer, ` +
    "nothing was rescued: the studio came back from its last synced snapshot, and conversation, " +
    "uncommitted and unpushed work since then were discarded.";
}
