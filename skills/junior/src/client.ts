// skills/junior/src/client.ts
// One chat call to Workers AI, plus the retry/fallback policy measured in the
// 2026-09-28 replay eval (docs/superpowers/specs/2026-09-28-junior-workers-ai-design.md).

export const GLM = "@cf/zai-org/glm-5.3";
export const DEEPSEEK = "@cf/deepseek-ai/deepseek-v4-pro-0813";
export const MAX_TOKENS_CAP = 128_000;

export type Transport =
  | { kind: "proxy"; url: string; spawnToken: string }
  | { kind: "direct"; base: string; accountId: string; token: () => Promise<string>; source: "api-token" | "wrangler" };

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatRequest { model: string; messages: ChatMessage[]; max_tokens: number }
export interface ChatResult { content: string; finish: string | null; usage: { in: number; out: number; neurons: number | null } }

export class ApiError extends Error {
  constructor(readonly code: number, message: string, readonly httpStatus = 0) { super(message); }
}
export class AuthError extends Error {}

// deno-lint-ignore no-explicit-any
type Json = any;

export function normalize(json: Json): ChatResult {
  if (json && typeof json.content === "string" && !("choices" in json)) {
    return { content: json.content, finish: json.finish ?? null, usage: json.usage ?? { in: 0, out: 0, neurons: null } };
  }
  const c = json?.choices?.[0] ?? {};
  return {
    content: typeof c.message?.content === "string" ? c.message.content : "",
    finish: c.finish_reason ?? null,
    usage: {
      in: json?.usage?.prompt_tokens ?? 0,
      out: json?.usage?.completion_tokens ?? 0,
      neurons: json?.usage?.neurons ?? null,
    },
  };
}

function parseLoose(text: string): Json | undefined {
  try { return JSON.parse(text.trim()); } catch { return undefined; }
}

export async function callOnce(
  t: Transport, req: ChatRequest, fetchImpl: typeof fetch, signal?: AbortSignal,
): Promise<ChatResult> {
  const url = t.kind === "proxy" ? `${t.url}/fleet/junior` : `${t.base}/accounts/${t.accountId}/ai/v1/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (t.kind === "proxy") headers["X-Fleet-Spawn-Token"] = t.spawnToken;
  else headers.authorization = `Bearer ${await t.token()}`;
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(req), signal });
  const text = await res.text();
  const json = parseLoose(text);
  if (json === undefined) {
    if (res.status === 404 && t.kind === "proxy") throw new AuthError("junior not enabled for this repo (FLEET_JUNIOR / JUNIOR_REPOS)");
    if (res.status === 403 && t.kind === "proxy") {
      throw new AuthError("junior not authorized for your current task: only the maestro enables it, by filing the task with `fleet task new --junior`");
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(`unauthorized (HTTP ${res.status})`);
    throw new ApiError(0, `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  const err = json.error ?? (json.success === false ? json.errors?.[0] : undefined);
  if (err || !res.ok) {
    const code = Number(err?.code ?? res.status);
    const message = String(err?.message ?? `HTTP ${res.status}`);
    if (code === 10000 || res.status === 401 || res.status === 403) throw new AuthError(message);
    throw new ApiError(code, message, res.status);
  }
  return normalize(json);
}

type Kind = "retry" | "rate" | "other";
function classify(e: ApiError): Kind {
  // The text fallback only applies alongside a transient-shaped HTTP status (5xx). A 4xx whose
  // message merely happens to contain "timeout"/"capacity" (e.g. a permanent quota/validation
  // error) must not be treated as retryable.
  if (e.code === 3046 || e.code === 3040 || (e.httpStatus >= 500 && /timeout|capacity/i.test(e.message))) return "retry";
  if (e.code === 429 || e.httpStatus === 429 || /rate limit|too many requests/i.test(e.message)) return "rate";
  return "other";
}

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

// Races an injected/default sleep against the caller's AbortSignal so a mid-backoff abort
// interrupts the wait immediately instead of running the full 10s/20s delay regardless.
function sleepAbortable(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

export interface PolicyOpts {
  transport: Transport;
  models: string[];
  messages: ChatMessage[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export async function callWithPolicy(o: PolicyOpts): Promise<{ result: ChatResult; model: string; calls: number }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let calls = 0;
  let last = "no model tried";
  for (const model of o.models) {
    let budget = o.maxTokens;
    let retried = false;
    let grown = false;
    let rateWaits = 0;
    while (true) {
      calls++;
      let r: ChatResult;
      try {
        r = await callOnce(o.transport, { model, messages: o.messages, max_tokens: budget }, fetchImpl, o.signal);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        last = `${model}: ${e.message}`;
        const k = classify(e);
        if (k === "rate") {
          if (rateWaits < 2) { rateWaits++; await sleepAbortable(10_000 * rateWaits, sleep, o.signal); continue; }
          throw new ApiError(429, `rate limited: ${last}`, 429);
        }
        if (k === "retry" && !retried) { retried = true; continue; }
        break;
      }
      if (r.finish === "length" && !grown && budget < MAX_TOKENS_CAP) {
        grown = true;
        budget = Math.min(budget * 2, MAX_TOKENS_CAP);
        continue;
      }
      if (r.content.trim() === "") { last = `${model}: empty output (finish=${r.finish})`; break; }
      return { result: r, model, calls };
    }
  }
  throw new ApiError(0, `all models failed; last: ${last}`);
}
