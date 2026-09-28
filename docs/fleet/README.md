# Fleet — org structure and standing rules

Record of truth for the agent fleet. Survives any single agent's context reset.
Last measured: 2026-08-03.

---

## 1. Project facts

| Field | Value |
|---|---|
| PROJECT | websites — simple marketing sites |
| REPOSITORY | `github.com/acme-org/websites` — transferred out of `former-org` 2026-08-08; renamed from `fleetflare-agency` 2026-08-03. Old URLs redirect. Cross-org transfer dropped all collaborators except `rafarc21`. |
| LOCAL PATH | `/Users/you/code/fleetflare/fleetflare-agency` — **directory NOT renamed**, see §7 |
| INTEGRATION BRANCH | `staging` |
| PRODUCTION BRANCH | `main` |
| PORT RANGE | 40150–40199 |
| THE HUMAN | the operator — agency founder, client-facing lead |
| RECORD OF TRUTH | this `docs/` tree, **for this repo**. Not Notion. Other projects keep their own record elsewhere — that does not change this one. See §7. |
| WORK TRACKER | GitHub Issues, this repo |

---

## 2. Structure

```
human  <->  cto  <->  manager  <->  { release · qa · devops · developers · explorers }
```

| role | owns | never does |
|---|---|---|
| cto | decisions, approvals, brainstorming with human | code, merges, creating agents |
| manager | fleet, work order, triage, board | product code, merges, talking past CTO |
| release | merging into `staging`, promotion `staging` → `main` | fixing what it finds, **deploying** |
| qa | post-merge verification on deployed env | fixing anything it finds |
| devops | infra, environments, DNS, secrets, headers, **deploy to Cloudflare** | product code, merging, promoting |
| developer | one task, end to end, self-verified | merging, touching another agent's files |
| explorer | decision sheets, context packs, overnight | talking to human, implementing |

**Only the CTO talks to the human.** Never put an implementer in front of the
human. Never redirect them to another terminal. Their channel stays quiet —
that is the entire reason this layer exists.

Manager contacts the human only if CTO is down or restarting, and says so.

---

## 3. Escalate to the human — these four, nothing else

1. Scope, price, deadline.
2. Content or asset existing nowhere, cannot be placeholdered.
3. Two client-side sources contradicting → implies business decision.
4. Licence, secret, legal risk.

**Deduplicate, never filter.** Same question from three directions = one question.
Obvious-seeming question still belongs to him if structural. Always attach a
recommendation so he can move fast when he agrees.

---

## 4. Interrupt the CTO immediately — otherwise batch

1. Changes a decision in flight.
2. Blocks a live agent.
3. Licence, secret, legal risk.
4. **Invalidates a fact the human already heard.** Not optional. Stale fact in a
   decision-maker's head is worse than an interruption — he acts on it.

---

## 5. Port registry

Band 40150–40199. Five ports per agent. **40160 is BLOCKED — OrbStack holds it.**

| agent | ports |
|---|---|
| cto | 40150–40154 |
| release | 40155–40159 |
| ~~blocked~~ | ~~40160~~ OrbStack |
| qa | 40161–40165 |
| devops | 40166–40170 |
| dev slot 1 | 40171–40175 |
| dev slot 2 | 40176–40180 |
| dev slot 3 | 40181–40185 |
| dev slot 4 | 40186–40190 |
| exp slot 1 | 40191–40195 |
| exp slot 2 | 40196–40199 |

Check free before binding. Know whether your framework auto-increments a busy port
instead of failing — if it does, the port you asked for is not necessarily the port
you got. Confirm what actually bound.

**Range ownership is not ownership of the listener. Check before binding, and check
before killing.** A port inside your range may be held by something that is not yours and
not an orphan. Identify the process before acting on it:

```
lsof -iTCP:<port> -sTCP:LISTEN -P          # who holds it
ps -o pid,etime,command -p <pid>           # what it is, and how long it has run
```

Recorded instance, 2026-08-05: port **40170**, the top of devops' range, was held by a live
`astro dev` server for the operator's side project — `pid 12345`, up 1h51m, serving 200. Reaping it
on range ownership alone would have destroyed active work by someone outside the fleet.

If the listener is not yours, **leave it and pick another port in your range.** Say in your
delivery which port actually bound, because the registry no longer predicts it.

Neighbouring bands, do not touch: beta 40000–40049, gamma 40050–40099,
acme 40100–40149. Port 40200 held by a Python process.

---

## 6. Standing conventions

**Naming.** Branch name = worktree name = agent name, one string:
`<issue-number>-<short-slug>`, e.g. `12-hero-slider`. Every task has an issue
before it has an agent. Permanent roles keep plain names. Explorers prefix `exp-`.

