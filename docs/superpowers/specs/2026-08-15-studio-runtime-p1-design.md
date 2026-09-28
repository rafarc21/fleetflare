# Studio Runtime P1 — Design

Date 2026-08-15. Branch `35-terminal-watch`, base `origin/staging` @ `62613b5`. Suite 177/177 green at write time. Owner: IS#35 (Watch the real Claude Code terminal from Mac and iPhone).

## Goal

One pilot **studio agent** on the websites repo: persistent interactive Claude Code in a Cloudflare container. Operator attaches from Mac (terminal/agentastic) and iPhone (native app via Tailscale; web page fallback). Image paste from Mac clipboard works. Batch lane (existing headless task path) untouched.

## Decisions already made (operator, 2026-08-15)

- Studio-first fleet. In-session subagents for parallelism. Cross-worktree roles spawn peer studios (P3).
- Task/headless path stays as dormant batch lane. Zero changes to it.
- $250k expiring Cloudflare credits. `keepAlive: true` deliberate. Credits buy metal, never tokens.
- Max subscription only (top Max tier). No API billing. Token governance = monitor (P2), not queue.
- Image paste = must-have, P1.
- iPhone must be native app. Chosen: Tailscale + Moshi (below). PWA rejected as primary; page kept as fallback.
- Approach A approved: `@cloudflare/sandbox` SDK for studios. No hand-rolled PTY.
- Pilot = websites repo studio (dogfood).
- Process rule: **each phase (P2, P3) repeats brainstorm → design spec → implementation plan.** This spec covers P1 only.

## Architecture

### StudioDO

- New DO class `StudioDO` in `apps/fleet`. Subclass of `Sandbox` from `@cloudflare/sandbox` (exact version pin). Own binding + migration in `wrangler.jsonc`. New SQLite class.
- One DO per studio, id `<repo>--<role>` (pilot: `websites--pilot`). Id regex `^([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)$` — segments never contain `--`, so the repo/role split is unambiguous (`a--b--c` rejected). Validated at every route.
- `getSandbox(env.STUDIO, id, { keepAlive: true })`.
- AgentDO, DeployDO, task loop, watchdog, gates: zero diffs.

### Studio image

`container/Dockerfile.studio`:
- `FROM docker.io/cloudflare/sandbox:<exact tag>`. Pin rule: resolve newest 0.x at implementation start, freeze in Dockerfile + package.json (SDK npm version must match image tag per SDK docs), upgrade only deliberately. Same policy as claude pin.
- Add: bun, git, gh, tmux, `@anthropic-ai/claude-code@2.1.224` (same pin as task image), `fleet` container CLI.
- Add: `tailscale`/`tailscaled` binaries. Entrypoint starts `tailscaled --tun=userspace-networking` + `tailscale up --ssh --authkey=$TS_AUTHKEY --hostname=<studio-id>`. Containers join tailnet as **user-owned, non-ephemeral devices via reusable auth key** — dodges tagged-resource ($1/mo each after 50) and ephemeral-minutes metering. Node cleanup on destroy via Tailscale API (P1: manual/documented; automation P3).
- UDP possibly blocked in container egress → WireGuard falls back to DERP relays over TCP 443. Accepted latency cost.

### Session bring-up

On provision and on every container (re)start, control session ensures tmux session `studio`:
- window 0: claude, launched with role system prompt (`--append-system-prompt`) + allowedTools from blueprint role file; `--continue` on restarts. P1 accepts losing at most the in-flight turn; full session sync to R2 = P2.
- window 1: plain shell.
- Repo cloned `/workspace/websites` with GitHub App installation token.

Claude auth: Max OAuth token as Worker secret → container env (Day-1 proven mechanism).

### Worker routes (fleetflare Worker, `/studio/*`)

| Route | Job |
|---|---|
| `GET /studio/:id/ws/terminal` | WS upgrade → PTY attached to tmux `studio`. Resize messages inline. Multiple concurrent attachers allowed (Mac + iPhone). |
| `POST /studio/:id/paste` | Image bytes → `sandbox.writeFile('/workspace/.paste/img-<n>.<ext>')` → returns path. Mime allowlist png/jpeg/webp. Size cap 10 MB. Filename server-generated, never user input. |
| `POST /studio/:id/provision` | Idempotent create: container up, tailscale up, repo clone, tmux bring-up, registry record. |
| `GET /studio/:id/status` | State for `fleet ls`. Scrubbed via existing redact boundary. |
| `POST /studio/:id/restart` | Container restart → bring-up path. |

Registry: extend existing `src/agents/registry.ts` pattern with studio entries.

### GitHub token refresh

Studios outlive the 1-hour App token. StudioDO alarm re-mints installation token (existing `src/github/app.ts`) every ~50 min, rewrites container-side git credential helper file. `gh` reads env refreshed same way. Refresh failure → status flag, Telegram alert via existing channel; session keeps running (only git push blocked until next success).

## Org chart / blueprint / portability (shapes final in P1, enforcement P3)

- **Blueprint** in fleetflare-agency repo `fleet/blueprint/`: `roles/*.md` (frontmatter: skills, allowedTools, may_spawn, reports_to, gate rights; body: role system prompt — same shape as Claude Code agent files), `org.json` (edges + gate matrix), skills referenced from existing `skills/`.
- **Per-repo**: single non-secret `fleet.json` — blueprint git ref **pinned to tag**, enabled roles, overrides, instance size. Onboarding = install GitHub App + commit `fleet.json` + `fleet spawn`.
- **Enforcement lives in Worker**, not files. Role files advisory; Worker validates spawn edges + gate rights (P3). Secrets never in repos.
- P1 ships: blueprint skeleton with one `pilot` role + `fleet.json` in websites repo. Provision reads both.

