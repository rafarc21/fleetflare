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
// separate, later change on top of this one — all three have since landed:
// admission via the spawn-token parent check below, container env wiring in
// src/studio/do.ts studioEnvVars (leadType "glm" skips CLAUDE_CODE_OAUTH_TOKEN),
// and burn/usage rows via logUsage below. (Also since then: issue #335's
// pre-stream retry via runAiWithRetry.)
import type { Env } from "../env";
import { readCappedBody } from "../http/capped-body";
import { isSpawnTokenShaped, resolveSpawnParent, type SpawnParent } from "../studio/spawn";
import { listStudios } from "../studio/registry";
import type { StudioStatus } from "../studio/types";
import { checkAndConsumeLeadCountTokensRateLimit, checkAndConsumeLeadRateLimit } from "./ratelimit";
import { parsePositiveInt } from "../ratelimit";
import { insertJuniorUsage } from "../junior/usage";
import {
  GLM_LEAD_MODEL, anthropicRequestToOpenAI, openAIResponseToAnthropic, classifyAiError,
  createStreamState, streamPrelude, applyOpenAIStreamChunk, closeStreamOrError, parseSseDataLine, runawayErrorFrame,
  parseStreamErrorChunk, streamErrorFrame, streamPing, runawayErrorMessage, runawayTokenEstimate,
} from "./translate";
import { isSmallModelName, pickModels } from "./router";
import { withOssLeadContinueRule } from "./lead-rule";
import { getAssignedModel, getModelStates, getRunawayAvoid, markRunawayAvoid, recordNoFinishReasonFailure, clearNoFinishReasonFailures, getNoFinishReasonFailures } from "./model-store";
import { POOL, modelById, type PoolModel } from "./models";

export const ANTHROPIC_MESSAGES_PATH = "/fleet/llm/anthropic/v1/messages";

/** Board issue #284, MINOR 4(b): the sibling Anthropic Messages API
 *  endpoint — some Anthropic SDK client configurations probe or call it to
 *  decide whether to compact context before sending a real request (Claude
 *  Code's own SDK may be one of them). Not mounted before this fix, so any
 *  request here fell through to the generic `/fleet/` catch-all and 404'd —
 *  see `handleFleetAnthropicCountTokens`'s own doc comment for the rest. */
export const ANTHROPIC_COUNT_TOKENS_PATH = "/fleet/llm/anthropic/v1/messages/count_tokens";

/** #1218: the synthetic studio id the triage daemon authenticates as. The
 *  messages/count_tokens routes' rate limits and usage rows key on this id,
 *  so the daemon draws its own lead-rate bucket and logs under a reserved id —
 *  never a real studio's spawn-token row. */
export const TRIAGE_DAEMON_ID = "triage--daemon";

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

/** A 429 without retry-after leaves Claude Code to guess its backoff;
 *  seconds rounded up so a client never retries before the window
 *  has actually rolled over. */
function rateLimitRefusal(message: string, retryAfterMs: number): Response {
  return Response.json(anthropicErrorBody("rate_limit_error", message), {
    status: 429,
    headers: { "retry-after": String(Math.ceil(retryAfterMs / 1000)) },
  });
}

/** Consume one unit of the lead rate budget; null = ok, a 429 Response =
 *  refused. The messages route's own limiter — per-minute + daily, with
 *  the refusal text and window math that route has always answered. */
async function consumeLeadRate(env: Env, studioId: string): Promise<Response | null> {
  const rate = await checkAndConsumeLeadRateLimit(env.DB, env, studioId, Date.now());
  return rate.ok ? null : rateLimitRefusal(
    rate.limit === "per-minute"
      ? "rate limit exceeded: too many glm-lead calls this minute"
      : "rate limit exceeded: daily glm-lead cap reached",
    rate.retryAfterMs,
  );
}

/** Same refusal shape as the messages route, but count_tokens' own text —
 *  a client told "too many glm-lead calls" on a count_tokens probe would
 *  misread its /messages budget as gone. */
async function consumeLeadCountTokensRate(env: Env, studioId: string): Promise<Response | null> {
  const rate = await checkAndConsumeLeadCountTokensRateLimit(env.DB, env, studioId, Date.now());
  return rate.ok ? null : rateLimitRefusal("rate limit exceeded: too many count_tokens calls this minute", rate.retryAfterMs);
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
 *  sent instead). Three distinct shapes all collapse to the same `ok: false`
 *  signal here, from this caller's own point of view: MAJOR 3's mid-stream
 *  `reader.read()` throw, and board issue #284's two silent-truncation
 *  shapes — (a) the stream ending without ever confirming a `finish_reason`
 *  and (b) an explicit upstream `{"error":...}` chunk mid-stream.
 *
 *  Issue #302: `failure` names WHICH abnormal end it was (see
 *  `failureReason`), so the usage row and the console line can tell an idle
 *  stall from an upstream error from a client that hung up. */
interface PumpResult { inputTokens: number; outputTokens: number; ok: boolean; failure?: string; /** #1228: the last 2 raw upstream `data:` payloads (model OUTPUT, never prompt). */ lastChunks?: string[] }

/** Issue #302: how long `pumpAnthropicStream` waits on one `reader.read()`
 *  before giving up on the upstream. A live GLM-lead run stalled ~8 minutes
 *  mid-stream; Claude Code only gives up after its own 600s client timeout,
 *  so the whole session sat idle. 90s clears GLM's normal ~60s calls (and the
 *  gaps between chunks inside one) with margin, and an `event: error` that
 *  early lets Claude Code retry within seconds. */
export const LEAD_STREAM_IDLE_MS_DEFAULT = 90_000;

/** `LEAD_STREAM_IDLE_MS` (env.ts), garbage-in -> default, same
 *  parsePositiveInt rule the lead rate limits use: a typo never disables the
 *  timeout. */
export function leadStreamIdleMs(env: { LEAD_STREAM_IDLE_MS?: string }): number {
  return parsePositiveInt(env.LEAD_STREAM_IDLE_MS, LEAD_STREAM_IDLE_MS_DEFAULT);
}

/** Issue #1147: how long the CLIENT may go without a byte before the streaming
 *  path sends one SSE `event: ping` (the clock runs from the last byte written
 *  to the client, not the last upstream chunk — a busy upstream whose output
 *  the client never sees still earns pings). 15s sits well under Claude Code's
 *  own client idle timeout, so a ping fires on any client-visible gap —
 *  including a long reasoning/prefill stretch with nothing to show — and never
 *  trips the client's own timeout. `LEAD_STREAM_PING_MS` (env.ts) — same
 *  garbage-in -> default rule as the idle timer. */
export const LEAD_STREAM_PING_MS_DEFAULT = 15_000;

export function leadStreamPingMs(env: { LEAD_STREAM_PING_MS?: string }): number {
  return parsePositiveInt(env.LEAD_STREAM_PING_MS, LEAD_STREAM_PING_MS_DEFAULT);
}

/** Issue #335: Workers AI throws `504 3046 Request timeout` (and the 529
 *  capacity shape) from inside env.AI.run, BEFORE any stream exists — the
 *  idle timer above never arms. Measured 2026-10-10 at up to 17% of calls.
 *  Those two statuses are retried up to LEAD_AI_MAX_RETRIES times; every
 *  other status (4xx, generic 500) goes back to the client unchanged. A
 *  retry only ever re-runs env.AI.run itself, so nothing is retried once a
 *  byte has gone to the client. */
export const LEAD_AI_MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([504, 529]);

/** Base backoff before retry n (0-based): `base * 2^n`, jittered down to
 *  half — 500ms gives [250,500] then [500,1000], at most 1.5s added to a
 *  call that would otherwise cost Claude Code a whole failed turn. */
export const LEAD_AI_RETRY_BASE_MS_DEFAULT = 500;

/** `LEAD_AI_RETRY_BASE_MS` (env.ts), same parsePositiveInt rule as
 *  leadStreamIdleMs. */
export function leadAiRetryBaseMs(env: { LEAD_AI_RETRY_BASE_MS?: string }): number {
  return parsePositiveInt(env.LEAD_AI_RETRY_BASE_MS, LEAD_AI_RETRY_BASE_MS_DEFAULT);
}

/** #767: same-model backoff schedule for a rate-limited (3021) upstream — the account window rolls over within a minute, so in-Worker waits beat a 429 that ends the client's whole turn. */
export const RATE_LIMIT_BACKOFF_MS = [3_000, 6_000, 12_000, 20_000] as const;
export const RATE_LIMIT_BACKOFF_CAP_MS = 45_000;

/** The last env.AI.run failure, plus how many attempts were spent. */
class AiRunError extends Error {
  constructor(message: string, readonly attempts: number) { super(message); }
}

