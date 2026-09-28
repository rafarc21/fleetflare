import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { handleGithubWebhook } from "../src/github/webhook";
import { handleTelegramWebhook } from "../src/telegram/webhook";
import { directusConfig } from "../src/directus/client";
import type { Env } from "../src/env";

/**
 * Board issue #334 — public release. The legacy Telegram surface (AgentDO,
 * DeployDO approvals, operator alerts) and the Directus project card are
 * operator-specific: each is OFF unless its flag is exactly "on", and the
 * operator's Telegram id comes from config, never from code.
 */

const WEBHOOK_SECRET = "hook-secret";
const off = (over: Partial<Env> = {}) =>
  ({ ...env, FLEET_TELEGRAM: undefined, GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, ...over }) as unknown as Env;

let realFetch: typeof globalThis.fetch;
let telegramCalls: string[] = [];
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
  telegramCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.telegram.org")) telegramCalls.push(url);
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tgUpdate(fromId: number) {
  return new Request("https://fleet.test/tg/websites", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: fromId }, chat: { id: fromId }, text: "/status" } }),
  });
}

describe("FLEET_TELEGRAM off (#334)", () => {
  it("POST /tg/<project> is not found", async () => {
    const res = await worker.fetch(tgUpdate(999999), off(), {} as ExecutionContext);
    expect(res.status).toBe(404);
  });

  it("the cron watchdog never touches AgentDO", async () => {
    let agentGets = 0;
    const AGENT = { idFromName: (n: string) => n, get: () => { agentGets++; return { fetch: async () => Response.json({ task: null }) }; } };
    await worker.scheduled({} as ScheduledController, off({ AGENT } as unknown as Partial<Env>), {} as ExecutionContext);
    expect(agentGets).toBe(0);
  });

  it("an unapproved write is still recorded in D1, but no Telegram message is sent", async () => {
    const body = JSON.stringify({
      ref: "refs/heads/staging", after: "deadbeefcafe",
      repository: { full_name: "acme-org/websites" }, sender: { login: "someone" },
    });
    const req = new Request("https://fleet.test/gh", {
      method: "POST",
      headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body), "content-type": "application/json" },
      body,
    });
    const res = await handleGithubWebhook(req, off(), Date.now, { waitUntil: () => {} } as unknown as ExecutionContext);
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare("SELECT body FROM events").all<{ body: string }>();
    expect(results.some((e) => /UNAPPROVED WRITE/.test(e.body))).toBe(true);
    expect(telegramCalls).toEqual([]);
  });
});

describe("the operator's Telegram id comes from config (#334)", () => {
  it("a sender that is not TELEGRAM_OPERATOR_ID is ignored, whoever the old hardcoded id was", async () => {
    const on = { ...env, FLEET_TELEGRAM: "on", TELEGRAM_OPERATOR_ID: "111" } as unknown as Env;
    await handleTelegramWebhook(tgUpdate(999999), on, "websites");
    expect(telegramCalls).toEqual([]);
    const { results } = await env.DB.prepare("SELECT body FROM events").all();
    expect(results).toHaveLength(0);
  });
});

describe("FLEET_DIRECTUS (#334)", () => {
  const configured = { DIRECTUS_URL: "https://estate.example.com", DIRECTUS_TOKEN: "t" };
  it("is null unless the flag is on, even with URL and token set", () => {
    expect(directusConfig({ ...configured } as unknown as Env)).toBeNull();
  });
  it("with the flag on, the configured client is returned", () => {
    expect(directusConfig({ ...configured, FLEET_DIRECTUS: "on" } as unknown as Env)).not.toBeNull();
  });
});
