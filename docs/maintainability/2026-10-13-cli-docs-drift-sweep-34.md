# CLI docs drift sweep 34 — fleet/ff verbs + flags in docs vs the real CLI (2026-10-13)

Ref #734. Analysis only, read-only, no code changed, no doc fixed here — this doc records findings; fixes land as separate tasks it spawns. Thirty-fourth maintainability sweep: documentation accuracy for the CLI surface — verbs and flags documented in docs/ that no longer match `fleet help` + the parsers in apps/fleet.

Scope per the task: docs/**, apps/fleet/docs/**, README.md, CONTRIBUTING.md vs `bun cli/fleet.ts help` and the arg parsing in apps/fleet/src/studio/cli-args.ts, apps/fleet/src/studio/ff.ts, apps/fleet/cli/fleet.ts, apps/fleet/container/studio-fleet, apps/fleet/scripts/deploy.sh. Line refs = physical lines at origin/main cbc1c6f (branch base), paths relative to repo root unless prefixed.

Excluded by precedent (sweep 17, docs-accuracy sweeps): docs/superpowers/ (archived working material), docs/fleet/README.md (dated 2026-08-03 record-of-truth snapshot for another project, carries its own "Last measured" framing), docs/fleet/firstmate-analysis.md, skipperm-effort-report.md, spike-lead-tools.md (dated records — every verb claim in them re-verified anyway, none stale on the claims that matter), apps/fleet/docs/plans/ (119 dated plan records; the one verb-shaped hit — studio-readonly-inspect.md's `fleet exec` — is the doc choosing the name `fleet inspect` OVER `fleet exec`, accurate history, not drift). docs/maintainability/*.md are the sweeps' own dated records, out of scope by construction.

**Lane rule (from the task):** GLM-OK = none of auth, secrets, tokens, credentials, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate, approvals. CLAUDE-ONLY = any of those. Findings touching any are titled CLAUDE-ONLY and not filed as GLM fix issues.

## Method

Every `fleet <verb>` and `ff` mention extracted from scope docs by grep (`fleet [a-z-]+`, backticked command spans); every `--flag` token likewise (`--[a-z][a-z0-9-]*`). Each then verified against the live parser: verb set from src/studio/cli-args.ts's switch (ls, check, clear-session-guard, inspect, tabs, attach, paste, spawn, provision, recycle, destroy, task-new/ls/show/verify/assign/state/reap/junior-sweep, rescue-gc, rescue-all, reap, memory-ls/compact, junior, accounts/hold/clear, models) and `bun cli/fleet.ts help` run in the working tree; ff grammar from src/studio/ff.ts parseFfArgs (role, quoted task, `#N`/`N` adopt, `--new`, `--help`/`-h` anywhere per #569); in-container verbs from container/studio-fleet's HELP; flags cross-checked per-verb against TASK_FLAGS and the bespoke parsers. Most claims checked out — the verified-clean list is below the findings, so the next sweep does not re-derive it.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | README's `fleet ls` "more columns" list names 6 of the 10 extras — 4 newer columns missing | GLM-OK |
| 2 | "one studio per role" (README + architecture.md x2) vs `fleet spawn --new` / `ff --new` instances (#269) | GLM-OK |
| 3 | operations.md's Infisical setup says bare `wrangler secret put` — the repo's own rule is `scripts/deploy.sh secret put`, never bare | CLAUDE-ONLY |
| 4 | operations.md's dead-account cleanup says bare `wrangler d1 execute fleet --remote` — remote-changing wrangler outside deploy.sh, accounts/failover section | CLAUDE-ONLY |

### S34-F1. README's `fleet ls` column enumeration is stale — 4 of the 10 extra columns missing — GLM-OK

- **Site:** README.md:150-152 — "(Trimmed for readability — the real table has more columns too: REPO, SESSION, ACTIVITY, ACCOUNT, HOST, ERROR. ...)"
- **CLI truth:** apps/fleet/cli/fleet.ts:398 — the real header row is `ID, REPO, STATE, RST, WIP, PRS, READY, SESSION, ACTIVITY, CHECKED, ROW, ACCOUNT, HOST, BURN, REFRESHED, ERROR` (16 columns). The README sample shows ID, STATE, READY, BURN and then names the extras as 6 — missing 4 that landed later: RST (issue #56, restarts), WIP (board #208, wip-sync age), PRS (#332, open PRs, `--prs`), CHECKED (verdict age), plus ROW and REFRESHED. A reader trusting the parenthetical to know the full table misses the two columns (`WIP`, `REFRESHED`) that carry operational meaning for a parked or stale studio.
- **Proposed fix:** README.md:150 — "the real table has more columns too: REPO, WIP, PRS, SESSION, ACTIVITY, CHECKED, ACCOUNT, HOST, REFRESHED, ERROR" (name all 10 extras past ID/STATE/READY/BURN, one line, no per-column glossary — `fleet help` is the reference).

### S34-F2. "One studio per role" in README + architecture.md — `--new` instances exist (#269) — GLM-OK

- **Site:** README.md:34 — "one studio per role per repo"; docs/architecture.md:52 — "one repo supports one studio per role"; docs/architecture.md:103 — FAQ "One studio per role — ... Parallelism beyond that comes from the member subagents inside each studio."
- **CLI truth:** `fleet spawn <role> --new` (apps/fleet/src/studio/cli-args.ts:70, :342-343, :915) creates an ADDITIONAL studio for that role on the lowest free instance number (`<repo>--<role>--2`, `--3`, ...) — issue #269, shipped; `ff <role> --new "<task>"` has the same flag (src/studio/ff.ts NEW_INSTANCE_FLAG, ff --help). `fleet help` documents it on the spawn row. The docs' absolute phrasing reads as a capability statement; a reader would conclude a second web-studio is impossible when the CLI has a first-class flag for exactly that (with the shared-account caveat the help text itself carries).
- **Proposed fix:** three one-phrase amendments: README.md:34 "...one studio per role per repo (a role's `--new` flag adds instances — `--2`, `--3` — when a parallel lead is worth it)". architecture.md:52 "...one studio per role by default — `fleet spawn --new` adds numbered instances (#269) — parallelism beyond that comes from members...". architecture.md:103 FAQ answer: keep "one studio per role" as the default shape, add the `--new` instance sentence before "Parallelism beyond that comes from the member subagents".

### S34-F3. operations.md's test-credentials setup says bare `wrangler secret put` — the repo's rule is `scripts/deploy.sh secret put`, never bare — CLAUDE-ONLY

- **Site:** docs/operations.md:114 — "2. `wrangler secret put INFISICAL_CLIENT_ID` and `wrangler secret put INFISICAL_CLIENT_SECRET`."
- **CLI truth:** docs/setup.md:310-314 (the repo's own operator rule): "Actual credentials never go in `wrangler.jsonc` — they are set with `scripts/deploy.sh secret put <NAME>` ... Use `scripts/deploy.sh`, never a bare `wrangler secret put`: there is no `apps/fleet/wrangler.jsonc` tracked in this repo for a bare `wrangler` invocation to find your Worker's name in, so it fails with `Required Worker name missing`." INFISICAL_CLIENT_ID/_SECRET are secrets (operations.md's own section says "The Worker holds an Infisical machine identity"). Following operations.md's step 2 as written fails on a fresh checkout for the exact reason setup.md names, and the two docs contradict each other on the same operation.
- **Lane:** secrets (Infisical machine identity, Worker-held credentials) → CLAUDE-ONLY per the task's rule. Recorded here; fix filed separately from the GLM lane.
- **Proposed fix:** operations.md:114 — `scripts/deploy.sh secret put INFISICAL_CLIENT_ID` and `scripts/deploy.sh secret put INFISICAL_CLIENT_SECRET`, matching setup.md's rule and its other secret-put walkthroughs.

### S34-F4. operations.md's dead-account cleanup says bare `wrangler d1 execute fleet --remote` — remote-changing wrangler outside the deploy.sh path — CLAUDE-ONLY

- **Site:** docs/operations.md:96-97 — `wrangler d1 execute fleet --remote --command "DELETE FROM fleet_state WHERE key = 'account-limit:CLAUDE_CODE_OAUTH_TOKEN_2'"` (the "Clearing a dead claude account" section).
- **CLI truth:** apps/fleet/scripts/deploy.sh's own read-only classifier (:152 `d1_is_local`, :192 `d1) d1_is_local ...`) exempts `d1` commands only when a real `--local` flag is present — `d1 execute --remote` is a remote-changing command that goes through deploy.sh's config/placeholder/dirty-ops guards exactly like `d1 migrations apply --remote` (setup.md:91-93: "Every deploy and migration below runs through `apps/fleet/scripts/deploy.sh` ... never a bare `wrangler deploy` or `wrangler d1 migrations apply`"; setup.md:145-150 names `migrate:remote` as the sanctioned form). operations.md's snippet as written runs the DELETE against the real D1 on a bare wrangler with none of those guards — same class of doc drift as S34-F3, in the same file, one section apart. (The `--remote` form is not `d1 migrations apply` verbatim, but the section's own subject is the account-limit map — the failover lane — and the command mutates fleet state in remote D1.)
- **Lane:** accounts routing / failover (dead-account limit rows) + remote D1 mutation → CLAUDE-ONLY per the task's rule. Recorded here; fix filed separately from the GLM lane.
- **Proposed fix:** operations.md:96 — `scripts/deploy.sh d1 execute fleet --remote --command '...'` (run from apps/fleet), with the one-line rationale "same deploy.sh path every other remote-changing wrangler command takes (docs/setup.md)".

## Verified clean (recorded, nothing filed)

Every other verb/flag claim in scope checked out against the live CLI — recorded so the next sweep does not re-derive it:

- README: `ff web-studio "<brief>"` / `ff web-studio 412` (adopt: ff.ts:204 `kind: "adopt"`, `#N` and bare `N` both accepted); bare `ff` REFUSES via DEFAULT_FF_ROLE "maestro" (ff.ts:37,274, board #250) — README:125-126 accurate; `fleet ls/check/task ls/task new/provision/recycle/destroy` block (README:130-137) matches the help rows including the provision/recycle/destroy one-line glosses; `bun run check/test/bun-test` (apps/fleet/package.json scripts; bun-test needs tmux + Chromium — CONTRIBUTING.md:19 accurate); `bun run migrate:local/migrate:remote/deploy --allow-unrescued` comments match package.json + deploy.sh:121-128 (`--allow-unrescued` consumed by deploy.sh, never wrangler).
- README sample `fleet ls` row strings: `provisioned`, `bare: no session` (cli/readiness-format.ts:65-67 exact spellings), BURN `12400o/5h:3100` shape = cli/burn-format.ts:28 `${outputTokens}o/5h:${window5hOutput}` — README:151-152's BURN gloss exact.
- docs/setup.md: `fleet junior enable --account <id>`/`disable` (:51-53) matches cli-args.ts:1126 junior case; `fleet accounts` table + `--write-labels` + `sync --watch` 60s (:737-740) match cli-args.ts accounts parsers + help; `fleet spawn`/`fleet provision` print the account a studio launched on (:666) — cli/fleet.ts:1353,1418 `formatAccountResolution("fleet spawn"/"fleet provision", ...)`; `fleet recycle <id> --account mapped` (:680) matches the destroy/recycle parsers (only literal "mapped" accepted); bare `fleet memory` answers "memory is off" (:408) — cli-args.ts:1108-1113, bare `fleet memory` IS an alias for `memory-ls`; `fleet attach` on a tailnet-less studio (:388) matches the attach path's Worker route; `CLAUDE_ACCOUNT_<n>_LABEL` naming (:687, :730) matches the help's --write-labels suggestion format.
- docs/operations.md: `fleet models` / `assign` (pool key glm|kimi|deepseek or raw id) / `promote` / `demote` (:145-148) match cli-args.ts:437-449 models verbs; `fleet spawn --lead glm|kimi|deepseek` (:150) matches spawn's `[--lead claude|glm|kimi|deepseek]` (cli-args.ts:342); `fleet creds get <name>` (:105) exists in container/studio-fleet's HELP with the exact 403/503 semantics the house rules carry; `fleet rescue-all` verdict strings (:51-53) match the help text; sensors workflow hourly cron `17 * * * *` (.github/workflows/sensors.yml:9) and fleet-check's path filters (fleet-check.yml:10-20) as the table at operations.md:173-180 states.
- docs/architecture.md: `fleet recycle`/`fleet destroy` rescue-first claims (:67-69, :91) match the help rows and `--discard-unsynced`/`--force` override semantics; `bun run deploy` rescue gate (:115) matches setup.md:787-793.
- No scope doc names a verb that does not exist: full token diff of `fleet [a-z-]+` mentions against the verb set found zero documented-but-gone or renamed verbs (the `ff doctor` mention in docs/fleet/firstmate-analysis.md:240 is a proposal for a future command in a dated 2026-09-05 analysis, marked "Exact fit for our Directus cutover" — never an existence claim).
- Flags: every `--flag` token in scope docs (`--allow-unrescued`, `--lead`, `--write-labels`, `--watch`, `--force`, `--discard-unsynced`, `--account`, `--json`, `--dry-run`, `--title/--objective/--output/--boundaries`, `--allow-dirty-ops`, deploy.sh's wrangler-flag guards in setup.md's target section) verified present with the documented spelling and value grammar in the parser that owns it; `--dangerously-skip-permissions`/`--yolo`/`--effort`/`--allowedTools` mentions are claude-CLI flags in dated records, out of fleet-CLI scope.

## Proposed follow-ups

One issue per actionable batch, `docs(GLM-OK): S34-Fn <short>`, refs #734, no closing keywords:

- **S34-F1** README: complete the `fleet ls` extra-columns list (finding 1)
- **S34-F2** README + architecture.md: name `--new` instances next to "one studio per role" (finding 2)

(S34-F3 and S34-F4 are CLAUDE-ONLY — recorded in this doc, not filed as GLM issues, per the task's lane rule.)
