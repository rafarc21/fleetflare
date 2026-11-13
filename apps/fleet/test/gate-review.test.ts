// #1469: the review verb's pure decision logic — skip classification, dedup,
// verdict mapping, lead mapping, and the status-post confirm contract.
import { describe, it, expect, vi } from "vitest";
import {
  docsOrLockfileOnly, reviewVerdict, decideReviewStart, reviewLeadType, reviewBlocking,
  postReviewStatus, REVIEW_PENDING_DESCRIPTION, REVIEW_STATUS_CONTEXT,
  type ReviewStatusPort,
} from "../src/gate/review";

const BLOCKING = ["migrations/**", "scripts/deploy/**"];

describe("docsOrLockfileOnly (#1469)", () => {
  it("docs and lockfiles are skipped", () => {
    expect(docsOrLockfileOnly(["README.md", "docs/guide.md"])).toBe(true);
    expect(docsOrLockfileOnly(["bun.lock", "package-lock.json"])).toBe(true);
    expect(docsOrLockfileOnly(["docs/a.md", "yarn.lock"])).toBe(true);
  });
  it("any code file means review", () => {
    expect(docsOrLockfileOnly(["src/index.ts"])).toBe(false);
    expect(docsOrLockfileOnly(["README.md", "src/index.ts"])).toBe(false);
  });
  it("an empty list is NOT skipped (fail closed)", () => {
    expect(docsOrLockfileOnly([])).toBe(false);
  });
});

describe("reviewVerdict (#1469)", () => {
  it("a passing report is success even on a blocking path", () => {
    expect(reviewVerdict({ blocking: true, envelopeStatus: "ok" })).toBe("success");
    expect(reviewVerdict({ blocking: true, envelopeStatus: "partial" })).toBe("success");
  });
  it("a failed report on a blocking path is failure", () => {
    expect(reviewVerdict({ blocking: true, envelopeStatus: "blocked" })).toBe("failure");
    expect(reviewVerdict({ blocking: true, envelopeStatus: "failed" })).toBe("failure");
  });
  it("a failed report off a blocking path is neutral (advisory)", () => {
    expect(reviewVerdict({ blocking: false, envelopeStatus: "blocked" })).toBe("neutral");
    expect(reviewVerdict({ blocking: false, envelopeStatus: "failed" })).toBe("neutral");
  });
});

describe("reviewBlocking (#1469)", () => {
  it("matches a blocking path with the /** prefix shape", () => {
    expect(reviewBlocking(["migrations/0012_x.sql"], BLOCKING)).toBe(true);
    expect(reviewBlocking(["src/index.ts"], BLOCKING)).toBe(false);
  });
});

describe("decideReviewStart (#1469)", () => {
  const review = { enabled: true, blockingPaths: BLOCKING, lead: "claude" as const };
  it("disabled when the repo has no enabled review", () => {
    expect(decideReviewStart({ review: null, changedFiles: ["src/a.ts"], existingState: undefined }).action).toBe("disabled");
    expect(decideReviewStart({ review: { enabled: false, blockingPaths: [], lead: "claude" }, changedFiles: ["src/a.ts"], existingState: undefined }).action).toBe("disabled");
  });
  it("skips a docs/lockfile-only diff", () => {
    expect(decideReviewStart({ review, changedFiles: ["README.md"], existingState: undefined }).action).toBe("skip");
  });
  it("skips a head that already carries a non-pending status", () => {
    expect(decideReviewStart({ review, changedFiles: ["src/a.ts"], existingState: "success" }).action).toBe("already-reviewed");
    expect(decideReviewStart({ review, changedFiles: ["src/a.ts"], existingState: "failure" }).action).toBe("already-reviewed");
  });
  it("runs on a fresh head", () => {
    expect(decideReviewStart({ review, changedFiles: ["src/a.ts"], existingState: undefined }).action).toBe("run");
  });
});

describe("reviewLeadType (#1469)", () => {
  it("claude maps to claude; the OSS pool keys map to glm", () => {
    expect(reviewLeadType("claude")).toBe("claude");
    expect(reviewLeadType("deepseek")).toBe("glm");
    expect(reviewLeadType("glm")).toBe("glm");
    expect(reviewLeadType("kimi")).toBe("glm");
  });
});

describe("postReviewStatus (#1469)", () => {
  function port(over: Partial<ReviewStatusPort> = {}): ReviewStatusPort & { posted: { state: string; description: string }[] } {
    const posted: { state: string; description: string }[] = [];
    return {
      mintToken: vi.fn(async () => "tok"),
      post: vi.fn(async (_t, _r, _s, state, description) => { posted.push({ state, description }); }),
      get: vi.fn(async () => undefined),
      ...over,
      posted,
    };
  }

  it("posts and confirms the state landed", async () => {
    const p = port({ get: vi.fn(async () => ({ state: "success", description: "ok" })) });
    await postReviewStatus(p, "acme/example", "c".repeat(40), { state: "success", description: "ok" });
    expect(p.post).toHaveBeenCalledWith("tok", "acme/example", "c".repeat(40), "success", "ok");
  });

  it("maps neutral to success at the GitHub boundary", async () => {
    const p = port({ get: vi.fn(async () => ({ state: "success", description: "advisory" })) });
    await postReviewStatus(p, "acme/example", "c".repeat(40), { state: "neutral", description: "advisory" });
    expect(p.posted[0]).toEqual({ state: "success", description: "advisory" });
  });

  it("throws when the read-back does not match", async () => {
    const p = port({ get: vi.fn(async () => ({ state: "pending", description: "other" })) });
    await expect(postReviewStatus(p, "acme/example", "c".repeat(40), { state: "success", description: "ok" }))
      .rejects.toThrow(/gate\/review POST failed/);
  });
});

describe("constants (#1469)", () => {
  it("the status context is distinct from the gate runner's", () => {
    expect(REVIEW_STATUS_CONTEXT).toBe("gate/review");
    expect(REVIEW_PENDING_DESCRIPTION).toBe("review in progress");
  });
});