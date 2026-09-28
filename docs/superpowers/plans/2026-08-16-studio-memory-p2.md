# Studio Memory P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable transcripts + session restore + fleet grid + token monitor for studio agents, plus three P1-ledgered bridge hardenings.

**Architecture:** Pull-model shipping — StudioDO schedules read container files via `sbExec` and write R2 (`STUDIO_ARCHIVE`). Grid and monitor are pure consumers of what shipping already moves. No new inbound surfaces; every route stays behind the existing Access gate.

**Tech Stack:** Existing P1 stack + R2 binding (miniflare-native in tests). No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-08-16-studio-memory-p2-design.md` (rulings R-P2-1..7 inline — they bind).

## Global Constraints

- Base: P1 head (`12196c3`) on branch `35-terminal-watch`. All four P1 gates stay green after every task: unit (390 at base) · `bun run check` · `bun run test:integration` (13 at base) · `bun run test:acceptance` (5 at base).
- Batch lane untouched: zero diffs under `container/server.ts`, `container/deploy-server.ts`, `src/agents/`, `src/deploy/`, `src/tasks/`.
- Transcript archive = RAW bytes in R2 (R-P2-7); every HTTP-served preview/summary passes `redactSecrets`. Burn data = numbers only.
- Shipping/monitor failures NEVER touch studio health state (`state`/`error` are provision/refresh-owned; new planes get their own fields).
- Constants: `TRANSCRIPT_PULL_MAX = 1_048_576`; ship tick 30s; sync tick 300s; rotation threshold 67_108_864 (64 MiB); hot tail 8_192 bytes; session single-read cap 4 MiB, split parts `-b 4m`, total cap 67_108_864; daily session keepers 7; 5h window 18_000_000 ms.
- bun only. Small conventional commits. Caveman docs/commits; code/tests normal.

## File Structure (locked)

```
apps/fleet/
  src/studio/
    archive.ts        # R2 paths, manifest math, offset/rotation pure logic
    transcript.ts     # ship loop (pure over ports) — DO wires it
    session-sync.ts   # tar/read/restore pipeline (pure over ports)
    burn.ts           # jsonl usage parser, counters, 5h window, alert streak
    grid.ts           # grid page render (template consumer)
    do.ts             # + schedules shipTranscript/syncSession wiring
    routes.ts         # content-negotiation on GET /studio/, burn in status
    registry.ts       # + burn summary + tailscaleHost columns
  page/
    grid.template.html
    grid.html         # build artifact (build:page extended → build:pages)
  container/
    studio-bringup.sh # + pipe-pane step, + restore-untar step, + ts-host write
  test/
    studio.archive.test.ts
    studio.transcript.test.ts
    studio.session.test.ts
    studio.burn.test.ts
    studio.grid.test.ts
    (+ existing files extended: ws TOCTOU, cli floor-loop)
  test-integration/attach.e2e.ts   # + P2 assertions
  test-integration/cli.acceptance.ts # + P2 assertions
