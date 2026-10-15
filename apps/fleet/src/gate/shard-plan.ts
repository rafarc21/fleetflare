// apps/fleet/src/gate/shard-plan.ts
//
// #715 / operator 08:25Z: pack shards by measured per-file wall time, not
// file count — LPT bin packing (heaviest file first onto the lightest
// shard). Deterministic: ms ties break by path, so run-to-run re-planning
// with the same timings yields identical shards.
export interface FileTiming { file: string; ms: number }

const DEFAULT_MS = 60_000; // first run, nothing measured yet

export function planShards(timings: FileTiming[], targetShardMs: number): string[][] {
  if (timings.length === 0) return [];

  // A file with ms 0 has no measurement behind it — weigh the measured
  // median instead so a fresh file neither hides at 0ms nor starves a
  // shard of balance. All-unmeasured input falls back to DEFAULT_MS.
  const measured = timings.filter((t) => t.ms > 0).map((t) => t.ms).sort((a, b) => a - b);
  const median = measured.length > 0
    ? measured[Math.floor((measured.length - 1) / 2)]
    : DEFAULT_MS;
  const weights = timings.map((t) => (t.ms > 0 ? t.ms : median));

  // Longest first; path breaks ms ties so sort order is total.
  const order = timings
    .map((t, i) => ({ file: t.file, ms: weights[i] }))
    .sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : 1));

  // ceil, not round: a shard over target is a cold-start slot worth paying
  // for, but an under-target remainder must not be dropped.
  const totalMs = order.reduce((sum, t) => sum + t.ms, 0);
  const n = Math.min(order.length, Math.max(1, Math.ceil(totalMs / targetShardMs)));

  const shards: { files: string[]; ms: number }[] = [];
  for (const t of order) {
    // A file heavier than a whole shard's budget gets a shard of its own —
    // pairing it with anything would just starve that neighbor.
    if (t.ms > targetShardMs && shards.length < n) {
      shards.push({ files: [t.file], ms: t.ms });
      continue;
    }
    if (shards.length >= n) {
      // All slots taken: pack onto the lightest existing shard.
      let lightest = shards[0];
      for (const s of shards) if (s.ms < lightest.ms) lightest = s;
      lightest.files.push(t.file);
      lightest.ms += t.ms;
      continue;
    }
    // Slots remain: fill each new shard up to target before opening another.
    const current = shards[shards.length - 1];
    if (current && current.ms < targetShardMs) {
      current.files.push(t.file);
      current.ms += t.ms;
    } else {
      shards.push({ files: [t.file], ms: t.ms });
    }
  }
  return shards.map((s) => s.files);
}
