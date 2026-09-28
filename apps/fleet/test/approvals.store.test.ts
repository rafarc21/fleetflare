import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createApproval, getApproval, decideApproval, finishApproval,
  setApprovalMessageId, recentApprovalsFor,
} from "../src/approvals/store";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM approvals").run();
});

const base = {
  id: "appr_1",
  eventId: "evt_1",
  project: "websites",
  action: "merge_staging" as const,
  params: { repo: "o/r", pr: "123" },
  chatId: "100000001",
};

describe("approvals store", () => {
  it("round-trips params as structured data, not a string", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.params).toEqual({ repo: "o/r", pr: "123" });
    expect(row?.state).toBe("pending");
    expect(row?.requestedTs).toBe(1000);
  });

  it("decides exactly once", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    expect(await decideApproval(env.DB, "appr_1", "approved", "100000001", 2000)).toBe(true);
    expect(await decideApproval(env.DB, "appr_1", "approved", "100000001", 3000)).toBe(false);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.decidedTs).toBe(2000);
  });

  it("refuses to decide a row that does not exist", async () => {
    expect(await decideApproval(env.DB, "nope", "approved", "1", 1)).toBe(false);
  });

  it("records the live message id and the terminal result", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    await setApprovalMessageId(env.DB, "appr_1", 77);
    await finishApproval(env.DB, "appr_1", "executed", "merged abc123");
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.messageId).toBe(77);
    expect(row?.state).toBe("executed");
    expect(row?.result).toBe("merged abc123");
  });

  it("finds recent approvals scoped to project and action", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    await createApproval(env.DB, { ...base, id: "appr_2", action: "merge_main" }, 1500);
    await createApproval(env.DB, { ...base, id: "appr_3", project: "other" }, 1600);
    const hits = await recentApprovalsFor(env.DB, "websites", "merge_staging", 500);
    expect(hits.map((h) => h.id)).toEqual(["appr_1"]);
  });

  it("excludes approvals older than the window", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    const hits = await recentApprovalsFor(env.DB, "websites", "merge_staging", 2000);
    expect(hits).toEqual([]);
  });
});