## Mac cockpit

`fleet` CLI: single-file bun, `apps/fleet/cli/`, `bun link`ed. P1 commands: `ls`, `attach <id>`, `paste <id>`.

Attach client (modeled on hatcher `cloudflare-terminal.ts`, written ours):
- Raw mode, alternate screen enter/restore, SIGWINCH resize forward, exponential backoff reconnect (0.5s base, 10s max, jitter).
- `ctrl-c` passes through (claude cancel). Detach = tmux `ctrl-b d`. Local hard escape = `ctrl-]`.
- **Paste intercept**: `ctrl-v` → `pngpaste` probes Mac clipboard → image: upload via `/paste`, type returned path into stream; no image: forward byte. Mirrors local claude ctrl-v semantics.
- agentastic: `dev newtab "fleet attach websites--pilot"`. No agentastic changes.

## iPhone

- **Primary (native): Tailscale iOS app + Moshi** (getmoshi.app; operator purchases; Termius free = fallback). Moshi → Tailscale SSH → tmux `studio`. Moshi extras (Claude Code hooks feed, agent inbox, push) = post-P1 exploration.
- **Fallback: xterm.js page** served by Worker behind Access. Minimal P1: connect, type, on-screen esc/ctrl/tab/arrows row.
- **Experiment (pilot-only): Claude Remote Control.** `claude remote-control` under tmux window 2, capacity default. Requires full-scope login creds (NOT `setup-token` token) + telemetry env vars unset + direct api.anthropic.com. Quarantined to pilot until proven. Success = pilot session visible/steerable in native Claude iPhone app.
- **Operator action: apply to Spectrum `connect()` inbound-TCP beta** (announced 2026-08-03). GA kills the overlay eventually.

## Auth

- `/studio/*` behind Cloudflare Access: browser = login (page), CLI = Access **service token** headers from `~/.fleet/credentials` (chmod 600). Same pattern as reporting app.
- Tailscale path auth = tailnet membership + Tailscale SSH ACL (operator devices only).
- Scrub boundary extends to `/studio/:id/status`. No token ever in transcripts/status (existing `redactCreds`).

## Testing (expanded per operator 2026-08-15)

Unit (vitest-pool-workers, alongside existing 177 — all stay green):
- Route auth: no credential → 401; wrong service token → 403; WS upgrade rejected pre-upgrade without auth.
- Id validation: traversal/injection attempts (`../`, uppercase, `%2f`) → 400.
- Paste: mime outside allowlist → 415; >10 MB → 413; filename server-side monotonic; success returns exact container path.
- Provision idempotency: double-provision = one container, one tmux, one registry row.
- Refresh alarm: schedules ~50 min; failure backoff; failure sets status flag.
- `fleet.json` + role frontmatter parsing: missing fields → typed errors.
- WS protocol framing: resize control messages interleaved with binary chunks parse correctly; unknown control types ignored not crash.
- Backpressure: slow consumer → bounded buffer, oldest-drop policy, no unbounded memory.
- Concurrent attachers: both sockets receive output; input from both interleaves without corruption (serialize at DO).

Integration (`wrangler dev` + real local container):
- Echo round-trip through WS → tmux → back.
- WS drop + reconnect: tmux screen intact, no duplicate sessions.
- Container restart: bring-up recreates tmux; claude relaunches `--continue`.
- Paste e2e: uploaded bytes checksum-match file in container.
- Registry/status reflects real container state.

Security probes:
- Scrub: status/transcript responses grepped for token patterns (extend existing redact tests).
- Paste path traversal impossible by construction (assert generated path prefix).
- Unauthenticated Tailscale SSH attempt from non-ACL device fails (manual).

Manual acceptance (delivery-standards; all before "done"):
- Mac iTerm + agentastic tab: attach, full claude turn, ctrl-v real screenshot lands in prompt, detach/reattach screen intact, `ctrl-]` escape works, `ctrl-c` cancels claude (not the client).
- Laptop lid closed 5 min → reopen → auto-reconnect, screen intact.
- iPhone: Moshi over Tailscale reaches tmux, full turn typed; fallback page connects and types.
- Kill container mid-generation → reattach → `--continue` session present.
- Isolation: two studios (pilot + scratch), type in A → appears only in A.
- Latency: measure echo round-trip Mac→container, record in PR.
- Regression: full existing suite + one batch-lane task e2e unchanged.
- Remote Control experiment: pilot session pairs, appears in Claude iPhone app, steerable (pass/fail recorded, non-blocking).

## Out of scope (P1)

Transcript durability/R2 sync, fleet grid dashboard, token burn monitor (P2). `fleet spawn`, org enforcement matrix, Tailscale node GC automation, 100-agent provisioning (P3). Each phase gets its own brainstorm → spec → plan cycle.

## Risks

- `@cloudflare/sandbox` 0.x churn → exact pin, deliberate upgrades (same policy as claude pin).
- Tailscale-in-CF-Containers unpublished as a pattern (mechanism standard, environment new) → integration-test early; page fallback exists.
- Remote Control auth swap → quarantined to pilot.
- `dev send` paste-drop (agentastic) unchanged — long instructions via INBOX pattern still apply to cloud tabs.
