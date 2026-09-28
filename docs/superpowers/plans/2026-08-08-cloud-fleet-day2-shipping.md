# Cloud Fleet Day 2 — Spec A: Shipping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the live cloud CTO agent a mounted GitHub repo, push and PR rights, and four Telegram approval gates, so it can ship code while every publish waits on an operator button press.

**Architecture:** The synchronous turn (LLM round trip inside the Telegram webhook request) becomes asynchronous. The container accepts a task and returns 202; a Durable Object schedule polls `/status` every 5s, appending milestones to D1 and editing one live Telegram message. Terminal states send a new, buzzing message — carrying an inline keyboard when the agent has requested a gate. The Worker, never the agent, executes every privileged action.

**Tech Stack:** Cloudflare Workers, Durable Objects, Cloudflare Containers (`@cloudflare/containers@0.0.20`), D1, `bun`, `wrangler@4`, `vitest@2` + `@cloudflare/vitest-pool-workers@0.12.21`, Claude Code `2.1.224` headless, Telegram Bot API, GitHub App REST API.

**Spec:** `docs/superpowers/specs/2026-08-08-cloud-fleet-day2-shipping-design.md`. Read it before Task 1. Where this plan and the spec disagree, the spec wins and the plan is wrong — report it.

## Global Constraints

Every task's requirements implicitly include this section.

- `ANTHROPIC_API_KEY` must appear nowhere — no code, no config, no test, no env. Max subscription, zero API credits.
- `bun` only. Never `npm`, `npx`, `pnpm`. Use `bunx` for one-off binaries.
- Every `wrangler` invocation is prefixed `env -u CLOUDFLARE_API_TOKEN` — the ambient token lacks the needed scopes and silently shadows the working OAuth login.
- Secrets reach production **only** via `wrangler secret put`. Never into a chat message, a file, a commit, a test fixture, or a `vars` block.
- Claude Code stays pinned at `@anthropic-ai/claude-code@2.1.224`. The auth gate parses its JSON output shape.
- The auth gate is `r.code !== 0 || r.raw == null || r.raw.is_error !== false`. Never gate on exit code alone; never read `subtype`. A missing credential exits **0** with `result: "Not logged in · Please run /login"`.
- Cloudflare account is Demosite `0000000000000000000000000000ac`.
- Working directory for all commands: `apps/fleet/`.
- Gates before every commit: `bun run test` and `bun run check` (both tsconfig projects).
- One accepted red test exists at baseline: `test/telegram.webhook.test.ts:93`. Task 6 addresses it. Until then, a suite reading 35/36 is expected, not a regression.
- **Containers cannot be constructed under `@cloudflare/vitest-pool-workers`** — it hardcodes `enableContainers: false`, so `ctx.container` is always undefined and instantiating `AgentDO` throws "Container is not enabled for this durable object class". All new logic goes in plain exported functions taking dependencies as parameters, called directly by tests. Durable Object classes stay thin shells. This is not negotiable; it is why Day 1's `deliver()` exists in the shape it does.
- Never override `alarm()` on a class extending `Container`. The library implements it and dispatches to named callbacks. Use `this.schedule(seconds, "methodName", payload)`, `this.deleteSchedules("methodName")`, and `this.renewActivityTimeout()`.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `migrations/0002_day2.sql` | `approvals`, `deploy_targets`, `fleet_state` tables |
| `src/state.ts` | `fleet_state` key-value accessors |
| `src/approvals/store.ts` | `approvals` row lifecycle. No business logic. |
| `src/approvals/gates.ts` | Gate action dispatch — what "approved" actually does |
| `src/deploy/targets.ts` | `deploy_targets` lookup |
| `src/deploy/do.ts` | `DeployDO` shell + `runDeploy()` logic function |
| `src/tasks/types.ts` | Shared task/gate types. No imports from elsewhere in `src`. |
| `src/tasks/loop.ts` | `advanceTask()` — the whole poll cycle as a pure function |
| `src/github/app.ts` | RS256 JWT → installation access token |
| `src/github/api.ts` | GitHub REST calls the Worker makes |
| `src/github/webhook.ts` | HMAC verification + unapproved-write detection |
| `container/fleet-cli.ts` | The `fleet` CLI the agent calls via Bash |
| `container/deploy-server.ts` | Deploy container HTTP server. No Claude. |
| `container/Dockerfile.deploy` | Deploy container image |

**Modified**

| Path | Change |
|---|---|
| `wrangler.jsonc` | Rename, `DeployDO`, second container, cron, vars |
| `src/env.ts` | New bindings, secrets, vars |
| `src/index.ts` | `/gh` route, `scheduled` handler, export `DeployDO` |
| `src/telegram/api.ts` | `message_id` returns, cards, keyboards, callback answers |
| `src/telegram/webhook.ts` | `callback_query`, commands, async dispatch |
| `src/agents/runtime.ts` | `ask()` → `startTask()` / `status()` / `abort()` |
| `src/agents/do.ts` | `deliver()` → `pollTask` schedule shell |
| `src/events/rules.ts` | Escalation ordering fix |
| `container/server.ts` | `/task`, `/status`, `/abort`, repo mount |
| `container/Dockerfile` | `fleet` CLI, git identity |

---

## Task 1: Schema, stores, and the two `routeDecision` defects

Pure D1 and pure logic. No container, no network. Fully testable under the existing harness.

**Files:**
- Create: `migrations/0002_day2.sql`
- Create: `src/state.ts`
- Create: `src/approvals/store.ts`
- Create: `src/deploy/targets.ts`
- Create: `src/tasks/types.ts`
- Modify: `src/events/rules.ts`
- Test: `test/approvals.store.test.ts`, `test/deploy.targets.test.ts`, `test/state.test.ts`
- Modify test: `test/events.rules.test.ts`

**Interfaces:**
- Consumes: `appendEvent`, `readSince` from `src/events/log.ts`; `FleetEvent`, `makeEvent` from `src/events/schema.ts` (all unchanged).
- Produces:
  - `type GateAction = "merge_staging" | "deploy_staging" | "merge_main" | "deploy_prod"`
  - `type ApprovalState = "pending" | "approved" | "rejected" | "executed" | "failed"`
  - `interface ApprovalRow { id, eventId, project, action: GateAction, params: Record<string,string>, state: ApprovalState, requestedTs, decidedTs, decidedBy, chatId, messageId, result }`
  - `createApproval(db, input): Promise<ApprovalRow>`
  - `getApproval(db, id): Promise<ApprovalRow | null>`
  - `setApprovalMessageId(db, id, messageId): Promise<void>`
  - `decideApproval(db, id, state, decidedBy, now): Promise<boolean>` — false when already decided
  - `finishApproval(db, id, state, result): Promise<void>`
  - `recentApprovalsFor(db, project, action, sinceTs): Promise<ApprovalRow[]>`
  - `interface DeployTarget { id, project, repo, ref, workdir, command, secrets: string[], env }`
  - `getDeployTarget(db, id): Promise<DeployTarget | null>`
  - `getFlag(db, key): Promise<string | null>` / `setFlag(db, key, value, now): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/approvals.store.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createApproval, getApproval, decideApproval, finishApproval,
  setApprovalMessageId, recentApprovalsFor,
} from "../src/approvals/store";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM approvals").run();
});

const base = {
  id: "appr_1",
  eventId: "evt_1",
  project: "websites",
  action: "merge_staging" as const,
  params: { repo: "o/r", pr: "123" },
  chatId: "100000001",
};

describe("approvals store", () => {
  it("round-trips params as structured data, not a string", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.params).toEqual({ repo: "o/r", pr: "123" });
    expect(row?.state).toBe("pending");
    expect(row?.requestedTs).toBe(1000);
  });

  it("decides exactly once", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    expect(await decideApproval(env.DB, "appr_1", "approved", "100000001", 2000)).toBe(true);
    expect(await decideApproval(env.DB, "appr_1", "approved", "100000001", 3000)).toBe(false);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.decidedTs).toBe(2000);
  });

  it("refuses to decide a row that does not exist", async () => {
    expect(await decideApproval(env.DB, "nope", "approved", "1", 1)).toBe(false);
  });

  it("records the live message id and the terminal result", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    await setApprovalMessageId(env.DB, "appr_1", 77);
    await finishApproval(env.DB, "appr_1", "executed", "merged abc123");
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.messageId).toBe(77);
    expect(row?.state).toBe("executed");
    expect(row?.result).toBe("merged abc123");
  });

  it("finds recent approvals scoped to project and action", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    await createApproval(env.DB, { ...base, id: "appr_2", action: "merge_main" }, 1500);
    await createApproval(env.DB, { ...base, id: "appr_3", project: "other" }, 1600);
    const hits = await recentApprovalsFor(env.DB, "websites", "merge_staging", 500);
    expect(hits.map((h) => h.id)).toEqual(["appr_1"]);
  });

  it("excludes approvals older than the window", async () => {
    await createApproval(env.DB, { ...base }, 1000);
    const hits = await recentApprovalsFor(env.DB, "websites", "merge_staging", 2000);
    expect(hits).toEqual([]);
  });
});
```

Create `test/deploy.targets.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { getDeployTarget } from "../src/deploy/targets";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM deploy_targets").run();
  await env.DB.prepare(
    `INSERT INTO deploy_targets (id, project, repo, ref, workdir, command, secrets, env)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    "websites:beta:staging", "websites", "acme-org/websites", "staging",
    "sites/beta", "bun install && bun run build", '["CLOUDFLARE_DEPLOY_TOKEN"]', "staging",
  ).run();
});

describe("deploy targets", () => {
  it("reads a target and parses its secret list", async () => {
    const t = await getDeployTarget(env.DB, "websites:beta:staging");
    expect(t?.workdir).toBe("sites/beta");
    expect(t?.secrets).toEqual(["CLOUDFLARE_DEPLOY_TOKEN"]);
  });

  it("returns null for an unknown id rather than a default", async () => {
    expect(await getDeployTarget(env.DB, "websites:beta:production")).toBeNull();
  });
});
```

Create `test/state.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { getFlag, setFlag } from "../src/state";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("fleet_state", () => {
  it("returns null for an unset key", async () => {
    expect(await getFlag(env.DB, "paused")).toBeNull();
  });

  it("sets and overwrites", async () => {
    await setFlag(env.DB, "paused", "1", 1000);
    expect(await getFlag(env.DB, "paused")).toBe("1");
    await setFlag(env.DB, "paused", "0", 2000);
    expect(await getFlag(env.DB, "paused")).toBe("0");
  });
});
```

Append to `test/events.rules.test.ts`:

```ts
it("lets a CTO-authored escalation reach the human", () => {
  const e = makeEvent(
    { from: "cto", to: "human", kind: "escalation", project: "websites", body: "price call" },
    1, "a",
  );
  const d = routeDecision(e, []);
  expect(d).toEqual({ allow: true, toHuman: true });
});

it("still keeps a non-CTO escalation away from the human", () => {
  const e = makeEvent(
    { from: "dev-42", to: "human", kind: "escalation", project: "websites", body: "price call" },
    1, "a",
  );
  const d = routeDecision(e, []);
  // Post-fix shape. Step 6 routes this through the shared human-addressing
  // gate, so it is refused with a reason rather than passed through as an
  // ordinary internal message. Both keep it away from the operator.
  expect(d).toEqual({ allow: false, reason: "only the CTO may address the human" });
});

