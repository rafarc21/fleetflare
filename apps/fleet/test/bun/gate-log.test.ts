// #1277: the pure pieces of `fleet gate log` — final-try key selection and
// failing-line extraction — kept apart from the Worker route so bun test can
// load them.
import { describe, it, expect } from "bun:test";
import { finalLegKey, failingLines, type LegOutput } from "../../src/gate/log";

describe("finalLegKey: pick the final try, never a stale SIGTERM try (#1277)", () => {
  const prefix = "gate/acme/example/runs/7/run-abc/";

  it("the base key when no try/retry exists", () => {
    expect(finalLegKey([`${prefix}shard-vitest-6.json`], "vitest-6")).toBe(`${prefix}shard-vitest-6.json`);
  });

  it(".retry beats the base", () => {
    expect(finalLegKey([`${prefix}shard-vitest-6.json`, `${prefix}shard-vitest-6.retry.json`], "vitest-6"))
      .toBe(`${prefix}shard-vitest-6.retry.json`);
  });

  it("a higher -tryN beats a lower one and beats .retry", () => {
    const keys = [
      `${prefix}shard-vitest-6.json`,
      `${prefix}shard-vitest-6.retry.json`,
      `${prefix}shard-vitest-6-try2.json`,
      `${prefix}shard-vitest-6-try3.json`,
    ];
    expect(finalLegKey(keys, "vitest-6")).toBe(`${prefix}shard-vitest-6-try3.json`);
  });

  it("a stale SIGTERM try2 is never chosen when a later try3 exists", () => {
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