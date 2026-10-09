// apps/fleet/src/llm/anthropic-route.ts
//
// POST /fleet/llm/anthropic/v1/messages — board issue #249, maestro decision
// 2 (2026-10-08T02:28Z STATUS): a `lead: glm` studio's `ANTHROPIC_BASE_URL`
// points here instead of the real Anthropic API. The Claude Code binary
// never changes — it still speaks the Anthropic Messages API — this route
// translates that wire shape to/from Workers AI's OpenAI-chat-completions
// shape (`env.AI.run("@cf/zai-org/glm-5.3", ...)`) and back, the same house
// rule `/fleet/junior` already follows: the Worker's own AI binding makes
// the call, so the container never holds a Cloudflare credential.
//
// Scope of THIS file: route + translation only (see translate.ts for every
// actual shape conversion). The admission-gate bypass, container env wiring
// (`lead: glm`, no CLAUDE_CODE_OAUTH_TOKEN) and burn/usage accounting are a
// separate, later change on top of this one — this route does not read or
// write any D1 usage row yet.
import type { Env } from "../env";
import { readCappedBody } from "../http/capped-body";
import { isSpawnTokenShaped, resolveSpawnParent, type SpawnParent } from "../studio/spawn";
import { listStudios } from "../studio/registry";
import type { StudioStatus } from "../studio/types";
import { checkAndConsumeLeadRateLimit } from "./ratelimit";
import { insertJuniorUsage } from "../junior/usage";
import {
  GLM_LEAD_MODEL, anthropicRequestToOpenAI, openAIResponseToAnthropic, classifyAiError,
  createStreamState, streamPrelude, applyOpenAIStreamChunk, closeStream, parseSseDataLine,
  streamErrorFrame,
} from "./translate";

export const ANTHROPIC_MESSAGES_PATH = "/fleet/llm/anthropic/v1/messages";

// deno-lint-ignore no-explicit-any
type Json = any;

// A lead's own conversation history is resent in full on every turn (same as
// the real Anthropic/OpenAI chat APIs — there is no server-side session
// state), so this is sized for a multi-turn session's accumulated context
// and tool output, not one bounded delegation call: 4x junior's own
// JUNIOR_BODY_CAP (2 MiB, sized for a single mechanical task body). Still a
// cap, not an exemption — a request genuinely this large is almost
// certainly a bug or an attack either way.
export const ANTHROPIC_BODY_CAP = 8 * 1024 * 1024;

const json = (body: Json, status: number) => Response.json(body, { status });
const text = (body: string, status: number) => new Response(body, { status });

/** Anthropic's own error-response envelope — see translate.ts's
 *  classifyAiError doc comment for the type/status table this fills in. */
function anthropicErrorBody(type: string, message: string): Json {
  return { type: "error", error: { type, message } };
}

/**
 * Claude Code, run with `ANTHROPIC_AUTH_TOKEN` set, sends it as `Authorization:
 * Bearer <token>` (maestro decision, #249 STATUS 2026-10-08T02:29Z). The
 * maestro's follow-up comment also accepts `x-api-key: <token>` — the header
 * the Anthropic SDK falls back to for some client configurations — "cheap,
 * robust to client variance". Either header, same spawn-token validation
 * (isSpawnTokenShaped/resolveSpawnParent) `/fleet/junior` already applies to
 * its own custom header; nothing about the TOKEN format differs by header.
 */
function extractPresentedToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== null) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m) return m[1];
  }
  return req.headers.get("x-api-key");
}

/** What `pumpAnthropicStream` resolves to — the real counts the caller logs
 *  through `insertJuniorUsage` (MAJOR 2/4), and whether the stream reached a
 *  genuine end (`ok: true`, `closeStream`'s normal frames were sent) or was
 *  cut short by an upstream failure (`ok: false`, a `streamErrorFrame` was
 *  sent instead — see MAJOR 3). */
interface PumpResult { inputTokens: number; outputTokens: number; ok: boolean }

/** Builds the Anthropic SSE byte stream for one request: the prelude,
 *  then every chunk the upstream OpenAI-compatible stream yields, translated
 *  through translate.ts's pure state machine, then the closing frames. Kept
 *  as its own function (rather than inlined into the handler) so the framing
 *  loop — decode, split on blank-line-delimited SSE frames, feed each
 *  `data:` line through parseSseDataLine — is the one and only place this
 *  file touches raw stream bytes.
 *
 * MAJOR 3 (maestro review round 1): a `reader.read()` throw (the upstream
 * Workers AI call failing PARTWAY through an already-started stream) used to
 * fall into this function's own `finally` block, which unconditionally ran
 * `closeStream` — the exact bug: a real mid-stream failure got silently
 * reported to the client as `end_turn` + `message_stop`, a normal end. Fixed
 * by catching the read failure explicitly, INSIDE the loop, and branching:
 * a mid-stream error emits `streamErrorFrame` instead of `closeStream`'s
 * frames, never both.
 */
