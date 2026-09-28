// apps/fleet/src/junior/route.ts
// POST /fleet/junior — the studio's road to Workers AI. Spawn-token auth, same
// as /fleet/tasks (board/routes.ts's handleFleetBoard). The Worker's own AI
// binding makes the call, so the container never holds a Cloudflare
// credential (house rule "deploy credentials", blueprint.ts).
import type { Env } from "../env";
import { isSpawnTokenShaped, resolveSpawnParent, SPAWN_TOKEN_HEADER } from "../studio/spawn";
import { listStudios } from "../studio/registry";
import type { StudioStatus } from "../studio/types";
import { JUNIOR_MODELS, juniorEnabled } from "./gate";
import { findLiveAssignedTask, type BoardApi } from "../board/board";
import { isJuniorAuthorized } from "./authz";
import { githubBoardApi, resolveStudioBoardRepo } from "../board/routes";

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

export async function handleFleetJunior(
  req: Request, env: Env,
  api: BoardApi = githubBoardApi(env),
  rows: () => Promise<StudioStatus[]> = () => listStudios(env),
  heartbeatMs = HEARTBEAT_MS,
): Promise<Response> {
  if (new URL(req.url).pathname !== "/fleet/junior") return text("not found", 404);
  if (env.FLEET_JUNIOR !== "on" || !env.AI) return text("not found", 404);
  if (req.method !== "POST") return text("method not allowed", 405);

  const presented = req.headers.get(SPAWN_TOKEN_HEADER);
  if (!isSpawnTokenShaped(presented)) return text("unauthorized", 401);
  const studio = await resolveSpawnParent(await rows(), presented);
  if (!studio) return text("unauthorized", 401);
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
  const authorized = await isJuniorAuthorized(env.DB, repo.value, live.value.number, studio.id);
  if (!authorized) return text("junior not authorized for your current task", 403);

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > JUNIOR_BODY_CAP) return text("payload too large", 413);
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
    try {
      out = JSON.stringify(normalizeAiResult(await ai.run(body.model, { messages: body.messages, max_tokens: maxTokens })));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out = JSON.stringify({ error: { code: aiErrorCode(message), message } });
    } finally {
      clearInterval(beat);
    }
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
