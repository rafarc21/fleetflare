// apps/fleet/test/bun/junior-client.test.ts
import { describe, expect, test } from "bun:test";
import {
  ApiError, AuthError, callOnce, callWithPolicy, normalize, GLM, DEEPSEEK, type Transport,
} from "../../../../skills/junior/src/client";

const direct: Transport = { kind: "direct", base: "https://x/v4", accountId: "acct", token: async () => "tok", source: "api-token" };
const proxy: Transport = { kind: "proxy", url: "https://w", spawnToken: "s".repeat(43) };
const ok = (content: string, finish = "stop") =>
  ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 4, neurons: 5 } });
const cfErr = (code: number, message: string) => ({ success: false, errors: [{ code, message }] });

type Reply = { status?: number; json?: unknown; text?: string };
function fakeFetch(replies: Reply[]) {
  const seen: { url: string; body: any; headers: Headers }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    const r = replies.shift();
    if (!r) throw new Error("unexpected call");
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}
const noSleep = async () => {};
const msgs = [{ role: "user" as const, content: "hi" }];

describe("normalize", () => {
  test("OpenAI shape", () => {
    expect(normalize(ok("hey"))).toEqual({ content: "hey", finish: "stop", usage: { in: 3, out: 4, neurons: 5 } });
  });
  test("already-normalized proxy shape passes through", () => {
    const n = { content: "c", finish: "length", usage: { in: 1, out: 2, neurons: null } };
    expect(normalize(n)).toEqual(n);
  });
  test("null content -> empty string", () => {
    expect(normalize({ choices: [{ message: { content: null }, finish_reason: "length" }] }).content).toBe("");
  });
});

