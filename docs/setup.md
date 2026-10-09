# Setup

The full requirements list and the step-by-step first deploy, moved out of
the root [README.md](../README.md) so the front door stays short. Nothing
here is condensed from the original — every command, secret, and caveat is
verbatim. If you just want the fastest path to a first studio, the README's
own Quickstart links back here at the point you need it.

## Requirements

- **Cloudflare account** on a paid Workers plan, with Containers enabled
- **Bun** and **Wrangler** locally
- **Docker** (or a Docker-compatible daemon) running locally — a deploy
  builds this project's three container images (`Dockerfile`,
  `Dockerfile.deploy`, `Dockerfile.studio`, all under
  `apps/fleet/container/`, wired in the `containers` array of your own
  `wrangler.jsonc` — see **Quickstart from zero** below) before it can push
  any of them
- **A Claude Code OAuth token** — `claude setup-token`
- **GitHub access to your repos** — a fine-grained PAT (the default
  `apps/fleet/src/env.ts` falls back to, and the whole of what an adopter
  must bring) or a GitHub App installation (optional: org-scoped bot
  identity, higher rate limits)
- **Tailscale auth key** (optional; enables reaching a studio over your tailnet)
- **Cloudflare Access** in front of the Worker, since the terminal endpoint is a shell
- **Orca** (optional) — the editor that gives every running studio a sidebar
  row and an attach terminal. Without the `orca` binary, `fleet`/`ff` print
  one line saying so and carry on; attach from any terminal with
  `fleet attach <id>`.

### Optional, operator-specific features

Off unless their flag is exactly `"on"` in your own copy of the config (at
`$FLEET_CONFIG`, e.g. `$FLEET_OPS_DIR/fleet/wrangler.jsonc`) — not
`apps/fleet/wrangler.jsonc`, which is not tracked in this repo at all. Start
from `apps/fleet/wrangler.example.jsonc`, which has them all off and no
operator-specific values.

| Flag | What it turns on | Also needs |
|---|---|---|
| `FLEET_TELEGRAM` | the legacy Telegram surface: `/tg` webhook, AgentDO tasks, DeployDO approvals, operator alerts | secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; var `TELEGRAM_OPERATOR_ID` |
| `FLEET_DIRECTUS` | the Directus project card in studio prompts | `DIRECTUS_URL`, secret `DIRECTUS_TOKEN` |
| `FLEET_AUTO_FAILOVER` | automatic Claude-account switch on a usage limit | more than one `CLAUDE_CODE_OAUTH_TOKEN_<n>` |
| `FLEET_JUNIOR` | the junior skill (Workers AI delegation): studios get the skill and `/fleet/junior` answers | the "ai" binding; `JUNIOR_REPOS` optionally narrows to a comma list of owner/repo; `JUNIOR_RATE_PER_MINUTE` (default 5) and `JUNIOR_DAILY_CAP` (default 50) throttle each studio |

With `FLEET_TELEGRAM` off, AgentDO and DeployDO stay declared (removing a
Durable Object class needs a migration) but nothing reaches them, so their
containers never start.

On your own Mac, `fleet junior enable --account <id>` enables the junior
skill locally (a direct Workers AI call, not through the Worker); `fleet
junior disable` removes it.

A local maestro (your own Mac session, not a cloud studio) needs the
`maestro-playbook` skill symlinked once, the same single-source pattern
`fleet-cockpit` already uses (see `fleet/blueprint/README.md`): `ln -sfn
<this-checkout>/skills/maestro-playbook ~/.claude/skills/maestro-playbook`.
Unlike junior, there is no enable/disable toggle or account config for it —
once linked, it is just another skill your local Claude session reads.

---

## Quickstart from zero

This section walks a stranger through every resource fleetflare needs, in the
order you actually need them, ending with a real deploy.

Every env var name below is copied character-for-character from
`apps/fleet/src/env.ts`, the source of truth for what the Worker reads. If
anything here ever looks stale, that file wins.

Config placeholders below (`<...>`) refer to `apps/fleet/wrangler.example.jsonc`,
the public placeholder template committed in this repo. There is no
`wrangler.jsonc` tracked in this repo at all — your real, account-specific
config lives OUTSIDE it, in a private location only you control (for example
a checkout of your own ops repo, at `$FLEET_OPS_DIR/fleet/wrangler.jsonc`).
Copy the example there and fill in every `<YOUR_...>` placeholder as you work
through the steps below:

```bash
git clone https://github.com/<you>/fleetflare
cd fleetflare/apps/fleet
bun install

export FLEET_OPS_DIR="$HOME/fleetflare-ops"   # wherever your private ops-repo-shaped checkout lives; add this to your shell profile so it survives new terminals
mkdir -p "$FLEET_OPS_DIR/fleet"
cp wrangler.example.jsonc "$FLEET_OPS_DIR/fleet/wrangler.jsonc"
```

