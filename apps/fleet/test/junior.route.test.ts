import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleFleetJunior, normalizeAiResult } from "../src/junior/route";
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
  it("403 when no live task carries junior", async () => {
    const { token, rows, e, run } = await setup();
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

describe("normalizeAiResult", () => {
  it("legacy { response } shape", () => {
    expect(normalizeAiResult({ response: "r" })).toEqual({ content: "r", finish: null, usage: { in: 0, out: 0, neurons: null } });
  });
});
