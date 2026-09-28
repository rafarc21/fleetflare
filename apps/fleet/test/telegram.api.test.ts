import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendMessage, sendCard, editCard, answerCallbackQuery, setWebhook } from "../src/telegram/api";

interface Call { url: string; body: any }
let calls: Call[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, body: JSON.parse(init.body as string) });
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("telegram api", () => {
  it("sendMessage returns a message id per piece", async () => {
    const ids = await sendMessage("T", "99", "hello");
    expect(ids).toEqual([4242]);
    expect(calls[0].url).toContain("/botT/sendMessage");
    expect(calls[0].body.chat_id).toBe("99");
  });

  it("sendCard sends exactly one message even past the length limit", async () => {
    const long = "x".repeat(9000);
    const id = await sendCard("T", "99", long);
    expect(id).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text.length).toBeLessThanOrEqual(4096);
  });

  it("sendCard renders buttons as a Telegram inline keyboard", async () => {
    await sendCard("T", "99", "approve?", [
      { text: "Approve", callbackData: "appr_1:yes" },
      { text: "Reject", callbackData: "appr_1:no" },
    ]);
    expect(calls[0].body.reply_markup).toEqual({
      inline_keyboard: [[
        { text: "Approve", callback_data: "appr_1:yes" },
        { text: "Reject", callback_data: "appr_1:no" },
      ]],
    });
  });

  it("editCard targets a message and can clear the keyboard", async () => {
    await editCard("T", "99", 4242, "decided");
    expect(calls[0].url).toContain("/editMessageText");
    expect(calls[0].body.message_id).toBe(4242);
    expect(calls[0].body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("answerCallbackQuery posts the query id", async () => {
    await answerCallbackQuery("T", "cbq1", "already decided");
    expect(calls[0].url).toContain("/answerCallbackQuery");
    expect(calls[0].body.callback_query_id).toBe("cbq1");
  });

  it("throws when Telegram reports logical failure in the body", async () => {
    globalThis.fetch = (async () =>
      Response.json({ ok: false, description: "chat not found" })) as typeof globalThis.fetch;
    await expect(sendCard("T", "99", "hi")).rejects.toThrow(/chat not found/);
  });

  it("sendMessage throws when Telegram reports logical failure in the body", async () => {
    globalThis.fetch = (async () =>
      Response.json({ ok: false, description: "chat not found" })) as typeof globalThis.fetch;
    await expect(sendMessage("T", "99", "hi")).rejects.toThrow(/chat not found/);
  });

  it("setWebhook registers both message and callback_query updates", async () => {
    // MUST FIX 1: "message" alone silently excludes every button tap — no
    // error, no delivery, every approval gate dead the moment this
    // re-registers. Nothing else in this suite goes through Telegram's own
    // registration filter, so only asserting on the request body here would
    // ever have caught it.
    await setWebhook("T", "https://fleet.example/tg/websites", "s3cret");
    expect(calls[0].url).toContain("/botT/setWebhook");
    expect(calls[0].body.allowed_updates).toEqual(
      expect.arrayContaining(["message", "callback_query"]),
    );
    expect(calls[0].body.url).toBe("https://fleet.example/tg/websites");
    expect(calls[0].body.secret_token).toBe("s3cret");
  });

  it("setWebhook throws when Telegram reports logical failure in the body", async () => {
    globalThis.fetch = (async () =>
      Response.json({ ok: false, description: "bot token invalid" })) as typeof globalThis.fetch;
    await expect(setWebhook("T", "https://fleet.example/tg/websites", "s3cret"))
      .rejects.toThrow(/bot token invalid/);
  });
});
