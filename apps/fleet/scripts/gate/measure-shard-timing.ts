//
// #715 / operator 08:25Z: shard count must be MEASURED, not a fixed number.
// Parses the same `vitest --reporter=json` shape localci.sh already
// produces (its own $RUN/vitest.json, scripts/localci/summarize.ts's own
// parseVitestJson) into {file, ms}[] for src/gate/shard-plan.ts's bucketer.
// Run standalone: `bun run apps/fleet/scripts/gate/measure-shard-timing.ts
// <vitest.json path>` prints the {file, ms}[] JSON to stdout.

export function parseVitestTimings(text: string): { file: string; ms: number }[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const results = (j as { testResults?: unknown }).testResults;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const rec = r as { name?: unknown; startTime?: unknown; endTime?: unknown };
    // Strip the repo-root prefix: prefer the explicit apps/fleet marker;
    // names outside apps/fleet keep their tail after their own root
    // (first two leading path segments), same as the vitest json shape.
    const file = String(rec.name ?? "")
      .replace(/^.*\/apps\/fleet\//, "")
      .replace(/^\/[^/]+\/[^/]+\//, "");
    const start = typeof rec.startTime === "number" ? rec.startTime : 0;
    const end = typeof rec.endTime === "number" ? rec.endTime : 0;
    return { file, ms: Math.max(0, end - start) };
  });
}

// bun test's junit reporter (bun 1.3.12): per-file `<testsuite>` time attr
// stays "0" — real seconds live only on each `<testcase time>`. Per-file
// timing is the sum of that file's testcase times. Same output shape as
// parseVitestTimings so shard-plan.ts treats both lanes alike.
// Plain bun runtime has no DOMParser, so testcase tags are matched with a
// regex: per-file ms = sum of that file's testcase time attrs.
export function parseBunJunitTimings(xml: string): { file: string; ms: number }[] {
  if (!xml.includes("<testcase")) return [];
  const out = new Map<string, number>();
  const re = /<testcase\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const file = /(?:\bfile="([^"]*)")/.exec(tag)?.[1] ?? "";
    if (!file) continue;
    const t = Number(/(?:\btime="([^"]*)")/.exec(tag)?.[1] ?? Number.NaN);
    out.set(file, (out.get(file) ?? 0) + (Number.isFinite(t) ? t : 0));
  }
  return [...out.entries()].map(([file, s]) => ({ file, ms: Math.round(s * 1000) }));
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: measure-shard-timing.ts <vitest-reporter-json-path>");
    process.exit(2);
  }
  const text = await Bun.file(path).text();
  console.log(JSON.stringify(parseVitestTimings(text)));
}
