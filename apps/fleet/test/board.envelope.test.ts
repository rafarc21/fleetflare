import { describe, it, expect, vi } from "vitest";
import {
  parseEnvelope, renderEnvelopeComment, parseEnvelopeComment, parseLearnings,
  ENVELOPE_SCHEMA_VERSION, ENVELOPE_MAX_CHARS,
} from "../src/board/envelope";
import { commentEnvelope, type BoardApi } from "../src/board/board";
import { taskStates, type EnvelopeDoc, type BoardTask } from "../src/board/types";

const MSG_ID = "0d9f1c2e-0000-4000-8000-000000000001";

const minimal = {
  sender: "websites--web-studio", intent: "result", status: "ok",
  verification: {
    url: "https://staging.example.com/pricing",
    steps: ["Open the pricing page", "Click Upgrade"],
    expected: "Checkout modal opens on the $49 tier",
  },
};

function doc(): EnvelopeDoc {
  const res = parseEnvelope(
    {
      ...minimal,
      artifacts: [{ kind: "pull-request", pr: "42" }, { kind: "file", path: "src/board/board.ts", digest: "sha256:ab" }],
      evidence: ["bun run test — 970 passed", "bun run check — clean"],
      open_questions: ["Should sprint close also close the issue?"],
      context_digest: ["CAS on the observed label, not a blind write"],
      learnings: ["GitHub auto-creates a missing label on issue create"],
      notes: "Board module landed.",
    },
    7, MSG_ID,
  );
  if (!res.ok) throw new Error(res.message);
  return res.doc;
}

describe("parseEnvelope", () => {
  it("stamps msg_id, schema_version and the ROUTE's task id — never the caller's", () => {
    const res = parseEnvelope({ ...minimal, task_id: 7 }, 7, MSG_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.envelope.msg_id).toBe(MSG_ID);
    expect(res.doc.envelope.schema_version).toBe(ENVELOPE_SCHEMA_VERSION);
    expect(res.doc.envelope.task_id).toBe(7);
    expect(res.doc.envelope.sender).toBe("websites--web-studio");
  });

  it("refuses an envelope whose task_id names a different task — wrong-agent contamination", () => {
    const res = parseEnvelope({ ...minimal, task_id: 9 }, 7, MSG_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("9");
    expect(res.message).toContain("7");
  });

  it("refuses an unknown intent and an unknown status, naming the closed set", () => {
    const badIntent = parseEnvelope({ ...minimal, intent: "gossip" }, 7, MSG_ID);
    expect(badIntent.ok).toBe(false);
    if (!badIntent.ok) expect(badIntent.message).toContain("clarify");

    const badStatus = parseEnvelope({ ...minimal, status: "fine" }, 7, MSG_ID);
    expect(badStatus.ok).toBe(false);
    if (!badStatus.ok) expect(badStatus.message).toContain("blocked");
  });

  it("requires a sender — an envelope with no author cannot be threaded", () => {
    expect(parseEnvelope({ intent: "result", status: "ok" }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...minimal, sender: "  " }, 7, MSG_ID).ok).toBe(false);
  });

  it("defaults every list slot to empty rather than dropping the key", () => {
    const res = parseEnvelope(minimal, 7, MSG_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.payload.artifacts).toEqual([]);
    expect(res.doc.payload.evidence).toEqual([]);
    expect(res.doc.payload.open_questions).toEqual([]);
    expect(res.doc.payload.context_digest).toEqual([]);
    expect(res.doc.payload.learnings).toEqual([]);
    expect(res.doc.notes).toBe("");
  });

  it("refuses an artifact that locates nothing, and one with no kind", () => {
    expect(parseEnvelope({ ...minimal, artifacts: [{ kind: "file" }] }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...minimal, artifacts: [{ path: "a.ts" }] }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...minimal, artifacts: [{ kind: "file", path: "a.ts" }] }, 7, MSG_ID).ok).toBe(true);
  });

  it("refuses a non-array where §6 says list, and a non-string entry inside one", () => {
    expect(parseEnvelope({ ...minimal, evidence: "ran the tests" }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...minimal, evidence: [1] }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...minimal, open_questions: {} }, 7, MSG_ID).ok).toBe(false);
  });

  it("refuses notes that would blow GitHub's own comment limit", () => {
    const res = parseEnvelope({ ...minimal, notes: "x".repeat(ENVELOPE_MAX_CHARS) }, 7, MSG_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain(String(ENVELOPE_MAX_CHARS));
  });

  it("refuses a non-object envelope outright", () => {
    expect(parseEnvelope(null, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope("result", 7, MSG_ID).ok).toBe(false);
  });
});

