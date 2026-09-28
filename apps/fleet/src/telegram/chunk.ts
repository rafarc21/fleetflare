export const TELEGRAM_LIMIT = 4096;

/**
 * Split text into Telegram-sized pieces, preferring newline boundaries.
 *
 * Contract: no content is dropped and pieces are emitted in source order.
 * Rejoining with "\n" reproduces the input exactly, EXCEPT where a single
 * line exceeded `limit` and had to be hard-split — those fragments rejoin
 * with a separator that was not in the source. Nothing is lost either way.
 *
 * `current` is `null` when nothing is buffered and `""` when a single blank
 * line is buffered. These are different states, and conflating them is a
 * content-loss bug, not a style choice: with string-emptiness as the
 * sentinel, blank lines vanish and `chunk("\n\n\n")` returns `[]`.
 */
export function chunk(text: string, limit: number = TELEGRAM_LIMIT): string[] {
  if (text.length === 0) return [];

  const out: string[] = [];
  let current: string | null = null;

  const push = () => {
    if (current !== null) {
      out.push(current);
      current = null;
    }
  };

  for (const line of text.split("\n")) {
    // A single line that cannot fit must be hard-split.
    if (line.length > limit) {
      push();
      for (let i = 0; i < line.length; i += limit) {
        out.push(line.slice(i, i + limit));
      }
      continue;
    }
    const candidate: string = current === null ? line : `${current}\n${line}`;
    if (candidate.length > limit) {
      push();
      current = line;
    } else {
      current = candidate;
    }
  }
  push();
  return out;
}
