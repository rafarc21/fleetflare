# Unused-exports sweep 24 — apps/fleet src+cli (2026-10-12)

Ref #588. Analysis only, read-only, no code changed. Twenty-fourth
maintainability sweep; scope `apps/fleet/src/**` and `apps/fleet/cli/**` minus
`container/`. Line refs = physical lines at `origin/main` `30bceb7`, paths
relative to `apps/fleet/`.

Method: scripted cross-reference of 1691 named exports against an importer map
built over src, cli, test, test-integration, scripts, page, and container
(rule-out only). Every finding below was then hand-re-grepped to rule out
comment mentions, container/'s own local mirrors (container/server.ts
re-declares TaskState/Milestone/GATE_ACTIONS locally — name match ≠ import),
re-export chains, and wrangler-required DO exports.

**Tier rule:** GLM-OK = none of auth, secrets, credentials, rescue, failover,
accounts routing, deploy, migrations, write-proxy, leak-gate. CLAUDE-ONLY =
touches any of those.

**Sweep's rule for what counts:** an export is a finding when no file OTHER
THAN its own imports it by name — either at all (zero-importer), or only from
the one test file that exists to test that module (sole-test-importer). An
export whose every mention elsewhere is a comment is still zero-importer.
Exports required by wrangler config (DO classes in src/index.ts) are KEEP with
the reason stated. "Proposed action" says un-export (used inside its own file
— drop the keyword only), delete (dead: no use anywhere), or keep + why.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | src/ratelimit.ts: 4 exports (RateLimitResult, RateLimitKind, checkAndConsumeRateLimit, RateLimitKindSpec) — the module's own public core, imported by nobody; only makeRateLimitKind + parsePositiveInt are | GLM-OK |
| 2 | src/tasks/types.ts: GATE_ACTIONS, isGateAction, TaskState, Milestone, PendingApproval — zero importers; only TaskStatus, GateAction, GATE_LABELS are consumed | GLM-OK |
| 3 | src/board/types.ts: isBacklog + BACKLOG_STALE_MS — zero importers (isBacklog used only by sibling isBacklogStale in-file; BACKLOG_STALE_MS cross-mentioned in a comment) | GLM-OK |
| 4 | src/llm/anthropic-route.ts: 7 exports (LEAD_STREAM_IDLE_MS_DEFAULT, leadStreamIdleMs, LEAD_AI_MAX_RETRIES, LEAD_AI_RETRY_BASE_MS_DEFAULT, leadAiRetryBaseMs, runAiWithRetry, failureClass) — all used in-file + own test only | GLM-OK |
| 5 | src/llm/ratelimit.ts + src/junior/ratelimit.ts: LeadRateLimitEnv, LeadCountTokensRateLimitEnv, JuniorRateLimitEnv — generic env types referenced only as their own module's makeRateLimitKind type parameter | GLM-OK |
| 6 | src/studio/inspect.ts: 6 zero-importer exports (INCARNATION_SECTION, BRINGUP_LOG_SECTION, INSPECT_BRINGUP_LOG_LINES, InspectSnapshot, InspectExec, InspectDeps) + INSPECT_TARGET used by observed.ts | GLM-OK |
| 7 | src/events/: rules.ts CTO_ID + Decision, log.ts D1PortStatement, schema.ts NewEvent — zero importers; D1Port (imported by close-action.ts) and appendEvent/makeEvent/routeDecision/dedupeKey are the consumed surface | GLM-OK |
| 8 | src/github/: api.ts PullRequestInfo (board.ts mentions it in a comment only), wake-events.ts RepoMatch, app.ts MintTokenOpts used in-file + auth.ts signature re-check | GLM-OK |
| 9 | CLI zero-importer types: cli/poll.ts PollOpts, cli/readiness-format.ts LsJsonRow, cli/recycle-outcome.ts RecycleReport, cli/wip-format.ts WipCheckEntry, cli/input.ts Intercept + CTRL_RBRACKET, cli/orca-workspace.ts OrcaRun + WorkspaceOutcome, cli/junior.ts JuniorPaths | GLM-OK |
| 10 | src/studio/do.ts: 25 zero-importer exports — the DO's whole internal vocabulary (RescueResult, HarvestResult, wipSync, recordWipSyncOnSuccess, RecycleGuard, readinessOf, etc.) exported with no importer; un-export en masse, but file borders the rescue lane | CLAUDE-ONLY |
| 11 | src/studio/provision.ts + install-cache.ts: 20 zero-importer exports (KEEP_ALIVE_KEY, guardedCloneCmd, verifyBringupLanded, SessionAdoption, INSTALL_CACHE_KEEP_GENERATIONS, ...) — same class as F10 | GLM-OK |
| 12 | src/studio/task-state.ts: TaskStateResult — zero importers; its siblings TaskStateFetchResult + TaskStateDeps are imported by cli/fleet.ts and the test | GLM-OK |
| 13 | src/studio/wake.ts: LOOSE_LIMIT_PATTERNS, SURVEY_HEADER_PATTERN, surveyOverlayOnScreen — zero importers, fixture mentions are comments | GLM-OK |
| 14 | Sole-test-importer class: 209 exports across 30+ modules imported only by their own module's test (install-cache.ts 22, survival-delivery.ts 18, orca-workspace.ts 11, directus/client.ts 7, agents/do.ts 7, org.ts 7...) — unit-test seams, deliberate; record the class, propose no en-masse change | GLM-OK |
| 15 | src/index.ts: AgentDO, DeployDO, StudioDO, StudioBigDO — zero importers in the graph but REQUIRED by wrangler.jsonc class_name bindings; KEEP + the in-file comment already says why | KEEP |

### S24-F1. src/ratelimit.ts — the rate-limit engine's public core, imported by nobody — GLM-OK

