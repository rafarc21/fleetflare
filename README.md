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

## ✨ Features

- ☁️ **Cloud-native, not laptop-bound.** A studio costs zero local RAM and
  keeps running through a closed laptop, a lost network, or a reboot.
- 👀 **Visible by default.** Every running studio gets a live terminal and a
  row in `fleet ls` — nothing spends money where you cannot see it.
- 🙅 **Leads never implement.** A hook refuses a lead's `Edit`/`Write`, so
  implementation is always dispatched to member subagents.
- 🧯 **Rescue-first lifecycle.** `fleet recycle`/`fleet destroy` rescue
  uncommitted work to its own branch first, and refuse outright if that
  rescue is impossible.
- 🎭 **A role per job.** `maestro` coordinates, `web-studio`/`release-studio`
  carry members, `pilot`/`scratch` are lightweight — one studio per role per
  repo.

Key concepts, the architecture, the full FAQ, and the repository layout are
in **[docs/architecture.md](docs/architecture.md)**.

**Status:** Fleetflare runs a real fleet daily across several repositories.
It is not a turnkey product — it assumes Cloudflare, GitHub, Claude Code, and
an editor that can host terminals, and expects you to read code when
something surprises you. [docs/operations.md](docs/operations.md) tells you
which surprises to expect first.

## 🚀 Quickstart

There is one real path here: deploy your own Worker to your own Cloudflare
account.

**Prerequisites**

- [ ] A Cloudflare account
- [ ] A GitHub personal access token (a fine-grained PAT is the default)
- [ ] A Claude Code OAuth token
- [ ] [Bun](https://bun.sh) installed locally

### 1️⃣ Clone and install

```bash
git clone https://github.com/<you>/fleetflare
cd fleetflare/apps/fleet
bun install
```

### 2️⃣ Point at your ops checkout

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

### 3️⃣ Migrate and deploy

```bash
bun run migrate:local    # apps/fleet/migrations/ against a local D1 for `wrangler dev`, via scripts/deploy.sh
bun run migrate:remote   # apps/fleet/migrations/ against your real D1, via scripts/deploy.sh
bun run deploy --allow-unrescued   # FIRST deploy only (see docs/setup.md): scripts/deploy.sh -> wrangler deploy -c wrangler.local.jsonc
```

### 4️⃣ Link the CLI

```bash
bun link            # from apps/fleet — provides `fleet` and `ff`
fleet ls            # must list studios (even zero of them), not 401/403
```

## 📋 Usage

Once deployed, a studio's lifecycle runs automatically from your GitHub
Issues board:

1. **Issue created**: you (or a teammate) file or comment on an issue in the
   target repo.
2. **Webhook fires**: GitHub delivers it to the Worker.
3. **Studio wakes**: the Worker spawns or wakes that repo's `StudioDO`,
   which runs (or already runs) the container holding the lead.
4. **The lead works**: it never implements directly — it dispatches the
   work to member subagents and tracks progress on the board.
5. **Studio reports back**: the studio comments an envelope on that same
   issue — there's no separate dashboard to check.

The commands you actually type, from inside any repo you want a studio for:

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
fleet recycle <id>          # new container on the current image; rescues first
fleet destroy <id>          # stop for good; rescues first
```

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

See [docs/architecture.md](docs/architecture.md) for roles, the safety
model, and the FAQ.

## 💻 Development

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
them.

## 📜 License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE) and
[NOTICE](NOTICE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