it("still dedupes a CTO escalation against an identical recent one", () => {
  const mk = (id: string) => makeEvent(
    { from: "cto", to: "human", kind: "escalation", project: "websites", thread: "T1", body: "Price?" },
    1, id,
  );
  expect(routeDecision(mk("b"), [mk("a")])).toEqual({
    allow: false, reason: "duplicate escalation on this thread",
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

```bash
env -u CLOUDFLARE_API_TOKEN bun run test
```

Expected: the three new files fail to resolve their imports; the three new `rules` tests fail on the current ordering. Record the exact failure text in the ledger — a test that fails for the wrong reason proves nothing.

- [ ] **Step 3: Write the migration**

Create `migrations/0002_day2.sql`:

```sql
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT    PRIMARY KEY,
  event_id      TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  params        TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  requested_ts  INTEGER NOT NULL,
  decided_ts    INTEGER,
  decided_by    TEXT,
  chat_id       TEXT    NOT NULL,
  message_id    INTEGER,
  result        TEXT
);

CREATE INDEX IF NOT EXISTS approvals_lookup ON approvals (project, action, requested_ts);
CREATE INDEX IF NOT EXISTS approvals_state  ON approvals (state);

CREATE TABLE IF NOT EXISTS deploy_targets (
  id       TEXT PRIMARY KEY,
  project  TEXT NOT NULL,
  repo     TEXT NOT NULL,
  ref      TEXT NOT NULL,
  workdir  TEXT NOT NULL,
  command  TEXT NOT NULL,
  secrets  TEXT NOT NULL,
  env      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts    INTEGER NOT NULL
);
```

- [ ] **Step 4: Write the shared types**

Create `src/tasks/types.ts`:

```ts
export type GateAction = "merge_staging" | "deploy_staging" | "merge_main" | "deploy_prod";

export const GATE_ACTIONS: GateAction[] = [
  "merge_staging", "deploy_staging", "merge_main", "deploy_prod",
];

export function isGateAction(v: string): v is GateAction {
  return (GATE_ACTIONS as string[]).includes(v);
}

/** Human-facing label for the approval message. */
export const GATE_LABELS: Record<GateAction, string> = {
  merge_staging: "Merge into staging",
  deploy_staging: "Deploy staging",
  merge_main: "Merge into main",
  deploy_prod: "Deploy production",
};

export type TaskState = "idle" | "running" | "done" | "failed";

export interface Milestone {
  ts: number;
  text: string;
}

export interface PendingApproval {
  action: GateAction;
  params: Record<string, string>;
}

/** Exactly what the agent container's GET /status returns. */
export interface TaskStatus {
  state: TaskState;
  taskId: string | null;
  milestones: Milestone[];
  pendingApproval: PendingApproval | null;
  result: string | null;
  error: string | null;
  costUsd: number | null;
}
```

- [ ] **Step 5: Write the stores**

Create `src/state.ts`:

```ts
export async function getFlag(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setFlag(
  db: D1Database, key: string, value: string, now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
    )
    .bind(key, value, now)
    .run();
}
```

Create `src/deploy/targets.ts`:

```ts
export interface DeployTarget {
  id: string;
  project: string;
  repo: string;
  ref: string;
  workdir: string;
  command: string;
  secrets: string[];
  env: string;
}

interface Row {
  id: string; project: string; repo: string; ref: string;
  workdir: string; command: string; secrets: string; env: string;
}

/**
 * Returns null for an unknown id. Callers must refuse rather than substitute a
 * default: a deploy that runs the wrong command is worse than one that does not
 * run at all.
 */
export async function getDeployTarget(
  db: D1Database, id: string,
): Promise<DeployTarget | null> {
  const r = await db
    .prepare(`SELECT * FROM deploy_targets WHERE id = ?`)
    .bind(id)
    .first<Row>();
  if (!r) return null;
  return { ...r, secrets: JSON.parse(r.secrets) as string[] };
}
```

Create `src/approvals/store.ts`:

```ts
import type { GateAction } from "../tasks/types";

export type ApprovalState = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface ApprovalRow {
  id: string;
  eventId: string;
  project: string;
  action: GateAction;
  params: Record<string, string>;
  state: ApprovalState;
  requestedTs: number;
  decidedTs: number | null;
  decidedBy: string | null;
  chatId: string;
  messageId: number | null;
  result: string | null;
}

export interface NewApproval {
  id: string;
  eventId: string;
  project: string;
  action: GateAction;
  params: Record<string, string>;
  chatId: string;
}

interface Row {
  id: string; event_id: string; project: string; action: string;
  params: string; state: string; requested_ts: number;
  decided_ts: number | null; decided_by: string | null;
  chat_id: string; message_id: number | null; result: string | null;
}

function toApproval(r: Row): ApprovalRow {
  return {
    id: r.id,
    eventId: r.event_id,
    project: r.project,
    action: r.action as GateAction,
    params: JSON.parse(r.params) as Record<string, string>,
    state: r.state as ApprovalState,
    requestedTs: r.requested_ts,
    decidedTs: r.decided_ts,
    decidedBy: r.decided_by,
    chatId: r.chat_id,
    messageId: r.message_id,
    result: r.result,
  };
}

export async function createApproval(
  db: D1Database, input: NewApproval, now: number,
): Promise<ApprovalRow> {
  await db
    .prepare(
      `INSERT INTO approvals (id, event_id, project, action, params, state, requested_ts, chat_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      input.id, input.eventId, input.project, input.action,
      JSON.stringify(input.params), now, input.chatId,
    )
    .run();
  const row = await getApproval(db, input.id);
  if (!row) throw new Error(`approval ${input.id} vanished immediately after insert`);
  return row;
}

export async function getApproval(db: D1Database, id: string): Promise<ApprovalRow | null> {
  const r = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<Row>();
  return r ? toApproval(r) : null;
}

export async function setApprovalMessageId(
  db: D1Database, id: string, messageId: number,
): Promise<void> {
  await db
    .prepare(`UPDATE approvals SET message_id = ? WHERE id = ?`)
    .bind(messageId, id)
    .run();
}

/**
 * Transitions pending -> approved|rejected, once. The `state = 'pending'`
 * predicate is the whole idempotency guarantee: Telegram redelivers callback
 * queries and a human can double-tap before the keyboard is edited away.
 * Returns false when the row is missing or already decided.
 */
export async function decideApproval(
  db: D1Database,
  id: string,
  state: "approved" | "rejected",
  decidedBy: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE approvals SET state = ?, decided_by = ?, decided_ts = ?
       WHERE id = ? AND state = 'pending'`,
    )
    .bind(state, decidedBy, now, id)
    .run();
  return res.meta.changes > 0;
}

export async function finishApproval(
  db: D1Database, id: string, state: "executed" | "failed", result: string,
): Promise<void> {
  await db
    .prepare(`UPDATE approvals SET state = ?, result = ? WHERE id = ?`)
    .bind(state, result.slice(0, 2000), id)
    .run();
}

export async function recentApprovalsFor(
  db: D1Database, project: string, action: GateAction, sinceTs: number,
): Promise<ApprovalRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM approvals
       WHERE project = ? AND action = ? AND requested_ts >= ?
       ORDER BY requested_ts DESC`,
    )
    .bind(project, action, sinceTs)
    .all<Row>();
  return (res.results ?? []).map(toApproval);
}
```

- [ ] **Step 6: Fix `routeDecision`**

The escalation branch currently returns before the `to === "human"` / `from === CTO_ID` check, so a CTO-authored escalation can never reach the operator. Dedupe must still run first — it is the "deduplicate, never filter" rule and applies to every escalation regardless of author.

Replace the body of `routeDecision` in `src/events/rules.ts`:

```ts
export function routeDecision(e: FleetEvent, recent: FleetEvent[]): Decision {
  // Dedupe first, and for every author. "Deduplicate, never filter" is about
  // collapsing the same question arriving from several directions; the CTO is
  // one of those directions.
  if (e.kind === "escalation") {
    const key = dedupeKey(e);
    const dup = recent.some((r) => r.kind === "escalation" && dedupeKey(r) === key);
    if (dup) return { allow: false, reason: "duplicate escalation on this thread" };
  }

  // One rule for who may address the human, applied to every kind. Previously
  // the escalation branch returned above this check, so a CTO escalation was
  // silently downgraded to toHuman:false and the operator never saw it.
  if (e.to === "human") {
    if (e.from !== CTO_ID) {
      return { allow: false, reason: "only the CTO may address the human" };
    }
    return { allow: true, toHuman: true };
  }

  return { allow: true, toHuman: false };
}
```

Note the deliberate behaviour change: a non-CTO escalation addressed to `"human"` now returns `allow:false` with the "only the CTO" reason, where it previously returned `allow:true, toHuman:false`. Both keep it away from the operator. The new shape is louder — a dropped event is recorded with a reason rather than silently logged as an ordinary internal message. Update any existing assertion that expected the old shape, and say so in the ledger rather than editing it quietly.

- [ ] **Step 7: Apply the migration locally and run the tests**

```bash
env -u CLOUDFLARE_API_TOKEN bun run migrate:local
env -u CLOUDFLARE_API_TOKEN bun run test
env -u CLOUDFLARE_API_TOKEN bun run check
```

Expected: all new tests pass, `check` exits 0, suite is the previous count plus the new tests with only the one known red at `test/telegram.webhook.test.ts:93`.

`test/apply-migrations.ts` uses `readD1Migrations` against the whole `migrations/` directory, so `0002` is picked up with no harness edit. Confirm that by observing the new tables resolve rather than by assuming it.

- [ ] **Step 8: Mutation-verify the idempotency test**

Temporarily drop `AND state = 'pending'` from `decideApproval`. Run `bun run test`. Expected: "decides exactly once" fails and nothing else does. Restore the predicate, re-run, confirm green. A test that passes against the broken code is not protecting anything.

- [ ] **Step 9: Commit**

```bash
git add migrations/0002_day2.sql src/state.ts src/approvals/store.ts \
        src/deploy/targets.ts src/tasks/types.ts src/events/rules.ts \
        test/approvals.store.test.ts test/deploy.targets.test.ts \
        test/state.test.ts test/events.rules.test.ts
git commit -m "feat(fleet): approvals, deploy targets and fleet state in D1

Also fixes routeDecision: the escalation branch returned before the
addressed-to-human check, so a CTO escalation could never reach the
operator. Dedupe still runs first, for every author."
```

---

## Task 2: Telegram cards, keyboards and callback answers

Everything the live-edited status message needs. Still no container, no GitHub.

**Files:**
- Modify: `src/telegram/api.ts`
- Test: `test/telegram.api.test.ts`

**Interfaces:**
- Consumes: `chunk()` from `src/telegram/chunk.ts` (unchanged); `test/mock-network.ts` already intercepts `api.telegram.org`.
- Produces:
  - `interface InlineButton { text: string; callbackData: string }`
  - `sendMessage(token, chatId, text): Promise<number[]>` — **return type changed** from `void` to the message ids of every piece sent
  - `sendCard(token, chatId, text, buttons?): Promise<number>` — exactly one message, truncated not chunked, returns its id
  - `editCard(token, chatId, messageId, text, buttons?): Promise<void>`
  - `answerCallbackQuery(token, callbackQueryId, text?): Promise<void>`

`sendCard` exists separately from `sendMessage` because a live-edited status message must be exactly one message. `chunk()` may legitimately split into several, and there is no such thing as editing "the message" once that happens.

- [ ] **Step 1: Write the failing test**

`test/mock-network.ts` currently returns a failure response for `api.telegram.org`. These tests need to inspect outbound bodies and return success, so give the mock a per-test override rather than replacing it — Day 1 relies on its failure behaviour in `agents.do.test.ts`.

Create `test/telegram.api.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendMessage, sendCard, editCard, answerCallbackQuery } from "../src/telegram/api";

interface Call { url: string; body: any }
let calls: Call[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, body: JSON.parse(init.body as string) });
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("telegram api", () => {
  it("sendMessage returns a message id per piece", async () => {
    const ids = await sendMessage("T", "99", "hello");
    expect(ids).toEqual([4242]);
    expect(calls[0].url).toContain("/botT/sendMessage");
    expect(calls[0].body.chat_id).toBe("99");
  });

  it("sendCard sends exactly one message even past the length limit", async () => {
    const long = "x".repeat(9000);
    const id = await sendCard("T", "99", long);
    expect(id).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text.length).toBeLessThanOrEqual(4096);
  });

  it("sendCard renders buttons as a Telegram inline keyboard", async () => {
    await sendCard("T", "99", "approve?", [
      { text: "Approve", callbackData: "appr_1:yes" },
      { text: "Reject", callbackData: "appr_1:no" },
    ]);
    expect(calls[0].body.reply_markup).toEqual({
      inline_keyboard: [[
        { text: "Approve", callback_data: "appr_1:yes" },
        { text: "Reject", callback_data: "appr_1:no" },
      ]],
    });
  });

  it("editCard targets a message and can clear the keyboard", async () => {
    await editCard("T", "99", 4242, "decided");
    expect(calls[0].url).toContain("/editMessageText");
    expect(calls[0].body.message_id).toBe(4242);
    expect(calls[0].body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("answerCallbackQuery posts the query id", async () => {
    await answerCallbackQuery("T", "cbq1", "already decided");
    expect(calls[0].url).toContain("/answerCallbackQuery");
    expect(calls[0].body.callback_query_id).toBe("cbq1");
  });

  it("throws when Telegram reports logical failure in the body", async () => {
    globalThis.fetch = (async () =>
      Response.json({ ok: false, description: "chat not found" })) as typeof globalThis.fetch;
    await expect(sendCard("T", "99", "hi")).rejects.toThrow(/chat not found/);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

```bash
env -u CLOUDFLARE_API_TOKEN bunx vitest run test/telegram.api.test.ts
```

Expected: FAIL, `sendCard` / `editCard` / `answerCallbackQuery` not exported.

- [ ] **Step 3: Implement**

Add to `src/telegram/api.ts`, keeping the existing `sendMessage` chunking behaviour and its `res.ok` check intact:

```ts
export interface InlineButton {
  text: string;
  callbackData: string;
}

const LIMIT = 4096;

function keyboard(buttons?: InlineButton[]) {
  // An empty inline_keyboard is how a keyboard is REMOVED on edit. Sending
  // undefined leaves the old buttons in place and the gate stays tappable.
  if (!buttons || buttons.length === 0) return { inline_keyboard: [] };
  return {
    inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))],
  };
}

async function call(token: string, method: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`telegram ${method} returned unparseable body: ${text.slice(0, 300)}`);
  }
  // Telegram reports logical failure in the body, not the status. setWebhook
  // taught us this on Day 1; it is true of every method.
  if (!res.ok || parsed?.ok !== true) {
    throw new Error(
      `telegram ${method} failed (${res.status}): ${parsed?.description ?? text.slice(0, 300)}`,
    );
  }
  return parsed.result;
}

/**
 * Exactly one message. Truncates rather than chunking: the caller intends to
 * edit this message later, and "the message" is not a well-defined thing once
 * chunk() has produced three of them.
 */
export async function sendCard(
  token: string, chatId: string, text: string, buttons?: InlineButton[],
): Promise<number> {
  const body = text.length > LIMIT ? `${text.slice(0, LIMIT - 2)} …` : text;
  const result = await call(token, "sendMessage", {
    chat_id: chatId,
    text: body,
    reply_markup: keyboard(buttons),
  });
  return result.message_id as number;
}

export async function editCard(
  token: string, chatId: string, messageId: number, text: string, buttons?: InlineButton[],
): Promise<void> {
  const body = text.length > LIMIT ? `${text.slice(0, LIMIT - 2)} …` : text;
  await call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: body,
    reply_markup: keyboard(buttons),
  });
}

export async function answerCallbackQuery(
  token: string, callbackQueryId: string, text?: string,
): Promise<void> {
  await call(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}
```

Change `sendMessage` to collect and return ids. Its existing loop already sends piece by piece and already throws on `!res.ok` and on `sent === 0`; keep both. Capture each piece's `message_id` from the parsed body and return the array. Do not route `sendMessage` through `call()` — its whitespace-skip and partial-delivery error text are load-bearing and were argued through in Day 1's review.

- [ ] **Step 4: Run the tests**

```bash
env -u CLOUDFLARE_API_TOKEN bun run test
env -u CLOUDFLARE_API_TOKEN bun run check
```

Expected: new file green; `test/agents.do.test.ts` still green, because it depends on `sendMessage` throwing under the failure mock and that path is untouched.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/api.ts test/telegram.api.test.ts
git commit -m "feat(fleet): telegram cards, inline keyboards, callback answers"
```

---

## Task 3: The task loop as a pure function

The seam. All poll-cycle logic lives here, testable without a container.

**Files:**
- Create: `src/tasks/loop.ts`
- Modify: `src/agents/runtime.ts`
- Test: `test/tasks.loop.test.ts`

**Interfaces:**
- Consumes: `TaskStatus`, `Milestone`, `PendingApproval`, `GateAction`, `GATE_LABELS` (Task 1); `sendCard`, `editCard` (Task 2); `appendEvent`, `makeEvent`; `createApproval`, `setApprovalMessageId` (Task 1).
- Produces:
  - `interface StartTaskInput { taskId, prompt, repo, ref, ghToken }`
  - `interface AgentRuntime { startTask(i: StartTaskInput): Promise<void>; status(): Promise<TaskStatus>; abort(): Promise<void> }` — **replaces `ask()`**
  - `class FakeRuntime implements AgentRuntime` — script-driven, for tests
  - `interface TaskRecord { taskId, agentId, project, thread, chatId, liveMessageId, startedTs, lastHeartbeat, failedPolls, shownMilestones }`
  - `interface LoopDeps { db, runtime, botToken, now, maxTaskSeconds, maxFailedPolls }`
  - `type LoopOutcome = { kind: "continue"; task: TaskRecord } | { kind: "terminal"; task: TaskRecord }`
  - `advanceTask(deps: LoopDeps, task: TaskRecord): Promise<LoopOutcome>`

- [ ] **Step 1: Write the failing test**

Create `test/tasks.loop.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { advanceTask, type TaskRecord, type LoopDeps } from "../src/tasks/loop";
import { FakeRuntime } from "../src/agents/runtime";
import { readSince } from "../src/events/log";
import { getApproval } from "../src/approvals/store";
import type { TaskStatus } from "../src/tasks/types";

let calls: { url: string; body: any }[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
  await env.DB.prepare("DELETE FROM approvals").run();
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      body: JSON.parse(init.body as string),
    });
    return Response.json({ ok: true, result: { message_id: 500 + calls.length } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: "task_1",
  agentId: "cto",
  project: "websites",
  thread: "T1",
  chatId: "100000001",
  liveMessageId: null,
  startedTs: 1000,
  lastHeartbeat: 1000,
  failedPolls: 0,
  shownMilestones: 0,
  ...over,
});

const deps = (runtime: FakeRuntime, over: Partial<LoopDeps> = {}): LoopDeps => ({
  db: env.DB,
  runtime,
  botToken: "T",
  now: 2000,
  maxTaskSeconds: 900,
  maxFailedPolls: 3,
  ...over,
});

const running = (milestones: string[]): TaskStatus => ({
  state: "running", taskId: "task_1",
  milestones: milestones.map((text, i) => ({ ts: 1000 + i, text })),
  pendingApproval: null, result: null, error: null, costUsd: null,
});

describe("advanceTask", () => {
  it("posts the live card on the first poll and keeps its id", async () => {
    const r = new FakeRuntime([running(["cloned repo"])]);
    const out = await advanceTask(deps(r), task());
    expect(out.kind).toBe("continue");
    expect(out.task.liveMessageId).toBe(501);
    expect(calls[0].url).toContain("/sendMessage");
    expect(calls[0].body.text).toContain("cloned repo");
  });

  it("edits the same message on later polls instead of sending a new one", async () => {
    const r = new FakeRuntime([running(["cloned repo", "tests green"])]);
    await advanceTask(deps(r), task({ liveMessageId: 501, shownMilestones: 1 }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/editMessageText");
    expect(calls[0].body.text).toContain("tests green");
  });

  it("does not touch Telegram when no new milestone arrived", async () => {
    const r = new FakeRuntime([running(["cloned repo"])]);
    await advanceTask(deps(r), task({ liveMessageId: 501, shownMilestones: 1 }));
    expect(calls).toHaveLength(0);
  });

  it("logs each new milestone to D1 exactly once", async () => {
    const r = new FakeRuntime([running(["a", "b"]), running(["a", "b", "c"])]);
    const first = await advanceTask(deps(r), task());
    const second = await advanceTask(deps(r), first.task);
    const events = await readSince(env.DB, "cto", 0);
    expect(events.filter((e) => e.kind === "report").map((e) => e.body))
      .toEqual(["a", "b", "c"]);
    expect(second.task.shownMilestones).toBe(3);
  });

  it("on done, sends a NEW buzzing message and stops", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [], pendingApproval: null,
      result: "PR #7 open", error: null, costUsd: 0.42,
    }]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, shownMilestones: 0 }));
    expect(out.kind).toBe("terminal");
    const sends = calls.filter((c) => c.url.includes("/sendMessage"));
    expect(sends).toHaveLength(1);
    expect(sends[0].body.text).toContain("PR #7 open");
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => e.body.includes("PR #7 open"))).toBe(true);
  });

  it("records the reported cost on the terminal event", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [], pendingApproval: null,
      result: "ok", error: null, costUsd: 0.42,
    }]);
    await advanceTask(deps(r), task({ liveMessageId: 501 }));
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => e.body.includes("0.42"))).toBe(true);
  });

  it("on a pending approval, writes the row and sends a keyboard", async () => {
    const r = new FakeRuntime([{
      state: "done", taskId: "task_1", milestones: [],
      pendingApproval: { action: "merge_staging", params: { repo: "o/r", pr: "7" } },
      result: null, error: null, costUsd: null,
    }]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501 }));
    expect(out.kind).toBe("terminal");
    const send = calls.find((c) => c.url.includes("/sendMessage"))!;
    const buttons = send.body.reply_markup.inline_keyboard[0];
    expect(buttons).toHaveLength(2);
    const id = buttons[0].callback_data.split(":")[0];
    const row = await getApproval(env.DB, id);
    expect(row?.action).toBe("merge_staging");
    expect(row?.params).toEqual({ repo: "o/r", pr: "7" });
    expect(row?.state).toBe("pending");
    // The mock returns 500 + calls.length, so the first send is 501. The row
    // must carry it, or the operator's tap has no message to edit.
    expect(row?.messageId).toBe(501);
  });

  it("on failed, reports the error and stops", async () => {
    const r = new FakeRuntime([{
      state: "failed", taskId: "task_1", milestones: [], pendingApproval: null,
      result: null, error: "claude failed (api_error): 401", costUsd: null,
    }]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501 }));
    expect(out.kind).toBe("terminal");
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => e.body.includes("401"))).toBe(true);
  });

  it("aborts a task that outran maxTaskSeconds", async () => {
    const r = new FakeRuntime([running(["still going"])]);
    const out = await advanceTask(
      deps(r, { now: 1000 + 901_000 }),
      task({ liveMessageId: 501, startedTs: 1000 }),
    );
    expect(out.kind).toBe("terminal");
    expect(r.aborted).toBe(true);
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => /budget|timed out|aborted/i.test(e.body))).toBe(true);
  });

  it("counts a failed poll and keeps going below the threshold", async () => {
    const r = new FakeRuntime([], new Error("container unreachable"));
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, failedPolls: 0 }));
    expect(out.kind).toBe("continue");
    expect(out.task.failedPolls).toBe(1);
  });

  it("declares the task dead after maxFailedPolls consecutive failures", async () => {
    const r = new FakeRuntime([], new Error("container unreachable"));
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, failedPolls: 2 }));
    expect(out.kind).toBe("terminal");
    const events = await readSince(env.DB, "human", 0);
    expect(events.some((e) => /unreachable|lost/i.test(e.body))).toBe(true);
  });

  it("resets the failure counter after a successful poll", async () => {
    const r = new FakeRuntime([running(["back"])]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, failedPolls: 2 }));
    expect(out.kind).toBe("continue");
    expect(out.task.failedPolls).toBe(0);
  });

  it("stamps the heartbeat on every successful poll", async () => {
    const r = new FakeRuntime([running(["x"])]);
    const out = await advanceTask(deps(r), task({ liveMessageId: 501, lastHeartbeat: 1000 }));
    expect(out.task.lastHeartbeat).toBe(2000);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

```bash
env -u CLOUDFLARE_API_TOKEN bunx vitest run test/tasks.loop.test.ts
```

Expected: FAIL, `src/tasks/loop` does not exist.

- [ ] **Step 3: Replace the runtime interface**

Rewrite `src/agents/runtime.ts`. `ask()` is gone — the whole point of Spec A is that a turn no longer blocks:

```ts
import type { Container } from "@cloudflare/containers";
import type { TaskStatus } from "../tasks/types";

export interface StartTaskInput {
  taskId: string;
  prompt: string;
  repo: string;
  ref: string;
  ghToken: string;
}

/** The one thing a Worker test cannot execute: a real container. */
export interface AgentRuntime {
  startTask(input: StartTaskInput): Promise<void>;
  status(): Promise<TaskStatus>;
  abort(): Promise<void>;
}

export class FakeRuntime implements AgentRuntime {
  public readonly started: StartTaskInput[] = [];
  public aborted = false;

  constructor(
    private readonly statuses: TaskStatus[],
    private readonly failWith?: Error,
  ) {}

  async startTask(input: StartTaskInput): Promise<void> {
    this.started.push(input);
    if (this.failWith) throw this.failWith;
  }

  async status(): Promise<TaskStatus> {
    if (this.failWith) throw this.failWith;
    const next = this.statuses.shift();
    if (!next) throw new Error("FakeRuntime: no scripted status left");
    return next;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

/** Talks to the agent container over its internal HTTP port. */
export class ContainerRuntime implements AgentRuntime {
  constructor(
    private readonly container: Container,
    private readonly port: number = 8080,
  ) {}

  private async call(path: string, body?: unknown): Promise<Response> {
    const res = await this.container.containerFetch(
      new Request(`http://container${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      this.port,
    );
    if (!res.ok) {
      throw new Error(`container ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res;
  }

  async startTask(input: StartTaskInput): Promise<void> {
    const res = await this.call("/task", input);
    await res.text(); // drain; see webhook.ts on isolated storage
  }

  async status(): Promise<TaskStatus> {
    const res = await this.container.containerFetch(
      new Request("http://container/status"),
      this.port,
    );
    if (!res.ok) {
      throw new Error(`container /status returned ${res.status}`);
    }
    return (await res.json()) as TaskStatus;
  }

  async abort(): Promise<void> {
    const res = await this.call("/abort");
    await res.text();
  }
}
```

- [ ] **Step 4: Write the loop**

Create `src/tasks/loop.ts`:

```ts
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import { sendCard, editCard, type InlineButton } from "../telegram/api";
import { createApproval, setApprovalMessageId } from "../approvals/store";
import { GATE_LABELS, type TaskStatus } from "./types";
import type { AgentRuntime } from "../agents/runtime";

/** Everything the DO must persist between polls. Plain data, no methods. */
export interface TaskRecord {
  taskId: string;
  agentId: string;
  project: string;
  thread: string | null;
  chatId: string;
  liveMessageId: number | null;
  startedTs: number;
  lastHeartbeat: number;
  failedPolls: number;
  /** How many milestones have already been logged and rendered. */
  shownMilestones: number;
}

export interface LoopDeps {
  db: D1Database;
  runtime: AgentRuntime;
  botToken: string;
  now: number;
  maxTaskSeconds: number;
  maxFailedPolls: number;
}

export type LoopOutcome =
  | { kind: "continue"; task: TaskRecord }
  | { kind: "terminal"; task: TaskRecord };

function rid(): string {
  return crypto.randomUUID().slice(0, 8);
}

function card(task: TaskRecord, milestones: string[]): string {
  const lines = milestones.map((m) => `• ${m}`).join("\n");
  return `Working — ${task.taskId}\n${lines}`;
}

/** Log to D1 first, then notify. The event log is the record; Telegram is delivery. */
async function report(
  deps: LoopDeps, task: TaskRecord, to: string, body: string,
): Promise<void> {
  await appendEvent(
    deps.db,
    makeEvent(
      {
        from: task.agentId, to, kind: "report",
        project: task.project, thread: task.thread, ref: task.taskId, body,
      },
      deps.now, rid(),
    ),
  );
}

async function terminalMessage(deps: LoopDeps, task: TaskRecord, body: string): Promise<void> {
  await report(deps, task, "human", body);
  try {
    await sendCard(deps.botToken, task.chatId, body);
  } catch (err) {
    // Never unwind a logged event over a delivery failure. Day 1 rule.
    console.error("terminal notify failed", err);
  }
}

/**
 * One poll cycle. Pure with respect to the Durable Object: everything it needs
 * arrives in deps, everything it changes comes back in the returned TaskRecord.
 * The DO persists that record and reschedules; it holds no logic of its own.
 */
export async function advanceTask(deps: LoopDeps, task: TaskRecord): Promise<LoopOutcome> {
  // Budget first, before spending another poll on a task that is already over.
  if ((deps.now - task.startedTs) / 1000 > deps.maxTaskSeconds) {
    try {
      await deps.runtime.abort();
    } catch (err) {
      console.error("abort failed", err);
    }
    await terminalMessage(
      deps, task,
      `Task ${task.taskId} aborted: exceeded the ${deps.maxTaskSeconds}s budget.`,
    );
    return { kind: "terminal", task };
  }

  let status: TaskStatus;
  try {
    status = await deps.runtime.status();
  } catch (err) {
    const failedPolls = task.failedPolls + 1;
    if (failedPolls >= deps.maxFailedPolls) {
      await terminalMessage(
        deps, task,
        `Task ${task.taskId} lost: container unreachable after ${failedPolls} polls. ` +
        `Last error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: "terminal", task: { ...task, failedPolls } };
    }
    return { kind: "continue", task: { ...task, failedPolls } };
  }

  let next: TaskRecord = { ...task, failedPolls: 0, lastHeartbeat: deps.now };

  // New milestones: log every one, render all of them into the single card.
  const fresh = status.milestones.slice(next.shownMilestones);
  if (fresh.length > 0) {
    for (const m of fresh) {
      await report(deps, next, next.agentId, m.text);
    }
    const all = status.milestones.map((m) => m.text);
    try {
      if (next.liveMessageId === null) {
        next.liveMessageId = await sendCard(deps.botToken, next.chatId, card(next, all));
      } else {
        await editCard(deps.botToken, next.chatId, next.liveMessageId, card(next, all));
      }
    } catch (err) {
      console.error("live card update failed", err);
    }
    next.shownMilestones = status.milestones.length;
  }

  if (status.state === "running" || status.state === "idle") {
    return { kind: "continue", task: next };
  }

  if (status.state === "failed") {
    await terminalMessage(
      deps, next, `Task ${next.taskId} failed: ${status.error ?? "no error reported"}`,
    );
    return { kind: "terminal", task: next };
  }

  // done
  if (status.pendingApproval) {
    const id = `appr_${deps.now.toString(36)}_${rid()}`;
    const eventBody =
      `${GATE_LABELS[status.pendingApproval.action]} — ` +
      `${JSON.stringify(status.pendingApproval.params)}`;
    const evt = makeEvent(
      {
        from: next.agentId, to: "human", kind: "approval_request",
        project: next.project, thread: next.thread, ref: id, body: eventBody,
      },
      deps.now, rid(),
    );
    await appendEvent(deps.db, evt);
    await createApproval(
      deps.db,
      {
        id, eventId: evt.id, project: next.project,
        action: status.pendingApproval.action,
        params: status.pendingApproval.params,
        chatId: next.chatId,
      },
      deps.now,
    );
    const buttons: InlineButton[] = [
      { text: "Approve", callbackData: `${id}:yes` },
      { text: "Reject", callbackData: `${id}:no` },
    ];
    try {
      const messageId = await sendCard(
        deps.botToken, next.chatId,
        `${GATE_LABELS[status.pendingApproval.action]}?\n${eventBody}`,
        buttons,
      );
      await setApprovalMessageId(deps.db, id, messageId);
    } catch (err) {
      // The row stays pending and queryable even if the message never lands.
      console.error("approval card failed", err);
    }
    return { kind: "terminal", task: next };
  }

  const cost = status.costUsd === null ? "" : ` (cost $${status.costUsd})`;
  await terminalMessage(
    deps, next, `${status.result ?? `Task ${next.taskId} done.`}${cost}`,
  );
  return { kind: "terminal", task: next };
}
```

- [ ] **Step 5: Delete `deliver()` and repoint its tests**

`src/agents/do.ts`'s `deliver()` is superseded — it exists to run one blocking `ask()`. Remove it and rewrite `test/agents.do.test.ts` against `advanceTask`. Do not leave `deliver()` behind "just in case": it would be the only remaining caller of a runtime method that no longer exists, and `bun run check` will say so.

Record in the ledger which of the three original assertions each new test replaces, so a reviewer can see nothing was quietly dropped.

- [ ] **Step 6: Run everything**

```bash
env -u CLOUDFLARE_API_TOKEN bun run test
env -u CLOUDFLARE_API_TOKEN bun run check
```

- [ ] **Step 7: Mutation-verify the two guards that matter**

1. Change `slice(next.shownMilestones)` to `slice(0)`. Expected: "logs each new milestone to D1 exactly once" fails, nothing else. Revert.
2. Change `failedPolls >= deps.maxFailedPolls` to `>`. Expected: "declares the task dead after maxFailedPolls consecutive failures" fails, nothing else. Revert.

Report both observed failures verbatim. If either mutation leaves the suite green, the test is decorative — fix the test, not the report.

- [ ] **Step 8: Commit**

```bash
git add src/tasks/loop.ts src/agents/runtime.ts src/agents/do.ts \
        test/tasks.loop.test.ts test/agents.do.test.ts