Every deploy and migration below runs through `apps/fleet/scripts/deploy.sh`
(wired up as `bun run deploy`, `bun run migrate:remote`, and `bun run
migrate:local`) — never a bare `wrangler deploy` or `wrangler d1 migrations
apply`. That script
reads `$FLEET_CONFIG` (default: `$FLEET_OPS_DIR/fleet/wrangler.jsonc`, the
file you just copied), copies it to a gitignored `wrangler.local.jsonc`
inside `apps/fleet/`, and only then runs `wrangler <subcommand> -c
wrangler.local.jsonc`. The copy step exists because wrangler resolves a
config's relative paths (this config's own `main`, and each container's
Dockerfile) relative to the directory the config file lives in — pointing
wrangler straight at your private checkout would resolve those paths there
instead of here. `scripts/deploy.sh` refuses loudly, before touching wrangler
at all, if `$FLEET_CONFIG` does not exist or still contains an unfilled
`<YOUR_` placeholder, so a copy-and-forget-to-fill-in mistake fails
immediately instead of deploying (or migrating) garbage. Remote-changing
`scripts/deploy.sh` runs (anything other than a known read-only command like
`whoami`, `tail`, `secret list`, or `d1 ... --local`) also refuse if the ops
checkout's `wrangler.jsonc` is untracked, has uncommitted changes, or is not
exactly at its upstream after a fetch — behind or ahead (issue #365, fixed by
#368). Commit, pull, and push the ops checkout first, or pass
`--allow-dirty-ops` to override, loudly. Set `FLEET_CONFIG` directly instead
of `FLEET_OPS_DIR` if your real config does not live inside an
ops-repo-shaped checkout.

### 0. Name your Worker

Pick your copied `wrangler.jsonc`'s (`$FLEET_CONFIG`) top-level `name`
(`wrangler.example.jsonc`'s own placeholder for it is `<YOUR_WORKER_NAME>`,
e.g. `"acme-fleet"`) before anything else below, because your Worker's public
address is DERIVED from it, not the other way around: a Worker named
`<name>` on Cloudflare account subdomain `<your-workers-dev-subdomain>`
answers at `https://<name>.<your-workers-dev-subdomain>.workers.dev`. Set
`WORKER_PUBLIC_URL` (step 5 below) to exactly that address once you know
your account's `*.workers.dev` subdomain (Cloudflare dashboard → Workers &
Pages → your subdomain is shown there). Changing `name` later changes the
address — and the GitHub webhook URL (step 3), `~/.fleet/credentials` (step
6), and the Cloudflare Access application (step 4) you configured against
the old one all break silently until you update every one of them to match.

### 1. Cloudflare D1 (the board/event-log database)

```bash
wrangler d1 create fleet
```

