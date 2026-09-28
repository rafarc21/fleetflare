# Fleet P4 — Atomic Teams, Sprint Diamond, Domain Harnesses

Date: 2026-08-19. Status: approved in brainstorm, pending the operator spec review.
Supersedes org-chart-of-chatting-sessions model. Builds on P1-P3 studio runtime.

## 1. Problem

Old fleet: long-lived Claude sessions message each other. Hub agent (a CTO)
receives interleaved messages from unrelated tasks. Context pollutes. Delays,
cross-task mistakes. Research names this exactly: "wrong-agent contamination"
(DACS), "kitchen sink session" (Anthropic docs). Inter-agent misalignment =
32-37% of all multi-agent failures (MAST, 1600+ traces). Free-form agent chat
discredited industry-wide (AutoGen GroupChat → maintenance mode).

## 2. Core decisions (all locked with the operator)

1. **Atomic teams.** One cloud container = one team = one Claude session
   (lead) + native subagents (team members). Session↔session chat: none.
   Subagent dispatch = structured handoff, context travels with task.
2. **Ephemeral, task-scoped.** Team spawns per task, executes end-to-end,
   reports, dies. No immortal sessions. Task = one DELIVERABLE (§2.12) —
   container boot paid per deliverable, never per implementation step.
3. **Sprints.** Work opens in sprint meeting, closes with kill-all teardown.
   Nothing survives sprint except artifacts.
4. **No interop protocol.** A2A/AGNTCY rejected (cross-org tools). Borrow A2A
   task-state vocabulary only: submitted / working / input_required /
   completed / failed / canceled.
5. **No hub agent.** Coordination = deterministic Worker code + GitHub Issues
   board. LLM spawned fresh for genuinely ambiguous decisions only
   (12-factor: deterministic code, LLM steps sprinkled).
6. **Comms contracts per channel.** Agent→human: caveman-compressed prose.
   Agent→agent / agent→board: fixed schema envelope, free text forbidden
   except bounded notes field. Humans get prose rendered FROM struct.
7. **Context travels by artifact** (commits, PRs, files). Messages carry
   pointers + evidence, never payloads.
8. **Domain-specific narrow agents.** Each agent ≤ ~12 tools. Evidence: tool
   selection 58%→26% accuracy past tool-count threshold; least privilege
   doubles as security.
9. **Studios named as human job titles.** No codenames. Each domain team =
   a STUDIO (the operator's standing term). Studio has internal org: named lead +
   named member subagents + reporting lines.
10. **Infisical = fleet-wide secret backbone.** Same tool Acme already
    uses → one standard across every client project. Free tier suffices at
    fleet scale (limits verified in P4a).
11. **Leads direct, never implement.** Ratchet from real failure: a CTO
    agent (old fleet) drifted into implementing a task, wrecked its own
    context window.
    Lead = dispatcher + reviewer of member output. Implementation tools
    exist ONLY in member subagents. Enforced by a PreToolUse hook (§4) —
    structural for Edit/Write/NotebookEdit, best-effort for Bash (a
    blocklist of observed write forms, not a sandbox). The lead prompt
    carries the rule as well, because the Bash half cannot guarantee it.
12. **One task = one team, task = one DELIVERABLE.** Board task = one
    coherent deliverable of substantial scope (one issue): a feature, a
    debug, a content write-up, a batch process — anything needing a longer
    stretch of work. Never a micro-step. Inside the container, ceremony
    scales with scope via superpowers classification (spike / bounded /
    architectural): longer scope → brainstorming skill first, then
    writing-plans decomposition (typically 10-12 steps); bounded work →
    short design + plan; everything → verify. Steps execute within the
    SAME instance — related work shares context by design; lead stays lean
    by dispatching. A team never holds two deliverables. Cross-task
    multiplicity lives on the board under the Maestro (§2.13) — no
    studio needs an internal PM. Release Manager stays fleet-level: its
    function (batch train, cross-studio intersection, one checklist) spans
    studios by nature.
13. **Maestro Studio = the only persistent session, and it is the operator's
    interface, never the fleet's mailbox.** `ff` in a repo folder →
    spawn-or-attach THAT repo's Maestro (container clones the repo on a
    `maestro` branch — Maestro reads code, never implements); `ff` outside
    any repo → the fleet-level Maestro. Two letters, nothing local: `ff` on
    Mac and Moshi on phone attach the SAME cloud tmux session. Ideas enter
    here in prose; Maestro classifies, writes task specs, spawns studios,
    reports status by reading the board ON DEMAND. Studios never message
    the Maestro — inbound traffic stays on the board (the old fleet's CTO
    died from inbound interleaving; the Maestro structurally cannot). Sprint meetings happen
    here (absorbs Planning Studio). Approvals + checklist links surface in
    this conversation; Moshi replaces Telegram (Telegram = optional
    fallback).