/** Incident fix (#717): Task 4 (spec 2026-10-13-model-pool-design,
 *  Component 4) shipped an AI Gateway option attached to EVERY `env.AI.run`
 *  call, defaulting to the account's own `"default"` gateway id when
 *  `LEAD_AI_GATEWAY_ID` (env.ts) was unset. That default gateway was not
 *  actually provisioned for unified billing in production — every GLM lead
 *  call came back `"2021: Insufficient unified billing credits"` the instant
 *  it deployed. There is no default gateway id anymore: the option is
 *  attached ONLY when an operator has explicitly set `LEAD_AI_GATEWAY_ID` to
 *  a non-empty string (`resolveGatewayId` below); unset/empty means no
 *  gateway option at all, the exact pre-Task-4 `ai.run(model, body)` call
 *  shape (two arguments, not three with `undefined`). */
export function resolveGatewayId(env: { LEAD_AI_GATEWAY_ID?: string }): string | undefined {
  return env.LEAD_AI_GATEWAY_ID ? env.LEAD_AI_GATEWAY_ID : undefined;
}

/** Task 4: 429/code-3021 ("Account rate limit exceeded", the spec's own
 *  Problem-section wording) — the ONE failure shape that means "this model
 *  specifically is out of budget right now", so the overflow loop below
 *  moves to the next pool model immediately rather than retrying the same
 *  one. `\b3021\b` catches the bare error code even on upstream wording that
 *  doesn't also say "rate limit" in English (classifyAiError's own
 *  `/rate limit|too many/i` already covers the wording this spec's measured
 *  messages use, but the numeric code is the more durable signal). */
const isRateLimited = (message: string) => /\b3021\b|rate limit|too many/i.test(message);

/** Incident fix (#717 continued, production 2026-10-13): kimi (10/49 calls),
 *  deepseek (1/3) and GLM (2/18) all threw upstream 500s in the same 6-minute
 *  window — `4002: could not route request to AI model`, `8005: Internal
 *  server error` — that `runModelPoolOverflow`'s break condition below used
 *  to treat as terminal (classifyAiError has no special case for either, so
 *  both fall through to its generic `{status: 500, type: "api_error"}`
 *  bucket, same as any other unrecognized message — see that function's own
 *  doc comment). A genuine per-request 500 is not something another model
 *  would answer differently in general, but THESE specific shapes are: they
 *  say the upstream couldn't route/serve the request at all, not that the
 *  request itself was bad. Same overflow posture as `isRateLimited`/3021 —
 *  move to the NEXT model immediately, no same-model backoff/retry (unlike
 *  504/529, which exhaust `runAiWithRetry`'s same-model retry first) — but
 *  kept as its OWN predicate rather than folded into `isRateLimited` itself:
 *  `isRateLimited` is also read at the final all-exhausted call site below to
 *  decide whether to report 429 `rate_limit_error` instead of
 *  `classifyAiError`'s own status/type, and these are not rate-limit errors —
 *  widening `isRateLimited` would have silently turned an exhausted 4002/8005
 *  run into a misreported 429 there too. Scoped to this loop's own error
 *  classification only, per the incident's own ask — `classifyAiError`'s
 *  status/type mapping for these strings is untouched.
 *
 *  Code review (Standards axis, #717): matches on the bare numeric codes
 *  ONLY, not on the generic phrases that originally accompanied them. The
 *  known incident strings — `"500 api_error: 4002: could not route request
 *  to AI model"` and `"8005: Internal server error"` — both already contain
 *  their own numeric code, so `\b4002\b|\b8005\b` matches them exactly
 *  without needing a bare `could not route` or `internal server error`
 *  alternative. A bare `internal server error` alternative in particular
 *  would have matched the literal generic HTTP 500 reason phrase from ANY
 *  model's genuinely-terminal, unrelated 500 — silently routing it to the
 *  next model instead of failing fast as the paragraph above requires. */
const isOverflowRoutingError = (message: string) => /\b4002\b|\b8005\b/i.test(message);

/** env.AI.run with issue #335's pre-stream retry. Resolves to the first
 *  successful value and the attempt count; rejects with AiRunError carrying
 *  the last upstream message. `sleep`/`random` are injectable for tests. */
export async function runAiWithRetry<T>(
  run: () => Promise<T>,
  opts: { baseMs: number; sleep?: (ms: number) => Promise<void>; random?: () => number },
): Promise<{ value: T; attempts: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await run(), attempts: attempt };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (attempt > LEAD_AI_MAX_RETRIES || !RETRYABLE_STATUSES.has(classifyAiError(message).status)) {
        throw new AiRunError(message, attempt);
      }
      const ceiling = opts.baseMs * 2 ** (attempt - 1);
      await sleep(ceiling / 2 + random() * (ceiling / 2));
    }
  }
}

/** #767: runAiWithRetry plus same-model backoff when the exhaustion was a rate limit: up to 4 extra rounds on the jittered schedule, cumulative sleep capped. Any other failure rethrows immediately. */
export async function runAiWithRateLimitBackoff<T>(
  run: () => Promise<T>,
  opts: { baseMs: number; sleep?: (ms: number) => Promise<void>; random?: () => number },
): Promise<{ value: T; attempts: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  let attempts = 0;
  let slept = 0;
  for (let round = 0; ; round++) {
    try {
      const r = await runAiWithRetry(run, opts);
      return { value: r.value, attempts: attempts + r.attempts };
    } catch (e) {
      if (!(e instanceof AiRunError)) throw e;
      attempts += e.attempts;
      const message = e.message;
      if (round >= RATE_LIMIT_BACKOFF_MS.length || !isRateLimited(message)) {
        throw new AiRunError(message, attempts);
      }
      const ms = Math.min(RATE_LIMIT_BACKOFF_MS[round] * (0.7 + 0.6 * random()), RATE_LIMIT_BACKOFF_CAP_MS - slept);
      if (ms > 0) { await sleep(ms); slept += ms; }
    }
  }
}

const IDLE = Symbol("idle");
const PING = Symbol("ping");
const ABORTED = Symbol("aborted");

/** Issue #1147: one pending `reader.read()`, raced against three clocks: the
 *  idle deadline (`idleLeftMs`, counted from the last upstream byte by the
 *  caller, so a ping never resets it), the keepalive tick (`pingLeftMs`, time
 *  left until the client's own silence reaches the ping interval; 0 turns it
 *  off), and the client's abort signal. Resolves `PING` on a keepalive tick,
 *  `IDLE` on the deadline, `ABORTED` when the client has gone. A losing read
 *  stays pending — the caller keeps it and races it again after a PING, or
 *  cancels the reader, which settles it, so nothing dangles. */
