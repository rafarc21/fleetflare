// #1276 item 3: the verdict-post queue's pure parts — the reset-time rule.
// The D1-backed queue's statements are exercised through drainVerdictQueue in
// the Worker-side test (test/gate-verdict-queue.test.ts).
import { describe, it, expect } from "bun:test";
import { verdictPostResetAt, VERDICT_POST_DEFAULT_RETRY_MS } from "../../src/gate/verdict-queue";

describe("verdictPostResetAt (#1276)", () => {
  it("uses GitHub's reset hint when present", () => {
    expect(verdictPostResetAt(120_000, 1000)).toBe(121_000);
  });

  it("falls back to the default minute when no hint is given", () => {
    expect(verdictPostResetAt(null, 1000)).toBe(1000 + VERDICT_POST_DEFAULT_RETRY_MS);
  });
});