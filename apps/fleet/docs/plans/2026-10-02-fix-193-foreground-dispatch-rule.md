# Fifth "never block on nothing" rule: dispatch a member in the foreground when its result is needed (board issue #193)

## The bug

2026-10-01 21:35Z on web-studio/#187: the lead dispatched a backend-developer
member via the Agent tool's default (`run_in_background: true`), then ended
its own turn to wait for the completion notification. `gates/completion-gate.sh`
(a Stop hook) correctly refused the stop each time — no
`/workspace/.fleet/done/<task>.json` existed yet, because the work genuinely
wasn't done (`gates/completion-gate.sh:184-191`). But each such idle stop
still burned down `MAX_REFUSALS` (5, `gates/completion-gate.sh:51`). At the
cap, the gate "stands down" — `exit 0`, allows the stop
(`gates/completion-gate.sh:86-90`) — by design, documented right above it
(`gates/completion-gate.sh:47-51`): "An UNBOUNDED Stop hook can wedge a
studio into an endless stop/refuse loop with no human near it, which is
worse than the drift it prevents." The allowed stop ended the lead's turn,
which killed the still-running background member mid-task. Zero commits,
~10 minutes of work lost.

## Why the fix is prompt discipline, not the gate

`gates/completion-gate.sh` is a stateless bash/python Stop hook. It has no
access to the Claude Code harness's own in-memory subagent registry, so it
cannot tell "a member I dispatched is still genuinely running" from "the
lead is just stuck on nothing." Its stand-down-at-cap behavior is correct
and intentional, not the bug — and it is also a one-way-door path
(`apps/fleet/scripts/merge-danger.ts`'s `ONE_WAY_GLOBS` lists `gates/**`),
out of scope for this fix regardless.

The real bug is upstream: a lead should never create the idle-wait turn in
the first place. The fix is to teach every lead, via the always-on house
rules, to dispatch a member in the FOREGROUND (`run_in_background: false`)
whenever it needs that member's result before continuing — which is almost
every implementation/verification step — so the Agent-tool call itself
blocks and the turn never idles waiting on a notification that might never
arrive, or that arrives after the gate has already stood down.

## Where the fix goes

`apps/fleet/src/studio/blueprint.ts`'s `HOUSE_RULES` array is the single,
always-on prompt text shared by every role (maestro, pilot, scratch, every
studio lead) — see `apps/fleet/test/houserules.prompt.test.ts`'s own
comment: "HOUSE_RULES is the ONLY always-on copy maestro, pilot and scratch
ever see — no studio.md gate paragraph behind it." This bug can hit any
role that uses the Agent tool, not just web-studio's lead, so the fix
belongs here, not in `fleet/blueprint/studios/web-studio/studio.md`.

The existing `"## House rules — never block on nothing"` section (issue
#85: "Four always-on rules, one per measured deadlock") already covers four
measured lead deadlocks: waiting on a notification instead of reading the
output, waiting on a job that is already dead, using `AskUserQuestion` in a
studio, and using `LEFTHOOK=0` to dodge a refused push. Issue #193 is a
fifth measured deadlock in the same family (an idle turn, waiting on
something that may never resume it) — add a fifth rule to this same
section, right after the fourth rule's trailing blank line, and update the
section's leading doc-comment from "Four always-on rules" to "Five
always-on rules, one per measured deadlock", noting what #193 added.

## Test plan (TDD)

In `apps/fleet/test/houserules.prompt.test.ts`, add a new `it(...)` to the
existing `describe("HOUSE_RULES — a lead never blocks on nothing (issue
#85)", ...)` block, pinning the new rule's full sentences via
`collapseWs(HOUSE_RULES)` regex matches — the same convention every other
`it` in that describe block (and this file's own stated reason for it,
above the "one branch per studio" block: a lone keyword match stays green
even when the whole instruction is deleted) already uses.

1. `cd apps/fleet && bunx vitest run test/houserules.prompt.test.ts` — RED,
   confirm it fails because the new rule's text does not exist yet.
2. Add the fifth rule's text to `HOUSE_RULES`, after the fourth rule.
3. Re-run the same single-file command — GREEN.

No full suite, no build — scoped to this one file for this pass; full-suite
verification is a later, separate step.
