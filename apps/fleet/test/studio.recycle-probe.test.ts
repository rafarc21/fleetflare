import { describe, it, expect, vi } from "vitest";
import { containerAnswers } from "../src/studio/do";
import type { SessionSyncDeps } from "../src/studio/session-sync";

/**
 * Board #68. Against an unresponsive container, recycle used to run session
 * sync, rescue-push AND harvest — each burning its own sbExec budget (30s/90s)
 * — before reaching destroy. The platform killed the invocation
 * (`outcome=exceededWallTime`) and the operator saw `500 internal error`.
 *
 * These cover the probe that decides whether that work is worth attempting.
 * The probe never throws: a failure IS the answer.
 */
function deps(exec: SessionSyncDeps["exec"]): SessionSyncDeps {
  return { exec } as unknown as SessionSyncDeps;
}

describe("containerAnswers — one cheap round trip before the expensive ones", () => {
  it("true when the container answers with exit 0", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "ok", stderr: "" }));
    expect(await containerAnswers(deps(exec))).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("false on a nonzero exit, without throwing", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "nope" }));
    expect(await containerAnswers(deps(exec))).toBe(false);
  });

  it("false when exec rejects — a dead container errors rather than answering", async () => {
    const exec = vi.fn(async () => { throw new Error("no instance"); });
    expect(await containerAnswers(deps(exec))).toBe(false);
  });

  it("false when exec never settles: the probe must not inherit sbExec's 90s budget", async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>(() => {}));
      const verdict = containerAnswers(deps(exec));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await verdict).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resolve before its own deadline — a slow-but-alive container still counts", async () => {
    vi.useFakeTimers();
    try {
      let settle: (v: { code: number; stdout: string; stderr: string }) => void = () => {};
      const exec = vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>((r) => { settle = r; }));
      const verdict = containerAnswers(deps(exec));
      await vi.advanceTimersByTimeAsync(7_000);
      settle({ code: 0, stdout: "ok", stderr: "" });
      expect(await verdict).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
