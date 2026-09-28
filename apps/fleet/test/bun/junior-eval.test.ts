// apps/fleet/test/bun/junior-eval.test.ts
import { expect, test } from "bun:test";
import { aggregate } from "../../../../scripts/junior-eval/eval";

test("aggregate: mean, perfect, harmful, failed, p50, cost; timeouts count as 0", () => {
  const results = [
    { model: "m1", commit: "c1", status: "ok", secs: 10, neurons: 1000 },
    { model: "m1", commit: "c2", status: "api-error", secs: 300, neurons: 0 },
    { model: "m2", commit: "c1", status: "ok", secs: 5, neurons: 100 },
  ];
  const verdicts = [
    { model: "m1", commit: "c1", s: 3, harmful: false },
    { model: "m2", commit: "c1", s: 2, harmful: true },
  ];
  expect(aggregate(results, verdicts)).toEqual([
    { model: "m2", n: 1, mean: 2, perfect: 0, harmful: 1, failed: 0, p50: 5, costPerTask: 0.0011 },
    { model: "m1", n: 2, mean: 1.5, perfect: 1, harmful: 0, failed: 1, p50: 300, costPerTask: 0.0055 },
  ].sort((a, b) => b.mean - a.mean));
});
