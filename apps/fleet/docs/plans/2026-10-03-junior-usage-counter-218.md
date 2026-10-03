# junior usage counter + fleet junior stats (#218)

Operator order 2026-10-03: measure GLM (junior) adopt vs Claude.

## Scope: bounded feature, 4 layers

1. D1 migration (one-way door, `apps/fleet/migrations/**` glob).
2. Worker: record usage server-side inside existing `/fleet/junior` route.
3. Worker: new `/studio/junior/usage` GET route (Access-auth), aggregate stats.
4. CLI: `fleet junior stats [--since <dur|date>]` + local jsonl read.

## Design decisions

**Where recording happens — server-side, not a second client POST.**
`handleFleetJunior` (`apps/fleet/src/junior/route.ts`) already resolves
`studio.id` (spawn token → studio, auth'd) and already computes
`usage.in`/`usage.out` via `normalizeAiResult` inside its detached IIFE
(route.ts:219-237), before writing result to client. Insert usage row
right there, fire-and-forget (own try/catch, never await-blocks the
response write, never throws out of the IIFE). No new studio-facing
write endpoint, no new auth surface, no second network round-trip from
junior.sh. This is what "ship to Worker / existing route" in the issue
body means literally.

**mode (edit|text) not in the AI request body.** `ChatRequest` sent to
`client.ts#callOnce` goes verbatim to Cloudflare's real chat-completions
API on `direct` transport — adding an extra field risks breaking that
call. Instead: `callOnce` sends header `X-Junior-Mode: <mode>` ONLY when
`t.kind === "proxy"` (never reaches the real Cloudflare API). Threaded
through `PolicyOpts` → `callWithPolicy` → `main.ts`. Worker route reads
the header, defaults to `"edit"` if absent/invalid.

**Local (Mac) recording stays in junior.sh, per issue text.** Local calls
never touch the Worker — `resolveTransport` returns `kind: "direct"` on a
laptop. After `telemetry()` is computed (one of 4 call sites: ok/invalid/
timeout/api-error — NOT the early AuthError branch, where `calls === 0`,
no model call ever happened), also call `recordUsageLocal()`:
append one JSON line to `~/.local/share/fleet/junior-usage.jsonl`
(`mkdirSync({recursive:true})` then append). Wrapped in try/catch —
failure logs a soft stderr warning, never changes `main()`'s return
value (issue Boundaries: "never blocks or fails the junior call").
Session id for a local line = `os.hostname()` (no spawn-token/studio
concept exists on a laptop).

**Row/line shape, same field names both places** (issue's `{ts,
studio-or-session id, mode, input_tokens, output_tokens, ok}`):
`{ts, id, mode, model, input_tokens, output_tokens, ok}`.

**No secrets, no prompt/response text** (issue Boundaries) — only
counts/ids/booleans ever written, enforced by construction (the record
function signatures take only numbers/strings/booleans, never
`ChatResult.content`).

## Files

- `apps/fleet/migrations/0004_junior_usage.sql` — new:
  ```sql
  CREATE TABLE IF NOT EXISTS junior_usage_log (
    id             TEXT    PRIMARY KEY,
    ts             INTEGER NOT NULL,
    studio_id      TEXT    NOT NULL,
    mode           TEXT    NOT NULL,
    model          TEXT    NOT NULL,
    input_tokens   INTEGER NOT NULL,
    output_tokens  INTEGER NOT NULL,
    ok             INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS junior_usage_log_ts ON junior_usage_log (ts);
  CREATE INDEX IF NOT EXISTS junior_usage_log_studio ON junior_usage_log (studio_id);
  ```
- `apps/fleet/src/junior/usage.ts` — new: `insertJuniorUsage(db, row)`,
  `aggregateJuniorUsage(db, sinceTs)` (GROUP BY studio_id: calls, sum
  input/output tokens; plus a totals row).
- `apps/fleet/src/junior/route.ts` — `handleFleetJunior`: read
  `X-Junior-Mode` header; after the IIFE computes `out`/usage (both ok
  and error paths), fire-and-forget `insertJuniorUsage`.
- `apps/fleet/src/index.ts` — mount new `GET /studio/junior/usage` route
  (Access-auth, same pattern as other `/studio/*` routes) →
  `handleJuniorUsageStats` (new, in `usage.ts` or a thin `stats-route.ts`
  beside it): parses `?since=`, calls `aggregateJuniorUsage`, returns
  JSON `{rows, totals}`.
- `skills/junior/src/client.ts` — `ChatRequest`/`PolicyOpts`/`callOnce`:
  thread `mode`, send as header on proxy transport only.
- `skills/junior/src/usage.ts` — new: `recordUsageLocal(env, row)`
  (jsonl append, try/catch, never throws).
- `skills/junior/src/main.ts` — call `recordUsageLocal` at the 4
  telemetry call sites (only when `transport.kind !== "proxy"` — proxy
  calls are recorded server-side already, recording them again locally
  too would double-count and also isn't what the issue describes).
- `apps/fleet/cli/cli-args.ts` — `junior` `CliCommand.action` gains
  `"stats"`; parse `--since <dur|date>`. `stats` must run AFTER
  `loadCredentials()` (needs Access JWT to call the Worker), unlike
  enable/disable/status — branch in `fleet.ts`'s pre-credentials special
  case to exclude `action === "stats"`.
- `apps/fleet/cli/junior.ts` — `cmdJuniorStats(creds, sinceArg)`: parse
  `--since` (duration `\d+[hd]` or ISO date) to a ms timestamp, read+
  filter local jsonl, fetch `/studio/junior/usage?since=` via
  `boardUrl`/`accessHeaders`-style helper (mirrors `cmdTaskShow`), merge
  local + remote rows, print per-id table + TOTAL line.
- `apps/fleet/scripts/merge-danger.ts` — no edit needed, migration glob
  already covers `apps/fleet/migrations/**`.

## Tests (real seams, matching house style)

- `apps/fleet/test/junior.usage.test.ts` (vitest, real D1 via
  `cloudflare:test` env, same pattern as `junior.ratelimit.test.ts`):
  `insertJuniorUsage` + `aggregateJuniorUsage` round-trip against real
  `env.DB`; `handleFleetJunior` route-level test asserting a row lands
  after a successful AND a failed `ai.run()`; `handleJuniorUsageStats`
  route test with Access-JWT mock, `?since=` filtering.
- `skills/junior/test/usage.test.ts` (bun:test): `recordUsageLocal`
  against a real tmp dir (`mkdtempSync`, real fs, no mock) — success
  case (line appended, correct shape) and failure case (unwritable dir)
  proving it never throws.
- `skills/junior/test/main.test.ts` extension (or new): proxy-mode call
  sends `X-Junior-Mode` header; direct-mode call does NOT send it (real
  `fetchImpl` stub capturing the request, not a full HTTP mock).
- `apps/fleet/test/bun/junior-stats-cli.test.ts`: real subprocess spawn
  of `fleet junior stats` (mirrors `junior-local-cli.test.ts`) against a
  real tmp jsonl file — proves on-disk parsing + `--since` filtering for
  the local half without a live Worker.

## Merge Danger

One-way (migration touches `apps/fleet/migrations/**`). Blast radius:
new table, additive only, no existing table/route touched — a bad
migration here affects nothing already in prod except taking one D1
migration slot; worst case is a broken `fleet junior stats` command,
never a broken junior call (usage insert is fire-and-forget, wrapped,
never affects the response already streamed to the studio).

## Verification plan (one heavy gate at a time, per house rule)

1. Scoped: `bun run test apps/fleet/test/junior.usage.test.ts` (vitest).
2. Scoped: `bun test skills/junior/test/usage.test.ts skills/junior/test/main.test.ts`.
3. `bun run migrate:local` then re-run (1) to confirm migration applies
   clean from scratch too.
4. Full gates, SEQUENTIAL, never concurrent with each other or with (1)-(3):
   `bun run check` (tsc, 4 projects) → `bun run test` (full vitest) →
   `bun run bun-test` → `bun run test-lies-check` → `bun run english-check`.
5. QA: ego-browser/Playwright MCP not applicable (no UI) — `qa-engineer`
   verifies via CLI invocation + real Worker call in dev, not browser.
