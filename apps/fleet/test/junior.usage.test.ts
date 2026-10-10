// apps/fleet/test/junior.usage.test.ts
//
// Issue #218: usage counting for /fleet/junior — one row per call (success
// and failure both), aggregated by studio for the GET /studio/junior/usage
// stats route. Same posture as junior.ratelimit.test.ts: real D1 via
// `cloudflare:test`'s `env.DB`, no mocking of the database.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { insertJuniorUsage, aggregateJuniorUsage, handleJuniorUsageStats } from "../src/junior/usage";
import { handleFleetJunior } from "../src/junior/route";
import { recordJuniorAuthorization } from "../src/junior/authz";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import type { BoardApi } from "../src/board/board";
import { studioLabel, type BoardTask } from "../src/board/types";

const REPO = "acme-org/websites";
const ME = "websites--web-studio";

// Issue #218 finding 1: the usage-log insert is handed to `ctx.waitUntil`
// now (house pattern — github/webhook.ts's `autoCloseOnPromote`,
// exceptions.ts's `pruneWorkerExceptions`), never a bare fire-and-forget
// `void`, so the Workers runtime cannot tear the execution context down
// mid-insert once the response stream closes. Same queue-don't-await fake
// `ctx` shape test/github.webhook.test.ts's and test/exceptions.test.ts's
// own `fakeCtx()` already establish.
function fakeCtx() {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { tasks.push(p); p.catch(() => {}); }),
    passThroughOnException: () => {},
    drain: () => Promise.all(tasks),
  };
  return ctx as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn>; drain: () => Promise<unknown[]> };
}
let ctx: ReturnType<typeof fakeCtx>;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await env.DB.prepare("DELETE FROM junior_usage_log").run();
  ctx = fakeCtx();
});

describe("insertJuniorUsage — failure reason (issue #302)", () => {
  it("stores the error reason on a failed row, NULL on an ok row", async () => {
    await insertJuniorUsage(env.DB, { id: "f1", ts: 1, studioId: ME, mode: "lead", model: "m", inputTokens: 0, outputTokens: 0, ok: false, error: "idle_timeout after 90000ms" });
    await insertJuniorUsage(env.DB, { id: "s1", ts: 2, studioId: ME, mode: "lead", model: "m", inputTokens: 1, outputTokens: 1, ok: true });
    const res = await env.DB.prepare("SELECT id, error FROM junior_usage_log ORDER BY ts").all<{ id: string; error: string | null }>();
    expect(res.results).toEqual([{ id: "f1", error: "idle_timeout after 90000ms" }, { id: "s1", error: null }]);
  });

  it("before migration 0005 lands, a failure row is still counted (retried without the error column)", async () => {
    const sqls: string[] = [];
    const db = {
      prepare(sql: string) {
        sqls.push(sql);
        return {
          bind: () => ({
            run: async () => {
              if (sql.includes("error)")) throw new Error("D1_ERROR: table junior_usage_log has no column named error: SQLITE_ERROR");
              return {};
            },
          }),
        };
      },
    } as unknown as D1Database;
    await insertJuniorUsage(db, { id: "f1", ts: 1, studioId: ME, mode: "lead", model: "m", inputTokens: 0, outputTokens: 0, ok: false, error: "no_finish_reason" });
    expect(sqls).toHaveLength(2);
    expect(sqls[1]).not.toContain("error");
  });

  it("an unrelated insert failure is not swallowed by that fallback", async () => {
    const db = {
      prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1_ERROR: UNIQUE constraint failed"); } }) }),
    } as unknown as D1Database;
    await expect(insertJuniorUsage(db, { id: "f1", ts: 1, studioId: ME, mode: "lead", model: "m", inputTokens: 0, outputTokens: 0, ok: false, error: "x" }))
      .rejects.toThrow(/UNIQUE/);
  });
});