14. **Container lifecycle contract.** Provision: clone task's repo, create
    `task/<issue>-<slug>` branch, materialize harness, boot with brief.
    Teardown: rescue-push (commit dirty + push branch) before ANY kill —
    idle reap, sprint close, crash. Work cannot die with a container. No
    in-container `git worktree`: container boundary + per-task branch IS
    the worktree. (Cached-clone worktrees = P4c boot optimization only.)

## 3. Studios

Studio = team template. One file per studio. Lead = the tmux claude session.
Members = named native subagents inside it. Human job titles throughout.

Leads NEVER implement (§2.11): every studio has explicit builder member(s)
holding the only Edit/Write access. Lead dispatches, reviews, reports.

| Studio | Internal org (lead ← members) | Domain | Tier-1 domain skills | Secrets (names) |
|---|---|---|---|---|
| Web Studio | Web Designer (lead) ← **Frontend Developer**, **Backend Developer** (Directus, APIs, Workers app code, D1/KV), Code Reviewer (fresh-context, read-only), QA Engineer (browser+console+network) | full-stack client sites + web apps; design IS code (Developer+Designer merged — the operator designs in code) | frontend-design, qa, landing-page, pricing-page, cro-* suite, shadcn, web-perf, unsplash-integration, Meng To style/layout skills (fleetflare `skills/`), design verbs (adapt/animate/arrange/critique/polish/…), emil-design-eng, cloudflare/durable-objects/wrangler (backend member) | UNSPLASH_KEY, DIRECTUS_* (backend tasks) |
| Content Studio | Content Editor (lead) ← **Copywriter** (writes content/files), Proofreader (unslop gate), QA Engineer | Directus content, copy, imports | import-content, directus-seed-deploy, lms-lesson, unslop rules | DIRECTUS_* |
| Media Studio | Media Producer (lead) ← **Visual Artist** (runs generations, writes outputs), Art Reviewer (curation) | image/video generation | higgsfield-generate/-soul-id/-product-photoshoot/-marketplace-cards, comfyui, video-to-superprompt | HIGGSFIELD_* |
| Marketing Studio | Marketing Manager (lead) ← **Email Copywriter** (drafts), Compliance Reviewer | campaigns, deliverability | email, email-audit/-check/-plan/-review/-sequence/-write, cloudflare-email-service | email creds |
| Maestro Studio | Maestro (lead, solo — output IS coordination artifacts: task specs, spawns, status; reads code on `maestro` branch, never implements) | the operator's interface (§2.13): sprint meetings, idea intake, fleet management; per-repo instance + one fleet-level; persistent (keep_alive) | sprint-ritual, spec-driven-delivery, manager-comms, cto-liaison, agent-lifecycle | none |
| Release Studio | Release Manager (lead) ← QA Engineer (staging sweep) | staging train, console sweep, checklist, verdict routing, prod deploy — fleet-level by nature (§2.12) | release-verification-checklist, qa, delivery-standards, agent-lifecycle | none (deploy stays Worker-side) |

Release Manager absorbed converge role: one owner for diamond bottom half.
Minimum viable diamond: Web Studio + Maestro Studio + Release Studio.

Rosters are DEEP by default: a member is a subagent definition — unused
members cost zero tokens (spawn only on dispatch). The real budget is
per-member tool count (≤12), never roster size.

Skill inventory sources (audited 2026-08-19): fleetflare-agency `skills/` (Meng To
design set, qa, cro suite, landing/pricing), `~/.claude/skills` (67 global:
design verbs, email suite, higgsfield, fleet ops), superpowers plugin
(process spine), caveman plugin. Acme repo: only `deploy.md` +
`release-cycle.md`, repo-specific — pattern donors for Release Manager, not
portable skills.

## 4. Studio file = harness contract

One file per studio, `fleet/blueprint/studios/<name>.md`. NOT a role prompt —
a full harness: org, skills (two tiers), tools, hooks, secrets, budgets.
Every locked behavior maps to an enforcement MECHANISM (deterministic where
possible), not to prompt hope. Ratchet discipline: each rule traces to a
past failure.

