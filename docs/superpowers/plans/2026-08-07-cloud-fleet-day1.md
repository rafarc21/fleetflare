# Cloud Fleet — Day 1 (proof of life) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Telegram message from the operator's phone reaches `claude` running inside a Cloudflare container, and a real reply returns to the same chat.

**Architecture:** A Cloudflare Worker is the control plane. It verifies Telegram webhooks, enforces routing rules, and appends every message to an append-only D1 event log. One Durable Object per agent owns that agent's identity, Telegram binding, and container handle. The container runs Claude Code authenticated by a Max subscription token, invoked per message with `--continue` so context persists without a long-running interactive process.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, Cloudflare Containers, D1, Vitest with `@cloudflare/vitest-pool-workers`, bun.

Spec: `docs/superpowers/specs/2026-08-06-cloud-fleet-design.md`.

## Global Constraints

- **bun only.** Never `npm`, `npx`, or `pnpm`. Use `bunx` for one-off binaries.
- **Zero Anthropic API credits.** Never introduce `ANTHROPIC_API_KEY` anywhere. The only Anthropic credential is `CLAUDE_CODE_OAUTH_TOKEN`, produced by `claude setup-token`.
- **Secrets never land in files, commits, or chat.** Every secret is supplied by `bunx wrangler secret put <NAME>`. If a plan step seems to require pasting a secret into a file, the step is wrong — stop.
- **Operator Telegram user id is `100000001`.** In a DM, `chat_id` equals this value.
- **Only an agent whose id is `cto` may emit an event with `to: "human"`.** Enforced in the Worker, not requested of agents.
- **Outbound Telegram messages are plain text in v1.** No `parse_mode`. Telegram cannot reject plain text over markup; markdown entities are a later concern.
- **Engineering writing is English.** Anything an end customer reads is pt-BR. No customer-facing copy exists in this plan.
- Node compat: Workers `nodejs_compat` flag on, `compatibility_date` `2026-08-01` or later.

## Operator prerequisites (blocking, human-only)

Neither can be automated. Task 7 cannot complete without both.

1. **Revoke `@websitescto_bot`'s token** (leaked to a chat transcript 2026-08-07). BotFather → `/mybots` → `@websitescto_bot` → API Token → Revoke. The replacement goes to `bunx wrangler secret put TELEGRAM_BOT_TOKEN`.
2. **Cloudflare API token with Pages scope** (spec §12). The current token lacks it, and a container has no browser for the OAuth fallback.

## File Structure

```
apps/fleet/
  package.json            deps + scripts
  wrangler.jsonc          bindings: D1, DO, container, secrets
  tsconfig.json
  vitest.config.ts        workers pool, applies wrangler.jsonc bindings
  migrations/
    0001_init.sql         events table
  src/
    env.ts                Env interface — single source of binding types
    index.ts              Worker entry, router, DO + Container exports
    events/
      schema.ts           FleetEvent type, validation, id/ts generation
      log.ts              D1 append + read-since (event log persistence)
      rules.ts            routing decisions — pure, no I/O
    telegram/
      api.ts              sendMessage, setWebhook (outbound HTTP)
      chunk.ts            4096-safe splitting — pure
      webhook.ts          inbound: secret verify, allowlist, → event
    agents/
      registry.ts         static agent table (id → role, project, chat)
      runtime.ts          AgentRuntime interface + FakeRuntime
      do.ts               AgentDO durable object
  container/
    Dockerfile            bun + git + gh + claude
    server.ts             in-container HTTP server driving claude
  test/
    events.log.test.ts
    events.rules.test.ts
    telegram.chunk.test.ts
    telegram.webhook.test.ts
    agents.do.test.ts
```

One responsibility per file. `rules.ts` and `chunk.ts` are pure so the rules that matter most are the cheapest to test. Container interaction sits behind `AgentRuntime` so every Worker test runs without a real container.

---

### Task 1: Scaffold and the event log

**Files:**
- Create: `apps/fleet/package.json`
- Create: `apps/fleet/tsconfig.json`
- Create: `apps/fleet/wrangler.jsonc`
- Create: `apps/fleet/vitest.config.ts`
- Create: `apps/fleet/migrations/0001_init.sql`
- Create: `apps/fleet/src/env.ts`
- Create: `apps/fleet/src/events/schema.ts`
- Create: `apps/fleet/src/events/log.ts`
- Create: `apps/fleet/src/index.ts` (temporary stub — wrangler `main` must resolve before any test can boot)
- Create: `apps/fleet/test/apply-migrations.ts`
- Test: `apps/fleet/test/events.log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FleetEvent` (type), `makeEvent(partial): FleetEvent`, `appendEvent(db: D1Database, e: FleetEvent): Promise<void>`, `readSince(db: D1Database, to: string, sinceTs: number): Promise<FleetEvent[]>`, `Env` (interface).

- [ ] **Step 1: Create the package scaffold**

`apps/fleet/package.json`:

```json
{
  "name": "@fleetflare/fleet",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "migrate:local": "wrangler d1 migrations apply fleet --local",
    "migrate:remote": "wrangler d1 migrations apply fleet --remote"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20260702.1",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^4.0.0"
  },
  "dependencies": {
    "@cloudflare/containers": "^0.0.20"
  }
}
```

`apps/fleet/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "container/**/*.ts"]
}
```

- [ ] **Step 2: Write wrangler config**

`apps/fleet/wrangler.jsonc`. `database_id` is filled in Step 4 — leave the placeholder string exactly as written until then.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "fleetflare-fleet",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "fleet", "database_id": "REPLACE_IN_STEP_4", "migrations_dir": "migrations" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "AGENT", "class_name": "AgentDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AgentDO"] }
  ]
}
```

- [ ] **Step 3: Write the D1 migration**

`apps/fleet/migrations/0001_init.sql`:

```sql
CREATE TABLE IF NOT EXISTS events (
  id            TEXT    PRIMARY KEY,
  ts            INTEGER NOT NULL,
  from_agent    TEXT    NOT NULL,
  to_agent      TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  ref           TEXT,
  thread        TEXT,
  body          TEXT    NOT NULL,
  requires_ack  INTEGER NOT NULL DEFAULT 0,
  acked_at      INTEGER
);

