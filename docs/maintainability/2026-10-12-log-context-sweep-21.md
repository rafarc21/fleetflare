# Log-context sweep 21 — apps/fleet/src console.* (2026-10-12)

Ref #543. Analysis only, read-only, no code changed. Twenty-first maintainability sweep: console.log/warn/error lines an operator cannot act on — no studio id, no issue/PR number, no route, errors flattened to a bare word, log text contradicting the code path. Scope `apps/fleet/src/**` (cli/ was sweep 12). Line refs = physical lines at `origin/main` 44116cb, paths relative to repo root.

Sweeps 1-20 (docs/maintainability/*.md) and the issues they filed are NOT repeated here.

**Tier rule (from #543):** GLM-OK = none of auth, secrets, credentials, rescue, failover, accounts routing, deploy, write-proxy, leak-gate. CLAUDE-ONLY = touches any of those.

## Method

All 323 console.* sites read in full (single-line sites via ripgrep, every multi-line and id-less candidate re-read in file context). The codebase is disciplined: nearly every log names its subject, and the file's single biggest pattern — `console.error(\`studio ${id}...\`)` — carries the studio id explicitly. The findings below are the residue: lines that force an operator reading only `wrangler tail` back into the codebase to learn WHICH studio, WHICH task, or WHAT failed.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | `src/tasks/loop.ts:83,108,157,221` — terminal/abort/card failures log no taskId | GLM-OK |
| 2 | `src/telegram/webhook.ts:72,97,106,116,121,156,207` — "callback failed" etc.: no project/agent/update_id | GLM-OK |
| 3 | `src/agents/do.ts:108,172,229,320` + `src/deploy/do.ts:154,178` — poll/deploy failures name neither task nor target | GLM-OK |
| 4 | `src/index.ts:208` — "re-arm failed" drops the taskId the two sibling logs carry | GLM-OK |
| 5 | `src/approvals/gates.ts:39` — step() logs `what` but never the approval id; execute-failure verdict loses which gate | GLM-OK |
| 6 | `src/exceptions.ts:220` — pruneWorkerExceptions logs no route/db context; insert (277) at least names the op | GLM-OK |
| 7 | `src/studio/terminal.ts:100,123,308,365` + `src/studio/sandbox-api.ts:470` + `src/studio/routes.ts:1469` — terminal stack logs no studio id (cross-DO, un attributable from tail) | GLM-OK |
| 8 | `src/studio/do.ts:397` — readTailscaleHost "studio tailscaleHost read failed": id in scope (caller 473) but not in the line | GLM-OK |
| 9 | `src/studio/do.ts:2564` — withBringupLogTail "studio: bring-up log tail read failed": bare `studio:` prefix, no id (id IS in scope — shipTranscript passes this.selfId()) | GLM-OK |
| 10 | `src/studio/do.ts:5803` — constructor spawn-token load failure logs no DO name (ctx.id.name in scope on 5799) | GLM-OK |
| 11 | `src/studio/do.ts:5122,5154` — autoWorking/staleShellNudge wrappers log no studio id (function is studio-free but caller has selfId) | GLM-OK |
| 12 | `src/studio/do.ts:6227` — logWakeOutcome("stale background-shell nudge") loses selfId the sibling wake labels carry | GLM-OK |
| 13 | `src/studio/do.ts:8277,8594` — "studio transcript ship failed" / "maestro sweep failed": both inside DO methods, no selfId (contrast: shipTranscript-internal lines at 5337,5440,5493 all carry it) | GLM-OK |
| 14 | `src/studio/do.ts:463` — refresh telegram alert catch: "studio refresh telegram alert failed" no id, while the SUCCESS line (458) interpolates next.id one line above | GLM-OK |
| 15 | `src/studio/session-sync.ts:1111` — advanceWatermark "syncSession: burn watermark write failed": id dropped (parseBurn at 1084 and the cursor catch at 1187 both carry `syncSession ${id}`) | GLM-OK |

### F1. tasks/loop.ts:83,108,157,221 — failures log no taskId — GLM-OK

- **Sites:** terminalMessage catch `console.error("terminal notify failed", err)` (:83); budget-abort catch `"abort failed"` (:108); live-card catch `"live card update failed"` (:157); approval-card catch `"approval card failed"` (:221).
- **Current text:** four fixed strings naming the operation but not the subject.
- **Risk:** `task.taskId` is in scope at every one of these; the SAME file's D1-bound messages (":125 `Task ${task.taskId} lost...`") carry it. From `wrangler tail` alone, a failing card send is unattributable across concurrent agent tasks; the queryable D1 twin (terminalMessage's report()) exists only for :83, not for :157/:221.
- **Proposed text:** interpolate the id — e.g. `terminal notify failed for ${task.taskId}` / `live card update failed for ${next.taskId}` (or the record variable in scope at each site). No behavior change, string only.

### F2. telegram/webhook.ts:72,97,106,116,121,156,207 — no project/agent/update_id — GLM-OK

- **Sites:** `"callback failed"` (:72), `"pause notice failed"` (:97), `"resume notice failed"` (:106), `"stop dispatch failed"` (:116), `"stop notice failed"` (:121), `"paused notice failed"` (:156), `"agent dispatch failed"` (:207). (`"agent start rejected"` :204 already carries status + body.)
- **Current text:** fixed strings; `project`, `agent.id`, `update.update_id`, `cq.id` are each in scope at their sites.
- **Risk:** the module serves multiple projects/agents (AGENTS array, agentForProject); a tail line cannot say which operator tap or which agent broke. The dedupe marker one line above :72 (`cb_${project}_${cq.id}`) proves the values are in hand.
- **Proposed text:** append the in-scope identifier, e.g. `callback failed for ${project}/${cq.id}` / `agent dispatch failed for ${agent.id}`. String only.

### F3. agents/do.ts:108,172,229,320 + deploy/do.ts:154,178 — neither task nor target named — GLM-OK

- **Sites:** `"advanceTask threw; rescheduling instead of wedging"` (108), `"clearRearm failed; leaving the task to reschedule anyway"` (172), `"abort on /stop failed"` (229), `"abort after dead container failed"` (320); deploy: `"advanceDeploy threw; rescheduling instead of wedging"` (154), `"deploy notify failed"` (178).
- **Current text:** fixed strings. `task.taskId` is in scope at all four agents sites; deploy has `project`/`targetId` in scope at :178.
- **Risk:** both DOs are one-instance-per-task/target, so the instance IS the context in principle — but `wrangler tail` merges isolates; every sibling decision in the same files (terminal messages, watchdog alerts) names the taskId. The watchdog exists because these polls fail silently; its own tail lines should name their subject the same way.
- **Proposed text:** `advanceTask threw for ${task.taskId}; rescheduling...` / `deploy notify failed for ${project}/${targetId}`. String only.

### F4. index.ts:208 — "re-arm failed" drops the taskId its siblings carry — GLM-OK

- **Site:** re-arm fetch catch, between :195 `heartbeat read failed for ${agent.id}` and the :223 watchdog card naming `task.taskId`.
- **Current text:** `console.error("re-arm failed", err)`.
- **Risk:** the loop var is `task` (from staleTasks) — one line up the operator learns the agent, two lines below the watchdog alert names the task; this line alone identifies neither.
- **Proposed text:** `console.error(\`re-arm failed for ${task.taskId}\`, err)`. String only.

### F5. approvals/gates.ts:39 — step() loses the approval id — GLM-OK

- **Site:** `const step = async (what, fn) => { ...; console.error(what, err) }`; called 8x with strings like "callback acknowledgement failed", "finishApproval(failed) write failed".
- **Current text:** the failure of an APPROVED GATE (merge_staging, deploy_prod) logs a what-string but no id.
- **Risk:** `row.id` and `row.action` are in scope at every call site; handleCallbackQuery is per-approval but tail merges isolates. A deploy_prod gate that failed at the finishApproval step is indistinguishable in the log from a merge_staging one.
- **Proposed text:** thread the id through the label at each call — `step(\`${row.id}: finishApproval(failed) write failed\`, ...)` — or add a second step() param. String only; never log params (they can carry a branch name but also arbitrary operator input).

### F6. exceptions.ts:220 — prune failure logs no context — GLM-OK

- **Site:** `console.error("pruneWorkerExceptions failed", err)` in the waitUntil prune.
- **Current text:** no route, no row count, no db binding name.
- **Risk:** the operator sees a D1 failure with no clue which surface it degrades: prune failing means worker_exceptions grows unbounded (the insert path it serves is rate-capped, so the table is bounded by cap × window only while prune works). The two sibling logs (:259, :277) name their operation stage; the prune's stage is exactly this line's job.
- **Proposed text:** `console.error("pruneWorkerExceptions failed — worker_exceptions retention now unbounded until the next insert", err)` — names the consequence; route is not in scope (pruneWorkerExceptions takes only db), keep it that way. String only.

### F7. terminal.ts:100,123,308,365 + sandbox-api.ts:470 + routes.ts:1469 — terminal stack unattributable — GLM-OK

- **Sites:** `"studio terminal input failed"` (100), `"studio terminal attach failed"` (123), `"studio terminal pty read failed"` (308), `"studio terminal send failed; dropping this client's output"` (365), `"studio pty socket error"` (sandbox-api 470), `"studio paste write failed"` (routes 1469).
- **Current text:** fixed "studio terminal..." strings. TerminalBridge (terminal.ts:80) holds no studio id — it is built per-StudioDO at do.ts:5822 with `new TerminalBridge((opts) => sbAttachPty(this, opts))`; routes.ts:1469 has `id.full` in scope (used at :1253, :1353 in the same file).
- **Risk:** one `wrangler tail` carries every studio's terminal traffic; "studio terminal attach failed" with no id is the exact "which studio" question this sweep exists for. sandbox-api.ts:470 names neither studio nor session id (STUDIO_SESSION_ID is module-constant, so the studio half is the missing one).
- **Proposed text:** thread the id: TerminalBridge constructor takes the DO's selfId (already available at the 5822 call site) and interpolates it; routes.ts uses `studio ${id.full} paste write failed`; sandbox-api's failStream can take the host's id via SandboxPtyHost (already carries the DO reference — check its interface for an id accessor; if none, the one-line fix adds `studioId` to the opts sbAttachPty already receives from the bridge). One string per site, no behavior change.

### F8. studio/do.ts:397 — tailscaleHost read failure loses the studio — GLM-OK

- **Site:** readTailscaleHost catch: `console.error("studio tailscaleHost read failed", err)`.
- **Current text:** no id. The caller at :473 (runRefreshToken's pure half) has the id — it is passed to refreshWithStorage at :8233 — but readTailscaleHost's signature (deps, sbExec) does not carry it.
- **Risk:** refresh runs for every studio on a tick; a container whose .ts-host read fails (deadline exit is silent by design, :393) is unattributable in the tail while its status row degrades to host unknown.
- **Proposed text:** add an `id` param to readTailscaleHost (one caller, tests seam-friendly) and log `studio ${id}: tailscaleHost read failed`. String + one param thread.

### F9. studio/do.ts:2564 — withBringupLogTail: bare `studio:` prefix — GLM-OK

- **Site:** catch in withBringupLogTail: `console.error("studio: bring-up log tail read failed, reporting the verdict without it", err)`.
- **Current text:** `"studio: "` literal prefix — reads as a label, not an id.
- **Risk:** the verdict's reason (which DOES reach the operator via StudioReadiness) already carries the failure; this line is the only tail trace of a container too dead to answer the exec — and it names no studio. The caller chain has the id: shipTranscript → runShipTickWithObservation(this.selfId() at :8267) → readiness probes (:2524 call site, inside runBringupVerdict which receives syncDeps — id threads the same way F8's does).
- **Proposed text:** thread the id to the function (param or the existing deps record) and log `studio ${id}: bring-up log tail read failed, reporting the verdict without it`. String + one param thread.

### F10. studio/do.ts:5803 — constructor spawn-token load failure names no DO — GLM-OK

- **Site:** constructor catch: `console.error("studio: could not load the persisted spawn token at construction", err)`.
- **Current text:** bare `studio:` prefix; `ctx.id.name` is used two lines above at :5799 (`constructorLaunch(env, ctx.id.name ?? "studio", ...)`).
- **Risk:** this is the FIRST log a wedged studio ever emits — before any tick, before any status row. At construction time the id is the only handle an operator has, and it is in scope, interpolated into launched, then dropped from the failure line.
- **Proposed text:** `console.error(\`studio ${ctx.id.name}: could not load the persisted spawn token at construction\`, err)`. String only.

### F11. studio/do.ts:5122,5154 — autoWorking/staleShellNudge wrappers lose the studio — GLM-OK

- **Sites:** `"auto submitted->working failed, next window retries"` (5122), `"stale background-shell nudge failed, next window retries"` (5154).
- **Current text:** fixed strings; both functions are studio-free (deps/storage params), called from shipTranscript with `this.selfId()` in hand at :8267.
- **Risk:** both are once-per-window retries — a persistent failure prints once per 15min per studio, and with several studios running the tail interleaves identical lines with no discriminator.
- **Proposed text:** thread `id` into autoWorking/staleShellNudge (one caller each, both already have selfId) and prefix `studio ${id}: ...`. Param thread + string.

### F12. studio/do.ts:6227 — stale background-shell nudge wake label drops selfId — GLM-OK

- **Site:** `logWakeOutcome("stale background-shell nudge", outcome)` in notifyStaleBackgroundShell — the same method that passes `this.selfId()` into wakeStudioWith at :6225.
- **Current text:** label without the id; every sibling wake label carries it ("maestro wake (${studioId})", "studio ${this.selfId()}: bring-up delivery of #${taskNumber}", logSurvivalOutcome's `studio ${this.selfId()}: ...`).
- **Risk:** logWakeOutcome prints "stale background-shell nudge failed: <tmux's own words>" — tmux's error text does not name the studio either, so the line is id-free end to end while the nudge itself (STALE_BACKGROUND_SHELL_NUDGE_PROMPT) is typed into a specific studio's pane.
- **Proposed text:** `logWakeOutcome(\`studio ${this.selfId()}: stale background-shell nudge\`, outcome)`. String only.

### F13. studio/do.ts:8277,8594 — DO-level catches drop the id their own inner lines carry — GLM-OK

- **Sites:** shipTranscript's outer catch `"studio transcript ship failed"` (8277); sweepMaestro's catch `"maestro sweep failed"` (8594).
- **Current text:** both are StudioDO methods with selfId() used abundantly inside the SAME callbacks (shipTranscript-internal lines at :5337, :5440, :5493 all say `shipTranscript ${id}`; the maestro sweep's own wake label at :8591 is the no-id "maestro sweep wake").
- **Risk:** the outer catch fires exactly when the inner machinery is too broken to have logged — the tick threw before any inner line ran — so the one line that DOES print is the one without the id. "maestro sweep failed" additionally does not say WHICH maestro (sweepMaestro is per-repo-maestro, several run).
- **Proposed text:** `studio ${this.selfId()}: transcript ship tick failed` / `studio ${this.selfId()}: maestro sweep failed`. String only.

### F14. studio/do.ts:463 — telegram alert catch drops the id the success line carries — GLM-OK

- **Site:** runRefreshToken's notify catch: `console.error("studio refresh telegram alert failed", err)`.
- **Current text:** no id; the SUCCESS path's notify body one line above (:458) interpolates `next.id` into the message.
- **Risk:** the degraded state transition IS recorded in the status row, so the operator sees it in `fleet ls` — but the reason the ALERT did not arrive (only the row) lives in this line, which cannot say for which studio the alert was lost. isNewStreak gates it to once per streak, so it is rare and correspondingly hard to re-locate.
- **Proposed text:** `console.error(\`studio ${next.id}: refresh telegram alert failed\`, err)`. String only.

### F15. studio/session-sync.ts:1111 — advanceWatermark drops the id parseBurn carries — GLM-OK

- **Site:** catch in advanceWatermark: `console.error("syncSession: burn watermark write failed, sync itself still succeeded", err)`.
- **Current text:** `syncSession:` literal prefix, no id. advanceWatermark takes (storage, parsed, tarStartedAt) — no id — but its only caller (:1015, :1034) runs inside syncSessionTick, which HAS the id and passes it to parseBurn three words later.
- **Risk:** the burn cursor catch at :1187 logs `syncSession ${id}: burn cursor/burn PERSIST FAILED...`; this sibling writes a strictly less-informative line for the adjacent key (SESSION_BURN_WATERMARK_KEY), so two burn-state failures in one tick print one attributable and one bare line.
- **Proposed text:** thread `id` into advanceWatermark (same shape parseBurn already takes) and log `syncSession ${id}: burn watermark write failed, sync itself still succeeded`. Param thread + string.

## CLAUDE-ONLY (listed, nothing filed)

- `src/studio/failover.ts:2640,3113,3117` — failover bring-up observation logs: read; both carry `studio ${idFallback/studioId}` already. Clean this pass.
- `src/studio/rescue.ts:43,89,104`, `src/studio/accounts.ts:748-764`, `src/write-proxy/mode.ts:50,78,121`, `src/board/leak.ts:42,51`, `src/studio/auth.ts:44,96`, `src/github/auth.ts:339`, `src/deploy/do.ts` deploy-path logs, credentials/ paths: all read; all either name their subject or are config-validation lines with the offending value already interpolated. No findings filed from these files.
- `src/junior/authz.ts:153` sweep revoke log and `src/agents/do.ts:108` were the only authz/agent lines lacking ids; F1/F3 cover the agents side, authz's sweep line names `repo#number` (the operator's key) — clean.

## Proposed follow-ups

One issue per batch, `chore(GLM-OK): S21-Fn <short>` (or fix/test prefix where the fix lane demands), filed from this doc, refs #543. Batches:
- **S21-F1** loop.ts taskId interpolation (finding 1)
- **S21-F2** telegram webhook project/agent id interpolation (finding 2)
- **S21-F3** agents+deploy DO task/target id interpolation (finding 3+4)
- **S21-F4** approvals step() approval-id threading (finding 5)
- **S21-F5** exceptions prune consequence line (finding 6)
- **S21-F6** terminal stack studio-id threading — bridge ctor param + routes + sandbox-api (finding 7)
- **S21-F7** do.ts one-param-thread batch: readTailscaleHost, withBringupLogTail, constructor ctx.id.name, autoWorking/staleShellNudge, advanceWatermark (findings 8,9,10,11,15)
- **S21-F8** do.ts string-only batch: nudge wake label, ship/sweep catches, refresh alert catch (findings 12,13,14)
