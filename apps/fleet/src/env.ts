import type { AgentDO } from "./agents/do";
import type { DeployDO } from "./deploy/do";
// Type-only — do.ts's own value import of "@cloudflare/sandbox" never
// reaches the runtime module graph through this. See
// src/studio/provision.ts's header comment for why that distinction is
// load-bearing here.
import type { StudioDO } from "./studio/do";

export interface Env {
  DB: D1Database;
  AGENT: DurableObjectNamespace<AgentDO>;
  DEPLOY: DurableObjectNamespace<DeployDO>;
  STUDIO: DurableObjectNamespace<StudioDO>;
  /**
   * Issue #107 (#70 ask 3): a second StudioDO container class for roles
   * profile.ts's BIG_PROFILE_ROLES marks "big" (release-studio today, the
   * QA/gate role) — see that file's own header and blueprint.ts's
   * Role.instance_type doc comment for the full ruling this completes.
   * wrangler.jsonc's containers[] entry for StudioBigDO is where the actual
   * instance_type value lives; this repo's own wrangler.example.jsonc/
   * wrangler.test.jsonc carry a placeholder (real value is the operator's
   * own ops-repo deploy config, same split every other instance_type in
   * this file already has). profile.ts's studioNamespace/getStudioStub are
   * the ONLY code that should read this binding directly — every other call
   * site routes through those instead of naming STUDIO/STUDIO_BIG itself.
   *
   * Issue #107 fix-first (operator, 2026-09-30): OPTIONAL, genuinely — an
   * older/forked fleet config's wrangler.jsonc can predate this binding
   * entirely, or a local `wrangler dev` may not have added it yet.
   * profile.ts's studioNamespace falls back to `env.STUDIO` (with a
   * console.warn) whenever it needs this binding and finds it missing,
   * rather than throwing — see that function's own doc comment.
   */
  STUDIO_BIG?: DurableObjectNamespace<StudioDO>;
  /** P2 transcript/session archival (src/studio/archive.ts owns the key
   * formats; shipping/sync loops are later tasks). Private — raw terminal
   * bytes, never scrubbed (see archive.ts's header). */
  STUDIO_ARCHIVE: R2Bucket;
  /**
   * Issue #335 (public-release scrub): the STUDIO_ARCHIVE binding's own
   * real `bucket_name` (wrangler.jsonc `r2_buckets[0].bucket_name`) — a
   * `vars` entry, not a secret (a bucket name isn't a credential).
   * install-cache.ts's presignR2 reads this; absent falls back to its own
   * neutral R2_BUCKET_NAME_DEFAULT.
   */
  R2_BUCKET_NAME?: string;
  /**
   * Board issue #334: the legacy Telegram surface (the `/tg` webhook,
   * AgentDO, DeployDO approvals, operator alerts) runs only when this is
   * exactly "on" — see agents/registry.ts's `telegramConfig`. Off in the
   * example config; on in the operator's own.
   */
  FLEET_TELEGRAM?: string;
  /** Telegram user id of the operator (the one sender /tg obeys, the one
   *  chat alerts go to). Config, never code. */
  TELEGRAM_OPERATOR_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Board issue #334: the Directus project card runs only when this is
   *  exactly "on" (directus/client.ts's `directusConfig`). */
  FLEET_DIRECTUS?: string;
  /** Junior (Workers AI delegation, docs/superpowers/specs/2026-09-28-junior-workers-ai-design.md):
   *  `/fleet/junior` answers and studios get the `junior` skill only when this
   *  is exactly "on". Absent = off. */
  FLEET_JUNIOR?: string;
  /** Optional comma list of "owner/repo" narrowing FLEET_JUNIOR, same format
   *  as INSTALL_CACHE_REPOS. Absent/empty = every repo when FLEET_JUNIOR is on. */
  JUNIOR_REPOS?: string;
  /**
   * PR #9 review, F1: per-studio throttles on `/fleet/junior`, both D1-backed
   * (src/junior/ratelimit.ts). `JUNIOR_RATE_PER_MINUTE` caps calls in any
   * rolling 60s bucket per studio (default 5); `JUNIOR_DAILY_CAP` caps calls
   * per UTC day per studio (default 50). Both optional, and garbage input
   * (absent, non-numeric, zero, negative) falls back to the default rather
   * than disabling the limit — see ratelimit.ts's parsePositiveInt.
   */
  JUNIOR_RATE_PER_MINUTE?: string;
  JUNIOR_DAILY_CAP?: string;
  /** Workers AI binding (`"ai": { "binding": "AI" }`). Only junior uses it. */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /**
   * THE claude credential, and the first of an ordered list.
   *
   * Issue #53 — CLAUDE_CODE_OAUTH_TOKEN_2, _3, … up to
   * src/studio/accounts.ts's MAX_CLAUDE_ACCOUNTS are additional ACCOUNTS the
   * fleet fails over to, in order, when the one a studio is on hits its limit.
   * `wrangler secret put CLAUDE_CODE_OAUTH_TOKEN_2` is the whole procedure:
   * adding an account is a secret write, never a code change.
   *
   * The alternates are deliberately NOT declared on this interface, exactly
   * like GITHUB_TOKEN_<OWNER> above and for the same reason — `Env` is closed
   * on purpose, and an index signature here would stop every `env.FOO` typo in
   * the codebase from failing the build. accounts.ts's resolveClaudeAccounts
   * isolates the computed-name reads behind one `unknown` cast.
   *
   * Only ONE of them ever reaches a container, always under this name, since
   * `claude` reads this name and no other: do.ts's studioEnvVars injects the
   * token of whichever account that studio is recorded on
   * (StudioStatus.claudeAccount).
   */
  CLAUDE_CODE_OAUTH_TOKEN: string;
  /**
   * Issue #271, optional, NOT a secret: repo -> account slot as JSON
   * (`{"demosite-life":2}`), keyed by the repo part of a studio id. Unmapped
   * repos launch on the first set account; a mapped slot whose secret is
   * unset refuses to launch. See accounts.ts's parseAccountMap/launchAccount.
   */
  CLAUDE_ACCOUNT_BY_REPO?: string;
  /** Issue #271, optional: auto-failover runs only when this is exactly "on". */
  FLEET_AUTO_FAILOVER?: string;
  /**
   * Issue #335 (public-release scrub): the TASK container's git identity
   * (container/server.ts). Usually the operator's App bot (`<slug>[bot]`) —
   * private, on the leak denylist. Issue #283: never reaches a studio, and
   * never becomes a studio's identity (see FLEET_STUDIO_GIT_NAME).
   */
  FLEET_BOT_NAME?: string;
  FLEET_BOT_EMAIL?: string;
  /**
   * Issue #283, optional, NOT a secret: the git identity every studio (and its
   * rescue commits) is authored as, set by the Worker on each credential
   * write. Both or neither; a `[bot]` value or one equal to FLEET_BOT_* is
   * ignored. Absent = `fleet-studio <fleet-studio@users.noreply.github.com>`.
   * See credentials.ts's studioGitIdentity.
   */
  FLEET_STUDIO_GIT_NAME?: string;
  FLEET_STUDIO_GIT_EMAIL?: string;
  /**
   * Issue #1 piece 5, optional, NOT a secret: `owner/name` of a PRIVATE repo
   * rescue pushes (rescue.ts) go to instead of `origin`, only for studios
   * whose work repo is PUBLIC (issue #24). Private or unknown visibility,
   * unset, malformed or a failed token mint = origin, logged loudly each
   * rescue. See rescue.ts's resolveRescueTarget.
   */
  FLEET_RESCUE_REMOTE?: string;
  /**
   * Issue #7, optional, NOT a secret: the work repos (`owner/name`, comma
   * separated) whose studios hold a read-only credential and push/gh-write
   * through /fleet/git and /fleet/gh. Unset = off everywhere: a deploy
   * changes nothing until the operator lists a repo and restarts its
   * studios. See src/write-proxy/mode.ts.
   */
  FLEET_WRITE_PROXY_REPOS?: string;
  /**
   * Issue #34, optional, NOT a secret: repos (`owner/name`, comma separated)
   * whose DEFAULT branch the write proxy may push. Unset = the proxy refuses
   * every update, force or delete of a repo's default branch.
   */
  FLEET_WRITE_PROXY_DEFAULT_BRANCH_REPOS?: string;
  /**
   * Issue #7, PAT fleets only: a read-only fine-grained PAT handed to studios
   * in proxy mode. GITHUB_READ_TOKEN_<OWNER> (same naming as
   * GITHUB_TOKEN_<OWNER>) wins for that owner. Unset = the studio gets no
   * GitHub credential at all (anonymous reads), never the write PAT. App
   * fleets need neither: the App token is narrowed to read at mint time.
   */
  GITHUB_READ_TOKEN?: string;
  /**
   * Issue #7, PAT fleets only: a fine-grained PAT with write access to the
   * FLEET_RESCUE_REMOTE repo and nothing else. It rides into the container
   * for rescue pushes; the fleet's own PAT never does. Unset on a PAT fleet =
   * rescue goes to origin through the write proxy (scanned).
   */
  FLEET_RESCUE_GITHUB_TOKEN?: string;
  /** Optional: no wrangler.jsonc `vars` entry today. AgentDO falls back to claude-opus-5. */
  AGENT_MODEL?: string;
  /**
   * The FLEET's own repo, `owner/name`. Committed in wrangler.jsonc, never
   * caller-supplied. Three distinct jobs, kept apart on purpose (dynamic
   * repo selection, P4a — see src/studio/repo.ts's header):
   *   - where `fleet.json` is read from, which is what names the BLUEPRINT
   *     repo (studios/, roles/, org.json). A work repo must never be able to
   *     move that pointer, so this stays fixed no matter which repo a studio
   *     clones.
   *   - the DEFAULT work repo: what a studio clones when nothing else names
   *     one (no detected repo, and no repo already bound to that studio).
   *   - AgentDO's own task repo (src/telegram/webhook.ts, approvals/gates.ts)
   *     — the Day-1 agent loop, unrelated to studios.
   * A repo the Worker resolved for a studio to clone lives on
   * ProvisionConfig.repoSlug / StudioStatus.repoSlug instead, never here.
   */
  /**
   * Issues #341/#330, optional: the operator's PRIVATE config repo
   * (`owner/name`, e.g. rafarc21/fleetflare-ops). Harvested memory lives at
   * `fleet/memory/` in it; the #330 house-rules overlay lives there too.
   * Unset = those features off, the public default. Set it with
   * `wrangler secret put FLEET_OPS_REPO` (not a secret, but it survives every
   * deploy and keeps the public config clean). See src/ops-repo.ts.
   */
  FLEET_OPS_REPO?: string;
  AGENT_REPO: string;
  AGENT_BASE_REF?: string;
  MAX_TASK_SECONDS?: string;
  /**
   * P6a repo auth — HOW the fleet touches git (src/github/auth.ts owns every
   * decision about it; this comment only says what to set). NOT operator auth:
   * "may this human drive the fleet?" is ACCESS_TEAM_DOMAIN/ACCESS_AUD below.
   *
   * Two providers, chosen PER REPO OWNER:
   *
   *   token — GITHUB_TOKEN, one fine-grained PAT. Any repo it was granted, any
   *           owner. The DEFAULT, and the whole of what an adopter must bring.
   *   app   — GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_INSTALLATION_ID.
   *           Org-scoped, a bot identity, higher rate limits.
   *
   * ALL FIVE ARE OPTIONAL, and that is the point of P6a: the App trio used to
   * be required, and GITHUB_INSTALLATION_ID in particular pinned the whole
   * fleet to ONE installation. GitHub Apps install per ACCOUNT, so that pin
   * made every personal-account repo permanently unreachable — installing the
   * App on the account creates a SECOND installation with a different id the
   * Worker never read. A fleet now needs a token, or the App, or both.
   *
   * GITHUB_REPO_AUTH — the owner -> provider map, comma-separated
   * `owner=provider`, with `*` as the wildcard: `"acme-org=app"` keeps the
   * org on the App while every other owner falls to the token. Non-secret
   * (owner names are not credentials), so it belongs in wrangler.jsonc's
   * `vars`. Absent = the automatic fallback: token when one is set, else the
   * App. An owner mapped to a provider that is not configured is a refusal
   * naming the missing variable, never a silent fallback to the other one.
   *
   * GITHUB_TOKEN — THE credential on the token path. A fine-grained PAT, set
   * with `wrangler secret put GITHUB_TOKEN`; never in wrangler.jsonc, never in
   * a client.json. It reaches a container only through the git credential
   * helper (src/studio/do.ts's credentialWriteCmd), never as a plain container
   * environment variable.
   *
   * GITHUB_TOKEN_<OWNER> — P6b, per-owner tokens. A fine-grained PAT has
   * exactly ONE resource owner, so ONE GITHUB_TOKEN can never reach two
   * owners' repos however GITHUB_REPO_AUTH is set. An owner may therefore
   * bring its own secret, named from the owner: uppercased with every
   * non-alphanumeric replaced by `_`, so `acme-hq` reads
   * GITHUB_TOKEN_ACME_HQ (src/github/auth.ts's tokenEnvName owns the
   * mapping, and pins it in a test). Optional and dynamic — deliberately NOT
   * declared on this interface, which is closed on purpose: auth.ts's
   * repoToken isolates the one computed-name read behind an `unknown` cast
   * rather than widening Env with an index signature that would stop every
   * other `env.FOO` typo from failing the build.
   *
   * Unset = that owner uses GITHUB_TOKEN, the declared default. The fallback
   * runs ONE way only: a per-owner token is never served for any owner but
   * its own.
   */
  GITHUB_APP_ID?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO_AUTH?: string;
  GITHUB_WEBHOOK_SECRET: string;
  /** Deploy container only (src/deploy/do.ts's envVars) — never the agent's. */
  /** Board #334: legacy DeployDO only (Telegram approvals); optional. */
  CLOUDFLARE_DEPLOY_TOKEN?: string;
  /**
   * Fleet Spawn P3, Task 3: this Worker's own public URL, committed
   * (non-secret — a deployed Worker's `*.workers.dev` address is not a
   * credential). do.ts's studioEnvVars threads it into every studio
   * container as `FLEET_WORKER_URL`, which is the ONE piece of config
   * `container/studio-fleet` needs beyond the spawn token itself to reach
   * `POST /fleet/spawn` — a studio has no other way to learn where "the
   * Worker" is, since it is cloned from AGENT_REPO, not from this repo.
   */
  WORKER_PUBLIC_URL: string;
  /** Cloudflare Access team domain — studio/auth.ts fetches this team's JWKS
   * from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`. */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application audience tag every /studio/* JWT must carry. */
  ACCESS_AUD: string;
  /**
   * Reusable Tailscale auth key. Should be EPHEMERAL (issue #189): every
   * container joins as a new node and destroy never removes it, so a
   * non-ephemeral key fills the tailnet's device quota. Threaded into the studio container's
   * environment by StudioDO.envVars, where container/studio-bringup.sh reads
   * it for `tailscale up`.
   *
   * Optional: a local `wrangler dev` / integration run has none, and the
   * bring-up script's own `[ -z "${TS_AUTHKEY:-}" ]` guard logs and skips
   * `tailscale up` in that case. A failing `tailscale up` (bogus key, full
   * quota) is non-fatal since issue #189: bring-up continues without the
   * tailnet and `fleet ls` READY says `provisioned (tailnet: ...)`.
   */
  TS_AUTHKEY?: string;
  /**
   * P2 plane 4 (token monitor, later task): rolling-5h output-token alert
   * threshold, telegram once per window. wrangler.jsonc `vars` sets "0"
   * (off); optional here too since a local `wrangler dev` / test run may
   * omit it entirely — either way, absent/"0" means alerts stay off.
   */
  BURN_ALERT_OUTPUT_TOKENS_5H?: string;
  /**
   * Fleet Spawn P3, Task 4 (R-P3-3): the fleet-wide cap on how many studios
   * may exist at once — src/studio/spawn.ts's `resolveMaxStudios` parses
   * this, enforced at BOTH provision entry points (routes.ts's direct
   * POST /studio/:id/provision and spawn.ts's runSpawn). Optional, parsed
   * defensively: absent or garbage both fall back to
   * spawn.ts's DEFAULT_MAX_STUDIOS (100), logged. Not set in wrangler.jsonc's
   * `vars` — the default is the intended value, and an operator who wants a
   * different cap adds it there deliberately (same "explicit-off beats an
   * absent var" posture BURN_ALERT_OUTPUT_TOKENS_5H takes, just defaulted
   * the other way since 100 studios is this feature's own target scale, not
   * an "off" state). wrangler.jsonc's StudioDO `max_instances` (raised
   * 5 -> 100 in the same commit that added this var) is a platform-level
   * backstop UNDER this app-level cap, not a replacement for it — see that
   * file's own comment.
   */
  MAX_STUDIOS?: string;
  /**
   * P5c — Directus, the ESTATE store (design §7): project registry,
   * contract, requirements-as-rows, decision log, client portal.
   *
   * BOTH OPTIONAL, and the fleet is fully functional with NEITHER set. That
   * is a design ruling, not a convenience: "Directus must be optional at
   * boot — a studio still comes up when it is unreachable. A fifth store
   * that can block provisioning is a fifth way to have no fleet."
   * src/directus/card.ts's `resolveProjectCard` is where that is enforced
   * (it swallows every failure and returns null), and
   * test/directus.card.test.ts proves provisioning survives an unreachable,
   * a 500-ing, and an unconfigured Directus.
   *
   * With neither set: `directusConfig` returns null, no project card is
   * resolved, no request is made, and every studio boots exactly as it did
   * before P5c. Nothing logs an error; a missing credential is a
   * configuration state, not a fault.
   *
   * DIRECTUS_URL — the instance origin, e.g. `https://directus.example.com`.
   * NOT a secret (a hostname is not a credential), so it belongs in
   * wrangler.jsonc's `vars` alongside WORKER_PUBLIC_URL rather than in
   * `wrangler secret`. It is declared optional here and NOT added to
   * wrangler.jsonc by this task, which was scoped not to touch that file —
   * adding the `vars` entry is the one repo edit still outstanding. Must be
   * https: client.ts refuses anything else outright rather than putting a
   * bearer token on a plaintext connection.
   *
   * DIRECTUS_TOKEN — THE credential, and the only one this feature needs.
   * A Directus STATIC ACCESS TOKEN belonging to a dedicated read-only role
   * (see docs/fleet/directus.md for the exact role and permissions). Set it
   * with `wrangler secret put DIRECTUS_TOKEN`; never in wrangler.jsonc,
   * never in a client.json, never threaded into a container — the Worker
   * reads and writes the estate, containers ask the Worker (§8's
   * single-writer rule, extended to Directus).
   */
  DIRECTUS_URL?: string;
  DIRECTUS_TOKEN?: string;
  /**
   * Board #350 — per-repo `bun install` cache (design in the issue body;
   * src/studio/install-cache.ts owns every decision about it). Comma-
   * separated "owner/repo" slugs, case-insensitive, e.g.
   * "example-org/websites" — see install-cache.ts's own header for why this
   * is a flat list and not a JSON map the way CLAUDE_ACCOUNT_BY_REPO is.
   * Committed in wrangler.jsonc's `vars` (repo slugs are not credentials,
   * same treatment AGENT_REPO/GITHUB_REPO_AUTH already get). Absent/empty =
   * every repo behaves exactly as it did before this feature existed — the
   * safe, opt-in default.
   */
  INSTALL_CACHE_REPOS?: string;
  /**
   * Board #350 — THREE secrets, all optional here and ALL THREE MUST be set
   * together before this feature does anything: install-cache.ts's
   * presignR2 refuses (returns null, logged nowhere per-call — see that
   * function's own doc comment) unless every one of them is present. They
   * are an R2 API TOKEN's access key id + secret access key, a DIFFERENT
   * credential from the plain Workers R2Bucket binding STUDIO_ARCHIVE above
   * already uses — R2's S3-compatible API (the only surface that can mint a
   * presigned URL) is authenticated with SigV4 against this pair, never the
   * binding's own credential. None of the three exist in this deploy yet;
   * minting an R2 API token is a Cloudflare-dashboard, operator-only action
   * (the same class of action this house's rules reserve for the maestro —
   * "Maestro deploys, never a studio"), and no code in this repo can
   * provision it. `wrangler secret put` for all three, never wrangler.jsonc
   * `vars` — an access key/secret pair is exactly the credential class
   * GITHUB_TOKEN/CLOUDFLARE_DEPLOY_TOKEN already get that treatment for.
   *
   * R2_ACCOUNT_ID        — the account id half of the R2 S3 endpoint
   *                        (`https://<this>.r2.cloudflarestorage.com`).
   * R2_ACCESS_KEY_ID     — the R2 API token's access key id.
   * R2_SECRET_ACCESS_KEY — the R2 API token's secret access key.
   */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /**
   * Issue #279: studio test credentials (src/creds/test-creds.ts). The
   * Worker's Infisical machine identity (Universal Auth) — Worker secrets set
   * with `wrangler secret put`, never vars, never in a container. Any of the
   * three below absent -> `/fleet/creds/*` answers 503 "test creds not
   * configured".
   */
  INFISICAL_CLIENT_ID?: string;
  INFISICAL_CLIENT_SECRET?: string;
  /** JSON var: `{"owner/repo": {"<name>": {workspaceId, environment, secretPath,
   *  key}}}`. Staging/dev/test environments and /test-accounts paths only;
   *  any other entry refuses the whole config. Holds locations, not values. */
  TEST_CREDS_BY_REPO?: string;
  /** Optional Infisical API origin (self-hosted). Default https://app.infisical.com. https only. */
  INFISICAL_API_URL?: string;
}