```yaml
name: web-studio
title: Web Studio
domain: <target repo(s)>
model: sonnet            # right-size; effort max only where argued
effort: high
maxTurns: 40             # hard step budget (12-factor: small focused agents)
org:
  lead: Web Designer     # the tmux claude session; talks to the operator + board.
                         # NEVER implements: PreToolUse lead-gate hook
                         # blocks Edit/Write/NotebookEdit and file-writing
                         # Bash forms (§2.11, enforcement row below)
  members:               # named subagents → materialized .claude/agents/*.md
    - name: Frontend Developer
      reports_to: lead
      tools: Edit/Write + build tools   # implementer
    - name: Backend Developer
      reports_to: lead
      tools: Edit/Write + wrangler/directus tooling   # implementer
    - name: Code Reviewer
      reports_to: lead
      tools: read-only   # fresh-context review, no write access
    - name: QA Engineer
      reports_to: lead
      tools: browser + console + network capture
skills:
  locked: []             # Tier 0 — injected by fleet for EVERY studio;
                         # not declarable, not removable (see table below)
  domain: [frontend-design, qa, ...]   # Tier 1 — per studio
allowedTools: ...        # ≤12 per member, least privilege
hooks:                   # per-studio additions on top of fleet-wide hooks
  PreToolUse: <validator script>    # exit 2 blocks action, reason to model
  Stop: completion-gate.sh
secrets: [UNSPLASH_KEY]  # NAMES only; resolved from Infisical at provision
mcp:                     # per-studio MCP servers → materialized .mcp.json
  - name: playwright     #   config template; secret NAMES resolved at provision
cloudflare: []           # CF service tokens by name (scoped, never deploy creds)
may_spawn: []
gates: []                # merge/deploy never in-container
```

### Tier 0 — locked skill set, every studio, non-negotiable

Superpowers process skills = the pipeline. Caveman = the comms standard.
"Skills wrong → agents do crap work" — this tier is why role ≠ markdown file.

