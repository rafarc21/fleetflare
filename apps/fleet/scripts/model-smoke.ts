#!/usr/bin/env bun
// apps/fleet/scripts/model-smoke.ts — live smoke for one pool model (spec
// 2026-10-13-model-pool-design, "Entry rule": a model joins the pool
// (`smokePassed: true` in src/llm/models.ts) only after THIS script passes
// against the real, live Workers AI binding through the gateway — never run
// in a studio container (no Cloudflare credentials exist there; see
// docs/operations.md's "Model pool" section), only by the maestro.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { modelByKey, type PoolModel } from "../src/llm/models";
import { checkDeprecation, type DeprecationStatus, type ModelCatalogEntry } from "../src/llm/deprecation";
import { anthropicRequestToOpenAI, openAIResponseToAnthropic } from "../src/llm/translate";

// Issue #1476: CF retired kimi-k2.7-code and deepseek-v4-pro-0813 with no
// signal into this repo; the pool kept `smokePassed: true` on both, so a
// studio kept reaching a dead id until an operator noticed. Refuse before
// spending a live inference call on an id CF's own catalog has dropped —
// same read-only `wrangler` spawnSync pattern as scripts/deploy-target.ts's
// `wranglerJson` (appDir = scripts/..).
//
// Round 2 (#1476): the subcommand is `wrangler ai models list --json`
// (wrangler 4.141) — `wrangler ai models --json` (round 1) is not a real
// command. Retirement is catalog-ABSENCE, not a stale date (see
// deprecation.ts's own round-2 note): CF simply drops a retired id from
// this list entirely, it does not keep listing it with a past
// `planned_deprecation_date`.
//
// Round 3 (#1476): two bugs found by a LIVE review run.
//
// 1. `.id` on a real `wrangler ai models list --json` catalog entry is a
// UUID on every entry — the model id string this repo cares about (e.g.
// `@cf/zai-org/glm-5.3`) sits in `.name`. `parseCatalogEntry` below reads
// `.name` first so the catalog-absence check actually compares the right
// field (the round-2 code read `e.id ?? e.name`, which made every live
// model's lookup compare a UUID the model's own `.id` never matches — every
// model looked "retired").
//
// 2. The gateway cache can serve a smoke call's exact request body back as
// a HIT (measured live: `cf-aig-cache-status: HIT`, 100-168ms, on all 3
// call shapes) — a "pass" reading a cached response never actually proves
// the live model still works. `smokeCall` below sends the AI Gateway
// cache-skip header on every call this script makes.
//
// Round 2/3: the catalog-fetch + decide-whether-to-call-inference logic is
// now one pure function, `planSmokeCatalogCheck`, exported so a test can
// exercise it directly (catalog array + target id in, a decision out) —
// the round-2 code had this logic inline in top-level script statements,
// which no test could reach without actually spawning live `wrangler` with
// real Cloudflare credentials. `main` below is now the only thing left that
// spawns `wrangler`, calls `process.exit`, or makes a live inference fetch —
// thin glue around the pure pieces, gated behind `import.meta.main` so a
// test can import this module's exported functions without running `main`
// (and without the live credential/network side effects it needs).

/** The decision `main` acts on, given a parsed catalog + the target model's
 *  id — pure, no wrangler spawn and no process.exit inside it, so a test can
 *  drive every branch directly. */
export interface SmokeCatalogDecision {
  status: DeprecationStatus;
  /** false: `main` must refuse before any inference call. */
  proceed: boolean;
  /** The exact string `main` prints (via console.error when !proceed, else
   *  console.warn on a "warn" status) — null when there is nothing to say
   *  (status "ok", no planned_deprecation_date on the entry at all). */
  message: string | null;
}

export function planSmokeCatalogCheck(
  entries: readonly ModelCatalogEntry[], targetId: string, now: number, warnDays = 14,
): SmokeCatalogDecision {
  const status = checkDeprecation(entries, targetId, now, warnDays);
  if (status === "retired") {
    return {
      status, proceed: false,
      message: `${targetId} is retired — absent from CF's own catalog (wrangler ai models list --json), or carries a past planned_deprecation_date — refusing before spending an inference call`,
    };
  }
  if (status === "warn") {
    const entry = entries.find((e) => e.id === targetId);
    return {
      status, proceed: true,
      message: `model-smoke: ${targetId} deprecation is within the warning window (planned_deprecation_date=${entry?.planned_deprecation_date})`,
    };
  }
  return { status, proceed: true, message: null };
}

/** L1 (#1476 round 3): 0 of 52 live models carry `planned_deprecation_date`
 *  as a top-level field today — CF's real shape for a model it HAS flagged
 *  carries it under `properties: [{ property_id, value }, ...]` instead.
 *  Checks the top-level field first (never seen live, but cheap and keeps
 *  the simpler shape working if CF ever sends it that way), else scans
 *  `properties[]` for the matching entry. */