The output includes a `database_id` — a UUID. Put it in your copy of
`wrangler.example.jsonc`'s (at `$FLEET_CONFIG`) `d1_databases` entry:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "fleet", "database_id": "<YOUR_D1_DATABASE_UUID>", "migrations_dir": "migrations" }
]
```

Name the database `fleet` exactly as shown, not
`wrangler.example.jsonc`'s own `<YOUR_D1_DATABASE_NAME>`-style free-form
placeholder pattern: `apps/fleet/package.json`'s `migrate:local`/
`migrate:remote` scripts hardcode the literal name `fleet` when they call
`wrangler d1 migrations apply`, so a database named anything else will not
be found unless you also edit those two scripts.

The migrations in `apps/fleet/migrations/` (`0001_init.sql`, `0002_day2.sql`
today) apply with the project's own scripts, both wrapping
`apps/fleet/scripts/deploy.sh`: `migrate:remote` (`d1 migrations apply fleet
--remote`) and `migrate:local` (`d1 migrations apply fleet --local`, against
a local D1 for `wrangler dev`; `--local` is one of `deploy.sh`'s read-only
commands, so it is exempt from the dirty-ops-checkout guard below, but not
from the config checks that run before it).

Hold off on both `bun run migrate:local` and `bun run migrate:remote` for
now — both run through `scripts/deploy.sh`, exactly like `bun run deploy`
(see the deploy mechanism described above), which refuses while
`$FLEET_CONFIG` still has ANY unfilled `<YOUR_` placeholder, including ones
from steps you have not reached yet (the R2 bucket name in step 2,
`AGENT_REPO` in step 5) — even for `migrate:local`, which does not actually
need those values. Both are called out again, right before the first deploy
below, once every placeholder is filled in.

### 2. Cloudflare R2 (studio transcript/session archive)

```bash
wrangler r2 bucket create <YOUR_R2_BUCKET_NAME>
```

Wire the binding:

```jsonc
"r2_buckets": [
  { "binding": "STUDIO_ARCHIVE", "bucket_name": "<YOUR_R2_BUCKET_NAME>" }
]
```

This bucket holds raw, unscrubbed terminal bytes (transcripts and session
tarballs) — the same trust domain as attaching to a live studio session.
Scope R2 access to it accordingly; it is Worker-only, never public.

### 3. GitHub auth: fine-grained PAT (default) or GitHub App (optional)

`apps/fleet/src/env.ts`'s own header comment settles which path is primary:
"token — ... The DEFAULT, and the whole of what an adopter must bring." A
GitHub App is an optional upgrade (org-scoped bot identity, higher API rate
limits), never a prerequisite. Pick one path, or both:
`GITHUB_REPO_AUTH` (step 5) maps a provider per repo owner, so a fleet can
run a PAT for personal repos and the App for an org at the same time.

**Option A — fine-grained PAT (default, simplest)**

Create one at github.com → Settings → Developer settings → Personal access
tokens → Fine-grained tokens, scoped to the repo(s) you want the fleet to
touch. Minimum repository permissions, matching what this project's code
actually calls (`apps/fleet/src/github/api.ts`):

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | Reads/writes files and git refs/trees/commits (the Contents API also covers git data), clones and pushes |
| Issues | Read and write | Reads and comments on board tasks |
| Pull requests | Read and write | Creates, lists, reads commits on, and merges PRs |
| Workflows | Read and write | GitHub requires this beyond Contents to push a commit that touches `.github/workflows/*.yml` |
| Metadata | Read-only | Granted automatically on every fine-grained token; no action needed |

Store it as the `GITHUB_TOKEN` secret in step 5. A PAT carries no App-level
webhook config of its own, so you still need a repo (or org) webhook —
Settings → Webhooks → Add webhook — delivering the same events described
under **Webhook** below.

A fleet spanning more than one owner is not limited to one shared PAT: give
any owner its own token instead of `GITHUB_TOKEN` by storing it as
`GITHUB_TOKEN_<OWNER>` — uppercase the owner, every non-alphanumeric
character replaced with `_` (`acme-corp` → `GITHUB_TOKEN_ACME_CORP`), the
same naming rule step 8 below uses for `GITHUB_INSTALLATION_ID_<OWNER>`. Set
it with `scripts/deploy.sh secret put GITHUB_TOKEN_<OWNER>`; an owner with no
override falls back to the shared `GITHUB_TOKEN`
(`apps/fleet/src/github/auth.ts`'s `tokenEnvName`/`repoToken`).

**Option B — GitHub App (optional: org-scoped, higher rate limits)**

Create one at github.com → Settings → Developer settings → GitHub Apps → New
GitHub App (a personal account or an org can own it).

**Permissions** (repository), verified against what this project's own code
actually calls (`apps/fleet/src/github/api.ts`, `apps/fleet/src/github/app.ts`):

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | Reads/writes files and git refs/trees/commits (the Contents API also covers git data), clones and pushes |
| Issues | Read and write | Reads and comments on board tasks |
| Pull requests | Read and write | Creates, lists, reads commits on, and merges PRs |
| Workflows | Read and write | Same reason as the PAT above — pushing a `.github/workflows/*.yml` change needs it beyond Contents |
| Actions | Read-only | Needed to receive `workflow_run` webhook deliveries (see **Webhook** below). Not independently verified against a live installation — no code here calls the Actions API directly — but consistent with GitHub's own permission-to-event mapping |
| Metadata | Read-only | Granted automatically; no action needed |

**Webhook** (either path — the App's own webhook config, or a plain repo
webhook for the PAT path): set the webhook URL to `https://<your-worker>/gh`
and invent a webhook secret (you will store it as `GITHUB_WEBHOOK_SECRET`
below — GitHub never sees anything but the secret itself). Subscribe to at
least **Issues**, **Issue comments**, **Pull requests**, **Pushes**, and
**Workflow runs** (`workflow_run`) — `apps/fleet/src/github/wake-events.ts`'s
`WAKE_EVENTS` set (`issue_comment`, `issues`, `pull_request`, `workflow_run`)
wakes the maestro; `push` is handled by a separate path in the same webhook
handler, watched only for `main`/`staging` (the unapproved-write alarm), not
part of `WAKE_EVENTS`. "Send me everything" is a safe default if you would
rather not curate the list.

**Private key** (App path only): Settings → General → Private keys →
Generate a private key. GitHub hands you a PKCS#1 key (`-----BEGIN RSA
PRIVATE KEY-----`); this project's code only accepts PKCS#8 (Web Crypto has
no PKCS#1 support), and fails with an explicit instruction if you paste the
wrong format. Convert it yourself first:

```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out key-pkcs8.pem
```

Store the contents of `key-pkcs8.pem` (the whole PEM, including the
`BEGIN`/`END` lines) as the `GITHUB_APP_PRIVATE_KEY` secret in step 5.

Install the App on your account or org. `GITHUB_APP_ID` goes into
`wrangler.jsonc`'s `vars` (step 5 below, it is not a secret); the
installation id is its own topic — see step 8.

### 4. Cloudflare Access (in front of the Worker)

The terminal endpoint is a shell, so nothing under `/studio/*` should be
reachable without Access in front of it.

**Human login path**: Zero Trust dashboard → Access → Applications → Add an
application → Self-hosted. Scope it to your Worker's `/studio/*` path ONLY —
every other route authenticates itself and must stay outside the Access
app's scope, or its own caller gets a 401 from Access before your code ever
runs (`apps/fleet/src/index.ts`'s route table): `/gh` (webhook signature),
`/fleet/spawn`, `/fleet/tasks`, and `/fleet/memory` (all three by spawn
token — the one credential a container holds, never an Access service
token), and `/tg/<project-slug>` (Telegram's own secret header, checked
against `TELEGRAM_WEBHOOK_SECRET`). Add a policy (e.g. an email-domain allow
rule) to the `/studio/*` application. Note two values from the app's
Overview page:

- `ACCESS_TEAM_DOMAIN` — your team domain, e.g.
  `<your-team>.cloudflareaccess.com`. No scheme, no trailing slash.
- `ACCESS_AUD` — the Application Audience (AUD) tag.

**Service-token path (for the CLI / automated access)**: Zero Trust → Access
→ Service Auth → Create Service Token. Add it to the *same* Access
application's policy as an **Include → Service Auth** rule — a minted token
that is never added to the policy is accepted by nobody. The CLI
(`apps/fleet/cli/fleet.ts`'s `accessHeaders`) sends the token's client id and
secret as the `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers on
every request; see step 6 (`~/.fleet/credentials`) for where it lives
locally.

### 5. Secrets vs. vars

Non-secret configuration (repo names, ids that are not credentials, feature
flags) lives in `wrangler.jsonc`'s `vars` — see `AGENT_REPO`,
`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`/`GITHUB_INSTALLATION_ID_<OWNER>`,
`GITHUB_REPO_AUTH`, `WORKER_PUBLIC_URL`, `AGENT_BASE_REF`,
`MAX_TASK_SECONDS`, `BURN_ALERT_OUTPUT_TOKENS_5H`, `MAX_STUDIOS`,
`CLAUDE_ACCOUNT_BY_REPO`, `FLEET_AUTO_FAILOVER`, `FLEET_REQUIRE_ACCOUNT_MAP`, `AGENT_MODEL`,
`DIRECTUS_URL` in `env.ts`. Actual credentials never go in `wrangler.jsonc` —
they are set with `scripts/deploy.sh secret put <NAME>`, which prompts on
stdin (never pass a secret as a CLI argument). Use `scripts/deploy.sh`, never
a bare `wrangler secret put`: there is no `apps/fleet/wrangler.jsonc` tracked
in this repo for a bare `wrangler` invocation to find your Worker's name in,
so it fails with `Required Worker name missing`. The FIRST `secret put`
against a Worker that does not exist yet will prompt to create it as a draft
Worker — accept that prompt; the real deploy later in this walkthrough fills
the rest in.

`secret put`/`secret delete`/`secret bulk` skip the pre-deploy rescue gate
(issue #36). Measured on a throwaway Worker: plain `@cloudflare/containers`
`Container` DO, instance `lite`, one container (n=1). Each command deploys a
new Worker version and restarts the Durable Object; the container kept its
boot id. `StudioDO` extends `Sandbox`, not measured directly. The DO restart
still costs something: attached terminals (TerminalBridge) drop, in-flight
exec/rescue calls abort. Rotate secrets when no rescue or exec is running.
A secret copied into a container at start stays OLD there until it next
starts (`fleet recycle`).

`AGENT_REPO` deserves its own callout: set it to YOUR fork
(`<you>/fleetflare`, matching the `git clone` above), never to the upstream
repo you forked from (e.g. `your-org/fleet`) — it is the fleet's own repo,
the one `fleet.json` is read from and the default work repo a studio clones
when nothing else names one. Your fork's own `fleet.json` (committed at that
repo's root) carries its own `blueprint.repo` field, naming where
role/skill files are cloned from at provision time — a fresh fork's copy
names the upstream repo it was forked from, plus `ref`, `roles`, and
`instance_type`. For a first deploy, edit your fork's `fleet.json` so
`blueprint.repo` names that same fork — so `AGENT_REPO` and `blueprint.repo`
agree and both resolve to one repo you control — and repoint
`blueprint.repo` elsewhere later only if you split role definitions into
their own repo.

Every `secret put` below runs through `scripts/deploy.sh` too (see the
deploy mechanism described in this section's intro), so it is refused, same
as `bun run migrate:remote`/`migrate:local` above, while `$FLEET_CONFIG`
still has ANY unfilled `<YOUR_` placeholder — including ones from steps you
have not reached yet, like `GITHUB_INSTALLATION_ID` in step 8. This
placeholder check runs before any command-specific handling, so it applies
even to `whoami`/`secret list`/`d1 ... --local`: finish filling in every
placeholder in `$FLEET_CONFIG` before running any `scripts/deploy.sh`
command, including the ones below.

```bash
export CLOUDFLARE_ACCOUNT_ID=<YOUR_CLOUDFLARE_ACCOUNT_ID>

scripts/deploy.sh secret put CLAUDE_CODE_OAUTH_TOKEN     # `claude setup-token`
scripts/deploy.sh secret put GITHUB_WEBHOOK_SECRET       # invented in step 3
scripts/deploy.sh secret put GITHUB_APP_PRIVATE_KEY      # the PKCS#8 key from step 3, App path only
scripts/deploy.sh secret put ACCESS_TEAM_DOMAIN          # from step 4
scripts/deploy.sh secret put ACCESS_AUD                  # from step 4
scripts/deploy.sh secret put TS_AUTHKEY                  # optional, see below
scripts/deploy.sh secret put GITHUB_TOKEN                # the default auth path (step 3), unless you use the GitHub App instead
scripts/deploy.sh secret put FLEET_OPS_REPO              # optional, see below — not secret-shaped, but survives every deploy this way
scripts/deploy.sh secret put TELEGRAM_BOT_TOKEN          # optional, only with FLEET_TELEGRAM="on" — see Telegram below
scripts/deploy.sh secret put TELEGRAM_WEBHOOK_SECRET     # optional, only with FLEET_TELEGRAM="on" — see Telegram below
scripts/deploy.sh secret put CLOUDFLARE_DEPLOY_TOKEN     # optional, only for the legacy Telegram deploy-approval gate — see step 7
scripts/deploy.sh secret put DIRECTUS_TOKEN              # optional, only with FLEET_DIRECTUS="on"
```

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are secrets, not vars, even though
neither is secret-shaped (a hostname and a tag are not credentials) — a
committed `vars` entry of the same name collides with a same-named secret at
deploy time, so the running fleet keeps both as secrets exclusively.

`TS_AUTHKEY` (Tailscale) is optional and enables reaching a studio over your
tailnet. Use a **reusable, ephemeral** auth key. Every studio container
joins the tailnet as a new node, and destroy/recycle never removes it: with a
non-ephemeral key, offline nodes pile up until the tailnet's device quota is
full (issue #189). An ephemeral node is removed automatically once offline.
Changing key type is an operator step — create the new key in the Tailscale
admin console, then `scripts/deploy.sh secret put TS_AUTHKEY`. If the quota is
already full, remove offline machines in the Tailscale admin console.

A failed `tailscale up` (bogus key, full quota, tailnet outage) does NOT stop
bring-up: the studio comes up without a tailnet, `bringup.log` records
`tailscale-up FAILED (...)`, and `fleet ls` READY reads
`provisioned (tailnet: quota reached)` or `provisioned (tailnet: down)`.
`fleet attach` goes through the Worker and keeps working. Leaving the key
unset is still the safe, supported state.

**`FLEET_OPS_REPO`** (optional; not to be confused with `FLEET_OPS_DIR` above
— that one is a local filesystem path `scripts/deploy.sh` reads on your own
machine, this one is a Worker setting): the `owner/name` slug of a private
repo you control (e.g. `<you>/fleetflare-ops`), unrelated to your fork of
this repo, that can also hold other operator-only config. Set it once with
`scripts/deploy.sh secret put FLEET_OPS_REPO` (it is not secret-shaped, but
this keeps it out of the committed public config and lets it survive every
deploy). It carries two independent, opt-in features:

- **Harvested memory** — when a studio is recycled or destroyed, the fleet
  harvests the learnings it recorded to `fleet/memory/` in that repo instead
  of anywhere in the public one. The index is read from that repo's default
  branch, and each studio gets a copy at `/opt/memory`.
- **A house-rules overlay** — a `house-rules.md` file at that repo's root,
  appended to every studio's neutral default house rules.

Leave `FLEET_OPS_REPO` unset and both features simply stay off: studios get
the neutral defaults only, `fleet memory` answers that memory is off, and
there is no error and nothing to configure. Set it and forget to create one
of the two files, and that one feature alone degrades gracefully (an empty
memory index, no overlay text) rather than breaking provisioning. The GitHub
App or token must be able to read and write that repo (private is fine). See
`apps/fleet/src/ops-repo.ts` for exactly how the slug is validated, and
`apps/fleet/src/studio/provision.ts` / `apps/fleet/src/memory/store.ts` for
how each feature reads from it.

**Leak gate** (always on; issue #1): a studio whose work repo is public, or
whose visibility cannot be confirmed, refuses any `git push` or `gh`
issue/pr/api/release/gist write whose text matches a private denylist. The
Worker applies the same check to every board task and comment it posts to a
repo that is not confirmed private. The denylist is `public-denylist.txt` at the root
of the `FLEET_OPS_REPO` repo: one extended regex per line, matched
case-insensitively. It is never committed to this repo. Fail closed: with no
`FLEET_OPS_REPO`, no file, an empty file or an invalid pattern, every such
write is refused. A refusal names the pattern's line number, never the term.
A studio whose work repo is private gets the gate switched off. See
`apps/fleet/src/leak-gate.ts`.

**Write proxy** (off by default, per repo; issue #7): the wrappers above run
inside the container, and container root can step around them. For a work repo
listed in `FLEET_WRITE_PROXY_REPOS` (a `vars` entry, comma-separated
`owner/name`), its studios hold a **read-only** GitHub credential, and its writes go through the Worker instead: `git push` is
rewritten (`pushInsteadOf`) to `/fleet/git/...`, which parses the pack, scans
every ref name, commit, tag, file and path against the same denylist, and only
then forwards the identical bytes to GitHub with the Worker's own token; `gh pr
create|edit|ready|comment|review` and `gh issue create|edit|comment` go to
`/fleet/gh` the same way. Other `gh` writes fail at GitHub (the token cannot
write). Pushes over 16 MiB are refused; split them. The proxy also refuses any
update, force-push or delete of the repo's default branch (issue #34), read
from GitHub and cached for 5 minutes; if it cannot be read, every push to that
repo is refused. Studios land changes through PRs. To let a repo's default
branch be pushed through the proxy anyway, list it in
`FLEET_WRITE_PROXY_DEFAULT_BRANCH_REPOS` (a `vars` entry, comma-separated
`owner/name`); nothing in a request can lift it. Operator setup:

- GitHub App fleets: nothing. The studio's token is narrowed to read at mint time.
- PAT fleets: `scripts/deploy.sh secret put GITHUB_READ_TOKEN` with a read-only
  fine-grained PAT (`GITHUB_READ_TOKEN_<OWNER>` per owner, like
  `GITHUB_TOKEN_<OWNER>`). Without one, studios read their public repo
  anonymously (low `gh` rate limits); the write PAT never reaches them.
  The read PAT also needs read access to a private blueprint or ops repo.
  PAT studios on a private repo are proxied too: a PAT can write every repo
  of its owner. Rotate the write PAT once deployed: earlier studios held it.
- Rescue to `FLEET_RESCUE_REMOTE` needs that repo to be private; PAT fleets
  also set `FLEET_RESCUE_GITHUB_TOKEN` (a PAT that can write only that repo).
  Otherwise rescue goes to origin through the proxy.
- Restart running studios after deploying (new image, new credential).
- Unset or unlisted = the pre-proxy behaviour: deploying changes nothing until
  a repo is listed. Removing a repo hands its studios their write credential
  again at the next refresh. See `apps/fleet/src/write-proxy/`.

**`FLEET_RESCUE_REMOTE`** (optional, strongly recommended when your fork is
public): the `owner/name` slug of a PRIVATE repo that receives rescue
pushes (`fleet/rescue/*` and friends) instead of `origin`, for studios whose
work repo is PUBLIC only. A private work repo, or one whose visibility check
fails, always rescues to its own `origin`. Set it with
`scripts/deploy.sh secret put FLEET_RESCUE_REMOTE`. The GitHub App or token
must be able to write that repo. Unset (or if the token mint fails), rescue pushes go to `origin` through
the leak gate: a denylist hit, or no denylist at all, refuses that rescue and
the work is lost at teardown. The Worker logs this loudly on every rescue.
The next provision of the same studio lists and fetches its rescue branches
from the same place: `origin` first, then this remote when rescue would use
it. A branch name on both with different commits keeps `origin`'s under its
name and fetches this remote's as `<name>-rescue-remote`. If this remote
cannot be listed, provision logs a WARNING and keeps `origin`'s results.

**Telegram** (optional, off by default): the legacy `/tg` webhook, AgentDO
tasks, DeployDO deploy approvals, and operator chat alerts all run only when
the `FLEET_TELEGRAM` var (in your `wrangler.jsonc`'s `vars`, not a secret) is
set to exactly `"on"` **and** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
and `TELEGRAM_OPERATOR_ID` are all configured — any one missing, and the
whole surface is off, silently and safely (`apps/fleet/src/agents/registry.ts`'s
`telegramConfig`). Leave `FLEET_TELEGRAM` unset (the public template's
default) to skip Telegram entirely; nothing below is needed for a first
deploy. To turn it on:

1. Create a bot with [@BotFather](https://t.me/botfather) (`/newbot`); it
   hands you the token for `TELEGRAM_BOT_TOKEN`.
2. Invent your own webhook secret for `TELEGRAM_WEBHOOK_SECRET` (same rule as
   `GITHUB_WEBHOOK_SECRET` above — you choose it; Telegram only echoes it
   back on every delivery for `handleTelegramWebhook` to check).
3. Find your own numeric Telegram user id from
   [@userinfobot](https://t.me/userinfobot) and set it as the
   `TELEGRAM_OPERATOR_ID` var — the one sender `/tg` obeys, the one chat every
   alert goes to.
4. Once you have `WORKER_PUBLIC_URL` (step 0 above), point the bot's webhook
   at your deployed Worker with Telegram's own `setWebhook` API:
   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://<your-worker>/tg/<project-slug>" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
5. `<project-slug>` there is not a user id — it must match a `project` field
   in the `AGENTS` array in `apps/fleet/src/agents/registry.ts`
   (`agentForProject` looks it up by exact string match against an entry with
   `role: "cto"`). Today that array has one entry, `project: "websites"`, so
   `/tg/websites` is the working URL until you add more agents; a numeric id
   there would never match and the webhook would be silently ignored.
6. Set `FLEET_TELEGRAM="on"` in your `wrangler.jsonc`'s `vars` alongside the
   three secrets above.

**`FLEET_DIRECTUS`** (optional, off by default, same shape as Telegram): set
to exactly `"on"` plus `DIRECTUS_URL` (a var) and `DIRECTUS_TOKEN` (a secret)
to turn on the Directus project card in studio prompts
(`apps/fleet/src/directus/client.ts`'s `directusConfig`). Off — the public
template's default — means no card and no calls to Directus at all.

### 6. `~/.fleet/credentials` (your machine, not the Worker)

The CLI (`fleet`/`ff`) reads this file locally to reach your deployed Worker.
Exact shape, from `apps/fleet/cli/fleet.ts`:

```bash
mkdir -p ~/.fleet
cat > ~/.fleet/credentials <<'JSON'
{"workerUrl":"https://<YOUR_WORKER_NAME>.<YOUR_WORKERS_DEV_SUBDOMAIN>.workers.dev",
 "accessClientId":"<SERVICE_TOKEN_CLIENT_ID>.access",
 "accessClientSecret":"<SERVICE_TOKEN_CLIENT_SECRET>"}
JSON
chmod 600 ~/.fleet/credentials
```

All three keys (`workerUrl`, `accessClientId`, `accessClientSecret`) are
required; the CLI refuses to run without them and warns (but does not block)
if the file is readable by anyone but you. `workerUrl` is the address
`bun run deploy` prints once you've deployed (see below) — fill this file in
now with what you already know (the service token from step 4), and confirm
`workerUrl` once you have it. Verify with `fleet ls` — it must list studios,
not fail with 401/403.

### 7. `CLOUDFLARE_DEPLOY_TOKEN` (optional)

This is **not** what deploys fleetflare's own Worker — that always goes
through `scripts/deploy.sh` on your own machine (see **Quickstart from
zero**'s intro above), which never touches this token at all. This secret
exists for one narrower, opt-in feature: the legacy Telegram deploy-approval
gate (`apps/fleet/src/approvals/gates.ts`'s `deploy_staging`/`deploy_prod`
actions), where an operator approves a deploy over Telegram and the Worker
itself then executes a *pre-registered* command — a row in a D1
`deploy_targets` table, looked up by id, never substituted or improvised
(`apps/fleet/src/deploy/targets.ts`'s `getDeployTarget`) — against some other
project the fleet manages. That gate refuses outright with `FLEET_TELEGRAM`
off ("deploy gate needs Telegram"), so this token is only worth setting once
Telegram (above) is already on and you intend to register at least one
deploy target for the gate to run.

If you only want fleetflare deploying itself, or you are happy running every
deploy by hand, skip this entirely — leaving it unset breaks nothing.

When you do use it: this token is a Cloudflare API token — the same kind of
credential `wrangler` itself reads as `CLOUDFLARE_API_TOKEN` — but it is
handed **only** to the Worker-side deploy container (`DeployDO`), never to a
studio/agent container. That split is a standing security rule in this
project: no studio ever holds a Cloudflare deploy credential, so a lead
asked to `wrangler deploy` or run `d1 migrations apply --remote` itself is
expected to refuse and say so — a deploy the gate can perform happens
through the Worker's own approval path, on this token, and everything else
(including fleetflare's own deploy) happens by the operator directly,
through `scripts/deploy.sh`.

Minimum scope: equivalent to Cloudflare's built-in "Edit Cloudflare Workers"
API token template (Account → Workers Scripts: Edit, Account Settings: Read;
add D1: Edit if the same token also runs `d1 migrations apply --remote`, and
Zone → Workers Routes: Edit only if the Worker is routed to a custom domain
rather than `*.workers.dev`). This has not been verified against a live
Cloudflare account — treat it as a starting point and narrow it if your
deploy command turns out to need less.

Exact mechanism it takes to reach a running deploy
(`apps/fleet/src/deploy/do.ts`, `DeployDO.envVars`): the token is injected as
a container **environment variable at container start** (the
`@cloudflare/containers` library's own hook, not a per-request header), so it
sits in `process.env` for the whole life of that one deploy container
(`apps/fleet/container/deploy-server.ts`) and is forwarded into every command
you register for a deploy target. `wrangler` itself reads
`CLOUDFLARE_API_TOKEN`, not `CLOUDFLARE_DEPLOY_TOKEN` — the names are
deliberately different, so a studio grepping its own environment for a
Cloudflare credential finds nothing named what `wrangler` expects — so the
deploy `command` string you register for a target must bridge the two
itself, e.g.:

```bash
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_DEPLOY_TOKEN" wrangler deploy
```

```bash
scripts/deploy.sh secret put CLOUDFLARE_DEPLOY_TOKEN
```

### 8. `GITHUB_INSTALLATION_ID_<OWNER>` — one installation id per owner

A GitHub App installs **per account** (an org or a user), not once globally.
If your fleet only ever touches repos under one owner, the shared
`GITHUB_INSTALLATION_ID` var is enough. The moment it needs to reach a
*second* owner (another org, or a personal account), that owner needs its
own installation id, named by uppercasing the owner and replacing every
non-alphanumeric character with `_` (`apps/fleet/src/github/app.ts`'s
`installationEnvName`):

```
acme-corp    -> GITHUB_INSTALLATION_ID_ACME_CORP
widgets-inc  -> GITHUB_INSTALLATION_ID_WIDGETS_INC
```

Find an owner's installation id from the installation's settings page in the
GitHub UI — your App's settings → Install App → the account → the resulting
installation settings page's URL carries the id
(`github.com/settings/installations/<ID>` for a personal account,
`github.com/organizations/<org>/settings/installations/<ID>` for an org). For
an org you own, `gh api orgs/<owner>/installations` also works with an
ordinary admin token; its personal-account equivalent
(`gh api users/<owner>/installation`) needs a GitHub App JWT you will not
have set up at this point in the walkthrough, so use the UI path instead for
a personal account. These are not secrets — an installation id is not a
credential — so they belong in your config's `vars`, not in
`scripts/deploy.sh secret put`. A per-owner id, when set, always wins over
the shared `GITHUB_INSTALLATION_ID` for that owner; an owner with neither set
falls back to the `GITHUB_TOKEN` PAT path if one is configured.

At this point every secret and var from steps 1–8 should be set. One optional
piece remains before the first real deploy below: a second Claude account, if
you want one.

### Claude accounts

One Claude account caps every studio at once. A second account can carry
chosen repos. Add it in **your own terminal**; no one else ever sees the
token:

```bash
claude setup-token                                            # log in as the second account
scripts/deploy.sh secret put CLAUDE_CODE_OAUTH_TOKEN_2         # paste the token when asked
```

Then map repos to it with the non-secret var `CLAUDE_ACCOUNT_BY_REPO`, JSON
keyed by the repo part of a studio id (`<repo>--<role>`):

```jsonc
// wrangler.jsonc "vars", or a dashboard variable
"CLAUDE_ACCOUNT_BY_REPO": "{\"acme-app\": 2}"
```

- **Key format:** the studio-id repo prefix — the bare repo name, lower case,
  as it appears before `--` in `fleet ls` (`acme-app` for studio
  `acme-app--lead`). Never `owner/repo`: such a key can never match and is
  dropped with a warning in the Worker log.
- Unmapped repos launch on the account with the most headroom, by fresh
  `fleet accounts sync` usage rows, kept off other repos' mapped slots while
  any other account is set. With no fresh usage, the first account that is
  set, in slot order (normally `CLAUDE_CODE_OAUTH_TOKEN`).
- `fleet spawn` and `fleet provision` print the account a studio launched on
  and why, on stderr after the table: `mapped (...)`, or
  `UNMAPPED, fell back to slot N — add "<repo>": <slot> to
  CLAUDE_ACCOUNT_BY_REPO`.
- **Strict mode:** `FLEET_REQUIRE_ACCOUNT_MAP=on` refuses to launch a studio
  whose repo has no key, with the reason (and the exact key to add) on its
  `fleet ls` row. It applies to every launch, so map existing repos first:
  an unmapped studio's next provision, restart, recycle or container start
  is refused too.
- A repo mapped to a slot whose secret is not set **refuses to launch**, with
  the reason on its `fleet ls` row. It never falls back to another account.
- Optional labels tell accounts apart in `fleet ls` and alert cards:
  `CLAUDE_ACCOUNT_2_LABEL=second@example.com` shows
  `second@example.com (CLAUDE_CODE_OAUTH_TOKEN_2)`. A label is not a
  credential.
- **Auto-failover is off** unless `FLEET_AUTO_FAILOVER=on`. Off, a studio that
  hits its limit is marked `degraded` and carded once, and is never switched.
  An account an earlier failover recorded is then ignored: the next launch
  uses the map and clears it.
- A studio's account is fixed when its container starts. To move a running
  studio after a map change, `fleet recycle <id>` it between tasks.

### Proactive account-limit sync (claude-swap)

Fleet only LEARNS a limit reactively today — a pane shows the modal, a row
gets marked `dead`, and that row can stay stale (reinstated account, nobody
cleared it) until hand-deleted. `cswap` (claude-swap, MIT) holds account
logins on YOUR Mac and reports real usage per account; `fleet accounts sync`
reads that and writes/clears fleet's own limit rows BEFORE a modal ever
shows.

Setup, on your own Mac, once per account:

```bash
uv tool install claude-swap
cswap add                 # logs in interactively; run once per account
```

**Never run `/logout` first.** It revokes the refresh token `cswap` needs —
log in fresh instead, or add an account `cswap` already holds a login for.

Labels are optional. Label a slot with the matching email, so sync joins it
by exact match:

```jsonc
"CLAUDE_ACCOUNT_2_LABEL": "second@example.com"
```

Must equal the email `cswap list` reports for that login, exact string, case
sensitive. Unlabelled slots are not stuck `unmanaged` forever, though:
reset-time inference covers them whenever BOTH a usage reading and a
recorded reset already exist — the slot's own currently-recorded reset time
(`fleet ls`'s limited-until) is matched against an unclaimed cswap account's
own `fiveHour`/`sevenDay` reset, within +/-5min, only when exactly one
candidate qualifies. No label and no reset to match against yet = that slot
reads `unmapped`, sync skips it, no row touched. `fleet accounts
--write-labels` prints a pasteable `CLAUDE_ACCOUNT_<n>_LABEL=<email>` line
for every slot it resolved by inference, so a label can be made explicit
once seen — it only prints suggestions, it never writes config itself.

Run it:

```bash
fleet accounts                # table: slot, label, match (label/inferred/unmapped/cswap-missing), 5h%, 7d% usage, reset, row state (D1 now), would (what sync would change) — READ ONLY, writes nothing
fleet accounts --write-labels # same, plus pasteable CLAUDE_ACCOUNT_<n>_LABEL=<email> suggestions for inferred slots (folds into --json's own object instead of a bare line when combined with --json)
fleet accounts sync           # same read, then WRITES: posts limit/clear decisions to fleet; reports applied/rejected/skipped
fleet accounts sync --watch   # loops every 60s, prints only on change, ctrl-c stops
```

Rule: pct >= 95 on EITHER the 5h window, the 7d window, OR any per-model
window marks that slot limited until THAT window's own reset time.
Everything under 95 clears the slot — including a stale `dead` row: a fresh
low reading right after re-login IS fleet's proof the account is alive
again, no separate check. A slot can also read `no data` instead of
`unmanaged`: that means a real cswap account WAS found for it (labelled or
inferred), but its own reading can't be trusted right now (relogin
required, or the reading itself is stale) — distinct from `unmanaged`
("we don't know which account this is at all"). Neither ever writes a row.
`cswap` missing or erroring never crashes any of this — every slot just
reads match `cswap-missing` and the command still runs.

Deploy — from `apps/fleet`, with `$FLEET_CONFIG` (or `$FLEET_OPS_DIR`) already
pointing at your filled-in `wrangler.jsonc` copy (see **Quickstart from
zero**'s intro above). Run the migrations held back from step 1 now too,
since every placeholder they needed (the R2 bucket name in step 2,
`AGENT_REPO` in step 5) is filled in:

```bash
bun run migrate:local    # apps/fleet/migrations/ against a local D1 for `wrangler dev`, via scripts/deploy.sh
bun run migrate:remote   # apps/fleet/migrations/ against your real D1, via scripts/deploy.sh
bun run deploy --allow-unrescued   # FIRST deploy only (see below): scripts/deploy.sh -> wrangler deploy -c wrangler.local.jsonc
```

**Why `--allow-unrescued` the first time:** `bun run deploy` gates itself
(issue #20). Before a container-replacing command it runs `fleet rescue-all`,
which needs a live Worker and `~/.fleet/credentials` to list studios. Before
the first deploy neither exists, so the gate fails closed. No studio runs
yet, so nothing can be lost. The flag is consumed by `deploy.sh`, never
passed to wrangler, and prints a loud WARNING. Every later deploy: plain
`bun run deploy`.

Install the CLIs, then point `~/.fleet/credentials` (step 6 above) at the
worker address `bun run deploy` just printed and confirm it end-to-end:

```bash
bun link            # from apps/fleet — provides `fleet` and `ff`
fleet ls            # must list studios (even zero of them), not 401/403
```

Then provision your first studio — see "Daily use" in the [README](../README.md)
for the CLI commands. A `degraded` response's `error` field names which step
failed (blueprint fetch, clone, or bring-up) and is already secret-scrubbed.

Every *subsequent* `bun run deploy` rescues first (issue #20): before any
command that replaces the studio containers (a bare deploy, `deploy` without
`--dry-run`, `versions deploy`, `rollback`, `delete`, `containers delete`),
`scripts/deploy.sh`
runs `fleet rescue-all` and refuses if it exits non-zero — `rescue-all
reported FAILED -- pre-deploy gate UNSAFE`. See [docs/operations.md](operations.md)
("Things that will bite you"). Read-only commands and `d1 migrations` never
run it. First the gate checks target (issue #36): `rescue-all` rescues the
fleet `~/.fleet/credentials` names, wrangler replaces the Worker the config
names (plus `--env`/`-e`, `CLOUDFLARE_ENV`, `--name`). `scripts/deploy-target.ts`
reads the config with the pinned wrangler's own reader. The credentials host
must EXACTLY equal one of that Worker's route/custom-domain hosts (a wildcard
route proves nothing), or `<worker-name>.<subdomain>.workers.dev` where
`<subdomain>` is the DEPLOYING account's own (issue #48: a read-only lookup
via `wrangler whoami`/`wrangler auth token` and the Cloudflare API; needs
network and a logged-in wrangler; set `CLOUDFLARE_ACCOUNT_ID` when the login
sees several accounts). Mismatch
refuses, naming both. Undeterminable target refuses too: no credentials,
unknown env, a second `-c`/`--config`, `--cwd`, `--env-file`, inline short
flags (`-e=prod`, `-eprod`; write `-e prod`), `WRANGLER_CI_OVERRIDE_NAME`, a
`CLOUDFLARE_*`/`WRANGLER_*` var in `apps/fleet/.env`, `.env.local`,
`.env.<env>`, `.env.<env>.local` (wrangler loads them), an unknown flag
between `delete` and the Worker name, and every `containers delete` (a
container app id names no Worker). To deploy another fleet, point
`~/.fleet/credentials` at it first. Pass
`--allow-unrescued` later only after reading the FAILED rows and accepting
the loss of that work. Never call a bare `wrangler deploy`: it skips the gate.

Issue #40: a Worker-only `deploy` does not need the flag. When rescue-all
fails, `scripts/deploy-containers-changed.ts` builds each container image as
wrangler will and compares it with the deployed container application
(`wrangler containers list`/`info`, read-only): same registry digest, same
`max_instances`/`instance_type`, and the same logs setting wrangler derives
from the Worker's top-level `observability` -> no container is replaced, the failure is a
WARNING, the deploy proceeds. An image or settings change, a first deploy, or
anything it cannot tell (no docker, offline, a container key it does not
compare, top-level `unsafe`, a DO migration deleting/renaming/transferring a
container class) stays refused. Only `deploy`, `-e`/`--env` and `--profile`
qualify; any other flag keeps the gate hard. The probe needs docker and a logged-in wrangler; an
image never pushed from this machine counts as changed. Every override
(`--allow-unrescued`, or that Worker-only pass) appends one JSON line to
`~/.fleet/deploy-overrides.jsonl`: time, command, target Worker, target
check, rescue-all verdict, operator (git `user.name`, else `$USER`). Flag
values are never recorded (`--var`, `--define`, `--secrets-file` may carry
secrets): flag names only, plus the `-e` env.
