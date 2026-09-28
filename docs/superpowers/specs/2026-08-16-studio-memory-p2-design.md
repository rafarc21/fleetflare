# Studio Memory P2 — Design

Date 2026-08-16. Branch `35-terminal-watch` (continues past PR#38's P1 head). Authored autonomously per operator directive 2026-08-15 ("go through all phases without me"); brainstorm gates collapsed into rulings, recorded inline. Suite 390/390 at write time.

## Goal

Nothing a studio does is ever lost; the fleet is visible from one page; token spend is observable. Four planes: durable transcripts, session-state sync, fleet grid, token monitor — plus three small bridge-hardening ride-alongs ledgered during P1.

## Rulings (design decisions, operator-auditable)

- **R-P2-1 Pull, not push.** Worker pulls transcript/session data from containers via `sbExec` on the existing schedule idiom. No container→Worker auth surface, no new inbound path, reuses the proven alarm mechanism. Cost if wrong: polling latency (30s) vs instant push — acceptable for archives.
- **R-P2-2 R2 chunk objects, no append.** R2 has no append; transcripts become sequential chunk objects `transcripts/<id>/<utc-date>/<seq>.log` + a manifest in DO storage. Cost: listing needs manifest; simple.
- **R-P2-3 Session snapshot is best-effort.** `~/.claude/projects` tarred live every 5 min + before restart. Claude Code session files are per-project jsonl (append-shaped); a mid-write snapshot loses at most the in-flight line. Cost if wrong: rare torn tail line — restore still loads.
- **R-P2-4 Burn derived from session files.** Max subscription has no usage API; claude's session jsonl carries per-message usage/cost fields. The session-sync plane already moves those bytes; the monitor parses increments. Advisory alerts only (telegram), threshold via env var. Cost if wrong: undercount if claude changes jsonl shape — monitor is advisory, never a gate.
- **R-P2-5 Ride-alongs in, big items out.** In: attach-TOCTOU close, reconnect floor-loop cap, tailscaleHost writer. Out (P3/backlog): studio-side approval channel, streaming paste reader, fleet spawn, 100-scale.
- **R-P2-6 Grid follows the terminal page's discipline.** Self-contained HTML, no framework, no external requests, Access in front, served by the Worker.

## Plane 1 — Transcript durability

- Bring-up adds `tmux pipe-pane -o -t studio:claude 'cat >> /workspace/.transcript/claude.log'` (guarded, idempotent like every bring-up step; directory created; ANSI kept raw — it is the truth of the terminal).
- StudioDO schedule `shipTranscript` every 30s: `sbExec` reads `tail -c +<offset>` (offset in DO storage key `transcriptOffset`), caps each pull at 1 MiB (`TRANSCRIPT_PULL_MAX`), writes chunk to R2 binding `STUDIO_ARCHIVE` at `transcripts/<id>/<yyyy-mm-dd>/<seq>.log`, advances offset + manifest (DO storage: seq, bytes, date). Rotation: when the container file exceeds 64 MiB, truncate after a confirmed ship (`truncate -s 0` + offset reset — one exec, ordered).
- Hot tail: last 8 KiB kept in DO storage key `transcriptTail` for the grid preview (updated on each ship).
- Failure posture: ship failure = log + retry next tick; never touches studio state (transcript is observability, not health).
- Scrub: transcript chunks are RAW terminal bytes (claude's own screen); they are NOT scrubbed (they are the operator's terminal truth, R2-private) — but the hot tail preview IS scrubbed before serving in any HTTP response (existing redactSecrets), and R2 access stays Worker-only. Ruling R-P2-7: raw archive, scrubbed previews. Cost if wrong: secrets an agent echoes land in private R2 — same trust domain as the live terminal itself.

## Plane 2 — Session-state sync

- StudioDO schedule `syncSession` every 300s + invoked before `restartStudio`'s bring-up. SDK exec returns stdout buffered, so no streaming: tar to a file (`tar -C /root -czf /workspace/.session-sync/latest.tar.gz .claude/projects .claude.json`), read its size; ≤ 4 MiB → single `sbExec base64` read; larger → `split -b 4m` and read parts sequentially (cap total at 64 MiB; beyond that, log + skip tick — a session dir that size signals a different problem). Store at R2 `sessions/<id>/latest.tar.gz` (+ `sessions/<id>/<iso>.tar.gz` daily keeper, 7 kept, older pruned).
- Restore: during provision bring-up, when container is fresh (`~/.claude/projects` absent) and R2 `latest` exists → Worker writes tar to `/workspace/.session-restore.tar.gz` via `sbWriteFile` (chunked if needed), bring-up untars before launching claude. `--continue` then finds history.
- Failure posture: sync failure logs + retries next tick; restore failure → bring-up proceeds fresh (log, never block) — a studio with amnesia beats a studio that won't start.

## Plane 3 — Fleet grid

- `GET /studio/` currently returns JSON; content-negotiate: `Accept: text/html` (browsers) → grid page; JSON otherwise (CLI unchanged — it sends Accept: application/json explicitly from this phase on; CLI updated in same task).
- Grid: card per studio — id, state chip, last activity, scrubbed hot-tail preview (last ~15 lines, rendered mono), burn column (plane 4), links: open terminal (`/studio/<id>/terminal`), buttons: provision/restart (POST via fetch with confirm). Auto-refresh via 10s fetch of the JSON (no websockets — YAGNI for P2).
- Same build discipline as terminal.html: template + build script, self-contained, dark, dvh-safe.

## Plane 4 — Token monitor

- Session-sync plane already pulls session jsonl bytes. Monitor parses INCREMENTALLY at sync time (Worker-side, from the tar it just shipped — parse in-memory, never store parsed PII beyond counters): per-studio counters in DO storage `burn` = `{turns, inputTokens, outputTokens, costUsd?, window5hStart, window5hOutput}` using claude jsonl usage fields (tolerant parser: absent fields = zeros, unknown shape = skip line + count `parseSkips`).
- Fleet totals: registry rows gain `burn` summary (scrubbed path — numbers only); grid shows per-studio + fleet header.
- Alert: env `BURN_ALERT_OUTPUT_TOKENS_5H` (default 0 = off). When a studio's rolling 5h output crosses it → telegram once per window (reuse streak pattern from lastRefreshError — dedicated `burnAlertedWindow` marker).

## Ride-alongs (P1 ledger)

- **Attach TOCTOU:** in `attach()`, after `ensurePty()` resolves, verify the pty is still the live one before `acceptWebSocket`; if it died in the microtask window → 503 (client backoff handles). Test: forced death between resolve and accept.
- **Reconnect floor-loop:** CLI + page: if a connection closes < 5s after opening, do NOT reset `attempt` (prevents 500ms hammering of an open-then-1011 studio). Test: backoff progresses across fast-close cycles.
- **tailscaleHost:** bring-up writes `tailscale status --json | <extract Self.DNSName>` (guarded, absent tailscale → skip) to `/workspace/.ts-host`; the refresh alarm reads it once per tick (`sbExec cat`, ignore absent) and stores into status. Grid + `fleet ls` display it.

## Infra

- wrangler.jsonc: R2 bucket binding `STUDIO_ARCHIVE` (bucket `studio-archive`); miniflare provides R2 in tests natively. Bucket creation = operator finish-list addition (or `wrangler r2 bucket create` at deploy — goes in the finish-list, not run here).
- New env: `BURN_ALERT_OUTPUT_TOKENS_5H` (var, optional).

## Testing (same discipline as P1)

- Unit: offset/manifest math incl. rotation boundary; jsonl usage parser (fixtures: real-shaped lines, absent fields, garbage, huge line); 5h window roll; burn alert streak; grid content-negotiation (401/html/json); TOCTOU + floor-loop pure logic; tailscaleHost absent/present.
- Integration additions (real container): pipe-pane → ship → R2 (miniflare) round-trip with offset persistence across two ticks; rotation exec ordering; session tar → restore on fresh container → `--continue` context present (assert file restored, not a claude turn); grid page serves + previews scrubbed.
- Acceptance additions: kill container mid-session → transcript chunks exist in R2 through the kill; reattach → session restored (files present).
- Gates: full unit + check + integration + acceptance green; batch lane zero-diff; P1 gates stay green (no regression to the 390).

## Out of scope (P3 / backlog)

Fleet spawn + org enforcement, 100-agent provisioning + burn tuning, studio-side approval channel, streaming paste reader, Tailscale node GC automation, tailscale installer pin, Moshi hooks-feed integration, keepAlive fleet policy.
