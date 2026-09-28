# firstmate — exhaustive analysis, what transfers to our fleet

Date: 2026-09-05. Source: `github.com/kunchenguid/firstmate` @ shallow clone, 200 commits.
Method: 6 parallel readers, disjoint slices, code-first. Every claim below cites
`path:line` in THEIR repo or ours. Docs-vs-code conflicts resolved to code.

## 1. What it is

OSS "agent distro". Not app, not harness, not CLI. Clone repo, launch agent
inside it, `AGENTS.md` takes over. One "first mate" agent runs a crew of
autonomous agents, each in own tmux window + git worktree. Human = "captain",
talks only to first mate.

Same problem as our fleet. Local-first instead of cloud containers.

| metric | value |
|---|---|
| stars / forks | 4,805 / 1,564 |
| license | MIT |
| created | 2026-06-12 |
| merged PRs | 3,767 (12 weeks) |
| issues | 360 open / 169 closed |
| shell scripts | 355 (172 in `bin/`) |
| tests | ~190 `.test.sh` |
| `AGENTS.md` | 594 lines, 75KB, ~18.8k tokens, ALWAYS loaded |

158 of last 200 commits from one human. Author builds firstmate with firstmate.

### Ecosystem — split by WHO EXECUTES

Same author, three MIT repos:

| repo | stars | lang | owns |
|---|---|---|---|
| `no-mistakes` | 8.3k | Go | validation gate |
| `treehouse` | 1.6k | Go | worktree lifecycle |
| `firstmate` | 4.8k | Shell + Markdown | agent layer |

Deterministic mechanics compile to Go binaries. Judgment stays shell + prose.
`VISION.md` states it as law: "Logic that can be exact lives in deterministic
scripts; work that requires understanding lives in an agent; the two never mix."

Answers our repo-split question independently. Split by executor — machine or
model — not by feature.

## 2. Confirmed defects in OUR code

Each verified directly against our tree, not inferred.

### 2.1 Envelope artifacts are unverified claims

`src/board/envelope.ts` validates artifact SHAPE only — needs `kind`, needs one
of `path|pr|url`. No consumer reads them: only `src/board/types.ts:251` (the
type) and prose at `src/studio/ff.ts:100`.

Studio reports `{kind:"pr", pr:"#999"}` for nonexistent PR. Worker records it as
fact.

firstmate has same hole one layer down: `state/<id>.status` is unlocked `>>`
appended by an LLM, no signature, no lock. Worker can write
`done: PR ... checks green` with no PR.

Fix: Worker GETs the PR before accepting. `src/github/api.ts` already reaches
`pulls/`.

### 2.2 SessionStart hook is compaction-blind

`apps/fleet/container/studio-bringup.sh` never reads hook payload `source`
field. No `compact` branch, no `resume` branch. Lead compacts mid-task, nothing
replays working set.

firstmate fix: `bin/fm-sessionstart-run.sh:130-144` routes on source.
`clear|compact` → `fm-session-start.sh --reemit`, which replays memory files,
fleet inventory and wake queue while skipping 6 mutating sweeps. Re-prints full
`AGENTS.md` when its SHA-256 baseline drifted (`:213-218`).

They register NO `PreCompact` hook; a test pins its absence
(`tests/fm-cursor-primary.test.sh:655`). Compaction is a session-open event, not
its own lifecycle.

### 2.3 Our test suite pins the pipe-with-no-water bug as correct

`apps/fleet/test/studio.session.test.ts:121` comment reads: "gate never asks a
studio for `learnings`". Tests at `:1442` assert the HARVEST side degrades
gracefully when field absent. Absence encoded as expected behavior.

firstmate catches this class in one assertion pair
(`tests/fm-ask-user-authority.test.sh:21-30`): run the real generator, then
`assert_grep` produced text CONTAINS required sentence, `assert_no_grep` it
retains contradicting OLDER wording. Positive + negative on generated agent
instructions.

### 2.4 PreToolUse matcher is a fixed list

