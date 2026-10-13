# Model Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every non-Claude studio lead call through AI Gateway `default` across a pool of Workers AI models (GLM 5.3, Kimi K2.7 Code, DeepSeek v4 Pro), with per-studio main model, role pick, 429/3021 overflow, and per-model quality auto-demotion.

**Architecture:** Pure registry (`src/llm/models.ts`) + pure picker (`src/llm/router.ts`) + D1-flag persistence (`src/llm/model-store.ts`, existing `fleet_state` table via `getFlag`/`setFlag`, no migration). `anthropic-route.ts` walks the picked list, calling `env.AI.run(model, body, { gateway: { id } })`. Quality: pure stats/demotion (`src/llm/model-quality.ts`) run by the Worker cron daily; operator CLI `fleet models`.

**Tech Stack:** Cloudflare Workers (TypeScript), Workers AI binding, AI Gateway, D1, vitest (`cloudflare:test` pool) + bun test, existing fleet CLI.

**Spec:** `docs/superpowers/specs/2026-10-13-model-pool-design.md`

## Global Constraints

- Every `env.AI.run` from the lead route passes `{ gateway: { id: <LEAD_AI_GATEWAY_ID, default "default"> } }`.
- Pool v1 = exactly three models; a model is `active` only if its smoke test passed (`smokePassed: true` in registry).
- Feature flag `LEAD_MODEL_POOL` = `"on"` enables pool; anything else → today's behavior (GLM only) but STILL through the gateway.
- 429 / 3021 / rate-limit text → next model, no backoff. 504/529 → existing #335 retry on same model, then next model. Never switch after the first stream byte.
- All exhausted → HTTP 429 Anthropic `rate_limit_error` with `retry-after: 30`.
- Demotion rule: over last 10 closed PRs of a model, first-try CI pass rate ≥ 25 points below best model's, OR ≥ 2 post-merge reverts.
- No migration. Persistence keys in `fleet_state`: `lead-model:<studioId>` → model id; `model-state:<modelId>` → `active|overflow|demoted`.
- Unchanged: per-studio `LEAD_RATE_PER_MINUTE`, `LEAD_DAILY_CAP`, auth gate, junior route.
- Claude-tier implementation only (route every GLM studio depends on).
- PR bodies: `refs #N`, never closing keywords.

## Review Focus

