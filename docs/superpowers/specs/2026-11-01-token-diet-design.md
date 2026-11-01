# Token diet: cut Claude spend on coordination

Date 2026-11-01. Status: APPROVED by operator 11-01.

## Intent

Claude caps drain faster than real work justifies. Measured 72h (10-29 → 11-01, 46 local transcripts, 5471 turns):

| wake class | turns | share of spend | median cache read / turn |
|---|---|---|---|
| monitor events | 3607 | 45% | 711k |
| peer messages + subagent-done | 1263 | 34% | 0.9–1.6M |
| operator messages | 195 | — | 1.44M |
| heartbeat + keepalive | 55 | ~1% | 170–340k |

- 3565 of 4925 tick turns idle (<3 tool calls). Idle ticks ≈ 34% of all spend, ~103M input-equivalent tokens/day.
- Cost driver: not reply size (~200–800 out). Driver = every wake re-reads whole coordinator context (sessions run days, 0.7–1.6M tokens).
- Multi-lane sprint burn = expected, real work. Not target of phase 1.

Why: coordinators ("maestros") spend most Claude on waking, re-reading, finding nothing. Fix wake design first, tools second.

## Goals

1. Idle-wake spend down ≥70% vs baseline above. Measure with same script (`ticks.py` method: group assistant usage by preceding user turn, classify, sum input-eq).
2. Maestro sleeps fully when nothing it watches moves.
3. Maestro context stays sprint-sized (target ≤200k) without losing useful memory.
4. Agents look facts up in shared memory instead of messaging peers.
5. Operator sees what OSS daemons do.

## Non-goals

- Cutting real multi-lane sprint work.
- Paid tools, hosted services, closed licenses.
- Replacing board/GitHub as task source of truth.

## Anti-goals (failure even if spend drops)

- Maestro forgets useful context. Operator ranks this worse than slowness.
- Dead/stalled studio goes unnoticed (dispatch-monitor rule: crash AND silent stop must still surface).
- Trimmed output hides failing line from a worker.
- Local RAM growth: Mac 24 GB, swap 11.3/12 GB used 11-01. No local models.

## Constraints

- Open source, free, local-first. Workers AI OSS models count as free.
- Reaction delay of minutes acceptable. Operator: "don't care much about reacting a few minutes slower."
- This repo is public: denylist applies to all committed text.
- Existing rules stay: merge on green gate only, workers never message coordinator, monitor coverage on crash + stop.

## Delivery order (operator 11-01: wake diet urgent)

1. Phase 1 ships first, alone. Phases 2–4 start only after phase 1 is live AND one week measured.
2. Phase 1 day 0, no new code, all maestros:
   - remove heartbeat crons from sessions with nothing watched;
   - in-session monitors narrowed to the 1d event set (template script);
   - keepalive idle wake (70 min) off; limit recovery stays;
   - prompt-cache TTL checked on each maestro.
3. Phase 1 build next: 1b gateway + out-of-session watchers, then 1c OSS screen in shadow, then 1e advisor + per-sprint sessions.
4. Measure: re-run classifier 7 days after day 0 and after gateway live.

## Phase 1 — maestro wake diet (largest saving)

### 1a. Sleep rule
- Maestro keeps waking only while something it watches moves: studio working, gate running, PR head/state changing.
- All watched work stalled or waiting on operator → full sleep. No ticks, no heartbeat.
- Wake again on: operator message, or a watched item changing state.
- "Waiting on operator" alone never justifies a wake.
- "Asleep" = session idle at prompt, no watcher armed that can wake it, no session cron. Claude Code itself needs nothing special.
- Heartbeat crons on maestros removed; gateway replaces them.
- Keepalive changes: drop the 70-min idle wake; keep limit-death recovery (wake after a limit resets) and gateway delivery. Keepalive must not wake an asleep maestro just because it is idle.

### 1b. Wake gateway (no Claude inside)
- Watchers move OUT of the Claude session. In-session `Monitor` tool processes go away for studio/PR watching: each output line wakes the session, and the tool caps at 30 min, so even re-arming costs a wake every 30 min.
- Watchers = plain background scripts (launchd or detached), one per maestro's watch set. They append events to a per-maestro queue file.
- One local gateway daemon per machine reads queues, batches per maestro.
- Wake channel (my call): gateway types ONE line into maestro's Orca terminal, same path keepalive uses today (prefix `GATEWAY:`, then summary lines). Keepalive's delivery checks (swallowed Enter, dead handle) reused. No in-session monitor to expire.
- Batch window hard ceiling: non-immediate events wake at most once per 15 min per maestro.
- Immediate classes (bypass batching AND OSS screen): studio stopped/GONE/dead, limit/modal on a lead, gate verdict on a PR maestro owns.
- Batched classes: task state change, PR opened/head moved, lead idle ≥10 min with open task (my call: idle-not-dead may wait 15 min; dead may not).
- Operator messages arrive directly in the terminal as today; gateway never delays them.
- Builder call: shell or bun script under launchd, next to existing keepalive. Reuse keepalive's registry of maestro sessions.