| Locked behavior | Skills | Enforcement mechanism |
|---|---|---|
| Caveman comms with humans, always | caveman plugin | Container SessionStart + UserPromptSubmit hooks inject mode every prompt (same mechanism as the operator's Mac). Baked fleet-wide, no studio opt-out |
| Scope-scaled process on every task: larger scope → brainstorm → design → plan; bounded → short design + plan; ALL → verify | superpowers: brainstorming, writing-plans | Team classifies at task start (spike/bounded/architectural). Product-level brainstorm+design happen at sprint meeting (PM + the operator). Per task: Stop-gate rejects completion unless envelope references a committed plan doc. Fix-tasks (from the operator's verdicts) exempt from re-brainstorm, never from plan+verify |
| Plan-driven execution | superpowers: executing-plans, subagent-driven-development | Lead prompt contract + plan doc checked into repo (auditable artifact) |
| TDD + debugging discipline | superpowers: test-driven-development, systematic-debugging | Stop-gate demands test output as envelope evidence |
| No completion without verification | superpowers: verification-before-completion + delivery-standards | Stop hook blocks "done" until build+lint+check+test outputs present and green. Deterministic, not prompt-based |
| Code review before PR | superpowers: requesting-code-review | Code Reviewer member (fresh context) must sign envelope before PR marked ready |
| Worktree/branch discipline | superpowers: using-git-worktrees, finishing-a-development-branch | Lead prompt + branch-name validation in PreToolUse git hook |
| Plugins present in container | superpowers + caveman plugins | Baked into container image at build, not per-provision |
| Lead never implements (§2.11) | — | PreToolUse hook (`lead-gate.sh`), matcher `Edit\|Write\|NotebookEdit\|Bash`, keyed on the payload's `agent_id` — absent = lead's own call, present = a dispatched member, who is never gated. **Structural for Edit/Write/NotebookEdit; best-effort for Bash.** The lead's Bash calls are scanned against a BLOCKLIST of observed write forms (redirect into a path, `tee`, `sed -i`, `mv`/`cp`, `dd of=`, plus the shell wrappers that hide any of those inside a quoted payload — `bash -c`, `sh -c`, `eval`, `xargs`/`env` spawning either); read + coordination commands pass, `xargs` itself included. It is not a sandbox — `python3 -c`, `ed`, `curl -o`, `wget -O`, `git apply`, `install`, `truncate` and `touch` all still write, so the lead prompts carry the rule too. NOT `disallowedTools`: that flag is session-global and strips the tool from every dispatched member as well (proven, P4a-1 Task 0 spike). Hook fails CLOSED (exits 2 when the script is absent or non-executable). Coordination artifacts exempt (board comments, checklist entries via `fleet` CLI — that IS lead work) |

### MCP + Cloudflare access map

Containers have NO MCP today. Studio file's `mcp:` block materializes a
container `.mcp.json` at provision; secret names resolve from Worker store.
CF access = scoped per-service API tokens as secrets. Deploy creds never.

| Studio | MCP servers (in container) | Cloudflare services |
|---|---|---|
| Web Studio | playwright (chromium baked in image) — self-check pages | none direct; staging/prod via Worker gates |
| Content Studio | none — Directus REST via import-content CLIs + DIRECTUS_* | none direct |
| Media Studio | comfyui-cloud (API key); higgsfield via CLI | R2 media bucket (scoped token) |
| Marketing Studio | none headless-viable for Gmail today → CF Email path | Email Sending + Email Routing (scoped token) |
| Maestro Studio | none — board via `fleet` CLI → Worker | none |
| Release Studio | playwright — console+network sweep on staging | Browser Rendering (optional sweep alternative) |

Rules of the map:
- Interactive-auth MCPs (claude.ai connectors) cannot auth headless —
  containers get API-key MCPs or CLIs only. Gmail inbox work stays on Mac
  agents until a service-account path exists.
- MCP tools count toward the ≤12 tool budget. Members not needing MCP get
  `disallowedTools: mcp__*` (tool-selection accuracy evidence, §2.8).
- chromium + playwright baked into container image once (qa practice);
  CF Browser Rendering is the fallback if image weight hurts.

### Secrets — Infisical backbone

Standardized across ALL client projects (same tool as Acme):

- Infisical layout: one Infisical project per client repo (envs
  staging/prod) + one `fleet` project for agency-wide creds (HIGGSFIELD_*,
  UNSPLASH_KEY, DIRECTUS_*, email). Client repos commit `.infisical.json`
  pointer (non-secret — same rule as client.json).
- **Injection at provision (P4a)**: Worker holds ONE scoped read-only
  Infisical machine identity. Resolves studio's declared secret names →
  fetches from client + fleet projects → injects VALUES as container env.
  Containers never hold Infisical creds. Blast radius = the values a studio
  declared, nothing more.
- the operator's surface: Infisical dashboard = one UI for every project's secrets,
  audit log, rotation. Replaces scattered .env management.
- **P4c option**: per-studio machine identities (scoped to exactly the
  studio's paths, TTL'd) if live rotation mid-task ever matters. Not P4a.
- Nobody gets Cloudflare deploy creds, ever — those live only Worker-side
  (existing architecture, unchanged; NOT in Infisical reach of studios).

### Rules

- Secrets: studio declares names, harness resolves (see above). Media
  Media Studio gets HIGGSFIELD_*, Web Studio gets UNSPLASH_KEY, least
  privilege throughout.
- Bringup materializes: members → `.claude/agents/`, Tier 0 + Tier 1 skills
  → container skills dir, hooks → settings. `skills` field goes from dead
  code to load-bearing.
- Member prompts encode checklist + output contract. Role-spec quality alone
  worth +9.4% success (MAST intervention data).
- Stop hook = free validation loop: completion structurally impossible until
  gates green. Attacks the 23.5% verification-failure class.
- Parse-time validation rejects a studio file that redeclares or drops
  Tier 0 (same BlueprintError contract as existing fields).

## 5. Board = GitHub Issues

Worker DO table rejected: invisible to the operator. GitHub Issues chosen:
visible, URL-addressable, mobile app, comments, milestones — zero new UI.

- One issue per task. Body = task spec (self-contained brief: objective,
  output format, boundaries — spec issues cause 43.8% of failures, quality
  enforced at sprint meeting).
- Labels = A2A states. **Worker is single writer of state labels.** Agents
  never close/label issues. Kills the state-drift class (websites fleet
  lesson: issue state lied about deploys; deploy truth always measured from
  branch + host, never from issue state).
- Team envelopes (result, evidence, artifact refs) = issue comments.
  Machine-parseable, human-readable.
- Fix lineage = linked fix-issues + comment thread.
- Sprint = milestone. Sprint board = issue list filtered by milestone.
- Board repo = repo being worked; cross-repo sprints → fleetflare-agency.
- Rate limits: non-issue. App installation tokens 5,000+ req/h; sprint scale
  is 20-30 tasks.
- DO keeps runtime ephemera only (container ids, spawn tokens) — as today.

## 6. Envelope schema (agent→board)

```
envelope:
  msg_id, task_id          # threading + idempotency
  sender, intent           # intent enum: request|result|error|clarify|escalate
  schema_version
payload:
  status: ok|partial|failed|blocked
  artifacts: [{path|pr|url, kind, digest}]
  evidence: [commands run, checks passed]   # no unverified claims
  open_questions           # structural slot — schema never forces a guess
  context_digest           # key decisions/assumptions (implicit-decision fix)
  learnings: []            # optional: reusable lessons → memory pipeline (§8)
notes: bounded free text
```

Validated at decode time (structured outputs / forced tool use). `clarify`
intent exists so schema never forces guessing (fail-to-ask = 6.8-11.65% of
failures). Humans never see the struct — caveman prose rendered from it.

## 7. Sprint diamond

```
SPRINT OPEN — meeting: the operator + Maestro (the `ff` session he is already in).
  Define scope together. PM writes task specs → issues on board.
        │
   FAN OUT — Worker spawns one ephemeral team per task, parallel.
   Each team: Ralph loop → self-QA → PR + envelope comment → dies.
        │
   STAGING TRAIN — Release Manager (deterministic merge via existing
   gates.ts machinery): batch-merge green PRs → deploy staging.
   Intersection breakage → auto fix-tasks BEFORE the operator looks.
        │
   CONSOLE SWEEP — RM's QA subagent browses every staging page,
   console + network capture (they miss different things). Any error →
   fix-task, checklist waits. the operator never stumbles on catchable errors.
        │
   CHECKLIST — RM builds manual-verification checklist via existing
   release-verification-checklist Worker: per task, staging URL, steps,
   expected result. Link to the operator (Telegram).
        │
   ★ THE OPERATOR VERIFIES ★ — one pass, all work at once, on staging. Ticks +
   comments in browser. Verdicts read back as JSON.
       ╱      ╲
   all pass    failures + notes
      │            ╲
   prod deploy    fix-teams spawned w/ notes + lineage
   (gated button)  → smaller diamond, repeat
        │
SPRINT CLOSE — kill all containers (agent-lifecycle teardown), CLOSE
  all sprint issues (Worker: done → completed, unfinished → closed
  not-planned with state note; carry-over decided at next sprint
  meeting, never left open), harvest learnings (§8), archive milestone.
  Clean slate.
```

Merge-before-verify honored: checklist built only after staging carries the
merged batch. Per-worktree human checking dead — intersection issues surface
pre-checklist. Train departs when sprint tasks green; the operator can trigger
converge early.

## 8. Memory + upskilling

Teams die; memory must not. Three layers, all git, all in the blueprint repo
(fleetflare-agency) — versioned, reviewable, visible:

```
fleet/memory/<studio>/*.md   # studio's own learnings (the operator memory format:
                             #   name/description frontmatter + fact)
fleet/memory/shared/*.md     # fleet-wide learnings, loaded by EVERY studio
skills/                      # distilled memory = the upskill endpoint
```

Flow:
- **Read**: provision injects shared + own-studio memory into the container
  (same mechanism as role prompt injection). Team starts knowing what its
  studio has learned.
- **Write**: envelope `learnings` field (§6). Worker commits entries to
  `fleet/memory/<studio>/` — single-writer symmetry with the board;
  containers never hold blueprint-repo write creds.
- **Promote**: sprint close harvest. Release Manager reviews sprint
  learnings: studio-local stays put; cross-studio → `shared/`; recurring/
  structural → distilled into a real SKILL via superpowers:writing-skills,
  landing in `skills/`. Next provision, every studio has it. THAT is
  upskilling: skill dir = the shared place, promotion = the pipeline.
- Promotions to `shared/` and `skills/` ride a PR — the operator can eyeball or
  auto-merge via gate. Bad learning never silently poisons every studio.

## 9. Worker changes (deterministic layer)

New:
- Board writer: issue create/label/comment/close via existing GitHub App
  creds. Single writer of task state.
- Train logic: batch-merge green PRs (reuse gates.ts mergePullRequest),
  staging deploy trigger, sweep trigger, fix-task spawn on failure.
- Studio file parsing: org/skills/hooks/secrets/mcp/maxTurns fields in
  blueprint.ts; bringup materialization (members, skills, hooks, .mcp.json)
  in studio-bringup.sh + provision.
- Secret injection: studio secret names → Worker fetches from Infisical
  (scoped read-only machine identity) at provision, injects as env.
- Memory: read-injection at provision; learning commits from envelopes;
  sprint-close issue closing + harvest.
- Envelope validation before board write.
- Lifecycle (§2.14): provision clones task.repo + task branch; teardown
  rescue-push before every kill path.
- Maestro Studio provisioning: per-repo instances + fleet-level, keep_alive,
  `maestro` branch clone.
- Studio image: sshd + mosh-server + tailscale (auth key via Infisical) —
  Moshi direct-attach path.

Reused as-is: P3 spawn machinery, approval gates, Telegram notify,
release-verification-checklist worker, IS_SANDBOX skip-permissions + effort
plumbing (committed, undeployed as of this spec).

## 10. Operator surface

the operator types commands never — two letters and prose only.

- **`ff`** (the ONLY command): repo-detect from cwd (`git remote origin`)
  → spawn-or-attach that repo's Maestro Studio; outside a repo → fleet-level
  Maestro. Everything else — task creation, studio spawns, sprint open/close,
  converge, status — happens by TALKING to the Maestro, which runs the
  deterministic verbs (`fleet` CLI + `gh`) itself. The former operator
  manual becomes the Maestro's own skill (original brief item 1, relocated
  into the cloud).
- **Phone = Moshi** (SSH over Mosh): connects into the same tmux session
  the Mac `ff` attaches — identical conversation, alive across network
  hops. Path today: Moshi → Mac (QR pair) → `ff`. Path at P4a: studio
  image ships sshd + mosh-server + tailscale; Moshi → tailnet → Maestro
  container direct; Mac fully optional.
- Approvals + checklist links surface inside the Maestro conversation.
  Telegram machinery kept as optional fallback only.
- the operator touchpoints: talk to Maestro, walk the checklist, press gate buttons,
  optionally attach to any live team (Maestro hands him the attach).

## 11. Phasing

- **P4a — minimum viable diamond**: studio file parsing + materialization
  (org, skills incl. Tier 0, hooks, secrets, mcp), Web Studio + Maestro
  Studio + Release Studio files, plugins + chromium + sshd/mosh/tailscale
  baked into image, board writer, memory read-injection, `ff`
  (repo-detect + spawn-or-attach Maestro), lifecycle clone/branch/rescue-push,
  sprint open/close (incl. issue closing), train merge + console sweep +
  checklist wiring. One real sprint on websites repo = acceptance test.
- **P4b — domains + memory loop**: Content Studio, Media Studio, Marketing
  Studio files, secret/MCP injection breadth, learning write-back
  + sprint-close harvest + promotion PRs.
- **P4c — polish**: envelope decode-time validation, fix-task automation
  depth, handbook regen, burn dashboards per sprint.

## 12. Open questions

- PM interactive meeting: attach to PM team in terminal (default) vs
  Telegram thread. Start terminal, revisit.
- Staging deploy per client repo: reuse existing deploy targets config;
  per-repo wiring confirmed during P4a acceptance sprint.
- Sweep page list source: sitemap vs studio-declared routes. Decide in P4a.
- Infisical free-tier limits (machine identities, API rate) + exact
  identity scoping: verify during P4a setup before committing all clients.

## 13. Evidence base (research session 2026-08-19)

Three research passes, full findings in session transcript. Load-bearing:
- Anthropic multi-agent research system (orchestrator-worker, workers never
  chat, artifacts + references, 90.2% over single-agent, ~15x tokens).
- MAST failure taxonomy, arXiv 2503.13657 (inter-agent misalignment 32-37%,
  verification 21-23%, role-spec +9.4%, verification +15.6%).
- Cognition "Don't Build Multi-Agents" (full traces not messages; writes
  stay single-threaded).
- DACS, arXiv 2604.07911 (wrong-agent contamination, focus sessions).
- Code as Agent Harness, arXiv 2605.18747 (git-as-bus beats prompt-based
  coordination, test-gated merges).
- 12-factor agents, HumanLayer (harness discipline, small focused agents,
  stateless reducer).
- Tool-count evidence (58%→26% selection accuracy; ≤12 tools per agent).
- Claude Code Agent Teams + cross-session messaging docs (mailbox + task
  list + "messages never carry history").
- A2A v1.0 (state vocab borrowed, protocol rejected for internal fleet).
- Structured outputs / decode-time schema enforcement as output contract.
