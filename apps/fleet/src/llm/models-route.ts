// Operator routes for #717's model pool (spec 2026-10-13-model-pool-design,
// Task 5): list every pool model + its state + per-studio assignments, and
// assign/promote/demote. This is the unauthenticated INNER handler — the
// mount point (src/studio/routes.ts's handleStudio, same lane as
// /studio/accounts*) already ran verifyAccess before reaching here, exactly
// like that file's own accounts routes; this module carries no auth of its
// own by design, so every test below calls it directly.
import { POOL, modelByKey, modelById } from "./models";
import { getModelStates, setAssignedModel, setModelState } from "./model-store";
import type { Env } from "../env";

// Accepts either a pool `key` ("kimi") or a raw Workers AI `id`
// ("@cf/moonshotai/kimi-k2.7-code") — the CLI and a human curling this
// route both reach for the short key, D1-stored assignments are the id.
const resolve = (m: unknown) => (typeof m === "string" ? modelByKey(m) ?? modelById(m) : undefined);

const j = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export async function handleModelsRoute(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname;

  if (path === "/studio/models") {
    if (req.method !== "GET") return j({ error: "method not allowed" }, 405);
    const states = await getModelStates(env.DB);
    // No scanStateTaskKeys-style prefix helper fits `lead-model:*` (every
    // existing one is keyed to a different prefix family) — a raw scan
    // against the real fleet_state schema (key, value, ts; see state.ts).
    const rows = await env.DB
      .prepare("SELECT key, value FROM fleet_state WHERE key LIKE 'lead-model:%'")
      .all<{ key: string; value: string }>();
    const assignments: Record<string, string> = {};
    for (const r of rows.results ?? []) assignments[r.key.slice("lead-model:".length)] = r.value;
    return j({
      models: POOL.map((m) => ({ key: m.key, id: m.id, state: states[m.id], smokePassed: m.smokePassed })),
      assignments,
    });
  }

  if (req.method !== "POST") return j({ error: "method not allowed" }, 405);

  let body: { studio?: unknown; model?: unknown };
  try {
    body = await req.json();
  } catch {
    return j({ error: "bad json body" }, 400);
  }

  const m = resolve(body.model);
  if (!m) return j({ error: `unknown model ${JSON.stringify(body.model)}` }, 400);

  if (path === "/studio/models/assign") {
    if (typeof body.studio !== "string" || body.studio.length === 0) {
      return j({ error: "\"studio\" is required" }, 400);
    }
    await setAssignedModel(env.DB, body.studio, m.id);
    return j({ ok: true, studio: body.studio, model: m.id });
  }
  if (path === "/studio/models/promote") {
    await setModelState(env.DB, m.id, "active");
    return j({ ok: true, model: m.id, state: "active" });
  }
  if (path === "/studio/models/demote") {
    await setModelState(env.DB, m.id, "demoted");
    return j({ ok: true, model: m.id, state: "demoted" });
  }
  return j({ error: "not found" }, 404);
}