CREATE INDEX IF NOT EXISTS events_to_ts  ON events (to_agent, ts);
CREATE INDEX IF NOT EXISTS events_thread ON events (thread);
```

- [ ] **Step 4: Create the D1 database and paste its id**

```bash
cd apps/fleet
bun install
env -u CLOUDFLARE_API_TOKEN bunx wrangler d1 create fleet
```

Copy the `database_id` from the output into `wrangler.jsonc`, replacing `REPLACE_IN_STEP_4`. Then:

```bash
bun run migrate:local
```

Expected: `0001_init.sql` reported as applied.

- [ ] **Step 5: Write the env and event types**

`apps/fleet/src/env.ts`:

```ts
export interface Env {
  DB: D1Database;
  AGENT: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  CLAUDE_CODE_OAUTH_TOKEN: string;
}
```

`apps/fleet/src/events/schema.ts`:

```ts
export type EventKind =
  | "task"
  | "question"
  | "report"
  | "decision"
  | "escalation"
  | "human"
  | "approval_request"
  | "approval";

export interface FleetEvent {
  id: string;
  ts: number;
  from: string;
  to: string;
  kind: EventKind;
  project: string;
  ref: string | null;
  thread: string | null;
  body: string;
  requiresAck: boolean;
}

export interface NewEvent {
  from: string;
  to: string;
  kind: EventKind;
  project: string;
  body: string;
  ref?: string | null;
  thread?: string | null;
  requiresAck?: boolean;
}

export function makeEvent(input: NewEvent, now: number, rand: string): FleetEvent {
  return {
    id: `evt_${now.toString(36)}_${rand}`,
    ts: now,
    from: input.from,
    to: input.to,
    kind: input.kind,
    project: input.project,
    ref: input.ref ?? null,
    thread: input.thread ?? null,
    body: input.body,
    requiresAck: input.requiresAck ?? false,
  };
}
```

- [ ] **Step 6: Write the failing test**

`apps/fleet/test/events.log.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeEvent } from "../src/events/schema";
import { appendEvent, readSince } from "../src/events/log";

describe("event log", () => {
  it("appends an event and reads it back for the recipient", async () => {
    const e = makeEvent(
      { from: "cto", to: "human", kind: "human", project: "websites", body: "hello" },
      1000,
      "aaa",
    );
    await appendEvent(env.DB, e);

    const rows = await readSince(env.DB, "human", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(e.id);
    expect(rows[0].body).toBe("hello");
    expect(rows[0].requiresAck).toBe(false);
  });

  it("filters by recipient and by timestamp", async () => {
    await appendEvent(env.DB, makeEvent(
      { from: "cto", to: "manager", kind: "task", project: "websites", body: "old" }, 100, "b"));
    await appendEvent(env.DB, makeEvent(
      { from: "cto", to: "manager", kind: "task", project: "websites", body: "new" }, 300, "c"));
    await appendEvent(env.DB, makeEvent(
      { from: "cto", to: "qa", kind: "task", project: "websites", body: "other" }, 300, "d"));

    const rows = await readSince(env.DB, "manager", 200);
    expect(rows.map((r) => r.body)).toEqual(["new"]);
  });
});
```

`apps/fleet/vitest.config.ts`. No version of `@cloudflare/vitest-pool-workers` auto-applies D1 migrations from `migrations_dir` — the migrations are read on the Node side here and applied on the worker side in a setup file, or `env.DB` boots with no tables:

```ts
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = await readD1Migrations(migrationsPath);

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          d1Databases: ["DB"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
  },
});
```

`apps/fleet/test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`apps/fleet/src/index.ts` — a temporary stub. `wrangler.jsonc` points `main` here and declares the `AgentDO` class, and `vitest-pool-workers` cannot boot the runtime for *any* test until both resolve. Task 4 rewrites the entry; Task 5 replaces `AgentDO` with the real class and re-exports it:

```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export class AgentDO extends DurableObject<Env> {}

export default {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd apps/fleet && bun run test`
Expected: FAIL — `Cannot find module '../src/events/log'`.

- [ ] **Step 8: Write the minimal implementation**

`apps/fleet/src/events/log.ts`:

```ts
import type { EventKind, FleetEvent } from "./schema";

interface Row {
  id: string;
  ts: number;
  from_agent: string;
  to_agent: string;
  kind: string;
  project: string;
  ref: string | null;
  thread: string | null;
  body: string;
  requires_ack: number;
}

function toEvent(r: Row): FleetEvent {
  return {
    id: r.id,
    ts: r.ts,
    from: r.from_agent,
    to: r.to_agent,
    kind: r.kind as EventKind,
    project: r.project,
    ref: r.ref,
    thread: r.thread,
    body: r.body,
    requiresAck: r.requires_ack === 1,
  };
}

export async function appendEvent(db: D1Database, e: FleetEvent): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (id, ts, from_agent, to_agent, kind, project, ref, thread, body, requires_ack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(e.id, e.ts, e.from, e.to, e.kind, e.project, e.ref, e.thread, e.body, e.requiresAck ? 1 : 0)
    .run();
}

export async function readSince(db: D1Database, to: string, sinceTs: number): Promise<FleetEvent[]> {
  const res = await db
    .prepare(`SELECT * FROM events WHERE to_agent = ? AND ts > ? ORDER BY ts ASC`)
    .bind(to, sinceTs)
    .all<Row>();
  return (res.results ?? []).map(toEvent);
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd apps/fleet && bun run test`
Expected: PASS, 2 tests.

- [ ] **Step 10: Commit**

```bash
git add apps/fleet
git commit -m "feat(fleet): scaffold worker, D1 event log with append and read-since"
```

---

### Task 2: Routing rules

The three fleet rules that matter are pure functions, so they are the cheapest thing in the system to prove and the most expensive to get wrong.

**Files:**
- Create: `apps/fleet/src/events/rules.ts`
- Test: `apps/fleet/test/events.rules.test.ts`

**Interfaces:**
- Consumes: `FleetEvent` from `src/events/schema.ts`.
- Produces: `routeDecision(e: FleetEvent, recent: FleetEvent[]): Decision` where `Decision = { allow: true; toHuman: boolean } | { allow: false; reason: string }`, and `dedupeKey(e: FleetEvent): string`.

- [ ] **Step 1: Write the failing test**

