import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleFleetJunior, normalizeAiResult, JUNIOR_BODY_CAP } from "../src/junior/route";
import { juniorEnabled } from "../src/junior/gate";
import { recordJuniorAuthorization } from "../src/junior/authz";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import type { BoardApi } from "../src/board/board";
import { studioLabel, type BoardTask } from "../src/board/types";

const REPO = "acme-org/websites";
const ME = "websites--web-studio";
function boardTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return { number: 7, url: "https://github.com/acme-org/websites/issues/7", title: "t", body: "b",
    state: "working", labels: ["working", studioLabel(ME), "junior"], assignee: ME, milestone: null,
    open: true, updatedAt: "2026-09-28T00:00:00Z", ...overrides };
}
function board(tasks: BoardTask[] | Error = [boardTask()]): BoardApi {
  const listIssues = vi.fn(async () => { if (tasks instanceof Error) throw tasks; return tasks; });
  return { listIssues } as unknown as BoardApi;
}
function row(id: string, hash: string, repoSlug: string | null = REPO): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug };
}
// `authorize` seeds the B1 D1 record for task #7 (the default `boardTask()`)
// assigned to `ME` — the Worker-side record that is now the actual /fleet/
// junior gate (src/junior/authz.ts), never the `junior` GitHub label. Every
// test below that exercises anything DOWNSTREAM of authorization (body
// parsing, the AI call, streaming, heartbeats) needs it; tests that assert on
// the authorization gate itself pass `authorize: false` and/or a different
// board fixture instead.
async function setup(
  overrides: Partial<Env> = {},
  aiResult: unknown = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
  authorize = true,
) {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token))];
  const run = vi.fn(async () => aiResult);
  const e = { ...env, AGENT_REPO: REPO, FLEET_JUNIOR: "on", AI: { run }, ...overrides } as unknown as Env;
  if (authorize) await recordJuniorAuthorization(e.DB, REPO, 7, ME, Date.now());
  return { token, rows, run, e };
}
const req = (token: string | null, body: unknown, path = "/fleet/junior", method = "POST") =>
  new Request(`https://w${path}`, {
    method, headers: token ? { [SPAWN_TOKEN_HEADER]: token } : {},
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
const good = { model: "@cf/zai-org/glm-5.3", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };

// PR #9 review, blocker B1: fleet_state is NOT isolated per test (see
// agents.do.test.ts's own identical beforeEach) — a D1-backed authorization
// record written in one test would otherwise leak into the next, silently
// authorizing a test that expects a 403.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("juniorEnabled", () => {
  it("off unless exactly 'on'", () => {
    expect(juniorEnabled({ FLEET_JUNIOR: undefined, JUNIOR_REPOS: undefined }, REPO)).toBe(false);
    expect(juniorEnabled({ FLEET_JUNIOR: "true", JUNIOR_REPOS: undefined }, REPO)).toBe(false);
    expect(juniorEnabled({ FLEET_JUNIOR: "on", JUNIOR_REPOS: undefined }, REPO)).toBe(true);
  });
  it("JUNIOR_REPOS narrows, case-insensitive", () => {
    expect(juniorEnabled({ FLEET_JUNIOR: "on", JUNIOR_REPOS: "Acme-Org/Websites" }, REPO)).toBe(true);
    expect(juniorEnabled({ FLEET_JUNIOR: "on", JUNIOR_REPOS: "acme-org/other" }, REPO)).toBe(false);
    expect(juniorEnabled({ FLEET_JUNIOR: "on", JUNIOR_REPOS: "acme-org/other" }, undefined)).toBe(false);
  });
});

