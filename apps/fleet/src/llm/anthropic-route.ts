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
import {
  GLM_LEAD_MODEL, anthropicRequestToOpenAI, openAIResponseToAnthropic, classifyAiError,
  createStreamState, streamPrelude, applyOpenAIStreamChunk, closeStream, parseSseDataLine,
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

/** Builds the Anthropic SSE byte stream for one request: the prelude,
 *  then every chunk the upstream OpenAI-compatible stream yields, translated
 *  through translate.ts's pure state machine, then the closing frames. Kept
 *  as its own function (rather than inlined into the handler) so the framing
 *  loop — decode, split on blank-line-delimited SSE frames, feed each
 *  `data:` line through parseSseDataLine — is the one and only place this
 *  file touches raw stream bytes.
 */
async function pumpAnthropicStream(
  upstream: ReadableStream<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>,
  id: string, model: string,
): Promise<void> {
  const enc = new TextEncoder();
  const write = async (frames: string[]) => { for (const f of frames) await writer.write(enc.encode(f)); };

  await write(streamPrelude(id, model));
  const state = createStreamState();
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  try {
    while (!done) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) { done = true; buffer += decoder.decode(); } else { buffer += decoder.decode(value, { stream: true }); }
      // SSE frames are blank-line delimited; a frame can carry more than one
      // `data:` line (rare for this backend, but parseSseDataLine is run per
      // LINE regardless, same as the spec requires).
      const frames = buffer.split("\n\n");
      buffer = done ? "" : (frames.pop() ?? "");
      if (done) {
        // Nothing left to hold back for — process every remaining frame,
        // including a final one with no trailing blank-line delimiter.
      }
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          const parsed = parseSseDataLine(line);
          if (parsed === "DONE" || parsed === null) continue;
          await write(applyOpenAIStreamChunk(state, parsed));
        }
      }
    }
  } finally {
    await write(closeStream(state));
  }
}

export async function handleFleetAnthropicMessages(
  req: Request, env: Env, _ctx: ExecutionContext,
  rows: () => Promise<StudioStatus[]> = () => listStudios(env),
): Promise<Response> {
  if (new URL(req.url).pathname !== ANTHROPIC_MESSAGES_PATH) return text("not found", 404);
  if (!env.AI) return text("not found", 404);
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
  const studio: SpawnParent | null = await resolveSpawnParent(await rows(), presented);
  if (!studio) return text("unauthorized", 401);

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
      const { status, type } = classifyAiError(message);
      return json(anthropicErrorBody(type, message), status);
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
      return json(anthropic, 200);
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const writer = writable.getWriter();
    // Detached, same fire-and-await-elsewhere shape /fleet/junior's own
    // heartbeat IIFE uses — the Response below returns `readable`
    // immediately; this is what actually fills it.
    void pumpAnthropicStream(upstream, writer, id, requestedModel)
      .catch(() => { /* client disconnected or upstream errored mid-stream — nothing left to deliver to */ })
      .finally(() => { writer.close().catch(() => {}); });
    return new Response(readable, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  let result: Json;
  try {
    result = await ai.run(GLM_LEAD_MODEL, openaiBody);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const { status, type } = classifyAiError(message);
    return json(anthropicErrorBody(type, message), status);
  }
  const anthropic = openAIResponseToAnthropic(result, { model: requestedModel });
  return json(anthropic, 200);
}
