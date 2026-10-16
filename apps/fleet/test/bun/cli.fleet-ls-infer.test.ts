// Issue #934, plan step 3 ("CLI wiring"): `fleet ls`'s INFER column — how
// many lead-inference calls each studio made in the last 30 min and how many
// of them returned ok, read from the batched GET /studio/junior/usage/lead
// route (plan step 1, already merged on this branch). A GLM/kimi/deepseek-led
// studio blocked on Workers AI 429/5xx reads `running` with every number
// frozen — silence looks like progress, and the issue's own origin story is
// one studio making 0 output for 5h while nobody saw it.
//
// Model: test/bun/cli.fleet-ls-prs.test.ts (the PRS column's own suite) for
// the pure formatTable half, the injected-fetch half, and the Bun.serve
// cmdLs stand-in — this file is that suite's shape, one column later.
//
// The pure half (formatInfer/isLeadInferenceBlocked) lives in cli/infer-format.ts,
// deliberately Bun/node-free (see that file's own header), so BOTH test pools
// could import it; the pins live HERE because the PRS precedent does — one
// column's contract in one place.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cmdLs, fetchLeadInferUsage, formatTable, type Credentials } from "../../cli/fleet";
import { lsJsonRows } from "../../cli/readiness-format";
import {
  formatInfer, isLeadInferenceBlocked, INFER_WINDOW_MS,
  type LeadInferUsage,
} from "../../cli/infer-format";
import type { OrcaDeps } from "../../cli/orca-workspace";
import type { StudioStatus } from "../../src/studio/types";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const CREDS: Credentials = { workerUrl: "http://127.0.0.1:1", accessClientId: "cid", accessClientSecret: "csecret" };

function row(overrides: Partial<StudioStatus> = {}, id = "websites--web-studio"): StudioStatus {
  return {
    id, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null, ...overrides,
  };
}

/** The INFER cell of one rendered table line, by header position. */
function inferCell(header: string, line: string): string {
  return line.split(/\s{2,}/)[header.split(/\s{2,}/).indexOf("INFER")];
}

/** The READY cell of one rendered table line, by header position. */
function readyCell(header: string, line: string): string {
  return line.split(/\s{2,}/)[header.split(/\s{2,}/).indexOf("READY")];
}

/** formatTable's header and row lines, split apart. */
function tableLines(out: string): string[] {
  return out.split("\n");
}

