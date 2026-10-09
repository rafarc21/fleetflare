import { describe, it, expect } from "vitest";
import { parseBrief, renderBriefPrompt, renderTaskBody, TASK_BODY_MAX, TASK_TITLE_MAX } from "../src/board/brief";

// §5's ruling made mechanical: a task body is a SELF-CONTAINED brief —
// objective, output format, boundaries. Spec issues cause 43.8% of agent
// failures, so the three sections are a hard floor here, not a convention a
// caller can skip.

describe("parseBrief", () => {
  const good = {
    title: "Build the task board",
    objective: "Worker-side board module owning every issue read/write.",
    outputFormat: "PR against 35-terminal-watch, tests green, deployed.",
    boundaries: "No sprint open/close. No studio wiring. No Dockerfiles.",
  };

  it("accepts a complete brief and trims every field", () => {
    const res = parseBrief({ ...good, title: "  Build the task board  " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.brief.title).toBe("Build the task board");
    expect(res.brief.objective).toBe(good.objective);
    expect(res.brief.milestone).toBeNull();
  });

  it("refuses a brief missing any one of the three sections, naming the missing one", () => {
    for (const field of ["objective", "outputFormat", "boundaries"] as const) {
      const res = parseBrief({ ...good, [field]: "" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain(field);
    }
  });

  it("refuses a non-string section rather than coercing it", () => {
    const res = parseBrief({ ...good, objective: 42 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("objective");
  });

  it("refuses a whitespace-only section — a blank slot is not a brief", () => {
    const res = parseBrief({ ...good, boundaries: "   \n  " });
    expect(res.ok).toBe(false);
  });

  it("refuses a missing or empty title", () => {
    expect(parseBrief({ ...good, title: "" }).ok).toBe(false);
    expect(parseBrief({ objective: good.objective, outputFormat: good.outputFormat, boundaries: good.boundaries }).ok)
      .toBe(false);
  });

  it("refuses a title over GitHub's own limit, naming the limit", () => {
    const res = parseBrief({ ...good, title: "x".repeat(TASK_TITLE_MAX + 1) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain(String(TASK_TITLE_MAX));
  });

  it("refuses a body over GitHub's own issue body limit, naming the limit", () => {
    const res = parseBrief({ ...good, objective: "x".repeat(TASK_BODY_MAX) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain(String(TASK_BODY_MAX));
  });

  it("carries a milestone through when given — sprint = milestone", () => {
    const res = parseBrief({ ...good, milestone: "Sprint 2026-08-25" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.brief.milestone).toBe("Sprint 2026-08-25");
  });

  it("reads an absent, null or empty milestone as no sprint, and refuses a non-string one", () => {
    expect(parseBrief({ ...good, milestone: null }).ok).toBe(true);
    expect(parseBrief({ ...good, milestone: "  " }).ok).toBe(true);
    expect(parseBrief({ ...good, milestone: 7 }).ok).toBe(false);
  });

  it("refuses a non-object body outright", () => {
    expect(parseBrief(null).ok).toBe(false);
    expect(parseBrief("brief").ok).toBe(false);
  });
});

describe("renderTaskBody", () => {
  const brief = {
    title: "T", objective: "Ship the board.", outputFormat: "A PR.",
    boundaries: "Nothing else.", milestone: null, assignee: null,
  };

  it("renders all three sections under headings a human can read on the phone", () => {
    const body = renderTaskBody(brief);
    expect(body).toContain("## Objective");
    expect(body).toContain("Ship the board.");
    expect(body).toContain("## Output format");
    expect(body).toContain("A PR.");
    expect(body).toContain("## Boundaries");
    expect(body).toContain("Nothing else.");
  });

  it("states the single-writer rule on the issue itself", () => {
    // The rule is invisible in GitHub's own UI — the issue has to carry it,
    // or a human hand-labels one and drift starts silently.
    expect(renderTaskBody(brief).toLowerCase()).toContain("do not");
    expect(renderTaskBody(brief)).toContain("Worker");
  });
});

describe("parseBrief — assignee (§5 assignment)", () => {
  const base = { title: "T", objective: "O", outputFormat: "F", boundaries: "B" };

  it("carries a valid studio id through", () => {
    const res = parseBrief({ ...base, assignee: " websites--web-studio " });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.brief.assignee).toBe("websites--web-studio");
  });

  it("absent, null and blank all mean unassigned", () => {
    for (const assignee of [undefined, null, "  "]) {
      const res = parseBrief({ ...base, assignee });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.brief.assignee).toBeNull();
    }
  });

  it("refuses a bare role, which could never match a label the Worker writes", () => {
    const res = parseBrief({ ...base, assignee: "web-studio" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("studio id");
  });

  it("refuses a non-string rather than swallowing the wrong shape", () => {
    expect(parseBrief({ ...base, assignee: 7 }).ok).toBe(false);
  });
});

// Task 5: the maestro's per-task authorization for the junior skill.
describe("parseBrief — junior (Task 5: maestro authorization)", () => {
  it("junior: true accepted, absent/false means not set, anything else is a 400", () => {
    const base = { title: "t", objective: "o", outputFormat: "f", boundaries: "b" };
    const ok = parseBrief({ ...base, junior: true });
    expect(ok.ok && ok.brief.junior).toBe(true);
    const off = parseBrief({ ...base, junior: false });
    expect(off.ok && off.brief.junior).toBeUndefined();
    const absent = parseBrief(base);
    expect(absent.ok && absent.brief.junior).toBeUndefined();
    expect(parseBrief({ ...base, junior: "yes" })).toEqual({ ok: false, message: "junior must be a boolean" });
  });
});

// Issue #249 (maestro spec point 5): security-class work's own marker —
// same boolean shape `junior` already uses, becomes SECURITY_LABEL
// (board/types.ts) on the issue. The REFUSAL half (never routed to a
// `leadType: "glm"` studio) lives in board.ts's createTask/assignTask, not
// here — this file only proves the brief ACCEPTS and carries the flag.
describe("parseBrief — security (#249)", () => {
  it("security: true accepted, absent/false means not set, anything else is a 400", () => {
    const base = { title: "t", objective: "o", outputFormat: "f", boundaries: "b" };
    const ok = parseBrief({ ...base, security: true });
    expect(ok.ok && ok.brief.security).toBe(true);
    const off = parseBrief({ ...base, security: false });
    expect(off.ok && off.brief.security).toBeUndefined();
    const absent = parseBrief(base);
    expect(absent.ok && absent.brief.security).toBeUndefined();
    expect(parseBrief({ ...base, security: "yes" })).toEqual({ ok: false, message: "security must be a boolean" });
  });
});

describe("renderBriefPrompt — what a lead boots holding", () => {
  const task = {
    number: 71, url: "https://github.com/o/r/issues/71",
    title: "Ship the thing", body: "## Objective\n\nShip it.\n",
  };
  const out = () => renderBriefPrompt(task, "websites--web-studio");

  it("carries the issue number, the url and the brief body verbatim", () => {
    expect(out()).toContain("#71");
    expect(out()).toContain("https://github.com/o/r/issues/71");
    expect(out()).toContain("Ship the thing");
    expect(out()).toContain("## Objective");
  });

  it("tells the lead who it is on the board and how to read the task back", () => {
    expect(out()).toContain("websites--web-studio");
    expect(out()).toContain("fleet task show 71");
    expect(out()).toContain("fleet task ls");
  });

  it("names the report verb — a lead that cannot report invents a channel", () => {
    expect(out()).toContain("fleet task report 71");
  });

  it("restates the single-writer rule, because the lead has gh and could close its own issue", () => {
    const text = out();
    expect(text).toContain("single writer");
    expect(text.toLowerCase()).toContain("never label, close or reopen");
    expect(text).toContain("gh");
  });

  // Board issue #41, half two. A verb a lead is never told about is a verb
  // that does not exist: the measured failure was tasks sitting at
  // `submitted` while the studio worked, which every monitor read as stalled.
  it("names the state verb and tells the lead to use it the moment it starts", () => {
    const text = out();
    expect(text).toContain("fleet task state 71 working");
    expect(text).toContain("input_required");
    expect(text).toContain("failed");
  });

  // Board issue #110: a lead never told `awaiting_merge` exists will never
  // set it, silently defeating the whole feature — this sentence is the
  // ONLY place a lead learns which states it may self-set.
  it("names awaiting_merge and explains when to set it, as the fourth and last self-set state", () => {
    const text = out();
    expect(text).toContain("awaiting_merge");
    expect(text).toContain("Those four, and no others.");
    // a "why" clause, not just the bare word: tied to having already
    // reported a result with a PR and having nothing left to do but wait.
    expect(text.toLowerCase()).toContain("report");
    expect(text.toLowerCase()).toContain("pr");
    expect(text.toLowerCase()).toContain("merge");
  });

  it("says outright that the lead cannot mark its own task completed", () => {
    const text = out();
    expect(text).toContain("completed");
    expect(text).toContain("verif");
  });

  it("says so when an ADOPTED issue has no body — a blank section reads as a complete brief", () => {
    // the operator's phone: a title and nothing else. P5 §3's adoption injects the
    // issue body as the brief, so the empty case has to be visible.
    const text = renderBriefPrompt({ ...task, body: "   \n" }, "websites--web-studio");
    expect(text).toContain("Ship the thing");
    expect(text).toContain("no body");
    expect(text).toContain("Ask before inventing scope");
  });
});
