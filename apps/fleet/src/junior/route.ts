// apps/fleet/src/junior/route.ts
// POST /fleet/junior — the studio's road to Workers AI. Spawn-token auth, same
// as /fleet/tasks (board/routes.ts's handleFleetBoard). The Worker's own AI
// binding makes the call, so the container never holds a Cloudflare
// credential (house rule "deploy credentials", blueprint.ts).
import type { Env } from "../env";
import { isSpawnTokenShaped, resolveSpawnParent, SPAWN_TOKEN_HEADER } from "../studio/spawn";
import { listStudios } from "../studio/registry";
import { parseStudioId } from "../studio/ids";
import type { StudioStatus } from "../studio/types";
import { JUNIOR_MODELS, juniorEnabled } from "./gate";
import { findLiveAssignedTask, type BoardApi } from "../board/board";
import { isJuniorAuthorized, revokeJuniorAuthorization } from "./authz";
import { checkAndConsumeJuniorRateLimit } from "./ratelimit";
import { githubBoardApi, resolveStudioBoardRepo } from "../board/routes";
import { insertJuniorUsage } from "./usage";

// Issue #218: the only two modes the CLI's client.ts ever sends (see that
// module's own `X-Junior-Mode` header — proxy transport only, per the design
// doc). An absent or unrecognized header defaults to "edit" rather than
// rejecting the call outright — usage counting must never be a reason a
// junior call that is otherwise fine gets refused.
const JUNIOR_MODES = ["edit", "text"] as const;
type JuniorMode = (typeof JUNIOR_MODES)[number];
function readJuniorMode(req: Request): JuniorMode {
  const raw = req.headers.get("X-Junior-Mode");
  return (JUNIOR_MODES as readonly string[]).includes(raw ?? "") ? (raw as JuniorMode) : "edit";
}

export const JUNIOR_BODY_CAP = 2 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

// deno-lint-ignore no-explicit-any
type Json = any;

export function normalizeAiResult(r: Json) {
  if (r && Array.isArray(r.choices)) {
    const c = r.choices[0] ?? {};
    return {
      content: typeof c.message?.content === "string" ? c.message.content : "",
      finish: c.finish_reason ?? null,
      usage: { in: r.usage?.prompt_tokens ?? 0, out: r.usage?.completion_tokens ?? 0, neurons: r.usage?.neurons ?? null },
    };
  }
  return {
    content: typeof r?.response === "string" ? r.response : "",
    finish: r?.finish_reason ?? null,
    usage: { in: r?.usage?.prompt_tokens ?? 0, out: r?.usage?.completion_tokens ?? 0, neurons: null },
  };
}

// The AI binding throws a bare `Error` with a free-text message — unlike
// client.ts's classify() (skills/junior/src/client.ts), there is no numeric
// `code` or HTTP status alongside it to scope this match against: `env.AI.run`
// is a direct binding call, not an HTTP response with its own status line.
// Unscoped substring matching is therefore the best signal available here,
// not the same shortcut client.ts's classifier was fixed away from — a
// misclassification here costs an extra retry/fallback attempt on the
// caller's side, never an auth or allowlist decision (both already happened
// before this function is reached).
function aiErrorCode(message: string): number {
  if (/timeout/i.test(message)) return 3046;
  if (/capacity/i.test(message)) return 3040;
  if (/rate limit|too many/i.test(message)) return 429;
  return 0;
}

const text = (body: string, status: number) => new Response(body, { status });

/**
 * PR #9 review, F2: defense in depth beyond "the maestro never gets the
 * `junior` skill" (Task 7's provision-time exclusion, studio/provision.ts's
 * `isMaestro` check) — even a maestro's own spawn token must never reach this
 * route, full stop, regardless of what the board or D1 would otherwise say.
 *
 * Role ALONE, deliberately NOT the same two-part (role + instance 1) check
 * src/studio/do.ts's own `isMaestro()` uses — that extra instance-1
 * restriction is specific to what THAT check decides ("may this studio arm
 * the one sweep loop", issue #269's singleton-role defense in depth, where
 * `wake-events.ts`'s `maestroIdFor` only ever wakes the bare id, so only
 * instance 1 is ever the one being addressed). This check answers a
 * different question — "is this studio a maestro AT ALL" — and a stray
 * `x--maestro--2` (however it came to exist) is still a maestro studio and
 * must still be excluded, not swept into "not instance 1, allow it". PR #9
 * review, item (b): the original copy of do.ts's check left exactly that gap
 * open.
 */