function raceUpstream(
  read: Promise<ReadableStreamReadResult<Uint8Array>>, idleLeftMs: number, pingLeftMs: number, signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array> | typeof IDLE | typeof PING | typeof ABORTED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const clock = new Promise<typeof IDLE | typeof PING | typeof ABORTED>((resolve) => {
    const idleFirst = pingLeftMs <= 0 || idleLeftMs <= pingLeftMs;
    timer = setTimeout(() => resolve(idleFirst ? IDLE : PING), Math.max(0, idleFirst ? idleLeftMs : pingLeftMs));
    if (signal) {
      onAbort = () => resolve(ABORTED);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([read, clock]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/** Thrown by `pumpAnthropicStream`'s own `write` when the client side of the
 *  TransformStream is gone — the one failure that is not the upstream's. */
class ClientAbort extends Error {}

/** Issue #1147 (review round 2): `p` settles, or the client's abort signal
 *  fires, or `boundMs` (> 0) passes — whichever comes first. The loser's
 *  listener and timer are cleared. Signal or bound rejects with ClientAbort:
 *  a write stuck on backpressure must not outlive a client that has gone, and
 *  a keepalive ping the client has not read for a whole interval counts as
 *  gone. With neither a signal nor a bound this is just `p`. */
function settleOrGone(p: Promise<unknown>, signal: AbortSignal | undefined, boundMs: number): Promise<unknown> {
  if (!signal && boundMs <= 0) return p;
  let rejectGone!: (e: Error) => void;
  const gone = new Promise<never>((_, reject) => { rejectGone = reject; });
  const abort = () => rejectGone(new ClientAbort());
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  if (boundMs > 0) timer = setTimeout(abort, boundMs);
  return Promise.race([p, gone]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
}

/** Issue #302: `<class> <anthropic error type>: <upstream message>` — the
 *  class says where it broke, the type is classifyAiError's own mapping of
 *  the upstream message. Messages come from the upstream/runtime, never from
 *  the request body. */
function failureReason(kind: string, message: string): string {
  return `${kind} ${classifyAiError(message).type}: ${message}`;
}

/** Board issue #304: the console line names the class/status only — an
 *  upstream error message can echo request input, and `wrangler tail`
 *  output outlives the request. */
export function failureClass(failure: string): string {
  const colon = failure.indexOf(":");
  return colon === -1 ? failure : failure.slice(0, colon);
}

// ---------------------------------------------------------------------------
// Issue #1228: request fingerprinting for no_finish_reason diagnosis
// ---------------------------------------------------------------------------

/** What `computeRequestFingerprint` resolves to — enough to identify a poison
 *  request and reason about its shape WITHOUT ever logging raw prompt bytes. */
interface RequestFingerprint {
  /** SHA-256 of the whole raw body (the durable "identical input" signal). */
  fingerprintHash: string;
  bodyBytes: number;
  toolCount: number;
  /** SHA-256 + byte length of the LAST tool_result's flattened content, or
   *  `""`/`0` when the request carried none. */
  lastToolResultHash: string;
  lastToolResultBytes: number;
}

/** Issue #1228: a poison request recurs even after /clear (fresh message
 *  history), so the poison lives in system/tools/request shape — the whole
 *  raw body is the fingerprint, and the last tool_result + tool count say
 *  where. Everything here is hashes or sizes; no raw content reaches a log. */
async function computeRequestFingerprint(raw: string, body: Json): Promise<RequestFingerprint> {
  const toolCount = Array.isArray(body?.tools) ? body.tools.length : 0;
  let lastToolResultHash = "";
  let lastToolResultBytes = 0;
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type === "tool_result") {
        // Same flatten as translate.ts's flattenTextLike (string | [{text}]).
        const content = typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content)
            ? b.content.filter((x: Json) => x && x.type === "text" && typeof x.text === "string").map((x: Json) => x.text).join("\n\n")
            : "";
        lastToolResultBytes = new TextEncoder().encode(content).byteLength;
        lastToolResultHash = await sha256Hex(content);
      }
    }
  }
  // Finding 4 (fresh-context review of #1228, PR #1235): `raw.length` counts
  // UTF-16 code units, not bytes -- every sibling field here already uses
  // TextEncoder for a real byte count; this one must too.
  const bodyBytes = new TextEncoder().encode(raw).byteLength;
  return { fingerprintHash: await sha256Hex(raw), bodyBytes, toolCount, lastToolResultHash, lastToolResultBytes };
}

/** Issue #1228: the one console line a no_finish_reason failure writes, in
 *  addition to `logUsage`'s own line. Carries ONLY hashes and sizes — never
 *  prompt text. `lastChunks` is model OUTPUT (already sent toward the client),
 *  logged as SHA-256 hashes + byte sizes anyway for consistency. */
async function logNoFinishReasonFingerprint(
  studioId: string, fingerprint: RequestFingerprint, lastChunks: string[] | undefined,
  inputTokens: number, outputTokens: number,
): Promise<void> {
  const chunkHashes: string[] = [];
  for (const c of lastChunks ?? []) chunkHashes.push(`${new TextEncoder().encode(c).byteLength}b:${await sha256Hex(c)}`);
  console.error(
    `[glm-lead] no_finish_reason studio=${studioId} fingerprint=${fingerprint.fingerprintHash} bodyBytes=${fingerprint.bodyBytes} tools=${fingerprint.toolCount} lastToolResult=${fingerprint.lastToolResultBytes}b:${fingerprint.lastToolResultHash || "-"} lastChunks=${chunkHashes.length > 0 ? chunkHashes.join(",") : "-"} usageIn=${inputTokens} usageOut=${outputTokens}`,
  );
}

/** Code review (Standards axis, #1228 fresh-context review, Finding 6):
 *  "record this out=0 no_finish_reason failure, check the 3-strike poison
 *  threshold, and answer with the matching body" — the `noFinishExhausted`
 *  branch (every pool candidate exhausted) and the final collected-failure
 *  branch (no next model to fail over to at all) in
 *  `handleFleetAnthropicMessages` used to each carry their own identical
 *  copy of this. One shared helper means Finding 1's bug class (the
 *  `outputTokens === 0` gate) only has one place left it could recur on.
 *  Returns the streak count too — the `noFinishExhausted` call site's own
 *  usage row still wants it in its failure message. */
async function recordAndRespondNoFinish(
  db: D1Database, studioId: string, fingerprintHash: string,
): Promise<{ n: number; response: Response }> {
  const n = await recordNoFinishReasonFailure(db, studioId, fingerprintHash);
  // Issue #1228 (3): after 3 identical-input failures the request is proven
  // poisonous — stop the client's 12x retry loop with a non-retriable 400.
  // Before that threshold it is a normal retriable overload (529), the
  // shape that moves the client's turn on.
  const response = n >= 3
    ? json(anthropicErrorBody("invalid_request_error", "upstream repeatedly failed to complete this request; compact context and retry"), 400)
    : json(anthropicErrorBody("overloaded_error", "upstream stream ended without a finish reason; retry the turn"), 529);
  return { n, response };
}

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
 *
 * Board issue #284: two more silent-truncation shapes, same "never fake a
 * normal end" discipline as MAJOR 3 above —
 *   (a) the upstream stream ends (reader naturally completes) WITHOUT ever
 *       sending a chunk that carries a `finish_reason` at all. Checked via
 *       `closeStreamOrError` (translate.ts) once the read loop ends, instead
 *       of calling `closeStream` directly — see that function's own doc
 *       comment for why the check lives there, layered on top of
 *       `closeStream`, rather than inside it.
 *   (b) the upstream sends an explicit `{"error": {...}}` chunk mid-stream
 *       (some OpenAI-compatible backends use this shape instead of, or
 *       interleaved with, a normal `{choices: [...]}` chunk). Checked via
 *       `parseStreamErrorChunk` BEFORE handing the parsed chunk to
 *       `applyOpenAIStreamChunk` — that function's own `chunk?.choices?.[0]`
 *       is `undefined` for a chunk shaped like this, so without this check
 *       the real upstream error message would be silently discarded instead
 *       of reaching the client at all.
 * Both report `ok: false` to this function's own caller, same "stream ended
 * abnormally" signal MAJOR 3's mid-stream-throw case already reports.
 *
 * Issue #302: two more abnormal ends, same discipline —
 *   (c) the upstream goes quiet: no chunk for `idleMs`. `reader.read()` is
 *       raced against an idle timer (raceUpstream); on timeout the
 *       upstream read is cancelled and an `event: error` goes out, so Claude
 *       Code retries now instead of after its own 600s client timeout.
 *   (d) the client hangs up: a `writer.write` rejects. The upstream read is
 *       cancelled (no point paying for tokens nobody reads) and the call is
 *       reported as `client_abort`, not an upstream failure.
 * Every abnormal end now also carries `failure` (see PumpResult).
 *
 * `requestedMaxTokens` (fresh-context review, #717 critical follow-up): the
 * INBOUND Anthropic request's own `max_tokens`, threaded to
 * `closeStreamOrError` (translate.ts) so the final `message_delta.usage.
 * output_tokens` frame is clamped the same way the non-streaming path's
 * `openAIResponseToAnthropic` call already is — the streaming path was the
 * one left genuinely unprotected: GLM's self-reported `completion_tokens`
 * (inflated by `reasoning_content`) used to reach the client verbatim here,
 * which is what actually broke live GLM-lead studios mid-turn (they stream
 * by default). Also clamps the `outputTokens` this function itself resolves
 * to on a clean end, below — the SAME number `handleFleetAnthropicMessages`
 * logs into the D1 usage row, kept consistent with what the client was
 * actually told rather than the raw, possibly-inflated upstream figure.
 *
 * Issue #1147: `keepalive.pingMs` > 0 writes one `event: ping` each time that
 * long passes with no byte written to the CLIENT (the idle deadline is NOT
 * reset by a ping, so a dead upstream still times out). Review round 2: the
 * clock follows the client, so upstream chunks the translator drops
 * (reasoning_content, buffered think tags) do not suppress pings. `keepalive.
 * signal` is the client's own request signal: an abort ends the pump as
 * `client_abort` at once, even while a write is stuck on backpressure. A ping
 * write is bounded by pingMs; a client that has not read a whole interval is
 * treated as gone. The non-streaming path passes pingMs 0 — its reply is
 * folded into one JSON body, so a ping has nowhere to go — but still passes
 * the signal.
 */
export async function pumpAnthropicStream(
  upstream: ReadableStream<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>,
  id: string, model: string, requestedMaxTokens: number, idleMs: number, poolModel?: PoolModel,
  keepalive: { pingMs: number; signal?: AbortSignal } = { pingMs: 0 },
): Promise<PumpResult> {
  const enc = new TextEncoder();
  // Issue #1147 (review round 2): `lastWriteAt` is the last byte the CLIENT got.
  // The ping clock runs from it, so a busy upstream the client never sees still
  // earns pings. Each write races the client's signal; a ping is also bounded
  // by the ping interval, so a client that has stopped reading counts as gone.
  let lastWriteAt = Date.now();
  const write = async (frames: string[], boundMs = 0) => {
    for (const f of frames) {
      try { await settleOrGone(writer.write(enc.encode(f)), keepalive.signal, boundMs); } catch { throw new ClientAbort(); }
      lastWriteAt = Date.now();
    }
  };
  const state = createStreamState({ thinkTags: poolModel?.thinkTags === true });
  const reader = upstream.getReader();
  const cancelUpstream = () => { reader.cancel().catch(() => {}); };
  // Issue #1228: the last 2 raw upstream `data:` payloads, kept so a
  // no_finish_reason fingerprint can say WHAT the upstream last emitted. These
  // are model output only — never the request body — so they are safe to log
  // (as hashes, not raw bytes).
  const lastChunks: string[] = [];
  // Issue #1099 (review, finding 5): an aborted runaway never gets the upstream
  // usage chunk, so its output count is the scan's own estimate (see
  // runawayTokenEstimate) rather than the 0 the stream would otherwise report.
  const end = (ok: boolean, failure?: string): PumpResult => ({
    inputTokens: state.inputTokens,
    outputTokens: ok ? Math.min(state.outputTokens, requestedMaxTokens)
      : failure?.startsWith("runaway:") ? Math.min(Math.max(state.outputTokens, runawayTokenEstimate(state)), requestedMaxTokens)
      : state.outputTokens,
    ok, ...(failure === undefined ? {} : { failure }), lastChunks: [...lastChunks],
  });

  try {
    await write(streamPrelude(id, model));
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    // Issue #1147: one read stays pending across keepalive ticks; a new one is
    // issued only after the last chunk is consumed. The idle clock runs from
    // the last upstream byte, not from the last tick.
    let pending = reader.read();
    pending.catch(() => {}); // settled by the race below; this only stops an early unhandled-rejection report
    let lastUpstreamAt = Date.now();
    while (!done) {
      // The keepalive clock is the CLIENT's silence, not the upstream's.
      const pingLeftMs = keepalive.pingMs > 0 ? Math.max(1, lastWriteAt + keepalive.pingMs - Date.now()) : 0;
      let step: ReadableStreamReadResult<Uint8Array> | typeof IDLE | typeof PING | typeof ABORTED;
      try {
        step = await raceUpstream(pending, lastUpstreamAt + idleMs - Date.now(), pingLeftMs, keepalive.signal);
      } catch (e) {
        // The upstream failed after message_start (and possibly a content
        // block) already reached the client — a genuine mid-stream error, not
        // a normal end. See this function's own doc comment, MAJOR 3.
        const message = e instanceof Error ? e.message : String(e);
        await write([streamErrorFrame(message)]);
        return end(false, failureReason("upstream_read_error", message));
      }
      if (step === PING) {
        await write([streamPing()], keepalive.pingMs);
        continue;
      }
      if (step === ABORTED) throw new ClientAbort();
      if (step === IDLE) {
        // Issue #302 (c): cancel first, so the upstream is released even if
        // the error frame can no longer be written. A client that also left
        // meanwhile does not hide the stall: the reason stays idle_timeout.
        cancelUpstream();
        // Bounded by the idle deadline: a client that stopped reading must not
        // hold the call open past it (review round 2, merged from e082ef00).
        await write([streamErrorFrame(`upstream stream idle timeout: no data for ${idleMs}ms`)], idleMs).catch(() => {});
        return end(false, `idle_timeout after ${idleMs}ms`);
      }
      const { done: readerDone, value } = step;
      lastUpstreamAt = Date.now();
      if (!readerDone) { pending = reader.read(); pending.catch(() => {}); }
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
          lastChunks.push(line.slice(5).trim());
          if (lastChunks.length > 2) lastChunks.shift();
          // Board issue #284 (b): an explicit upstream error chunk — checked
          // BEFORE applyOpenAIStreamChunk, which would otherwise see no
          // `choices[0]` on a chunk shaped like this and silently no-op.
          const errorMessage = parseStreamErrorChunk(parsed);
          if (errorMessage !== null) {
            cancelUpstream();
            await write([streamErrorFrame(errorMessage)]);
            return end(false, failureReason("upstream_error_chunk", errorMessage));
          }
          await write(applyOpenAIStreamChunk(state, parsed));
          // Issue #1099: a degenerate text/reasoning run. Abort upstream (no
          // more tokens paid for) and end with a retriable overloaded_error.
          if (state.runaway !== null) {
            cancelUpstream();
            await write([runawayErrorFrame(state.runaway)]);
            return end(false, `runaway:${state.runaway}`);
          }
        }
      }
    }
    // Board issue #284 (a): closeStreamOrError (translate.ts) checks whether
    // the stream ever confirmed a finish_reason before emitting closeStream's
    // normal frames — see that function's own doc comment.
    const closed = closeStreamOrError(state, requestedMaxTokens);
    await write(closed.frames);
    return end(closed.ok, closed.ok ? undefined : closed.reason);
  } catch (e) {
    if (!(e instanceof ClientAbort)) throw e;
    // Issue #302 (d).
    cancelUpstream();
    return end(false, "client_abort");
  }
}

/** Issue #1099 (review round 3, finding 3): the non-streaming reply is built from
 *  the stream translator's own frames. pumpAnthropicStream writes them into a
 *  buffer, so the non-streaming path shares the stream's finish_reason, runaway
 *  and error handling (closeStreamOrError) instead of a second reassembly. */
async function collectAnthropicFrames(
  upstream: ReadableStream<Uint8Array>, id: string, model: string, requestedMaxTokens: number,
  idleMs: number, poolModel: PoolModel | undefined, signal?: AbortSignal,
): Promise<{ result: PumpResult; sse: string }> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const sse = new Response(readable).text();
  const result = await pumpAnthropicStream(upstream, writer, id, model, requestedMaxTokens, idleMs, poolModel, { pingMs: 0, signal })
    .finally(() => writer.close().catch(() => {}));
  return { result, sse: await sse };
}