`studio-bringup.sh:610` — `"matcher": "Edit|Write|NotebookEdit|Bash"`. New
write-capable or delegation-shaped tool walks past.

firstmate hit this live. `docs/subagent-guard.md:15-27`, 2026-07-22: lead ran 4
workers through built-in subagent tool. Fleet showed zero work, 2 died on
restart, supervision down 73 min. Their fix: matcher `.*`, test tool-NAME shape
against a stem list, because "the failure is precisely the absence of that
metadata."

### 2.5 Embedded snippets never executed by a test

Only `test/cli.fleet.test.ts` spawns a subprocess. Our python/bash living inside
TypeScript strings is never run.

## 3. Steal list, ranked

### Tier 1 — closes a verified defect, small build

1. **Worker verifies envelope artifacts.** §2.1. Reject `intent=result` whose
   claimed PR 404s.
2. **SessionStart routes on `source`; `compact|clear` → re-emit digest.** §2.2.
   Cheapest fix for context loss.
3. **Generated-prose assertions** (`grep` + `no_grep`) over gate HOWTO. §2.3.
4. **Extract-and-execute embedded snippets in tests.** Model
   `tests/fm-turnend-guard.test.sh:850-873` — jq the command out of tracked
   config, write to temp file, run with real payload on stdin. Run it in a
   subshell and assert PARENT SURVIVES: that single assertion catches the
   `exit`-kills-shared-sandbox-session bug.
5. **PreToolUse matcher tests tool-name SHAPE, not a list.** §2.4.

### Tier 2 — the supervision build

We have no watcher. Operator polls `fleet ls`. This tier is the largest gap and
firstmate's deepest work — but see §5.1: do NOT port their architecture.

6. **DO alarm as the watcher.** Studio writes heartbeat; DO alarm compares age
   vs grace; "supervision needed" = assigned open issue exists. Closes
   alive-but-bare.
7. **Absorb only on positive evidence.** `bin/fm-classify-lib.sh:1723-1735` —
   absorb requires `state: working` with `source: run-step|pane`. Missing,
   malformed or stale busy-state classifies UNKNOWN, never idle. Default is
   surface. Silence is never proof of health.
8. **Unknown is not dead either.** `fm-crew-state.sh:193-196` — unreachable host
   emits `unknown remote-endpoint "(not proof of death)"`. Never reap on
   unreachable.
9. **Filesystem-write probe as third liveness input.** `fm-classify-lib.sh:1770-1798`,
   depth 6, 10s timeout, prune list. Writes → defer. No writes → escalate. Sees
   work a quiet UI hides. Translates to container unchanged.
10. **Escalating payload, not just escalating frequency.**
    `bin/fm-watch.sh:781-790` — at N repeats the reason itself carries
    `demand-deep-inspection`.
11. **Never auto-restart a wedged worker** (`bin/fm-watch.sh:55-58`). Escalate to
    human. Same logic as lead-never-implements.
12. **Out-of-band alarm when the escalation channel is stuck.**
    `bin/fm-supervise-daemon.sh:947` fires when a buffered digest stays
    undelivered past 300s — i.e. supervisor itself wedged. Channels deliberately
    outside the fleet: macOS `osascript`, or `command:<cmd>` to a pager.
    Their example pushes to `ntfy.sh`. Default-ON. We have zero liveness
    alerting; the operator's phone is the right sink.
13. **Block budget below the harness cap, then one loud fail-open.**
    `fm-turnend-guard.sh:88` budget 3, deliberately below Claude's own 8-block
    cap. Stops a guard becoming an infinite loop.

### Tier 3 — architecture

14. **Delivery decoupled from model obedience.** The script that RECORDS an
    outcome publishes it; the model never carries it.
    `bin/fm-parent-channel-lib.sh:99-144` — append-once by exact-string
    `grep -Fqx`, folded to one line, cut at 1200 chars. Born from an incident
    (`docs/secondmate-parent-channel.md:10-16`, 2026-09-02): four outcomes lost
    because a mate addressed "captain" in its own chat. Every recording script
    publishes: `fm-pr-check.sh`, `fm-merge-outcome-lib.sh`, `fm-teardown.sh`
    (which REFUSES removal while undelivered).
    Our board posts today depend on a studio remembering.
