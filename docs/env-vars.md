# Environment variables reference

Every operator-configurable var and secret, plus the Worker- and
runtime-injected set a studio or task container actually carries, on one
page. This is the reference; [docs/setup.md](setup.md) stays the
walkthrough (it names the vars a first deploy actually sets) and links
here for the rest. `apps/fleet/src/env.ts` remains the source of truth —
if a table row here ever disagrees with that file, env.ts wins. Reader
paths are relative to `apps/fleet/`. Out of scope, deliberately: the
wrangler bindings themselves (DB, AI, AGENT, DEPLOY, STUDIO, STUDIO_BIG,
STUDIO_ARCHIVE, R2 buckets) — config, not env vars.

Two house rules that shape every row below:

- **Vars vs. secrets.** Non-secret configuration (repo names, ids that
  are not credentials, feature flags, throttles) belongs in your own
  `wrangler.jsonc`'s `vars`. Actual credentials never go there — they are
  set with `scripts/deploy.sh secret put <NAME>`, never a bare
  `wrangler secret put`. Exceptions where a non-secret-shaped value is
  deliberately kept as a secret (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
  `FLEET_OPS_REPO`) are marked in the secrets table.
- **Flag semantics.** Feature gates (`FLEET_TELEGRAM`, `FLEET_DIRECTUS`,
  `FLEET_AUTO_FAILOVER`, `FLEET_REQUIRE_ACCOUNT_MAP`, `FLEET_JUNIOR`) act
  only on the exact string `"on"`. Anything else — absent, `"true"`,
  `"1"` — means off.

## Operator-facing vars (`vars` in your wrangler.jsonc)

