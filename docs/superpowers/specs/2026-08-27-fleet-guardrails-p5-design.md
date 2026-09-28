# Fleet P5 — Guardrails, Backlog, Verification

Date: 2026-08-27. Status: brainstormed with the operator, approved, pending spec review.
Extends P4 (`2026-08-19-fleet-atomic-teams-p4-design.md`). Does not supersede it.

## 1. Problem

Agents drift off rules that live only in prompts. Six failures the operator has
watched, each now a ratchet:

1. **Claimed done, wasn't.** No verification ran.
2. **Reported success on broken output.** Builds, renders, wrong.
3. **Work lost on teardown.** Container died holding uncommitted work.
4. **Caveman drift.** Compression decays over a long session.
5. **Skipped brainstorm/plan** on feature work.
6. **Skills silently unresolvable.** Hit live this session: `superpowers:
   brainstorming` returned "Unknown skill" mid-session. Cause: marketplace
   re-resolved a version label under a running session (6.2.0 cached
   2026-08-19 15:49, mid-session; label is not commit-immutable). Studios
   are long-lived too — same failure applies.

Prompts ask. Hooks enforce. Only two hook events actually STOP anything:
`PreToolUse` (exit 2 blocks the call) and `Stop` (rejects completion).
`SessionStart`/`UserPromptSubmit` only inject.

## 2. Hook matrix

### Fleet-wide — every studio, not declarable, not removable

