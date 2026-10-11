/** Pulls the `rel="next"` URL out of a GitHub `Link` response header
 *  (RFC 8288), or null on the last page — shared by both GitHub clients
 *  (board/api.ts, github/api.ts) so a parser fix lands in both. An
 *  empty URL fails closed: following it would refetch the same page
 *  forever. */
export function nextPageLink(linkHeader: string | null): string | null {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1]!;
  }
  return null;
}
