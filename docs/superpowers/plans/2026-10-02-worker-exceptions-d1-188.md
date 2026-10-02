# Capture Worker exceptions into D1 (#188)

**Issue:** https://github.com/rafarc21/fleetflare/issues/188

**Context:** #168 sensor 4 ("Worker exceptions") needs a durable record of
any exception that escapes the Worker's own entry points. The design doc
(`docs/superpowers/specs/2026-10-01-sensor-task-control-loop-168-design.md`,
section "4. Worker exceptions", lines 82-92) lays out two options; the
operator approved option (b): wrap `fetch`/`scheduled` themselves so an
uncaught exception gets written to D1 immediately before being rethrown
unchanged. No new credential is needed — the Worker already holds D1 write
access via `env.DB`.

Merge danger: **one-way**. `migrations/0003_worker_exceptions.sql` is a D1
migration; once applied `--remote` it cannot be rolled back. Full review
tier.

## Schema

New file `apps/fleet/migrations/0003_worker_exceptions.sql`, following
`0002_day2.sql`'s exact style (`CREATE TABLE IF NOT EXISTS`, `id TEXT PRIMARY
KEY` generated app-side via `crypto.randomUUID()`, `ts INTEGER NOT NULL`
epoch millis passed by the caller, aligned caps column types):

```sql
CREATE TABLE IF NOT EXISTS worker_exceptions (
  id          TEXT    PRIMARY KEY,
  ts          INTEGER NOT NULL,
  route       TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  stack_head  TEXT
);