function isMaestroStudio(studioId: string): boolean {
  const id = parseStudioId(studioId);
  return id?.role === "maestro";
}

/**
 * PR #9 review, F3: the request body, or `null` if it is over `cap` — read
 * off the actual byte STREAM, never via `req.text()`. `.text()` fully
 * materializes the body into one JS string before anything downstream can
 * compare its size against `cap`, which is exactly the DoS shape a body cap
 * exists to prevent: a declared-or-actual size under whatever platform
 * ceiling exists but still large enough to matter gets fully allocated
 * regardless of what this function would have said about it.
 *
 * Pumps the reader chunk by chunk, summing byte lengths as it goes, and
 * cancels the reader (never reads another byte) the instant the running total
 * crosses `cap` — a lying-or-absent Content-Length header (this module's own
 * early header check catches an HONEST one) is caught here from the real
 * bytes, without ever concatenating an oversized body into one buffer.
 *
 * `req.body === null` (a GET, or a POST with a genuinely empty body) reads as
 * the empty string — the same shape `req.text()` would have produced.
 */
async function readCappedBody(req: Request, cap: number): Promise<string | null> {
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function handleFleetJunior(
  req: Request, env: Env,
  api: BoardApi = githubBoardApi(env),
  rows: () => Promise<StudioStatus[]> = () => listStudios(env),
  heartbeatMs = HEARTBEAT_MS,
): Promise<Response> {
  if (new URL(req.url).pathname !== "/fleet/junior") return text("not found", 404);
  if (env.FLEET_JUNIOR !== "on" || !env.AI) return text("not found", 404);
  if (req.method !== "POST") return text("method not allowed", 405);

  // PR #9 review, F3: cheapest possible refusal, ahead of auth and every
  // other check — a declared Content-Length already over the cap needs no
  // token check, no board call, and (the whole point) no byte of the body
  // ever read. A caller that lies UNDER the real size is still caught below,
  // where the body is actually read.
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > JUNIOR_BODY_CAP) return text("payload too large", 413);
  }

  const presented = req.headers.get(SPAWN_TOKEN_HEADER);
  if (!isSpawnTokenShaped(presented)) return text("unauthorized", 401);
  const studio = await resolveSpawnParent(await rows(), presented);
  if (!studio) return text("unauthorized", 401);
  // F2: absolute, and first — before juniorEnabled, before any board call,
  // before a D1 read. See isMaestroStudio's own doc comment.
  if (isMaestroStudio(studio.id)) return text("junior not authorized for your current task", 403);
  if (!juniorEnabled(env, studio.repoSlug ?? env.AGENT_REPO)) return text("not found", 404);

  // The maestro's gate: only a live task it filed with `--junior` lets this
  // studio through. Read fresh every call — a completed or reassigned task
  // must stop authorizing at once. A board error fails CLOSED.
  //
  // PR #9 review, blocker B1: `findLiveAssignedTask` finds the CANDIDATE task
  // (open, live state, assigned to this studio) from board/GitHub signals the
  // Worker itself controls the meaning of. Whether THAT task was actually
  // authorized for junior is then answered from D1 (isJuniorAuthorized),
  // never from `JUNIOR_LABEL` on the issue — see board.ts's own doc comment
  // on findLiveAssignedTask and authz.ts's header for the full argument. A
  // studio's own `gh` token can label its own issue; it can never write a
  // fleet_state row.
  const repo = resolveStudioBoardRepo(studio.repoSlug, env.AGENT_REPO, undefined);
  if (!repo.ok) return text("junior not authorized for your current task", 403);
  let live;
  try { live = await findLiveAssignedTask(api, repo.value, studio.id); }
  catch { return text("board unavailable", 503); }
  if (!live.ok) return text("board unavailable", 503);
  if (live.value === null) return text("junior not authorized for your current task", 403);
  // Issue #10: a reopened task is not the task the maestro authorized. Its
  // record is revoked here for good; open + live + assigned alone come back
  // with any reopen, whoever did it.
  if (live.value.reopened === true) {
    await revokeJuniorAuthorization(env.DB, repo.value, live.value.number);
    return text("junior not authorized for your current task", 403);
  }
  const authorized = await isJuniorAuthorized(env.DB, repo.value, live.value.number, studio.id);
  if (!authorized) return text("junior not authorized for your current task", 403);

  // F1: only an AUTHORIZED call consumes rate budget — a caller hammering an
  // unauthorized/misconfigured task must not be able to burn through its own
  // allowance before it is ever entitled to spend it. Checked after
  // authorization, before any body work or the AI call itself.
  const rate = await checkAndConsumeJuniorRateLimit(env.DB, env, studio.id, Date.now());
  if (!rate.ok) {
    return text(
      rate.limit === "per-minute"
        ? "rate limit exceeded: too many /fleet/junior calls this minute"
        : "rate limit exceeded: daily /fleet/junior cap reached",
      429,
    );
  }

  const raw = await readCappedBody(req, JUNIOR_BODY_CAP);
  if (raw === null) return text("payload too large", 413);
  let body: Json;
  try { body = JSON.parse(raw); } catch { return text("bad json", 400); }
  if (!JUNIOR_MODELS.includes(body?.model)) return text("model not allowed", 400);
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return text("messages required", 400);
  // The Worker's AI binding is the real trust boundary — it is what talks to
  // the billed Workers AI service — so the 128,000 ceiling documented as a
  // Global Constraint (matching skills/junior/src/client.ts's MAX_TOKENS_CAP)
  // must be enforced here too, not only client-side where an already-
  // authorized studio could simply skip it and call this route directly.
  const maxTokens = Math.min(Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 64_000, 128_000);

  const mode = readJuniorMode(req);
  const ai = env.AI;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  // A client that disconnects (or whose own AbortSignal fires) while ai.run()
  // is still in flight leaves this writer closed/errored well before that
  // call resolves — every heartbeat tick after that would otherwise reject
  // with nothing to catch it (an unhandled rejection on every 15s tick for
  // the rest of the call). Stop retrying the moment a write fails instead of
  // firing into a dead writer indefinitely.
  const beat = setInterval(() => { w.write(enc.encode(" ")).catch(() => clearInterval(beat)); }, heartbeatMs);
  void (async () => {
    let out: string;
    let ok: boolean;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const normalized = normalizeAiResult(await ai.run(body.model, { messages: body.messages, max_tokens: maxTokens }));
      inputTokens = normalized.usage.in;
      outputTokens = normalized.usage.out;
      ok = true;
      out = JSON.stringify(normalized);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ok = false;
      out = JSON.stringify({ error: { code: aiErrorCode(message), message } });
    } finally {
      clearInterval(beat);
    }
    // Issue #218: fire-and-forget, own catch — a usage-logging failure must
    // never affect (or delay) the result already written to the studio
    // below. Never awaited before the write/close.
    void insertJuniorUsage(env.DB, {
      id: crypto.randomUUID(), ts: Date.now(), studioId: studio.id, mode, model: body.model,
      inputTokens, outputTokens, ok,
    }).catch(() => {});
    // A client that aborted mid-call leaves this writer closed/errored by
    // the time the AI call resolves — writing to it then would otherwise be
    // an unhandled rejection inside this detached IIFE. Swallow it: the
    // caller is gone, so there is nothing left to deliver the result to.
    try {
      await w.write(enc.encode(out));
      await w.close();
    } catch { /* client disconnected before the result was ready */ }
  })();
  return new Response(readable, { status: 200, headers: { "content-type": "application/json" } });
}
