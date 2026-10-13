#!/usr/bin/env bun
// apps/fleet/scripts/model-smoke.ts — live smoke for one pool model (spec
// 2026-10-13-model-pool-design, "Entry rule": a model joins the pool
// (`smokePassed: true` in src/llm/models.ts) only after THIS script passes
// against the real, live Workers AI binding through the gateway — never run
// in a studio container (no Cloudflare credentials exist there; see
// docs/operations.md's "Model pool" section), only by the maestro.
import { modelByKey } from "../src/llm/models";
import { anthropicRequestToOpenAI, openAIResponseToAnthropic } from "../src/llm/translate";

const key = process.argv[2];
const m = key ? modelByKey(key) : undefined;
if (!m) {
  console.error("usage: bun scripts/model-smoke.ts glm|kimi|deepseek");
  process.exit(2);
}

const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const gw = process.env.GATEWAY_ID ?? "default";
if (!acct || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required");
  process.exit(2);
}

const url = `https://gateway.ai.cloudflare.com/v1/${acct}/${gw}/workers-ai/${m.id}`;
const tools = [
  {
    name: "get_weather",
    description: "weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
];

async function call(body: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(anthropicRequestToOpenAI(body, m!)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const first = { messages: [{ role: "user", content: "Call get_weather for Paris." }], tools, max_tokens: 1024 };

// 1. Tool call.
const r1 = openAIResponseToAnthropic(await (await call(first)).json().then((j: any) => j.result ?? j), { model: m.id });
const tu = r1.content.find((b: any) => b.type === "tool_use");
if (!tu || tu.name !== "get_weather" || String(tu.input?.city).toLowerCase() !== "paris") {
  console.error("SMOKE FAIL tool_call", JSON.stringify(r1.content).slice(0, 300));
  process.exit(1);
}

// 2. Multi-turn — feed the tool_result back, expect the final text to use it.
const second = {
  ...first,
  messages: [
    ...first.messages,
    { role: "assistant", content: r1.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "18C sunny" }] },
  ],
};
const r2 = openAIResponseToAnthropic(await (await call(second)).json().then((j: any) => j.result ?? j), { model: m.id });
if (!JSON.stringify(r2.content).includes("18")) {
  console.error("SMOKE FAIL multi_turn");
  process.exit(1);
}

// 3. Stream — same request, stream: true; just check the raw SSE shape.
const s = await call({ ...first, stream: true });
const text = await s.text();
if (!/data:/.test(text) || !/\[DONE\]|finish_reason/.test(text)) {
  console.error("SMOKE FAIL stream");
  process.exit(1);
}

console.log(`SMOKE PASS ${m.id}`);
