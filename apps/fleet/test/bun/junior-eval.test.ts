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

// The plan's own fixture above never ties (mean 2 vs 1.5), so `rows.sort((a, b)
// => b.mean - a.mean)` is never exercised on equal means. Array.prototype.sort
// is spec-guaranteed stable (ECMA-262 since ES2019, and Bun/Node/V8 honor
// this), so a tie is broken by each model's first-appearance order in the
// `results` array (the order `aggregate`'s internal Map first sees the model,
// since re-`set`-ing an existing Map key does not move it). This test locks
// that behavior in both directions, so a future refactor that breaks
// insertion-order stability (e.g. swapping the Map for something unordered)
// fails loudly instead of silently producing a nondeterministic table that
// feeds the junior-default decision.
test("aggregate: tied mean preserves each model's first-appearance order (stable sort)", () => {
  const verdicts = [
    { model: "m1", commit: "c1", s: 2, harmful: false },
    { model: "m2", commit: "c1", s: 2, harmful: false },
  ];
  const m1First = [
    { model: "m1", commit: "c1", status: "ok", secs: 10, neurons: 0 },
    { model: "m2", commit: "c1", status: "ok", secs: 10, neurons: 0 },
  ];
  expect(aggregate(m1First, verdicts).map((r) => r.model)).toEqual(["m1", "m2"]);

  const m2First = [
    { model: "m2", commit: "c1", status: "ok", secs: 10, neurons: 0 },
    { model: "m1", commit: "c1", status: "ok", secs: 10, neurons: 0 },
  ];
  expect(aggregate(m2First, verdicts).map((r) => r.model)).toEqual(["m2", "m1"]);
});
