# Junior — Workers AI delegation for Claude Code

Date: 2026-09-28. Status: approved design, pre-plan.

## Goal

Claude Code (senior) delegates mechanical, low-risk edits to Workers AI model (junior). Senior reviews + applies. Senior holds final responsibility. Spends operator's Cloudflare credits, not Claude tokens.

Opt-in. Off by default, local and cloud. Not every user wants it.

Control rests with maestro role (operator decision, 2026-09-28). In fleet, studio may call junior only while working task maestro authorized. Maestro never calls junior itself: it writes no code, junior diff is code.

## Non-goals

- Junior as agent with tools. Junior never writes files, never runs commands.
- Routing Claude Code itself to non-Claude models (proxy, claude-code-router). Rejected: all senior traffic through proxy, unsupported by Anthropic.
- Cloudflare credential inside studio container. House rule `blueprint.ts:510-518` stays true.
- Studio self-authorizing junior. Only maestro sets `junior` label.
- Relabeling already-filed task (`fleet task junior <n>`). v1: maestro files task with `--junior` at creation. Add later if needed.

## Evidence (2026-09-27/28)

Replay eval: 10 real single-file fleetflare commits. Each model gets pre-image + commit message, returns SEARCH/REPLACE blocks. Blind Claude judges score 0-3 vs reference intent. API timeouts count 0.

| model | mean | full | harmful | fail | p50 / p90 s | $/task |
|---|---|---|---|---|---|---|
| glm-5.3 (64k budget) | 3.00 | 10 | 0 | 0 | 60 / 188 | 0.048 |
| deepseek-v4-pro-0813 | 2.90 | 9 | 0 | 0 | 72 / 133 | 0.024 |
| deepseek-v4-flash-0731 | 2.80 | 8 | 1 | 0 | 36 / 148 | 0.010 |
| glm-5.3 medium effort | 2.70 | 9 | 0 | 1 | 53 / 235 | 0.032 |
| glm-5.3-flash | 2.40 | 8 | 0 | 2 | 92 / 235 | 0.003 |
| kimi-k2.6 | 2.40 | 6 | 2 | 0 | 36 / 127 | 0.022 |
| kimi-k2.7-code | 2.00 | 5 | 2 | 2 | 25 / 80 | 0.016 |
| qwen3.8-27b | 1.80 | 6 | 0 | 4 | 70 / 121 | 0.008 |
| gpt-oss-120b | 1.60 | 4 | 1 | 3 | 12 / 30 | 0.003 |
| nemotron-3-120b-a12b | 1.20 | 2 | 0 | 5 | 50 / 115 | 0.014 |

Independent boards agree: GLM-5.3 leads Artificial Analysis Intel (44.8), TB4.0 (41.9), DeepSWE (69) among Workers AI models. Vendor TB2.1 claims (GLM 88.2, DeepSeek-Pro 87.9) inflated vs independent runs. SWE-bench Verified ignored (contaminated).

Measured gotchas:
- GLM-5.3 at 16k `max_tokens`: 3/10 `finish: length`, zero output. Reasoning ate budget. 64k fixes.
- `reasoning_effort: medium` barely cuts GLM-5.3 tokens (14k on hard tasks). Not worth quality loss.
- Error 3046 (request timeout) seen on glm-5.3, glm-5.3-flash, qwen3.8-27b. Hard 970-line file worst.
- Wrangler OAuth token expires ~1h. Long runs got 10000 auth errors mid-run.
- Flash models not faster in practice. Dropped.

Caveats: n=10, single run each, judge = Claude, commit messages detailed (senior-grade brief). Directional, not definitive.

## Architecture

### 1. Skill: `skills/junior/`

- `SKILL.md`: when to delegate, when never, review contract.
  - Delegate: boilerplate, test scaffolds, renames, mechanical refactors, docstrings, log summarizing, commit-msg drafts.
  - Never: auth, secrets, migrations, deploys, fleet state, destructive or irreversible ops, anything senior cannot fully review.
  - Junior output = untrusted input. Senior reads full diff, `git apply --check`, applies, runs tests. Senior owns result.
  - Calls take ~60s p50, up to ~3min. Dispatch in background, parallel, keep working.
- `junior.sh`: wrapper. Only entry point.

### 2. Wrapper contract

```
junior.sh --task "<instruction>" [--mode edit|text] [--model glm|deepseek] [--timeout 300] file...
```

- `--mode edit` (default): prompt forces SEARCH/REPLACE blocks, each headed by file path. Wrapper validates every block: SEARCH matches exactly once in named file. Converts to unified diff on stdout. Saves copy `.junior/<ts>.patch`. Never writes source files.
- `--mode text`: plain text out. No validation. For summaries, triage, drafts.
- Default model `@cf/zai-org/glm-5.3`, `max_tokens` 64000, default reasoning. Fallback `@cf/deepseek-ai/deepseek-v4-pro-0813`.
- Input cap ~200k tokens (byte estimate). Over cap: refuse, tell senior to split.
- stderr telemetry, one line per call: `junior: model=glm-5.3 secs=61 in=4.1k out=7.4k $0.048 status=ok`.

Auth order:
1. `FLEET_WORKER_URL` + `FLEET_SPAWN_TOKEN` set (inside studio) → `POST $FLEET_WORKER_URL/fleet/junior`.
2. `CLOUDFLARE_API_TOKEN` set → direct OpenAI-compat `/ai/v1/chat/completions`.
3. Else fresh `wrangler auth token` per call (fixes 1h expiry).

Account id: `CLOUDFLARE_ACCOUNT_ID`, else local junior config (see 5).

### 3. Error handling

