import { describe, expect, it } from "vitest";
import { requestInspect, renderInspect, formatSessionForceArmedLine, INSPECT_CLIENT_TIMEOUT_MS } from "../cli/inspect-request";
import { INSPECT_EXEC_MS } from "../src/studio/inspect";

// Board #91. cli/inspect-request.ts, not cli/fleet.ts — same Bun-global
// reason test/cli.fleet.test.ts's header gives for importing
// cli/fleet-totals.ts directly.

const hangUntilAborted: typeof fetch = (_input, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  });

describe("requestInspect — fleet inspect's one HTTP round trip", () => {
  it("gives up on a Worker that never answers, and says the Worker is the silent side", async () => {
    // Measured 2026-09-24: the bare fetch had no timeout, so the third
    // attempt hung past the caller's own 600s budget.
    const out = await requestInspect("https://x/studio/a--b/inspect", {}, { fetchImpl: hangUntilAborted, timeoutMs: 20 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("Worker did not answer");
  });

  it("turns a Cloudflare HTML error page into its title, naming the Worker side — never raw HTML", async () => {
    const html = "<!DOCTYPE html><html><head><title>Worker threw exception | example-org.demosite.workers.dev | Cloudflare</title></head><body>Error 1101</body></html>";
    const fetchImpl: typeof fetch = async () => new Response(html, { status: 500, headers: { "content-type": "text/html" } });
    const out = await requestInspect("https://x/studio/a--b/inspect", {}, { fetchImpl });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("HTTP 500");
      expect(out.message).toContain("Worker threw exception");
      expect(out.message).toContain("Worker/Durable Object");
      expect(out.message).not.toContain("<html");
    }
  });

  it("hands back the parsed JSON body on a 200", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ ok: false, error: "refused: stopped" });
    const out = await requestInspect("https://x/studio/a--b/inspect", {}, { fetchImpl });
    expect(out).toEqual({ ok: true, body: { ok: false, error: "refused: stopped" } });
  });

  it("waits longer than the DO's own container deadline, so the container's named failure arrives first", () => {
    expect(INSPECT_CLIENT_TIMEOUT_MS).toBeGreaterThan(INSPECT_EXEC_MS + 5_000);
  });
});

// #151: never a tail without its age. A frozen screen read as live misled two
// coordinators for 20+ minutes.
describe("renderInspect — the tail always carries its capture time", () => {
  const body = { ok: true as const, checkoutExists: true, paneCommand: "claude", tail: "last line\n" };
  const now = Date.parse("2026-09-24T17:50:07Z");

  it("prints the capture time and its age before the tail", () => {
    const out = renderInspect({ ...body, capturedAt: Date.parse("2026-09-24T17:50:00Z") / 1000 }, now);
    expect(out.ok).toBe(true);
    const text = out.lines.join("\n");
    expect(text).toContain("captured 17:50:00Z (age 7s)");
    expect(text.indexOf("captured")).toBeLessThan(text.indexOf("last line"));
  });

  it("refuses to print a tail with no capture time", () => {
    const out = renderInspect({ ...body }, now);
    expect(out.ok).toBe(false);
    expect(out.lines.join("\n")).not.toContain("last line");
    expect(out.lines.join("\n")).toContain("no capture time");
  });
});

// Issue #228 item 5: an armed force-next-sync override was previously
// invisible on `fleet inspect` too — do.ts's inspect() DO method mirrors
// StudioStatus.sessionForceArmedAt onto the response body.
//
// Issue #228 HOLD fix, item 4: the line itself moved OUT of renderInspect
// and into this standalone, pure formatter — cmdInspect (cli/fleet.ts) now
// calls it BEFORE the `!body.ok` early exit, the same "formatObservedLines,
// called before the ok-check" shape readiness-format.ts already established
// — so an `ok: false` inspect (a stopped studio, a container exec failure)
// shows an armed override too, instead of never reaching the renderInspect
// call that used to be the only place this printed.
describe("formatSessionForceArmedLine (issue #228 items 4 and 5)", () => {
  it("a string (armed) prints one line naming the timestamp", () => {
    expect(formatSessionForceArmedLine("2026-09-24T10:00:00.000Z"))
      .toEqual(["session guard: force-next-sync armed since 2026-09-24T10:00:00.000Z"]);
  });

  it("null (not armed) prints nothing", () => {
    expect(formatSessionForceArmedLine(null)).toEqual([]);
  });

  it("undefined (a Worker older than issue #228 item 5) prints nothing", () => {
    expect(formatSessionForceArmedLine(undefined)).toEqual([]);
  });
});

describe("renderInspect — no longer renders the armed-override line itself (issue #228 HOLD fix, item 4)", () => {
  const body = { ok: true as const, checkoutExists: true, paneCommand: "claude", tail: "last line\n", capturedAt: 1_758_735_007 };

  it("an armed override on the body is not printed by renderInspect — formatSessionForceArmedLine owns that line now", () => {
    const out = renderInspect({ ...body, sessionForceArmedAt: "2026-09-24T10:00:00.000Z" }, Date.parse("2026-09-24T17:50:07Z"));
    expect(out.lines.join("\n")).not.toContain("session guard");
  });
});
