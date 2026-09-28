import { describe, it, expect } from "vitest";
import { formatTaskTable, formatTaskShow, formatAssignWake, TITLE_WIDTH } from "../cli/task-format";
import { parseEnvelope, renderEnvelopeComment } from "../src/board/envelope";
import type { BoardTask } from "../src/board/types";

// Imports cli/task-format.ts specifically, NOT cli/fleet.ts — same reason
// test/cli.fleet.test.ts imports cli/fleet-totals.ts: cli/fleet.ts carries
// bun-only globals that the root tsconfig's type set cannot resolve. This
// module is deliberately Bun/node-free.

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 12, url: "https://github.com/o/r/issues/12", title: "Build the task board",
    body: "## Objective\n\nShip it.\n", state: "submitted", labels: ["submitted"],
    assignee: null, milestone: "Sprint 1", open: true, updatedAt: "2026-08-25T10:00:00Z", ...overrides,
  };
}

describe("formatTaskTable", () => {
  it("says so plainly when the board is empty", () => {
    expect(formatTaskTable([])).toContain("no tasks");
  });

  it("prints number, state, sprint, title and the issue url", () => {
    const out = formatTaskTable([task()]);
    expect(out).toContain("#");
    expect(out).toContain("12");
    expect(out).toContain("submitted");
    expect(out).toContain("Sprint 1");
    expect(out).toContain("Build the task board");
    expect(out).toContain("https://github.com/o/r/issues/12");
  });

  it("shows a task with no sprint as a dash, matching every other absent value in this CLI", () => {
    expect(formatTaskTable([task({ milestone: null })])).toContain("-");
  });

  it("makes drift loud rather than blank — the labels are the evidence", () => {
    const out = formatTaskTable([task({ state: null, labels: ["working", "completed"] })]);
    expect(out).toContain("DRIFT");
    expect(out).toContain("working");
    expect(out).toContain("completed");
  });

  it("prints an unlabelled issue as backlog, not as drift", () => {
    const out = formatTaskTable([task({ state: null, labels: [] })]);
    expect(out).toContain("backlog");
    expect(out).not.toContain("DRIFT");
  });

  it("appends /stale rather than replacing the state, so both stay readable", () => {
    expect(formatTaskTable([{ ...task({ state: null, labels: [] }), stale: true }]))
      .toContain("backlog/stale");
    expect(formatTaskTable([{ ...task(), stale: true }])).toContain("submitted/stale");
  });

  it("truncates a long title so the url column stays reachable", () => {
    const out = formatTaskTable([task({ title: "x".repeat(TITLE_WIDTH + 40) })]);
    expect(out).toContain("…");
    expect(out.split("\n")[1].length).toBeLessThan(TITLE_WIDTH + 80);
  });
});

describe("formatTaskShow", () => {
  function envelopeComment(notes: string) {
    const parsed = parseEnvelope(
      {
        sender: "websites--web-studio", intent: "result", status: "ok",
        artifacts: [{ kind: "pull-request", pr: "42" }],
        evidence: ["bun run test — 970 passed"],
        verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
        open_questions: ["Close the issue at sprint close?"],
        context_digest: ["CAS, not a blind write"],
        notes,
      },
      12, "msg-1",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    return {
      id: 1, url: "u1", author: "example-bot[bot]", createdAt: "2026-08-25T11:00:00Z",
      body: renderEnvelopeComment(parsed.doc), envelope: parsed.doc,
    };
  }

  it("prints the task header, its url and the brief itself", () => {
    const out = formatTaskShow({ task: task(), comments: [] });
    expect(out).toContain("#12");
    expect(out).toContain("submitted");
    expect(out).toContain("https://github.com/o/r/issues/12");
    expect(out).toContain("## Objective");
    expect(out).toContain("Ship it.");
  });

  it("renders an envelope comment from its struct — intent, status, artifacts, evidence, questions", () => {
    const out = formatTaskShow({ task: task(), comments: [envelopeComment("Board module landed.")] });
    expect(out).toContain("websites--web-studio");
    expect(out).toContain("result");
    expect(out).toContain("ok");
    expect(out).toContain("PR #42");
    expect(out).toContain("bun run test — 970 passed");
    expect(out).toContain("Close the issue at sprint close?");
    expect(out).toContain("Board module landed.");
    // The struct itself is machinery, not something an operator reads.
    expect(out).not.toContain("```json");
  });

  it("prints a human comment as written", () => {
    const out = formatTaskShow({
      task: task(),
      comments: [{ id: 2, url: "u2", author: "rafarc21", createdAt: "t2", body: "looks good", envelope: null }],
    });
    expect(out).toContain("rafarc21");
    expect(out).toContain("looks good");
  });

  it("says the task has no comments rather than trailing an empty heading", () => {
    expect(formatTaskShow({ task: task(), comments: [] }).toLowerCase()).toContain("no comments");
  });
});

describe("the STUDIO column (§5 assignment)", () => {
  it("names the owning studio, and prints - for an unassigned task", () => {
    const out = formatTaskTable([
      task({ assignee: "websites--web-studio", labels: ["submitted", "studio:websites--web-studio"] }),
      task({ number: 13, assignee: null }),
    ]);
    expect(out).toContain("STUDIO");
    expect(out).toContain("websites--web-studio");
    expect(out.split("\n")[2]).toContain(" - ");
  });

  it("prints DRIFT with the labels when two writers claim one task", () => {
    // Same treatment the STATE column gives an ambiguous state: a blank cell
    // would read as "unassigned", which is the opposite of what it means.
    const out = formatTaskTable([task({
      assignee: null, labels: ["submitted", "studio:a--b", "studio:c--d"],
    })]);
    expect(out).toContain("DRIFT(studio:a--b,studio:c--d)");
  });

  it("`fleet task show` carries the owner on its header line", () => {
    const out = formatTaskShow({ task: task({ assignee: "websites--web-studio" }), comments: [] });
    expect(out).toContain("studio: websites--web-studio");
  });
});

// Board issue #41, half one: the operator has to be able to SEE that an
// assignment woke the studio, or did not and why. "Nothing happened, silently"
// is the whole complaint the issue opens with.

describe("formatAssignWake", () => {
  it("says the studio was given a turn", () => {
    expect(formatAssignWake({ woke: true, digest: "WAKE TASK ASSIGNED #42 \"t\"" }))
      .toBe("woke the studio: WAKE TASK ASSIGNED #42 \"t\"");
  });

  it("says nothing was woken, and why, verbatim", () => {
    expect(formatAssignWake({ woke: false, reason: "websites--web-studio is stopped — no wake was sent" }))
      .toBe("NO WAKE — websites--web-studio is stopped — no wake was sent");
  });

  it("prints nothing at all when the response carries no wake field", () => {
    // A bare backlog create with no assignee — the one case with no studio
    // to report a wake outcome about — answers exactly as it did before this
    // feature existed. Board #158: a same-studio re-assign is NOT this case
    // any more; it carries a wake field and prints one of the lines above.
    expect(formatAssignWake(undefined)).toBeNull();
  });
});

// Task 5: the maestro's per-task authorization for the junior skill.
describe("junior authorization is visible on the board", () => {
  it("marks junior-authorized tasks in ls and show", () => {
    const t = { ...task(), labels: [...task().labels, "junior"] };
    expect(formatTaskTable([t])).toContain("[junior] ");
    expect(formatTaskShow({ task: t, comments: [] }).split("\n")[0]).toContain("junior: yes");
    expect(formatTaskShow({ task: task(), comments: [] }).split("\n")[0]).not.toContain("junior");
  });
});
