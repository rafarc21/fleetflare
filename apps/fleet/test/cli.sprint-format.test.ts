import { describe, it, expect } from "vitest";
import {
  formatSprintStatusLine, formatSprintStatusLines, formatSprintSummaries, formatSprintStatus,
} from "../cli/sprint-format";
import { task as boardTask } from "./helpers/board-api";
import type { SprintSummary } from "../src/board/sprint";

// Imports cli/sprint-format.ts specifically, NOT cli/fleet.ts — same reason
// test/cli.task-format.test.ts imports cli/task-format.ts: cli/fleet.ts carries
// bun-only globals that the root tsconfig's type set cannot resolve. This
// module is deliberately Bun/node-free.

// The module prefixes every title with `Sprint `, so a fixture title is the
// bare milestone name ("1", "2"), not the already-prefixed "Sprint 1".
const summary = (overrides: Partial<SprintSummary> = {}): SprintSummary => ({
  title: "1", owner: "rafael", goal: "ship X", completed: 3, total: 10, ...overrides,
});

describe("formatSprintStatusLine", () => {
  it("prints title, completed/total and the rounded percent", () => {
    expect(formatSprintStatusLine(summary())).toBe("Sprint 1: 3/10 (30%)");
  });

  it("reads an empty sprint as 0%, never a divide-by-zero", () => {
    expect(formatSprintStatusLine(summary({ completed: 0, total: 0 }))).toBe("Sprint 1: 0/0 (0%)");
  });
});

describe("formatSprintStatusLines", () => {
  it("says so plainly when no sprints are open", () => {
    expect(formatSprintStatusLines([])).toBe("(no open sprints)");
  });

  it("prints one status line per open sprint", () => {
    const out = formatSprintStatusLines([
      summary({ title: "1", completed: 3, total: 10 }),
      summary({ title: "2", completed: 0, total: 4 }),
    ]);
    expect(out).toBe("Sprint 1: 3/10 (30%)\nSprint 2: 0/4 (0%)");
  });
});

describe("formatSprintSummaries", () => {
  it("carries the status line, owner and goal", () => {
    const out = formatSprintSummaries([summary()]);
    expect(out).toContain("Sprint 1: 3/10 (30%)");
    expect(out).toContain("owner: rafael");
    expect(out).toContain("goal: ship X");
  });

  it("renders an ownerless sprint as a dash, matching every other absent value in this CLI", () => {
    expect(formatSprintSummaries([summary({ owner: null })])).toContain("owner: -");
  });

  it("says so plainly when no sprints are open", () => {
    expect(formatSprintSummaries([])).toBe("(no open sprints)");
  });
});

describe("formatSprintStatus", () => {
  it("leads with the summary line, then one line per task still needing work", () => {
    const out = formatSprintStatus(summary(), [
      boardTask({ number: 12, state: "working", assignee: "websites--web-studio" }),
      boardTask({ number: 13, state: "submitted", assignee: null }),
    ]);
    expect(out.split("\n")[0]).toBe("Sprint 1: 3/10 (30%)");
    expect(out).toContain("  12 working websites--web-studio");
    expect(out).toContain("  13 submitted -");
  });

  it("skips completed and canceled tasks — they need no more work", () => {
    const out = formatSprintStatus(summary(), [
      boardTask({ number: 12, state: "completed", assignee: "websites--web-studio" }),
      boardTask({ number: 13, state: "canceled", assignee: null }),
      boardTask({ number: 14, state: "working", assignee: "websites--web-studio" }),
    ]);
    expect(out).not.toContain("  12");
    expect(out).not.toContain("  13");
    expect(out).toContain("  14 working websites--web-studio");
  });

  it("renders a drifted task (no state, no assignee) as dashes", () => {
    const out = formatSprintStatus(summary(), [
      boardTask({ number: 12, state: null, assignee: null }),
    ]);
    expect(out).toContain("  12 - -");
  });
});