CREATE INDEX IF NOT EXISTS worker_exceptions_ts ON worker_exceptions (ts);
```

`stack_head` is nullable — a thrown non-`Error` value may carry no stack at
all.

## New module: `apps/fleet/src/exceptions.ts`

Modeled on `src/events/log.ts` (prepared statements, `.bind(...)`,
`D1Database` as the first param) and `src/state.ts`.

- `recordWorkerException(db: D1Database, route: string, err: unknown, now: number): Promise<void>`
  — extracts `name`/`message`/`stack` from `err` (a thrown non-`Error` gets
  `message = String(err)`, `name = "<non-Error throw>"`, no stack).
  **Redacts before truncating, never the other way round** — the same order
  `src/studio/activity.ts`'s `truncateLine`/`extractLastVisibleLine` doc
  comments establish and `src/studio/grid.ts`'s `scrubPreview` already
  implements: `redactSecrets` (imported from `src/studio/redact.ts`, already
  Worker-importable) runs on the FULL `message` and the FULL `stack` first;
  only the already-redacted stack is then sliced to its head
  (`STACK_HEAD_MAX_LINES = 10` lines). `id` is `crypto.randomUUID()`.
  **Never throws** — its own `db.prepare(...).run()` call is wrapped in
  try/catch; on failure it `console.error`s and swallows (issue is explicit:
  "insert failure must never change response behavior", so this function's
  whole contract is best-effort). On a successful insert it also calls
  `pruneWorkerExceptions` — same never-throws contract, failure swallowed
  the same way so a prune failure can never surface either.
- `pruneWorkerExceptions(db: D1Database, keep: number = 1000): Promise<void>`
  — caps the table at `keep` rows, deleting the oldest beyond that by `ts`:
  `DELETE FROM worker_exceptions WHERE id NOT IN (SELECT id FROM
  worker_exceptions ORDER BY ts DESC LIMIT ?)`. No existing "cap at N rows"
  precedent elsewhere in this repo (only timestamp-cutoff deletes exist), so
  this is new. Never throws, same reasoning as above.
- `countWorkerExceptions(db: D1Database): Promise<number>` — plain `SELECT
  COUNT(*) AS n FROM worker_exceptions`, `.first<{n: number}>()`. This one
  CAN propagate normally — it backs a read-only route, nothing depends on it
  being silent.

## Wrapper placement: `apps/fleet/src/index.ts`

Exactly one outer `try/catch` added around the ENTIRE body of each entry
point, catching anything that escapes past the handlers' own existing LOCAL
try/catch blocks (scheduled's several sub-step catches are untouched — this
wrapper only catches what already gets past them).

- `fetch`: `route = url.pathname`.
- `scheduled`: `route = "scheduled"` (no URL exists in a cron invocation).

On catch: `await recordWorkerException(env.DB, route, err, Date.now())`
(never escapes, per its own contract above), then `throw err` — rethrows
the exact same error, unchanged, no wrapping.

## New read-only route: `apps/fleet/src/studio/routes.ts`

`GET /studio/worker-exceptions/count`, mounted inside `handleStudio`
alongside the existing `GET /studio/accounts` route (same no-studio-id
shape, same Access-gated surface already enforced by `verifyAccess` at the
top of `handleStudio`, same `Response.json(...)` response shape). Returns
`Response.json({ count: await countWorkerExceptions(env.DB) })`. Deliberately
reuses the EXISTING Access-gated `/studio/` auth lane — no new credential, no
new auth surface.

## Test plan (TDD, RED then GREEN)

New file `apps/fleet/test/exceptions.test.ts` for the module's own unit
tests, plus additions to `apps/fleet/test/index.test.ts` (entry-point
wrapping) and `apps/fleet/test/studio.routes.test.ts` (the new route). Both
existing files' `beforeEach` gain `DELETE FROM worker_exceptions` alongside
their existing `DELETE FROM fleet_state`.

Required coverage (7 items):

1. A forced exception through `worker.fetch` (via `vi.spyOn` on a module
   function the route under test calls — e.g. `registry.listStudios`, the
   same technique `index.test.ts` already uses throughout for
   `authModule.verifyAccess`) → assert a row landed in `worker_exceptions`
   (direct `env.DB.prepare(...).all()`) with the right `route`/`name`/
   `message`, AND assert `worker.fetch(...)` still rejects with the ORIGINAL
   error unchanged.
2. Same shape for `worker.scheduled` (spy on `state.getFlag`, called
   outside any of `scheduled`'s own local try/catch blocks, with a stale
   task present so that line actually runs).
3. A redaction test: throw an error whose message contains a secret shape
   `redactSecrets` covers (e.g. `sk-ant-...`) and assert the stored
   `message` has it redacted, not the raw secret.
4. An insert-failure test: a plain object implementing only `prepare` (same
   "stub binding with the one method it needs" shape as `index.test.ts`'s
   `fakeAgentReturning`/`fakeStudio`), delegating every statement to the
   real `env.DB.prepare` EXCEPT the `INSERT INTO worker_exceptions`
   statement, which throws. Assert the original (non-D1) error still
   propagates out of `fetch` unchanged, and that no row landed (proving the
   insert genuinely failed rather than silently succeeding).
5. A unit test for `pruneWorkerExceptions`: insert 1005 rows directly with
   distinct `ts` values, call it with `keep = 1000`, assert exactly 1000
   remain and they are the 1000 newest by `ts`.
6. A unit test for `countWorkerExceptions` against a known row count.
7. A route test for `GET /studio/worker-exceptions/count` (401 without
   Access, 200 with the right count).

Run only the touched files: `vitest run test/index.test.ts
test/exceptions.test.ts test/studio.routes.test.ts` — not the full `bun run
test`/`bun run check` sweep (heavy-gate budget; this task's scope doesn't
need the full suite, and a second concurrent full gate from another fleet
member risks the memory ceiling).

## Operator fix-first review, PR #198 (2026-10-02)

The operator reviewed the PR directly (soft block, migration stays as-is)
and asked for five fixes before merge. All five landed on top of the plan
above, same migration, same table:

1. **Hot-path safety in `recordWorkerException`.** Three changes so a
   slow/degraded D1 can't turn every failing request into a second
   load-bearing call against the SAME struggling D1: a per-isolate rate cap
   (~20 records/minute, rolling window, checked before any `prepare`/`run`
   is attempted — `rateCapped`/`__resetExceptionRateCapForTests` in
   exceptions.ts); a ~2s timeout on the insert itself (`Promise.race` +
   `setTimeout`, same idiom as src/studio/sandbox-api.ts's `sbExec`); and
   the prune call moved from an inline `await` to `ctx.waitUntil`, so it
   still runs every time but strictly after the caller's own response has
   already resolved. `recordWorkerException` gained a required `ctx:
   ExecutionContext` parameter; both src/index.ts call sites thread their
   already-in-scope `ctx` through.
2. **New secret shapes in `redactSecrets`** (src/studio/redact.ts, a
   Worker-wide util — these help every caller, not just this feature): a
   JWT (`eyJ...`), a Telegram bot token (this Worker's own real
   `telegram.token` → `sendCard` path), a multiline PEM private-key block,
   and `token=`/`key=` query-string values. Also, in exceptions.ts: a
   `MAX_FIELD_CHARS` (2000) char cap on both `message` and `stack_head`,
   applied AFTER redaction (same ordering this module already followed for
   `stack_head`'s line-count truncation) — `message` had no cap before this.
   **Superseded below (operator stop-change, see "Operator stop-change:
   secret patterns moved off the shared util" section) — the shared-`redactSecrets`
   part of this fix was reverted; the patterns now live module-local in
   exceptions.ts. The `MAX_FIELD_CHARS` cap described here is unaffected
   and still stands as written.**
3. **Stronger test assertions.** The four exception-capture tests in
   test/index.test.ts now assert `.rejects.toBe(originalErrorInstance)`
   instead of `.rejects.toThrow(message)` — proving the EXACT same object
   propagates, not merely one with a matching string. Added a new test
   covering an async `.run()` rejection (not just a synchronous `.prepare()`
   throw) through the same try/catch.
4. **Prune query shape.** `pruneWorkerExceptions` now deletes by a
   boundary-timestamp comparison (`ts < (SELECT ts ... OFFSET keep - 1)`)
   instead of `NOT IN` over a potentially-large id set. Fewer than `keep`
   rows: the subquery returns no row, so `ts < NULL` is never true — nothing
   gets deleted, which is correct.

### Caveats

`countWorkerExceptions` (and the `/studio/worker-exceptions/count` route it
backs) answering 0 does **not** mean the Worker is healthy — this entire
feature only catches what is thrown synchronously-awaited inside `fetch`'s/
`scheduled`'s own body, via the one outer try/catch src/index.ts wraps
around each. It has no visibility into:

- Failures inside a `ctx.waitUntil`-deferred background task — this
  feature's own `pruneWorkerExceptions` call included; if prune itself
  fails inside its `waitUntil`, nothing records that, since there is no
  outer try/catch left once the promise has been handed off.
- Durable Object internals (AgentDO/DeployDO/StudioDO methods run in their
  own object context, never touching this wrapper).
- WebSocket message handlers, if any exist.
- A route that catches its own error internally and deliberately returns a
  500 `Response` rather than throwing — nothing escapes to be caught, so
  nothing gets recorded.

This is a known, accepted gap for this sensor's current scope, not a defect
to fix here — see `countWorkerExceptions`'s own doc comment (exceptions.ts)
and the `/studio/worker-exceptions/count` route's doc comment
(src/studio/routes.ts) for the same note kept next to the code.

## Operator stop-change: secret patterns moved off the shared util (2026-10-02)

Item 2 of the "Operator fix-first review" section above, as originally
landed, extended the SHARED Worker-wide `redactSecrets`
(`src/studio/redact.ts`) with the 4 new patterns. That util has a shell
mirror, `apps/fleet/container/studio-bringup.sh`'s `bringup_redact`, which
has to stay byte-for-byte in sync with it — so the fix also edited
`studio-bringup.sh`, plus `test/studio.redact.test.ts` and
`test/bun/bringup-log.test.ts` to cover both sides.

**Operator stop-change:** touching anything under `container/` makes this
a container IMAGE change — a rebuild and rollout, replacing every running
studio — for what was supposed to be a Worker-only feature (new D1 table,
new D1 writes, no new credential). Unacceptable blast radius. Ruling:
revert the shared-util path entirely; keep the 4 patterns, but move them
local to this feature.

**The revert (commit `075a7f7`):** `src/studio/redact.ts`,
`container/studio-bringup.sh`, `test/studio.redact.test.ts`, and
`test/bun/bringup-log.test.ts` were hard-reset to byte-identical with
`origin/main` — undoing exactly the 4 commits (`42aaae5`, `7217040`,
`5b0382c`, `2741ff5`) that had touched them for this fix.

**The replacement (commit `7e02d4c`):** the same 4 shapes (JWT, Telegram
bot token, multiline PEM private-key block, `token=`/`key=` query-string
values) landed instead as a new module-private function,
`scrubExceptionLocalSecrets`, in `src/exceptions.ts` — not exported, not
the shared `redactSecrets`. `describeError` calls it on `message` and
`stack` AFTER `redactSecrets` already ran and BEFORE `stackHead`/
`capField` (same redact-before-truncate ordering the rest of this module
follows). Coverage on `worker_exceptions` rows is identical to the
reverted version; zero lines under `container/` change. 4 new tests moved
into `test/exceptions.test.ts` (specimens carried over from the reverted
`test/studio.redact.test.ts`, see `git show 42aaae5`).

**Regex-precision follow-up (commits `8729901`, `815eca1`):** a second
operator review hardened the 4 patterns themselves:

- `TELEGRAM_TOKEN_RE` gained `\b` word-boundary anchors on both ends, so it
  no longer partial-matches inside a longer digit run.
- `PEM_PRIVATE_KEY_RE`'s END-marker alternation gained an end-of-string
  fallback (`(?:-----END [A-Z ]*PRIVATE KEY-----|$)`) — without it, an
  unterminated PEM block (no END marker ever found) forced the non-greedy
  `[\s\S]*?` to backtrack across the rest of the string hunting for a
  terminator that doesn't exist, the classic non-greedy-with-no-anchor
  ReDoS/quadratic-blowup shape. Anchoring to end-of-string gives the engine
  a guaranteed match point instead.
- `QUERY_SECRET_RE` expanded its alternation to also cover `access_token=`
  and `api_key=`, not just `token=`/`key=`.
- Test-isolation nit (`test/index.test.ts`): the module-level exception
  rate cap (~20/minute) was never reset between tests, risking cross-test
  pollution on a long run — the top-level `beforeEach` now calls
  `__resetExceptionRateCapForTests`.

No container/image change in any of this follow-up either — all 3 commits
stayed inside `src/exceptions.ts` and its own test file (plus the one
`index.test.ts` nit above).