**Identifiers.** Never bare. Always `IS#54 (short real title)` and
`PR#54 (short real title)`, uppercase, no space, **every mention**. Look titles up
rather than invent them.

**Messages.** End every message with numbered `## Action points`, or explicit
"Nothing needed from you". Silence reads as forgetting.

**Language.** Engineering writing: English. Anything the end customer reads:
pt-BR. Correct any file contradicting this.

**Documents.** When a change makes a document false, fix that document in the same
change. Not a follow-up. A document contradicting reality is worse than a missing
one, because it gets trusted.

**Issues close by hand, never by merge keyword.** GitHub honours `Closes` / `Fixes` /
`Resolves` **only when a PR merges into the default branch**. This repo's default branch
is `main` and every fleet PR targets `staging`, so **no closing keyword will ever fire
here.** A closing keyword in a `staging` PR documents intent; it is not a mechanism.
Close an issue only on verified-in-production evidence. First case was
`PR#16 (X-Deployed-Commit header + Pages deploy-target doc sweep)` → `IS#10 (Deployed
sites serve no commit identifier header, so QA cannot prove which build it measured)`,
harmless only by luck.

**Write both reference forms.** `IS#10 (title)` is for the reader and is required by the
identifier rule above. But GitHub does not recognise `IS#10`, so it creates no link and
no backreference — the issue never shows the PR that touched it. Include a bare `#10`
somewhere in the body as well. The bare form links; the titled form informs. Neither
closes anything here.

**Merged is not served.** `staging` is not a deployed environment. Work merged there is
not in front of a user until promotion at sprint open, the deploy lands, and QA confirms
it on the production host. Verified instance: `PR#16` merged the `X-Deployed-Commit`
header, and `curl -sI https://beta-site.pages.dev/` still returned `HTTP/2 200` with no
such header, because production was still serving a 5-day-old build.

**Killing.** Kill an agent only once its PR is merged into `staging` AND verified
there by QA against green gates. Everything else hibernates: kill process, drop
`node_modules`, keep worktree + branch + transcript.

**File ownership.** Never two agents on one file. State ownership in every briefing.

**Memory.** Write a memory file the moment you learn something, not at the end.
Agents get recycled; context goes with them.

---

## 7. Known state, measured 2026-08-03

> **Never write a branch SHA into this block.** It has falsified this document three
> times in one day: at birth it quoted `eac7979`, the state before the commit that
> added it; then `PR#3` merged; then `PR#7` merged. A SHA here is a fact with a
> half-life of minutes. **Measure it instead:**
>
> ```
> git fetch origin && git rev-parse --short origin/staging origin/main
> git rev-list --left-right --count origin/main...origin/staging
> ```

Durable facts only, below.

- `staging` accumulates merges and promotes to `main` **only at sprint open**, only
  after QA green, only via release. Expect `staging` to be ahead of `main`; that is
  the design, not drift.
- **Merged into `staging` 2026-08-03**, each verified by
  `git merge-base --is-ancestor` on both the merge commit and the head commit, never
  by the MERGED badge:
  `PR#3 (docs: Halo Lab design fingerprint playbook + slider prompt)` — retargeted
  `main` → `staging` by the manager, CTO-approved;
  `PR#6 (docs: correct fleet known-state SHA and record two open PRs)`;
  `PR#7 (docs: record staging ahead of main, PR#3 merged, PR#2 held)`.
- `PR#2 (Vendor curated Meng To design skills for client site builds)`: **OPEN and
  deliberately held**, base `main`. Blocked on the vendoring **licence** question.
  Licence risk — do not merge it, however clean the gates read.
- Branch `side-project` pushed to origin at `9f9e811` as a backup. It held 3 commits / 447
  files / 53,390 insertions existing on one disk only. Repo verified private first.
- All four `docs/summer-hunter-*.md` carry a SUPERADO banner. Summer Hunter left this
  repo: it has its own repo `github.com/summerhunter/exampleorg.com` (verified to
  exist, private), its own agent fleet, its own record of truth.