```

---

### Task 1: R2 binding + archive pure logic

**Files:**
- Modify: `apps/fleet/wrangler.jsonc` (R2 binding `STUDIO_ARCHIVE`, bucket `studio-archive`; env var `BURN_ALERT_OUTPUT_TOKENS_5H` optional), `apps/fleet/src/env.ts`
- Create: `apps/fleet/src/studio/archive.ts`, `apps/fleet/test/studio.archive.test.ts`

**Interfaces:**
- Produces: `chunkKey(id: string, dateIso: string, seq: number): string` → `transcripts/<id>/<yyyy-mm-dd>/<seq(6, zero-padded)>.log`; `sessionLatestKey(id)`, `sessionDailyKey(id, dateIso)`; `TranscriptManifest = { seq: number; offset: number; date: string }`; `advance(m: TranscriptManifest, bytesShipped: number, now: Date): TranscriptManifest` (date roll resets seq); `shouldRotate(fileSize: number): boolean` (>= 64 MiB); all constants exported from here.

- [ ] **Step 1: failing tests** — key formats exact; `advance` increments seq, carries offset, rolls seq to 0 on new UTC date; `shouldRotate` boundary (64MiB-1 false, 64MiB true); zero-padding sorts lexicographically (`000009 < 000010`).
- [ ] **Step 2: run, fails. Implement. Suite green (pool-workers picks up the new binding — copy the existing binding declaration style; miniflare provides R2 natively).**
- [ ] **Step 3: commit** — `feat(fleet): studio archive scaffold + R2 binding`

---

### Task 2: Transcript ship loop

**Files:**
- Create: `apps/fleet/src/studio/transcript.ts`, `apps/fleet/test/studio.transcript.test.ts`
- Modify: `apps/fleet/src/studio/do.ts` (schedule `shipTranscript` 30s from provision — `deleteSchedules` first, reschedule in `finally`, exactly the refresh-loop idiom), `apps/fleet/container/studio-bringup.sh` (guarded pipe-pane step + `mkdir -p /workspace/.transcript`)

**Interfaces:**
- Consumes: archive.ts, `sbExec`, R2 binding, DO storage keyed port (extend the P1 `StudioStorage` keyed-overload pattern with `transcriptManifest`, `transcriptTail` keys).
- Produces: `shipTranscriptTick(deps: ShipDeps, storage, id): Promise<ShipResult>` where `ShipDeps = { exec(cmd): Promise<{code,stdout,stderr}>; r2Put(key, bytes): Promise<void>; now(): Date }`; `ShipResult = {shipped: number, rotated: boolean, skipped?: string}`. Reads `tail -c +<offset+1> /workspace/.transcript/claude.log | head -c 1048576` base64-wrapped (`| base64`) to survive binary bytes through exec stdout; decodes Worker-side. Rotation: when `stat -c %s` ≥ threshold AND offset == size (fully shipped) → `truncate -s 0` + manifest offset reset (same tick, ordered, exec chained `&&`). Hot tail: after ship, `tail -c 8192` (base64) → storage `transcriptTail`. Absent file (pre-first-bring-up) → `{skipped:"no-file"}`. Ship failure throws → DO catch logs, never touches status.
- Bring-up: `tmux pipe-pane -o -t studio:claude 'cat >> /workspace/.transcript/claude.log'` guarded by checking `tmux show-options -p -t studio:claude 2>/dev/null | grep -q pipe` is NOT reliable — instead guard idempotently: pipe-pane `-o` toggles; use unconditional `tmux pipe-pane -t studio:claude 'cat >> /workspace/.transcript/claude.log'` (no `-o`, sets it absolutely; re-running re-sets the same pipe — verify semantics with tmux docs in-container and document; the requirement is double-run ≠ toggle-off).

- [ ] **Step 1: failing unit tests** — offset math across two ticks (fake exec returns sized outputs); binary-safe round-trip (bytes with 0x00/0xff through the base64 path); rotation only when fully shipped; date-roll seq reset; no-file skip; tail stored; failure isolation (throwing r2Put leaves manifest unchanged — no partial advance).
- [ ] **Step 2: implement; wire DO schedule; bring-up step (+ the pipe-pane semantics note). Full suite green.**
- [ ] **Step 3: commit** — `feat(fleet): transcript shipping to R2`

---

### Task 3: Session sync + restore

**Files:**
- Create: `apps/fleet/src/studio/session-sync.ts`, `apps/fleet/test/studio.session.test.ts`
- Modify: `apps/fleet/src/studio/do.ts` (schedule `syncSession` 300s; `restartStudio` runs one sync before bring-up), `apps/fleet/src/studio/provision.ts` (fresh-container restore step: R2 `latest` exists AND container lacks `~/.claude/projects` → `sbWriteFile` tar (chunked ≤4MiB parts to `/workspace/.session-restore/part-NN`) before bring-up), `apps/fleet/container/studio-bringup.sh` (guarded restore-untar step: parts present AND `~/.claude/projects` absent → `cat parts | tar -xzf - -C /root` then remove parts)

**Interfaces:**
- Produces: `syncSessionTick(deps, storage, id): Promise<SyncResult>` — tar to file, `stat` size, ≤4MiB single base64 read else split+read parts sequentially, total >64MiB → `{skipped:"oversize"}` + log; R2 put `latest` every tick, daily key once per UTC date (storage marker `sessionDailyDate`), prune to 7 dailies (r2 list+delete port). `restorePlan(r2Head, containerHasProjects): "restore"|"skip"` pure.
- Failure posture: sync throw → log only. Restore failure → provision proceeds fresh (log; never degraded).

- [ ] **Step 1: failing tests** — single vs split path selection by size; oversize skip; daily-once marker; prune keeps newest 7; restorePlan truth table; restart-runs-sync-first ordering (fake exec sequence assertion); provision restore only when fresh+exists.
- [ ] **Step 2: implement all three surfaces + bring-up step. Full suite green.**
- [ ] **Step 3: commit** — `feat(fleet): session sync and restore`

---

### Task 4: Token monitor

**Files:**
- Create: `apps/fleet/src/studio/burn.ts`, `apps/fleet/test/studio.burn.test.ts`
- Modify: `apps/fleet/src/studio/session-sync.ts` (after a successful sync, hand the tar bytes to burn parsing — in-memory, tar parsed via a minimal ustar reader for `*.jsonl` members only; no dependency), `apps/fleet/src/studio/types.ts` (+`burn` summary type), `apps/fleet/src/studio/registry.ts` (+burn numbers in rows), `apps/fleet/src/studio/do.ts` (alert wiring via existing telegram util)

**Interfaces:**
- Produces: `parseUsageIncrement(prev: BurnCursor, jsonlByFile: Map<string, string>): {cursor: BurnCursor, delta: BurnDelta, parseSkips: number}` — cursor = per-file byte offsets so re-parsing is incremental across ticks; tolerant (missing usage fields = zeros; malformed line = skip+count). `rollWindow(burn, delta, now): Burn` — 5h window start/output tracking. `shouldAlert(burn, threshold, alreadyAlertedWindow): boolean` — once per window, streak-reset on window roll (lastRefreshError pattern). `Burn = {turns, inputTokens, outputTokens, costUsd, window5hStart, window5hOutput}`.
- Constraint: burn numbers only in registry/status (no message content ever leaves the parser); threshold 0/absent = alerts off.

- [ ] **Step 1: failing tests** — fixtures: realistic claude jsonl lines (usage present), lines without usage, garbage, giant line; incremental cursor across two parses (no double count); window roll at exactly 5h; alert once-per-window incl. reset; ustar reader extracts only `.jsonl` members (fixture tar built in-test via a tiny writer or pre-baked bytes).
- [ ] **Step 2: implement; wire into sync tick + registry + telegram alert. Full suite green.**
- [ ] **Step 3: commit** — `feat(fleet): token burn monitor`

---

### Task 5: Fleet grid page

**Files:**
- Create: `apps/fleet/page/grid.template.html`, `apps/fleet/src/studio/grid.ts`, `apps/fleet/test/studio.grid.test.ts`
- Modify: `apps/fleet/scripts/build-page.ts` (build both pages; keep sourcemap guard for each), `apps/fleet/src/studio/routes.ts` (GET `/studio/`: `Accept` includes `text/html` → grid page (studio data server-injected as JSON blob, scrubbed previews), else JSON as today), `apps/fleet/cli/fleet.ts` (`ls` sends `Accept: application/json` explicitly)

**Requirements:** cards (id, state chip, last activity, tailscaleHost when present, burn columns, scrubbed 15-line tail preview `<pre>`), links to `/studio/<id>/terminal`, provision/restart buttons (fetch POST + confirm dialog + result toast), 10s auto-refresh re-fetching JSON (no reload). Terminal-page discipline: self-contained, dark, dvh, no external requests, build guard.

- [ ] **Step 1: failing route tests** — 401 unauth; html for browser Accept; json for CLI Accept; preview scrubbed (seed tail w/ ghs_ token → absent in served HTML); burn numbers present.
- [ ] **Step 2: implement template + render + build + CLI header. Full suite green. Headless: curl both negotiations, grep no-external-URLs, syntax-check inline JS.**
- [ ] **Step 3: commit** — `feat(fleet): fleet grid page`

---

### Task 6: Ride-alongs (bridge hardening trio)

**Files:**
- Modify: `apps/fleet/src/studio/terminal.ts` (TOCTOU: after `ensurePty()` resolves in `attach()`, if the resolved handle is no longer `this.live` → return 503, no accept), `apps/fleet/cli/fleet.ts` + `apps/fleet/page/terminal.template.html` (+rebuild artifact) (floor-loop: connection lifetime <5s → `attempt` NOT reset), `apps/fleet/container/studio-bringup.sh` (write `/workspace/.ts-host` from `tailscale status --json` Self.DNSName, guarded, absent-tailscale skip), `apps/fleet/src/studio/do.ts` (refresh tick also `sbExec cat /workspace/.ts-host` → status `tailscaleHost`, absent → null, never fails the tick)
- Tests: extend `test/studio.ws.test.ts` (TOCTOU forced-death case), `test/cli.input.test.ts` or new pure-fn tests (floor-loop: `nextAttempt(prev, connLifetimeMs)` pure), refresh test (ts-host read success/absent)

- [ ] **Step 1: failing tests per item. Step 2: implement all three + rebuild page artifact. Full suite green. Step 3: commit** — `fix(fleet): attach TOCTOU, reconnect floor, tailscaleHost`

---

### Task 7: Integration + acceptance additions

**Files:**
- Modify: `apps/fleet/test-integration/attach.e2e.ts` (+: pipe-pane→ship→R2 round-trip across two forced ticks with offset persistence; rotation exec-order (use a tiny threshold override env for test); session tar→restore on a fresh container (files present after bring-up); grid html serves with scrubbed preview), `apps/fleet/test-integration/cli.acceptance.ts` (+: kill container mid-session → R2 chunks survive; reattach → session files restored; `fleet ls` shows burn + host columns)
- Note: R2 in `wrangler dev` = miniflare-local bucket — assert through the Worker (add a test-only read-back route in `dev-entry.ts`, NOT in `src/`).

- [ ] **Step 1: extend suites; run `bun run test:integration` + `test:acceptance` — all green incl. P1's originals. Paste verdict lines. Step 2: commit** — `test(fleet): P2 integration + acceptance`

---

### Task 8: Close-out

- [ ] Full gates: unit + check + integration + acceptance; batch-lane zero-diff whole-branch; `wrangler deploy --dry-run` clean (now includes R2 binding — dry-run validates shape only).
- [ ] `docs/superpowers/OPERATOR-FINISH-LIST.md`: + `wrangler r2 bucket create studio-archive` before deploy; + optional `BURN_ALERT_OUTPUT_TOKENS_5H`; + note transcripts/sessions are private-R2 raw.
- [ ] Report with evidence. NO PR (controller owns it after whole-branch P2 review).
- [ ] commit — `docs(fleet): P2 finish-list additions`

---

## Self-review notes (write time)

- Spec coverage: planes 1-4 → tasks 2-5; ride-alongs → 6; infra → 1; testing → distributed + 7; finish-list → 8. Rulings R-P2-1..7 embedded in task text where they bind.
- Placeholders: pipe-pane idempotency semantics deliberately resolved in-task with documentation duty (T2) — a verification procedure, not a TBD.
- Type consistency: `TranscriptManifest`/`ShipDeps` (T1/T2), `Burn*` (T4), keyed-storage extensions named at first use; `nextAttempt` pure fn (T6).