git commit -m "feat(fleet): async task loop as a pure function

Replaces the blocking ask() runtime with startTask/status/abort and
moves the whole poll cycle into advanceTask(), which tests call
directly. Containers cannot be constructed under vitest-pool-workers,
so DO classes must stay logic-free shells."
```

---

## Task 4: Agent container — `/task`, `/status`, `/abort`, repo mount, `fleet` CLI

Container-side. Verified by building the image and driving it with `curl`, exactly as Day 1 Task 6 was.

**Files:**
- Modify: `container/server.ts`
- Create: `container/fleet-cli.ts`
- Modify: `container/Dockerfile`

**Interfaces:**
- Consumes: `TaskStatus`, `Milestone`, `PendingApproval`, `isGateAction` — copy the type shapes into the container rather than importing across the tsconfig boundary. `container/tsconfig.json` is a separate project with `@types/bun`; importing Worker sources into it re-opens the type leak Day 1's split closed. The `TaskStatus` JSON shape is the contract, not a shared module.
- Produces: HTTP contract consumed by `ContainerRuntime` (Task 3) and the `fleet` CLI contract used by the agent.

- [ ] **Step 1: Write the `fleet` CLI**

Create `container/fleet-cli.ts`:

```ts
#!/usr/bin/env bun
/**
 * The agent's only channel for progress and gate requests. Talks to this
 * container's own server over localhost. No network, no credentials.
 */
