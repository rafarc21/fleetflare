# Env-var docs sweep 30 — apps/fleet src+cli vs setup/operations/wrangler example (2026-10-13)

Ref #648. Analysis only, read-only, no code changed. Thirtieth
maintainability sweep. Scope: every `env.X` / `process.env.X` read in
`apps/fleet/src/**` and `apps/fleet/cli/**` minus `container/`,
cross-referenced against `docs/setup.md`, `docs/operations.md` and
`apps/fleet/wrangler.example.jsonc`. Line refs = physical lines at
origin/main `8aa9d69`, paths relative to `apps/fleet/`.

Method: scripted inventory of all 79 distinct `env.X` property reads plus
the 2 `process.env.X` reads (junior.ts HOME ×3 — homedir convention, and
orca-workspace.ts ORCA_CLI_COMMAND), each then hand-checked in the three
doc surfaces by grep. Ruled out: wrangler bindings (DB, AI, AGENT, DEPLOY,
STUDIO, STUDIO_BIG, STUDIO_ARCHIVE — config, not vars), every var named
in setup.md's step-5 enumeration or feature table, and the computed-name
families setup.md already covers (GITHUB_TOKEN_<OWNER>,
CLAUDE_CODE_OAUTH_TOKEN_<n>, GITHUB_READ_TOKEN_<OWNER>,
GITHUB_INSTALLATION_ID_<OWNER>).

**Tier rule:** GLM-OK = none of auth, secrets, credentials, rescue,
failover, accounts routing, deploy, migrations, write-proxy, leak-gate.
CLAUDE-ONLY = touches any of those. Lane follows the READ SITE's file,
not the doc surface the fix would edit (same ruling sweep 24 applied).

**Direction:** only "read but undocumented" findings below. The reverse
(drift: documented but no code reads) had zero hits — every name in
setup.md/operations.md/wrangler.example.jsonc that names a Worker var or
secret has a live reader, except INFISICAL_API_URL's sibling
INFISICAL_CLIENT_ID/_SECRET and TEST_CREDS_BY_REPO which operations.md
documents fully (§Studio test credentials).

## Findings