/** The translator's SSE frames, parsed back to event name and JSON data. */
function parseFrames(sse: string): Array<{ event: string; data: Json }> {
  const out: Array<{ event: string; data: Json }> = [];
  for (const frame of sse.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (event !== undefined && data !== undefined) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

/** The message of the translator's `event: error` frame, if the stream ended in one. */
function errorFrameMessage(sse: string): string | null {
  return parseFrames(sse).find((f) => f.event === "error")?.data.error?.message ?? null;
}

/** Folds the translator's frames into one Anthropic Messages reply (the
 *  non-streaming shape). A malformed tool argument becomes an empty input, the
 *  same as openAIResponseToAnthropic. */
function foldAnthropicFrames(sse: string): Json {
  const message: Json = {
    id: "", type: "message", role: "assistant", model: "", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
  };
  const toolArgs = new Map<number, string>();
  for (const { event, data } of parseFrames(sse)) {
    if (event === "message_start") Object.assign(message, data.message);
    else if (event === "content_block_start") {
      message.content[data.index] = { ...data.content_block };
      if (data.content_block.type === "tool_use") toolArgs.set(data.index, "");
    } else if (event === "content_block_delta") {
      const block = message.content[data.index];
      if (data.delta.type === "text_delta") block.text += data.delta.text;
      else toolArgs.set(data.index, (toolArgs.get(data.index) ?? "") + data.delta.partial_json);
    } else if (event === "content_block_stop" && toolArgs.has(data.index)) {
      let input: Json = {};
      try { input = JSON.parse(toolArgs.get(data.index) || "{}"); } catch { /* malformed args: empty input, as openAIResponseToAnthropic */ }
      message.content[data.index].input = input;
    } else if (event === "message_delta") {
      message.stop_reason = data.delta.stop_reason;
      message.usage = data.usage;
    }
  }
  return message;
}

/** Shared gate both `/fleet/llm/anthropic/v1/messages` handlers in this file
 *  enforce before either one's OWN logic runs — extracted here (board issue
 *  #284 review follow-up) after `handleFleetAnthropicMessages` and
 *  `handleFleetAnthropicCountTokens` were found to duplicate this ~20-line
 *  block verbatim, down to the error strings: path check, the
 *  `FLEET_JUNIOR`/`env.AI` feature flag, method check, declared-Content-
 *  Length cap, spawn-token extraction/validation
 *  (`extractPresentedToken`/`isSpawnTokenShaped`/`resolveSpawnParent`), and
 *  the `leadType === "glm"` gate. See `handleFleetAnthropicMessages`'s own
 *  (now-removed) inline comments for why each individual check exists —
 *  this function only collects them into one place so both routes keep
 *  enforcing the exact same thing. The rate limit stays OUT of this shared
 *  gate, applied by each route itself right after the gate — the messages
 *  route enforces its per-minute/daily limiter, count_tokens its OWN
 *  per-minute-only one (separate D1 prefix, no daily cap), each at its own
 *  position (before any body work), keeping the gate's own contract
 *  "refusal or studio, nothing spent".
 *
 *  Returns either an early refusal `Response` (any one of the checks above
 *  failing) or the resolved `studio`/`allRows` the caller needs to proceed —
 *  a caller only has work left to do once it gets the latter back.
 */
/** #1218: SHA-256 hex of a string, same helper shape org.ts's hashSpawnToken
 *  uses. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** #1218: constant-time "presented token equals TRIAGE_ROUTER_TOKEN". Both
 *  sides are hashed, then the two digests are compared byte-by-byte with XOR
 *  accumulation so the comparison cost never depends on how much of the
 *  secret matched (workerd has no timingSafeEqual). Unset or empty secret is
 *  a clean false — behaviour unchanged when the operator has not set it. */
async function isTriageDaemonToken(env: Env, presented: string | null): Promise<boolean> {
  const secret = env.TRIAGE_ROUTER_TOKEN;
  if (presented === null || secret === undefined || secret.length === 0) return false;
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authenticateGlmLeadRequest(
  req: Request, expectedPath: string, env: Env, rows: () => Promise<StudioStatus[]>,
): Promise<{ response: Response } | { studio: SpawnParent; allRows: StudioStatus[] }> {
  if (new URL(req.url).pathname !== expectedPath) return { response: text("not found", 404) };
  // MAJOR 2: reuses junior's OWN feature flag (same env.FLEET_JUNIOR !== "on"
  // check junior/route.ts:101 already applies) rather than inventing a
  // second, parallel on/off switch for a second Workers-AI-spending route —
  // one flag, one place an operator has to remember to flip.
  if (env.FLEET_JUNIOR !== "on" || !env.AI) return { response: text("not found", 404) };
  if (req.method !== "POST") return { response: text("method not allowed", 405) };

  // Cheapest possible refusal first, same order /fleet/junior already
  // applies (PR #9 review, F3): a declared Content-Length over the cap needs
  // no token check and no byte of the body ever read.
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > ANTHROPIC_BODY_CAP) return { response: text("payload too large", 413) };
  }

  const presented = extractPresentedToken(req);
  if (!isSpawnTokenShaped(presented)) {
    // #1218: a presented value that is not spawn-token-shaped may still be the
    // scoped router-only triage credential. Accepted ONLY here — the spawn
    // token path above never sees it, and no other route reads this secret.
    // #1221: that shape gate is exactly why a spawn-shaped value can never be
    // the triage key — a value matching the spawn-token shape routes to
    // spawn-token resolution below and is never compared against this secret.
    if (await isTriageDaemonToken(env, presented)) {
      return {
        studio: { id: TRIAGE_DAEMON_ID, repo: "oss-triage", role: "daemon" },
        allRows: [],
      };
    }
    return { response: text("unauthorized", 401) };
  }
  const allRows = await rows();
  const studio: SpawnParent | null = await resolveSpawnParent(allRows, presented);
  if (!studio) return { response: text("unauthorized", 401) };
  // #1221: TRIAGE_DAEMON_ID is reserved for the synthetic credential above —
  // a real registry row must never claim it, or its spawn token would pass
  // this gate and spend (rate limit + usage) under the daemon's id.
  if (studio.id === TRIAGE_DAEMON_ID) return { response: text("unauthorized", 401) };
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
    return { response: text("this route serves glm-led studios only", 403) };
  }
  return { studio, allRows };
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
 *  studio.
 *
 *  Issue #302: a failed call also records its `failure` reason (capped at
 *  FAILURE_REASON_CAP, whitespace collapsed to one line) in the row's `error`
 *  column and writes ONE console.error line for `wrangler tail` — ids,
 *  counts and the reason only, never prompt or response text. Before this,
 *  an upstream stall left `ok=0` rows with no reason and empty tail logs.
 *
 *  Board issue #304, item 3: "never prompt or response text" was not quite
 *  true of the console line before this fix — the upstream's OWN error
 *  message can echo request input (a context-overflow error quoting the
 *  prompt is the shape the review flagged), and `wrangler tail` output
 *  outlives the request. The console line now carries failureClass()'s
 *  class/status only, while the D1 `error` column keeps the full capped
 *  message — that one stays queryable per-row for diagnosis, where the
 *  console line's blast radius is not.
 *
 *  Issue #335: every row also carries the call's wall time (`startedAt` to
 *  now, retry backoff included) and its env.AI.run attempt count.
 *
 *  Task 4 (spec 2026-10-13-model-pool-design): `model` is now REQUIRED on
 *  every call site — the model actually used (the overflow loop's winning
 *  candidate, or the last one tried on a total failure), never the fixed
 *  `GLM_LEAD_MODEL` this call used to hardcode regardless of which model
 *  the request actually hit. */
