import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleTelegramWebhook } from "../src/telegram/webhook";
import { getFlag, setFlag } from "../src/state";
import { readSince } from "../src/events/log";

let started = 0;
let aborted = 0;
let realFetch: typeof globalThis.fetch;

const fakeAgent = {
  idFromName: (n: string) => n,
  get: () => {
    // env.AGENT.get() runs synchronously, one line before webhook.ts's
    // dispatch awaits mintRepoToken() to build the /start request
    // body. That mint is a hard-throwing Task-7 stub (src/github/app.ts)
    // until the GitHub App is wired, so stub.fetch(".../start") is never
    // actually reached today, even for a message that clears every gate —
    // empirically confirmed (see task-6-report.md) and the exact gap
    // test/telegram.webhook.test.ts's own dedupe test already documents and
    // works around the same way: counting the dispatch attempt at get(),
    // not at fetch()'s URL. /stop's fetch(".../abort") below needs no
    // token, so it *is* reached, and is still counted at fetch() by URL.
    started++;
    return {
      fetch: async (url: string) => {
        if (String(url).endsWith("/abort")) aborted++;
        return new Response("ok");
      },
    };
  },
};

function post(text: string, updateId: number) {
  return new Request("https://x/tg/websites", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET! },
    body: JSON.stringify({
      update_id: updateId,
      message: { from: { id: 100000001 }, chat: { id: 100000001 }, text },
    }),
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
  await env.DB.prepare("DELETE FROM fleet_state").run();
  started = 0; aborted = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ ok: true, result: { message_id: 1 } })) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

const withAgent = { ...env, AGENT: fakeAgent as any };

describe("commands", () => {
  it("/pause sets the flag and starts no task", async () => {
    await handleTelegramWebhook(post("/pause", 1), withAgent, "websites");
    expect(await getFlag(env.DB, "paused")).toBe("1");
    expect(started).toBe(0);
  });

  it("a message while paused does not reach the agent", async () => {
    await setFlag(env.DB, "paused", "1", 1);
    await handleTelegramWebhook(post("build the thing", 2), withAgent, "websites");
    expect(started).toBe(0);
  });

  it("/resume clears the flag and lets the next message through", async () => {
    await setFlag(env.DB, "paused", "1", 1);
    await handleTelegramWebhook(post("/resume", 3), withAgent, "websites");
    expect(await getFlag(env.DB, "paused")).toBe("0");
    await handleTelegramWebhook(post("build the thing", 4), withAgent, "websites");
    expect(started).toBe(1);
  });

  it("/stop aborts the running task", async () => {
    await handleTelegramWebhook(post("/stop", 5), withAgent, "websites");
    expect(aborted).toBe(1);
  });

  it("a command is not logged as a task for the agent", async () => {
    await handleTelegramWebhook(post("/pause", 6), withAgent, "websites");
    const events = await readSince(env.DB, "cto", 0);
    expect(events.filter((e) => e.kind === "human")).toEqual([]);
  });
});