| Var | Default | What it does | Reader |
|---|---|---|---|
| `AGENT_REPO` | — (required) | The fleet's own repo `owner/name`: where `fleet.json` is read from, the default work repo, and the agent loop's task repo | `src/studio/repo.ts` |
| `AGENT_BASE_REF` | `staging` (code fallback; the example template commits `main` — sane for any fork) | Ref AgentDO clones its task repo at | `src/telegram/webhook.ts` |
| `AGENT_MODEL` | `claude-opus-5` | Model name AgentDO passes to the CLI | `src/agents/do.ts` |
| `MAX_TASK_SECONDS` | `900` | AgentDO task container time cap (seconds) | `src/agents/do.ts` |
| `MAX_STUDIOS` | `100` | Fleet-wide cap on existing studios, enforced at both provision entry points | `src/studio/spawn.ts` |
| `WORKER_PUBLIC_URL` | — (required) | This Worker's own public URL; threaded into every studio container as `FLEET_WORKER_URL` | `src/studio/do.ts` |
| `GITHUB_APP_ID` | off (App path off) | GitHub App id — the App auth provider | `src/github/auth.ts` |
| `GITHUB_INSTALLATION_ID` | off (App path off) | Shared GitHub App installation id | `src/github/app.ts` |
| `GITHUB_REPO_AUTH` | auto: token if set, else App | `owner=provider` map, `*` wildcard, choosing token vs. App per owner | `src/github/auth.ts` |
| `CLAUDE_ACCOUNT_BY_REPO` | unset (unmapped) | JSON `<repo>:<slot>` mapping studios to Claude account slots | `src/studio/accounts.ts` |
| `CLAUDE_ACCOUNT_<n>_LABEL` | none | Optional account label (usually the account email), shown by `fleet ls` and alerts; a label is not a credential | `src/studio/accounts.ts` |
| `FLEET_REQUIRE_ACCOUNT_MAP` | off | `"on"`: refuse to launch a studio whose repo has no `CLAUDE_ACCOUNT_BY_REPO` key | `src/studio/accounts.ts` |
| `FLEET_TELEGRAM` | off | `"on"`: legacy Telegram surface (`/tg` webhook, AgentDO tasks, DeployDO approvals, alerts) | `src/agents/registry.ts` |
| `TELEGRAM_OPERATOR_ID` | — | Telegram user id of the operator (`/tg` sender, alert chat) | `src/agents/registry.ts` |
| `FLEET_DIRECTUS` | off | `"on"`: Directus project card in studio prompts | `src/directus/client.ts` |
| `DIRECTUS_URL` | off (card off) | Directus instance origin, https only | `src/directus/client.ts` |
| `FLEET_AUTO_FAILOVER` | off | `"on"`: switch Claude accounts automatically on a usage limit | `src/studio/accounts.ts` |
| `FLEET_JUNIOR` | off | `"on"`: junior skill + `/fleet/junior` answers, AND the glm-lead LLM route (`/fleet/llm/anthropic/v1/messages`) — one flag gates both Workers-AI-spending routes | `src/junior/gate.ts`, `src/llm/anthropic-route.ts` |
| `JUNIOR_REPOS` | every repo | Comma list of `owner/repo` narrowing the junior skill, `/fleet/junior`, and the glm-lead PROVISION gate (`do.ts` refuses a glm studio whose repo is narrowed out); the glm route at request time checks only `FLEET_JUNIOR` | `src/junior/gate.ts` |
| `JUNIOR_RATE_PER_MINUTE` | 5 | `/fleet/junior` calls per rolling 60s per studio | `src/junior/ratelimit.ts` |
| `JUNIOR_DAILY_CAP` | 50 | `/fleet/junior` calls per UTC day per studio | `src/junior/ratelimit.ts` |
| `LEAD_RATE_PER_MINUTE` | 60 | glm-lead messages-route calls per rolling 60s per studio | `src/llm/ratelimit.ts` |
| `LEAD_DAILY_CAP` | 2000 | glm-lead messages-route calls per UTC day per studio | `src/llm/ratelimit.ts` |
| `LEAD_COUNT_TOKENS_RATE_PER_MINUTE` | 60 | glm-lead `/count_tokens` calls per rolling 60s per studio (its own counter, no daily cap) | `src/llm/ratelimit.ts` |
| `LEAD_STREAM_IDLE_MS` | 90000 | ms the glm-lead route waits for an upstream stream chunk before erroring | `src/llm/anthropic-route.ts` |
| `LEAD_AI_RETRY_BASE_MS` | 500 | Base backoff (ms) before retrying a pre-stream Workers AI 504/529 (2 retries max) | `src/llm/anthropic-route.ts` |
| `BURN_ALERT_OUTPUT_TOKENS_5H` | `0` (off) | Rolling-5h output-token alert threshold, Telegram once per window | `src/studio/do.ts` |
| `FLEET_BOT_NAME` / `FLEET_BOT_EMAIL` | `fleetflare[bot]` | Task container's git identity (default applied in container/server.ts; rescue side in src/studio/rescue.ts); never a studio's identity — src/studio/credentials.ts only refuses a studio identity equal to it | `container/server.ts` (default), `src/studio/credentials.ts` (refusal rule) |
| `FLEET_STUDIO_GIT_NAME` / `FLEET_STUDIO_GIT_EMAIL` | `fleet-studio <fleet-studio@users.noreply.github.com>` | Git identity every studio and its rescue commits are authored as; both or neither; a `[bot]` value or one equal to `FLEET_BOT_*` is ignored | `src/studio/credentials.ts` |
| `INSTALL_CACHE_REPOS` | off | Comma list of `owner/repo` opting repos into the per-repo `bun install` cache; needs the three `R2_*` secrets below | `src/studio/install-cache.ts` |
| `R2_BUCKET_NAME` | `studio-archive` (`R2_BUCKET_NAME_DEFAULT`) | The `STUDIO_ARCHIVE` binding's real `bucket_name`; presigned install-cache URLs sign against it | `src/studio/install-cache.ts` |
| `FLEET_RESCUE_REMOTE` | origin | `owner/name` of a PRIVATE repo rescue pushes go to for public work repos only | `src/studio/rescue.ts` |
| `FLEET_WRITE_PROXY_REPOS` | off everywhere | Comma list of `owner/name` whose studios hold read-only GitHub creds and write through the Worker proxy | `src/write-proxy/mode.ts` |
| `FLEET_WRITE_PROXY_DEFAULT_BRANCH_REPOS` | refuse every default-branch push | Comma list of `owner/name` whose default branch the proxy may push anyway | `src/write-proxy/mode.ts` |
| `TEST_CREDS_BY_REPO` | off (503) | JSON `<owner/repo>` -> name -> Infisical location (locations, never values); staging/dev/test paths only | `src/creds/test-creds.ts` |
| `INFISICAL_API_URL` | `https://app.infisical.com` | Optional self-hosted Infisical origin, https only | `src/creds/test-creds.ts` |