function logUsage(
  env: Env, ctx: ExecutionContext, studioId: string,
  call: { model: string; stream: boolean; inputTokens: number; outputTokens: number; ok: boolean; failure?: string; startedAt: number; attempts: number; timeToHeaders: number },
): void {
  const { stream, inputTokens, outputTokens, ok, attempts, timeToHeaders } = call;
  const durationMs = Math.max(0, Math.round(Date.now() - call.startedAt));
  const error = ok || call.failure === undefined
    ? undefined
    : call.failure.replace(/\s+/g, " ").slice(0, FAILURE_REASON_CAP);
  if (!ok) {
    console.error(
      `[glm-lead] call failed studio=${studioId} stream=${stream} in=${inputTokens} out=${outputTokens} reason=${failureClass(error ?? "unknown")}`,
    );
  }
  ctx.waitUntil(insertJuniorUsage(env.DB, {
    id: crypto.randomUUID(), ts: Date.now(), studioId, mode: USAGE_MODE, model: call.model,
    inputTokens, outputTokens, ok, ...(error === undefined ? {} : { error }), durationMs, attempts, timeToHeaders,
  }).catch((e) => console.error("[glm-lead] usage insert failed", e instanceof Error ? e.message : String(e))));
}

/** Issue #302: an upstream error message can be arbitrarily long (a stack, an
 *  HTML error page); the reason column only needs enough to classify it. */
const FAILURE_REASON_CAP = 300;

/** The outcome of walking `pickModels`' candidate list — either the winning
 *  model's own upstream value, or (every candidate exhausted) the last
 *  model tried and the message it failed with. Either way `usedModel`/
 *  `attempts` are what the caller's usage row needs regardless of outcome —
 *  see `runModelPoolOverflow`'s own doc comment.
 *
 *  Finding 7 (fresh-context review of #1228, PR #1235): these 4 variants
 *  used to be discriminated via ad hoc `"x" in overflow` checks at call
 *  sites, while its sibling `ConsumeOutcome` (introduced in the same diff,
 *  right below) already uses a clean `kind` literal tag. Given the same
 *  style here for internal consistency — every call site now narrows on
 *  `overflow.kind` instead of a property-presence check. */
type ModelOverflowResult =
  | { kind: "ok"; upstream: Json; usedModel: string; attempts: number; collected?: CollectedFrames }
  | { kind: "exhausted"; usedModel: string; attempts: number; lastMessage: string }
  | { kind: "no_finish_exhausted"; usedModel: string; attempts: number; lastNoFinish?: PumpResult }
  | { kind: "pump_error"; usedModel: string; attempts: number; pumpError: string };

/** Issue #1228: what the non-streaming caller folds its reply from — the
 *  translator frames plus the pump's own result. */
type CollectedFrames = Awaited<ReturnType<typeof collectAnthropicFrames>>;

/** What the `consume` callback resolves to: the reassembled frames (the
 *  normal case), a non-stream object the provider returned in place of a
 *  stream, or a pump bug (kept distinct so it stays the same fixed-message
 *  500 it always was, never folded into the no_finish_reason failover). */
type ConsumeOutcome =
  | { kind: "collected"; frames: CollectedFrames }
  | { kind: "plain" }
  | { kind: "pump_error"; message: string };

/** Code review (Standards axis, #1228 fresh-context review, Finding 5): the
 *  outcome of running `consume` against one `env.AI.run` value — either the
 *  walk should stop and return `result` right away (a plain reply, a pump
 *  bug, or anything that is not an out=0 no_finish_reason — see the
 *  `fr.ok || !(...)` condition below, the ONE gate this also shares with
 *  the bottom non-streaming failure branch in `handleFleetAnthropicMessages`,
 *  Finding 1), or the walk should keep going (`frame` is the out=0
 *  no_finish_reason PumpResult to remember as `lastNoFinish`). */
type AttemptOutcome =
  | { accept: true; result: ModelOverflowResult }
  | { accept: false; frame: PumpResult };

/** Code review (Standards axis, #1228 fresh-context review, Finding 5):
 *  "consume one upstream value, decide whether an out=0 no_finish_reason
 *  means retry/failover or something else means stop" — the initial attempt
 *  and the same-model retry inside `runModelPoolOverflow`'s loop used to be
 *  two hand-written, byte-identical copies of this. Pure aside from the
 *  `consume` call itself. */
async function attemptOnce(
  consume: (value: Json, modelId: string) => Promise<ConsumeOutcome>,
  value: Json, modelId: string, usedModel: string, attempts: number,
): Promise<AttemptOutcome> {
  const outcome = await consume(value, modelId);
  if (outcome.kind === "plain") return { accept: true, result: { kind: "ok", upstream: value, usedModel, attempts } };
  if (outcome.kind === "pump_error") return { accept: true, result: { kind: "pump_error", usedModel, attempts, pumpError: outcome.message } };
  const fr = outcome.frames.result;
  // Issue #1228: the stream ends without a finish_reason AFTER the caller
  // has consumed it (env.AI.run itself succeeded). An out=0 no_finish_reason
  // is a transient upstream failure another model may answer: retry the
  // SAME model once, then move to the next candidate. Anything else
  // (success, or a no_finish_reason that DID produce output — Finding 1) is
  // not that shape, so the walk stops here and reports it as-is.
  if (fr.ok || !(fr.failure === "no_finish_reason" && fr.outputTokens === 0)) {
    return { accept: true, result: { kind: "ok", upstream: value, usedModel, attempts, collected: outcome.frames } };
  }
  return { accept: false, frame: fr };
}

