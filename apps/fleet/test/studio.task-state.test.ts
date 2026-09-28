import { describe, it, expect, vi } from "vitest";
import { runTaskStateTransition, type TaskStateDeps, type TaskStateFetchResult } from "../src/studio/task-state";

// Board task #131: `fleet task state <n> <to>` — the CLI verb that wraps the
// EXISTING `transitionTask` route (board.ts:140, routed at
// routes.ts:256). Fake-injection style, the same house convention
// test/studio.onboard.test.ts and test/studio.destroy.test.ts already use —
// no vi.mock() anywhere in this file, matching the rest of apps/fleet/test.

interface FakeCreds {
  workerUrl: string;
}

const CREDS: FakeCreds = { workerUrl: "https://fleet.example.com" };

function baseDeps(overrides: Partial<TaskStateDeps<FakeCreds>> = {}): TaskStateDeps<FakeCreds> {
  return {
    getCurrentState: vi.fn(async (): Promise<TaskStateFetchResult> => ({ ok: true, state: "submitted" })),
    transition: vi.fn(async (): Promise<TaskStateFetchResult> => ({ ok: true, state: "completed" })),
    ...overrides,
  };
}

describe("runTaskStateTransition", () => {
  it("happy transition: reads the current state, sends it as `from`, and reports before -> after", async () => {
    const getCurrentState = vi.fn(async (): Promise<TaskStateFetchResult> => ({ ok: true, state: "submitted" }));
    const transition = vi.fn(async (): Promise<TaskStateFetchResult> => ({ ok: true, state: "completed" }));
    const deps = baseDeps({ getCurrentState, transition });

    const result = await runTaskStateTransition(deps, CREDS, 42, "completed");

    expect(getCurrentState).toHaveBeenCalledWith(CREDS, 42);
    expect(transition).toHaveBeenCalledWith(CREDS, 42, "submitted", "completed");
    expect(result).toEqual({ ok: true, from: "submitted", to: "completed" });
  });

  it("stale-from 409: the route's own message comes through byte-identical, never reformatted", async () => {
    const staleMessage =
      'task #42 is "working", caller expected "submitted" — the Worker is the single writer of task state ' +
      "and refuses a transition it did not initiate";
    const deps = baseDeps({
      getCurrentState: vi.fn(async (): Promise<TaskStateFetchResult> => ({ ok: true, state: "submitted" })),
      transition: vi.fn(async (): Promise<TaskStateFetchResult> => ({ ok: false, status: 409, message: staleMessage })),
    });

    const result = await runTaskStateTransition(deps, CREDS, 42, "completed");

    expect(result).toEqual({ ok: false, status: 409, message: staleMessage });
    if (!result.ok) expect(result.message).toBe(staleMessage);
  });

  it("a getCurrentState failure is surfaced as-is and transition is never called", async () => {
    const readMessage = "board upstream failed: installation revoked";
    const transition = vi.fn(async (): Promise<TaskStateFetchResult> => ({ ok: true, state: "completed" }));
    const deps = baseDeps({
      getCurrentState: vi.fn(async (): Promise<TaskStateFetchResult> => ({ ok: false, status: 502, message: readMessage })),
      transition,
    });

    const result = await runTaskStateTransition(deps, CREDS, 42, "completed");

    expect(result).toEqual({ ok: false, status: 502, message: readMessage });
    expect(transition).not.toHaveBeenCalled();
  });
});