### 1c. OSS screen
- Existing DeepSeek triage daemon (shadow mode today) reads each batch.
- Decides: drop / summarize / wake Claude. Only "needs decision" batches reach Claude.
- Screens batched classes only. Immediate classes never pass through it.
- "Drop" = logged to gateway log, not delivered. Never deletes the event.
- Shadow → live: 48h where gateway delivers everything AND logs daemon verdict. Agreement = daemon said "drop" and Claude took no action (no tool call beyond reads) on that batch. Promote per maestro at ≥95% agreement and zero "drop" on a batch Claude acted on. Gateway computes it; operator sees result in daemon view (phase 3).

### 1d. Monitor discipline
- Monitors emit only state changes: PR opened/head moved/closed, gate verdict, task state, studio stopped/GONE, lead idle ≥10 min (once).
- No progress lines. No working↔idle flips.
- Stop monitor when its last agent done.
- Ship one template script; briefs and skills point at it.

### 1e. Session hygiene
- One maestro session per sprint. Sprint close → handoff note → fresh session.
- No auto-compaction on maestros (it drops old context silently). Builder verifies exact setting name in Claude Code docs.
- Advisor: maestro tells operator when to clear, start fresh, or split work into separate worktree/maestro. Triggers (my call, tune later): context >200k, sprint closed, new unrelated topic.
- Advisor = nudge at 200k, repeated firmer at 400k. Never a hard stop; operator decides.
- If Claude Code offers no way to turn auto-compaction off: keep default compaction at the context limit as backstop, rely on advisor so limit is rarely hit. Phase not blocked.
- Handoff note written BEFORE advising clear. Nothing lost: board, PRs, memory hold state.
- Verify prompt-cache TTL 1h on maestros (`/usage` "Prompt cache (main)"); ticks inside 1h then pay cache read, not cache write.

## Phase 2 — shared memory

- Repo owner: rafarc21 account (operator 11-01). Private.
- Cloud read access: reuse the fleet's existing GitHub App token if installed on the repo; else a read-only deploy key. Bring-up clones it next to the work checkout.
- Migration: fleet-wide facts (accounts, rules, incidents, reference) copied from today's per-session memory dirs, deduped. Project-specific memory stays in place until trial passes.
- Private git repo of markdown notes, separate from code repos. Why separate: this repo public (leak), product repos wrong home for cross-project facts and clutter PR history, ops repo mixes deploy blast radius.
- Layout: `shared/` fleet-wide facts, `projects/<repo>/`, `handoffs/<maestro>/`. One fact per file, frontmatter as today.
- Index: memsearch (MIT) on Mac only. Markdown = source of truth, index rebuildable. Skip its turn-summarizing plugin (spends Claude per turn).
- Cloud studios: clone read-only at bring-up, grep only (no 558 MB embed model in containers).
- Lookup wrapper returns top 3 snippets, ≤300 chars each. Briefs say "look up memory" instead of "ask peer X".
- gitleaks pre-commit. Private repo.
- Trial 1 week. Kill if >1 GB RSS per session or recall <70% on 10 known questions.
- Later: migrate to operator's own graph-map product (MCP exists) once mechanism proven. Mirror first, viewer for operator; agents keep cheap search.

## Phase 3 — OpenCode + daemon visibility

- OpenCode (MIT, already installed 1.2.10) in its own Orca tab, provider = Workers AI OpenAI-compatible endpoint (GLM-5.3, Kimi-code, DeepSeek-v4). For small tasks operator now gives Claude.
- No local models (RAM).
- Daemon visibility: `watch-triage.sh` tails triage + escalation logs → one readable line per batch (time, mode, events, action, latency, tokens). Header: mode, hourly cap, pid. Own Orca tab.

## Phase 4 — studio tool-output trimming (multi-lane burn)

- Trial on one OSS-led scratch studio: rtk-oss (Apache-2.0 edition only) vs Tokenade (MIT/Apache, young — pin version, auto-update off).
- Replay failing test run + long gh/log read; compare tokens; failure line must survive.
- Cheap fallback: lower `BASH_MAX_OUTPUT_LENGTH`, failure-grep PreToolUse hook from Claude Code docs.
- Rejected: context-mode (Elastic-2.0, not OSS; blocks native tools). claude-mem, qmd, mem0/letta (server or heavy models).

## Measurement

- Baseline numbers above. Fixed baseline window: 2026-10-29 08:23Z → 2026-11-01 08:20Z, all `~/.claude/projects/*/*.jsonl` touched in it.
- Script: operator's private tools dir (`~/.fleetflare-maestro/tools/token-diet/ticks.py`), not this repo (it names private paths). Re-run weekly over a same-length window; report idle-wake tokens/day and share per class.
- Phase 1 success: idle-wake spend ≥70% down, zero missed studio deaths in the week.

## Left to builder

- Gateway language and file location; event format between monitors and gateway.
- Exact Claude Code settings names (compaction, cache TTL); verify against current docs before use.
- How triage daemon receives batches (file queue vs socket).
- Advisor implementation (hook reading context size vs instruction in maestro skill).
