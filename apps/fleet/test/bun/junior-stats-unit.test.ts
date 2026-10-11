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
import { fetchJuniorUsage, cmdJuniorStats, type JuniorUsageFetch } from "../../cli/junior";
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
      now: () => 0, home,
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
      now: () => 0, home,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("laptop-a");
    expect(err.join("\n").toLowerCase()).toContain("fleet-wide stats unavailable");
    rmSync(home, { recursive: true, force: true });
  });

  test("fetch throws: same soft-fail shape as non-ok", async () => {
    const { home } = homeWithLocalRow(1, 1, 1);
    const { doFetch } = fakeFetch([new Error("ECONNREFUSED")]);
    const out: string[] = [], err: string[] = [];
    const code = await cmdJuniorStats(CREDS, undefined, {
      doFetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l), exit: () => { throw new Error("soft-fail must not exit"); },
      now: () => 0, home,
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
      now: () => 0, home,
    });
    expect(code).toBe(1);
    expect(fetches).toBe(0);
    expect(err.length).toBeGreaterThan(0);
    rmSync(home, { recursive: true, force: true });
  });
});
