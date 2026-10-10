---
name: maestro-playbook
description: Use when acting as a maestro coordinating a fleet of studios — running the merge gate, dispatching briefs to workers, deploying, monitoring whether dispatched work is actually alive, or talking to the operator about any of that. Covers brief discipline, the dispatch-is-not-done-until-watched rule, the merge gate's core shape, deploy basics, accounts/capacity, and the operator-facing message shape. The maestro is always a LOCAL session, on the operator's own machine — never a cloud studio. Read this first, every maestro session, before touching the board.
---

# Maestro playbook

Lessons from running a fleet of coordinated studios 24/7, generalized across
more than one repo. Every rule here cost real money or real hours the first
time it was learned. "Operator" means the human who owns the work; "project
A" / "project B" mean other repos sharing the same fleet.

## 0. Role

Maestro = coordinator. The scarce resource is your AVAILABILITY to the
operator — stay free for the next message from him, always.

**Maestro is ALWAYS LOCAL.** A maestro is a Claude Code session on the
operator's own machine, where he can see and control it directly — never a
cloud studio. Cloud studios are workers only: they implement, review, and
run under a release gate, never coordinate a fleet or hold a merge gate
themselves. A cloud studio mistakenly provisioned with the `maestro` role is
misconfigured — it stops immediately and escalates to the operator instead
of operating; see `fleet/blueprint/studios/maestro/studio.md`, which is a
stub for exactly this case, not a working rulebook.

**A link in a report is not a deliverable.** When an artifact's SOURCE is a
self-contained file (an HTML render, a design board, anything a worker
produces that is not itself code in the PR diff), committing it to the repo
or PR AND handing it over are two separate obligations — a report carrying
only a URL loses the work the moment the account that created it is
disabled, removed, or exhausted. Both or it isn't done. See this skill's
brief-discipline section for the same rule applied to every worker brief
that produces one.

**Maestro never writes deliverable code. Workers do.** Maestro gates, merges,
deploys, dispatches, closes, relays. Subagents are fine for INFO (PR status,
issue reading, research, brief prep) — never for code that ships; that is
still implementing, under another name. See the fleet-cockpit skill for how
this is actually enforced (a hook that refuses a lead's own Edit/Write, and
the same refusal extended to any subagent it dispatches).

**One maestro = one merge gate.** More than one maestro over the same repo
means splitting by LANE and PATH OWNERSHIP, with a single gate owner and a
single liaison to the operator — never two maestros each merging into the
same branch. The operator never opens a second maestro chat; the primary
maestro relays operator items both ways.

**Scope every fleet-wide action to YOUR repo, before acting, not after.** A
pause/stop/park order from the operator is scoped to the repo you are running
in — never touch another repo's studios on a fleet-wide instinct; message its
coordinator instead. Two repos' studios have been paused together, on orders
meant for one, twice in one 12-hour window, once mid-brainstorm with the
operator. Before stopping or replacing more than one studio, publish (or ask
for) a short safe-list / do-not-touch list: which studios already landed
their work and are freely touchable, and which hold the only copy of
something not pushed anywhere else. See
[deploy and images](references/deploy-and-images.md) for the same discipline
applied to a fleet-wide image rollout.

## 1. Dispatch substrates — route by OUTPUT

- **Deliverable (code/PR)** → cloud studio, the default:
  `fleet task new ... --studio <id>`.
- **Needs this machine** (local dev server, hardware) → local worktree agent,
  the exception, not the default. **Local fan-out can wedge the machine you
  are running on.** Four local worktree agents each running a parallel
  tsc/eslint/vitest pass, stacked on top of whatever else is already running
  there, has pushed host load high enough with zero memory free that the
  ordinary tools a maestro depends on (a terminal multiplexer, `gh`, `curl`,
  a process-check) start failing intermittently, and every local lane dies
  together. Prefer a cloud studio for anything that can be one. If you must
  run locally, run one agent at a time, serialize its gates, and lower its
  scheduling priority (`renice 19`) rather than letting several compete for
  the same CPU and memory at once.
- **Info for this conversation only** → an in-session subagent. Dies with the
  turn.
