# Repoint pool keys kimi + deepseek off retired Workers AI ids (#1476)

Date: 2026-11-26. Scope: bounded fix, catalog-only.

## Root cause (confirmed)

CF retired `@cf/moonshotai/kimi-k2.7-code` and `@cf/deepseek-ai/deepseek-v4-pro-0813`
2026-11-20. Operator ran `fleet models demote kimi`/`demote deepseek` same day —
state flag only, model stays IN the pool.

`router.ts:pickModels` filters `eligible` by `smokePassed` only, never by
`state`. Design intent (`docs/superpowers/specs/2026-10-13-model-pool-design.md`
Components §3): "demoted only as overflow tail" — demoted models are MEANT to
stay walkable, just last. So when glm (the only `active` model) errors, the
walk still reaches demoted kimi/deepseek → retired id → `500 5028` reaches the
lead, turn dies. Not a router bug — the catalog itself still lists dead ids.
Matches #1476's 11-25 19:18Z comment: glm-pinned studios still hit the
kimi 5028.

Fix is catalog-only, per boundary: re-point the ids in `models.ts`, no
router/state-machine change.

## Pins checked

- `lead-model:<studioId>` (model-store.ts `getAssignedModel`) already guards
  against a stale id: `modelById(v)` must resolve, else returns `null` → pool
  round-robin default. A studio pinned to a since-removed pool id self-heals
  next call, no migration needed.
- `model-state:<modelId>` flags (demoted/overflow) key off the OLD retired ids
  today. Once the ids change, those flags are simply orphaned keys (never read
  again — `getModelStates` only reads flags for ids currently in `POOL`). No
  cleanup needed, new ids default `active` (`getModelStates` fallback).

## Decision — replacement ids

- `deepseek` → `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (only live candidate
  named in the task; no live alternative to weigh).
- `kimi` → `@cf/qwen/qwen3.8-27b`. No live Kimi id exists on CF (confirmed —
  only candidates are qwen3.8-27b / gpt-oss-120b). In-repo measured data
  (`docs/superpowers/specs/2026-09-28-junior-workers-ai-design.md` junior-eval
  table, different workload but only cross-model comparison in this repo):
  qwen3.8-27b scored 1.80 vs gpt-oss-120b 1.60, fewer failures (0 vs 1) at
  comparable cost. Ships with `thinkTags: false` (qwen3.8-27b is not a
  `<think>`-tag reasoning model per CF docs, unlike kimi-k2.7-code) — flagged
  for maestro to confirm on live smoke output.
- Both ship `smokePassed: false`. **No Cloudflare credential exists in this
  studio container** (confirmed: `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`
  both unset) — `scripts/model-smoke.ts`'s own header says maestro-only, never
  a studio. NEEDS MAESTRO before merge: run
  `bun scripts/model-smoke.ts kimi` and `deepseek` with real creds, paste
  output in the PR, flip `smokePassed: true` on pass.

## Smoke catches future retirement

`scripts/model-smoke.ts` currently has no deprecation awareness — a model
already dead on CF's catalog still gets `smokePassed: true` forever once set.
Add a pure, unit-testable check:

- `src/llm/deprecation.ts`: `checkDeprecation(entry, now, warnDays=14)` →
  `"ok" | "warn" | "retired"` from a catalog entry's `planned_deprecation_date`.
  `null`/absent date → `"ok"`. Date in the past → `"retired"`. Date within
  `warnDays` → `"warn"`. Else `"ok"`.
- `model-smoke.ts`: before the live inference calls, fetch
  `wrangler ai models --json` (maestro's own creds), find the target model's
  entry, run `checkDeprecation`. `"retired"` → fail fast (exit 1), never
  spend an inference call on a dead id. `"warn"` → print, continue.
- Unit tests cover `checkDeprecation` only (pure function, fixture dates) —
  the live `wrangler` call itself is untestable from a studio, same
  constraint as the inference smoke call already had.

## Docs

`docs/operations.md` "Model pool" section: add one line — smoke now also
checks `planned_deprecation_date` and refuses a retired id before spending
an inference call.

## Out of scope (per #1476 ACCEPT list — not required)

- Pinned-studio migration table: `fleet models` STUDIO list needs live Worker
  access this studio does not have. `getAssignedModel`'s stale-id guard
  (above) makes migration a no-op anyway.
- `fleet models` showing no retired id active, and `spawn --lead deepseek`
  end-to-end: both are post-deploy, live-fleet checks. Maestro verifies after
  merge + deploy (studios never deploy).

## Verification

- `bun run test` filtered to `apps/fleet/test/llm.*` + new deprecation test —
  targeted, not full suite.
- `bun run check` (types) on changed files.
- Live smoke: maestro, pre-merge, output pasted into PR.