/** Code review (Standards axis, #717): extracted verbatim out of
 *  `handleFleetAnthropicMessages`'s own body — the self-contained walk over
 *  `order` (pickModels' own candidate model list). Spec Component 4's own
 *  rule: a 429/3021, a 4002/8005 (incident #717 continued —
 *  `isOverflowRoutingError`'s own doc comment), or a 504/529 moves to the
 *  next candidate. #1070: a 504/529 moves on after the FIRST failure while
 *  another candidate remains; the issue #335 same-model retry
 *  (`runAiWithRetry`) runs only on the last candidate, where nothing else is
 *  left to move to. Anything else (a 4xx the request
 *  itself caused, an unrecognized genuine 500) is not a failure another
 *  model would answer differently, so the walk stops there and reports it
 *  as the final failure.
 *
 *  `attempts` accumulates every `env.AI.run` call across EVERY model this
 *  walk tried, not just the winning model's own retry count — a usage
 *  row's `attempts` is the total number of `env.AI.run` calls the whole
 *  call cost (see `handleFleetAnthropicMessages`'s own doc comment on
 *  `startedAt`/`attempts`). Pure aside from the `ai.run` call itself — no
 *  env/ctx/studio reach-in, so a caller supplies exactly what the walk
 *  needs and nothing more. */
async function runModelPoolOverflow(
  ai: NonNullable<Env["AI"]>, order: string[], body: Json,
  gatewayId: string | undefined, baseMs: number,
  retryDeps?: { sleep?: (ms: number) => Promise<void>; random?: () => number },
  consume?: (value: Json, modelId: string) => Promise<ConsumeOutcome>,
): Promise<ModelOverflowResult> {
  let attempts = 0;
  let usedModel = order[0];
  let lastMessage = "";
  const seen = new Set<string>();
  let lastNoFinish: PumpResult | undefined;
  for (const [index, modelId] of order.entries()) {
    const pm = modelById(modelId) ?? POOL[0];
    usedModel = pm.id;
    // Issue #1099 (review, finding 1): always stream upstream, so the runaway scan
    // runs on the non-streaming path too (the caller reassembles a reply).
    const openaiBody = anthropicRequestToOpenAI({ ...body, stream: true }, { id: pm.id, minMaxTokens: pm.minMaxTokens, maxMaxTokens: pm.maxMaxTokens });
    const backoffHere = order.length === 1 || order.every((id) => id === modelId || seen.has(id));
    // Incident fix (#717): the gateway option is attached ONLY when
    // `gatewayId` is actually set — `ai.run(pm.id, openaiBody)` with no
    // third argument at all otherwise, not `ai.run(pm.id, openaiBody,
    // undefined)`.
    const run = () => (gatewayId === undefined ? ai.run(pm.id, openaiBody) : ai.run(pm.id, openaiBody, { gateway: { id: gatewayId } }));
    // #1070: a candidate with another one still after it gets exactly one
    // attempt — its 504/529 moves on at once instead of spending
    // LEAD_AI_MAX_RETRIES same-model retries (~235 s each on a 3046 timeout).
    // Only the last candidate (or the sole one) keeps the same-model retry.
    const hasNext = index < order.length - 1;
    try {
      const r = await (backoffHere
        ? runAiWithRateLimitBackoff(run, { baseMs, ...(retryDeps ?? {}) })
        : hasNext
          ? run().then((value) => ({ value, attempts: 1 }))
          : runAiWithRetry(run, { baseMs }));
      attempts += r.attempts;
      if (consume === undefined) return { kind: "ok", upstream: r.value, usedModel, attempts };
      const first = await attemptOnce(consume, r.value, pm.id, usedModel, attempts);
      if (first.accept) return first.result;
      lastNoFinish = first.frame;
      const retried = await runAiWithRetry(run, { baseMs });
      attempts += retried.attempts;
      const second = await attemptOnce(consume, retried.value, pm.id, usedModel, attempts);
      if (second.accept) return second.result;
      lastNoFinish = second.frame;
      // Same-model retry also failed the same way: move to the next candidate.
      if (hasNext) continue;
      return { kind: "no_finish_exhausted", usedModel, attempts, lastNoFinish };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      lastMessage = message;
      attempts += e instanceof AiRunError ? e.attempts : 1;
      if (isRateLimited(message)) seen.add(modelId);
      const { status } = classifyAiError(message);
      if (!(isRateLimited(message) || isOverflowRoutingError(message) || status === 504 || status === 529)) break;
    }
  }
  return { kind: "exhausted", usedModel, attempts, lastMessage };
}

