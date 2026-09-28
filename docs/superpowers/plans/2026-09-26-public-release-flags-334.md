# Public-release flags (board issue #334)

SHOULD for public release. Keep the operator's live setup working unchanged: every
flag ON in the repo's `wrangler.jsonc` (his config), OFF in a new
`wrangler.example.jsonc`.

## Findings (read-only mapping, 2026-09-26)

- Telegram: `OPERATOR_ID = "100000001"` hardcoded (`src/agents/registry.ts:1`);
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET` required in `Env`. Entry
  points: `POST /tg/:project` (`index.ts:63`), cron watchdog over `AGENTS`
  (`index.ts:97-148`), GitHub unapproved-write alert (`github/webhook.ts:629`),
  studio alerts (`studio/do.ts` notify closures: refresh, sync, failover).
- DeployDO: only caller is the Telegram approval button
  (`approvals/gates.ts:214`) → legacy. With Telegram off, AgentDO and DeployDO
  are unreachable (their only entry points are `/tg` and the cron) and their
  containers never start. Classes, bindings and migrations stay: deleting a DO
  class needs a `deleted_classes` migration + deploy — separate follow-up.
- Directus: already optional (null config → no fetch); one gate point,
  `directusConfig` (`directus/client.ts:84`), covers all 3 call sites.
- Orca: `ensureStudioWorkspace` returns silently when the `orca` binary is
  missing (`cli/orca-workspace.ts:534`); only `fleet ls` says so.

## Design

1. `FLEET_TELEGRAM` ("on" enables) + `TELEGRAM_OPERATOR_ID` var.
   `telegramEnabled(env)` = flag "on" AND bot token AND operator id set.
   Off: `/tg/*` → 404; cron watchdog loop skipped (container-watch still
   runs); unapproved-write alert skipped (D1 event still written); studio
   notify closures no-op. `TELEGRAM_*`, `CLOUDFLARE_DEPLOY_TOKEN` become
   optional in `Env`. Operator id read from env, never hardcoded.
2. `FLEET_DIRECTUS` ("on" enables): `directusConfig` returns null otherwise.
3. Orca: missing binary → one stderr line per process from
   `ensureStudioWorkspace` ("Orca is optional; attach with `fleet attach`"),
   suppressed inside a studio (`STUDIO_ID` set). Binary present but not under
   Orca stays silent (deliberate, existing rule). README + fleet-cockpit say
   Orca is optional.
4. `wrangler.jsonc`: `FLEET_TELEGRAM="on"`, `TELEGRAM_OPERATOR_ID`,
   `FLEET_DIRECTUS="on"`. New `wrangler.example.jsonc`: flags off,
   placeholders for every operator-specific value.

## Tests (RED first each)

- `/tg/x` → 404 with flag off; handled with flag on.
- `scheduled()` makes no AGENT call with flag off; container-watch still runs.
- github webhook: unapproved write with flag off → D1 event, no Telegram send.
- studio notify: flag off → no fetch to Telegram.
- operator id: webhook refuses a sender ≠ `TELEGRAM_OPERATOR_ID`.
- `directusConfig` null unless `FLEET_DIRECTUS="on"`.
- Orca: missing binary logs once across two calls; `STUDIO_ID` set → silent;
  binary present + not under Orca → silent.

## Gates

`bun run check`, `bun run test`, bun-test lane (Linux), english-check.