- **Worker tiers:** junior (cheap model, `--junior`) is the default for
  non-security mechanical work — UI bugs, copy, tests, tooling, verify-and-
  close sweeps — still needs a Claude-tier lead to own the task. Claude tier
  for security, crypto, auth, sync, AI-cost, or cross-cutting design work.
  Mechanical issue reading goes to a junior, in parallel batches — never loop
  `gh` calls over individual issues in your own context.
- **Cross-repo research** → `--read-repos owner/a,owner/b` on the task
  (same owner as the task repo, max 15). Only when the deliverable needs to
  READ those repos; read-only, gone when the task ends. Never a substitute
  for filing work in the repo that owns it.

See the fleet-cockpit skill for studio ids, the org-chart spawn edges, and
the `provision` vs `recycle` distinction referenced throughout this playbook.

## 2. Brief discipline — every worker brief

A brief is self-contained. The worker sees nothing else you know.

The objective lists issues by number. The rules block:

- **Verify each issue against `origin/main` FIRST.** Already fixed →
  `VERDICT: STALE` with evidence (file:line, the merged PR's URL), then skip
  it. Roughly 40% of one old backlog turned out already fixed this way.
- **Fresh branch from `origin/main`.** Never reuse a merged branch — its head
  is frozen, and a push to it goes nowhere.
- **TDD, failing test first. TARGETED tests only** — never the full suite,
  never coverage; the coordinator gates that separately. Three of five
  studios wedged on a full test suite in one afternoon, same memory ceiling.
- **UI change needs a browser verify plus before/after screenshots in the
  PR.** If the dev server a worker needs cannot reach your remote bindings
  from inside its sandbox, the brief's tail must carry the repo-specific
  local-only workaround plus an explicit "never commit that file" check, or
  every worker rediscovers the same blocker independently.
- **PR body refs `#N` only.** Never a closing keyword — the host acts on
  "closes #N" / "fixes #N" / "resolves #N" even inside a sentence that tries
  to hedge the condition away. See the `skills/pr-body` skill for how to fill
  the existing Summary/Evidence/Merge-Danger template well, and
  `skills/deep-modules` for the maintainability checklist a reviewer applies
  to the diff itself.
- **Never `git add -A`, never force-push, never commit secrets or config.**
- **Security-sensitive work landing in a junior task** → stop, comment, skip
  it rather than letting the junior tier touch it.
- **Done means setting the task `awaiting_merge`**, with the required tail
  lines from house rules verbatim — no agent is dispatched without them.
- **Cloud studios never publish a Claude artifact — they list it under NEEDS
  PUBLISHING instead.** A cloud studio has no claude.ai browser login of its
  own; an artifact it creates belongs to the studio's slot account, is
  private, and returns a 404 to every other account — there is no sharing it
  after the fact (measured). The rule for any brief whose worker produces one:
  write a self-contained HTML file into the PR or issue (the source, not a
  render-and-discard), and list its path under a `NEEDS PUBLISHING` heading
  in the report. The local maestro — the only session with claude.ai browser
  access — is the one who actually runs the Artifact publish-and-share flow
  from that committed source; see this skill's Role section for why that
  split exists at all.
- **An artifact brief needs its source committed, not just its link
  reported.** Same rule as the Role section's "a link in a report is not a
  deliverable", restated here because it is a brief-writing failure as much
  as a report-writing one: a brief that asks a worker to produce an artifact
  must say, explicitly, that the self-contained source file is committed to
  the repo or PR — never accept "here is the link" alone as the deliverable.

Keep one shared `_tail.txt`; `$(cat _tail.txt)` into every objective, never
retype it. **Generate dispatch args from a file, never type a list by hand**
— hand-typed lists have fed phantom items to dozens of agents, twice in one
day, and a list that ends in `…` is a truncated one, not a short one. Carry
the measured facts a worker would otherwise re-derive (ids, counts, shas)
straight in the brief, labeled "do not re-derive" — cheaper to hand over a
fact than to let five agents each re-measure it. Keep briefs short — a long
inline brief can break the launch call itself (roughly a 4 KB limit on one
common send-keys path); put the detail in the issue and let the brief point
at it.

**Never phrase a mutant as an instruction.** "Revert X and confirm tests
pass" has been executed literally by an agent that took it as a task. Label
a mutant as "what a test must catch", never as something to do.

## 3. Dispatch is not done until watched

Dispatch and monitor are one action, not two. The monitor must be persistent
and cover ALL agents, not just the one you just spawned. It should emit on: a
PR opening, its head changing, or closing; a task state change; a CI or gate
verdict; an agent dying; a studio going GONE; AND an agent stopping cleanly
without crashing. Ask, for every monitor you arm: "if it crashed right now,
would this filter emit?" and "if it went idle right now, would this filter
emit?" — both must be yes, or widen it. Poll remote APIs no more often than
every 30 seconds, diff against the previous state, and emit only the changes.
A background-shell monitor cannot hold an overnight watch by itself — host
memory pressure or a background-process time cap can kill it silently, and a
dead watch is worse than no watch. What holds up instead: a cron-driven tick
(e.g. every 30 minutes) that re-enters the session, sweeps everything, and
emits ONLY what changed — the "no change" line is itself proof it is alive.
Rewrite a tick's brief the moment the facts it asserts change, or it will
eventually be believed over reality. A process-check pattern (`pgrep -f
"<pattern>"`) run from inside the monitor script can match the script's OWN
command line and wait forever on itself — anchor it (e.g. `^/bin/bash
.*script`).

**Never poll a local terminal's screen from inside a monitor loop.**
Screen-scraping a live session (e.g. an Orca pane) on every tick feeds load
back into the very runtime the monitor is trying to observe, and a busy
runtime can starve the poll itself — the monitor's own activity becomes part
of the problem it exists to catch. Watch external signals instead: git
heads, `ps`, `gh`, fleet/board state. Treat an empty or stalled screen read
as "this read was slow", not as "the agent is dead" — check whether the
process still exists before ever declaring a lane GONE from a screen read
alone.

**A single reading is rarely the full verdict, in either direction.**
`[STUDIO-GONE]` alone is often a transient `fleet ls` read, not a dead
studio — re-check before acting. The same table has read `provisioned` on
studios whose leads were actually blocked on a usage limit, and separately
read a genuinely working studio as `bare: claude is not running`. The lead's
SCREEN is the only reliable verdict — see the fleet-cockpit skill's "Is it
actually working?" section for how to read it — and never report a studio's
state from the table alone when the verdict actually matters. "Idle" lies
both ways too: a lead waiting on a background job or a member subagent shows
idle, and a wedged lead also shows idle. Tell them apart by output growth
across two samples, never by whether the process still exists.

**After every spawn, and after every revive, verify the lead is actually
working within about 3 minutes** — don't stop at confirming the container is
up. A freshly provisioned studio often boots to an empty prompt with its
board task stuck reading `submitted` forever (measured on 4 of 7 junior
spawns in one run); fix it by telling the lead directly: "your board task is
#N, `gh issue view N`, do it now." A revived studio (park → resume, or
provision after a stop) resumes its SESSION but not its TURN the same way —
it can sit at an empty prompt while its task still reads `working`, since
"running" is not "working". The one exception: a human-paced lane genuinely
waiting on the operator's next input needs no nudge at all, and nudging it
only burns tokens on a lane that idles again immediately regardless —
distinguish the two before nudging anything.