| # | finding | read site | default | proposed doc line | lane | issue |
|--:|---|---|---|---|---|---|
| 1 | `LEAD_COUNT_TOKENS_RATE_PER_MINUTE` — glm count_tokens route per-minute throttle; sibling LEAD_RATE_PER_MINUTE/LEAD_DAILY_CAP have commented wrangler examples, this one absent from all three surfaces | src/llm/ratelimit.ts:65 (env.ts:102) | 60 (`DEFAULT_LEAD_COUNT_TOKENS_RATE_PER_MINUTE`, ratelimit.ts:53) | commented `"LEAD_COUNT_TOKENS_RATE_PER_MINUTE": "60"` in wrangler.example.jsonc next to LEAD_RATE_PER_MINUTE; +1 line in setup.md step-5 vars enumeration | GLM-OK | [#651](https://github.com/rafarc21/fleetflare/issues/651) |
| 2 | Container-injected vars read by code, named by no operator doc (only threat-model.md names FLEET_SPAWN_TOKEN): STUDIO_NAME, STUDIO_SKILLS, STUDIO_MEMBERS_B64, STUDIO_COMPLETION_GATE (harness expectation), STUDIO_ID (registry-lock suppression), ORCA_WORKTREE_ID + TERM_PROGRAM (orcaPresent), ORCA_CLI_COMMAND (binary override), FLEET_MEMORY_TOKEN (ops-repo read token, exec-env only) | src/studio/provision.ts:1406-1435; cli/orca-workspace.ts:210, :542, :1364; src/memory/store.ts:32 | — (all set by the Worker itself, never operator config) | new ops.md subsection: one table, each var + who sets it + reader file | CLAUDE-ONLY (FLEET_MEMORY_TOKEN mint block is do.ts:6038-6046, credentials lane) | [#652](https://github.com/rafarc21/fleetflare/issues/652) |
| 3 | glm-lead container pair ANTHROPIC_AUTH_TOKEN (spawn token) + ANTHROPIC_BASE_URL (WORKER_PUBLIC_URL + glm route base) — setup.md:680 mentions glm-lead studios, never what their environment carries | src/studio/do.ts:4538-4539 (glmAnthropicBaseUrl :4519) | — (computed, never operator config) | 2 lines in setup.md near glm-lead coverage: the pair, who sets it, never operator config | CLAUDE-ONLY (read site = do.ts studioEnvVars credential block) | [#653](https://github.com/rafarc21/fleetflare/issues/653) |
| 4 | LEAD_RATE_PER_MINUTE + LEAD_DAILY_CAP — commented wrangler examples exist; setup.md step-5 vars enumeration (lines 302-309) lists the junior pair but not the lead pair | src/llm/ratelimit.ts:43, :45 (env.ts:91-92) | 60 / 2000 | add both to setup.md step-5 vars enumeration, one line, next to junior throttles | GLM-OK | [#654](https://github.com/rafarc21/fleetflare/issues/654) |
| 5 | LEAD_STREAM_IDLE_MS + LEAD_AI_RETRY_BASE_MS — same shape as #4: wrangler example documents, setup.md enumeration does not | src/llm/anthropic-route.ts:137-138, :158-159 (env.ts:110, :116) | 90000 / 500 | add both to setup.md step-5 vars enumeration alongside #4 | GLM-OK | [#655](https://github.com/rafarc21/fleetflare/issues/655) |
| 6 | FLEET_JUNIOR gates the glm route too (anthropic-route.ts:375 reuses the flag) — setup.md feature table row says junior only, an operator would leave it off on a junior-less glm fleet and lose the whole LLM path | src/llm/anthropic-route.ts:375 | off | extend setup.md FLEET_JUNIOR table row (+ the wrangler.example.jsonc comment) to name the glm route | GLM-OK | [#656](https://github.com/rafarc21/fleetflare/issues/656) |
| 7 | R2 trio (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) + INSTALL_CACHE_REPOS — named only in wrangler.example.jsonc's header comment; setup.md walkthrough never mentions the secrets or the opt-in var | src/studio/install-cache.ts:1373 (env.ts:417-419) | off (all three must be set together; presignR2 returns null otherwise) | name the trio as secrets + INSTALL_CACHE_REPOS as var in setup.md feature notes | GLM-OK | [#657](https://github.com/rafarc21/fleetflare/issues/657) |
| 8 | CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN read by cli/junior.ts for transport selection (proxy > api-token > wrangler; proxy = FLEET_WORKER_URL + FLEET_SPAWN_TOKEN, both injected) — setup.md documents both only as wrangler's vars, never the CLI's | cli/junior.ts:74, :79 | proxy when in-studio, else api-token if set, else wrangler | extend setup.md junior section: 3 transport modes + their env inputs | GLM-OK | [#658](https://github.com/rafarc21/fleetflare/issues/658) |
| 9 | JUNIOR_REPOS — the only one of FLEET_JUNIOR's four vars missing from setup.md's feature-table row (wrangler.example.jsonc:111 has the commented example) | src/junior/gate.ts:33 (env.ts:68) | every repo when FLEET_JUNIOR is on | add JUNIOR_REPOS to the FLEET_JUNIOR row | GLM-OK | [#659](https://github.com/rafarc21/fleetflare/issues/659) |
| 10 | No env-var reference page exists — every var documented exactly once, scattered (setup step text, feature table, wrangler comment, or env.ts doc comment), so gaps like #1-#9 recur by construction | (root cause, not a single read site) | — | docs/env-vars.md: one table, every Worker var + secret (name, var/secret, default, reader, feature pointer) + a container-injected section; do AFTER #1-#9 land so it consolidates correct text | GLM-OK | [#661](https://github.com/rafarc21/fleetflare/issues/661) |
| 11 | Git-identity pairs FLEET_BOT_NAME/_EMAIL (task container; leak-denylist-adjacent per env.ts:155-157, never reaches a studio) and FLEET_STUDIO_GIT_NAME/_EMAIL (studio + rescue commits; `[bot]` or FLEET_BOT-equal refused) — wrangler.example.jsonc documents all four; setup.md documents none | src/studio/credentials.ts:166-172 (studioGitIdentity; env.ts:158-159, :167-168) | FLEET_BOT_* absent = `fleetflare[bot]`; FLEET_STUDIO_GIT_* absent = `fleet-studio <fleet-studio@users.noreply.github.com>` | name both pairs in setup.md, each pointing at studioGitIdentity for the rules | CLAUDE-ONLY (read site = credentials lane; FLEET_BOT_NAME carries the leak-denylist note) | [#665](https://github.com/rafarc21/fleetflare/issues/665) |

## Excluded / no finding

- `AGENT_MODEL` (src/agents/do.ts:187, default claude-opus-5) — setup.md:307 names it. Not a gap.
- `MAX_STUDIOS` (src/studio/spawn.ts resolveMaxStudios) — setup.md:306 names it. Not a gap.
- `GITHUB_READ_TOKEN` + per-owner — setup.md:446 documents both. Not a gap.
- `INFISICAL_*`, `TEST_CREDS_BY_REPO` — operations.md §Studio test credentials documents all four. Not a gap.
- `ORCA_CLI_COMMAND`'s sibling `ORCA_WORKSPACE` etc. — no reads; orca deps are injected by the harness, not operator config, folded into finding 2's table proposal.
- Banned areas (auth, secrets, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate) were inventoried but produced no additional undocumented-var findings beyond #2/#3/#11, whose lanes mark them CLAUDE-ONLY for the fix.
