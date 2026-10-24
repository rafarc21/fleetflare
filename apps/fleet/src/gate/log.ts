// #1277: `fleet gate log` — read one leg's final R2 output and surface the
// failing test names + assertions, not just the "Tests 1 failed" summary line.
//
// Pure of bindings so bun test can load it: the Worker route (routes.ts) passes
// the real R2 listing/gets, the CLI prints what it returns. The one rule that
// matters here is "pick the FINAL try": a leg can write several results —
// shard-<leg>.json (first attempt), shard-<leg>.retry.json (a red-first retry),
// shard-<leg>-try<N>.json (an infra retry), shard-<leg>@head.json (a union leg)
// — and reading a stale SIGTERM try (exit 143) as the verdict misleads.

/** One leg-result object as the container wrote it to R2 (container/gate-server.ts's
 *  GateBody): state + description, plus the stdout/stderr tail it keeps. */
export interface LegOutput {
  state: "success" | "failure" | "error";
  description?: string;
  stdout?: string;
  stderr?: string;
  summary?: string;
  limits?: string;
}

/** The try suffixes a leg result key may carry, ordered so the LAST match in
 *  file order is the final try: `.retry.json` beats the base, `-tryN.json`
 *  beats both and a higher N beats a lower one. `@head` is a DIFFERENT leg
 *  (the union leg), never a try of the same one. */
const TRY_SUFFIX = /(?:-try(\d+)\.json|\.retry\.json)$/;

/** A key's final-try rank: higher wins. -tryN -> N+2 (beats retry's 2, beats
 *  base's 1); .retry -> 2; base -> 1. A key that is not this leg's own shape
 *  ranks 0 and is ignored. */
function tryRank(key: string): number {
  const m = TRY_SUFFIX.exec(key);
  if (m === null) return key.endsWith(".json") ? 1 : 0;
  if (m[1] !== undefined) return Number(m[1]) + 2;
  return 2; // .retry
}

/** The final-try key for one leg from the full set of keys under its run
 *  prefix. Only keys whose base matches `shard-<leg>` (or `shard-<leg>@head`)
 *  count; the highest rank wins, a tie (unreachable: rank is injective per
 *  suffix) keeps the first seen. Null when the leg has no result at all. */
export function finalLegKey(keys: string[], leg: string): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const key of keys) {
    // Strip `.json` and any variant suffix (-tryN / .retry) to get the leg's
    // BASE name, which must be exactly `.../shard-<leg>`. A plain `vitest-6`
    // query then cannot pick up `vitest-6@head` (a different leg, #1095) —
    // but a query for leg `vitest-6@head` matches its own base exactly.
    const base = key.replace(/\.json$/, "").replace(/-try\d+$/, "").replace(/\.retry$/, "");
    if (!base.endsWith(`shard-${leg}`)) continue;
    const rank = tryRank(key);
    if (rank > bestRank) { bestRank = rank; best = key; }
  }
  return best;
}

/** The failing-test lines from one leg's output: a FAIL / ✕ / (fail) marker, a
 *  failing-test name (vitest's "> <name>", bun's "(fail) <name>"), and every
 *  AssertionError line. Ordered as they appear, de-duplicated. Empty when the
 *  output has none (a pass, or a failure whose assertion scrolled past the 32k
 *  kept tail — the honest answer is "not in the tail", never a fabrication). */
export function failingLines(output: LegOutput): string[] {
  const text = `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
  const lines = text.split("\n");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const isFail = /^(FAIL|✕|✗)/.test(line) || /^\(fail\)/.test(line);
    const isAssertion = /AssertionError/.test(line);
    if (isFail || isAssertion) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}