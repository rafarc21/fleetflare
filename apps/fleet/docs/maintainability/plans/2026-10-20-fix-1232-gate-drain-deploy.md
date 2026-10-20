---
# fix #1232: drain running gate runs before Worker deploy (refs #1232)

## What

Measured 2026-10-19 19:57Z: a forced Worker deploy (after 600 s no-lull) killed 3
in-flight gate runs; one lost 9 legs on both attempts. The Worker's
`code_update_strategy` is "immediate", so a deploy ends live Workflows
instances mid-leg, and a gate's Workflow is not resumable across a deploy.
Add a drain: deploy.sh sets a D1 flag so new gate runs queue as pending, waits
until running gate instances = 0 (cap 15 min), deploys, clears the flag; the
queued pending runs start once the flag is clear.

## Fix (Worker-only; deploy.sh is the operator's script, no container change)

1. **`gate_drain` flag** (D1 `fleet_state`, key `gate_drain`, value "1" while a
   deploy is draining). No migration: the table exists (migration 0002), and
   `getFlag`/`setFlag`/`deleteFlag` (src/state.ts) are the existing accessors.
   `flagIsSet(db, "gate_drain")` is the read.

2. **Pending queue** (D1 `fleet_state`, key `gate_drain_pending`): a JSON array
   of `{ repo, pr, headSha }` — the runs that arrived while the flag was set.
   Plain `getFlag`/`setFlag`/`deleteFlag` over the JSON string, not a new table:
   the queue is tiny (a handful of PRs in a 15-minute window).

3. **Start paths queue instead of create while the flag is set** (both entry
   points, in `auto-run-env.ts` so `auto-run.ts` stays env-free):
   - `autoRunFromEnv` (the pull_request webhook) — before starting, read the
     flag; when set, append `{ repo, pr, headSha }` to the queue and return
     `"pending"` (no Workflow create). Still posts the pending commit status so
     GitHub never sees the head without a gate (#1191).
   - `handleGateRoute` POST /studio/gate/start (src/gate/routes.ts) — when the
     flag is set, return `{ started: false, pending: true }` (still HTTP 200);
     the CLI prints "queued (gate draining for deploy)". It does NOT queue the
     id-less manual start (the manual form carries no headSha until it reads
     GitHub), so a manual run during a drain fails-fast instead of queueing.

4. **Cron drains the queue** (src/index.ts `handleScheduled`, after the
   watchdog sweep): when the flag is NOT set and the queue is non-empty, start
   each queued `{ repo, pr, headSha }` through `autoRunFromEnv` (the same path
   as the webhook), then clear the queue. A start failure keeps the entry
   (replayed next minute). The queue drains only when the flag is clear, so the
   deploy's own "clear flag" is what releases them.

5. **deploy.sh drain** (scripts/deploy.sh, before the `wrangler deploy`):
   - set `gate_drain` = "1" via `wrangler d1 execute fleet --remote
     --command "INSERT INTO fleet_state (key,value,ts) VALUES ('gate_drain','1',<epoch>) ON CONFLICT(key) DO UPDATE SET value='1', ts=excluded.ts"`;
   - loop `wrangler workflows instances list gate --json` filtered to
     running/paused statuses; count > 0 → sleep 5 s and retry, up to 15 min;
   - on timeout, refuse (exit non-zero) and leave the flag SET (the operator
     clears it manually after inspecting) — never deploy into a running gate;
   - run the wrangler deploy (the existing `exec "$WRANGLER" deploy ...`);
   - clear the flag (set value "0"). On any deploy failure the flag stays set
     (a `trap` is out of scope; the operator clears it). Only for the plain
     Worker `deploy` path (no args / plain `deploy`), not `versions deploy`,
     `rollback`, `delete`, `d1 migrations` (read-only commands and migrations
     never drain).
   - `--allow-unrescued` does NOT skip the drain: the drain is a different gate.
     New flag `--skip-gate-drain` (consumed here, never passed to wrangler)
     skips it loudly.

## TDD

- **drain helpers (vitest)** — new `test/gate-drain.test.ts`: `gateDrainPending`
  enqueue/peek/dequeue over the real D1 (JSON parse, idempotent replay, clear);
  the flag read/set via `flagIsSet`/`setFlag`.
- **start queueing (vitest)** — `test/gate-routes.test.ts` and the webhook test:
  flag set → POST /studio/gate/start answers `{ started:false, pending:true }`
  and creates no instance; webhook queues the PR and `create` is never called.
- **cron drain (vitest)** — `test/gate-watchdog-env.test.ts` (or the new drain
  file): flag clear + queue non-empty → each queued PR is started through
  autoRunFromEnv and the queue clears; flag set → nothing starts.
- **deploy.sh (bun)** — `test/bun/deploy-rescue-gate-*.test.ts` harness: the
  stub wrangler records the `d1 execute` / `workflows instances list` / `deploy`
  calls; assert set-flag → poll-list → deploy → clear-flag order, that a
  non-empty running list refuses after the cap, and that `d1 migrations` never
  drains.

## Boundaries

`apps/fleet/src/gate/**` (auto-run-env.ts, routes.ts), `apps/fleet/src/index.ts`
(cron), `apps/fleet/scripts/deploy.sh`, `apps/fleet/src/state.ts` (reused, no
change), tests. No `src/gate/auto-run.ts` change (stays env-free), no
container/, no image, no migration. OSS lead OK.

## Verify

`cd apps/fleet && bunx vitest run test/gate-drain.test.ts
test/gate-routes.test.ts test/gate-watchdog-env.test.ts
test/github.webhook-pull-request-gate.test.ts` then
`bun test test/bun/deploy-rescue-gate-misc.test.ts test/bun/cli-gate.test.ts`
then `bun run check` last.
---