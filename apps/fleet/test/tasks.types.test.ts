import { describe, it, expect } from "vitest";
import { GATE_LABELS, type GateAction, type TaskStatus } from "../src/tasks/types";

// S24-F2 (refs #602, parent #588): the consumed surface of src/tasks/types.ts
// is exactly GateAction, GATE_LABELS, TaskStatus — the only names its five
// importers (tasks/loop.ts, agents/runtime.ts, approvals/gates.ts,
// approvals/store.ts, test/tasks.loop.test.ts) pull. This module's other
// five exports have zero importers and this branch deletes or un-exports
// them. This test pins the SURFACE that must survive: if removing one of
// those names later breaks a real consumer, that break surfaces as this file
// failing to compile or these assertions failing — not as a silent change.
describe("tasks/types consumed surface (S24-F2 pin)", () => {
  it("GATE_LABELS maps every GateAction to a non-empty label", () => {
    const actions: GateAction[] = ["merge_staging", "deploy_staging", "merge_main", "deploy_prod"];
    for (const action of actions) {
      const label = GATE_LABELS[action];
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("TaskStatus type-checks with the container /status shape", () => {
    const status: TaskStatus = {
      state: "idle",
      taskId: null,
      milestones: [],
      pendingApproval: null,
      result: null,
      error: null,
      costUsd: null,
    };
    // A type-only pin: the value exists at runtime solely so tsc/vitest
    // prove the interface still composes (WorkerTaskState/Milestone/PendingApproval
    // stay in-file under TaskStatus after this branch un-exports them).
    expect(status.state).toBe("idle");
    expect(status.milestones).toEqual([]);
    expect(status.pendingApproval).toBeNull();
  });
});
