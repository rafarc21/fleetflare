import type { Env } from "../env";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import { agentForProject, telegramConfig } from "../agents/registry";
import { getFlag, setFlag } from "../state";
import { sendMessage } from "./api";
import type { TaskRecord } from "../tasks/loop";
import { mintRepoToken } from "../github/auth";
import { writeProxyOn } from "../write-proxy/mode";
import { handleCallbackQuery, makeExecutor, type CallbackQuery } from "../approvals/gates";

interface TelegramUpdate {
  update_id?: number;
  message?: {
    from?: { id: number };
    chat?: { id: number };
    text?: string;
  };
  callback_query?: CallbackQuery;
}

export async function handleTelegramWebhook(
  req: Request,
  env: Env,
  project: string,
): Promise<Response> {
  // Board #334: Telegram off (or unconfigured) → this surface does not exist.
  const tg = telegramConfig(env);
  if (!tg) return new Response("not found", { status: 404 });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== tg.webhookSecret) {
    return new Response("forbidden", { status: 403 });
  }

  // Everything past the secret gate returns 200, and that has to include
  // failures to parse. An uncaught throw here surfaces as a runtime 500,
  // which Telegram retries — the exact retry storm this contract prevents.
  let update: TelegramUpdate;
  try {
    const parsed: unknown = await req.json();
    // `?.` below guards the children of `message`, not `update` itself, so a
    // body of the literal `null` would throw on property access.
    if (parsed === null || typeof parsed !== "object") return new Response("ok");
    update = parsed as TelegramUpdate;
  } catch {
    return new Response("ok");
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    // Same redelivery-dedup trick as update_id below: Telegram retries a
    // callback_query it never got a fast 2xx for, exactly like any other
    // update. This row's only job is to occupy `id` so a repeat is a silent
    // appendEvent no-op — handleCallbackQuery (src/approvals/gates.ts)
    // writes the real approval/report event(s), under its own id, once this
    // guard lets it through. kind:"decision" (declared in EventKind, unused
    // anywhere else in this codebase) rather than "human": a bare tap is
    // never an operator chat message, the same reason the command branches
    // below are kept out of the "human" stream too.
    const marker = makeEvent(
      { from: "human", to: "cto", kind: "decision", project, body: `callback_query ${cq.id}` },
      Date.now(),
      crypto.randomUUID().slice(0, 8),
    );
    marker.id = `cb_${project}_${cq.id}`;
    const isNew = await appendEvent(env.DB, marker);
    if (!isNew) return new Response("ok");

    // Same always-200 contract: Telegram retries a non-2xx callback too.
    try {
      await handleCallbackQuery(env, cq, makeExecutor(env), Date.now());
    } catch (err) {
      console.error("callback failed", err);
    }
    return new Response("ok");
  }

  const text = update.message?.text;
  const fromId = update.message?.from?.id;

  // Always 200 past this point: Telegram retries non-2xx, and a retry storm on
  // a message we intend to ignore is worse than the ignored message.
  if (!text || fromId === undefined) return new Response("ok");
  if (String(fromId) !== tg.operatorId) return new Response("ok");

  const agent = agentForProject(project, env);
  if (!agent) return new Response("ok");

  // Commands, not tasks: each returns before the event/dispatch machinery
  // below so a tap never counts as a task for the agent (no kind:"human"
  // event, no container spend) and a reply confirms the tap never landed
  // silently on the operator's phone.
  if (text === "/pause") {
    await setFlag(env.DB, "paused", "1", Date.now());
    try {
      await sendMessage(tg.token, agent.chatId, "Paused. New tasks are refused until /resume.");
    } catch (err) {
      console.error("pause notice failed", err);
    }
    return new Response("ok");
  }
  if (text === "/resume") {
    await setFlag(env.DB, "paused", "0", Date.now());
    try {
      await sendMessage(tg.token, agent.chatId, "Resumed.");
    } catch (err) {
      console.error("resume notice failed", err);
    }
    return new Response("ok");
  }
  if (text === "/stop") {
    try {
      const stub = env.AGENT.get(env.AGENT.idFromName(agent.id));
      const doRes = await stub.fetch("https://agent/abort", { method: "POST" });
      await doRes.text(); // drain: vitest-pool-workers isolated storage, same as /start below
    } catch (err) {
      console.error("stop dispatch failed", err);
    }
    try {
      await sendMessage(tg.token, agent.chatId, "Stopped.");
    } catch (err) {
      console.error("stop notice failed", err);
    }
    return new Response("ok");
  }

  const event = makeEvent(
    { from: "human", to: agent.id, kind: "human", project, body: text },
    Date.now(),
    crypto.randomUUID().slice(0, 8),
  );
  // Telegram redelivers the same update_id whenever it doesn't see a fast
  // 2xx (e.g. the LLM round trip below runs long and the request times out
  // from Telegram's side). Deriving the row's id from update_id, instead of
  // makeEvent's random one, turns that redelivery into a duplicate INSERT
  // that ON CONFLICT DO NOTHING silently absorbs — one event, one dispatch,
  // no second opus-effort turn, no second, possibly contradicting reply.
  // update_id is required on every real Telegram update; only fall back to
  // the random id if it's somehow missing, rather than let every such
  // malformed request collide on the same literal id.
  if (update.update_id !== undefined) {
    event.id = `tg_${project}_${update.update_id}`;
  }
  const inserted = await appendEvent(env.DB, event);
  if (!inserted) return new Response("ok"); // already handled — skip dispatch

  // Refuse a second concurrent run before spending a container on it.
  // Set by /pause above, cleared by /resume; survives a Worker redeploy
  // because it lives in D1, not memory.
  const paused = await getFlag(env.DB, "paused");
  if (paused === "1") {
    try {
      await sendMessage(tg.token, agent.chatId, "Fleet is paused. /resume to continue.");
    } catch (err) {
      // Same always-200 contract as the dispatch below: the event is
      // already logged, so a failed notice must not surface as a 500.
      console.error("paused notice failed", err);
    }
    return new Response("ok");
  }

  const taskId = `task_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
  const record: TaskRecord = {
    taskId, agentId: agent.id, project, thread: event.thread,
    chatId: agent.chatId, liveMessageId: null,
    startedTs: Date.now(), lastHeartbeat: Date.now(),
    failedPolls: 0, shownMilestones: 0,
  };

  // The event is already logged. Dispatch is best-effort delivery on top of
  // that, and it must obey the same always-200 contract as everything else
  // past the secret gate: an uncaught throw anywhere in here — resolving a
  // GitHub credential, or the DO's own fetch — surfaces as a REJECTED promise
  // (not a 500 Response), which becomes a runtime 500, which Telegram
  // retries. That retry is now a safe no-op (see the dedupe above), not a
  // duplicate event.
  // Issue #7: this legacy container gets a WRITE token for AGENT_REPO and
  // has none of the write proxy's wrappers or routing. A repo the operator
  // routed through the proxy must not get one by this door.
  if (writeProxyOn(env, env.AGENT_REPO)) {
    console.error(`agent dispatch skipped: ${env.AGENT_REPO} is on FLEET_WRITE_PROXY_REPOS (no write token to legacy agents)`);
    return new Response("ok");
  }
  try {
    const stub = env.AGENT.get(env.AGENT.idFromName(agent.id));
    const doRes = await stub.fetch("https://agent/start", {
      method: "POST",
      body: JSON.stringify({
        task: record,
        prompt: text,
        repo: env.AGENT_REPO,
        ref: env.AGENT_BASE_REF ?? "staging",
        ghToken: await mintRepoToken(env, env.AGENT_REPO),
      }),
    });
    const doBody = await doRes.text(); // drain: vitest-pool-workers isolated storage
    // The operator's message is already logged as an event either way. A busy
    // agent means it waits in the log, not that it vanished.
    if (doRes.status === 409) {
      await sendMessage(
        tg.token, agent.chatId,
        "Already working on something. Your message is queued — /stop to interrupt.",
      );
    } else if (!doRes.ok) {
      console.error("agent start rejected", doRes.status, doBody.slice(0, 300));
    }
  } catch (err) {
    console.error("agent dispatch failed", err);
  }
  return new Response("ok");
}