`apps/fleet/test/events.rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeEvent } from "../src/events/schema";
import { dedupeKey, routeDecision } from "../src/events/rules";

const ev = (over: Partial<Parameters<typeof makeEvent>[0]> = {}, ts = 1) =>
  makeEvent(
    { from: "cto", to: "human", kind: "human", project: "websites", body: "hi", ...over },
    ts,
    String(ts),
  );

describe("routeDecision", () => {
  it("lets the CTO reach the human", () => {
    const d = routeDecision(ev(), []);
    expect(d).toEqual({ allow: true, toHuman: true });
  });

  it("blocks a non-CTO agent from reaching the human", () => {
    const d = routeDecision(ev({ from: "dev-42" }), []);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/only the cto/i);
  });

  it("routes a non-CTO escalation to the CTO instead of dropping it", () => {
    const d = routeDecision(ev({ from: "dev-42", kind: "escalation", to: "human" }), []);
    expect(d).toEqual({ allow: true, toHuman: false });
  });

  it("allows normal agent-to-agent traffic", () => {
    const d = routeDecision(ev({ from: "manager", to: "dev-42", kind: "task" }), []);
    expect(d).toEqual({ allow: true, toHuman: false });
  });

  it("suppresses a duplicate escalation on the same thread", () => {
    const first = ev({ from: "dev-1", kind: "escalation", thread: "IS#54", body: "which font?" }, 1);
    const second = ev({ from: "dev-2", kind: "escalation", thread: "IS#54", body: "Which font?  " }, 2);
    const d = routeDecision(second, [first]);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/duplicate/i);
  });

  it("does not treat a different question on the same thread as a duplicate", () => {
    const first = ev({ from: "dev-1", kind: "escalation", thread: "IS#54", body: "which font?" }, 1);
    const second = ev({ from: "dev-2", kind: "escalation", thread: "IS#54", body: "which colour?" }, 2);
    expect(routeDecision(second, [first]).allow).toBe(true);
  });

  it("does not count a non-escalation event as a prior duplicate", () => {
    // Same key, different kind. Without the kind filter in the dup predicate,
    // an ordinary task message would silently suppress a real escalation.
    const task = ev({ from: "manager", to: "dev-1", kind: "task", thread: "IS#54", body: "which font?" }, 1);
    const esc = ev({ from: "dev-1", kind: "escalation", thread: "IS#54", body: "which font?" }, 2);
    expect(routeDecision(esc, [task]).allow).toBe(true);
  });
});

describe("dedupeKey", () => {
  it("ignores case and surrounding whitespace", () => {
    expect(dedupeKey(ev({ kind: "escalation", thread: "T", body: " Hello " })))
      .toBe(dedupeKey(ev({ kind: "escalation", thread: "T", body: "hello" })));
  });

  it("separates different threads", () => {
    expect(dedupeKey(ev({ kind: "escalation", thread: "A", body: "x" })))
      .not.toBe(dedupeKey(ev({ kind: "escalation", thread: "B", body: "x" })));
  });

  it("separates the same question asked on different projects", () => {
    expect(dedupeKey(ev({ kind: "escalation", project: "websites", thread: "T", body: "which font?" })))
      .not.toBe(dedupeKey(ev({ kind: "escalation", project: "beta", thread: "T", body: "which font?" })));
  });

  it("does not let a separator inside the thread forge a collision", () => {
    // Concatenation with a bare "::" would make these two identical.
    expect(dedupeKey(ev({ kind: "escalation", thread: "T1", body: "x::y broke" })))
      .not.toBe(dedupeKey(ev({ kind: "escalation", thread: "T1::x", body: "y broke" })));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fleet && bun run test events.rules`
Expected: FAIL — `Cannot find module '../src/events/rules'`.

- [ ] **Step 3: Write the minimal implementation**

`apps/fleet/src/events/rules.ts`:

```ts
import type { FleetEvent } from "./schema";

export const CTO_ID = "cto";

export type Decision =
  | { allow: true; toHuman: boolean }
  | { allow: false; reason: string };

/**
 * Identity for escalation collapsing: case- and whitespace-insensitive on the
 * body, scoped to project and thread.
 *
 * JSON-encoded rather than concatenated. A bare separator lets
 * (thread "T1", body "x::y broke") and (thread "T1::x", body "y broke")
 * produce the same key, which would suppress a real question and report the
 * misleading reason "duplicate escalation on this thread".
 *
 * `project` is part of the identity because the fleet is multi-tenant: the
 * same generic question on two projects is two questions.
 */
export function dedupeKey(e: FleetEvent): string {
  const body = e.body.trim().toLowerCase().replace(/\s+/g, " ");
  return JSON.stringify([e.project, e.thread, body]);
}

export function routeDecision(e: FleetEvent, recent: FleetEvent[]): Decision {
  if (e.kind === "escalation") {
    const key = dedupeKey(e);
    const dup = recent.some((r) => r.kind === "escalation" && dedupeKey(r) === key);
    if (dup) return { allow: false, reason: "duplicate escalation on this thread" };
    // Escalations from below never reach the human directly; the CTO decides.
    return { allow: true, toHuman: false };
  }

  if (e.to === "human") {
    if (e.from !== CTO_ID) {
      return { allow: false, reason: "only the CTO may address the human" };
    }
    return { allow: true, toHuman: true };
  }

  return { allow: true, toHuman: false };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fleet && bun run test events.rules`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/events/rules.ts apps/fleet/test/events.rules.test.ts
git commit -m "feat(fleet): routing rules — cto-only-to-human, escalation dedupe"
```

---

### Task 3: Telegram outbound

**Files:**
- Create: `apps/fleet/src/telegram/chunk.ts`
- Create: `apps/fleet/src/telegram/api.ts`
- Test: `apps/fleet/test/telegram.chunk.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `chunk(text: string, limit?: number): string[]`, `sendMessage(token: string, chatId: string, text: string): Promise<void>`, `setWebhook(token: string, url: string, secret: string): Promise<unknown>`.

- [ ] **Step 1: Write the failing test**

`apps/fleet/test/telegram.chunk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunk } from "../src/telegram/chunk";

describe("chunk", () => {
  it("returns a short message unchanged, as one piece", () => {
    expect(chunk("hello")).toEqual(["hello"]);
  });

  it("never emits a piece longer than the limit", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    for (const piece of chunk(text, 100)) {
      expect(piece.length).toBeLessThanOrEqual(100);
    }
  });

  it("prefers to split on a newline", () => {
    const text = "aaaa\nbbbb\ncccc";
    expect(chunk(text, 10)).toEqual(["aaaa\nbbbb", "cccc"]);
  });

  it("hard-splits a single line longer than the limit", () => {
    const pieces = chunk("x".repeat(25), 10);
    expect(pieces).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("drops nothing — pieces rejoin to the original", () => {
    const text = "alpha\nbeta\ngamma\ndelta";
    expect(chunk(text, 12).join("\n")).toBe(text);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk("")).toEqual([]);
  });

  // The four below pin the blank-line class of bug. With string-emptiness as
  // the buffer sentinel, every one of these silently loses content while the
  // six tests above stay green.

  it("preserves a blank line between two lines", () => {
    expect(chunk("a\n\nb").join("\n")).toBe("a\n\nb");
  });

  it("preserves a leading newline", () => {
    expect(chunk("\nabc").join("\n")).toBe("\nabc");
  });

  it("never returns zero pieces for input that has characters", () => {
    // chunk("\n\n\n") returning [] makes sendMessage deliver nothing, silently.
    expect(chunk("\n\n\n").length).toBeGreaterThan(0);
    expect(chunk("\n\n\n").join("\n")).toBe("\n\n\n");
  });

  it("keeps a blank line that falls on a chunk boundary", () => {
    const text = "aaaaaaaaaa\n\nbbbbbbbbbb";
    expect(chunk(text, 10).join("\n")).toBe(text);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fleet && bun run test telegram.chunk`