// Task 4 (P5a guardrails): do.ts's teardown harvest calls this directly
// against a studio's `.fleet/done.json`, outside any full envelope — so it
// gets its own direct coverage, not just parseEnvelope's integration test
// above (line 78: "defaults every list slot to empty").
describe("parseLearnings — the same rule the board envelope's learnings[] already enforces", () => {
  it("absent or null: empty list, not an error — most studios harvest nothing", () => {
    expect(parseLearnings(undefined)).toEqual({ ok: true, list: [] });
    expect(parseLearnings(null)).toEqual({ ok: true, list: [] });
  });

  it("trims each entry and drops blanks", () => {
    expect(parseLearnings(["  real one  ", "", "   ", "another"]))
      .toEqual({ ok: true, list: ["real one", "another"] });
  });

  it("refuses a non-array", () => {
    const res = parseLearnings("one learning as a bare string");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("learnings");
  });

  it("refuses an array with a non-string entry", () => {
    const res = parseLearnings(["fine", 123]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("learnings");
  });
});

describe("parseEnvelope — verification intent (§4)", () => {
  const sample = { url: "https://x.test/check", steps: ["open it", "click it"], expected: "it works" };
  const base = { sender: "websites--web-studio", intent: "result" };

  // Fix round 1: reviewer traced a real path around "result/ok only" -- a
  // partial result still attaches a PR (artifacts is independent of
  // status), Release Studio merges on CI-green not envelope status (§5/§7),
  // and verification intent never got demanded. Every graded result -- ok,
  // partial, failed, blocked -- owes it; only "nothing produced" is exempt.
  it.each(["ok", "partial", "failed", "blocked"])(
    "refuses a result/%s envelope with no verification block, naming the field and its shape",
    (status) => {
      const res = parseEnvelope({ ...base, status }, 7, MSG_ID);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain("verification");
      expect(res.message).toContain("url");
      expect(res.message).toContain("steps");
      expect(res.message).toContain("expected");
    },
  );

  it.each(["ok", "partial", "failed", "blocked"])(
    "accepts a result/%s envelope carrying a well-formed verification block",
    (status) => {
      const res = parseEnvelope({ ...base, status, verification: sample }, 7, MSG_ID);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.doc.payload.verification).toEqual(sample);
    },
  );

  it.each(["request", "clarify", "escalate", "error"])(
    "does NOT require verification on intent %s — nothing was produced to point at yet",
    (intent) => {
      expect(parseEnvelope({ sender: "s", intent, status: "ok" }, 7, MSG_ID).ok).toBe(true);
    },
  );

  it("still shape-checks a verification block on an exempt intent that carries one anyway", () => {
    const res = parseEnvelope({ sender: "s", intent: "clarify", status: "partial", verification: { url: "" } }, 7, MSG_ID);
    expect(res.ok).toBe(false);
  });

  it("refuses a verification block missing url, with empty steps, or with a blank expected", () => {
    const ok = { ...base, status: "ok" };
    expect(parseEnvelope({ ...ok, verification: { steps: ["a"], expected: "b" } }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...ok, verification: { url: "u", steps: [], expected: "b" } }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...ok, verification: { url: "u", steps: ["a"], expected: "" } }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...ok, verification: { url: "u", steps: ["", "  "], expected: "b" } }, 7, MSG_ID).ok).toBe(false);
    expect(parseEnvelope({ ...ok, verification: { url: "u", steps: "a", expected: "b" } }, 7, MSG_ID).ok).toBe(false);
  });

  it("trims steps and drops blank entries, same as every other §6 text list", () => {
    const res = parseEnvelope({ ...base, status: "ok", verification: { url: " u ", steps: [" a ", "", "b"], expected: " e " } }, 7, MSG_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.payload.verification).toEqual({ url: "u", steps: ["a", "b"], expected: "e" });
  });
});

describe("renderEnvelopeComment", () => {
  it("leads with prose a human reads — intent, sender, status — not the struct", () => {
    const body = renderEnvelopeComment(doc());
    const head = body.split("\n")[0];
    expect(head).toContain("result");
    expect(head).toContain("websites--web-studio");
    expect(head).toContain("ok");
    expect(head).not.toContain("{");
  });

  it("renders artifacts, evidence, open questions and context digest as readable lists", () => {
    const body = renderEnvelopeComment(doc());
    expect(body).toContain("PR #42");
    expect(body).toContain("src/board/board.ts");
    expect(body).toContain("bun run test — 970 passed");
    expect(body).toContain("Should sprint close also close the issue?");
    expect(body).toContain("CAS on the observed label, not a blind write");
    expect(body).toContain("Board module landed.");
  });

  it("hides the struct behind a details block — humans never read the struct", () => {
    const body = renderEnvelopeComment(doc());
    expect(body).toContain("<details>");
    expect(body).toContain("```json");
  });

  it("renders the verification block — URL, steps, expected — for a graded result", () => {
    const body = renderEnvelopeComment(doc());
    expect(body).toContain("Verification");
    expect(body).toContain(minimal.verification.url);
    expect(body).toContain(minimal.verification.steps[0]);
    expect(body).toContain(minimal.verification.expected);
  });

  it("renders nothing under Verification when the envelope carries no block", () => {
    const res = parseEnvelope({ sender: "s", intent: "request", status: "ok" }, 7, MSG_ID);
    if (!res.ok) throw new Error(res.message);
    expect(renderEnvelopeComment(res.doc)).not.toContain("Verification");
  });

  it("says so explicitly when a list slot is empty, rather than dropping the heading", () => {
    const res = parseEnvelope(minimal, 7, MSG_ID);
    if (!res.ok) throw new Error(res.message);
    const body = renderEnvelopeComment(res.doc);
    expect(body).toContain("Open questions");
    expect(body.toLowerCase()).toContain("none");
  });
});

