# Env var docs drift sweep 39 (2026-10-13)

Ref #742. Analysis only, read-only — no code changed. Thirty-ninth
maintainability sweep; scope: `apps/fleet/src/env.ts`'s `Env` interface
vs docs/setup.md + docs/operations.md + apps/fleet/wrangler.example.jsonc.
Names only, never values. Line refs = physical lines at `origin/main`
`0cd438f`; paths relative to repo root.

Method: every field on `Env` (66 declarations incl. bindings) extracted
from env.ts, then grep'd case-exact across all three docs. Reverse
direction: every env var NAME documented in those docs grep'd in
`apps/fleet/src/**` + `apps/fleet/container/**` + `apps/fleet/scripts/**`
for a code read — including computed-name families (GITHUB_TOKEN_<OWNER>
via auth.ts tokenEnvName, GITHUB_READ_TOKEN_<OWNER> via write-proxy/mode.ts,
CLAUDE_CODE_OAUTH_TOKEN_<n> via accounts.ts, CLAUDE_ACCOUNT_<n>_LABEL via
accounts.ts labelVarName, GITHUB_INSTALLATION_ID_<OWNER> via app.ts).

**Ruled out (verified accurate, no finding):** every var documented in
docs/setup.md has a code read — ACCESS_TEAM_DOMAIN/ACCESS_AUD (studio/auth.ts),
GITHUB_WEBHOOK_SECRET (github/webhook.ts), TS_AUTHKEY (studio/do.ts envVars),
CLOUDFLARE_DEPLOY_TOKEN (deploy/do.ts), FLEET_OPS_REPO (ops-repo.ts),
TELEGRAM_* trio (agents/registry.ts), FLEET_RESCUE_REMOTE/FLEET_RESCUE_GITHUB_TOKEN
(studio/rescue.ts:116, studio/do.ts:6873), FLEET_WRITE_PROXY_REPOS/
FLEET_WRITE_PROXY_DEFAULT_BRANCH_REPOS (write-proxy/mode.ts), GITHUB_READ_TOKEN
(write-proxy/mode.ts:104), FLEET_AUTO_FAILOVER/FLEET_REQUIRE_ACCOUNT_MAP/
CLAUDE_ACCOUNT_BY_REPO (studio/accounts.ts), AGENT_BASE_REF (telegram/webhook.ts:191),
MAX_TASK_SECONDS (agents/do.ts:281), AGENT_MODEL (agents/do.ts:187), MAX_STUDIOS
(studio/routes.ts:259, spawn.ts), BURN_ALERT_OUTPUT_TOKENS_5H (studio/do.ts:6843),
INFISICAL_* + TEST_CREDS_BY_REPO (creds/test-creds.ts:225-247), DIRECTUS_URL/
DIRECTUS_TOKEN (directus/client.ts:87-89), JUNIOR_RATE_PER_MINUTE/JUNIOR_DAILY_CAP
(junior/ratelimit.ts), FLEET_JUNIOR/JUNIOR_REPOS (junior/gate.ts:33),
FLEET_BOT_NAME/FLEET_BOT_EMAIL (studio/credentials.ts:168 — the [bot]-guard),
FLEET_STUDIO_GIT_NAME/FLEET_STUDIO_GIT_EMAIL (studio/credentials.ts:166-167).
Direction B clean: no documented var lacks a code read.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | LEAD_RATE_PER_MINUTE + LEAD_DAILY_CAP — absent from setup.md and operations.md | GLM-OK |
| 2 | LEAD_COUNT_TOKENS_RATE_PER_MINUTE — absent from all three docs | GLM-OK |
| 3 | LEAD_STREAM_IDLE_MS + LEAD_AI_RETRY_BASE_MS — absent from setup.md and operations.md | GLM-OK |
| 4 | FLEET_BOT_* + FLEET_STUDIO_GIT_* — absent from setup.md | GLM-OK |
| 5 | INSTALL_CACHE_REPOS + R2_BUCKET_NAME + R2_* secret trio — absent from setup.md | CLAUDE-ONLY |
| 6 | LEAD_MODEL_POOL + LEAD_AI_GATEWAY_ID + MODEL_QUALITY_ISSUE — absent from wrangler.example.jsonc | GLM-OK |

