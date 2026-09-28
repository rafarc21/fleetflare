# Cloud fleet Day 2 — Spec A: Shipping

Date: 2026-08-08. Status: pending human review.
Branch: `cloud-managed`. Repo: `websites`.
Predecessor: `2026-08-06-cloud-fleet-design.md` (Day 1, shipped and live).

## 1. Goal

Day 1 proved a message from the operator's phone reaches Claude Code in a
Cloudflare container and replies. The agent has no repository. `/workspace` is
empty. It cannot ship anything.

Spec A gives it a repo, push and PR rights, and four approval gates over
Telegram. Every publish waits on an operator button press. Nothing unattended.

Day 2's other three items — MCP capability server, agent registry in D1, fleet
exposed as MCP to local Claude Code — are **Spec B**, brainstormed separately.
They share one machine (an MCP endpoint on the Worker) and item 3 is item 4's
prerequisite. Spec A is the only one that changes the execution model, so it
goes first and alone.

## 2. What Day 1 leaves standing

Keep, unchanged in shape:

- Worker → D1 event log → Durable Object per agent → Cloudflare Container →
  `claude -p` on `CLAUDE_CODE_OAUTH_TOKEN`, Max subscription.
- Telegram webhook with `X-Telegram-Bot-Api-Secret-Token`, operator allowlist.
- `update_id` dedupe, `INSERT ... ON CONFLICT(id) DO NOTHING`.
- `is_error === false` gate on claude's JSON. Exit code alone is not sufficient
  and never becomes sufficient.
- Pinned `@anthropic-ai/claude-code@2.1.224`. The gate parses its JSON shape.

Hard constraints, unchanged:

- `ANTHROPIC_API_KEY` appears nowhere. Max subscription, zero API credits.
- bun only. Never npm, npx, pnpm.
- Every wrangler call prefixed `env -u CLOUDFLARE_API_TOKEN`.
- Secrets only via `wrangler secret put`. Never chat, never a file, never a commit.

## 3. Decisions taken 2026-08-08

Recorded with reasoning, so a later reader does not relitigate them.

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | Day 2 splits into Spec A (shipping) and Spec B (MCP layer) | one Day 2 spec | Four subsystems. Only A changes the execution model. |
| 2 | Deploy targets are **config rows in D1**, not code | hardcoded target | Onboarding repo #2 must be an INSERT. Matches Day 1 spec §13. |
| 3 | Deploy commands run in a **fleet-owned deploy container** on Cloudflare | Railway runner; GitHub Actions | Same substrate already proven. No workflow file committed into a client repo. Works whether or not a repo is on GitHub. Railway stays the documented fallback if a build outgrows a container. |
| 4 | Secrets target state is Infisical, fetched at run time by scoped machine identity | fleet stores client credentials | Fleet never accumulates client secrets. **v1 falls back to `wrangler secret put`** behind the same interface — Infisical provisioning is unconfirmed as of this date. |
| 5 | Running task shows as **one Telegram message, edited live**. Terminal states send a new, buzzing message | stream every milestone; stay silent | Full detail on demand, zero buzz otherwise. |
| 6 | Turn stays `claude -p --continue`, one process per turn | long-lived streaming session | Agent ends its turn at a gate. Nothing stays alive while the operator sleeps. Makes the resume path exercise `readSince`. |
| 7 | Turn execution goes **async**, driven by a DO alarm poll | keep it inside the webhook request | A 6-minute coding task cannot live inside a Telegram request. |
| 8 | Agent identity is a **GitHub App**, `fleetflare` | machine account; operator's own token | 1-hour installation tokens; `fleetflare[bot]` is unmistakably not the operator; no seat, no 2FA to babysit. |
| 9 | "Agent will not merge unasked" is **policy, not structure** | GitHub Team + rulesets ($4/user/mo); fork model | Operator's call, 2026-08-08. See §10 for the exact residual risk and §16 for the upgrade path. |
| 10 | CTO holds push and PR rights itself | wait for Spec B's dev agents | `docs/fleet/README.md` says the CTO never writes code. That rule is right for a local fleet of eight and wrong for a cloud fleet of one. Doctrine returns in Spec B. Written as an exception, not a silent break. |
| 11 | Worker and GitHub App both named `fleetflare` | keep `fleetflare-fleet` | Operator's call. §14 covers the rename's cost. |
| 12 | No Cloudflare Queues | Day 1 spec §7 wanted them | One agent, one task at a time. The DO already serialises. Revisit in Spec B when devs fan out. |
| 13 | No separate watchdog bot | Day 1 spec §9 wanted one | A second bot is not an independent sender. The Worker sends both. See §12. |

