// apps/fleet/test/bun/junior-stats-unit.test.ts
// Issue #366: sweep-4 F6 — the Worker read behind `fleet junior stats` as a
// tagged result, injectable so the merge/print/soft-fail policy is testable
// without spawning the CLI. The end-to-end subprocess lane stays in
// junior-stats-cli.test.ts, untouched — this is the unit seam underneath it.
// bun:test file like every other test/bun/*.ts — cli/junior.ts deliberately
// has no bun-only globals, so it loads here (same reason junior-local-cli
// .test.ts can import it).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchJuniorUsage, cmdJuniorStats, formatJuniorStats, type JuniorUsageFetch } from "../../cli/junior";
import { juniorUsageLogPath } from "../../../../skills/junior/src/usage";

const CREDS = { workerUrl: "http://127.0.0.1:1", accessClientId: "id", accessClientSecret: "secret" } as const;

// The fake is one round trip: answer with a body, or throw. Anything else
// (wrong URL, wrong headers, wrong method) fails the test — the seam must
// carry exactly what the real fetch carries, or the fake proves nothing.
function fakeFetch(answers: Array<{ ok?: boolean; status?: number; body: string } | Error>): {
  doFetch: JuniorUsageFetch; calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const doFetch: JuniorUsageFetch = async (url, init) => {
    calls.push({ url, init });
    const a = answers[i++] ?? new Error("unexpected extra fetch");
    if (a instanceof Error) throw a;
    return new Response(a.body, { status: a.ok === false ? (a.status ?? 500) : (a.status ?? 200) });
  };
  return { doFetch, calls };
}

const WORKER_BODY = JSON.stringify({
  rows: [{ studioId: "pilot--acme-x", calls: 3, inputTokens: 100, outputTokens: 50 }],
  totals: { calls: 3, inputTokens: 100, outputTokens: 50 },
});

