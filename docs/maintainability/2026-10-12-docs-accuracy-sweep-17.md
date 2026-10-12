# Documentation accuracy sweep 17 — docs/ + docs/fleet (2026-10-12)

Ref #536. Read-only analysis. No code changed, no doc fixed here — this doc records findings; fixes land as separate tasks it spawns.

Scope: `docs/*.md` (architecture, operations, setup, threat-model), `docs/fleet/*.md` (README, directus, firstmate-analysis, skipperm-effort-report, spike-lead-tools). `apps/fleet/docs` root has no loose .md files (only maintainability/ and plans/, both excluded by the task); `docs/superpowers/` (17 specs, 115 plans, 1 evidence) is archived working material by the same convention sweep 7 applied. `docs/fleet/README.md` is a dated (2026-08-03) record-of-truth snapshot for a different project (acme-org/websites) that carries its own "Last measured" framing — historical record, not live doc; claims about THIS repo inside it are noted below where stale.

Method: every doc claim naming a command, flag, route, file, env var, migration, workflow, or behavior was checked against code on origin/main 39dda2b; live-CI claims also checked with `gh run list` and `gh pr checks`. Most claims checked out (spot list: setup.md's env-var names all resolve in env.ts, test-creds 503/403 strings, cswap 95% threshold and +/-5min inference, `fleet junior enable`, leak-gate fail-closed strings, deploy.sh placeholder and dirty-ops guards, rescue-all verdict strings, WAKE_EVENTS set, StudioDO token-refresh at REFRESH_SECONDS=3000, glm-lead strict-mode exemption at do.ts:4254, Chrome-for-Testing via playwright installer in Dockerfile.studio:237, registry.ts's cto/websites entry, ego-browser install). Findings below are the ones that did not.

Tiers: GLM-OK findings are doc-only edits, no code touch. threat-model.md is the credentials doc wholesale — its findings are CLAUDE-ONLY, listed here but not filed as GLM fix tasks.

### S17-F1. operations.md says one-way-door.yml "does not exist yet" — it exists and runs on every PR — GLM-OK

`docs/operations.md:141` and `:160-176` say `.github/workflows/one-way-door.yml` "does not exist in this repo yet", "Until that file is added, no `one-way-door` check runs on any PR". The file exists (added 2026-10-11 in 1db884b) and runs: `gh run list` shows "One-Way Door" completing on PRs today, and `gh pr checks` on open PR 535 shows a passing `classify` check. The whole "Blocked: workflow file" paragraph (GitHub-App-token push refusal narrative) is resolved history. Fix: delete the "not yet added"/"does not exist" claims and the blocked-push narrative; describe the workflow as present (it labels `one-way-door` on every PR), keep the pointer to `ONE_WAY_GLOBS`.

### S17-F2. operations.md says "three workflows" — there are four — GLM-OK

