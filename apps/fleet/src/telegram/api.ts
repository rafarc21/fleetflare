import { chunk, TELEGRAM_LIMIT } from "./chunk";

const API = "https://api.telegram.org";

export async function sendMessage(token: string, chatId: string, text: string): Promise<number[]> {
  const ids: number[] = [];
  let sent = 0;
  for (const piece of chunk(text)) {
    // Telegram rejects a whitespace-only body. Skip the piece rather than
    // failing the whole send over a blank line.
    if (piece.trim() === "") continue;

    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: piece }),
    });
    if (!res.ok) {
      throw new Error(
        `telegram sendMessage failed after ${sent} piece(s): ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result: { message_id: number };
    };
    // Telegram reports logical failure in the body, not the status — the
    // same gap that shipped as a bug on setWebhook once already. res.ok
    // alone (checked above) is not enough: a 200 with {ok:false} (chat not
    // found, bot blocked, ...) must not be read as a successful send.
    if (body.ok !== true) {
      throw new Error(
        `telegram sendMessage failed after ${sent} piece(s): ${body.description ?? JSON.stringify(body)}`,
      );
    }
    ids.push(body.result.message_id);
    sent++;
  }

  // Delivering nothing must never be silent. This fires on empty or
  // whitespace-only input — a caller bug the operator needs to see, not a
  // no-op that looks like success.
  if (sent === 0) {
    throw new Error("telegram sendMessage delivered nothing: body was empty or whitespace-only");
  }
  return ids;
}

export async function setWebhook(token: string, url: string, secret: string): Promise<unknown> {
  const res = await fetch(`${API}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // "message" alone silently excludes callback_query: Telegram never
    // delivers a button tap, no error anywhere, and every approval gate goes
    // dead the moment this re-registers (the Worker rename makes
    // re-registration mandatory — spec §14). Every local test still passes,
    // since none of them go through Telegram's own registration filter.
    body: JSON.stringify({
      url, secret_token: secret, allowed_updates: ["message", "callback_query"],
    }),
  });
  // Telegram signals logical failure in the JSON body, not the HTTP status.
  // Returning it unchecked would let Task 7 register nothing and report success.
  const body = (await res.json()) as { ok?: boolean; description?: string };
  if (!res.ok || body.ok !== true) {
    throw new Error(
      `telegram setWebhook failed: ${res.status} ${body.description ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

function keyboard(buttons?: InlineButton[]) {
  // An empty inline_keyboard is how a keyboard is REMOVED on edit. Sending
  // undefined leaves the old buttons in place, so a decided approval gate
  // would stay tappable.
  if (!buttons || buttons.length === 0) return { inline_keyboard: [] };
  return {
    inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))],
  };
}

// Shared by the card/keyboard/callback methods below, all of which need the
// same body-vs-status failure check. sendMessage is deliberately NOT routed
// through this: its whitespace-skip and partial-delivery accounting are
// load-bearing and predate this helper.
async function call(token: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: TelegramApiResponse;
  try {
    parsed = JSON.parse(text) as TelegramApiResponse;
  } catch {
    throw new Error(`telegram ${method} returned unparseable body: ${text.slice(0, 300)}`);
  }
  // Telegram reports logical failure in the body, not the status. setWebhook
  // taught us this on Day 1; it is true of every method.
  if (!res.ok || parsed.ok !== true) {
    throw new Error(
      `telegram ${method} failed (${res.status}): ${parsed.description ?? text.slice(0, 300)}`,
    );
  }
  return parsed.result;
}

/**
 * Exactly one message. Truncates rather than chunking: the caller intends to
 * edit this message later, and "the message" is not a well-defined thing once
 * chunk() has produced several of them.
 */
export async function sendCard(
  token: string,
  chatId: string,
  text: string,
  buttons?: InlineButton[],
): Promise<number> {
  const body = text.length > TELEGRAM_LIMIT ? `${text.slice(0, TELEGRAM_LIMIT - 2)} …` : text;
  const result = await call(token, "sendMessage", {
    chat_id: chatId,
    text: body,
    reply_markup: keyboard(buttons),
  });
  return (result as { message_id: number }).message_id;
}

export async function editCard(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  buttons?: InlineButton[],
): Promise<void> {
  const body = text.length > TELEGRAM_LIMIT ? `${text.slice(0, TELEGRAM_LIMIT - 2)} …` : text;
  await call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: body,
    reply_markup: keyboard(buttons),
  });
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await call(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}
