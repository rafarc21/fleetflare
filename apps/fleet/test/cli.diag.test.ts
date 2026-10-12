import { describe, expect, it } from "vitest";
import { errText, decodeBody } from "../cli/diag";

// Issue #400 (sweep-5 finding F2, parent #394): one shared cli/diag.ts for
// the two shapes every CLI error path re-writes — `err instanceof Error ?
// err.message : String(err)` (30 sites across 10 cli files; ff.ts and
// accounts.ts had already named theirs errText) and the "decode a Worker
// error body" dance (HTML <title> else JSON .error else plain slice, held
// today by repair-failure.ts and inspect-request.ts). Golden table: every
// case answers for both of today's copies at once, so a migrating call
// site diffs against this table instead of re-deriving the behavior.

describe("errText — an unknown catch, as one line", () => {
  it("an Error yields its message", () => {
    expect(errText(new Error("boom"))).toBe("boom");
  });

  it("a thrown plain string is itself", () => {
    expect(errText("nope")).toBe("nope");
  });

  // The contract for everything else is exactly `String(err)` — a handler
  // whose whole job is reporting a failure must never fail at its own
  // reporting, whatever the caught value turns out to be.
  it("a non-Error object yields its String form", () => {
    expect(errText({ weird: true })).toBe(String({ weird: true }));
  });

  it("undefined yields the string \"undefined\"", () => {
    expect(errText(undefined)).toBe("undefined");
  });
});

describe("decodeBody — a non-2xx Worker body, as the detail of one line", () => {
  // A Cloudflare error page (e.g. 1101 "Worker threw exception") is a whole
  // HTML document; its <title> is the only part worth a terminal line —
  // both of today's copies kept this regex for exactly that reason.
  it("a Cloudflare HTML error page reduces to its trimmed <title>", () => {
    const html = "<!DOCTYPE html><html><head><title>Worker threw exception | example.workers.dev | Cloudflare</title></head><body>" +
      "Error 1101 " + "x".repeat(5000) + "</body></html>";
    expect(decodeBody(500, html, 2000)).toBe("Worker threw exception | example.workers.dev | Cloudflare");
  });

  // A <title> that trims to "" is no detail at all — the body that carried
  // it is the next best answer, not an empty line.
  it("an HTML body with an empty <title> falls through to the raw-text branch", () => {
    expect(decodeBody(500, "<title></title>the container did not answer an 8s probe", 2000))
      .toBe("<title></title>the container did not answer an 8s probe");
  });

  // Issue #217: the 409 refusal (routes.ts's launchOrStartRefusalResponse)
  // answers `{"error": "<reason>"}` — without this branch the operator
  // reads the raw JSON blob, braces and quoting included, instead of the
  // reason itself.
  it("a JSON {error} body yields the reason, not the raw JSON", () => {
    expect(decodeBody(409, JSON.stringify({ error: "refused: reason" }), 2000)).toBe("refused: reason");
  });

  // #217 review round 2: `.error` can carry redacted container stderr, so
  // the cap must reach this branch too, not only the plain-text fallback.
  it("a long JSON .error is capped at maxChars", () => {
    const reason = "x".repeat(1000);
    expect(decodeBody(409, JSON.stringify({ error: reason }), 300)).toBe(reason.slice(0, 300));
  });

  it("a JSON body with no string .error falls through to the raw-text branch, trimmed", () => {
    expect(decodeBody(500, '  {"ok": false}  ', 2000)).toBe('{"ok": false}');
  });

  it("plain text is trimmed and capped at maxChars", () => {
    expect(decodeBody(503, "  " + "y".repeat(1000), 300)).toBe("y".repeat(300));
  });

  it("an empty body is an empty detail — no placeholder invented", () => {
    expect(decodeBody(502, "", 2000)).toBe("");
  });

  // `status` is accepted and never used in the return: the label and the
  // exit/throw policy stay at the call site (repair-failure.ts prefixes
  // `${label}: ${status} ...`, inspect-request.ts frames `HTTP ${status}`),
  // and taking the status keeps every call site reading uniformly — one
  // decoder invoked as decodeBody(res.status, text, cap) wherever a body is
  // read next to its status.
  it("the status never leaks into the detail — same body, same answer at any status", () => {
    expect(decodeBody(500, "provision refused", 2000)).toBe("provision refused");
    expect(decodeBody(409, "provision refused", 2000)).toBe("provision refused");
  });
});