| hook | enforces | state |
|---|---|---|
| SessionStart | caveman injected | BUILT, firing (proven: `.caveman-active` mtime 5s after bring-up's own writes) |
| UserPromptSubmit | caveman re-injected each turn | BUILT |
| SessionStart | **Tier-0 skills RESOLVE, not merely exist on disk** | NEW — closes failure 6 |
| PreToolUse | lead never implements (Edit/Write/NotebookEdit + Bash write-forms) | BUILT, proven live |
| Stop | verification intent present (§4) | NEW |

The skill-resolution check is the subtle one. The existing harness check
verifies skills are materialized ON DISK. Failure 6 was a skill present on
disk and not invocable. Presence != resolvable. Check must invoke, not stat.

### Per studio, on top

| studio | Stop-gate additionally demands |
|---|---|
| **Web** (code) | plan doc referenced · build/lint/check/test output · verification intent |
| **Content / Media / Marketing** | design doc from the non-code brainstorm skill (§6) · verification intent · NO test demand |
| **Release** | batch merged · staging deployed · console+network sweep run · one checklist assembled |
| **Maestro** | task specs filed via the board verb, never raw `gh issue create` · no plan/test demand (never implements) |

Code-writing is derived from the roster, not declared: a member holding
Edit/Write is what makes a studio one.

### Not hooks

- **Failure 3 (teardown)** — Worker-side rescue-push in EVERY kill path
  (P4 §2.14, never built). A Stop hook cannot see a teardown.
- **Failure 2 (broken output)** — Stop can demand console capture and
  verification intent. Wrongness that renders fine is caught only by the operator's
  checklist. That is what the checklist is for; do not pretend otherwise.

## 3. Backlog

**Backlog = on the board, no studio assigned.** That is the whole
definition.

Sources: the operator files from his phone; an old issue nobody triaged; a studio
died and Maestro unassigned it.

Rules:
- `fleet task ls` shows backlog. NEVER hidden. Today `listTasks` filters to
  issues carrying a state label (`board.ts`: `issues.filter((i) =>
  taskStates(i.labels).length > 0)`), so a hand-filed issue vanishes —
  looks filed, is inert. Fix that filter.
- No hook blocks `gh issue create`. File however you like. Unassigned means
  unassigned, not invisible.
- **Stale** = in backlog a while, nothing blocking it. Worker flags
  mechanically (age + no blockers + no assignment). Maestro decides.
  Detection is mechanical; the call is judgment.

### Adoption

`ff <role> <issue-number>` — point a studio at an EXISTING issue.

Worker adopts: stamps `studio:<repo>--<role>`, sets state, injects the
issue body as the brief, spawns. Works whether the issue was labeled or
bare. Closes the gap where any pre-existing issue was unreachable —
`parseFfArgs` today takes only a role and a NEW task string.

### Reassignment

`task assign <n> <role>` — Maestro's verb.

Worker does atomically: remove old `studio:` label, add new, state →
`submitted`, comment the lineage (from, to, when, why). Prior envelope
comments stay: history of what the dead studio did survives.

Maestro MAY rewrite the brief when reassigning — body is content, not
state. Reassigning a wrong brief just ships the same wrong brief.

Maestro NEVER runs `gh issue edit`. It decides; the Worker writes.

## 4. Verification intent

Every studio, every task. Not optional, not per-domain.

At done-time the lead writes into its envelope: **URL, steps, expected
result**. Stop-gate demands it exactly as it demands test evidence.

Why at done-time: studios are ephemeral. The lead that did the work is dead
by the time the PR merges. Capture before teardown or lose it.

## 5. Checklist flow

the operator's ruling: one channel, one checklist, mechanics outsourced.

```
studio leads   → verification intent into the envelope (Stop-gate demands it)
Release Studio → batch-merge green PRs, deploy staging, console+network sweep,
                 fix-tasks for what the sweep catches,
                 assemble every intent into ONE checklist (the operator's standard format)
Maestro        → delivers the checklist link + summary to the operator
the operator           → ticks once
Release Studio → reads verdicts back as JSON, files fix-tasks with lineage
Maestro        → reports what happened
```

Release Studio does assembly, no judgment — it concatenates what studios
declared. Judgment stayed with the leads, who had the context.

**Fix-tasks respawn the studio, not the container.** The original lead is
dead. A fix-task spawns a fresh instance of the same studio with lineage +
the operator's notes. From the operator's side it is still "the Web Designer" — the role
persists, the process does not.

Deploy stays Worker-gated. the operator presses the button. Unchanged from P4.

## 6. Non-code brainstorm skill

`superpowers:brainstorming` classifies spike / bounded / architectural —
code-shaped. Content, media and marketing work has different axes. No
equivalent exists (audited `~/.claude/skills`, 67 skills: `spec-driven-
delivery` and `sprint-ritual` are fleet-ops, not idea-shaping).

Write one. Its classification axes, replacing spike/bounded/architectural:

- **Reversibility** — a draft costs nothing; a sent campaign cannot be
  unsent. Ceremony scales with how hard the mistake is to undo.
- **Reference exists?** — brand voice, locked palette, prior art. Absent
  reference means the first deliverable is the reference, and that is a
  bigger task than it looks.
- **Source material** — does this need archive footage, product data,
  customer quotes that must be gathered before anything can be made?

Its "verify" step is not tests. It is the operator's eye — so its output must
include the verification intent §4 demands.

## 7. Where things live

Store by who writes it, how it changes, and who must read it.

| store | holds | why there |
|---|---|---|
| **Repo** | `CLAUDE.md` conventions · `docs/` architecture, specs, plans, runbooks · wrangler/Dockerfiles · `.infisical.json` pointer | Changes WITH the code, reviewed in the same PR, correct at that commit. Infra notes that drift from code are worse than none. |
| **GitHub Issues** | tasks · state labels · envelope comments · milestones = sprints | Units of work with state. Human-visible, mobile, URL-addressable. |
| **Directus** | project registry · contract · requirements · client portal + inbound requests · decision log | Queryable, spans repos, outlives any one repo, editable from a UI on a phone. |
| **Fleet memory** (blueprint repo) | how-to-work learnings · gotchas · promoted skills | Must be INJECTED at provision and REVIEWED in a PR. Git already does both. |
| **Infisical** | every secret | Never the other four. Docs carry secret NAMES only. |

The line: repo docs describe THIS PROJECT. Directus describes THE ESTATE.
Fleet memory describes HOW TO WORK.

Infra split three ways, as the worked example:
- `wrangler.jsonc` → repo (it IS the infra)
- "prod is on the Demosite CF account; beta is unreachable from the others"
  → Directus (spans repos, outlives them)
- "merged is not served; blueprint reads from main" → fleet memory (true of
  the fleet, not of one project)

### Access

| store | how an agent reads it |
|---|---|
| Repo | already cloned at provision |
| Issues | Worker API, scoped per studio (proven live) |
| Fleet memory | blueprint clone at provision (existing mechanism) |
| Directus | NEW: Worker fetches at provision, injects a compact **project card** — 10-20 lines, never a document dump |

Directus must be optional at boot: a studio still comes up when it is
unreachable. A fifth store that can block provisioning is a fifth way to
have no fleet.

### Contract and requirements — tiered exposure

Contracts carry things no studio should see (the operator's standing rule from the
proposal work: never ship cost or margin).

| tier | holds | who sees |
|---|---|---|
| **Stakes** (in the project card, ~5 lines) | go-live date · fixed-price yes/no · "bugs and delays carry penalties" · scope boundary | every studio, injected |
| **Requirements** (on demand) | numbered list, full text, acceptance criteria | any studio, fetched when checking its own work |
| **Commercial** | price, margin, payment terms, penalty amounts | **Maestro only** (ruled: it is the interface and must not gold-plate a fixed-price job) |

**Requirements are first-class objects** (ruled), one row each: id, text,
acceptance criteria, status. Consequences that make them worth the setup:

- a task brief cites the requirements it satisfies
- verification intent (§4) names which requirement each step proves
- the checklist (§5) groups by requirement — the operator ticks "R-7 satisfied",
  not "some page looks right"
- a fix-task cites the requirement it failed

Discipline this imposes: requirements must exist in Directus BEFORE work
starts, or tasks cannot cite them and the checklist has nothing to group
by. That is the sprint meeting's job.

## 8. Client portal

Directus is also the client portal. Requests arrive daily; they are prose
from a non-technical person, never a task spec. Auto-conversion produces
garbage tasks, so Maestro triages.

```
client submits            Directus: status new
Worker cron notices       surfaces to Maestro as inbox
Maestro triages           writes a real task spec
Worker files the issue    links back: request.issue = N
issue moves               Worker mirrors state -> Directus
client watches            without emailing the operator
```

Maestro's verbs: `request ls` · `request accept <id>` · `request reject
<id> <reason>` · `request link <id> <issue>` (duplicate of existing work).

Dedup is structural: the request row holds `issue_number` once linked, so
converting twice is impossible.

**Single-writer extends to Directus.** Maestro decides; the Worker writes
both stores. Same rule, one more target.

### Two vocabularies

Internal states leak the wrong story. A client reading `failed` hears "your
team failed" when it usually means superseded. And a request moving to
`completed` in 40 minutes tells the client exactly what the operator's client-facing
rules say never to reveal.

| internal | client sees |
|---|---|
| submitted / backlog | Received |
| working | In progress |
| completed | Delivered — with the verification link |
| failed / canceled | nothing (or "superseded") |

Mapping lives in the Worker. The client never sees fleet mechanics.

**Delivered publishes only after the operator ticks the checklist** (ruled). Not on
issue close. Publishing on close is the claimed-done-wasn't failure aimed
at a paying client instead of at the operator.

## 9. Memory: compaction without loss

Two failures, both real: memory too big and expensive to load, AND
compaction that lost something needed. The second is worse and it dictates
the design.

Loss happened because compaction DELETED the source. Fleet memory lives in
git, so nothing ever has to be deleted. One rule resolves both:

> **Compaction changes what is LOADED. Never what EXISTS.**

### Three tiers, only the first costs tokens

```
index         always loaded, one line per fact     ~60 lines, cost stays FLAT
memory files  full detail, fetched when relevant   free until needed
archive/      demoted, unindexed                   still greppable, still in git
```

Compaction merges INDEX LINES, never memory files. A merged line cites its
sources so the original is always reachable:

```
- [CF container rollout](cloudflare-container-image-rollout.md, +2 archived) — ...
```

Demotion moves a file to `archive/` and drops its index line. "Lost"
becomes "not loaded by default", which is recoverable; deletion is not.

### Second rule: compaction keeps specifics

Numbers, names, commands, dates survive verbatim. Prose around them may go.
Same as caveman's own rule 6. What gets lost in a bad compaction is almost
always a specific — the exact flag, the exact path — dissolved into a
summary.

### Promotion-or-death

| cited by | outcome |
|---|---|
| 3+ tasks | promote to a SKILL; memories collapse into it, originals archived |
| 1-2 tasks | stays indexed |
| 0 tasks, 2 sprints old | demoted to archive — NOT deleted |

**When:** sprint close. Release Studio already harvests there; extend that
pass rather than inventing a ritual.

**Teardown harvest:** the studio writes learnings into its envelope BEFORE
the container dies; the Worker commits them. Same kill path as rescue-push,
same reason — capture before teardown or lose it.

### Named risk

An agent decides what to demote. That is judgment, and judgment is where
the original loss came from. Mitigations, all three required:
- demotion is archival, never deletion
- compaction lands as a PR the operator can reject
- the specifics rule is checkable by diff

### Search: one mandated entry point

`codebase-memory-mcp` (https://github.com/DeusData/codebase-memory-mcp) is
the MANDATORY first search step for memory. Not because its graph helps —
it is a CODE knowledge graph ("deduplicates matches into containing
functions, ranks by structural importance"), and memory files are prose
with no functions, so for `.md` it degrades to grep. The value is that ONE
verb replaces three inconsistent habits (grep / glob / nothing).

Prerequisites, both real:
- the blueprint repo must be indexed (`index_repository`) — measured
  2026-08-27: not indexed, only unrelated worktrees are
- the index goes stale like any cache; a re-index belongs in the same
  sprint-close pass as compaction, or it becomes a second store that lies

Fallback is mandatory too: grep still works when the index is missing or
stale. A search path that can block an agent is a search path that can
stop the fleet.

## 10. Access model

| actor | board access |
|---|---|
| **Worker** | sees ALL issues, writes ALL labels. Holds the GitHub App installation token. Scoping is policy it APPLIES, not blindness it suffers. |
| **Maestro** | reads whole board (via Worker). Blind Maestro cannot triage or report status. |
| **Other studios** | read own tasks only. Proven live: another studio's task 404s, another repo 403s. |
| **All agents** | never write state. Worker only. |

Caveat, recorded not hidden: Maestro holds `Bash(gh *)` and can already
read the whole board with raw `gh`. For Maestro the scoping is convention,
not a boundary. For other studios it is real — their token is spawn-scoped.

## 11. Missing plumbing this depends on

- `studio-fleet spawn --task <n>` — the in-container CLI takes no task, so
  Maestro cannot fan out WITH a brief. This is what makes sprint fan-out
  manual instead of real.
- Maestro's board-wide read route.
- Rescue-push in the kill path (P4 §2.14).
- `listTasks` surfacing backlog.
- `index_repository` on the blueprint repo, plus a re-index in the
  sprint-close pass (measured 2026-08-27: not indexed).

## 12. Open, deliberately

- Which path delivered the env-less bring-up that left a studio ungated
  (defences catch it regardless of path; cause unproven after investigation).
- Stop-gate has never refused a real studio mid-task — verified by direct
  invocation, not an end-to-end run.
- No destroy verb. `recycle` destroys AND re-provisions; tearing a studio
  down is not expressible.
- Per-exec `sbExec` env leaks into the tmux pane: not passing a var does
  not unset it. Testing bring-up by hand needs `env -u`.