- **Files:** `src/ratelimit.ts:34` (`export type RateLimitResult`), `:43` (`export interface RateLimitKind`), `:116` (`export async function checkAndConsumeRateLimit`), `:150` (`export type RateLimitKindSpec`).
- **Grep evidence:** importers of ../ratelimit or ./ratelimit: junior/ratelimit.ts (makeRateLimitKind), llm/ratelimit.ts (makeRateLimitKind), llm/anthropic-route.ts (parsePositiveInt). `checkAndConsumeRateLimit` appears outside its file only in its own doc comment at :62; RateLimitResult/RateLimitKindSpec appear nowhere else; RateLimitKind is referenced by llm/ratelimit.ts only inside a comment (:152 "keeping RateLimitKind's shape unchanged").
- **Proposed action:** un-export `checkAndConsumeRateLimit`, `RateLimitResult`, `RateLimitKindSpec`; KEEP `RateLimitKind` exported only if a test imports it after F1 lands — today nothing does. All four are used inside ratelimit.ts itself (checkAndConsumeRateLimit is the engine makeRateLimitKind delegates to at :178), so this is keyword-drop, not deletion. Risk: none — tsc would catch any hidden importer at build time.

### S24-F2. src/tasks/types.ts — five of eight exports consumed by nothing — GLM-OK

- **Files:** `src/tasks/types.ts:3` (`export const GATE_ACTIONS`), `:7` (`export function isGateAction`), `:19` (`export type TaskState`), `:21` (`export interface Milestone`), `:26` (`export interface PendingApproval`).
- **Grep evidence:** the module's importers are tasks/loop.ts, agents/runtime.ts, approvals/gates.ts, approvals/store.ts, test/tasks.loop.test.ts — each imports ONLY TaskStatus, GateAction, or GATE_LABELS. `isGateAction` is called nowhere (its own body is the only use of GATE_ACTIONS outside the array's declaration). TaskState/Milestone/PendingApproval are used in-file to compose TaskStatus; container/server.ts declares its own local `TaskState`, `Milestone`, `GATE_ACTIONS` mirrors ("Mirrors src/tasks/types.ts's GATE_ACTIONS" — a comment at container/server.ts:53), which is why a name grep alone overcounts.
- **Proposed action:** un-export GATE_ACTIONS, isGateAction, TaskState, Milestone, PendingApproval. isGateAction is a dead export — delete the function entirely if no test pins it (none does).

### S24-F3. src/board/types.ts — isBacklog and BACKLOG_STALE_MS exported for no reader — GLM-OK

- **Files:** `src/board/types.ts:143` (`export function isBacklog`), `:154` (`export const BACKLOG_STALE_MS`).
- **Grep evidence:** isBacklog's only caller is the sibling isBacklogStale in the same file (:182). BACKLOG_STALE_MS's only out-of-file mention is a doc comment in src/memory/compact.ts:27 ("the same sprint length board/types.ts's BACKLOG_STALE_MS is") — a comment, not an import. BoardTask's state field uses the board's own TaskState, so no hidden dependency.
- **Proposed action:** un-export both; keep the compact.ts comment (it cites the name, and the name stays — only the export keyword goes). Zero behavior change; tsc pins it.

### S24-F4. src/llm/anthropic-route.ts — the whole GLM-lead tuning surface is self-plus-test-only — GLM-OK

- **Files:** `src/llm/anthropic-route.ts:132` (LEAD_STREAM_IDLE_MS_DEFAULT), `:137` (leadStreamIdleMs), `:148` (LEAD_AI_MAX_RETRIES), `:154` (LEAD_AI_RETRY_BASE_MS_DEFAULT), `:158` (leadAiRetryBaseMs), `:170` (runAiWithRetry), `:218` (failureClass).
- **Grep evidence:** all seven are used inside anthropic-route.ts itself (runAiWithRetry at :514, failureClass at :456, leadStreamIdleMs at :561, leadAiRetryBaseMs at :515, LEAD_AI_MAX_RETRIES at :181). The ONLY external import is test/llm.anthropic-route.test.ts; env.ts mentions LEAD_STREAM_IDLE_MS_DEFAULT and LEAD_AI_RETRY_BASE_MS_DEFAULT in the doc comments of the corresponding env vars (:107, :114) — comments, not imports.
- **Proposed action:** KEEP runAiWithRetry, leadStreamIdleMs, leadAiRetryBaseMs, failureClass exported — they are the test's seams for the retry policy and a plausible future consumer surface (they encode the operator's GLM timeouts); un-export the two _DEFAULT constants if the test stops needing them, or keep for the same reason. Minimum honest change: none required; the finding records that the tuning surface is deliberately closed. Proposed: keep + add nothing; listed because the sweep counts exports with zero production importers.

### S24-F5. The three env type parameters — generic aliases consumed only by their own makeRateLimitKind call — GLM-OK

