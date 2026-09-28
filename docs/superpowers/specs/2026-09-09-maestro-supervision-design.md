# Maestro supervision — event-driven, sweep-backed

Date 2026-09-09. Approved by the operator in chat, same day.

## Problem

Maestro cannot supervise. Claude session acts only on a turn. Nothing gives
maestro a turn unless operator types. Blueprint line "check every 10 min" is
instruction session cannot follow.

Today operator runs the loop by hand. 10-min cron, own terminal. Works. Not
durable, dies with session.

## Correction to the naive design

Studios emit no events. Studio has no outbound channel. Only outward signals:
GitHub write (envelope comment, task state, PR) and own container state.

So "studio sends event" resolves to two different mechanisms:
- board/PR activity -> GitHub webhook. True push.
- studio crash, bare, READY stale -> NO event exists. Cloudflare Containers
  emit nothing. Sweep is only detector.

Sweep therefore not a fallback. Sweep is the crash detector. Keep it even
with webhooks live.

## Architecture

Three parts.

### 1. Waker (Worker code)

**Webhook path.** `/gh` already exists, HMAC-verified
(`src/github/webhook.ts:26`), `GITHUB_WEBHOOK_SECRET` set. Handler currently
early-returns on any event that is not `push`. Add branch: `issue_comment`,
`issues`, `pull_request`, `check_suite` -> wake maestro with delta digest.
Reuse existing signature gate. No new route, no new secret.

**Sweep path.** Named schedule callback on maestro DO, same idiom as
`refreshToken()` / `shipTranscript()` (`src/studio/do.ts:1961`). Reschedule in
`finally`, never a bare tail statement — unguarded throw ends chain forever,
no watchdog re-arms it.

Interval 20 min. Every wake (webhook or sweep) resets it. Busy fleet fires
zero sweeps.

**No polling.** Dropped. Webhook covers board latency, sweep covers crash.
2-min poll from first draft removed at the operator's call.

**Wake mechanism.** Worker `sbExec` into maestro container, `tmux send-keys`
to window 0. Same shape as `~/.fleet/probe/send.ts`. MUST be proven by test
first — Phase 2 task 1. No attach race here (maestro tmux long-running),
unlike probe's settleMs>=9000 case.

### 2. Quiescence

Stop sweeping when work is done. Measurable, never vibes.

Quiescent iff ALL:
- no board task in flight on a running studio
- no open fleet PR pending CI or merge
- every studio stopped, or running with no unfinished envelope

Two guards:
- **Two consecutive quiescent sweeps** before stopping. One flaps.
- **Fail-CLOSED.** Check throws (GitHub down, `fleet ls` errors) -> do NOT
  declare quiescence. Keep sweeping. Stopping is a GATE; branch rule is
  fail-CLOSED for a gate. Broken check never means "done".

On quiescence: emit FINAL wave, do not reschedule, record end state.

Re-arm on: new task assigned, studio spawned, PR opened, operator
`fleet watch on`.

### 3. Wave message — 8 fields, fixed

Same fields every wave. Empty field prints `—`. Never omit a field: absent
field is indistinguishable from forgotten field.

```
🎯 WAVE      EVENT(<what>) | SWEEP #n | FINAL
🏭 STUDIOS   name state/ready age · burn
📋 BOARD     tasks in flight · completed · backlog count
🔀 PRS       number, CI verdict, mergeability, action taken
✅ DONE      delta since last wave only. never restate
🚧 BLOCKED   what is stuck + exactly what it needs
🧭 NEXT      what maestro does now, unprompted
⏱️ NEXT      sweep at <ts> | STOPPED — quiescent
💸 SPEND     output tokens this wave / cumulative
```

Fixed set means diffable by eye AND parseable by machine.

**Destination.** Maestro comments each wave on one pinned board issue
`fleet: maestro wave log`. Durable, free, greppable. `fleet waves --tail`
reads that issue. No new storage.

## Staging

**Phase 1 — blueprint only.** Supervision contract into
`fleet/blueprint/studios/maestro/studio.md`: what maestro does when woken,
the 8 fields verbatim, quiescence rule, fail-CLOSED clause. Provable today —
operator types the wake prompt by hand, exactly what the 10-min loop does.
Zero Worker code.

**Phase 2 — the waker.** Webhook branch + sweep schedule + quiescence.
Replaces operator's hand.

Phase 1 first. If report format is wrong, find out while it is still prompt
text.

## Operator action required

Repo-level hooks empty (`gh api repos/acme-org/websites/hooks` -> `[]`).
Delivery is App-level. App must subscribe to events: **Issue comment,
Issues, Pull request, Check suite**. Same settings page as Workflows
permission.

Until ticked: webhooks deliver nothing, only sweep fires. Design fail-safe
by construction — sweep alone still catches everything, just at 20-min
latency.

## Cost

Cloudflare credits expire 2026-12-11. Use-them-or-lose-them. Container
uptime cheap.

Real cost is waking maestro — Claude tokens, not CF credits. Design
minimizes wakes, not uptime. Webhook wake fires only on real delta. Sweep
fires only after 20 min silence. Idle fleet reaching quiescence stops
entirely.