Expected: FAIL — `Cannot find module '../src/telegram/chunk'`.

- [ ] **Step 3: Write the minimal implementation**

`apps/fleet/src/telegram/chunk.ts`:

```ts
export const TELEGRAM_LIMIT = 4096;

/**
 * Split text into Telegram-sized pieces, preferring newline boundaries.
 *
 * Contract: no content is dropped and pieces are emitted in source order.
 * Rejoining with "\n" reproduces the input exactly, EXCEPT where a single
 * line exceeded `limit` and had to be hard-split — those fragments rejoin
 * with a separator that was not in the source. Nothing is lost either way.
 *
 * `current` is `null` when nothing is buffered and `""` when a single blank
 * line is buffered. These are different states, and conflating them is a
 * content-loss bug, not a style choice: with string-emptiness as the
 * sentinel, blank lines vanish and `chunk("\n\n\n")` returns `[]`.
 */
export function chunk(text: string, limit: number = TELEGRAM_LIMIT): string[] {
  if (text.length === 0) return [];

  const out: string[] = [];
  let current: string | null = null;

  const push = () => {
    if (current !== null) {
      out.push(current);
      current = null;
    }
  };

  for (const line of text.split("\n")) {
    // A single line that cannot fit must be hard-split.
    if (line.length > limit) {
      push();
      for (let i = 0; i < line.length; i += limit) {
        out.push(line.slice(i, i + limit));
      }
      continue;
    }
    const candidate = current === null ? line : `${current}\n${line}`;
    if (candidate.length > limit) {
      push();
      current = line;
    } else {
      current = candidate;
    }
  }
  push();
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fleet && bun run test telegram.chunk`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the Telegram API client**

`apps/fleet/src/telegram/api.ts`. Plain text only — no `parse_mode`, so Telegram cannot reject a message over markup.

```ts
import { chunk } from "./chunk";

const API = "https://api.telegram.org";

export async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  let sent = 0;
  for (const piece of chunk(text)) {
    // Telegram rejects a whitespace-only body. Skip the piece rather than
    // failing the whole send over a blank line.
    if (piece.trim() === "") continue;

    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: piece }),
    });
    if (!res.ok) {
      throw new Error(
        `telegram sendMessage failed after ${sent} piece(s): ${res.status} ${await res.text()}`,
      );
    }
    sent++;
  }

  // Delivering nothing must never be silent. This fires on empty or
  // whitespace-only input — a caller bug the operator needs to see, not a
  // no-op that looks like success.
  if (sent === 0) {
    throw new Error("telegram sendMessage delivered nothing: body was empty or whitespace-only");
  }
}

export async function setWebhook(token: string, url: string, secret: string): Promise<unknown> {
  const res = await fetch(`${API}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"] }),
  });
  // Telegram signals logical failure in the JSON body, not the HTTP status.
  // Returning it unchecked would let Task 7 register nothing and report success.
  const body = (await res.json()) as { ok?: boolean; description?: string };
  if (!res.ok || body.ok !== true) {
    throw new Error(
      `telegram setWebhook failed: ${res.status} ${body.description ?? JSON.stringify(body)}`,
    );
  }
  return body;
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/telegram apps/fleet/test/telegram.chunk.test.ts
git commit -m "feat(fleet): telegram outbound — 4096 chunking, plain-text send"
```

---

### Task 4: Telegram inbound webhook

**Files:**
- Create: `apps/fleet/src/agents/registry.ts`
- Create: `apps/fleet/src/telegram/webhook.ts`
- Create: `apps/fleet/src/index.ts`
- Test: `apps/fleet/test/telegram.webhook.test.ts`

**Interfaces:**
- Consumes: `Env`, `makeEvent`, `appendEvent`. **Not** `routeDecision` — inbound operator messages are gated by the allowlist, not by the routing rules. `routeDecision` governs outbound traffic and is first used in Task 5.
- Produces: `OPERATOR_ID` (string), `AgentRecord = { id: string; role: string; project: string; chatId: string }`, `agentById(id: string): AgentRecord | undefined`, `agentForProject(project: string): AgentRecord | undefined`, `handleTelegramWebhook(req: Request, env: Env, project: string): Promise<Response>`, and the default Worker export.

- [ ] **Step 1: Write the failing test**

`apps/fleet/test/telegram.webhook.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readSince } from "../src/events/log";

const SECRET = "test-secret";

function update(text: string, fromId = 100000001, chatId = 100000001) {
  return new Request("https://fleet.test/tg/websites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 1, from: { id: fromId }, chat: { id: chatId }, text },
    }),
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
});