describe("insertJuniorUsage — call duration and attempts (issue #335)", () => {
  it("stores duration_ms and attempts; both NULL when absent", async () => {
    await insertJuniorUsage(env.DB, { id: "d1", ts: 1, studioId: ME, mode: "lead", model: "m", inputTokens: 1, outputTokens: 1, ok: true, durationMs: 1234, attempts: 2 });
    await insertJuniorUsage(env.DB, { id: "d2", ts: 2, studioId: ME, mode: "lead", model: "m", inputTokens: 0, outputTokens: 0, ok: false, error: "x", durationMs: 9, attempts: 3 });
    await insertJuniorUsage(env.DB, { id: "d3", ts: 3, studioId: ME, mode: "edit", model: "m", inputTokens: 1, outputTokens: 1, ok: true });
    const res = await env.DB.prepare("SELECT id, error, duration_ms AS durationMs, attempts FROM junior_usage_log ORDER BY ts")
      .all<{ id: string; error: string | null; durationMs: number | null; attempts: number | null }>();
    expect(res.results).toEqual([
      { id: "d1", error: null, durationMs: 1234, attempts: 2 },
      { id: "d2", error: "x", durationMs: 9, attempts: 3 },
      { id: "d3", error: null, durationMs: null, attempts: null },
    ]);
  });

  function missingColumnDb(missing: string[]) {
    const sqls: string[] = [];
    const db = {
      prepare(sql: string) {
        sqls.push(sql);
        return {
          bind: () => ({
            run: async () => {
              const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")"));
              const gone = missing.find((c) => cols.split(/\s*,\s*/).includes(c));
              if (gone) throw new Error(`D1_ERROR: table junior_usage_log has no column named ${gone}: SQLITE_ERROR`);
              return {};
            },
          }),
        };
      },
    } as unknown as D1Database;
    return { db, sqls };
  }

  it("before migration 0006 lands, the row keeps its error reason (drops only the new columns)", async () => {
    const { db, sqls } = missingColumnDb(["duration_ms", "attempts"]);
    await insertJuniorUsage(db, { id: "f1", ts: 1, studioId: ME, mode: "lead", model: "m", inputTokens: 0, outputTokens: 0, ok: false, error: "no_finish_reason", durationMs: 5, attempts: 1 });
    expect(sqls).toHaveLength(2);
    expect(sqls[1]).toContain("error");
    expect(sqls[1]).not.toContain("duration_ms");
  });

  it("before migrations 0005 and 0006 land, the call is still counted (legacy columns only)", async () => {
    const { db, sqls } = missingColumnDb(["error", "duration_ms", "attempts"]);
    await insertJuniorUsage(db, { id: "f1", ts: 1, studioId: ME, mode: "lead", model: "m", inputTokens: 0, outputTokens: 0, ok: false, error: "x", durationMs: 5, attempts: 1 });
    expect(sqls).toHaveLength(3);
    expect(sqls[2]).not.toMatch(/error|duration_ms|attempts/);
  });
});