15. **Event log is not state.** `bin/fm-crew-state.sh:4-9` — `<id>.status` is an
    append-only EVENT LOG; `tail -1` goes stale the moment a gate resolves.
    Deterministic reader with authority order (`:20-64`): run-step matching
    branch AND head identity → pane busy signature → log tail only if its verb
    maps. Our labels are an event log too; our READY-vs-STATE trap is the same
    bug. One Worker endpoint returning `state·source·detail`.
16. **Gate at the choke point, not in the session.** `no-mistakes` is a git
    REMOTE: `git push no-mistakes` → disposable worktree → review/test/docs/lint
    → forwards to real remote and opens PR only when green. An agent cannot skip
    it by ending its turn differently, by being a subagent, or by hook
    misconfiguration. Our Stop gate is inside the agent's own session and has all
    three holes. We already hold half this insight (Worker is sole writer of task
    state); we never applied it to QUALITY.
17. **Single DoD owner, rendered everywhere.** `bin/fm-dod-lib.sh:177-232` owns
    each mode's definition-of-done text; both `fm-brief.sh` and `fm-promote.sh`
    render from it, so a promoted worker cannot inherit a weaker contract.
    Ours: Stop gate and brief and issue-adoption must render from one source.
18. **Machine-readable contract line the spawner re-checks.** Brief opens DoD
    with fixed line `Delivery contract: mode=<mode>`; `fm-spawn.sh:10-14` re-reads
    it and REFUSES launch on mismatch with its own `--mode`. Brief and record
    cannot drift.
19. **Durable inbox + dumb doorbell.** `fm-task-inbox-lib.sh:14-56` — payload on
    disk, terminal gets one fixed line, ack = `mv` to `handled/`, bounded
    re-ring ladder. Replaces fragile text-into-container steering; survives a
    dropped WebSocket.
20. **Fused record+board transition under one lock**, with a durable
    pending-close marker for the single crash window
    (`fm-backlog-transition-lib.sh:7-13`), replayed at session start.
21. **`paused:` vs `blocked:` verb split** (`fm-classify-lib.sh:80-91`). A
    DECLARED external wait is absorbed on a cadence, never wedge-escalated.
22. **Routing index for always-loaded text.** `AGENTS.md:544-564` §13 — 13 skills
    behind CONDITION-shaped triggers ("load before scoping a reported bug").
    258KB of skill text deferred behind ~1.5KB of triggers. Stated policy
    (`firstmate-coding-guidelines/SKILL.md:58-64`): "AGENTS.md's token cost is
    paid by every session of every fleet member, every time. A skill's cost is
    paid only by the sessions that actually load it."
23. **Reinforcement requires named evidence.** `.agents/skills/stow/SKILL.md:99`:
    "reinforcement requires independent evidence from this session that you can
    name in the receipt; plausibility, importance, prior knowledge, and the
    entry's own text are not evidence." Entries carry `<!--a:YYYY-MM-DD-->`
    refreshed only by a session that USED them. Still unenforced — but it makes
    usefulness LEGIBLE, which is our problem (b): nobody cites a memory file, so
    promotion and decay can never fire.
24. **Memory budget as a number with a verdict.**
    `bin/fm-startup-memory-budget-lib.sh:12` — cap 7500, unit `ceil(bytes/3)`.
    ~40 lines of bash. Paranoid parser rejects symlink, hardlink, multiline,
    leading zero. Per-home, NEVER summed across homes.
25. **Cold archive is a MOVE with provenance**, never budget-counted
    (`stow/SKILL.md:134-146`). Provenance line carries source file, tier,
    reinforced date, reason. Recovery = grep + copy back. Makes pruning safe
    enough to actually do.