1. Unknown / malformed `lead-model:` flag value (typo'd model id) → ignored, round-robin default used; never a 500.
2. Every pool model demoted or overflow-only → picker still returns ≥1 model (demoted tail) — a studio is never left with an empty list.
3. 3021 on the LAST model in the list → 429 with retry-after, usage row logged with the last model tried, not GLM hardcoded.
4. Requested model name absent / empty / non-string → treated as "lead" role, not "small".
5. `LEAD_MODEL_POOL` off → exactly one model (GLM) tried, still via gateway — today's behavior preserved except routing.

Each line above has its test in the owning task (Tasks 2, 3, 4).

---

## File Structure

- Create `apps/fleet/src/llm/models.ts` — pool registry: ids, quirks, smoke flag. Pure.
- Create `apps/fleet/src/llm/router.ts` — `pickModels()`. Pure.
- Create `apps/fleet/src/llm/model-store.ts` — read/write `lead-model:*` and `model-state:*` flags.
- Create `apps/fleet/src/llm/model-quality.ts` — `modelStats()`, `shouldDemote()`. Pure.
- Modify `apps/fleet/src/llm/translate.ts` — `anthropicRequestToOpenAI(body, model)` takes model + per-model min max_tokens.
- Modify `apps/fleet/src/llm/anthropic-route.ts:497-525` — picker + gateway + overflow loop; log actual model.
- Modify `apps/fleet/src/env.ts` — `LEAD_MODEL_POOL?`, `LEAD_AI_GATEWAY_ID?`.
- Modify `apps/fleet/src/studio/spawn.ts:345-350` — `--lead kimi|deepseek` accepted (maps to `leadType: "glm"` + model assignment).
- Create `apps/fleet/src/llm/models-route.ts` — operator routes `GET /studio/models`, `POST /studio/models/assign|promote|demote`.
- Modify `apps/fleet/cli/fleet.ts` + `apps/fleet/src/studio/cli-args.ts` — `fleet models [assign <studio> <model>|promote <model>|demote <model>]`.
- Modify `apps/fleet/src/index.ts` scheduled handler — daily quality pass.
- Create `apps/fleet/scripts/model-smoke.ts` — live smoke per model.
- Tests: `apps/fleet/test/bun/llm-models.test.ts`, `test/bun/llm-router.test.ts`, `test/bun/llm-model-quality.test.ts`, `test/llm.model-store.test.ts`, extend `test/llm.anthropic-route.test.ts`, `test/bun/llm-translate.test.ts`.
- Docs: `docs/setup.md` (two env vars), `docs/operations.md` (`fleet models`).

---

### Task 1: Pool registry

**Files:**
- Create: `apps/fleet/src/llm/models.ts`
- Test: `apps/fleet/test/bun/llm-models.test.ts`

**Interfaces:**
- Produces:
  - `type ModelState = "active" | "overflow" | "demoted"`
  - `interface PoolModel { key: "glm" | "kimi" | "deepseek"; id: string; minMaxTokens: number; smokePassed: boolean }`
  - `const POOL: readonly PoolModel[]`
  - `function modelByKey(key: string): PoolModel | undefined`
  - `function modelById(id: string): PoolModel | undefined`

- [ ] **Step 1: Confirm exact model ids** — open https://developers.cloudflare.com/workers-ai/models/ and copy the Kimi K2.7 Code and DeepSeek v4 Pro ids exactly (GLM is `@cf/zai-org/glm-5.3`, already in `translate.ts:28`). Put them in Step 3's code. Do not guess the Kimi namespace.

- [ ] **Step 2: Write the failing test**

```ts
// apps/fleet/test/bun/llm-models.test.ts
import { describe, it, expect } from "bun:test";
import { POOL, modelByKey, modelById } from "../../src/llm/models";

describe("model pool registry", () => {
  it("has exactly glm, kimi, deepseek in that order", () => {
    expect(POOL.map((m) => m.key)).toEqual(["glm", "kimi", "deepseek"]);
  });
  it("every id is a @cf/ Workers AI id and unique", () => {
    expect(POOL.every((m) => m.id.startsWith("@cf/"))).toBe(true);
    expect(new Set(POOL.map((m) => m.id)).size).toBe(POOL.length);
  });
  it("glm keeps today's id and 16000 max_tokens floor", () => {
    expect(modelByKey("glm")).toEqual({ key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: 16000, smokePassed: true });
  });
  it("lookups miss cleanly", () => {
    expect(modelByKey("gpt4")).toBeUndefined();
    expect(modelById("@cf/nope/nope")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/fleet && bun test test/bun/llm-models.test.ts`
Expected: FAIL — cannot find module `../../src/llm/models`.

- [ ] **Step 4: Implement**

```ts
// apps/fleet/src/llm/models.ts
// Model pool for non-Claude studio leads (spec 2026-10-13-model-pool-design).
// Per account, per model rate limits on Workers AI: each model adds its own budget.
export type ModelState = "active" | "overflow" | "demoted";

export interface PoolModel {
  key: "glm" | "kimi" | "deepseek";
  id: string;
  /** Floor on max_tokens sent upstream; reasoning models burn budget first (translate.ts GLM_MIN_MAX_TOKENS). */
  minMaxTokens: number;
  /** True only after scripts/model-smoke.ts passed against live Workers AI. */
  smokePassed: boolean;
}

export const POOL: readonly PoolModel[] = [
  { key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: 16000, smokePassed: true },
  { key: "kimi", id: "<KIMI_ID_FROM_STEP_1>", minMaxTokens: 16000, smokePassed: false },
  { key: "deepseek", id: "@cf/deepseek-ai/deepseek-v4-pro-0813", minMaxTokens: 16000, smokePassed: false },
];

export function modelByKey(key: string): PoolModel | undefined {
  return POOL.find((m) => m.key === key);
}

export function modelById(id: string): PoolModel | undefined {
  return POOL.find((m) => m.id === id);
}
```

Replace `<KIMI_ID_FROM_STEP_1>` with the id copied in Step 1 before running tests (the uniqueness/`@cf/` test fails otherwise).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/fleet && bun test test/bun/llm-models.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/llm/models.ts apps/fleet/test/bun/llm-models.test.ts
git commit -m "feat(llm): model pool registry (refs #N)"
```

---

### Task 2: Model picker

**Files:**
- Create: `apps/fleet/src/llm/router.ts`
- Test: `apps/fleet/test/bun/llm-router.test.ts`

**Interfaces:**
- Consumes: `POOL`, `PoolModel`, `ModelState`, `modelById` (Task 1).
- Produces:
  - `function isSmallModelName(requested: unknown): boolean`
  - `function defaultModelFor(studioId: string, pool: readonly PoolModel[], states: Record<string, ModelState>): string`
  - `function pickModels(input: { studioId: string; requestedModel: unknown; assigned: string | null; states: Record<string, ModelState>; pool?: readonly PoolModel[]; poolOn: boolean }): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/llm-router.test.ts
import { describe, it, expect } from "bun:test";
import { pickModels, isSmallModelName, defaultModelFor } from "../../src/llm/router";
import type { PoolModel } from "../../src/llm/models";

const P: PoolModel[] = [
  { key: "glm", id: "@cf/a/glm", minMaxTokens: 1, smokePassed: true },
  { key: "kimi", id: "@cf/b/kimi", minMaxTokens: 1, smokePassed: true },
  { key: "deepseek", id: "@cf/c/ds", minMaxTokens: 1, smokePassed: true },
];
const ALL = { "@cf/a/glm": "active", "@cf/b/kimi": "active", "@cf/c/ds": "active" } as const;
const base = { studioId: "repo--web-studio--49", requestedModel: "claude-opus-4", pool: P, poolOn: true };

describe("isSmallModelName", () => {
  it("haiku-ish names are small", () => { expect(isSmallModelName("claude-3-5-haiku-latest")).toBe(true); });
  it("lead names are not small", () => { expect(isSmallModelName("claude-opus-4")).toBe(false); });
  it("absent/empty/non-string is lead role", () => {
    expect(isSmallModelName(undefined)).toBe(false);
    expect(isSmallModelName("")).toBe(false);
    expect(isSmallModelName(42)).toBe(false);
  });
});

describe("pickModels", () => {
  it("pool off: GLM only (pool[0])", () => {
    expect(pickModels({ ...base, poolOn: false, assigned: "@cf/b/kimi", states: { ...ALL } })).toEqual(["@cf/a/glm"]);
  });
  it("assigned main model first, then the rest in pool order", () => {
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...ALL } })).toEqual(["@cf/b/kimi", "@cf/a/glm", "@cf/c/ds"]);
  });
  it("small role: next active model after main goes first", () => {
    expect(pickModels({ ...base, requestedModel: "claude-haiku", assigned: "@cf/b/kimi", states: { ...ALL } }))
      .toEqual(["@cf/c/ds", "@cf/b/kimi", "@cf/a/glm"]);
  });
  it("unknown assigned id falls back to round-robin default", () => {
    const out = pickModels({ ...base, assigned: "@cf/typo/x", states: { ...ALL } });
    expect(out[0]).toBe(defaultModelFor(base.studioId, P, { ...ALL }));
    expect(out).toHaveLength(3);
  });
  it("overflow models after active; demoted last", () => {
    const states = { "@cf/a/glm": "demoted", "@cf/b/kimi": "overflow", "@cf/c/ds": "active" } as const;
    expect(pickModels({ ...base, assigned: null, states: { ...states } })).toEqual(["@cf/c/ds", "@cf/b/kimi", "@cf/a/glm"]);
  });
  it("assigned but demoted: not first", () => {
    const states = { "@cf/a/glm": "active", "@cf/b/kimi": "demoted", "@cf/c/ds": "active" } as const;
    expect(pickModels({ ...base, assigned: "@cf/b/kimi", states: { ...states } })[0]).not.toBe("@cf/b/kimi");
  });
  it("never empty even when everything is demoted", () => {
    const states = { "@cf/a/glm": "demoted", "@cf/b/kimi": "demoted", "@cf/c/ds": "demoted" } as const;
    expect(pickModels({ ...base, assigned: null, states: { ...states } }).length).toBe(3);
  });
  it("models with smokePassed false are excluded", () => {
    const pool = P.map((m) => (m.key === "kimi" ? { ...m, smokePassed: false } : m));
    expect(pickModels({ ...base, pool, assigned: "@cf/b/kimi", states: { ...ALL } })).not.toContain("@cf/b/kimi");
  });
});