describe("telegram webhook", () => {
  it("rejects a request with a wrong secret token", async () => {
    const req = update("hello");
    req.headers.set("x-telegram-bot-api-secret-token", "wrong");
    const res = await SELF.fetch(req);
    expect(res.status).toBe(403);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  it("rejects a request with no secret token at all", async () => {
    const res = await SELF.fetch(new Request("https://fleet.test/tg/websites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 2, message: { message_id: 2, from: { id: 100000001 }, chat: { id: 100000001 }, text: "x" } }),
    }));
    expect(res.status).toBe(403);
  });

  it("drops a message from a user who is not the operator", async () => {
    const res = await SELF.fetch(update("hello", 999999));
    expect(res.status).toBe(200);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  it("accepts the operator and appends a human event addressed to the cto", async () => {
    const res = await SELF.fetch(update("what is the status?"));
    expect(res.status).toBe(200);
    const rows = await readSince(env.DB, "cto", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe("human");
    expect(rows[0].kind).toBe("human");
    expect(rows[0].project).toBe("websites");
    expect(rows[0].body).toBe("what is the status?");
  });

  it("returns 200 and writes nothing for a body that is not JSON", async () => {
    // A throw here would surface as a 500, which Telegram retries — the retry
    // storm the always-200 contract exists to prevent.
    const res = await SELF.fetch(new Request("https://fleet.test/tg/websites", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: "not json at all",
    }));
    expect(res.status).toBe(200);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  it("returns 200 and writes nothing for a JSON body of literal null", async () => {
    // Parses fine, then `update.message` throws: optional chaining guards the
    // children of `message`, not `update` itself.
    const res = await SELF.fetch(new Request("https://fleet.test/tg/websites", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: "null",
    }));
    expect(res.status).toBe(200);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  it("ignores an update with no text without erroring", async () => {
    const res = await SELF.fetch(new Request("https://fleet.test/tg/websites", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ update_id: 3, message: { message_id: 3, from: { id: 100000001 }, chat: { id: 100000001 } } }),
    }));
    expect(res.status).toBe(200);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });
});
```

`env.TELEGRAM_WEBHOOK_SECRET` must be populated under test. In `vitest.config.ts`, **add** the three fake secrets to the existing `miniflare.bindings` object — do not replace the block. `TEST_MIGRATIONS` and the `setupFiles` entry from Task 1 must survive; without them `env.DB` boots with no tables and every test in this file fails on a missing `events` table.

The `bindings` object becomes:

```ts
          bindings: {
            TEST_MIGRATIONS: migrations,
            TELEGRAM_WEBHOOK_SECRET: "test-secret",
            TELEGRAM_BOT_TOKEN: "test-token",
            CLAUDE_CODE_OAUTH_TOKEN: "test-oauth",
          },
```

Everything else in `vitest.config.ts` is unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fleet && bun run test telegram.webhook`
Expected: FAIL — `Cannot find module '../src/index'` or a 404 from the Worker.

- [ ] **Step 3: Write the agent registry**

`apps/fleet/src/agents/registry.ts`:

```ts
export const OPERATOR_ID = "100000001";

export interface AgentRecord {
  id: string;
  role: string;
  project: string;
  /** Telegram chat this agent speaks in. In a DM this equals the operator's user id. */
  chatId: string;
}

/** Day 1 fleet: one agent. Grows to a D1 table when the second project onboards. */
export const AGENTS: AgentRecord[] = [
  { id: "cto", role: "cto", project: "websites", chatId: OPERATOR_ID },
];

export function agentById(id: string): AgentRecord | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function agentForProject(project: string): AgentRecord | undefined {
  return AGENTS.find((a) => a.project === project && a.role === "cto");
}
```

- [ ] **Step 4: Write the webhook handler**

`apps/fleet/src/telegram/webhook.ts`:

```ts
import type { Env } from "../env";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import { agentForProject, OPERATOR_ID } from "../agents/registry";

interface TelegramUpdate {
  message?: {
    from?: { id: number };
    chat?: { id: number };
    text?: string;
  };
}

export async function handleTelegramWebhook(
  req: Request,
  env: Env,
  project: string,
): Promise<Response> {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  // Everything past the secret gate returns 200, and that has to include
  // failures to parse. An uncaught throw here surfaces as a runtime 500,
  // which Telegram retries — the exact retry storm this contract prevents.
  let update: TelegramUpdate;
  try {
    const parsed: unknown = await req.json();
    // `?.` below guards the children of `message`, not `update` itself, so a
    // body of the literal `null` would throw on property access.
    if (parsed === null || typeof parsed !== "object") return new Response("ok");
    update = parsed as TelegramUpdate;
  } catch {
    return new Response("ok");
  }

  const text = update.message?.text;
  const fromId = update.message?.from?.id;

  // Always 200 past this point: Telegram retries non-2xx, and a retry storm on
  // a message we intend to ignore is worse than the ignored message.
  if (!text || fromId === undefined) return new Response("ok");
  if (String(fromId) !== OPERATOR_ID) return new Response("ok");

  const agent = agentForProject(project);
  if (!agent) return new Response("ok");

  const event = makeEvent(
    { from: "human", to: agent.id, kind: "human", project, body: text },
    Date.now(),
    crypto.randomUUID().slice(0, 8),
  );
  await appendEvent(env.DB, event);

  // Dispatch to the agent's Durable Object is added in Task 5, once AgentDO
  // exists. Appending first means no message is lost in the meantime.
  return new Response("ok");
}
```

- [ ] **Step 5: Write the Worker entry**

`apps/fleet/src/index.ts`. This replaces the Task 1 stub's `fetch`, but **keeps exporting an `AgentDO` class**: `wrangler.jsonc` declares `class_name: "AgentDO"`, and if the entry stops exporting it the runtime cannot boot and every test in the package fails, not just this one. Task 5 moves the real implementation into `src/agents/do.ts` and re-exports it from here.

```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram/webhook";

// Still a stub. Task 5 replaces this with a re-export of the real AgentDO.
// It must stay exported: wrangler.jsonc binds AGENT to this class name.
export class AgentDO extends DurableObject<Env> {}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const tg = url.pathname.match(/^\/tg\/([a-z0-9-]+)$/);
    if (tg && req.method === "POST") {
      return handleTelegramWebhook(req, env, tg[1]);
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/fleet && bun run test telegram.webhook`
Expected: PASS, 5 tests. Nothing here references `AgentDO`, so the suite is green before that class exists.

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/src apps/fleet/test/telegram.webhook.test.ts apps/fleet/vitest.config.ts
git commit -m "feat(fleet): telegram inbound — secret verify, allowlist, event append"
```

---

### Task 5: AgentDO and the runtime seam

The container is the one thing tests cannot run. Putting it behind an interface keeps every Worker test hermetic.

**Files:**
- Create: `apps/fleet/src/agents/runtime.ts`
- Create: `apps/fleet/src/agents/do.ts`
- Test: `apps/fleet/test/agents.do.test.ts`

**Interfaces:**
- Consumes: `Env`, `FleetEvent`, `appendEvent`, `makeEvent`, `routeDecision`, `sendMessage`, `agentById`.
- Produces: `AgentRuntime` (interface with `ask(prompt: string): Promise<string>`), `FakeRuntime` (class), `AgentDO` (Durable Object class), and the DO route `POST /deliver` accepting a `FleetEvent` JSON body.

- [ ] **Step 1: Write the failing test**

`apps/fleet/test/agents.do.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { makeEvent } from "../src/events/schema";
import { readSince } from "../src/events/log";
import { FakeRuntime } from "../src/agents/runtime";
import type { AgentDO } from "../src/agents/do";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
});

function humanEvent(body: string) {
  return makeEvent(
    { from: "human", to: "cto", kind: "human", project: "websites", body },
    Date.now(),
    "t1",
  );
}

describe("AgentDO", () => {
  it("asks the runtime and logs the reply as a cto->human event", async () => {
    const id = env.AGENT.idFromName("cto");
    const stub = env.AGENT.get(id);

    await runInDurableObject(stub, async (instance: AgentDO) => {
      instance.setRuntime(new FakeRuntime(["the site is green"]));
    });

    await stub.fetch("https://agent/deliver", {
      method: "POST",
      body: JSON.stringify(humanEvent("status?")),
    });

    const replies = await readSince(env.DB, "human", 0);
    expect(replies).toHaveLength(1);
    expect(replies[0].from).toBe("cto");
    expect(replies[0].kind).toBe("human");
    expect(replies[0].body).toBe("the site is green");
  });

  it("passes the operator's text through to the runtime unchanged", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("cto"));
    const fake = new FakeRuntime(["ok"]);

    await runInDurableObject(stub, async (instance: AgentDO) => {
      instance.setRuntime(fake);
    });

    await stub.fetch("https://agent/deliver", {
      method: "POST",
      body: JSON.stringify(humanEvent("deploy IS#54 please")),
    });

    expect(fake.prompts).toEqual(["deploy IS#54 please"]);
  });

  it("records a runtime failure as a report rather than losing the turn", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("cto"));

    await runInDurableObject(stub, async (instance: AgentDO) => {
      instance.setRuntime(new FakeRuntime([], new Error("container unreachable")));
    });

    const res = await stub.fetch("https://agent/deliver", {
      method: "POST",
      body: JSON.stringify(humanEvent("status?")),
    });
    expect(res.status).toBe(200);

    const replies = await readSince(env.DB, "human", 0);
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toMatch(/container unreachable/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fleet && bun run test agents.do`
Expected: FAIL — `Cannot find module '../src/agents/runtime'`.

- [ ] **Step 3: Write the runtime seam**

`apps/fleet/src/agents/runtime.ts`:

```ts
/** The one thing a Worker test cannot execute: a real container. */
export interface AgentRuntime {
  ask(prompt: string): Promise<string>;
}

export class FakeRuntime implements AgentRuntime {
  public readonly prompts: string[] = [];

  constructor(
    private readonly replies: string[],
    private readonly failWith?: Error,
  ) {}

  async ask(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.failWith) throw this.failWith;
    return this.replies.shift() ?? "";
  }
}
```

- [ ] **Step 4: Write the Durable Object**

`apps/fleet/src/agents/do.ts`. The container is wired in Task 7; until then `runtime` must be injected by a test.

```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { appendEvent } from "../events/log";
import { makeEvent, type FleetEvent } from "../events/schema";
import { routeDecision } from "../events/rules";
import { sendMessage } from "../telegram/api";
import { agentById } from "./registry";
import type { AgentRuntime } from "./runtime";

export class AgentDO extends DurableObject<Env> {
  private runtime: AgentRuntime | undefined;

  /** Test seam. Task 7 replaces the default with a container-backed runtime. */
  setRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/deliver" || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const incoming = (await req.json()) as FleetEvent;
    const agent = agentById(incoming.to);
    if (!agent) return new Response("unknown agent", { status: 404 });

    let replyText: string;
    try {
      if (!this.runtime) throw new Error("no runtime configured for this agent");
      replyText = await this.runtime.ask(incoming.body);
    } catch (err) {
      replyText = `agent runtime error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const reply = makeEvent(
      {
        from: agent.id,
        to: "human",
        kind: "human",
        project: incoming.project,
        thread: incoming.thread,
        body: replyText,
      },
      Date.now(),
      crypto.randomUUID().slice(0, 8),
    );

    const decision = routeDecision(reply, []);
    if (!decision.allow) {
      return Response.json({ dropped: decision.reason });
    }

    // Log before notifying. The event log is the record; Telegram is delivery.
    await appendEvent(this.env.DB, reply);

    if (decision.toHuman) {
      try {
        await sendMessage(this.env.TELEGRAM_BOT_TOKEN, agent.chatId, replyText);
      } catch (err) {
        // A failed notification must never unwind a logged event. Under test the
        // token is fake and this always throws; in production the watchdog
        // surfaces repeated failures.
        console.error("telegram delivery failed", err);
      }
    }
    return new Response("ok");
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/fleet && bun run test agents.do`
Expected: PASS, 3 tests. The fake `test-token` makes every `sendMessage` fail; the catch is what keeps the logged event intact, which is exactly the production behaviour being asserted.

- [ ] **Step 6: Wire the webhook to the Durable Object**

Now that `AgentDO` exists, restore dispatch. In `apps/fleet/src/telegram/webhook.ts`, replace the comment added in Task 4 Step 4 with:

```ts
  // The event is already logged. Dispatch is best-effort delivery on top of
  // that, and it must obey the same always-200 contract as everything else
  // past the secret gate: an uncaught throw inside AgentDO surfaces here as a
  // REJECTED promise (not a 500 Response), which becomes a runtime 500, which
  // Telegram retries. Inbound updates are not deduped by update_id, so a retry
  // would re-append the operator's message as a second event.
  try {
    const stub = env.AGENT.get(env.AGENT.idFromName(agent.id));
    const doRes = await stub.fetch("https://agent/deliver", {
      method: "POST",
      body: JSON.stringify(event),
    });
    // Drain the body even though it is never forwarded. Required by
    // vitest-pool-workers' storage isolation:
    // https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage
    await doRes.text();
  } catch (err) {
    console.error("agent dispatch failed", err);
  }

  return new Response("ok");
```

And in `apps/fleet/src/index.ts`, add the export above `export default`:

```ts
export { AgentDO } from "./agents/do";
```

- [ ] **Step 7: Run the whole suite**

Run: `cd apps/fleet && bun run test`
Expected: PASS, all files. The webhook test now exercises the real DO path, so a break in `AgentDO` fails there too.

- [ ] **Step 8: Commit**

```bash
git add apps/fleet/src apps/fleet/test/agents.do.test.ts
git commit -m "feat(fleet): AgentDO with injectable runtime seam, webhook dispatch"
```

---

### Task 6: Container image and in-container agent

**Files:**
- Create: `apps/fleet/container/Dockerfile`
- Create: `apps/fleet/container/server.ts`
- Modify: `apps/fleet/wrangler.jsonc`

**Interfaces:**
- Consumes: `CLAUDE_CODE_OAUTH_TOKEN` from the environment.
- Produces: an HTTP service on port 8080 with `POST /ask` accepting `{"prompt": string}` and returning `{"text": string}`, plus `GET /health`.

Design note: this invokes `claude -p --continue` per message rather than holding an interactive process. Context still persists — `--continue` resumes the conversation from `~/.claude` inside the container, which lives as long as the container does. It is markedly simpler than supervising a duplex stream and it survives a crashed turn. Duplex streaming is a later optimisation if latency demands it.

- [ ] **Step 1: Write the Dockerfile**

`apps/fleet/container/Dockerfile`:

```dockerfile
FROM oven/bun:1.3-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Pinned. The auth gate and the JSON contract in server.ts are written
# against this CLI's output shape; a floating install would change both
# with zero diff to review. 2.1.224 is the version verified working.
RUN bun install -g @anthropic-ai/claude-code@2.1.224

WORKDIR /workspace
COPY server.ts /app/server.ts

ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "/app/server.ts"]
```

- [ ] **Step 2: Write the in-container server**

`apps/fleet/container/server.ts`:

```ts
const PORT = Number(process.env.PORT ?? 8080);
const WORKDIR = process.env.AGENT_WORKDIR ?? "/workspace";

// Measured in a real container: with no --model flag, headless `claude`
// resolved to claude-sonnet-5. The CTO is the agent a human argues with, so
// pin it rather than inheriting whatever the account default happens to be.
const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5";

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  terminal_reason?: string;
  session_id?: string;
  total_cost_usd?: number;
}

async function runClaude(
  args: string[],
): Promise<{ text: string; raw: ClaudeResult | null; code: number; stderr: string }> {
  const proc = Bun.spawn(["claude", ...args], {
    cwd: WORKDIR,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let raw: ClaudeResult | null = null;
  try {
    raw = JSON.parse(out) as ClaudeResult;
  } catch {
    raw = null;
  }
  return { text: raw?.result ?? out.trim(), raw, code, stderr };
}

async function ask(prompt: string): Promise<string> {
  // --continue resumes this container's conversation; context persists for the
  // life of the container without holding an interactive process open.
  // No fallback path, and none should be added. Measured in a real container
  // with a valid credential: --continue on a FRESH container returns exit 0,
  // is_error false, and a real answer — Claude Code silently starts a new
  // conversation when there is nothing to resume. A retry keyed on English
  // error prose is unreachable dead code that breaks silently the first time
  // the CLI rewords itself.
  const r = await runClaude([
    "-p", prompt,
    "--output-format", "json",
    "--effort", "high",
    "--model", MODEL,
    "--continue",
  ]);

  // The exit code alone is NOT sufficient. Measured in a real container:
  //   no credential at all  -> exit 0, result "Not logged in · Please run /login"
  //   invalid credential    -> exit 1, "Failed to authenticate. API Error: 401"
  //
  // So require an explicit is_error:false. Anything else is failure:
  // unparseable stdout leaves `raw` null, and an absent is_error field must
  // not read as success. `subtype` is "success" even on failure — never read it.
  if (r.code !== 0 || r.raw == null || r.raw.is_error !== false) {
    const detail = r.text || r.stderr || `exit ${r.code}`;
    const why = r.raw?.terminal_reason ?? `exit ${r.code}`;
    throw new Error(`claude failed (${why}): ${detail.slice(0, 500)}`);
  }

  return r.text;
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      // tokenPresent, not "authed": this reports that a credential is SET,
      // not that it works. An expired token still reads true. Do not key a
      // readiness probe on it — only /ask proves the credential is live.
      return Response.json({ ok: true, tokenPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) });
    }

    if (url.pathname === "/ask" && req.method === "POST") {
      const { prompt } = (await req.json()) as { prompt?: string };
      if (!prompt) return new Response("prompt required", { status: 400 });
      try {
        return Response.json({ text: await ask(prompt) });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`agent container listening on ${PORT}`);
```

- [ ] **Step 3: Add the container binding to wrangler**

Add this one top-level key to `apps/fleet/wrangler.jsonc`. Do **not** touch `durable_objects` or `migrations` — both already name `AgentDO`, which is the same class the container attaches to.

```jsonc
  "containers": [
    {
      "class_name": "AgentDO",
      "image": "./container/Dockerfile",
      "instance_type": "standard",
      "max_instances": 3
    }
  ],
```

The `durable_objects` and `migrations` blocks from Task 1 already name `AgentDO`; no change is needed there.

- [ ] **Step 4: Build the image locally to verify it compiles**

```bash
cd apps/fleet
docker build -t fleet-agent-test ./container
```

Expected: build succeeds, final image tagged. If Docker is unavailable locally, skip — `wrangler deploy` builds remotely in Task 7 and a build error surfaces there instead.

- [ ] **Step 5: Verify the container serves and reports unauthenticated**

```bash
docker run --rm -p 8080:8080 fleet-agent-test &
sleep 3
curl -s localhost:8080/health
docker stop "$(docker ps -q --filter ancestor=fleet-agent-test)"
```

Expected: `{"ok":true,"authed":false}` — `authed:false` is correct here, no token was passed.

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/container apps/fleet/wrangler.jsonc
git commit -m "feat(fleet): container image running claude on subscription auth"
```

---

### Task 7: Wire the container, deploy, prove life

**Files:**
- Modify: `apps/fleet/src/agents/runtime.ts`
- Modify: `apps/fleet/src/agents/do.ts`
- Create: `apps/fleet/scripts/set-webhook.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `ContainerRuntime` (class implementing `AgentRuntime`), a deployed Worker, a registered Telegram webhook.

**Blocked on both operator prerequisites.** Do not start Step 4 until the bot token is revoked and replaced and the Pages-scoped Cloudflare token exists.

- [ ] **Step 1: Add the container-backed runtime**

Append to `apps/fleet/src/agents/runtime.ts`:

```ts
import type { Container } from "@cloudflare/containers";

/** Talks to the agent container over its internal HTTP port. */
export class ContainerRuntime implements AgentRuntime {
  constructor(
    private readonly container: Container,
    private readonly port: number = 8080,
  ) {}

  async ask(prompt: string): Promise<string> {
    const res = await this.container.containerFetch(
      new Request("http://container/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      }),
      this.port,
    );
    if (!res.ok) {
      throw new Error(`container returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const { text } = (await res.json()) as { text: string };
    return text;
  }
}
```

- [ ] **Step 2: Make AgentDO a Container and default to the real runtime**

In `apps/fleet/src/agents/do.ts`, replace the class declaration line and add a default runtime. Change:

```ts
import { DurableObject } from "cloudflare:workers";
```

to:

```ts
import { Container } from "@cloudflare/containers";
```

Change `export class AgentDO extends DurableObject<Env> {` to:

```ts
export class AgentDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "20m";

  get envVars() {
    return {
      CLAUDE_CODE_OAUTH_TOKEN: this.env.CLAUDE_CODE_OAUTH_TOKEN,
      AGENT_WORKDIR: "/workspace",
    };
  }
```

Then change the runtime resolution inside `fetch` from `if (!this.runtime) throw ...` to:

```ts
      const runtime = this.runtime ?? new ContainerRuntime(this);
      replyText = await runtime.ask(incoming.body);
```

and add the import:

```ts
import { ContainerRuntime } from "./runtime";
```

- [ ] **Step 3: Run the whole suite — the seam must still hold**

Run: `cd apps/fleet && bun run test`
Expected: PASS, all files. Tests inject `FakeRuntime`, so no container starts.

- [ ] **Step 4: Push secrets**

Run each and paste the value at the prompt. Nothing is echoed, nothing is written to a file.

```bash
cd apps/fleet
claude setup-token                                   # copy the token it prints
env -u CLOUDFLARE_API_TOKEN bunx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
env -u CLOUDFLARE_API_TOKEN bunx wrangler secret put TELEGRAM_BOT_TOKEN
env -u CLOUDFLARE_API_TOKEN bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # invent a long random string
```

- [ ] **Step 5: Apply migrations remotely and deploy**

```bash
env -u CLOUDFLARE_API_TOKEN bun run migrate:remote
env -u CLOUDFLARE_API_TOKEN bun run deploy
```

Expected: a `https://fleetflare-fleet.<subdomain>.workers.dev` URL. Record it.

- [ ] **Step 6: Confirm the Worker is up before involving Telegram**

```bash
curl -s https://fleetflare-fleet.<subdomain>.workers.dev/health
```

Expected: `{"ok":true}`. A 404 here means the route regressed; fix before continuing.

- [ ] **Step 7: Register the webhook**

`apps/fleet/scripts/set-webhook.ts`:

```ts
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const url = process.env.FLEET_WEBHOOK_URL;

if (!token || !secret || !url) {
  console.error("set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and FLEET_WEBHOOK_URL");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"] }),
});
console.log(await res.json());
```

Run it with the values in the environment for one command only, so they never enter shell history as literals:

```bash
cd apps/fleet
read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN
read -rs TELEGRAM_WEBHOOK_SECRET && export TELEGRAM_WEBHOOK_SECRET
export FLEET_WEBHOOK_URL="https://fleetflare-fleet.<subdomain>.workers.dev/tg/websites"
bun run scripts/set-webhook.ts
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
```

Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`.

- [ ] **Step 8: Proof of life**

Send `what repo are you in, and what branch?` to `@websitescto_bot` from the operator's phone.

Expected: a reply in the same chat, naming the container's workspace. A generic answer that does not mention a real path means `claude` ran but the workspace is empty — that is still a pass for Day 1, because it proves the whole path end to end.

- [ ] **Step 9: Forced negatives — the checks that actually matter**

Positive-only results pass identically when the allowlist is missing and when any agent can impersonate the CTO. Run all three.

```bash
# 1. Wrong secret must be refused.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' \
  -H 'x-telegram-bot-api-secret-token: wrong' \
  -d '{"update_id":1,"message":{"message_id":1,"from":{"id":100000001},"chat":{"id":100000001},"text":"x"}}' \
  https://fleetflare-fleet.<subdomain>.workers.dev/tg/websites
# Expected: 403

# 2. No secret at all must be refused.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' \
  -d '{"update_id":2,"message":{"message_id":2,"from":{"id":100000001},"chat":{"id":100000001},"text":"x"}}' \
  https://fleetflare-fleet.<subdomain>.workers.dev/tg/websites
# Expected: 403
```

3. **Non-operator is ignored.** Have a second Telegram account message `@websitescto_bot`. Expected: no reply, and no new row for it. Confirm with:

```bash
env -u CLOUDFLARE_API_TOKEN bunx wrangler d1 execute fleet --remote \
  --command "SELECT from_agent, to_agent, kind, substr(body,1,40) AS body FROM events ORDER BY ts DESC LIMIT 10"
```

Expected: the operator's message and the CTO's reply appear; the stranger's does not.

- [ ] **Step 10: Commit**

```bash
git add apps/fleet
git commit -m "feat(fleet): container runtime, deploy, telegram webhook registration"
```

- [ ] **Step 11: Record the deployment**

Append the Worker URL, the D1 `database_id`, and the date to `docs/fleet/README.md` under a new `## Cloud fleet` heading. A deployment nobody recorded is a deployment the next agent cannot find.

```bash
git add docs/fleet/README.md
git commit -m "docs(fleet): record cloud fleet worker url and d1 id"
```

---

## Day 2 — not planned yet, deliberately

Day 1 carries the whole technical risk: whether Claude Code runs inside a Cloudflare container on subscription auth, and whether container latency is tolerable over Telegram. Planning Day 2 in detail before that is answered would be speculative.

Day 2 scope, from spec §15, to be planned once Task 7 Step 8 passes:

- Manager agent and the second warm container
- Cloudflare Queues for work dispatch, stateless dev spawn
- `git push` plus PR from inside a container using a fine-grained GitHub token (spec §12)
- The four approval gates with inline keyboards (spec §10)
- Watchdog cron sweep (spec §11)
- Hibernate and wake via R2 snapshots (spec §8)

## Verification for the whole plan

From spec §16. Items 1 and 2 do not apply to Day 1 — there is a single bot and a single agent, so cross-talk and forged approvals cannot yet occur. The rest map to Task 7 Step 9 and to the unit tests:

| Spec §16 check | Where it is proven |
|---|---|
| Non-operator inbound is dropped | Task 4 test 3; Task 7 Step 9 item 3 |
| `to:"human"` from a non-CTO never reaches Telegram | Task 2 test 2 |
| Escalation dedupe collapses repeats | Task 2 test 5 |
| Runtime failure does not lose the turn | Task 5 test 3 |
| Webhook secret is enforced | Task 4 tests 1 and 2; Task 7 Step 9 items 1 and 2 |
| Message reaches the container and returns | Task 7 Step 8 |