## Secrets (`scripts/deploy.sh secret put <NAME>`)

| Secret | What it is | Reader |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | THE claude credential; alternates `CLAUDE_CODE_OAUTH_TOKEN_<n>` add failover accounts | `src/studio/accounts.ts` |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret you invent in setup step 3 | `src/github/webhook.ts` |
| `GITHUB_TOKEN` | Fine-grained PAT — the default GitHub auth path; `GITHUB_TOKEN_<OWNER>` overrides per owner | `src/github/auth.ts` |
| `GITHUB_APP_PRIVATE_KEY` | The App's PKCS#8 private key (App path only) | `src/github/app.ts` |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain. Not secret-shaped, but kept as a secret: a committed same-named var collides at deploy time | `src/studio/auth.ts` |
| `ACCESS_AUD` | Access application audience tag. Same collision rule as above | `src/studio/auth.ts` |
| `TS_AUTHKEY` | Reusable EPHEMERAL Tailscale auth key; optional | `src/studio/do.ts` |
| `TELEGRAM_BOT_TOKEN` | Bot token, `FLEET_TELEGRAM` only | `src/agents/registry.ts` |
| `TELEGRAM_WEBHOOK_SECRET` | Your invented Telegram webhook secret, `FLEET_TELEGRAM` only | `src/agents/registry.ts` |
| `DIRECTUS_TOKEN` | Directus static access token (read-only role), `FLEET_DIRECTUS` only | `src/directus/client.ts` |
| `FLEET_OPS_REPO` | `owner/name` of your private ops repo. Not secret-shaped, but kept as a secret so it survives every deploy and stays out of the public config | `src/ops-repo.ts` |
| `FLEET_RESCUE_GITHUB_TOKEN` | PAT fleets only: PAT that can write ONLY the `FLEET_RESCUE_REMOTE` repo | `src/studio/do.ts` |
| `GITHUB_READ_TOKEN` | PAT fleets only: read-only PAT handed to studios in proxy mode; `GITHUB_READ_TOKEN_<OWNER>` per owner | `src/write-proxy/mode.ts` |
| `CLOUDFLARE_DEPLOY_TOKEN` | Worker-side deploy container only (legacy Telegram deploy-approval gate); never a studio's | `src/deploy/do.ts` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API-token pair + account id for install-cache presigned URLs; ALL THREE together or the feature stays off; a different credential from the `STUDIO_ARCHIVE` binding | `src/studio/install-cache.ts` |
| `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` | Infisical Universal Auth machine identity for `fleet creds get`; any missing = 503 | `src/creds/test-creds.ts` |

## Computed-name families

Named at runtime from an owner or a slot, so they are deliberately NOT
declared in env.ts (a closed interface is what makes every other `env.FOO`
typo fail the build). Setup.md owns the naming rules:

- `GITHUB_TOKEN_<OWNER>` — a fine-grained PAT is single-owner, so an owner
  may bring its own token. Owner uppercased, every non-alphanumeric
  character replaced by `_` (`acme-corp` -> `GITHUB_TOKEN_ACME_CORP`).
  Reader: `src/github/auth.ts` (`tokenEnvName`/`repoToken`).