## 4. Turn lifecycle

Today, everything inside one Telegram request:

```
Telegram -> Worker -> D1 -> DO.fetch -> container /ask ...blocks... -> reply -> sendMessage
```

Spec A:

```
Telegram -> Worker -> D1 -> DO.fetch -> container POST /task -> 202, instantly
                              |
                       DO sets alarm, 5s
                              |
   alarm loop --- containerFetch /status --- new milestones -> D1 events
              |                                             -> editMessageText (one live message)
              |--- resets sleepAfter          (keepalive)
              |--- stamps heartbeat           (watchdog)
              |--- enforces MAX_TASK_SECONDS  (cost guard)
                              |
              terminal: done | failed
                        (done may carry a pendingApproval)
                              |
              NEW Telegram message (buzzes) + inline keyboard if a gate
```

**Why alarm-polling, not the container POSTing to `/events`.** Day 1 spec §5
sketched a `POST /events` route for containers. Dropped. One alarm does three
jobs — progress, keepalive, heartbeat — and adds zero public attack surface. A
container calling the public Worker URL needs its own auth boundary and a second
inbound gate to defend, for strictly less.

## 5. Components

### Container, agent (`container/server.ts`, extended)

| Route | Behaviour |
|---|---|
| `POST /task` | `{taskId, prompt, repo, ref, ghToken}`. Returns 202 immediately. Spawns `claude -p --continue` detached. |
| `GET /status` | `{state: idle\|running\|done\|failed, taskId, milestones[], pendingApproval, result, error, costUsd}` |
| `POST /abort` | Kills the running claude process. Used by the cost guard and `/stop`. |
| `GET /health` | Unchanged. |

Repo mount: first task clones
`https://x-access-token:<ghToken>@github.com/<repo>.git` into
`/workspace/<repo>`, base branch `staging`. Later turns `git fetch`.

**The GitHub token arrives per task, in the request body — never in `envVars`.**
It dies with the turn instead of sitting in a container environment for the
20-minute `sleepAfter` window. This is a real softening of Day 1 spec §12's
stated v1 compromise, not a restatement of it.

Git identity: `fleetflare[bot]`, matching the App.

### `fleet` CLI (new, baked into the container)

The agent's only way to report progress or request a gate. Called via Bash:

```
fleet milestone "tests green"
fleet request-approval merge_staging --pr 123
```

Writes to the container's own localhost server. `/status` surfaces it. No MCP
dependency, no network. Milestones and gate requests share one mechanism.

The container's `--append-system-prompt` gains: how to call `fleet`, that it
must end its turn after requesting approval, and that it must never merge or
deploy by hand.

### Container, deploy (new class, no claude)

Separate image. bun, git, wrangler. No Claude Code, no agent, no path from an
agent container to this one.

| Route | Behaviour |
|---|---|
| `POST /run` | `{targetId, repo, ref, workdir, command, secrets[]}`. Returns 202. |
| `GET /status` | Same shape as the agent container. Captures exit code and output tail. |

### Worker routes

| Route | Purpose |
|---|---|
| `POST /tg/:project` | Telegram webhook. Now handles `message` **and** `callback_query`. |
| `POST /gh` | GitHub webhook. HMAC-SHA256 verified via Web Crypto. |
| `GET /health` | Unchanged. |
| cron `* * * * *` | Watchdog sweep. §12. |

### Durable Objects

- `AgentDO` — gains the alarm loop, task state, heartbeat, abort.
- `DeployDO` — new. Same alarm-poll shape against the deploy container.

### GitHub App module (new)

Worker signs an RS256 JWT with Web Crypto, exchanges it for a 1-hour
installation access token. Two call sites: minting the agent's per-task token,
and minting the Worker's own token for a merge. The Worker's token never leaves
the Worker.

## 6. Data model

Two new D1 tables. `events` is unchanged.