describe("fleet ls table — INFER column (#934)", () => {
  test("has an INFER column between ACTIVITY and CHECKED", () => {
    const [header] = tableLines(formatTable([row()], NOW));
    const cols = header.split(/\s{2,}/);
    expect(cols).toContain("INFER");
    expect(cols.indexOf("INFER")).toBe(cols.indexOf("ACTIVITY") + 1);
    expect(cols.indexOf("CHECKED")).toBe(cols.indexOf("INFER") + 1);
  });

  test("no map at all (single-studio views, or a route that never answered): the cell reads '-'", () => {
    const [header, line] = tableLines(formatTable([row()], NOW));
    expect(inferCell(header, line)).toBe("-");
  });

  test("a covered studio renders '<ok>/<calls> <pct>%'; a 100% ok-rate renders '100%', never a bare '48/48'", () => {
    const map = new Map<string, LeadInferUsage>([
      ["websites--web-studio", { calls: 48, ok: 12 }],
      ["beta--pilot", { calls: 48, ok: 48 }],
    ]);
    const [header, ...lines] = tableLines(formatTable([
      row({ id: "websites--web-studio" }),
      row({ id: "beta--pilot" }),
    ], NOW, null, undefined, map));
    expect(inferCell(header, lines[0])).toBe("12/48 25%");
    expect(inferCell(header, lines[1])).toBe("48/48 100%");
  });

  // The route can only answer a row for a studio that HAS lead rows, but a
  // 0-call aggregate must still never divide by zero into "NaN%" — the cell
  // degrades to the same '-' an unanswered studio reads, rather than
  // printing a figure that cannot be a figure.
  test("a 0-call row renders '-', never '0/0 NaN%'", () => {
    const [header, line] = tableLines(formatTable([row()], NOW, null, undefined, new Map([["websites--web-studio", { calls: 0, ok: 0 }]])));
    expect(inferCell(header, line)).toBe("-");
  });

  test("a studio the map does not cover reads '-' — 'could not look' never reads as 0/0", () => {
    const [header, line] = tableLines(formatTable([row({ id: "beta--pilot" })], NOW, null, undefined, new Map([["websites--web-studio", { calls: 48, ok: 12 }]])));
    expect(inferCell(header, line)).toBe("-");
  });

  // The threshold is the issue's own: >=10 calls AND under 50% ok in the
  // window. The marker APPENDS to the READY cell (the operator already looks
  // there for "this row is lying about being fine") and the underlying
  // verdict still shows — "provisioned inference-blocked", never the marker
  // alone. A null readiness renders "?" (formatReady's own word for "no
  // verdict"), so the pinned cell here is "? inference-blocked".
  test("blocked: >=10 calls under 50% ok — READY reads '<verdict> inference-blocked', the verdict still visible", () => {
    const [header, line] = tableLines(formatTable([row()], NOW, null, undefined, new Map([["websites--web-studio", { calls: 48, ok: 12 }]])));
    expect(readyCell(header, line)).toBe("? inference-blocked");
    expect(line).not.toContain("inference-blocked ?"); // never replaces the verdict
  });

  test("NOT blocked: 9 calls (under the >=10 floor) — no marker anywhere in the line", () => {
    const [, line] = tableLines(formatTable([row()], NOW, null, undefined, new Map([["websites--web-studio", { calls: 9, ok: 1 }]])));
    expect(line).not.toContain("inference-blocked");
  });

  test("NOT blocked: exactly 50% ok — the marker fires only UNDER half, never at it", () => {
    const [header, line48] = tableLines(formatTable([row()], NOW, null, undefined, new Map([["websites--web-studio", { calls: 48, ok: 24 }]])));
    expect(line48).not.toContain("inference-blocked");
    expect(inferCell(header, line48)).toBe("24/48 50%");
    const [, line20] = tableLines(formatTable([row()], NOW, null, undefined, new Map([["websites--web-studio", { calls: 20, ok: 10 }]])));
    expect(line20).not.toContain("inference-blocked");
  });

  // The old call shape: formatTable's single-studio call sites (cmdCheck,
  // cmdSpawn, cmdInspect…) pass at most orca rows — no map, cell '-'.
  test("a table that passes ONLY orca rows (the old call shape) still renders, INFER reads '-'", () => {
    const [header, line] = tableLines(formatTable([row()], NOW, new Map([["websites--web-studio", "open"]])));
    expect(header).toContain("INFER");
    expect(inferCell(header, line)).toBe("-");
  });
});

