<div align="center">

# Fleetflare

### 🚀 Run coding agents as long-lived cloud studios, not laptop processes.

![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)
![CLI](https://img.shields.io/badge/cli-Bun-000000)
![CI](https://github.com/rafarc21/fleetflare/actions/workflows/fleet-check.yml/badge.svg)

</div>

Each **studio** is a Cloudflare Container running one Claude Code session —
the **lead** — plus the member subagents it dispatches, wired to a **GitHub
Issues board**: work arrives as an issue, the studio reports back with a
comment on that same issue, and there's no separate dashboard to keep in
sync.

**What you get:**

- ☁️ **A cloud studio, not a laptop process** — survives a closed laptop, a
  lost network, and a reboot, and costs zero local RAM while it works.
- 🗂️ **Your GitHub Issues board as the only dashboard** — a studio picks up
  work as an issue and reports back on that same issue, so there is nothing
  new to keep in sync.
- 👀 **Total visibility, nothing spent in the dark** — `fleet ls` lists every
  running studio, its readiness, and its burn, live from your terminal.

A studio's id is `<repo>--<role>` — say hello to `fleet ls`:

```
$ fleet ls
ID                          STATE      READY                 BURN
acme-site--maestro          running    provisioned           12400o/5h:3100
acme-site--web-studio       running    provisioned           8200o/5h:1900
acme-docs--release-studio   degraded   bare: no session       0o/5h:0
```

(Trimmed for readability — the real table has more columns too: REPO,
SESSION, ACTIVITY, ACCOUNT, HOST, ERROR. BURN reads `<cumulative output
tokens>o/5h:<tokens in the current 5h bucket>`.)

**Status:** Fleetflare runs a real fleet daily across several repositories.
It is not a turnkey product — it assumes Cloudflare, GitHub, Claude Code, and
an editor that can host terminals, and expects you to read code when
something surprises you. [docs/operations.md](docs/operations.md) tells you
which surprises to expect first.

---

## ✨ Features

- ☁️ **Cloud-native, not laptop-bound.** Local agents are bounded by local
  RAM — measured on a 24 GB machine: 84 worktrees, 135 node/claude
  processes, 7.2 GB resident, and everything slows down together. A cloud
  studio costs zero local memory and keeps running through a closed laptop
  or a reboot.
- 👀 **Visible by default.** The tradeoff of moving work off your screen is
  honest, so every running studio gets a visible row and a live terminal (in
  [Orca](docs/setup.md#requirements) or plain `fleet ls`/`fleet attach`), and
  nothing spends money where you cannot see it.
- 🙅 **Leads never implement.** A PreToolUse hook refuses a lead's
  `Edit`/`Write` and its file-writing Bash forms, so implementation is always
  dispatched to member subagents — enforced in code, not asked for in a
  prompt.
- 🧯 **Rescue-first lifecycle.** `fleet recycle` and `fleet destroy` rescue
  uncommitted work to its own branch before touching a container, and refuse
  outright if that rescue is impossible (loudly overridable, never silent).
- 🎭 **A role per job.** `maestro` coordinates and never implements;
  `web-studio` and `release-studio` carry members; `pilot` and `scratch` are
  lightweight. One studio per role per repo — parallelism beyond that comes
  from the members inside each studio.
- 🤖 **Optional extras when you want them.** Delegate mechanical edits to a
  Workers AI model with the opt-in `junior`/GLM skill, or let a studio that
  hits its Claude usage limit fail over to the next configured account with
  `FLEET_AUTO_FAILOVER=on`. Both off by default. See
  [docs/setup.md](docs/setup.md).

### Key concepts

| Concept | What it means |
|---|---|
| **studio** | One Cloudflare container running one Claude Code session (the lead) plus the member subagents it dispatches. |
| **lead** | The Claude Code session in a studio's tmux window 0. Never implements directly — a hook forces it to dispatch to members. |
| **maestro** | The role that coordinates a repo's work and never implements; one of the roles alongside `web-studio`, `release-studio`, `pilot`, `scratch`. |
| **board** | The GitHub Issues in your target repo. Labels are the state machine work moves through. |
| **rescue** | Before any deploy that replaces containers, `fleet rescue-all` commits and pushes every studio's uncommitted work to its own `fleet/rescue/...` branch so nothing is lost. See [docs/operations.md](docs/operations.md). |
| **junior / GLM** | The opt-in `FLEET_JUNIOR` skill: studios can delegate mechanical, low-risk edits to a Workers AI model (GLM) and review its diff before applying. See [docs/setup.md](docs/setup.md). |
| **account failover** | With `FLEET_AUTO_FAILOVER=on`, a studio that hits its Claude usage limit switches to the next configured `CLAUDE_CODE_OAUTH_TOKEN_<n>` automatically. Off by default. See [docs/setup.md](docs/setup.md). |
| **leak gate** | Always on: a studio whose work repo is public (or unconfirmed) refuses any push or `gh` write matching a private denylist. |

## 🧠 How it works

| Piece | What it is |
|---|---|
| **Worker** | The brain. HTTP routes, a one-minute cron, the GitHub webhook. |
| **StudioDO** | One Durable Object per studio. Holds its token, schedules its ticks, talks to its container. |
| **Container** | Ubuntu with tmux, git, `gh`, Bun, Chrome for Testing, and the Claude Code CLI. The lead lives in tmux window 0. |
| **Board** | GitHub Issues in the *target* repo. Labels are the state machine. |
| **Blueprint** | Role definitions and skills, cloned from this repo into the container at provision time. |

```mermaid
flowchart LR
    Issue["GitHub Issue<br/>(the board)"] -->|webhook| Worker
    Worker -->|spawns / wakes| StudioDO["StudioDO<br/>(one per studio)"]
    StudioDO -->|runs| Container["Container<br/>tmux + Claude Code lead"]
    Blueprint["Blueprint repo<br/>(roles & skills)"] -->|cloned at provision| Container
    Container -->|comments envelope| Issue
```

A studio's id is `<repo>--<role>`, for example `acme-site--web-studio`. That
id is an address: it becomes a DNS label, a board assignment label, and the
registry key. Dots and underscores in a repo name fold to hyphens.

## 🚀 Quickstart

There is one real path here: deploy your own Worker to your own Cloudflare
account. How long that takes depends on how many of the pieces below you
already have on hand, not on the length of this guide.

**Prerequisites**

- [ ] A Cloudflare account
- [ ] A GitHub personal access token (a fine-grained PAT is the default)
- [ ] A Claude Code OAuth token
- [ ] [Bun](https://bun.sh) installed locally

**1. Clone and install**

```bash
git clone https://github.com/<you>/fleetflare
cd fleetflare/apps/fleet
bun install
```

**2. Point at your ops checkout**

```bash
export FLEET_OPS_DIR="$HOME/fleetflare-ops"   # wherever your private ops-repo-shaped checkout lives; add this to your shell profile so it survives new terminals
mkdir -p "$FLEET_OPS_DIR/fleet"
cp wrangler.example.jsonc "$FLEET_OPS_DIR/fleet/wrangler.jsonc"
```

<details>
<summary>What else this needs (Cloudflare D1/R2, GitHub auth, Access, secrets)</summary>

You need: a Cloudflare D1 database and R2 bucket, GitHub auth (a
fine-grained PAT is the default), Cloudflare Access in front of the Worker,
and the essential secrets — `CLAUDE_CODE_OAUTH_TOKEN`,
`GITHUB_WEBHOOK_SECRET`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `GITHUB_TOKEN` —
set one at a time with `scripts/deploy.sh secret put <NAME>` (never a bare
`wrangler secret put`). Every resource, every secret, Claude accounts, and
why `--allow-unrescued` is needed the first time: full walkthrough in
**[docs/setup.md](docs/setup.md)**.

</details>

**3. Migrate and deploy**

```bash
bun run migrate:local    # apps/fleet/migrations/ against a local D1 for `wrangler dev`, via scripts/deploy.sh
bun run migrate:remote   # apps/fleet/migrations/ against your real D1, via scripts/deploy.sh
bun run deploy --allow-unrescued   # FIRST deploy only (see docs/setup.md): scripts/deploy.sh -> wrangler deploy -c wrangler.local.jsonc
```

**4. Link the CLI**

```bash
bun link            # from apps/fleet — provides `fleet` and `ff`
fleet ls            # must list studios (even zero of them), not 401/403
```

## 🕹️ Daily use

From inside any repo you want a studio for:

```bash
ff                          # this repo's maestro: spawn if absent, then attach
ff web-studio "<brief>"     # file a task, spawn a studio for it, attach
ff web-studio 412           # adopt existing issue #412
```

`ctrl-]` detaches. The studio keeps running.

```bash
fleet ls                    # every studio: state, readiness, burn
fleet check <id>            # ask the container right now, read-only
fleet task ls               # the board for this repo
fleet task new --title T --objective O --output F --boundaries B
fleet provision <id>        # heal a half-built studio, same container
                            # --fresh-session (also on recycle): start claude without
                            # --continue; old session moved aside, never deleted,
                            # shipped to R2 sessions/<id>/aside/<dir>/ on its own
fleet recycle <id>          # new container on the current image; rescues first
                            # refuses if rescue impossible; --discard-unsynced overrides
fleet destroy <id>          # stop for good; rescues first; refuses if rescue impossible
                            # (--discard-unsynced or --force overrides)
```

### Roles

`maestro` coordinates and never implements. `web-studio` and `release-studio`
carry members. `pilot` and `scratch` are lightweight. A studio id is
`<repo>--<role>`, so one repo supports one studio per role — parallelism beyond
that comes from members inside each studio, which is the intended shape.

## 🛡️ Safety

- 🔓 **Leak gate** (always on) — a studio whose work repo is public, or whose
  visibility cannot be confirmed, refuses any `git push` or `gh`
  issue/pr/api/release/gist write whose text matches a private denylist.
- 🔁 **Write proxy** (opt-in, per repo) — a listed repo's studios hold a
  read-only GitHub credential; their writes are scanned against the same
  denylist and forwarded by the Worker instead.
- 🔑 **No studio ever holds a Cloudflare deploy credential** — a lead asked to
  `wrangler deploy` or run a remote migration itself is expected to refuse.
- 🚪 **Cloudflare Access** sits in front of the terminal endpoint (`/studio/*`),
  since it is a shell.
- 💾 **`fleet recycle` and `fleet destroy` rescue uncommitted work first** and
  refuse if the rescue is impossible (`--discard-unsynced`/`--force`
  override, loudly).

Read [docs/threat-model.md](docs/threat-model.md) before deploying: a studio
runs its agent as root in a container that holds real credentials. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## ❓ FAQ

**Why GitHub Issues instead of a dashboard?**
Because it's the board you already use. Work reaches a studio as an issue,
and the studio reports back by commenting an envelope on that same issue —
no separate task database, no dashboard to keep in sync.

**What happens if my laptop dies mid-task?**
Nothing to the studio itself — it runs in a Cloudflare container, not on your
laptop, and keeps working through a closed laptop, a lost network, or a
reboot.

**Does this cost money when idle?**
A studio is a live container: it keeps running (and costing) until you
`fleet recycle` or `fleet destroy` it. Fleetflare's guarantee is visibility,
not idle-suspend — `fleet ls` lists every running studio and its burn, so
nothing spends money where you cannot see it.

**What stops a studio going rogue on my repo?**
The leak gate (always on) refuses any push or GitHub write matching a
private denylist when the repo is public; the write proxy (opt-in) hands a
listed repo's studios a read-only credential and routes writes through the
Worker instead; and no studio ever holds a Cloudflare deploy credential. See
[docs/threat-model.md](docs/threat-model.md).

**Can I run more than one studio per repo?**
One studio per role — a studio id is `<repo>--<role>`, so `maestro`,
`web-studio`, `release-studio`, `pilot`, and `scratch` can all run at once on
the same repo. Parallelism beyond that comes from the member subagents
inside each studio.

**Can leads implement code themselves?**
No. A PreToolUse hook refuses a lead's `Edit`/`Write` and its file-writing
Bash forms, enforced in code. Implementation is always dispatched to member
subagents.

**Does deploying lose in-progress work?**
`bun run deploy` runs `fleet rescue-all` first and refuses to proceed if any
studio's uncommitted work cannot be rescued. Since container images build
reproducibly, a deploy that only touches Worker source keeps the same image
digest and leaves running studios untouched; a deploy that changes
`container/` replaces the containers built from it, which is exactly what
the rescue gate protects. See [docs/operations.md](docs/operations.md).

**Do I need Claude Code specifically, or can I use another AI coding tool?**
The studio image runs the Claude Code CLI as the lead today — this project
is not yet tool-agnostic.

## 🧪 Development

```bash
cd apps/fleet
bun run check       # types, all tsconfig projects
bun run test        # vitest-pool-workers
bun run bun-test    # container-level tests; needs tmux and Chromium
```

Both test lanes matter. `bun run test` alone is half the suite.

GitHub Actions runs `english` on every pull request, and `check` whenever the
diff touches the paths it watches — see
[docs/operations.md](docs/operations.md) for both workflows and what triggers
them, and the (now superseded) Mac-based local-ci daemon.

### Repository layout

```
apps/fleet/          the Worker, the CLI, the container image
  src/               Worker source: routes, Durable Objects, board, GitHub
  cli/               `fleet` and `ff`
  container/         Dockerfile and bring-up for the studio image
fleet/blueprint/     role definitions and org chart the studios inherit
gates/              hooks that constrain what a lead may do
skills/             operator and agent skills
docs/               plans and design records
```

## 📜 License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE) and
[NOTICE](NOTICE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