```sql
CREATE TABLE deploy_targets (
  id       TEXT PRIMARY KEY,   -- 'websites:beta:staging'
  project  TEXT NOT NULL,
  repo     TEXT NOT NULL,      -- 'acme-org/websites'
  ref      TEXT NOT NULL,      -- branch to deploy from
  workdir  TEXT NOT NULL,      -- 'sites/beta'
  command  TEXT NOT NULL,      -- 'bun install && bun run build && wrangler pages deploy dist/client ...'
  secrets  TEXT NOT NULL,      -- JSON array of secret names to inject
  env      TEXT NOT NULL       -- 'staging' | 'production'
);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,          -- the approval_request event
  project       TEXT NOT NULL,
  action        TEXT NOT NULL,          -- merge_staging|deploy_staging|merge_main|deploy_prod
  params        TEXT NOT NULL,          -- JSON: {repo, pr, targetId, ...}
  state         TEXT NOT NULL,          -- pending|approved|rejected|executed|failed
  requested_ts  INTEGER NOT NULL,
  decided_ts    INTEGER,
  decided_by    TEXT,
  chat_id       TEXT NOT NULL,
  message_id    INTEGER,                -- Telegram message holding the keyboard
  result        TEXT
);
```

Plus one key-value row store for flags that must survive a Worker redeploy — the
`/pause` state in §11 is its only v1 occupant:

```sql
CREATE TABLE fleet_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts    INTEGER NOT NULL
);
```

Onboarding repo #2 is an `INSERT` into `deploy_targets`. Not a code change, not
a deploy. This is Day 1 spec §13's "no per-repo code" made concrete.

## 7. Gate flow

Four gates, all the operator's: merge into `staging`, deploy staging, merge into
`main`, deploy production.

1. Agent pushes a branch, opens a PR, runs
   `fleet request-approval merge_staging --pr 123`, ends its turn. Nothing stays
   alive.
2. `AgentDO` alarm sees `pendingApproval` in `/status`. Writes the
   `approval_request` event and the `approvals` row. Sends a **new** Telegram
   message carrying `[Approve] [Reject]`, `callback_data = <approvalId>:yes|no`.
3. Operator taps, whenever. Worker:
   - verifies `callback_query.from.id === OPERATOR_ID`;
   - `answerCallbackQuery` to stop the client spinner;
   - `editMessageText` replacing the keyboard with the decision and timestamp —
     no second tap, and the chat itself becomes the audit trail;
   - writes the `approval` event, flips the row.
4. Worker **executes**. The agent never does.
   - `merge_staging` / `merge_main` — mint installation token,
     `PUT /repos/{owner}/{repo}/pulls/{n}/merge`. Write a `report` event carrying
     the resulting SHA.
   - `deploy_staging` / `deploy_prod` — look up the `deploy_targets` row, get a
     `DeployDO` stub, send the command. Same alarm-poll, same live message, same
     buzzing terminal message. Machinery reused, not rebuilt.
5. The `approval` event is addressed to the agent (`handleCallbackQuery`,
   `src/approvals/gates.ts`, writes `to: agentForProject(row.project)?.id ??
   "cto"`) — that half shipped. **Deferred, not built:** nothing today reads
   that event to start a fresh turn. `readSince` has zero production callers.
   The agent is not resumed automatically; the operator has to send a new
   Telegram message to continue. Automatic rehydration remains future work.

**Reject.** Row → `rejected`. Nothing executes. A `report` event addressed to the
agent carries the rejection, and the agent stays stopped until the operator says
something next — a rejected gate never auto-starts a new turn, because the
operator's reason for rejecting is not yet known to anyone.

Idempotency: `callback_query.id` dedupes exactly as `update_id` does today, and
`state !== 'pending'` makes a duplicate a no-op that answers "already decided".

Unknown `targetId` refuses. It never falls back to a default command.

## 8. Identity and secrets

GitHub App `fleetflare`, installed on `acme-org` for `websites`.

| Secret | Holder | Lifetime |
|---|---|---|
| `GITHUB_APP_PRIVATE_KEY` | Worker, `wrangler secret put` | long |
| installation token, agent | container request body | 1 hour |
| installation token, merge | Worker memory, per call | 1 hour |
| `GITHUB_WEBHOOK_SECRET` | Worker | long |
| `CLOUDFLARE_DEPLOY_TOKEN` | deploy container only | long, v1 |
| `CLAUDE_CODE_OAUTH_TOKEN` | agent container `envVars` | long, unchanged |

`GITHUB_APP_ID` and `GITHUB_INSTALLATION_ID` are non-secret `vars`.

