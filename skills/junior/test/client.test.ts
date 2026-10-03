// skills/junior/test/client.test.ts
// Issue #218: callOnce sends X-Junior-Mode only on proxy transport (never
// reaches Cloudflare's real chat-completions API, which must receive exactly
// what it receives today — apps/fleet/docs/plans/2026-10-03-junior-usage-
// counter-218.md's own design decision).
import { describe, expect, test } from "bun:test";
import { callOnce, callWithPolicy, GLM, type Transport } from "../src/client";

const direct: Transport = { kind: "direct", base: "https://x/v4", accountId: "acct", token: async () => "tok", source: "api-token" };
const proxy: Transport = { kind: "proxy", url: "https://w", spawnToken: "s".repeat(43) };
const ok = { content: "c", finish: "stop", usage: { in: 1, out: 1, neurons: null } };
const msgs = [{ role: "user" as const, content: "hi" }];

function fakeFetch() {
  const seen: { headers: Headers }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    seen.push({ headers: new Headers(init.headers) });
    return new Response(JSON.stringify(ok), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("callOnce X-Junior-Mode header", () => {
  test("proxy transport sends X-Junior-Mode matching the requested mode", async () => {
    const { f, seen } = fakeFetch();
    await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f, undefined, "text");
    expect(seen[0].headers.get("x-junior-mode")).toBe("text");
  });

  test("direct transport never sends X-Junior-Mode (the real Cloudflare API gets exactly what it gets today)", async () => {
    const { f, seen } = fakeFetch();
    await callOnce(direct, { model: GLM, messages: msgs, max_tokens: 5 }, f, undefined, "text");
    expect(seen[0].headers.has("x-junior-mode")).toBe(false);
  });
});

describe("callWithPolicy threads mode through to callOnce", () => {
  test("proxy transport: mode option reaches the header on the underlying call", async () => {
    const { f, seen } = fakeFetch();
    await callWithPolicy({
      transport: proxy, models: [GLM], messages: msgs, maxTokens: 5, mode: "text", fetchImpl: f,
    });
    expect(seen[0].headers.get("x-junior-mode")).toBe("text");
  });

  test("proxy transport: omitting mode defaults to edit", async () => {
    const { f, seen } = fakeFetch();
    await callWithPolicy({ transport: proxy, models: [GLM], messages: msgs, maxTokens: 5, fetchImpl: f });
    expect(seen[0].headers.get("x-junior-mode")).toBe("edit");
  });
});
