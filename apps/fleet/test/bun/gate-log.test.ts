// #1277: the pure pieces of `fleet gate log` — final-try key selection and
// failing-line extraction — kept apart from the Worker route so bun test can
// load them.
import { describe, it, expect } from "bun:test";
import { finalLegKey, failingLines, legAttemptKeys, firstFailingTest, attemptLabel, type LegOutput } from "../../src/gate/log";

describe("finalLegKey: pick the final try, never a stale SIGTERM try (#1277)", () => {
  const prefix = "gate/acme/example/runs/7/run-abc/";

  it("the base key when no try/retry exists", () => {
    expect(finalLegKey([`${prefix}shard-vitest-6.json`], "vitest-6")).toBe(`${prefix}shard-vitest-6.json`);
  });

  it(".retry beats the base", () => {
    expect(finalLegKey([`${prefix}shard-vitest-6.json`, `${prefix}shard-vitest-6.retry.json`], "vitest-6"))
      .toBe(`${prefix}shard-vitest-6.retry.json`);
  });

  it(".retry ranks above every -tryN (it is written LAST, leg-run.ts)", () => {
    const keys = [
      `${prefix}shard-vitest-6.json`,
      `${prefix}shard-vitest-6.retry.json`,
      `${prefix}shard-vitest-6-try2.json`,
      `${prefix}shard-vitest-6-try3.json`,
    ];
    expect(finalLegKey(keys, "vitest-6")).toBe(`${prefix}shard-vitest-6.retry.json`);
  });

  it("a higher -tryN beats a lower one when there is no .retry", () => {
    const keys = [
      `${prefix}shard-vitest-6-try2.json`, // exit 143, stale
      `${prefix}shard-vitest-6-try3.json`,
    ];
    expect(finalLegKey(keys, "vitest-6")).toBe(`${prefix}shard-vitest-6-try3.json`);
  });

  it("ignores other legs' keys, and @head is a different leg, not a try", () => {
    const keys = [
      `${prefix}shard-vitest-7.json`,
      `${prefix}shard-vitest-6@head.json`,
    ];
    expect(finalLegKey(keys, "vitest-6")).toBeNull();
  });

  it("null when the leg has no result at all", () => {
    expect(finalLegKey([`${prefix}shard-merge-tree.json`], "vitest-6")).toBeNull();
  });
});

describe("failingLines: failing tests + assertions, never fabricated (#1277)", () => {
  const out = (stdout: string, stderr = ""): LegOutput => ({ state: "failure", stdout, stderr });

  it("pulls FAIL and ✕ markers and the AssertionError line", () => {
    const lines = failingLines(out([
      "RUN  v1.2.3",
      " ✕ should trim (2ms)",
      "FAIL tests/a.test.ts > a > should trim",
      "AssertionError: expected 'x ' to equal 'x'",
      " ✓ should pass",
    ].join("\n")));
    expect(lines).toContain("✕ should trim (2ms)");
    expect(lines).toContain("FAIL tests/a.test.ts > a > should trim");
    expect(lines).toContain("AssertionError: expected 'x ' to equal 'x'");
    expect(lines.some((l) => l.startsWith("✓"))).toBe(false);
  });

  it("a pass (no fail markers) extracts nothing", () => {
    expect(failingLines(out("✓ should pass\n1393 passed\n"))).toEqual([]);
  });

  it("de-duplicates repeated markers", () => {
    const lines = failingLines(out("FAIL x\nFAIL x\n"));
    expect(lines).toEqual(["FAIL x"]);
  });

  it("(fail) bun markers are caught too", () => {
    expect(failingLines(out("(fail) should trim [5.00ms]\n"))).toEqual(["(fail) should trim [5.00ms]"]);
  });
});
describe("legAttemptKeys: every attempt of one leg, oldest first (#1318)", () => {
  const prefix = "gate/acme/example/runs/7/run-abc/";
  const base = `${prefix}shard-vitest-6`;

  it("lists the base, each -tryN and .retry in write order", () => {
    const keys = [
      `${base}.json`,
      `${base}-try2.json`,
      `${base}.retry.json`,
      `${base}-try3.json`,
    ];
    expect(legAttemptKeys(keys, "vitest-6")).toEqual([
      `${base}.json`,
      `${base}-try2.json`,
      `${base}-try3.json`,
      `${base}.retry.json`,
    ]);
  });

  it("ignores other legs' keys, including @head and @head shards", () => {
    const keys = [
      `${base}.json`,
      `${prefix}shard-vitest-7.json`,
      `${prefix}shard-vitest-6@head.json`,
      `${prefix}shard-vitest@head-6.json`,
    ];
    expect(legAttemptKeys(keys, "vitest-6")).toEqual([`${base}.json`]);
  });

  it("empty when the leg has no result at all", () => {
    expect(legAttemptKeys([`${prefix}shard-merge-tree.json`], "vitest-6")).toEqual([]);
  });
});