const PORT = Number(process.env.PORT ?? 8080);
const BASE = `http://127.0.0.1:${PORT}`;

const GATE_ACTIONS = ["merge_staging", "deploy_staging", "merge_main", "deploy_prod"];

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`fleet: ${path} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "milestone") {
  const text = args.join(" ").trim();
  if (!text) { console.error("fleet milestone <text>"); process.exit(1); }
  await post("/internal/milestone", { text });
} else if (cmd === "request-approval") {
  const action = args[0];
  if (!action || !GATE_ACTIONS.includes(action)) {
    console.error(`fleet request-approval <${GATE_ACTIONS.join("|")}> [--pr N] [--target ID]`);
    process.exit(1);
  }
  const params: Record<string, string> = {};
  for (const key of ["pr", "target", "repo", "ref"]) {
    const v = flag(args, key);
    if (v !== undefined) params[key] = v;
  }
  await post("/internal/approval", { action, params });
  console.log(`fleet: requested ${action}. End your turn now — the operator decides next.`);
} else {
  console.error("fleet <milestone|request-approval> ...");
  process.exit(1);
}
```

- [ ] **Step 2: Rewrite the container server**

Modify `container/server.ts`. Keep `runClaude`, the `is_error` gate and the pinned-CLI assumptions **exactly as they are** — they are the Day 1 findings and they are not up for revision. Replace only the blocking `/ask` surface.

```ts
// --- task state -------------------------------------------------------------

interface Milestone { ts: number; text: string }
interface PendingApproval { action: string; params: Record<string, string> }

interface TaskState {
  state: "idle" | "running" | "done" | "failed";
  taskId: string | null;
  milestones: Milestone[];
  pendingApproval: PendingApproval | null;
  result: string | null;
  error: string | null;
  costUsd: number | null;
}

let task: TaskState = {
  state: "idle", taskId: null, milestones: [], pendingApproval: null,
  result: null, error: null, costUsd: null,
};

let current: ReturnType<typeof Bun.spawn> | null = null;

// --- repo mount -------------------------------------------------------------

async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.slice(0, 500)}`);
}

/**
 * Clone on first use, fetch afterwards. The token arrives per task and is used
 * inline rather than written to a credential store, so it does not outlive the
 * turn on disk. `git remote set-url` on every task keeps a stale hour-old token
 * from being reused after it expires.
 */
async function mountRepo(repo: string, ref: string, ghToken: string): Promise<string> {
  const dir = `${WORKDIR}/${repo.split("/")[1]}`;
  const url = `https://x-access-token:${ghToken}@github.com/${repo}.git`;
  if (await Bun.file(`${dir}/.git/HEAD`).exists()) {
    await sh(["git", "remote", "set-url", "origin", url], dir);
    await sh(["git", "fetch", "origin", ref], dir);
    await sh(["git", "checkout", "-B", ref, `origin/${ref}`], dir);
  } else {
    await sh(["git", "clone", "--branch", ref, url, dir], WORKDIR);
  }
  await sh(["git", "config", "user.name", "fleetflare[bot]"], dir);
  await sh(["git", "config", "user.email",
            "fleetflare[bot]@users.noreply.github.com"], dir);
  return dir;
}

// --- task execution ---------------------------------------------------------