describe("insertJuniorUsage + aggregateJuniorUsage", () => {
  it("round-trips a single row", async () => {
    await insertJuniorUsage(env.DB, {
      id: "u1", ts: 100, studioId: ME, mode: "edit", model: "@cf/zai-org/glm-5.3",
      inputTokens: 10, outputTokens: 20, ok: true,
    });
    const agg = await aggregateJuniorUsage(env.DB, 0);
    expect(agg.rows).toEqual([{ studioId: ME, calls: 1, inputTokens: 10, outputTokens: 20 }]);
    expect(agg.totals).toEqual({ calls: 1, inputTokens: 10, outputTokens: 20 });
  });

  it("groups by studio id across multiple studios and multiple rows", async () => {
    const OTHER = "websites--release-studio";
    await insertJuniorUsage(env.DB, { id: "u1", ts: 100, studioId: ME, mode: "edit", model: "m", inputTokens: 10, outputTokens: 20, ok: true });
    await insertJuniorUsage(env.DB, { id: "u2", ts: 200, studioId: ME, mode: "text", model: "m", inputTokens: 5, outputTokens: 7, ok: false });
    await insertJuniorUsage(env.DB, { id: "u3", ts: 300, studioId: OTHER, mode: "edit", model: "m", inputTokens: 1, outputTokens: 2, ok: true });

    const agg = await aggregateJuniorUsage(env.DB, 0);
    // ORDER BY studio_id, so lexically "release-studio" < "web-studio".
    expect(agg.rows).toEqual([
      { studioId: OTHER, calls: 1, inputTokens: 1, outputTokens: 2 },
      { studioId: ME, calls: 2, inputTokens: 15, outputTokens: 27 },
    ]);
    expect(agg.totals).toEqual({ calls: 3, inputTokens: 16, outputTokens: 29 });
  });

  // Fresh-context review finding 2: anthropic-route.ts's glm-lead route
  // writes into this SAME table, tagged mode: "lead" (USAGE_MODE in that
  // file) — a studio's entire lead-inference volume, not an occasional
  // junior delegation. This table's own header doc comment states its
  // purpose is specifically "measure GLM (junior) adoption vs Claude", so a
  // lead-mode row must never count toward that number — it is real usage/
  // billing data (still inserted, still readable by a raw query), just not
  // junior-adoption data.
  it("excludes mode: \"lead\" rows from the junior-adoption aggregate (fresh-context review finding 2)", async () => {
    await insertJuniorUsage(env.DB, { id: "u1", ts: 100, studioId: ME, mode: "edit", model: "m", inputTokens: 10, outputTokens: 20, ok: true });
    await insertJuniorUsage(env.DB, { id: "u2", ts: 200, studioId: ME, mode: "lead", model: "m", inputTokens: 1000, outputTokens: 2000, ok: true });

    const agg = await aggregateJuniorUsage(env.DB, 0);
    expect(agg.rows).toEqual([{ studioId: ME, calls: 1, inputTokens: 10, outputTokens: 20 }]);
    expect(agg.totals).toEqual({ calls: 1, inputTokens: 10, outputTokens: 20 });

    // The lead-mode row is still really there — this is "excluded from the
    // adoption aggregate", not "never written"/"deleted".
    const raw = await env.DB.prepare("SELECT mode FROM junior_usage_log WHERE mode = 'lead'").all();
    expect(raw.results).toHaveLength(1);
  });

  it("`since` excludes rows older than the cutoff", async () => {
    await insertJuniorUsage(env.DB, { id: "u1", ts: 100, studioId: ME, mode: "edit", model: "m", inputTokens: 10, outputTokens: 20, ok: true });
    await insertJuniorUsage(env.DB, { id: "u2", ts: 5000, studioId: ME, mode: "edit", model: "m", inputTokens: 1, outputTokens: 1, ok: true });

    const agg = await aggregateJuniorUsage(env.DB, 1000);
    expect(agg.rows).toEqual([{ studioId: ME, calls: 1, inputTokens: 1, outputTokens: 1 }]);
    expect(agg.totals).toEqual({ calls: 1, inputTokens: 1, outputTokens: 1 });
  });
});

// handleFleetJunior route-level: a usage row lands after both a successful
// and a failed ai.run() call, carrying the right mode/model/ok/tokens.
const boardTask = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  number: 7, url: "https://github.com/acme-org/websites/issues/7", title: "t", body: "b",
  state: "working", labels: ["working", studioLabel(ME), "junior"], assignee: ME, milestone: null,
  open: true, updatedAt: "2026-09-28T00:00:00Z", ...overrides,
});
function board(tasks: BoardTask[] = [boardTask()]): BoardApi {
  const listIssues = vi.fn(async () => tasks);
  return { listIssues } as unknown as BoardApi;
}
function row(id: string, hash: string, repoSlug: string | null = REPO): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug };
}
async function setup(aiResult: unknown) {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token))];
  const run = vi.fn(async () => {
    if (aiResult instanceof Error) throw aiResult;
    return aiResult;
  });
  const e = { ...env, AGENT_REPO: REPO, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;
  await recordJuniorAuthorization(e.DB, REPO, 7, ME, Date.now());
  return { token, rows, run, e };
}
const good = { model: "@cf/zai-org/glm-5.3", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
const req = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://w/fleet/junior", {
    method: "POST",
    headers: { [SPAWN_TOKEN_HEADER]: token, ...headers },
    body: JSON.stringify(body),
  });

