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

/** The try suffixes a leg result key may carry. `@head` is a DIFFERENT leg
 *  (the union leg), never a try of the same one. */
const TRY_SUFFIX = /(?:-try(\d+)\.json|\.retry\.json)$/;

/** A key's final-try rank: higher wins. `.retry` ranks above every `-tryN`
 *  because leg-run.ts writes `.retry.json` LAST (the red-first retry runs
 *  after the infra-try sequence); a higher `-tryN` beats a lower one, and the
 *  base ranks lowest. A key that is not this leg's own shape ranks 0. */
function tryRank(key: string): number {
  const m = TRY_SUFFIX.exec(key);
  if (m === null) return key.endsWith(".json") ? 1 : 0;
  if (m[1] !== undefined) return Number(m[1]) + 1;
  // .retry is the last write: rank it above every -tryN (1 + a large floor).
  return 10_000;
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

/** The key suffix after the base `shard-<leg>`: "" for the first attempt,
 *  "-try<N>" for an infra retry, ".retry" for a red-first retry. */
function attemptSuffix(key: string): string | null {
  const base = key.replace(/\.json$/, "").replace(/-try\d+$/, "").replace(/\.retry$/, "");
  const m = base.match(/shard-([^/]+)$/);
  if (m === null) return null;
  return m[1];
}

/** Every attempt key of one leg, oldest first (#1318): the first attempt,
 *  then each infra `-tryN` in numeric order, then `.retry` last (leg-run.ts
 *  writes it after the infra-try sequence). Only keys whose base matches
 *  `shard-<leg>` exactly count — `@head` legs (sharded or not) are a
 *  different leg and never appear. */
export function legAttemptKeys(keys: string[], leg: string): string[] {
  const own = keys.filter((key) => {
    const suffix = attemptSuffix(key);
    // The exact-base match alone isolates the leg: a query for `vitest-6`
    // never picks up `vitest-6@head`, and a query for `vitest-6@head` (or
    // `vitest@head-6`) matches only its own `@head` attempts (#1318 r1).
    return suffix !== null && suffix === leg;
  });
  const rank = (key: string): number => tryRank(key);
  return own.sort((a, b) => rank(a) - rank(b));
}

/** #1377: the attempt label for one result key — the shard name with its
 *  attempt variant, e.g. `shard-browser@head.retry`. Pure, so a test pins it
 *  and the evidence route shares one spelling with the result key's own dir. */
export function attemptLabel(key: string): string {
  return key.replace(/\.json$/, "").split("/").pop() ?? key;
}

/** #1343 MED6: the listing prefix for a run's RESULT keys (its `shard-` files),
 *  never the whole run prefix. Evidence lives under `evidence/`, so scoping to
 *  `shard-` keeps a flood of evidence files from crowding a result out of one
 *  listing page. Pure, so a test pins it. */
export function resultKeysPrefix(runPrefix: string): string {
  return `${runPrefix}shard-`;
}

/** The first named failing test in one attempt's output (#1318): vitest's
 *  "FAIL <file> > <suite> > <name>" (or its "✕ <name>" line), or bun test's
 *  "(fail) <name>". Null when the tail names none — a hung leg writes no
 *  output, so the honest answer is "unnamed", never a guess. */
export function firstFailingTest(output: LegOutput): string | null {
  const text = `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const vitest = /^FAIL\b.*>\s*([^>\s][^>]*?)\s*$/.exec(line);
    if (vitest !== null) return vitest[1];
    const bun = /^\(fail\)\s+(.+?)\s*\[[\d.]+\w+\]$/.exec(line);
    if (bun !== null) return bun[1];
    const cross = /^[✕✗]\s+(.+?)\s+\(\d+(?:\.\d+)?\w+\)$/.exec(line);
    if (cross !== null) return cross[1];
  }
  return null;
}