# Cloud agent fleet on Cloudflare

Date: 2026-08-06. Status: pending human review.
Branch: `cloud-managed`. Repo: `websites`.

## 1. Goal

Run the agent fleet in the cloud. Operator controls it from Telegram while
travelling. Laptop becomes one client, not the host.

Hard constraints:

1. **Must run on Claude Max 20x subscription.** Zero Anthropic API credits.
2. **Must ship.** Code, PRs, merges, deploys. Not only conversation.
3. **Telegram is mandatory.** One chat per agent.
4. Operator departs 2026-08-08. Day-1 slice must work before then.

## 2. Why not Claude Managed Agents

Rejected on billing, not capability.

Managed Agents is a Claude Developer Platform product. Bills API token rates
plus $0.08 per session-hour against a Console key. Subscription cannot pay it.

The Agent SDK credit does not cover it. That credit lists four surfaces: Agent
SDK in own projects, `claude -p` headless, Claude Code GitHub Actions,
third-party apps authenticating with a subscription. Managed Agents absent.
Credit scheme also paused 2026-06-15, so `claude -p` currently runs against
ordinary subscription limits with no separate credit.

`cloudflare/claude-managed-agents` requires two Console-issued secrets:
`ANTHROPIC_ENVIRONMENT_KEY` (`sk-ant-oat01-…`, used for poll/ack/heartbeat/
force-stop/event stream) and `ANTHROPIC_API_KEY`. Both API-billed. Repo
unusable unmodified.

Cloudflare's own framing: agent loop runs on Anthropic, execution runs on
Cloudflare. The loop is the API-billed hop.

Measured on operator machine 2026-08-06: `ANTHROPIC_API_KEY` unset,
`billingType: stripe_subscription`, OAuth credential in Keychain.

Subscription OAuth tokens are policy-scoped to Claude Code and native Anthropic
apps. Pointing one at `/v1/agents` is outside permitted use. Not a design
option.

## 3. The substitution

Move the brain into the container.

`claude setup-token` exists in Claude Code 2.1.223: *"Set up a long-lived
authentication token (requires Claude subscription)"*. Same mechanism Claude
Code GitHub Actions uses. Produces a token supplied as
`CLAUDE_CODE_OAUTH_TOKEN`.

So: Claude Code runs **inside** the Cloudflare container, subscription-authed.
Anthropic's Managed Agents loop leaves the diagram. Cloudflare substrate stays.

Permitted-use boundary: operator's own containers, operator's own work, single
operator. Prohibition is on fronting claude.ai login for other people's
requests. Not what this is.

## 4. What carries over from `cloudflare/claude-managed-agents`

Used as blueprint, not dependency.

| Piece | Fate |
|---|---|
| Worker control plane, `/webhooks` | Keep. Serves Telegram, not Anthropic. |
| Container per session | Keep. One per agent. |
| Durable Object per session | Keep. Per-agent state. |
| Snapshots to R2 | Keep. Becomes the hibernate rule. |
| `SECRETS` + `EGRESS_POLICIES` KV, outbound proxy | Deferred to v2. See §12. |
| `BROWSER`, `AI`, `SEND_EMAIL`, `DB`, `vpc_services[]` | Keep. QA gets real CDP, no local Chrome. |
| `defineTool` (Zod, Worker-side, Anthropic calls it) | Reshape: same tools as an MCP server on the Worker; container `.mcp.json` points at it. |
| Anthropic session event stream | Replace with own D1 event log. |
| `multiagent` coordinator | Build. §7. |
| Memory stores | Replace with R2 + container volume. |

## 5. Architecture

```
Telegram --webhook--> Worker (control plane)
                        |
        +---------------+---------------+
        |          |         |          |
       D1         KV        R2      Queues
     events    secrets  snapshots  dispatch
     board                memory
        |
   DO per agent  --container binding-->  Container
   identity                              claude + git + gh + bun
   telegram binding                      CLAUDE_CODE_OAUTH_TOKEN
   inbox cursor                          .mcp.json -> Worker /mcp
   heartbeat alarm
```

Worker never reasons. Container never holds a secret it does not need. DO is
the only component that knows an agent exists.

### Worker routes

| Route | Purpose |
|---|---|
| `POST /tg/:bot` | Telegram webhook. Verifies `X-Telegram-Bot-Api-Secret-Token`. Routes to DO. |
| `POST /mcp/*` | MCP server exposing Cloudflare bindings as agent tools. |
| `POST /events` | Container posts events. Validated, written to D1, fanned out. |
| `GET /health` | Watchdog target. |
| `GET /` | Dashboard: agents, status, last heartbeat, pending approvals. |
| cron `* * * * *` | Watchdog sweep. |

