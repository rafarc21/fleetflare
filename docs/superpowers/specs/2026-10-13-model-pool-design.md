# Model pool for non-Claude studio leads — design

Date: 2026-10-13. Status: approved in brainstorm (operator), pending spec review.

## Problem

- GLM-lead studios hit Workers AI 429 / code 3021 ("Account rate limit exceeded") many times per hour. Each kills a turn; maestro resends by hand.
- Cause: paid text-generation models are limited **per account, per model**: 20 req/min on standard billing, 50 req/min with prepaid AI Gateway credits + unified billing. Ten studios share one model's budget.
- Every call goes to `@cf/zai-org/glm-5.3` (`GLM_LEAD_MODEL`, `src/llm/translate.ts:28`). The requested model name is read (`anthropic-route.ts:499`) but ignored.
- `env.AI.run(model, body)` (`anthropic-route.ts:515`) passes no `gateway` option. Calls bypass the account's `default` AI Gateway, so unified billing (50 rpm) never applies and the gateway shows no traffic.

## Goals

1. Zero 3021 turn deaths at 10 studios; headroom for 20-30.
2. Quality held: first-try CI pass rate, gate bounce rate and post-merge revert rate per model visible and enforced.
3. All calls through AI Gateway `default` (billing, logs).

## Non-goals

- Gate runner redesign (separate spec, issue #715).
- Kimi K3 (not in the Workers AI catalog on 2026-10-13; add when listed).
- Raising studio count above 10 until 24h at zero 3021.

## Pool

| model | id | tool calling | context |
|---|---|---|---|
| GLM 5.3 | `@cf/zai-org/glm-5.3` | yes (docs) | 1M |
| Kimi K2.7 Code | `@cf/moonshotai/kimi-k2.7-code` | yes (docs) | 262k |
| DeepSeek v4 Pro | `@cf/deepseek-ai/deepseek-v4-pro-0813` | unverified — smoke test decides | 1M |

Entry rule: model joins only after `scripts/model-smoke.ts` passes against live Workers AI via the gateway: one tool call, multi-turn, streamed reply, through the Anthropic↔OpenAI translator.

Exact model ids are read from the catalog when the plan is written; ids above are as listed in the catalog page on 2026-10-13.

## Components

1. **`src/llm/models.ts`** — pool registry. Per model: id, smoke-passed flag, state (`active` | `overflow` | `demoted`), per-model translator quirks (tool-call shape, min `max_tokens`).
2. **Studio main model** — `fleet spawn --lead glm|kimi|deepseek` persists `leadModel` on the studio record, same stickiness as `--lead glm` (#249). Absent → pool assigns round-robin over `active` models.
3. **`src/llm/router.ts`** — pure `pickModels({studio, requestedModel, pool}) → string[]`:
   - first: studio's main model (if `active`);
   - role: requested name matching the small/fast pattern (e.g. `haiku`) → next `active` model first instead;
   - then remaining `active` models, then `overflow` models; `demoted` only as overflow tail.
4. **Call loop** in `anthropic-route.ts` — walk the list; each try `env.AI.run(model, body, { gateway: { id: "default" } })`.
   - 429 / 3021 → next model immediately.
   - transient 5xx / capacity → existing #335 retry on same model, then next model.
   - once the stream started → no switch; error ends the turn (Claude Code retries).
   - all exhausted → 429 + `retry-after` (shortest known reset).
5. **Usage log** — record model actually used + `overflow: boolean` per call (existing usage rows gain two fields).

Unchanged: per-studio `LEAD_RATE_PER_MINUTE`, `LEAD_DAILY_CAP` override, auth, junior route.

## Quality

Per main model, over its last 10 closed PRs (PR → studio → `leadModel`):
- first-try CI pass rate;
- gate bounces (conflict, CI fail, leak, closing keyword);
- post-merge reverts;
- overflow share of its calls.

**Auto-demote** when, over that window: first-try CI pass rate ≥ 25 points below the best model's, OR ≥ 2 reverts. Demoted model: no new studios; its studios switch main model at next task assignment; stays as overflow. Board issue + push notification on demotion.

**Report:** `fleet models` prints the table; a daily comment on a pinned board issue posts it. Override: `fleet models promote|demote <model>`.

Data sources: GitHub checks + PR history, board task history, usage log. No new store.

## Rollout

- Worker-only change behind `LEAD_MODEL_POOL=on|off` (default off). No image change.
- Depends on a working Worker deploy (wrangler auth).
- After on: studios 45-48 GLM, 49-51 Kimi, 52-54 DeepSeek (only models that passed smoke).
- Watch 24h: 3021 count (target 0) and quality table.

## Testing

- Unit: router ordering (main, role, overflow, demoted skipped); per-model translator fixtures; gateway option present on every `env.AI.run`; 3021 → next model; mid-stream error → no switch; all-exhausted → 429 + retry-after.
- Live: `scripts/model-smoke.ts` per model (manual, maestro-run).

## Build

Claude-tier studio. Every non-Claude studio depends on this route; a regression stops the whole GLM fleet. Not GLM work.