describe("callOnce direct transport", () => {
  test("posts OpenAI-compat request with bearer token", async () => {
    const { f, seen } = fakeFetch([{ json: ok("a") }]);
    await callOnce(direct, { model: GLM, messages: msgs, max_tokens: 10 }, f);
    expect(seen[0].url).toBe("https://x/v4/accounts/acct/ai/v1/chat/completions");
    expect(seen[0].headers.get("authorization")).toBe("Bearer tok");
    expect(seen[0].body).toEqual({ model: GLM, messages: msgs, max_tokens: 10 });
  });
  test("Cloudflare error envelope -> ApiError with code", async () => {
    const { f } = fakeFetch([{ status: 500, json: cfErr(3046, "AiError: Request timeout") }]);
    const e = await callOnce(direct, { model: GLM, messages: msgs, max_tokens: 10 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe(3046);
  });
  test("10000 auth error -> AuthError", async () => {
    const { f } = fakeFetch([{ status: 401, json: cfErr(10000, "Authentication error") }]);
    expect(await callOnce(direct, { model: GLM, messages: msgs, max_tokens: 1 }, f).catch((x) => x)).toBeInstanceOf(AuthError);
  });
});

describe("callOnce proxy transport", () => {
  test("posts to /fleet/junior with spawn token, parses padded JSON", async () => {
    const { f, seen } = fakeFetch([{ text: "      " + JSON.stringify({ content: "c", finish: "stop", usage: { in: 1, out: 1, neurons: null } }) }]);
    const r = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f);
    expect(r.content).toBe("c");
    expect(seen[0].url).toBe("https://w/fleet/junior");
    expect(seen[0].headers.get("x-fleet-spawn-token")).toBe("s".repeat(43));
  });
  test("plain-text 404 -> AuthError 'junior not enabled for this repo'", async () => {
    const { f } = fakeFetch([{ status: 404, text: "not found" }]);
    const e = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toContain("junior not enabled for this repo");
  });
  test("plain-text 403 -> AuthError naming the maestro gate", async () => {
    const { f } = fakeFetch([{ status: 403, text: "junior not authorized for your current task" }]);
    const e = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toContain("fleet task new --junior");
  });
  test("plain-text 401 -> AuthError unauthorized", async () => {
    const { f } = fakeFetch([{ status: 401, text: "unauthorized" }]);
    const e = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toContain("unauthorized");
  });
  test("error body from Worker -> ApiError", async () => {
    const { f } = fakeFetch([{ text: "  " + JSON.stringify({ error: { code: 3040, message: "out of capacity" } }) }]);
    const e = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe(3040);
  });
});

describe("callWithPolicy", () => {
  const run = (replies: Reply[]) => {
    const { f, seen } = fakeFetch(replies);
    const p = callWithPolicy({ transport: direct, models: [GLM, DEEPSEEK], messages: msgs, maxTokens: 64000, fetchImpl: f, sleep: noSleep });
    return { p, seen };
  };

  test("first success returns", async () => {
    const { p } = run([{ json: ok("done") }]);
    expect(await p).toMatchObject({ model: GLM, calls: 1, result: { content: "done" } });
  });
  test("3046 retries once on same model, then falls back", async () => {
    const { p, seen } = run([
      { status: 500, json: cfErr(3046, "timeout") }, { status: 500, json: cfErr(3046, "timeout") }, { json: ok("ds") },
    ]);
    expect(await p).toMatchObject({ model: DEEPSEEK, calls: 3 });
    expect(seen.map((s) => s.body.model)).toEqual([GLM, GLM, DEEPSEEK]);
  });
  test("3040 capacity retried once then succeeds", async () => {
    const { p } = run([{ status: 500, json: cfErr(3040, "capacity") }, { json: ok("ok") }]);
    expect(await p).toMatchObject({ model: GLM, calls: 2 });
  });
  test("finish=length retries once with double budget", async () => {
    const { p, seen } = run([{ json: ok("", "length") }, { json: ok("full") }]);
    expect((await p).result.content).toBe("full");
    expect(seen.map((s) => s.body.max_tokens)).toEqual([64000, 128000]);
  });
  test("length budget never exceeds cap", async () => {
    const { f, seen } = fakeFetch([{ json: ok("", "length") }, { json: ok("x") }]);
    await callWithPolicy({ transport: direct, models: [GLM], messages: msgs, maxTokens: 100000, fetchImpl: f, sleep: noSleep });
    expect(seen[1].body.max_tokens).toBe(128000);
  });
  test("empty output falls back", async () => {
    const { p } = run([{ json: ok("   ") }, { json: ok("ds") }]);
    expect(await p).toMatchObject({ model: DEEPSEEK });
  });
  test("429 backs off 10s then 20s, then fails", async () => {
    const waits: number[] = [];
    const { f } = fakeFetch([{ status: 429, json: cfErr(429, "rate limited") }, { status: 429, json: cfErr(429, "rate limited") }, { status: 429, json: cfErr(429, "rate limited") }]);
    const e = await callWithPolicy({ transport: direct, models: [GLM, DEEPSEEK], messages: msgs, maxTokens: 1, fetchImpl: f, sleep: async (ms) => { waits.push(ms); } }).catch((x) => x);
    expect(waits).toEqual([10000, 20000]);
    expect(e).toBeInstanceOf(ApiError);
  });
  test("auth error is not retried", async () => {
    const { p, seen } = run([{ status: 401, json: cfErr(10000, "Authentication error") }]);
    expect(await p.catch((x) => x)).toBeInstanceOf(AuthError);
    expect(seen.length).toBe(1);
  });
  test("all models failing -> ApiError naming the last failure", async () => {
    const { p } = run([{ json: ok("") }, { json: ok("") }]);
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toContain("all models failed");
  });
  test("permanent (4xx) error whose message merely contains 'capacity' is not retried, falls straight to next model", async () => {
    const { p, seen } = run([
      { status: 400, json: cfErr(9001, "You have reached your neuron capacity limit for this billing period") },
      { json: ok("done") },
    ]);
    expect(await p).toMatchObject({ model: DEEPSEEK, calls: 2 });
    expect(seen.map((s) => s.body.model)).toEqual([GLM, DEEPSEEK]);
  });
  test("rate backoff aborts immediately if the caller's signal fires mid-wait, instead of completing the wait", async () => {
    const ac = new AbortController();
    let sleepCalls = 0;
    const hangingSleep = (_ms: number) =>
      new Promise<void>(() => {
        sleepCalls++;
        queueMicrotask(() => ac.abort());
      });
    const { f } = fakeFetch([{ status: 429, json: cfErr(429, "rate limited") }]);
    const e = await callWithPolicy({
      transport: direct, models: [GLM], messages: msgs, maxTokens: 1, fetchImpl: f, sleep: hangingSleep, signal: ac.signal,
    }).catch((x) => x);
    expect(sleepCalls).toBe(1);
    expect(e.name).toBe("AbortError");
  });
});
