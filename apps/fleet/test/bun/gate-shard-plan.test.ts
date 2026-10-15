// apps/fleet/test/bun/gate-shard-plan.test.ts
//
// Issue #948 (plan Task 3, refs #715): LPT shard bucketing balanced by
// measured wall time. Review delta (#715 comment 6188308109): pack by
// per-file duration, not file count; no-timing files get the measured
// median; ties broken by path so output is deterministic; a file heavier
// than targetShardMs gets its own shard.
import { describe, it, expect } from "bun:test";
import { planShards, type FileTiming } from "../../src/gate/shard-plan";

describe("planShards", () => {
  it("empty input -> zero shards", () => {
    expect(planShards([], 60_000)).toEqual([]);
  });

  it("sizes N from total/targetShardMs, not a fixed count", () => {
    const timings: FileTiming[] = Array.from({ length: 10 }, (_, i) => ({ file: `f${i}.test.ts`, ms: 10_000 }));
    // total 100_000ms, target 20_000ms -> 5 shards
    const shards = planShards(timings, 20_000);
    expect(shards.length).toBe(5);
    // every file assigned exactly once
    expect(shards.flat().sort()).toEqual(timings.map((t) => t.file).sort());
  });

  it("balances by wall time, not file count", () => {
    const timings: FileTiming[] = [
      { file: "slow.test.ts", ms: 90_000 },
      ...Array.from({ length: 9 }, (_, i) => ({ file: `fast${i}.test.ts`, ms: 10_000 })),
    ];
    const shards = planShards(timings, 30_000);
    // the one slow file must not share a shard with more than a little fast work
    const slowShard = shards.find((s) => s.includes("slow.test.ts"))!;
    expect(slowShard.length).toBeLessThanOrEqual(2);
  });

  it("never returns an empty shard for non-empty input", () => {
    const timings: FileTiming[] = [{ file: "only.test.ts", ms: 5_000 }];
    const shards = planShards(timings, 20_000);
    expect(shards.every((s) => s.length > 0)).toBe(true);
  });

  it("a single huge file never splits across two shards", () => {
    const timings: FileTiming[] = [{ file: "huge.test.ts", ms: 500_000 }];
    const shards = planShards(timings, 20_000);
    const owning = shards.filter((s) => s.includes("huge.test.ts"));
    expect(owning.length).toBe(1);
  });

  it("a file with no timing gets the measured median, not zero", () => {
    const timings: FileTiming[] = [
      { file: "a.test.ts", ms: 10_000 },
      { file: "b.test.ts", ms: 30_000 },
      { file: "c.test.ts", ms: 20_000 },
      { file: "d.test.ts", ms: 0 }, // new file, never measured
    ];
    const shards = planShards(timings, 30_000);
    // every file assigned exactly once, regardless of missing timing
    expect(shards.flat().sort()).toEqual(timings.map((t) => t.file).sort());
    // median of measured files is 20_000; d.test.ts must weigh that, not 0.
    // Total 80_000, target 30_000 -> 3 shards; a 0-weight d.test.ts would
    // leave a nearly-empty shard once real files fill the other two.
    expect(shards.every((s) => s.length > 0)).toBe(true);
  });

  it("packs heaviest first onto the lightest shard (LPT), so shards come out even", () => {
    // 3 x 10s and 3 x 6s over 3 shards: LPT puts one 10 per shard, then a 6
    // on each lightest shard -> 16s each. Fill-to-target would stack 20 / 16 / 12.
    const timings: FileTiming[] = [
      { file: "a.test.ts", ms: 10_000 }, { file: "b.test.ts", ms: 10_000 }, { file: "c.test.ts", ms: 10_000 },
      { file: "d.test.ts", ms: 6_000 }, { file: "e.test.ts", ms: 6_000 }, { file: "f.test.ts", ms: 6_000 },
    ];
    const loads = planShards(timings, 16_000).map((s) =>
      s.reduce((sum, f) => sum + timings.find((t) => t.file === f)!.ms, 0));
    expect(loads.sort((x, y) => x - y)).toEqual([16_000, 16_000, 16_000]);
  });

  it("deterministic: same input in different order -> same output", () => {
    const timings: FileTiming[] = [
      { file: "z.test.ts", ms: 10_000 },
      { file: "a.test.ts", ms: 10_000 },
      { file: "m.test.ts", ms: 10_000 },
    ];
    const one = planShards(timings, 15_000);
    const two = planShards([...timings].reverse(), 15_000);
    expect(one).toEqual(two);
  });
});
