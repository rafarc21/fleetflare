// apps/fleet/test/llm.anthropic-triage.test.ts
// #1218: the scoped router-only TRIAGE_ROUTER_TOKEN credential. The local
// oss-triage daemon authenticates to the two glm-lead llm routes
// (/messages and /count_tokens) with this secret and NO spawn token — the
// routes resolve it to the synthetic studio id "triage--daemon" so rate
// limits and usage rows key on that id. Same cloudflare:test convention as
// llm.anthropic-core.test.ts (spawn-token resolution still needs a real
// registry row + StudioStatus shape for the spawn-token path this file also
// exercises), and fakeCtx for the deferred usage-row insert.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  handleFleetAnthropicMessages, handleFleetAnthropicCountTokens,
  ANTHROPIC_MESSAGES_PATH, ANTHROPIC_COUNT_TOKENS_PATH,
} from "../src/llm/anthropic-route";
import { handleFleetSpawn, type BlueprintFetch } from "../src/studio/routes";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { fakeCtx } from "./helpers/fake-ctx";

const ME = "acme-org--web-studio";
const TRIAGE_SECRET = "triage-secret";
const DAEMON_ID = "triage--daemon";

// glm-led by default, same fixture shape llm.anthropic-core.test.ts uses —
// only the spawn-token path (unset-secret test) actually resolves this row.
function row(id: string, hash: string, leadType: "claude" | "glm" | undefined = "glm"): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug: "acme-org/websites",
    ...(leadType === undefined ? {} : { leadType }) };
}

let ctx: ReturnType<typeof fakeCtx>;

async function usageRows() {
  const res = await env.DB.prepare(
    "SELECT studio_id AS studioId, mode, model, input_tokens AS inputTokens, output_tokens AS outputTokens, ok, error, duration_ms AS durationMs, attempts FROM junior_usage_log ORDER BY ts ASC",
  ).all<{ studioId: string; mode: string; model: string; inputTokens: number; outputTokens: number; ok: number; error: string | null; durationMs: number | null; attempts: number | null }>();
  return res.results ?? [];
}

const good = { model: "claude-opus-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

function req(opts: { token?: string | null; apiKey?: string; body?: unknown; path?: string; method?: string }) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const method = opts.method ?? "POST";
  return new Request(`https://w${opts.path ?? ANTHROPIC_MESSAGES_PATH}`, {
    method, headers,
    body: method === "POST" ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? good)) : undefined,
  });
}

// The AI result every triage call here returns: a normal non-streaming reply.
const aiOk = async () => ({
  choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});

function triageEnv(run: ReturnType<typeof vi.fn>, extra: Partial<Env> = {}) {
  return { ...env, FLEET_JUNIOR: "on", AI: { run }, TRIAGE_ROUTER_TOKEN: TRIAGE_SECRET, ...extra } as unknown as Env;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await env.DB.prepare("DELETE FROM junior_usage_log").run();
  ctx = fakeCtx();
});