function readPlannedDeprecationDate(e: any): string | null | undefined {
  if (e.planned_deprecation_date !== undefined) return e.planned_deprecation_date;
  const props = Array.isArray(e.properties) ? e.properties : [];
  const prop = props.find((p: any) => p?.property_id === "planned_deprecation_date");
  return prop?.value;
}

/** R1 (#1476 round 3): `.name` is the model id string (e.g.
 *  `@cf/zai-org/glm-5.3`); `.id` is a UUID on every live catalog entry —
 *  preferring `.name` is the actual fix, `.id` stays as a fallback only for
 *  a catalog shape that genuinely has no `.name` at all. */
export function parseCatalogEntry(e: any): ModelCatalogEntry {
  return { id: e.name ?? e.id, planned_deprecation_date: readPlannedDeprecationDate(e) };
}

/** AI Gateway's own cache-skip header (round 3, #1476) — every inference
 *  call model-smoke.ts makes must send it so a smoke "pass" proves the LIVE
 *  model still works, not a cached response from an earlier run. */
export const AI_GATEWAY_SKIP_CACHE_HEADER = "cf-aig-skip-cache";

/** The one place every live inference call this script makes goes through
 *  (tool call, multi-turn, stream — `main`'s own `call()` wraps this
 *  unchanged for all three), so the cache-skip header only needs setting
 *  once. `fetchImpl` defaults to the real global `fetch`; a test passes a
 *  stub to intercept the request without any network. */
export async function smokeCall(
  url: string, token: string, model: PoolModel, body: unknown, fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      [AI_GATEWAY_SKIP_CACHE_HEADER]: "true",
    },
    body: JSON.stringify(anthropicRequestToOpenAI(body, model)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function main(): Promise<void> {
  const key = process.argv[2];
  const m = key ? modelByKey(key) : undefined;
  if (!m) {
    console.error("usage: bun scripts/model-smoke.ts glm|kimi|deepseek");
    process.exit(2);
    return;
  }

  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const gw = process.env.GATEWAY_ID ?? "default";
  if (!acct || !token) {
    console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required");
    process.exit(2);
    return;
  }

  const appDir = join(import.meta.dir, "..");
  const catalog = spawnSync(join(appDir, "node_modules", ".bin", "wrangler"), ["ai", "models", "list", "--json"], {
    cwd: appDir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: acct, CLOUDFLARE_API_TOKEN: token },
  });
  if (catalog.status !== 0) {
    console.error(`SMOKE FAIL catalog fetch: wrangler ai models list --json exited ${catalog.status}: ${(catalog.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
    process.exit(1);
    return;
  }
  let entries: ModelCatalogEntry[] = [];
  try {
    const out = catalog.stdout ?? "";
    entries = JSON.parse(out.slice(out.search(/[[{]/))).map(parseCatalogEntry);
  } catch (e) {
    console.error(`SMOKE FAIL catalog parse: ${String(e)}`);
    process.exit(1);
    return;
  }

  const decision = planSmokeCatalogCheck(entries, m.id, Date.now());
  if (!decision.proceed) {
    console.error(`SMOKE FAIL ${decision.message}`);
    process.exit(1);
    return;
  }
  if (decision.message !== null) console.warn(decision.message);

  const url = `https://gateway.ai.cloudflare.com/v1/${acct}/${gw}/workers-ai/${m.id}`;
  const tools = [
    {
      name: "get_weather",
      description: "weather for a city",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  ];

  const call = (body: unknown): Promise<Response> => smokeCall(url, token, m, body);

  const first = { messages: [{ role: "user", content: "Call get_weather for Paris." }], tools, max_tokens: 1024 };

  // 1. Tool call.
  const r1 = openAIResponseToAnthropic(await (await call(first)).json().then((j: any) => j.result ?? j), { model: m.id, requestedMaxTokens: first.max_tokens });
  const tu = r1.content.find((b: any) => b.type === "tool_use");
  if (!tu || tu.name !== "get_weather" || String(tu.input?.city).toLowerCase() !== "paris") {
    console.error("SMOKE FAIL tool_call", JSON.stringify(r1.content).slice(0, 300));
    process.exit(1);
    return;
  }

  // 2. Multi-turn — feed the tool_result back, expect the final text to use it.
  const second = {
    ...first,
    messages: [
      ...first.messages,
      { role: "assistant", content: r1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "18C sunny" }] },
    ],
  };
  const r2 = openAIResponseToAnthropic(await (await call(second)).json().then((j: any) => j.result ?? j), { model: m.id, requestedMaxTokens: first.max_tokens });
  if (!JSON.stringify(r2.content).includes("18")) {
    console.error("SMOKE FAIL multi_turn");
    process.exit(1);
    return;
  }

  // 3. Stream — same request, stream: true; just check the raw SSE shape.
  const s = await call({ ...first, stream: true });
  const text = await s.text();
  if (!/data:/.test(text) || !/\[DONE\]|finish_reason/.test(text)) {
    console.error("SMOKE FAIL stream");
    process.exit(1);
    return;
  }

  console.log(`SMOKE PASS ${m.id}`);
}

if (import.meta.main) {
  await main();
}