describe("handleFleetJunior", () => {
  it("404 when flag off", async () => {
    const { token, rows, e } = await setup({ FLEET_JUNIOR: undefined });
    expect((await handleFleetJunior(req(token, good), e, board(), rows)).status).toBe(404);
  });
  it("404 when repo not listed", async () => {
    const { token, rows, e } = await setup({ JUNIOR_REPOS: "acme-org/other" });
    expect((await handleFleetJunior(req(token, good), e, board(), rows)).status).toBe(404);
  });
  it("404 when AI binding missing", async () => {
    const { token, rows, e } = await setup({ AI: undefined });
    expect((await handleFleetJunior(req(token, good), e, board(), rows)).status).toBe(404);
  });
  it("405 on GET", async () => {
    const { token, rows, e } = await setup();
    expect((await handleFleetJunior(req(token, null, "/fleet/junior", "GET"), e, board(), rows)).status).toBe(405);
  });
  it("401 on missing or unknown token", async () => {
    const { rows, e } = await setup();
    expect((await handleFleetJunior(req(null, good), e, board(), rows)).status).toBe(401);
    expect((await handleFleetJunior(req(mintSpawnToken(), good), e, board(), rows)).status).toBe(401);
  });
  it("400 on model outside allowlist", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetJunior(req(token, { ...good, model: "@cf/openai/gpt-oss-120b" }), e, board(), rows);
    expect(r.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  it("400 on bad JSON or missing messages", async () => {
    const { token, rows, e } = await setup();
    expect((await handleFleetJunior(req(token, "{nope"), e, board(), rows)).status).toBe(400);
    expect((await handleFleetJunior(req(token, { model: good.model }), e, board(), rows)).status).toBe(400);
  });
  it("413 over 2 MB", async () => {
    const { token, rows, e } = await setup();
    const big = { ...good, messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }] };
    expect((await handleFleetJunior(req(token, big), e, board(), rows)).status).toBe(413);
  });
  // PR #9 review, F3: the old check read the WHOLE body into one JS string
  // (`req.text()`) before ever comparing its length to the cap — exactly the
  // DoS shape a Content-Length ceiling is supposed to prevent. A lying
  // Content-Length must be caught from the header alone, with nothing else
  // in the handler (auth, board, AI) ever running.
  it("F3: a Content-Length lying above the cap is rejected before auth, board, or AI work", async () => {
    const { e, run } = await setup();
    const api = board();
    const rows = vi.fn(async () => []);
    const request = new Request("https://w/fleet/junior", {
      method: "POST",
      // Deliberately NO spawn-token header: the size gate must fire even
      // before auth would, proving nothing downstream of it ran.
      headers: { "content-length": String(JUNIOR_BODY_CAP + 1) },
      body: JSON.stringify(good),
    });
    const r = await handleFleetJunior(request, e, api, rows);
    expect(r.status).toBe(413);
    expect(rows).not.toHaveBeenCalled();
    expect(api.listIssues).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  // The Content-Length header can be absent or under-reported; the real
  // ceiling has to be enforced against the bytes actually read, streamed in,
  // never against one fully-materialized string.
  it("F3: a streamed body over the cap with no Content-Length header is rejected without ever being fully drained", async () => {
    const { token, rows, e, run } = await setup();
    const chunkSize = 1024 * 1024; // 1 MiB
    const totalChunks = 5; // 5 MiB total, well over the 2 MiB cap
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced++;
        if (produced > totalChunks) { controller.close(); return; }
        controller.enqueue(new Uint8Array(chunkSize));
      },
    });
    const request = new Request("https://w/fleet/junior", {
      method: "POST",
      headers: { [SPAWN_TOKEN_HEADER]: token },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const r = await handleFleetJunior(request, e, board(), rows);
    expect(r.status).toBe(413);
    // Stopped pulling once the running total crossed the cap (after 3 MiB —
    // the 3rd chunk), never drained all 5.
    expect(produced).toBeLessThan(totalChunks);
    expect(run).not.toHaveBeenCalled();
  });
  it("200 streams normalized JSON and forwards the request to env.AI.run", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetJunior(req(token, good), e, board(), rows);
    expect(r.status).toBe(200);
    expect(JSON.parse((await r.text()).trim())).toEqual({ content: "ok", finish: "stop", usage: { in: 1, out: 2, neurons: null } });
    expect(run).toHaveBeenCalledWith(good.model, { messages: good.messages, max_tokens: 100 });
  });
  it("AI error becomes an error body with a classified code", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => { throw new Error("AiError: AiError: Request timeout (abc)"); });
    const r = await handleFleetJunior(req(token, good), e, board(), rows);
    expect(JSON.parse((await r.text()).trim())).toEqual({ error: { code: 3046, message: "AiError: AiError: Request timeout (abc)" } });
  });
  it("heartbeat spaces precede the JSON on slow calls", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(() => new Promise((res) => setTimeout(() => res({ response: "late" }), 50)));
    const r = await handleFleetJunior(req(token, good), e, board(), rows, 10);
    const text = await r.text();
    expect(text.startsWith(" ")).toBe(true);
    expect(JSON.parse(text.trim()).content).toBe("late");
  });
  it("a client disconnect mid-call stops the heartbeat instead of retrying a dead writer forever", async () => {
    const { token, rows, e } = await setup();
    // ai.run resolves well after the disconnect below, so if the interval
    // is only ever cleared in the async IIFE's `finally` (the unfixed
    // behaviour) clearInterval cannot have fired yet at the check below —
    // the fix must clear it the moment a heartbeat write itself fails.
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(() => new Promise((res) => setTimeout(() => res({ response: "late" }), 200)));
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const r = await handleFleetJunior(req(token, good), e, board(), rows, 10);
    const reader = r.body!.getReader();
    await reader.read(); // consume a heartbeat byte so the stream is flowing
    await reader.cancel(); // simulate the client going away mid-call
    await new Promise((res) => setTimeout(res, 60)); // let several 10ms heartbeat ticks fire against the now-errored writer
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
  it("max_tokens is clamped to 128000 server-side before reaching env.AI.run", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetJunior(req(token, { ...good, max_tokens: 999999999 }), e, board(), rows);
    expect(r.status).toBe(200);
    expect(run).toHaveBeenCalledWith(good.model, { messages: good.messages, max_tokens: 128_000 });
  });
});