async function runTask(input: {
  taskId: string; prompt: string; repo: string; ref: string; ghToken: string;
}): Promise<void> {
  try {
    const dir = await mountRepo(input.repo, input.ref, input.ghToken);
    task.milestones.push({ ts: Date.now(), text: `mounted ${input.repo}@${input.ref}` });

    const proc = Bun.spawn([
      "claude",
      "-p", input.prompt,
      "--output-format", "json",
      "--effort", "high",
      "--model", MODEL,
      "--append-system-prompt", SYSTEM_PROMPT,
      "--continue",
    ], {
      cwd: dir,
      env: { ...process.env, GH_TOKEN: input.ghToken, GITHUB_TOKEN: input.ghToken },
      stdout: "pipe", stderr: "pipe",
    });
    current = proc;

    const [out, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    current = null;

    let raw: ClaudeResult | null = null;
    try { raw = JSON.parse(out) as ClaudeResult; } catch { raw = null; }

    // Identical gate to Day 1. Exit code alone is not sufficient: a missing
    // credential exits 0 with "Not logged in". Never read `subtype`.
    if (code !== 0 || raw == null || raw.is_error !== false) {
      const detail = raw?.result ?? out.trim() ?? stderr;
      const why = raw?.terminal_reason ?? `exit ${code}`;
      task = { ...task, state: "failed", error: `claude failed (${why}): ${detail.slice(0, 500)}` };
      return;
    }

    task = {
      ...task,
      state: "done",
      result: raw.result ?? "",
      costUsd: raw.total_cost_usd ?? null,
    };
  } catch (err) {
    current = null;
    task = { ...task, state: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
```

Extend `SYSTEM_PROMPT` — the Day 1 text was written for an agent with no repo and is now actively wrong:

```ts
const SYSTEM_PROMPT = [
  "You are a cloud agent. The repository is cloned in your working directory and",
  "`gh` is authenticated. Report progress with `fleet milestone \"<text>\"` as you go —",
  "it is the operator's only view of what you are doing.",
  "You may commit, push branches and open pull requests.",
  "You must NEVER merge a pull request and NEVER deploy. Those are the operator's,",
  "and requesting one ends your turn:",
  "  fleet request-approval merge_staging --pr <N>",
  "  fleet request-approval deploy_staging --target <id>",
  "  fleet request-approval merge_main --pr <N>",
  "  fleet request-approval deploy_prod --target <id>",
  "After calling request-approval, stop. Do not wait, do not poll, do not continue.",
  "Your memory resets when the container sleeps (20 minutes idle). If asked about a",
  "prior conversation you have no record of, say you cannot know rather than guessing.",
].join(" ");
```

Routes:

```ts
if (url.pathname === "/task" && req.method === "POST") {
  if (task.state === "running") {
    return Response.json({ error: "a task is already running" }, { status: 409 });
  }
  const input = await req.json() as {
    taskId: string; prompt: string; repo: string; ref: string; ghToken: string;
  };
  if (!input?.taskId || !input?.prompt || !input?.repo || !input?.ref || !input?.ghToken) {
    return Response.json({ error: "taskId, prompt, repo, ref, ghToken required" }, { status: 400 });
  }
  task = {
    state: "running", taskId: input.taskId, milestones: [],
    pendingApproval: null, result: null, error: null, costUsd: null,
  };
  // Deliberately not awaited: the caller gets 202 and the DO polls /status.
  void runTask(input);
  return Response.json({ accepted: true }, { status: 202 });
}

if (url.pathname === "/status") {
  return Response.json(task);
}

if (url.pathname === "/abort" && req.method === "POST") {
  current?.kill();
  current = null;
  task = { ...task, state: "failed", error: "aborted" };
  return Response.json({ ok: true });
}

if (url.pathname === "/internal/milestone" && req.method === "POST") {
  const { text } = await req.json() as { text?: string };
  if (!text) return new Response("text required", { status: 400 });
  task.milestones.push({ ts: Date.now(), text });
  return Response.json({ ok: true });
}

if (url.pathname === "/internal/approval" && req.method === "POST") {
  const body = await req.json() as { action?: string; params?: Record<string, string> };
  if (!body?.action) return new Response("action required", { status: 400 });
  task.pendingApproval = { action: body.action, params: body.params ?? {} };
  return Response.json({ ok: true });
}
```

Keep `/health` unchanged.

- [ ] **Step 3: Update the Dockerfile**

```dockerfile
COPY server.ts /app/server.ts
COPY fleet-cli.ts /app/fleet-cli.ts
RUN printf '#!/bin/sh\nexec bun run /app/fleet-cli.ts "$@"\n' > /usr/local/bin/fleet \
    && chmod +x /usr/local/bin/fleet

RUN git config --global user.name  "fleetflare[bot]" \
    && git config --global user.email "fleetflare[bot]@users.noreply.github.com" \
    && git config --global --add safe.directory '*'
```

- [ ] **Step 4: Build and drive it by hand**

This is the check that matters. `bun run test` cannot reach any of it.

```bash
cd apps/fleet/container
docker build -t fleet-agent-test .
docker run --rm -d -p 8099:8080 --name fleet-test \
  -e CLAUDE_CODE_OAUTH_TOKEN="$(echo skip)" fleet-agent-test
sleep 3
curl -s localhost:8099/health
curl -s localhost:8099/status
curl -s -X POST localhost:8099/internal/milestone \
  -H 'content-type: application/json' -d '{"text":"hand-written"}'
curl -s localhost:8099/status
curl -s -X POST localhost:8099/task -H 'content-type: application/json' -d '{}'
docker exec fleet-test fleet milestone "via the CLI"
docker exec fleet-test sh -c 'command -v git gh claude bun'
curl -s localhost:8099/status
docker rm -f fleet-test
```

Expected and each to be recorded verbatim in the ledger:
- `/health` → `{"ok":true,"tokenPresent":true}`
- initial `/status` → `state:"idle"`
- after the milestone POST → one milestone, `hand-written`
- `/task` with `{}` → HTTP 400, not a crash
- `fleet milestone` via `docker exec` → a second milestone appears
- all four binaries resolve

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/fleet
env -u CLOUDFLARE_API_TOKEN bun run check
env -u CLOUDFLARE_API_TOKEN bun run test
git add container/
git commit -m "feat(fleet): async container tasks, repo mount, fleet CLI"
```

---

## Task 5: `AgentDO` shell, scheduled polling, async webhook dispatch

Wires Tasks 3 and 4 together. This is where the library's alarm ownership matters.

**Files:**
- Modify: `src/agents/do.ts`
- Modify: `src/telegram/webhook.ts`
- Modify: `src/env.ts`
- Modify: `wrangler.jsonc`
- Test: `test/telegram.webhook.test.ts`

**Interfaces:**
- Consumes: `advanceTask`, `TaskRecord`, `LoopDeps` (Task 3); `ContainerRuntime` (Task 3); `getFlag` (Task 1).
- Produces: `AgentDO.startTask(payload)` callable over `stub.fetch("https://agent/start")`; `AgentDO.pollTask(payload)` as a scheduled callback name.

**Critical constraint, verified against `node_modules/@cloudflare/containers/dist/lib/container.d.ts`:**

```
alarm(alarmProps: {isRetry, retryCount}): Promise<void>   ← the library implements this
schedule<T>(when: Date|number, callback: string, payload?: T): Promise<Schedule<T>>
deleteSchedules(name: string): void
renewActivityTimeout(): void
```

`Container` already implements `alarm()` and dispatches to scheduled callbacks by method name. **Overriding `alarm()` breaks `sleepAfter` silently.** Schedule by name instead. `when` as a number is a delay in **seconds**.

- [ ] **Step 1: Rewrite `AgentDO`**

```ts
import { Container } from "@cloudflare/containers";
import type { Env } from "../env";
import { advanceTask, type TaskRecord } from "../tasks/loop";
import { ContainerRuntime, type AgentRuntime } from "../agents/runtime";

const POLL_SECONDS = 5;
const TASK_KEY = "task";

export class AgentDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "20m";

  envVars = {
    CLAUDE_CODE_OAUTH_TOKEN: this.env.CLAUDE_CODE_OAUTH_TOKEN,
    AGENT_WORKDIR: "/workspace",
    AGENT_MODEL: this.env.AGENT_MODEL ?? "claude-opus-5",
  };

  private runtime: AgentRuntime | undefined;

  /** Only for a real instance under runInDurableObject. advanceTask's own
   *  `runtime` parameter is the seam the unit tests use. */
  setRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  private rt(): AgentRuntime {
    return this.runtime ?? new ContainerRuntime(this);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/start" && req.method === "POST") {
      const body = (await req.json()) as { task: TaskRecord; prompt: string; repo: string; ref: string; ghToken: string };
      // One task per agent (spec §11). The container also returns 409, but
      // refusing here is what keeps a second inbound message from costing a
      // second opus turn — by the time the container answers, it has started.
      const inFlight = await this.ctx.storage.get<TaskRecord>(TASK_KEY);
      if (inFlight) {
        return Response.json({ busy: true, taskId: inFlight.taskId }, { status: 409 });
      }
      await this.ctx.storage.put(TASK_KEY, body.task);
      await this.rt().startTask({
        taskId: body.task.taskId, prompt: body.prompt,
        repo: body.repo, ref: body.ref, ghToken: body.ghToken,
      });
      await this.schedule(POLL_SECONDS, "pollTask", { taskId: body.task.taskId });
      return Response.json({ started: body.task.taskId });
    }
    if (url.pathname === "/abort" && req.method === "POST") {
      this.deleteSchedules("pollTask");
      await this.ctx.storage.delete(TASK_KEY);
      await this.rt().abort();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/heartbeat") {
      const task = await this.ctx.storage.get<TaskRecord>(TASK_KEY);
      return Response.json({ task: task ?? null });
    }
    return new Response("not found", { status: 404 });
  }

  /** Scheduled callback. Named, not an alarm() override — Container owns alarm(). */
  async pollTask(_payload: { taskId: string }): Promise<void> {
    const task = await this.ctx.storage.get<TaskRecord>(TASK_KEY);
    if (!task) return; // aborted or already terminal

    // Explicit, because a poll is activity: without this a task that runs
    // longer than sleepAfter has its container stopped underneath it.
    this.renewActivityTimeout();

    const out = await advanceTask(
      {
        db: this.env.DB,
        runtime: this.rt(),
        botToken: this.env.TELEGRAM_BOT_TOKEN,
        now: Date.now(),
        maxTaskSeconds: Number(this.env.MAX_TASK_SECONDS ?? 900),
        maxFailedPolls: 3,
      },
      task,
    );

    if (out.kind === "terminal") {
      await this.ctx.storage.delete(TASK_KEY);
      return;
    }
    await this.ctx.storage.put(TASK_KEY, out.task);
    await this.schedule(POLL_SECONDS, "pollTask", { taskId: out.task.taskId });
  }
}
```

- [ ] **Step 2: Make the webhook dispatch asynchronously**

In `src/telegram/webhook.ts`, replace the `/deliver` dispatch. Everything above it — secret gate, parse guard, operator allowlist, `update_id` dedupe, always-200 — stays untouched.

```ts
// Refuse a second concurrent run before spending a container on it.
const paused = await getFlag(env.DB, "paused");
if (paused === "1") {
  await sendMessage(env.TELEGRAM_BOT_TOKEN, agent.chatId, "Fleet is paused. /resume to continue.");
  return new Response("ok");
}

const taskId = `task_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
const record: TaskRecord = {
  taskId, agentId: agent.id, project, thread: event.thread,
  chatId: agent.chatId, liveMessageId: null,
  startedTs: Date.now(), lastHeartbeat: Date.now(),
  failedPolls: 0, shownMilestones: 0,
};

try {
  const stub = env.AGENT.get(env.AGENT.idFromName(agent.id));
  const doRes = await stub.fetch("https://agent/start", {
    method: "POST",
    body: JSON.stringify({
      task: record,
      prompt: text,
      repo: env.AGENT_REPO,
      ref: env.AGENT_BASE_REF ?? "staging",
      ghToken: await mintInstallationToken(env),
    }),
  });
  const doBody = await doRes.text(); // drain: vitest-pool-workers isolated storage
  // The operator's message is already logged as an event either way. A busy
  // agent means it waits in the log, not that it vanished.
  if (doRes.status === 409) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN, agent.chatId,
      "Already working on something. Your message is queued — /stop to interrupt.",
    );
  } else if (!doRes.ok) {
    console.error("agent start rejected", doRes.status, doBody.slice(0, 300));
  }
} catch (err) {
  console.error("agent dispatch failed", err);
}
return new Response("ok");
```

`mintInstallationToken` lands in Task 7. Until then, stub it in `src/github/app.ts` as a function that throws `"GitHub App not configured"`, and have the webhook catch it — the dispatch is already inside a try/catch that must preserve the always-200 contract. Note the stub in the ledger so Task 7 is known to be replacing it, not inventing it.

- [ ] **Step 3: Extend `Env` and `wrangler.jsonc`**

`src/env.ts` gains:

```ts
  AGENT_REPO: string;
  AGENT_BASE_REF?: string;
  MAX_TASK_SECONDS?: string;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
```

`wrangler.jsonc` gains a `vars` block. Secrets are **not** listed here:

```jsonc
  "vars": {
    "AGENT_REPO": "acme-org/websites",
    "AGENT_BASE_REF": "staging",
    "MAX_TASK_SECONDS": "900",
    "GITHUB_APP_ID": "<from operator>",
    "GITHUB_INSTALLATION_ID": "<from operator>"
  }
```

Leave the two `<from operator>` values as-is until Task 7 supplies them; the Worker is not redeployed before then.

- [ ] **Step 4: Recover the known red test**

`test/telegram.webhook.test.ts:93` fails because forcing a throw needs a live `AgentDO`, which cannot be constructed. The dedupe test already solved this by calling `handleTelegramWebhook` directly with a hand-built `AGENT` namespace. Apply the same shape here: a fake namespace whose `get()` returns a stub whose `fetch()` rejects. Assert HTTP 200 and that the human event survives.

```ts
it("still returns 200 when the agent dispatch throws", async () => {
  const fakeAgent = {
    idFromName: (n: string) => n,
    get: () => ({ fetch: () => Promise.reject(new Error("boom")) }),
  };
  const res = await handleTelegramWebhook(
    new Request("https://x/tg/websites", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify({
        update_id: 4242,
        message: { from: { id: 100000001 }, chat: { id: 100000001 }, text: "hi" },
      }),
    }),
    { ...env, AGENT: fakeAgent as any },
    "websites",
  );
  expect(res.status).toBe(200);
  const events = await readSince(env.DB, "cto", 0);
  expect(events).toHaveLength(1);
});
```

If this passes, the suite goes to full green and the README's "one accepted red" paragraph must be rewritten in Task 10 rather than left to contradict reality.

- [ ] **Step 5: Run the gates**

```bash
env -u CLOUDFLARE_API_TOKEN bun run test
env -u CLOUDFLARE_API_TOKEN bun run check
```

- [ ] **Step 6: Commit**

```bash
git add src/agents/do.ts src/telegram/webhook.ts src/env.ts wrangler.jsonc \
        test/telegram.webhook.test.ts
git commit -m "feat(fleet): scheduled poll loop, async webhook dispatch

Container owns alarm(); schedule('pollTask') by name and renew the
activity timeout explicitly, or a task outliving sleepAfter has its
container stopped underneath it."
```

---

## Task 6: `callback_query`, gate decisions, `/stop` `/pause` `/resume`

The operator's thumb. No GitHub yet — the executor is an injected interface so this task is testable and reviewable on its own.

**Files:**
- Create: `src/approvals/gates.ts`
- Modify: `src/telegram/webhook.ts`
- Modify: `src/index.ts`
- Test: `test/approvals.gates.test.ts`, `test/telegram.callback.test.ts`

**Interfaces:**
- Consumes: `getApproval`, `decideApproval`, `finishApproval`, `setApprovalMessageId` (Task 1); `editCard`, `answerCallbackQuery`, `sendCard` (Task 2); `getFlag`, `setFlag` (Task 1).
- Produces:
  - `type GateExecutor = (action: GateAction, params: Record<string,string>) => Promise<string>` — returns a human-readable result, throws on failure
  - `interface CallbackQuery { id, from?: {id}, data?, message?: {message_id, chat: {id}} }`
  - `handleCallbackQuery(env, cq: CallbackQuery, execute: GateExecutor, now: number): Promise<void>`
  - `makeExecutor(env): GateExecutor` — one `switch` on the action; Tasks 7 and 9 fill its branches
  - Commands (`/pause`, `/resume`, `/stop`) are handled inline in `handleTelegramWebhook`, not in a separate module. They are three branches on `text` sitting between the operator allowlist and the task dispatch, and extracting them would put the pause check further from the dispatch it guards.

- [ ] **Step 1: Write the failing tests**

Create `test/approvals.gates.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleCallbackQuery, type GateExecutor } from "../src/approvals/gates";
import { createApproval, getApproval } from "../src/approvals/store";
import { readSince } from "../src/events/log";

const OPERATOR = 100000001;
let calls: { url: string; body: any }[] = [];
let executed: { action: string; params: Record<string, string> }[] = [];
let realFetch: typeof globalThis.fetch;

const executor: GateExecutor = async (action, params) => {
  executed.push({ action, params });
  return "merged abc12345";
};
const boomExecutor: GateExecutor = async () => {
  throw new Error("Pull Request is not mergeable");
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM approvals").run();
  await env.DB.prepare("DELETE FROM events").run();
  calls = []; executed = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      body: JSON.parse(init.body as string),
    });
    return Response.json({ ok: true, result: { message_id: 900 } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

async function seed(id = "appr_1") {
  await createApproval(env.DB, {
    id, eventId: "evt_1", project: "websites", action: "merge_staging",
    params: { repo: "o/r", pr: "7" }, chatId: String(OPERATOR),
  }, 1000);
  await env.DB.prepare("UPDATE approvals SET message_id = 77 WHERE id = ?").bind(id).run();
}

const cq = (over: any = {}) => ({
  id: "cbq1", from: { id: OPERATOR }, data: "appr_1:yes",
  message: { message_id: 77, chat: { id: OPERATOR } },
  ...over,
});

describe("handleCallbackQuery", () => {
  it("rejects a callback from a non-operator id and executes nothing", async () => {
    await seed();
    await handleCallbackQuery(env, cq({ from: { id: 999999 } }), executor, 2000);
    expect(executed).toEqual([]);
    expect((await getApproval(env.DB, "appr_1"))?.state).toBe("pending");
    expect(calls.every((c) => c.url.includes("answerCallbackQuery"))).toBe(true);
  });

  it("is the only writer of an approval event", async () => {
    await seed();
    await handleCallbackQuery(env, cq({ from: { id: 999999 } }), executor, 2000);
    const all = await readSince(env.DB, "cto", 0);
    expect(all.filter((e) => e.kind === "approval")).toEqual([]);
    await handleCallbackQuery(env, cq(), executor, 2000);
    const after = await readSince(env.DB, "cto", 0);
    expect(after.filter((e) => e.kind === "approval")).toHaveLength(1);
  });

  it("approves, executes once, and strips the keyboard", async () => {
    await seed();
    await handleCallbackQuery(env, cq(), executor, 2000);
    expect(executed).toEqual([{ action: "merge_staging", params: { repo: "o/r", pr: "7" } }]);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.state).toBe("executed");
    expect(row?.result).toBe("merged abc12345");
    const edit = calls.find((c) => c.url.includes("editMessageText"))!;
    expect(edit.body.message_id).toBe(77);
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("ignores a second tap", async () => {
    await seed();
    await handleCallbackQuery(env, cq(), executor, 2000);
    calls = [];
    await handleCallbackQuery(env, cq({ id: "cbq2" }), executor, 3000);
    expect(executed).toHaveLength(1);
    const answer = calls.find((c) => c.url.includes("answerCallbackQuery"))!;
    expect(answer.body.text).toMatch(/already decided/i);
  });

  it("rejects without executing and tells the agent to stop", async () => {
    await seed();
    await handleCallbackQuery(env, cq({ data: "appr_1:no" }), executor, 2000);
    expect(executed).toEqual([]);
    expect((await getApproval(env.DB, "appr_1"))?.state).toBe("failed");
    const events = await readSince(env.DB, "cto", 0);
    expect(events.some((e) => e.kind === "report" && /rejected/i.test(e.body))).toBe(true);
  });

  it("records an executor failure without crashing", async () => {
    await seed();
    await handleCallbackQuery(env, cq(), boomExecutor, 2000);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.state).toBe("failed");
    expect(row?.result).toMatch(/not mergeable/);
    expect(calls.some((c) => /FAILED/.test(c.body?.text ?? ""))).toBe(true);
  });

  it("answers an unknown approval id and writes nothing", async () => {
    await handleCallbackQuery(env, cq({ data: "appr_nope:yes" }), executor, 2000);
    expect(executed).toEqual([]);
    expect(await readSince(env.DB, "cto", 0)).toEqual([]);
  });

  it("answers unreadable callback data without throwing", async () => {
    await seed();
    await handleCallbackQuery(env, cq({ data: "garbage" }), executor, 2000);
    expect(executed).toEqual([]);
    expect((await getApproval(env.DB, "appr_1"))?.state).toBe("pending");
  });
});
```

Test 2 is spec §18 negative 2 — the claim that a verified callback is the *only* path that can write an `approval`. Test 1 is negative 1.

Create `test/telegram.callback.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleTelegramWebhook } from "../src/telegram/webhook";
import { getFlag, setFlag } from "../src/state";
import { readSince } from "../src/events/log";

let started = 0;
let aborted = 0;
let realFetch: typeof globalThis.fetch;

const fakeAgent = {
  idFromName: (n: string) => n,
  get: () => ({
    fetch: async (url: string) => {
      if (String(url).endsWith("/start")) started++;
      if (String(url).endsWith("/abort")) aborted++;
      return new Response("ok");
    },
  }),
};

function post(text: string, updateId: number) {
  return new Request("https://x/tg/websites", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message: { from: { id: 100000001 }, chat: { id: 100000001 }, text },
    }),
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
  await env.DB.prepare("DELETE FROM fleet_state").run();
  started = 0; aborted = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ ok: true, result: { message_id: 1 } })) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