26. **Convergence precondition** (`stow/SKILL.md:115`): total the eligible pool
    FIRST; if evicting all of it still misses budget, evict NOTHING and escalate.
    Prevents "trimmed 30 files, still over."
27. **Pre-teardown persistence request.** `bin/fm-secondmate-restart-lib.sh:38`
    asks a dying agent to persist open work held only in that conversation — and
    explicitly says "Do NOT run the memory, learnings, or captain-preference
    sweeps," because bundling curation would make every reload cost far more. We
    rescue-push code and harvest `learnings[]`; we never ask what open work
    exists only in the lead's head.
28. **Read-once contract** (`fm-session-start.sh:774-790`), printed BEFORE its
    subject, naming the escape hatches: "re-reading everything defeats the entire
    point of this command."
29. **Doctor with `fixable:` / `human:` / `action:` line protocol**, re-derived
    after `--fix` so a repair is never trusted on its own word. Exact fit for our
    Directus cutover: `ff doctor` prints token, network, image-digest gaps and
    the operator step.
30. **Argv-only remote protocol.** `fm-on.sh:103-120` sends base64 NUL-delimited
    argv, never a command string. Command must be tracked, executable,
    non-symlink — checked on BOTH ends. `env -i` with filesystem-discovered PATH;
    no shell startup file ever evaluated. Our container exec should take
    `{cmd, args[]}` from a fixed namespace.
31. **Sentinel-code no-failover.** `fm-spawn.sh:1076-1083` — exit 3 means ONLY
    "not my route"; every other failure aborts and never silently falls back to
    local. Cheap, auditable.
32. **CI invariant: private paths are never tracked.** `ci.yml:426-434` asserts
    `git ls-files -- data state config projects` is empty. One job. Directly
    useful for our OSS packaging.
33. **Declarative dispatch routing.** `docs/examples/crew-dispatch.json` maps
    task shape → harness/model/effort, with an ARRAY of alternatives resolved by
    quota. Ours is one hardcoded ternary
    (`ROLE_EFFORT: studio.effort ?? (name === "maestro" ? "max" : "")`).
34. **Concurrency as an earned, archived proof.** Admission to the parallel test
    lane requires a RECORDED passing proof; `--check-coverage` refuses if the
    runner's embedded set diverges from `--list`. Never retries a failure into
    green.
35. **`.greptile/rules.md`** — precedent store, so an argument won on one PR is
    not re-litigated on the next.

## 4. Where we are already ahead

- **Our gate fails CLOSED.** `studio-bringup.sh:578-608` — script deleted (127),
  chmod lost (126), wrong `$HOME` all exit 2 and refuse. firstmate fails OPEN
  nearly everywhere: missing `jq`, empty stdin, malformed payload → exit 0.
  Cursor's stop hook cannot block at all; Grok discards hook stdout.
- **Their hard rule 1 has no hook.** "Never write to a project" is their
  most-cited safety boundary — cited 4× — and there is NO `Edit|Write` matcher in
  `.claude/settings.json` and no `permissions.deny`. Honor system. We enforce
  ours.
- **Worker is the sole writer of task state.** Their status log is unlocked, LLM
  appended, unsigned.
- **Their merge authority is fiction.** Verified: `fm-pr-merge.sh` contains zero
  `yolo` occurrences; the one in `fm-merge-local.sh` is a comment (line 8). No
  merge script reads the autonomy flag. Any agent holding the CLI merges.
  `architecture.md:95` claims local-only lands "after an approved fast-forward
  merge" — no approval is verified.
- **A DO alarm is an out-of-session watchdog they structurally cannot have.**
  See §5.1.
- Real board (GitHub Issues) vs markdown + awk registries.

## 5. What NOT to copy

### 5.1 Their watcher architecture

Their supervision DIES WITH THE SESSION. The watcher is a grandchild of the Stop
hook; Claude's teardown kills arm and watcher together
(`bin/fm-claude-stop-autoarm.sh:36-37`). Close the terminal: crew keeps running,
nobody watches, NOTHING alarms. No watchdog on the watcher's absence outside a
live session. Their own reading: firstmate does not solve the gap, it relocates
it into the session.