export async function handleFleetAnthropicMessages(
  req: Request, env: Env, ctx: ExecutionContext,
  rows: () => Promise<StudioStatus[]> = () => listStudios(env),
  pool?: readonly PoolModel[],
  retryDeps?: { sleep?: (ms: number) => Promise<void>; random?: () => number },
): Promise<Response> {
  const gate = await authenticateGlmLeadRequest(req, ANTHROPIC_MESSAGES_PATH, env, rows);
  if ("response" in gate) return gate.response;
  const { studio } = gate;

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
  const refusal = await consumeLeadRate(env, studio.id);
  if (refusal) return refusal;

  const raw = await readCappedBody(req, ANTHROPIC_BODY_CAP);
  if (raw === null) return text("payload too large", 413);
  let body: Json;
  try { body = JSON.parse(raw); } catch { return text("bad json", 400); }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return text("messages required", 400);
  if (typeof body?.max_tokens !== "number" || !(body.max_tokens > 0)) return text("max_tokens required", 400);
  // Issue #1112 layer 1: lead calls only. Claude Code's helper calls carry a
  // haiku-class model name (isSmallModelName) and never get the rule.
  if (!isSmallModelName(body.model)) body = withOssLeadContinueRule(body);

  const requestedModel = typeof body.model === "string" && body.model.length > 0 ? body.model : GLM_LEAD_MODEL;
  const ai = env.AI;
  // Defensive: `authenticateGlmLeadRequest` already refused with 404 above
  // when `!env.AI`, so this is unreachable at runtime — kept only because
  // TypeScript cannot carry that function's narrowing of `env.AI` across
  // the call boundary into this one.
  if (!ai) return text("not found", 404);

  // Issue #1228: hash the raw body ONCE (fingerprint also keyed by it) and
  // refuse a request already proven to fail 3x before spending any more AI
  // budget. `raw` is the pre-lead-rule body — identical on every retry of
  // the same client request, which is the signal that matters here.
  const fingerprint = await computeRequestFingerprint(raw, body);
  if (await getNoFinishReasonFailures(env.DB, studio.id, fingerprint.fingerprintHash) >= 3) {
    console.error(
      `[glm-lead] no_finish_reason studio=${studio.id} fingerprint=${fingerprint.fingerprintHash} repeated=3+ refused`,
    );
    return json(anthropicErrorBody("invalid_request_error", "upstream repeatedly failed to complete this request; compact context and retry"), 400);
  }

  // Task 4 (spec 2026-10-13-model-pool-design, Components 3/4): the ordered
  // list of models this call walks. Pool off keeps the exact pre-#717
  // behavior — `pickModels` returns `[POOL[0].id]` (GLM) unconditionally
  // when `poolOn` is false, so there is nothing else to change here for an
  // operator who hasn't flipped `LEAD_MODEL_POOL` on yet. `assigned`/
  // `states` are only ever read from D1 when the pool is actually on — pool
  // off has no use for either, and `pickModels` ignores them anyway.
  const poolOn = env.LEAD_MODEL_POOL === "on";
  // LEAD_MODEL_OVERFLOW=off (#768): the walk is assigned-model-only —
  // `pickModels` returns the one model and the overflow loop below never
  // has a second candidate to move to.
  const gatewayId = resolveGatewayId(env);
  const avoidOn = poolOn && env.LEAD_MODEL_OVERFLOW !== "off";
  const order = pickModels({
    studioId: studio.id,
    requestedModel: body.model,
    poolOn,
    overflowOn: env.LEAD_MODEL_OVERFLOW !== "off",
    // Issue #1099: after a runaway abort the studio's next call moves off that model.
    avoid: avoidOn ? await getRunawayAvoid(env.DB, studio.id) : [],
    assigned: poolOn ? await getAssignedModel(env.DB, studio.id) : null,
    states: poolOn ? await getModelStates(env.DB) : {},
    ...(pool === undefined ? {} : { pool }),
  });

  // Input count for a runaway, whose aborted upstream never reports prompt
  // tokens. Same heuristic as count_tokens (estimateInputTokens).
  const requestInputEstimate = () => estimateInputTokens(anthropicRequestToOpenAI(body).messages, body.tools);

  // Issue #335: one clock per call. `attempts` now accumulates across EVERY
  // model this call walks (Task 4's overflow loop), not just the winning
  // model's own #335 retry count — a usage row's `attempts` is the total
  // number of `env.AI.run` calls this one Messages-API request cost.
  const startedAt = Date.now();
  const stream = body.stream === true;
  // Issue #1228: the non-streaming caller consumes the upstream stream inside
  // the overflow walk so an out=0 no_finish_reason retries once then fails
  // over to the next model. The streaming caller cannot retry after the
  // Response has left, so it passes no `consume` and keeps the old behavior.
  const overflow = await runModelPoolOverflow(
    ai, order, body, gatewayId, leadAiRetryBaseMs(env), retryDeps,
    stream ? undefined : async (value, modelId) => {
      if (!(value instanceof ReadableStream)) return { kind: "plain" as const };
      try {
        const frames = await collectAnthropicFrames(
          value, `msg_${crypto.randomUUID().replace(/-/g, "")}`, requestedModel, body.max_tokens, leadStreamIdleMs(env), modelById(modelId), req.signal,
        );
        // Issue #1228: every no_finish_reason — including the intermediate one
        // that then retries/fails over — gets its fingerprint line here, so a
        // poison request leaves a full trail even when a later model recovers.
        if (frames.result.failure === "no_finish_reason") {
          await logNoFinishReasonFingerprint(studio.id, fingerprint, frames.result.lastChunks, frames.result.inputTokens, frames.result.outputTokens);
        }
        return { kind: "collected" as const, frames };
      } catch (e) {
        return { kind: "pump_error" as const, message: e instanceof Error ? e.message : String(e) };
      }
    },
  );
  const { usedModel, attempts } = overflow;
  const headersAt = Date.now();

  if (overflow.kind !== "ok") {
    // Issue #1228: every candidate ended with an out=0 no_finish_reason —
    // the request is poisonous to every model, not rate-limited. A 500 keeps
    // the client retrying the SAME body 12x; a 400 (invalid_request_error) is
    // the one shape Claude Code reads as "stop, don't retry". Log the
    // fingerprint once more (hashes/sizes only) and count the failure.
    if (overflow.kind === "no_finish_exhausted") {
      const nf = overflow.lastNoFinish;
      // The fingerprint line was already written inside the walk's consume
      // callback (one per no_finish_reason, including this last one); here
      // the turn is a confirmed failure, so count it toward the 3-try cap.
      const { n, response } = await recordAndRespondNoFinish(env.DB, studio.id, fingerprint.fingerprintHash);
      logUsage(env, ctx, studio.id, {
        model: usedModel, stream, inputTokens: nf?.inputTokens ?? 0, outputTokens: nf?.outputTokens ?? 0, ok: false,
        failure: `no_finish_reason exhausted all models (count=${n})`, startedAt, attempts, timeToHeaders: headersAt - startedAt,
      });
      return response;
    }
    // Issue #1228: a pump bug while collecting the non-streaming reply stays
    // the fixed-message 500 it always was — never folded into the failover.
    if (overflow.kind === "pump_error") {
      logUsage(env, ctx, studio.id, {
        model: usedModel, stream, inputTokens: 0, outputTokens: 0, ok: false,
        failure: `pump_error: ${overflow.pumpError}`, startedAt, attempts, timeToHeaders: headersAt - startedAt,
      });
      return json(anthropicErrorBody("api_error", "upstream stream failed"), 500);
    }
    // Spec Component 4: "all exhausted -> 429 + retry-after (shortest known
    // reset)" — every candidate model either 429'd/3021'd or exhausted its
    // own transient retry. A rate-limited exhaustion is reported as 429
    // regardless of which specific upstream wording the LAST model used
    // (classifyAiError's own mapping stays the fallback for anything else).
    const { lastMessage } = overflow;
    const rateLimited = isRateLimited(lastMessage);
    const { status, type, message: overrideMessage } = rateLimited
      ? { status: 429, type: "rate_limit_error", message: undefined as string | undefined }
      : classifyAiError(lastMessage);
    logUsage(env, ctx, studio.id, {
      model: usedModel, stream, inputTokens: 0, outputTokens: 0, ok: false,
      failure: `ai_run_error ${status} ${type}: ${lastMessage}`, startedAt, attempts, timeToHeaders: headersAt - startedAt,
    });
    const res = json(anthropicErrorBody(type, overrideMessage ?? lastMessage), status);
    if (status === 429) {
      // Same window-rollover discipline as rateLimitRefusal's own 429s
      // above — 30s is the simplest reset estimate available without this
      // route tracking a per-model 3021 cooldown clock yet (no model in the
      // pool reports one today).
      res.headers.set("retry-after", "30");
    }
    return res;
  }
  const { upstream } = overflow;

  if (stream) {
    if (!(upstream instanceof ReadableStream)) {
      // Defensive: the untyped fallback overload's return type is
      // `Promise<Record<string, unknown>>` for a non-streaming call, but
      // `stream: true` is documented (workers-types' sibling-model
      // `glm-4.7-flash` typed overload) to resolve to a ReadableStream. A
      // provider that ignored `stream: true` and returned a plain object
      // anyway is translated through the non-streaming path rather than
      // crashing on `.getReader()`.
      const anthropic = openAIResponseToAnthropic(upstream, { model: requestedModel, requestedMaxTokens: body.max_tokens });
      logUsage(env, ctx, studio.id, { model: usedModel, stream: true, inputTokens: anthropic.usage.input_tokens, outputTokens: anthropic.usage.output_tokens, ok: true, startedAt, attempts, timeToHeaders: headersAt - startedAt });
      return json(anthropic, 200);
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const writer = writable.getWriter();
    // Board issue #284, MINOR 4(a): the Response below returns `readable`
    // immediately — the Workers runtime is free to tear down this
    // execution context the instant that Response is considered "done"
    // from ITS own point of view, which can happen before this detached
    // promise chain has actually finished writing/closing the stream. Same
    // reasoning as `logUsage`'s own doc comment above (and the
    // `insertJuniorUsage` call site it describes) for why this is
    // `ctx.waitUntil`, not a bare `void`: only `ctx.waitUntil` keeps a
    // promise alive past the point the runtime would otherwise consider
    // this request's work finished. MAJOR 2/4: the real token counts (and
    // whether the stream ended cleanly — MAJOR 3) only exist once
    // pumpAnthropicStream resolves, so the usage row is logged from its own
    // `.then()`, not alongside the other two call sites above.
    //
    // Issue #302: a client hang-up is now a `client_abort` PumpResult, not a
    // rejection; what still rejects here is a bug inside the pump itself,
    // logged as `pump_error` rather than dropped without a row.
    ctx.waitUntil(
      pumpAnthropicStream(upstream, writer, id, requestedModel, body.max_tokens, leadStreamIdleMs(env), modelById(usedModel),
        { pingMs: leadStreamPingMs(env), signal: req.signal })
        .then(async (result) => {
          const runaway = result.failure?.startsWith("runaway:") === true;
          // The aborted upstream never reports prompt tokens; estimate them (see requestInputEstimate).
          const inputTokens = runaway && result.inputTokens === 0 ? requestInputEstimate() : result.inputTokens;
          logUsage(env, ctx, studio.id, { model: usedModel, stream: true, ...result, inputTokens, startedAt, attempts, timeToHeaders: headersAt - startedAt });
          // Issue #1099: the retry (a 529 the client re-sends) moves to the next model.
          if (runaway && avoidOn) {
            ctx.waitUntil(markRunawayAvoid(env.DB, studio.id, usedModel).catch(() => {}));
          }
          // Issue #1228: the streaming path can't retry (the Response already
          // left), but it still fingerprints and counts a no_finish_reason so
          // the entry gate refuses the SAME poison request on its next send.
          if (result.failure === "no_finish_reason") {
            ctx.waitUntil(logNoFinishReasonFingerprint(studio.id, fingerprint, result.lastChunks, inputTokens, result.outputTokens));
            ctx.waitUntil(recordNoFinishReasonFailure(env.DB, studio.id, fingerprint.fingerprintHash).catch(() => {}));
          } else if (result.ok) {
            ctx.waitUntil(clearNoFinishReasonFailures(env.DB, studio.id, fingerprint.fingerprintHash).catch(() => {}));
          }
        })
        .catch((e) => logUsage(env, ctx, studio.id, {
          model: usedModel, stream: true, inputTokens: 0, outputTokens: 0, ok: false,
          failure: `pump_error: ${e instanceof Error ? e.message : String(e)}`, startedAt, attempts, timeToHeaders: headersAt - startedAt,
        }))
        .finally(() => { writer.close().catch((e) => console.error("[glm-lead] writer close failed after stream end", e instanceof Error ? e.message : String(e))); }),
    );
    return new Response(readable, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  // Fresh-context review (#717 critical follow-up): this is the REAL
  // non-streaming path (the branch above at `stream === true` is only the
  // defensive fallback for a provider that ignored `stream: true`) — the
  // one call site the original incident fix actually missed.
  // `requestedMaxTokens` was previously omitted here entirely, so an
  // inflated upstream `completion_tokens` reached the client, and this logged
  // usage row, completely unclamped.
  //
  // Issue #1228: the overflow walk already consumed the winning model's stream
  // (its `consume` callback) and handed back `collected` — the translator
  // frames + pump result. Only when the provider returned a non-stream object
  // (`collected` absent) does this path fall back to the plain-object shape.
  if (overflow.collected === undefined) {
    const anthropic = openAIResponseToAnthropic(upstream, { model: requestedModel, requestedMaxTokens: body.max_tokens });
    logUsage(env, ctx, studio.id, { model: usedModel, stream: false, inputTokens: anthropic.usage.input_tokens, outputTokens: anthropic.usage.output_tokens, ok: true, startedAt, attempts, timeToHeaders: headersAt - startedAt });
    return json(anthropic, 200);
  }
  // Issue #1099 (review round 3, finding 3): the reply is folded from the stream
  // translator's frames, so a runaway is caught before any byte goes out (529),
  // and a stream that ends without a finish_reason is an error, never a 200.
  const { result, sse } = overflow.collected;
  // Issue #1147: the client hung up while the reply was being collected. Nobody
  // will read the JSON, so it is a failure here, never an ok row.
  // UNMEASURED IN PRODUCTION (review round 2): on workerd 1.20260730 a non-
  // streaming request whose reply is not written yet gets no disconnect, even
  // with keepalive pings on (test/bun/llm-disconnect-workerd.test.ts, /collect).
  // So this branch does not run on that runtime today, and a dropped
  // non-streaming client still logs ok=1 when its reply completes. Kept because
  // it is correct if the runtime ever delivers the signal in that window.
  if (result.failure === "client_abort") {
    logUsage(env, ctx, studio.id, {
      model: usedModel, stream: false, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: false,
      failure: "client_abort", startedAt, attempts, timeToHeaders: headersAt - startedAt,
    });
    return json(anthropicErrorBody("api_error", "client disconnected"), 499);
  }
  if (result.failure?.startsWith("runaway:") === true) {
    const reason = result.failure.slice("runaway:".length);
    logUsage(env, ctx, studio.id, {
      model: usedModel, stream: false, inputTokens: result.inputTokens || requestInputEstimate(), outputTokens: result.outputTokens,
      ok: false, failure: result.failure, startedAt, attempts, timeToHeaders: headersAt - startedAt,
    });
    if (avoidOn) ctx.waitUntil(markRunawayAvoid(env.DB, studio.id, usedModel).catch(() => {}));
    return json(anthropicErrorBody("overloaded_error", runawayErrorMessage(reason)), 529);
  }
  if (!result.ok) {
    const message = errorFrameMessage(sse) ?? result.failure ?? "upstream stream failed";
    const { status, type, message: overrideMessage } = classifyAiError(message);
    logUsage(env, ctx, studio.id, {
      model: usedModel, stream: false, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: false,
      failure: `upstream_error ${type}: ${message}`, startedAt, attempts, timeToHeaders: headersAt - startedAt,
    });
    // Issue #1228: a no_finish_reason that produced output is NOT a poison
    // request (the model answered, then the stream cut) — it stays a normal
    // error. Only the out=0 shape is fingerprinted and counted; that one
    // reaches this line only when there was no next model to fail over to
    // (a single-model pool, or LEAD_MODEL_OVERFLOW=off).
    //
    // Finding 1 (fresh-context review of #1228, PR #1235): this used to key
    // ONLY on `result.failure === "no_finish_reason"`, with no `outputTokens
    // === 0` check — unlike `attemptOnce`'s own gate above (and
    // `runModelPoolOverflow`'s retry walk it came from), which only treats
    // an OUT=0 no_finish_reason as retriable/poison-countable. The incident's
    // own data says poison runs die after 0-1.6k out tokens, not always 0, so
    // this branch used to wrongly fingerprint/count a no_finish_reason WITH
    // output toward the same 3-strike streak meant only for the out=0 shape
    // — risking a false-positive permanent 400 on an unrelated flaky request,
    // and double-logging the fingerprint for the same frame (once inside the
    // overflow walk's own `consume` callback, once again here).
    if (result.failure === "no_finish_reason" && result.outputTokens === 0) {
      await logNoFinishReasonFingerprint(studio.id, fingerprint, result.lastChunks, result.inputTokens, result.outputTokens);
      return (await recordAndRespondNoFinish(env.DB, studio.id, fingerprint.fingerprintHash)).response;
    }
    return json(anthropicErrorBody(type, overrideMessage ?? message), status);
  }
  ctx.waitUntil(clearNoFinishReasonFailures(env.DB, studio.id, fingerprint.fingerprintHash).catch(() => {}));
  logUsage(env, ctx, studio.id, { model: usedModel, stream: false, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: true, startedAt, attempts, timeToHeaders: headersAt - startedAt });
  return json(foldAnthropicFrames(sse), 200);
}

/** ESTIMATE ONLY, not a real count — this backend has no tokenizer exposed
 *  to it at all (no Anthropic tokenizer, no access to GLM's own vocab), so
 *  there is no way to answer this honestly with an exact number. Heuristic:
 *  total character count of every message's string content, its tool_calls
 *  (name + arguments), and the request's tools JSON (their schemas are real
 *  prompt material the backend re-receives every call), divided by ~4 —
 *  the commonly cited rough chars-per-token ratio for English text. Runs
 *  on POST-translation messages, where anthropicRequestToOpenAI has
 *  already flattened any Anthropic content array into string content, so
 *  a message whose content is not a string contributes nothing here.
 *  Flagged here rather than guessed at silently, same "say so in a comment
 *  instead of guessing" convention classifyAiError's own doc comment
 *  (translate.ts) already established for this file.
 *  `Math.max(1, ...)` only to avoid reporting 0 for a technically-non-empty
 *  request — not a claim that 1 is ever the real count. */
function estimateInputTokens(messages: Json[], tools: Json[] | undefined): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      chars += String(tc.function?.name ?? "").length + String(tc.function?.arguments ?? "").length;
    }
  }
  for (const t of Array.isArray(tools) ? tools : []) chars += JSON.stringify(t ?? {}).length;
  return Math.max(1, Math.round(chars / 4));
}