const withAgent = { ...env, AGENT: fakeAgent as any };

describe("commands", () => {
  it("/pause sets the flag and starts no task", async () => {
    await handleTelegramWebhook(post("/pause", 1), withAgent, "websites");
    expect(await getFlag(env.DB, "paused")).toBe("1");
    expect(started).toBe(0);
  });

  it("a message while paused does not reach the agent", async () => {
    await setFlag(env.DB, "paused", "1", 1);
    await handleTelegramWebhook(post("build the thing", 2), withAgent, "websites");
    expect(started).toBe(0);
  });

  it("/resume clears the flag and lets the next message through", async () => {
    await setFlag(env.DB, "paused", "1", 1);
    await handleTelegramWebhook(post("/resume", 3), withAgent, "websites");
    expect(await getFlag(env.DB, "paused")).toBe("0");
    await handleTelegramWebhook(post("build the thing", 4), withAgent, "websites");
    expect(started).toBe(1);
  });

  it("/stop aborts the running task", async () => {
    await handleTelegramWebhook(post("/stop", 5), withAgent, "websites");
    expect(aborted).toBe(1);
  });

  it("a command is not logged as a task for the agent", async () => {
    await handleTelegramWebhook(post("/pause", 6), withAgent, "websites");
    const events = await readSince(env.DB, "cto", 0);
    expect(events.filter((e) => e.kind === "human")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
env -u CLOUDFLARE_API_TOKEN bunx vitest run test/approvals.gates.test.ts test/telegram.callback.test.ts
```

- [ ] **Step 3: Implement `src/approvals/gates.ts`**

```ts
import type { Env } from "../env";
import { OPERATOR_ID, agentForProject } from "../agents/registry";
import { getApproval, decideApproval, finishApproval } from "./store";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import { editCard, answerCallbackQuery, sendCard } from "../telegram/api";
import { GATE_LABELS, type GateAction } from "../tasks/types";

export type GateExecutor = (
  action: GateAction, params: Record<string, string>,
) => Promise<string>;

export interface CallbackQuery {
  id: string;
  from?: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

export async function handleCallbackQuery(
  env: Env, cq: CallbackQuery, execute: GateExecutor, now: number,
): Promise<void> {
  // The entire "an agent cannot self-approve" guarantee. A callback_query can
  // only originate from Telegram for a real tap, and only the operator's id
  // passes here.
  if (String(cq.from?.id ?? "") !== OPERATOR_ID) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id, "not authorised");
    return;
  }

  const [id, verdict] = (cq.data ?? "").split(":");
  if (!id || (verdict !== "yes" && verdict !== "no")) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id, "unreadable button");
    return;
  }

  const row = await getApproval(env.DB, id);
  if (!row) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id, "unknown approval");
    return;
  }

  const state = verdict === "yes" ? "approved" : "rejected";
  const first = await decideApproval(env.DB, id, state, OPERATOR_ID, now);
  if (!first) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id, "already decided");
    return;
  }
  await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id);

  const label = GATE_LABELS[row.action];
  const stamp = new Date(now).toISOString();

  // Strip the keyboard before doing the work: a slow merge must not leave a
  // second tappable button on screen.
  if (row.messageId !== null) {
    try {
      await editCard(
        env.TELEGRAM_BOT_TOKEN, row.chatId, row.messageId,
        `${label} — ${state} ${stamp}`,
      );
    } catch (err) {
      console.error("keyboard strip failed", err);
    }
  }

  await appendEvent(
    env.DB,
    makeEvent(
      {
        from: OPERATOR_ID, to: agentForProject(row.project)?.id ?? "cto",
        kind: "approval", project: row.project, ref: row.id,
        body: `${label}: ${state}`,
      },
      now, crypto.randomUUID().slice(0, 8),
    ),
  );

  if (state === "rejected") {
    await finishApproval(env.DB, id, "failed", "rejected by operator");
    // The agent stays stopped. A rejected gate never auto-starts a new turn:
    // the operator's reason for rejecting is not yet known to anyone, and
    // guessing it burns an opus turn on the wrong work.
    await appendEvent(
      env.DB,
      makeEvent(
        {
          from: OPERATOR_ID, to: agentForProject(row.project)?.id ?? "cto",
          kind: "report", project: row.project, ref: row.id,
          body: `${label} rejected by the operator. Do not retry unless told.`,
        },
        now, crypto.randomUUID().slice(0, 8),
      ),
    );
    return;
  }

  try {
    const result = await execute(row.action, row.params);
    await finishApproval(env.DB, id, "executed", result);
    await sendCard(env.TELEGRAM_BOT_TOKEN, row.chatId, `${label} done — ${result}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishApproval(env.DB, id, "failed", msg);
    await sendCard(env.TELEGRAM_BOT_TOKEN, row.chatId, `${label} FAILED — ${msg}`);
  }
}
```

Watch the registry lookup: it is `agentForProject(row.project)`, not `agentById`. Both take a `string`, so the type checker cannot tell them apart and `agentById("websites")` silently returns `undefined` — the approval event would then always address the `"cto"` fallback and look correct in every single-agent test.

- [ ] **Step 4: Route commands and callbacks in the webhook**

In `handleTelegramWebhook`, after the secret gate and the parse guard, before the message path:

```ts
if (update.callback_query) {
  // Same always-200 contract: Telegram retries a non-2xx callback too.
  try {
    await handleCallbackQuery(env, update.callback_query, makeExecutor(env), Date.now());
  } catch (err) {
    console.error("callback failed", err);
  }
  return new Response("ok");
}
```

Add `callback_query` to the `TelegramUpdate` interface. Dedupe on `callback_query.id` using the same `appendEvent` conflict trick already used for `update_id`: derive an event id of `cb_<project>_<callback_query.id>` and skip when the insert is a no-op.

Command handling sits after the operator allowlist and before the task dispatch:

```ts
if (text === "/pause")  { await setFlag(env.DB, "paused", "1", Date.now()); ... return ok }
if (text === "/resume") { await setFlag(env.DB, "paused", "0", Date.now()); ... return ok }
if (text === "/stop")   { stub.fetch("https://agent/abort", { method: "POST" }); ... return ok }
```

Each replies with a one-line confirmation so a tap on the phone is never silent.

`makeExecutor(env)` returns a function that throws `"gate executor not wired"` for every action. Tasks 7 and 9 replace its branches.

- [ ] **Step 5: Run the gates and mutation-verify the authorisation check**

```bash
env -u CLOUDFLARE_API_TOKEN bun run test
env -u CLOUDFLARE_API_TOKEN bun run check
```

Then change `String(cq.from?.id ?? "") !== OPERATOR_ID` to `=== OPERATOR_ID`. Expected: the non-operator test fails and only it. Revert. A security test that survives its own inversion is not a security test.

- [ ] **Step 6: Commit**

```bash
git add src/approvals/gates.ts src/telegram/webhook.ts src/index.ts \
        test/approvals.gates.test.ts test/telegram.callback.test.ts
git commit -m "feat(fleet): operator approval callbacks, pause and stop"
```

---

## Task 7: GitHub App auth and the merge gates

**Blocked on operator prerequisite 1** — app id, installation id, private key. Do not start until `GITHUB_APP_PRIVATE_KEY` is set and the two ids are known.

**Files:**
- Create: `src/github/app.ts`, `src/github/api.ts`
- Modify: `src/approvals/gates.ts` (executor branches), `wrangler.jsonc` (`vars`)
- Test: `test/github.app.test.ts`, `test/github.api.test.ts`

**Interfaces:**
- Produces:
  - `mintInstallationToken(env): Promise<string>`
  - `mergePullRequest(token, repo, pr, commitTitle): Promise<string>` — returns the merge SHA, throws with GitHub's own message

- [ ] **Step 1: Write the failing tests**

Create `test/github.app.test.ts`. Generate a real keypair rather than checking in a fixture — a private key in the repo is a private key in the repo, even a throwaway one:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mintInstallationToken } from "../src/github/app";

let pem: string;
let headers: Record<string, string>[] = [];
let realFetch: typeof globalThis.fetch;
let respond: () => Response;

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
});

const env = () => ({
  GITHUB_APP_ID: "12345",
  GITHUB_INSTALLATION_ID: "99",
  GITHUB_APP_PRIVATE_KEY: pem,
}) as any;

