// apps/fleet/src/gate/shard-plan.ts
//
// #715 / operator 08:25Z: pack shards by measured per-file wall time, not
// file count — LPT bin packing (heaviest file first onto the lightest
// shard). Deterministic: ms ties break by path, so run-to-run re-planning
// with the same timings yields identical shards.
export interface FileTiming { file: string; ms: number }

const DEFAULT_MS = 60_000; // first run, nothing measured yet

/** Sum of the weights: the wall time the whole set costs, unmeasured files
 *  included at the median. */
export function totalWeightMs(timings: FileTiming[]): number {
  return weighTimings(timings).reduce((sum, ms) => sum + ms, 0);
}

/** Per-file weight in ms, aligned with `timings`. A file with ms 0 has no
 *  measurement behind it — weigh the measured median instead so a fresh file
 *  neither hides at 0ms nor starves a shard of balance. All-unmeasured input
 *  falls back to DEFAULT_MS. */
export function weighTimings(timings: FileTiming[]): number[] {
  const measured = timings.filter((t) => t.ms > 0).map((t) => t.ms).sort((a, b) => a - b);
  const median = measured.length > 0
    ? measured[Math.floor((measured.length - 1) / 2)]
    : DEFAULT_MS;
  return timings.map((t) => (t.ms > 0 ? t.ms : median));
}

export function planShards(timings: FileTiming[], targetShardMs: number): string[][] {
  if (timings.length === 0) return [];

  const weights = weighTimings(timings);

  // Longest first; path breaks ms ties so sort order is total.
  const order = timings
    .map((t, i) => ({ file: t.file, ms: weights[i] }))
    .sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : 1));

  // ceil, not round: a shard over target is a cold-start slot worth paying
  // for, but an under-target remainder must not be dropped.
  const totalMs = order.reduce((sum, t) => sum + t.ms, 0);
  const n = Math.min(order.length, Math.max(1, Math.ceil(totalMs / targetShardMs)));

  // LPT: the first n files each open a shard (heaviest first), then every
  // later file goes to the lightest shard. Filling a shard up to target
  // before opening the next overshoots by a whole file per shard, which left
  // the bun lane's slowest leg ~36% over an even split (#1018).
  const shards: { files: string[]; ms: number }[] = [];
  for (const t of order) {
    if (shards.length < n) {
      shards.push({ files: [t.file], ms: t.ms });
      continue;
    }
    let lightest = shards[0];
    for (const s of shards) if (s.ms < lightest.ms) lightest = s;
    lightest.files.push(t.file);
    lightest.ms += t.ms;
  }
  return shards.map((s) => s.files);
}