describe("firstFailingTest: the first named failing test in an attempt's output (#1318)", () => {
  const out = (stdout: string): LegOutput => ({ state: "failure", stdout });

  it("picks the vitest '> name' that follows a FAIL line", () => {
    expect(firstFailingTest(out([
      "FAIL src/a.test.ts > a > should trim",
      "AssertionError: expected 'x ' to equal 'x'",
    ].join("\n")))).toBe("should trim");
  });

  it("picks a bun (fail) name", () => {
    expect(firstFailingTest(out("(fail) should add [4.00ms]\n"))).toBe("should add");
  });

  it("picks the first ✕ line's name", () => {
    expect(firstFailingTest(out(" ✕ should drop (2ms)\n"))).toBe("should drop");
  });

  it("null when no failing test is named in the tail", () => {
    expect(firstFailingTest(out("1393 passed\n"))).toBeNull();
    expect(firstFailingTest(out("FAIL (no name follows)\n"))).toBeNull();
  });
});

describe("attemptLabel (#1377)", () => {
  it("the shard name with its attempt variant, @head included", () => {
    expect(attemptLabel("gate/a/b/runs/1/r/shard-browser@head.retry.json")).toBe("shard-browser@head.retry");
    expect(attemptLabel("gate/a/b/runs/1/r/shard-browser@head.json")).toBe("shard-browser@head");
    expect(attemptLabel("gate/a/b/runs/1/r/shard-e2e.json")).toBe("shard-e2e");
  });
});

describe("legAttemptKeys: @head legs (#1318 r1)", () => {
  const prefix = "gate/acme/example/runs/7/run-abc/";

  it("lists the attempts of a union leg vitest-6@head", () => {
    const keys = [
      `${prefix}shard-vitest-6@head.json`,
      `${prefix}shard-vitest-6@head-try2.json`,
    ];
    expect(legAttemptKeys(keys, "vitest-6@head")).toEqual([
      `${prefix}shard-vitest-6@head.json`,
      `${prefix}shard-vitest-6@head-try2.json`,
    ]);
  });

  it("lists the attempts of a sharded union leg vitest@head-6", () => {
    const keys = [
      `${prefix}shard-vitest@head-6.json`,
      `${prefix}shard-vitest@head-6.retry.json`,
    ];
    expect(legAttemptKeys(keys, "vitest@head-6")).toEqual([
      `${prefix}shard-vitest@head-6.json`,
      `${prefix}shard-vitest@head-6.retry.json`,
    ]);
  });
});

// #1398 Task 2: tryRank must recognize the retry step's OWN internal
// infra-retry shape (`.retry-tryN`), produced by retryResultKey then
// infraRetryResultKey composed -- the retry step always runs LAST, and a later
// internal try of IT is later still.
describe("tryRank: .retry-tryN ranks above every plain -tryN and the bare .retry (#1398)", () => {
  it("ranks .retry-tryN ABOVE the bare .retry (try 1), not below", () => {
    expect(finalLegKey(
      ["gate/o/r/runs/1/i/shard-vitest-8.retry.json", "gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json"],
      "vitest-8",
    )).toBe("gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json");
  });

  it("still ranks a plain -tryN (start step's own infra retry) correctly against .retry-tryN", () => {
    expect(finalLegKey(
      ["gate/o/r/runs/1/i/shard-vitest-8-try2.json", "gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json"],
      "vitest-8",
    )).toBe("gate/o/r/runs/1/i/shard-vitest-8.retry-try2.json"); // the retry step's own try always runs LAST
  });
});