// Issue #218 Boundaries: "recording failure must never delay/break the
// /fleet/junior response". A Proxy wrapping the REAL D1 binding — every
// query but the usage-log insert passes straight through to it (so
// rate-limit/authorization reads/writes made earlier in the same request
// still work against real data), but a `prepare` call whose SQL targets
// `junior_usage_log` returns a statement whose `.run()` always rejects,
// simulating a D1 insert failure at exactly the one call site this
// Boundary is about.
function dbWithFailingUsageInsert(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (query: string) => {
          if (query.includes("junior_usage_log")) {
            return { bind: () => ({ run: async () => { throw new Error("simulated D1 insert failure"); } }) };
          }
          return target.prepare(query);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as D1Database;
}

describe("handleFleetJunior — usage recording (#218)", () => {
  // Finding 1 (fresh-context review): the insert must be handed to
  // `ctx.waitUntil`, not a bare `void`-prefixed fire-and-forget — the
  // Workers runtime is free to tear down the execution context the instant
  // the response stream closes, and only `ctx.waitUntil` keeps a promise
  // alive past that point. Proven two ways: `ctx.waitUntil` was actually
  // invoked with a promise, and awaiting everything it queued (`drain()`,
  // not `r.text()`) is what makes the row observable — never the response
  // body itself.
  it("#218 finding 1: the usage-log insert is handed to ctx.waitUntil, not fire-and-forget", async () => {
    const { token, rows, e } = await setup({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const r = await handleFleetJunior(req(token, good), e, ctx, board(), rows);
    await r.text();
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await ctx.drain();

    const logged = await env.DB.prepare("SELECT * FROM junior_usage_log").all();
    expect(logged.results).toHaveLength(1);
  });

  it("records ok=1 with real token counts after a successful ai.run() call", async () => {
    const { token, rows, e } = await setup({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const r = await handleFleetJunior(req(token, good), e, ctx, board(), rows);
    await r.text(); // drain so the detached IIFE's insert has run

    const logged = await env.DB.prepare("SELECT * FROM junior_usage_log").all();
    expect(logged.results).toHaveLength(1);
    const logRow = logged.results[0] as Record<string, unknown>;
    expect(logRow.studio_id).toBe(ME);
    expect(logRow.ok).toBe(1);
    expect(logRow.input_tokens).toBe(3);
    expect(logRow.output_tokens).toBe(4);
    expect(logRow.model).toBe(good.model);
    expect(logRow.mode).toBe("edit"); // header omitted -> defaults to "edit"
  });

  it("records ok=0 with zero tokens after a failed ai.run() call", async () => {
    const { token, rows, e } = await setup(new Error("boom"));
    const r = await handleFleetJunior(req(token, good), e, ctx, board(), rows);
    await r.text();

    const logged = await env.DB.prepare("SELECT * FROM junior_usage_log").all();
    expect(logged.results).toHaveLength(1);
    const logRow = logged.results[0] as Record<string, unknown>;
    expect(logRow.ok).toBe(0);
    expect(logRow.input_tokens).toBe(0);
    expect(logRow.output_tokens).toBe(0);
  });

  it("records the X-Junior-Mode header value in the row's mode column", async () => {
    const { token, rows, e } = await setup({ response: "r" });
    const r = await handleFleetJunior(req(token, good, { "X-Junior-Mode": "text" }), e, ctx, board(), rows);
    await r.text();

    const logged = await env.DB.prepare("SELECT mode FROM junior_usage_log").all();
    expect((logged.results[0] as Record<string, unknown>).mode).toBe("text");
  });

  it("an invalid X-Junior-Mode header value falls back to the edit default", async () => {
    const { token, rows, e } = await setup({ response: "r" });
    const r = await handleFleetJunior(req(token, good, { "X-Junior-Mode": "bogus" }), e, ctx, board(), rows);
    await r.text();

    const logged = await env.DB.prepare("SELECT mode FROM junior_usage_log").all();
    expect((logged.results[0] as Record<string, unknown>).mode).toBe("edit");
  });

  // Code review round 1, Spec-axis gap: the fire-and-forget `.catch(() =>
  // {})` in route.ts SUGGESTS a failed usage insert can never delay or break
  // the response — this test actually forces that failure (see
  // dbWithFailingUsageInsert's own doc comment) and proves the studio still
  // gets its normal 200 body, not just that a successful insert leaves the
  // response alone.
  it("#218 Boundaries: a D1 insert failure for the usage row never delays or breaks the 200 response", async () => {
    const { token, rows, e } = await setup({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const failing = { ...e, DB: dbWithFailingUsageInsert(e.DB) } as unknown as Env;

    const r = await handleFleetJunior(req(token, good), failing, ctx, board(), rows);
    expect(r.status).toBe(200);
    expect(JSON.parse((await r.text()).trim())).toEqual({
      content: "ok", finish: "stop", usage: { in: 3, out: 4, neurons: null },
    });

    // The insert genuinely failed — no row landed — proving this is a real
    // rejection surfacing through the full insertJuniorUsage call, not a
    // no-op double of the already-covered success path.
    const logged = await env.DB.prepare("SELECT * FROM junior_usage_log").all();
    expect(logged.results).toHaveLength(0);
  });
});

describe("handleJuniorUsageStats", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("401/403 when Access auth fails — same pattern as every other /studio/* route", async () => {
    const failure = new Response("forbidden", { status: 403 });
    const verifyAccessFn = vi.fn(async () => failure);
    const r = await handleJuniorUsageStats(new Request("https://w/studio/junior/usage"), env as unknown as Env, verifyAccessFn);
    expect(r.status).toBe(403);
    expect(verifyAccessFn).toHaveBeenCalled();
  });

  it("200 with {rows, totals} when authenticated, and ?since= filters correctly", async () => {
    await insertJuniorUsage(env.DB, { id: "u1", ts: 100, studioId: ME, mode: "edit", model: "m", inputTokens: 10, outputTokens: 20, ok: true });
    await insertJuniorUsage(env.DB, { id: "u2", ts: 5000, studioId: ME, mode: "edit", model: "m", inputTokens: 1, outputTokens: 1, ok: true });
    const verifyAccessFn = vi.fn(async () => null);

    const all = await handleJuniorUsageStats(new Request("https://w/studio/junior/usage"), env as unknown as Env, verifyAccessFn);
    expect(all.status).toBe(200);
    const allBody = await all.json<{ rows: unknown[]; totals: { calls: number } }>();
    expect(allBody.totals.calls).toBe(2);

    const since = await handleJuniorUsageStats(
      new Request("https://w/studio/junior/usage?since=1000"), env as unknown as Env, verifyAccessFn,
    );
    const sinceBody = await since.json<{ rows: unknown[]; totals: { calls: number } }>();
    expect(sinceBody.totals.calls).toBe(1);
  });

  it("verifyAccess is stubbed via the module spy too, matching the house pattern", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const r = await handleJuniorUsageStats(new Request("https://w/studio/junior/usage"), env as unknown as Env);
    expect(r.status).toBe(200);
  });
});