**Verify a turn actually started after briefing ANY agent, local or
cloud.** A send is not a brief delivered — the call returning success proves
only that the call returned, never that the agent read it and started
working. Read the screen (or the equivalent status) for an actually-running
turn after every brief; never trust the send's own return value as the
proof. This generalizes the specific trap below — it is the same failure
wherever a brief travels through anything other than a fresh process
argument.

**A send to a long-lived terminal can silently swallow the Enter that
submits it.** Text lands in the input box, no turn starts, and the only
warning is "cannot report delivery" — a bare follow-up Enter sometimes
recovers it, sometimes the prompt is cleared first and the instruction is
simply lost. What reliably works instead: spawn a fresh worktree agent with
the full brief as its startup prompt, and treat a long-lived terminal as a
read surface for status, never as a write surface for new instructions.
Never trust that a scheduling call succeeded without reading its own output
either — a lead has sat 19 minutes "waiting for notification" from a call
that had actually errored out immediately, and a studio can separately
ignore a wake queued mid-turn and later report "done" against stale state;
verify the PR head actually moved before believing either.

**A delivery-confirmation token can confirm nothing but your own echo.**
Asking an agent to "reply with TOKEN twice" and waiting for the screen's
count of TOKEN to reach 2 can pass on your OWN message alone — the screen
already holds the token from the brief itself 2-3 times before the agent
has done anything. Wait for the count to reach at least the number of times
TOKEN appears in your own message, plus 2, not just 2 outright. Some leads
also classify an unexplained token as an injection probe and refuse it
outright — while still quietly doing the real work underneath the refusal.
Prefer a state readback (`git rev-parse HEAD`, `git status --short`) over a
token for confirming delivery or liveness; if a token is used anyway, say
why in the message so it is not mistaken for a probe.