describe("parseEnvelopeComment", () => {
  it("round-trips a rendered envelope back to the exact struct", () => {
    const original = doc();
    expect(parseEnvelopeComment(renderEnvelopeComment(original))).toEqual(original);
  });

  it("survives notes that themselves contain a json fence", () => {
    // The struct is always the LAST json fence in the body — that is what
    // makes a fence inside free text harmless.
    const res = parseEnvelope({ ...minimal, notes: "we tried:\n```json\n{\"a\":1}\n```\nand it failed" }, 7, MSG_ID);
    if (!res.ok) throw new Error(res.message);
    expect(parseEnvelopeComment(renderEnvelopeComment(res.doc))).toEqual(res.doc);
  });

  it("returns null for a human comment and for a mangled struct", () => {
    expect(parseEnvelopeComment("looks good to me, ship it")).toBeNull();
    expect(parseEnvelopeComment("```json\n{not json\n```")).toBeNull();
    expect(parseEnvelopeComment("```json\n{\"a\":1}\n```")).toBeNull();
  });
});

describe("commentEnvelope verifies PR artifacts", () => {
  function task(labels: string[]): BoardTask {
    return {
      number: 7, url: "https://github.com/o/r/issues/7", title: "t", body: "",
      state: taskStates(labels)[0] ?? null, labels,
      assignee: null, milestone: null, open: true, updatedAt: "2026-08-25T10:00:00Z",
    };
  }

  // No shared BoardApi fake lives in this file -- envelope.ts's own tests are
  // pure and need none. Built locally, scoped to this describe block, rather
  // than reused from another test file's (task-4 brief).
  function fakeBoardApi(overrides: Partial<BoardApi> & { labels?: string[] } = {}): BoardApi {
    const { labels = ["working"], ...rest } = overrides;
    return {
      createIssue: vi.fn(async () => task(labels)),
      getIssue: vi.fn(async () => task(labels)),
      listIssues: vi.fn(async () => [task(labels)]),
      addLabels: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
      createComment: vi.fn(async () => ({ id: 1, url: "https://github.com/o/r/issues/7#issuecomment-1" })),
      pullRequestExists: vi.fn(async () => true),
      listComments: vi.fn(async () => []),
      listMilestones: vi.fn(async () => []),
      branchExists: vi.fn(async () => true),
      commitExists: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
      listOpenPullFiles: vi.fn(async () => []),
      ...rest,
    };
  }

  const RESULT = {
    sender: "web-studio", intent: "result", status: "ok",
    artifacts: [{ kind: "pr", pr: "#4242" }],
    verification: { url: "https://staging.example/x", steps: ["open it"], expected: "renders" },
  };

  it("refuses a result whose claimed PR does not exist", async () => {
    const api = fakeBoardApi({ labels: ["working"], pullRequestExists: async () => false });
    const res = await commentEnvelope(api, "o/r", 7, RESULT, "m1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.message).toContain("4242");
    }
  });

  it("accepts the same result when the PR is real", async () => {
    const api = fakeBoardApi({ labels: ["working"], pullRequestExists: async () => true });
    const res = await commentEnvelope(api, "o/r", 7, RESULT, "m1");
    expect(res.ok).toBe(true);
  });

  it("never calls GitHub for a non-PR artifact", async () => {
    let calls = 0;
    const api = fakeBoardApi({
      labels: ["working"],
      pullRequestExists: async () => { calls++; return true; },
    });
    const res = await commentEnvelope(
      api, "o/r", 7, { ...RESULT, artifacts: [{ kind: "doc", path: "docs/x.md" }] }, "m1",
    );
    expect(res.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it("a GitHub outage does NOT refuse the envelope — the check fails OPEN", async () => {
    // Gate fail-CLOSED, check fail-OPEN: an unreachable API is a statement
    // about the API, never about the studio's work. Losing a real report to a
    // 500 is worse than recording one unverified claim.
    const api = fakeBoardApi({
      labels: ["working"],
      pullRequestExists: async () => { throw new Error("read o/r#4242 failed (503): upstream"); },
    });
    const res = await commentEnvelope(api, "o/r", 7, RESULT, "m1");
    expect(res.ok).toBe(true);
  });
});