- `GITHUB_READ_TOKEN_<OWNER>` — same naming, read-only twin for proxy
  mode. Reader: `src/write-proxy/mode.ts`.
- `GITHUB_INSTALLATION_ID_<OWNER>` — same naming, one App installation
  per account. Reader: `src/github/app.ts` (`installationEnvName`).
- `CLAUDE_CODE_OAUTH_TOKEN_<n>` — failover Claude accounts, `_2` up to
  `MAX_CLAUDE_ACCOUNTS`, in order. Reader: `src/studio/accounts.ts`.
- `CLAUDE_ACCOUNT_<n>_LABEL` — see the vars table above.

## Container- and CLI-injected (never operator config)

Set by the Worker or by the runtime, read inside a studio/task container
or the CLI. An operator never writes any of these; they are listed so a
grepping studio (or a curious operator) can identify each one.

| Var | Who sets it | Reader |
|---|---|---|
| `STUDIO_NAME` | Worker, at provision | `src/studio/provision.ts` |
| `STUDIO_ID` | Worker, at provision | `src/studio/do.ts` (sets), `cli/orca-workspace.ts` (reads) |
| `STUDIO_SKILLS` | Worker, at provision (comma list) | `src/studio/provision.ts` |
| `STUDIO_MEMBERS_B64` | Worker, at provision (base64 member bundle) | `src/studio/provision.ts` |
| `STUDIO_COMPLETION_GATE` | Worker, at provision ("" when the role writes no code) | `src/studio/provision.ts` |
| `FLEET_SPAWN_TOKEN` | Worker, at provision (the container's one credential) | container/studio-fleet |
| `FLEET_WORKER_URL` | Worker, at provision (= `WORKER_PUBLIC_URL`) | container/studio-fleet |
| `FLEET_MEMORY_TOKEN` | Worker, on the memory-clone exec env only (ops-repo read token) | `src/memory/store.ts` |
| `ANTHROPIC_AUTH_TOKEN` | Worker, glm-lead studios only (= the studio's own spawn token) | `claude` in the container |
| `ANTHROPIC_BASE_URL` | Worker, glm-lead studios only (= `WORKER_PUBLIC_URL` + glm route base) | `claude` in the container |
| `TERM_PROGRAM` / `ORCA_WORKTREE_ID` | Orca (the editor), when a session runs inside it | `cli/orca-workspace.ts` |
| `ORCA_CLI_COMMAND` | You, only to override the `orca` binary's name on PATH | `cli/orca-workspace.ts` |
| `FLEET_GIT_NAME` / `FLEET_GIT_EMAIL` | Worker, on the git-identity credential exec (= the studio git identity) | `src/studio/credentials.ts` (sets), the `git config` exec (reads) |
| `FLEET_TOKEN` | Worker, on the git credential exec (the container's GitHub token) | `src/studio/credentials.ts` (sets), `~/.git-credentials` write (reads) |
| `ROLE_PROMPT_B64` | Worker, at provision (the role's prompt, base64) | `container/studio-bringup.sh` |
| `ROLE_ALLOWED_TOOLS` / `ROLE_EFFORT` | Worker, at provision (claude `--allowedTools` / `--effort`) | `container/studio-bringup.sh` |
| `ROLE_MCP` / `STUDIO_MCP` | Worker, at provision (MCP servers config) | `container/studio-bringup.sh` |
| `STUDIO_LEAD_DISALLOWED` | Worker, at provision (lead tool-deny install switch) | `container/studio-bringup.sh` |
| `FLEET_WORKSPACE` | Worker, at provision (the workspace dir, default /workspace) | `container/studio-bringup.sh` |
| `FLEET_FRESH_SESSION` | Worker, only with `--fresh-session` provision/recycle | `container/studio-bringup.sh` |
| `GH_TOKEN` / `GITHUB_TOKEN` | Worker, on the agent task container's claude exec (the task repo token) | `container/server.ts` |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | You (your shell), for `fleet junior enable`'s direct Workers AI transport selection | `cli/junior.ts` |
