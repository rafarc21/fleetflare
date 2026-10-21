import { describe, it, expect, vi } from "vitest";
import { completedGate, fallbackTaskPr, type CompletedGatePort } from "../src/board/completed-gate";

const REPO = "acme-org/websites";
const SHA = "abc123def4567890";

function port(overrides: Partial<CompletedGatePort> = {}): CompletedGatePort {
  return {
    getPullRequest: vi.fn(async () => ({ merged: true })),
    getHeadSha: vi.fn(async () => SHA),
    getCommitStatus: vi.fn(async () => ({ state: "success" })),
    findTaskPrs: vi.fn(async () => []),
    ...overrides,
  };
}

describe("completedGate — #1247", () => {
  it("merged + success status -> { ok: true }", async () => {
    const result = await completedGate(port(), REPO, 42);
    expect(result).toEqual({ ok: true, value: null });
  });

  it("not merged -> ok:false 409, message contains 'not merged'", async () => {
    const result = await completedGate(port({ getPullRequest: vi.fn(async () => ({ merged: false })) }), REPO, 42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.message).toContain("not merged");
    }
  });

  it("merged + status undefined -> 409, message contains 'not success'", async () => {
    const result = await completedGate(port({ getCommitStatus: vi.fn(async () => undefined) }), REPO, 42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.message).toContain("not success");
    }
  });

  it("merged + status 'failure' -> 409", async () => {
    const result = await completedGate(port({ getCommitStatus: vi.fn(async () => ({ state: "failure" })) }), REPO, 42);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("merged + status 'success' checks getCommitStatus on the PR's head sha", async () => {
    const p = port();
    const result = await completedGate(p, REPO, 42);
    expect(result).toEqual({ ok: true, value: null });
    expect(p.getHeadSha).toHaveBeenCalledWith(REPO, 42);
    expect(p.getCommitStatus).toHaveBeenCalledWith(REPO, SHA);
  });
});

describe("fallbackTaskPr — search when the envelope names no PR", () => {
  it("no candidates -> 409 naming no PR", async () => {
    const p = port({ findTaskPrs: vi.fn(async () => []) });
    const result = await fallbackTaskPr(p, REPO, 42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.message).toContain("no PR");
    }
  });

  it("first candidate merged + green -> returns its number", async () => {
    const p = port({ findTaskPrs: vi.fn(async () => [77]) });
    const result = await fallbackTaskPr(p, REPO, 42);
    expect(result).toEqual({ ok: true, value: 77 });
  });

  it("first candidate unmerged, second merged + green -> returns the second", async () => {
    const p = port({
      findTaskPrs: vi.fn(async () => [88, 99]),
      getPullRequest: vi.fn(async (_repo, n) => ({ merged: n === 99 })),
    });
    const result = await fallbackTaskPr(p, REPO, 42);
    expect(result).toEqual({ ok: true, value: 99 });
  });

  it("every candidate fails the gate -> 409", async () => {
    const p = port({
      findTaskPrs: vi.fn(async () => [88, 99]),
      getPullRequest: vi.fn(async () => ({ merged: false })),
    });
    const result = await fallbackTaskPr(p, REPO, 42);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });
});