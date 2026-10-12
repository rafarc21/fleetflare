/** Bun-lane shared `waitFor` for the four suites whose copies were
 *  byte-identical (sweep 18, F11). Polls `predicate` until it returns true
 *  or `timeoutMs` elapses; checks once more after the deadline so a
 *  last-instant true is never reported as a timeout. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}