/**
 * Board issue #284, MINOR 4(b): `POST /v1/messages/count_tokens`, the
 * sibling Anthropic Messages API endpoint. The real Anthropic endpoint
 * returns `{"input_tokens": <count>}` without generating anything — this
 * route follows the same shape, but see `estimateInputTokens`'s own doc
 * comment for why the number itself is an ESTIMATE, not a real count.
 *
 * Same trust boundary as `handleFleetAnthropicMessages` above — auth
 * (`extractPresentedToken`/`isSpawnTokenShaped`/`resolveSpawnParent`), the
 * `FLEET_JUNIOR`/`env.AI` feature flag, and the `leadType === "glm"` gate
 * are all still enforced here even though this route never actually calls
 * `env.AI.run` — none of those checks exist BECAUSE of the AI call; they
 * exist because this is still a spawn-token-authenticated glm-lead-only
 * surface, same as every other check in this file. Rate limiting too, same
 * position (after the auth gate, before any body work), but from its OWN
 * per-minute-only limiter (`checkAndConsumeLeadCountTokensRateLimit`,
 * separate D1 prefix, no daily cap) — an unthrottled endpoint is a free
 * D1-hammering surface, yet its calls spend no AI budget and must not
 * draw down the messages route's.
 */
export async function handleFleetAnthropicCountTokens(
  req: Request, env: Env, ctx: ExecutionContext,
  rows: () => Promise<StudioStatus[]> = () => listStudios(env),
): Promise<Response> {
  const gate = await authenticateGlmLeadRequest(req, ANTHROPIC_COUNT_TOKENS_PATH, env, rows);
  if ("response" in gate) return gate.response;
  const { studio } = gate;

  // count_tokens gets its OWN per-minute bucket: it spends no AI budget,
  // and drawing it from the /messages daily cap locked studios out
  // (measured 2026-10-11) — see consumeLeadCountTokensRate's doc comment.
  const refusal = await consumeLeadCountTokensRate(env, studio.id);
  if (refusal) return refusal;

  const raw = await readCappedBody(req, ANTHROPIC_BODY_CAP);
  if (raw === null) return text("payload too large", 413);
  let body: Json;
  try { body = JSON.parse(raw); } catch { return text("bad json", 400); }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return text("messages required", 400);

  const openaiBody = anthropicRequestToOpenAI(body);
  return json({ input_tokens: estimateInputTokens(openaiBody.messages, body.tools) }, 200);
}