describe("fetchJuniorUsage", () => {
  test("ok: maps the Worker aggregate to JuniorStatsRow[]", async () => {
    const { doFetch, calls } = fakeFetch([{ body: WORKER_BODY }]);
    const r = await fetchJuniorUsage(CREDS, 0, doFetch);
    expect(r).toEqual({
      ok: true,
      rows: [{ id: "pilot--acme-x", calls: 3, inputTokens: 100, outputTokens: 50 }],
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/studio/junior/usage?since=0");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBe("id");
    expect(headers["CF-Access-Client-Secret"]).toBe("secret");
  });

  test("non-ok: tagged {ok:false,status,message}, never thrown, never exiting", async () => {
    const { doFetch } = fakeFetch([{ ok: false, status: 503, body: "upstream unavailable" }]);
    const r = await fetchJuniorUsage(CREDS, 0, doFetch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.message).toContain("503");
      expect(r.message).toContain("upstream unavailable");
    }
  });

  test("fetch throws (network down): tagged {ok:false,status:0,message}, never propagates", async () => {
    const { doFetch } = fakeFetch([new Error("ECONNREFUSED")]);
    const r = await fetchJuniorUsage(CREDS, 0, doFetch);
    expect(r).toEqual({ ok: false, status: 0, message: "ECONNREFUSED" });
  });

  test("sinceMs lands in the query string encoded", async () => {
    const { doFetch, calls } = fakeFetch([{ body: JSON.stringify({ rows: [], totals: { calls: 0, inputTokens: 0, outputTokens: 0 } }) }]);
    await fetchJuniorUsage(CREDS, 1770000000000, doFetch);
    expect(calls[0].url).toBe("http://127.0.0.1:1/studio/junior/usage?since=1770000000000");
  });
});

describe("cmdJuniorStats (injected fetch)", () => {
  function homeWithLocalRow(calls: number, inputTokens: number, outputTokens: number) {
    const home = mkdtempSync(join(tmpdir(), "junior-unit-home-"));
    const dir = join(home, ".local", "share", "fleet");
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    // One line per call (readLocalUsage counts lines, never a `calls` field),
    // so the tokens are split to sum to the totals — same aggregate shape as
    // the characterization lane's 10/20 + 5/5 pair.
    const share = (total: number, i: number) => Math.floor(total / calls) + (i < total % calls ? 1 : 0);
    const lines = Array.from({ length: calls }, (_, i) =>
      JSON.stringify({ ts, id: "laptop-a", mode: "edit", model: "glm", input_tokens: share(inputTokens, i), output_tokens: share(outputTokens, i), ok: true }));
    writeFileSync(join(dir, "junior-usage.jsonl"), `${lines.join("\n")}\n`);
    return { home, path: juniorUsageLogPath(home) };
  }

  test("worker rows merge with local rows, TOTAL sums both (exit 0)", async () => {
    const { home } = homeWithLocalRow(2, 15, 25);
    const { doFetch } = fakeFetch([{ body: WORKER_BODY }]);
    const logs: string[] = [];
    const code = await cmdJuniorStats(CREDS, undefined, {
      doFetch, stdout: (l) => logs.push(l), stderr: () => {}, exit: () => { throw new Error("must not exit on worker rows"); },
      home,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/pilot--acme-x\s+3\s+100\s+50/);
    expect(logs.join("\n")).toMatch(/laptop-a\s+2\s+15\s+25/);
    expect(logs.join("\n")).toMatch(/TOTAL\s+5\s+115\s+75/);
    rmSync(home, { recursive: true, force: true });
  });

  test("worker down: local-only table on stdout, warning on stderr, exit 0", async () => {
    const { home } = homeWithLocalRow(1, 10, 20);
    const { doFetch } = fakeFetch([{ ok: false, status: 500, body: "boom" }]);
    const out: string[] = [], err: string[] = [];
    const code = await cmdJuniorStats(CREDS, undefined, {
      doFetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l), exit: () => { throw new Error("soft-fail must not exit"); },
      home,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("laptop-a");
    expect(err.join("\n").toLowerCase()).toContain("fleet-wide stats unavailable");
    // The warning in full, byte-for-byte: a soft-fail line drifting (wrong
    // status shape, dropped "showing local-only", reworded prefix) must fail
    // here, not just somewhere downstream of a loose lowercase prefix match.
    expect(err[0]).toBe("fleet junior stats: fleet-wide stats unavailable (HTTP 500: boom) — showing local-only");
    rmSync(home, { recursive: true, force: true });
  });

  test("fetch throws: same soft-fail shape as non-ok", async () => {
    const { home } = homeWithLocalRow(1, 1, 1);
    const { doFetch } = fakeFetch([new Error("ECONNREFUSED")]);
    const out: string[] = [], err: string[] = [];
    const code = await cmdJuniorStats(CREDS, undefined, {
      doFetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l), exit: () => { throw new Error("soft-fail must not exit"); },
      home,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("laptop-a");
    expect(err.join("\n").toLowerCase()).toContain("fleet-wide stats unavailable");
    expect(err.join("\n")).toContain("ECONNREFUSED");
    rmSync(home, { recursive: true, force: true });
  });

  test("bad --since: usage error on stderr, exit 1, fetch never called", async () => {
    const { home } = homeWithLocalRow(1, 1, 1);
    const out: string[] = [], err: string[] = [];
    let fetches = 0;
    const code = await cmdJuniorStats(CREDS, "not-a-duration", {
      doFetch: async () => { fetches++; throw new Error("unreachable"); }, stdout: (l) => out.push(l), stderr: (l) => err.push(l),
      exit: (c) => { if (c !== 1) throw new Error("usage error must exit 1"); },
      home,
    });
    expect(code).toBe(1);
    expect(fetches).toBe(0);
    expect(err.length).toBeGreaterThan(0);
    rmSync(home, { recursive: true, force: true });
  });

  test("--since 24h against a pinned clock: local rows older than the cutoff drop", async () => {
    const home = mkdtempSync(join(tmpdir(), "junior-unit-home-"));
    const dir = join(home, ".local", "share", "fleet");
    mkdirSync(dir, { recursive: true });
    const dayMs = 24 * 60 * 60 * 1000;
    const hourMs = 60 * 60 * 1000;
    // Written at now()-2h and now()-30d: only the recent line survives the
    // `--since 24h` cutoff (2h >= cutoff; 30d < it), and the cutoff is only
    // reproducible because `now` is pinned — the real clock would move under
    // the test. This is the one place the now seam is actually exercised;
    // every other cmdJuniorStats test leaves it out.
    const nowMs = 1770000000000;
    const row = (ts: number) => `${JSON.stringify({ ts, id: "laptop-a", mode: "edit", model: "glm", input_tokens: 5, output_tokens: 5, ok: true })}\n`;
    writeFileSync(join(dir, "junior-usage.jsonl"), row(nowMs - 2 * hourMs) + row(nowMs - 30 * dayMs));
    const { doFetch } = fakeFetch([{ body: JSON.stringify({ rows: [], totals: { calls: 0, inputTokens: 0, outputTokens: 0 } }) }]);
    const out: string[] = [];
    const code = await cmdJuniorStats(CREDS, "24h", {
      doFetch, stdout: (l) => out.push(l), stderr: () => {}, exit: () => { throw new Error("must not exit"); },
      now: () => nowMs, home,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/laptop-a\s+1\s+5\s+5/);
    expect((out.join("\n").match(/laptop-a/g) ?? []).length).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });
});

// Issue #399 (sweep-5 F1): byte-exact characterization pins of
// formatJuniorStats, written BEFORE the formatColumns fold. Two ids with
// different digit lengths (2 vs 12 calls, 100 vs 12345 input tokens) so
// column-width alignment is fully exercised, plus the TOTAL row. Any width
// or gap change in the shared builder shows up here first.
describe("formatJuniorStats — exact bytes (#399)", () => {
  const ROWS = [
    { id: "a", calls: 2, inputTokens: 100, outputTokens: 50 },
    { id: "b", calls: 12, inputTokens: 12345, outputTokens: 6789 },
  ];

  test("header, both rows, and the TOTAL row: every byte of the table", () => {
    expect(formatJuniorStats(ROWS)).toBe(
      "ID     CALLS  INPUT TOKENS  OUTPUT TOKENS\n" +
      "a      2      100           50\n" +
      "b      12     12345         6789\n" +
      "TOTAL  14     12445         6839",
    );
  });

  // The drift this fold cites: pre-fold code padded EVERY column then
  // trimEnded each line, so the #205 rule lived in the trimEnd, not in the
  // table. These bytes prove the equivalence: pad-every-column-then-trimEnd
  // leaves the same bytes as never padding the last column — the fold
  // (default: last column never padded) must keep every line identical.
  test("no line ends in whitespace (pad-every-column-then-trimEnd produces the same bytes as never padding the last column)", () => {
    for (const line of formatJuniorStats(ROWS).split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });
});