describe("handleFleetJunior — maestro authorization", () => {
  // B1: the label is no longer load-bearing (see the B1 test below), so this
  // is deliberately `authorize: false` — the actual refusal reason is "no D1
  // record for this task", not "no junior label".
  it("403 when the live task has no D1 authorization record", async () => {
    const { token, rows, e, run } = await setup({}, undefined, false);
    const r = await handleFleetJunior(req(token, good), e, board([boardTask({ labels: ["working", studioLabel(ME)] })]), rows);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("junior not authorized for your current task");
    expect(run).not.toHaveBeenCalled();
  });
  it("403 when the junior task is completed", async () => {
    const { token, rows, e } = await setup();
    const done = boardTask({ state: "completed", open: false, labels: ["completed", studioLabel(ME), "junior"] });
    expect((await handleFleetJunior(req(token, good), e, board([done]), rows)).status).toBe(403);
  });
  it("403 when the junior task belongs to another studio", async () => {
    const { token, rows, e } = await setup();
    const theirs = boardTask({ assignee: "websites--release-studio", labels: ["working", studioLabel("websites--release-studio"), "junior"] });
    expect((await handleFleetJunior(req(token, good), e, board([theirs]), rows)).status).toBe(403);
  });
  it("503 when the board read fails — fail closed", async () => {
    const { token, rows, e, run } = await setup();
    expect((await handleFleetJunior(req(token, good), e, board(new Error("github 500")), rows)).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
  it("board is read for the studio's own id on its bound repo", async () => {
    const { token, rows, e } = await setup();
    const api = board();
    await (await handleFleetJunior(req(token, good), e, api, rows)).text();
    expect(vi.mocked(api.listIssues).mock.calls[0][0]).toBe(REPO);
  });

  // PR #9 review, blocker B1: a studio's own repo-scoped `gh` token can add a
  // label to its own issue (`gh issue edit <n> --add-label junior`) — GitHub
  // never distinguishes who added a label. The default `board()` fixture
  // already carries JUNIOR_LABEL on a live task assigned to ME (see
  // `boardTask()` above), simulating exactly that: a label present on the
  // board with NO Worker-side D1 record behind it (setup's `authorize: false`
  // below skips the one write that would create one). This must stay 403.
  //
  // Mutation-test proof (performed by hand, not committed): reverting
  // route.ts's authorization check back to `t.labels.includes(JUNIOR_LABEL)`
  // (the pre-fix code) makes this exact test go green on a task that should
  // never have been authorized — i.e. this test is RED against the label-only
  // implementation and GREEN only against the real D1-backed one.
  it("B1: a JUNIOR_LABEL present on the board with no Worker-side D1 record does NOT authorize", async () => {
    const { token, rows, e, run } = await setup({}, undefined, false);
    const r = await handleFleetJunior(req(token, good), e, board(), rows);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("junior not authorized for your current task");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("handleFleetJunior — rate limit and daily cap (F1)", () => {
  it("a request within both limits still succeeds normally", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetJunior(req(token, good), e, board(), rows);
    expect(r.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });
  it("429s once the per-minute rate is exceeded, naming the limit", async () => {
    const { token, rows, e, run } = await setup({ JUNIOR_RATE_PER_MINUTE: "1" });
    const api = board();
    const first = await handleFleetJunior(req(token, good), e, api, rows);
    expect(first.status).toBe(200);
    const second = await handleFleetJunior(req(token, good), e, api, rows);
    expect(second.status).toBe(429);
    expect(await second.text()).toMatch(/minute/i);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("429s once the daily cap is exceeded, naming the limit, even with room left in the per-minute rate", async () => {
    const { token, rows, e, run } = await setup({ JUNIOR_DAILY_CAP: "1" });
    const api = board();
    const first = await handleFleetJunior(req(token, good), e, api, rows);
    expect(first.status).toBe(200);
    const second = await handleFleetJunior(req(token, good), e, api, rows);
    expect(second.status).toBe(429);
    expect(await second.text()).toMatch(/daily/i);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("an unauthorized call never consumes rate budget", async () => {
    const { token, rows, e, run } = await setup({ JUNIOR_RATE_PER_MINUTE: "1" }, undefined, false);
    // Unauthorized (no D1 record) — should 403, not consume the one
    // per-minute slot, and leave it free for a subsequently authorized call.
    const unauthorized = await handleFleetJunior(req(token, good), e, board(), rows);
    expect(unauthorized.status).toBe(403);
    const { recordJuniorAuthorization } = await import("../src/junior/authz");
    await recordJuniorAuthorization(e.DB, REPO, 7, ME, Date.now());
    const authorized = await handleFleetJunior(req(token, good), e, board(), rows);
    expect(authorized.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("handleFleetJunior — maestro exclusion (F2)", () => {
  // Defense in depth beyond "the maestro never gets the junior skill" (Task
  // 7's provision-time exclusion): even a maestro token that somehow reached
  // this route must never get through. PR #9 review, item (b): the check
  // matches on ROLE ALONE (see route.ts's isMaestroStudio doc comment for why
  // it deliberately does NOT copy do.ts's own isMaestro()'s extra instance-1
  // restriction) — any maestro instance is excluded, not just instance 1.
  const MAESTRO = "websites--maestro";
  it("403s a maestro-identified studio immediately — before board lookup, before body processing", async () => {
    const token = mintSpawnToken();
    const rows = async () => [row(MAESTRO, await hashSpawnToken(token))];
    const run = vi.fn(async () => ({ response: "x" }));
    const e = { ...env, AGENT_REPO: REPO, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;
    const maestroTask = boardTask({ labels: ["working", studioLabel(MAESTRO), "junior"], assignee: MAESTRO });
    const api = board([maestroTask]);
    // Even a D1 record that would otherwise authorize this exact studio/task
    // must not save it — the maestro exclusion runs first and is absolute.
    await recordJuniorAuthorization(e.DB, REPO, maestroTask.number, MAESTRO, Date.now());

    const r = await handleFleetJunior(req(token, good), e, api, rows);

    expect(r.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect(api.listIssues).not.toHaveBeenCalled();
  });

  // PR #9 review, item (b): the check must match on ROLE ALONE, not
  // role-and-instance-1. do.ts's own isMaestro() requires instance 1 too, but
  // for a DIFFERENT reason specific to its own use (only the canonical
  // instance 1 may arm the sweep loop, since wake-events.ts's maestroIdFor
  // only ever wakes the bare id) — that reasoning does not transfer here.
  // This route needs "is this studio a maestro AT ALL", so a stray second
  // maestro instance (however it came to exist) must be excluded exactly like
  // instance 1 is.
  const MAESTRO_2 = "websites--maestro--2";
  it("403s a maestro studio at instance 2 exactly like instance 1 — role alone is what matters here", async () => {
    const token = mintSpawnToken();
    const rows = async () => [row(MAESTRO_2, await hashSpawnToken(token))];
    const run = vi.fn(async () => ({ response: "x" }));
    const e = { ...env, AGENT_REPO: REPO, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;
    const maestroTask = boardTask({ labels: ["working", studioLabel(MAESTRO_2), "junior"], assignee: MAESTRO_2 });
    const api = board([maestroTask]);
    await recordJuniorAuthorization(e.DB, REPO, maestroTask.number, MAESTRO_2, Date.now());

    const r = await handleFleetJunior(req(token, good), e, api, rows);

    expect(r.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect(api.listIssues).not.toHaveBeenCalled();
  });
});

describe("normalizeAiResult", () => {
  it("legacy { response } shape", () => {
    expect(normalizeAiResult({ response: "r" })).toEqual({ content: "r", finish: null, usage: { in: 0, out: 0, neurons: null } });
  });
});