describe("fetchLeadInferUsage — the fetch behind the column (#934)", () => {
  /** Records every request, answers from a scripted array — junior-stats-unit
   *  .test.ts's own fakeFetch shape: one answer per fetch, anything else
   *  fails the test, so the seam must carry exactly what the real fetch
   *  carries or the fake proves nothing. */
  function fakeFetch(answers: Array<{ ok?: boolean; status?: number; body: string } | Error>): {
    fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      const a = answers[i++] ?? new Error("unexpected extra fetch");
      if (a instanceof Error) throw a;
      return new Response(a.body, { status: a.ok === false ? (a.status ?? 500) : (a.status ?? 200) });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  // A pinned now, so since=<nowMs - 30min> is a pinned string too — the
  // window is INFER_WINDOW_MS by construction, and 1770000000000 - 30min is
  // 1769998200000.
  const NOW_MS = 1770000000000;

  test("one GET to the lead-usage route, since=now-30min encoded, Access headers + explicit JSON Accept", async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: JSON.stringify({ rows: [] }) }]);
    await fetchLeadInferUsage(CREDS, NOW_MS, fetchImpl);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`http://127.0.0.1:1/studio/junior/usage/lead?since=${NOW_MS - INFER_WINDOW_MS}`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBe("cid");
    expect(headers["CF-Access-Client-Secret"]).toBe("csecret");
    expect(headers["Accept"]).toBe("application/json");
  });

  test("the fetch carries its own 10s deadline — a hung read degrades, never hangs ls", async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: JSON.stringify({ rows: [] }) }]);
    await fetchLeadInferUsage(CREDS, NOW_MS, fetchImpl);
    expect(calls[0].init.signal instanceof AbortSignal).toBe(true);
  });

  test("a 200 body maps rows to a studio-id -> {calls, ok} map", async () => {
    const { fetchImpl } = fakeFetch([{
      body: JSON.stringify({ rows: [{ studioId: "websites--web-studio", calls: 48, ok: 12 }, { studioId: "beta--pilot", calls: 3, ok: 3 }] }),
    }]);
    const r = await fetchLeadInferUsage(CREDS, NOW_MS, fetchImpl);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.by.get("websites--web-studio")).toEqual({ calls: 48, ok: 12 });
    expect(r.by.get("beta--pilot")).toEqual({ calls: 3, ok: 3 });
  });

  test("a 404 (a Worker that predates the route) is a tagged miss naming the status, never a thrown error", async () => {
    const { fetchImpl } = fakeFetch([{ ok: false, status: 404, body: "not found" }]);
    const r = await fetchLeadInferUsage(CREDS, NOW_MS, fetchImpl);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("404");
  });

  test("a fetch that throws is the same tagged miss, never a rejection", async () => {
    const { fetchImpl } = fakeFetch([new Error("ECONNREFUSED")]);
    const r = await fetchLeadInferUsage(CREDS, NOW_MS, fetchImpl);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("ECONNREFUSED");
  });
});

describe("cmdLs — the wiring (#934)", () => {
  const STUDIO: StudioStatus = row({ id: "websites--web-studio" });
  let inferAnswer: Response;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/studio/") return Response.json([STUDIO]);
        if (u.pathname === "/studio/junior/usage/lead") return inferAnswer;
        // /studio/accounts, /studio/board/open-prs and everything else: a
        // route this stand-in does not serve 404s — best-effort callers
        // must sail past that.
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  /** Outside Orca (the prs suite's own fixture): no Orca call is attempted. */
  const NOT_UNDER_ORCA: OrcaDeps = {
    env: { TERM_PROGRAM: "Apple_Terminal" },
    hasBinary: () => "orca",
    registry: { get: () => undefined, set: async () => {} },
    log: () => {},
    run: async () => { throw new Error("no orca call expected"); },
    lock: (_id, fn) => fn(),
  };

  /** Captures stdout lines (the table/json) AND stderr lines (the warnings),
   *  so a test can assert on both halves of one run. */
  async function ls(json = false): Promise<{ out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { err.push(args.join(" ")); };
    try {
      await cmdLs({ workerUrl: server.url.toString(), accessClientId: "", accessClientSecret: "" }, false, NOT_UNDER_ORCA, json, false);
    } finally {
      console.log = realLog;
      console.error = realError;
    }
    // Each printed chunk can be a whole multi-line block (the table is ONE
    // console.log) — flatten to lines so header/row matching is per line.
    return { out: out.flatMap((l) => l.split("\n")), err };
  }

  test("the route's answer renders in the INFER cell", async () => {
    inferAnswer = Response.json({ rows: [{ studioId: "websites--web-studio", calls: 48, ok: 12 }] });
    const { out } = await ls();
    const header = out.find((l) => l.split(/\s{2,}/).includes("INFER"));
    const table = out.find((l) => l.includes("websites--web-studio"));
    expect(header).toBeDefined();
    expect(table).toBeDefined();
    expect(inferCell(header!, table!)).toBe("12/48 25%");
  });

  test("a route that 404s: cells '-', ONE stderr degrade line, the table still prints", async () => {
    inferAnswer = new Response("not found", { status: 404 });
    const { out, err } = await ls();
    const header = out.find((l) => l.split(/\s{2,}/).includes("INFER"));
    const table = out.find((l) => l.includes("websites--web-studio"));
    expect(header).toBeDefined();
    expect(table).toBeDefined();
    expect(inferCell(header!, table!)).toBe("-");
    // Exactly one line, and stdout stays machine-clean — the warning is
    // console.error, never a table interruption.
    expect(err.filter((l) => l.startsWith("fleet ls: lead inference status unavailable"))).toHaveLength(1);
    // The rest of stderr (if any) is not this feature's.
    expect(err.filter((l) => l.includes("inference"))).toHaveLength(1);
  });

  test("--json with the route answering: each row carries infer: {calls, ok}", async () => {
    inferAnswer = Response.json({ rows: [{ studioId: "websites--web-studio", calls: 48, ok: 12 }] });
    const { out } = await ls(true);
    const parsed = JSON.parse(out.join("")) as Array<{ id: string; infer?: { calls: number; ok: number } }>;
    expect(parsed[0].id).toBe("websites--web-studio");
    expect(parsed[0].infer).toEqual({ calls: 48, ok: 12 });
  });

  test("--json with the route 404ing: no infer key at all — 'no data' must not read as 0/0", async () => {
    inferAnswer = new Response("not found", { status: 404 });
    const { out } = await ls(true);
    const parsed = JSON.parse(out.join("")) as Array<{ id: string; infer?: { calls: number; ok: number } }>;
    expect(parsed[0].id).toBe("websites--web-studio");
    expect(Object.hasOwn(parsed[0], "infer")).toBe(false);
  });
});

