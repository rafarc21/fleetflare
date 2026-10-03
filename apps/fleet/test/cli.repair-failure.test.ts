import { describe, it, expect } from "vitest";
import { repairFailureLine, destroyPath } from "../cli/repair-failure";

describe("destroyPath — the flags ride recycle's own query names (#129)", () => {
  it("maps each flag combination", () => {
    expect(destroyPath(false, false)).toBe("/destroy");
    expect(destroyPath(true, false)).toBe("/destroy?force=true");
    expect(destroyPath(false, true)).toBe("/destroy?discard-unsynced=true");
    expect(destroyPath(true, true)).toBe("/destroy?force=true&discard-unsynced=true");
  });
});

// Issue #96: every repair verb printed `${status} ${text.slice(0, 300)}`. The
// side-naming line and the recycle refusal are both longer than 300 chars,
// and the part that got cut was the fallback — the only actionable half.
describe("repairFailureLine — a repair verb's failure, printed whole", () => {
  it("keeps a long route message intact, fallback and all", () => {
    const text = "recycle failed: the Durable Object did not answer: Network connection lost. (retryable=true). " +
      "Every repair verb goes through it, so retrying cannot help. " +
      "On 2026-09-24 this self-healed in ~20 min. Watch CHECKED in fleet ls; wait.";
    expect(text.length).toBeGreaterThan(200);
    const line = repairFailureLine("recycle", 503, "x".repeat(200) + text);
    expect(line).toContain("Watch CHECKED in fleet ls; wait.");
    expect(line.startsWith("fleet recycle: 503 ")).toBe(true);
  });

  it("a Cloudflare HTML error page is reduced to its <title>, and named as the Worker side", () => {
    const html = "<!DOCTYPE html><html><head><title>Worker threw exception | example.workers.dev | Cloudflare</title></head><body>" +
      "x".repeat(5000) + "</body></html>";
    const line = repairFailureLine("provision", 500, html);
    expect(line).toBe(
      "fleet provision: 500 Worker threw exception | example.workers.dev | Cloudflare " +
        "(a Cloudflare error page: the Worker threw — this page does not say which side failed)",
    );
  });

  it("still bounds a pathological body", () => {
    expect(repairFailureLine("destroy", 500, "y".repeat(100_000)).length).toBeLessThan(2100);
  });

  // Issue #217: provision/restart/recycle's new 409 refusal (routes.ts's
  // launchOrStartRefusalResponse) answers `{"error": "<reason>"}` — without
  // this branch the operator read the raw JSON blob, braces and quoting
  // included, instead of the reason itself.
  it("a JSON {error} body (the new #217 409 refusal shape) prints the reason, not the raw JSON", () => {
    const body = JSON.stringify({ error: "claude account: every account limited; earliest reset 2026-10-03T12:00:00.000Z" });
    const line = repairFailureLine("provision", 409, body);
    expect(line).toBe(
      "fleet provision: 409 claude account: every account limited; earliest reset 2026-10-03T12:00:00.000Z",
    );
    expect(line).not.toContain("{");
    expect(line).not.toContain("}");
  });

  it("a JSON body without a string .error falls through to the raw-text branch", () => {
    const line = repairFailureLine("check", 500, JSON.stringify({ ok: false }));
    expect(line).toBe(`fleet check: 500 ${JSON.stringify({ ok: false })}`);
  });

  it("non-JSON text (every other verb's body today) is unaffected by the new branch", () => {
    const line = repairFailureLine("recycle", 409, "recycle refused: the container did not answer an 8s probe.");
    expect(line).toBe("fleet recycle: 409 recycle refused: the container did not answer an 8s probe.");
  });
});

describe("discardNote — what --discard-unsynced just paid", () => {
  it("names the flag, the loss, and that the refusal was bypassed on purpose", async () => {
    const { discardNote } = await import("../cli/repair-failure");
    const note = discardNote("demosite-life--web-studio");
    expect(note).toContain("--discard-unsynced");
    expect(note).toContain("demosite-life--web-studio");
    expect(note).toContain("discarded");
    expect(note).toContain("last synced snapshot");
  });
});