### S39-F1. LEAD_RATE_PER_MINUTE / LEAD_DAILY_CAP — glm-lead throttle pair undocumented — GLM-OK

- **Declared:** apps/fleet/src/env.ts:91 (`LEAD_RATE_PER_MINUTE?`), :92
  (`LEAD_DAILY_CAP?`); read at apps/fleet/src/llm/ratelimit.ts:43-46
  (`perMinuteEnv`/`dailyCapEnv` strings), defaults ratelimit.ts:22 (60), :31 (2000).
- **Documented:** only in apps/fleet/wrangler.example.jsonc:119-120, as
  commented-out entries. docs/setup.md never mentions either name; its
  optional-features table (docs/setup.md:39-45) documents the JUNIOR_*
  throttle pair but not the parallel LEAD_* pair. docs/operations.md silent.
- **Proposed doc line (setup.md flag table row):** `| \`LEAD_RATE_PER_MINUTE\`/\`LEAD_DAILY_CAP\` | glm-lead route throttle (per-minute / per-UTC-day per studio, defaults 60 / 2000) | none — both optional vars |`

### S39-F2. LEAD_COUNT_TOKENS_RATE_PER_MINUTE — nowhere in any doc — GLM-OK

- **Declared:** apps/fleet/src/env.ts:102; read at
  apps/fleet/src/llm/ratelimit.ts:65 (`perMinuteEnv`), default ratelimit.ts:53 (60).
- **Documented:** nowhere. Not in setup.md, not in operations.md, not in
  wrangler.example.jsonc — not even as a commented entry (its sibling LEAD_*
  throttle vars at least get those).
- **Proposed doc line (setup.md, near the glm-lead throttle row):**
  `\`LEAD_COUNT_TOKENS_RATE_PER_MINUTE\` (default 60) throttles the count_tokens endpoint per studio; no daily arm — the endpoint spends no AI budget.`

### S39-F3. LEAD_STREAM_IDLE_MS / LEAD_AI_RETRY_BASE_MS — glm-lead stream tuning undocumented — GLM-OK

- **Declared:** apps/fleet/src/env.ts:110 (`LEAD_STREAM_IDLE_MS?`, default
  90000), :116 (`LEAD_AI_RETRY_BASE_MS?`, default 500); read at
  apps/fleet/src/llm/anthropic-route.ts:138 and :159 via parsePositiveInt.
- **Documented:** only as commented entries in wrangler.example.jsonc:123
  and :126. setup.md and operations.md silent on both.
- **Proposed doc line (setup.md flag table row):** `| \`LEAD_STREAM_IDLE_MS\`/\`LEAD_AI_RETRY_BASE_MS\` | glm-lead stream idle timeout (ms, default 90000) and pre-stream 504/529 retry backoff base (ms, default 500) | none |`

### S39-F4. FLEET_BOT_* / FLEET_STUDIO_GIT_* — git identity vars absent from setup.md — GLM-OK

- **Declared:** apps/fleet/src/env.ts:165 (`FLEET_BOT_NAME?`), :166
  (`FLEET_BOT_EMAIL?`), :174 (`FLEET_STUDIO_GIT_NAME?`), :175
  (`FLEET_STUDIO_GIT_EMAIL?`); read at apps/fleet/src/studio/credentials.ts:166-168
  (studioGitIdentity) and container/server.ts:178-183 (task container git config).
- **Documented:** wrangler.example.jsonc:130-139 carries all four (two active,
  two commented). docs/setup.md never names any of the four — an operator
  reading only setup.md cannot discover the fleet's git identity is
  configurable at all.
