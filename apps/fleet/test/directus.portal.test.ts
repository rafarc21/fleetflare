import { describe, it, expect } from "vitest";
import { clientStatus, clientView, clientViews, isDelivered } from "../src/directus/portal";
import type { EstateRequest, RequestStatus } from "../src/directus/types";
import { REQUESTS } from "../src/directus/schema";

const req = (over: Partial<EstateRequest> = {}): EstateRequest => ({
  id: "q1", project: "p1", submitted_at: "2026-08-20T10:00:00Z",
  submitted_by: "Amanda", body: "the booking page feels slow on my phone",
  status: "submitted", issue_number: null, verification_url: null, delivered_at: null,
  ...over,
});

describe("the two vocabularies (§8)", () => {
  it("maps submitted and backlog to Received — a client told 'backlog' asks when", () => {
    expect(clientStatus(req({ status: "submitted" }))).toBe("Received");
    expect(clientStatus(req({ status: "backlog" }))).toBe("Received");
  });

  it("maps working to In progress", () => {
    expect(clientStatus(req({ status: "working" }))).toBe("In progress");
  });

  it("publishes NOTHING for failed and canceled — `failed` reads as blame, and usually means superseded", () => {
    expect(clientStatus(req({ status: "failed" }))).toBeNull();
    expect(clientStatus(req({ status: "canceled" }))).toBeNull();
  });

  it("publishes nothing for an internal state nobody mapped — guessing here means guessing Delivered", () => {
    expect(clientStatus(req({ status: "archived" as unknown as RequestStatus }))).toBeNull();
    expect(clientStatus(req({ status: null }))).toBeNull();
  });

  it("covers every internal state the schema declares", () => {
    // A state added to the schema and not mapped here would otherwise fall
    // into the default branch and silently vanish from the portal.
    const declared = REQUESTS.fields.find((f) => f.field === "status")?.choices ?? [];
    expect(declared).toEqual(["submitted", "backlog", "working", "completed", "failed", "canceled"]);
    for (const s of declared) {
      const mapped = clientStatus(req({ status: s as RequestStatus, delivered_at: "2026-08-24T09:00:00Z", verification_url: "https://c.example/r/1" }));
      const expected = s === "failed" || s === "canceled" ? null : expect.any(String);
      expect(mapped).toEqual(expected);
    }
  });
});

describe("the Delivered gate (ruled: only after the operator ticks the checklist)", () => {
  const completed = (over: Partial<EstateRequest> = {}) => req({ status: "completed", ...over });

  it("does NOT publish Delivered on issue close alone", () => {
    // Publishing on close is the claimed-done-wasn't failure, aimed at a
    // paying client instead of at the operator.
    expect(clientStatus(completed({ issue_number: 42 }))).toBe("In progress");
  });

  it("does not publish Delivered on the tick without the evidence link", () => {
    expect(clientStatus(completed({ delivered_at: "2026-08-24T09:00:00Z" }))).toBe("In progress");
  });

  it("does not publish Delivered on an evidence link without the tick", () => {
    // The checklist EXISTS before it is ticked. Handing a client an unticked
    // checklist and calling it the delivery is the same failure by another route.
    expect(clientStatus(completed({ verification_url: "https://checklist.example/r/1" }))).toBe("In progress");
  });

  it("publishes Delivered when both halves are present", () => {
    const r = completed({ delivered_at: "2026-08-24T09:00:00Z", verification_url: "https://checklist.example/r/1" });
    expect(clientStatus(r)).toBe("Delivered");
    expect(isDelivered(r)).toBe(true);
  });

  it("treats empty strings as absent, not as a tick", () => {
    expect(isDelivered(completed({ delivered_at: "", verification_url: "https://c.example/1" }))).toBe(false);
    expect(isDelivered(completed({ delivered_at: "2026-08-24T09:00:00Z", verification_url: "" }))).toBe(false);
  });
});

describe("clientView — the projection, and what it refuses to carry", () => {
  it("shows the client their own words, their own timestamp, and the mapped status", () => {
    const v = clientView(req({ status: "working" }));
    expect(v).toEqual({
      id: "q1", status: "In progress",
      body: "the booking page feels slow on my phone",
      submittedAt: "2026-08-20T10:00:00Z", verificationUrl: null,
    });
  });

  it("never carries fleet mechanics — no issue number, no internal word, no completion time", () => {
    const v = clientView(req({ status: "working", issue_number: 42 }))!;
    const json = JSON.stringify(v);
    expect(json).not.toContain("42");
    expect(json).not.toContain("working");
    expect(json).not.toContain("submitted_by");
    // No completedAt anywhere: the gap between submission and completion is
    // exactly what the operator's client-facing rules say never to reveal.
    expect(Object.keys(v).sort()).toEqual(["body", "id", "status", "submittedAt", "verificationUrl"]);
  });

  it("attaches the verification link only on Delivered", () => {
    const url = "https://checklist.example/r/1";
    expect(clientView(req({ status: "working", verification_url: url }))!.verificationUrl).toBeNull();
    expect(clientView(req({ status: "completed", verification_url: url }))!.verificationUrl).toBeNull();
    expect(clientView(req({
      status: "completed", verification_url: url, delivered_at: "2026-08-24T09:00:00Z",
    }))!.verificationUrl).toBe(url);
  });

  it("returns null rather than an empty shell for anything that publishes nothing", () => {
    expect(clientView(req({ status: "failed" }))).toBeNull();
    expect(clientView(req({ status: "canceled" }))).toBeNull();
  });

  it("tolerates a row with no body", () => {
    expect(clientView(req({ body: null }))!.body).toBe("");
  });
});

describe("clientViews — the portal list", () => {
  it("drops what publishes nothing and keeps the rest in order", () => {
    const rows = [
      req({ id: "a", status: "submitted" }),
      req({ id: "b", status: "failed" }),
      req({ id: "c", status: "working" }),
      req({ id: "d", status: "canceled" }),
      req({ id: "e", status: "completed", delivered_at: "2026-08-24T09:00:00Z", verification_url: "https://c.example/e" }),
    ];
    expect(clientViews(rows).map((v) => [v.id, v.status])).toEqual([
      ["a", "Received"], ["c", "In progress"], ["e", "Delivered"],
    ]);
  });
});