describe("TRIAGE_ROUTER_TOKEN (scoped router-only credential)", () => {
  it("accepted on messages — 200, run called, usage logged under triage--daemon", async () => {
    const run = vi.fn(aiOk);
    const e = triageEnv(run);
    const rows = async () => [];
    const r = await handleFleetAnthropicMessages(req({ token: TRIAGE_SECRET }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(run).toHaveBeenCalled();
    await ctx.drain();
    const logged = await usageRows();
    expect(logged).toHaveLength(1);
    expect(logged[0].studioId).toBe(DAEMON_ID);
  });

  it("accepted on count_tokens — 200, run NOT called, numeric input_tokens", async () => {
    const run = vi.fn(aiOk);
    const e = triageEnv(run);
    const rows = async () => [];
    const r = await handleFleetAnthropicCountTokens(
      req({ token: TRIAGE_SECRET, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows,
    );
    expect(r.status).toBe(200);
    expect(run).not.toHaveBeenCalled();
    const body = (await r.json()) as { input_tokens: unknown };
    expect(typeof body.input_tokens).toBe("number");
  });

  it("wrong token rejected with 401", async () => {
    const run = vi.fn(aiOk);
    const e = triageEnv(run);
    const rows = async () => [];
    const r = await handleFleetAnthropicMessages(req({ token: "wrong-secret" }), e, ctx, rows);
    expect(r.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("unset secret = unchanged — triage 401, a real spawn token still 200", async () => {
    const run = vi.fn(aiOk);
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run } } as unknown as Env;
    const noRows = async () => [];
    expect((await handleFleetAnthropicMessages(req({ token: TRIAGE_SECRET }), e, ctx, noRows)).status).toBe(401);

    // Empty secret rejects the same as unset: TRIAGE_ROUTER_TOKEN="" must not
    // authenticate an empty presented bearer (built inline — req()'s own
    // `if (opts.token)` guard would skip an empty string).
    const eEmpty = { ...env, FLEET_JUNIOR: "on", AI: { run }, TRIAGE_ROUTER_TOKEN: "" } as unknown as Env;
    const emptyReq = new Request(`https://w${ANTHROPIC_MESSAGES_PATH}`, {
      method: "POST", headers: { authorization: "Bearer " },
      body: JSON.stringify(good),
    });
    expect((await handleFleetAnthropicMessages(emptyReq, eEmpty, ctx, noRows)).status).toBe(401);

    const token = mintSpawnToken();
    const rows = async () => [row(ME, await hashSpawnToken(token))];
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(200);
  });

  it("rate limit applies — LEAD_RATE_PER_MINUTE=1, second triage call 429 + retry-after", async () => {
    const run = vi.fn(aiOk);
    const e = triageEnv(run, { LEAD_RATE_PER_MINUTE: "1" });
    const rows = async () => [];
    const first = await handleFleetAnthropicMessages(req({ token: TRIAGE_SECRET }), e, ctx, rows);
    expect(first.status).toBe(200);
    const second = await handleFleetAnthropicMessages(req({ token: TRIAGE_SECRET }), e, ctx, rows);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
  });
});

describe("TRIAGE_ROUTER_TOKEN is accepted on no other route", () => {
  it("rejected on the spawn route with 401 — not spawn-token-shaped", async () => {
    const e = { ...env, TRIAGE_ROUTER_TOKEN: TRIAGE_SECRET } as unknown as Env;
    const dummyFetchFile = (async () => "fake") as BlueprintFetch;
    const r = new Request("https://w/fleet/spawn", {
      method: "POST", headers: { [SPAWN_TOKEN_HEADER]: TRIAGE_SECRET },
    });
    const res = await handleFleetSpawn(r, e, dummyFetchFile);
    expect(res.status).toBe(401);
  });
});

describe("#1221 triage key edge cases (maestro security review amend)", () => {
  it("empty configured key + empty x-api-key header gives 401", async () => {
    const run = vi.fn(aiOk);
    const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, TRIAGE_ROUTER_TOKEN: "" } as unknown as Env;
    const rows = async () => [];
    const r = await handleFleetAnthropicMessages(
      new Request(`https://w${ANTHROPIC_MESSAGES_PATH}`, {
        method: "POST", headers: { "x-api-key": "" }, body: JSON.stringify(good),
      }), e, ctx, rows,
    );
    expect(r.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("FLEET_JUNIOR off + a valid triage key gives 404", async () => {
    const run = vi.fn(aiOk);
    const e = { ...env, FLEET_JUNIOR: "off", AI: { run }, TRIAGE_ROUTER_TOKEN: TRIAGE_SECRET } as unknown as Env;
    const rows = async () => [];
    const r = await handleFleetAnthropicMessages(req({ token: TRIAGE_SECRET }), e, ctx, rows);
    expect(r.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("count_tokens rate limit returns 429 for triage--daemon", async () => {
    const run = vi.fn(aiOk);
    const e = triageEnv(run, { LEAD_COUNT_TOKENS_RATE_PER_MINUTE: "1" });
    const rows = async () => [];
    const first = await handleFleetAnthropicCountTokens(
      req({ token: TRIAGE_SECRET, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows,
    );
    expect(first.status).toBe(200);
    const second = await handleFleetAnthropicCountTokens(
      req({ token: TRIAGE_SECRET, path: ANTHROPIC_COUNT_TOKENS_PATH }), e, ctx, rows,
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
  });

  it("a second wrong key sharing the first hex char is rejected", async () => {
    const run = vi.fn(aiOk);
    const e = triageEnv(run);
    const rows = async () => [];
    // "other" hashes to 0d... — same first hex char as TRIAGE_SECRET's d6...
    const r = await handleFleetAnthropicMessages(req({ token: "other" }), e, ctx, rows);
    expect(r.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("a real registry row with the reserved id triage--daemon is rejected", async () => {
    const run = vi.fn(aiOk);
    const e = triageEnv(run);
    const token = mintSpawnToken();
    const rows = async () => [row(DAEMON_ID, await hashSpawnToken(token), "glm")];
    const r = await handleFleetAnthropicMessages(req({ token }), e, ctx, rows);
    expect(r.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("a spawn-shaped value is never accepted as the triage key", async () => {
    const run = vi.fn(aiOk);
    const e = triageEnv(run);
    const rows = async () => [];
    // A spawn-shaped value routes to spawn-token resolution, never the triage
    // compare — with no matching row it must 401, not fall through to the key.
    const spawnShaped = `fsp_${"0".repeat(64)}`;
    const r = await handleFleetAnthropicMessages(req({ token: spawnShaped }), e, ctx, rows);
    expect(r.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});