v1 uses `wrangler secret put` throughout. Infisical replaces the deploy
container's credential fetch behind the same interface once provisioned; nothing
else moves.

## 9. Failure handling

Every path ends in a `report` event and a buzzing Telegram message. **Nothing
retries an LLM turn automatically.** A retry is money.

| Failure | Detection | Result |
|---|---|---|
| Container dies mid-task | 3 consecutive failed polls, or `/status` does not know the taskId | Task marked failed, operator told |
| `claude` exits `is_error` | `/status` → `failed` | Same, carrying its error text |
| Deploy command fails | exit code + output tail | `report` with the tail, row → `failed` |
| Merge API rejects | GitHub's own message | `report`, row → `failed`, no retry |
| Telegram send fails | Day 1 behaviour | self-addressed `report` in D1 |
| Alarm itself dies | cron heartbeat sweep, §12 | alarm re-armed |

## 10. Security boundary

| Guarantee | Strength | Basis |
|---|---|---|
| Agent cannot publish to the internet | **Policy** (was Structural — demoted 2026-08-08) | The container still holds no Cloudflare token, no Infisical identity, and no reference to the deploy container. But the installed App grants `actions: write`, and `.github/workflows/client-reports.yml` has a `workflow_dispatch` trigger, a Deploy step, and `secrets.CLOUDFLARE_API_TOKEN`. So the agent can `POST .../actions/workflows/client-reports.yml/dispatches` and publish to production with no gate, using credentials the fleet never holds. Detected after the fact by §10's webhook; not prevented. Operator's accepted risk. |
| Agent cannot forge an approval | **Structural** | An `approval` row is only written by a `callback_query` whose `from.id` matches the operator. The agent holds no Telegram token and has no route to the Worker. Closes Day 1 spec §16 negative 4. |
| Only the CTO addresses the human | **Structural** for agent-authored replies; **by design** for Worker-authored operator notices | `routeDecision` is enforced at exactly two production sites, both in `src/tasks/loop.ts` (`:76`, `:205`) — the agent's own reply paths. Six other senders reach the operator directly, never through it: `src/deploy/do.ts:168,173` (`from:"deploy"`), `src/github/webhook.ts:156,167` (`from:"worker"`), `src/index.ts:81`, five notices in `src/telegram/webhook.ts` (`:91,100,115,148,188`), `src/approvals/gates.ts:148,158`, and the live milestone card, `src/tasks/loop.ts:156`. Two of the six (`deploy/do.ts`, `github/webhook.ts`) write a `to:"human"` event first — one `routeDecision` would refuse outright, since neither `"deploy"` nor `"worker"` is the CTO. The intent holds for those five: each is a Worker-authored notice, bypassing by design — reporting on the Worker's own action, or relaying an operator command, never an agent speaking. The sixth breaks that pattern. The live milestone card relays `status.milestones[].text` — text the agent itself supplied via `fleet milestone` — straight to Telegram, no `routeDecision` call at all. Safe today only because `AGENTS` (`src/agents/registry.ts`) holds one entry, and that entry is the CTO — not because anything stops a second project's agent from reaching the human unrouted. "Structural" alone overstated the enforcement here too; corrected here rather than in §13, which this row cites but does not itself describe. |
| Agent will not merge unasked | **Policy** | Its installation token carries `contents: write`, which is what merging requires. Instruction plus the webhook alarm below. |

**The residual risk, stated plainly.** GitHub branch protection and rulesets are
unavailable: `acme-org` is on the free plan and `websites` is
private. Measured 2026-08-08 — `GET /rulesets` and
`GET /branches/staging/protection` both return 403 *"Upgrade to GitHub Pro or
make this repository public"*. So a token that can push a feature branch can
also merge it. The agent is instructed not to, and is caught if it does. It is
not prevented.

Worst case is bounded: an unapproved merge lands a commit on a branch that
nothing auto-deploys. Merged is not served in this repo, and here that is a
safety property rather than a defect.

**Detection.** The repo has zero webhooks today, measured 2026-08-08. Spec A
subscribes the **GitHub App** to `push` and `pull_request`, delivered to
`POST /gh` — the App's own webhook, not a per-repo webhook, so repo #2 is
covered by installing the App rather than by remembering to add a hook. Any
write to `staging` or `main` with no matching `approval` row fires a Telegram
alert naming actor, SHA and branch, within seconds. This only works because
`fleetflare[bot]` is unmistakably not the operator — the second reason for the
GitHub App.

