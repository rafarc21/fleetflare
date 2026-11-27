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

## Round 2 update (same PR, new measured facts from the maestro)

Live probe confirmed round 1's picks (deepseek-v4.1-flash-1017,
qwen3.8-27b both pass tool call + multi-turn + stream against the real
translator; gpt-oss-120b fails with HTTP 400 "content must be a string",
old schema — excluded for cause). Six fixes landed on top of round 1:

1. **Wrong wrangler subcommand.** `wrangler ai models --json` is not a real
   command (wrangler 4.141) — it's `wrangler ai models list --json`.
   Fixed in `scripts/model-smoke.ts`.

2. **Catalog semantics were wrong.** A retired id does not carry a past
   `planned_deprecation_date` — it is simply ABSENT from the catalog
   entirely (0 of 52 live models currently carry that field at all).
   Reworked `checkDeprecation` (`src/llm/deprecation.ts`) to take the FULL
   catalog list + a target id: absent from the list → `"retired"`; present
   with a past date → `"retired"`; present within `warnDays` → `"warn"`;
   present with no date or a far-future date → `"ok"`. `warnDays`
   `planned_deprecation_date` stays as a secondary, forward-looking check —
   it may never fire against today's real data, but CF could set the field
   before dropping a model next time. TDD: `llm-deprecation.test.ts`
   rewritten red-first for the new signature, then `checkDeprecation` and
   `model-smoke.ts`'s pre-flight call both reworked to match.

3. **Stale pin remap.** A studio's `lead-model:<studioId>` D1 flag can hold
   an old retired id (e.g. `fleet spawn --lead deepseek` before this
   repoint). `getAssignedModel` used to return `null` for any id that
   doesn't resolve, which falls through to `router.ts`'s hash default —
   scattering a deepseek-pinned studio onto glm/kimi/deepseek instead of
   keeping it on the deepseek key. Added `RETIRED_TO_KEY` + `resolveStaleId`
   in `src/llm/models.ts`: a known-retired id resolves back to its pool
   key's CURRENT id; a genuine typo/never-pool-member id still returns
   `null`. Wired into `model-store.ts`'s `getAssignedModel`. TDD:
   `test/llm.model-store.test.ts` got a new red-first case seeding the raw
   old kimi/deepseek ids and asserting resolution to the current ids,
   alongside the existing typo case (which must keep returning `null`).

4. **`GET /studio/models` showed the raw stored id, not what actually
   runs.** Changed `assignments` from `Record<studio, string>` to
   `Record<studio, { stored: string; resolved: string | null }>`
   (`src/llm/models-route.ts`, using the same pure `resolveStaleId`, no
   extra DB round trip). Updated the two real consumers: `cli/models.ts`'s
   `fleet models` listing (flags a stale pin inline as `<resolved> (was
   <stored>)`), and `cli/fleet.ts`'s `fetchLeadAssignments` (the `fleet ls`
   ACCOUNT column / `--json` output now reflect the resolved id so
   `leadModelOf`'s contract — a `Record<studio, string>` of ids — still
   holds). TDD: `test/llm.models-route.test.ts` red-first for the new
   shape plus a new stale-pinned-studio case.

5. **Dead deepseek id also named in the junior route.** `JUNIOR_MODELS`
   (`src/junior/gate.ts`), `DEEPSEEK` (`skills/junior/src/client.ts`), and
   `eval.ts`'s `--models` default all still pointed at the retired
   `deepseek-v4-pro-0813` — swapped to `deepseek-v4.1-flash-1017`, the same
   id the lead pool's `deepseek` key now uses. `gate.ts`'s doc comment
   keeps its 2026-09-28 replay eval score (measured against the OLD id)
   but gets an explicit caveat that the score does not carry over to the
   new id — a re-eval is out of scope for #1476. Fixed the one test this
   broke: `junior-cli.test.ts`'s `--model deepseek` assertion now expects
   `model=deepseek-v4.1-flash-1017`.

6. Cosmetic: `cli/lead-model.ts`'s doc-comment examples swapped the dead
   `kimi-k2.7-code` id for a live one (`glm-5.3`).

Not touched (per the round-1 boundary, still holds): `router.ts`,
`LEAD_MODEL_OVERFLOW`/`LEAD_MODEL_POOL` behavior.

Verification this round: `bun test` on every touched `test/bun/*.test.ts`
file by name, `vitest run` on every touched `test/*.test.ts` file by name
(never the full suite), one solo `flock /tmp/fleet-gate.lock bun run
check` at the end (passed, no output).