async function pumpAnthropicStream(
  upstream: ReadableStream<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>,
  id: string, model: string,
): Promise<PumpResult> {
  const enc = new TextEncoder();
  const write = async (frames: string[]) => { for (const f of frames) await writer.write(enc.encode(f)); };

  await write(streamPrelude(id, model));
  const state = createStreamState();
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    let step: { done: boolean; value?: Uint8Array };
    try {
      step = await reader.read();
    } catch (e) {
      // The upstream failed after message_start (and possibly a content
      // block) already reached the client — a genuine mid-stream error, not
      // a normal end. See this function's own doc comment, MAJOR 3.
      const message = e instanceof Error ? e.message : String(e);
      await write([streamErrorFrame(message)]);
      return { inputTokens: state.inputTokens, outputTokens: state.outputTokens, ok: false };
    }
    const { done: readerDone, value } = step;
    if (readerDone) { done = true; buffer += decoder.decode(); } else { buffer += decoder.decode(value, { stream: true }); }
    // SSE frames are blank-line delimited; a frame can carry more than one
    // `data:` line (rare for this backend, but parseSseDataLine is run per
    // LINE regardless, same as the spec requires).
    const frames = buffer.split("\n\n");
    buffer = done ? "" : (frames.pop() ?? "");
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        const parsed = parseSseDataLine(line);
        if (parsed === "DONE" || parsed === null) continue;
        await write(applyOpenAIStreamChunk(state, parsed));
      }
    }
  }
  await write(closeStream(state));
  return { inputTokens: state.inputTokens, outputTokens: state.outputTokens, ok: true };
}

// MAJOR 2 (maestro review round 1): this route's own usage-log `mode` value
// — junior_usage_log's `mode` column otherwise only ever carries "edit"/
// "text" (junior/route.ts's JUNIOR_MODES), neither of which describes a lead
// turn. A distinct literal keeps a GLM-lead row visibly different from a
// junior delegation row in the SAME table, without needing a schema change.
const USAGE_MODE = "lead";

/** MAJOR 2: one `insertJuniorUsage` call, every exit path from this route
 *  that actually dispatched a request to `env.AI.run` (reused verbatim —
 *  same table, same shape junior/route.ts's own call site writes — see that
 *  file's own doc comment on why this is `ctx.waitUntil`, not a bare `void`:
 *  the Workers runtime can tear down this execution context the instant the
 *  response is returned/closes). Never throws into the caller — the
 *  `.catch(() => {})` matches insertJuniorUsage's own doc comment: a
 *  logging failure must never affect a response already on its way to the
 *  studio. */
function logUsage(
  env: Env, ctx: ExecutionContext, studioId: string, inputTokens: number, outputTokens: number, ok: boolean,
): void {
  ctx.waitUntil(insertJuniorUsage(env.DB, {
    id: crypto.randomUUID(), ts: Date.now(), studioId, mode: USAGE_MODE, model: GLM_LEAD_MODEL,
    inputTokens, outputTokens, ok,
  }).catch(() => {}));
}