- **Proposed doc line (setup.md, in "Secrets vs. vars" vars list):** add
  `FLEET_BOT_NAME`, `FLEET_BOT_EMAIL`, `FLEET_STUDIO_GIT_NAME`,
  `FLEET_STUDIO_GIT_EMAIL` to the non-secret vars enumeration, each optional
  with a neutral built-in default.

### S39-F5. INSTALL_CACHE_REPOS + R2_BUCKET_NAME + R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY — install-cache vars absent from setup.md — CLAUDE-ONLY

- **Declared:** apps/fleet/src/env.ts:46 (`R2_BUCKET_NAME?`), :401
  (`INSTALL_CACHE_REPOS?`), :424-426 (the R2_* secret trio); read at
  apps/fleet/src/studio/install-cache.ts:1373-1375.
- **Documented:** wrangler.example.jsonc:8-12 (secrets named in the header
  comment), :87 (commented INSTALL_CACHE_REPOS), :130 (R2_BUCKET_NAME).
  docs/setup.md documents creating the R2 bucket (lines 171-179) but never
  the R2_BUCKET_NAME var that must mirror `r2_buckets[0].bucket_name`, never
  INSTALL_CACHE_REPOS, never the three R2_* secrets — the whole install-cache
  feature is invisible to a setup.md-only reader.
- **CLAUDE-ONLY lane:** the R2_* trio are credentials (an R2 API token's
  access key id + secret access key + account id); finding, issue and fix
  handled by a Claude studio, never GLM.
- **Proposed doc line (setup.md, new "Install cache" subsection):**
  `\`INSTALL_CACHE_REPOS\` (vars, comma list of owner/repo) opts a repo into the per-repo bun-install cache; needs secrets \`R2_ACCOUNT_ID\`, \`R2_ACCESS_KEY_ID\`, \`R2_SECRET_ACCESS_KEY\` (an R2 API token scoped to the archive bucket) and var \`R2_BUCKET_NAME\` matching r2_buckets[0].bucket_name.`

### S39-F6. LEAD_MODEL_POOL / LEAD_AI_GATEWAY_ID / MODEL_QUALITY_ISSUE — newest feature, example config missing them — GLM-OK

- **Declared:** apps/fleet/src/env.ts:443 (`LEAD_MODEL_POOL?`), :445
  (`LEAD_AI_GATEWAY_ID?`), :452 (`MODEL_QUALITY_ISSUE?`); read at
  apps/fleet/src/llm/anthropic-route.ts:643 (pool on/off), :182 (gateway id),
  apps/fleet/src/llm/model-quality-cron.ts:164 and :174, src/index.ts:277.
- **Documented:** docs/setup.md:45 (flag-table row — good) and
  docs/operations.md:139-140. Missing from
  apps/fleet/wrangler.example.jsonc: no `LEAD_MODEL_POOL` entry at all —
  neither active nor commented — so the example template, the file an
  operator copies first, cannot enable the feature it has never heard of.
  Every other optional feature flag (FLEET_TELEGRAM, FLEET_DIRECTUS,
  FLEET_AUTO_FAILOVER, FLEET_JUNIOR) has at least an `"off"` placeholder
  entry there.
- **Proposed doc line (wrangler.example.jsonc, vars block):**
  `"LEAD_MODEL_POOL": "off"` plus commented `// "LEAD_AI_GATEWAY_ID": "default"`
  and `// "MODEL_QUALITY_ISSUE": "<issue-number>"`, same shape as the other flags.

## Outcome

Six findings: five GLM-OK (doc additions to setup.md and one
wrangler.example.jsonc entry), one CLAUDE-ONLY (S39-F5, R2 credentials).
No documented var lacks a code read — the drift is one-directional:
code-declared vars the docs have not caught up with, concentrated in the
glm-lead route's throttle/tuning vars (F1-F3) and the two newest features
(install cache, model pool).
