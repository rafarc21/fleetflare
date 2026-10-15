# Plan — gate shard planner (Task 3, refs #715, issue #948)

Pure module `apps/fleet/src/gate/shard-plan.ts` + bun test. Interfaces exactly per plan Task 3: `FileTiming { file: string; ms: number }`, `planShards(timings: FileTiming[], targetShardMs: number): string[][]`. Review delta (#715 comment 6188308109): pack by measured per-file duration, LPT (longest first onto lightest shard); file with no timing gets median of measured; ties broken by path for determinism; single file > targetShardMs gets own shard. N = max(1, ceil(total/targetShardMs)), capped at file count.

## Steps

1. RED: write apps/fleet/test/bun/gate-shard-plan.test.ts (plan Task 3 cases + delta: median default, path tie determinism, oversize own shard). Commit.
2. GREEN: implement apps/fleet/src/gate/shard-plan.ts, targeted test green. Commit.
3. Verify: bun test test/bun/gate-shard-plan.test.ts; tsc --noEmit -p test; tsc --noEmit; english-check. One gate at a time.
4. Review (15m cap, 2 rounds max), then PR + envelope on #948.