- **`beta.demosite.life` is LIVE. An earlier entry here said it returns 401 and that was
  wrong.** See `IS#12 (Correction: beta.demosite.life is not down; the 401 is an artefact
  of the Accept header used to measure it)`. The host content-negotiates:
  `Accept: */*` (curl's default) → **401**, reproducible 3/3;
  `Accept: text/html` → **302** → `/login` → **200**; a real browser renders the
  product sign-in page. **No human visitor ever sees that 401.**
  The manager measured it with curl's default header, reported the 401 as a property of
  the site, and told devops it had been independently verified — which made a false fact
  more credible rather than less. QA caught it.
  Consequence: any `sites/beta/client.json` `domain` change justified by the 401 rests on
  a measurement artefact. Whether that field should name the app host or the marketing
  host is a **product decision, not a defect** — it is not devops' call and not QA's.
- release required a scoped permission grant to merge at all: `gh pr merge` was denied
  by the auto-mode classifier. Fixed via `.claude/settings.local.json` **inside the
  release worktree only** — deliberately not repo-wide, so developers still cannot
  merge.
- **`docs/fleet/README.md` is owned by the manager.** release and the manager both
  edited it on 2026-08-03 and produced conflicting PRs. Find it false → report the
  finding to the manager, do not edit it.
- Repo renamed on GitHub. Local directory still `fleetflare-agency` — renaming it would
  break 10 worktree gitdir pointers plus Supacode and Superset internal state.
  Open question for the human, not assumed.
- GitHub Issues: **0**. Milestones: **0**. Tracker starts empty.
- No root `package.json`. Gates run per-site under `sites/*`, not at repo root.
- `sites/`: `acme-careers`, `acme-careers-sync`, `beta`.
- `docs/`: `platform-spec.md` (Approved 2026-03-16), plus four superseded Summer
  Hunter docs — see the SUPERADO note above.
- 13 live worktrees across `code/fleetflare`, `.supacode`, `.superset`, including the four
  permanent fleet roles.
- **A second, unrelated fleet is running** on `/Users/you/code/exampleorg.com`
  with its own `cto`, `gerente`, `qa`, `devops` and task agents, integration branch
  `teste`. Ports do not collide (41xxx vs our 40150–40199). Named identically to ours,
  so check which terminal you are in before acting.

---

## 8. Verification gate — never drops, at any task size

Gates clean and **output read** · tests green and output read · server curl-verified
on a **specific real route**, never bare root · page opened and driven at every width
that matters · **console and network clean after a full scroll** · screenshot taken
**and read** · every claim traceable to something actually seen.

Delivery = pre-verified URL for a specific route + context block + numbered action
points. Never "done". Never "should work".

**A dramatic improvement is a reason to look harder, not to celebrate.** Building an
artefact is not the same as it being served. A stale environment invalidates a
measurement silently.

**MERGED IS NOT SERVED. PROMOTED IS NOT SHIPPED.** `main` is a branch, not a deployment.
**There is no CD in this repo** — verified, no `.github/workflows` exists at all. Merging
into `staging` ships nothing; promoting to `main` ships nothing either.

A change is **shipped** only when **devops has deployed it by hand** and **qa has verified
it on the live URL**. Those are two different roles and both are required. Proven twice on
2026-08-03: `PR#16` merged the `X-Deployed-Commit` header, `PR#20` promoted it to `main`,
and `curl -sI https://beta-site.pages.dev/` still returned `HTTP/2 200` with no such header
after both.

So an issue never closes on a merge or a promotion. It closes on a deployed artefact
someone has looked at.

**Your tool's defaults are part of your measurement.** Cost us a real reversal on
2026-08-03: `curl https://beta.demosite.life/` returns 401 under curl's default
`Accept: */*`, and 302 → `/login` → 200 under `Accept: text/html`. The manager reported
the 401 as a fact about the site, devops changed a config field on it, and it went into
this document. It described curl, not the host. **When a result would change someone's
behaviour, vary the request before reporting it** — headers, method, client — and say
which client you measured with. A 401 that only one client ever sees is not an outage.

**"I verified it myself" is not a second source when both checks share the blind spot.**
Re-running the same command with the same defaults confirms the artefact, not the fact.

**A test that fails in 0ms did not run. Check the harness before reporting a regression.**
A suite that reports failures with no elapsed time never reached your code — the assertions
did not execute, so they cannot have found anything. Read the duration column before the
pass/fail column.

Cost a near-miss on 2026-08-05: `bun run test:content` in `sites/beta` reported **4 failed**,
every one at `0ms`. That reads exactly like four content regressions on a live site. The
cause was a missing Playwright browser binary — `Executable doesn't exist at …
chrome-headless-shell`. After `bunx playwright install chromium`, all four passed in 6.4s.
Reporting the red would have sent someone hunting four copy bugs that do not exist.

The general form: **a failure whose shape the code could not have produced is a signal to
check the harness, not a finding.** Zero duration, every test failing identically, failures
before any setup output — none of those describe your software, so verify the runner before
reporting anything. **If the harness is healthy and the shape persists, it is a real
finding, and now a strong one.**

That last clause is not decoration. Without it this rule becomes a way to make a failure go
away: someone declares a real regression impossible and closes it. Reporting a bug that does
not exist is the cheaper error — dismissing one that does is worse, because nothing
downstream catches it. Same family as a status code that describes your client rather than
the host.

**Run a control test on any result that saves you work.** The trigger is not a tool or a
technique — it is the shape of the answer. A clean console, a passing gate, a finding
that means you can stop: those are exactly when a broken instrument and a good result
look identical, and exactly when a control is cheapest.

qa's phrasing, and it is better than the rule it replaces:

> the control test is cheap precisely because it is boring. It costs one `console.error`
> and it is only ever worth running on the results you want to be true… the tell is a
> result that saves work, not any particular tool.

Worked example, qa on the beta baseline: before trusting "console clean, zero messages",
it emitted a deliberate `console.error`, confirmed the channel captured it, then cleared
it. Only then was the clean result evidence rather than an assumption about the
instrument.

**Do not pass another role's measurement through as verified.** Attribute it. qa recorded
the manager's `IS#15` gate numbers as *the manager's*, not QA-verified, because
re-measuring needed a `bun install` it had not run. That is the correct handling — the
opposite is how the beta 401 picked up false credibility and cost a config change.
---

## Cloud fleet

Day 1 cloud deploy, container-backed CTO agent. Real infrastructure, `apps/fleet/`
this repo, branch `cloud-managed`.

| Field | Value |
|---|---|
| WORKER URL | `https://fleetflare-fleet.demosite.workers.dev` |
| D1 DATABASE ID | `00000000-0000-4000-8000-000000000000` (name `fleet`) |
| CLOUDFLARE ACCOUNT | Demosite (`0000000000000000000000000000ac`) |
| DEPLOYED | 2026-08-07; re-deployed same day, final-review fix wave |
| DEPLOY COMMIT | this fix wave's commit — see `.superpowers/sdd/2026-08-07-cloud-fleet-day1/final-fix-report.md` for the exact SHA. Supersedes `e068aae` (original deploy) and `58dd059` (`deliver()` refactor, behaviour-identical, reached HEAD but was never independently deployed) |

Verified same date: `/health` -> `{"ok":true}`. `/tg/websites` with a wrong or
missing Telegram secret token -> 403, both cases. Re-verified against
production after the redeploy below — same three results.

**Telegram is live, not pending.** Webhook registered against
`https://fleetflare-fleet.demosite.workers.dev/tg/websites`: `pending_update_count 0`,
no errors. End-to-end proven in production, both directions — including a
real message sent from the operator's phone.

Known constraint, still load-bearing: `AgentDO` and `DeployDO` extend
`Container<Env>`, and `@cloudflare/vitest-pool-workers@0.12.21` hardcodes
`enableContainers: false` (confirmed current in the latest published version
too, and in Cloudflare's own changelog) — `ctx.container` is always undefined
under this test pool, so constructing a live `AgentDO` or `DeployDO` throws
"Container is not enabled for this durable object class" regardless of
runtime injection. Every test that needs one works around it instead of
fighting it: DO-bound logic is extracted into a plain function tests call
directly with a fake runtime or a poisoned D1 binding (`advanceTask`,
`pollOnce`, `pollAndClearRearm`, `toStartInput`, `advanceDeploy`,
`pollDeployOnce` — see their doc comments in `src/agents/do.ts` and
`src/deploy/do.ts`), or the test goes through the handler one layer up
(`handleTelegramWebhook`, `worker.scheduled`) with a hand-built binding
standing in for the DO. `bun run test` is 174/0, measured 2026-08-10 — no
accepted failures of this kind remain.

### 2026-08-07 final-review fix wave

Landed together, one redeploy, verified live (`/health` 200, both 403
negatives — above). Inbound events are keyed on `update_id`
(`tg_<project>_<update_id>`, `INSERT ... ON CONFLICT(id) DO NOTHING`), which
is the fix for the "runaway usage while the operator is airborne" risk: a
slow LLM round trip used to make Telegram redeliver the same update and pay
for it twice, opus turn included — a redelivered update is now a no-op past
the dedupe check instead. Also landed: the CTO container's system prompt
(`container/server.ts`) now states plainly it has no repository, no GitHub
or MCP tools, and its memory resets whenever the container sleeps (20m
idle) — a fabrication guard, not a new capability. A failed Telegram send
is now also logged as a `kind: "report"` event in D1 (`src/agents/do.ts`,
addressed back to the sending agent, `ref` pointing at the reply that
failed to send), so a delivery failure is queryable while unattended
instead of sitting only in a Workers log nobody reads. `AGENT_MODEL` now
threads from the Worker's `Env` into `AgentDO.envVars` (still defaults
`claude-opus-5`, matching `container/server.ts`'s own default), so changing
the model is a config change, not a container rebuild.