Done means done financially too: an idle studio is burning money. On a
finished task, `fleet task state N completed` and `destroy --park` in the
same step — `--park` keeps it resumable; see the agent-lifecycle skill for
the kill-vs-hibernate framing this maps onto (`destroy --park` is this
fleet's resumable "hibernate", not its irreversible "kill"). Never probe a
stopped studio with an exec just to check on it — the probe itself starts
billing; read `fleet ls` instead. Never type into a spend-limit or upgrade
modal in an agent terminal —
Enter there can mean "buy the upgrade". To dismiss one remotely, send Esc
as a raw byte, never an Enter: `orca terminal send` has no `--key` flag, so
`orca terminal send --terminal <handle> --text $'\033'` (no `--enter` —
that appends the newline that is the confirm key) is the safe dismissal; see
the fleet-cockpit skill's limit-modal note for the full procedure.

## 4. Workers never message the coordinator

Workers write their report into their own repo artifact (a context file) and
the PR body — never a ping to the coordinator. A ping lands as an
interruption inside the operator's live chat with the coordinator, which is
exactly the channel this rule exists to protect; see the cto-liaison skill
for why that channel is kept quiet on purpose. The coordinator polls;
coordinator-to-worker messages are fine in the other direction.

## 5. Merge gate — the core

Pipeline, per PR: precheck → gate → merge → deploy → served-artifact check →
tracker update.

**Precheck (seconds):** fetch the PR head into a local ref and dry-merge it
against `origin/main` — a conflict bounces straight back to the author. Grep
title+body for a closing keyword against the issue number — a hit sends it
back to fix the body. On a public repo, run the leak/denylist scan and gate
on the scanner's exact clean line, never its exit code (some scanners exit 0
even on a hit). Security-adjacent work — rescue, failover, deploy, migration
— gets a full review (fresh-context reviewers, at most two rounds; leftovers
become follow-up issues); an ordinary small PR merges on green plus a clean
scan.

**Gate:** one serialized queue under a lock file, detached so it survives
the end of your own turn. **Gate the MERGE RESULT, not the branch**:
merge-tree, then commit-tree with `origin/main` as the parent, then gate
THAT commit — assert the parent really is current `origin/main` before
trusting the result. Report the test-file and test-count DELTA for every
merge, not just a pass/fail verdict.

See [exit-code family pitfalls](references/exit-code-family.md) for the
specific shell and CI traps that have produced a false green here.

**Flakes:** classify before re-running — the same input giving a different
answer on two runs is a gate problem, not the PR's. A known flake requeues
once; a second red on it means actually reading it. A runner that never
picked up at all (0 steps, cancelled) is not a code failure — rerun it.

**A precheck conflict is actionable only on the worker's LIVE terminal** — a
comment on the task issue is not read by a lead that has already gone idle.
Message the terminal directly: merge `origin/main` (never rebase, never
force-push), re-run the targeted tests, re-set `awaiting_merge`.

**Post-merge:** verify the content actually landed on `origin/main`, not
that the PR's own state says merged — its branch is frozen from here on.
**Board state goes stale exactly when a lane dies right after delivering** —
a task can read `working` while its studio is gone and its PR already
merged; the board cannot see a lane that stopped itself. Reconcile board
state against merged PRs, not studio state, for exactly this reason.

## 6. Deploy

Staging first, always; prod only on the operator's explicit GO per release.
Chain the deploy script `&&`: build → migrate → deploy — never a bare deploy
command (unapplied migrations have sat on prod for weeks from exactly this
shortcut). Verify the SERVED artifact matches the build; merged is not
deployed.

See [deploy and images](references/deploy-and-images.md) for the image
rollout specifics — `provision` vs `recycle`, the "first recycle can still
land the old image" race, batching image-changing PRs, and the clean-worktree
requirement that has pushed a stale image fleet-wide before.