- **Files:** `src/llm/ratelimit.ts:36` (`export type LeadRateLimitEnv`), `:55` (`export type LeadCountTokensRateLimitEnv`), `src/junior/ratelimit.ts:28` (`export type JuniorRateLimitEnv`).
- **Grep evidence:** each appears in exactly two places: its declaration and its own module's `makeRateLimitKind<X>({...})` type parameter (llm/ratelimit.ts:41, :63; junior/ratelimit.ts:33). No file imports any of the three; the modules' consumed exports are the checkAndConsume* functions (junior/route.ts:15, llm/anthropic-route.ts:22).
- **Proposed action:** un-export all three (drop the keyword; the type stays for its own module's generic). One-line each.

### S24-F6. src/studio/inspect.ts — six internal exports; INSPECT_TARGET already earns its keep — GLM-OK

- **Files:** `src/studio/inspect.ts:116` (INCARNATION_SECTION), `:117` (BRINGUP_LOG_SECTION), `:121` (INSPECT_BRINGUP_LOG_LINES), `:182` (InspectSnapshot), `:252` (InspectExec), `:254` (InspectDeps) — all zero-importer; `:72` (INSPECT_TARGET) — imported by src/studio/observed.ts.
- **Grep evidence:** grep for each name across src/cli/test/page/scripts returns only inspect.ts itself (and test/studio.inspect.test.ts for the *_DEFAULT_TAIL_LINES/INSPECT_EXEC_MS family, which is NOT part of this finding). observed.ts imports INSPECT_TARGET (its session-incarnation probe reads the same marker string).
- **Proposed action:** un-export the six; KEEP INSPECT_TARGET exported (cross-module contract with observed.ts — the section header both files must agree on).

### S24-F7. src/events/ — the decision types' exports outlived their consumers — GLM-OK

- **Files:** `src/events/rules.ts:3` (`export const CTO_ID`), `:5` (`export type Decision`), `src/events/log.ts:39` (`export interface D1PortStatement`), `src/events/schema.ts:24` (`export interface NewEvent`).
- **Grep evidence:** events/rules importers: tasks/loop.ts (routeDecision), test/events.rules.test.ts (dedupeKey, routeDecision). CTO_ID and Decision are used inside rules.ts only (routeDecision returns Decision; CTO_ID feeds the CTO escalation check). Directus "Decision" hits (schema.ts, types.ts EstateDecision) are a different type in a different module. D1Port's sibling D1PortStatement is referenced only inside log.ts (D1Port's own signature) — D1Port IS imported (board/close-action.ts:12). NewEvent is used only inside schema.ts (appendEvent/makeEvent take it).
- **Proposed action:** un-export CTO_ID, Decision, D1PortStatement, NewEvent. Keep appendEvent, D1Port, makeEvent, routeDecision, dedupeKey — the actual consumed surface.

### S24-F8. src/github/ — one comment-mentioned type, one orphan, one in-family seam — GLM-OK

- **Files:** `src/github/api.ts:907` (`export interface PullRequestInfo`), `src/github/wake-events.ts:105` (`export interface RepoMatch`), `src/github/app.ts:79` (`export interface MintTokenOpts`).
- **Grep evidence:** PullRequestInfo's only out-of-file mention is a comment in src/board/board.ts:67 ("Narrowed from github/api.ts's PullRequestInfo") — board.ts defines its own narrower type. RepoMatch appears nowhere outside wake-events.ts. MintTokenOpts IS imported by src/github/auth.ts:58 and used in mintRepoToken's signature :329 — false positive from the first pass, corrected here: MintTokenOpts is USED, not a finding; kept in the table so the correction is on the record.
- **Proposed action:** un-export PullRequestInfo and RepoMatch; MintTokenOpts keep. (Auth-adjacent modules were read for rule-out only — github/app.ts is the token-mint lane's edge, so any change there belongs to the CLAUDE-ONLY lane; this finding's un-export targets api.ts and wake-events.ts only, both GLM-safe.)

### S24-F9. CLI display types exported with no importer — GLM-OK

- **Files:** cli/poll.ts:5 (PollOpts), cli/readiness-format.ts:458 (LsJsonRow), cli/recycle-outcome.ts:86 (RecycleReport), cli/wip-format.ts:58 (WipCheckEntry), cli/input.ts:14 (CTRL_RBRACKET) + `:17` (Intercept), cli/orca-workspace.ts:113 (OrcaRun) + `:167` (WorkspaceOutcome), cli/junior.ts:20 (JuniorPaths).
- **Grep evidence:** each name greps to its own file only. cli/fleet.ts imports from these modules — but classifyInput/CTRL_V (input), reapTerminalAll/TerminalPage (reap-terminal), formatMemoryTable/MemoryFileRow (memory-format), sweepAllPages/SweepPage (junior-sweep) — never the finding's names. Intercept is the return type of the IMPORTED classifyInput, so callers see the type without importing it: the export is a convenience nobody took.
- **Proposed action:** un-export all nine. All are used in-file (PollOpts in pollLoop's signature, RecycleReport in recycle's render, WipCheckEntry in wip-format's rows, OrcaRun/WorkspaceOutcome in orca's deps/results, JuniorPaths in junior's own helpers, CTRL_RBRACKET/Intercept in classifyInput). Zero behavior change.

### S24-F10. src/studio/do.ts — 25 zero-importer exports, one file — CLAUDE-ONLY

- **Files:** `src/studio/do.ts` — the finding's spread: :631 RESCUE_MARKERS_ONLY, :642 RescuePushKind, :655 RescueResult, :819 wipSync, :867 recordWipSyncOnSuccess, :910 WipLastCheckResult, :1185 HarvestResult, :1207 CommitLearningFile, :1217 ResolveMemoryRepo, :1325 ArchiveResult, :1347 DoneRecordArchiveDeps, :1368 DoneRecordHashStorage, :1508 DONE_RECORD_COMMENT_MAX_CHARS, :1653 RecycleGuard, :2101 readinessOf, :2154 START_REFUSED_CODE, :2203 startRefusedResponse, :2212 limitSightingIn, :2218 switchedBlockIn, :2264 recordDeliveredTask, :2719 HealDecision, :3698 LastStopStorage, :3852 readFleetAccountBurn, :4273 refuseUnlessJuniorEnabled, :4505 glmAnthropicBaseUrl, :4590 SpawnTokenStorage, :5159 STALE_BACKGROUND_SHELL_NUDGE_PROMPT (line numbers from the first pass; re-pin before any fix).
- **Grep evidence:** importer map over src/cli/test/scripts/page finds no file importing any of these from ./do or ../studio/do — do.ts's importers (routes.ts, survival-delivery.ts, index.ts, tests) pull DO classes and a handful of names, none from this list. The export keywords are fossils of do.ts's monolith era (pre-split), when the names were shared with modules that have since been extracted with their own copies.
- **Proposed action:** CLAUDE-ONLY — do.ts sits in the rescue/failover-adjacent lane (RESCUE_MARKERS_ONLY, RecycleGuard, rescue push paths), so the en-masse un-export belongs to a task with the lane's guardrails, not a GLM batch. Filed as one deepen issue for a Claude-led pass; mechanical (drop keywords, run tsc), but large enough to deserve its own review.

### S24-F11. src/studio/provision.ts + install-cache.ts — the same fossil class, GLM-safe side — GLM-OK

- **Files:** `src/studio/provision.ts` — :466 KEEP_ALIVE_KEY, :883 guardedCloneCmd, :1005 REMOTE_BRANCHES_LIST_FILE, :1030 RESCUE_DISCOVERY_TIMEOUT_SECONDS, :1359 verifyBringupLanded, :1566 TAILNET_DOWN_PATH, :1772 OpsHouseRulesOutcome, :3135 SessionAdoption, :3257 freshSessionNoteFor. `src/studio/install-cache.ts` — :203 INSTALL_CACHE_KEEP_GENERATIONS, :740 INSTALL_COMPLETE_MARKER, :1328 R2PresignEnv, :1352 INSTALL_CACHE_URL_TTL_SECONDS, :1452 InstallCacheRestoreOutcome, :1461 InstallCacheDirRestoreResult, :1475 InstallCacheRestoreResult, :1852 InstallCacheFailureRecord, :2001 InstallCacheSaveOutcome, :2005 InstallCacheDirSaveResult, :2013 InstallCacheSaveResult.
- **Grep evidence:** zero importers for every name (importer map + hand grep). install-cache.ts's own test imports a DIFFERENT family (the test-only names — finding F14), not these.
- **Proposed action:** un-export — mechanical keyword drops, tsc-verifiable, no rescue/auth adjacency in provision's listed names. install-cache.ts is pure install-cache mechanics.

### S24-F12. src/studio/task-state.ts — TaskStateResult orphaned by its own consumers — GLM-OK

- **Files:** `src/studio/task-state.ts:38` (`export type TaskStateResult`).
- **Grep evidence:** the module's importers: cli/fleet.ts:37 and test/studio.task-state.test.ts:2 — both import runTaskStateTransition + TaskStateFetchResult (+ TaskStateDeps in the test). TaskStateResult is used in-file (:69, runTaskStateTransition's return type) but never imported: consumers let the return type flow from the function signature.
- **Proposed action:** un-export. One keyword.