`docs/operations.md:135` says "GitHub Actions runs natively on this repository — three workflows". Four exist: `fleet-check.yml`, `english-check.yml`, `one-way-door.yml`, `sensors.yml` (record-only hourly sensors, issue #187, added same 1db884b wave). Fix: say four and add the sensors row (hourly cron, rewrites the pinned sensor-burn-log issue, gates nothing).

### S17-F3. setup.md says the migrations are "0001_init.sql, 0002_day2.sql today" — six exist — GLM-OK

`docs/setup.md:151-152` says "The migrations in `apps/fleet/migrations/` (`0001_init.sql`, `0002_day2.sql` today)". Six exist: 0003_worker_exceptions, 0004/0005/0006_junior_usage* (junior usage tracking, issues #192/#211 era). The claim's substance (scripts hardcode the database name `fleet`) is still true; only the "today" list is stale. Fix: drop the parenthetical file list or say "six today (0001–0006)".

### S17-F4. spike-lead-tools.md says the shipped matcher is "Edit|Write|NotebookEdit|Bash" — it is `.*` — GLM-OK

`docs/fleet/spike-lead-tools.md:174-176` says "the shipped matcher is `Edit|Write|NotebookEdit|Bash`". studio-bringup.sh:1016 now ships `"matcher": ".*"` — P7a Task 5 moved the tool decision into the hook script by SHAPE, explicitly citing firstmate-analysis §2.4 (a fixed list lets a new tool walk past). The spike doc's Ruling section says "See `apps/fleet/container/studio-bringup.sh` for the real list" — the real matcher is no longer a list. Fix: one amended note in the Ruling (the spike itself is a dated record, so amend — do not rewrite — the shipped-matcher sentence to name the `.*` matcher and the P7a change, as the doc already did once for the Bash fix wave).

### S17-F5. firstmate-analysis.md quotes the effort ternary as `name === "maestro"` — code says `cto` — GLM-OK

`docs/fleet/firstmate-analysis.md:250` quotes our code as `` `ROLE_EFFORT: studio.effort ?? (name === "maestro" ? "max" : "")` `` inside finding 33 (declarative dispatch routing). `apps/fleet/src/studio/blueprint.ts:764` actually reads `ROLE_EFFORT: role.effort ?? (role.name === "cto" ? "max" : "")` — different receiver field and different role name. The doc's argument (one hardcoded ternary) still holds; the quote is just wrong on both spellings. Fix: correct the quoted line to the real code.

### S17-F6. firstmate-analysis.md §2.1 says envelope artifacts have "no consumer" — the Worker now verifies PR claims — GLM-OK

`docs/fleet/firstmate-analysis.md:53-64` says "No consumer reads them: only `src/board/types.ts:251` (the type) and prose at `src/studio/ff.ts:100`" and "Studio reports `{kind:"pr", pr:"#999"}` for nonexistent PR. Worker records it as fact." That landed as open-prs/pr-landed work: `src/board/board.ts:69` carries `getPullRequest`, `src/board/open-prs.ts:24` says "getPullRequest names that PR's live state", and #332 review made a thrown getPullRequest fail the envelope. §3 item 1 ("Worker verifies envelope artifacts. §2.1. Reject intent=result whose claimed PR 404s") is therefore partially DONE, not pending. Fix: mark §2.1 with a dated landed-note (artifacts claiming a PR are now verified against GitHub) so the steal list does not get re-litigated.

### S17-F7. skipperm-effort-report.md says roleBringupEnv returns "three keys" / RoleEnv is a "fixed triple" — four now — GLM-OK

`docs/fleet/skipperm-effort-report.md:32,35` says `roleBringupEnv` "now returns three keys" and `RoleEnv` is a "fixed triple" (ROLE_PROMPT_B64, ROLE_ALLOWED_TOOLS, ROLE_EFFORT). `apps/fleet/src/studio/blueprint.ts:758` now returns four — `ROLE_MCP` (issue #276) — and `provision.ts:397` types it. The report is a dated change report (2026-08-19), accurate as of its date; the mechanism it documents survived. Fix: none needed in a dated report unless the repo wants living accuracy — candidate for a one-line "superseded count: ROLE_MCP added later (#276)" note; filed as the doc-only question rather than silently leaving both spellings unreconciled.

### S17-F8. operations.md's localci paragraph reads as the current CI story — Actions is current, and the section's own framing no longer matches — GLM-OK

`docs/operations.md:188-194` says localci "predates this native Actions setup and is superseded by it... no longer gate a merge or post a commit status". True — but the paragraph still leads the reader to reproduce lanes by hand on a Mac, while the section above it (S17-F1/F2) describes workflows that were, at the time that paragraph was written, claimed not to exist. After fixing S17-F1/F2 the paragraph is consistent; this finding exists so the fix does not stop at the two headline claims and leave the section half-migrated: re-read the whole CI section end-to-end after F1/F2 land and rewrite any sentence that still tells the old story.

### S17-F9. threat-model.md says "three Durable Object classes" — four — CLAUDE-ONLY

`docs/threat-model.md:11-12` says the Worker "fronts three Durable Object classes" (StudioDO, DeployDO, AgentDO). A fourth exists: `StudioBigDO` (issue #107, apps/fleet/src/studio/do.ts:8630, wrangler.example.jsonc:170) — a same-shape larger-memory StudioDO subclass for standard-4 containers. Same doc also carries wholesale line-number drift in its citations (e.g. `do.ts:2672` for the OAuth token env — the code now at do.ts:4565 in `studioEnvVars`; `do.ts:151-156` for the 50-minute refresh — now `REFRESH_SECONDS` at :234; `board.ts:655-662` for a "three-state allowlist" — board.ts:1022 says four-state). CLAUDE-ONLY: threat-model.md is the credentials/secrets doc; fixes there are filed separately from the GLM lane, per the task's skip list. Listed here so the drift is on record.

## Files checked clean (no findings)

`docs/architecture.md` — every claim verified: one-minute cron (wrangler.example.jsonc:34), tmux window 0, Chrome for Testing (playwright-installed, Dockerfile.studio:237), repo layout paths all resolve, rescue/write-proxy/leak-gate descriptions match code. `docs/fleet/directus.md` — `scripts/directus-schema.ts` exists, `DIRECTUS_URL`/`DIRECTUS_TOKEN` handling and portal.ts design match. `docs/fleet/README.md` — historical snapshot for another project by its own framing; no live-doc claims about this repo survive unscoped.
