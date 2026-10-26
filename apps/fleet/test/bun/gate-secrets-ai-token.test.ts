// #1346: the Workers AI proxy route's run-scoped bearer token. "Expires with
// run": a token minted with ttlMs verifies right up to the boundary and
// fails exactly past it, and never verifies for a different run or leg even
// well before expiry.
import { describe, it, expect } from "bun:test";
import { mintRunToken, verifyRunToken } from "../../src/gate/secrets-ai-token";

const KEY = "test-signing-key-not-real";

describe("mintRunToken / verifyRunToken", () => {
  it("verifies a freshly minted token for its own run and leg", async () => {
    const token = await mintRunToken({ runId: "run-1", leg: "ai-smoke", now: 1_000, ttlMs: 60_000 }, KEY);
    expect(await verifyRunToken(token, { runId: "run-1", leg: "ai-smoke", now: 1_500 }, KEY)).toBe(true);
  });

  it("verifies right up to one millisecond before exp", async () => {
    const token = await mintRunToken({ runId: "run-1", leg: "ai-smoke", now: 1_000, ttlMs: 60_000 }, KEY);
    expect(await verifyRunToken(token, { runId: "run-1", leg: "ai-smoke", now: 1_000 + 60_000 - 1 }, KEY)).toBe(true);
  });

  it("run token expires with run: fails exactly at exp, and past it", async () => {
    const token = await mintRunToken({ runId: "run-1", leg: "ai-smoke", now: 1_000, ttlMs: 60_000 }, KEY);
    expect(await verifyRunToken(token, { runId: "run-1", leg: "ai-smoke", now: 1_000 + 60_000 }, KEY)).toBe(false);
    expect(await verifyRunToken(token, { runId: "run-1", leg: "ai-smoke", now: 1_000 + 60_000 + 1 }, KEY)).toBe(false);
  });

  it("rejects a token minted for a different run id, even before expiry", async () => {
    const token = await mintRunToken({ runId: "run-1", leg: "ai-smoke", now: 1_000, ttlMs: 60_000 }, KEY);
    expect(await verifyRunToken(token, { runId: "run-2", leg: "ai-smoke", now: 1_500 }, KEY)).toBe(false);
  });

  it("rejects a token minted for a different leg, even before expiry", async () => {
    const token = await mintRunToken({ runId: "run-1", leg: "ai-smoke", now: 1_000, ttlMs: 60_000 }, KEY);
    expect(await verifyRunToken(token, { runId: "run-1", leg: "other-leg", now: 1_500 }, KEY)).toBe(false);
  });

  it("rejects a token signed with a different key (tampered or wrong deploy)", async () => {
    const token = await mintRunToken({ runId: "run-1", leg: "ai-smoke", now: 1_000, ttlMs: 60_000 }, KEY);
    expect(await verifyRunToken(token, { runId: "run-1", leg: "ai-smoke", now: 1_500 }, "a-different-key")).toBe(false);
  });

  it("rejects a tampered payload even with a valid-looking signature part", async () => {
    const token = await mintRunToken({ runId: "run-1", leg: "ai-smoke", now: 1_000, ttlMs: 60_000 }, KEY);
    const [, sig] = token.split(".");
    const forged = `${btoa(JSON.stringify({ runId: "run-1", leg: "ai-smoke", exp: 9_999_999 })).replace(/=+$/, "")}.${sig}`;
    expect(await verifyRunToken(forged, { runId: "run-1", leg: "ai-smoke", now: 1_500 }, KEY)).toBe(false);
  });

  it("rejects malformed tokens without throwing", async () => {
    expect(await verifyRunToken("not-a-token", { runId: "run-1", leg: "ai-smoke", now: 1_500 }, KEY)).toBe(false);
    expect(await verifyRunToken("", { runId: "run-1", leg: "ai-smoke", now: 1_500 }, KEY)).toBe(false);
    expect(await verifyRunToken("a.b.c", { runId: "run-1", leg: "ai-smoke", now: 1_500 }, KEY)).toBe(false);
  });
});