A Durable Object alarm lives outside every studio, survives every container
death, and is single-threaded — so the lockdir + PID-identity + process-ancestry
machinery they need is unnecessary for us. `bin/fm-arm-command-policy.mjs` alone
is 38KB of blessed-command-tree policy that exists ONLY because the model arms
the watcher. If the DO arms, none of it is needed.

Port the CLASSIFIER (§3 items 7-12). Not the plumbing.

### 5.2 Their headline claims do not survive the code

- **"Event-driven"** — push exists for ONE backend (herdr,
  `bin/fm-backend.sh:927-932`). Default is `sleep 15` (`bin/fm-watch.sh:1331`).
  README:50 and `architecture.md:11` both say "sleeps on the fleet".
- **"Zero-token supervision"** — honest for IDLE. Detection and classification
  are bash end to end, verified. But every actionable wake costs a turn, and the
  protocol mandates drain → handle → `--ack-through <SEQ>`, so ≥1 extra turn per
  event. Accurate claim: zero-token idle.
- **`/stow` "enforces each home's budget"** (README:179) — it enforces nothing.
  `fm-startup-memory-budget.sh` prints `over-budget` and returns 0.
- **Decay and cold archival** — described, never coded. Zero lines parse a tier
  marker. `grep -rn '<!--a:' bin/ tests/` is empty. The tick, stale check,
  archive move, provenance line and eviction order are all the model editing
  markdown and self-reporting.

### 5.3 Structural choices wrong for us

- **75KB always-loaded `AGENTS.md`** — ~19k tokens per session per agent. Their
  own guideline's founding fact is 585 → 958 lines of drift.
- **355 bash files, 5 runtime backends, 10 harnesses.** We ship one container
  runtime and one harness. Adopt the seam SHAPE, not the matrix. Adding a backend
  there means edits in ~9 files.
- **Pane-hash liveness** (`fm-watch.sh:1831-1832`). No pane in a container. They
  quarantined rendered-text classification to Grok alone for this reason.
- **Treehouse worktree pool.** Laptop optimization; containers are our isolation.
- **Markdown + awk registries** and a markdown backlog.
- **`--dangerously-skip-permissions` / `--yolo` on every harness.** Safe only
  because a human owns the tmux pane. Our studios are unattended.
- **Third-person nautical persona + captain-address mandate.** Token tax. Ours is
  caveman.
- **Pass-horizon `/N` counters** in memory markers — model does arithmetic over N
  markdown entries every pass. Silent-corruption machine. Take the date, skip the
  counter.
- **`FM_GATE_REFUSE_BYPASS=1` exported by `tests/lib.sh:36`** — a global
  guard-disable in the shared test helper, with one test standing between the
  bypass and every other suite.
- **`FM_ALLOW_SUBAGENT=1`** disarms the delegation guard from the environment.

### 5.4 Their Relay is not safe — do not adopt it for the phone path

Relevant because we want phone-driven fleet control. Local code gates for a
public X/Discord mention driving an agent are, in full: token present → shim byte
identity → non-empty text → request_id slug → offer dedupe. No author check, no
allowlist, no approval, no sandbox exists in `bin/`. "Owner-only routing… never a
stranger" is asserted SERVER-SIDE at their hosted endpoint and is locally
unverifiable. `fm-x-poll.sh:159-160` stashes the network object verbatim and
`SKILL.md:30` then defines that text as "a real instruction from the captain — to
act on", authorized up to shipping through the gate.

Measured holes:
- **Cap bypass confirmed.** Relinking the same task with no carry flags resets
  `x_followups=0` and `LINK_TS=now` (`fm-x-link.sh:217-227`). Cap AND window both
  reset. Cap is per-task-link, not per author or thread, so each new mention buys
  a fresh 3.
- **Window is env-raisable with no ceiling** (`fm-x-followup.sh:102-105`). The
  604800 clamp governs only context pruning.