describe("defaultModelFor", () => {
  it("is stable per studio id and lands on an active model", () => {
    const a = defaultModelFor("x--web-studio--45", P, { ...ALL });
    expect(defaultModelFor("x--web-studio--45", P, { ...ALL })).toBe(a);
    expect(P.map((m) => m.id)).toContain(a);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/fleet && bun test test/bun/llm-router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/llm/router.ts
// Pure model picker (spec 2026-10-13-model-pool-design, Components 3).
import { POOL, type ModelState, type PoolModel } from "./models";

const SMALL = /haiku|small|fast|mini/i;

/** Claude Code names its helper/background calls with a small-model id. Anything else = lead role. */
export function isSmallModelName(requested: unknown): boolean {
  return typeof requested === "string" && requested.length > 0 && SMALL.test(requested);
}

function stateOf(states: Record<string, ModelState>, id: string): ModelState {
  return states[id] ?? "active";
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Round-robin default: stable per studio id over smoke-passed active models (any eligible model if none active). */
export function defaultModelFor(studioId: string, pool: readonly PoolModel[], states: Record<string, ModelState>): string {
  const eligible = pool.filter((m) => m.smokePassed);
  const active = eligible.filter((m) => stateOf(states, m.id) === "active");
  const from = active.length > 0 ? active : eligible;
  return from[hash(studioId) % from.length].id;
}

export function pickModels(input: {
  studioId: string; requestedModel: unknown; assigned: string | null;
  states: Record<string, ModelState>; pool?: readonly PoolModel[]; poolOn: boolean;
}): string[] {
  const pool = input.pool ?? POOL;
  if (!input.poolOn) return [pool[0].id];
  const eligible = pool.filter((m) => m.smokePassed);
  const rank = (id: string) => ({ active: 0, overflow: 1, demoted: 2 })[stateOf(input.states, id)];
  const known = input.assigned !== null && eligible.some((m) => m.id === input.assigned);
  const main = known && rank(input.assigned!) === 0 ? input.assigned! : defaultModelFor(input.studioId, eligible, input.states);
  const rest = eligible.map((m) => m.id).filter((id) => id !== main).sort((a, b) => rank(a) - rank(b));
  let order = rank(main) === 0 ? [main, ...rest] : [...rest, main].sort((a, b) => rank(a) - rank(b));
  if (isSmallModelName(input.requestedModel)) {
    const i = order.findIndex((id, idx) => idx > 0 && rank(id) === 0);
    if (i > 0) order = [order[i], ...order.filter((_, idx) => idx !== i)];
  }
  return order;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/fleet && bun test test/bun/llm-router.test.ts`
Expected: PASS (all). If "small role" order differs, fix the implementation, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/llm/router.ts apps/fleet/test/bun/llm-router.test.ts
git commit -m "feat(llm): pure model picker — main, role, overflow, demoted tail (refs #N)"
```

---

### Task 3: Model store (assignment + state flags)

**Files:**
- Create: `apps/fleet/src/llm/model-store.ts`
- Test: `apps/fleet/test/llm.model-store.test.ts`

**Interfaces:**
- Consumes: `getFlag`, `setFlag`, `deleteFlag` from `src/state.ts`; `POOL`, `modelById`, `ModelState` (Task 1).
- Produces:
  - `function getAssignedModel(db: D1Database, studioId: string): Promise<string | null>` — returns id only if `modelById` knows it.
  - `function setAssignedModel(db: D1Database, studioId: string, modelId: string): Promise<void>` — throws on unknown id.
  - `function getModelStates(db: D1Database): Promise<Record<string, ModelState>>`
  - `function setModelState(db: D1Database, modelId: string, state: ModelState): Promise<void>`

- [ ] **Step 1: Read `src/state.ts:1-40`** for `getFlag(db, key)` / `setFlag(db, key, value, …)` exact signature; use it verbatim below.

- [ ] **Step 2: Write the failing test**

```ts
// apps/fleet/test/llm.model-store.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getAssignedModel, setAssignedModel, getModelStates, setModelState } from "../src/llm/model-store";
import { POOL } from "../src/llm/models";

describe("model store", () => {
  it("assignment round-trips for a pool model", async () => {
    await setAssignedModel(env.DB, "r--web-studio--49", POOL[1].id);
    expect(await getAssignedModel(env.DB, "r--web-studio--49")).toBe(POOL[1].id);
  });
  it("absent assignment reads null", async () => {
    expect(await getAssignedModel(env.DB, "r--web-studio--99")).toBeNull();
  });
  it("unknown stored id reads null (never trusted)", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO fleet_state (key, value) VALUES (?, ?)").bind("lead-model:r--x", "@cf/typo/x").run();
    expect(await getAssignedModel(env.DB, "r--x")).toBeNull();
  });
  it("set refuses unknown model", async () => {
    await expect(setAssignedModel(env.DB, "r--y", "@cf/typo/x")).rejects.toThrow(/unknown model/);
  });
  it("states default to active; set persists", async () => {
    expect((await getModelStates(env.DB))[POOL[2].id]).toBe("active");
    await setModelState(env.DB, POOL[2].id, "demoted");
    expect((await getModelStates(env.DB))[POOL[2].id]).toBe("demoted");
  });
});
```

If `fleet_state` column names differ, adapt the one raw INSERT to the real schema from `migrations/` (do not change store code to fit the test).

- [ ] **Step 3: Run to verify fail**

Run: `cd apps/fleet && npx vitest run test/llm.model-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// apps/fleet/src/llm/model-store.ts
// Model pool persistence on the existing fleet_state flag table — no migration.
import { getFlag, setFlag } from "../state";
import { POOL, modelById, type ModelState } from "./models";

const ASSIGN = (studioId: string) => `lead-model:${studioId}`;
const STATE = (modelId: string) => `model-state:${modelId}`;
const STATES: readonly ModelState[] = ["active", "overflow", "demoted"];

export async function getAssignedModel(db: D1Database, studioId: string): Promise<string | null> {
  const v = await getFlag(db, ASSIGN(studioId));
  return v !== null && modelById(v) ? v : null;
}

export async function setAssignedModel(db: D1Database, studioId: string, modelId: string): Promise<void> {
  if (!modelById(modelId)) throw new Error(`unknown model ${modelId}`);
  await setFlag(db, ASSIGN(studioId), modelId);
}

export async function getModelStates(db: D1Database): Promise<Record<string, ModelState>> {
  const out: Record<string, ModelState> = {};
  for (const m of POOL) {
    const v = await getFlag(db, STATE(m.id));
    out[m.id] = v !== null && (STATES as readonly string[]).includes(v) ? (v as ModelState) : "active";
  }
  return out;
}

export async function setModelState(db: D1Database, modelId: string, state: ModelState): Promise<void> {
  if (!modelById(modelId)) throw new Error(`unknown model ${modelId}`);
  await setFlag(db, STATE(modelId), state);
}
```

Match `setFlag`'s real arity from Step 1 (add the extra args it requires, e.g. a timestamp).

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/fleet && npx vitest run test/llm.model-store.test.ts`
Expected: PASS (5).

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/llm/model-store.ts apps/fleet/test/llm.model-store.test.ts
git commit -m "feat(llm): model assignment + pool state on fleet_state flags (refs #N)"
```

---

### Task 4: Route — gateway + model per request + overflow

**Files:**
- Modify: `apps/fleet/src/env.ts` (add two optional vars)
- Modify: `apps/fleet/src/llm/translate.ts:147-150`
- Modify: `apps/fleet/src/llm/anthropic-route.ts:445-525`
- Test: extend `apps/fleet/test/llm.anthropic-route.test.ts`, `apps/fleet/test/bun/llm-translate.test.ts`

**Interfaces:**
- Consumes: `pickModels` (Task 2), `getAssignedModel`, `getModelStates` (Task 3), `modelById` (Task 1).
- Produces:
  - `anthropicRequestToOpenAI(body: Json, model?: { id: string; minMaxTokens: number }): Json` — default GLM (back-compat for existing callers).
  - `logUsage` call shape gains `model: string`.
  - `const LEAD_AI_GATEWAY_DEFAULT = "default"`.

- [ ] **Step 1: Env vars.** In `src/env.ts` `Env` interface add:

```ts
  /** "on" enables the lead model pool (spec 2026-10-13-model-pool-design). */
  LEAD_MODEL_POOL?: string;
  /** AI Gateway id every lead Workers AI call routes through. Default "default". */
  LEAD_AI_GATEWAY_ID?: string;
```

- [ ] **Step 2: Failing translate test** (append to `test/bun/llm-translate.test.ts`):

```ts
import { anthropicRequestToOpenAI } from "../../src/llm/translate";
it("model override sets id and max_tokens floor", () => {
  const out = anthropicRequestToOpenAI({ messages: [{ role: "user", content: "hi" }], max_tokens: 10 }, { id: "@cf/b/kimi", minMaxTokens: 9000 });
  expect(out.model).toBe("@cf/b/kimi");
  expect(out.max_tokens).toBe(9000);
});
it("no override keeps GLM defaults", () => {
  const out = anthropicRequestToOpenAI({ messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
  expect(out.model).toBe("@cf/zai-org/glm-5.3");
  expect(out.max_tokens).toBe(16000);
});
```

Run: `cd apps/fleet && bun test test/bun/llm-translate.test.ts` → FAIL on the override test.

- [ ] **Step 3: Implement translate change** — `translate.ts:147-150`:

```ts
export function anthropicRequestToOpenAI(body: Json, model: { id: string; minMaxTokens: number } = { id: GLM_LEAD_MODEL, minMaxTokens: GLM_MIN_MAX_TOKENS }): Json {
  // ...existing message building unchanged...
  const out: Json = { model: model.id, messages, max_tokens: Math.max(Number(body.max_tokens) || 0, model.minMaxTokens) };
```

Update the function's doc comment: model is the picked pool model, default GLM. Run translate tests → PASS.

- [ ] **Step 4: Failing route tests** (append to `test/llm.anthropic-route.test.ts`, reuse its `row()`/token helpers and existing `env.AI` stubbing pattern in that file):

```ts
describe("model pool + gateway (spec 2026-10-13)", () => {
  it("every AI call carries the gateway option, pool off", async () => {
    const calls: unknown[][] = [];
    const ai = { run: vi.fn(async (...a: unknown[]) => { calls.push(a); return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }) };
    const res = await callRoute({ ai, envOverrides: {} }); // existing helper style in this file
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("@cf/zai-org/glm-5.3");
    expect(calls[0][2]).toEqual({ gateway: { id: "default" } });
  });
  it("pool on: 3021 on first model moves to next model, no backoff", async () => {
    const seen: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      seen.push(model);
      if (seen.length === 1) throw new Error("3021: rate limiting: Account rate limit exceeded");
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" } });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
  it("pool on: every model 429s → 429 rate_limit_error with retry-after", async () => {
    const ai = { run: vi.fn(async () => { throw new Error("3021: Account rate limit exceeded"); }) };
    const res = await callRoute({ ai, envOverrides: { LEAD_MODEL_POOL: "on" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json() as any).error.type).toBe("rate_limit_error");
  });
  it("custom gateway id via LEAD_AI_GATEWAY_ID", async () => {
    const calls: unknown[][] = [];
    const ai = { run: vi.fn(async (...a: unknown[]) => { calls.push(a); return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }) };
    await callRoute({ ai, envOverrides: { LEAD_AI_GATEWAY_ID: "fleet" } });
    expect(calls[0][2]).toEqual({ gateway: { id: "fleet" } });
  });
});
```

`callRoute` = whatever request-building helper the file already uses (read the file's top ~120 lines; if none, write a local helper that builds the authorized POST exactly like the file's existing happy-path test and calls `handleFleetAnthropicMessages(req, { ...env, AI: ai, ...envOverrides }, ctx)`). Classification `classifyAiError` already maps "rate limit" text to 429; "3021" alone must also count — add to Step 5.

Run: `cd apps/fleet && npx vitest run test/llm.anthropic-route.test.ts` → FAIL (no gateway arg; no overflow).

- [ ] **Step 5: Implement route** — in `anthropic-route.ts`:

```ts
import { pickModels } from "./router";
import { getAssignedModel, getModelStates } from "./model-store";
import { modelById, POOL } from "./models";

export const LEAD_AI_GATEWAY_DEFAULT = "default";
const isRateLimited = (message: string) => /\b3021\b|rate limit|too many/i.test(message);
```

Replace the single `runAiWithRetry(() => ai.run(GLM_LEAD_MODEL, openaiBody), …)` block (≈ lines 497-525) with:

```ts
  const poolOn = env.LEAD_MODEL_POOL === "on";
  const gateway = { gateway: { id: env.LEAD_AI_GATEWAY_ID || LEAD_AI_GATEWAY_DEFAULT } };
  const order = pickModels({
    studioId: studio.id, requestedModel: body.model, poolOn,
    assigned: poolOn ? await getAssignedModel(env.DB, studio.id) : null,
    states: poolOn ? await getModelStates(env.DB) : {},
  });
  const startedAt = Date.now();
  const stream = body.stream === true;
  let upstream: Json | undefined;
  let attempts = 0;
  let usedModel = order[0];
  let lastMessage = "";
  for (const modelId of order) {
    const pm = modelById(modelId) ?? POOL[0];
    const openaiBody = anthropicRequestToOpenAI(body, { id: pm.id, minMaxTokens: pm.minMaxTokens });
    try {
      const r = await runAiWithRetry(() => ai.run(pm.id, openaiBody, gateway), { baseMs: leadAiRetryBaseMs(env) });
      upstream = r.value; attempts += r.attempts; usedModel = pm.id;
      break;
    } catch (e) {
      lastMessage = e instanceof Error ? e.message : String(e);
      attempts += e instanceof AiRunError ? e.attempts : 1;
      usedModel = pm.id;
      const { status } = classifyAiError(lastMessage);
      // overflow only on rate limit / exhausted transient; other errors return as today
      if (!(isRateLimited(lastMessage) || status === 504 || status === 529)) break;
    }
  }
  if (upstream === undefined) {
    const rl = isRateLimited(lastMessage);
    const { status, type, message: overrideMessage } = rl ? { status: 429, type: "rate_limit_error", message: undefined } : classifyAiError(lastMessage);
    logUsage(env, ctx, studio.id, { model: usedModel, stream, inputTokens: 0, outputTokens: 0, ok: false, failure: `ai_run_error ${status} ${type}: ${lastMessage}`, startedAt, attempts });
    const res = json(anthropicErrorBody(type, overrideMessage ?? lastMessage), status);
    if (status === 429) res.headers.set("retry-after", "30");
    return res;
  }
```

Then thread `model: usedModel` into every later `logUsage(...)` call in this function, and change `logUsage` to take `model` in its `call` param and write `model: call.model` instead of `GLM_LEAD_MODEL`. Keep `requestedModel` for the response's display `model` field unchanged. Remove the now-unused single `openaiBody` declaration above the loop.

Note `json(...)` may return a Response whose headers are immutable in some runtimes — if `headers.set` throws in tests, build it as `new Response(JSON.stringify(anthropicErrorBody(...)), { status, headers: { "content-type": "application/json", "retry-after": "30" } })`.

- [ ] **Step 6: Run route + translate tests**

Run: `cd apps/fleet && npx vitest run test/llm.anthropic-route.test.ts && bun test test/bun/llm-translate.test.ts`
Expected: PASS, including all pre-existing tests (pool off path is today's behavior + gateway).

- [ ] **Step 7: Typecheck**

Run: `cd apps/fleet && bun run check`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/fleet/src/env.ts apps/fleet/src/llm/translate.ts apps/fleet/src/llm/anthropic-route.ts apps/fleet/test/llm.anthropic-route.test.ts apps/fleet/test/bun/llm-translate.test.ts
git commit -m "feat(llm): route lead calls via AI Gateway + pool overflow on 3021 (refs #N)"
```

---

### Task 5: Operator routes + `fleet models` CLI + spawn flag

**Files:**
- Create: `apps/fleet/src/llm/models-route.ts`
- Modify: `apps/fleet/src/index.ts` (mount routes next to existing `/studio/accounts*` routes)
- Modify: `apps/fleet/src/studio/spawn.ts:345-350` (`readLeadTypeRequest`) + spawn handler where `leadType` is persisted (≈ :548-560, :716-718)
- Modify: `apps/fleet/src/studio/cli-args.ts` (VERBS + parse), `apps/fleet/cli/fleet.ts` (command)
- Test: `apps/fleet/test/llm.models-route.test.ts`, `apps/fleet/test/studio.cli-args.test.ts`, `apps/fleet/test/studio.spawn-leadmodel.test.ts`

**Interfaces:**
- Consumes: Task 3 store, Task 1 registry.
- Produces:
  - `GET /studio/models` → `{ models: [{ key, id, state, smokePassed }], assignments: Record<studioId, modelId> }` (assignments for running studios only).
  - `POST /studio/models/assign` body `{ studio, model }` (model = key or id) → 200 / 400 unknown.
  - `POST /studio/models/promote|demote` body `{ model }` → sets `active` / `demoted`.
  - `readLeadTypeRequest(body)` now returns `{ leadType: "claude" | "glm"; model?: string } | undefined | null` — `"kimi"`/`"deepseek"` map to `{ leadType: "glm", model: <id> }`, `"glm"` → `{ leadType: "glm", model: glm id }`.

- [ ] **Step 1: Read how `/studio/accounts/sync` is authenticated and mounted** (`grep -n "accounts/sync" apps/fleet/src/index.ts apps/fleet/src/studio/routes.ts`). The new routes use the SAME operator auth guard, verbatim.

- [ ] **Step 2: Failing route test** `test/llm.models-route.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { handleModelsRoute } from "../src/llm/models-route";
import { POOL } from "../src/llm/models";

const post = (path: string, body: unknown) => new Request(`https://x${path}`, { method: "POST", body: JSON.stringify(body) });

describe("models route", () => {
  it("assign by key then list shows it", async () => {
    expect((await handleModelsRoute(post("/studio/models/assign", { studio: "r--web-studio--49", model: "kimi" }), env)).status).toBe(200);
    const list = await (await handleModelsRoute(new Request("https://x/studio/models"), env)).json() as any;
    expect(list.assignments["r--web-studio--49"]).toBe(POOL[1].id);
  });
  it("assign unknown model is 400", async () => {
    expect((await handleModelsRoute(post("/studio/models/assign", { studio: "r--a", model: "gpt4" }), env)).status).toBe(400);
  });
  it("demote then promote", async () => {
    await handleModelsRoute(post("/studio/models/demote", { model: "deepseek" }), env);
    let list = await (await handleModelsRoute(new Request("https://x/studio/models"), env)).json() as any;
    expect(list.models.find((m: any) => m.key === "deepseek").state).toBe("demoted");
    await handleModelsRoute(post("/studio/models/promote", { model: "deepseek" }), env);
    list = await (await handleModelsRoute(new Request("https://x/studio/models"), env)).json() as any;
    expect(list.models.find((m: any) => m.key === "deepseek").state).toBe("active");
  });
});
```

(`handleModelsRoute` is the inner handler AFTER auth; auth is applied at the mount point in `index.ts`, same as accounts.) Assignments list: read `lead-model:*` via existing `scanStateTaskKeys`-style prefix scan if one fits, else a `SELECT key, value FROM fleet_state WHERE key LIKE 'lead-model:%'`.

Run → FAIL.

- [ ] **Step 3: Implement `models-route.ts`**

```ts
// apps/fleet/src/llm/models-route.ts
import { POOL, modelByKey, modelById } from "./models";
import { getModelStates, setAssignedModel, setModelState } from "./model-store";
import type { Env } from "../env";

const resolve = (m: unknown) => (typeof m === "string" ? (modelByKey(m) ?? modelById(m)) : undefined);
const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export async function handleModelsRoute(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === "/studio/models") {
    const states = await getModelStates(env.DB);
    const rows = await env.DB.prepare("SELECT key, value FROM fleet_state WHERE key LIKE 'lead-model:%'").all<{ key: string; value: string }>();
    const assignments: Record<string, string> = {};
    for (const r of rows.results ?? []) assignments[r.key.slice("lead-model:".length)] = r.value;
    return j({ models: POOL.map((m) => ({ key: m.key, id: m.id, state: states[m.id], smokePassed: m.smokePassed })), assignments });
  }
  if (req.method !== "POST") return j({ error: "method" }, 405);
  let body: { studio?: unknown; model?: unknown };
  try { body = await req.json(); } catch { return j({ error: "bad json" }, 400); }
  const m = resolve(body.model);
  if (!m) return j({ error: `unknown model ${String(body.model)}` }, 400);
  if (path === "/studio/models/assign") {
    if (typeof body.studio !== "string" || body.studio.length === 0) return j({ error: "studio required" }, 400);
    await setAssignedModel(env.DB, body.studio, m.id);
    return j({ ok: true, studio: body.studio, model: m.id });
  }
  if (path === "/studio/models/promote") { await setModelState(env.DB, m.id, "active"); return j({ ok: true }); }
  if (path === "/studio/models/demote") { await setModelState(env.DB, m.id, "demoted"); return j({ ok: true }); }
  return j({ error: "not found" }, 404);
}
```

Adjust the `fleet_state` column names to the real schema (see Task 3 Step 1). Mount in `index.ts` under the same operator guard used by `/studio/accounts*`. Run test → PASS.

- [ ] **Step 4: Spawn flag.** Failing test `test/studio.spawn-leadmodel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readLeadTypeRequest } from "../src/studio/spawn";
import { POOL } from "../src/llm/models";

describe("readLeadTypeRequest pool keys", () => {
  it("kimi → glm-led with kimi model", () => { expect(readLeadTypeRequest({ leadType: "kimi" })).toEqual({ leadType: "glm", model: POOL[1].id }); });
  it("deepseek → glm-led with deepseek model", () => { expect(readLeadTypeRequest({ leadType: "deepseek" })).toEqual({ leadType: "glm", model: POOL[2].id }); });
  it("glm → glm-led with glm model", () => { expect(readLeadTypeRequest({ leadType: "glm" })).toEqual({ leadType: "glm", model: POOL[0].id }); });
  it("claude → claude, no model", () => { expect(readLeadTypeRequest({ leadType: "claude" })).toEqual({ leadType: "claude" }); });
  it("absent → undefined; gpt4 → null", () => {
    expect(readLeadTypeRequest({})).toBeUndefined();
    expect(readLeadTypeRequest({ leadType: "gpt4" })).toBeNull();
  });
});
```

Implement: `readLeadTypeRequest` returns the object shape above (use `modelByKey`). Update its two callers in `spawn.ts` to read `.leadType` where they used the string, and after the studio row is first written, if `.model` is set call `setAssignedModel(env.DB, childId, model)`. Update the 400 message to `expected "claude", "glm", "kimi" or "deepseek"`. Fix every existing test that asserted the old string return (search `readLeadTypeRequest(` in `test/`). Run spawn + glm-leadtype tests → PASS.

- [ ] **Step 5: CLI.** In `cli-args.ts` add verb `models` (args `"[assign <studio> <model> | promote <model> | demote <model>]"`, summary "Model pool for non-Claude leads: table of models, states and studio assignments; assign/promote/demote."). Parse: bare → `{ cmd: "models-ls" }`; `assign s m` → `{ cmd: "models-assign", studio, model }`; `promote|demote m` → `{ cmd: "models-set", state, model }`; anything else → `usage(...)`. Extend `CliCommand` union. Add parse tests to `test/studio.cli-args.test.ts`:

```ts
it("models parses", () => {
  expect(parseCliArgs(["models"])).toEqual({ cmd: "models-ls" });
  expect(parseCliArgs(["models", "assign", "r--web-studio--49", "kimi"])).toEqual({ cmd: "models-assign", studio: "r--web-studio--49", model: "kimi" });
  expect(parseCliArgs(["models", "demote", "deepseek"])).toEqual({ cmd: "models-set", state: "demote", model: "deepseek" });
  expect(parseCliArgs(["models", "bogus"]).cmd).toBe("usage");
});
```

In `cli/fleet.ts`, implement the three commands by calling the routes with the same request helper `accounts` uses; print `models-ls` as a table `KEY  ID  STATE  SMOKE` then `STUDIO  MODEL`. Spawn CLI: allow `--lead kimi|deepseek` wherever `--lead glm` is validated (grep `--lead` in `cli-args.ts`).

- [ ] **Step 6: Run all touched tests + typecheck**

Run: `cd apps/fleet && npx vitest run test/llm.models-route.test.ts test/studio.spawn-leadmodel.test.ts test/studio.cli-args.test.ts test/studio.glm-leadtype-persist-do.test.ts && bun run check`
Expected: PASS, exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/src/llm/models-route.ts apps/fleet/src/index.ts apps/fleet/src/studio/spawn.ts apps/fleet/src/studio/cli-args.ts apps/fleet/cli/fleet.ts apps/fleet/test/
git commit -m "feat(fleet): fleet models CLI + routes, spawn --lead kimi|deepseek (refs #N)"
```

---

### Task 6: Quality stats + daily auto-demotion

**Files:**
- Create: `apps/fleet/src/llm/model-quality.ts`
- Modify: `apps/fleet/src/index.ts` scheduled handler (daily, once per UTC day)
- Test: `apps/fleet/test/bun/llm-model-quality.test.ts`

**Interfaces:**
- Consumes: `setModelState` (Task 3); existing GitHub helpers in `src/github/api.ts` (`ghJson` or equivalent — read the file's exports first); existing board comment helper (grep `createIssueComment\|postComment` in `src/github/`).
- Produces:
  - `interface PrOutcome { model: string; closedAt: number; firstCiPassed: boolean; bounced: boolean; reverted: boolean }`
  - `interface ModelStats { model: string; prs: number; firstCiPassRate: number; bounces: number; reverts: number }`
  - `function modelStats(outcomes: PrOutcome[], window?: number): ModelStats[]` (window default 10, newest first per model)
  - `function shouldDemote(stats: ModelStats[]): string[]` — model ids to demote
  - `function statsTable(stats: ModelStats[]): string` — markdown table

- [ ] **Step 1: Failing test**

```ts
// apps/fleet/test/bun/llm-model-quality.test.ts
import { describe, it, expect } from "bun:test";
import { modelStats, shouldDemote, statsTable, type PrOutcome } from "../../src/llm/model-quality";

const pr = (model: string, i: number, over: Partial<PrOutcome> = {}): PrOutcome =>
  ({ model, closedAt: i, firstCiPassed: true, bounced: false, reverted: false, ...over });

describe("model quality", () => {
  it("uses the newest 10 PRs per model", () => {
    const o = [...Array.from({ length: 12 }, (_, i) => pr("a", i, { firstCiPassed: i >= 2 }))];
    expect(modelStats(o)[0]).toMatchObject({ model: "a", prs: 10, firstCiPassRate: 1 });
  });
  it("demotes a model 25+ points below best first-try rate", () => {
    const o = [...Array.from({ length: 10 }, (_, i) => pr("a", i)), ...Array.from({ length: 10 }, (_, i) => pr("b", i, { firstCiPassed: i < 7 }))];
    expect(shouldDemote(modelStats(o))).toEqual(["b"]); // 1.0 vs 0.7 = 30 points
  });
  it("does not demote at 24 points; does at 25", () => {
    const s = (b: number) => [
      { model: "a", prs: 10, firstCiPassRate: 1, bounces: 0, reverts: 0 },
      { model: "b", prs: 10, firstCiPassRate: b, bounces: 0, reverts: 0 },
    ];
    expect(shouldDemote(s(0.76))).toEqual([]);
    expect(shouldDemote(s(0.75))).toEqual(["b"]);
  });
  it("demotes on 2 reverts regardless of rate", () => {
    const o = Array.from({ length: 10 }, (_, i) => pr("c", i, { reverted: i < 2 }));
    expect(shouldDemote(modelStats(o))).toEqual(["c"]);
  });
  it("models with fewer than 5 PRs are never demoted", () => {
    const o = [...Array.from({ length: 10 }, (_, i) => pr("a", i)), ...Array.from({ length: 4 }, (_, i) => pr("b", i, { firstCiPassed: false }))];
    expect(shouldDemote(modelStats(o))).toEqual([]);
  });
  it("table has one row per model", () => {
    expect(statsTable(modelStats([pr("a", 1), pr("b", 1)])).split("\n").filter((l) => l.startsWith("| a") || l.startsWith("| b"))).toHaveLength(2);
  });
});
```

(The 5-PR minimum is a guard so a brand-new model is not demoted on 1-2 PRs; add it to the spec's Quality section in the same PR.)

Run: `cd apps/fleet && bun test test/bun/llm-model-quality.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// apps/fleet/src/llm/model-quality.ts
// Per-model PR quality + auto-demote rule (spec 2026-10-13-model-pool-design, Quality).
export interface PrOutcome { model: string; closedAt: number; firstCiPassed: boolean; bounced: boolean; reverted: boolean }
export interface ModelStats { model: string; prs: number; firstCiPassRate: number; bounces: number; reverts: number }

const MIN_PRS = 5;
const GAP = 0.25;
const MAX_REVERTS = 2;

export function modelStats(outcomes: PrOutcome[], window = 10): ModelStats[] {
  const by = new Map<string, PrOutcome[]>();
  for (const o of outcomes) by.set(o.model, [...(by.get(o.model) ?? []), o]);
  return [...by.entries()].map(([model, list]) => {
    const w = [...list].sort((a, b) => b.closedAt - a.closedAt).slice(0, window);
    return {
      model, prs: w.length,
      firstCiPassRate: w.length ? w.filter((o) => o.firstCiPassed).length / w.length : 0,
      bounces: w.filter((o) => o.bounced).length,
      reverts: w.filter((o) => o.reverted).length,
    };
  });
}

export function shouldDemote(stats: ModelStats[]): string[] {
  const eligible = stats.filter((s) => s.prs >= MIN_PRS);
  const best = Math.max(0, ...eligible.map((s) => s.firstCiPassRate));
  return eligible
    .filter((s) => s.reverts >= MAX_REVERTS || best - s.firstCiPassRate >= GAP)
    .map((s) => s.model);
}

export function statsTable(stats: ModelStats[]): string {
  const head = "| model | prs | first-try CI | bounces | reverts |\n|---|---|---|---|---|";
  return [head, ...stats.map((s) => `| ${s.model} | ${s.prs} | ${Math.round(s.firstCiPassRate * 100)}% | ${s.bounces} | ${s.reverts} |`)].join("\n");
}
```

Run → PASS.

- [ ] **Step 3: Collect outcomes (I/O shell).** Add `async function collectOutcomes(env: Env): Promise<PrOutcome[]>` in `model-quality.ts` (keep the pure functions above untouched):
  - list closed PRs from the last 14 days in the fleet's own repo via the existing GitHub helper;
  - per PR: studio = the `studio:` label on the issue it `refs` (board task), model = `getAssignedModel(env.DB, studio)` (skip PRs with no assigned model);
  - `firstCiPassed` = conclusion of the FIRST completed check suite on the PR's first head commit is `success`;
  - `bounced` = PR had > 1 head commit after review request, or a CONFLICTING state was recorded — use: more than one distinct head SHA had a failed check;
  - `reverted` = a later merged PR title starts with `Revert "` and references this PR's number.
  Read `src/github/api.ts` exports first and use them; no raw `fetch` to GitHub.

- [ ] **Step 4: Daily cron.** In `index.ts` `scheduled`, once per UTC day (guard with flag `model-quality:last-day` = `YYYY-MM-DD`, using `getFlag`/`setFlag`), only when `env.LEAD_MODEL_POOL === "on"`: `const s = modelStats(await collectOutcomes(env)); for (const id of shouldDemote(s)) await setModelState(env.DB, id, "demoted");` then post `statsTable(s)` (+ a line naming demoted models) as a comment on the pinned board issue whose number is in env `MODEL_QUALITY_ISSUE` (skip posting if unset). Wrap in try/catch → `recordWorkerException(env.DB, "model-quality", err, Date.now(), ctx)`, matching the existing scheduled error handling at `index.ts:85-90`.

- [ ] **Step 5: Test the cron guard** in `test/llm.model-quality-cron.test.ts` with a stubbed `collectOutcomes` injection (export `runDailyModelQuality(env, deps)` taking `{ collect, post }` so the test passes fakes): asserts (a) runs once per day, (b) demotes the right model, (c) skipped when pool off, (d) posts the table when `MODEL_QUALITY_ISSUE` set.

```ts
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { runDailyModelQuality } from "../src/llm/model-quality";
import { getModelStates } from "../src/llm/model-store";
import { POOL } from "../src/llm/models";

const outcomes = [
  ...Array.from({ length: 10 }, (_, i) => ({ model: POOL[0].id, closedAt: i, firstCiPassed: true, bounced: false, reverted: false })),
  ...Array.from({ length: 10 }, (_, i) => ({ model: POOL[2].id, closedAt: i, firstCiPassed: i < 5, bounced: false, reverted: false })),
];
describe("daily model quality", () => {
  it("demotes once per day, posts table", async () => {
    const post = vi.fn(async () => {});
    const e = { ...env, LEAD_MODEL_POOL: "on", MODEL_QUALITY_ISSUE: "1" };
    await runDailyModelQuality(e as any, { collect: async () => outcomes, post, now: Date.UTC(2026, 9, 14, 6) });
    await runDailyModelQuality(e as any, { collect: async () => outcomes, post, now: Date.UTC(2026, 9, 14, 7) });
    expect(post).toHaveBeenCalledTimes(1);
    expect((await getModelStates(env.DB))[POOL[2].id]).toBe("demoted");
  });
  it("pool off: no-op", async () => {
    const post = vi.fn(async () => {});
    await runDailyModelQuality({ ...env, LEAD_MODEL_POOL: "off" } as any, { collect: async () => outcomes, post, now: Date.UTC(2026, 9, 15, 6) });
    expect(post).not.toHaveBeenCalled();
  });
});
```

Run all quality tests → PASS. `bun run check` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/llm/model-quality.ts apps/fleet/src/index.ts apps/fleet/test/bun/llm-model-quality.test.ts apps/fleet/test/llm.model-quality-cron.test.ts docs/superpowers/specs/2026-10-13-model-pool-design.md
git commit -m "feat(llm): per-model quality stats + daily auto-demote (refs #N)"
```

---

### Task 7: Live smoke script + docs

**Files:**
- Create: `apps/fleet/scripts/model-smoke.ts`
- Modify: `docs/setup.md`, `docs/operations.md`

**Interfaces:**
- Consumes: `POOL` (Task 1), `anthropicRequestToOpenAI` (Task 4), existing stream translator `openAIStreamToAnthropic` or `pumpAnthropicStream` equivalent in `translate.ts` (read its export name).
- Produces: CLI `bun scripts/model-smoke.ts <modelKey>` → exit 0 + `SMOKE PASS <id>` or exit 1 + reason.

- [ ] **Step 1: Write the script.** Calls the Workers AI REST API through the gateway: `POST https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${GATEWAY_ID}/workers-ai/${modelId}` with `Authorization: Bearer ${CLOUDFLARE_API_TOKEN}` (env vars; never printed). Three checks, each must pass:
  1. **Tool call:** Anthropic request with one tool `get_weather(city)` and prompt "Call get_weather for Paris." → translated response contains a `tool_use` block named `get_weather` with input `{ city: "Paris" }` (case-insensitive).
  2. **Multi-turn:** feed back a `tool_result` "18C sunny" → final text mentions `18`.
  3. **Stream:** same as 1 with `stream: true` → at least one `content_block_start` and a `message_stop` after translating the SSE.

```ts
// apps/fleet/scripts/model-smoke.ts — live smoke for one pool model (spec 2026-10-13, Pool entry rule).
import { modelByKey } from "../src/llm/models";
import { anthropicRequestToOpenAI, openAIResponseToAnthropic } from "../src/llm/translate";

const key = process.argv[2];
const m = key ? modelByKey(key) : undefined;
if (!m) { console.error("usage: bun scripts/model-smoke.ts glm|kimi|deepseek"); process.exit(2); }
const acct = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN, gw = process.env.GATEWAY_ID ?? "default";
if (!acct || !token) { console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required"); process.exit(2); }
const url = `https://gateway.ai.cloudflare.com/v1/${acct}/${gw}/workers-ai/${m.id}`;
const tools = [{ name: "get_weather", description: "weather for a city", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];

async function call(body: unknown): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(anthropicRequestToOpenAI(body, m!)) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const first = { messages: [{ role: "user", content: "Call get_weather for Paris." }], tools, max_tokens: 1024 };
const r1 = openAIResponseToAnthropic(await (await call(first)).json().then((j: any) => j.result ?? j), { model: m.id });
const tu = r1.content.find((b: any) => b.type === "tool_use");
if (!tu || tu.name !== "get_weather" || String(tu.input?.city).toLowerCase() !== "paris") { console.error("SMOKE FAIL tool_call", JSON.stringify(r1.content).slice(0, 300)); process.exit(1); }
const second = { ...first, messages: [...first.messages, { role: "assistant", content: r1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "18C sunny" }] }] };
const r2 = openAIResponseToAnthropic(await (await call(second)).json().then((j: any) => j.result ?? j), { model: m.id });
if (!JSON.stringify(r2.content).includes("18")) { console.error("SMOKE FAIL multi_turn"); process.exit(1); }
const s = await call({ ...first, stream: true });
const text = await s.text();
if (!/data:/.test(text) || !/\[DONE\]|finish_reason/.test(text)) { console.error("SMOKE FAIL stream"); process.exit(1); }
console.log(`SMOKE PASS ${m.id}`);
```

(The stream check here validates the upstream SSE shape; the translator's stream path is already unit-tested. If the gateway's REST response envelope differs, adapt the `.result ?? j` unwrap after one manual curl, not the checks.)

- [ ] **Step 2: Run against GLM** (maestro, with creds): `cd apps/fleet && bun scripts/model-smoke.ts glm` → `SMOKE PASS @cf/zai-org/glm-5.3`. Then `kimi`, `deepseek`. For each PASS, flip `smokePassed: true` in `models.ts` in this task's commit; leave FAIL models `false` and note the failure in the PR body.

- [ ] **Step 3: Docs.** `docs/setup.md` env table: `LEAD_MODEL_POOL` (`on` enables pool; default off), `LEAD_AI_GATEWAY_ID` (default `default`), `MODEL_QUALITY_ISSUE` (board issue for daily table). `docs/operations.md`: section "Model pool" — `fleet models`, `assign`, `promote`/`demote`, `spawn --lead kimi|deepseek`, smoke script usage, demotion rule.

- [ ] **Step 4: english-check + commit**

Run: `cd apps/fleet && bun run scripts/english-check.ts`
Expected: clean.

```bash
git add apps/fleet/scripts/model-smoke.ts apps/fleet/src/llm/models.ts docs/setup.md docs/operations.md
git commit -m "feat(llm): live model smoke script + model pool docs (refs #N)"
```

---

## Rollout (maestro, after merge)

1. Worker deploy (needs wrangler auth fixed): `deploy-gated.sh`. No image change.
2. Verify gateway traffic: AI Gateway `default` dashboard shows requests within 5 min (pool still off → GLM only).
3. Set `LEAD_MODEL_POOL=on` (`wrangler secret put` or ops var), `MODEL_QUALITY_ISSUE=<pinned issue>`.
4. `fleet models assign` studios 49-51 → kimi, 52-54 → deepseek (only smoke-passed models).
5. Watch 24h: 3021 count in usage log (target 0), `fleet models` table.