### AgentDO

Owns: agent id, role, project, Telegram binding (bot + `chat_id` +
`message_thread_id`), inbox cursor into D1, container handle, status,
heartbeat timestamp.

Alarms: heartbeat check, idle hibernate, wake on inbound.

### Container

Image: node + bun + git + `gh` + `@anthropic-ai/claude-code`.

Env: `CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_ID`, `AGENT_ROLE`, `PROJECT`,
`MCP_URL`, `GITHUB_TOKEN` (v1, see §12).

Long-lived agents: `claude` in duplex streaming mode
(`--output-format stream-json --input-format stream-json`), process stays up.
Stateless agents: `claude -p` per task, exits.

## 6. Org chart

```
human --Telegram--> CTO --> manager --> release   (stateless, per batch)
                 long-lived  long-lived  qa        (stateless, per deploy)
                            hibernates   devops    (stateless, per task)
                                         dev x N   (stateless, per issue)
                                         explorer  (stateless, cron)
```

Two warm containers. Everything else born per task, dies after.

Mode assignment rationale: long-lived where a human is on the other end,
because a stateless CTO re-asks questions the operator already answered.
Stateless where code ships, matching the existing fleet rule: developer owns
one task end to end, killed once merged and verified.

**Invariant: container context is a cache, never the record.** D1 plus R2 hold
truth. Decisions written before acted on. Container dies, replacement
rehydrates from event log and loses speed, not information.

## 7. Protocol

Conversation: append-only event log in D1. Work dispatch: Cloudflare Queues.

Split reasoning: conversation needs ordering and replay, and that log replaces
`docs/fleet/` as the record agents must otherwise remember to update. Dispatch
needs retry and backpressure, so a dev container dying mid-task gets its
message redelivered rather than losing it.

### Envelope

```json
{
  "id": "evt_...",
  "ts": 1785000000000,
  "from": "manager",
  "to": "dev-42",
  "kind": "task|question|report|decision|escalation|human|approval_request|approval",
  "project": "websites",
  "ref": "IS#54",
  "thread": "IS#54",
  "body": "...",
  "requires_ack": true
}
```

### Fleet rules become code

| Rule, prose today | Enforcement |
|---|---|
| Only CTO talks to the human | Worker drops any `to:"human"` whose `from` is not `cto`. Filter, not request. |
| Deduplicate, never filter | Escalations hash on `thread` + normalized body. Three agents, same question, one Telegram message listing three sources. |
| Silence reads as forgetting | `requires_ack` blocks sender's next turn until acked. Dropped message becomes impossible. |
| Never two agents on one file | DO registry holds file-ownership claims per project. Second claimant is refused. |

Side effect: message bodies are D1 rows, never argv. Kills the `dev send`
paste-drop class of bug permanently.

## 8. Lifecycle

| Event | Behaviour |
|---|---|
| spawn | Worker creates DO, DO starts container, container clones repo at branch, emits `ready`. |
| hibernate | DO alarm on idle. Container snapshot to R2. Container stopped. |
| wake | Inbound event. Restore snapshot. `claude --continue`. |
| kill | Only after PR merged into `staging` AND QA green, both verified by Worker against GitHub API. Snapshot deleted, Telegram topic archived. |

Kill gate is machine-checked, not self-reported.

## 9. Telegram

Webhook, not long polling. `setWebhook` once per bot with a secret token.

This structurally deletes the failure class that took the local fleet down for
two days: no poller process to die on reboot, no orphan holding a token, no
second consumer answering at random, no registration boot race, no `bot.pid` to
babysit.

Topology:

- One bot per persistent CTO, each its own DM. Worker routes on bot token
  instead of `TELEGRAM_STATE_DIR`. Per-project isolation and blast-radius cap
  carry over from the local design.
- **v1 needs a new bot.** The three existing bots serve EO, BETA and Acme.
  `websites` has none, and it is the first fleet target (§13), so a
  `Websites | CTO` bot must be created in BotFather before Day 1 completes.
  Creating a bot and reading the operator's numeric id are the only two steps
  that cannot be automated.
- The three existing bots stay pointed at the local fleet until their projects
  onboard. Do not repoint a bot while a local poller may still hold its token:
  Telegram refuses two consumers, and the symptom is silent.
- Ephemeral agents get **forum topics** in one supergroup. Topic per issue,
  archived at merge. No BotFather work per agent, no ~20-bot ceiling.