beforeEach(() => {
  headers = [];
  respond = () => Response.json({ token: "ghs_installation_token" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_i: any, init: any) => {
    headers.push(init.headers as Record<string, string>);
    return respond();
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

function decodeJwtPayload(auth: string): any {
  const jwt = auth.replace("Bearer ", "");
  const [, payload] = jwt.split(".");
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
}

describe("mintInstallationToken", () => {
  it("returns the installation token GitHub issues", async () => {
    expect(await mintInstallationToken(env())).toBe("ghs_installation_token");
  });

  it("authenticates with a three-segment RS256 JWT", async () => {
    await mintInstallationToken(env());
    const jwt = headers[0].authorization.replace("Bearer ", "");
    expect(jwt.split(".")).toHaveLength(3);
    const header = JSON.parse(atob(jwt.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    expect(header.alg).toBe("RS256");
  });

  it("issues the JWT for the app, within GitHub's 10-minute ceiling", async () => {
    await mintInstallationToken(env());
    const p = decodeJwtPayload(headers[0].authorization);
    expect(p.iss).toBe("12345");
    expect(p.exp - p.iat).toBeLessThanOrEqual(600);
  });

  it("back-dates iat to absorb clock skew", async () => {
    await mintInstallationToken(env());
    const p = decodeJwtPayload(headers[0].authorization);
    expect(p.iat).toBeLessThan(Math.floor(Date.now() / 1000));
  });

  it("throws GitHub's own message on a non-2xx", async () => {
    respond = () => new Response('{"message":"Bad credentials"}', { status: 401 });
    await expect(mintInstallationToken(env())).rejects.toThrow(/Bad credentials/);
  });

  it("refuses to run unconfigured rather than sending an empty JWT", async () => {
    await expect(
      mintInstallationToken({ ...env(), GITHUB_APP_PRIVATE_KEY: "" }),
    ).rejects.toThrow(/not configured/);
  });
});
```

Create `test/github.api.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mergePullRequest } from "../src/github/api";

let calls: { url: string; method: string; body: any }[] = [];
let realFetch: typeof globalThis.fetch;
let respond: () => Response;

beforeEach(() => {
  calls = [];
  respond = () => Response.json({ sha: "abc1234567" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      method: init.method,
      body: JSON.parse(init.body as string),
    });
    return respond();
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

describe("mergePullRequest", () => {
  it("PUTs to the merge endpoint and returns the merge sha", async () => {
    const sha = await mergePullRequest("tok", "o/r", "7", "Merge into staging (PR #7)");
    expect(sha).toBe("abc1234567");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls/7/merge");
    expect(calls[0].body.commit_title).toBe("Merge into staging (PR #7)");
  });

  it("surfaces GitHub's reason when the PR cannot merge", async () => {
    respond = () => new Response('{"message":"Pull Request is not mergeable"}', { status: 405 });
    await expect(mergePullRequest("tok", "o/r", "7", "t"))
      .rejects.toThrow(/not mergeable/);
  });

  it("surfaces a conflict with the base branch", async () => {
    respond = () => new Response('{"message":"Base branch was modified"}', { status: 409 });
    await expect(mergePullRequest("tok", "o/r", "7", "t"))
      .rejects.toThrow(/Base branch was modified/);
  });
});
```

- [ ] **Step 2: Implement `src/github/app.ts`**

```ts
import type { Env } from "../env";

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

async function appJwt(appId: string, privateKeyPem: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(now / 1000) - 60; // clock skew allowance, per GitHub's docs
  const payload = { iat, exp: iat + 540, iss: appId };
  const unsigned =
    `${b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    `${b64urlStr(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

/**
 * A fresh 1-hour installation token per call. Deliberately not cached: it is
 * handed to a container, and the shorter it is live the smaller the §12
 * compromise. Minting costs one request.
 */
export async function mintInstallationToken(env: Env): Promise<string> {
  if (!env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_ID) {
    throw new Error("GitHub App not configured");
  }
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Date.now());
  const res = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "fleetflare",
      },
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`installation token failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text) as { token: string }).token;
}
```

- [ ] **Step 3: Implement `src/github/api.ts`**

```ts
export async function mergePullRequest(
  token: string, repo: string, pr: string, commitTitle: string,
): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/merge`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "fleetflare",
      "content-type": "application/json",
    },
    body: JSON.stringify({ commit_title: commitTitle, merge_method: "squash" }),
  });
  const text = await res.text();
  if (!res.ok) {
    // GitHub explains itself well here — "not mergeable", "review required",
    // "base was modified". Pass its words through rather than inventing ours.
    throw new Error(`merge failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text) as { sha: string }).sha;
}
```

- [ ] **Step 4: Wire the merge branches into `makeExecutor`**

```ts
case "merge_staging":
case "merge_main": {
  const pr = params.pr;
  if (!pr) throw new Error("merge gate requires --pr");
  const token = await mintInstallationToken(env);
  const sha = await mergePullRequest(
    token, params.repo ?? env.AGENT_REPO, pr, `${GATE_LABELS[action]} (PR #${pr})`,
  );
  return `merged PR #${pr} as ${sha.slice(0, 8)}`;
}
```

Replace the Task 5 stub import of `mintInstallationToken` with the real one and confirm the webhook's dispatch path now mints a live token.

- [ ] **Step 5: Set the vars, run the gates, commit**

```bash
# operator supplies these two; neither is secret
env -u CLOUDFLARE_API_TOKEN bun run test
env -u CLOUDFLARE_API_TOKEN bun run check
git add src/github/ src/approvals/gates.ts wrangler.jsonc test/github.*.test.ts
git commit -m "feat(fleet): GitHub App auth and operator-gated merges"
```

---

## Task 8: GitHub webhook — unapproved-write detection

**Blocked on operator prerequisite 2** — the App's webhook secret.

**Files:**
- Create: `src/github/webhook.ts`
- Modify: `src/index.ts`
- Test: `test/github.webhook.test.ts`

**Interfaces:**
- Produces: `verifySignature(secret, body, header): Promise<boolean>`; `handleGithubWebhook(req, env, now): Promise<Response>`

- [ ] **Step 1: Write the failing tests**

Create `test/github.webhook.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleGithubWebhook } from "../src/github/webhook";
import { createApproval, finishApproval } from "../src/approvals/store";

const SECRET = "hook-secret";
let sent: { body: any }[] = [];
let realFetch: typeof globalThis.fetch;

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

const push = (ref: string) => JSON.stringify({
  ref, after: "deadbeefcafe",
  repository: { full_name: "acme-org/websites" },
  sender: { login: "fleetflare[bot]" },
});

async function post(body: string, sig: string | null) {
  return handleGithubWebhook(
    new Request("https://x/gh", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        ...(sig ? { "x-hub-signature-256": sig } : {}),
      },
      body,
    }),
    { ...env, GITHUB_WEBHOOK_SECRET: SECRET } as any,
    5_000_000,
  );
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM approvals").run();
  await env.DB.prepare("DELETE FROM events").run();
  sent = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_i: any, init: any) => {
    sent.push({ body: JSON.parse(init.body as string) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

describe("github webhook", () => {
  it("rejects a body signed with the wrong secret", async () => {
    const body = push("refs/heads/staging");
    const bad = await sign(body).then((s) => s.replace(/.$/, "0"));
    expect((await post(body, bad)).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("rejects an unsigned body", async () => {
    const body = push("refs/heads/staging");
    expect((await post(body, null)).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("ignores a push to a feature branch", async () => {
    const body = push("refs/heads/some-feature");
    expect((await post(body, await sign(body))).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("alerts on a write to staging with no approved gate", async () => {
    const body = push("refs/heads/staging");
    await post(body, await sign(body));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toMatch(/UNAPPROVED WRITE/);
    expect(sent[0].body.text).toMatch(/fleetflare\[bot\]/);
    expect(sent[0].body.text).toMatch(/deadbeef/);
  });

  it("stays silent when an executed approval covers the window", async () => {
    await createApproval(env.DB, {
      id: "appr_1", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 4_990_000);
    await finishApproval(env.DB, "appr_1", "executed", "merged");
    const body = push("refs/heads/staging");
    expect((await post(body, await sign(body))).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("still alerts when the only approval in the window was rejected", async () => {
    await createApproval(env.DB, {
      id: "appr_2", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 4_990_000);
    await finishApproval(env.DB, "appr_2", "failed", "rejected by operator");
    const body = push("refs/heads/staging");
    await post(body, await sign(body));
    expect(sent).toHaveLength(1);
  });

  it("alerts when the matching approval is older than the window", async () => {
    await createApproval(env.DB, {
      id: "appr_3", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 1_000_000);
    await finishApproval(env.DB, "appr_3", "executed", "merged");
    const body = push("refs/heads/staging");
    await post(body, await sign(body));
    expect(sent).toHaveLength(1);
  });
});
```

Signature comparison is constant-time here, unlike Day 1's `!==` on the Telegram secret header. That deferral was argued as acceptable because the header is a fixed value behind Cloudflare's edge; a webhook body is attacker-chosen, so the same argument does not carry. Record the distinction in the ledger rather than letting a reviewer read it as inconsistency.

- [ ] **Step 2: Implement**

```ts
import type { Env } from "../env";
import { recentApprovalsFor } from "../approvals/store";
import { sendCard } from "../telegram/api";
import { agentForProject } from "../agents/registry";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";

const WATCHED = new Set(["refs/heads/staging", "refs/heads/main"]);
const WINDOW_MS = 30 * 60 * 1000;

export async function verifySignature(
  secret: string, body: string, header: string | null,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected =
    "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== header.length) return false;
  // Constant time: the body is attacker-chosen here, unlike the Telegram
  // secret header, so a length-independent compare is worth the four lines.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export async function handleGithubWebhook(
  req: Request, env: Env, now: number,
): Promise<Response> {
  const body = await req.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, req.headers.get("x-hub-signature-256")))) {
    return new Response("forbidden", { status: 401 });
  }
  if (req.headers.get("x-github-event") !== "push") return new Response("ok");

  const p = JSON.parse(body) as {
    ref?: string; after?: string;
    repository?: { full_name?: string };
    pusher?: { name?: string };
    sender?: { login?: string };
  };
  if (!p.ref || !WATCHED.has(p.ref)) return new Response("ok");

  const branch = p.ref.replace("refs/heads/", "");
  const action = branch === "staging" ? "merge_staging" : "merge_main";
  const project = "websites";
  const recent = await recentApprovalsFor(env.DB, project, action, now - WINDOW_MS);
  if (recent.some((r) => r.state === "executed")) return new Response("ok");

  const who = p.sender?.login ?? p.pusher?.name ?? "unknown";
  const alert =
    `UNAPPROVED WRITE\n${p.repository?.full_name} ${branch} ` +
    `${(p.after ?? "").slice(0, 8)}\nactor: ${who}\nNo approved gate in the last 30 minutes.`;

  await appendEvent(
    env.DB,
    makeEvent(
      { from: "worker", to: "human", kind: "escalation", project, body: alert },
      now, crypto.randomUUID().slice(0, 8),
    ),
  );
  const agent = agentForProject(project);
  if (agent) {
    try {
      await sendCard(env.TELEGRAM_BOT_TOKEN, agent.chatId, alert);
    } catch (err) {
      console.error("alert delivery failed", err);
    }
  }
  return new Response("ok");
}
```

Route it in `src/index.ts`: `if (url.pathname === "/gh" && req.method === "POST") return handleGithubWebhook(req, env, Date.now());`

Known limitation to record in the ledger rather than paper over: the 30-minute window plus `state === "executed"` is a heuristic. Two approved merges close together, or a legitimate merge from the operator's own laptop, can read as approved or unapproved respectively. It exists to make an unapproved write **loud**, not to be an authorisation decision — the spec is explicit that this layer is detection, not prevention.

- [ ] **Step 3: Gates and commit**

```bash
env -u CLOUDFLARE_API_TOKEN bun run test
env -u CLOUDFLARE_API_TOKEN bun run check
git add src/github/webhook.ts src/index.ts test/github.webhook.test.ts
git commit -m "feat(fleet): detect unapproved writes to staging and main"
```

---

## Task 9: Deploy container and the deploy gates

**Blocked on operator prerequisite 3** — the scoped Cloudflare API token.

**Files:**
- Create: `container/deploy-server.ts`, `container/Dockerfile.deploy`, `src/deploy/do.ts`
- Modify: `src/approvals/gates.ts`, `src/index.ts`, `src/env.ts`, `wrangler.jsonc`
- Test: `test/deploy.run.test.ts`

**Interfaces:**
- Produces: `runDeploy(deps, target): Promise<string>`; `class DeployDO extends Container<Env>`

The deploy container **must not** contain Claude Code and **must not** receive `CLAUDE_CODE_OAUTH_TOKEN`. That absence is the structural half of the boundary — spec §18 negative 8 asserts it.

- [ ] **Step 1: Write `container/Dockerfile.deploy`**

```dockerfile
FROM oven/bun:1.3-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# No @anthropic-ai/claude-code. Deliberate: this container must never be able
# to reason, only to execute one command the operator already approved.
RUN bun install -g wrangler@4

WORKDIR /workspace
COPY deploy-server.ts /app/deploy-server.ts
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "/app/deploy-server.ts"]
```

- [ ] **Step 2: Write `container/deploy-server.ts`**

```ts
const PORT = Number(process.env.PORT ?? 8080);
const WORKDIR = "/workspace";

interface DeployState {
  state: "idle" | "running" | "done" | "failed";
  targetId: string | null;
  result: string | null;
  error: string | null;
}

let job: DeployState = { state: "idle", targetId: null, result: null, error: null };

/** Replace every secret value with a marker before anything is returned or logged. */
function scrub(text: string, values: string[]): string {
  let out = text;
  for (const v of values) {
    if (v && v.length >= 8) out = out.split(v).join("«redacted»");
  }
  return out;
}

async function run(target: {
  id: string; repo: string; ref: string; workdir: string;
  command: string; secrets: string[]; token: string;
}): Promise<void> {
  const secretValues: string[] = [];
  const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
  for (const name of target.secrets) {
    const v = process.env[name];
    if (!v) {
      job = { ...job, state: "failed", error: `missing secret ${name}` };
      return;
    }
    childEnv[name] = v;
    secretValues.push(v);
  }

  const dir = `${WORKDIR}/${target.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const url = `https://x-access-token:${target.token}@github.com/${target.repo}.git`;
  secretValues.push(target.token);

  const steps: string[][] = [
    ["rm", "-rf", dir],
    ["git", "clone", "--depth", "1", "--branch", target.ref, url, dir],
  ];
  for (const cmd of steps) {
    const p = Bun.spawn(cmd, { cwd: WORKDIR, env: childEnv, stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) {
      job = { ...job, state: "failed", error: scrub(`${cmd[0]} failed (${code}): ${err}`, secretValues).slice(0, 2000) };
      return;
    }
  }

  const p = Bun.spawn(["sh", "-c", target.command], {
    cwd: `${dir}/${target.workdir}`,
    env: childEnv,
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const tail = scrub(`${out}\n${err}`, secretValues).slice(-2000);
  job = code === 0
    ? { ...job, state: "done", result: `exit 0\n${tail}` }
    : { ...job, state: "failed", error: `exit ${code}\n${tail}` };
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/status") return Response.json(job);
    if (url.pathname === "/run" && req.method === "POST") {
      if (job.state === "running") {
        return Response.json({ error: "a deploy is already running" }, { status: 409 });
      }
      const target = await req.json() as Parameters<typeof run>[0];
      if (!target?.id || !target?.command || !target?.repo || !target?.token) {
        return Response.json({ error: "id, repo, command, token required" }, { status: 400 });
      }
      job = { state: "running", targetId: target.id, result: null, error: null };
      void run(target);
      return Response.json({ accepted: true }, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  },
});
```

- [ ] **Step 3: Write `src/deploy/do.ts`**

```ts
import { Container } from "@cloudflare/containers";
import type { Env } from "../env";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import { sendCard } from "../telegram/api";
import { agentForProject } from "../agents/registry";

const POLL_SECONDS = 10;
const JOB_KEY = "job";

export interface DeployJob {
  targetId: string;
  project: string;
  chatId: string;
  startedTs: number;
}

export interface DeployStatus {
  state: "idle" | "running" | "done" | "failed";
  targetId: string | null;
  result: string | null;
  error: string | null;
}

export interface DeployDeps {
  db: D1Database;
  botToken: string;
  now: number;
  maxSeconds: number;
}

/**
 * One deploy poll cycle, as a plain function for the same reason advanceTask is
 * one: DeployDO cannot be constructed under the test harness.
 */
export async function advanceDeploy(
  deps: DeployDeps, job: DeployJob, status: DeployStatus,
): Promise<{ done: boolean }> {
  const overBudget = (deps.now - job.startedTs) / 1000 > deps.maxSeconds;
  if (status.state === "running" && !overBudget) return { done: false };

  const body = overBudget
    ? `Deploy ${job.targetId} aborted: exceeded the ${deps.maxSeconds}s budget.`
    : status.state === "done"
      ? `Deploy ${job.targetId} succeeded.\n${status.result ?? ""}`
      : `Deploy ${job.targetId} FAILED.\n${status.error ?? "no error reported"}`;

  await appendEvent(
    deps.db,
    makeEvent(
      {
        from: "deploy", to: "human", kind: "report",
        project: job.project, ref: job.targetId, body,
      },
      deps.now, crypto.randomUUID().slice(0, 8),
    ),
  );
  try {
    await sendCard(deps.botToken, job.chatId, body);
  } catch (err) {
    console.error("deploy notify failed", err);
  }
  return { done: true };
}

export class DeployDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";

  // No CLAUDE_CODE_OAUTH_TOKEN. This container must never be able to reason,
  // only to execute one command the operator already approved.
  envVars = {
    CLOUDFLARE_DEPLOY_TOKEN: this.env.CLOUDFLARE_DEPLOY_TOKEN,
  };

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      const target = (await req.json()) as {
        id: string; project: string; chatId: string;
        repo: string; ref: string; workdir: string;
        command: string; secrets: string[]; token: string;
      };
      const res = await this.containerFetch(
        new Request("http://container/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(target),
        }),
        8080,
      );
      const text = await res.text();
      if (!res.ok) return new Response(text, { status: res.status });
      await this.ctx.storage.put<DeployJob>(JOB_KEY, {
        targetId: target.id, project: target.project,
        chatId: target.chatId, startedTs: Date.now(),
      });
      await this.schedule(POLL_SECONDS, "pollDeploy", { targetId: target.id });
      return Response.json({ started: target.id });
    }
    return new Response("not found", { status: 404 });
  }

  /** Named schedule callback. Container owns alarm(); never override it. */
  async pollDeploy(_payload: { targetId: string }): Promise<void> {
    const job = await this.ctx.storage.get<DeployJob>(JOB_KEY);
    if (!job) return;
    this.renewActivityTimeout();

    let status: DeployStatus;
    try {
      const res = await this.containerFetch(new Request("http://container/status"), 8080);
      status = (await res.json()) as DeployStatus;
    } catch (err) {
      console.error("deploy status poll failed", err);
      await this.schedule(POLL_SECONDS, "pollDeploy", { targetId: job.targetId });
      return;
    }

    const { done } = await advanceDeploy(
      { db: this.env.DB, botToken: this.env.TELEGRAM_BOT_TOKEN, now: Date.now(), maxSeconds: 1800 },
      job, status,
    );
    if (done) {
      await this.ctx.storage.delete(JOB_KEY);
      return;
    }
    await this.schedule(POLL_SECONDS, "pollDeploy", { targetId: job.targetId });
  }
}
```

`test/deploy.run.test.ts` covers `advanceDeploy` directly: running and inside budget → `done:false` and no Telegram call; `done` → one `report` event and one message; `failed` → the error text reaches both; running but past `maxSeconds` → treated as terminal with an abort message. Reuse the `globalThis.fetch` capture from Task 3.

- [ ] **Step 4: Register the second container**

`wrangler.jsonc`:

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "AGENT",  "class_name": "AgentDO" },
      { "name": "DEPLOY", "class_name": "DeployDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AgentDO"] },
    { "tag": "v2", "new_sqlite_classes": ["DeployDO"] }
  ],
  "containers": [
    { "class_name": "AgentDO",  "image": "./container/Dockerfile",        "instance_type": "standard-1", "max_instances": 3 },
    { "class_name": "DeployDO", "image": "./container/Dockerfile.deploy", "instance_type": "standard-1", "max_instances": 2 }
  ]
```

Export `DeployDO` from `src/index.ts`. A container class declared in `wrangler.jsonc` without a matching export fails boot for the whole Worker — Day 1 Task 4 hit exactly this.

- [ ] **Step 5: Wire the deploy branches into `makeExecutor`**

```ts
case "deploy_staging":
case "deploy_prod": {
  const targetId = params.target;
  if (!targetId) throw new Error("deploy gate requires --target");
  const target = await getDeployTarget(env.DB, targetId);
  // Refuse rather than substitute. A deploy that runs the wrong command is
  // worse than one that does not run.
  if (!target) throw new Error(`unknown deploy target: ${targetId}`);
  const agent = agentForProject(target.project);
  const stub = env.DEPLOY.get(env.DEPLOY.idFromName(target.id));
  // The DO's /run payload is the target PLUS the two things only the Worker
  // can supply: where to report, and a fresh clone token. Sending the bare
  // DeployTarget leaves both undefined and the container 400s.
  const res = await stub.fetch("https://deploy/run", {
    method: "POST",
    body: JSON.stringify({
      ...target,
      chatId: agent?.chatId ?? OPERATOR_ID,
      token: await mintInstallationToken(env),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`deploy refused (${res.status}): ${text.slice(0, 300)}`);
  return `deploy ${target.id} started`;
}
```

- [ ] **Step 6: Seed one real target and prove it**

```bash
env -u CLOUDFLARE_API_TOKEN bunx wrangler d1 execute fleet --remote --command \
  "INSERT INTO deploy_targets VALUES ('websites:fleet:staging','websites','acme-org/websites','staging','apps/fleet','bun install','[]','staging')"
```

Start with a harmless `bun install` rather than a real publish. Prove the whole chain — approval, container, exit code, report — before letting it touch anything served.

- [ ] **Step 7: Verify the boundary by inspection**

```bash
docker build -t fleet-deploy-test -f container/Dockerfile.deploy container/
docker run --rm fleet-deploy-test sh -c 'command -v claude || echo ABSENT'
docker run --rm fleet-deploy-test sh -c 'env | grep -c CLAUDE_CODE_OAUTH_TOKEN || echo ABSENT'
```

Expected: `ABSENT` both times. Record verbatim — this is spec §18 negative 8 and the only evidence for the strongest claim in §10.

- [ ] **Step 8: Gates and commit**

```bash
env -u CLOUDFLARE_API_TOKEN bun run test
env -u CLOUDFLARE_API_TOKEN bun run check
git add container/deploy-server.ts container/Dockerfile.deploy src/deploy/ \
        src/approvals/gates.ts src/index.ts src/env.ts wrangler.jsonc \
        test/deploy.run.test.ts
git commit -m "feat(fleet): deploy container and operator-gated deploys"
```

---

## Task 10: Watchdog, rename to `fleetflare`, deploy, live verification

**Files:**
- Modify: `src/index.ts`, `wrangler.jsonc`, `docs/fleet/README.md`
- Test: `test/watchdog.test.ts`

- [ ] **Step 1: Write the watchdog test, then the watchdog**

Create `src/tasks/watchdog.ts`:

```ts
import type { TaskRecord } from "./loop";

export const STALE_MS = 3 * 60 * 1000;

export interface Stale {
  task: TaskRecord;
  staleMs: number;
}

/**
 * Which running tasks have stopped being polled. A stale heartbeat does not
 * mean the container died — advanceTask already handles that. It means the DO's
 * own schedule stopped firing, which nothing else can notice.
 *
 * Pure and total: the cron handler does the I/O, this decides.
 */
export function staleTasks(
  records: (TaskRecord | null)[], now: number, thresholdMs = STALE_MS,
): Stale[] {
  return records
    .filter((r): r is TaskRecord => r !== null)
    .map((task) => ({ task, staleMs: now - task.lastHeartbeat }))
    .filter((s) => s.staleMs > thresholdMs);
}
```

Create `test/watchdog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { staleTasks } from "../src/tasks/watchdog";
import type { TaskRecord } from "../src/tasks/loop";

const rec = (over: Partial<TaskRecord>): TaskRecord => ({
  taskId: "t", agentId: "cto", project: "websites", thread: null,
  chatId: "1", liveMessageId: null, startedTs: 0, lastHeartbeat: 0,
  failedPolls: 0, shownMilestones: 0, ...over,
});

describe("staleTasks", () => {
  it("ignores agents with no running task", () => {
    expect(staleTasks([null, null], 1_000_000)).toEqual([]);
  });

  it("ignores a task polled within the threshold", () => {
    expect(staleTasks([rec({ lastHeartbeat: 1_000_000 })], 1_000_000 + 179_000)).toEqual([]);
  });

  it("flags a task whose schedule stopped firing", () => {
    const out = staleTasks([rec({ lastHeartbeat: 1_000_000 })], 1_000_000 + 181_000);
    expect(out).toHaveLength(1);
    expect(out[0].staleMs).toBe(181_000);
  });

  it("is exclusive at exactly the threshold", () => {
    expect(staleTasks([rec({ lastHeartbeat: 0 })], 180_000)).toEqual([]);
    expect(staleTasks([rec({ lastHeartbeat: 0 })], 180_001)).toHaveLength(1);
  });
});
```

Then the cron handler in `src/index.ts`. It does the I/O and nothing else:

```ts
async scheduled(_c: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const records: (TaskRecord | null)[] = [];
  for (const agent of AGENTS) {
    try {
      const stub = env.AGENT.get(env.AGENT.idFromName(agent.id));
      const res = await stub.fetch("https://agent/heartbeat");
      const { task } = (await res.json()) as { task: TaskRecord | null };
      records.push(task);
    } catch (err) {
      console.error(`heartbeat read failed for ${agent.id}`, err);
      records.push(null);
    }
  }

  for (const { task, staleMs } of staleTasks(records, Date.now())) {
    const key = `rearm:${task.taskId}`;
    const attempts = Number((await getFlag(env.DB, key)) ?? "0") + 1;
    await setFlag(env.DB, key, String(attempts), Date.now());
    try {
      const stub = env.AGENT.get(env.AGENT.idFromName(task.agentId));
      await (await stub.fetch("https://agent/rearm", { method: "POST" })).text();
    } catch (err) {
      console.error("re-arm failed", err);
    }
    // Alert on the second failure, not the first: one missed schedule is a
    // hiccup, two in a row is the fleet going deaf — which is exactly what
    // cost two silent days before.
    if (attempts >= 2) {
      await sendCard(
        env.TELEGRAM_BOT_TOKEN, task.chatId,
        `WATCHDOG: task ${task.taskId} has not polled for ${Math.round(staleMs / 1000)}s. ` +
        `Re-arm attempt ${attempts} did not take.`,
      );
    }
  }
}
```

`AgentDO` gains a matching `/rearm` route: re-read the stored `TaskRecord` and, if one exists, `await this.schedule(POLL_SECONDS, "pollTask", { taskId: task.taskId })`. Clear `rearm:<taskId>` in `pollTask` on any successful poll, or the counter never resets and every long task eventually alerts.

`wrangler.jsonc`:

```jsonc
  "triggers": { "crons": ["* * * * *"] }
```

- [ ] **Step 2: Rename**

`wrangler.jsonc`: `"name": "fleetflare-fleet"` → `"name": "fleetflare"`.

**Renaming a Worker script creates a new Durable Object namespace — `AgentDO` state does not carry over.** Harmless here: `AgentDO` persists only a `TaskRecord` for an in-flight task, and D1 holds everything that matters. Do the rename when no task is running, and record in the ledger that any in-flight task at rename time is abandoned by design rather than lost to a bug.

- [ ] **Step 3: Deploy, in this order**

Order is not optional. Reverse steps 1 and 2 and Telegram points at a 404.

```bash
env -u CLOUDFLARE_API_TOKEN bun run deploy
curl -s https://fleetflare.demosite.workers.dev/health
```

Then re-register the webhook, checking the JSON `ok` field rather than the HTTP status — Telegram reports logical failure in the body:

```bash
curl -s -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://fleetflare.demosite.workers.dev/tg/websites","secret_token":"<SECRET>","allowed_updates":["message","callback_query"]}'
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

`allowed_updates` **must** include `callback_query`. Telegram's default omits it, and every approval button would be silently dead — no error, no delivery. This is the single most likely way Task 6 appears broken in production while passing every local test.

The token comes from the operator's own shell or an existing secret, never from this document and never echoed into the transcript.

- [ ] **Step 4: Verify against production**

```bash
curl -s https://fleetflare.demosite.workers.dev/health
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://fleetflare.demosite.workers.dev/tg/websites -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'x-telegram-bot-api-secret-token: wrong' \
  https://fleetflare.demosite.workers.dev/tg/websites -d '{}'
```

Expected: `{"ok":true}`, then `403`, then `403`. Same three checks Day 1 closed on.

- [ ] **Step 5: Point the GitHub App webhook at the new host, then delete the old Worker**

Only after steps 3 and 4 pass:

```bash
env -u CLOUDFLARE_API_TOKEN bunx wrangler delete --name fleetflare-fleet
```

- [ ] **Step 6: End-to-end proof of life**

From the operator's phone, not from a synthetic POST. Record each observation verbatim in the ledger:

1. Send a task that changes one file.
2. The live card appears and is **edited** — confirm by message id, not by eye.
3. A PR opens, authored by `fleetflare[bot]`.
4. The approval message arrives with two buttons.
5. Tap Approve. The PR merges. The keyboard is replaced by the decision and timestamp.
6. Tap it again. Nothing happens twice.
7. `d1 execute --remote "SELECT id, action, state, result FROM approvals"` shows one `executed` row.
8. Push directly to `staging` from the laptop. The unapproved-write alert arrives.

- [ ] **Step 7: Correct the docs**

`docs/fleet/README.md`'s Cloud fleet section currently states the URL, the deploy commit, and "one accepted red test". After Task 5 the red is gone and after this task the URL has changed. Rewrite all three. A README that contradicts production was the merge blocker on Day 1 — do not reproduce it.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts wrangler.jsonc docs/fleet/README.md test/watchdog.test.ts
git commit -m "feat(fleet): watchdog cron, rename to fleetflare, redeploy"
```

---

## Deferred, with reasons

Not gaps — decisions, recorded so a reviewer does not raise them as omissions.

- **`MAX_TURNS_PER_THREAD`** (spec §11). The resume path that could loop does not exist until an approval starts a follow-up turn, which Spec A does not implement — approvals end the turn and the operator starts the next one. Adding a counter now would guard nothing. It belongs with the resume path in Spec B.
- **`readSince` as the rehydration source** (spec §13 item 3). Same reason: rehydration happens on resume. `advanceTask` gives `readSince` a real caller through the milestone log, so it is no longer dead code, but the "context is a cache" invariant is only fully exercised once a turn resumes from the log.
- **Escalation dedupe with a populated `recent`** (spec §13 item 2). `routeDecision` is fixed and tested with a populated `recent` in Task 1, but no production caller passes one yet. Wire it when an agent first emits an escalation, which Spec A never does.