- **`FMX_RELAY_URL` scheme unvalidated** (`fm-x-lib.sh:259-265`) — `http://`
  sends the bearer token in cleartext.
- **Media-host allowlist is doc-only** — the hosts appear in `SKILL.md:120-125`
  and nowhere in `bin/`. Model-enforced SSRF control.
- **No local rate limit.** 30s poll → up to 2,880 agent turns/day, each able to
  spawn crewmates.
- **Voice has no authentication** beyond SSH reachability
  (`fm-voice-client.py:178`). Anything writing that stdin is "the captain". Scope
  is narrow — read records, queue a note — which is the only mitigation.

Our Mosh + Tailscale + Directus path is stronger. Keep it.

## 6. Their open issues are our failure catalog

Independently derived, same system class. 361 open, theme counts:

```
lock 42   watcher 37   worktree 33   supervis 30
wake 24   stale 22     teardown 19
memory 1  stow 2       bearings 2
```

~40% of unresolved bug mass is supervision machinery. Memory generates ~zero
issues — consistent with §5.2: prose cannot fail loudly.

Ones we have hit verbatim:
- "Firstmate workers load a supervisor-only root AGENTS.md that contradicts their
  assigned role" — our lead-vs-member contract collision. We fixed it by keying
  PreToolUse on `agent_id`.
- "Teardown landedness uses stale remote refs and ignores stash entries" — our
  rescue-push, same bug class. Note THEIR teardown has no rescue at all: dirty
  worktree is REFUSED (`fm-teardown.sh:1500-1502`), `--force` discards outright.
- "fm_pid_alive treats zombies as live and preserves dead supervision ownership"
  — our STATE-column-lies problem.
- "Two live sessions on one home block every turn end forever: the fail-open
  guard's silent identity refusal never records the failure the guard's fail-open
  requires" — a fail-open CHECK that cannot report its own failure. We ruled the
  asymmetry (gate fail-closed, check fail-open) but never checked the recording
  path.

Ones we have no answer to at all:
- "Add fan-out and cost ceilings with machine-checkable loop stops."
- "Document and bound unintended secret inheritance at worker launch."

## 7. Strategic contrast

| | firstmate | our fleet |
|---|---|---|
| shape | distro — clone the repo, run an agent in it | hosted Worker + containers |
| setup | `git clone`, launch harness | Cloudflare account, Worker deploy, auth |
| isolation | git worktree on the laptop | container per studio |
| supervisor | bash watcher inside the session | none yet; DO alarm is the right home |
| survives laptop close | no | yes |
| board | markdown file, pluggable backend | GitHub Issues, Worker sole writer |
| audience | "empowers exactly one individual" | an agency, multiple operators |
| depth | capped at 2 layers, deliberately | captain → maestro → lead → member |

`VISION.md`: "The command structure stays flat: every layer between the captain's
intent and the acting agent costs fidelity and tokens, so depth is capped, not
grown." We run four layers. Worth defending or shortening — not ignoring.

Their setup story is better and it is a deliberate architectural choice, not
polish. Ours cannot match it while the runtime is a hosted Worker; that is the
honest cost of surviving a closed laptop.

## 8. Lines worth keeping

From `VISION.md`, stated better than we state them:

- "trivial is a guess" — why the lead never implements.
- "Evidence is never authorization: a diagnosis, a report, or a recommendation
  authorizes nothing by itself."
- "Unlanded work is never torn down; a refusal to discard is a finding, not an
  obstacle."
- "Obligations are closed by records, not by recollection."
- "A rigid script must never adjudicate meaning, and intelligence must never be
  spent on what a script can do exactly and repeatably."
- "Scripts stop safely and report when the world surprises them; agents read,
  interpret, and decide."

`VISION.md` is not decoration. Every issue triage posts a per-rule adjudication —
each principle scored aligns / conflicts / cannot tell against the proposed
change, with code SHAs as evidence. The doc is the acceptance criterion. We have
specs with rulings and no per-change adjudication.