- **Separate watchdog bot.** Speaks only when something is down.

Allowlist from first request: operator's numeric user id, enforced in Worker.
No pairing flow.

Formatting moves to the Worker send path. Keep the entity route:
`telegramify-markdown` `convert()` then `split_entities()`. Never
`markdownify()` plus `parse_mode` — that double-escapes and can be rejected
over markup, and the 4096 split bisects code blocks.

## 10. Approval gates

Nothing publishes unattended. Four gates, all operator's:

1. Merge into `staging`
2. Deploy staging
3. Merge into `main`
4. Deploy production

Release agent prepares fully — merge order resolved, gates run, real output
captured — then emits `approval_request`. Worker renders an inline keyboard.
Operator taps. Worker writes an `approval` event. Agent proceeds.

Agents cannot self-approve: Worker rejects any `approval` whose `from` is not
the operator's Telegram id.

Batching: multiple `approval_request` events on one thread render as one
message with per-item buttons, so a prepared batch is N taps rather than N
conversations.

## 11. Watchdog

Cron every minute. Worker reads each DO heartbeat age. Stale, restart
container. Two consecutive failed restarts, watchdog bot messages operator.

This exists because its absence cost two days of silent deafness. Absence of
alerting was the actual defect, not the dead process.

## 12. Secrets

Target state: KV `SECRETS` plus Cloudflare outbound proxy, container sees
placeholders only, real values substituted at egress. Same guarantee as
Anthropic vaults.

**v1 compromise, stated plainly:** container receives a fine-grained GitHub
token scoped to only the repos in scope, in env. Egress proxy is v2 hardening.
Blast radius is those repos. Accepted for the 2-day slice; not acceptable
permanently.

Never in container env, ever: global Cloudflare tokens, Directus admin tokens,
client credentials.

### Cloudflare token

Operator pasted a global-scope Cloudflare API token into a chat transcript on
2026-08-06. That token is compromised: it now exists in a session log on disk.
It must be rolled, and its replacement must be scoped, not global:

```
Account: Cloudflare Pages:Edit
Account: Workers Scripts:Edit
Account: D1:Edit
Account: Workers R2 Storage:Edit
Account: Workers KV Storage:Edit
```

Replacement is supplied via `wrangler secret put`, never through a chat, a
file, or a commit.

Related known blocker: the existing Cloudflare token lacks Pages scope, which
is why local deploys currently require unsetting it and falling back to OAuth.
A container has no browser, so OAuth is impossible there. The scoped
replacement above resolves this and is a prerequisite for Day 2.

## 13. Scope

Platform built in `websites`, multi-tenant in shape from the start: `project`
is a column on every event and a field on every agent, never a hardcoded path.

First fleet targets `websites`. Other repos onboard by config once validated.
No per-repo code.

## 14. Out of scope for v1

- Egress credential proxy (§12)
- Production auto-deploy without approval
- Multi-project fan-out beyond `websites`
- Replacing local Agentastic fleet. Cloud fleet runs alongside it.

## 15. Two-day sequence

Operator-only prerequisites, both blocking Day 1:

1. Roll the compromised Cloudflare token, create the scoped replacement (§12).
2. Create the `Websites | CTO` bot in BotFather (§9).

**Day 1.** Worker, AgentDO, container image, `CLAUDE_CODE_OAUTH_TOKEN` auth,
Telegram webhook, CTO agent only, D1 event log.
Proof of life: message from phone reaches `claude` in a Cloudflare container
and a real reply returns to the same chat.

**Day 2.** Manager, stateless dev spawn, git push plus PR from container,
approval gates, watchdog, hibernate and wake.

## 16. Verification

Positive-only checks pass identically when everything is collapsed onto one
agent. Required negatives:

1. Message to the EO bot does **not** appear in BETA or Acme context.
2. Before the allowlist is written, an inbound message from a non-operator id
   is dropped.
3. An event with `to:"human"` and `from:"dev-42"` never reaches Telegram.
4. An `approval` event forged by an agent is rejected.
5. Container killed mid-task: message redelivered from the Queue, work resumes,
   nothing lost.
6. Container killed while long-lived: wake restores from snapshot; with the
   snapshot deleted, agent rehydrates from the event log.
7. Watchdog: stop a container by hand, confirm restart within two minutes;
   break restart, confirm the operator is messaged.
8. Heartbeat staleness surfaces on the dashboard before the operator notices
   by hand.

Every claim traced to output actually read. Building an artefact is not the
same as it being served.