describe("lsJsonRows — the infer decoration (#934)", () => {
  test("a map entry rides the row as infer: {calls, ok}; a studio the map does not cover carries no key", () => {
    const rows = lsJsonRows([
      row({ id: "websites--web-studio" }),
      row({ id: "beta--pilot" }),
    ], NOW, undefined, undefined, new Map([["websites--web-studio", { calls: 48, ok: 12 }]]));
    expect(rows[0].infer).toEqual({ calls: 48, ok: 12 });
    expect(Object.hasOwn(rows[1], "infer")).toBe(false);
  });

  test("no map passed (a caller predating this feature): unchanged shape, no infer key", () => {
    const rows = lsJsonRows([row()], NOW);
    expect(Object.hasOwn(rows[0], "infer")).toBe(false);
  });
});

// The pure half called DIRECTLY, not through formatTable. The wiring pins
// above prove the column renders these verdicts; these pins prove the
// functions themselves, including the two edges no wiring test reaches:
// the floored percent (47.9% must read 47%, never 48% rounded up — an
// inflated ok-rate is the exact false-clean reading #934 exists to kill)
// and the exact >=10 floor boundary (10 calls fires; the wiring tests only
// prove 9 does not). The constants' values are pinned in the behavior
// describe at the bottom — where they act, not as copied literals. A pure function
// failing here names itself in the failure; failing through formatTable it
// has to be traced first.
describe("formatInfer — pure (#934)", () => {
  test("undefined (no lead rows: Claude-led or idle) renders '-'", () => {
    expect(formatInfer(undefined)).toBe("-");
  });

  test("12 ok of 48 calls renders '12/48 25%'", () => {
    expect(formatInfer({ calls: 48, ok: 12 })).toBe("12/48 25%");
  });

  test("all ok renders '48/48 100%', not a bare '48/48'", () => {
    expect(formatInfer({ calls: 48, ok: 48 })).toBe("48/48 100%");
  });

  test("zero-call row never prints NaN — '-' instead", () => {
    expect(formatInfer({ calls: 0, ok: 0 })).toBe("-");
  });

  test("floored percent, never rounded up: 23/48 (47.9%) renders 47%", () => {
    expect(formatInfer({ calls: 48, ok: 23 })).toBe("23/48 47%");
  });
});