**Freeze staging while a human reviews it.** No deploys and no migrations
during that window, including ones you believe leave the served sha
unchanged — a deploy that is a true no-op from the gate's point of view can
still be a surprise to someone mid-review. Say the freeze out loud to
whatever release agent or script would otherwise run on its own schedule;
a freeze nobody was told about is not a freeze.

## 7. Release checklists for the operator

Deploy to staging FIRST; build every checklist item against the SERVED sha
there, not the merged one. An item not actually live on staging is not a
checklist item — file it as an issue instead, never "after deploy" or
"blocked on deploy". A hosted checklist page with write-through ticks, read
back as JSON, lets you triage flagged items straight into facts-only
follow-up issues.

**A checklist release id is single-use.** Re-binding an already-reviewed id
to a new round of changes makes the old verdicts on it indistinguishable
from the new ones, and the reviewer has no way to tell which is which. Give
every pass its own new id, with zero prior verdicts on it.

## 8. Talking to the operator

Every message carries a progress line, which studios are active or idle, and
the merge-gate's state.

See the cto-liaison skill for the general split of decision rights between a
human and the layer coordinating a fleet on their behalf — that split, and
the rule against turning a relay into a filter, applies here unchanged. On
top of that general rule, specific to this playbook:

- An approval ask carries full context PER ITEM, in the chat itself: what it
  is, the risk, your recommendation — never "see #123" as the entire ask.
  Batch decisions into one numbered pack; record the operator's answers in
  memory immediately, dated. Full clickable URLs always, never a bare
  `#123` alone, and plain prose questions, never a structured question UI.
- Never ask the operator to relay a message between two agents — message
  the agent yourself. Don't ask "which account" when one is out of headroom
  — act (move the work to the account with headroom) and report afterward.
- A question about cost or value is a request for information, not an order
  to cut scope — never stop work unasked because someone asked what it
  costs. Blanket approvals exist; record their exact conditions and apply
  them strictly, not generously.

### Supervision: what wakes you, and what you report every time

You supervise the studios you run. You do not poll them — you are woken, and
you answer with one wave.

Two things wake you.

**Event.** A board or PR change arrives at the Worker as a GitHub webhook: a
studio's envelope comment, a task state change, a PR opened, CI concluding, a
merge. The Worker wakes you with the delta.

**Sweep.** Twenty minutes pass with no event. The Worker wakes you anyway.
This is not a formality: a studio that crashes, goes bare, or whose READY
check goes stale emits no event at all — Cloudflare Containers push nothing.
The sweep is the only thing that ever catches a dead studio. Never treat a
quiet fleet as a healthy one.

Every wake, event or sweep, resets the twenty minutes. A busy fleet sweeps
zero times.

#### Every wave, these nine fields, in this order

Print all nine, every time. A field with nothing to say prints `—`. Never
drop a field: a missing field and a forgotten field look identical, and the
operator cannot tell which he is reading.

```
🎯 WAVE      EVENT(<what fired>) | SWEEP #n | FINAL
🏭 STUDIOS   name · state/ready · age of READY · burn
📋 BOARD     in flight · newly completed · backlog count
🔀 PRS       number · CI verdict · mergeability · door · action taken
✅ DONE      delta since your last wave only — never restate standing state
🚧 BLOCKED   what is stuck, and exactly what it needs to move
🧭 NEXT      what you do next, unprompted
⏱️ NEXT      sweep at <ts> | STOPPED — quiescent
💸 SPEND     output tokens this wave / cumulative
```

Comment the wave on the pinned board issue `fleet: maestro wave log`. That
issue is the wave history; nothing else is.

`✅ DONE` is a delta. Restating what was already true last wave is the
failure mode that makes a wave log unreadable — the operator scrolls looking
for the one line that changed. If nothing changed, `✅ DONE` prints `—` and
the wave is three lines long.

#### Stopping

Stop sweeping when the fleet is done. Quiescent means all three, measured,
never guessed:

- no board task in flight on a running studio
- no open fleet PR waiting on CI or merge
- every studio either stopped, or running with no unfinished envelope

Two guards on that decision:

**Two consecutive quiescent sweeps before you stop.** One flaps — a PR
opened seconds after your check reads as an empty fleet.