### S24-F13. src/studio/wake.ts — three exports whose only outside mentions are comments — GLM-OK

- **Files:** `src/studio/wake.ts:135` (LOOSE_LIMIT_PATTERNS), `:204` (SURVEY_HEADER_PATTERN), `:224` (surveyOverlayOnScreen).
- **Grep evidence:** grep across src/cli/test finds the names inside wake.ts only, plus comments: test/fixtures/survey-panes.ts:22 and test/bun/wake-guard.test.ts:351,355 cite them in prose ("`surveyOverlayOnScreen`'s own doc comment", "the container-side SURVEY_HEADER_PATTERN wraps..."). wake.ts's real importers (webhook.ts, assign-wake.ts, wake-gate.ts, failover.ts, survival-delivery.ts, sweep.ts, do.ts, routes.ts) import WakeOutcome, WakeExec, logWakeOutcome, runGatedWake, singleFlightWake — none of the three.
- **Proposed action:** un-export all three; used in-file (LOOSE_LIMIT_PATTERNS → LOOSE_JS :149, SURVEY_HEADER_PATTERN → the survey probe, surveyOverlayOnScreen → the detector).

### S24-F14. The sole-test-importer class — 209 exports across 30+ modules — GLM-OK (record, no action)

- **Files (top of the distribution):** src/studio/install-cache.ts (22 names), src/studio/survival-delivery.ts (18), cli/orca-workspace.ts (11), src/agents/do.ts (7), src/directus/client.ts (7), src/studio/org.ts (7), src/github/api.ts (6), src/studio/ff.ts (6), src/studio/burn.ts (6), src/studio/claude-swap.ts (6) — each name imported only by its module's own test file.
- **Grep evidence:** importer map: for every name, the importer set is exactly {src/<module>, test/<module>.test.ts} (or test/bun/<module>.test.ts). Example: install-cache's repoCheckoutDirName/installCacheKey/... imported by test/install-cache.test.ts alone.
- **Proposed action:** KEEP — deliberate unit-test seams on pure modules (the repo's own test-lies-check enforces that these tests test the module, not mocks). Recording the class because the task asks for it; a future lint (e.g. knip) should be configured to treat these as used, not to flag them.

### S24-F15. src/index.ts DO class re-exports — zero importers, required anyway — KEEP

- **Files:** `src/index.ts:26,29,41` — `export { AgentDO } from "./agents/do"`, `export { DeployDO } from "./deploy/do"`, `export { StudioDO, StudioBigDO } from "./studio/do"`.
- **Grep evidence:** no file imports from src/index.ts; wrangler.test.jsonc binds class_name AgentDO/StudioDO (:61,63) and the migrations list names them (:68,70) — the entry-point export is what makes the binding resolve. The in-file comment at :27-31 already documents the boot-failure mode when this line is missing (Day 1 Task 4).
- **Proposed action:** KEEP, zero change. Listed so a future unused-export tool does not flag it, and because the sweep's method (zero importers) would otherwise report it as a false positive.

## Not filed (counted, no issue)

- The do.ts `export {X} from "./y"` re-export blocks (:190, :239) — re-exports of harvest-record/ship-cadence names for the DO's own graph; counted as re-exports, not findings.
- container/'s local mirrors (TaskState, GATE_ACTIONS, Milestone at container/server.ts:50-62) — deliberate container-side copies with their own comment; not part of src's export surface.
- `__reset*ForTests` exports (org.ts:203, test-creds.ts:110, burn.ts:603) — test-reset hooks by naming convention; same class as F14.
- Approx. 341 further zero-importer exports inside excluded lanes (rescue, failover, auth, accounts routing, deploy, write-proxy, approvals, leak-gate, credentials) — out of scope per the task's EXCLUDE list, counted for the record only.
- 290 further in-scope sole-test-importer names below the top-10 distribution (F14 lists the head) — same class, same keep verdict.

## Counts

15 findings: 12 GLM-OK with proposed un-export actions (F1-F3, F5-F7, F9, F11-F13 + the F14 record + F15 keep), 1 CLAUDE-ONLY (F10, do.ts en-masse pass), 2 keep-with-reason (F4, F15), 1 record-only (F14). Filed deepen issues: one per actionable batch — F1, F2, F3, F5, F6, F7, F9, F11, F12, F13 (GLM-OK un-export batches), F10 (CLAUDE-ONLY), F8 (correction-only, no issue needed).

## S24-F14 appendix — full sole-test-importer distribution (#613)

Fresh count at origin/main f558821 (the sweep above was at 30bceb7), built
with an importer map over src, cli, test, test-integration, scripts, page —
container/ excluded both as exporter and importer; the excluded lanes
(auth, secrets, rescue, failover, accounts routing, deploy, migrations,
write-proxy, leak-gate, approvals) are excluded as exporters but still
searched as importers. Method: parse every `import { NAME }` (including
inline `type NAME` and multi-line blocks), `export { NAME } from`,
`import * as X` plus X.NAME usage, and dynamic `await import()` /
`import("mod").NAME`; comment and string mentions are not importers; a
file importing itself does not count; re-export blocks are not counted as
the re-exporter own exports. Class rule: the name has at least one
importer, and EVERY importer is a test-lane file (test/, test/bun/,
test-integration/).

- Total: 481 in-scope sole-test-importer names across 92 modules. Delta
  vs the sweep own 209/290 split: the original 209 is the same class under
  a narrower rule — importers exactly one canonical own test file, 207
  names here, plus burn.ts 2 more (the old pass attributed burn.ts
  re-exported session-stats names to burn; this pass attributes them to
  session-stats.ts, whose consumer burn.ts is a non-test file) — and the
  7 anthropic-route.ts names the sweep recorded under F4 instead. The
  290 rest of the old claim and the remaining 267 of the 481 are the same
  class where several tests of one module, cross-module tests, or
  fixtures import the name (do.ts 75, provision.ts 28, cli/fleet.ts 27
  live here).
- Per-module distribution, every module, count in parens at the row end:

| module | names |
|---|---|
| src/studio/do.ts | ARCHIVE_DEADLINE_MS, AUTO_WORKING_EVERY_MS, AUTO_WORKING_KEY, BARE_SELF_HEALED, CHECK_ATTEMPTS, DELIVERED_TASK_KEY, DONE_RECORD_HASHES_KEY, ExecUnreachableError, LastStopStorage, LaunchRefusedError, ProvisionedVerdict, REFRESH_SECONDS, ROLLOUT_EXIT_MARKER, RefreshDeps, SHIP_EXEC_DEADLINE_MS, SPAWN_TOKEN_KEY, STALE_SHELL_NUDGE_EVERY_MS, STALE_SHELL_NUDGE_KEY, STUDIO_TICKS, SpawnTokenStorage, StartRefusedError, TICK_DEADLINES_MS, applyAccountClears, applyStudioGitSafetyPort, checkAndRecordReadiness, checkProvisionedGated, checkProvisionedWithRetry, clearForceMappedAccount, clearSessionGuard, constructorLaunch, decideAccountClears, decideHeal, deliverAssignedTaskOnBringup, disarmStudioTicks, doneRecordComment, doneRecordPutter, ensureSpawnToken, gatedStateIn, healBareContainer, healDiedInRollout, incarnationPatch, installLeakGatePort, launchAccountName, launchAccountOrRefuse, launchFields, loadOrMintSpawnToken, mainCheckoutPushFromFailure, mirrorBurnToRegistry, opsFileFetcher, provisionWithFreshVerdict, readTailscaleHost, recordContainerStop, recordLaunchedAccount, recordWipLastCheck, recycleWithSync, refreshWithStorage, refuseUnlessMappedAccountLaunchable, rescueSnapshot, resolveLeadType, restartWithFreshVerdict, restartWithSync, runRefreshCredential, runRefreshToken, runScheduledTick, runShipTickWithObservation, startAccountRefusal, startRefusal, statusDetailWithStorage, studioEnvVars, sweepWake, syncSessionCycle, wakeStudioWith, wipLastCheckResultOf, wipTargetChecksFrom, withObserved (75) |
| src/studio/install-cache.ts | INSTALL_ACTIVITY_WINDOW_SECONDS, INSTALL_CACHE_FAILURE_BACKOFF_BASE_MS, INSTALL_CACHE_FAILURE_BACKOFF_MAX_MS, INSTALL_CACHE_MAX_BYTES, INSTALL_CACHE_RESTORE_BUDGET_MS, INSTALL_CACHE_RESTORE_DISK_SAFETY_MULTIPLIER, INSTALL_CACHE_REVERIFY_EVERY, INSTALL_CACHE_SAVE_LEASE_STALE_MS, INSTALL_CACHE_URL_ENV, LOCKFILE_CANDIDATES, R2_BUCKET_NAME_DEFAULT, WORKSPACE_LOCK_MARKERS, absoluteCacheDir, bunInstallRunningCmd, dirSlug, discoverCacheDirsCmd, guardDirWithinRepo, installCacheFailureBackoffActive, installCacheFailureBackoffMs, installCacheFailureKey, installCacheHashKey, installCacheKey, installCachePrefix, installCacheRestoreCmd, installCacheReverifyKey, installCacheSaveCmd, keysToPrune, lockHashCmd, nodeModulesPresentCmd, normalizeCacheDir, parseBunInstallRunning, parseCacheDirs, parseInstallCacheFailure, parseLockHash, parseRestoreFailureReason, parseSaveOutcome, repoCheckoutDirName (37) |
| src/studio/provision.ts | BRINGUP_CMD, BRINGUP_RETRY_HEALED, CAVEMAN_FLAG_TRIES, CONTAINER_HAS_PROJECTS_CMD, DESTROY_EPOCH_KEY, FRESH_SESSION_INVOLUNTARY_LINE_THRESHOLD, FRESH_SESSION_MARKER, OPS_HOUSE_RULES_PATH, PROVISIONED_CHECK_TRIES, SESSION_ADOPT_DEADLINE_MS, SESSION_ADOPT_MARKER, SESSION_RESTORE_DIR, SESSION_RESTORE_MANIFEST_PATH, SessionMarkStorage, adoptWorktreeSession, adoptWorktreeSessionCmd, bringupLogAppendCmd, composePromptBlocks, discoverRescueRefsCmd, freshSessionInvoluntaryRefusal, parseFreshSession, parseSessionAdoption, recordBringupObservation, resolveBringupEnv, restorePartPath, runProvision, runRestart, runSessionRestore (28) |
| cli/fleet.ts | DetectedRepo, PARK_WARNING_UNAVAILABLE, PARK_WARNING_UNKNOWN_SCAN, REAP_LOCK_STALE_MS, RescueAllDeps, RescueAllFlags, RescueAllOutcome, STRICT_UNMERGED_UNKNOWN_PROCEEDING, STRICT_UNMERGED_UNKNOWN_SCAN, TabsDeps, TabsFlags, cmdLs, cmdPrintAttachHandle, cmdRescueAll, fetchStudioOpenPrs, formatLsHead, formatStudioCount, formatTable, fullErrorLine, openPrsByStudio, parkWarningLines, reapDeps, rescueFetchInit, runRescueAll, runTabs, strictRefusalLines, withReapLock (27) |
| src/studio/session-sync.ts | BURN_ALERTED_WINDOW_KEY, BURN_CURSOR_KEY, SESSION_ASIDE_MAX, SESSION_ASIDE_RAW_MAX, SESSION_BURN_WATERMARK_KEY, SESSION_DAILY_DATE_KEY, SESSION_EXCLUDES_PATH, SESSION_SYNC_DIR, SESSION_TAR_PATH, asideCleanCmd, asideListCmd, asideMarkCmd, asidePackCmd, asidePartReadCmd, partReadCmd, singleReadCmd, splitCmd, tarAndStatCmd (18) |
| src/studio/survival-delivery.ts | SURVIVAL_RETRY_MAX_ATTEMPTS, SURVIVAL_RETRY_WINDOW_MS, SurvivalBringup, attributeRescueBranch, branchArtifacts, isRescueBranchFor, isWipRescueRef, matchesTaskNumber, midTurnRow, parseRescueStamp, prArtifactNumbers, rescueBranchNestedPrefix, rescueBranchPrefix, rescueBranchesFor, rescueRefStamp, resolveSurvivalInput, retryBoundExceeded, survivalBriefAllowed (18) |
| cli/orca-workspace.ts | ContextSalvageDeps, OrcaResult, WorkspaceRegistry, WorkspaceRemovalOutcome, classifyStudioRow, describeWorkspaceRemoval, ensureStudioWorkspace, fileLockAt, fileWorkspaceRegistry, lockFileName, orcaPresent, previewStudioWorkspace, removeStudioWorkspace, studioWorkspaceName (14) |
| src/studio/credentials.ts | READ_REPOS_TOKEN_PATH, STUDIO_GIT_WRAPPER_PATH, STUDIO_GIT_WRAPPER_TMP_PATH, STUDIO_PUSH_ALIAS_DEPTH_REFUSAL, STUDIO_PUSH_LEAK_REFUSAL, STUDIO_PUSH_NONCOMMIT_REFUSAL, STUDIO_PUSH_PLUMBING_REFUSAL, STUDIO_PUSH_PROBE_FAILED, STUDIO_PUSH_REFUSAL, STUDIO_PUSH_SHELL_ALIAS_REFUSAL, STUDIO_PUSH_SUBMODULE_REFUSAL, STUDIO_PUSH_UNRESOLVED_DEFAULT, studioGitWrapperScript (13) |
| src/studio/wake.ts | LOOSE_TAIL_LINES, PANE_PROBE_CMD, PANE_SCREEN_CMD, SUBMIT_HINT_TEXT, WAKE_TARGET, flattenPrompt, looseLimitOnScreen, runWake, submitCheckCmd, submitFragment, wakeCmd (11) |
| src/studio/observed.ts | BRINGUP_TOKEN_WRITE_SECTION, OBSERVED_KEY, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION, SESSION_FOUND_SECTION, SESSION_LEAD_AGE_SECTION, UNREACHABLE_ELAPSED_MS, emptyObserved, readFileLineCmd, writeIncarnationCmd (10) |
| src/studio/org.ts | FleetJsonFetchDeps, ORG_CACHE_TTL_MS, ORG_RETRY_MS, OrgFetchDeps, __resetFleetJsonCacheForTests, __resetOrgCacheForTests, createFleetJsonCache, createOrgCache, parseOrgJson (9) |
| cli/junior.ts | JuniorUsageFetch, fetchJuniorUsage, formatJuniorStats, juniorDisable, juniorEnable, juniorPaths, juniorStatus (7) |
| src/agents/do.ts | DEFAULT_MAX_TASK_SECONDS, parseMaxTaskSeconds, pollAndClearRearm, pollOnce, shouldAbortOnTerminal, shouldClearRearm, toStartInput (7) |
| src/directus/client.ts | fetchContractCommercial, fetchContractStakes, fetchProjectByKey, listOpenDecisions, listRequests, listRequirements, stripCommercial (7) |
| src/llm/anthropic-route.ts | ANTHROPIC_BODY_CAP, LEAD_AI_RETRY_BASE_MS_DEFAULT, LEAD_STREAM_IDLE_MS_DEFAULT, failureClass, leadAiRetryBaseMs, leadStreamIdleMs, runAiWithRetry (7) |
| src/studio/accounts.ts | ClaudeAccountEnv, MAX_CLAUDE_ACCOUNTS, USAGE_ORDERING_FRESHNESS_MS, claudeAccountVarName, parseAccountMap, selectByHeadroom, unmappedFallbackAccount (7) |
| src/studio/claude-swap.ts | CswapWindow, HeadroomCandidate, MAX_USAGE_AGE_SECONDS, RESET_MATCH_WINDOW_MS, UsageHeadroom, pickHeadroomAccount, toUsageHeadroom (7) |
| src/github/api.ts | BLUEPRINT_FILE_MAX_BYTES, INSTALLATION_REPOS_MAX_PAGES, INSTALLATION_REPOS_PAGE_SIZE, compareAhead, ghRequest, listAllBranchNames (6) |
| src/studio/burn.ts | CURSOR_PERSIST_SOFT_CAP_BYTES, CURSOR_PERSIST_TARGET_BYTES, CURSOR_PRUNE_MS, __setPathMapKeyForTest, parseUsageIncrement, pathMapKey (6) |
| src/studio/ff.ts | DEFAULT_FF_ROLE, FF_DEFAULT_BOUNDARIES, FF_DEFAULT_OUTPUT, FF_USAGE, describeState, isProvisioned (6) |
| src/studio/inspect.ts | CHECKOUT_MISSING, CHECKOUT_PRESENT, INSPECT_DEFAULT_TAIL_LINES, TAIL_BEGIN, inspectCmd, parseInspectOutput (6) |
| cli/reap.ts | REAP_BACKOFF_MS, ReapDestroyResult, ReapInspect, STALL_AFTER_MS, STALL_ALARM_EVERY_MS (5) |
| src/board/routes.ts | GithubUrlExistenceChecks, PolicyFetch, ReapPort, RescueGcPort, githubAwareVerifyFetch (5) |
| src/directus/schema-apply.ts | collectionPayload, fieldMismatch, fieldPayload, primaryKeyField, relationPayload (5) |
| src/directus/schema.ts | CONTRACTS, DECISIONS, PROJECTS, REQUESTS, REQUIREMENTS (5) |
| src/studio/destroy.ts | DESTROY_REFUSED_PREFIX, DestroyGuard, destroyRefusal, destroyRescueUnconfirmedRefusal, destroyWithSync (5) |
| src/studio/member-alerts.ts | MemberRow, POLL_LOOP_ELAPSED_MINUTES, POLL_LOOP_TOKENS, goneMemberNames, pollLoopFlags (5) |
| src/studio/sandbox-api.ts | ExecDeadlineError, STUDIO_SESSION_ID, SandboxHandle, SbExecOptions, SessionBusyError (5) |
| cli/accounts-format.ts | ACCOUNTS_TABLE_UTC_NOTE, describeCurrentState, describeWould, wouldChange (4) |
| src/board/board.ts | LEAD_TASK_STATES, REBRIEF_TASK_STATES, TERMINAL_CLOSE_PAGE, requireAssignedTask (4) |
| src/directus/portal.ts | clientStatus, clientView, clientViews, isDelivered (4) |
| src/memory/compact.ts | DEMOTION_MIN_AGE_MS, SPRINT_MS, countCitations, demotionVerdict (4) |
| src/studio/spawn.ts | DEFAULT_MAX_STUDIOS, RESUME_COOLDOWN_MS, readInstanceRequest, readLeadTypeRequest (4) |
| src/studio/sweep.ts | SWEEP_COUNT_KEY, SweepDeps, SweepStorage, sweepPrompt (4) |
| cli/context-salvage.ts | inventoryContext, listContextFiles, salvageDestinationFor (3) |
| cli/ff.ts | FfSpawnNewDeps, ffSpawnNew, fileTask (3) |
| cli/recycle-outcome.ts | RECYCLE_CLIENT_TIMEOUT_MS, RECYCLE_POLL_ATTEMPTS, RECYCLE_POLL_INTERVAL_MS (3) |
| src/board/api.ts | BOARD_MAX_PAGES, BOARD_PAGE_SIZE, TASK_TEXTS_MAX_PAGES (3) |
| src/creds/test-creds.ts | __resetInfisicalTokenCacheForTests, lookupTestCred, parseTestCredsConfig (3) |
| src/github/promote-close.ts | BatchedPull, PATH1_BATCH_MAX, mergeClosable (3) |
| src/llm/ratelimit.ts | DEFAULT_LEAD_COUNT_TOKENS_RATE_PER_MINUTE, DEFAULT_LEAD_DAILY_CAP, DEFAULT_LEAD_RATE_PER_MINUTE (3) |
| src/memory/routes.ts | MEMORY_SURVEY_MAX_FILES, MemoryDeps, githubMemoryDeps (3) |
| src/studio/gh-wrapper.ts | STUDIO_GH_ALIAS_REFUSAL, STUDIO_GH_LEAK_REFUSAL, STUDIO_GH_PROXY_MISSING (3) |
| src/studio/paste.ts | PASTE_SEQ_KEY, PasteDeps, SeqStorage (3) |
| cli/destroy-outcome.ts | DESTROY_POLL_ATTEMPTS, DESTROY_POLL_INTERVAL_MS (2) |
| cli/wip-format.ts | normalizeWipLastCheck, wipSyncRefEcho (2) |
| src/board/envelope.ts | ENVELOPE_MAX_CHARS, ENVELOPE_SCHEMA_VERSION (2) |
| src/board/verify.ts | extractRefCandidates, renderVerifyComment (2) |
| src/directus/card.ts | CardDeps, renderProjectCard (2) |
| src/exceptions.ts | __resetExceptionRateCapForTests, pruneWorkerExceptions (2) |
| src/github/wake-events.ts | WAKE_EVENTS, WAVE_LOG_TITLE (2) |
| src/junior/ratelimit.ts | DEFAULT_JUNIOR_DAILY_CAP, DEFAULT_JUNIOR_RATE_PER_MINUTE (2) |
| src/junior/route.ts | JUNIOR_BODY_CAP, normalizeAiResult (2) |
| src/llm/translate.ts | GLM_MIN_MAX_TOKENS, closeStream (2) |
| src/studio/blueprint.ts | HOUSE_RULES, Role (2) |
| src/studio/cli-args.ts | CLI_USAGE, VERBS (2) |
| src/studio/container-class.ts | BIG_PROFILE_ROLES, doClassForRole (2) |
| src/studio/onboard.ts | OnboardDeps, buildOnboardBrief (2) |
| src/studio/registry.ts | getStudioRow, withAccountDisplay (2) |
| src/studio/routes.ts | BlueprintFetch, spawnDeps (2) |
| src/studio/survival-brief.ts | RESUMED_TRUST_ORIGIN_LINE, sanitizeBranch (2) |
| src/studio/terminal.ts | AttachPty, WS_BUFFER_MAX (2) |
| cli/inspect-request.ts | INSPECT_CLIENT_TIMEOUT_MS (1) |
| cli/restart-format.ts | RESTART_CHURN_24H (1) |
| cli/studio-row.ts | STUDIO_STATES (1) |
| cli/task-format.ts | TITLE_WIDTH (1) |
| cli/task-new-retry.ts | sendWithRetry (1) |
| src/agents/runtime.ts | FakeRuntime (1) |
| src/board/brief.ts | TASK_BODY_MAX (1) |
| src/board/comment-wake.ts | commentDigest (1) |
| src/board/pr-landed.ts | OPEN_TASKS_SCAN_MAX_CANDIDATES (1) |
| src/board/wake-gate.ts | WakeRefusals (1) |
| src/directus/types.ts | RequestStatus (1) |
| src/events/log.ts | readSince (1) |
| src/events/rules.ts | dedupeKey (1) |
| src/github/read-repos.ts | revokeInstallationToken (1) |
| src/github/webhook.ts | verifySignature (1) |
| src/junior/usage.ts | aggregateJuniorUsage (1) |
| src/memory/index-file.ts | MEMORY_ARCHIVE_DIR (1) |
| src/memory/prompt.ts | MEMORY_INDEX_MAX_LINES (1) |
| src/memory/specifics.ts | extractSpecifics (1) |
| src/studio/activity.ts | LAST_LINE_MAX_CHARS (1) |
| src/studio/archive.ts | ROTATION_THRESHOLD_BYTES (1) |
| src/studio/frames.ts | encodeResize (1) |
| src/studio/grid.ts | computeFleetTotals (1) |
| src/studio/profile.ts | studioNamespace (1) |
| src/studio/restarts.ts | RESTART_WINDOW_MS (1) |
| src/studio/studio-blueprint.ts | TIER0_SKILLS (1) |
| src/studio/task-reap.ts | ReapTaskInput (1) |
| src/studio/task-state.ts | TaskStateDeps (1) |
| src/studio/tmux.ts | STUDIO_TMUX_SOCKET (1) |
| src/telegram/api.ts | setWebhook (1) |
- Boundary calls: src/studio/do.ts is in scope by path (its file
  name matches no excluded lane) and its 75 names are recorded above,
  but by content it borders the rescue lane (the sweep own F10 tier
  call) — any future fix batch touching them is CLAUDE-ONLY. Same
  posture for src/creds/test-creds.ts (credentials-adjacent) and
  src/studio/credentials.ts (git-wrapper constants). No name was dropped
  on lane doubt.
- Same class, by convention: `__reset*ForTests` /
  `__setPathMapKeyForTest` hooks — org.ts:203 (__resetOrgCacheForTests),
  org.ts:340 (__resetFleetJsonCacheForTests), test-creds.ts:110
  (__resetInfisicalTokenCacheForTests), burn.ts:603
  (__setPathMapKeyForTest), plus the sibling exceptions.ts:189
  (__resetExceptionRateCapForTests, imported by two tests). All are
  already in their module rows above; named here because the "Not
  filed" section groups them with F14. The auth-lane hooks
  (studio/auth.ts:108,112) stay out with their module.
- KEEP verdict for every name in this table. test-lies-check enforces
  that these tests exercise the real module, not mocks of it — the
  import is the proof, not the problem.

## S24-F14 appendix — future lint configuration (#613)

When the repo adopts an unused-export linter (knip or successor),
configure it so this class is never flagged. Facts verified 2026-10-12
against knip v6.41.0 (schema at
https://github.com/webpro-nl/knip/blob/main/packages/knip/src/schema/configuration.ts):

- knip DEFAULT mode counts imports from test files as usage — the seams
  above would NOT be flagged in a default run. No special config needed
  for the default.
- knip --production mode (entry patterns suffixed !) excludes test
  files from analysis — a production-mode run WOULD flag every seam. If
  production mode is ever adopted: pair it with per-glob
  `ignoreIssues: { "src/studio/install-cache.ts": ["exports"], ... }`
  for the seam modules (one entry per module row above), or keep the
  seams out of production-mode scope.
- Existing v6 options: `ignoreExportsUsedInFile` (default false —
  exports used only in-file; NOT our case: these exports ARE imported,
  by tests), `includeEntryExports` (default false), `ignoreIssues`
  (per-glob issue-type suppression — the right lever), `ignore`
  (per-glob). `ignoreExportsUsedInTest` NO LONGER EXISTS in v6 — it
  was dropped because default behavior already treats test imports as
  usage.
- Repo shape for the config: vitest lane at apps/fleet/test/*.test.ts,
  bun:test lane at apps/fleet/test/bun/*.test.ts, entry candidate
  apps/fleet/src/index.ts. Index-only DO class re-exports (F15) and the
  wrangler class_name bindings are a separate knip concern (entry
  exports), not part of this class.