| condition | action |
|---|---|
| 3046 timeout / 3040 capacity | retry once, then fallback model |
| 429 | backoff 10s, 20s, then fail |
| `finish: length` | retry once, 2x budget, cap 128k |
| empty content | failure → fallback model |
| SEARCH mismatch | one repair turn with exact error, then fail + raw output |
| input over cap | refuse before call |
| wall clock over `--timeout` | kill, fail |

Distinct exit codes per class. Senior decides: retry, split, or do it itself.

### 4. Cloud: Worker proxy `POST /fleet/junior`

- Mount beside `/fleet/tasks` in `src/index.ts`, before `/fleet/` catch-all.
- Auth: same as `handleFleetBoard` (`src/board/routes.ts:738-740`): `isSpawnTokenShaped` + `resolveSpawnParent` → studio row.
- Gate: 404 unless `FLEET_JUNIOR === "on"` AND (`JUNIOR_REPOS` unset OR studio `repoSlug` in list).
- Then task gate (section 5): 403 unless live assigned task carries `junior`.
- Calls `env.AI.run(model, {messages, max_tokens})` via new AI binding (`"ai": {"binding": "AI"}` in wrangler config). Streams response back.
- Guards: model allowlist (glm-5.3, deepseek-v4-pro-0813), body cap 2 MB.
- Container gets zero new credentials. Existing spawn token only.

### 5. Authorization — maestro, per task

- Label `junior` on board task = junior authorized for that task. Constant `JUNIOR_LABEL` in `src/board/types.ts`.
- Only way to set it: `fleet task new ... --junior` (boolean flag). Flows CLI brief → `parseBrief` (`TaskBrief.junior?: boolean`) → `createTask` appends label in same single create call. Studio tokens never reach create path.
- `fleet task ls` marks `[junior]` before title; `fleet task show` header prints `junior: yes`. Maestro sees what it authorized.
- `/fleet/junior` check, after spawn-token + flag gate: studio has ≥1 task assigned (`studio:<id>` label), open, state in `LIVE_TASK_STATES`, carrying `junior`. Else 403 `junior not authorized for your current task`. Board read fails → 503, fail closed.
- Maestro studio never gets junior skill (provision excludes `name === "maestro"`).
- Maestro rulebook (`fleet/blueprint/studios/maestro/studio.md`) gains "Junior — your call, per task" section: what it is, when to flag, when never, cost reality, never call it yourself.
- Local maestro (operator's own Claude session) same rulebook: `~/.claude/CLAUDE.md` gets matching lines at rollout.
- Local non-fleet use (`fleet junior enable` on Mac) not board-gated: operator runs it there, direct token path.

### 6. Opt-in config

Cloud (Worker vars, pattern of `FLEET_DIRECTUS` + `INSTALL_CACHE_REPOS`):
- `FLEET_JUNIOR` — `"on"` enables. Unset = off.
- `JUNIOR_REPOS` — optional comma list `owner/repo`. Narrows to those repos.
- Documented in `README.md` flag table + `wrangler.example.jsonc` (commented out).
- When on for studio's repo (maestro excluded): `junior` added to `STUDIO_SKILLS`, house-rule block appended: skill exists, usable only on task maestro labeled `junior`, senior owns every diff. When off: neither.

Local (`fleet` CLI, `cli/fleet.ts`):
- `fleet junior enable [--account <id>]` → symlink `~/.claude/skills/junior` → checkout `skills/junior`; write account id to `~/.config/fleet/junior.json`.
- `fleet junior disable` → remove symlink. Config kept.
- `fleet junior status` → enabled?, account, auth path that would be used.
- Nothing installed without `enable`.

### 7. Eval kept: `scripts/junior-eval/`

- Replay harness from spike: pick small single-file commits, run models, build blind packets, aggregate judge verdicts.
- Manual, opt-in, not CI. Rerun when Cloudflare adds models → decide default switch.
- Judging step = senior dispatches blind judge subagents on packets. Script prints instructions.

## Testing

1. Wrapper — bun tests, local stub HTTP server: every error-table row; block validation 0/1/2+ matches; blocks→diff verified by `git apply --check` on temp repo; auth order; `--mode text` skips validation; input cap.
2. Worker `/fleet/junior` — vitest, mocked `env.AI` + fake BoardApi: 404 flag off; 404 repo not listed; 401 bad token; 403 no junior task; 403 junior task completed; 403 junior task assigned elsewhere; 503 board read fails; 200 live junior task; model allowlist; 2 MB cap; streaming passthrough.
3a. Task label — cli-args `--junior`; parseBrief accepts boolean only; createTask labels `[submitted, studio:x, junior]` in one call; task ls/show render marker. Maestro rulebook pinned by test (mentions `--junior`, never-call-yourself).
3. Provision — skill in `STUDIO_SKILLS` only when on and studio not maestro; house-rule line only when on; existing no-Cloudflare-creds pins still pass. `vendored-skills.test.ts` covers new `SKILL.md`.
4. Local CLI — enable/disable/status against temp `HOME`.
5. Live smoke — manual, env-gated, not CI: one real call on operator account per path (local wrangler, local API token, deployed Worker).

## Rollout

1. Merge with flags off. Zero behavior change.
2. Deploy Worker (AI binding add). Worker-only deploy, no container churn.
3. Operator: `fleet junior enable` locally. Live smoke.
4. Set `FLEET_JUNIOR=on`, `JUNIOR_REPOS=rafarc21/fleetflare`. Maestro files one `--junior` task. Studio smoke: call succeeds. Second task without label: 403.
4a. Add junior lines to `~/.claude/CLAUDE.md` maestro section (local maestro).
5. Widen `JUNIOR_REPOS` after a week of telemetry lines look sane.

## Open questions

None blocking. English-only rule applies to all new files.