## 11. Cost guards

The largest unattended money unknown: Day 1 never confirmed whether fleet usage
draws subscription quota or extra-usage credits, and `hasExtraUsageEnabled` is
true, so overflow bills silently. These are hard limits enforced in code, not
guidance in a prompt.

- `MAX_TASK_SECONDS`, default 900. The alarm aborts past it.
- `MAX_TURNS_PER_THREAD`, default 10, counted over the event envelope's
  `thread`. Kills resume loops.
- One task per agent. A second inbound message while running is queued as an
  event, never a second container run.
- `/stop`, `/pause`, `/resume` are Telegram commands, handled in
  `POST /tg/:project` alongside ordinary messages. `/stop` aborts the running
  task via the container's `/abort`. `/pause` refuses new tasks until `/resume`;
  the flag lives in D1, so it survives a Worker redeploy.
- Every terminal event records `total_cost_usd` from claude's own JSON, so the
  event log answers "what did this cost" without opening a dashboard.

## 12. Watchdog

Day 1 spec §11 called the absence of alerting the actual defect. Closed here.

Alarm polls stamp a heartbeat. Worker cron, every minute, scans for `running`
tasks whose heartbeat is over 3 minutes stale — which means the DO alarm itself
died — and re-arms it. Two consecutive failed re-arms alert the operator.

Honest gap: §9 wanted a separate watchdog bot. Skipped. A second bot is not an
independent sender — the Worker sends both, so a broken Worker silences both.
Real coverage is an external pinger against `/health`. Named, out of scope, one
line of config to add later.

## 13. Day 1 open items folded in

1. `routeDecision`'s escalation branch returns before the `from === CTO_ID`
   check, so a CTO-authored escalation could never reach the human. Reorder.
2. `routeDecision(reply, [])` always passes an empty `recent`, so escalation
   dedupe can never fire. Pass a bounded `readSince` window.
3. `readSince` has zero production callers, leaving "context is a cache, the
   event log is the record" unimplemented. **Still true as shipped:** the
   resume path sketched in §7 step 5 was not built this round, so `readSince`
   gained no caller. Recorded as deferred, not as done — see §7 step 5.
4. Known red test, `test/telegram.webhook.test.ts:93`. §4 restructures that
   dispatch path anyway. Attempt the recovery rather than inherit the red; if it
   still needs a seam inside `webhook.ts`, build it.

## 14. Rename to `fleetflare`

Worker `fleetflare-fleet` → `fleetflare`. New URL
`https://fleetflare.demosite.workers.dev`.

**Renaming a Worker script creates a new Durable Object namespace. `AgentDO`
state does not carry over.** Harmless here — `AgentDO` persists nothing today, a
container handle and an in-memory field, and D1 holds everything real. Recorded
so nobody reads it as data loss later.

Order is not optional:

1. Deploy `fleetflare`.
2. `setWebhook` → `https://fleetflare.demosite.workers.dev/tg/websites`, checking
   the JSON `ok` field, not the HTTP status.
3. Verify: `/health` 200, both 403 negatives, one real message end to end.
4. Point the `fleetflare` App's webhook URL at the new host.
5. Only then delete `fleetflare-fleet`.

Reverse steps 1 and 2 and Telegram points at a 404. The D1 database keeps its
name and id; the binding is by id, not by Worker name.

Then: `docs/fleet/README.md`, this repo's memory, and the Day 1 spec's URL
references.

## 15. Out of scope for Spec A

- MCP capability server, agent registry in D1, fleet-as-MCP. All Spec B.
- Egress credential proxy. Still Day 1 spec §12's v2.
- GitHub Issues as task intake. Telegram only.
- Multi-project fan-out. `websites` only; repo #2 is a `deploy_targets` INSERT
  plus Spec B's registry.
- Hibernate and snapshot to R2.
- Replacing the local Agentastic fleet.

## 16. Upgrade path for §10's accepted risks

Two separate risks now live in §10. Both reverse by configuration, not redesign.

**A. The agent can merge unasked.** Accepted 2026-08-08.

1. Upgrade `acme-org` to GitHub Team.
2. Add a ruleset on `staging` and `main`: require a pull request before merging,
   restrict who may push.