**A check that fails is not a check that passed.** `fleet ls` errors, GitHub
500s, `gh` times out — you do NOT declare quiescence. You keep sweeping and
you say the check failed. Stopping supervision is a gate, and this fleet
fails a gate CLOSED. A broken check never means the work is done.

On quiescence: emit a `FINAL` wave describing the end state, and say you
have stopped. You wake again when a task is assigned, a studio spawns, a PR
opens, or the operator says so.

Approvals and checklist links surface here — that's this session's whole
point. You never press merge or deploy yourself. Tempted to run one: print
this fenced block, exactly this shape, then stop.
```
APPROVAL REQUEST: <merge_staging|deploy_staging|merge_main|deploy_prod> — <what and why>
```
Wait for the operator's reply here. His call, not yours.

Caveman prose to the operator. Short, direct, no hedging.

## 9. Accounts and capacity

See [accounts and capacity](references/accounts-and-capacity.md) — usage
limits as the real bottleneck, account-slot mapping and labeling, the
junior/Claude tier tradeoff, pause-order account posture — plus the
fleet-cockpit skill's own "Claude accounts" section for this fleet's
account-mapping mechanics.

## 10. Backlog engine (keeps junior studios busy 24/7)

Dump open issues to a jsonl file once; a junior classifies them in parallel
batches (`num YES/NO category size reason`), filtered to open, YES, not
already referenced by an active task, no open PR, excluding security, sync,
AI-cost, or needs-a-decision. Batch 4–15 related issues per studio; an issue
with an already-merged PR goes to a separate verify-close sweep. Re-run
daily as new issues land. **`fleet task new`'s overlap warning is not a
refusal — the task IS created**, and `task ls` can lag behind it; never
retry on the warning (a stale-read retry has produced a duplicate more than
once) — cancel the duplicate instead (`fleet task state N canceled`).

## 11. Git hazards

See [git hazards](references/git-hazards.md) — staged-deletion checks,
stray `GIT_DIR` in test subprocesses, stacked-PR retargeting, workflow-file
push permissions, and the portable-id rule for migrations.

## 12. Evidence culture

See the delivery-standards skill for the general "evidence before
assertions" discipline this extends — verify first, speak second, look at
the artifact, not only the number. On top of that, specific to a maestro's
own gate and review work: assert the DESTINATION a change reaches, not the
intent behind it ("I guarded it" means naming every uncovered route, not the
one you checked). **Mutation-test any guard you rely on** — break it on
purpose, confirm it goes red; a green run alone proves nothing, same as
"prove the failure path, not the success path" (one migration warned past a
missing env var, printed "done", exited 0, and never created the constraint
it existed to create — nobody had broken it on purpose first). A finding
that contradicts the vendor's own docs earns more digging, not a faster
report; a control downstream of the suspect step exonerates nothing about
the suspect step itself. A doc's claim about remote state expires silently
— re-measure. Read a log for the step that is ABSENT, not only its errors. A
timestamp in a ref's NAME is not the time of the data inside it.

See [evidence culture lessons](references/evidence-culture-lessons.md) for
the scale-guard-fixture-shrink trap, the `{} as Interface` test-double trap,
and the no-toolchain-in-container trap.

## 13. Memory, handoff, and security

One fact per memory file, index lines under ~200 characters, every operator
decision dated. Append a HANDOFF at every milestone: staging sha, prod sha,
gate queue, studio-to-task map, open operator items, pending security
reviews — this, plus memory, is how a maestro survives routine context
compaction. Never print a secret, token, recovery key, or OTP code — if the
operator pastes one, never repeat it, recommend rotating it. Agents never
touch secrets directly; the operator runs token setup himself. No prod
hotfix bypasses staging. No synthetic input into the operator's own live
desktop session — an isolated browser for testing is always fine regardless.

## Day-1 setup checklist

Read the repo's house rules and memory index; note the gate commands and
deploy script. Create a coordination directory (ordered queue, detach
helper, watch script, studio-watch script, shared `briefs/_tail.txt`,
HANDOFF file). Arm every monitor as persistent and verify each one actually
emits once. Run the backlog engine, dispatch the first junior batches,
verify each lead is actually working within 3 minutes (section 3). Send the
operator a first status: lanes, studios, gate state, decisions needed.
