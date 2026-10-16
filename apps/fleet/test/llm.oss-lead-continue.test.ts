// apps/fleet/test/llm.oss-lead-continue.test.ts
// Issue #1112 layer 1: OSS leads (glm/kimi/deepseek behind the glm-lead
// Messages route) ended their turn after every step with todos still open.
// The router now appends a continue-until-todos-done rule to the lead's system
// prompt. These tests pin the pure transform and the route wiring: the rule
// reaches env.AI.run for the lead, and is NOT added to helper calls (Claude
// Code's small-model side requests, which carry a haiku-class model name).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleFleetAnthropicMessages, ANTHROPIC_MESSAGES_PATH } from "../src/llm/anthropic-route";
import { withOssLeadContinueRule, OSS_LEAD_CONTINUE_RULE } from "../src/llm/lead-rule";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { fakeCtx } from "./helpers/fake-ctx";

const ME = "acme-org--web-studio";

describe("withOssLeadContinueRule — pure transform", () => {
  it("appends the rule after an existing string system prompt", () => {
    const out = withOssLeadContinueRule({ model: "x", system: "You are a lead.", messages: [] });
    expect(out.system).toBe(`You are a lead.\n\n${OSS_LEAD_CONTINUE_RULE}`);
  });

  it("sets the rule as the system prompt when none is present", () => {
    const out = withOssLeadContinueRule({ model: "x", messages: [] });
    expect(out.system).toBe(OSS_LEAD_CONTINUE_RULE);
  });

  it("appends a text block when system is an array of content blocks", () => {
    const out = withOssLeadContinueRule({
      model: "x", messages: [], system: [{ type: "text", text: "base" }],
    });
    expect(out.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: OSS_LEAD_CONTINUE_RULE },
    ]);
  });

  it("does not mutate the caller's body", () => {
    const body = { model: "x", messages: [], system: "base" };
    withOssLeadContinueRule(body);
    expect(body.system).toBe("base");
  });

  it("is idempotent: applying twice adds the rule once", () => {
    const once = withOssLeadContinueRule({ model: "x", messages: [], system: "base" });
    const twice = withOssLeadContinueRule(once);
    expect(twice.system).toBe(once.system);
  });

  it("states the continue-until-todos-done rule in the words the issue specifies", () => {
    expect(OSS_LEAD_CONTINUE_RULE).toContain("Never end your turn while your todo list has pending or in_progress items");
    expect(OSS_LEAD_CONTINUE_RULE).toContain("unless you need operator input or are blocked");
  });
});

// Route wiring. Same fixture shape as llm.anthropic-core.test.ts: a glm-led
// studio row with a real spawn token, env.AI.run mocked.
function row(id: string, hash: string): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug: "acme-org/websites",
    leadType: "glm" };
}

let ctx: ReturnType<typeof fakeCtx>;

async function setup() {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token))];
  const run = vi.fn(async () => ({
    choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }));
  const e = { ...env, FLEET_JUNIOR: "on", AI: { run }, LEAD_AI_RETRY_BASE_MS: "1" } as unknown as Env;
  return { token, rows, run, e };
}

function postReq(token: string, body: unknown) {
  return new Request(`https://w${ANTHROPIC_MESSAGES_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function sentMessages(run: ReturnType<typeof vi.fn>): Array<{ role: string; content: unknown }> {
  const call = run.mock.calls[0] as unknown as [string, { messages: Array<{ role: string; content: unknown }> }];
  return call[1].messages;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await env.DB.prepare("DELETE FROM junior_usage_log").run();
  ctx = fakeCtx();
});

describe("handleFleetAnthropicMessages — OSS lead continue rule (#1112 layer 1)", () => {
  it("lead request: the rule reaches env.AI.run inside the system message", async () => {
    const { token, rows, run, e } = await setup();
    const r = await handleFleetAnthropicMessages(postReq(token, {
      model: "claude-opus-4-5", max_tokens: 100, system: "Lead base prompt.",
      messages: [{ role: "user", content: "do the thing" }],
    }), e, ctx, rows);
    expect(r.status).toBe(200);
    const sys = sentMessages(run).find((m) => m.role === "system");
    expect(sys).toBeDefined();
    expect(sys!.content).toContain("Lead base prompt.");
    expect(sys!.content).toContain(OSS_LEAD_CONTINUE_RULE);
  });

  it("lead request with no system prompt: the rule becomes the system message", async () => {
    const { token, rows, run, e } = await setup();
    const r = await handleFleetAnthropicMessages(postReq(token, {
      model: "claude-opus-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }],
    }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(sentMessages(run)[0]).toEqual({ role: "system", content: OSS_LEAD_CONTINUE_RULE });
  });

  it("helper request (haiku-class model name): no rule is added", async () => {
    const { token, rows, run, e } = await setup();
    const r = await handleFleetAnthropicMessages(postReq(token, {
      model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "title this" }],
    }), e, ctx, rows);
    expect(r.status).toBe(200);
    expect(sentMessages(run).some((m) => m.role === "system")).toBe(false);
    expect(JSON.stringify(run.mock.calls)).not.toContain(OSS_LEAD_CONTINUE_RULE);
  });
});