3. Put the `example-org-fleet` App in the ruleset bypass list.

The Worker's merge path is unchanged by this. Only the agent's ability to bypass
it disappears.

**B. The agent can execute arbitrary code in GitHub Actions with two production
secrets.** Accepted 2026-08-10, after the concern was raised three times with
measured evidence. Recorded here at its true scope, which is larger than
"can publish unasked".

The installed App carries `actions: write`.
`.github/workflows/client-reports.yml` on `main` is `workflow_dispatch`-triggerable
and calls `actions/checkout@v4` at **both** jobs with **no pinned `ref`**. For a
`workflow_dispatch`, checkout defaults to the ref it was dispatched against.

So the agent can push a branch, dispatch that workflow against it, and **that
branch's code runs** — with `secrets.CLOUDFLARE_API_TOKEN` and
`secrets.WINDSOR_API_KEY` in the environment. That is arbitrary code execution,
not merely a production deploy. The workflow additionally interpolates
`${{ github.event.inputs.client }}` straight into a shell command, a script
injection sink reachable by anyone who can dispatch.

The agent does **not** need the `workflows` permission for this. It cannot edit
the workflow file and does not have to.

**How far this reaches depends entirely on `secrets.CLOUDFLARE_API_TOKEN`'s
scope, which is unmeasured.** If that token carries D1:Edit or Workers
Scripts:Edit on the Demosite account, then §10's remaining structural guarantee —
"an agent cannot forge an approval" — becomes reachable from outside this
codebase entirely, by rewriting the `approvals` table or replacing the Worker.
Nothing in this repository can prevent or detect that.

Reversal is a single setting: App → Permissions → **Actions → Read-only**.
Read-only still lets an agent see whether CI passed, and restores the structural
guarantee with **zero code change**. `organization_projects: admin` and
`repository_hooks: write` are also broader than this design requires and can be
dropped at the same time. Pinning `ref: main` in the workflow's checkout steps
would close the code-execution half independently of the App's permissions.

Until then §10 records the publish guarantee as **policy**, enforced by
instruction and caught after the fact by the GitHub webhook in §5 — not
prevented. The code-execution path above is neither prevented nor detected.

## 17. Operator prerequisites

Blocking. None can be automated.

1. Create GitHub App `fleetflare`. Install on `acme-org` for
   `websites`. Permissions: `contents: write`, `pull requests: write`,
   `metadata: read`. Subscribe to `push` and `pull_request`. Note the app id and
   installation id. Download the private key →
   `wrangler secret put GITHUB_APP_PRIVATE_KEY`.
2. Set the App's webhook URL to the new Worker host and its secret →
   `wrangler secret put GITHUB_WEBHOOK_SECRET`.
3. Mint the scoped Cloudflare API token for the deploy container (Day 1 spec
   §12; still not minted) → `wrangler secret put CLOUDFLARE_DEPLOY_TOKEN`.
4. Confirm on the Claude usage dashboard that fleet usage draws subscription
   quota, not extra-usage credits.

## 18. Verification

Day 1 discipline. Every claim traced to output actually read. Building an
artefact is not the same as it being served.

**Harness constraint, designed in rather than rediscovered.** Containers cannot
be constructed under `@cloudflare/vitest-pool-workers` — `enableContainers` is
hardcoded false. All new logic goes in plain functions taking a runtime
interface, called directly by tests, exactly as `deliver()` already is.

Required negatives:

1. A `callback_query` from a non-operator id is rejected. No `approval` row, no
   execution.
2. An `approval` event synthesized by an agent has no route to the callback
   path. Assert the verified callback is the only writer.
3. Double-tap executes once.
4. Container death mid-task surfaces as a failed task and a message, never a
   silent hang.
5. A task exceeding `MAX_TASK_SECONDS` is aborted.
6. A push to `staging` with no matching `approval` row alerts; one with a
   matching row stays silent.
7. An unknown `targetId` refuses instead of running a default command.
8. Deploy container holds no Claude Code binary and no `CLAUDE_CODE_OAUTH_TOKEN`.

Positive proof of life, in production, on the renamed Worker: a task typed from
the operator's phone clones the repo, changes a file, pushes a branch, opens a
PR, requests approval, and stops. Operator taps. The PR merges as
`fleetflare[bot]`. A deploy gate then runs a real `deploy_targets` command and
reports its exit code.
