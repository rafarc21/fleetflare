# Threat model

For someone deciding whether to run fleetflare: what the system holds, where
each credential lives, what a studio can do, and which risks are accepted by
design. Every claim cites file and line; anything the code does not show is
marked **unverified**. Report vulnerabilities as described in
[SECURITY.md](../SECURITY.md).

## System in one paragraph

A Cloudflare Worker (`apps/fleet/src/index.ts`) fronts three Durable Object
classes. `StudioDO` runs a long-lived Cloudflare Container per "studio", where
Claude Code runs as root inside tmux (`apps/fleet/container/Dockerfile.studio`,
`apps/fleet/container/studio-bringup.sh`). `DeployDO` runs a separate deploy
container. The operator drives the fleet from a Mac with the `fleet` and `ff`
CLIs (`apps/fleet/cli/fleet.ts`). GitHub is the source of truth for code and
the task board.

## Assets and where they live

Secret names only. No value appears anywhere in this document.

| Secret (Worker binding) | Purpose | Reaches a studio container? |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` (and `_2`, `_3`, ...) | Claude account(s) the studios run on | **Yes**, one account's token, as a plain process environment variable (`apps/fleet/src/studio/do.ts:2672`; alternates stay Worker-side, `apps/fleet/src/env.ts:36-39`) |
| `GITHUB_TOKEN`, `GITHUB_TOKEN_<OWNER>` | Fine-grained PAT, per repo owner (`apps/fleet/src/env.ts:98-118`) | **Yes**, written to a credential file (see next section) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` (+ per-owner ids) | GitHub App; the Worker mints installation tokens (`apps/fleet/src/github/app.ts:78`) | The private key: no. Minted installation tokens: **yes**, same file as the PAT |
| `TS_AUTHKEY` | Tailscale auth key, documented as **reusable, ephemeral** (issue #189) (`apps/fleet/src/env.ts:143-156`) | **Yes**, plain environment variable (`apps/fleet/src/studio/do.ts:2677`) |
| `FLEET_SPAWN_TOKEN` (minted per studio, not a Worker secret) | Studio-to-Worker authentication on `/fleet/*` | **Yes**, plain environment variable (`apps/fleet/src/studio/do.ts:2679`) |
| `CLOUDFLARE_DEPLOY_TOKEN` | Cloudflare deploys | **No.** Only the deploy container's env (`apps/fleet/src/deploy/do.ts:215-216`, `apps/fleet/src/env.ts:126`) |
| `GITHUB_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `DIRECTUS_TOKEN` | Worker-side verification and integrations (`apps/fleet/src/env.ts`) | No (`DIRECTUS_TOKEN`: explicitly never, `apps/fleet/src/env.ts:208-214`) |

**GitHub token scope.** Which provider serves a repo is chosen per owner by
`GITHUB_REPO_AUTH` (`apps/fleet/src/github/auth.ts:307-311`). Two facts matter:

- An App installation token is requested with **no `permissions` or
  `repositories` narrowing** in the request body
  (`apps/fleet/src/github/app.ts:96-107`). It therefore carries every
  permission the App was granted, on every repo in that installation. It
  expires after one hour, and studios refresh it every 50 minutes
  (`apps/fleet/src/studio/do.ts:151-156`).
- A PAT lives as long as its owner configured it; the fleet cannot shorten it
  (`apps/fleet/src/github/auth.ts:300-306`).

The permissions actually granted to the App or the PAT are set in GitHub's UI
and are **unverified** from this repository. Assume write access to contents
and pull requests at minimum, since studios push branches and open PRs.

## What lands inside a studio container

| Credential | Location | File mode |
|---|---|---|
| Claude OAuth token | Container process environment, inherited by the tmux server and every pane (`apps/fleet/src/studio/do.ts:2500-2510`) | n/a |
| GitHub token (App or PAT) | `/workspace/.git-credentials`, plus `$HOME/.config/gh/hosts.yml` for `gh` (`apps/fleet/src/studio/credentials.ts:114-130`). Read-only when the work repo is on `FLEET_WRITE_PROXY_REPOS` (issue #7, `apps/fleet/src/write-proxy/mode.ts`); writes then go through the Worker's scanning proxy | `hosts.yml` is 600; `.git-credentials` gets no explicit chmod |
| Blueprint-repo GitHub token | `/workspace/.git-credentials-blueprint` (`apps/fleet/src/studio/credentials.ts:204-216`) | no explicit chmod |
| Tailscale auth key, spawn token | Process environment (`apps/fleet/src/studio/do.ts:2677-2679`) | n/a |

Care was taken to keep tokens out of argv and logs: the token reaches the
write command through the exec's environment and is expanded only by `printf`,
a shell builtin (`apps/fleet/src/studio/credentials.ts:97-101`). Worker-side
error text is scrubbed for GitHub, Tailscale and Anthropic token shapes
(`apps/fleet/src/studio/redact.ts:1-40`).

None of that changes who can read them inside the container. Claude Code runs
as root (no `USER` directive, `apps/fleet/src/studio/credentials.ts:42-45`), so
**every process in the container, and therefore the model itself, can read
every credential above** with `env`, `cat`, or `/proc/*/environ`. File modes
do not help against root.

The R2 archive of terminal output is raw and never scrubbed
(`apps/fleet/src/env.ts:14-18`), so a token a studio echoes can land there.

## Root, `IS_SANDBOX=1` and `--dangerously-skip-permissions`

**What is set.** The image sets `IS_SANDBOX=1`
(`apps/fleet/container/Dockerfile.studio:10`), and bring-up always launches the
lead with `--dangerously-skip-permissions`
(`apps/fleet/container/studio-bringup.sh:1516`). Claude Code refuses that flag
as root unless `IS_SANDBOX=1` is present
(`apps/fleet/container/studio-bringup.sh:1502-1505`).

**Why.** Studios run unattended; an unanswered prompt parks one forever (`apps/fleet/container/studio-bringup.sh:1100-1106`).

**What it permits.** Every tool call, including any Bash command, runs without
a prompt, as root. `allowedTools` gates nothing under this flag
(`apps/fleet/container/studio-bringup.sh:853`).

**What contains it.**

1. The container boundary. The code states that the base image
   (`cloudflare/sandbox:0.12.7`) is a Firecracker microVM
   (`apps/fleet/container/Dockerfile.studio:1-10`). That is a claim about the
   Cloudflare platform, **unverified** from this repository.
2. No Cloudflare credential inside the studio. This is a stated house rule
   given to every studio (`apps/fleet/src/studio/blueprint.ts:480-492`) and it
   matches the env list above.
3. Worker-side approvals for the Worker's own merge and deploy actions: only
   the operator's Telegram id can approve (`apps/fleet/src/approvals/gates.ts:46-52`),
   and the merge and deploy tokens are minted in the Worker, never in a
   container (`apps/fleet/src/approvals/gates.ts:160-176`).

The bring-up comment says bypassing prompts "widens nothing that reaches
production" (`apps/fleet/container/studio-bringup.sh:1506-1509`). That holds
for Cloudflare deploys. It does **not** hold for GitHub: the studio's own token
can merge a PR or move a branch directly, without the Worker's approval flow
(see below).

**Hooks are defense in depth, not a security boundary.** Both hook scripts say
so in their first line (`gates/lead-gate.sh:2`, `gates/completion-gate.sh:2`).
The lead gate's own "HONEST SCOPE" paragraph lists open write paths such as
`python3 -c`, `curl -o` and `git apply` (`gates/lead-gate.sh:80-100`). The
hooks live in `~/.claude/hooks`, which a root process can rewrite. The same is
true of the git wrapper that refuses pushes to the default branch: its own
comment names `gh pr merge`, `gh api` ref updates and calling
`/usr/bin/git` directly as uncovered (`apps/fleet/src/studio/credentials.ts:471-490`).
Treat all three as guard rails against mistakes, not against an adversary.
For a repo on `FLEET_WRITE_PROXY_REPOS` the push half of that gap is closed
server-side: the studio's token is read-only, so every push goes through the
Worker's write proxy, which refuses the default branch whatever path the push
took (`apps/fleet/src/write-proxy/git-route.ts`, issue #34). Unlisted repos keep
the wrapper as their only guard.
`memguard` is a memory watchdog and has no security role
(`apps/fleet/container/memguard.ts:1-11`).

## Egress and the top threat

**Egress is unrestricted.** The repository configures no egress control; a
search of `apps/fleet/src` finds no `enableInternet` setting, and the
`@cloudflare/containers` class (0.0.20, `apps/fleet/package.json:35`) defaults
it to `true` (`dist/lib/container.js:174` in that package). Studios
depend on it: they fetch `@playwright/mcp@latest` at runtime
(`apps/fleet/container/studio-bringup.sh:804`) and talk to GitHub.

**Tailscale.** Bring-up runs `tailscaled` in userspace networking mode and
`tailscale up --ssh` with the auth key
(`apps/fleet/container/studio-bringup.sh:230`, `:248`). Every studio joins the
operator's tailnet and accepts Tailscale SSH, as root. Tailnet ACLs are
outside this repository and **unverified**.

**The realistic top threat: prompt injection leading to exfiltration.** A
studio reads untrusted content all day: web pages in a browser, issue and PR
text, dependency READMEs, package install output. Text crafted to instruct
the agent can make it run a command. With no prompts, root, and open egress,
one such command can send every credential in the table above to an attacker.

| Mitigation | Status |
|---|---|
| No Cloudflare deploy credential in studios | Present |
| Worker-side approval for Worker-run merges and deploys | Present |
| Token scrubbing in Worker-side error text | Present (does not cover the raw archive) |
| One-hour lifetime on App installation tokens | Present, App path only |
| Egress allowlist | **Absent** |
| Least-privilege GitHub token per studio (per repo, narrowed permissions) | **Absent** |
| Claude token kept out of the model's reach | **Absent** |
| Ephemeral, scoped Tailscale key | **Recommended, not enforced** (docs/setup.md asks for an ephemeral key; the fleet cannot check key type) |
| Branch protection preventing direct merge with the studio token | Not configured by fleetflare; depends on your GitHub settings |

What a leak costs: the GitHub token (write to every repo it covers, until
expiry or revocation), the Claude account (usage billed to you), the Tailscale
key (a new device on your tailnet, until you revoke it), and the spawn token
(new studios under your Worker, up to `MAX_STUDIOS`, default 100,
`apps/fleet/src/env.ts:164-180`).

## Worker-side controls

| Surface | Authentication | Evidence |
|---|---|---|
| `POST /gh` (GitHub webhooks) | HMAC-SHA256 of the body with `GITHUB_WEBHOOK_SECRET`, constant-time compare; an unset secret rejects every delivery | `apps/fleet/src/github/webhook.ts:46-65`, `:535-540` |
| `POST /tg/<project>` (Telegram) | Secret-token header equals `TELEGRAM_WEBHOOK_SECRET` (plain string compare) | `apps/fleet/src/telegram/webhook.ts:26` |
| `/studio/*` (Mac CLI, board, memory) | Cloudflare Access. The Worker re-verifies the `Cf-Access-Jwt-Assertion` JWT itself (RS256 signature, `ACCESS_AUD` audience, expiry) rather than trusting the header | `apps/fleet/src/studio/auth.ts:135-171`, `apps/fleet/src/studio/routes.ts:296` |
| `/fleet/*` (studios calling back) | Per-studio spawn token, matched by hash against the registry; a studio may move only its own task, within a three-state allowlist | `apps/fleet/src/studio/spawn.ts:179-205`, `apps/fleet/src/board/board.ts:655-662` |
| `/health` | None | `apps/fleet/src/index.ts:77` |

## Mac side

The CLI reads `~/.fleet/credentials`, a JSON file holding the Worker URL and a
Cloudflare Access service token (client id and secret)
(`apps/fleet/cli/fleet.ts:62-97`). It sends them as `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers (`apps/fleet/cli/fleet.ts:145-146`). The
file is plaintext on disk. The CLI warns when its mode is looser than 600 but
does not refuse to run (`apps/fleet/cli/fleet.ts:80-91`). Anyone holding this
file can drive the whole fleet through `/studio/*`.

## Out of scope

- The security of Cloudflare's container isolation, GitHub, Anthropic and
  Tailscale themselves.
- A malicious operator. The operator is fully trusted.
- Code a studio writes and ships. Review and CI on your repositories are your
  control for that.

## Recommendations (not shipped)

Suggestions for operators and future work. None is implemented today.
1. **Narrow GitHub tokens.** Grant the App or PAT only the repos and
   permissions studios need, and request installation tokens with an explicit
   `repositories` and `permissions` body.
2. **Protect default branches** on every repo a studio can reach, so the
   studio token cannot merge without review.
3. **Add an egress allowlist** (GitHub, Anthropic, npm registry, Tailscale) so
   a prompt-injected command cannot post credentials to an arbitrary host.
4. **Use an ephemeral, tagged Tailscale key** and a tailnet ACL that limits
   what studios can reach and who can SSH into them.
5. **Separate accounts.** Run the fleet on a Claude account and a GitHub
   identity dedicated to it, so a leak does not expose your personal ones.