export async function handleFleetAnthropicMessages(
  req: Request, env: Env, ctx: ExecutionContext,
  rows: () => Promise<StudioStatus[]> = () => listStudios(env),
): Promise<Response> {
  if (new URL(req.url).pathname !== ANTHROPIC_MESSAGES_PATH) return text("not found", 404);
  // MAJOR 2: reuses junior's OWN feature flag (same env.FLEET_JUNIOR !== "on"
  // check junior/route.ts:101 already applies) rather than inventing a
  // second, parallel on/off switch for a second Workers-AI-spending route —
  // one flag, one place an operator has to remember to flip.
  if (env.FLEET_JUNIOR !== "on" || !env.AI) return text("not found", 404);
  if (req.method !== "POST") return text("method not allowed", 405);

  // Cheapest possible refusal first, same order /fleet/junior already
  // applies (PR #9 review, F3): a declared Content-Length over the cap needs
  // no token check and no byte of the body ever read.
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > ANTHROPIC_BODY_CAP) return text("payload too large", 413);
  }

  const presented = extractPresentedToken(req);
  if (!isSpawnTokenShaped(presented)) return text("unauthorized", 401);
  const allRows = await rows();
  const studio: SpawnParent | null = await resolveSpawnParent(allRows, presented);
  if (!studio) return text("unauthorized", 401);
  // MAJOR 2 (BLOCKER-adjacent): spawn-token validity alone used to be the
  // entire gate — ANY studio's token, any leadType, could spend Workers AI
  // budget here with zero spend controls. `SpawnParent` (spawn.ts) carries
  // no `leadType` (it is a registry-row field, not part of the parent-
  // resolution shape every OTHER route needs), so the full `StudioStatus`
  // row is looked up here, by the same id resolveSpawnParent just verified
  // owns this token — the one field this route actually needs that
  // `SpawnParent` does not carry.
  const studioRow = allRows.find((r) => r.id === studio.id);
  if (studioRow?.leadType !== "glm") {
    return text("this route serves glm-led studios only", 403);
  }

  // F1 (junior/route.ts's own naming): only an authorized, flag-enabled,
  // correctly-led call consumes rate budget — checked after every refusal
  // above, before any body work or the AI call itself.
  //
  // Board issue #284, MAJOR 1: this used to reuse junior's own 5/min, 50/day
  // D1 counters directly — sized for occasional delegation calls, not a
  // full Claude Code agentic session making many Messages-API round trips
  // per minute, so a glm-lead studio got 429'd into uselessness almost
  // immediately. This route now has its OWN D1-backed per-minute/daily
  // counters (llm/ratelimit.ts), keyed by studio id but under distinct key
  // prefixes — genuinely separate budget from junior's, even though both
  // routes still spend out of the same underlying Workers AI quota.
  const rate = await checkAndConsumeLeadRateLimit(env.DB, env, studio.id, Date.now());
  if (!rate.ok) {
    return text(
      rate.limit === "per-minute"
        ? "rate limit exceeded: too many glm-lead calls this minute"
        : "rate limit exceeded: daily glm-lead cap reached",
      429,
    );
  }

  const raw = await readCappedBody(req, ANTHROPIC_BODY_CAP);
  if (raw === null) return text("payload too large", 413);
  let body: Json;
  try { body = JSON.parse(raw); } catch { return text("bad json", 400); }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return text("messages required", 400);
  if (typeof body?.max_tokens !== "number" || !(body.max_tokens > 0)) return text("max_tokens required", 400);

  const requestedModel = typeof body.model === "string" && body.model.length > 0 ? body.model : GLM_LEAD_MODEL;
  const openaiBody = anthropicRequestToOpenAI(body);
  const ai = env.AI;

  if (body.stream === true) {
    let upstream: Json;
    try {
      upstream = await ai.run(GLM_LEAD_MODEL, openaiBody);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const { status, type, message: overrideMessage } = classifyAiError(message);
      logUsage(env, ctx, studio.id, 0, 0, false);
      return json(anthropicErrorBody(type, overrideMessage ?? message), status);
    }
    if (!(upstream instanceof ReadableStream)) {
      // Defensive: the untyped fallback overload's return type is
      // `Promise<Record<string, unknown>>` for a non-streaming call, but
      // `stream: true` is documented (workers-types' sibling-model
      // `glm-4.7-flash` typed overload) to resolve to a ReadableStream. A
      // provider that ignored `stream: true` and returned a plain object
      // anyway is translated through the non-streaming path rather than
      // crashing on `.getReader()`.
      const anthropic = openAIResponseToAnthropic(upstream, { model: requestedModel });
      logUsage(env, ctx, studio.id, anthropic.usage.input_tokens, anthropic.usage.output_tokens, true);
      return json(anthropic, 200);
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const writer = writable.getWriter();
    // Detached, same fire-and-await-elsewhere shape /fleet/junior's own
    // heartbeat IIFE uses — the Response below returns `readable`
    // immediately; this is what actually fills it. MAJOR 2/4: the real
    // token counts (and whether the stream ended cleanly — MAJOR 3) only
    // exist once pumpAnthropicStream resolves, so the usage row is logged
    // from its own `.then()`, not alongside the other two call sites above.
    void pumpAnthropicStream(upstream, writer, id, requestedModel)
      .then((result) => logUsage(env, ctx, studio.id, result.inputTokens, result.outputTokens, result.ok))
      .catch(() => { /* client disconnected before the stream could even start writing — nothing to log or deliver */ })
      .finally(() => { writer.close().catch(() => {}); });
    return new Response(readable, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  let result: Json;
  try {
    result = await ai.run(GLM_LEAD_MODEL, openaiBody);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const { status, type, message: overrideMessage } = classifyAiError(message);
    logUsage(env, ctx, studio.id, 0, 0, false);
    return json(anthropicErrorBody(type, overrideMessage ?? message), status);
  }
  const anthropic = openAIResponseToAnthropic(result, { model: requestedModel });
  logUsage(env, ctx, studio.id, anthropic.usage.input_tokens, anthropic.usage.output_tokens, true);
  return json(anthropic, 200);
}
