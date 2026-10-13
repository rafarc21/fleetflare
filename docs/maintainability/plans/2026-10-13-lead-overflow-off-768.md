# Plan — LEAD_MODEL_OVERFLOW=off, one assigned model per studio (#768)

Refs https://github.com/rafarc21/fleetflare/issues/768. GLM 20 rpm/account/model saturated; pool overflow to Kimi mid-conversation ended GLM turns badly (Kimi ~90k context, text-only, no tool call). Each studio stays on its ONE assigned model — no cross-model overflow.

## Changes
1. `src/env.ts`: `LEAD_MODEL_OVERFLOW?: string` — `"off"` disables overflow, default on (today's behavior).
2. `src/llm/router.ts` `pickModels`: new param `overflowOn: boolean`. When `poolOn && !overflowOn`, return `[main]` only — main = assigned model if known + eligible + active, else `defaultModelFor` (demoted state still respected inside defaultModelFor).
3. `src/llm/anthropic-route.ts`: pass `overflowOn: env.LEAD_MODEL_OVERFLOW !== "off"` into pickModels.
4. No D1, no migration, no wrangler change. Pool-off path untouched.

## Tests (TDD)
- `test/bun/llm-router.test.ts` (bun): overflow off + assigned kimi → `["kimi"]`; overflow off + no assignment → `[defaultModelFor]`; overflow off + unknown assigned id → `[defaultModelFor]`; overflow on unchanged.
- `test/llm.anthropic-route.test.ts` (vitest): overflow off + assigned kimi in D1 (`setAssignedModel`) → ai.run called with kimi only; overflow off + 3021 on kimi → 429, ai.run called once (no GLM call); overflow on (unset) unchanged.
- Verification commands (one at a time, heavy-gate budget): `bun test test/bun/llm-router.test.ts`, `bunx vitest run test/llm.anthropic-route.test.ts`, `bun run check`, `bun run english-check`, `bun run test-lies-check`.

## Boundaries
- Targeted tests only, never full suite + build together.
- PR refs #768, no closing keywords.