describe("isLeadInferenceBlocked — pure (#934)", () => {
  test("fires at >=10 calls under 50% ok", () => {
    expect(isLeadInferenceBlocked({ calls: 48, ok: 12 })).toBe(true);
    expect(isLeadInferenceBlocked({ calls: 10, ok: 4 })).toBe(true);
  });

  test("under 10 calls never fires, however bad the rate", () => {
    expect(isLeadInferenceBlocked({ calls: 9, ok: 1 })).toBe(false);
    expect(isLeadInferenceBlocked({ calls: 0, ok: 0 })).toBe(false);
  });

  test("exactly 50% ok does NOT fire — the threshold is strictly under", () => {
    expect(isLeadInferenceBlocked({ calls: 48, ok: 24 })).toBe(false);
    expect(isLeadInferenceBlocked({ calls: 20, ok: 10 })).toBe(false);
  });

  test("undefined never fires", () => {
    expect(isLeadInferenceBlocked(undefined)).toBe(false);
  });
});

describe("constants, pinned through behavior (#934)", () => {
  // The window and the threshold exist to be READ by other code (the fetch's
  // since= cutoff, the blocked gate), so this pins them where they act — a
  // literal-to-literal copy of the export would be the tautological shape
  // test-lies-check refuses (and would catch nothing if the value drifted).

  // The fetch describe above pins the WIRING — since = nowMs -
  // INFER_WINDOW_MS, so the route's window and whatever the export says can
  // never drift apart — but that pin stays green through any change to the
  // constant's VALUE. This is the magnitude pin: with now pinned, exactly
  // 30 minutes back is a pinned string too (1770000000000 - 1800000).
  test("the fetch's since= cutoff is exactly 30 minutes back", async () => {
    const NOW_MS = 1770000000000; // the fetch describe's own pinned now
    const calls: Array<{ url: string }> = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push({ url: String(input) });
      return new Response(JSON.stringify({ rows: [] }));
    }) as unknown as typeof fetch;
    await fetchLeadInferUsage(CREDS, NOW_MS, fetchImpl);
    // 30 minutes in ms, spelled as the arithmetic — never the imported
    // constant copied back, which could not catch a drift.
    expect(calls[0].url).toBe(
      `http://127.0.0.1:1/studio/junior/usage/lead?since=${NOW_MS - 30 * 60 * 1000}`,
    );
  });

  // The pure describe above pins the same two calls through the gate
  // function; named here because this is the threshold's own meaning: 9
  // calls says "not trying" (idle or Claude-led), the 10th says "trying
  // and failing" — and only then may the marker speak.
  test("the blocked gate turns on at exactly the 10th call", () => {
    expect(isLeadInferenceBlocked({ calls: 10, ok: 4 })).toBe(true);
    expect(isLeadInferenceBlocked({ calls: 9, ok: 1 })).toBe(false);
  });
});

// Issue #1142, item 2 — READY flags a router-led lead that reads "working"
// yet made 0 router calls in the INFER window (issue #911 ask). Pinned on the
// rendered READY cell, same as the blocked marker above.
describe("fleet ls table — READY inference-silent marker (#1142)", () => {
  const working = (overrides: Partial<StudioStatus> = {}, id = "websites--web-studio"): StudioStatus =>
    row({
      id, leadType: "glm",
      observed: { activity: { state: "working", since: new Date(NOW.getTime() - 10 * 60_000).toISOString(), anchored: true, observedAt: NOW.toISOString() } } as unknown as StudioStatus["observed"],
      ...overrides,
    }, id);

  test("a working router-led row with a map and no entry reads 'inference-silent' in READY", () => {
    const [header, line] = tableLines(formatTable([working()], NOW, null, undefined, new Map()));
    expect(readyCell(header, line)).toContain("inference-silent");
  });

  test("no usage map (route unavailable): no silent marker", () => {
    const [header, line] = tableLines(formatTable([working()], NOW));
    expect(readyCell(header, line)).not.toContain("inference-silent");
  });

  test("a Claude-led working row: no silent marker", () => {
    const [header, line] = tableLines(formatTable([working({ leadType: "claude" })], NOW, null, undefined, new Map()));
    expect(readyCell(header, line)).not.toContain("inference-silent");
  });
});
